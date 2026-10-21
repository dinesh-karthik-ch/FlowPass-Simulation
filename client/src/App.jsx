import React, { useCallback, useEffect, useRef, useState } from 'react';
import GameScene from './Scene3D.jsx';
import { Speedometer, Minimap, Spark, RouteTrack } from './hud.jsx';
import { sound } from './sound.js';
import { createVehicle, resetVehicle, recoverVehicle, stepVehicle, toG } from './physics.js';
import { buildInput, readGamepad, KEY_ACTIONS, GAME_KEYS } from './input.js';
import {
  API, VEHICLE_ID, ROUTES, FINISH_Z, clamp, formatKm, formatMoney, formatTime,
  simPosition, toLatLon, headingDegrees, cardinal, getScenery, spawnFor, DIRECTIONS
} from './constants.js';

const SEND_MS = 250;           // telemetry cadence (4 Hz) + a forced sample on every geofence crossing
const HUD_MS = 125;            // dashboard refresh (8 Hz); the 3D scene itself runs at display rate
const SERIES_LEN = 240;        // 60 s of history at 4 Hz
const CAMERAS = [['chase', 'CHASE'], ['far', 'FAR CHASE'], ['high', 'HIGH ANGLE']];
const QUALITY_OPTS = [['performance', 'LOW'], ['balanced', 'MED'], ['quality', 'HIGH']];
const DRIVE_OPTS = [['free', 'FREE', 'Pivot on the spot + sidestep with Q/E (G toggles)'], ['real', 'REALISTIC', 'The car has to move in order to turn']];
const newSession = () => `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '—');
const signed = (n, d = 1) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(d);

/* ------------------------------ small presentational helpers ------------------------------ */
const Tile = ({ label, value, unit, tone }) => <div className={`kv ${tone || ''}`}><span>{label}</span><b>{value}{unit && <small>{unit}</small>}</b></div>;
const Meter = ({ label, value, tone }) => <div className="meter"><span>{label}</span><div className="meter-bar"><i className={tone} style={{ width: `${clamp(value, 0, 100)}%` }} /></div><b>{Math.round(value)}%</b></div>;

/** Press-and-hold button using pointer events, so several can be held at once on a touch screen. */
function PadButton({ padRef, name, className = '', label, children }) {
  const set = v => e => { e.preventDefault(); padRef.current[name] = v; if (v) e.currentTarget.setPointerCapture?.(e.pointerId); };
  return <button type="button" className={`pad-btn ${className}`} aria-label={label}
    onPointerDown={set(true)} onPointerUp={set(false)} onPointerCancel={set(false)} onLostPointerCapture={set(false)} onContextMenu={e => e.preventDefault()}>{children}</button>;
}

function Segmented({ value, options, onChange, label, disabled = false }) {
  return <div className={`segmented ${disabled ? 'locked' : ''}`} role="group" aria-label={label}>
    {options.map(([k, text, title]) => <button key={k} type="button" className={value === k ? 'on' : ''} title={disabled ? 'Locked while a trip is running' : title} disabled={disabled} aria-pressed={value === k} onClick={() => onChange(k)}>{text}</button>)}
  </div>;
}

/* ================================== APP ================================== */
export default function App() {
  /* ---- simulation state lives in refs: the physics loop never waits for React ---- */
  const vehicleRef = useRef(null);
  if (!vehicleRef.current) vehicleRef.current = createVehicle();
  const keysRef = useRef({});
  const padRef = useRef({});
  const camModeRef = useRef('chase');
  const runningRef = useRef(false);
  const orbitRef = useRef({ az: 0, el: 0.32, dist: 11, chase: 9.5, top: 0 });
  const trailRef = useRef([]);
  const seriesRef = useRef({ speed: [], g: [], lane: [] });
  const logRef = useRef([]);
  const linkRef = useRef({ sent: 0, ok: 0, failed: 0, stale: 0, skipped: 0, lat: [], times: [], lastLatency: null });
  const serverRef = useRef({});
  const sessionRef = useRef(newSession());
  const sequenceRef = useRef(0);
  const queueRef = useRef(Promise.resolve());
  const pendingRef = useRef(0);
  const resettingRef = useRef(true);
  const resyncRef = useRef(false);
  const lastResyncRef = useRef(0);
  const completeRef = useRef(false);
  const failRef = useRef(0);
  const lastSimRef = useRef(0);
  const lastSendRef = useRef(0);
  const bannerTimer = useRef(null);
  const sceneRef = useRef(null);
  const fpsRef = useRef(60);

  const [routeKey, setRouteKey] = useState('express');
  const [startDir, setStartDir] = useState('FORWARD'); // which end of the road the car is placed at (two-way operation)
  const [started, setStarted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [tripComplete, setTripComplete] = useState(false);
  const [camMode, setCamModeState] = useState('chase');
  const [freeMode, setFreeMode] = useState(true);
  const [lights, setLights] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [quality, setQuality] = useState('balanced');
  const [tab, setTab] = useState('trip');
  const [showPad, setShowPad] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches);
  const [showNpcs, setShowNpcs] = useState(true);
  const [apiStatus, setApiStatus] = useState('connecting');
  const [rate, setRate] = useState(2.5);
  const [resetKey, setResetKey] = useState(0);
  const [banner, setBanner] = useState(null);
  const [telemetry, setTelemetry] = useState({ geofence: 'OUTSIDE', journey: 'INACTIVE', distanceMeters: 0, toll: 0, event: 'READY' });
  const [events, setEvents] = useState([{ id: 'init', time: new Date().toLocaleTimeString(), type: 'SYSTEM', message: 'Simulator initialised. Ready to start.' }]);
  const [live, setLive] = useState(() => snapshot(createVehicle(), performance.now(), seriesRef.current, linkRef.current, 60, false));

  // The physics loop reads the latest React state through these refs (assigned on every render).
  const runRef = useRef({});
  runRef.current = { started, paused, complete: tripComplete, routeKey, free: freeMode, startDir };
  runningRef.current = started;
  const actionsRef = useRef({});

  /* ---------------------------------- events + banner ---------------------------------- */
  const addEvent = useCallback((type, message) => {
    setEvents(prev => [{ id: `${Date.now()}-${Math.random()}`, time: new Date().toLocaleTimeString(), type, message }, ...prev].slice(0, 40));
  }, []);
  const showBanner = useCallback((type, text) => {
    clearTimeout(bannerTimer.current);
    setBanner({ type, text, id: Math.random() });
    bannerTimer.current = setTimeout(() => setBanner(null), 2800);
  }, []);

  /* ---------------------------------- backend link ---------------------------------- */
  const registerSession = useCallback(async (routeForSession) => {
    const r = await fetch(`${API}/api/reset`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vehicleId: VEHICLE_ID, sessionId: sessionRef.current, routeKey: routeForSession })
    });
    if (!r.ok) throw new Error('reset');
  }, []);

  const checkBackend = useCallback(async (quiet = false) => {
    resettingRef.current = true;
    try {
      const h = await fetch(`${API}/api/health`);
      if (!h.ok) throw new Error('health');
      const info = await h.json();
      if (Number.isFinite(info.tollRatePerKm)) setRate(info.tollRatePerKm);
      await registerSession(runRef.current.routeKey);
      setApiStatus('online'); failRef.current = 0;
      if (!quiet) addEvent('SYSTEM', 'Backend connected. API healthy.');
      return true;
    } catch {
      setApiStatus('offline');
      if (!quiet) addEvent('ERROR', `Cannot reach backend at ${API}. Start the server.`);
      return false;
    } finally { resettingRef.current = false; }
  }, [addEvent, registerSession]);

  useEffect(() => { checkBackend(); }, [checkBackend]);
  // Until the trip starts, quietly keep retrying so the Start button unlocks as soon as the API is up.
  useEffect(() => {
    if (apiStatus !== 'offline' || started) return;
    const id = setInterval(() => checkBackend(true), 3000);
    return () => clearInterval(id);
  }, [apiStatus, started, checkBackend]);

  // The backend keeps journeys in memory. If it restarted mid-trip it answers 409 "needsReset": re-register the session.
  const resync = useCallback(async () => {
    // Requests that were already in flight also answer 409; one re-registration is enough, so ignore the rest for a few seconds.
    if (resyncRef.current || performance.now() - lastResyncRef.current < 4000) return;
    resyncRef.current = true; lastResyncRef.current = performance.now();
    try {
      await registerSession(runRef.current.routeKey);
      addEvent('SYNC', 'Backend lost this trip (restart?). Session re-registered; toll counting restarts from here.');
      setApiStatus('online');
    } catch { setApiStatus('offline'); }
    finally { resyncRef.current = false; }
  }, [addEvent, registerSession]);

  const sendTelemetry = useCallback((force = false) => {
    if (resettingRef.current) return;
    const link = linkRef.current;
    if (pendingRef.current > 0 && !force) { link.skipped++; return; } // never let a slow API build up a backlog
    const v = vehicleRef.current;
    const sessionId = sessionRef.current, sequence = sequenceRef.current++;
    const { lat, lon } = toLatLon(v.x, v.z);
    const payload = {
      vehicleId: VEHICLE_ID, sessionId, sequence, latitude: lat, longitude: lon, routeKey: runRef.current.routeKey,
      speed: Math.round(v.kmh * 10) / 10, simPosition: simPosition(v.z),
      heading: Math.round(headingDegrees(v.heading) * 10) / 10, lateralOffset: Math.round(v.x * 100) / 100, acceleration: Math.round(v.accelLong * 100) / 100
    };
    pendingRef.current++;
    const task = async () => {
      if (resettingRef.current || sessionId !== sessionRef.current || completeRef.current) { pendingRef.current--; return; }
      const t0 = performance.now(); link.sent++;
      try {
        const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 4000);
        const res = await fetch(`${API}/api/telemetry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctl.signal });
        clearTimeout(timer);
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          if (err.stale) { link.stale++; return; }
          if (err.needsReset) { link.failed++; resync(); return; }
          throw new Error(`API ${res.status}`);
        }
        const data = await res.json();
        if (resettingRef.current || sessionId !== sessionRef.current) return;
        const latency = performance.now() - t0;
        link.ok++; link.lastLatency = latency; link.lat.push(latency); if (link.lat.length > 20) link.lat.shift();
        link.times.push(performance.now());
        failRef.current = 0; setApiStatus('online');
        serverRef.current = data;
        setTelemetry(prev => ({ ...prev, ...data, latitude: lat, longitude: lon, lastUpdate: Date.now() }));
        if (data.event && data.event !== 'NONE') {
          const returnedToEntry = data.event === 'RETURN_TO_ENTRY';
          const normalExit = data.event === 'EXIT';
          addEvent(data.event, data.event === 'ENTRY'
            ? `Entry gate ${data.entryGate || 'A'} crossed ${DIRECTIONS[data.direction] || ''}. Toll counting started.`
            : returnedToEntry
              ? `Vehicle returned through Entry Gate ${data.exitGate || 'A'}. Trip ended as a return, not a normal exit.`
              : `Exit gate ${data.exitGate || '—'} crossed ${DIRECTIONS[data.direction] || ''}. Final toll ₹${Number(data.toll).toFixed(2)}.`);
          sound.chime(returnedToEntry ? 'return' : normalExit ? 'exit' : 'entry');
          if (!returnedToEntry) {
            showBanner(data.event, data.event === 'ENTRY'
              ? `ENTRY GATE ${data.entryGate || 'A'} · ${DIRECTIONS[data.direction] || ''} · TOLLING STARTED`
              : `EXIT GATE ${data.exitGate || '—'} · TOLL ₹${Number(data.toll).toFixed(2)}`);
          }
          if (normalExit) {
            // Only a real exit gate completes and stops the trip. Returning through A is not a toll exit.
            completeRef.current = true;
            const vehicle = vehicleRef.current;
            vehicle.vx = 0; vehicle.vz = 0; vehicle.speed = 0; vehicle.kmh = 0;
            setStarted(false); setTripComplete(true);
            addEvent('COMPLETE', `Journey completed at Exit Gate ${data.exitGate || '—'}. Final toll: ₹${Number(data.toll).toFixed(2)}. Choose Drive Again or Continue in Reverse.`);
          } else if (returnedToEntry) {
            // No popup, no toll, and no forced restart: the driver remains in control.
            addEvent('RETURN', `Returned through Entry Gate ${data.exitGate || 'A'}. Not an exit. Toll reading kept at ₹${Number(data.toll || 0).toFixed(2)}; distance: ${(Number(data.distanceMeters || 0) / 1000).toFixed(2)} km. Continue driving; crossing an entry gate again starts a fresh journey.`);
          }
        }
      } catch {
        link.failed++;
        if (!resettingRef.current && sessionId === sessionRef.current && ++failRef.current > 3) setApiStatus('offline');
      } finally { pendingRef.current = Math.max(0, pendingRef.current - 1); }
    };
    queueRef.current = queueRef.current.then(task, task);
  }, [addEvent, showBanner, resync]);

  /* ---------------------------------- actions ---------------------------------- */
  const setCamMode = useCallback(mode => {
    camModeRef.current = mode; setCamModeState(mode);
    if (mode === 'orbit') orbitRef.current.az = -vehicleRef.current.heading; // start the orbit camera behind the car
  }, []);
  const cycleCamera = () => { const i = CAMERAS.findIndex(c => c[0] === camModeRef.current); setCamMode(CAMERAS[(i + 1) % CAMERAS.length][0]); };

  const togglePause = () => {
    if (!started || tripComplete) return;
    const next = !paused;
    keysRef.current = {}; padRef.current = {};
    setPaused(next);
    addEvent('SYSTEM', next ? 'Simulation paused.' : 'Simulation resumed.');
  };

  const startTrip = () => {
    if (started) return;
    if (apiStatus === 'offline') { addEvent('ERROR', 'Cannot start: backend is offline.'); checkBackend(true); return; }
    sound.unlock();
    setPaused(false); setStarted(true); setTripComplete(false); completeRef.current = false;
    lastSendRef.current = performance.now();
    sendTelemetry(true); // publish the initial sample immediately so the live telemetry panel wakes up at trip start
    addEvent('START', `Trip started on ${ROUTES[routeKey].name} (${DIRECTIONS[startDir]}). Cross an entry gate (A heading north, D heading south) to start tolling, then steer onto any exit ramp; the backend detects the path you actually take.`);
  };

  const resetTrip = (nextRoute = routeKey, nextDir = runRef.current.startDir || 'FORWARD') => {
    resettingRef.current = true;
    sessionRef.current = newSession(); sequenceRef.current = 0; failRef.current = 0; pendingRef.current = 0; completeRef.current = false;
    keysRef.current = {}; padRef.current = {};
    const pose = spawnFor(nextRoute, nextDir);
    resetVehicle(vehicleRef.current, pose);
    orbitRef.current.az = -pose.heading;
    trailRef.current = []; seriesRef.current = { speed: [], g: [], lane: [] }; logRef.current = [];
    linkRef.current = { sent: 0, ok: 0, failed: 0, stale: 0, skipped: 0, lat: [], times: [], lastLatency: null };
    serverRef.current = {};
    lastSimRef.current = simPosition(pose.z); lastSendRef.current = performance.now();
    setPaused(false); setStarted(false); setTripComplete(false); setBanner(null); setResetKey(k => k + 1);
    setLights(!!ROUTES[nextRoute].night);
    setTelemetry({ geofence: 'OUTSIDE', journey: 'INACTIVE', distanceMeters: 0, toll: 0, event: 'RESET' });
    setEvents([{ id: `reset-${Date.now()}`, time: new Date().toLocaleTimeString(), type: 'RESET', message: `Trip cleared. Vehicle placed at the ${nextDir === 'REVERSE' ? 'north end (heading south)' : 'start line (heading north)'}.` }]);
    const task = async () => {
      try { await registerSession(nextRoute); setApiStatus('online'); }
      catch { setApiStatus('offline'); addEvent('ERROR', 'Could not reach backend reset endpoint.'); }
      finally { resettingRef.current = false; }
    };
    queueRef.current = queueRef.current.then(task, task);
  };

  // Switch to the opposite starting direction (works from the start screen, mid-reset, or after a completed trip).
  const continueInReverse = () => {
    // Use the direction we actually drove if a trip completed; otherwise flip the current start direction.
    const currentDir = tripComplete
      ? (telemetry.direction || runRef.current.startDir || startDir)
      : (runRef.current.startDir || startDir);
    const nextDir = currentDir === 'REVERSE' ? 'FORWARD' : 'REVERSE';
    setStartDir(nextDir);
    runRef.current.startDir = nextDir;
    resetTrip(routeKey, nextDir);
    addEvent('SYSTEM', `Direction set to ${DIRECTIONS[nextDir]}. Vehicle placed at the ${nextDir === 'REVERSE' ? 'north end (Gate D)' : 'south end (Gate A)'}. Start driving when ready.`);
  };

  const recover = () => {
    if (!started || tripComplete) return;
    recoverVehicle(vehicleRef.current);
    addEvent('RECOVER', 'Vehicle placed back on the carriageway at the same route position.');
  };

  const exportCsv = () => {
    const rows = logRef.current;
    if (!rows.length) { addEvent('SYSTEM', 'Nothing to export yet — drive a little first.'); return; }
    const cols = Object.keys(rows[0]);
    const csv = [cols.join(','), ...rows.map(r => cols.map(c => r[c]).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `flowpass-telemetry-${routeKey}-${Date.now()}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    addEvent('SYSTEM', `Exported ${rows.length} telemetry samples to CSV.`);
  };

  actionsRef.current = {
    run(name) {
      switch (name) {
        case 'reset': return resetTrip();
        case 'pause': return togglePause();
        case 'start': return started ? (paused && togglePause()) : startTrip();
        case 'camera': return cycleCamera();
        case 'lights': return setLights(l => !l);
        case 'driveMode': return setFreeMode(m => !m);
        case 'recover': return recover();
        case 'help': return setTab('controls');
        case 'telemetry': return setTab('telemetry');
        default:
      }
    },
    send: sendTelemetry,
    complete() {
      if (completeRef.current) return;
      completeRef.current = true;
      setTripComplete(true); sendTelemetry(true);
      addEvent('COMPLETE', 'Route complete. Review the trip summary.');
    },
    impact(kmh) { addEvent('IMPACT', `Collision at ${kmh} km/h.`); },
    edge() { addEvent('EDGE', 'You reached the edge of the simulation world. Turn around.'); }
  };

  /* ---------------------------------- keyboard ---------------------------------- */
  useEffect(() => {
    const typing = t => t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable);
    const down = e => {
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (GAME_KEYS.has(e.code)) { e.preventDefault(); keysRef.current[e.code] = true; return; }
      const action = KEY_ACTIONS[e.code];
      if (action && !e.repeat) { if (e.code === 'Enter' && e.target?.tagName === 'BUTTON') return; actionsRef.current.run(action); }
    };
    const up = e => { if (GAME_KEYS.has(e.code)) { e.preventDefault(); keysRef.current[e.code] = false; } };
    const clearAll = () => { keysRef.current = {}; padRef.current = {}; };
    // so that Space (handbrake) never "clicks" a button that still has focus
    const blurButtons = e => { const b = e.target.closest?.('button'); if (b && !b.closest('.pad')) b.blur(); };
    const hidden = () => { if (document.hidden) { clearAll(); const r = runRef.current; if (r.started && !r.paused && !r.complete) actionsRef.current.run('pause'); } };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', clearAll);
    window.addEventListener('click', blurButtons); document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', clearAll);
      window.removeEventListener('click', blurButtons); document.removeEventListener('visibilitychange', hidden);
    };
  }, []);

  /* ---------------------------------- camera: drag to orbit, wheel to zoom ---------------------------------- */
  useEffect(() => {
    const el = sceneRef.current; if (!el) return;
    const wheel = e => {
      e.preventDefault();
      const o = orbitRef.current, m = camModeRef.current, d = Math.sign(e.deltaY);
      if (m === 'chase') o.chase = clamp(o.chase + d * 0.8, 5, 20);
      else if (m === 'orbit') o.dist = clamp(o.dist + d * 1.2, 5, 40);
      else if (m === 'top') o.top = clamp(o.top + d * 4, -12, 70);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  const drag = useRef(null);
  const onScenePointerDown = e => {
    if (camModeRef.current !== 'orbit' || e.button !== 0 || e.target.closest('button,select,.welcome-card')) return;
    drag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onScenePointerMove = e => {
    if (!drag.current) return;
    const o = orbitRef.current;
    o.az -= (e.clientX - drag.current.x) * 0.006; o.el = clamp(o.el + (e.clientY - drag.current.y) * 0.005, 0.05, 1.45);
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const onScenePointerUp = () => { drag.current = null; };

  /* ---------------------------------- main loop: input → physics → telemetry → HUD ---------------------------------- */
  const gpRef = useRef({ connected: false });
  useEffect(() => {
    let raf, prev = performance.now(), hudAcc = 0, serAcc = 0, trailAcc = 0;
    const tick = now => {
      raf = requestAnimationFrame(tick);
      const raw = (now - prev) / 1000; prev = now;
      fpsRef.current += ((1 / Math.max(raw, 0.001)) - fpsRef.current) * 0.12; // faster FPS tracking
      const dt = Math.min(0.033, raw); // cap at 33ms (30fps min) for smoother physics
      const run = runRef.current, v = vehicleRef.current;

      const gp = readGamepad(gpRef.current); gpRef.current = gp;
      gp.edges.forEach(name => actionsRef.current.run(name));

      const driving = run.started && !run.paused && !run.complete && !completeRef.current;
      if (driving) {
        const input = buildInput(keysRef.current, padRef.current, gp);
        const obstacles = getScenery(run.routeKey).obstacles;
        for (let left = dt; left > 1e-5;) { // sub-step for stability at low frame rates
          const h = Math.min(left, 1 / 120); left -= h; // finer steps for smoother motion
          for (const ev of stepVehicle(v, input, h, { free: run.free, obstacles, routeKey: run.routeKey })) {
            if (ev.type === 'IMPACT') { sound.impact(ev.kmh); actionsRef.current.impact(ev.kmh); } else if (ev.type === 'EDGE') actionsRef.current.edge();
          }
        }
        // geofence crossing → immediate sample; otherwise regular cadence
        const route = ROUTES[run.routeKey], sim = simPosition(v.z), previousSim = lastSimRef.current;
        // Check all physical gate lines in both direction lists so southbound crossings also fire
        // an immediate telemetry sample (not just relying on the 250 ms cadence).
        const allGatePositions = [...new Set([
          ...(route.gates || []).map(g => g.position),
          ...(route.reverseGates || []).map(g => g.position)
        ])];
        const crossedGate = allGatePositions.some(pos =>
          (previousSim < pos && sim >= pos) ||
          (previousSim > pos && sim <= pos));
        lastSimRef.current = sim;
        if (crossedGate) { lastSendRef.current = now; actionsRef.current.send(true); }
        else if (now - lastSendRef.current >= SEND_MS) { lastSendRef.current = now; actionsRef.current.send(false); }
        if (v.z <= FINISH_Z && v.vz <= 0) { v.vx = v.vz = 0; v.speed = v.kmh = 0; actionsRef.current.complete(); }

        trailAcc += dt; serAcc += dt;
        if (trailAcc > 0.2) { trailAcc = 0; const t = trailRef.current; t.push([v.x, v.z]); if (t.length > 300) t.shift(); }
        if (serAcc >= SEND_MS / 1000) {
          serAcc = 0;
          const s = seriesRef.current;
          s.speed.push(v.kmh); s.g.push(toG(v.accelLong)); s.lane.push(v.x);
          for (const k of Object.keys(s)) if (s[k].length > SERIES_LEN) s[k].shift();
          const sv = serverRef.current, ll = toLatLon(v.x, v.z), log = logRef.current;
          log.push({
            t_s: +v.tripTime.toFixed(2), seq: sv.lastSequence ?? '', speed_kmh: +v.kmh.toFixed(1), signed_speed_ms: +v.speed.toFixed(2),
            x_m: +v.x.toFixed(2), z_m: +v.z.toFixed(2), route_pos_m: +simPosition(v.z).toFixed(1), heading_deg: +headingDegrees(v.heading).toFixed(1),
            lat: +ll.lat.toFixed(6), lon: +ll.lon.toFixed(6),
            accel_long_ms2: +v.accelLong.toFixed(2), accel_lat_ms2: +v.accelLat.toFixed(2), yaw_deg_s: +(v.yawRate * 180 / Math.PI).toFixed(1), slip_deg: +v.slip.toFixed(1),
            throttle_pct: Math.round(v.throttle * 100), brake_pct: Math.round(v.brake * 100), surface: v.surface,
            geofence: sv.geofence ?? '', journey: sv.journey ?? '', direction: sv.direction ?? '', eligible_distance_m: sv.distanceMeters ?? '', toll_inr: sv.toll ?? ''
          });
          if (log.length > 6000) log.shift();
        }
      }

      sound.update(v, driving);
      hudAcc += raw * 1000;
      if (hudAcc >= HUD_MS) { hudAcc = 0; setLive(snapshot(v, now, seriesRef.current, linkRef.current, fpsRef.current, gp.connected)); }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  /* ---------------------------------- derived view data ---------------------------------- */
  const route = ROUTES[routeKey];
  const active = telemetry.journey === 'ACTIVE';
  const inZone = telemetry.geofence === 'INSIDE';
  const reversing = live.speed < -0.3;
  const gear = reversing ? 'R' : live.kmh < 1 ? 'N' : 'D';
  const link = live.link;
  const fresh = started && telemetry.lastUpdate ? live.wall - telemetry.lastUpdate < 2500 : null;
  const stats = telemetry.stats || {};
  const offline = apiStatus === 'offline';

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark">F</div><div><div className="brand-name">FLOW<span>PASS</span></div><div className="brand-sub">INTELLIGENT DISTANCE TOLLING</div></div></div>
      <div className="top-meta">
        {live.gamepad && <span className="chip">🎮 GAMEPAD</span>}
        <span className="chip" title="Rendering frame rate">{Math.round(live.fps)} FPS</span>
        <button type="button" className={`api-pill ${apiStatus}`} onClick={() => checkBackend()} title="Click to re-check the API"><i />{apiStatus === 'online' ? 'API CONNECTED' : offline ? 'API OFFLINE · RETRYING' : 'CONNECTING API'}</button>
        <span className="demo-tag">3D SIMULATION</span>
      </div>
    </header>

    <main className="layout">
      <section className="game-column">
        <div className="scene-wrap" ref={sceneRef} onPointerDown={onScenePointerDown} onPointerMove={onScenePointerMove} onPointerUp={onScenePointerUp} onPointerCancel={onScenePointerUp}
          style={{ cursor: camMode === 'orbit' ? 'grab' : 'default' }}>
          <GameScene vehicleRef={vehicleRef} camMode={camMode} started={started}
            routeKey={routeKey} lights={lights} qualityKey={quality} resetKey={resetKey} showNpcs={showNpcs} />
          <div className="scene-vignette" />

          <div className="hud-top">
            <div className="route-card"><span className="route-pill">{route.name} · {DIRECTIONS[active ? telemetry.direction : startDir] || DIRECTIONS[startDir]}</span></div>
            <div className="hud-top-right">
              <div className={`zone-status ${inZone ? 'inside' : ''}`}><span className="status-dot" />{inZone ? 'IN CHARGING ZONE' : active ? 'IN CORRIDOR' : telemetry.journey === 'COMPLETED' ? 'TRIP CHARGED' : telemetry.journey === 'RETURNED_TO_ENTRY' ? 'RETURNED TO ENTRY' : 'APPROACHING CORRIDOR'}</div>
              <div className="toll-chip">
                <div><span>ELIGIBLE</span><b>{formatKm(telemetry.distanceMeters || 0)}<small>km</small></b></div>
                <div><span>{telemetry.journey === 'COMPLETED' ? 'FINAL TOLL' : 'TOLL'}</span><b className="mint">{formatMoney(telemetry.toll)}</b></div>
              </div>
            </div>
          </div>

          {banner && <div key={banner.id} className={`event-banner ${banner.type.toLowerCase()}`}>{banner.text}</div>}

          <div className="hud-flags">
            {live.surface !== 'ROAD' && <span className={`flag ${live.surface === 'OFFROAD' ? 'warn' : ''}`}>{live.surface === 'OFFROAD' ? 'OFF-ROAD' : 'SHOULDER'}</span>}
            {live.skid && <span className="flag warn">DRIFT {Math.abs(Math.round(live.slip))}°</span>}
            {live.boosting && <span className="flag boost">BOOST</span>}
            {reversing && <span className="flag">REVERSE</span>}
            {!freeMode && <span className="flag dim">REALISTIC STEERING</span>}
          </div>

          <div className="hud-bottom">
            <Speedometer kmh={live.kmh} gear={gear} boosting={live.boosting} />
            <div className="hud-center">
              <RouteTrack routeKey={routeKey} simPos={live.simPos} inside={inZone} />
            </div>
            <div className="hud-right"><Minimap vehicleRef={vehicleRef} routeKey={routeKey} trailRef={trailRef} /></div>
          </div>

          {!started && !tripComplete && <div className="welcome-card">
            <div className="welcome-icon">↗</div>
            <div className="welcome-title">Ready for your drive?</div>
            <p>Drive freely and steer onto any exit ramp. FlowPass detects the path you actually take; no exit selection is required.</p>
            <div className="controls-hint">
              <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or arrows · drive</div>
              <div><kbd>Q</kbd><kbd>E</kbd> sidestep · <kbd>Space</kbd> handbrake · <kbd>Shift</kbd> boost</div>
              <div><kbd>C</kbd> camera · <kbd>F</kbd> recover · <kbd>P</kbd> pause · <kbd>R</kbd> reset</div>
            </div>
            <div className="result-actions">
              <button type="button" className="primary-btn" onClick={startTrip} disabled={offline}>{offline ? 'Waiting for API…' : 'Start driving'} <span>→</span></button>
              <button type="button" className="secondary-btn" onClick={() => { continueInReverse(); }} title="Switch to the opposite starting direction">Switch direction <span>⇄</span></button>
            </div>
            <small className="hint-enter">or press <kbd>Enter</kbd> · Direction: <b>{DIRECTIONS[startDir]}</b></small>
          </div>}

          {tripComplete && <div className="welcome-card result-card">
            <div className="welcome-icon">✓</div>
            <div className="welcome-title">Route complete</div>
            <div className="result-total">{formatMoney(telemetry.toll)}</div>
            <div className="result-grid">
              <div><span>Eligible distance</span><b>{formatKm(telemetry.distanceMeters || 0)} km</b></div>
              <div><span>Rate</span><b>₹{rate.toFixed(2)}/km</b></div>
              <div><span>Trip time</span><b>{formatTime(live.tripTime)}</b></div>
              <div><span>Distance driven</span><b>{formatKm(live.odometer)} km</b></div>
              <div><span>Top speed</span><b>{Math.round(live.maxKmh)} km/h</b></div>
              <div><span>Impacts</span><b>{live.impacts}</b></div>
            </div>
            <div className="result-actions">
              <button type="button" className="primary-btn" onClick={() => resetTrip(routeKey, telemetry.direction || startDir)}>Drive again <span>↻</span></button>
              <button type="button" className="secondary-btn" onClick={continueInReverse}>Continue opposite <span>⇄</span></button>
            </div>
            <small className="hint-enter">Drive again repeats the same direction · Continue opposite starts from the other end.</small>
          </div>}

          {paused && <div className="welcome-card"><div className="welcome-icon">⏸</div><div className="welcome-title">Paused</div><p>The simulation is frozen — your speed and position are kept.</p><div className="result-actions"><button type="button" className="primary-btn" onClick={togglePause}>Continue <span>▶</span></button><button type="button" className="secondary-btn" onClick={() => resetTrip()}>Drive again <span>↻</span></button></div></div>}
          {!started && !tripComplete && <div className="scene-paused">SIMULATION STANDBY</div>}
        </div>

        {/* ---------- control dock ---------- */}
        <div className="dock">
          <div className="dock-row">
            <div className="dock-selects"><label className="field">ENVIRONMENT
              <select value={routeKey} disabled={started} onChange={e => { const next = e.target.value; setRouteKey(next); runRef.current.routeKey = next; resetTrip(next); e.target.blur(); }}>
                {Object.entries(ROUTES).map(([k, r]) => <option key={k} value={k}>{r.name}</option>)}
              </select>
            </label>

            <div className="field">CAMERA <Segmented label="Camera" value={camMode} options={CAMERAS} onChange={setCamMode} /></div>
            <div className="field">STEERING <Segmented label="Steering model" value={freeMode ? 'free' : 'real'} options={DRIVE_OPTS} onChange={k => setFreeMode(k === 'free')} /></div>
            <div className="field">GRAPHICS <Segmented label="Graphics quality" value={quality} options={QUALITY_OPTS} onChange={setQuality} /></div></div>
            <div className="dock-actions">
              <button type="button" className={`tool ${lights ? 'on' : ''}`} onClick={() => setLights(l => !l)} title="Headlights (L)">💡 Lights</button>
              <button type="button" className={`tool ${soundOn ? 'on' : ''}`} onClick={() => { const n = !soundOn; setSoundOn(n); sound.setEnabled(n); }} title="Sound effects">{soundOn ? '🔊 Sound' : '🔇 Sound'}</button>
              <button type="button" className={`tool ${showPad ? 'on' : ''}`} onClick={() => setShowPad(s => !s)} title="On-screen controls">🕹 Touch pad</button>
              <button type="button" className={`tool ${showNpcs ? 'on' : ''}`} onClick={() => setShowNpcs(n => !n)} title="Toggle NPC traffic vehicles">🚗 Traffic</button>
              <button type="button" className="tool" onClick={recover} disabled={!started || tripComplete} title="Back onto the road (F)">⤒ Recover</button>
              {started && !tripComplete && <button type="button" className="tool" onClick={togglePause} title="Pause (P)">{paused ? '▶ Resume' : '⏸ Pause'}</button>}
              <button type="button" className="tool danger" onClick={() => resetTrip()} title="Reset trip (R)">↻ Reset</button>
            </div>
          </div>
          {showPad && <div className="pad" onContextMenu={e => e.preventDefault()}>
            <div className="pad-group"><PadButton padRef={padRef} name="left" label="Steer left">◀</PadButton><PadButton padRef={padRef} name="right" label="Steer right">▶</PadButton></div>
            <div className="pad-group small">
              <PadButton padRef={padRef} name="strafeL" label="Sidestep left" className="ghost">⇠<small>SIDE</small></PadButton>
              <PadButton padRef={padRef} name="handbrake" label="Handbrake" className="warn">✋<small>HAND</small></PadButton>
              <PadButton padRef={padRef} name="boost" label="Boost" className="boost">⚡<small>BOOST</small></PadButton>
              <PadButton padRef={padRef} name="strafeR" label="Sidestep right" className="ghost">⇢<small>SIDE</small></PadButton>
            </div>
            <div className="pad-group"><PadButton padRef={padRef} name="brake" label="Brake or reverse" className="brake">▼<small>BRAKE / REV</small></PadButton><PadButton padRef={padRef} name="throttle" label="Accelerate" className="gas">▲<small>GAS</small></PadButton></div>
          </div>}
        </div>
        <div className="disclaimer"><span>ⓘ</span> Educational prototype · GPS is simulated · Fictional route · Not for real toll collection</div>
      </section>

      {/* ---------------------------------- sidebar ---------------------------------- */}
      <aside className="dashboard">
        <div className="section-head">
          <div><div className="eyebrow">FLOWPASS CONTROL CENTRE</div><h2>Journey analytics</h2><div className="dashboard-subtitle">Vehicle {VEHICLE_ID} · {route.name}</div></div>
          <span className={`live-badge ${apiStatus}`}>{apiStatus === 'online' ? 'LIVE' : 'OFFLINE'}</span>
        </div>
        <div className="tabs" role="tablist">
          {[['trip', 'TRIP'], ['telemetry', 'TELEMETRY'], ['controls', 'CONTROLS']].map(([k, t]) => <button key={k} role="tab" type="button" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t}</button>)}
        </div>

        {tab === 'trip' && <div className="tab-body">
          <div className="metric-grid">
            <div className="metric-card"><span className="metric-icon mint">↗</span><span className="metric-label">ELIGIBLE DISTANCE</span><div className="metric-value">{formatKm(telemetry.distanceMeters || 0)}<small>km</small></div><div className="metric-note">Counted inside the corridor only</div></div>
            <div className="metric-card"><span className="metric-icon blue">₹</span><span className="metric-label">{telemetry.journey === 'COMPLETED' ? 'FINAL TOLL' : 'ESTIMATED TOLL'}</span><div className="metric-value">{formatMoney(telemetry.toll)}</div><div className="metric-note">₹{rate.toFixed(2)}/km · calculated by the API</div></div>
          </div>
          <div className="state-card">
            <div className="state-row"><span>JOURNEY STATUS</span><strong className={active ? 'text-mint' : telemetry.journey === 'COMPLETED' ? 'text-blue' : ''}>{telemetry.journey || 'INACTIVE'}</strong></div>
            <div className="state-row"><span>GEOFENCE</span><strong className={inZone ? 'text-mint' : ''}>{telemetry.geofence || 'OUTSIDE'}</strong></div>
            <div className="state-row"><span>LAST EVENT</span><strong>{telemetry.event || 'NONE'}</strong></div>
            <div className="state-row"><span>DIRECTION</span><strong>{DIRECTIONS[telemetry.direction] || '—'}</strong></div>
            <div className="state-row"><span>ENTRY GATE</span><strong>{telemetry.entryGate ? `GATE ${telemetry.entryGate}` : '—'}</strong></div>
            <div className="state-row"><span>EXIT GATE</span><strong>{telemetry.exitGate ? `GATE ${telemetry.exitGate}` : '—'}</strong></div>
            <div className="state-row"><span>ENTRIES / EXITS</span><strong>{telemetry.entryCount ?? 0} / {telemetry.exitCount ?? 0}</strong></div>
          </div>
          <div className="events-card">
            <div className="card-heading">EVENT TIMELINE <span>{events.length} EVENTS</span></div>
            <div className="event-list">{events.slice(0, 14).map(ev => <div className="event-row" key={ev.id}><div className={`event-marker ${ev.type.toLowerCase()}`} /><div className="event-content"><strong>{ev.type}</strong><p>{ev.message}</p><small>{ev.time}</small></div></div>)}</div>
          </div>
        </div>}

        {tab === 'telemetry' && <div className="tab-body">
          <div className="coords-card">
            <div className="card-heading">VEHICLE DYNAMICS <span>LIVE · 8 Hz</span></div>
            <div className="kv-list">
              <Tile label="SPEED" value={Math.round(live.kmh)} unit="km/h" tone="mint" />
              <Tile label="ACCEL" value={signed(live.accelLong)} unit="m/s²" />
              <Tile label="LAT G" value={signed(toG(live.accelLat), 2)} unit="g" />
              <Tile label="YAW RATE" value={signed(live.yawDeg, 0)} unit="°/s" />
              <Tile label="SLIP ANGLE" value={f(Math.abs(live.slip), 0)} unit="°" tone={live.skid ? 'warn' : ''} />
              <Tile label="STEERING" value={signed(live.steer * 100, 0)} unit="%" />
            </div>
            <Meter label="THROTTLE" value={live.throttle * 100} tone="mint" />
            <Meter label="BRAKE" value={live.brake * 100} tone="red" />
          </div>
          <div className="coords-card">
            <div className="card-heading">POSITION &amp; TRIP <span>WGS84 · SIMULATED</span></div>
            <div className="latlon"><div><span>LATITUDE</span><b>{f(live.lat, 6)}°</b></div><div><span>LONGITUDE</span><b>{f(live.lon, 6)}°</b></div></div>
            <div className="kv-list">
              <Tile label="ROUTE POSITION" value={Math.round(live.simPos)} unit="m" />
              <Tile label="LANE OFFSET" value={f(Math.abs(live.x), 1)} unit={live.x < -0.05 ? 'm L' : live.x > 0.05 ? 'm R' : 'm'} />
              <Tile label="SURFACE" value={live.surface} tone={live.surface === 'OFFROAD' ? 'warn' : ''} />
              <Tile label="HEADING" value={`${String(Math.round(live.heading) % 360).padStart(3, '0')}°`} unit={cardinal(live.heading)} />
              <Tile label="ODOMETER" value={f(live.odometer / 1000, 2)} unit="km" />
              <Tile label="TRIP TIME" value={formatTime(live.tripTime)} />
              <Tile label="AVG SPEED" value={Math.round(live.avgKmh)} unit="km/h" />
              <Tile label="TOP SPEED" value={Math.round(live.maxKmh)} unit="km/h" />
              <Tile label="IMPACTS" value={live.impacts} tone={live.impacts ? 'warn' : ''} />
            </div>
          </div>
          <div className="coords-card">
            <div className="card-heading">LIVE CHARTS <span>LAST 60 s</span></div>
            <div className="chart"><div className="chart-head"><span>SPEED</span><b>{Math.round(live.kmh)} km/h</b></div><Spark data={live.series.speed} min={0} max={170} color="#4be5c5" /></div>
            <div className="chart"><div className="chart-head"><span>LONGITUDINAL G</span><b>{signed(toG(live.accelLong), 2)} g</b></div><Spark data={live.series.g} min={-1.2} max={1.2} color="#65b8ff" zeroLine /></div>
            <div className="chart"><div className="chart-head"><span>LANE OFFSET</span><b>{signed(live.x, 1)} m</b></div><Spark data={live.series.lane} min={-12} max={12} color="#f2bb76" zeroLine /></div>
          </div>
          <div className="coords-card">
            <div className="card-heading">BACKEND LINK <span className={fresh === false ? 'text-warn' : ''}>{fresh == null ? 'IDLE' : fresh ? '● FRESH' : '⚠ STALE'}</span></div>
            <div className="kv-list">
              <Tile label="LATENCY" value={link.lastLatency == null ? '—' : Math.round(link.lastLatency)} unit="ms" />
              <Tile label="AVG LATENCY" value={link.avgLatency == null ? '—' : Math.round(link.avgLatency)} unit="ms" />
              <Tile label="SAMPLE RATE" value={f(link.rateHz, 1)} unit="Hz" />
              <Tile label="SENT" value={link.sent} />
              <Tile label="ACKED" value={link.ok} tone="mint" />
              <Tile label="FAILED" value={link.failed} tone={link.failed ? 'warn' : ''} />
            </div>
            <div className="coord-row"><span>SESSION</span><code className="session-id">{sessionRef.current.split('-').slice(-1)[0]}</code></div>
            <div className="coord-row"><span>LAST SEQUENCE</span><code>{telemetry.lastSequence ?? '—'}</code></div>
            <div className="coord-row"><span>SERVER TOP / AVG SPEED</span><code>{stats.maxSpeed != null ? `${Math.round(stats.maxSpeed)} / ${Math.round(stats.avgSpeed)} km/h` : '—'}</code></div>
            <div className="coord-row"><span>LAST SAMPLE</span><code>{telemetry.lastUpdate ? new Date(telemetry.lastUpdate).toLocaleTimeString() : 'No telemetry yet'}</code></div>
            <div className="export-row"><button type="button" className="tool" onClick={exportCsv}>⬇ Export CSV</button><small>{logRef.current.length} samples recorded</small></div>
          </div>
        </div>}

        {tab === 'controls' && <div className="tab-body">
          <div className="coords-card keys-card">
            <div className="card-heading">DRIVING <span>KEYBOARD</span></div>
            {[['W / ↑', 'Accelerate'], ['S / ↓', 'Brake, then reverse'], ['A D / ← →', 'Steer'], ['Q / E', 'Sidestep left / right (free steering)'], ['Space', 'Handbrake — hold with steering to drift'], ['Shift', 'Boost (while accelerating)']]
              .map(([k, d]) => <div className="key-row" key={k}><kbd>{k}</kbd><span>{d}</span></div>)}
          </div>
          <div className="coords-card keys-card">
            <div className="card-heading">SIMULATION</div>
            {[['C', 'Cycle camera (chase / cockpit / top / orbit)'], ['L', 'Headlights'], ['G', 'Free ⇄ realistic steering'], ['F', 'Recover onto the road'], ['P / Esc', 'Pause / resume'], ['Enter', 'Start trip'], ['R', 'Reset trip'], ['T / H', 'Telemetry / this help']]
              .map(([k, d]) => <div className="key-row" key={k}><kbd>{k}</kbd><span>{d}</span></div>)}
          </div>
          <div className="coords-card keys-card">
            <div className="card-heading">MOUSE · TOUCH · GAMEPAD <span>{live.gamepad ? 'CONNECTED' : 'NONE DETECTED'}</span></div>
            {[['Drag', 'Rotate the view (orbit camera)'], ['Wheel', 'Zoom the current camera'], ['Touch pad', 'Multi-touch on-screen controls'], ['Gamepad', 'RT/LT pedals · left stick steer · A handbrake · B boost · Y camera · Start pause']]
              .map(([k, d]) => <div className="key-row" key={k}><kbd>{k}</kbd><span>{d}</span></div>)}
          </div>
          <div className="coords-card keys-card"><div className="card-heading">HOW TOLLING WORKS</div>
            <p className="note">You can drive anywhere. The backend only counts your progress <b>along the route</b> between the ENTRY and EXIT gates — sideways movement, driving on the grass and distance outside the corridor are never charged. The road is <b>two-way</b>: northbound you enter at A and leave at B, C or D; southbound you enter at D and leave at C, B or A (southbound exit ramps branch off on the left). The same per-km rate applies both ways. Turning back out through the gate you came in by is handled correctly.</p>
          </div>
        </div>}

        <div className="footer-status">
          <span className={`status-dot ${apiStatus}`} />
          <div><strong>{apiStatus === 'online' ? 'Backend responding' : offline ? 'Backend unavailable' : 'Checking backend'}</strong><small>{apiStatus === 'online' ? 'Telemetry is processed by the Express API' : `Expected at ${API}`}</small></div>
          <button type="button" title="Check API again" onClick={() => checkBackend()}>↻</button>
        </div>
      </aside>
    </main>
  </div>;
}

/* Everything the dashboard needs, computed from the vehicle at HUD cadence. */
function snapshot(v, now, series, link, fps, gamepad) {
  const { lat, lon } = toLatLon(v.x, v.z);
  link.times = link.times.filter(t => now - t < 3000);
  return {
    kmh: v.kmh, speed: v.speed, heading: headingDegrees(v.heading), accelLong: v.accelLong, accelLat: v.accelLat,
    yawDeg: v.yawRate * 180 / Math.PI, slip: v.slip, steer: v.steer, throttle: v.throttle, brake: v.brake,
    surface: v.surface, skid: v.skid, boosting: v.boosting, x: v.x, simPos: simPosition(v.z), lat, lon,
    odometer: v.odometer, maxKmh: v.maxKmh, avgKmh: v.movingTime > 0.5 ? (v.odometer / v.movingTime) * 3.6 : 0, tripTime: v.tripTime, impacts: v.impacts,
    series: { speed: series.speed.slice(), g: series.g.slice(), lane: series.lane.slice() },
    link: {
      sent: link.sent, ok: link.ok, failed: link.failed, lastLatency: link.lastLatency,
      avgLatency: link.lat.length ? link.lat.reduce((a, b) => a + b, 0) / link.lat.length : null, rateHz: link.times.length / 3
    },
    fps, gamepad, wall: Date.now()
  };
}
