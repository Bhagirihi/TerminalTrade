'use strict';

const zlib = require('zlib');
const { istDateKey } = require('./time');

// Front-month MCX futures. The instrument key changes every expiry, so it is
// resolved from Upstox's public contract file instead of being hardcoded.
const PRODUCTS = [
  { id: 'CRUDE', name: 'CRUDE', asset: 'CRUDEOIL' },
  { id: 'GOLD', name: 'GOLD', asset: 'GOLD' },
  { id: 'SILVER', name: 'SILVER', asset: 'SILVER' },
];

const MASTER = 'https://assets.upstox.com/market-quote/instruments/exchange/MCX.json.gz';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function expiryLabel(epoch) {
  const key = istDateKey(Number(epoch));
  const parts = String(key).split('-');
  const month = MONTHS[Number(parts[1]) - 1];
  const day = Number(parts[2]);
  if (!month || !day) return '';
  return `${day} ${month} ${String(parts[0]).slice(2)}`;
}

function dayStart(now) {
  return Date.parse(`${istDateKey(now)}T00:00:00+05:30`);
}

function pickFront(rows, asset, now) {
  const start = dayStart(now);
  const live = (rows || []).filter((row) => {
    return row && row.asset_symbol === asset && row.instrument_type === 'FUT' && Number(row.expiry) >= start;
  });
  live.sort((a, b) => Number(a.expiry) - Number(b.expiry));
  return live[0] || null;
}

function toSymbol(product, row) {
  const qty = Number(row.qty_multiplier);
  const lot = Number(row.lot_size);
  return {
    id: product.id,
    name: product.name,
    kind: 'commodity',
    asset: product.asset,
    lotSize: Number.isFinite(qty) && qty > 0 ? qty : lot,
    upstoxKey: row.instrument_key,
    contract: expiryLabel(row.expiry),
  };
}

async function resolveCommodities(now = Date.now()) {
  const res = await fetch(MASTER, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`MCX contract file ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer());
  const text = zlib.gunzipSync(raw).toString('utf8');
  const rows = JSON.parse(text);
  const out = [];
  for (const product of PRODUCTS) {
    const row = pickFront(rows, product.asset, now);
    if (row && row.instrument_key) out.push(toSymbol(product, row));
  }
  return out;
}

module.exports = { PRODUCTS, pickFront, toSymbol, resolveCommodities };
