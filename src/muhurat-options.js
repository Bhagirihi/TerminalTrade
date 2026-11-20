'use strict';

// Muhurat Options lane — NIFTY 50 + BANKNIFTY ATM CE/PE only.
// Same session window / P > 12 / Live BUY rules as equity Muhurat, sized in lots.

const { SYMBOLS } = require('./config');
const { nearestListedStrike, nearestStepStrike } = require('./strikes');
const { istDateKey } = require('./time');
const { emaSeries, vwapSeries, dmiSeries } = require('./indicators');
const { supertrendSeries } = require('./supertrend');
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
  optionsInitialStop,
  optionsStopLossPct,
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

/** 15m momentum "train" — breakout trigger + TV indicator confirmation. */
function trainEnabled() {
  const v = String(process.env.MUHURAT_OPT_TRAIN || 'true').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

function optionsTrainStopPct() {
  const n = Number(process.env.MUHURAT_OPT_TRAIN_SL_PCT);
  return Number.isFinite(n) && n > 0 ? n : 8;
}

function trainMinConfirms() {
  const n = Number(process.env.MUHURAT_OPT_TRAIN_MIN_CONFIRM);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
}

function trainAdxFloor() {
  const n = Number(process.env.MUHURAT_OPT_TRAIN_ADX);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

function volumeSma(volumes, length) {
  const out = new Array(volumes.length).fill(NaN);
  for (let i = length - 1; i < volumes.length; i++) {
    let s = 0;
    for (let k = i - length + 1; k <= i; k++) s += volumes[k];
    out[i] = s / length;
  }
  return out;
}

function shiftIstDateKey(dayKey, deltaDays) {
  const base = Date.parse(`${dayKey}T12:00:00+05:30`);
  if (!Number.isFinite(base)) return dayKey;
  return istDateKey(base + deltaDays * 86400000);
}

/** Load ~1 week of 15m bars so ST/EMA/ADX/VWAP can seed. */
async function loadIndex15mBars(provider, symbol, dayKey) {
  const from = shiftIstDateKey(dayKey, -10);
  if (typeof provider.getMinuteCandles === 'function') {
    try {
      const rows = await provider.getMinuteCandles(symbol.upstoxKey, from, dayKey, 15, {
        isToday: true,
      });
      if (rows && rows.length) return rows;
    } catch (_) {
      /* fall through */
    }
  }
  if (typeof provider.getCandlesForDate !== 'function') return [];
  try {
    return (await provider.getCandlesForDate({ upstoxKey: symbol.upstoxKey }, dayKey, 15, true)) || [];
  } catch (_) {
    return [];
  }
}

/**
 * Detect bullish/bearish train on 15m bars.
 * Trigger = price-action breakout (don't wait for every indicator).
 * Confirm = Supertrend(10,3) · EMA9/21 · ADX(14) · VWAP · Volume SMA(20).
 * Need ≥2 confirms (env MUHURAT_OPT_TRAIN_MIN_CONFIRM); ride with ≥3 if no fresh breakout.
 */
function detectIndexTrain(candles15m, ltp) {
  const empty = {
    train: null,
    trainReason: '',
    trainLevel: null,
    bars: 0,
    confirms: [],
    indicators: null,
  };
  if (!trainEnabled()) return empty;
  if (!candles15m || candles15m.length < 30) {
    return {
      ...empty,
      trainReason: 'need ~30×15m bars',
      bars: candles15m ? candles15m.length : 0,
    };
  }

  const candles = candles15m;
  const i = candles.length - 1;
  const c = candles[i];
  const closes = candles.map((x) => Number(x.close));
  const volumes = candles.map((x) => (Number.isFinite(Number(x.volume)) ? Number(x.volume) : 0));
  const price = Number.isFinite(Number(ltp)) ? Number(ltp) : Number(c.close);

  const ema9 = emaSeries(closes, 9);
  const ema21 = emaSeries(closes, 21);
  const st = supertrendSeries(candles, 10, 3.0);
  const dmi = dmiSeries(candles, 14, 14);
  const vwap = vwapSeries(candles);
  const volSma20 = volumeSma(volumes, 20);

  const prior = candles.slice(Math.max(0, i - 12), Math.max(1, i - 1));
  const swingHigh = Math.max(...prior.map((x) => Number(x.high)).filter(Number.isFinite));
  const swingLow = Math.min(...prior.map((x) => Number(x.low)).filter(Number.isFinite));
  const brokeUp = Number.isFinite(swingHigh) && (price > swingHigh || Number(c.close) > swingHigh);
  const brokeDown = Number.isFinite(swingLow) && (price < swingLow || Number(c.close) < swingLow);

  const stGreen = st.direction[i] === -1;
  const stRed = st.direction[i] === 1;
  const emaBull = Number.isFinite(ema9[i]) && Number.isFinite(ema21[i]) && ema9[i] > ema21[i];
  const emaBear = Number.isFinite(ema9[i]) && Number.isFinite(ema21[i]) && ema9[i] < ema21[i];
  const emaCrossUp = emaBull && i > 0 && Number.isFinite(ema9[i - 1]) && Number.isFinite(ema21[i - 1])
    && ema9[i - 1] <= ema21[i - 1];
  const emaCrossDn = emaBear && i > 0 && Number.isFinite(ema9[i - 1]) && Number.isFinite(ema21[i - 1])
    && ema9[i - 1] >= ema21[i - 1];
  const aboveEmas = Number.isFinite(ema9[i]) && Number.isFinite(ema21[i])
    && price > ema9[i] && price > ema21[i];
  const belowEmas = Number.isFinite(ema9[i]) && Number.isFinite(ema21[i])
    && price < ema9[i] && price < ema21[i];
  const adxFloor = trainAdxFloor();
  const adxBull = Number.isFinite(dmi.adx[i]) && dmi.adx[i] >= adxFloor
    && Number.isFinite(dmi.plus[i]) && Number.isFinite(dmi.minus[i]) && dmi.plus[i] > dmi.minus[i];
  const adxBear = Number.isFinite(dmi.adx[i]) && dmi.adx[i] >= adxFloor
    && Number.isFinite(dmi.plus[i]) && Number.isFinite(dmi.minus[i]) && dmi.minus[i] > dmi.plus[i];
  const aboveVwap = Number.isFinite(vwap[i]) && price > vwap[i];
  const belowVwap = Number.isFinite(vwap[i]) && price < vwap[i];
  const volUp = Number.isFinite(volSma20[i]) && volSma20[i] > 0 && volumes[i] > volSma20[i];

  const bullConfirms = [];
  if (stGreen) bullConfirms.push('ST green');
  if (emaBull) bullConfirms.push(emaCrossUp ? 'EMA9×21↑' : 'EMA9>21');
  if (aboveEmas) bullConfirms.push('above EMAs');
  if (adxBull) bullConfirms.push(`ADX ${r2(dmi.adx[i])}+DI`);
  if (aboveVwap) bullConfirms.push('>VWAP');
  if (volUp && (brokeUp || emaCrossUp)) bullConfirms.push('vol>SMA20');

  const bearConfirms = [];
  if (stRed) bearConfirms.push('ST red');
  if (emaBear) bearConfirms.push(emaCrossDn ? 'EMA9×21↓' : 'EMA9<21');
  if (belowEmas) bearConfirms.push('below EMAs');
  if (adxBear) bearConfirms.push(`ADX ${r2(dmi.adx[i])}-DI`);
  if (belowVwap) bearConfirms.push('<VWAP');
  if (volUp && (brokeDown || emaCrossDn)) bearConfirms.push('vol>SMA20');

  const indicators = {
    st: stGreen ? 'green' : (stRed ? 'red' : null),
    stValue: r2(st.value[i]),
    ema9: r2(ema9[i]),
    ema21: r2(ema21[i]),
    adx: r2(dmi.adx[i]),
    plusDI: r2(dmi.plus[i]),
    minusDI: r2(dmi.minus[i]),
    vwap: r2(vwap[i]),
    volSma20: r2(volSma20[i]),
    volume: volumes[i],
  };

  const minC = trainMinConfirms();
  const base = {
    bars: candles.length,
    indicators,
    trainLevel: null,
    confirms: [],
  };

  // Trigger = breakout (+ optional fresh EMA cross). Confirms filter late/weak moves.
  if ((brokeUp || emaCrossUp) && bullConfirms.length >= minC) {
    return {
      ...base,
      train: 'CE',
      trainReason: brokeUp
        ? `breakout > ${r2(swingHigh)} + ${bullConfirms.join(', ')}`
        : `EMA cross + ${bullConfirms.join(', ')}`,
      trainLevel: r2(swingHigh),
      confirms: bullConfirms,
    };
  }
  if ((brokeDown || emaCrossDn) && bearConfirms.length >= minC) {
    return {
      ...base,
      train: 'PE',
      trainReason: brokeDown
        ? `breakdown < ${r2(swingLow)} + ${bearConfirms.join(', ')}`
        : `EMA cross + ${bearConfirms.join(', ')}`,
      trainLevel: r2(swingLow),
      confirms: bearConfirms,
    };
  }
  // Ride an established train without waiting for a new breakout every bar.
  if (bullConfirms.length >= minC + 1 && stGreen && emaBull && aboveVwap) {
    return {
      ...base,
      train: 'CE',
      trainReason: `ride ${bullConfirms.join(', ')}`,
      trainLevel: r2(swingHigh),
      confirms: bullConfirms,
    };
  }
  if (bearConfirms.length >= minC + 1 && stRed && emaBear && belowVwap) {
    return {
      ...base,
      train: 'PE',
      trainReason: `ride ${bearConfirms.join(', ')}`,
      trainLevel: r2(swingLow),
      confirms: bearConfirms,
    };
  }

  return {
    ...base,
    train: null,
    trainReason: brokeUp
      ? `breakout weak (${bullConfirms.length}/${minC})`
      : (brokeDown ? `breakdown weak (${bearConfirms.length}/${minC})` : ''),
    confirms: brokeUp ? bullConfirms : (brokeDown ? bearConfirms : []),
  };
}

function analyzeIndex(symbol, candles, ltp, trainInfo = null) {
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
  let score = scored.score + 2;
  const reasons = [...scored.reasons, 'index liquidity'];
  let bias = 'NEUTRAL';
  if (aboveSma && (d1 == null || d1 >= -0.3) && rsi != null && rsi >= 48) bias = 'CE';
  else if (!aboveSma || (d1 != null && d1 <= -0.4) || (rsi != null && rsi < 45)) bias = 'PE';

  const train = trainInfo && trainInfo.train ? trainInfo : null;
  if (train && train.train === 'CE') {
    bias = 'CE';
    score += 4;
    reasons.push(`TRAIN ${train.trainReason || '15m up'}`);
  } else if (train && train.train === 'PE') {
    bias = 'PE';
    score += 4;
    reasons.push(`TRAIN ${train.trainReason || '15m down'}`);
  }

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
    train: train ? train.train : null,
    trainReason: trainInfo ? (trainInfo.trainReason || '') : '',
    trainLevel: trainInfo ? trainInfo.trainLevel : null,
    trainConfirms: trainInfo && Array.isArray(trainInfo.confirms) ? trainInfo.confirms : [],
    trainIndicators: trainInfo ? trainInfo.indicators : null,
    score,
    reasons,
    bias,
  };
}

function premiumLevels(premium, tick = 0.05) {
  const entry = Number(premium);
  if (!(entry > 0)) return null;
  const round = (n) => Math.round(n / tick) * tick;
  // Hard rule: options SL = −5% of premium (env MUHURAT_OPT_SL_PCT).
  const stop = optionsInitialStop(entry, tick) != null
    ? optionsInitialStop(entry, tick)
    : round(entry * (1 - optionsStopLossPct() / 100));
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
  if (indexAnalyzed.train === right) {
    score += 5;
    reasons.push(`TRAIN ${right}`);
  } else if (indexAnalyzed.train && indexAnalyzed.train !== right) {
    score -= 8;
    reasons.push(`against TRAIN ${indexAnalyzed.train}`);
  }
  if (right === 'CE' && indexAnalyzed.aboveSma) score += 1;
  if (right === 'PE' && indexAnalyzed.aboveSma === false) score += 1;
  return { score, reasons };
}

function stopAtPct(entry, tick, pct) {
  const e = Number(entry);
  if (!(e > 0) || !(pct > 0)) return null;
  const step = Number(tick) > 0 ? Number(tick) : 0.05;
  return Math.round((e * (1 - pct / 100)) / step) * step;
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
  const onTrain = indexAnalyzed.train === right;
  const againstTrain = !!(indexAnalyzed.train && indexAnalyzed.train !== right);
  const tick = tickSize || 0.05;
  let levels = null;
  if (optCandles && optCandles.length >= 15) {
    levels = levelsFromCandles(optCandles, premium, 'options');
    // Force options hard SL at −5% of premium (ignore wider/tighter candle stop).
    // On 15m TRAIN matching side, give more room (−8% default).
    const forcedStop = onTrain
      ? stopAtPct(premium, tick, optionsTrainStopPct())
      : optionsInitialStop(premium, tick);
    if (forcedStop != null) levels.stopLoss = r2(forcedStop);
    const trail = trailPlan(premium, levels.stopLoss, levels.target1, levels.target2, premium, {
      mode: 'options',
      armHoldSec: 0,
    });
    Object.assign(levels, trail);
  } else {
    levels = premiumLevels(premium, tick);
    if (onTrain && levels) {
      const wider = stopAtPct(premium, tick, optionsTrainStopPct());
      if (wider != null) {
        levels.stopLoss = r2(wider);
        const trail = trailPlan(premium, levels.stopLoss, levels.target1, levels.target2, premium, {
          mode: 'options',
          armHoldSec: 0,
        });
        Object.assign(levels, trail);
      }
    }
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

  // Ride the 15m train: matching CE/PE gets easier BUY + never TOO HOT;
  // opposite side is blocked.
  let verdict = 'SKIP';
  if (againstTrain) {
    verdict = 'SKIP';
  } else if (onTrain) {
    if (sideScore.score >= 6) verdict = 'BUY';
    else if (sideScore.score >= 4) verdict = 'WATCH';
  } else if (sideScore.score >= 8 && indexAnalyzed.rsi != null && indexAnalyzed.rsi <= 72) {
    verdict = 'BUY';
  } else if (sideScore.score >= 5) {
    verdict = 'WATCH';
  } else if (indexAnalyzed.rsi != null && indexAnalyzed.rsi > 75 && right === 'CE') {
    verdict = 'TOO HOT';
  }

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
    train: indexAnalyzed.train || null,
    trainReason: indexAnalyzed.trainReason || '',
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

function optionsLotRule() {
  // 1-lot premium cost (LTP × lot size):
  //   below ₹5k  → 2 lots
  //   ₹5k+ (incl. above ₹10k) → 1 lot
  const twoLotBelow = Number(process.env.MUHURAT_OPT_TWO_LOT_BELOW);
  const oneLotFrom = Number(process.env.MUHURAT_OPT_ONE_LOT_FROM);
  return {
    twoLotBelow: Number.isFinite(twoLotBelow) && twoLotBelow > 0 ? twoLotBelow : 5000,
    oneLotFrom: Number.isFinite(oneLotFrom) && oneLotFrom > 0 ? oneLotFrom : 10000,
  };
}

function wantedOptionsLots(lotCost) {
  const { twoLotBelow } = optionsLotRule();
  if (!(lotCost > 0)) return 0;
  // Below ₹5k → 2 lots; at/above ₹5k (and above ₹10k) → 1 lot.
  return lotCost < twoLotBelow ? 2 : 1;
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
  // Hard cap = configured options budget only (do not inflate with margin twice).
  // plan.budget already includes availableMargin from allocateBudget — do not add it again.
  const hardCap = Number(budget) > 0 ? Number(budget) : DEFAULT_BUDGET;
  const unaffordable = [];
  for (const pick of plan.picks || []) {
    const lot = Number(pick.lotSize) || 1;
    const ltp = Number(pick.ltp);
    if (!(ltp > 0) || !(lot > 0)) continue;
    const lotCost = ltp * lot;
    const left = hardCap - used;
    let lots = wantedOptionsLots(lotCost);
    // Fit into remaining options budget (never exceed hardCap).
    while (lots > 1 && lots * lotCost > left + 1) lots -= 1;
    if (lots < 1 || lots * lotCost > left + 1) {
      unaffordable.push({
        ticker: pick.ticker,
        need: Math.ceil(lotCost),
        budget: hardCap,
        wantLots: wantedOptionsLots(lotCost),
      });
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
    budget: r2(hardCap),
    used: r2(used),
    left: r2(Math.max(0, hardCap - used)),
    pickCount: picks.length,
    picks,
    byTicker,
    unaffordable: unaffordable.slice(0, 6),
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
    let trainInfo = null;
    if (phaseInfo.phase !== 'before_open') {
      try {
        const c15 = await loadIndex15mBars(provider, symbol, phaseInfo.day);
        trainInfo = detectIndexTrain(c15, indexLtp);
      } catch (_) {
        trainInfo = null;
      }
    }
    const indexAnalyzed = analyzeIndex(symbol, candles, indexLtp, trainInfo);
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
      pickRule: `Options Live BUY CE / BUY PE only (never sell-to-open) · ATM · P > 12 · lots · 15m TRAIN rides matching side (no TOO HOT) · max ${maxTradesPerDay('options') || '∞'}/day.`,
      maxTrades: maxTradesPerDay('options'),
      underlyings: 'NIFTY 50 + BANKNIFTY only',
      entry: 'BUY CE or BUY PE only if premium holds above session open · ride 15m index TRAIN (CE/PE)',
      initialStop: `Hard SL −${optionsStopLossPct()}% of premium (−${optionsTrainStopPct()}% on TRAIN) — exit if hit`,
      trailOptions: '+5% → cost · +10% lock · then +5% steps',
      hardExit: `Square off by ${SESSION.exitBy} IST`,
      instruments: 'Nearest expiry ATM CE and PE — long premium only',
      train: trainEnabled()
        ? `15m breakout trigger + ST(10,3)/EMA9·21/ADX14/VWAP/VolSMA20 (≥${trainMinConfirms()} confirms)`
        : 'off',
    },
  };
}

function patchOptionsBookLtps(book, ltpByKey, priorBook = null, positions = null) {
  if (!book || !ltpByKey) return book;
  const { patchBookLtps } = require('./muhurat');
  return patchBookLtps(book, ltpByKey, priorBook, positions);
}

module.exports = {
  buildMuhuratOptionsBook,
  allocateOptionsBudget,
  wantedOptionsLots,
  optionsLotRule,
  analyzeIndex,
  detectIndexTrain,
  loadIndex15mBars,
  trainEnabled,
  trainMinConfirms,
  optionsTrainStopPct,
  premiumLevels,
  scoreOptionSide,
  patchOptionsBookLtps,
  loadOptionBook,
};
