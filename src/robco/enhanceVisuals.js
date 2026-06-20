/**
 * Lift the render quality of a loaded RobCo robot.
 *
 * The base viewer ships with no tone mapping and a flat (uniform-white) PMREM environment,
 * which makes the PBR metal/plastic parts look dull. This:
 *   • enables ACES filmic tone mapping + sRGB output on the renderer,
 *   • replaces scene.environment with a neutral studio (RoomEnvironment) PMREM for richer
 *     image-based reflections,
 *   • enables shadow casting/receiving on the robot meshes and gives metals sensible IBL.
 */
import * as THREE from 'three';

export async function enhanceVisuals(model, sm) {
    if (!sm?.renderer || !sm?.scene) return;
    const { renderer, scene } = sm;

    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Studio environment for image-based lighting (much nicer reflections than the flat default).
    try {
        const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js');
        const pmrem = new THREE.PMREMGenerator(renderer);
        const envScene = new RoomEnvironment();
        const env = pmrem.fromScene(envScene, 0.04).texture;
        scene.environment = env;
        pmrem.dispose();
        envScene.dispose?.();
    } catch (e) {
        console.warn('[RobCo] studio environment upgrade failed:', e);
    }

    model.threeObject?.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
            if (!m) continue;
            if ('envMapIntensity' in m) m.envMapIntensity = 1.25;
            // Flat-shaded GLBs sometimes import without smooth normals; keep as-authored but
            // ensure the material recompiles for the new tone mapping / environment.
            m.needsUpdate = true;
        }
    });

    // Render Settings panel (lets the user dial exposure / env / lights / shadows live).
    try {
        const { RenderSettingsPanel } = await import('./RenderSettingsPanel.js');
        RenderSettingsPanel.ensure(sm).applyAll();
    } catch (e) {
        console.warn('[RobCo] render settings panel failed:', e);
    }

    // View panel (geometry / inertia / frames / highlight / interaction / screenshot).
    try {
        const { ViewPanel } = await import('./ViewPanel.js');
        ViewPanel.ensure(sm, model);
    } catch (e) {
        console.warn('[RobCo] view panel failed:', e);
    }

    // Base frame (movable base / world group) + Setup panel (Base/Scene/End-Effector sections).
    try {
        const { BaseFrame } = await import('./BaseFrame.js');
        const { SetupPanel } = await import('./SetupPanel.js');
        const bf = BaseFrame.ensure(sm, model);
        SetupPanel.ensure(sm, bf);
    } catch (e) {
        console.warn('[RobCo] setup panel failed:', e);
    }

    sm.redraw?.();
    sm.render?.();
}
