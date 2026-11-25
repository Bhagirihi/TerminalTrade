'use strict';

// Minimal Upstox client for V3 `npm run start` — Node stdlib only (global
// fetch, no dependencies). READ-ONLY: token check, intraday candles, option
// contracts/chain, LTP. No order placement — V3 suggests trades, it never
// places them.
//
// Token expiry is checked against the live API (a 401 / UDAPI100050 /
// "invalid token" response), not just by looking for a token in .env —
// main's muhurat2 only checks presence, so a dead token is caught here
// before any data call.

const { isUpstoxAuthError } = require('./upstox-auth');
const { istDateKey } = require('./time');

const BASE = 'https://api.upstox.com';
const DAY_MS = 24 * 60 * 60 * 1000;

class UpstoxApi {
  constructor(token, opts = {}) {
    this.token = token || '';
    this.timeoutMs = (opts && opts.timeoutMs) || 15000;
  }

  async fetchJson(url) {
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new Error(`Upstox request failed: ${e.message || e}`);
    }
    if (res.ok) return res.json();
    const body = await res.text().then((t) => t.slice(0, 240)).catch(() => '');
    const err = new Error(`Upstox ${res.status}: ${body}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  // { ok: true } or { ok: false, reason: 'missing' | 'expired' | 'error', detail }
  async checkToken() {
    if (!this.token) return { ok: false, reason: 'missing', detail: 'no access token in .env' };
    try {
      await this.fetchJson(`${BASE}/v2/market-quote/ltp?instrument_key=${encodeURIComponent('NSE_INDEX|Nifty 50')}`);
      return { ok: true };
    } catch (e) {
      if (e.status === 401 || isUpstoxAuthError(e)) {
        return { ok: false, reason: 'expired', detail: e.message };
      }
      return { ok: false, reason: 'error', detail: e.message };
    }
  }

  parseCandles(json) {
    const rows = (json && json.data && json.data.candles) || [];
    return rows
      .map((r) => ({ t: Date.parse(r[0]), open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] || 0 }))
      .filter((c) => Number.isFinite(c.t))
      .sort((a, b) => a.t - b.t);
  }

  // Today's intraday candles, oldest first. Empty before the open / on holidays.
  async getIntradayCandles(instrumentKey, minutes) {
    const j = await this.fetchJson(
      `${BASE}/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/minutes/${minutes}`
    );
    return this.parseCandles(j);
  }

  // Historical minute candles over a date range (YYYY-MM-DD), oldest first.
  // Upstox takes (toDate, fromDate) in the URL — same order as main.
  async getHistoricalCandles(instrumentKey, minutes, fromDate, toDate) {
    const j = await this.fetchJson(
      `${BASE}/v3/historical-candle/${encodeURIComponent(instrumentKey)}/minutes/${minutes}/${toDate}/${fromDate}`
    );
    return this.parseCandles(j);
  }

  // Candles for the last `daysBack` calendar days + today, oldest first.
  // Merges the historical range with today's intraday bars (intraday wins on
  // overlap) and drops the still-forming bar, so callers only ever see
  // closed bars — the entry rules require a candle close.
  // Why this exists: the intraday endpoint only returns today's bars, so
  // before ~14:15 IST there are fewer than the 60 five-minute bars the
  // indicators need, and the 15m trend check (50 bars) needs ~2 days
  // regardless. A 5-day window always covers it, holidays included.
  async getCandlesWindow(instrumentKey, minutes, daysBack = 5) {
    const now = Date.now();
    const toDate = istDateKey(now);
    const fromDate = istDateKey(now - daysBack * DAY_MS);
    const byT = new Map();
    try {
      for (const c of await this.getHistoricalCandles(instrumentKey, minutes, fromDate, toDate)) byT.set(c.t, c);
    } catch (_) {
      /* intraday below still gives today */
    }
    try {
      for (const c of await this.getIntradayCandles(instrumentKey, minutes)) byT.set(c.t, c);
    } catch (_) {
      /* keep historical */
    }
    const closeMs = minutes * 60 * 1000;
    return [...byT.values()]
      .filter((c) => c.t + closeMs <= now)
      .sort((a, b) => a.t - b.t);
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

  // Last traded price for one instrument key.
  async getLtp(instrumentKey) {
    const book = await this.getLtps([instrumentKey]);
    const px = book.get(instrumentKey);
    if (!Number.isFinite(px)) throw new Error('Upstox LTP: empty response');
    return px;
  }

  // Last traded price for many keys. Upstox accepts a comma-separated list.
  // Returns a Map of instrument key -> last_price (same shape as main).
  async getLtps(instrumentKeys) {
    const unique = [...new Set((instrumentKeys || []).filter(Boolean).map(String))];
    const out = new Map();
    if (!unique.length) return out;
    const key = unique.map((item) => encodeURIComponent(item)).join(',');
    const j = await this.fetchJson(`${BASE}/v2/market-quote/ltp?instrument_key=${key}`);
    const data = (j && j.data) || {};
    const entries = Object.values(data);
    for (const value of entries) {
      const token = value && (value.instrument_token || value.instrument_key);
      const px = value && Number(value.last_price);
      if (token && Number.isFinite(px)) out.set(String(token), px);
    }
    if (unique.length === 1 && entries.length === 1) {
      const px = Number(entries[0] && entries[0].last_price);
      if (Number.isFinite(px)) out.set(unique[0], px);
    }
    return out;
  }

  // Equity funds for live buys (same endpoint and shape as main's getFunds).
  async getFunds() {
    const j = await this.fetchJson(`${BASE}/v2/user/get-funds-and-margin`);
    const eq = (j && j.data && j.data.equity) || {};
    const available = Number(eq.available_margin);
    const used = Number(eq.used_margin);
    return {
      available: Number.isFinite(available) ? available : 0,
      used: Number.isFinite(used) ? used : 0,
      payin: Number(eq.payin_amount) || 0,
    };
  }
}

module.exports = { UpstoxApi };
