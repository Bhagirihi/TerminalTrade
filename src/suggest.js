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
const { istDateKey, istTimeStr, istShortDateTime } = require('./time');
const term = require('./terminal');

const CHECK_KEYS = ['vsVwap', 'emaAligned', 'rsiSide', 'macdConfirm', 'volumeBacked'];

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
// Candles come from the last 5 calendar days + today (see getCandlesWindow),
// so the indicators are seeded even before 14:15 IST. The session VWAP
// still resets each day, so today's VWAP stays today's.
// Returns { id, status, entry, score, regime, card?, asOf?, reason? } where
// status is 'trade' | 'no-trade' | 'no-data' | 'error'. A failure here never
// throws — the other underlying still gets its suggestion.
async function suggestFor(api, symbol, budgetState, opts = {}) {
  const base = { id: symbol.id };
  let bars5;
  let bars15;
  try {
    bars5 = await api.getCandlesWindow(symbol.upstoxKey, 5);
    bars15 = await api.getCandlesWindow(symbol.upstoxKey, 15);
  } catch (e) {
    return { ...base, status: 'error', reason: `candles failed: ${e.message}` };
  }
  if (!bars5.length) {
    return { ...base, status: 'no-data', reason: 'no 5m candles in the last 5 days (market closed?)' };
  }
  const asOf = `${istDateKey(last(bars5).t)} ${istTimeStr(last(bars5).t)} IST`;
  base.bars5 = bars5; // the tick keeps these for the live indicator preview
  const entry = evaluateEntry(bars5);
  const regime = classifyRegime(bars5);
  if (!entry.evaluable) return { ...base, status: 'no-data', entry, regime, asOf, reason: entry.reason };
  // When the entry passes, resolve the ATM contract BEFORE scoring, so
  // the score can judge its liquidity from the live feed's bid/ask
  // spread. The option key is a numeric exchange token (NSE_FO|37590) —
  // it comes from the contracts API, never constructed from the strike.
  let book = null;
  let atm = null;
  let key = null;
  if (entry.passed) {
    const indexLtp = last(bars5).close;
    try {
      book = await loadOptionBook(api, symbol, istDateKey(Date.now()));
    } catch (e) {
      return { ...base, status: 'error', entry, regime, asOf, reason: `option book failed: ${e.message}` };
    }
    atm = nearestListedStrike(indexLtp, book.strikes) || nearestStepStrike(indexLtp, symbol.strikeStep);
    key = book.instruments[`${atm}|${entry.side}`];
    if (!key) return { ...base, status: 'error', entry, regime, asOf, reason: `no ${entry.side} contract at ${atm}` };
  }
  const liquidityOk = entry.passed && key && typeof opts.liquidityFor === 'function'
    ? opts.liquidityFor(key)
    : null;
  const score = entry.passed
    ? scoreTrade({ side: entry.side, entry, bars5, bars15, liquidityOk })
    : null;
  if (!entry.passed || !score.tradeable) {
    return { ...base, status: 'no-trade', entry, score, regime, asOf, atmKeys: book ? atmBandKeys(book, atm, symbol) : [] };
  }
  let ltp = book.chainLtp[key];
  if (!Number.isFinite(ltp)) {
    try { ltp = await api.getLtp(key); } catch (_) { ltp = null; }
  }
  if (!Number.isFinite(ltp)) {
    return { ...base, status: 'no-trade', entry, score, regime, asOf, reason: `no live premium for ${symbol.id} ${atm} ${entry.side}` };
  }
  const lot = book.lotByKey[key] || symbol.lotSize;
  const card = {
    ticker: `${symbol.id} ${atm} ${entry.side}`,
    strike: atm,
    expiry: book.expiry,
    instrumentKey: key,
    lot,
    ltp: +ltp.toFixed(2),
    sl: +(ltp * (1 - SL_PCT / 100)).toFixed(2),
    t1: +(ltp * (1 + T1_PCT / 100)).toFixed(2),
    t2: +(ltp * (1 + T2_PCT / 100)).toFixed(2),
    costPerLot: +(ltp * lot).toFixed(2),
    maxLossPerLot: +(ltp * lot * SL_PCT / 100).toFixed(2),
  };
  // Size in whole lots inside the day's budget (shared pool: NIFTY takes
  // first, BANKNIFTY gets what's left). No budget -> 1 lot, paper-sized.
  const remaining = budgetState ? budgetState.remaining : null;
  const lots = remaining == null ? 1 : Math.floor(remaining / card.costPerLot);
  if (lots < 1) {
    return {
      ...base, status: 'no-trade', entry, score, regime, asOf,
      reason: `1 lot costs ₹${card.costPerLot.toFixed(2)}, only ₹${remaining.toFixed(2)} left in budget`,
    };
  }
  card.lots = lots;
  card.qty = lots * lot;
  card.totalCost = +(card.costPerLot * lots).toFixed(2);
  card.maxLoss = +(card.maxLossPerLot * lots).toFixed(2);
  if (budgetState) {
    budgetState.remaining = +(budgetState.remaining - card.totalCost).toFixed(2);
    card.budgetLeft = budgetState.remaining;
  }
  return { ...base, status: 'trade', entry, score, regime, asOf, card, atmKeys: atmBandKeys(book, atm, symbol) };
}

// ATM ± 1 strike, both sides — the keys the watch loop subscribes to so
// the feed's bid/ask is warm when a setup appears. Keys come from the
// book (numeric exchange tokens), never built from strike numbers.
function atmBandKeys(book, atm, symbol) {
  const keys = [];
  for (const s of [atm - symbol.strikeStep, atm, atm + symbol.strikeStep]) {
    for (const side of ['CE', 'PE']) {
      const k = book.instruments[`${s}|${side}`];
      if (k) keys.push(k);
    }
  }
  return keys;
}

async function suggestAll(api, ids, opts = {}) {
  const list = UNDERLYINGS.filter((s) => !ids || ids.includes(s.id));
  const budgetState = opts.budget != null ? { remaining: opts.budget } : null;
  const out = [];
  for (const symbol of list) out.push(await suggestFor(api, symbol, budgetState, opts));
  return out;
}

function fmt(n) { return Number.isFinite(n) ? String(n) : '—'; }

function px(n, d = 2) { return Number.isFinite(n) ? n.toFixed(d) : '—'; }

function vol(n) { return Number.isFinite(n) ? Math.round(n).toLocaleString('en-IN') : '—'; }

// One side's five entry conditions with the actual readings.
function formatEntryChecksSide(entry, side) {
  const v = entry.values;
  const labels = {
    CE: {
      vsVwap: `Price above VWAP — close ${px(v.close)} vs VWAP ${px(v.vwap)}`,
      emaAligned: `EMA 20 above EMA 50 — ${px(v.emaFast)} vs ${px(v.emaSlow)}`,
      rsiSide: `RSI above 50 — RSI ${px(v.rsi, 1)}`,
      macdConfirm: `MACD bullish — line ${px(v.macdLine)} vs signal ${px(v.macdSignal)}, hist ${px(v.macdHist)}`,
      volumeBacked: `Volume above MA 20 — ${vol(v.volume)} vs ${vol(v.volMa)}`,
    },
    PE: {
      vsVwap: `Price below VWAP — close ${px(v.close)} vs VWAP ${px(v.vwap)}`,
      emaAligned: `EMA 20 below EMA 50 — ${px(v.emaFast)} vs ${px(v.emaSlow)}`,
      rsiSide: `RSI below 50 — RSI ${px(v.rsi, 1)}`,
      macdConfirm: `MACD bearish — line ${px(v.macdLine)} vs signal ${px(v.macdSignal)}, hist ${px(v.macdHist)}`,
      volumeBacked: `Volume above MA 20 — ${vol(v.volume)} vs ${vol(v.volMa)}`,
    },
  };
  const conds = entry.conditionsBySide ? entry.conditionsBySide[side] : entry.conditions;
  const lines = [];
  for (const key of CHECK_KEYS) {
    if (conds[key] === undefined) {
      const note = key === 'volumeBacked'
        ? 'Volume \u2014 not available for indices (index candles carry no volume)'
        : `${key} \u2014 no data`;
      lines.push(`    ${term.yellow('?')} ${note}`);
      continue;
    }
    lines.push(`    ${conds[key] ? term.green('\u2713') : term.red('\u2717')} ${labels[side][key]}`);
  }
  return lines;
}

// Plain words for one failed entry check, so "no trade" reads as a reason
// instead of a raw indicator dump.
function checkReason(side, key, v) {
  const CE = {
    vsVwap: `price is below VWAP (close ${px(v.close)} vs ${px(v.vwap)})`,
    emaAligned: `EMA 20 is below EMA 50 (${px(v.emaFast)} vs ${px(v.emaSlow)})`,
    rsiSide: `RSI ${px(v.rsi, 1)} is below 50`,
    macdConfirm: `MACD hasn't turned bullish yet (line ${px(v.macdLine)} vs signal ${px(v.macdSignal)}, hist ${px(v.macdHist)})`,
    volumeBacked: `volume is below its 20-bar average (${vol(v.volume)} vs ${vol(v.volMa)})`,
  };
  const PE = {
    vsVwap: `price is above VWAP (close ${px(v.close)} vs ${px(v.vwap)})`,
    emaAligned: `EMA 20 is above EMA 50 (${px(v.emaFast)} vs ${px(v.emaSlow)})`,
    rsiSide: `RSI ${px(v.rsi, 1)} is above 50`,
    macdConfirm: `MACD hasn't turned bearish yet (line ${px(v.macdLine)} vs signal ${px(v.macdSignal)}, hist ${px(v.macdHist)})`,
    volumeBacked: `volume is below its 20-bar average (${vol(v.volume)} vs ${vol(v.volMa)})`,
  };
  return (side === 'CE' ? CE : PE)[key];
}

// The side that came closest to a setup (most checks passed; CE on a tie).
function closestSide(entry) {
  if (!entry.conditionsBySide) return 'CE';
  const count = (c) => Object.values(c).filter(Boolean).length;
  return count(entry.conditionsBySide.PE) > count(entry.conditionsBySide.CE) ? 'PE' : 'CE';
}

function scoreSummary(score) {
  const passed = score.checks.filter((c) => c.status === 'pass').length;
  const notChecked = score.checks.filter((c) => c.status === 'nodata').map((c) => c.label.toLowerCase());
  let s = `${passed} of ${score.checks.length} checks passed`;
  if (notChecked.length) s += `, ${notChecked.join(', ')} not checked`;
  return s;
}

function entrySummary(entry) {
  const v = entry.values;
  const volTxt = entry.conditions && entry.conditions.volumeBacked === undefined
    ? 'volume n/a (indices)'
    : 'volume above MA';
  if (entry.side === 'PE') {
    return `price below VWAP, EMA 20 < 50, RSI ${px(v.rsi, 1)}, MACD bearish, ${volTxt}`;
  }
  return `price above VWAP, EMA 20 > 50, RSI ${px(v.rsi, 1)}, MACD bullish, ${volTxt}`;
}

// The whole point of this layout: the verdict first, then only the detail
// that explains it, inside a bordered card. A trade shows the card up top;
// a no-trade shows the closest side and why it fell short, in plain words.

// Live indicator preview: the four entry checks recomputed on the forming
// 5m bar (live LTP as its close). Display only — it never gates an entry,
// and a '?' means the reading is not finite (not enough bars yet).
function liveLine(live, side) {
  if (!live || !Number.isFinite(live.close)) return null;
  const bull = side === 'CE';
  const v = live;
  const mark = (ok) => (ok === true ? term.green('\u2713') : ok === false ? term.red('\u2717') : term.yellow('?'));
  const fin = (...xs) => xs.every(Number.isFinite);
  const m = [
    mark(fin(v.close, v.vwap) ? (bull ? v.close > v.vwap : v.close < v.vwap) : undefined),
    mark(fin(v.emaFast, v.emaSlow) ? (bull ? v.emaFast > v.emaSlow : v.emaFast < v.emaSlow) : undefined),
    mark(fin(v.rsi) ? (bull ? v.rsi > 50 : v.rsi < 50) : undefined),
    mark(fin(v.macdLine, v.macdSignal, v.macdHist) ? (bull ? v.macdLine > v.macdSignal && v.macdHist > 0 : v.macdLine < v.macdSignal && v.macdHist < 0) : undefined),
  ];
  const adxTxt = Number.isFinite(v.adx) ? ` \u00b7 ADX ${px(v.adx, 1)}` : '';
  const atrTxt = Number.isFinite(v.atrPct) ? ` \u00b7 ATR ${px(v.atrPct, 2)}%` : '';
  return `LIVE forming bar \u2014 ${m[0]} VWAP ${m[1]} EMA ${m[2]} RSI ${m[3]} MACD \u00b7 close ${px(v.close)} vs VWAP ${px(v.vwap)}${adxTxt}${atrTxt} (not a signal)`;
}

function formatSuggestion(s) {
  const titleParts = [s.id];
  if (s.asOf) titleParts.push(s.asOf.slice(11)); // "12:45 IST"
  if (s.regime && s.regime.evaluable) {
    titleParts.push(`${s.regime.label} (ADX ${fmt(+s.regime.features.adx.toFixed(1))})`);
  }
  const title = term.cyan(term.bold(titleParts.join(' \u00b7 ')));
  const lines = [];
  if (s.status === 'error') {
    lines.push(term.red(`\u2717 Error \u2014 ${s.reason || 'failed'}`));
    return term.card(title, lines);
  }
  if (s.status === 'no-data') {
    lines.push(term.yellow(`\u2014 ${s.reason || 'no data'}`));
    return term.card(title, lines);
  }
  // Which side the live preview reads for: the passing side on a trade
  // (or a score-missed setup), the closest side on a no-trade.
  const liveSide = s.entry && s.entry.passed ? s.entry.side : s.entry ? closestSide(s.entry) : null;
  const ll = liveSide ? liveLine(s.live, liveSide) : null;
  if (s.status === 'trade') {
    const c = s.card;
    // A setup the loop deliberately did NOT buy (already traded today,
    // position already open, past square-off): the card must not read as
    // a buy. Show why it was skipped instead of the entry/cost lines.
    if (s.skippedReason) {
      lines.push(term.yellow(term.bold(`\u2717 NO TRADE \u2014 ${c.ticker} setup found, but ${s.skippedReason}.`)));
      lines.push(`Score ${s.score.score}/${s.score.max} (${s.score.verdict}) \u2014 ${scoreSummary(s.score)}`);
      lines.push(`${term.green('\u2713')} All 5 ${s.entry.side} checks passed \u2014 ${entrySummary(s.entry)}`);
      if (ll) lines.push(ll);
      return term.card(title, lines);
    }
    lines.push(term.green(term.bold(`\u2713 TRADE: BUY ${c.ticker} \u2014 expiry ${c.expiry}, lot ${c.lot}`)));
    if (Number.isFinite(s.generatedAtMs)) lines.push(`  Generated ${istShortDateTime(s.generatedAtMs)} IST`);
    lines.push(`  Entry \u20b9${c.ltp}  \u00b7  SL \u20b9${c.sl} (-${SL_PCT}%)  \u00b7  T1 \u20b9${c.t1} (+${T1_PCT}%)  \u00b7  T2 \u20b9${c.t2} (+${T2_PCT}%)`);
    const costLine = c.lots
      ? `  Cost/lot \u20b9${c.costPerLot} \u00b7 ${c.lots} lot${c.lots > 1 ? 's' : ''} (${c.qty} qty) \u00b7 total \u20b9${c.totalCost} \u00b7 max loss \u20b9${c.maxLoss}${c.budgetLeft != null ? ` \u00b7 budget left \u20b9${c.budgetLeft}` : ''}`
      : `  Cost/lot \u20b9${c.costPerLot}  \u00b7  max loss/lot \u20b9${c.maxLossPerLot}`;
    lines.push(costLine);
    lines.push('');
    lines.push(`Score ${s.score.score}/${s.score.max} (${s.score.verdict}) \u2014 ${scoreSummary(s.score)}`);
    lines.push(`${term.green('\u2713')} All 5 ${s.entry.side} checks passed \u2014 ${entrySummary(s.entry)}`);
    if (ll) lines.push(ll);
    return term.card(title, lines);
  }
  // No trade.
  if (s.entry && !s.entry.passed) {
    const side = closestSide(s.entry);
    const conds = s.entry.conditionsBySide[side];
    const passed = Object.values(conds).filter((v) => v === true).length;
    const failed = CHECK_KEYS.filter((k) => conds[k] === false);
    const nodata = CHECK_KEYS.filter((k) => conds[k] === undefined);
    const measured = passed + failed.length;
    const reason = failed.map((k) => checkReason(side, k, s.entry.values)).join('; ');
    const nodataNote = nodata.length ? ` (${nodata.map((k) => (k === 'volumeBacked' ? 'volume' : k)).join(', ')} not available)` : '';
    lines.push(term.yellow(term.bold(`\u2717 NO TRADE \u2014 ${side} passed ${passed} of ${measured} measured checks; ${reason}.${nodataNote}`)));
    lines.push(...formatEntryChecksSide(s.entry, side));
    if (ll) lines.push(ll);
    return term.card(title, lines);
  }
  // Entry passed but no trade: either the score is below the 70 bar, or
  // a sizing/premium block (s.reason) stopped it. Show the real reason —
  // the score message is a lie for a budget block (score 70 IS the bar).
  const missed = s.score.checks.filter((c) => c.status === 'fail');
  if (s.reason) {
    lines.push(term.yellow(term.bold(`\u2717 NO TRADE \u2014 ${s.entry.side} setup found, but ${s.reason}.`)));
  } else {
    lines.push(term.yellow(term.bold(`\u2717 NO TRADE \u2014 ${s.entry.side} setup found, but score ${s.score.score}/${s.score.max} is below the 70 bar.`)));
    if (missed.length) {
      lines.push(`Missed: ${missed.map((c) => c.label.toLowerCase()).join('; ')}.`);
    }
  }
  lines.push(`Score ${s.score.score}/${s.score.max} (${s.score.verdict}) \u2014 ${scoreSummary(s.score)}`);
  lines.push(`${term.green('\u2713')} All 5 ${s.entry.side} checks passed \u2014 ${entrySummary(s.entry)}`);
  if (ll) lines.push(ll);
  return term.card(title, lines);
}

module.exports = { suggestFor, suggestAll, formatSuggestion, loadOptionBook, atmBandKeys, UNDERLYINGS, SL_PCT, T1_PCT, T2_PCT };
