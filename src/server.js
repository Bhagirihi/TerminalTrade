'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { config } = require('./config');
const { Engine } = require('./engine');
const { openTerminal } = require('./terminal');
const { openTrade } = require('./trade-view');

const terminalMode = process.argv.includes('--terminal');
const tradeMode = process.argv.includes('--trade');
const attachMode = terminalMode || tradeMode;
const dashboardUrl = `http://localhost:${config.port}`;

function phoneUrl(port) {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      const v4 = net.family === 'IPv4' || net.family === 4;
      if (v4 && !net.internal) return `http://${net.address}:${port}`;
    }
  }
  return null;
}

const onPhone = phoneUrl(config.port);

function loopback(addr) {
  const a = String(addr || '');
  return a === '127.0.0.1' || a === '::1' || a.endsWith('127.0.0.1');
}

function publicBind(host) {
  return host === '0.0.0.0' || host === '::' || host === '';
}

// A LAN client gets prices and signals. The Upstox portfolio stays on this machine.
function viewFor(state, addr) {
  if (!state || loopback(addr)) return state;
  return { ...state, portfolio: null };
}

function dashboardReachable(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(false);
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          resolve(Boolean(body && body.ok === true));
        } catch (_) {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function openView(args) {
  return tradeMode ? openTrade(args) : openTerminal(args);
}

function runClient() {
  let state = { status: 'starting', symbols: {} };
  const dashboard = process.stdout.isTTY ? openView({ url: onPhone || dashboardUrl, getState: () => state }) : null;
  if (!dashboard) {
    console.log(`Dashboard already running: ${dashboardUrl}`);
    return;
  }
  console.log(onPhone ? `Phone, same Wi-Fi: ${onPhone}` : 'Attached to the dashboard already running on this port');

  const connect = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${config.port}`);
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'state') {
          state = msg.state;
          dashboard.draw();
        }
      } catch (_) {
        /* ignore a bad frame */
      }
    });
    ws.on('close', () => {
      state = { ...state, status: 'error', error: 'dashboard disconnected' };
      dashboard.draw();
      setTimeout(connect, 1000);
    });
    ws.on('error', () => {
      /* close follows, and that reconnects */
    });
  };
  connect();
}

function startServer() {
  const app = express();
  app.use(express.static(path.join(__dirname, '..', 'public')));

  let latestState = { status: 'starting', symbols: {} };
  const clients = new Set();
  let dashboard = null;

  const engine = new Engine((state) => {
    latestState = state;
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'state', state: viewFor(state, ws.remoteAddress) }));
    }
    if (dashboard) dashboard.draw();
  });

  app.get('/api/state', (req, res) => res.json(viewFor(latestState, req.socket.remoteAddress)));
  app.get('/api/health', (_req, res) => res.json({ ok: true, source: latestState.source || null, status: latestState.status }));

  const server = app.listen(config.port, config.host, () => {
    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws, req) => {
      ws.remoteAddress = req.socket.remoteAddress;
      clients.add(ws);
      ws.send(JSON.stringify({ type: 'state', state: viewFor(latestState, ws.remoteAddress) }));
      ws.on('close', () => clients.delete(ws));
    });

    if ((terminalMode || tradeMode) && process.stdout.isTTY) {
      dashboard = openView({ url: onPhone || dashboardUrl, getState: () => latestState });
      if (dashboard) dashboard.draw();
    }
    if (!dashboard) {
      console.log(`Dashboard: ${dashboardUrl}`);
      if (publicBind(config.host) && onPhone) console.log(`Phone (same Wi-Fi): ${onPhone}`);
      if (process.env.TERMUX_VERSION) console.log('This phone is running the project. Leave this screen open.');
    }

    engine.start().catch((e) => {
      console.error('[engine] failed to start:', e.message);
      latestState = { status: 'error', error: e.message, symbols: {} };
      if (dashboard) dashboard.draw();
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attachMode) {
      runClient();
      return;
    }
    const hint = err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Stop the other process or set PORT in .env.` : err.message;
    console.error(hint);
    process.exit(1);
  });
}

async function main() {
  if (attachMode && (await dashboardReachable(config.port))) {
    runClient();
    return;
  }
  startServer();
}

main();
