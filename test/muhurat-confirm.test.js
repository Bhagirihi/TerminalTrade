'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  updateConfirmLedger,
  isConfirmed,
  seatWithConfirm,
  confirmAgeSec,
} = require('../src/muhurat-confirm');
const { allocateBudget } = require('../src/muhurat');

test('confirm ledger starts timer and confirms after needSec', () => {
  const t0 = 1_000_000;
  let ledger = { date: '2026-11-09', mode: 'equity', names: {} };
  ledger = updateConfirmLedger(ledger, [{ ticker: 'SBIN', profitScore: 14 }], t0);
  assert.equal(isConfirmed(ledger, 'SBIN', t0, 180), false);
  assert.equal(confirmAgeSec(ledger, 'SBIN', t0 + 179_000), 179);
  assert.equal(isConfirmed(ledger, 'SBIN', t0 + 180_000, 180), true);
});

test('dropping out of top pool resets confirm streak', () => {
  const t0 = 1_000_000;
  let ledger = { date: '2026-11-09', mode: 'equity', names: {} };
  ledger = updateConfirmLedger(ledger, ['SBIN'], t0);
  ledger = updateConfirmLedger(ledger, ['NTPC'], t0 + 120_000);
  assert.equal(ledger.names.SBIN, undefined);
  ledger = updateConfirmLedger(ledger, ['SBIN'], t0 + 121_000);
  assert.equal(isConfirmed(ledger, 'SBIN', t0 + 121_000, 180), false);
});

test('seatWithConfirm only seats confirmed unless sticky', () => {
  const t0 = 1_000_000;
  let ledger = { date: '2026-11-09', mode: 'equity', names: {} };
  const pool = [
    { ticker: 'HOT', ltp: 100, profitScore: 20, verdict: 'BUY' },
    { ticker: 'OLD', ltp: 100, profitScore: 15, verdict: 'BUY' },
  ];
  ledger = updateConfirmLedger(ledger, pool, t0);
  ledger.names.OLD.since = t0 - 200_000; // already confirmed
  const { seated, confirming } = seatWithConfirm(pool, {
    nameCap: 2,
    deployable: 10000,
    ledger,
    stickyTickers: [],
    now: t0,
    needSec: 180,
  });
  assert.equal(seated.length, 1);
  assert.equal(seated[0].ticker, 'OLD');
  assert.ok(confirming.some((c) => c.ticker === 'HOT'));
});

test('allocateBudget with confirmSec 0 seats immediately', () => {
  const plan = allocateBudget(20000, [
    {
      ticker: 'A',
      ltp: 1000,
      verdict: 'BUY',
      score: 10,
      aboveOpen: true,
      sellT1: 1015,
      sellT2: 1025,
      sellStop: 990,
      levels: { target1: 1015, target2: 1025, stopLoss: 990 },
    },
  ], { confirmSec: 0, persistConfirm: false, mode: 'equity' });
  assert.equal(plan.pickCount, 1);
  assert.equal(plan.picks[0].orderReady, true);
});
