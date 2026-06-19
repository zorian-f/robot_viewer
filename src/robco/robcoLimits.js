/**
 * RobCo joint range.
 *
 * Every RobCo robot axis (Drive / BaseDrive) travels ±270°, so we apply this uniformly
 * rather than relying on the per-module descriptor's `q_lower_hard` / `q_upper_hard`,
 * which are frequently absent and would otherwise fall back to ±180° (±π) — too tight
 * for the sliders, the teach-pendant IK, and free posing. The descriptor's raw values are
 * still preserved on each link's `userData.descriptor` if ever needed.
 */
export const ROBCO_AXIS_LIMIT_DEG = 270;
export const ROBCO_AXIS_LIMIT_RAD = (ROBCO_AXIS_LIMIT_DEG * Math.PI) / 180; // ≈ 4.712389
