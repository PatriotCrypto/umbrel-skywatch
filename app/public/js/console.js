// The WW2 view as a full radar console: a steel cabinet that wraps around a big round scope,
// with working knobs, selector switches, toggles, lit push buttons, lamps and gauges.
// Everything here is per screen (stored in this browser) and only shows in the WW2 view.
import { $, h, store, fmtNum, fmtDur, fmtDist } from './util.js';
import * as snd from './audio.js';

let deps = null;
let root = null;
const refs = { knobs: {}, toggles: {}, selectors: {}, lamps: {}, buttons: {}, gauges: {}, win: {} };
let lastData = 0;
let testUntil = 0;
let ackUntil = 0;
const bootedAt = Date.now();

const disp = () => store('display') || {};
const setDisp = (patch) => store('display', { ...disp(), ...patch });
const eff = () => deps.radar.getDisplay();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const SVGNS = 'http://www.w3.org/2000/svg';

// ---------- rotary knob ----------
const KNOB_SVG = `
<svg viewBox="0 0 100 100" aria-hidden="true">
  <g class="ticks"></g>
  <circle cx="50" cy="50" r="35" fill="#10150f" stroke="#050704" stroke-width="2"/>
  <g class="cap">
    <circle cx="50" cy="50" r="30" fill="url(#kg)" stroke="#0a0d09" stroke-width="1.5"/>
    <circle cx="50" cy="50" r="30" fill="none" stroke="rgba(0,0,0,.55)" stroke-width="3" stroke-dasharray="1.6 2.1"/>
    <circle cx="50" cy="50" r="22" fill="url(#kg2)" stroke="rgba(255,255,255,.1)"/>
    <rect x="48" y="23" width="4" height="17" rx="1.5" fill="#f4ecd2"/>
  </g>
</svg>`;

const DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <radialGradient id="kg" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="#8b9582"/><stop offset=".55" stop-color="#3f4839"/><stop offset="1" stop-color="#1b2119"/></radialGradient>
  <radialGradient id="kg2" cx="40%" cy="35%" r="80%"><stop offset="0" stop-color="#626c5c"/><stop offset="1" stop-color="#2a3027"/></radialGradient>
</defs></svg>`;

function knob(key, label, { get, set, fmt, reset, step = 0.04 }) {
  const wrap = h('div', { class: 'knob-cell' });
  const el = h('div', { class: 'knob', tabindex: '0', role: 'slider', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', title: `${label}: drag up or down, scroll, or use the arrow keys. Double-click to reset.` });
  el.innerHTML = KNOB_SVG;
  const ticks = el.querySelector('.ticks');
  for (let i = 0; i <= 10; i++) {
    const a = (-135 + i * 27) * Math.PI / 180; const big = i % 5 === 0;
    const l = document.createElementNS(SVGNS, 'line');
    l.setAttribute('x1', 50 + Math.sin(a) * 40); l.setAttribute('y1', 50 - Math.cos(a) * 40);
    l.setAttribute('x2', 50 + Math.sin(a) * (big ? 48 : 45)); l.setAttribute('y2', 50 - Math.cos(a) * (big ? 48 : 45));
    l.setAttribute('stroke', '#e2dbbd'); l.setAttribute('stroke-width', big ? 2 : 1.2);
    ticks.append(l);
  }
  const cap = el.querySelector('.cap');
  const out = h('div', { class: 'knob-out' });
  const draw = () => {
    const v = clamp(get(), 0, 1);
    cap.style.transform = `rotate(${-135 + v * 270}deg)`;
    el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
    out.textContent = fmt(v);
  };
  let lastStep = -1;
  const apply = (v) => { set(clamp(v, 0, 1)); draw(); const stp = Math.round(clamp(v, 0, 1) * 25); if (stp !== lastStep) { lastStep = stp; snd.ratchet(); } };
  let startY = 0; let startV = 0; let dragging = false;
  el.addEventListener('pointerdown', (e) => { dragging = true; startY = e.clientY; startV = get(); el.setPointerCapture(e.pointerId); el.classList.add('grab'); e.preventDefault(); });
  el.addEventListener('pointermove', (e) => { if (dragging) apply(startV + (startY - e.clientY) / 180); });
  const end = () => { dragging = false; el.classList.remove('grab'); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', (e) => { e.preventDefault(); apply(get() + (e.deltaY < 0 ? step : -step)); }, { passive: false });
  el.addEventListener('keydown', (e) => {
    const k = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step }[e.key];
    if (k) { e.preventDefault(); e.stopPropagation(); apply(get() + k); }
  });
  el.addEventListener('dblclick', () => { reset(); draw(); });
  wrap.append(el, h('div', { class: 'engrave' }, label), out);
  refs.knobs[key] = { draw };
  draw();
  return wrap;
}

// ---------- detented selector switch (click or scroll to step) ----------
function selector(key, label, options, { get, set }) {
  const n = options.length;
  const ang = (i) => (n === 1 ? 0 : -65 + (130 / (n - 1)) * i);
  const wrap = h('div', { class: 'knob-cell' });
  const el = h('div', { class: 'knob selector', tabindex: '0', role: 'slider', 'aria-label': label, title: `${label}: click or scroll to change` });
  const labels = options.map(([, text], i) => {
    const a = ang(i) * Math.PI / 180;
    return `<text x="${60 + Math.sin(a) * 51}" y="${62 - Math.cos(a) * 51}" font-size="9" text-anchor="middle" fill="#e2dbbd" font-family="Share Tech Mono, monospace">${text}</text>`;
  }).join('');
  const marks = options.map((_, i) => { const a = ang(i) * Math.PI / 180; return `<line x1="${60 + Math.sin(a) * 38}" y1="${60 - Math.cos(a) * 38}" x2="${60 + Math.sin(a) * 43}" y2="${60 - Math.cos(a) * 43}" stroke="#e2dbbd" stroke-width="2"/>`; }).join('');
  el.innerHTML = `<svg viewBox="0 0 120 120" aria-hidden="true">${labels}${marks}
    <circle cx="60" cy="60" r="31" fill="#10150f" stroke="#050704" stroke-width="2"/>
    <g class="cap" style="transform-origin:60px 60px">
      <path d="M60 24 L69 52 Q76 60 69 68 L51 68 Q44 60 51 52 Z" fill="url(#kg)" stroke="#0a0d09" stroke-width="1.5"/>
      <circle cx="60" cy="60" r="19" fill="url(#kg2)" stroke="rgba(255,255,255,.12)"/>
      <rect x="58" y="28" width="4" height="22" rx="1.5" fill="#f4ecd2"/>
    </g></svg>`;
  const cap = el.querySelector('.cap');
  const out = h('div', { class: 'knob-out' });
  const idx = () => Math.max(0, options.findIndex(([v]) => v === get()));
  const draw = () => { cap.style.transform = `rotate(${ang(idx())}deg)`; out.textContent = options[idx()][1]; };
  const go = (d) => { set(options[(idx() + d + n) % n][0]); draw(); snd.clunk(d > 0); };
  el.addEventListener('click', () => go(1));
  el.addEventListener('wheel', (e) => { e.preventDefault(); go(e.deltaY < 0 ? 1 : -1); }, { passive: false });
  el.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowRight', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); go(1); }
    else if (['ArrowDown', 'ArrowLeft'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); go(-1); }
  });
  wrap.append(el, h('div', { class: 'engrave' }, label), out);
  refs.selectors[key] = { draw };
  draw();
  return wrap;
}

// ---------- toggle switch ----------
function toggle(key, label, { get, set }) {
  const btn = h('button', { class: 'toggle', type: 'button', role: 'switch', 'aria-label': label, title: label });
  btn.innerHTML = '<span class="nut"><span class="well"><i class="lever"></i></span></span>';
  const pos = h('div', { class: 'tpos' }, h('span', { class: 'o' }, 'OFF'), h('span', { class: 'i' }, 'ON'));
  const draw = () => { const on = !!get(); btn.classList.toggle('on', on); pos.classList.toggle('lit', on); btn.setAttribute('aria-checked', String(on)); };
  btn.addEventListener('click', () => { snd.clunk(!get()); set(!get()); draw(); });
  refs.toggles[key] = { draw };
  draw();
  return h('div', { class: 'toggle-cell' }, pos, btn, h('div', { class: 'engrave' }, label));
}

// ---------- lit push button (square lens with a legend) ----------
function lbtn(key, legend, color, onClick, lit = null) {
  const b = h('button', { class: `lbtn ${color}`, type: 'button', 'aria-label': legend, onclick: () => { b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 220); snd.clack(); onClick(); } },
    h('span', { class: 'lens' }, legend));
  refs.buttons[key] = { el: b, lit };
  return b;
}

// ---------- lamp with a chrome bezel ----------
function lamp(key, label, color) {
  const l = h('i', { class: `lamp ${color}${key === 'low' || key === 'alert' ? ' steady' : ''}` });
  refs.lamps[key] = l;
  return h('div', { class: 'lamp-cell' }, l, h('div', { class: 'engrave tiny' }, label));
}

// ---------- analog gauge ----------
function gauge(key, label, ends) {
  const wrap = h('div', { class: 'gauge' });
  const ticks = [];
  for (let i = 0; i <= 10; i++) {
    const a = (-60 + i * 12) * Math.PI / 180; const long = i % 5 === 0;
    ticks.push(`<line x1="${60 + Math.sin(a) * 44}" y1="${72 - Math.cos(a) * 44}" x2="${60 + Math.sin(a) * (long ? 36 : 40)}" y2="${72 - Math.cos(a) * (long ? 36 : 40)}" stroke="${i >= 9 ? '#c0452d' : '#2a2a20'}" stroke-width="${long ? 2 : 1.2}"/>`);
  }
  wrap.innerHTML = `<svg viewBox="0 0 120 84" aria-hidden="true">
    <rect x="1" y="1" width="118" height="82" rx="8" fill="#161a14" stroke="#05070a" stroke-width="2"/>
    <rect x="6" y="6" width="108" height="72" rx="4" fill="#ddd7b6"/>
    <rect x="6" y="6" width="108" height="72" rx="4" fill="url(#gl)"/>
    ${ticks.join('')}
    <text x="16" y="30" font-size="8" fill="#2a2a20" font-family="Share Tech Mono, monospace">${ends[0]}</text>
    <text x="104" y="30" font-size="8" text-anchor="end" fill="#2a2a20" font-family="Share Tech Mono, monospace">${ends[1]}</text>
    <text x="60" y="60" font-size="8.5" text-anchor="middle" fill="#2a2a20" font-family="Special Elite, monospace">${label}</text>
    <g class="needle" style="transform-origin:60px 72px"><line x1="60" y1="72" x2="60" y2="30" stroke="#9c2a1c" stroke-width="1.8" stroke-linecap="round"/></g>
    <circle cx="60" cy="72" r="5" fill="#1a1d17"/>
  </svg>`;
  refs.gauges[key] = wrap.querySelector('.needle');
  return wrap;
}

function setNeedle(key, frac) {
  const n = refs.gauges[key];
  if (n) n.style.transform = `rotate(${-60 + clamp(frac, 0, 1) * 120}deg)`;
}

const win = (key, label, small = false) => {
  const v = h('b', {}, '---');
  refs.win[key] = v;
  return h('div', { class: `window${small ? ' small' : ''}` }, h('span', {}, label), v);
};

const grp = (title, ...kids) => h('section', { class: 'grp' }, h('div', { class: 'gt' }, title), ...kids);

// ---------- WW2 easter eggs ----------
const FACTS = [
  ['Opana Point · 0702 · 7 Dec 1941', 'Privates Joseph Lockard and George Elliott, working a mobile SCR-270 radar on Oahu, plot a very large echo to the north, roughly 130 miles out. It was the Japanese carrier strike force. Radar did its job; the warning was not acted on in time.'],
  ['Equipment note', "The SCR-270 was the Army's mobile long-range early-warning radar. Its big bedspring antenna array rode on a truck, and in good conditions it could spot aircraft well over a hundred miles away."],
  ['Angels', "Angels is old RAF slang for altitude in thousands of feet. 'Angels two-five' means 25,000 feet. It is on every contact label on this scope."],
  ['Cavity magnetron', 'Invented in Britain in 1940, the cavity magnetron made small, powerful microwave radar possible. Britain shared the design with the United States that same year, and the MIT Radiation Laboratory went on to develop dozens of radar sets from it.'],
  ['Information center', 'Aircraft Warning Service information centers borrowed heavily from the British plot rooms of the Chain Home system. Radar and observer reports came in by telephone, plotters placed markers on a big map, and controllers decided who to scramble.'],
  ['Ground observers', 'Radar could not see everywhere, so volunteer ground observers across the country watched the skies from posts and phoned in sightings. At the program’s height there were well over a million of them.'],
  ['SCR-584', 'The SCR-584 could track a target automatically and feed a gun director. Paired with the proximity fuze, it was a big reason anti-aircraft guns did so well against V-1 flying bombs over southern England in 1944.'],
  ['Los Angeles · 25 Feb 1942', 'The night after a submarine shelled a California oil field, jittery air defenses fired well over a thousand rounds at an air raid that was most likely a stray weather balloon and a lot of nerves.'],
  ['V for Victory', 'In 1941 the BBC began using the Morse letter V (dit dit dit dah) as a sign of resistance. It matches the opening notes of Beethoven’s Fifth, so that became the signature too. Try tapping it on the key.'],
  ['Black Widow', 'The P-61 Black Widow, the first US night fighter built for the job, carried its own radar so it could hunt by echo in the dark.'],
  ['On watch', 'Plotting rooms ran around the clock. If the scope is quiet, that is the job working: nothing in the sky you need to know about.'],
  ['Reading the echo', 'Operators learned to read their echoes. A steady blip usually meant a single aircraft, and a fat, flickering one often meant a formation.'],
];
const DATE_EGGS = {
  '12-7': ['Pearl Harbor remembrance', '0702 hours. Opana Point radar picks up a large echo to the north. A moment tonight for everyone who served and everyone who stood watch.'],
  '6-6': ['D-Day · 6 June 1944', 'Thousands of Allied aircraft crossed the Channel that day, and every radar and plotter on both sides of it was busy. Honor to those who went.'],
  '11-11': ['Veterans Day', 'Thank you to everyone who has served. The scope is on watch.'],
  '5-8': ['V-E Day · 8 May 1945', 'The guns fall silent in Europe, and the plotters finally get a quiet night.'],
};
const SLOGANS = ['Caution · high voltage', 'Loose lips sink ships', "Keep 'em flying", 'Buy war bonds', 'V for victory', 'We can do it'];
const WARBIRDS = new Set(['B17', 'B25', 'B24', 'B26', 'B29', 'P51', 'P38', 'P40', 'P47', 'P63', 'F4U', 'CORS', 'F6F', 'AT6', 'T6', 'SPIT', 'HURI', 'PBY', 'CATA', 'DC3', 'C47', 'TBM3']);
const MORSE = { '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E', '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I', '.---': 'J', '-.-': 'K', '.-..': 'L', '--': 'M', '-.': 'N', '---': 'O', '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T', '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X', '-.--': 'Y', '--..': 'Z', '.----': '1', '..---': '2', '...--': '3', '....-': '4', '.....': '5', '-....': '6', '--...': '7', '---..': '8', '----.': '9', '-----': '0' };

const CHART_ORDER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
const CODE_OF = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));
const dd = (c) => c.replace(/\./g, '·').replace(/-/g, '−');

/** Close any pop-ups that belong to the console (chart, telegram, flag, air raid) */
export function closeOverlays() {
  for (const id of ['morsechart', 'telegram', 'flag']) $('#' + id)?.remove();
  $('#transmission') && ($('#transmission').hidden = true);
  clearTimeout(telTimer); clearTimeout(flagTimer);
  endRaid();
}

/** Morse cheat sheet: a little card over the scope */
export function morseChart() {
  const old = $('#morsechart');
  if (old) { old.remove(); return; }
  const st = deps.radar.stage;
  const card = h('div', { class: 'morsechart', id: 'morsechart', role: 'dialog', 'aria-label': 'Morse code chart', title: 'Click to close' },
    h('div', { class: 'tg-head' }, h('span', {}, 'Morse code'), h('em', { class: 'stamp' }, 'Chart')),
    h('div', { class: 'mc-grid' }, ...CHART_ORDER.map((c) => h('span', {}, h('b', {}, c === '0' ? 'Ø' : c), h('i', {}, dd(CODE_OF[c]))))),
    h('div', { class: 'mc-foot' }, 'Tap the key: short press = dot, long press = dash. Pause between letters. Try ', h('u', {}, 'V'), ', ', h('u', {}, 'SOS'), ', ', h('u', {}, '73'), ', ', h('u', {}, 'CQ'), ' and ', h('u', {}, 'USA'), '.'));
  card.style.left = `${st ? st.cx : innerWidth / 2}px`; card.style.top = `${st ? st.cy : innerHeight / 2}px`;
  card.addEventListener('click', () => card.remove());
  document.body.append(card);
  snd.clack();
}

const STAR_PTS = (() => { const p = []; for (let r = 0; r < 9; r++) { const n = r % 2 === 0 ? 6 : 5; for (let c = 0; c < n; c++) p.push([r % 2 === 0 ? 1 + c * 2 : 2 + c * 2, r + 1]); } return p; })();
let flagTimer = null;
let raidUntil = 0; let testClicks = 0; let testClickAt = 0;
function endRaid() { raidUntil = 0; document.body.classList.remove('raid'); if (deps?.radar) deps.radar.raid = null; snd.stopSiren?.(); }
/** Seven lamp tests in a row: a huge bomber formation, sirens, every light flashing */
function raid() {
  const dur = 15000; raidUntil = Date.now() + dur; testUntil = raidUntil;
  document.body.classList.add('raid');
  deps.radar.raid = { t0: performance.now(), dur, ang: Math.random() * Math.PI * 2 };
  snd.siren(dur);
  telegram('Air raid warning', 'Large formation inbound, bearing unknown, altitude unknown, count unknown. All stations to alert. (It is only the lamp test button. Probably.)', 'Alert');
  setTimeout(() => { if (Date.now() >= raidUntil - 50) endRaid(); }, dur + 100);
}
/** Old Glory fills the whole screen */
export function flag() {
  const old = $('#flag');
  if (old) old.remove();
  clearTimeout(flagTimer);
  const W = 1235; const Hh = 650; const sh = Hh / 13; const cw = 494; const ch = sh * 7;
  const stripes = Array.from({ length: 13 }, (_, i) => `<rect y="${(i * sh).toFixed(2)}" width="${W}" height="${sh.toFixed(2)}" fill="${i % 2 === 0 ? '#b22234' : '#f5f5f0'}"/>`).join('');
  const star = (cx, cy, R) => { const pts = []; for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5; const rr = k % 2 === 0 ? R : R * 0.382; pts.push(`${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`); } return `<polygon points="${pts.join(' ')}" fill="#fff"/>`; };
  const stars = STAR_PTS.map(([c, r]) => star(c * (cw / 12), r * (ch / 10), 16)).join('');
  const el = h('div', { class: 'flag', id: 'flag', role: 'img', 'aria-label': 'The American flag. Click to close.', title: 'Click to close',
    html: `<svg viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none">${stripes}<rect width="${cw}" height="${ch.toFixed(2)}" fill="#3c3b6e"/>${stars}</svg><div class="sheen"></div><div class="cap">The Stars and Stripes</div>` });
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 700); clearTimeout(flagTimer); };
  el.addEventListener('click', close);
  document.body.append(el);
  snd.bugle();
  flagTimer = setTimeout(close, 9000);
}

let telTimer = null; let lastFact = -1; let chaseUntil = 0; let sosUntil = 0; let lastFoo = 0;
const seenWarbirds = new Set();

/** A typed telegram over the scope. Click it to dismiss. */
export function telegram(head, text, stamp = 'Flash') {
  let el = $('#telegram');
  if (!el) { el = h('div', { id: 'telegram', class: 'telegram', role: 'status' }); document.body.append(el); el.addEventListener('click', () => { el.hidden = true; clearInterval(telTimer); }); }
  const st = deps?.radar?.stage;
  if (st) { el.style.left = `${st.cx}px`; el.style.top = `${st.cy - st.R * 0.62}px`; el.style.width = `${Math.min(520, st.R * 1.15)}px`; }
  const body = h('p', {}, '');
  el.replaceChildren(h('div', { class: 'tg-head' }, h('span', {}, 'Aircraft Warning Service'), h('i', { class: 'stamp' }, stamp)), h('div', { class: 'tg-sub' }, head), body);
  el.hidden = false;
  clearInterval(telTimer);
  snd.teleprinter(text.length);
  let i = 0;
  telTimer = setInterval(() => {
    i += 2; body.textContent = text.slice(0, i);
    if (i >= text.length) { clearInterval(telTimer); snd.bell(); telTimer = setTimeout(() => { el.hidden = true; }, 9000 + text.length * 25); }
  }, 30);
}

function fact() {
  let i; do { i = Math.floor(Math.random() * FACTS.length); } while (FACTS.length > 1 && i === lastFact);
  lastFact = i;
  telegram(FACTS[i][0], FACTS[i][1], 'History');
}

export function consoleFoo() {
  const now = Date.now();
  if (now - lastFoo < 6000) return;
  lastFoo = now;
  telegram('Unidentified contact', 'Foo fighters: glowing balls of light that Allied aircrews reported pacing their aircraft over Europe and the Pacific in 1944 and 1945. Nobody ever settled on an explanation. Whatever that was, it is gone now.', 'Unknown');
}

/** A telegraph key. Tap dots and dashes; try V, SOS, 73 or CQ. */
function morseBay() {
  const out = h('b', {}, '');
  const winEl = h('div', { class: 'window small morse' }, h('span', {}, 'Key'), out);
  const key = h('button', { class: 'morse-key', type: 'button', 'aria-label': 'Telegraph key. Tap dots and dashes. Try V, or S O S.', title: 'Telegraph key: tap dots and dashes (V, SOS, 73, CQ)' },
    h('i', { class: 'base' }), h('i', { class: 'arm' }), h('i', { class: 'knob2' }), h('i', { class: 'contact' }));
  let downAt = 0; let buf = ''; let text = ''; let letterTimer; let clearTimer;
  const show = () => { out.textContent = `${text}${buf ? ' ' + buf.replace(/\./g, '·').replace(/-/g, '−') : ''}`.trim().slice(-14) || ''; };
  const eggs = () => {
    if (text.endsWith('SOS')) { text = ''; sosUntil = Date.now() + 6000; snd.morse('...---...'); telegram('S O S', 'Distress call received. Stand by. All stations clear the frequency. (Nobody is actually in trouble. The scope is fine.)', 'Priority'); }
    else if (text === 'V') { chaseUntil = Date.now() + 4000; snd.morse('...-'); telegram('V for victory', 'Dit dit dit dah. The BBC used it from 1941, and so did resistance movements across occupied Europe.', 'Victory'); }
    else if (text.endsWith('USA')) { text = ''; flag(); }
    else if (text.endsWith('73')) { text = ''; telegram('73', 'Best regards, and good DX. Fair winds and clear skies.', 'Greetings'); }
    else if (text.endsWith('CQ')) { text = ''; telegram('CQ', 'Calling any station. Nobody is on frequency, but the scope heard you.', 'Calling'); }
  };
  const commit = () => { const ch = MORSE[buf] || '?'; buf = ''; text = (text + ch).slice(-14); show(); eggs(); clearTimeout(clearTimer); clearTimer = setTimeout(() => { text = ''; show(); }, 5000); };
  const press = () => { if (downAt) return; downAt = performance.now(); key.classList.add('down'); snd.keyDown(); clearTimeout(letterTimer); };
  const release = () => { if (!downAt) return; const d = performance.now() - downAt; downAt = 0; key.classList.remove('down'); snd.keyUp(); if (buf.length < 6) buf += d < 220 ? '.' : '-'; show(); letterTimer = setTimeout(commit, 800); };
  key.addEventListener('pointerdown', (e) => { key.setPointerCapture(e.pointerId); press(); e.preventDefault(); });
  key.addEventListener('pointerup', release); key.addEventListener('pointercancel', release);
  key.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); e.stopPropagation(); press(); } });
  key.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); release(); } });
  const help = h('button', { class: 'mc-btn', type: 'button', title: 'Morse code chart', 'aria-label': 'Show Morse code chart', onclick: morseChart }, '?');
  return h('div', { class: 'keybay' }, key, winEl, help);
}

// ---------- build ----------
export function initConsole(d) {
  deps = d;
  const { radar, openPanelBtn } = d;
  root = $('#console');
  root.innerHTML = '';
  root.append(h('div', { html: DEFS + '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><linearGradient id="gl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient></defs></svg>' }));
  const maxRange = () => Math.max(5, (radar.radiusNm || 40) * 1.2);
  const rangeNow = () => radar.rangeNm || radar.radiusNm || 40;
  const rangeToV = (nm) => Math.log(nm / 2) / Math.log(maxRange() / 2);
  const dget = (k, d) => () => eff()[k] ?? d;

  const left = h('aside', { class: 'cpanel left', 'aria-label': 'Receiver controls' },
    h('div', { class: 'plate title' }, h('b', {}, 'SKYWATCH'), (refs.sub = h('i', {}, 'Aircraft warning service'))),
    h('div', { class: 'knob-grid' },
      knob('range', 'Range', {
        get: () => rangeToV(rangeNow()),
        set: (v) => { radar.rangeNm = 2 * Math.pow(maxRange() / 2, v); store('range', radar.rangeNm); },
        fmt: () => `${Math.round(rangeNow())} nm`, reset: () => { radar.rangeNm = null; store('range', null); }, step: 0.03,
      }),
      knob('sweep', 'Sweep', {
        get: () => (15 - (eff().sweepSeconds || 8)) / 12, set: (v) => setDisp({ sweepSeconds: +(15 - v * 12).toFixed(1) }),
        fmt: () => `${(eff().sweepSeconds || 8).toFixed(0)} s`, reset: () => setDisp({ sweepSeconds: 8 }),
      }),
      knob('bright', 'Bright', {
        get: () => (dget('brightness', 1)() - 0.3) / 1.2, set: (v) => setDisp({ brightness: +(0.3 + v * 1.2).toFixed(2) }),
        fmt: () => `${Math.round(dget('brightness', 1)() * 100)}%`, reset: () => setDisp({ brightness: 1 }),
      }),
      knob('gain', 'Gain', {
        get: () => dget('gain', 1)() / 2, set: (v) => setDisp({ gain: +(v * 2).toFixed(2) }),
        fmt: () => `${Math.round(dget('gain', 1)() * 100)}%`, reset: () => setDisp({ gain: 1 }),
      }),
      knob('persist', 'Persist', {
        get: () => (dget('persist', 1)() - 0.4) / 2.1, set: (v) => setDisp({ persist: +(0.4 + v * 2.1).toFixed(2) }),
        fmt: () => `${dget('persist', 1)().toFixed(1)}x`, reset: () => setDisp({ persist: 1 }),
      }),
      selector('phos', 'Phosphor', [['green', 'P1'], ['amber', 'P12'], ['blue', 'P7'], ['white', 'P4']], { get: dget('phosphor', 'green'), set: (v) => setDisp({ phosphor: v }) }),
      selector('gate', 'Gate', [['all', 'ALL'], ['high', 'HI'], ['low', 'LO'], ['mil', 'MIL']], { get: dget('gate', 'all'), set: (v) => setDisp({ gate: v }) }),
      h('div', { class: 'knob-cell' }, h('div', { class: 'counter', id: 'hours', role: 'button', title: 'Hours on watch', onclick: fact }, '000.0'), h('div', { class: 'engrave' }, 'Run hrs'))),
    grp('Display',
      h('div', { class: 'toggles' },
        toggle('labels', 'Labels', { get: () => eff().labels !== false, set: (v) => setDisp({ labels: v }) }),
        toggle('trails', 'Trails', { get: () => eff().trails !== false, set: (v) => setDisp({ trails: v }) }),
        toggle('heat', 'Heat', { get: () => !!eff().heatOverlay, set: (v) => setDisp({ heatOverlay: v }) }),
        toggle('rings', 'Rings', { get: () => eff().rings !== false, set: (v) => setDisp({ rings: v }) }),
        toggle('spokes', 'Spokes', { get: () => eff().spokes !== false, set: (v) => setDisp({ spokes: v }) }),
        toggle('beam', 'Beam', { get: () => eff().beam !== false, set: (v) => setDisp({ beam: v }) }))),
    grp('Status',
      h('div', { class: 'lamps' },
        lamp('power', 'Power', 'g'), lamp('data', 'Data', 'g'), lamp('link', 'Link', 'g'), lamp('quota', 'Quota', 'g'), lamp('low', 'Low', 'r'), lamp('idle', 'Idle', 'a'),
        lamp('quiet', 'Quiet', 'a'), lamp('paused', 'Paused', 'a'), lamp('alert', 'Alert', 'r'), lamp('emerg', 'Emerg', 'r'), lamp('mil', 'Mil', 'a'), lamp('helo', 'Helo', 'a'),
        lamp('gnd', 'Gnd', 'a'), lamp('heavy', 'Heavy', 'a'), lamp('warbird', 'Warbird', 'g'), lamp('unid', 'Unid', 'a'), lamp('gps', 'GPS', 'a'), lamp('night', 'Night', 'a'))),
    grp('Azimuth', h('div', { class: 'azimuth' },
      h('div', { class: 'dial', 'aria-hidden': 'true', html: '<i class="ring"></i><b class="n">N</b><b class="e">E</b><b class="s">S</b><b class="w">W</b><i class="hand"></i><i class="hub"></i>' }),
      h('div', { class: 'az-wins' }, win('brg', 'Beam brg'), win('rng', 'Range', true)))),
    h('div', { class: 'jacks', 'aria-hidden': 'true' },
      ...['red', 'black', 'red', 'black'].map((c) => h('i', { class: `post ${c}` })),
      ...[0, 1, 2].map(() => h('i', { class: 'fuse' }))),
    morseBay(),
    h('div', { class: 'grille', 'aria-hidden': 'true' }),
    (() => { let n = 0; const pl = h('div', { class: 'plate stripe', role: 'button', tabindex: '0', title: 'Click for another slogan' }, h('span', {}, SLOGANS[0])); const next = () => { n = (n + 1) % SLOGANS.length; pl.firstChild.textContent = SLOGANS[n]; pl.classList.toggle('stripe', n === 0); pl.classList.toggle('slogan', n !== 0); snd.clack(); }; pl.addEventListener('click', next); pl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); next(); } }); return pl; })());

  const panelBtn = (key, legend, color, panel) => lbtn(key, legend, color, () => openPanelBtn(panel),
    () => !$('#drawer').hidden && !!document.querySelector(`.tb[data-panel=${panel}]`)?.classList.contains('on'));
  const right = h('aside', { class: 'cpanel right', 'aria-label': 'Display controls' },
    h('div', { class: 'plate click', role: 'button', tabindex: '0', title: 'Click for a bit of history', onclick: fact, onkeydown: (e) => { if (e.key === 'Enter') fact(); } }, 'Plot board'),
    h('div', { class: 'windows one' }, win('clock', 'Local time'), win('date', 'Date · Zulu', true)),
    h('div', { class: 'windows' }, win('contacts', 'Contacts'), win('today', 'Calls today'), win('near', 'Nearest', true), win('high', 'Highest', true)),
    h('div', { class: 'windows' }, win('link', 'Next data', true), win('left', 'Calls left', true)),
    grp('Meters', h('div', { class: 'gauges' }, gauge('quota', 'CALLS', ['E', 'F']), gauge('next', 'NEXT', ['0', 'MAX']), gauge('traffic', 'TRAFFIC', ['0', '30']))),
    grp('Controls',
      h('div', { class: 'lbtns' },
        panelBtn('log', 'Log', 'g', 'log'), panelBtn('stats', 'Stats', 'g', 'stats'), panelBtn('alerts', 'Alerts', 'r', 'alerts'),
        panelBtn('watch', 'Watch', 'a', 'watch'), panelBtn('settings', 'Setup', 'a', 'settings'), lbtn('theme', 'Style', 'g', () => $('#themeBtn').click()),
        lbtn('zout', 'Zoom −', 'a', () => { $('#zoomOut').click(); refs.knobs.range.draw(); }), lbtn('zin', 'Zoom +', 'a', () => { $('#zoomIn').click(); refs.knobs.range.draw(); }),
        lbtn('full', 'Full', 'g', () => $('#fullBtn').click(), () => !!document.fullscreenElement),
        lbtn('night', 'Night', 'a', () => { setDisp({ night: !disp().night }); applyNight(); }, () => !!disp().night),
        lbtn('test', 'Lamp test', 'r', () => { const t = Date.now(); testClicks = t - testClickAt < 3000 ? testClicks + 1 : 1; testClickAt = t; if (testClicks >= 7) { testClicks = 0; raid(); return; } testUntil = t + 2500; snd.lampBuzz(); }, () => Date.now() < testUntil),
        lbtn('ack', 'Ack', 'r', () => { ackUntil = Date.now() + 10 * 60000; deps.app.unseenAlerts = 0; $('#alertBadge').hidden = true; }, () => alarmActive() && Date.now() > ackUntil))),
    grp('Altitude', h('div', { class: 'ledbars', id: 'ledbars' }, ...['GND', '<5K', '<10K', '<20K', '<30K', '30K+'].map((l) => h('div', { class: 'ledcol' },
      h('div', { class: 'leds' }, ...Array.from({ length: 8 }, (_, i) => h('i', { class: `led ${i < 5 ? 'g' : i < 7 ? 'a' : 'r'}` }))), h('div', { class: 'engrave tiny' }, l))))),
    h('div', { class: 'keyplate' }, h('div', { class: 'kt' }, 'Key bindings'), h('div', { class: 'kgrid' },
      ...[['T', 'Style'], ['F', 'Full screen'], ['+ −', 'Zoom'], ['L', 'Log'], ['S', 'Stats'], ['A', 'Alerts'], ['W', 'Watchlist'], [',', 'Setup'], ['Esc', 'Close']]
        .map(([k, t]) => h('span', {}, h('kbd', {}, k), t)))),
    h('a', { class: 'plate small serial', href: 'https://wingbits.com', target: '_blank', rel: 'noopener noreferrer', title: 'Aircraft data from the Wingbits network' }, 'Data · Wingbits'));

  root.append(left, right);
  window.addEventListener('resize', layoutConsole);
  layoutConsole();
  applyNight();
  setInterval(updateConsole, 200);
  // anniversary messages, once per session
  try {
    const d = new Date(); const egg = DATE_EGGS[`${d.getMonth() + 1}-${d.getDate()}`];
    if (egg && !sessionStorage.getItem('skywatch:dateegg')) { sessionStorage.setItem('skywatch:dateegg', '1'); setTimeout(() => { if (!root.hidden) telegram(egg[0], egg[1], 'Remembrance'); }, 6000); }
  } catch { /* no session storage */ }
}

const rangeNowAbs = () => deps.radar.rangeNm || deps.radar.radiusNm || 40;
const alarmActive = () => !!deps.app.snapshot?.aircraft?.some((a) => ['7500', '7600', '7700'].includes(a.sq));

function applyNight() { document.body.classList.toggle('console-night', !!disp().night && document.body.classList.contains('console-on')); }

/** Show the console (WW2 view on a landscape screen) and tell the radar where the scope sits */
export function layoutConsole() {
  if (!root) return;
  const W = window.innerWidth; const H = window.innerHeight;
  const top = 26; const bot = 14; const sideMin = 290;
  const R = Math.floor(Math.min(H / 2 - 100, W / 2 - 90 - 12 - sideMin));
  const on = deps.currentTheme() === 'ww2' && W >= 1000 && H >= 620 && W / H >= 1.3 && R >= 150;
  document.body.classList.toggle('console-on', on);
  document.body.classList.toggle('console-compact', H < 900);
  root.hidden = !on;
  if (!on) { if (deps.radar.stage) deps.radar.setStage(null); closeOverlays(); applyNight(); return; }
  const cx = W / 2; const cy = H / 2;
  const side = Math.floor(cx - (R + 90) - 12);
  root.style.setProperty('--side', `${side}px`);
  root.style.setProperty('--ctop', `${top}px`);
  root.style.setProperty('--cbot', `${bot}px`);
  document.documentElement.style.setProperty('--ctop', `${top}px`);
  document.documentElement.style.setProperty('--cbot', `${bot}px`);
  deps.radar.setStage({ cx, cy, R, top, bot, side });
  applyNight();
  refreshControls();
}

function refreshControls() {
  for (const k of Object.values(refs.knobs)) k.draw();
  for (const t of Object.values(refs.toggles)) t.draw();
  for (const s of Object.values(refs.selectors)) s.draw();
}

/** The server sent fresh data: blink the DATA lamp */
export function consoleData() { lastData = performance.now(); }

export function updateConsole() {
  if (!root || root.hidden) return;
  const st = deps.app.status; const snap = deps.app.snapshot;
  const nowMs = Date.now(); const now = performance.now();
  const test = nowMs < testUntil;
  const list = snap?.aircraft || [];
  const L = refs.lamps;
  const state = st?.budget?.state;
  const pct = st?.plan?.monthlyLimit ? st.plan.monthlyRemaining / st.plan.monthlyLimit : 1;
  const emerg = alarmActive(); const acked = nowMs < ackUntil;
  const set = (k, on) => L[k].classList.toggle('on', test || on);
  set('power', true);
  set('data', now - lastData < 1800);
  set('link', !deps.app.linkDown);
  set('quota', pct >= 0.1);
  set('low', pct < 0.1);
  set('idle', state === 'idle');
  set('quiet', state === 'quiet');
  set('paused', state === 'paused');
  set('alert', (deps.app.unseenAlerts || 0) > 0 || !!st?.error);
  set('emerg', emerg);
  set('mil', list.some((a) => a.d?.mil));
  set('helo', list.some((a) => ['A7'].includes(a.c)));
  set('gnd', list.some((a) => a.og));
  set('heavy', list.some((a) => a.c === 'A5'));
  const bird = list.find((a) => WARBIRDS.has(String(a.d?.type || '').toUpperCase()));
  set('warbird', !!bird);
  if (bird && !seenWarbirds.has(bird.h)) { seenWarbirds.add(bird.h); snd.engine(); telegram(`Warbird on the scope · ${String(bird.d.type).toUpperCase()}`, `${bird.f || bird.h} is flying history. Keep an ear out for a radial engine.`, 'Warbird'); }
  set('unid', !!deps.radar.foo);
  set('gps', !!deps.radar.gps?.cells?.length);
  set('night', !!disp().night);
  if (nowMs < chaseUntil) { const keys = Object.keys(L); const k = Math.floor(nowMs / 200) % keys.length; keys.forEach((n, i) => L[n].classList.toggle('on', i === k || i === (k + 1) % keys.length)); }
  if (nowMs < sosUntil) { const on = Math.floor(nowMs / 400) % 2 === 0; ['emerg', 'alert'].forEach((n) => L[n].classList.toggle('on', on)); }
  L.emerg.classList.toggle('steady', acked); L.alert.classList.toggle('steady', acked);
  { const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
    refs.win.clock.textContent = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    refs.win.date.textContent = `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}Z`.toUpperCase();
    const b = st?.budget || {}; const next = st?.nextPollAt ? Math.max(0, (st.nextPollAt - nowMs) / 1000) : null;
    const tag = { idle: 'IDLE ', quiet: 'QUIET ', paused: 'PAUSED ' }[b.state] || '';
    refs.win.link.textContent = st?.needsHome ? 'SET HOME' : st?.error ? 'LINK FAULT' : b.state === 'paused' ? 'PAUSED' : next !== null ? `${tag}${fmtDur(next)}`.toUpperCase() : '---';
    refs.win.left.textContent = st?.plan ? `${fmtNum(st.plan.monthlyRemaining)}` : '---';
    const sub = $('#brandSub')?.textContent; if (sub && refs.sub.textContent !== sub) refs.sub.textContent = sub; }
  refs.win.contacts.textContent = test ? '888' : String(list.length).padStart(3, '0');
  refs.win.today.textContent = test ? '888' : st?.today ? fmtNum(st.today.total) : '---';
  const c = deps.radar.center;
  if (test) { refs.win.near.textContent = '88888888'; refs.win.high.textContent = '88888888'; }
  else if (c && list.length) {
    const dist = (a) => Math.hypot((a.lo - c.lon) * 60 * Math.cos(c.lat * Math.PI / 180), (a.la - c.lat) * 60);
    const near = list.reduce((m, a) => (dist(a) < dist(m) ? a : m));
    const airborne = list.filter((a) => !a.og && a.ab != null);
    const high = airborne.length ? airborne.reduce((m, a) => (a.ab > m.ab ? a : m)) : null;
    const name = (a) => String(a.f || a.h).toUpperCase().slice(0, 8);
    refs.win.near.textContent = `${name(near)} ${dist(near).toFixed(1)}`;
    refs.win.high.textContent = high ? `${name(high)} FL${String(Math.round(high.ab / 100)).padStart(3, '0')}` : '---';
  } else { refs.win.near.textContent = '---'; refs.win.high.textContent = '---'; }
  // altitude LED bar graph
  const bands = [0, 0, 0, 0, 0, 0];
  for (const a of list) { const ab = a.ab; const i = a.og ? 0 : ab == null ? 1 : ab < 5000 ? 1 : ab < 10000 ? 2 : ab < 20000 ? 3 : ab < 30000 ? 4 : 5; bands[i]++; }
  const scale = Math.max(6, ...bands);
  $('#ledbars').querySelectorAll('.ledcol').forEach((col, i) => {
    const lit = test ? 8 : Math.round((bands[i] / scale) * 8);
    col.querySelectorAll('.led').forEach((led, k) => led.classList.toggle('on', 7 - k < lit));
  });
  // azimuth dial follows the sweep beam
  const period = (eff().sweepSeconds || 8);
  const hand = root.querySelector('.dial .hand');
  if (hand && hand.dataset.period !== String(period)) {
    hand.dataset.period = String(period);
    hand.style.animation = 'none'; void hand.offsetWidth;
    hand.style.animation = `spin ${period}s linear infinite`;
    hand.style.animationDelay = `-${(performance.now() % (period * 1000)) / 1000}s`;
  }
  refs.win.brg.textContent = test ? '888' : String(Math.floor(((performance.now() % (period * 1000)) / (period * 1000)) * 360)).padStart(3, '0');
  refs.win.rng.textContent = test ? '888' : `${Math.round(rangeNowAbs())} NM`;
  setNeedle('quota', test ? 1 : pct);
  const iv = st?.budget?.intervalSec;
  if (st?.nextPollAt && iv) setNeedle('next', Math.min(1, Math.max(0, (st.nextPollAt - nowMs) / 1000 / iv)));
  setNeedle('traffic', test ? 1 : Math.min(1, list.length / 30));
  const hrs = (nowMs - bootedAt) / 3600000;
  $('#hours').textContent = (hrs >= 1000 ? 999.9 : hrs).toFixed(1).padStart(5, '0');
  for (const b of Object.values(refs.buttons)) b.el.classList.toggle('lit', test || !!b.lit?.());
  refs.knobs.range.draw(); // follows mouse-wheel zoom on the scope
}
