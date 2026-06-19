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
            credentials: 'include',
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) throw new Error(`PUT ${path} → HTTP ${res.status}`);
        return res.status;
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
