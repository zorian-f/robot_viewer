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

const edge = (src, tgt) => ({
    id: `vueflow__edge-${src}out-${tgt}in`,
    source: src,
    sourceHandle: 'out',
    target: tgt,
});

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
