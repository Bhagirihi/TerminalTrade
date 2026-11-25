'use strict';

// Run the V3 screenshot-plan rules on candles and print the verdict.
//   node examples/run-rules.js                 → demo on synthetic candles (no token needed)
//   node examples/run-rules.js --candles5m 5m.json --candles15m 15m.json
//                                              → run on your own candles (JSON arrays of
//                                                { t, open, high, low, close, volume },
//                                                closed bars only, oldest first)
//
// With real candles: 5m needs 60+ bars, 15m needs 50+ bars. Liquidity shows
// as "no data" unless you pass --liquidity-ok (live option quotes required).

const fs = require('fs');
const path = require('path');
const { evaluateEntry } = require('../src/entry-rules');
const { scoreTrade } = require('../src/trade-score');
const { classifyRegime } = require('../src/regime');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

// Demo candles: a steady rising market (120 x 5m, 60 x 15m).
function demoBars(n, stepMs) {
  const out = [];
  let t = Date.parse('2026-11-25T09:15:00+05:30');
  let prev = 25000;
  for (let i = 0; i < n; i++) {
    const open = prev;
    const close = open * 1.0008;
    out.push({
      t: t + i * stepMs, open,
      high: Math.max(open, close) * 1.0004,
      low: Math.min(open, close) * 0.9998,
      close, volume: 1000 + i * 10,
    });
    prev = close;
  }
  return out;
}

function main() {
  const f5 = arg('--candles5m');
  const f15 = arg('--candles15m');
  const bars5 = f5 ? loadJson(f5) : demoBars(120, 5 * 60 * 1000);
  const bars15 = f15 ? loadJson(f15) : demoBars(60, 15 * 60 * 1000);
  if (!f5) console.log('(demo candles — pass --candles5m/--candles15m to use real data)\n');

  const entry = evaluateEntry(bars5);
  if (!entry.evaluable) {
    console.log('Entry:', entry.reason);
    return;
  }
  console.log('Entry:', entry.passed
    ? `${entry.side} ${entry.entryType} — ${JSON.stringify(entry.conditions)}`
    : `no setup — ${JSON.stringify(entry.conditions)}`);
  console.log('Values:', JSON.stringify(entry.values, (k, v) => (typeof v === 'number' ? +v.toFixed(2) : v)));

  if (entry.passed) {
    const score = scoreTrade({
      side: entry.side, entry, bars5, bars15,
      liquidityOk: arg('--liquidity-ok') === 'true' ? true : null,
    });
    console.log(`\nScore: ${score.score}/${score.max} (${score.verdict}) — tradeable: ${score.tradeable}, R:R 1:${score.riskReward}`);
    for (const c of score.checks) console.log(`  ${c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '?'} ${c.label} — ${c.scored}/${c.points}`);
  }

  const regime = classifyRegime(bars5);
  console.log('\nRegime:', regime.evaluable ? regime.label : regime.reason);
  if (regime.features) {
    console.log(`  ADX ${+regime.features.adx.toFixed(1)}, ATR ${+regime.features.atrPct.toFixed(2)}% (median ${+regime.features.atrMedian.toFixed(2)}%), RSI ${+regime.features.rsi.toFixed(0)}`);
  }
}

main();
