/**
 * WaypointStore — the canonical set of teach waypoints + their 3D markers.
 *
 * A waypoint's source of truth is a **world-frame** TCP pose (so it stays fixed when the base
 * moves). Markers live under BaseFrame.worldGroup, so they automatically move with the world
 * when the base is repositioned. The base-frame pose used for IK / RobFlow push is derived on
 * demand via BaseFrame.worldToBase().
 *
 *   worldPose: { pos:[x,y,z] m, quat:[x,y,z,w] }   // worldGroup-local (Z-up)
 *   joints:    number[] (deg)                       // captured snapshot (IK seed + exact replay)
 *   groupId:   string|null                          // grouped waypoints push as one node
 */
import * as THREE from 'three';

const KEY = 'robco-waypoints';
const ONE = new THREE.Vector3(1, 1, 1);
let _seq = 0;

export class WaypointStore {
    static ensure(sm, baseFrame) {
        if (window._robcoWaypointStore) {
            window._robcoWaypointStore.attachTo(baseFrame);
            return window._robcoWaypointStore;
        }
        const s = new WaypointStore(sm, baseFrame);
        window._robcoWaypointStore = s;
        return s;
    }

    constructor(sm, baseFrame) {
        this.sm = sm;
        this.base = baseFrame;
        this.items = [];
        this.onChange = null; // () => void (panel re-render)

        this.group = new THREE.Group();
        this.group.name = 'robco-waypoints';
        baseFrame.attach(this.group);

        this._restore();
    }

    attachTo(baseFrame) {
        if (this.base === baseFrame) return;
        this.base = baseFrame;
        baseFrame.attach(this.group);
    }

    // --- mutate --------------------------------------------------------
    add(worldMatrix, jointsDeg, name) {
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        const s = new THREE.Vector3();
        worldMatrix.decompose(pos, quat, s);
        const item = {
            id: `wp${++_seq}`,
            name: name || `P${this.items.length + 1}`,
            groupId: null,
            worldPose: { pos: pos.toArray(), quat: quat.toArray() },
            joints: (jointsDeg || []).slice(),
            reachable: true,
        };
        item._marker = this._makeMarker(item);
        this.group.add(item._marker);
        this.items.push(item);
        this._persist();
        this._touch();
        return item;
    }

    remove(id) {
        const i = this.items.findIndex((w) => w.id === id);
        if (i < 0) return;
        const [it] = this.items.splice(i, 1);
        it._marker?.parent?.remove(it._marker);
        this._persist();
        this._touch();
    }

    clear() {
        this.items.forEach((it) => it._marker?.parent?.remove(it._marker));
        this.items = [];
        this._persist();
        this._touch();
    }

    rename(id, name) {
        const it = this.byId(id);
        if (it) { it.name = name; this._persist(); this._touch(); }
    }

    setVisible(on) {
        this.group.visible = on;
        this.sm.redraw?.();
    }

    isVisible() { return this.group.visible; }

    /** Assign a fresh group id to the given ids (grouped → one movement node on push). */
    groupItems(ids) {
        const gid = `g${++_seq}`;
        this.items.forEach((it) => { if (ids.includes(it.id)) it.groupId = gid; });
        this._persist();
        this._touch();
    }

    ungroupItems(ids) {
        this.items.forEach((it) => { if (ids.includes(it.id)) it.groupId = null; });
        this._persist();
        this._touch();
    }

    /** Ordered list of {groupId, items[]} — singletons get groupId null. */
    grouped() {
        const out = [];
        const byGid = new Map();
        for (const it of this.items) {
            if (it.groupId == null) { out.push({ groupId: null, items: [it] }); continue; }
            if (!byGid.has(it.groupId)) {
                const entry = { groupId: it.groupId, items: [] };
                byGid.set(it.groupId, entry);
                out.push(entry);
            }
            byGid.get(it.groupId).items.push(it);
        }
        return out;
    }

    // --- derive --------------------------------------------------------
    byId(id) { return this.items.find((w) => w.id === id); }

    worldMatrix(it) {
        const pos = new THREE.Vector3().fromArray(it.worldPose.pos);
        const quat = new THREE.Quaternion().fromArray(it.worldPose.quat);
        return new THREE.Matrix4().compose(pos, quat, ONE);
    }

    /** Base/robot-root-frame matrix for IK + RobFlow push (depends on current base pose). */
    baseMatrix(it) {
        return this.base.worldToBase(this.worldMatrix(it));
    }

    /** Base-frame cartesian pose for a RobFlow cartesianPose: position mm + orientation deg (XYZ euler). */
    cartesianBaseFrame(it) {
        const m = this.baseMatrix(it);
        const p = new THREE.Vector3().setFromMatrixPosition(m);
        const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromRotationMatrix(m), 'XYZ');
        const r = (v) => Math.round(v * 1000) / 1000;
        return {
            position: [r(p.x * 1000), r(p.y * 1000), r(p.z * 1000)],
            orientation: [r((e.x * 180) / Math.PI), r((e.y * 180) / Math.PI), r((e.z * 180) / Math.PI)],
        };
    }

    /** Recompute reachability of every waypoint at the current base via the teach pendant. */
    refreshReachability(teach) {
        if (!teach) return;
        for (const it of this.items) {
            it.reachable = teach.checkReachable(this.baseMatrix(it), it.joints);
            this._styleMarker(it);
        }
        this.sm.redraw?.();
        this._touch();
    }

    reachableCount() { return this.items.filter((w) => w.reachable).length; }

    select(id) {
        for (const it of this.items) this._styleMarker(it, it.id === id);
    }

    // --- markers -------------------------------------------------------
    _makeMarker(item) {
        const g = new THREE.Group();
        g.add(new THREE.AxesHelper(0.06));
        const dot = new THREE.Mesh(
            new THREE.SphereGeometry(0.012, 16, 12),
            new THREE.MeshBasicMaterial({ color: 0x2f81f7, depthTest: false, transparent: true }),
        );
        dot.renderOrder = 998;
        g.add(dot);
        g._dot = dot;
        const pos = new THREE.Vector3().fromArray(item.worldPose.pos);
        const quat = new THREE.Quaternion().fromArray(item.worldPose.quat);
        g.position.copy(pos);
        g.quaternion.copy(quat);
        item._marker = g;
        this._styleMarker(item);
        return g;
    }

    _styleMarker(item, selected = false) {
        const dot = item._marker?._dot;
        if (!dot) return;
        const color = !item.reachable ? 0xf85149 : selected ? 0xffd000 : 0x2f81f7;
        dot.material.color.setHex(color);
        dot.scale.setScalar(selected ? 1.6 : 1);
    }

    rebuildMarkers() {
        this.items.forEach((it) => {
            if (it._marker) it._marker.parent?.remove(it._marker);
            it._marker = this._makeMarker(it);
            this.group.add(it._marker);
        });
        this.sm.redraw?.();
    }

    // --- persistence ---------------------------------------------------
    _persist() {
        try {
            const data = this.items.map((it) => ({
                id: it.id, name: it.name, groupId: it.groupId,
                worldPose: it.worldPose, joints: it.joints,
            }));
            localStorage.setItem(KEY, JSON.stringify(data));
        } catch { /* ignore */ }
    }

    _restore() {
        try {
            const data = JSON.parse(localStorage.getItem(KEY));
            if (!Array.isArray(data)) return;
            for (const d of data) {
                const it = {
                    id: d.id || `wp${++_seq}`, name: d.name, groupId: d.groupId ?? null,
                    worldPose: d.worldPose, joints: d.joints || [], reachable: true,
                };
                const n = parseInt(String(it.id).replace(/\D/g, ''), 10);
                if (!Number.isNaN(n) && n > _seq) _seq = n;
                it._marker = this._makeMarker(it);
                this.group.add(it._marker);
                this.items.push(it);
            }
        } catch { /* ignore */ }
    }

    _touch() { try { this.onChange?.(); } catch (e) { console.warn('[RobCo] waypointStore.onChange:', e); } }
}
