'use strict';

// Square off today's open Upstox short-term positions (Muhurat day trades).
// Usage:
//   npm run muhurat:exit
//   node tools/muhurat-exit.js --dry-run

const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');
const { UpstoxProvider } = require('../src/data/upstox');
const { istDateKey, istFullStr } = require('../src/time');

const PAPER_DIR = path.join(__dirname, '..', 'paper');
const TAG = 'muhurat';

function dryRun() {
  return process.argv.includes('--dry-run') || process.argv.includes('--Dry');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function openLegs(rows) {
  const out = [];
  for (const row of rows || []) {
    const qty = num(row.quantity);
    if (!qty) continue;
    const key = row.instrument_token != null ? String(row.instrument_token) : '';
    if (!key) continue;
    out.push({
      key,
      qty: Math.abs(qty),
      side: qty > 0 ? 'SELL' : 'BUY', // long → SELL to exit; short → BUY to cover
      product: String(row.product || 'I').toUpperCase() || 'I',
      symbol: row.trading_symbol || row.tradingsymbol || row.symbol || key,
      exchange: row.exchange || '',
      pnl: row.pnl != null ? Number(row.pnl) : null,
      avg: row.average_price != null ? Number(row.average_price) : null,
      last: row.last_price != null ? Number(row.last_price) : null,
    });
  }
  return out;
}

async function cancelOpenStops(provider, keys) {
  const want = new Set(keys);
  let orders = [];
  try {
    orders = await provider.getOrders();
  } catch (e) {
    console.log(`Could not list orders (continue): ${e.message}`);
    return 0;
  }
  let n = 0;
  for (const o of orders || []) {
    const status = String(o.status || o.order_status || '').toUpperCase();
    if (!/OPEN|TRIGGER PENDING|PENDING|MODIFIED/i.test(status)) continue;
    const key = o.instrument_token != null ? String(o.instrument_token) : '';
    if (!want.has(key)) continue;
    const type = String(o.order_type || '').toUpperCase();
    const txn = String(o.transaction_type || '').toUpperCase();
    const tag = String(o.tag || '');
    if (txn !== 'SELL') continue;
    if (!(type === 'SL-M' || type === 'SL' || tag === TAG)) continue;
    const id = o.order_id || o.orderId;
    if (!id) continue;
    try {
      await provider.cancelOrder(id);
      n += 1;
      console.log(`Cancelled stop/order ${id} · ${o.trading_symbol || key}`);
      await sleep(250);
    } catch (e) {
      console.log(`Cancel ${id} failed: ${e.message}`);
    }
  }
  return n;
}

function markLocalStatesClosed(day) {
  if (!fs.existsSync(PAPER_DIR)) return;
  for (const mode of ['live', 'options']) {
    const file = path.join(PAPER_DIR, `muhurat-${mode}-${day}.json`);
    if (!fs.existsSync(file)) continue;
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const pos of Object.values(state.positions || {})) {
        if (!pos) continue;
        pos.qty = 0;
        pos.status = 'CLOSED';
        pos.exitReason = pos.exitReason || 'manual-exit';
      }
      state.squaredOff = true;
      state.entered = Object.values(state.positions || {}).some((p) => p && p.qty > 0);
      fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
      console.log(`Updated local state ${path.basename(file)}`);
    } catch (e) {
      console.log(`Local state ${path.basename(file)}: ${e.message}`);
    }
  }
}

async function main() {
  const dry = dryRun();
  if (!config.upstox.accessToken) {
    console.error('UPSTOX_ACCESS_TOKEN missing — run npm run login / Link Upstox first.');
    process.exit(1);
  }
  const provider = new UpstoxProvider(config.upstox.accessToken);
  const day = istDateKey(Date.now());
  console.log(dry ? `Muhurat EXIT (dry-run) · ${istFullStr(Date.now())}` : `Muhurat EXIT · ${istFullStr(Date.now())}`);
  console.log(`Day ${day} · squaring off open short-term positions`);

  const book = await provider.getPortfolio();
  const legs = openLegs(book.positionRows || []);
  if (!legs.length) {
    console.log('No open short-term positions. Nothing to exit.');
    markLocalStatesClosed(day);
    return;
  }

  console.log(`Open legs: ${legs.length}`);
  for (const leg of legs) {
    const pnl = leg.pnl != null ? ` · pnl ₹${leg.pnl}` : '';
    console.log(`  ${leg.side} ${leg.symbol} qty ${leg.qty} · ${leg.product}${pnl}`);
  }

  if (dry) {
    console.log('Dry-run only — no orders sent. Re-run without --dry-run to exit.');
    return;
  }

  const cancelled = await cancelOpenStops(provider, legs.map((l) => l.key));
  if (cancelled) console.log(`Cancelled ${cancelled} open stop/order(s).`);

  let ok = 0;
  let fail = 0;
  for (const leg of legs) {
    try {
      const placed = await provider.placeOrder({
        instrumentToken: leg.key,
        quantity: leg.qty,
        transactionType: leg.side,
        orderType: 'MARKET',
        product: leg.product,
        tag: TAG,
      });
      const id = placed && (placed.order_id || placed.orderId);
      console.log(`EXIT ${leg.side} ${leg.symbol} qty ${leg.qty} · order ${id || 'ok'}`);
      ok += 1;
      await sleep(400);
    } catch (e) {
      fail += 1;
      console.error(`FAIL ${leg.symbol}: ${e.message}`);
    }
  }

  markLocalStatesClosed(day);
  console.log(`Done · exited ${ok} · failed ${fail}`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
