'use strict';

// Early session trigger. From 09:15 to 09:30 the 15-minute candle is still
// open, so the first closed 5-minute candle that closes with the trend already
// in force books the entry. After 09:30 the 15-minute rules take over, and a
// 5-minute candle that closed the other way leaves the entry to those rules.
// A 1-minute or 3-minute close is not used: one noisy minute would fire on
// almost every open.

const { istDateKey, istTimeStr, istToEpoch } = require('./time');

const EARLY_MINUTES = 5;

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function closedFastBars(minuteCandles, now) {
  const today = istDateKey(now);
  const open = istToEpoch(today, 9, 15);
  const cutoff = istToEpoch(today, 9, 30);
  const bars = (minuteCandles || [])
    .filter((c) => Number.isFinite(c.t) && c.t >= open && c.t < cutoff)
    .sort((a, b) => a.t - b.t);
  const out = [];
  for (let start = open; start < cutoff; start += EARLY_MINUTES * 60000) {
    const end = start + EARLY_MINUTES * 60000;
    if (now < end) break;
    const used = bars.filter((c) => c.t >= start && c.t < end);
    const hasLastMinute = used.some((c) => c.t >= end - 60000);
    if (!used.length || (!hasLastMinute && now < end + 120000)) break;
    out.push({ t: end, open: used[0].open, close: used[used.length - 1].close });
  }
  return out;
}

// side is the 15-minute trend from the last bar before today's 09:15 candle:
// 'LONG' (bullish Supertrend) or 'SHORT'.
function earlyTrigger(minuteCandles, side, now = Date.now()) {
  if (side !== 'LONG' && side !== 'SHORT') return null;
  for (const bar of closedFastBars(minuteCandles, now)) {
    const confirms = side === 'LONG' ? bar.close > bar.open : bar.close < bar.open;
    if (!confirms) continue;
    return {
      dateKey: istDateKey(now),
      t: bar.t,
      timeIST: istTimeStr(bar.t),
      price: round2(bar.close),
      side,
      reason: `${EARLY_MINUTES}-minute close confirms the open trend`,
    };
  }
  return null;
}

function priorSessionSide(closed, direction, now) {
  const open = istToEpoch(istDateKey(now), 9, 15);
  let side = null;
  for (let i = 0; i < closed.length; i++) {
    if (closed[i].t >= open) break;
    if (direction[i] < 0) side = 'LONG';
    else if (direction[i] > 0) side = 'SHORT';
  }
  return side;
}

module.exports = { earlyTrigger, priorSessionSide, EARLY_MINUTES };
