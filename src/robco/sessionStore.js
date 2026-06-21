/**
 * Remember the last RobFlow connection across page reloads (browser storage only — never
 * persisted to the project).
 *
 *  - session URL / SID  -> localStorage  (persists across browser restarts; it's the address
 *    of the session, needed to reconnect/pre-fill).
 *  - Cognito id token   -> sessionStorage (survives an F5 reload but is cleared when the tab
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
        localStorage.setItem(SESSION_KEY, JSON.stringify({ url: url || sid, sid }));
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

/** Editor login creds (for inner flow-endpoint auth). sessionStorage — cleared on tab close. */
export function saveCreds(username, password) {
    try {
        if (username) sessionStorage.setItem(CREDS_KEY, JSON.stringify({ username, password: password || '' }));
    } catch {
        /* storage unavailable */
    }
}

export function loadCreds() {
    try {
        const s = sessionStorage.getItem(CREDS_KEY);
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
        sessionStorage.removeItem(CREDS_KEY);
    } catch {
        /* ignore */
    }
}
