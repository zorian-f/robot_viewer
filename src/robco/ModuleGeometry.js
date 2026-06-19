/**
 * RobCo module geometry node.
 *
 * Faithful port of RobCo Studio's robot-visualizer module assembly
 * (`@therobotcompany/robot-visualizer`, class `s5`). Each RobCo module is a
 * proximal -> shaft -> distal chain of Object3D nodes:
 *   - proximal: the module root; carries the proximal visual mesh (the fixed body)
 *   - shaft:    offset from proximal by `kinematics.proximal_transformation`
 *   - distal:   offset from shaft by `kinematics.distal_transformation` (Drive modules);
 *               carries the distal visual mesh and is the rotating frame of the joint.
 *
 * Drive / BaseDrive modules are revolute joints about the distal frame's local Z.
 * The next module in the chain attaches under this module's distal node.
 *
 * Units: transforms are in metres, given as 4x4 row-major matrices. Joint angles
 * here are RADIANS (the live RobFlow stream is degrees and must be converted by the
 * caller before `setJointAngleRad`).
 */
import * as THREE from 'three';

const DRIVE_TYPES = new Set(['Drive', 'BaseDrive']);

/**
 * @param {number[][]} rows - 4x4 matrix as nested rows (row-major), or null.
 * @returns {THREE.Matrix4}
 */
function matrixFromRows(rows) {
    const m = new THREE.Matrix4();
    if (rows && rows.length === 4) {
        // THREE.Matrix4.set takes row-major arguments, and rows.flat() is row-major.
        m.set(...rows.flat());
    }
    return m;
}

/**
 * Load a GLB/GLTF mesh and return its scene group.
 * @param {string} url
 * @returns {Promise<THREE.Object3D>}
 */
async function loadGLB(url) {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    const gltf = await new Promise((resolve, reject) => {
        loader.load(url, resolve, undefined, reject);
    });
    return gltf.scene || gltf;
}

export class RobotModuleNode {
    /**
     * @param {string} moduleId - mapping key (e.g. "0001").
     * @param {number} [seq=0] - position in the chain; makes names unique when a module
     *   id repeats (the same drive type can appear multiple times in one robot).
     */
    constructor(moduleId, seq = 0) {
        this.moduleId = moduleId;
        this.seq = seq;
        this.moduleType = 'Base';
        this.typeId = '';
        this.name = '';
        this.legacy = false;
        this.isDriveModule = false;

        this.proximal = new THREE.Group();
        this.shaft = new THREE.Group();
        this.distal = new THREE.Group();

        this.proximalTf = new THREE.Matrix4();
        this.distalTf = new THREE.Matrix4();

        /** raw descriptor JSON, for downstream features (mass/inertia, motor, gears...) */
        this.descriptor = null;
        this.parent = null;
        this.children = new Set();
    }

    /**
     * Build the proximal -> shaft -> distal hierarchy and load visual meshes,
     * mirroring the RobCo bundle's `initFromJSON`.
     *
     * @param {Object} descriptor - the per-module JSON descriptor.
     * @param {string} folderUrl - base URL of this module's asset folder.
     */
    async initFromJSON(descriptor, folderUrl) {
        this.descriptor = descriptor;
        this.folderUrl = folderUrl; // kept for lazy collision-mesh loading
        this.moduleType = descriptor['module-type'];
        this.typeId = String(descriptor['type-id'] ?? '');
        this.name = descriptor.name || this.moduleId;
        this.legacy = !!descriptor.legacy;
        this.isDriveModule = DRIVE_TYPES.has(this.moduleType);

        this.proximal.name = `${this.seq}_${this.moduleId}_${this.name}_proximal`;
        this.distal.name = `${this.seq}_${this.moduleId}_${this.name}_distal`;

        const kin = descriptor.kinematics || {};
        const cv = descriptor.collisions_visuals || {};

        const proximalTfRows = kin.proximal_transformation ?? null;
        let distalTfRows = null;
        let proximalMeshFile = cv.proximal_visual_mesh;
        let distalMeshFile = '';

        if (this.isDriveModule) {
            distalTfRows = kin.distal_transformation ?? null;
            proximalMeshFile = cv.proximal_visual_mesh;
            distalMeshFile = cv.distal_visual_mesh;
        }

        if (proximalTfRows) this.proximalTf = matrixFromRows(proximalTfRows);
        if (distalTfRows) this.distalTf = matrixFromRows(distalTfRows);

        this.shaft.applyMatrix4(this.proximalTf);
        this.distal.applyMatrix4(this.distalTf);
        this.proximal.add(this.shaft);
        this.shaft.add(this.distal);

        // Load meshes (proximal -> proximal node, distal -> distal node), as in the bundle.
        const loads = [];
        if (proximalMeshFile) {
            loads.push(loadGLB(`${folderUrl}/${proximalMeshFile}`).then((m) => ['proximal', m]));
        }
        if (distalMeshFile) {
            loads.push(loadGLB(`${folderUrl}/${distalMeshFile}`).then((m) => ['distal', m]));
        }

        const results = await Promise.allSettled(loads);
        for (const r of results) {
            if (r.status !== 'fulfilled') {
                console.warn(`[RobCo] mesh load failed for module ${this.moduleId}:`, r.reason);
                continue;
            }
            const [slot, mesh] = r.value;
            if (slot === 'proximal') this.proximal.add(mesh);
            else this.distal.add(mesh);
        }
    }

    /**
     * Apply a revolute joint angle (radians) about the distal frame's local Z,
     * exactly as the RobCo bundle does: distal.rotation = rot(distalTf * Rz(angle)),
     * preserving the distal translation.
     * @param {number} angleRad
     */
    setJointAngleRad(angleRad) {
        if (!this.isDriveModule) return;
        const t = new THREE.Matrix4().makeRotationZ(angleRad);
        t.multiplyMatrices(this.distalTf, t); // distalTf * Rz
        this.distal.setRotationFromMatrix(t);
    }

    /**
     * Lazily load the convex-decomposition collision meshes (.stl) onto the proximal/distal
     * links, hidden, as a translucent overlay. Idempotent.
     * @returns {Promise<THREE.Mesh[]>}
     */
    async loadCollision() {
        if (this._collisionLoaded) return this._collisionMeshes;
        this._collisionLoaded = true;
        this._collisionMeshes = [];
        const cv = this.descriptor?.collisions_visuals || {};
        const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
        const mat = new THREE.MeshStandardMaterial({
            color: 0x00e0a0, transparent: true, opacity: 0.35, depthWrite: false, roughness: 0.7,
        });
        const loadInto = async (file, node) => {
            if (!file) return;
            try {
                const geo = await new Promise((res, rej) =>
                    new STLLoader().load(`${this.folderUrl}/${file}`, res, undefined, rej));
                const mesh = new THREE.Mesh(geo, mat);
                mesh.userData.isCollisionMesh = true;
                mesh.visible = false;
                node.add(mesh);
                this._collisionMeshes.push(mesh);
            } catch (e) {
                console.warn(`[RobCo] collision STL load failed (${file}):`, e);
            }
        };
        await loadInto(cv.proximal_approximation_mesh, this.proximal);
        if (this.isDriveModule) await loadInto(cv.distal_approximation_mesh, this.distal);
        return this._collisionMeshes;
    }

    setCollisionVisible(on) {
        (this._collisionMeshes || []).forEach((m) => { m.visible = on; });
    }

    /**
     * Attach this module under a parent module's distal link.
     * @param {RobotModuleNode} parent
     */
    setParent(parent) {
        parent.children.add(this);
        if (this.parent) this.parent.children.delete(this);
        this.parent = parent;
        parent.getDistalLink().add(this.getProximalLink());
    }

    getProximalLink() {
        return this.proximal;
    }

    getDistalLink() {
        return this.distal;
    }
}
