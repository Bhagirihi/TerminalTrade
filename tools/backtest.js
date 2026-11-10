'use strict';

// Backtest the Supertrend paper rules on Upstox history.
//   node tools/backtest.js              # last 5 years, NIFTY + BANKNIFTY
//   node tools/backtest.js 2            # last 2 years
// Saves JSON under cache/backtest/ and prints win rate / R:R.

const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');
const { UpstoxProvider } = require('../src/data/upstox');
const { runStrategy } = require('../src/strategy');
const { resolveCommodities } = require('../src/commodities');
const { istDateKey } = require('../src/time');

function strategyOpts(extra = {}) {
  const s = config.strategy || {};
  return {
    flipOnly: !!s.flipOnly,
    emaExit: s.emaExit !== false,
    emaExitBars: Number(s.emaExitBars) || 0,
    ...extra,
  };
}

const CACHE = path.join(__dirname, '..', 'cache', 'backtest');
const STAKE = 50000;

const INDEXES = [
  { id: 'NIFTY', name: 'NIFTY 50', upstoxKey: 'NSE_INDEX|Nifty 50', lotSize: 65 },
  { id: 'BANKNIFTY', name: 'BANKNIFTY', upstoxKey: 'NSE_INDEX|Nifty Bank', lotSize: 30 },
];

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function shiftMonths(dateKey, months) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function monthWindows(fromKey, toKey) {
  const out = [];
  let cursor = `${fromKey.slice(0, 8)}01`;
  while (cursor <= toKey) {
    const [y, m] = cursor.split('-').map(Number);
    const end = new Date(Date.UTC(y, m, 0));
    const endKey = `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, '0')}-${String(end.getUTCDate()).padStart(2, '0')}`;
    out.push({ from: cursor < fromKey ? fromKey : cursor, to: endKey > toKey ? toKey : endKey });
    const next = shiftMonths(cursor, 1);
    cursor = `${next.slice(0, 8)}01`;
  }
  return out;
}

function cacheFile(id, from, to) {
  return path.join(CACHE, `${id}_${from}_${to}_15m.json`);
}

async function fetchMonth(provider, symbol, from, to) {
  const file = cacheFile(symbol.id, from, to);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = encodeURIComponent(symbol.upstoxKey);
  const url = `https://api.upstox.com/v3/historical-candle/${key}/minutes/15/${to}/${from}`;
  const json = await provider.fetchJson(url);
  const candles = provider.parseCandles(json);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(candles));
  return candles;
}

async function loadSeries(provider, symbol, fromKey, toKey) {
  const windows = monthWindows(fromKey, toKey);
  const all = [];
  const seen = new Set();
  for (const w of windows) {
    process.stdout.write(`  ${symbol.id} ${w.from}..${w.to}   \r`);
    try {
      const rows = await fetchMonth(provider, symbol, w.from, w.to);
      for (const c of rows) {
        if (seen.has(c.t)) continue;
        seen.add(c.t);
        all.push(c);
      }
    } catch (err) {
      console.error(`\n  ${symbol.id} ${w.from}: ${err.message.slice(0, 120)}`);
    }
  }
  process.stdout.write('\n');
  all.sort((a, b) => a.t - b.t);
  return all;
}

function pairTrades(signals) {
  const trades = [];
  let open = null;
  for (const s of signals || []) {
    if (s.type === 'BUY CE' || s.type === 'BUY PE') {
      open = {
        side: s.type,
        entry: s.price,
        entryAt: `${s.dateKey} ${s.timeIST}`,
        entryT: s.t,
        reason: s.reason,
      };
      continue;
    }
    if (!open) continue;
    if (s.type !== 'EXIT CE' && s.type !== 'EXIT PE' && s.type !== 'SQOFF') continue;
    const points = s.points != null
      ? s.points
      : open.side === 'BUY CE'
        ? s.price - open.entry
        : open.entry - s.price;
    const ret = open.entry ? points / open.entry : null;
    trades.push({
      ...open,
      exit: s.price,
      exitAt: `${s.dateKey} ${s.timeIST}`,
      exitReason: s.reason,
      points: round2(points),
      returnPct: ret == null ? null : round2(ret * 100),
      stakePnl: ret == null ? null : round2(STAKE * ret),
      win: points > 0,
    });
    open = null;
  }
  return trades;
}

function summarize(trades) {
  const closed = trades.filter((t) => t.points != null);
  const wins = closed.filter((t) => t.points > 0);
  const losses = closed.filter((t) => t.points < 0);
  const flats = closed.filter((t) => t.points === 0);
  const grossWin = wins.reduce((a, t) => a + t.points, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.points, 0));
  const avgWin = wins.length ? grossWin / wins.length : null;
  const avgLoss = losses.length ? grossLoss / losses.length : null;
  return {
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    flats: flats.length,
    winRate: closed.length ? round2((wins.length / closed.length) * 100) : null,
    avgWinPts: avgWin == null ? null : round2(avgWin),
    avgLossPts: avgLoss == null ? null : round2(avgLoss),
    riskReward: avgWin != null && avgLoss ? round2(avgWin / avgLoss) : null,
    profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : grossWin > 0 ? null : null,
    totalPoints: round2(closed.reduce((a, t) => a + t.points, 0)),
    stakePnl: round2(closed.reduce((a, t) => a + (t.stakePnl || 0), 0)),
    expectancyPts: closed.length ? round2(closed.reduce((a, t) => a + t.points, 0) / closed.length) : null,
  };
}

function printReport(name, from, to, bars, stats, note) {
  console.log(`\n=== ${name} ===`);
  console.log(`Period: ${from} → ${to}`);
  console.log(`Bars: ${bars}${note ? `  (${note})` : ''}`);
  console.log(`Closed trades: ${stats.trades}   Wins: ${stats.wins}   Losses: ${stats.losses}   Flats: ${stats.flats}`);
  console.log(`Win rate (accuracy): ${stats.winRate == null ? '—' : `${stats.winRate}%`}`);
  console.log(`Avg win: ${stats.avgWinPts} pts   Avg loss: ${stats.avgLossPts} pts`);
  console.log(`Risk:Reward (avg win / avg loss): ${stats.riskReward == null ? '—' : `${stats.riskReward} : 1`}`);
  console.log(`Profit factor: ${stats.profitFactor == null ? '—' : stats.profitFactor}`);
  console.log(`Total index points: ${stats.totalPoints}   Expectancy/trade: ${stats.expectancyPts} pts`);
  console.log(`₹${STAKE.toLocaleString('en-IN')} stake P&L (percent of entry × stake): ${stats.stakePnl}`);
}

async function runSymbol(provider, symbol, fromKey, toKey, strategyOpts = {}) {
  const candles = await loadSeries(provider, symbol, fromKey, toKey);
  if (candles.length < 50) {
    return { candles, trades: [], stats: summarize([]), error: 'not enough bars' };
  }
  const run = runStrategy(candles, symbol.lotSize, strategyOpts);
  const trades = pairTrades(run.signals);
  return { candles, trades, stats: summarize(trades), open: run.position };
}

async function main() {
  const years = Math.max(1, Number(process.argv[2] || 5));
  if (!config.upstox.accessToken) {
    console.error('Set UPSTOX_ACCESS_TOKEN in .env');
    process.exit(1);
  }
  const provider = new UpstoxProvider(config.upstox.accessToken);
  const toKey = istDateKey(Date.now() - 86400000);
  const fromKey = shiftMonths(toKey, -years * 12);

  const opts = strategyOpts();
  console.log(`Backtest Supertrend (ST 10/3, EMA 13, 15m) — last ${years} year(s)`);
  console.log(`Window: ${fromKey} → ${toKey}`);
  console.log(`Rules: flipOnly=${opts.flipOnly}  emaExit=${opts.emaExit}  emaExitBars=${opts.emaExitBars}`);
  console.log('HOLD/SELL share plan is not in this run (needs your historical book, not market history).');

  const reports = [];
  const indexTrades = [];

  for (const symbol of INDEXES) {
    const result = await runSymbol(provider, symbol, fromKey, toKey, opts);
    printReport(symbol.name, fromKey, toKey, result.candles.length, result.stats);
    indexTrades.push(...result.trades.map((t) => ({ ...t, index: symbol.id })));
    reports.push({
      id: symbol.id,
      name: symbol.name,
      from: fromKey,
      to: toKey,
      bars: result.candles.length,
      stats: result.stats,
      trades: result.trades,
    });
  }

  try {
    const commodities = await resolveCommodities(Date.now());
    for (const row of commodities) {
      const symbol = { id: row.id, name: row.name, upstoxKey: row.upstoxKey, lotSize: row.lotSize };
      const fromCmd = shiftMonths(toKey, -2);
      if (!(config.paperCommodities || []).includes(row.id)) continue;
      const result = await runSymbol(provider, symbol, fromCmd, toKey, strategyOpts({
        squareOffHour: 23,
        squareOffMinute: 15,
      }));
      printReport(
        `${row.name} ${row.contract || ''}`.trim(),
        fromCmd,
        toKey,
        result.candles.length,
        result.stats,
        'front-month only — not a full 5-year continuous series'
      );
      reports.push({
        id: row.id,
        name: row.name,
        contract: row.contract,
        from: fromCmd,
        to: toKey,
        bars: result.candles.length,
        note: 'front-month only',
        stats: result.stats,
        trades: result.trades,
      });
    }
  } catch (err) {
    console.error(`Commodities skipped: ${err.message}`);
  }

  const combined = summarize(indexTrades);
  console.log('\n=== NIFTY + BANKNIFTY combined (₹50,000 stake model per trade) ===');
  console.log(`Closed trades: ${combined.trades}`);
  console.log(`Win rate (accuracy): ${combined.winRate}%`);
  console.log(`Risk:Reward: ${combined.riskReward == null ? '—' : `${combined.riskReward} : 1`}`);
  console.log(`Profit factor: ${combined.profitFactor}`);
  console.log(`Total stake P&L if every trade used ₹50,000: ${combined.stakePnl}`);
  console.log('(Live paper plan uses one shared ₹50,000 pool — first trade takes the cash, next waits.)');

  const outPath = path.join(CACHE, `report_${fromKey}_${toKey}.json`);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        from: fromKey,
        to: toKey,
        years,
        stakePerTradeModel: STAKE,
        notes: [
          'Supertrend ATR 10 / mult 3.0, EMA 13 exit, index square-off 15:10 IST.',
          'Win rate = winning closed trades / all closed trades.',
          'Risk:Reward = average winning trade points / average losing trade points.',
          'Stake P&L scales index percent move by ₹50,000 (not full lot notional).',
          'HOLD/SELL portfolio paper plan is not backtested — that needs historical holdings.',
          'Commodity rows use the current front-month contract only.',
        ],
        combinedIndex: combined,
        symbols: reports,
      },
      null,
      2
    )
  );
  console.log(`\nSaved ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
