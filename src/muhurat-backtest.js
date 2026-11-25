'use strict';

// 1-year backtest of the muhurat STOCKS lane (equities only — see below).
//
// Replays the live rules with the repo's own functions — no re-implementation of
// the screen: per bar it rebuilds each row with scoreRow / levelsFromCandles /
// applySessionVerdict, sizes with allocateBudget, and exits with trailPlan.
// Entry/exit decisions run on 1-minute bars; LTP is proxied by the bar close
// for entries and by bar high/low for intra-bar stop/target crossings.
//
// Fidelity choices (all stated in the report, not hidden):
// - Universe: the 33 fixed names (CORE + EXTRA). NSE top-gainers are NOT
//   replayed — the NSE endpoint is live-only and no archive exists in-repo.
//   This understates the live universe; it does not flatter the fixed names.
// - Daily screen uses bars strictly before day D (last full close D-1). Live
//   may include today's partial daily bar — the probe settles which.
// - Sizing uses the lane budget ONLY (availableMargin = 0). This neutralises
//   the live C1 bug (allocator sizes against budget + full margin, bot caps at
//   the lane budget, picks get skipped). Live results will be worse than this
//   backtest until C1 is fixed — the report says so.
// - Loss gate DISABLED: the live gate is whole-account holdings P&L, which a
//   backtest cannot reproduce. Slightly optimistic on bad days.
// - Fills at bar close on entry; exits at the crossed level's price (stop or
//   T2). Intra-bar priority is SL first, then T2 — same as managePositions.
// - Trail: +2.5% arm (30s hold → armed at bar T, lockable from bar T+1 at 1m
//   granularity), lock +1.5%, then +1% steps. Peak from bar highs.
// - T1 is signal-only (the bot never sells at T1) — recorded, not exited on.
// - Costs use the published Upstox intraday stack (see intradayRoundTripCost).
// - No re-entry: one trade per ticker per day, max 5/day, 15:15 square-off.

const {
  CORE,
  EXTRA,
  analyzeName,
  allocateBudget,
  trailPlan,
  stockTrailConfig,
  sessionPhase,
  applySessionVerdict,
  scoreRow,
  levelsFromCandles,
  maxTradesPerDay,
} = require('./muhurat');
const { istDateKey } = require('./time');

const UNIVERSE = [...CORE, ...EXTRA];

// --- Costs: Upstox intraday equity (published schedule, Sep 2026 check) --------
// Brokerage min(0.1% of order value, Rs 20) per executed order; STT 0.025% on
// the sell side; NSE txn 0.00307% both sides; SEBI Rs 10/crore; stamp 0.003%
// on buys; GST 18% on (brokerage + txn + SEBI). One round trip = 2 orders.
const COST = {
  brokeragePct: 0.001,
  brokerageCap: 20,
  sttSellPct: 0.00025,
  txnPct: 0.0000307,
  sebiPct: 0.000001,
  stampBuyPct: 0.00003,
  gstPct: 0.18,
};

function r2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function brokerageFor(value) {
  return Math.min(COST.brokeragePct * value, COST.brokerageCap);
}

/** Full intraday charge stack for one round trip. Values are turnover (Rs). */
function intradayRoundTripCost(buyValue, sellValue) {
  const b = Number(buyValue) || 0;
  const s = Number(sellValue) || 0;
  const brokerage = r2(brokerageFor(b) + brokerageFor(s));
  const stt = r2(COST.sttSellPct * s);
  const txn = r2(COST.txnPct * (b + s));
  const sebi = r2(COST.sebiPct * (b + s));
  const stamp = r2(COST.stampBuyPct * b);
  const gst = r2(COST.gstPct * (brokerage + txn + sebi));
  const total = r2(brokerage + stt + txn + sebi + stamp + gst);
  return { brokerage, stt, txn, sebi, stamp, gst, total };
}

/**
 * Daily-fixed screen values for one symbol on one day, from bars before D.
 * analyzeName is called once (ltp = last close — the daily fields don't depend
 * on ltp); the per-bar row builder below recomputes only the price-dependent
 * parts. Returns null when the symbol has < 20 daily bars (live: ERROR).
 */
function buildSymbolDay(meta, dailyCandles) {
  if (!dailyCandles || dailyCandles.length < 20) return null;
  const lastClose = dailyCandles[dailyCandles.length - 1].close;
  const row = analyzeName(meta, dailyCandles, lastClose);
  return {
    meta,
    daily: dailyCandles,
    sma50: row.sma50,
    rsi: row.rsi,
    d1: row.d1,
    d5: row.d5,
    // ATR% is price-relative (ATR / price): cache the ATR value itself plus
    // the reference price so buildRow can recompute it at each bar's LTP.
    atr: row.atrPct != null ? (row.atrPct / 100) * lastClose : null,
    refPrice: lastClose,
  };
}

/**
 * Rebuild one symbol's row at a given LTP, exactly as analyzeName would for
 * that LTP (same scoreRow / levels / verdict rules), then apply the session
 * verdict. Verified against analyzeName in test/muhurat-backtest-stocks.test.js.
 */
function buildRow(symbolDay, ltp, phase, openPx) {
  const { meta, daily, sma50, rsi, d1, d5, atr, refPrice } = symbolDay;
  const atrPct = atr != null && ltp ? (atr / ltp) * 100 : null;
  const distSma = sma50 != null && ltp ? ((ltp - sma50) / sma50) * 100 : null;
  const aboveSma = sma50 != null ? ltp > sma50 : false;
  const { score, reasons } = scoreRow({
    aboveSma,
    rsi,
    d1: d1 || 0,
    d5: d5 || 0,
    distSma,
    atrPct,
    ticker: meta.ticker,
  });
  const levels = levelsFromCandles(daily, ltp, 'equity');
  let verdict = 'SKIP';
  if (score >= 8 && rsi != null && rsi <= 72) verdict = 'BUY';
  else if (score >= 5 && rsi != null && rsi <= 75) verdict = 'WATCH';
  else if (rsi != null && rsi > 75) verdict = 'TOO HOT';
  const riskPct = levels.stopLoss != null ? ((levels.stopLoss - ltp) / ltp) * 100 : null;
  const reward1Pct = levels.target1 != null ? ((levels.target1 - ltp) / ltp) * 100 : null;
  const row = {
    ticker: meta.ticker,
    key: meta.key,
    sleeve: meta.sleeve || null,
    core: Boolean(meta.core),
    ltp: r2(ltp),
    sma50: r2(sma50),
    rsi: r2(rsi),
    d1: r2(d1),
    d5: r2(d5),
    atrPct: r2(atrPct),
    distSma: r2(distSma),
    aboveSma,
    score,
    reasons,
    verdict,
    levels,
    riskPct: r2(riskPct),
    reward1Pct: r2(reward1Pct),
  };
  return applySessionVerdict(row, phase, openPx);
}

/**
 * Replay one trading day at 1-minute bars.
 *
 * @param {string} date 'YYYY-MM-DD' (IST)
 * @param {Map<string, object>} symbolDays ticker -> buildSymbolDay output
 * @param {Map<string, Array>} minuteBars ticker -> 1m bars [{t,open,high,low,close,volume}] sorted
 * @param {object} opts {budget=15000, confirmSec=60, maxTrades=5}
 * @returns day result (see dayDoc for the persisted shape)
 */
function replayDay(date, symbolDays, minuteBars, opts = {}) {
  const budget = Number(opts.budget) > 0 ? Number(opts.budget) : 15000;
  const confirmSec = opts.confirmSec != null ? Number(opts.confirmSec) : 60;
  const maxTrades = opts.maxTrades != null ? Number(opts.maxTrades) : maxTradesPerDay('equity');
  const trailCfg = stockTrailConfig();

  // Union of bar timestamps, 09:15–15:30. A ticker with no bar yet that day is
  // skipped until its first bar (its LTP is unknown — same as live).
  const times = new Set();
  const openPxByTicker = new Map();
  const lastCloseByTicker = new Map();
  for (const [ticker, bars] of minuteBars) {
    if (!bars || !bars.length) continue;
    openPxByTicker.set(ticker, bars[0].open);
    for (const b of bars) times.add(b.t);
  }
  const sortedTimes = [...times].sort((a, b) => a - b);
  if (!sortedTimes.length) return { date, skipped: 'no-minute-bars', trades: [] };

  let confirmLedger = { date, mode: 'equity', names: {} };
  const open = new Map(); // ticker -> position
  const closedToday = new Set();
  const trades = [];
  const skips = { overBudget: 0, stopAtEntry: 0, levelHit: 0, maxTrades: 0 };
  let tradesToday = 0;
  let openSpend = 0;
  let squaredOff = false;

  const barAt = (ticker, t) => {
    const bars = minuteBars.get(ticker);
    if (!bars) return null;
    // Bars are sorted; find the bar at t (exact 1m grid from the API).
    let lo = 0;
    let hi = bars.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].t === t) return bars[mid];
      if (bars[mid].t < t) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  };

  for (const t of sortedTimes) {
    const phase = sessionPhase(t, 'regular');
    // Refresh each ticker's LTP from its bar at t (or keep the last close).
    for (const [ticker, bars] of minuteBars) {
      const bar = barAt(ticker, t);
      if (bar) lastCloseByTicker.set(ticker, bar.close);
    }

    // --- Exits first (live tick order: SL check, trail update, T2; square-off
    // in exit_only/closed). Exits run on every bar, entries only when live.
    if (phase.phase === 'exit_only' || phase.phase === 'closed') {
      if (!squaredOff) {
        for (const pos of [...open.values()]) {
          const ltp = lastCloseByTicker.get(pos.ticker);
          closePosition(pos, Number.isFinite(ltp) ? ltp : pos.entry, t, '15:15');
        }
        squaredOff = true;
      }
      continue;
    }

    for (const pos of [...open.values()]) {
      const bar = barAt(pos.ticker, t);
      if (!bar) continue;
      // Peak from bar high (max LTP seen inside the bar).
      if (bar.high > pos.peak) pos.peak = bar.high;
      // Stamp the trail arm the first time peak reaches the arm price.
      if (pos.trailArmAt == null && pos.peak + 1e-9 >= trailArmPx(pos)) {
        pos.trailArmAt = t;
      }
      const plan = trailPlan(pos.entry, pos.initialStop, pos.t1, pos.t2, pos.peak, {
        mode: 'equity',
        armAt: pos.trailArmAt,
        now: t,
      });
      const stop = Math.max(pos.initialStop, plan.activeStop != null ? plan.activeStop : pos.initialStop);
      pos.stop = stop;
      if (bar.low <= stop + 1e-9) {
        closePosition(pos, stop, t, 'SL');
      } else if (bar.high >= pos.t2 - 1e-9) {
        closePosition(pos, pos.t2, t, 'T2');
      } else if (bar.high >= pos.t1 - 1e-9) {
        pos.t1Hit = true;
      }
    }

    // --- Entries (live phase only).
    if (!phase.canDecideBuy || squaredOff) continue;
    if (tradesToday >= maxTrades && maxTrades > 0) continue;
    const rows = [];
    for (const [ticker, sd] of symbolDays) {
      const ltp = lastCloseByTicker.get(ticker);
      if (!Number.isFinite(ltp)) continue;
      rows.push(buildRow(sd, ltp, phase, openPxByTicker.get(ticker)));
    }
    const alloc = allocateBudget(budget, rows, {
      availableMargin: 0, // lane budget only — neutralises the live C1 bug (see header)
      mode: 'equity',
      day: date,
      now: t,
      confirmLedger,
      persistConfirm: false,
      maxTrades,
      confirmSec,
      stickyTickers: [...open.keys()],
    });
    confirmLedger = alloc.confirmLedger || confirmLedger;
    for (const pick of alloc.picks || []) {
      if (!pick.orderReady || !(pick.qty > 0)) continue;
      if (open.has(pick.ticker) || closedToday.has(pick.ticker)) continue;
      if (maxTrades > 0 && tradesToday >= maxTrades) { skips.maxTrades += 1; continue; }
      const ltp = Number(pick.ltp);
      const need = pick.qty * ltp;
      if (!(pick.sellStop != null) || pick.sellStop >= ltp) { skips.stopAtEntry += 1; continue; }
      if (levelBlocksBuy(pick)) { skips.levelHit += 1; continue; }
      if (openSpend + need > budget + 1) { skips.overBudget += 1; continue; }
      open.set(pick.ticker, {
        ticker: pick.ticker,
        key: pick.key,
        qty: pick.qty,
        entry: ltp,
        initialStop: pick.sellStop,
        stop: pick.sellStop,
        t1: pick.sellT1,
        t2: pick.sellT2,
        peak: ltp,
        trailArmAt: null,
        buyAt: t,
        entryP: pick.profitScore,
        t1Hit: false,
        spend: r2(need),
      });
      openSpend += need;
      tradesToday += 1;
    }
  }

  // Any position still open (no 15:15 bar): close at the last known LTP.
  for (const pos of [...open.values()]) {
    const ltp = lastCloseByTicker.get(pos.ticker);
    closePosition(pos, Number.isFinite(ltp) ? ltp : pos.entry, sortedTimes[sortedTimes.length - 1], '15:15');
  }

  function trailArmPx(pos) {
    return Math.round((pos.entry * (1 + trailCfg.armPct / 100)) / 0.05) * 0.05;
  }

  function levelBlocksBuy(pick) {
    // Mirrors enterFromBook: don't buy through a hit level.
    return pick.action === 'EXIT' || pick.action === 'T1 HIT' || pick.stopHit || pick.t1Hit || pick.t2Hit;
  }

  function closePosition(pos, exitPx, t, reason) {
    open.delete(pos.ticker);
    openSpend -= pos.spend;
    closedToday.add(pos.ticker);
    const exit = r2(exitPx);
    const grossPnl = r2((exit - pos.entry) * pos.qty);
    const charges = intradayRoundTripCost(pos.entry * pos.qty, exit * pos.qty);
    trades.push({
      ticker: pos.ticker,
      mode: 'equity',
      key: pos.key,
      qty: pos.qty,
      entry: pos.entry,
      exit,
      spend: pos.spend,
      pnl: grossPnl, // live-ledger semantics: gross of charges
      charges: charges.total,
      netPnl: r2(grossPnl - charges.total),
      exitReason: reason,
      status: 'CLOSED',
      buyAt: new Date(pos.buyAt).toISOString(),
      sellAt: new Date(t).toISOString(),
      entryP: pos.entryP != null ? pos.entryP : null,
      t1Hit: Boolean(pos.t1Hit),
      right: null,
    });
  }

  const grossPnl = r2(trades.reduce((s, tr) => s + (tr.pnl || 0), 0));
  const charges = r2(trades.reduce((s, tr) => s + (tr.charges || 0), 0));
  const netPnl = r2(trades.reduce((s, tr) => s + (tr.netPnl || 0), 0));
  const investment = r2(trades.reduce((s, tr) => s + (tr.spend || 0), 0));
  return {
    date,
    trades,
    tradeCount: trades.length,
    wins: trades.filter((tr) => tr.netPnl > 0).length,
    losses: trades.filter((tr) => tr.netPnl < 0).length,
    grossPnl,
    charges,
    netPnl,
    investment,
    skips,
  };
}

/** Aggregate stats across replayed days (net of costs, unless noted). */
function summarizeDays(dayResults) {
  const days = dayResults.filter((d) => d && !d.skipped);
  const trades = days.flatMap((d) => d.trades || []);
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const netWin = wins.reduce((s, t) => s + t.netPnl, 0);
  const netLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const dailyNet = days.map((d) => ({ date: d.date, netPnl: d.netPnl }));
  for (const d of dailyNet) {
    equity += d.netPnl;
    if (equity > peak) peak = equity;
    if (peak - equity > maxDrawdown) maxDrawdown = peak - equity;
  }
  const byTicker = {};
  for (const t of trades) {
    const row = byTicker[t.ticker] || (byTicker[t.ticker] = { trades: 0, wins: 0, netPnl: 0 });
    row.trades += 1;
    if (t.netPnl > 0) row.wins += 1;
    row.netPnl = r2(row.netPnl + t.netPnl);
  }
  return {
    days: days.length,
    skippedDays: dayResults.length - days.length,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    flats: trades.length - wins.length - losses.length,
    winRate: trades.length ? r2((wins.length / trades.length) * 100) : null,
    avgWinNet: wins.length ? r2(netWin / wins.length) : null,
    avgLossNet: losses.length ? r2(netLoss / losses.length) : null,
    riskRewardNet: wins.length && losses.length ? r2((netWin / wins.length) / (netLoss / losses.length)) : null,
    profitFactorGross: grossLoss > 0 ? r2(grossWin / grossLoss) : grossWin > 0 ? null : null,
    profitFactorNet: netLoss > 0 ? r2(netWin / netLoss) : netWin > 0 ? null : null,
    grossPnl: r2(trades.reduce((s, t) => s + t.pnl, 0)),
    charges: r2(trades.reduce((s, t) => s + t.charges, 0)),
    netPnl: r2(trades.reduce((s, t) => s + t.netPnl, 0)),
    expectancyNet: trades.length ? r2(trades.reduce((s, t) => s + t.netPnl, 0) / trades.length) : null,
    maxDrawdown: r2(maxDrawdown),
    bestDay: dailyNet.length ? dailyNet.reduce((a, b) => (b.netPnl > a.netPnl ? b : a)) : null,
    worstDay: dailyNet.length ? dailyNet.reduce((a, b) => (b.netPnl < a.netPnl ? b : a)) : null,
    tradesPerDay: days.length ? r2(trades.length / days.length) : null,
    byTicker,
  };
}

/**
 * Day document in the live muhurat-history shape (paper/muhurat-history/days/)
 * so a backtest day diffs directly against a live day. `pnl`/`realizedPnl`
 * keep live semantics (gross of charges); net figures live under `backtest`.
 */
function dayDoc(result) {
  const trades = (result.trades || []).map((t) => ({
    ticker: t.ticker,
    mode: 'equity',
    key: t.key || null,
    qty: t.qty,
    entry: t.entry,
    exit: t.exit,
    spend: t.spend,
    pnl: t.pnl,
    exitReason: t.exitReason,
    status: 'CLOSED',
    buyAt: t.buyAt,
    sellAt: t.sellAt,
    right: null,
  }));
  return {
    date: result.date,
    updatedAt: new Date().toISOString(),
    investment: result.investment || 0,
    realizedPnl: result.grossPnl || 0,
    openInvestment: 0,
    trades,
    byMode: {
      equity: {
        investment: result.investment || 0,
        realizedPnl: result.grossPnl || 0,
        openInvestment: 0,
        tradeCount: trades.length,
      },
      options: { investment: 0, realizedPnl: 0, openInvestment: 0, tradeCount: 0 },
    },
    backtest: {
      source: 'muhurat-backtest-stocks',
      grossPnl: result.grossPnl || 0,
      charges: result.charges || 0,
      netPnl: result.netPnl || 0,
      wins: result.wins || 0,
      losses: result.losses || 0,
      skips: result.skips || {},
    },
  };
}

module.exports = {
  UNIVERSE,
  COST,
  intradayRoundTripCost,
  buildSymbolDay,
  buildRow,
  replayDay,
  summarizeDays,
  dayDoc,
};
