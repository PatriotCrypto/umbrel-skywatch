import { Radar } from './radar.js';
import { THEME_META, RARITY_COLORS } from './themes.js';
import { $, h, api, store, fmtAlt, fmtDist, fmtNum, fmtDur, fmtAgo, fmtWhen, cardinal, label } from './util.js';
import { openPanel, refreshPanel, currentPanel, loadHeat } from './panels.js';

export const app = {
  settings: null, status: null, snapshot: null, ruleTypes: {}, categories: {}, version: '',
  wingnauts: [], unseenAlerts: 0, selected: null, track: null,
};

const viewerId = store('viewer') || Math.random().toString(36).slice(2, 12);
store('viewer', viewerId);

const radar = new Radar($('#radar'), {
  onSelect: (hit) => {
    if (hit?.flyby) return showOperatorCard();
    select(hit?.hex || null);
  },
  getDisplay: () => ({ ...(app.settings?.display || {}), ...(store('display') || {}) }),
});
app.radar = radar;
window.skywatch = app; // handy for debugging in the browser console

// ---------- boot ----------
async function boot() {
  const s = await api('api/state');
  app.settings = s.settings; app.status = s.status; app.version = s.version;
  app.ruleTypes = s.ruleTypes; app.categories = s.categories;
  applyTheme(currentTheme());
  const saved = store('range');
  if (saved) radar.rangeNm = saved;
  connect();
  presence();
  setInterval(presence, 20000);
  document.addEventListener('visibilitychange', presence);
  setInterval(renderHud, 1000);
  renderHud();
  loadOperator();
  loadHeat().catch(() => {});
  if (needsSetup() && !store('welcomed')) { store('welcomed', true); openPanel('settings', { welcome: true }); }
}

function needsSetup() {
  const s = app.settings;
  return !s.apiKey.set || s.home.lat === null;
}

// ---------- live data ----------
let es;
function connect() {
  es = new EventSource('api/stream');
  es.addEventListener('snapshot', (e) => {
    const p = JSON.parse(e.data);
    app.snapshot = p;
    radar.setData(p);
    if (app.selected) renderCard();
    if (currentPanel() === 'watch') refreshPanel();
  });
  es.addEventListener('status', (e) => { app.status = JSON.parse(e.data); renderHud(); });
  es.addEventListener('gps', (e) => { radar.gps = JSON.parse(e.data); });
  es.addEventListener('watch', () => { if (currentPanel() === 'watch') refreshPanel(); });
  es.addEventListener('alert', (e) => onAlert(JSON.parse(e.data)));
  es.onopen = () => banner(null);
  es.onerror = () => banner('Lost connection to the radar. Reconnecting…');
}

function presence() {
  const visible = document.visibilityState === 'visible';
  fetch('api/presence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: viewerId, visible }), keepalive: true }).catch(() => {});
}

// ---------- theme ----------
export function currentTheme() { return store('theme') || app.settings?.display.theme || 'ww2'; }

export function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  radar.setTheme(name);
  const meta = THEME_META[name];
  $('#brandTitle').textContent = meta.brand;
  document.querySelector('meta[name=theme-color]').setAttribute('content', meta.swatch[0]);
  renderHud();
}

export function setTheme(name, persist = true) {
  if (persist) store('theme', name);
  applyTheme(name);
}

function cycleTheme() {
  const names = Object.keys(THEME_META);
  setTheme(names[(names.indexOf(currentTheme()) + 1) % names.length]);
  toast({ title: THEME_META[currentTheme()].title, message: THEME_META[currentTheme()].sub });
}

// ---------- HUD ----------
function renderHud() {
  const st = app.status;
  const s = app.settings;
  if (!st || !s) return;
  const meta = THEME_META[currentTheme()];
  const units = s.display.units;
  const home = s.home.label || 'Home';
  $('#brandSub').textContent = st.demo ? `${meta.tagline} · demo traffic` : `${meta.tagline} · ${home}`;

  const now = new Date();
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const z = `${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}Z`;
  const count = app.snapshot?.aircraft?.length ?? 0;
  $('#readout').innerHTML = `<b>${clock}</b> · ${z}<br><b>${count}</b> contacts · ${fmtDist(st.radiusNm, units, 0)} radius`;

  const b = st.budget || {};
  const parts = [];
  if (st.error) parts.push(`<span class="err">${st.error.message}</span>`);
  if (st.needsHome) parts.push('<span class="warn">Set your home location in Settings to start the radar</span>');
  const next = st.nextPollAt ? Math.max(0, (st.nextPollAt - Date.now()) / 1000) : null;
  const stateLabel = { watched: 'Live', idle: 'Idle (nobody watching)', quiet: 'Quiet hours', paused: 'Paused' }[b.state] || 'Starting';
  if (b.state === 'paused' && b.reason) parts.push(`<span class="warn">${b.reason}</span>`);
  else if (next !== null) parts.push(`${stateLabel} · next data in <b>${fmtDur(next)}</b> · every ${fmtDur(b.intervalSec)}`);
  if (st.plan) {
    const pctUsed = st.plan.monthlyLimit ? (st.plan.monthlyUsed / st.plan.monthlyLimit) * 100 : 0;
    const proj = st.plan.monthlyLimit ? Math.min(100, ((b.projectedAppTotal + (st.plan.monthlyUsed - st.appUsed)) / st.plan.monthlyLimit) * 100) : 0;
    parts.push(`<span class="meter" title="Used this month, with a marker at the projected month-end total"><i style="width:${pctUsed.toFixed(1)}%"></i><i class="proj" style="width:${proj.toFixed(1)}%"></i></span>`);
    parts.push(`${st.demo ? 'Demo quota' : st.plan.name || 'Plan'} · <b>${fmtNum(st.plan.monthlyRemaining)}</b> of ${fmtNum(st.plan.monthlyLimit)} calls left · ${fmtNum(st.today.total)} today`);
  }
  $('#budgetHud').innerHTML = parts.join('<br>');
}

// ---------- selection + aircraft card ----------
function select(hex) {
  if (app.selected !== hex) { app.track = null; radar.track = null; }
  app.selected = hex;
  radar.selected = hex;
  renderCard();
}
app.select = select;

function findLive(hex) { return app.snapshot?.aircraft.find((a) => a.h === hex) || null; }

async function renderCard() {
  const card = $('#card');
  const hex = app.selected;
  if (!hex) { card.hidden = true; return; }
  const a = findLive(hex);
  const units = app.settings.display.units;
  card.hidden = false;
  if (!a) {
    card.replaceChildren(h('button', { class: 'icon-btn close', onclick: () => select(null), 'aria-label': 'Close' }, '✕'),
      h('h3', {}, hex.toUpperCase()), h('div', { class: 'sub' }, 'Out of radar range now.'));
    return;
  }
  const d = a.d || {};
  const title = label(a);
  const what = d.model ? `${d.manufacturer ? d.manufacturer + ' ' : ''}${d.model}` : app.categories[a.c] || 'Aircraft';
  const subtitle = [what, d.operator].filter(Boolean).join(' · ');
  const live = radar.aircraft.get(hex);
  const pos = live?.pos;
  const distNm = pos ? Math.hypot(pos.x, pos.y) : a.dist;
  const brg = pos ? ((Math.atan2(pos.x, pos.y) * 180) / Math.PI + 360) % 360 : a.brg;
  const tags = [];
  if (a.emergency) tags.push(h('span', { class: 'tag emg' }, `${a.sq} ${a.emergency}`));
  if (d.mil) tags.push(h('span', { class: 'tag mil' }, 'Military'));
  if (a.rare && !d.mil) tags.push(h('span', { class: 'tag rare' }, 'Rare'));
  if (d.privacy) tags.push(h('span', { class: 'tag priv', title: 'Owner enrolled in an FAA privacy program; registration hidden' }, 'Privacy'));
  if (a.t === 'MLAT') tags.push(h('span', { class: 'tag', title: 'Position from multilateration, less precise than ADS-B' }, 'MLAT'));

  const trackBtn = h('button', { class: 'btn ghost', onclick: loadTrack }, app.track ? 'Track loaded' : 'Load full track (1 API call)');
  if (app.track) trackBtn.disabled = true;
  card.replaceChildren(...[
    h('button', { class: 'icon-btn close', onclick: () => select(null), 'aria-label': 'Close' }, '✕'),
    h('h3', {}, title, ...tags),
    h('div', { class: 'sub' }, subtitle || ' '),
    h('div', { class: 'grid' },
      h('div', {}, h('b', {}, fmtAlt(a.ab, a.og)), h('span', {}, 'Altitude')),
      h('div', {}, h('b', {}, a.gs ? `${Math.round(a.gs)} kt` : '—'), h('span', {}, 'Ground speed')),
      h('div', {}, h('b', {}, a.th != null ? `${String(Math.round(pos?.hdg ?? a.th)).padStart(3, '0')}°` : '—'), h('span', {}, 'Heading')),
      h('div', {}, h('b', {}, fmtDist(distNm, units)), h('span', {}, `${brg != null ? cardinal(brg) : ''} of home`)),
      h('div', {}, h('b', {}, a.sq || '—'), h('span', {}, 'Squawk')),
      h('div', {}, h('b', {}, d.type || a.c || '—'), h('span', {}, 'Type')),
    ),
    h('dl', { class: 'kv' },
      h('dt', {}, 'ICAO hex'), h('dd', {}, a.h.toUpperCase()),
      d.reg ? h('dt', {}, 'Registration') : null, d.reg ? h('dd', {}, d.reg) : null,
      d.built ? h('dt', {}, 'Built') : null, d.built ? h('dd', {}, d.built) : null,
      h('dt', {}, 'Last report'), h('dd', {}, `${Math.max(0, Math.round((Date.now() + radar.clockOffset - a.ra) / 1000))} s ago`),
    ),
    a.emergency ? h('div', { class: 'emg' }, `Squawking ${a.sq}: ${a.emergency}`) : null,
    h('div', { class: 'actions' }, trackBtn,
      h('button', { class: 'btn ghost', onclick: () => openPanel('log', { hex: a.h }) }, 'History')),
  ].filter(Boolean));
}

async function loadTrack() {
  const hex = app.selected;
  try {
    const r = await api(`api/aircraft/${hex}/track`, { method: 'POST' });
    if (!r.points.length) { toast({ title: 'No track available', message: r.message || 'Wingbits returned no points.' }); return; }
    app.track = r.points; radar.track = r.points; renderCard();
  } catch (err) { toast({ title: 'Could not load track', message: err.message }); }
}

// ---------- alerts ----------
function onAlert(a) {
  const emg = a.kind === 'emergency';
  toast({ title: a.title, message: a.message, emg, hex: a.hex });
  if (currentPanel() !== 'alerts') {
    app.unseenAlerts++;
    const b = $('#alertBadge'); b.hidden = false; b.textContent = String(app.unseenAlerts);
  } else refreshPanel();
  if (currentTheme() === 'omniverse' && app.operator && (a.kind === 'newtype' || a.kind === 'military')) {
    transmit(a.kind === 'newtype' ? 'New type logged. Adding it to the archive.' : 'Military traffic on the scope. Keep an eye on it.');
  }
}
export function clearAlertBadge() { app.unseenAlerts = 0; $('#alertBadge').hidden = true; }

export function toast({ title, message, emg = false, hex = null, ms = 7000 }) {
  const el = h('div', { class: `toast${emg ? ' emg' : ''}`, role: 'status', onclick: () => { if (hex) select(hex); el.remove(); } }, h('b', {}, title), message || '');
  $('#toasts').prepend(el);
  while ($('#toasts').children.length > 4) $('#toasts').lastChild.remove();
  setTimeout(() => el.remove(), emg ? ms * 3 : ms);
}

function banner(text) {
  const b = $('#banner');
  if (!text) { b.hidden = true; return; }
  b.textContent = text; b.hidden = false;
}

// ---------- Wingnauts ----------
export async function loadOperator() {
  try {
    const c = await api('api/wingnauts');
    app.wingnauts = c.items || [];
  } catch { app.wingnauts = []; }
  const chosen = app.settings.wingnauts.operator;
  const it = app.wingnauts.find((x) => x.id === chosen) || app.wingnauts[0];
  if (!it) { app.operator = null; radar.operator = null; return; }
  const img = new Image();
  if (it.local) img.src = `api/wingnauts/img/${encodeURIComponent(it.id)}`;
  app.operator = { ...it, img, rarityColor: RARITY_COLORS[String(it.rarity || '').toLowerCase()] || RARITY_COLORS.common };
  radar.operator = app.operator;
}

function showOperatorCard() {
  const op = app.operator;
  if (!op) return;
  transmit(`${op.name} reporting. All quiet on this sector… mostly.`);
}

let transTimer;
function transmit(text) {
  const op = app.operator;
  if (!op) return;
  const t = $('#transmission');
  t.replaceChildren(h('b', {}, `◆ ${op.name}${op.rarity ? ' · ' + op.rarity : ''}`), text);
  t.hidden = false;
  clearTimeout(transTimer);
  transTimer = setTimeout(() => { t.hidden = true; }, 9000);
}
app.transmit = transmit;

// ---------- controls ----------
document.querySelectorAll('.tb[data-panel]').forEach((b) => b.addEventListener('click', () => openPanel(b.dataset.panel)));
$('#themeBtn').addEventListener('click', cycleTheme);
$('#zoomIn').addEventListener('click', () => { radar.zoom(1 / 1.25); store('range', radar.rangeNm); });
$('#zoomOut').addEventListener('click', () => { radar.zoom(1.25); store('range', radar.rangeNm); });
$('#fullBtn').addEventListener('click', toggleFullscreen);
$('#radar').addEventListener('wheel', () => store('range', radar.rangeNm), { passive: true });

let wakeLock = null;
async function toggleFullscreen() {
  if (!document.fullscreenElement) {
    await document.documentElement.requestFullscreen?.().catch(() => {});
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
  } else {
    await document.exitFullscreen?.();
    wakeLock?.release?.(); wakeLock = null;
  }
}
document.addEventListener('visibilitychange', async () => {
  if (document.fullscreenElement && document.visibilityState === 'visible' && !wakeLock) {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
  }
});

// Kiosk: hide controls and cursor when the mouse is idle
let idleTimer;
function poke() {
  document.body.classList.remove('kiosk-idle');
  clearTimeout(idleTimer);
  const s = app.settings;
  if (s && s.display.kioskHide === false) return;
  idleTimer = setTimeout(() => { if ($('#drawer').hidden && $('#card').hidden) document.body.classList.add('kiosk-idle'); }, 5000);
}
['mousemove', 'mousedown', 'touchstart', 'keydown'].forEach((ev) => window.addEventListener(ev, poke, { passive: true }));
poke();

const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
let kpos = 0;
window.addEventListener('keydown', (e) => {
  kpos = e.key === KONAMI[kpos] ? kpos + 1 : e.key === KONAMI[0] ? 1 : 0;
  if (kpos === KONAMI.length) {
    kpos = 0;
    setTheme('omniverse');
    if (app.operator) { radar.startFlyby(); transmit('You found the back door. Welcome to the Omniverse.'); }
    else toast({ title: 'Omniverse unlocked', message: 'Add your Wingnauts in Settings to put one on watch.' });
    return;
  }
  if (e.target.closest('input, textarea, select')) return;
  const k = e.key.toLowerCase();
  if (k === 'f') toggleFullscreen();
  else if (k === 't') cycleTheme();
  else if (k === 'l') openPanel('log');
  else if (k === 's') openPanel('stats');
  else if (k === 'a') openPanel('alerts');
  else if (k === 'w') openPanel('watch');
  else if (k === ',') openPanel('settings');
  else if (k === '+' || k === '=') $('#zoomIn').click();
  else if (k === '-') $('#zoomOut').click();
  else if (k === 'escape') { if (!$('#drawer').hidden) $('#drawerClose').click(); else select(null); }
});

boot().catch((err) => banner(`Could not start: ${err.message}`));

export { renderHud, select, fmtAgo, fmtWhen };
