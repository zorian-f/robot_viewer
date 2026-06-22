/**
 * A bright product-viz studio environment for PMREM, replacing three's dim RoomEnvironment.
 *
 * RobCo Studio lights its arm purely by a bright baked HDR through `scene.environment` (ACES,
 * no punctual lights, no shadows). The arm body is polished aluminium (metallic 0.99, rough
 * 0.25), so it shows almost only the reflected environment — a dim, flat env reads as grey/
 * gloomy. This builds a soft light-grey room with a large overhead softbox + side/front fill
 * panels (HDR values >1, preserved by the PMREM half-float target) so polished metal picks up
 * crisp highlights and a clean gradient — approximating RobCo's HDR look without any asset.
 *
 * Pass the returned scene to `PMREMGenerator.fromScene(scene, 0.04)`.
 */
import * as THREE from 'three';

function panel(scene, w, h, d, value, pos) {
    const m = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshBasicMaterial(),
    );
    m.material.color.setRGB(value, value, value); // value may exceed 1 → HDR highlight
    m.position.set(pos[0], pos[1], pos[2]);
    scene.add(m);
    return m;
}

export function createStudioEnvironment() {
    const scene = new THREE.Scene();

    // Enclosing room: light-grey diffuse fill from every direction (soft ambient base).
    const room = new THREE.Mesh(
        new THREE.BoxGeometry(20, 18, 20),
        new THREE.MeshStandardMaterial({ side: THREE.BackSide, color: 0xd9dde2, roughness: 1, metalness: 0 }),
    );
    scene.add(room);

    // Large overhead softbox — the main highlight source.
    panel(scene, 14, 0.4, 14, 3.0, [0, 8.6, 0]);
    // Side fills (rim highlights), slightly off-axis + asymmetric for natural variation.
    panel(scene, 0.4, 9, 9, 1.7, [-9.6, 2.5, 1]);
    panel(scene, 0.4, 9, 9, 1.2, [9.6, 2.5, -2]);
    // Soft front fill so the face toward the default camera isn't dark.
    panel(scene, 9, 6, 0.4, 0.9, [0, 3, 9.6]);
    // Faint back light for edge separation.
    panel(scene, 9, 5, 0.4, 0.7, [0, 3.5, -9.6]);

    return scene;
}
