/**
 * RobFlow Tools panel — consolidated control surface (inspired by RobFlowLink):
 *   • Status  — WebSocket ● + API ● + decoded robot / operation / safety state.
 *   • Teach   — gizmo on/off, Move/Rotate, IK readout, Send (velocity/accel/approach), Stop.
 *   • Control — Enable (operational), Stop, global-speed.
 *
 * Drives the TeachPendant gizmo engine and a RobFlowClient. Sections that need a robot
 * (Send/Control/Status) are hidden when there is no client (static preview).
 */
import { OPERATION_MODE, ROBOT_STATE, SAFETY_STATE, label, SEVERITY_COLOR, canTeach } from './robcoEnums.js';
import { buildJointFlow } from '../transport/flowBuilder.js';
import { makeDraggable } from './draggable.js';

const PANEL_CSS =
    'position:fixed;right:16px;top:16px;z-index:3000;width:300px;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;' +
    'color:#e6edf3;background:rgba(13,17,23,0.9);border:1px solid rgba(255,255,255,0.12);border-radius:10px;' +
    'padding:12px;backdrop-filter:blur(6px);box-shadow:0 6px 24px rgba(0,0,0,0.4);';
const BTN = 'font:600 12px ui-monospace,monospace;color:#e6edf3;background:rgba(255,255,255,0.06);' +
    'border:1px solid rgba(255,255,255,0.15);border-radius:7px;padding:6px 10px;cursor:pointer;';

function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
}
function dot(color) {
    return `display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};margin-right:6px;vertical-align:middle;`;
}
function sectionTitle(t) {
    return el('div', 'font-weight:600;letter-spacing:.04em;opacity:.85;margin:12px 0 6px;text-transform:uppercase;font-size:10px;', t);
}
/** Labeled slider row → { row, get } */
function slider(labelText, min, max, step, val, onInput) {
    const row = el('div', 'display:grid;grid-template-columns:64px 1fr 40px;gap:8px;align-items:center;margin:4px 0;');
    row.append(el('span', 'opacity:.8;', labelText));
    const input = el('input', 'width:100%;accent-color:#2f81f7;');
    input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = val;
    const out = el('span', 'text-align:right;opacity:.9;', (+val).toFixed(2));
    input.addEventListener('input', () => { out.textContent = (+input.value).toFixed(2); onInput?.(+input.value); });
    row.append(input, out);
    return { row, get: () => +input.value };
}

export class RobFlowToolsPanel {
    constructor(app, { teach = null, client = null } = {}) {
        this.app = app;
        this.teach = teach;
        this.client = client;
        this.states = {};
        this._waypoints = [];
        this._build();
        if (teach) this.setTeach(teach);
        if (client) this._pingApi();
    }

    /** Attach (or replace) the teach gizmo engine after the robot is built. */
    setTeach(teach) {
        this.teach = teach;
        if (teach) {
            teach.onIk = (res) => this._setIk(res);
            teach.onModeChange = (m) => this._setMode(m);
            if (this.client) this._buildJogRows(teach.jointNames);
        }
    }

    _buildJogRows(jointNames) {
        this._jogRows.innerHTML = '';
        jointNames.forEach((_, i) => {
            const row = el('div', 'display:flex;gap:6px;align-items:center;margin:3px 0;');
            row.append(el('span', 'width:30px;opacity:.8;', `J${i + 1}`));
            const minus = el('button', BTN + 'flex:1;', '−');
            const plus = el('button', BTN + 'flex:1;', '+');
            minus.addEventListener('pointerdown', (e) => { e.preventDefault(); this._jogStart(i, -1); });
            plus.addEventListener('pointerdown', (e) => { e.preventDefault(); this._jogStart(i, 1); });
            for (const b of [minus, plus]) {
                b.addEventListener('pointerup', () => this._jogStop());
                b.addEventListener('pointerleave', () => this._jogStop());
                b.addEventListener('pointercancel', () => this._jogStop());
            }
            row.append(minus, plus);
            this._jogRows.append(row);
        });
    }

    _jogStart(index, dir) {
        if (!this.client) return;
        this._jogStop();
        const v = dir * this._jogSpeed.get();
        const fire = () => this.client.jogJoint(index, v).then(() => this.setApi(true)).catch((e) => {
            this.setApi(false);
            this._ik.textContent = `jog failed: ${e.message}`;
            this._jogStop();
        });
        fire();
        this._jogTimer = setInterval(fire, 800); // re-send before the ~1 s jog timeout
    }

    _jogStop() {
        if (this._jogTimer) {
            clearInterval(this._jogTimer);
            this._jogTimer = null;
            this.client?.stopJogging?.().catch(() => {});
        }
    }

    _build() {
        const root = el('div', PANEL_CSS);
        const title = el('div', 'font-weight:600;font-size:14px;color:#fff;margin-bottom:2px;', 'RobFlow Tools  ⠿');
        root.append(title);

        // --- Status ---
        root.append(sectionTitle('Status'));
        const conn = el('div', 'margin-bottom:4px;');
        this._wsDot = el('span', dot('#5b6b7a')); this._wsTxt = el('span', 'margin-right:12px;', 'WS —');
        this._apiDot = el('span', dot('#5b6b7a')); this._apiTxt = el('span', null, 'API —');
        conn.append(this._wsDot, this._wsTxt, this._apiDot, this._apiTxt);
        root.append(conn);
        this._robotLine = el('div'); this._modeLine = el('div'); this._safetyLine = el('div');
        root.append(this._robotLine, this._modeLine, this._safetyLine);
        this._renderStates();

        // --- Teach ---
        root.append(sectionTitle('Teach Pendant'));
        const teachRow = el('div', 'display:flex;gap:6px;flex-wrap:wrap;');
        this._teachBtn = el('button', BTN, 'Teach: OFF');
        this._moveBtn = el('button', BTN + 'display:none;', 'Move (W)');
        this._rotBtn = el('button', BTN + 'display:none;', 'Rotate (E)');
        teachRow.append(this._teachBtn, this._moveBtn, this._rotBtn);
        root.append(teachRow);
        this._ik = el('div', 'margin-top:6px;font-size:11px;color:#9da7b3;min-height:16px;');
        root.append(this._ik);

        this._teachBtn.addEventListener('click', () => this._toggleTeach());
        this._moveBtn.addEventListener('click', () => this.teach?.setMode('translate'));
        this._rotBtn.addEventListener('click', () => this.teach?.setMode('rotate'));

        // --- Send (needs client) ---
        this._sendBox = el('div', 'margin-top:8px;');
        this._vel = slider('velocity', 0.01, 1, 0.01, 1);
        this._acc = slider('accel', 0.01, 1, 0.01, 1);
        const apprRow = el('div', 'display:flex;align-items:center;gap:8px;margin:4px 0;');
        apprRow.append(el('span', 'opacity:.8;width:64px;', 'approach'));
        this._appr = el('select', 'flex:1;background:rgba(255,255,255,0.08);color:#e6edf3;border:1px solid rgba(255,255,255,0.15);border-radius:5px;padding:3px;font:inherit;');
        this._appr.innerHTML = '<option value="1">PTP</option><option value="2">Linear</option>';
        apprRow.append(this._appr);
        const sendRow = el('div', 'display:flex;gap:6px;margin-top:6px;');
        this._sendBtn = el('button', BTN + 'border-color:#2f81f7;flex:1;', 'Send to Robot');
        this._stopBtn = el('button', BTN + 'background:#5a1e1e;border-color:#f85149;', 'Stop');
        sendRow.append(this._sendBtn, this._stopBtn);
        this._sendBox.append(this._vel.row, this._acc.row, apprRow, sendRow);
        root.append(this._sendBox);
        this._sendBtn.addEventListener('click', () => this._send());
        this._stopBtn.addEventListener('click', () => this._control('stop'));

        // --- Control (needs client) ---
        this._ctrlBox = el('div');
        this._ctrlBox.append(sectionTitle('Control'));
        const ctrlRow = el('div', 'display:flex;gap:6px;');
        this._enableBtn = el('button', BTN + 'border-color:#3fb950;flex:1;', 'Enable (operational)');
        const ctrlStop = el('button', BTN + 'background:#5a1e1e;border-color:#f85149;', 'Stop');
        ctrlRow.append(this._enableBtn, ctrlStop);
        this._ctrlBox.append(ctrlRow);
        this._gspeed = slider('glob spd', 0, 1, 0.01, 1, () => {});
        this._gspeed.row.querySelector('input').addEventListener('change', (e) => this._setGlobalSpeed(+e.target.value));
        this._ctrlBox.append(this._gspeed.row);
        root.append(this._ctrlBox);
        this._enableBtn.addEventListener('click', () => this._control('enable'));
        ctrlStop.addEventListener('click', () => this._control('stop'));

        // --- Waypoints → Flow (needs client) ---
        this._wpBox = el('div');
        this._wpBox.append(sectionTitle('Waypoints → Flow'));
        this._wpCount = el('div', 'opacity:.8;margin-bottom:4px;', '0 captured');
        this._wpBox.append(this._wpCount);
        const wpRow = el('div', 'display:flex;gap:6px;');
        const capBtn = el('button', BTN + 'flex:1;', 'Capture pose');
        const clrBtn = el('button', BTN, 'Clear');
        wpRow.append(capBtn, clrBtn);
        this._wpBox.append(wpRow);
        const nameRow = el('div', 'display:flex;gap:6px;align-items:center;margin-top:6px;');
        nameRow.append(el('span', 'opacity:.8;', 'name'));
        this._flowName = el('input', 'flex:1;background:rgba(255,255,255,0.08);color:#e6edf3;border:1px solid rgba(255,255,255,0.15);border-radius:5px;padding:3px 6px;font:inherit;');
        this._flowName.value = 'Viewer Flow';
        nameRow.append(this._flowName);
        this._wpBox.append(nameRow);
        const pushRow = el('div', 'display:flex;gap:6px;margin-top:6px;');
        const pushBtn = el('button', BTN + 'flex:1;', 'Push Flow');
        const runBtn = el('button', BTN + 'border-color:#3fb950;flex:1;', 'Push & Run');
        pushRow.append(pushBtn, runBtn);
        this._wpBox.append(pushRow);
        root.append(this._wpBox);
        capBtn.addEventListener('click', () => this._capture());
        clrBtn.addEventListener('click', () => this._clearWaypoints());
        pushBtn.addEventListener('click', () => this._pushFlow(false));
        runBtn.addEventListener('click', () => this._pushFlow(true));

        // --- Jog (needs client; press-and-hold per joint, requires JOGGING/TEACH mode) ---
        this._jogBox = el('div');
        this._jogBox.append(sectionTitle('Jog (hold)'));
        this._jogSpeed = slider('speed', 0.01, 1, 0.01, 0.1);
        this._jogBox.append(this._jogSpeed.row);
        this._jogRows = el('div');
        this._jogBox.append(this._jogRows);
        root.append(this._jogBox);

        // Hide robot-only sections without a client.
        if (!this.client) {
            this._sendBox.style.display = 'none';
            this._ctrlBox.style.display = 'none';
            this._wpBox.style.display = 'none';
            this._jogBox.style.display = 'none';
        }

        document.body.appendChild(root);
        this.root = root;
        makeDraggable(root, title);
        this._teachVisible(false);
    }

    // --- status ---------------------------------------------------------
    setWs(connected) {
        this._wsDot.style.cssText = dot(connected ? SEVERITY_COLOR.ok : SEVERITY_COLOR.err);
        this._wsTxt.textContent = connected ? 'WS live' : 'WS down';
    }
    setApi(reachable) {
        this._apiDot.style.cssText = dot(reachable ? SEVERITY_COLOR.ok : SEVERITY_COLOR.err);
        this._apiTxt.textContent = reachable ? 'API ok' : 'API err';
    }
    setStates(patch) {
        Object.assign(this.states, patch);
        this._renderStates();
    }
    _stateLine(node, name, map, code) {
        const [text, sev] = label(map, code);
        node.innerHTML = `<span style="${dot(SEVERITY_COLOR[sev])}"></span>${name}: ${text}`;
    }
    _renderStates() {
        this._stateLine(this._robotLine, 'Robot', ROBOT_STATE, this.states.robotState);
        this._stateLine(this._modeLine, 'Mode', OPERATION_MODE, this.states.operationMode);
        this._stateLine(this._safetyLine, 'Safety', SAFETY_STATE, this.states.safetyState);
        const teachable = canTeach(this.states.operationMode, this.states.safetyState);
        if (this._sendBtn) {
            this._sendBtn.style.borderColor = teachable ? '#2f81f7' : '#d29922';
            this._sendBtn.title = teachable ? 'Send the previewed joint pose' : 'Robot not in TEACH mode';
        }
    }

    // --- teach ----------------------------------------------------------
    _teachVisible(on) {
        this._moveBtn.style.display = on ? 'inline-block' : 'none';
        this._rotBtn.style.display = on ? 'inline-block' : 'none';
        this._sendBox.style.display = on && this.client ? 'block' : 'none';
        this._ik.style.display = on ? 'block' : 'none';
        this._teachBtn.textContent = `Teach: ${on ? 'ON' : 'OFF'}`;
        this._teachBtn.style.background = on ? '#238636' : 'rgba(255,255,255,0.06)';
    }
    _toggleTeach() {
        if (!this.teach) return;
        const on = !this.teach.enabled;
        this.teach.setEnabled(on);
        this._teachVisible(on);
        if (on) this._setMode(this.teach.mode);
    }
    _setMode(mode) {
        this._moveBtn.style.background = mode === 'translate' ? '#1f6feb' : 'rgba(255,255,255,0.06)';
        this._rotBtn.style.background = mode === 'rotate' ? '#1f6feb' : 'rgba(255,255,255,0.06)';
    }
    _setIk(res) {
        this._ik.textContent = res.converged
            ? `IK ok · ${res.iters} it · ${(res.posErr * 1000).toFixed(1)} mm / ${(res.rotErr * 180 / Math.PI).toFixed(1)}°`
            : `IK best-effort · ${(res.posErr * 1000).toFixed(0)} mm / ${(res.rotErr * 180 / Math.PI).toFixed(0)}°`;
    }

    // --- robot commands -------------------------------------------------
    async _send() {
        if (!this.client || !this.teach) return;
        const deg = this.teach.currentAnglesDeg();
        const v = this._vel.get(), a = this._acc.get(), appr = +this._appr.value;
        if (!window.confirm(`Send joint move to the robot?\n\n[${deg.map((d) => d.toFixed(1)).join(', ')}] °\nvelocity ${v}, accel ${a}, ${appr === 1 ? 'PTP' : 'Linear'}\n\nThe real robot will move.`)) return;
        this._ik.textContent = 'sending move…';
        try {
            await this.client.moveJointAngles(deg, { velocity: v, acceleration: a, approachMode: appr });
            this.setApi(true);
            this._ik.textContent = 'move sent ✓';
        } catch (e) {
            this.setApi(false);
            this._ik.textContent = `send failed: ${e.message}`;
        }
    }
    async _control(kind) {
        if (!this.client) return;
        try {
            if (kind === 'enable') await this.client.setDesiredRobotState(2);
            else if (kind === 'stop') await this.client.stop();
            this.setApi(true);
            this._ik.textContent = `${kind} ✓`;
        } catch (e) {
            this.setApi(false);
            this._ik.textContent = `${kind} failed: ${e.message}`;
        }
    }
    async _setGlobalSpeed(v) {
        if (!this.client) return;
        try { await this.client.setGlobalSpeed(v); this.setApi(true); }
        catch (e) { this.setApi(false); this._ik.textContent = `speed failed: ${e.message}`; }
    }
    async _pingApi() {
        try { await this.client.getRobotConfig(); this.setApi(true); }
        catch { this.setApi(false); }
    }

    // --- waypoints / flow ----------------------------------------------
    _capture() {
        if (!this.teach) return;
        this._waypoints.push({ anglesDeg: this.teach.currentAnglesDeg(), name: `P${this._waypoints.length + 1}` });
        this._wpCount.textContent = `${this._waypoints.length} captured`;
        this._ik.textContent = `captured P${this._waypoints.length}`;
    }
    _clearWaypoints() {
        this._waypoints = [];
        this._wpCount.textContent = '0 captured';
    }
    async _pushFlow(run) {
        if (!this.client) return;
        if (this._waypoints.length === 0) { this._ik.textContent = 'no waypoints captured'; return; }
        const flow = buildJointFlow(this._flowName.value || 'Viewer Flow', this._waypoints, {
            velocity: this._vel.get(), acceleration: this._acc.get(),
        });
        this._ik.textContent = run ? 'pushing & running flow…' : 'pushing flow…';
        try {
            const created = await this.client.createFlow(flow);
            this.setApi(true);
            const uuid = created?.uuid ?? created?.id;
            if (run) {
                if (!window.confirm(`Run flow "${flow.name}" (${this._waypoints.length} waypoints)?\nThe real robot will move.`)) {
                    this._ik.textContent = `flow created (not run): ${uuid?.slice(0, 8) || ''}`;
                    return;
                }
                await this.client.runFlow(uuid);
                this._ik.textContent = 'flow running ✓';
            } else {
                this._ik.textContent = `flow created ✓ ${uuid?.slice(0, 8) || ''}`;
            }
        } catch (e) {
            this.setApi(false);
            this._ik.textContent = `flow failed: ${e.message}`;
        }
    }

    dispose() {
        this._jogStop();
        this.root?.remove();
    }
}
