'use strict';

// Muhurat terminal + optional full auto Upstox trader.
// Live orders only when MUHURAT_LIVE=true and MUHURAT_LIVE_CONFIRM=I_ACCEPT_REAL_ORDERS.

const { config } = require('../src/config');
const { UpstoxProvider } = require('../src/data/upstox');
const { istDateKey, istFullStr } = require('../src/time');
const { buildMuhuratBook, SESSION, patchBookLtps, allInstrumentKeys, maxTradesPerDay } = require('../src/muhurat');
const { buildMuhuratOptionsBook } = require('../src/muhurat-options');
const { runMuhuratChecks, formatChecks } = require('../src/muhurat-checks');
const { createMuhuratBot, portfolioLossGate } = require('../src/muhurat-bot');
const { collectUserSignals, formatSignal } = require('../src/muhurat-signals');
const { askBuyApproval } = require('../src/muhurat-approve');
const { openTerminal } = require('../src/terminal');
const { UpstoxFeed } = require('../src/data/upstox-feed');
const { summarizePortfolio, summarizeLive } = require('../src/portfolio');
const { demoChecks, buildDemoState } = require('../src/muhurat-demo');
const { startMuhuratWeb, publishLiveSnapshot } = require('../src/muhurat-web');
const {
  isUpstoxAuthError,
  muhuratWebRootUrl,
  runInteractiveUpstoxLogin,
} = require('../src/upstox-auth');
const { runMuhuratExit, isDryArg } = require('./muhurat-exit');

function isBothArg() {
  // Supports: --both / --all / Both, plus MUHURAT_MODE=both (muhurat2 default).
  if (
    process.env.npm_config_both === 'true' ||
    process.env.npm_config_all === 'true' ||
    process.env.MUHURAT_MODE === 'both' ||
    process.env.MUHURAT_MODE === 'all'
  ) {
    return true;
  }
  return process.argv.some((a) => {
    const s = String(a);
    return (
      s === '--both' ||
      s === '--Both' ||
      s === '--all' ||
      s === '--All' ||
      s === 'both' ||
      s === 'Both' ||
      s === 'all' ||
      s === 'All' ||
      /^--?(both|all)$/i.test(s)
    );
  });
}

function isStocksOnlyArg() {
  // Force equity-only when combined default is on: --stocks / --equity.
  if (
    process.env.npm_config_stocks === 'true' ||
    process.env.npm_config_equity === 'true' ||
    process.env.MUHURAT_MODE === 'equity' ||
    process.env.MUHURAT_MODE === 'stocks'
  ) {
    return true;
  }
  return process.argv.some((a) => {
    const s = String(a);
    return (
      s === '--stocks' ||
      s === '--Stocks' ||
      s === '--equity' ||
      s === '--Equity' ||
      s === 'stocks' ||
      s === 'equity' ||
      /^--?(stocks|equity)$/i.test(s)
    );
  });
}

function isOptionsArg() {
  // Supports: --Options / --options / --option / Options, plus `npm run muhrat2 -- --option`.
  if (
    process.env.npm_config_options === 'true' ||
    process.env.npm_config_Options === 'true' ||
    process.env.npm_config_option === 'true' ||
    process.env.MUHURAT_MODE === 'options'
  ) {
    return true;
  }
  return process.argv.some((a) => {
    const s = String(a);
    return (
      s === '--Options' ||
      s === '--options' ||
      s === '--option' ||
      s === 'Options' ||
      s === 'options' ||
      s === 'option' ||
      /^--?Options?$/i.test(s)
    );
  });
}

/** Resolve run mode: both | options | equity. --Options / --stocks win over --both. */
function resolveRunMode(opts = {}) {
  if (opts.mode === 'both' || opts.mode === 'options' || opts.mode === 'equity') return opts.mode;
  if (isOptionsArg()) return 'options';
  if (isStocksOnlyArg()) return 'equity';
  if (isBothArg()) return 'both';
  return 'equity';
}

function portfolioKeysOf(rows) {
  const keys = [];
  for (const row of rows || []) {
    const k = row && row.instrument_token != null ? String(row.instrument_token) : '';
    if (k) keys.push(k);
  }
  return keys;
}

// Reprice book.portfolio from live LTPs so Invest/Value/Loss moves between REST polls.
function repriceBookPortfolio(book, ltpByKey) {
  if (!book || !book.portfolioRows) return book;
  const holdings = book.portfolioRows.holdings || [];
  const positions = book.portfolioRows.positions || [];
  const live = summarizeLive(holdings, positions, (row) => {
    const key = row && row.instrument_token != null ? String(row.instrument_token) : '';
    if (!key || !ltpByKey) return null;
    const n = Number(ltpByKey.get(key));
    return Number.isFinite(n) ? n : null;
  });
  book.portfolio = live;
  book.lossGate = portfolioLossGate(book);
  if (book.lossGate.blocked) {
    book.liveBuys = [];
    book.extrasBuy = [];
  }
  return book;
}

function isTokenCheckpointFail(report) {
  if (!report || !report.failed) return false;
  return report.failed.some((c) => {
    if (!c) return false;
    if (c.id === 'UPSTOX_TOKEN') return true;
    if (['UPSTOX_PORTFOLIO', 'UPSTOX_LTP', 'UPSTOX_CANDLES', 'UPSTOX_FEED'].includes(c.id)) {
      return isUpstoxAuthError(c.detail);
    }
    return false;
  });
}

async function runCheckpoints({ skip = false, autoLogin = true, successUrl } = {}) {
  if (skip) {
    console.log('Muhurat checkpoints skipped (--skip-checks).');
    return true;
  }
  const afterLoginUrl = successUrl || muhuratWebRootUrl();
  let report = await runMuhuratChecks();
  console.log(formatChecks(report));
  console.log('');

  if (!report.ok && autoLogin && isTokenCheckpointFail(report)) {
    console.log(amber(bold('Upstox token missing/expired — opening login (same as npm run login)…')));
    console.log(dim(`After login → ${afterLoginUrl}`));
    try {
      const result = await runInteractiveUpstoxLogin({ successUrl: afterLoginUrl });
      console.log(green(bold(`Logged in as ${result.userName}. Token saved.`)));
      console.log('');
      report = await runMuhuratChecks();
      console.log(formatChecks(report));
      console.log('');
    } catch (e) {
      console.error(red(e.message || e));
      process.exitCode = 1;
      return false;
    }
  }

  if (!report.ok) {
    process.exitCode = 1;
    return false;
  }
  return true;
}

function shiftDate(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

const paint = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
const dim = (t) => paint('2', t);
const bold = (t) => paint('1', t);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const amber = (t) => paint('33', t);

function visLen(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
}

function clip(s, n) {
  if (n <= 0) return '';
  let vis = 0;
  let out = '';
  let i = 0;
  const str = String(s);
  while (i < str.length && vis < n) {
    if (str[i] === '\x1b') {
      const m = str.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += str[i];
    vis += 1;
    i += 1;
  }
  if (visLen(str) > n && out.includes('\x1b[')) out += '\x1b[0m';
  return out;
}

function pad(s, n) {
  const c = clip(s, n);
  const gap = n - visLen(c);
  return gap > 0 ? c + ' '.repeat(gap) : c;
}

function fmt(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${Math.abs(n).toFixed(2)}%`;
}

function tonePct(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const t = pct(n);
  return n >= 0 ? green(t) : red(t);
}

function verdictPaint(v) {
  if (v === 'BUY') return green(bold('BUY'));
  if (v === 'PREP') return amber('PREP');
  if (v === 'WATCH') return amber('WATCH');
  if (v === 'TOO HOT') return red('TOO HOT');
  if (v === 'NO NEW BUY') return dim('NO NEW');
  if (v === 'ERROR') return red('ERROR');
  return dim(v || '—');
}

function borderOf(verdict) {
  if (verdict === 'BUY') return green;
  if (verdict === 'PREP' || verdict === 'WATCH') return amber;
  if (verdict === 'TOO HOT' || verdict === 'ERROR') return red;
  return dim;
}

function cardRow(left, right, inner, border) {
  const gap = inner - visLen(left) - visLen(right || '');
  const body = gap > 0 ? left + ' '.repeat(gap) + (right || '') : left;
  const padRight = Math.max(0, inner - visLen(body));
  return border('│') + body + ' '.repeat(padRight) + border('│');
}

function stockBox(row, inner) {
  const border = borderOf(row.verdict);
  const lines = [border('┌' + '─'.repeat(inner) + '┐')];
  if (row.error) {
    lines.push(cardRow(` ${bold(row.ticker)}`, '', inner, border));
    lines.push(cardRow(` ${red(clip(row.error, Math.max(4, inner - 2)))}`, '', inner, border));
    lines.push(border('└' + '─'.repeat(inner) + '┘'));
    return lines;
  }
  const lv = row.levels || {};
  const lotBit = row.lots > 0 ? ` ${row.lots}L` : '';
  const qtyBit = row.qty > 0 ? ` qty ${row.qty}${lotBit} ₹${fmt(row.spend)}` : '';
  const liveBit = row.live ? green(' LIVE') : '';
  const waitBit = row.confirmLeftSec != null ? amber(` ${row.confirmLeftSec}s`) : '';
  const pScore = row.profitScore != null ? bold(`P${fmt(row.profitScore)}`) : dim(`${row.score || '—'}`);
  const gainerBit = row.fromGainer ? amber(' ▲') : '';
  lines.push(cardRow(` ${bold(row.ticker)} ${verdictPaint(row.verdict)}${gainerBit}${liveBit}${waitBit}`, pScore, inner, border));
  lines.push(cardRow(clip(
    ` LTP ${fmt(row.ltp)}  RSI ${fmt(row.rsi)}${row.dayChangePct != null ? `  day ${tonePct(row.dayChangePct)}` : ''}${qtyBit}`,
    inner
  ), '', inner, border));
  lines.push(cardRow(clip(
    ` SL ${red(fmt(row.sellStop || lv.stopLoss))}  T1 ${green(fmt(row.sellT1 || lv.target1))}  T2 ${green(fmt(row.sellT2 || lv.target2))}  ${bold(row.action || 'WAIT')}`,
    inner
  ), '', inner, border));
  lines.push(border('└' + '─'.repeat(inner) + '┘'));
  return lines;
}

function columnCount(width, n) {
  if (n <= 1) return 1;
  // Wide enough that Sup/Res/SL/T1/T2 stay readable; still packs 3–4 on large terminals.
  const minCol = 38;
  const gap = 1;
  const fit = Math.floor((width + gap) / (minCol + gap));
  return Math.max(1, Math.min(n, fit, 5));
}

function drawSlice(rows, width, gridCols) {
  const gap = 1;
  const cols = Math.max(1, gridCols || rows.length);
  const col = Math.floor((width - gap * (cols - 1)) / cols);
  const inner = Math.max(18, col - 2);
  const drawn = rows.map((row) => stockBox(row, inner));
  const maxH = Math.max(...drawn.map((card) => card.length));
  const cardW = inner + 2;
  const out = [];
  for (let line = 0; line < maxH; line++) {
    const parts = [];
    for (let i = 0; i < cols; i++) {
      if (i) parts.push(' '.repeat(gap));
      if (i < drawn.length) parts.push(drawn[i][line] || ' '.repeat(cardW));
      else parts.push(' '.repeat(cardW));
    }
    out.push(pad(parts.join(''), width));
  }
  return out;
}

function placeBoxes(rows, width) {
  if (!rows.length) return [dim('None right now.')];
  const cols = columnCount(width, rows.length);
  const out = [];
  for (let i = 0; i < rows.length; i += cols) {
    out.push(...drawSlice(rows.slice(i, i + cols), width, cols));
  }
  return out;
}

function section(title, rows, width) {
  return [bold(title), ...placeBoxes(rows, width)];
}

/** Manual cues when auto orders fail (static IP / 403) or for watch-only. */
function userSignalLines(book, bot, phase, width) {
  const lines = [];
  const sig = collectUserSignals(book, bot);
  const buys = (sig && sig.buys) || [];
  const sells = (sig && sig.sells) || [];
  if (!buys.length && !sells.length) return lines;
  lines.push(clip(bold('── USER SIGNALS ──') + dim('  place in Upstox app if auto blocked'), width));
  for (const s of buys) {
    lines.push(clip(green(bold(`  BUY(USER)  ==>  ${formatSignal(s)}`)), width));
  }
  for (const s of sells) {
    lines.push(clip(red(bold(`  SELL(USER) ==>  ${formatSignal(s)}`)), width));
  }
  lines.push('');
  return lines;
}

function renderBookPanel(state, opts = {}) {
  const width = opts.width || 100;
  const book = (state && state.book) || {};
  const lines = [];
  const phase = book.phase || {};
  const optionsMode = book.mode === 'options' || (state && state.mode === 'options');
  const title = opts.panelTitle
    || (optionsMode ? 'Muhurat Options' : 'Muhurat');
  lines.push(clip(
    bold(title) +
      '  ' + dim(optionsMode ? 'NIFTY + BANKNIFTY ATM CE/PE · ' + SESSION.label : SESSION.label) +
      '  ' + dim(`${book.asOf || '—'} · ${book.screened || 0} names · ${state && state.updatedAt ? state.updatedAt : ''}`),
    width
  ));
  if (state && state.error && !opts.hideSharedError) lines.push(clip(red(state.error), width));
  const feedLabel = state && state.feed === 'live' ? green('FEED LIVE') : state && state.feed === 'poll' ? amber('FEED POLL') : dim('FEED —');
  if (!opts.hideFeedPhase) {
    lines.push(clip(
      (phase.canDecideBuy ? green : amber)(
        phase.message || 'No BUY decision until market open review'
      ) + dim(phase.clock ? ` · now ${phase.clock}` : '') + '  ' + feedLabel,
      width
    ));
  }
  // USER SIGNALS near the top so they are hard to miss.
  lines.push(...userSignalLines(book, state && state.bot, phase, width));
  if (optionsMode && (book.indexes || []).length) {
    const bits = (book.indexes || []).map((ix) => {
      if (!ix || ix.error) return `${ix && ix.indexId ? ix.indexId : '?'} err`;
      return `${ix.indexId} ${fmt(ix.indexLtp)} ${ix.bias || '—'}`;
    });
    lines.push(clip(dim(`Index  ${bits.join(' · ')}`), width));
  }
  const openPos = (state && state.bot && state.bot.positions) || [];
  if (openPos.length) {
    let invest = 0;
    let value = 0;
    for (const p of openPos) {
      const qty = Number(p.qty) || 0;
      if (!(qty > 0)) continue;
      const entry = Number(p.entry);
      const last = Number.isFinite(Number(p.last)) ? Number(p.last) : entry;
      const spend = Number(p.spend);
      invest += Number.isFinite(spend) && spend > 0 ? spend : (Number.isFinite(entry) ? entry * qty : 0);
      value += Number.isFinite(last) ? last * qty : (Number.isFinite(entry) ? entry * qty : 0);
    }
    const pnl = value - invest;
    lines.push(clip(
      bold('Open') +
        dim(` ₹${fmt(invest)}→${fmt(value)}`) +
        ' · ' + green(`+₹${fmt(pnl > 0 ? pnl : 0)}`) +
        ' · ' + red(`−₹${fmt(pnl < 0 ? Math.abs(pnl) : 0)}`),
      width
    ));
  }
  const bud = book.budget;
  const avail = book.availableMargin != null ? book.availableMargin : (bud && bud.availableMargin);
  const tradeMode = optionsMode ? 'options' : 'equity';
  const tradeCap = (book.rules && book.rules.maxTrades) != null
    ? book.rules.maxTrades
    : maxTradesPerDay(tradeMode);
  const botTrades = state && state.bot && state.bot.tradesToday != null ? state.bot.tradesToday : null;
  const confirmNeed = (book.budget && book.budget.confirmSec) != null
    ? book.budget.confirmSec
    : (book.rules && book.rules.confirmSec);
  const statusBits = [];
  if (avail != null && Number.isFinite(Number(avail))) statusBits.push(green(`margin ₹${fmt(avail)}`));
  if (bud) statusBits.push(dim(`budget ₹${fmt(bud.budget)}${bud.pickCount ? ` · ${bud.pickCount} picks` : ''}`));
  if (tradeCap > 0) statusBits.push(dim(`max ${tradeCap}/day${botTrades != null ? ` · ${botTrades} used` : ''}`));
  if (confirmNeed > 0) statusBits.push(dim(`confirm ${confirmNeed}s`));
  if (statusBits.length) lines.push(clip(statusBits.join(dim(' · ')), width));
  const lossGate = (state && state.bot && state.bot.lossGate) || (book && book.lossGate);
  if (lossGate && lossGate.blocked) {
    lines.push(clip(red(bold('DO NOT TRADE')) + red(` · book loss ${lossGate.pnlPct}%`), width));
  }
  if (state && state.bot && (state.bot.live || state.bot.paper)) {
    const modeLabel = state.bot.paper
      ? amber(bold('AUTO PAPER'))
      : red(bold('AUTO LIVE'));
    lines.push(clip(modeLabel + dim(` · ${state.bot.product || 'I'} · spend ₹${fmt(state.bot.spend)} · open ${state.bot.openCount || 0}`), width));
    if (state.bot.lastError) lines.push(clip(red(state.bot.lastError), width));
    for (const p of state.bot.positions || []) {
      lines.push(clip(
        green(`IN ${p.ticker} ×${p.qty} @${fmt(p.entry)} SL ${fmt(p.stop)} last ${fmt(p.last)}`),
        width
      ));
    }
    for (const row of (state.bot.log || []).slice(-2)) {
      lines.push(clip(dim(row.msg), width));
    }
  } else if (!opts.hideAutoOff) {
    lines.push(clip(dim('Auto off — signals only · exit 3:15'), width));
  }

  const byPDesc = (a, b) => (Number(b.profitScore) || -99) - (Number(a.profitScore) || -99);
  const gainerTickerSet = new Set(
    (book.topGainers || []).filter((r) => r && r.ticker).map((r) => r.ticker)
  );
  const markGainer = (r) => {
    if (!r) return r;
    if (r.fromGainer || gainerTickerSet.has(r.ticker)) return { ...r, fromGainer: true };
    return r;
  };

  // Live BUY: only BUY cards with P > 12 — never label as Watch. Highest P first.
  const liveBuys = (book.liveBuys || book.extrasBuy || [])
    .filter((r) => r && r.verdict === 'BUY' && Number(r.profitScore) > 12)
    .map((r) => {
      let next = markGainer(r);
      if (next.fromWatch) {
        const { fromWatch, ...rest } = next;
        next = { ...rest, verdict: 'BUY', buy: 'YES', action: 'BUY' };
      }
      return next;
    })
    .sort(byPDesc);

  const pAbove12 = (r) => r && Number(r.profitScore) > 12;

  // Watchlist during live: WATCH names with P > 12, not already in Live BUY.
  const liveTickers = new Set(liveBuys.map((r) => r.ticker));
  const watchlistLive = (book.extrasWatch || [])
    .filter((r) => pAbove12(r) && !liveTickers.has(r.ticker))
    .map(markGainer)
    .sort(byPDesc);

  const prep = (book.prep || []).filter(pAbove12).map(markGainer).sort(byPDesc);
  const core = (book.core || []).filter(pAbove12).map(markGainer).sort(byPDesc);

  if (phase.canDecideBuy) {
    if (lossGate && lossGate.blocked) {
      lines.push(bold('Live BUY — blocked'));
      lines.push(clip(red('DO NOT TRADE — book loss near 20%. No new buys.'), width));
    } else {
      lines.push(bold('Live BUY'));
      lines.push(...placeBoxes(liveBuys, width));
    }
    if (watchlistLive.length) {
      lines.push(bold('Watch'));
      lines.push(...placeBoxes(watchlistLive, width));
    }
    const confirming = (book.budget && book.budget.confirming) || [];
    if (confirming.length) {
      lines.push(bold('Confirming'));
      lines.push(...placeBoxes(
        confirming.map((r) => ({
          ...r,
          verdict: 'WATCH',
          buy: 'WAIT',
          action: `WAIT ${r.confirmLeftSec != null ? r.confirmLeftSec + 's' : ''}`.trim(),
        })),
        width
      ));
    }
  } else {
    const watchBefore = (core.length ? core : prep).slice().sort(byPDesc);
    lines.push(bold('Watch — no BUY call yet'));
    lines.push(...placeBoxes(watchBefore, width));
    if (prep.length && core.length) {
      const prepExtra = prep
        .filter((p) => !core.some((c) => c.ticker === p.ticker))
        .sort(byPDesc)
        .slice(0, 6);
      if (prepExtra.length) {
        lines.push(bold('Other PREP'));
        lines.push(...placeBoxes(prepExtra, width));
      }
    }
  }
  if ((book.extrasSkipHot || []).length) {
    const hot = (book.extrasSkipHot || []).map((r) => `${r.ticker} ${fmt(r.rsi)}`).join(' · ');
    lines.push(clip(red(`Too hot  ${hot}`), width));
  }
  if ((book.budget && book.budget.unaffordable || []).length) {
    const bits = book.budget.unaffordable
      .map((r) => `${r.ticker} needs ₹${fmt(r.need)}`)
      .join(' · ');
    lines.push(clip(amber(`Budget too small for 1 lot: ${bits}`), width));
  }

  // Top Gainers (equity mode only): P > 12, skip anything already in Live BUY / Watchlist.
  if (!optionsMode) {
    const shownTickers = new Set([
      ...liveTickers,
      ...watchlistLive.map((r) => r.ticker),
      ...(!phase.canDecideBuy ? [...core, ...prep].map((r) => r.ticker) : []),
    ]);
    const gainers = (book.topGainers || [])
      .filter((r) => pAbove12(r) && !shownTickers.has(r.ticker))
      .map((r) => ({ ...r, fromGainer: true }))
      .sort(byPDesc)
      .slice(0, 8);
    if (gainers.length) {
      lines.push(bold('Top Gainers'));
      lines.push(...placeBoxes(gainers, width));
    } else if (book.gainerError) {
      lines.push(clip(amber(`Top Gainers · ${book.gainerError}`), width));
    }
  }

  if (!opts.hideFooter) {
    lines.push(clip(dim('BUY after 9:25 · confirm ~3m · exit 3:15 · q quit'), width));
  }
  if (opts.log) lines.push(clip(dim(opts.log), width));
  return lines;
}

function render(state, opts = {}) {
  const width = opts.width || 100;
  const height = opts.height || 40;
  const fill = opts.fill !== false;
  const both = (state && state.mode === 'both') || (opts.mode === 'both');

  let lines;
  if (both) {
    const sharedError = state && state.error ? [clip(red(state.error), width)] : [];
    const feedLabel = state && state.feed === 'live' ? green('FEED LIVE') : state && state.feed === 'poll' ? amber('FEED POLL') : dim('FEED —');
    const header = [
      clip(
        bold('Muhurat2') + dim('  stocks + options  ') + feedLabel +
          dim(state && state.updatedAt ? ` · ${state.updatedAt}` : '') +
          dim(opts.url ? ` · web ${opts.url}` : ''),
        width
      ),
      ...sharedError,
    ];
    const stockLines = renderBookPanel(
      { ...state, mode: 'equity', book: state.book || {}, bot: state.bot, error: '' },
      { width, panelTitle: '▸ Stocks', hideSharedError: true, hideFeedPhase: false, hideFooter: true, hideAutoOff: true }
    );
    const optLines = renderBookPanel(
      { ...state, mode: 'options', book: state.optionsBook || {}, bot: state.optionsBot, error: '' },
      { width, panelTitle: '▸ Options', hideSharedError: true, hideFeedPhase: true, hideFooter: true, hideAutoOff: true }
    );
    lines = [
      ...header,
      ...stockLines,
      clip(dim('─'.repeat(Math.min(width, 52))), width),
      ...optLines,
      clip(dim(`BUY after 9:25 · confirm ~3m · exit 3:15 · web ${opts.url || 'UI'} · q quit`), width),
    ];
  } else {
    lines = renderBookPanel(state, { width, log: opts.log });
  }

  if (fill) while (lines.length < height) lines.push('');
  return lines.slice(0, fill ? height : lines.length).map((l) => pad(clip(l, width), width)).join('\n');
}

async function resolveLiveBudget(provider, { budget, money } = {}) {
  let funds = money && money.funds != null ? money.funds : null;
  let available = money && money.available != null ? money.available : null;
  if (!money) {
    try {
      if (provider && typeof provider.getFunds === 'function') funds = await provider.getFunds();
    } catch (_) {
      funds = null;
    }
    available = funds && Number.isFinite(Number(funds.available)) ? Number(funds.available) : null;
  }
  const configured = Number(
    budget != null ? budget
      : process.env.MUHURAT_BUDGET || 20000
  );
  return {
    funds,
    budget: configured > 0 ? configured : 20000,
    available,
  };
}

async function attachPortfolioToBook(provider, book, portfolioCache) {
  if (portfolioCache) {
    book.portfolioRows = portfolioCache.portfolioRows;
    book.portfolio = portfolioCache.portfolio;
  } else {
    try {
      const raw = await provider.getPortfolio();
      const holdings = raw.holdingRows || [];
      const positions = raw.positionRows || [];
      book.portfolioRows = { holdings, positions };
      book.portfolio = summarizePortfolio(holdings, positions);
    } catch (e) {
      book.portfolioRows = { holdings: [], positions: [] };
      book.portfolio = { investment: 0, pnl: 0, error: e.message };
    }
  }
  book.lossGate = portfolioLossGate(book);
  if (book.lossGate.blocked) {
    book.liveBuys = [];
    book.extrasBuy = [];
    if (book.budget) {
      book.budget.picks = [];
      book.budget.pickCount = 0;
      book.budget.used = 0;
      book.budget.left = book.budget.budget;
      book.budget.expectedT1 = 0;
    }
  }
  return book;
}

async function fetchBook(provider, {
  mode = 'equity',
  stickyTickers = [],
  budget,
  money,
  portfolioCache,
  skipPortfolio = false,
} = {}) {
  const to = istDateKey(Date.now());
  const from = shiftDate(to, -120);
  const resolved = await resolveLiveBudget(provider, { budget, money });
  const book = mode === 'options'
    ? await buildMuhuratOptionsBook(provider, {
      fromDate: from,
      toDate: to,
      budget: resolved.budget,
      availableMargin: resolved.available,
      stickyTickers,
    })
    : await buildMuhuratBook(provider, {
      fromDate: from,
      toDate: to,
      budget: resolved.budget,
      availableMargin: resolved.available,
      stickyTickers,
    });
  book.funds = resolved.funds;
  book.availableMargin = resolved.available;
  if (!skipPortfolio) await attachPortfolioToBook(provider, book, portfolioCache);
  else {
    book.portfolioRows = { holdings: [], positions: [] };
    book.portfolio = { investment: 0, pnl: 0 };
    book.lossGate = { blocked: false };
  }
  return book;
}

async function loadPortfolioCache(provider) {
  try {
    const raw = await provider.getPortfolio();
    const holdings = raw.holdingRows || [];
    const positions = raw.positionRows || [];
    return {
      portfolioRows: { holdings, positions },
      portfolio: summarizePortfolio(holdings, positions),
    };
  } catch (e) {
    return {
      portfolioRows: { holdings: [], positions: [] },
      portfolio: { investment: 0, pnl: 0, error: e.message },
    };
  }
}

async function once(opts = {}) {
  const mode = resolveRunMode(opts);
  const ready = await runCheckpoints(opts);
  if (!ready) return;
  const provider = new UpstoxProvider(config.upstox.accessToken);
  if (mode === 'both') {
    const money = await resolveLiveBudget(provider);
    const portfolioCache = await loadPortfolioCache(provider);
    const stockBudget = Number(process.env.MUHURAT_BUDGET_STOCK || process.env.MUHURAT_BUDGET || money.budget);
    const optionsBudget = Number(process.env.MUHURAT_BUDGET_OPTIONS || process.env.MUHURAT_BUDGET || money.budget);
    const book = await fetchBook(provider, {
      mode: 'equity',
      budget: stockBudget,
      money,
      portfolioCache,
    });
    const optionsBook = await fetchBook(provider, {
      mode: 'options',
      budget: optionsBudget,
      money,
      portfolioCache,
    });
    const text = render(
      { book, optionsBook, mode: 'both', updatedAt: istFullStr(Date.now()) },
      { width: Math.max(72, (process.stdout.columns || 100) - 1), height: 200, fill: false }
    );
    console.log(text);
    return;
  }
  const book = await fetchBook(provider, { mode });
  const text = render(
    { book, mode, updatedAt: istFullStr(Date.now()) },
    { width: Math.max(72, (process.stdout.columns || 100) - 1), height: 200, fill: false }
  );
  console.log(text);
}

async function live(opts = {}) {
  const mode = resolveRunMode(opts);
  process.env.MUHURAT_BUY_APPROVED = 'NO';

  // Start web UI first so expired-token login can redirect to http://…:3000/
  const keys = new Set(mode === 'options' ? [] : allInstrumentKeys());
  const ltpByKey = new Map();
  let bot = null;
  let optionsBot = null;
  const state = {
    mode,
    book: {
      mode: mode === 'options' ? 'options' : 'equity',
      core: [],
      extrasBuy: [],
      extrasWatch: [],
      extrasSkipHot: [],
      screened: 0,
    },
    optionsBook: mode === 'both'
      ? { mode: 'options', core: [], extrasBuy: [], extrasWatch: [], extrasSkipHot: [], screened: 0 }
      : null,
    updatedAt: '',
    error: '',
    feed: '—',
    bot: null,
    optionsBot: null,
  };

  let web = null;
  let provider = null;
  try {
    web = await startMuhuratWeb({
      getState: () => state,
      onUpstoxLinked: ({ token, userName }) => {
        if (provider && token) provider.token = token;
        state.error = '';
        console.log(green(bold(`Upstox linked via web as ${userName || 'user'}`)));
      },
    });
    console.log(green(bold(`Muhurat web UI (public): ${web.url}`)));
    if (web.publicUrl && web.lanUrl && web.publicUrl !== web.lanUrl) {
      console.log(dim(`LAN: ${web.lanUrl}`));
    }
    if (web.localUrl && web.localUrl !== web.url) {
      console.log(dim(`Local only: ${web.localUrl}`));
    }
    console.log(dim('Link Upstox from the UI · open Oracle firewall TCP ' + web.port));
  } catch (e) {
    console.log(amber(`Muhurat web UI unavailable: ${e.message}`));
  }

  const ready = await runCheckpoints({
    ...opts,
    // Prefer Oracle/public URL so login lands on the cloud host, not 127.0.0.1
    successUrl: (web && web.url) || muhuratWebRootUrl(),
  });
  if (!ready) {
    if (web) await web.close().catch(() => {});
    return;
  }

  const defaultBudget = Number(process.env.MUHURAT_BUDGET || 20000);
  const defaultStockBudget = Number(process.env.MUHURAT_BUDGET_STOCK || defaultBudget);
  const defaultOptionsBudget = Number(process.env.MUHURAT_BUDGET_OPTIONS || defaultBudget);
  let stockBudget = defaultStockBudget;
  let optionsBudget = defaultOptionsBudget;

  process.env.MUHURAT_BUY_APPROVED = 'NO';
  delete process.env.MUHURAT_PAPER;
  const gateModes = mode === 'both'
    ? ['equity', 'options']
    : mode === 'options'
      ? ['options']
      : ['equity'];
  const liveAvailable = process.env.MUHURAT_LIVE === 'true';
  const gate = await askBuyApproval({
    defaultBudget,
    defaultStockBudget,
    defaultOptionsBudget,
    modes: gateModes,
    liveAvailable,
  });
  if (gate.approved) {
    process.env.MUHURAT_BUY_APPROVED = 'YES';
    stockBudget = gate.stockBudget || defaultStockBudget;
    optionsBudget = gate.optionsBudget || defaultOptionsBudget;
    process.env.MUHURAT_BUDGET = String(gate.budget);
    process.env.MUHURAT_BUDGET_STOCK = String(stockBudget);
    process.env.MUHURAT_BUDGET_OPTIONS = String(optionsBudget);
  } else if (gate.paper) {
    process.env.MUHURAT_PAPER = 'true';
    stockBudget = gate.stockBudget || defaultStockBudget;
    optionsBudget = gate.optionsBudget || defaultOptionsBudget;
    process.env.MUHURAT_BUDGET = String(gate.budget);
    process.env.MUHURAT_BUDGET_STOCK = String(stockBudget);
    process.env.MUHURAT_BUDGET_OPTIONS = String(optionsBudget);
  } else {
    console.log(amber(gate.reason || 'Watch-only mode.'));
  }

  provider = new UpstoxProvider(config.upstox.accessToken);
  if (mode === 'both') {
    bot = createMuhuratBot(provider, { mode: 'equity', budget: stockBudget, enforceBudget: true });
    optionsBot = createMuhuratBot(provider, { mode: 'options', budget: optionsBudget, enforceBudget: true });
  } else {
    bot = createMuhuratBot(provider, {
      mode,
      budget: mode === 'options' ? optionsBudget : stockBudget,
      enforceBudget: true,
    });
  }
  state.bot = bot ? bot.snapshot() : null;
  state.optionsBot = optionsBot ? optionsBot.snapshot() : null;

  const paperOn = !!(bot && bot.paper) || !!(optionsBot && optionsBot.paper);
  if (bot || optionsBot) {
    if (paperOn) {
      if (mode === 'both') {
        console.log(amber(bold(
          `PAPER AUTO (STOCKS+OPTIONS) — stocks ₹${stockBudget.toLocaleString('en-IN')} · options ₹${optionsBudget.toLocaleString('en-IN')} · no Upstox orders. q quit.`
        )));
      } else {
        console.log(amber(bold(
          `PAPER AUTO${mode === 'options' ? ' (OPTIONS)' : ''} — budget ₹${Number(process.env.MUHURAT_BUDGET).toLocaleString('en-IN')} · simulated fills only. q quit.`
        )));
      }
    } else if (mode === 'both') {
      console.log(red(bold(
        `FULL AUTO ARMED (STOCKS+OPTIONS) — stocks ₹${stockBudget.toLocaleString('en-IN')} (max ${maxTradesPerDay('equity')}/day) · options ₹${optionsBudget.toLocaleString('en-IN')} (max ${maxTradesPerDay('options')}/day). q quit.`
      )));
    } else {
      console.log(red(bold(
        `FULL AUTO ARMED${mode === 'options' ? ' (OPTIONS)' : ''} — budget ₹${Number(process.env.MUHURAT_BUDGET).toLocaleString('en-IN')} · max ${maxTradesPerDay(mode)} trades/day. Real BUY/SELL after session rules. q quit.`
      )));
    }
  } else {
    console.log(dim(
      mode === 'both'
        ? 'Running stocks+options without order bot — signals only.'
        : mode === 'options'
          ? 'Running Options mode without order bot — NIFTY/BANKNIFTY ATM CE/PE levels only.'
          : 'Running without order bot — ENTRY/BUY/SELL levels only.'
    ));
  }

  const term = openTerminal({
    url: web ? web.url : undefined,
    getState: () => state,
    render: (s, opts) => render(s, { ...opts, url: web ? web.url : opts && opts.url }),
  });
  if (!term && !web) {
    await once({ mode });
    return;
  }

  function pushUi() {
    if (term) term.draw();
    if (web) web.broadcast();
    else publishLiveSnapshot(state); // still feed :3000/muhurat/ when dedicated web port is busy
  }

  let tickTimer = null;
  function applyTicks() {
    if (!ltpByKey.size || !state.book) return;
    if (tickTimer) return;
    tickTimer = setTimeout(() => {
      tickTimer = null;
      state.book = patchBookLtps(
        state.book,
        ltpByKey,
        state.book,
        state.bot && state.bot.positions
      );
      repriceBookPortfolio(state.book, ltpByKey);
      if (state.optionsBook) {
        state.optionsBook = patchBookLtps(
          state.optionsBook,
          ltpByKey,
          state.optionsBook,
          state.optionsBot && state.optionsBot.positions
        );
        repriceBookPortfolio(state.optionsBook, ltpByKey);
      }
      state.updatedAt = istFullStr(Date.now());
      pushUi();
    }, 150);
  }

  function syncPortfolioKeys(book, feed) {
    const holdKeys = portfolioKeysOf(book && book.portfolioRows && book.portfolioRows.holdings);
    const posKeys = portfolioKeysOf(book && book.portfolioRows && book.portfolioRows.positions);
    const bookKeys = (book && book.instrumentKeys) || [];
    const gainerKeys = ((book && book.topGainers) || []).map((r) => r && r.key).filter(Boolean);
    const fresh = [];
    for (const k of [...holdKeys, ...posKeys, ...bookKeys, ...gainerKeys]) {
      if (!keys.has(k)) {
        keys.add(k);
        fresh.push(k);
      }
    }
    if (fresh.length && feed) feed.subscribe(fresh);
    return fresh;
  }

  async function refreshBook() {
    try {
      if (mode === 'both') {
        const money = await resolveLiveBudget(provider);
        const portfolioCache = await loadPortfolioCache(provider);
        const stickyStock = ((state.bot && state.bot.positions) || [])
          .filter((p) => p && p.qty > 0)
          .map((p) => p.ticker);
        const stickyOpt = ((state.optionsBot && state.optionsBot.positions) || [])
          .filter((p) => p && p.qty > 0)
          .map((p) => p.ticker);
        const book = await fetchBook(provider, {
          mode: 'equity',
          stickyTickers: stickyStock,
          budget: stockBudget,
          money,
          portfolioCache,
        });
        const optionsBook = await fetchBook(provider, {
          mode: 'options',
          stickyTickers: stickyOpt,
          budget: optionsBudget,
          money,
          portfolioCache,
        });
        syncPortfolioKeys(book, feed);
        syncPortfolioKeys(optionsBook, feed);
        repriceBookPortfolio(book, ltpByKey);
        repriceBookPortfolio(optionsBook, ltpByKey);
        state.book = patchBookLtps(book, ltpByKey, state.book, state.bot && state.bot.positions);
        state.optionsBook = patchBookLtps(
          optionsBook,
          ltpByKey,
          state.optionsBook,
          state.optionsBot && state.optionsBot.positions
        );
        if (bot) state.bot = await bot.tick(state.book, ltpByKey);
        if (optionsBot) state.optionsBot = await optionsBot.tick(state.optionsBook, ltpByKey);
      } else {
        const stickyTickers = ((state.bot && state.bot.positions) || [])
          .filter((p) => p && p.qty > 0)
          .map((p) => p.ticker);
        const book = await fetchBook(provider, {
          mode,
          stickyTickers,
          budget: mode === 'options' ? optionsBudget : stockBudget,
        });
        syncPortfolioKeys(book, feed);
        repriceBookPortfolio(book, ltpByKey);
        state.book = patchBookLtps(book, ltpByKey, state.book, state.bot && state.bot.positions);
        if (bot) state.bot = await bot.tick(state.book, ltpByKey);
      }
      state.updatedAt = istFullStr(Date.now());
      state.error = '';
      pushUi();
    } catch (e) {
      state.error = e.message;
      pushUi();
    }
  }

  async function pollLtps() {
    // Websocket feed already carries LTPs — REST polling only burns rate limit.
    if (state.feed === 'live') return;
    try {
      const map = await provider.getLtps([...keys]);
      for (const [k, v] of map.entries()) {
        if (Number.isFinite(v)) ltpByKey.set(k, v);
      }
      if (state.feed !== 'live') state.feed = 'poll';
      applyTicks();
    } catch (e) {
      state.error = `LTP ${e.message}`;
      pushUi();
    }
  }

  const feed = new UpstoxFeed(config.upstox.accessToken, [...keys], (tick) => {
    if (!tick || !tick.instrumentKey || !Number.isFinite(tick.ltp)) return;
    ltpByKey.set(tick.instrumentKey, tick.ltp);
    state.feed = 'live';
    applyTicks();
  });
  feed.start().catch((e) => {
    state.feed = 'poll';
    state.error = `feed ${e.message}`;
    pushUi();
  });

  await refreshBook();
  await pollLtps();
  // Pace REST so Upstox/Cloudflare do not 429 (esp. both mode + checkpoints).
  const refreshMs = (bot || optionsBot)
    ? (mode === 'both' ? 15 * 1000 : 10 * 1000)
    : 20 * 1000;
  const pollMs = mode === 'both' ? 8 * 1000 : 5 * 1000;
  setInterval(() => refreshBook().catch(() => {}), refreshMs);
  setInterval(() => pollLtps().catch(() => {}), pollMs);
  if (bot || optionsBot) {
    setInterval(() => {
      const jobs = [];
      if (bot && state.book) {
        jobs.push(bot.tick(state.book, ltpByKey).then((v) => { state.bot = v; }));
      }
      if (optionsBot && state.optionsBook) {
        jobs.push(optionsBot.tick(state.optionsBook, ltpByKey).then((v) => { state.optionsBot = v; }));
      }
      Promise.all(jobs).then(() => pushUi()).catch(() => {});
    }, mode === 'both' ? 6 * 1000 : 4 * 1000);
  }
}

function isDemoArg() {
  // Supports: --Demo / --demo / Demo, plus `npm run muhurat --Demo` (npm_config_demo).
  if (process.env.npm_config_demo === 'true' || process.env.npm_config_Demo === 'true') return true;
  return process.argv.some((a) => {
    const s = String(a);
    return s === '--Demo' || s === '--demo' || s === 'Demo' || s === 'demo' || /^--?Demo$/i.test(s);
  });
}

async function runDemo() {
  const width = Math.max(96, (process.stdout.columns || 110) - 1);
  const height = 200;
  console.log(red(bold('══════════════════════════════════════════════════════')));
  console.log(red(bold('  MUHURAT DEMO — DUMMY DATA ONLY (no Upstox orders)')));
  console.log(red(bold('══════════════════════════════════════════════════════')));
  console.log(dim('Shows how the live screen looks after 2:30 with fake picks + auto bot.'));
  console.log('');

  console.log(formatChecks(demoChecks(), { starting: false }));
  console.log('');

  console.log(bold('── Scene 1: Live BUY + FULL AUTO (dummy) ──'));
  console.log('');
  const liveState = buildDemoState('live');
  console.log(render(liveState, { width, height, fill: false, log: 'DEMO scene 1 · fake LTPs · fake positions' }));
  console.log('');

  console.log(bold('── Scene 2: Book loss near 20% → DO NOT TRADE (dummy) ──'));
  console.log('');
  const blockedState = buildDemoState('blocked');
  console.log(render(blockedState, { width, height, fill: false, log: 'DEMO scene 2 · loss gate blocks new buys' }));
  console.log('');
  console.log(dim('End of demo. Real session: npm run muhurat2   (type YES only if you want live money)'));
}

function isExitArg() {
  return process.argv.some((a) => {
    const s = String(a);
    return (
      s === '--exit'
      || s === '--Exit'
      || s === 'exit'
      || s === 'Exit'
      || /^--?exit(-?all)?$/i.test(s)
      || s === '--square-off'
      || s === '--flatten'
    );
  });
}

if (require.main === module) {
  const onceMode = process.argv.includes('--once');
  const checksOnly = process.argv.includes('--checks-only');
  const skip = process.argv.includes('--skip-checks');
  const exitAll = isExitArg();
  const demoMode = isDemoArg();
  const mode = resolveRunMode();
  const opts = { skip, mode };
  (async () => {
    if (demoMode) {
      await runDemo();
      return;
    }
    if (exitAll) {
      console.log(amber(bold('Muhurat2 EXIT — square off ALL today\'s open day trades.')));
      const result = await runMuhuratExit({ dry: isDryArg() });
      process.exit(result.fail ? 1 : 0);
    }
    if (checksOnly) {
      const report = await runMuhuratChecks();
      console.log(formatChecks(report, { starting: false }));
      process.exit(report.ok ? 0 : 1);
    }
    if (mode === 'both') {
      console.log(amber(bold('Muhurat BOTH — stocks + options in one process (separate budgets).')));
    } else if (mode === 'options') {
      console.log(amber(bold('Muhurat Options mode — NIFTY 50 + BANKNIFTY ATM CE/PE only.')));
    }
    console.log(dim(`Session · ${SESSION.label}`));
    if (onceMode) await once(opts);
    else await live(opts);
  })().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}

module.exports = {
  render,
  fetchBook,
  runCheckpoints,
  runDemo,
  isDemoArg,
  isExitArg,
  isOptionsArg,
  isBothArg,
  isStocksOnlyArg,
  resolveRunMode,
  repriceBookPortfolio,
  portfolioKeysOf,
  userSignalLines,
};
