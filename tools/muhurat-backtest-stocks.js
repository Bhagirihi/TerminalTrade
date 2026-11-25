'use strict';

// 1-year backtest of the muhurat STOCKS lane (equities, fixed 33 names).
//   node tools/muhurat-backtest-stocks.js                 # last 1 year, to yesterday
//   node tools/muhurat-backtest-stocks.js --years 2
//   node tools/muhurat-backtest-stocks.js --from 2025-11-24 --to 2026-11-23 --budget 15000
//   node tools/muhurat-backtest-stocks.js --no-fetch      # cache only
//   node tools/muhurat-backtest-stocks.js --prefetch --from 2022-11-19 --to 2026-11-23
//     # download + cache all candles for the range, no replay (warm the cache
//     # right after login; later runs then fetch nothing)
// Needs UPSTOX_ACCESS_TOKEN in .env unless --no-fetch and the cache is complete.
// Data is cached under cache/muhurat-backtest/ (daily per symbol, 1m per
// symbol-month); re-runs only fetch what is missing.
// Writes cache/muhurat-backtest/days/<date>.json (live-ledger shape) and
// cache/muhurat-backtest/report-<from>_<to>.json, and prints the summary.
//
// Fidelity notes (also in src/muhurat-backtest.js): fixed 33 only (no NSE
// gainers — live-only endpoint), daily screen from bars before day D, sizing
// on the lane budget only (neutralises the live C1 bug — live will be worse
// until C1 is fixed), loss gate disabled, fills at bar close / exits at the
// crossed level, costs = published Upstox intraday stack.

const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');
const { UpstoxProvider } = require('../src/data/upstox');
const { istDateKey } = require('../src/time');
const {
  UNIVERSE,
  buildSymbolDay,
  replayDay,
  summarizeDays,
  dayDoc,
} = require('../src/muhurat-backtest');

const CACHE = process.env.MUHURAT_BACKTEST_CACHE || path.join(__dirname, '..', 'cache', 'muhurat-backtest');
const DAYS_DIR = path.join(CACHE, 'days');
const WARMUP_DAYS = 120; // live fetches today-120d of daily bars
const BUDGET_DEFAULT = 15000; // shipped .env.example MUHURAT_BUDGET_STOCK

function parseArgs(argv) {
  const out = { years: 1, budget: BUDGET_DEFAULT, confirmSec: 60, maxTrades: 5, noFetch: false, symbols: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[i + 1];
    if (a === '--from') out.from = next();
    else if (a === '--to') out.to = next();
    else if (a === '--years') out.years = Math.max(1, Number(next()) || 1);
    else if (a === '--budget') out.budget = Number(next()) || BUDGET_DEFAULT;
    else if (a === '--confirm-sec') out.confirmSec = Number(next());
    else if (a === '--max-trades') out.maxTrades = Number(next());
    else if (a === '--no-fetch') out.noFetch = true;
    else if (a === '--symbols') out.symbols = next().split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--prefetch') out.prefetch = true;
  }
  return out;
}

function shiftDays(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function shiftMonths(dateKey, months) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function monthChunks(fromKey, toKey) {
  const out = [];
  let cursor = `${fromKey.slice(0, 8)}01`;
  while (cursor <= toKey) {
    const end = shiftDays(shiftMonths(cursor, 1), -1);
    out.push({ from: cursor, to: end < toKey ? end : toKey });
    cursor = shiftMonths(cursor, 1).slice(0, 8) + '01';
  }
  return out;
}

function readCache(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeCache(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

async function fetchDaily(provider, symbol, from, to, noFetch) {
  const file = path.join(CACHE, `daily_${symbol.ticker}_${from}_${to}.json`);
  const hit = readCache(file);
  if (hit) return { bars: hit, hit: true };
  if (noFetch) throw new Error(`missing cache (daily ${symbol.ticker}) — run without --no-fetch`);
  const bars = await provider.getDailyCandles(symbol.key, from, to);
  writeCache(file, bars);
  return { bars, hit: false };
}

async function fetchMinuteMonth(provider, symbol, ym, noFetch) {
  // Cache whole months (1st → month end) so a later run with a different
  // partial range in the same month still hits a complete cache.
  const monthEnd = shiftDays(shiftMonths(`${ym}-01`, 1), -1);
  const file = path.join(CACHE, `minute1_${symbol.ticker}_${ym}.json`);
  const hit = readCache(file);
  if (hit) return { bars: hit, hit: true };
  if (noFetch) throw new Error(`missing cache (1m ${symbol.ticker} ${ym}) — run without --no-fetch`);
  const bars = await provider.getMinuteCandles(symbol.key, `${ym}-01`, monthEnd, 1, { isToday: monthEnd === istDateKey(Date.now()) });
  writeCache(file, bars);
  return { bars, hit: false };
}

/**
 * Prefetch all data a stocks backtest needs for [from, to]: daily bars
 * (120d warmup + range) and 1m bars, month-chunked, per symbol — cache-first.
 * Returns { from, to, dailyByTicker, minuteByTickerMonth, tradingDays,
 * fetched: { daily, minuteMonths }, cacheHits: { daily, minuteMonths } }.
 * The replay never fetches: runStocksBacktest calls this first, then replays
 * purely from what it returned. `providerOverride` is for tests (a stub
 * provider); otherwise the provider is built from UPSTOX_ACCESS_TOKEN.
 */
async function fetchStocksData(args, log = console.log, providerOverride = null) {
  const today = istDateKey(Date.now());
  const to = args.to || shiftDays(today, -1);
  const from = args.from || shiftMonths(to, -args.years * 12);
  const warmFrom = shiftDays(from, -WARMUP_DAYS);
  const symbols = args.symbols
    ? UNIVERSE.filter((s) => args.symbols.includes(s.ticker))
    : UNIVERSE;
  if (!symbols.length) throw new Error('No symbols matched --symbols');

  let provider = providerOverride;
  if (!provider) {
    if (args.noFetch) provider = null;
    else if (!config.upstox.accessToken) {
      throw new Error('Set UPSTOX_ACCESS_TOKEN in .env (run npm run login first), or use --no-fetch with a warm cache.');
    } else provider = new UpstoxProvider(config.upstox.accessToken);
  }

  const fetched = { daily: 0, minuteMonths: 0 };
  const cacheHits = { daily: 0, minuteMonths: 0 };
  const dailyByTicker = new Map();
  for (const sym of symbols) {
    process.stdout.write(`  daily ${sym.ticker}…\r`);
    const { bars, hit } = await fetchDaily(provider, sym, warmFrom, to, args.noFetch);
    if (hit) cacheHits.daily += 1; else fetched.daily += 1;
    dailyByTicker.set(sym.ticker, bars);
  }
  process.stdout.write('\n');

  const sbin = dailyByTicker.get('SBIN') || [...dailyByTicker.values()][0] || [];
  const tradingDays = [...new Set(sbin.map((b) => istDateKey(b.t)))].filter((d) => d >= from && d <= to).sort();
  log(`Trading days in range: ${tradingDays.length}`);

  const chunks = monthChunks(from, to);
  const minuteByTickerMonth = new Map();
  for (const sym of symbols) {
    for (const c of chunks) {
      process.stdout.write(`  1m ${sym.ticker} ${c.from.slice(0, 7)}…\r`);
      const { bars, hit } = await fetchMinuteMonth(provider, sym, c.from.slice(0, 7), args.noFetch);
      if (hit) cacheHits.minuteMonths += 1; else fetched.minuteMonths += 1;
      if (!minuteByTickerMonth.has(sym.ticker)) minuteByTickerMonth.set(sym.ticker, []);
      minuteByTickerMonth.get(sym.ticker).push(...bars);
    }
  }
  process.stdout.write('\n');
  for (const arr of minuteByTickerMonth.values()) arr.sort((a, b) => a.t - b.t);
  return { from, to, dailyByTicker, minuteByTickerMonth, tradingDays, fetched, cacheHits };
}

/**
 * Reusable stocks-lane backtest. Returns { from, to, dayResults, summary,
 * reportPath }. Throws (does not exit) when the token is missing or the
 * cache is incomplete under --no-fetch, so a caller (e.g. the terminal
 * report) can catch it and still show the live part. `log` receives the
 * progress lines; pass a no-op to silence them.
 */
async function runStocksBacktest(args, log = console.log) {
  const { from, to, dailyByTicker, minuteByTickerMonth, tradingDays } = await fetchStocksData(args, log);

  log(`Muhurat stocks backtest — ${from} → ${to} (${dailyByTicker.size} names, budget ₹${args.budget}, confirm ${args.confirmSec}s, max ${args.maxTrades}/day)`);
  log('Universe: fixed 33 only (NSE gainers excluded — live-only endpoint, no archive).');
  log('Sizing: lane budget only (C1 neutralised — see header). Loss gate: disabled.');

  // --- Replay day by day (purely from the prefetched data above).
  const dayResults = [];
  for (const date of tradingDays) {
    const symbolDays = new Map();
    const minuteBars = new Map();
    for (const [ticker, daily] of dailyByTicker) {
      const sym = UNIVERSE.find((s) => s.ticker === ticker);
      const sd = buildSymbolDay(sym, daily.filter((b) => istDateKey(b.t) < date).slice(-WARMUP_DAYS));
      if (sd) symbolDays.set(ticker, sd);
      const mins = (minuteByTickerMonth.get(ticker) || []).filter((b) => istDateKey(b.t) === date);
      if (mins.length) minuteBars.set(ticker, mins);
    }
    const result = replayDay(date, symbolDays, minuteBars, {
      budget: args.budget,
      confirmSec: args.confirmSec,
      maxTrades: args.maxTrades,
    });
    dayResults.push(result);
    fs.mkdirSync(DAYS_DIR, { recursive: true });
    fs.writeFileSync(path.join(DAYS_DIR, `${date}.json`), JSON.stringify(dayDoc(result), null, 2));
    if (result.skipped) {
      log(`  ${date}  skipped (${result.skipped})`);
    } else {
      log(`  ${date}  trades ${result.tradeCount}  net ${result.netPnl >= 0 ? '+' : ''}₹${result.netPnl.toLocaleString('en-IN')}`);
    }
  }

  const summary = summarizeDays(dayResults);
  const report = {
    generatedAt: new Date().toISOString(),
    from,
    to,
    budget: args.budget,
    confirmSec: args.confirmSec,
    maxTrades: args.maxTrades,
    universe: { fixed: [...dailyByTicker.keys()], gainers: 'excluded — live-only NSE endpoint, no archive' },
    assumptions: [
      'Fixed 33 names only (CORE 5 + EXTRA 28); NSE top-gainers leg excluded.',
      'Daily screen from bars strictly before day D (last full close D-1).',
      'Sizing on lane budget only (availableMargin = 0) — neutralises the live C1 bug; live will be worse until C1 is fixed.',
      'Loss gate disabled (live gate is whole-account holdings P&L, unreproducible).',
      'Entries at 1m bar close; exits at the crossed level price; SL before T2 in a bar.',
      'Trail +2.5% arm (30s hold), lock +1.5%, +1% steps; peak from bar highs.',
      'T1 signal-only, never exited on. One trade per ticker per day; 15:15 square-off.',
      'Costs: Upstox intraday stack — brokerage min(0.1%, Rs 20)/order, STT 0.025% sell, NSE 0.00307%, SEBI Rs 10/crore, stamp 0.003% buy, GST 18% on brokerage+txn+SEBI.',
    ],
    summary,
    days: dayResults.map((d) => ({
      date: d.date,
      trades: d.tradeCount || 0,
      wins: d.wins || 0,
      losses: d.losses || 0,
      grossPnl: d.grossPnl || 0,
      charges: d.charges || 0,
      netPnl: d.netPnl || 0,
      skips: d.skips || {},
    })),
  };
  const outPath = path.join(CACHE, `report-${from}_${to}.json`);
  writeCache(outPath, report);
  return { from, to, dayResults, summary, reportPath: outPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.prefetch) {
    let prefetched;
    try {
      prefetched = await fetchStocksData(args, console.log);
    } catch (err) {
      console.error(`Prefetch failed: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    const { from, to, tradingDays, fetched, cacheHits } = prefetched;
    console.log(`\nPrefetched ${from} → ${to}: ${tradingDays.length} trading days.`);
    console.log(`  Fetched: ${fetched.daily} daily series, ${fetched.minuteMonths} symbol-months of 1m bars.`);
    console.log(`  Cache hits: ${cacheHits.daily} daily series, ${cacheHits.minuteMonths} symbol-months.`);
    console.log('Cache: cache/muhurat-backtest/ — later runs only fetch what is missing.');
    return;
  }
  const { from, to, summary, reportPath } = await runStocksBacktest(args);
  console.log('\n=== Muhurat stocks lane — 1-year backtest ===');
  console.log(`Period: ${from} → ${to}  ·  Days: ${summary.days}  ·  Trades: ${summary.trades}`);
  console.log(`Win rate: ${summary.winRate == null ? '—' : `${summary.winRate}%`}  ·  Wins ${summary.wins} / Losses ${summary.losses} / Flat ${summary.flats}`);
  console.log(`Avg win (net): ${summary.avgWinNet == null ? '—' : `₹${summary.avgWinNet.toLocaleString('en-IN')}`}  ·  Avg loss (net): ${summary.avgLossNet == null ? '—' : `₹${summary.avgLossNet.toLocaleString('en-IN')}`}  ·  R:R (net): ${summary.riskRewardNet == null ? '—' : summary.riskRewardNet}`);
  console.log(`Profit factor: gross ${summary.profitFactorGross == null ? '—' : summary.profitFactorGross}  ·  net ${summary.profitFactorNet == null ? '—' : summary.profitFactorNet}`);
  console.log(`Gross P&L: ₹${summary.grossPnl.toLocaleString('en-IN')}  ·  Charges: ₹${summary.charges.toLocaleString('en-IN')}  ·  Net P&L: ₹${summary.netPnl.toLocaleString('en-IN')}`);
  console.log(`Expectancy/trade (net): ${summary.expectancyNet == null ? '—' : `₹${summary.expectancyNet.toLocaleString('en-IN')}`}  ·  Max drawdown: ₹${summary.maxDrawdown.toLocaleString('en-IN')}`);
  console.log(`Best day: ${summary.bestDay ? `${summary.bestDay.date} ₹${summary.bestDay.netPnl.toLocaleString('en-IN')}` : '—'}  ·  Worst day: ${summary.worstDay ? `${summary.worstDay.date} ₹${summary.worstDay.netPnl.toLocaleString('en-IN')}` : '—'}`);
  console.log(`Trades/day: ${summary.tradesPerDay}`);
  console.log(`\nSaved ${reportPath}`);
  console.log('Day ledgers (live-ledger shape): cache/muhurat-backtest/days/<date>.json');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { runStocksBacktest, fetchStocksData, parseArgs, shiftDays, shiftMonths, monthChunks };
