'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadFeedType, pricesFromObject } = require('../src/data/upstox-feed');

test('feed decode: ltpc last price for an index key', async () => {
  const FeedResponse = await loadFeedType();
  const msg = FeedResponse.create({
    feeds: {
      'NSE_INDEX|Nifty 50': { ltpc: { ltp: 22501.25, cp: 22440.1 } },
      'NSE_INDEX|Nifty Bank': { ltpc: { ltp: 48110.5, cp: 47990 } },
    },
  });
  const buf = FeedResponse.encode(msg).finish();
  const obj = FeedResponse.toObject(FeedResponse.decode(buf), { longs: Number, defaults: false });
  const prices = Object.fromEntries(pricesFromObject(obj).map((p) => [p.instrumentKey, p]));
  assert.deepStrictEqual(prices['NSE_INDEX|Nifty 50'], { instrumentKey: 'NSE_INDEX|Nifty 50', ltp: 22501.25, prevClose: 22440.1 });
  assert.deepStrictEqual(prices['NSE_INDEX|Nifty Bank'], { instrumentKey: 'NSE_INDEX|Nifty Bank', ltp: 48110.5, prevClose: 47990 });
});

test('feed decode: ignores a tick with no price', async () => {
  const FeedResponse = await loadFeedType();
  const msg = FeedResponse.create({
    feeds: { 'NSE_INDEX|Nifty 50': { ltpc: { cp: 22440.1 } } },
  });
  const buf = FeedResponse.encode(msg).finish();
  const obj = FeedResponse.toObject(FeedResponse.decode(buf), { longs: Number, defaults: false });
  assert.deepStrictEqual(pricesFromObject(obj), []);
});
