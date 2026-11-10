'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { runCeSignals } = require('../src/strategy-ce');

// IST clock: bar starts as epoch ms. All generators below produce strictly
// increasing timestamps, mirroring what engine.candlesNow hands the strategy.
function t(h, m) {
  return Date.UTC(2026, 9, 21, h - 5, m - 30);
}

function bar(tt, o, c, extra = {}) {
  return {
    t: tt,
    open: o,
    high: Math.max(o, c) + (extra.highPad ?? 2),
    low: Math.min(o, c) - (extra.lowPad ?? 2),
    close: c,
    volume: extra.volume ?? 1000,
  };
}

// 100 bars of gentle uptrend for indicator seeding, then a 3-bar pullback
// that tags EMA20, then one strong reclaim bar. The reclaim lands at
// start + 103 bars; pick startH/startM so the action falls in the session.
function setupCandles(startH = 6, startM = 0, reclaimMove = 22) {
  const candles = [];
  let px = 25000;
  for (let i = 0; i < 100; i++) {
    const tt = t(startH, startM) + i * 5 * 60000;
    const o = px;
    const c = o + 1.2 + ((i % 3) - 1) * 1.5;
    candles.push(bar(tt, o, c));
    px = c;
  }
  for (let i = 0; i < 3; i++) {
    const tt = t(startH, startM) + (100 + i) * 5 * 60000;
    const o = px;
    const c = o - 6;
    candles.push(bar(tt, o, c, { volume: 1500 }));
    px = c;
  }
  const rt = t(startH, startM) + 103 * 5 * 60000;
  const ro = px;
  const rc = ro + reclaimMove;
  candles.push(bar(rt, ro, rc, { volume: 2000 }));
  return candles;
}

function runLive(candles) {
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  const last = sorted[sorted.length - 1].t;
  return runCeSignals(sorted, { liveBarT: last, now: last });
}

function buysOf(run) {
  return run.signals.filter((s) => s.type === 'BUY CE');
}

test('ce: a full setup fires BUY CE with stop = max(swing, 1.5 ATR) and 1.8R target', () => {
  const candles = setupCandles(); // reclaim at 14:35 IST, in session
  const run = runLive(candles);
  const buys = buysOf(run);
  assert.strictEqual(buys.length, 1);
  const e = buys[0];
  assert.strictEqual(e.side, 'LONG');
  assert.strictEqual(e.qty, 65);
  assert.ok(e.stopLoss < e.price);
  assert.ok(Math.abs(e.target - e.price - 1.8 * (e.price - e.stopLoss)) < 0.01);
  assert.strictEqual(run.position.side, 'LONG');
  assert.strictEqual(run.position.entryPrice, e.price);
});

test('ce: a close below the stop exits with reason Stop and negative points', () => {
  const candles = setupCandles();
  const entry = buysOf(runLive(candles))[0];
  const tt = candles[candles.length - 1].t + 5 * 60000;
  candles.push(bar(tt, entry.price, entry.stopLoss - 10));
  const run = runLive(candles);
  const exit = run.signals.find((s) => s.type === 'EXIT CE');
  assert.ok(exit);
  assert.strictEqual(exit.reason, 'Stop');
  assert.ok(exit.points < 0);
  assert.strictEqual(run.position, null);
});

test('ce: a close above the target exits with reason Target', () => {
  const candles = setupCandles();
  const entry = buysOf(runLive(candles))[0];
  const tt = candles[candles.length - 1].t + 5 * 60000;
  candles.push(bar(tt, entry.price, entry.target + 5));
  const run = runLive(candles);
  const exit = run.signals.find((s) => s.type === 'EXIT CE');
  assert.ok(exit);
  assert.strictEqual(exit.reason, 'Target');
  // Exits fill on the bar close (the documented close convention), here target + 5.
  assert.ok(Math.abs(exit.points - (entry.target + 5 - entry.price)) < 0.01);
});

test('ce: at most 3 entries per day', () => {
  // useSession:false isolates the daily cap (the session gate has its own test):
  // 4 full setup cycles need more bars than the 09:20-14:40 window holds.
  const opts = { useSession: false };
  const runLiveNoSession = (candles) => {
    const sorted = [...candles].sort((a, b) => a.t - b.t);
    const last = sorted[sorted.length - 1].t;
    return runCeSignals(sorted, { liveBarT: last, now: last, ...opts });
  };
  let candles = setupCandles(2, 0);
  for (let k = 0; k < 5; k++) {
    const run = runLiveNoSession(candles);
    const buys = buysOf(run);
    assert.ok(buys.length <= 3, `cycle ${k}: capped at 3`);
    let tt = candles[candles.length - 1].t;
    const entry = buys.pop();
    tt += 5 * 60000;
    // small stop exit keeps the price zone stable so the pattern repeats
    if (entry && buys.length < 3) candles.push(bar(tt, entry.price, entry.stopLoss - 5));
    // 10 gentle recovery bars restore the EMA9 > EMA20 gap after the stop bar
    for (let s = 0; s < 10; s++) {
      tt += 5 * 60000;
      const o = candles[candles.length - 1].close;
      candles.push(bar(tt, o, o + 2));
    }
    // fresh pullback + reclaim for the next cycle
    for (let s = 0; s < 3; s++) {
      tt += 5 * 60000;
      const o = candles[candles.length - 1].close;
      candles.push(bar(tt, o, o - 6, { volume: 1500 }));
    }
    tt += 5 * 60000;
    const o = candles[candles.length - 1].close;
    candles.push(bar(tt, o, o + 22, { volume: 2000 }));
  }
  const run = runLiveNoSession(candles);
  assert.strictEqual(buysOf(run).length, 3);
});

test('ce: no entries outside the 09:20-14:40 session (setup marker only)', () => {
  const candles = setupCandles(0, 30); // reclaim at 09:05 IST, before the session
  const run = runLive(candles);
  assert.strictEqual(buysOf(run).length, 0);
  assert.strictEqual(run.debug.setup, 'PASS');
  assert.strictEqual(run.debug.entry, 'BLOCK');
  assert.strictEqual(run.signals.filter((s) => s.type === 'SETUP').length, 1);
});

test('ce: an open position is flattened in the 15:10-15:25 window', () => {
  const candles = setupCandles(); // reclaim at 14:35 IST
  let tt = candles[candles.length - 1].t;
  for (let m = 0; m < 6; m++) {
    // drift sideways toward 15:10 without hitting stop/target
    tt += 5 * 60000;
    const o = candles[candles.length - 1].close;
    candles.push(bar(tt, o, o + 1));
  }
  // force the last bar into the flat window
  const last = candles[candles.length - 1];
  candles[candles.length - 1] = { ...last, t: t(15, 10) };
  const run = runLive(candles);
  const sqoff = run.signals.find((s) => s.type === 'SQOFF');
  assert.ok(sqoff);
  assert.strictEqual(sqoff.reason, 'End of day');
  assert.strictEqual(run.position, null);
});

test('ce: cooldown blocks re-entry within 3 bars of an exit', () => {
  const candles = setupCandles(5, 0); // reclaim at 13:35 IST; whole sequence fits in session
  const entry = buysOf(runLive(candles))[0];
  let tt = candles[candles.length - 1].t + 5 * 60000;
  candles.push(bar(tt, entry.price, entry.stopLoss - 5)); // small stop exit keeps RSI cool
  // immediate fresh setup 1 bar later — should be blocked by cooldown
  tt += 5 * 60000;
  let o = candles[candles.length - 1].close;
  candles.push(bar(tt, o, o + 22, { volume: 2000 }));
  let run = runLive(candles);
  assert.strictEqual(buysOf(run).length, 1);
  assert.strictEqual(run.signals.filter((s) => s.type === 'SETUP').length, 1);
  // 3 pullback bars, then a fresh reclaim 5 bars after the exit — cooldown done
  for (let s = 0; s < 3; s++) {
    tt += 5 * 60000;
    o = candles[candles.length - 1].close;
    candles.push(bar(tt, o, o - 6, { volume: 1500 }));
  }
  tt += 5 * 60000;
  o = candles[candles.length - 1].close;
  candles.push(bar(tt, o, o + 22, { volume: 2000 }));
  run = runLive(candles);
  assert.strictEqual(buysOf(run).length, 2);
});

test('ce: a lock on the live bar keeps the first break', () => {
  const candles = setupCandles();
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  const last = sorted[sorted.length - 1];
  const lockPrice = last.close + 40; // worse fill than the current close
  const run = runCeSignals(sorted, {
    liveBarT: last.t,
    now: last.t,
    locks: [
      {
        barT: last.t,
        t: last.t,
        timeIST: '14:35',
        type: 'BUY CE',
        side: 'LONG',
        price: lockPrice,
        reason: 'Bullish CE signal (EMA/VWAP/RSI/ADX pullback)',
        stopLoss: lockPrice - 20,
        target: lockPrice + 36,
      },
    ],
  });
  const buy = buysOf(run)[0];
  assert.ok(buy);
  assert.strictEqual(buy.price, lockPrice);
  assert.strictEqual(buy.stopLoss, lockPrice - 20);
  assert.strictEqual(run.position.activeStop, lockPrice - 20);
});

test('ce: the live entry bar stops out once price leaves the fill', () => {
  const candles = setupCandles();
  const first = runLive(candles);
  const buy = buysOf(first)[0];
  const last = candles[candles.length - 1];
  last.close = buy.stopLoss - 5;
  last.low = last.close - 1;
  const run = runCeSignals(candles, {
    liveBarT: last.t,
    now: buy.t + 60000,
    locks: [
      {
        barT: last.t,
        t: buy.t,
        timeIST: buy.timeIST,
        type: 'BUY CE',
        side: 'LONG',
        price: buy.price,
        reason: buy.reason,
        stopLoss: buy.stopLoss,
        target: buy.target,
      },
    ],
  });
  const exit = run.signals.find((s) => s.type === 'EXIT CE');
  assert.ok(exit, 'same-bar stop fires');
  assert.strictEqual(exit.reason, 'Stop');
  assert.strictEqual(run.position, null);
});

test('ce: the live block reason names the failed check', () => {
  const candles = setupCandles();
  const last = candles[candles.length - 1];
  last.close = last.open - 30;
  last.low = last.close - 2;
  const run = runCeSignals(candles, { liveBarT: last.t, now: last.t + 60000 });
  assert.strictEqual(run.debug.setup, 'WAIT');
  assert.ok(run.debug.block, 'a blocked live bar says why');
});
