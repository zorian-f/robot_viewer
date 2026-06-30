/**
 * TcpTrace — draws the path the tool-center-point sweeps as a polyline in space.
 *
 * While enabled, a timer samples the live TCP position (TeachPendant.tcpBaseMatrix() — the tool
 * tip when a tool offset is set) and appends it to a growing line, capturing motion from ANY
 * source (live stream, flow run, teach-gizmo drag, jog, FK joint drag) since they all just move
 * the model's joints and the sample re-runs FK each tick.
 *
 * Frame: points are taken in the robot-root/base frame and the line is parented to
 * model.threeObject. The RobCo base is pinned at the world origin (the environment moves, not the
 * robot), so the trace stays glued to the arm regardless of base placement or up-axis — no frame
 * conversion needed.
 *
 * Buffer: a preallocated Float32 position attribute with setDrawRange; at MAX_POINTS the oldest
 * point is dropped via copyWithin (cheap, keeps vertex draw order correct).
 */
import * as THREE from 'three';

const MAX_POINTS = 4000;     // ~4 m of path at the 1 mm sample threshold
const MIN_STEP_M = 0.001;    // skip samples that didn't move at least this far (no idle pile-up)
const SAMPLE_MS = 50;        // ~20 Hz
const TRACE_COLOR = 0x8aced8; // RobCo "Ocean Blue" accent — distinct from waypoint markers

export class TcpTrace {
    static ensure({ sm, model, teach }) {
        if (window._robcoTcpTrace) {
            window._robcoTcpTrace.repoint({ sm, model, teach });
            return window._robcoTcpTrace;
        }
        const t = new TcpTrace({ sm, model, teach });
        window._robcoTcpTrace = t;
        return t;
    }

    constructor({ sm, model, teach }) {
        this.sm = sm;
        this.model = model;
        this.teach = teach;
        this.enabled = false;
        this.line = null;
        this.positions = null;
        this.count = 0;
        this._last = null;   // THREE.Vector3 of the last appended point
        this._timer = null;
    }

    /** Re-point at a freshly (re)built robot: move the line under the new root and reset the path. */
    repoint({ sm, model, teach }) {
        const reparent = model && model !== this.model;
        this.sm = sm || this.sm;
        this.teach = teach || this.teach;
        if (reparent) {
            this.model = model;
            this.clear();
            if (this.line) {
                this.line.parent?.remove(this.line);
                this._root()?.add(this.line);
            }
        }
    }

    _root() {
        return this.model?.threeObject || null;
    }

    _ensureLine() {
        if (this.line) return this.line;
        const root = this._root();
        if (!root) return null;
        this.positions = new Float32Array(MAX_POINTS * 3);
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
        geom.setDrawRange(0, 0);
        const mat = new THREE.LineBasicMaterial({ color: TRACE_COLOR });
        this.line = new THREE.Line(geom, mat);
        this.line.name = 'robco-tcp-trace';
        this.line.frustumCulled = false;
        this.line.renderOrder = 5;
        root.add(this.line);
        return this.line;
    }

    /** Start / stop sampling. Lazily builds the line on first enable. */
    setEnabled(on) {
        this.enabled = !!on;
        if (this.enabled) {
            this._ensureLine();
            if (this.line) this.line.visible = true;
            this._sample(); // capture the current point immediately
            if (!this._timer) this._timer = setInterval(() => this._sample(), SAMPLE_MS);
        } else {
            this._stopTimer();
        }
        this.sm?.redraw?.();
    }

    /** Show / hide without losing the recorded path. */
    setVisible(on) {
        if (this.line) this.line.visible = !!on;
        this.sm?.redraw?.();
    }

    isVisible() {
        return !!this.line?.visible;
    }

    /** Wipe the recorded path (keeps the line object + sampling state). */
    clear() {
        this.count = 0;
        this._last = null;
        if (this.line) {
            this.line.geometry.setDrawRange(0, 0);
            this.line.geometry.attributes.position.needsUpdate = true;
        }
        this.sm?.redraw?.();
    }

    _stopTimer() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    /** Sample the current TCP position and append it if it moved far enough. */
    _sample() {
        if (!this.enabled || !this.teach) return;
        let p;
        try {
            p = new THREE.Vector3().setFromMatrixPosition(this.teach.tcpBaseMatrix());
        } catch (e) {
            return; // kinematics not ready / transient
        }
        if (this._last && p.distanceTo(this._last) < MIN_STEP_M) return;
        this._append(p);
    }

    _append(p) {
        const line = this._ensureLine();
        if (!line) return;
        if (this.count >= MAX_POINTS) {
            this.positions.copyWithin(0, 3); // drop the oldest point
            this.count = MAX_POINTS - 1;
        }
        const o = this.count * 3;
        this.positions[o] = p.x;
        this.positions[o + 1] = p.y;
        this.positions[o + 2] = p.z;
        this.count += 1;
        line.geometry.setDrawRange(0, this.count);
        line.geometry.attributes.position.needsUpdate = true;
        this._last = p;
        this.sm?.redraw?.();
    }

    dispose() {
        this._stopTimer();
        if (this.line) {
            this.line.parent?.remove(this.line);
            this.line.geometry?.dispose?.();
            this.line.material?.dispose?.();
            this.line = null;
        }
        this.positions = null;
        this.count = 0;
        this._last = null;
        if (window._robcoTcpTrace === this) window._robcoTcpTrace = null;
    }
}
