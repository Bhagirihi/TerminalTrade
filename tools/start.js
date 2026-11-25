'use strict';

// `npm run start` — the V3 daily driver:
//   1. checks the Upstox token against the live API,
//   2. if it is missing or expired, ASKS to log in again (same OAuth flow
//      as `npm run login` — main's muhurat2 logs in automatically instead,
//      here you get asked first),
//   3. shows your Upstox funds and the live NIFTY / BANKNIFTY levels,
//   4. asks your trading budget for today (default: available funds) and
//      sizes each suggestion in whole lots inside it,
//   5. suggests trades from live NIFTY/BANKNIFTY candles using the V3 rules
//      and records each one as a PAPER trade (paper/v3-paper-trades.jsonl).
// Paper trading only — no live orders are placed. Run `npm run paper` to
// see how the paper trades did.

const readline = require('readline');
const { upstoxCredentials, runInteractiveUpstoxLogin } = require('../src/upstox-auth');
const { UpstoxApi } = require('../src/upstox-api');
const { suggestAll, formatSuggestion } = require('../src/suggest');
const { loadPaperTrades, recordPaperTrade, hasOpenTradeFor } = require('../src/paper');
const { istDateKey } = require('../src/time');

function inr(n) {
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function askYesNo(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} (y/n) `, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

// Trading budget for today. Non-interactive runs take the default
// (available funds, if known); otherwise there is no budget cap and each
// suggestion is paper-traded as 1 lot.
function askBudget(defaultBudget) {
  const def = defaultBudget != null && Number.isFinite(defaultBudget) && defaultBudget > 0
    ? Math.floor(defaultBudget) : null;
  if (!process.stdin.isTTY) return Promise.resolve(def);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const label = def != null
    ? `Trading budget for today (₹) [${def}]: `
    : 'Trading budget for today (₹): ';
  return new Promise((resolve) => {
    rl.question(label, (ans) => {
      rl.close();
      const n = Number(String(ans).trim().replace(/,/g, ''));
      if (Number.isFinite(n) && n > 0) return resolve(Math.floor(n));
      if (ans.trim() === '' && def != null) return resolve(def);
      console.log(`Invalid amount — using ${def != null ? `₹${def}` : '1 lot per trade'}.`);
      resolve(def);
    });
  });
}

async function main() {
  let creds = upstoxCredentials();
  let api = new UpstoxApi(creds.accessToken);
  let check = await api.checkToken();

  if (!check.ok && check.reason !== 'error') {
    if (check.reason === 'missing') {
      console.log('No Upstox token in .env.');
    } else {
      console.log(`Upstox token expired (${check.detail}).`);
    }
    const yes = await askYesNo('Log in again now?');
    if (!yes) {
      console.log('Run `npm run login` when ready, then `npm run start` again.');
      process.exitCode = 1;
      return;
    }
    const result = await runInteractiveUpstoxLogin({});
    console.log(`Logged in as ${result.userName}. Token saved.`);
    creds = upstoxCredentials();
    api = new UpstoxApi(creds.accessToken);
    check = await api.checkToken();
    if (!check.ok) {
      console.error(`Still not logged in: ${check.detail}`);
      process.exitCode = 1;
      return;
    }
  } else if (!check.ok) {
    console.error(`Upstox API error (not a token problem): ${check.detail}`);
    process.exitCode = 1;
    return;
  }

  console.log('Token OK.');

  // Funds + live index levels, best effort — a failure here never blocks
  // the suggestions below.
  let funds = null;
  try { funds = await api.getFunds(); } catch (_) { /* header shows unavailable */ }
  let indexLtps = new Map();
  try {
    indexLtps = await api.getLtps(['NSE_INDEX|Nifty 50', 'NSE_INDEX|Nifty Bank']);
  } catch (_) { /* header omits the levels */ }
  if (funds) {
    const total = funds.available + funds.used;
    console.log(`Upstox funds — available ₹${inr(funds.available)} · used ₹${inr(funds.used)} · total ₹${inr(total)}`);
  } else {
    console.log('Upstox funds — unavailable');
  }
  const nifty = indexLtps.get('NSE_INDEX|Nifty 50');
  const bank = indexLtps.get('NSE_INDEX|Nifty Bank');
  if (nifty || bank) {
    console.log(`NIFTY ${nifty ? inr(nifty) : '—'}  ·  BANKNIFTY ${bank ? inr(bank) : '—'}`);
  }

  const budget = await askBudget(funds ? funds.available : null);
  if (budget != null) console.log(`Trading budget for today: ₹${inr(budget)}`);

  console.log('Fetching live candles…');
  const suggestions = await suggestAll(api, undefined, { budget });
  for (const s of suggestions) console.log(formatSuggestion(s));

  // Paper trading only — record each tradeable suggestion (one open paper
  // position per contract per day, so a second run doesn't double-record).
  // No live orders are placed anywhere in V3.
  const today = istDateKey(Date.now());
  const existing = loadPaperTrades();
  let recorded = 0;
  let totalCost = 0;
  for (const s of suggestions) {
    if (s.status !== 'trade') continue;
    if (hasOpenTradeFor(existing, s.card.ticker, s.card.expiry, today)) {
      console.log(`Paper: ${s.card.ticker} already open today — skipped duplicate.`);
      continue;
    }
    const trade = {
      id: `${today}-${s.card.ticker.replace(/ /g, '-')}`,
      date: today,
      recordedAt: new Date().toISOString(),
      ticker: s.card.ticker,
      strike: s.card.strike,
      expiry: s.card.expiry,
      side: s.entry.side,
      instrumentKey: s.card.instrumentKey,
      lots: s.card.lots,
      qty: s.card.qty,
      lotSize: s.card.lot,
      entry: s.card.ltp,
      sl: s.card.sl,
      t1: s.card.t1,
      t2: s.card.t2,
      costPerLot: s.card.costPerLot,
      totalCost: s.card.totalCost,
      maxLoss: s.card.maxLoss,
      budgetLeft: s.card.budgetLeft != null ? s.card.budgetLeft : null,
      status: 'OPEN',
    };
    recordPaperTrade(trade);
    existing.push(trade);
    recorded += 1;
    totalCost += trade.totalCost;
  }
  if (recorded) console.log(`\nPaper trades recorded: ${recorded} (total cost ₹${inr(totalCost)})`);
  console.log('Paper trading only — no live orders placed. Run `npm run paper` to see how they did.');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
