'use strict';

// Paper book for one index. Both BUY CE and BUY PE are long the option,
// so the result is always exit premium minus entry premium, times quantity.
// Nothing here sends an order.

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function investmentOf(premium, qty) {
  if (premium == null || qty == null) return null;
  const n = Number(premium) * Number(qty);
  return Number.isFinite(n) ? round2(n) : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "23 Oct 09:15". A signal with no date keeps the clock time alone.
function whenLabel(dateKey, time) {
  const clock = time || '';
  const parts = String(dateKey || '').split('-');
  const month = MONTHS[Number(parts[1]) - 1];
  const day = Number(parts[2]);
  if (!month || !day) return clock || '—';
  return clock ? `${day} ${month} ${clock}` : `${day} ${month}`;
}

function buildPaperTrades({ index, indexId, signals, lotSize, markPremium }) {
  const trades = [];
  let open = null;

  for (const s of signals || []) {
    if (s.type === 'BUY CE' || s.type === 'BUY PE') {
      open = {
        index,
        indexId,
        side: s.type,
        strike: s.strike,
        right: s.right,
        qty: lotSize,
        entryTime: s.timeIST,
        entryDate: s.dateKey || null,
        entryAt: whenLabel(s.dateKey, s.timeIST),
        entryT: s.t,
        entryPremium: s.premium,
        investment: investmentOf(s.premium, lotSize),
        stopLoss: s.stopLoss,
        target: s.target,
        entryReason: s.reason,
        status: 'OPEN',
      };
      continue;
    }
    if (!open) continue;
    if (s.type !== 'EXIT CE' && s.type !== 'EXIT PE' && s.type !== 'SQOFF') continue;
    const pts = s.premium == null || open.entryPremium == null ? null : round2(s.premium - open.entryPremium);
    trades.push({
      ...open,
      status: 'CLOSED',
      exitTime: s.timeIST,
      exitDate: s.dateKey || null,
      exitAt: whenLabel(s.dateKey, s.timeIST),
      exitT: s.t,
      exitPremium: s.premium,
      exitReason: s.reason,
      premiumPoints: pts,
      pnl: pts == null ? null : round2(pts * open.qty),
    });
    open = null;
  }

  if (open) {
    const pts = markPremium == null || open.entryPremium == null ? null : round2(markPremium - open.entryPremium);
    trades.push({
      ...open,
      markPremium: round2(markPremium),
      premiumPoints: pts,
      pnl: pts == null ? null : round2(pts * open.qty),
    });
  }
  return trades;
}

function summarizePaper(trades) {
  let realized = 0;
  let unrealized = 0;
  let realizedKnown = false;
  let unrealizedKnown = false;
  let priced = 0;
  for (const t of trades) {
    if (t.pnl == null) continue;
    priced += 1;
    if (t.status === 'CLOSED') {
      realized += t.pnl;
      realizedKnown = true;
    } else {
      unrealized += t.pnl;
      unrealizedKnown = true;
    }
  }
  const realizedR = realizedKnown ? round2(realized) : 0;
  const unrealizedR = unrealizedKnown ? round2(unrealized) : 0;
  const any = realizedKnown || unrealizedKnown;
  return {
    trades,
    realized: realizedR,
    unrealized: unrealizedR,
    // Null when every row is missing a premium. A zero here would look like a flat book.
    total: any ? round2(realizedR + unrealizedR) : null,
    priced,
    unpriced: trades.length - priced,
  };
}

module.exports = { buildPaperTrades, summarizePaper, whenLabel };
