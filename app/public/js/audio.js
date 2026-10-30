// Synthesized sound effects for the Omniverse view. Everything is generated with the
// Web Audio API, so there are no audio files. Sound is per screen (stored in this
// browser), off by default, and only ever plays in the Omniverse view.
import { store } from './util.js';

const DEFAULTS = { on: false, vol: 0.5, controller: true, ship: true, radar: true, ambient: false, ww2: true, hum: false };

let ctx = null; let master = null; let comp = null;
let ambientNodes = null;
let ctx_ok = () => false; // set by init: is Omniverse showing, and is it outside quiet hours?
let quietCheck = () => false;
let isWw2 = () => false;
let lastPing = 0; let lastChime = 0;

export function soundPrefs() { return { ...DEFAULTS, ...(store('sound') || {}) }; }
export function saveSoundPrefs(patch) {
  store('sound', { ...soundPrefs(), ...patch });
  applyVolume();
  syncAmbient();
}

/** isOmniverse: () => boolean, isQuiet: () => boolean */
export function initAudio({ isOmniverse, isQuiet, isWw2: ww2 }) {
  ctx_ok = isOmniverse; quietCheck = isQuiet; if (ww2) isWw2 = ww2;
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
  if (cat === 'ww2' ? !isWw2() : !ctx_ok()) return false;
  if (quietCheck()) return false;
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
let ambientMode = null;
function startAmbient(mode = 'omni') {
  if (ctx && ambientNodes && ambientMode !== mode) stopAmbient();
  if (ambientNodes || !ctx) return;
  ambientMode = mode;
  const t = ctx.currentTime;
  const out = ctx.createGain(); out.gain.setValueAtTime(0.0001, t); out.gain.linearRampToValueAtTime(mode === 'ww2' ? 0.06 : 0.05, t + 4);
  out.connect(master);
  const oscs = [];
  const s = ctx.createBufferSource(); s.buffer = noiseBuffer(); s.loop = true;
  if (mode === 'ww2') {
    // mains transformer hum with its harmonics, plus a little tube hiss
    for (const [f, v] of [[60, 0.6], [120, 0.35], [180, 0.12], [240, 0.06]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = v; o.connect(g); g.connect(out); oscs.push(o);
    }
    const flt = ctx.createBiquadFilter(); flt.type = 'bandpass'; flt.frequency.value = 3200; flt.Q.value = 0.7;
    const ng = ctx.createGain(); ng.gain.value = 0.05; s.connect(flt); flt.connect(ng); ng.connect(out);
  } else {
    const o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = 55;
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = 82.6;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.35;
    const mod = ctx.createGain(); mod.gain.value = 0.65;
    lfo.connect(lfoG); lfoG.connect(mod.gain);
    o1.connect(mod); o2.connect(mod);
    const flt = ctx.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = 220;
    const ng = ctx.createGain(); ng.gain.value = 0.25;
    s.connect(flt); flt.connect(ng);
    mod.connect(out); ng.connect(out);
    oscs.push(o1, o2, lfo);
  }
  oscs.forEach((o) => o.start()); s.start();
  ambientNodes = { out, stop: () => { oscs.forEach((o) => { try { o.stop(); } catch { /* done */ } }); try { s.stop(); } catch { /* done */ } } };
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
  const quiet = quietCheck();
  const mode = p.on && !quiet ? (ctx_ok() && p.ambient ? 'omni' : isWw2() && p.hum ? 'ww2' : null) : null;
  if (mode) { if (ensure()) startAmbient(mode); } else stopAmbient();
}

/** Plays a sample so the volume slider and toggle can be tried from settings */
export function preview() {
  if (!soundPrefs().on || !ensure()) return;
  forcing = true; lastPing = 0;
  ping(true); transmission(30);
  forcing = false;
}

// ---------- WW2 console: telegraph key ----------
let keyTone = null;
/** Sidetone while the telegraph key is held down */
export function keyDown() {
  if (keyTone || !can('ww2')) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(); const g = ctx.createGain();
  o.type = 'sine'; o.frequency.value = 650;
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.18, t + 0.006);
  o.connect(g); g.connect(master); o.start(t);
  keyTone = { o, g };
}
export function keyUp() {
  if (!keyTone) return;
  const { o, g } = keyTone; keyTone = null;
  const t = ctx.currentTime;
  g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0.0001, t + 0.012);
  o.stop(t + 0.02);
}
/** Plays a Morse string like "...-" (dot 90 ms, dash 270 ms) */
export function morse(pattern) {
  if (!can('ww2')) return;
  let at = 0;
  for (const c of pattern) {
    if (c === ' ') { at += 0.27; continue; }
    const len = c === '.' ? 0.09 : 0.27;
    tone({ f: 650, dur: len, type: 'sine', vol: 0.18, at, attack: 0.006 });
    at += len + 0.09;
  }
}
/** A teleprinter chatter for the telegram card */
export function teleprinter(chars = 40) {
  if (!can('ww2')) return;
  const n = Math.min(40, Math.max(6, Math.round(chars / 3)));
  for (let i = 0; i < n; i++) noise({ dur: 0.02, vol: 0.14, filter: 'highpass', f: 2500, at: i * 0.045 + Math.random() * 0.015 });
  noise({ dur: 0.05, vol: 0.2, filter: 'bandpass', f: 900, at: n * 0.045 + 0.05 });
}

// ---------- WW2 console effects ----------
let lastRatchet = 0; let lastBlip = 0;
/** Soft thump each time the beam passes north */
export function sweepThump() {
  if (!can('ww2')) return;
  tone({ f: 75, f2: 42, dur: 0.22, type: 'sine', vol: 0.16 });
  noise({ dur: 0.05, vol: 0.05, filter: 'lowpass', f: 600 });
}
/** A contact painted by the beam: a short blip panned to where it is on the scope */
export function blip(pan = 0) {
  const now = performance.now();
  if (now - lastBlip < 120) return;
  if (!can('ww2')) return;
  lastBlip = now;
  tone({ f: 1500, dur: 0.07, type: 'sine', vol: 0.1, attack: 0.002, pan: pan * 0.7 });
  tone({ f: 3000, dur: 0.04, type: 'sine', vol: 0.025, attack: 0.002, pan: pan * 0.7 });
}
/** Relay clack for the lit push buttons */
export function clack() {
  if (!can('ww2')) return;
  noise({ dur: 0.03, vol: 0.4, filter: 'bandpass', f: 1400, q: 1.2 });
  tone({ f: 170, f2: 90, dur: 0.05, type: 'square', vol: 0.1, at: 0.025 });
}
/** Heavy toggle switch or selector detent */
export function clunk(up = true) {
  if (!can('ww2')) return;
  noise({ dur: 0.04, vol: 0.4, filter: 'bandpass', f: up ? 900 : 700, q: 0.9 });
  tone({ f: up ? 110 : 90, f2: 55, dur: 0.1, type: 'sine', vol: 0.3 });
  noise({ dur: 0.02, vol: 0.22, filter: 'highpass', f: 2400, at: 0.07 });
}
/** Detent click as a knob turns */
export function ratchet() {
  const now = performance.now();
  if (now - lastRatchet < 35) return;
  if (!can('ww2')) return;
  lastRatchet = now;
  noise({ dur: 0.012, vol: 0.28, filter: 'highpass', f: 2200 });
  tone({ f: 380, dur: 0.02, type: 'square', vol: 0.03 });
}
/** Lamp test: relays chattering and a buzz */
export function lampBuzz() {
  if (!can('ww2')) return;
  for (let i = 0; i < 7; i++) noise({ dur: 0.025, vol: 0.3, filter: 'bandpass', f: 1300, q: 1.2, at: i * 0.07 });
  tone({ f: 120, dur: 1.2, type: 'sawtooth', vol: 0.05, at: 0.1, attack: 0.05 });
}
/** Air-raid style wail for an emergency squawk */
export function klaxon() {
  if (!can('ww2')) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(); const flt = ctx.createBiquadFilter(); const g = ctx.createGain();
  o.type = 'sawtooth'; flt.type = 'lowpass'; flt.frequency.value = 1700;
  o.frequency.setValueAtTime(420, t);
  for (let i = 0; i < 2; i++) { o.frequency.linearRampToValueAtTime(880, t + i * 1.4 + 0.7); o.frequency.linearRampToValueAtTime(420, t + i * 1.4 + 1.4); }
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.11, t + 0.15); g.gain.setValueAtTime(0.11, t + 2.5); g.gain.linearRampToValueAtTime(0.0001, t + 2.9);
  o.connect(flt); flt.connect(g); g.connect(master); o.start(t); o.stop(t + 3);
}
/** Desk bell, at the end of a telegram */
/** A short bugle call for the flag */
export function bugle() {
  if (!can('ww2')) return;
  [[392, .16], [523, .16], [659, .16], [784, .5], [659, .16], [784, 1.0]].reduce((at, [f, d]) => {
    tone({ f, dur: d * 1.1, type: 'triangle', vol: 0.16, at, attack: 0.02 });
    tone({ f: f * 2, dur: d, type: 'sine', vol: 0.04, at, attack: 0.02 });
    return at + d + 0.03;
  }, 0);
}
let sirenNodes = null;
/** Air raid siren: a rising and falling wail over a low drone of engines */
export function siren(durSec = 15) {
  if (!can('ww2')) return;
  stopSiren();
  const t = ctx.currentTime;
  const o = ctx.createOscillator(); const f = ctx.createBiquadFilter(); const g = ctx.createGain();
  o.type = 'sawtooth'; f.type = 'lowpass'; f.frequency.value = 1500;
  o.frequency.setValueAtTime(380, t);
  for (let i = 0; i < Math.ceil(durSec / 4); i++) { o.frequency.linearRampToValueAtTime(860, t + i * 4 + 2); o.frequency.linearRampToValueAtTime(380, t + i * 4 + 4); }
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.1, t + 0.5); g.gain.setValueAtTime(0.1, t + durSec - 1.5); g.gain.linearRampToValueAtTime(0.0001, t + durSec);
  o.connect(f); f.connect(g); g.connect(master); o.start(t); o.stop(t + durSec + 0.1);
  const d1 = ctx.createOscillator(); const d2 = ctx.createOscillator(); const dg = ctx.createGain();
  d1.type = 'sawtooth'; d2.type = 'sawtooth'; d1.frequency.value = 54; d2.frequency.value = 57.5;
  dg.gain.setValueAtTime(0.0001, t); dg.gain.linearRampToValueAtTime(0.1, t + durSec * 0.7); dg.gain.linearRampToValueAtTime(0.0001, t + durSec);
  const df = ctx.createBiquadFilter(); df.type = 'lowpass'; df.frequency.value = 220;
  d1.connect(df); d2.connect(df); df.connect(dg); dg.connect(master); d1.start(t); d2.start(t); d1.stop(t + durSec + 0.1); d2.stop(t + durSec + 0.1);
  sirenNodes = [o, d1, d2];
}
export function stopSiren() {
  if (!sirenNodes) return;
  for (const n of sirenNodes) { try { n.stop(); } catch { /* already stopped */ } }
  sirenNodes = null;
}
export function bell() {
  if (!can('ww2')) return;
  tone({ f: 1760, dur: 1.1, type: 'sine', vol: 0.12 });
  tone({ f: 2349, dur: 0.8, type: 'sine', vol: 0.06 });
  tone({ f: 3520, dur: 0.4, type: 'sine', vol: 0.025 });
}
/** The unidentified contact: an eerie warble */
export function warble() {
  if (!can('ww2')) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(); const lfo = ctx.createOscillator(); const lg = ctx.createGain(); const g = ctx.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(480, t); o.frequency.linearRampToValueAtTime(620, t + 3.2);
  lfo.frequency.value = 6.5; lg.gain.value = 38; lfo.connect(lg); lg.connect(o.frequency);
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.07, t + 1); g.gain.linearRampToValueAtTime(0.0001, t + 3.4);
  o.connect(g); g.connect(master); o.start(t); lfo.start(t); o.stop(t + 3.5); lfo.stop(t + 3.5);
}
/** A radial engine passing by (a warbird on the scope) */
export function engine() {
  if (!can('ww2')) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(); const flt = ctx.createBiquadFilter(); const am = ctx.createGain(); const lfo = ctx.createOscillator(); const lg = ctx.createGain(); const g = ctx.createGain();
  o.type = 'sawtooth'; o.frequency.setValueAtTime(70, t); o.frequency.linearRampToValueAtTime(92, t + 1.8); o.frequency.linearRampToValueAtTime(64, t + 3.6);
  flt.type = 'lowpass'; flt.frequency.value = 340;
  am.gain.value = 0.55; lfo.frequency.value = 15; lg.gain.value = 0.45; lfo.connect(lg); lg.connect(am.gain);
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.14, t + 1.6); g.gain.linearRampToValueAtTime(0.0001, t + 3.6);
  o.connect(flt); flt.connect(am); am.connect(g); g.connect(master);
  o.start(t); lfo.start(t); o.stop(t + 3.7); lfo.stop(t + 3.7);
}
