// Alert rules, evaluated against data the radar already has (no extra API calls),
// with optional push notifications through ntfy.
import { EMERGENCY_SQUAWKS } from './geo.js';

export const RULE_TYPES = {
  emergency: { label: 'Emergency squawk (7500 / 7600 / 7700)', cooldownMin: 15, priority: 5, tags: ['rotating_light'] },
  watchlist: { label: 'Watchlist aircraft spotted', cooldownMin: 180, priority: 4, tags: ['eyes'] },
  military: { label: 'Military aircraft', cooldownMin: 360, priority: 3, tags: ['shield'] },
  newtype: { label: 'New aircraft type for your life list', cooldownMin: 0, priority: 3, tags: ['sparkles'] },
  low: { label: 'Low aircraft near home', cooldownMin: 60, priority: 3, tags: ['arrow_down'] },
  category: { label: 'Aircraft category near home', cooldownMin: 120, priority: 3, tags: ['helicopter'] },
  near: { label: 'Anything passing close overhead', cooldownMin: 60, priority: 2, tags: ['small_airplane'] },
};

export function ensureRules(rules) {
  const list = Array.isArray(rules) ? rules : [];
  const have = new Set(list.map((r) => r.id));
  if (!have.has('watchlist')) list.splice(1, 0, { id: 'watchlist', type: 'watchlist', enabled: true });
  if (!have.has('near')) list.push({ id: 'near', type: 'near', enabled: false, withinNm: 2 });
  return list.filter((r) => RULE_TYPES[r.type]);
}

function label(a) {
  const d = a.d || {};
  const who = a.f || d.reg || a.h.toUpperCase();
  const what = d.model ? `${d.manufacturer ? d.manufacturer + ' ' : ''}${d.model}` : a.c || 'aircraft';
  return { who, what };
}

function where(a, units) {
  if (a.dist == null) return '';
  const card = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(a.brg / 45) % 8];
  const conv = units === 'km' ? [1.852, 'km'] : units === 'mi' ? [1.15078, 'mi'] : [1, 'nm'];
  const alt = a.og ? 'on the ground' : a.ab != null ? `${Math.round(a.ab).toLocaleString('en-US')} ft` : 'altitude unknown';
  return `${(a.dist * conv[0]).toFixed(1)} ${conv[1]} ${card} of home, ${alt}`;
}

export function matchesWatch(a, w) {
  const q = w.query.toUpperCase();
  return (a.f && a.f.toUpperCase() === q) || a.h.toUpperCase() === q || (a.d?.reg && a.d.reg.toUpperCase() === q);
}

export class Alerter {
  constructor(db, getSettings, { fetchImpl = globalThis.fetch, onAlert = () => {} } = {}) {
    this.db = db;
    this.getSettings = getSettings;
    this.fetch = fetchImpl;
    this.onAlert = onAlert;
    this.last = new Map();
    this.ins = db.prepare('INSERT INTO alerts (ts, rule_id, kind, hex, title, message, delivered, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.upd = db.prepare('UPDATE alerts SET delivered = ?, error = ? WHERE id = ?');
  }

  /** Evaluate every rule against the live picture. */
  evaluate(aircraft, { newTypes = [] } = {}) {
    const s = this.getSettings();
    const rules = ensureRules(s.alerts.rules).filter((r) => r.enabled);
    const units = s.display.units;
    for (const rule of rules) {
      if (rule.type === 'newtype') {
        for (const t of newTypes) {
          this.fire(rule, t.hex, `New type: ${t.label || t.typecode}`, `First ${t.label || t.typecode} (${t.typecode}) on your life list.`, `newtype:${t.typecode}`);
        }
        continue;
      }
      for (const a of aircraft) {
        const { who, what } = label(a);
        switch (rule.type) {
          case 'emergency':
            if (a.sq && EMERGENCY_SQUAWKS[a.sq]) this.fire(rule, a.h, `Squawk ${a.sq}: ${EMERGENCY_SQUAWKS[a.sq]}`, `${who} (${what}) is squawking ${a.sq}. ${where(a, units)}.`, `emg:${a.h}:${a.sq}`);
            break;
          case 'watchlist':
            for (const w of s.watchlist) if (matchesWatch(a, w)) this.fire(rule, a.h, `Watchlist: ${w.label || w.query}`, `${who} (${what}) is on the radar. ${where(a, units)}.`, `watch:${a.h}`);
            break;
          case 'military':
            if (a.d?.mil) this.fire(rule, a.h, `Military: ${who}`, `${what}. ${where(a, units)}.`, `mil:${a.h}`);
            break;
          case 'low':
            if (!a.og && a.ab != null && a.ab < (rule.belowFt ?? 2000) && a.dist != null && a.dist <= (rule.withinNm ?? 5)) {
              this.fire(rule, a.h, `Low aircraft: ${who}`, `${what} at ${Math.round(a.ab)} ft. ${where(a, units)}.`, `low:${a.h}`);
            }
            break;
          case 'category':
            if (a.c && (rule.categories || []).includes(a.c) && a.dist != null && a.dist <= (rule.withinNm ?? 10)) {
              this.fire(rule, a.h, `${a.c === 'A7' ? 'Helicopter' : 'Aircraft'} nearby: ${who}`, `${what}. ${where(a, units)}.`, `cat:${a.h}`);
            }
            break;
          case 'near':
            if (a.dist != null && a.dist <= (rule.withinNm ?? 2)) this.fire(rule, a.h, `Overhead: ${who}`, `${what}. ${where(a, units)}.`, `near:${a.h}`);
            break;
          default:
        }
      }
    }
  }

  fire(rule, hex, title, message, key) {
    const meta = RULE_TYPES[rule.type];
    const now = Date.now();
    const prev = this.last.get(key);
    if (prev && (meta.cooldownMin === 0 || now - prev < meta.cooldownMin * 60000)) return;
    this.last.set(key, now);
    const r = this.ins.run(now, rule.id, rule.type, hex, title, message, 0, null);
    const id = Number(r.lastInsertRowid);
    const alert = { id, ts: now, rule: rule.id, kind: rule.type, hex, title, message };
    this.onAlert(alert);
    this.push(title, message, meta).then(
      (ok) => this.upd.run(ok ? 1 : 0, null, id),
      (err) => this.upd.run(0, String(err.message || err).slice(0, 200), id),
    );
  }

  async push(title, message, meta = { priority: 3, tags: [] }) {
    const { ntfy } = this.getSettings();
    if (!ntfy.topic) return false;
    const headers = { 'content-type': 'application/json' };
    if (ntfy.token) headers.authorization = `Bearer ${ntfy.token}`;
    const res = await this.fetch(ntfy.server, {
      method: 'POST', headers, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ topic: ntfy.topic, title, message, priority: meta.priority, tags: meta.tags }),
    });
    if (!res.ok) throw new Error(`ntfy answered HTTP ${res.status}`);
    return true;
  }

  history(limit = 100) {
    return this.db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT ?').all(limit);
  }
}
