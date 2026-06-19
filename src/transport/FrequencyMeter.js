/**
 * FrequencyMeter — estimate the push cadence of a WebSocket message stream by
 * timestamping arrivals and averaging inter-arrival PERIODS.
 *
 * Why this is sound (and the traps it avoids):
 *  - Average the PERIOD (Δ) and invert once: Hz = 1000 / mean(Δ_ms). Do NOT average
 *    instantaneous 1000/Δ — 1/x is convex, so by Jensen mean(1/Δ) > 1/mean(Δ), which
 *    biases the reported frequency HIGH. mean(Δ) telescopes to (t_last−t_first)/(N−1),
 *    so roughly zero-mean network/event-loop jitter on interior samples cancels and the
 *    estimator is unbiased (improves ~1/√N).
 *  - Jitter inflates std(Δ) but NOT mean(Δ): std is the QUALITY metric, mean is ACCURACY.
 *  - Timestamp in the WS onmessage path (never in requestAnimationFrame, which would
 *    measure the ~60 Hz display refresh instead of the push rate).
 *  - Discard warm-up samples (connection ramp / JIT / buffered-backlog flush).
 *  - Gate on tab visibility: a hidden/backgrounded tab is throttled toward ~1 Hz and
 *    coalesces messages, which would yield a false reading.
 *  - Detect on-change vs fixed-period delivery via a value-changed ratio, so a stationary
 *    robot on an on-change stream doesn't report a meaningless rate. Measure while moving.
 *
 * Pure logic + a tab-visibility listener; no rendering. The panel polls snapshot().
 */

const EPS_DEG = 1e-3; // joint angles are degrees, quantised to ~0.01°

export class FrequencyMeter {
    /**
     * @param {Object} [opts]
     * @param {string|null} [opts.type='jointAngles'] - message type to measure; null = any type.
     * @param {number} [opts.warmup=20]   - leading deltas to discard after a (re)start.
     * @param {number} [opts.sampleSize=300] - capture target; also the rolling-window capacity.
     * @param {number} [opts.epsilon=1e-3] - per-element threshold for "value changed".
     */
    constructor(opts = {}) {
        this.type = opts.type === undefined ? 'jointAngles' : opts.type;
        this.warmup = opts.warmup ?? 20;
        this.sampleSize = opts.sampleSize ?? 300;
        this.capacity = Math.max(opts.capacity ?? this.sampleSize, this.sampleSize);
        this.epsilon = opts.epsilon ?? EPS_DEG;

        this._totalDeltas = []; // inter-arrival of ANY message type (rolling), for a context rate
        this._totalCap = 120;
        this._totalLastTs = null;

        this._frozen = null;     // last completed capture report
        this._capture = null;    // { target, count } while capturing
        this.onCapture = null;   // optional callback(report)

        this._reset();

        // Tab-visibility contamination guard.
        this._onVisibility = () => {
            if (typeof document !== 'undefined' && document.hidden) {
                this._windowInvalid = true;
                this.breakGap();
            }
        };
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this._onVisibility);
        }
    }

    _reset() {
        this._lastTs = null;
        this._lastVec = null;
        this._deltas = [];
        this._changed = [];
        this._warmupLeft = this.warmup;
        this._windowInvalid = false;
        this._arrivals = 0;
    }

    /** Drop the running anchor so a connection/visibility gap isn't recorded as one huge Δ. */
    breakGap() {
        this._lastTs = null;
        this._lastVec = null;
        this._totalLastTs = null;
    }

    /** Begin a clean fixed-N capture: clears the window, discards warm-up, collects `n` deltas. */
    startCapture(n = this.sampleSize) {
        this._reset();
        this._frozen = null;
        this._capture = { target: n, count: 0 };
    }

    cancelCapture() {
        this._capture = null;
    }

    captureProgress() {
        return this._capture ? { count: this._capture.count, target: this._capture.target } : null;
    }

    frozen() {
        return this._frozen;
    }

    dispose() {
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this._onVisibility);
        }
    }

    /**
     * Record one arrival. Call from the WS onmessage path.
     * @param {string} type
     * @param {*} data   - payload (array of joint degrees for 'jointAngles').
     * @param {number} tsMs - high-res arrival timestamp (event.timeStamp || performance.now()).
     */
    tick(type, data, tsMs) {
        if (typeof tsMs !== 'number') tsMs = (typeof performance !== 'undefined' ? performance.now() : 0);

        // Context rate across every message type (rolling).
        if (this._totalLastTs != null) {
            const dt = tsMs - this._totalLastTs;
            if (dt > 0) {
                this._totalDeltas.push(dt);
                if (this._totalDeltas.length > this._totalCap) this._totalDeltas.shift();
            }
        }
        this._totalLastTs = tsMs;

        if (this.type && type !== this.type) return;
        if (typeof document !== 'undefined' && document.hidden) {
            this._windowInvalid = true;
            this.breakGap();
            return;
        }

        this._arrivals += 1;

        // on-change vs fixed-period: did the joint vector actually move since last frame?
        let changed = false;
        if (Array.isArray(data)) {
            if (Array.isArray(this._lastVec) && this._lastVec.length === data.length) {
                for (let i = 0; i < data.length; i++) {
                    if (Math.abs(data[i] - this._lastVec[i]) > this.epsilon) {
                        changed = true;
                        break;
                    }
                }
            }
            this._lastVec = data.slice();
        }

        if (this._lastTs != null) {
            const delta = tsMs - this._lastTs;
            if (delta > 0) {
                if (this._warmupLeft > 0) {
                    this._warmupLeft -= 1;
                } else {
                    this._deltas.push(delta);
                    this._changed.push(changed);
                    if (this._deltas.length > this.capacity) {
                        this._deltas.shift();
                        this._changed.shift();
                    }
                    if (this._capture) {
                        this._capture.count += 1;
                        if (this._capture.count >= this._capture.target) {
                            this._frozen = this.snapshot();
                            this._capture = null;
                            try {
                                this.onCapture?.(this._frozen);
                            } catch {
                                /* ignore */
                            }
                        }
                    }
                }
            }
        }
        this._lastTs = tsMs;
    }

    /** Rough rate across all message types (rolling), for context next to the typed rate. */
    totalHz() {
        const d = this._totalDeltas;
        if (d.length < 2) return 0;
        const mean = d.reduce((a, b) => a + b, 0) / d.length;
        return mean > 0 ? 1000 / mean : 0;
    }

    /** Compute statistics over the current rolling window (or capture). */
    snapshot() {
        const deltas = this._deltas;
        const n = deltas.length;
        const base = {
            ready: n >= 2,
            n,
            invalid: this._windowInvalid,
            crossOriginIsolated:
                typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false,
        };
        if (n < 2) return base;

        const sum = deltas.reduce((a, b) => a + b, 0);
        const mean = sum / n;
        const sorted = [...deltas].sort((a, b) => a - b);
        const at = (p) => sorted[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
        const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
        const variance = deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
        const std = Math.sqrt(variance);

        const k = Math.floor(n * 0.1);
        const trimmed = sorted.slice(k, n - k);
        const trimmedMean = trimmed.length
            ? trimmed.reduce((a, b) => a + b, 0) / trimmed.length
            : mean;

        const changedCount = this._changed.filter(Boolean).length;
        const changedRatio = this._changed.length ? changedCount / this._changed.length : 0;
        let regime;
        if (changedRatio < 0.1) regime = 'fixed-period (values static — move robot to confirm)';
        else if (changedRatio > 0.6) regime = 'tracking motion';
        else regime = 'mixed';

        const jitterPct = mean > 0 ? std / mean : 0;
        let quality;
        if (this._windowInvalid) quality = 'invalid';
        else if (jitterPct < 0.1 && Math.abs(median - mean) / mean < 0.05) quality = 'good';
        else if (jitterPct < 0.3) quality = 'fair';
        else quality = 'noisy';

        // Histogram over [min, p99] with a final overflow bin (so one GC pause can't stretch it).
        const lo = sorted[0];
        const p99 = at(0.99);
        const bins = 16;
        const span = p99 - lo || 1;
        const counts = new Array(bins + 1).fill(0); // index `bins` = overflow ( > p99 )
        for (const d of deltas) {
            if (d > p99) {
                counts[bins] += 1;
                continue;
            }
            let idx = Math.floor(((d - lo) / span) * bins);
            if (idx >= bins) idx = bins - 1;
            if (idx < 0) idx = 0;
            counts[idx] += 1;
        }

        return {
            ...base,
            hz: mean > 0 ? 1000 / mean : 0,
            meanMs: mean,
            medianMs: median,
            trimmedMeanMs: trimmedMean,
            stdMs: std,
            minMs: sorted[0],
            maxMs: sorted[n - 1],
            p95Ms: at(0.95),
            p99Ms: p99,
            jitterPct,
            changedRatio,
            regime,
            quality,
            windowSeconds: sum / 1000,
            histogram: { lo, hi: p99, bins, counts },
        };
    }
}
