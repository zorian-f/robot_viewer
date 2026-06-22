/**
 * Remember the last RobFlow connection across page reloads (browser storage only — never
 * persisted to the project).
 *
 *  - session URL / SID     -> localStorage  (persists across browser restarts; it's the address
 *    of the session, needed to reconnect/pre-fill).
 *  - editor user / password -> localStorage (persist across browser restarts so the connect
 *    dialog pre-fills them and auto-reconnect can re-do the editor login. Stored in plaintext,
 *    browser-local only — acceptable here because this is the low-value inner editor login
 *    (default "editor"/"robco"), never sent anywhere but the user's own RobFlow endpoint).
 *  - Cognito id token       -> sessionStorage (survives an F5 reload but is cleared when the tab
 *    closes; the token is a short-lived (~1 h) bearer credential, so we keep its persistence
 *    deliberately narrow).
 *
 * All access is wrapped in try/catch so private-mode / disabled storage never breaks connect.
 */
const SESSION_KEY = 'robco-session';
const TOKEN_KEY = 'robco-token';
const CREDS_KEY = 'robco-editor-creds';

export function saveSession(url, sid) {
    try {
        // Preserve a previously-saved human-readable URL when a later call only knows the SID
        // (e.g. liveConnect re-saving the freshly derived SID after a successful connect). This
        // keeps the URL the user actually typed visible in the dialog on the next reload.
        const prev = loadSession() || {};
        const nextUrl = url || prev.url || sid;
        const nextSid = sid || prev.sid || null;
        localStorage.setItem(SESSION_KEY, JSON.stringify({ url: nextUrl, sid: nextSid }));
    } catch {
        /* storage unavailable */
    }
}

export function loadSession() {
    try {
        const s = localStorage.getItem(SESSION_KEY);
        return s ? JSON.parse(s) : null;
    } catch {
        return null;
    }
}

export function saveToken(token) {
    try {
        if (token) sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
        /* storage unavailable */
    }
}

export function loadToken() {
    try {
        return sessionStorage.getItem(TOKEN_KEY) || '';
    } catch {
        return '';
    }
}

/**
 * Editor login creds (for inner flow-endpoint auth). Persisted to localStorage so they survive
 * a browser restart and the connect dialog can always pre-fill them. Saved on every connect, so
 * editing a field and reconnecting updates the stored value.
 */
export function saveCreds(username, password) {
    try {
        localStorage.setItem(
            CREDS_KEY,
            JSON.stringify({ username: username || '', password: password || '' }),
        );
    } catch {
        /* storage unavailable */
    }
}

export function loadCreds() {
    try {
        // Prefer the persistent (localStorage) record; fall back to a legacy sessionStorage value
        // written by older builds so an in-progress session doesn't lose its creds on upgrade.
        const s = localStorage.getItem(CREDS_KEY) || sessionStorage.getItem(CREDS_KEY);
        return s ? JSON.parse(s) : null;
    } catch {
        return null;
    }
}

export function clearSession() {
    try {
        localStorage.removeItem(SESSION_KEY);
    } catch {
        /* ignore */
    }
    try {
        sessionStorage.removeItem(TOKEN_KEY);
    } catch {
        /* ignore */
    }
    try {
        localStorage.removeItem(CREDS_KEY);
        sessionStorage.removeItem(CREDS_KEY); // also drop any legacy copy
    } catch {
        /* ignore */
    }
}
