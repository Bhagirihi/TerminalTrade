'use strict';

process.env.MUHURAT_CONFIRM_SEC = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  premiumLevels,
  scoreOptionSide,
  analyzeIndex,
  detectIndexTrain,
  allocateOptionsBudget,
} = require('../src/muhurat-options');
const { isOptionsArg, render } = require('../tools/muhurat');

test('premiumLevels uses −5% hard SL and targets above', () => {
  const lv = premiumLevels(100);
  assert.equal(lv.stopLoss, 95);
  assert.ok(lv.target1 > 100);
  assert.ok(lv.target2 >= lv.target1);
});

test('scoreOptionSide prefers matching bias', () => {
  const bull = scoreOptionSide({ score: 8, reasons: [], bias: 'CE', aboveSma: true, rsi: 55 }, 'CE');
  const against = scoreOptionSide({ score: 8, reasons: [], bias: 'CE', aboveSma: true, rsi: 55 }, 'PE');
  assert.ok(bull.score > against.score);
});

test('analyzeIndex returns CE/PE bias from trend', () => {
  const candles = [];
  let px = 24000;
  for (let i = 0; i < 60; i++) {
    px += 40;
    candles.push({ open: px - 20, high: px + 30, low: px - 30, close: px });
  }
  const row = analyzeIndex({ id: 'NIFTY', lotSize: 65, strikeStep: 50 }, candles, px);
  assert.equal(row.bias, 'CE');
  assert.ok(row.score > 0);
});

function synth15m(startPx, n, step, vol = 1000) {
  const bars = [];
  let px = startPx;
  const day0 = Date.parse('2026-11-19T09:15:00+05:30');
  for (let i = 0; i < n; i++) {
    const open = px;
    const close = px + step;
    const high = Math.max(open, close) + Math.abs(step) * 0.4;
    const low = Math.min(open, close) - Math.abs(step) * 0.3;
    bars.push({
      t: day0 + i * 15 * 60 * 1000,
      open,
      high,
      low,
      close,
      volume: vol + (i % 3) * 50,
    });
    px = close;
  }
  return bars;
}

test('detectIndexTrain flags CE on breakout + indicator confirms', () => {
  // Build a rising 15m series so ST/EMA/ADX/VWAP can seed, then break out.
  const bars = synth15m(24800, 40, 12, 1200);
  const last = bars[bars.length - 1];
  // Spike breakout with heavy volume
  const px = last.close;
  bars.push({
    t: last.t + 15 * 60 * 1000,
    open: px,
    high: px + 180,
    low: px - 10,
    close: px + 150,
    volume: 8000,
  });
  const t = detectIndexTrain(bars, px + 150);
  assert.equal(t.train, 'CE');
  assert.ok(t.confirms.length >= 2);
  assert.ok(t.indicators);
  assert.ok(t.indicators.ema9 > t.indicators.ema21);
});

test('detectIndexTrain flags PE on breakdown + indicator confirms', () => {
  const bars = synth15m(25200, 40, -12, 1200);
  const last = bars[bars.length - 1];
  const px = last.close;
  bars.push({
    t: last.t + 15 * 60 * 1000,
    open: px,
    high: px + 10,
    low: px - 180,
    close: px - 150,
    volume: 8000,
  });
  const t = detectIndexTrain(bars, px - 150);
  assert.equal(t.train, 'PE');
  assert.ok(t.confirms.length >= 2);
});

test('detectIndexTrain waits for enough 15m history to seed indicators', () => {
  const bars = synth15m(25000, 12, 40, 5000);
  const t = detectIndexTrain(bars, bars[bars.length - 1].close);
  assert.equal(t.train, null);
  assert.match(t.trainReason, /need/);
});

test('analyzeIndex forces CE bias when train is CE', () => {
  const candles = [];
  let px = 24500;
  for (let i = 0; i < 60; i++) {
    px -= 20;
    candles.push({ open: px + 10, high: px + 20, low: px - 20, close: px });
  }
  const row = analyzeIndex(
    { id: 'NIFTY', lotSize: 65, strikeStep: 50 },
    candles,
    px,
    { train: 'CE', trainReason: '15m breakout', trainLevel: 25000 }
  );
  assert.equal(row.bias, 'CE');
  assert.equal(row.train, 'CE');
  assert.ok(row.reasons.some((r) => /TRAIN/.test(r)));
});

test('scoreOptionSide boosts TRAIN side and penalizes against', () => {
  const base = { score: 8, reasons: [], bias: 'CE', aboveSma: true, rsi: 55, train: 'CE' };
  const ce = scoreOptionSide(base, 'CE');
  const pe = scoreOptionSide(base, 'PE');
  assert.ok(ce.score > pe.score);
  assert.ok(ce.reasons.some((r) => /TRAIN CE/.test(r)));
  assert.ok(pe.reasons.some((r) => /against TRAIN/.test(r)));
});

test('allocateOptionsBudget sizes in lots', () => {
  // lotCost = 100*65 = 6500 → above ₹5k → 1 lot
  const plan = allocateOptionsBudget(20000, [
    {
      ticker: 'NIFTY 25000 CE',
      key: 'NSE_FO|1',
      verdict: 'BUY',
      ltp: 100,
      lotSize: 65,
      profitScore: 18,
      reward1Pct: 20,
      rr: 1.2,
      sellT1: 122,
      levels: { target1: 122, stopLoss: 72 },
      aboveOpen: true,
    },
  ], { now: Date.now() });
  assert.ok(plan.pickCount >= 1);
  const pick = plan.picks[0];
  assert.equal(pick.qty % 65, 0);
  assert.equal(pick.lots, 1);
  assert.ok(pick.spend <= 20000 + 1);
});

test('options: below ₹5k lot cost → 2 lots; above ₹10k → 1 lot', () => {
  const cheap = allocateOptionsBudget(20000, [
    {
      ticker: 'BANKNIFTY 50000 CE',
      key: 'NSE_FO|2',
      verdict: 'BUY',
      ltp: 100, // 100*30 = 3000 < 5k → 2 lots
      lotSize: 30,
      profitScore: 20,
      reward1Pct: 20,
      rr: 1.2,
      sellT1: 120,
      levels: { target1: 120, stopLoss: 70 },
      aboveOpen: true,
    },
  ], { now: Date.now() });
  assert.equal(cheap.picks[0].lots, 2);
  assert.equal(cheap.picks[0].qty, 60);

  const rich = allocateOptionsBudget(40000, [
    {
      ticker: 'NIFTY 25000 CE',
      key: 'NSE_FO|3',
      verdict: 'BUY',
      ltp: 200, // 200*65 = 13000 > 10k → 1 lot
      lotSize: 65,
      profitScore: 20,
      reward1Pct: 20,
      rr: 1.2,
      sellT1: 240,
      levels: { target1: 240, stopLoss: 150 },
      aboveOpen: true,
    },
  ], { now: Date.now() });
  assert.equal(rich.picks[0].lots, 1);
  assert.equal(rich.picks[0].qty, 65);
});

test('allocateOptionsBudget skips 1 lot above hard budget', () => {
  const plan = allocateOptionsBudget(5000, [
    {
      ticker: 'NIFTY 25000 CE',
      key: 'NSE_FO|1',
      verdict: 'BUY',
      ltp: 200,
      lotSize: 65,
      profitScore: 20,
      reward1Pct: 20,
      rr: 1.2,
      sellT1: 240,
      levels: { target1: 240, stopLoss: 150 },
      aboveOpen: true,
    },
  ], { availableMargin: 100000, now: Date.now() });
  assert.equal(plan.pickCount, 0);
  assert.ok((plan.unaffordable || []).length >= 1);
  assert.ok(plan.unaffordable[0].need >= 13000);
});

test('isOptionsArg detects --Options', () => {
  const prev = process.argv.slice();
  process.argv = ['node', 'tools/muhurat.js', '--Options'];
  assert.equal(isOptionsArg(), true);
  process.argv = ['node', 'tools/muhurat.js', '--option'];
  assert.equal(isOptionsArg(), true);
  process.argv = prev;
});

test('render options mode title', () => {
  const text = render({
    mode: 'options',
    book: {
      mode: 'options',
      asOf: '2026-11-08',
      screened: 4,
      phase: { phase: 'closed', canDecideBuy: false, clock: '19:40', message: 'Session closed.' },
      budget: { budget: 20000, used: 0, left: 20000, pickCount: 0 },
      indexes: [{ indexId: 'NIFTY', indexLtp: 24986, bias: 'CE', train: 'CE' }],
      core: [{
        ticker: 'NIFTY 25000 CE',
        right: 'CE',
        verdict: 'NO NEW BUY',
        profitScore: 16.2,
        score: 10,
        ltp: 128,
        indexLtp: 24986,
        entry: 128,
        buy: 'NO',
        action: 'EXIT ONLY',
        sellStop: 92,
        sellT1: 156,
        sellT2: 186,
        rsi: 55,
        distSma: 2,
        lotSize: 65,
        levels: {
          support: 110, resistance: 156, stopLoss: 92, target1: 156, target2: 186,
          resistanceNext: 186, activeStop: 92, trailCost: 128, trailLock03: 128.4, trailLabel: 'initial SL',
        },
      }],
      prep: [],
      liveBuys: [],
      extrasWatch: [],
      extrasSkipHot: [],
      topGainers: [],
    },
    updatedAt: '08 Nov 19:40 IST',
    feed: 'live',
  }, { width: 110, height: 40, fill: false }).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(text, /Muhurat Options/);
  assert.match(text, /NIFTY 25000 CE/);
  assert.match(text, /TRAIN→CE/);
  assert.doesNotMatch(text, /Top Gainers/);
});
