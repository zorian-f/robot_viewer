/**
 * Dev entry points for the RobCo pipeline, selected via a `?robco=` query param:
 *
 *   ?robco=fixtures                 -> bundled samples in /robco-fixtures (offline, single D86)
 *   ?robco=fixtures&ids=0001,0005   -> custom module-id chain from fixtures
 *   ?robco=live                     -> captured demo arm, built static from the public CDN
 *   ?robco=<robot_modules_url>&ids= -> any geometry base URL + id chain (static)
 *   ?robco=session&sid=<SID>        -> LIVE: connect WS, build from robotModuleIds, mirror angles
 *   ?robco=local&host=<ip>&port=8000 -> LIVE against a local robot
 *
 * Static builds go through RobCoModuleAdapter; live modes go through connectLiveSession.
 */
import { RobCoModuleAdapter } from '../adapters/RobCoModuleAdapter.js';
import { connectLiveSession } from './liveConnect.js';
import { applyAnglesDeg } from './poseUtils.js';

// RobCo's public geometry CDN (Access-Control-Allow-Origin: *), no session/auth needed.
const PUBLIC_MODULES_CDN = 'https://robco.studio/modules';

// A real 6-DOF demo arm captured from a live session's `robotModuleIds` (clamps included;
// the adapter drops them). Posed to the streamed jointAngles for a lifelike preview.
const LIVE_ROBOT = {
    ids: [
        '0305', '8009', '0302', '8009', '0326', '8008', '0301', '8008', '0301',
        '8008', '0315', '8007', '0300', '8007', '0300', '8007', '1000',
    ],
    anglesDeg: [0, 45, -90, 0, 0, 0],
};

function parseIds(csv, fallback) {
    if (!csv) return fallback;
    return csv.split(',').map((s) => s.trim()).filter(Boolean);
}

export async function maybeLoadRobCo(app) {
    const params = new URLSearchParams(location.search);
    if (!params.has('robco')) return;
    const mode = params.get('robco');

    // --- Live modes -------------------------------------------------------
    if (mode === 'session') {
        const sid = params.get('sid');
        if (!sid) return console.error('[RobCo] ?robco=session requires &sid=<SID>');
        return connectLiveSession(app, {
            sid,
            token: params.get('token') || undefined,
            modulesBase: params.get('base') || undefined,
        });
    }
    if (mode === 'local') {
        return connectLiveSession(app, {
            host: params.get('host') || 'localhost',
            port: Number(params.get('port') || 8000),
            secure: params.get('secure') === '1',
            token: params.get('token') || undefined,
        });
    }

    // --- Static builds ----------------------------------------------------
    let baseUrl;
    let ids;
    let anglesDeg = null;
    if (mode === 'live') {
        baseUrl = params.get('base') || PUBLIC_MODULES_CDN;
        ids = parseIds(params.get('ids'), LIVE_ROBOT.ids);
        anglesDeg = LIVE_ROBOT.anglesDeg;
    } else {
        baseUrl = !mode || mode === 'fixtures' ? '/robco-fixtures' : mode;
        ids = parseIds(params.get('ids'), ['0001']);
    }

    console.log(`[RobCo] building robot ${JSON.stringify(ids)} from ${baseUrl}`);
    try {
        const model = await RobCoModuleAdapter.build({ baseUrl, moduleIds: ids });
        if (anglesDeg) applyAnglesDeg(model, anglesDeg);
        app.fileHandler.onModelLoaded(model, { name: 'robco-robot.robco' });
        console.log(
            `[RobCo] loaded: ${model.links.size} links, ${model.joints.size} joints`,
            model.userData.jointOrder,
        );

        // Dynamics dashboard (static pose -> static gravity torques).
        try {
            const { DynamicsController } = await import('../dynamics/DynamicsController.js');
            const ctrl = await DynamicsController.attach(model);
            if (ctrl) {
                const a = anglesDeg || (model.userData.jointOrder || []).map(() => 0);
                ctrl.update(a, performance.now());
                window._robcoDynamics = ctrl;
            }
        } catch (e) {
            console.error('[RobCo] dynamics dashboard failed:', e);
        }

        // Teach pendant (drag the TCP gizmo -> IK preview). Off until the button is clicked.
        try {
            const { TeachPendant } = await import('./TeachPendant.js');
            const teach = await TeachPendant.attach(app, model);
            if (teach) window._robcoTeach = teach;
        } catch (e) {
            console.error('[RobCo] teach pendant failed:', e);
        }
    } catch (err) {
        console.error('[RobCo] load failed:', err);
    }
}
