/**
 * Minimal RobFlow REST client (the bits the teach pendant needs to command a robot).
 *
 * Base URL forms (see transport/session.js):
 *   cloud: https://api.robco.studio/public/virtual-robot/session/{SID}/api/v3.0
 *   local: http://{host}:{port}/api/v3.0
 *
 * Auth: cloud accepts the Cognito id token as Bearer (verified) and also the in-session
 * cookie (credentials: include). Moves require the robot in TEACH mode + a safe state.
 * Angles are in DEGREES (matches RobFlow), velocity/acceleration are 0..1 fractions.
 */
export class RobFlowClient {
    /**
     * @param {string} restBase - .../api/v3.0
     * @param {Object} [opts]
     * @param {string} [opts.token] - Bearer token (cloud Cognito id token).
     */
    constructor(restBase, { token = null } = {}) {
        this.restBase = restBase.replace(/\/$/, '');
        this.token = token;
    }

    _headers() {
        const h = { 'Content-Type': 'application/json' };
        if (this.token) h.Authorization = `Bearer ${this.token}`;
        return h;
    }

    async _put(path, body) {
        const res = await fetch(`${this.restBase}${path}`, {
            method: 'PUT',
            headers: this._headers(),
            // The API returns Access-Control-Allow-Origin: *, which the browser rejects with
            // credentials:'include'. Auth is the Bearer token, so omit credentials.
            credentials: 'omit',
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) {
            const detail = res.status === 401 || res.status === 403
                ? ' (missing/expired token, or robot not in TEACH mode)'
                : '';
            throw new Error(`PUT ${path} → HTTP ${res.status}${detail}`);
        }
        return res.status;
    }

    async _get(path) {
        const res = await fetch(`${this.restBase}${path}`, {
            headers: this._headers(),
            credentials: 'omit',
        });
        if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
        return res.json();
    }

    /** GET /robot-config/ — also used as a lightweight API-reachability ping. */
    getRobotConfig() {
        return this._get('/robot-config/');
    }

    /** Set global speed fraction (0..1). */
    setGlobalSpeed(speed) {
        return this._put('/global-speed', Math.round(speed * 1000) / 1000);
    }

    /** Stop any active jog motion. */
    stopJogging() {
        return this._put('/stop-jogging');
    }

    /** Jog a single joint at a velocity fraction (requires JOGGING/TEACH mode). */
    jogJoint(jointIndex, velocity) {
        return this._put('/jog-joint', { jointIndex, velocity });
    }

    /** Move to joint angles (degrees). approachMode: 1=PTP, 2=Linear. */
    moveJointAngles(anglesDeg, { velocity = 0.1, acceleration = 0.1, approachMode = 1 } = {}) {
        return this._put('/move-joint-angles', [
            { pose: { jointAngles: anglesDeg }, velocity, acceleration, approachMode },
        ]);
    }

    /** Move the TCP to a Cartesian pose. position mm, orientation deg. */
    moveCartesian(position, orientation, { velocity = 0.1, acceleration = 0.1 } = {}) {
        return this._put('/move-cartesian', [
            { pose: { position, orientation }, velocity, acceleration },
        ]);
    }

    /** Desired robot state: 2 = OPERATIONAL. */
    setDesiredRobotState(state) {
        return this._put('/desired-robot-state', state);
    }

    /** Emergency stop — halts motion. */
    stop() {
        return this._put('/stop');
    }
}
