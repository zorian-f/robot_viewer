/**
 * Teach pendant: a draggable TCP gizmo that drives the arm by inverse kinematics (preview).
 *
 * Drag the handle -> the target world position is mapped into the robot/MuJoCo frame via the
 * model root (model.threeObject is the base frame under SceneManager.world) -> position-only
 * DLS IK (MujocoKinematics) -> joint angles applied to the model so the arm follows.
 *
 * v1: position-only (translate handle), preview only. Sending to the robot is gated behind
 * the REST client + TEACH mode (P5 send / P2). While enabled it sets app._teachActive so the
 * live WS mirror pauses (no fight between dragging and incoming jointAngles).
 */
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { MujocoKinematics } from '../dynamics/MujocoKinematics.js';

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

        this.target = new THREE.Object3D();
        this.target.position.copy(this._tcpWorld());
        this.sm.scene.add(this.target);

        const tc = new TransformControls(this.sm.camera, this.sm.renderer.domElement);
        tc.setMode('translate');
        tc.setSpace('world');
        tc.addEventListener('dragging-changed', (e) => {
            this.sm.controls.enabled = !e.value;
        });
        tc.addEventListener('objectChange', () => this._onDrag());
        tc.attach(this.target);
        tc.visible = false;
        tc.enabled = false;
        this.sm.scene.add(tc);
        this.tc = tc;

        this._buildButton();
    }

    _currentQ() {
        return this.jointNames.map((n) => this.model.joints.get(n)?.currentValue ?? 0);
    }

    _tcpWorld() {
        const p = this.kin.fk(this._currentQ()).pos;
        this.model.threeObject.updateMatrixWorld(true);
        return this.model.threeObject.localToWorld(new THREE.Vector3(p[0], p[1], p[2]));
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
        const res = this.kin.solveIK([local.x, local.y, local.z], null, this._currentQ());
        this._applyQ(res.q);
        if (this._readout) {
            this._readout.textContent = res.converged
                ? `IK ok (${res.iters} it, ${(res.posErr * 1000).toFixed(1)} mm)`
                : `IK best-effort (${(res.posErr * 1000).toFixed(0)} mm)`;
        }
    }

    /** Re-snap the gizmo to the current TCP (call from the live mirror when not teaching). */
    syncTcp() {
        if (!this.enabled) this.target.position.copy(this._tcpWorld());
    }

    setEnabled(on) {
        this.enabled = on;
        this.app._teachActive = on; // pause the live WS mirror while teaching
        this.tc.visible = on;
        this.tc.enabled = on;
        if (on) this.target.position.copy(this._tcpWorld());
        this.btn.textContent = `Teach Pendant: ${on ? 'ON' : 'OFF'}`;
        this.btn.style.background = on ? '#238636' : 'rgba(13,17,23,0.88)';
        if (this._readout) this._readout.style.display = on ? 'block' : 'none';
    }

    toggle() {
        this.setEnabled(!this.enabled);
    }

    _buildButton() {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:fixed;right:16px;top:16px;z-index:3000;text-align:right;';
        const btn = document.createElement('button');
        btn.textContent = 'Teach Pendant: OFF';
        btn.style.cssText =
            'font:600 12px ui-monospace,Menlo,Consolas,monospace;color:#e6edf3;' +
            'background:rgba(13,17,23,0.88);border:1px solid rgba(255,255,255,0.15);' +
            'border-radius:8px;padding:7px 12px;cursor:pointer;backdrop-filter:blur(6px);';
        btn.addEventListener('click', () => this.toggle());
        const readout = document.createElement('div');
        readout.style.cssText =
            'margin-top:6px;font:11px ui-monospace,monospace;color:#9da7b3;display:none;';
        wrap.append(btn, readout);
        document.body.appendChild(wrap);
        this.btn = btn;
        this._readout = readout;
        this._buttonWrap = wrap;
    }

    dispose() {
        this.tc?.detach();
        this.tc?.dispose?.();
        this.tc?.parent?.remove(this.tc);
        this.target?.parent?.remove(this.target);
        this._buttonWrap?.remove();
        this.kin?.dispose();
    }
}
