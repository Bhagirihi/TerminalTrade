'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rowsFromNsePayload, rankByUpstoxDayChange } = require('../src/top-gainers');

test('rowsFromNsePayload maps FOSec gainers', () => {
  const json = {
    FOSec: {
      data: [
        { symbol: 'DIVISLAB', net_price: 7.52, ltp: 6200, prev_price: 5765 },
        { symbol: 'ashokley', net_price: 3.4, ltp: 250, prev_price: 242 },
      ],
    },
  };
  const rows = rowsFromNsePayload(json, 'FOSec');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ticker, 'DIVISLAB');
  assert.equal(rows[0].dayChangePct, 7.52);
  assert.equal(rows[1].ticker, 'ASHOKLEY');
});

test('rankByUpstoxDayChange sorts by day % from full quotes', async () => {
  const provider = {
    async getFullQuotes(keys) {
      const map = new Map();
      map.set('NSE_EQ|A', { last_price: 110, net_change: 10, volume: 1 }); // ~10%
      map.set('NSE_EQ|B', { last_price: 105, net_change: 5, volume: 1 }); // ~5%
      map.set('NSE_EQ|C', { last_price: 90, net_change: -10, volume: 1 }); // loser
      return map;
    },
  };
  const ranked = await rankByUpstoxDayChange(provider, [
    { ticker: 'A', key: 'NSE_EQ|A' },
    { ticker: 'B', key: 'NSE_EQ|B' },
    { ticker: 'C', key: 'NSE_EQ|C' },
  ], { limit: 5 });
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].ticker, 'A');
  assert.ok(ranked[0].dayChangePct > ranked[1].dayChangePct);
});
