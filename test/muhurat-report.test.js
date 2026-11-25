'use strict';

// Tests for tools/muhurat-report.js — the terminal version of the report.
// No network, no real ledger: synthetic day docs in the live shape.

const assert = require('node:assert');
const { test } = require('node:test');
const { renderReport, curvePoints } = require('../tools/muhurat-report');
const { computeHistoryStats } = require('../tools/muhurat-history-stats');

function dayDoc(date, trades) {
  return {
    date,
    updatedAt: `${date}T10:00:00.000Z`,
    investment: 0,
    realizedPnl: trades.filter((t) => t.status === 'CLOSED').reduce((s, t) => s + (t.pnl || 0), 0),
    openInvestment: 0,
    trades,
    byMode: { equity: {}, options: {} },
  };
}

function trade(ticker, mode, qty, entry, exit, exitReason, status = 'CLOSED') {
  const pnl = status === 'CLOSED' ? Math.round((exit - entry) * qty * 100) / 100 : 0;
  return {
    ticker, mode, key: `NSE_EQ|${ticker}`, qty, entry, exit,
    spend: Math.round(entry * qty * 100) / 100,
    pnl, exitReason, status,
    buyAt: '2026-11-17T04:00:00.000Z',
    sellAt: status === 'CLOSED' ? '2026-11-17T05:00:00.000Z' : null,
    right: null,
  };
}

const docs = [
  dayDoc('2026-11-17', [trade('NIFTY CE', 'options', 65, 100, 125, 'T2')]),
  dayDoc('2026-11-19', [trade('NIFTY PE', 'options', 65, 103.25, 97.25, 'SL-5%')]),
  dayDoc('2026-11-23', [
    trade('BANKNIFTY PE', 'options', 15, 444.2, 421.2, 'SL-M'),
    trade('COFORGE', 'equity', 7, 2141.1, null, null, 'OPEN'),
  ]),
];

test('curve points are cumulative net P&L in day order', () => {
  const pts = curvePoints(computeHistoryStats(docs).days);
  assert.strictEqual(pts.length, 3);
  assert.strictEqual(pts[0].date, '2026-11-17');
  // Day 1 net win is positive; each loss day pulls the curve down, but the
  // big day-1 win still leaves the synthetic run net positive overall.
  assert.ok(pts[0].value > 0);
  assert.ok(pts[1].value < pts[0].value);
  assert.ok(pts[2].value < pts[1].value);
  assert.ok(pts[2].value > 0);
  assert.strictEqual(pts[2].value, computeHistoryStats(docs).summary.netPnl);
});

test('terminal report shows the same headline numbers as the web report', () => {
  const text = renderReport(computeHistoryStats(docs), { noColor: true, width: 78 });
  const s = computeHistoryStats(docs).summary;
  assert.ok(text.includes('MUHURAT2'), 'title');
  assert.ok(text.includes('WINNING PROBABILITY'), 'tiles present');
  assert.ok(text.includes('PROFIT FACTOR'), 'tiles present');
  assert.ok(text.includes('DRAWDOWN'), 'tiles present');
  assert.ok(text.includes('P&L RATIO'), 'tiles present');
  assert.ok(text.includes(`${s.winRate}%`), `win rate ${s.winRate}% shown`);
  assert.ok(text.includes('1:2'), 'win:loss ratio 1:2 shown');
  assert.ok(text.includes('\u2588'), 'equity curve drawn');
  assert.ok(text.includes('NIFTY CE'), 'per-trade table present');
  assert.ok(text.includes('COFORGE'), 'open positions listed');
  assert.ok(text.includes('not counted in win rate'), 'open positions excluded note');
});

// --- Backtest + shareable HTML (2022 range) ---

const { splitRange, backtestResultToReport, renderHtmlReport, buildReport } = require('../tools/muhurat-report');

function stubDay(date, ticker, netPnl) {
  return {
    date,
    trades: [{ ticker, mode: 'equity', key: `NSE_EQ|${ticker}`, qty: 10, entry: 100, exit: 100 + netPnl / 10, spend: 1000, pnl: netPnl, charges: 0, netPnl, exitReason: 'T2', status: 'CLOSED' }],
    tradeCount: 1, wins: netPnl > 0 ? 1 : 0, losses: netPnl < 0 ? 1 : 0,
    grossPnl: netPnl, charges: 0, netPnl, investment: 1000,
  };
}

test('splitRange: inside the ledger → live only; before it → backtest + live', () => {
  const first = '2026-11-12';
  assert.deepStrictEqual(splitRange('2026-11-19', '2026-11-23', first), { live: ['2026-11-19', '2026-11-23'], backtest: null });
  assert.deepStrictEqual(splitRange('2022-11-19', '2026-11-23', first), { live: ['2026-11-12', '2026-11-23'], backtest: ['2022-11-19', '2026-11-11'] });
  assert.deepStrictEqual(splitRange('2022-01-01', '2022-12-31', first), { live: null, backtest: ['2022-01-01', '2022-12-31'] });
  assert.deepStrictEqual(splitRange('2022-11-19', '2026-11-23', null), { live: null, backtest: ['2022-11-19', '2026-11-23'] });
});

test('backtest section is labelled simulated and never mixes with live', () => {
  const bt = backtestResultToReport([stubDay('2023-01-02', 'SBIN', 500), stubDay('2023-01-03', 'SBIN', -200)]);
  assert.strictEqual(bt.summary.trades, 2);
  assert.strictEqual(bt.summary.winRate, 50);
  const text = renderReport(bt, { noColor: true, width: 78, mode: 'backtest' });
  assert.ok(text.includes('SIMULATED'), 'backtest label');
  assert.ok(text.includes('Stocks lane only'), 'fidelity note');
  assert.ok(text.includes('NOT backtested'), 'options lane excluded note');
  assert.ok(!text.includes('LIVE PERFORMANCE'), 'no live label on a backtest');
});

test('buildReport merges live + stub backtest, and survives a backtest failure', async () => {
  const stub = async () => ({ dayResults: [stubDay('2023-01-02', 'SBIN', 500)] });
  const ok = await buildReport({
    liveDocs: docs, ledgerFirst: '2026-11-12',
    from: '2022-11-19', to: '2026-11-23', backtest: null,
    runBacktest: stub, budget: 15000, confirmSec: 60, maxTrades: 5, noFetch: false, log: () => {},
  });
  assert.strictEqual(ok.sections.length, 2);
  assert.strictEqual(ok.sections[0].mode, 'live');
  assert.strictEqual(ok.sections[1].mode, 'backtest');
  assert.strictEqual(ok.backtestSkipped, null);

  const failing = async () => { throw new Error('Set UPSTOX_ACCESS_TOKEN in .env'); };
  const partial = await buildReport({
    liveDocs: docs, ledgerFirst: '2026-11-12',
    from: '2022-11-19', to: '2026-11-23', backtest: null,
    runBacktest: failing, budget: 15000, confirmSec: 60, maxTrades: 5, noFetch: false, log: () => {},
  });
  assert.strictEqual(partial.sections.length, 1, 'live part still returned');
  assert.strictEqual(partial.sections[0].mode, 'live');
  assert.ok(partial.backtestSkipped.includes('UPSTOX_ACCESS_TOKEN'), 'token error reported, not hidden');
});

test('HTML report embeds the numbers, tiles and curve', () => {
  const live = computeHistoryStats(docs);
  const bt = backtestResultToReport([stubDay('2023-01-02', 'SBIN', 500)]);
  const html = renderHtmlReport(
    [{ mode: 'live', result: live }, { mode: 'backtest', result: bt }],
    { from: '2022-11-19', to: '2026-11-23' },
  );
  assert.ok(html.includes('Muhurat2 — Performance Report'), 'title');
  assert.ok(html.includes('WINNING PROBABILITY'), 'tiles');
  assert.ok(html.includes('<svg'), 'curve');
  assert.ok(html.includes('Live performance'), 'live section');
  assert.ok(html.includes('Stocks backtest (simulated)'), 'backtest section');
  assert.ok(html.includes('NIFTY CE'), 'live trades listed');
  assert.ok(html.includes('SBIN'), 'backtest trades listed');
});
