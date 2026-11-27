'use strict';

// Daily trade + P&L record for V3 `npm run start` — one JSON file per day
// (daily/<YYYY-MM-DD>.json), local state only (gitignored, never pushed).
// Written whenever a trade closes and once more when the loop ends, so the
// file stays current even if the process dies mid-day. Built from the paper
// + live ledgers, so it always agrees with them; the loop writes trades
// nowhere else. Each trade carries its full details (entry/exit datetimes,
// prices, qty, SL/T1/T2, exit reason, gross/charges/net) and the summary
// holds the day's realised P&L, split by paper/live.
const fs = require('fs');
const path = require('path');
const { loadPaperTrades } = require('./paper');
const { loadLiveTrades } = require('./trading');

const DAILY_DIR = path.join(__dirname, '..', 'daily');
const dailyFile = (date) => path.join(DAILY_DIR, `${date}.json`);

// Today's stored record, or null when the day has none yet (first run).
function readDailyRecord(date) {
  try { return JSON.parse(fs.readFileSync(dailyFile(date), 'utf8')); } catch (_) { return null; }
}

function summarize(trades) {
  const closed = trades.filter((t) => t.status === 'CLOSED');
  const open = trades.filter((t) => t.status === 'OPEN');
  const expired = trades.filter((t) => t.status === 'EXPIRED');
  const sum = (key) => closed.reduce((a, t) => a + (Number(t[key]) || 0), 0);
  const wins = closed.filter((t) => (Number(t.netPnl) || 0) > 0).length;
  const losses = closed.filter((t) => (Number(t.netPnl) || 0) < 0).length;
  return {
    trades: trades.length,
    closed: closed.length,
    open: open.length,
    expired: expired.length,
    gross: +sum('grossPnl').toFixed(2),
    charges: +sum('charges').toFixed(2),
    net: +sum('netPnl').toFixed(2),
    wins,
    losses,
  };
}

function buildDailyRecord(date, opts = {}) {
  const paper = loadPaperTrades()
    .filter((t) => t.date === date)
    .map((t) => ({ ...t, mode: 'PAPER' }));
  const live = loadLiveTrades()
    .filter((t) => t.date === date)
    .map((t) => ({ ...t, mode: 'LIVE' }));
  const trades = [...paper, ...live]
    .sort((a, b) => String(a.recordedAt || '').localeCompare(String(b.recordedAt || '')));
  const ps = summarize(paper);
  const ls = summarize(live);
  const total = {
    trades: ps.trades + ls.trades,
    closed: ps.closed + ls.closed,
    open: ps.open + ls.open,
    expired: ps.expired + ls.expired,
    gross: +(ps.gross + ls.gross).toFixed(2),
    charges: +(ps.charges + ls.charges).toFixed(2),
    net: +(ps.net + ls.net).toFixed(2),
    wins: ps.wins + ls.wins,
    losses: ps.losses + ls.losses,
  };
  // Keep the day's budget and mode once known (the report path has no
  // state to supply them, so it preserves whatever an earlier write stored).
  let budget = opts.budget != null ? opts.budget : null;
  let mode = opts.mode != null ? opts.mode : null;
  if (budget == null || mode == null) {
    try {
      const prev = JSON.parse(fs.readFileSync(dailyFile(date), 'utf8'));
      if (prev) {
        if (budget == null && prev.budget != null) budget = prev.budget;
        if (mode == null && prev.mode != null) mode = prev.mode;
      }
    } catch (_) { /* no earlier file — budget/mode stay null */ }
  }
  return { date, generatedAt: new Date().toISOString(), mode, budget, trades, summary: { paper: ps, live: ls, total } };
}

function writeDailyRecord(date, opts = {}) {
  const rec = buildDailyRecord(date, opts);
  fs.mkdirSync(DAILY_DIR, { recursive: true });
  fs.writeFileSync(dailyFile(date), JSON.stringify(rec, null, 2) + '\n');
  return rec;
}

module.exports = { DAILY_DIR, dailyFile, readDailyRecord, buildDailyRecord, writeDailyRecord };
