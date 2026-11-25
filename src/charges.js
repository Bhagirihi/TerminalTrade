'use strict';

// Options charge stack, copied from main's optionsRoundTripCost
// (src/muhurat-backtest.js) — same Upstox intraday rates, same rounding:
// brokerage ₹20/order, STT 0.15% of sell premium (since 1 Apr 2026),
// NSE txn 0.03553% of sell premium, SEBI ₹10/crore of sell premium,
// stamp 0.003% of buy premium, GST 18% on brokerage+txn+SEBI.
// buyValue / sellValue are turnover (Rs), i.e. qty x price.
const OPT_COST = {
  brokeragePerOrder: 20,
  sttSellPct: 0.0015,
  txnSellPct: 0.0003553,
  sebiPct: 0.000001,
  stampBuyPct: 0.00003,
  gstPct: 0.18,
};

function r2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function optionsRoundTripCost(buyValue, sellValue) {
  const b = Number(buyValue) || 0;
  const s = Number(sellValue) || 0;
  const brokerage = r2(OPT_COST.brokeragePerOrder * 2);
  const stt = r2(OPT_COST.sttSellPct * s);
  const txn = r2(OPT_COST.txnSellPct * s);
  const sebi = r2(OPT_COST.sebiPct * s);
  const stamp = r2(OPT_COST.stampBuyPct * b);
  const gst = r2(OPT_COST.gstPct * (brokerage + txn + sebi));
  const total = r2(brokerage + stt + txn + sebi + stamp + gst);
  return { brokerage, stt, txn, sebi, stamp, gst, total };
}

// Net P&L of one options round trip: gross minus the full charge stack.
function optionsNetPnl(qty, buyPx, sellPx) {
  const q = Number(qty) || 0;
  const gross = r2(q * (Number(sellPx) - Number(buyPx)));
  const charges = optionsRoundTripCost(q * Number(buyPx), q * Number(sellPx));
  return { gross, charges: charges.total, net: r2(gross - charges.total) };
}

module.exports = { optionsRoundTripCost, optionsNetPnl };
