/**
 * Per-motor no-load speed at the 48 V Circulo bus, for the torque-speed envelope (#4).
 *
 * Why only no-load speed: the low-speed torque ceiling is the *drive-enforced* current limit
 * (i_max·Kt, from the descriptor + CSV 0x6073) — NOT the motor datasheet peak torque, which the
 * Circulo's current config disallows. So the envelope is the current-limit torque derated by a
 * back-EMF rolloff that reaches zero at the motor's no-load speed:
 *
 *   τ_max(ω) = i_max · Kt · max(0, 1 − ω_motor / ω_noload)        (motor side; ×gear_ratio → joint)
 *
 * This sidesteps the datasheet-vs-descriptor Kt convention mismatch entirely and, at ω = 0,
 * reduces exactly to the static current utilization (|i_q| / i_max).
 *
 * No-load speeds (motor side, 48 V):
 *  - TQ ILM-E (delta-serial winding): straight from the datasheet (Rev0107).
 *  - Kollmorgen TBM2G: not published directly; extrapolated linearly from the datasheet peak
 *    torque and the rated-@48V point (155 °C) to zero torque, ω0 = ω_r / (1 − T_r/T_peak).
 *
 * Keyed by the substring that appears in the descriptor's `motor.name`. See memory
 * `robco-motor-envelopes` for the full corner-point table and sources.
 */
const RPM_TO_RAD = (2 * Math.PI) / 60;

// motor-name substring -> no-load speed (rpm, motor side, 48 V)
const NO_LOAD_RPM = {
    // TQ RoboDrive ILM-E, delta-serial (datasheet)
    'ILM-E50x14': 6526,
    'ILM-E70x18': 3450,
    'ILM-85x26': 2536,
    // Kollmorgen TBM2G (extrapolated from peak + rated@48V/155°C)
    'TBM2G-06808C': 8857,
    'TBM2G-08513D': 7539,
    'TBM2G-09426D': 4174,
    'TBM2G-11526C': 2585,
};

// i²t peak time (Synapticon 0x200A:2), per motor, read from each module's Circulo .csv.
// Time at the maximum current to reach the 100% heat-index limit. TQ ILM all use 10 s; the
// Kollmorgen-retrofit drives vary (e.g. D86-KM trips ~2.5× faster than the 10 s default).
// motor-name substring -> peak time (seconds, motor side, 48 V).
const PEAK_TIME_SEC = {
    'ILM-E50x14': 10,
    'ILM-E70x18': 10,
    'ILM-85x26': 10,
    'TBM2G-06808C': 3.9,
    'TBM2G-08513D': 8.6,
    'TBM2G-09426D': 10,
    'TBM2G-11526C': 11.42,
};

/**
 * No-load (zero-torque) motor speed for a given descriptor motor name.
 * @param {string} [motorName]
 * @returns {number|null} rad/s (motor side), or null if the motor is unknown.
 */
export function noLoadSpeedRadFor(motorName) {
    if (!motorName) return null;
    for (const key of Object.keys(NO_LOAD_RPM)) {
        if (motorName.includes(key)) return NO_LOAD_RPM[key] * RPM_TO_RAD;
    }
    return null;
}

/**
 * i²t peak time (Synapticon 0x200A:2) for a given descriptor motor name.
 * @param {string} [motorName]
 * @returns {number|null} seconds, or null if the motor is unknown (caller defaults).
 */
export function peakTimeSecFor(motorName) {
    if (!motorName) return null;
    for (const key of Object.keys(PEAK_TIME_SEC)) {
        if (motorName.includes(key)) return PEAK_TIME_SEC[key];
    }
    return null;
}
