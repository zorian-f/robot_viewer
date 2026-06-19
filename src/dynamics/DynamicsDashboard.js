/**
 * Floating per-joint dynamics panel: angle / velocity / acceleration / torque / utilization.
 *
 * Pure DOM (no framework), styled to sit over the three.js canvas. Built once for a given
 * joint count; `render()` just updates values + the utilization bars.
 */
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
        this._build(parent);
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
        title.textContent = 'Joint Dynamics';
        title.style.cssText = 'font-weight:600;margin-bottom:8px;letter-spacing:.04em;color:#fff;';
        el.appendChild(title);

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

        parent.appendChild(el);
        this.el = el;
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
