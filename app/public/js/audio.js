// Synthesized sound effects for the Omniverse view. Everything is generated with the
// Web Audio API, so there are no audio files. Sound is per screen (stored in this
// browser), off by default, and only ever plays in the Omniverse view.
import { store } from './util.js';

const DEFAULTS = { on: false, vol: 0.5, controller: true, ship: true, radar: true, ambient: false };

let ctx = null; let master = null; let comp = null;
let ambientNodes = null;
let ctx_ok = () => false; // set by init: is Omniverse showing, and is it outside quiet hours?
let quietCheck = () => false;
let lastPing = 0; let lastChime = 0;

export function soundPrefs() { return { ...DEFAULTS, ...(store('sound') || {}) }; }
export function saveSoundPrefs(patch) {
  store('sound', { ...soundPrefs(), ...patch });
  applyVolume();
  syncAmbient();
}

/** isOmniverse: () => boolean, isQuiet: () => boolean */
export function initAudio({ isOmniverse, isQuiet }) {
  ctx_ok = isOmniverse; quietCheck = isQuiet;
  // Browsers only allow audio after a click or key press, so unlock on the first one.
  const unlock = () => { ensure(); syncAmbient(); };
  ['pointerdown', 'keydown', 'touchstart'].forEach((e) => window.addEventListener(e, unlock, { passive: true }));
  setInterval(syncAmbient, 15000);
}

function ensure() {
  if (!soundPrefs().on) return false;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  if (!ctx) {
    try {
      ctx = new AC();
      comp = ctx.createDynamicsCompressor();
      master = ctx.createGain();
      master.connect(comp); comp.connect(ctx.destination);
      applyVolume();
    } catch { ctx = null; return false; }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx.state === 'running';
}

function applyVolume() {
  if (master) master.gain.value = Math.pow(soundPrefs().vol, 1.6) * 0.9;
}

/** Can a sound in this category play right now? */
let forcing = false;
function can(cat) {
  if (forcing) return ensure();
  const p = soundPrefs();
  if (!p.on || (cat && !p[cat])) return false;
  if (!ctx_ok() || quietCheck()) return false;
  return ensure();
}

// ---------- building blocks ----------
function tone({ f = 440, f2 = null, dur = 0.2, type = 'sine', vol = 0.3, at = 0, attack = 0.005, pan = 0, out = master }) {
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator(); const g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(1, f2), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let last = g;
  o.connect(g);
  if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); last = p; }
  last.connect(out);
  o.start(t); o.stop(t + dur + 0.05);
  return { o, g };
}

let noiseBuf = null;
function noiseBuffer() {
  if (noiseBuf) return noiseBuf;
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

function noise({ dur = 0.1, vol = 0.2, at = 0, filter = 'bandpass', f = 2000, f2 = null, q = 1, attack = 0.003, pan = 0, out = master }) {
  const t = ctx.currentTime + at;
  const s = ctx.createBufferSource(); s.buffer = noiseBuffer(); s.loop = true;
  const flt = ctx.createBiquadFilter(); flt.type = filter; flt.Q.value = q;
  flt.frequency.setValueAtTime(f, t);
  if (f2) flt.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(flt); flt.connect(g);
  let last = g;
  if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); last = p; }
  last.connect(out);
  s.start(t, Math.random()); s.stop(t + dur + 0.05);
}

// ---------- the effects ----------
const rnd = (a, b) => a + Math.random() * (b - a);

/** Mic key click, used for each controller click */
export function keyClick() {
  if (!can('controller')) return;
  noise({ dur: 0.03, vol: 0.5, filter: 'highpass', f: 1800, q: 0.7 });
  tone({ f: 180, f2: 90, dur: 0.05, type: 'square', vol: 0.12 });
}

/** The controller speaking: squelch, a burst of radio babble, then a roger beep */
export function transmission(chars = 40) {
  if (!can('controller')) return;
  noise({ dur: 0.14, vol: 0.16, f: 2600, q: 0.8 });
  const n = Math.max(5, Math.min(16, Math.round(chars / 5)));
  let at = 0.1;
  for (let i = 0; i < n; i++) {
    const len = rnd(0.045, 0.1);
    tone({ f: rnd(320, 760), f2: rnd(300, 800), dur: len, type: 'triangle', vol: 0.09, at });
    at += len + rnd(0.015, 0.05);
  }
  tone({ f: 1500, dur: 0.09, type: 'sine', vol: 0.12, at: at + 0.04 });
  noise({ dur: 0.18, vol: 0.12, f: 2200, q: 0.8, at: at + 0.12 });
}

/** Three clicks: the runway lights relay */
export function lightsRelay() {
  if (!can('controller')) return;
  [0, 0.16, 0.32].forEach((at) => noise({ dur: 0.03, vol: 0.45, filter: 'highpass', f: 1600, at }));
  tone({ f: 70, f2: 45, dur: 0.25, type: 'sine', vol: 0.28, at: 0.5 });
  tone({ f: 110, dur: 2.5, type: 'sine', vol: 0.05, at: 0.5, attack: 0.4 });
}

/** Five clicks: power-up hum rising with the lights */
export function powerUp() {
  if (!can('controller')) return;
  tone({ f: 55, f2: 330, dur: 3, type: 'sawtooth', vol: 0.07, attack: 0.5 });
  tone({ f: 110, f2: 660, dur: 3, type: 'sine', vol: 0.1, attack: 0.5 });
  noise({ dur: 3, vol: 0.06, filter: 'lowpass', f: 300, f2: 5000, attack: 0.6 });
  tone({ f: 880, dur: 0.15, type: 'sine', vol: 0.1, at: 3.0 });
}

/** Seven clicks: a sharp rise, a deep boom and a long rumble */
export function bigBang() {
  if (!can('controller')) return;
  noise({ dur: 0.45, vol: 0.4, filter: 'bandpass', f: 200, f2: 7000, q: 0.6, attack: 0.3 });
  tone({ f: 100, f2: 900, dur: 0.45, type: 'sawtooth', vol: 0.1, attack: 0.3 });
  const b = 0.45;
  noise({ dur: 0.35, vol: 0.9, filter: 'lowpass', f: 9000, f2: 400, at: b, attack: 0.004 });
  tone({ f: 90, f2: 24, dur: 3.2, type: 'sine', vol: 0.95, at: b, attack: 0.01 });
  tone({ f: 55, f2: 20, dur: 4.5, type: 'sine', vol: 0.7, at: b + 0.05, attack: 0.02 });
  noise({ dur: 5, vol: 0.45, filter: 'lowpass', f: 700, f2: 60, at: b, attack: 0.05 });
  // shimmer as the light fades
  [1320, 1760, 2640].forEach((f, i) => tone({ f, dur: 3.5, type: 'sine', vol: 0.025, at: b + 0.6 + i * 0.25, attack: 0.4 }));
}

/** The ship drifting by: a soft whoosh that pans across the speakers */
export function flybyWhoosh(durMs, panFrom, panTo) {
  if (!can('ship')) return;
  const dur = durMs / 1000; const t = ctx.currentTime;
  const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  const bus = ctx.createGain(); bus.gain.value = 1;
  if (p) { p.pan.setValueAtTime(panFrom, t); p.pan.linearRampToValueAtTime(panTo, t + dur); bus.connect(p); p.connect(master); } else bus.connect(master);
  const s = ctx.createBufferSource(); s.buffer = noiseBuffer(); s.loop = true;
  const flt = ctx.createBiquadFilter(); flt.type = 'bandpass'; flt.Q.value = 2.5;
  flt.frequency.setValueAtTime(250, t);
  flt.frequency.exponentialRampToValueAtTime(1400, t + dur * 0.5);
  flt.frequency.exponentialRampToValueAtTime(220, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.16, t + dur * 0.5);
  g.gain.linearRampToValueAtTime(0.0001, t + dur);
  s.connect(flt); flt.connect(g); g.connect(bus);
  s.start(t, Math.random()); s.stop(t + dur + 0.1);
  tone({ f: 260, f2: 520, dur: dur * 0.5, type: 'sine', vol: 0.03, attack: dur * 0.3, out: bus });
  tone({ f: 520, f2: 240, dur: dur * 0.5, type: 'sine', vol: 0.03, at: dur * 0.5, attack: dur * 0.05, out: bus });
}

/** Clicking the ship */
export function zap() {
  if (!can('ship')) return;
  tone({ f: 2200, f2: 180, dur: 0.28, type: 'sawtooth', vol: 0.12 });
  tone({ f: 1400, f2: 2400, dur: 0.12, type: 'square', vol: 0.05, at: 0.3 });
}

/** A new aircraft shows up on the scope */
export function ping(special = false) {
  const now = performance.now();
  if (now - lastPing < 2500) return;
  if (!can('radar')) return;
  lastPing = now;
  const f = special ? 1760 : 1175;
  tone({ f, dur: 0.5, type: 'sine', vol: 0.16 });
  tone({ f, dur: 0.5, type: 'sine', vol: 0.06, at: 0.18 });
}

/** A new type on the life list: a short 8-bit arpeggio */
export function levelUp() {
  const now = performance.now();
  if (now - lastChime < 4000) return;
  if (!can('radar')) return;
  lastChime = now;
  [523, 659, 784, 1047].forEach((f, i) => tone({ f, dur: 0.12, type: 'square', vol: 0.07, at: i * 0.075 }));
  tone({ f: 1047, dur: 0.35, type: 'square', vol: 0.06, at: 0.32 });
}

/** Emergency squawk: a restrained two-tone alert */
export function alarm() {
  if (!can('radar')) return;
  for (let i = 0; i < 3; i++) {
    tone({ f: 880, dur: 0.16, type: 'triangle', vol: 0.18, at: i * 0.4 });
    tone({ f: 660, dur: 0.16, type: 'triangle', vol: 0.18, at: i * 0.4 + 0.2 });
  }
}

/** Konami code */
export function jingle() {
  if (!can('controller')) return;
  const notes = [523, 523, 784, 784, 880, 880, 784, 698, 698, 659, 659, 587, 587, 523];
  notes.forEach((f, i) => tone({ f, dur: i === 6 || i === 13 ? 0.3 : 0.1, type: 'square', vol: 0.07, at: i * 0.11 }));
}

// ---------- ambient hum ----------
function startAmbient() {
  if (ambientNodes || !ctx) return;
  const t = ctx.currentTime;
  const out = ctx.createGain(); out.gain.setValueAtTime(0.0001, t); out.gain.linearRampToValueAtTime(0.05, t + 4);
  out.connect(master);
  const o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = 55;
  const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = 82.6;
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
  const lfoG = ctx.createGain(); lfoG.gain.value = 0.35;
  const mod = ctx.createGain(); mod.gain.value = 0.65;
  lfo.connect(lfoG); lfoG.connect(mod.gain);
  o1.connect(mod); o2.connect(mod);
  const s = ctx.createBufferSource(); s.buffer = noiseBuffer(); s.loop = true;
  const flt = ctx.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = 220;
  const ng = ctx.createGain(); ng.gain.value = 0.25;
  s.connect(flt); flt.connect(ng);
  mod.connect(out); ng.connect(out);
  [o1, o2, lfo].forEach((o) => o.start()); s.start();
  ambientNodes = { out, stop: () => { [o1, o2, lfo].forEach((o) => { try { o.stop(); } catch { /* done */ } }); try { s.stop(); } catch { /* done */ } } };
}

function stopAmbient() {
  if (!ambientNodes) return;
  const { out, stop } = ambientNodes; ambientNodes = null;
  const t = ctx.currentTime;
  out.gain.cancelScheduledValues(t); out.gain.setValueAtTime(out.gain.value, t); out.gain.linearRampToValueAtTime(0.0001, t + 1.2);
  setTimeout(stop, 1400);
}

/** Start or stop the hum to match the settings, the view and quiet hours */
export function syncAmbient() {
  const p = soundPrefs();
  const want = p.on && p.ambient && ctx_ok() && !quietCheck();
  if (want) { if (ensure()) startAmbient(); } else stopAmbient();
}

/** Plays a sample so the volume slider and toggle can be tried from settings */
export function preview() {
  if (!soundPrefs().on || !ensure()) return;
  forcing = true; lastPing = 0;
  ping(true); transmission(30);
  forcing = false;
}
