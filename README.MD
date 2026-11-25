# TerminalTrade V3

Blank branch — V3 starts here.

## Modules

- `npm run login` — Upstox login (OAuth, token into `.env`).
- `npm run start` — check the token, ask to log in again if expired, show Upstox funds + live NIFTY/BANKNIFTY, ask your trading budget for the day, then suggest trades from live candles and record each one as a PAPER trade. Paper trading only — no live orders.
- `npm run paper` — reconcile the paper ledger against live option prices: closes trades at SL/T2, shows live P&L on open ones, all net of charges.
- `src/indicators.js` — VWAP, EMA 20/50, RSI 14, MACD 12/26/9, Volume MA 20 (+ ATR, ADX).
- `src/entry-rules.js` — CE/PE setups from the screenshot plan, on 5m candles.
- `src/trade-score.js` — 0–100 trade quality calculator (pass bar 70).
- `src/regime.js` — rule-based regime label (trending/sideways × high/low vol); XGBoost-ready features, no model trained yet.
- `examples/run-rules.js` — run the rules: `node examples/run-rules.js` (demo candles) or `--candles5m 5m.json --candles15m 15m.json` with your own candles.
