import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';

dotenv.config();
export const app = express();
app.use(cors());
app.use(express.json({ limit: '32kb' }));
const PORT = Number(process.env.PORT || 4000);
const TOLL_RATE_PER_KM = Math.max(0, Number(process.env.TOLL_RATE_PER_KM || 2.5));
const DEFAULT_VEHICLE = 'FP-3D-001';
const journeys = new Map();
const history = [];
const MAX_HISTORY = 200;
// Authoritative fictional route configuration. Clients send a route ID, never zone boundaries.
export const ROUTES = Object.freeze({
  express: { name: 'North Expressway', start: 170, end: 1130, entry: 170, exit: 1130, length: 1200,
    gates: [{ id: 'A', position: 170, x: 0, kind: 'ENTRY' }, { id: 'B', position: 700, x: 18, kind: 'EXIT' }, { id: 'C', position: 935, x: 23, kind: 'EXIT' }, { id: 'D', position: 1130, x: 0, kind: 'EXIT' }] },
  forest: { name: 'Pine Valley Route', start: 130, end: 1040, entry: 130, exit: 1040, length: 1200,
    gates: [{ id: 'A', position: 130, x: 0, kind: 'ENTRY' }, { id: 'B', position: 530, x: 18, kind: 'EXIT' }, { id: 'C', position: 770, x: 23, kind: 'EXIT' }, { id: 'D', position: 1040, x: 0, kind: 'EXIT' }] },
  dusk: { name: 'Dusk Ridge Bypass', start: 220, end: 1120, entry: 220, exit: 1120, length: 1200,
    gates: [{ id: 'A', position: 220, x: 0, kind: 'ENTRY' }, { id: 'B', position: 670, x: 18, kind: 'EXIT' }, { id: 'C', position: 905, x: 23, kind: 'EXIT' }, { id: 'D', position: 1120, x: 0, kind: 'EXIT' }] }
});

/* Two-way operation: northbound traffic (progress increasing) enters at A and leaves at B / C / D;
 * southbound traffic (progress decreasing) enters at D and leaves at C / B / A. Southbound branch ramps
 * mirror the northbound ones (x < 0) and run over the 130 m ending at their gate. */
const RAMP_LEN = 130;
function reverseGatesOf(route) {
  const entry = route.gates.find(g => g.kind === 'ENTRY');
  const last = route.gates.filter(g => g.kind === 'EXIT' && !(g.x || 0)).reduce((a, b) => (b.position > a.position ? b : a));
  const ramps = route.gates.filter(g => g.kind === 'EXIT' && (g.x || 0) !== 0).slice().reverse().map(g => ({ id: g.id, position: g.position, x: -g.x, kind: 'EXIT', dir: -1 }));
  return [{ id: last.id, position: last.position, x: 0, kind: 'ENTRY', dir: -1 }, ...ramps, { id: entry.id, position: entry.position, x: 0, kind: 'EXIT', dir: -1 }];
}
for (const r of Object.values(ROUTES)) r.reverseGates = reverseGatesOf(r);
function rampCentre(g, position) {
  const dir = g.dir === -1 ? -1 : 1;
  const start = dir === 1 ? g.position - RAMP_LEN : g.position + RAMP_LEN;
  const t = Math.max(0, Math.min(1, dir * (position - start) / RAMP_LEN)), sm = t * t * (3 - 2 * t);
  return (g.x < 0 ? -1 : 1) * (6.4 + (Math.abs(g.x) - 6.4) * sm);
}

function validCoordinate(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 && !(lat === 0 && lon === 0);
}
function newJourney(vehicleId, sessionId = 'default', routeKey = 'express') {
  return { vehicleId, sessionId, routeKey, targetExitGate: null, lastSequence: -1, journey: 'INACTIVE', geofence: 'OUTSIDE', distanceMeters: 0, toll: 0,
    lastPosition: null, lastLatitude: null, lastLongitude: null, entryCount: 0, exitCount: 0, event: 'NONE', startedAt: null, endedAt: null,
    activeEntryGate: null, activeEntryPosition: null, exitGate: null, rampVisited: {}, direction: null,
    totalTelemetryCount: 0,
    // Driving statistics (server-side, from accepted samples)
    maxSpeed: 0, speedSum: 0, lastHeading: null, lastLateral: null, lastAcceleration: null };
}
function getJourney(vehicleId, sessionId, routeKey) {
  let s = journeys.get(vehicleId);
  if (!s || s.sessionId !== sessionId) { s = newJourney(vehicleId, sessionId, routeKey); journeys.set(vehicleId, s); }
  return s;
}
// Optional numeric telemetry fields: absent is fine, present must be finite and in range.
function optionalNumber(value, min, max) {
  if (value === undefined || value === null) return { ok: true, value: null };
  const n = Number(value);
  return { ok: Number.isFinite(n) && n >= min && n <= max, value: n };
}
function round(n, places = 2) { const p = 10 ** places; return Math.round(n * p) / p; }
/** Extra distance (metres) driven on a branch ramp compared with the straight mainline stretch it replaces. */
function rampExtraLength(gate) {
  if (!(gate.x || 0)) return 0;
  const dx = Math.abs(gate.x) - 6.4; let length = 0, px = 0, pz = 0;
  for (let i = 1; i <= 24; i++) {
    const t = i / 24, x = dx * t * t * (3 - 2 * t), z = RAMP_LEN * t;
    length += Math.hypot(x - px, z - pz); px = x; pz = z;
  }
  return Math.max(0, length - RAMP_LEN);
}

app.get('/', (_req, res) => res.json({ service: 'FlowPass 3D Telemetry API', status: 'ok', educationalPrototype: true }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'FlowPass', build: 'two-way-continuation-exit-fix-2026-10-21-r5', timestamp: new Date().toISOString(), tollRatePerKm: TOLL_RATE_PER_KM, uptime: process.uptime() }));
app.get('/api/routes', (_req, res) => res.json({ routes: ROUTES, tollRatePerKm: TOLL_RATE_PER_KM }));
app.get('/api/state', (_req, res) => res.json({ journeys: [...journeys.values()], history: history.slice(0, 30) }));

app.post('/api/reset', (req, res) => {
  try {
    const vehicleId = String(req.body?.vehicleId || DEFAULT_VEHICLE).trim().slice(0, 40);
    const sessionId = String(req.body?.sessionId || `reset-${Date.now()}`).slice(0, 100);
    const routeKey = ROUTES[req.body?.routeKey] ? req.body.routeKey : 'express';
    const state = newJourney(vehicleId, sessionId, routeKey); state.event = 'RESET';
    journeys.set(vehicleId, state);
    // Reset intentionally clears this vehicle's event history for a clean demonstration.
    for (let i = history.length - 1; i >= 0; i--) if (history[i].vehicleId === vehicleId) history.splice(i, 1);
    console.log(`[RESET] vehicle=${vehicleId} session=${sessionId} route=${routeKey} exitMode=auto-detect`);
    res.json({ ok: true, vehicleId, sessionId, routeKey, exitMode: 'auto-detect', event: 'RESET', journey: 'INACTIVE', geofence: 'OUTSIDE', distanceMeters: 0, toll: 0 });
  } catch (e) {
    console.error('[RESET Error]', e.message);
    res.status(500).json({ error: 'Reset failed' });
  }
});

app.post('/api/telemetry', (req, res) => {
  try {
    const b = req.body || {};
    const vehicleId = String(b.vehicleId || '').trim().slice(0, 40);
    const sessionId = String(b.sessionId || '').trim().slice(0, 100);
    const routeKey = String(b.routeKey || '');
    const route = ROUTES[routeKey];
    // Exit is inferred from the path actually driven; legacy exitTarget fields are ignored.
    const lat = Number(b.latitude), lon = Number(b.longitude), speed = Number(b.speed), position = Number(b.simPosition), sequence = Number(b.sequence);
    const hd = optionalNumber(b.heading, 0, 360), lateral = optionalNumber(b.lateralOffset, -1000, 1000), accel = optionalNumber(b.acceleration, -200, 200);
    if (!hd.ok || !lateral.ok || !accel.ok) {
      return res.status(400).json({ accepted: false, error: 'Invalid optional telemetry field (heading 0-360, lateralOffset ±1000 m, acceleration ±200 m/s²)' });
    }
    if (!vehicleId || !sessionId || !route || !validCoordinate(lat, lon) || !Number.isFinite(speed) || speed < 0 || speed > 400 ||
        !Number.isFinite(position) || position < -1 || position > route.length + 1 || !Number.isSafeInteger(sequence) || sequence < 0) {
      return res.status(400).json({ accepted: false, error: 'Invalid telemetry payload or unknown route',
        debug: { vehicleId: !!vehicleId, sessionId: !!sessionId, route: !!route, lat, lon, speed, position, sequence } });
    }
    // Clamp position to valid range after validation (allow slight overshoot from physics)
    const clampedPosition = Math.max(0, Math.min(route.length, position));

    let state = journeys.get(vehicleId);
    if (!state || state.sessionId !== sessionId) {
      // A reset establishes a new session before telemetry is accepted.
      return res.status(409).json({ accepted: false, error: 'Unknown or expired trip session; reset trip first', needsReset: true });
    }
    if (state.routeKey !== routeKey) return res.status(409).json({ accepted: false, error: 'Route mismatch; reset trip before switching routes', needsReset: true });
    if (sequence <= state.lastSequence) return res.status(409).json({ accepted: false, stale: true, error: 'Out-of-order telemetry rejected', lastSequence: state.lastSequence });
    // No destination is preselected. The first exit whose actual road corridor is traversed wins.

    state.totalTelemetryCount++;
    state.maxSpeed = Math.max(state.maxSpeed, speed); state.speedSum += speed;
    state.lastHeading = hd.value; state.lastAcceleration = accel.value;
    const previous = state.lastPosition;
    let event = 'NONE';
    let crossedGate = null;
    const gatesFor = sg => (sg > 0 ? route.gates : route.reverseGates);
    const lat0 = lateral.value ?? 0;

    // Track every branch ramp of the ACTIVE direction independently. The exit is chosen by the vehicle's
    // actual lateral position, not a UI selector; ramps use the same smoothstep centreline as the 3D scene,
    // so passing B/C on the mainline never counts as an exit. sg = +1 northbound, -1 southbound.
    if (state.journey === 'ACTIVE') {
      const sg = state.direction === 'REVERSE' ? -1 : 1;
      for (const gate of gatesFor(sg).filter(g => g.kind === 'EXIT' && (g.x || 0) !== 0)) {
        const rampStart = sg > 0 ? gate.position - RAMP_LEN : gate.position + RAMP_LEN;
        if (sg * clampedPosition < sg * rampStart - 4 || sg * clampedPosition > sg * gate.position + 12) continue;
        const centre = rampCentre(gate, clampedPosition), previousCentre = rampCentre(gate, previous ?? clampedPosition);
        // Allow a little more tolerance for frame/API sampling gaps. Use lateral magnitude as a fallback:
        // in a 3D driving demo, steering sign can vary with vehicle heading/camera convention, but the
        // backend should still recognize that the vehicle followed the ramp's outward arc.
        const currentNear = Math.abs(lat0 - centre) <= 15 || Math.abs(Math.abs(lat0) - Math.abs(centre)) <= 12;
        const previousLat = state.lastLateral ?? 9999;
        const previousNear = Math.abs(previousLat - previousCentre) <= 15 || Math.abs(Math.abs(previousLat) - Math.abs(previousCentre)) <= 12;
        if (currentNear || previousNear) state.rampVisited[gate.id] = true;
      }
    }

    if (previous !== null) {
      if (state.journey !== 'ACTIVE') {
        // Either end of the route can be an entry: A when driving north, D when driving south.
        const fEntry = route.gates.find(g => g.kind === 'ENTRY'), rEntry = route.reverseGates.find(g => g.kind === 'ENTRY');
        let started = null;
        if (previous < fEntry.position && clampedPosition >= fEntry.position) started = { gate: fEntry, direction: 'FORWARD', distance: clampedPosition - fEntry.position };
        else if (previous > rEntry.position && clampedPosition <= rEntry.position) started = { gate: rEntry, direction: 'REVERSE', distance: rEntry.position - clampedPosition };
        if (started) {
          state.journey = 'ACTIVE'; state.geofence = 'INSIDE'; state.direction = started.direction;
          state.distanceMeters = Math.max(0, started.distance); state.toll = state.distanceMeters / 1000 * TOLL_RATE_PER_KM;
          state.activeEntryGate = started.gate.id; state.activeEntryPosition = started.gate.position; state.exitGate = null; state.targetExitGate = null; state.rampVisited = {};
          state.startedAt = new Date().toISOString(); state.endedAt = null; state.entryCount++;
          event = 'ENTRY'; crossedGate = started.gate;
        }
      } else {
        const sg = state.direction === 'REVERSE' ? -1 : 1;
        const exitGates = gatesFor(sg).filter(g => g.kind === 'EXIT');
        // movingOn: allow a small tolerance for diagonal/sideways movement on ramps where the
        // along-road component may briefly go the wrong way. Gate crossing is checked bidirectionally.
        const movingOn = sg * (clampedPosition - previous) >= -3;
        const exitsHit = movingOn
          ? exitGates.filter(g => {
              // Gate must be ahead of entry, and the vehicle must have just crossed the gate line
              // (previous was before the gate, or we're within a generous window for this sample rate).
              if (sg * g.position <= sg * state.activeEntryPosition) return false;
              // Allow a wider crossing window (±8 m) to compensate for 250 ms telemetry gaps.
              const crossed = sg * previous >= sg * g.position - 8 && sg * previous <= sg * g.position + 4 &&
                              sg * clampedPosition >= sg * g.position - 4;
              const justPast = sg * previous < sg * g.position && sg * clampedPosition >= sg * g.position - 4;
              if (!crossed && !justPast) return false;
              if (!(g.x || 0)) {
                // Straight-through gate (D northbound or A southbound): vehicle must be near the centreline.
                return Math.abs(lat0) <= 14 || Math.abs(state.lastLateral ?? 9999) <= 14;
              }
              // Branch exit: valid only when the vehicle actually followed the ramp corridor.
              const centre = rampCentre(g, clampedPosition), previousCentre = rampCentre(g, previous);
              const previousLat = state.lastLateral ?? 9999;
              // Accept if near the ramp at the gate or at the previous sample (handles fast crossing).
              // Also accept by absolute offset magnitude to handle mirrored southbound conventions.
              const nearGate = Math.abs(lat0 - centre) <= 16 || Math.abs(Math.abs(lat0) - Math.abs(centre)) <= 11 ||
                Math.abs(previousLat - previousCentre) <= 16 || Math.abs(Math.abs(previousLat) - Math.abs(previousCentre)) <= 11;
              const traversedRamp = !!state.rampVisited[g.id] || nearGate;
              return traversedRamp && nearGate && Math.abs(lat0) >= 8;
            }).sort((a, b) => sg * a.position - sg * b.position)
          : [];
        const exitHit = exitsHit[0];
        const returnedToEntry = sg * clampedPosition < sg * previous && sg * previous > sg * state.activeEntryPosition && sg * clampedPosition <= sg * state.activeEntryPosition;
        if (exitHit) {
          // Final distance = what was actually driven inside the corridor (including any back-and-forth),
          // up to the exit gate line, plus the extra length of the curved ramp when a branch exit is used.
          state.distanceMeters += Math.abs(exitHit.position - previous) + rampExtraLength(exitHit);
          state.journey = 'COMPLETED'; state.geofence = 'OUTSIDE'; state.exitCount++;
          state.targetExitGate = exitHit.id; state.exitGate = exitHit.id; state.endedAt = new Date().toISOString();
          state.toll = state.distanceMeters / 1000 * TOLL_RATE_PER_KM;
          event = 'EXIT'; crossedGate = exitHit;
        } else if (returnedToEntry) {
          // Going back out through the gate we came in by is a non-billable cancellation, not a paid exit.
          state.distanceMeters += Math.abs(previous - state.activeEntryPosition);
          state.journey = 'RETURNED_TO_ENTRY'; state.geofence = 'OUTSIDE';
          state.exitGate = state.activeEntryGate; state.targetExitGate = null; state.endedAt = new Date().toISOString();
          state.toll = state.distanceMeters / 1000 * TOLL_RATE_PER_KM; // reading is kept on screen after returning
          event = 'RETURN_TO_ENTRY'; crossedGate = { id: state.activeEntryGate, position: state.activeEntryPosition, kind: 'RETURN' };
        } else {
          // Live estimate while driving; final amount is recomputed using the actual exit path.
          state.distanceMeters += Math.abs(clampedPosition - previous);
          state.geofence = 'INSIDE'; state.toll = state.distanceMeters / 1000 * TOLL_RATE_PER_KM;
        }
      }
    }
    if (state.journey !== 'ACTIVE') state.geofence = 'OUTSIDE';
    console.log(`[TELEMETRY] session=${sessionId} seq=${sequence} pos=${clampedPosition.toFixed(1)} lateral=${(lateral.value ?? 0).toFixed(1)} ramps=${Object.keys(state.rampVisited).join(',') || '-'} exit=${state.exitGate || '-'} event=${event} journey=${state.journey}`);
    const record = { id: `${sessionId}-${sequence}`, timestamp: new Date().toISOString(), vehicleId, sessionId, sequence,
      latitude: lat, longitude: lon, speed, simPosition: clampedPosition, routeKey, routeName: route.name,
      heading: hd.value, lateralOffset: lateral.value, acceleration: accel.value,
      geofence: state.geofence, journey: state.journey, direction: state.direction, distanceMeters: round(state.distanceMeters, 1), toll: round(state.toll), event,
      entryGate: state.activeEntryGate, exitGate: state.exitGate, targetExitGate: state.targetExitGate, crossedGate: crossedGate ? { ...crossedGate } : null };
    // Critical cursor update: without these assignments every request looked like the first sample,
    // so entry/exit detection never ran and sequence numbers were never advanced.
    state.lastPosition = clampedPosition;
    state.lastLatitude = lat; state.lastLongitude = lon; state.lastSequence = sequence; state.lastLateral = lateral.value;
    history.unshift(record); if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    res.json({ accepted: true, ...record, tollRatePerKm: TOLL_RATE_PER_KM, entryCount: state.entryCount, exitCount: state.exitCount,
      startedAt: state.startedAt, endedAt: state.endedAt, lastSequence: state.lastSequence, entryGate: state.activeEntryGate, exitGate: state.exitGate, targetExitGate: state.targetExitGate,
      stats: { samples: state.totalTelemetryCount, maxSpeed: round(state.maxSpeed, 1), avgSpeed: round(state.speedSum / state.totalTelemetryCount, 1) } });
  } catch (e) {
    console.error('[Telemetry Error]', e.message, e.stack);
    res.status(500).json({ accepted: false, error: 'Server error processing telemetry' });
  }
});

// Error middleware must come after the routes. Malformed JSON is a client error, not a server crash.
app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) return res.status(400).json({ accepted: false, error: 'Malformed JSON body' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ accepted: false, error: 'Payload too large' });
  console.error('[FlowPass API Error]', err?.message || err);
  res.status(500).json({ error: 'Internal server error' });
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(PORT, () => console.log(`FlowPass 3D API listening on http://localhost:${PORT}`));
}
