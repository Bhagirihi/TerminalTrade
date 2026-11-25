'use strict';

// Section-3 entry rules from the screenshot plan, on 5-minute candles.
// Candles are { t, open, high, low, close, volume }[] and must be CLOSED bars
// only — every signal this module returns is therefore "after candle close"
// (rule 6 / 12). A "confirmed retest" is reported when price comes back to
// the session VWAP (the breakout level in this setup) and holds it with all
// conditions still true.
//
// CE buying setup — all five must hold on the signal bar:
//   1. NIFTY price above VWAP (session VWAP, resets each IST day)
//   2. EMA 20 above EMA 50
//   3. RSI 14 above 50
//   4. MACD bullish confirmation (line above signal, histogram > 0)
//   5. Breakout candle supported by volume (volume above Volume MA 20)
// PE buying setup is the exact mirror.
// When indicators conflict (some CE, some PE) neither side passes — no trade.

const {
  emaSeries, rsiSeries, vwapSeries, macdSeries, smaSeries,
} = require('./indicators');

const DEFAULTS = {
  emaFast: 20,
  emaSlow: 50,
  rsiLen: 14,
  rsiMid: 50,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  volMaLen: 20,
  // Bars needed before every series has seeded (EMA 50 + MACD signal).
  minBars: 60,
  // Retest: the low may dip this far under VWAP and still count as "held".
  retestTolerancePct: 0.2,
};

function computeSeries(bars, o) {
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  return {
    emaFast: emaSeries(closes, o.emaFast),
    emaSlow: emaSeries(closes, o.emaSlow),
    rsi: rsiSeries(closes, o.rsiLen),
    macd: macdSeries(closes, o.macdFast, o.macdSlow, o.macdSignal),
    vwap: vwapSeries(bars),
    volMa: smaSeries(volumes, o.volMaLen),
  };
}

// The five conditions for one side ('CE' | 'PE') at bar index i.
function sideConditions(s, bars, o, side, i) {
  const bull = side === 'CE';
  const bar = bars[i];
  return {
    vsVwap: bull ? bar.close > s.vwap[i] : bar.close < s.vwap[i],
    emaAligned: bull ? s.emaFast[i] > s.emaSlow[i] : s.emaFast[i] < s.emaSlow[i],
    rsiSide: bull ? s.rsi[i] > o.rsiMid : s.rsi[i] < o.rsiMid,
    macdConfirm: bull
      ? s.macd.line[i] > s.macd.signal[i] && s.macd.hist[i] > 0
      : s.macd.line[i] < s.macd.signal[i] && s.macd.hist[i] < 0,
    volumeBacked: Number.isFinite(s.volMa[i]) && bar.volume > s.volMa[i],
  };
}

function allTrue(conds) { return Object.values(conds).every(Boolean); }

// 'breakout' when the conditions first become true on this bar;
// 'retest' when they already held on the previous bar and this bar's low
// came back to (within tolerance of) the session VWAP and held it.
function entryTypeFor(s, bars, o, side) {
  const i = bars.length - 1;
  if (i < 1) return 'breakout';
  if (!allTrue(sideConditions(s, bars, o, side, i - 1))) return 'breakout';
  const vwap = s.vwap[i];
  const tol = vwap * o.retestTolerancePct / 100;
  if (side === 'CE') {
    // Dipped back to VWAP and held above it.
    return bars[i].low <= vwap + tol && bars[i].close > vwap ? 'retest' : 'breakout';
  }
  // PE mirror: pushed back up to VWAP and held below it.
  return bars[i].high >= vwap - tol && bars[i].close < vwap ? 'retest' : 'breakout';
}

// Evaluate the last closed 5m bar. Returns:
//   { evaluable, side: 'CE' | 'PE' | null, passed, entryType,
//     conditions, values, reason? }
// side is null when neither side's five conditions all hold (including when
// indicators conflict). `values` carries the indicator readings at the bar
// for logging / the scoring model.
function evaluateEntry(bars5, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!Array.isArray(bars5) || bars5.length < o.minBars) {
    return {
      evaluable: false, side: null, passed: false, entryType: null,
      conditions: null, values: null,
      reason: `need ${o.minBars} closed 5m bars, got ${Array.isArray(bars5) ? bars5.length : 0}`,
    };
  }
  const s = computeSeries(bars5, o);
  const i = bars5.length - 1;
  const bar = bars5[i];
  const values = {
    close: bar.close,
    vwap: s.vwap[i],
    emaFast: s.emaFast[i],
    emaSlow: s.emaSlow[i],
    rsi: s.rsi[i],
    macdLine: s.macd.line[i],
    macdSignal: s.macd.signal[i],
    macdHist: s.macd.hist[i],
    prevMacdHist: i > 0 ? s.macd.hist[i - 1] : NaN,
    volume: bar.volume,
    volMa: s.volMa[i],
  };
  for (const side of ['CE', 'PE']) {
    const conditions = sideConditions(s, bars5, o, side, i);
    if (allTrue(conditions)) {
      return {
        evaluable: true, side, passed: true,
        entryType: entryTypeFor(s, bars5, o, side),
        conditions, values,
      };
    }
  }
  // Neither side passed: report the CE conditions so the caller can see
  // which checks failed (the PE mirror fails on at least the same axis).
  return {
    evaluable: true, side: null, passed: false, entryType: null,
    conditions: sideConditions(s, bars5, o, 'CE', i), values,
  };
}

module.exports = { evaluateEntry, DEFAULTS };
