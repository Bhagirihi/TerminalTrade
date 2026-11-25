'use strict';

// Section-5 scoring model from the screenshot plan: a 0–100 trade quality
// calculator with the doc's exact weights. This is a screening score, not a
// validated probability of profit — a high score does not guarantee a win.
//
//   15-minute trend aligned            20 points
//   Price above VWAP (CE) / below (PE) 15 points
//   EMA 20/50 alignment                15 points
//   Strong 5-minute entry confirmation 20 points
//   Volume confirmation                10 points
//   Favourable risk/reward (min 1:2)   15 points
//   Option liquidity, acceptable spread 5 points
//
// "Strong 5-minute entry confirmation" is the doc's biggest weight but is
// never defined there, so it is concretized here as: all five entry
// conditions hold AND the MACD histogram is expanding (momentum
// strengthening) AND the signal candle closed in the outer third of its
// range (a conviction close). Verdicts: >= 70 Strong (tradeable), 40–69
// Moderate, < 40 Weak. A check with no data behind it scores 0 and is
// reported as 'nodata' instead of silently counting as a fail.

const { emaSeries, vwapSeries } = require('./indicators');

const CHECKS = [
  { key: 'trend15m', points: 20 },
  { key: 'vsVwap', points: 15 },
  { key: 'emaAligned', points: 15 },
  { key: 'entry5m', points: 20 },
  { key: 'volume', points: 10 },
  { key: 'riskReward', points: 15 },
  { key: 'liquidity', points: 5 },
];

const LABELS = {
  CE: {
    trend15m: '15-minute trend aligned',
    vsVwap: 'Price above VWAP',
    emaAligned: 'EMA 20/50 bullish alignment',
    entry5m: 'Strong 5-minute entry confirmation',
    volume: 'Volume confirmation',
    riskReward: 'Favourable risk/reward (minimum 1:2)',
    liquidity: 'Option liquidity and acceptable spread',
  },
  PE: {
    trend15m: '15-minute trend aligned',
    vsVwap: 'Price below VWAP',
    emaAligned: 'EMA 20/50 bearish alignment',
    entry5m: 'Strong 5-minute entry confirmation',
    volume: 'Volume confirmation',
    riskReward: 'Favourable risk/reward (minimum 1:2)',
    liquidity: 'Option liquidity and acceptable spread',
  },
};

const DEFAULTS = {
  passBar: 70,
  // Trade plan defaults (same as muhurat2): -5% stop, +22% first target.
  slPct: 5,
  t1Pct: 22,
  minRiskReward: 2,
};

function trend15mAligned(bars15, side) {
  if (!Array.isArray(bars15) || bars15.length < 50) return null;
  const closes = bars15.map((b) => b.close);
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const vwap = vwapSeries(bars15);
  const i = bars15.length - 1;
  if (![ema20[i], ema50[i], vwap[i]].every(Number.isFinite)) return null;
  const bull = side === 'CE';
  const emaOk = bull ? ema20[i] > ema50[i] : ema20[i] < ema50[i];
  const vwapOk = bull ? bars15[i].close > vwap[i] : bars15[i].close < vwap[i];
  return emaOk && vwapOk;
}

// Strong 5m confirmation: all five entry conditions hold, MACD histogram is
// expanding, and the signal candle closed in the outer third of its range.
function strongEntry(entry, bars5) {
  if (!entry || !entry.passed || !entry.values) return false;
  const v = entry.values;
  if (!Number.isFinite(v.macdHist)) return false;
  const i = bars5.length - 1;
  if (i < 1) return false;
  const prevHist = entry.prevMacdHist;
  const expanding = Number.isFinite(prevHist) ? v.macdHist > prevHist : true;
  const bar = bars5[i];
  const range = bar.high - bar.low;
  if (range <= 0) return false;
  const conviction = entry.side === 'CE'
    ? (bar.close - bar.low) / range >= 2 / 3
    : (bar.high - bar.close) / range >= 2 / 3;
  return expanding && conviction;
}

// input:
//   { side: 'CE' | 'PE', entry, bars5, bars15,
//     slPct, t1Pct, liquidityOk: true | false | null }
// entry is the result of evaluateEntry(); bars5 the 5m candles it ran on.
// liquidityOk comes from live option quotes (bid/ask spread, OI); null when
// no quotes are available, and the check is then reported as 'nodata'.
function scoreTrade(input) {
  const o = { ...DEFAULTS, ...(input.opts || {}) };
  const side = input.side;
  const entry = input.entry || {};
  const conds = entry.conditions || {};
  const checks = [];
  const verdictFor = (score) => (score >= o.passBar ? 'Strong' : score >= 40 ? 'Moderate' : 'Weak');

  const push = (key, status) => {
    const def = CHECKS.find((c) => c.key === key);
    checks.push({
      key, label: LABELS[side][key], points: def.points,
      status, // 'pass' | 'fail' | 'nodata'
      scored: status === 'pass' ? def.points : 0,
    });
  };

  const t15 = trend15mAligned(input.bars15, side);
  push('trend15m', t15 === null ? 'nodata' : t15 ? 'pass' : 'fail');
  push('vsVwap', conds.vsVwap === undefined ? 'nodata' : conds.vsVwap ? 'pass' : 'fail');
  push('emaAligned', conds.emaAligned === undefined ? 'nodata' : conds.emaAligned ? 'pass' : 'fail');
  push('entry5m', !entry.passed ? 'fail' : strongEntry(entry, input.bars5 || []) ? 'pass' : 'fail');
  push('volume', conds.volumeBacked === undefined ? 'nodata' : conds.volumeBacked ? 'pass' : 'fail');
  const rr = o.slPct > 0 ? o.t1Pct / o.slPct : 0;
  push('riskReward', rr >= o.minRiskReward ? 'pass' : 'fail');
  push('liquidity', input.liquidityOk === null || input.liquidityOk === undefined
    ? 'nodata' : input.liquidityOk ? 'pass' : 'fail');

  const score = checks.reduce((s, c) => s + c.scored, 0);
  const evaluatedMax = checks
    .filter((c) => c.status !== 'nodata')
    .reduce((s, c) => s + c.points, 0);
  return {
    score, max: 100, evaluatedMax,
    riskReward: Number(rr.toFixed(2)),
    checks,
    verdict: verdictFor(score),
    tradeable: score >= o.passBar,
  };
}

module.exports = { scoreTrade, CHECKS, DEFAULTS };
