/**
 * RobCo cloud auth helper.
 *
 * Self-contained in-app OAuth is NOT possible: RobCo's Cognito (pool eu-central-1_McJovQlcb,
 * client 4gntu4bg8bim49i7edsjg981bq, hosted UI https://auth.robco.studio) only redirects to
 * https://robco.studio/login and uses a confidential client (secret on RobCo's backend). So
 * we can't receive/exchange the code in our app.
 *
 * Practical path: the user logs in at robco.studio (Google) and we use the resulting Cognito
 * **id token** -> GET /public/virtual-robot/status -> { token: SID }. The token lasts ~1h.
 * A robco.studio content-script extension (like session-clipper) can automate handing us the
 * token; otherwise it is pasted in the Connect dialog.
 */
export const ROBCO_AUTH = {
    clientId: '4gntu4bg8bim49i7edsjg981bq',
    hostedUi: 'https://auth.robco.studio',
    appOrigin: 'https://robco.studio',
    scope: 'aws.cognito.signin.user.admin+email+openid',
    statusUrl: 'https://api.robco.studio/public/virtual-robot/status',
};

/** RobCo hosted-UI login URL (Google). Lands the user back on robco.studio (their callback). */
export function loginUrl() {
    const { hostedUi, clientId, scope, appOrigin } = ROBCO_AUTH;
    const redirect = encodeURIComponent(`${appOrigin}/login`);
    return `${hostedUi}/login?client_id=${clientId}&response_type=code&scope=${scope}&redirect_uri=${redirect}`;
}

/** Decode a JWT payload (no verification) for display: email + expiry. */
export function decodeToken(token) {
    try {
        const payload = JSON.parse(
            decodeURIComponent(
                atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
                    .split('')
                    .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
                    .join(''),
            ),
        );
        const expiresInMin = payload.exp ? Math.round((payload.exp * 1000 - Date.now()) / 60000) : null;
        return { email: payload.email, exp: payload.exp, expiresInMin, expired: expiresInMin !== null && expiresInMin <= 0 };
    } catch {
        return null;
    }
}

/**
 * Exchange a Cognito id token for a virtual-robot session id (SID).
 * @param {string} token - Cognito id token (Bearer).
 * @param {string} [apiHost=api.robco.studio]
 * @returns {Promise<string>} the session token (SID)
 */
export async function fetchSession(token, apiHost = 'api.robco.studio') {
    const url = apiHost === 'api.robco.studio' ? ROBCO_AUTH.statusUrl : `https://${apiHost}/public/virtual-robot/status`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`/status → HTTP ${res.status}${res.status === 401 ? ' (token expired or invalid)' : ''}`);
    const data = await res.json();
    if (!data.token) throw new Error('/status returned no session token');
    return data.token;
}
