'use strict';

// Live trading for V3 watch mode. Real money when called.
//   entry: MARKET BUY, then a broker SL-M SELL at the stop (the real
//   protection, placed immediately after the fill).
//   exits: SL is left to the broker SL-M (detected by polling orders);
//   T2 and the 15:15 square-off sell at market after cancelling the SL-M.
//   A market sell is NEVER placed while an SL-M may still be live —
//   cancelling first is what keeps one position from being sold twice.
//   Order placement is single-attempt: a failed buy is never retried
//   (a retry without an idempotency key could double-buy — the C2 lesson
//   from muhurat2's placeOrder).
//
// Levels are recomputed off the ACTUAL fill price (SL −5%, T1 +22%,
// T2 +45% of the fill), not the card's LTP — muhurat2's gap was that
// slippage repriced the trade while T1/T2 stayed at the planned levels.

const fs = require('fs');
const path = require('path');
const { optionsNetPnl } = require('./charges');

const LIVE_DIR = path.join(__dirname, '..', 'live');
const LIVE_FILE = path.join(LIVE_DIR, 'v3-live-trades.jsonl');

function loadLiveTrades() {
  try {
    const raw = fs.readFileSync(LIVE_FILE, 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (_) {
    return [];
  }
}

function saveLiveTrades(trades) {
  fs.mkdirSync(LIVE_DIR, { recursive: true });
  fs.writeFileSync(LIVE_FILE, trades.map((t) => JSON.stringify(t)).join('\n') + (trades.length ? '\n' : ''));
}

function recordLiveTrade(trade) {
  fs.mkdirSync(LIVE_DIR, { recursive: true });
  fs.appendFileSync(LIVE_FILE, JSON.stringify(trade) + '\n');
}

function findOrder(orders, orderId) {
  return (Array.isArray(orders) ? orders : []).find(
    (o) => String(o.order_id || o.orderId || '') === String(orderId)
  );
}

function isTerminal(status) {
  return /complete|completed|traded|filled|rejected|cancelled|canceled|failed/.test(
    String(status || '').toLowerCase()
  );
}

function isFilled(status) {
  return /complete|completed|traded|filled/.test(String(status || '').toLowerCase());
}

// Place the live entry for a sized card. Returns the position fields
// (entry/sl/t1/t2 off the fill) plus order ids. Throws only when NO
// position was taken (buy rejected / no order id); a missing fill confirm
// still places the SL-M off the card levels and marks fillUnknown.
async function placeLiveEntry(api, card, qty) {
  const buy = await api.placeOrder({
    instrumentToken: card.instrumentKey,
    quantity: qty,
    transactionType: 'BUY',
    orderType: 'MARKET',
    product: 'I',
    tag: 'V3',
  });
  const buyOrderId = buy && (buy.order_id || buy.orderId);
  if (!buyOrderId) throw new Error('live buy: no order id returned');

  const fill = await api.getOrderResult(buyOrderId);
  if (fill && !isFilled(fill.status)) {
    throw new Error(`live buy ${buyOrderId}: ${fill.status} — no position taken`);
  }
  const fillUnknown = !fill;
  const entry = fill && Number.isFinite(fill.averagePrice) && fill.averagePrice > 0
    ? fill.averagePrice
    : card.ltp;
  const sl = +(entry * 0.95).toFixed(2);
  const t1 = +(entry * 1.22).toFixed(2);
  const t2 = +(entry * 1.45).toFixed(2);

  let slmOrderId = null;
  let slmError = null;
  try {
    const slm = await api.placeOrder({
      instrumentToken: card.instrumentKey,
      quantity: qty,
      transactionType: 'SELL',
      orderType: 'SL-M',
      triggerPrice: sl,
      product: 'I',
      tag: 'V3-SL',
    });
    slmOrderId = slm && (slm.order_id || slm.orderId);
    if (!slmOrderId) slmError = 'SL-M: no order id returned';
  } catch (e) {
    slmError = `SL-M failed: ${e.message || e}`;
  }
  return { buyOrderId, entry, sl, t1, t2, slmOrderId, slmError, fillUnknown };
}

// Poll the broker's orders once; any OPEN live position whose SL-M has
// filled is closed at the SL-M's average price (or the stop level).
// Returns the newly closed positions. Mutates the positions in place.
async function syncLivePositions(api, positions) {
  const open = positions.filter((p) => p.status === 'OPEN' && p.slmOrderId);
  if (!open.length) return [];
  const orders = await api.getOrders();
  const closed = [];
  for (const pos of open) {
    const slm = findOrder(orders, pos.slmOrderId);
    if (!slm || !isFilled(slm.status)) continue;
    const avg = Number(slm.average_price != null ? slm.average_price : slm.averagePrice);
    const exit = Number.isFinite(avg) && avg > 0 ? avg : pos.sl;
    const { gross, charges, net } = optionsNetPnl(pos.qty, pos.entry, exit);
    Object.assign(pos, {
      status: 'CLOSED', exit, exitReason: 'SL-M', exitAt: new Date().toISOString(),
      grossPnl: gross, charges, netPnl: net,
    });
    closed.push(pos);
  }
  if (closed.length) {
    // Merge into the full ledger — never rewrite the file with only the
    // in-memory (today's open) subset, or older trades would be wiped.
    const all = loadLiveTrades().map((t) => {
      const cur = positions.find((p) => p.id === t.id);
      return cur || t;
    });
    saveLiveTrades(all);
  }
  return closed;
}

// Exit a live position at market (T2 or 15:15 square-off). Cancels the
// SL-M first; if the SL-M already filled, or the cancel fails, it does
// NOT sell — the broker stop owns the position then. Returns
// { ok, exit?, reason? } and closes the record on success.
async function exitLivePosition(api, pos, reason, exitPx) {
  if (pos.slmOrderId) {
    let orders = [];
    try { orders = await api.getOrders(); } catch (_) { orders = []; }
    const slm = findOrder(orders, pos.slmOrderId);
    if (slm && isFilled(slm.status)) {
      return { ok: false, reason: 'SL-M already filled — broker owns the exit' };
    }
    try {
      await api.cancelOrder(pos.slmOrderId);
    } catch (e) {
      return { ok: false, reason: `SL-M cancel failed (${e.message || e}) — not selling, broker stop stays live` };
    }
  }
  const sell = await api.placeOrder({
    instrumentToken: pos.instrumentKey,
    quantity: pos.qty,
    transactionType: 'SELL',
    orderType: 'MARKET',
    product: 'I',
    tag: 'V3',
  });
  const sellOrderId = sell && (sell.order_id || sell.orderId);
  if (!sellOrderId) throw new Error('live sell: no order id returned');
  const fill = await api.getOrderResult(sellOrderId);
  const exit = fill && Number.isFinite(fill.averagePrice) && fill.averagePrice > 0
    ? fill.averagePrice
    : exitPx;
  const { gross, charges, net } = optionsNetPnl(pos.qty, pos.entry, exit);
  Object.assign(pos, {
    status: 'CLOSED', exit, exitReason: reason, exitAt: new Date().toISOString(),
    sellOrderId, grossPnl: gross, charges, netPnl: net,
  });
  return { ok: true, exit };
}

module.exports = {
  LIVE_FILE,
  loadLiveTrades,
  saveLiveTrades,
  recordLiveTrade,
  placeLiveEntry,
  syncLivePositions,
  exitLivePosition,
};
