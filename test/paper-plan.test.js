'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  splitCards,
  marketValue,
  updatePaperPlan,
  markPnl,
  INDEX_POOL,
  COMMODITY_POOL,
} = require('../src/paper-plan');

const TMP = path.join(__dirname, '..', 'paper');
const DAY = '2026-10-25';

function clean() {
  for (const name of [`plan-${DAY}.json`, `pnl-${DAY}.json`]) {
    try {
      fs.unlinkSync(path.join(TMP, name));
    } catch (_) {
      /* missing is fine */
    }
  }
}

test('SELL total leaves NEW BUY cash as value minus SELL market value', () => {
  clean();
  const book = {
    investment: 387448.34,
    pnl: -64796.8,
    cards: [
      { ticker: 'RELIANCE', qty: 10, last: 1190, pnl: 319, pnlPct: 2.75 },
      { ticker: 'SWIGGY', qty: 38, last: 176, pnl: -8132, pnlPct: -54.87 },
    ],
  };
  const value = book.investment + book.pnl;
  const sellValue = marketValue(book.cards[1]);
  const plan = updatePaperPlan({
    book,
    symbols: {
      NIFTY: { name: 'NIFTY 50', ltp: 22600, direction: -1, lastSession: 'Fri 23 Oct' },
      BANKNIFTY: { name: 'BANKNIFTY', ltp: 54287, direction: 1, lastSession: 'Fri 23 Oct' },
      CRUDE: { name: 'CRUDE', ltp: 9784, direction: -1, lastSession: 'Fri 23 Oct' },
      GOLD: { name: 'GOLD', ltp: 142150, direction: 1, lastSession: 'Fri 23 Oct' },
      SILVER: { name: 'SILVER', ltp: 196100, direction: -1, lastSession: 'Fri 23 Oct' },
    },
    now: Date.parse(`${DAY}T11:30:00+05:30`),
    persist: true,
  });
  assert.equal(plan.portfolioValue, Math.round(value * 100) / 100);
  assert.equal(plan.sellTotal, sellValue);
  assert.equal(plan.newBuyCashStart, Math.round((value - sellValue) * 100) / 100);
  assert.ok(plan.hold.some((row) => row.ticker === 'RELIANCE'));
  assert.ok(plan.sell.some((row) => row.ticker === 'SWIGGY' && row.status === 'SOLD'));
  assert.ok(fs.existsSync(path.join(TMP, `pnl-${DAY}.json`)));
  clean();
});

test('index and commodity pools are sequential first-come from 50,000', () => {
  clean();
  const value = 322651.54;
  const book = {
    investment: value,
    pnl: 0,
    cards: [{ ticker: 'RELIANCE', qty: 10, last: 1190, pnl: 0, pnlPct: 0 }],
  };
  const plan = updatePaperPlan({
    book,
    symbols: {
      NIFTY: { name: 'NIFTY 50', ltp: 22600, direction: -1, lastSession: 'Fri 23 Oct' },
      BANKNIFTY: { name: 'BANKNIFTY', ltp: 54287, direction: 1, lastSession: 'Fri 23 Oct' },
      CRUDE: { name: 'CRUDE', ltp: 9784, direction: -1, lastSession: 'Fri 23 Oct' },
      GOLD: { name: 'GOLD', ltp: 142150, direction: 1, lastSession: 'Fri 23 Oct' },
      SILVER: { name: 'SILVER', ltp: 196100, direction: -1, lastSession: 'Fri 23 Oct' },
    },
    now: Date.parse(`${DAY}T11:30:00+05:30`),
  });
  const nifty = plan.trades.find((t) => t.indexId === 'NIFTY');
  const bank = plan.trades.find((t) => t.indexId === 'BANKNIFTY');
  const crude = plan.trades.find((t) => t.indexId === 'CRUDE');
  const gold = plan.trades.find((t) => t.indexId === 'GOLD');
  assert.ok(nifty);
  assert.equal(nifty.stake, INDEX_POOL);
  assert.equal(plan.indexPool, 0);
  assert.equal(bank, undefined);
  assert.ok(crude);
  assert.equal(crude.stake, COMMODITY_POOL);
  assert.equal(plan.commodityPool, 0);
  // Gold/Silver stay out of the default paper commodity list.
  assert.equal(gold, undefined);
  assert.equal(plan.trades.some((t) => t.indexId === 'SILVER'), false);
  clean();
});

test('mark pnl is stake times percent move', () => {
  assert.equal(markPnl('LONG', 100, 110, 50000), 5000);
  assert.equal(markPnl('SHORT', 100, 90, 50000), 5000);
});

test('splitCards uses the 10% loss cut', () => {
  const { hold, sell } = splitCards([
    { ticker: 'A', pnlPct: -9 },
    { ticker: 'B', pnlPct: -10.1 },
  ]);
  assert.equal(hold.length, 1);
  assert.equal(sell[0].ticker, 'B');
});
