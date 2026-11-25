'use strict';

// Muhurat2 performance report, for the terminal — the same numbers as the web
// report page (equity curve + stat tiles), rendered as text.
//   node tools/muhurat-report.js
//   node tools/muhurat-report.js --from 2026-11-19 --to 2026-11-23
//   node tools/muhurat-report.js --from 2022-11-19 --to 2026-11-23
//   node tools/muhurat-report.js --dir paper/muhurat-history/days --no-color
//   node tools/muhurat-report.js --no-html   # terminal only, no file
//   node tools/muhurat-report.js --prefetch --from 2022-11-19 --to 2026-11-23
//     # download + cache all candles the backtest part needs, no report yet
//     # (run right after login; the report itself then fetches nothing)
//
// What a range means:
// - Dates the live ledger covers (bot live since 2026-11-12) come from the
//   ledger itself: real trades, real fills, net of Upstox charges.
// - Dates BEFORE the ledger starts are backtested (stocks lane only): the
//   same scoring/sizing/trail/exit rules replayed on Upstox 1m candles.
//   Needs a fresh UPSTOX_ACCESS_TOKEN (morning login); without it the
//   backtest part is skipped with a note and the live part still prints.
//   The options lane is never backtested (no historical option premiums).
// - By default the report is ALSO written as a standalone HTML file
//   (muhurat-report-<from>_<to>.html) you can open or send to anyone.
//   Use --no-html for terminal-only output, --html <path> for a custom file.
//
// Read-only for the ledger; the backtest only reads market data. No orders.

const fs = require('fs');
const path = require('path');
const { computeHistoryStats } = require('./muhurat-history-stats');
const { summarizeDays } = require('../src/muhurat-backtest');
const { runStocksBacktest, fetchStocksData, shiftDays } = require('./muhurat-backtest-stocks');

const DEFAULT_DIR = path.join(__dirname, '..', 'paper', 'muhurat-history', 'days');

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

function parseArgs(argv) {
  const out = {
    dir: DEFAULT_DIR, from: null, to: null, noColor: false,
    html: true, htmlPath: null, backtest: null, noFetch: false, prefetch: false,
    budget: 15000, confirmSec: 60, maxTrades: 5,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    const hasValue = next != null && !next.startsWith('--');
    if (a === '--dir' && hasValue) out.dir = next;
    else if (a === '--from' && hasValue) out.from = next;
    else if (a === '--to' && hasValue) out.to = next;
    else if (a === '--no-color') out.noColor = true;
    else if (a === '--no-html') out.html = false;
    else if (a === '--html') { out.html = true; if (hasValue) out.htmlPath = next; }
    else if (a === '--backtest') out.backtest = true;
    else if (a === '--no-backtest') out.backtest = false;
    else if (a === '--no-fetch') out.noFetch = true;
    else if (a === '--prefetch') out.prefetch = true;
    else if (a === '--budget' && hasValue) out.budget = Number(next) || 15000;
    else if (a === '--confirm-sec' && hasValue) out.confirmSec = Number(next) || 60;
    else if (a === '--max-trades' && hasValue) out.maxTrades = Number(next) || 5;
  }
  if (process.env.NO_COLOR) out.noColor = true;
  return out;
}

function fmtRs(n) {
  if (n == null || !Number.isFinite(n)) return '-';
  const sign = n < 0 ? '-' : '';
  return `${sign}\u20B9${Math.abs(n).toLocaleString('en-IN')}`;
}

function fmtRs2(n) {
  if (n == null || !Number.isFinite(n)) return '-';
  const sign = n < 0 ? '-' : '';
  return `${sign}\u20B9${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function colorize(text, color, enabled) {
  return enabled ? color + text + RESET : text;
}

/** Cumulative net P&L per day (closed trades only), in day order. */
function curvePoints(days) {
  let cum = 0;
  return days.map((d) => {
    cum = Math.round((cum + d.netPnl) * 100) / 100;
    return { date: d.date, value: cum };
  });
}

/**
 * ASCII area chart of the cumulative curve. Width/height fixed so the output
 * is stable when piped. The zero line is drawn; points above it are green,
 * below it red (unless colours are off).
 */
function renderCurve(points, width, height, useColor) {
  if (!points.length) return '  (no data)\n';
  const values = points.map((p) => p.value);
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) { min -= 1; max += 1; }
  const pad = 0.08 * (max - min);
  min -= pad;
  max += pad;
  const zeroRow = Math.round(((max - 0) / (max - min)) * (height - 1));
  const valueAt = (col) => {
    const t = (col / (width - 1)) * (points.length - 1);
    const i = Math.min(points.length - 2, Math.floor(t));
    const frac = t - i;
    return points[i].value + (points[i + 1].value - points[i].value) * frac;
  };
  const rowOf = (v) => Math.round(((max - v) / (max - min)) * (height - 1));
  const yLabel = (row) => {
    const v = max - (row / (height - 1)) * (max - min);
    return fmtRs(Math.round(v)).padStart(10);
  };
  const lines = [];
  for (let row = 0; row < height; row += 1) {
    let line = '';
    for (let col = 0; col < width; col += 1) {
      const v = valueAt(col);
      const r = rowOf(v);
      if (r === row) line += colorize('\u2588', v >= 0 ? GREEN : RED, useColor);
      else if (row > r && row <= zeroRow && v >= 0) line += colorize('\u2591', GREEN, useColor);
      else if (row < r && row >= zeroRow && v < 0) line += colorize('\u2591', RED, useColor);
      else if (row === zeroRow) line += colorize('\u2500', DIM, useColor);
      else line += ' ';
    }
    lines.push(`${yLabel(row)} \u2502${line}`);
  }
  const first = points[0].date.slice(5);
  const last = points[points.length - 1].date.slice(5);
  const axis = ' '.repeat(11) + '\u2514' + '\u2500'.repeat(width);
  const dates = ' '.repeat(11) + ' ' + first + ' '.repeat(Math.max(1, width - first.length - last.length - 1)) + last;
  return lines.join('\n') + '\n' + axis + '\n' + dates + '\n';
}

function streaks(days) {
  let win = 0;
  let loss = 0;
  let curWin = 0;
  let curLoss = 0;
  for (const d of days) {
    for (const t of d.trades) {
      if (t.netPnl > 0) { curWin += 1; curLoss = 0; win = Math.max(win, curWin); }
      else if (t.netPnl < 0) { curLoss += 1; curWin = 0; loss = Math.max(loss, curLoss); }
    }
  }
  return { win, loss };
}

function extremes(days) {
  let best = null;
  let worst = null;
  for (const d of days) {
    for (const t of d.trades) {
      if (!best || t.netPnl > best.netPnl) best = { ...t, date: d.date };
      if (!worst || t.netPnl < worst.netPnl) worst = { ...t, date: d.date };
    }
  }
  return { best, worst };
}

/** One row of stat tiles, each `w` chars wide, with a border. */
function renderTiles(tiles, cols, w, useColor) {
  const lines = [];
  for (let r = 0; r < tiles.length; r += cols) {
    const row = tiles.slice(r, r + cols);
    const border = row.map(() => '+' + '-'.repeat(w - 2) + '+').join(' ');
    const labelLine = row.map((t) => '| ' + t.label.padEnd(w - 3) + '|').join(' ');
    const valueLine = row.map((t) => {
      const v = t.value.length > w - 3 ? t.value.slice(0, w - 3) : t.value;
      const colored = t.tone ? colorize(v, t.tone === 'green' ? GREEN : RED, useColor) : v;
      const pad = ' '.repeat(Math.max(0, w - 3 - v.length));
      return '| ' + colored + pad + '|';
    }).join(' ');
    const subLine = row.map((t) => '| ' + (t.sub || '').padEnd(w - 3).slice(0, w - 3) + '|').join(' ');
    lines.push(border, labelLine, valueLine, subLine, border);
  }
  return lines.join('\n') + '\n';
}

function tilesFor(result) {
  const s = result.summary;
  const st = streaks(result.days);
  const ex = extremes(result.days);
  return [
    { label: 'WINNING PROBABILITY', value: s.winRate == null ? '-' : `${s.winRate}%`, sub: `Wins ${s.wins} / Losses ${s.losses}`, tone: s.winRate != null && s.winRate >= 50 ? 'green' : 'red' },
    { label: 'WIN LOSS RATIO', value: s.wins === 0 && s.losses === 0 ? '-' : `${s.wins}:${s.losses}`, sub: 'closed trades' },
    { label: 'RISK PER TRADE', value: '5.0%', sub: 'options SL' },
    { label: 'DRAWDOWN', value: fmtRs2(s.maxDrawdown), sub: 'peak-to-trough, net', tone: 'red' },
    { label: 'AVG PROFIT', value: fmtRs2(s.avgWinNet), sub: 'per winning trade', tone: 'green' },
    { label: 'AVG LOSS', value: fmtRs2(s.avgLossNet), sub: 'per losing trade', tone: 'red' },
    { label: 'WIN STREAK', value: String(st.win), sub: 'max consecutive wins' },
    { label: 'LOSS STREAK', value: String(st.loss), sub: 'max consecutive losses' },
    { label: 'MAX PROFIT', value: ex.best ? fmtRs2(ex.best.netPnl) : '-', sub: ex.best ? `${ex.best.ticker}` : '', tone: 'green' },
    { label: 'MAX LOSS', value: ex.worst ? fmtRs2(ex.worst.netPnl) : '-', sub: ex.worst ? `${ex.worst.ticker}` : '', tone: 'red' },
    { label: 'PROFIT FACTOR', value: s.profitFactorNet == null ? '-' : s.profitFactorNet.toFixed(2), sub: `gross ${s.profitFactorGross == null ? '-' : s.profitFactorGross.toFixed(2)}` },
    { label: 'P&L RATIO', value: s.riskRewardNet == null ? '-' : `${s.riskRewardNet.toFixed(2)}x`, sub: 'avg win / avg loss' },
  ];
}

function renderReport(result, opts) {
  const s = result.summary;
  const useColor = !opts.noColor;
  const w = opts.width || 78;
  const mode = opts.mode || 'live';
  const out = [];
  const hr = '='.repeat(w);
  const range = result.days.length
    ? `${result.days[0].date} to ${result.days[result.days.length - 1].date}`
    : 'no days';
  out.push(hr);
  out.push(colorize(mode === 'backtest' ? 'MUHURAT2 — STOCKS BACKTEST (SIMULATED)' : 'MUHURAT2 — LIVE PERFORMANCE REPORT', BOLD, useColor));
  out.push(`Range: ${range}  |  Closed trades: ${s.trades}  |  Days with trades: ${s.days}`);
  out.push(`Net P&L: ${colorize(fmtRs2(s.netPnl), s.netPnl >= 0 ? GREEN : RED, useColor)}  (gross ${fmtRs2(s.grossPnl)}, charges ${fmtRs2(s.charges)})`);
  if (mode === 'backtest') {
    out.push('Stocks lane only — fixed 33 names, no NSE gainers (live-only endpoint).');
    out.push('Simulated fills at 1m bar close, exits at crossed levels; sizing on the');
    out.push('lane budget only (live C1 bug neutralised — live will be worse until fixed).');
    out.push('Loss gate disabled. Options lane is NOT backtested (no option premiums).');
  }
  out.push(hr);
  out.push('');
  out.push(colorize('EQUITY CURVE — cumulative net P&L', BOLD, useColor));
  out.push(renderCurve(curvePoints(result.days), Math.min(64, w - 14), 12, useColor));
  out.push(renderTiles(tilesFor(result), 3, 25, useColor));
  out.push(colorize('PER DAY (net)', BOLD, useColor));
  out.push('  date        trades  W/L    net          charges');
  for (const d of result.days) {
    if (!d.tradeCount && d.netPnl === 0) continue;
    out.push(`  ${d.date}  ${String(d.tradeCount).padEnd(6)}  ${d.wins}/${d.losses}    ${fmtRs2(d.netPnl).padStart(12)}  ${fmtRs2(d.charges).padStart(10)}`);
  }
  out.push('');
  out.push(colorize('CLOSED TRADES', BOLD, useColor));
  out.push('  date        trade                 qty  entry -> exit    gross        charges     net      exit');
  for (const d of result.days) {
    for (const t of d.trades) {
      out.push(`  ${d.date}  ${t.ticker.padEnd(20)}  ${String(t.qty).padEnd(3)}  ${String(t.entry).padEnd(7)}-> ${String(t.exit).padEnd(8)} ${fmtRs2(t.pnl).padStart(10)} ${fmtRs2(t.charges).padStart(10)} ${fmtRs2(t.netPnl).padStart(10)}  ${t.exitReason || ''}`);
    }
  }
  if (result.openPositions && result.openPositions.length) {
    out.push('');
    out.push(colorize('STILL OPEN (not counted in win rate)', BOLD, useColor));
    for (const p of result.openPositions) {
      out.push(`  ${p.date}  ${p.ticker} (${p.mode}) x${p.qty} @ ${fmtRs(p.entry)}  invested ${fmtRs(p.spend)}`);
    }
  }
  out.push('');
  out.push(`  equity: ${result.byMode.equity.trades} trades, win rate ${result.byMode.equity.winRate == null ? '-' : `${result.byMode.equity.winRate}%`}, net ${fmtRs2(result.byMode.equity.netPnl)}`);
  out.push(`  options: ${result.byMode.options.trades} trades, win rate ${result.byMode.options.winRate == null ? '-' : `${result.byMode.options.winRate}%`}, net ${fmtRs2(result.byMode.options.netPnl)}`);
  out.push('');
  out.push(`Expectancy/trade (net): ${s.expectancyNet == null ? '-' : fmtRs2(s.expectancyNet)}   |   Ledger pnl is gross of charges; every figure above is net.`);
  if (mode === 'live') out.push(`Only ${s.trades} closed trades — a snapshot, not a verdict on the strategy.`);
  return out.join('\n');
}

/**
 * Split a requested [from, to] range into the part the live ledger covers
 * and the part before the ledger starts (which must be backtested).
 * ledgerFirst is the earliest date the ledger has, or null when it is empty.
 * Returns { live: [from, to] | null, backtest: [from, to] | null }.
 */
function splitRange(from, to, ledgerFirst) {
  if (!from || !to) return { live: from && to ? [from, to] : null, backtest: null };
  if (!ledgerFirst) return { live: null, backtest: [from, to] };
  const backtest = from < ledgerFirst
    ? [from, to < ledgerFirst ? to : shiftDays(ledgerFirst, -1)]
    : null;
  const live = to >= ledgerFirst
    ? [from < ledgerFirst ? ledgerFirst : from, to]
    : null;
  return { live, backtest };
}

/** Shape backtest dayResults into the same result object the live stats use. */
function backtestResultToReport(dayResults) {
  const days = [...dayResults].sort((a, b) => (a.date < b.date ? -1 : 1));
  const summary = summarizeDays(days);
  const byMode = {};
  for (const mode of ['equity', 'options']) {
    byMode[mode] = summarizeDays(days.map((d) => ({
      ...d,
      trades: d.trades.filter((t) => t.mode === mode),
    })));
  }
  return { days, summary, byMode, openPositions: [] };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function svgCurve(points, width, height) {
  if (!points.length) return '<p>No data.</p>';
  const values = points.map((p) => p.value);
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) { min -= 1; max += 1; }
  const pad = 0.08 * (max - min);
  min -= pad;
  max += pad;
  const x = (i) => (i / Math.max(1, points.length - 1)) * width;
  const y = (v) => ((max - v) / (max - min)) * height;
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `0,${y(0).toFixed(1)} ${line} ${width},${y(0).toFixed(1)}`;
  const fmt = (v) => `₹${Math.round(v).toLocaleString('en-IN')}`;
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Equity curve">
    <line x1="0" y1="${y(0).toFixed(1)}" x2="${width}" y2="${y(0).toFixed(1)}" stroke="#94a3b8" stroke-width="1"/>
    <polygon points="${area}" fill="#22c55e" fill-opacity="0.18"/>
    <polyline points="${line}" fill="none" stroke="#16a34a" stroke-width="2.5"/>
    <text x="4" y="14" font-size="11" fill="#64748b">${esc(fmt(max - pad))}</text>
    <text x="4" y="${(height - 6).toFixed(0)}" font-size="11" fill="#64748b">${esc(fmt(min + pad))}</text>
    <text x="4" y="${(y(0) - 4).toFixed(1)}" font-size="11" fill="#64748b">₹0</text>
  </svg>
  <div class="axis"><span>${esc(points[0].date)}</span><span>${esc(points[points.length - 1].date)}</span></div>`;
}

function sectionHtml(result, mode) {
  const s = result.summary;
  const tiles = tilesFor(result);
  const tileHtml = tiles.map((t) => {
    const cls = t.tone === 'green' ? 'good' : t.tone === 'red' ? 'bad' : '';
    return `<div class="tile"><div class="tlabel">${esc(t.label)}</div><div class="tvalue ${cls}">${esc(t.value)}</div><div class="tsub">${esc(t.sub || '')}</div></div>`;
  }).join('\n');
  const dayRows = result.days.filter((d) => d.tradeCount || d.netPnl !== 0).map((d) => (
    `<tr><td>${esc(d.date)}</td><td>${d.tradeCount}</td><td>${d.wins}/${d.losses}</td><td class="${d.netPnl >= 0 ? 'good' : 'bad'}">${esc(fmtRs2(d.netPnl))}</td><td>${esc(fmtRs2(d.charges))}</td></tr>`
  )).join('\n');
  const tradeRows = result.days.flatMap((d) => d.trades.map((t) => (
    `<tr><td>${esc(d.date)}</td><td>${esc(t.ticker)}</td><td>${esc(t.mode)}</td><td>${t.qty}</td><td>${esc(t.entry)} → ${esc(t.exit)}</td><td>${esc(fmtRs2(t.pnl))}</td><td>${esc(fmtRs2(t.charges))}</td><td class="${t.netPnl >= 0 ? 'good' : 'bad'}">${esc(fmtRs2(t.netPnl))}</td><td>${esc(t.exitReason || '')}</td></tr>`
  ))).join('\n');
  const openRows = (result.openPositions || []).map((p) => (
    `<tr><td>${esc(p.date)}</td><td>${esc(p.ticker)}</td><td>${esc(p.mode)}</td><td>${p.qty}</td><td>${esc(fmtRs(p.entry))}</td><td>${esc(fmtRs(p.spend))}</td></tr>`
  )).join('\n');
  const notes = mode === 'backtest'
    ? `<p class="note">Simulated — stocks lane only (fixed 33 names, no NSE gainers). Fills at 1m bar close, exits at crossed levels; sizing on the lane budget only (live C1 bug neutralised); loss gate disabled. Options lane is not backtested. All figures net of Upstox intraday charges.</p>`
    : `<p class="note">Live ledger — real trades, real fills, net of Upstox charges. Open positions are not counted in the win rate. Only ${s.trades} closed trades — a snapshot, not a verdict on the strategy.</p>`;
  return `<section>
  <h2>${mode === 'backtest' ? 'Stocks backtest (simulated)' : 'Live performance'}</h2>
  <p class="headline">Net P&amp;L <strong class="${s.netPnl >= 0 ? 'good' : 'bad'}">${esc(fmtRs2(s.netPnl))}</strong> &nbsp;·&nbsp; gross ${esc(fmtRs2(s.grossPnl))} &nbsp;·&nbsp; charges ${esc(fmtRs2(s.charges))} &nbsp;·&nbsp; ${s.trades} closed trades</p>
  ${notes}
  <div class="chart">${svgCurve(curvePoints(result.days), 760, 260)}</div>
  <div class="tiles">${tileHtml}</div>
  <h3>Per day (net)</h3>
  <table><tr><th>Date</th><th>Trades</th><th>W/L</th><th>Net</th><th>Charges</th></tr>${dayRows}</table>
  <h3>Closed trades</h3>
  <table><tr><th>Date</th><th>Trade</th><th>Mode</th><th>Qty</th><th>Entry → Exit</th><th>Gross</th><th>Charges</th><th>Net</th><th>Exit</th></tr>${tradeRows}</table>
  ${openRows ? `<h3>Still open</h3><table><tr><th>Date</th><th>Trade</th><th>Mode</th><th>Qty</th><th>Entry</th><th>Invested</th></tr>${openRows}</table>` : ''}
  <p class="note">Equity: ${result.byMode.equity.trades} trades, win rate ${result.byMode.equity.winRate == null ? '—' : `${result.byMode.equity.winRate}%`}, net ${esc(fmtRs2(result.byMode.equity.netPnl))} &nbsp;·&nbsp; Options: ${result.byMode.options.trades} trades, win rate ${result.byMode.options.winRate == null ? '—' : `${result.byMode.options.winRate}%`}, net ${esc(fmtRs2(result.byMode.options.netPnl))} &nbsp;·&nbsp; Expectancy/trade (net): ${s.expectancyNet == null ? '—' : esc(fmtRs2(s.expectancyNet))}</p>
</section>`;
}

/** Standalone HTML report (same numbers as the terminal output). */
function renderHtmlReport(sections, { from, to }) {
  const body = sections.map((sec) => sectionHtml(sec.result, sec.mode)).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Muhurat2 Performance Report — ${esc(from || '')} to ${esc(to || '')}</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#f1f5f9;color:#0f172a}
main{max-width:980px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:19px;margin:28px 0 8px}h3{font-size:15px;margin:22px 0 8px}
.sub{color:#64748b;font-size:13px;margin:0 0 16px}.headline{font-size:16px}
.good{color:#16a34a}.bad{color:#dc2626}
.chart{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px}
.axis{display:flex;justify-content:space-between;color:#64748b;font-size:12px;margin-top:4px}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0}
.tile{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px}
.tlabel{font-size:11px;letter-spacing:.06em;color:#64748b;text-transform:uppercase}
.tvalue{font-size:22px;font-weight:700;margin:4px 0}.tsub{font-size:12px;color:#64748b}
table{width:100%;border-collapse:collapse;background:#fff;font-size:13px}
th,td{border:1px solid #e2e8f0;padding:6px 8px;text-align:left}
th{background:#f8fafc}.note{color:#64748b;font-size:13px}
section{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:18px 20px;margin-top:18px}
@media(max-width:640px){.tiles{grid-template-columns:repeat(2,1fr)}}
</style></head><body><main>
<h1>Muhurat2 — Performance Report</h1>
<p class="sub">${esc(from || '')} to ${esc(to || '')} · generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC · net of Upstox charges</p>
${body}
</main></body></html>`;
}

/**
 * Build the report sections for a range. `runBacktest` is injectable so
 * tests can stub the network-backed replay; main() passes the real runner.
 * Returns { sections, backtestSkipped }.
 */
async function buildReport({ liveDocs, ledgerFirst, from, to, backtest, runBacktest, budget, confirmSec, maxTrades, noFetch, log }) {
  const parts = splitRange(from, to, ledgerFirst);
  const sections = [];
  let backtestSkipped = null;
  if (parts.live) {
    const docs = liveDocs.filter((d) => d.date >= parts.live[0] && d.date <= parts.live[1]);
    if (docs.length) sections.push({ mode: 'live', result: computeHistoryStats(docs) });
  }
  const wantBacktest = backtest === true || (backtest == null && parts.backtest);
  if (wantBacktest && parts.backtest) {
    try {
      log(`Backtesting ${parts.backtest[0]} → ${parts.backtest[1]} (stocks lane) — fetching candles, this takes a few minutes for multi-year ranges…`);
      const bt = await runBacktest({
        from: parts.backtest[0], to: parts.backtest[1],
        budget, confirmSec, maxTrades, noFetch, years: 1,
      }, () => {});
      sections.push({ mode: 'backtest', result: backtestResultToReport(bt.dayResults) });
    } catch (e) {
      backtestSkipped = e.message;
    }
  }
  return { sections, backtestSkipped };
}

function loadLedgerDocs(dir, from, to) {
  if (!fs.existsSync(dir)) return { all: [], inRange: [] };
  const files = fs.readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  const all = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      all.push(parsed.day || parsed);
    } catch (e) {
      console.error(`Skipping unreadable ${f}: ${e.message}`);
    }
  }
  all.sort((a, b) => (a.date < b.date ? -1 : 1));
  const inRange = all.filter((d) => (!from || d.date >= from) && (!to || d.date <= to));
  return { all, inRange };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { all, inRange } = loadLedgerDocs(args.dir, args.from, args.to);
  const ledgerFirst = all.length ? all[0].date : null;
  const from = args.from || ledgerFirst || new Date().toISOString().slice(0, 10);
  const to = args.to || new Date().toISOString().slice(0, 10);
  if (args.prefetch) {
    const parts = splitRange(from, to, ledgerFirst);
    if (!parts.backtest) {
      console.log('Nothing to prefetch — the whole range is covered by the live ledger already on disk.');
      return;
    }
    console.log(`Prefetching candles for the backtest part ${parts.backtest[0]} → ${parts.backtest[1]} (stocks lane)…`);
    let prefetched;
    try {
      prefetched = await fetchStocksData({
        from: parts.backtest[0], to: parts.backtest[1],
        budget: args.budget, confirmSec: args.confirmSec, maxTrades: args.maxTrades,
        noFetch: args.noFetch, years: 1,
      }, console.log);
    } catch (err) {
      console.error(`Prefetch failed: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    const { tradingDays, fetched, cacheHits } = prefetched;
    console.log(`\nPrefetched ${parts.backtest[0]} → ${parts.backtest[1]}: ${tradingDays.length} trading days.`);
    console.log(`  Fetched: ${fetched.daily} daily series, ${fetched.minuteMonths} symbol-months of 1m bars.`);
    console.log(`  Cache hits: ${cacheHits.daily} daily series, ${cacheHits.minuteMonths} symbol-months.`);
    console.log('Cache: cache/muhurat-backtest/ — the report command now fetches nothing for this range.');
    return;
  }
  const { sections, backtestSkipped } = await buildReport({
    liveDocs: inRange, ledgerFirst, from, to,
    backtest: args.backtest, runBacktest: runStocksBacktest,
    budget: args.budget, confirmSec: args.confirmSec, maxTrades: args.maxTrades,
    noFetch: args.noFetch, log: console.log,
  });
  if (!sections.length) {
    console.log('No history days in range, and no backtest ran.');
    if (backtestSkipped) console.log(`Backtest skipped: ${backtestSkipped}`);
    return;
  }
  const width = process.stdout.columns && process.stdout.columns < 100
    ? process.stdout.columns
    : 78;
  for (const sec of sections) {
    console.log(renderReport(sec.result, { ...args, width, mode: sec.mode }));
    console.log('');
  }
  if (backtestSkipped) {
    console.log(`Backtest skipped: ${backtestSkipped}`);
    console.log('Run it after the morning login (fresh UPSTOX_ACCESS_TOKEN on the server).');
  }
  if (args.html) {
    const file = args.htmlPath || path.join(process.cwd(), `muhurat-report-${from}_${to}.html`);
    fs.writeFileSync(file, renderHtmlReport(sections, { from, to }));
    console.log(`\nShareable report written: ${file}`);
    console.log('Open it in a browser or send the file to anyone — it is self-contained.');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  renderReport, curvePoints, renderCurve, streaks, extremes, parseArgs,
  splitRange, backtestResultToReport, renderHtmlReport, buildReport, loadLedgerDocs,
};
