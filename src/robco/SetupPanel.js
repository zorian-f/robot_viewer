/**
 * Setup panel — cell layout controls, in the same draggable/minimizable style as the View
 * and Render panels. Collapsible sections:
 *   Base         : reposition the robot base within the world (numeric + gizmo). [Phase 1]
 *   Scene        : load a background GLB and align it in the world.              [Phase 2]
 *   End-Effector : import a tool GLB, align it, set mass + CoM.                  [Phase 5]
 *
 * A single shared TransformControls gizmo is reused across sections (only one editable at a
 * time). The Base section drives BaseFrame (worldGroup = inverse(basePose)); the Scene section
 * transforms a GLB parented into the worldGroup.
 */
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { makeDraggable } from './draggable.js';
import { registerManipulator, activateManipulator, deactivateManipulator } from './manipulators.js';

const PANEL_CSS =
    'position:fixed;left:16px;top:330px;z-index:3000;width:272px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;' +
    'color:#e6edf3;background:rgba(13,17,23,0.9);border:1px solid rgba(255,255,255,0.12);border-radius:10px;' +
    'padding:10px 12px;backdrop-filter:blur(6px);box-shadow:0 6px 24px rgba(0,0,0,0.4);max-height:80vh;overflow:auto;';
const BTN = 'font:600 11px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:5px 9px;cursor:pointer;';
const NUM = 'width:46px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);' +
    'border-radius:4px;color:#e6edf3;padding:2px 4px;font:inherit;text-align:right;';
const SCENE_KEY = 'robco-scene-transform';
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
}
function sectionTitle(t) {
    return el('div', 'font-weight:600;letter-spacing:.04em;opacity:.85;margin:10px 0 5px;text-transform:uppercase;font-size:10px;', t);
}

export class SetupPanel {
    static ensure(sm, baseFrame) {
        if (window._robcoSetupPanel) {
            window._robcoSetupPanel.sm = sm;
            window._robcoSetupPanel.base = baseFrame;
            return window._robcoSetupPanel;
        }
        const p = new SetupPanel(sm, baseFrame);
        window._robcoSetupPanel = p;
        return p;
    }

    constructor(sm, baseFrame) {
        this.sm = sm;
        this.base = baseFrame;
        this.scene = null; // loaded GLB group
        this._editing = null; // current gizmo target name
        this._build();
        // Arbiter: another manipulator activating closes this gizmo.
        registerManipulator('setup-gizmo', () => this._stopEdit());
    }

    _build() {
        const root = el('div', PANEL_CSS);
        const header = el('div', 'display:flex;align-items:center;justify-content:space-between;font-weight:600;color:#fff;');
        const t = el('span', null, 'Setup  ⠿');
        const minBtn = el('button', 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#e6edf3;border-radius:6px;cursor:pointer;width:22px;height:20px;', '▾');
        header.append(t, minBtn);
        root.append(header);
        const body = el('div', 'margin-top:6px;');
        root.append(body);
        this._body = body;

        // shared gizmo mode bar
        this._modeBar = el('div', 'display:none;gap:6px;margin:4px 0;align-items:center;');
        this._modeBar.append(el('span', 'opacity:.7;', 'gizmo:'));
        ['translate', 'rotate', 'scale'].forEach((m) => {
            const b = el('button', BTN, m === 'translate' ? 'move' : m === 'rotate' ? 'rot' : 'scale');
            b.dataset.mode = m;
            b.addEventListener('click', () => this._setMode(m));
            this._modeBar.append(b);
        });
        const done = el('button', BTN, 'done');
        done.addEventListener('click', () => this._stopEdit());
        this._modeBar.append(done);

        body.append(this._buildBaseSection());
        body.append(this._modeBar);
        body.append(this._buildSceneSection());

        minBtn.addEventListener('click', () => {
            const hidden = body.style.display === 'none';
            body.style.display = hidden ? 'block' : 'none';
            minBtn.textContent = hidden ? '▾' : '▸';
        });

        document.body.appendChild(root);
        this.root = root;
        makeDraggable(root, t, 'setup');
    }

    addSection(node) { this._body.append(node); }

    // --- shared gizmo --------------------------------------------------
    _ensureGizmo() {
        if (this._tc) return this._tc;
        const tc = new TransformControls(this.sm.camera, this.sm.renderer.domElement);
        tc.setSpace('world');
        tc.setSize(0.7);
        tc.addEventListener('dragging-changed', (e) => { this.sm.controls.enabled = !e.value; });
        tc.addEventListener('objectChange', () => { this._onGizmo?.(); });
        this.sm.scene.add(tc);
        this._tc = tc;
        return tc;
    }

    _edit(name, target, modes, onChange) {
        activateManipulator('setup-gizmo'); // turn off teach gizmo / FK drag
        const tc = this._ensureGizmo();
        tc.attach(target);
        tc.setMode(modes[0]);
        tc.visible = true;
        tc.enabled = true;
        this._editing = name;
        this._onGizmo = onChange;
        this._allowedModes = modes;
        this._modeBar.style.display = 'flex';
        // dim mode buttons not allowed for this target (e.g. base has no scale)
        [...this._modeBar.querySelectorAll('button[data-mode]')].forEach((b) => {
            b.style.opacity = modes.includes(b.dataset.mode) ? '1' : '0.3';
        });
        this.sm.redraw?.();
    }

    _stopEdit() {
        if (this._tc) { this._tc.visible = false; this._tc.enabled = false; this._tc.detach(); }
        this._editing = null;
        this._onGizmo = null;
        this._modeBar.style.display = 'none';
        if (this.sm?.controls) this.sm.controls.enabled = true; // never leave orbit disabled
        deactivateManipulator('setup-gizmo');
        this.sm.redraw?.();
    }

    _setMode(m) {
        if (this._allowedModes && !this._allowedModes.includes(m)) return;
        this._tc?.setMode(m);
    }

    // --- Base section --------------------------------------------------
    _buildBaseSection() {
        const wrap = el('div');
        wrap.append(sectionTitle('Base position (in cell)'));
        wrap.append(el('div', 'font-size:10px;color:#6e7681;margin:-2px 0 5px;',
            'Robot stays at origin; the scene + waypoints move so you can test base placements.'));

        this._baseFields = {};
        const triple = (label, keys, step) => {
            const row = el('div', 'display:flex;align-items:center;gap:4px;margin:3px 0;');
            row.append(el('span', 'width:34px;opacity:.8;', label));
            keys.forEach((k) => {
                const inp = el('input', NUM);
                inp.type = 'number'; inp.step = String(step);
                inp.addEventListener('change', () => this._applyBaseNumeric());
                this._baseFields[k] = inp;
                row.append(inp);
            });
            return row;
        };
        wrap.append(triple('mm', ['x', 'y', 'z'], 10));
        wrap.append(triple('deg', ['rx', 'ry', 'rz'], 5));

        const btnRow = el('div', 'display:flex;gap:6px;margin-top:6px;');
        const editBtn = el('button', BTN, 'Drag world');
        editBtn.addEventListener('click', () =>
            this._edit('base', this.base.worldGroup, ['translate', 'rotate'],
                () => { this.base.recomputeFromWorld(); this._refreshBase(); }));
        const resetBtn = el('button', BTN, 'Reset');
        resetBtn.addEventListener('click', () => { this.base.reset(); this._refreshBase(); });
        btnRow.append(editBtn, resetBtn);
        wrap.append(btnRow);

        this._refreshBase();
        return wrap;
    }

    _applyBaseNumeric() {
        const f = this._baseFields;
        const pos = new THREE.Vector3((+f.x.value || 0) / 1000, (+f.y.value || 0) / 1000, (+f.z.value || 0) / 1000);
        const e = new THREE.Euler((+f.rx.value || 0) * D2R, (+f.ry.value || 0) * D2R, (+f.rz.value || 0) * D2R, 'XYZ');
        this.base.setBasePose(pos, new THREE.Quaternion().setFromEuler(e));
    }

    _refreshBase() {
        const r = this.base.readout();
        const f = this._baseFields;
        const set = (k, v) => { if (f[k]) f[k].value = Math.round(v * 100) / 100; };
        set('x', r.x); set('y', r.y); set('z', r.z); set('rx', r.rx); set('ry', r.ry); set('rz', r.rz);
    }

    // --- Scene section -------------------------------------------------
    _buildSceneSection() {
        const wrap = el('div');
        wrap.append(sectionTitle('Scene'));
        this._sceneStatus = el('div', 'font-size:11px;color:#9da7b3;margin-bottom:4px;', 'no scene loaded');
        wrap.append(this._sceneStatus);

        const fileInput = el('input');
        fileInput.type = 'file';
        fileInput.accept = '.glb,.gltf';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', () => {
            if (fileInput.files?.[0]) this._loadScene(fileInput.files[0]);
        });
        wrap.append(fileInput);

        const row1 = el('div', 'display:flex;gap:6px;');
        const loadBtn = el('button', BTN, 'Load GLB…');
        loadBtn.addEventListener('click', () => fileInput.click());
        const editBtn = el('button', BTN, 'Align');
        editBtn.addEventListener('click', () => {
            if (!this.scene) return;
            this._edit('scene', this.scene, ['translate', 'rotate', 'scale'], () => this._onSceneGizmo());
        });
        row1.append(loadBtn, editBtn);
        wrap.append(row1);

        this._sceneFields = {};
        const triple = (label, keys, step) => {
            const row = el('div', 'display:flex;align-items:center;gap:4px;margin:3px 0;');
            row.append(el('span', 'width:34px;opacity:.8;', label));
            keys.forEach((k) => {
                const inp = el('input', NUM);
                inp.type = 'number'; inp.step = String(step);
                inp.addEventListener('change', () => this._applySceneNumeric());
                this._sceneFields[k] = inp;
                row.append(inp);
            });
            return row;
        };
        const sceneBody = el('div', 'display:none;');
        sceneBody.append(triple('m', ['px', 'py', 'pz'], 0.1));
        sceneBody.append(triple('deg', ['rx', 'ry', 'rz'], 15));
        const scaleRow = el('div', 'display:flex;align-items:center;gap:6px;margin:3px 0;');
        scaleRow.append(el('span', 'width:34px;opacity:.8;', 'scale'));
        const scaleIn = el('input', NUM.replace('width:46px', 'width:64px'));
        scaleIn.type = 'number'; scaleIn.step = '0.05'; scaleIn.value = '1';
        scaleIn.addEventListener('change', () => this._applySceneNumeric());
        this._sceneFields.scale = scaleIn;
        scaleRow.append(scaleIn);
        sceneBody.append(scaleRow);

        const row2 = el('div', 'display:flex;gap:6px;margin-top:4px;');
        const yup = el('button', BTN, 'Y-up→Z-up');
        yup.addEventListener('click', () => this._sceneYupToZup());
        const reset = el('button', BTN, 'Reset');
        reset.addEventListener('click', () => this._resetScene());
        const remove = el('button', BTN, 'Remove');
        remove.addEventListener('click', () => this._removeScene());
        row2.append(yup, reset, remove);
        sceneBody.append(row2);
        wrap.append(sceneBody);
        this._sceneBody = sceneBody;
        return wrap;
    }

    async _loadScene(file) {
        this._sceneStatus.textContent = `loading ${file.name}…`;
        const url = URL.createObjectURL(file);
        try {
            const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
            const gltf = await new Promise((res, rej) => new GLTFLoader().load(url, res, undefined, rej));
            this._removeScene();
            const g = gltf.scene || gltf;
            g.name = 'robco-scene';
            this.scene = g;
            this.base.attach(g);
            this._sceneFileName = file.name;
            this._restoreSceneTransform();
            this._refreshScene();
            this._sceneBody.style.display = 'block';
            this._sceneStatus.textContent = `scene: ${file.name}`;
            this.sm.redraw?.();
        } catch (e) {
            console.warn('[RobCo] scene load failed:', e);
            this._sceneStatus.textContent = `load failed: ${e.message}`;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    _onSceneGizmo() {
        this._refreshScene();
        this._persistSceneTransform();
    }

    _applySceneNumeric() {
        if (!this.scene) return;
        const f = this._sceneFields;
        this.scene.position.set(+f.px.value || 0, +f.py.value || 0, +f.pz.value || 0);
        this.scene.rotation.set((+f.rx.value || 0) * D2R, (+f.ry.value || 0) * D2R, (+f.rz.value || 0) * D2R);
        const s = +f.scale.value || 1;
        this.scene.scale.setScalar(s);
        this._persistSceneTransform();
        this.sm.redraw?.();
    }

    _refreshScene() {
        if (!this.scene) return;
        const f = this._sceneFields;
        const p = this.scene.position;
        const e = new THREE.Euler().setFromQuaternion(this.scene.quaternion, 'XYZ');
        const r = (v) => Math.round(v * 1000) / 1000;
        f.px.value = r(p.x); f.py.value = r(p.y); f.pz.value = r(p.z);
        f.rx.value = Math.round(e.x * R2D); f.ry.value = Math.round(e.y * R2D); f.rz.value = Math.round(e.z * R2D);
        f.scale.value = r(this.scene.scale.x);
    }

    _sceneYupToZup() {
        if (!this.scene) return;
        this.scene.rotateX(Math.PI / 2);
        this._refreshScene();
        this._persistSceneTransform();
        this.sm.redraw?.();
    }

    _resetScene() {
        if (!this.scene) return;
        this.scene.position.set(0, 0, 0);
        this.scene.rotation.set(0, 0, 0);
        this.scene.scale.setScalar(1);
        this._refreshScene();
        this._persistSceneTransform();
        this.sm.redraw?.();
    }

    _removeScene() {
        if (this._editing === 'scene') this._stopEdit();
        if (this.scene) { this.scene.parent?.remove(this.scene); this.scene = null; }
        this._sceneBody.style.display = 'none';
        this._sceneStatus.textContent = 'no scene loaded';
        this.sm.redraw?.();
    }

    _persistSceneTransform() {
        if (!this.scene) return;
        try {
            const p = this.scene.position;
            const e = new THREE.Euler().setFromQuaternion(this.scene.quaternion, 'XYZ');
            localStorage.setItem(SCENE_KEY, JSON.stringify({
                pos: [p.x, p.y, p.z], euler: [e.x, e.y, e.z], scale: this.scene.scale.x,
            }));
        } catch { /* ignore */ }
    }

    _restoreSceneTransform() {
        try {
            const s = JSON.parse(localStorage.getItem(SCENE_KEY));
            if (s && this.scene) {
                this.scene.position.fromArray(s.pos || [0, 0, 0]);
                this.scene.rotation.set(...(s.euler || [0, 0, 0]));
                this.scene.scale.setScalar(s.scale || 1);
            }
        } catch { /* ignore */ }
    }
}
