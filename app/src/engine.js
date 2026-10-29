// The engine owns the API client, the budget, and every scheduled job.
import fs from 'node:fs/promises';
import path from 'node:path';
import { cellToBoundary } from 'h3-js';
import { kvGet, kvSet } from './db.js';
import { computeBudget, inQuietHours } from './budget.js';
import { WingbitsClient, normalizeAircraft } from './wingbits.js';
import { DemoClient } from './demo.js';
import { Tracker } from './tracker.js';
import { Alerter, matchesWatch } from './alerts.js';
import { bboxAround, distanceNm } from './geo.js';

const USAGE_REFRESH_MS = 5 * 60 * 1000;
const PRESENCE_TTL_MS = 45 * 1000;
const MIN_GAP_MS = 5000;

export class Engine {
  constructor({ db, dataDir, getSettings, broadcast, apiBase, fetchImpl = globalThis.fetch }) {
    this.db = db;
    this.dataDir = dataDir;
    this.getSettings = getSettings;
    this.broadcast = broadcast;
    this.apiBase = apiBase;
    this.fetch = fetchImpl;
    this.tracker = new Tracker(db);
    this.alerter = new Alerter(db, getSettings, { fetchImpl, onAlert: (a) => this.broadcast('alert', a) });
    this.viewers = new Map();
    this.usage = null;
    this.usageAt = 0;
    this.callsSinceUsage = 0;
    this.lastCallAt = 0;
    this.lastPollAt = 0;
    this.inflight = false;
    this.backoffUntil = 0;
    this.backoffMs = 0;
    this.error = null;
    this.halted = false;
    this.detailsQueue = new Map(); // hex -> queued at
    this.detailsFailures = new Map();
    this.watchStatus = new Map();
    this.lastWatchSearch = 0;
    this.watchCursor = 0;
    this.gps = null;
    this.lastPollCount = 0;
    this.timer = null;
    this.configure();
  }

  // (Re)build the client after settings change.
  configure() {
    const s = this.getSettings();
    const demo = s.demo || !s.apiKey;
    const key = demo ? 'demo' : `key:${s.apiKey.slice(-6)}`;
    if (this.clientKey === key) return;
    this.clientKey = key;
    this.stateKey = demo ? 'budget:demo' : 'budget:live';
    this.state = kvGet(this.db, this.stateKey, { periodResetAt: null, appUsed: 0, watchedFraction: 0.5 });
    this.client = demo
      ? new DemoClient({ getCenter: () => this.getSettings().home, getRadius: () => this.effectiveRadius() })
      : new WingbitsClient({ apiKey: s.apiKey, base: this.apiBase, fetchImpl: this.fetch, onCall: (k) => this.countCall(k) });
    if (demo) { this.client.onCall = (k) => this.countCall(k); this.client.used = this.state.appUsed || 0; }
    this.usage = null;
    this.usageAt = 0;
    this.error = null;
    this.halted = false;
    this.backoffUntil = 0;
    this.backoffMs = 0;
    this.tracker.clearLive();
    this.lastPollAt = 0;
  }

  get isDemo() { return Boolean(this.client?.isDemo); }

  start() {
    this.loadGps();
    this.timer = setInterval(() => this.tick().catch((e) => console.error('tick', e)), 1000);
    this.presenceTimer = setInterval(() => this.updateWatchedFraction(), 60000);
  }

  stop() { clearInterval(this.timer); clearInterval(this.presenceTimer); }

  // ---------- presence ----------
  presence(id, visible) {
    if (!id) return;
    this.viewers.set(String(id).slice(0, 64), { visible: Boolean(visible), at: Date.now() });
  }

  watched() {
    const now = Date.now();
    for (const [id, v] of this.viewers) {
      if (now - v.at > PRESENCE_TTL_MS) { this.viewers.delete(id); continue; }
      if (v.visible) return true;
    }
    return false;
  }

  updateWatchedFraction() {
    const w = this.watched() ? 1 : 0;
    // ~17 hour time constant
    this.state.watchedFraction = this.state.watchedFraction * 0.999 + 0.001 * w;
    this.persist();
  }

  // ---------- budget ----------
  countCall(kind) {
    this.state.appUsed = (this.state.appUsed || 0) + 1;
    this.callsSinceUsage++;
    this.lastCallAt = Date.now();
    const day = new Date().toISOString().slice(0, 10);
    this.db.prepare('INSERT INTO apicalls (day, kind, n) VALUES (?, ?, 1) ON CONFLICT(day, kind) DO UPDATE SET n = n + 1').run(day, kind);
    this.persistSoon();
  }

  callsToday(kind) {
    const day = new Date().toISOString().slice(0, 10);
    const row = kind
      ? this.db.prepare('SELECT n FROM apicalls WHERE day = ? AND kind = ?').get(day, kind)
      : this.db.prepare('SELECT SUM(n) AS n FROM apicalls WHERE day = ?').get(day);
    return row?.n || 0;
  }

  persist() { kvSet(this.db, this.stateKey, this.state); }
  persistSoon() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => { this.persistTimer = null; this.persist(); }, 5000);
  }

  liveUsage() {
    if (!this.usage) return null;
    return { ...this.usage, monthlyRemaining: Math.max(0, this.usage.monthlyRemaining - this.callsSinceUsage), monthlyUsed: this.usage.monthlyUsed + this.callsSinceUsage };
  }

  budget() {
    const s = this.getSettings();
    return computeBudget({
      usage: this.liveUsage(), appUsed: this.state.appUsed || 0, budget: s.budget,
      watched: this.watched(), quiet: inQuietHours(s.budget.quiet), watchedFraction: this.state.watchedFraction ?? 0.5,
    });
  }

  effectiveRadius() {
    const s = this.getSettings();
    const max = this.usage?.features?.geoQueryMaxNm;
    return Math.max(1, Math.min(s.radiusNm, Number.isFinite(max) ? max : 500));
  }

  async refreshUsage() {
    try {
      const u = await this.client.usage();
      this.usage = u;
      this.usageAt = Date.now();
      this.callsSinceUsage = 0;
      if (this.state.periodResetAt !== u.periodResetAt) {
        // a new billing period started (or first run)
        if (this.state.periodResetAt) this.state.appUsed = 0;
        this.state.periodResetAt = u.periodResetAt;
        this.persist();
      }
      if (this.error?.code === 402 && u.monthlyRemaining > 0) this.error = null;
      if (this.error?.code === 'usage') this.error = null;
      return u;
    } catch (err) {
      this.usageAt = Date.now();
      this.handleError(err, 'usage');
      return null;
    }
  }

  handleError(err, what) {
    const status = err.status ?? 0;
    const now = Date.now();
    if (status === 401) {
      this.halted = true;
      this.error = { code: 401, message: 'Wingbits did not accept the API key. Check it in Settings.' };
    } else if (status === 402) {
      this.error = { code: 402, message: 'Wingbits says the plan quota is used up or the plan is inactive.' };
      this.backoffUntil = now + 15 * 60000;
    } else if (status === 429) {
      this.backoffMs = Math.min(10 * 60000, Math.max(30000, this.backoffMs * 2));
      this.backoffUntil = now + this.backoffMs;
      this.error = { code: 429, message: `Rate limited by Wingbits. Backing off for ${Math.round(this.backoffMs / 1000)} s.` };
    } else if (status === 400) {
      this.error = { code: 400, message: `Wingbits rejected the ${what} request: ${err.message}` };
      this.backoffUntil = now + 5 * 60000;
    } else {
      this.backoffMs = Math.min(10 * 60000, Math.max(15000, this.backoffMs * 2));
      this.backoffUntil = now + this.backoffMs;
      this.error = { code: what === 'usage' ? 'usage' : status || 'network', message: `${what} failed: ${err.message}. Retrying in ${Math.round(this.backoffMs / 1000)} s.` };
    }
    this.broadcastStatus();
  }

  // ---------- scheduler ----------
  async tick() {
    if (this.inflight) return;
    const s = this.getSettings();
    const now = Date.now();
    if (this.halted) { this.maybeStatus(); return; }
    if (!this.usage || now - this.usageAt > USAGE_REFRESH_MS) {
      if (now >= this.backoffUntil || !this.usage) {
        this.inflight = true;
        try { await this.refreshUsage(); } finally { this.inflight = false; }
      }
      if (!this.usage) return;
    }
    if (now < this.backoffUntil) { this.maybeStatus(); return; }
    if (!this.isDemo && (s.home.lat === null || s.home.lon === null)) { this.maybeStatus(); return; }

    const b = this.budget();
    this.lastBudget = b;
    if (b.intervalSec && now - this.lastCallAt >= MIN_GAP_MS) {
      const due = this.lastPollAt + b.intervalSec * 1000;
      if (now >= due) {
        this.inflight = true;
        try { await this.poll(); } finally { this.inflight = false; }
        return;
      }
    }
    // side jobs, at most one per tick and never back to back with a poll
    if (now - this.lastCallAt < MIN_GAP_MS || b.appRemaining < 1) { this.maybeStatus(); return; }
    this.inflight = true;
    try {
      if (await this.maybeFlushDetails(b)) return;
      if (await this.maybeGps()) return;
      if (await this.maybeWatchSearch()) return;
    } finally { this.inflight = false; }
    this.maybeStatus();
  }

  home() {
    const s = this.getSettings();
    if (s.home.lat !== null && s.home.lon !== null) return { lat: s.home.lat, lon: s.home.lon };
    if (this.isDemo) return this.client.getCenter();
    return null;
  }

  async poll() {
    const s = this.getSettings();
    const home = this.home();
    if (!home) return;
    let raw;
    try {
      raw = await this.client.flightsRadius({ la: home.lat, lo: home.lon, rad: this.effectiveRadius(), minAlt: s.minAlt, maxAlt: s.maxAlt });
    } catch (err) {
      this.lastPollAt = Date.now();
      this.handleError(err, 'radar');
      return;
    }
    const now = Date.now();
    this.lastPollAt = now;
    this.backoffMs = 0;
    if (this.error && this.error.code !== 401) this.error = null;
    const list = (Array.isArray(raw) ? raw : []).map((a) => normalizeAircraft(a, now)).filter(Boolean);
    this.lastPollCount = list.length;
    const { events } = this.tracker.ingest(list, home, now);

    // queue registry lookups for aircraft we have never looked up
    const has = this.db.prepare('SELECT 1 FROM details WHERE hex = ?');
    for (const a of list) {
      if (!this.detailsQueue.has(a.h) && !has.get(a.h) && (this.detailsFailures.get(a.h) || 0) < 3) this.detailsQueue.set(a.h, now);
    }

    const snap = this.tracker.snapshot({ withTrails: s.display.trails });
    // watchlist matches from the area poll are free
    for (const a of snap) for (const w of s.watchlist) if (matchesWatch(a, w)) this.watchStatus.set(w.query, { at: now, source: 'radar', found: true, la: a.la, lo: a.lo, ab: a.ab, f: a.f, h: a.h, dist: a.dist });

    this.alerter.evaluate(snap);
    this.broadcast('snapshot', this.snapshotPayload(snap));
    this.broadcastStatus();
    return events;
  }

  snapshotPayload(snap = this.tracker.snapshot({ withTrails: this.getSettings().display.trails })) {
    const b = this.lastBudget || this.budget();
    return {
      serverTime: Date.now(), polledAt: this.lastPollAt, home: this.home(), radiusNm: this.effectiveRadius(),
      intervalSec: b.intervalSec, demo: this.isDemo, aircraft: snap,
    };
  }

  async maybeFlushDetails(b) {
    if (!this.detailsQueue.size) return false;
    const s = this.getSettings();
    if (this.callsToday('details') >= s.budget.detailsDailyCap) return false;
    const now = Date.now();
    const oldest = Math.min(...this.detailsQueue.values());
    const waitMs = b.state === 'watched' ? 45000 : 10 * 60000;
    if (this.detailsQueue.size < 50 && now - oldest < waitMs) return false;
    const batch = [...this.detailsQueue.keys()].slice(0, 100);
    let res;
    try {
      res = await this.client.details(batch);
    } catch (err) {
      for (const h of batch) this.detailsFailures.set(h, (this.detailsFailures.get(h) || 0) + 1);
      this.handleError(err, 'aircraft details');
      return true;
    }
    let newTypes = [];
    try {
      newTypes = this.storeDetails(Array.isArray(res) ? res : []);
    } catch (err) {
      console.error('could not store aircraft details:', err.message);
    }
    for (const h of batch) this.detailsQueue.delete(h);
    const snap = this.tracker.snapshot({ withTrails: s.display.trails });
    this.alerter.evaluate(snap, { newTypes });
    if (newTypes.length) this.broadcast('newtype', newTypes.map((t) => ({ typecode: t.typecode, label: t.label })));
    this.broadcast('snapshot', this.snapshotPayload(snap));
    return true;
  }

  storeDetails(results) {
    const now = Date.now();
    const ins = this.db.prepare(`INSERT OR REPLACE INTO details (hex, fetched_at, found, registration, typecode, short_type, model, manufacturer, operator, owner, built, mil, privacy, category_desc, icao_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const addType = this.db.prepare('INSERT OR IGNORE INTO types (typecode, first_seen, first_hex, label, aircraft) VALUES (?, ?, ?, ?, 0)');
    const bumpType = this.db.prepare('UPDATE types SET aircraft = aircraft + 1 WHERE typecode = ?');
    const newTypes = [];
    this.db.exec('BEGIN');
    try {
      for (const r of results) {
        const hex = String(r.icao24 || '').toLowerCase();
        if (!hex) continue;
        const d = r.details;
        if (!d) { ins.run(hex, now, 0, null, null, null, null, null, null, null, null, 0, 0, null, null); continue; }
        const privacy = d.faaLadd === true || d.faaPia === true;
        const typecode = d.typecode || d.shortType || null;
        const v = (x) => (x === undefined || x === null || x === '' ? null : String(x));
        ins.run(hex, now, 1, privacy ? null : v(d.registration), v(typecode), v(d.shortType), v(d.model), v(d.manufacturerName),
          privacy ? null : v(d.operator), privacy ? null : v(d.owner), v(d.built), d.mil ? 1 : 0, privacy ? 1 : 0, v(d.categoryDescription), v(d.icaoAircraftType));
        if (typecode) {
          const label = [d.manufacturerName, d.model].filter(Boolean).join(' ') || typecode;
          const r2 = addType.run(typecode, now, hex, label);
          if (r2.changes) newTypes.push({ typecode, label, hex });
          bumpType.run(typecode);
        }
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return newTypes;
  }

  // ---------- GPS interference overlay ----------
  async loadGps() {
    try { this.gps = JSON.parse(await fs.readFile(path.join(this.dataDir, 'gps.json'), 'utf8')); } catch { this.gps = null; }
  }

  async maybeGps() {
    const s = this.getSettings();
    if (!s.gps.enabled) return false;
    const home = this.home();
    if (!home) return false;
    const key = `${home.lat.toFixed(2)},${home.lon.toFixed(2)},${this.effectiveRadius()},${this.isDemo}`;
    if (this.gps && this.gps.key === key && Date.now() - this.gps.fetchedAt < 24 * 3600 * 1000) return false;
    if (this.gpsFailedAt && Date.now() - this.gpsFailedAt < 60 * 60000) return false;
    try {
      const res = await this.client.jam(bboxAround(home.lat, home.lon, this.effectiveRadius() * 1.2));
      const cells = (res?.hexes || []).filter((x) => x.npAvg < 8).map((x) => ({
        np: Math.round(x.npAvg * 10) / 10, n: x.aircraftCount,
        poly: cellToBoundary(x.h3Index).map(([la, lo]) => [Math.round(la * 1e4) / 1e4, Math.round(lo * 1e4) / 1e4]),
      }));
      this.gps = { key, fetchedAt: Date.now(), lastUpdated: res?.lastUpdated || null, cells };
      await fs.writeFile(path.join(this.dataDir, 'gps.json'), JSON.stringify(this.gps));
      this.broadcast('gps', this.gps);
    } catch (err) {
      this.gpsFailedAt = Date.now();
      this.handleError(err, 'GPS overlay');
    }
    return true;
  }

  // ---------- watchlist searches beyond the radar circle ----------
  async maybeWatchSearch() {
    const s = this.getSettings();
    const list = s.watchlist.filter((w) => w.search);
    if (!s.budget.watchSearch || !list.length) return false;
    if (Date.now() - this.lastWatchSearch < (s.budget.watchSearchMinutes * 60000) / list.length) return false;
    if (this.callsToday('search') >= s.budget.watchSearchDailyCap) return false;
    const w = list[this.watchCursor++ % list.length];
    const recent = this.watchStatus.get(w.query);
    this.lastWatchSearch = Date.now();
    if (recent && recent.source === 'radar' && Date.now() - recent.at < 10 * 60000) return false;
    try {
      const res = await this.client.search(w.query);
      const f = res?.flight ? normalizeAircraft(res.flight) : null;
      const home = this.home();
      this.watchStatus.set(w.query, f
        ? { at: Date.now(), source: 'search', found: true, la: f.la, lo: f.lo, ab: f.ab, f: f.f, h: f.h, gs: f.gs, dist: home ? distanceNm(home.lat, home.lon, f.la, f.lo) : null }
        : { at: Date.now(), source: 'search', found: false });
      this.broadcast('watch', this.watchPayload());
    } catch (err) {
      this.handleError(err, 'watchlist search');
    }
    return true;
  }

  watchPayload() {
    const s = this.getSettings();
    return s.watchlist.map((w) => ({ ...w, status: this.watchStatus.get(w.query) || null }));
  }

  async trackFor(hex) {
    const b = this.budget();
    if (b.appRemaining < 1) throw Object.assign(new Error('No budget left this period'), { status: 402 });
    const res = await this.client.path(hex);
    return (res?.flight?.path || []).map((p) => [p.latitude, p.longitude, p.altitude, p.timestamp, p.source || null]);
  }

  // ---------- status ----------
  status() {
    const s = this.getSettings();
    const b = this.budget();
    const usage = this.liveUsage();
    return {
      demo: this.isDemo, hasKey: Boolean(s.apiKey), needsHome: !this.isDemo && (s.home.lat === null || s.home.lon === null),
      plan: usage ? { name: usage.plan, monthlyLimit: usage.monthlyLimit, monthlyUsed: usage.monthlyUsed, monthlyRemaining: usage.monthlyRemaining, periodResetAt: usage.periodResetAt, rateLimitPerMinute: usage.rateLimitPerMinute, geoQueryMaxNm: usage.features?.geoQueryMaxNm ?? null } : null,
      budget: b, appUsed: this.state.appUsed || 0, watched: this.watched(), watchedFraction: Math.round((this.state.watchedFraction ?? 0.5) * 100) / 100,
      lastPollAt: this.lastPollAt, nextPollAt: b.intervalSec ? this.lastPollAt + b.intervalSec * 1000 : null,
      aircraft: this.lastPollCount, radiusNm: this.effectiveRadius(),
      today: { total: this.callsToday(), flights: this.callsToday('flights'), details: this.callsToday('details'), search: this.callsToday('search'), path: this.callsToday('path'), gps: this.callsToday('gps') },
      detailsQueued: this.detailsQueue.size, error: this.error, halted: this.halted,
    };
  }

  maybeStatus() {
    const now = Date.now();
    if (now - (this.lastStatusAt || 0) > 5000) this.broadcastStatus();
  }

  broadcastStatus() {
    this.lastStatusAt = Date.now();
    this.broadcast('status', this.status());
  }
}
