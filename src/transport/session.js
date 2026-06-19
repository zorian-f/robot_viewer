/**
 * Resolve RobFlow endpoint URLs for a cloud session (SID) or a local robot.
 *
 * Cloud (verified live):
 *   REST     https://api.robco.studio/public/virtual-robot/session/{SID}/api/v3.0
 *   WS       wss://api.robco.studio/public/virtual-robot/session/ws/{SID}/api/v3.0/robot   (note /ws/ infix)
 *   modules  https://robco.studio/modules            (public CDN, Access-Control-Allow-Origin: *)
 *
 * Local robot:
 *   REST     http://{host}:{port}/api/v3.0
 *   WS       ws://{host}:{port}/api/v3.0/robot
 *   modules  http://{host}:{port}/robot_modules
 *
 * @param {Object} opts
 * @param {string} [opts.sid]          - cloud session token (selects cloud mode).
 * @param {string} [opts.apiHost]      - cloud API host (default api.robco.studio).
 * @param {string} [opts.modulesBase]  - override the geometry base URL.
 * @param {string} [opts.host]         - local robot host (default localhost).
 * @param {number} [opts.port]         - local robot port (default 8000).
 * @param {boolean} [opts.secure]      - use https/wss for local.
 * @returns {{mode:string, restBase:string, wsUrl:string, modulesBase:string, sid?:string}}
 */
export function resolveSession(opts = {}) {
    if (opts.sid) {
        const apiHost = opts.apiHost || 'api.robco.studio';
        const sid = opts.sid;
        const httpRoot = `https://${apiHost}/public/virtual-robot/session/${sid}`;
        const wsRoot = `wss://${apiHost}/public/virtual-robot/session/ws/${sid}`;
        return {
            mode: 'cloud',
            sid,
            restBase: `${httpRoot}/api/v3.0`,
            wsUrl: `${wsRoot}/api/v3.0/robot`,
            // Public CDN is CORS-friendly; the in-session robot_modules path also works.
            modulesBase: opts.modulesBase || 'https://robco.studio/modules',
        };
    }

    const host = opts.host || 'localhost';
    const port = opts.port || 8000;
    const scheme = opts.secure ? 'https' : 'http';
    const wscheme = opts.secure ? 'wss' : 'ws';
    return {
        mode: 'local',
        restBase: `${scheme}://${host}:${port}/api/v3.0`,
        wsUrl: `${wscheme}://${host}:${port}/api/v3.0/robot`,
        modulesBase: opts.modulesBase || `${scheme}://${host}:${port}/robot_modules`,
    };
}
