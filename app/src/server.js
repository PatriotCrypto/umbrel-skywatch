import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { loadSettings, saveSettings, publicSettings, applyUpdate } from './settings.js';
import { Engine } from './engine.js';
import { RULE_TYPES, ensureRules } from './alerts.js';
import { Wingnauts, isWallet } from './wingnauts.js';
import { WingbitsClient } from './wingbits.js';
import { CATEGORIES } from './geo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3928);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const API_BASE = process.env.WINGBITS_API_BASE || 'https://customer-api.wingbits.com';
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;

const db = openDb(DATA_DIR);
let settings = loadSettings(db);
settings.alerts.rules = ensureRules(settings.alerts.rules);
const getSettings = () => settings;

// ---------- server-sent events ----------
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

const engine = new Engine({ db, dataDir: DATA_DIR, getSettings, broadcast, apiBase: API_BASE });
const wingnauts = new Wingnauts(DATA_DIR);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error(req.method, req.path, err.message);
  res.status(err.status && err.status >= 400 && err.status < 600 ? err.status : 500).json({ error: err.message || 'Something went wrong' });
});

app.get('/api/health', (req, res) => res.json({ ok: true, version: VERSION }));

app.get('/api/state', (req, res) => {
  res.json({
    version: VERSION, settings: publicSettings(settings), status: engine.status(),
    ruleTypes: RULE_TYPES, categories: CATEGORIES,
  });
});

app.get('/api/stream', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 5000\n\n');
  clients.add(res);
  res.write(`event: snapshot\ndata: ${JSON.stringify(engine.snapshotPayload())}\n\n`);
  res.write(`event: status\ndata: ${JSON.stringify(engine.status())}\n\n`);
  if (engine.gps) res.write(`event: gps\ndata: ${JSON.stringify(engine.gps)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

app.post('/api/presence', (req, res) => {
  engine.presence(req.body?.id, req.body?.visible);
  res.json({ ok: true, watched: engine.watched() });
});

app.put('/api/settings', wrap(async (req, res) => {
  const before = settings;
  const next = applyUpdate(settings, req.body || {});
  next.alerts.rules = ensureRules(next.alerts.rules);
  if (next.apiKey && before.apiKey !== next.apiKey && req.body?.demo === undefined) next.demo = false;
  settings = next;
  saveSettings(db, settings);
  const homeChanged = before.home.lat !== next.home.lat || before.home.lon !== next.home.lon || before.radiusNm !== next.radiusNm;
  engine.configure();
  if (homeChanged) { engine.tracker.clearLive(); engine.lastPollAt = 0; }
  engine.broadcastStatus();
  res.json({ settings: publicSettings(settings), status: engine.status() });
}));

app.post('/api/test-key', wrap(async (req, res) => {
  const key = typeof req.body?.apiKey === 'string' && req.body.apiKey.trim() ? req.body.apiKey.trim() : settings.apiKey;
  if (!key) return res.status(400).json({ error: 'Enter an API key first.' });
  const client = new WingbitsClient({ apiKey: key, base: API_BASE });
  try {
    const u = await client.usage();
    res.json({ ok: true, usage: u });
  } catch (err) {
    res.status(200).json({ ok: false, status: err.status, error: err.status === 401 ? 'Wingbits did not accept this key.' : err.message });
  }
}));

app.post('/api/ntfy/test', wrap(async (req, res) => {
  try {
    const ok = await engine.alerter.push('Skywatch test', 'Notifications from your radar are working.', { priority: 3, tags: ['radar'] });
    res.json(ok ? { ok: true } : { ok: false, error: 'Set an ntfy topic first.' });
  } catch (err) { res.json({ ok: false, error: err.message }); }
}));

// ---------- spotter log ----------
const LOG_SQL = `SELECT a.*, d.found, d.registration, d.typecode, d.model, d.manufacturer, d.operator, d.mil, d.privacy
  FROM aircraft a LEFT JOIN details d ON d.hex = a.hex`;

function cleanRow(r) {
  const n = (v) => (v === null || v === undefined || Math.abs(v) >= 1e8 ? null : v);
  return {
    hex: r.hex, first: r.first_seen, last: r.last_seen, visits: r.visits, callsign: r.last_callsign, category: r.category,
    closest: n(r.closest_nm), minAlt: n(r.min_alt), maxAlt: n(r.max_alt), reg: r.privacy ? null : r.registration,
    type: r.typecode, model: r.model, manufacturer: r.manufacturer, operator: r.privacy ? null : r.operator,
    mil: Boolean(r.mil), privacy: Boolean(r.privacy), looked: r.found !== null && r.found !== undefined,
  };
}

app.get('/api/log', (req, res) => {
  const q = String(req.query.q || '').trim().toUpperCase();
  const filter = String(req.query.filter || 'all');
  const sort = { last: 'a.last_seen DESC', first: 'a.first_seen DESC', visits: 'a.visits DESC', closest: 'a.closest_nm ASC' }[req.query.sort] || 'a.last_seen DESC';
  const limit = Math.min(500, Number(req.query.limit) || 200);
  const where = [];
  const args = [];
  if (q) {
    where.push('(UPPER(a.hex) LIKE ? OR UPPER(a.last_callsign) LIKE ? OR (d.privacy = 0 AND UPPER(d.registration) LIKE ?) OR UPPER(d.typecode) LIKE ? OR UPPER(d.model) LIKE ? OR (d.privacy = 0 AND UPPER(d.operator) LIKE ?))');
    for (let i = 0; i < 6; i++) args.push(`%${q}%`);
  }
  if (filter === 'today') { where.push('a.last_seen >= ?'); args.push(startOfDay()); }
  if (filter === 'new') { where.push('a.first_seen >= ?'); args.push(startOfDay()); }
  if (filter === 'mil') where.push('d.mil = 1');
  if (filter === 'rare') where.push("(d.mil = 1 OR a.category IN ('A6','A7','B1','B2','B3','B4','B6','B7'))");
  const sql = `${LOG_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${sort} LIMIT ${limit}`;
  const rows = db.prepare(sql).all(...args).map(cleanRow);
  const totals = db.prepare('SELECT COUNT(*) AS aircraft, (SELECT COUNT(*) FROM types) AS types, (SELECT COUNT(*) FROM visits) AS visits FROM aircraft').get();
  res.json({ rows, totals });
});

app.get('/api/log.csv', (req, res) => {
  const rows = db.prepare(`${LOG_SQL} ORDER BY a.first_seen`).all().map(cleanRow);
  const cols = ['hex', 'callsign', 'reg', 'type', 'manufacturer', 'model', 'operator', 'category', 'mil', 'visits', 'closest', 'minAlt', 'maxAlt', 'first', 'last'];
  const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(c === 'first' || c === 'last' ? new Date(r[c]).toISOString() : r[c])).join(',')));
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', 'attachment; filename="skywatch-spotter-log.csv"');
  res.send(lines.join('\n'));
});

app.get('/api/lifelist', (req, res) => {
  res.json(db.prepare('SELECT typecode, label, first_seen, first_hex, aircraft FROM types ORDER BY first_seen DESC').all());
});

app.get('/api/aircraft/:hex', (req, res) => {
  const hex = String(req.params.hex).toLowerCase().replace(/[^0-9a-f~]/g, '').slice(0, 8);
  const row = db.prepare(`${LOG_SQL} WHERE a.hex = ?`).get(hex);
  const visits = db.prepare('SELECT start_ts, end_ts, callsign, min_dist_nm, min_alt, max_alt, squawk FROM visits WHERE hex = ? ORDER BY id DESC LIMIT 20').all(hex);
  res.json({ aircraft: row ? cleanRow(row) : null, visits });
});

app.post('/api/aircraft/:hex/track', wrap(async (req, res) => {
  const hex = String(req.params.hex).toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 6);
  try {
    res.json({ points: await engine.trackFor(hex) });
  } catch (err) {
    if (err.status === 404) return res.json({ points: [], message: 'Wingbits has no stored track for this aircraft right now.' });
    throw err;
  }
}));

// ---------- stats ----------
app.get('/api/stats', (req, res) => {
  const now = Date.now();
  const hourly = db.prepare('SELECT hour, aircraft FROM hourly WHERE hour >= ? ORDER BY hour').all(Math.floor(now / 1000) - 48 * 3600);
  const daily = db.prepare(`SELECT strftime('%Y-%m-%d', start_ts / 1000, 'unixepoch', 'localtime') AS day, COUNT(DISTINCT hex) AS aircraft, COUNT(*) AS visits
    FROM visits WHERE start_ts >= ? GROUP BY day ORDER BY day`).all(now - 30 * 86400000);
  const byHour = db.prepare(`SELECT CAST(strftime('%H', start_ts / 1000, 'unixepoch', 'localtime') AS INTEGER) AS h, COUNT(*) AS visits
    FROM visits WHERE start_ts >= ? GROUP BY h ORDER BY h`).all(now - 30 * 86400000);
  const topTypes = db.prepare(`SELECT d.typecode AS k, MAX(d.manufacturer || ' ' || d.model) AS label, COUNT(*) AS n FROM visits v JOIN details d ON d.hex = v.hex
    WHERE d.typecode IS NOT NULL GROUP BY d.typecode ORDER BY n DESC LIMIT 10`).all();
  const topOperators = db.prepare(`SELECT d.operator AS k, COUNT(*) AS n FROM visits v JOIN details d ON d.hex = v.hex
    WHERE d.operator IS NOT NULL AND d.privacy = 0 GROUP BY d.operator ORDER BY n DESC LIMIT 10`).all();
  const categories = db.prepare('SELECT category AS k, COUNT(*) AS n FROM aircraft WHERE category IS NOT NULL GROUP BY category ORDER BY n DESC').all();
  const totals = db.prepare(`SELECT (SELECT COUNT(*) FROM aircraft) AS aircraft, (SELECT COUNT(*) FROM types) AS types,
    (SELECT COUNT(*) FROM visits) AS visits, (SELECT COUNT(*) FROM aircraft WHERE first_seen >= ?) AS newToday,
    (SELECT COUNT(DISTINCT hex) FROM visits WHERE end_ts >= ?) AS today,
    (SELECT MIN(closest_nm) FROM aircraft WHERE closest_nm < 1e8) AS closest,
    (SELECT MIN(first_seen) FROM aircraft) AS since`).get(startOfDay(), startOfDay());
  const calls = db.prepare('SELECT day, kind, n FROM apicalls WHERE day >= ? ORDER BY day').all(new Date(now - 30 * 86400000).toISOString().slice(0, 10));
  res.json({ hourly, daily, byHour, topTypes, topOperators, categories, totals, calls });
});

app.get('/api/heatmap', (req, res) => {
  res.json(db.prepare('SELECT lat, lon, n FROM heat ORDER BY n DESC LIMIT 6000').all());
});

// ---------- alerts ----------
app.get('/api/alerts', (req, res) => res.json({ rules: settings.alerts.rules, history: engine.alerter.history(150) }));
app.delete('/api/alerts/history', (req, res) => { db.exec('DELETE FROM alerts'); res.json({ ok: true }); });

// ---------- watchlist ----------
app.get('/api/watchlist', (req, res) => res.json(engine.watchPayload()));

// ---------- GPS overlay ----------
app.get('/api/gps', (req, res) => res.json(engine.gps || null));

// ---------- Wingnauts ----------
app.get('/api/wingnauts', wrap(async (req, res) => {
  const c = await wingnauts.load();
  res.json({ ...c, items: c.items.map(({ image, ...rest }) => rest) });
}));

app.post('/api/wingnauts/refresh', wrap(async (req, res) => {
  const { wallet, rpc } = settings.wingnauts;
  if (!isWallet(wallet)) return res.status(400).json({ error: 'Add a Solana wallet address in Settings first.' });
  const c = await wingnauts.refresh({ wallet, rpc });
  res.json({ ...c, items: c.items.map(({ image, ...rest }) => rest) });
}));

app.delete('/api/wingnauts', wrap(async (req, res) => { await wingnauts.clear(); res.json({ ok: true }); }));

app.get('/api/wingnauts/img/:id', wrap(async (req, res) => {
  const c = await wingnauts.load();
  const it = c.items.find((x) => x.id === req.params.id);
  if (!it || !it.local) return res.status(404).end();
  res.setHeader('content-type', it.local);
  res.setHeader('cache-control', 'private, max-age=86400');
  fs.createReadStream(wingnauts.imagePath(it.id)).on('error', () => res.status(404).end()).pipe(res);
}));

// ---------- static UI ----------
// The budget maths is shared with the browser for the settings preview
app.get('/js/budget.js', (req, res) => res.type('text/javascript').sendFile(path.join(__dirname, 'budget.js')));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', index: 'index.html' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

function startOfDay() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Skywatch Radar ${VERSION} on :${PORT} (data in ${DATA_DIR})`);
  engine.start();
});

function shutdown() {
  engine.stop();
  engine.persist();
  for (const res of clients) res.end();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
