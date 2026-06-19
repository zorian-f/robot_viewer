/**
 * Render Settings — a draggable, minimizable panel to dial in visual quality live:
 * tone-mapping mode + exposure, environment (IBL) intensity, key/ambient light, shadows.
 * Applies to the shared renderer/scene/lights and persists to localStorage.
 */
import * as THREE from 'three';
import { makeDraggable } from './draggable.js';

const TONE = {
    None: THREE.NoToneMapping,
    ACES: THREE.ACESFilmicToneMapping,
    AgX: THREE.AgXToneMapping,
    Neutral: THREE.NeutralToneMapping,
    Reinhard: THREE.ReinhardToneMapping,
    Cineon: THREE.CineonToneMapping,
};
const KEY = 'robco-render-settings-v2'; // bumped so the RobCo-style defaults take effect
// Defaults match RobCo Studio's visualizer: warm-white background, ACES tone mapping,
// IBL/environment-dominant lighting with a soft directional key.
const DEFAULTS = { exposure: 1.0, envIntensity: 1.2, tone: 'ACES', keyLight: 0.6, ambient: 0.35, shadows: true, background: '#FCF9F7' };

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
        this._build();
    }

    _save() {
        try { localStorage.setItem(KEY, JSON.stringify(this.s)); } catch { /* ignore */ }
    }

    _slider(label, min, max, step, val, onInput) {
        const row = el('div', 'display:grid;grid-template-columns:62px 1fr 36px;gap:6px;align-items:center;margin:5px 0;');
        row.append(el('span', 'opacity:.8;', label));
        const input = el('input', 'width:100%;accent-color:#2f81f7;');
        input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = val;
        const out = el('span', 'text-align:right;opacity:.9;', (+val).toFixed(2));
        input.addEventListener('input', () => { out.textContent = (+input.value).toFixed(2); onInput(+input.value); });
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
        const tm = el('select', 'flex:1;background:rgba(255,255,255,0.08);color:#e6edf3;border:1px solid rgba(255,255,255,0.15);border-radius:5px;padding:3px;font:inherit;');
        tm.innerHTML = Object.keys(TONE).map((k) => `<option value="${k}"${k === this.s.tone ? ' selected' : ''}>${k}</option>`).join('');
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

        body.append(this._slider('exposure', 0, 3, 0.05, this.s.exposure, (v) => { this.s.exposure = v; this._applyExposure(); this._save(); this.sm.render?.(); }));
        body.append(this._slider('env IBL', 0, 3, 0.05, this.s.envIntensity, (v) => { this.s.envIntensity = v; this._applyEnv(); this._save(); this.sm.render?.(); }));
        body.append(this._slider('key light', 0, 8, 0.1, this.s.keyLight, (v) => { this.s.keyLight = v; this._applyLights(); this._save(); this.sm.render?.(); }));
        body.append(this._slider('ambient', 0, 3, 0.05, this.s.ambient, (v) => { this.s.ambient = v; this._applyLights(); this._save(); this.sm.render?.(); }));

        const shRow = el('label', 'display:flex;align-items:center;gap:8px;margin-top:6px;cursor:pointer;');
        const sh = el('input'); sh.type = 'checkbox'; sh.checked = this.s.shadows; sh.style.cssText = 'accent-color:#3fb950;';
        sh.addEventListener('change', () => { this.s.shadows = sh.checked; this._applyShadows(); this._save(); this.sm.render?.(); });
        shRow.append(sh, el('span', 'opacity:.85;', 'shadows'));
        body.append(shRow);

        minBtn.addEventListener('click', () => {
            const hidden = body.style.display === 'none';
            body.style.display = hidden ? 'block' : 'none';
            minBtn.textContent = hidden ? '▾' : '▸';
        });

        document.body.appendChild(root);
        this.root = root;
        makeDraggable(root, title, 'render');
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

    /** Apply all current settings (call after a model (re)loads). */
    applyAll() {
        this._applyBackground();
        this._applyExposure();
        this._applyTone();
        this._applyEnv();
        this._applyLights();
        this._applyShadows();
        this.sm.render?.();
    }
}
