import React, { useEffect, useId, useRef } from 'react';
import { ROUTES, ROUTE_LENGTH, START_Z, ROAD, RAMP_LEN, rampCentre, rampGatesOf, getScenery, clamp, cardinal } from './constants.js';

/* ---------- Speedometer: 240° arc gauge ---------- */
const polar = (cx, cy, r, deg) => [cx + r * Math.sin(deg * Math.PI / 180), cy - r * Math.cos(deg * Math.PI / 180)];
const arc = (cx, cy, r, a0, a1) => {
  const [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, a1);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};

export const Speedometer = React.memo(function Speedometer({ kmh, gear, boosting, max = 180 }) {
  const cx = 100, cy = 100, r = 78;
  const ang = v => -120 + 240 * clamp(v / max, 0, 1);
  const ticks = [];
  for (let v = 0; v <= max; v += 10) {
    const major = v % 30 === 0, a = ang(v);
    const [x0, y0] = polar(cx, cy, r + 7, a), [x1, y1] = polar(cx, cy, r + (major ? 15 : 11), a);
    ticks.push(<line key={v} x1={x0} y1={y0} x2={x1} y2={y1} className={major ? 'tick major' : 'tick'} />);
    if (major) { const [tx, ty] = polar(cx, cy, r - 14, a); ticks.push(<text key={`t${v}`} x={tx} y={ty + 3} className="tick-label">{v}</text>); }
  }
  const shown = Math.min(kmh, max);
  return <div className={`speedo ${boosting ? 'boost' : ''}`}>
    <svg viewBox="0 0 200 168" role="img" aria-label={`Speed ${Math.round(kmh)} kilometres per hour`}>
      <path d={arc(cx, cy, r, -120, 120)} className="gauge-track" />
      <path d={arc(cx, cy, r, ang(130), 120)} className="gauge-red" />
      {shown > 0.5 && <path d={arc(cx, cy, r, -120, ang(shown))} className="gauge-fill" />}
      {ticks}
      <text x={cx} y={cy + 6} className="speed-num">{Math.round(kmh)}</text>
      <text x={cx} y={cy + 22} className="speed-unit">KM/H</text>
    </svg>
    <div className="gear-row">
      {['R', 'N', 'D'].map(g => <span key={g} className={g === gear ? 'on' : ''}>{g}</span>)}
      <span className={`boost-tag ${boosting ? 'on' : ''}`}>BOOST</span>
    </div>
  </div>;
});

/* ---------- Compass ---------- */
export const Compass = React.memo(function Compass({ heading }) {
  const dirs = [['N', 0], ['E', 90], ['S', 180], ['W', 270]];
  return <div className="compass" aria-label={`Heading ${Math.round(heading)} degrees`}>
    <svg viewBox="0 0 80 80">
      <g style={{ transform: `rotate(${-heading}deg)`, transformOrigin: '40px 40px' }}>
        <circle cx="40" cy="40" r="35" className="compass-ring" />
        {Array.from({ length: 24 }, (_, i) => { const a = i * 15, [x0, y0] = polar(40, 40, 35, a), [x1, y1] = polar(40, 40, i % 6 === 0 ? 29 : 32, a); return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} className="compass-tick" />; })}
        {dirs.map(([d, a]) => { const [x, y] = polar(40, 40, 23, a); return <text key={d} x={x} y={y + 3} className={`compass-dir ${d === 'N' ? 'north' : ''}`} style={{ transform: `rotate(${heading}deg)`, transformOrigin: `${x}px ${y}px` }}>{d}</text>; })}
      </g>
      <path d="M40 8 L45 18 L35 18 Z" className="compass-pointer" />
    </svg>
    <div className="compass-read"><b>{String(Math.round(heading) % 360).padStart(3, '0')}°</b><span>{cardinal(heading)}</span></div>
  </div>;
});

/* ---------- Minimap (north-up radar, redrawn on its own rAF loop, no React renders) ---------- */
export function Minimap({ vehicleRef, routeKey, trailRef, size = 148 }) {
  const ref = useRef();
  useEffect(() => {
    const cv = ref.current;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = size * dpr; cv.height = size * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const route = ROUTES[routeKey] || ROUTES.express;
    const sc = getScenery(routeKey);
    const S = size, H = S / 2, pad = 11, k = S / 128;
    const mapY = progress => S - pad - (clamp(progress, 0, ROUTE_LENGTH) / ROUTE_LENGTH) * (S - pad * 2);
    const mapX = x => pad + ((x + 27) / 60) * (S - pad * 2);
    const drawPath = (gate, color, width) => {
      ctx.beginPath();
      const rev = gate.dir === -1;
      const start = rev ? gate.position + RAMP_LEN : gate.position - RAMP_LEN;
      for (let i = 0; i <= 30; i++) {
        const t = i / 30, progress = start + (rev ? -RAMP_LEN : RAMP_LEN) * t;
        const x = rampCentre(gate, progress), y = mapY(progress);
        if (i === 0) ctx.moveTo(mapX(x), y); else ctx.lineTo(mapX(x), y);
      }
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.stroke();
    };
    let raf, last = 0;
    const draw = t => {
      raf = requestAnimationFrame(draw);
      if (t - last < 66) return;
      last = t;
      const v = vehicleRef.current;
      ctx.clearRect(0, 0, S, S);
      ctx.save();
      ctx.fillStyle = '#0a1b2b'; ctx.fillRect(0, 0, S, S);
      // Subtle map grid and full-route overview (not a vehicle-centred linear slice).
      ctx.strokeStyle = '#ffffff14'; ctx.lineWidth = 1;
      for (let i = 1; i < 5; i++) { const yy = i * S / 5; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(S, yy); ctx.stroke(); }
      const first = route.gates.find(g => g.kind === 'ENTRY');
      const lastExit = Math.max(...route.gates.filter(g => g.kind === 'EXIT').map(g => g.position));
      const roadTop = mapY(lastExit + 10), roadBottom = mapY(first.position - 15);
      // Mainline carriageway.
      ctx.lineCap = 'round'; ctx.strokeStyle = '#51636f'; ctx.lineWidth = 17 * k;
      ctx.beginPath(); ctx.moveTo(mapX(0), roadBottom); ctx.lineTo(mapX(0), roadTop); ctx.stroke();
      ctx.strokeStyle = '#dbe6ec'; ctx.lineWidth = 1.2; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(mapX(0), roadBottom); ctx.lineTo(mapX(0), roadTop); ctx.stroke(); ctx.setLineDash([]);
      // Real branch paths at their configured gate positions.
      for (const g of rampGatesOf(route)) {
        const y0 = mapY(g.dir === -1 ? g.position + RAMP_LEN : g.position - RAMP_LEN);
        ctx.strokeStyle = '#51636f'; ctx.lineWidth = 13 * k;
        ctx.beginPath(); ctx.moveTo(mapX(0), y0); ctx.lineTo(mapX(g.x < 0 ? -6.4 : 6.4), y0); ctx.stroke();
        drawPath(g, '#51636f', 13 * k);
        drawPath(g, '#aebfca', 1.2);
      }
      // Gate bars and readable labels for every exit, including D on the mainline.
      const mapGates = [...route.gates, ...(route.reverseGates || []).filter(g => (g.x || 0) !== 0)];
      for (const g of mapGates) {
        const gx = g.kind === 'ENTRY' ? 0 : (g.x || 0), gy = mapY(g.position), px = mapX(gx);
        const twoWay = !(g.x || 0) && (route.reverseGates || []).some(q => q.position === g.position && !(q.x || 0) && q.kind !== g.kind);
        // Compact gate badge: the letter sits inside the dot (mainline gates A / D work in both directions and get a ring).
        ctx.beginPath(); ctx.arc(px, gy, 6.2, 0, Math.PI * 2);
        ctx.fillStyle = g.kind === 'ENTRY' || twoWay ? route.accent : '#70b7ff'; ctx.fill();
        ctx.strokeStyle = twoWay ? '#ffffff' : '#07151d'; ctx.lineWidth = twoWay ? 1.6 : 1.4; ctx.stroke();
        ctx.fillStyle = '#06131d'; ctx.font = '800 8px "DM Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(g.id, px, gy + 0.6);
        ctx.textBaseline = 'alphabetic';
      }
      // Recent vehicle trail and current position.
      const trail = trailRef.current;
      if (trail.length > 1) {
        ctx.strokeStyle = '#4be5c5cc'; ctx.lineWidth = 2; ctx.beginPath();
        trail.forEach((p, i) => {
          const progress = START_Z - p[1];
          if (i === 0) ctx.moveTo(mapX(p[0]), mapY(progress)); else ctx.lineTo(mapX(p[0]), mapY(progress));
        }); ctx.stroke();
      }
      const progress = START_Z - v.z;
      ctx.translate(mapX(v.x), mapY(progress)); ctx.rotate(v.heading);
      ctx.fillStyle = '#4be5c5'; ctx.strokeStyle = '#06211f'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, -6.5); ctx.lineTo(5, 5); ctx.lineTo(0, 3); ctx.lineTo(-5, 5); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#9fd8cd'; ctx.font = '700 8px "DM Mono", monospace'; ctx.textAlign = 'center'; ctx.fillText('N', H, 10);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [routeKey, size, vehicleRef, trailRef]);
  return <canvas ref={ref} className="minimap" style={{ width: size, height: size }} aria-label="Route overview showing entry, all exits and branching roads" />;
}

/* ---------- Sparkline (fixed time window, newest sample on the right) ---------- */
export const Spark = React.memo(function Spark({ data, min = 0, max = 1, color = '#4be5c5', height = 46, zeroLine = false, window = 240 }) {
  const id = useId();
  const W = 240, n = data.length;
  const yOf = d => height - 2 - ((clamp(d, min, max) - min) / (max - min || 1)) * (height - 4);
  const pts = data.map((d, i) => `${(((i + window - n) / (window - 1)) * W).toFixed(1)},${yOf(d).toFixed(1)}`);
  const line = pts.join(' ');
  const x0 = n ? (window - n) / (window - 1) * W : 0;
  return <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="spark" style={{ height }}>
    <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".35" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
    {zeroLine && <line x1="0" x2={W} y1={yOf(0)} y2={yOf(0)} className="spark-zero" />}
    {n > 1 && <>
      <polygon points={`${x0},${height} ${line} ${W},${height}`} fill={`url(#${id})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </>}
  </svg>;
});

/* ---------- Route progress, with the charging corridor shown on the track ---------- */
export const RouteTrack = React.memo(function RouteTrack({ routeKey, simPos, inside }) {
  const route = ROUTES[routeKey] || ROUTES.express;
  const pct = v => `${(v / ROUTE_LENGTH) * 100}%`;
  const gates = route.gates || [{ id: 'A', position: route.entry, kind: 'ENTRY' }, { id: 'B', position: route.exit, kind: 'EXIT' }];
  return <div className="route-track">
    <div className="route-track-label"><span>ROUTE · GATES A–D · TWO-WAY</span><strong>{Math.round((simPos / ROUTE_LENGTH) * 100)}% · {Math.round(simPos)} m</strong></div>
    <div className="track-row">
      <span className="track-end" title="South end of the road">S</span>
      <div className="track-col">
        <div className="track">
          <div className={`track-zone ${inside ? 'live' : ''}`} style={{ left: pct(route.entry), width: pct(route.exit - route.entry), '--accent': route.accent }} />
          {gates.map(g => <i key={g.id} title={`Gate ${g.id} · ${g.position} m`} className="track-gate" style={{ left: pct(g.position), background: g.id === 'A' || g.id === 'D' ? route.accent : '#70b7ff' }} />)}
          <div className="track-car" style={{ left: pct(simPos) }} />
        </div>
        <div className="track-scale">{gates.map(g => <span key={g.id} style={{ left: pct(g.position), color: g.id === 'A' || g.id === 'D' ? route.accent : '#70b7ff' }}>{g.id}</span>)}</div>
      </div>
      <span className="track-end" title="North end of the road">N</span>
    </div>
  </div>;
});
