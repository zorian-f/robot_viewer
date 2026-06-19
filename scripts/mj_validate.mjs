// Validate inverse-dynamics torque via mujoco-js in Node.
// 1) Known-answer pendulum (1kg @ 1m horizontal -> 9.81 Nm).
// 2) The real arm from the public CDN at the streamed pose.
import { readFileSync } from 'node:fs';

const load_mujoco = (await import('mujoco-js/dist/mujoco_wasm.js')).default;
const mj = await load_mujoco();
try { mj.FS.mkdir('/working'); } catch {}
try { mj.FS.mount(mj.MEMFS, { root: '.' }, '/working'); } catch {}

let seq = 0;
function torquesFor(xml, qRad) {
    const path = `/working/m${seq++}.xml`;
    mj.FS.writeFile(path, xml);
    const model = mj.MjModel.loadFromXML(path);
    const data = new mj.MjData(model);
    mj.mj_resetData(model, data);
    for (let i = 0; i < qRad.length; i++) data.qpos[i] = qRad[i];
    // qvel/qacc remain 0 -> static (gravity) torque
    mj.mj_inverse(model, data);
    const tau = Array.from({ length: qRad.length }, (_, i) => data.qfrc_inverse[i]);
    data.delete?.(); model.delete?.();
    return tau;
}

// --- 1) pendulum -----------------------------------------------------------
const pend = `<mujoco model="p"><compiler angle="radian"/><option gravity="0 0 -9.81"/>
<worldbody><body name="l"><joint name="j0" type="hinge" axis="0 1 0"/>
<inertial pos="1 0 0" mass="1" diaginertia="1e-3 1e-3 1e-3"/></body></worldbody></mujoco>`;
const tPend = torquesFor(pend, [0]);
console.log(`pendulum hold torque = ${tPend[0].toFixed(3)} Nm  (expected ±9.81)`);

// --- 2) real arm -----------------------------------------------------------
const DRIVE = new Set(['Drive', 'BaseDrive']);
const fmt = (n) => (Math.abs(n) < 1e-12 ? '0' : Number(n.toFixed(9)).toString());
const vc = (a) => a.map(fmt).join(' ');
function decompose(m) {
    if (!m) return { pos: [0, 0, 0], quat: [1, 0, 0, 0] };
    const pos = [m[0][3], m[1][3], m[2][3]];
    const [r00, r01, r02] = m[0], [r10, r11, r12] = m[1], [r20, r21, r22] = m[2];
    const tr = r00 + r11 + r22; let w, x, y, z;
    if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = .25 * s; x = (r21 - r12) / s; y = (r02 - r20) / s; z = (r10 - r01) / s; }
    else if (r00 > r11 && r00 > r22) { const s = Math.sqrt(1 + r00 - r11 - r22) * 2; w = (r21 - r12) / s; x = .25 * s; y = (r01 + r10) / s; z = (r02 + r20) / s; }
    else if (r11 > r22) { const s = Math.sqrt(1 + r11 - r00 - r22) * 2; w = (r02 - r20) / s; x = (r01 + r10) / s; y = .25 * s; z = (r12 + r21) / s; }
    else { const s = Math.sqrt(1 + r22 - r00 - r11) * 2; w = (r10 - r01) / s; x = (r02 + r20) / s; y = (r12 + r21) / s; z = .25 * s; }
    return { pos, quat: [w, x, y, z] };
}
function inertial(mass, I, com) {
    if (!mass || mass <= 0) return '';
    const ia = I && I.length === 3
        ? `fullinertia="${vc([I[0][0], I[1][1], I[2][2], I[0][1], I[0][2], I[1][2]])}"`
        : 'diaginertia="1e-6 1e-6 1e-6"';
    return `<inertial pos="${vc(com || [0, 0, 0])}" mass="${fmt(mass)}" ${ia}/>`;
}
function mjcf(descs) {
    const jn = []; let inner = '';
    for (let i = descs.length - 1; i >= 0; i--) {
        const d = descs[i], dyn = d.dynamics || {}, kin = d.kinematics || {};
        const drive = DRIVE.has(d['module-type']);
        const P = decompose(kin.proximal_transformation);
        const D = drive ? decompose(kin.distal_transformation) : { pos: [0, 0, 0], quat: [1, 0, 0, 0] };
        const pj = drive ? (jn.push(`j${i}`), `<joint name="j${i}" type="hinge" axis="0 0 1" limited="false"/>`) : '';
        inner = `<body name="b${i}p">${inertial(dyn.proximal_mass, dyn.proximal_inertia, dyn.proximal_center_of_mass)}`
            + `<body name="b${i}s" pos="${vc(P.pos)}" quat="${vc(P.quat)}">`
            + `<body name="b${i}d" pos="${vc(D.pos)}" quat="${vc(D.quat)}">`
            + `${pj}${drive ? inertial(dyn.distal_mass, dyn.distal_inertia, dyn.distal_center_of_mass) : ''}${inner}`
            + `</body></body></body>`;
    }
    return { xml: `<mujoco model="r"><compiler angle="radian"/><option gravity="0 0 -9.81"/><worldbody>${inner}</worldbody></mujoco>`, jointNames: jn.reverse() };
}

const ids = ['0305', '8009', '0302', '8009', '0326', '8008', '0301', '8008', '0301', '8008', '0315', '8007', '0300', '8007', '0300', '8007', '1000'];
const map = JSON.parse(readFileSync('C:/Users/zeili/OneDrive/Dokumente/VSC/robot_viewer/public/robco-fixtures/module_folder_mapping.json', 'utf8'));
const cache = {};
const descs = [];
for (const id of ids) {
    const e = map[id];
    if (!cache[id]) cache[id] = await (await fetch(`https://robco.studio/modules/${e.folderName}/${e.fileName}`)).json();
    descs.push(cache[id]);
}
const { xml, jointNames } = mjcf(descs);
const peak = descs.filter((d) => DRIVE.has(d['module-type'])).map((d) => d.module_properties?.peak_torque ?? null);
const poseDeg = [0, 45, -90, 0, 0, 0];
const tau = torquesFor(xml, poseDeg.map((d) => d * Math.PI / 180));
console.log(`\narm joints: ${jointNames.length}, pose ${JSON.stringify(poseDeg)} deg`);
tau.forEach((t, i) => {
    const pk = peak[i];
    console.log(`  J${i + 1}: torque ${t.toFixed(2).padStart(8)} Nm   peak ${pk}   util ${pk ? (Math.abs(t) / pk * 100).toFixed(1) + '%' : 'n/a'}`);
});
