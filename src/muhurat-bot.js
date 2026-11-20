'use strict';

// Fully automated Muhurat cash trader via Upstox live orders — or paper fills.
// Live: MUHURAT_LIVE=true, MUHURAT_LIVE_CONFIRM=I_ACCEPT_REAL_ORDERS, MUHURAT_BUY_APPROVED=YES.
// Paper: MUHURAT_PAPER=true (simulated BUY/SELL, no broker orders).
// Caps spend at MUHURAT_BUDGET. Hard market SELL at 15:15 IST.

const fs = require('fs');
const path = require('path');
const { istDateKey, istFullStr, istFullSecStr } = require('./time');
const {
  sessionPhase,
  DEFAULT_BUDGET,
  maxTradesPerDay,
  trailPlan,
  stockTrailConfig,
  optionsTrailConfig,
  optionsInitialStop,
  optionsStopLossPct,
} = require('./muhurat');
const { summarizePortfolio } = require('./portfolio');
const { staticIpHint } = require('./upstox-ip');
const {
  appendLog,
  recordBuy,
  recordSell,
  syncFromBotState,
  countTradesForDay,
} = require('./muhurat-history');

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

function paperEnabled() {
  const v = String(process.env.MUHURAT_PAPER || '').trim().toLowerCase();
  return v === 'true' || v === 'yes' || v === '1';
}

function tradingEnabled() {
  return liveEnabled() || paperEnabled();
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
  const prefix = paperEnabled() && !liveEnabled() ? 'muhurat-paper' : 'muhurat';
  return path.join(PAPER_DIR, `${prefix}-${tag}-${day}.json`);
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
  const mode = bookModeOf(state.bookMode || state.mode);
  const fromPositions = Object.values(state.positions || {}).filter(
    (p) => p && (p.buyOrderId || p.status === 'OPEN' || p.status === 'CLOSED')
  ).length;
  const fromState = Number.isFinite(Number(state.tradesToday)) && Number(state.tradesToday) >= 0
    ? Math.floor(Number(state.tradesToday))
    : 0;
  let fromHistory = 0;
  try {
    fromHistory = countTradesForDay(state.date, mode);
  } catch (_) {
    fromHistory = 0;
  }
  // Max across sources so a wiped state file cannot re-open beyond the day cap.
  return Math.max(fromState, fromPositions, fromHistory);
}

function fillIsComplete(fill) {
  if (!fill) return false;
  const st = String(fill.status || '').toLowerCase();
  if (/reject|cancel|fail/.test(st)) return false;
  return /complete|completed|traded|filled/.test(st)
    || (fill.averagePrice != null && Number(fill.averagePrice) > 0);
}

function fillIsRejected(fill) {
  if (!fill) return false;
  return /reject|cancel|fail/.test(String(fill.status || '').toLowerCase());
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
  try {
    syncFromBotState(state);
  } catch (_) {
    /* history is best-effort */
  }
}

function pushLog(state, msg) {
  const at = new Date().toISOString();
  state.log.push({ at, msg });
  if (state.log.length > 80) state.log = state.log.slice(-80);
  try {
    appendLog({
      day: state.date,
      mode: bookModeOf(state.bookMode || state.mode),
      msg,
      at,
    });
  } catch (_) {
    /* history is best-effort */
  }
}

// Avoid spamming the same waiting/budget line every few seconds.
const lastLogByKey = new Map();
function pushLogChange(state, key, msg) {
  if (!msg) return false;
  const id = `${state.date || ''}|${bookModeOf(state.bookMode || state.mode)}|${key}`;
  if (lastLogByKey.get(id) === msg) return false;
  lastLogByKey.set(id, msg);
  pushLog(state, msg);
  return true;
}

/** One-line why options are flat (CE/PE verdict + score + RSI), esp. after a PE SL on an up day. */
function optionsIdleStatus(book, state) {
  const rows = [];
  const seen = new Set();
  for (const list of [book && book.core, book && book.extrasWatch, book && book.extrasSkipHot, book && book.liveBuys]) {
    for (const r of list || []) {
      if (!r || !r.ticker || seen.has(r.ticker)) continue;
      seen.add(r.ticker);
      rows.push(r);
    }
  }
  if (!rows.length) return 'No live BUY picks yet — waiting';

  const closedPe = Object.values((state && state.positions) || {}).some(
    (p) => p && p.status === 'CLOSED' && String(p.right || '').toUpperCase() === 'PE'
  );
  const bits = rows
    .slice()
    .sort((a, b) => {
      // Prefer CE first after a PE stop-out / when explaining a silent up day.
      const ar = String(a.right || '').toUpperCase() === 'CE' ? 0 : 1;
      const br = String(b.right || '').toUpperCase() === 'CE' ? 0 : 1;
      if (ar !== br) return ar - br;
      return (Number(b.profitScore) || 0) - (Number(a.profitScore) || 0);
    })
    .slice(0, 4)
    .map((r) => {
      const right = String(r.right || '').toUpperCase() || '?';
      const verdict = r.verdict || r.action || '—';
      const p = Number(r.profitScore);
      const score = Number(r.score);
      const rsi = Number(r.rsi);
      const why = Array.isArray(r.reasons) && r.reasons.length
        ? r.reasons.slice(0, 2).join(', ')
        : '';
      const parts = [
        `${r.ticker || right}`,
        verdict,
        Number.isFinite(p) ? `P${p}` : null,
        Number.isFinite(score) ? `score${score}` : null,
        Number.isFinite(rsi) ? `RSI${Math.round(rsi)}` : null,
        why || null,
      ].filter(Boolean);
      return parts.join(' ');
    });

  const head = closedPe
    ? 'No options BUY after PE exit'
    : 'No live BUY picks yet';
  return `${head} · ${bits.join(' · ')}`;
}

function roundTick(n, tick = 0.05) {
  return Math.round(Number(n) / tick) * tick;
}

function viewOf(state, phase) {
  const open = Object.values(state.positions || {}).filter((p) => p && p.qty > 0);
  const tradesToday = tradesOpenedCount(state);
  const mode = bookModeOf(state.bookMode || state.mode);
  const tradeCap = maxTradesPerDay(mode);
  const paper = paperEnabled() && !liveEnabled();
  return {
    enabled: true,
    live: !paper,
    paper,
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function orderStatusOf(row) {
  return String((row && (row.status || row.order_status || row.orderStatus)) || '').toLowerCase();
}

function orderAvgPrice(row) {
  const n = Number(
    row && (row.average_price != null ? row.average_price
      : row.averagePrice != null ? row.averagePrice
        : row.price)
  );
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function orderTimeMs(row) {
  const raw = row && (row.exchange_timestamp || row.order_timestamp || row.timestamp || row.order_time);
  if (!raw) return Date.now();
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : Date.now();
}

/** Poll Upstox until order is complete/rejected (or timeout). */
async function waitOrderResult(provider, orderId, { tries = 10, delayMs = 350 } = {}) {
  if (!orderId || !provider || typeof provider.getOrders !== 'function') return null;
  for (let i = 0; i < tries; i += 1) {
    await sleep(delayMs);
    let orders = [];
    try {
      orders = await provider.getOrders();
    } catch (_) {
      continue;
    }
    const hit = (Array.isArray(orders) ? orders : []).find(
      (o) => String(o.order_id || o.orderId || '') === String(orderId)
    );
    if (!hit) continue;
    const status = orderStatusOf(hit);
    const done = /complete|completed|traded|filled|rejected|cancelled|canceled|failed/.test(status);
    if (done) {
      return {
        status: hit.status || hit.order_status || status,
        averagePrice: orderAvgPrice(hit),
        atMs: orderTimeMs(hit),
      };
    }
  }
  return null;
}

async function placeBuy(provider, pick, product) {
  // Long only — BUY CE / BUY PE / stocks. Never sell-to-open options.
  if (paperEnabled() && !liveEnabled()) {
    return { order_id: `PAPER-BUY-${Date.now()}`, paper: true };
  }
  return provider.placeOrder({
    instrumentToken: pick.key,
    quantity: pick.qty,
    transactionType: 'BUY',
    orderType: 'MARKET',
    product,
    tag: TAG,
  });
}

async function orderStillOpen(provider, orderId) {
  if (!orderId || !provider || typeof provider.getOrders !== 'function') return null;
  try {
    const orders = await provider.getOrders();
    const hit = (Array.isArray(orders) ? orders : []).find(
      (o) => String(o.order_id || o.orderId || '') === String(orderId)
    );
    if (!hit) return false;
    const st = orderStatusOf(hit);
    if (/complete|completed|traded|filled|rejected|cancelled|canceled|failed/.test(st)) return false;
    return /open|pending|trigger|modified|after\s*market|amo/.test(st) || st.length > 0;
  } catch (_) {
    return null;
  }
}

async function placeOrReplaceStop(provider, pos, stop, product) {
  if (!pos || pos.status === 'CLOSED' || pos.exiting || !(pos.qty > 0)) return;
  let trigger = roundTick(stop);
  const floor = Math.max(
    Number(pos.initialStop) || 0,
    Number(pos.stop) || 0
  );
  // Long-only: never send a lower SL-M to the broker.
  if (floor > 0 && trigger < floor - 1e-9) trigger = roundTick(floor);
  const ltp = Number(pos.last != null ? pos.last : pos.entry);
  // Long SL-M must stay strictly below LTP or the broker rejects / fires instantly.
  if (Number.isFinite(ltp) && ltp > 0 && trigger >= ltp - 1e-9) {
    pos.stop = floor > 0 ? Math.min(floor, roundTick(ltp * 0.999)) : roundTick(ltp * 0.999);
    return; // hard LTP exit path will flatten if already at/through stop
  }
  if (paperEnabled() && !liveEnabled()) {
    pos.stop = trigger;
    pos.slOrderId = pos.slOrderId || `PAPER-SL-${Date.now()}`;
    return;
  }
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
      const oldId = pos.slOrderId;
      try {
        await provider.cancelOrder(oldId);
      } catch (_) {
        /* may already be filled */
      }
      const still = await orderStillOpen(provider, oldId);
      if (still === true) {
        throw new Error(`SL replace blocked — old SL-M ${oldId} still open`);
      }
      // still === false → gone; null → unknown: only place new if net still long
      if (still === null) {
        const net = await netQtyOpen(provider, pos.key);
        if (net != null && net <= 0) {
          pos.qty = 0;
          pos.slOrderId = null;
          return;
        }
        if (net == null) {
          throw new Error(`SL replace blocked — cannot verify old SL-M ${oldId}`);
        }
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

async function cancelStopOrder(provider, pos) {
  if (!pos || !pos.slOrderId) return false;
  if (paperEnabled() && !liveEnabled()) {
    pos.slOrderId = null;
    return true;
  }
  try {
    await provider.cancelOrder(pos.slOrderId);
    pos.slOrderId = null;
    return true;
  } catch (_) {
    pos.slOrderId = null;
    return false; // may already be filled — check net qty before another SELL
  }
}

async function netQtyOpen(provider, instrumentToken) {
  if (!provider || typeof provider.getPositions !== 'function') return null;
  try {
    const rows = await provider.getPositions();
    const list = Array.isArray(rows) ? rows : [];
    let net = 0;
    for (const r of list) {
      const key = r.instrument_token || r.instrumentToken || r.key;
      if (String(key) !== String(instrumentToken)) continue;
      const q = Number(r.quantity != null ? r.quantity : r.net_quantity != null ? r.net_quantity : r.netQty);
      if (Number.isFinite(q)) net += q;
    }
    return net;
  } catch (_) {
    return null;
  }
}

// One exit only: cancel resting SL-M first, then a single market SELL.
// If SL-M already filled (cancel fails / net qty 0), skip — avoids naked short.
async function marketSell(provider, pos, product, state = null) {
  if (!pos || pos.status === 'CLOSED' || pos.exiting) return null;
  if (!(pos.qty > 0)) return null;
  pos.exiting = true;
  const paper = paperEnabled() && !liveEnabled();
  const cancelled = await cancelStopOrder(provider, pos);
  if (!cancelled && !paper) {
    const net = await netQtyOpen(provider, pos.key);
    if (net != null && net <= 0) {
      pos.qty = 0;
      return { order_id: null, alreadyFlat: true };
    }
    // Cannot verify broker qty → do not risk a naked short after SL-M may have filled.
    if (net == null) {
      pos.exiting = false;
      throw new Error(`SELL ${pos.ticker}: cannot verify position after SL cancel — skipped market sell`);
    }
    if (net > 0 && net < pos.qty) pos.qty = net;
  }
  const qty = pos.qty;
  const ltp = Number(pos.last != null ? pos.last : pos.entry);
  if (state) {
    pushLog(state, `${paper ? 'PAPER ' : ''}ORDER SEND SELL ${pos.ticker} qty ${qty} @~${Number.isFinite(ltp) ? ltp : '—'}${paper ? '' : ' → Upstox'} · ${istFullSecStr()}`);
  }
  if (paper) {
    if (state) {
      pushLog(state, `PAPER ORDER FILLED SELL ${pos.ticker} qty ${qty} @~${Number.isFinite(ltp) ? ltp : '—'} · ${istFullSecStr()}`);
    }
    return { order_id: `PAPER-SELL-${Date.now()}`, paper: true, averagePrice: ltp };
  }
  try {
    const placed = await provider.placeOrder({
      instrumentToken: pos.key,
      quantity: pos.qty,
      transactionType: 'SELL',
      orderType: 'MARKET',
      product,
      tag: TAG,
    });
    const orderId = placed && (placed.order_id || placed.orderId);
    if (state && orderId) {
      pushLog(state, `ORDER ACK SELL ${pos.ticker} order ${orderId} accepted by Upstox · ${istFullSecStr()}`);
      const fill = await waitOrderResult(provider, orderId);
      if (fill) {
        const avg = fill.averagePrice != null ? fill.averagePrice : ltp;
        pushLog(state, `ORDER FILLED SELL ${pos.ticker} qty ${qty} avg ₹${avg} status ${fill.status} · ${istFullSecStr(fill.atMs)}`);
        placed.averagePrice = avg;
      } else {
        pushLog(state, `ORDER PENDING SELL ${pos.ticker} order ${orderId} — no fill confirm yet · ${istFullSecStr()}`);
      }
    }
    return placed;
  } catch (e) {
    pos.exiting = false; // allow retry if broker rejected
    throw e;
  }
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

async function promotePendingBuy(provider, state, ticker, pending, fill, product) {
  const mode = bookModeOf(state.bookMode || state.mode);
  const fillPx = fill.averagePrice != null ? Number(fill.averagePrice) : Number(pending.quote);
  if (!(fillPx > 0) || !(pending.qty > 0)) return false;
  let initialStop = Number(pending.sellStop);
  if (mode === 'options') {
    const forced = optionsInitialStop(fillPx, 0.05);
    if (forced != null) initialStop = forced;
  } else if (!Number.isFinite(initialStop) || initialStop >= fillPx - 1e-9) {
    initialStop = roundTick(fillPx * 0.992);
  }
  const buyAt = new Date().toISOString();
  const pos = {
    ticker,
    key: pending.key,
    qty: pending.qty,
    closedQty: pending.qty,
    entry: fillPx,
    last: fillPx,
    right: pending.right || null,
    initialStop,
    stop: initialStop,
    t1: pending.sellT1,
    t2: pending.sellT2,
    buyOrderId: pending.orderId,
    slOrderId: null,
    stage: 0,
    peak: fillPx,
    trailArmAt: null,
    trailLabel: mode === 'options' ? `initial SL −${optionsStopLossPct()}%` : 'initial SL',
    spend: Number(pending.spend) || fillPx * pending.qty,
    status: 'OPEN',
    buyAt,
  };
  state.positions[ticker] = pos;
  state.tradesToday = tradesOpenedCount(state);
  try {
    recordBuy({
      day: state.date,
      mode,
      ticker: pos.ticker,
      key: pos.key,
      qty: pos.qty,
      entry: pos.entry,
      spend: pos.spend,
      right: pos.right,
      at: buyAt,
    });
  } catch (_) { /* best-effort */ }
  pushLog(state, `BUY ${ticker} qty ${pos.qty} @~${fillPx} order ${pending.orderId} (pending→filled) · ${istFullSecStr()}`);
  try {
    await placeOrReplaceStop(provider, pos, pos.stop, product);
  } catch (e) {
    state.lastError = `SL ${ticker}: ${e.message}`;
    pushLog(state, state.lastError);
  }
  return true;
}

async function resolvePendingBuys(provider, state, product) {
  const pending = state.pendingBuys || {};
  const tickers = Object.keys(pending);
  if (!tickers.length) return;
  for (const ticker of tickers) {
    const row = pending[ticker];
    if (!row || !row.orderId) {
      delete pending[ticker];
      continue;
    }
    if (state.positions[ticker] && state.positions[ticker].qty > 0) {
      delete pending[ticker];
      continue;
    }
    const fill = await waitOrderResult(provider, row.orderId, { tries: 2, delayMs: 200 });
    if (fillIsComplete(fill)) {
      pushLog(state, `ORDER FILLED BUY ${ticker} order ${row.orderId} avg ₹${fill.averagePrice != null ? fill.averagePrice : row.quote} · ${istFullSecStr(fill.atMs)}`);
      await promotePendingBuy(provider, state, ticker, row, fill, product);
      delete pending[ticker];
    } else if (fillIsRejected(fill)) {
      pushLog(state, `ORDER REJECT BUY ${ticker} order ${row.orderId} status ${fill.status} · ${istFullSecStr(fill.atMs)}`);
      state.failedBuys = state.failedBuys || {};
      state.failedBuys[ticker] = Date.now() + 60 * 1000;
      delete pending[ticker];
    } else if (Date.now() - (row.at || 0) > 5 * 60 * 1000) {
      pushLog(state, `ORDER PENDING BUY ${ticker} order ${row.orderId} timed out (5m) — cleared · ${istFullSecStr()}`);
      state.failedBuys = state.failedBuys || {};
      state.failedBuys[ticker] = Date.now() + 60 * 1000;
      delete pending[ticker];
    }
  }
  state.pendingBuys = pending;
}

async function enterFromBook(provider, state, book, product) {
  book = await attachPortfolio(provider, book);
  await resolvePendingBuys(provider, state, product);
  const lossGate = portfolioLossGate(book);
  state.lossGate = lossGate;
  if (lossGate.blocked) {
    state.lastError = lossGate.reason;
    pushLogChange(state, 'lossGate', lossGate.reason);
    return;
  }
  if (state.lastError && String(state.lastError).startsWith('DO NOT TRADE')) {
    state.lastError = '';
  }
  // Back off when Upstox static-IP blocks — avoid spamming place-order every few seconds.
  if (state.orderBlockUntil && Date.now() < state.orderBlockUntil) {
    return;
  }
  const mode = bookModeOf(book);
  state.bookMode = mode;
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
      // Dedupe by ticker names only — omit countdown seconds (they change every tick).
      const tip = warming.slice(0, 3).map((r) => r.ticker).join(', ');
      pushLogChange(state, `waiting:${tip}`, `Waiting confirm (${tip}) — no order yet`);
    } else if (mode === 'options') {
      pushLogChange(state, 'waiting', optionsIdleStatus(book, state));
    } else {
      pushLogChange(state, 'waiting', 'No live BUY picks yet — waiting');
    }
    return;
  }
  const tradeCap = maxTradesPerDay(mode);
  let tradesToday = tradesOpenedCount(state);
  state.tradesToday = tradesToday;
  if (tradeCap > 0 && tradesToday >= tradeCap) {
    pushLogChange(state, 'maxTrades', `Max ${tradeCap} ${mode} trades/day reached (${tradesToday}) — no new BUY`);
    return;
  }
  let spent = Object.values(state.positions).reduce(
    (s, p) => s + ((p && p.qty > 0 && p.status !== 'CLOSED') ? (Number(p.spend) || 0) : 0),
    0
  );
  const cap = spendCap(book, state);
  const hard = Number(state.budgetLimit);
  const unaffordable = [];
  for (const pick of picks) {
    if (tradeCap > 0 && tradesToday >= tradeCap) {
      pushLogChange(state, 'maxTrades', `Max ${tradeCap} trades/day — stopping new entries`);
      break;
    }
    // Options: long premium only (BUY CE / BUY PE). Never sell-to-open.
    if (mode === 'options') {
      const right = String(pick.right || '').toUpperCase();
      if (right && right !== 'CE' && right !== 'PE') {
        pushLogChange(state, `skipRight:${pick.ticker}`, `Skip ${pick.ticker} — options entries are BUY CE/PE only`);
        continue;
      }
    }
    if (state.positions[pick.ticker] && state.positions[pick.ticker].qty > 0 && state.positions[pick.ticker].status !== 'CLOSED') continue;
    // Already traded this ticker today (even if closed) — count as one trade, don't re-enter.
    if (state.positions[pick.ticker] && state.positions[pick.ticker].status === 'CLOSED') continue;
    // Failed earlier this session — don't hammer the same name until backoff clears.
    if (state.failedBuys && state.failedBuys[pick.ticker] && Date.now() < state.failedBuys[pick.ticker]) continue;
    const planSl = Number(pick.sellStop != null ? pick.sellStop : pick.levels && pick.levels.stopLoss);
    const planLtp = Number(pick.ltp);
    // Long: never enter when planned SL is already at/above LTP (would reject or instant-stop).
    if (Number.isFinite(planSl) && Number.isFinite(planLtp) && planSl >= planLtp - 1e-9) {
      pushLogChange(
        state,
        `slAbove:${pick.ticker}`,
        `Skip ${pick.ticker} — SL ${planSl} ≥ LTP ${planLtp} (wait for valid stop below price)`
      );
      continue;
    }
    // Already through T1/T2 on the card — do not open a fresh long.
    if (pick.action === 'EXIT' || pick.action === 'T1 HIT' || pick.stopHit || pick.t1Hit || pick.t2Hit) {
      pushLogChange(
        state,
        `levelHit:${pick.ticker}`,
        `Skip ${pick.ticker} — ${pick.action || 'level hit'} (no new BUY)`
      );
      continue;
    }
    const need = Number(pick.spend) || pick.qty * pick.ltp;
    if (Number.isFinite(hard) && hard > 0 && need > hard + 1) {
      unaffordable.push({ ticker: pick.ticker, need: Math.ceil(need), hard });
      continue;
    }
    if (spent + need > cap + 1) {
      unaffordable.push({ ticker: pick.ticker, need: Math.ceil(need), hard: Math.floor(cap), kind: 'cap' });
      continue;
    }
    try {
      const entry = Number(pick.ltp);
      const paper = paperEnabled() && !liveEnabled();
      pushLog(state, `${paper ? 'PAPER ' : ''}ORDER SEND BUY ${pick.ticker} qty ${pick.qty} @~${entry}${paper ? '' : ' → Upstox'} · ${istFullSecStr()}`);
      const placed = await placeBuy(provider, pick, product);
      const orderId = placed && (placed.order_id || placed.orderId);
      let fill = null;
      if (paper) {
        pushLog(state, `PAPER ORDER FILLED BUY ${pick.ticker} qty ${pick.qty} @~${entry} · ${istFullSecStr()}`);
        fill = { status: 'complete', averagePrice: entry, atMs: Date.now() };
      } else if (orderId) {
        pushLog(state, `ORDER ACK BUY ${pick.ticker} order ${orderId} accepted by Upstox · ${istFullSecStr()}`);
        fill = await waitOrderResult(provider, orderId);
        if (fillIsComplete(fill)) {
          const avg = fill.averagePrice != null ? fill.averagePrice : entry;
          pushLog(state, `ORDER FILLED BUY ${pick.ticker} qty ${pick.qty} avg ₹${avg} status ${fill.status} · ${istFullSecStr(fill.atMs)}`);
        } else if (fillIsRejected(fill)) {
          pushLog(state, `ORDER REJECT BUY ${pick.ticker} order ${orderId} status ${fill.status} · ${istFullSecStr(fill.atMs)}`);
          state.failedBuys = state.failedBuys || {};
          state.failedBuys[pick.ticker] = Date.now() + 60 * 1000;
          continue;
        } else {
          // No confirmed fill — do NOT open a local position (avoids phantom inventory).
          pushLog(state, `ORDER PENDING BUY ${pick.ticker} order ${orderId} — waiting fill, not booking yet · ${istFullSecStr()}`);
          state.pendingBuys = state.pendingBuys || {};
          state.pendingBuys[pick.ticker] = {
            orderId,
            key: pick.key,
            qty: pick.qty,
            right: pick.right || null,
            sellStop: planSl,
            sellT1: pick.sellT1 || (pick.levels && pick.levels.target1),
            sellT2: pick.sellT2 || (pick.levels && pick.levels.target2),
            spend: Number(pick.spend) || null,
            quote: entry,
            at: Date.now(),
          };
          continue;
        }
      } else if (!paper) {
        pushLog(state, `ORDER FAIL BUY ${pick.ticker} — no order id from Upstox · ${istFullSecStr()}`);
        state.failedBuys = state.failedBuys || {};
        state.failedBuys[pick.ticker] = Date.now() + 60 * 1000;
        continue;
      }
      if (!fillIsComplete(fill) && !paper) continue;
      const fillPx = fill && fill.averagePrice != null ? Number(fill.averagePrice) : entry;
      let initialStop = planSl;
      if (mode === 'options') {
        const forced = optionsInitialStop(fillPx, 0.05);
        if (forced != null) initialStop = forced;
      } else if (!Number.isFinite(Number(initialStop)) || Number(initialStop) >= fillPx - 1e-9) {
        initialStop = roundTick(fillPx * 0.992);
      }
      const buyAt = new Date().toISOString();
      const pos = {
        ticker: pick.ticker,
        key: pick.key,
        qty: pick.qty,
        closedQty: pick.qty,
        entry: fillPx,
        last: fillPx,
        right: pick.right || null,
        initialStop,
        stop: initialStop,
        t1: pick.sellT1 || (pick.levels && pick.levels.target1),
        t2: pick.sellT2 || (pick.levels && pick.levels.target2),
        buyOrderId: orderId,
        slOrderId: null,
        stage: 0,
        peak: fillPx,
        trailArmAt: null,
        trailLabel: mode === 'options' ? `initial SL −${optionsStopLossPct()}%` : 'initial SL',
        spend: Number(pick.spend) || fillPx * pick.qty,
        status: 'OPEN',
        buyAt,
      };
      state.positions[pick.ticker] = pos;
      if (state.pendingBuys) delete state.pendingBuys[pick.ticker];
      spent += pos.spend;
      tradesToday += 1;
      state.tradesToday = tradesToday;
      try {
        recordBuy({
          day: state.date,
          mode,
          ticker: pos.ticker,
          key: pos.key,
          qty: pos.qty,
          entry: pos.entry,
          spend: pos.spend,
          right: pos.right,
          at: buyAt,
        });
      } catch (_) {
        /* history is best-effort */
      }
      const tagBuy = paper ? 'PAPER BUY' : 'BUY';
      pushLog(state, `${tagBuy} ${pick.ticker} qty ${pick.qty} @~${fillPx} order ${orderId || '?'} (${tradesToday}/${tradeCap || '∞'}) · ${istFullSecStr()}`);
      try {
        if (!paper) {
          pushLog(state, `ORDER SEND SELL ${pick.ticker} qty ${pick.qty} SL-M trigger ${pos.stop} → Upstox · ${istFullSecStr()}`);
        }
        await placeOrReplaceStop(provider, pos, pos.stop, product);
        if (paper) {
          pushLog(state, `PAPER SL ${pick.ticker} @ ${pos.stop} · ${istFullSecStr()}`);
        } else if (pos.slOrderId) {
          pushLog(state, `ORDER ACK SELL ${pick.ticker} SL-M order ${pos.slOrderId} @ ${pos.stop} · ${istFullSecStr()}`);
        } else {
          pushLog(state, `SL-M ${pick.ticker} @ ${pos.stop} · ${istFullSecStr()}`);
        }
      } catch (e) {
        state.lastError = `SL ${pick.ticker}: ${e.message}`;
        pushLog(state, state.lastError);
      }
    } catch (e) {
      state.lastError = `BUY ${pick.ticker}: ${e.message}`;
      pushLog(state, `${state.lastError} · ${istFullSecStr()}`);
      if (isStaticIpBlock(e)) {
        state.orderBlockUntil = Date.now() + 15 * 60 * 1000;
        state.failedBuys = state.failedBuys || {};
        state.failedBuys[pick.ticker] = state.orderBlockUntil;
        pushLog(state, `Static IP block — pausing BUY 15 min. ${staticIpHint()}`);
        break;
      }
      state.failedBuys = state.failedBuys || {};
      state.failedBuys[pick.ticker] = Date.now() + 60 * 1000;
    }
  }
  if (unaffordable.length) {
    const minNeed = Math.min(...unaffordable.map((u) => u.need));
    const budgetLabel = Number.isFinite(hard) && hard > 0 ? hard : (unaffordable[0].hard || 0);
    const names = unaffordable
      .slice(0, 4)
      .map((u) => `${u.ticker} ₹${u.need}`)
      .join(', ');
    const hint = mode === 'equity'
      ? 'raise MUHURAT_BUDGET_STOCK (or type a higher stock budget at YES)'
      : 'raise MUHURAT_BUDGET_OPTIONS';
    pushLogChange(
      state,
      'unaffordable',
      `Budget ₹${budgetLabel} too small for Live BUY (need ≥ ₹${minNeed}) — ${names}${unaffordable.length > 4 ? '…' : ''} · ${hint}`
    );
  }
  state.entered = Object.values(state.positions).some((p) => p.qty > 0);
}

function markClosed(pos, reason, { day, mode, ltp } = {}) {
  const exitPx = Number.isFinite(Number(ltp)) ? Number(ltp) : Number(pos.last);
  if (Number.isFinite(exitPx)) pos.last = exitPx;
  if (!(pos.closedQty > 0) && pos.qty > 0) pos.closedQty = pos.qty;
  pos.qty = 0;
  pos.status = 'CLOSED';
  pos.exiting = false;
  pos.slOrderId = null;
  pos.exitReason = reason;
  pos.sellAt = new Date().toISOString();
  if (day && pos.ticker) {
    try {
      recordSell({
        day,
        mode: mode || 'equity',
        ticker: pos.ticker,
        key: pos.key,
        qty: pos.closedQty || 0,
        entry: pos.entry,
        exit: exitPx,
        spend: pos.spend,
        exitReason: reason,
        right: pos.right,
        at: pos.sellAt,
      });
    } catch (_) {
      /* history is best-effort */
    }
  }
}

async function syncStopOrderFill(provider, state, pos, mode, ltp) {
  if (!pos || !pos.slOrderId || (paperEnabled() && !liveEnabled())) return false;
  const fill = await waitOrderResult(provider, pos.slOrderId, { tries: 1, delayMs: 0 });
  if (!fillIsComplete(fill)) return false;
  const exitPx = fill.averagePrice != null ? fill.averagePrice : ltp;
  markClosed(pos, 'SL-M', { day: state.date, mode, ltp: exitPx });
  pushLog(state, `ORDER FILLED SELL ${pos.ticker} SL-M order ${pos.slOrderId} avg ₹${exitPx} · ${istFullSecStr(fill.atMs)}`);
  return true;
}

async function managePositions(provider, state, ltpByKey, product) {
  const mode = bookModeOf(state.bookMode || state.mode);
  for (const pos of Object.values(state.positions)) {
    if (!pos || !(pos.qty > 0) || pos.status === 'CLOSED' || pos.exiting) continue;
    const ltp = ltpByKey.get(pos.key);
    if (!Number.isFinite(ltp)) continue;
    pos.last = ltp;
    // Broker SL-M may have filled without our market-sell path — sync local book.
    try {
      if (await syncStopOrderFill(provider, state, pos, mode, ltp)) continue;
    } catch (_) { /* best-effort */ }
    // Hard LTP stop for stocks + options (paper and live). Options also keep −5% floor.
    const hardSl = mode === 'options' && Number.isFinite(pos.entry) && pos.entry > 0
      ? (pos.initialStop != null
        ? Number(pos.initialStop)
        : pos.entry * (1 - optionsStopLossPct() / 100))
      : Number(pos.stop != null ? pos.stop : pos.initialStop);
    if (Number.isFinite(hardSl) && ltp <= hardSl + 1e-9) {
      try {
        const reason = mode === 'options' ? `SL-${optionsStopLossPct()}%` : 'SL';
        await marketSell(provider, pos, product, state);
        markClosed(pos, reason, { day: state.date, mode, ltp });
        const tag = mode === 'options'
          ? `SELL ${pos.ticker} SL −${optionsStopLossPct()}% @~${ltp} (BUY ${pos.right || 'CE/PE'} exit only)`
          : `SELL ${pos.ticker} SL @~${ltp}`;
        pushLog(state, `${tag} · ${istFullSecStr()}`);
      } catch (e) {
        state.lastError = `SL exit ${pos.ticker}: ${e.message}`;
        pushLog(state, state.lastError);
      }
      continue;
    }
    const trail = positionTrail(pos, ltp, mode);
    pos.peak = trail.peak;
    pos.trailArmAt = trail.trailArmAt;
    pos.trailLabel = trail.trailLabel;
    const curStop = Number(pos.stop);
    const initStop = Number(pos.initialStop != null ? pos.initialStop : curStop);
    // Long-only: SL never moves down (trail may only raise).
    let stop = Number(trail.activeStop);
    if (Number.isFinite(initStop)) stop = Math.max(stop || initStop, initStop);
    if (Number.isFinite(curStop)) stop = Math.max(stop || curStop, curStop);
    const stage = trail.trailStage;
    const raised = Number.isFinite(stop) && (!Number.isFinite(curStop) || stop > curStop + 1e-9);
    if (raised || stage > (pos.stage || 0)) {
      pos.stage = Math.max(stage, pos.stage || 0);
      if (raised) {
        try {
          const paper = paperEnabled() && !liveEnabled();
          if (!paper) {
            pushLog(state, `ORDER SEND SELL ${pos.ticker} qty ${pos.qty} SL-M trail ${trail.trailLabel} trigger ${stop} → Upstox · ${istFullSecStr()}`);
          }
          await placeOrReplaceStop(provider, pos, stop, product);
          if (paper) {
            pushLog(state, `PAPER Trail ${pos.ticker} ${trail.trailLabel} SL→${stop} · ${istFullSecStr()}`);
          } else if (pos.slOrderId) {
            pushLog(state, `ORDER ACK SELL ${pos.ticker} SL-M order ${pos.slOrderId} @ ${stop} · ${istFullSecStr()}`);
          } else {
            pushLog(state, `Trail ${pos.ticker} ${trail.trailLabel} SL→${stop} · ${istFullSecStr()}`);
          }
        } catch (e) {
          state.lastError = `Trail ${pos.ticker}: ${e.message}`;
          pushLog(state, `${state.lastError} · ${istFullSecStr()}`);
        }
      }
    }
    // Soft take-profit at T2: market sell (closes long BUY CE/PE — not sell-to-open)
    if (Number.isFinite(pos.t2) && ltp >= pos.t2) {
      try {
        await marketSell(provider, pos, product, state);
        markClosed(pos, 'T2', { day: state.date, mode, ltp });
        pushLog(state, `SELL ${pos.ticker} T2 hit @~${ltp} · ${istFullSecStr()}`);
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
    if (!pos || !(pos.qty > 0) || pos.status === 'CLOSED' || pos.exiting) continue;
    try {
      const qty = pos.qty;
      const sold = await marketSell(provider, pos, product, state);
      if (sold && sold.alreadyFlat) {
        markClosed(pos, '15:15', {
          day: state.date,
          mode: bookModeOf(state.bookMode || state.mode),
          ltp: pos.last,
        });
        pushLog(state, `SQUARE-OFF ${pos.ticker} already flat · ${istFullSecStr()}`);
        continue;
      }
      markClosed(pos, '15:15', {
        day: state.date,
        mode: bookModeOf(state.bookMode || state.mode),
        ltp: pos.last,
      });
      pushLog(state, `SQUARE-OFF ${pos.ticker} qty ${qty} · ${istFullSecStr()}`);
    } catch (e) {
      state.lastError = `Square-off ${pos.ticker}: ${e.message}`;
      pushLog(state, state.lastError);
    }
  }
  // Only mark done when nothing remains open — failed sells retry next tick.
  const stillOpen = Object.values(state.positions || {}).some(
    (p) => p && p.qty > 0 && p.status !== 'CLOSED'
  );
  state.squaredOff = !stillOpen;
  if (stillOpen) {
    pushLogChange(state, 'squareOffRetry', `Square-off incomplete — will retry · ${istFullSecStr()}`);
  }
}

function createMuhuratBot(provider, { mode = 'equity', budget, enforceBudget = false } = {}) {
  if (!tradingEnabled()) return null;
  const paper = paperEnabled() && !liveEnabled();
  const product = productOf();
  const botMode = mode === 'options' ? 'options' : 'equity';
  const budgetLimit = Number(budget) > 0 ? Math.floor(Number(budget)) : budgetOf();
  let busy = false;

  return {
    enabled: true,
    live: !paper,
    paper,
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
  paperEnabled,
  tradingEnabled,
  CONFIRM,
  loadState,
  viewOf,
  portfolioLossGate,
  noTradeLossPct,
  spendCap,
  positionTrail,
  stageFor,
  stopForStage,
  optionsIdleStatus,
  pushLogChange,
  tradesOpenedCount,
  fillIsComplete,
  fillIsRejected,
};
