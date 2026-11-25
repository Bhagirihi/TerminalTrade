# TerminalTrade V3

Blank branch — V3 starts here.

## Modules

- `npm run login` — Upstox login (OAuth, token into `.env`).
- `npm run start` — check the token, ask to log in again if expired, show Upstox funds + live NIFTY/BANKNIFTY, ask "Do you want Live trading?" (YES = real orders, NO = paper), ask your trading budget for the day, then WATCH the market live. Prices are REALTIME via Upstox's websocket feed (v3): index levels, open-position P&L and SL/T2 exits update on the tick that crosses the level. Candles still refresh every 30s — entries are evaluated only when a new 5m bar closes, which is the correct time to act. If the feed drops, the loop falls back to REST polling and keeps working. Live entries are market BUY + a broker SL-M at the stop; the loop exits at T2 or 15:15, and the broker SL-M owns the stop. Ctrl+C stops and squares off. `npm run start -- --once` does one pass and exits. First run after pulling: `npm install` (adds the `ws` websocket library).
- The score's liquidity check (5 points) is now measured, not guessed: the loop subscribes to the ATM ± 1 strike CE/PE keys (real numeric tokens from the contracts API) so the feed's bid/ask is warm before a setup appears, and a spread of 0.5% of mid or tighter passes. No quote yet (feed down, or the band still warming up on the first tick) scores as 'nodata' — the score ceiling is 90 with liquidity measured, 85 without it, and volume stays nodata (index candles carry no volume).
- `npm run paper` — reconcile the paper ledger against live option prices: closes trades at SL/T2, shows live P&L on open ones, all net of charges.
- `src/indicators.js` — VWAP, EMA 20/50, RSI 14, MACD 12/26/9, Volume MA 20 (+ ATR, ADX).
- `src/entry-rules.js` — CE/PE setups from the screenshot plan, on 5m candles.
- `src/trade-score.js` — 0–100 trade quality calculator (pass bar 70).
- `src/regime.js` — rule-based regime label (trending/sideways × high/low vol); XGBoost-ready features, no model trained yet.
- `examples/run-rules.js` — run the rules: `node examples/run-rules.js` (demo candles) or `--candles5m 5m.json --candles15m 15m.json` with your own candles.
