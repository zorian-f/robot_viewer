/**
 * Cycle-time meter for a looping RobFlow flow.
 *
 * The pushed flow logs a marker (CYCLE_MARKER) via a messageLog node at the end of its loop
 * body, so every full pass emits one server-timestamped entry into the robot's message log.
 * That log streams over the `/robot` WebSocket as `{type:'messages', data:{messages:[…]}}` — a
 * cumulative list. We watch it, pick out our marker entries, and the gap between consecutive
 * entries' server timestamps is one full cycle.
 *
 * Robustness:
 *  - dedupe by message `uuid` (bounded) so re-sent log snapshots don't double-count;
 *  - timestamps are monotonic — an out-of-order or replayed entry can never move time backwards
 *    or count a stale cycle (so clearing the dedupe set mid-run is always safe);
 *  - prefer the server `date`; fall back to client arrival time only if it's missing.
 */
const SEEN_CAP = 5000;

export class CycleTimer {
    /**
     * @param {Object} [opts]
     * @param {string} [opts.marker] - message text to match (lowercased substring).
     * @param {number} [opts.window=20] - rolling window size for the average.
     */
    constructor({ marker = 'orrerium-cycle', window = 20 } = {}) {
        this.marker = String(marker).toLowerCase();
        this.windowN = window;
        this.onUpdate = null; // fn(stats)
        this._seen = new Set();
        this._lastMs = null;
        this._deltas = [];
        this.count = 0;
        this.lastCycleMs = null;
    }

    /** Clear timing state (call when (re)starting a flow). Keeps the dedupe set so the
     *  previous run's already-seen markers can't be recounted across the restart gap. */
    reset() {
        this._lastMs = null;
        this._deltas = [];
        this.count = 0;
        this.lastCycleMs = null;
        this.onUpdate?.(this.stats());
    }

    /** @returns {{lastMs:number|null, avgMs:number|null, count:number, samples:number}} */
    stats() {
        const avgMs = this._deltas.length
            ? this._deltas.reduce((a, b) => a + b, 0) / this._deltas.length
            : null;
        return { lastMs: this.lastCycleMs, avgMs, count: this.count, samples: this._deltas.length };
    }

    /**
     * Feed a `messages` WS payload (`{messages:[…]}` or a bare array).
     * @param {Object|Array} data
     * @param {number} [arrivalMs] - client receive time (performance.now()), used only if an
     *        entry has no server timestamp.
     */
    ingest(data, arrivalMs) {
        const list = Array.isArray(data?.messages) ? data.messages
            : Array.isArray(data) ? data : null;
        if (!list) return;

        const fresh = [];
        for (const m of list) {
            if (!m || !m.uuid || this._seen.has(m.uuid)) continue;
            if (!String(m.message ?? '').toLowerCase().includes(this.marker)) continue;
            this._seen.add(m.uuid);
            fresh.push(m);
        }
        if (!fresh.length) return;

        // Sort by timestamp so deltas are correct even when the snapshot isn't ordered.
        fresh.sort((a, b) => this._ts(a, arrivalMs) - this._ts(b, arrivalMs));
        let changed = false;
        for (const m of fresh) {
            const t = this._ts(m, arrivalMs);
            if (this._lastMs != null) {
                if (t <= this._lastMs) continue; // stale / replayed — ignore
                this.lastCycleMs = t - this._lastMs;
                this._deltas.push(this.lastCycleMs);
                if (this._deltas.length > this.windowN) this._deltas.shift();
                this.count += 1;
                changed = true;
            }
            this._lastMs = t; // first marker only baselines (no cycle yet)
        }

        if (this._seen.size > SEEN_CAP) this._seen.clear(); // monotonic gate keeps this safe
        if (changed) this.onUpdate?.(this.stats());
    }

    /** Parse a message's server timestamp to epoch-ms; fall back to client arrival time. */
    _ts(m, arrivalMs) {
        const d = m.date ?? m.timestamp ?? m.time;
        if (typeof d === 'number') return d > 1e12 ? d : d * 1000; // epoch ms vs seconds
        if (typeof d === 'string') {
            const p = Date.parse(d);
            if (!Number.isNaN(p)) return p;
        }
        return arrivalMs ?? 0;
    }
}
