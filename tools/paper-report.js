'use strict';

// `npm run paper` — reconcile the V3 paper-trade ledger
// (paper/v3-paper-trades.jsonl) against live option prices:
//   - for each OPEN trade, fetch the option's 5m candles for today and
//     close it at SL / trailing stop (low touched the stop) or T2 (high
//     touched the target), in time order; T1 is noted, not an exit
//     (same as muhurat2).
//   - expired contracts (expiry before today) are marked EXPIRED.
//   - P&L is NET of the full options charge stack (see src/charges.js).
// Without a live token it still prints the ledger, minus live prices.
// Side by side with the loop: the loop owns all writes. When it is
// running, this report only shows live prices and changes nothing —
// reconciling here would fight the loop's in-memory positions, and the
// loop's next save would silently undo the report's closes.
const fs = require('fs');
const path = require('path');

const { upstoxCredentials } = require('../src/upstox-auth');
const { UpstoxApi } = require('../src/upstox-api');
const { loadPaperTrades, savePaperTrades, closePaperTrade } = require('../src/paper');
const { optionsNetPnl } = require('../src/charges');
const { trailStop, effectiveSl } = require('../src/trail');
const { istDateKey } = require('../src/time');
const { writeDailyRecord } = require('../src/daily');

function inr(n) {
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const LOCK_FILE = path.join(__dirname, '..', 'v3-loop.lock');

// The pid of the V3 loop currently running on this machine, or null.
// Same rule as the loop's own lock (see lockPidIsLoop / acquireLock in
// tools/start.js): the pid must be alive AND its cmdline must really be
// a V3 loop — a stale pid, or one reused by another program, does not
// count. Kept inline so this report never depends on the loop's modules.
function loopRunning() {
  let pid = null;
  try { pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10); } catch (_) { return null; }
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); } catch (_) { return null; }
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    if (!cmd.includes('tools/start.js')) return null;
  } catch (_) { /* no /proc — the alive check is all there is */ }
  return pid;
}

async function main(apiOverride = null) {
  const trades = loadPaperTrades();
  if (!trades.length) {
    console.log('No paper trades yet. Run `npm run start` first.');
    return;
  }

  const loopPid = loopRunning();
  if (loopPid) console.log(`V3 loop is running (pid ${loopPid}) — showing the ledger as-is; the loop owns all closes. Re-run after the loop stops to reconcile.`);

  let api = apiOverride;
  if (!api) {
    try {
      const creds = upstoxCredentials();
      const candidate = new UpstoxApi(creds.accessToken);
      const check = await candidate.checkToken();
      if (check.ok) api = candidate;
    } catch (_) { /* no live data — ledger still prints */ }
  }

  const today = istDateKey(Date.now());
  let changed = false;
  for (const t of trades) {
    if (t.status !== 'OPEN') continue;
    if (!loopPid && t.expiry < today) {
      t.status = 'EXPIRED';
      t.exitReason = 'expiry passed — settlement not tracked';
      changed = true;
      continue;
    }
    if (!api) continue;
    let bars = [];
    try { bars = await api.getCandlesWindow(t.instrumentKey, 5); } catch (_) { bars = []; }
    const todayBars = bars.filter((b) => istDateKey(b.t) === today);
    if (loopPid) {
      // Display only: live price + T1 note, no closes, no saves.
      const last = todayBars[todayBars.length - 1];
      t.liveLtp = last ? last.close : null;
      t.t1Hit = todayBars.some((b) => b.high >= t.t1);
      continue;
    }
    let closed = false;
    let peak = t.peak != null ? t.peak : t.entry;
    for (const b of todayBars) {
      // The bar's low can only trigger the trail that existed when the
      // bar opened; the bar's high raises the peak (and the trail) after.
      const stop = trailStop(t.entry, t.sl, peak);
      if (b.low <= stop) { closePaperTrade(t, stop, stop > t.sl ? 'TRAIL' : 'SL', b.t); closed = true; break; }
      if (b.high >= t.t2) { closePaperTrade(t, t.t2, 'T2', b.t); closed = true; break; }
      if (b.high > peak) peak = b.high;
    }
    if (!closed && peak !== (t.peak != null ? t.peak : t.entry)) { t.peak = peak; changed = true; }
    if (closed) { changed = true; continue; }
    const last = todayBars[todayBars.length - 1];
    t.liveLtp = last ? last.close : null;
    t.t1Hit = todayBars.some((b) => b.high >= t.t1);
  }
  if (changed) {
    savePaperTrades(trades);
    // Refresh the stored daily record for every day touched, so the
    // daily files agree with the ledger even for closes done here.
    for (const d of [...new Set(trades.map((t) => t.date))]) {
      try {
        writeDailyRecord(d);
        console.log(`Daily record updated: daily/${d}.json`);
      } catch (e) {
        console.log(`Daily record write failed for ${d}: ${e.message || e}`);
      }
    }
  }

  const open = trades.filter((t) => t.status === 'OPEN');
  const closed = trades.filter((t) => t.status === 'CLOSED');
  const expired = trades.filter((t) => t.status === 'EXPIRED');
  const netClosed = closed.reduce((a, t) => a + (Number(t.netPnl) || 0), 0);
  console.log(`Paper trades — ${open.length} open · ${closed.length} closed · ${expired.length} expired · closed net ₹${inr(netClosed)}`);
  if (!api) console.log('(no live token — live prices unavailable; run `npm run start` after login)');

  for (const t of open) {
    const effSl = effectiveSl(t);
    let line = `OPEN  ${t.date} ${t.ticker} (exp ${t.expiry}) — ${t.lots} lot${t.lots > 1 ? 's' : ''}, entry ₹${t.entry}, SL ₹${effSl}${effSl > t.sl ? ' (trail)' : ''}, T1 ₹${t.t1}, T2 ₹${t.t2}`;
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

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exitCode = 1;
  });
}

module.exports = { main, loopRunning };
