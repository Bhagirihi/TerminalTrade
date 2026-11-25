'use strict';

// Paper-trade ledger for V3 `npm run start` — append-only JSONL, one trade
// per line, local state only (gitignored, never pushed). A paper trade is
// the suggestion recorded as if taken: entry at the live premium, SL/T1/T2
// from the card, sized in whole lots inside the day's budget. `npm run
// paper` reconciles OPEN trades against live option candles and marks
// exits. No live orders are ever placed from this file.
const fs = require('fs');
const path = require('path');

const PAPER_DIR = path.join(__dirname, '..', 'paper');
const LEDGER_FILE = path.join(PAPER_DIR, 'v3-paper-trades.jsonl');

function loadPaperTrades() {
  let raw = '';
  try { raw = fs.readFileSync(LEDGER_FILE, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* skip a bad line */ }
  }
  return out;
}

function savePaperTrades(trades) {
  fs.mkdirSync(PAPER_DIR, { recursive: true });
  const text = trades.map((t) => JSON.stringify(t)).join('\n') + (trades.length ? '\n' : '');
  fs.writeFileSync(LEDGER_FILE, text);
}

function recordPaperTrade(trade) {
  fs.mkdirSync(PAPER_DIR, { recursive: true });
  fs.appendFileSync(LEDGER_FILE, JSON.stringify(trade) + '\n');
  return trade;
}

// Close an open paper trade at a price, net of the options charge stack.
function closePaperTrade(t, exitPx, reason, atMs) {
  const { optionsNetPnl } = require('./charges');
  const { gross, charges, net } = optionsNetPnl(t.qty, t.entry, exitPx);
  t.status = 'CLOSED';
  t.exit = exitPx;
  t.exitReason = reason;
  t.exitAt = new Date(atMs).toISOString();
  t.grossPnl = gross;
  t.charges = charges;
  t.netPnl = net;
}

// One open paper position per contract per day — a second `npm run start`
// suggesting the same contract does not double-record it.
function hasOpenTradeFor(trades, ticker, expiry, date) {
  return trades.some(
    (t) => t.status === 'OPEN' && t.ticker === ticker && t.expiry === expiry && t.date === date
  );
}

module.exports = { LEDGER_FILE, loadPaperTrades, savePaperTrades, recordPaperTrade, hasOpenTradeFor, closePaperTrade };
