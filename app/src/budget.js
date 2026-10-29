// Budget engine: turns the account's remaining quota into a polling interval.
// Pure functions only, so it can be unit-tested without the network.

export const PRESETS = {
  eco: { label: 'Eco', spend: 0.5 },
  balanced: { label: 'Balanced', spend: 0.9 },
  max: { label: 'Max', spend: 1.0 },
  custom: { label: 'Custom', spend: 1.0 },
};

// Share of the app's allowance held back for non-radar calls
// (aircraft details, GPS overlay, track lookups, watchlist searches).
export const RESERVE_FRACTION = 0.08;

export const LIMITS = {
  absoluteMinSec: 5,        // never poll faster than this, whatever the plan
  watchedMaxSec: 15 * 60,   // even on a tiny budget, refresh at least every 15 min while watched
  idleMaxSec: 60 * 60,
  minSecondsToReset: 60,
};

export function inQuietHours(quiet, date = new Date()) {
  if (!quiet || !quiet.enabled) return false;
  const toMin = (s) => {
    const [h, m] = String(s || '0:0').split(':').map(Number);
    return ((h || 0) * 60 + (m || 0)) % 1440;
  };
  const start = toMin(quiet.start);
  const end = toMin(quiet.end);
  const now = date.getHours() * 60 + date.getMinutes();
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/**
 * @param {object} p
 * @param {object} p.usage   { monthlyLimit, monthlyRemaining, periodResetAt, rateLimitPerMinute }
 * @param {number} p.appUsed calls this app has made in the current period
 * @param {object} p.budget  settings.budget
 * @param {boolean} p.watched someone is looking at a radar screen right now
 * @param {boolean} p.quiet  quiet hours are active
 * @param {number} p.watchedFraction estimated share of time someone is watching (0..1)
 * @param {number} p.now     ms epoch
 */
export function computeBudget({ usage, appUsed = 0, budget, watched, quiet = false, watchedFraction = 0.5, now = Date.now() }) {
  const out = {
    state: 'paused', reason: '', intervalSec: null, watchedIntervalSec: null, idleIntervalSec: null,
    allowance: 0, appRemaining: 0, spendable: 0, secondsToReset: 0, perDay: 0, projectedAppTotal: 0,
    warning: null,
  };
  if (!usage) { out.reason = 'Waiting for plan details from Wingbits'; return out; }

  const limit = Math.max(0, Number(usage.monthlyLimit) || 0);
  const remaining = Math.max(0, Number(usage.monthlyRemaining) || 0);
  const resetAt = Date.parse(usage.periodResetAt);
  const secondsToReset = Math.max(LIMITS.minSecondsToReset, Number.isFinite(resetAt) ? (resetAt - now) / 1000 : 30 * 86400);
  out.secondsToReset = secondsToReset;

  const share = budget.share === 'percent' ? clamp(Number(budget.percent) || 0, 1, 100) / 100 : 1;
  const allowance = Math.floor(limit * share);
  const appRemaining = Math.max(0, Math.min(remaining, allowance - appUsed));
  out.allowance = allowance;
  out.appRemaining = appRemaining;

  const preset = PRESETS[budget.preset] || PRESETS.balanced;
  const spendable = appRemaining * (1 - RESERVE_FRACTION) * preset.spend;
  out.spendable = Math.floor(spendable);

  // Fastest rate the plan allows. Use at most half of the per-minute limit so
  // detail lookups and clicks never trip a 429.
  const rpm = Math.max(1, Number(usage.rateLimitPerMinute) || 12);
  const rateFloorSec = Math.max(LIMITS.absoluteMinSec, 120 / rpm);

  if (spendable < 1) {
    out.reason = appRemaining < 1 ? 'Budget used up until the monthly reset' : 'Remaining budget is held in reserve until the reset';
    return out;
  }

  const idleRatio = budget.idle === 'pause' ? 0 : 0.15;
  const p = clamp(watchedFraction, 0.05, 1);

  let watchedInterval;
  if (budget.preset === 'custom') {
    watchedInterval = Math.max(rateFloorSec, Number(budget.customInterval) || 60);
  } else {
    // calls = T * r_w * (p + (1-p) * k)  =>  r_w = calls / (T * (p + (1-p)k))
    const rw = spendable / (secondsToReset * (p + (1 - p) * idleRatio));
    watchedInterval = 1 / rw;
  }
  watchedInterval = clamp(watchedInterval, rateFloorSec, LIMITS.watchedMaxSec);
  const idleInterval = idleRatio > 0 ? clamp(watchedInterval / idleRatio, watchedInterval, LIMITS.idleMaxSec) : null;

  out.watchedIntervalSec = round1(watchedInterval);
  out.idleIntervalSec = idleInterval ? round1(idleInterval) : null;

  const projected = secondsToReset * (p / watchedInterval + (1 - p) * (idleInterval ? 1 / idleInterval : 0));
  out.projectedAppTotal = Math.round(appUsed + projected);
  out.perDay = Math.round(projected / (secondsToReset / 86400));
  if (budget.preset === 'custom' && projected > spendable) {
    const days = (spendable / projected) * (secondsToReset / 86400);
    out.warning = `At this custom rate the budget runs out in about ${days < 1 ? Math.round(days * 24) + ' hours' : Math.round(days) + ' days'}, then radar pauses until the reset.`;
  }

  if (watched && !quiet) {
    out.state = 'watched';
    out.intervalSec = out.watchedIntervalSec;
  } else if (idleInterval) {
    out.state = quiet ? 'quiet' : 'idle';
    out.intervalSec = out.idleIntervalSec;
  } else {
    out.state = 'paused';
    out.reason = quiet ? 'Quiet hours: radar paused' : 'Nobody is watching: radar paused (Settings → Budget)';
  }
  return out;
}

export function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function round1(v) { return Math.round(v * 10) / 10; }
