'use strict';

// Win rate + P&L ratio (profit factor) from the LIVE muhurat ledger —
// paper/muhurat-history/days/<YYYY-MM-DD>.json on the server.
//   node tools/muhurat-history-stats.js
//   node tools/muhurat-history-stats.js --from 2026-11-17 --to 2026-11-25
//   node tools/muhurat-history-stats.js --dir paper/muhurat-history/days
//
// Definitions (printed with the numbers, so they can't be misread):
// - Win rate = closed trades with NET P&L > 0 / all closed trades. Net =
//   ledger P&L minus the Upstox charge stack (intraday equity / options).
// - Profit factor = total gross profit of winners / total gross loss of
//   losers. Above 1.0 means the winners paid for the losers.
// - P&L ratio (avg win / avg loss) = average net win / average net loss.
// The ledger's own `pnl` is GROSS of charges — never quote it as profit.
//
// This reads history only. It places no orders and touches no live state.

const fs = require('fs');
const path = require('path');
const {
  intradayRoundTripCost,
  optionsRoundTripCost,
  summarizeDays,
} = require('../src/muhurat-backtest');

const DEFAULT_DIR = path.join(__dirname, '..', 'paper', 'muhurat-history', 'days');

function parseArgs(argv) {
  const out = { dir: DEFAULT_DIR, from: null, to: null, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[i + 1];
    else if (a === '--from') out.from = argv[i + 1];
    else if (a === '--to') out.to = argv[i + 1];
    else if (a === '--json') out.json = argv[i + 1];
  }
  return out;
}

function chargesFor(trade) {
  const buyValue = (Number(trade.entry) || 0) * (Number(trade.qty) || 0);
  const sellValue = (Number(trade.exit) || 0) * (Number(trade.qty) || 0);
  if (trade.mode === 'options') return optionsRoundTripCost(buyValue, sellValue);
  return intradayRoundTripCost(buyValue, sellValue);
}

/**
 * Aggregate closed-trade stats from parsed day documents (live-ledger shape).
 * Returns { days, summary, byMode, openPositions, perDay } — the summary is
 * the same shape as the backtest's summarizeDays, so live and backtest
 * numbers compare directly.
 */
function computeHistoryStats(dayDocs) {
  const days = [];
  const openPositions = [];
  for (const doc of dayDocs) {
    if (!doc || !doc.date) continue;
    const trades = [];
    for (const t of doc.trades || []) {
      if (t.status === 'OPEN') {
        openPositions.push({
          date: doc.date,
          ticker: t.ticker,
          mode: t.mode,
          qty: t.qty,
          entry: t.entry,
          spend: t.spend,
        });
        continue;
      }
      if (t.status !== 'CLOSED') continue;
      const gross = Number(t.pnl) || 0;
      const charges = chargesFor(t).total;
      trades.push({
        ticker: t.ticker,
        mode: t.mode || 'equity',
        key: t.key || null,
        qty: t.qty,
        entry: t.entry,
        exit: t.exit,
        spend: t.spend,
        pnl: gross,
        charges,
        netPnl: Math.round((gross - charges) * 100) / 100,
        exitReason: t.exitReason || null,
        status: 'CLOSED',
        buyAt: t.buyAt || null,
        sellAt: t.sellAt || null,
        right: null,
      });
    }
    const grossPnl = Math.round(trades.reduce((s, t) => s + t.pnl, 0) * 100) / 100;
    const charges = Math.round(trades.reduce((s, t) => s + t.charges, 0) * 100) / 100;
    const netPnl = Math.round(trades.reduce((s, t) => s + t.netPnl, 0) * 100) / 100;
    days.push({
      date: doc.date,
      trades,
      tradeCount: trades.length,
      wins: trades.filter((t) => t.netPnl > 0).length,
      losses: trades.filter((t) => t.netPnl < 0).length,
      grossPnl,
      charges,
      netPnl,
      investment: trades.reduce((s, t) => s + (Number(t.spend) || 0), 0),
    });
  }
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  const summary = summarizeDays(days);
  const byMode = {};
  for (const mode of ['equity', 'options']) {
    const modeDays = days.map((d) => ({
      ...d,
      trades: d.trades.filter((t) => t.mode === mode),
    }));
    byMode[mode] = summarizeDays(modeDays);
  }
  return { days, summary, byMode, openPositions };
}

function fmtRs(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return `₹${n.toLocaleString('en-IN')}`;
}

function printStats(result, { from, to }) {
  const s = result.summary;
  const range = from || to ? `${from || '…'} → ${to || '…'}` : 'all history';
  console.log(`\n=== Muhurat live history — win rate + P&L ratio (${range}) ===`);
  console.log(`Days with trades: ${s.days}  ·  Closed trades: ${s.trades}`);
  console.log(`Win rate (net of charges): ${s.winRate == null ? '—' : `${s.winRate}%`}  ·  Wins ${s.wins} / Losses ${s.losses} / Flat ${s.flats}`);
  console.log(`Profit factor: gross ${s.profitFactorGross == null ? '—' : s.profitFactorGross}  ·  net ${s.profitFactorNet == null ? '—' : s.profitFactorNet}`);
  console.log(`Avg win (net): ${fmtRs(s.avgWinNet)}  ·  Avg loss (net): ${fmtRs(s.avgLossNet)}  ·  P&L ratio (avg win / avg loss): ${s.riskRewardNet == null ? '—' : s.riskRewardNet}`);
  console.log(`Gross P&L: ${fmtRs(s.grossPnl)}  ·  Charges: ${fmtRs(s.charges)}  ·  Net P&L: ${fmtRs(s.netPnl)}`);
  console.log(`Expectancy/trade (net): ${s.expectancyNet == null ? '—' : fmtRs(s.expectancyNet)}  ·  Max drawdown (daily net): ${fmtRs(s.maxDrawdown)}`);
  for (const mode of ['equity', 'options']) {
    const m = result.byMode[mode];
    console.log(`  ${mode}: ${m.trades} trades, win rate ${m.winRate == null ? '—' : `${m.winRate}%`}, PF net ${m.profitFactorNet == null ? '—' : m.profitFactorNet}, net ${fmtRs(m.netPnl)}`);
  }
  console.log('\nPer day (net):');
  for (const d of result.days) {
    if (!d.tradeCount && d.netPnl === 0) continue;
    console.log(`  ${d.date}  trades ${d.tradeCount}  W${d.wins}/L${d.losses}  net ${d.netPnl >= 0 ? '+' : ''}${fmtRs(d.netPnl)}  charges ${fmtRs(d.charges)}`);
  }
  if (result.openPositions.length) {
    console.log('\nStill open (not counted in win rate — no exit yet):');
    for (const p of result.openPositions) {
      console.log(`  ${p.date}  ${p.ticker} (${p.mode}) x${p.qty} @ ${fmtRs(p.entry)}  invested ${fmtRs(p.spend)}`);
    }
  }
  console.log('\nLedger pnl is gross of charges; win rate and P&L ratio above are net.');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.dir)) {
    console.error(`No history dir: ${args.dir}`);
    process.exit(1);
  }
  const files = fs.readdirSync(args.dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  const docs = [];
  for (const f of files) {
    const date = f.slice(0, 10);
    if (args.from && date < args.from) continue;
    if (args.to && date > args.to) continue;
    try {
      // The dashboard serves day files wrapped as { ok, day } — unwrap them.
      const parsed = JSON.parse(fs.readFileSync(path.join(args.dir, f), 'utf8'));
      docs.push(parsed.day || parsed);
    } catch (e) {
      console.error(`Skipping unreadable ${f}: ${e.message}`);
    }
  }
  if (!docs.length) {
    console.log('No history days in range.');
    return;
  }
  const result = computeHistoryStats(docs);
  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify(result, null, 2));
    console.log(`Wrote ${args.json}`);
  }
  printStats(result, args);
}

if (require.main === module) main();

module.exports = { computeHistoryStats, chargesFor, parseArgs };
