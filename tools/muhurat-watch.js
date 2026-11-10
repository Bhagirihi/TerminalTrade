'use strict';

// Poll Stock or Options muhurat book against live Upstox and append a short status line.
// Usage: node tools/muhurat-watch.js stock|options [intervalSec]
//
// SIGNALS ONLY — never places Upstox orders (improvement / monitor sessions).

// Hard-disable live trading before config/.env can arm the bot.
process.env.MUHURAT_LIVE = 'false';
process.env.MUHURAT_BUY_APPROVED = 'NO';
delete process.env.MUHURAT_LIVE_CONFIRM;

require('../src/config');
// Re-assert after .env load (config only sets missing keys; .env may have LIVE=true).
process.env.MUHURAT_LIVE = 'false';
process.env.MUHURAT_BUY_APPROVED = 'NO';

const fs = require('fs');
const path = require('path');
const { UpstoxProvider } = require('../src/data/upstox');
const { buildMuhuratBook, sessionPhase, maxTradesPerDay } = require('../src/muhurat');
const { buildMuhuratOptionsBook } = require('../src/muhurat-options');
const { istDateKey, istFullStr } = require('../src/time');
const { config } = require('../src/config');
const { liveEnabled } = require('../src/muhurat-bot');

if (liveEnabled()) {
  console.error('Refusing to run: live orders are somehow enabled. Watcher is signals-only.');
  process.exit(1);
}

// Belt-and-suspenders: never call placeOrder from this process.
if (UpstoxProvider.prototype.placeOrder) {
  UpstoxProvider.prototype.placeOrder = async function blockedPlaceOrder() {
    throw new Error('muhurat-watch: order placement blocked (signals-only session)');
  };
}

const modeArg = String(process.argv[2] || 'stock').toLowerCase();
const mode = modeArg === 'options' || modeArg === 'option' ? 'options' : 'equity';
const intervalSec = Math.max(20, Number(process.argv[3]) || 45);
const outDir = process.env.MUHURAT_WATCH_DIR || '/tmp/muhurat-watch';
fs.mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, `${mode === 'options' ? 'options' : 'stock'}.log`);
const latestFile = path.join(outDir, `${mode === 'options' ? 'options' : 'stock'}-latest.json`);

function shiftDate(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function summarize(book) {
  const phase = book.phase || {};
  const buys = (book.liveBuys || [])
    .filter((r) => r && r.verdict === 'BUY' && Number(r.profitScore) > 12)
    .map((r) => `${r.ticker} P${r.profitScore} qty${r.qty || 0}`);
  const watch = (book.extrasWatch || [])
    .filter((r) => Number(r.profitScore) > 12)
    .slice(0, 5)
    .map((r) => `${r.ticker} P${r.profitScore}`);
  return {
    at: istFullStr(Date.now()),
    mode: book.mode || mode,
    phase: phase.phase,
    clock: phase.clock,
    canDecideBuy: phase.canDecideBuy,
    availableMargin: book.availableMargin,
    pickCount: book.budget && book.budget.pickCount,
    used: book.budget && book.budget.used,
    maxTrades: maxTradesPerDay(mode),
    liveBuys: buys,
    watchlist: watch,
    indexes: (book.indexes || []).map((ix) => ({
      id: ix.indexId,
      ltp: ix.indexLtp,
      bias: ix.bias,
      err: ix.error || ix.optionError || null,
    })),
  };
}

async function tick(provider) {
  const to = istDateKey(Date.now());
  const from = shiftDate(to, -120);
  let available = null;
  try {
    const funds = await provider.getFunds();
    available = funds.available;
  } catch (_) {
    available = null;
  }
  const budget = Number(process.env.MUHURAT_BUDGET || 20000);
  const book = mode === 'options'
    ? await buildMuhuratOptionsBook(provider, { fromDate: from, toDate: to, budget, availableMargin: available })
    : await buildMuhuratBook(provider, { fromDate: from, toDate: to, budget, availableMargin: available });
  book.availableMargin = available;
  const summary = summarize(book);
  fs.writeFileSync(latestFile, JSON.stringify(summary, null, 2));
  const line = [
    summary.at,
    summary.phase,
    `buys=[${summary.liveBuys.join(', ') || '—'}]`,
    `watch=[${summary.watchlist.join(', ') || '—'}]`,
    summary.pickCount != null ? `picks=${summary.pickCount}` : '',
    available != null ? `margin=${Math.round(available)}` : '',
  ].filter(Boolean).join(' · ');
  fs.appendFileSync(logFile, `${line}\n`);
  console.log(`[${mode}] ${line}`);
  return summary;
}

async function main() {
  if (!config.upstox.accessToken) {
    console.error('Missing UPSTOX_ACCESS_TOKEN');
    process.exit(1);
  }
  process.env.MUHURAT_SESSION = process.env.MUHURAT_SESSION || 'regular';
  const provider = new UpstoxProvider(config.upstox.accessToken);
  console.log(`[${mode}] SIGNALS ONLY — no orders · watching every ${intervalSec}s → ${logFile}`);
  console.log(`[${mode}] session ${sessionPhase().phase} · max trades ${maxTradesPerDay(mode)} · liveEnabled=${liveEnabled()}`);
  for (;;) {
    try {
      await tick(provider);
    } catch (e) {
      const msg = `${istFullStr(Date.now())} ERROR ${e.message}`;
      fs.appendFileSync(logFile, `${msg}\n`);
      console.error(`[${mode}] ${msg}`);
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
