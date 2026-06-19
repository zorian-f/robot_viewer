/**
 * "Connect to RobFlow" dialog: paste a Cognito id token (and/or a session URL/SID), then
 * connect (build robot + live mirror + dynamics + teach pendant with Send enabled).
 *
 * Token -> GET /status -> SID. A session URL/SID can also be pasted directly (Send then
 * needs the token too). See transport/robcoAuth for why a full in-app OAuth isn't possible.
 */
import { fetchSession, decodeToken } from '../transport/robcoAuth.js';
import { connectLiveSession } from './liveConnect.js';

/** Extract the SID from a full session URL, or pass through a bare SID. */
function parseSid(input) {
    const s = input.trim();
    if (!s) return '';
    const m = s.match(/session\/(?:ws\/)?([^/?#]+)/);
    return m ? m[1] : s;
}

export function openConnectDialog(app) {
    const overlay = document.createElement('div');
    overlay.style.cssText =
        'position:fixed;inset:0;z-index:4000;background:rgba(0,0,0,0.55);display:flex;' +
        'align-items:center;justify-content:center;font:13px ui-monospace,Menlo,Consolas,monospace;';

    const card = document.createElement('div');
    card.style.cssText =
        'background:#0d1117;color:#e6edf3;border:1px solid rgba(255,255,255,0.15);border-radius:12px;' +
        'padding:20px;width:560px;max-width:92vw;box-shadow:0 12px 40px rgba(0,0,0,0.5);';
    card.innerHTML = `
        <div style="font-weight:600;font-size:15px;margin-bottom:4px;">Connect to RobFlow</div>
        <div style="opacity:.72;margin-bottom:14px;line-height:1.6;">
          1. <a href="https://robco.studio" target="_blank" rel="noopener"
                style="color:#2f81f7;text-decoration:none;">Open RobCo Studio ↗</a> and log in (Google).<br>
          2. DevTools (F12) → <b>Network</b> → click any request to <code>api.robco.studio</code>
             → copy the <code>authorization: Bearer …</code> value.<br>
          3. Paste it below → Connect. Token lasts ~1&nbsp;h. (A session URL alone gives a
             view-only connection.)
        </div>
        <label style="display:block;opacity:.8;margin:8px 0 3px;">Cognito id token (Bearer)</label>
        <textarea id="rc-token" rows="4" placeholder="eyJ…"
          style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.06);color:#e6edf3;
          border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:8px;resize:vertical;font:inherit;"></textarea>
        <label style="display:block;opacity:.8;margin:10px 0 3px;">Session URL or SID (optional)</label>
        <input id="rc-sid" type="text" placeholder="https://api.robco.studio/.../session/<SID>/…  or  <SID>"
          style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.06);color:#e6edf3;
          border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:8px;font:inherit;"/>
        <div id="rc-status" style="min-height:18px;margin-top:10px;font-size:12px;opacity:.85;"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;">
          <button id="rc-cancel" style="background:transparent;color:#9da7b3;border:1px solid rgba(255,255,255,0.15);
            border-radius:8px;padding:8px 14px;cursor:pointer;font:inherit;">Cancel</button>
          <button id="rc-connect" style="background:#238636;color:#fff;border:0;border-radius:8px;
            padding:8px 16px;cursor:pointer;font:inherit;font-weight:600;">Connect</button>
        </div>`;
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const $ = (id) => card.querySelector(id);
    const status = (msg, ok = false) => {
        $('#rc-status').textContent = msg;
        $('#rc-status').style.color = ok ? '#3fb950' : '#f0b72f';
    };
    const close = () => overlay.remove();

    $('#rc-token').addEventListener('input', () => {
        const t = $('#rc-token').value.trim();
        if (!t) return status('');
        const info = decodeToken(t);
        if (!info) status('token does not look like a JWT');
        else if (info.expired) status(`token expired (${info.email || ''})`);
        else status(`token ok — ${info.email || ''}, ~${info.expiresInMin} min left`, true);
    });

    $('#rc-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    $('#rc-connect').addEventListener('click', async () => {
        const token = $('#rc-token').value.trim();
        let sid = parseSid($('#rc-sid').value);
        status('connecting…');
        try {
            if (token && !sid) sid = await fetchSession(token);
            if (!sid) throw new Error('paste a token or a session URL/SID');
            close();
            await connectLiveSession(app, { sid, token: token || undefined });
            console.log('[RobCo] connected via dialog');
        } catch (e) {
            status(`failed: ${e.message}`);
            console.error('[RobCo] connect failed:', e);
        }
    });
}
