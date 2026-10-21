import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../server.js';
let server, base;
let session = 'test-session-1';
let seq = 0;
const vehicleId = 'TEST-VEHICLE';
async function post(path, body) {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}
async function reset(routeKey = 'express', id = session) {
  session = id; seq = 0;
  return post('/api/reset', { vehicleId, sessionId: session, routeKey });
}
async function telemetry(position, routeKey = 'express', overrides = {}) {
  return post('/api/telemetry', { vehicleId, sessionId: session, sequence: seq++, latitude: 11.1 + position / 111000, longitude: 77.1, speed: 36, simPosition: position, routeKey, lateralOffset: 0, ...overrides });
}
before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });
test('health endpoint reports healthy service', async () => {
  const r = await fetch(`${base}/api/health`); assert.equal(r.status, 200); assert.equal((await r.json()).status, 'ok');
});
test('route API exposes one entry and multiple exit gates', async () => {
  const r = await fetch(`${base}/api/routes`); const data = await r.json();
  assert.equal(data.routes.express.gates[0].id, 'A');
  assert.deepEqual(data.routes.express.gates.filter(g => g.kind === 'EXIT').map(g => g.id), ['B', 'C', 'D']);
});
test('invalid telemetry is rejected', async () => {
  await reset();
  const r = await telemetry(200, 'express', { latitude: 999 });
  assert.equal(r.status, 400); assert.equal(r.data.accepted, false);
});
test('automatic path detection completes Exit B only when the B ramp is driven', async () => {
  await reset('express', 'auto-exit-b'); await telemetry(100); await telemetry(300); await telemetry(500);
  await telemetry(600, 'express', { lateralOffset: 8.0 });
  await telemetry(650, 'express', { lateralOffset: 14.0 });
  const exit = await telemetry(710, 'express', { lateralOffset: 18.0 });
  assert.equal(exit.data.event, 'EXIT'); assert.equal(exit.data.exitGate, 'B');
  assert.ok(exit.data.distanceMeters > 480); assert.ok(exit.data.toll > 1.2);
});
test('passing B on the mainline does not end the trip', async () => {
  await reset('express', 'pass-b-mainline'); await telemetry(100); await telemetry(300); await telemetry(500);
  const passB = await telemetry(750, 'express', { lateralOffset: 0 });
  assert.equal(passB.data.event, 'NONE'); assert.equal(passB.data.journey, 'ACTIVE');
});
test('automatic path detection completes Exit C after taking the C ramp', async () => {
  await reset('express', 'auto-exit-c'); await telemetry(100); await telemetry(300); await telemetry(800);
  await telemetry(840, 'express', { lateralOffset: 9.4 });
  await telemetry(890, 'express', { lateralOffset: 18.3 });
  const exit = await telemetry(950, 'express', { lateralOffset: 23.0 });
  assert.equal(exit.data.event, 'EXIT'); assert.equal(exit.data.exitGate, 'C');
  assert.ok(exit.data.distanceMeters > 640); assert.ok(exit.data.toll > 1.6);
});
test('automatic path detection completes Exit D on the mainline', async () => {
  await reset('express', 'auto-exit-d'); await telemetry(100); await telemetry(300); await telemetry(600); await telemetry(900);
  const exit = await telemetry(1130, 'express', { lateralOffset: 0 });
  assert.equal(exit.data.event, 'EXIT'); assert.equal(exit.data.exitGate, 'D');
  assert.equal(exit.data.distanceMeters, 960); assert.equal(exit.data.toll, 2.4);
});
test('exit toll uses the distance actually driven, not the straight A-to-D distance', async () => {
  await reset('express', 'detour-exit-d'); await telemetry(100); await telemetry(300); await telemetry(600); await telemetry(1050); await telemetry(900);
  const exit = await telemetry(1130, 'express', { lateralOffset: 0 });
  assert.equal(exit.data.event, 'EXIT'); assert.equal(exit.data.distanceMeters, 1260);
  assert.ok(exit.data.toll > 2.4);
});
test('returning to Entry A keeps the toll reading, is not an exit and does not count as an exit', async () => {
  await reset('express', 'return-no-charge'); await telemetry(100); await telemetry(400); await telemetry(500);
  const backOut = await telemetry(100);
  assert.equal(backOut.data.event, 'RETURN_TO_ENTRY'); assert.equal(backOut.data.exitGate, 'A');
  assert.ok(backOut.data.toll > 0); assert.equal(backOut.data.journey, 'RETURNED_TO_ENTRY');
  assert.equal(backOut.data.exitCount, 0);
});

test('route configuration is authoritative and route switching requires reset', async () => {
  await reset('forest', 'route-session');
  const ok = await telemetry(200, 'forest'); assert.equal(ok.status, 200); assert.equal(ok.data.routeName, 'Pine Valley Route');
  const wrong = await telemetry(300, 'express'); assert.equal(wrong.status, 409);
});
test('stale sequence and expired session are rejected', async () => {
  await reset('express', 'fresh-session');
  const first = await telemetry(50); assert.equal(first.status, 200);
  const stale = await post('/api/telemetry', { vehicleId, sessionId: session, sequence: 0, latitude: 11.1, longitude: 77.1, speed: 0, simPosition: 60, routeKey: 'express' });
  assert.equal(stale.status, 409); assert.equal(stale.data.stale, true);
  const expired = await post('/api/telemetry', { vehicleId, sessionId: 'old-session', sequence: 10, latitude: 11.1, longitude: 77.1, speed: 0, simPosition: 60, routeKey: 'express' });
  assert.equal(expired.status, 409);
});
test('fresh trip after reset begins cleanly', async () => {
  await reset('express', 'old-trip'); await telemetry(100); await telemetry(300);
  await reset('express', 'new-trip');
  const r = await telemetry(100); assert.equal(r.status, 200); assert.equal(r.data.distanceMeters, 0); assert.equal(r.data.journey, 'INACTIVE');
});
test('extended telemetry (heading, lateral offset, acceleration) is accepted, echoed and summarised', async () => {
  await reset('express', 'extended-session'); await telemetry(100, 'express', { speed: 40 });
  const r = await telemetry(300, 'express', { speed: 80, heading: 12.5, lateralOffset: -3.2, acceleration: 2.4 });
  assert.equal(r.status, 200);
  assert.equal(r.data.heading, 12.5); assert.equal(r.data.lateralOffset, -3.2); assert.equal(r.data.acceleration, 2.4);
  assert.equal(r.data.stats.samples, 2); assert.equal(r.data.stats.maxSpeed, 80); assert.equal(r.data.stats.avgSpeed, 60);
});
test('legacy payloads without optional fields still work', async () => {
  await reset('express', 'legacy-session');
  const r = await telemetry(50); assert.equal(r.status, 200); assert.equal(r.data.heading, null);
});
test('out-of-range optional fields are rejected', async () => {
  await reset('express', 'bad-optional');
  assert.equal((await telemetry(50, 'express', { heading: 400 })).status, 400);
  assert.equal((await telemetry(50, 'express', { lateralOffset: 'abc' })).status, 400);
});
test('lateral movement does not change toll distance', async () => {
  await reset('express', 'lateral-session'); await telemetry(100);
  await telemetry(300, 'express', { lateralOffset: 40 });
  const r = await telemetry(400, 'express', { lateralOffset: -60 });
  assert.equal(r.data.distanceMeters, 230); // only longitudinal movement after entry A at 170
});
test('malformed JSON returns 400 instead of a 500', async () => {
  const r = await fetch(`${base}/api/telemetry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.equal(r.status, 400);
});

/* ---------------- two-way operation: southbound entry at D, exits at C / B / A ---------------- */
test('route API exposes the southbound gates (entry D, exits C, B, A)', async () => {
  const r = await fetch(`${base}/api/routes`); const data = await r.json();
  const rev = data.routes.express.reverseGates;
  assert.equal(rev[0].id, 'D'); assert.equal(rev[0].kind, 'ENTRY');
  assert.deepEqual(rev.filter(g => g.kind === 'EXIT').map(g => g.id), ['C', 'B', 'A']);
  assert.ok(rev.find(g => g.id === 'B').x < 0);
});
test('southbound: crossing D downward starts a journey and exiting at A charges the full distance', async () => {
  await reset('express', 'rev-exit-a'); await telemetry(1190);
  const enter = await telemetry(1100);
  assert.equal(enter.data.event, 'ENTRY'); assert.equal(enter.data.direction, 'REVERSE'); assert.equal(enter.data.entryGate, 'D');
  await telemetry(600); await telemetry(300);
  const exit = await telemetry(170, 'express', { lateralOffset: 0 });
  assert.equal(exit.data.event, 'EXIT'); assert.equal(exit.data.exitGate, 'A');
  assert.equal(exit.data.distanceMeters, 960); assert.equal(exit.data.toll, 2.4);
});
test('southbound toll equals the northbound toll for the same stretch', async () => {
  await reset('express', 'sym-fwd'); await telemetry(100); await telemetry(300); await telemetry(900);
  const fwd = await telemetry(1130, 'express', { lateralOffset: 0 });
  await reset('express', 'sym-rev'); await telemetry(1190); await telemetry(1100); await telemetry(600);
  const rev = await telemetry(170, 'express', { lateralOffset: 0 });
  assert.equal(fwd.data.toll, rev.data.toll); assert.equal(fwd.data.distanceMeters, rev.data.distanceMeters);
});
test('southbound exit at B only completes when the mirrored B ramp is driven', async () => {
  await reset('express', 'rev-exit-b'); await telemetry(1190); await telemetry(1100); await telemetry(900);
  await telemetry(800, 'express', { lateralOffset: -8.0 });
  await telemetry(750, 'express', { lateralOffset: -14.2 });
  const exit = await telemetry(690, 'express', { lateralOffset: -18.0 });
  assert.equal(exit.data.event, 'EXIT'); assert.equal(exit.data.exitGate, 'B'); assert.equal(exit.data.direction, 'REVERSE');
  assert.ok(exit.data.distanceMeters > 430); assert.ok(exit.data.toll > 1.07);
});
test('southbound: passing B and C on the mainline does not end the trip', async () => {
  await reset('express', 'rev-pass'); await telemetry(1190); await telemetry(1100); await telemetry(900);
  const passC = await telemetry(850, 'express', { lateralOffset: 0 }); const passB = await telemetry(600, 'express', { lateralOffset: 0 });
  assert.equal(passC.data.event, 'NONE'); assert.equal(passB.data.event, 'NONE'); assert.equal(passB.data.journey, 'ACTIVE');
});
test('southbound: going back out through D is a non-billable return, not an exit', async () => {
  await reset('express', 'rev-return'); await telemetry(1190); await telemetry(1100); await telemetry(900);
  const back = await telemetry(1190);
  assert.equal(back.data.event, 'RETURN_TO_ENTRY'); assert.equal(back.data.exitGate, 'D'); assert.equal(back.data.journey, 'RETURNED_TO_ENTRY');
});
test('driving south past A without having entered at D never starts a journey', async () => {
  await reset('express', 'rev-no-entry'); await telemetry(400);
  const r = await telemetry(100); assert.equal(r.data.journey, 'INACTIVE'); assert.equal(r.data.event, 'NONE');
});
test('a northbound trip is unaffected by D being a southbound entry', async () => {
  await reset('express', 'fwd-d'); await telemetry(100); await telemetry(300); await telemetry(1100);
  const r = await telemetry(1130, 'express', { lateralOffset: 0 });
  assert.equal(r.data.event, 'EXIT'); assert.equal(r.data.direction, 'FORWARD'); assert.equal(r.data.exitGate, 'D');
});


test('southbound exit at C completes when the mirrored C ramp is followed', async () => {
  await reset('express', 'rev-exit-c'); await telemetry(1190); await telemetry(1100); await telemetry(1020);
  await telemetry(990, 'express', { lateralOffset: -8.0 });
  await telemetry(955, 'express', { lateralOffset: -15.5 });
  const exit = await telemetry(925, 'express', { lateralOffset: -23.0 });
  assert.equal(exit.data.event, 'EXIT'); assert.equal(exit.data.exitGate, 'C');
  assert.equal(exit.data.direction, 'REVERSE'); assert.ok(exit.data.toll > 0);
});

test('southbound mirrored ramp exit tolerates opposite lateral sign from steering convention', async () => {
  await reset('express', 'rev-exit-b-opposite-sign'); await telemetry(1190); await telemetry(1100); await telemetry(900);
  await telemetry(800, 'express', { lateralOffset: 8.0 });
  await telemetry(750, 'express', { lateralOffset: 14.2 });
  const exit = await telemetry(690, 'express', { lateralOffset: 18.0 });
  assert.equal(exit.data.event, 'EXIT'); assert.equal(exit.data.exitGate, 'B');
  assert.equal(exit.data.direction, 'REVERSE');
});
