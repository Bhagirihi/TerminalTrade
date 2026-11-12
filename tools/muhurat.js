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
const { askBuyApproval } = require('../src/muhurat-approve');
const { openTerminal } = require('../src/terminal');
const { UpstoxFeed } = require('../src/data/upstox-feed');
const { summarizePortfolio, summarizeLive } = require('../src/portfolio');
const { demoChecks, buildDemoState } = require('../src/muhurat-demo');

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

async function runCheckpoints({ skip = false } = {}) {
  if (skip) {
    console.log('Muhurat checkpoints skipped (--skip-checks).');
    return true;
  }
  const report = await runMuhuratChecks();
  console.log(formatChecks(report));
  console.log('');
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
  const lotBit = row.lots > 0 ? ` ${row.lots} lot×${row.lotSize || ''}`.trim() : '';
  const qtyBit = row.qty > 0
    ? ` qty ${row.qty}${lotBit ? ` (${lotBit})` : ''}≈₹${fmt(row.spend)}`
    : '';
  const edgeBit = row.expectedT1 > 0 ? green(` T1≈+₹${fmt(row.expectedT1)}`) : (row.reward1Pct != null ? dim(` T1 ${pct(row.reward1Pct)}`) : '');
  const liveBit = row.live ? green(' LIVE') : '';
  const pScore = row.profitScore != null ? dim(` P${fmt(row.profitScore)}`) : dim(` ${row.score} `);
  const gainerBit = row.fromGainer ? amber(' GAINER') : '';
  lines.push(cardRow(` ${bold(row.ticker)} ${verdictPaint(row.verdict)}${gainerBit}${liveBit}`, pScore, inner, border));
  const dayBit = row.dayChangePct != null ? ` day ${tonePct(row.dayChangePct)}` : '';
  const idxBit = row.indexLtp != null ? ` idx ${fmt(row.indexLtp)}` : '';
  lines.push(cardRow(clip(` LTP ${fmt(row.ltp)} RSI ${fmt(row.rsi)} SMA ${tonePct(row.distSma)}${idxBit}${dayBit}${qtyBit}${edgeBit}`, inner), '', inner, border));
  lines.push(cardRow(clip(
    ` ENTRY ${fmt(row.entry)}  BUY ${row.buy === 'YES' ? green('YES') : row.buy === 'LATER' ? amber('LATER') : dim(row.buy || 'NO')}  ACT ${bold(row.action || 'WAIT')}`,
    inner
  ), '', inner, border));
  lines.push(cardRow(clip(
    ` SELL  SL ${red(fmt(row.sellStop))}  T1 ${green(fmt(row.sellT1))}  T2 ${green(fmt(row.sellT2))}`,
    inner
  ), '', inner, border));
  lines.push(cardRow(clip(` Sup ${fmt(lv.support)} Res ${fmt(lv.resistance)} R2 ${fmt(lv.resistanceNext)}`, inner), '', inner, border));
  lines.push(cardRow(clip(
    ` Trail ${lv.trailMode === 'options' ? 'opt' : 'stk'} arm→${fmt(lv.trailArmPx || lv.trailArm06)} lock→${fmt(lv.trailFirstLockPx || lv.trailLock03)} · ${lv.trailLabel || ''}`,
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
  const phaseInfo = (book && book.phase) || phase || {};
  const lossGate = (bot && bot.lossGate) || (book && book.lossGate);
  const buyBlocked = lossGate && lossGate.blocked;

  const buys = [];
  const seenBuy = new Set();
  if (!buyBlocked && phaseInfo.canDecideBuy !== false) {
    for (const r of (book && book.liveBuys) || []) {
      if (!r || !r.ticker) continue;
      if (r.verdict !== 'BUY') continue;
      if (!(Number(r.profitScore) > 12)) continue;
      if (!(r.qty > 0)) continue;
      if (r.orderReady === false) continue;
      if (seenBuy.has(r.ticker)) continue;
      seenBuy.add(r.ticker);
      buys.push(r.ticker);
    }
  }

  const sells = [];
  const seenSell = new Set();
  const pushSell = (ticker) => {
    if (!ticker || seenSell.has(ticker)) return;
    seenSell.add(ticker);
    sells.push(ticker);
  };
  const exitOnly = phaseInfo.phase === 'exit_only' || phaseInfo.phase === 'closed';
  for (const p of (bot && bot.positions) || []) {
    if (!p || !p.ticker || !(p.qty > 0)) continue;
    const last = Number(p.last);
    const stop = Number(p.stop);
    const t2 = Number(p.t2);
    if (exitOnly) pushSell(p.ticker);
    else if (Number.isFinite(last) && Number.isFinite(stop) && last <= stop) pushSell(p.ticker);
    else if (Number.isFinite(last) && Number.isFinite(t2) && last >= t2) pushSell(p.ticker);
  }
  // If auto BUY failed (IP / 403), still surface the name from recent bot errors/logs.
  if (!buyBlocked) {
    const err = String((bot && bot.lastError) || '');
    const m = err.match(/^BUY\s+([A-Z0-9 .&-]+)\s*:/i);
    if (m && m[1] && !seenBuy.has(m[1].trim())) {
      const t = m[1].trim();
      seenBuy.add(t);
      buys.unshift(t);
    }
  }

  if (!buys.length && !sells.length) return lines;
  lines.push(bold('USER SIGNALS') + dim(' · place manually if auto order blocked'));
  for (const t of buys.slice(0, 8)) {
    lines.push(clip(green(bold(`BUY(USER) ==> ${t}`)), width));
  }
  for (const t of sells.slice(0, 8)) {
    lines.push(clip(red(bold(`SELL(USER) ==> ${t}`)), width));
  }
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
  if (optionsMode && (book.indexes || []).length) {
    const bits = (book.indexes || []).map((ix) => {
      if (!ix || ix.error) return `${ix && ix.indexId ? ix.indexId : '?'} err`;
      return `${ix.indexId} ${fmt(ix.indexLtp)} bias ${ix.bias || '—'} P-ready`;
    });
    lines.push(clip(dim(`Index  ${bits.join(' · ')}`), width));
  }
  // Positions only: total investment + always show Profit and Loss.
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
    const profit = pnl > 0 ? pnl : 0;
    const loss = pnl < 0 ? Math.abs(pnl) : 0;
    lines.push(clip(
      bold('Positions') +
        dim(` · Invest ₹${fmt(invest)}`) +
        dim(` · Value ₹${fmt(value)}`) +
        ' · ' + green(`Profit ₹${fmt(profit)}`) +
        ' · ' + red(`Loss ₹${fmt(loss)}`),
      width
    ));
  } else if (phase.canDecideBuy) {
    lines.push(clip(
      bold('Positions') + dim(' · Invest ₹0.00') + ' · ' + green('Profit ₹0.00') + ' · ' + red('Loss ₹0.00'),
      width
    ));
  }
  const bud = book.budget;
  const avail = book.availableMargin != null ? book.availableMargin : (bud && bud.availableMargin);
  if (avail != null && Number.isFinite(Number(avail))) {
    lines.push(clip(green(`Available margin ₹${fmt(avail)}`) + dim(' · Live BUY = P > 12 only'), width));
  }
  const tradeMode = optionsMode ? 'options' : 'equity';
  const tradeCap = (book.rules && book.rules.maxTrades) != null
    ? book.rules.maxTrades
    : maxTradesPerDay(tradeMode);
  const botTrades = state && state.bot && state.bot.tradesToday != null ? state.bot.tradesToday : null;
  const confirmNeed = (book.budget && book.budget.confirmSec) != null
    ? book.budget.confirmSec
    : (book.rules && book.rules.confirmSec);
  if (tradeCap > 0) {
    lines.push(clip(
      dim(`Max ${tradeCap} ${optionsMode ? 'option' : 'stock'} trades/day`) +
        (botTrades != null ? dim(` · used ${botTrades}/${tradeCap}`) : '') +
        (confirmNeed > 0 ? dim(` · confirm ${confirmNeed}s before BUY`) : ''),
      width
    ));
  }
  if (bud) {
    if (phase.canDecideBuy && bud.pickCount > 0) {
      lines.push(clip(
        green(`Budget ₹${fmt(bud.budget)}`) +
          dim(` · ${bud.pickCount} picks · use ₹${fmt(bud.used)} · left ₹${fmt(bud.left)}`) +
          (bud.expectedT1 != null ? green(` · if T1s hit ≈+₹${fmt(bud.expectedT1)}`) : ''),
        width
      ));
    } else {
      lines.push(clip(
        dim(`Budget ₹${fmt(bud.budget)} ready · after open: BUY names with P > 12 · max ${tradeCap || '∞'} trades/day`),
        width
      ));
    }
  }
  const lossGate = (state && state.bot && state.bot.lossGate) || (book && book.lossGate);
  if (lossGate && lossGate.blocked) {
    lines.push(clip(red(bold('DO NOT TRADE')) + red(` · book loss ${lossGate.pnlPct}% (near −${lossGate.limit}% / 20% rule)`), width));
  }
  if (state && state.bot && state.bot.live) {
    lines.push(clip(red(bold('FULL AUTO LIVE')) + dim(` · product ${state.bot.product || 'I'} · spend ₹${fmt(state.bot.spend)} · open ${state.bot.openCount || 0}`), width));
    if (state.bot.lastError) lines.push(clip(red(state.bot.lastError), width));
    for (const p of state.bot.positions || []) {
      lines.push(clip(
        green(`IN ${p.ticker} qty ${p.qty} entry ${fmt(p.entry)} SL ${fmt(p.stop)} stage ${p.stage} last ${fmt(p.last)}`),
        width
      ));
    }
    for (const row of (state.bot.log || []).slice(-3)) {
      lines.push(clip(dim(row.msg), width));
    }
  } else {
    lines.push(clip(dim('Auto off — signals only. Trail: stock +2.5%→+1.5% then +1% · options +5%→cost then +10%/+5% · exit 3:15'), width));
  }

  lines.push(...userSignalLines(book, state && state.bot, phase, width));

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
      lines.push(bold('Live BUY — P > 12'));
      lines.push(...placeBoxes(liveBuys, width));
    }
    if (watchlistLive.length) {
      lines.push(bold('Watchlist — P > 12'));
      lines.push(...placeBoxes(watchlistLive, width));
    }
    const confirming = (book.budget && book.budget.confirming) || [];
    if (confirming.length) {
      lines.push(bold('Confirming — top P, waiting stability before trade slot'));
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
    lines.push(bold('Watchlist — P > 12 (no BUY call yet)'));
    lines.push(...placeBoxes(watchBefore, width));
    if (prep.length && core.length) {
      const prepExtra = prep
        .filter((p) => !core.some((c) => c.ticker === p.ticker))
        .sort(byPDesc)
        .slice(0, 6);
      if (prepExtra.length) {
        lines.push(bold('Other PREP — P > 12 (wait for open)'));
        lines.push(...placeBoxes(prepExtra, width));
      }
    }
  }
  if ((book.extrasSkipHot || []).length) {
    const hot = (book.extrasSkipHot || []).map((r) => `${r.ticker} ${fmt(r.rsi)}`).join(' · ');
    lines.push(clip(red(`Too hot  ${hot}`), width));
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
      lines.push(bold('Top Gainers — P > 12'));
      lines.push(...placeBoxes(gainers, width));
    } else if (book.gainerError) {
      lines.push(clip(amber(`Top Gainers · ${book.gainerError}`), width));
    }
  }

  if (!opts.hideFooter) {
    lines.push(clip(dim('Hold above open 5–10m → buy · book T1 · exit T2 or 3:15 · q quit'), width));
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
        bold('Muhurat') + dim('  stocks + options · one process · separate budgets  ') + feedLabel +
          dim(state && state.updatedAt ? ` · ${state.updatedAt}` : ''),
        width
      ),
      ...sharedError,
    ];
    const stockLines = renderBookPanel(
      { ...state, mode: 'equity', book: state.book || {}, bot: state.bot, error: '' },
      { width, panelTitle: 'Stocks', hideSharedError: true, hideFeedPhase: false, hideFooter: true }
    );
    const optLines = renderBookPanel(
      { ...state, mode: 'options', book: state.optionsBook || {}, bot: state.optionsBot, error: '' },
      { width, panelTitle: 'Options', hideSharedError: true, hideFeedPhase: true, hideFooter: true }
    );
    lines = [
      ...header,
      ...stockLines,
      clip(dim('─'.repeat(Math.min(width, 48))), width),
      ...optLines,
      clip(dim('Hold above open 5–10m → buy · separate stock/options budgets · exit 3:15 · q quit'), width),
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
  const ready = await runCheckpoints(opts);
  if (!ready) return;

  const defaultBudget = Number(process.env.MUHURAT_BUDGET || 20000);
  const defaultStockBudget = Number(process.env.MUHURAT_BUDGET_STOCK || defaultBudget);
  const defaultOptionsBudget = Number(process.env.MUHURAT_BUDGET_OPTIONS || defaultBudget);
  let bot = null;
  let optionsBot = null;
  let stockBudget = defaultStockBudget;
  let optionsBudget = defaultOptionsBudget;

  if (process.env.MUHURAT_LIVE === 'true') {
    const gateModes = mode === 'both'
      ? ['equity', 'options']
      : mode === 'options'
        ? ['options']
        : ['equity'];
    const gate = await askBuyApproval({
      defaultBudget,
      defaultStockBudget,
      defaultOptionsBudget,
      modes: gateModes,
    });
    if (gate.approved) {
      process.env.MUHURAT_BUY_APPROVED = 'YES';
      stockBudget = gate.stockBudget || defaultStockBudget;
      optionsBudget = gate.optionsBudget || defaultOptionsBudget;
      process.env.MUHURAT_BUDGET = String(gate.budget);
      process.env.MUHURAT_BUDGET_STOCK = String(stockBudget);
      process.env.MUHURAT_BUDGET_OPTIONS = String(optionsBudget);
    } else {
      process.env.MUHURAT_BUY_APPROVED = 'NO';
      console.log(amber(gate.reason || 'Watch-only mode.'));
    }
  } else {
    console.log(dim(
      mode === 'both'
        ? 'MUHURAT_LIVE is not true — stocks+options signals / watch only (no Upstox orders).'
        : mode === 'options'
          ? 'MUHURAT_LIVE is not true — Options signals / watch only (no Upstox orders).'
          : 'MUHURAT_LIVE is not true — signals / watch only (no Upstox orders).'
    ));
  }

  const provider = new UpstoxProvider(config.upstox.accessToken);
  if (mode === 'both') {
    bot = createMuhuratBot(provider, { mode: 'equity', budget: stockBudget, enforceBudget: true });
    optionsBot = createMuhuratBot(provider, { mode: 'options', budget: optionsBudget, enforceBudget: true });
  } else {
    bot = createMuhuratBot(provider, {
      mode,
      budget: mode === 'options' ? optionsBudget : stockBudget,
    });
  }

  if (bot || optionsBot) {
    if (mode === 'both') {
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

  const keys = new Set(mode === 'options' ? [] : allInstrumentKeys());
  const ltpByKey = new Map();
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
    bot: bot ? bot.snapshot() : null,
    optionsBot: optionsBot ? optionsBot.snapshot() : null,
  };

  const term = openTerminal({
    getState: () => state,
    render,
  });
  if (!term) {
    await once({ mode });
    return;
  }

  let tickTimer = null;
  function applyTicks() {
    if (!ltpByKey.size || !state.book) return;
    if (tickTimer) return;
    tickTimer = setTimeout(() => {
      tickTimer = null;
      state.book = patchBookLtps(state.book, ltpByKey);
      repriceBookPortfolio(state.book, ltpByKey);
      if (state.optionsBook) {
        state.optionsBook = patchBookLtps(state.optionsBook, ltpByKey);
        repriceBookPortfolio(state.optionsBook, ltpByKey);
      }
      state.updatedAt = istFullStr(Date.now());
      term.draw();
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
        state.book = patchBookLtps(book, ltpByKey);
        state.optionsBook = patchBookLtps(optionsBook, ltpByKey);
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
        state.book = patchBookLtps(book, ltpByKey);
        if (bot) state.bot = await bot.tick(state.book, ltpByKey);
      }
      state.updatedAt = istFullStr(Date.now());
      state.error = '';
      term.draw();
    } catch (e) {
      state.error = e.message;
      term.draw();
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
      term.draw();
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
    term.draw();
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
      Promise.all(jobs).then(() => term.draw()).catch(() => {});
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
  console.log(dim('End of demo. Real session: npm run muhurat   (type YES only if you want live money)'));
}

if (require.main === module) {
  const onceMode = process.argv.includes('--once');
  const checksOnly = process.argv.includes('--checks-only');
  const skip = process.argv.includes('--skip-checks');
  const demoMode = isDemoArg();
  const mode = resolveRunMode();
  const opts = { skip, mode };
  (async () => {
    if (demoMode) {
      await runDemo();
      return;
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
  isOptionsArg,
  isBothArg,
  isStocksOnlyArg,
  resolveRunMode,
  repriceBookPortfolio,
  portfolioKeysOf,
  userSignalLines,
};
