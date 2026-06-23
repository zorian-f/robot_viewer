![screenshot](./docs/screenshot.png)

---

# Robot Viewer

[![License](https://img.shields.io/badge/license-Apache--2.0-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-web-orange.svg)](#)
[![JavaScript](https://img.shields.io/badge/language-JavaScript-f1e05a.svg)](#)
[![Three.js](https://img.shields.io/badge/Three.js-0.163-black.svg)](https://threejs.org/)
[![Vite](https://img.shields.io/badge/Vite-4.5-646cff.svg)](https://vitejs.dev/)
[![Live](https://img.shields.io/badge/🌐_live-orrerium.web.app-brightgreen?style=flat)](https://orrerium.web.app)

A web-based 3D viewer, editor and motion-planning workbench for robot models. It runs
entirely in the browser (no install, no server) on top of [Three.js](https://threejs.org/)
and a WebAssembly build of [MuJoCo](https://mujoco.org/) — load a robot description,
inspect and pose it, evaluate dynamics, and (optionally) drive a live robot through a
teach-and-waypoint workflow.

> **About this fork.** This is an independent fork of
> [fan-ziqi/robot_viewer](https://github.com/fan-ziqi/robot_viewer) that adds an
> interactive teach/IK/dynamics workbench and an optional **RobFlow integration layer**
> for connecting to a live robot session. See [Disclaimer](#disclaimer) for trademark and
> affiliation notes.

**Live instance:** https://orrerium.web.app — all model processing happens in your browser;
your models never leave your device.

---

## Features

### Model loading & visualization
- **Formats:** URDF, [Xacro](http://wiki.ros.org/xacro) (macro expansion + conditionals),
  MJCF (MuJoCo XML), USD *(partial)*, plus glTF/GLB, STL, OBJ and Collada meshes.
- **Robot types:** serial kinematic chains (parallel mechanisms not supported).
- **View panel** — toggle visual vs. **collision** geometry (real convex-decomposition
  meshes), center-of-mass markers and inertia ellipsoids, link/joint coordinate frames,
  hover-highlight a link to read its name and mass, and save a PNG screenshot.
- **Built-in code editor** (CodeMirror) with syntax highlighting and live preview.
- **Scene management** — file tree and scene-graph view of the model hierarchy.

### Posing, kinematics & IK
- Per-joint sliders and drag-to-rotate (forward kinematics).
- MuJoCo-backed **forward kinematics** and a damped-least-squares **inverse kinematics**
  solver (full 6-DOF: position + orientation targets).
- A draggable **TCP gizmo** with live IK preview, in Move or Rotate mode.

### Dynamics
- Live per-joint **dashboard**: angle, velocity, acceleration, torque and utilization.
- Inverse-dynamics torque + utilization (MuJoCo), with a velocity/acceleration estimator
  and an optional fixed-Δt smoothing interval.
- Editable **TCP payload** (mass + center-of-mass offset) reflected in torque utilization,
  with a payload marker at the tool point.

### Cell setup
- **Movable robot base** (world-frame inverse-transform) with the base pose persisted
  across reloads.
- Load and align a **scene mesh (GLB)** in the world frame.
- **End-effector import** — align a tool mesh and set its mass, CoM and optional
  tool-tip TCP.
- Configurable per-joint range.

### Teach & waypoints
- A **teach pendant**: gizmo-driven posing with gated *Send* (velocity / acceleration /
  approach) and *Stop* controls.
- **Waypoints** — capture / list / go-to / group teach poses. Each waypoint stores a
  world-frame TCP pose (so it stays put when the base moves) plus a joint snapshot; a
  multi-seed reachability retry avoids false "unreachable" results after large base moves.

### Rendering
- ACES / Neutral tone mapping with image-based lighting for a clean, metallic look.
- Load your own **HDRI/EXR** environment map, or use the built-in **procedural studio
  environment** (used by default when no HDRI is present).
- Exposure, environment, light and shadow controls; a perceptual environment-intensity
  slider; reference-grid toggle.

### UX
- Draggable, minimizable panels with persisted positions.
- Connection credentials and session persisted across reloads.

---

## RobFlow integration (optional)

In addition to offline viewing, the app can connect to a **RobFlow** robot session to
mirror and drive a live robot:

- **Connect** with an access token; the app resolves a session and opens a live link.
- **Live state** — stream joint angles over WebSocket into the viewer, with a stream-rate
  meter and diagnostics; sessions reconnect/persist across reloads.
- **Drive** — send teach-pendant moves, and push captured waypoints (joint- or
  Cartesian-space, optionally variable-bound) to a flow.

This integration is implemented entirely against RobFlow's own network interfaces using
credentials **you** supply at runtime. No RobFlow/RobCo software, assets, or credentials are
bundled in this repository. If you don't use RobFlow, every feature above except this
section works fully offline. See the [Disclaimer](#disclaimer).

---

## Getting started

Requires **Node 24** (20+ works) and **pnpm 9** (`corepack enable pnpm`).

```bash
git clone https://github.com/zorian-f/robot_viewer.git
cd robot_viewer
corepack enable pnpm
pnpm install

pnpm dev        # http://localhost:3000
pnpm build      # production build -> dist/
pnpm preview    # serve the built dist/ locally
```

The dev server sets `COOP`/`COEP` headers, required for the USD WebAssembly viewer's
`SharedArrayBuffer`; the production host mirrors this.

---

## Deployment

Hosted on **Firebase Hosting** and deployed automatically by GitHub Actions
([`.github/workflows/firebase-hosting-deploy.yml`](.github/workflows/firebase-hosting-deploy.yml)):

| Branch | Target | URL |
|---|---|---|
| `main` | Production | https://orrerium.web.app |
| `develop` | Shared dev preview | a stable `orrerium--develop-…web.app` channel |

Every push builds and deploys the app automatically — there are no manual deploy steps.
Per-pull-request preview deploys can additionally be enabled so each PR publishes its own
temporary preview URL.

---

## Contributing

Contributions are welcome. The branch model:

- **`main`** — production; always releasable, changed only via pull request.
- **`develop`** — shared integration branch backing the dev preview.
- **Feature work** — branch off `develop` (`feat/short-description`), commit using
  [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
  `refactor:`, `docs:`, `chore:`, `ci:`, `perf:`), then open a **PR into `develop`**.
  Releases go out via a `develop` → `main` PR.

New contributors: see [ONBOARDING.md](ONBOARDING.md) for a full setup and workflow guide.

**Please don't commit** secrets, `dist/`, `node_modules/`, or any proprietary HDRI/EXR
under `public/env/` (these are gitignored; the app falls back to the procedural
environment). Note that production builds strip `console.*`.

---

## Project structure

```
src/
  loaders/      URDF / Xacro / MJCF / USD / glTF / STL / OBJ / Collada loaders
  renderer/     Three.js scene, environment/IBL, MuJoCo simulation
  adapters/     model-format adapters
  controllers/  interaction & camera controllers
  dynamics/     kinematics & dynamics
  models/       unified in-memory robot model
  editor/       CodeMirror editor
  ui/  views/   panels and layout
  robco/        teach/waypoints/render/view panels + integration glue
  transport/    live session: WebSocket + REST client, token auth
  utils/
public/         static assets (USD WASM viewer, fixtures, favicon)
scripts/        validation helpers (IK / MuJoCo / WebSocket probes)
vite.config.js  build & dev config
firebase.json   hosting config (COOP/COEP, caching)
```

---

## Acknowledgements

Forked from **[fan-ziqi/robot_viewer](https://github.com/fan-ziqi/robot_viewer)**, which in
turn builds on the open-source robotics community:

- **[urdf-loader](https://github.com/gkjohnson/urdf-loaders)** — URDF loading for Three.js
- **[xacro-parser](https://github.com/gkjohnson/xacro-parser)** — ROS Xacro parser for JavaScript
- **[mujoco_wasm](https://github.com/zalo/mujoco_wasm)** — MuJoCo physics compiled to WebAssembly
- **[usd-viewer](https://github.com/needle-tools/usd-viewer)** — OpenUSD viewer
- **[mechaverse](https://github.com/jurmy24/mechaverse)** — design inspiration

---

## License

Licensed under the [Apache License 2.0](LICENSE), consistent with the upstream project.

---

## Disclaimer

This is an independent, community fork. It is **not affiliated with, endorsed by, or
sponsored by RobCo** or any robot vendor. "RobCo" and "RobFlow" are names/trademarks of
their respective owners and are used here solely to describe interoperability (nominative
use). This repository contains no proprietary RobFlow/RobCo source code, assets, or
branding; the optional integration communicates with RobFlow over its network interfaces
using credentials provided by the user at runtime. Use it in accordance with any terms that
apply to the systems you connect to.
