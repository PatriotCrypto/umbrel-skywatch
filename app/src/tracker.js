// Turns each radar poll into the spotter log, stats, heatmap and trails.
// Everything here works from data already fetched, so it costs no API calls.
import { distanceNm, bearingDeg, RARE_CATEGORIES, EMERGENCY_SQUAWKS, CATEGORIES } from './geo.js';

const VISIT_GAP_MS = 20 * 60 * 1000;   // unseen this long = the next sighting is a new visit
const TRAIL_POINTS = 24;
const HEAT_CELL_DEG = 0.02;            // about 1.2 nm

export class Tracker {
  constructor(db) {
    this.db = db;
    this.live = new Map();      // hex -> latest normalised record + extras
    this.trails = new Map();    // hex -> [{la, lo, ab, t}]
    this.openVisits = new Map(); // hex -> visit row id
    this.hourSet = new Set();
    this.hour = null;
    this.lastSnapshotAt = 0;
    this.stmts = {
      getAircraft: db.prepare('SELECT * FROM aircraft WHERE hex = ?'),
      insAircraft: db.prepare(`INSERT INTO aircraft (hex, first_seen, last_seen, visits, last_callsign, category, closest_nm, min_alt, max_alt, last_squawk)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`),
      updAircraft: db.prepare(`UPDATE aircraft SET last_seen = ?, visits = visits + ?, last_callsign = COALESCE(?, last_callsign),
        category = COALESCE(?, category), closest_nm = MIN(COALESCE(closest_nm, 1e9), ?),
        min_alt = MIN(COALESCE(min_alt, 1e9), COALESCE(?, 1e9)), max_alt = MAX(COALESCE(max_alt, -1e9), COALESCE(?, -1e9)),
        last_squawk = COALESCE(?, last_squawk) WHERE hex = ?`),
      insVisit: db.prepare(`INSERT INTO visits (hex, callsign, category, start_ts, end_ts, min_dist_nm, min_alt, max_alt, max_gs, squawk)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      updVisit: db.prepare(`UPDATE visits SET end_ts = ?, callsign = COALESCE(?, callsign), min_dist_nm = MIN(min_dist_nm, ?),
        min_alt = MIN(COALESCE(min_alt, 1e9), COALESCE(?, 1e9)), max_alt = MAX(COALESCE(max_alt, -1e9), COALESCE(?, -1e9)),
        max_gs = MAX(COALESCE(max_gs, 0), COALESCE(?, 0)), squawk = COALESCE(?, squawk) WHERE id = ?`),
      lastVisit: db.prepare('SELECT id, end_ts FROM visits WHERE hex = ? ORDER BY id DESC LIMIT 1'),
      hourly: db.prepare(`INSERT INTO hourly (hour, aircraft, polls) VALUES (?, ?, 1)
        ON CONFLICT(hour) DO UPDATE SET aircraft = MAX(aircraft, excluded.aircraft), polls = polls + 1`),
      heat: db.prepare(`INSERT INTO heat (cell, lat, lon, n) VALUES (?, ?, ?, 1) ON CONFLICT(cell) DO UPDATE SET n = n + 1`),
      detailsFor: db.prepare('SELECT * FROM details WHERE hex = ?'),
    };
  }

  /**
   * @returns {{ newHexes: string[], events: object[] }}
   */
  ingest(list, home, now = Date.now()) {
    const events = [];
    const newHexes = [];
    const seen = new Set();
    const hour = Math.floor(now / 3600000) * 3600;
    if (hour !== this.hour) { this.hour = hour; this.hourSet = new Set(); }

    this.db.exec('BEGIN');
    try {
      for (const a of list) {
        seen.add(a.h);
        this.hourSet.add(a.h);
        const dist = home ? distanceNm(home.lat, home.lon, a.la, a.lo) : null;
        const brg = home ? bearingDeg(home.lat, home.lon, a.la, a.lo) : null;
        const prev = this.live.get(a.h);
        const isNewHere = !prev;
        this.live.set(a.h, { ...a, dist, brg, seenAt: now });

        // trail (only when it actually moved, to keep the payload small)
        let trail = this.trails.get(a.h);
        if (!trail) { trail = []; this.trails.set(a.h, trail); }
        const last = trail[trail.length - 1];
        if (!last || Math.abs(last.la - a.la) + Math.abs(last.lo - a.lo) > 0.002) {
          trail.push({ la: a.la, lo: a.lo, ab: a.ab, t: a.ra });
          if (trail.length > TRAIL_POINTS) trail.shift();
        }

        // spotter log
        const row = this.stmts.getAircraft.get(a.h);
        const distVal = dist ?? 1e9;
        if (!row) {
          this.stmts.insAircraft.run(a.h, now, now, a.f, a.c, distVal, a.ab, a.ab, a.sq);
          newHexes.push(a.h);
          events.push({ kind: 'first', hex: a.h });
        } else {
          const newVisit = now - row.last_seen > VISIT_GAP_MS ? 1 : 0;
          this.stmts.updAircraft.run(now, newVisit, a.f, a.c, distVal, a.ab, a.ab, a.sq, a.h);
        }

        let visitId = this.openVisits.get(a.h);
        if (!visitId) {
          const lv = this.stmts.lastVisit.get(a.h);
          if (lv && now - lv.end_ts <= VISIT_GAP_MS) visitId = lv.id;
        }
        if (visitId) {
          this.stmts.updVisit.run(now, a.f, distVal, a.ab, a.ab, a.gs, a.sq, visitId);
        } else {
          const r = this.stmts.insVisit.run(a.h, a.f, a.c, now, now, distVal, a.ab, a.ab, a.gs, a.sq);
          visitId = Number(r.lastInsertRowid);
          if (row) events.push({ kind: 'return', hex: a.h });
        }
        this.openVisits.set(a.h, visitId);

        if (isNewHere) events.push({ kind: 'enter', hex: a.h });
        if (a.sq && EMERGENCY_SQUAWKS[a.sq] && (!prev || prev.sq !== a.sq)) events.push({ kind: 'emergency', hex: a.h, squawk: a.sq });

        // heatmap
        const cl = Math.round(a.la / HEAT_CELL_DEG) * HEAT_CELL_DEG;
        const co = Math.round(a.lo / HEAT_CELL_DEG) * HEAT_CELL_DEG;
        this.stmts.heat.run(`${cl.toFixed(3)},${co.toFixed(3)}`, cl, co);
      }
      this.stmts.hourly.run(hour, this.hourSet.size);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    // Aircraft not in this poll leave the live picture
    for (const hex of [...this.live.keys()]) {
      if (!seen.has(hex)) {
        this.live.delete(hex);
        this.openVisits.delete(hex);
        events.push({ kind: 'leave', hex });
      }
    }
    for (const hex of [...this.trails.keys()]) if (!this.live.has(hex)) this.trails.delete(hex);
    this.lastSnapshotAt = now;
    return { newHexes, events };
  }

  rehome(home) {
    for (const a of this.live.values()) {
      a.dist = home ? distanceNm(home.lat, home.lon, a.la, a.lo) : null;
      a.brg = home ? bearingDeg(home.lat, home.lon, a.la, a.lo) : null;
    }
  }

  clearLive() { this.live.clear(); this.trails.clear(); this.openVisits.clear(); }

  // Shape sent to the browser. Registration and owner are withheld for
  // aircraft enrolled in the FAA's LADD or PIA privacy programs.
  describe(hex) {
    const d = this.stmts.detailsFor.get(hex);
    if (!d || !d.found) return null;
    return {
      reg: d.privacy ? null : d.registration, type: d.typecode, shortType: d.short_type, model: d.model,
      manufacturer: d.manufacturer, operator: d.privacy ? null : d.operator, built: d.built,
      mil: Boolean(d.mil), privacy: Boolean(d.privacy),
    };
  }

  snapshot({ withTrails = true } = {}) {
    const out = [];
    for (const a of this.live.values()) {
      const det = this.describe(a.h);
      const rare = (a.c && RARE_CATEGORIES.has(a.c)) || det?.mil;
      out.push({
        h: a.h, la: a.la, lo: a.lo, c: a.c, f: a.f, th: a.th, ab: a.ab, ag: a.ag, ro: a.ro, gs: a.gs,
        sq: a.sq, t: a.t, og: a.og, ra: a.ra, dist: a.dist, brg: a.brg,
        emergency: a.sq && EMERGENCY_SQUAWKS[a.sq] ? EMERGENCY_SQUAWKS[a.sq] : null,
        rare: Boolean(rare), d: det,
        trail: withTrails ? (this.trails.get(a.h) || []).map((p) => [p.la, p.lo, p.ab]) : undefined,
      });
    }
    return out;
  }

  static categoryLabel(c) { return CATEGORIES[c] || null; }
}
