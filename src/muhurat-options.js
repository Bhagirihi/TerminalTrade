'use strict';

// Muhurat Options lane — NIFTY 50 + BANKNIFTY ATM CE/PE only.
// Same session window / P > 12 / Live BUY rules as equity Muhurat, sized in lots.

const { SYMBOLS } = require('./config');
const { nearestListedStrike, nearestStepStrike } = require('./strikes');
const { istDateKey } = require('./time');
const {
  SESSION,
  DEFAULT_BUDGET,
  sessionPhase,
  applySessionVerdict,
  profitMetrics,
  levelsFromCandles,
  trailPlan,
  allocateBudget,
  scoreRow,
  maxTradesPerDay,
} = require('./muhurat');
const { screenHolding } = require('./portfolio-screen');

function r2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function smaLast(values, window) {
  if (!values || values.length < window) return null;
  let sum = 0;
  for (let i = values.length - window; i < values.length; i++) sum += values[i];
  return sum / window;
}

function atr14(candles) {
  if (!candles || candles.length < 15) return null;
  let sum = 0;
  for (let i = candles.length - 14; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    sum += tr;
  }
  return sum / 14;
}

async function loadOptionBook(provider, symbol, today) {
  const contracts = await provider.getOptionContracts(symbol.upstoxKey);
  const expiries = [...new Set(contracts.map((c) => c.expiry))].filter((e) => e >= today).sort();
  const expiry = expiries[0];
  if (!expiry) throw new Error(`No upcoming expiry for ${symbol.id}`);
  const listed = contracts.filter((c) => c.expiry === expiry);
  const strikes = [...new Set(listed.map((c) => Number(c.strike_price)))].filter(Number.isFinite).sort((a, b) => a - b);
  const instruments = {};
  const lotByKey = {};
  const metaByKey = {};
  for (const c of listed) {
    const k = `${c.strike_price}|${c.instrument_type}`;
    instruments[k] = c.instrument_key;
    lotByKey[c.instrument_key] = Number(c.lot_size) || symbol.lotSize;
    metaByKey[c.instrument_key] = {
      tradingSymbol: c.trading_symbol,
      strike: Number(c.strike_price),
      right: c.instrument_type,
      lotSize: Number(c.lot_size) || symbol.lotSize,
      tickSize: Number(c.tick_size) || 0.05,
    };
  }
  let chainLtp = {};
  try {
    const chain = await provider.getOptionChain(symbol.upstoxKey, expiry);
    for (const row of chain || []) {
      for (const side of [
        ['call_options', 'CE'],
        ['put_options', 'PE'],
      ]) {
        const [field, right] = side;
        const opt = row[field];
        const px = opt && opt.market_data && Number(opt.market_data.ltp);
        if (opt && opt.instrument_key && Number.isFinite(px)) chainLtp[opt.instrument_key] = px;
      }
    }
  } catch (_) {
    chainLtp = {};
  }
  return { expiry, strikes, instruments, lotByKey, metaByKey, chainLtp };
}

function analyzeIndex(symbol, candles, ltp) {
  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1];
  const price = Number.isFinite(ltp) ? ltp : last;
  const screened = screenHolding({ ticker: symbol.id, buyPrice: price, quantity: 1, closes });
  const sma50 = screened.sma50 != null ? screened.sma50 : r2(smaLast(closes, 50));
  const rsi = screened.rsi;
  const d1 = closes.length > 1 ? ((last - closes[closes.length - 2]) / closes[closes.length - 2]) * 100 : null;
  const d5 = closes.length > 5 ? ((last - closes[closes.length - 6]) / closes[closes.length - 6]) * 100 : null;
  const atr = atr14(candles);
  const atrPct = atr != null && price ? (atr / price) * 100 : null;
  const distSma = sma50 ? ((price - sma50) / sma50) * 100 : null;
  const aboveSma = sma50 != null ? price > sma50 : false;
  const scored = scoreRow({
    aboveSma,
    rsi,
    d1: d1 || 0,
    d5: d5 || 0,
    distSma,
    atrPct,
    ticker: symbol.id,
  });
  // Index options are always liquid — mirror MEGA bump without faking an equity ticker.
  const score = scored.score + 2;
  const reasons = [...scored.reasons, 'index liquidity'];
  let bias = 'NEUTRAL';
  if (aboveSma && (d1 == null || d1 >= -0.3) && rsi != null && rsi >= 48) bias = 'CE';
  else if (!aboveSma || (d1 != null && d1 <= -0.4) || (rsi != null && rsi < 45)) bias = 'PE';
  return {
    indexId: symbol.id,
    indexLtp: r2(price),
    sma50: r2(sma50),
    rsi: r2(rsi),
    d1: r2(d1),
    d5: r2(d5),
    atrPct: r2(atrPct),
    distSma: r2(distSma),
    aboveSma,
    score,
    reasons,
    bias,
  };
}

function premiumLevels(premium, tick = 0.05) {
  const entry = Number(premium);
  if (!(entry > 0)) return null;
  const round = (n) => Math.round(n / tick) * tick;
  const stop = round(Math.max(entry * 0.72, entry - Math.max(entry * 0.28, 8)));
  const t1 = round(entry * 1.22);
  const t2 = round(entry * 1.45);
  const trail = trailPlan(entry, stop, t1, t2, entry, { mode: 'options', armHoldSec: 0 });
  return {
    support: r2(round(entry * 0.85)),
    resistance: r2(t1),
    resistanceNext: r2(t2),
    stopLoss: r2(stop),
    target1: r2(t1),
    target2: r2(t2),
    ...trail,
  };
}

function scoreOptionSide(indexAnalyzed, right) {
  let score = Number(indexAnalyzed.score) || 0;
  const reasons = [...(indexAnalyzed.reasons || [])];
  if (indexAnalyzed.bias === right) {
    score += 4;
    reasons.push(`${right} bias`);
  } else if (indexAnalyzed.bias === 'NEUTRAL') {
    score += 1;
    reasons.push('neutral index');
  } else {
    score -= 3;
    reasons.push(`against ${indexAnalyzed.bias} bias`);
  }
  if (right === 'CE' && indexAnalyzed.aboveSma) score += 1;
  if (right === 'PE' && indexAnalyzed.aboveSma === false) score += 1;
  return { score, reasons };
}

function buildOptionRow({
  symbol,
  right,
  strike,
  key,
  tradingSymbol,
  lotSize,
  tickSize,
  premium,
  indexAnalyzed,
  optCandles,
  phaseInfo,
  openPx,
}) {
  const sideScore = scoreOptionSide(indexAnalyzed, right);
  let levels = null;
  if (optCandles && optCandles.length >= 15) {
    levels = levelsFromCandles(optCandles, premium, 'options');
    // Candle-based SL/T1/T2 kept; trail must follow options step-lock rules.
    const trail = trailPlan(premium, levels.stopLoss, levels.target1, levels.target2, premium, {
      mode: 'options',
      armHoldSec: 0,
    });
    Object.assign(levels, trail);
  } else {
    levels = premiumLevels(premium, tickSize || 0.05);
  }
  if (!levels) {
    return applySessionVerdict({
      ticker: `${symbol.id} ${strike} ${right}`,
      key,
      indexId: symbol.id,
      right,
      strike,
      lotSize,
      tradingSymbol,
      error: 'no premium',
      verdict: 'ERROR',
      score: -99,
      mode: 'options',
    }, phaseInfo, null);
  }

  let verdict = 'SKIP';
  if (sideScore.score >= 8 && indexAnalyzed.rsi != null && indexAnalyzed.rsi <= 72) verdict = 'BUY';
  else if (sideScore.score >= 5) verdict = 'WATCH';
  else if (indexAnalyzed.rsi != null && indexAnalyzed.rsi > 75 && right === 'CE') verdict = 'TOO HOT';

  const row = {
    ticker: `${symbol.id} ${strike} ${right}`,
    key,
    indexId: symbol.id,
    right,
    strike,
    lotSize,
    tradingSymbol,
    sleeve: `${symbol.id} ATM ${right}`,
    mode: 'options',
    core: true,
    ltp: r2(premium),
    indexLtp: indexAnalyzed.indexLtp,
    sma50: indexAnalyzed.sma50,
    rsi: indexAnalyzed.rsi,
    d1: indexAnalyzed.d1,
    d5: indexAnalyzed.d5,
    atrPct: indexAnalyzed.atrPct,
    distSma: indexAnalyzed.distSma,
    aboveSma: indexAnalyzed.aboveSma,
    bias: indexAnalyzed.bias,
    score: sideScore.score,
    reasons: sideScore.reasons,
    verdict,
    levels,
    riskPct: r2(((levels.stopLoss - premium) / premium) * 100),
    reward1Pct: r2(((levels.target1 - premium) / premium) * 100),
    expiry: null,
  };
  Object.assign(row, profitMetrics(row));
  // Liquidity bump for index options
  row.profitScore = r2((Number(row.profitScore) || 0) + 2);
  return applySessionVerdict(row, phaseInfo, openPx);
}

function allocateOptionsBudget(budget, rows, {
  availableMargin = null,
  stickyTickers = [],
  day = null,
  now = Date.now(),
} = {}) {
  // Reuse equity allocator but force qty to lot multiples afterward.
  // Options cap is separate (default 2 trades/day).
  const plan = allocateBudget(budget, rows, {
    availableMargin,
    mode: 'options',
    maxTrades: maxTradesPerDay('options'),
    stickyTickers,
    day,
    now,
  });
  const byTicker = { ...(plan.byTicker || {}) };
  const picks = [];
  let used = 0;
  for (const pick of plan.picks || []) {
    const lot = Number(pick.lotSize) || 1;
    const ltp = Number(pick.ltp);
    if (!(ltp > 0) || !(lot > 0)) continue;
    const lotCost = ltp * lot;
    const cash = Number((byTicker[pick.ticker] && byTicker[pick.ticker].cash) || pick.spend || 0);
    let lots = Math.floor(cash / lotCost);
    if (lots < 1 && lotCost <= (Number(plan.budget) + (Number(availableMargin) || 0)) + 1) {
      // Ensure at least 1 lot if the name was seated and a single lot fits deployable cash.
      const deployable = Number(plan.budget) + (Number.isFinite(Number(availableMargin)) ? Number(availableMargin) : 0);
      if (lotCost <= deployable - used + 1) lots = 1;
    }
    if (lots < 1) {
      delete byTicker[pick.ticker];
      continue;
    }
    const qty = lots * lot;
    const spend = r2(qty * ltp);
    const t1 = Number(pick.sellT1 != null ? pick.sellT1 : pick.levels && pick.levels.target1);
    const expectedT1 = Number.isFinite(t1) ? r2(qty * (t1 - ltp)) : 0;
    byTicker[pick.ticker] = {
      ...byTicker[pick.ticker],
      qty,
      spend,
      cash: spend,
      lots,
      lotSize: lot,
      expectedT1,
      profitScore: pick.profitScore,
    };
    picks.push({
      ...pick,
      qty,
      spend,
      allocCash: spend,
      lots,
      expectedT1,
      buy: 'YES',
      action: 'BUY',
      verdict: 'BUY',
    });
    used += spend;
  }
  return {
    ...plan,
    used: r2(used),
    left: r2(Math.max(0, Number(plan.budget) - used)),
    pickCount: picks.length,
    picks,
    byTicker,
    expectedT1: r2(picks.reduce((s, p) => s + (Number(p.expectedT1) || 0), 0)),
  };
}

async function buildMuhuratOptionsBook(provider, {
  fromDate,
  toDate,
  budget,
  availableMargin = null,
  now = Date.now(),
  stickyTickers = [],
} = {}) {
  const phaseInfo = sessionPhase(now);
  const today = istDateKey(now);
  const planBudget = Number(budget) > 0 ? Number(budget) : DEFAULT_BUDGET;

  const indexKeys = SYMBOLS.map((s) => s.upstoxKey);
  let indexLtpMap = new Map();
  try {
    indexLtpMap = await provider.getLtps(indexKeys);
  } catch (_) {
    indexLtpMap = new Map();
  }

  const all = [];
  const indexes = [];
  const instrumentKeys = [];

  for (const symbol of SYMBOLS) {
    let candles;
    try {
      candles = await provider.getDailyCandles(symbol.upstoxKey, fromDate, toDate);
    } catch (e) {
      indexes.push({ indexId: symbol.id, error: e.message.slice(0, 120) });
      continue;
    }
    if (!candles || candles.length < 20) {
      indexes.push({ indexId: symbol.id, error: `only ${candles ? candles.length : 0} bars` });
      continue;
    }
    const indexLtp = indexLtpMap.get(symbol.upstoxKey);
    const indexAnalyzed = analyzeIndex(symbol, candles, indexLtp);
    indexes.push(indexAnalyzed);

    let book;
    try {
      book = await loadOptionBook(provider, symbol, today);
    } catch (e) {
      indexes[indexes.length - 1].optionError = e.message.slice(0, 120);
      continue;
    }

    const stepStrike = nearestStepStrike(indexAnalyzed.indexLtp, symbol.strikeStep);
    const atm = nearestListedStrike(indexAnalyzed.indexLtp, book.strikes) || stepStrike;
    if (atm == null) continue;

    for (const right of ['CE', 'PE']) {
      const key = book.instruments[`${atm}|${right}`];
      if (!key) continue;
      instrumentKeys.push(key);
      const meta = book.metaByKey[key] || {};
      let premium = book.chainLtp[key];
      if (!Number.isFinite(premium)) {
        try {
          const m = await provider.getLtps([key]);
          premium = m.get(key);
        } catch (_) {
          premium = null;
        }
      }
      let optCandles = null;
      try {
        optCandles = await provider.getDailyCandles(key, fromDate, toDate);
      } catch (_) {
        optCandles = null;
      }
      let openPx = null;
      if (phaseInfo.phase !== 'before_open' && typeof provider.getCandlesForDate === 'function') {
        try {
          const mins = await provider.getCandlesForDate({ upstoxKey: key }, phaseInfo.day, 1, true);
          if (mins && mins.length) openPx = mins[0].open;
        } catch (_) {
          openPx = null;
        }
      }
      const row = buildOptionRow({
        symbol,
        right,
        strike: atm,
        key,
        tradingSymbol: meta.tradingSymbol || `${symbol.id} ${atm} ${right}`,
        lotSize: meta.lotSize || symbol.lotSize,
        tickSize: meta.tickSize || (symbol.id === 'NIFTY' ? 0.05 : 0.05),
        premium,
        indexAnalyzed,
        optCandles,
        phaseInfo,
        openPx,
      });
      row.expiry = book.expiry;
      all.push(row);
    }
  }

  const budgetPlan = phaseInfo.canDecideBuy
    ? allocateOptionsBudget(planBudget, all, {
      availableMargin,
      stickyTickers,
      day: phaseInfo.day,
      now,
    })
    : {
      budget: planBudget,
      used: 0,
      left: planBudget,
      byTicker: {},
      pickCount: 0,
      expectedT1: 0,
      picks: [],
      confirming: [],
      watchFilled: [],
      availableMargin: availableMargin || null,
    };

  const liveBuys = phaseInfo.canDecideBuy ? (budgetPlan.picks || []) : [];
  const liveTickers = new Set(liveBuys.map((r) => r.ticker));

  for (const row of all) {
    const a = budgetPlan.byTicker[row.ticker];
    if (a) {
      row.qty = a.qty;
      row.lots = a.lots;
      row.spend = a.spend;
      row.allocCash = a.cash;
      row.profitScore = a.profitScore;
      row.expectedT1 = a.expectedT1;
      row.verdict = 'BUY';
      row.buy = 'YES';
      row.action = 'BUY';
    } else {
      row.qty = 0;
      row.lots = 0;
      row.spend = 0;
      row.allocCash = 0;
      row.expectedT1 = 0;
      if (row.profitScore == null) Object.assign(row, profitMetrics(row));
    }
  }

  const watchlist = all
    .filter((r) => !liveTickers.has(r.ticker) && Number(r.profitScore) > 12)
    .filter((r) => r.verdict === 'WATCH' || r.verdict === 'BUY' || r.verdict === 'PREP')
    .sort((a, b) => (Number(b.profitScore) || -99) - (Number(a.profitScore) || -99));

  const prep = all
    .filter((r) => r.verdict === 'PREP' && Number(r.profitScore) > 12)
    .sort((a, b) => (Number(b.profitScore) || -99) - (Number(a.profitScore) || -99));

  return {
    mode: 'options',
    session: SESSION,
    phase: phaseInfo,
    indexes,
    core: all.sort((a, b) => (Number(b.profitScore) || -99) - (Number(a.profitScore) || -99)),
    liveBuys: liveBuys.filter((r) => Number(r.profitScore) > 12)
      .sort((a, b) => (Number(b.profitScore) || -99) - (Number(a.profitScore) || -99)),
    prep,
    extrasBuy: liveBuys,
    extrasWatch: watchlist,
    extrasSkipHot: all.filter((r) => r.verdict === 'TOO HOT').slice(0, 6),
    topGainers: [],
    screened: all.length,
    instrumentKeys: [...new Set(instrumentKeys)],
    asOf: toDate,
    budget: budgetPlan,
    rules: {
      budget: planBudget,
      pickRule: `Options Live BUY = ATM CE/PE with P > 12, sized in lots · max ${maxTradesPerDay('options') || '∞'} trades/day.`,
      maxTrades: maxTradesPerDay('options'),
      underlyings: 'NIFTY 50 + BANKNIFTY only',
      entry: 'Buy option only if premium holds above session open (when available)',
      hardExit: `Square off by ${SESSION.exitBy} IST`,
      instruments: 'Nearest expiry ATM CE and PE',
    },
  };
}

function patchOptionsBookLtps(book, ltpByKey) {
  if (!book || !ltpByKey) return book;
  const { patchBookLtps } = require('./muhurat');
  return patchBookLtps(book, ltpByKey);
}

module.exports = {
  buildMuhuratOptionsBook,
  allocateOptionsBudget,
  analyzeIndex,
  premiumLevels,
  scoreOptionSide,
  patchOptionsBookLtps,
  loadOptionBook,
};
