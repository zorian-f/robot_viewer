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
        this.settings = DynamicsDashboard._loadSettings();
        this._build(parent);
    }

    getSettings() {
        return { ...this.settings };
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
            padding: 10px 12px; min-width: 360px; backdrop-filter: blur(6px);
            box-shadow: 0 6px 24px rgba(0,0,0,0.4);`;

        const title = document.createElement('div');
        title.textContent = 'Joint Dynamics  ⠿';
        title.style.cssText = 'font-weight:600;margin-bottom:8px;letter-spacing:.04em;color:#fff;';
        el.appendChild(title);
        this._title = title;

        const head = document.createElement('div');
        head.style.cssText =
            'display:grid;grid-template-columns:34px 56px 56px 56px 64px 1fr;gap:6px;' +
            'opacity:.6;margin-bottom:4px;';
        ['', '° ', '°/s', '°/s²', 'N·m', 'util'].forEach((h) => {
            const c = document.createElement('div');
            c.textContent = h;
            c.style.textAlign = h === '' ? 'left' : 'right';
            head.appendChild(c);
        });
        el.appendChild(head);

        this.jointLabels.forEach((label, i) => {
            const row = document.createElement('div');
            row.style.cssText =
                'display:grid;grid-template-columns:34px 56px 56px 56px 64px 1fr;gap:6px;' +
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
            // utilization bar
            const barWrap = document.createElement('div');
            barWrap.style.cssText =
                'height:12px;background:rgba(255,255,255,0.08);border-radius:6px;overflow:hidden;position:relative;';
            const bar = document.createElement('div');
            bar.style.cssText = 'height:100%;width:0;border-radius:6px;transition:width .08s linear;';
            const pct = document.createElement('span');
            pct.style.cssText =
                'position:absolute;right:5px;top:0;line-height:12px;font-size:10px;color:#fff;';
            barWrap.appendChild(bar);
            barWrap.appendChild(pct);
            row.appendChild(barWrap);
            cells.bar = bar;
            cells.pct = pct;
            cells.title = label;
            row.title = label;

            el.appendChild(row);
            this.rows.push(cells);
        });

        this._buildSettings(el);

        parent.appendChild(el);
        this.el = el;
        makeDraggable(el, this._title);
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
    }

    /**
     * @param {Object} t
     * @param {number[]} t.angleDeg
     * @param {number[]} t.velocity    - rad/s
     * @param {number[]} t.acceleration- rad/s²
     * @param {number[]} t.torque      - N·m
     * @param {(number|null)[]} t.utilization - 0..1
     */
    render({ angleDeg, velocity, acceleration, torque, utilization }) {
        for (let i = 0; i < this.rows.length; i++) {
            const r = this.rows[i];
            r.angle.textContent = (angleDeg?.[i] ?? 0).toFixed(1);
            r.vel.textContent = ((velocity?.[i] ?? 0) * RAD2DEG).toFixed(1);
            r.acc.textContent = ((acceleration?.[i] ?? 0) * RAD2DEG).toFixed(0);
            r.torque.textContent = (torque?.[i] ?? 0).toFixed(1);
            const u = utilization?.[i];
            r.bar.style.width = u == null ? '0' : `${Math.min(100, u * 100).toFixed(0)}%`;
            r.bar.style.background = utilColor(u);
            r.pct.textContent = u == null ? '—' : `${(u * 100).toFixed(0)}%`;
        }
    }

    dispose() {
        this.el?.remove();
    }
}
