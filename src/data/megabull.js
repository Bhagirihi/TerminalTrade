'use strict';

// MegaBull paper-trading REST client (virtual money only).
// Docs: https://megabull.in/paper-trading-api-india.html
// Auth: header `api-key`. Base: https://api.megabull.in

const fs = require('fs');
const path = require('path');
const { config } = require('../config');

const BASE = 'https://api.megabull.in';
const CACHE_DIR = path.join(__dirname, '..', '..', 'cache');
const INSTRUMENT_CACHE = path.join(CACHE_DIR, 'megabull-instruments.json');

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

class MegaBullClient {
  constructor(apiKey) {
    this.name = 'MEGABULL';
    this.apiKey = apiKey;
    this.instruments = null;
    this.instrumentsAt = 0;
  }

  enabled() {
    return Boolean(this.apiKey);
  }

  async request(method, urlPath, body) {
    const res = await fetch(`${BASE}${urlPath}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'api-key': this.apiKey,
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(config.requestTimeoutMs || 15000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = { raw: text };
    }
    if (!res.ok) {
      const msg = Array.isArray(json && json.message)
        ? json.message.join('; ')
        : (json && (json.message || json.error)) || text.slice(0, 200);
      throw new Error(`MegaBull ${res.status}: ${msg}`);
    }
    return json;
  }

  getProfile() {
    return this.request('GET', '/api/user/my');
  }

  getPositions() {
    return this.request('GET', '/api/position/my');
  }

  getOrders() {
    return this.request('GET', '/api/order/my');
  }

  getLtp(instrumentToken) {
    return this.request('GET', `/api/marketwatch/ltp/${encodeURIComponent(instrumentToken)}`);
  }

  async placeOrder({ instrumentToken, qty, type, duration = 'MIS', orderType = 'MKT', price, triggerPrice }) {
    const body = {
      instrumentToken: String(instrumentToken),
      qty: Number(qty),
      type, // BUY | SELL
      duration, // MIS | CNC
      orderType, // MKT | LIMIT | SL
    };
    if (price != null) body.price = Number(price);
    if (triggerPrice != null) body.triggerPrice = Number(triggerPrice);
    // API validates price even for MKT — fill from LTP when missing.
    if (body.price == null || !(body.price > 0)) {
      const quote = await this.getLtp(instrumentToken);
      body.price = Number(quote && quote.ltp);
    }
    if (!(body.price > 0)) throw new Error('MegaBull: no LTP to price the order');
    return this.request('POST', '/api/order/buysell', body);
  }

  cancelOrders(ids) {
    return this.request('PUT', '/api/order/bulk/cancel', (ids || []).map(Number));
  }

  async loadInstruments(force = false) {
    const fresh = this.instruments && Date.now() - this.instrumentsAt < 6 * 60 * 60 * 1000;
    if (!force && fresh) return this.instruments;
    if (!force && fs.existsSync(INSTRUMENT_CACHE)) {
      try {
        const saved = JSON.parse(fs.readFileSync(INSTRUMENT_CACHE, 'utf8'));
        if (Array.isArray(saved && saved.rows) && saved.at && Date.now() - saved.at < 12 * 60 * 60 * 1000) {
          this.instruments = saved.rows;
          this.instrumentsAt = saved.at;
          return this.instruments;
        }
      } catch (_) {
        /* refresh */
      }
    }
    const meta = await this.request('GET', '/api/marketwatch/instruments');
    const url = meta && meta.downloadUrl;
    if (!url) throw new Error('MegaBull: instruments downloadUrl missing');
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`MegaBull instruments CSV ${res.status}`);
    const csv = await res.text();
    const rows = parseInstrumentCsv(csv);
    this.instruments = rows;
    this.instrumentsAt = Date.now();
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(INSTRUMENT_CACHE, JSON.stringify({ at: this.instrumentsAt, rows }));
    return rows;
  }

  async resolveOption({ indexId, strike, right, now = Date.now() }) {
    const rows = await this.loadInstruments();
    const prefix = indexId === 'BANKNIFTY' ? 'BANKNIFTY' : 'NIFTY';
    const rightU = String(right || 'CE').toUpperCase() === 'PE' ? 'PE' : 'CE';
    const strikeN = Math.round(Number(strike));
    if (!Number.isFinite(strikeN)) return null;
    const todayKey = istDayKey(now);
    const matches = [];
    for (const row of rows) {
      const ts = row.tradingSymbol || '';
      if (!ts.startsWith(prefix) || ts.includes('FUT')) continue;
      if (!ts.endsWith(rightU)) continue;
      // NIFTY26OCT22900CE — strike sits before CE/PE
      const m = ts.match(new RegExp(`^${prefix}(\\d{2})([A-Z]{3})(\\d+)${rightU}$`));
      if (!m) continue;
      if (Number(m[3]) !== strikeN) continue;
      const exp = expiryFromSym(m[1], m[2], row.instrumentName);
      if (!exp || exp < todayKey) continue;
      matches.push({ ...row, expiry: exp });
    }
    matches.sort((a, b) => a.expiry.localeCompare(b.expiry));
    return matches[0] || null;
  }

  indexToken(indexId) {
    return indexId === 'BANKNIFTY' ? '260105' : '256265';
  }
}

function parseInstrumentCsv(csv) {
  const lines = String(csv || '').trim().split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].match(/("([^"]*)"|[^,]+)/g);
    if (!parts || parts.length < 3) continue;
    const clean = parts.map((p) => p.replace(/^"|"$/g, ''));
    rows.push({
      tradingSymbol: clean[0],
      instrumentName: clean[1],
      instrumentToken: clean[2],
    });
  }
  return rows;
}

function istDayKey(epochMs) {
  const d = new Date(epochMs + (5 * 60 + 30) * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function expiryFromSym(yy, mon, name) {
  const month = MONTHS[mon];
  if (!month) return null;
  const year = 2000 + Number(yy);
  const fromName = String(name || '').match(/(\d{1,2})\s+([A-Z]{3})\s+/i);
  const day = fromName ? Number(fromName[1]) : 28;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function createMegaBull() {
  const key = config.megabull && config.megabull.apiKey;
  return key ? new MegaBullClient(key) : null;
}

module.exports = { MegaBullClient, createMegaBull, parseInstrumentCsv };
