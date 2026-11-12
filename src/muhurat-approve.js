'use strict';

// Interactive gate: live Upstox money warning → user must type YES to allow BUY.
// Then ask budget (stocks / options / both). Used by `npm run muhurat` before orders.

const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { DEFAULT_BUDGET } = require('./muhurat');

const paint = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
const bold = (t) => paint('1', t);
const red = (t) => paint('31', t);
const amber = (t) => paint('33', t);
const dim = (t) => paint('2', t);

function parseBudget(raw, fallback) {
  if (!raw) return fallback;
  const n = Number(String(raw).replace(/,/g, ''));
  if (Number.isFinite(n) && n >= 1000) return Math.floor(n);
  console.log(amber(`Invalid budget — using ₹${fallback}`));
  return fallback;
}

async function askBudgetLine(rl, label, defaultBudget) {
  const raw = String(await rl.question(`${label} [default ${defaultBudget}]: `)).trim();
  return parseBudget(raw, defaultBudget);
}

async function askBuyApproval({
  defaultBudget = DEFAULT_BUDGET,
  defaultStockBudget,
  defaultOptionsBudget,
  modes = ['equity'],
} = {}) {
  const wantStock = modes.includes('equity') || modes.includes('stocks');
  const wantOptions = modes.includes('options');
  const stockDefault = Number(defaultStockBudget) > 0 ? Number(defaultStockBudget) : defaultBudget;
  const optionsDefault = Number(defaultOptionsBudget) > 0 ? Number(defaultOptionsBudget) : defaultBudget;

  if (!process.stdin.isTTY) {
    return {
      approved: false,
      budget: defaultBudget,
      stockBudget: stockDefault,
      optionsBudget: optionsDefault,
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
    if (wantStock && wantOptions) {
      console.log(dim('  1) Scan stocks + NIFTY/BANKNIFTY options in one process'));
      console.log(dim('  2) Use separate budgets for stocks and options'));
    } else if (wantOptions) {
      console.log(dim('  1) Scan NIFTY/BANKNIFTY ATM CE/PE'));
      console.log(dim('  2) Pick lots within your options budget'));
    } else {
      console.log(dim('  1) Scan stocks for this session'));
      console.log(dim('  2) Pick max-profit names within your budget'));
    }
    console.log(dim('  3) BUY on Upstox automatically'));
    console.log(dim('  4) Watch each position — trail SL / target'));
    console.log(dim('  5) SELL when target OR stop-loss hits (or hard exit 3:15)'));
    console.log('');
    console.log(amber('Type YES to approve live BUY/SELL. Type NO for watch-only (no orders).'));
    const ans = String(await rl.question('Approve live trading? ')).trim().toUpperCase();
    if (ans !== 'YES') {
      console.log(amber('No BUY approval — signals / watch only. No Upstox orders.'));
      return {
        approved: false,
        budget: defaultBudget,
        stockBudget: stockDefault,
        optionsBudget: optionsDefault,
        reason: 'User declined',
      };
    }

    let stockBudget = stockDefault;
    let optionsBudget = optionsDefault;
    let budget = defaultBudget;

    if (wantStock && wantOptions) {
      stockBudget = await askBudgetLine(rl, 'Stock budget in INR', stockDefault);
      optionsBudget = await askBudgetLine(rl, 'Options budget in INR', optionsDefault);
      budget = stockBudget + optionsBudget;
      console.log(red(bold(
        `APPROVED — stocks ₹${stockBudget.toLocaleString('en-IN')} · options ₹${optionsBudget.toLocaleString('en-IN')}`
      )));
    } else if (wantOptions) {
      optionsBudget = await askBudgetLine(rl, 'Options budget in INR', optionsDefault);
      budget = optionsBudget;
      console.log(red(bold(`APPROVED — options live auto with budget ₹${budget.toLocaleString('en-IN')}`)));
    } else {
      stockBudget = await askBudgetLine(rl, 'Stock budget in INR', stockDefault);
      budget = stockBudget;
      console.log(red(bold(`APPROVED — live auto with budget ₹${budget.toLocaleString('en-IN')}`)));
    }

    console.log(dim('Starting scan / watch / trade loop…'));
    console.log('');
    return {
      approved: true,
      budget,
      stockBudget,
      optionsBudget,
      reason: 'User typed YES',
    };
  } finally {
    rl.close();
  }
}

module.exports = { askBuyApproval };
