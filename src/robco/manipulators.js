/**
 * Single-active-manipulator arbiter.
 *
 * Only one direct 3D manipulation should be live at a time: the teach TCP gizmo, the Setup
 * gizmo (Base/Scene/End-Effector align), or the View-panel FK joint-drag. Each registers a
 * `turnOff` fn under a name; activating one turns the others off, so gizmos never overlap or
 * fight over the pointer / OrbitControls.
 */
const registry = new Map(); // name -> turnOff()
let active = null;

export function registerManipulator(name, turnOff) {
    registry.set(name, turnOff);
}

/** Make `name` the sole active manipulator: turn every other registered one off. */
export function activateManipulator(name) {
    for (const [other, turnOff] of registry) {
        if (other !== name) {
            try { turnOff?.(); } catch (e) { console.warn('[RobCo] manipulator turnOff:', e); }
        }
    }
    active = name;
}

export function deactivateManipulator(name) {
    if (active === name) active = null;
}

export function activeManipulator() {
    return active;
}
