// Validate FK + DLS IK on the real arm via mujoco-js (Node, headless).
import { readFileSync } from 'node:fs';
const load = (await import('mujoco-js/dist/mujoco_wasm.js')).default;
const mj = await load();
try { mj.FS.mkdir('/working'); } catch {}
try { mj.FS.mount(mj.MEMFS, { root: '.' }, '/working'); } catch {}

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
    const ia = I && I.length === 3 ? `fullinertia="${vc([I[0][0], I[1][1], I[2][2], I[0][1], I[0][2], I[1][2]])}"` : 'diaginertia="1e-6 1e-6 1e-6"';
    return `<inertial pos="${vc(com || [0, 0, 0])}" mass="${fmt(mass)}" ${ia}/>`;
}
function mjcf(descs) {
    let inner = `<site name="tcp" pos="0 0 0" size="0.01"/>`;
    for (let i = descs.length - 1; i >= 0; i--) {
        const d = descs[i], dyn = d.dynamics || {}, kin = d.kinematics || {};
        const drive = DRIVE.has(d['module-type']);
        const P = decompose(kin.proximal_transformation);
        const D = drive ? decompose(kin.distal_transformation) : { pos: [0, 0, 0], quat: [1, 0, 0, 0] };
        const pj = drive ? `<joint name="j${i}" type="hinge" axis="0 0 1" limited="false"/>` : '';
        inner = `<body name="b${i}p">${inertial(dyn.proximal_mass, dyn.proximal_inertia, dyn.proximal_center_of_mass)}`
            + `<body name="b${i}s" pos="${vc(P.pos)}" quat="${vc(P.quat)}"><body name="b${i}d" pos="${vc(D.pos)}" quat="${vc(D.quat)}">`
            + `${pj}${drive ? inertial(dyn.distal_mass, dyn.distal_inertia, dyn.distal_center_of_mass) : ''}${inner}</body></body></body>`;
    }
    return `<mujoco model="r"><compiler angle="radian"/><option gravity="0 0 -9.81"/><worldbody>${inner}</worldbody></mujoco>`;
}

const ids = ['0305', '8009', '0302', '8009', '0326', '8008', '0301', '8008', '0301', '8008', '0315', '8007', '0300', '8007', '0300', '8007', '1000'];
const map = JSON.parse(readFileSync('C:/Users/zeili/OneDrive/Dokumente/VSC/robot_viewer/public/robco-fixtures/module_folder_mapping.json', 'utf8'));
const cache = {}; const descs = [];
for (const id of ids) { const e = map[id]; if (!cache[id]) cache[id] = await (await fetch(`https://robco.studio/modules/${e.folderName}/${e.fileName}`)).json(); descs.push(cache[id]); }
mj.FS.writeFile('/working/k.xml', mjcf(descs));
const model = mj.MjModel.loadFromXML('/working/k.xml');
const data = new mj.MjData(model);
const SITE = mj.mjtObj?.mjOBJ_SITE?.value ?? 6;
const sid = mj.mj_name2id(model, SITE, 'tcp');
const nq = descs.filter((d) => DRIVE.has(d['module-type'])).length;

const sub = (a, b) => a.map((v, i) => v - b[i]);
const norm = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function fk(q) { for (let i = 0; i < nq; i++) data.qpos[i] = q[i]; mj.mj_fwdPosition(model, data); const p = sid * 3, m = sid * 9; return { pos: [data.site_xpos[p], data.site_xpos[p + 1], data.site_xpos[p + 2]], mat: Array.from({ length: 9 }, (_, k) => data.site_xmat[m + k]) }; }
function rotVec(A, B) { const R = new Array(9); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R[3 * i + j] = B[3 * i] * A[3 * j] + B[3 * i + 1] * A[3 * j + 1] + B[3 * i + 2] * A[3 * j + 2]; const tr = R[0] + R[4] + R[8], ang = Math.acos(clamp((tr - 1) / 2, -1, 1)), ax = [R[7] - R[5], R[2] - R[6], R[3] - R[1]], s = Math.sin(ang); if (Math.abs(s) < 1e-9) return [0, 0, 0]; const k = ang / (2 * s); return [ax[0] * k, ax[1] * k, ax[2] * k]; }
function solveLin(A, b) { const n = b.length, M = A.map((r, i) => r.concat(b[i])); for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; if (Math.abs(M[p][c]) < 1e-12) return null;[M[c], M[p]] = [M[p], M[c]]; for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; } } return M.map((r, i) => r[n] / r[i]); }
function solveIK(tPos, tMat, q0) {
    const lambda = 0.08, maxStep = 0.25, rows = 6; let q = q0.slice(), pe = Infinity, re = 0, iter = 0;
    for (; iter < 100; iter++) {
        const cur = fk(q), ePos = sub(tPos, cur.pos), eRot = rotVec(cur.mat, tMat); pe = norm(ePos); re = norm(eRot);
        if (pe < 1e-3 && re < 5e-3) break;
        const err = ePos.concat(eRot), eps = 1e-6, J = Array.from({ length: rows }, () => new Array(nq).fill(0));
        for (let j = 0; j < nq; j++) { const qp = q.slice(); qp[j] += eps; const f = fk(qp), dp = sub(f.pos, cur.pos), dr = rotVec(cur.mat, f.mat); for (let r = 0; r < 3; r++) { J[r][j] = dp[r] / eps; J[r + 3][j] = dr[r] / eps; } }
        const JJt = Array.from({ length: rows }, (_, a) => Array.from({ length: rows }, (_, b) => { let s = 0; for (let c = 0; c < nq; c++) s += J[a][c] * J[b][c]; return s + (a === b ? lambda * lambda : 0); }));
        const y = solveLin(JJt, err); if (!y) break;
        const dq = new Array(nq).fill(0); for (let c = 0; c < nq; c++) { let s = 0; for (let a = 0; a < rows; a++) s += J[a][c] * y[a]; dq[c] = s; }
        const sn = norm(dq), sc = sn > maxStep ? maxStep / sn : 1; for (let c = 0; c < nq; c++) q[c] += dq[c] * sc;
    }
    return { q, pe, re, iter, ok: pe < 1e-3 && re < 5e-3 };
}

const home = [0, 45, -90, 0, 0, 0].map((d) => d * Math.PI / 180);
const target = fk(home);
console.log(`TCP at home pose: [${target.pos.map((v) => v.toFixed(3)).join(', ')}] m`);

// Test 1: reach the home pose from a zero seed.
let r = solveIK(target.pos, target.mat, [0, 0, 0, 0, 0, 0]);
let f = fk(r.q);
console.log(`\nTest1 reach-home from zero seed: ${r.ok ? 'CONVERGED' : 'failed'} in ${r.iter} iters`);
console.log(`  pos err ${(norm(sub(f.pos, target.pos)) * 1000).toFixed(2)} mm, rot err ${r.re.toFixed(4)} rad`);

// Test 2: reach a target shifted 8cm (+x, -z) from home.
const t2 = [target.pos[0] + 0.08, target.pos[1], target.pos[2] - 0.08];
r = solveIK(t2, target.mat, home);
f = fk(r.q);
console.log(`\nTest2 reach shifted target from home seed: ${r.ok ? 'CONVERGED' : 'failed'} in ${r.iter} iters`);
console.log(`  pos err ${(norm(sub(f.pos, t2)) * 1000).toFixed(2)} mm, rot err ${r.re.toFixed(4)} rad`);
console.log(`  solution deg: [${r.q.map((v) => (v * 180 / Math.PI).toFixed(1)).join(', ')}]`);
