/**
 * Inverse-dynamics torque + utilization for a RobCo arm, via MuJoCo-WASM.
 *
 * MuJoCo's `mj_inverse` gives only the rigid-body Newton-Euler torque (gravity + link
 * inertia + Coriolis) — which is exactly what the digital twin computes (its motor model is
 * compiled out). To match a *real* RobControl joint we add, per drive, the two terms the
 * firmware adds on top (verified against robcontrol `motor_model.cpp` / `robot_model.cpp`):
 *
 *   τ_total = τ_NE  +  motor-inertia torque  +  friction torque
 *     motor-inertia : ddq · gear_ratio² · motor_inertia          (reflected rotor inertia)
 *     friction      : viscous·q̇ + (coulomb + quad·τ_NE²)·sin(atan(k·q̇))   (k = FRICTION_RAMP)
 *
 * and the motor q-axis current that produces it (no field weakening, no gear efficiency):
 *
 *   i_q = (τ_total / gear_ratio) / torque_constant
 *
 * All parameters are read per joint from each module's own descriptor — drive types differ
 * wildly (Kt, gear ratio, friction span 4→120 N·m, different motors/manufacturers), so
 * nothing is a global constant. Current/overload use the motor-side current limits
 * (motor.rated_current + motor.peak_current as ‰ of rated), which match the Circulo drive's
 * CiA402 objects 0x6075/0x6073.
 *
 * Validated against a known pendulum (m·g·L) and the real demo arm (see scripts/mj_validate.mjs).
 */
import { mjcfFromModules } from './mjcfFromModules.js';
import { noLoadSpeedRadFor, peakTimeSecFor } from './motorEnvelopes.js';

const DRIVE_TYPES = new Set(['Drive', 'BaseDrive']);

// Coulomb-friction velocity smoothing: τ_c·sin(atan(k·q̇)) → ±τ_c. RobControl default
// `friction_model_ramping_factor` = 100 (program_arguments.hpp); q̇ in rad/s, joint side.
const FRICTION_RAMP = 100;

export class MujocoDynamics {
    /**
     * @param {Object[]} descriptors - per-module descriptors, base->flange (clamps included).
     * @param {Object} [opts] - payload etc., forwarded to mjcfFromModules.
     * @returns {Promise<MujocoDynamics>}
     */
    static async create(descriptors, opts = {}) {
        const loadMujoco = (await import('mujoco-js/dist/mujoco_wasm.js')).default;
        const mj = await loadMujoco();
        return new MujocoDynamics(mj, descriptors, opts);
    }

    constructor(mj, descriptors, opts = {}) {
        this.mj = mj;
        this.descriptors = descriptors;
        // Apply the motor model (friction + reflected motor inertia + current) on top of the
        // rigid-body NE torque. true = real-hardware-accurate, false = twin-accurate (NE only).
        this.motorModel = opts.motorModel !== false;

        const drives = descriptors.filter((d) => DRIVE_TYPES.has(d['module-type']));
        // Torque limits (output side) for utilization denominators.
        this.peakTorque = drives.map((d) => d.module_properties?.peak_torque ?? null);
        this.ratedTorque = drives.map((d) => d.module_properties?.rated_torque ?? null);
        // Motor-model parameters, per drive, from each module's descriptor.
        this.gearRatio = drives.map((d) => d.gears?.ratio ?? null);
        this.motorInertia = drives.map((d) => d.dynamics?.motor_inertia ?? 0);
        this.frictionCoulomb = drives.map((d) => d.friction_parameters?.friction_coulomb ?? 0);
        this.frictionViscous = drives.map((d) => d.friction_parameters?.friction_viscous ?? 0);
        // Load-dependent friction (quad·τ_NE²); only populated on D193-class modules, else 0.
        this.frictionLoadQuad = drives.map((d) => d.friction_parameters?.friction_load_dependent_quadratic ?? 0);
        // Current: Kt (motor side) + motor-side current limits. peak_current is ‰ of rated
        // (CiA402 0x6073), so i_max = rated_current · peak_current/1000.
        this.torqueConstant = drives.map((d) => d.motor?.torque_constant ?? null);
        this.ratedCurrent = drives.map((d) => d.motor?.rated_current ?? null);
        this.maxCurrent = drives.map((d) => {
            const ir = d.motor?.rated_current;
            const pk = d.motor?.peak_current; // per-mille of rated
            return ir != null && pk != null ? ir * (pk / 1000) : null;
        });
        // No-load speed (rad/s, motor side) for the back-EMF torque-speed rolloff (#4).
        this.noLoadSpeed = drives.map((d) => noLoadSpeedRadFor(d.motor?.name));
        // i²t peak time (s) per drive, from the Circulo config (Synapticon 0x200A:2). null
        // for unknown motors → the i²t model falls back to a default.
        this.peakTime = drives.map((d) => peakTimeSecFor(d.motor?.name));

        // Persisted model options (payload + gravity) so a rebuild from one (e.g. payload
        // change) keeps the other (e.g. base-orientation gravity).
        this._opts = {};
        try { mj.FS.mkdir('/working'); } catch { /* exists */ }
        try { mj.FS.mount(mj.MEMFS, { root: '.' }, '/working'); } catch { /* mounted */ }
        this.rebuild(opts);
    }

    /** Toggle the motor model: true = real-hardware (NE + friction + inertia), false = twin (NE only). */
    setMotorModel(on) {
        this.motorModel = !!on;
    }

    /** Rebuild the MuJoCo model (e.g. after a payload or gravity change). Options merge. */
    rebuild(opts = {}) {
        this._opts = { ...this._opts, ...opts };
        const { xml, jointNames } = mjcfFromModules(this.descriptors, this._opts);
        this.jointNames = jointNames;
        this.nq = jointNames.length;
        const path = '/working/robco_dyn.xml';
        this.mj.FS.writeFile(path, xml);
        this._dispose();
        this.model = this.mj.MjModel.loadFromXML(path);
        this.data = new this.mj.MjData(this.model);
    }

    /** Update the TCP payload (kg, CoM in flange frame) and rebuild. */
    setPayload(mass, com = [0, 0, 0]) {
        this.rebuild({ payloadMass: mass || 0, payloadCom: com });
    }

    /**
     * Set the gravity vector in the robot base frame and rebuild. For a tilted/wall/ceiling
     * mount, pass world gravity expressed in the base frame: g_base = baseQuat⁻¹·[0,0,-9.81].
     * @param {number[]} gravity - [gx, gy, gz] in m/s², base frame.
     */
    setGravity(gravity) {
        this.rebuild({ gravity });
    }

    /**
     * Inverse dynamics for a joint state (radians, rad/s, rad/s²).
     *
     * Returns the total joint torque (rigid-body NE plus, when the motor model is on, the
     * firmware's friction + reflected-motor-inertia terms), the estimated motor q-axis
     * current, and utilization fractions against both the torque limits and the current
     * limits. Utilization arrays are null per joint where the relevant limit is unknown.
     *
     * @param {number[]} q     - joint positions (rad), base->flange.
     * @param {number[]} [qdot]  - joint velocities (rad/s); 0 if omitted (static hold).
     * @param {number[]} [qddot] - joint accelerations (rad/s²); 0 if omitted.
     * @returns {{torque:number[], utilization:(number|null)[], utilizationRated:(number|null)[],
     *   current:(number|null)[], currentUtil:(number|null)[], currentUtilRated:(number|null)[],
     *   neTorque:number[], frictionTorque:number[], inertiaTorque:number[]}}
     */
    computeTorques(q, qdot = null, qddot = null) {
        const { mj, model, data, nq } = this;
        mj.mj_resetData(model, data);
        for (let i = 0; i < nq; i++) {
            data.qpos[i] = q[i] ?? 0;
            if (qdot) data.qvel[i] = qdot[i] ?? 0;
            if (qddot) data.qacc[i] = qddot[i] ?? 0;
        }
        mj.mj_inverse(model, data);

        const torque = new Array(nq);
        const neTorque = new Array(nq);
        const frictionTorque = new Array(nq).fill(0);
        const inertiaTorque = new Array(nq).fill(0);
        const utilization = new Array(nq);
        const utilizationRated = new Array(nq);
        const current = new Array(nq);
        const currentUtil = new Array(nq);
        const currentUtilRated = new Array(nq);

        for (let i = 0; i < nq; i++) {
            // Rigid-body Newton-Euler torque (gravity + link inertia + Coriolis) = the friction
            // "load" term in the firmware, and the only torque the digital twin produces.
            const ne = data.qfrc_inverse[i];
            neTorque[i] = ne;
            const dq = qdot ? (qdot[i] ?? 0) : 0;
            const ddq = qddot ? (qddot[i] ?? 0) : 0;

            let t = ne;
            if (this.motorModel) {
                const ratio = this.gearRatio[i];
                if (ratio) {
                    inertiaTorque[i] = ddq * ratio * ratio * this.motorInertia[i];
                }
                const loadDep = this.frictionLoadQuad[i] * ne * ne;
                frictionTorque[i] =
                    this.frictionViscous[i] * dq +
                    (this.frictionCoulomb[i] + loadDep) * Math.sin(Math.atan(FRICTION_RAMP * dq));
                t = ne + inertiaTorque[i] + frictionTorque[i];
            }
            torque[i] = t;

            const at = Math.abs(t);
            utilization[i] = this.peakTorque[i] ? at / this.peakTorque[i] : null;
            utilizationRated[i] = this.ratedTorque[i] ? at / this.ratedTorque[i] : null;

            // Motor q-axis current: τ_motor = τ_joint / gear_ratio; i_q = τ_motor / Kt.
            const ratio = this.gearRatio[i];
            const kt = this.torqueConstant[i];
            if (ratio && kt) {
                const iq = t / ratio / kt;
                current[i] = iq;
                const aiq = Math.abs(iq);
                // Available current at this speed: the drive current limit derated by the
                // back-EMF rolloff (1 − ω_motor/ω_noload). With no envelope data, frac = 1 (no
                // rolloff) → reduces to the static current utilization.
                let frac = 1;
                const w0 = this.noLoadSpeed[i];
                if (w0) frac = Math.max(0, 1 - (Math.abs(dq) * ratio) / w0);
                const avail = this.maxCurrent[i] != null ? this.maxCurrent[i] * frac : null;
                currentUtil[i] = avail != null
                    ? (avail > 1e-6 ? aiq / avail : (aiq > 0 ? Infinity : 0))
                    : null;
                currentUtilRated[i] = this.ratedCurrent[i] ? aiq / this.ratedCurrent[i] : null;
            } else {
                current[i] = null;
                currentUtil[i] = null;
                currentUtilRated[i] = null;
            }
        }
        return {
            torque, utilization, utilizationRated,
            current, currentUtil, currentUtilRated,
            neTorque, frictionTorque, inertiaTorque,
        };
    }

    _dispose() {
        this.data?.delete?.();
        this.model?.delete?.();
        this.data = null;
        this.model = null;
    }

    dispose() {
        this._dispose();
    }
}
