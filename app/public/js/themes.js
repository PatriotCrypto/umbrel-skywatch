// Four ways to draw the same sky. Each theme receives a render context `r`:
// { ctx, w, h, cx, cy, R, scale, rangeNm, toScreen, now, display, sweep, state, selected }
import { ringStep } from './radar.js';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const EMERGENCY = new Set(['7500', '7600', '7700']);

function label(d) { return d.f || d.d?.reg || d.h.toUpperCase(); }
function fl(ab) { return ab === null || ab === undefined ? '---' : String(Math.max(0, Math.round(ab / 100))).padStart(3, '0'); }
function blink(now, period = 700) { return Math.floor(now / period) % 2 === 0; }
function isMil(d) { return Boolean(d.d?.mil); }

function rings(r, draw) {
  const rs = ringStep(r.rangeNm, r.display.units);
  for (let i = 1; i <= rs.count; i++) draw(i * rs.stepNm * r.scale, `${+(i * rs.step).toFixed(1)}${i === rs.count ? ' ' + rs.label : ''}`, i, rs.count);
}

function clipScope(r) {
  r.ctx.save();
  r.ctx.beginPath();
  r.ctx.arc(r.cx, r.cy, r.R, 0, TAU);
  r.ctx.clip();
}

// The heatmap is drawn once into an offscreen canvas and reused every frame
// until the data, zoom, size or theme changes.
function heatCells(r, cells, color) {
  if (!cells.length) return;
  const { ctx, state, radar } = r;
  const key = `${cells.length}:${cells[0].n}:${r.rangeNm.toFixed(2)}:${r.w}x${r.h}:${radar.theme.name}:${radar.center?.lat},${radar.center?.lon}`;
  if (!state.heat || state.heat.key !== key) {
    const dpr = radar.dpr || 1;
    const off = document.createElement('canvas');
    off.width = Math.round(r.w * dpr); off.height = Math.round(r.h * dpr);
    const g2 = off.getContext('2d');
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    g2.beginPath(); g2.arc(r.cx, r.cy, r.R, 0, TAU); g2.clip();
    g2.globalCompositeOperation = 'lighter';
    const max = Math.max(1, cells[0].n);
    const rad = Math.max(6, 0.02 * 60 * r.scale * 1.1);
    // one shared gradient sprite, stamped with varying alpha
    const spr = document.createElement('canvas');
    const sz = Math.ceil(rad * 2 * dpr);
    spr.width = spr.height = Math.max(2, sz);
    const sg = spr.getContext('2d');
    const grad = sg.createRadialGradient(sz / 2, sz / 2, 0, sz / 2, sz / 2, sz / 2);
    grad.addColorStop(0, color(1)); grad.addColorStop(1, color(0));
    sg.fillStyle = grad; sg.fillRect(0, 0, sz, sz);
    for (const c of cells) {
      const p = radar.project(c.lat, c.lon);
      const [x, y] = r.toScreen(p.x, p.y);
      if (x < -rad || y < -rad || x > r.w + rad || y > r.h + rad) continue;
      g2.globalAlpha = 0.08 + (Math.log(1 + c.n) / Math.log(1 + max)) * 0.4;
      g2.drawImage(spr, x - rad, y - rad, rad * 2, rad * 2);
    }
    state.heat = { key, canvas: off };
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(state.heat.canvas, 0, 0);
  ctx.restore();
}

function gpsCells(r, cells, stroke, fill) {
  const { ctx } = r;
  clipScope(r);
  for (const c of cells) {
    const sev = Math.max(0.15, Math.min(1, (8 - c.np) / 8));
    ctx.beginPath();
    c.pts.forEach((p, i) => { const [x, y] = r.toScreen(p.x, p.y); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.closePath();
    ctx.fillStyle = fill(sev);
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}

function noiseTile(size, alpha) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = Math.random() * 255 * alpha;
  }
  g.putImageData(img, 0, 0);
  return c;
}

/* =====================================================================
   1. WW2 plot room — phosphor PPI scope with a rotating sweep
   ===================================================================== */
const ww2 = {
  name: 'ww2', sweep: true,
  init(s) { s.noise = noiseTile(128, 0.08); s.noiseShift = 0; },
  background(r) {
    const { ctx, w, h, cx, cy, R } = r;
    ctx.fillStyle = '#020502';
    ctx.fillRect(0, 0, w, h);
    const g = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, R);
    g.addColorStop(0, '#0c2a0c');
    g.addColorStop(0.7, '#071a07');
    g.addColorStop(1, '#041004');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();
  },
  grid(r) {
    const { ctx, cx, cy, R } = r;
    ctx.save();
    ctx.strokeStyle = 'rgba(109,255,109,0.20)';
    ctx.fillStyle = 'rgba(109,255,109,0.45)';
    ctx.font = '11px "Special Elite", monospace';
    ctx.lineWidth = 1;
    rings(r, (rad, text) => {
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, TAU); ctx.stroke();
      ctx.fillText(text, cx + 4, cy - rad + 13);
    });
    ctx.setLineDash([2, 6]);
    for (let a = 0; a < 360; a += 30) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.sin(a * DEG) * R, cy - Math.cos(a * DEG) * R);
      ctx.stroke();
    }
    ctx.restore();
    // home marker
    ctx.strokeStyle = 'rgba(109,255,109,0.7)';
    ctx.beginPath(); ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 6); ctx.stroke();
  },
  heat(r, cells) { heatCells(r, cells, (a) => `rgba(109,255,109,${a})`); },
  gps(r, cells) { gpsCells(r, cells, 'rgba(255,179,71,0.5)', (s) => `rgba(255,179,71,${0.08 + s * 0.12})`); },
  trail() {},
  track(r, pts) {
    const { ctx } = r;
    ctx.save(); ctx.setLineDash([3, 5]); ctx.strokeStyle = 'rgba(255,179,71,0.6)'; ctx.beginPath();
    pts.forEach((p, i) => { const [x, y] = r.toScreen(p.x, p.y); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke(); ctx.restore();
  },
  aircraft(r, { a, alpha }, selected) {
    const { ctx, now, display } = r;
    const d = a.d;
    if (!a.paint) return;
    const period = (display.sweepSeconds || 8) * 1000;
    const age = now - a.paint.t;
    const fade = Math.max(0, 1 - age / (period * 1.05));
    const emg = d.sq && EMERGENCY.has(d.sq);
    const glow = (x, y, k, size) => {
      const [sx, sy] = r.toScreen(x, y);
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, size * 2.6);
      const col = emg ? '255,90,74' : '150,255,140';
      g.addColorStop(0, `rgba(${col},${k})`);
      g.addColorStop(0.35, `rgba(${col},${k * 0.45})`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(sx, sy, size * 2.6, 0, TAU); ctx.fill();
      return [sx, sy];
    };
    // ghost echoes of earlier sweeps
    a.paint.hist.forEach((p, i) => glow(p.x, p.y, 0.16 * alpha * (1 - i / 5), 3));
    const size = d.c === 'A5' || d.c === 'A4' ? 5 : d.c === 'A1' || d.c === 'A7' ? 3.2 : 4;
    const [sx, sy] = glow(a.paint.x, a.paint.y, Math.max(0.12, fade) * alpha, size);
    a.screen = [sx, sy];
    if (isMil(d)) {
      ctx.strokeStyle = `rgba(150,255,140,${0.6 * alpha})`;
      ctx.strokeRect(sx - 7, sy - 7, 14, 14);
    }
    if (emg && blink(now)) {
      ctx.strokeStyle = 'rgba(255,90,74,0.9)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sx, sy, 13, 0, TAU); ctx.stroke(); ctx.lineWidth = 1;
    }
    if (display.labels || selected) {
      ctx.font = '11px "Special Elite", monospace';
      const l1 = label(d); const l2 = d.og ? 'GROUND' : `ANGELS ${d.ab == null ? '?' : Math.round(d.ab / 1000)}`;
      const [lx, ly] = r.place(sx, sy, Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width), 24);
      ctx.fillStyle = `rgba(185,245,176,${(selected ? 1 : 0.35 + fade * 0.55) * alpha})`;
      ctx.fillText(l1, lx, ly + 10);
      ctx.fillStyle = `rgba(185,245,176,${(selected ? 0.85 : 0.25 + fade * 0.4) * alpha})`;
      ctx.fillText(l2, lx, ly + 22);
    }
    if (selected) {
      ctx.strokeStyle = 'rgba(255,179,71,0.9)';
      ctx.beginPath();
      for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        ctx.moveTo(sx + dx * 12, sy + dy * 6); ctx.lineTo(sx + dx * 12, sy + dy * 12); ctx.lineTo(sx + dx * 6, sy + dy * 12);
      }
      ctx.stroke();
    }
  },
  foreground(r) {
    const { ctx, cx, cy, R, sweep, w, h, state } = r;
    // beam + afterglow
    const a = (sweep - 90) * DEG;
    ctx.save();
    clipScope(r);
    if (ctx.createConicGradient) {
      const g = ctx.createConicGradient(a - 1.2, cx, cy);
      g.addColorStop(0, 'rgba(109,255,109,0)');
      g.addColorStop(1.2 / TAU, 'rgba(109,255,109,0.20)');
      g.addColorStop(1.2 / TAU + 0.0001, 'rgba(109,255,109,0)');
      g.addColorStop(1, 'rgba(109,255,109,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, a - 1.2, a); ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(190,255,180,0.85)';
    ctx.lineWidth = 1.6;
    ctx.shadowColor = 'rgba(109,255,109,0.9)'; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); ctx.stroke();
    ctx.shadowBlur = 0;
    // grain
    state.noiseShift = (state.noiseShift + 37) % 128;
    const pat = ctx.createPattern(state.noise, 'repeat');
    ctx.translate(state.noiseShift, state.noiseShift * 0.7);
    ctx.fillStyle = pat;
    ctx.fillRect(-state.noiseShift, -state.noiseShift, w + 128, h + 128);
    ctx.restore();
    // bezel
    ctx.save();
    ctx.lineWidth = 10;
    ctx.strokeStyle = '#0e140d';
    ctx.beginPath(); ctx.arc(cx, cy, R + 6, 0, TAU); ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(109,255,109,0.35)';
    ctx.beginPath(); ctx.arc(cx, cy, R + 1, 0, TAU); ctx.stroke();
    ctx.fillStyle = 'rgba(109,255,109,0.55)';
    ctx.font = '11px "Special Elite", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let d = 0; d < 360; d += 10) {
      const rad = (d - 90) * DEG;
      const inner = d % 30 === 0 ? R - 10 : R - 5;
      ctx.strokeStyle = 'rgba(109,255,109,0.45)';
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(rad) * inner, cy + Math.sin(rad) * inner); ctx.lineTo(cx + Math.cos(rad) * R, cy + Math.sin(rad) * R); ctx.stroke();
      if (d % 30 === 0) ctx.fillText(String(d).padStart(3, '0'), cx + Math.cos(rad) * (R + 20), cy + Math.sin(rad) * (R + 20));
    }
    ctx.restore();
    // vignette
    const v = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, Math.max(w, h) * 0.75);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.65)');
    ctx.fillStyle = v; ctx.fillRect(0, 0, w, h);
  },
  flyby(r, x, y, ang) { pixelShip(r.ctx, x, y, ang, 2, ['#b9f5b0', '#6dff6d']); },
};

/* =====================================================================
   2. Control tower — modern approach-control scope with data blocks
   ===================================================================== */
const tower = {
  name: 'tower', sweep: false,
  background(r) {
    const { ctx, w, h } = r;
    ctx.fillStyle = '#080d12';
    ctx.fillRect(0, 0, w, h);
  },
  grid(r) {
    const { ctx, cx, cy, R } = r;
    ctx.save();
    ctx.strokeStyle = 'rgba(120,150,170,0.22)';
    ctx.fillStyle = 'rgba(150,180,200,0.55)';
    ctx.font = '11px "Share Tech Mono", monospace';
    rings(r, (rad, text) => {
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, TAU); ctx.stroke();
      ctx.fillText(text, cx + rad * 0.707 + 3, cy - rad * 0.707 - 3);
    });
    ctx.strokeStyle = 'rgba(120,150,170,0.12)';
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
    // compass rose
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(150,180,200,0.6)';
    for (let d = 0; d < 360; d += 5) {
      const rad = (d - 90) * DEG;
      const len = d % 30 === 0 ? 10 : d % 10 === 0 ? 6 : 3;
      ctx.strokeStyle = 'rgba(150,180,200,0.45)';
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(rad) * R, cy + Math.sin(rad) * R); ctx.lineTo(cx + Math.cos(rad) * (R - len), cy + Math.sin(rad) * (R - len)); ctx.stroke();
      if (d % 30 === 0) ctx.fillText(String(d / 10).padStart(2, '0'), cx + Math.cos(rad) * (R + 14), cy + Math.sin(rad) * (R + 14));
    }
    ctx.strokeStyle = 'rgba(150,180,200,0.4)';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = '#3fd0ff';
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, TAU); ctx.stroke();
  },
  heat(r, cells) { heatCells(r, cells, (a) => `rgba(63,208,255,${a * 0.8})`); },
  gps(r, cells) { gpsCells(r, cells, 'rgba(245,215,110,0.55)', (s) => `rgba(245,215,110,${0.05 + s * 0.12})`); },
  trail(r, { a, alpha }) {
    const { ctx } = r;
    const pts = a.trail.slice(-8);
    pts.forEach((p, i) => {
      const [x, y] = r.toScreen(p.x, p.y);
      ctx.fillStyle = `rgba(160,200,220,${(0.12 + (i / pts.length) * 0.4) * alpha})`;
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    });
  },
  track(r, pts) {
    const { ctx } = r;
    ctx.save(); ctx.strokeStyle = 'rgba(245,215,110,0.55)'; ctx.lineWidth = 1.2; ctx.beginPath();
    pts.forEach((p, i) => { const [x, y] = r.toScreen(p.x, p.y); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke(); ctx.restore();
  },
  aircraft(r, { a, p, alpha }, selected) {
    const { ctx, now, display } = r;
    const d = a.d;
    const [x, y] = a.screen;
    const emg = d.sq && EMERGENCY.has(d.sq);
    const color = emg ? '#ff4d4d' : selected ? '#f5d76e' : isMil(d) ? '#e08cff' : d.t === 'MLAT' ? '#8fb6c9' : '#e8f4fa';
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.4;
    // leader line: one minute ahead
    if (d.gs && !d.og) {
      const len = (d.gs / 120) * r.scale; // 30 s ahead
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.sin(p.hdg * DEG) * len, y - Math.cos(p.hdg * DEG) * len); ctx.stroke();
    }
    // target symbol by category
    const c = d.c || '';
    ctx.beginPath();
    if (c === 'A7') { ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y + 4); ctx.lineTo(x - 5, y + 4); ctx.closePath(); ctx.stroke(); }
    else if (c === 'A1' || c === 'A2' || c.startsWith('B')) { ctx.arc(x, y, 3.5, 0, TAU); ctx.stroke(); }
    else if (isMil(d)) { ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath(); ctx.fill(); }
    else { ctx.rect(x - 3.5, y - 3.5, 7, 7); ctx.fill(); }
    if (emg && blink(now, 500)) { ctx.beginPath(); ctx.arc(x, y, 12, 0, TAU); ctx.stroke(); }
    // data block
    if (display.labels || selected || emg) {
      ctx.font = '12px "Share Tech Mono", monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      const vr = d.og ? 'GND' : fl(d.ab);
      const lines = [label(d), `${vr} ${d.gs ? String(Math.round(d.gs / 10)).padStart(2, '0') : '--'}${emg ? ' ' + d.sq : ''}`];
      if (selected) lines.push(d.d?.type || d.c || '');
      const bw = Math.max(...lines.map((t) => ctx.measureText(t).width));
      const [bx, by] = r.place(x, y, bw, lines.length * 14, 16);
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(bx < x ? bx + bw + 2 : bx - 2, by + 7); ctx.stroke();
      lines.forEach((t, i) => ctx.fillText(t, bx, by + 11 + i * 14));
    }
    ctx.globalAlpha = 1; ctx.lineWidth = 1;
  },
  foreground(r) {
    const { ctx, w, h } = r;
    ctx.fillStyle = 'rgba(150,180,200,0.35)';
    ctx.font = '11px "Share Tech Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`RNG ${Math.round(r.rangeNm)} NM · TRUE NORTH UP`, 18, h - 96);
  },
  flyby(r, x, y, ang) { pixelShip(r.ctx, x, y, ang, 2, ['#f5d76e', '#3fd0ff']); },
};

/* =====================================================================
   3. Deep field — holographic space-station scope with altitude stalks
   ===================================================================== */
function altColor(ab, a = 1) {
  const t = Math.max(0, Math.min(1, (ab ?? 0) / 42000));
  const hue = 305 - t * 120; // magenta low → cyan high
  return `hsla(${hue}, 100%, ${62 + t * 8}%, ${a})`;
}
const space = {
  name: 'space', sweep: false,
  init(s, radar) {
    s.stars = Array.from({ length: 260 }, () => ({ x: Math.random(), y: Math.random(), z: Math.random(), tw: Math.random() * TAU }));
  },
  background(r) {
    const { ctx, w, h, cx, cy, R, now, state } = r;
    ctx.fillStyle = '#02020a';
    ctx.fillRect(0, 0, w, h);
    const n1 = ctx.createRadialGradient(w * 0.2, h * 0.25, 0, w * 0.2, h * 0.25, Math.max(w, h) * 0.6);
    n1.addColorStop(0, 'rgba(90,40,160,0.28)'); n1.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = n1; ctx.fillRect(0, 0, w, h);
    const n2 = ctx.createRadialGradient(w * 0.85, h * 0.8, 0, w * 0.85, h * 0.8, Math.max(w, h) * 0.5);
    n2.addColorStop(0, 'rgba(0,140,170,0.20)'); n2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = n2; ctx.fillRect(0, 0, w, h);
    for (const s of state.stars || []) {
      const x = ((s.x * w + now * 0.004 * (0.3 + s.z)) % w);
      const y = s.y * h;
      const a = 0.25 + 0.55 * s.z * (0.6 + 0.4 * Math.sin(now / 900 + s.tw));
      ctx.fillStyle = `rgba(210,225,255,${a})`;
      ctx.fillRect(x, y, s.z > 0.85 ? 2 : 1, s.z > 0.85 ? 2 : 1);
    }
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, 'rgba(20,40,80,0.35)'); g.addColorStop(1, 'rgba(10,10,40,0.05)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();
  },
  grid(r) {
    const { ctx, cx, cy, R, now } = r;
    ctx.save();
    ctx.shadowColor = 'rgba(89,243,255,0.7)'; ctx.shadowBlur = 6;
    ctx.font = '500 10px Orbitron, sans-serif';
    rings(r, (rad, text, i) => {
      ctx.strokeStyle = `rgba(89,243,255,${0.16 + i * 0.03})`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, TAU); ctx.stroke();
      ctx.fillStyle = 'rgba(89,243,255,0.65)';
      ctx.fillText(text.toUpperCase(), cx + 6, cy - rad - 4);
    });
    // rotating holographic arcs
    ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      const rot = (now / (9000 + i * 4000)) * (i % 2 ? -1 : 1) * TAU;
      ctx.strokeStyle = i === 1 ? 'rgba(255,79,216,0.55)' : 'rgba(89,243,255,0.5)';
      ctx.setLineDash([R * 0.18, R * 0.07]);
      ctx.beginPath(); ctx.arc(cx, cy, R * (0.985 - i * 0.022), rot, rot + Math.PI * 1.25); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
    // reticle
    ctx.strokeStyle = 'rgba(255,79,216,0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, 6, 0, TAU); ctx.moveTo(cx - 14, cy); ctx.lineTo(cx - 8, cy); ctx.moveTo(cx + 8, cy); ctx.lineTo(cx + 14, cy); ctx.stroke();
  },
  heat(r, cells) { heatCells(r, cells, (a) => `rgba(255,79,216,${a * 0.8})`); },
  gps(r, cells) { gpsCells(r, cells, 'rgba(255,211,79,0.65)', (s) => `rgba(255,211,79,${0.05 + s * 0.14})`); },
  trail(r, { a, alpha }) {
    const { ctx } = r;
    const pts = a.trail;
    ctx.beginPath();
    pts.forEach((p, i) => { const [x, y] = r.toScreen(p.x, p.y); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.strokeStyle = altColor(a.d.ab, 0.25 * alpha); ctx.lineWidth = 1.2; ctx.stroke();
  },
  track(r, pts) {
    const { ctx } = r;
    ctx.save(); ctx.strokeStyle = 'rgba(255,211,79,0.7)'; ctx.setLineDash([6, 4]); ctx.beginPath();
    pts.forEach((p, i) => { const [x, y] = r.toScreen(p.x, p.y); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke(); ctx.restore();
  },
  aircraft(r, { a, p, alpha }, selected) {
    const { ctx, now, display, R } = r;
    const d = a.d;
    const [gx, gy] = a.screen;
    const lift = d.og ? 0 : Math.min(R * 0.11, ((d.ab ?? 0) / 45000) * R * 0.11);
    const x = gx; const y = gy - lift;
    a.screen = [x, y];
    const emg = d.sq && EMERGENCY.has(d.sq);
    const col = emg ? `rgba(255,59,107,${alpha})` : isMil(d) ? `rgba(255,120,60,${alpha})` : altColor(d.ab, alpha);
    // shadow + stalk
    ctx.fillStyle = `rgba(89,243,255,${0.25 * alpha})`;
    ctx.beginPath(); ctx.ellipse(gx, gy, 3, 1.5, 0, 0, TAU); ctx.fill();
    if (lift > 2) { ctx.strokeStyle = `rgba(150,170,255,${0.22 * alpha})`; ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(x, y); ctx.stroke(); }
    ctx.save();
    ctx.translate(x, y);
    ctx.shadowColor = col; ctx.shadowBlur = selected ? 18 : 10;
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.5;
    const s = d.c === 'A5' ? 7 : d.c === 'A1' || d.c === 'A7' ? 4.5 : 5.5;
    ctx.rotate(p.hdg * DEG);
    ctx.beginPath(); ctx.moveTo(0, -s * 1.5); ctx.lineTo(s, s); ctx.lineTo(0, s * 0.4); ctx.lineTo(-s, s); ctx.closePath();
    if (isMil(d) || emg) ctx.fill(); else ctx.stroke();
    ctx.restore();
    if (emg && blink(now, 450)) { ctx.strokeStyle = 'rgba(255,59,107,0.9)'; ctx.beginPath(); ctx.arc(x, y, 15, 0, TAU); ctx.stroke(); }
    if (selected) {
      const k = (now % 1600) / 1600;
      ctx.strokeStyle = `rgba(89,243,255,${1 - k})`;
      ctx.beginPath(); ctx.arc(x, y, 10 + k * 18, 0, TAU); ctx.stroke();
    }
    if (display.labels || selected) {
      const l1 = label(d).toUpperCase(); const l2 = d.og ? 'SURFACE' : `FL${fl(d.ab)}  ${d.gs ? Math.round(d.gs) + 'KT' : ''}`;
      ctx.font = '500 10px Orbitron, sans-serif';
      const w1 = ctx.measureText(l1).width;
      ctx.font = '11px "Share Tech Mono", monospace';
      const [lx, ly] = r.place(x, y, Math.max(w1, ctx.measureText(l2).width), 24, 11);
      ctx.font = '500 10px Orbitron, sans-serif';
      ctx.fillStyle = `rgba(220,235,255,${0.85 * alpha})`;
      ctx.fillText(l1, lx, ly + 10);
      ctx.font = '11px "Share Tech Mono", monospace';
      ctx.fillStyle = col;
      ctx.fillText(l2, lx, ly + 22);
    }
  },
  foreground(r) {
    const { ctx, w, h } = r;
    ctx.strokeStyle = 'rgba(89,243,255,0.4)';
    ctx.lineWidth = 1.5;
    const m = 10; const L = 26;
    for (const [x, y, sx, sy] of [[m, m, 1, 1], [w - m, m, -1, 1], [m, h - m, 1, -1], [w - m, h - m, -1, -1]]) {
      ctx.beginPath(); ctx.moveTo(x, y + sy * L); ctx.lineTo(x, y); ctx.lineTo(x + sx * L, y); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
  },
  flyby(r, x, y, ang) { pixelShip(r.ctx, x, y, ang, 2, ['#ffd34f', '#ff4fd8']); },
};

/* =====================================================================
   4. Omniverse — pixel-art starscape in the spirit of the Wingnauts world
   ===================================================================== */
const OMNI = { bg1: '#101b25', bg2: '#1d2c39', cream: '#f6e7cf', orange: '#f26b1d', teal: '#33d1c1', purple: '#9b5de5', red: '#e84a5f', blue: '#3d7bff', ink: '#0b141c' };
// 9x9 sprites, nose up. o = outline, b = body, a = accent
const SPRITES = {
  jet: [
    '....o....', '...oao...', '...obo...', '.oobbboo.', 'oabbbbbao', '...obo...', '...obo...', '..oobool.', '..o...o..'],
  prop: [
    '...ooo...', '....o....', 'oooobooo.', 'obbbabbbo', 'oooobooo.', '....o....', '....o....', '...oao...', '.........'],
  heli: [
    'ooooooooo', '....o....', '...obo...', '..obbbo..', '..obabo..', '..obbbo..', '...obo...', '....o....', '...ooo...'],
  fighter: [
    '....o....', '...obo...', '...obo...', '..obabo..', '.obbbbbo.', 'obbobobbo', 'oo.obo.oo', '...oao...', '...o.o...'],
  balloon: [
    '..ooooo..', '.obbabbo.', 'obbbabbbo', 'obbbabbbo', '.obbabbo.', '..obbbo..', '...o.o...', '...oao...', '...ooo...'],
  saucer: [
    '.........', '...ooo...', '..oaaao..', '.obbbbbo.', 'obabababo', '.obbbbbo.', '..o...o..', '.........', '.........'],
};
function spriteFor(d) {
  if (d.c === 'A7') return SPRITES.heli;
  if (d.c === 'B2') return SPRITES.balloon;
  if (d.c === 'A6' || (isMil(d) && d.c !== 'A5')) return SPRITES.fighter;
  if (d.c === 'A1' || d.c === 'A2' || d.c === 'B1' || d.c === 'B4') return SPRITES.prop;
  if (!d.c || d.c === 'A0' || d.c === 'B6' || d.c === 'B7') return SPRITES.saucer;
  return SPRITES.jet;
}
function drawSprite(ctx, sprite, x, y, ang, px, colors) {
  const [body, accent] = colors;
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.rotate(Math.round(ang / (Math.PI / 2)) * (Math.PI / 2));
  const off = -4.5 * px;
  for (let j = 0; j < 9; j++) {
    const row = sprite[j];
    for (let i = 0; i < 9; i++) {
      const ch = row[i];
      if (ch === '.') continue;
      ctx.fillStyle = ch === 'o' || ch === 'l' ? OMNI.ink : ch === 'a' ? accent : body;
      ctx.fillRect(off + i * px, off + j * px, px, px);
    }
  }
  ctx.restore();
}
function pixelShip(ctx, x, y, ang, px, colors) { drawSprite(ctx, SPRITES.saucer, x, y, ang, px, colors); }

function pixelCircle(ctx, cx, cy, rad, step, size, color) {
  ctx.fillStyle = color;
  const n = Math.max(24, Math.floor((TAU * rad) / step));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    ctx.fillRect(Math.round(cx + Math.cos(a) * rad), Math.round(cy + Math.sin(a) * rad), size, size);
  }
}
function plus(ctx, x, y, s, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x - s, y, s * 3, s);
  ctx.fillRect(x, y - s, s, s * 3);
}

const omniverse = {
  name: 'omniverse', sweep: false,
  init(s) {
    const cols = [OMNI.orange, OMNI.red, OMNI.blue, OMNI.cream, OMNI.teal];
    s.plus = Array.from({ length: 46 }, () => ({ x: Math.random(), y: Math.random(), c: cols[Math.floor(Math.random() * cols.length)], s: Math.random() > 0.8 ? 3 : 2, ph: Math.random() * 10 }));
    s.dots = Array.from({ length: 120 }, () => ({ x: Math.random(), y: Math.random() }));
    s.arcs = Array.from({ length: 4 }, (_, i) => ({ x: Math.random(), y: Math.random() * 0.6 + 0.2, r: 0.5 + i * 0.25 }));
  },
  background(r) {
    const { ctx, w, h, now, state } = r;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, OMNI.bg1); g.addColorStop(1, OMNI.bg2);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    for (const a of state.arcs || []) pixelCircle(ctx, a.x * w, a.y * h, a.r * Math.max(w, h), 9, 1.5, 'rgba(120,150,170,0.22)');
    ctx.fillStyle = 'rgba(160,190,210,0.35)';
    for (const d of state.dots || []) ctx.fillRect(Math.round(d.x * w), Math.round(d.y * h), 2, 2);
    for (const p of state.plus || []) {
      if (Math.floor(now / 600 + p.ph) % 7 === 0) continue; // twinkle
      plus(ctx, Math.round(p.x * w), Math.round(p.y * h), p.s, p.c);
    }
  },
  grid(r) {
    const { ctx, cx, cy, R } = r;
    rings(r, (rad, text, i, n) => {
      pixelCircle(ctx, cx, cy, rad, 7, 2, i === n ? 'rgba(246,231,207,0.55)' : 'rgba(51,209,193,0.35)');
      ctx.fillStyle = 'rgba(246,231,207,0.7)';
      ctx.font = '10px Silkscreen, monospace';
      ctx.fillText(text.toUpperCase(), Math.round(cx + 6), Math.round(cy - rad - 5));
    });
    ctx.font = '700 12px Silkscreen, monospace';
    ctx.fillStyle = OMNI.orange;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0]].forEach(([t, dx, dy]) => ctx.fillText(t, cx + dx * (R + 16), cy + dy * (R + 16)));
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    // home: a little pixel beacon
    ctx.fillStyle = OMNI.orange; ctx.fillRect(cx - 3, cy - 3, 6, 6);
    ctx.fillStyle = OMNI.cream; ctx.fillRect(cx - 1, cy - 1, 2, 2);
  },
  heat(r, cells) { heatCells(r, cells, (a) => `rgba(242,107,29,${a * 0.85})`); },
  gps(r, cells) { gpsCells(r, cells, 'rgba(232,74,95,0.7)', (s) => `rgba(232,74,95,${0.06 + s * 0.14})`); },
  trail(r, { a, alpha }) {
    const { ctx } = r;
    const pts = a.trail;
    pts.forEach((p, i) => {
      if (i % 2) return;
      const [x, y] = r.toScreen(p.x, p.y);
      ctx.fillStyle = `rgba(51,209,193,${(0.15 + (i / pts.length) * 0.5) * alpha})`;
      ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, 3, 3);
    });
  },
  track(r, pts) {
    const { ctx } = r;
    pts.forEach((p, i) => {
      if (i % 2) return;
      const [x, y] = r.toScreen(p.x, p.y);
      ctx.fillStyle = 'rgba(242,107,29,0.6)';
      ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, 3, 3);
    });
  },
  aircraft(r, { a, p, alpha }, selected) {
    const { ctx, now, display } = r;
    const d = a.d;
    const [x, y] = a.screen;
    const emg = d.sq && EMERGENCY.has(d.sq);
    const body = emg ? OMNI.red : isMil(d) ? OMNI.purple : d.ab != null && d.ab < 10000 ? OMNI.teal : OMNI.orange;
    ctx.globalAlpha = alpha;
    const px = d.c === 'A5' ? 3 : 2;
    drawSprite(ctx, spriteFor(d), x, y, p.hdg * DEG, px, [body, OMNI.cream]);
    if (!d.og && d.gs > 1) {
      // exact heading: two pixels ahead of the nose
      ctx.fillStyle = OMNI.cream;
      for (const k of [8, 11]) ctx.fillRect(Math.round(x + Math.sin(p.hdg * DEG) * k * px * 0.75) - 1, Math.round(y - Math.cos(p.hdg * DEG) * k * px * 0.75) - 1, 2, 2);
    }
    if ((emg && blink(now, 400)) || selected) {
      const s = 16;
      ctx.fillStyle = emg ? OMNI.red : OMNI.cream;
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        ctx.fillRect(Math.round(x + dx * s - 2), Math.round(y + dy * s - 2), 4, 4);
      }
    }
    if (display.labels || selected) {
      ctx.font = '10px Silkscreen, monospace';
      const t = label(d);
      const tw = ctx.measureText(t).width;
      let [lx, ly] = r.place(x, y, tw + 6, 24, 13);
      lx = Math.round(lx); ly = Math.round(ly);
      ctx.fillStyle = 'rgba(11,20,28,0.75)';
      ctx.fillRect(lx, ly, tw + 6, 24);
      ctx.fillStyle = OMNI.cream;
      ctx.fillText(t, lx + 3, ly + 10);
      ctx.fillStyle = body;
      ctx.fillText(d.og ? 'GROUND' : `${d.ab == null ? '???' : Math.round(d.ab / 100)}`, lx + 3, ly + 21);
    }
    ctx.globalAlpha = 1;
  },
  foreground(r) {
    const { ctx, w, h, radar } = r;
    // chunky frame
    ctx.fillStyle = OMNI.ink;
    ctx.fillRect(0, 0, w, 4); ctx.fillRect(0, h - 4, w, 4); ctx.fillRect(0, 0, 4, h); ctx.fillRect(w - 4, 0, 4, h);
    // Wingnaut controller portrait
    const op = radar.operator;
    const want = { small: 96, medium: 160, large: 240, xl: 340 }[r.display.controllerSize || 'large'] || 240;
    const size = Math.round(Math.max(72, Math.min(want, h - 300, w * 0.32)));
    const x = 22; const y = h - size - 140;
    if (y < 90) { r.state.controllerRect = null; return; }
    r.state.controllerRect = [x - 4, y - 4, size + 8, size + 44];
    const border = op?.rarityColor || OMNI.teal;
    ctx.fillStyle = OMNI.ink; ctx.fillRect(x - 6, y - 6, size + 12, size + 48);
    ctx.fillStyle = border; ctx.fillRect(x - 3, y - 3, size + 6, size + 6);
    ctx.fillStyle = OMNI.ink; ctx.fillRect(x, y, size, size);
    if (op?.img?.complete && op.img.naturalWidth) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(op.img, x, y, size, size);
      ctx.imageSmoothingEnabled = true;
    } else {
      // placeholder: a tiny radar dish
      const s = size / 12;
      ctx.fillStyle = OMNI.teal;
      for (const [i, j] of [[3, 3], [4, 3], [5, 3], [6, 3], [7, 3], [2, 4], [8, 4], [2, 5], [8, 5], [3, 6], [7, 6], [4, 7], [5, 7], [6, 7], [5, 8], [5, 9], [4, 9], [6, 9]]) ctx.fillRect(x + i * s, y + j * s, s, s);
      ctx.fillStyle = OMNI.orange; ctx.fillRect(x + 5 * s, y + 5 * s, s, s);
    }
    const fs = size >= 200 ? 13 : 10;
    ctx.font = `${fs}px Silkscreen, monospace`;
    ctx.fillStyle = OMNI.cream;
    const num = op ? String(op.name || '').replace(/^wingnaut\s*/i, '').trim() : '';
    ctx.fillText(op ? `CONTROLLER ${num}` : 'NO CONTROLLER', x, y + size + fs + 6);
    ctx.fillStyle = op ? border : 'rgba(246,231,207,0.55)';
    ctx.fillText(op ? (op.rarity || 'WINGNAUT').toUpperCase() : 'ADD ONE IN SETTINGS', x, y + size + fs * 2 + 10);
  },
  flyby(r, x, y, ang) { pixelShip(r.ctx, x, y, ang, 3, [OMNI.orange, OMNI.cream]); },
};

export const THEMES = { ww2, tower, space, omniverse };
export const THEME_META = {
  ww2: { title: 'WW2 plot room', sub: 'Phosphor scope with a rotating sweep', brand: 'SKYWATCH', tagline: 'Chain Home · plot room', swatch: ['#030703', '#6dff6d', '#ffb347'] },
  tower: { title: 'Control tower', sub: 'Approach scope, data blocks, leader lines', brand: 'SKYWATCH APP', tagline: 'Approach control', swatch: ['#0a0f14', '#e8f4fa', '#3fd0ff'] },
  space: { title: 'Deep field', sub: 'Holographic station scope with altitude stalks', brand: 'SKYWATCH//DEEP FIELD', tagline: 'Orbital tracking array', swatch: ['#03030a', '#59f3ff', '#ff4fd8'] },
  omniverse: { title: 'Omniverse', sub: 'Pixel starscape with your Wingnaut as controller', brand: 'SKYWATCH OMNIVERSE', tagline: 'Signals from the static', swatch: ['#121e28', '#f26b1d', '#33d1c1'] },
};
export const RARITY_COLORS = { common: '#33d1c1', uncommon: '#f26b1d', rare: '#3d7bff', epic: '#9b5de5', legendary: '#ffd166', mythic: '#e84a5f' };
