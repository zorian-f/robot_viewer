/**
 * Live RobFlow session -> viewer bridge (P3).
 *
 * Opens the /robot WebSocket, builds the robot once `robotModuleIds` arrives, hands it to
 * the viewer's display path, then mirrors `jointAngles` (and `baseShift`) live.
 */
import { resolveSession } from '../transport/session.js';
import { RobFlowSocket } from '../transport/RobFlowSocket.js';
import { RobFlowClient } from '../transport/RobFlowClient.js';
import { FrequencyMeter } from '../transport/FrequencyMeter.js';
import { StreamRatePanel } from './StreamRatePanel.js';
import { RobCoModuleAdapter } from '../adapters/RobCoModuleAdapter.js';
import { applyAnglesDeg, applyBaseShift } from './poseUtils.js';
import { DynamicsController } from '../dynamics/DynamicsController.js';
import { TeachPendant } from './TeachPendant.js';
import { RobFlowToolsPanel } from './RobFlowToolsPanel.js';

const redactSid = (url) => url.replace(/session\/ws\/[^/]+/, 'session/ws/<SID>');

/**
 * @param {Object} app - the viewer App instance (needs app.fileHandler.onModelLoaded).
 * @param {Object} opts - passed to resolveSession ({sid} for cloud, {host,port} for local).
 * @returns {Promise<RobFlowSocket>}
 */
export async function connectLiveSession(app, opts) {
    const session = resolveSession(opts);
    console.log(`[RobCo] live ${session.mode} connect: ${redactSid(session.wsUrl)}`);

    const client = new RobFlowClient(session.restBase, { token: opts.token });
    const panel = new RobFlowToolsPanel(app, { client });
    const socket = new RobFlowSocket(session.wsUrl);

    // Stream-rate meter: timestamp every frame off the socket (with event.timeStamp), measure
    // the jointAngles push cadence. Tap is passive — never touches the per-type handlers.
    const meter = new FrequencyMeter({ type: 'jointAngles', sampleSize: 300, warmup: 20 });
    socket.addTap((type, data, ts, recvNow) => meter.tick(type, data, ts, recvNow));
    StreamRatePanel.ensure(meter);
    app._robcoStreamMeter = meter;
    let model = null;
    let building = false;
    let latestAngles = null;
    let latestBaseShift = null;
    let dynamics = null;
    let teach = null;
    let pendingPayload = null;

    socket.on('robotModuleIds', async (ids) => {
        if (model || building) return; // build once; rebuild-on-change can come later
        building = true;
        try {
            console.log(`[RobCo] building live robot from ${ids.length} module ids`);
            model = await RobCoModuleAdapter.build({
                baseUrl: session.modulesBase,
                moduleIds: ids,
            });
            app.fileHandler.onModelLoaded(model, { name: 'robco-live.robco' });
            if (latestBaseShift) applyBaseShift(model, latestBaseShift);
            if (latestAngles) applyAnglesDeg(model, latestAngles);
            console.log(
                `[RobCo] live robot ready: ${model.links.size} links, ${model.joints.size} joints`,
            );
            try {
                const { enhanceVisuals } = await import('./enhanceVisuals.js');
                await enhanceVisuals(model, app.sceneManager);
            } catch (e) { console.warn('[RobCo] enhanceVisuals failed:', e); }

            // Live dynamics dashboard (torque/utilization each frame).
            try {
                dynamics = await DynamicsController.attach(model);
                if (dynamics && pendingPayload) {
                    dynamics.setPayload(pendingPayload.mass, pendingPayload.com);
                }
                if (dynamics && latestAngles) dynamics.update(latestAngles, performance.now());
            } catch (e) {
                console.error('[RobCo] dynamics dashboard failed:', e);
            }

            // Teach pendant (drag gizmo -> IK preview). Pauses the mirror while teaching.
            try {
                teach = await TeachPendant.attach(app, model);
                panel.setTeach(teach);
                // While posing with the gizmo, the dynamics panel follows the previewed pose.
                if (teach) teach.onPose = (deg) => dynamics?.updateStatic(deg);
            } catch (e) {
                console.error('[RobCo] teach pendant failed:', e);
            }
        } catch (err) {
            console.error('[RobCo] live build failed:', err);
            building = false;
        }
    });

    socket.on('jointAngles', (angles) => {
        latestAngles = angles;
        // Pause the mirror while teaching so dragging isn't fought by incoming angles.
        if (model && !app._teachActive) applyAnglesDeg(model, angles);
        // While teaching, the dynamics panel follows the gizmo (updateStatic), not the stream.
        if (dynamics && !app._teachActive) dynamics.update(angles, performance.now());
        if (teach) teach.syncTcp();
    });

    socket.on('baseShift', (bs) => {
        latestBaseShift = bs;
        if (model) applyBaseShift(model, bs);
    });

    socket.on('payload', (p) => {
        // Only apply a real robot payload (mass > 0). A zero/absent robot payload must NOT
        // overwrite the user's manually-set TCP load (persisted in the dynamics panel and
        // re-applied on attach) — otherwise every (re)connect wipes it and it has to be
        // re-entered by hand after each reload.
        if (!p || !(p.mass > 0)) return;
        // RobFlow payload: mass (kg) + centerOfMass. CoM assumed metres in the flange frame.
        const com = p.centerOfMass || [0, 0, 0];
        if (dynamics) dynamics.setPayload(p.mass, com);
        else pendingPayload = { mass: p.mass, com };
    });

    socket.on('robotState', (d) => panel.setStates({ robotState: d }));
    socket.on('operationMode', (d) => panel.setStates({ operationMode: d }));
    socket.on('safetyState', (d) => panel.setStates({ safetyState: d }));
    socket.onStatus((state) => {
        panel.setWs(state === 'open');
        // Don't average a connection gap into the rate; resume cleanly on (re)connect.
        meter.breakGap();
    });

    socket.connect();
    app._robflowSocket = socket; // keep a handle for teardown/debugging
    return socket;
}
