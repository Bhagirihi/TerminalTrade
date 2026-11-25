'use strict';

// Tests for the probe's NSE-master helpers (tools/muhurat-backtest-probe.js).
// No network: a synthetic master. Expiries are read from the master, never
// assumed from a weekday (NIFTY weekly moved Thursday → Monday, Oct 2025).

const assert = require('node:assert');
const { test } = require('node:test');
const {
  expiryList,
  expiryOnOrBefore,
  optionContracts,
  futureContracts,
  pickAtmCe,
} = require('../tools/muhurat-backtest-probe');

// Expiries: NIFTY weekly Mon 2026-08-24 + monthly Thu 2026-08-27,
// BANKNIFTY weekly Thu 2026-08-27. Strikes straddle a 25,700 index close.
function master() {
  const rows = [];
  const opt = (name, expiry, strike, type) => ({
    instrument_key: `NSE_FO|${name}26AUG${strike}${type}`,
    tradingsymbol: `${name}26AUG${strike}${type}`,
    name,
    instrument_type: type,
    expiry,
    strike_price: strike,
  });
  for (const s of [25400, 25600, 25700, 25800, 26000]) {
    rows.push(opt('NIFTY', '2026-08-24', s, 'CE'));
    rows.push(opt('NIFTY', '2026-08-24', s, 'PE'));
  }
  rows.push(opt('NIFTY', '2026-08-27', 25700, 'CE'));
  for (const s of [63400, 63700, 64000]) {
    rows.push(opt('BANKNIFTY', '2026-08-27', s, 'CE'));
    rows.push(opt('BANKNIFTY', '2026-08-27', s, 'PE'));
  }
  rows.push({
    instrument_key: 'NSE_FO|NIFTY26AUGFUT',
    tradingsymbol: 'NIFTY26AUGFUT',
    name: 'NIFTY',
    instrument_type: 'FUT',
    expiry: '2026-08-27',
  });
  rows.push({
    instrument_key: 'NSE_FO|BANKNIFTY26AUGFUT',
    tradingsymbol: 'BANKNIFTY26AUGFUT',
    name: 'BANKNIFTY',
    instrument_type: 'FUT',
    expiry: '2026-08-27',
  });
  rows.push({
    instrument_key: 'NSE_EQ|SBIN',
    tradingsymbol: 'SBIN',
    name: 'SBIN',
    instrument_type: 'EQ',
    expiry: '',
  });
  return rows;
}

test('expiryList collects sorted unique expiries per underlying', () => {
  assert.deepStrictEqual(expiryList(master(), 'NIFTY'), ['2026-08-24', '2026-08-27']);
  assert.deepStrictEqual(expiryList(master(), 'BANKNIFTY'), ['2026-08-27']);
});

test('expiryOnOrBefore picks the nearest expiry at or before the target', () => {
  const exps = ['2026-08-24', '2026-08-27', '2026-08-31'];
  assert.strictEqual(expiryOnOrBefore(exps, '2026-08-25'), '2026-08-24');
  assert.strictEqual(expiryOnOrBefore(exps, '2026-08-27'), '2026-08-27');
  assert.strictEqual(expiryOnOrBefore(exps, '2026-08-23'), null);
});

test('optionContracts filters by underlying + expiry + CE/PE only', () => {
  assert.strictEqual(optionContracts(master(), 'NIFTY', '2026-08-24').length, 10);
  assert.strictEqual(optionContracts(master(), 'NIFTY', '2026-08-27').length, 1);
  assert.strictEqual(optionContracts(master(), 'BANKNIFTY', '2026-08-27').length, 6);
  assert.strictEqual(optionContracts(master(), 'BANKNIFTY', '2026-08-24').length, 0);
  // BANKNIFTY rows must never leak into a NIFTY filter ('BANKNIFTY' contains
  // 'NIFTY' as a substring), and NIFTYIT-style names must not match either.
  const extra = master();
  extra.push({ instrument_key: 'NSE_FO|NIFTYIT26AUG100CE', tradingsymbol: 'NIFTYIT26AUG100CE', name: 'NIFTYIT', instrument_type: 'CE', expiry: '2026-08-24', strike_price: 100 });
  assert.strictEqual(optionContracts(extra, 'NIFTY', '2026-08-24').length, 10);
});

test('futureContracts picks only the FUT row', () => {
  const futs = futureContracts(master(), 'NIFTY', '2026-08-27');
  assert.strictEqual(futs.length, 1);
  assert.strictEqual(futs[0].tradingsymbol, 'NIFTY26AUGFUT');
  assert.strictEqual(futureContracts(master(), 'BANKNIFTY', '2026-08-24').length, 0);
});

test('pickAtmCe picks the closest CE to the index close', () => {
  const contracts = optionContracts(master(), 'NIFTY', '2026-08-24');
  const picked = pickAtmCe(contracts, 25700);
  assert.strictEqual(picked.strike_price, 25700);
  assert.strictEqual(picked.instrument_type, 'CE');
  const picked2 = pickAtmCe(contracts, 25650);
  assert.strictEqual(picked2.strike_price, 25600);
});
