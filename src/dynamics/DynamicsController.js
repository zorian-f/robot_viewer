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
        return new DynamicsController(dyn, dash);
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
        const qRad = anglesDeg.map((d) => d * DEG2RAD);
        const { velocity, acceleration } = this.deriv.update(qRad, tMs);
        const { torque, utilization } = this.dyn.computeTorques(qRad, velocity, acceleration);
        this.dash.render({ angleDeg: anglesDeg, velocity, acceleration, torque, utilization });
    }

    /** @param {number} mass kg @param {number[]} com flange-frame CoM (m) */
    setPayload(mass, com = [0, 0, 0]) {
        this.dyn.setPayload(mass, com);
    }

    dispose() {
        this.dash?.dispose();
        this.dyn?.dispose();
    }
}
