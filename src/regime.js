'use strict';

// Section 4A — pattern recognition, rule-based for now.
//
// The screenshot plan's first AI step is an XGBoost model classifying the
// market regime (Trending / Sideways / High volatility / Low volatility).
// There is no labeled training data yet (8 live trades; historical premiums
// only exist if the probe's expired-option test passes), so no model is
// trained here. Instead this module:
//   1. labels the regime from rules on data that already exists (ADX + ATR),
//   2. exposes extractRegimeFeatures() — the exact feature vector an XGBoost
//      model would consume later, so the model can drop in without changing
//      callers.
//
// Trend axis: trending when ADX(14) >= 20 (the same bar muhurat2's train
// detection uses); sideways below it. Volatility axis: high when the ATR%
// sits at or above its own 20-bar median, low when below it. The two axes
// are independent — a market can be trending AND high-volatility.

const { dmiSeries, trueRanges, rmaSeries, rsiSeries, emaSeries, vwapSeries } = require('./indicators');

const DEFAULTS = {
  adxLen: 14,
  atrLen: 14,
  atrMedianLen: 20,
  trendAdx: 20,
  minBars: 40,
};

function median(values) {
  const xs = [...values].sort((a, b) => a - b);
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

// Feature vector for the regime classifier (rule-based now, XGBoost later).
// All features are plain numbers, aligned to the last bar of `candles`.
function extractRegimeFeatures(candles, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!Array.isArray(candles) || candles.length < o.minBars) return null;
  const closes = candles.map((c) => c.close);
  const dmi = dmiSeries(candles, o.adxLen, o.adxLen);
  const tr = trueRanges(candles);
  const atr = rmaSeries(tr, o.atrLen);
  const rsi = rsiSeries(closes, 14);
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const vwap = vwapSeries(candles);
  const i = candles.length - 1;
  const atrPct = atr.map((a, k) => (Number.isFinite(a) && closes[k] ? (100 * a) / closes[k] : NaN));
  const recent = atrPct.slice(-o.atrMedianLen).filter(Number.isFinite);
  const atrMedian = recent.length ? median(recent) : NaN;
  return {
    adx: dmi.adx[i],
    plusDi: dmi.plus[i],
    minusDi: dmi.minus[i],
    diDiff: Number.isFinite(dmi.plus[i]) && Number.isFinite(dmi.minus[i])
      ? dmi.plus[i] - dmi.minus[i] : NaN,
    atrPct: atrPct[i],
    atrMedian,
    atrPctVsMedian: Number.isFinite(atrPct[i]) && Number.isFinite(atrMedian) && atrMedian > 0
      ? atrPct[i] / atrMedian : NaN,
    rsi: rsi[i],
    emaSpreadPct: Number.isFinite(ema20[i]) && Number.isFinite(ema50[i]) && ema50[i]
      ? (100 * (ema20[i] - ema50[i])) / ema50[i] : NaN,
    vwapDistPct: Number.isFinite(vwap[i]) && vwap[i]
      ? (100 * (closes[i] - vwap[i])) / vwap[i] : NaN,
  };
}

// Rule-based regime label from the features above.
// Returns { evaluable, trend, vol, label, features, reason? }.
function classifyRegime(candles, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const features = extractRegimeFeatures(candles, o);
  if (!features || !Number.isFinite(features.adx) || !Number.isFinite(features.atrPctVsMedian)) {
    return {
      evaluable: false, trend: null, vol: null, label: null, features,
      reason: `need ${o.minBars} bars with seeded ADX/ATR, got ${Array.isArray(candles) ? candles.length : 0}`,
    };
  }
  const trend = features.adx >= o.trendAdx ? 'trending' : 'sideways';
  const vol = features.atrPctVsMedian >= 1 ? 'high' : 'low';
  const trendWord = trend === 'trending' ? 'Trending' : 'Sideways';
  const volWord = vol === 'high' ? 'High volatility' : 'Low volatility';
  return {
    evaluable: true, trend, vol,
    label: `${trendWord} · ${volWord}`,
    features,
  };
}

module.exports = { classifyRegime, extractRegimeFeatures, DEFAULTS };
