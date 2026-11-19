'use strict';

// Lightweight web UI for muhurat2 — same state as the terminal, on a browser/phone.
// Listens on 0.0.0.0 so Oracle/public IP can reach it (open port in cloud firewall).
// Default port 3000 (MUHURAT_WEB_PORT, else PORT, else 3000).

const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const {
  upstoxLinkStatus,
  upstoxCredentials,
  webUpstoxRedirectUri,
  buildUpstoxAuthUrl,
  exchangeUpstoxCode,
  saveTokenToEnv,
} = require('./upstox-auth');
const {
  listDays,
  dayDetail,
  readLogs,
  backfillFromPaperStates,
} = require('./muhurat-history');

function lanHost() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      const v4 = net.family === 'IPv4' || net.family === 4;
      if (v4 && !net.internal) return net.address;
    }
  }
  return null;
}

/** Best URL for users/login redirect: Oracle/public → LAN → localhost. */
function preferredUrl(port = webPortOf()) {
  return pageUrl(publicHostOf(), port)
    || pageUrl(lanHost(), port)
    || pageUrl('127.0.0.1', port);
}

function phoneUrl(port) {
  const host = lanHost();
  return host ? `http://${host}:${port}` : null;
}

function webPortOf() {
  const n = Number(process.env.MUHURAT_WEB_PORT || process.env.PORT || 3000);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return 3000;
}

/** Prefer Oracle/public host so users open the cloud IP, not localhost. */
function publicHostOf() {
  const raw = String(
    process.env.MUHURAT_WEB_HOST
    || process.env.MUHURAT_PUBLIC_HOST
    || process.env.UPSTOX_STATIC_IP_PRIMARY
    || ''
  ).trim();
  if (!raw) return null;
  // Allow host or full URL; strip protocol/path.
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    || null;
}

function pageUrl(host, port) {
  if (!host) return null;
  return `http://${host}:${port}/`;
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
  const upstox = upstoxLinkStatus();
  return {
    kind: 'muhurat',
    mode,
    updatedAt: state && state.updatedAt,
    feed: state && state.feed,
    error: state && state.error,
    upstox,
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

function mountUpstoxAuthRoutes(app, { onUpstoxLinked, broadcast } = {}) {
  const pending = new Map(); // state → { redirectUri, at }

  app.get('/api/auth/upstox', (_req, res) => {
    res.json({ ok: true, ...upstoxLinkStatus(), linkPath: '/auth/upstox' });
  });

  app.get('/auth/upstox', (req, res) => {
    const creds = upstoxCredentials();
    if (!creds.apiKey || !creds.apiSecret) {
      res.status(400).type('html').send(
        '<p>Set UPSTOX_API_KEY and UPSTOX_API_SECRET in .env first.</p><p><a href="/">Back</a></p>'
      );
      return;
    }
    const redirectUri = webUpstoxRedirectUri();
    const state = crypto.randomBytes(16).toString('hex');
    pending.set(state, { redirectUri, at: Date.now() });
    // Drop stale states (>10 min).
    for (const [k, v] of pending) {
      if (Date.now() - v.at > 10 * 60 * 1000) pending.delete(k);
    }
    const url = buildUpstoxAuthUrl({ apiKey: creds.apiKey, redirectUri, state });
    console.log(`Upstox web link started · redirect ${redirectUri}`);
    res.redirect(url);
  });

  app.get('/auth/upstox/callback', async (req, res) => {
    const errParam = req.query.error;
    const code = req.query.code;
    const returnedState = String(req.query.state || '');
    const pendingRow = pending.get(returnedState);
    pending.delete(returnedState);

    if (errParam) {
      res.status(400).type('html').send(
        `<p>Upstox login failed: ${String(errParam)}</p><p><a href="/">Back to Muhurat</a></p>`
      );
      return;
    }
    if (!code) {
      res.status(400).type('html').send('<p>Missing auth code.</p><p><a href="/">Back</a></p>');
      return;
    }
    if (!pendingRow) {
      res.status(400).type('html').send(
        '<p>Login state expired or did not match. <a href="/auth/upstox">Try again</a>.</p>'
      );
      return;
    }

    try {
      const creds = upstoxCredentials();
      const exchanged = await exchangeUpstoxCode({
        code: String(code),
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        redirectUri: pendingRow.redirectUri,
      });
      saveTokenToEnv(exchanged.token, creds.envPath);
      if (typeof onUpstoxLinked === 'function') {
        try { onUpstoxLinked(exchanged); } catch (e) {
          console.error(`onUpstoxLinked: ${e.message}`);
        }
      }
      if (typeof broadcast === 'function') broadcast();
      console.log(`Upstox linked via web as ${exchanged.userName}`);
      res
        .status(200)
        .type('html')
        .send(
          `<!doctype html><meta charset="utf-8" />
           <title>Upstox linked</title>
           <p>Linked as <b>${exchanged.userName}</b>. Token saved.</p>
           <p><a href="/?linked=1">Open Muhurat</a></p>
           <script>location.replace('/?linked=1');</script>`
        );
    } catch (e) {
      console.error(`Upstox web callback: ${e.message}`);
      res.status(502).type('html').send(
        `<p>${e.message}</p>
         <p>Register this redirect on the Upstox app: <code>${pendingRow.redirectUri}</code></p>
         <p><a href="/auth/upstox">Retry</a> · <a href="/">Back</a></p>`
      );
    }
  });
}

/** Mount /muhuratlogs + history APIs on any Express app (Muhurat UI or main dashboard). */
function mountMuhuratHistoryRoutes(app, { publicDir } = {}) {
  try {
    backfillFromPaperStates();
  } catch (_) {
    /* best-effort seed from existing bot state files */
  }
  // Prefer /muhuratlogs/ (static folder) so Supertrend on :3000 can serve it too.
  app.get('/muhuratlogs', (_req, res) => res.redirect(302, '/muhuratlogs/'));
  app.get('/muhurat-logs.html', (_req, res) => res.redirect(302, '/muhuratlogs/'));
  app.get('/api/muhurat/days', (req, res) => {
    const limit = Number(req.query.limit) || 60;
    res.json({ ok: true, days: listDays({ limit }) });
  });
  app.get('/api/muhurat/days/:day', (req, res) => {
    const day = String(req.params.day || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      res.status(400).json({ ok: false, error: 'day must be YYYY-MM-DD' });
      return;
    }
    res.json({ ok: true, day: dayDetail(day) });
  });
  app.get('/api/muhurat/logs', (req, res) => {
    const day = String(req.query.day || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      res.status(400).json({ ok: false, error: 'day query required (YYYY-MM-DD)' });
      return;
    }
    const limit = Number(req.query.limit) || 500;
    const mode = req.query.mode || null;
    res.json({ ok: true, day, logs: readLogs(day, { limit, mode }) });
  });
}

function candidateWebPorts() {
  const preferred = webPortOf();
  const extras = String(process.env.MUHURAT_WEB_FALLBACK_PORTS || '3001,3010,3020')
    .split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set([preferred, ...extras])];
}

function listenOnPort(server, port) {
  return new Promise((resolve, reject) => {
    const onErr = (err) => {
      server.removeListener('listening', onListen);
      try { server.close(); } catch (_) { /* ignore */ }
      reject(err);
    };
    const onListen = () => {
      server.removeListener('error', onErr);
      resolve(port);
    };
    server.once('error', onErr);
    server.once('listening', onListen);
    server.listen(port, '0.0.0.0');
  });
}

async function startMuhuratWeb({ getState, onUpstoxLinked } = {}) {
  const app = express();
  const publicDir = path.join(__dirname, '..', 'public');
  const muhuratPage = path.join(publicDir, 'muhurat.html');
  // Root = Muhurat UI (not public/index.html Supertrend page).
  app.get('/', (_req, res) => res.sendFile(muhuratPage));
  app.get('/muhurat.html', (_req, res) => res.redirect(301, '/'));
  mountMuhuratHistoryRoutes(app, { publicDir });
  app.use(express.static(publicDir, { index: false }));
  app.get('/api/muhurat', (_req, res) => {
    res.json(payloadFromState(typeof getState === 'function' ? getState() : null));
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'muhurat' }));

  // broadcast assigned after wss setup; auth routes close over the holder.
  const hub = { broadcast: () => {} };
  mountUpstoxAuthRoutes(app, {
    onUpstoxLinked,
    broadcast: () => hub.broadcast(),
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  const clients = new Set();

  const broadcast = () => {
    const payload = JSON.stringify({ type: 'muhurat', state: payloadFromState(typeof getState === 'function' ? getState() : null) });
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  };
  hub.broadcast = broadcast;

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'muhurat', state: payloadFromState(typeof getState === 'function' ? getState() : null) }));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });
  // Prevent crash: ws re-emits HTTP server listen errors as unhandled 'error' on WSS.
  wss.on('error', () => {});

  const ports = candidateWebPorts();
  let port = null;
  let lastErr = null;
  for (const candidate of ports) {
    try {
      port = await listenOnPort(server, candidate);
      break;
    } catch (err) {
      lastErr = err;
      if (!(err && err.code === 'EADDRINUSE')) {
        throw err;
      }
    }
  }
  if (port == null) {
    const tried = ports.join(', ');
    throw new Error(
      lastErr && lastErr.code === 'EADDRINUSE'
        ? `Ports in use (${tried}) — stop the other process or set MUHURAT_WEB_PORT`
        : (lastErr && lastErr.message) || 'Muhurat web failed to bind'
    );
  }
  server.on('error', (err) => {
    console.error(`Muhurat web server: ${err.message}`);
  });
  const publicHost = publicHostOf();
  const lan = lanHost();
  const publicUrl = pageUrl(publicHost, port);
  const lanUrl = pageUrl(lan, port);
  const localUrl = pageUrl('127.0.0.1', port);
  return {
    port,
    // Prefer Oracle/public IP so remote users can open the UI.
    url: publicUrl || lanUrl || localUrl,
    publicUrl,
    lanUrl,
    localUrl,
    phone: lanUrl,
    host: publicHost || lan || '127.0.0.1',
    broadcast,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

module.exports = {
  startMuhuratWeb,
  mountMuhuratHistoryRoutes,
  payloadFromState,
  slimBook,
  webPortOf,
  publicHostOf,
  pageUrl,
  lanHost,
  preferredUrl,
};
