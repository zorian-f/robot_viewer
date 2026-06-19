/**
 * Minimal RobFlow `/robot` WebSocket client.
 *
 * Connects to the (cloud or local) robot WS, parses the `{type, data}` message stream,
 * and dispatches per-type to registered handlers. Auto-reconnects with backoff.
 *
 * The cloud WS is authorized by the SID in the URL path (no auth header needed).
 * Message types of interest: robotModuleIds, jointAngles, baseShift, tool, pose,
 * fixedModuleIds, operationMode, robotState, safetyState. (Positions only — no
 * velocity/torque; see RobotVisualizer_Notes.)
 */
export class RobFlowSocket {
    /**
     * @param {string} wsUrl
     * @param {Object} [opts]
     * @param {boolean} [opts.reconnect=true]
     * @param {number} [opts.maxBackoffMs=15000]
     */
    constructor(wsUrl, opts = {}) {
        this.wsUrl = wsUrl;
        this.reconnect = opts.reconnect !== false;
        this.maxBackoffMs = opts.maxBackoffMs ?? 15000;

        this.ws = null;
        this._handlers = new Map(); // type -> fn(data, fullMessage)
        this._anyHandler = null;
        this._taps = []; // fn(type, data, tsMs) — multiple non-exclusive observers
        this._statusHandler = null;
        this._stopped = false;
        this._attempt = 0;
        this._reconnectTimer = null;
    }

    /** Register a handler for a specific message type. Returns `this` for chaining. */
    on(type, fn) {
        this._handlers.set(type, fn);
        return this;
    }

    /** Handler called for every message: fn(type, data). Single-owner (last wins). */
    onAny(fn) {
        this._anyHandler = fn;
        return this;
    }

    /**
     * Register a passive observer called for every frame with a high-resolution arrival
     * timestamp: fn(type, data, tsMs). Multiple taps are allowed (unlike onAny) and they
     * never interfere with the per-type handlers — used for the stream-rate meter.
     * @returns {() => void} unsubscribe
     */
    addTap(fn) {
        this._taps.push(fn);
        return () => {
            const i = this._taps.indexOf(fn);
            if (i >= 0) this._taps.splice(i, 1);
        };
    }

    /** Handler called on connection lifecycle: fn('open'|'close'|'error', detail). */
    onStatus(fn) {
        this._statusHandler = fn;
        return this;
    }

    connect() {
        this._stopped = false;
        this._open();
        return this;
    }

    _open() {
        const ws = new WebSocket(this.wsUrl);
        this.ws = ws;

        ws.onopen = () => {
            this._attempt = 0;
            this._statusHandler?.('open', this.wsUrl);
        };
        ws.onmessage = (event) => {
            // recvNow = when our handler actually ran; ts = when the event was created
            // (event.timeStamp, a DOMHighResTimeStamp on the same timeline as performance.now()
            // but closer to wire arrival). recvNow - ts is the main-thread dispatch lag, which
            // reveals whether bursty deltas are local coalescing vs upstream batching.
            const recvNow = performance.now();
            const ts = event.timeStamp > 0 ? event.timeStamp : recvNow;
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch {
                return;
            }
            if (!msg || typeof msg.type !== 'string') return;
            this._anyHandler?.(msg.type, msg.data, ts);
            for (const tap of this._taps) {
                try {
                    tap(msg.type, msg.data, ts, recvNow);
                } catch {
                    /* a tap must never break dispatch */
                }
            }
            const fn = this._handlers.get(msg.type);
            if (fn) fn(msg.data, msg);
        };
        ws.onerror = (e) => this._statusHandler?.('error', e);
        ws.onclose = (e) => {
            this._statusHandler?.('close', e);
            if (!this._stopped && this.reconnect) this._scheduleReconnect();
        };
    }

    _scheduleReconnect() {
        const backoff = Math.min(this.maxBackoffMs, 500 * 2 ** this._attempt);
        this._attempt += 1;
        this._reconnectTimer = setTimeout(() => this._open(), backoff);
    }

    /** Send a message object (rarely needed; the /robot stream is read-mostly). */
    send(obj) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(obj));
        }
    }

    close() {
        this._stopped = true;
        if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
        try {
            this.ws?.close();
        } catch {
            /* ignore */
        }
    }
}
