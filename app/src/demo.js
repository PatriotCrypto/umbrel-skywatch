// Demo mode: a small air-traffic simulation that answers the same calls as the
// real Wingbits client. Used before an API key is set, for screenshots and tests.
// All airlines, callsigns and registrations here are made up.
import { destination, distanceNm, bearingDeg } from './geo.js';
import { latLngToCell, gridDisk } from 'h3-js';

const AIRLINES = [
  { name: 'Meridian Air', icao: 'MDN' }, { name: 'Northstar Express', icao: 'NSE' },
  { name: 'Ohio Valley Air', icao: 'OVA' }, { name: 'Redbird Cargo', icao: 'RBC' },
  { name: 'Liberty Airways', icao: 'LBY' },
];
const TYPES = {
  airliner: [
    ['B738', 'Boeing', '737-800', 'A3'], ['A320', 'Airbus', 'A320-214', 'A3'], ['A321', 'Airbus', 'A321-231', 'A3'],
    ['E175', 'Embraer', 'ERJ-175', 'A3'], ['CRJ9', 'Bombardier', 'CRJ-900', 'A3'], ['B789', 'Boeing', '787-9', 'A5'],
    ['B77W', 'Boeing', '777-300ER', 'A5'], ['B752', 'Boeing', '757-200', 'A4'], ['A359', 'Airbus', 'A350-900', 'A5'],
  ],
  ga: [
    ['C172', 'Cessna', '172S Skyhawk', 'A1'], ['PA28', 'Piper', 'PA-28-181 Archer', 'A1'], ['SR22', 'Cirrus', 'SR22', 'A1'],
    ['RV12', "Van's Aircraft", 'RV-12iS', 'A1'], ['BE36', 'Beechcraft', 'A36 Bonanza', 'A1'],
  ],
  heli: [['R44', 'Robinson', 'R44 Raven II', 'A7'], ['EC35', 'Airbus Helicopters', 'H135', 'A7'], ['B407', 'Bell', '407', 'A7']],
  mil: [['C17', 'Boeing', 'C-17A Globemaster III', 'A5'], ['K35R', 'Boeing', 'KC-135R Stratotanker', 'A5'], ['F16', 'General Dynamics', 'F-16C Fighting Falcon', 'A6'], ['H60', 'Sikorsky', 'UH-60 Black Hawk', 'A7']],
  biz: [['GLF5', 'Gulfstream', 'G-V', 'A2'], ['C68A', 'Cessna', 'Citation Latitude', 'A2']],
  balloon: [['BALL', 'Cameron Balloons', 'Hot air balloon', 'B2']],
};

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_CENTER = { lat: 40.6413, lon: -73.7781 };

export class DemoClient {
  constructor({ getCenter, getRadius }) {
    this.getCenter = () => {
      const c = getCenter();
      return c && Number.isFinite(c.lat) && Number.isFinite(c.lon) ? c : DEFAULT_CENTER;
    };
    this.getRadius = getRadius;
    this.rand = rng(Date.now() & 0xffffffff);
    this.sims = new Map();
    this.registry = new Map();
    this.lastStep = Date.now();
    this.used = 0;
    this.isDemo = true;
    this.centerKey = '';
  }

  pick(arr) { return arr[Math.floor(this.rand() * arr.length)]; }

  newHex() {
    let h;
    do { h = (0xa00000 + Math.floor(this.rand() * 0x0fffff)).toString(16); } while (this.registry.has(h));
    return h;
  }

  newReg() {
    const n = 100 + Math.floor(this.rand() * 9800);
    const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
    return `N${n}${letters[Math.floor(this.rand() * letters.length)]}${this.rand() > 0.5 ? letters[Math.floor(this.rand() * letters.length)] : ''}`;
  }

  spawn(kind, center, radius, now, inside = false) {
    const [typecode, manufacturer, model, cat] = this.pick(TYPES[kind]);
    const hex = this.newHex();
    const reg = this.newReg();
    const airline = kind === 'airliner' ? this.pick(AIRLINES) : null;
    let callsign = reg;
    if (airline) callsign = `${airline.icao}${100 + Math.floor(this.rand() * 4800)}`;
    if (kind === 'mil') callsign = this.pick(['REACH', 'TEAL', 'VIPER', 'DUDE', 'ATLAS']) + (10 + Math.floor(this.rand() * 89));
    const privacy = kind === 'biz' && this.rand() > 0.4;
    this.registry.set(hex, {
      icao24: hex, registration: privacy ? null : reg, manufacturerName: manufacturer, model, typecode,
      shortType: typecode, operator: airline ? airline.name : kind === 'mil' ? 'United States Air Force' : null,
      owner: null, built: String(1995 + Math.floor(this.rand() * 30)), mil: kind === 'mil',
      faaLadd: privacy, faaPia: false, categoryDescription: null, icaoAircraftType: null,
    });

    const startBearing = this.rand() * 360;
    const pos = inside
      ? destination(center.lat, center.lon, startBearing, radius * Math.sqrt(this.rand()) * 0.8)
      : destination(center.lat, center.lon, startBearing, radius * 1.08);
    const inward = (startBearing + 180 + (this.rand() - 0.5) * 70 + 360) % 360;
    const profile = {
      airliner: () => ({ alt: 28000 + Math.round(this.rand() * 11) * 1000, gs: 420 + this.rand() * 80, vr: 0 }),
      ga: () => ({ alt: 2500 + Math.round(this.rand() * 6) * 500, gs: 95 + this.rand() * 40, vr: 0 }),
      heli: () => ({ alt: 700 + Math.round(this.rand() * 10) * 100, gs: 85 + this.rand() * 40, vr: 0 }),
      mil: () => ({ alt: cat === 'A6' ? 18000 + this.rand() * 8000 : 22000 + this.rand() * 10000, gs: cat === 'A6' ? 420 + this.rand() * 80 : 380 + this.rand() * 60, vr: 0 }),
      biz: () => ({ alt: 37000 + Math.round(this.rand() * 8) * 1000, gs: 440 + this.rand() * 40, vr: 0 }),
      balloon: () => ({ alt: 1200 + this.rand() * 1500, gs: 6 + this.rand() * 6, vr: 0 }),
    }[kind]();
    // Some airliners arrive into a pretend field 12 nm north-east of home
    let target = null;
    if (kind === 'airliner' && this.rand() < 0.35) {
      target = destination(center.lat, center.lon, 45, Math.min(12, radius * 0.4));
      profile.alt = 9000 + this.rand() * 4000;
      profile.gs = 260 + this.rand() * 40;
    }
    const sim = {
      hex, kind, cat, callsign, lat: pos.lat, lon: pos.lon,
      hdg: inside ? this.rand() * 360 : inward, turn: 0, ...profile, target,
      born: now, sq: kind === 'ga' ? '1200' : String(1000 + Math.floor(this.rand() * 6777)).replace(/[89]/g, '1'),
      src: this.rand() < 0.08 ? 'MLAT' : 'ADSB',
    };
    this.sims.set(hex, sim);
    return sim;
  }

  step(now) {
    const center = this.getCenter();
    const radius = Math.max(5, this.getRadius());
    const key = `${center.lat.toFixed(3)},${center.lon.toFixed(3)},${radius}`;
    if (key !== this.centerKey) { this.sims.clear(); this.centerKey = key; this.lastStep = now; }
    let dt = Math.min(600, (now - this.lastStep) / 1000);
    this.lastStep = now;

    // Integrate in 2 s steps so turns look natural even after a long gap
    while (dt > 0) {
      const h = Math.min(2, dt);
      dt -= h;
      for (const s of this.sims.values()) {
        if (s.kind === 'ga' || s.kind === 'heli') {
          if (this.rand() < 0.01 * h) s.turn = (this.rand() - 0.5) * 6;
          if (this.rand() < 0.02 * h) s.turn = 0;
          // drift back toward the middle if wandering out
          const dist = distanceNm(center.lat, center.lon, s.lat, s.lon);
          if (dist > radius * 0.85 && s.born > 0) {
            const back = bearingDeg(s.lat, s.lon, center.lat, center.lon);
            const diff = ((back - s.hdg + 540) % 360) - 180;
            s.turn = Math.sign(diff) * 3;
          }
        }
        if (s.target) {
          const want = bearingDeg(s.lat, s.lon, s.target.lat, s.target.lon);
          const diff = ((want - s.hdg + 540) % 360) - 180;
          s.turn = Math.max(-2, Math.min(2, diff * 0.2));
          const d = distanceNm(s.lat, s.lon, s.target.lat, s.target.lon);
          s.alt = Math.max(1500, Math.min(s.alt, d * 320));
          s.gs = Math.max(140, Math.min(s.gs, 140 + d * 8));
          if (d < 1.5) { s.gone = true; }
        }
        s.hdg = (s.hdg + s.turn * h + 360) % 360;
        const p = destination(s.lat, s.lon, s.hdg, (s.gs * h) / 3600);
        s.lat = p.lat; s.lon = p.lon;
      }
    }

    for (const [hex, s] of this.sims) {
      const d = distanceNm(center.lat, center.lon, s.lat, s.lon);
      if (s.gone || d > radius * 1.25) this.sims.delete(hex);
    }

    // Keep the sky busy: about one aircraft per 2 nm of radius, up to 40
    const target = Math.min(40, Math.round(radius / 2) + 4);
    let guard = 0;
    while (this.sims.size < target && guard++ < 60) {
      const roll = this.rand();
      const kind = roll < 0.55 ? 'airliner' : roll < 0.78 ? 'ga' : roll < 0.86 ? 'heli' : roll < 0.92 ? 'mil' : roll < 0.985 ? 'biz' : 'balloon';
      this.spawn(kind, center, radius, now, this.sims.size < target / 2);
    }

    // A scripted emergency squawk for 3 minutes every 40 minutes
    const cycle = Math.floor(now / 2400000);
    const inEmergency = now % 2400000 < 180000;
    for (const s of this.sims.values()) {
      if (s.emergencyCycle === cycle && !inEmergency) { s.sq = s.prevSq; delete s.emergencyCycle; }
    }
    if (inEmergency && ![...this.sims.values()].some((s) => s.emergencyCycle === cycle)) {
      const s = [...this.sims.values()].find((x) => x.kind === 'airliner');
      if (s) { s.prevSq = s.sq; s.sq = '7700'; s.emergencyCycle = cycle; }
    }
  }

  toApi(s, now) {
    return {
      h: s.hex, la: s.lat, lo: s.lon, c: s.cat, f: s.callsign, th: Math.round(s.hdg * 10) / 10,
      ab: Math.round(s.alt / 25) * 25, ag: Math.round((s.alt + 175) / 25) * 25,
      ro: Math.round(s.turn * 4 * 10) / 10, ra: new Date(now - Math.floor(this.rand() * 1500)).toISOString(),
      og: false, sq: s.sq, gs: Math.round(s.gs * 10) / 10, t: s.src,
    };
  }

  count(kind) { this.used++; if (this.onCall) this.onCall(kind); }

  async usage() {
    const now = new Date();
    const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return {
      plan: 'Demo', rateLimitPerMinute: 12, monthlyLimit: 30000, monthlyUsed: this.used,
      monthlyRemaining: 30000 - this.used, periodResetAt: reset.toISOString(), features: { geoQueryMaxNm: 150 },
    };
  }

  async flightsRadius({ la, lo, rad, minAlt, maxAlt }) {
    const now = Date.now();
    this.step(now);
    this.count("flights");
    const out = [];
    for (const s of this.sims.values()) {
      if (distanceNm(la, lo, s.lat, s.lon) > rad) continue;
      if (minAlt != null && s.alt < minAlt) continue;
      if (maxAlt != null && s.alt > maxAlt) continue;
      out.push(this.toApi(s, now));
    }
    return out;
  }

  async details(hexes) {
    this.count("details");
    return hexes.map((h) => ({ icao24: h.toLowerCase(), details: this.registry.get(h.toLowerCase()) || null }));
  }

  async search(query) {
    this.count("search");
    const q = query.toUpperCase();
    for (const s of this.sims.values()) {
      const reg = this.registry.get(s.hex)?.registration;
      if (s.callsign === q || s.hex.toUpperCase() === q || reg === q) return { flight: this.toApi(s, Date.now()) };
    }
    return { flight: null, message: 'No live flight found' };
  }

  async path(id) {
    this.count("path");
    const s = this.sims.get(String(id).toLowerCase());
    if (!s) { const e = new Error('Not found'); e.status = 404; throw e; }
    const pts = [];
    const back = (s.hdg + 180) % 360;
    for (let i = 30; i >= 0; i--) {
      const p = destination(s.lat, s.lon, back, (s.gs * i * 20) / 3600);
      pts.push({ latitude: p.lat, longitude: p.lon, altitude: Math.round(s.alt), timestamp: Date.now() - i * 20000, source: 'adsb' });
    }
    return { flight: { id: s.hex, name: s.callsign, path: pts } };
  }

  async jam() {
    this.count("gps");
    const c = this.getCenter();
    const r = this.getRadius();
    const patch = destination(c.lat, c.lon, 250, Math.max(8, r * 0.6));
    const cells = gridDisk(latLngToCell(patch.lat, patch.lon, 5), 2);
    return {
      lastUpdated: new Date().toISOString(),
      hexes: cells.map((h, i) => ({ h3Index: h, sampleCount: 200 + i * 10, aircraftCount: 12 + i, npAvg: 3 + (i % 5), aircraftHours: 30 })),
    };
  }
}
