'use strict';

// Trade suggestions for V3 `npm run start` — live Upstox data + the V3
// screenshot-plan rules. SUGGESTIONS ONLY: no orders are placed.
// (This is the "suggest" half of main's muhurat2 flow, rebuilt on the V3
// rules — VWAP / EMA 20-50 / RSI / MACD entry, 0–100 score, regime —
// instead of muhurat2's 15m train logic.)
//
// Per underlying (NIFTY 50, BANKNIFTY):
//   5m + 15m intraday candles → entry rules → 0–100 score → regime
//   if tradeable → nearest-expiry ATM CE/PE card: LTP, -5% SL, +22% T1,
//   +45% T2, lot size and cost per lot. Otherwise the verdict + why.

const { evaluateEntry } = require('./entry-rules');
const { scoreTrade } = require('./trade-score');
const { classifyRegime } = require('./regime');
const { nearestListedStrike, nearestStepStrike } = require('./strikes');
const { istDateKey } = require('./time');

const UNDERLYINGS = [
  { id: 'NIFTY', name: 'NIFTY 50', upstoxKey: 'NSE_INDEX|Nifty 50', lotSize: 65, strikeStep: 50 },
  { id: 'BANKNIFTY', name: 'BANKNIFTY', upstoxKey: 'NSE_INDEX|Nifty Bank', lotSize: 30, strikeStep: 100 },
];

// Trade plan defaults (same as muhurat2's options lane).
const SL_PCT = 5;
const T1_PCT = 22;
const T2_PCT = 45;

function last(arr) { return arr[arr.length - 1]; }

// Nearest-expiry option book: contracts → first expiry >= today → strikes,
// instrument keys and lot sizes → chain LTPs. Same shape as main's
// loadOptionBook in src/muhurat-options.js.
async function loadOptionBook(api, symbol, today) {
  const contracts = await api.getOptionContracts(symbol.upstoxKey);
  const expiries = [...new Set(contracts.map((c) => c.expiry))].filter((e) => e >= today).sort();
  const expiry = expiries[0];
  if (!expiry) throw new Error(`No upcoming expiry for ${symbol.id}`);
  const listed = contracts.filter((c) => c.expiry === expiry);
  const strikes = [...new Set(listed.map((c) => Number(c.strike_price)))].filter(Number.isFinite).sort((a, b) => a - b);
  const instruments = {};
  const lotByKey = {};
  for (const c of listed) {
    const k = `${c.strike_price}|${c.instrument_type}`;
    instruments[k] = c.instrument_key;
    lotByKey[c.instrument_key] = Number(c.lot_size) || symbol.lotSize;
  }
  let chainLtp = {};
  try {
    const chain = await api.getOptionChain(symbol.upstoxKey, expiry);
    for (const row of chain || []) {
      for (const [field] of [['call_options'], ['put_options']]) {
        const opt = row[field];
        const px = opt && opt.market_data && Number(opt.market_data.ltp);
        if (opt && opt.instrument_key && Number.isFinite(px)) chainLtp[opt.instrument_key] = px;
      }
    }
  } catch (_) {
    chainLtp = {};
  }
  return { expiry, strikes, instruments, lotByKey, chainLtp };
}

// One underlying: fetch candles, run the V3 rules, build the card if tradeable.
// Returns { id, status, entry, score, regime, card?, reason? } where status is
// 'trade' | 'no-trade' | 'no-data' | 'error'. A failure here never throws —
// the other underlying still gets its suggestion.
async function suggestFor(api, symbol) {
  const base = { id: symbol.id };
  let bars5;
  let bars15;
  try {
    bars5 = await api.getIntradayCandles(symbol.upstoxKey, 5);
    bars15 = await api.getIntradayCandles(symbol.upstoxKey, 15);
  } catch (e) {
    return { ...base, status: 'error', reason: `candles failed: ${e.message}` };
  }
  if (!bars5.length) {
    return { ...base, status: 'no-data', reason: 'no 5m candles yet today (pre-open, holiday, or market closed)' };
  }
  const entry = evaluateEntry(bars5);
  const regime = classifyRegime(bars5);
  if (!entry.evaluable) return { ...base, status: 'no-data', entry, regime, reason: entry.reason };
  const score = entry.passed
    ? scoreTrade({ side: entry.side, entry, bars5, bars15, liquidityOk: null })
    : null;
  if (!entry.passed || !score.tradeable) {
    return { ...base, status: 'no-trade', entry, score, regime };
  }
  const indexLtp = last(bars5).close;
  let book;
  try {
    book = await loadOptionBook(api, symbol, istDateKey(Date.now()));
  } catch (e) {
    return { ...base, status: 'error', entry, score, regime, reason: `option book failed: ${e.message}` };
  }
  const atm = nearestListedStrike(indexLtp, book.strikes) || nearestStepStrike(indexLtp, symbol.strikeStep);
  const key = book.instruments[`${atm}|${entry.side}`];
  if (!key) return { ...base, status: 'error', entry, score, regime, reason: `no ${entry.side} contract at ${atm}` };
  let ltp = book.chainLtp[key];
  if (!Number.isFinite(ltp)) {
    try { ltp = await api.getLtp(key); } catch (_) { ltp = null; }
  }
  if (!Number.isFinite(ltp)) {
    return { ...base, status: 'no-trade', entry, score, regime, reason: `no live premium for ${symbol.id} ${atm} ${entry.side}` };
  }
  const lot = book.lotByKey[key] || symbol.lotSize;
  const card = {
    ticker: `${symbol.id} ${atm} ${entry.side}`,
    strike: atm,
    expiry: book.expiry,
    lot,
    ltp: +ltp.toFixed(2),
    sl: +(ltp * (1 - SL_PCT / 100)).toFixed(2),
    t1: +(ltp * (1 + T1_PCT / 100)).toFixed(2),
    t2: +(ltp * (1 + T2_PCT / 100)).toFixed(2),
    costPerLot: +(ltp * lot).toFixed(2),
    maxLossPerLot: +(ltp * lot * SL_PCT / 100).toFixed(2),
  };
  return { ...base, status: 'trade', entry, score, regime, card };
}

async function suggestAll(api, ids) {
  const list = UNDERLYINGS.filter((s) => !ids || ids.includes(s.id));
  const out = [];
  for (const symbol of list) out.push(await suggestFor(api, symbol));
  return out;
}

function fmt(n) { return Number.isFinite(n) ? String(n) : '—'; }

function formatSuggestion(s) {
  const lines = [`\n== ${s.id} ==`];
  if (s.status === 'error' || s.status === 'no-data') {
    lines.push(`  ${s.reason || 'no data'}`);
    return lines.join('\n');
  }
  if (s.entry) {
    lines.push(`  Entry: ${s.entry.passed ? `${s.entry.side} ${s.entry.entryType}` : 'no setup'}`);
  }
  if (s.score) {
    lines.push(`  Score: ${s.score.score}/${s.score.max} (${s.score.verdict}) — tradeable: ${s.score.tradeable}`);
  }
  if (s.regime && s.regime.evaluable) lines.push(`  Regime: ${s.regime.label} (ADX ${fmt(+s.regime.features.adx.toFixed(1))})`);
  if (s.status === 'no-trade') {
    if (s.reason) lines.push(`  ${s.reason}`);
    else lines.push('  No trade — score below the 70 bar or no entry setup.');
    return lines.join('\n');
  }
  const c = s.card;
  lines.push(`  SUGGESTION: BUY ${c.ticker}  (expiry ${c.expiry}, lot ${c.lot})`);
  lines.push(`    Entry ₹${c.ltp}  ·  SL ₹${c.sl} (-${SL_PCT}%)  ·  T1 ₹${c.t1} (+${T1_PCT}%)  ·  T2 ₹${c.t2} (+${T2_PCT}%)`);
  lines.push(`    Cost/lot ₹${c.costPerLot}  ·  max loss/lot ₹${c.maxLossPerLot}  ·  suggestion only, no order placed`);
  return lines.join('\n');
}

module.exports = { suggestFor, suggestAll, formatSuggestion, loadOptionBook, UNDERLYINGS, SL_PCT, T1_PCT, T2_PCT };
