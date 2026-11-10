'use strict';

// Same-session long screen (signals only — no orders unless live bot is armed).
// Regular NSE day by default; Diwali Muhurat window via MUHURAT_SESSION=muhurat.
// Core five + other liquid names scored with hard exit 15:15 IST.

require('./config'); // load .env so MUHURAT_SESSION is visible
const { screenHolding } = require('./portfolio-screen');
const { istDateKey, istToEpoch, istTimeStr } = require('./time');
const { fetchTopGainerCandidates, rankByUpstoxDayChange } = require('./top-gainers');
const {
  confirmSec,
  loadConfirmLedger,
  saveConfirmLedger,
  updateConfirmLedger,
  seatWithConfirm,
} = require('./muhurat-confirm');

const CORE = [
  { ticker: 'SBIN', key: 'NSE_EQ|INE062A01020', sleeve: 'Bank — primary' },
  { ticker: 'AXISBANK', key: 'NSE_EQ|INE238A01034', sleeve: 'Bank — primary' },
  { ticker: 'TATASTEEL', key: 'NSE_EQ|INE081A01020', sleeve: 'Metals' },
  { ticker: 'HINDALCO', key: 'NSE_EQ|INE038A01020', sleeve: 'Metals' },
  { ticker: 'HINDUNILVR', key: 'NSE_EQ|INE030A01027', sleeve: 'Defensive' },
];

const EXTRA = [
  { ticker: 'RELIANCE', key: 'NSE_EQ|INE002A01018' },
  { ticker: 'HDFCBANK', key: 'NSE_EQ|INE040A01034' },
  { ticker: 'ICICIBANK', key: 'NSE_EQ|INE090A01021' },
  { ticker: 'INFY', key: 'NSE_EQ|INE009A01021' },
  { ticker: 'TCS', key: 'NSE_EQ|INE467B01029' },
  { ticker: 'BHARTIARTL', key: 'NSE_EQ|INE397D01024' },
  { ticker: 'ITC', key: 'NSE_EQ|INE154A01025' },
  { ticker: 'LT', key: 'NSE_EQ|INE018A01030' },
  { ticker: 'NTPC', key: 'NSE_EQ|INE733E01010' },
  { ticker: 'POWERGRID', key: 'NSE_EQ|INE752E01010' },
  { ticker: 'ONGC', key: 'NSE_EQ|INE213A01029' },
  { ticker: 'JSWSTEEL', key: 'NSE_EQ|INE019A01038' },
  { ticker: 'BEL', key: 'NSE_EQ|INE263A01024' },
  { ticker: 'HAL', key: 'NSE_EQ|INE066F01020' },
  { ticker: 'MARUTI', key: 'NSE_EQ|INE585B01010' },
  { ticker: 'M&M', key: 'NSE_EQ|INE101A01026' },
  { ticker: 'SUNPHARMA', key: 'NSE_EQ|INE044A01036' },
  { ticker: 'TITAN', key: 'NSE_EQ|INE280A01028' },
  { ticker: 'ASIANPAINT', key: 'NSE_EQ|INE021A01026' },
  { ticker: 'ULTRACEMCO', key: 'NSE_EQ|INE481G01011' },
  { ticker: 'WIPRO', key: 'NSE_EQ|INE075A01022' },
  { ticker: 'HCLTECH', key: 'NSE_EQ|INE860A01027' },
  { ticker: 'ADANIENT', key: 'NSE_EQ|INE423A01024' },
  { ticker: 'ADANIPORTS', key: 'NSE_EQ|INE742F01042' },
  { ticker: 'EICHERMOT', key: 'NSE_EQ|INE066A01021' },
  { ticker: 'BAJAJ-AUTO', key: 'NSE_EQ|INE917I01010' },
  { ticker: 'INDIGO', key: 'NSE_EQ|INE646L01027' },
  { ticker: 'COALINDIA', key: 'NSE_EQ|INE522F01014' },
];

const MEGA = new Set([
  'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'SBIN', 'ITC', 'BHARTIARTL',
  'LT', 'AXISBANK', 'TATASTEEL', 'NTPC', 'POWERGRID', 'HINDUNILVR', 'MARUTI', 'M&M',
  'HINDALCO', 'JSWSTEEL',
]);

// Session clocks (IST). Default = regular NSE day; set MUHURAT_SESSION=muhurat for Diwali Muhurat window.
const SCHEDULES = {
  regular: {
    mode: 'regular',
    open: '09:15',
    decide: '09:25',
    exitBy: '15:15',
    close: '15:30',
    openH: 9,
    openM: 15,
    decideH: 9,
    decideM: 25,
    exitH: 15,
    exitM: 15,
    closeH: 15,
    closeM: 30,
    label: 'Regular · open 9:15 · buy after 9:25 · hard exit 3:15 IST',
  },
  muhurat: {
    mode: 'muhurat',
    open: '14:20',
    decide: '14:30',
    exitBy: '15:15',
    close: '15:30',
    openH: 14,
    openM: 20,
    decideH: 14,
    decideM: 30,
    exitH: 15,
    exitM: 15,
    closeH: 15,
    closeM: 30,
    label: 'Muhurat · buy 2:20 · hard exit 3:15 IST',
  },
};

function sessionMode() {
  const raw = String(process.env.MUHURAT_SESSION || '').trim().toLowerCase();
  if (raw === 'muhurat' || raw === 'special') return 'muhurat';
  if (raw === 'regular' || raw === 'normal' || raw === 'day') return 'regular';
  if (process.env.npm_config_muhurat === 'true' || process.env.npm_config_Muhurat === 'true') return 'muhurat';
  if (process.env.npm_config_regular === 'true' || process.env.npm_config_Regular === 'true') return 'regular';
  const argv = process.argv || [];
  if (argv.some((a) => /^--?Muhurat$/i.test(String(a)) || String(a) === 'Muhurat')) return 'muhurat';
  if (argv.some((a) => /^--?Regular$/i.test(String(a)) || String(a) === 'Regular')) return 'regular';
  return 'regular';
}

function getSession(mode = sessionMode()) {
  return SCHEDULES[mode] || SCHEDULES.regular;
}

// Dynamic so UI/checks always see the active schedule.
const SESSION = {
  get mode() { return getSession().mode; },
  get open() { return getSession().open; },
  get decide() { return getSession().decide; },
  get exitBy() { return getSession().exitBy; },
  get close() { return getSession().close; },
  get label() { return getSession().label; },
};

// ₹ budget for live picks only (filled after market open — not pre-chosen names).
// BUY + Watch (P > 12) compete by profitScore, capped per mode:
// stocks default 5/day, options default 2/day.
const DEFAULT_BUDGET = 20000;
const DEFAULT_MAX_TRADES = 5; // stocks (legacy alias)
const DEFAULT_MAX_TRADES_STOCK = 5;
const DEFAULT_MAX_TRADES_OPTIONS = 2;
const MAX_LIVE_BUYS = DEFAULT_MAX_TRADES_STOCK; // legacy export alias

function parseTradeCap(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n); // 0 = unlimited
}

function maxLiveBuys() {
  return maxTradesPerDay('equity');
}

function maxTradesPerDay(mode = 'equity') {
  const options = mode === 'options' || mode === 'option';
  if (options) {
    // MUHURAT_MAX_TRADES_OPTIONS, else legacy MUHURAT_MAX_TRADES only if explicitly set for options runs.
    if (process.env.MUHURAT_MAX_TRADES_OPTIONS != null && process.env.MUHURAT_MAX_TRADES_OPTIONS !== '') {
      return parseTradeCap(process.env.MUHURAT_MAX_TRADES_OPTIONS, DEFAULT_MAX_TRADES_OPTIONS);
    }
    return DEFAULT_MAX_TRADES_OPTIONS;
  }
  // Stocks: MUHURAT_MAX_TRADES_STOCK → MUHURAT_MAX_TRADES → MUHURAT_MAX_NAMES → 5
  if (process.env.MUHURAT_MAX_TRADES_STOCK != null && process.env.MUHURAT_MAX_TRADES_STOCK !== '') {
    return parseTradeCap(process.env.MUHURAT_MAX_TRADES_STOCK, DEFAULT_MAX_TRADES_STOCK);
  }
  if (process.env.MUHURAT_MAX_TRADES != null && process.env.MUHURAT_MAX_TRADES !== '') {
    return parseTradeCap(process.env.MUHURAT_MAX_TRADES, DEFAULT_MAX_TRADES_STOCK);
  }
  if (process.env.MUHURAT_MAX_NAMES != null && process.env.MUHURAT_MAX_NAMES !== '') {
    return parseTradeCap(process.env.MUHURAT_MAX_NAMES, DEFAULT_MAX_TRADES_STOCK);
  }
  return DEFAULT_MAX_TRADES_STOCK;
}

function r2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function roundTick(n, tick = 0.05) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n / tick) * tick;
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

function scoreRow({ aboveSma, rsi, d1, d5, distSma, atrPct, ticker }) {
  let score = 0;
  const reasons = [];
  if (aboveSma) {
    score += 2;
    reasons.push('above SMA50');
  } else {
    score -= 2;
    reasons.push('below SMA50');
  }
  if (rsi != null && rsi >= 45 && rsi <= 68) {
    score += 2;
    reasons.push('RSI mid-strong');
  } else if (rsi != null && rsi > 68 && rsi <= 75) {
    reasons.push('RSI warm');
  } else if (rsi != null && rsi > 75) {
    score -= 3;
    reasons.push('RSI overbought');
  } else if (rsi != null && rsi < 40) {
    score -= 1;
    reasons.push('RSI weak');
  }
  if (d1 > 0.3) {
    score += 1;
    reasons.push('green day');
  } else if (d1 < -1.5) {
    score -= 2;
    reasons.push('hard red day');
  }
  if (d5 > 3 && d5 < 15) {
    score += 2;
    reasons.push('healthy 5d');
  } else if (d5 >= 15) {
    score -= 1;
    reasons.push('5d extended');
  } else if (d5 < 0) {
    score -= 1;
    reasons.push('5d down');
  }
  if (distSma != null && distSma > 0 && distSma < 8) {
    score += 1;
    reasons.push('near SMA room');
  } else if (distSma != null && distSma >= 12) {
    score -= 1;
    reasons.push('far above SMA');
  }
  if (atrPct != null && atrPct >= 1.5 && atrPct <= 3.5) {
    score += 1;
    reasons.push('tradable ATR');
  }
  if (MEGA.has(ticker)) {
    score += 2;
    reasons.push('high liquidity');
  }
  return { score, reasons };
}

function levelsFromCandles(candles, ltp, mode = 'equity') {
  const last = candles[candles.length - 1];
  const entry = Number.isFinite(ltp) ? ltp : last.close;
  const recent5 = candles.slice(-5);
  const recent10 = candles.slice(-10);
  const low5 = Math.min(...recent5.map((c) => c.low));
  const high5 = Math.max(...recent5.map((c) => c.high));
  const low10 = Math.min(...recent10.map((c) => c.low));
  const high10 = Math.max(...recent10.map((c) => c.high));

  const pivot = (last.high + last.low + last.close) / 3;
  const r1 = 2 * pivot - last.low;
  const s1 = 2 * pivot - last.high;
  const r2p = pivot + (last.high - last.low);

  const support = roundTick(Math.max(s1, low5));
  const resistance = roundTick(high5 <= entry * 1.002 ? Math.max(high5, r1) : Math.min(r1, high5));
  const resistanceNext = roundTick(Math.max(r1, r2p, high10));

  let stop = entry * 0.992;
  const structural = support != null ? support * 0.998 : stop;
  stop = Math.max(structural, entry * 0.991);
  stop = Math.min(stop, entry * 0.996);
  stop = roundTick(stop);

  let t1 = roundTick(Math.max(entry * 1.005, entry + (resistance - entry) * 0.35));
  if (resistance > entry) t1 = roundTick(Math.min(t1, resistance));
  else t1 = roundTick(entry * 1.005);

  let t2 = roundTick(Math.max(entry * 1.008, t1 + (entry - stop)));
  if (resistanceNext > entry) t2 = roundTick(Math.min(Math.max(t2, entry * 1.008), resistanceNext));
  if (t2 <= t1) t2 = roundTick(entry * 1.01);

  const trail = trailPlan(entry, stop, t1, t2, entry, { mode });
  return {
    support: r2(support),
    resistance: r2(resistance),
    resistanceNext: r2(resistanceNext),
    stopLoss: r2(stop),
    target1: r2(t1),
    target2: r2(t2),
    pivot: r2(pivot),
    s1: r2(roundTick(s1)),
    r1: r2(roundTick(r1)),
    ...trail,
  };
}

function envPct(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envSec(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Stock step-lock: arm at +2.5% → floor +1.5%; then each +1% raises floor +1%.
function stockTrailConfig() {
  return {
    armPct: envPct('MUHURAT_STOCK_ARM_PCT', 2.5),
    lockPct: envPct('MUHURAT_STOCK_LOCK_PCT', 1.5),
    stepPct: envPct('MUHURAT_STOCK_STEP_PCT', 1),
    armHoldSec: envSec('MUHURAT_STOCK_ARM_HOLD_SEC', 30),
  };
}

// Options: +5% → cost; +10% → +10% floor; then each +5% raises floor +5%.
function optionsTrailConfig() {
  return {
    bePct: envPct('MUHURAT_OPT_BE_PCT', 5),
    lockFirstPct: envPct('MUHURAT_OPT_LOCK_FIRST_PCT', 10),
    stepPct: envPct('MUHURAT_OPT_STEP_PCT', 5),
  };
}

function trailModeOf(modeOrOpts) {
  if (modeOrOpts === 'options' || modeOrOpts === 'option') return 'options';
  if (modeOrOpts && typeof modeOrOpts === 'object') {
    if (modeOrOpts.mode === 'options' || modeOrOpts.mode === 'option') return 'options';
  }
  return 'equity';
}

function pxAtPct(entry, pct) {
  return r2(roundTick(entry * (1 + Number(pct) / 100)));
}

// Step profit-lock trail (muhurat2).
// Stocks: +2.5% (hold armHoldSec) → lock +1.5%; then +1% steps.
// Options: +5% → cost; +10% → +10%; then +5% steps.
// `last` should be peak LTP since entry when managing an open trade.
function trailPlan(entry, initialStop, t1, t2, last = entry, opts = {}) {
  const e = Number(entry);
  if (!Number.isFinite(e) || e <= 0) {
    return {
      entry: null,
      trailCost: null,
      trailLock03: null,
      trailArm06: null,
      trailArmPx: null,
      trailFirstLockPx: null,
      activeStop: null,
      trailStage: 0,
      trailLabel: 'no entry',
      trailMode: 'equity',
      lockPct: null,
    };
  }
  const mode = trailModeOf(opts);
  const cost = r2(roundTick(e));
  const init = r2(initialStop);
  const px = Number.isFinite(last) ? last : e;
  const gainPct = ((px / e) - 1) * 100;
  const now = opts.now != null ? Number(opts.now) : Date.now();
  const armAt = opts.armAt != null ? Number(opts.armAt) : null;

  let stage = 0;
  let active = init;
  let label = 'initial SL';
  let lockPct = null;

  if (mode === 'options') {
    const cfg = optionsTrailConfig();
    const bePx = cost;
    const beArmPx = pxAtPct(e, cfg.bePct);
    const firstLockPx = pxAtPct(e, cfg.lockFirstPct);
    // Compare on price (avoids float edge at exact % levels like 102.5).
    if (px + 1e-9 >= firstLockPx) {
      const steps = Math.max(0, Math.floor((gainPct - cfg.lockFirstPct + 1e-9) / cfg.stepPct));
      lockPct = cfg.lockFirstPct + steps * cfg.stepPct;
      active = pxAtPct(e, lockPct);
      stage = 2 + steps;
      label = `trail → +${lockPct}% (options)`;
    } else if (px + 1e-9 >= beArmPx) {
      active = bePx;
      stage = 1;
      lockPct = 0;
      label = `trail → cost (options +${cfg.bePct}%)`;
    }
    if (stage >= 1 && init != null && active < init) active = init;
    return {
      entry: cost,
      trailCost: bePx,
      trailLock03: firstLockPx,
      trailArm06: pxAtPct(e, cfg.bePct),
      trailArmPx: pxAtPct(e, cfg.bePct),
      trailFirstLockPx: firstLockPx,
      activeStop: r2(active),
      trailStage: stage,
      trailLabel: label,
      trailMode: 'options',
      lockPct,
    };
  }

  const cfg = stockTrailConfig();
  const armPx = pxAtPct(e, cfg.armPct);
  const firstLockPx = pxAtPct(e, cfg.lockPct);
  const needHold = opts.armHoldSec != null ? Number(opts.armHoldSec) : cfg.armHoldSec;
  const armedLongEnough = needHold <= 0
    || (armAt != null && Number.isFinite(armAt) && (now - armAt) >= needHold * 1000);

  if (px + 1e-9 >= armPx) {
    if (!armedLongEnough) {
      stage = 0;
      active = init;
      label = `arming stock trail (+${cfg.armPct}% hold ${needHold}s)`;
    } else {
      const steps = Math.max(0, Math.floor((gainPct - cfg.armPct + 1e-9) / cfg.stepPct));
      lockPct = cfg.lockPct + steps * cfg.stepPct;
      active = pxAtPct(e, lockPct);
      stage = 1 + steps;
      label = `trail → +${lockPct}% (stock)`;
    }
  }
  if (stage >= 1 && init != null && active < init) active = init;

  return {
    entry: cost,
    trailCost: cost,
    trailLock03: firstLockPx,
    trailArm06: armPx,
    trailArmPx: armPx,
    trailFirstLockPx: firstLockPx,
    activeStop: r2(active),
    trailStage: stage,
    trailLabel: label,
    trailMode: 'equity',
    lockPct,
  };
}

function sessionPhase(now = Date.now(), mode = sessionMode()) {
  const sched = getSession(mode);
  const day = istDateKey(now);
  const openAt = istToEpoch(day, sched.openH, sched.openM);
  const decideAt = istToEpoch(day, sched.decideH, sched.decideM); // ~10 min after open before naming buys
  const exitAt = istToEpoch(day, sched.exitH, sched.exitM);
  const closeAt = istToEpoch(day, sched.closeH, sched.closeM);
  let phase = 'closed';
  if (now < openAt) phase = 'before_open';
  else if (now < decideAt) phase = 'watching_open';
  else if (now < exitAt) phase = 'live';
  else if (now < closeAt) phase = 'exit_only';
  const openLabel = sched.open.replace(/^0/, '');
  const decideLabel = sched.decide.replace(/^0/, '');
  const exitLabel = sched.exitBy.replace(/^0/, '');
  return {
    phase,
    mode: sched.mode,
    day,
    now,
    openAt,
    decideAt,
    exitAt,
    closeAt,
    clock: istTimeStr(now),
    canDecideBuy: phase === 'live',
    message:
      phase === 'before_open'
        ? `Market not open yet — no BUY decision. Levels only. Re-check after ${openLabel}.`
        : phase === 'watching_open'
          ? `Opened — watching first minutes. No BUY call until ~${decideLabel}.`
          : phase === 'live'
            ? 'Live review — BUY only if holding above the open.'
            : phase === 'exit_only'
              ? `Past ${exitLabel} — exit only, no new buys.`
              : 'Session closed.',
  };
}

// Rank by same-session profit potential (T1/T2 upside × RR × quality), not name popularity.
function profitMetrics(row) {
  const entry = Number(row.ltp);
  const t1 = Number(row.sellT1 != null ? row.sellT1 : row.levels && row.levels.target1);
  const t2 = Number(row.sellT2 != null ? row.sellT2 : row.levels && row.levels.target2);
  const sl = Number(row.sellStop != null ? row.sellStop : row.levels && row.levels.stopLoss);
  if (!(entry > 0) || !Number.isFinite(t1) || !Number.isFinite(sl)) {
    return { profitScore: -99, reward1Pct: null, reward2Pct: null, rr: null, edgePerRupee: 0 };
  }
  const reward1 = (t1 - entry) / entry;
  const reward2 = Number.isFinite(t2) ? (t2 - entry) / entry : reward1;
  const risk = (entry - sl) / entry;
  const rr = risk > 0 ? reward1 / risk : 0;
  let profitScore =
    reward1 * 220 +
    Math.max(reward2, 0) * 90 +
    Math.min(Math.max(rr, 0), 3) * 12 +
    (Number(row.score) || 0) * 0.35;
  if (MEGA.has(row.ticker)) profitScore += 2;
  if (row.rsi != null && row.rsi > 72) profitScore -= 4;
  if (row.aboveOpen === false) profitScore -= 8;
  if (reward1 <= 0) profitScore = -99;
  return {
    profitScore: r2(profitScore),
    reward1Pct: r2(reward1 * 100),
    reward2Pct: r2(reward2 * 100),
    rr: r2(rr),
    edgePerRupee: r2(Math.max(reward1, 0)),
  };
}

function rankByProfit(rows, { verdicts, minRr = 0.35, requireAboveOpen = false } = {}) {
  const allow = new Set(verdicts || ['BUY']);
  return (rows || [])
    .filter((r) => r && allow.has(r.verdict) && r.ltp > 0 && !r.error)
    .filter((r) => !requireAboveOpen || r.aboveOpen !== false)
    .map((r) => {
      const m = profitMetrics(r);
      return { ...r, ...m };
    })
    .filter((r) => (r.reward1Pct == null || r.reward1Pct > 0.2) && (r.rr == null || r.rr >= minRr))
    .sort((a, b) => {
      if ((b.profitScore || -99) !== (a.profitScore || -99)) return (b.profitScore || -99) - (a.profitScore || -99);
      return (b.edgePerRupee || 0) - (a.edgePerRupee || 0);
    });
}

function pickTopProfitBuys(rows, maxN = maxLiveBuys()) {
  const ranked = rankByProfit(rows, { verdicts: ['BUY'] });
  if (!(maxN > 0)) return ranked; // unlimited when MUHURAT_MAX_NAMES unset
  return ranked.slice(0, Math.max(1, maxN));
}

// Promote a WATCH row into a live BUY card so the bot / UI treat it as actionable.
function promoteWatchToBuy(row) {
  return {
    ...row,
    verdict: 'BUY',
    buy: 'YES',
    action: 'BUY',
    fromWatch: true,
    trade: {
      ...(row.trade || {}),
      buy: 'YES',
      action: 'BUY',
      entry: row.entry != null ? row.entry : row.ltp,
      sellStop: row.sellStop,
      sellT1: row.sellT1,
      sellT2: row.sellT2,
    },
  };
}

function pushAlloc(row, qty, alloc, filled) {
  if (!(qty > 0) || !(row.ltp > 0)) return 0;
  const spend = r2(qty * row.ltp);
  const t1 = Number(row.sellT1 != null ? row.sellT1 : row.levels && row.levels.target1);
  const exp = Number.isFinite(t1) ? r2(qty * (t1 - row.ltp)) : 0;
  alloc[row.ticker] = {
    cash: spend,
    qty,
    spend,
    leftover: 0,
    profitScore: row.profitScore,
    reward1Pct: row.reward1Pct,
    rr: row.rr,
    expectedT1: exp,
    fromWatch: Boolean(row.fromWatch),
  };
  filled.push({
    ...row,
    qty,
    spend,
    allocCash: spend,
    expectedT1: exp,
    profitScore: row.profitScore,
    reward1Pct: row.reward1Pct,
    rr: row.rr,
  });
  return spend;
}

function allocateBudget(budget, buyRows, opts = {}) {
  const total = Number(budget) > 0 ? Number(budget) : DEFAULT_BUDGET;
  const watchCash = Number(opts && opts.availableMargin);
  const watchPool = Number.isFinite(watchCash) && watchCash > 0 ? watchCash : 0;
  const deployable = total + watchPool;
  const MIN_WATCH_PROFIT = 12;
  const mode = (opts && opts.mode) === 'options' ? 'options' : 'equity';

  // Live pool = BUY names and strong Watch names, both requiring P > 12. Shown only as BUY (no Watch label).
  const buys = rankByProfit(buyRows, { verdicts: ['BUY'] })
    .filter((r) => Number(r.profitScore) > MIN_WATCH_PROFIT);
  const watches = rankByProfit(buyRows, {
    verdicts: ['WATCH'],
    minRr: 0.3,
    requireAboveOpen: true,
  })
    .filter((r) => Number(r.profitScore) > MIN_WATCH_PROFIT)
    .map(promoteWatchToBuy);

  // One ranked pool by profitScore — top P first, hard cap max trades/day.
  const pool = [...buys, ...watches].sort((a, b) => {
    if ((b.profitScore || -99) !== (a.profitScore || -99)) return (b.profitScore || -99) - (a.profitScore || -99);
    return (b.edgePerRupee || 0) - (a.edgePerRupee || 0);
  });

  const nameCap = opts && opts.maxTrades != null
    ? parseTradeCap(opts.maxTrades, maxTradesPerDay(mode))
    : maxTradesPerDay(mode); // stocks 5 / options 2; 0 = unlimited

  // Confirm ledger: track how long each top name has stayed in the pool.
  const day = opts.day || istDateKey(Date.now());
  const needSec = opts.confirmSec != null ? Number(opts.confirmSec) : confirmSec();
  let ledger = opts.confirmLedger || loadConfirmLedger(day, mode);
  const trackN = Math.max(nameCap > 0 ? nameCap * 2 : 10, 10);
  ledger = updateConfirmLedger(ledger, pool.slice(0, trackN), opts.now || Date.now());
  if (opts.persistConfirm !== false) {
    try { saveConfirmLedger(ledger); } catch (_) { /* ignore */ }
  }

  const { seated, confirming, seatCost } = seatWithConfirm(pool, {
    nameCap,
    deployable,
    ledger,
    stickyTickers: opts.stickyTickers || [],
    now: opts.now || Date.now(),
    needSec,
  });

  const seen = new Set(seated.map((r) => r.ticker));
  const alloc = {};
  const filled = [];
  const qtyByTicker = {};
  for (const row of seated) qtyByTicker[row.ticker] = 1;

  let used = seatCost;
  let leftover = Math.max(0, deployable - used);
  if (seated.length && leftover > 0) {
    const weightSum = seated.reduce((s, r) => s + Math.max(Number(r.profitScore) || 0, 0.5), 0) || 1;
    for (const row of seated) {
      const weight = Math.max(Number(row.profitScore) || 0, 0.5) / weightSum;
      const add = Math.floor((leftover * weight) / row.ltp);
      if (add > 0) {
        qtyByTicker[row.ticker] += add;
        used += add * row.ltp;
      }
    }
  }
  leftover = Math.max(0, deployable - used);
  const nowMs = opts.now || Date.now();
  // More confirmed names if cash remains.
  for (const row of pool) {
    if (nameCap > 0 && seated.length >= nameCap) break;
    if (seen.has(row.ticker) || !(row.ltp > 0) || leftover < row.ltp) continue;
    // Only add if already confirmed (same gate as initial seat).
    const since = ledger.names[row.ticker] && ledger.names[row.ticker].since;
    const ageOk = needSec <= 0 || (since && (nowMs - since) >= needSec * 1000);
    if (!ageOk && !(opts.stickyTickers || []).includes(row.ticker)) continue;
    const qty = Math.floor(leftover / row.ltp);
    if (!(qty > 0)) continue;
    seated.push({ ...row, orderReady: true });
    seen.add(row.ticker);
    qtyByTicker[row.ticker] = qty;
    leftover -= qty * row.ltp;
    used += qty * row.ltp;
  }
  if (leftover > 0 && seated.length) {
    const cheap = [...seated].sort((a, b) => a.ltp - b.ltp)[0];
    const add = Math.floor(leftover / cheap.ltp);
    if (add > 0) {
      qtyByTicker[cheap.ticker] += add;
      used += add * cheap.ltp;
    }
  }

  let expectedT1 = 0;
  for (const row of seated) {
    pushAlloc(row, qtyByTicker[row.ticker] || 0, alloc, filled);
    expectedT1 += (alloc[row.ticker] && alloc[row.ticker].expectedT1) || 0;
  }

  const picks = filled.filter((r) => r.qty > 0).map((r) => ({
    ...r,
    orderReady: r.orderReady !== false,
  }));
  const spent = picks.reduce((s, r) => s + (Number(r.spend) || 0), 0);
  return {
    budget: r2(deployable),
    used: r2(spent),
    left: r2(Math.max(0, deployable - spent)),
    byTicker: alloc,
    pickCount: picks.length,
    maxTrades: nameCap,
    confirmSec: needSec,
    confirming: confirming.slice(0, 8),
    expectedT1: r2(expectedT1),
    picks,
    watchFilled: picks.filter((r) => r.fromWatch).map((r) => r.ticker),
    availableMargin: watchPool || null,
  };
}

function applySessionVerdict(row, phaseInfo, openPx) {
  const base = row.verdict;
  const out = { ...row, open: openPx != null ? r2(openPx) : null, aboveOpen: null };
  if (openPx != null && row.ltp != null) {
    out.aboveOpen = row.ltp >= openPx * 0.998;
  }

  if (phaseInfo.phase === 'before_open' || phaseInfo.phase === 'watching_open') {
    if (base === 'BUY') out.verdict = 'PREP';
    else if (base === 'TOO HOT') out.verdict = 'TOO HOT';
    else if (base === 'ERROR') out.verdict = 'ERROR';
    else out.verdict = 'WATCH';
    out.decideLater = true;
    return withTradeSignals(out, phaseInfo);
  }
  if (phaseInfo.phase === 'exit_only' || phaseInfo.phase === 'closed') {
    out.verdict = base === 'ERROR' ? 'ERROR' : 'NO NEW BUY';
    return withTradeSignals(out, phaseInfo);
  }
  // live: keep BUY only if above session open when we have it
  if (base === 'BUY' && out.aboveOpen === false) {
    out.verdict = 'SKIP';
    out.reasons = [...(row.reasons || []), 'below Muhurat open'];
  }
  return withTradeSignals(out, phaseInfo);
}

// Clear ENTRY / BUY / SELL levels for the card (signals only).
function withTradeSignals(row, phaseInfo) {
  const lv = row.levels || {};
  const entry = r2(lv.entry != null ? lv.entry : row.ltp);
  let action = 'WAIT';
  if (phaseInfo && phaseInfo.phase === 'before_open') action = 'WAIT OPEN';
  else if (phaseInfo && phaseInfo.phase === 'watching_open') action = 'WATCH OPEN';
  else if (row.verdict === 'BUY') action = 'BUY';
  else if (row.verdict === 'PREP') action = 'PREP';
  else if (row.verdict === 'TOO HOT') action = 'NO BUY';
  else if (row.verdict === 'NO NEW BUY') action = 'EXIT ONLY';
  else if (row.verdict === 'SKIP') action = 'SKIP';
  else action = 'WATCH';

  row.entry = entry;
  row.buy = row.verdict === 'BUY' ? 'YES' : (row.verdict === 'PREP' ? 'LATER' : 'NO');
  row.sellStop = lv.activeStop != null ? lv.activeStop : lv.stopLoss;
  row.sellT1 = lv.target1;
  row.sellT2 = lv.target2;
  row.action = action;
  row.trade = {
    entry,
    buy: row.buy,
    sellStop: row.sellStop,
    sellT1: row.sellT1,
    sellT2: row.sellT2,
    action,
  };
  return row;
}

function applyLiveLtp(row, ltp, phaseInfo, mode) {
  if (!row || !Number.isFinite(ltp) || ltp <= 0) return row;
  const next = { ...row, ltp: r2(ltp), live: true };
  const lv = { ...(row.levels || {}) };
  const entryRef = lv.entry != null ? lv.entry : ltp;
  const trailMode = trailModeOf(mode || row.mode || 'equity');
  // Preview uses armHoldSec=0 so cards show the lock immediately at the arm price.
  const trail = trailPlan(entryRef, lv.stopLoss, lv.target1, lv.target2, ltp, {
    mode: trailMode,
    armHoldSec: 0,
  });
  Object.assign(lv, trail);
  next.levels = lv;
  if (next.open != null) next.aboveOpen = ltp >= next.open * 0.998;
  next.riskPct = lv.stopLoss != null ? r2(((lv.stopLoss - ltp) / ltp) * 100) : row.riskPct;
  next.reward1Pct = lv.target1 != null ? r2(((lv.target1 - ltp) / ltp) * 100) : row.reward1Pct;
  return withTradeSignals(next, phaseInfo || sessionPhase());
}

function patchBookLtps(book, ltpByKey) {
  if (!book || !ltpByKey) return book;
  const phaseInfo = book.phase || sessionPhase();
  const mode = trailModeOf(book.mode);
  const patchList = (rows) => (rows || []).map((row) => {
    if (!row || !row.key) return row;
    const px = ltpByKey.get(row.key);
    if (!Number.isFinite(px)) return row;
    return applyLiveLtp(row, px, phaseInfo, mode);
  });
  const next = { ...book };
  next.core = patchList(book.core);
  next.prep = patchList(book.prep);
  next.liveBuys = patchList(book.liveBuys);
  next.extrasBuy = patchList(book.extrasBuy);
  next.extrasWatch = patchList(book.extrasWatch);
  next.extrasSkipHot = patchList(book.extrasSkipHot);
  next.topGainers = patchList(book.topGainers);
  next.ltpAt = Date.now();
  return next;
}

function allInstrumentKeys(extraRows = []) {
  const seen = new Set();
  const keys = [];
  for (const row of [...CORE, ...EXTRA, ...(extraRows || [])]) {
    if (row && row.key && !seen.has(row.key)) {
      seen.add(row.key);
      keys.push(row.key);
    }
  }
  return keys;
}

async function screenOne(provider, meta, ltpMap, phaseInfo, fromDate, toDate) {
  let candles;
  try {
    candles = await provider.getDailyCandles(meta.key, fromDate, toDate);
  } catch (e) {
    return applySessionVerdict({
      ticker: meta.ticker,
      key: meta.key,
      core: Boolean(meta.core),
      sleeve: meta.sleeve || null,
      fromGainer: Boolean(meta.fromGainer),
      dayChangePct: meta.dayChangePct != null ? meta.dayChangePct : null,
      error: e.message.slice(0, 120),
      verdict: 'ERROR',
      score: -99,
    }, phaseInfo, null);
  }
  if (!candles || candles.length < 20) {
    return applySessionVerdict({
      ticker: meta.ticker,
      key: meta.key,
      core: Boolean(meta.core),
      sleeve: meta.sleeve || null,
      fromGainer: Boolean(meta.fromGainer),
      dayChangePct: meta.dayChangePct != null ? meta.dayChangePct : null,
      error: `only ${candles ? candles.length : 0} bars`,
      verdict: 'ERROR',
      score: -99,
    }, phaseInfo, null);
  }
  let row = analyzeName(meta, candles, ltpMap.get(meta.key));
  if (meta.fromGainer) row.fromGainer = true;
  if (meta.dayChangePct != null) row.dayChangePct = meta.dayChangePct;
  if (meta.gainerSource) row.gainerSource = meta.gainerSource;
  let openPx = null;
  if (phaseInfo.phase !== 'before_open') {
    openPx = await fetchSessionOpen(provider, meta.key, phaseInfo.day, phaseInfo.phase);
  }
  return applySessionVerdict(row, phaseInfo, openPx);
}

function analyzeName(meta, candles, ltp) {
  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1];
  const price = Number.isFinite(ltp) ? ltp : last;
  const screened = screenHolding({
    ticker: meta.ticker,
    buyPrice: price,
    quantity: 1,
    closes,
  });
  const sma50 = screened.sma50 != null ? screened.sma50 : r2(smaLast(closes, 50));
  const rsi = screened.rsi;
  const d1 = closes.length > 1 ? ((last - closes[closes.length - 2]) / closes[closes.length - 2]) * 100 : null;
  const d5 = closes.length > 5 ? ((last - closes[closes.length - 6]) / closes[closes.length - 6]) * 100 : null;
  const atr = atr14(candles);
  const atrPct = atr != null && price ? (atr / price) * 100 : null;
  const distSma = sma50 ? ((price - sma50) / sma50) * 100 : null;
  const aboveSma = sma50 != null ? price > sma50 : false;
  const { score, reasons } = scoreRow({
    aboveSma,
    rsi,
    d1: d1 || 0,
    d5: d5 || 0,
    distSma,
    atrPct,
    ticker: meta.ticker,
  });
  const levels = levelsFromCandles(candles, price, 'equity');
  // Recompute trail vs live LTP (planned entry = LTP until you buy).
  const trail = trailPlan(price, levels.stopLoss, levels.target1, levels.target2, price, {
    mode: 'equity',
    armHoldSec: 0,
  });
  Object.assign(levels, trail);
  const riskPct = levels.stopLoss != null ? ((levels.stopLoss - price) / price) * 100 : null;
  const reward1Pct = levels.target1 != null ? ((levels.target1 - price) / price) * 100 : null;

  let verdict = 'SKIP';
  if (score >= 8 && rsi != null && rsi <= 72) verdict = 'BUY';
  else if (score >= 5 && rsi != null && rsi <= 75) verdict = 'WATCH';
  else if (rsi != null && rsi > 75) verdict = 'TOO HOT';

  return {
    ticker: meta.ticker,
    key: meta.key,
    sleeve: meta.sleeve || null,
    core: Boolean(meta.core),
    ltp: r2(price),
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
}

async function fetchSessionOpen(provider, instrumentKey, day, phase) {
  if (!provider || typeof provider.getCandlesForDate !== 'function') return null;
  if (phase === 'before_open') return null;
  try {
    const candles = await provider.getCandlesForDate(
      { upstoxKey: instrumentKey },
      day,
      1,
      true
    );
    if (candles && candles.length) return candles[0].open;
  } catch (_) {
    /* no intraday yet */
  }
  return null;
}

async function buildMuhuratBook(provider, {
  fromDate,
  toDate,
  budget,
  availableMargin = null,
  now = Date.now(),
  stickyTickers = [],
} = {}) {
  const phaseInfo = sessionPhase(now);
  const universe = [
    ...CORE.map((r) => ({ ...r, core: true })),
    ...EXTRA.filter((e) => !CORE.some((c) => c.ticker === e.ticker)).map((r) => ({ ...r, core: false })),
  ];

  // NSE F&O top gainers → Upstox keys; also rank fixed universe by Upstox day %.
  let gainerMetas = [];
  let gainerError = null;
  try {
    const nseGainers = await fetchTopGainerCandidates({ limit: 15, known: universe });
    gainerMetas = nseGainers.map((g) => ({
      ticker: g.ticker,
      key: g.key,
      core: false,
      sleeve: 'Top gainer',
      fromGainer: true,
      dayChangePct: g.dayChangePct,
      gainerSource: g.source,
    }));
  } catch (e) {
    gainerError = e.message.slice(0, 160);
  }
  try {
    const upstoxRanked = await rankByUpstoxDayChange(provider, universe, { limit: 10 });
    const have = new Set(gainerMetas.map((g) => g.ticker));
    for (const g of upstoxRanked) {
      if (have.has(g.ticker)) {
        const hit = gainerMetas.find((x) => x.ticker === g.ticker);
        if (hit && hit.dayChangePct == null) hit.dayChangePct = g.dayChangePct;
        continue;
      }
      // Already in CORE/EXTRA — mark when we screen; skip duplicate meta.
      have.add(g.ticker);
    }
  } catch (_) {
    /* quotes optional */
  }

  const knownTickers = new Set(universe.map((u) => u.ticker));
  const gainerOnly = gainerMetas.filter((g) => !knownTickers.has(g.ticker));
  const screenList = [
    ...universe,
    ...gainerOnly,
  ];
  // Tag CORE/EXTRA rows that also appear on the gainer list.
  const gainerByTicker = new Map(gainerMetas.map((g) => [g.ticker, g]));
  for (const meta of screenList) {
    const g = gainerByTicker.get(meta.ticker);
    if (!g) continue;
    meta.fromGainer = true;
    meta.dayChangePct = g.dayChangePct;
    meta.gainerSource = g.gainerSource || meta.gainerSource;
    if (!meta.sleeve) meta.sleeve = 'Top gainer';
  }

  const keys = screenList.map((u) => u.key);
  let ltpMap = new Map();
  try {
    ltpMap = await provider.getLtps(keys);
  } catch (_) {
    /* candles still usable */
  }

  const core = [];
  const others = [];
  const topGainers = [];
  for (const meta of screenList) {
    const row = await screenOne(provider, meta, ltpMap, phaseInfo, fromDate, toDate);
    if (meta.core) core.push(row);
    else others.push(row);
    if (meta.fromGainer) topGainers.push(row);
  }

  others.sort((a, b) => (b.score || -99) - (a.score || -99));
  const all = [...core, ...others];
  // Deduplicate if a core name also landed in others (shouldn't, but safe).
  const allByTicker = new Map();
  for (const row of all) {
    if (!allByTicker.has(row.ticker)) allByTicker.set(row.ticker, row);
  }
  const uniqueAll = [...allByTicker.values()];

  const prep = uniqueAll
    .filter((r) => r.verdict === 'PREP')
    .map((r) => ({ ...r, ...profitMetrics(r) }))
    .sort((a, b) => (b.profitScore || -99) - (a.profitScore || -99));
  const planBudget = Number(budget) > 0 ? Number(budget) : DEFAULT_BUDGET;
  const budgetPlan = phaseInfo.canDecideBuy
    ? allocateBudget(planBudget, uniqueAll, {
      availableMargin,
      mode: 'equity',
      day: phaseInfo.day,
      now,
      stickyTickers,
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
      confirmSec: confirmSec(),
      watchFilled: [],
      availableMargin: availableMargin || null,
    };
  const liveBuys = phaseInfo.canDecideBuy ? (budgetPlan.picks || []) : [];
  const liveTickers = new Set(liveBuys.map((r) => r.ticker));

  for (const row of uniqueAll) {
    const a = budgetPlan.byTicker[row.ticker];
    if (a) {
      row.qty = a.qty;
      row.spend = a.spend;
      row.allocCash = a.cash;
      row.profitScore = a.profitScore;
      row.expectedT1 = a.expectedT1;
      row.rr = a.rr;
      row.reward1Pct = a.reward1Pct != null ? a.reward1Pct : row.reward1Pct;
      if (a.fromWatch) {
        row.verdict = 'BUY';
        row.buy = 'YES';
        row.action = 'BUY';
        row.fromWatch = true;
      }
    } else {
      row.qty = 0;
      row.spend = 0;
      row.allocCash = 0;
      row.expectedT1 = 0;
      if (row.profitScore == null) Object.assign(row, profitMetrics(row));
    }
  }

  const scoredGainers = topGainers
    .map((r) => {
      const live = uniqueAll.find((x) => x.ticker === r.ticker) || r;
      return { ...live, ...profitMetrics(live), fromGainer: true };
    })
    .filter((r) => Number(r.profitScore) > 12)
    .sort((a, b) => {
      if ((b.profitScore || -99) !== (a.profitScore || -99)) return (b.profitScore || -99) - (a.profitScore || -99);
      return (b.dayChangePct || 0) - (a.dayChangePct || 0);
    });

  const extrasWatch = uniqueAll
    .filter((r) => r.verdict === 'WATCH' && !liveTickers.has(r.ticker))
    .map((r) => ({ ...r, ...profitMetrics(r) }))
    .filter((r) => Number(r.profitScore) > 12)
    .sort((a, b) => (Number(b.profitScore) || -99) - (Number(a.profitScore) || -99))
    .slice(0, 10);
  const extrasSkipHot = uniqueAll.filter((r) => r.verdict === 'TOO HOT').slice(0, 10);

  return {
    session: SESSION,
    phase: phaseInfo,
    core,
    liveBuys,
    prep,
    extrasBuy: liveBuys,
    extrasWatch,
    extrasSkipHot,
    topGainers: scoredGainers,
    gainerError,
    screened: screenList.length,
    instrumentKeys: allInstrumentKeys(gainerOnly),
    asOf: toDate,
    budget: budgetPlan,
    rules: {
      budget: planBudget,
      maxNames: maxTradesPerDay(),
      maxTrades: maxTradesPerDay(),
      confirmSec: confirmSec(),
      pickRule: `Live BUYs = P > 12, must stay top-ranked ~${confirmSec()}s before using a trade slot · max ${maxTradesPerDay() || '∞'}/day.`,
      decide: `No BUY name is fixed before open. Review after ${SESSION.open}; calls from ~${SESSION.decide} if holding above open.`,
      entry: 'Buy only if price holds above the session open',
      initialStop: 'Use SL on card (~0.9% under entry)',
      trailStock: `Stock: +${stockTrailConfig().armPct}% (hold ${stockTrailConfig().armHoldSec}s) → lock +${stockTrailConfig().lockPct}%; then +${stockTrailConfig().stepPct}% steps`,
      trailOptions: `Options: +${optionsTrailConfig().bePct}% → cost; +${optionsTrailConfig().lockFirstPct}% → +${optionsTrailConfig().lockFirstPct}%; then +${optionsTrailConfig().stepPct}% steps`,
      targets: 'Book at T1; stretch to T2 if strong · step-lock trail protects profit',
      hardExit: `Square off by ${SESSION.exitBy} IST`,
      noAverage: 'Do not add if red; do not exceed ₹ budget',
      topGainers: 'NSE F&O gainers → Upstox keys/quotes/candles → same filters; show only P > 12',
    },
  };
}

module.exports = {
  CORE,
  EXTRA,
  SESSION,
  SCHEDULES,
  DEFAULT_BUDGET,
  DEFAULT_MAX_TRADES,
  DEFAULT_MAX_TRADES_STOCK,
  DEFAULT_MAX_TRADES_OPTIONS,
  MAX_LIVE_BUYS,
  maxLiveBuys,
  maxTradesPerDay,
  confirmSec,
  sessionMode,
  getSession,
  buildMuhuratBook,
  analyzeName,
  levelsFromCandles,
  trailPlan,
  stockTrailConfig,
  optionsTrailConfig,
  allocateBudget,
  pickTopProfitBuys,
  profitMetrics,
  sessionPhase,
  applySessionVerdict,
  withTradeSignals,
  applyLiveLtp,
  patchBookLtps,
  allInstrumentKeys,
  scoreRow,
  screenOne,
};
