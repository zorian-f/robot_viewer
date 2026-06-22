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
import { registerManipulator, activateManipulator } from './manipulators.js';

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
        this.toolOffset = null; // Matrix4 flange→tool-tip when a tool defines the TCP, else null

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

        // Arbiter: another manipulator activating turns this gizmo off.
        registerManipulator('teach', () => { if (this.enabled) this.setEnabled(false); });
    }

    _currentQ() {
        return this.jointNames.map((n) => this.model.joints.get(n)?.currentValue ?? 0);
    }

    /** Current previewed joint angles in degrees (what Send would transmit). */
    currentAnglesDeg() {
        return this._currentQ().map((r) => (r * 180) / Math.PI);
    }

    /**
     * Define the TCP as a tool tip offset from the flange (Matrix4) or clear it (null).
     * When set, the gizmo, captured waypoints, and IK targets are all at the tool tip.
     */
    setToolOffset(m4) {
        this.toolOffset = m4 ? m4.clone() : null;
        this.syncTcp();
        this.sm.redraw?.();
    }

    _tipFromFlange(flangeM4) {
        return this.toolOffset ? flangeM4.clone().multiply(this.toolOffset) : flangeM4;
    }

    _flangeFromTip(tipM4) {
        return this.toolOffset ? tipM4.clone().multiply(this.toolOffset.clone().invert()) : tipM4;
    }

    _tcpPose() {
        const baseM = this.tcpBaseMatrix(); // flange, or tool tip when a tool offset is set
        this.model.threeObject.updateMatrixWorld(true);
        const pos = new THREE.Vector3().setFromMatrixPosition(baseM);
        const quat = new THREE.Quaternion().setFromRotationMatrix(baseM);
        const position = this.model.threeObject.localToWorld(pos);
        const qRoot = this.model.threeObject.getWorldQuaternion(new THREE.Quaternion());
        return { position, quaternion: qRoot.multiply(quat) };
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
        // Target is the tool tip (base frame); convert to the flange the IK actually solves for.
        const tipBase = new THREE.Matrix4().compose(local, qRoot.conjugate().multiply(qTarget), new THREE.Vector3(1, 1, 1));
        const flangeBase = this._flangeFromTip(tipBase);
        const fpos = new THREE.Vector3().setFromMatrixPosition(flangeBase);
        const fquat = new THREE.Quaternion().setFromRotationMatrix(flangeBase);
        const res = this.kin.solveIK([fpos.x, fpos.y, fpos.z], quatToRowMajor(fquat), this._currentQ());
        this._applyQ(res.q);
        this.onIk?.(res);
        this.onPose?.(this.currentAnglesDeg()); // let the dynamics panel recompute for the new pose
    }

    /** Re-snap the gizmo to the current TCP (call from the live mirror when not teaching). */
    syncTcp() {
        if (!this.enabled) this._setTargetToTcp();
    }

    /** Current TCP pose (flange, or tool tip when a tool offset is set) in the base frame. */
    tcpBaseMatrix() {
        const fk = this.kin.fk(this._currentQ());
        const flange = new THREE.Matrix4().compose(
            new THREE.Vector3(fk.pos[0], fk.pos[1], fk.pos[2]),
            rowMajorToQuat(fk.mat),
            new THREE.Vector3(1, 1, 1),
        );
        return this._tipFromFlange(flange);
    }

    // A base-frame target matrix refers to the TCP (tool tip); the IK solves for the flange.
    _solveTip(m4, seedDeg) {
        const flange = this._flangeFromTip(m4);
        const pos = new THREE.Vector3().setFromMatrixPosition(flange);
        const q = new THREE.Quaternion().setFromRotationMatrix(flange);
        const seed = seedDeg && seedDeg.length ? seedDeg.map((d) => (d * Math.PI) / 180) : this._currentQ();
        return this.kin.solveIK([pos.x, pos.y, pos.z], quatToRowMajor(q), seed);
    }

    /** Solve IK to a base-frame target matrix and apply it (preview). Returns the IK result. */
    goToBaseMatrix(m4, seedDeg) {
        const res = this._solveTip(m4, seedDeg);
        this._applyQ(res.q);
        this.onPose?.(this.currentAnglesDeg());
        this.syncTcp();
        return res;
    }

    /**
     * Test reachability of a base-frame target matrix without moving the arm. Tries the captured
     * seed first (fast path), then a few spread seeds so a poor seed after a large base move
     * doesn't flag a genuinely reachable pose as unreachable.
     */
    checkReachable(m4, seedDeg) {
        if (this._solveTip(m4, seedDeg).converged) return true;
        for (const alt of this._altSeeds()) {
            if (this._solveTip(m4, alt).converged) return true;
        }
        return false;
    }

    /** A small spread of fallback IK seeds (degrees) for the reachability retry. */
    _altSeeds() {
        const n = this.jointNames.length;
        return [
            this.currentAnglesDeg(),                                  // current pose
            new Array(n).fill(0),                                     // home
            Array.from({ length: n }, (_, i) => (i % 2 ? 90 : -90)),  // spread A
            Array.from({ length: n }, (_, i) => (i % 2 ? -120 : 60)), // spread B
        ];
    }

    /** Solve IK to a base-frame target WITHOUT moving the arm; returns joint angles (deg). */
    solveBaseMatrix(m4, seedDeg) {
        const res = this._solveTip(m4, seedDeg);
        return { deg: res.q.map((r) => (r * 180) / Math.PI), converged: res.converged, posErr: res.posErr };
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
            activateManipulator('teach'); // turn off the Setup gizmo / FK drag
            this._setTargetToTcp();
            window.addEventListener('keydown', this._onKey);
        } else {
            window.removeEventListener('keydown', this._onKey);
            if (this.sm?.controls) this.sm.controls.enabled = true; // never leave orbit disabled
        }
        this.onEnabledChange?.(on);
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
