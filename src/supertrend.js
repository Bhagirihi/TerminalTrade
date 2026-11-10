'use strict';

const { trueRanges, rmaSeries } = require('./indicators');

// Line-by-line port of the Supertrend block from the Pine v6 strategy
// "Nifty/BankNifty Multi-Index Strategy":
//
//   hl2 = (high + low) / 2
//   atr = ta.rma(ta.tr, 10)
//   basic_upper = hl2 + 3.0 * atr ; basic_lower = hl2 - 3.0 * atr
//   final_upper := (basic_upper < nz(final_upper[1]) or close[1] > nz(final_upper[1])) ? basic_upper : nz(final_upper[1])
//   final_lower := (basic_lower > nz(final_lower[1]) or close[1] < nz(final_lower[1])) ? basic_lower : nz(final_lower[1])
//   trend := close > nz(final_upper[1]) ? -1 : close < nz(final_lower[1]) ? 1 : nz(trend[1])
//   supertrend = trend == -1 ? final_lower : final_upper
//
// His convention: direction -1 = BULLISH, +1 = BEARISH.
// nz(x) in Pine turns na into 0; JS NaN comparisons are false, like Pine.
// The var bands start at 0.0 in Pine, so the previous-band values start at 0 here too.

function nz(x) {
  return Number.isNaN(x) ? 0 : x;
}

function supertrendSeries(candles, period = 10, multiplier = 3.0) {
  const trs = trueRanges(candles);
  const atr = rmaSeries(trs, period);
  const n = candles.length;

  const value = new Array(n).fill(NaN); // supertrend line value per bar
  const direction = new Array(n).fill(1); // -1 bullish / +1 bearish
  const flipped = new Array(n).fill(false);

  let finalUpperPrev = 0.0; // Pine: var float final_upper = 0.0
  let finalLowerPrev = 0.0; // Pine: var float final_lower = 0.0
  let trendPrev = NaN; // Pine: trend[1] is na on the first bar -> nz() = 0
  let dirPrev = NaN;

  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const closePrev = i > 0 ? candles[i - 1].close : NaN;
    const hl2 = (c.high + c.low) / 2;
    const basicUpper = hl2 + multiplier * atr[i];
    const basicLower = hl2 - multiplier * atr[i];

    const finalUpper =
      basicUpper < nz(finalUpperPrev) || closePrev > nz(finalUpperPrev)
        ? basicUpper
        : nz(finalUpperPrev);
    const finalLower =
      basicLower > nz(finalLowerPrev) || closePrev < nz(finalLowerPrev)
        ? basicLower
        : nz(finalLowerPrev);

    const trend =
      c.close > nz(finalUpperPrev) ? -1 : c.close < nz(finalLowerPrev) ? 1 : nz(trendPrev);

    direction[i] = trend;
    value[i] = trend === -1 ? finalLower : finalUpper;
    flipped[i] = i > 0 && direction[i] !== dirPrev;

    finalUpperPrev = finalUpper;
    finalLowerPrev = finalLower;
    trendPrev = trend;
    dirPrev = direction[i];
  }

  return { value, direction, flipped, atr };
}

module.exports = { supertrendSeries };
