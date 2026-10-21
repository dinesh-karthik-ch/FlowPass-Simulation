/*
 * Vehicle physics (pure JS, no React/Three).
 *
 * Conventions
 *   - x = lateral (east +), z = along the road. "North"/forward at heading 0 is -Z.
 *   - heading increases when turning right (clockwise seen from above).
 *   - forward vector f = (sin h, -cos h), right vector r = (cos h, sin h)
 *   - world velocity (vx, vz) is stored; it is split into forward/lateral parts every step,
 *     which is what allows drifting, sliding sideways and strafing.
 */
import { START_Z, WORLD, ROAD, ROUTES, clamp, lerp, wrapAngle, onRampCorridorAt } from './constants.js';
const ROUTES_FOR_SURFACE = ROUTES;

export const CAR = { wheelbase: 2.7, maxFwd: 36, maxBoost: 44, maxRev: 10, bodyR: 1.0, bodyOffset: 1.15 };
const G = 9.81;

export function surfaceAt(x, z, routeKey = 'express') {
  const route = ROUTES_FOR_SURFACE[routeKey] || ROUTES_FOR_SURFACE.express;
  if (onRampCorridorAt(route, x, z, 6.1)) return 'ROAD';
  const a = Math.abs(x);
  return a <= ROAD.half ? 'ROAD' : a <= ROAD.shoulder ? 'SHOULDER' : 'OFFROAD';
}
const SURFACE = {
  ROAD: { drag: 1, grip: 1, top: 1 },
  SHOULDER: { drag: 1.15, grip: 0.9, top: 0.92 },
  OFFROAD: { drag: 2.4, grip: 0.55, top: 0.6 }
};

export function createVehicle(x = 0, z = START_Z, heading = 0) {
  return {
    x, z, heading, vx: 0, vz: 0, yawRate: 0,
    steer: 0, throttle: 0, brake: 0, boosting: false, skid: false,
    speed: 0,        // signed forward speed (m/s); negative = reversing
    kmh: 0,          // ground speed (km/h, always >= 0)
    slip: 0,         // slip angle (deg)
    accelLong: 0, accelLat: 0, // smoothed body accelerations (m/s²), lateral + = to the right
    surface: 'ROAD', skidIntensity: 0,
    odometer: 0, maxKmh: 0, tripTime: 0, movingTime: 0,
    impacts: 0, impactCooldown: 0, edgeCooldown: 0, shake: 0, recoveries: 0
  };
}

export function resetVehicle(v, pose = {}) { Object.assign(v, createVehicle(pose.x ?? 0, pose.z ?? START_Z, pose.heading ?? 0)); return v; }

/** Put the car back on the middle of the road at the same position along the route, facing forward. */
export function recoverVehicle(v) {
  // keep facing south if that is where the car points (two-way operation); otherwise face north
  v.x = 0; v.heading = Math.abs(wrapAngle(v.heading)) > Math.PI * 0.75 ? Math.PI : 0;
  v.vx = 0; v.vz = 0; v.yawRate = 0; v.steer = 0; v.skid = false;
  v.speed = 0; v.kmh = 0; v.recoveries++;
  return v;
}

/**
 * Advance the car by dt seconds.
 * input: { throttle 0..1, brake 0..1, steer -1..1, handbrake, boost, strafe -1..1 }
 * opts:  { free: boolean (omnidirectional assist), obstacles: [{x,z,r}] }
 * returns an array of events ({type:'IMPACT', kmh} | {type:'EDGE'})
 */
export function stepVehicle(v, input, dt, opts = {}) {
  const events = [];
  if (!(dt > 0)) return events;
  const free = opts.free !== false;
  const obstacles = opts.obstacles || [];

  v.surface = surfaceAt(v.x, v.z, opts.routeKey || 'express');
  const S = SURFACE[v.surface];
  const throttleIn = clamp(input.throttle || 0, 0, 1);
  const brakeIn = clamp(input.brake || 0, 0, 1);
  const handbrake = !!input.handbrake;
  const boost = !!input.boost && throttleIn > 0;
  const strafeIn = free ? clamp(input.strafe || 0, -1, 1) : 0;

  const pedal = Math.min(1, dt * 12);
  v.throttle += (throttleIn - v.throttle) * pedal;
  v.brake += ((handbrake ? 1 : brakeIn) - v.brake) * pedal;
  v.boosting = boost;

  const ovx = v.vx, ovz = v.vz;
  let fx = Math.sin(v.heading), fz = -Math.cos(v.heading);
  let vF = v.vx * fx + v.vz * fz;
  const vF0 = vF;
  const vmax = (boost ? CAR.maxBoost : CAR.maxFwd) * S.top;

  /* ---- longitudinal: engine, brakes, reverse, resistance ---- */
  let a = 0;
  if (throttleIn > 0) {
    if (vF < -0.5) a += 18 * throttleIn; // braking out of a reverse
    else a += (10 + (boost ? 9 : 0)) * Math.sqrt(clamp(1 - Math.max(vF, 0) / vmax, 0, 1)) * throttleIn;
  }
  if (brakeIn > 0) {
    if (vF > 0.5) a -= 18 * brakeIn;                                          // braking
    else a -= 7 * brakeIn * clamp(1 - Math.max(-vF, 0) / CAR.maxRev, 0, 1);   // reversing
  }
  if (vF > vmax) a -= (vF - vmax) * 3; // soft limiter (e.g. boost ended)
  vF += a * dt;

  let resistance = (0.4 + 0.0006 * vF * vF) * S.drag;
  if (!throttleIn && !brakeIn) resistance += 1.6 * S.drag; // engine braking
  if (handbrake) resistance += 14;
  const dv = resistance * dt;
  if (Math.abs(vF) <= dv) vF = 0; else vF -= Math.sign(vF) * dv;
  if (vF < -CAR.maxRev) vF = -CAR.maxRev;
  v.vx += fx * (vF - vF0);
  v.vz += fz * (vF - vF0);

  /* ---- steering -> yaw rate ---- */
  const target = clamp(input.steer || 0, -1, 1);
  const slew = (Math.abs(target) > Math.abs(v.steer) && target * v.steer >= 0 ? 5.5 : 9) * dt;
  v.steer += clamp(target - v.steer, -slew, slew);

  const sp = Math.abs(vF);
  let yawT;
  if (free) {
    // Free-roam assist: the car can pivot on the spot and is more agile at low speed.
    const authority = lerp(1.9, 1.0, clamp(sp / 30, 0, 1));
    yawT = v.steer * authority * (vF < -1 ? -1 : 1);
  } else {
    // Bicycle model: needs forward/reverse motion to turn.
    const delta = v.steer * 0.55 / (1 + sp / 6);
    yawT = vF * Math.tan(delta) / CAR.wheelbase;
  }
  // Tyre grip limit on lateral acceleration (≈1.4 g on tarmac)
  const yawLimit = (14 * S.grip) / Math.max(sp, 2) * (handbrake ? 1.5 : 1);
  yawT = clamp(yawT, -yawLimit, yawLimit);
  if (handbrake && sp > 5) yawT *= 1.4; // handbrake = oversteer
  v.yawRate += (yawT - v.yawRate) * Math.min(1, dt * 9);
  v.heading = wrapAngle(v.heading + v.yawRate * dt);

  /* ---- lateral grip / strafe in the new body frame ---- */
  fx = Math.sin(v.heading); fz = -Math.cos(v.heading);
  const rx = Math.cos(v.heading), rz = Math.sin(v.heading);
  let vF2 = v.vx * fx + v.vz * fz;
  let vR = v.vx * rx + v.vz * rz;
  if (strafeIn) {
    vR += clamp(strafeIn * 8 - vR, -22 * dt, 22 * dt);
  } else {
    // weight transfer: hard braking while turning at speed loosens the tyres a little
    const loaded = (vF2 > 12 ? 1 - 0.3 * brakeIn * Math.abs(v.steer) : 1);
    const grip = handbrake ? 1.4 : 10 * S.grip * loaded;
    vR -= vR * Math.min(1, grip * dt);
  }
  v.vx = fx * vF2 + rx * vR;
  v.vz = fz * vF2 + rz * vR;

  /* ---- integrate + collide ---- */
  v.x += v.vx * dt;
  v.z += v.vz * dt;
  collide(v, obstacles, events, dt);
  clampToWorld(v, events);

  /* ---- derived telemetry ---- */
  fx = Math.sin(v.heading); fz = -Math.cos(v.heading);
  const rx2 = Math.cos(v.heading), rz2 = Math.sin(v.heading);
  vF2 = v.vx * fx + v.vz * fz;
  vR = v.vx * rx2 + v.vz * rz2;
  const awx = (v.vx - ovx) / dt, awz = (v.vz - ovz) / dt;
  const k = Math.min(1, dt * 8);
  v.accelLong += ((awx * fx + awz * fz) - v.accelLong) * k;
  v.accelLat += ((awx * rx2 + awz * rz2) - v.accelLat) * k;
  const ground = Math.hypot(v.vx, v.vz);
  v.speed = vF2;
  v.kmh = ground * 3.6;
  v.slip = Math.atan2(vR, Math.max(Math.abs(vF2), 0.5)) * 180 / Math.PI;
  v.skidIntensity = clamp(Math.max((Math.abs(vR) - 1.6) / 6, handbrake ? 0.6 : 0, brakeIn > 0.9 && vF2 > 15 ? (vF2 - 15) / 25 : 0), 0, 1);
  v.skid = (Math.abs(vR) > 2.2 && ground > 3) || (handbrake && ground > 6) || (brakeIn > 0.9 && vF2 > 15);
  v.odometer += ground * dt;
  v.maxKmh = Math.max(v.maxKmh, v.kmh);
  v.tripTime += dt;
  if (ground > 0.5) v.movingTime += dt;
  v.impactCooldown = Math.max(0, v.impactCooldown - dt);
  v.edgeCooldown = Math.max(0, v.edgeCooldown - dt);
  v.shake = Math.max(0, v.shake - dt * 2.5);
  return events;
}

function collide(v, obstacles, events) {
  const fx = Math.sin(v.heading), fz = -Math.cos(v.heading);
  const rr0 = CAR.bodyR;
  let hit = 0;
  for (const sgn of [1, -1]) {
    // two body circles (front + rear) approximate the car's footprint
    let px = v.x + fx * CAR.bodyOffset * sgn, pz = v.z + fz * CAR.bodyOffset * sgn;
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      const dx = px - o.x, dz = pz - o.z;
      if (dx > 3 || dx < -3 || dz > 3 || dz < -3) continue;
      const rr = rr0 + o.r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2) || 1e-4;
      const nx = dx / d, nz = dz / d, pen = rr - d;
      v.x += nx * pen; v.z += nz * pen; px += nx * pen; pz += nz * pen;
      const vn = v.vx * nx + v.vz * nz;
      if (vn < 0) {
        v.vx -= 1.25 * vn * nx; v.vz -= 1.25 * vn * nz; // slight bounce
        v.vx *= 0.8; v.vz *= 0.8;
        hit = Math.max(hit, -vn);
      }
    }
  }
  if (hit > 2 && v.impactCooldown <= 0) {
    v.impacts++; v.impactCooldown = 0.8; v.shake = clamp(hit / 14, 0.25, 1);
    events.push({ type: 'IMPACT', kmh: Math.round(hit * 3.6) });
  }
}

function clampToWorld(v, events) {
  let edge = false;
  if (v.x < WORLD.xMin) { v.x = WORLD.xMin; if (v.vx < 0) v.vx = 0; edge = true; }
  if (v.x > WORLD.xMax) { v.x = WORLD.xMax; if (v.vx > 0) v.vx = 0; edge = true; }
  if (v.z < WORLD.zMin) { v.z = WORLD.zMin; if (v.vz < 0) v.vz = 0; edge = true; }
  if (v.z > WORLD.zMax) { v.z = WORLD.zMax; if (v.vz > 0) v.vz = 0; edge = true; }
  if (edge && v.edgeCooldown <= 0) { v.edgeCooldown = 3; events.push({ type: 'EDGE' }); }
}

export const toG = a => a / G;
