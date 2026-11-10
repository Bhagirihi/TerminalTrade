'use strict';

// Pre-flight checkpoints before `npm run muhurat`.
// Hard fails stop the run. Warns print but allow continue.

const { config } = require('./config');
const { UpstoxProvider } = require('./data/upstox');
const {
  DEFAULT_BUDGET,
  SESSION,
  allInstrumentKeys,
  sessionPhase,
  maxTradesPerDay,
} = require('./muhurat');
const { liveEnabled, CONFIRM, portfolioLossGate, noTradeLossPct } = require('./muhurat-bot');
const { summarizePortfolio } = require('./portfolio');
const { istFullStr } = require('./time');

function ok(id, detail) {
  return { id, status: 'pass', detail };
}
function warn(id, detail) {
  return { id, status: 'warn', detail };
}
function fail(id, detail) {
  return { id, status: 'fail', detail };
}

async function checkEnv() {
  const rows = [];
  if (!config.upstox.accessToken) {
    rows.push(fail('UPSTOX_TOKEN', 'UPSTOX_ACCESS_TOKEN missing — run npm run login'));
  } else {
    rows.push(ok('UPSTOX_TOKEN', 'Access token present in .env'));
  }
  const budget = Number(process.env.MUHURAT_BUDGET || DEFAULT_BUDGET);
  if (!(budget > 0)) rows.push(fail('BUDGET', 'MUHURAT_BUDGET must be > 0'));
  else if (budget < 5000) rows.push(warn('BUDGET', `Budget ₹${budget} is small for multi-name plan`));
  else {
    rows.push(ok(
      'BUDGET',
      `MUHURAT_BUDGET = ₹${budget.toLocaleString('en-IN')} + margin · stock max ${maxTradesPerDay('equity') || '∞'}/day · options max ${maxTradesPerDay('options') || '∞'}/day`
    ));
  }
  rows.push(ok('SESSION', `${SESSION.label}`));
  return rows;
}

async function checkUpstox() {
  const rows = [];
  if (!config.upstox.accessToken) return rows;
  const up = new UpstoxProvider(config.upstox.accessToken);
  try {
    const book = await up.getPortfolio();
    const summary = summarizePortfolio(book.holdingRows || [], book.positionRows || []);
    rows.push(ok('UPSTOX_PORTFOLIO', `Holdings ${(book.holdingRows || []).length} · investment ₹${Number(summary.investment || 0).toLocaleString('en-IN')}`));
    const gate = portfolioLossGate({ portfolio: summary });
    const limit = noTradeLossPct();
    if (gate.blocked) {
      rows.push(fail('BOOK_LOSS', gate.reason || `Book loss near −20% — DO NOT TRADE (limit −${limit}%)`));
    } else if (gate.pnlPct != null && gate.pnlPct <= -(limit - 5)) {
      rows.push(warn('BOOK_LOSS', `Book P&L ${gate.pnlPct.toFixed(1)}% — DO NOT TRADE if it reaches −${limit}% (~20% rule)`));
    } else if (gate.pnlPct != null) {
      rows.push(ok('BOOK_LOSS', `Book P&L ${gate.pnlPct.toFixed(1)}% · block new trades at −${limit}% (near 20%)`));
    } else {
      rows.push(ok('BOOK_LOSS', `No book loss % yet · block new trades at −${limit}% (near 20%)`));
    }
  } catch (e) {
    rows.push(fail('UPSTOX_PORTFOLIO', e.message.slice(0, 140)));
  }
  const keys = allInstrumentKeys().slice(0, 5);
  try {
    const map = await up.getLtps(keys);
    const n = [...map.values()].filter((v) => Number.isFinite(v)).length;
    if (n < 3) rows.push(fail('UPSTOX_LTP', `Only ${n}/5 sample LTPs — token or market data issue`));
    else rows.push(ok('UPSTOX_LTP', `LTP ok (${n}/5 sample names)`));
  } catch (e) {
    rows.push(fail('UPSTOX_LTP', e.message.slice(0, 140)));
  }
  try {
    const { istDateKey } = require('./time');
    const to = istDateKey(Date.now());
    const [y, m, d] = to.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - 40);
    const pad = (n) => String(n).padStart(2, '0');
    const from = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
    const candles = await up.getDailyCandles(keys[0], from, to);
    if (!candles || candles.length < 20) rows.push(fail('UPSTOX_CANDLES', 'Not enough daily bars for screening'));
    else rows.push(ok('UPSTOX_CANDLES', `${candles.length} daily bars for screening`));
  } catch (e) {
    rows.push(fail('UPSTOX_CANDLES', e.message.slice(0, 140)));
  }
  return rows;
}

async function checkFeedAuthorize() {
  if (!config.upstox.accessToken) return [];
  try {
    const res = await fetch('https://api.upstox.com/v3/feed/market-data-feed/authorize', {
      headers: { Authorization: `Bearer ${config.upstox.accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(config.requestTimeoutMs || 15000),
    });
    const text = await res.text();
    if (!res.ok) return [warn('UPSTOX_FEED', `Authorize ${res.status}: ${text.slice(0, 100)} — will fall back to LTP poll`)];
    return [ok('UPSTOX_FEED', 'Market feed authorize ok (realtime LTP)')];
  } catch (e) {
    return [warn('UPSTOX_FEED', `${e.message.slice(0, 100)} — will fall back to LTP poll`)];
  }
}

function checkSessionClock() {
  const phase = sessionPhase(Date.now());
  if (phase.phase === 'live') return [ok('CLOCK', `Live window · ${phase.clock} IST · BUY decisions on`)];
  if (phase.phase === 'watching_open') {
    return [ok('CLOCK', `Open watch · ${phase.clock} IST · BUY after ~${SESSION.decide}`)];
  }
  if (phase.phase === 'before_open') {
    return [ok('CLOCK', `Before open · ${phase.clock} IST · watchlist only until ${SESSION.open}`)];
  }
  if (phase.phase === 'exit_only') return [warn('CLOCK', `Past 3:15 · ${phase.clock} IST · exit only`)];
  return [warn('CLOCK', `Outside Muhurat · ${phase.clock} IST · ${phase.message}`)];
}

function checkRulesAck() {
  const rows = [
    ok('TRAIL', 'Trail: @T1→cost · @+0.6%→+0.3% · hard exit 3:15'),
    ok('PICKS', `Live picks = BUY + Watch P>12 · stock max ${maxTradesPerDay('equity') || '∞'}/day · options max ${maxTradesPerDay('options') || '∞'}/day`),
    ok('NO_TRADE_LOSS', `If book loss ≥ −${noTradeLossPct()}% (near 20%) → DO NOT TRADE`),
  ];
  if (liveEnabled()) {
    rows.unshift(ok('LIVE_ORDERS', 'BUY approved this run — real Upstox BUY/SELL armed'));
    rows.push(ok('RULES', 'After open: scan → max-profit buys → watch SL/trail/target → auto sell'));
  } else if (process.env.MUHURAT_LIVE === 'true' && process.env.MUHURAT_LIVE_CONFIRM !== CONFIRM) {
    rows.unshift(fail('LIVE_ORDERS', `MUHURAT_LIVE=true but set MUHURAT_LIVE_CONFIRM=${CONFIRM}`));
  } else if (process.env.MUHURAT_LIVE === 'true') {
    rows.unshift(warn('LIVE_ORDERS', 'Live mode armed in .env — still needs your YES at start before any BUY'));
    rows.push(ok('RULES', 'No orders until you type YES to the live-money warning'));
  } else {
    rows.unshift(warn('LIVE_ORDERS', 'Signals only (.env MUHURAT_LIVE not true)'));
    rows.push(ok('RULES', 'No Upstox auto orders'));
  }
  return rows;
}

async function runMuhuratChecks() {
  const started = Date.now();
  const checks = [];
  checks.push(...(await checkEnv()));
  checks.push(...checkSessionClock());
  checks.push(...checkRulesAck());
  checks.push(...(await checkUpstox()));
  checks.push(...(await checkFeedAuthorize()));
  const failed = checks.filter((c) => c.status === 'fail');
  const warned = checks.filter((c) => c.status === 'warn');
  return {
    ok: failed.length === 0,
    checks,
    failed,
    warned,
    at: istFullStr(started),
    ms: Date.now() - started,
  };
}

function formatChecks(report, opts = {}) {
  const paint = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
  const lines = [];
  lines.push(paint('1', 'Muhurat checkpoints'));
  lines.push(paint('2', `${report.at} · ${report.ms}ms`));
  lines.push('');
  for (const c of report.checks) {
    const tag = c.status === 'pass' ? paint('32', 'PASS') : c.status === 'warn' ? paint('33', 'WARN') : paint('31', 'FAIL');
    lines.push(`${tag}  ${c.id.padEnd(16)}  ${c.detail}`);
  }
  lines.push('');
  if (!report.ok) {
    lines.push(paint('31', `Stopped — ${report.failed.length} checkpoint(s) failed. Fix .env / login, then retry.`));
  } else if (opts.starting === false) {
    if (report.warned.length) lines.push(paint('33', `${report.warned.length} warning(s).`));
    lines.push(paint('32', 'All required checkpoints passed.'));
  } else if (report.warned.length) {
    lines.push(paint('33', `${report.warned.length} warning(s) — continuing.`));
    lines.push(paint('32', 'All required checkpoints passed. Starting Muhurat…'));
  } else {
    lines.push(paint('32', 'All checkpoints passed. Starting Muhurat…'));
  }
  return lines.join('\n');
}

module.exports = { runMuhuratChecks, formatChecks, checkEnv, checkSessionClock };
