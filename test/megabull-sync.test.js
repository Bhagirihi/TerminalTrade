'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { syncMegaBull, collectEntries, signalKey } = require('../src/megabull-sync');
const { renderTrade } = require('../src/trade-view');

const PAPER = path.join(__dirname, '..', 'paper');
const DAY = '2026-10-25';

function clean() {
  try {
    fs.unlinkSync(path.join(PAPER, `megabull-${DAY}.json`));
  } catch (_) {
    /* missing is fine */
  }
}

function mockClient(opts = {}) {
  const placed = [];
  return {
    enabled: () => true,
    getProfile: async () => ({
      virtualMoneyLeft: 950000,
      virtualMoney: 1000000,
      brokerage: 40,
    }),
    getPositions: async () => (opts.positions || []),
    getOrders: async () => ({ open: [], executed: placed.slice() }),
    resolveOption: async ({ indexId, strike, right }) => ({
      instrumentToken: 'tok-1',
      instrumentName: `${indexId} ${strike} ${right}`,
      tradingSymbol: `${indexId}26OCT${strike}${right}`,
    }),
    placeOrder: async (body) => {
      if (opts.fail) throw new Error(opts.fail);
      const order = {
        id: 100 + placed.length,
        status: 'COMPLETE',
        price: body.price || 120,
        qty: body.qty,
        type: body.type,
      };
      placed.push(order);
      return order;
    },
    _placed: placed,
  };
}

test('collectEntries merges Supertrend and CE signals in time order', () => {
  const rows = collectEntries({
    symbols: {
      NIFTY: {
        name: 'NIFTY 50',
        lotSize: 65,
        signalsToday: [{ t: 2, type: 'BUY CE', strike: 25400, right: 'CE' }],
      },
    },
    ceStrategy: {
      NIFTY: {
        signalsToday: [{ t: 1, type: 'BUY CE', strike: 25350, right: 'CE' }],
      },
    },
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].strategy, 'CE v3');
  assert.equal(rows[1].strategy, 'Supertrend');
  assert.ok(signalKey(rows[1], 'NIFTY').includes('BUY CE'));
});

test('syncMegaBull places BUY then ignores duplicate, then SELL on exit', async () => {
  clean();
  const client = mockClient();
  const now = Date.parse(`${DAY}T10:00:00+05:30`);
  const state = {
    symbols: {
      NIFTY: {
        name: 'NIFTY 50',
        lotSize: 65,
        signalsToday: [
          { t: 1, timeIST: '09:30', type: 'BUY CE', strike: 25400, right: 'CE', premium: 110 },
        ],
      },
    },
  };
  const first = await syncMegaBull(client, state, now);
  assert.equal(client._placed.length, 1);
  assert.equal(client._placed[0].type, 'BUY');
  assert.equal(first.virtualMoneyLeft, 950000);
  assert.equal(first.log.length, 1);

  const again = await syncMegaBull(client, state, now);
  assert.equal(client._placed.length, 1);
  assert.equal(again.log.length, 1);

  state.symbols.NIFTY.signalsToday.push({
    t: 2,
    timeIST: '11:00',
    type: 'EXIT CE',
    strike: 25400,
    right: 'CE',
    premium: 140,
  });
  const exited = await syncMegaBull(client, state, now);
  assert.equal(client._placed.length, 2);
  assert.equal(client._placed[1].type, 'SELL');
  assert.ok(exited.log.some((row) => row.side === 'SELL'));
  clean();
});

test('syncMegaBull skips exit when no entry was placed', async () => {
  clean();
  const client = mockClient();
  const now = Date.parse(`${DAY}T10:00:00+05:30`);
  await syncMegaBull(client, {
    symbols: {
      NIFTY: {
        name: 'NIFTY 50',
        lotSize: 65,
        signalsToday: [{ t: 1, type: 'EXIT CE', strike: 25400, right: 'CE' }],
      },
    },
  }, now);
  assert.equal(client._placed.length, 0);
  clean();
});

test('trade view shows MegaBull cash and position', () => {
  const text = String(renderTrade({
    status: 'live',
    source: 'UPSTOX',
    updatedAt: '2026-10-25 10:54 IST',
    symbols: {
      NIFTY: { name: 'NIFTY 50', ltp: 25400, direction: 1, signalsToday: [] },
      BANKNIFTY: { name: 'BANKNIFTY', ltp: 55000, direction: -1, signalsToday: [] },
    },
    megabull: {
      enabled: true,
      virtualMoneyLeft: 950000,
      virtualMoney: 1000000,
      brokerage: 40,
      positions: [{
        instrumentName: 'NIFTY 25400 CE',
        instrumentToken: '1',
        type: 'LONG',
        qty: 65,
        priceAvg: 110,
        pl: 325,
      }],
      log: [{ type: 'BUY CE', tradingSymbol: 'NIFTY26OCT25400CE', price: 110, status: 'COMPLETE' }],
      lastError: '',
    },
  }, { width: 120, height: 80 })).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(text, /MegaBull paper/);
  assert.match(text, /Cash left/);
  assert.match(text, /9,50,000/);
  assert.match(text, /NIFTY 25400 CE/);
  assert.match(text, /LONG/);
  assert.match(text, /Virtual MegaBull orders only/);
});
