'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickFront, toSymbol } = require('../src/commodities');

test('front month is the nearest live future of the main contract', () => {
  const now = Date.parse('2026-10-25T10:00:00+05:30');
  const rows = [
    { asset_symbol: 'GOLD', instrument_type: 'FUT', expiry: Date.parse('2026-10-20T23:59:59+05:30'), instrument_key: 'OLD', qty_multiplier: 100 },
    { asset_symbol: 'GOLD', instrument_type: 'FUT', expiry: Date.parse('2026-12-04T23:59:59+05:30'), instrument_key: 'MCX_FO|495213', qty_multiplier: 100, lot_size: 1 },
    { asset_symbol: 'GOLDTEN', instrument_type: 'FUT', expiry: Date.parse('2026-10-30T23:59:59+05:30'), instrument_key: 'MINI', qty_multiplier: 10 },
    { asset_symbol: 'GOLD', instrument_type: 'CE', expiry: Date.parse('2026-11-01T23:59:59+05:30'), instrument_key: 'OPT' },
  ];
  const row = pickFront(rows, 'GOLD', now);
  assert.equal(row.instrument_key, 'MCX_FO|495213');
  const symbol = toSymbol({ id: 'GOLD', name: 'GOLD', asset: 'GOLD' }, row);
  assert.equal(symbol.kind, 'commodity');
  assert.equal(symbol.lotSize, 100);
  assert.equal(symbol.contract, '4 Dec 26');
});
