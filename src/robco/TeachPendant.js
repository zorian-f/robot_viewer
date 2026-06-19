/**
 * Teach pendant: a draggable TCP gizmo that drives the arm by inverse kinematics (preview).
 *
 * Translate OR rotate the handle -> the target world pose is mapped into the robot/MuJoCo
 * frame via the model root (model.threeObject is the base frame under SceneManager.world) ->
 * full 6-DOF DLS IK (MujocoKinematics) -> joint angles applied so the arm follows.
 *
 * Modes: Move (translate) / Rotate (all 3 axes). Toggle via the button or W / E keys.
 * Preview only; sending to the robot is gated on the REST client + TEACH mode.
 * While enabled it sets app._teachActive so the live WS mirror pauses (no fight with drags).
 */
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { MujocoKinematics } from '../dynamics/MujocoKinematics.js';

// THREE Matrix4 is column-major; extract the rotation as a row-major 3x3 (MuJoCo convention).
function quatToRowMajor(q) {
    const e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
    return [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
}
function rowMajorToQuat(m) {
    const M = new THREE.Matrix4().set(
        m[0], m[1], m[2], 0,
        m[3], m[4], m[5], 0,
        m[6], m[7], m[8], 0,
        0, 0, 0, 1,
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
        return new TeachPendant(app, model, kin, opts.client || null);
    }

    constructor(app, model, kin, client = null) {
        this.app = app;
        this.model = model;
        this.kin = kin;
        this.client = client; // RobFlowClient for sending; null in static (no-session) mode
        this.sm = app.sceneManager;
        this.jointNames = model.userData.jointOrder;
        this.enabled = false;
        this.mode = 'translate';

        this.target = new THREE.Object3D();
        this._setTargetToTcp();
        this.sm.scene.add(this.target);

        const tc = new TransformControls(this.sm.camera, this.sm.renderer.domElement);
        tc.setMode('translate');
        tc.setSpace('world');
        tc.setSize(0.8);
        tc.addEventListener('dragging-changed', (e) => {
            this.sm.controls.enabled = !e.value;
        });
        tc.addEventListener('objectChange', () => this._onDrag());
        tc.attach(this.target);
        tc.visible = false;
        tc.enabled = false;
        this.sm.scene.add(tc);
        this.tc = tc;

        this._onKey = (e) => {
            if (!this.enabled) return;
            if (e.key === 'w' || e.key === 'W') this._setMode('translate');
            else if (e.key === 'e' || e.key === 'E') this._setMode('rotate');
        };

        this._buildUI();
    }

    _currentQ() {
        return this.jointNames.map((n) => this.model.joints.get(n)?.currentValue ?? 0);
    }

    /** Current TCP world pose (position + quaternion). */
    _tcpPose() {
        const fk = this.kin.fk(this._currentQ());
        this.model.threeObject.updateMatrixWorld(true);
        const position = this.model.threeObject.localToWorld(
            new THREE.Vector3(fk.pos[0], fk.pos[1], fk.pos[2]),
        );
        const qRoot = this.model.threeObject.getWorldQuaternion(new THREE.Quaternion());
        const quaternion = qRoot.multiply(rowMajorToQuat(fk.mat));
        return { position, quaternion };
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
        // Target orientation in the robot frame: R_root_world⁻¹ · R_target_world
        const qRoot = this.model.threeObject.getWorldQuaternion(new THREE.Quaternion());
        const qTarget = this.target.getWorldQuaternion(new THREE.Quaternion());
        const qRobot = qRoot.conjugate().multiply(qTarget);
        const mat = quatToRowMajor(qRobot);

        const res = this.kin.solveIK([local.x, local.y, local.z], mat, this._currentQ());
        this._applyQ(res.q);
        if (this._readout) {
            this._readout.textContent = res.converged
                ? `IK ok · ${res.iters} it · ${(res.posErr * 1000).toFixed(1)} mm / ${(res.rotErr * 180 / Math.PI).toFixed(1)}°`
                : `IK best-effort · ${(res.posErr * 1000).toFixed(0)} mm / ${(res.rotErr * 180 / Math.PI).toFixed(0)}°`;
        }
    }

    /** Re-snap the gizmo to the current TCP (call from the live mirror when not teaching). */
    syncTcp() {
        if (!this.enabled) this._setTargetToTcp();
    }

    _setMode(mode) {
        this.mode = mode;
        this.tc.setMode(mode);
        if (this._modeBtn) {
            this._modeBtn.textContent = mode === 'translate' ? 'Mode: Move (W)' : 'Mode: Rotate (E)';
        }
    }

    setEnabled(on) {
        this.enabled = on;
        this.app._teachActive = on; // pause the live WS mirror while teaching
        this.tc.visible = on;
        this.tc.enabled = on;
        if (on) {
            this._setTargetToTcp();
            window.addEventListener('keydown', this._onKey);
        } else {
            window.removeEventListener('keydown', this._onKey);
        }
        this.btn.textContent = `Teach Pendant: ${on ? 'ON' : 'OFF'}`;
        this.btn.style.background = on ? '#238636' : 'rgba(13,17,23,0.88)';
        this._modeBtn.style.display = on ? 'inline-block' : 'none';
        const showSend = on && !!this.client;
        this._sendBtn.style.display = showSend ? 'inline-block' : 'none';
        this._stopBtn.style.display = showSend ? 'inline-block' : 'none';
        this._readout.style.display = on ? 'block' : 'none';
    }

    toggle() {
        this.setEnabled(!this.enabled);
    }

    /** Send the previewed joint pose to the robot (gated, with confirm). */
    async _send() {
        if (!this.client) return;
        const deg = this._currentQ().map((r) => (r * 180) / Math.PI);
        const pretty = deg.map((d) => d.toFixed(1)).join(', ');
        if (!window.confirm(`Send joint move to the robot?\n\n[${pretty}] °\n\nThe real robot will move. Ensure it is in TEACH mode and the area is clear.`)) {
            return;
        }
        this._readout.textContent = 'sending move…';
        try {
            await this.client.moveJointAngles(deg, { velocity: 0.1, acceleration: 0.1 });
            this._readout.textContent = 'move command sent ✓';
        } catch (e) {
            this._readout.textContent = `send failed: ${e.message}`;
            console.error('[RobCo] send failed:', e);
        }
    }

    async _stop() {
        try {
            await this.client?.stop();
            this._readout.textContent = 'STOP sent';
        } catch (e) {
            this._readout.textContent = `stop failed: ${e.message}`;
        }
    }

    _buildUI() {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:fixed;right:16px;top:16px;z-index:3000;text-align:right;';
        const btnCss =
            'font:600 12px ui-monospace,Menlo,Consolas,monospace;color:#e6edf3;' +
            'background:rgba(13,17,23,0.88);border:1px solid rgba(255,255,255,0.15);' +
            'border-radius:8px;padding:7px 12px;cursor:pointer;backdrop-filter:blur(6px);';

        const btn = document.createElement('button');
        btn.textContent = 'Teach Pendant: OFF';
        btn.style.cssText = btnCss;
        btn.addEventListener('click', () => this.toggle());

        const modeBtn = document.createElement('button');
        modeBtn.textContent = 'Mode: Move (W)';
        modeBtn.style.cssText = btnCss + 'display:none;margin-left:6px;';
        modeBtn.addEventListener('click', () =>
            this._setMode(this.mode === 'translate' ? 'rotate' : 'translate'),
        );

        const sendBtn = document.createElement('button');
        sendBtn.textContent = 'Send to Robot';
        sendBtn.style.cssText = btnCss + 'display:none;margin-left:6px;border-color:#2f81f7;';
        sendBtn.addEventListener('click', () => this._send());

        const stopBtn = document.createElement('button');
        stopBtn.textContent = 'Stop';
        stopBtn.style.cssText =
            btnCss + 'display:none;margin-left:6px;background:#5a1e1e;border-color:#f85149;';
        stopBtn.addEventListener('click', () => this._stop());

        const readout = document.createElement('div');
        readout.style.cssText =
            'margin-top:6px;font:11px ui-monospace,monospace;color:#9da7b3;display:none;';

        const row = document.createElement('div');
        row.append(btn, modeBtn, sendBtn, stopBtn);
        wrap.append(row, readout);
        document.body.appendChild(wrap);
        this.btn = btn;
        this._modeBtn = modeBtn;
        this._sendBtn = sendBtn;
        this._stopBtn = stopBtn;
        this._readout = readout;
        this._buttonWrap = wrap;
    }

    dispose() {
        window.removeEventListener('keydown', this._onKey);
        this.tc?.detach();
        this.tc?.dispose?.();
        this.tc?.parent?.remove(this.tc);
        this.target?.parent?.remove(this.target);
        this._buttonWrap?.remove();
        this.kin?.dispose();
    }
}
