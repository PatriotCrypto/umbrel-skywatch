import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBudget, inQuietHours } from '../src/budget.js';

const DAY = 86400000;
const now = Date.parse('2026-11-01T00:00:00Z');
const usage = (over = {}) => ({
  monthlyLimit: 30000, monthlyUsed: 0, monthlyRemaining: 30000, rateLimitPerMinute: 12,
  periodResetAt: new Date(now + 30 * DAY).toISOString(), ...over,
});
const budget = (over = {}) => ({ share: 'all', percent: 100, preset: 'balanced', customInterval: 60, idle: 'slow', quiet: { enabled: false }, ...over });

function projectedMonth(b, watchedFraction) {
  const secs = 30 * 86400;
  return secs * (watchedFraction / b.watchedIntervalSec + (1 - watchedFraction) / b.idleIntervalSec);
}

test('30k calls with someone watching half the time stays inside the plan', () => {
  const b = computeBudget({ usage: usage(), budget: budget(), watched: true, watchedFraction: 0.5, now });
  assert.equal(b.state, 'watched');
  const total = projectedMonth(b, 0.5);
  assert.ok(total <= 30000 * 0.92 * 0.9 + 1, `projected ${total}`);
  assert.ok(total > 30000 * 0.92 * 0.9 * 0.97, `should use most of the budget, got ${total}`);
  assert.ok(b.watchedIntervalSec > 40 && b.watchedIntervalSec < 70, `watched interval ${b.watchedIntervalSec}`);
});

test('idle rate is slower than watched', () => {
  const b = computeBudget({ usage: usage(), budget: budget(), watched: false, now });
  assert.equal(b.state, 'idle');
  assert.ok(b.intervalSec > b.watchedIntervalSec * 5);
});

test('pause when nobody is watching', () => {
  const b = computeBudget({ usage: usage(), budget: budget({ idle: 'pause' }), watched: false, now });
  assert.equal(b.state, 'paused');
  assert.equal(b.intervalSec, null);
});

test('sharing 50% doubles the interval', () => {
  const full = computeBudget({ usage: usage(), budget: budget(), watched: true, now });
  const half = computeBudget({ usage: usage(), budget: budget({ share: 'percent', percent: 50 }), watched: true, now });
  assert.ok(Math.abs(half.watchedIntervalSec / full.watchedIntervalSec - 2) < 0.05);
});

test('app usage counts against its share, other apps count against the account', () => {
  const b = computeBudget({ usage: usage({ monthlyRemaining: 1000 }), appUsed: 0, budget: budget(), watched: true, now });
  assert.equal(b.appRemaining, 1000);
  const c = computeBudget({ usage: usage(), appUsed: 14500, budget: budget({ share: 'percent', percent: 50 }), watched: true, now });
  assert.equal(c.appRemaining, 500);
});

test('never faster than half the rate limit or 5 s', () => {
  const b = computeBudget({ usage: usage({ monthlyLimit: 1e9, monthlyRemaining: 1e9 }), budget: budget({ preset: 'max' }), watched: true, now });
  assert.equal(b.watchedIntervalSec, 10); // 12 rpm -> one every 10 s
  const big = computeBudget({ usage: usage({ monthlyLimit: 1e9, monthlyRemaining: 1e9, rateLimitPerMinute: 480 }), budget: budget({ preset: 'max' }), watched: true, now });
  assert.equal(big.watchedIntervalSec, 5);
});

test('exhausted budget pauses', () => {
  const b = computeBudget({ usage: usage({ monthlyRemaining: 0 }), budget: budget(), watched: true, now });
  assert.equal(b.state, 'paused');
  assert.match(b.reason, /used up/);
});

test('custom rate warns when it would run out early', () => {
  const b = computeBudget({ usage: usage(), budget: budget({ preset: 'custom', customInterval: 10 }), watched: true, watchedFraction: 1, now });
  assert.equal(b.watchedIntervalSec, 10);
  assert.ok(b.warning && /runs out/.test(b.warning));
});

test('eco spends about half of balanced', () => {
  const bal = computeBudget({ usage: usage(), budget: budget(), watched: true, now });
  const eco = computeBudget({ usage: usage(), budget: budget({ preset: 'eco' }), watched: true, now });
  assert.ok(Math.abs(eco.watchedIntervalSec / bal.watchedIntervalSec - 1.8) < 0.05);
});

test('quiet hours wrap past midnight', () => {
  const q = { enabled: true, start: '23:00', end: '06:00' };
  const at = (h, m = 0) => { const d = new Date(2026, 10, 1, h, m); return d; };
  assert.equal(inQuietHours(q, at(23, 30)), true);
  assert.equal(inQuietHours(q, at(3)), true);
  assert.equal(inQuietHours(q, at(6)), false);
  assert.equal(inQuietHours(q, at(12)), false);
  assert.equal(inQuietHours({ ...q, enabled: false }, at(3)), false);
});

test('quiet hours follow the timezone given, not the server clock', () => {
  const q = { enabled: true, start: '00:00', end: '06:00', tz: 'America/New_York' };
  const utc0125 = new Date(Date.UTC(2026, 9, 30, 1, 25)); // 21:25 on Oct 29 in New York
  assert.equal(inQuietHours(q, utc0125), false);
  assert.equal(inQuietHours({ ...q, tz: 'UTC' }, utc0125), true);
  assert.equal(inQuietHours(q, new Date(Date.UTC(2026, 9, 30, 7, 0))), true); // 03:00 in New York
  assert.equal(inQuietHours({ ...q, tz: 'Not/AZone' }, utc0125) === inQuietHours({ ...q, tz: '' }, utc0125), true);
});

test('quiet hours slow the radar even when a screen is open', () => {
  const b = computeBudget({ usage: usage(), budget: budget(), watched: true, quiet: true, now });
  assert.equal(b.state, 'quiet');
  assert.equal(b.intervalSec, b.idleIntervalSec);
});
