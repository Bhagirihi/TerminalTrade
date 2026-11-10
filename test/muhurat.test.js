'use strict';

// Unit tests seat instantly — production uses MUHURAT_CONFIRM_SEC (default 180).
process.env.MUHURAT_CONFIRM_SEC = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CORE,
  levelsFromCandles,
  scoreRow,
  analyzeName,
  trailPlan,
  allocateBudget,
  sessionPhase,
  applySessionVerdict,
  applyLiveLtp,
  withTradeSignals,
  getSession,
  maxTradesPerDay,
  DEFAULT_MAX_TRADES_STOCK,
  DEFAULT_MAX_TRADES_OPTIONS,
} = require('../src/muhurat');
const { render } = require('../tools/muhurat');
const { istToEpoch } = require('../src/time');

test('core five are fixed', () => {
  assert.deepEqual(CORE.map((c) => c.ticker), ['SBIN', 'AXISBANK', 'TATASTEEL', 'HINDALCO', 'HINDUNILVR']);
});

test('levelsFromCandles returns stop below entry and targets above', () => {
  const candles = [];
  let px = 100;
  for (let i = 0; i < 30; i++) {
    px += (i % 3) - 1;
    candles.push({ open: px, high: px + 2, low: px - 2, close: px });
  }
  const last = candles[candles.length - 1].close;
  const lv = levelsFromCandles(candles, last);
  assert.ok(lv.stopLoss < last);
  assert.ok(lv.target1 > last);
  assert.ok(lv.target2 >= lv.target1);
});

test('score prefers liquid trend without overbought RSI', () => {
  const good = scoreRow({ aboveSma: true, rsi: 60, d1: 1, d5: 6, distSma: 3, atrPct: 2.2, ticker: 'SBIN' });
  const hot = scoreRow({ aboveSma: true, rsi: 82, d1: 2, d5: 12, distSma: 14, atrPct: 2.2, ticker: 'SBIN' });
  assert.ok(good.score > hot.score);
});

test('analyzeName returns a verdict and trail levels', () => {
  const candles = [];
  let px = 100;
  for (let i = 0; i < 60; i++) {
    px += 0.4;
    candles.push({ open: px - 0.5, high: px + 1, low: px - 1, close: px, t: i });
  }
  const row = analyzeName({ ticker: 'SBIN', key: 'x', core: true }, candles, candles[candles.length - 1].close);
  assert.equal(row.ticker, 'SBIN');
  assert.ok(row.levels.stopLoss < row.ltp);
  assert.ok(['BUY', 'WATCH', 'TOO HOT', 'SKIP'].includes(row.verdict));
});

test('trailPlan stock: +2.5% arms +1.5% lock (after hold), then +1% steps', () => {
  const entry = 100;
  const init = 98.5;
  const t0 = 1_000_000;
  // Below arm → initial SL
  assert.equal(trailPlan(entry, init, 102, 104, 101.5, { mode: 'equity', armHoldSec: 0 }).trailStage, 0);
  assert.equal(trailPlan(entry, init, 102, 104, 101.5, { mode: 'equity', armHoldSec: 0 }).activeStop, 98.5);
  // At +2.5% with hold satisfied → +1.5%
  const a = trailPlan(entry, init, 102, 104, 102.5, {
    mode: 'equity', armAt: t0, now: t0 + 30_000, armHoldSec: 30,
  });
  assert.equal(a.trailStage, 1);
  assert.equal(a.activeStop, 101.5);
  // Hold not finished → still initial SL
  const waiting = trailPlan(entry, init, 102, 104, 102.5, {
    mode: 'equity', armAt: t0, now: t0 + 5_000, armHoldSec: 30,
  });
  assert.equal(waiting.trailStage, 0);
  assert.equal(waiting.activeStop, 98.5);
  // +4.5% → lock +3.5%
  const b = trailPlan(entry, init, 102, 104, 104.5, { mode: 'equity', armHoldSec: 0 });
  assert.equal(b.activeStop, 103.5);
  assert.equal(b.lockPct, 3.5);
});

test('trailPlan options: +5%→cost, +10%→+10%, +17%→+15%', () => {
  const entry = 100;
  const init = 80;
  assert.equal(trailPlan(entry, init, 122, 145, 104, { mode: 'options' }).trailStage, 0);
  assert.equal(trailPlan(entry, init, 122, 145, 105, { mode: 'options' }).activeStop, 100);
  assert.equal(trailPlan(entry, init, 122, 145, 112, { mode: 'options' }).activeStop, 110);
  assert.equal(trailPlan(entry, init, 122, 145, 117, { mode: 'options' }).activeStop, 115);
  assert.equal(trailPlan(entry, init, 122, 145, 117, { mode: 'options' }).lockPct, 15);
});

test('regular schedule opens 09:15 and goes live after 09:25', () => {
  assert.equal(getSession('regular').open, '09:15');
  assert.equal(sessionPhase(istToEpoch('2026-11-10', 9, 20), 'regular').phase, 'watching_open');
  assert.equal(sessionPhase(istToEpoch('2026-11-10', 10, 0), 'regular').phase, 'live');
  assert.equal(sessionPhase(istToEpoch('2026-11-10', 15, 20), 'regular').phase, 'exit_only');
});

test('muhurat schedule still supports 14:20 special window', () => {
  assert.equal(sessionPhase(istToEpoch('2026-11-08', 13, 0), 'muhurat').phase, 'before_open');
  assert.equal(sessionPhase(istToEpoch('2026-11-08', 14, 35), 'muhurat').phase, 'live');
});

test('before open: BUY becomes PREP and budget not assigned to fixed names', () => {
  const before = istToEpoch('2026-11-10', 8, 0); // regular session opens 09:15
  const phase = sessionPhase(before, 'regular');
  assert.equal(phase.phase, 'before_open');
  assert.equal(phase.canDecideBuy, false);
  const row = applySessionVerdict({ ticker: 'SBIN', verdict: 'BUY', ltp: 1000, score: 11, reasons: [] }, phase, null);
  assert.equal(row.verdict, 'PREP');
  const plan = allocateBudget(20000, []);
  assert.equal(plan.pickCount, 0);
  assert.equal(plan.used, 0);
});

test('max trades/day: stocks 5, options 2', () => {
  const keys = [
    'MUHURAT_MAX_TRADES',
    'MUHURAT_MAX_TRADES_STOCK',
    'MUHURAT_MAX_TRADES_OPTIONS',
    'MUHURAT_MAX_NAMES',
  ];
  const prev = {};
  for (const k of keys) {
    prev[k] = process.env[k];
    delete process.env[k];
  }
  assert.equal(DEFAULT_MAX_TRADES_STOCK, 5);
  assert.equal(DEFAULT_MAX_TRADES_OPTIONS, 2);
  assert.equal(maxTradesPerDay('equity'), 5);
  assert.equal(maxTradesPerDay('options'), 2);

  const rows = [];
  for (let i = 0; i < 8; i++) {
    rows.push({
      ticker: `T${i}`,
      ltp: 100,
      verdict: 'BUY',
      score: 10,
      aboveOpen: true,
      sellT1: 110,
      sellT2: 120,
      sellStop: 90,
      levels: { target1: 110, target2: 120, stopLoss: 90 },
    });
  }
  assert.equal(allocateBudget(50000, rows, { mode: 'equity' }).pickCount, 5);
  assert.equal(allocateBudget(50000, rows, { mode: 'options' }).pickCount, 2);

  for (const k of keys) {
    if (prev[k] == null) delete process.env[k];
    else process.env[k] = prev[k];
  }
});

test('live phase: allocateBudget prefers higher profitScore names', () => {
  const plan = allocateBudget(20000, [
    {
      ticker: 'WEAK',
      ltp: 1000,
      verdict: 'BUY',
      score: 8,
      aboveOpen: true,
      sellT1: 1008,
      sellT2: 1015,
      sellStop: 990,
      levels: { target1: 1008, target2: 1015, stopLoss: 990 },
    },
    {
      ticker: 'STRONG',
      ltp: 1000,
      verdict: 'BUY',
      score: 11,
      aboveOpen: true,
      sellT1: 1015,
      sellT2: 1025,
      sellStop: 990,
      levels: { target1: 1015, target2: 1025, stopLoss: 990 },
    },
  ]);
  assert.ok(plan.byTicker.STRONG);
  assert.ok(plan.byTicker.WEAK);
  assert.ok(plan.byTicker.STRONG.qty > plan.byTicker.WEAK.qty);
  assert.ok(plan.byTicker.STRONG.profitScore > plan.byTicker.WEAK.profitScore);
  assert.ok(plan.used <= 20000);
  assert.ok(plan.expectedT1 > 0);
});

test('higher-P Watch joins Live BUY pool as BUY (P > 12)', () => {
  const plan = allocateBudget(12000, [
    {
      ticker: 'OKBUY',
      ltp: 5000,
      verdict: 'BUY',
      score: 8,
      aboveOpen: true,
      sellT1: 5040,
      sellT2: 5080,
      sellStop: 4950,
      levels: { target1: 5040, target2: 5080, stopLoss: 4950 },
    },
    {
      ticker: 'HOTWATCH',
      ltp: 1000,
      verdict: 'WATCH',
      score: 11,
      aboveOpen: true,
      sellT1: 1020,
      sellT2: 1040,
      sellStop: 990,
      levels: { target1: 1020, target2: 1040, stopLoss: 990 },
    },
  ], { availableMargin: 0 });
  assert.ok(plan.byTicker.HOTWATCH, 'P>12 Watch must enter live pool');
  assert.equal(plan.byTicker.HOTWATCH && plan.picks.find((p) => p.ticker === 'HOTWATCH').verdict, 'BUY');
  assert.ok(plan.byTicker.HOTWATCH.qty >= 1);
});

test('leftover budget fills from Watch section', () => {
  const plan = allocateBudget(20000, [
    {
      ticker: 'BUY1',
      ltp: 9500,
      verdict: 'BUY',
      score: 11,
      aboveOpen: true,
      sellT1: 9600,
      sellT2: 9700,
      sellStop: 9400,
      levels: { target1: 9600, target2: 9700, stopLoss: 9400 },
    },
    {
      ticker: 'WATCH1',
      ltp: 400,
      verdict: 'WATCH',
      score: 11,
      aboveOpen: true,
      sellT1: 410,
      sellT2: 420,
      sellStop: 396,
      levels: { target1: 410, target2: 420, stopLoss: 396 },
    },
    {
      ticker: 'WATCH_LOW',
      ltp: 300,
      verdict: 'WATCH',
      score: 4,
      aboveOpen: true,
      sellT1: 301,
      sellT2: 302,
      sellStop: 297,
      levels: { target1: 301, target2: 302, stopLoss: 297 },
    },
  ], { availableMargin: 16769 });
  assert.ok(plan.byTicker.BUY1);
  assert.ok(plan.byTicker.BUY1.qty >= 1);
  assert.ok(plan.watchFilled.length >= 1, 'should promote Watch with P > 12');
  assert.ok(!plan.watchFilled.includes('WATCH_LOW'), 'Watch with P ≤ 12 must stay out');
  const watchPick = plan.picks.find((p) => p.fromWatch);
  assert.ok(watchPick);
  assert.equal(watchPick.verdict, 'BUY');
  assert.ok(watchPick.profitScore > 12);
  assert.ok(watchPick.qty > 0);
  assert.ok(plan.used > 20000, 'available margin should fund Watch beyond ₹20k BUY slice');
});

test('applyLiveLtp marks LIVE and refreshes ENTRY BUY SELL', () => {
  const phase = sessionPhase(istToEpoch('2026-11-10', 8, 0), 'regular');
  let row = {
    ticker: 'SBIN',
    key: 'NSE_EQ|INE062A01020',
    verdict: 'PREP',
    ltp: 1018.5,
    levels: {
      stopLoss: 1010.5, target1: 1023.6, target2: 1032, entry: 1018.5, activeStop: 1010.5,
    },
  };
  row = withTradeSignals(row, phase);
  row = applyLiveLtp(row, 1020, phase);
  assert.equal(row.live, true);
  assert.equal(row.ltp, 1020);
  assert.equal(row.buy, 'LATER');
  assert.ok(row.entry);
  assert.ok(row.sellStop);
  assert.ok(row.sellT1);
});

test('render before open shows watchlist not trade plan', () => {
  const text = render({
    book: {
      asOf: '2026-11-08',
      screened: 30,
      phase: {
        phase: 'before_open',
        canDecideBuy: false,
        clock: '13:05',
        message: 'Market not open yet — no BUY decision. Levels only. Re-check after 9:15.',
      },
      budget: { budget: 20000, used: 0, left: 20000, pickCount: 0 },
      core: [{
        ticker: 'SBIN',
        verdict: 'PREP',
        score: 11,
        profitScore: 14.2,
        ltp: 1018.5,
        entry: 1018.5,
        buy: 'LATER',
        action: 'WAIT OPEN',
        sellStop: 1010.5,
        sellT1: 1020,
        sellT2: 1027,
        rsi: 65,
        distSma: 3.5,
        d1: 1.2,
        d5: 5.9,
        levels: {
          support: 999.5, resistance: 1020, stopLoss: 1010.5, target1: 1020, target2: 1027, resistanceNext: 1029,
          activeStop: 1010.5, trailCost: 1018.5, trailLock03: 1021.55, trailLabel: 'initial SL',
        },
      }],
      prep: [],
      liveBuys: [],
      extrasWatch: [],
      extrasSkipHot: [],
    },
    updatedAt: '08 Nov 13:05 IST',
    feed: 'live',
  }, { width: 110, height: 40, fill: false }).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(text, /Watchlist — P > 12/);
  assert.match(text, /no BUY decision/i);
  assert.match(text, /SBIN/);
  assert.match(text, /ENTRY/);
  assert.match(text, /BUY/);
  assert.match(text, /SELL/);
  assert.match(text, /FEED LIVE/);
  assert.doesNotMatch(text, /Live BUY now/);
});

function sampleCard(partial) {
  return {
    score: 8,
    ltp: 100,
    entry: 100,
    buy: 'NO',
    action: 'WAIT',
    sellStop: 99,
    sellT1: 101,
    sellT2: 102,
    rsi: 55,
    distSma: 2,
    levels: {
      support: 98, resistance: 103, stopLoss: 99, target1: 101, target2: 102,
      resistanceNext: 104, activeStop: 99, trailCost: 100, trailLock03: 100.3, trailLabel: 'initial SL',
    },
    ...partial,
  };
}

test('render shows Top Gainers with P score', () => {
  const text = render({
    book: {
      asOf: '2026-11-08',
      screened: 40,
      phase: { phase: 'open', canDecideBuy: true, clock: '14:45', message: 'Live' },
      budget: { budget: 20000, used: 0, left: 20000, pickCount: 0 },
      core: [],
      prep: [],
      liveBuys: [],
      extrasWatch: [],
      extrasSkipHot: [],
      topGainers: [
        sampleCard({
          ticker: 'SIEMENS', verdict: 'WATCH', fromGainer: true, dayChangePct: 3.06, profitScore: 15.94,
        }),
        sampleCard({
          ticker: 'WEAKGAIN', verdict: 'SKIP', fromGainer: true, dayChangePct: 5, profitScore: 8.2,
        }),
      ],
    },
    updatedAt: '08 Nov 14:45 IST',
    feed: 'live',
  }, { width: 110, height: 50, fill: false }).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(text, /Top Gainers — P > 12/);
  assert.match(text, /SIEMENS/);
  assert.match(text, /P15\.94|P15/);
  assert.doesNotMatch(text, /WEAKGAIN/);
});

test('gainer already in Live BUY or Watchlist is flagged there, not repeated in Top Gainers', () => {
  const text = render({
    book: {
      asOf: '2026-11-08',
      screened: 40,
      phase: { phase: 'open', canDecideBuy: true, clock: '14:45', message: 'Live' },
      budget: { budget: 20000, used: 5000, left: 15000, pickCount: 1, expectedT1: 40 },
      core: [],
      prep: [],
      liveBuys: [
        sampleCard({
          ticker: 'TATASTEEL', verdict: 'BUY', buy: 'YES', action: 'BUY', profitScore: 14.2, qty: 10, spend: 1800,
        }),
        sampleCard({
          ticker: 'NTPC', verdict: 'BUY', buy: 'YES', action: 'BUY', profitScore: 18.5, qty: 20, spend: 6000,
        }),
      ],
      extrasWatch: [
        sampleCard({ ticker: 'SIEMENS', verdict: 'WATCH', profitScore: 15.9 }),
        sampleCard({ ticker: 'LOWP', verdict: 'WATCH', profitScore: 9.1 }),
        sampleCard({ ticker: 'BEL', verdict: 'WATCH', profitScore: 13.2 }),
      ],
      extrasSkipHot: [],
      topGainers: [
        sampleCard({ ticker: 'TATASTEEL', verdict: 'BUY', fromGainer: true, profitScore: 14.2, dayChangePct: 2.1 }),
        sampleCard({ ticker: 'SIEMENS', verdict: 'WATCH', fromGainer: true, profitScore: 15.9, dayChangePct: 3.0 }),
        sampleCard({ ticker: 'ASHOKLEY', verdict: 'WATCH', fromGainer: true, profitScore: 13.5, dayChangePct: 3.4 }),
        sampleCard({ ticker: 'WEAKGAIN', verdict: 'WATCH', fromGainer: true, profitScore: 8.0, dayChangePct: 4.0 }),
      ],
    },
    updatedAt: '08 Nov 14:45 IST',
    feed: 'live',
  }, { width: 120, height: 80, fill: false }).replace(/\x1b\[[0-9;]*m/g, '');

  assert.match(text, /Live BUY/);
  assert.match(text, /Watchlist — P > 12/);
  assert.match(text, /GAINER/);
  // Highest P Live BUY first: NTPC (18.5) before TATASTEEL (14.2)
  assert.ok(text.indexOf('NTPC') < text.indexOf('TATASTEEL'));
  // Watchlist: SIEMENS (15.9) before BEL (13.2); LOWP (P 9.1) hidden
  assert.ok(text.indexOf('SIEMENS') < text.indexOf('BEL'));
  assert.doesNotMatch(text, /LOWP/);
  assert.doesNotMatch(text, /WEAKGAIN/);
  // Overlap stays in Live/Watch with flag; only ASHOKLEY remains under Top Gainers
  const gainerSection = text.slice(text.indexOf('Top Gainers'));
  assert.match(gainerSection, /ASHOKLEY/);
  assert.doesNotMatch(gainerSection, /TATASTEEL/);
  assert.doesNotMatch(gainerSection, /SIEMENS/);
});
