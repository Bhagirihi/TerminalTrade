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

// Typical cash names need ~₹5k–₹8k+ for 1 lot-sized BUY; ₹2k just spam-skips.
const MIN_STOCK_BUDGET = 10000;
const MIN_OPTIONS_BUDGET = 5000;

function parseBudget(raw, fallback, { min = 1000, label = 'budget' } = {}) {
  if (!raw) return fallback;
  const n = Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 1000) {
    console.log(amber(`Invalid ${label} — using ₹${fallback}`));
    return fallback;
  }
  const floor = Math.floor(n);
  if (floor < min) {
    console.log(amber(
      `${label} ₹${floor} is too low (min ₹${min} to avoid unaffordable skips) — using ₹${Math.max(fallback, min)}`
    ));
    return Math.max(fallback, min);
  }
  return floor;
}

async function askBudgetLine(rl, label, defaultBudget, min) {
  const raw = String(await rl.question(`${label} [default ${defaultBudget}]: `)).trim();
  return parseBudget(raw, defaultBudget, { min, label });
}

async function askBudgets(rl, { wantStock, wantOptions, stockDefault, optionsDefault, defaultBudget }) {
  let stockBudget = stockDefault;
  let optionsBudget = optionsDefault;
  let budget = defaultBudget;

  if (wantStock && wantOptions) {
    stockBudget = await askBudgetLine(rl, 'Stock budget in INR', stockDefault, MIN_STOCK_BUDGET);
    optionsBudget = await askBudgetLine(rl, 'Options budget in INR', optionsDefault, MIN_OPTIONS_BUDGET);
    budget = stockBudget + optionsBudget;
  } else if (wantOptions) {
    optionsBudget = await askBudgetLine(rl, 'Options budget in INR', optionsDefault, MIN_OPTIONS_BUDGET);
    budget = optionsBudget;
  } else {
    stockBudget = await askBudgetLine(rl, 'Stock budget in INR', stockDefault, MIN_STOCK_BUDGET);
    budget = stockBudget;
  }
  return { stockBudget, optionsBudget, budget };
}

/**
 * Non-interactive gate for PM2 / Oracle (no TTY).
 * MUHURAT_AUTO_APPROVE=live|paper|watch
 * live also needs MUHURAT_LIVE=true + MUHURAT_LIVE_CONFIRM=I_ACCEPT_REAL_ORDERS.
 */
function resolveAutoApprove({
  defaultBudget = DEFAULT_BUDGET,
  stockDefault,
  optionsDefault,
  liveAvailable = true,
  wantStock = true,
  wantOptions = false,
} = {}) {
  const auto = String(process.env.MUHURAT_AUTO_APPROVE || '').trim().toLowerCase();
  if (!auto) return null;

  const stockBudget = parseBudget(
    process.env.MUHURAT_BUDGET_STOCK,
    stockDefault,
    { min: MIN_STOCK_BUDGET, label: 'stock budget' }
  );
  const optionsBudget = parseBudget(
    process.env.MUHURAT_BUDGET_OPTIONS,
    optionsDefault,
    { min: MIN_OPTIONS_BUDGET, label: 'options budget' }
  );
  let budget = defaultBudget;
  if (wantStock && wantOptions) budget = stockBudget + optionsBudget;
  else if (wantOptions) budget = optionsBudget;
  else budget = stockBudget;

  if (auto === 'live' || auto === 'yes') {
    if (!liveAvailable) {
      return {
        approved: false,
        paper: false,
        budget,
        stockBudget,
        optionsBudget,
        reason: 'MUHURAT_AUTO_APPROVE=live but MUHURAT_LIVE is not armed',
      };
    }
    console.log(red(bold(
      `AUTO LIVE (MUHURAT_AUTO_APPROVE) — stocks ₹${stockBudget.toLocaleString('en-IN')} · options ₹${optionsBudget.toLocaleString('en-IN')}`
    )));
    return {
      approved: true,
      paper: false,
      budget,
      stockBudget,
      optionsBudget,
      reason: 'MUHURAT_AUTO_APPROVE=live',
    };
  }

  if (auto === 'paper') {
    console.log(green(bold(
      `AUTO PAPER (MUHURAT_AUTO_APPROVE) — stocks ₹${stockBudget.toLocaleString('en-IN')} · options ₹${optionsBudget.toLocaleString('en-IN')} (no real orders)`
    )));
    return {
      approved: false,
      paper: true,
      budget,
      stockBudget,
      optionsBudget,
      reason: 'MUHURAT_AUTO_APPROVE=paper',
    };
  }

  if (auto === 'watch' || auto === 'no' || auto === 'off') {
    return {
      approved: false,
      paper: false,
      budget,
      stockBudget,
      optionsBudget,
      reason: 'MUHURAT_AUTO_APPROVE=watch — signals only',
    };
  }

  console.log(amber(`Unknown MUHURAT_AUTO_APPROVE=${auto} — use live|paper|watch`));
  return null;
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

  const auto = resolveAutoApprove({
    defaultBudget,
    stockDefault,
    optionsDefault,
    liveAvailable,
    wantStock,
    wantOptions,
  });
  if (auto) return auto;

  if (!process.stdin.isTTY) {
    return {
      approved: false,
      paper: false,
      budget: defaultBudget,
      stockBudget: stockDefault,
      optionsBudget: optionsDefault,
      reason: 'No interactive terminal — set MUHURAT_AUTO_APPROVE=paper|live for PM2. Signals-only.',
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

module.exports = { askBuyApproval, resolveAutoApprove };
