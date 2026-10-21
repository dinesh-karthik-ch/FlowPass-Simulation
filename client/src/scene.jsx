import React, { Suspense, useLayoutEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { ROUTES, QUALITY, START_Z, getScenery, clamp, lerp, lerpAngle } from './constants.js';

/* ============================== helpers ============================== */
/** One draw call for N copies. `fill(i, object3D, color)` positions each instance (and may return a colour). */
function Instanced({ count, fill, children, castShadow = false }) {
  const ref = useRef();
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const o = new THREE.Object3D();
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      o.position.set(0, 0, 0); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1);
      const col = fill(i, o, c);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
      if (col) mesh.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [count, fill]);
  return <instancedMesh ref={ref} args={[null, null, count]} castShadow={castShadow} frustumCulled={false}>{children}</instancedMesh>;
}

/* ============================== ROAD + SCENERY ============================== */
const CONE_PALETTES = [0, 1, 2].map(i => [['#245d43', '#2e7650', '#398858'][i], ['#28694b', '#317b50', '#3d8c58'][i]]);
const DASH_GEO = new THREE.PlaneGeometry(0.12, 8.5).rotateX(-Math.PI / 2);
const SKID_GEO = new THREE.PlaneGeometry(0.26, 0.9).rotateX(-Math.PI / 2);

/** Memoised fill() for one tree layer: layerY is the layer height at scale 1; palette (optional) tints per tree variant. */
function useTreeFill(trees, layerY, palette) {
  return useMemo(() => (i, o, c) => {
    const t = trees[i];
    o.position.set(t.x, layerY * t.s, t.z);
    o.scale.setScalar(t.s);
    return palette ? c.set(palette[t.v]) : null;
  }, [trees, layerY, palette]);
}

function Forest({ trees }) {
  const trunk = useTreeFill(trees, 0.8, null);
  const l0 = useTreeFill(trees, 1.45, CONE_PALETTES[0]);
  const l1 = useTreeFill(trees, 1.97, CONE_PALETTES[1]);
  const l2 = useTreeFill(trees, 2.49, CONE_PALETTES[2]);
  return <group>
    <Instanced count={trees.length} fill={trunk}><cylinderGeometry args={[0.12, 0.19, 1.6, 6]} /><meshStandardMaterial color="#76523a" roughness={1} /></Instanced>
    {[l0, l1, l2].map((fill, i) => <Instanced key={i} count={trees.length} fill={fill}>
      <coneGeometry args={[0.8 - i * 0.14, 1.35, 7]} /><meshStandardMaterial color="#ffffff" roughness={1} />
    </Instanced>)}
  </group>;
}

function ZoneGate({ z, label, color }) {
  return <group position={[0, 0, z]}>
    {[-1, 1].map(side => <group key={side} position={[side * 5.7, 0, 0]}>
      <mesh position={[0, 1.45, 0]}><boxGeometry args={[0.18, 2.9, 0.18]} /><meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.6} /></mesh>
      <mesh position={[0, 2.95, 0]}><boxGeometry args={[1.1, 0.12, 0.12]} /><meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.2} /></mesh>
    </group>)}
    <mesh position={[0, 3.1, 0]}><boxGeometry args={[11.4, 0.12, 0.14]} /><meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} /></mesh>
    {/* glowing stripe on the tarmac so the boundary is obvious from any camera */}
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.024, 0]}><planeGeometry args={[12.4, 0.55]} /><meshBasicMaterial color={color} transparent opacity={0.85} /></mesh>
    <Html position={[0, 3.5, 0]} center distanceFactor={13} zIndexRange={[1, 0]} occlude={false}><div className="gate-label" style={{ borderColor: color, color }}>{label}</div></Html>
  </group>;
}

function HighwaySign({ z, side, title, subtitle, accent }) {
  return <group position={[side * 10.5, 0, z]}>
    <mesh position={[0, 1.8, 0]}><boxGeometry args={[0.12, 3.6, 0.14]} /><meshStandardMaterial color="#a7b1b9" metalness={0.55} /></mesh>
    <mesh position={[0, 3.25, 0]}><boxGeometry args={[3.5, 1.15, 0.16]} /><meshStandardMaterial color="#123b39" roughness={0.5} /></mesh>
    <mesh position={[0, 3.25, 0.1]}><boxGeometry args={[3.38, 1.03, 0.03]} /><meshStandardMaterial color="#174c47" /></mesh>
    <Html position={[0, 3.48, 0.2]} center distanceFactor={20} zIndexRange={[1, 0]} transform occlude={false}>
      <div className="road-sign" style={{ borderColor: accent }}><b>{title}</b><small>{subtitle}</small></div>
    </Html>
  </group>;
}

const Road = React.memo(function Road({ routeKey }) {
  const route = ROUTES[routeKey] || ROUTES.express;
  const sc = getScenery(routeKey);
  const dashes = useMemo(() => [-2.12, 2.12].flatMap(x => Array.from({ length: 56 }, (_, j) => [x, -610 + j * 22])), []);
  const fillDash = useMemo(() => (i, o) => { o.position.set(dashes[i][0], 0.02, dashes[i][1]); }, [dashes]);
  const fillPost = useMemo(() => (i, o) => { const p = sc.posts[i]; o.position.set(p.x, 0.45, p.z); }, [sc]);
  const fillReflector = useMemo(() => (i, o) => { const p = sc.posts[i]; o.position.set(p.x, 0.78, p.z); }, [sc]);
  const fillPole = useMemo(() => (i, o) => { const l = sc.lamps[i]; o.position.set(l.x, 2.5, l.z); }, [sc]);
  const fillArm = useMemo(() => (i, o) => { const l = sc.lamps[i]; o.position.set(l.x - l.side * 0.6, 4.9, l.z); }, [sc]);
  const fillBulb = useMemo(() => (i, o) => { const l = sc.lamps[i]; o.position.set(l.x - l.side * 1.1, 4.82, l.z); }, [sc]);
  const corridorLen = route.exit - route.entry;
  return <group>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.005, 0]} receiveShadow><planeGeometry args={[15.5, 1500]} /><meshStandardMaterial color="#202831" roughness={0.98} /></mesh>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0]} receiveShadow><planeGeometry args={[12.8, 1500]} /><meshStandardMaterial color={route.road} roughness={0.95} /></mesh>
    {[-6.35, 6.35].map((x, i) => <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.017, 0]}><planeGeometry args={[0.16, 1500]} /><meshStandardMaterial color="#f4f0dc" roughness={0.7} /></mesh>)}
    <Instanced count={dashes.length} fill={fillDash}><primitive object={DASH_GEO} attach="geometry" /><meshStandardMaterial color="#e5e8e8" roughness={0.8} /></Instanced>

    {/* delineator posts (replace the old solid guard-rail so the car can leave the road) */}
    <Instanced count={sc.posts.length} fill={fillPost}><boxGeometry args={[0.1, 0.9, 0.1]} /><meshStandardMaterial color="#d9dfe3" roughness={0.6} /></Instanced>
    <Instanced count={sc.posts.length} fill={fillReflector}><boxGeometry args={[0.12, 0.2, 0.12]} /><meshStandardMaterial color="#ff9c33" emissive="#ff7a00" emissiveIntensity={0.5} /></Instanced>

    <Instanced count={sc.lamps.length} fill={fillPole}><cylinderGeometry args={[0.06, 0.09, 5, 8]} /><meshStandardMaterial color="#8899a4" metalness={0.6} roughness={0.35} /></Instanced>
    <Instanced count={sc.lamps.length} fill={fillArm}><boxGeometry args={[1.4, 0.08, 0.22]} /><meshStandardMaterial color="#8899a4" metalness={0.5} /></Instanced>
    <Instanced count={sc.lamps.length} fill={fillBulb}><boxGeometry args={[0.35, 0.06, 0.15]} /><meshStandardMaterial color="#fffbe8" emissive="#fffadf" emissiveIntensity={route.night ? 2.2 : 0.6} /></Instanced>

    <ZoneGate z={sc.entryZ} label={`ENTRY ${route.entry}`} color={route.accent} />
    <ZoneGate z={sc.exitZ} label={`EXIT ${route.exit}`} color="#5ab5ff" />
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, (sc.entryZ + sc.exitZ) / 2]}>
      <planeGeometry args={[12.5, corridorLen]} /><meshBasicMaterial color={route.accent} transparent opacity={0.09} side={THREE.DoubleSide} />
    </mesh>
    <HighwaySign z={-170} side={-1} title="FLOWPASS" subtitle="DISTANCE TOLLING" accent={route.accent} />
    <HighwaySign z={-410} side={1} title="SAFE DRIVE" subtitle="KEEP LEFT" accent={route.accent} />
    <HighwaySign z={150} side={-1} title={route.name.toUpperCase()} subtitle="DEMO ROUTE" accent={route.accent} />
    <Forest trees={sc.trees} />
  </group>;
});

/** Big ground plane that always sits under the car, so there is no visible edge anywhere inside the world. */
function Ground({ vehicleRef, color }) {
  const ref = useRef();
  useFrame(() => { const v = vehicleRef.current; if (ref.current) ref.current.position.set(v.x, -0.12, v.z); });
  return <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} receiveShadow><planeGeometry args={[1800, 1800]} /><meshStandardMaterial color={color} roughness={1} /></mesh>;
}

/* ============================== CAR ============================== */
const blobTexture = (() => {
  let tex;
  return () => {
    if (tex) return tex;
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'); const grad = g.createRadialGradient(32, 32, 4, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,.9)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
    return (tex = new THREE.CanvasTexture(c));
  };
})();

const Car = React.memo(function Car({ vehicleRef, camModeRef, lights, shadows }) {
  const root = useRef(), body = useRef();
  const steerRefs = useRef([]), spinRefs = useRef([]);
  const spin = useRef(0), steerVis = useRef(0);
  const tail = useMemo(() => new THREE.MeshStandardMaterial({ color: '#ff2738', emissive: '#ff172a', emissiveIntensity: 1.6 }), []);
  const head = useMemo(() => new THREE.MeshStandardMaterial({ color: '#f4fbff', emissive: '#dff5ff', emissiveIntensity: 1.2 }), []);
  const blob = useMemo(() => blobTexture(), []);
  useLayoutEffect(() => { head.emissiveIntensity = lights ? 2.6 : 1.0; }, [lights, head]);

  useFrame((_, dt) => {
    const v = vehicleRef.current, g = root.current, b = body.current;
    if (!g) return;
    const k = 1 - Math.exp(-10 * dt);
    g.position.set(v.x, lerp(g.position.y, v.surface === 'OFFROAD' ? -0.08 : 0.04, k), v.z);
    g.rotation.y = Math.PI - v.heading; // model front is +Z locally; heading 0 drives toward -Z
    g.visible = camModeRef.current !== 'cockpit';
    b.rotation.x = lerp(b.rotation.x, -clamp(v.accelLong, -9, 9) * 0.0045, k);  // nose lifts on throttle, dives on brake
    b.rotation.z = lerp(b.rotation.z, clamp(v.accelLat, -14, 14) * 0.0055, k);   // body rolls to the outside of a corner
    tail.emissiveIntensity = 1.4 + v.brake * 3.2;
    spin.current += (v.speed * dt) / 0.37;
    steerVis.current = lerp(steerVis.current, -v.steer * 0.45, k);
    steerRefs.current.forEach((w, i) => { if (w && i < 2) w.rotation.y = steerVis.current; });
    spinRefs.current.forEach(w => { if (w) w.rotation.x = spin.current; });
  });

  const bodyCol = '#e9edf0', glass = '#1b2d3c';
  const wheels = [[-0.96, 1.35], [0.96, 1.35], [-0.96, -1.35], [0.96, -1.35]];
  return <group ref={root}>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}><planeGeometry args={[3.2, 5.6]} /><meshBasicMaterial map={blob} transparent opacity={shadows ? 0.35 : 0.6} depthWrite={false} /></mesh>
    <group ref={body}>
      <mesh position={[0, 0.47, 0]} castShadow><boxGeometry args={[1.9, 0.42, 4.15]} /><meshStandardMaterial color={bodyCol} metalness={0.48} roughness={0.28} /></mesh>
      <mesh position={[0, 0.66, 0.98]} castShadow><boxGeometry args={[1.82, 0.28, 1.55]} /><meshStandardMaterial color="#f5f6f7" metalness={0.4} roughness={0.25} /></mesh>
      <mesh position={[0, 0.78, -0.72]} castShadow><boxGeometry args={[1.7, 0.28, 1.18]} /><meshStandardMaterial color="#d7dde2" metalness={0.4} roughness={0.27} /></mesh>
      <mesh position={[0, 0.99, -0.25]} castShadow><boxGeometry args={[1.46, 0.66, 1.82]} /><meshStandardMaterial color="#cfd9df" metalness={0.35} roughness={0.23} /></mesh>
      <mesh position={[0, 1.03, -0.25]}><boxGeometry args={[1.35, 0.52, 1.72]} /><meshStandardMaterial color={glass} metalness={0.45} roughness={0.16} /></mesh>
      <mesh position={[0, 1.06, 0.23]} rotation={[-0.25, 0, 0]}><boxGeometry args={[1.3, 0.04, 0.63]} /><meshStandardMaterial color="#344d5b" metalness={0.35} roughness={0.18} /></mesh>
      <mesh position={[0, 1.06, -0.75]} rotation={[0.22, 0, 0]}><boxGeometry args={[1.28, 0.04, 0.53]} /><meshStandardMaterial color="#344d5b" metalness={0.35} roughness={0.18} /></mesh>
      {[-1, 1].map(side => <group key={side}>
        <mesh position={[side * 0.74, 1.03, -0.24]}><boxGeometry args={[0.035, 0.42, 1.12]} /><meshStandardMaterial color="#6b8997" metalness={0.3} roughness={0.2} /></mesh>
        <mesh position={[side * 1.02, 0.78, 0.18]} castShadow><boxGeometry args={[0.22, 0.12, 0.28]} /><meshStandardMaterial color={bodyCol} metalness={0.4} roughness={0.25} /></mesh>
        <mesh position={[side * 0.62, 0.62, 2.1]} material={head}><boxGeometry args={[0.42, 0.13, 0.045]} /></mesh>
        <mesh position={[side * 0.66, 0.42, -2.08]} material={tail}><boxGeometry args={[0.36, 0.13, 0.04]} /></mesh>
        {lights && <mesh position={[side * 0.62, 0.35, 2.1 + 4.5]} rotation={[-Math.PI / 2, 0, 0]}>
          <coneGeometry args={[2.2, 9, 14, 1, true]} /><meshBasicMaterial color="#fff4c9" transparent opacity={0.09} depthWrite={false} blending={THREE.AdditiveBlending} side={THREE.DoubleSide} />
        </mesh>}
      </group>)}
      <mesh position={[0, 0.49, 2.09]}><boxGeometry args={[0.72, 0.2, 0.035]} /><meshStandardMaterial color="#111a22" metalness={0.25} /></mesh>
      <mesh position={[0, 0.34, 2.08]}><boxGeometry args={[1.42, 0.09, 0.08]} /><meshStandardMaterial color="#aab5bd" metalness={0.7} /></mesh>
      <mesh position={[0, 0.34, -2.08]}><boxGeometry args={[1.42, 0.09, 0.08]} /><meshStandardMaterial color="#8a949c" metalness={0.6} /></mesh>
    </group>
    {wheels.map(([x, z], i) => <group key={i} position={[x, 0.34, z]} ref={el => { steerRefs.current[i] = el; }}>
      <group ref={el => { spinRefs.current[i] = el; }}>
        <mesh rotation={[0, 0, Math.PI / 2]} castShadow><cylinderGeometry args={[0.37, 0.37, 0.22, 20]} /><meshStandardMaterial color="#10161c" roughness={0.92} /></mesh>
        <mesh rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.23, 0.23, 0.235, 16]} /><meshStandardMaterial color="#b8c5ce" metalness={0.78} roughness={0.24} /></mesh>
        <mesh rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.08, 0.08, 0.24, 12]} /><meshStandardMaterial color="#687985" metalness={0.8} /></mesh>
      </group>
    </group>)}
  </group>;
});

/* ============================== SKID MARKS ============================== */
const MAX_SKIDS = 500;
function Skids({ vehicleRef }) {
  const ref = useRef();
  const state = useRef({ i: 0, lx: 1e9, lz: 1e9 });
  useLayoutEffect(() => {
    const m = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < MAX_SKIDS; i++) ref.current.setMatrixAt(i, m);
    ref.current.instanceMatrix.needsUpdate = true;
  }, []);
  const o = useMemo(() => new THREE.Object3D(), []);
  useFrame(() => {
    const v = vehicleRef.current, s = state.current, mesh = ref.current;
    if (!mesh || !v.skid) { s.lx = 1e9; return; }
    if (Math.hypot(v.x - s.lx, v.z - s.lz) < 0.55) return;
    s.lx = v.x; s.lz = v.z;
    const fx = Math.sin(v.heading), fz = -Math.cos(v.heading), rx = Math.cos(v.heading), rz = Math.sin(v.heading);
    for (const side of [-1, 1]) {
      o.position.set(v.x - fx * 1.35 + rx * side * 0.96, 0.03, v.z - fz * 1.35 + rz * side * 0.96);
      // marks follow the car's actual direction of travel (not its nose), so drifts leave a believable trail
      const dir = Math.atan2(v.vx, -v.vz);
      o.rotation.set(0, Math.PI - dir, 0); o.scale.set(1, 1, 1); o.updateMatrix();
      mesh.setMatrixAt(s.i, o.matrix); s.i = (s.i + 1) % MAX_SKIDS;
    }
    mesh.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={ref} args={[null, null, MAX_SKIDS]} frustumCulled={false}>
    <primitive object={SKID_GEO} attach="geometry" /><meshBasicMaterial color="#0b0d10" transparent opacity={0.4} depthWrite={false} />
  </instancedMesh>;
}

/* ============================== CAMERA ============================== */
function CameraRig({ vehicleRef, camModeRef, orbitRef, runningRef }) {
  const { camera } = useThree();
  const rig = useRef({ pos: new THREE.Vector3(0, 6, START_Z + 14), look: new THREE.Vector3(0, 1, START_Z), heading: 0, init: false });
  const want = useMemo(() => new THREE.Vector3(), []);
  const wantLook = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const r = rig.current, v = vehicleRef.current, orb = orbitRef.current;
    const running = runningRef.current;
    const mode = running ? camModeRef.current : 'standby';
    const fx = Math.sin(v.heading), fz = -Math.cos(v.heading), rx = Math.cos(v.heading), rz = Math.sin(v.heading);
    const kmh = v.kmh;
    let posRate = 8, lookRate = 10, fovT = 52 + clamp(kmh, 0, 160) * 0.1 + (v.boosting ? 6 : 0), up = 1;

    if (mode === 'chase') {
      r.heading = lerpAngle(r.heading, v.heading, 1 - Math.exp(-4.5 * dt));
      const cfx = Math.sin(r.heading), cfz = -Math.cos(r.heading);
      const dist = orb.chase + kmh * 0.03;
      want.set(v.x - cfx * dist, 3.9 + orb.chase * 0.12 + kmh * 0.008, v.z - cfz * dist);
      const ahead = 6 + clamp(kmh, 0, 150) * 0.05; // look near the car when slow, further ahead when fast
      wantLook.set(v.x + cfx * ahead, 0.3, v.z + cfz * ahead);
      posRate = 7; lookRate = 9;
    } else if (mode === 'cockpit') {
      want.set(v.x + fx * 0.15 + rx * 0.38, 1.22, v.z + fz * 0.15 + rz * 0.38);
      wantLook.set(v.x + fx * 20 + rx * v.steer * 2.5, 1.1, v.z + fz * 20 + rz * v.steer * 2.5);
      posRate = 60; lookRate = 14; fovT += 16;
    } else if (mode === 'top') {
      want.set(v.x, 34 + orb.top + kmh * 0.25, v.z + 0.001);
      wantLook.set(v.x, 0, v.z);
      posRate = 6; lookRate = 12; up = 0; fovT = 48;
    } else { // 'orbit' (user-controlled) and 'standby' (slow showroom spin before the trip starts)
      if (mode === 'standby') { orb.az += dt * 0.28; }
      const el = mode === 'standby' ? 0.26 : orb.el, d = mode === 'standby' ? 10.5 : orb.dist;
      want.set(v.x + Math.sin(orb.az) * Math.cos(el) * d, 1 + Math.sin(el) * d, v.z + Math.cos(orb.az) * Math.cos(el) * d);
      wantLook.set(v.x, 1, v.z);
      posRate = mode === 'standby' ? 4 : 12; lookRate = 14; fovT = 50;
    }

    if (!r.init) { r.pos.copy(want); r.look.copy(wantLook); r.init = true; }
    r.pos.lerp(want, 1 - Math.exp(-posRate * dt));
    r.look.lerp(wantLook, 1 - Math.exp(-lookRate * dt));
    camera.position.copy(r.pos);
    if (v.shake > 0) camera.position.add(want.set((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)).multiplyScalar(v.shake * 0.35));
    camera.up.set(0, up, up ? 0 : -1);
    camera.lookAt(r.look);
    if (Math.abs(camera.fov - fovT) > 0.05) { camera.fov += (fovT - camera.fov) * (1 - Math.exp(-4 * dt)); camera.updateProjectionMatrix(); }
  });
  return null;
}

/* ============================== LIGHTS ============================== */
function Sun({ vehicleRef, route, quality }) {
  const light = useRef();
  const target = useMemo(() => new THREE.Object3D(), []);
  useLayoutEffect(() => { const c = light.current.shadow.camera; c.left = c.bottom = -20; c.right = c.top = 20; c.near = 1; c.far = 140; c.updateProjectionMatrix(); }, []);
  useFrame(() => {
    const v = vehicleRef.current, l = light.current;
    l.position.set(v.x - 30, 45, v.z + 15);
    target.position.set(v.x, 0, v.z);
    target.updateMatrixWorld();
  });
  return <>
    <ambientLight intensity={route.ambient} />
    <hemisphereLight args={['#e8f7ff', '#4a6c49', route.ambient]} />
    <directionalLight ref={light} target={target} color={route.sunColor} intensity={route.sunIntensity} castShadow={quality.shadows}
      shadow-mapSize-width={quality.shadowMap} shadow-mapSize-height={quality.shadowMap} shadow-bias={-0.0006} shadow-normalBias={0.06} />
    <primitive object={target} />
  </>;
}

/* ============================== CANVAS ============================== */
export const GameScene = React.memo(function GameScene({ vehicleRef, camModeRef, orbitRef, runningRef, routeKey, lights, qualityKey, resetKey }) {
  const route = ROUTES[routeKey] || ROUTES.express;
  const quality = QUALITY[qualityKey] || QUALITY.balanced;
  return <Canvas key={qualityKey} shadows={quality.shadows} dpr={quality.dpr} camera={{ position: [0, 6, START_Z + 14], fov: 52, near: 0.1, far: 900 }}
    gl={{ antialias: quality.antialias, powerPreference: 'high-performance', alpha: false }}>
    <color attach="background" args={[route.sky]} />
    <fog attach="fog" args={[route.sky, 90, 380]} />
    <Suspense fallback={null}>
      <Sun vehicleRef={vehicleRef} route={route} quality={quality} />
      <Ground vehicleRef={vehicleRef} color={route.ground} />
      <Road routeKey={routeKey} />
      <Car vehicleRef={vehicleRef} camModeRef={camModeRef} lights={lights} shadows={quality.shadows} />
      <Skids key={resetKey} vehicleRef={vehicleRef} />
      <CameraRig vehicleRef={vehicleRef} camModeRef={camModeRef} orbitRef={orbitRef} runningRef={runningRef} />
    </Suspense>
  </Canvas>;
});
