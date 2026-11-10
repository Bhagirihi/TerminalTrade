'use strict';

// Second strategy lane: "NIFTY Index Signals | CE Buy Alerts v3" (Pine v6).
// Long-only bullish pullback continuation. The engine runs it on the same
// candles and symbols as the Supertrend lane, with its own position, signals
// and locks. The rules below are unchanged; only the book they read changes.
//
// Pine rule recap (inputs kept as JS defaults):
//   Trend    : close > EMA50 rising, EMA9 > EMA20, close > VWAP
//   Momentum : RSI(14) in [50, 72], +DI > -DI, ADX(14) >= 15
//   Trigger  : a bar in the last 4 tagged/undercut EMA20, then the current
//              bar reclaims EMA9 and closes bullish above the prior high
//   Risk     : stop = max(prior 5-bar swing low, close - 1.5*ATR),
//              valid only if 0.4*ATR <= risk <= 3.5*ATR; target = 1.8R
//   Guards   : max 3 entries/day, 3-bar cooldown after exit,
//              daily loss lock at -1000 points (1% of 100000, qty 1),
//              entries only 09:20-14:40 IST, flatten 15:10-15:25 IST
//
// Conventions (same as strategy.js): finished bars are judged on the close,
// the live bar on the live close, and the first break is kept via opts.locks
// so a later tick cannot erase it. Exits are evaluated on the bar close —
// Pine's intrabar stop/limit fills are NOT replicated; the close convention
// is the documented, honest approximation used across this project.
// Signals only — nothing here places orders.

const { emaSeries, rsiSeries, vwapSeries, dmiSeries, trueRanges, rmaSeries } = require('./indicators');
const { istParts, istDateKey, istTimeStr } = require('./time');

const DEFAULTS_CE = {
  fastLen: 9,
  pullbackLen: 20,
  trendLen: 50,
  rsiLen: 14,
  atrLen: 14,
  diLen: 14,
  adxSmooth: 14,
  minRSI: 50,
  maxRSI: 72,
  minADX: 15,
  rr: 1.8,
  stopATR: 1.5,
  swingLen: 5,
  minStopATR: 0.4,
  maxStopATR: 3.5,
  maxTradesDay: 3,
  cooldownBars: 3,
  dailyLossPoints: 1000, // 1% of 100000 initial capital at qty 1 (Pine-faithful)
  useSession: true,
};

// Bar-open minutes since midnight IST.
function barMins(t) {
  const p = istParts(t);
  return p.hour * 60 + p.minute;
}

function lowestLow(lows, i, len) {
  let m = Infinity;
  for (let k = i - len + 1; k <= i; k++) {
    if (k < 0) return NaN;
    if (lows[k] < m) m = lows[k];
  }
  return m;
}

// candles: [{ t (bar START, ms), open, high, low, close, volume }] in IST order.
// The last candle may still be forming; pass opts.liveBarT for it and opts.now
// for the clock. opts.locks replays decisions already taken on a live bar.
// Returns the indicator series, the signal list, the final open position, and
// a debug snapshot for the dashboard.
function runCeSignals(candles, opts = {}) {
  const cfg = { ...DEFAULTS_CE, ...opts };
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const lows = candles.map((c) => c.low);

  const emaFast = emaSeries(closes, cfg.fastLen);
  const emaPB = emaSeries(closes, cfg.pullbackLen);
  const emaTrend = emaSeries(closes, cfg.trendLen);
  const rsi = rsiSeries(closes, cfg.rsiLen);
  const atr = rmaSeries(trueRanges(candles), cfg.atrLen);
  const vwap = vwapSeries(candles);
  const dmi = dmiSeries(candles, cfg.diLen, cfg.adxSmooth);

  const locks = Array.isArray(cfg.locks) ? cfg.locks : [];
  const signals = [];
  let position = null; // { side:'LONG', entryPrice, entryTime, entryIndex, qty, activeStop, activeTarget }
  let entryIndex = -1;

  // Daily risk state, rebuilt deterministically from the signal tape.
  let dayKey = null;
  let dayStartPoints = 0;
  let totalPoints = 0;
  let tradesToday = 0;
  let lastExitBar = -Infinity;

  const debug = {
    setup: 'WAIT',
    risk: 'BLOCK',
    entry: 'BLOCK',
    tradesToday: 0,
    maxTradesDay: cfg.maxTradesDay,
    dailyLocked: false,
    block: '',
  };

  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const dateKey = istDateKey(c.t);
    const timeIST = istTimeStr(c.t);
    const live = cfg.liveBarT === c.t;
    const mins = barMins(c.t);
    const inSession = !cfg.useSession || (mins >= 560 && mins < 880); // 09:20-14:40
    const inFlatWindow = mins >= 910 && mins < 925; // 15:10-15:25

    if (dateKey !== dayKey) {
      dayKey = dateKey;
      dayStartPoints = totalPoints;
      tradesToday = 0;
    }

    const here = locks.filter((l) => l.barT === c.t);
    const entryLock = here.find((l) => l.type === 'BUY CE');
    const exitLock = here.find((l) => l.type === 'EXIT CE' || l.type === 'SQOFF');

    const ready =
      i >= 1 &&
      Number.isFinite(emaTrend[i]) &&
      Number.isFinite(vwap[i]) &&
      Number.isFinite(atr[i]) &&
      Number.isFinite(dmi.adx[i]) &&
      Number.isFinite(rsi[i]) &&
      Number.isFinite(emaFast[i]) &&
      Number.isFinite(emaPB[i]);

    // --- Setup (Pine: setupSignal) ---
    let setupSignal = false;
    let validRisk = false;
    let candidateStop = NaN;
    let riskDistance = NaN;
    let trendUp = false;
    let momentumOK = false;
    let pullbackTouch = false;
    let continuation = false;
    if (ready) {
      trendUp =
        c.close > emaTrend[i] &&
        emaTrend[i] > emaTrend[i - 1] &&
        emaFast[i] > emaPB[i] &&
        c.close > vwap[i];
      momentumOK =
        rsi[i] >= cfg.minRSI &&
        rsi[i] <= cfg.maxRSI &&
        dmi.plus[i] > dmi.minus[i] &&
        dmi.adx[i] >= cfg.minADX;
      for (let k = Math.max(0, i - 3); k <= i; k++) {
        if (Number.isFinite(emaPB[k]) && lows[k] - emaPB[k] <= 0) {
          pullbackTouch = true;
          break;
        }
      }
      continuation = c.close > emaFast[i] && c.close > c.open && c.close > candles[i - 1].high;
      setupSignal = trendUp && momentumOK && pullbackTouch && continuation;

      const swingStop = lowestLow(lows, i - 1, cfg.swingLen); // ta.lowest(low, swingLen)[1]
      const atrStopPrice = c.close - atr[i] * cfg.stopATR;
      candidateStop = Math.max(swingStop, atrStopPrice);
      riskDistance = c.close - candidateStop;
      validRisk =
        Number.isFinite(swingStop) &&
        Number.isFinite(atr[i]) &&
        candidateStop > 0 &&
        riskDistance >= atr[i] * cfg.minStopATR &&
        riskDistance <= atr[i] * cfg.maxStopATR;
    }

    // --- Entry controls (Pine: canEnter) ---
    const openPoints = position ? (position.side === 'LONG' ? c.close - position.entryPrice : 0) : 0;
    const dailyPnL = totalPoints - dayStartPoints + (position ? openPoints : 0);
    const dailyLocked = dailyPnL <= -cfg.dailyLossPoints;
    const cooldownOK = i - lastExitBar > cfg.cooldownBars;
    const canEnter =
      ready && inSession && !dailyLocked && tradesToday < cfg.maxTradesDay && position == null && cooldownOK;
    const actualEntrySignal = setupSignal && canEnter && validRisk;

    if (live && i === n - 1) {
      debug.setup = setupSignal ? 'PASS' : 'WAIT';
      debug.risk = validRisk ? 'PASS' : 'BLOCK';
      debug.entry = canEnter ? 'PASS' : 'BLOCK';
      debug.tradesToday = tradesToday;
      debug.dailyLocked = dailyLocked;
      debug.block = ceBlockReason({
        ready,
        position,
        inSession,
        dailyLocked,
        tradesToday,
        maxTrades: cfg.maxTradesDay,
        cooldownOK,
        setupSignal,
        validRisk,
        trendUp,
        momentumOK,
        pullbackTouch,
        close: c.close,
        emaTrend: emaTrend[i],
        emaTrendPrev: emaTrend[i - 1],
        emaFast: emaFast[i],
        emaPB: emaPB[i],
        vwap: vwap[i],
        rsi: rsi[i],
        minRSI: cfg.minRSI,
        maxRSI: cfg.maxRSI,
        plus: dmi.plus[i],
        minus: dmi.minus[i],
        adx: dmi.adx[i],
        minADX: cfg.minADX,
      });
    }

    // Setup-only marker (Pine: yellow "SET" dot) — informational, never a trade.
    if (setupSignal && !actualEntrySignal && !position) {
      signals.push({
        t: live && cfg.now ? cfg.now : c.t,
        barT: c.t,
        timeIST: live && cfg.now ? istTimeStr(cfg.now) : timeIST,
        dateKey,
        type: 'SETUP',
        side: 'LONG',
        price: c.close,
        qty: null,
        reason: 'Setup only — blocked by risk/session/limits',
      });
    }

    // --- Entry ---
    if (!position && (entryLock || actualEntrySignal)) {
      const price = entryLock ? entryLock.price : c.close;
      const when = entryLock ? entryLock.t : live && cfg.now ? cfg.now : c.t;
      const whenIST = entryLock ? entryLock.timeIST : live && cfg.now ? istTimeStr(cfg.now) : timeIST;
      const lockedStop = lockLevel(entryLock, 'stopLoss');
      const lockedTarget = lockLevel(entryLock, 'target');
      const stop = Number.isFinite(lockedStop) ? lockedStop : candidateStop;
      const target = Number.isFinite(lockedTarget) ? lockedTarget : price + riskDistance * cfg.rr;
      position = {
        side: 'LONG',
        entryPrice: price,
        entryTime: when,
        entryIndex: i,
        qty: cfg.qty || 65, // NIFTY lot
        activeStop: stop,
        activeTarget: target,
      };
      entryIndex = i;
      tradesToday += 1;
      signals.push({
        t: when,
        barT: c.t,
        timeIST: whenIST,
        dateKey,
        type: 'BUY CE',
        side: 'LONG',
        price,
        qty: position.qty,
        reason: entryLock ? entryLock.reason : 'Bullish CE signal (EMA/VWAP/RSI/ADX pullback)',
        stopLoss: stop,
        target,
      });
    }

    // --- Exits (Pine: strategy.exit stop/limit, daily lock, flat window) ---
    // Finished bars exit on a later bar. The live bar can exit once price has
    // traded off the entry, same as the Supertrend lane.
    const moved = position != null && c.close !== position.entryPrice;
    const sameBarLater = live && position != null && position.entryTime < (cfg.now || c.t) && moved;
    if (position && (i > entryIndex || sameBarLater)) {
      const useExitLock = exitLock && exitLock.t > position.entryTime;
      let reason = null;
      let price = c.close;
      let when = live && cfg.now ? cfg.now : c.t;
      let whenIST = live && cfg.now ? istTimeStr(cfg.now) : timeIST;
      let type = 'EXIT CE';
      if (useExitLock) {
        reason = exitLock.reason;
        price = exitLock.price;
        when = exitLock.t;
        whenIST = exitLock.timeIST;
        if (exitLock.type === 'SQOFF') type = 'SQOFF';
      } else if (!exitLock) {
        if (c.close <= position.activeStop) reason = 'Stop';
        else if (c.close >= position.activeTarget) reason = 'Target';
        else if (dailyLocked) reason = 'Daily loss lock';
        else if (inFlatWindow) {
          reason = 'End of day';
          type = 'SQOFF';
        }
      }
      if (reason) {
        const pts = price - position.entryPrice;
        totalPoints += pts;
        lastExitBar = i;
        signals.push({
          t: when,
          barT: c.t,
          timeIST: whenIST,
          dateKey,
          type,
          side: 'LONG',
          price,
          qty: position.qty,
          points: Math.round(pts * 100) / 100,
          reason,
        });
        position = null;
      }
    }
  }

  return { emaFast, emaPB, emaTrend, rsi, atr, vwap, dmi, signals, position, debug };
}

function lockLevel(lock, field) {
  if (!lock) return NaN;
  const direct = Number(lock[field]);
  if (Number.isFinite(direct)) return direct;
  const nested = lock.levels ? Number(lock.levels[field]) : NaN;
  return Number.isFinite(nested) ? nested : NaN;
}

// One reason the live bar is not a trade, so the dashboard can say which check failed.
function ceBlockReason(s) {
  if (!s.ready) return 'Indicators warming up';
  if (s.position) return '';
  if (!s.inSession) return 'Outside 09:20–14:40';
  if (s.dailyLocked) return 'Daily loss lock';
  if (s.tradesToday >= s.maxTrades) return 'Max trades today';
  if (!s.cooldownOK) return 'Cooldown after the last exit';
  if (!s.setupSignal) {
    if (!(s.close > s.emaTrend && s.emaTrend > s.emaTrendPrev)) return 'EMA50 is not rising under price';
    if (!(s.emaFast > s.emaPB)) return 'EMA9 is not above EMA20';
    if (!(s.close > s.vwap)) return 'Close is not above VWAP';
    if (!(s.rsi >= s.minRSI && s.rsi <= s.maxRSI)) {
      return `RSI ${Number(s.rsi).toFixed(1)} is outside ${s.minRSI}–${s.maxRSI}`;
    }
    if (!(s.plus > s.minus)) return '+DI is not above −DI';
    if (!(s.adx >= s.minADX)) return `ADX ${Number(s.adx).toFixed(1)} is below ${s.minADX}`;
    if (!s.pullbackTouch) return 'No EMA20 tag in the last 4 bars';
    return 'No bullish reclaim of EMA9';
  }
  if (!s.validRisk) return 'Stop is outside 0.4–3.5 ATR';
  return '';
}

module.exports = { runCeSignals, DEFAULTS_CE, ceBlockReason };
