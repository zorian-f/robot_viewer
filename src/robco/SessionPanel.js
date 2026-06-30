/**
 * Session panel — save the whole workspace to a file and load it back. Same draggable,
 * minimizable style as the View / Render / Setup panels. Shown directly under the
 * "Connect RobFlow" button (devLoad.maybeLoadRobCo); drag it anywhere or minimize with ▾.
 *
 *   Save Session   → downloads a .robcosession.json (robot recipe + waypoints + tool/scene GLBs
 *                    + camera + settings) AND records it for auto-restore on the next reload.
 *   Load Session…  → pick a file → stage it → reload, so it restores on a clean page.
 *   Clear saved    → forget the auto-restore snapshot and reload clean.
 */
import { makeDraggable, makeCollapsible } from './draggable.js';
import {
    FORMAT, saveSession, stageAndReload, clearSavedSession, hasSavedSession, assetsBytes,
} from './sessionSnapshot.js';

const PANEL_CSS =
    'position:fixed;left:16px;top:56px;z-index:3000;width:230px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;' +
    'color:#e6edf3;background:rgba(13,17,23,0.9);border:1px solid rgba(255,255,255,0.12);border-radius:10px;' +
    'padding:10px 12px;backdrop-filter:blur(6px);box-shadow:0 6px 24px rgba(0,0,0,0.4);';
const BTN = 'width:100%;font:600 11px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:7px 9px;cursor:pointer;margin-top:6px;';

function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
}

function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export class SessionPanel {
    static ensure(app) {
        if (window._robcoSessionPanel) return window._robcoSessionPanel;
        const p = new SessionPanel(app);
        window._robcoSessionPanel = p;
        return p;
    }

    constructor(app) {
        this.app = app;
        this._build();
        this._refreshClearState();
    }

    toggle() {
        if (!this.root) return;
        this.root.style.display = this.root.style.display === 'none' ? 'block' : 'none';
    }

    _status(msg, isError = false) {
        if (this._statusEl) {
            this._statusEl.textContent = msg;
            this._statusEl.style.color = isError ? '#f85149' : '#9da7b3';
        }
    }

    _build() {
        const root = el('div', PANEL_CSS);

        const header = el('div', 'display:flex;align-items:center;justify-content:space-between;font-weight:600;color:#fff;');
        const title = el('span', null, 'Session  ⠿');
        const minBtn = el('button', 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#e6edf3;border-radius:6px;cursor:pointer;width:22px;height:20px;', '▾');
        header.append(title, minBtn);
        root.append(header);

        const body = el('div', 'margin-top:6px;');
        root.append(body);

        body.append(el('div', 'font-size:10px;color:#6e7681;margin:2px 0 4px;',
            'Saves the robot, waypoints, tool + scene GLBs, camera and look. Auto-restores on reload.'));

        const saveBtn = el('button', BTN, 'Save Session');
        saveBtn.addEventListener('click', () => this._save());
        body.append(saveBtn);

        // hidden picker for Load
        const fileInput = el('input');
        fileInput.type = 'file';
        fileInput.accept = '.json,.robcosession.json,application/json';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', () => { if (fileInput.files?.[0]) this._load(fileInput.files[0]); });
        body.append(fileInput);

        const loadBtn = el('button', BTN, 'Load Session…');
        loadBtn.addEventListener('click', () => fileInput.click());
        body.append(loadBtn);

        this._clearBtn = el('button', BTN + 'opacity:.85;', 'Clear saved session');
        this._clearBtn.addEventListener('click', () => this._clear());
        body.append(this._clearBtn);

        this._statusEl = el('div', 'font-size:10px;color:#9da7b3;margin-top:7px;min-height:13px;');
        body.append(this._statusEl);

        makeCollapsible(body, minBtn, 'session');

        document.body.appendChild(root);
        this.root = root;
        makeDraggable(root, title, 'session');
    }

    async _refreshClearState() {
        const has = await hasSavedSession();
        if (this._clearBtn) this._clearBtn.style.display = has ? 'block' : 'none';
    }

    async _save() {
        try {
            this._status('saving…');
            const session = await saveSession(this.app);
            if (!session.robot) {
                this._status('no robot loaded — saved scene state only');
            }
            const json = JSON.stringify(session);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const stamp = (session.savedAt || '').replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
            a.href = url;
            a.download = `workspace-${stamp || 'session'}.robcosession.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            const assets = assetsBytes(session);
            this._status(`saved · ${fmtBytes(json.length)}${assets ? ` (${fmtBytes(assets)} embedded)` : ''} · auto-restores on reload`);
            this._refreshClearState();
        } catch (e) {
            console.error('[RobCo] save session failed:', e);
            this._status(`save failed: ${e.message}`, true);
        }
    }

    async _load(file) {
        this._status(`loading ${file.name}…`);
        try {
            const text = await file.text();
            const session = JSON.parse(text);
            if (session?.format !== FORMAT) {
                this._status('not a RobCo session file', true);
                return;
            }
            this._status('restoring… (reloading page)');
            await stageAndReload(session); // persists to IndexedDB then reloads → restore on clean page
        } catch (e) {
            console.error('[RobCo] load session failed:', e);
            this._status(`load failed: ${e.message}`, true);
        }
    }

    async _clear() {
        try {
            await clearSavedSession();
            this._status('cleared — reloading clean…');
            setTimeout(() => location.reload(), 250);
        } catch (e) {
            this._status(`clear failed: ${e.message}`, true);
        }
    }
}
