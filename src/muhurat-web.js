'use strict';

// Lightweight web UI for muhurat2 — same state as the terminal, on a browser/phone.
// Default http://127.0.0.1:3001 (MUHURAT_WEB_PORT / PORT+1).

const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

function phoneUrl(port) {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      const v4 = net.family === 'IPv4' || net.family === 4;
      if (v4 && !net.internal) return `http://${net.address}:${port}`;
    }
  }
  return null;
}

function webPortOf() {
  const n = Number(process.env.MUHURAT_WEB_PORT);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  const base = Number(process.env.PORT) || 3000;
  return base === 3000 ? 3001 : base + 1;
}

function slimRow(r) {
  if (!r) return null;
  return {
    ticker: r.ticker,
    verdict: r.verdict,
    profitScore: r.profitScore,
    ltp: r.ltp,
    rsi: r.rsi,
    qty: r.qty,
    spend: r.spend,
    lots: r.lots,
    lotSize: r.lotSize,
    entry: r.entry,
    buy: r.buy,
    action: r.action,
    sellStop: r.sellStop,
    sellT1: r.sellT1,
    sellT2: r.sellT2,
    orderReady: r.orderReady,
    confirmLeftSec: r.confirmLeftSec,
    live: r.live,
    fromGainer: r.fromGainer,
    dayChangePct: r.dayChangePct,
    indexLtp: r.indexLtp,
    right: r.right,
    levels: r.levels
      ? {
        support: r.levels.support,
        resistance: r.levels.resistance,
        stopLoss: r.levels.stopLoss,
        target1: r.levels.target1,
        target2: r.levels.target2,
        trailLabel: r.levels.trailLabel,
      }
      : null,
  };
}

function slimBook(book) {
  if (!book) return null;
  const phase = book.phase || {};
  return {
    mode: book.mode,
    asOf: book.asOf,
    screened: book.screened,
    phase: {
      phase: phase.phase,
      canDecideBuy: phase.canDecideBuy,
      clock: phase.clock,
      message: phase.message,
    },
    budget: book.budget
      ? {
        budget: book.budget.budget,
        used: book.budget.used,
        left: book.budget.left,
        pickCount: book.budget.pickCount,
        confirmSec: book.budget.confirmSec,
        expectedT1: book.budget.expectedT1,
        confirming: (book.budget.confirming || []).slice(0, 8).map(slimRow),
        unaffordable: book.budget.unaffordable || [],
      }
      : null,
    availableMargin: book.availableMargin,
    lossGate: book.lossGate || null,
    indexes: book.indexes || [],
    liveBuys: (book.liveBuys || []).slice(0, 12).map(slimRow),
    extrasWatch: (book.extrasWatch || []).slice(0, 12).map(slimRow),
    core: (book.core || []).slice(0, 12).map(slimRow),
    prep: (book.prep || []).slice(0, 12).map(slimRow),
    topGainers: (book.topGainers || []).slice(0, 8).map(slimRow),
    extrasSkipHot: (book.extrasSkipHot || []).slice(0, 6).map((r) => ({
      ticker: r.ticker,
      rsi: r.rsi,
    })),
    rules: book.rules || null,
  };
}

function userSignalsOf(book, bot) {
  const buys = [];
  const sells = [];
  const seenB = new Set();
  const seenS = new Set();
  const phase = (book && book.phase) || {};
  const lossGate = (bot && bot.lossGate) || (book && book.lossGate);
  if (!(lossGate && lossGate.blocked) && phase.canDecideBuy !== false) {
    for (const r of (book && book.liveBuys) || []) {
      if (!r || !r.ticker || r.verdict !== 'BUY') continue;
      if (!(Number(r.profitScore) > 12) || !(r.qty > 0) || r.orderReady === false) continue;
      if (seenB.has(r.ticker)) continue;
      seenB.add(r.ticker);
      buys.push(r.ticker);
    }
  }
  const err = String((bot && bot.lastError) || '');
  const m = err.match(/^BUY\s+([A-Z0-9 .&-]+)\s*:/i);
  if (m && m[1] && !seenB.has(m[1].trim())) buys.unshift(m[1].trim());
  const exitOnly = phase.phase === 'exit_only' || phase.phase === 'closed';
  for (const p of (bot && bot.positions) || []) {
    if (!p || !p.ticker || !(p.qty > 0) || seenS.has(p.ticker)) continue;
    const last = Number(p.last);
    const stop = Number(p.stop);
    const t2 = Number(p.t2);
    if (
      exitOnly
      || (Number.isFinite(last) && Number.isFinite(stop) && last <= stop)
      || (Number.isFinite(last) && Number.isFinite(t2) && last >= t2)
    ) {
      seenS.add(p.ticker);
      sells.push(p.ticker);
    }
  }
  return { buys: buys.slice(0, 8), sells: sells.slice(0, 8) };
}

function payloadFromState(state) {
  const mode = (state && state.mode) || 'equity';
  const stockSignals = userSignalsOf(state && state.book, state && state.bot);
  const optSignals = mode === 'both'
    ? userSignalsOf(state && state.optionsBook, state && state.optionsBot)
    : { buys: [], sells: [] };
  return {
    kind: 'muhurat',
    mode,
    updatedAt: state && state.updatedAt,
    feed: state && state.feed,
    error: state && state.error,
    book: slimBook(state && state.book),
    optionsBook: mode === 'both' ? slimBook(state && state.optionsBook) : null,
    bot: state && state.bot,
    optionsBot: state && state.optionsBot,
    userSignals: {
      buys: [...stockSignals.buys, ...optSignals.buys],
      sells: [...stockSignals.sells, ...optSignals.sells],
    },
  };
}

function startMuhuratWeb({ getState } = {}) {
  const port = webPortOf();
  const app = express();
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));
  app.get('/', (_req, res) => res.redirect('/muhurat.html'));
  app.get('/api/muhurat', (_req, res) => {
    res.json(payloadFromState(typeof getState === 'function' ? getState() : null));
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'muhurat' }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  const clients = new Set();

  const broadcast = () => {
    const payload = JSON.stringify({ type: 'muhurat', state: payloadFromState(typeof getState === 'function' ? getState() : null) });
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  };

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'muhurat', state: payloadFromState(typeof getState === 'function' ? getState() : null) }));
    ws.on('close', () => clients.delete(ws));
  });

  let listening = false;
  const ready = new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (!listening) reject(err);
    });
    server.listen(port, '0.0.0.0', () => {
      listening = true;
      resolve({
        port,
        url: `http://127.0.0.1:${port}/muhurat.html`,
        phone: phoneUrl(port) ? `${phoneUrl(port)}/muhurat.html` : null,
        broadcast,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });

  return ready;
}

module.exports = {
  startMuhuratWeb,
  payloadFromState,
  slimBook,
  webPortOf,
};
