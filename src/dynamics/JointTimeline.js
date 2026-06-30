/**
 * JointTimeline — a collapsible "Graphs" section for the Joint Dynamics panel.
 *
 * One small Canvas-2D chart per joint plotting three series over time, all on a shared percent
 * axis so the 100% limit line is meaningful for each:
 *   • mech  — torque (mechanical) utilization, % of gearbox peak
 *   • curr  — motor current utilization, % of the speed-aware drive limit
 *   • heat  — i²t motor-overload index, % (100 = limiting threshold, up to 250)
 *
 * Per-joint peak-hold maxima are tracked (surviving the rolling window) and drawn as dashed
 * lines + shown numerically in each chart's legend. A "Reset heat" button clears the heat history
 * + heat peak (util history is untouched) and fires onResetHeat() so the i²t model resets too.
 *
 * Fed one sample per DynamicsDashboard.render(); capture is cheap and always on, but the canvases
 * are only redrawn while the section is expanded.
 */
const WINDOW_S = 60;          // rolling time window kept in the buffers
const COLORS = { mech: '#3fb950', curr: '#2f81f7', heat: '#f0883e' };
const STORE_KEY = 'robco-dyn-graphs';

const el = (tag, css, text) => {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
};

/** Round up to a "nice" axis maximum (50, 100, 150, …) and a matching gridline step. */
function niceAxis(maxVal) {
    const top = Math.max(100, maxVal);
    const yMax = Math.ceil(top / 50) * 50;
    const step = yMax <= 150 ? 50 : (yMax <= 300 ? 50 : 100);
    return { yMax, step };
}

export class JointTimeline {
    /**
     * @param {string[]} jointLabels - one per joint (base->flange).
     * @param {{onResetHeat?: () => void}} [opts]
     */
    constructor(jointLabels, { onResetHeat = null } = {}) {
        this.labels = jointLabels;
        this.onResetHeat = onResetHeat;
        this.n = jointLabels.length;
        this.expanded = JointTimeline._loadExpanded();
        this.series = jointLabels.map(() => ({
            t: [], mech: [], curr: [], heat: [], peak: { mech: 0, curr: 0, heat: 0 },
        }));
        this.canvases = [];
        this._build();
    }

    get element() { return this.root; }

    static _loadExpanded() {
        try { return JSON.parse(localStorage.getItem(STORE_KEY)) === true; } catch { return false; }
    }
    static _saveExpanded(on) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(!!on)); } catch { /* ignore */ }
    }

    _build() {
        const root = el('div', 'margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.1);');

        const header = el('div', 'display:flex;align-items:center;gap:8px;font-size:11px;');
        this._toggle = el('button',
            'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#e6edf3;' +
            'border-radius:6px;padding:3px 8px;cursor:pointer;font:inherit;font-weight:600;');
        this._toggle.textContent = this.expanded ? 'Graphs ▾' : 'Graphs ▸';
        this._toggle.addEventListener('click', () => this.setExpanded(!this.expanded));

        // Compact shared legend so each chart's header can stay terse.
        const legend = el('div', 'display:flex;gap:10px;align-items:center;margin-left:auto;opacity:.85;');
        for (const [k, name] of [['mech', 'mech'], ['curr', 'curr'], ['heat', 'heat']]) {
            const item = el('span', 'display:flex;align-items:center;gap:4px;');
            item.append(el('span', `width:9px;height:3px;border-radius:2px;background:${COLORS[k]};display:inline-block;`),
                el('span', null, name));
            legend.append(item);
        }
        const resetBtn = el('button',
            'background:rgba(255,255,255,0.06);border:1px solid rgba(248,81,73,0.5);color:#e6edf3;' +
            'border-radius:6px;padding:3px 8px;cursor:pointer;font:inherit;');
        resetBtn.textContent = 'Reset heat';
        resetBtn.title = 'Clear the i²t heat accumulation + its graph history';
        resetBtn.addEventListener('click', () => { this.clearHeat(); this.onResetHeat?.(); });

        header.append(this._toggle, legend, resetBtn);
        root.append(header);

        this._charts = el('div', 'margin-top:8px;max-height:340px;overflow-y:auto;' +
            (this.expanded ? '' : 'display:none;'));
        this.labels.forEach((label, i) => {
            const c = document.createElement('canvas');
            c.style.cssText = 'width:100%;height:72px;display:block;margin:6px 0;';
            c.title = label;
            this._charts.append(c);
            this.canvases.push(c);
        });
        root.append(this._charts);

        this.root = root;
    }

    setExpanded(on) {
        this.expanded = !!on;
        this._charts.style.display = this.expanded ? 'block' : 'none';
        this._toggle.textContent = this.expanded ? 'Graphs ▾' : 'Graphs ▸';
        JointTimeline._saveExpanded(this.expanded);
        if (this.expanded) this._drawAll();
    }

    /**
     * Append one sample. `mech`/`curr` are 0..1 fractions (stored as %), `heat` is already a %.
     * @param {{mech:(number|null)[], curr:(number|null)[], heat:(number|null)[]}} sample
     */
    push({ mech, curr, heat }) {
        const t = performance.now();
        const pct = (v) => (v == null ? null : v * 100);
        for (let i = 0; i < this.n; i++) {
            const s = this.series[i];
            const m = pct(mech?.[i]);
            const c = pct(curr?.[i]);
            const h = heat?.[i] == null ? null : heat[i];
            s.t.push(t); s.mech.push(m); s.curr.push(c); s.heat.push(h);
            if (m != null && m > s.peak.mech) s.peak.mech = m;
            if (c != null && c > s.peak.curr) s.peak.curr = c;
            if (h != null && h > s.peak.heat) s.peak.heat = h;
            // Drop samples older than the rolling window.
            const cutoff = t - WINDOW_S * 1000;
            let drop = 0;
            while (drop < s.t.length && s.t[drop] < cutoff) drop++;
            if (drop > 0) { s.t.splice(0, drop); s.mech.splice(0, drop); s.curr.splice(0, drop); s.heat.splice(0, drop); }
        }
        if (this.expanded) this._drawAll();
    }

    /** Reset only the heat: null out heat history + heat peak; leave mech/curr intact. */
    clearHeat() {
        for (const s of this.series) {
            s.heat = s.heat.map(() => null);
            s.peak.heat = 0;
        }
        if (this.expanded) this._drawAll();
    }

    _drawAll() {
        for (let i = 0; i < this.n; i++) this._drawChart(i);
    }

    _drawChart(i) {
        const canvas = this.canvases[i];
        const s = this.series[i];
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cssW = canvas.clientWidth || 410;
        const cssH = canvas.clientHeight || 72;
        if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
            canvas.width = Math.round(cssW * dpr);
            canvas.height = Math.round(cssH * dpr);
        }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        const padL = 30, padR = 6, padT = 14, padB = 13;
        const plotW = cssW - padL - padR;
        const plotH = cssH - padT - padB;
        const { yMax, step } = niceAxis(Math.max(s.peak.mech, s.peak.curr, s.peak.heat));
        const yToPx = (v) => padT + plotH * (1 - v / yMax);

        // Grid + Y labels (percent).
        ctx.font = '9px ui-monospace, monospace';
        ctx.textBaseline = 'middle';
        for (let v = 0; v <= yMax; v += step) {
            const y = yToPx(v);
            const isLimit = v === 100;
            ctx.strokeStyle = isLimit ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.10)';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(padL, y + 0.5); ctx.lineTo(cssW - padR, y + 0.5); ctx.stroke();
            ctx.fillStyle = isLimit ? 'rgba(230,237,243,0.8)' : 'rgba(157,167,179,0.7)';
            ctx.textAlign = 'right';
            ctx.fillText(`${v}`, padL - 4, y);
        }

        // X axis: time in seconds relative to now (0 at right).
        const now = s.t.length ? s.t[s.t.length - 1] : performance.now();
        const spanMs = WINDOW_S * 1000;
        const tToPx = (t) => padL + plotW * (1 - (now - t) / spanMs);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(157,167,179,0.7)';
        for (let sec = 0; sec <= WINDOW_S; sec += 20) {
            const x = padL + plotW * (1 - sec / WINDOW_S);
            ctx.fillText(sec === 0 ? '0s' : `-${sec}`, x, cssH - padB + 2);
        }

        // Series polylines (skip null gaps).
        const drawSeries = (key) => {
            ctx.strokeStyle = COLORS[key];
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            let pen = false;
            for (let k = 0; k < s.t.length; k++) {
                const v = s[key][k];
                if (v == null) { pen = false; continue; }
                const x = tToPx(s.t[k]);
                const y = yToPx(Math.min(v, yMax));
                if (!pen) { ctx.moveTo(x, y); pen = true; } else { ctx.lineTo(x, y); }
            }
            ctx.stroke();
            // Peak-hold dashed line.
            const peak = s.peak[key];
            if (peak > 0) {
                const y = yToPx(Math.min(peak, yMax));
                ctx.save();
                ctx.strokeStyle = COLORS[key];
                ctx.globalAlpha = 0.4;
                ctx.setLineDash([3, 3]);
                ctx.beginPath(); ctx.moveTo(padL, y + 0.5); ctx.lineTo(cssW - padR, y + 0.5); ctx.stroke();
                ctx.restore();
            }
        };
        drawSeries('mech');
        drawSeries('curr');
        drawSeries('heat');

        // Header: joint label + per-series peak (max) values, colour-coded.
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(230,237,243,0.9)';
        ctx.font = '600 10px ui-monospace, monospace';
        ctx.fillText(`J${i + 1}`, padL, 1);
        ctx.font = '10px ui-monospace, monospace';
        let x = padL + 22;
        const fmtPeak = (v) => `${Math.round(v)}%`;
        for (const [key, name] of [['mech', 'mech'], ['curr', 'curr'], ['heat', 'heat']]) {
            const text = `${name} ${fmtPeak(s.peak[key])}`;
            ctx.fillStyle = COLORS[key];
            ctx.fillText(text, x, 1);
            x += ctx.measureText(text).width + 10;
        }
    }

    dispose() {
        this.root?.remove();
        this.canvases = [];
        this.series = [];
    }
}
