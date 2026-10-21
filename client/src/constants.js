/* Shared constants + helpers. No browser / React dependencies, so it is unit-testable in Node. */

export const API = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL) || 'http://localhost:4000';
export const VEHICLE_ID = 'FP-3D-001';

/** World layout: the road runs along the Z axis. Start line is z = START_Z, "forward" is -Z. */
export const ROUTE_LENGTH = 1200;
export const START_Z = 520;
export const FINISH_Z = START_Z - ROUTE_LENGTH + 10; // trip completes ~10 m before the end of the route
export const ROAD = { half: 6.4, shoulder: 7.75 };
/** Soft world edge. The car can roam freely inside this box (road, shoulders, grass, forest). */
export const WORLD = { xMin: -300, xMax: 300, zMin: -700, zMax: 650 };

export const ROUTES = {
  express: {
    name: 'North Expressway', subtitle: 'OPEN EXPRESSWAY',
    ground: '#6f9a5f', road: '#3a4149', accent: '#36e2bd', entry: 170, exit: 1130,
    gates: [{ id: 'A', position: 170, x: 0, kind: 'ENTRY' }, { id: 'B', position: 700, x: 18, kind: 'EXIT' }, { id: 'C', position: 935, x: 23, kind: 'EXIT' }, { id: 'D', position: 1130, x: 0, kind: 'EXIT' }],
    sky: '#a8d9ed', skyTop: '#3f8fdc', skyHorizon: '#d4eaf4', sunColor: '#fff0cf', sunGlow: 1,
    sunOffset: [-38, 56, -34], lightColor: '#fff0d6', lightIntensity: 2.3,
    ambient: ['#ffffff', 0.55], hemi: ['#eaf6ff', '#4f7048', 1.0],
    fog: [130, 560], mountain: '#7f9bb4', snow: '#ffffff', hill: '#5d8a52',
    lamp: '#fff3c9', poolOpacity: 0.10, night: false, clouds: 0.95, cloudTint: '#ffffff',
    treeStep: 9, treeMin: 13, treeSpread: 70, roundChance: 0.45,
    foliage: ['#2f7a45', '#3a8d4f', '#4a9d58'], autumnChance: 0.12,
    sunIntensity: 2.1, treeCell: 22, treeSkip: 0.3
  },
  forest: {
    name: 'Pine Valley Route', subtitle: 'FOREST HIGHWAY',
    ground: '#4a7448', road: '#363d42', accent: '#a5e66d', entry: 130, exit: 1040,
    gates: [{ id: 'A', position: 130, x: 0, kind: 'ENTRY' }, { id: 'B', position: 530, x: 18, kind: 'EXIT' }, { id: 'C', position: 770, x: 23, kind: 'EXIT' }, { id: 'D', position: 1040, x: 0, kind: 'EXIT' }],
    sky: '#a8c8d5', skyTop: '#6a9db8', skyHorizon: '#cfe0d8', sunColor: '#f6f2d8', sunGlow: 0.7,
    sunOffset: [-32, 40, -42], lightColor: '#f3f0d8', lightIntensity: 1.9,
    ambient: ['#e5f3ec', 0.65], hemi: ['#dcefe6', '#3d5f3e', 1.0],
    fog: [55, 330], mountain: '#587f70', snow: '#e9f2ee', hill: '#3f6a45',
    lamp: '#f5f1c7', poolOpacity: 0.10, night: false, clouds: 0.7, cloudTint: '#f1f6f3',
    treeStep: 4.6, treeMin: 11.5, treeSpread: 55, roundChance: 0.08,
    foliage: ['#1f5d3e', '#26704a', '#317f55'], autumnChance: 0,
    sunIntensity: 1.9, treeCell: 14, treeSkip: 0.2
  },
  dusk: {
    name: 'Dusk Ridge Bypass', subtitle: 'EVENING BYPASS',
    ground: '#44566a', road: '#2c323d', accent: '#f2bb76', entry: 220, exit: 1120,
    gates: [{ id: 'A', position: 220, x: 0, kind: 'ENTRY' }, { id: 'B', position: 670, x: 18, kind: 'EXIT' }, { id: 'C', position: 905, x: 23, kind: 'EXIT' }, { id: 'D', position: 1120, x: 0, kind: 'EXIT' }],
    sky: '#d09b83', skyTop: '#232857', skyHorizon: '#f19068', sunColor: '#ffb36b', sunGlow: 1.6,
    sunOffset: [-62, 15, -72], lightColor: '#ffab70', lightIntensity: 2.6,
    ambient: ['#9aa8e0', 0.95], hemi: ['#8f9fdc', '#3a4560', 1.1],
    fog: [90, 470], mountain: '#444a78', snow: '#f4c5b2', hill: '#323f55',
    lamp: '#ffd89a', poolOpacity: 0.55, night: true, clouds: 0.85, cloudTint: '#ffc2a0',
    treeStep: 13, treeMin: 14, treeSpread: 70, roundChance: 0.1,
    foliage: ['#1d4a49', '#235a55', '#2c6a62'], autumnChance: 0,
    sunIntensity: 1.6, treeCell: 26, treeSkip: 0.35
  }
};

/* ---------- Two-way operation ----------
 * Northbound traffic (heading 0, -Z, progress increasing) enters at A and leaves at B / C / D.
 * Southbound traffic enters at D and leaves at C / B / A. Southbound exit ramps are the mirror
 * images of the northbound ones (x < 0) and branch off over the same 130 m stretch ending at the gate. */
export const RAMP_LEN = 130;
export const DIRECTIONS = { FORWARD: 'NORTHBOUND', REVERSE: 'SOUTHBOUND' };
export function reverseGatesOf(route) {
  const entry = route.gates.find(g => g.kind === 'ENTRY');
  const last = route.gates.filter(g => g.kind === 'EXIT' && !(g.x || 0)).reduce((a, b) => (b.position > a.position ? b : a));
  const ramps = route.gates.filter(g => g.kind === 'EXIT' && (g.x || 0) !== 0).slice().reverse()
    .map(g => ({ id: g.id, position: g.position, x: -g.x, kind: 'EXIT', dir: -1 }));
  return [{ id: last.id, position: last.position, x: 0, kind: 'ENTRY', dir: -1 }, ...ramps, { id: entry.id, position: entry.position, x: 0, kind: 'EXIT', dir: -1 }];
}
for (const r of Object.values(ROUTES)) r.reverseGates = reverseGatesOf(r);

/** Signed lateral centre (x) of a ramp at a given route progress. Shared by scene, physics, minimap and backend. */
export function rampCentre(g, progress) {
  const dir = g.dir === -1 ? -1 : 1;
  const start = dir === 1 ? g.position - RAMP_LEN : g.position + RAMP_LEN;
  const t = clamp(dir * (progress - start) / RAMP_LEN, 0, 1);
  const s = t * t * (3 - 2 * t);
  return (g.x < 0 ? -1 : 1) * (6.4 + (Math.abs(g.x) - 6.4) * s);
}
/** Route-progress interval [lo, hi] covered by a ramp's pavement (a little slack around the gate line). */
export const rampSpan = g => (g.dir === -1 ? [g.position - 3, g.position + RAMP_LEN + 2] : [g.position - RAMP_LEN - 2, g.position + 3]);
/** Every branch ramp (both directions) of a route. */
export const rampGatesOf = route => [...(route.gates || []), ...(route.reverseGates || [])].filter(g => g.kind === 'EXIT' && (g.x || 0) !== 0);
export function onRampCorridorAt(route, x, z, radius) {
  const progress = START_Z - z;
  return rampGatesOf(route).some(g => { const [lo, hi] = rampSpan(g); return progress >= lo && progress <= hi && Math.abs(x - rampCentre(g, progress)) < radius; });
}

// Camera presets consumed by Scene3D.jsx (chase, far chase, high angle).
export const CAMERA_MODES = [
  { label: 'CHASE', dist: 8, height: 3.2, fov: 56 },
  { label: 'FAR CHASE', dist: 15, height: 6, fov: 52 },
  { label: 'HIGH ANGLE', dist: 5, height: 12, fov: 48 }
];

// Backward-compatible alias used by the 3D scene.
export const Z_START = START_Z;

export const QUALITY = {
  balanced: { label: 'BALANCED', shadows: true, shadowMap: 1024, dpr: [1, 1.25], antialias: false },
  quality: { label: 'QUALITY', shadows: true, shadowMap: 2048, dpr: [1, 2], antialias: true },
  performance: { label: 'PERFORMANCE', shadows: false, shadowMap: 512, dpr: [1, 1], antialias: false }
};

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const wrapAngle = a => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
export const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;
export const formatKm = m => (m / 1000).toFixed(2);
export const formatMoney = n => `₹${Number(n || 0).toFixed(2)}`;
export const formatTime = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Distance along the route (metres) for a world Z. This is what the backend receives as simPosition. */
export const simPosition = z => clamp(START_Z - z, 0, ROUTE_LENGTH);
/** Spawn pose for a direction: northbound starts at the south end facing north; southbound starts just beyond Gate D facing south. */
export const spawnFor = (routeKey, dir) => {
  const r = ROUTES[routeKey] || ROUTES.express;
  if (dir !== 'REVERSE') return { x: 0, z: START_Z, heading: 0 };
  const d = r.reverseGates.find(g => g.kind === 'ENTRY');
  return { x: 0, z: START_Z - Math.min(ROUTE_LENGTH - 15, d.position + 55), heading: Math.PI };
};
export const zFromSim = s => START_Z - s;
/** Fictional GNSS mapping (near Coimbatore). */
export const toLatLon = (x, z) => ({ lat: 11.1 + (START_Z - z) / 111000, lon: 77.1 + x / 98000 });
export const headingDegrees = h => ((h * 180 / Math.PI) % 360 + 360) % 360;
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const cardinal = deg => CARDINALS[Math.round(deg / 45) % 8];

/* ---------- deterministic scenery (shared by renderer, minimap and collision) ---------- */
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashString = s => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

const sceneryCache = {};
export function getScenery(routeKey) {
  if (sceneryCache[routeKey]) return sceneryCache[routeKey];
  const route = ROUTES[routeKey] || ROUTES.express;
  const rand = mulberry32(hashString(routeKey));
  const trees = [];

  // Roadside rows (close to the carriageway)
  for (let i = 0; i < 74; i++) {
    const z = -620 + i * 17;
    const side = i % 2 === 0 ? -1 : 1;
    const spread = routeKey === 'forest' ? 11 + (i % 4) * 2.6 : routeKey === 'dusk' ? 17 + (i % 5) * 3 : 15 + (i % 5) * 3;
    trees.push({ x: side * spread, z, s: 0.8 + (i % 4) * 0.18, v: i % 2 });
    if (i % 2 === 0) trees.push({ x: -side * (spread + 8 + (i % 3) * 3), z: z - 7, s: 0.72 + (i % 3) * 0.2, v: (i + 1) % 2 });
  }
  // Wider forest band so the open-world driving never feels like a flat empty plane
  const cell = route.treeCell;
  for (let gz = WORLD.zMin + 10; gz < WORLD.zMax - 10; gz += cell) {
    for (const side of [-1, 1]) {
      for (let gx = 30; gx < 200; gx += cell) {
        if (rand() < route.treeSkip) continue;
        trees.push({ x: side * (gx + rand() * cell * 0.8), z: gz + rand() * cell * 0.8, s: 0.8 + rand() * 0.9, v: rand() < 0.5 ? 0 : 1 });
      }
    }
  }

  const lamps = [];
  for (const side of [-1, 1]) for (let i = 0; i < 26; i++) lamps.push({ x: side * 9.5, z: -580 + i * 46, side });
  const posts = [];
  for (const side of [-1, 1]) for (let i = 0; i < 62; i++) posts.push({ x: side * 8.1, z: -600 + i * 24, side });
  const signs = [{ z: -170, side: -1 }, { z: -410, side: 1 }, { z: 150, side: -1 }].map(s => ({ ...s, x: s.side * 10.5 }));

  const entryZ = zFromSim(route.entry), exitZ = zFromSim(route.exit);
  const onRampCorridor = (x, z, radius = 0) => onRampCorridorAt(route, x, z, 5.7 + radius);
  // Keep roadside trees, lamps and sign collision bodies out of the branch carriageways.
  const obstacles = [
    ...trees.filter(t => !onRampCorridor(t.x, t.z, 0.42 * t.s)).map(t => ({ x: t.x, z: t.z, r: 0.42 * t.s })),
    ...lamps.filter(l => !onRampCorridor(l.x, l.z, 0.22)).map(l => ({ x: l.x, z: l.z, r: 0.22 })),
    ...signs.filter(s => !onRampCorridor(s.x, s.z, 0.25)).map(s => ({ x: s.x, z: s.z, r: 0.25 })),
    ...[-1, 1].flatMap(side => route.gates.map(g => ({ x: side * 5.7, z: zFromSim(g.position), r: 0.25 })))
  ];
  return (sceneryCache[routeKey] = { trees, lamps, posts, signs, obstacles, entryZ, exitZ });
}
