/*
 * Input sources are kept in plain objects/refs (no React state) so the physics loop reads them every frame
 * without re-rendering:
 *   keys  – physical keys by KeyboardEvent.code (works on any keyboard layout)
 *   pad   – on-screen buttons (pointer events, so multi-touch works)
 *   gp    – the first connected gamepad, polled each frame
 */
export const KEY_ACTIONS = {
  KeyR: 'reset', KeyP: 'pause', Escape: 'pause', Enter: 'start', KeyC: 'camera', KeyL: 'lights',
  KeyG: 'driveMode', KeyF: 'recover', KeyH: 'help', KeyT: 'telemetry'
};
export const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'ShiftLeft', 'ShiftRight'
]);

const DEADZONE = 0.14;
const dz = v => (Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE));

export function readGamepad(prev) {
  const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
  const p = [...pads].find(g => g && g.connected);
  if (!p) return { connected: false, throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, strafe: 0, edges: [] };
  const b = i => p.buttons[i]?.value || 0;
  const pressed = i => !!p.buttons[i]?.pressed;
  const edges = [];
  const was = prev?.down || {};
  const down = { cam: pressed(3), pause: pressed(9), reset: pressed(8), lights: pressed(12), recover: pressed(2) };
  if (down.cam && !was.cam) edges.push('camera');
  if (down.pause && !was.pause) edges.push('pause');
  if (down.reset && !was.reset) edges.push('reset');
  if (down.lights && !was.lights) edges.push('lights');
  if (down.recover && !was.recover) edges.push('recover');
  const dpad = (pressed(15) ? 1 : 0) - (pressed(14) ? 1 : 0);
  return {
    connected: true, id: p.id, down, edges,
    throttle: Math.max(b(7), pressed(7) ? 1 : 0), brake: Math.max(b(6), pressed(6) ? 1 : 0),
    steer: dz(p.axes[0] || 0) || dpad, handbrake: pressed(0), boost: pressed(1) || pressed(5),
    strafe: dz(p.axes[2] || 0) + ((pressed(4) ? -1 : 0))
  };
}

/** Merge keyboard + on-screen pad + gamepad into one analogue input struct for the physics step. */
export function buildInput(keys, pad, gp) {
  const k = c => !!keys[c];
  const throttle = Math.max((k('KeyW') || k('ArrowUp') || pad.throttle) ? 1 : 0, gp.throttle);
  const brake = Math.max((k('KeyS') || k('ArrowDown') || pad.brake) ? 1 : 0, gp.brake);
  const kbSteer = ((k('KeyD') || k('ArrowRight') || pad.right) ? 1 : 0) - ((k('KeyA') || k('ArrowLeft') || pad.left) ? 1 : 0);
  const steer = Math.abs(gp.steer) > Math.abs(kbSteer) ? gp.steer : kbSteer;
  const kbStrafe = (k('KeyE') ? 1 : 0) - (k('KeyQ') ? 1 : 0) + ((pad.strafeR ? 1 : 0) - (pad.strafeL ? 1 : 0));
  const strafe = Math.abs(gp.strafe) > Math.abs(kbStrafe) ? gp.strafe : kbStrafe;
  return {
    throttle, brake, steer, strafe,
    handbrake: k('Space') || !!pad.handbrake || gp.handbrake,
    boost: k('ShiftLeft') || k('ShiftRight') || !!pad.boost || gp.boost
  };
}
