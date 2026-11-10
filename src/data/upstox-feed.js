'use strict';

// Upstox Market Data Feed V3. One authorize call, then a websocket that pushes
// last traded price for the subscribed instrument keys.
// https://upstox.com/developer/api-documentation/v3/get-market-data-feed

const crypto = require('crypto');
const path = require('path');
const protobuf = require('protobufjs');
const WebSocket = require('ws');
const { config } = require('../config');

const AUTHORIZE_URL = 'https://api.upstox.com/v3/feed/market-data-feed/authorize';
const PROTO_PATH = path.join(__dirname, 'MarketDataFeedV3.proto');
const TYPE_NAME = 'com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse';

function ltpcOf(feed) {
  if (!feed) return null;
  if (feed.ltpc) return feed.ltpc;
  const full = feed.fullFeed;
  if (!full) return null;
  return (full.indexFF && full.indexFF.ltpc) || (full.marketFF && full.marketFF.ltpc) || null;
}

function pricesFromObject(obj) {
  const out = [];
  for (const [instrumentKey, feed] of Object.entries((obj && obj.feeds) || {})) {
    const ltpc = ltpcOf(feed);
    if (!ltpc || !Number.isFinite(ltpc.ltp) || ltpc.ltp <= 0) continue;
    out.push({
      instrumentKey,
      ltp: ltpc.ltp,
      prevClose: Number.isFinite(ltpc.cp) ? ltpc.cp : null,
    });
  }
  return out;
}

async function loadFeedType() {
  const root = await protobuf.load(PROTO_PATH);
  return root.lookupType(TYPE_NAME);
}

class UpstoxFeed {
  constructor(accessToken, instrumentKeys, onTick) {
    this.token = accessToken;
    this.instrumentKeys = new Set(instrumentKeys);
    this.onTick = onTick;
    this.ws = null;
    this.connected = false;
    this.stopped = false;
    this.retry = 0;
    this.reconnectTimer = null;
    this.FeedResponse = null;
    this.seen = false;
  }

  async start() {
    this.FeedResponse = await loadFeedType();
    try {
      await this.connect();
    } catch (e) {
      console.error(`[upstox-feed] ${e.message}`);
      this.scheduleReconnect();
    }
  }

  async authorize() {
    const res = await fetch(AUTHORIZE_URL, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`authorize ${res.status}: ${text.slice(0, 180)}`);
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      throw new Error('authorize: response was not JSON');
    }
    const url = json && json.data && (json.data.authorizedRedirectUri || json.data.authorized_redirect_uri);
    if (!url) throw new Error('authorize: no socket URL');
    return url;
  }

  connect() {
    if (this.stopped) return Promise.resolve();
    return this.authorize().then((url) => {
      if (this.stopped) return;
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { followRedirects: true });
        this.ws = ws;
        let opened = false;
        ws.on('open', () => {
          opened = true;
          this.connected = true;
          this.retry = 0;
          this.sendSub([...this.instrumentKeys]);
          resolve();
        });
        ws.on('message', (data) => this.handleMessage(data));
        ws.on('error', (err) => {
          console.error(`[upstox-feed] ${err.message}`);
          if (!opened) reject(err);
        });
        ws.on('close', () => {
          this.connected = false;
          if (this.ws === ws) this.ws = null;
          if (!opened || this.stopped) return;
          this.scheduleReconnect();
        });
      });
    });
  }

  sendSub(keys) {
    if (!this.ws || !this.connected || !keys.length) return;
    this.ws.send(Buffer.from(JSON.stringify({
      guid: crypto.randomUUID(),
      method: 'sub',
      data: { mode: 'ltpc', instrumentKeys: keys },
    })));
    console.log(`[upstox-feed] subscribed ${keys.length} instrument${keys.length === 1 ? '' : 's'}`);
  }

  // Add contracts after the socket is up (the open strikes for the paper book).
  subscribe(keys) {
    const fresh = [];
    for (const key of keys || []) {
      if (!key || this.instrumentKeys.has(key)) continue;
      this.instrumentKeys.add(key);
      fresh.push(key);
    }
    if (fresh.length) this.sendSub(fresh);
  }

  handleMessage(data) {
    if (!this.FeedResponse) return;
    let decoded;
    try {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      decoded = this.FeedResponse.toObject(this.FeedResponse.decode(buf), {
        longs: Number,
        defaults: false,
      });
    } catch (e) {
      console.error(`[upstox-feed] decode: ${e.message}`);
      return;
    }
    for (const tick of pricesFromObject(decoded)) {
      if (!this.seen) {
        this.seen = true;
        console.log(`[upstox-feed] live ${tick.instrumentKey} ${tick.ltp}`);
      }
      this.onTick(tick);
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.retry += 1;
    const wait = Math.min(30000, 1000 * 2 ** Math.min(this.retry, 5));
    console.error(`[upstox-feed] disconnected, retrying in ${Math.round(wait / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((e) => {
        console.error(`[upstox-feed] ${e.message}`);
        this.scheduleReconnect();
      });
    }, wait);
  }

  stop() {
    this.stopped = true;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }
}

module.exports = { UpstoxFeed, pricesFromObject, loadFeedType };
