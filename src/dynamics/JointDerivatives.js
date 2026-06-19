/**
 * Estimate joint velocity and acceleration from a position-only stream.
 *
 * RobFlow streams joint *positions* only (no velocity/torque), at ~16 Hz and quantised to
 * 0.01°. Plain finite differences of that are very noisy in acceleration, so we fit a
 * quadratic q(t) ≈ a + b·τ + c·τ² (least squares) over a short sliding window per joint,
 * with τ = t − t_latest. At τ = 0:  position = a,  velocity = b,  acceleration = 2c.
 *
 * Units are whatever you feed in (use radians + seconds for dynamics). Feed timestamps in
 * milliseconds; they are converted to seconds internally.
 */
export class JointDerivatives {
    /**
     * @param {Object} [opts]
     * @param {number} [opts.windowSize=7] - samples used for each fit (>=3 enables accel).
     * @param {number} [opts.minDtMs=1] - ignore samples closer than this in time.
     */
    constructor({ windowSize = 7, minDtMs = 1 } = {}) {
        this.windowSize = Math.max(3, windowSize);
        this.minDtMs = minDtMs;
        this.reset();
    }

    reset() {
        this._t = []; // ms timestamps
        this._q = []; // number[][] positions per sample
        this._n = 0; // joint count
    }

    /**
     * Push a new sample and return smoothed position/velocity/acceleration.
     * @param {number[]} positions - joint positions (radians recommended).
     * @param {number} [tMs=performance.now()] - sample timestamp in ms.
     * @returns {{position:number[], velocity:number[], acceleration:number[]}}
     */
    update(positions, tMs = (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
        if (this._n !== positions.length) {
            // joint count changed (robot rebuilt) -> restart the window
            this.reset();
            this._n = positions.length;
        }
        const last = this._t[this._t.length - 1];
        if (last !== undefined && tMs - last < this.minDtMs) {
            // too close in time; just refresh the latest sample
            this._q[this._q.length - 1] = positions.slice();
            this._t[this._t.length - 1] = tMs;
        } else {
            this._t.push(tMs);
            this._q.push(positions.slice());
        }
        while (this._t.length > this.windowSize) {
            this._t.shift();
            this._q.shift();
        }
        return this._fit(positions);
    }

    /** @private */
    _fit(latest) {
        const n = this._n;
        const m = this._t.length;
        const position = latest.slice();
        const velocity = new Array(n).fill(0);
        const acceleration = new Array(n).fill(0);
        if (m < 2) return { position, velocity, acceleration };

        const tLast = this._t[m - 1];
        const tau = this._t.map((t) => (t - tLast) / 1000); // seconds, <= 0

        if (m === 2) {
            // first-order only
            const dt = tau[1] - tau[0];
            if (dt !== 0) {
                for (let j = 0; j < n; j++) {
                    velocity[j] = (this._q[1][j] - this._q[0][j]) / dt;
                }
            }
            return { position, velocity, acceleration };
        }

        // Quadratic least squares: normal-equation sums (shared across joints).
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
        for (let i = 0; i < m; i++) {
            const t = tau[i], t2 = t * t;
            s0 += 1; s1 += t; s2 += t2; s3 += t2 * t; s4 += t2 * t2;
        }
        for (let j = 0; j < n; j++) {
            let b0 = 0, b1 = 0, b2 = 0;
            for (let i = 0; i < m; i++) {
                const q = this._q[i][j], t = tau[i];
                b0 += q; b1 += q * t; b2 += q * t * t;
            }
            const coef = solve3(
                [s0, s1, s2, s1, s2, s3, s2, s3, s4],
                [b0, b1, b2],
            );
            if (coef) {
                position[j] = coef[0]; // a (at tau=0)
                velocity[j] = coef[1]; // b
                acceleration[j] = 2 * coef[2]; // 2c
            }
        }
        return { position, velocity, acceleration };
    }
}

/**
 * Solve a 3x3 linear system A x = b (A row-major length 9) via Cramer's rule.
 * @returns {number[]|null} x, or null if singular.
 */
function solve3(A, b) {
    const [a, c, d, e, f, g, h, i, k] = A;
    const det =
        a * (f * k - g * i) - c * (e * k - g * h) + d * (e * i - f * h);
    if (Math.abs(det) < 1e-12) return null;
    const dx =
        b[0] * (f * k - g * i) - c * (b[1] * k - g * b[2]) + d * (b[1] * i - f * b[2]);
    const dy =
        a * (b[1] * k - g * b[2]) - b[0] * (e * k - g * h) + d * (e * b[2] - b[1] * h);
    const dz =
        a * (f * b[2] - b[1] * i) - c * (e * b[2] - b[1] * h) + b[0] * (e * i - f * h);
    return [dx / det, dy / det, dz / det];
}
