/**
 * Per-joint motor overload (i²t) heat index — a client-side replica of the servo drive's
 * i²t motor-overload protection, the same index the drive reports as joint "utilization" /
 * overload percent.
 *
 * The drive tracks the copper-loss excess over the continuous (rated) current and integrates
 * it into a heat index that reaches 100% after running at the maximum current for a
 * configured "peak time", then would limit current (and releases the limit at 50%). We
 * reproduce the index — not the current limiting — from our estimated motor current:
 *
 *   H[k] = clamp( H[k−1] + 100 · (i² − i_rated²) / ((i_max² − i_rated²) · t_peak) · Δt , 0, 250 )   [%]
 *
 * One formula covers both charge (i > i_rated) and recovery (i < i_rated). Inputs per joint:
 *   i_rated = motor.rated_current
 *   i_max   = motor.rated_current · peak_current‰/1000
 *   t_peak  = drive peak time, seconds (varies per motor; ~10 s typical)
 *
 * Units must match the current estimate (motor-side amps, Kt-consistent — see MujocoDynamics).
 * t_peak is not in the JSON descriptor (it comes from the drive's overload configuration), so
 * it defaults here and is tunable.
 */
const MAX_HEAT = 250; // % — the drive clamps the tracking variable at 250%.
const LIMIT_PCT = 100; // % — at/above this the real drive limits current to rated.

export class I2tModel {
    /**
     * @param {(number|null)[]} ratedCurrent - per-joint continuous current i_rated (A).
     * @param {(number|null)[]} maxCurrent   - per-joint maximum current i_max (A).
     * @param {Object} [opts]
     * @param {number|(number|null)[]} [opts.tPeakSec=10] - peak time (s), per joint or scalar;
     *   time at i_max to reach 100%. Unknown/missing entries default to 10 s.
     */
    constructor(ratedCurrent, maxCurrent, { tPeakSec = 10 } = {}) {
        this.iRated = ratedCurrent || [];
        this.iMax = maxCurrent || [];
        this.n = this.iRated.length;
        this.setPeakTime(tPeakSec);
        this.reset();
    }

    reset() {
        this.heat = new Array(this.n).fill(0);
    }

    /** @param {number|(number|null)[]} s peak time(s) in seconds, per joint or scalar. */
    setPeakTime(s) {
        this.tPeak = Array.from({ length: this.n }, (_, i) => {
            const v = Array.isArray(s) ? s[i] : s;
            return v != null && v > 0 ? v : 10;
        });
    }

    /** @returns {boolean} whether any joint is at/above the current-limiting threshold. */
    get limiting() {
        return this.heat.some((h) => h != null && h >= LIMIT_PCT);
    }

    /**
     * Advance the heat index by one sample.
     * @param {(number|null)[]} current - estimated motor q-axis current per joint (A).
     * @param {number} dtSec - elapsed time since the previous sample (s).
     * @returns {(number|null)[]} heat index per joint, 0..250 (%), null where unknown.
     */
    update(current, dtSec) {
        // Ignore non-positive or gap-sized steps (stream stalls, tab backgrounding).
        const dt = Math.max(0, Math.min(dtSec || 0, 0.5));
        for (let i = 0; i < this.n; i++) {
            const ir = this.iRated[i];
            const im = this.iMax[i];
            const iq = current?.[i];
            if (ir == null || im == null || iq == null || im <= ir) {
                this.heat[i] = null;
                continue;
            }
            const denom = (im * im - ir * ir) * this.tPeak[i];
            const dH = denom > 0 ? (100 * (iq * iq - ir * ir) / denom) * dt : 0;
            const h = (this.heat[i] ?? 0) + dH;
            this.heat[i] = Math.max(0, Math.min(MAX_HEAT, h));
        }
        return this.heat.slice();
    }
}
