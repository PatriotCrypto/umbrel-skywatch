import { kvGet, kvSet } from './db.js';

export const DEFAULTS = {
  apiKey: '',
  demo: true,
  home: { lat: null, lon: null, label: 'Home' },
  radiusNm: 40,
  minAlt: null,
  maxAlt: null,
  budget: {
    share: 'all',          // 'all' | 'percent'
    percent: 100,
    preset: 'balanced',    // eco | balanced | max | custom
    customInterval: 60,
    idle: 'slow',          // slow | pause
    quiet: { enabled: false, start: '23:00', end: '06:00', tz: '' },
    detailsDailyCap: 60,
    watchSearch: false,
    watchSearchMinutes: 60,
    watchSearchDailyCap: 24,
  },
  display: {
    theme: 'ww2', labels: true, trails: true, units: 'nm', sweepSeconds: 8,
    kioskHide: true, gpsOverlay: false, heatOverlay: false, controllerSize: 'large',
  },
  gps: { enabled: false },
  ntfy: { server: 'https://ntfy.sh', topic: '', token: '' },
  alerts: {
    rules: [
      { id: 'emergency', type: 'emergency', enabled: true },
      { id: 'military', type: 'military', enabled: false },
      { id: 'newtype', type: 'newtype', enabled: false },
      { id: 'low', type: 'low', enabled: false, belowFt: 2000, withinNm: 5 },
      { id: 'rotor', type: 'category', enabled: false, categories: ['A7'], withinNm: 10 },
    ],
  },
  watchlist: [],
  wingnauts: { wallet: '', rpc: '', operator: null },
};

const SECRET_PATHS = [['apiKey'], ['ntfy', 'token'], ['wingnauts', 'rpc']];

export function loadSettings(db) {
  return deepMerge(structuredClone(DEFAULTS), kvGet(db, 'settings', {}));
}

export function saveSettings(db, s) { kvSet(db, 'settings', s); }

// Copy for the browser: secrets replaced by { set, hint }
export function publicSettings(s) {
  const out = structuredClone(s);
  for (const p of SECRET_PATHS) {
    const parent = p.length === 1 ? out : out[p[0]];
    const key = p[p.length - 1];
    const val = parent[key];
    parent[key] = { set: Boolean(val), hint: val ? '…' + String(val).slice(-4) : '' };
  }
  return out;
}

/** Applies a partial update from the browser. Secrets are only replaced when a new string is given. */
export function applyUpdate(current, patch) {
  const next = structuredClone(current);
  if (!patch || typeof patch !== 'object') return next;
  for (const p of SECRET_PATHS) {
    const src = p.length === 1 ? patch : patch[p[0]];
    if (!src) continue;
    const key = p[p.length - 1];
    if (key in src) {
      const v = src[key];
      if (typeof v === 'string') {
        if (p.length === 1) next[key] = v.trim(); else next[p[0]][key] = v.trim();
      }
      delete src[key];
    }
  }
  deepMerge(next, patch, true);
  return validate(next);
}

function validZone(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function validate(s) {
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const lat = Number(s.home.lat); const lon = Number(s.home.lon);
  s.home.lat = s.home.lat === null || s.home.lat === '' || !Number.isFinite(lat) ? null : num(lat, -90, 90, null);
  s.home.lon = s.home.lon === null || s.home.lon === '' || !Number.isFinite(lon) ? null : num(lon, -180, 180, null);
  s.home.label = String(s.home.label || 'Home').slice(0, 40);
  s.radiusNm = num(s.radiusNm, 1, 500, 40);
  s.minAlt = s.minAlt === null || s.minAlt === '' ? null : num(s.minAlt, -2000, 60000, null);
  s.maxAlt = s.maxAlt === null || s.maxAlt === '' ? null : num(s.maxAlt, 0, 100000, null);
  const b = s.budget;
  b.share = b.share === 'percent' ? 'percent' : 'all';
  b.percent = num(b.percent, 1, 100, 100);
  b.preset = ['eco', 'balanced', 'max', 'custom'].includes(b.preset) ? b.preset : 'balanced';
  b.customInterval = num(b.customInterval, 5, 3600, 60);
  b.idle = b.idle === 'pause' ? 'pause' : 'slow';
  b.quiet.tz = validZone(b.quiet.tz) ? String(b.quiet.tz) : '';
  b.detailsDailyCap = num(b.detailsDailyCap, 0, 1000, 60);
  b.watchSearchMinutes = num(b.watchSearchMinutes, 15, 1440, 60);
  b.watchSearchDailyCap = num(b.watchSearchDailyCap, 0, 500, 24);
  const d = s.display;
  d.theme = ['ww2', 'tower', 'space', 'omniverse'].includes(d.theme) ? d.theme : 'ww2';
  d.units = ['nm', 'mi', 'km'].includes(d.units) ? d.units : 'nm';
  d.sweepSeconds = num(d.sweepSeconds, 2, 20, 8);
  d.controllerSize = ['small', 'medium', 'large', 'xl'].includes(d.controllerSize) ? d.controllerSize : 'large';
  s.watchlist = (Array.isArray(s.watchlist) ? s.watchlist : []).slice(0, 50).map((w) => ({
    query: String(w.query || '').trim().toUpperCase().slice(0, 15),
    label: String(w.label || '').slice(0, 40),
    search: Boolean(w.search),
  })).filter((w) => w.query.length >= 3);
  if (!Array.isArray(s.alerts.rules)) s.alerts.rules = structuredClone(DEFAULTS.alerts.rules);
  s.ntfy.server = String(s.ntfy.server || 'https://ntfy.sh').replace(/\/+$/, '');
  s.ntfy.topic = String(s.ntfy.topic || '').trim().slice(0, 64);
  s.wingnauts.wallet = String(s.wingnauts.wallet || '').trim();
  return s;
}

function deepMerge(target, src, replaceArrays = true) {
  if (!src || typeof src !== 'object') return target;
  for (const [k, v] of Object.entries(src)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (Array.isArray(v)) target[k] = replaceArrays ? structuredClone(v) : v;
    else if (v && typeof v === 'object' && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) deepMerge(target[k], v, replaceArrays);
    else target[k] = v;
  }
  return target;
}
