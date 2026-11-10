'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { nearestListedStrike, nearestStepStrike, rightForSignal } = require('../src/strikes');

test('nearest listed strike snaps to the contract grid', () => {
  const nifty = [22700, 22750, 22800];
  assert.strictEqual(nearestListedStrike(22750.55, nifty), 22750);
  assert.strictEqual(nearestListedStrike(22780, nifty), 22800);
  const bank = [55400, 55500, 55600, 55700];
  assert.strictEqual(nearestListedStrike(55413.15, bank), 55400);
  assert.strictEqual(nearestListedStrike(55612.5, bank), 55600);
});

test('step fallback matches the 50 and 100 grids', () => {
  assert.strictEqual(nearestStepStrike(22750.55, 50), 22750);
  assert.strictEqual(nearestStepStrike(55413.15, 100), 55400);
  assert.strictEqual(nearestStepStrike(55612.5, 100), 55600);
});

test('signal side maps to CE or PE', () => {
  assert.strictEqual(rightForSignal({ type: 'BUY CE' }), 'CE');
  assert.strictEqual(rightForSignal({ type: 'EXIT PE' }), 'PE');
  assert.strictEqual(rightForSignal({ type: 'SQOFF', side: 'LONG' }), 'CE');
});
