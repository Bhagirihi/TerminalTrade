'use strict';

// Listed option strikes, not the raw index print.
// Nifty is every 50 (22700, 22750, 22800). Bank Nifty near the money is every 100.

function nearestListedStrike(price, strikes) {
  if (!Number.isFinite(price) || !strikes || !strikes.length) return null;
  let best = null;
  let bestDist = Infinity;
  for (const strike of strikes) {
    const dist = Math.abs(strike - price);
    if (dist < bestDist || (dist === bestDist && (best == null || strike < best))) {
      best = strike;
      bestDist = dist;
    }
  }
  return best;
}

function nearestStepStrike(price, step) {
  if (!Number.isFinite(price) || !step) return null;
  return Math.round(price / step) * step;
}

function rightForSignal(signal) {
  if (!signal) return null;
  if (signal.type === 'BUY CE' || signal.type === 'EXIT CE') return 'CE';
  if (signal.type === 'BUY PE' || signal.type === 'EXIT PE') return 'PE';
  if (signal.side === 'LONG') return 'CE';
  if (signal.side === 'SHORT') return 'PE';
  return null;
}

module.exports = { nearestListedStrike, nearestStepStrike, rightForSignal };
