'use strict';

// Paper plan for the trade screen. Signals only — nothing here places an order.
//
// Equity: HOLD rows keep the real buy price. SELL market value is removed from
// the live portfolio value so NEW BUY cash Y = value − SELL total.
// Index pool ₹50,000 for NIFTY + BANKNIFTY (first signal takes the remaining
// cash, next signal takes what is left). Commodity pool ₹50,000 for names in
// config.paperCommodities (default CRUDE only). Closed trades return stake + P&L.

const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const { istDateKey, istParts, istTimeStr, istFullStr } = require('./time');

const INDEX_IDS = ['NIFTY', 'BANKNIFTY'];
const ALL_COMMODITY_IDS = ['CRUDE', 'GOLD', 'SILVER'];
const INDEX_POOL = 50000;
const COMMODITY_POOL = 50000;

function commodityIds() {
  const wanted = (config.paperCommodities && config.paperCommodities.length)
    ? config.paperCommodities
    : ['CRUDE'];
  return ALL_COMMODITY_IDS.filter((id) => wanted.includes(id));
}
const PAPER_DIR = path.join(__dirname, '..', 'paper');

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function buyPriceOf(card) {
  const last = Number(card && card.last);
  const pct = Number(card && card.pnlPct);
  if (!Number.isFinite(last) || !Number.isFinite(pct) || pct === -100) return null;
  return round2(last / (1 + pct / 100));
}

function marketValue(card) {
  const last = Number(card && card.last);
  const qty = Number(card && card.qty);
  if (!Number.isFinite(last) || !Number.isFinite(qty)) return null;
  return round2(last * qty);
}

function splitCards(cards) {
  const hold = [];
  const sell = [];
  for (const card of cards || []) {
    if (card && card.pnlPct != null && card.pnlPct < -10) sell.push(card);
    else hold.push(card);
  }
  return { hold, sell };
}

function emptyPlan(day) {
  return {
    date: day,
    indexPool: INDEX_POOL,
    commodityPool: COMMODITY_POOL,
    newBuyCash: null,
    newBuyCashStart: null,
    portfolioValue: null,
    sellTotal: null,
    hold: [],
    sell: [],
    trades: [],
    realized: 0,
    unrealized: 0,
    total: null,
    squareOffSaved: false,
  };
}

function planPath(day) {
  return path.join(PAPER_DIR, `plan-${day}.json`);
}

function pnlPath(day) {
  return path.join(PAPER_DIR, `pnl-${day}.json`);
}

function loadPlan(day) {
  try {
    const saved = JSON.parse(fs.readFileSync(planPath(day), 'utf8'));
    if (!saved || saved.date !== day) return emptyPlan(day);
    return {
      ...emptyPlan(day),
      ...saved,
      trades: Array.isArray(saved.trades) ? saved.trades : [],
    };
  } catch (_) {
    return emptyPlan(day);
  }
}

function savePlan(plan) {
  fs.mkdirSync(PAPER_DIR, { recursive: true });
  const { _persistFp, ...rest } = plan;
  fs.writeFileSync(planPath(plan.date), JSON.stringify(rest, null, 2));
}

function savePnlJson(plan, whenLabel) {
  fs.mkdirSync(PAPER_DIR, { recursive: true });
  const payload = {
    date: plan.date,
    savedAt: whenLabel || istFullStr(Date.now()),
    portfolioValue: plan.portfolioValue,
    sellTotal: plan.sellTotal,
    newBuyCashStart: plan.newBuyCashStart,
    newBuyCash: plan.newBuyCash,
    indexPool: plan.indexPool,
    commodityPool: plan.commodityPool,
    hold: plan.hold,
    sell: plan.sell,
    trades: plan.trades,
    realized: plan.realized,
    unrealized: plan.unrealized,
    total: plan.total,
  };
  fs.writeFileSync(pnlPath(plan.date), JSON.stringify(payload, null, 2));
  return payload;
}

function poolKey(id) {
  if (INDEX_IDS.includes(id)) return 'index';
  if (ALL_COMMODITY_IDS.includes(id)) return 'commodity';
  return null;
}

function remainingOf(plan, pool) {
  if (pool === 'index') return plan.indexPool;
  if (pool === 'commodity') return plan.commodityPool;
  return 0;
}

function setRemaining(plan, pool, value) {
  if (pool === 'index') plan.indexPool = round2(value);
  if (pool === 'commodity') plan.commodityPool = round2(value);
}

function sideOf(symbol) {
  if (symbol && symbol.position) {
    if (symbol.position.label === 'BUY PE' || symbol.position.side === 'SHORT') return 'SHORT';
    return 'LONG';
  }
  if (symbol && symbol.direction != null) return symbol.direction < 0 ? 'LONG' : 'SHORT';
  return null;
}

function markPnl(side, entry, last, stake) {
  if (![entry, last, stake].every(Number.isFinite) || entry === 0) return null;
  const move = side === 'SHORT' ? (entry - last) / entry : (last - entry) / entry;
  return round2(stake * move);
}

function hasOpen(plan, id) {
  return (plan.trades || []).some((t) => t.indexId === id && t.status === 'OPEN');
}

function suggestStrike(symbol, side) {
  if (!symbol) return { strike: null, right: null };
  if (symbol.kind === 'commodity' || ALL_COMMODITY_IDS.includes(symbol.id)) {
    return { strike: null, right: null, contract: symbol.contract || null, instrument: 'FUT' };
  }
  const pos = symbol.position;
  if (pos && pos.strike != null) {
    return { strike: pos.strike, right: pos.right || (side === 'SHORT' ? 'PE' : 'CE'), instrument: 'OPT' };
  }
  const lastSig = [...(symbol.signalsToday || [])].reverse().find((s) => s.strike != null);
  if (lastSig) {
    return { strike: lastSig.strike, right: lastSig.right || (side === 'SHORT' ? 'PE' : 'CE'), instrument: 'OPT' };
  }
  const step = symbol.id === 'BANKNIFTY' ? 100 : 50;
  const ltp = Number(symbol.ltp);
  if (!Number.isFinite(ltp)) return { strike: null, right: side === 'SHORT' ? 'PE' : 'CE', instrument: 'OPT' };
  return {
    strike: Math.round(ltp / step) * step,
    right: side === 'SHORT' ? 'PE' : 'CE',
    instrument: 'OPT',
  };
}

function openTrade(plan, { id, name, side, price, when, reason, pool, symbol }) {
  if (!side || !Number.isFinite(price) || price <= 0) return null;
  if (hasOpen(plan, id)) return null;
  const poolLeft = remainingOf(plan, pool);
  const cashLeft = plan.newBuyCash == null ? poolLeft : plan.newBuyCash;
  const stake = round2(Math.min(poolLeft, cashLeft));
  if (!Number.isFinite(stake) || stake <= 0) return null;
  setRemaining(plan, pool, poolLeft - stake);
  if (plan.newBuyCash != null) plan.newBuyCash = round2(plan.newBuyCash - stake);
  const levels = suggestStrike(symbol, side);
  const fut = levels.instrument === 'FUT';
  const row = {
    book: pool,
    index: name || id,
    indexId: id,
    side: fut ? (side === 'SHORT' ? 'SELL FUT' : 'BUY FUT') : side === 'SHORT' ? 'BUY PE' : 'BUY CE',
    strategy: 'Paper plan',
    instrument: levels.instrument || (fut ? 'FUT' : 'OPT'),
    contract: levels.contract || (symbol && symbol.contract) || null,
    strike: levels.strike != null ? levels.strike : null,
    right: levels.right || null,
    qty: null,
    stake,
    entryPrice: round2(price),
    last: round2(price),
    entryAt: when,
    entryT: Date.now(),
    entryReason: reason || 'Setup',
    status: 'OPEN',
    pnl: 0,
  };
  plan.trades.push(row);
  return row;
}

function closeTrade(trade, plan, { price, when, reason }) {
  if (!trade || trade.status !== 'OPEN') return;
  const last = Number(price);
  const short = trade.side === 'BUY PE' || trade.side === 'SELL FUT';
  const pnl = markPnl(short ? 'SHORT' : 'LONG', trade.entryPrice, last, trade.stake);
  trade.status = 'CLOSED';
  trade.exitPrice = round2(last);
  trade.exitAt = when;
  trade.exitReason = reason || 'Square-off';
  trade.pnl = pnl;
  const back = round2((trade.stake || 0) + (pnl || 0));
  const pool = trade.book;
  setRemaining(plan, pool, remainingOf(plan, pool) + (Number.isFinite(back) ? back : trade.stake || 0));
  if (plan.newBuyCash != null && Number.isFinite(back)) plan.newBuyCash = round2(plan.newBuyCash + back);
}

function refreshMarks(plan, symbols) {
  for (const trade of plan.trades || []) {
    if (trade.status !== 'OPEN') continue;
    const symbol = symbols[trade.indexId];
    const last = Number(symbol && symbol.ltp);
    trade.last = Number.isFinite(last) ? round2(last) : trade.entryPrice;
    const short = trade.side === 'BUY PE' || trade.side === 'SELL FUT';
    trade.pnl = markPnl(short ? 'SHORT' : 'LONG', trade.entryPrice, trade.last, trade.stake);
    if (symbol && symbol.contract && !trade.contract) trade.contract = symbol.contract;
    if ((!trade.strike || !trade.right) && symbol) {
      const levels = suggestStrike(symbol, short ? 'SHORT' : 'LONG');
      if (trade.strike == null && levels.strike != null) trade.strike = levels.strike;
      if (!trade.right && levels.right) trade.right = levels.right;
      if (!trade.instrument && levels.instrument) trade.instrument = levels.instrument;
    }
  }
}

function syncEquity(plan, book) {
  const value = book && book.investment != null && book.pnl != null ? round2(book.investment + book.pnl) : null;
  const { hold, sell } = splitCards(book && book.cards);
  let sellTotal = 0;
  plan.sell = sell.map((card) => {
    const valueRow = marketValue(card);
    if (Number.isFinite(valueRow)) sellTotal += valueRow;
    return {
      ticker: card.ticker,
      qty: card.qty,
      last: card.last,
      buyPrice: buyPriceOf(card),
      value: valueRow,
      pnl: card.pnl,
      pnlPct: card.pnlPct,
      status: 'SOLD',
    };
  });
  sellTotal = round2(sellTotal);
  plan.hold = hold.map((card) => {
    const buy = buyPriceOf(card);
    const last = Number(card.last);
    const qty = Number(card.qty);
    const pnl = Number.isFinite(buy) && Number.isFinite(last) && Number.isFinite(qty) ? round2((last - buy) * qty) : card.pnl;
    return {
      ticker: card.ticker,
      qty: card.qty,
      buyPrice: buy,
      last: card.last,
      pnl,
      pnlPct: card.pnlPct,
      status: 'HOLD',
    };
  });
  plan.portfolioValue = value;
  plan.sellTotal = sellTotal;
  const startCash = value != null && sellTotal != null ? round2(Math.max(0, value - sellTotal)) : null;
  if (plan.newBuyCashStart == null && startCash != null) {
    plan.newBuyCashStart = startCash;
    plan.newBuyCash = startCash;
  } else if (startCash != null && plan.newBuyCashStart != null) {
    // Keep the spent amount; refresh the ceiling if the live book moved.
    const spent = round2(plan.newBuyCashStart - (plan.newBuyCash || 0));
    plan.newBuyCashStart = startCash;
    plan.newBuyCash = round2(Math.max(0, startCash - (Number.isFinite(spent) ? spent : 0)));
  }
}

function squareOffHourFor(id) {
  return ALL_COMMODITY_IDS.includes(id) ? { hour: 23, minute: 15 } : { hour: 15, minute: 10 };
}

function pastSquareOff(id, now) {
  const p = istParts(now);
  const cut = squareOffHourFor(id);
  return p.hour > cut.hour || (p.hour === cut.hour && p.minute >= cut.minute);
}

function isWeekend(now) {
  const wd = istParts(now).weekday;
  return wd === 0 || wd === 6;
}

function summarize(plan) {
  let realized = 0;
  let unrealized = 0;
  let any = false;
  for (const t of plan.trades || []) {
    if (t.pnl == null) continue;
    any = true;
    if (t.status === 'CLOSED') realized += t.pnl;
    else unrealized += t.pnl;
  }
  for (const row of plan.hold || []) {
    if (row.pnl == null) continue;
    any = true;
    unrealized += row.pnl;
  }
  plan.realized = round2(realized);
  plan.unrealized = round2(unrealized);
  plan.total = any ? round2(realized + unrealized) : null;
  return plan;
}

function candidates(symbols) {
  const rows = [];
  for (const id of INDEX_IDS.concat(commodityIds())) {
    const symbol = symbols && symbols[id];
    if (!symbol) continue;
    const pool = poolKey(id);
    const live = symbol.position;
    const side = sideOf(symbol);
    const price = Number(symbol.ltp);
    if (!side || !Number.isFinite(price)) continue;
    const reason = live
      ? `Live ${live.label || side}`
      : symbol.lastSession
        ? `${symbol.lastSession} setup`
        : 'Session setup';
    rows.push({
      id,
      name: symbol.name || id,
      side,
      price,
      pool,
      reason,
      symbol,
      t: live && live.entryTimeIST ? 1 : 0,
    });
  }
  // Live positions first, then the rest in index/commodity list order.
  const order = INDEX_IDS.concat(commodityIds());
  rows.sort((a, b) => b.t - a.t || order.indexOf(a.id) - order.indexOf(b.id));
  return rows;
}

function updatePaperPlan({ book, symbols, now = Date.now(), persist = true }) {
  const day = istDateKey(now);
  const plan = loadPlan(day);
  syncEquity(plan, book);
  refreshMarks(plan, symbols || {});

  const when = istTimeStr(now);
  for (const row of candidates(symbols || {})) {
    if (pastSquareOff(row.id, now) && !isWeekend(now)) continue;
    if (hasOpen(plan, row.id)) continue;
    openTrade(plan, {
      id: row.id,
      name: row.name,
      side: row.side,
      price: row.price,
      when: isWeekend(now) && symbols[row.id] && symbols[row.id].lastSession ? symbols[row.id].lastSession : when,
      reason: row.reason,
      pool: row.pool,
      symbol: row.symbol || symbols[row.id],
    });
  }

  let closedAny = false;
  for (const trade of plan.trades || []) {
    if (trade.status !== 'OPEN') continue;
    if (!pastSquareOff(trade.indexId, now)) continue;
    if (isWeekend(now)) continue;
    const symbol = symbols && symbols[trade.indexId];
    closeTrade(trade, plan, {
      price: symbol && symbol.ltp != null ? symbol.ltp : trade.last || trade.entryPrice,
      when,
      reason: `${String(squareOffHourFor(trade.indexId).hour).padStart(2, '0')}:${String(squareOffHourFor(trade.indexId).minute).padStart(2, '0')} square-off`,
    });
    closedAny = true;
  }

  summarize(plan);

  const indexDone = pastSquareOff('NIFTY', now);
  const commodityDone = pastSquareOff('CRUDE', now);
  const shouldSnap = (!isWeekend(now) && indexDone && commodityDone) || isWeekend(now) || (closedAny && indexDone);
  if (shouldSnap) {
    savePnlJson(plan, isWeekend(now) ? `${istFullStr(now)} (last session mark)` : istFullStr(now));
    plan.squareOffSaved = true;
  }

  // Disk write is slower than a feed tick — only persist when the book changes.
  if (persist) {
    const fp = JSON.stringify({
      trades: (plan.trades || []).map((t) => [t.indexId, t.status, t.entryT, t.stake, t.strike]),
      pools: [plan.indexPool, plan.commodityPool, plan.newBuyCash],
      squareOffSaved: plan.squareOffSaved,
    });
    if (fp !== plan._persistFp) {
      plan._persistFp = fp;
      savePlan(plan);
    }
  }
  return plan;
}

function viewTrades(plan) {
  const rows = [];
  for (const row of plan.hold || []) {
    rows.push({
      index: row.ticker,
      indexId: row.ticker,
      strategy: 'HOLD',
      entryAt: row.buyPrice != null ? `buy ${row.buyPrice}` : 'HOLD',
      status: 'HOLD',
      pnl: row.pnl,
    });
  }
  for (const row of plan.sell || []) {
    rows.push({
      index: row.ticker,
      indexId: row.ticker,
      strategy: 'SELL',
      entryAt: 'sold',
      status: 'SOLD',
      pnl: row.pnl,
    });
  }
  for (const trade of plan.trades || []) rows.push(trade);
  return rows;
}

module.exports = {
  INDEX_POOL,
  COMMODITY_POOL,
  splitCards,
  buyPriceOf,
  marketValue,
  emptyPlan,
  loadPlan,
  savePlan,
  savePnlJson,
  updatePaperPlan,
  viewTrades,
  openTrade,
  closeTrade,
  markPnl,
  poolKey,
  candidates,
};
