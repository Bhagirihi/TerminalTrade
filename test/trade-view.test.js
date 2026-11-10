'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderTrade } = require('../src/trade-view');

function strip(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function sample() {
  return {
    status: 'live',
    source: 'UPSTOX',
    feed: 'upstox',
    updatedAt: '2026-10-25 10:54 IST',
    portfolio: {
      investment: 387448.34,
      pnl: -64796.33,
      holdings: 2,
      positions: 0,
      live: true,
      cards: [
        { ticker: 'SWIGGY', qty: 38, last: 176, pnl: -8132, pnlPct: -54.87, sma50: 210, rsi: 32.4, aboveSma: false },
        { ticker: 'RELIANCE', qty: 10, last: 1190, pnl: 319, pnlPct: 2.75, sma50: 1100, rsi: 48.2, aboveSma: true },
      ],
    },
    symbols: {
      NIFTY: {
        name: 'NIFTY 50',
        ltp: 25412.35,
        change: 85.2,
        changePct: 0.34,
        direction: -1,
        lotSize: 65,
        position: { side: 'LONG', label: 'BUY CE', strike: 25400, qty: 65, target: 25500, stopLoss: 25300 },
        signalsToday: [{ t: 1, timeIST: '09:30', type: 'BUY CE', strike: 25400, reason: 'Supertrend flip to bullish' }],
      },
      BANKNIFTY: { name: 'BANKNIFTY', ltp: 55400, change: -40, changePct: -0.07, direction: 1, signalsToday: [] },
    },
    ceStrategy: {},
    paper: {
      total: 1255,
      trades: [{ index: 'NIFTY 50', strategy: 'Supertrend', entryAt: '25 Oct 09:30', status: 'OPEN', pnl: 1255 }],
    },
  };
}

test('trade view shows portfolio, both indexes, signals, paper, and Gemini', () => {
  const text = strip(renderTrade(sample(), {
    width: 120,
    height: 70,
    gemini: {
      text: 'Summary: The loss sits in a few names.\nRisk: Do not add to those names.\nAvoid making new investments without a clear understanding of the underlying fundamentals and technical indicators.',
      at: Date.parse('2026-10-25T05:00:00Z'),
    },
  }));
  assert.match(text, /P&L/);
  assert.match(text, /16\.72%/);
  assert.match(text, /HOLD/);
  assert.match(text, /SELL/);
  assert.match(text, /NEW BUY/);
  assert.match(text, /SWIGGY/);
  assert.match(text, /RELIANCE/);
  assert.match(text, /NIFTY 50/);
  assert.match(text, /25,412\.35/);
  assert.match(text, /BANKNIFTY/);
  assert.match(text, /55,400\.00/);
  assert.match(text, /Target/);
  assert.match(text, /Profit/);
  assert.match(text, /Loss/);
  assert.match(text, /BULLISH/);
  assert.match(text, /BEARISH/);
  assert.match(text, /Signals/);
  assert.match(text, /BUY CE/);
  assert.match(text, /Paper trades/);
  assert.match(text, /OPEN/);
  assert.match(text, /Gemini/);
  assert.match(text, /Technicals/);
  assert.match(text, /1 of 2 names are under their own 50-day average/);
  assert.match(text, /No name has RSI above 75/);
  assert.match(text, /under 50-day/);
  assert.doesNotMatch(text, /clear understanding of the underlying fundamentals/);
  assert.match(text, /UPSTOX — REALTIME/);
  assert.match(text, /MegaBull paper/);
  assert.match(text, /MEGABULL_API_KEY/);
  assert.match(text, /q quit/);
  for (const line of text.split('\n')) assert.ok(line.length <= 120, line);
});

test('trade view stays inside a short terminal', () => {
  const text = strip(renderTrade(sample(), { width: 80, height: 24, gemini: { text: 'Summary: Saved note.', at: Date.now() } }));
  const lines = text.split('\n');
  assert.equal(lines.length, 24);
  for (const line of lines) assert.ok(line.length <= 80);
  assert.match(text, /NIFTY 50/);
  assert.match(text, /q quit/);
});

test('trade view shows the paper plan pools', () => {
  const state = sample();
  state.paperPlan = {
    sellTotal: 6688,
    newBuyCash: 265963.54,
    newBuyCashStart: 315963.54,
    indexPool: 0,
    commodityPool: 0,
    total: -1200,
    squareOffSaved: true,
    trades: [
      { index: 'NIFTY 50', strategy: 'Paper plan', entryAt: 'Fri 23 Oct', status: 'OPEN', pnl: -200, stake: 50000 },
      { index: 'SWIGGY', strategy: 'SELL', entryAt: 'sold', status: 'SOLD', pnl: -8132 },
    ],
  };
  const text = strip(renderTrade(state, { width: 120, height: 90 }));
  assert.match(text, /NEW BUY cash left/);
  assert.match(text, /Index left/);
  assert.match(text, /Commodity CRUDE left/);
  assert.match(text, /pnl-.*\.json|Square-off P&L JSON/);
});

test('trade view shows crude, gold, and silver', () => {
  const state = sample();
  state.symbols.CRUDE = { name: 'CRUDE', contract: '19 Nov 26', ltp: 5420, change: 12, changePct: 0.22, direction: -1 };
  state.symbols.GOLD = { name: 'GOLD', contract: '4 Dec 26', ltp: 78000, change: -100, changePct: -0.13, direction: 1 };
  state.symbols.BANKNIFTY.lastSession = 'Fri 23 Oct';
  state.symbols.BANKNIFTY.lotSize = 30;
  state.symbols.BANKNIFTY.supertrend = 55600;
  state.symbols.BANKNIFTY.support = 54800;
  state.symbols.SILVER = { name: 'SILVER', contract: '4 Dec 26', ltp: 92000, change: 50, changePct: 0.05, direction: -1 };
  const text = strip(renderTrade(state, { width: 120, height: 90 }));
  assert.match(text, /CRUDE/);
  assert.match(text, /GOLD/);
  assert.match(text, /SILVER/);
  assert.match(text, /5,420\.00/);
  assert.match(text, /19 Nov 26/);
  assert.match(text, /Fri 23 Oct/);
  assert.match(text, /BUY PE/);
  for (const line of text.split('\n')) assert.ok(line.length <= 120, line);
});
