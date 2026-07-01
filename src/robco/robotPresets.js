/**
 * RobCo virtual-robot preset catalog.
 *
 * Source of truth: the public https://robco.studio/db/modular_robots.json — the same file the
 * Studio "Virtual Robot Configuration" loads. Falls back to a bundled snapshot when the CDN is
 * unreachable. Each preset maps a friendly name to an ordered module type-id list.
 *
 * Two id forms matter:
 *   idsRaw    — the catalog's unpadded type-ids (352, 301, 1007). Sent to Studio verbatim as the
 *               `module_ids` WS payload (exactly what the configurator sends).
 *   idsPadded — 4-digit zero-padded ('0352','0301','1007') — the keys of module_folder_mapping.json.
 *               Used to build the arm locally (offline) and to name a live robotModuleIds stream.
 */
export const MODULES_CDN = 'https://robco.studio/modules';
const CATALOG_URL = 'https://robco.studio/db/modular_robots.json';
const FALLBACK_URL = 'robco-fixtures/modular_robots.json'; // bundled snapshot (same origin)

/** Pad a module id (number or string) to the 4-digit folder-mapping key form. */
export function pad4(id) {
    return String(id).trim().padStart(4, '0');
}

/**
 * Normalize any module-id list (numbers/strings, padded or not) to canonical 4-digit strings,
 * dropping the 8xxx "clamp" modules — a live robotModuleIds stream includes them but the catalog
 * (and the adapter's build) do not, so they must be ignored when naming / diffing a config.
 */
export function canonicalIds(ids) {
    return (ids || [])
        .filter((id) => { const n = Number(id); return !(n >= 8000 && n <= 8999); })
        .map(pad4);
}

function parseIds(idBuildOrder) {
    return String(idBuildOrder || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** German-formatted mm ("1.850" / "440") → metres. */
function reachToM(armReachMm) {
    const mm = parseInt(String(armReachMm || '').replace(/[^\d]/g, ''), 10);
    return Number.isFinite(mm) ? mm / 1000 : null;
}

function normalize(raw) {
    const idsStr = parseIds(raw.IdBuildOrder);
    return {
        englishName: raw.EnglishName || raw.RobotName || 'Robot',
        robotName: raw.RobotName || '',
        dof: parseInt(raw.Dof, 10) || null,
        reachM: reachToM(raw.ArmReachMm),
        payloadKg: parseFloat(raw.PayloadKg) || null,
        no: raw.No || '',
        buildOrder: raw.BuildOrder || '',
        idsRaw: idsStr.map((s) => Number(s)),  // → Studio (module_ids WS payload)
        idsPadded: idsStr.map(pad4),           // → local build + name matching
    };
}

/** Load + normalize the preset catalog (CDN first, bundled snapshot on any failure). */
export async function loadPresets() {
    let arr = null;
    try {
        const res = await fetch(CATALOG_URL, { credentials: 'omit' });
        if (res.ok) arr = await res.json();
    } catch { /* fall through to bundled snapshot */ }
    if (!Array.isArray(arr)) {
        try {
            const res = await fetch(FALLBACK_URL);
            if (res.ok) arr = await res.json();
        } catch { /* ignore */ }
    }
    if (!Array.isArray(arr)) return [];
    return arr.map(normalize).filter((p) => p.idsPadded.length > 0);
}

/** Find the preset whose module list matches `ids` (order-sensitive), or null. */
export function matchPreset(ids, presets) {
    const key = canonicalIds(ids).join(',');
    if (!key) return null;
    return (presets || []).find((p) => p.idsPadded.join(',') === key) || null;
}
