# TerminalTrade V3

Blank branch — V3 starts here.

## Modules

- `npm run login` — Upstox login (OAuth, token into `.env`).
- `npm run start` — check the token, ask to log in again if expired, show Upstox funds + live NIFTY/BANKNIFTY, ask "Do you want Live trading?" (YES = real orders, NO = paper), ask your trading budget for the day, then WATCH the market live. Prices are REALTIME via Upstox's websocket feed (v3): index levels, open-position P&L and SL/T2 exits update on the tick that crosses the level. Candles still refresh every 30s — entries are evaluated only when a new 5m bar closes, which is the correct time to act. If the feed drops, the loop falls back to REST polling and keeps working. Live entries are market BUY + a broker SL-M at the stop; the loop exits at T2 or 15:15, and the broker SL-M owns the stop. Ctrl+C stops and squares off. `npm run start -- --once` does one pass and exits. First run after pulling: `npm install` (adds the `ws` websocket library).
- The score's liquidity check (5 points) is now measured, not guessed: the loop subscribes to the ATM ± 1 strike CE/PE keys (real numeric tokens from the contracts API) so the feed's bid/ask is warm before a setup appears, and a spread of 0.5% of mid or tighter passes. No quote yet (feed down, or the band still warming up on the first tick) scores as 'nodata' — the score ceiling is 90 with liquidity measured, 85 without it, and volume stays nodata (index candles carry no volume).
- The funds line carries the day's trade fund: `Upstox funds — available ₹15,510.40 · used ₹0.00 · total ₹15,510.40 · trade fund ₹12,000.00` (omitted when the budget is uncapped). Ctrl+C stops cleanly: the first press squares off and exits (the 30s sleep is woken, not just cleared), a second press force-quits at once, and a 20s safety net exits even if a tick or square-off is stuck.
- Budget recycles on close: when a position closes (SL/T2/SL-M/15:15), its net proceeds — entry cost + net P&L, i.e. the exit value minus charges — go back into the day's budget, so the loop can trade again. `spent + left` always equals the budget; a win can push the leftover above the budget, which is real profit. Each position is credited exactly once.
- Daily trade record: every day's trades are stored in `daily/<YYYY-MM-DD>.json` (local only, gitignored) — each trade with entry/exit datetimes, strike, expiry, side, qty, lots, SL/T1/T2, exit reason, gross/charges/net, plus a summary with the day's realised P&L split by paper/live. Written when a trade opens, when it closes, and once more when the loop ends; `npm run paper` refreshes it for any day it reconciles.
- Live indicator preview: each card carries a `LIVE forming bar` line — VWAP, EMA 20/50, RSI and MACD recomputed on the forming 5m bar (live LTP as its close, refreshed from REST every 30s and moved tick-by-tick by the feed), so you see the checks flipping as the price moves. It is display only and marked "not a signal": entries still fire only on a closed 5m bar, so a setup can never appear and vanish inside a bar.
- `npm run paper` — reconcile the paper ledger against live option prices: closes trades at SL/T2, shows live P&L on open ones, all net of charges.
- `src/indicators.js` — VWAP, EMA 20/50, RSI 14, MACD 12/26/9, Volume MA 20 (+ ATR, ADX).
- `src/entry-rules.js` — CE/PE setups from the screenshot plan, on 5m candles.
- `src/trade-score.js` — 0–100 trade quality calculator (pass bar 70).
- `src/regime.js` — rule-based regime label (trending/sideways × high/low vol); XGBoost-ready features, no model trained yet.
- `examples/run-rules.js` — run the rules: `node examples/run-rules.js` (demo candles) or `--candles5m 5m.json --candles15m 15m.json` with your own candles.
