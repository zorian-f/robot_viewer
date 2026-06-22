/**
 * A self-contained studio environment for PMREM, calibrated to RobCo Studio's actual baked HDRI.
 *
 * The real env (a 2048×1024 Cycles equirectangular EXR) was decoded and profiled:
 *   - a calm, near-neutral grey FIELD at median ≈ 0.089 linear luminance (middle 50% ≈ 0.075–0.112),
 *   - a small (~1%) concentrated bright KEY peaking ~207 linear → the specular highlights,
 *   - solid-angle-weighted average luminance ≈ 0.54,
 *   - colour within ±1% of neutral with a faint warm lean (R 1.008, G 0.998, B 1.001).
 * That dark-field + bright-key ratio is what makes polished aluminium read as crisp metal rather
 * than flat grey. We approximate it with unlit (MeshBasic, toneMapped:false → exact linear
 * radiance baked into the half-float PMREM target) panels. The Render panel can also load RobCo's
 * exact EXR for a byte-identical match.
 *
 * Pass the returned scene to `PMREMGenerator.fromScene(scene, 0.04)`.
 */
import * as THREE from 'three';

const LIN = THREE.LinearSRGBColorSpace;
const WARM = [1.008, 0.998, 1.001]; // faint warm-neutral lean from the decoded profile

function emitter(scene, w, h, d, lum, pos) {
    const m = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshBasicMaterial({ toneMapped: false }), // bake true linear radiance, no tone map
    );
    m.material.color.setRGB(lum * WARM[0], lum * WARM[1], lum * WARM[2], LIN);
    if (pos) m.position.set(pos[0], pos[1], pos[2]);
    scene.add(m);
    return m;
}

export function createStudioEnvironment() {
    const scene = new THREE.Scene();

    // FIELD: calm dark-grey ambient from all directions (median ≈ 0.089 linear). Enclosing box.
    const room = new THREE.Mesh(
        new THREE.BoxGeometry(20, 18, 20),
        new THREE.MeshBasicMaterial({ side: THREE.BackSide, toneMapped: false }),
    );
    room.material.color.setRGB(0.09 * WARM[0], 0.09 * WARM[1], 0.09 * WARM[2], LIN);
    scene.add(room);

    // KEY: soft, bright overhead softbox → the specular highlight + soft directional read.
    // (Brightness lifts the weighted-average luminance toward ~0.54; tune via the env-IBL slider.)
    emitter(scene, 8, 0.4, 8, 10.0, [0, 8.6, 0]);
    // Gentle fills for a slight gradient (the p90 ≈ 0.22 tail), not flat.
    emitter(scene, 0.4, 8, 8, 0.6, [-9.6, 3, 1]);
    emitter(scene, 0.4, 8, 8, 0.45, [9.6, 3, -2]);
    emitter(scene, 8, 5, 0.4, 0.4, [0, 3, 9.6]);

    return scene;
}
