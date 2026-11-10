'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { earlyTrigger } = require('../src/early');
const { istToEpoch } = require('../src/time');

const open = istToEpoch('2026-10-16', 9, 15);

function minute(i, barOpen, close) {
  const high = Math.max(barOpen, close);
  const low = Math.min(barOpen, close);
  return { t: open + i * 60000, open: barOpen, high, low, close };
}

test('early trigger waits for the 5-minute candle to close', () => {
  const bars = [0, 1, 2, 3, 4].map((i) => minute(i, 100, 101));
  assert.strictEqual(earlyTrigger(bars, 'LONG', open + 4 * 60000), null);
});

test('early trigger buys the call when the first 5-minute candle closes up with the trend', () => {
  const bars = [0, 1, 2, 3, 4].map((i) => minute(i, 100 + i, 101 + i));
  const hit = earlyTrigger(bars, 'LONG', open + 5 * 60000);
  assert.strictEqual(hit.timeIST, '09:20');
  assert.strictEqual(hit.side, 'LONG');
  assert.ok(hit.price > 100);
});

test('early trigger skips a 5-minute candle that closes against the trend and takes the next one', () => {
  const down = [0, 1, 2, 3, 4].map((i) => minute(i, 110 - i, 109 - i));
  const up = [5, 6, 7, 8, 9].map((i) => minute(i, 100, 102));
  assert.strictEqual(earlyTrigger(down, 'LONG', open + 5 * 60000), null);
  const hit = earlyTrigger(down.concat(up), 'LONG', open + 10 * 60000);
  assert.strictEqual(hit.timeIST, '09:25');
});

test('early trigger stays flat when both 5-minute candles close against the trend', () => {
  const down = [];
  for (let i = 0; i < 10; i++) down.push(minute(i, 120 - i, 119 - i));
  assert.strictEqual(earlyTrigger(down, 'LONG', open + 10 * 60000), null);
});
