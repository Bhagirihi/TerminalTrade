'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { liveEnabled, CONFIRM, createMuhuratBot, portfolioLossGate } = require('../src/muhurat-bot');

test('liveEnabled requires live + confirm + BUY approval', () => {
  const prevLive = process.env.MUHURAT_LIVE;
  const prevConfirm = process.env.MUHURAT_LIVE_CONFIRM;
  const prevBuy = process.env.MUHURAT_BUY_APPROVED;
  process.env.MUHURAT_LIVE = 'true';
  process.env.MUHURAT_LIVE_CONFIRM = CONFIRM;
  process.env.MUHURAT_BUY_APPROVED = 'NO';
  assert.equal(liveEnabled(), false);
  process.env.MUHURAT_BUY_APPROVED = 'YES';
  assert.equal(liveEnabled(), true);
  process.env.MUHURAT_LIVE = 'false';
  assert.equal(liveEnabled(), false);
  if (prevLive == null) delete process.env.MUHURAT_LIVE;
  else process.env.MUHURAT_LIVE = prevLive;
  if (prevConfirm == null) delete process.env.MUHURAT_LIVE_CONFIRM;
  else process.env.MUHURAT_LIVE_CONFIRM = prevConfirm;
  if (prevBuy == null) delete process.env.MUHURAT_BUY_APPROVED;
  else process.env.MUHURAT_BUY_APPROVED = prevBuy;
});

test('createMuhuratBot returns null when live flags off', () => {
  const prevLive = process.env.MUHURAT_LIVE;
  process.env.MUHURAT_LIVE = 'false';
  assert.equal(createMuhuratBot({}), null);
  if (prevLive == null) delete process.env.MUHURAT_LIVE;
  else process.env.MUHURAT_LIVE = prevLive;
});

test('portfolioLossGate blocks near 20% book loss', () => {
  const prev = process.env.MUHURAT_NO_TRADE_LOSS_PCT;
  process.env.MUHURAT_NO_TRADE_LOSS_PCT = '18';
  const ok = portfolioLossGate({ portfolio: { investment: 100000, pnl: -10000 } });
  assert.equal(ok.blocked, false);
  assert.equal(ok.pnlPct, -10);
  const near = portfolioLossGate({ portfolio: { investment: 100000, pnl: -18500 } });
  assert.equal(near.blocked, true);
  assert.match(near.reason, /DO NOT TRADE/);
  const empty = portfolioLossGate({});
  assert.equal(empty.blocked, false);
  if (prev == null) delete process.env.MUHURAT_NO_TRADE_LOSS_PCT;
  else process.env.MUHURAT_NO_TRADE_LOSS_PCT = prev;
});
