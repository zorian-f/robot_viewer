/**
 * Order a list of RobCo module ids base -> flange and (optionally) filter modules.
 *
 * RobCo's own robot-visualizer drops Clamp modules (type-id starting "C") — mounting
 * adapters between modules. We KEEP them by default: their `proximal_transformation` is
 * identity (verified — zero-length connectors), so including them does not change the
 * kinematics, but it adds their visual mesh and their (small) mass/inertia to the model —
 * better looking and more accurate for the dynamics dashboard. Each becomes a fixed link.
 *
 * The live `robotModuleIds` stream is already base->flange, so we preserve order and only
 * filter ids missing from the mapping. (`dropClamps: true` restores RobCo's behaviour.)
 *
 * @param {Object} mapping - parsed module_folder_mapping.json (id -> {moduleType,...}).
 * @param {string[]} moduleIds - module ids that make up the robot.
 * @param {Object} [opts]
 * @param {boolean} [opts.dropClamps=false] - drop Clamp modules (RobCo's behaviour).
 * @returns {string[]} filtered, ordered module ids.
 */
export function chainOrder(mapping, moduleIds, { dropClamps = false } = {}) {
    return moduleIds.filter((id) => {
        const entry = mapping[id];
        if (!entry) {
            console.warn(`[RobCo] module id "${id}" not in folder mapping; skipping`);
            return false;
        }
        if (dropClamps && entry.moduleType === 'Clamp') return false;
        return true;
    });
}
