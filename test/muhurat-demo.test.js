'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDemoState, demoChecks } = require('../src/muhurat-demo');

test('demoChecks all pass', () => {
  const report = demoChecks();
  assert.equal(report.ok, true);
  assert.ok(report.checks.some((c) => c.id === 'NO_TRADE_LOSS'));
});

test('live demo state has BUY picks and bot positions', () => {
  const state = buildDemoState('live');
  assert.equal(state.book.demo, true);
  assert.ok(state.book.liveBuys.length >= 3);
  assert.equal(state.book.liveBuys[0].verdict, 'BUY');
  assert.equal(state.bot.live, true);
  assert.ok(state.bot.openCount > 0);
  assert.equal(state.book.lossGate.blocked, false);
  assert.ok(state.book.portfolio.investment > 0);
  assert.ok(Number.isFinite(state.book.portfolio.pnl));
});

test('blocked demo state clears buys and sets DO NOT TRADE', () => {
  const state = buildDemoState('blocked');
  assert.equal(state.book.lossGate.blocked, true);
  assert.equal(state.book.liveBuys.length, 0);
  assert.match(state.bot.lastError, /DO NOT TRADE/);
});
