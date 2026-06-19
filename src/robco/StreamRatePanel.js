/**
 * Stream Rate panel — measures the cadence of the live /robot WebSocket jointAngles stream.
 *
 * Live line: rolling estimate of the jointAngles push rate (Hz + period), plus the total
 * all-message rate for context. "Measure" runs a clean fixed-N capture (warm-up discarded,
 * visibility-gated) and freezes a detailed report: mean/median/trimmed period, jitter (std),
 * min/max/p95/p99, the on-change-vs-fixed-period regime, and a delta histogram.
 *
 * Draggable + minimizable, in the same style as the View / Render panels. Reads a
 * FrequencyMeter; does no measurement itself.
 */
import { makeDraggable } from './draggable.js';

const PANEL_CSS =
    'position:fixed;right:332px;top:16px;z-index:3000;width:288px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;' +
    'color:#e6edf3;background:rgba(13,17,23,0.9);border:1px solid rgba(255,255,255,0.12);border-radius:10px;' +
    'padding:10px 12px;backdrop-filter:blur(6px);box-shadow:0 6px 24px rgba(0,0,0,0.4);';
const BTN = 'font:600 11px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:6px 10px;cursor:pointer;';
const QUALITY_COLOR = { good: '#3fb950', fair: '#d29922', noisy: '#f85149', invalid: '#f85149' };

function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
}
function title(t) {
    return el('div', 'font-weight:600;letter-spacing:.04em;opacity:.85;margin:10px 0 5px;text-transform:uppercase;font-size:10px;', t);
}

export class StreamRatePanel {
    static ensure(meter) {
        if (window._robcoStreamPanel) {
            window._robcoStreamPanel.setMeter(meter);
            return window._robcoStreamPanel;
        }
        const p = new StreamRatePanel(meter);
        window._robcoStreamPanel = p;
        return p;
    }

    constructor(meter) {
        this.meter = meter;
        this._build();
        this._poll = setInterval(() => this._refresh(), 400);
    }

    setMeter(m) { this.meter = m; }

    _build() {
        const root = el('div', PANEL_CSS);
        const header = el('div', 'display:flex;align-items:center;justify-content:space-between;font-weight:600;color:#fff;');
        const t = el('span', null, 'Stream Rate  ⠿');
        const minBtn = el('button', 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#e6edf3;border-radius:6px;cursor:pointer;width:22px;height:20px;', '▾');
        header.append(t, minBtn);
        root.append(header);

        const body = el('div', 'margin-top:6px;');
        root.append(body);

        // Live readout
        this._big = el('div', 'font:700 26px ui-monospace,monospace;color:#fff;margin-top:4px;', '— Hz');
        this._sub = el('div', 'font-size:11px;color:#9da7b3;', 'waiting for jointAngles…');
        this._total = el('div', 'font-size:11px;color:#6e7681;margin-top:1px;', '');
        body.append(this._big, this._sub, this._total);

        // Measure
        body.append(title('Measure'));
        const row = el('div', 'display:flex;gap:6px;align-items:center;');
        this._measureBtn = el('button', BTN, `Measure (${this.meter?.sampleSize ?? 300})`);
        this._measureBtn.addEventListener('click', () => this._measure());
        const resetBtn = el('button', BTN, 'Reset');
        resetBtn.addEventListener('click', () => {
            this.meter?.cancelCapture();
            if (this.meter) this.meter._frozen = null;
            this._report.innerHTML = '';
            this._progress.textContent = '';
        });
        row.append(this._measureBtn, resetBtn);
        body.append(row);
        this._progress = el('div', 'font-size:11px;color:#9da7b3;margin-top:4px;min-height:14px;');
        body.append(this._progress);
        body.append(el('div', 'font-size:10px;color:#6e7681;margin-top:2px;', 'Move the robot (jog / run a flow) while measuring — the stream may only update on change.'));

        // Frozen report
        this._report = el('div', 'margin-top:8px;');
        body.append(this._report);

        minBtn.addEventListener('click', () => {
            const hidden = body.style.display === 'none';
            body.style.display = hidden ? 'block' : 'none';
            minBtn.textContent = hidden ? '▾' : '▸';
        });

        document.body.appendChild(root);
        this.root = root;
        this.body = body;
        makeDraggable(root, t, 'stream');
    }

    _measure() {
        if (!this.meter) return;
        this.meter.startCapture();
        this._report.innerHTML = '';
        this._measureBtn.disabled = true;
        this._measureBtn.style.opacity = '0.5';
    }

    _refresh() {
        if (!this.meter) return;

        // Live rolling readout
        const s = this.meter.snapshot();
        if (s.ready) {
            this._big.textContent = `${s.hz.toFixed(1)} Hz`;
            this._sub.textContent =
                `${s.meanMs.toFixed(1)} ms · ±${s.stdMs.toFixed(1)} ms · ${s.regime.split(' (')[0]} · N=${s.n}`;
            this._sub.style.color = s.invalid ? '#f85149' : '#9da7b3';
            if (s.invalid) this._sub.textContent += '  ⚠ tab was hidden — Measure for a clean read';
        } else {
            this._big.textContent = '— Hz';
            this._sub.textContent = 'waiting for jointAngles…';
        }
        const th = this.meter.totalHz();
        this._total.textContent = th > 0 ? `all message types: ${th.toFixed(1)} Hz` : '';

        // Capture progress
        const prog = this.meter.captureProgress();
        if (prog) {
            this._progress.textContent = `measuring… ${prog.count}/${prog.target}`;
        }

        // Frozen report
        const frozen = this.meter.frozen();
        if (frozen && this._shownReport !== frozen) {
            this._shownReport = frozen;
            this._measureBtn.disabled = false;
            this._measureBtn.style.opacity = '1';
            this._progress.textContent = 'done.';
            this._renderReport(frozen);
        }
    }

    _renderReport(r) {
        this._report.innerHTML = '';
        if (!r.ready) {
            this._report.append(el('div', 'color:#f85149;font-size:11px;', 'not enough samples'));
            return;
        }
        const color = QUALITY_COLOR[r.quality] || '#9da7b3';

        // headline
        const head = el('div', 'display:flex;align-items:baseline;gap:8px;');
        head.append(el('span', 'font:700 22px ui-monospace,monospace;color:#fff;', `${r.hz.toFixed(2)} Hz`));
        head.append(el('span', 'font-size:11px;color:#9da7b3;', `period ${r.meanMs.toFixed(2)} ms`));
        const badge = el('span', `margin-left:auto;font-size:10px;font-weight:600;color:${color};border:1px solid ${color};border-radius:5px;padding:1px 6px;`, r.quality.toUpperCase());
        head.append(badge);
        this._report.append(head);

        // stat grid
        const rows = [
            ['median', `${r.medianMs.toFixed(2)} ms`],
            ['trimmed mean (10%)', `${r.trimmedMeanMs.toFixed(2)} ms`],
            ['jitter (std)', `${r.stdMs.toFixed(2)} ms  (${(r.jitterPct * 100).toFixed(0)}%)`],
            ['min / max', `${r.minMs.toFixed(1)} / ${r.maxMs.toFixed(1)} ms`],
            ['p95 / p99', `${r.p95Ms.toFixed(1)} / ${r.p99Ms.toFixed(1)} ms`],
            ['samples', `${r.n}  (${r.windowSeconds.toFixed(1)} s)`],
            ['regime', r.regime],
            ['changed/arrival', `${(r.changedRatio * 100).toFixed(0)}%`],
            ['within ±20% of mean', `${(r.centralFraction * 100).toFixed(0)}%`],
        ];
        if (r.lagN > 0) {
            rows.push(['dispatch lag mean/p95', `${r.lagMeanMs.toFixed(1)} / ${r.lagP95Ms.toFixed(1)} ms`]);
        }
        const grid = el('div', 'display:grid;grid-template-columns:auto 1fr;gap:1px 10px;margin-top:6px;font-size:11px;');
        for (const [k, v] of rows) {
            grid.append(el('span', 'color:#6e7681;', k));
            grid.append(el('span', 'color:#e6edf3;text-align:right;', v));
        }
        this._report.append(grid);

        // histogram
        this._report.append(title('Δ histogram'));
        const h = r.histogram;
        const max = Math.max(1, ...h.counts);
        const wrap = el('div', 'display:flex;align-items:flex-end;gap:1px;height:42px;');
        h.counts.forEach((c, i) => {
            const isOverflow = i === h.bins;
            const binLo = h.lo + (i / h.bins) * (h.hi - h.lo);
            const binHi = h.lo + ((i + 1) / h.bins) * (h.hi - h.lo);
            const bar = el('div',
                `flex:1;height:${Math.round((c / max) * 40) + 1}px;` +
                `background:${isOverflow ? '#f85149' : '#2f81f7'};border-radius:1px 1px 0 0;`);
            bar.title = isOverflow ? `> ${h.hi.toFixed(1)} ms (overflow): ${c}` : `${binLo.toFixed(1)}–${binHi.toFixed(1)} ms: ${c}`;
            wrap.append(bar);
        });
        this._report.append(wrap);
        const axis = el('div', 'display:flex;justify-content:space-between;font-size:9px;color:#6e7681;margin-top:1px;');
        axis.append(el('span', null, `${h.lo.toFixed(0)} ms`), el('span', null, `${h.hi.toFixed(0)} ms`), el('span', null, '>p99'));
        this._report.append(axis);

        // shape diagnosis (unimodal vs bimodal/bursty + likely cause)
        const shapeColor = r.shape === 'unimodal' ? '#3fb950' : '#d29922';
        const diag = el('div',
            `margin-top:8px;font-size:10px;color:#cdd6e0;border-left:2px solid ${shapeColor};padding-left:6px;`);
        diag.append(el('span', `font-weight:600;color:${shapeColor};`, `${r.shape}: `));
        diag.append(document.createTextNode(r.diagnosis));
        this._report.append(diag);

        // instrument note
        const res = r.crossOriginIsolated ? '~5–100 µs (COOP/COEP on)' : '~100 µs–1 ms (timer clamped)';
        this._report.append(el('div', 'font-size:9px;color:#6e7681;margin-top:6px;',
            `timer resolution ${res}. Hz = 1000/mean(Δ); jitter shown is std(Δ), which does not bias the mean.`));
    }
}
