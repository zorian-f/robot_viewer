/**
 * Ties the dynamics pipeline together for a built RobCo model:
 *   live joint angles (deg) -> JointDerivatives -> MujocoDynamics.computeTorques -> dashboard.
 *
 * Use `DynamicsController.attach(model)` after the model is displayed, then call `update()`
 * for each new joint-angle sample (or once for a static pose).
 */
import * as THREE from 'three';
import { JointDerivatives } from './JointDerivatives.js';
import { MujocoDynamics } from './MujocoDynamics.js';
import { I2tModel } from './I2tModel.js';
import { DynamicsDashboard } from './DynamicsDashboard.js';

const DEG2RAD = Math.PI / 180;

export class DynamicsController {
    /**
     * @param {import('../models/UnifiedRobotModel.js').UnifiedRobotModel} model
     * @param {Object} [opts] - {payloadMass, payloadCom, parent}
     * @returns {Promise<DynamicsController|null>} null if there are no drive joints.
     */
    static async attach(model, opts = {}) {
        const nodes = model.userData?.moduleNodes || [];
        const descriptors = nodes.map((n) => n.descriptor).filter(Boolean);
        const jointOrder = model.userData?.jointOrder || [];
        if (jointOrder.length === 0) return null;

        const dyn = await MujocoDynamics.create(descriptors, opts);
        const dash = new DynamicsDashboard(jointOrder, opts.parent);
        const ctrl = new DynamicsController(dyn, dash);

        // Live-tune the derivative estimator from the panel's settings (fixed Δt on/off + ms).
        ctrl.deriv.setOptions(dash.getSettings());
        dash.onSettingsChange = (s) => ctrl.deriv.setOptions(s);
        ctrl._initMarker(model);

        // Motor-model toggle (real-hardware vs twin-accurate). Recompute on change so the
        // panel updates even while idle.
        ctrl.dyn.setMotorModel(dash.getMotorModel?.() ?? true);
        dash.onMotorModelChange = (on) => {
            ctrl.dyn.setMotorModel(on);
            if (ctrl._lastAngles) ctrl.update(ctrl._lastAngles, performance.now());
        };

        // TCP payload (kg + CoM offset) -> rebuild the dynamics model with a load at the flange.
        dash.onPayloadChange = (kg, com) => ctrl.setPayload(kg, com);
        const payload0 = dash.getPayload?.() || 0;
        const com0 = dash.getPayloadComMeters?.() || [0, 0, 0];
        if (payload0 > 0) ctrl.dyn.setPayload(payload0, com0);
        ctrl._updateMarker(payload0, com0);

        return ctrl;
    }

    constructor(dyn, dash) {
        this.dyn = dyn;
        this.dash = dash;
        this.deriv = new JointDerivatives();
        // i²t heat index, seeded from the drives' motor-side current limits and per-motor peak
        // times (Synapticon 0x200A:2, baked from the Circulo .csv; unknown motors default 10 s).
        this.i2t = new I2tModel(dyn.ratedCurrent, dyn.maxCurrent, { tPeakSec: dyn.peakTime });
        this._lastT = null; // ms, for real-Δt thermal integration
    }

    /**
     * @param {number[]} anglesDeg - live joint angles (degrees), base->flange.
     * @param {number} [tMs] - sample timestamp.
     */
    /**
     * Re-express world gravity in the robot base frame when the base mount orientation changes
     * (wall/ceiling mounts shift the static hold torque substantially). Rebuilds the MuJoCo
     * model only on an actual orientation change. Reads the BaseFrame lazily (it may be created
     * after this controller). g_base = baseQuat⁻¹ · [0,0,-9.81].
     */
    _syncGravity() {
        const base = this._baseFrame || (typeof window !== 'undefined' ? window._robcoBaseFrame : null);
        if (!base?.baseQuat) return;
        this._baseFrame = base;
        const q = base.baseQuat;
        const key = `${q.x},${q.y},${q.z},${q.w}`;
        if (key === this._baseQuatKey) return;
        this._baseQuatKey = key;
        const g = new THREE.Vector3(0, 0, -9.81).applyQuaternion(q.clone().invert());
        this.dyn.setGravity([g.x, g.y, g.z]);
    }

    update(anglesDeg, tMs = performance.now()) {
        this._lastAngles = anglesDeg;
        this._syncGravity();
        const qRad = anglesDeg.map((d) => d * DEG2RAD);
        const { velocity, acceleration } = this.deriv.update(qRad, tMs);
        const { torque, utilization, current, currentUtil } =
            this.dyn.computeTorques(qRad, velocity, acceleration);
        // Integrate the i²t heat index over real elapsed time (thermal, not the differentiation Δt).
        const dtSec = this._lastT == null ? 0 : (tMs - this._lastT) / 1000;
        this._lastT = tMs;
        const heat = this.i2t.update(current, dtSec);
        this.dash.render({ angleDeg: anglesDeg, velocity, acceleration, torque, utilization, current, currentUtil, heat });
    }

    /**
     * Recompute at a static pose (zero velocity/acceleration) — used while posing with the
     * teach gizmo, so the panel shows the gravity + payload hold torque at that pose.
     * @param {number[]} anglesDeg
     */
    updateStatic(anglesDeg) {
        this._lastAngles = anglesDeg;
        this._syncGravity();
        const qRad = anglesDeg.map((d) => d * DEG2RAD);
        const zeros = qRad.map(() => 0);
        // At zero velocity/acceleration the friction and motor-inertia terms vanish, so this is
        // the pure gravity + payload hold torque (Coulomb friction at standstill is indeterminate
        // and intentionally not added).
        const { torque, utilization, current, currentUtil } = this.dyn.computeTorques(qRad, zeros, zeros);
        // A manual gizmo pose is a what-if, not a real time series: hold the heat index (don't
        // accumulate) and reset the thermal clock so the next live sample sees no fake gap.
        this._lastT = null;
        const heat = this.i2t.heat.slice();
        this.dash.render({ angleDeg: anglesDeg, velocity: zeros, acceleration: zeros, torque, utilization, current, currentUtil, heat });
        this.deriv.reset(); // so a later live stream doesn't differentiate across the manual pose
    }

    /** @param {number} mass kg @param {number[]} com flange-frame CoM (m) */
    setPayload(mass, com = [0, 0, 0]) {
        this.dyn.setPayload(mass, com); // rebuilds the MuJoCo model with the load at the flange
        this._updateMarker(mass, com);
        // Recompute immediately so the change shows even when idle (static pose).
        if (this._lastAngles) this.update(this._lastAngles, performance.now());
    }

    /** A black sphere at the flange marking the payload; sits at the CoM offset, sized by mass. */
    _initMarker(model) {
        const nodes = model.userData?.moduleNodes || [];
        const flange = nodes.length
            ? (nodes[nodes.length - 1].getDistalLink?.() || nodes[nodes.length - 1].distal)
            : model.threeObject;
        if (!flange) return;
        const mat = new THREE.MeshStandardMaterial({ color: 0x0d0d0d, roughness: 0.45, metalness: 0.1 });
        this._marker = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), mat);
        this._marker.castShadow = true;
        this._marker.visible = false;
        flange.add(this._marker);
    }

    _updateMarker(mass, com = [0, 0, 0]) {
        if (!this._marker) return;
        this._marker.visible = mass > 0;
        this._marker.position.set(com[0] || 0, com[1] || 0, com[2] || 0);
        const r = 0.025 + 0.02 * Math.cbrt(Math.max(0, mass)); // grows gently with load
        this._marker.scale.setScalar(r);
    }

    dispose() {
        this.dash?.dispose();
        this.dyn?.dispose();
    }
}
