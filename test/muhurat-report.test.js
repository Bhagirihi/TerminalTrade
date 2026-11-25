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
