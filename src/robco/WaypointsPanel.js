/**
 * Waypoints panel — capture / list / go-to / group teach waypoints.
 *
 * Capture freezes the current TCP as a world-frame pose (so it stays put when the base moves).
 * Each row can drive the robot to that pose ("Go": IK re-solved for the current base; sends a
 * move when connected, otherwise previews). Multi-select + Group/Ungroup controls how they push
 * to RobFlow (Phase 4). A visibility toggle hides/shows the markers in the viewport. Reachability
 * is recomputed live as the base moves (red marker / badge when unreachable).
 *
 * Draggable/minimizable, persisted position key `waypoints`.
 */
import { makeDraggable } from './draggable.js';
import { buildWaypointFlow } from '../transport/flowBuilder.js';

const PANEL_CSS =
    'position:fixed;right:332px;top:330px;z-index:3000;width:300px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;' +
    'color:#e6edf3;background:rgba(13,17,23,0.9);border:1px solid rgba(255,255,255,0.12);border-radius:10px;' +
    'padding:10px 12px;backdrop-filter:blur(6px);box-shadow:0 6px 24px rgba(0,0,0,0.4);max-height:80vh;overflow:auto;';
const BTN = 'font:600 11px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:5px 9px;cursor:pointer;';

function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
}

export class WaypointsPanel {
    static ensure(opts) {
        if (window._robcoWaypointsPanel) {
            window._robcoWaypointsPanel.update(opts);
            return window._robcoWaypointsPanel;
        }
        const p = new WaypointsPanel(opts);
        window._robcoWaypointsPanel = p;
        return p;
    }

    constructor({ app, teach, base, store, client }) {
        this.app = app;
        this.teach = teach;
        this.base = base;
        this.store = store;
        this.client = client || null;
        this._selected = new Set();
        this._build();

        // Re-render on store changes; recompute reachability when the base moves.
        this.store.onChange = () => this._renderList();
        this.base.onChange = () => { this.store.refreshReachability(this.teach); this._renderList(); };
        this.store.refreshReachability(this.teach);
    }

    update({ teach, base, store, client }) {
        if (teach) this.teach = teach;
        if (base) { this.base = base; this.base.onChange = () => { this.store.refreshReachability(this.teach); this._renderList(); }; }
        if (store) { this.store = store; this.store.onChange = () => this._renderList(); }
        if (client !== undefined) this.client = client;
        this._renderList();
    }

    _build() {
        const root = el('div', PANEL_CSS);
        const header = el('div', 'display:flex;align-items:center;justify-content:space-between;font-weight:600;color:#fff;');
        const t = el('span', null, 'Waypoints  ⠿');
        const minBtn = el('button', 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#e6edf3;border-radius:6px;cursor:pointer;width:22px;height:20px;', '▾');
        header.append(t, minBtn);
        root.append(header);
        const body = el('div', 'margin-top:6px;');
        root.append(body);

        // capture + count
        const topRow = el('div', 'display:flex;align-items:center;gap:8px;margin-bottom:4px;');
        const capBtn = el('button', BTN, 'Capture');
        capBtn.addEventListener('click', () => this._capture());
        this._count = el('div', 'font-size:11px;color:#9da7b3;');
        topRow.append(capBtn, this._count);
        body.append(topRow);

        // visibility toggle
        const visRow = el('label', 'display:flex;align-items:center;gap:8px;margin:2px 0 6px;cursor:pointer;');
        const vis = el('input'); vis.type = 'checkbox'; vis.checked = this.store.isVisible(); vis.style.accentColor = '#2f81f7';
        vis.addEventListener('change', () => this.store.setVisible(vis.checked));
        this._visCb = vis;
        visRow.append(vis, el('span', 'opacity:.9;', 'Show waypoints'));
        body.append(visRow);

        // list
        this._list = el('div', 'border-top:1px solid rgba(255,255,255,0.1);padding-top:4px;');
        body.append(this._list);

        // group controls
        const grpRow = el('div', 'display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;');
        const groupBtn = el('button', BTN, 'Group sel.');
        groupBtn.addEventListener('click', () => this._groupSelected());
        const ungroupBtn = el('button', BTN, 'Ungroup sel.');
        ungroupBtn.addEventListener('click', () => this._ungroupSelected());
        const clearBtn = el('button', BTN, 'Clear all');
        clearBtn.addEventListener('click', () => { this.store.clear(); this._selected.clear(); });
        grpRow.append(groupBtn, ungroupBtn, clearBtn);
        body.append(grpRow);

        this._status = el('div', 'font-size:11px;color:#9da7b3;min-height:14px;margin-top:6px;');
        body.append(this._status);

        // push section
        body.append(this._buildPush());

        minBtn.addEventListener('click', () => {
            const hidden = body.style.display === 'none';
            body.style.display = hidden ? 'block' : 'none';
            minBtn.textContent = hidden ? '▾' : '▸';
        });

        document.body.appendChild(root);
        this.root = root;
        makeDraggable(root, t, 'waypoints');
        this._renderList();
    }

    _capture() {
        if (!this.teach) { this._status.textContent = 'teach pendant not ready'; return; }
        const baseM = this.teach.tcpBaseMatrix();          // base-frame TCP
        const worldM = this.base.baseToWorld(baseM);        // → world frame (stays fixed on base move)
        const it = this.store.add(worldM, this.teach.currentAnglesDeg(), null);
        this._status.textContent = `captured ${it.name}`;
    }

    _renderList() {
        if (!this._list) return;
        this._list.innerHTML = '';
        const items = this.store.items;
        const reach = this.store.reachableCount();
        this._count.textContent = `${items.length} captured · ${reach}/${items.length} reachable`;
        if (this._visCb) this._visCb.checked = this.store.isVisible();

        let lastGid = '__none__';
        items.forEach((it) => {
            // group divider
            if (it.groupId && it.groupId !== lastGid) {
                this._list.append(el('div', 'font-size:9px;color:#6e7681;margin:3px 0 1px;', `▼ group ${it.groupId}`));
            }
            lastGid = it.groupId || '__none__';

            const row = el('div', 'display:flex;align-items:center;gap:6px;margin:2px 0;' +
                (it.groupId ? 'padding-left:8px;border-left:2px solid rgba(47,129,247,0.4);' : ''));
            const chk = el('input'); chk.type = 'checkbox'; chk.checked = this._selected.has(it.id); chk.style.accentColor = '#2f81f7';
            chk.addEventListener('change', () => { chk.checked ? this._selected.add(it.id) : this._selected.delete(it.id); });
            const dot = el('span', `width:8px;height:8px;border-radius:50%;background:${it.reachable ? '#3fb950' : '#f85149'};flex:0 0 auto;`);
            const name = el('input', 'flex:1;min-width:0;background:transparent;border:0;border-bottom:1px solid rgba(255,255,255,0.12);color:#e6edf3;font:inherit;padding:1px 2px;');
            name.value = it.name;
            name.addEventListener('change', () => this.store.rename(it.id, name.value));
            name.addEventListener('focus', () => { this._selectMarker(it.id); });
            const go = el('button', BTN + 'padding:3px 7px;', 'Go');
            go.addEventListener('click', () => this._goTo(it));
            const del = el('button', BTN + 'padding:3px 7px;', '✕');
            del.addEventListener('click', () => { this._selected.delete(it.id); this.store.remove(it.id); });
            row.append(chk, dot, name, go, del);
            this._list.append(row);
        });
        if (items.length === 0) this._list.append(el('div', 'opacity:.6;font-size:11px;', 'no waypoints — Capture to add'));
    }

    _selectMarker(id) {
        this.store.select(id);
        this.app.sceneManager?.redraw?.();
    }

    _goTo(it) {
        if (!this.teach) { this._status.textContent = 'teach pendant not ready'; return; }
        const res = this.teach.goToBaseMatrix(this.store.baseMatrix(it), it.joints);
        if (!res.converged) {
            this._status.textContent = `${it.name}: unreachable from this base (posErr ${(res.posErr * 1000).toFixed(0)} mm)`;
            return;
        }
        if (this.client) {
            const deg = res.q.map((r) => (r * 180) / Math.PI);
            this.client.moveJointAngles(deg, { velocity: 0.3, acceleration: 0.3 })
                .then(() => { this._status.textContent = `moving to ${it.name}`; })
                .catch((e) => { this._status.textContent = `move failed: ${e.message}`; });
        } else {
            this._status.textContent = `preview ${it.name}`;
        }
    }

    // --- push to RobFlow ----------------------------------------------
    _buildPush() {
        const wrap = el('div', 'border-top:1px solid rgba(255,255,255,0.1);margin-top:8px;padding-top:6px;');
        wrap.append(el('div', 'font-weight:600;letter-spacing:.04em;opacity:.85;margin-bottom:4px;text-transform:uppercase;font-size:10px;', 'Push → RobFlow'));

        const nameRow = el('div', 'display:flex;align-items:center;gap:6px;margin:2px 0;');
        nameRow.append(el('span', 'opacity:.8;', 'name'));
        this._flowName = el('input', 'flex:1;min-width:0;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:4px;color:#e6edf3;padding:2px 4px;font:inherit;');
        this._flowName.value = 'Viewer Flow';
        nameRow.append(this._flowName);
        wrap.append(nameRow);

        // joint | cartesian toggle (default joint — faster, exact; cartesian needs calibration)
        this._mode = 'joint';
        const modeRow = el('div', 'display:flex;align-items:center;gap:6px;margin:4px 0;');
        modeRow.append(el('span', 'opacity:.8;', 'as'));
        const jointBtn = el('button', BTN, 'joint');
        const cartBtn = el('button', BTN, 'cartesian');
        const setMode = (m) => {
            this._mode = m;
            jointBtn.style.background = m === 'joint' ? 'rgba(47,129,247,0.35)' : 'rgba(255,255,255,0.06)';
            cartBtn.style.background = m === 'cartesian' ? 'rgba(47,129,247,0.35)' : 'rgba(255,255,255,0.06)';
        };
        jointBtn.addEventListener('click', () => setMode('joint'));
        cartBtn.addEventListener('click', () => setMode('cartesian'));
        modeRow.append(jointBtn, cartBtn);
        wrap.append(modeRow);
        setMode('joint');

        const va = el('div', 'display:flex;align-items:center;gap:6px;margin:2px 0;font-size:11px;');
        va.append(el('span', 'opacity:.8;', 'vel'));
        this._vel = el('input', 'width:48px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:4px;color:#e6edf3;padding:2px 4px;font:inherit;text-align:right;');
        this._vel.type = 'number'; this._vel.step = '0.05'; this._vel.min = '0'; this._vel.max = '1'; this._vel.value = '0.1';
        this._acc = this._vel.cloneNode(); this._acc.value = '0.1';
        va.append(this._vel, el('span', 'opacity:.8;', 'acc'), this._acc);
        wrap.append(va);

        const btnRow = el('div', 'display:flex;gap:6px;margin-top:4px;');
        this._pushBtn = el('button', BTN, 'Push');
        this._pushBtn.addEventListener('click', () => this._push(false));
        this._runBtn = el('button', BTN, 'Push & Run');
        this._runBtn.addEventListener('click', () => this._push(true));
        btnRow.append(this._pushBtn, this._runBtn);
        wrap.append(btnRow);

        if (!this.client) wrap.append(el('div', 'font-size:10px;color:#6e7681;margin-top:3px;', 'connect a session to push'));
        return wrap;
    }

    async _push(run) {
        if (!this.client) { this._status.textContent = 'no connection — open Connect first'; return; }
        if (this.store.items.length === 0) { this._status.textContent = 'no waypoints to push'; return; }
        const mode = this._mode;
        const velocity = Math.max(0, Math.min(1, +this._vel.value || 0.1));
        const acceleration = Math.max(0, Math.min(1, +this._acc.value || 0.1));

        // Build per-group item data for the current base placement.
        const groups = [];
        const unreachable = [];
        for (const g of this.store.grouped()) {
            const items = [];
            for (const it of g.items) {
                if (mode === 'cartesian') {
                    const c = this.store.cartesianBaseFrame(it);
                    items.push({ name: it.name, position: c.position, orientation: c.orientation });
                } else {
                    const s = this.teach.solveBaseMatrix(this.store.baseMatrix(it), it.joints);
                    if (!s.converged) { unreachable.push(it.name); continue; }
                    items.push({ name: it.name, joints: s.deg.map((d) => Math.round(d * 1000) / 1000) });
                }
            }
            if (items.length) groups.push({ items });
        }
        if (mode === 'joint' && unreachable.length) {
            this._status.textContent = `unreachable from this base: ${unreachable.join(', ')} — reposition base or remove`;
            return;
        }

        const { flow, variableUuids } = buildWaypointFlow(this._flowName.value || 'Viewer Flow', groups, { mode, velocity, acceleration });
        this._lastPush = { flowUuid: flow.uuid, variableUuids, mode };
        this._status.textContent = `pushing ${variableUuids.length} ${mode} waypoints…`;
        this._pushBtn.disabled = this._runBtn.disabled = true;
        try {
            const created = await this.client.importFlow(flow);
            const uuid = created?.uuid || flow.uuid;
            if (run) {
                await this.client.runFlow(uuid);
                this._status.textContent = `running "${flow.name}" (${variableUuids.length} waypoints)`;
            } else {
                this._status.textContent = `pushed "${flow.name}" — ${groups.length} node(s), ${variableUuids.length} variables`;
            }
        } catch (e) {
            this._status.textContent = `push failed: ${e.message}`;
            console.error('[RobCo] waypoint push failed:', e);
        } finally {
            this._pushBtn.disabled = this._runBtn.disabled = false;
        }
    }

    _groupSelected() {
        const ids = [...this._selected];
        if (ids.length < 2) { this._status.textContent = 'select 2+ waypoints to group'; return; }
        this.store.groupItems(ids);
        this._status.textContent = `grouped ${ids.length} waypoints`;
    }

    _ungroupSelected() {
        const ids = [...this._selected];
        if (!ids.length) { this._status.textContent = 'select waypoints to ungroup'; return; }
        this.store.ungroupItems(ids);
        this._status.textContent = `ungrouped ${ids.length} waypoints`;
    }
}
