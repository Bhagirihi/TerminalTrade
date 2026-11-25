'use strict';

// `npm run paper` — reconcile the V3 paper-trade ledger
// (paper/v3-paper-trades.jsonl) against live option prices:
//   - for each OPEN trade, fetch the option's 5m candles for today and
//     close it at SL (low touched the stop) or T2 (high touched the target),
//     in time order; T1 is noted, not an exit (same as muhurat2).
//   - expired contracts (expiry before today) are marked EXPIRED.
//   - P&L is NET of the full options charge stack (see src/charges.js).
// Without a live token it still prints the ledger, minus live prices.

const { upstoxCredentials } = require('../src/upstox-auth');
const { UpstoxApi } = require('../src/upstox-api');
const { loadPaperTrades, savePaperTrades } = require('../src/paper');
const { optionsNetPnl } = require('../src/charges');
const { istDateKey } = require('../src/time');

function inr(n) {
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function closeTrade(t, exitPx, reason, atMs) {
  const { gross, charges, net } = optionsNetPnl(t.qty, t.entry, exitPx);
  t.status = 'CLOSED';
  t.exit = exitPx;
  t.exitReason = reason;
  t.exitAt = new Date(atMs).toISOString();
  t.grossPnl = gross;
  t.charges = charges;
  t.netPnl = net;
}

async function main() {
  const trades = loadPaperTrades();
  if (!trades.length) {
    console.log('No paper trades yet. Run `npm run start` first.');
    return;
  }

  let api = null;
  try {
    const creds = upstoxCredentials();
    const candidate = new UpstoxApi(creds.accessToken);
    const check = await candidate.checkToken();
    if (check.ok) api = candidate;
  } catch (_) { /* no live data — ledger still prints */ }

  const today = istDateKey(Date.now());
  let changed = false;
  for (const t of trades) {
    if (t.status !== 'OPEN') continue;
    if (t.expiry < today) {
      t.status = 'EXPIRED';
      t.exitReason = 'expiry passed — settlement not tracked';
      changed = true;
      continue;
    }
    if (!api) continue;
    let bars = [];
    try { bars = await api.getCandlesWindow(t.instrumentKey, 5); } catch (_) { bars = []; }
    const todayBars = bars.filter((b) => istDateKey(b.t) === today);
    let closed = false;
    for (const b of todayBars) {
      if (b.low <= t.sl) { closeTrade(t, t.sl, 'SL', b.t); closed = true; break; }
      if (b.high >= t.t2) { closeTrade(t, t.t2, 'T2', b.t); closed = true; break; }
    }
    if (closed) { changed = true; continue; }
    const last = todayBars[todayBars.length - 1];
    t.liveLtp = last ? last.close : null;
    t.t1Hit = todayBars.some((b) => b.high >= t.t1);
  }
  if (changed) savePaperTrades(trades);

  const open = trades.filter((t) => t.status === 'OPEN');
  const closed = trades.filter((t) => t.status === 'CLOSED');
  const expired = trades.filter((t) => t.status === 'EXPIRED');
  const netClosed = closed.reduce((a, t) => a + (Number(t.netPnl) || 0), 0);
  console.log(`Paper trades — ${open.length} open · ${closed.length} closed · ${expired.length} expired · closed net ₹${inr(netClosed)}`);
  if (!api) console.log('(no live token — live prices unavailable; run `npm run start` after login)');

  for (const t of open) {
    let line = `OPEN  ${t.date} ${t.ticker} (exp ${t.expiry}) — ${t.lots} lot${t.lots > 1 ? 's' : ''}, entry ₹${t.entry}, SL ₹${t.sl}, T1 ₹${t.t1}, T2 ₹${t.t2}`;
    if (t.liveLtp != null) {
      const { gross, net } = optionsNetPnl(t.qty, t.entry, t.liveLtp);
      line += ` — live ₹${t.liveLtp}, P&L gross ₹${inr(gross)} / net ₹${inr(net)}${t.t1Hit ? ' (T1 hit)' : ''}`;
    }
    console.log(line);
  }
  for (const t of closed) {
    console.log(`DONE  ${t.date} ${t.ticker} (exp ${t.expiry}) — ${t.exitReason} @ ₹${t.exit}, entry ₹${t.entry} → net ₹${inr(t.netPnl)} (gross ₹${inr(t.grossPnl)}, charges ₹${inr(t.charges)})`);
  }
  for (const t of expired) {
    console.log(`EXP   ${t.date} ${t.ticker} (exp ${t.expiry}) — ${t.exitReason}`);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
