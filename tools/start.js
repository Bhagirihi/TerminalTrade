'use strict';

// `npm run start` — the V3 daily driver, now a live watch loop:
//   1. checks the Upstox token against the live API,
//   2. if it is missing or expired, ASKS to log in again (same OAuth flow
//      as `npm run login`),
//   3. shows your Upstox funds and the live NIFTY / BANKNIFTY levels,
//   4. ASKS: "Do you want Live trading?" — YES = real orders (market BUY
//      + broker SL-M at entry, exits managed by the loop), NO = paper
//      trading (records only, nothing is bought),
//   5. asks your trading budget for today (default: available funds) and
//      sizes each trade in whole lots inside it,
//   6. WATCHES the market in real time: every 30s it re-fetches candles
//      and index levels, re-renders the cards, and re-evaluates entries
//      whenever a new 5m bar closes. Open positions are monitored every
//      tick — SL (broker SL-M for live, loop exit for paper), T2, and a
//      15:15 square-off. Ctrl+C stops the loop and squares off everything.
// `npm run start -- --once` does a single pass and exits (no watching).
// Live positions live in live/v3-live-trades.jsonl, paper in
// paper/v3-paper-trades.jsonl — both local, gitignored, never pushed.

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { upstoxCredentials, runInteractiveUpstoxLogin } = require('../src/upstox-auth');
const { UpstoxApi } = require('../src/upstox-api');
const { suggestAll, formatSuggestion, loadOptionBook, atmBandKeys, UNDERLYINGS } = require('../src/suggest');
const { spreadOk } = require('../src/trade-score');
const { indicatorValues } = require('../src/entry-rules');
const { nearestStepStrike } = require('../src/strikes');
const { loadPaperTrades, savePaperTrades, recordPaperTrade, hasOpenTradeFor, closePaperTrade } = require('../src/paper');
const { loadLiveTrades, saveLiveTrades, recordLiveTrade, placeLiveEntry, syncLivePositions, exitLivePosition } = require('../src/trading');
const { writeDailyRecord, readDailyRecord, latestDailyRecord } = require('../src/daily');
const { optionsNetPnl } = require('../src/charges');
const { MarketFeed } = require('../src/market-feed');
const { card } = require('../src/terminal');
const { istDateKey, istParts, istTimeSecStr, istFullSecStr } = require('../src/time');

const POLL_MS = 30000;
const SQUARE_OFF_MIN = 15 * 60 + 15; // 15:15 IST
const CLOSE_MIN = 15 * 60 + 30; // 15:30 IST

function inr(n) {
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function askYesNo(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} (y/n) `, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

// Trading budget for today. Non-interactive runs take the default
// (available funds, if known); otherwise there is no budget cap and each
// suggestion is traded as 1 lot.
function askBudget(defaultBudget) {
  const def = defaultBudget != null && Number.isFinite(defaultBudget) && defaultBudget > 0
    ? Math.floor(defaultBudget) : null;
  if (!process.stdin.isTTY) return Promise.resolve(def);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const label = def != null
    ? `Trading budget for today (₹) [${def}]: `
    : 'Trading budget for today (₹): ';
  return new Promise((resolve) => {
    rl.question(label, (ans) => {
      rl.close();
      const n = Number(String(ans).trim().replace(/,/g, ''));
      if (Number.isFinite(n) && n > 0) return resolve(Math.floor(n));
      if (ans.trim() === '' && def != null) return resolve(def);
      console.log(`Invalid amount — using ${def != null ? `₹${def}` : '1 lot per trade'}.`);
      resolve(def);
    });
  });
}

// Market hours (IST, Mon–Fri, 09:00–15:30). Holidays are not in this
// check — on a holiday the loop just sees no new bars and idles.
function marketOpen(nowMs) {
  const p = istParts(nowMs);
  const wd = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  if (wd === 0 || wd === 6) return false;
  const mins = p.hour * 60 + p.minute;
  return mins >= 9 * 60 && mins < CLOSE_MIN;
}

function log(state, msg) {
  state.log.push({ time: istTimeSecStr(Date.now()), msg });
}

function positionLines(state) {
  const out = [];
  const all = [
    ...state.positions.live.map((p) => ({ ...p, kind: 'LIVE' })),
    ...state.positions.paper.map((p) => ({ ...p, kind: 'PAPER' })),
  ];
  if (!all.length) return out;
  for (const p of all) {
    let line = `${p.kind} ${p.ticker} — ${p.lots} lot${p.lots > 1 ? 's' : ''} @ ₹${p.entry}, SL ₹${p.sl}, T1 ₹${p.t1}, T2 ₹${p.t2}`;
    if (Number.isFinite(p.liveLtp)) {
      const { gross, net } = optionsNetPnl(p.qty, p.entry, p.liveLtp);
      line += ` — live ₹${p.liveLtp}, P&L gross ₹${inr(gross)} / net ₹${inr(net)}${p.t1Hit ? ' (T1 hit)' : ''}`;
    }
    if (p.kind === 'LIVE' && !p.slmOrderId) line += ' — NO BROKER SL-M (loop monitor only)';
    out.push(line);
  }
  return out;
}

function render(state, nowMs) {
  const feedStatus = !state.feed ? 'off' : state.feed.isLive() ? 'live' : 'down';
  const header = [
    `V3 WATCH — ${state.mode} · budget ${state.budget != null ? `₹${inr(state.budget)}` : 'uncapped'} · spent ₹${inr(state.spent)} · left ${state.remaining != null ? `₹${inr(state.remaining)}` : '—'} · feed ${feedStatus} · ${istTimeSecStr(nowMs)} IST`,
    state.funds
      ? `Upstox funds — available ₹${inr(state.funds.available)} · used ₹${inr(state.funds.used)} · total ₹${inr(state.funds.available + state.funds.used)}${state.budget != null ? ` · trade fund ₹${inr(state.budget)}` : ''}`
      : 'Upstox funds — unavailable',
    state.indexLtps && (state.indexLtps.get('NSE_INDEX|Nifty 50') || state.indexLtps.get('NSE_INDEX|Nifty Bank'))
      ? `NIFTY ${state.indexLtps.get('NSE_INDEX|Nifty 50') ? inr(state.indexLtps.get('NSE_INDEX|Nifty 50')) : '—'}  ·  BANKNIFTY ${state.indexLtps.get('NSE_INDEX|Nifty Bank') ? inr(state.indexLtps.get('NSE_INDEX|Nifty Bank')) : '—'}`
      : '',
  ].filter(Boolean);
  const cards = Object.values(state.lastCards).map((s) => formatSuggestion(s));
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[2J\x1b[0;0H');
    console.log([...header, ...cards, ...screenBlocks(state)].join('\n'));
  } else {
    const fresh = state.log.slice(state.printedLog || 0);
    state.printedLog = state.log.length;
    for (const l of fresh) console.log(`${l.time} ${l.msg}`);
  }
}

// TTY-only blocks after the index cards: today's open positions in their
// own box, a blank line, then the log in its own box. (Positions are
// today's only — the loop only ever resumes today's ledgers — and the box
// is titled with the session mode, so a paper day reads PAPER.)
function screenBlocks(state) {
  const out = [];
  const rows = positionLines(state);
  if (rows.length) {
    out.push(card(`OPEN POSITIONS (${rows.length}) · ${state.mode}`, rows));
    out.push('');
  }
  const tail = state.log.slice(-6).map((l) => `${l.time} ${l.msg}`);
  if (tail.length) out.push(card('LOG', tail));
  return out;
}

async function enterTrade(state, api, s, nowMs) {
  const key = `${s.card.ticker}|${s.card.expiry}`;
  const today = istDateKey(nowMs);
  state.tradedToday.add(key);
  if (state.mode === 'PAPER') {
    const trade = {
      id: `${today}-${s.card.ticker.replace(/ /g, '-')}`,
      date: today,
      recordedAt: new Date(nowMs).toISOString(),
      ticker: s.card.ticker,
      strike: s.card.strike,
      expiry: s.card.expiry,
      side: s.entry.side,
      instrumentKey: s.card.instrumentKey,
      lots: s.card.lots,
      qty: s.card.qty,
      lotSize: s.card.lot,
      entry: s.card.ltp,
      sl: s.card.sl,
      t1: s.card.t1,
      t2: s.card.t2,
      costPerLot: s.card.costPerLot,
      totalCost: s.card.totalCost,
      maxLoss: s.card.maxLoss,
      budgetLeft: s.card.budgetLeft != null ? s.card.budgetLeft : null,
      status: 'OPEN',
    };
    recordPaperTrade(trade);
    state.positions.paper.push(trade);
    state.spent = +(state.spent + trade.totalCost).toFixed(2);
    if (state.remaining != null) state.remaining = Math.max(0, +(state.remaining - trade.totalCost).toFixed(2));
    if (state.feed) state.feed.subscribe([trade.instrumentKey]);
    log(state, `PAPER BUY ${trade.ticker} ${trade.lots} lot${trade.lots > 1 ? 's' : ''} @ ₹${trade.entry} (total ₹${inr(trade.totalCost)})`);
    try { writeDailyRecord(today, { budget: state.budget }); } catch (_) { /* daily file is best-effort */ }
    return;
  }
  // LIVE
  try {
    const placed = await placeLiveEntry(api, s.card, s.card.qty);
    const trade = {
      id: `${today}-${s.card.ticker.replace(/ /g, '-')}`,
      date: today,
      recordedAt: new Date(nowMs).toISOString(),
      ticker: s.card.ticker,
      strike: s.card.strike,
      expiry: s.card.expiry,
      side: s.entry.side,
      instrumentKey: s.card.instrumentKey,
      lots: s.card.lots,
      qty: s.card.qty,
      lotSize: s.card.lot,
      entry: placed.entry,
      sl: placed.sl,
      t1: placed.t1,
      t2: placed.t2,
      costPerLot: +(placed.entry * s.card.lot).toFixed(2),
      totalCost: +(placed.entry * s.card.qty).toFixed(2),
      maxLoss: +(placed.entry * s.card.qty * 0.05).toFixed(2),
      buyOrderId: placed.buyOrderId,
      slmOrderId: placed.slmOrderId,
      slmError: placed.slmError || null,
      fillUnknown: placed.fillUnknown || false,
      status: 'OPEN',
    };
    recordLiveTrade(trade);
    state.positions.live.push(trade);
    state.spent = +(state.spent + trade.totalCost).toFixed(2);
    if (state.remaining != null) state.remaining = Math.max(0, +(state.remaining - trade.totalCost).toFixed(2));
    if (state.feed) state.feed.subscribe([trade.instrumentKey]);
    log(state, `LIVE BUY ${trade.ticker} ${trade.lots} lot${trade.lots > 1 ? 's' : ''} @ ₹${trade.entry} (order ${trade.buyOrderId}, total ₹${inr(trade.totalCost)})${trade.slmOrderId ? ` — SL-M ${trade.slmOrderId}` : ' — SL-M FAILED, loop monitor is the only stop'}`);
    try { writeDailyRecord(today, { budget: state.budget }); } catch (_) { /* daily file is best-effort */ }
  } catch (e) {
    log(state, `LIVE BUY FAILED ${s.card.ticker}: ${e.message || e} — no position taken`);
    state.tradedToday.delete(key); // a failed buy does not burn the day's chance
  }
}

function maybeUnsubscribe(state, key) {
  if (!state.feed) return;
  const stillOpen = [...state.positions.live, ...state.positions.paper]
    .some((p) => p.status === 'OPEN' && p.instrumentKey === key);
  if (!stillOpen) state.feed.unsubscribe([key]);
}

// Return a closed trade's net proceeds to the day's budget so the loop can
// trade again after a close: remaining += entry cost + net P&L (the exit
// value minus charges), spent -= the same, so spent + remaining == budget
// always. A win can push remaining above the budget — that is real profit,
// not a bug. Guarded by state.creditedCloses so a position is credited
// exactly once even if two paths see the same close.
function creditClose(state, pos) {
  if (!pos) return;
  if (!state.creditedCloses) state.creditedCloses = new Set();
  if (state.creditedCloses.has(pos.id)) return;
  state.creditedCloses.add(pos.id);
  const entryCost = Number(pos.totalCost) || (Number(pos.qty) || 0) * (Number(pos.entry) || 0);
  const net = Number(pos.netPnl) || 0;
  const credit = +(entryCost + net).toFixed(2);
  state.spent = +(state.spent - credit).toFixed(2);
  if (state.remaining != null) state.remaining = +(state.remaining + credit).toFixed(2);
}

// After a close: recycle the budget and refresh the stored daily record
// for the trade's date. The daily write is best-effort — a disk failure
// must not break the watch loop, so it only logs.
function noteClosedTrade(state, pos) {
  creditClose(state, pos);
  try {
    writeDailyRecord(pos.date, { budget: state.budget });
  } catch (e) {
    log(state, `daily record write failed for ${pos.date}: ${e.message || e}`);
  }
}

// Check one open position against a fresh LTP — from a feed tick (realtime)
// or the 30s REST poll. Exits at SL/T2, notes T1. Guarded by pos.exiting
// so a feed tick and the poll can't both sell the same position.
async function checkPositionQuote(state, api, pos, kind, ltp, nowMs) {
  if (pos.status !== 'OPEN' || pos.exiting) return;
  pos.liveLtp = ltp;
  if (ltp >= pos.t1 && !pos.t1Hit) {
    pos.t1Hit = true;
    log(state, `${kind} ${pos.ticker} T1 hit @ ₹${ltp}`);
  }
  const saveLedger = () => {
    if (kind === 'PAPER') savePaperTrades(loadPaperTrades().map((t) => {
      const cur = state.positions.paper.find((p) => p.id === t.id);
      return cur || t;
    }));
    else saveLiveTrades(loadLiveTrades().map((t) => {
      const cur = state.positions.live.find((p) => p.id === t.id);
      return cur || t;
    }));
  };
  if (kind === 'PAPER') {
    if (ltp <= pos.sl) {
      closePaperTrade(pos, pos.sl, 'SL', nowMs);
      log(state, `PAPER ${pos.ticker} closed SL @ ₹${pos.exit} — net ₹${inr(pos.netPnl)}`);
      saveLedger();
      noteClosedTrade(state, pos);
      maybeUnsubscribe(state, pos.instrumentKey);
    } else if (ltp >= pos.t2) {
      closePaperTrade(pos, pos.t2, 'T2', nowMs);
      log(state, `PAPER ${pos.ticker} closed T2 @ ₹${pos.exit} — net ₹${inr(pos.netPnl)}`);
      saveLedger();
      noteClosedTrade(state, pos);
      maybeUnsubscribe(state, pos.instrumentKey);
    }
    return;
  }
  // LIVE
  if (ltp >= pos.t2) {
    pos.exiting = true;
    try {
      const r = await exitLivePosition(api, pos, 'T2', pos.t2);
      if (r.ok) {
        log(state, `LIVE ${pos.ticker} closed T2 @ ₹${r.exit} — net ₹${inr(pos.netPnl)}`);
        saveLedger();
        noteClosedTrade(state, pos);
        maybeUnsubscribe(state, pos.instrumentKey);
      } else {
        log(state, `LIVE ${pos.ticker} T2 exit skipped: ${r.reason}`);
        pos.exiting = false;
      }
    } catch (e) {
      log(state, `LIVE ${pos.ticker} T2 exit FAILED: ${e.message || e} — position still open`);
      pos.exiting = false;
    }
  } else if (ltp <= pos.sl && !pos.slmOrderId) {
    // No broker stop exists (SL-M placement failed) — the loop is the
    // only stop, so sell at market now.
    pos.exiting = true;
    try {
      const r = await exitLivePosition(api, pos, 'SL', pos.sl);
      if (r.ok) {
        log(state, `LIVE ${pos.ticker} closed SL @ ₹${r.exit} — net ₹${inr(pos.netPnl)} (no SL-M existed)`);
        saveLedger();
        noteClosedTrade(state, pos);
        maybeUnsubscribe(state, pos.instrumentKey);
      } else {
        log(state, `LIVE ${pos.ticker} SL exit skipped: ${r.reason}`);
        pos.exiting = false;
      }
    } catch (e) {
      log(state, `LIVE ${pos.ticker} SL exit FAILED: ${e.message || e} — position still open`);
      pos.exiting = false;
    }
  }
}

async function monitorPositions(state, api, nowMs) {
  const open = [...state.positions.live, ...state.positions.paper];
  if (!open.length) return;

  // Live: the broker SL-M is the stop — detect its fill first.
  if (state.positions.live.length) {
    try {
      const closed = await syncLivePositions(api, state.positions.live);
      for (const c of closed) {
        log(state, `LIVE ${c.ticker} closed SL-M @ ₹${c.exit} — net ₹${inr(c.netPnl)}`);
        noteClosedTrade(state, c);
        maybeUnsubscribe(state, c.instrumentKey);
      }
    } catch (e) {
      log(state, `live SL-M sync failed: ${e.message || e}`);
    }
  }

  // Fresh LTPs: feed first (realtime), REST batch fills any gaps.
  let ltps = new Map();
  if (state.feed && state.feed.isLive()) {
    for (const p of open) {
      const q = state.feed.getQuote(p.instrumentKey);
      if (q) ltps.set(p.instrumentKey, q.ltp);
    }
  }
  if (ltps.size < open.length) {
    try {
      const rest = await api.getLtps(open.map((p) => p.instrumentKey));
      for (const [k, v] of rest) if (!ltps.has(k)) ltps.set(k, v);
    } catch (_) { /* positions show without live prices */ }
  }
  for (const pos of state.positions.paper) {
    const ltp = ltps.get(pos.instrumentKey);
    if (Number.isFinite(ltp)) await checkPositionQuote(state, api, pos, 'PAPER', ltp, nowMs);
  }
  for (const pos of state.positions.live) {
    const ltp = ltps.get(pos.instrumentKey);
    if (Number.isFinite(ltp)) await checkPositionQuote(state, api, pos, 'LIVE', ltp, nowMs);
  }
}

// Square off every open position (15:15, or when the loop stops).
async function squareOffAll(state, api, nowMs) {
  const closedNow = [];
  let liveChanged = false;
  for (const pos of state.positions.live) {
    if (pos.status !== 'OPEN') continue;
    try {
      const r = await exitLivePosition(api, pos, '15:15', Number.isFinite(pos.liveLtp) ? pos.liveLtp : pos.entry);
      if (r.ok) {
        log(state, `LIVE ${pos.ticker} squared off @ ₹${r.exit} — net ₹${inr(pos.netPnl)}`);
        liveChanged = true;
        closedNow.push(pos);
        maybeUnsubscribe(state, pos.instrumentKey);
      } else log(state, `LIVE ${pos.ticker} square-off skipped: ${r.reason} — STILL OPEN, check Upstox`);
    } catch (e) {
      log(state, `LIVE ${pos.ticker} square-off FAILED: ${e.message || e} — STILL OPEN, check Upstox`);
    }
  }
  let paperChanged = false;
  for (const pos of state.positions.paper) {
    if (pos.status !== 'OPEN') continue;
    closePaperTrade(pos, Number.isFinite(pos.liveLtp) ? pos.liveLtp : pos.entry, '15:15', nowMs);
    log(state, `PAPER ${pos.ticker} squared off @ ₹${pos.exit} — net ₹${inr(pos.netPnl)}`);
    paperChanged = true;
    closedNow.push(pos);
    maybeUnsubscribe(state, pos.instrumentKey);
  }
  if (liveChanged) saveLiveTrades(loadLiveTrades().map((t) => {
    const cur = state.positions.live.find((p) => p.id === t.id);
    return cur || t;
  }));
  if (paperChanged) savePaperTrades(loadPaperTrades().map((t) => {
    const cur = state.positions.paper.find((p) => p.id === t.id);
    return cur || t;
  }));
  // Recycle the budget and refresh the daily records once the ledger
  // saves above have landed, so the daily files read the closed trades.
  for (const p of closedNow) noteClosedTrade(state, p);
}

// One watch tick. Returns 'done' when the market day is over.
async function warmLiquidityBand(state, api) {
  // Subscribe to the ATM ± 1 strike CE/PE keys (from the contracts API's
  // numeric tokens) so the feed's bid/ask is warm when a setup appears
  // and the score can judge liquidity. The book is cached and refreshed
  // only when the ATM moves more than a strike or every 30 minutes.
  if (!state.feed) return;
  if (!state.warmBook) state.warmBook = {};
  for (const symbol of UNDERLYINGS) {
    const ltp = state.indexLtps.get(symbol.upstoxKey);
    if (!Number.isFinite(ltp)) continue;
    const atm = nearestStepStrike(ltp, symbol.strikeStep);
    const cached = state.warmBook[symbol.id];
    const stale = !cached || Date.now() - cached.atMs > 30 * 60 * 1000
      || Math.abs(atm - cached.atm) > symbol.strikeStep;
    if (!stale) continue;
    try {
      const book = await loadOptionBook(api, symbol, istDateKey(Date.now()));
      state.warmBook[symbol.id] = { book, atm, atMs: Date.now() };
      state.feed.subscribe(atmBandKeys(book, atm, symbol));
    } catch (e) {
      log(state, `${symbol.id} warm-up book failed: ${e.message || e}`);
    }
  }
}

// Recompute the live indicator preview for one underlying: the same
// VWAP/EMA/RSI/MACD as the entry rules, but on [...closed 5m bars, the
// forming bar] so the card shows where the indicators stand right now.
// Display only — it never gates an entry, which still needs a closed bar.
function updateLiveValues(state, id) {
  if (!state.bars5) state.bars5 = {};
  if (!state.formingBar) state.formingBar = {};
  if (!state.liveValues) state.liveValues = {};
  const bars5 = state.bars5[id];
  const forming = state.formingBar[id];
  if (!bars5 || bars5.length < 60 || !forming) return;
  const live = indicatorValues([...bars5, forming]);
  if (live) {
    state.liveValues[id] = live;
    if (state.lastCards[id]) state.lastCards[id].live = live;
  }
}

async function tick(state, api, nowMs) {
  const p = istParts(nowMs);
  const mins = p.hour * 60 + p.minute;
  if (mins >= CLOSE_MIN) return 'done';
  const today = istDateKey(nowMs);

  // Index levels: realtime feed first, REST fills any gaps.
  let indexLtps = new Map();
  if (state.feed && state.feed.isLive()) {
    for (const k of ['NSE_INDEX|Nifty 50', 'NSE_INDEX|Nifty Bank']) {
      const q = state.feed.getQuote(k);
      if (q) indexLtps.set(k, q.ltp);
    }
  }
  if (indexLtps.size < 2) {
    try {
      const rest = await api.getLtps(['NSE_INDEX|Nifty 50', 'NSE_INDEX|Nifty Bank']);
      for (const [k, v] of rest) if (!indexLtps.has(k)) indexLtps.set(k, v);
    } catch (_) { /* header keeps the last levels */ }
  }
  state.indexLtps = indexLtps;

  // Warm the feed's bid/ask for the ATM band before scoring, so the
  // liquidity check has a live spread to judge.
  await warmLiquidityBand(state, api);

  let suggestions = [];
  try {
    suggestions = await suggestAll(api, undefined, {
      budget: state.remaining,
      // Liquidity: the ATM option's spread from the live feed. No quote
      // yet (feed down, or the band still warming up) -> null -> the
      // check scores as 'nodata', exactly like before the feed existed.
      liquidityFor: (key) => {
        const q = state.feed ? state.feed.getQuote(key) : null;
        if (!q) return null;
        return spreadOk(q.bid, q.ask);
      },
    });
  } catch (e) {
    log(state, `suggestions failed: ${e.message || e}`);
  }
  for (const s of suggestions) {
    const prevBar = state.lastBar[s.id];
    state.lastBar[s.id] = s.asOf;
    state.lastCards[s.id] = s;
    if (s.bars5) { if (!state.bars5) state.bars5 = {}; state.bars5[s.id] = s.bars5; }
    if (s.asOf === prevBar) continue; // same 5m bar — nothing new to act on
    log(state, `${s.id}: ${s.status === 'trade' ? `TRADE ${s.card.ticker} ${s.score.score}/100` : s.status === 'no-trade' ? 'no setup' : s.status} (new 5m bar ${s.asOf})`);
    if (s.status !== 'trade') continue;
    if (mins >= SQUARE_OFF_MIN) continue; // past square-off, no new entries
    if (state.tradedToday.has(`${s.card.ticker}|${s.card.expiry}`)) continue;
    if (state.positions.live.concat(state.positions.paper).some((pos) => pos.status === 'OPEN' && pos.ticker === s.card.ticker && pos.expiry === s.card.expiry)) continue;
    await enterTrade(state, api, s, nowMs);
  }

  // Live indicator preview: refresh the forming 5m bar from REST and
  // recompute the indicators on it. The feed then moves the forming bar
  // tick by tick in onQuote until the next 30s refresh.
  for (const symbol of UNDERLYINGS) {
    if (!state.formingBar) state.formingBar = {};
    try {
      const forming = await api.getFormingBar(symbol.upstoxKey, 5);
      if (forming) state.formingBar[symbol.id] = forming;
    } catch (_) { /* keep the last forming bar */ }
    updateLiveValues(state, symbol.id);
  }

  await monitorPositions(state, api, nowMs);
  if (mins >= SQUARE_OFF_MIN) await squareOffAll(state, api, nowMs);
  render(state, nowMs);
  return mins >= CLOSE_MIN ? 'done' : 'ok';
}

function daySummary(state) {
  const all = [...state.positions.live, ...state.positions.paper];
  const closed = all.filter((t) => t.status === 'CLOSED');
  const open = all.filter((t) => t.status === 'OPEN');
  const net = closed.reduce((a, t) => a + (Number(t.netPnl) || 0), 0);
  const lines = [
    `--- Day summary (${state.mode}) ---`,
    `Trades today: ${all.length} (${closed.length} closed, ${open.length} open)`,
    `Closed net P&L: ₹${inr(net)}`,
  ];
  for (const t of closed) lines.push(`  ${t.ticker} ${t.exitReason} @ ₹${t.exit} — net ₹${inr(t.netPnl)}`);
  for (const t of open) lines.push(`  ${t.ticker} STILL OPEN @ entry ₹${t.entry} — check Upstox${t.slmOrderId ? ' (SL-M live)' : ' (NO broker stop)'}`);
  return lines.join('\n');
}


// One loop per machine: a second start (interactive or service) refuses
// while another is alive, so two loops can never trade the same day. A
// lock whose pid is dead (crash, kill -9, power cut) is stale and is
// taken over by the next start.
const LOCK_FILE = path.join(__dirname, '..', 'v3-loop.lock');
function acquireLock() {
  try {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, 0); return { ok: false, pid }; } catch (_) { /* stale — take over */ }
    }
  } catch (_) { /* no lock file */ }
  try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}
function releaseLock() { try { fs.unlinkSync(LOCK_FILE); } catch (_) { /* already gone */ } }

// Derive today's budget state from the paper + live ledgers: spent is the
// money already committed — open/expired trades at full entry cost, closed
// trades at their realised loss (or minus their win) — and tradedToday
// covers every contract traded today, open or closed, so a restart can
// never re-enter a contract the day already traded.
function deriveDayState(today, budget) {
  const all = [
    ...loadPaperTrades().filter((t) => t.date === today),
    ...loadLiveTrades().filter((t) => t.date === today),
  ];
  let spent = 0;
  const tradedToday = new Set();
  let openCount = 0;
  for (const t of all) {
    tradedToday.add(`${t.ticker}|${t.expiry}`);
    if (t.status === 'CLOSED') spent += -(Number(t.netPnl) || 0);
    else { spent += Number(t.totalCost) || 0; if (t.status === 'OPEN') openCount += 1; }
  }
  spent = +spent.toFixed(2);
  const remaining = budget != null ? Math.max(0, +(budget - spent).toFixed(2)) : null;
  return { spent, remaining, tradedToday, tradedCount: all.length, openCount };
}

// Today's stored session (mode + budget) plus the ledger-derived state.
// When today has no session stored yet, the most recent earlier day's mode
// and budget carry forward — so a fresh day can start on its own with the
// last day's settings, and the morning is just the login. Spent/left still
// come from TODAY's ledgers (empty on a fresh morning). Null only when no
// day has ever stored a session — the very first run.
function loadDayState(today) {
  const rec = readDailyRecord(today);
  if (rec && rec.mode != null && rec.budget != null) {
    return { mode: rec.mode, budget: rec.budget, carriedFrom: null, ...deriveDayState(today, rec.budget) };
  }
  const prev = latestDailyRecord(today);
  if (!prev || prev.mode == null || prev.budget == null) return null;
  return { mode: prev.mode, budget: prev.budget, carriedFrom: prev.date, ...deriveDayState(today, prev.budget) };
}

async function main() {
  // One loop per machine — see acquireLock above.
  const lock = acquireLock();
  if (!lock.ok) {
    console.log(lock.pid
      ? `Another V3 loop is already running (pid ${lock.pid}) — refusing to start a second one. Stop it first (tools/v3-service.sh stop) or wait for it to finish.`
      : `Cannot take the loop lock: ${lock.error || 'unknown error'}.`);
    process.exitCode = 1;
    return;
  }
  try { await runMain(); } finally { releaseLock(); }
}

async function runMain() {
  const once = process.argv.includes('--once');
  const service = process.argv.includes('--service');
  const fresh = process.argv.includes('--fresh');
  let creds = upstoxCredentials();
  let api = new UpstoxApi(creds.accessToken);
  let check = await api.checkToken();

  if (!check.ok && check.reason !== 'error') {
    if (service) {
      console.log(`Upstox token ${check.reason === 'missing' ? 'missing from .env' : `expired (${check.detail})`} — service mode cannot log in. Log in once (npm run login); the watchdog will start the loop on its own after that.`);
      process.exitCode = 1;
      return;
    }
    if (check.reason === 'missing') {
      console.log('No Upstox token in .env.');
    } else {
      console.log(`Upstox token expired (${check.detail}).`);
    }
    const yes = await askYesNo('Log in again now?');
    if (!yes) {
      console.log('Run `npm run login` when ready, then `npm run start` again.');
      process.exitCode = 1;
      return;
    }
    const result = await runInteractiveUpstoxLogin({});
    console.log(`Logged in as ${result.userName}. Token saved.`);
    creds = upstoxCredentials();
    api = new UpstoxApi(creds.accessToken);
    check = await api.checkToken();
    if (!check.ok) {
      console.error(`Still not logged in: ${check.detail}`);
      process.exitCode = 1;
      return;
    }
  } else if (!check.ok) {
    console.error(`Upstox API error (not a token problem): ${check.detail}`);
    process.exitCode = 1;
    return;
  }

  console.log('Token OK.');

  // Funds + live index levels, best effort — a failure here never blocks
  // the watch below.
  let funds = null;
  try { funds = await api.getFunds(); } catch (_) { /* header shows unavailable */ }
  let indexLtps = new Map();
  try {
    indexLtps = await api.getLtps(['NSE_INDEX|Nifty 50', 'NSE_INDEX|Nifty Bank']);
  } catch (_) { /* header omits the levels */ }
  const nifty = indexLtps.get('NSE_INDEX|Nifty 50');
  const bank = indexLtps.get('NSE_INDEX|Nifty Bank');
  if (nifty || bank) {
    console.log(`NIFTY ${nifty ? inr(nifty) : '—'}  ·  BANKNIFTY ${bank ? inr(bank) : '—'}`);
  }

  const nowMs = Date.now();
  if (!once && !marketOpen(nowMs)) {
    console.log(`Market is closed (IST ${istTimeSecStr(nowMs)}) — nothing to watch. Run again during market hours (Mon–Fri 09:00–15:30 IST).`);
    return;
  }

  const today = istDateKey(nowMs);

  // Resume today's session when one exists: mode + budget come from the
  // day's stored record, spent/left and the traded-today list from the
  // ledgers — so a restart (or a service start) continues the day instead
  // of resetting it. --fresh ignores the stored session and asks again.
  let mode = null;
  let budget = null;
  let dayState = null;
  if (!fresh) {
    const restored = loadDayState(today);
    if (restored) {
      ({ mode, budget } = restored);
      dayState = restored;
      console.log(`Resuming today's ${mode} session — budget ₹${inr(budget)}${restored.carriedFrom ? ` (carried forward from ${restored.carriedFrom})` : ''}, spent ₹${inr(restored.spent)}, left ₹${inr(restored.remaining)}, ${restored.tradedCount} trade(s) today (${restored.openCount} open).`);
    }
  }
  if (mode == null) {
    if (service) {
      console.log('No session yet today — run `npm run start` once interactively to set the mode and budget, then the service will resume it on its own.');
      process.exitCode = 1;
      return;
    }
    const liveAns = await askYesNo('Do you want Live trading?');
    mode = liveAns ? 'LIVE' : 'PAPER';
    budget = await askBudget(funds ? funds.available : null);
    if (budget != null) console.log(`Trading budget for today: ₹${inr(budget)}`);
    dayState = deriveDayState(today, budget);
  }
  const live = mode === 'LIVE';
  // Funds line prints here (not earlier) so it can carry the trade fund
  // — the budget you just entered (or resumed).
  if (funds) {
    const total = funds.available + funds.used;
    console.log(`Upstox funds — available ₹${inr(funds.available)} · used ₹${inr(funds.used)} · total ₹${inr(total)}${budget != null ? ` · trade fund ₹${inr(budget)}` : ''}`);
  } else {
    console.log('Upstox funds — unavailable');
  }
  console.log(live
    ? 'LIVE mode — the loop will place real market orders (BUY + SL-M) when a setup appears, within your budget.'
    : 'Paper trading only — no live orders placed. Run `npm run paper` to see how they did.');
  // Store the session immediately (mode + budget) so a restart or a
  // service start can resume from this moment on, even before the first
  // trade of the day.
  try { writeDailyRecord(today, { budget, mode }); } catch (_) { /* daily file is best-effort */ }

  // Realtime price feed (Upstox websocket v3). Best effort — if it never
  // connects, the loop falls back to REST LTP polling and keeps working.
  // onQuote checks open positions on the tick that crosses SL/T2 and
  // re-renders the screen (throttled to 1/s) so prices move live.
  let state = null;
  const feed = new MarketFeed({
    token: creds.accessToken,
    onQuote: (q) => {
      if (!state) return;
      // The header levels come from state.indexLtps, which the 30s tick
      // refreshes — so a live index tick must land there too, or the
      // header looks frozen between ticks even while the feed is live.
      if (q.instrumentKey === 'NSE_INDEX|Nifty 50' || q.instrumentKey === 'NSE_INDEX|Nifty Bank') {
        state.indexLtps.set(q.instrumentKey, q.ltp);
      }
      // Move the forming 5m bar with the live price; the indicator
      // preview is recomputed from it on the throttled re-render below.
      const symbol = UNDERLYINGS.find((u) => u.upstoxKey === q.instrumentKey);
      if (symbol && state.formingBar[symbol.id]) {
        const f = state.formingBar[symbol.id];
        f.close = q.ltp;
        if (q.ltp > f.high) f.high = q.ltp;
        if (q.ltp < f.low) f.low = q.ltp;
      }
      const pos = [...state.positions.live, ...state.positions.paper]
        .find((p) => p.status === 'OPEN' && p.instrumentKey === q.instrumentKey);
      if (pos) {
        const kind = state.positions.live.includes(pos) ? 'LIVE' : 'PAPER';
        checkPositionQuote(state, api, pos, kind, q.ltp, Date.now())
          .catch((e) => log(state, `quote check failed: ${e.message || e}`));
      }
      if (process.stdout.isTTY && Date.now() - (state.lastRenderMs || 0) > 1000) {
        state.lastRenderMs = Date.now();
        for (const symbol of UNDERLYINGS) updateLiveValues(state, symbol.id);
        render(state, Date.now());
      }
    },
    onStatus: (msg) => { if (state) log(state, msg); },
  });
  feed.start();
  feed.subscribe(['NSE_INDEX|Nifty 50', 'NSE_INDEX|Nifty Bank']);

  state = {
    mode,
    budget,
    remaining: dayState.remaining,
    spent: dayState.spent,
    funds,
    indexLtps,
    feed,
    positions: {
      live: loadLiveTrades().filter((t) => t.status === 'OPEN' && t.date === today),
      paper: loadPaperTrades().filter((t) => t.status === 'OPEN' && t.date === today),
    },
    tradedToday: dayState.tradedToday,
    creditedCloses: new Set(),
    lastBar: {},
    lastCards: {},
    warmBook: {},
    bars5: {},
    formingBar: {},
    liveValues: {},
    log: [],
    printedLog: 0,
    lastRenderMs: 0,
  };
  if (state.positions.live.length || state.positions.paper.length) {
    log(state, `Resumed ${state.positions.live.length} live + ${state.positions.paper.length} paper open position(s) from today.`);
    feed.subscribe([...state.positions.live, ...state.positions.paper].map((t) => t.instrumentKey));
  }

  if (once) {
    await tick(state, api, Date.now());
    console.log(daySummary(state));
    try { writeDailyRecord(istDateKey(Date.now()), { budget: state.budget }); } catch (_) { /* daily file is best-effort */ }
    feed.stop();
    return;
  }

  console.log(`Watching the market (${mode}) — every ${POLL_MS / 1000}s. Ctrl+C stops and squares off.`);
  let stop = false;
  let timer = null;
  let wakeUp = null;
  let sigintCount = 0;
  const stopLoop = () => {
    sigintCount += 1;
    if (sigintCount > 1) {
      // Second ^C: stop waiting for a graceful shutdown and exit now.
      // Any open live position keeps its broker SL-M as protection.
      console.log('Force quitting — open live positions keep their broker SL-M.');
      process.exit(130);
    }
    stop = true;
    feed.stop();
    if (timer) clearTimeout(timer);
    // The 30s sleep is a promise resolved by its timer — clearing the
    // timer alone never resolves it, so ^C used to hang here forever.
    // Resolving it lets the loop see `stop` and shut down.
    if (wakeUp) wakeUp();
    // Safety net: a stuck tick or square-off must not hang the process
    // forever. Unref'd, so a clean shutdown still exits promptly.
    const force = setTimeout(() => process.exit(130), 20000);
    force.unref();
  };
  process.on('SIGINT', stopLoop);
  process.on('SIGTERM', stopLoop);
  while (!stop) {
    const done = await tick(state, api, Date.now());
    if (done === 'done' || stop) break;
    await new Promise((r) => { wakeUp = r; timer = setTimeout(r, POLL_MS); });
    wakeUp = null;
    timer = null;
  }
  if (stop) log(state, 'Stopping — squaring off all open positions.');
  await squareOffAll(state, api, Date.now());
  render(state, Date.now());
  console.log(daySummary(state));
  try { writeDailyRecord(istDateKey(Date.now()), { budget: state.budget }); } catch (_) { /* daily file is best-effort */ }
  feed.stop();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exitCode = 1;
  });
}

module.exports = { tick, enterTrade, monitorPositions, squareOffAll, checkPositionQuote, creditClose, noteClosedTrade, warmLiquidityBand, updateLiveValues, marketOpen, render, screenBlocks, positionLines, daySummary, loadDayState, deriveDayState, acquireLock, releaseLock };
