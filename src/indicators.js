'use strict';

// Indicator helpers matching TradingView Pine semantics:
// - ta.rma : Wilder smoothing, seeded with the SMA of the first `length` values
//            (Pine seeds ta.rma/ta.ema with sma when the previous value is na).
// - ta.ema : alpha = 2/(length+1), same SMA seeding.
// - pivots : a pivot at bar j is only *confirmed* `right` bars later, exactly
//            like ta.pivothigh / ta.pivotlow (the value is known at bar j+right).

function trueRanges(candles) {
  const out = new Array(candles.length);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) {
      out[i] = c.high - c.low;
    } else {
      const pc = candles[i - 1].close;
      out[i] = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    }
  }
  return out;
}

function smaSeed(values, i, length) {
  let s = 0;
  for (let k = i - length + 1; k <= i; k++) s += values[k];
  return s / length;
}

function rmaSeries(values, length) {
  const out = new Array(values.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    if (i === length - 1) {
      prev = smaSeed(values, i, length);
      out[i] = prev;
    } else if (i >= length) {
      prev = (prev * (length - 1) + values[i]) / length;
      out[i] = prev;
    }
  }
  return out;
}

function emaSeries(values, length) {
  const out = new Array(values.length).fill(NaN);
  const alpha = 2 / (length + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    if (i === length - 1) {
      prev = smaSeed(values, i, length);
      out[i] = prev;
    } else if (i >= length) {
      prev = alpha * values[i] + (1 - alpha) * prev;
      out[i] = prev;
    }
  }
  return out;
}

// Returns arrays resAt/supAt where resAt[i] is the resistance level *known at bar i*
// (latest confirmed pivot high), same for support. NaN until the first confirmation.
function pivotLevels(candles, left, right) {
  const n = candles.length;
  const resAt = new Array(n).fill(NaN);
  const supAt = new Array(n).fill(NaN);
  let res = NaN;
  let sup = NaN;
  for (let i = 0; i < n; i++) {
    const j = i - right; // pivot candidate whose confirmation lands on bar i
    if (j >= left) {
      let isHigh = true;
      let isLow = true;
      for (let k = j - left; k <= j + right; k++) {
        if (k === j) continue;
        if (candles[k].high >= candles[j].high) isHigh = false;
        if (candles[k].low <= candles[j].low) isLow = false;
      }
      if (isHigh) res = candles[j].high;
      if (isLow) sup = candles[j].low;
    }
    resAt[i] = res;
    supAt[i] = sup;
  }
  return { resAt, supAt };
}

module.exports = { trueRanges, rmaSeries, emaSeries, pivotLevels, rsiSeries, vwapSeries, dmiSeries };

// ta.rsi(close, length): Wilder's RSI — RMA of gains over RMA of |changes|.
function rsiSeries(closes, length) {
  const out = new Array(closes.length).fill(NaN);
  const gains = new Array(closes.length).fill(0);
  const losses = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    gains[i] = Math.max(ch, 0);
    losses[i] = Math.max(-ch, 0);
  }
  const avgGain = rmaSeries(gains, length);
  const avgLoss = rmaSeries(losses, length);
  for (let i = 0; i < closes.length; i++) {
    if (!Number.isFinite(avgGain[i]) || !Number.isFinite(avgLoss[i])) continue;
    if (avgLoss[i] === 0) {
      out[i] = avgGain[i] === 0 ? 50 : 100;
    } else {
      out[i] = 100 - 100 / (1 + avgGain[i] / avgLoss[i]);
    }
  }
  return out;
}

// ta.vwap(hlc3): session-anchored cumulative VWAP, reset each IST day.
// Falls back to the cumulative mean of hlc3 when volume is absent/zero.
function vwapSeries(candles) {
  const { istDateKey } = require('./time');
  const out = new Array(candles.length).fill(NaN);
  let day = null;
  let pv = 0;
  let v = 0;
  let phlc3 = 0;
  let n = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = istDateKey(c.t);
    if (d !== day) {
      day = d;
      pv = 0;
      v = 0;
      phlc3 = 0;
      n = 0;
    }
    const hlc3 = (c.high + c.low + c.close) / 3;
    const vol = Number.isFinite(c.volume) ? c.volume : 0;
    pv += hlc3 * vol;
    v += vol;
    phlc3 += hlc3;
    n += 1;
    out[i] = v > 0 ? pv / v : phlc3 / n;
  }
  return out;
}

// ta.dmi(diLen, adxLen): +DI, -DI and ADX with Wilder smoothing.
// Returns { plus, minus, adx } aligned with the input candles.
function dmiSeries(candles, diLen, adxLen) {
  const n = candles.length;
  const plus = new Array(n).fill(NaN);
  const minus = new Array(n).fill(NaN);
  const adx = new Array(n).fill(NaN);
  const tr = trueRanges(candles);
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const dn = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > dn && up > 0 ? up : 0;
    minusDM[i] = dn > up && dn > 0 ? dn : 0;
  }
  const atr = rmaSeries(tr, diLen);
  const sPlus = rmaSeries(plusDM, diLen);
  const sMinus = rmaSeries(minusDM, diLen);
  const dx = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(atr[i]) || atr[i] === 0) continue;
    plus[i] = (100 * sPlus[i]) / atr[i];
    minus[i] = (100 * sMinus[i]) / atr[i];
    const sum = plus[i] + minus[i];
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plus[i] - minus[i])) / sum;
  }
  const adxS = rmaSeries(dx.map((x) => (Number.isFinite(x) ? x : 0)), adxLen);
  for (let i = 0; i < n; i++) {
    // ADX is only valid once both smoothings have seeded.
    if (i >= diLen - 1 + adxLen - 1 && Number.isFinite(adxS[i])) adx[i] = adxS[i];
  }
  return { plus, minus, adx };
}
