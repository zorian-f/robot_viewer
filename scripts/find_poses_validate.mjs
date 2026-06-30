// Validate the "find different poses for a given TCP" enumeration headlessly (Node, mujoco-js).
//
// Mirrors TeachPendant.findConfigurationsForMatrix: solve DLS IK from a spread of structured +
// seeded-random seeds, de-duplicate converged solutions by wrap-aware joint distance, and assert
// that every returned configuration reaches the SAME TCP and that the branches are distinct.
import { readFileSync } from 'node:fs';
const load = (await import('mujoco-js/dist/mujoco_wasm.js')).default;
const mj = await load();
try { mj.FS.mkdir('/working'); } catch {}
try { mj.FS.mount(mj.MEMFS, { root: '.' }, '/working'); } catch {}

const DRIVE = new Set(['Drive', 'BaseDrive']);
const LIMIT_DEG = 270; // ROBCO_AXIS_LIMIT_DEG
const LIMIT_RAD = LIMIT_DEG * Math.PI / 180;
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
// Same DLS solver as the app, with the ±270° joint clamp MujocoKinematics applies.
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
        const sn = norm(dq), sc = sn > maxStep ? maxStep / sn : 1; for (let c = 0; c < nq; c++) q[c] = clamp(q[c] + dq[c] * sc, -LIMIT_RAD, LIMIT_RAD); }
    return { q, pe, re, iter, ok: pe < 1e-3 && re < 5e-3 };
}

// --- enumeration (mirrors TeachPendant) ------------------------------------
const angDiffDeg = (a, b) => Math.abs(((a - b + 180) % 360 + 360) % 360 - 180);
const maxAbs = (arr) => arr.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function structuredSeeds(curDeg) {
    const n = curDeg.length;
    const seeds = [curDeg, new Array(n).fill(0), Array.from({ length: n }, (_, i) => (i % 2 ? 90 : -90)), Array.from({ length: n }, (_, i) => (i % 2 ? -120 : 60))];
    for (let j = 0; j < n; j++) { const s = curDeg.slice(); s[j] = -s[j]; seeds.push(s); }
    const a = curDeg.slice(); a[n - 1] += 180; seeds.push(a);
    const b = curDeg.slice(); b[n - 1] -= 180; seeds.push(b);
    return seeds;
}
function findConfigs(tPos, tMat, curDeg, { samples = 48, tol = 2.0 } = {}) {
    const hash = Math.round(tPos[0] * 1000) * 73856093 ^ Math.round(tPos[1] * 1000) * 19349663 ^ Math.round(tPos[2] * 1000) * 83492791;
    const prng = mulberry32(hash | 0);
    const seeds = structuredSeeds(curDeg);
    for (let s = 0; s < samples; s++) seeds.push(Array.from({ length: nq }, () => prng() * 2 * LIMIT_DEG - LIMIT_DEG));
    const accepted = [];
    for (const seedDeg of seeds) {
        const res = solveIK(tPos, tMat, seedDeg.map((d) => d * Math.PI / 180));
        if (!res.ok) continue;
        const deg = res.q.map((r) => r * 180 / Math.PI);
        let dup = false;
        for (const acc of accepted) { if (acc.deg.every((v, i) => angDiffDeg(v, deg[i]) < tol)) { if (maxAbs(deg) < maxAbs(acc.deg)) acc.deg = deg; dup = true; break; } }
        if (!dup) accepted.push({ deg, pe: res.pe, re: res.re });
    }
    return accepted.map((a) => ({ ...a, dist: a.deg.reduce((s, v, i) => s + angDiffDeg(v, curDeg[i]), 0), minMargin: LIMIT_DEG - maxAbs(a.deg) })).sort((x, y) => x.dist - y.dist);
}

// --- the test --------------------------------------------------------------
let failures = 0;
const assert = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'} — ${msg}`); if (!cond) failures++; };

const startDeg = [0, 30, -60, 20, 40, 10];          // a generic mid-workspace pose
const target = fk(startDeg.map((d) => d * Math.PI / 180));
console.log(`Arm: ${nq} drive(s). Target TCP from [${startDeg.join(', ')}]°: [${target.pos.map((v) => v.toFixed(3)).join(', ')}] m\n`);

const configs = findConfigs(target.pos, target.mat, [0, 0, 0, 0, 0, 0]); // search from home
console.log(`Found ${configs.length} distinct configuration(s):`);
for (const c of configs) console.log(`  Δ${Math.round(c.dist)}°  margin ${Math.round(c.minMargin)}°  [${c.deg.map((v) => v.toFixed(1)).join(', ')}]`);
console.log('');

assert(configs.length >= 2, `multiple branches found (${configs.length} ≥ 2) for a mid-workspace pose`);

let allReach = true, worstPos = 0, worstRot = 0;
for (const c of configs) {
    const f = fk(c.deg.map((d) => d * Math.PI / 180));
    const pe = norm(sub(f.pos, target.pos)) * 1000, re = norm(rotVec(f.mat, target.mat));
    worstPos = Math.max(worstPos, pe); worstRot = Math.max(worstRot, re);
    if (pe > 1.0 || re > 5e-3) allReach = false;
}
assert(allReach, `every configuration reaches the target TCP (worst ${worstPos.toFixed(2)} mm / ${worstRot.toFixed(4)} rad)`);

let distinct = true;
for (let i = 0; i < configs.length; i++) for (let j = i + 1; j < configs.length; j++) {
    if (configs[i].deg.every((v, k) => angDiffDeg(v, configs[j].deg[k]) < 2.0)) distinct = false;
}
assert(distinct, 'configurations are pairwise distinct (> 2° on at least one joint)');

const det = findConfigs(target.pos, target.mat, [0, 0, 0, 0, 0, 0]);
const stable = det.length === configs.length && det.every((c, i) => c.deg.every((v, k) => angDiffDeg(v, configs[i].deg[k]) < 1e-6));
assert(stable, 'enumeration is deterministic (same list on a repeat run)');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
