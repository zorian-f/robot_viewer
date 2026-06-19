/**
 * Ties the dynamics pipeline together for a built RobCo model:
 *   live joint angles (deg) -> JointDerivatives -> MujocoDynamics.computeTorques -> dashboard.
 *
 * Use `DynamicsController.attach(model)` after the model is displayed, then call `update()`
 * for each new joint-angle sample (or once for a static pose).
 */
import { JointDerivatives } from './JointDerivatives.js';
import { MujocoDynamics } from './MujocoDynamics.js';
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

        // TCP payload (kg + CoM offset) -> rebuild the dynamics model with a load at the flange.
        dash.onPayloadChange = (kg, com) => ctrl.setPayload(kg, com);
        const payload0 = dash.getPayload?.() || 0;
        if (payload0 > 0) ctrl.dyn.setPayload(payload0, dash.getPayloadComMeters?.() || [0, 0, 0]);

        return ctrl;
    }

    constructor(dyn, dash) {
        this.dyn = dyn;
        this.dash = dash;
        this.deriv = new JointDerivatives();
    }

    /**
     * @param {number[]} anglesDeg - live joint angles (degrees), base->flange.
     * @param {number} [tMs] - sample timestamp.
     */
    update(anglesDeg, tMs) {
        this._lastAngles = anglesDeg;
        const qRad = anglesDeg.map((d) => d * DEG2RAD);
        const { velocity, acceleration } = this.deriv.update(qRad, tMs);
        const { torque, utilization } = this.dyn.computeTorques(qRad, velocity, acceleration);
        this.dash.render({ angleDeg: anglesDeg, velocity, acceleration, torque, utilization });
    }

    /**
     * Recompute at a static pose (zero velocity/acceleration) — used while posing with the
     * teach gizmo, so the panel shows the gravity + payload hold torque at that pose.
     * @param {number[]} anglesDeg
     */
    updateStatic(anglesDeg) {
        this._lastAngles = anglesDeg;
        const qRad = anglesDeg.map((d) => d * DEG2RAD);
        const zeros = qRad.map(() => 0);
        const { torque, utilization } = this.dyn.computeTorques(qRad, zeros, zeros);
        this.dash.render({ angleDeg: anglesDeg, velocity: zeros, acceleration: zeros, torque, utilization });
        this.deriv.reset(); // so a later live stream doesn't differentiate across the manual pose
    }

    /** @param {number} mass kg @param {number[]} com flange-frame CoM (m) */
    setPayload(mass, com = [0, 0, 0]) {
        this.dyn.setPayload(mass, com); // rebuilds the MuJoCo model with the load at the flange
        // Recompute immediately so the change shows even when idle (static pose).
        if (this._lastAngles) this.update(this._lastAngles, performance.now());
    }

    dispose() {
        this.dash?.dispose();
        this.dyn?.dispose();
    }
}
