/**
 * Floating per-joint dynamics panel: angle / velocity / acceleration / torque / utilization.
 *
 * Pure DOM (no framework), styled to sit over the three.js canvas. Built once for a given
 * joint count; `render()` just updates values + the utilization bars.
 */
import { makeDraggable } from '../robco/draggable.js';

const RAD2DEG = 180 / Math.PI;

function utilColor(u) {
    if (u == null) return '#5b6b7a';
    if (u < 0.5) return '#3fb950'; // green
    if (u < 0.8) return '#d29922'; // amber
    return '#f85149'; // red
}

// i²t heat index colour (% of the limiting threshold; the drive starts limiting at 100,
// releases at 50). Uses a cooler palette to read as "thermal" vs the load bar above.
function heatColor(h) {
    if (h == null) return 'transparent';
    if (h < 50) return '#2f81f7'; // blue (cool)
    if (h < 100) return '#d29922'; // amber (warming)
    return '#f85149'; // red (limiting)
}

export class DynamicsDashboard {
    /**
     * @param {string[]} jointLabels - one label per joint (base->flange).
     * @param {HTMLElement} [parent=document.body]
     */
    constructor(jointLabels, parent = document.body) {
        this.jointLabels = jointLabels;
        this.rows = [];
        /** @type {?(s:{fixedDt:boolean,fixedDtMs:number})=>void} */
        this.onSettingsChange = null;
        /** @type {?(kg:number)=>void} */
        this.onPayloadChange = null;
        /** @type {?(on:boolean)=>void} */
        this.onMotorModelChange = null;
        this.settings = DynamicsDashboard._loadSettings();
        this._motorModel = DynamicsDashboard._loadMotorModel();
        const pay = DynamicsDashboard._loadPayload();
        this._payloadKg = pay.kg;
        this._payloadCom = pay.com; // CoM offset from the flange/TCP, in mm
        this._build(parent);
    }

    getPayload() {
        return this._payloadKg;
    }

    /** CoM offset converted to metres (what MujocoDynamics.setPayload expects). */
    getPayloadComMeters() {
        return this._payloadCom.map((v) => v / 1000);
    }

    static _loadPayload() {
        try {
            const raw = JSON.parse(localStorage.getItem('robco-tcp-payload'));
            if (typeof raw === 'number') return { kg: Math.max(0, raw), com: [0, 0, 0] }; // legacy
            if (raw && typeof raw === 'object') {
                return { kg: Math.max(0, raw.kg || 0), com: Array.isArray(raw.com) ? raw.com : [0, 0, 0] };
            }
        } catch { /* ignore */ }
        return { kg: 0, com: [0, 0, 0] };
    }

    static _savePayload(kg, com) {
        try { localStorage.setItem('robco-tcp-payload', JSON.stringify({ kg, com })); } catch { /* ignore */ }
    }

    getSettings() {
        return { ...this.settings };
    }

    /** @returns {boolean} whether the motor model (friction + inertia + current) is applied. */
    getMotorModel() {
        return this._motorModel;
    }

    static _loadMotorModel() {
        try {
            const v = JSON.parse(localStorage.getItem('robco-dyn-motormodel'));
            if (typeof v === 'boolean') return v;
        } catch { /* ignore */ }
        return true; // default: real-hardware-accurate
    }

    static _saveMotorModel(on) {
        try { localStorage.setItem('robco-dyn-motormodel', JSON.stringify(!!on)); } catch { /* ignore */ }
    }

    static _loadSettings() {
        try {
            const s = JSON.parse(localStorage.getItem('robco-dyn-settings'));
            if (s && typeof s.fixedDt === 'boolean') {
                return { fixedDt: s.fixedDt, fixedDtMs: s.fixedDtMs > 0 ? s.fixedDtMs : 62.5 };
            }
        } catch { /* ignore */ }
        return { fixedDt: true, fixedDtMs: 62.5 };
    }

    static _saveSettings(s) {
        try {
            localStorage.setItem('robco-dyn-settings', JSON.stringify(s));
        } catch { /* ignore */ }
    }

    _build(parent) {
        const el = document.createElement('div');
        el.className = 'robco-dynamics-panel';
        el.style.cssText = `
            position: fixed; left: 16px; bottom: 16px; z-index: 3000;
            font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace;
            color: #e6edf3; background: rgba(13,17,23,0.88);
            border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
            padding: 10px 12px; min-width: 400px; backdrop-filter: blur(6px);
            box-shadow: 0 6px 24px rgba(0,0,0,0.4);`;

        const title = document.createElement('div');
        title.textContent = 'Joint Dynamics  ⠿';
        title.style.cssText = 'font-weight:600;margin-bottom:8px;letter-spacing:.04em;color:#fff;';
        el.appendChild(title);
        this._title = title;

        // TCP payload — mass (kg) + CoM offset (mm, flange frame); included in torque / util.
        const inputCss = 'background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);' +
            'border-radius:4px;color:#e6edf3;padding:2px 4px;font:inherit;text-align:right;';
        const numIn = (val, w) => {
            const i = document.createElement('input');
            i.type = 'number'; i.step = '1'; i.value = String(val);
            i.style.cssText = inputCss + `width:${w}px;`;
            return i;
        };
        const dim = (t) => { const s = document.createElement('span'); s.textContent = t; s.style.opacity = '.6'; return s; };

        const massIn = numIn(this._payloadKg, 58);
        massIn.step = '0.1';
        const cx = numIn(this._payloadCom[0], 40);
        const cy = numIn(this._payloadCom[1], 40);
        const cz = numIn(this._payloadCom[2], 40);

        const emitPayload = () => {
            this._payloadKg = Math.max(0, parseFloat(massIn.value) || 0);
            massIn.value = String(this._payloadKg);
            this._payloadCom = [cx, cy, cz].map((i) => parseFloat(i.value) || 0);
            DynamicsDashboard._savePayload(this._payloadKg, this._payloadCom);
            this.onPayloadChange?.(this._payloadKg, this.getPayloadComMeters());
        };
        [massIn, cx, cy, cz].forEach((i) => i.addEventListener('change', emitPayload));

        const massRow = document.createElement('div');
        massRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px;';
        const massLbl = document.createElement('span'); massLbl.textContent = 'TCP load'; massLbl.style.opacity = '.8';
        massRow.append(massLbl, massIn, dim('kg'));
        el.appendChild(massRow);

        const comRow = document.createElement('div');
        comRow.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:8px;font-size:11px;';
        const comLbl = document.createElement('span'); comLbl.textContent = 'CoM'; comLbl.style.cssText = 'opacity:.8;margin-right:2px;';
        comRow.append(comLbl, dim('x'), cx, dim('y'), cy, dim('z'), cz, dim('mm'));
        el.appendChild(comRow);

        const head = document.createElement('div');
        head.style.cssText =
            'display:grid;grid-template-columns:30px 48px 48px 48px 54px 48px 1fr;gap:6px;' +
            'opacity:.6;margin-bottom:4px;';
        ['', '°', '°/s', '°/s²', 'N·m', 'A', 'util'].forEach((h) => {
            const c = document.createElement('div');
            c.textContent = h;
            c.style.textAlign = h === '' ? 'left' : 'right';
            head.appendChild(c);
        });
        el.appendChild(head);

        this.jointLabels.forEach((label, i) => {
            const row = document.createElement('div');
            row.style.cssText =
                'display:grid;grid-template-columns:30px 48px 48px 48px 54px 48px 1fr;gap:6px;' +
                'align-items:center;padding:2px 0;';
            const cells = {};
            const mk = (key, align = 'right') => {
                const c = document.createElement('div');
                c.style.textAlign = align;
                row.appendChild(c);
                cells[key] = c;
                return c;
            };
            mk('name', 'left').textContent = `J${i + 1}`;
            mk('angle');
            mk('vel');
            mk('acc');
            mk('torque');
            mk('current');
            // utilization bar
            const barWrap = document.createElement('div');
            barWrap.style.cssText =
                'height:12px;background:rgba(255,255,255,0.08);border-radius:6px;overflow:hidden;position:relative;';
            const bar = document.createElement('div');
            bar.style.cssText = 'height:100%;width:0;border-radius:6px;transition:width .08s linear;';
            // i²t thermal underline: thin bar along the bottom = accumulated motor heat index
            // (0..100% = the drive's current-limiting threshold). Distinct from the load bar.
            const heat = document.createElement('div');
            heat.style.cssText =
                'position:absolute;left:0;bottom:0;height:3px;width:0;border-radius:2px;transition:width .15s linear;';
            const pct = document.createElement('span');
            pct.style.cssText =
                'position:absolute;right:5px;top:0;line-height:12px;font-size:10px;color:#fff;';
            barWrap.appendChild(bar);
            barWrap.appendChild(heat);
            barWrap.appendChild(pct);
            row.appendChild(barWrap);
            cells.bar = bar;
            cells.heat = heat;
            cells.barWrap = barWrap;
            cells.pct = pct;
            cells.title = label;
            row.title = label;

            el.appendChild(row);
            this.rows.push(cells);
        });

        this._buildSettings(el);

        parent.appendChild(el);
        this.el = el;
        makeDraggable(el, this._title, 'dynamics');
    }

    _buildSettings(container) {
        const wrap = document.createElement('div');
        wrap.style.cssText =
            'margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.1);' +
            'display:flex;align-items:center;gap:8px;font-size:11px;';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = this.settings.fixedDt;
        cb.style.cssText = 'accent-color:#3fb950;cursor:pointer;margin:0;';
        const lbl = document.createElement('label');
        lbl.textContent = 'Fixed Δt';
        lbl.style.cursor = 'pointer';
        lbl.prepend(cb);
        lbl.style.cssText = 'display:flex;align-items:center;gap:5px;cursor:pointer;';

        const num = document.createElement('input');
        num.type = 'number';
        num.min = '1';
        num.step = '0.5';
        num.value = String(this.settings.fixedDtMs);
        num.style.cssText =
            'width:52px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);' +
            'border-radius:4px;color:#e6edf3;padding:2px 4px;font:inherit;text-align:right;';
        const unit = document.createElement('span');
        unit.textContent = 'ms';
        unit.style.opacity = '.7';
        const hz = document.createElement('span');
        hz.style.cssText = 'opacity:.55;margin-left:auto;';

        const updHz = () => {
            const ms = parseFloat(num.value) || 0;
            hz.textContent = ms > 0 ? `${(1000 / ms).toFixed(1)} Hz` : '';
        };
        const emit = () => {
            this.settings = { fixedDt: cb.checked, fixedDtMs: parseFloat(num.value) || 62.5 };
            num.disabled = !cb.checked;
            num.style.opacity = cb.checked ? '1' : '.4';
            DynamicsDashboard._saveSettings(this.settings);
            updHz();
            this.onSettingsChange?.(this.settings);
        };

        cb.addEventListener('change', emit);
        num.addEventListener('change', emit);
        num.addEventListener('input', updHz);
        num.disabled = !cb.checked;
        num.style.opacity = cb.checked ? '1' : '.4';
        updHz();

        wrap.append(lbl, num, unit, hz);
        container.appendChild(wrap);

        // Motor-model toggle: ON = real-hardware (NE + friction + reflected inertia + current),
        // OFF = twin-accurate (rigid-body Newton-Euler torque only).
        const mwrap = document.createElement('div');
        mwrap.style.cssText = 'margin-top:6px;display:flex;align-items:center;gap:8px;font-size:11px;';
        const mcb = document.createElement('input');
        mcb.type = 'checkbox';
        mcb.checked = this._motorModel;
        mcb.style.cssText = 'accent-color:#3fb950;cursor:pointer;margin:0;';
        const mlbl = document.createElement('label');
        mlbl.textContent = 'Motor model (friction + inertia)';
        mlbl.prepend(mcb);
        mlbl.style.cssText = 'display:flex;align-items:center;gap:5px;cursor:pointer;';
        const mnote = document.createElement('span');
        mnote.style.cssText = 'opacity:.55;margin-left:auto;';
        const updNote = () => { mnote.textContent = mcb.checked ? 'real' : 'twin'; };
        mcb.addEventListener('change', () => {
            this._motorModel = mcb.checked;
            DynamicsDashboard._saveMotorModel(this._motorModel);
            updNote();
            this.onMotorModelChange?.(this._motorModel);
        });
        updNote();
        mwrap.append(mlbl, mnote);
        container.appendChild(mwrap);
    }

    /**
     * @param {Object} t
     * @param {number[]} t.angleDeg
     * @param {number[]} t.velocity    - rad/s
     * @param {number[]} t.acceleration- rad/s²
     * @param {number[]} t.torque      - N·m
     * @param {(number|null)[]} t.utilization - torque utilization, 0..1
     * @param {(number|null)[]} [t.current]     - motor q-axis current, A
     * @param {(number|null)[]} [t.currentUtil] - current utilization (vs peak current), 0..1
     * @param {(number|null)[]} [t.heat]        - i²t heat index, 0..250 (%)
     */
    render({ angleDeg, velocity, acceleration, torque, utilization, current, currentUtil, heat }) {
        for (let i = 0; i < this.rows.length; i++) {
            const r = this.rows[i];
            r.angle.textContent = (angleDeg?.[i] ?? 0).toFixed(1);
            r.vel.textContent = ((velocity?.[i] ?? 0) * RAD2DEG).toFixed(1);
            r.acc.textContent = ((acceleration?.[i] ?? 0) * RAD2DEG).toFixed(0);
            r.torque.textContent = (torque?.[i] ?? 0).toFixed(1);
            const iq = current?.[i];
            r.current.textContent = iq == null ? '—' : iq.toFixed(1);
            // The bar shows the binding constraint: torque (mechanical/gearbox) and current
            // (electrical/thermal) are different ceilings — whichever is higher is the limit.
            const ut = utilization?.[i];
            const uc = currentUtil?.[i];
            const u = ut == null && uc == null ? null : Math.max(ut ?? 0, uc ?? 0);
            const binds = uc != null && (ut == null || uc > ut) ? 'I' : 'τ';
            const uLabel = u == null ? '—' : (u > 1 ? `>100% ${binds}` : `${(u * 100).toFixed(0)}% ${binds}`);
            r.bar.style.width = u == null ? '0' : `${Math.min(100, u * 100).toFixed(0)}%`;
            r.bar.style.background = utilColor(u);
            r.pct.textContent = uLabel;
            // i²t thermal underline (heat is a %; 100 = limiting threshold).
            const h = heat?.[i];
            r.heat.style.width = h == null ? '0' : `${Math.min(100, h).toFixed(0)}%`;
            r.heat.style.background = heatColor(h);
            if (r.barWrap) {
                r.barWrap.title = h == null
                    ? r.title
                    : `${r.title} — load ${uLabel}, i²t heat ${h.toFixed(0)}%`;
            }
        }
    }

    dispose() {
        this.el?.remove();
    }
}
