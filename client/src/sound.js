/* Tiny Web Audio sound layer (no assets, no dependencies). Engine hum, tyre squeal, impact thud, gate chime.
 * Everything is created lazily on the first user gesture and is silent unless enabled. */
let ctx = null, master = null, engineGain = null, engineFilter = null, squealGain = null, intakeGain = null, noiseBuf = null;
let oscs = null, enabled = true;

function ensure() {
  if (ctx) return true;
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return false;
  try {
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 1.0; master.connect(ctx.destination);
    // One smooth electric-motor tone: a soft triangle + faint upper harmonic, pitch follows speed.
    engineFilter = ctx.createBiquadFilter(); engineFilter.type = 'lowpass'; engineFilter.frequency.value = 1100; engineFilter.Q.value = 0.8;
    engineGain = ctx.createGain(); engineGain.gain.value = 0;
    engineFilter.connect(engineGain); engineGain.connect(master);
    oscs = [['triangle', 1, 0.85], ['sine', 2, 0.28]].map(([type, mult, vol]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.value = 120; g.gain.value = vol; o.connect(g); g.connect(engineFilter); o.start();
      return { o, mult };
    });
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const loopNoise = (freq, q, type) => {
      const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0; src.connect(f); f.connect(g); g.connect(master); src.start();
      return g;
    };
    squealGain = loopNoise(1700, 7, 'bandpass');   // tyre squeal
    intakeGain = loopNoise(900, 1.0, 'bandpass');   // soft intake / wind rush under throttle
    return true;
  } catch { ctx = null; return false; }
}

const tone = (freq, start, dur, vol, type = 'sine') => {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
  g.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
  o.connect(g); g.connect(master); o.start(ctx.currentTime + start); o.stop(ctx.currentTime + start + dur + 0.05);
};

export const sound = {
  /** Call from a user gesture (Start / key press). */
  unlock() { if (ensure() && ctx.state === 'suspended') ctx.resume().catch(() => {}); },
  setEnabled(on) { enabled = !!on; if (!on) this.silence(); else this.unlock(); },
  isEnabled: () => enabled,
  /** Per-frame: v = vehicle state, active = simulation is running. */
  update(v, active) {
    if (!ctx || !oscs) return;
    const t = ctx.currentTime;
    if (!enabled || !active) { this.silence(); return; }
    const kmh = v.kmh, thr = v.throttle, sp = Math.min(1, kmh / 150);
    const base = 110 + sp * 330 + thr * 25;                       // Hz, rises smoothly with speed
    for (const { o, mult } of oscs) o.frequency.setTargetAtTime(base * mult, t, 0.06);
    engineFilter.frequency.setTargetAtTime(700 + sp * 1100 + thr * 500, t, 0.08);
    engineGain.gain.setTargetAtTime(kmh < 1 && thr < 0.05 ? 0 : 0.032 + 0.085 * thr + 0.038 * sp, t, 0.08);
    intakeGain.gain.setTargetAtTime(thr * 0.022 * sp, t, 0.1);
    squealGain.gain.setTargetAtTime(v.skid ? Math.min(0.18, 0.045 + (v.skidIntensity || 0.4) * 0.12) : 0, t, 0.04);
  },
  silence() { if (!ctx || !engineGain) return; const t = ctx.currentTime; engineGain.gain.setTargetAtTime(0, t, 0.06); squealGain.gain.setTargetAtTime(0, t, 0.05); intakeGain.gain.setTargetAtTime(0, t, 0.05); },
  impact(kmh = 20) {
    if (!ctx || !enabled) return;
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500;
    const g = ctx.createGain(), t = ctx.currentTime, vol = Math.min(0.8, 0.28 + kmh / 90);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(lp); lp.connect(g); g.connect(master); src.start(t, Math.random() * 0.5, 0.4);
  },
  /** kind: 'entry' | 'exit' | 'return' */
  chime(kind = 'entry') {
    if (!ctx || !enabled) return;
    if (kind === 'exit') { tone(660, 0, 0.25, 0.26); tone(880, 0.14, 0.35, 0.26); }
    else if (kind === 'return') { tone(520, 0, 0.2, 0.20); }
    else { tone(880, 0, 0.22, 0.24); tone(1175, 0.12, 0.3, 0.24); }
  }
};
