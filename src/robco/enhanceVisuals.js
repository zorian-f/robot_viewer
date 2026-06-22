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

    // Match RobCo Studio's recipe: ACES Filmic at exposure 1.0, lit purely by a bright studio
    // environment (no punctual lights / shadows by default). The panel can change all of this.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Environment for IBL. Prefer a local equirectangular HDRI/EXR at public/env/studio.exr (e.g.
    // RobCo's own studio map — gitignored, never committed) for the exact look; otherwise fall back
    // to the calibrated procedural studio env. The Render panel can also load one at runtime.
    try {
        const pmrem = new THREE.PMREMGenerator(renderer);
        let envTex = null;
        const url = `${import.meta.env?.BASE_URL ?? '/'}env/studio.exr`;
        try {
            const { EXRLoader } = await import('three/examples/jsm/loaders/EXRLoader.js');
            const tex = await new Promise((res, rej) => new EXRLoader().load(url, res, undefined, rej));
            tex.mapping = THREE.EquirectangularReflectionMapping;
            envTex = pmrem.fromEquirectangular(tex).texture;
            tex.dispose();
            console.log('[RobCo] environment: studio.exr (exact)');
        } catch {
            const { createStudioEnvironment } = await import('./studioEnvironment.js');
            envTex = pmrem.fromScene(createStudioEnvironment(), 0.04).texture;
            console.log('[RobCo] environment: procedural studio (studio.exr not found)');
        }
        scene.environment = envTex;
        pmrem.dispose();
    } catch (e) {
        console.warn('[RobCo] environment setup failed:', e);
    }

    model.threeObject?.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
            if (!m) continue;
            // RobCo applies no envMapIntensity override (GLB default 1.0); the bright studio env
            // does the work. The Render panel can still scale it live.
            if ('envMapIntensity' in m) m.envMapIntensity = 1.0;
            // The GLBs author status LEDs as materials named "Emission …" but ship them without an
            // emissiveFactor, so they render as flat grey/green. Make them actually glow.
            if (m.name && /emission/i.test(m.name) && m.emissive && m.color) {
                m.emissive.copy(m.color);
                m.emissiveIntensity = /gr[üu]n|green/i.test(m.name) ? 1.4 : 1.0;
            }
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
