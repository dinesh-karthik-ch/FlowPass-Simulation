# FlowPass — 3D Intelligent Distance-Based Highway Tolling Simulator

FlowPass is an educational prototype that demonstrates how a vehicle's simulated position can be used to detect entry and exit gates, track eligible distance, and estimate a distance-based highway toll. It combines a real-time 3D driving simulator with an Express telemetry API.

> **Prototype notice:** FlowPass uses synthetic/simulated vehicle coordinates and fictional routes. It is not connected to a real vehicle GNSS receiver and must not be used for real-world toll collection or billing.

## Highlights

- **Interactive 3D driving:** drive along the highway, use the ramps, and explore the environment.
- **Bidirectional journeys:** simulate northbound and southbound travel.
- **Automatic gate-based direction and exit handling:** the backend processes the gate crossings and route position received in telemetry; the driver does not preselect an exit.
- **Distance-based toll estimate:** toll is calculated by the backend using the eligible simulated distance and configured rate.
- **Multiple environments:** North Expressway, Pine Valley Route, and Dusk Ridge Bypass.
- **Traffic/NPC toggle:** show or hide background traffic vehicles.
- **Telemetry dashboard:** inspect vehicle dynamics, simulated position, trip progress, API health, latency, and event history.
- **CSV export:** export captured telemetry from the dashboard for further analysis.
- **Driving options:** keyboard, on-screen controls, and supported gamepad input; multiple camera and graphics-quality options.
- **Automated tests:** Node.js test suites for vehicle physics and backend telemetry/journey processing.

## Architecture

```text
flowpass/
├── client/                  React + Vite + Three.js / React Three Fiber
│   ├── src/App.jsx          App orchestration, telemetry, trip and dashboard state
│   ├── src/Scene3D.jsx      3D scene component
│   ├── src/scene.jsx        Road, vehicle, scenery and camera elements
│   ├── src/physics.js       Vehicle movement and handling logic
│   ├── src/input.js         Keyboard, touch and gamepad input
│   ├── src/hud.jsx          Driving HUD and telemetry visuals
│   ├── src/constants.js     Routes, world configuration and helpers
│   ├── src/sound.js         Simulation sound effects
│   └── test/                Vehicle physics tests
└── server/
    ├── server.js            Express API, gate detection, journey state and toll logic
    └── test/                Backend telemetry and journey tests
```

The browser simulates vehicle movement and sends telemetry to the API. The backend is authoritative for journey-state transitions and toll calculations. The backend keeps journey state **in memory**, so restarting it clears active sessions and history.

## Requirements

- Node.js 18 or later (a current LTS release is recommended)
- npm
- A modern browser with WebGL support
- Git (optional, for version control)

## Run locally

Open a terminal at the extracted `flowpass` project root.

### 1. Configure the backend

```bash
cd server
npm install
```

Copy `server/.env.example` to `server/.env` if you want to override defaults. The example settings are:

```env
PORT=4000
TOLL_RATE_PER_KM=2.50
```

Start the API:

```bash
npm run dev
```

The API should be available at `http://localhost:4000`. Check `http://localhost:4000/api/health` in your browser.

### 2. Configure and start the frontend

Open a **second terminal** at the `flowpass` project root:

```bash
cd client
npm install
```

The client reads its backend URL from `VITE_API_URL`. By default it uses `http://localhost:4000`. To override it, copy `client/.env.example` to `client/.env` and set:

```env
VITE_API_URL=http://localhost:4000
```

Start Vite:

```bash
npm run dev
```

Open the local URL printed by Vite, usually `http://localhost:5173`. Keep both terminals running while using the simulator.

## Controls

| Key / input | Action |
|---|---|
| `W` / `↑` | Accelerate |
| `S` / `↓` | Brake, then reverse |
| `A` / `D` / `←` / `→` | Steer |
| `Q` / `E` | Sidestep in Free steering mode |
| `Space` | Handbrake; combine with steering to drift |
| `Shift` | Boost while accelerating |
| `C` | Cycle camera views |
| `L` | Toggle headlights |
| `G` | Switch Free / Realistic steering |
| `F` | Recover onto the road |
| `P` / `Esc` | Pause / resume |
| `Enter` | Start driving |
| `R` | Reset trip |
| `T` / `H` | Open Telemetry / Controls tab |

Use the on-screen touch controls on touch devices. Gamepad support includes trigger-based pedals and controller buttons for steering-related actions, handbrake, boost, camera, and pause; exact mappings are also shown in the in-app Controls panel.

## Bidirectional toll journey

FlowPass supports northbound and southbound simulated journeys. Entry and exit decisions are made from the vehicle telemetry and the gate/route logic, rather than by selecting an exit in advance.

| Direction | Entry gate | Possible exits |
|---|---|---|
| Northbound | A | B or C ramp, or D on the mainline |
| Southbound | D | C or B mirrored ramp, or A on the mainline |

After a charged journey completes, use **Drive Again** to repeat the same direction or **Continue in Reverse** to start a new journey from the opposite end. Passing a ramp gate while staying on the mainline should not by itself complete the trip; the vehicle must follow the relevant exit path. Returning through the entry gate is treated as a non-billable return rather than a normal toll exit.

## Toll model

The default rate is **₹2.50 per kilometre**. The backend uses the configured rate (`TOLL_RATE_PER_KM`) and the eligible simulated journey distance to calculate the estimated toll. Ramp geometry receives a route-length correction so the estimate is not based only on a straight-line shortcut. The routes and coordinates are fictional and are intended only for demonstration.

## Telemetry dashboard

The Telemetry view provides information such as:

- Speed, acceleration, lateral G, yaw rate, steering, throttle, and braking
- Simulated coordinates, route progress, lane offset, road surface, odometer, and trip time
- Recent speed, acceleration, and lane-offset charts
- API connection status, request latency, sent/acknowledged/failed counts, and freshness indicators
- Event history for entry, exit, and journey completion
- CSV export of the captured telemetry session

The client sends periodic telemetry samples and sends additional samples around gate crossings to help the backend detect transitions. The values represent the simulator, not measurements from a real vehicle or GNSS receiver.

## API reference

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/` | API service status |
| `GET` | `/api/health` | Health status, uptime, and configured toll rate |
| `GET` | `/api/routes` | Route and gate configuration |
| `GET` | `/api/state` | Current in-memory journey state and recent history |
| `POST` | `/api/reset` | Register/reset a vehicle session |
| `POST` | `/api/telemetry` | Submit a simulated vehicle telemetry sample |

The backend accepts JSON requests. See `server/server.js` for the exact payload validation and response structure.

## Tests and production build

Run backend tests:

```bash
cd server
npm test
```

Run frontend physics tests:

```bash
cd client
npm test
```

Create a production frontend build:

```bash
cd client
npm run build
```

Preview the production build locally:

```bash
npm run preview
```

Run tests and build before publishing changes. If a test or build fails, resolve it before deploying rather than assuming the project is ready.

## Deployment overview

The frontend and backend are separate services and should be deployed separately.

### Backend service

A Node-compatible hosting service (for example, Render) can run the API from the `server` directory:

- **Root directory:** `server`
- **Build command:** `npm install`
- **Start command:** `npm start`
- **Environment variables:** `TOLL_RATE_PER_KM=2.50`; the hosting platform normally provides `PORT`

After deployment, verify `https://YOUR-BACKEND-HOST/api/health` returns JSON with a successful status.

### Frontend static site

A static hosting service (for example, Netlify) can build the Vite client from the `client` directory:

- **Base/root directory:** `client`
- **Build command:** `npm run build`
- **Publish directory:** `dist`
- **Environment variable:** `VITE_API_URL=https://YOUR-BACKEND-HOST` (the base URL only; do not append `/api/telemetry`)

Vite environment variables are embedded at build time. Set `VITE_API_URL` in the hosting dashboard and trigger a fresh deployment after changing it. Then open the deployed site and confirm the API indicator shows **CONNECTED** and that `/api/health` is reachable. The backend currently enables CORS; for a public production system, configure allowed origins explicitly.

## Known limitations

- Vehicle coordinates are synthetic and are not obtained from real GPS/GNSS hardware.
- Roads, gates, and routes are fictional simulation geometry.
- Backend journey state and history are in memory and are lost when the server restarts.
- Authentication, persistent storage, and multi-user production hardening are not implemented.
- The prototype has not been validated for real-road distance accuracy, safety, or real toll collection.
- Rendering performance depends on the user's GPU and browser; use the in-app graphics-quality control to trade visual detail for frame rate.

## Repository hygiene

- Keep real secrets and local `.env` files out of Git. Commit only `.env.example` templates.
- Do not commit `node_modules/` or generated build output unless your deployment workflow explicitly requires it.
- Review `git status` before committing.

## License

No license has been specified in this repository. Unless a license is added, all rights remain with the copyright holder and reuse is not automatically granted.
