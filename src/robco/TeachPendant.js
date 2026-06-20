/**
 * Teach pendant gizmo engine: a draggable TCP handle driven by inverse kinematics.
 *
 * Drag/rotate the handle -> the target world pose is mapped into the robot/MuJoCo frame via
 * the model root -> full 6-DOF DLS IK (MujocoKinematics) -> joint angles applied so the arm
 * follows. UI (buttons, send, status) lives in RobFlowToolsPanel, which drives this engine.
 *
 * Modes: 'translate' / 'rotate' (all 3 axes). While enabled it sets app._teachActive so the
 * live WS mirror pauses (no fight with drags).
 */
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { MujocoKinematics } from '../dynamics/MujocoKinematics.js';

function quatToRowMajor(q) {
    const e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
    return [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
}
function rowMajorToQuat(m) {
    const M = new THREE.Matrix4().set(
        m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1,
    );
    return new THREE.Quaternion().setFromRotationMatrix(M);
}

export class TeachPendant {
    static async attach(app, model, opts = {}) {
        const nodes = model.userData?.moduleNodes || [];
        const descriptors = nodes.map((n) => n.descriptor).filter(Boolean);
        const jointOrder = model.userData?.jointOrder || [];
        if (jointOrder.length === 0) return null;
        const kin = await MujocoKinematics.create(descriptors, opts);
        return new TeachPendant(app, model, kin);
    }

    constructor(app, model, kin) {
        this.app = app;
        this.model = model;
        this.kin = kin;
        this.sm = app.sceneManager;
        this.jointNames = model.userData.jointOrder;
        this.enabled = false;
        this.mode = 'translate';
        this.onIk = null; // (res) => void

        this.target = new THREE.Object3D();
        this._setTargetToTcp();
        this.sm.scene.add(this.target);

        const tc = new TransformControls(this.sm.camera, this.sm.renderer.domElement);
        tc.setMode('translate');
        tc.setSpace('world');
        tc.setSize(0.8);
        tc.addEventListener('dragging-changed', (e) => { this.sm.controls.enabled = !e.value; });
        tc.addEventListener('objectChange', () => this._onDrag());
        tc.attach(this.target);
        tc.visible = false;
        tc.enabled = false;
        this.sm.scene.add(tc);
        this.tc = tc;

        this._onKey = (e) => {
            if (!this.enabled) return;
            if (e.key === 'w' || e.key === 'W') this.setMode('translate');
            else if (e.key === 'e' || e.key === 'E') this.setMode('rotate');
        };
    }

    _currentQ() {
        return this.jointNames.map((n) => this.model.joints.get(n)?.currentValue ?? 0);
    }

    /** Current previewed joint angles in degrees (what Send would transmit). */
    currentAnglesDeg() {
        return this._currentQ().map((r) => (r * 180) / Math.PI);
    }

    _tcpPose() {
        const fk = this.kin.fk(this._currentQ());
        this.model.threeObject.updateMatrixWorld(true);
        const position = this.model.threeObject.localToWorld(
            new THREE.Vector3(fk.pos[0], fk.pos[1], fk.pos[2]),
        );
        const qRoot = this.model.threeObject.getWorldQuaternion(new THREE.Quaternion());
        return { position, quaternion: qRoot.multiply(rowMajorToQuat(fk.mat)) };
    }

    _setTargetToTcp() {
        const pose = this._tcpPose();
        this.target.position.copy(pose.position);
        this.target.quaternion.copy(pose.quaternion);
    }

    _applyQ(q) {
        this.jointNames.forEach((n, i) => {
            const j = this.model.joints.get(n);
            if (!j) return;
            j.currentValue = q[i];
            j.threeObject?.setJointValue?.(q[i]);
        });
    }

    _onDrag() {
        if (!this.enabled) return;
        this.model.threeObject.updateMatrixWorld(true);
        const local = this.model.threeObject.worldToLocal(this.target.position.clone());
        const qRoot = this.model.threeObject.getWorldQuaternion(new THREE.Quaternion());
        const qTarget = this.target.getWorldQuaternion(new THREE.Quaternion());
        const mat = quatToRowMajor(qRoot.conjugate().multiply(qTarget));
        const res = this.kin.solveIK([local.x, local.y, local.z], mat, this._currentQ());
        this._applyQ(res.q);
        this.onIk?.(res);
        this.onPose?.(this.currentAnglesDeg()); // let the dynamics panel recompute for the new pose
    }

    /** Re-snap the gizmo to the current TCP (call from the live mirror when not teaching). */
    syncTcp() {
        if (!this.enabled) this._setTargetToTcp();
    }

    /** Current TCP pose as a 4x4 matrix in the robot base (root-local, native Z-up) frame. */
    tcpBaseMatrix() {
        const fk = this.kin.fk(this._currentQ());
        return new THREE.Matrix4().compose(
            new THREE.Vector3(fk.pos[0], fk.pos[1], fk.pos[2]),
            rowMajorToQuat(fk.mat),
            new THREE.Vector3(1, 1, 1),
        );
    }

    /** Solve IK to a base-frame target matrix and apply it (preview). Returns the IK result. */
    goToBaseMatrix(m4, seedDeg) {
        const pos = new THREE.Vector3().setFromMatrixPosition(m4);
        const q = new THREE.Quaternion().setFromRotationMatrix(m4);
        const seed = seedDeg && seedDeg.length ? seedDeg.map((d) => (d * Math.PI) / 180) : this._currentQ();
        const res = this.kin.solveIK([pos.x, pos.y, pos.z], quatToRowMajor(q), seed);
        this._applyQ(res.q);
        this.onPose?.(this.currentAnglesDeg());
        this.syncTcp();
        return res;
    }

    /** Test reachability of a base-frame target matrix without moving the arm. */
    checkReachable(m4, seedDeg) {
        const pos = new THREE.Vector3().setFromMatrixPosition(m4);
        const q = new THREE.Quaternion().setFromRotationMatrix(m4);
        const seed = seedDeg && seedDeg.length ? seedDeg.map((d) => (d * Math.PI) / 180) : this._currentQ();
        return this.kin.solveIK([pos.x, pos.y, pos.z], quatToRowMajor(q), seed).converged;
    }

    setMode(mode) {
        this.mode = mode;
        this.tc.setMode(mode);
        this.onModeChange?.(mode);
    }

    setEnabled(on) {
        this.enabled = on;
        this.app._teachActive = on;
        this.tc.visible = on;
        this.tc.enabled = on;
        if (on) {
            this._setTargetToTcp();
            window.addEventListener('keydown', this._onKey);
        } else {
            window.removeEventListener('keydown', this._onKey);
        }
    }

    dispose() {
        window.removeEventListener('keydown', this._onKey);
        this.tc?.detach();
        this.tc?.dispose?.();
        this.tc?.parent?.remove(this.tc);
        this.target?.parent?.remove(this.target);
        this.kin?.dispose();
    }
}
