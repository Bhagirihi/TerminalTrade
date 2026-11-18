'use strict';

// Interactive gate: live Upstox money warning → YES for live, else ask paper trading.
// Used by `npm run muhurat2` before the order/paper bot starts.

const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { DEFAULT_BUDGET } = require('./muhurat');

const paint = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
const bold = (t) => paint('1', t);
const red = (t) => paint('31', t);
const amber = (t) => paint('33', t);
const green = (t) => paint('32', t);
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

async function askBudgets(rl, { wantStock, wantOptions, stockDefault, optionsDefault, defaultBudget }) {
  let stockBudget = stockDefault;
  let optionsBudget = optionsDefault;
  let budget = defaultBudget;

  if (wantStock && wantOptions) {
    stockBudget = await askBudgetLine(rl, 'Stock budget in INR', stockDefault);
    optionsBudget = await askBudgetLine(rl, 'Options budget in INR', optionsDefault);
    budget = stockBudget + optionsBudget;
  } else if (wantOptions) {
    optionsBudget = await askBudgetLine(rl, 'Options budget in INR', optionsDefault);
    budget = optionsBudget;
  } else {
    stockBudget = await askBudgetLine(rl, 'Stock budget in INR', stockDefault);
    budget = stockBudget;
  }
  return { stockBudget, optionsBudget, budget };
}

async function askBuyApproval({
  defaultBudget = DEFAULT_BUDGET,
  defaultStockBudget,
  defaultOptionsBudget,
  modes = ['equity'],
  liveAvailable = true,
} = {}) {
  const wantStock = modes.includes('equity') || modes.includes('stocks');
  const wantOptions = modes.includes('options');
  const stockDefault = Number(defaultStockBudget) > 0 ? Number(defaultStockBudget) : defaultBudget;
  const optionsDefault = Number(defaultOptionsBudget) > 0 ? Number(defaultOptionsBudget) : defaultBudget;

  if (!process.stdin.isTTY) {
    return {
      approved: false,
      paper: false,
      budget: defaultBudget,
      stockBudget: stockDefault,
      optionsBudget: optionsDefault,
      reason: 'No interactive terminal — cannot approve. Signals-only.',
    };
  }

  const rl = readline.createInterface({ input, output });
  try {
    let liveYes = false;

    if (liveAvailable) {
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
      console.log(amber('Type YES to approve live BUY/SELL. Type NO to skip live trading.'));
      const ans = String(await rl.question('Approve live trading? ')).trim().toUpperCase();
      liveYes = ans === 'YES';
    } else {
      console.log('');
      console.log(dim('MUHURAT_LIVE is not enabled — live Upstox orders are off.'));
    }

    if (liveYes) {
      const budgets = await askBudgets(rl, {
        wantStock,
        wantOptions,
        stockDefault,
        optionsDefault,
        defaultBudget,
      });
      if (wantStock && wantOptions) {
        console.log(red(bold(
          `LIVE APPROVED — stocks ₹${budgets.stockBudget.toLocaleString('en-IN')} · options ₹${budgets.optionsBudget.toLocaleString('en-IN')}`
        )));
      } else if (wantOptions) {
        console.log(red(bold(`LIVE APPROVED — options budget ₹${budgets.budget.toLocaleString('en-IN')}`)));
      } else {
        console.log(red(bold(`LIVE APPROVED — budget ₹${budgets.budget.toLocaleString('en-IN')}`)));
      }
      console.log(dim('Starting live scan / watch / trade loop…'));
      console.log('');
      return {
        approved: true,
        paper: false,
        ...budgets,
        reason: 'User typed YES for live',
      };
    }

    if (liveAvailable) {
      console.log(amber('Live trading declined.'));
    }
    console.log('');
    console.log(amber(bold('Paper trading — simulated BUY/SELL, no Upstox orders.')));
    console.log(dim('Same rules (SL / trail / T2 / 3:15) · fills logged under paper/'));
    console.log(amber('Do you want paper trading? Type YES or NO.'));
    const paperAns = String(await rl.question('Paper trading? ')).trim().toUpperCase();
    if (paperAns !== 'YES') {
      console.log(amber('No live / no paper — signals / watch only.'));
      return {
        approved: false,
        paper: false,
        budget: defaultBudget,
        stockBudget: stockDefault,
        optionsBudget: optionsDefault,
        reason: 'User declined live and paper',
      };
    }

    const budgets = await askBudgets(rl, {
      wantStock,
      wantOptions,
      stockDefault,
      optionsDefault,
      defaultBudget,
    });
    if (wantStock && wantOptions) {
      console.log(green(bold(
        `PAPER ON — stocks ₹${budgets.stockBudget.toLocaleString('en-IN')} · options ₹${budgets.optionsBudget.toLocaleString('en-IN')} (no real orders)`
      )));
    } else if (wantOptions) {
      console.log(green(bold(`PAPER ON — options budget ₹${budgets.budget.toLocaleString('en-IN')} (no real orders)`)));
    } else {
      console.log(green(bold(`PAPER ON — budget ₹${budgets.budget.toLocaleString('en-IN')} (no real orders)`)));
    }
    console.log(dim('Starting paper scan / watch / trade loop…'));
    console.log('');
    return {
      approved: false,
      paper: true,
      ...budgets,
      reason: 'User typed YES for paper',
    };
  } finally {
    rl.close();
  }
}

module.exports = { askBuyApproval };
