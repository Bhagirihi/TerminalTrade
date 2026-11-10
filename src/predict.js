'use strict';

// Opening read. From 09:15 IST the first 1, 3 and 5 minutes each build a
// high/low from the 1-minute candles. Once a window has closed, the live
// price is above it (call), below it (put), or still inside it. The longest
// closed window is the prediction. This does not book a paper trade.

const { istDateKey, istToEpoch } = require('./time');

const WINDOWS = [1, 3, 5];

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function openingRead(minuteCandles, price, now = Date.now()) {
  const today = istDateKey(now);
  const open = istToEpoch(today, 9, 15);
  const sessionEnd = open + 6 * 60 * 60000;
  const bars = (minuteCandles || []).filter((c) => Number.isFinite(c.t) && c.t >= open && c.t < sessionEnd);

  const windows = WINDOWS.map((minutes) => {
    const end = open + minutes * 60000;
    const used = bars.filter((c) => c.t >= open && c.t < end);
    const closedBar = used.some((c) => c.t >= end - 60000);
    const ready = now >= end && used.length > 0 && (closedBar || now >= end + 120000);
    if (!ready) return { minutes, ready: false, high: null, low: null, bias: null };
    const high = Math.max(...used.map((c) => c.high));
    const low = Math.min(...used.map((c) => c.low));
    let bias = 'INSIDE';
    if (Number.isFinite(price) && price > high) bias = 'CALL';
    else if (Number.isFinite(price) && price < low) bias = 'PUT';
    return { minutes, ready: true, high: round2(high), low: round2(low), bias };
  });

  const ready = windows.filter((w) => w.ready);
  const primary = ready.length ? ready[ready.length - 1] : null;
  const agree = primary ? ready.filter((w) => w.bias === primary.bias).length : 0;

  let label = now < open ? 'Before open' : 'Waiting';
  let side = null;
  if (primary && primary.bias === 'CALL') {
    label = 'Bullish';
    side = 'CALL';
  } else if (primary && primary.bias === 'PUT') {
    label = 'Bearish';
    side = 'PUT';
  } else if (primary) {
    label = 'Inside';
  }

  return {
    label,
    side,
    minutes: primary ? primary.minutes : null,
    agree,
    ready: ready.length,
    windows,
  };
}

module.exports = { openingRead, WINDOWS };
