'use strict';

// Rule screen for delivery holdings. Same checks as the pasted script:
// a 50-day simple average, and an RSI that averages the last 14 up and down
// moves (not the Wilder RSI on the index dashboard).
// The action is a label from those rules. It is not an order.

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function smaLast(values, window) {
  if (!values || values.length < window) return NaN;
  let sum = 0;
  for (let i = values.length - window; i < values.length; i++) sum += values[i];
  return sum / window;
}

// pandas: gain = delta.clip(lower=0).rolling(14).mean(), same for loss.
// The first full window ends on the 15th close.
function simpleRsi(closes, window = 14) {
  const out = new Array(closes.length).fill(NaN);
  for (let i = window; i < closes.length; i++) {
    let gain = 0;
    let loss = 0;
    for (let k = i - window + 1; k <= i; k++) {
      const delta = closes[k] - closes[k - 1];
      if (delta > 0) gain += delta;
      else if (delta < 0) loss += -delta;
    }
    gain /= window;
    loss /= window;
    if (gain === 0 && loss === 0) continue;
    if (loss === 0) {
      out[i] = 100;
      continue;
    }
    const rs = gain / loss;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

function screenHolding({ ticker, buyPrice, quantity, closes }) {
  const name = ticker || '—';
  if (!closes || closes.length < 50 || !Number.isFinite(Number(buyPrice)) || Number(buyPrice) === 0) {
    return {
      ticker: name,
      quantity: quantity == null ? null : quantity,
      buyPrice: round2(Number(buyPrice)),
      currentPrice: null,
      pnlPct: null,
      sma50: null,
      rsi: null,
      action: 'REVIEW',
      reason: 'Not enough daily history, or the buy price is missing.',
    };
  }

  const current = closes[closes.length - 1];
  const sma50 = smaLast(closes, 50);
  const rsiSeries = simpleRsi(closes, 14);
  const rsiRaw = rsiSeries[rsiSeries.length - 1];
  const rsi = Number.isFinite(rsiRaw) ? rsiRaw : 0;
  const pnlPct = ((current - buyPrice) / buyPrice) * 100;

  let action = 'HOLD / REVIEW';
  let reason = 'Consolidating within normal parameters.';
  if (current > sma50 && pnlPct > -5) {
    action = 'KEEP';
    reason = 'Price is above 50-day SMA; strong trend.';
  } else if (current < sma50 && pnlPct < -10) {
    action = 'SELL / CUT LOSS';
    reason = 'Price broke below 50-day SMA with over 10% drawdown.';
  } else if (rsi > 75) {
    action = 'BOOK PROFIT / REVIEW';
    reason = `Short-term overbought (RSI: ${rsi.toFixed(1)}). Consider trailing stop-loss.`;
  }

  return {
    ticker: name,
    quantity: quantity == null ? null : quantity,
    buyPrice: round2(Number(buyPrice)),
    currentPrice: round2(current),
    pnlPct: round2(pnlPct),
    sma50: round2(sma50),
    rsi: round2(rsi),
    action,
    reason,
  };
}

function holdingInput(row) {
  const qty = Number(row && row.quantity) || 0;
  const t1 = Number(row && row.t1_quantity) || 0;
  const quantity = qty !== 0 ? qty : t1;
  const ticker = (row && (row.tradingsymbol || row.trading_symbol || row.company_name)) || '—';
  return {
    ticker: String(ticker),
    instrumentKey: row && row.instrument_token != null ? String(row.instrument_token) : '',
    buyPrice: Number(row && row.average_price),
    quantity,
  };
}

module.exports = { screenHolding, simpleRsi, holdingInput };
