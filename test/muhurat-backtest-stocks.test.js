'use strict';

// Tests for the muhurat stocks-lane backtest (src/muhurat-backtest.js).
// No network: all data is synthetic. The synthetic daily series is built so
// SBIN screens BUY (score 11, RSI ~65, P > 12) — if the screen math changes,
// these tests fail loudly instead of silently replaying a different strategy.

const assert = require('node:assert');
const { test } = require('node:test');
const {
  intradayRoundTripCost,
  buildSymbolDay,
  buildRow,
  replayDay,
  summarizeDays,
  dayDoc,
} = require('../src/muhurat-backtest');
const {
  analyzeName,
  applySessionVerdict,
  sessionPhase,
  CORE,
} = require('../src/muhurat');
const { istToEpoch } = require('../src/time');

const SBIN = CORE.find((c) => c.ticker === 'SBIN');
const DAY = '2026-11-13'; // Friday
const PREV = '2026-11-12';

// Daily closes: gentle drift, then a 14-day window with 8 up / 6 down days
// (RSI ~65) and a strong last 5 days (d5 ~+5%). High/low = close ±0.7%.
function syntheticDaily() {
  const pcts = [];
  for (let i = 0; i < 56; i += 1) pcts.push(i % 5 === 4 ? -0.2 : 0.25);
  // Last 14 days: D D U D U D U D D U U U U U (up +0.9/+1.0.., down -0.7).
  const last14 = [-0.7, -0.7, 0.9, -0.7, 0.9, -0.7, 0.9, -0.7, -0.7, 1.0, 1.1, 0.9, 1.0, 1.2];
  pcts.push(...last14);
  const candles = [];
  let close = 100;
  let t = Date.parse('2026-08-24T09:15:00+05:30');
  for (let i = 0; i < pcts.length; i += 1) {
    close *= 1 + pcts[i] / 100;
    candles.push({
      t,
      open: close / (1 + pcts[i] / 100),
      high: close * 1.007,
      low: close * 0.993,
      close,
      volume: 100000,
    });
    t += 86400000;
    // Skip weekends in the synthetic calendar (not load-bearing for the test).
    const d = new Date(t);
    if (d.getUTCDay() === 6) t += 86400000;
    if (d.getUTCDay() === 0) t += 86400000;
  }
  return candles;
}

// 1m bars for DAY from a per-minute close path (fractions of open).
function minuteBars(open, closes) {
  const bars = [];
  let prev = open;
  for (let i = 0; i < closes.length; i += 1) {
    const close = closes[i];
    bars.push({
      t: istToEpoch(DAY, 9, 15) + i * 60000,
      open: prev,
      high: Math.max(prev, close) * 1.001,
      low: Math.min(prev, close) * 0.999,
      close,
      volume: 1000,
    });
    prev = close;
  }
  return bars;
}

function flatPath(n, level) {
  return Array.from({ length: n }, (_, i) => level * (1 + 0.0005 * Math.sin(i / 7)));
}

test('intraday costs match the published Upstox stack (hand-computed)', () => {
  // Buy 10 @ 1000, sell 10 @ 1010.
  const c = intradayRoundTripCost(10000, 10100);
  assert.strictEqual(c.brokerage, 20.1); // min(0.1%, 20) each leg: 10 + 10.10
  assert.strictEqual(c.stt, 2.53); // 0.025% of sell
  assert.strictEqual(c.txn, 0.62); // 0.00307% of 20100
  assert.strictEqual(c.sebi, 0.02); // Rs 10/crore of 20100
  assert.strictEqual(c.stamp, 0.3); // 0.003% of buy
  assert.strictEqual(c.gst, 3.73); // 18% of (20.10 + 0.62 + 0.02)
  assert.strictEqual(c.total, 27.3);
});

test('synthetic daily series screens BUY with P > 12', () => {
  const daily = syntheticDaily();
  const row = analyzeName(SBIN, daily, daily[daily.length - 1].close);
  assert.strictEqual(row.verdict, 'BUY');
  assert.ok(row.score >= 8, `score ${row.score}`);
  assert.ok(row.rsi >= 45 && row.rsi <= 68, `rsi ${row.rsi}`);
  const { profitMetrics } = require('../src/muhurat');
  const m = profitMetrics({ ...row, sellStop: row.levels.stopLoss, sellT1: row.levels.target1, sellT2: row.levels.target2 });
  assert.ok(m.profitScore > 12, `P ${m.profitScore}`);
});

test('buildRow matches analyzeName at the same LTP', () => {
  const daily = syntheticDaily();
  const sd = buildSymbolDay(SBIN, daily);
  assert.ok(sd);
  const open = daily[daily.length - 1].close;
  const t = istToEpoch(DAY, 10, 0);
  const phase = sessionPhase(t, 'regular');
  assert.strictEqual(phase.phase, 'live');
  for (const f of [1, 1.01, 0.99]) {
    const ltp = open * f;
    const a = applySessionVerdict(analyzeName(SBIN, daily, ltp), phase, open);
    const b = buildRow(sd, ltp, phase, open);
    assert.strictEqual(b.verdict, a.verdict, `verdict @ ${f}`);
    assert.strictEqual(b.score, a.score, `score @ ${f}`);
    assert.strictEqual(b.levels.stopLoss, a.levels.stopLoss, `stop @ ${f}`);
    assert.strictEqual(b.levels.target1, a.levels.target1, `t1 @ ${f}`);
    assert.strictEqual(b.levels.target2, a.levels.target2, `t2 @ ${f}`);
    assert.strictEqual(b.aboveOpen, a.aboveOpen, `aboveOpen @ ${f}`);
  }
});

function runDay(closes, opts = {}) {
  const daily = opts.daily || syntheticDaily();
  const open = daily[daily.length - 1].close;
  const sd = buildSymbolDay(SBIN, daily);
  const bars = minuteBars(open, closes);
  const result = replayDay(DAY, new Map([['SBIN', sd]]), new Map([['SBIN', bars]]), {
    budget: 15000,
    confirmSec: 60,
    maxTrades: 5,
    ...opts,
  });
  return { result, open, daily };
}

test('replay: rising day exits at T2, respects confirm gate and budget', () => {
  const open = syntheticDaily().pop().close;
  const { result } = runDay(
    Array.from({ length: 376 }, (_, i) => open * (1 + (i < 120 ? i * 0.0002 : 0.024)))
  );
  assert.strictEqual(result.tradeCount, 1);
  const tr = result.trades[0];
  assert.strictEqual(tr.exitReason, 'T2');
  assert.ok(tr.exit > tr.entry, 'T2 exit above entry');
  assert.ok(tr.spend <= 15000, `spend ${tr.spend} within budget`);
  assert.ok(tr.qty > 0);
  // Confirm gate: name enters the pool at 09:25, needs 60s → first buy 09:26+.
  assert.ok(
    new Date(tr.buyAt).getTime() >= istToEpoch(DAY, 9, 26),
    `bought at ${tr.buyAt}, expected >= 09:26 IST`
  );
  assert.ok(tr.charges > 0, 'charges applied');
  assert.strictEqual(tr.netPnl, Math.round((tr.pnl - tr.charges) * 100) / 100);
});

test('replay: falling day exits at SL below entry', () => {
  const open = syntheticDaily().pop().close;
  // Rise slightly first so the 09:26 entry is above the session open (the
  // live above-open guard would skip a below-open entry), then fall -2.5%.
  const closes = Array.from({ length: 376 }, (_, i) => {
    if (i < 20) return open * (1 + i * 0.0001);
    return open * (1 + 0.002 - (i - 20) * 0.0003);
  });
  const { result } = runDay(closes);
  assert.strictEqual(result.tradeCount, 1);
  assert.strictEqual(result.trades[0].exitReason, 'SL');
  assert.ok(result.trades[0].exit < result.trades[0].entry);
  assert.ok(result.trades[0].netPnl < 0);
});

test('replay: flat day squares off at 15:15', () => {
  const { result } = runDay(flatPath(376, syntheticDaily().pop().close));
  assert.strictEqual(result.tradeCount, 1);
  assert.strictEqual(result.trades[0].exitReason, '15:15');
});

test('replay: trail arms at +2.5% and locks +1.5% — exit above entry', () => {
  // For the trail to matter, T2 must sit above the +2.5% arm (otherwise T2
  // fires first). Boost the last daily bar's high so resistanceNext is far
  // above entry and T2 lands near +3.3% vs entry.
  const daily = syntheticDaily();
  const last = daily[daily.length - 1];
  last.high = last.close * 1.1;
  const open = last.close;
  // Rise to +3.0% vs open — above the +2.5% trail arm (measured from the
  // entry, ~+0.4% above open) but below T2 (+2.76% vs entry ≈ +3.15% vs
  // open), so the trail (not T2) produces the exit — then fall to +0.6%.
  const closes = Array.from({ length: 376 }, (_, i) => {
    if (i < 75) return open * (1 + (i * 0.03) / 75); // rise to +3.0% by ~10:30
    return open * (1 + 0.03 - ((i - 75) * 0.02) / 100); // fall to +0.6%
  });
  const { result } = runDay(closes, { daily });
  assert.strictEqual(result.tradeCount, 1);
  const tr = result.trades[0];
  assert.strictEqual(tr.exitReason, 'SL');
  assert.ok(tr.exit > tr.entry, `trail exit ${tr.exit} should be above entry ${tr.entry}`);
  assert.ok(Math.abs(tr.exit / tr.entry - 1.015) < 0.002, `exit should be ~+1.5% lock, got ${tr.exit / tr.entry}`);
});

test('replay: no minute bars → day skipped', () => {
  const daily = syntheticDaily();
  const sd = buildSymbolDay(SBIN, daily);
  const result = replayDay(DAY, new Map([['SBIN', sd]]), new Map(), { budget: 15000 });
  assert.strictEqual(result.skipped, 'no-minute-bars');
});

test('replay: symbol with < 20 daily bars is unusable', () => {
  assert.strictEqual(buildSymbolDay(SBIN, syntheticDaily().slice(0, 10)), null);
});

test('summarizeDays + dayDoc keep live-ledger shape', () => {
  const { result } = runDay(
    Array.from({ length: 376 }, (_, i) => syntheticDaily().pop().close * (1 + (i < 120 ? i * 0.0002 : 0.024)))
  );
  const summary = summarizeDays([result]);
  assert.strictEqual(summary.trades, 1);
  assert.strictEqual(summary.days, 1);
  assert.ok(summary.netPnl > 0);
  const doc = dayDoc(result);
  assert.strictEqual(doc.date, DAY);
  assert.strictEqual(doc.trades.length, 1);
  assert.strictEqual(doc.byMode.equity.tradeCount, 1);
  assert.strictEqual(doc.trades[0].pnl, result.trades[0].pnl, 'ledger pnl stays gross');
  assert.strictEqual(doc.backtest.netPnl, result.netPnl);
});

test('PREV constant is referenced (keeps the day pair explicit)', () => {
  assert.match(PREV, /^\d{4}-\d{2}-\d{2}$/);
});
