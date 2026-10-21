import test from 'node:test';
import assert from 'node:assert/strict';
import { createVehicle, stepVehicle, recoverVehicle, surfaceAt, CAR } from '../src/physics.js';
import { WORLD, START_Z, getScenery, simPosition, headingDegrees, cardinal } from '../src/constants.js';

const DT = 1 / 60;
const NONE = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, strafe: 0 };
function run(v, input, seconds, opts = {}) {
  const events = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) events.push(...stepVehicle(v, input, DT, opts));
  return events;
}

test('accelerates forward along -Z and respects the speed limit', () => {
  const v = createVehicle();
  run(v, { ...NONE, throttle: 1 }, 15);
  assert.ok(v.z < START_Z - 200, 'moved forward (-Z)');
  assert.ok(Math.abs(v.x) < 0.01, 'no lateral drift when going straight');
  assert.ok(v.speed <= CAR.maxFwd + 0.01 && v.speed > 30);
});

test('0-100 km/h takes a believable 3-6 seconds', () => {
  const v = createVehicle(); let t = 0;
  while (v.kmh < 100 && t < 15) { stepVehicle(v, { ...NONE, throttle: 1 }, DT); t += DT; }
  assert.ok(t > 3 && t < 6, `took ${t.toFixed(2)}s`);
});

test('boost raises top speed above the normal limit', () => {
  const v = createVehicle();
  run(v, { ...NONE, throttle: 1, boost: true }, 25);
  assert.ok(v.speed > CAR.maxFwd + 2);
});

test('can reverse (+Z) and stop cleanly', () => {
  const v = createVehicle(0, 0);
  run(v, { ...NONE, brake: 1 }, 4);
  assert.ok(v.z > 5 && v.speed < 0, 'moving backwards');
  run(v, NONE, 6);
  assert.equal(v.speed, 0);
});

test('steering right turns clockwise (+x), left turns the other way', () => {
  const r = createVehicle(0, 0); run(r, { ...NONE, throttle: 1 }, 2); run(r, { ...NONE, throttle: 1, steer: 1 }, 2);
  const l = createVehicle(0, 0); run(l, { ...NONE, throttle: 1 }, 2); run(l, { ...NONE, throttle: 1, steer: -1 }, 2);
  assert.ok(r.heading > 0.2 && r.x > 0);
  assert.ok(l.heading < -0.2 && l.x < 0);
});

test('can drive in every compass direction (full 360 degrees)', () => {
  const v = createVehicle(0, 0);
  const seen = new Set();
  for (let i = 0; i < 60 * 40; i++) {
    stepVehicle(v, { ...NONE, throttle: 0.5, steer: 0.6 }, DT);
    seen.add(cardinal(headingDegrees(v.heading)));
  }
  assert.equal(seen.size, 8, `saw ${[...seen].join(',')}`);
});

test('free mode pivots on the spot; realistic mode does not', () => {
  const free = createVehicle(0, 0); run(free, { ...NONE, steer: 1 }, 1);
  const real = createVehicle(0, 0); run(real, { ...NONE, steer: 1 }, 1, { free: false });
  assert.ok(free.heading > 0.8, 'free mode rotates in place');
  assert.equal(real.heading, 0, 'realistic mode needs motion to turn');
});

test('strafe moves the car sideways without changing heading', () => {
  const v = createVehicle(0, 0); run(v, { ...NONE, strafe: 1 }, 1.5);
  assert.ok(v.x > 5, `strafed right x=${v.x}`);
  assert.ok(Math.abs(v.heading) < 1e-6);
  const w = createVehicle(0, 0); run(w, { ...NONE, strafe: 1 }, 1.5, { free: false });
  assert.equal(w.x, 0, 'strafe disabled in realistic mode');
});

test('handbrake + steering induces a drift (slip angle + skid)', () => {
  const v = createVehicle(0, 0); run(v, { ...NONE, throttle: 1 }, 5);
  run(v, { ...NONE, throttle: 1, steer: 1, handbrake: true }, 0.4);
  assert.ok(Math.abs(v.slip) > 8, `slip ${v.slip.toFixed(1)}`);
  assert.ok(v.skid);
});

test('off-road is clearly slower than tarmac; surfaces are detected', () => {
  assert.equal(surfaceAt(0), 'ROAD'); assert.equal(surfaceAt(7), 'SHOULDER'); assert.equal(surfaceAt(20), 'OFFROAD');
  const road = createVehicle(0, 0); const grass = createVehicle(30, 0);
  run(road, { ...NONE, throttle: 1 }, 12); run(grass, { ...NONE, throttle: 1 }, 12);
  assert.ok(grass.kmh < road.kmh * 0.9);
});

test('collisions stop the car passing through obstacles and count impacts', () => {
  const v = createVehicle(0, 0);
  const obstacles = [{ x: 0, z: -40, r: 0.5 }];
  const events = run(v, { ...NONE, throttle: 1 }, 6, { obstacles });
  assert.ok(events.some(e => e.type === 'IMPACT'));
  assert.ok(v.impacts >= 1);
  assert.ok(v.z > -40 + CAR.bodyR, 'did not tunnel through the obstacle');
});

test('the world edge is a soft wall, not a crash', () => {
  const v = createVehicle(WORLD.xMax - 5, 0, Math.PI / 2);
  const events = run(v, { ...NONE, throttle: 1 }, 5);
  assert.ok(v.x <= WORLD.xMax);
  assert.ok(events.some(e => e.type === 'EDGE'));
});

test('driving anywhere off the road never makes the backend position invalid', () => {
  const v = createVehicle(200, -300);
  assert.ok(simPosition(v.z) >= 0 && simPosition(v.z) <= 1200);
  v.z = 5000; assert.equal(simPosition(v.z), 0);
});

test('recover puts the car back on the road, same route position, stationary', () => {
  const v = createVehicle(60, 100, 2); v.vx = 5; v.vz = 5;
  recoverVehicle(v);
  assert.equal(v.x, 0); assert.equal(v.z, 100); assert.equal(v.heading, 0); assert.equal(v.vx + v.vz, 0); assert.equal(v.recoveries, 1);
});

test('scenery is deterministic and keeps the carriageway clear', () => {
  const a = getScenery('forest'), b = getScenery('forest');
  assert.equal(a, b);
  assert.ok(a.trees.length > 300);
  assert.ok(a.obstacles.every(o => !(Math.abs(o.x) < 5.6 && Math.abs(o.z - a.entryZ) > 1 && Math.abs(o.z - a.exitZ) > 1)), 'no obstacle in the driving lanes');
});

test('selected exit ramp is treated as tarmac rather than off-road', async () => {
  const { START_Z } = await import('../src/constants.js');
  const progress = 600;
  const z = START_Z - progress;
  const x = 6.4 + (18 - 6.4) * ((progress - (650 - 100)) / 100);
  assert.equal(surfaceAt(x, z, 'express'), 'ROAD');
});

/* ---------------- two-way operation ---------------- */
import { ROUTES as ROUTE_TABLE, rampCentre, rampGatesOf, spawnFor, simPosition as simPos, START_Z as START } from '../src/constants.js';
import { surfaceAt as surf, resetVehicle as resetV, recoverVehicle as recoverV, createVehicle as newV } from '../src/physics.js';

test('every route has southbound gates: entry D, exits C/B/A, mirrored ramps on the left', () => {
  for (const r of Object.values(ROUTE_TABLE)) {
    const rev = r.reverseGates;
    assert.equal(rev[0].kind, 'ENTRY'); assert.equal(rev[0].id, 'D');
    assert.deepEqual(rev.filter(g => g.kind === 'EXIT').map(g => g.id), ['C', 'B', 'A']);
    for (const g of rev.filter(g => (g.x || 0) !== 0)) assert.ok(g.x < 0 && g.dir === -1);
    // gate order along the route is preserved for the planned spacing
    assert.ok(r.gates[1].position > r.gates[0].position && r.gates[3].position > r.gates[2].position);
  }
});
test('southbound ramps mirror the northbound centreline', () => {
  const g = ROUTE_TABLE.express.gates[1], m = ROUTE_TABLE.express.reverseGates.find(q => q.id === 'B');
  assert.equal(g.position, m.position);
  assert.ok(Math.abs(rampCentre(g, g.position - 65) + rampCentre(m, m.position + 65)) < 1e-9);
  assert.equal(rampCentre(m, m.position), m.x);
  assert.equal(rampCentre(m, m.position + 130), -6.4);
});
test('the southbound ramp is drivable road, the empty mirror side is not', () => {
  const m = ROUTE_TABLE.express.reverseGates.find(q => q.id === 'B');
  const z = START - (m.position + 20), x = rampCentre(m, m.position + 20);
  assert.equal(surf(x, z, 'express'), 'ROAD');
  const f = ROUTE_TABLE.express.gates[1];
  assert.equal(surf(rampCentre(f, f.position - 20), START - (f.position - 20), 'express'), 'ROAD');
  assert.equal(surf(-x, z, 'express'), 'OFFROAD'); // no northbound ramp on the left at that spot
  assert.ok(rampGatesOf(ROUTE_TABLE.express).length === 4);
});
test('southbound spawn is beyond gate D facing south and inside the route', () => {
  for (const k of Object.keys(ROUTE_TABLE)) {
    const p = spawnFor(k, 'REVERSE'), d = ROUTE_TABLE[k].reverseGates[0];
    assert.equal(p.heading, Math.PI); assert.ok(simPos(p.z) > d.position && simPos(p.z) < 1200);
    assert.deepEqual(spawnFor(k, 'FORWARD'), { x: 0, z: START, heading: 0 });
  }
});
test('reset places the car at the requested pose and recover keeps its facing', () => {
  const v = newV(); const p = spawnFor('express', 'REVERSE'); resetV(v, p);
  assert.equal(v.heading, Math.PI); assert.equal(v.z, p.z);
  v.x = 5; recoverV(v); assert.equal(v.heading, Math.PI); assert.equal(v.x, 0);
  resetV(v); assert.equal(v.heading, 0); assert.equal(v.z, START);
});
