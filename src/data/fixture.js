'use strict';

// Fixture provider: reads candles from local CSV files (FIXTURE_DIR/NIFTY.csv,
// BANKNIFTY.csv with header t,open,high,low,close[,volume], t = epoch ms).
// This is ONLY for offline testing of the dashboard/engine - it is not a
// market data source. The dashboard labels it "FIXTURE (test data)".

const fs = require('fs');
const path = require('path');

class FixtureProvider {
  constructor(dir) {
    this.name = 'FIXTURE';
    this.dir = dir;
    this.cache = {};
  }

  load(symbol) {
    if (this.cache[symbol.id]) return this.cache[symbol.id];
    const file = path.join(this.dir, `${symbol.id}.csv`);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const candles = [];
    for (let i = 1; i < lines.length; i++) {
      const [t, o, h, l, c, v] = lines[i].split(',').map(Number);
      if (Number.isFinite(t)) candles.push({ t, open: o, high: h, low: l, close: c, volume: v || 0 });
    }
    candles.sort((a, b) => a.t - b.t);
    this.cache[symbol.id] = candles;
    return candles;
  }

  async getCandlesForDate(symbol, dateKey) {
    const { istDateKey } = require('../time');
    return this.load(symbol).filter((c) => istDateKey(c.t) === dateKey);
  }

  async getLTP(symbol) {
    const all = this.load(symbol);
    return all.length ? all[all.length - 1].close : NaN;
  }
}

module.exports = { FixtureProvider };
