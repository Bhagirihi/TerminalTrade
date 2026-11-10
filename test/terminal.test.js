'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { renderDashboard } = require('../src/terminal');

function strip(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function sample() {
  return {
    status: 'live',
    source: 'UPSTOX',
    feed: 'upstox',
    updatedAt: '2026-10-15 10:45 IST',
    symbols: {
      NIFTY: {
        name: 'NIFTY 50',
        ltp: 25412.35,
        change: 42.1,
        changePct: 0.17,
        supertrend: 25380.2,
        direction: -1,
        ema13: 25401.1,
        resistance: 25450,
        support: 25320,
        lastCandleTimeIST: '10:30',
        dayPoints: 12.4,
        position: {
          side: 'LONG',
          label: 'BUY CE',
          strike: 25400,
          right: 'CE',
          premium: 142.5,
          stopLoss: 25380.2,
          target: 25450,
          qty: 25,
          openPoints: 8.2,
        },
        signalsToday: [
          { t: 1, timeIST: '09:15', type: 'BUY CE', strike: 25400, right: 'CE', premium: 129.8, stopLoss: 25380.2, target: 25450, reason: 'Supertrend flip to bullish' },
        ],
        chart: [
          { close: 25380, st: 25340, dir: -1, ema: 25370 },
          { close: 25400, st: 25360, dir: -1, ema: 25385 },
          { close: 25412, st: 25380, dir: -1, ema: 25401 },
        ],
      },
      BANKNIFTY: {
        name: 'BANKNIFTY',
        ltp: 55410,
        change: -80,
        changePct: -0.14,
        supertrend: 55600,
        direction: 1,
        ema13: 55510,
        resistance: 55800,
        support: 55200,
        lastCandleTimeIST: '10:30',
        dayPoints: -10.5,
        position: null,
        signalsToday: [],
        chart: [
          { close: 55500, st: 55620, dir: 1, ema: 55540 },
          { close: 55410, st: 55600, dir: 1, ema: 55510 },
        ],
      },
    },
    portfolio: { investment: 250000, pnl: -1540.5, holdings: 3, positions: 1, error: null },
    paper: {
      total: 1255,
      trades: [
        {
          index: 'NIFTY 50',
          strike: 25400,
          right: 'CE',
          entryTime: '09:15',
          entryPremium: 129.8,
          qty: 65,
          status: 'OPEN',
          markPremium: 180,
          premiumPoints: 50.2,
          pnl: 1255,
        },
      ],
    },
  };
}

test('terminal dashboard fits the screen and shows the live book', () => {
  for (const [width, height] of [[79, 24], [79, 40], [119, 32], [140, 50]]) {
    const frame = renderDashboard(sample(), { width, height, url: 'http://localhost:3000', log: 'live' });
    const lines = frame.split('\n');
    assert.strictEqual(lines.length, height, `height ${height}`);
    for (const line of lines) assert.ok(strip(line).length <= width, strip(line));
  }

  const text = strip(renderDashboard(sample(), { width: 120, height: 46, url: 'http://localhost:3000' }));
  assert.match(text, /NIFTY 50/);
  assert.match(text, /BANKNIFTY/);
  assert.match(text, /25,412\.35/);
  assert.match(text, /BULLISH/);
  assert.match(text, /BEARISH/);
  assert.match(text, /BUY CE/);
  assert.match(text, /Strike/);
  assert.match(text, /25,400/);
  assert.match(text, /Support/);
  assert.match(text, /25,320\.00/);
  assert.match(text, /Resistance/);
  assert.match(text, /25,450\.00/);
  assert.match(text, /55,400/);
  assert.match(text, /55,200\.00/);
  assert.match(text, /55,800\.00/);
  assert.match(text, /No open position/);
  assert.match(text, /Upstox portfolio/);
  assert.match(text, /Investment 2,50,000\.00/);
  assert.match(text, /P&L -1,540\.50/);
  assert.match(text, /Paper trades/);
  assert.match(text, /Qty/);
  assert.match(text, /Invested/);
  assert.match(text, /8,437\.00/);
  assert.match(text, /\+1,255\.00/);
  assert.match(text, /Today's signals/);
  assert.match(text, /Supertrend flip to bullish/);
  assert.match(text, /UPSTOX — REALTIME/);
  assert.match(text, /q quit/);
});

test('terminal card explains a waiting pullback in plain words', () => {
  const state = sample();
  state.ceStrategy = {
    NIFTY: {
      emaFast: 22648.81,
      emaPB: 22676.06,
      emaTrend: 22710.2,
      rsi: 42.35,
      adx: 21.41,
      dayPoints: 0,
      position: null,
      debug: {
        setup: 'WAIT',
        risk: 'BLOCK',
        entry: 'PASS',
        tradesToday: 0,
        maxTradesDay: 3,
        dailyLocked: false,
        block: 'EMA50 is not rising under price',
      },
    },
  };
  const text = strip(renderDashboard(state, { width: 120, height: 60, url: 'http://localhost:3000' }));
  assert.match(text, /V1 {2}Supertrend/);
  assert.match(text, /V2 {2}Pullback/);
  assert.match(text, /Not a trade\. EMA 50 is not rising under price\./);
  assert.match(text, /0 of 3 trades today/);
  assert.doesNotMatch(text, /Risk BLOCK/);
  assert.doesNotMatch(text, /Setup WAIT/);
});

test('terminal dashboard shows an empty day and an engine error', () => {
  const empty = strip(renderDashboard({ status: 'starting', symbols: {} }, { width: 80, height: 20 }));
  assert.match(empty, /connecting…/);
  assert.match(empty, /No paper trades yet today/);
  assert.match(empty, /No signals yet today/);

  const failed = strip(renderDashboard({ status: 'error', error: 'token expired', symbols: {} }, { width: 80, height: 16 }));
  assert.match(failed, /ERROR: token expired/);
});
