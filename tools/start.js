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
const { upstoxCredentials, runInteractiveUpstoxLogin } = require('../src/upstox-auth');
const { UpstoxApi } = require('../src/upstox-api');
const { suggestAll, formatSuggestion } = require('../src/suggest');
const { loadPaperTrades, savePaperTrades, recordPaperTrade, hasOpenTradeFor, closePaperTrade } = require('../src/paper');
const { loadLiveTrades, saveLiveTrades, recordLiveTrade, placeLiveEntry, syncLivePositions, exitLivePosition } = require('../src/trading');
const { optionsNetPnl } = require('../src/charges');
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
  out.push(`OPEN POSITIONS (${all.length}):`);
  for (const p of all) {
    let line = `  ${p.kind} ${p.ticker} — ${p.lots} lot${p.lots > 1 ? 's' : ''} @ ₹${p.entry}, SL ₹${p.sl}, T1 ₹${p.t1}, T2 ₹${p.t2}`;
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
  const header = [
    `V3 WATCH — ${state.mode} · budget ${state.budget != null ? `₹${inr(state.budget)}` : 'uncapped'} · spent ₹${inr(state.spent)} · left ${state.remaining != null ? `₹${inr(state.remaining)}` : '—'} · ${istTimeSecStr(nowMs)} IST`,
    state.funds
      ? `Upstox funds — available ₹${inr(state.funds.available)} · used ₹${inr(state.funds.used)} · total ₹${inr(state.funds.available + state.funds.used)}`
      : 'Upstox funds — unavailable',
    state.indexLtps && (state.indexLtps.get('NSE_INDEX|Nifty 50') || state.indexLtps.get('NSE_INDEX|Nifty Bank'))
      ? `NIFTY ${state.indexLtps.get('NSE_INDEX|Nifty 50') ? inr(state.indexLtps.get('NSE_INDEX|Nifty 50')) : '—'}  ·  BANKNIFTY ${state.indexLtps.get('NSE_INDEX|Nifty Bank') ? inr(state.indexLtps.get('NSE_INDEX|Nifty Bank')) : '—'}`
      : '',
  ].filter(Boolean);
  const cards = Object.values(state.lastCards).map((s) => formatSuggestion(s));
  const positions = positionLines(state);
  const tail = state.log.slice(-6).map((l) => `${l.time} ${l.msg}`);
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[2J\x1b[0;0H');
    console.log([...header, ...cards, ...positions, ...tail].join('\n'));
  } else {
    const fresh = state.log.slice(state.printedLog || 0);
    state.printedLog = state.log.length;
    for (const l of fresh) console.log(`${l.time} ${l.msg}`);
  }
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
    log(state, `PAPER BUY ${trade.ticker} ${trade.lots} lot${trade.lots > 1 ? 's' : ''} @ ₹${trade.entry} (total ₹${inr(trade.totalCost)})`);
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
    log(state, `LIVE BUY ${trade.ticker} ${trade.lots} lot${trade.lots > 1 ? 's' : ''} @ ₹${trade.entry} (order ${trade.buyOrderId}, total ₹${inr(trade.totalCost)})${trade.slmOrderId ? ` — SL-M ${trade.slmOrderId}` : ' — SL-M FAILED, loop monitor is the only stop'}`);
  } catch (e) {
    log(state, `LIVE BUY FAILED ${s.card.ticker}: ${e.message || e} — no position taken`);
    state.tradedToday.delete(key); // a failed buy does not burn the day's chance
  }
}

async function monitorPositions(state, api, nowMs) {
  const open = [...state.positions.live, ...state.positions.paper];
  if (!open.length) return;
  let ltps = new Map();
  try { ltps = await api.getLtps(open.map((p) => p.instrumentKey)); } catch (_) { /* positions show without live prices */ }

  // Live: the broker SL-M is the stop — detect its fill first.
  if (state.positions.live.length) {
    try {
      const closed = await syncLivePositions(api, state.positions.live);
      for (const c of closed) log(state, `LIVE ${c.ticker} closed SL-M @ ₹${c.exit} — net ₹${inr(c.netPnl)}`);
    } catch (e) {
      log(state, `live SL-M sync failed: ${e.message || e}`);
    }
  }

  let paperChanged = false;
  let liveChanged = false;
  for (const pos of state.positions.paper) {
    if (pos.status !== 'OPEN') continue;
    const ltp = ltps.get(pos.instrumentKey);
    if (!Number.isFinite(ltp)) continue;
    pos.liveLtp = ltp;
    if (ltp >= pos.t1 && !pos.t1Hit) { pos.t1Hit = true; log(state, `PAPER ${pos.ticker} T1 hit @ ₹${ltp}`); }
    if (ltp <= pos.sl) {
      closePaperTrade(pos, pos.sl, 'SL', nowMs);
      log(state, `PAPER ${pos.ticker} closed SL @ ₹${pos.exit} — net ₹${inr(pos.netPnl)}`);
      paperChanged = true;
    } else if (ltp >= pos.t2) {
      closePaperTrade(pos, pos.t2, 'T2', nowMs);
      log(state, `PAPER ${pos.ticker} closed T2 @ ₹${pos.exit} — net ₹${inr(pos.netPnl)}`);
      paperChanged = true;
    }
  }
  for (const pos of state.positions.live) {
    if (pos.status !== 'OPEN') continue;
    const ltp = ltps.get(pos.instrumentKey);
    if (!Number.isFinite(ltp)) continue;
    pos.liveLtp = ltp;
    if (ltp >= pos.t1 && !pos.t1Hit) { pos.t1Hit = true; log(state, `LIVE ${pos.ticker} T1 hit @ ₹${ltp}`); }
    if (ltp >= pos.t2) {
      try {
        const r = await exitLivePosition(api, pos, 'T2', pos.t2);
        if (r.ok) {
          log(state, `LIVE ${pos.ticker} closed T2 @ ₹${r.exit} — net ₹${inr(pos.netPnl)}`);
          liveChanged = true;
        } else {
          log(state, `LIVE ${pos.ticker} T2 exit skipped: ${r.reason}`);
        }
      } catch (e) {
        log(state, `LIVE ${pos.ticker} T2 exit FAILED: ${e.message || e} — position still open`);
      }
    } else if (ltp <= pos.sl && !pos.slmOrderId) {
      // No broker stop exists (SL-M placement failed) — the loop is the
      // only stop, so sell at market now.
      try {
        const r = await exitLivePosition(api, pos, 'SL', pos.sl);
        if (r.ok) {
          log(state, `LIVE ${pos.ticker} closed SL @ ₹${r.exit} — net ₹${inr(pos.netPnl)} (no SL-M existed)`);
          liveChanged = true;
        } else {
          log(state, `LIVE ${pos.ticker} SL exit skipped: ${r.reason}`);
        }
      } catch (e) {
        log(state, `LIVE ${pos.ticker} SL exit FAILED: ${e.message || e} — position still open`);
      }
    }
  }
  if (paperChanged) savePaperTrades(loadPaperTrades().map((t) => {
    const open = state.positions.paper.find((p) => p.id === t.id);
    return open || t;
  }));
  if (liveChanged) saveLiveTrades(loadLiveTrades().map((t) => {
    const open = state.positions.live.find((p) => p.id === t.id);
    return open || t;
  }));
}

// Square off every open position (15:15, or when the loop stops).
async function squareOffAll(state, api, nowMs) {
  let liveChanged = false;
  for (const pos of state.positions.live) {
    if (pos.status !== 'OPEN') continue;
    try {
      const r = await exitLivePosition(api, pos, '15:15', Number.isFinite(pos.liveLtp) ? pos.liveLtp : pos.entry);
      if (r.ok) {
        log(state, `LIVE ${pos.ticker} squared off @ ₹${r.exit} — net ₹${inr(pos.netPnl)}`);
        liveChanged = true;
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
  }
  if (liveChanged) saveLiveTrades(loadLiveTrades().map((t) => {
    const cur = state.positions.live.find((p) => p.id === t.id);
    return cur || t;
  }));
  if (paperChanged) savePaperTrades(loadPaperTrades().map((t) => {
    const cur = state.positions.paper.find((p) => p.id === t.id);
    return cur || t;
  }));
}

// One watch tick. Returns 'done' when the market day is over.
async function tick(state, api, nowMs) {
  const p = istParts(nowMs);
  const mins = p.hour * 60 + p.minute;
  if (mins >= CLOSE_MIN) return 'done';
  const today = istDateKey(nowMs);

  try {
    state.indexLtps = await api.getLtps(['NSE_INDEX|Nifty 50', 'NSE_INDEX|Nifty Bank']);
  } catch (_) { /* header keeps the last levels */ }

  let suggestions = [];
  try {
    suggestions = await suggestAll(api, undefined, { budget: state.remaining });
  } catch (e) {
    log(state, `suggestions failed: ${e.message || e}`);
  }
  for (const s of suggestions) {
    const prevBar = state.lastBar[s.id];
    state.lastBar[s.id] = s.asOf;
    state.lastCards[s.id] = s;
    if (s.asOf === prevBar) continue; // same 5m bar — nothing new to act on
    log(state, `${s.id}: ${s.status === 'trade' ? `TRADE ${s.card.ticker} ${s.score.score}/100` : s.status === 'no-trade' ? 'no setup' : s.status} (new 5m bar ${s.asOf})`);
    if (s.status !== 'trade') continue;
    if (mins >= SQUARE_OFF_MIN) continue; // past square-off, no new entries
    if (state.tradedToday.has(`${s.card.ticker}|${s.card.expiry}`)) continue;
    if (state.positions.live.concat(state.positions.paper).some((pos) => pos.status === 'OPEN' && pos.ticker === s.card.ticker && pos.expiry === s.card.expiry)) continue;
    await enterTrade(state, api, s, nowMs);
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

async function main() {
  const once = process.argv.includes('--once');
  let creds = upstoxCredentials();
  let api = new UpstoxApi(creds.accessToken);
  let check = await api.checkToken();

  if (!check.ok && check.reason !== 'error') {
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
  if (funds) {
    const total = funds.available + funds.used;
    console.log(`Upstox funds — available ₹${inr(funds.available)} · used ₹${inr(funds.used)} · total ₹${inr(total)}`);
  } else {
    console.log('Upstox funds — unavailable');
  }
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

  const live = await askYesNo('Do you want Live trading?');
  const mode = live ? 'LIVE' : 'PAPER';
  const budget = await askBudget(funds ? funds.available : null);
  if (budget != null) console.log(`Trading budget for today: ₹${inr(budget)}`);
  console.log(live
    ? 'LIVE mode — the loop will place real market orders (BUY + SL-M) when a setup appears, within your budget.'
    : 'Paper trading only — no live orders placed. Run `npm run paper` to see how they did.');

  const today = istDateKey(nowMs);
  const state = {
    mode,
    budget,
    remaining: budget,
    spent: 0,
    funds,
    indexLtps,
    positions: {
      live: loadLiveTrades().filter((t) => t.status === 'OPEN' && t.date === today),
      paper: loadPaperTrades().filter((t) => t.status === 'OPEN' && t.date === today),
    },
    tradedToday: new Set(),
    lastBar: {},
    lastCards: {},
    log: [],
    printedLog: 0,
  };
  for (const t of [...state.positions.live, ...state.positions.paper]) {
    state.tradedToday.add(`${t.ticker}|${t.expiry}`);
    state.spent = +(state.spent + (Number(t.totalCost) || 0)).toFixed(2);
    if (state.remaining != null) state.remaining = Math.max(0, +(state.remaining - (Number(t.totalCost) || 0)).toFixed(2));
  }
  if (state.positions.live.length || state.positions.paper.length) {
    log(state, `Resumed ${state.positions.live.length} live + ${state.positions.paper.length} paper open position(s) from today.`);
  }

  if (once) {
    await tick(state, api, Date.now());
    console.log(daySummary(state));
    return;
  }

  console.log(`Watching the market (${mode}) — every ${POLL_MS / 1000}s. Ctrl+C stops and squares off.`);
  let stop = false;
  let timer = null;
  const stopLoop = () => { stop = true; if (timer) clearTimeout(timer); };
  process.on('SIGINT', stopLoop);
  process.on('SIGTERM', stopLoop);
  while (!stop) {
    const done = await tick(state, api, Date.now());
    if (done === 'done' || stop) break;
    await new Promise((r) => { timer = setTimeout(r, POLL_MS); });
  }
  if (stop) log(state, 'Stopping — squaring off all open positions.');
  await squareOffAll(state, api, Date.now());
  render(state, Date.now());
  console.log(daySummary(state));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exitCode = 1;
  });
}

module.exports = { tick, enterTrade, monitorPositions, squareOffAll, marketOpen, render, daySummary };
