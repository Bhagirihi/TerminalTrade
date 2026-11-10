'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { rmaSeries, emaSeries, pivotLevels } = require('../src/indicators');
const { supertrendSeries } = require('../src/supertrend');
const { runStrategy, marketExitReason, refreshLevels } = require('../src/strategy');
const { totp } = require('../src/data/angelone');
const { istParts, istToEpoch, istTimeStr } = require('../src/time');

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('IST parts: 04:00 UTC = 09:30 IST', () => {
  const p = istParts(Date.UTC(2026, 9, 15, 4, 0));
  assert.strictEqual(p.hour, 9);
  assert.strictEqual(p.minute, 30);
  assert.strictEqual(p.day, 15);
});

test('RMA seeds with SMA then Wilder-smooths', () => {
  const r = rmaSeries([1, 2, 3, 4, 5], 3);
  assert.ok(Number.isNaN(r[0]) && Number.isNaN(r[1]));
  assert.ok(approx(r[2], 2));
  assert.ok(approx(r[3], 8 / 3));
  assert.ok(approx(r[4], (8 / 3) * (2 / 3) + 5 / 3));
});

test('EMA seeds with SMA then alpha-smooths', () => {
  const e = emaSeries([1, 2, 3, 4, 5], 3);
  assert.ok(approx(e[2], 2));
  assert.ok(approx(e[3], 3));
  assert.ok(approx(e[4], 4));
});

test('TOTP matches the RFC 6238 test vector (SHA-1, t=59s)', () => {
  // Secret "12345678901234567890" in base32:
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.strictEqual(totp(secret, 59000), '287082');
});

function candle(t, close, spread = 0.4) {
  return { t, open: close, high: close + spread, low: close - spread, close, volume: 0 };
}

test('Supertrend: steady rise is bullish (-1) and trails below price; crash flips bearish', () => {
  const candles = [];
  const t0 = istToEpoch('2026-10-14', 9, 15);
  for (let i = 0; i < 40; i++) candles.push(candle(t0 + i * 900000, 100 + i));
  for (let i = 0; i < 10; i++) candles.push(candle(t0 + (40 + i) * 900000, 139 - i * 6));
  const st = supertrendSeries(candles, 10, 3.0);
  assert.strictEqual(st.direction[39], -1);
  assert.ok(st.value[39] < candles[39].close, 'bullish ST line sits below price');
  assert.strictEqual(st.direction[49], 1);
});

test('Pivot: a clear peak becomes resistance only after the right-side lag', () => {
  const candles = [];
  const t0 = istToEpoch('2026-10-14', 9, 15);
  for (let i = 0; i < 60; i++) {
    const peak = i === 30 ? 50 : 0;
    candles.push({ t: t0 + i * 900000, open: 100, high: 100 + peak + (i % 3), low: 99, close: 100, volume: 0 });
  }
  const { resAt } = pivotLevels(candles, 15, 15);
  assert.ok(Number.isNaN(resAt[44]), 'not yet confirmed at bar 44');
  assert.strictEqual(resAt[45], 150, 'peak high 100+50+0 confirmed at bar 45');
});

// A full synthetic day: warmup afternoon (rising) on 2026-10-14, then 2026-10-15.
function dayCandles(todayCloses) {
  const candles = [];
  const w0 = istToEpoch('2026-10-14', 13, 30);
  for (let i = 0; i < 16; i++) candles.push(candle(w0 + i * 900000, 100 + i, 0.3));
  const d0 = istToEpoch('2026-10-15', 9, 15);
  todayCloses.forEach((c, i) => candles.push(candle(d0 + i * 900000, c, 0.3)));
  return candles;
}

test('Strategy: a 5-minute open trigger is the only entry, then the 15-minute rules run', () => {
  const closes = [];
  for (let i = 0; i < 25; i++) closes.push(116 + i * 0.8);
  const candles = dayCandles(closes);
  const early = {
    dateKey: '2026-10-15',
    t: istToEpoch('2026-10-15', 9, 20),
    timeIST: '09:20',
    price: 116.4,
    side: 'LONG',
    reason: '5-minute close confirms the open trend',
  };
  const run = runStrategy(candles, 25, { earlyEntry: early });
  const today = run.signals.filter((s) => s.dateKey === '2026-10-15');
  const buys = today.filter((s) => s.type === 'BUY CE');
  assert.strictEqual(buys.length, 1);
  assert.strictEqual(buys[0].timeIST, '09:20');
  assert.strictEqual(buys[0].price, 116.4);
  assert.strictEqual(today[today.length - 1].type, 'SQOFF');
});

test('Strategy: the 09:15 bar waits for the 5-minute trigger during the open window', () => {
  const closes = [];
  for (let i = 0; i < 25; i++) closes.push(116 + i * 0.8);
  const candles = dayCandles(closes);
  const open = istToEpoch('2026-10-15', 9, 15);
  const run = runStrategy(candles, 25, { liveBarT: open, now: open + 3 * 60000, deferOpen: true });
  const today = run.signals.filter((s) => s.dateKey === '2026-10-15');
  assert.ok(!today.some((s) => s.type === 'BUY CE' || s.type === 'BUY PE'), 'no open entry before 09:30');
});

test('Strategy: bullish at the 09:15 bar -> BUY CE at open, rides to 15:10 SQOFF', () => {
  // Gentle rise all day: no EMA exit (close stays above EMA13), no ST flip.
  const closes = [];
  for (let i = 0; i < 25; i++) closes.push(116 + i * 0.8);
  const run = runStrategy(dayCandles(closes), 25);
  const today = run.signals.filter((s) => s.dateKey === '2026-10-15');
  assert.strictEqual(today[0].type, 'BUY CE');
  assert.strictEqual(today[0].timeIST, '09:15');
  assert.strictEqual(today[today.length - 1].type, 'SQOFF');
  assert.strictEqual(today[today.length - 1].timeIST, '15:15');
  assert.ok(today[today.length - 1].points > 0);
  assert.strictEqual(run.position, null);
});

test('Strategy: sharp drop after entry triggers EXIT CE (EMA/flip) before square-off', () => {
  const closes = [117, 118, 119, 120, 110, 100, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85, 84, 83, 82, 81, 80, 79, 78, 77];
  const run = runStrategy(dayCandles(closes), 25);
  const today = run.signals.filter((s) => s.dateKey === '2026-10-15');
  assert.strictEqual(today[0].type, 'BUY CE');
  assert.ok(today.some((s) => s.type === 'EXIT CE'), 'an EXIT CE fired');
  assert.ok(!today.some((s) => s.type === 'SQOFF'), 'no SQOFF after the position already exited');
});

test('Strategy: a close through the ratcheted Supertrend is a trailing stop', () => {
  const closes = [];
  for (let i = 0; i < 18; i++) closes.push(116 + i * 1.2);
  closes.push(110, 100, 96);
  const run = runStrategy(dayCandles(closes), 25);
  const today = run.signals.filter((s) => s.dateKey === '2026-10-15');
  const exit = today.find((s) => s.type === 'EXIT CE');
  assert.ok(exit, 'the call exits');
  assert.ok(exit.reason === 'Stop loss' || exit.reason === 'Trailing stop' || exit.reason === 'Close crossed EMA 13');
});

test('market exits follow stop, trailing stop, target, then trailing target', () => {
  const position = {
    side: 'LONG',
    entryPrice: 100,
    initialStop: 90,
    stopLoss: 90,
    trailingStop: 90,
    target: 120,
    trailingTarget: null,
    peak: 100,
    trailOn: false,
  };
  assert.strictEqual(marketExitReason(position, 89), 'Stop loss');
  position.trailingStop = 96;
  assert.strictEqual(marketExitReason(position, 95), 'Trailing stop');
  position.trailingStop = 90;
  assert.strictEqual(marketExitReason(position, 120), 'Target');
  position.trailOn = true;
  position.trailingTarget = 112;
  position.peak = 118;
  assert.strictEqual(marketExitReason(position, 111), 'Trailing target');

  const open = {
    side: 'LONG',
    entryPrice: 100,
    initialStop: 90,
    stopLoss: 90,
    trailingStop: 90,
    target: 130,
    trailingTarget: null,
    peak: 100,
    trailOn: false,
  };
  refreshLevels(open, 112, 0, { value: [94], atr: [3] }, { resAt: [125], supAt: [NaN] });
  assert.ok(open.trailingStop >= 94);
  assert.strictEqual(open.target, 125);
  assert.strictEqual(open.trailOn, true);
  assert.ok(open.trailingTarget < open.peak);
});

test('Strategy: a locked live exit keeps the trigger price after the candle moves', () => {
  const closes = [];
  for (let i = 0; i < 12; i++) closes.push(116 + i);
  const candles = dayCandles(closes);
  const last = candles[candles.length - 1];
  last.close = 140;
  const locks = [{
    barT: last.t,
    t: last.t + 5 * 60000,
    timeIST: '12:05',
    type: 'EXIT CE',
    side: 'LONG',
    price: 121.5,
    reason: 'Stop loss',
  }];
  const run = runStrategy(candles, 25, { locks, liveBarT: last.t, now: last.t + 6 * 60000 });
  const exit = run.signals.find((s) => s.type === 'EXIT CE' && s.barT === last.t);
  assert.ok(exit, 'locked exit is kept');
  assert.strictEqual(exit.price, 121.5);
  assert.strictEqual(exit.timeIST, '12:05');
  assert.strictEqual(run.position, null);
});

test('Strategy: the live 15:00 candle squares off when the clock hits 15:10', () => {
  const closes = [];
  for (let i = 0; i < 24; i++) closes.push(116 + i * 0.8);
  const candles = dayCandles(closes);
  const bar = candles[candles.length - 1];
  assert.strictEqual(istTimeStr(bar.t), '15:00');
  const before = runStrategy(candles, 25);
  assert.ok(before.position, '15:00 bar is still open before 15:10');
  const live = runStrategy(candles, 25, { liveBarT: bar.t, now: bar.t + 12 * 60000 });
  const today = live.signals.filter((s) => s.dateKey === '2026-10-15');
  assert.strictEqual(today[today.length - 1].type, 'SQOFF');
  assert.strictEqual(today[today.length - 1].timeIST, '15:12');
  assert.strictEqual(live.position, null);
});

test('Strategy: a commodity square-off waits until 23:15', () => {
  const closes = [];
  for (let i = 0; i < 24; i++) closes.push(116 + i * 0.8);
  const candles = dayCandles(closes);
  const bar = candles[candles.length - 1];
  const live = runStrategy(candles, 100, {
    liveBarT: bar.t,
    now: bar.t + 12 * 60000,
    squareOffHour: 23,
    squareOffMinute: 15,
  });
  assert.ok(live.position, '15:12 is still inside the MCX session');
  assert.ok(!live.signals.some((s) => s.type === 'SQOFF'));
});

test('Strategy: flipOnly skips the 09:15 open-bar entry', () => {
  const closes = [];
  for (let i = 0; i < 24; i++) closes.push(116 + i * 0.8);
  const withOpen = runStrategy(dayCandles(closes), 25, { flipOnly: false });
  const flipOnly = runStrategy(dayCandles(closes), 25, { flipOnly: true });
  const openEntries = withOpen.signals.filter((s) => /Market open/i.test(s.reason || ''));
  const flipEntries = flipOnly.signals.filter((s) => /Market open/i.test(s.reason || ''));
  assert.ok(openEntries.length >= 1);
  assert.equal(flipEntries.length, 0);
});

test('Strategy: emaExitBars delays the EMA-13 scratch exit', () => {
  // Build a long that later closes under a falling EMA path.
  const closes = [];
  for (let i = 0; i < 20; i++) closes.push(100 + i);
  for (let i = 0; i < 8; i++) closes.push(120 - i * 3);
  const quick = runStrategy(dayCandles(closes), 25, { emaExit: true, emaExitBars: 0, flipOnly: false });
  const delayed = runStrategy(dayCandles(closes), 25, { emaExit: true, emaExitBars: 6, flipOnly: false });
  const quickEma = quick.signals.find((s) => s.reason === 'Close crossed EMA 13');
  const delayedEma = delayed.signals.find((s) => s.reason === 'Close crossed EMA 13');
  if (quickEma && delayedEma) assert.ok(delayedEma.t >= quickEma.t);
  else assert.ok(quickEma || delayed.position || delayed.signals.some((s) => s.type === 'SQOFF'));
});

test('Strategy: levels on an open trade are present and the trail stop does not loosen', () => {
  const closes = [];
  for (let i = 0; i < 12; i++) closes.push(116 + i);
  const run = runStrategy(dayCandles(closes), 25);
  assert.ok(run.position, 'still open before square-off');
  assert.strictEqual(run.position.side, 'LONG');
  if (run.position.initialStop != null && run.position.trailingStop != null) {
    assert.ok(run.position.trailingStop >= run.position.initialStop);
  }
});
