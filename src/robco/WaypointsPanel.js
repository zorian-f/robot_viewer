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
import { buildWaypointFlow, poseValue } from '../transport/flowBuilder.js';

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

    constructor({ app, teach, base, store, client, cycleTimer }) {
        this.app = app;
        this.teach = teach;
        this.base = base;
        this.store = store;
        this.client = client || null;
        this.cycleTimer = cycleTimer || null;
        this._selected = new Set();
        // Per-flow-name push registry: name → {flowUuid, name, mode, signature, varByKey}.
        // Lets a re-push reuse the same variables (override) or clean them up (rebuild).
        this._pushReg = new Map();
        this._build();
        this._bindCycleTimer();

        // Re-render on store changes; recompute reachability when the base moves.
        this.store.onChange = () => this._renderList();
        this.base.onChange = () => { this.store.refreshReachability(this.teach); this._renderList(); };
        this.store.refreshReachability(this.teach);
    }

    update({ teach, base, store, client, cycleTimer }) {
        if (teach) this.teach = teach;
        if (base) { this.base = base; this.base.onChange = () => { this.store.refreshReachability(this.teach); this._renderList(); }; }
        if (store) { this.store = store; this.store.onChange = () => this._renderList(); }
        if (client !== undefined) this.client = client;
        if (cycleTimer) { this.cycleTimer = cycleTimer; this._bindCycleTimer(); }
        this._renderList();
    }

    /** Route the cycle meter's updates to the readout and show its current value. */
    _bindCycleTimer() {
        if (!this.cycleTimer) return;
        this.cycleTimer.onUpdate = (stats) => this._renderCycle(stats);
        this._renderCycle(this.cycleTimer.stats());
    }

    _renderCycle(stats) {
        if (!this._cycleLine) return;
        if (!stats || stats.lastMs == null) { this._cycleLine.textContent = 'Cycle: —'; return; }
        const s = (ms) => `${(ms / 1000).toFixed(2)} s`;
        const avg = stats.avgMs != null ? ` · avg ${s(stats.avgMs)}` : '';
        this._cycleLine.textContent = `Cycle: ${s(stats.lastMs)}${avg} · n=${stats.count}`;
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
        // If the robot is actually at this pose (not gizmo-dragging), keep RobFlow's exact
        // reported cartesian — its orientation convention isn't a simple offset from our FK.
        const robflowPose = (!this.app._teachActive && this.app._robcoLatestPose) ? this.app._robcoLatestPose : null;
        const it = this.store.add(worldM, this.teach.currentAnglesDeg(), null, robflowPose);
        this._status.textContent = `captured ${it.name}${robflowPose ? ' (exact cartesian)' : ''}`;
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
        this._vel.type = 'number'; this._vel.step = '0.05'; this._vel.min = '0'; this._vel.max = '1'; this._vel.value = '1';
        this._acc = this._vel.cloneNode(); this._acc.value = '1';
        va.append(this._vel, el('span', 'opacity:.8;', 'acc'), this._acc);
        wrap.append(va);

        const btnRow = el('div', 'display:flex;gap:6px;margin-top:4px;');
        this._pushBtn = el('button', BTN, 'Push');
        this._pushBtn.addEventListener('click', () => this._push(false));
        this._runBtn = el('button', BTN, 'Push & Run');
        this._runBtn.addEventListener('click', () => this._push(true));
        // Run the last-pushed flow again without re-importing (re-uses its variables).
        this._runOnlyBtn = el('button', BTN + 'border-color:#3fb950;', 'Run');
        this._runOnlyBtn.addEventListener('click', () => this._runLast());
        btnRow.append(this._pushBtn, this._runBtn, this._runOnlyBtn);
        wrap.append(btnRow);

        // Measured loop cycle time (fed by the messageLog marker over the WS message stream).
        this._cycleLine = el('div', 'font-size:11px;color:#9da7b3;margin-top:6px;min-height:14px;', 'Cycle: —');
        wrap.append(this._cycleLine);

        if (!this.client) wrap.append(el('div', 'font-size:10px;color:#6e7681;margin-top:3px;', 'connect a session to push'));
        return wrap;
    }

    async _push(run) {
        if (!this.client) { this._status.textContent = 'no connection — open Connect first'; return; }
        if (this.store.items.length === 0) { this._status.textContent = 'no waypoints to push'; return; }
        const mode = this._mode;
        const velocity = Math.max(0, Math.min(1, +this._vel.value || 1));
        const acceleration = Math.max(0, Math.min(1, +this._acc.value || 1));

        // Build per-group item data for the current base placement. Each item keeps its
        // stable waypoint id so a re-push can target the same variables (override path).
        const groups = [];
        const unreachable = [];
        for (const g of this.store.grouped()) {
            const items = [];
            for (const it of g.items) {
                if (mode === 'cartesian') {
                    // Prefer RobFlow's exact captured cartesian (correct convention); fall back to
                    // our computed base-frame pose (approximate orientation) for gizmo/base-moved poses.
                    const c = it.robflowPose && it.robflowPose.position
                        ? it.robflowPose
                        : this.store.cartesianBaseFrame(it);
                    items.push({ id: it.id, name: it.name, position: c.position, orientation: c.orientation });
                } else {
                    const s = this.teach.solveBaseMatrix(this.store.baseMatrix(it), it.joints);
                    if (!s.converged) { unreachable.push(it.name); continue; }
                    items.push({ id: it.id, name: it.name, joints: s.deg.map((d) => Math.round(d * 1000) / 1000) });
                }
            }
            if (items.length) groups.push({ items });
        }
        if (mode === 'joint' && unreachable.length) {
            this._status.textContent = `unreachable from this base: ${unreachable.join(', ')} — reposition base or remove`;
            return;
        }

        const name = this._flowName.value || 'Viewer Flow';
        // Structural signature = everything that lives in the flow's nodes rather than its
        // pose variables: grouping/order of waypoint ids, mode, velocity, acceleration. If only
        // the poses moved (same signature), we can override the variable values in place.
        const signature = JSON.stringify({
            mode, velocity, acceleration,
            groups: groups.map((g) => g.items.map((i) => i.id)),
        });
        const reg = this._pushReg.get(name);
        const canOverride = !!reg && reg.signature === signature
            && groups.every((g) => g.items.every((i) => reg.varByKey[String(i.id)]));

        this._pushBtn.disabled = this._runBtn.disabled = this._runOnlyBtn.disabled = true;
        try {
            let overrode = false;
            if (canOverride) {
                try {
                    await this._override(reg, groups, mode, run);
                    overrode = true;
                } catch (e) {
                    // Override is the fast path; if the backend rejects it, fall back to a full
                    // rebuild (which also cleans up the old variables) so a push is never stuck.
                    console.warn('[RobCo] variable override failed — rebuilding:', e);
                    this._status.textContent = `override failed, rebuilding… (${e.message})`;
                }
            }
            if (!overrode) {
                await this._rebuild(reg, name, groups, { mode, velocity, acceleration }, signature, run);
            }
        } catch (e) {
            const hint = /\b40[13]\b/.test(e.message)
                ? ' — editor login required (reconnect with the editor password)' : '';
            this._status.textContent = `push failed: ${e.message}${hint}`;
            console.error('[RobCo] waypoint push failed:', e);
        } finally {
            this._pushBtn.disabled = this._runBtn.disabled = this._runOnlyBtn.disabled = false;
        }
    }

    /**
     * Value-only fast path — only the poses changed. PATCH the existing pose variables in
     * place (no re-import, no new variables). Sets both currentValue and initialValue so the
     * new pose applies whichever one the run resolves (RobFlow runtime is strict here — verify
     * on the live robot; if a re-run ignores the override, press Push to force a rebuild).
     */
    async _override(reg, groups, mode, run) {
        // `dtype` is the discriminator the PATCH /variables tagged-union needs to pick the right
        // partial model — without it the backend rejects the body (422, errorCode 250).
        const dtype = mode === 'cartesian' ? 'cartesianPose' : 'jointPose';
        let n = 0;
        for (const g of groups) {
            for (const it of g.items) {
                const v = poseValue(mode, it);
                await this.client.updateVariable(reg.varByKey[String(it.id)], { dtype, currentValue: v, initialValue: v });
                n += 1;
            }
        }
        this._lastPush = { flowUuid: reg.flowUuid, name: reg.name, variableUuids: Object.values(reg.varByKey), mode };
        if (run) {
            await this._beginRun(reg.flowUuid);
            this._status.textContent = `override + run "${reg.name}" — updated ${n} waypoint value(s)`;
        } else {
            this._status.textContent = `override "${reg.name}" — updated ${n} value(s) in place (no re-import)`;
        }
    }

    /**
     * Full rebuild — structure changed (or first push). Delete the previous push's variables
     * first so re-pushing never piles them up (and dodges the import-time "variable name
     * already exists → HTTP 500" trap), then import a fresh flow.
     */
    async _rebuild(reg, name, groups, opts, signature, run) {
        if (reg) {
            for (const varUuid of Object.values(reg.varByKey)) {
                await this.client.deleteVariable(varUuid).catch(() => {}); // best-effort cleanup
            }
        }
        const { flow, variableUuids, varByKey } = buildWaypointFlow(name, groups, opts);
        this._status.textContent = `pushing ${variableUuids.length} ${opts.mode} waypoints…`;
        const created = await this.client.importFlow(flow);
        const uuid = created?.uuid || flow.uuid;
        this._pushReg.set(name, { flowUuid: uuid, name: flow.name, mode: opts.mode, signature, varByKey });
        this._lastPush = { flowUuid: uuid, name: flow.name, variableUuids, mode: opts.mode };
        if (run) {
            await this._beginRun(uuid);
            this._status.textContent = `running "${flow.name}" (${variableUuids.length} waypoints)`;
        } else {
            this._status.textContent = `pushed "${flow.name}" — ${groups.length} node(s), ${variableUuids.length} variables`;
        }
    }

    /**
     * Start (or restart) a run. Our flows loop forever, so a previous run is usually still
     * active — issue PUT /stop first to clear FLOW_CONTINUOUS_RUNNING (otherwise /run → 409),
     * re-assert operational, reset the cycle meter, then run. Retries once if the robot was
     * still mid-stop when /run landed.
     */
    async _beginRun(uuid) {
        await this.client.stop().catch(() => {});                  // clear any looping/paused flow
        await this.client.setDesiredRobotState(2).catch(() => {}); // ensure operational
        this.cycleTimer?.reset();                                  // fresh run → measure from scratch
        try {
            await this.client.runFlow(uuid);
        } catch (e) {
            if (!/\b409\b/.test(e.message)) throw e;
            await new Promise((r) => setTimeout(r, 500));          // robot still stopping — let it settle
            await this.client.setDesiredRobotState(2).catch(() => {});
            await this.client.runFlow(uuid);
        }
    }

    /** Run the most recently pushed flow again — no re-import (re-uses its variables). */
    async _runLast() {
        if (!this.client) { this._status.textContent = 'no connection — open Connect first'; return; }
        const last = this._lastPush;
        if (!last?.flowUuid) { this._status.textContent = 'nothing pushed yet — Push first'; return; }
        this._runOnlyBtn.disabled = true;
        this._status.textContent = `running "${last.name || 'flow'}"…`;
        try {
            await this._beginRun(last.flowUuid);
            this._status.textContent = `running "${last.name || 'flow'}"`;
        } catch (e) {
            const hint = /\b40[13]\b/.test(e.message)
                ? ' — editor login required (reconnect with the editor password)' : '';
            this._status.textContent = `run failed: ${e.message}${hint}`;
            console.error('[RobCo] flow run failed:', e);
        } finally {
            this._runOnlyBtn.disabled = false;
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
