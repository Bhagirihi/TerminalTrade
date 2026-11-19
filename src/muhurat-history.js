'use strict';

// Persistent Muhurat logs + daily P&L / investment ledger under paper/muhurat-history/.
// Survives restarts; UI serves this at /muhuratlogs.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'paper', 'muhurat-history');
const LOGS_DIR = path.join(ROOT, 'logs');
const DAYS_DIR = path.join(ROOT, 'days');

function ensureDirs() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.mkdirSync(DAYS_DIR, { recursive: true });
}

function dayFile(day) {
  return path.join(DAYS_DIR, `${day}.json`);
}

function logFile(day) {
  return path.join(LOGS_DIR, `${day}.jsonl`);
}

function r2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function emptyDay(day) {
  return {
    date: day,
    updatedAt: null,
    investment: 0,
    realizedPnl: 0,
    openInvestment: 0,
    trades: [],
    byMode: {
      equity: { investment: 0, realizedPnl: 0, openInvestment: 0, tradeCount: 0 },
      options: { investment: 0, realizedPnl: 0, openInvestment: 0, tradeCount: 0 },
    },
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDirs();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadDay(day) {
  if (!day) return emptyDay('');
  const raw = readJson(dayFile(day), null);
  if (!raw || raw.date !== day) return emptyDay(day);
  return {
    ...emptyDay(day),
    ...raw,
    trades: Array.isArray(raw.trades) ? raw.trades : [],
    byMode: {
      ...emptyDay(day).byMode,
      ...(raw.byMode && typeof raw.byMode === 'object' ? raw.byMode : {}),
    },
  };
}

function saveDay(doc) {
  if (!doc || !doc.date) return;
  doc.updatedAt = new Date().toISOString();
  writeJson(dayFile(doc.date), doc);
}

function appendLog({ day, msg, mode, at } = {}) {
  if (!day || !msg) return;
  ensureDirs();
  const row = {
    at: at || new Date().toISOString(),
    mode: mode === 'options' ? 'options' : 'equity',
    msg: String(msg),
  };
  fs.appendFileSync(logFile(day), `${JSON.stringify(row)}\n`);
}

function readLogs(day, { limit = 500, mode } = {}) {
  if (!day) return [];
  let text = '';
  try {
    text = fs.readFileSync(logFile(day), 'utf8');
  } catch (_) {
    return [];
  }
  const lines = text.split('\n').filter(Boolean);
  const cap = Math.min(Math.max(Number(limit) || 500, 1), 5000);
  const slice = lines.slice(-cap);
  const out = [];
  for (const line of slice) {
    try {
      const row = JSON.parse(line);
      if (mode && row.mode !== mode) continue;
      out.push(row);
    } catch (_) {
      /* skip bad line */
    }
  }
  return out;
}

function tradeKey(mode, ticker) {
  return `${mode === 'options' ? 'options' : 'equity'}::${ticker}`;
}

function upsertTrade(doc, patch) {
  const mode = patch.mode === 'options' ? 'options' : 'equity';
  const key = tradeKey(mode, patch.ticker);
  let row = doc.trades.find((t) => tradeKey(t.mode, t.ticker) === key);
  if (!row) {
    row = {
      ticker: patch.ticker,
      mode,
      key: patch.key || null,
      qty: patch.qty || 0,
      entry: null,
      exit: null,
      spend: 0,
      pnl: null,
      exitReason: null,
      status: 'OPEN',
      buyAt: null,
      sellAt: null,
      right: patch.right || null,
    };
    doc.trades.push(row);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    row[k] = v;
  }
  row.mode = mode;
  row.ticker = patch.ticker || row.ticker;
  return row;
}

function recomputeDay(doc) {
  let investment = 0;
  let realizedPnl = 0;
  let openInvestment = 0;
  const byMode = {
    equity: { investment: 0, realizedPnl: 0, openInvestment: 0, tradeCount: 0 },
    options: { investment: 0, realizedPnl: 0, openInvestment: 0, tradeCount: 0 },
  };
  for (const t of doc.trades) {
    const mode = t.mode === 'options' ? 'options' : 'equity';
    const spend = Number(t.spend) || 0;
    const bucket = byMode[mode];
    bucket.tradeCount += 1;
    if (t.status === 'CLOSED') {
      investment += spend;
      bucket.investment += spend;
      const pnl = Number(t.pnl);
      if (Number.isFinite(pnl)) {
        realizedPnl += pnl;
        bucket.realizedPnl += pnl;
      }
    } else {
      openInvestment += spend;
      bucket.openInvestment += spend;
      investment += spend;
      bucket.investment += spend;
    }
  }
  doc.investment = r2(investment);
  doc.realizedPnl = r2(realizedPnl);
  doc.openInvestment = r2(openInvestment);
  for (const k of Object.keys(byMode)) {
    byMode[k].investment = r2(byMode[k].investment);
    byMode[k].realizedPnl = r2(byMode[k].realizedPnl);
    byMode[k].openInvestment = r2(byMode[k].openInvestment);
  }
  doc.byMode = byMode;
  return doc;
}

function recordBuy({
  day, mode, ticker, key, qty, entry, spend, right, at,
} = {}) {
  if (!day || !ticker) return null;
  const doc = loadDay(day);
  upsertTrade(doc, {
    ticker,
    mode,
    key,
    qty,
    entry: entry != null ? r2(entry) : null,
    spend: spend != null ? r2(spend) : r2((Number(entry) || 0) * (Number(qty) || 0)),
    right: right || null,
    status: 'OPEN',
    buyAt: at || new Date().toISOString(),
    exit: null,
    pnl: null,
    exitReason: null,
    sellAt: null,
  });
  recomputeDay(doc);
  saveDay(doc);
  return doc;
}

function recordSell({
  day, mode, ticker, qty, exit, entry, spend, exitReason, right, at, key,
} = {}) {
  if (!day || !ticker) return null;
  const doc = loadDay(day);
  const e = Number(entry);
  const x = Number(exit);
  const q = Number(qty) || 0;
  let pnl = null;
  if (Number.isFinite(e) && Number.isFinite(x) && q > 0) {
    pnl = r2((x - e) * q);
  }
  upsertTrade(doc, {
    ticker,
    mode,
    key,
    qty: q || undefined,
    entry: Number.isFinite(e) ? r2(e) : undefined,
    exit: Number.isFinite(x) ? r2(x) : null,
    spend: spend != null ? r2(spend) : undefined,
    right: right || undefined,
    status: 'CLOSED',
    exitReason: exitReason || null,
    sellAt: at || new Date().toISOString(),
    pnl,
  });
  recomputeDay(doc);
  saveDay(doc);
  return doc;
}

/** Sync open/closed positions from bot state into the day ledger. */
function syncFromBotState(state) {
  if (!state || !state.date) return null;
  const mode = state.bookMode === 'options' || state.mode === 'options' ? 'options' : 'equity';
  const doc = loadDay(state.date);
  for (const pos of Object.values(state.positions || {})) {
    if (!pos || !pos.ticker) continue;
    const status = pos.status === 'CLOSED' || !(pos.qty > 0) ? 'CLOSED' : 'OPEN';
    const entry = Number(pos.entry);
    const exitPx = Number(pos.last != null ? pos.last : pos.exit);
    const qty = Number(pos.qty > 0 ? pos.qty : pos.closedQty) || Number(pos.qty) || 0;
    const spend = Number(pos.spend) || (Number.isFinite(entry) ? r2(entry * (qty || 0)) : 0);
    let pnl = null;
    if (status === 'CLOSED' && Number.isFinite(entry) && Number.isFinite(exitPx)) {
      const closedQty = Number(pos.closedQty) || qty || 0;
      // Prefer qty captured at open via spend/entry.
      const q = closedQty > 0 ? closedQty : (spend > 0 && entry > 0 ? Math.round(spend / entry) : 0);
      if (q > 0) pnl = r2((exitPx - entry) * q);
    }
    const existing = doc.trades.find((t) => tradeKey(t.mode, t.ticker) === tradeKey(mode, pos.ticker));
    upsertTrade(doc, {
      ticker: pos.ticker,
      mode,
      key: pos.key || null,
      qty: status === 'CLOSED'
        ? (Number(pos.closedQty) || (spend > 0 && entry > 0 ? Math.round(spend / entry) : qty) || qty)
        : qty,
      entry: Number.isFinite(entry) ? r2(entry) : null,
      exit: status === 'CLOSED' && Number.isFinite(exitPx)
        ? r2(exitPx)
        : (status === 'CLOSED' ? (existing && existing.exit) : null),
      spend: r2(spend),
      right: pos.right || null,
      status,
      exitReason: pos.exitReason || (existing && existing.exitReason) || null,
      buyAt: pos.buyAt || (existing && existing.buyAt) || undefined,
      sellAt: status === 'CLOSED'
        ? (pos.sellAt || (existing && existing.sellAt) || new Date().toISOString())
        : undefined,
      pnl: status === 'CLOSED'
        ? (pnl != null ? pnl : (existing && existing.pnl))
        : null,
    });
  }
  recomputeDay(doc);
  saveDay(doc);
  return doc;
}

function listDays({ limit = 60 } = {}) {
  ensureDirs();
  let names = [];
  try {
    names = fs.readdirSync(DAYS_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch (_) {
    return [];
  }
  names.sort().reverse();
  const cap = Math.min(Math.max(Number(limit) || 60, 1), 365);
  return names.slice(0, cap).map((f) => {
    const day = f.replace(/\.json$/, '');
    const doc = loadDay(day);
    return {
      date: doc.date,
      updatedAt: doc.updatedAt,
      investment: doc.investment,
      realizedPnl: doc.realizedPnl,
      openInvestment: doc.openInvestment,
      tradeCount: (doc.trades || []).length,
      byMode: doc.byMode,
    };
  });
}

function dayDetail(day) {
  const doc = loadDay(day);
  return {
    ...doc,
    logs: readLogs(day, { limit: 1000 }),
  };
}

const PAPER_DIR = path.join(__dirname, '..', 'paper');

/** Seed day ledgers from existing muhurat bot state JSON files. */
function backfillFromPaperStates() {
  let names = [];
  try {
    names = fs.readdirSync(PAPER_DIR);
  } catch (_) {
    return { days: 0 };
  }
  const re = /^(muhurat(?:-paper)?)-(live|options)-(\d{4}-\d{2}-\d{2})\.json$/;
  let days = 0;
  for (const name of names) {
    const m = name.match(re);
    if (!m) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(PAPER_DIR, name), 'utf8'));
      if (!raw || typeof raw !== 'object') continue;
      const mode = m[2] === 'options' ? 'options' : 'equity';
      const day = m[3];
      const state = {
        date: raw.date || day,
        bookMode: mode,
        mode: m[2],
        positions: raw.positions && typeof raw.positions === 'object' ? raw.positions : {},
      };
      if (!state.date) continue;
      syncFromBotState(state);
      // Also copy short in-memory logs into persistent log file if empty.
      if (Array.isArray(raw.log) && raw.log.length) {
        const existing = readLogs(state.date, { limit: 5 });
        if (!existing.length) {
          for (const row of raw.log) {
            if (!row || !row.msg) continue;
            appendLog({
              day: state.date,
              mode,
              msg: row.msg,
              at: row.at || new Date().toISOString(),
            });
          }
        }
      }
      days += 1;
    } catch (_) {
      /* skip bad file */
    }
  }
  return { days };
}

module.exports = {
  ROOT,
  appendLog,
  readLogs,
  loadDay,
  listDays,
  dayDetail,
  recordBuy,
  recordSell,
  syncFromBotState,
  backfillFromPaperStates,
  emptyDay,
};
