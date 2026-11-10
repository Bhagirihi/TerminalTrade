'use strict';

// Angel One SmartAPI provider (realtime, free with an Angel One account).
// - Login:   POST /rest/auth/angelbroking/user/v1/loginByPassword
//            (clientcode + password + TOTP). Or paste a ready JWT in .env.
// - Candles: POST /rest/secure/angelbroking/historical/v1/getCandleData
// - LTP:     POST /rest/secure/angelbroking/order/v1/getLtpData
// Index symbol tokens (Angel instrument master): NIFTY 99926000, BANKNIFTY 99926009.

const crypto = require('crypto');
const { config } = require('../config');
const { istDateKey } = require('../time');

const BASE = 'https://apiconnect.angelone.in';

const INTERVALS = {
  1: 'ONE_MINUTE',
  3: 'THREE_MINUTE',
  5: 'FIVE_MINUTE',
  10: 'TEN_MINUTE',
  15: 'FIFTEEN_MINUTE',
  30: 'THIRTY_MINUTE',
  60: 'ONE_HOUR',
};

// RFC 6238 TOTP (SHA-1, 30s step, 6 digits) from a base32 secret.
function totp(secretBase32, nowMs = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretBase32.replace(/\s|-/g, '').toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const key = Buffer.from(bytes);
  const counter = Math.floor(nowMs / 30000);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

class AngelProvider {
  constructor(cfg) {
    this.name = 'ANGELONE';
    this.cfg = cfg;
    this.jwt = cfg.jwtToken || '';
  }

  baseHeaders() {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': this.cfg.localIP,
      'X-ClientPublicIP': this.cfg.publicIP,
      'X-MACAddress': this.cfg.macAddress,
      'X-PrivateKey': this.cfg.apiKey,
    };
  }

  async login() {
    if (this.jwt) return this.jwt;
    const res = await fetch(`${BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
      method: 'POST',
      headers: this.baseHeaders(),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
      body: JSON.stringify({
        clientcode: this.cfg.clientCode,
        password: this.cfg.password,
        totp: totp(this.cfg.totpSecret),
      }),
    });
    const j = await res.json().catch(() => null);
    if (!j || !j.status || !j.data || !j.data.jwtToken) {
      throw new Error(`Angel login failed: ${j ? j.message || JSON.stringify(j).slice(0, 200) : res.status}`);
    }
    this.jwt = j.data.jwtToken;
    return this.jwt;
  }

  async post(pathname, body) {
    const jwt = await this.login();
    const res = await fetch(`${BASE}${pathname}`, {
      method: 'POST',
      headers: { ...this.baseHeaders(), Authorization: `Bearer ${jwt}` },
      signal: AbortSignal.timeout(config.requestTimeoutMs),
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => null);
    if (!j || !j.status) {
      // One retry with a fresh login if the JWT expired mid-session.
      if (this.jwt && !this.cfg.jwtToken) {
        this.jwt = '';
        const jwt2 = await this.login();
        const res2 = await fetch(`${BASE}${pathname}`, {
          method: 'POST',
          headers: { ...this.baseHeaders(), Authorization: `Bearer ${jwt2}` },
          signal: AbortSignal.timeout(config.requestTimeoutMs),
          body: JSON.stringify(body),
        });
        const j2 = await res2.json().catch(() => null);
        if (j2 && j2.status) return j2;
      }
      throw new Error(`Angel ${pathname} failed: ${j ? j.message || JSON.stringify(j).slice(0, 200) : res.status}`);
    }
    return j;
  }

  // Candles for one IST date ('YYYY-MM-DD'), fetched as a single day chunk.
  async getCandlesForDate(symbol, dateKey, intervalMinutes) {
    const interval = INTERVALS[intervalMinutes];
    if (!interval) throw new Error(`Angel: unsupported interval ${intervalMinutes}`);
    const j = await this.post('/rest/secure/angelbroking/historical/v1/getCandleData', {
      exchange: symbol.angel.exchange,
      symboltoken: symbol.angel.symboltoken,
      interval,
      fromdate: `${dateKey} 09:15`,
      todate: `${dateKey} 15:30`,
    });
    const rows = j.data || [];
    return rows
      .map((r) => ({ t: Date.parse(r[0]), open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] || 0 }))
      .filter((c) => Number.isFinite(c.t) && istDateKey(c.t) === dateKey)
      .sort((a, b) => a.t - b.t);
  }

  async getLTP(symbol) {
    const j = await this.post('/rest/secure/angelbroking/order/v1/getLtpData', {
      exchange: symbol.angel.exchange,
      tradingsymbol: symbol.angel.tradingsymbol,
      symboltoken: symbol.angel.symboltoken,
    });
    if (!j.data || !Number.isFinite(j.data.ltp)) throw new Error('Angel LTP: empty response');
    return j.data.ltp;
  }
}

module.exports = { AngelProvider, totp };
