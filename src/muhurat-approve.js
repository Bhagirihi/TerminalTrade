'use strict';

// Interactive gate: live Upstox money warning → user must type YES to allow BUY.
// Then ask budget. Used by `npm run muhurat` before the bot can place orders.

const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { DEFAULT_BUDGET } = require('./muhurat');

const paint = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
const bold = (t) => paint('1', t);
const red = (t) => paint('31', t);
const amber = (t) => paint('33', t);
const dim = (t) => paint('2', t);

async function askBuyApproval({ defaultBudget = DEFAULT_BUDGET } = {}) {
  if (!process.stdin.isTTY) {
    return {
      approved: false,
      budget: defaultBudget,
      reason: 'No interactive terminal — cannot approve BUY. Signals-only.',
    };
  }

  const rl = readline.createInterface({ input, output });
  try {
    console.log('');
    console.log(red(bold('══════════════════════════════════════════════════════')));
    console.log(red(bold('  LIVE TRADING ON UPSTOX — THIS USES YOUR REAL MONEY')));
    console.log(red(bold('══════════════════════════════════════════════════════')));
    console.log(dim('After YES the bot will:'));
    console.log(dim('  1) Scan stocks for this Muhurat session'));
    console.log(dim('  2) Pick max-profit names within your budget'));
    console.log(dim('  3) BUY on Upstox automatically'));
    console.log(dim('  4) Watch each position — trail SL / target'));
    console.log(dim('  5) SELL when target OR stop-loss hits (or hard exit 3:15)'));
    console.log('');
    console.log(amber('Type YES to approve live BUY/SELL. Type NO for watch-only (no orders).'));
    const ans = String(await rl.question('Approve live trading? ')).trim().toUpperCase();
    if (ans !== 'YES') {
      console.log(amber('No BUY approval — signals / watch only. No Upstox orders.'));
      return { approved: false, budget: defaultBudget, reason: 'User declined' };
    }

    const raw = String(await rl.question(`Budget in INR [default ${defaultBudget}]: `)).trim();
    let budget = defaultBudget;
    if (raw) {
      const n = Number(String(raw).replace(/,/g, ''));
      if (Number.isFinite(n) && n >= 1000) budget = Math.floor(n);
      else console.log(amber(`Invalid budget — using ₹${defaultBudget}`));
    }
    console.log(red(bold(`APPROVED — live auto with budget ₹${budget.toLocaleString('en-IN')}`)));
    console.log(dim('Starting scan / watch / trade loop…'));
    console.log('');
    return { approved: true, budget, reason: 'User typed YES' };
  } finally {
    rl.close();
  }
}

module.exports = { askBuyApproval };
