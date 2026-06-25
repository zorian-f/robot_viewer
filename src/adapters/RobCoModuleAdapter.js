/**
 * RobCo Module Adapter
 *
 * Builds robot_viewer's UnifiedRobotModel from RobCo Studio's robot_modules data:
 *   {base}/module_folder_mapping.json  ->  per-module descriptor JSON  ->  GLB meshes.
 *
 * The three.js hierarchy is assembled exactly like RobCo's own visualizer
 * (see ModuleGeometry.RobotModuleNode), then wrapped as a UnifiedRobotModel so the
 * viewer's inertia visualization, joint controls, frames, and MuJoCo path all work.
 *
 * The raw per-module descriptor (mass/inertia, motor, gears, friction, torque limits)
 * is stashed on each link's `userData.descriptor` for the dynamics dashboard.
 *
 * Units: geometry/CoM metres, mass kg, inertia kg·m², joint limits radians. The live
 * RobFlow `jointAngles` stream is degrees and is converted to radians by the WS bridge
 * before being applied.
 */
import {
    UnifiedRobotModel,
    Link,
    Joint,
    JointLimits,
    InertialProperties,
} from '../models/UnifiedRobotModel.js';
import { RobotModuleNode } from '../robco/ModuleGeometry.js';
import { chainOrder } from '../robco/chainOrder.js';
import { ROBCO_AXIS_LIMIT_RAD } from '../robco/robcoLimits.js';

const MODULE_MAPPING_FILE = 'module_folder_mapping.json';

async function defaultFetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
    return res.json();
}

/**
 * Map a RobCo `dynamics` block (one side: proximal or distal) to InertialProperties.
 * @param {number} mass
 * @param {number[][]} inertia3x3
 * @param {number[]} com - centre of mass [x,y,z]
 * @returns {InertialProperties|null}
 */
function toInertial(mass, inertia3x3, com) {
    if (mass === undefined && !inertia3x3) return null;
    const p = new InertialProperties();
    p.mass = mass ?? 0;
    p.origin = { xyz: com ? [com[0], com[1], com[2]] : [0, 0, 0], rpy: [0, 0, 0] };
    if (inertia3x3 && inertia3x3.length === 3) {
        p.ixx = inertia3x3[0][0];
        p.iyy = inertia3x3[1][1];
        p.izz = inertia3x3[2][2];
        p.ixy = inertia3x3[0][1];
        p.ixz = inertia3x3[0][2];
        p.iyz = inertia3x3[1][2];
    }
    return p;
}

export class RobCoModuleAdapter {
    /**
     * @param {Object} opts
     * @param {string} opts.baseUrl          - robot_modules base URL (no trailing slash needed).
     * @param {string[]} opts.moduleIds      - module ids making up the robot (base->flange).
     * @param {Object} [opts.mapping]        - pre-fetched module_folder_mapping.json.
     * @param {(url:string)=>Promise<Object>} [opts.fetchJson] - injectable JSON fetcher (tests).
     * @returns {Promise<UnifiedRobotModel>}
     */
    static async build({ baseUrl, moduleIds, mapping = null, fetchJson = defaultFetchJson }) {
        const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
        const map = mapping || (await fetchJson(`${base}/${MODULE_MAPPING_FILE}`));

        const orderedIds = chainOrder(map, moduleIds);
        if (orderedIds.length === 0) {
            throw new Error('[RobCo] no kinematic modules to build after filtering');
        }

        // Fetch descriptors + build geometry nodes in chain order. The chain index keeps
        // names unique when a module id repeats (e.g. two D116 drives in one arm).
        const nodes = [];
        for (let idx = 0; idx < orderedIds.length; idx++) {
            const id = orderedIds[idx];
            const entry = map[id];
            const folderUrl = `${base}/${entry.folderName}`;
            const descriptor = await fetchJson(`${folderUrl}/${entry.fileName}`);
            const node = new RobotModuleNode(id, idx);
            await node.initFromJSON(descriptor, folderUrl);
            nodes.push(node);
        }

        // Serial chain: each module's proximal attaches under the previous module's distal.
        for (let i = 1; i < nodes.length; i++) {
            nodes[i].setParent(nodes[i - 1]);
        }

        const model = this.toUnifiedModel(nodes);
        // Stash the exact rebuild descriptor so a saved session can reconstruct this robot
        // ({baseUrl, moduleIds}). orderedIds is the post-filter base->flange chain actually built
        // (includes clamps), so it round-trips deterministically through chainOrder on rebuild.
        model.userData.baseUrl = base;
        model.userData.moduleIds = orderedIds.slice();
        return model;
    }

    /**
     * Wrap a chained list of RobotModuleNodes as a UnifiedRobotModel.
     * @param {RobotModuleNode[]} nodes - chained base->flange.
     * @returns {UnifiedRobotModel}
     */
    static toUnifiedModel(nodes) {
        const model = new UnifiedRobotModel();
        model.name = 'robco-robot';
        model.threeObject = nodes[0].getProximalLink();
        model.threeObject.userData = model.threeObject.userData || {};
        model.threeObject.userData.type = 'robco';

        const jointOrder = [];

        for (const node of nodes) {
            const d = node.descriptor || {};
            const dyn = d.dynamics || {};
            const mp = d.module_properties || {};

            // Proximal link (the fixed body of the module).
            const proximalLink = new Link(node.proximal.name);
            proximalLink.threeObject = node.proximal;
            proximalLink.inertial = toInertial(
                dyn.proximal_mass,
                dyn.proximal_inertia,
                dyn.proximal_center_of_mass,
            );
            proximalLink.userData.descriptor = d;
            proximalLink.userData.moduleId = node.moduleId;
            proximalLink.userData.side = 'proximal';
            model.addLink(proximalLink);

            if (node.isDriveModule) {
                // Distal link (the rotating output of the drive).
                const distalLink = new Link(node.distal.name);
                distalLink.threeObject = node.distal;
                distalLink.inertial = toInertial(
                    dyn.distal_mass,
                    dyn.distal_inertia,
                    dyn.distal_center_of_mass,
                );
                distalLink.userData.descriptor = d;
                distalLink.userData.moduleId = node.moduleId;
                distalLink.userData.side = 'distal';
                model.addLink(distalLink);

                // Revolute joint about local Z, driving the distal node. Name includes the
                // chain index so repeated drive ids (e.g. two D116) stay distinct.
                const joint = new Joint(`${node.seq}_${node.moduleId}_${node.name}`, 'revolute');
                joint.parent = proximalLink.name;
                joint.child = distalLink.name;
                joint.axis = { xyz: [0, 0, 1] };
                joint.currentValue = 0;

                const limits = new JointLimits();
                // Every RobCo axis travels ±270° — apply uniformly (see robcoLimits.js),
                // not the descriptor's q_*_hard (often absent -> would default to ±180°).
                limits.lower = -ROBCO_AXIS_LIMIT_RAD;
                limits.upper = ROBCO_AXIS_LIMIT_RAD;
                if (mp.peak_torque !== undefined) limits.effort = mp.peak_torque;
                if (mp.max_velocity !== undefined) limits.velocity = mp.max_velocity;
                joint.limits = limits;

                // Bridge to the existing universal joint setter: the URDF code path calls
                // joint.threeObject.setJointValue(angleRad). We point threeObject at the
                // distal node and give it that method + a `limit` for ignore-limits support.
                const distalObj = node.distal;
                distalObj.limit = { lower: limits.lower, upper: limits.upper };
                distalObj.setJointValue = (angleRad) => node.setJointAngleRad(angleRad);
                joint.threeObject = distalObj;

                model.addJoint(joint);
                jointOrder.push(joint.name);
            }
        }

        model.rootLink = nodes[0].proximal.name;
        model.userData = {
            type: 'robco',
            jointOrder, // joint names in base->flange order (matches live jointAngles[])
            moduleNodes: nodes,
        };
        return model;
    }
}
