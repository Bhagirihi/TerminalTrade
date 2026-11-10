'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { repriceBookPortfolio, portfolioKeysOf } = require('../tools/muhurat');

test('portfolioKeysOf reads instrument_token', () => {
  assert.deepEqual(
    portfolioKeysOf([{ instrument_token: 'NSE_EQ|A' }, { instrument_token: 'NSE_EQ|B' }]),
    ['NSE_EQ|A', 'NSE_EQ|B']
  );
});

test('repriceBookPortfolio moves P&L with live LTPs', () => {
  const book = {
    portfolioRows: {
      holdings: [
        { instrument_token: 'NSE_EQ|A', quantity: 10, average_price: 100, last_price: 110, pnl: 100 },
      ],
      positions: [],
    },
    portfolio: { investment: 1000, pnl: 100 },
    liveBuys: [{ ticker: 'X' }],
  };
  const ltp = new Map([['NSE_EQ|A', 120]]);
  repriceBookPortfolio(book, ltp);
  assert.equal(book.portfolio.investment, 1000);
  assert.equal(book.portfolio.pnl, 200);
  assert.equal(book.portfolio.liveCount, 1);
  assert.equal(book.lossGate.blocked, false);
});
