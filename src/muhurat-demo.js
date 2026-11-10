'use strict';

// Dummy Muhurat book + bot snapshot for terminal demos (no Upstox / no orders).

const { SESSION, DEFAULT_BUDGET } = require('./muhurat');

function levels(entry, slPct = 0.009, t1Pct = 0.005, t2Pct = 0.014) {
  const stop = Math.round((entry * (1 - slPct)) / 0.05) * 0.05;
  const t1 = Math.round((entry * (1 + t1Pct)) / 0.05) * 0.05;
  const t2 = Math.round((entry * (1 + t2Pct)) / 0.05) * 0.05;
  const trailCost = entry;
  const trailLock03 = Math.round((entry * 1.003) / 0.05) * 0.05;
  return {
    support: Math.round((entry * 0.985) / 0.05) * 0.05,
    resistance: Math.round((entry * 1.012) / 0.05) * 0.05,
    resistanceNext: Math.round((entry * 1.022) / 0.05) * 0.05,
    stopLoss: stop,
    target1: t1,
    target2: t2,
    trailCost,
    trailLock03,
    trailLabel: 'initial SL',
  };
}

function row(partial) {
  const entry = partial.ltp;
  const lv = levels(entry, partial.slPct, partial.t1Pct, partial.t2Pct);
  return {
    ticker: partial.ticker,
    key: `DEMO|${partial.ticker}`,
    core: Boolean(partial.core),
    sleeve: partial.sleeve || '',
    verdict: partial.verdict,
    buy: partial.buy,
    action: partial.action,
    score: partial.score,
    profitScore: partial.profitScore,
    ltp: entry,
    entry,
    rsi: partial.rsi,
    distSma: partial.distSma,
    openPx: partial.openPx != null ? partial.openPx : entry * 0.998,
    aboveOpen: true,
    qty: partial.qty || 0,
    spend: partial.spend || 0,
    expectedT1: partial.expectedT1 || 0,
    reward1Pct: partial.reward1Pct != null ? partial.reward1Pct : 0.5,
    rr: partial.rr != null ? partial.rr : 0.55,
    sellStop: lv.stopLoss,
    sellT1: lv.target1,
    sellT2: lv.target2,
    levels: lv,
    live: Boolean(partial.live),
  };
}

function demoChecks() {
  return {
    ok: true,
    ms: 12,
    at: '2026-11-08 14:35 IST',
    checks: [
      { id: 'UPSTOX_TOKEN', status: 'pass', detail: 'DEMO — fake token ok' },
      { id: 'BUDGET', status: 'pass', detail: `MUHURAT_BUDGET = ₹${DEFAULT_BUDGET.toLocaleString('en-IN')} + available margin` },
      { id: 'SESSION', status: 'pass', detail: SESSION.label },
      { id: 'CLOCK', status: 'pass', detail: 'DEMO Live window · 14:35 IST · BUY decisions on' },
      { id: 'LIVE_ORDERS', status: 'pass', detail: 'DEMO FULL AUTO (fake — no real Upstox orders)' },
      { id: 'TRAIL', status: 'pass', detail: 'Trail: @T1→cost · @+0.6%→+0.3% · hard exit 3:15' },
      { id: 'PICKS', status: 'pass', detail: 'Live picks = BUY + Watch P>12 · stock max 5/day · options max 2/day' },
      { id: 'NO_TRADE_LOSS', status: 'pass', detail: 'If book loss ≥ −18% (near 20%) → DO NOT TRADE' },
      { id: 'RULES', status: 'pass', detail: 'DEMO: scan → max-profit buys → SL/trail/target → sell' },
      { id: 'UPSTOX_PORTFOLIO', status: 'pass', detail: 'Holdings 27 · Invest ₹4,00,876.34 · Loss ₹39,767.30 (−9.92%)' },
      { id: 'BOOK_LOSS', status: 'pass', detail: 'Book P&L −9.92% · block new trades at −18% (near 20%)' },
      { id: 'UPSTOX_LTP', status: 'pass', detail: 'DEMO LTP feed ok' },
      { id: 'UPSTOX_CANDLES', status: 'pass', detail: 'DEMO candles ok' },
      { id: 'UPSTOX_FEED', status: 'pass', detail: 'DEMO market feed live' },
    ],
    failed: [],
    warned: [],
  };
}

function buildLiveBuyBook() {
  const hindalco = row({
    ticker: 'HINDALCO', core: true, sleeve: 'Metals', verdict: 'BUY', buy: 'YES', action: 'BUY NOW',
    score: 14, profitScore: 20.01, ltp: 958.4, rsi: 67.4, distSma: 0.84,
    qty: 6, spend: 5750.4, expectedT1: 46.8, reward1Pct: 0.81, t1Pct: 0.0081, t2Pct: 0.017, live: true,
  });
  const tatasteel = row({
    ticker: 'TATASTEEL', core: true, sleeve: 'Metals', verdict: 'BUY', buy: 'YES', action: 'BUY NOW',
    score: 13, profitScore: 15.39, ltp: 186.3, rsi: 64.91, distSma: 3.33,
    qty: 20, spend: 3726.0, expectedT1: 20.0, reward1Pct: 0.54, live: true,
  });
  const sbin = row({
    ticker: 'SBIN', core: true, sleeve: 'Bank — primary', verdict: 'BUY', buy: 'YES', action: 'BUY NOW',
    score: 12, profitScore: 14.9, ltp: 1018.5, rsi: 65.1, distSma: 3.49,
    qty: 4, spend: 4074.0, expectedT1: 20.4, reward1Pct: 0.5, live: true,
  });
  const axis = row({
    ticker: 'AXISBANK', core: true, sleeve: 'Bank — primary', verdict: 'BUY', buy: 'YES', action: 'HOLD OPEN',
    score: 12, profitScore: 14.86, ltp: 1322.9, rsi: 56.45, distSma: 6.41,
    qty: 3, spend: 3968.7, expectedT1: 19.8, reward1Pct: 0.5, live: true,
  });
  const hul = row({
    ticker: 'HINDUNILVR', core: true, sleeve: 'Defensive', verdict: 'BUY', buy: 'YES', action: 'BUY NOW',
    score: 11, profitScore: 14.18, ltp: 1998.4, rsi: 69.49, distSma: 4.47,
    qty: 1, spend: 1998.4, expectedT1: 10.0, reward1Pct: 0.5, live: true,
  });
  const liveBuys = [hindalco, tatasteel, sbin, axis, hul];
  const used = liveBuys.reduce((s, r) => s + r.spend, 0);
  const expectedT1 = liveBuys.reduce((s, r) => s + r.expectedT1, 0);

  return {
    session: SESSION,
    phase: {
      phase: 'live',
      canDecideBuy: true,
      clock: '14:35',
      day: '2026-11-08',
      message: 'DEMO · Live window — BUY on strongest profit names',
    },
    core: liveBuys,
    liveBuys,
    prep: [],
    extrasBuy: liveBuys,
    extrasWatch: [
      row({
        ticker: 'TCS', verdict: 'WATCH', buy: 'NO', action: 'WATCH',
        score: 8, profitScore: 15.79, ltp: 2498.5, rsi: 54.54, distSma: 9.42, reward1Pct: 0.66,
      }),
      row({
        ticker: 'NTPC', verdict: 'WATCH', buy: 'NO', action: 'WATCH',
        score: 7, profitScore: 14.11, ltp: 323.45, rsi: 57.41, distSma: 0.87, reward1Pct: 0.49,
      }),
    ],
    extrasSkipHot: [
      { ticker: 'ITC', rsi: 76.17 },
      { ticker: 'LT', rsi: 92.31 },
      { ticker: 'MARUTI', rsi: 77.62 },
    ],
    screened: 33,
    asOf: '2026-11-08 DEMO',
    // Dummy book totals (mirrors real Upstox Invest / Profit / Loss line).
    portfolio: {
      investment: 400876.34,
      pnl: -39767.3,
      holdings: 27,
      positions: 0,
      liveCount: 27,
      totalCount: 27,
    },
    lossGate: { blocked: false, pnlPct: -9.92, limit: 18, reason: '' },
    budget: {
      budget: DEFAULT_BUDGET,
      used: Math.round(used * 100) / 100,
      left: Math.round((DEFAULT_BUDGET - used) * 100) / 100,
      pickCount: liveBuys.length,
      expectedT1: Math.round(expectedT1 * 100) / 100,
      picks: liveBuys,
      byTicker: Object.fromEntries(liveBuys.map((r) => [r.ticker, r])),
    },
    demo: true,
  };
}

function buildBlockedBook() {
  const book = buildLiveBuyBook();
  book.phase = {
    ...book.phase,
    message: 'DEMO · DO NOT TRADE scene — book loss near 20%',
  };
  book.portfolio = {
    investment: 400876.34,
    pnl: -76166.5,
    holdings: 27,
    positions: 0,
    liveCount: 27,
    totalCount: 27,
  };
  book.lossGate = {
    blocked: true,
    pnlPct: -19,
    limit: 18,
    reason: 'DO NOT TRADE — book loss -19.0% (block near −18%, ~20% rule)',
  };
  book.liveBuys = [];
  book.extrasBuy = [];
  book.budget = {
    ...book.budget,
    used: 0,
    left: DEFAULT_BUDGET,
    pickCount: 0,
    expectedT1: 0,
    picks: [],
  };
  return book;
}

function buildDemoBot(book) {
  const open = (book.liveBuys || []).filter((r) => r.qty > 0).slice(0, 3).map((r, i) => ({
    ticker: r.ticker,
    qty: r.qty,
    entry: r.entry,
    stop: r.sellStop,
    stage: i === 0 ? 1 : 0,
    last: r.ltp * (i === 0 ? 1.004 : 1.001),
    spend: r.spend,
  }));
  const blocked = Boolean(book.lossGate && book.lossGate.blocked);
  return {
    enabled: true,
    live: true,
    product: 'I',
    spend: open.reduce((s, p) => s + p.spend, 0),
    openCount: open.length,
    positions: open,
    lossGate: book.lossGate,
    lastError: blocked ? book.lossGate.reason : '',
    log: blocked
      ? [
          { msg: 'DEMO: scanned 33 names' },
          { msg: book.lossGate.reason },
          { msg: 'DEMO: no new BUY — waiting for book recovery' },
        ]
      : [
          { msg: 'DEMO: BUY HINDALCO qty 6 @~958.40' },
          { msg: 'DEMO: SL-M HINDALCO @ 949.75' },
          { msg: 'DEMO: Trail HINDALCO stage 1 SL→958.40 (cost)' },
        ],
  };
}

function buildDemoState(scene = 'live') {
  const book = scene === 'blocked' ? buildBlockedBook() : buildLiveBuyBook();
  return {
    book,
    bot: buildDemoBot(book),
    feed: 'live',
    updatedAt: '2026-11-08 14:35 IST',
    error: '',
    demo: true,
  };
}

module.exports = {
  demoChecks,
  buildLiveBuyBook,
  buildBlockedBook,
  buildDemoBot,
  buildDemoState,
};
