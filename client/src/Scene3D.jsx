import React, { Suspense, useLayoutEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Stars } from '@react-three/drei';
import * as THREE from 'three';
import { ROUTES, CAMERA_MODES, QUALITY, Z_START, RAMP_LEN as RAMP_LENGTH, rampCentre, rampSpan, rampGatesOf, onRampCorridorAt, clamp, lerp, lerpAngle } from './constants.js';

/* =====================================================================
 * Helpers: seeded random, canvas textures, instancing
 * ===================================================================== */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTexture(w, h, draw, repeat) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}

let _glow, _cloud;
function getGlowTexture() {
  if (!_glow) {
    _glow = canvasTexture(128, 128, (g, w, h) => {
      const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(0.35, 'rgba(255,255,255,0.45)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
  }
  return _glow;
}
function getCloudTexture() {
  if (!_cloud) {
    const rand = rng(99);
    _cloud = canvasTexture(256, 128, (g, w, h) => {
      for (let i = 0; i < 9; i++) {
        const x = 50 + rand() * (w - 100), y = 50 + rand() * 30, r = 26 + rand() * 30;
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, 'rgba(255,255,255,0.85)');
        gr.addColorStop(0.6, 'rgba(255,255,255,0.35)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
      }
    });
  }
  return _cloud;
}

function makeGrassTexture(repeat) {
  const rand = rng(11);
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      const x = rand() * w, y = rand() * h, r = 20 + rand() * 42;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(0,35,0,${0.05 + rand() * 0.08})`);
      gr.addColorStop(1, 'rgba(0,35,0,0)');
      g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let i = 0; i < 1500; i++) {
      g.fillStyle = `rgba(0,40,0,${0.05 + rand() * 0.12})`;
      g.fillRect(rand() * w, rand() * h, 1 + rand() * 2, 2 + rand() * 3);
    }
  }, repeat);
}

function makeAsphaltTexture(repeat) {
  const rand = rng(5);
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#ececec'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 4200; i++) {
      const dark = rand() > 0.35;
      g.fillStyle = dark ? `rgba(0,0,0,${0.05 + rand() * 0.14})` : `rgba(255,255,255,${0.1 + rand() * 0.25})`;
      g.fillRect(rand() * w, rand() * h, 1 + rand() * 1.6, 1 + rand() * 1.6);
    }
  }, repeat);
}

function makeLabelTexture({ title, subtitle, accent, bg = '#123b39', fg = '#ffffff' }) {
  return canvasTexture(512, 160, (g, w, h) => {
    g.fillStyle = bg; g.beginPath(); g.roundRect(4, 4, w - 8, h - 8, 18); g.fill();
    g.lineWidth = 5; g.strokeStyle = accent; g.beginPath(); g.roundRect(11, 11, w - 22, h - 22, 13); g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    let size = 58;
    do { g.font = `800 ${size}px Manrope, Arial, sans-serif`; size -= 2; } while (g.measureText(title).width > w - 70 && size > 20);
    g.fillStyle = fg; g.fillText(title, w / 2, subtitle ? 64 : h / 2);
    if (subtitle) { g.fillStyle = accent; g.font = '600 27px "DM Mono", monospace'; g.fillText(subtitle, w / 2, 115); }
  });
}

/* Generic InstancedMesh: items = [{ p:[x,y,z], s:number|[x,y,z], rx, ry, c:Color|string }] */
function Inst({ items, children, castShadow = false, receiveShadow = false }) {
  const ref = useRef();
  useLayoutEffect(() => {
    const m = ref.current; if (!m) return;
    const o = new THREE.Object3D(); const col = new THREE.Color();
    items.forEach((it, i) => {
      o.position.set(it.p[0], it.p[1], it.p[2]);
      o.rotation.set(it.rx || 0, it.ry || 0, 0);
      if (typeof it.s === 'number') o.scale.setScalar(it.s); else if (it.s) o.scale.set(it.s[0], it.s[1], it.s[2]); else o.scale.set(1, 1, 1);
      o.updateMatrix(); m.setMatrixAt(i, o.matrix);
      if (it.c !== undefined) { col.set(it.c); m.setColorAt(i, col); }
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere?.();
  }, [items]);
  if (!items.length) return null;
  return <instancedMesh key={items.length} ref={ref} args={[null, null, items.length]} frustumCulled={false} castShadow={castShadow} receiveShadow={receiveShadow}>{children}</instancedMesh>;
}

const FLAT = -Math.PI / 2;

/* Very gentle wind sway for instanced foliage: a tiny vertex offset driven by one shared time uniform. */
const WIND = { uTime: { value: 0 } };
function windSway(mat, amp = 0.05) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uWindTime = WIND.uTime;
    sh.vertexShader = 'uniform float uWindTime;\n' + sh.vertexShader.replace('#include <begin_vertex>',
      `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec2 wp = vec2(instanceMatrix[3].x, instanceMatrix[3].z);
        float wph = wp.x * 0.17 + wp.y * 0.11;
        // slow gust front travelling across the forest, plus per-tree sway and fine leaf flutter
        float gust = 0.55 + 0.45 * sin(uWindTime * 0.35 - dot(wp, vec2(0.012, 0.020)));
        float h = clamp(position.y + 0.8, 0.0, 2.0);
        float wk = h * h * 0.5 * ${amp.toFixed(3)};
        float sway = sin(uWindTime * 1.25 + wph) + 0.35 * sin(uWindTime * 2.7 + wph * 1.9);
        float flutter = sin(uWindTime * 7.0 + wph * 3.1 + position.x * 5.0) * 0.12;
        transformed.x += (sway * gust + gust * 0.6 + flutter) * wk;
        transformed.z += (sin(uWindTime * 0.9 + wph * 1.3) * gust * 0.6 + flutter * 0.5) * wk;
      #endif`);
  };
  mat.customProgramCacheKey = () => 'wind2' + amp;
  return mat;
}
function WindClock() {
  useFrame(({ clock }) => { WIND.uTime.value = clock.elapsedTime; });
  return null;
}
const decal = (n) => ({ polygonOffset: true, polygonOffsetFactor: -n, polygonOffsetUnits: -n });

/* =====================================================================
 * SKY: gradient dome + sun glow + clouds + stars
 * ===================================================================== */
function SkyRig({ route }) {
  const dome = useRef();
  const clouds = useRef();
  const cloudData = useMemo(() => {
    const r = rng(1234);
    return Array.from({ length: 18 }, () => ({
      x: (r() - 0.5) * 1500, y: 85 + r() * 80, z: (r() - 0.5) * 1400,
      w: 110 + r() * 150, speed: 1.2 + r() * 2.2, o: 0.35 + r() * 0.5
    }));
  }, []);
  const mat = useMemo(() => {
    const sun = new THREE.Vector3(...route.sunOffset).normalize();
    return new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(route.skyTop) }, uHor: { value: new THREE.Color(route.skyHorizon) },
        uSun: { value: sun }, uSunColor: { value: new THREE.Color(route.sunColor) }, uGlow: { value: route.sunGlow }
      },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `varying vec3 vDir; uniform vec3 uTop; uniform vec3 uHor; uniform vec3 uSun; uniform vec3 uSunColor; uniform float uGlow;
        void main(){
          vec3 d = normalize(vDir);
          float h = clamp(d.y, 0.0, 1.0);
          vec3 col = mix(uHor, uTop, pow(h, 0.5));
          float s = max(dot(d, normalize(uSun)), 0.0);
          col += uSunColor * (pow(s, 900.0) * 3.0 + pow(s, 48.0) * 0.55 * uGlow + pow(s, 6.0) * 0.22 * uGlow);
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`
    });
  }, [route]);

  useFrame((state, delta) => {
    if (dome.current) dome.current.position.copy(state.camera.position);
    if (clouds.current) {
      const cx = state.camera.position.x, cz = state.camera.position.z;
      clouds.current.children.forEach((s, i) => {
        const d = cloudData[i];
        d.x += d.speed * delta;
        if (d.x - cx > 750) d.x -= 1500; else if (d.x - cx < -750) d.x += 1500;
        if (d.z - cz > 700) d.z -= 1400; else if (d.z - cz < -700) d.z += 1400;
        s.position.set(d.x, d.y, d.z);
        const br = 1 + Math.sin(state.clock.elapsedTime * 0.07 + i * 1.7) * 0.025;
        s.scale.set(d.w * br, d.w * 0.4 * br, 1);
        s.material.opacity = d.o * route.clouds * (0.92 + Math.sin(state.clock.elapsedTime * 0.11 + i) * 0.08);
      });
    }
  });

  return <>
    <group ref={dome}>
      <mesh renderOrder={-10} frustumCulled={false}><sphereGeometry args={[900, 32, 16]} /><primitive object={mat} attach="material" /></mesh>
      {route.night && <Stars radius={600} depth={60} count={1800} factor={5} saturation={0} fade speed={0.4} />}
    </group>
    <group ref={clouds}>
      {cloudData.map((d, i) => <sprite key={i} scale={[d.w, d.w * 0.4, 1]} position={[d.x, d.y, d.z]}>
        <spriteMaterial map={getCloudTexture()} color={route.cloudTint} transparent opacity={d.o * route.clouds} depthWrite={false} fog={false} />
      </sprite>)}
    </group>
  </>;
}

/* Directional light that follows the car so shadows stay sharp around it */
function Sun({ route, positionRef }) {
  const light = useRef();
  const target = useMemo(() => new THREE.Object3D(), []);
  useFrame(() => {
    const p = positionRef.current;
    if (!light.current) return;
    light.current.position.set(p.x + route.sunOffset[0], route.sunOffset[1], p.z + route.sunOffset[2]);
    target.position.set(p.x, 0, p.z);
    target.updateMatrixWorld();
  });
  return <>
    <directionalLight ref={light} target={target} color={route.lightColor} intensity={route.lightIntensity} castShadow
      shadow-mapSize-width={1024} shadow-mapSize-height={1024}
      shadow-camera-left={-34} shadow-camera-right={34} shadow-camera-top={34} shadow-camera-bottom={-34}
      shadow-camera-near={1} shadow-camera-far={220} shadow-bias={-0.0006} shadow-normalBias={0.05} />
    <primitive object={target} />
  </>;
}

/* =====================================================================
 * SCENERY: mountains, hills, trees, bushes, rocks
 * ===================================================================== */
function Backdrop({ route, routeKey }) {
  const { mountains, caps, hills } = useMemo(() => {
    const r = rng(routeKey === 'dusk' ? 77 : routeKey === 'forest' ? 55 : 33);
    const base = new THREE.Color(route.mountain);
    const mountains = [], caps = [], hills = [];
    const addMountain = (x, z, layer) => {
      const R = 110 + r() * 90 + layer * 40, H = 55 + r() * 75 + layer * 45;
      const col = base.clone().offsetHSL((r() - 0.5) * 0.03, 0, (r() - 0.5) * 0.06 + layer * 0.03);
      mountains.push({ p: [x, H / 2 - 4, z], s: [R, H, R], ry: r() * 3, c: col });
      if (H > 95) caps.push({ p: [x, H - H * 0.16 - 4, z], s: [R * 0.345, H * 0.32, R * 0.345], ry: 0 });
    };
    for (let z = -960; z <= 960; z += 62) {
      addMountain(-(340 + r() * 140), z + r() * 30, 0);
      addMountain(340 + r() * 140, z + r() * 30, 0);
      if (z % 124 === 0) { addMountain(-(620 + r() * 140), z, 1); addMountain(620 + r() * 140, z, 1); }
    }
    for (let x = -700; x <= 700; x += 110) { addMountain(x + r() * 40, -(1020 + r() * 80), 1); addMountain(x + r() * 40, 1020 + r() * 80, 1); }
    const hc = new THREE.Color(route.hill);
    for (let z = -820; z <= 820; z += 46) {
      for (const side of [-1, 1]) {
        const h = 14 + r() * 26;
        hills.push({ p: [side * (115 + r() * 130), -h * 0.28, z + r() * 20], s: [55 + r() * 60, h, 45 + r() * 50], c: hc.clone().offsetHSL((r() - 0.5) * 0.03, 0, (r() - 0.5) * 0.08) });
      }
    }
    return { mountains, caps, hills };
  }, [route, routeKey]);
  return <group>
    <Inst items={mountains}><coneGeometry args={[1, 1, 6]} /><meshStandardMaterial color="#ffffff" flatShading roughness={1} /></Inst>
    <Inst items={caps}><coneGeometry args={[1, 1, 6]} /><meshStandardMaterial color={route.snow} flatShading roughness={0.9} /></Inst>
    <Inst items={hills} receiveShadow><sphereGeometry args={[1, 14, 8]} /><meshStandardMaterial color="#ffffff" roughness={1} /></Inst>
  </group>;
}

function Scenery({ route, routeKey }) {
  const d = useMemo(() => {
    const r = rng(routeKey === 'dusk' ? 21 : routeKey === 'forest' ? 7 : 42);
    const trunks = [], c0 = [], c1 = [], c2 = [], rTrunks = [], blobsA = [], blobsB = [], bushes = [], rocks = [];
    const fol = route.foliage.map(h => new THREE.Color(h));
    const autumn = [new THREE.Color('#d98a3d'), new THREE.Color('#c9602f'), new THREE.Color('#e0b13f')];
    const jitter = (c) => c.clone().offsetHSL((r() - 0.5) * 0.04, (r() - 0.5) * 0.1, (r() - 0.5) * 0.07);
    const trunkCol = new THREE.Color('#76523a');
    // Keep trees clear of the overpass abutments and roadside signs
    const blocked = (x, z) => (Math.abs(z - 400) < 6 && Math.abs(x) < 22) || [-170, -410, 150].some(sz => Math.abs(z - sz) < 4.5 && Math.abs(x) < 15) || isRampCorridor(route, x, z, 10.5);
    for (let z = -740; z <= 740; z += route.treeStep) {
      for (const side of [-1, 1]) {
        const x = side * (route.treeMin + Math.pow(r(), 1.3) * route.treeSpread);
        const zz = z + (r() - 0.5) * route.treeStep;
        const s = 0.85 + r() * 1.05;
        const ry = r() * 6;
        if (blocked(x, zz)) continue;
        if (r() < route.roundChance) {
          const c = r() < route.autumnChance ? jitter(autumn[Math.floor(r() * 3)]) : jitter(fol[Math.floor(r() * 3)]).offsetHSL(0, 0, 0.03);
          rTrunks.push({ p: [x, 0.9 * s, zz], s: [s, s, s], c: trunkCol });
          blobsA.push({ p: [x, 2.5 * s, zz], s: [1.35 * s, 1.15 * s, 1.35 * s], ry, c });
          blobsB.push({ p: [x + 0.5 * s, 3.2 * s, zz - 0.3 * s], s: [0.95 * s, 0.85 * s, 0.95 * s], ry: ry + 1, c: c.clone().offsetHSL(0, 0, 0.04) });
        } else {
          const c = jitter(fol[Math.floor(r() * 3)]);
          trunks.push({ p: [x, 0.8 * s, zz], s, c: trunkCol });
          c0.push({ p: [x, 1.45 * s, zz], s: [0.8 * s, s, 0.8 * s], ry, c });
          c1.push({ p: [x, 1.97 * s, zz], s: [0.66 * s, s, 0.66 * s], ry, c: c.clone().offsetHSL(0, 0, 0.025) });
          c2.push({ p: [x, 2.49 * s, zz], s: [0.52 * s, s, 0.52 * s], ry, c: c.clone().offsetHSL(0, 0, 0.05) });
        }
        if (r() < 0.55) {
          const bx = side * (11 + r() * 24), bz = z + r() * route.treeStep, bs = 0.5 + r() * 0.8;
          if (!isRampCorridor(route, bx, bz, 10.5)) bushes.push({ p: [bx, bs * 0.5, bz], s: [bs * 1.3, bs, bs * 1.3], ry: r() * 3, c: jitter(fol[Math.floor(r() * 3)]).offsetHSL(0, 0, 0.04) });
        }
        if (r() < 0.16) {
          const rx = side * (10.5 + r() * 40), rz = z + r() * route.treeStep, rs = 0.5 + r() * 1.5;
          if (!isRampCorridor(route, rx, rz, 10.5)) rocks.push({ p: [rx, rs * 0.28, rz], s: [rs * 1.2, rs * 0.75, rs], ry: r() * 6, c: new THREE.Color('#8b949b').offsetHSL(0, 0, (r() - 0.5) * 0.12) });
        }
      }
    }
    return { trunks, c0, c1, c2, rTrunks, blobsA, blobsB, bushes, rocks };
  }, [route, routeKey]);
  const foliageMat = <meshStandardMaterial color="#ffffff" roughness={1} ref={m => m && windSway(m, 0.045)} />;
  return <group>
    <Inst items={d.trunks} castShadow><cylinderGeometry args={[0.12, 0.19, 1.6, 6]} /><meshStandardMaterial color="#ffffff" roughness={1} /></Inst>
    <Inst items={d.c0} castShadow><coneGeometry args={[1, 1.35, 7]} />{foliageMat}</Inst>
    <Inst items={d.c1} castShadow><coneGeometry args={[1, 1.35, 7]} />{foliageMat}</Inst>
    <Inst items={d.c2} castShadow><coneGeometry args={[1, 1.35, 7]} />{foliageMat}</Inst>
    <Inst items={d.rTrunks} castShadow><cylinderGeometry args={[0.14, 0.22, 1.8, 6]} /><meshStandardMaterial color="#ffffff" roughness={1} /></Inst>
    <Inst items={d.blobsA} castShadow><icosahedronGeometry args={[1, 1]} /><meshStandardMaterial color="#ffffff" roughness={0.95} flatShading ref={m => m && windSway(m, 0.05)} /></Inst>
    <Inst items={d.blobsB} castShadow><icosahedronGeometry args={[1, 1]} /><meshStandardMaterial color="#ffffff" roughness={0.95} flatShading ref={m => m && windSway(m, 0.05)} /></Inst>
    <Inst items={d.bushes} castShadow><icosahedronGeometry args={[1, 0]} /><meshStandardMaterial color="#ffffff" roughness={1} flatShading ref={m => m && windSway(m, 0.035)} /></Inst>
    <Inst items={d.rocks} castShadow receiveShadow><dodecahedronGeometry args={[1, 0]} /><meshStandardMaterial color="#ffffff" roughness={1} flatShading /></Inst>
  </group>;
}

/* =====================================================================
 * ROAD, GATES, SIGNS, OVERPASS
 * ===================================================================== */
function HighwaySign({ z, side, title, subtitle, accent }) {
  const tex = useMemo(() => makeLabelTexture({ title, subtitle, accent }), [title, subtitle, accent]);
  return <group position={[side * 10.8, 0, z]}>
    {[-1.4, 1.4].map(x => <mesh key={x} position={[x, 1.7, 0]} castShadow><boxGeometry args={[0.12, 3.4, 0.14]} /><meshStandardMaterial color="#a7b1b9" metalness={0.55} roughness={0.4} /></mesh>)}
    <mesh position={[0, 3.45, -0.06]} castShadow><boxGeometry args={[4.1, 1.35, 0.1]} /><meshStandardMaterial color="#0d2a29" roughness={0.6} /></mesh>
    <mesh position={[0, 3.45, 0.0]}><planeGeometry args={[3.95, 1.24]} /><meshBasicMaterial map={tex} toneMapped={false} /></mesh>
  </group>;
}

/* One gantry per physical gate. Mainline gates serve both directions, so the face northbound traffic sees
 * (+Z side) and the face southbound traffic sees (-Z side) each show that direction's role (e.g. A: ENTRY / EXIT). */
function gateSigns(route) {
  const kindColor = (k, route) => (k === 'ENTRY' ? route.accent : '#5ab5ff');
  const label = (g, dirName) => ({ title: `${g.kind === 'ENTRY' ? 'ENTRY' : 'EXIT'} GATE ${g.id}`, subtitle: `${dirName} · ${g.position} m`, color: kindColor(g.kind, route) });
  const out = [];
  const fwd = route.gates || [], rev = route.reverseGates || [];
  for (const g of fwd) {
    if (!(g.x || 0)) {
      const r = rev.find(q => q.position === g.position && !(q.x || 0));
      const front = label(g, 'NORTHBOUND'), back = r ? label(r, 'SOUTHBOUND') : front;
      out.push({ gid: `main-${g.id}`, x: 0, z: Z_START - g.position, ...front, color: g.kind === 'ENTRY' || (r && r.kind === 'ENTRY') ? route.accent : '#5ab5ff', back });
    } else {
      const f = label(g, 'NORTHBOUND'); out.push({ gid: `nb-${g.id}`, x: g.x, z: Z_START - g.position, ...f, back: f });
    }
  }
  for (const g of rev) if ((g.x || 0) !== 0) { const f = label(g, 'SOUTHBOUND'); out.push({ gid: `sb-${g.id}`, x: g.x, z: Z_START - g.position, ...f, back: f }); }
  return out;
}

function ZoneGate({ x = 0, z, title, subtitle, color, back }) {
  const tex = useMemo(() => makeLabelTexture({ title, subtitle, accent: color, bg: '#0a1722', fg: color }), [title, subtitle, color]);
  const backTex = useMemo(() => (back ? makeLabelTexture({ title: back.title, subtitle: back.subtitle, accent: back.color, bg: '#0a1722', fg: back.color }) : tex), [back, tex]);
  const stripe = useRef(); const led = useRef(); const field = useRef();
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (field.current) field.current.material.opacity = 0.04 + Math.sin(t * 1.6 + z * 0.05) * 0.02;
    if (stripe.current) stripe.current.material.opacity = 0.5 + Math.sin(t * 3) * 0.22;
    if (led.current) led.current.visible = Math.sin(t * 6) > -0.3;
  });
  const steel = <meshStandardMaterial color="#c9d3da" metalness={0.55} roughness={0.38} />;
  return <group position={[x, 0, z]}>
    {[-1, 1].map(side => <group key={side} position={[side * 7.7, 0, 0]}>
      <mesh position={[0, 3.45, 0]} castShadow><boxGeometry args={[0.42, 6.9, 0.42]} />{steel}</mesh>
      <mesh position={[0, 3.45, 0.22]}><boxGeometry args={[0.1, 6.5, 0.02]} /><meshBasicMaterial color={color} toneMapped={false} /></mesh>
      <mesh position={[0, 0.16, 0]}><boxGeometry args={[0.95, 0.32, 0.95]} /><meshStandardMaterial color="#4b5963" roughness={0.8} /></mesh>
    </group>)}
    <mesh position={[0, 6.75, 0]} castShadow><boxGeometry args={[16.6, 0.6, 0.6]} />{steel}</mesh>
    <mesh position={[0, 6.38, 0.31]}><boxGeometry args={[15.8, 0.07, 0.04]} /><meshBasicMaterial color={color} toneMapped={false} /></mesh>
    <mesh position={[0, 5.2, -0.08]} castShadow><boxGeometry args={[7.5, 2.45, 0.12]} /><meshStandardMaterial color="#0a1722" roughness={0.6} /></mesh>
    <mesh position={[0, 5.2, 0.0]}><planeGeometry args={[7.3, 2.28]} /><meshBasicMaterial map={tex} toneMapped={false} /></mesh>
    <mesh position={[0, 5.2, -0.16]} rotation={[0, Math.PI, 0]}><planeGeometry args={[7.3, 2.28]} /><meshBasicMaterial map={backTex} toneMapped={false} /></mesh>
    {[-3.2, 3.2].map(x => <mesh key={x} position={[x, 6.15, 0]}><boxGeometry args={[0.08, 0.5, 0.08]} />{steel}</mesh>)}
    {[-4.6, 0, 4.6].map(x => <group key={x} position={[x, 6.1, 0.05]}>
      <mesh><boxGeometry args={[0.6, 0.34, 0.5]} /><meshStandardMaterial color="#1a2430" metalness={0.4} roughness={0.5} /></mesh>
      <mesh position={[0, 0, 0.26]}><boxGeometry args={[0.16, 0.16, 0.03]} /><meshBasicMaterial color="#0b0b0b" /></mesh>
    </group>)}
    <mesh ref={led} position={[0, 6.1, 0.34]}><boxGeometry args={[0.1, 0.1, 0.03]} /><meshBasicMaterial color="#ff3040" toneMapped={false} /></mesh>
    <mesh ref={stripe} rotation={[FLAT, 0, 0]} position={[0, 0.03, 0]}>
      <planeGeometry args={[12.8, 0.7]} /><meshBasicMaterial color={color} transparent opacity={0.6} depthWrite={false} toneMapped={false} {...decal(4)} />
    </mesh>
    <mesh ref={field} position={[0, 3.2, 0]}><planeGeometry args={[12.8, 6.4]} /><meshBasicMaterial color={color} transparent opacity={0.045} depthWrite={false} side={THREE.DoubleSide} /></mesh>
  </group>;
}

function Corridor({ route }) {
  const len = route.exit - route.entry;
  const zc = Z_START - (route.entry + route.exit) / 2;
  const chev = useRef();
  const geo = useMemo(() => {
    const s = new THREE.Shape();
    s.moveTo(-1, -0.55); s.lineTo(0, 0.55); s.lineTo(1, -0.55); s.lineTo(1, -1.0); s.lineTo(0, 0.1); s.lineTo(-1, -1.0); s.closePath();
    return new THREE.ShapeGeometry(s);
  }, []);
  const rows = useMemo(() => Math.max(1, Math.floor(len / 16)), [len]);
  const accent = useMemo(() => new THREE.Color(route.accent), [route]);
  useLayoutEffect(() => {
    const m = chev.current; if (!m) return;
    const o = new THREE.Object3D(); let i = 0;
    // right lane = northbound traffic (points -Z), left lane = southbound traffic (points +Z)
    for (let r = 0; r < rows; r++) for (const [x, rot] of [[4.26, 0], [-4.26, Math.PI]]) {
      o.position.set(x, 0.022, Z_START - route.entry - 8 - r * 16);
      o.rotation.set(FLAT, 0, rot); o.scale.set(1.15, 1.15, 1); o.updateMatrix(); m.setMatrixAt(i++, o.matrix);
      m.setColorAt(i - 1, accent);
    }
    m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [rows, route, accent]);
  useFrame(({ clock }) => {
    const m = chev.current; if (!m) return;
    const t = clock.elapsedTime; const c = new THREE.Color(); let i = 0;
    for (let r = 0; r < rows; r++) {
      // each lane's chevrons pulse in the direction its traffic travels
      c.copy(accent).multiplyScalar(0.18 + 0.82 * Math.max(0, Math.sin(t * 4 - r * 0.55))); m.setColorAt(i++, c);
      c.copy(accent).multiplyScalar(0.18 + 0.82 * Math.max(0, Math.sin(t * 4 + r * 0.55))); m.setColorAt(i++, c);
    }
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });
  return <group>
    <mesh rotation={[FLAT, 0, 0]} position={[0, 0.012, zc]}><planeGeometry args={[12.8, len]} /><meshBasicMaterial color={route.accent} transparent opacity={0.09} side={THREE.DoubleSide} depthWrite={false} {...decal(2)} /></mesh>
    {[-6.7, 6.7].map(x => <mesh key={x} rotation={[FLAT, 0, 0]} position={[x, 0.014, zc]}><planeGeometry args={[0.22, len]} /><meshBasicMaterial color={route.accent} toneMapped={false} {...decal(3)} /></mesh>)}
    <instancedMesh key={rows} ref={chev} args={[geo, null, rows * 2]} frustumCulled={false}>
      <meshBasicMaterial color="#ffffff" transparent opacity={0.8} depthWrite={false} toneMapped={false} {...decal(3)} />
    </instancedMesh>
  </group>;
}

function Overpass({ z }) {
  const concrete = <meshStandardMaterial color="#aab1b7" roughness={0.92} />;
  return <group position={[0, 0, z]}>
    <mesh position={[0, 7.2, 0]} castShadow receiveShadow><boxGeometry args={[36, 0.9, 7.5]} />{concrete}</mesh>
    {[-1, 1].map(s => <mesh key={s} position={[0, 8.05, s * 3.55]} castShadow><boxGeometry args={[36, 0.85, 0.3]} />{concrete}</mesh>)}
    {[-1, 1].map(s => <group key={s}>
      <mesh position={[s * 11.8, 3.4, 0]} castShadow receiveShadow><boxGeometry args={[1.6, 6.9, 5.4]} />{concrete}</mesh>
      <mesh position={[s * 14.5, 1.6, 0]} castShadow><boxGeometry args={[4.5, 3.4, 5.4]} />{concrete}</mesh>
    </group>)}
    <mesh position={[0, 6.7, 0]}><boxGeometry args={[34, 0.08, 0.12]} /><meshBasicMaterial color="#fff1c9" toneMapped={false} /></mesh>
    <mesh position={[0, 7.2, 3.78]}><boxGeometry args={[36, 0.12, 0.05]} /><meshBasicMaterial color="#e5434f" toneMapped={false} /></mesh>
  </group>;
}

/* Ramp centreline: the SAME smoothstep curve the physics surface test, minimap and backend use,
 * so the painted road always matches where the car is treated as "on road". */
const RAMP_LEN = RAMP_LENGTH, RAMP_HALF = 4.2, RAMP_TAPER = 34;
/* Triangle strip between two lateral offsets (relative to the centreline, positive = away from the mainline)
 * sampled along the ramp in increasing route progress. Offsets are mirrored for southbound (x < 0) ramps. */
function rampStrip(gate, inner, outer, y, uScale = 1) {
  const dir = gate.dir === -1 ? -1 : 1, sg = gate.x < 0 ? -1 : 1;
  const start = dir === 1 ? gate.position - RAMP_LEN : gate.position + RAMP_LEN;   // where the ramp leaves the mainline
  const lo = dir === 1 ? start : gate.position - 4, hi = dir === 1 ? gate.position + 4 : start, steps = 52;
  const verts = [], uvs = [], idx = []; let run = 0, prev = null;
  for (let i = 0; i <= steps; i++) {
    const progress = lo + (hi - lo) * (i / steps);
    const c = rampCentre(gate, progress), c2 = rampCentre(gate, Math.min(hi, progress + 0.5)), c1 = rampCentre(gate, Math.max(lo, progress - 0.5));
    // unit normal to the centreline in the XZ plane (increasing progress = -Z)
    const dx = c2 - c1, dz = -1.0, len = Math.hypot(dx, dz), nx = -dz / len, nz = dx / len;
    const ramp = clamp(dir * (progress - start) / RAMP_TAPER, 0, 1), taper = ramp * ramp * (3 - 2 * ramp);
    const a0 = inner(taper), b0 = outer(taper);
    const a = sg > 0 ? a0 : -b0, b = sg > 0 ? b0 : -a0, z = Z_START - progress;
    verts.push(c + nx * a, y, z + nz * a, c + nx * b, y, z + nz * b);
    if (prev !== null) run += Math.hypot(c - prev, 1); prev = c;
    uvs.push(0, run / 4.3, uScale, run / 4.3);
    if (i < steps) { const n = i * 2; idx.push(n, n + 1, n + 2, n + 1, n + 3, n + 2); } // counter-clockwise seen from above
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

function ExitRamp({ gate, route }) {
  const asphalt = useMemo(() => makeAsphaltTexture([1, 1]), []);
  const geo = useMemo(() => {
    // Lane surface: the inner edge peels off the mainline shoulder, the outer edge fans out, so the
    // ramp starts as a thin wedge (gore) at the road edge and widens to full width over ~34 m.
    const surface = rampStrip(gate, t => -RAMP_HALF * t, t => RAMP_HALF * t, 0.019, 2);
    const apron = rampStrip(gate, t => -(RAMP_HALF + 0.9) * t, t => (RAMP_HALF + 0.9) * t, 0.016, 2);
    const edgeIn = rampStrip(gate, t => -(RAMP_HALF - 0.12) * t, t => -(RAMP_HALF - 0.30) * t, 0.024);
    const edgeOut = rampStrip(gate, t => (RAMP_HALF - 0.30) * t, t => (RAMP_HALF - 0.12) * t, 0.024);
    return { surface, apron, edgeIn, edgeOut };
  }, [gate.position, gate.x, gate.dir]);
  return <group>
    <mesh geometry={geo.apron} receiveShadow><meshStandardMaterial color="#2a323b" roughness={0.98} {...decal(2)} /></mesh>
    <mesh geometry={geo.surface} receiveShadow><meshStandardMaterial color={route.road} map={asphalt} roughness={0.9} metalness={0.04} envMapIntensity={0.5} {...decal(3)} /></mesh>
    <mesh geometry={geo.edgeIn}><meshStandardMaterial color="#f4f0dc" roughness={0.6} {...decal(5)} /></mesh>
    <mesh geometry={geo.edgeOut}><meshStandardMaterial color="#f4f0dc" roughness={0.6} {...decal(5)} /></mesh>
    <mesh position={[gate.x || 0, 0.03, Z_START - gate.position]}><boxGeometry args={[8.2, 0.02, 0.24]} /><meshBasicMaterial color={gate.kind === 'ENTRY' ? route.accent : '#5ab5ff'} toneMapped={false} /></mesh>
  </group>;
}

function isRampCorridor(route, x, z, margin = 5.8) { return onRampCorridorAt(route, x, z, margin); }

function Road({ routeKey, route }) {
  const asphalt = useMemo(() => makeAsphaltTexture([3, 150]), []);
  const grass = useMemo(() => makeGrassTexture([90, 100]), []);
  const glow = getGlowTexture();
  const lampColor = useMemo(() => new THREE.Color(route.lamp), [route]);

  const dashes = useMemo(() => { const a = []; for (const x of [-2.12, 2.12]) for (let z = -740; z <= 740; z += 22) a.push({ p: [x, 0.02, z], rx: FLAT, s: [0.13, 8.5, 1] }); return a; }, []);
  const posts = useMemo(() => { const a = []; for (const side of [-1, 1]) for (let z = -740; z <= 740; z += 6) if (!isRampCorridor(route, side * 8.5, z, 2.1)) a.push({ p: [side * 8.5, 0.43, z] }); return a; }, [route]);
  const reflectors = useMemo(() => { const a = []; for (const side of [-1, 1]) for (let z = -740; z <= 740; z += 24) if (!isRampCorridor(route, side * 8.43, z, 2.1)) a.push({ p: [side * 8.43, 0.64, z], c: side < 0 ? '#ffb347' : '#ffffff' }); return a; }, [route]);
  const lamps = useMemo(() => {
    const poles = [], arms = [], heads = [], pools = [];
    for (const side of [-1, 1]) for (let z = -740; z <= 740; z += 40) {
      if (isRampCorridor(route, side * 9.6, z, 2.4)) continue;
      poles.push({ p: [side * 9.6, 2.5, z] });
      arms.push({ p: [side * 9.0, 4.9, z] });
      heads.push({ p: [side * 8.45, 4.82, z] });
      pools.push({ p: [side * 6.3, 0.03, z], rx: FLAT, s: [9, 14, 1] });
    }
    return { poles, arms, heads, pools };
  }, [route]);
  const wear = useMemo(() => [-4.26, 0, 4.26].flatMap(x => [x - 0.9, x + 0.9].map(xx => ({ p: [xx, 0.011, 0], rx: FLAT, s: [0.7, 1500, 1] }))), []);
  const gateEntryZ = Z_START - route.entry, gateExitZ = Z_START - route.exit;

  return <group>
    {/* Ground */}
    <mesh rotation={[FLAT, 0, 0]} position={[0, -0.23, 0]} receiveShadow><planeGeometry args={[2400, 2400]} /><meshStandardMaterial color={route.ground} map={grass} roughness={1} /></mesh>
    {/* Shoulders + asphalt */}
    <mesh rotation={[FLAT, 0, 0]} position={[0, -0.005, 0]} receiveShadow><planeGeometry args={[15.8, 1900]} /><meshStandardMaterial color="#2a323b" map={asphalt} roughness={0.98} /></mesh>
    <mesh rotation={[FLAT, 0, 0]} position={[0, 0.006, 0]} receiveShadow><planeGeometry args={[12.8, 1900]} /><meshStandardMaterial color={route.road} map={asphalt} roughness={0.9} metalness={0.04} envMapIntensity={0.5} /></mesh>
    {/* Tyre-wear tracks */}
    <Inst items={wear}><planeGeometry args={[1, 1]} /><meshBasicMaterial color="#000000" transparent opacity={0.13} depthWrite={false} {...decal(1)} /></Inst>
    {/* Edge lines + centre dashes */}
    {[-6.35, 6.35].map(x => <mesh key={x} rotation={[FLAT, 0, 0]} position={[x, 0.017, 0]}><planeGeometry args={[0.17, 1900]} /><meshStandardMaterial color="#f4f0dc" roughness={0.6} {...decal(2)} /></mesh>)}
    <Inst items={dashes}><planeGeometry args={[1, 1]} /><meshStandardMaterial color="#e8ebea" roughness={0.65} {...decal(2)} /></Inst>
    {/* Guardrails */}
    <Inst items={posts} castShadow><boxGeometry args={[0.08, 0.78, 0.08]} /><meshStandardMaterial color="#6b7881" metalness={0.4} roughness={0.5} /></Inst>
    <Inst items={reflectors}><boxGeometry args={[0.05, 0.07, 0.03]} /><meshBasicMaterial color="#ffffff" toneMapped={false} /></Inst>
    {[-1, 1].flatMap(side => {
      // gaps in the guardrail where this side's branch ramps leave the carriageway (northbound ramps on +x, southbound on -x)
      const gaps = rampGatesOf(route).filter(g => (g.x < 0 ? -1 : 1) === side).map(g => { const [lo, hi] = rampSpan(g); return [Z_START - hi, Z_START - lo]; }).sort((a, b) => a[0] - b[0]);
      const segments = []; let cursor = -950;
      gaps.forEach(([a, b]) => { if (a > cursor) segments.push([cursor, a]); cursor = Math.max(cursor, b); });
      if (cursor < 950) segments.push([cursor, 950]);
      return segments.map(([a, b], i) => <mesh key={`rail-${side}-${i}`} position={[side * 8.5, 0.67, (a + b) / 2]} castShadow><boxGeometry args={[0.13, 0.15, Math.max(0.1, b - a)]} /><meshStandardMaterial color="#b6c0c6" metalness={0.6} roughness={0.35} /></mesh>);
    })}
    {/* Lamps */}
    <Inst items={lamps.poles} castShadow><cylinderGeometry args={[0.06, 0.09, 5, 8]} /><meshStandardMaterial color="#8899a4" metalness={0.6} roughness={0.35} /></Inst>
    <Inst items={lamps.arms}><boxGeometry args={[1.3, 0.08, 0.2]} /><meshStandardMaterial color="#8899a4" metalness={0.5} roughness={0.4} /></Inst>
    <Inst items={lamps.heads}><boxGeometry args={[0.45, 0.07, 0.18]} /><meshBasicMaterial color={lampColor} toneMapped={false} /></Inst>
    <Inst items={lamps.pools}><planeGeometry args={[1, 1]} /><meshBasicMaterial map={glow} color={lampColor} transparent opacity={route.poolOpacity} depthWrite={false} blending={THREE.AdditiveBlending} {...decal(3)} /></Inst>
    {/* Toll corridor + gates */}
    <Corridor route={route} />
    {rampGatesOf(route).map(g => <ExitRamp key={`ramp-${g.dir === -1 ? 'sb' : 'nb'}-${g.id}`} gate={g} route={route} />)}
    {gateSigns(route).map(g => <ZoneGate key={g.gid} {...g} />)}
    {/* Signage and structures */}
    <HighwaySign z={-170} side={-1} title="FLOWPASS" subtitle="DISTANCE TOLLING" accent={route.accent} />
    <HighwaySign z={-410} side={1} title="SAFE DRIVE" subtitle="STAY IN LANE" accent={route.accent} />
    <HighwaySign z={150} side={-1} title={route.name.toUpperCase()} subtitle="DEMO ROUTE" accent={route.accent} />
    <Overpass z={400} />
    <Scenery route={route} routeKey={routeKey} />
    <Backdrop route={route} routeKey={routeKey} />
  </group>;
}

/* =====================================================================
 * WIND STREAKS (speed feeling)
 * ===================================================================== */
function SpeedStreaks({ positionRef, headingRef, speedRef }) {
  const COUNT = 38;
  const mesh = useRef();
  const pts = useRef(Array.from({ length: COUNT }, () => ({ x: 0, y: -50, z: 0, ready: false })));
  const o = useMemo(() => new THREE.Object3D(), []);
  useFrame((_, delta) => {
    const m = mesh.current; if (!m) return;
    const dt = Math.min(delta, 0.05);
    const p = positionRef.current, h = headingRef.current, v = speedRef.current;
    const fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h);
    const fast = v > 14;
    const targetO = fast ? clamp((v - 14) / 22, 0, 1) * 0.36 : 0;
    // Frame-rate independent easing prevents airflow streaks from pulsing on slower machines.
    m.material.opacity += (targetO - m.material.opacity) * (1 - Math.exp(-dt * 5.0));
    m.visible = m.material.opacity > 0.004;
    if (!fast) return;
    const len = clamp(v * 0.31, 1.1, 10);
    pts.current.forEach((s, i) => {
      const ahead = (s.x - p.x) * fx + (s.z - p.z) * fz;
      if (!s.ready || ahead < -8 || ahead > 80) {
        const a = 10 + Math.random() * 60, lat = (Math.random() < 0.5 ? -1 : 1) * (2.2 + Math.random() * 8);
        s.x = p.x + fx * a + rx * lat; s.z = p.z + fz * a + rz * lat; s.y = 0.4 + Math.random() * 4; s.ready = true;
      }
      o.position.set(s.x, s.y, s.z); o.rotation.set(0, -h, 0); o.scale.set(0.03, 0.03, len); o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={mesh} args={[null, null, COUNT]} frustumCulled={false}>
    <boxGeometry args={[1, 1, 1]} /><meshBasicMaterial color="#d9f7ff" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} fog={false} />
  </instancedMesh>;
}

/* =====================================================================
 * CAR
 * ===================================================================== */
function useCarEnv(route) {
  const gl = useThree(s => s.gl);
  return useMemo(() => {
    const sc = new THREE.Scene();
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: {
        uTop: { value: new THREE.Color(route.skyTop) }, uHor: { value: new THREE.Color(route.skyHorizon) },
        uGround: { value: new THREE.Color(route.ground).multiplyScalar(0.35) },
        uSun: { value: new THREE.Vector3(...route.sunOffset).normalize() }, uSunColor: { value: new THREE.Color(route.sunColor) }
      },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `varying vec3 vDir; uniform vec3 uTop; uniform vec3 uHor; uniform vec3 uGround; uniform vec3 uSun; uniform vec3 uSunColor;
        void main(){
          vec3 d = normalize(vDir);
          vec3 col = d.y > 0.0 ? mix(uHor, uTop, pow(clamp(d.y, 0.0, 1.0), 0.5)) : mix(uHor * 0.6, uGround, clamp(-d.y * 3.0, 0.0, 1.0));
          float s = max(dot(d, uSun), 0.0);
          col += uSunColor * (pow(s, 60.0) * 6.0 + pow(s, 8.0) * 0.6);
          gl_FragColor = vec4(col, 1.0);
        }`
    });
    sc.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), mat));
    const pm = new THREE.PMREMGenerator(gl);
    const rt = pm.fromScene(sc, 0.02);
    pm.dispose();
    return rt.texture;
  }, [gl, route]);
}

function shade(hex, f) { const c = new THREE.Color(hex); c.multiplyScalar(f); return `#${c.getHexString()}`; }

/* Tyre marks: ring buffer of dark decals dropped behind the rear wheels while the car is skidding */
const SKID_GEO = new THREE.PlaneGeometry(0.22, 1).rotateX(-Math.PI / 2);
function SkidMarks({ positionRef, headingRef, resetKey, roadColor = '#3a4149' }) {
  const COUNT = 320;
  const mesh = useRef();
  const st = useRef({ i: 0, lx: 0, lz: 0, has: false, born: new Float32Array(COUNT).fill(-1), clock: 0, fadeT: 0 });
  const colA = useMemo(() => new THREE.Color('#0b0d10'), []);
  const colB = useMemo(() => new THREE.Color(roadColor).multiplyScalar(0.9), [roadColor]);
  const colTmp = useMemo(() => new THREE.Color(), []);
  const o = useMemo(() => new THREE.Object3D(), []);
  useLayoutEffect(() => {
    const m = mesh.current; if (!m) return;
    o.scale.set(0, 0, 0); o.updateMatrix();
    for (let i = 0; i < COUNT; i++) m.setMatrixAt(i, o.matrix);
    m.instanceMatrix.needsUpdate = true;
  }, [o]);
  useFrame((_, delta) => {
    const m = mesh.current, p = positionRef.current; if (!m) return;
    const s = st.current;
    s.clock += delta; s.fadeT += delta;
    // marks darken instantly, then slowly weather back into the asphalt over ~18 s
    if (s.fadeT > 0.25) {
      s.fadeT = 0; let any = false;
      for (let i = 0; i < COUNT; i++) {
        if (s.born[i] < 0) continue;
        const k = clamp((s.clock - s.born[i]) / 18, 0, 1);
        colTmp.copy(colA).lerp(colB, k * k); m.setColorAt(i, colTmp); any = true;
      }
      if (any && m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    if (!p.skid || p.surface === 'OFFROAD') { s.has = false; return; }
    if (s.has && Math.hypot(p.x - s.lx, p.z - s.lz) < 0.7) return;
    const h = headingRef.current, fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h);
    const seg = s.has ? clamp(Math.hypot(p.x - s.lx, p.z - s.lz) + 0.15, 0.7, 3) : 0.7;
    for (const side of [-0.82, 0.82]) {
      o.position.set(p.x - fx * 1.25 + rx * side, 0.03, p.z - fz * 1.25 + rz * side);
      o.rotation.set(0, -h, 0); o.scale.set(1, 1, seg); o.updateMatrix();
      m.setMatrixAt(s.i, o.matrix); m.setColorAt(s.i, colA); s.born[s.i] = s.clock; s.i = (s.i + 1) % COUNT;
    }
    m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
    s.lx = p.x; s.lz = p.z; s.has = true;
  });
  return <instancedMesh ref={mesh} args={[null, null, COUNT]} frustumCulled={false}>
    <primitive object={SKID_GEO} attach="geometry" />
    <meshBasicMaterial color="#ffffff" transparent opacity={0.55} depthWrite={false} {...decal(4)} />
  </instancedMesh>;
}

function Car({ positionRef, headingRef, speedRef, carColor, accent, night, lightsOn, route }) {
  const env = useCarEnv(route);
  const group = useRef(), bodyRef = useRef();
  const wheelRefs = useRef([]), tailMats = useRef([]), tailGlows = useRef([]);
  const lightFade = useRef(lightsOn ? 1 : 0), headPool = useRef(), headLamps = useRef([]);
  const wheelAngle = useRef(0), steerAngle = useRef(0);
  // underdamped springs give the body a believable overshoot instead of a straight ease
  const sus = useRef({ roll: [0, 0], pitch: [0, 0], heave: [0, 0], yaw: [0, 0] });
  const glowRef = useRef();
  const glow = getGlowTexture();
  const body = carColor, bodyLight = shade(carColor, 1.12), bodyDark = shade(carColor, 0.82);
  const glass = '#16232f';

  useFrame((_, delta) => {
    if (!group.current) return;
    const p = positionRef.current, heading = headingRef.current, spd = speedRef.current;
    group.current.position.set(p.x, 0.04, p.z);
    // The child vehicle-model group is rotated by PI to align its +Z-facing mesh with
    // the physics forward axis (-Z). This outer group applies the dynamic steering heading.
    group.current.rotation.y = -heading;

    const k = 1 - Math.exp(-6 * delta);
    steerAngle.current = lerp(steerAngle.current, (p.steerInput || 0) * 0.35, 1 - Math.exp(-8 * delta));
    const speedFactor = clamp(Math.abs(spd) / 30, 0, 1);
    // Body motion follows smoothed accelerations (not on/off pedal flags) so it eases in and out
    const dt = Math.min(delta, 0.033);
    const spring = (st, target, k, c) => { st[1] += (k * (target - st[0]) - c * st[1]) * dt; st[0] += st[1] * dt; };
    const rough = p.surface === 'OFFROAD' ? 1 : p.surface === 'SHOULDER' ? 0.35 : 0;
    const tn = performance.now() * 0.001;
    const rollT = -(p.steerInput || 0) * 0.04 * speedFactor - clamp((p.accelLat || 0) * 0.0015, -0.02, 0.02);
    const pitchT = clamp(-(p.accelLong || 0) * 0.0022, -0.02, 0.035);
    // surface texture: fine road hum on asphalt, heavier multi-frequency bumps on shoulder / grass
    const bump = (Math.sin(tn * 17.3) + Math.sin(tn * 29.1 + 1.3) * 0.7 + Math.sin(tn * 41.7 + 2.1) * 0.4) * speedFactor;
    const bumpB = (Math.sin(tn * 13.1 + 0.6) + Math.sin(tn * 23.9 + 2.6) * 0.8) * speedFactor;
    const S = sus.current;
    spring(S.roll, rollT + bumpB * (0.0010 + rough * 0.008), 70, 14);
    spring(S.pitch, pitchT + bump * (0.0007 + rough * 0.006), 65, 13);
    spring(S.heave, bump * (0.0010 + rough * 0.010) + clamp(-(p.accelLong || 0) * 0.0005, -0.010, 0.008), 90, 16);
    spring(S.yaw, clamp((p.steerInput || 0) * -0.010 * speedFactor, -0.010, 0.010), 32, 10);
    if (bodyRef.current) {
      bodyRef.current.rotation.z = S.roll[0]; bodyRef.current.rotation.x = S.pitch[0]; bodyRef.current.rotation.y = S.yaw[0];
      bodyRef.current.position.y = S.heave[0] + Math.sin(tn * 45) * 0.0012 * (1 - speedFactor);
    }
    if (glowRef.current) glowRef.current.material.opacity = (night ? 0.8 : 0.4) * (0.9 + Math.sin(tn * 2.2) * 0.1) * (0.85 + speedFactor * 0.25);
    lightFade.current = lerp(lightFade.current, lightsOn ? 1 : 0, 1 - Math.exp(-9 * delta));
    if (headPool.current) headPool.current.material.opacity = 0.015 + 0.835 * lightFade.current;
    headLamps.current.forEach(l => { if (l) l.intensity = 7 * lightFade.current; });
    tailMats.current.forEach(m => { if (m) m.emissiveIntensity = lerp(m.emissiveIntensity, p.braking ? 5 : 1.6, k * 2); });
    tailGlows.current.forEach(s => {
      if (!s) return;
      const size = lerp(s.scale.x, p.braking ? 2.3 : 1.0, k * 2);
      s.scale.set(size, size, 1);
      s.material.opacity = lerp(s.material.opacity, p.braking ? 1 : 0.5, k * 2);
    });

    wheelAngle.current = (wheelAngle.current + spd * Math.min(delta, 0.05) / 0.34) % (Math.PI * 2); // rolling radius 0.34 m
    wheelRefs.current.forEach((w, i) => {
      if (!w) return;
      w.rotation.x = wheelAngle.current;
      if (i < 2) w.rotation.y = -steerAngle.current;
      // wheels follow the road surface independently of the body (small bounce on rough ground)
      w.position.y = 0.34 + Math.sin(performance.now() * 0.001 * (31 + i * 7) + i) * 0.006 * rough * speedFactor;
    });
  });

  const paint = (c) => <meshPhysicalMaterial color={c} metalness={0.5} roughness={0.3} clearcoat={1} clearcoatRoughness={0.06} envMap={env} envMapIntensity={1.1} />;
  return <group ref={group}>
    {/* soft blob shadow (always visible, even when real shadows are subtle) */}
    <mesh rotation={[FLAT, 0, 0]} position={[0, 0.02, 0]}><planeGeometry args={[3.0, 5.6]} /><meshBasicMaterial map={glow} color="#000000" transparent opacity={0.4} depthWrite={false} {...decal(5)} /></mesh>
    {/* underglow */}
    <mesh ref={glowRef} rotation={[FLAT, 0, 0]} position={[0, 0.07, 0]}><planeGeometry args={[3.2, 5.6]} /><meshBasicMaterial map={glow} color={accent} transparent opacity={night ? 0.8 : 0.4} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} {...decal(6)} /></mesh>

    <group rotation={[0, Math.PI, 0]}>
      {/* Headlight pool plus local lights: toggle affects both the visible beam and nearby illumination. */}
      <mesh ref={headPool} rotation={[FLAT, 0, 0]} position={[0, 0.045, 11]}><planeGeometry args={[7.5, 19]} /><meshBasicMaterial map={glow} color="#fff3d2" transparent opacity={lightsOn ? 0.85 : 0.015} depthWrite={false} blending={THREE.AdditiveBlending} {...decal(5)} /></mesh>
      {[-0.62, 0.62].map((side, i) => <pointLight key={side} ref={l => { headLamps.current[i] = l; }} position={[side, 0.62, 2.12]} color="#d9edff" intensity={lightsOn ? 7 : 0} distance={28} decay={2} />)}

      <group ref={bodyRef}>
        {/* Lower chassis, bonnet, cabin and rear deck */}
        <mesh position={[0, 0.47, 0]} castShadow>{<boxGeometry args={[1.9, 0.42, 4.15]} />}{paint(body)}</mesh>
        <mesh position={[0, 0.66, 0.98]} castShadow><boxGeometry args={[1.82, 0.28, 1.55]} />{paint(bodyLight)}</mesh>
        <mesh position={[0, 0.78, -0.72]} castShadow><boxGeometry args={[1.7, 0.28, 1.18]} />{paint(bodyDark)}</mesh>
        <mesh position={[0, 0.99, -0.25]} castShadow><boxGeometry args={[1.46, 0.66, 1.82]} />{paint(shade(carColor, 0.95))}</mesh>
        <mesh position={[0, 1.03, -0.25]}><boxGeometry args={[1.35, 0.52, 1.72]} /><meshPhysicalMaterial color={glass} metalness={0.8} roughness={0.05} clearcoat={1} clearcoatRoughness={0.03} envMap={env} envMapIntensity={1.5} /></mesh>
        <mesh position={[0, 1.06, 0.23]} rotation={[-0.25, 0, 0]}><boxGeometry args={[1.3, 0.04, 0.63]} /><meshStandardMaterial color="#2c4252" metalness={0.6} roughness={0.1} /></mesh>
        <mesh position={[0, 1.06, -0.75]} rotation={[0.22, 0, 0]}><boxGeometry args={[1.28, 0.04, 0.53]} /><meshStandardMaterial color="#2c4252" metalness={0.6} roughness={0.1} /></mesh>
        {/* Roof panel + rails */}
        <mesh position={[0, 1.335, -0.25]}><boxGeometry args={[1.38, 0.04, 1.6]} />{paint(bodyDark)}</mesh>
        {[-1, 1].map(s => <mesh key={s} position={[s * 0.62, 1.38, -0.25]}><boxGeometry args={[0.04, 0.05, 1.4]} /><meshStandardMaterial color="#9aa7b0" metalness={0.8} roughness={0.25} /></mesh>)}
        {/* Side skirts, accent stripe, mirrors, windows */}
        {[-1, 1].map(side => <group key={side}>
          <mesh position={[side * 0.97, 0.27, 0]}><boxGeometry args={[0.06, 0.1, 2.7]} /><meshStandardMaterial color="#10161c" roughness={0.6} /></mesh>
          <mesh position={[side * 0.955, 0.5, 0]}><boxGeometry args={[0.012, 0.045, 3.5]} /><meshBasicMaterial color={accent} toneMapped={false} /></mesh>
          <mesh position={[side * 0.74, 1.03, -0.24]}><boxGeometry args={[0.035, 0.42, 1.12]} /><meshStandardMaterial color="#7c9aa8" metalness={0.5} roughness={0.12} /></mesh>
          <mesh position={[side * 1.02, 0.78, 0.18]} castShadow><boxGeometry args={[0.22, 0.12, 0.28]} />{paint(body)}</mesh>
        </group>)}
        {/* Front grille, headlamps, DRL strips */}
        <mesh position={[0, 0.49, 2.09]}><boxGeometry args={[0.72, 0.2, 0.035]} /><meshStandardMaterial color="#0d141a" metalness={0.3} roughness={0.5} /></mesh>
        <mesh position={[0, 0.355, 2.1]}><boxGeometry args={[1.45, 0.07, 0.05]} /><meshStandardMaterial color="#0d141a" /></mesh>
        {[-1, 1].map(side => <group key={`l${side}`}>
          <mesh position={[side * 0.62, 0.62, 2.1]}><boxGeometry args={[0.42, 0.13, 0.045]} /><meshStandardMaterial color="#f4fbff" emissive="#dff5ff" emissiveIntensity={1.6} toneMapped={false} /></mesh>
          <mesh position={[side * 0.62, 0.52, 2.1]}><boxGeometry args={[0.4, 0.025, 0.045]} /><meshBasicMaterial color={accent} toneMapped={false} /></mesh>
          <mesh position={[side * 0.66, 0.5, -2.08]}><boxGeometry args={[0.38, 0.13, 0.04]} /><meshStandardMaterial ref={m => { tailMats.current[side > 0 ? 1 : 0] = m; }} color="#ff2738" emissive="#ff172a" emissiveIntensity={1.6} toneMapped={false} /></mesh>
          <sprite ref={s => { tailGlows.current[side > 0 ? 1 : 0] = s; }} position={[side * 0.66, 0.5, -2.2]} scale={[1, 1, 1]}>
            <spriteMaterial map={glow} color="#ff2a3a" transparent opacity={0.5} depthWrite={false} blending={THREE.AdditiveBlending} fog={false} />
          </sprite>
        </group>)}
        <mesh position={[0, 0.36, -2.07]}><boxGeometry args={[1.5, 0.08, 0.06]} /><meshStandardMaterial color="#8a949c" metalness={0.6} roughness={0.35} /></mesh>
        <mesh position={[0, 0.58, -2.085]}><boxGeometry args={[0.52, 0.14, 0.02]} /><meshStandardMaterial color="#e6e9ea" roughness={0.5} /></mesh>
        <mesh position={[0, 0.34, 2.08]}><boxGeometry args={[1.42, 0.09, 0.08]} /><meshStandardMaterial color="#aab5bd" metalness={0.7} roughness={0.3} /></mesh>
        {/* Spoiler */}
        <mesh position={[0, 1.0, -1.94]} castShadow><boxGeometry args={[1.5, 0.05, 0.4]} />{paint(bodyDark)}</mesh>
        {[-0.55, 0.55].map(x => <mesh key={x} position={[x, 0.9, -1.92]}><boxGeometry args={[0.05, 0.2, 0.1]} /><meshStandardMaterial color="#10161c" /></mesh>)}
      </group>

      {/* Wheels */}
      {[[-0.96, 1.35], [0.96, 1.35], [-0.96, -1.35], [0.96, -1.35]].map(([x, z], i) =>
        <group key={i} position={[x, 0.34, z]} ref={el => { wheelRefs.current[i] = el; if (el) el.rotation.order = 'YXZ'; }}>
          <mesh rotation={[0, 0, Math.PI / 2]} castShadow><cylinderGeometry args={[0.37, 0.37, 0.24, 24]} /><meshStandardMaterial color="#0e1318" roughness={0.96} /></mesh>
          <mesh rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.25, 0.25, 0.25, 20]} /><meshStandardMaterial color="#c4d0d8" metalness={0.9} roughness={0.2} envMap={env} envMapIntensity={1.2} /></mesh>
          {[0, 1, 2, 3, 4].map(j => <mesh key={j} rotation={[(j * Math.PI) / 5, 0, 0]} position={[x > 0 ? 0.06 : -0.06, 0, 0]}><boxGeometry args={[0.12, 0.44, 0.045]} /><meshStandardMaterial color="#5f7080" metalness={0.8} roughness={0.3} /></mesh>)}
          <mesh rotation={[0, 0, Math.PI / 2]} position={[x > 0 ? 0.08 : -0.08, 0, 0]}><cylinderGeometry args={[0.07, 0.07, 0.14, 12]} /><meshStandardMaterial color="#1b242c" metalness={0.8} roughness={0.3} /></mesh>
        </group>)}
    </group>
  </group>;
}

/* =====================================================================
 * NPC TRAFFIC
 * Spawns a small fleet of AI vehicles that drive up and down the road.
 * Each NPC has its own lane, speed, colour, and a simple state machine:
 *   DRIVING → passes off the far end → RESPAWN → re-enters from opposite end.
 * NPCs yield slightly when the player is very close (basic proximity awareness).
 * ===================================================================== */

const NPC_COLORS = ['#e53935','#1e88e5','#43a047','#fb8c00','#8e24aa','#00acc1','#f4511e','#6d4c41'];
const NPC_ACCENTS = ['#ff8a80','#82b1ff','#b9f6ca','#ffd180','#ea80fc','#84ffff','#ff9e80','#d7ccc8'];

// Shared NPC pool definition — constant across renders
const NPC_DEFS = (() => {
  const r = rng(999);
  const lanes = [-3.1, -1.0, 1.0, 3.1]; // x offsets within the road half-width
  return Array.from({ length: 10 }, (_, i) => {
    const color = NPC_COLORS[i % NPC_COLORS.length];
    const accent = NPC_ACCENTS[i % NPC_ACCENTS.length];
    const lane = lanes[i % lanes.length];
    const dir = i % 2 === 0 ? 1 : -1; // 1 = northbound (-Z), -1 = southbound (+Z)
    const baseSpeed = 45 + r() * 45; // km/h
    const startZ = (520 - r() * 1100) * (dir === 1 ? 1 : -1); // staggered initial z
    return { id: i, color, accent, lane, dir, baseSpeed, startZ };
  });
})();

function NpcCar({ def, positionRef, nightMode, showNpcs }) {
  const group = useRef();
  const stateRef = useRef({
    z: def.startZ,
    speed: def.baseSpeed,
    heading: def.dir === 1 ? 0 : Math.PI, // northbound faces -Z (heading 0), southbound faces +Z (heading PI)
    wheelAngle: 0,
  });
  const wheelRefs = useRef([]);
  const tailMatRefs = useRef([]);
  const glow = getGlowTexture();
  const bodyDark = shade(def.color, 0.82);

  useFrame((_, delta) => {
    if (!group.current) return;
    const s = stateRef.current;

    if (!showNpcs) { group.current.visible = false; return; }
    group.current.visible = true;

    const dt = Math.min(delta, 0.05);

    // Proximity slowdown — yield if player is in the same lane and close ahead
    const p = positionRef.current;
    const dx = Math.abs(p.x - def.lane);
    const dz = (p.z - s.z) * def.dir; // positive when player is ahead in NPC's direction
    const isClose = dx < 3.5 && dz > 0 && dz < 28;
    const targetSpeed = isClose ? Math.max(def.baseSpeed * 0.35, def.baseSpeed - 60) : def.baseSpeed;
    s.speed += (targetSpeed - s.speed) * (1 - Math.exp(-3 * dt));

    const mps = s.speed / 3.6;
    s.z -= def.dir * mps * dt; // northbound moves in -Z, southbound in +Z

    // Respawn off the far end
    if (def.dir === 1 && s.z < -720) s.z = 560;
    if (def.dir === -1 && s.z > 560) s.z = -720;

    // Tiny lateral weave for realism
    const t = performance.now() * 0.001;
    const weave = Math.sin(t * 0.6 + def.id * 2.3) * 0.18;

    group.current.position.set(def.lane + weave, 0.04, s.z);
    group.current.rotation.y = -s.heading + Math.sin(t * 0.4 + def.id) * 0.012;

    s.wheelAngle = (s.wheelAngle + mps * dt / 0.34) % (Math.PI * 2);
    wheelRefs.current.forEach(w => { if (w) w.rotation.x = s.wheelAngle; });

    // Tail lights — always on for southbound (facing player), dim for northbound
    const emissive = (def.dir === -1 || nightMode) ? 3.5 : 1.2;
    tailMatRefs.current.forEach(m => { if (m) m.emissiveIntensity = emissive; });
  });

  const paint = c => <meshStandardMaterial color={c} metalness={0.4} roughness={0.38} />;

  return (
    <group ref={group}>
      {/* shadow blob */}
      <mesh rotation={[FLAT, 0, 0]} position={[0, 0.02, 0]}>
        <planeGeometry args={[2.8, 5.2]} />
        <meshBasicMaterial map={glow} color="#000000" transparent opacity={0.35} depthWrite={false} {...decal(5)} />
      </mesh>
      <group rotation={[0, Math.PI, 0]}>
        {/* body */}
        <mesh position={[0, 0.47, 0]} castShadow><boxGeometry args={[1.85, 0.40, 4.0]} />{paint(def.color)}</mesh>
        <mesh position={[0, 0.66, 0.95]} castShadow><boxGeometry args={[1.78, 0.26, 1.5]} />{paint(shade(def.color, 1.10))}</mesh>
        <mesh position={[0, 0.78, -0.68]} castShadow><boxGeometry args={[1.65, 0.26, 1.12]} />{paint(bodyDark)}</mesh>
        {/* cabin */}
        <mesh position={[0, 0.99, -0.22]} castShadow><boxGeometry args={[1.42, 0.62, 1.75]} />{paint(shade(def.color, 0.93))}</mesh>
        <mesh position={[0, 1.03, -0.22]}><boxGeometry args={[1.32, 0.50, 1.68]} /><meshStandardMaterial color="#16232f" metalness={0.8} roughness={0.06} /></mesh>
        {/* accent stripe */}
        {[-1, 1].map(side => <mesh key={side} position={[side * 0.945, 0.5, 0]}><boxGeometry args={[0.012, 0.042, 3.4]} /><meshBasicMaterial color={def.accent} toneMapped={false} /></mesh>)}
        {/* headlights */}
        {[-1, 1].map(side => <mesh key={side} position={[side * 0.60, 0.62, 2.05]}><boxGeometry args={[0.40, 0.12, 0.04]} /><meshStandardMaterial color="#f4fbff" emissive="#dff5ff" emissiveIntensity={nightMode ? 3 : 1.2} toneMapped={false} /></mesh>)}
        {/* tail lights */}
        {[-1, 1].map((side, i) => <mesh key={side} position={[side * 0.64, 0.50, -2.04]}>
          <boxGeometry args={[0.36, 0.12, 0.04]} />
          <meshStandardMaterial ref={m => { tailMatRefs.current[i] = m; }} color="#ff2738" emissive="#ff172a" emissiveIntensity={1.6} toneMapped={false} />
        </mesh>)}
        {/* wheels */}
        {[[-0.94, 1.30], [0.94, 1.30], [-0.94, -1.30], [0.94, -1.30]].map(([x, z], i) => (
          <group key={i} position={[x, 0.34, z]} ref={el => { wheelRefs.current[i] = el; }}>
            <mesh rotation={[0, 0, Math.PI / 2]} castShadow><cylinderGeometry args={[0.34, 0.34, 0.22, 18]} /><meshStandardMaterial color="#0e1318" roughness={0.96} /></mesh>
            <mesh rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.22, 0.22, 0.23, 14]} /><meshStandardMaterial color="#b0bec5" metalness={0.85} roughness={0.25} /></mesh>
          </group>
        ))}
      </group>
    </group>
  );
}

function NpcFleet({ positionRef, nightMode, showNpcs }) {
  return <>
    {NPC_DEFS.map(def => (
      <NpcCar key={def.id} def={def} positionRef={positionRef} nightMode={nightMode} showNpcs={showNpcs} />
    ))}
  </>;
}

/* =====================================================================
 * WORLD + CAMERA
 * ===================================================================== */
function World({ speedRef, headingRef, positionRef, started, routeKey, cameraMode, carColor, lights, showNpcs }) {
  const route = ROUTES[routeKey] || ROUTES.express;
  const cameraPos = useRef(new THREE.Vector3(10, 3, Z_START + 10));
  const cameraTarget = useRef(new THREE.Vector3(0, 1, Z_START));
  const tmpA = useMemo(() => new THREE.Vector3(), []);
  const tmpB = useMemo(() => new THREE.Vector3(), []);
  const camHeading = useRef(0);

  useFrame((state, delta) => {
    // Camera follows a lightly smoothed heading so quick steering reversals don't whip the view
    // Use faster heading tracking for less perceived lag while still being smooth.
    camHeading.current = lerpAngle(camHeading.current, headingRef.current, 1 - Math.exp(-12 * delta));
    const p = positionRef.current, h = camHeading.current, spd = Math.abs(speedRef.current);
    // Position smooth factor: higher = less lag. Use separate values for pos and target.
    const posSmooth = 1 - Math.exp(-7 * delta);
    const tgtSmooth = 1 - Math.exp(-10 * delta);
    let fov;
    if (!started) {
      // Showroom orbit while on standby
      const a = state.clock.elapsedTime * 0.28 + 0.6;
      tmpA.set(p.x + Math.sin(a) * 9.5, 2.5 + Math.sin(a * 0.7) * 0.5, p.z + Math.cos(a) * 9.5);
      tmpB.set(p.x, 0.95, p.z);
      fov = 46;
      cameraPos.current.lerp(tmpA, 1 - Math.exp(-3.2 * delta));
      cameraTarget.current.lerp(tmpB, 1 - Math.exp(-5 * delta));
    } else {
      const mode = CAMERA_MODES[cameraMode] || CAMERA_MODES[0];
      tmpA.set(p.x - Math.sin(h) * (mode.dist + spd * 0.04), mode.height + spd * 0.01, p.z + Math.cos(h) * (mode.dist + spd * 0.04));
      tmpB.set(p.x + Math.sin(h) * 12, 0.75, p.z - Math.cos(h) * 12);
      fov = mode.fov + clamp(spd / 36, 0, 1) * 9;
      cameraPos.current.lerp(tmpA, posSmooth);
      cameraTarget.current.lerp(tmpB, tgtSmooth);
    }
    state.camera.position.copy(cameraPos.current);
    state.camera.lookAt(cameraTarget.current);
    if (Math.abs(state.camera.fov - fov) > 0.05) {
      state.camera.fov = lerp(state.camera.fov, fov, 1 - Math.exp(-3 * delta));
      state.camera.updateProjectionMatrix();
    }
  });

  return <group>
    <WindClock />
    <SkyRig route={route} />
    <Sun route={route} positionRef={positionRef} />
    <Road routeKey={routeKey} route={route} />
    <SkidMarks positionRef={positionRef} headingRef={headingRef} roadColor={route.road} />
    <SpeedStreaks positionRef={positionRef} headingRef={headingRef} speedRef={speedRef} />
    <Car positionRef={positionRef} headingRef={headingRef} speedRef={speedRef} carColor={carColor} accent={route.accent} night={route.night} lightsOn={lights} route={route} />
    <NpcFleet positionRef={positionRef} nightMode={route.night} showNpcs={showNpcs} />
  </group>;
}

function VehicleBridge({ vehicleRef, positionRef, headingRef, speedRef }) {
  useFrame(() => {
    const v = vehicleRef.current;
    if (!v) return;
    const p = positionRef.current;
    p.x = v.x; p.z = v.z;
    p.steerInput = v.steer || 0;
    p.braking = (v.brake || 0) > 0.08;
    p.accel = (v.throttle || 0) > 0.08;
    p.skid = !!v.skid; p.surface = v.surface; p.skidIntensity = v.skidIntensity || 0;
    p.accelLong = v.accelLong || 0; p.accelLat = v.accelLat || 0;
    headingRef.current = v.heading || 0;
    speedRef.current = v.speed || 0;
  });
  return null;
}

function GameScene({ vehicleRef, camMode, started, routeKey, lights, qualityKey, resetKey, showNpcs }) {
  const route = ROUTES[routeKey] || ROUTES.express;
  const positionRef = useRef({ x: 0, z: Z_START, steerInput: 0, braking: false, accel: false });
  const headingRef = useRef(0), speedRef = useRef(0);
  const cameraMode = camMode === 'far' ? 1 : (camMode === 'high' ? 2 : 0);
  const quality = QUALITY[qualityKey] || QUALITY.balanced;
  return <Canvas key={`${qualityKey || 'balanced'}-${resetKey || 0}`} shadows={quality.shadows} dpr={quality.dpr} camera={{ position: [10, 3, Z_START + 10], fov: 56, near: 0.3, far: 1700 }} gl={{ antialias: quality.antialias, powerPreference: 'high-performance', alpha: false }}>
    <color attach="background" args={[route.skyHorizon]} />
    <fog attach="fog" args={[route.skyHorizon, route.fog[0], route.fog[1]]} />
    <ambientLight color={route.ambient[0]} intensity={route.ambient[1]} />
    <hemisphereLight args={[route.hemi[0], route.hemi[1], route.hemi[2]]} />
    <Suspense fallback={null}>
      <VehicleBridge vehicleRef={vehicleRef} positionRef={positionRef} headingRef={headingRef} speedRef={speedRef} />
      <World speedRef={speedRef} headingRef={headingRef} positionRef={positionRef} started={started} routeKey={routeKey} cameraMode={cameraMode} carColor="#eceff1" lights={lights} showNpcs={showNpcs} />
    </Suspense>
  </Canvas>;
}

// App telemetry/HUD state refreshes several times per second; memoization keeps those updates
// from re-rendering the expensive Three.js scene when its actual props have not changed.
export default React.memo(GameScene);
