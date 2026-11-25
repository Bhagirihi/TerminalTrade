'use strict';

// Tests for prefetch (tools/muhurat-backtest-stocks.js fetchStocksData).
// No network: a stub provider returns synthetic candles; the cache lives in
// a temp dir (MUHURAT_BACKTEST_CACHE), so the real cache is untouched.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'muhurat-prefetch-'));
process.env.MUHURAT_BACKTEST_CACHE = TMP;

const { fetchStocksData, runStocksBacktest } = require('../tools/muhurat-backtest-stocks');

const noop = () => {};

// Synthetic candles: daily bars drift +0.25% (every 5th day -0.2%), 1m bars
// flat around the open. Same shapes as the provider's real output.
function dayMs(dateKey) {
  return Date.parse(`${dateKey}T09:15:00+05:30`);
}

function syntheticDaily(fromKey, toKey) {
  const bars = [];
  let close = 100;
  let t = dayMs(fromKey);
  const end = dayMs(toKey);
  let i = 0;
  while (t <= end) {
    const d = new Date(t);
    const weekday = d.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      const pct = i % 5 === 4 ? -0.2 : 0.25;
      close *= 1 + pct / 100;
      bars.push({ t, open: close / (1 + pct / 100), high: close * 1.007, low: close * 0.993, close, volume: 100000 });
      i += 1;
    }
    t += 86400000;
  }
  return bars;
}

function syntheticMinutes(fromKey, toKey) {
  const bars = [];
  let t = dayMs(fromKey);
  const end = dayMs(toKey);
  while (t <= end) {
    const d = new Date(t);
    const weekday = d.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      let prev = 110;
      for (let m = 0; m < 375; m += 1) {
        const close = prev * 1.0001;
        bars.push({ t: t + m * 60000, open: prev, high: Math.max(prev, close) * 1.001, low: Math.min(prev, close) * 0.999, close, volume: 1000 });
        prev = close;
      }
    }
    t += 86400000;
  }
  return bars;
}

function stubProvider() {
  const calls = { daily: 0, minute: 0 };
  return {
    calls,
    async getDailyCandles(_key, from, to) {
      calls.daily += 1;
      return syntheticDaily(from, to);
    },
    async getMinuteCandles(_key, from, to) {
      calls.minute += 1;
      return syntheticMinutes(from, to);
    },
  };
}

const ARGS = { from: '2026-11-10', to: '2026-11-13', years: 1, budget: 15000, confirmSec: 60, maxTrades: 5, noFetch: false, symbols: ['SBIN', 'RELIANCE'] };

test('prefetch downloads daily + 1m into the cache, second run hits only cache', async () => {
  const stub = stubProvider();
  const first = await fetchStocksData(ARGS, noop, stub);
  assert.ok(first.tradingDays.length >= 3, `trading days found: ${first.tradingDays.join(',')}`);
  assert.strictEqual(first.fetched.daily, 2, 'both daily series fetched');
  assert.strictEqual(first.fetched.minuteMonths, 2, 'one month x two symbols fetched');
  assert.strictEqual(first.cacheHits.daily, 0);
  assert.ok(fs.existsSync(path.join(TMP, 'daily_SBIN_2026-07-13_2026-11-13.json')), 'daily cache file written');
  assert.ok(fs.existsSync(path.join(TMP, 'minute1_SBIN_2026-11.json')), '1m cache file written');

  const callsAfterFirst = { ...stub.calls };
  const second = await fetchStocksData(ARGS, noop, stub);
  assert.strictEqual(second.fetched.daily, 0, 'nothing re-fetched');
  assert.strictEqual(second.fetched.minuteMonths, 0);
  assert.strictEqual(second.cacheHits.daily, 2);
  assert.strictEqual(second.cacheHits.minuteMonths, 2);
  assert.deepStrictEqual(stub.calls, callsAfterFirst, 'provider not called again');
  assert.deepStrictEqual(second.tradingDays, first.tradingDays);
});

test('runStocksBacktest replays purely from the warm cache (--no-fetch)', async () => {
  const stub = stubProvider();
  await fetchStocksData(ARGS, noop, stub);
  const callsBeforeReplay = { ...stub.calls };
  const out = await runStocksBacktest({ ...ARGS, noFetch: true }, noop);
  assert.strictEqual(out.from, '2026-11-10');
  assert.strictEqual(out.to, '2026-11-13');
  assert.ok(out.dayResults.length >= 3, 'one result per trading day');
  assert.ok(out.summary, 'summary computed');
  assert.ok(fs.existsSync(out.reportPath), 'report JSON written');
  assert.deepStrictEqual(stub.calls, callsBeforeReplay, 'the replay fetched nothing');
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
