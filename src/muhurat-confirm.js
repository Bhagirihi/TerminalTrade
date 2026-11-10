'use strict';

// Stability gate: a name must stay in the top live pool for CONFIRM_SEC
// before it can consume a daily trade slot. Stops flicker from burning max trades.

const fs = require('fs');
const path = require('path');

const PAPER_DIR = path.join(__dirname, '..', 'paper');
const DEFAULT_CONFIRM_SEC = 180; // 3 minutes

function confirmSec() {
  const raw = process.env.MUHURAT_CONFIRM_SEC;
  if (raw == null || raw === '') return DEFAULT_CONFIRM_SEC;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CONFIRM_SEC;
  return Math.floor(n); // 0 = disabled (instant)
}

function ledgerPath(day, mode = 'equity') {
  const tag = mode === 'options' ? 'options' : 'equity';
  return path.join(PAPER_DIR, `muhurat-confirm-${tag}-${day}.json`);
}

function loadConfirmLedger(day, mode = 'equity') {
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath(day, mode), 'utf8'));
    if (!raw || raw.date !== day) return { date: day, mode, names: {} };
    return {
      date: day,
      mode,
      names: raw.names && typeof raw.names === 'object' ? raw.names : {},
    };
  } catch (_) {
    return { date: day, mode, names: {} };
  }
}

function saveConfirmLedger(ledger) {
  fs.mkdirSync(PAPER_DIR, { recursive: true });
  fs.writeFileSync(
    ledgerPath(ledger.date, ledger.mode),
    JSON.stringify(ledger, null, 2)
  );
}

/**
 * Keep only tickers still in the current top pool. New names start a timer.
 * Dropped names lose their streak (must re-confirm if they return).
 */
function updateConfirmLedger(ledger, topTickers, now = Date.now()) {
  const next = {
    date: ledger.date,
    mode: ledger.mode,
    names: {},
  };
  const seen = new Set();
  for (const item of topTickers || []) {
    const ticker = typeof item === 'string' ? item : item && item.ticker;
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    const prev = ledger.names && ledger.names[ticker];
    const p = typeof item === 'object' ? Number(item.profitScore) : null;
    next.names[ticker] = {
      since: prev && prev.since ? prev.since : now,
      lastSeen: now,
      lastP: Number.isFinite(p) ? p : (prev && prev.lastP) || null,
    };
  }
  return next;
}

function confirmAgeSec(ledger, ticker, now = Date.now()) {
  const row = ledger && ledger.names && ledger.names[ticker];
  if (!row || !row.since) return 0;
  return Math.max(0, Math.floor((now - row.since) / 1000));
}

function isConfirmed(ledger, ticker, now = Date.now(), needSec = confirmSec()) {
  if (!(needSec > 0)) return true;
  return confirmAgeSec(ledger, ticker, now) >= needSec;
}

/**
 * Seat order:
 * 1) stickyTickers still in pool (already committed / confirmed earlier)
 * 2) newly confirmed names by P
 * Unconfirmed high-P names are returned in `confirming` (not seated).
 */
function seatWithConfirm(pool, {
  nameCap,
  deployable,
  ledger,
  stickyTickers = [],
  now = Date.now(),
  needSec = confirmSec(),
} = {}) {
  const seated = [];
  const confirming = [];
  const seen = new Set();
  let seatCost = 0;

  const byTicker = new Map();
  for (const row of pool || []) {
    if (row && row.ticker && !byTicker.has(row.ticker)) byTicker.set(row.ticker, row);
  }

  const trySeat = (row, { ready }) => {
    if (!row || !row.ticker || seen.has(row.ticker) || !(row.ltp > 0)) return false;
    if (nameCap > 0 && seated.length >= nameCap) return false;
    if (seatCost + row.ltp > deployable + 1) return false;
    const age = confirmAgeSec(ledger, row.ticker, now);
    const confirmed = isConfirmed(ledger, row.ticker, now, needSec);
    if (!ready && !confirmed) {
      if (!confirming.some((c) => c.ticker === row.ticker)) {
        confirming.push({
          ...row,
          orderReady: false,
          confirmAgeSec: age,
          confirmNeedSec: needSec,
          confirmLeftSec: Math.max(0, needSec - age),
        });
      }
      return false;
    }
    seated.push({
      ...row,
      orderReady: true,
      confirmAgeSec: age,
      confirmNeedSec: needSec,
      confirmLeftSec: 0,
    });
    seen.add(row.ticker);
    seatCost += row.ltp;
    return true;
  };

  // Sticky first — already using a trade slot mentally / still strong.
  for (const t of stickyTickers || []) {
    const row = byTicker.get(t);
    if (row) trySeat(row, { ready: true });
  }

  // Then highest-P confirmed names.
  for (const row of pool || []) {
    if (seen.has(row.ticker)) continue;
    trySeat(row, { ready: false });
  }

  // Remaining unconfirmed top names (for UI), capped.
  for (const row of pool || []) {
    if (seen.has(row.ticker)) continue;
    if (confirming.some((c) => c.ticker === row.ticker)) continue;
    if (isConfirmed(ledger, row.ticker, now, needSec)) continue;
    const age = confirmAgeSec(ledger, row.ticker, now);
    confirming.push({
      ...row,
      orderReady: false,
      confirmAgeSec: age,
      confirmNeedSec: needSec,
      confirmLeftSec: Math.max(0, needSec - age),
    });
    if (confirming.length >= Math.max(nameCap || 5, 5)) break;
  }

  return { seated, confirming, seatCost };
}

module.exports = {
  DEFAULT_CONFIRM_SEC,
  confirmSec,
  loadConfirmLedger,
  saveConfirmLedger,
  updateConfirmLedger,
  confirmAgeSec,
  isConfirmed,
  seatWithConfirm,
};
