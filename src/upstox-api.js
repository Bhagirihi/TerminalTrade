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

const BASE = 'https://api.upstox.com';

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
    const j = await this.fetchJson(
      `${BASE}/v2/market-quote/ltp?instrument_key=${encodeURIComponent(instrumentKey)}`
    );
    const data = (j && j.data) || {};
    const entry = Object.values(data)[0];
    const px = entry && Number(entry.last_price);
    if (!Number.isFinite(px)) throw new Error('Upstox LTP: empty response');
    return px;
  }
}

module.exports = { UpstoxApi };
