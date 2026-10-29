import { $, h, api, fmtAlt, fmtDist, fmtNum, fmtDur, fmtAgo, fmtWhen, cardinal, store } from './util.js';
import { THEME_META } from './themes.js';
import { computeBudget } from './budget.js';
import { app, applyTheme, setTheme, currentTheme, toast, clearAlertBadge, loadOperator, renderHud } from './main.js';

const TITLES = { log: 'Spotter log', stats: 'Stats', alerts: 'Alerts', watch: 'Watchlist', settings: 'Settings' };
let open = null;
let openOpts = {};

export function currentPanel() { return open; }

export function openPanel(name, opts = {}) {
  const drawer = $('#drawer');
  if (open === name && !opts.hex && !opts.welcome) { closePanel(); return; }
  open = name; openOpts = opts;
  document.querySelectorAll('.tb[data-panel]').forEach((b) => b.classList.toggle('on', b.dataset.panel === name));
  $('#drawerTitle').textContent = TITLES[name];
  drawer.hidden = false;
  if (name === 'alerts') clearAlertBadge();
  refreshPanel();
}

export function closePanel() {
  open = null;
  $('#drawer').hidden = true;
  document.querySelectorAll('.tb[data-panel]').forEach((b) => b.classList.remove('on'));
}
$('#drawerClose').addEventListener('click', closePanel);

export async function refreshPanel() {
  if (!open) return;
  const body = $('#drawerBody');
  const scroll = body.scrollTop;
  const render = { log: renderLog, stats: renderStats, alerts: renderAlerts, watch: renderWatch, settings: renderSettings }[open];
  try {
    const node = await render(openOpts);
    if (!node) return;
    body.replaceChildren(node);
    body.scrollTop = scroll;
  } catch (err) {
    body.replaceChildren(h('div', { class: 'note bad' }, `Could not load: ${err.message}`));
  }
}

async function save(patch, quiet = false) {
  try {
    const r = await api('api/settings', { method: 'PUT', body: patch });
    app.settings = r.settings; app.status = r.status;
    renderHud();
    if (!quiet) toast({ title: 'Saved', message: '', ms: 1800 });
    return true;
  } catch (err) {
    toast({ title: 'Could not save', message: err.message });
    return false;
  }
}

const seg = (options, value, onPick) => h('div', { class: 'seg' }, options.map(([v, text]) =>
  h('button', { class: v === value ? 'on' : '', type: 'button', onclick: () => onPick(v) }, text)));
const field = (labelText, input, hint) => h('label', { class: 'field' }, h('span', {}, labelText), input, hint ? h('span', { class: 'hint' }, hint) : null);
const section = (title, ...kids) => h('div', { class: 'section' }, h('h3', {}, title), ...kids);
const check = (text, on, onChange) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: on, onchange: (e) => onChange(e.target.checked) }), text);

function tagsFor(r) {
  const t = [];
  if (r.mil) t.push(h('span', { class: 'tag mil' }, 'Mil'));
  if (['A6', 'A7', 'B1', 'B2', 'B3', 'B4', 'B6', 'B7'].includes(r.category)) t.push(h('span', { class: 'tag rare' }, r.category === 'A7' ? 'Rotor' : 'Rare'));
  if (r.privacy) t.push(h('span', { class: 'tag priv' }, 'Privacy'));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (r.first >= today.getTime()) t.push(h('span', { class: 'tag new' }, 'New'));
  return t;
}

/* ---------------- spotter log ---------------- */
let logState = { q: '', filter: 'all', sort: 'last', view: 'aircraft' };

async function renderLog(opts) {
  if (opts.hex) return renderAircraft(opts.hex);
  const units = app.settings.display.units;
  const wrap = h('div', {});
  const views = seg([['aircraft', 'Aircraft'], ['types', 'Life list']], logState.view, (v) => { logState.view = v; refreshPanel(); });
  wrap.append(h('div', { class: 'row', style: { marginBottom: '12px', justifyContent: 'space-between' } }, views,
    h('a', { class: 'btn ghost', href: 'api/log.csv', download: 'skywatch-spotter-log.csv' }, 'Export CSV')));

  if (logState.view === 'types') {
    const types = await api('api/lifelist');
    wrap.append(h('p', { class: 'muted' }, `${types.length} aircraft types spotted. A type joins the list the first time its registry details come back.`));
    wrap.append(h('div', { class: 'list' }, types.map((t) => h('div', { class: 'item', onclick: () => t.first_hex && openPanel('log', { hex: t.first_hex }) },
      h('div', { class: 't' }, t.label || t.typecode), h('div', { class: 'r' }, `${t.aircraft}×`),
      h('div', { class: 's' }, `${t.typecode} · first seen ${fmtWhen(t.first_seen)}`)))));
    return wrap;
  }

  const qs = new URLSearchParams({ q: logState.q, filter: logState.filter, sort: logState.sort });
  const data = await api(`api/log?${qs}`);
  const search = h('input', { type: 'text', placeholder: 'Search callsign, registration, type, operator', value: logState.q });
  let t;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { logState.q = search.value; refreshPanel().then(() => { const s = $('#drawerBody input[type=text]'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }); }, 300); });
  wrap.append(field('Search', search));
  wrap.append(h('div', { class: 'row', style: { marginBottom: '10px' } },
    seg([['all', 'All'], ['today', 'Today'], ['new', 'New'], ['rare', 'Rare'], ['mil', 'Military']], logState.filter, (v) => { logState.filter = v; refreshPanel(); }),
    h('select', { style: { width: 'auto' }, onchange: (e) => { logState.sort = e.target.value; refreshPanel(); } },
      [['last', 'Last seen'], ['first', 'First seen'], ['visits', 'Most visits'], ['closest', 'Closest pass']].map(([v, l]) => h('option', { value: v, selected: v === logState.sort }, l)))));
  wrap.append(h('p', { class: 'muted' }, `${fmtNum(data.totals.aircraft)} aircraft · ${fmtNum(data.totals.types)} types · ${fmtNum(data.totals.visits)} visits logged`));
  if (!data.rows.length) wrap.append(h('div', { class: 'note' }, 'Nothing here yet. The log fills in as aircraft cross your radar.'));
  wrap.append(h('div', { class: 'list' }, data.rows.map((r) => {
    const name = r.callsign || r.reg || r.hex.toUpperCase();
    const what = [r.type, r.model && r.manufacturer ? `${r.manufacturer} ${r.model}` : r.model, r.operator].filter(Boolean).join(' · ') || app.categories[r.category] || (r.looked ? 'No registry record' : 'Looking up…');
    return h('div', { class: 'item', onclick: () => openPanel('log', { hex: r.hex }) },
      h('div', { class: 't' }, name, ...tagsFor(r)),
      h('div', { class: 'r' }, `${r.visits}× · ${fmtAgo(r.last)}`),
      h('div', { class: 's' }, `${what} · closest ${fmtDist(r.closest, units)}${r.minAlt != null ? ` · ${fmtNum(r.minAlt)}–${fmtNum(r.maxAlt)} ft` : ''}`));
  })));
  return wrap;
}

async function renderAircraft(hex) {
  const units = app.settings.display.units;
  const { aircraft: r, visits } = await api(`api/aircraft/${hex}`);
  const wrap = h('div', {});
  wrap.append(h('button', { class: 'btn ghost', style: { marginBottom: '12px' }, onclick: () => openPanel('log', {}) }, '← Back to log'));
  if (!r) { wrap.append(h('div', { class: 'note' }, 'Not in the log.')); return wrap; }
  const live = app.snapshot?.aircraft.find((a) => a.h === hex);
  wrap.append(h('h2', { style: { fontFamily: 'var(--font-display)', fontWeight: 'normal', margin: '0 0 4px', color: 'var(--accent)' } }, r.callsign || r.reg || hex.toUpperCase(), ...tagsFor(r)));
  wrap.append(h('p', { class: 'muted', style: { marginTop: 0 } }, [r.manufacturer, r.model].filter(Boolean).join(' ') || app.categories[r.category] || 'Unknown type'));
  wrap.append(h('dl', { class: 'kv' },
    h('dt', {}, 'ICAO hex'), h('dd', {}, hex.toUpperCase()),
    h('dt', {}, 'Registration'), h('dd', {}, r.privacy ? 'Hidden (FAA privacy program)' : r.reg || '—'),
    h('dt', {}, 'Type code'), h('dd', {}, r.type || '—'),
    h('dt', {}, 'Operator'), h('dd', {}, r.operator || '—'),
    h('dt', {}, 'Category'), h('dd', {}, r.category ? `${r.category} · ${app.categories[r.category] || ''}` : '—'),
    h('dt', {}, 'First seen'), h('dd', {}, new Date(r.first).toLocaleString()),
    h('dt', {}, 'Last seen'), h('dd', {}, new Date(r.last).toLocaleString()),
    h('dt', {}, 'Visits'), h('dd', {}, String(r.visits)),
    h('dt', {}, 'Closest pass'), h('dd', {}, fmtDist(r.closest, units)),
    h('dt', {}, 'Altitudes'), h('dd', {}, r.minAlt != null ? `${fmtNum(r.minAlt)} – ${fmtNum(r.maxAlt)} ft` : '—')));
  if (live) wrap.append(h('div', { class: 'row', style: { margin: '12px 0' } }, h('button', { class: 'btn primary', onclick: () => app.select(hex) }, 'Show on radar')));
  wrap.append(section('Recent visits', h('div', { class: 'list' }, visits.map((v) => h('div', { class: 'item', style: { cursor: 'default' } },
    h('div', { class: 't' }, v.callsign || '—'), h('div', { class: 'r' }, fmtWhen(v.start_ts)),
    h('div', { class: 's' }, `${fmtDur((v.end_ts - v.start_ts) / 1000)} on radar · closest ${fmtDist(v.min_dist_nm < 1e8 ? v.min_dist_nm : null, units)}${v.min_alt != null && v.min_alt < 1e8 ? ` · ${fmtNum(v.min_alt)}–${fmtNum(v.max_alt)} ft` : ''}${v.squawk ? ` · sq ${v.squawk}` : ''}`))))));
  return wrap;
}

/* ---------------- stats ---------------- */
async function renderStats() {
  const s = await api('api/stats');
  const units = app.settings.display.units;
  const t = s.totals;
  const wrap = h('div', {});
  wrap.append(h('div', { class: 'stat-tiles' },
    tile(fmtNum(t.today), 'Aircraft today'), tile(fmtNum(t.newToday), 'New today'), tile(fmtNum(t.aircraft), 'All time'),
    tile(fmtNum(t.types), 'Types'), tile(t.closest != null ? fmtDist(t.closest, units) : '—', 'Closest pass'),
    tile(t.since ? new Date(t.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—', 'Logging since')));

  const display = app.settings.display;
  wrap.append(section('Overlays',
    check('Show heatmap of where aircraft fly', display.heatOverlay, async (v) => { await save({ display: { heatOverlay: v } }, true); loadHeat(); }),
    h('p', { class: 'muted' }, 'Built from every position the radar has logged. Costs no API calls.')));

  const now = Date.now();
  const hours = [];
  const byHour = new Map(s.hourly.map((r) => [r.hour, r.aircraft]));
  const firstHour = Math.floor(now / 3600000) * 3600 - 47 * 3600;
  for (let i = 0; i < 48; i++) { const hr = firstHour + i * 3600; hours.push({ x: hr * 1000, y: byHour.get(hr) || 0 }); }
  wrap.append(section('Aircraft on radar per hour · last 48 h', chart(hours, (p) => `${new Date(p.x).toLocaleString(undefined, { weekday: 'short', hour: 'numeric' })}: ${p.y} aircraft`, (p) => new Date(p.x).getHours() === 0 ? new Date(p.x).toLocaleDateString(undefined, { weekday: 'short' }) : null)));

  const hod = Array.from({ length: 24 }, (_, i) => ({ x: i, y: s.byHour.find((r) => r.h === i)?.visits || 0 }));
  wrap.append(section('Busiest time of day · last 30 days', chart(hod, (p) => `${p.x}:00–${p.x + 1}:00 · ${p.y} visits`, (p) => (p.x % 6 === 0 ? `${p.x}:00` : null))));

  if (s.daily.length > 1) {
    wrap.append(section('Unique aircraft per day', chart(s.daily.map((d) => ({ x: d.day, y: d.aircraft })), (p) => `${p.x}: ${p.y} aircraft`, (p, i, arr) => (i === 0 || i === arr.length - 1 ? p.x.slice(5) : null))));
  }
  wrap.append(section('Top types', bars(s.topTypes.map((r) => [r.label?.trim() || r.k, r.n, r.k]))));
  wrap.append(section('Top operators', bars(s.topOperators.map((r) => [r.k, r.n]))));
  wrap.append(section('Categories', bars(s.categories.map((r) => [`${r.k} · ${app.categories[r.k] || ''}`, r.n]))));

  const dayCalls = new Map();
  for (const c of s.calls) dayCalls.set(c.day, (dayCalls.get(c.day) || 0) + c.n);
  if (dayCalls.size) {
    wrap.append(section('API calls per day', chart([...dayCalls].map(([x, y]) => ({ x, y })), (p) => `${p.x}: ${p.y} calls`, (p, i, arr) => (i === 0 || i === arr.length - 1 ? p.x.slice(5) : null)),
      h('p', { class: 'muted' }, `Today: ${app.status.today.flights} radar, ${app.status.today.details} aircraft details, ${app.status.today.search} watchlist searches, ${app.status.today.path} tracks, ${app.status.today.gps} GPS.`)));
  }
  return wrap;
}

function tile(v, l) { return h('div', { class: 'tile' }, h('b', {}, v), h('span', {}, l)); }

function bars(rows) {
  if (!rows.length) return h('p', { class: 'muted' }, 'No data yet.');
  const max = Math.max(...rows.map((r) => r[1]));
  return h('div', { class: 'bars' }, rows.map(([k, n, sub]) => h('div', { class: 'bar', title: `${k}: ${n}` }, h('i', { style: { width: `${(n / max) * 100}%` } }), h('span', {}, k), h('em', {}, fmtNum(n)))));
}

// Single-series bar chart on canvas with a hover tooltip
function chart(points, tip, tick) {
  const c = h('canvas', { class: 'chart', role: 'img', 'aria-label': 'Bar chart' });
  const tipEl = h('div', { class: 'note', style: { margin: '4px 0 0', minHeight: '32px' } }, 'Hover a bar for details');
  const draw = (hover = -1) => {
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim();
    const muted = css.getPropertyValue('--muted').trim();
    const line = css.getPropertyValue('--line').trim();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = c.clientWidth || 380; const H = 130;
    c.width = W * dpr; c.height = H * dpr;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const top = 8; const bottom = 18; const left = 28;
    const max = Math.max(1, ...points.map((p) => p.y));
    const n = points.length;
    const bw = (W - left) / n;
    ctx.strokeStyle = line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, H - bottom + 0.5); ctx.lineTo(W, H - bottom + 0.5); ctx.stroke();
    ctx.fillStyle = muted; ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right'; ctx.fillText(String(max), left - 5, top + 8); ctx.fillText('0', left - 5, H - bottom);
    ctx.textAlign = 'center';
    points.forEach((p, i) => {
      const bh = ((H - top - bottom) * p.y) / max;
      const x = left + i * bw + 1; const w = Math.max(1, bw - 2);
      ctx.globalAlpha = hover === -1 || hover === i ? 1 : 0.45;
      ctx.fillStyle = accent;
      if (bh > 0) {
        const rr = Math.min(4, w / 2, bh);
        ctx.beginPath();
        ctx.moveTo(x, H - bottom); ctx.lineTo(x, H - bottom - bh + rr);
        ctx.quadraticCurveTo(x, H - bottom - bh, x + rr, H - bottom - bh);
        ctx.lineTo(x + w - rr, H - bottom - bh); ctx.quadraticCurveTo(x + w, H - bottom - bh, x + w, H - bottom - bh + rr);
        ctx.lineTo(x + w, H - bottom); ctx.fill();
      }
      ctx.globalAlpha = 1;
      const label = tick(p, i, points);
      if (label) { ctx.fillStyle = muted; ctx.fillText(label, x + w / 2, H - 4); }
    });
    c._geom = { left, bw };
  };
  c.addEventListener('mousemove', (e) => {
    const g = c._geom; if (!g) return;
    const i = Math.floor((e.offsetX - g.left) / g.bw);
    if (i >= 0 && i < points.length) { tipEl.textContent = tip(points[i]); draw(i); }
  });
  c.addEventListener('mouseleave', () => draw());
  requestAnimationFrame(() => draw());
  return h('div', {}, c, tipEl);
}

export async function loadHeat() {
  if (!app.settings.display.heatOverlay) { app.radar.heat = null; return; }
  app.radar.heat = await api('api/heatmap');
}

/* ---------------- alerts ---------------- */
async function renderAlerts() {
  const data = await api('api/alerts');
  const s = app.settings;
  const wrap = h('div', {});
  const ntfyOn = Boolean(s.ntfy.topic);
  wrap.append(h('div', { class: `note ${ntfyOn ? 'ok' : ''}` }, ntfyOn
    ? `Push notifications go to ntfy topic “${s.ntfy.topic}”. Alerts are worked out from radar data you already have, so they cost no extra API calls.`
    : 'Alerts show here and on screen. To get them on your phone, add an ntfy topic in Settings → Notifications.'));

  const rules = structuredClone(s.alerts.rules);
  const saveRules = () => save({ alerts: { rules } }, true);
  wrap.append(section('Rules', ...rules.map((r) => {
    const meta = app.ruleTypes[r.type] || { label: r.type };
    const extra = [];
    if (r.type === 'low') {
      extra.push(numIn('Below (ft)', r.belowFt, (v) => { r.belowFt = v; saveRules(); }), numIn('Within (nm)', r.withinNm, (v) => { r.withinNm = v; saveRules(); }));
    }
    if (r.type === 'category') {
      extra.push(h('label', { class: 'field' }, h('span', {}, 'Categories'), h('input', { type: 'text', value: (r.categories || []).join(', '), onchange: (e) => { r.categories = e.target.value.toUpperCase().split(/[\s,]+/).filter(Boolean); saveRules(); } })),
        numIn('Within (nm)', r.withinNm, (v) => { r.withinNm = v; saveRules(); }));
    }
    if (r.type === 'near') extra.push(numIn('Within (nm)', r.withinNm, (v) => { r.withinNm = v; saveRules(); }));
    return h('div', { style: { marginBottom: '10px' } }, check(meta.label, r.enabled, (v) => { r.enabled = v; saveRules(); }),
      extra.length ? h('div', { class: 'row', style: { paddingLeft: '24px' } }, extra) : null);
  }), h('p', { class: 'muted' }, 'Category codes: A1 light, A2 small, A3 large, A5 heavy, A6 high performance, A7 rotorcraft, B1 glider, B2 balloon, B6 drone.')));

  wrap.append(section('History',
    data.history.length ? h('div', { class: 'list' }, data.history.map((a) => h('div', { class: 'item', onclick: () => a.hex && app.select(a.hex) },
      h('div', { class: 't' }, a.title), h('div', { class: 'r' }, fmtWhen(a.ts)),
      h('div', { class: 's' }, `${a.message}${a.delivered ? ' · sent to phone' : a.error ? ` · push failed: ${a.error}` : ''}`)))) : h('p', { class: 'muted' }, 'No alerts yet.'),
    data.history.length ? h('button', { class: 'btn ghost', style: { marginTop: '10px' }, onclick: async () => { await api('api/alerts/history', { method: 'DELETE' }); refreshPanel(); } }, 'Clear history') : null));
  return wrap;
}

function numIn(text, value, onChange) {
  return h('label', { class: 'field' }, h('span', {}, text), h('input', { type: 'number', value: value ?? '', onchange: (e) => onChange(Number(e.target.value)) }));
}

/* ---------------- watchlist ---------------- */
async function renderWatch() {
  const items = await api('api/watchlist');
  const s = app.settings;
  const units = s.display.units;
  const wrap = h('div', {});
  wrap.append(h('p', { class: 'muted', style: { marginTop: 0 } }, 'Track specific aircraft by callsign, registration or ICAO hex. Matches inside your radar circle are free.'));
  const q = h('input', { type: 'text', placeholder: 'N12345, DAL123 or a1b2c3', maxlength: 15 });
  const lbl = h('input', { type: 'text', placeholder: 'Label (optional)' });
  const srch = h('input', { type: 'checkbox' });
  wrap.append(section('Add aircraft',
    h('div', { class: 'row' }, field('Callsign / registration / hex', q), field('Label', lbl)),
    h('label', { class: 'check' }, srch, 'Also look for it outside my radar circle (uses API calls)'),
    h('button', { class: 'btn primary', onclick: async () => {
      const query = q.value.trim().toUpperCase();
      if (query.length < 3) { toast({ title: 'Too short', message: 'Enter at least 3 characters.' }); return; }
      const list = [...s.watchlist.filter((w) => w.query !== query), { query, label: lbl.value.trim(), search: srch.checked }];
      const patch = { watchlist: list };
      if (srch.checked && !s.budget.watchSearch) patch.budget = { watchSearch: true };
      if (await save(patch, true)) refreshPanel();
    } }, 'Add to watchlist')));

  if (s.watchlist.some((w) => w.search)) {
    wrap.append(h('div', { class: 'note' }, s.budget.watchSearch
      ? `Outside searches: about every ${s.budget.watchSearchMinutes} min across the list, up to ${s.budget.watchSearchDailyCap} calls a day (Settings → API budget).`
      : 'Outside searches are switched off in Settings → API budget.'));
  }
  wrap.append(section('Watching', items.length ? h('div', { class: 'list' }, items.map((w) => {
    const st = w.status;
    let line = 'Not seen yet';
    if (st?.found) {
      const where = st.dist != null ? `${fmtDist(st.dist, units)} from home` : '';
      line = `${st.source === 'radar' ? 'On radar' : 'Found by search'} ${fmtAgo(st.at)} · ${where} · ${fmtAlt(st.ab)}`;
    } else if (st) line = `Not airborne at last check (${fmtAgo(st.at)})`;
    return h('div', { class: 'item', onclick: () => st?.found && st.source === 'radar' && app.select(st.h) },
      h('div', { class: 't' }, w.label || w.query, w.label ? h('span', { class: 'muted' }, ` ${w.query}`) : null, w.search ? h('span', { class: 'tag' }, 'search') : null),
      h('div', { class: 'r' }, h('button', { class: 'icon-btn', title: 'Remove', onclick: async (e) => { e.stopPropagation(); if (await save({ watchlist: s.watchlist.filter((x) => x.query !== w.query) }, true)) refreshPanel(); } }, '✕')),
      h('div', { class: 's' }, line));
  })) : h('p', { class: 'muted' }, 'Nothing on the watchlist yet.')));
  return wrap;
}

/* ---------------- settings ---------------- */
async function renderSettings(opts) {
  const s = app.settings;
  const st = app.status;
  const wrap = h('div', {});

  if (opts.welcome) {
    wrap.append(h('div', { class: 'welcome section' },
      h('h1', {}, 'Welcome to Skywatch'),
      h('p', {}, 'Right now the radar is showing made-up demo traffic. To see the real sky:'),
      h('ol', { class: 'steps' },
        h('li', {}, 'Create a key on the Wingbits API dashboard and paste it below.'),
        h('li', {}, 'Enter your home coordinates and how far out to look.'),
        h('li', {}, 'Pick a budget. Skywatch paces itself so you never run out mid-month.'))));
  }

  // --- Wingbits API
  const keyIn = h('input', { type: 'password', autocomplete: 'off', placeholder: s.apiKey.set ? `Saved key ${s.apiKey.hint}` : 'Paste your Wingbits API key' });
  const keyNote = h('div', {});
  const planNote = st.plan && !st.demo
    ? h('div', { class: 'note ok' }, `${st.plan.name} plan · ${fmtNum(st.plan.monthlyLimit)} calls a month · ${st.plan.rateLimitPerMinute}/min · max radius ${st.plan.geoQueryMaxNm ?? '—'} nm · resets ${new Date(st.plan.periodResetAt).toLocaleDateString()}`)
    : null;
  wrap.append(section('Wingbits API',
    field('API key', keyIn, 'Stored only on your Umbrel. Never sent to the browser after saving.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn ghost', onclick: async () => {
        keyNote.replaceChildren(h('div', { class: 'note' }, 'Checking…'));
        const r = await api('api/test-key', { method: 'POST', body: { apiKey: keyIn.value } });
        keyNote.replaceChildren(r.ok
          ? h('div', { class: 'note ok' }, `Key works: ${r.usage.plan} plan, ${fmtNum(r.usage.monthlyRemaining)} of ${fmtNum(r.usage.monthlyLimit)} calls left this month. (Checking is free.)`)
          : h('div', { class: 'note bad' }, r.error));
      } }, 'Test key'),
      h('button', { class: 'btn primary', onclick: async () => {
        if (!keyIn.value.trim()) return;
        if (await save({ apiKey: keyIn.value.trim(), demo: false })) { keyIn.value = ''; refreshPanel(); }
      } }, 'Save key')),
    keyNote, planNote,
    check('Demo mode (simulated traffic, no API calls)', s.demo || !s.apiKey.set, async (v) => { if (!s.apiKey.set && !v) { toast({ title: 'Add a key first', message: 'Demo mode stays on until a key is saved.' }); refreshPanel(); return; } await save({ demo: v }); refreshPanel(); }),
    h('p', { class: 'muted' }, h('a', { href: 'https://wingbits.com/dashboard/developers', target: '_blank', rel: 'noopener noreferrer' }, 'Wingbits API dashboard'), ' · ', h('a', { href: 'https://customer-api.wingbits.com/docs/', target: '_blank', rel: 'noopener noreferrer' }, 'API docs'))));

  // --- Home
  const lat = h('input', { type: 'number', step: 'any', value: s.home.lat ?? '', placeholder: '39.1031' });
  const lon = h('input', { type: 'number', step: 'any', value: s.home.lon ?? '', placeholder: '-84.5120' });
  const name = h('input', { type: 'text', value: s.home.label });
  const maxR = st.plan?.geoQueryMaxNm || 150;
  const radOut = h('b', {}, `${s.radiusNm} nm`);
  const rad = h('input', { type: 'range', min: 5, max: maxR, step: 5, value: Math.min(s.radiusNm, maxR), oninput: (e) => { radOut.textContent = `${e.target.value} nm`; } });
  const minA = h('input', { type: 'number', value: s.minAlt ?? '', placeholder: 'none' });
  const maxA = h('input', { type: 'number', value: s.maxAlt ?? '', placeholder: 'none' });
  wrap.append(section('Home location',
    h('div', { class: 'row' }, field('Latitude', lat), field('Longitude', lon)),
    h('div', { class: 'row' }, field('Name', name),
      h('button', { class: 'btn ghost', style: { alignSelf: 'end', marginBottom: '12px' }, onclick: () => {
        if (!navigator.geolocation) { toast({ title: 'Not available', message: 'This browser cannot share its location.' }); return; }
        navigator.geolocation.getCurrentPosition((p) => { lat.value = p.coords.latitude.toFixed(5); lon.value = p.coords.longitude.toFixed(5); },
          () => toast({ title: 'Location blocked', message: 'Browsers only share location over https or localhost. Type the coordinates instead (right-click your house in Google Maps to copy them).' }));
      } }, 'Use this device')),
    h('label', { class: 'field' }, h('span', {}, 'Radar radius ', radOut), rad, h('span', { class: 'hint' }, `Your plan allows up to ${maxR} nm. One poll costs one call whatever the radius.`)),
    h('div', { class: 'row' }, field('Min altitude (ft)', minA), field('Max altitude (ft)', maxA)),
    h('button', { class: 'btn primary', onclick: async () => {
      const la = lat.value === '' ? null : Number(lat.value); const lo = lon.value === '' ? null : Number(lon.value);
      if ((la === null) !== (lo === null) || (la !== null && (Math.abs(la) > 90 || Math.abs(lo) > 180))) { toast({ title: 'Check the coordinates', message: 'Latitude −90 to 90, longitude −180 to 180.' }); return; }
      if (await save({ home: { lat: la, lon: lo, label: name.value }, radiusNm: Number(rad.value), minAlt: minA.value === '' ? null : Number(minA.value), maxAlt: maxA.value === '' ? null : Number(maxA.value) })) { app.radar.rangeNm = null; store('range', null); refreshPanel(); }
    } }, 'Save location')));

  // --- Budget
  const b = structuredClone(s.budget);
  const preview = h('div', { class: 'note' });
  const updatePreview = () => {
    const usage = st.plan ? { monthlyLimit: st.plan.monthlyLimit, monthlyRemaining: st.plan.monthlyRemaining, periodResetAt: st.plan.periodResetAt, rateLimitPerMinute: st.plan.rateLimitPerMinute } : null;
    if (!usage) { preview.textContent = 'Waiting for plan details…'; return; }
    const r = computeBudget({ usage, appUsed: st.appUsed, budget: b, watched: true, watchedFraction: st.watchedFraction });
    const idle = b.idle === 'pause' ? 'paused when nobody is watching' : `every ${fmtDur(r.idleIntervalSec)} when nobody is watching`;
    preview.replaceChildren(...[
      r.watchedIntervalSec ? `About every ${fmtDur(r.watchedIntervalSec)} while a screen is open, ${idle}. Roughly ${fmtNum(r.perDay)} radar calls a day, ${fmtNum(r.allowance)} allowed this period for Skywatch.` : r.reason,
      r.warning ? h('div', { style: { color: 'var(--warn)', marginTop: '6px' } }, r.warning) : null,
      h('div', { class: 'muted', style: { marginTop: '6px' } }, `Screens are open about ${Math.round((st.watchedFraction || 0.5) * 100)}% of the time; the pacing learns this as you use it.`)].filter(Boolean));
  };
  const commit = () => { updatePreview(); save({ budget: b }, true); };
  const pct = h('input', { type: 'range', min: 5, max: 100, step: 5, value: b.percent, oninput: (e) => { b.percent = Number(e.target.value); pctOut.textContent = `${b.percent}%`; updatePreview(); }, onchange: commit });
  const pctOut = h('b', {}, `${b.percent}%`);
  const custom = h('input', { type: 'number', min: 5, max: 3600, value: b.customInterval, onchange: (e) => { b.customInterval = Number(e.target.value); commit(); } });
  const segWrap = (key, options) => {
    const holder = h('div', {});
    const draw = () => holder.replaceChildren(seg(options, b[key], (v) => { b[key] = v; draw(); commit(); refreshPanel(); }));
    draw();
    return holder;
  };
  wrap.append(section('API budget',
    field('How much of the monthly quota may Skywatch use?', segWrap('share', [['all', 'All of it'], ['percent', 'A share']])),
    b.share === 'percent' ? h('label', { class: 'field' }, h('span', {}, 'Share for Skywatch ', pctOut), pct, h('span', { class: 'hint' }, 'Use this if the same key powers other projects.')) : null,
    field('Pace', segWrap('preset', [['eco', 'Eco'], ['balanced', 'Balanced'], ['max', 'Max'], ['custom', 'Custom']]), 'Eco spends about half, Balanced about 90%, Max all of the share, spread evenly to the monthly reset.'),
    b.preset === 'custom' ? field('Poll every (seconds) while watched', custom) : null,
    field('When no screen is open', segWrap('idle', [['slow', 'Slow down'], ['pause', 'Pause']]), 'Slow down keeps alerts and the log running in the background.'),
    check('Quiet hours (poll slowly overnight, even with a screen on)', b.quiet.enabled, (v) => { b.quiet.enabled = v; commit(); refreshPanel(); }),
    b.quiet.enabled ? h('div', { class: 'row' },
      field('From', h('input', { type: 'time', value: b.quiet.start, onchange: (e) => { b.quiet.start = e.target.value; commit(); } })),
      field('To', h('input', { type: 'time', value: b.quiet.end, onchange: (e) => { b.quiet.end = e.target.value; commit(); } }))) : null,
    h('div', { class: 'row' },
      field('Aircraft-detail lookups per day', h('input', { type: 'number', min: 0, max: 1000, value: b.detailsDailyCap, onchange: (e) => { b.detailsDailyCap = Number(e.target.value); commit(); } }), 'Each lookup covers up to 100 aircraft and is cached forever.'),
      field('Watchlist searches per day', h('input', { type: 'number', min: 0, max: 500, value: b.watchSearchDailyCap, onchange: (e) => { b.watchSearchDailyCap = Number(e.target.value); commit(); } }))),
    check('Search for watchlist aircraft outside my radar circle', b.watchSearch, (v) => { b.watchSearch = v; commit(); }),
    preview));
  updatePreview();

  // --- Display
  const d = s.display;
  const theme = currentTheme();
  wrap.append(section('Display',
    h('div', { class: 'theme-grid' }, Object.entries(THEME_META).map(([k, m]) => h('button', { class: `theme-opt${k === theme ? ' on' : ''}`, type: 'button', onclick: async () => { setTheme(k); await save({ display: { theme: k } }, true); refreshPanel(); } },
      h('span', { class: 'swatch' }, m.swatch.map((c) => h('i', { style: { background: c } }))), h('b', {}, m.title), h('small', {}, m.sub)))),
    h('p', { class: 'muted' }, 'Each screen remembers its own style, so the den monitor can be WW2 while your laptop shows the tower.'),
    check('Callsign labels', d.labels, (v) => save({ display: { labels: v } }, true)),
    check('Trails', d.trails, (v) => save({ display: { trails: v } }, true)),
    check('Hide controls and cursor when the mouse is idle', d.kioskHide !== false, (v) => save({ display: { kioskHide: v } }, true)),
    field('Distance units', seg([['nm', 'Nautical miles'], ['mi', 'Statute miles'], ['km', 'Kilometers']], d.units, async (v) => { await save({ display: { units: v } }, true); refreshPanel(); })),
    h('label', { class: 'field' }, h('span', {}, `WW2 sweep speed: one turn every ${d.sweepSeconds} s`), h('input', { type: 'range', min: 3, max: 15, value: d.sweepSeconds, onchange: async (e) => { await save({ display: { sweepSeconds: Number(e.target.value) } }, true); refreshPanel(); } })),
    check('GPS interference overlay (1 API call a day)', s.gps.enabled && d.gpsOverlay, async (v) => { await save({ gps: { enabled: v }, display: { gpsOverlay: v } }, true); }),
    h('p', { class: 'muted' }, 'Shades areas where aircraft reported poor GPS accuracy. That points to degraded GPS, not necessarily jamming.')));

  // --- Notifications
  const server = h('input', { type: 'url', value: s.ntfy.server });
  const topic = h('input', { type: 'text', value: s.ntfy.topic, placeholder: 'my-skywatch-alerts' });
  const token = h('input', { type: 'password', autocomplete: 'off', placeholder: s.ntfy.token.set ? `Saved ${s.ntfy.token.hint}` : 'Only for protected topics' });
  const ntfyNote = h('div', {});
  wrap.append(section('Notifications (ntfy)',
    h('p', { class: 'muted', style: { marginTop: 0 } }, 'Install the free ntfy app on your phone and subscribe to the same topic. Pick a hard-to-guess topic name: anyone who knows it can read it on the public server. ntfy also runs on Umbrel if you want your own server.'),
    field('Server', server), h('div', { class: 'row' }, field('Topic', topic), field('Access token', token)),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: async () => { const p = { ntfy: { server: server.value, topic: topic.value } }; if (token.value) p.ntfy.token = token.value; if (await save(p)) refreshPanel(); } }, 'Save'),
      h('button', { class: 'btn ghost', onclick: async () => { const r = await api('api/ntfy/test', { method: 'POST' }); ntfyNote.replaceChildren(h('div', { class: `note ${r.ok ? 'ok' : 'bad'}` }, r.ok ? 'Test sent. Check your phone.' : r.error)); } }, 'Send test'),
      s.ntfy.token.set ? h('button', { class: 'btn ghost', onclick: async () => { if (await save({ ntfy: { token: '' } })) refreshPanel(); } }, 'Remove token') : null),
    ntfyNote));

  // --- Wingnauts
  const wallet = h('input', { type: 'text', value: s.wingnauts.wallet, placeholder: 'Solana wallet address (public)' });
  const rpc = h('input', { type: 'password', autocomplete: 'off', placeholder: s.wingnauts.rpc.set ? `Saved RPC ${s.wingnauts.rpc.hint}` : 'https://mainnet.helius-rpc.com/?api-key=…' });
  const wnNote = h('div', {});
  const owned = app.wingnauts || [];
  wrap.append(section('Wingnauts',
    h('p', { class: 'muted', style: { marginTop: 0 } }, 'Got Wingnauts? Enter the public wallet that holds them and one will take a seat as your radar operator. Read-only: nothing is signed and no keys are needed. The lookup needs a Solana RPC that supports the DAS API, such as a free Helius endpoint.'),
    field('Wallet address', wallet), field('Solana RPC URL', rpc),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: async () => {
        const p = { wingnauts: { wallet: wallet.value.trim() } };
        if (rpc.value) p.wingnauts.rpc = rpc.value.trim();
        if (!(await save(p, true))) return;
        wnNote.replaceChildren(h('div', { class: 'note' }, 'Looking up your Wingnauts…'));
        try {
          const r = await api('api/wingnauts/refresh', { method: 'POST' });
          await loadOperator();
          wnNote.replaceChildren(h('div', { class: 'note ok' }, r.items.length ? `Found ${r.items.length} Wingnaut${r.items.length > 1 ? 's' : ''}.` : 'No Wingnauts found in that wallet.'));
          setTimeout(refreshPanel, 1200);
        } catch (err) { wnNote.replaceChildren(h('div', { class: 'note bad' }, err.message)); }
      } }, 'Look up'),
      owned.length ? h('button', { class: 'btn ghost', onclick: async () => { await api('api/wingnauts', { method: 'DELETE' }); await save({ wingnauts: { wallet: '', rpc: '', operator: null } }, true); await loadOperator(); refreshPanel(); } }, 'Remove') : null),
    wnNote,
    owned.length ? h('div', { class: 'list', style: { marginTop: '10px' } }, owned.map((w) => h('div', { class: 'item', onclick: async () => { await save({ wingnauts: { operator: w.id } }, true); await loadOperator(); refreshPanel(); app.transmit?.('Reporting for duty.'); } },
      h('div', { class: 't', style: { display: 'flex', gap: '10px', alignItems: 'center' } },
        w.local ? h('img', { src: `api/wingnauts/img/${encodeURIComponent(w.id)}`, alt: '', width: 40, height: 40, style: { imageRendering: 'pixelated' } }) : null, w.name),
      h('div', { class: 'r' }, (app.operator?.id === w.id) ? 'On watch' : 'Choose'),
      h('div', { class: 's' }, w.rarity || '')))) : null,
    owned.length ? h('p', { class: 'muted' }, 'Your operator shows in the Omniverse view and drops in now and then elsewhere. Wingnauts art belongs to its creators; Skywatch only shows the NFTs your wallet holds.') : null));

  // --- About
  wrap.append(section('About',
    h('dl', { class: 'kv' }, h('dt', {}, 'Version'), h('dd', {}, app.version), h('dt', {}, 'Mode'), h('dd', {}, st.demo ? 'Demo traffic' : 'Live')),
    h('p', {}, 'Aircraft data is ', h('a', { href: 'https://wingbits.com', target: '_blank', rel: 'noopener noreferrer' }, 'powered by Wingbits'), ', a community network of ADS-B receivers.'),
    h('p', { class: 'muted' }, 'Skywatch is an unofficial community app. It is not made, endorsed or supported by Wingbits. Everything it logs stays on your Umbrel. Aircraft enrolled in the FAA LADD or PIA privacy programs are shown without registration or owner.'),
    h('p', { class: 'muted' }, 'Keyboard: T style · F full screen · L log · S stats · A alerts · W watchlist · , settings · +/− zoom · Esc close.')));
  return wrap;
}
