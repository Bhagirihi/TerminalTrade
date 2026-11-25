'use strict';

// Probe what the Upstox API can actually return for a muhurat backtest.
// Run on the server after the morning login (needs a fresh UPSTOX_ACCESS_TOKEN):
//   node tools/muhurat-backtest-probe.js
// Writes cache/muhurat-backtest/probe-<YYYY-MM-DD>.json and prints PASS/FAIL per test.
//
// Tests: (1) auth, (2) 370-day daily candles + today's-partial-bar behaviour,
// (3) 15m month, (4) 1m single day (first/last bar times), (5) 1m month range
// (truncation?), (6) expired weekly option contract candles for NIFTY and
// BANKNIFTY — the decisive test for the options lane, (7) split/bonus scan
// across the 33 fixed names, (8) expired monthly futures candles (NIFTY +
// BANKNIFTY).
//
// Expiries are read from the NSE master itself, never assumed from a weekday:
// NSE moved the NIFTY weekly expiry (Thursday → Monday, Oct 2025), so a
// hardcoded weekday would pick the wrong contract.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { config } = require('../src/config');
const { UpstoxProvider } = require('../src/data/upstox');
const { CORE, EXTRA } = require('../src/muhurat');
const { istDateKey } = require('../src/time');

const CACHE = path.join(__dirname, '..', 'cache', 'muhurat-backtest');
const NSE_MASTER = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';
const SBIN = CORE.find((c) => c.ticker === 'SBIN');
const NIFTY_INDEX_KEY = 'NSE_INDEX|Nifty 50';
const UNDERLYINGS = [
  { name: 'NIFTY', indexKey: 'NSE_INDEX|Nifty 50' },
  { name: 'BANKNIFTY', indexKey: 'NSE_INDEX|Nifty Bank' },
];

function shiftDays(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function shiftMonths(dateKey, months) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function barDateKey(t) {
  return istDateKey(t);
}

function hhmm(t) {
  const d = new Date(t + 5.5 * 3600 * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

async function fetchNseMaster() {
  const res = await fetch(NSE_MASTER, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`NSE master ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const json = zlib.gunzipSync(buf).toString('utf8');
  const rows = JSON.parse(json);
  return Array.isArray(rows) ? rows : [];
}

// --- NSE master helpers (pure; unit-tested) --------------------------------
// Expiry dates in the master are the source of truth — weekly expiry weekdays
// change (NIFTY weekly moved Thursday → Monday in Oct 2025), so never assume
// one. `name` is 'NIFTY' or 'BANKNIFTY'.

function expiryList(master, name) {
  const set = new Set();
  for (const r of master) {
    const nm = String(r.name || '').toUpperCase();
    const sym = String(r.tradingsymbol || r.trading_symbol || '').toUpperCase();
    if (nm !== name && !symbolFor(name, sym)) continue;
    const exp = String(r.expiry || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(exp)) set.add(exp);
  }
  return [...set].sort();
}

function expiryOnOrBefore(expiries, target) {
  let best = null;
  for (const e of expiries) {
    if (e <= target) best = e;
    else break;
  }
  return best;
}

function strikeOf(r) {
  return Number(r.strike_price != null ? r.strike_price : r.strike);
}

function symbolOf(r) {
  return String(r.tradingsymbol || r.trading_symbol || '');
}

// Symbol belongs to `name` when it starts with the name followed by a digit
// (the expiry year, e.g. NIFTY26AUG25700CE). A bare startsWith would also
// match NIFTYIT / NIFTYMIDCAP, and 'BANKNIFTY…' contains 'NIFTY' as a
// substring, so neither a loose prefix nor includes() is safe.
function symbolFor(name, sym) {
  return sym.startsWith(name) && /\d/.test(sym[name.length] || '');
}

function optionContracts(master, name, expiry) {
  return master.filter((r) => {
    const sym = symbolOf(r);
    const nm = String(r.name || '');
    const type = String(r.instrument_type || '');
    return String(r.instrument_key || '').startsWith('NSE_FO')
      && String(r.expiry || '').slice(0, 10) === expiry
      && (symbolFor(name, sym) || nm.toUpperCase() === name)
      && (type === 'CE' || type === 'PE' || /CE$/.test(sym) || /PE$/.test(sym));
  });
}

function futureContracts(master, name, expiry) {
  return master.filter((r) => {
    const sym = symbolOf(r);
    const nm = String(r.name || '');
    const type = String(r.instrument_type || '');
    return String(r.instrument_key || '').startsWith('NSE_FO')
      && String(r.expiry || '').slice(0, 10) === expiry
      && (symbolFor(name, sym) || nm.toUpperCase() === name)
      && (type === 'FUT' || /FUT$/.test(sym));
  });
}

function pickAtmCe(contracts, close) {
  const withStrike = contracts.filter((r) => Number.isFinite(strikeOf(r)));
  if (!withStrike.length) return null;
  withStrike.sort((a, b) => Math.abs(strikeOf(a) - close) - Math.abs(strikeOf(b) - close));
  return withStrike.find((r) => String(r.instrument_type || '').includes('CE') || /CE$/.test(symbolOf(r)))
    || withStrike[0];
}

async function main() {
  if (!config.upstox.accessToken) {
    console.error('Set UPSTOX_ACCESS_TOKEN in .env (run npm run login first)');
    process.exit(1);
  }
  const provider = new UpstoxProvider(config.upstox.accessToken);
  const today = istDateKey(Date.now());
  const yesterday = shiftDays(today, -1);
  const results = { generatedAt: new Date().toISOString(), today, tests: {} };
  const report = (name, ok, detail) => {
    results.tests[name] = { ok, ...detail };
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && detail.note ? ` — ${detail.note}` : ''}`);
    if (detail) {
      for (const [k, v] of Object.entries(detail)) {
        if (k === 'note') continue;
        console.log(`      ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
      }
    }
  };

  // 1. Auth.
  try {
    const ltp = await provider.getLTP({ upstoxKey: NIFTY_INDEX_KEY });
    report('auth', true, { note: `NIFTY LTP ${ltp}` });
  } catch (err) {
    report('auth', false, { note: err.message.slice(0, 160) });
    console.error('Token invalid — aborting the rest of the probe.');
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(path.join(CACHE, `probe-${today}.json`), JSON.stringify(results, null, 2));
    process.exit(1);
  }

  // 2. Daily candles, 370 days, toDate = today: does the last bar include today?
  try {
    const from = shiftDays(today, -370);
    const bars = await provider.getDailyCandles(SBIN.key, from, today);
    const last = bars[bars.length - 1];
    const lastKey = last ? barDateKey(last.t) : null;
    report('daily_370d', bars.length > 200, {
      bars: bars.length,
      first: bars.length ? barDateKey(bars[0].t) : null,
      last: lastKey,
      todayPartialBar: lastKey === today,
      note: lastKey === today
        ? 'last bar IS today (partial) — live screens include it; backtest uses bars < day D'
        : 'last bar is yesterday or earlier — daily series ends at last close',
    });
  } catch (err) {
    report('daily_370d', false, { note: err.message.slice(0, 160) });
  }

  // 3. 15m candles, one full month (~2 months ago).
  try {
    const mFrom = shiftMonths(today, -2).slice(0, 8) + '01';
    const mTo = shiftDays(shiftMonths(mFrom, 1), -1);
    const bars = await provider.getMinuteCandles(SBIN.key, mFrom, mTo, 15);
    report('minutes15_month', bars.length > 500, {
      bars: bars.length,
      from: mFrom,
      to: mTo,
      first: bars.length ? `${barDateKey(bars[0].t)} ${hhmm(bars[0].t)}` : null,
      last: bars.length ? `${barDateKey(bars[bars.length - 1].t)} ${hhmm(bars[bars.length - 1].t)}` : null,
    });
  } catch (err) {
    report('minutes15_month', false, { note: err.message.slice(0, 160) });
  }

  // 4. 1m candles, one past trading day: first/last bar times (session open = first bar?).
  try {
    let day = shiftDays(today, -3);
    let bars = [];
    for (let i = 0; i < 7 && !bars.length; i += 1) {
      bars = await provider.getCandlesForDate({ upstoxKey: SBIN.key }, day, 1, false);
      if (!bars.length) day = shiftDays(day, -1);
    }
    report('minutes1_day', bars.length > 300, {
      day,
      bars: bars.length,
      firstBar: bars.length ? hhmm(bars[0].t) : null,
      lastBar: bars.length ? hhmm(bars[bars.length - 1].t) : null,
      firstOpen: bars.length ? bars[0].open : null,
      note: bars.length && hhmm(bars[0].t) === '09:15'
        ? 'first bar is 09:15 — session open = candles[0].open, as live assumes'
        : 'first bar is NOT 09:15 — check pre-open bars before trusting session-open',
    });
  } catch (err) {
    report('minutes1_day', false, { note: err.message.slice(0, 160) });
  }

  // 5. 1m candles, one full month range: truncated?
  try {
    const mFrom = shiftMonths(today, -2).slice(0, 8) + '01';
    const mTo = shiftDays(shiftMonths(mFrom, 1), -1);
    const bars = await provider.getMinuteCandles(SBIN.key, mFrom, mTo, 1);
    const days = new Set(bars.map((b) => barDateKey(b.t))).size;
    report('minutes1_month', bars.length > 5000, {
      bars: bars.length,
      daysCovered: days,
      from: mFrom,
      to: mTo,
      note: bars.length > 5000
        ? 'month of 1m bars returned in one ranged call — no truncation seen'
        : 'FEWER bars than a full month (~8k expected) — range may be capped; backtest must chunk smaller',
    });
  } catch (err) {
    report('minutes1_month', false, { note: err.message.slice(0, 160) });
  }

  // 6. Expired weekly option contract candles — decisive for the options lane.
  // Expiry comes from the master (nearest expiry on/before ~90 days ago),
  // for NIFTY and BANKNIFTY separately.
  let master = null;
  try {
    master = await fetchNseMaster();
  } catch (err) {
    report('expired_option_candles', false, { note: `NSE master fetch failed: ${err.message.slice(0, 120)}` });
  }
  if (master) {
    for (const u of UNDERLYINGS) {
      const testName = `expired_option_candles_${u.name}`;
      try {
        const target = shiftDays(today, -90);
        const expiry = expiryOnOrBefore(expiryList(master, u.name), target);
        if (!expiry) {
          report(testName, false, { note: `no ${u.name} expiry on/before ${target} in the master` });
          continue;
        }
        const idxDaily = await provider.getDailyCandles(u.indexKey, shiftDays(expiry, -3), expiry);
        const closeAtExpiry = idxDaily.length ? idxDaily[idxDaily.length - 1].close : null;
        const opts = optionContracts(master, u.name, expiry);
        const picked = closeAtExpiry != null ? pickAtmCe(opts, closeAtExpiry) : null;
        if (!picked) {
          report(testName, false, {
            expiry,
            masterRows: master.length,
            matchingContracts: opts.length,
            indexCloseAtExpiry: closeAtExpiry,
            note: 'could not identify an expired ATM contract in the master — inspect master schema',
          });
          continue;
        }
        const key = picked.instrument_key;
        const daily = await provider.getDailyCandles(key, shiftDays(expiry, -30), expiry);
        const mins = await provider.getMinuteCandles(key, expiry, expiry, 1);
        report(testName, daily.length > 0 && mins.length > 0, {
          expiry,
          contract: symbolOf(picked) || key,
          instrumentKey: key,
          indexCloseAtExpiry: closeAtExpiry,
          dailyBars: daily.length,
          minuteBarsOnExpiryDay: mins.length,
          note: daily.length > 0 && mins.length > 0
            ? 'expired-contract candles ARE retained — options lane backtest is possible'
            : 'expired-contract candles NOT returned — options lane stays modelled, not measured',
        });
      } catch (err) {
        report(testName, false, { note: err.message.slice(0, 160) });
      }
    }
  }

  // 7. Split/bonus scan: any daily close jumping >25% day-on-day in the 33.
  try {
    const from = shiftDays(today, -370);
    const flags = [];
    for (const sym of [...CORE, ...EXTRA]) {
      const bars = await provider.getDailyCandles(sym.key, from, yesterday);
      for (let i = 1; i < bars.length; i += 1) {
        const prev = bars[i - 1].close;
        const cur = bars[i].close;
        if (prev > 0 && Math.abs(cur / prev - 1) > 0.25) {
          flags.push({ ticker: sym.ticker, date: barDateKey(bars[i].t), prevClose: prev, close: cur });
        }
      }
    }
    report('split_scan', true, {
      suspiciousDays: flags.length,
      flags: flags.slice(0, 20),
      note: flags.length
        ? 'days above need a manual check — a split/bonus breaks levels if candles are unadjusted'
        : 'no >25% single-day close jumps in the 33 over the last year',
    });
  } catch (err) {
    report('split_scan', false, { note: err.message.slice(0, 160) });
  }

  // 8. Expired monthly futures candles (NIFTY + BANKNIFTY) — the "Future"
  // half of the F&O data. Same master-driven expiry lookup as test 6.
  if (master) {
    for (const u of UNDERLYINGS) {
      const testName = `expired_futures_candles_${u.name}`;
      try {
        const target = shiftDays(today, -60);
        const expiry = expiryOnOrBefore(expiryList(master, u.name), target);
        if (!expiry) {
          report(testName, false, { note: `no ${u.name} expiry on/before ${target} in the master` });
          continue;
        }
        const futs = futureContracts(master, u.name, expiry);
        if (!futs.length) {
          report(testName, false, { expiry, note: `no ${u.name} FUT contract with expiry ${expiry} in the master` });
          continue;
        }
        const key = futs[0].instrument_key;
        const daily = await provider.getDailyCandles(key, shiftDays(expiry, -30), expiry);
        const mins = await provider.getMinuteCandles(key, expiry, expiry, 1);
        report(testName, daily.length > 0 && mins.length > 0, {
          expiry,
          contract: symbolOf(futs[0]) || key,
          instrumentKey: key,
          dailyBars: daily.length,
          minuteBarsOnExpiryDay: mins.length,
          note: daily.length > 0 && mins.length > 0
            ? 'expired futures candles ARE retained — futures backtest is possible'
            : 'expired futures candles NOT returned',
        });
      } catch (err) {
        report(testName, false, { note: err.message.slice(0, 160) });
      }
    }
  }

  fs.mkdirSync(CACHE, { recursive: true });
  const outPath = path.join(CACHE, `probe-${today}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  const passed = Object.values(results.tests).filter((t) => t.ok).length;
  const total = Object.keys(results.tests).length;
  console.log(`\nProbe: ${passed}/${total} passed. Saved ${outPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { expiryList, expiryOnOrBefore, optionContracts, futureContracts, pickAtmCe, strikeOf, symbolOf, symbolFor };
