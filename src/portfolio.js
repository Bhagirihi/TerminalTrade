'use strict';

// Upstox portfolio totals. Holdings are the delivery book. Open F&O and
// intraday positions are added on top. A delivery equity position is left
// out, because that stock is already in the holdings list.

function round2(n) {
  return Math.round(n * 100) / 100;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function holdingUnits(row) {
  const qty = num(row && row.quantity);
  const t1 = num(row && row.t1_quantity);
  if (qty != null && qty !== 0) return qty;
  if (t1 != null && t1 !== 0) return t1;
  return 0;
}

function isDeliveryEquity(row) {
  const token = String((row && row.instrument_token) || '');
  const exchange = String((row && row.exchange) || '');
  const product = String((row && row.product) || '');
  const derivative = token.includes('_FO') || exchange === 'NFO' || exchange === 'BFO' || exchange === 'MCX';
  if (derivative) return false;
  return product === 'D';
}

function summarizePortfolio(holdings, positions) {
  let investment = 0;
  let pnl = 0;
  let holdingCount = 0;
  let positionCount = 0;

  for (const row of holdings || []) {
    const units = holdingUnits(row);
    if (!units) continue;
    const avg = num(row.average_price);
    if (avg == null) continue;
    const last = num(row.last_price);
    const api = num(row.pnl);
    investment += avg * units;
    pnl += api != null ? api : last != null ? (last - avg) * units : 0;
    holdingCount += 1;
  }

  for (const row of positions || []) {
    if (isDeliveryEquity(row)) continue;
    const units = num(row.quantity) || 0;
    const mult = num(row.multiplier);
    const m = mult != null && mult > 0 ? mult : 1;
    const avg = num(row.average_price);
    const api = num(row.pnl);
    const realised = num(row.realised) || 0;
    const unrealised = num(row.unrealised) || 0;
    const leg = api != null ? api : realised + unrealised;
    if (!units && !leg) continue;
    if (units && avg != null) investment += Math.abs(units) * avg * m;
    pnl += leg;
    if (units) positionCount += 1;
  }

  return {
    investment: round2(investment),
    pnl: round2(pnl),
    holdings: holdingCount,
    positions: positionCount,
    error: null,
  };
}

module.exports = { summarizePortfolio, summarizeLive };

// Live variant of summarizePortfolio: each row's P&L prefers a live LTP tick
// (ltpOf(row) -> number|null) over the REST snapshot's pnl/last_price, so the
// dashboard P&L moves tick-by-tick between the ~20s portfolio polls.
// liveCount = rows priced from a live tick; totalCount = rows counted.
function summarizeLive(holdings, positions, ltpOf) {
  let investment = 0;
  let pnl = 0;
  let holdingCount = 0;
  let positionCount = 0;
  let liveCount = 0;
  let totalCount = 0;

  const liveOf = (row) => {
    const v = ltpOf ? ltpOf(row) : null;
    return Number.isFinite(v) ? v : null;
  };

  for (const row of holdings || []) {
    const units = holdingUnits(row);
    if (!units) continue;
    const avg = num(row.average_price);
    if (avg == null) continue;
    const live = liveOf(row);
    const last = live != null ? live : num(row.last_price);
    // A live quote beats the REST snapshot's pnl, which is stale by up to one poll.
    const api = live != null ? null : num(row.pnl);
    investment += avg * units;
    pnl += api != null ? api : last != null ? (last - avg) * units : 0;
    if (live != null) liveCount += 1;
    totalCount += 1;
    holdingCount += 1;
  }

  for (const row of positions || []) {
    if (isDeliveryEquity(row)) continue;
    const units = num(row.quantity) || 0;
    const mult = num(row.multiplier);
    const m = mult != null && mult > 0 ? mult : 1;
    const avg = num(row.average_price);
    const live = liveOf(row);
    const api = live != null ? null : num(row.pnl);
    const realised = num(row.realised) || 0;
    const unrealised = num(row.unrealised) || 0;
    const leg =
      api != null ? api : live != null && avg != null ? (live - avg) * units * m : realised + unrealised;
    if (!units && !leg) continue;
    if (units && avg != null) investment += Math.abs(units) * avg * m;
    pnl += leg;
    if (live != null && units) liveCount += 1;
    if (units || leg) totalCount += 1;
    if (units) positionCount += 1;
  }

  return {
    investment: round2(investment),
    pnl: round2(pnl),
    holdings: holdingCount,
    positions: positionCount,
    liveCount,
    totalCount,
    error: null,
  };
}
