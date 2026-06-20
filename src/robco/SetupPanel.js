/**
 * Setup panel — cell layout controls, in the same draggable/minimizable style as the View
 * and Render panels. Collapsible sections:
 *   Base         : reposition the robot base within the world (numeric + gizmo). [Phase 1]
 *   Scene        : load a background GLB and align it.                            [Phase 2]
 *   End-Effector : import a tool GLB, align it, set mass + CoM.                   [Phase 5]
 *
 * The Base section drives BaseFrame (which moves the worldGroup = inverse(basePose)).
 */
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { makeDraggable } from './draggable.js';

const PANEL_CSS =
    'position:fixed;left:16px;top:330px;z-index:3000;width:266px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;' +
    'color:#e6edf3;background:rgba(13,17,23,0.9);border:1px solid rgba(255,255,255,0.12);border-radius:10px;' +
    'padding:10px 12px;backdrop-filter:blur(6px);box-shadow:0 6px 24px rgba(0,0,0,0.4);';
const BTN = 'font:600 11px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:5px 9px;cursor:pointer;';
const NUM = 'width:54px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);' +
    'border-radius:4px;color:#e6edf3;padding:2px 4px;font:inherit;text-align:right;';

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
        this._build();
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

        body.append(this._buildBaseSection());

        minBtn.addEventListener('click', () => {
            const hidden = body.style.display === 'none';
            body.style.display = hidden ? 'block' : 'none';
            minBtn.textContent = hidden ? '▾' : '▸';
        });

        document.body.appendChild(root);
        this.root = root;
        makeDraggable(root, t, 'setup');
    }

    /** Public hook so Phase-2/5 modules can append their own sections. */
    addSection(node) {
        this._body.append(node);
    }

    // --- Base section --------------------------------------------------
    _buildBaseSection() {
        const wrap = el('div');
        wrap.append(sectionTitle('Base position (in cell)'));
        wrap.append(el('div', 'font-size:10px;color:#6e7681;margin:-2px 0 5px;',
            'Robot stays at origin; the scene + waypoints move so you can test base placements.'));

        this._fields = {};
        const triple = (labels, keys, step) => {
            const row = el('div', 'display:flex;align-items:center;gap:4px;margin:3px 0;');
            row.append(el('span', 'width:36px;opacity:.8;', labels));
            keys.forEach((k) => {
                const inp = el('input', NUM.replace('width:54px', 'width:46px'));
                inp.type = 'number'; inp.step = String(step);
                inp.addEventListener('change', () => this._applyNumeric());
                this._fields[k] = inp;
                row.append(inp);
            });
            return row;
        };
        wrap.append(triple('mm', ['x', 'y', 'z'], 10));
        wrap.append(triple('deg', ['rx', 'ry', 'rz'], 5));

        const btnRow = el('div', 'display:flex;gap:6px;margin-top:6px;');
        const gizmoBtn = el('button', BTN, 'Gizmo: off');
        gizmoBtn.addEventListener('click', () => this._toggleGizmo(gizmoBtn));
        const modeBtn = el('button', BTN, 'move');
        modeBtn.addEventListener('click', () => this._cycleMode(modeBtn));
        const resetBtn = el('button', BTN, 'Reset');
        resetBtn.addEventListener('click', () => { this.base.reset(); this._refresh(); });
        btnRow.append(gizmoBtn, modeBtn, resetBtn);
        wrap.append(btnRow);

        this._refresh();
        return wrap;
    }

    _applyNumeric() {
        const f = this._fields;
        const pos = new THREE.Vector3(
            (+f.x.value || 0) / 1000, (+f.y.value || 0) / 1000, (+f.z.value || 0) / 1000);
        const e = new THREE.Euler(
            (+f.rx.value || 0) * Math.PI / 180,
            (+f.ry.value || 0) * Math.PI / 180,
            (+f.rz.value || 0) * Math.PI / 180, 'XYZ');
        this.base.setBasePose(pos, new THREE.Quaternion().setFromEuler(e));
    }

    _refresh() {
        const r = this.base.readout();
        const f = this._fields;
        const set = (k, v) => { if (f[k]) f[k].value = Math.round(v * 100) / 100; };
        set('x', r.x); set('y', r.y); set('z', r.z);
        set('rx', r.rx); set('ry', r.ry); set('rz', r.rz);
    }

    _toggleGizmo(btn) {
        if (!this._tc) {
            const tc = new TransformControls(this.sm.camera, this.sm.renderer.domElement);
            tc.setMode('translate');
            tc.setSpace('world');
            tc.setSize(0.7);
            tc.addEventListener('dragging-changed', (e) => { this.sm.controls.enabled = !e.value; });
            tc.addEventListener('objectChange', () => { this.base.recomputeFromWorld(); this._refresh(); });
            tc.attach(this.base.worldGroup);
            this.sm.scene.add(tc);
            this._tc = tc;
        }
        const on = !this._tc.visible;
        this._tc.visible = on;
        this._tc.enabled = on;
        btn.textContent = on ? 'Gizmo: on' : 'Gizmo: off';
        this.sm.redraw?.();
    }

    _cycleMode(btn) {
        const next = btn.textContent === 'move' ? 'rotate' : 'move';
        btn.textContent = next;
        this._tc?.setMode(next === 'move' ? 'translate' : 'rotate');
    }
}
