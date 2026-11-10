'use strict';

// Replay the strategy over a candle CSV (header: t,open,high,low,close[,volume],
// t = epoch ms) and print the final state + every signal. Useful for checking
// the JS port against TradingView on the same period.
//   node tools/replay.js candles.csv [lotSize]

const fs = require('fs');
const { runStrategy } = require('../src/strategy');
const { istFullStr } = require('../src/time');

const file = process.argv[2];
const lotSize = Number(process.argv[3] || 25);
if (!file) {
  console.error('Usage: node tools/replay.js <candles.csv> [lotSize]');
  process.exit(1);
}

const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
const candles = [];
for (let i = 1; i < lines.length; i++) {
  const [t, o, h, l, c, v] = lines[i].split(',').map(Number);
  if (Number.isFinite(t)) candles.push({ t, open: o, high: h, low: l, close: c, volume: v || 0 });
}
candles.sort((a, b) => a.t - b.t);

const run = runStrategy(candles, lotSize);
console.log(`Candles: ${candles.length} (${istFullStr(candles[0].t)} -> ${istFullStr(candles[candles.length - 1].t)})`);
console.log(`Signals: ${run.signals.length}`);
let total = 0;
for (const s of run.signals) {
  const pts = s.points !== undefined ? ` ${s.points >= 0 ? '+' : ''}${s.points} pts` : '';
  if (s.points !== undefined) total += s.points;
  console.log(`${s.dateKey} ${s.timeIST}  ${s.type.padEnd(7)} @ ${s.price.toFixed(2)}${pts}  (${s.reason})`);
}
console.log(`Closed-trade total: ${Math.round(total * 100) / 100} pts`);
console.log('Open position:', run.position ? `${run.position.side} @ ${run.position.entryPrice}` : 'none');
const last = candles.length - 1;
console.log(`Last bar: ST=${run.stValue[last].toFixed(2)} dir=${run.direction[last]} EMA13=${run.ema[last].toFixed(2)} RES=${run.resAt[last]} SUP=${run.supAt[last]}`);
