'use strict';

// Tests for tools/muhurat-history-stats.js (live-ledger win rate + P&L ratio).
// No network, no real ledger: synthetic day docs in the live shape.

const assert = require('node:assert');
const { test } = require('node:test');
const { computeHistoryStats } = require('../tools/muhurat-history-stats');
const { optionsRoundTripCost } = require('../src/muhurat-backtest');

function dayDoc(date, trades) {
  return {
    date,
    updatedAt: `${date}T10:00:00.000Z`,
    investment: trades.reduce((s, t) => s + (t.spend || 0), 0),
    realizedPnl: trades.filter((t) => t.status === 'CLOSED').reduce((s, t) => s + (t.pnl || 0), 0),
    openInvestment: 0,
    trades,
    byMode: { equity: {}, options: {} },
  };
}

function trade(ticker, mode, qty, entry, exit, exitReason, status = 'CLOSED') {
  const pnl = status === 'CLOSED' ? Math.round((exit - entry) * qty * 100) / 100 : 0;
  return {
    ticker, mode, key: `NSE_EQ|${ticker}`, qty, entry, exit,
    spend: Math.round(entry * qty * 100) / 100,
    pnl, exitReason, status,
    buyAt: '2026-11-17T04:00:00.000Z',
    sellAt: status === 'CLOSED' ? '2026-11-17T05:00:00.000Z' : null,
    right: null,
  };
}

test('options costs match the published stack (hand-computed)', () => {
  // Buy 65 @ 103.25 (premium 6711.25), sell 65 @ 97.25 (premium 6321.25).
  const c = optionsRoundTripCost(6711.25, 6321.25);
  assert.strictEqual(c.brokerage, 40); // flat Rs 20 per order x2
  assert.strictEqual(c.stt, 9.48); // 0.15% of sell premium
  assert.strictEqual(c.txn, 2.25); // 0.03553% of sell premium
  assert.strictEqual(c.sebi, 0.01); // Rs 10/crore of sell premium
  assert.strictEqual(c.stamp, 0.2); // 0.003% of buy premium
  assert.strictEqual(c.gst, 7.61); // 18% of (40 + 2.25 + 0.01)
  assert.strictEqual(c.total, 59.55);
});

test('win rate + profit factor from synthetic ledger days', () => {
  const docs = [
    dayDoc('2026-11-17', [
      trade('NIFTY CE', 'options', 65, 100, 125, 'T2'),
      trade('BANKNIFTY CE', 'options', 30, 200, 210, 'T2'),
    ]),
    dayDoc('2026-11-19', [
      trade('NIFTY PE', 'options', 65, 103.25, 97.25, 'SL'),
    ]),
    dayDoc('2026-11-20', [
      trade('SBIN', 'equity', 29, 1000, 999, 'SL'),
      trade('NIFTY PE', 'options', 65, 444.2, 421.2, 'SL'),
      trade('BANKNIFTY PE', 'options', 15, 300, 280, '15:15'),
    ]),
    dayDoc('2026-11-23', [
      trade('BANKNIFTY PE', 'options', 15, 444.2, 421.2, 'SL'),
      trade('NIFTY PE', 'options', 65, 103.25, 97.25, 'SL'),
      trade('COFORGE', 'equity', 7, 2141.1, null, null, 'OPEN'),
    ]),
  ];
  const r = computeHistoryStats(docs);
  // Closed trades: 2 wins (Nov 17) + 6 losses = 8. Win rate 25% on net.
  assert.strictEqual(r.summary.trades, 8);
  assert.strictEqual(r.summary.wins, 2);
  assert.strictEqual(r.summary.losses, 6);
  assert.strictEqual(r.summary.winRate, 25);
  // Gross wins 1625 + 300 = 1925; gross losses 390 + 29 + 1495 + 300 + 345 + 390.
  assert.strictEqual(r.summary.grossPnl, 1925 - 2949);
  assert.ok(r.summary.charges > 0, 'charges applied to every trade');
  assert.ok(r.summary.profitFactorNet < 1, 'losing run has PF < 1');
  // Avg win (~900) beats avg loss (~540) here — the run still loses because
  // losses outnumber wins 3:1. Win rate alone would hide that; PF shows it.
  assert.ok(r.summary.riskRewardNet > 1, 'avg win bigger than avg loss here');
  // Per-mode split.
  assert.strictEqual(r.byMode.options.trades, 7);
  assert.strictEqual(r.byMode.equity.trades, 1);
  // Open position is reported, not counted as a trade.
  assert.strictEqual(r.openPositions.length, 1);
  assert.strictEqual(r.openPositions[0].ticker, 'COFORGE');
  assert.strictEqual(r.days.length, 4);
});

test('empty history → zero trades, null rates (not a crash, not a fake 0%)', () => {
  const r = computeHistoryStats([]);
  assert.strictEqual(r.summary.trades, 0);
  assert.strictEqual(r.summary.winRate, null);
  assert.strictEqual(r.summary.profitFactorNet, null);
});
