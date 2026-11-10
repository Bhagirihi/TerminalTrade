'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Engine } = require('../src/engine');
const { SYMBOLS } = require('../src/config');
const { istDateKey, istToEpoch } = require('../src/time');

const nifty = SYMBOLS.find((s) => s.id === 'NIFTY');

function book() {
  return {
    instruments: { '22600|CE': 'NSE_FO|1' },
    ltp: { 'NSE_FO|1': 150 },
    strikes: [22600],
  };
}

test('engine: a closed bar takes that bar’s option candle, not the live premium', () => {
  const engine = new Engine();
  const barT = istToEpoch('2026-10-22', 10, 15);
  const now = barT + 20 * 60000;
  engine.optionCandles['NSE_FO|1'] = [{ t: barT, open: 80, high: 90, low: 70, close: 88, volume: 1 }];
  const lock = { dateKey: istDateKey(barT), barT, type: 'BUY CE', side: 'LONG', price: 22610 };
  engine.stampLock(lock, nifty, book(), 15, now);
  assert.strictEqual(lock.strike, 22600);
  assert.strictEqual(lock.right, 'CE');
  assert.strictEqual(lock.premium, 88);
});

test('engine: a live bar stamps the chain premium once', () => {
  const engine = new Engine();
  const barT = istToEpoch(istDateKey(Date.now()), 10, 15);
  const now = barT + 60 * 1000;
  const chain = book();
  const lock = { dateKey: istDateKey(now), barT, type: 'BUY CE', side: 'LONG', price: 22610 };
  engine.stampLock(lock, nifty, chain, 15, now);
  assert.strictEqual(lock.premium, 150);
  chain.ltp['NSE_FO|1'] = 10;
  engine.stampLock(lock, nifty, chain, 15, now);
  assert.strictEqual(lock.premium, 150);
});

test('engine: a closed bar with no option candle stays unpriced', () => {
  const engine = new Engine();
  const barT = istToEpoch('2026-10-22', 10, 15);
  const lock = { dateKey: istDateKey(barT), barT, type: 'BUY CE', side: 'LONG', price: 22610 };
  engine.stampLock(lock, nifty, book(), 15, barT + 20 * 60000);
  assert.ok(lock.premium == null);
  assert.strictEqual(lock.strike, 22600);
});
