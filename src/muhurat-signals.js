'use strict';

// Shared USER SIGNAL shape for terminal + web: ticker + IST stamp + price at first sight.

const { istDateKey, istFullSecStr } = require('./time');
const { levelOverrideAction, actionBlocksNewBuy, positionLevelAction } = require('./muhurat');

const firstSeen = new Map(); // `${day}|${side}|${ticker}` -> { at, atIst, price }

function dayKey(now = Date.now()) {
  return istDateKey(now);
}

function stampSignal(side, ticker, price, now = Date.now()) {
  const key = `${dayKey(now)}|${side}|${ticker}`;
  const existing = firstSeen.get(key);
  if (existing) return existing;
  const px = Number(price);
  const row = {
    ticker,
    side,
    at: new Date(now).toISOString(),
    atIst: istFullSecStr(now),
    price: Number.isFinite(px) ? Math.round(px * 100) / 100 : null,
  };
  firstSeen.set(key, row);
  return row;
}

function formatSignal(sig) {
  if (!sig) return '';
  if (typeof sig === 'string') return sig;
  const px = sig.price != null ? Number(sig.price).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) : '—';
  const when = sig.atIst || sig.at || '—';
  return `${sig.ticker} · ${when} · ₹${px}`;
}

function collectUserSignals(book, bot) {
  const buys = [];
  const sells = [];
  const seenB = new Set();
  const seenS = new Set();
  const phase = (book && book.phase) || {};
  const lossGate = (bot && bot.lossGate) || (book && book.lossGate);
  const now = Date.now();

  if (!(lossGate && lossGate.blocked) && phase.canDecideBuy !== false) {
    for (const r of (book && book.liveBuys) || []) {
      if (!r || !r.ticker || r.verdict !== 'BUY') continue;
      if (!(Number(r.profitScore) > 12) || !(r.qty > 0) || r.orderReady === false) continue;
      const override = levelOverrideAction(r);
      // Stop / target hit → SELL cue, never BUY(USER).
      if (actionBlocksNewBuy(override)) {
        if (!seenS.has(r.ticker)) {
          seenS.add(r.ticker);
          sells.push(stampSignal('SELL', r.ticker, r.ltp != null ? r.ltp : r.entry, now));
        }
        continue;
      }
      if (seenB.has(r.ticker)) continue;
      seenB.add(r.ticker);
      buys.push(stampSignal('BUY', r.ticker, r.ltp != null ? r.ltp : r.entry, now));
    }
  }

  const err = String((bot && bot.lastError) || '');
  const m = err.match(/^BUY\s+([A-Z0-9 .&-]+)\s*:/i);
  if (m && m[1] && !seenB.has(m[1].trim()) && !seenS.has(m[1].trim())) {
    const t = m[1].trim();
    seenB.add(t);
    buys.unshift(stampSignal('BUY', t, null, now));
  }

  const exitOnly = phase.phase === 'exit_only' || phase.phase === 'closed';
  for (const p of (bot && bot.positions) || []) {
    if (!p || !p.ticker || !(p.qty > 0) || seenS.has(p.ticker)) continue;
    const tag = positionLevelAction(p);
    if (exitOnly || tag === 'EXIT' || tag === 'T1 HIT') {
      seenS.add(p.ticker);
      const last = Number(p.last);
      sells.push(stampSignal('SELL', p.ticker, Number.isFinite(last) ? last : p.entry, now));
    }
  }

  return {
    buys: buys.slice(0, 8),
    sells: sells.slice(0, 8),
  };
}

module.exports = {
  stampSignal,
  formatSignal,
  collectUserSignals,
  firstSeen,
};
