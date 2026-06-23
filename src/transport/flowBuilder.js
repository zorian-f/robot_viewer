/**
 * Build a RobFlow v7.0.0 flow from captured joint waypoints.
 *
 * Port of RobFlowLink's flow builder: start → jointMovement(s) → stop, with VueFlow edges
 * (`vueflow__edge-{src}out-{tgt}in`). Proven to import + run against the RobCo backend.
 *
 * merged=true : one jointMovement node whose `movements[]` holds every pose (compact).
 * merged=false: one jointMovement node per pose, chained (visible sequence in the editor).
 * Angles are in DEGREES; velocity/acceleration are 0..1 fractions.
 */
const uuid = () =>
    (crypto.randomUUID
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
              const r = (Math.random() * 16) | 0;
              return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
          }));

function makeMovement(anglesDeg, velocity, acceleration, name = '') {
    return {
        name,
        pose: { jointAngles: anglesDeg },
        uuid: uuid(),
        valid: true,
        velocity,
        acceleration,
        approachMode: 1,
        blendingRadius: 0,
    };
}

function makeJointNode(id, label, repAngles, movements, velocity, acceleration, x) {
    return {
        id,
        type: 'jointMovement',
        parentNode: null,
        data: {
            name: label,
            pose: { jointAngles_: repAngles, poseVariableId: null, variableIndex_: null },
            valid: true,
            canBeSaved: true,
            validStates: { general: true },
            velocity,
            acceleration,
            approachMode: 1,
            blendingRadius: 0,
            movements,
        },
        position: { x, y: 0 },
    };
}

const edge = (src, tgt, handle = 'out') => ({
    id: `vueflow__edge-${src}${handle}-${tgt}in`,
    source: src,
    sourceHandle: handle,
    target: tgt,
});

/** Infinite loop entry node — its "loop" handle runs the body each iteration, forever. */
function loopNode(id, x) {
    return {
        id,
        type: 'loop',
        parentNode: null,
        data: {
            name: '',
            valid: true,
            infinite: true,
            canBeSaved: true,
            iterations: { dtype: 'integer', expressionRaw: '1', expressionProcessed: '1' },
        },
        position: { x, y: 0 },
    };
}

// Stamped on every variable we create so they're trivial to find & bulk-clean in RobFlow.
const ORRERIUM_TAG = { name: 'orrerium', color: '#8ACED8' };

// ---- Variable-bound waypoint flow (Phase 4) --------------------------------
// RobFlow variable types: jointPose (jointAngles[] deg) / cartesianPose (position xyz mm +
// orientation rx,ry,rz EULER deg). One variable per waypoint (no array type). A movement binds
// to its variable via pose.poseVariableId; the literal pose stays as a fallback. Grouped
// waypoints become ONE movement node with movements[]; ungrouped become one node each.

function protocolConfigs() {
    return {
        modbus: { enabled: false, dataType: '', readonly: false, bitAddress: 0, connectionId: null, updateFromModbus: false },
        profinet: { enabled: false, offsetPosition: 0, byteLength: 0, omitPlcUpdate: false },
    };
}

/**
 * The pose value stored in a jointPose / cartesianPose variable (and patched on override).
 * cartesian: position xyz mm + orientation rx,ry,rz EULER deg. joint: jointAngles[] deg.
 * @returns {object} a fresh value object (never mutates `it`).
 */
export function poseValue(mode, it) {
    return mode === 'cartesian'
        ? { poseVariableId: null, position: it.position, orientation: it.orientation }
        : { poseVariableId: null, jointAngles: it.joints };
}

/** EximJointPoseVariable / EximCartesianPoseVariable for a waypoint. */
function poseVariable(mode, name, varUuid, it) {
    const common = {
        conflictAction: null, name, description: '', uuid: varUuid,
        persistent: true, readonly: false, tags: [{ ...ORRERIUM_TAG }], syncToStudio: false,
        version: 'v7.1.7', problematic: false, protocolConfigs: protocolConfigs(),
    };
    const v = poseValue(mode, it);
    const dtype = mode === 'cartesian' ? 'cartesianPose' : 'jointPose';
    return { ...common, dtype, initialValue: v, currentValue: { ...v } };
}

/** One movement inside a movement node, bound to its pose variable. */
function poseMovement(mode, it, varUuid, velocity, acceleration) {
    const m = { name: it.name || '', uuid: uuid(), valid: true, velocity, acceleration, blendingRadius: 0 };
    if (mode === 'cartesian') {
        m.pose = { position: it.position, orientation: it.orientation, poseVariableId: varUuid };
    } else {
        m.approachMode = 1;
        m.pose = { jointAngles: it.joints, poseVariableId: varUuid };
    }
    return m;
}

function moveNode(mode, id, label, movements, x) {
    return {
        id,
        type: mode === 'cartesian' ? 'cartesianMovement' : 'jointMovement',
        parentNode: null,
        data: { name: label, valid: true, canBeSaved: true, movements },
        position: { x, y: 0 },
    };
}

const sanitize = (s) => String(s || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'wp';

/**
 * Build an importable EximFlow from grouped waypoints, each movement bound to a pose variable.
 * @param {string} name
 * @param {{label?:string, items:{id?:string, name?:string, joints?:number[], position?:number[], orientation?:number[]}[]}[]} groups
 *        groups[].items each carry joints (deg) for joint mode and/or position(mm)+orientation(deg) for cartesian.
 * @param {{mode?:'joint'|'cartesian', velocity?:number, acceleration?:number,
 *          flowUuid?:string, varUuidFor?:(key:string)=>string|undefined}} [opts]
 *        flowUuid / varUuidFor let the caller reuse stable ids across re-pushes (override support).
 * @returns {{flow:object, variableUuids:string[], varByKey:Record<string,string>}}
 *          flow (POST /flows/import), the per-waypoint variable uuids, and a waypoint-key → uuid map.
 */
export function buildWaypointFlow(name, groups, opts = {}) {
    const mode = opts.mode === 'cartesian' ? 'cartesian' : 'joint';
    const velocity = opts.velocity ?? 0.1;
    const acceleration = opts.acceleration ?? 0.1;
    const flowUuid = opts.flowUuid || uuid();
    const short = flowUuid.slice(0, 8);

    const variables = [];
    const variableUuids = [];
    const varByKey = {};
    const nodes = [{
        id: 'start', type: 'start', parentNode: null,
        data: { valid: true, validStates: { general: true } }, position: { x: 0, y: 0 },
    }];
    const edges = [];
    // Wrap the whole sequence in an infinite loop: start → loop, and the loop's "loop" (body)
    // handle drives the movement chain. No stop node — when the body chain ends, the loop just
    // repeats it forever.
    nodes.push(loopNode('loop', 380));
    edges.push(edge('start', 'loop'));
    let prev = 'loop';
    let prevHandle = 'loop'; // first body edge leaves the loop via its "loop" (body) handle
    let x = 760;
    let gIdx = 0;
    let wIdx = 0;

    for (const grp of groups) {
        const movements = grp.items.map((it) => {
            const key = it.id != null ? String(it.id) : `${wIdx}`;
            const varUuid = opts.varUuidFor?.(key) || uuid();
            const varName = `wp_${short}_${wIdx}_${sanitize(it.name)}`;
            variables.push(poseVariable(mode, varName, varUuid, it));
            variableUuids.push(varUuid);
            varByKey[key] = varUuid;
            wIdx += 1;
            return poseMovement(mode, it, varUuid, velocity, acceleration);
        });
        const id = `move-${gIdx}`;
        const label = grp.label || (grp.items.length > 1 ? `Group ${gIdx + 1}` : grp.items[0]?.name || `Move ${gIdx + 1}`);
        nodes.push(moveNode(mode, id, label, movements, x));
        edges.push(edge(prev, id, prevHandle));
        prev = id;
        prevHandle = 'out';
        x += 380;
        gIdx += 1;
    }
    // No stop / afterCompletion edge: the infinite loop re-runs the body chain.

    const flow = {
        name,
        uuid: flowUuid,
        version: 'v7.1.7',
        nodes,
        edges,
        groups: [],
        settings: {
            speed: 1.0,
            isHomePositionActive: false,
            homePosition: { poseVariableId: null, jointAngles: [] },
            description: `RobFlow Viewer — ${variableUuids.length} ${mode} waypoints in ${groups.length} node(s)`,
            environmentFile: null,
            environmentShift: [0, 0, 0, 0, 0, 0],
            environmentScale: 1,
            valid: true,
        },
        variables,
        subflows: [],
        modbusConnections: [],
        robVisionDeviceConnections: [],
        tools: [],
        workspaces: [],
        sqlConfigs: [],
        conflictAction: null,
        csvConfigs: [],
    };
    return { flow, variableUuids, varByKey };
}

/**
 * @param {string} name
 * @param {{anglesDeg:number[], name?:string}[]} waypoints
 * @param {{velocity?:number, acceleration?:number, merged?:boolean}} [opts]
 * @returns {object} RobFlow v7.0.0 flow dict
 */
export function buildJointFlow(name, waypoints, opts = {}) {
    const velocity = opts.velocity ?? 0.1;
    const acceleration = opts.acceleration ?? 0.1;
    const merged = opts.merged ?? true;

    const nodes = [{
        id: 'start', type: 'start', parentNode: null,
        data: { valid: true, validStates: { general: true } },
        position: { x: 0, y: 0 },
    }];
    const edges = [];
    let prev = 'start';
    let stopX;

    if (merged) {
        const movements = waypoints.map((w, i) =>
            makeMovement(w.anglesDeg, velocity, acceleration, w.name || `Pose ${i + 1}`));
        nodes.push(makeJointNode('move-0', name, waypoints[0].anglesDeg, movements, velocity, acceleration, 380));
        edges.push(edge('start', 'move-0'));
        prev = 'move-0';
        stopX = 760;
    } else {
        waypoints.forEach((w, i) => {
            const id = `move-${i}`;
            const label = w.name || `Pose ${i + 1}`;
            nodes.push(makeJointNode(id, label, w.anglesDeg,
                [makeMovement(w.anglesDeg, velocity, acceleration, label)],
                velocity, acceleration, (i + 1) * 380));
            edges.push(edge(prev, id));
            prev = id;
        });
        stopX = (waypoints.length + 1) * 380;
    }

    nodes.push({
        id: 'stop', type: 'stop', parentNode: null,
        data: { valid: true, validStates: { general: true } },
        position: { x: stopX, y: 0 },
    });
    edges.push(edge(prev, 'stop'));

    return {
        name,
        version: 'v7.0.0',
        nodes,
        edges,
        groups: [],
        settings: {
            speed: 1.0,
            isHomePositionActive: false,
            homePosition: { poseVariableId: null, jointAngles: [] },
            description: `Created from RobFlow Viewer — ${waypoints.length} waypoints`,
            environmentFile: null,
            environmentShift: [0, 0, 0, 0, 0, 0],
            environmentScale: 1,
            valid: true,
        },
        variables: [],
        subflows: [],
        modbusConnections: [],
        robVisionDeviceConnections: [],
        tools: [],
        workspaces: [],
        sqlConfigs: [],
        conflictAction: null,
        csvConfigs: [],
    };
}
