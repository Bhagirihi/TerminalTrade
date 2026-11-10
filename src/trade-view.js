'use strict';

const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const { openTerminal } = require('./terminal');

const GEMINI_CACHE = path.join(__dirname, '..', 'cache', 'gemini-book.json');

function paint(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}
const dim = (t) => paint('2', t);
const bold = (t) => paint('1', t);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const amber = (t) => paint('33', t);

function visLen(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
}

function clipAnsi(s, n) {
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

function padAnsi(s, n) {
  const clipped = clipAnsi(s, n);
  const gap = n - visLen(clipped);
  return gap > 0 ? clipped + ' '.repeat(gap) : clipped;
}

function fmt(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function money(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n));
}

function pct(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)}%`;
}

function tone(n, text) {
  if (n == null || !Number.isFinite(Number(n))) return text;
  return n >= 0 ? green(text) : red(text);
}

function wrap(text, width) {
  const words = String(text || '').replace(/\*\*/g, '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  const limit = Math.max(8, width);
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (cur && next.length > limit) {
      lines.push(cur);
      cur = word;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function box(body, width, ink) {
  const border = ink || dim;
  const inner = Math.max(8, width - 2);
  const lines = [border('┌' + '─'.repeat(inner) + '┐')];
  for (const row of body) lines.push(border('│') + padAnsi(` ${row}`, inner) + border('│'));
  lines.push(border('└' + '─'.repeat(inner) + '┘'));
  return lines;
}

function place(cards, width) {
  if (!cards.length) return [];
  const gap = 2;
  const min = 28;
  let cols = Math.max(1, Math.min(cards.length, Math.floor((width + gap) / (min + gap)), 4));
  const col = Math.floor((width - gap * (cols - 1)) / cols);
  const out = [];
  for (let i = 0; i < cards.length; i += cols) {
    const slice = cards.slice(i, i + cols);
    const drawn = slice.map((card) => box(card.body, col, card.ink));
    const height = Math.max(...drawn.map((lines) => lines.length));
    for (let line = 0; line < height; line++) {
      out.push(drawn.map((lines) => padAnsi(lines[line] || '', col)).join(' '.repeat(gap)));
    }
  }
  return out;
}

function badge(state) {
  if (!state || state.status === 'starting') return amber('connecting…');
  if (state.status === 'error') return red(`ERROR: ${state.error || ''}`);
  if (state.feed === 'upstox' || state.source === 'UPSTOX') return green('UPSTOX — REALTIME');
  if (state.source === 'ANGELONE') return green('ANGEL ONE — LIVE');
  return amber(state.source || state.status || 'waiting');
}

function splitBook(book) {
  const cards = Array.isArray(book && book.cards) ? [...book.cards] : [];
  const sell = [];
  const hold = [];
  for (const card of cards) {
    if (card.pnlPct != null && card.pnlPct < -10) sell.push(card);
    else hold.push(card);
  }
  sell.sort((a, b) => a.pnl - b.pnl);
  hold.sort((a, b) => b.pnl - a.pnl);
  return { sell, hold };
}

function stockBox(card) {
  const rsi = card.rsi == null ? 'RSI —' : `RSI ${Number(card.rsi).toFixed(1)}`;
  const average = card.aboveSma == null ? '50-day —' : card.aboveSma ? 'above 50-day' : 'under 50-day';
  return {
    ink: card.pnl < 0 ? red : green,
    body: [
      `${bold(card.ticker)}  ${tone(card.pnlPct, pct(card.pnlPct))}`,
      tone(card.pnl, money(card.pnl)),
      dim(`${average}  ${rsi}`),
    ],
  };
}

function technicalLines(cards, width) {
  const lines = ['', bold('Technicals')];
  const known = (cards || []).filter((card) => card.sma50 != null);
  if (!known.length) {
    lines.push(dim('50-day average and RSI load from daily prices. Each box shows them once that history arrives.'));
    lines.push(dim('Earnings, debt, and valuation are not in the Upstox book, so this read stays on price.'));
    return lines.map((line) => clipAnsi(line, width));
  }
  const under = known.filter((card) => card.aboveSma === false);
  const hot = known.filter((card) => card.rsi != null && card.rsi > 75).sort((a, b) => b.rsi - a.rsi);
  const lossUnder = under.filter((card) => card.pnl < 0).sort((a, b) => a.pnl - b.pnl).slice(0, 4);
  lines.push(dim(`${under.length} of ${known.length} names are under their own 50-day average.`));
  lines.push(dim(hot.length ? `RSI above 75: ${hot.map((card) => `${card.ticker} ${Number(card.rsi).toFixed(1)}`).join(', ')}.` : 'No name has RSI above 75.'));
  if (lossUnder.length) lines.push(dim(`The open loss under that average is largest in ${lossUnder.map((card) => card.ticker).join(', ')}.`));
  lines.push(dim('Earnings, debt, and valuation are not in the Upstox book. This is the price average and RSI.'));
  return lines.map((line) => clipAnsi(line, width));
}

function indexBox(symbol) {
  if (!symbol) {
    return { ink: dim, body: [dim('Waiting for price')] };
  }
  const trend = symbol.direction == null ? dim('—') : symbol.direction < 0 ? green('BULLISH') : red('BEARISH');
  const change = symbol.change == null ? dim('—') : tone(symbol.change, `${money(symbol.change)}  ${pct(symbol.changePct)}`);
  return {
    ink: dim,
    body: [
      bold(symbol.contract ? `${symbol.name || 'Index'}  ${symbol.contract}` : (symbol.name || 'Index')),
      `${bold(fmt(symbol.ltp))}  ${trend}`,
      change,
    ],
  };
}

function plainRows(title, rows, width) {
  const lines = ['', bold(title)];
  if (!rows.length) {
    lines.push(dim('None yet today.'));
    return lines;
  }
  for (const row of rows) lines.push(clipAnsi(row, width));
  return lines;
}

function fmtStrike(strike, right) {
  if (strike == null) return '';
  const n = Number(strike).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  return right ? `${n} ${right}` : n;
}

function signalLine(sig) {
  const type = sig.type || '—';
  const kind = type === 'BUY CE' || type === 'BUY FUT'
    ? green(type)
    : type === 'BUY PE' || type === 'SELL FUT'
      ? red(type)
      : amber(type);
  const contract = sig.contract ? `  ${sig.contract}` : '';
  const strike = sig.strike != null ? `  ${fmtStrike(sig.strike, sig.right)}` : '';
  const prem = sig.premium != null ? `  prem ${fmt(sig.premium)}` : '';
  const px = sig.price != null ? `  @ ${fmt(sig.price)}` : '';
  const why = sig.reason ? `  ${dim(sig.reason)}` : '';
  return `${sig.timeIST || '—'}  ${sig.index || '—'}  ${kind}${contract}${strike}${prem}${px}${why}`;
}

function paperLine(trade) {
  const pnl = tone(trade.pnl, money(trade.pnl));
  const side = trade.side || '';
  const sideInk = side === 'BUY CE' || side === 'BUY FUT' ? green(side) : side === 'BUY PE' || side === 'SELL FUT' ? red(side) : side;
  const strike = trade.instrument === 'FUT' || trade.contract
    ? (trade.contract ? `FUT ${trade.contract}` : 'FUT')
    : fmtStrike(trade.strike, trade.right);
  const marks = trade.entryPrice != null
    ? `  ${fmt(trade.entryPrice)}→${fmt(trade.last != null ? trade.last : trade.entryPrice)}`
    : '';
  const stake = trade.stake != null ? `  stake ${fmt(trade.stake)}` : '';
  return `${trade.index || '—'}  ${sideInk}${strike ? `  ${strike}` : ''}  ${trade.status || '—'}${marks}  ${pnl}${stake}`;
}

function megaBullLines(mb, width) {
  const lines = ['', bold('MegaBull paper')];
  if (!mb || !mb.enabled) {
    lines.push(dim('Set MEGABULL_API_KEY in .env to mirror signals as virtual orders.'));
    return lines.map((line) => clipAnsi(line, width));
  }
  lines.push(clipAnsi(
    dim(`Cash left ${fmt(mb.virtualMoneyLeft)} / ${fmt(mb.virtualMoney)}   Brokerage ${fmt(mb.brokerage)}`),
    width
  ));
  if (mb.lastError) lines.push(clipAnsi(red(mb.lastError), width));
  const positions = mb.positions || [];
  if (!positions.length) lines.push(dim('No open MegaBull position.'));
  else {
    for (const p of positions.slice(0, 6)) {
      const side = p.type === 'LONG' ? green('LONG') : p.type === 'SHORT' ? red('SHORT') : dim(p.type || '—');
      lines.push(clipAnsi(
        `${p.instrumentName || p.instrumentToken}  ${side}  qty ${p.qty}  avg ${fmt(p.priceAvg)}  P&L ${tone(p.pl, money(p.pl))}`,
        width
      ));
    }
  }
  const log = mb.log || [];
  for (const row of log.slice(-4)) {
    if (row.error) lines.push(clipAnsi(dim(`fail ${row.type || ''} ${row.strike || ''} ${row.error}`), width));
    else {
      lines.push(clipAnsi(
        dim(`${row.type || row.side} ${row.tradingSymbol || row.instrumentName || ''} @ ${fmt(row.price)}  ${row.status || ''}`),
        width
      ));
    }
  }
  lines.push(dim('Virtual MegaBull orders only. Upstox is never ordered.'));
  return lines.map((line) => clipAnsi(line, width));
}

function paperPlanLines(plan, width) {
  const lines = ['', bold('Paper trades')];
  if (!plan) {
    lines.push(dim('Paper plan loads with the live book.'));
    return lines.map((line) => clipAnsi(line, width));
  }
  if (plan.newBuyCashStart == null && plan.portfolioValue == null) {
    lines.push(dim('Upstox book not loaded yet — NEW BUY cash waits for holdings.'));
  } else {
    lines.push(clipAnsi(
      dim(`SELL total ${fmt(plan.sellTotal)}   NEW BUY cash left ${fmt(plan.newBuyCash)} / start ${fmt(plan.newBuyCashStart)}`),
      width
    ));
  }
  const cmd = ((config.paperCommodities && config.paperCommodities.length) ? config.paperCommodities : ['CRUDE']).join('+');
  const indexUsed = Math.round((50000 - Number(plan.indexPool || 0)) * 100) / 100;
  const cmdUsed = Math.round((50000 - Number(plan.commodityPool || 0)) * 100) / 100;
  lines.push(clipAnsi(
    dim(`Index left ${fmt(plan.indexPool)} (in use ${fmt(indexUsed)})   Commodity ${cmd} left ${fmt(plan.commodityPool)} (in use ${fmt(cmdUsed)})`),
    width
  ));
  const trades = plan.trades || [];
  if (!trades.length) lines.push(dim('None yet today.'));
  else {
    const open = trades.filter((t) => t.status === 'OPEN' || t.status === 'HOLD');
    const sold = trades.filter((t) => t.status === 'SOLD');
    const closed = trades.filter((t) => t.status === 'CLOSED');
    const show = [...open.slice(0, 6), ...closed.slice(-4)];
    for (const row of show) lines.push(clipAnsi(paperLine(row), width));
    if (sold.length) lines.push(dim(`${sold.length} SELL names treated as sold for NEW BUY cash.`));
    if (trades.length > show.length) lines.push(dim(`${trades.length - show.length} more rows in paper/plan-*.json`));
  }
  if (plan.total != null) lines.push(tone(plan.total, `Paper plan P&L ${money(plan.total)}`));
  if (plan.squareOffSaved) lines.push(dim('Square-off P&L JSON saved under paper/pnl-*.json'));
  return lines;
}

function geminiLines(note, width) {
  const lines = ['', bold('Gemini')];
  if (!note || !note.text) {
    lines.push(dim('No saved suggestion yet. Run npm run screen once. This box keeps that note.'));
    lines.push(dim('Not an order.'));
    return lines;
  }
  const clean = withoutEmptyAdvice(String(note.text)).replace(/\*\*/g, '').replace(/^\s*[*\-]\s+/gm, '');
  const kept = [];
  for (const para of clean.split(/\n+/)) {
    const trimmed = para.trim();
    if (!trimmed || /^stock-by-stock/i.test(trimmed)) continue;
    kept.push(...wrap(trimmed.replace(/^(summary|risk)\s*:\s*/i, ''), width));
    if (kept.length >= 5) break;
  }
  lines.push(...kept.slice(0, 5));
  const when = note.at ? new Date(note.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false, day: '2-digit', month: 'short' }) : '';
  lines.push(dim(when ? `Saved ${when} IST. Same note until the book changes. Not an order.` : 'Saved note. Not an order.'));
  return lines;
}

function withoutEmptyAdvice(text) {
  return String(text || '')
    .split(/\n+/)
    .filter((line) => !/clear understanding of the underlying fundamentals/i.test(line))
    .join('\n');
}

function loadGeminiNote() {
  try {
    const saved = JSON.parse(fs.readFileSync(GEMINI_CACHE, 'utf8'));
    if (!saved || typeof saved.text !== 'string') return null;
    return saved;
  } catch (_) {
    return null;
  }
}

function pointsToCash(pts, qty) {
  if (!Number.isFinite(pts) || !Number.isFinite(qty)) return null;
  return pts * qty;
}

function newBuyFrom(symbol, pos) {
  if (!symbol || !pos) return null;
  const label = pos.label || (pos.side === 'SHORT' ? 'BUY PE' : 'BUY CE');
  if (label !== 'BUY CE' && label !== 'BUY PE') return null;
  const ltp = Number(symbol.ltp);
  const target = Number(pos.target);
  const stop = Number(pos.stopLoss);
  const qty = Number(pos.qty || symbol.lotSize);
  const long = label === 'BUY CE';
  const profitPts = Number.isFinite(ltp) && Number.isFinite(target) ? (long ? target - ltp : ltp - target) : null;
  const lossPts = Number.isFinite(ltp) && Number.isFinite(stop) ? (long ? ltp - stop : stop - ltp) : null;
  const name = symbol.name || symbol.id || 'Index';
  const commodity = symbol.kind === 'commodity' || !!symbol.contract;
  const shown = commodity
    ? (label === 'BUY CE' ? 'BUY FUT' : label === 'BUY PE' ? 'SELL FUT' : label)
    : label;
  const strike = commodity
    ? (symbol.contract ? ` ${symbol.contract}` : ' FUT')
    : pos.strike != null
      ? ` ${Number(pos.strike).toLocaleString('en-IN', { maximumFractionDigits: 0 })}${pos.right ? ` ${pos.right}` : ''}`
      : '';
  const body = [`${bold(name)}  ${shown.includes('PE') || shown.includes('SELL') ? red(shown) : green(shown)}${strike}`];
  if (pos.asOf) body.push(dim(pos.asOf));
  body.push(
    `Now ${fmt(Number.isFinite(ltp) ? ltp : null)}`,
    `Target ${fmt(Number.isFinite(target) ? target : null)}`,
    `Stop ${fmt(Number.isFinite(stop) ? stop : null)}`,
    `Profit ${tone(profitPts, money(pointsToCash(profitPts, qty)))}`,
    `Loss ${tone(lossPts == null ? null : -Math.abs(lossPts), money(pointsToCash(lossPts == null ? null : -Math.abs(lossPts), qty)))}`,
  );
  return { ink: amber, body };
}

function sessionSetup(symbol) {
  if (!symbol || symbol.position || !symbol.lastSession) return null;
  const price = Number(symbol.ltp);
  if (symbol.direction == null || !Number.isFinite(price)) return null;
  const long = symbol.direction < 0;
  const stop = Number(symbol.supertrend);
  const pivot = Number(long ? symbol.resistance : symbol.support);
  return {
    label: long ? 'BUY CE' : 'BUY PE',
    stopLoss: Number.isFinite(stop) && (long ? stop < price : stop > price) ? stop : null,
    target: Number.isFinite(pivot) && (long ? pivot > price : pivot < price) ? pivot : null,
    qty: symbol.lotSize,
    asOf: symbol.lastSession,
  };
}

function newBuys(state) {
  const symbols = (state && state.symbols) || {};
  const ce = (state && state.ceStrategy) || {};
  const rows = [];
  const paperCmd = (config.paperCommodities && config.paperCommodities.length) ? config.paperCommodities : ['CRUDE'];
  for (const id of ['NIFTY', 'BANKNIFTY', ...paperCmd]) {
    const symbol = symbols[id];
    if (!symbol) continue;
    const v1 = newBuyFrom(symbol, symbol.position) || newBuyFrom(symbol, sessionSetup(symbol));
    if (v1) rows.push(v1);
    const lane = ce[id];
    const v2 = lane && lane.position && lane.position !== symbol.position ? newBuyFrom({ ...symbol, ltp: lane.ltp != null ? lane.ltp : symbol.ltp }, lane.position) : null;
    if (v2) rows.push(v2);
  }
  return rows;
}

function collectSignals(state) {
  const rows = [];
  for (const [id, symbol] of Object.entries((state && state.symbols) || {})) {
    const commodity = symbol.kind === 'commodity' || ['CRUDE', 'GOLD', 'SILVER'].includes(id);
    for (const sig of symbol.signalsToday || []) {
      let type = sig.type;
      if (commodity && (type === 'BUY CE' || type === 'BUY PE')) {
        type = type === 'BUY CE' ? 'BUY FUT' : 'SELL FUT';
      }
      rows.push({
        ...sig,
        type,
        index: symbol.name,
        contract: symbol.contract || sig.contract || null,
        strike: commodity ? null : sig.strike,
        right: commodity ? null : sig.right,
      });
    }
  }
  for (const lane of Object.values((state && state.ceStrategy) || {})) {
    for (const sig of lane.signalsToday || []) {
      rows.push({ ...sig, index: lane.indexName || lane.name });
    }
  }
  rows.sort((a, b) => (a.t || 0) - (b.t || 0));
  return rows;
}

function renderTrade(state, opts = {}) {
  const width = Math.max(40, opts.width || 80);
  const height = Math.max(16, opts.height || 40);
  const grouped = splitBook(state && state.portfolio);
  let holdLimit = opts.holdLimit == null ? grouped.hold.length : opts.holdLimit;
  let sellLimit = opts.sellLimit == null ? grouped.sell.length : opts.sellLimit;
  let signalLimit = opts.signalLimit == null ? 8 : opts.signalLimit;
  let paperLimit = opts.paperLimit == null ? 8 : opts.paperLimit;

  const build = () => composeTrade(state, { ...opts, width, holdLimit, sellLimit, signalLimit, paperLimit });
  let lines = build();
  while (lines.length + 1 > height && (holdLimit > 4 || sellLimit > 4 || signalLimit > 3 || paperLimit > 2)) {
    if (sellLimit > 8) sellLimit = 8;
    else if (holdLimit > 8) holdLimit = 8;
    else if (sellLimit > 4) sellLimit = 4;
    else if (holdLimit > 4) holdLimit = 4;
    else if (signalLimit > 3) signalLimit = 3;
    else paperLimit = 2;
    lines = build();
  }

  const foot = dim('Signals only. No orders are sent.  q quit');
  const bodyBudget = Math.max(1, height - 1);
  let body = lines.length > bodyBudget ? lines.slice(0, bodyBudget) : lines;
  while (body.length < bodyBudget) body.push('');
  return [...body, foot].slice(0, height).map((line) => padAnsi(line, width)).join('\n');
}

function composeTrade(state, opts) {
  const width = opts.width;
  const book = (state && state.portfolio) || null;
  const symbols = (state && state.symbols) || {};
  const paid = book && book.investment != null ? fmt(book.investment) : '—';
  const pnl = book && book.pnl != null ? book.pnl : null;
  const value = book && book.investment != null && pnl != null ? book.investment + pnl : null;
  const pnlPct = book && book.investment ? (pnl / book.investment) * 100 : null;

  const lines = [];
  const title = bold('NIFTY 50  ·  BANKNIFTY');
  const mark = badge(state || {});
  lines.push(clipAnsi(title + ' '.repeat(Math.max(1, width - visLen(title) - visLen(mark))) + mark, width));
  lines.push(dim(state && state.updatedAt ? state.updatedAt : 'waiting for the dashboard'));
  if (!book) lines.push(dim('Waiting for the Upstox book.'));
  else if (book.error) lines.push(red(book.error));
  else lines.push(clipAnsi(`Paid ${paid}   Value ${value == null ? '—' : fmt(value)}   P&L ${tone(pnl, `${money(pnl)}  ${pct(pnlPct)}`)}`, width));
  lines.push(...place([indexBox(symbols.NIFTY), indexBox(symbols.BANKNIFTY)], width));
  const commodities = ['CRUDE', 'GOLD', 'SILVER'].map((id) => symbols[id]).filter(Boolean);
  if (commodities.length) {
    lines.push(bold('CRUDE  ·  GOLD  ·  SILVER'));
    lines.push(...place(commodities.map(indexBox), width));
  }
  lines.push(...technicalLines(book && book.cards, width));

  const grouped = splitBook(book);
  const hold = grouped.hold.slice(0, opts.holdLimit == null ? grouped.hold.length : opts.holdLimit).map(stockBox);
  const sell = grouped.sell.slice(0, opts.sellLimit == null ? grouped.sell.length : opts.sellLimit).map(stockBox);
  lines.push('');
  lines.push(bold('HOLD'));
  if (!hold.length) lines.push(dim(book && book.cards ? 'None in this group.' : 'Waiting for holdings.'));
  else lines.push(...place(hold, width));
  lines.push('');
  lines.push(bold('SELL'));
  lines.push(dim('Loss already worse than 10%.'));
  if (!sell.length) lines.push(dim('None in this group.'));
  else lines.push(...place(sell, width));

  const buys = newBuys(state);
  lines.push('');
  lines.push(bold('NEW BUY'));
  lines.push(dim('Latest price to the strategy target and stop. A closed day uses the last session. Points × lot. Not an order.'));
  if (!buys.length) lines.push(dim('No new buy right now.'));
  else lines.push(...place(buys, width));

  const signals = collectSignals(state);
  const signalRows = (opts.signalLimit ? signals.slice(-opts.signalLimit) : signals).map(signalLine);
  lines.push(...plainRows('Signals', signalRows, width));

  if (state && state.paperPlan) lines.push(...paperPlanLines(state.paperPlan, width));
  else {
    const trades = (state && state.paper && state.paper.trades) || [];
    const paperRows = (opts.paperLimit ? trades.slice(-opts.paperLimit) : trades).map(paperLine);
    lines.push(...plainRows('Paper trades', paperRows, width));
    if (state && state.paper && state.paper.total != null) lines.push(tone(state.paper.total, `Paper P&L ${money(state.paper.total)}`));
  }
  lines.push(...megaBullLines(state && state.megabull, width));

  lines.push(...geminiLines(opts.gemini, width));
  return lines;
}

function openTrade({ url, getState }) {
  const bag = { note: loadGeminiNote() };
  const handle = openTerminal({
    url,
    getState,
    render: (viewState, view) => renderTrade(viewState, { ...view, gemini: bag.note }),
  });
  const timer = setInterval(() => {
    bag.note = loadGeminiNote();
    if (handle) handle.draw();
  }, 30000);
  process.on('exit', () => clearInterval(timer));
  return handle;
}

module.exports = { renderTrade, openTrade, loadGeminiNote };
