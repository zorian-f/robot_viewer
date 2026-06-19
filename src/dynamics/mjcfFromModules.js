/**
 * Generate a dynamics-only MuJoCo MJCF from RobCo module descriptors.
 *
 * We only need mass / inertia / kinematics for inverse dynamics — no visual meshes
 * (three.js already renders those). The body tree mirrors RobCo's proximal -> shaft ->
 * distal assembly: each module is welded to the previous module's distal frame; Drive /
 * BaseDrive modules carry a hinge joint about the distal frame's local Z. A payload body
 * is welded at the flange.
 *
 * Pure (no THREE / DOM) so it is unit-testable in Node. Descriptors must be in chain order
 * (base -> flange, clamps included). All SI: metres, kg, kg·m², radians.
 */

const DRIVE_TYPES = new Set(['Drive', 'BaseDrive']);

const fmt = (n) => (Math.abs(n) < 1e-12 ? '0' : Number(n.toFixed(9)).toString());
const vec = (a) => a.map(fmt).join(' ');

/**
 * Decompose a 4x4 rigid transform (row-major nested rows) into MuJoCo pos + quat (w x y z).
 * @param {number[][]|null} m
 * @returns {{pos:number[], quat:number[]}}
 */
export function decompose(m) {
    if (!m) return { pos: [0, 0, 0], quat: [1, 0, 0, 0] };
    const pos = [m[0][3], m[1][3], m[2][3]];
    const r00 = m[0][0], r01 = m[0][1], r02 = m[0][2];
    const r10 = m[1][0], r11 = m[1][1], r12 = m[1][2];
    const r20 = m[2][0], r21 = m[2][1], r22 = m[2][2];
    const tr = r00 + r11 + r22;
    let w, x, y, z;
    if (tr > 0) {
        const s = Math.sqrt(tr + 1) * 2;
        w = 0.25 * s; x = (r21 - r12) / s; y = (r02 - r20) / s; z = (r10 - r01) / s;
    } else if (r00 > r11 && r00 > r22) {
        const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
        w = (r21 - r12) / s; x = 0.25 * s; y = (r01 + r10) / s; z = (r02 + r20) / s;
    } else if (r11 > r22) {
        const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
        w = (r02 - r20) / s; x = (r01 + r10) / s; y = 0.25 * s; z = (r12 + r21) / s;
    } else {
        const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
        w = (r10 - r01) / s; x = (r02 + r20) / s; y = (r12 + r21) / s; z = 0.25 * s;
    }
    return { pos, quat: [w, x, y, z] };
}

function inertialXml(mass, inertia, com) {
    if (!mass || mass <= 0) return '';
    const p = com || [0, 0, 0];
    let inertiaAttr;
    if (inertia && inertia.length === 3) {
        // MuJoCo fullinertia order: ixx iyy izz ixy ixz iyz
        inertiaAttr = `fullinertia="${vec([
            inertia[0][0], inertia[1][1], inertia[2][2],
            inertia[0][1], inertia[0][2], inertia[1][2],
        ])}"`;
    } else {
        inertiaAttr = 'diaginertia="1e-6 1e-6 1e-6"';
    }
    return `<inertial pos="${vec(p)}" mass="${fmt(mass)}" ${inertiaAttr}/>`;
}

/**
 * @param {Object[]} descriptors - per-module JSON descriptors, base->flange (clamps included).
 * @param {Object} [opts]
 * @param {number} [opts.payloadMass=0] - TCP payload mass (kg).
 * @param {number[]} [opts.payloadCom=[0,0,0]] - payload CoM in the flange frame (m).
 * @param {number[]} [opts.gravity=[0,0,-9.81]]
 * @returns {{xml:string, jointNames:string[]}} MJCF and the hinge joint names base->flange.
 */
export function mjcfFromModules(descriptors, opts = {}) {
    const payloadMass = opts.payloadMass ?? 0;
    const payloadCom = opts.payloadCom ?? [0, 0, 0];
    const gravity = opts.gravity ?? [0, 0, -9.81];
    const jointNames = [];

    // Inner-most content, welded at the flange of the last module: a TCP site (for FK /
    // Jacobian / IK) plus an optional payload body.
    let inner = '';
    if (opts.tcpSite !== false) {
        inner += `<site name="tcp" pos="${vec(opts.tcpOffset || [0, 0, 0])}" size="0.01"/>`;
    }
    if (payloadMass > 0) {
        inner += `<body name="payload">${inertialXml(payloadMass, null, payloadCom)}</body>`;
    }

    for (let i = descriptors.length - 1; i >= 0; i--) {
        const d = descriptors[i] || {};
        const dyn = d.dynamics || {};
        const kin = d.kinematics || {};
        const isDrive = DRIVE_TYPES.has(d['module-type']);

        const P = decompose(kin.proximal_transformation);
        const D = isDrive ? decompose(kin.distal_transformation) : { pos: [0, 0, 0], quat: [1, 0, 0, 0] };

        const proxInertial = inertialXml(dyn.proximal_mass, dyn.proximal_inertia, dyn.proximal_center_of_mass);
        const distInertial = isDrive
            ? inertialXml(dyn.distal_mass, dyn.distal_inertia, dyn.distal_center_of_mass)
            : '';

        let jointXml = '';
        if (isDrive) {
            const jn = `j${i}`;
            jointNames.push(jn);
            // limited="false": inverse dynamics should not include joint-limit forces.
            jointXml = `<joint name="${jn}" type="hinge" axis="0 0 1" limited="false"/>`;
        }

        inner =
            `<body name="b${i}_prox">${proxInertial}` +
            `<body name="b${i}_shaft" pos="${vec(P.pos)}" quat="${vec(P.quat)}">` +
            `<body name="b${i}_distal" pos="${vec(D.pos)}" quat="${vec(D.quat)}">` +
            `${jointXml}${distInertial}${inner}` +
            `</body></body></body>`;
    }

    const xml =
        `<mujoco model="robco">` +
        `<compiler angle="radian"/>` +
        `<option gravity="${vec(gravity)}"/>` +
        `<worldbody>${inner}</worldbody>` +
        `</mujoco>`;

    // jointNames were collected flange->base; reverse to base->flange (matches jointAngles).
    return { xml, jointNames: jointNames.reverse() };
}
