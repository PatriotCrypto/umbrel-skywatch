// Thin client for the Wingbits Customer API (https://customer-api.wingbits.com/docs/).
// Every request except /v1/account/usage counts against the monthly quota, so the
// client reports each counted call through onCall(kind).

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class WingbitsClient {
  constructor({ apiKey, base = 'https://customer-api.wingbits.com', onCall = () => {}, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
    this.apiKey = apiKey;
    this.base = base.replace(/\/+$/, '');
    this.onCall = onCall;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, { query, body, free = false, kind = 'other' } = {}) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const headers = { 'x-api-key': this.apiKey, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await this.fetch(url, {
        method, headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ApiError(0, `Network error: ${err.cause?.code || err.name || err.message}`);
    }
    // Count anything the server answered (except the free usage endpoint and auth failures).
    if (!free && res.status !== 401) this.onCall(kind);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
      throw new ApiError(res.status, msg, data);
    }
    return data;
  }

  usage() { return this.request('GET', '/v1/account/usage', { free: true, kind: 'usage' }); }

  flightsRadius({ la, lo, rad, minAlt, maxAlt }) {
    return this.request('GET', '/v1/flights', {
      kind: 'flights',
      query: { by: 'radius', la: round5(la), lo: round5(lo), rad, unit: 'nm', min_ab: minAlt, max_ab: maxAlt },
    });
  }

  details(hexes) {
    return this.request('POST', '/v1/flights/details', { kind: 'details', body: { icao24s: hexes } });
  }

  search(query) {
    return this.request('GET', '/v1/flights/search', { kind: 'search', query: { query } });
  }

  path(id) {
    return this.request('GET', `/v1/flights/${encodeURIComponent(id)}/path`, { kind: 'path' });
  }

  jam(bbox) {
    return this.request('GET', '/v1/gps/jam', { kind: 'gps', query: bbox });
  }
}

const round5 = (v) => Math.round(v * 1e5) / 1e5;

// Normalise one aircraft record from the live endpoints. Only h/la/lo/og are guaranteed.
export function normalizeAircraft(a, receivedAt = Date.now()) {
  if (!a || typeof a.h !== 'string' || !Number.isFinite(a.la) || !Number.isFinite(a.lo)) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  let alt = num(a.ab);
  let onGround = a.og === true || a.og === 'true' || a.og === 1;
  if (a.ab === 'ground') { alt = 0; onGround = true; }
  const ra = typeof a.ra === 'string' ? Date.parse(a.ra) : num(a.ra);
  return {
    h: a.h.toLowerCase(),
    la: a.la, lo: a.lo,
    c: typeof a.c === 'string' ? a.c.toUpperCase() : null,
    f: typeof a.f === 'string' ? a.f.trim() || null : null,
    th: num(a.th), ab: alt, ag: num(a.ag), ro: num(a.ro), gs: num(a.gs),
    sq: typeof a.sq === 'string' ? a.sq : (num(a.sq) !== null ? String(a.sq).padStart(4, '0') : null),
    t: typeof a.t === 'string' ? a.t.toUpperCase() : null,
    og: onGround,
    ra: Number.isFinite(ra) ? Math.min(ra, receivedAt) : receivedAt,
  };
}
