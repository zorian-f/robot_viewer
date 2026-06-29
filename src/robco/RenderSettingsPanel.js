/**
 * Render Settings — a draggable, minimizable panel to dial in visual quality live:
 * tone-mapping mode + exposure, environment (IBL) intensity, key/ambient light, shadows.
 * Applies to the shared renderer/scene/lights and persists to localStorage.
 */
import * as THREE from 'three';
import { makeDraggable } from './draggable.js';
import { createStudioEnvironment } from './studioEnvironment.js';

const TONE = {
    None: THREE.NoToneMapping,
    ACES: THREE.ACESFilmicToneMapping,
    AgX: THREE.AgXToneMapping,
    Neutral: THREE.NeutralToneMapping,
    Reinhard: THREE.ReinhardToneMapping,
    Cineon: THREE.CineonToneMapping,
};
const KEY = 'robco-render-settings-v6'; // bumped to ship the tuned default look
// Tuned default look: filmic (ACES) tone mapping at exposure 1.0, lit by a strong key light
// (3.0) + ambient (1.2) with a low studio-IBL contribution (0.15); shadows, ambient occlusion
// and bloom are off by default. PBR metalness/roughness ~0.43. Everything is tunable in panel.
const DEFAULTS = {
    exposure: 1.0, envIntensity: 0.15, tone: 'ACES', keyLight: 3.0, ambient: 1.2, shadows: false,
    background: '#FCF9F7',
    ao: false, aoStrength: 2.0, bloom: false, bloomStrength: 0.45, metalness: 0.43, roughness: 0.43,
};

const PANEL_CSS =
    'position:fixed;right:16px;bottom:16px;z-index:3000;width:240px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;' +
    'color:#e6edf3;background:rgba(13,17,23,0.9);border:1px solid rgba(255,255,255,0.12);border-radius:10px;' +
    'padding:10px 12px;backdrop-filter:blur(6px);box-shadow:0 6px 24px rgba(0,0,0,0.4);';

function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
}

export class RenderSettingsPanel {
    static ensure(sm) {
        if (window._robcoRenderPanel) return window._robcoRenderPanel;
        const p = new RenderSettingsPanel(sm);
        window._robcoRenderPanel = p;
        return p;
    }

    constructor(sm) {
        this.sm = sm;
        let saved = {};
        try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* ignore */ }
        this.s = { ...DEFAULTS, ...saved };
        // Which environment (IBL) source is active, for session save/restore. enhanceVisuals seeds
        // the scene with the studio env, so 'studio' is the effective default until the user loads
        // a custom EXR/HDRI. _envBytes/_envFileName hold a custom map's raw bytes when source==='custom'.
        this._envSource = 'studio';
        this._envBytes = null;
        this._envFileName = null;
        this._build();
    }

    _save() {
        try { localStorage.setItem(KEY, JSON.stringify(this.s)); } catch { /* ignore */ }
    }

    /**
     * @param {number} [curve=1] - >1 makes the slider perceptual: the bottom of the travel gets
     *   fine resolution and the top coarse (value = min + (max-min)·pos^curve). Useful for
     *   envMapIntensity, where small low-end changes are visually large.
     */
    _slider(label, min, max, step, val, onInput, curve = 1) {
        const row = el('div', 'display:grid;grid-template-columns:62px 1fr 40px;gap:6px;align-items:center;margin:5px 0;');
        row.append(el('span', 'opacity:.8;', label));
        const input = el('input', 'width:100%;accent-color:#2f81f7;');
        const fmt = (v) => (Math.abs(v) < 0.1 ? (+v).toFixed(3) : (+v).toFixed(2));
        const out = el('span', 'text-align:right;opacity:.9;font-size:10px;', fmt(val));
        if (curve !== 1) {
            const toPos = (v) => Math.pow(Math.max(0, (v - min) / (max - min)), 1 / curve);
            const toVal = (p) => min + (max - min) * Math.pow(p, curve);
            input.type = 'range'; input.min = 0; input.max = 1; input.step = 0.001; input.value = toPos(val);
            input.addEventListener('input', () => { const v = toVal(+input.value); out.textContent = fmt(v); onInput(v); });
        } else {
            input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = val;
            input.addEventListener('input', () => { out.textContent = fmt(+input.value); onInput(+input.value); });
        }
        row.append(input, out);
        return row;
    }

    _build() {
        const root = el('div', PANEL_CSS);

        const header = el('div', 'display:flex;align-items:center;justify-content:space-between;font-weight:600;color:#fff;');
        const title = el('span', null, 'Render Settings  ⠿');
        const minBtn = el('button', 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#e6edf3;border-radius:6px;cursor:pointer;width:22px;height:20px;', '▾');
        header.append(title, minBtn);
        root.append(header);

        const body = el('div', 'margin-top:8px;');
        root.append(body);

        // Tone mapping select
        const tmRow = el('div', 'display:flex;align-items:center;gap:8px;margin:5px 0;');
        tmRow.append(el('span', 'opacity:.8;width:62px;', 'tone'));
        // color-scheme:dark darkens the native option popup in Chromium; the per-option
        // background/colour covers Firefox, whose popup ignores the parent's translucent bg.
        const tm = el('select', 'flex:1;background:rgba(255,255,255,0.08);color:#e6edf3;border:1px solid rgba(255,255,255,0.15);border-radius:5px;padding:3px;font:inherit;color-scheme:dark;');
        tm.innerHTML = Object.keys(TONE).map((k) => `<option style="background:#0d1117;color:#e6edf3;" value="${k}"${k === this.s.tone ? ' selected' : ''}>${k}</option>`).join('');
        tm.addEventListener('change', () => { this.s.tone = tm.value; this._applyTone(); this._save(); this.sm.render?.(); });
        tmRow.append(tm);
        body.append(tmRow);

        // Background colour
        const bgRow = el('div', 'display:flex;align-items:center;gap:8px;margin:5px 0;');
        bgRow.append(el('span', 'opacity:.8;width:62px;', 'background'));
        const bg = el('input', 'width:40px;height:22px;background:transparent;border:1px solid rgba(255,255,255,0.15);border-radius:5px;cursor:pointer;padding:0;');
        bg.type = 'color';
        bg.value = this.s.background;
        bg.addEventListener('input', () => { this.s.background = bg.value; this._applyBackground(); this._save(); this.sm.render?.(); });
        const bgReset = el('button', 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#9da7b3;border-radius:5px;cursor:pointer;font:inherit;padding:2px 6px;', 'RobCo');
        bgReset.addEventListener('click', () => { this.s.background = '#FCF9F7'; bg.value = '#FCF9F7'; this._applyBackground(); this._save(); this.sm.render?.(); });
        bgRow.append(bg, bgReset);
        body.append(bgRow);

        // Environment map: load an HDRI/EXR equirectangular for IBL (e.g. RobCo's own studio.exr,
        // extracted locally), or reset to the built-in procedural studio. Background stays solid.
        const envRow = el('div', 'display:flex;align-items:center;gap:6px;margin:5px 0;');
        const envFile = el('input'); envFile.type = 'file'; envFile.accept = '.exr,.hdr'; envFile.style.display = 'none';
        envFile.addEventListener('change', () => { if (envFile.files?.[0]) this._loadEnvFile(envFile.files[0]); });
        const envBtn = el('button', 'flex:1;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#e6edf3;border-radius:5px;cursor:pointer;font:inherit;padding:3px 6px;', 'Load HDRI/EXR…');
        envBtn.addEventListener('click', () => envFile.click());
        const envReset = el('button', 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#9da7b3;border-radius:5px;cursor:pointer;font:inherit;padding:3px 6px;', 'Studio');
        envReset.addEventListener('click', () => this._applyStudioEnv());
        envRow.append(el('span', 'opacity:.8;width:62px;', 'env map'), envBtn, envReset, envFile);
        body.append(envRow);
        this._envStatus = el('div', 'font-size:10px;color:#6e7681;margin:-2px 0 4px;min-height:12px;');
        body.append(this._envStatus);

        body.append(this._slider('exposure', 0, 3, 0.05, this.s.exposure, (v) => { this.s.exposure = v; this._applyExposure(); this._save(); this.sm.render?.(); }));
        // Perceptual (cubic) curve so the low end (where the sweet spot sits) is finely adjustable.
        body.append(this._slider('env IBL', 0, 3, 0.001, this.s.envIntensity, (v) => { this.s.envIntensity = v; this._applyEnv(); this._save(); this.sm.render?.(); }, 3));
        body.append(this._slider('key light', 0, 8, 0.1, this.s.keyLight, (v) => { this.s.keyLight = v; this._applyLights(); this._save(); this.sm.render?.(); }));
        body.append(this._slider('ambient', 0, 3, 0.05, this.s.ambient, (v) => { this.s.ambient = v; this._applyLights(); this._save(); this.sm.render?.(); }));

        const shRow = el('label', 'display:flex;align-items:center;gap:8px;margin-top:6px;cursor:pointer;');
        const sh = el('input'); sh.type = 'checkbox'; sh.checked = this.s.shadows; sh.style.cssText = 'accent-color:#3fb950;';
        sh.addEventListener('change', () => { this.s.shadows = sh.checked; this._applyShadows(); this._save(); this.sm.render?.(); });
        shRow.append(sh, el('span', 'opacity:.85;', 'shadows'));
        body.append(shRow);

        // --- Post-processing: ambient occlusion ---
        const aoRow = el('label', 'display:flex;align-items:center;gap:8px;margin-top:6px;cursor:pointer;');
        const ao = el('input'); ao.type = 'checkbox'; ao.checked = this.s.ao; ao.style.cssText = 'accent-color:#3fb950;';
        ao.addEventListener('change', () => { this.s.ao = ao.checked; this._applyAO(); this._save(); this.sm.render?.(); });
        aoRow.append(ao, el('span', 'opacity:.85;', 'ambient occlusion'));
        body.append(aoRow);
        body.append(this._slider('AO amt', 0, 2, 0.05, this.s.aoStrength, (v) => { this.s.aoStrength = v; this._applyAO(); this._save(); this.sm.render?.(); }));

        // --- Post-processing: bloom ---
        const blRow = el('label', 'display:flex;align-items:center;gap:8px;margin-top:6px;cursor:pointer;');
        const bl = el('input'); bl.type = 'checkbox'; bl.checked = this.s.bloom; bl.style.cssText = 'accent-color:#3fb950;';
        bl.addEventListener('change', () => { this.s.bloom = bl.checked; this._applyBloom(); this._save(); this.sm.render?.(); });
        blRow.append(bl, el('span', 'opacity:.85;', 'bloom'));
        body.append(blRow);
        body.append(this._slider('bloom', 0, 1, 0.01, this.s.bloomStrength, (v) => { this.s.bloomStrength = v; this._applyBloom(); this._save(); this.sm.render?.(); }));

        // --- PBR material defaults (only affects converted URDF/STL meshes, not authored glTF) ---
        body.append(this._slider('metalness', 0, 1, 0.01, this.s.metalness, (v) => { this.s.metalness = v; this._applyMaterials(); this._save(); this.sm.render?.(); }));
        body.append(this._slider('roughness', 0, 1, 0.01, this.s.roughness, (v) => { this.s.roughness = v; this._applyMaterials(); this._save(); this.sm.render?.(); }));

        minBtn.addEventListener('click', () => {
            const hidden = body.style.display === 'none';
            body.style.display = hidden ? 'block' : 'none';
            minBtn.textContent = hidden ? '▾' : '▸';
        });

        document.body.appendChild(root);
        this.root = root;
        makeDraggable(root, title, 'render');
    }

    // --- environment ----------------------------------------------------
    /** Load an equirectangular HDRI (.hdr) or EXR (.exr) as scene.environment via PMREM. */
    async _loadEnvFile(file) {
        this._envStatus.textContent = `loading ${file.name}…`;
        // Retain the raw EXR/HDR bytes + mark the source 'custom' so a session save can embed it.
        try { this._envBytes = await file.arrayBuffer(); } catch { this._envBytes = null; }
        this._envFileName = file.name;
        this._envSource = 'custom';
        const url = URL.createObjectURL(file);
        try {
            const isExr = /\.exr$/i.test(file.name);
            const mod = isExr
                ? await import('three/examples/jsm/loaders/EXRLoader.js')
                : await import('three/examples/jsm/loaders/RGBELoader.js');
            const Loader = isExr ? mod.EXRLoader : mod.RGBELoader;
            const tex = await new Promise((res, rej) => new Loader().load(url, res, undefined, rej));
            tex.mapping = THREE.EquirectangularReflectionMapping;
            const pmrem = new THREE.PMREMGenerator(this.sm.renderer);
            const rt = pmrem.fromEquirectangular(tex);
            this.sm.scene.environment = rt.texture;
            tex.dispose();
            pmrem.dispose();
            this._applyEnv(); // re-assert envMapIntensity on materials
            this._envStatus.textContent = `env: ${file.name}`;
            this.sm.render?.();
        } catch (e) {
            console.warn('[RobCo] env load failed:', e);
            this._envStatus.textContent = `load failed: ${e.message}`;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    /** Reset to the built-in procedural studio environment. */
    _applyStudioEnv() {
        this._envSource = 'studio';
        this._envBytes = null;
        this._envFileName = null;
        try {
            const pmrem = new THREE.PMREMGenerator(this.sm.renderer);
            this.sm.scene.environment = pmrem.fromScene(createStudioEnvironment(), 0.04).texture;
            pmrem.dispose();
            this._applyEnv();
            if (this._envStatus) this._envStatus.textContent = 'env: built-in studio';
            this.sm.render?.();
        } catch (e) {
            console.warn('[RobCo] studio env reset failed:', e);
        }
    }

    // --- apply ----------------------------------------------------------
    _applyBackground() { if (this.sm.scene) this.sm.scene.background = new THREE.Color(this.s.background); }
    _applyExposure() { this.sm.renderer.toneMappingExposure = this.s.exposure; }
    _applyTone() {
        this.sm.renderer.toneMapping = TONE[this.s.tone] ?? THREE.ACESFilmicToneMapping;
        this.sm.scene.traverse((o) => {
            if (!o.isMesh) return;
            for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m) m.needsUpdate = true;
        });
    }
    _applyEnv() {
        this.sm.scene.traverse((o) => {
            if (!o.isMesh) return;
            for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
                if (m && 'envMapIntensity' in m) m.envMapIntensity = this.s.envIntensity;
            }
        });
    }
    _applyLights() {
        if (this.sm.directionalLight) this.sm.directionalLight.intensity = this.s.keyLight;
        if (this.sm.ambientLight) this.sm.ambientLight.intensity = this.s.ambient;
    }
    _applyShadows() {
        this.sm.renderer.shadowMap.enabled = this.s.shadows;
        if (this.sm.directionalLight) this.sm.directionalLight.castShadow = this.s.shadows;
        this.sm.renderer.shadowMap.needsUpdate = true;
        this.sm.scene.traverse((o) => { if (o.isMesh) { o.castShadow = this.s.shadows; o.receiveShadow = this.s.shadows; } });
    }

    _applyAO() { this.sm.postFX?.setAO(this.s.ao, this.s.aoStrength); }
    _applyBloom() { this.sm.postFX?.setBloom(this.s.bloom, this.s.bloomStrength); }
    /** Re-apply AO + bloom (called once the lazily-loaded post-processing composer is ready). */
    applyPostFX() { this._applyAO(); this._applyBloom(); }
    /** Apply global metalness/roughness to converted (non-authored) PBR materials only. */
    _applyMaterials() {
        this.sm.scene.traverse((o) => {
            if (!o.isMesh) return;
            for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
                if (m && m.isMeshStandardMaterial && m.userData?.pbrConverted) {
                    m.metalness = this.s.metalness;
                    m.roughness = this.s.roughness;
                    m.needsUpdate = true;
                }
            }
        });
    }

    /** Apply all current settings (call after a model (re)loads). */
    applyAll() {
        this._applyBackground();
        this._applyExposure();
        this._applyTone();
        this._applyEnv();
        this._applyLights();
        this._applyShadows();
        this._applyMaterials();
        this._applyAO();
        this._applyBloom();
        this.sm.render?.();
    }
}
