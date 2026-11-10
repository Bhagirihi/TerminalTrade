'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { screenHolding, simpleRsi } = require('../src/portfolio-screen');

function flat(n, price) {
  return new Array(n).fill(price);
}

test('screen: price above the 50-day average and a small loss is KEEP', () => {
  const closes = flat(60, 100);
  closes[closes.length - 1] = 110;
  const row = screenHolding({ ticker: 'RELIANCE', buyPrice: 112, quantity: 10, closes });
  assert.strictEqual(row.action, 'KEEP');
  assert.ok(row.pnlPct > -5);
  assert.ok(row.currentPrice > row.sma50);
});

test('screen: a close under the 50-day average with more than 10% loss is SELL', () => {
  const closes = flat(60, 100);
  closes[closes.length - 1] = 80;
  const row = screenHolding({ ticker: 'TCS', buyPrice: 100, quantity: 5, closes });
  assert.strictEqual(row.action, 'SELL / CUT LOSS');
  assert.ok(row.pnlPct < -10);
});

test('screen: RSI above 75 is BOOK PROFIT only when the keep and sell rules miss', () => {
  const closes = flat(70, 100);
  for (let i = 55; i < closes.length; i++) closes[i] = 100 + (i - 54) * 2;
  const rsi = simpleRsi(closes, 14);
  assert.ok(rsi[rsi.length - 1] > 75);
  const buy = closes[closes.length - 1] / 0.93;
  const row = screenHolding({ ticker: 'INFY', buyPrice: buy, quantity: 15, closes });
  assert.strictEqual(row.action, 'BOOK PROFIT / REVIEW');
  assert.match(row.reason, /RSI:/);
});

test('screen: a short history stays on REVIEW', () => {
  const row = screenHolding({ ticker: 'SBIN', buyPrice: 600, quantity: 20, closes: flat(10, 600) });
  assert.strictEqual(row.action, 'REVIEW');
});
