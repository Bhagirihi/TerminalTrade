'use strict';

// `npm run start` — the V3 daily driver:
//   1. checks the Upstox token against the live API,
//   2. if it is missing or expired, ASKS to log in again (same OAuth flow
//      as `npm run login` — main's muhurat2 logs in automatically instead,
//      here you get asked first),
//   3. shows your Upstox funds and the live NIFTY / BANKNIFTY levels,
//   4. suggests trades from live NIFTY/BANKNIFTY candles using the V3 rules.
// Suggestions only — no orders are placed.

const readline = require('readline');
const { upstoxCredentials, runInteractiveUpstoxLogin } = require('../src/upstox-auth');
const { UpstoxApi } = require('../src/upstox-api');
const { suggestAll, formatSuggestion } = require('../src/suggest');

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

  console.log('Fetching live candles…');
  const suggestions = await suggestAll(api);
  for (const s of suggestions) console.log(formatSuggestion(s));
  console.log('\nSuggestions only — no orders placed.');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
