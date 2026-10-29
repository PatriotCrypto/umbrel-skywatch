// End-to-end: run the real server against a fake Wingbits API that follows the
// published OpenAPI spec, and check what Skywatch sends and how it paces itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY = 'test-key-1234567890';
const log = [];
let mode = 'ok';
let used = 0;

function mockWingbits() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      log.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), key: req.headers['x-api-key'], body });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers['x-api-key'] !== KEY) return send(401, { statusCode: 401, error: 'Unauthorized', message: 'Invalid API key' });
      if (url.pathname === '/v1/account/usage') {
        return send(200, { plan: 'Starter', rateLimitPerMinute: 12, monthlyLimit: 30000, monthlyUsed: used, monthlyRemaining: 30000 - used, periodResetAt: new Date(Date.now() + 20 * 86400000).toISOString(), features: { geoQueryMaxNm: 150 } });
      }
      if (mode === '429') { used++; return send(429, { statusCode: 429, error: 'Too Many Requests', message: 'Slow down' }); }
      used++;
      if (url.pathname === '/v1/flights' && req.method === 'GET') {
        const la = Number(url.searchParams.get('la')); const lo = Number(url.searchParams.get('lo'));
        return send(200, [
          { h: 'A1B2C3', la: la + 0.05, lo: lo + 0.05, c: 'A3', f: 'TST123 ', th: 90, ab: 12000, ag: 12200, gs: 300, ra: new Date().toISOString(), og: false, sq: '7700', t: 'ADSB' },
          { h: 'abc123', la: la - 0.1, lo, og: false },
          { h: 'ffff00', la, lo: lo + 0.02, ab: 'ground', og: true, c: 'C1' },
        ]);
      }
      if (url.pathname === '/v1/flights/details' && req.method === 'POST') {
        const { icao24s } = JSON.parse(body);
        return send(200, icao24s.map((h) => ({ icao24: h.toLowerCase(), details: h.toLowerCase() === 'a1b2c3' ? { icao24: 'a1b2c3', registration: 'N123TS', manufacturerName: 'Boeing', model: '737-800', typecode: 'B738', shortType: 'B738', operator: 'Test Air', owner: 'Owner LLC', built: '2010', mil: false, faaLadd: false, faaPia: false } : h.toLowerCase() === 'abc123' ? { icao24: 'abc123', registration: 'N999PV', manufacturerName: 'Gulfstream', model: 'G-V', typecode: 'GLF5', shortType: 'GLF5', operator: 'Secret Co', owner: 'Secret Owner', mil: false, faaLadd: true, faaPia: false } : null })));
      }
      if (url.pathname.endsWith('/path')) return send(200, { flight: { id: 'a1b2c3', name: 'TST123', path: [{ latitude: 39, longitude: -84, altitude: 1000, timestamp: 1, source: 'adsb' }] } });
      return send(404, { statusCode: 404, error: 'Not Found', message: 'nope' });
    });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(250); }
  throw new Error('timed out; calls so far: ' + log.map((l) => l.method + ' ' + l.path).join(', '));
}

test('talks to the Wingbits API the way the spec describes', { timeout: 90000 }, async (t) => {
  const mock = mockWingbits();
  await new Promise((r) => mock.listen(0, r));
  const apiPort = mock.address().port;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skywatch-e2e-'));
  const port = 4100 + Math.floor(Math.random() * 500);
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    cwd: path.join(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, WINGBITS_API_BASE: `http://127.0.0.1:${apiPort}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  t.after(() => { server.kill(); mock.close(); });
  const base = `http://127.0.0.1:${port}`;
  const j = async (p, opts) => { const r = await fetch(base + p, opts); return r.json(); };
  const put = (body) => j('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  await until(async () => { try { return (await j('/api/health')).ok; } catch { return false; } });

  // a wrong key is reported as such, and testing a key is free
  const bad = await j('/api/test-key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: 'nope' }) });
  assert.equal(bad.ok, false);
  const good = await j('/api/test-key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: KEY }) });
  assert.equal(good.ok, true);
  assert.equal(used, 0, 'usage checks must not consume quota');

  const saved = await put({ apiKey: KEY, home: { lat: 39.1, lon: -84.9, label: 'Test' }, radiusNm: 300, budget: { preset: 'max' } });
  assert.deepEqual(saved.settings.apiKey, { set: true, hint: '…7890' }, 'the key never goes back to the browser');
  assert.equal(saved.settings.demo, false);

  // someone is watching -> polls (a browser sends this heartbeat every 20 s)
  let visible = true;
  const beat = () => j('/api/presence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'e2e', visible }) });
  await beat();
  const hb = setInterval(beat, 15000);
  t.after(() => clearInterval(hb));
  const flightsCall = await until(() => log.find((l) => l.path === '/v1/flights'));
  assert.equal(flightsCall.key, KEY);
  assert.equal(flightsCall.query.by, 'radius');
  assert.equal(flightsCall.query.unit, 'nm');
  assert.equal(flightsCall.query.rad, '150', 'radius is capped at the plan geoQueryMaxNm');
  assert.equal(flightsCall.query.la, '39.1');

  // details are batched into one POST and privacy aircraft lose their registration
  const det = await until(() => log.find((l) => l.path === '/v1/flights/details'), 70000);
  assert.deepEqual(JSON.parse(det.body).icao24s.sort(), ['a1b2c3', 'abc123', 'ffff00']);
  const logData = await until(async () => { const d = await j('/api/log'); return d.rows.find((r) => r.hex === 'abc123' && r.looked) ? d : null; });
  const priv = logData.rows.find((r) => r.hex === 'abc123');
  assert.equal(priv.reg, null);
  assert.equal(priv.operator, null);
  assert.equal(priv.privacy, true);
  const normal = logData.rows.find((r) => r.hex === 'a1b2c3');
  assert.equal(normal.reg, 'N123TS');
  assert.equal(normal.callsign, 'TST123');

  // the 7700 squawk raised an alert without any extra API call
  const alerts = await j('/api/alerts');
  assert.ok(alerts.history.some((a) => a.kind === 'emergency' && a.hex === 'a1b2c3'));
  const lifelist = await j('/api/lifelist');
  assert.deepEqual(lifelist.map((x) => x.typecode).sort(), ['B738', 'GLF5']);

  // every counted call is tracked
  const st = (await j('/api/state')).status;
  assert.equal(st.appUsed, used, `app counted ${st.appUsed}, server saw ${used}`);
  assert.ok(st.budget.watchedIntervalSec >= 10, 'never faster than half of 12 requests/min');

  // rate limiting backs off instead of hammering
  mode = '429';
  const before = log.filter((l) => l.path !== '/v1/account/usage').length;
  await until(async () => (await j('/api/state')).status.error?.code === 429, 30000);
  await wait(12000);
  const after = log.filter((l) => l.path !== '/v1/account/usage').length;
  assert.ok(after - before <= 2, `made ${after - before} calls while rate limited`);
  mode = 'ok';

  // nobody watching + pause -> no polling at all
  await put({ budget: { idle: 'pause' } });
  visible = false;
  await beat();
  const st2 = (await j('/api/state')).status;
  assert.equal(st2.budget.state, 'paused');
  assert.ok(!/test-key-1234567890/.test(out), 'the API key is never logged');
});
