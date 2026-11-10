'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { summarizePortfolio } = require('../src/portfolio');

test('portfolio: holdings investment is quantity times average price, P&L is the Upstox pnl', () => {
  const book = summarizePortfolio(
    [
      { quantity: 10, average_price: 100, last_price: 110, pnl: 100 },
      { quantity: 0, t1_quantity: 0, average_price: 50, pnl: 0 },
    ],
    []
  );
  assert.strictEqual(book.investment, 1000);
  assert.strictEqual(book.pnl, 100);
  assert.strictEqual(book.holdings, 1);
  assert.strictEqual(book.positions, 0);
});

test('portfolio: a pending t1 quantity counts when the settled quantity is zero', () => {
  const book = summarizePortfolio([{ quantity: 0, t1_quantity: 4, average_price: 25, pnl: 8 }], []);
  assert.strictEqual(book.investment, 100);
  assert.strictEqual(book.pnl, 8);
});

test('portfolio: delivery equity positions are not added again, F&O and closed intraday are', () => {
  const book = summarizePortfolio(
    [{ quantity: 10, average_price: 100, pnl: 50 }],
    [
      { product: 'D', instrument_token: 'NSE_EQ|INE000', quantity: 10, average_price: 100, pnl: 50 },
      { product: 'I', instrument_token: 'NSE_FO|1', quantity: 65, multiplier: 1, average_price: 80, pnl: 325 },
      { product: 'I', instrument_token: 'NSE_FO|2', quantity: -30, average_price: 10, pnl: -90 },
      { product: 'I', instrument_token: 'NSE_EQ|INE111', quantity: 0, realised: 40, unrealised: 0, pnl: 40 },
    ]
  );
  assert.strictEqual(book.investment, 1000 + 65 * 80 + 30 * 10);
  assert.strictEqual(book.pnl, 50 + 325 - 90 + 40);
  assert.strictEqual(book.holdings, 1);
  assert.strictEqual(book.positions, 2);
});

const { summarizeLive } = require('../src/portfolio');

test('portfolio live: a live tick reprices P&L between polls', () => {
  const rows = [{ instrument_token: 'NSE_EQ|INE1', quantity: 10, average_price: 100, last_price: 110, pnl: 100 }];
  const book = summarizeLive(rows, [], (r) => (r.instrument_token === 'NSE_EQ|INE1' ? 115 : null));
  assert.strictEqual(book.investment, 1000);
  assert.strictEqual(book.pnl, 150); // (115-100)*10, not the stale api pnl 100
  assert.strictEqual(book.liveCount, 1);
  assert.strictEqual(book.totalCount, 1);
});

test('portfolio live: falls back to the REST snapshot when no live tick', () => {
  const rows = [{ instrument_token: 'NSE_EQ|INE1', quantity: 10, average_price: 100, last_price: 110, pnl: 100 }];
  const book = summarizeLive(rows, [], () => null);
  assert.strictEqual(book.pnl, 100);
  assert.strictEqual(book.liveCount, 0);
});

test('portfolio live: short F&O position with multiplier uses live LTP', () => {
  const book = summarizeLive(
    [],
    [{ product: 'I', instrument_token: 'NSE_FO|1', quantity: -30, multiplier: 1, average_price: 80, pnl: -90 }],
    () => 70
  );
  assert.strictEqual(book.investment, 30 * 80);
  assert.strictEqual(book.pnl, (70 - 80) * -30); // short gains as price falls
  assert.strictEqual(book.liveCount, 1);
});

test('portfolio live: mixed live and snapshot rows', () => {
  const rows = [
    { instrument_token: 'NSE_EQ|A', quantity: 10, average_price: 100, last_price: 110, pnl: 100 },
    { instrument_token: 'NSE_EQ|B', quantity: 5, average_price: 200, last_price: 190, pnl: -50 },
  ];
  const book = summarizeLive(rows, [], (r) => (r.instrument_token === 'NSE_EQ|A' ? 120 : null));
  assert.strictEqual(book.pnl, 200 - 50); // live for A: (120-100)*10=200; snapshot for B: -50
  assert.strictEqual(book.liveCount, 1);
  assert.strictEqual(book.totalCount, 2);
});
