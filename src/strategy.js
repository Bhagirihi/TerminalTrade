'use strict';

const { emaSeries, pivotLevels } = require('./indicators');
const { supertrendSeries } = require('./supertrend');
const { istParts, istDateKey, istTimeStr } = require('./time');

// Port of the strategy logic from the Pine v6 script
// "Nifty/BankNifty Multi-Index Strategy" (signals only - nothing here places orders):
//
//   Entry (only when flat):
//     BUY CE (long)  : Supertrend flips bullish (direction < 0), OR the 09:15 bar
//                      opens with direction already bullish.
//     BUY PE (short) : Supertrend flips bearish (direction > 0), OR the 09:15 bar
//                      opens with direction already bearish.
//   Dynamic exit, all from the market:
//     Stop loss        : Supertrend at entry. Price through it exits.
//     Trailing stop    : the Supertrend ratcheted in the trade's favor.
//     Target           : the latest confirmed pivot beyond price (resistance for
//                        a call, support for a put). Price through it exits.
//     Trailing target  : after the trade has earned the initial stop distance,
//                        a pullback of one current ATR from the best close exits.
//     EMA 13           : price through EMA 13 exits if none of the above did.
//   A finished bar is judged on its close, and the exit waits for a later bar.
//   The bar still trading is judged on its live close. The first break is kept
//   (opts.locks) so a later tick cannot erase it. A same-bar exit waits until
//   price has moved off the entry print.
//   Square-off: an open trade is closed at 15:10 IST. The live bar uses the
//   clock; a finished bar uses its open time. No new entry at or after 15:10.
//   Entries and exits are booked at the signal price. On a finished bar that
//   price is the close. On the live bar it is the price at the moment.
//
// Pine defaults kept: ST period 10, multiplier 3.0, EMA length 13,
// pivot left/right 15/15. Lot size is passed in (Nifty 65, Bank Nifty 30).

const DEFAULTS = {
  stPeriod: 10,
  stMultiplier: 3.0,
  emaLength: 13,
  srLeft: 15,
  srRight: 15,
  // flipOnly: enter only on a Supertrend flip (skip the 09:15 "trend already on" rule).
  flipOnly: false,
  // emaExit: false disables the EMA-13 cross exit. emaExitBars delays it until
  // that many finished bars after entry (0 = from the next bar, as before).
  emaExit: true,
  emaExitBars: 0,
};

function squareOffClock(cfg) {
  const hour = cfg && cfg.squareOffHour != null ? cfg.squareOffHour : 15;
  const minute = cfg && cfg.squareOffMinute != null ? cfg.squareOffMinute : 10;
  const label = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return { hour, minute, label };
}

function isSquareOffBar(p, cfg) {
  const clock = squareOffClock(cfg);
  return p.hour > clock.hour || (p.hour === clock.hour && p.minute >= clock.minute);
}

function protectiveStop(side, price, stValue) {
  if (!Number.isFinite(stValue) || stValue <= 0 || !Number.isFinite(price)) return null;
  if (side === 'LONG' && stValue < price) return stValue;
  if (side === 'SHORT' && stValue > price) return stValue;
  return null;
}

function tighten(side, current, candidate) {
  if (candidate == null) return current;
  if (current == null) return candidate;
  return side === 'LONG' ? Math.max(current, candidate) : Math.min(current, candidate);
}

// Levels carried on an open position. Stop and target come from the Supertrend
// and the confirmed pivots, and both only move with the market.
function seedLevels(side, entry, i, st, sr) {
  const stop = protectiveStop(side, entry, st.value[i]);
  const pivot = side === 'LONG' ? sr.resAt[i] : sr.supAt[i];
  const target = Number.isFinite(pivot) && (side === 'LONG' ? pivot > entry : pivot < entry) ? pivot : null;
  return {
    initialStop: stop,
    stopLoss: stop,
    trailingStop: stop,
    target,
    trailingTarget: null,
    peak: entry,
    trailOn: false,
  };
}

function refreshLevels(position, close, i, st, sr) {
  const long = position.side === 'LONG';
  const pivot = long ? sr.resAt[i] : sr.supAt[i];
  if (Number.isFinite(pivot) && (long ? pivot > close : pivot < close)) position.target = pivot;

  const liveStop = protectiveStop(position.side, close, st.value[i]);
  position.trailingStop = tighten(position.side, position.trailingStop, liveStop);

  position.peak = long ? Math.max(position.peak, close) : Math.min(position.peak, close);
  const risk = position.initialStop == null ? null : Math.abs(position.entryPrice - position.initialStop);
  const reward = long ? position.peak - position.entryPrice : position.entryPrice - position.peak;
  if (!position.trailOn && risk != null && risk > 0 && reward >= risk) position.trailOn = true;
  const atr = st.atr[i];
  if (position.trailOn && Number.isFinite(atr) && atr > 0) {
    position.trailingTarget = long ? position.peak - atr : position.peak + atr;
  }
}

// First matching rule wins. Capital protection comes before taking profit.
function marketExitReason(position, close) {
  const long = position.side === 'LONG';
  const stop = position.trailingStop != null ? position.trailingStop : position.stopLoss;
  if (stop != null && (long ? close < stop : close > stop)) {
    const moved = position.initialStop != null && (long ? stop > position.initialStop : stop < position.initialStop);
    return moved ? 'Trailing stop' : 'Stop loss';
  }
  if (position.target != null && (long ? close >= position.target : close <= position.target)) return 'Target';
  if (position.trailOn && position.trailingTarget != null) {
    const giveback = long
      ? close <= position.trailingTarget && close > position.entryPrice
      : close >= position.trailingTarget && close < position.entryPrice;
    if (giveback) return 'Trailing target';
  }
  return null;
}

function lockedLevels(lock, side, price, i, st, sr) {
  const lv = lock && lock.levels;
  if (!lv) return seedLevels(side, price, i, st, sr);
  return {
    initialStop: lv.initialStop ?? null,
    stopLoss: lv.stopLoss ?? null,
    trailingStop: lv.trailingStop ?? null,
    target: lv.target ?? null,
    trailingTarget: lv.trailingTarget ?? null,
    peak: Number.isFinite(lv.peak) ? lv.peak : price,
    trailOn: !!lv.trailOn,
  };
}

// candles: [{ t (epoch ms, bar START), open, high, low, close }] in IST order.
// The last candle may still be forming. Pass opts.liveBarT for that bar and
// opts.now for the clock. opts.locks keeps a decision already taken on a bar.
// Returns per-bar computed series plus the signal list and the final open position.
function runStrategy(candles, lotSize, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const closes = candles.map((c) => c.close);
  const st = supertrendSeries(candles, cfg.stPeriod, cfg.stMultiplier);
  const ema = emaSeries(closes, cfg.emaLength);
  const sr = pivotLevels(candles, cfg.srLeft, cfg.srRight);
  const locks = Array.isArray(cfg.locks) ? cfg.locks : [];
  const now = Number.isFinite(cfg.now) ? cfg.now : null;

  const signals = [];
  let position = null; // { side:'LONG'|'SHORT', entryPrice, entryTime, entryIndex, qty }
  let entryIndex = -1;
  let squaredOffDate = null;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const p = istParts(c.t);
    const dateKey = istDateKey(c.t);
    const dir = st.direction[i];
    const timeIST = istTimeStr(c.t);
    const live = cfg.liveBarT === c.t;
    const clock = live && now ? istParts(now) : p;
    const here = locks.filter((l) => l.barT === c.t);
    const entryLock = here.find((l) => l.type === 'BUY CE' || l.type === 'BUY PE');
    const exitLock = here.find((l) => l.type === 'EXIT CE' || l.type === 'EXIT PE' || l.type === 'SQOFF');

    const openHour = cfg.openHour != null ? cfg.openHour : 9;
    const openMinute = cfg.openMinute != null ? cfg.openMinute : 15;
    const isMarketOpenBar = p.hour === openHour && p.minute === openMinute;
    // During 09:15–09:30 the engine can defer the 15-minute open rule so the
    // first confirming 5-minute close is the entry. A Supertrend flip still enters.
    const openRule = !cfg.flipOnly && isMarketOpenBar && !cfg.deferOpen;
    const longCond = (st.flipped[i] && dir < 0) || (openRule && dir < 0);
    const shortCond = (st.flipped[i] && dir > 0) || (openRule && dir > 0);

    // A fast open trigger can fill before this bar's own rule. It is kept, and
    // the open-bar rule does not fire a second time. A lock from that moment wins.
    // flipOnly skips this early open fill as well — only Supertrend flips enter.
    const early = cfg.earlyEntry;
    if (!cfg.flipOnly && !position && !entryLock && early && early.dateKey === dateKey && isMarketOpenBar) {
      position = {
        side: early.side,
        entryPrice: early.price,
        entryTime: early.t,
        entryIndex: i,
        qty: lotSize,
        ...seedLevels(early.side, early.price, i, st, sr),
      };
      entryIndex = i;
      const type = early.side === 'LONG' ? 'BUY CE' : 'BUY PE';
      signals.push({
        t: early.t,
        barT: c.t,
        timeIST: early.timeIST,
        dateKey,
        type,
        side: early.side,
        price: early.price,
        qty: lotSize,
        reason: early.reason,
      });
    }

    // --- Entries (Pine section 3). A lock is the moment already taken. ---
    if (!position && squaredOffDate !== dateKey && (entryLock || !isSquareOffBar(clock, cfg))) {
      let take = null;
      if (entryLock) {
        take = {
          side: entryLock.side,
          type: entryLock.type,
          price: entryLock.price,
          t: entryLock.t,
          timeIST: entryLock.timeIST,
          reason: entryLock.reason,
          levels: lockedLevels(entryLock, entryLock.side, entryLock.price, i, st, sr),
        };
      } else if (longCond || shortCond) {
        const side = longCond ? 'LONG' : 'SHORT';
        const when = live && now ? now : c.t;
        take = {
          side,
          type: side === 'LONG' ? 'BUY CE' : 'BUY PE',
          price: c.close,
          t: when,
          timeIST: live && now ? istTimeStr(now) : timeIST,
          reason: st.flipped[i]
            ? (side === 'LONG' ? 'Supertrend flip to bullish' : 'Supertrend flip to bearish')
            : (side === 'LONG' ? 'Market open, trend bullish' : 'Market open, trend bearish'),
          levels: seedLevels(side, c.close, i, st, sr),
        };
      }
      if (take) {
        position = {
          side: take.side,
          entryPrice: take.price,
          entryTime: take.t,
          entryIndex: i,
          qty: lotSize,
          ...take.levels,
        };
        entryIndex = i;
        signals.push({
          t: take.t,
          barT: c.t,
          timeIST: take.timeIST,
          dateKey,
          type: take.type,
          side: take.side,
          price: take.price,
          qty: lotSize,
          reason: take.reason,
        });
      }
    }

    // Finished bars exit on a later bar. The live bar can exit once price has
    // traded off the entry. A lock replays the moment that already fired.
    const moved = position != null && c.close !== position.entryPrice;
    const sameBarLater = live && position != null && position.entryTime < (now || c.t) && moved;
    if (position && (i > entryIndex || sameBarLater)) {
      const long = position.side === 'LONG';
      const useLock = exitLock && exitLock.side === position.side && (i > entryIndex || exitLock.t > position.entryTime);
      let reason = null;
      let price = c.close;
      let when = live && now ? now : c.t;
      let whenIST = live && now ? istTimeStr(now) : timeIST;
      let type = long ? 'EXIT CE' : 'EXIT PE';
      if (useLock) {
        reason = exitLock.reason;
        price = exitLock.price;
        when = exitLock.t;
        whenIST = exitLock.timeIST;
        if (exitLock.type === 'SQOFF') type = 'SQOFF';
      } else if (!exitLock) {
        reason = marketExitReason(position, c.close);
        const heldBars = i - entryIndex;
        const emaReady = cfg.emaExit !== false && heldBars >= (Number(cfg.emaExitBars) || 0);
        if (!reason && emaReady && ((long && c.close < ema[i]) || (!long && c.close > ema[i]))) {
          reason = 'Close crossed EMA 13';
        }
      }
      if (reason) {
        const pts = long ? price - position.entryPrice : position.entryPrice - price;
        signals.push({ t: when, barT: c.t, timeIST: whenIST, dateKey, type, side: position.side, price, qty: position.qty, points: round2(pts), reason });
        position = null;
      } else {
        refreshLevels(position, c.close, i, st, sr);
      }
    }

    // --- End-of-day square-off (Pine section 5) ---
    if (position && isSquareOffBar(clock, cfg)) {
      const sq = exitLock && exitLock.type === 'SQOFF' ? exitLock : null;
      const price = sq ? sq.price : c.close;
      const when = sq ? sq.t : (live && now ? now : c.t);
      const whenIST = sq ? sq.timeIST : (live && now ? istTimeStr(now) : timeIST);
      const pts = position.side === 'LONG' ? price - position.entryPrice : position.entryPrice - price;
      signals.push({
        t: when,
        barT: c.t,
        timeIST: whenIST,
        dateKey,
        type: 'SQOFF',
        side: position.side,
        price,
        qty: position.qty,
        points: round2(pts),
        reason: sq ? sq.reason : `${squareOffClock(cfg).label} square-off`,
      });
      position = null;
      squaredOffDate = dateKey;
    }
  }

  return {
    stValue: st.value,
    direction: st.direction,
    flipped: st.flipped,
    ema,
    resAt: sr.resAt,
    supAt: sr.supAt,
    signals,
    position,
  };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

module.exports = { runStrategy, DEFAULTS, marketExitReason, refreshLevels };
