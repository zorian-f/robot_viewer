/**
 * RobFlow robot state enums → human labels + severity (for status colouring).
 * Ported from RobFlowLink/core/enums.py. Severity: ok | busy | warn | err.
 */
const OK = 'ok', BUSY = 'busy', WARN = 'warn', ERR = 'err';

export const OPERATION_MODE = {
    100: ['Teach', OK],
    200: ['Flow', OK],
    210: ['Flow (continuous)', OK],
    211: ['Flow running', BUSY],
    212: ['Flow resume', BUSY],
    220: ['Flow paused', WARN],
    221: ['Flow paused (on traj.)', WARN],
    222: ['Flow paused (off traj.)', WARN],
    500: ['Error', ERR],
    600: ['Critical', ERR],
};

export const ROBOT_STATE = {
    101: ['Disabled', WARN],
    102: ['Switched on', OK],
    103: ['Idle', OK],
    104: ['Transition', BUSY],
    110: ['Idle (paused)', WARN],
    111: ['Paused (on traj.)', WARN],
    112: ['Paused (off traj.)', WARN],
    210: ['Moving', BUSY],
    211: ['Moving PTP', BUSY],
    212: ['Moving linear', BUSY],
    213: ['Resume', BUSY],
    214: ['Auto-resume', BUSY],
    220: ['Decelerating', BUSY],
    231: ['Jogging', BUSY],
    232: ['Hand-guiding', BUSY],
    500: ['Error', ERR],
    510: ['Connection error', ERR],
    511: ['Backend connection error', ERR],
    512: ['Controller connection error', ERR],
    513: ['Robot connection error', ERR],
    520: ['Movement error', ERR],
    521: ['Near singularity', ERR],
    523: ['Velocity error', ERR],
    525: ['Angle out of limit', ERR],
    530: ['Module error', ERR],
    531: ['Module overheat', ERR],
    600: ['Critical', ERR],
};

export const SAFETY_STATE = {
    100: ['Manual', OK],
    200: ['Auto', OK],
    300: ['Safe stop', WARN],
    301: ['Safe stop 0', WARN],
    302: ['Safe stop 1', WARN],
    303: ['Safe stop 2', WARN],
    500: ['Safety error', ERR],
};

export function label(map, code) {
    if (code === undefined || code === null) return ['—', 'warn'];
    return map[code] || [`code ${code}`, 'warn'];
}

export const SEVERITY_COLOR = {
    ok: '#3fb950',
    busy: '#2f81f7',
    warn: '#d29922',
    err: '#f85149',
};

/** True when the robot is in TEACH mode and not in a safety/error state — moves allowed. */
export function canTeach(operationMode, safetyState) {
    return operationMode === 100 && safetyState !== 500 && (safetyState === undefined || safetyState < 300);
}
