// Radar canvas: projection, dead reckoning between polls, sweep painting,
// input handling. Drawing itself is delegated to the active theme.
import { THEMES } from './themes.js';

const DEG = Math.PI / 180;
const BLEND_MS = 1800;
const GONE_FADE_MS = 25000;
const MAX_COAST_S = 300;
const EMG = new Set(['7500', '7600', '7700']);

export class Radar {
  constructor(canvas, { onSelect, getDisplay, onFlyby, onContact, onSweep, onBlip, onFoo }) {
    this.opts = { onFlyby, onContact, onSweep, onBlip, onFoo };
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.chassisEl = document.getElementById('chassis');
    this.onSelect = onSelect;
    this.getDisplay = getDisplay;
    this.aircraft = new Map();
    this.center = null;
    this.radiusNm = 40;
    this.rangeNm = null;
    this.clockOffset = 0;
    this.intervalSec = 60;
    this.selected = null;
    this.theme = THEMES.ww2;
    this.themeState = {};
    this.gps = null;
    this.heat = null;
    this.operator = null; // { img, name, rarity }
    this.flyby = null;
    this.lastSweep = 0;
    this.track = null; // fetched full track for the selected aircraft
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.bindInput();
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  /** Park a pre-drawn image on the canvas behind the live one (the WW2 steel cabinet), so it isn't repainted every frame */
  showChassis(src) {
    const c = this.chassisEl; if (!c) return false;
    c.width = src.width; c.height = src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    c.style.display = 'block';
    return true;
  }
  hideChassis() { if (this.chassisEl) this.chassisEl.style.display = 'none'; }

  setTheme(name) {
    this.hideChassis();
    this.theme = THEMES[name] || THEMES.ww2;
    this.themeState = {};
    this.theme.init?.(this.themeState, this);
    for (const a of this.aircraft.values()) a.paint = null;
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.themeState = {};
    this.theme.init?.(this.themeState, this);
  }

  // Equirectangular projection around home, in nautical miles (x east, y north)
  project(lat, lon) {
    const c = this.center;
    return { x: (lon - c.lon) * 60 * Math.cos(c.lat * DEG), y: (lat - c.lat) * 60 };
  }

  setData(p) {
    const now = performance.now();
    this.clockOffset = p.serverTime - Date.now();
    if (p.home) {
      const moved = !this.center || Math.abs(this.center.lat - p.home.lat) > 1e-6 || Math.abs(this.center.lon - p.home.lon) > 1e-6;
      this.center = p.home;
      if (moved) this.aircraft.clear();
    }
    if (p.radiusNm) {
      if (this.rangeNm === null || this.rangeNm > p.radiusNm * 1.25) this.rangeNm = p.radiusNm;
      this.radiusNm = p.radiusNm;
    }
    if (p.intervalSec) this.intervalSec = p.intervalSec;
    if (!this.center) return;
    const seen = new Set();
    const first = this.aircraft.size === 0;
    for (const d of p.aircraft) {
      seen.add(d.h);
      const prev = this.aircraft.get(d.h);
      if (!first && !prev) this.opts.onContact?.(d);
      else if (prev && !EMG.has(prev.d.sq) && EMG.has(d.sq)) this.opts.onContact?.(d, true);
      const base = this.project(d.la, d.lo);
      const rec = { d, base, trail: (d.trail || []).map(([la, lo, ab]) => ({ ...this.project(la, lo), ab })), corr: null, paint: prev?.paint || null, gone: null, born: prev?.born || now };
      if (prev && !prev.gone) {
        // smooth the jump from the old prediction to the new fix
        const oldPos = this.predict(prev, now, true);
        const newPos = this.predict(rec, now, false);
        const dx = oldPos.x - newPos.x; const dy = oldPos.y - newPos.y;
        if (Math.hypot(dx, dy) < 6) rec.corr = { dx, dy, t: now };
      }
      this.aircraft.set(d.h, rec);
    }
    for (const [hex, a] of this.aircraft) if (!seen.has(hex) && !a.gone) a.gone = now;
  }

  // Dead reckoning from the last fix using ground speed, heading and roll
  predict(a, now, withCorr = true) {
    const d = a.d;
    const serverNow = Date.now() + this.clockOffset;
    let t = (serverNow - d.ra) / 1000;
    const maxCoast = Math.min(MAX_COAST_S, this.intervalSec * 1.6 + 30);
    const stale = t > maxCoast;
    t = Math.max(0, Math.min(t, maxCoast));
    let { x, y } = a.base;
    let hdg = d.th ?? 0;
    if (!d.og && d.gs && d.th !== null && d.th !== undefined && d.gs > 1) {
      const v = d.gs / 3600; // nm per second
      let w = 0;
      if (d.ro && Math.abs(d.ro) > 2 && d.gs > 40) w = Math.max(-3, Math.min(3, (1091 * Math.tan(d.ro * DEG)) / d.gs)) * DEG;
      const tTurn = w ? Math.min(t, 45) : 0;
      const h0 = hdg * DEG;
      if (tTurn > 0) {
        x += (v / w) * (Math.cos(h0) - Math.cos(h0 + w * tTurn));
        y += (v / w) * (Math.sin(h0 + w * tTurn) - Math.sin(h0));
      }
      const h1 = h0 + w * tTurn;
      const rest = t - tTurn;
      x += v * rest * Math.sin(h1);
      y += v * rest * Math.cos(h1);
      hdg = ((h1 / DEG) % 360 + 360) % 360;
    }
    if (withCorr && a.corr) {
      const k = Math.min(1, (now - a.corr.t) / BLEND_MS);
      const e = 1 - k * k * (3 - 2 * k);
      x += a.corr.dx * e; y += a.corr.dy * e;
      if (k >= 1) a.corr = null;
    }
    return { x, y, hdg, stale };
  }

  /** Where the scope sits when the WW2 console surrounds it (null = fill the window) */
  setStage(rect) {
    this.stage = rect;
    this.themeState = {};
    this.theme.init?.(this.themeState, this);
  }

  geom() {
    const st = this.stage;
    if (st && this.theme.name === 'ww2') {
      const { cx, cy, R } = st;
      const rangeNm = this.rangeNm || this.radiusNm || 40;
      const scale = R / rangeNm;
      return { cx, cy, R, scale, rangeNm, toScreen: (x, y) => [cx + x * scale, cy - y * scale] };
    }
    const margin = Math.max(24, Math.min(this.w, this.h) * 0.06);
    const R = Math.min(this.w, this.h) / 2 - margin;
    const cx = this.w / 2; const cy = this.h / 2 + (this.h > this.w ? -20 : 8);
    const rangeNm = this.rangeNm || this.radiusNm || 40;
    const scale = R / rangeNm;
    return { cx, cy, R, scale, rangeNm, toScreen: (x, y) => [cx + x * scale, cy - y * scale] };
  }

  // Keep the animation alive even if one frame hits a drawing error
  frame(ts) {
    try { this.draw(); } catch (err) { if (!this.warned) { console.error('radar frame', err); this.warned = true; } }
    requestAnimationFrame(this.frame);
  }

  draw() {
    const now = performance.now();
    const ctx = this.ctx;
    const display = this.getDisplay();
    let sx = 0; let sy = 0;
    if (this.bang && !this.bang.reduced) {
      const k = Math.max(0, 1 - (now - this.bang.t0) / 900);
      sx = (Math.random() - 0.5) * 22 * k; sy = (Math.random() - 0.5) * 22 * k;
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, sx * this.dpr, sy * this.dpr);
    if (sx || sy) { ctx.fillStyle = '#000'; ctx.fillRect(-30, -30, this.w + 60, this.h + 60); }
    const g = this.geom();
    const sweepPeriod = (display.sweepSeconds || 8) * 1000;
    const sweep = ((now % sweepPeriod) / sweepPeriod) * 360;
    const boxes = [];
    // Label placement: try four corners around a contact and keep the first free one
    const place = (x, y, w, hh, gap = 9) => {
      const cand = [[x + gap, y - hh - 2], [x + gap, y + 4], [x - w - gap, y - hh - 2], [x - w - gap, y + 4]];
      let pick = cand[0];
      for (const c of cand) {
        const hit = boxes.some((b) => c[0] < b[0] + b[2] && c[0] + w > b[0] && c[1] < b[1] + b[3] && c[1] + hh > b[1]);
        if (!hit) { pick = c; break; }
      }
      boxes.push([pick[0], pick[1], w, hh]);
      return pick;
    };
    const r = { ...g, ctx, w: this.w, h: this.h, now, wall: Date.now(), display, sweep, selected: this.selected, center: this.center, radar: this, state: this.themeState, place, boxes };

    this.theme.background(r);
    this.theme.grid(r);
    // runway-lights easter egg: redraw the grid additively so every line glows
    if (this.lights) {
      const k = (now - this.lights.t0) / this.lights.ms;
      if (k >= 1) this.lights = null;
      else {
        const glow = this.lights.level * (k < 0.08 ? k / 0.08 : k > 0.75 ? (1 - k) / 0.25 : 1);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const passes = glow > 1 ? 5 : glow > 0.5 ? 3 : glow > 0.15 ? 2 : 1;
        for (let i = 0; i < passes; i++) { ctx.globalAlpha = Math.min(1, glow * 1.3); this.theme.grid(r); }
        ctx.restore();
      }
    }
    if (display.heatOverlay && this.heat && this.center) this.theme.heat?.(r, this.heat);
    if (display.gpsOverlay && this.gps?.cells?.length && this.center) this.theme.gps?.(r, this.gps.cells.map((c) => ({ ...c, pts: c.poly.map(([la, lo]) => this.project(la, lo)) })));

    const list = [];
    if (this.center) {
      for (const [hex, a] of this.aircraft) {
        let alpha = 1;
        if (a.gone) {
          alpha = 1 - (now - a.gone) / GONE_FADE_MS;
          if (alpha <= 0) { this.aircraft.delete(hex); continue; }
        }
        const p = this.predict(a, now);
        if (p.stale) alpha *= 0.55;
        const dist = Math.hypot(p.x, p.y);
        if (dist > g.rangeNm * 1.02) continue;
        a.pos = p;
        a.screen = g.toScreen(p.x, p.y);
        list.push({ a, p, alpha, dist });
      }
    }

    // sweep painting: a contact refreshes only when the beam passes it
    if (this.theme.sweep) {
      const prev = this.lastSweep;
      for (const { a, p } of list) {
        const brg = ((Math.atan2(p.x, p.y) / DEG) + 360) % 360;
        const crossed = prev <= sweep ? brg > prev && brg <= sweep : brg > prev || brg <= sweep;
        if (crossed || (!a.paint && now - a.born < 50)) {
          const hist = a.paint?.hist || [];
          if (a.paint) hist.unshift({ x: a.paint.x, y: a.paint.y });
          if (hist.length > 4) hist.pop();
          if (crossed) this.opts.onBlip?.(Math.max(-1, Math.min(1, p.x / g.rangeNm)));
          a.paint = { x: p.x, y: p.y, t: now, hist };
        }
      }
      if (sweep < prev) this.opts.onSweep?.();
      this.lastSweep = sweep;
    }

    // low first so high traffic draws on top, selected last
    list.sort((u, v) => (u.a.d.ab ?? 0) - (v.a.d.ab ?? 0));
    const sel = list.find((x) => x.a.d.h === this.selected);
    if (sel && this.track) this.theme.track?.(r, this.track.map(([la, lo]) => this.project(la, lo)));
    for (const item of list) {
      if (display.trails && item.a.trail.length > 1) this.theme.trail?.(r, item);
    }
    for (const { a } of list) if (a.screen) boxes.push([a.screen[0] - 6, a.screen[1] - 6, 12, 12]);
    for (const item of list) if (item !== sel) this.theme.aircraft(r, item, false);
    if (sel) this.theme.aircraft(r, sel, true);

    this.drawFlyby(r);
    this.drawFoo(r);
    this.drawRaid(r);
    this.theme.foreground(r, list);
    this.drawBang(r);
    this.visible = list;
  }

  // Wingnauts easter egg: now and then a little ship crosses the scope
  drawFlyby(r) {
    if (!this.operator) return;
    const now = r.now;
    // a ship crosses every 2 to 5 minutes
    if (!this.nextFlyby) this.nextFlyby = now + 30000 + Math.random() * 60000;
    if (!this.flyby && now >= this.nextFlyby) this.startFlyby();
    const f = this.flyby;
    if (!f) return;
    const k = (now - f.t0) / f.dur;
    if (k > 1) { this.flyby = null; return; }
    const ang = f.a0 + (f.a1 - f.a0) * k;
    const x = r.cx + Math.cos(ang) * r.R * 0.97;
    const y = r.cy + Math.sin(ang) * r.R * 0.97;
    f.x = x; f.y = y;
    (this.theme.flyby || THEMES.omniverse.flyby)(r, x, y, ang + Math.PI / 2);
  }

  // WW2 easter egg: now and then an unidentified glowing contact wanders across the scope
  // ("foo fighters", reported by Allied aircrews in 1944-45). Click it.
  drawFoo(r) {
    if (this.theme.name !== 'ww2') { this.foo = null; return; }
    const now = r.now; const ctx = r.ctx;
    if (!this.nextFoo) this.nextFoo = now + (8 + Math.random() * 12) * 60000;
    if (!this.foo && now >= this.nextFoo) this.spawnFoo();
    const f = this.foo;
    if (!f) return;
    const k = (now - f.t0) / f.dur;
    if (k > 1) { this.foo = null; this.nextFoo = now + (25 + Math.random() * 35) * 60000; return; }
    const t = (now - f.t0) / 1000;
    const fade = Math.min(1, k * 8, (1 - k) * 8);
    ctx.save();
    for (let i = 0; i < 3; i++) {
      const ang = f.a + (t - i * 1.1) * f.w;
      const rad = r.R * (f.r + 0.07 * Math.sin((t - i * 1.1) * 0.7));
      const x = r.cx + Math.cos(ang) * rad; const y = r.cy + Math.sin(ang) * rad;
      if (i === 0) { f.x = x; f.y = y; }
      const size = (i === 0 ? 11 : 8) * (0.85 + 0.15 * Math.sin(t * 6 + i));
      const g = ctx.createRadialGradient(x, y, 0, x, y, size * 2.4);
      const a = (i === 0 ? 0.8 : 0.5) * fade;
      g.addColorStop(0, `rgba(255,190,110,${a})`); g.addColorStop(0.4, `rgba(255,120,40,${a * 0.5})`); g.addColorStop(1, 'rgba(255,100,30,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, size * 2.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // WW2 easter egg (seven lamp tests): a huge bomber formation flies in toward the centre of the scope
  drawRaid(r) {
    const q = this.raid;
    if (!q || this.theme.name !== 'ww2') return;
    const k = (r.now - q.t0) / q.dur;
    if (k > 1) { this.raid = null; return; }
    const ctx = r.ctx; const R = r.R; const t = (r.now - q.t0) / 1000;
    const ease = k < 0.8 ? k / 0.8 : 1;                    // reach the centre at 80%, then hold and fade
    const dist = R * 1.3 * (1 - ease * ease * (3 - 2 * ease) * 0.97);
    const fade = Math.min(1, k * 10, (1 - k) * 5);
    const ux = Math.cos(q.ang); const uy = Math.sin(q.ang);   // direction from the centre to where they come from
    const hx = -ux; const hy = -uy;                            // heading (toward the centre)
    const px = -hy; const py = hx;                              // across the formation
    ctx.save();
    ctx.beginPath(); ctx.arc(r.cx, r.cy, R * 0.985, 0, Math.PI * 2); ctx.clip();
    ctx.globalAlpha = fade;
    // sectors: a warning ring pulsing out from the centre
    if (k > 0.2) { const pr = ((t * 0.9) % 1); ctx.strokeStyle = `rgba(255,70,50,${(1 - pr) * 0.5})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(r.cx, r.cy, R * (0.1 + pr * 0.9), 0, Math.PI * 2); ctx.stroke(); }
    const s = R * 0.022;
    const drawPlane = (x, y, a, size) => {
      ctx.save(); ctx.translate(x, y); ctx.rotate(a);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 3.2);
      g.addColorStop(0, 'rgba(255,120,60,.55)'); g.addColorStop(1, 'rgba(255,60,20,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, size * 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffeec2'; ctx.strokeStyle = '#ffeec2'; ctx.lineWidth = Math.max(1, size * 0.28);
      ctx.beginPath(); ctx.moveTo(size * 1.4, 0); ctx.lineTo(-size * 1.2, 0); ctx.stroke();           // fuselage
      ctx.beginPath(); ctx.moveTo(size * 0.2, -size * 1.6); ctx.lineTo(-size * 0.2, 0); ctx.lineTo(size * 0.2, size * 1.6); ctx.closePath(); ctx.fill(); // wings
      ctx.beginPath(); ctx.moveTo(-size * 1.0, -size * 0.6); ctx.lineTo(-size * 1.2, 0); ctx.lineTo(-size * 1.0, size * 0.6); ctx.closePath(); ctx.fill(); // tail
      ctx.restore();
    };
    // six combat boxes, each a stack of Vs, trailing back along the approach path
    let n = 0;
    for (let box = 0; box < 6; box++) {  // (the wedge is 6 wide; a second echelon trails behind)
    for (let ech = 0; ech < 2; ech++) {
      const bx = (box - 2.5) * s * 17; const by = Math.abs(box - 2.5) * s * 8;
      for (let row = 0; row < 5; row++) for (let side = -1; side <= 1; side += (row === 0 ? 2 : 1)) {
        if (row === 0 && side === 1) continue;
        const along = by + ech * s * 26 + row * s * 3.4; const across = bx + side * row * s * 2.6;
        const wob = Math.sin(t * 2 + n * 1.7) * s * 0.5; n++;
        const x = r.cx + ux * (dist + along) + px * (across + wob); const y = r.cy + uy * (dist + along) + py * (across + wob);
        const a = Math.atan2(hy, hx) + Math.sin(t * 1.3 + n) * 0.04;
        ctx.strokeStyle = 'rgba(255,200,140,.18)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - hx * s * 6, y - hy * s * 6); ctx.stroke();
        drawPlane(x, y, a, s * (0.75 + 0.1 * Math.sin(n)));
      }
    }
    }
    // the whole scope flickers red now and then
    if (Math.floor(t * 4) % 2 === 0) { ctx.fillStyle = 'rgba(255,40,20,.07)'; ctx.fillRect(r.cx - R, r.cy - R, R * 2, R * 2); }
    ctx.restore();
  }

  spawnFoo() {
    this.opts.onFoo?.();
    this.foo = { t0: performance.now(), dur: 45000, a: Math.random() * Math.PI * 2, w: (Math.random() > 0.5 ? 1 : -1) * (0.1 + Math.random() * 0.1), r: 0.35 + Math.random() * 0.4 };
  }

  startFlyby() {
    this.nextFlyby = performance.now() + 120000 + Math.random() * 180000;
    const a0 = Math.random() * Math.PI * 2;
    this.flyby = { t0: performance.now(), dur: 14000, a0, a1: a0 + (Math.random() > 0.5 ? 1 : -1) * 1.2 };
    this.opts.onFlyby?.(this.flyby);
  }

  lightsUp(level, ms) { this.lights = { level, t0: performance.now(), ms }; }

  // Seven clicks: flash, shockwaves, a burst of debris, a shake, and every light on
  bigBang() {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const parts = [];
    for (let i = 0; i < (reduced ? 0 : 420); i++) {
      const a = Math.random() * Math.PI * 2;
      parts.push({ a, v: 0.25 + Math.random() ** 2 * 2.6, w: 0.6 + Math.random() * 2.2, hue: Math.random() });
    }
    this.bang = { t0: performance.now(), parts, reduced };
    this.lightsUp(1.6, 9000);
  }

  drawBang(r) {
    const b = this.bang;
    if (!b) return;
    const { ctx, w, h, cx, cy } = r;
    const t = performance.now() - b.t0;
    if (t > 4200) { this.bang = null; return; }
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ffffff';
    const maxR = Math.hypot(w, h);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // core glow
    const core = Math.max(0, 1 - t / 1600);
    if (core > 0) {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * (0.15 + t / 3000));
      g.addColorStop(0, `rgba(255,255,255,${core})`);
      g.addColorStop(0.25, `rgba(255,240,200,${core * 0.6})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    }
    if (!b.reduced) {
      // shockwave rings
      for (let i = 0; i < 3; i++) {
        const tt = t - i * 260;
        if (tt <= 0) continue;
        const k = tt / 2600;
        if (k > 1) continue;
        ctx.strokeStyle = i === 1 ? accent : '#ffffff';
        ctx.globalAlpha = (1 - k) * 0.9;
        ctx.lineWidth = 34 * (1 - k) + 2;
        ctx.beginPath(); ctx.arc(cx, cy, k * maxR * 0.9, 0, Math.PI * 2); ctx.stroke();
      }
      // debris streaks
      ctx.globalAlpha = 1;
      const life = Math.max(0, 1 - t / 3200);
      for (const p of b.parts) {
        const d = p.v * t * 0.55;
        const tail = Math.min(d, 18 + p.v * 40);
        const x1 = cx + Math.cos(p.a) * d; const y1 = cy + Math.sin(p.a) * d;
        if (x1 < -50 || y1 < -50 || x1 > w + 50 || y1 > h + 50) continue;
        ctx.strokeStyle = p.hue > 0.7 ? accent : `rgba(255,${200 + Math.round(p.hue * 55)},${160 + Math.round(p.hue * 90)},1)`;
        ctx.globalAlpha = life;
        ctx.lineWidth = p.w;
        ctx.beginPath(); ctx.moveTo(x1 - Math.cos(p.a) * tail, y1 - Math.sin(p.a) * tail); ctx.lineTo(x1, y1); ctx.stroke();
      }
    }
    ctx.restore();
    // the flash itself, on top of everything
    const flash = b.reduced ? 0 : t < 90 ? 1 : Math.max(0, 1 - (t - 90) / 700);
    if (flash > 0) { ctx.fillStyle = `rgba(255,255,255,${flash})`; ctx.fillRect(0, 0, w, h); }
  }


  hit(px, py) {
    const c = this.themeState.controllerRect;
    if (c && this.theme.name === 'omniverse' && px >= c[0] && px <= c[0] + c[2] && py >= c[1] && py <= c[1] + c[3]) return { controller: true };
    if (this.flyby && Math.hypot(px - this.flyby.x, py - this.flyby.y) < 18) return { flyby: true };
    if (this.foo && this.foo.x != null && Math.hypot(px - this.foo.x, py - this.foo.y) < 28) return { foo: true };
    let best = null; let bd = 22;
    for (const { a } of this.visible || []) {
      if (!a.screen) continue;
      const dd = Math.hypot(px - a.screen[0], py - a.screen[1]);
      if (dd < bd) { bd = dd; best = a; }
    }
    return best ? { hex: best.d.h } : null;
  }

  zoom(f) {
    const max = Math.max(5, this.radiusNm * 1.2);
    this.rangeNm = Math.max(2, Math.min(max, (this.rangeNm || this.radiusNm) * f));
  }

  bindInput() {
    const c = this.canvas;
    c.addEventListener('click', (e) => {
      const hit = this.hit(e.clientX, e.clientY);
      this.onSelect(hit);
    });
    c.addEventListener('mousemove', (e) => {
      const hit = this.hit(e.clientX, e.clientY);
      c.style.cursor = hit ? 'pointer' : '';
    });
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom(e.deltaY > 0 ? 1.12 : 1 / 1.12); }, { passive: false });
    let pinch = null;
    c.addEventListener('touchstart', (e) => { if (e.touches.length === 2) pinch = dist2(e.touches); }, { passive: true });
    c.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && pinch) { const d = dist2(e.touches); this.zoom(pinch / d); pinch = d; }
    }, { passive: true });
    c.addEventListener('touchend', () => { pinch = null; });
  }
}

function dist2(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }

// Pick range-ring spacing that gives 3-6 rings in the user's units
export function ringStep(rangeNm, units) {
  const k = units === 'km' ? 1.852 : units === 'mi' ? 1.15078 : 1;
  const range = rangeNm * k;
  const steps = [0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200];
  let step = steps[steps.length - 1];
  for (const s of steps) if (range / s <= 6) { step = s; break; }
  return { stepNm: step / k, step, label: units === 'km' ? 'km' : units === 'mi' ? 'mi' : 'nm', count: Math.floor(range / step + 1e-6) };
}
