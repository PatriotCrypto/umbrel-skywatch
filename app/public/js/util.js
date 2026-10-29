export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const UNITS = {
  nm: { k: 1, label: 'nm' },
  mi: { k: 1.15078, label: 'mi' },
  km: { k: 1.852, label: 'km' },
};

export function fmtDist(nm, units = 'nm', digits = 1) {
  if (nm === null || nm === undefined) return '—';
  const u = UNITS[units] || UNITS.nm;
  return `${(nm * u.k).toFixed(digits)} ${u.label}`;
}

export const fmtAlt = (ft, og) => (og ? 'GND' : ft === null || ft === undefined ? '—' : `${Math.round(ft).toLocaleString('en-US')} ft`);
export const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
export const pad = (n, w = 2) => String(n).padStart(w, '0');

export function fmtAgo(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.round(s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function fmtWhen(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d >= today) return t;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${t}`;
}

export function fmtDur(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}:${pad(sec % 60)}`;
  return `${Math.floor(sec / 3600)}h ${pad(Math.floor((sec % 3600) / 60))}m`;
}

export const cardinal = (b) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((b % 360) + 360) % 360 / 45) % 8];

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

export function store(key, value) {
  try {
    if (value === undefined) { const v = localStorage.getItem(`skywatch:${key}`); return v === null ? undefined : JSON.parse(v); }
    localStorage.setItem(`skywatch:${key}`, JSON.stringify(value));
  } catch { /* storage unavailable */ }
  return undefined;
}

export function label(a) {
  return a.f || a.d?.reg || a.h.toUpperCase();
}
