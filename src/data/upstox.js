'use strict';

// Upstox API provider (realtime, uses YOUR access token from .env).
// - Candles: v3 historical-candle API (supports 15minute; v2 did not).
// - LTP:     v2 market-quote/ltp, used when the V3 market-data websocket is down.
// Docs shapes verified 2026-10-15: candles come back as
// [isoTimestamp, open, high, low, close, volume, oi], newest first.

const dns = require('dns');
const { config } = require('../config');
const { summarizePortfolio } = require('../portfolio');

const BASE = 'https://api.upstox.com';

// Prefer IPv4 so order APIs match Upstox static-IP allowlist (IPv6 often mismatches).
try {
  if (typeof dns.setDefaultResultOrder === 'function') dns.setDefaultResultOrder('ipv4first');
} catch (_) {
  /* ignore */
}

let ipv4Dispatcher = null;
function getIpv4Dispatcher() {
  if (ipv4Dispatcher) return ipv4Dispatcher;
  try {
    const { Agent } = require('undici');
    ipv4Dispatcher = new Agent({ connect: { family: 4 } });
  } catch (_) {
    ipv4Dispatcher = null;
  }
  return ipv4Dispatcher;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimited(status, body) {
  if (status === 429) return true;
  const text = String(body || '');
  return (
    text.includes('UDAPI10005')
    || /Too Many Request/i.test(text)
    || text.includes('error-1015')
    || /rate limit/i.test(text)
  );
}

function retryAfterMs(res, attempt) {
  const header = res && res.headers && res.headers.get && res.headers.get('retry-after');
  const sec = header != null ? Number(header) : NaN;
  if (Number.isFinite(sec) && sec > 0) return Math.min(60_000, Math.ceil(sec * 1000));
  // 2s, 5s, 12s, 25s — Cloudflare 1015 needs a real pause.
  return Math.min(30_000, Math.round(2000 * (2.2 ** attempt)));
}

// Process-wide pace: one Upstox HTTP call at a time, min gap between starts.
// Stops two bots / book refresh + LTP poll from stampeding into 429.
const MIN_GAP_MS = Math.max(200, Number(process.env.UPSTOX_MIN_GAP_MS) || 400);
let gate = Promise.resolve();
let nextSlotAt = 0;

function scheduleUpstoxCall(run) {
  const job = gate.then(async () => {
    const wait = Math.max(0, nextSlotAt - Date.now());
    if (wait > 0) await sleep(wait);
    nextSlotAt = Date.now() + MIN_GAP_MS;
    return run();
  });
  // Keep the chain alive even if one call fails.
  gate = job.then(() => {}, () => {});
  return job;
}

class UpstoxProvider {
  constructor(accessToken) {
    this.name = 'UPSTOX';
    this.token = accessToken;
  }

  headers() {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/json' };
  }

  async fetchJson(url, opts = {}) {
    const maxAttempts = Math.max(1, Number(opts.retries != null ? opts.retries : 4));
    return scheduleUpstoxCall(async () => {
      let lastErr = null;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const dispatcher = getIpv4Dispatcher();
        const res = await fetch(url, {
          method: opts.method || 'GET',
          headers: {
            ...this.headers(),
            ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: opts.body != null ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(config.requestTimeoutMs),
          ...(dispatcher ? { dispatcher } : {}),
        });
        if (res.ok) return res.json();
        const body = await res.text().then((t) => t.slice(0, 240));
        lastErr = new Error(`Upstox ${res.status}: ${body}`);
        if (isRateLimited(res.status, body) && attempt < maxAttempts - 1) {
          const pause = retryAfterMs(res, attempt);
          await sleep(pause);
          // Push the shared slot out so other callers also cool down.
          nextSlotAt = Math.max(nextSlotAt, Date.now() + MIN_GAP_MS);
          continue;
        }
        throw lastErr;
      }
      throw lastErr || new Error('Upstox request failed');
    });
  }

  // Live equity orders (real money when called). Product: I=intraday, D=delivery.
  async placeOrder({
    instrumentToken,
    quantity,
    transactionType, // BUY | SELL
    orderType = 'MARKET', // MARKET | LIMIT | SL | SL-M
    product = 'I',
    price = 0,
    triggerPrice = 0,
    validity = 'DAY',
    tag = '',
    isAmo = false,
  }) {
    const body = {
      quantity: Number(quantity),
      product,
      validity,
      price: Number(price) || 0,
      tag: tag || undefined,
      instrument_token: String(instrumentToken),
      order_type: orderType,
      transaction_type: transactionType,
      disclosed_quantity: 0,
      trigger_price: Number(triggerPrice) || 0,
      is_amo: Boolean(isAmo),
    };
    const j = await this.fetchJson(`${BASE}/v2/order/place`, { method: 'POST', body });
    return (j && j.data) || j;
  }

  async modifyOrder({
    orderId,
    quantity,
    orderType,
    price = 0,
    triggerPrice = 0,
    validity = 'DAY',
    disclosedQuantity = 0,
  }) {
    const body = {
      order_id: String(orderId),
      quantity: Number(quantity),
      validity,
      price: Number(price) || 0,
      order_type: orderType,
      disclosed_quantity: Number(disclosedQuantity) || 0,
      trigger_price: Number(triggerPrice) || 0,
    };
    const j = await this.fetchJson(`${BASE}/v2/order/modify`, { method: 'PUT', body });
    return (j && j.data) || j;
  }

  async cancelOrder(orderId) {
    const j = await this.fetchJson(`${BASE}/v2/order/cancel?order_id=${encodeURIComponent(orderId)}`, {
      method: 'DELETE',
    });
    return (j && j.data) || j;
  }

  async getOrders() {
    const j = await this.fetchJson(`${BASE}/v2/order/retrieve-all`);
    const data = j && j.data;
    return Array.isArray(data) ? data : [];
  }

  async getPositions() {
    const j = await this.fetchJson(`${BASE}/v2/portfolio/short-term-positions`);
    return rowsOf(j);
  }

  parseCandles(json) {
    const rows = (json && json.data && json.data.candles) || [];
    return rows
      .map((r) => ({ t: Date.parse(r[0]), open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] || 0 }))
      .filter((c) => Number.isFinite(c.t))
      .sort((a, b) => a.t - b.t);
  }

  // Candles for one IST date ('YYYY-MM-DD'). Uses the intraday endpoint for
  // today (freshest), historical for any other day.
  async getCandlesForDate(symbol, dateKey, intervalMinutes, isToday) {
    const key = encodeURIComponent(symbol.upstoxKey);
    if (isToday) {
      try {
        const j = await this.fetchJson(`${BASE}/v3/historical-candle/intraday/${key}/minutes/${intervalMinutes}`);
        const candles = this.parseCandles(j);
        if (candles.length) return candles;
      } catch (_) {
        /* fall through to historical */
      }
    }
    const j = await this.fetchJson(
      `${BASE}/v3/historical-candle/${key}/minutes/${intervalMinutes}/${dateKey}/${dateKey}`
    );
    return this.parseCandles(j);
  }

  // Daily candles from `fromDate` through `toDate` (YYYY-MM-DD), oldest first.
  async getDailyCandles(instrumentKey, fromDate, toDate) {
    const key = encodeURIComponent(instrumentKey);
    const j = await this.fetchJson(`${BASE}/v3/historical-candle/${key}/days/1/${toDate}/${fromDate}`);
    return this.parseCandles(j);
  }

  async getOptionContracts(instrumentKey) {
    const j = await this.fetchJson(`${BASE}/v2/option/contract?instrument_key=${encodeURIComponent(instrumentKey)}`);
    return (j && j.data) || [];
  }

  async getOptionChain(instrumentKey, expiry) {
    const j = await this.fetchJson(
      `${BASE}/v2/option/chain?instrument_key=${encodeURIComponent(instrumentKey)}&expiry_date=${expiry}`
    );
    return (j && j.data) || [];
  }

  async getPortfolio() {
    const [holdings, positions] = await Promise.all([
      this.fetchJson(`${BASE}/v2/portfolio/long-term-holdings`),
      this.fetchJson(`${BASE}/v2/portfolio/short-term-positions`),
    ]);
    const h = rowsOf(holdings);
    const p = rowsOf(positions);
    // holdingRows/positionRows ride along so the engine can price live P&L
    // from feed ticks between polls (see summarizeLive).
    return { ...summarizePortfolio(h, p), holdingRows: h, positionRows: p };
  }

  // Equity available margin for live cash / intraday buys.
  async getFunds() {
    const j = await this.fetchJson(`${BASE}/v2/user/get-funds-and-margin`);
    const eq = (j && j.data && j.data.equity) || {};
    const available = Number(eq.available_margin);
    const used = Number(eq.used_margin);
    return {
      available: Number.isFinite(available) ? available : 0,
      used: Number.isFinite(used) ? used : 0,
      payin: Number(eq.payin_amount) || 0,
      raw: eq,
    };
  }

  async getLTP(symbol) {
    const book = await this.getLtps([symbol.upstoxKey]);
    const px = book.get(symbol.upstoxKey);
    if (Number.isFinite(px)) return px;
    const only = [...book.values()];
    if (only.length === 1 && Number.isFinite(only[0])) return only[0];
    throw new Error('Upstox LTP: empty response');
  }

  // Last traded price for many keys. Upstox accepts a comma-separated list.
  // Returns instrument_token -> last_price.
  async getLtps(instrumentKeys) {
    const unique = [...new Set((instrumentKeys || []).filter(Boolean).map(String))];
    const out = new Map();
    const chunk = 40;
    for (let i = 0; i < unique.length; i += chunk) {
      const part = unique.slice(i, i + chunk);
      const key = part.map((item) => encodeURIComponent(item)).join(',');
      const j = await this.fetchJson(`${BASE}/v2/market-quote/ltp?instrument_key=${key}`);
      const data = (j && j.data) || {};
      const entries = Object.values(data);
      for (const value of entries) {
        const token = value && (value.instrument_token || value.instrument_key);
        const px = value && Number(value.last_price);
        if (token && Number.isFinite(px)) out.set(String(token), px);
      }
      if (part.length === 1 && entries.length === 1 && Number.isFinite(Number(entries[0] && entries[0].last_price))) {
        out.set(part[0], Number(entries[0].last_price));
      }
    }
    return out;
  }

  // Full market quotes (LTP, net_change, OHLC, volume). Max ~500 keys / request.
  // Returns instrument_token -> quote object.
  async getFullQuotes(instrumentKeys) {
    const unique = [...new Set((instrumentKeys || []).filter(Boolean).map(String))];
    const out = new Map();
    const chunk = 40;
    for (let i = 0; i < unique.length; i += chunk) {
      const part = unique.slice(i, i + chunk);
      const symbol = part.map((item) => encodeURIComponent(item)).join(',');
      const j = await this.fetchJson(`${BASE}/v2/market-quote/quotes?symbol=${symbol}`);
      const data = (j && j.data) || {};
      for (const value of Object.values(data)) {
        const token = value && (value.instrument_token || value.instrument_key);
        if (token) out.set(String(token), value);
      }
      if (part.length === 1 && Object.keys(data).length === 1) {
        const only = Object.values(data)[0];
        if (only) out.set(part[0], only);
      }
    }
    return out;
  }
}

function rowsOf(json) {
  const data = json && json.data;
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.holdings)) return data.holdings;
  if (data && Array.isArray(data.positions)) return data.positions;
  return [];
}

module.exports = { UpstoxProvider };
