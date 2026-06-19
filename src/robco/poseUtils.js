/**
 * Shared helpers to apply RobFlow live state (degrees / mm) to a RobCo UnifiedRobotModel.
 */
import * as THREE from 'three';

/**
 * Apply joint angles (degrees, in base->flange joint order) to the model.
 * @param {import('../models/UnifiedRobotModel.js').UnifiedRobotModel} model
 * @param {number[]} anglesDeg
 */
export function applyAnglesDeg(model, anglesDeg) {
    if (!model || !anglesDeg) return;
    const order = model.userData?.jointOrder || [];
    for (let i = 0; i < order.length; i++) {
        const deg = anglesDeg[i];
        if (deg === undefined || deg === null) continue;
        const joint = model.joints.get(order[i]);
        if (!joint) continue;
        const rad = (deg * Math.PI) / 180;
        joint.currentValue = rad;
        joint.threeObject?.setJointValue?.(rad);
    }
}

/**
 * Apply the robot base shift (position mm, orientation deg) to the model root.
 * @param {import('../models/UnifiedRobotModel.js').UnifiedRobotModel} model
 * @param {{position:number[], orientation:number[]}} baseShift
 */
export function applyBaseShift(model, baseShift) {
    const root = model?.threeObject;
    if (!root || !baseShift) return;
    const p = baseShift.position || [0, 0, 0];
    const o = baseShift.orientation || [0, 0, 0];
    root.position.set(p[0] / 1000, p[1] / 1000, p[2] / 1000);
    root.rotation.set(
        (o[0] * Math.PI) / 180,
        (o[1] * Math.PI) / 180,
        (o[2] * Math.PI) / 180,
    );
    root.updateMatrixWorld(true);
}

export { THREE };
