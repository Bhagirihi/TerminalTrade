'use strict';

// Top day-gainers for Muhurat: NSE lists the movers (Upstox has no gainers
// endpoint); we resolve NSE_EQ instrument keys from Upstox’s public master and
// enrich with Upstox full quotes for LTP / net_change.

const zlib = require('zlib');

const NSE_GAINERS_URL = 'https://www.nseindia.com/api/live-analysis-variations?index=gainers';
const UPSTOX_NSE_MASTER = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let nseCookie = '';
let nseCookieAt = 0;
let equityKeyBySymbol = null;
let equityKeyAt = 0;

const MASTER_TTL_MS = 6 * 60 * 60 * 1000;
const COOKIE_TTL_MS = 10 * 60 * 1000;

async function refreshNseCookie() {
  const res = await fetch('https://www.nseindia.com', {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(12000),
  });
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  nseCookie = Array.isArray(set) ? set.map((c) => String(c).split(';')[0]).join('; ') : '';
  nseCookieAt = Date.now();
}

async function fetchNseGainersJson() {
  if (!nseCookie || Date.now() - nseCookieAt > COOKIE_TTL_MS) {
    await refreshNseCookie();
  }
  const res = await fetch(NSE_GAINERS_URL, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      Referer: 'https://www.nseindia.com/',
      Cookie: nseCookie,
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`NSE gainers ${res.status}`);
  return res.json();
}

function rowsFromNsePayload(json, bucket) {
  const block = json && json[bucket];
  const data = block && Array.isArray(block.data) ? block.data : [];
  return data
    .map((row) => {
      const ticker = String((row && (row.symbol || row.Symbol)) || '').trim().toUpperCase();
      if (!ticker) return null;
      const dayChangePct = Number(row.net_price != null ? row.net_price : row.pChange);
      const ltp = Number(row.ltp != null ? row.ltp : row.lastPrice);
      const prev = Number(row.prev_price != null ? row.prev_price : row.previousClose);
      return {
        ticker,
        dayChangePct: Number.isFinite(dayChangePct) ? dayChangePct : null,
        ltp: Number.isFinite(ltp) ? ltp : null,
        prevClose: Number.isFinite(prev) ? prev : null,
        series: row.series || 'EQ',
        source: `nse:${bucket}`,
      };
    })
    .filter(Boolean);
}

async function loadEquityKeyMap() {
  if (equityKeyBySymbol && Date.now() - equityKeyAt < MASTER_TTL_MS) return equityKeyBySymbol;
  const res = await fetch(UPSTOX_NSE_MASTER, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Upstox NSE master ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer());
  const rows = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
  const map = new Map();
  for (const row of rows || []) {
    if (!row || row.segment !== 'NSE_EQ' || row.instrument_type !== 'EQ') continue;
    const sym = String(row.trading_symbol || '').trim().toUpperCase();
    if (sym && row.instrument_key && !map.has(sym)) map.set(sym, String(row.instrument_key));
  }
  equityKeyBySymbol = map;
  equityKeyAt = Date.now();
  return map;
}

function resolveUpstoxKey(ticker, known = []) {
  const t = String(ticker || '').toUpperCase();
  const hit = (known || []).find((r) => r && String(r.ticker).toUpperCase() === t && r.key);
  if (hit) return hit.key;
  if (equityKeyBySymbol && equityKeyBySymbol.has(t)) return equityKeyBySymbol.get(t);
  return null;
}

/**
 * NSE F&O top gainers → Upstox NSE_EQ keys (preferred liquid bucket).
 * Falls back to NIFTY / allSec if FOSec is empty.
 */
async function fetchTopGainerCandidates({ limit = 15, known = [] } = {}) {
  const json = await fetchNseGainersJson();
  await loadEquityKeyMap();
  const buckets = ['FOSec', 'NIFTY', 'NIFTYNEXT50', 'allSec'];
  let raw = [];
  for (const bucket of buckets) {
    raw = rowsFromNsePayload(json, bucket);
    if (raw.length) break;
  }
  const out = [];
  const seen = new Set();
  for (const row of raw) {
    if (seen.has(row.ticker)) continue;
    const key = resolveUpstoxKey(row.ticker, known);
    if (!key) continue;
    seen.add(row.ticker);
    out.push({ ...row, key, sleeve: 'Top gainer' });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Rank an instrument list by Upstox day % change (full market quotes).
 * Use when you already have keys (CORE+EXTRA) and want in-universe gainers.
 */
async function rankByUpstoxDayChange(provider, metas, { limit = 15 } = {}) {
  if (!provider || typeof provider.getFullQuotes !== 'function') return [];
  const keys = (metas || []).map((m) => m.key).filter(Boolean);
  if (!keys.length) return [];
  const quotes = await provider.getFullQuotes(keys);
  const ranked = [];
  for (const meta of metas || []) {
    const q = quotes.get(meta.key);
    if (!q) continue;
    const ltp = Number(q.last_price);
    const net = Number(q.net_change);
    let dayChangePct = null;
    if (Number.isFinite(ltp) && Number.isFinite(net) && ltp !== net) {
      const prev = ltp - net;
      if (prev) dayChangePct = (net / prev) * 100;
    }
    if (!(dayChangePct > 0)) continue;
    ranked.push({
      ticker: meta.ticker,
      key: meta.key,
      core: Boolean(meta.core),
      sleeve: meta.sleeve || 'Upstox day gainer',
      ltp: Number.isFinite(ltp) ? ltp : null,
      dayChangePct: Math.round(dayChangePct * 100) / 100,
      volume: Number(q.volume) || null,
      source: 'upstox:quotes',
    });
  }
  ranked.sort((a, b) => (b.dayChangePct || 0) - (a.dayChangePct || 0));
  return ranked.slice(0, limit);
}

module.exports = {
  fetchTopGainerCandidates,
  rankByUpstoxDayChange,
  loadEquityKeyMap,
  resolveUpstoxKey,
  rowsFromNsePayload,
};
