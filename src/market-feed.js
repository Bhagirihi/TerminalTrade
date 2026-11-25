'use strict';

// Upstox market-data feed v3 over WebSocket — realtime ticks for the V3
// watch loop.
//   GET /v3/feed/market-data-feed/authorize  ->  wss URL
//   connect, send JSON {guid, method:'sub', data:{mode:'full',
//   instrumentKeys:[...]}}  ->  binary protobuf FeedResponse frames.
//
// Decoding is hand-rolled (no protobufjs): a wire-format walker that
// reads only the fields we need (ltp + best bid/ask) and skips everything
// else, so it stays correct if Upstox adds fields. Field numbers come
// from the vendored src/MarketDataFeedV3.proto (official schema).
//   FeedResponse.feeds (2, map<string, Feed>)
//   Feed.fullFeed (2) -> FullFeed.marketFF (1) | indexFF (2)
//   MarketFullFeed.ltpc (1) / IndexFullFeed.ltpc (1) -> LTPC.ltp (1, double)
//   MarketFullFeed.marketLevel (2) -> MarketLevel.bidAskQuote (1, first
//   = best) -> Quote.bidP (2, double) / askP (4, double)
//
// The loop keeps its 30s REST candle poll (entries are evaluated on
// CLOSED 5m bars — the correct time to act); the feed makes PRICES
// realtime: index levels, open-position P&L, and SL/T2 detection happen
// on the tick that crosses the level instead of up to 30s later.
// If the feed drops or never connects, the loop falls back to REST LTP
// polling and keeps working.

const AUTHORIZE_URL = 'https://api.upstox.com/v3/feed/market-data-feed/authorize';

// ---- minimal protobuf wire reader (only what the feed needs) ----
function readVarint(buf, pos) {
  let v = 0n;
  let shift = 0n;
  let i = pos;
  while (i < buf.length) {
    const b = buf[i++];
    v |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7n;
  }
  return { value: Number(v), next: i };
}

function readTag(buf, pos) {
  const { value, next } = readVarint(buf, pos);
  return { field: value >> 3, wire: value & 7, next };
}

// Walk a message's fields between [start, end), calling
// onField(field, wire, valueStart, valueEnd) for each. For wire type 2
// (length-delimited) valueStart is AFTER the length prefix.
function walkFields(buf, start, end, onField) {
  let pos = start;
  while (pos < end) {
    const { field, wire, next } = readTag(buf, pos);
    let valueStart;
    let valueEnd;
    if (wire === 0) {
      valueStart = next;
      valueEnd = readVarint(buf, next).next;
    } else if (wire === 1) {
      valueStart = next;
      valueEnd = next + 8;
    } else if (wire === 5) {
      valueStart = next;
      valueEnd = next + 4;
    } else if (wire === 2) {
      const { value: len, next: n2 } = readVarint(buf, next);
      valueStart = n2;
      valueEnd = n2 + len;
    } else throw new Error(`unsupported protobuf wire type ${wire}`);
    onField(field, wire, valueStart, valueEnd);
    pos = valueEnd;
  }
}

function decodeLtpc(buf, start, end) {
  let ltp = null;
  walkFields(buf, start, end, (field, wire, vs, ve) => {
    if (field === 1 && wire === 1) ltp = buf.readDoubleLE(vs);
  });
  return ltp;
}

function decodeQuote(buf, start, end) {
  let bidP = null;
  let askP = null;
  walkFields(buf, start, end, (field, wire, vs, ve) => {
    if (field === 2 && wire === 1) bidP = buf.readDoubleLE(vs);
    if (field === 4 && wire === 1) askP = buf.readDoubleLE(vs);
  });
  return { bidP, askP };
}

function decodeMarketLevel(buf, start, end) {
  let best = null;
  walkFields(buf, start, end, (field, wire, vs, ve) => {
    if (field === 1 && wire === 2 && best === null) best = decodeQuote(buf, vs, ve);
  });
  return best;
}

// One Feed message -> { ltp, bid, ask } (bid/ask null for indices).
function decodeFeed(buf, start, end) {
  let out = { ltp: null, bid: null, ask: null };
  walkFields(buf, start, end, (field, wire, vs, ve) => {
    if (field === 1 && wire === 2) {
      // Feed.ltpc (direct LTPC mode)
      out.ltp = decodeLtpc(buf, vs, ve);
    } else if (field === 2 && wire === 2) {
      // Feed.fullFeed -> marketFF (1) | indexFF (2)
      walkFields(buf, vs, ve, (f2, w2, s2, e2) => {
        if ((f2 === 1 || f2 === 2) && w2 === 2) {
          // MarketFullFeed / IndexFullFeed: ltpc (1), marketLevel (2)
          walkFields(buf, s2, e2, (f3, w3, s3, e3) => {
            if (f3 === 1 && w3 === 2) out.ltp = decodeLtpc(buf, s3, e3);
            if (f3 === 2 && w3 === 2) {
              const q = decodeMarketLevel(buf, s3, e3);
              if (q) { out.bid = q.bidP; out.ask = q.askP; }
            }
          });
        }
      });
    }
  });
  return out;
}

// A whole FeedResponse frame -> [{ instrumentKey, ltp, bid, ask }].
function decodeFeedResponse(buf) {
  const quotes = [];
  walkFields(buf, 0, buf.length, (field, wire, vs, ve) => {
    if (field !== 2 || wire !== 2) return; // feeds map
    // Map entry: key (field 1, string), value (field 2, Feed message).
    let key = null;
    let feed = null;
    walkFields(buf, vs, ve, (f2, w2, s2, e2) => {
      if (f2 === 1 && w2 === 2) key = buf.toString('utf8', s2, e2);
      if (f2 === 2 && w2 === 2) feed = decodeFeed(buf, s2, e2);
    });
    if (key && feed && Number.isFinite(feed.ltp)) {
      quotes.push({ instrumentKey: key, ltp: feed.ltp, bid: feed.bid, ask: feed.ask });
    }
  });
  return quotes;
}

class MarketFeed {
  constructor({ token, onQuote, onStatus, WebSocketImpl, authorizeUrl } = {}) {
    this.token = token;
    this.onQuote = onQuote || (() => {});
    this.onStatus = onStatus || (() => {});
    this.WebSocketImpl = WebSocketImpl || require('ws');
    this.authorizeUrl = authorizeUrl || AUTHORIZE_URL;
    this.keys = new Set();
    this.quotes = new Map(); // instrumentKey -> { ltp, bid, ask, atMs }
    this.ws = null;
    this.stopped = false;
    this.reconnectDelayMs = 1000;
    this.reconnectTimer = null;
    this.guidN = 0;
  }

  isLive() {
    return !!this.ws && this.ws.readyState === 1; // WebSocket.OPEN
  }

  getQuote(instrumentKey) {
    return this.quotes.get(instrumentKey) || null;
  }

  subscribe(keys) {
    let changed = false;
    for (const k of keys || []) {
      if (!this.keys.has(k)) { this.keys.add(k); changed = true; }
    }
    if (changed && this.isLive()) this.sendSubscribe();
  }

  unsubscribe(keys) {
    let changed = false;
    for (const k of keys || []) {
      if (this.keys.delete(k)) changed = true;
    }
    if (changed && this.isLive()) this.sendUnsubscribe(keys);
  }

  sendSubscribe() {
    if (!this.isLive() || !this.keys.size) return;
    this.ws.send(Buffer.from(JSON.stringify({
      guid: `v3-${Date.now()}-${this.guidN++}`,
      method: 'sub',
      data: { mode: 'full', instrumentKeys: [...this.keys] },
    })));
  }

  sendUnsubscribe(keys) {
    if (!this.isLive()) return;
    this.ws.send(Buffer.from(JSON.stringify({
      guid: `v3-${Date.now()}-${this.guidN++}`,
      method: 'unsub',
      data: { mode: 'full', instrumentKeys: keys || [] },
    })));
  }

  async authorize() {
    const res = await fetch(this.authorizeUrl, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = await res.text().then((t) => t.slice(0, 200)).catch(() => '');
      throw new Error(`feed authorize ${res.status}: ${body}`);
    }
    const j = await res.json();
    const url = j && j.data && j.data.authorizedRedirectUri;
    if (!url) throw new Error('feed authorize: no authorizedRedirectUri');
    return url;
  }

  async start() {
    this.stopped = false;
    await this.connect();
  }

  async connect() {
    if (this.stopped) return;
    let url;
    try {
      url = await this.authorize();
    } catch (e) {
      this.onStatus(`feed authorize failed: ${e.message || e}`);
      return this.scheduleReconnect();
    }
    const ws = new this.WebSocketImpl(url);
    this.ws = ws;
    ws.on('open', () => {
      this.reconnectDelayMs = 1000;
      this.onStatus('feed live');
      this.sendSubscribe();
    });
    ws.on('message', (data) => {
      try {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        for (const q of decodeFeedResponse(buf)) {
          this.quotes.set(q.instrumentKey, { ...q, atMs: Date.now() });
          this.onQuote(q);
        }
      } catch (e) {
        this.onStatus(`feed decode failed: ${e.message || e}`);
      }
    });
    ws.on('error', () => { /* 'close' follows; reconnect there */ });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      this.onStatus('feed down');
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30000);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try { this.ws.close(); } catch (_) { /* already closed */ }
      this.ws = null;
    }
  }
}

module.exports = { MarketFeed, decodeFeedResponse, AUTHORIZE_URL };
