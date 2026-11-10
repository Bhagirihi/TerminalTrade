'use strict';

process.env.MUHURAT_CONFIRM_SEC = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  premiumLevels,
  scoreOptionSide,
  analyzeIndex,
  allocateOptionsBudget,
} = require('../src/muhurat-options');
const { isOptionsArg, render } = require('../tools/muhurat');

test('premiumLevels puts stop below premium and targets above', () => {
  const lv = premiumLevels(100);
  assert.ok(lv.stopLoss < 100);
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

test('allocateOptionsBudget sizes in lots', () => {
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
  assert.ok(pick.lots >= 1);
  assert.ok(pick.spend <= 20000 + 1);
});

test('isOptionsArg detects --Options', () => {
  const prev = process.argv.slice();
  process.argv = ['node', 'tools/muhurat.js', '--Options'];
  assert.equal(isOptionsArg(), true);
  process.argv = ['node', 'tools/muhurat2.js', '--option'];
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
      indexes: [{ indexId: 'NIFTY', indexLtp: 24986, bias: 'CE' }],
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
  assert.doesNotMatch(text, /Top Gainers/);
});
