/**
 * Inverse-dynamics torque + utilization for a RobCo arm, via MuJoCo-WASM.
 *
 * Builds a dynamics-only MuJoCo model from the module descriptors (see mjcfFromModules),
 * then for a given joint state (q, q̇, q̈) computes per-joint torque with `mj_inverse` and
 * utilization against each drive's peak/rated torque.
 *
 * Validated against a known pendulum (m·g·L) and the real demo arm (see scripts/mj_validate.mjs):
 * base/wrist ≈ 0, shoulder bears the load, all within limits.
 */
import { mjcfFromModules } from './mjcfFromModules.js';

const DRIVE_TYPES = new Set(['Drive', 'BaseDrive']);

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
        const drives = descriptors.filter((d) => DRIVE_TYPES.has(d['module-type']));
        this.peakTorque = drives.map((d) => d.module_properties?.peak_torque ?? null);
        this.ratedTorque = drives.map((d) => d.module_properties?.rated_torque ?? null);
        try { mj.FS.mkdir('/working'); } catch { /* exists */ }
        try { mj.FS.mount(mj.MEMFS, { root: '.' }, '/working'); } catch { /* mounted */ }
        this.rebuild(opts);
    }

    /** Rebuild the MuJoCo model (e.g. after a payload change). */
    rebuild(opts = {}) {
        const { xml, jointNames } = mjcfFromModules(this.descriptors, opts);
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
     * Inverse dynamics for a joint state (radians, rad/s, rad/s²).
     * @param {number[]} q
     * @param {number[]} [qdot]
     * @param {number[]} [qddot]
     * @returns {{torque:number[], utilization:number[], utilizationRated:number[]}}
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
        const utilization = new Array(nq);
        const utilizationRated = new Array(nq);
        for (let i = 0; i < nq; i++) {
            const t = data.qfrc_inverse[i];
            torque[i] = t;
            utilization[i] = this.peakTorque[i] ? Math.abs(t) / this.peakTorque[i] : null;
            utilizationRated[i] = this.ratedTorque[i] ? Math.abs(t) / this.ratedTorque[i] : null;
        }
        return { torque, utilization, utilizationRated };
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
