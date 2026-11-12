'use strict';

// Fully automated Muhurat cash trader via Upstox live orders.
// Requires MUHURAT_LIVE=true, MUHURAT_LIVE_CONFIRM=I_ACCEPT_REAL_ORDERS,
// and MUHURAT_BUY_APPROVED=YES (set only after interactive YES this run).
// Caps spend at MUHURAT_BUDGET. Hard market SELL at 15:15 IST.

const fs = require('fs');
const path = require('path');
const { istDateKey, istFullStr } = require('./time');
const {
  sessionPhase,
  DEFAULT_BUDGET,
  maxTradesPerDay,
  trailPlan,
  stockTrailConfig,
  optionsTrailConfig,
} = require('./muhurat');
const { summarizePortfolio } = require('./portfolio');

const PAPER_DIR = path.join(__dirname, '..', 'paper');
const TAG = 'muhurat';
const CONFIRM = 'I_ACCEPT_REAL_ORDERS';

function liveEnabled() {
  return (
    process.env.MUHURAT_LIVE === 'true'
    && process.env.MUHURAT_LIVE_CONFIRM === CONFIRM
    && process.env.MUHURAT_BUY_APPROVED === 'YES'
  );
}

function productOf() {
  return (process.env.MUHURAT_PRODUCT || 'I').toUpperCase() === 'D' ? 'D' : 'I';
}

function budgetOf() {
  const n = Number(process.env.MUHURAT_BUDGET || DEFAULT_BUDGET);
  return n > 0 ? n : DEFAULT_BUDGET;
}

// Cap = already-spent open positions + Upstox available margin (so leftover cash can buy Watch).
// When state.budgetLimit is set (merged stocks+options), each bot stays within its own budget.
function spendCap(book, state) {
  const openSpend = Object.values((state && state.positions) || {}).reduce(
    (s, p) => s + ((p && p.qty > 0 && p.status !== 'CLOSED') ? (Number(p.spend) || 0) : 0),
    0
  );
  const available = Number(book && book.funds && book.funds.available);
  const limit = Number(state && state.budgetLimit);
  const configured = Number.isFinite(limit) && limit > 0 ? limit : budgetOf();
  if (Number.isFinite(available) && available >= 0) {
    if (Number.isFinite(limit) && limit > 0) {
      return Math.min(openSpend + available, configured);
    }
    return openSpend + available;
  }
  return configured;
}

// Near 20% book loss → do not open new trades (default block at 18%).
function noTradeLossPct() {
  const n = Number(process.env.MUHURAT_NO_TRADE_LOSS_PCT || 18);
  return Number.isFinite(n) && n > 0 ? n : 18;
}

function portfolioLossGate(book) {
  const investment = Number(book && book.portfolio && book.portfolio.investment);
  const pnl = Number(book && book.portfolio && book.portfolio.pnl);
  if (!(investment > 0) || !Number.isFinite(pnl)) {
    return { blocked: false, pnlPct: null, limit: noTradeLossPct(), reason: '' };
  }
  const pnlPct = (pnl / investment) * 100;
  const limit = noTradeLossPct();
  const blocked = pnlPct <= -limit;
  return {
    blocked,
    pnlPct: Math.round(pnlPct * 100) / 100,
    limit,
    reason: blocked
      ? `DO NOT TRADE — book loss ${pnlPct.toFixed(1)}% (block near −${limit}%, ~20% rule)`
      : '',
  };
}

function statePath(day, mode = 'equity') {
  const tag = mode === 'options' ? 'options' : 'live';
  return path.join(PAPER_DIR, `muhurat-${tag}-${day}.json`);
}

function emptyState(day, mode = 'equity') {
  return {
    date: day,
    mode: mode === 'options' ? 'options' : 'live',
    bookMode: mode === 'options' ? 'options' : 'equity',
    entered: false,
    squaredOff: false,
    tradesToday: 0, // successful BUY count today (max trades/day gate)
    positions: {}, // ticker -> { key, qty, entry, stop, t1, t2, buyOrderId, slOrderId, stage, spend }
    log: [],
    lastError: '',
  };
}

function tradesOpenedCount(state) {
  if (Number.isFinite(Number(state.tradesToday)) && Number(state.tradesToday) >= 0) {
    return Math.floor(Number(state.tradesToday));
  }
  return Object.values(state.positions || {}).filter((p) => p && (p.buyOrderId || p.status === 'OPEN' || p.status === 'CLOSED')).length;
}

function bookModeOf(bookOrMode) {
  if (bookOrMode === 'options' || bookOrMode === 'equity') return bookOrMode;
  if (bookOrMode && bookOrMode.mode === 'options') return 'options';
  return 'equity';
}

function loadState(day, mode = 'equity') {
  const bookMode = bookModeOf(mode);
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(day, bookMode), 'utf8'));
    if (!raw || raw.date !== day) return emptyState(day, bookMode);
    return {
      ...emptyState(day, bookMode),
      ...raw,
      bookMode,
      positions: raw.positions && typeof raw.positions === 'object' ? raw.positions : {},
      log: Array.isArray(raw.log) ? raw.log : [],
    };
  } catch (_) {
    return emptyState(day, bookMode);
  }
}

function saveState(state) {
  fs.mkdirSync(PAPER_DIR, { recursive: true });
  const mode = bookModeOf(state.bookMode || state.mode);
  fs.writeFileSync(statePath(state.date, mode), JSON.stringify(state, null, 2));
}

function pushLog(state, msg) {
  state.log.push({ at: new Date().toISOString(), msg });
  if (state.log.length > 80) state.log = state.log.slice(-80);
}

function roundTick(n, tick = 0.05) {
  return Math.round(Number(n) / tick) * tick;
}

function viewOf(state, phase) {
  const open = Object.values(state.positions || {}).filter((p) => p && p.qty > 0);
  const tradesToday = tradesOpenedCount(state);
  const mode = bookModeOf(state.bookMode || state.mode);
  const tradeCap = maxTradesPerDay(mode);
  return {
    enabled: true,
    live: true,
    phase: phase && phase.phase,
    bookMode: mode,
    entered: state.entered,
    squaredOff: state.squaredOff,
    openCount: open.length,
    tradesToday,
    maxTrades: tradeCap,
    spend: open.reduce((s, p) => s + (Number(p.spend) || 0), 0),
    positions: open,
    lossGate: state.lossGate || null,
    lastError: state.lastError || '',
    log: (state.log || []).slice(-8),
  };
}

async function placeBuy(provider, pick, product) {
  return provider.placeOrder({
    instrumentToken: pick.key,
    quantity: pick.qty,
    transactionType: 'BUY',
    orderType: 'MARKET',
    product,
    tag: TAG,
  });
}

async function placeOrReplaceStop(provider, pos, stop, product) {
  const trigger = roundTick(stop);
  if (pos.slOrderId) {
    try {
      await provider.modifyOrder({
        orderId: pos.slOrderId,
        quantity: pos.qty,
        orderType: 'SL-M',
        triggerPrice: trigger,
        price: 0,
      });
      pos.stop = trigger;
      return;
    } catch (_) {
      try {
        await provider.cancelOrder(pos.slOrderId);
      } catch (_) {
        /* continue to place fresh */
      }
      pos.slOrderId = null;
    }
  }
  const placed = await provider.placeOrder({
    instrumentToken: pos.key,
    quantity: pos.qty,
    transactionType: 'SELL',
    orderType: 'SL-M',
    product,
    triggerPrice: trigger,
    price: 0,
    tag: TAG,
  });
  pos.slOrderId = placed && (placed.order_id || placed.orderId);
  pos.stop = trigger;
}

async function marketSell(provider, pos, product) {
  if (pos.slOrderId) {
    try {
      await provider.cancelOrder(pos.slOrderId);
    } catch (_) {
      /* may already be filled */
    }
    pos.slOrderId = null;
  }
  if (!(pos.qty > 0)) return null;
  return provider.placeOrder({
    instrumentToken: pos.key,
    quantity: pos.qty,
    transactionType: 'SELL',
    orderType: 'MARKET',
    product,
    tag: TAG,
  });
}

function positionTrail(pos, ltp, mode, now = Date.now()) {
  const entry = Number(pos.entry);
  if (!(entry > 0) || !Number.isFinite(ltp)) {
    return {
      peak: Number(pos.peak) || entry,
      trailArmAt: pos.trailArmAt || null,
      activeStop: pos.stop,
      trailStage: pos.stage || 0,
      trailLabel: pos.trailLabel || 'initial SL',
    };
  }
  const peak = Math.max(Number(pos.peak) || entry, ltp);
  const trailMode = mode === 'options' ? 'options' : 'equity';
  const gainPct = ((peak / entry) - 1) * 100;
  let trailArmAt = pos.trailArmAt || null;
  if (trailMode === 'equity') {
    const armPx = entry * (1 + stockTrailConfig().armPct / 100);
    if (peak + 1e-9 >= armPx && trailArmAt == null) trailArmAt = now;
  } else {
    const bePx = entry * (1 + optionsTrailConfig().bePct / 100);
    if (peak + 1e-9 >= bePx && trailArmAt == null) trailArmAt = now;
  }
  const trail = trailPlan(
    entry,
    pos.initialStop != null ? pos.initialStop : entry * 0.992,
    pos.t1,
    pos.t2,
    peak,
    {
      mode: trailMode,
      armAt: trailArmAt,
      now,
      armHoldSec: trailMode === 'equity' ? stockTrailConfig().armHoldSec : 0,
    }
  );
  return {
    peak,
    trailArmAt,
    activeStop: trail.activeStop,
    trailStage: trail.trailStage,
    trailLabel: trail.trailLabel,
    lockPct: trail.lockPct,
  };
}

// Kept for tests / callers — prefer positionTrail for live management.
function stageFor(pos, ltp, mode = 'equity') {
  return positionTrail(pos, ltp, mode).trailStage;
}

function stopForStage(pos, stage, mode = 'equity') {
  const entry = Number(pos.entry);
  const peak = Number(pos.peak) || entry;
  // Recompute from peak using current trail rules (stage arg ignored intentionally).
  void stage;
  return positionTrail({ ...pos, peak }, peak, mode).activeStop;
}

async function attachPortfolio(provider, book) {
  const next = book && typeof book === 'object' ? book : {};
  if (next.portfolio && Number.isFinite(next.portfolio.investment)) return next;
  try {
    const raw = await provider.getPortfolio();
    next.portfolio = summarizePortfolio(raw.holdingRows || [], raw.positionRows || []);
  } catch (e) {
    next.portfolio = next.portfolio || { investment: 0, pnl: 0, error: e.message };
  }
  return next;
}

function isStaticIpBlock(err) {
  const msg = String((err && err.message) || err || '');
  return msg.includes('UDAPI1154') || /static IP/i.test(msg);
}

async function enterFromBook(provider, state, book, product) {
  book = await attachPortfolio(provider, book);
  const lossGate = portfolioLossGate(book);
  state.lossGate = lossGate;
  if (lossGate.blocked) {
    state.lastError = lossGate.reason;
    pushLog(state, lossGate.reason);
    return;
  }
  if (state.lastError && String(state.lastError).startsWith('DO NOT TRADE')) {
    state.lastError = '';
  }
  // Back off when Upstox static-IP blocks — avoid spamming place-order every few seconds.
  if (state.orderBlockUntil && Date.now() < state.orderBlockUntil) {
    return;
  }
  const picks = (book.liveBuys || []).filter(
    (r) => r.verdict === 'BUY'
      && r.qty > 0
      && r.key
      && Number(r.profitScore) > 12
      && r.orderReady !== false // must clear confirm window (or sticky)
  );
  if (!picks.length) {
    const warming = (book.budget && book.budget.confirming) || [];
    if (warming.length) {
      const tip = warming.slice(0, 3).map((r) => `${r.ticker} ${r.confirmLeftSec || '?'}s`).join(', ');
      pushLog(state, `Waiting confirm (${tip}) — no order yet`);
    } else {
      pushLog(state, 'No live BUY picks yet — waiting');
    }
    return;
  }
  const mode = bookModeOf(book);
  state.bookMode = mode;
  const tradeCap = maxTradesPerDay(mode);
  let tradesToday = tradesOpenedCount(state);
  state.tradesToday = tradesToday;
  if (tradeCap > 0 && tradesToday >= tradeCap) {
    pushLog(state, `Max ${tradeCap} ${mode} trades/day reached (${tradesToday}) — no new BUY`);
    return;
  }
  let spent = Object.values(state.positions).reduce(
    (s, p) => s + ((p && p.qty > 0 && p.status !== 'CLOSED') ? (Number(p.spend) || 0) : 0),
    0
  );
  const cap = spendCap(book, state);
  for (const pick of picks) {
    if (tradeCap > 0 && tradesToday >= tradeCap) {
      pushLog(state, `Max ${tradeCap} trades/day — stopping new entries`);
      break;
    }
    if (state.positions[pick.ticker] && state.positions[pick.ticker].qty > 0 && state.positions[pick.ticker].status !== 'CLOSED') continue;
    // Already traded this ticker today (even if closed) — count as one trade, don't re-enter.
    if (state.positions[pick.ticker] && state.positions[pick.ticker].status === 'CLOSED') continue;
    // Failed earlier this session — don't hammer the same name until backoff clears.
    if (state.failedBuys && state.failedBuys[pick.ticker] && Date.now() < state.failedBuys[pick.ticker]) continue;
    const need = Number(pick.spend) || pick.qty * pick.ltp;
    if (spent + need > cap + 1) {
      pushLog(state, `Skip ${pick.ticker} — would exceed ₹${cap}`);
      continue;
    }
    try {
      const placed = await placeBuy(provider, pick, product);
      const orderId = placed && (placed.order_id || placed.orderId);
      const entry = Number(pick.ltp);
      const pos = {
        ticker: pick.ticker,
        key: pick.key,
        qty: pick.qty,
        entry,
        initialStop: pick.sellStop || (pick.levels && pick.levels.stopLoss),
        stop: pick.sellStop || (pick.levels && pick.levels.stopLoss),
        t1: pick.sellT1 || (pick.levels && pick.levels.target1),
        t2: pick.sellT2 || (pick.levels && pick.levels.target2),
        buyOrderId: orderId,
        slOrderId: null,
        stage: 0,
        peak: entry,
        trailArmAt: null,
        trailLabel: 'initial SL',
        spend: Number(pick.spend) || entry * pick.qty,
        status: 'OPEN',
      };
      state.positions[pick.ticker] = pos;
      spent += pos.spend;
      tradesToday += 1;
      state.tradesToday = tradesToday;
      pushLog(state, `BUY ${pick.ticker} qty ${pick.qty} @~${entry} order ${orderId || '?'} (${tradesToday}/${tradeCap || '∞'})`);
      try {
        await placeOrReplaceStop(provider, pos, pos.stop, product);
        pushLog(state, `SL-M ${pick.ticker} @ ${pos.stop}`);
      } catch (e) {
        state.lastError = `SL ${pick.ticker}: ${e.message}`;
        pushLog(state, state.lastError);
      }
    } catch (e) {
      state.lastError = `BUY ${pick.ticker}: ${e.message}`;
      pushLog(state, state.lastError);
      if (isStaticIpBlock(e)) {
        state.orderBlockUntil = Date.now() + 5 * 60 * 1000;
        state.failedBuys = state.failedBuys || {};
        state.failedBuys[pick.ticker] = state.orderBlockUntil;
        pushLog(state, 'Static IP block — pausing new BUY attempts for 5 min. Fix Upstox Static IPs / restart after login.');
        break;
      }
      state.failedBuys = state.failedBuys || {};
      state.failedBuys[pick.ticker] = Date.now() + 60 * 1000;
    }
  }
  state.entered = Object.values(state.positions).some((p) => p.qty > 0);
}

async function managePositions(provider, state, ltpByKey, product) {
  const mode = bookModeOf(state.bookMode || state.mode);
  for (const pos of Object.values(state.positions)) {
    if (!pos || !(pos.qty > 0) || pos.status === 'CLOSED') continue;
    const ltp = ltpByKey.get(pos.key);
    if (!Number.isFinite(ltp)) continue;
    pos.last = ltp;
    const trail = positionTrail(pos, ltp, mode);
    pos.peak = trail.peak;
    pos.trailArmAt = trail.trailArmAt;
    pos.trailLabel = trail.trailLabel;
    const stop = trail.activeStop;
    const stage = trail.trailStage;
    const curStop = Number(pos.stop);
    const raised = Number.isFinite(stop) && (!Number.isFinite(curStop) || stop > curStop + 1e-9);
    if (raised || stage > (pos.stage || 0)) {
      pos.stage = Math.max(stage, pos.stage || 0);
      if (raised) {
        try {
          await placeOrReplaceStop(provider, pos, stop, product);
          pushLog(state, `Trail ${pos.ticker} ${trail.trailLabel} SL→${stop}`);
        } catch (e) {
          state.lastError = `Trail ${pos.ticker}: ${e.message}`;
          pushLog(state, state.lastError);
        }
      }
    }
    // Soft take-profit at T2: market sell
    if (Number.isFinite(pos.t2) && ltp >= pos.t2) {
      try {
        await marketSell(provider, pos, product);
        pos.qty = 0;
        pos.status = 'CLOSED';
        pos.exitReason = 'T2';
        pushLog(state, `SELL ${pos.ticker} T2 hit @~${ltp}`);
      } catch (e) {
        state.lastError = `T2 sell ${pos.ticker}: ${e.message}`;
        pushLog(state, state.lastError);
      }
    }
  }
}

async function squareOffAll(provider, state, product) {
  if (state.squaredOff) return;
  for (const pos of Object.values(state.positions)) {
    if (!pos || !(pos.qty > 0) || pos.status === 'CLOSED') continue;
    try {
      await marketSell(provider, pos, product);
      pushLog(state, `SQUARE-OFF ${pos.ticker} qty ${pos.qty}`);
      pos.qty = 0;
      pos.status = 'CLOSED';
      pos.exitReason = '15:15';
    } catch (e) {
      state.lastError = `Square-off ${pos.ticker}: ${e.message}`;
      pushLog(state, state.lastError);
    }
  }
  state.squaredOff = true;
}

function createMuhuratBot(provider, { mode = 'equity', budget, enforceBudget = false } = {}) {
  if (!liveEnabled()) return null;
  const product = productOf();
  const botMode = mode === 'options' ? 'options' : 'equity';
  const budgetLimit = Number(budget) > 0 ? Math.floor(Number(budget)) : budgetOf();
  let busy = false;

  return {
    enabled: true,
    live: true,
    product,
    mode: botMode,
    budget: budgetLimit,
    async tick(book, ltpByKey = new Map()) {
      const modeNow = bookModeOf(book && book.mode ? book : botMode);
      if (busy) return viewOf(loadState(istDateKey(Date.now()), modeNow), sessionPhase());
      busy = true;
      const now = Date.now();
      const day = istDateKey(now);
      const phase = sessionPhase(now);
      const state = loadState(day, modeNow);
      state.bookMode = modeNow;
      if (enforceBudget) state.budgetLimit = budgetLimit;
      else delete state.budgetLimit;
      try {
        if (phase.phase === 'exit_only' || phase.phase === 'closed') {
          await squareOffAll(provider, state, product);
        } else if (phase.canDecideBuy && !state.squaredOff) {
          book = await attachPortfolio(provider, book || {});
          state.lossGate = portfolioLossGate(book);
          if (state.lossGate.blocked) {
            state.lastError = state.lossGate.reason;
            if (!state.log.length || state.log[state.log.length - 1].msg !== state.lossGate.reason) {
              pushLog(state, state.lossGate.reason);
            }
          } else {
            // Keep buying new names (incl. Watch P>12) while budget + max trades/day allow.
            await enterFromBook(provider, state, book, product);
          }
          await managePositions(provider, state, ltpByKey, product);
        } else if (!state.log.length || state.log[state.log.length - 1].msg !== (phase.message || phase.phase)) {
          pushLog(state, phase.message || phase.phase);
        }
        state.lastError = state.lastError || '';
      } catch (e) {
        state.lastError = e.message;
        pushLog(state, e.message);
      }
      saveState(state);
      busy = false;
      return viewOf(state, phase);
    },
    snapshot() {
      const day = istDateKey(Date.now());
      return viewOf(loadState(day, botMode), sessionPhase());
    },
  };
}

module.exports = {
  createMuhuratBot,
  liveEnabled,
  CONFIRM,
  loadState,
  viewOf,
  portfolioLossGate,
  noTradeLossPct,
  spendCap,
  positionTrail,
  stageFor,
  stopForStage,
};
