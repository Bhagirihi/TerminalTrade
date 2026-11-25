'use strict';

// Muhurat2 performance report, for the terminal — the same numbers as the web
// report page (equity curve + stat tiles), rendered as text.
//   node tools/muhurat-report.js
//   node tools/muhurat-report.js --from 2026-11-17 --to 2026-11-25
//   node tools/muhurat-report.js --dir paper/muhurat-history/days --no-color
//
// Reads the live ledger day files (paper/muhurat-history/days/*.json).
// All P&L is NET of Upstox charges. Read-only: places no orders.

const fs = require('fs');
const path = require('path');
const { computeHistoryStats } = require('./muhurat-history-stats');

const DEFAULT_DIR = path.join(__dirname, '..', 'paper', 'muhurat-history', 'days');

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

function parseArgs(argv) {
  const out = { dir: DEFAULT_DIR, from: null, to: null, noColor: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[i + 1];
    else if (a === '--from') out.from = argv[i + 1];
    else if (a === '--to') out.to = argv[i + 1];
    else if (a === '--no-color') out.noColor = true;
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
  const top = tiles.map(() => '+' + '-'.repeat(w - 2) + '+').join(' ');
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

function renderReport(result, opts) {
  const s = result.summary;
  const useColor = !opts.noColor;
  const w = opts.width || 78;
  const out = [];
  const hr = '='.repeat(w);
  const range = result.days.length
    ? `${result.days[0].date} to ${result.days[result.days.length - 1].date}`
    : 'no days';
  out.push(hr);
  out.push(colorize('MUHURAT2 — LIVE PERFORMANCE REPORT', BOLD, useColor));
  out.push(`Range: ${range}  |  Closed trades: ${s.trades}  |  Days with trades: ${s.days}`);
  out.push(`Net P&L: ${colorize(fmtRs2(s.netPnl), s.netPnl >= 0 ? GREEN : RED, useColor)}  (gross ${fmtRs2(s.grossPnl)}, charges ${fmtRs2(s.charges)})`);
  out.push(hr);
  out.push('');
  out.push(colorize('EQUITY CURVE — cumulative net P&L', BOLD, useColor));
  out.push(renderCurve(curvePoints(result.days), Math.min(64, w - 14), 12, useColor));
  const st = streaks(result.days);
  const ex = extremes(result.days);
  const tiles = [
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
  out.push(renderTiles(tiles, 3, 25, useColor));
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
  if (result.openPositions.length) {
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
  out.push(`Only ${s.trades} closed trades — a snapshot, not a verdict on the strategy.`);
  return out.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.dir)) {
    console.error(`No history dir: ${args.dir}`);
    process.exit(1);
  }
  const files = fs.readdirSync(args.dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  const docs = [];
  for (const f of files) {
    const date = f.slice(0, 10);
    if (args.from && date < args.from) continue;
    if (args.to && date > args.to) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(args.dir, f), 'utf8'));
      docs.push(parsed.day || parsed);
    } catch (e) {
      console.error(`Skipping unreadable ${f}: ${e.message}`);
    }
  }
  if (!docs.length) {
    console.log('No history days in range.');
    return;
  }
  const width = process.stdout.columns && process.stdout.columns < 100
    ? process.stdout.columns
    : 78;
  console.log(renderReport(computeHistoryStats(docs), { ...args, width }));
}

if (require.main === module) main();

module.exports = { renderReport, curvePoints, renderCurve, streaks, extremes, parseArgs };
