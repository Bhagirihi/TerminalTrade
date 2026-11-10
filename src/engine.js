'use strict';

const fs = require('fs');
const path = require('path');
const { config, SYMBOLS, angelConfigured } = require('./config');
const { UpstoxProvider } = require('./data/upstox');
const { UpstoxFeed } = require('./data/upstox-feed');
const { AngelProvider } = require('./data/angelone');
const { FixtureProvider } = require('./data/fixture');
const { runStrategy } = require('./strategy');
const { runCeSignals } = require('./strategy-ce');
const { supertrendSeries } = require('./supertrend');
const { createPremiumTrail, updatePremiumTrail, premiumTrailLevel } = require('./premium-trail');
const { nearestListedStrike, nearestStepStrike } = require('./strikes');
const { buildPaperTrades, summarizePaper } = require('./paper');
const { updatePaperPlan, viewTrades } = require('./paper-plan');
const { summarizeLive } = require('./portfolio');
const { screenHolding } = require('./portfolio-screen');
const { istParts, istDateKey, istTimeStr, istFullStr, istToEpoch } = require('./time');
const { openingRead } = require('./predict');
const { earlyTrigger, priorSessionSide } = require('./early');
const { resolveCommodities } = require('./commodities');
const { createMegaBull } = require('./data/megabull');
const { syncMegaBull } = require('./megabull-sync');

// Engine: keeps warm candles per symbol, runs the strategy on finished bars
// plus the candle that is still trading, and locks a signal at the moment it
// fires so a later tick cannot take it back. Live LTP updates that candle.

function recentDateKeys(days) {
  const keys = [];
  const now = Date.now();
  for (let d = days - 1; d >= 0; d--) keys.push(istDateKey(now - d * 86400000));
  return keys;
}

function isWeekend(dateKey) {
  const wd = new Date(`${dateKey}T12:00:00+05:30`).getUTCDay();
  return wd === 0 || wd === 6;
}

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function sessionLabel(epoch) {
  const p = istParts(epoch);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[p.weekday]} ${p.day} ${months[p.month - 1]}`;
}

function shiftDateKey(dateKey, days) {
  return istDateKey(Date.parse(`${dateKey}T12:00:00+05:30`) + days * 86400000);
}

function portfolioCards(holdings, ltpOf, techOf) {
  const cards = [];
  for (const row of holdings || []) {
    const qty = Number(row && row.quantity) || 0;
    const t1 = Number(row && row.t1_quantity) || 0;
    const units = qty !== 0 ? qty : t1;
    if (!units) continue;
    const avg = Number(row.average_price);
    if (!Number.isFinite(avg) || avg === 0) continue;
    const live = ltpOf ? ltpOf(row) : null;
    const last = Number.isFinite(live) ? live : Number(row.last_price);
    if (!Number.isFinite(last)) continue;
    const pnl = (last - avg) * units;
    const ticker = String((row.tradingsymbol || row.trading_symbol || row.company_name) || '—');
    const tech = typeof techOf === 'function' ? techOf(row, last, ticker, units, avg) : null;
    cards.push({
      ticker,
      qty: units,
      last: round2(last),
      pnl: round2(pnl),
      pnlPct: round2(((last - avg) / avg) * 100),
      sma50: tech && tech.sma50 != null ? tech.sma50 : null,
      rsi: tech && tech.rsi != null ? tech.rsi : null,
      aboveSma: tech && tech.sma50 != null ? last > tech.sma50 : null,
    });
  }
  cards.sort((a, b) => a.pnl - b.pnl);
  return cards;
}

function snapshotLevels(position) {
  if (!position) return null;
  // CE positions store activeStop/activeTarget. Supertrend stores stopLoss/target.
  const stopLoss = position.stopLoss ?? position.activeStop ?? null;
  const target = position.target ?? position.activeTarget ?? null;
  return {
    initialStop: position.initialStop ?? null,
    stopLoss,
    trailingStop: position.trailingStop ?? null,
    target,
    trailingTarget: position.trailingTarget ?? null,
    peak: position.peak,
    trailOn: !!position.trailOn,
  };
}

function ceMomentKey(symbol) {
  return `${symbol.id}_CE`;
}

function barOf(signal) {
  return signal && signal.barT != null ? signal.barT : signal ? signal.t : null;
}

function rightOf(row) {
  if (!row) return null;
  if (row.right === 'CE' || row.right === 'PE') return row.right;
  const type = row.type || '';
  if (type.includes('CE')) return 'CE';
  if (type.includes('PE')) return 'PE';
  if (row.side === 'LONG') return 'CE';
  if (row.side === 'SHORT') return 'PE';
  return null;
}

function candlePremium(candles, barT) {
  if (!candles || barT == null) return null;
  let best = null;
  let bestDist = Infinity;
  for (const c of candles) {
    const dist = Math.abs(c.t - barT);
    if (dist < bestDist) {
      best = c;
      bestDist = dist;
    }
  }
  // The signal bar, allowing a small timestamp skew. The next 5-minute bar is too far.
  if (!best || bestDist > 2 * 60000) return null;
  return round2(best.close);
}

// Copy the locked strike, premium, and CE stop onto the signal that replays it.
function applyLockFields(signals, locks) {
  if (!locks || !locks.length) return signals;
  const map = new Map(locks.map((m) => [`${m.barT}|${m.type}`, m]));
  return signals.map((s) => {
    const lock = map.get(`${barOf(s)}|${s.type}`);
    if (!lock) return s;
    return {
      ...s,
      strike: lock.strike != null ? lock.strike : s.strike,
      right: lock.right || s.right,
      premium: lock.premium != null ? lock.premium : s.premium,
      stopLoss: s.stopLoss != null ? s.stopLoss : lock.stopLoss,
      target: s.target != null ? s.target : lock.target,
    };
  });
}

function contractPremium(book, strike, right) {
  if (!book || strike == null || !right) return null;
  const key = book.instruments[`${strike}|${right}`];
  const px = key && book.ltp ? Number(book.ltp[key]) : NaN;
  return round2(px);
}

// Start of the bar that is trading now, labeled by its open.
// At 11:24 on a 15-minute book that bar opened at 11:15. Null outside 09:15–15:30.
function liveBarStart(now, tfMin) {
  const p = istParts(now);
  const mins = p.hour * 60 + p.minute;
  if (mins < 9 * 60 + 15 || mins >= 15 * 60 + 30) return null;
  const slot = Math.floor(mins / tfMin) * tfMin;
  return istToEpoch(istDateKey(now), Math.floor(slot / 60), slot % 60);
}

function pickStrike(price, symbol, book) {
  if (book && book.strikes && book.strikes.length) return nearestListedStrike(price, book.strikes);
  return nearestStepStrike(price, symbol.strikeStep);
}

function indexAtOrBefore(closed, t) {
  let idx = -1;
  for (let i = 0; i < closed.length; i++) {
    if (closed[i].t <= t) idx = i;
    else break;
  }
  return idx;
}

// Walk the day's signals in order so an exit keeps the strike that was bought.
// Stop is the Supertrend at entry. Target is the pivot beyond the entry
// (resistance for a call, support for a put).
function withStrikes(signals, closed, run, symbol, book, optionCandles) {
  const indexOf = new Map(closed.map((c, i) => [c.t, i]));
  let held = null;
  return signals.map((s) => {
    const entry = s.type === 'BUY CE' || s.type === 'BUY PE';
    if (entry) {
      const at = barOf(s);
      const i = indexOf.has(at) ? indexOf.get(at) : indexOf.has(s.t) ? indexOf.get(s.t) : indexAtOrBefore(closed, at);
      const right = s.right || (s.type === 'BUY CE' ? 'CE' : 'PE');
      const strike = s.strike != null ? s.strike : pickStrike(s.price, symbol, book);
      const key = book && strike != null ? book.instruments[`${strike}|${right}`] : null;
      let stopLoss = null;
      let target = null;
      if (i >= 0 && run.stValue) {
        stopLoss = round2(run.stValue[i]);
        const rawTarget = right === 'CE' ? (run.resAt ? run.resAt[i] : NaN) : (run.supAt ? run.supAt[i] : NaN);
        const targetOk = right === 'CE' ? rawTarget > s.price : rawTarget < s.price;
        target = targetOk ? round2(rawTarget) : null;
      }
      held = { strike, right, key, stopLoss, target };
    }
    const stamped = Number.isFinite(Number(s.premium)) ? round2(Number(s.premium)) : null;
    const fromCandle = held ? candlePremium(optionCandles[held.key], barOf(s)) : null;
    const row = {
      ...s,
      strike: held ? held.strike : s.strike ?? null,
      right: held ? held.right : s.right ?? null,
      premium: held ? (stamped != null ? stamped : fromCandle) : s.premium ?? null,
      // A stop already on the signal (CE lane, or a locked Supertrend stop) wins.
      // Otherwise use the Supertrend / pivot levels at the entry bar.
      stopLoss: entry && held ? (s.stopLoss != null ? round2(Number(s.stopLoss)) : held.stopLoss) : null,
      target: entry && held ? (s.target != null ? round2(Number(s.target)) : held.target) : null,
    };
    if (!entry) held = null;
    return row;
  });
}

class Engine {
  constructor(onUpdate) {
    this.onUpdate = onUpdate || (() => {});
    this.providers = [];
    this.active = null;
    this.candles = {}; // symbolId -> Map<t, candle> (shared by both strategy lanes)
    this.fastCandles = {}; // symbolId -> Map<t, today's 1-minute candle>
    this.ltp = {}; // symbolId -> number
    this.state = { status: 'starting', source: null, feed: null, updatedAt: null, symbols: {} };
    this.lastFingerprint = '';
    this.feed = null;
    this.publishSoon = null;
    this.optionBooks = {}; // symbolId -> { expiry, strikes, instruments, ltp }
    this.optionCandles = {}; // option instrument key -> today's candles at the shared timeframe
    this.trackedOptionKeys = new Set();
    this.ticking = false;
    this.paperFp = '';
    this.portfolio = null;
    this.earlyMarks = {};
    this.moments = {}; // symbolId -> decisions taken on a live candle
    this.premiumTrailState = {}; // symbolId -> { entryTime, state } for the premium trailing exit
    this.portfolioRows = null; // { holdings, positions } raw rows from the last portfolio poll
    this.portfolioLtp = {}; // instrumentKey -> last tick LTP (live portfolio P&L)
    this.portfolioLtpTs = {}; // instrumentKey -> Date.now() of the last tick
    this.portfolioKeys = new Set(); // holding/position instrument keys on the feed
    this.dailyCloses = new Map(); // instrument key -> daily closes, oldest first
    this.techAt = 0;
    this.techLoading = false;
    this.commodities = [];
    this.megabull = config.megabull && config.megabull.enabled !== false ? createMegaBull() : null;
    this.megabullView = null;
    this.megabullSyncing = false;
    for (const s of SYMBOLS) {
      this.candles[s.id] = new Map();
      this.fastCandles[s.id] = new Map();
    }
  }

  buildProviders() {
    const want = config.dataSource;
    const list = [];
    if (want === 'fixture') {
      if (!config.fixtureDir) throw new Error('DATA_SOURCE=fixture but FIXTURE_DIR is not set');
      list.push(new FixtureProvider(config.fixtureDir));
      return list;
    }
    const upstox = config.upstox.accessToken ? new UpstoxProvider(config.upstox.accessToken) : null;
    const angel = angelConfigured() ? new AngelProvider(config.angel) : null;
    if (want === 'upstox') {
      if (!upstox) throw new Error('DATA_SOURCE=upstox but UPSTOX_ACCESS_TOKEN is missing in .env');
      list.push(upstox);
    } else if (want === 'angelone') {
      if (!angel) throw new Error('DATA_SOURCE=angelone but Angel credentials are incomplete in .env');
      list.push(angel);
    } else {
      // auto: Upstox first, Angel One as failover (both are realtime).
      if (upstox) list.push(upstox);
      if (angel) list.push(angel);
    }
    if (!list.length) {
      throw new Error(
        'No data source configured. Add UPSTOX_ACCESS_TOKEN (Upstox) or the ANGEL_* values (Angel One SmartAPI) to .env - see README.'
      );
    }
    return list;
  }

  marketSymbols() {
    return SYMBOLS.concat(this.commodities || []);
  }

  async loadCommodities() {
    try {
      const rows = await resolveCommodities(Date.now());
      this.commodities = rows;
      for (const symbol of rows) {
        if (!this.candles[symbol.id]) this.candles[symbol.id] = new Map();
        if (!this.fastCandles[symbol.id]) this.fastCandles[symbol.id] = new Map();
      }
      const label = rows.map((symbol) => `${symbol.name} ${symbol.contract} (${symbol.upstoxKey})`).join(', ');
      console.log(`[engine] commodities: ${label || 'none'}`);
    } catch (e) {
      this.commodities = [];
      console.error(`[engine] commodities: ${e.message}`);
    }
  }

  async fetchDay(provider, symbol, dateKey) {
    const isToday = dateKey === istDateKey(Date.now());
    const rows = await provider.getCandlesForDate(symbol, dateKey, config.timeframeMinutes, isToday);
    const map = this.candles[symbol.id];
    const now = Date.now();
    const tfMs = config.timeframeMinutes * 60000;
    for (const c of rows) {
      const prev = map.get(c.t);
      // The bar still trading keeps the higher high and lower low already
      // seen on the feed. Its close is the latest price.
      if (prev && c.t + tfMs > now) {
        const ltp = this.ltp[symbol.id];
        map.set(c.t, {
          t: c.t,
          open: c.open,
          high: Math.max(prev.high, c.high),
          low: Math.min(prev.low, c.low),
          close: Number.isFinite(ltp) ? ltp : c.close,
          volume: c.volume || 0,
        });
      } else {
        map.set(c.t, c);
      }
    }
  }

  async loadWarmup(provider) {
    const keys = recentDateKeys(config.warmupDays).filter((k) => !isWeekend(k));
    for (const symbol of this.marketSymbols()) {
      for (const k of keys) {
        try {
          await this.fetchDay(provider, symbol, k);
        } catch (e) {
          console.error(`[engine] warmup ${symbol.id} ${k} via ${provider.name}: ${e.message}`);
        }
      }
    }
  }

  async refreshFast(provider) {
    const today = istDateKey(Date.now());
    for (const symbol of SYMBOLS) {
      try {
        const rows = await provider.getCandlesForDate(symbol, today, 1, true);
        const map = this.fastCandles[symbol.id];
        for (const c of rows) {
          if (istDateKey(c.t) === today) map.set(c.t, c);
        }
      } catch (e) {
        console.error(`[engine] 1m ${symbol.id} via ${provider.name}: ${e.message}`);
      }
    }
  }

  async refreshToday(provider) {
    const today = istDateKey(Date.now());
    const streaming = provider.name === 'UPSTOX' && this.feed && this.feed.connected;
    for (const symbol of this.marketSymbols()) {
      try {
        await this.fetchDay(provider, symbol, today);
      } catch (e) {
        if (symbol.kind !== 'commodity') throw e;
        console.error(`[engine] candles ${symbol.id} via ${provider.name}: ${e.message}`);
      }
      if (streaming) continue;
      try {
        const ltp = await provider.getLTP(symbol);
        if (Number.isFinite(ltp)) this.ltp[symbol.id] = ltp;
      } catch (e) {
        console.error(`[engine] LTP ${symbol.id} via ${provider.name}: ${e.message}`);
      }
    }
  }

  async refreshOptions(provider) {
    if (!provider || provider.name !== 'UPSTOX') return;
    const today = istDateKey(Date.now());
    for (const symbol of SYMBOLS) {
      try {
        let book = this.optionBooks[symbol.id];
        if (!book || book.day !== today) {
          const contracts = await provider.getOptionContracts(symbol.upstoxKey);
          const expiries = [...new Set(contracts.map((c) => c.expiry))].filter((e) => e >= today).sort();
          const expiry = expiries[0];
          if (!expiry) continue;
          const listed = contracts.filter((c) => c.expiry === expiry);
          const instruments = {};
          for (const c of listed) instruments[`${c.strike_price}|${c.instrument_type}`] = c.instrument_key;
          book = {
            day: today,
            expiry,
            strikes: [...new Set(listed.map((c) => c.strike_price))].sort((a, b) => a - b),
            instruments,
            ltp: {},
            ltpTs: {}, // instrumentKey -> Date.now() of the last tick (freshness gate for the premium trail)
          };
          this.optionBooks[symbol.id] = book;
        }
        const chain = await provider.getOptionChain(symbol.upstoxKey, book.expiry);
        const ltp = {};
        for (const row of chain) {
          for (const side of ['call_options', 'put_options']) {
            const opt = row[side];
            const px = opt && opt.market_data && opt.market_data.ltp;
            if (opt && opt.instrument_key && Number.isFinite(px)) ltp[opt.instrument_key] = px;
          }
        }
        book.ltp = ltp;
        // Seed tick timestamps with the snapshot time: the chain LTPs were just
        // observed, so they count as fresh until staleMs passes without a tick.
        const snapTs = Date.now();
        book.ltpTs = book.ltpTs || {};
        for (const key of Object.keys(ltp)) book.ltpTs[key] = snapTs;

      } catch (e) {
        console.error(`[engine] options ${symbol.id}: ${e.message}`);
      }
    }
  }

  // Contracts both lanes still need, on the shared candle timeframe.
  contractsWanted(symbol, book) {
    const today = istDateKey(Date.now());
    const out = [];
    const seen = new Set();
    const add = (row, tf) => {
      const right = rightOf(row);
      const strike = row.strike != null ? row.strike : pickStrike(row.price, symbol, book);
      if (strike == null || !right) return;
      const key = book.instruments[`${strike}|${right}`];
      if (!key) return;
      const id = `${key}|${tf}`;
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ key, tf });
    };
    const walk = (list, tf) => {
      for (const m of list || []) {
        if (!m || m.dateKey !== today) continue;
        if (m.type !== 'BUY CE' && m.type !== 'BUY PE' && m.type !== 'EXIT CE' && m.type !== 'EXIT PE' && m.type !== 'SQOFF') continue;
        add(m, tf);
      }
    };
    walk(this.moments[symbol.id], config.timeframeMinutes);
    walk(this.moments[ceMomentKey(symbol)], config.timeframeMinutes);
    return out;
  }

  async fetchTrackedCandles(provider) {
    if (!provider || provider.name !== 'UPSTOX') return;
    const today = istDateKey(Date.now());
    for (const symbol of SYMBOLS) {
      const book = this.optionBooks[symbol.id];
      if (!book) continue;
      for (const job of this.contractsWanted(symbol, book)) {
        this.trackedOptionKeys.add(job.key);
        try {
          this.optionCandles[job.key] = await provider.getCandlesForDate({ upstoxKey: job.key }, today, job.tf, true);
        } catch (e) {
          console.error(`[engine] option candles ${job.key}: ${e.message}`);
        }
      }
    }
  }

  // Fill a missing strike from the listed book (or the index step) and a missing
  // premium from that bar's option candle. A still-open bar may use the live
  // LTP once. A closed bar never takes today's live price as its fill.
  stampLock(lock, symbol, book, tfMin, now) {
    if (!lock) return false;
    let changed = false;
    const right = rightOf(lock);
    if (right && lock.right !== right) {
      lock.right = right;
      changed = true;
    }
    if (lock.strike == null) {
      const strike = pickStrike(lock.price, symbol, book);
      if (strike != null) {
        lock.strike = strike;
        changed = true;
      }
    }
    const key = book && lock.strike != null && right ? book.instruments[`${lock.strike}|${right}`] : null;
    if (key && lock.instrumentKey !== key) {
      lock.instrumentKey = key;
      changed = true;
    }
    if (lock.premium != null || !right) return changed;
    const fromCandle = candlePremium(key ? this.optionCandles[key] : null, lock.barT);
    const open = lock.barT != null && lock.barT + tfMin * 60000 > now;
    const px = fromCandle != null ? fromCandle : open ? contractPremium(book, lock.strike, right) : null;
    if (px != null) {
      lock.premium = px;
      changed = true;
    }
    return changed;
  }

  stampList(symbol, list, tfMin, now) {
    if (!list || !list.length) return false;
    const book = this.optionBooks[symbol.id];
    const today = istDateKey(now);
    let changed = false;
    for (const lock of list) {
      if (!lock || lock.dateKey !== today) continue;
      if (this.stampLock(lock, symbol, book, tfMin, now)) changed = true;
    }
    return changed;
  }

  stampAllMoments(now) {
    let changed = false;
    for (const symbol of SYMBOLS) {
      if (this.stampList(symbol, this.moments[symbol.id], config.timeframeMinutes, now)) changed = true;
      if (this.stampList(symbol, this.moments[ceMomentKey(symbol)], config.timeframeMinutes, now)) changed = true;
    }
    return changed;
  }

  syncOptionFeed() {
    if (this.feed && this.trackedOptionKeys.size) this.feed.subscribe([...this.trackedOptionKeys]);
  }

  // Keep the market feed subscribed to every holding/position instrument so
  // the portfolio P&L can be repriced from live ticks between the ~20s polls.
  syncPortfolioFeed() {
    if (this.feed && this.portfolioKeys.size) this.feed.subscribe([...this.portfolioKeys]);
  }

  // Live portfolio view: the REST snapshot's investment baseline, but P&L
  // repriced from the freshest feed ticks (older than 2 minutes counts as
  // stale and falls back to the snapshot). `live` tells the UI whether the
  // P&L number is really moving.
  livePortfolioView() {
    const base = this.portfolio;
    if (!base || base.error || !this.portfolioRows) return base;
    const now = Date.now();
    const ltp = this.portfolioLtp || {};
    const ts = this.portfolioLtpTs || {};
    const view = summarizeLive(
      this.portfolioRows.holdings,
      this.portfolioRows.positions,
      (row) => {
        const key = row && row.instrument_token != null ? String(row.instrument_token) : null;
        if (key == null) return null;
        const t = ts[key];
        if (t == null || now - t > 120000) return null;
        const n = Number(ltp[key]);
        return Number.isFinite(n) ? n : null;
      }
    );
    const priceOf = (row) => {
      const key = row && row.instrument_token != null ? String(row.instrument_token) : null;
      if (key == null) return null;
      const t = ts[key];
      const fresh = t != null && now - t <= 120000;
      const n = fresh ? Number(ltp[key]) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    const techOf = (row, last, ticker, units, avg) => {
      const key = row && row.instrument_token != null ? String(row.instrument_token) : '';
      const closes = key ? this.dailyCloses.get(key) : null;
      if (!closes || closes.length < 50) return null;
      const series = closes.slice();
      if (Number.isFinite(last)) series[series.length - 1] = last;
      return screenHolding({ ticker, buyPrice: avg, quantity: units, closes: series });
    };
    return { ...view, live: view.liveCount > 0, cards: portfolioCards(this.portfolioRows.holdings, priceOf, techOf) };
  }

  // Daily closes for the 50-day average and RSI. This stays off the price tick
  // so a slow history pull cannot stall the index quotes.
  async refreshHoldingTech(provider) {
    if (this.techLoading) return;
    if (!provider || typeof provider.getDailyCandles !== 'function' || !this.portfolioRows) return;
    const fresh = this.techAt && Date.now() - this.techAt < 10 * 60 * 1000 && this.dailyCloses.size;
    if (fresh) return;
    const holdings = this.portfolioRows.holdings || [];
    this.techLoading = true;
    try {
      const toDate = istDateKey(Date.now());
      const fromDate = shiftDateKey(toDate, -200);
      for (const row of holdings) {
        const key = row && row.instrument_token != null ? String(row.instrument_token) : '';
        if (!key) continue;
        try {
          const candles = await provider.getDailyCandles(key, fromDate, toDate);
          const closes = (candles || []).map((c) => Number(c.close)).filter((n) => Number.isFinite(n));
          this.dailyCloses.set(key, closes);
        } catch (err) {
          if (!this.dailyCloses.has(key)) this.dailyCloses.set(key, []);
          console.error(`[engine] daily ${key}: ${err.message}`);
        }
      }
      this.techAt = Date.now();
    } finally {
      this.techLoading = false;
    }
  }

  // The bar that is open now. Its close is the latest price, and its high and
  // low only widen. A tick before the poll arrives starts the bar.
  touchLiveCandle(symbolId, price, tfMin, map) {
    if (!Number.isFinite(price)) return;
    const now = Date.now();
    const tf = tfMin || config.timeframeMinutes;
    const start = liveBarStart(now, tf);
    const m = map || this.candles[symbolId];
    if (start == null || !m) return;
    let bar = m.get(start);
    if (!bar) {
      m.set(start, { t: start, open: price, high: price, low: price, close: price, volume: 0, provisional: true });
      return;
    }
    bar.close = price;
    if (price > bar.high) bar.high = price;
    if (price < bar.low) bar.low = price;
  }

  // Finished bars, plus the one bar still trading. A provisional bar that has
  // reached its close becomes a normal bar so a decision taken on it remains.
  candlesNow(symbolId, now, tfMin, map) {
    const tf = tfMin || config.timeframeMinutes;
    const tfMs = tf * 60000;
    const m = map || this.candles[symbolId];
    const start = liveBarStart(now, tf);
    for (const bar of m.values()) {
      if (bar.provisional && bar.t + tfMs <= now) delete bar.provisional;
    }
    const all = [...m.values()].sort((a, b) => a.t - b.t);
    const forming = start != null ? m.get(start) || null : null;
    const closed = all.filter((c) => c !== forming && c.t + tfMs <= now);
    const series = forming ? closed.concat([forming]) : closed;
    return { closed, forming, series };
  }

  // First confirming 5-minute bar after 09:15. Null until that bar has closed
  // with the prior session's Supertrend still in force.
  openTrigger(symbol, pack, now) {
    if (!pack.series.length) return null;
    const st = supertrendSeries(pack.series);
    const side = priorSessionSide(pack.closed, st.direction, now);
    if (!side) return null;
    const minutes = [...(this.fastCandles[symbol.id] || new Map()).values()];
    return earlyTrigger(minutes, side, now);
  }

  evaluate(symbol, now) {
    const pack = this.candlesNow(symbol.id, now);
    const day = istDateKey(now);
    const locks = (this.moments[symbol.id] || []).filter((m) => m.dateKey === day);
    const commodity = symbol.kind === 'commodity';
    const early = commodity ? null : this.openTrigger(symbol, pack, now);
    const p = istParts(now);
    const mins = p.hour * 60 + p.minute;
    const deferOpen = !commodity && mins >= 9 * 60 + 15 && mins < 9 * 60 + 30 && !early;
    const strat = config.strategy || {};
    const run = runStrategy(pack.series, symbol.lotSize, {
      locks,
      liveBarT: pack.forming ? pack.forming.t : null,
      now,
      earlyEntry: early || undefined,
      deferOpen: strat.flipOnly ? false : deferOpen,
      flipOnly: !!strat.flipOnly,
      emaExit: strat.emaExit !== false,
      emaExitBars: Number(strat.emaExitBars) || 0,
      ...(commodity ? { squareOffHour: 23, squareOffMinute: 15, openHour: 9, openMinute: 0 } : {}),
    });
    this.applyPremiumTrail(symbol, run, pack.forming, locks, day, now);
    this.commitLiveMoment(symbol, run, pack.forming, now);
    return { ...pack, run };
  }

  // Second strategy lane: CE Signals v3 on the same candles and symbols as
  // Supertrend. Locks live under `${id}_CE`, so the two strategies can hold
  // the same symbol independently.
  evaluateCe(symbol, now) {
    const pack = this.candlesNow(symbol.id, now);
    const day = istDateKey(now);
    const key = ceMomentKey(symbol);
    const locks = (this.moments[key] || []).filter((m) => m.dateKey === day);
    const run = runCeSignals(pack.series, {
      locks,
      liveBarT: pack.forming ? pack.forming.t : null,
      now,
      qty: symbol.lotSize,
    });
    this.applyPremiumTrail(symbol, run, pack.forming, locks, day, now, key);
    this.commitLiveMoment(symbol, run, pack.forming, now, key);
    return { ...pack, run };
  }

  // Premium-based trailing exit (design: ../trading/premium-trailing-exit-design.md).
  // The index strategy in strategy.js cannot see option premium, so a bought
  // option can bleed out on theta/IV crush while no index exit fires. This
  // trails the live premium of the position's own strike instead:
  //   - premium trailing exit: arms at +activatePts peak profit, exits on
  //     giveback keeping keepFrac of the peak premium profit (never a loss);
  //   - premium theta stop: exits at -maxLossFrac of entry premium, no arming.
  // Evaluated on the live engine only, after the index strategy ran. Fires at
  // most once per position; the exit is committed as a lock (like every other
  // exit) so later ticks replay it and a restart restores it from the saved
  // moments. Stale or missing premium keeps the trail inert — it never acts
  // on old prices.
  applyPremiumTrail(symbol, run, forming, locks, day, now, trailKey) {
    const tKey = trailKey || symbol.id;
    const cfg = config.premiumTrail;
    if (!cfg || !cfg.enabled || !run.position || !forming) return;
    const pos = run.position;
    const side = pos.side;
    const right = side === 'LONG' ? 'CE' : 'PE';
    const exitType = side === 'LONG' ? 'EXIT CE' : 'EXIT PE';

    const isPremiumExit = (m) =>
      m != null &&
      m.side === side &&
      (m.type === 'EXIT CE' || m.type === 'EXIT PE') &&
      (m.reason === 'Premium trailing exit' || m.reason === 'Premium stop (theta)');

    // Already exited by the premium trail (this session or a restarted one):
    // replay the locked exit instead of firing again.
    const done = locks.find((m) => isPremiumExit(m) && m.t > pos.entryTime);
    if (done) {
      run.signals.push({
        t: done.t,
        barT: done.barT,
        timeIST: done.timeIST,
        dateKey: day,
        type: done.type,
        side: done.side,
        price: done.price,
        qty: done.qty,
        reason: done.reason,
        premium: done.premium,
      });
      run.position = null;
      return;
    }

    const book = this.optionBooks[symbol.id];
    const entryLock = locks.find(
      (m) => (m.type === 'BUY CE' || m.type === 'BUY PE') && m.side === side && m.t === pos.entryTime
    );
    const entryPremium = entryLock && Number.isFinite(Number(entryLock.premium)) ? Number(entryLock.premium) : NaN;
    if (!Number.isFinite(entryPremium)) return; // no entry premium stamped: cannot trail

    // Same strike the entry used (pickStrike is deterministic on the entry price).
    const strike = pickStrike(entryLock ? entryLock.price : pos.entryPrice, symbol, book);
    const key = book && strike != null ? book.instruments[`${strike}|${right}`] : null;
    const px = key && book && book.ltp ? Number(book.ltp[key]) : NaN;
    const ts = key && book && book.ltpTs ? book.ltpTs[key] : null;
    const fresh = Number.isFinite(px) && ts != null && now - ts <= cfg.staleMs;
    if (!fresh) return;

    let mem = this.premiumTrailState[tKey];
    if (!mem || mem.entryTime !== pos.entryTime) {
      const snap = entryLock && entryLock.premiumTrail;
      mem = this.premiumTrailState[tKey] = {
        entryTime: pos.entryTime,
        state:
          snap && Number.isFinite(snap.peak)
            ? { entryPremium, premiumPeak: snap.peak, armed: !!snap.armed }
            : createPremiumTrail(entryPremium),
      };
    }
    const res = updatePremiumTrail(mem.state, px, cfg);
    // Persist the peak on the entry lock: moments are saved to paper/<day>.json,
    // so a restart restores the trail instead of resetting it (a reset would loosen it).
    if (entryLock) entryLock.premiumTrail = { peak: round2(mem.state.premiumPeak), armed: mem.state.armed };
    if (!res.exit) return;

    const reason = res.exit === 'theta' ? 'Premium stop (theta)' : 'Premium trailing exit';
    run.signals.push({
      t: now,
      barT: forming.t,
      timeIST: istTimeStr(now),
      dateKey: day,
      type: exitType,
      side,
      price: forming.close, // index price at the moment; premium P&L comes from `premium`
      qty: pos.qty,
      reason,
      premium: round2(px),
      // no `points`: this is a premium exit, kept out of the index-points day total
    });
    run.position = null;
  }

  // The first time the live candle breaks a level, keep that price, that
  // clock time, and the option premium. Later ticks replay the lock.
  // momentsKey defaults to the symbol id; the CE lane passes its own key so
  // the two strategies' locks never collide.
  commitLiveMoment(symbol, run, forming, now, momentsKey) {
    const mKey = momentsKey || symbol.id;
    const book = this.optionBooks[symbol.id];
    const day = istDateKey(now);
    const locks = (this.moments[mKey] || []).filter((m) => m.dateKey === day);
    const map = new Map(locks.map((m) => [`${m.barT}|${m.type}`, m]));
    let held = null;
    if (!forming) {
      this.lockClosedSignals(symbol, run, day, book, map);
      this.moments[mKey] = [...map.values()];
      return;
    }
    run.signals = run.signals.map((s) => {
      const entry = s.type === 'BUY CE' || s.type === 'BUY PE';
      const barT = s.barT != null ? s.barT : s.t;
      if (barT !== forming.t) {
        held = entry ? { price: s.price, right: s.type === 'BUY CE' ? 'CE' : 'PE' } : null;
        return s;
      }
      const key = `${barT}|${s.type}`;
      let lock = map.get(key);
      const right = entry ? (s.type === 'BUY CE' ? 'CE' : 'PE') : (held ? held.right : (s.side === 'LONG' ? 'CE' : 'PE'));
      const strike = pickStrike(entry || !held ? (lock ? lock.price : s.price) : held.price, symbol, book);
      const levels = entry ? snapshotLevels(run.position) : null;
      const stopLoss = round2(s.stopLoss != null ? Number(s.stopLoss) : levels && levels.stopLoss);
      const target = round2(s.target != null ? Number(s.target) : levels && levels.target);
      if (!lock) {
        lock = {
          dateKey: day,
          barT,
          t: s.t,
          timeIST: s.timeIST,
          type: s.type,
          side: s.side,
          price: s.price,
          qty: s.qty,
          reason: s.reason,
          strike,
          right,
          premium: contractPremium(book, strike, right),
          stopLoss,
          target,
          levels,
        };
        map.set(key, lock);
      } else {
        // Keep the first fill. Only fill holes, so a later tick cannot move the stop.
        if (lock.premium == null) lock.premium = contractPremium(book, strike, right);
        if (lock.strike == null && strike != null) lock.strike = strike;
        if (!lock.right && right) lock.right = right;
        if (lock.stopLoss == null && stopLoss != null) lock.stopLoss = stopLoss;
        if (lock.target == null && target != null) lock.target = target;
        if (entry && lock.levels == null && levels) lock.levels = levels;
      }
      held = entry ? { price: lock.price, right: s.type === 'BUY CE' ? 'CE' : 'PE' } : null;
      const row = { ...s, barT, t: lock.t, timeIST: lock.timeIST, price: lock.price, reason: lock.reason };
      if (lock.premium != null) row.premium = lock.premium;
      return row;
    });
    if (run.position) {
      const entryLock = [...map.values()].find((m) => (m.type === 'BUY CE' || m.type === 'BUY PE') && m.t === run.position.entryTime);
      if (entryLock && entryLock.barT === forming.t) entryLock.levels = snapshotLevels(run.position);
    }
    this.lockClosedSignals(symbol, run, day, book, map);
    this.moments[mKey] = [...map.values()];
  }

  // A finished bar keeps the price the strategy booked. Create the lock once
  // so a restart can still attach that bar's option candle as the premium.
  lockClosedSignals(symbol, run, day, book, map) {
    let held = null;
    for (const s of run.signals) {
      if (s.dateKey !== day) continue;
      const entry = s.type === 'BUY CE' || s.type === 'BUY PE';
      const barT = s.barT != null ? s.barT : s.t;
      const prior = held;
      const right = entry ? (s.type === 'BUY CE' ? 'CE' : 'PE') : prior ? prior.right : rightOf(s);
      held = entry ? { price: s.price, right } : null;
      const key = `${barT}|${s.type}`;
      if (map.has(key)) continue;
      const strike = s.strike != null ? s.strike : pickStrike(entry ? s.price : prior ? prior.price : s.price, symbol, book);
      const levels = entry ? snapshotLevels(run.position && run.position.entryTime === s.t ? run.position : null) : null;
      map.set(key, {
        dateKey: day,
        barT,
        t: s.t,
        timeIST: s.timeIST,
        type: s.type,
        side: s.side,
        price: s.price,
        qty: s.qty,
        reason: s.reason,
        strike,
        right,
        premium: Number.isFinite(Number(s.premium)) ? round2(Number(s.premium)) : null,
        stopLoss: round2(s.stopLoss != null ? Number(s.stopLoss) : levels && levels.stopLoss),
        target: round2(s.target != null ? Number(s.target) : levels && levels.target),
        levels,
      });
    }
  }

  liveCandleView(ltp, now, forming, tfMin) {
    const start = liveBarStart(now, tfMin || config.timeframeMinutes);
    if (start == null || !Number.isFinite(ltp)) return null;
    const same = forming && forming.t === start ? forming : null;
    return {
      timeIST: istTimeStr(start),
      open: same ? round2(same.open) : null,
      high: same ? round2(Math.max(same.high, ltp)) : null,
      low: same ? round2(Math.min(same.low, ltp)) : null,
      close: round2(ltp),
    };
  }

  onFeedTick(tick) {
    const symbol = this.marketSymbols().find((s) => s.upstoxKey === tick.instrumentKey);
    if (symbol) {
      this.ltp[symbol.id] = tick.ltp;
      this.touchLiveCandle(symbol.id, tick.ltp);
    } else if (this.trackedOptionKeys.has(tick.instrumentKey)) {
      for (const book of Object.values(this.optionBooks)) {
        if (book && book.ltp) {
          book.ltp[tick.instrumentKey] = tick.ltp;
          book.ltpTs = book.ltpTs || {};
          book.ltpTs[tick.instrumentKey] = Date.now();
        }
      }
    } else if (this.portfolioKeys.has(tick.instrumentKey)) {
      this.portfolioLtp[tick.instrumentKey] = tick.ltp;
      this.portfolioLtpTs[tick.instrumentKey] = Date.now();
    } else {
      return;
    }
    if (this.publishSoon) return;
    // Index ticks arrive many times a second. Publish at most once a second so
    // the dashboard price settles instead of repainting on every print.
    this.publishSoon = setTimeout(() => {
      this.publishSoon = null;
      try {
        this.publish();
      } catch (e) {
        console.error(`[engine] publish: ${e.message}`);
      }
    }, 1000);
  }

  syncFeed() {
    const upstox = this.active && this.active.name === 'UPSTOX' ? this.active : null;
    if (upstox && !this.feed) {
      this.feed = new UpstoxFeed(upstox.token, this.marketSymbols().map((s) => s.upstoxKey), (tick) => this.onFeedTick(tick));
      this.feed.start();
    } else if (!upstox && this.feed) {
      this.feed.stop();
      this.feed = null;
    }
  }

  computeState() {
    const now = Date.now();
    const todayKey = istDateKey(now);
    const out = {
      status: 'live',
      source: this.active ? this.active.name : null,
      feed: this.feed && this.feed.connected ? 'upstox' : null,
      updatedAt: istFullStr(now),
      symbols: {},
    };

    for (const symbol of this.marketSymbols()) {
      const { closed, forming, series, run } = this.evaluate(symbol, now);
      const last = series.length - 1;

      const todayCandles = closed.filter((c) => istDateKey(c.t) === todayKey);
      const prevDayCandles = closed.filter((c) => istDateKey(c.t) !== todayKey);
      const prevClose = prevDayCandles.length ? prevDayCandles[prevDayCandles.length - 1].close : null;
      const ltp = Number.isFinite(this.ltp[symbol.id])
        ? this.ltp[symbol.id]
        : forming
          ? forming.close
          : closed.length
            ? closed[closed.length - 1].close
            : null;

      const book = this.optionBooks[symbol.id];
      const locked = applyLockFields(run.signals, this.moments[symbol.id]);
      const struck = withStrikes(this.stampEarlyPremium(symbol, locked, book), series, run, symbol, book, this.optionCandles);
      const todaySignals = struck.filter((s) => s.dateKey === todayKey).map((s) => ({ ...s, strategy: 'Supertrend' }));
      const closedToday = todaySignals.filter((s) => s.points !== undefined);
      const dayPoints = closedToday.reduce((a, s) => a + s.points, 0);
      const entryRow = [...struck].reverse().find((s) => s.type === 'BUY CE' || s.type === 'BUY PE');

      let position = null;
      if (run.position) {
        const p = run.position;
        const openPoints = ltp != null ? (p.side === 'LONG' ? ltp - p.entryPrice : p.entryPrice - ltp) : null;
        const right = p.side === 'LONG' ? 'CE' : 'PE';
        const strike = entryRow && entryRow.right === right ? entryRow.strike : pickStrike(p.entryPrice, symbol, book);
        const key = book && strike != null ? book.instruments[`${strike}|${right}`] : null;
        const livePremium = key && book && book.ltp ? book.ltp[key] : null;
        position = {
          side: p.side,
          label: p.side === 'LONG' ? 'BUY CE' : 'BUY PE',
          entryPrice: p.entryPrice,
          entryTimeIST: istTimeStr(p.entryTime),
          qty: p.qty,
          openPoints: openPoints != null ? Math.round(openPoints * 100) / 100 : null,
          strike,
          right,
          premium: round2(livePremium),
          stopLoss: round2(p.stopLoss),
          trailingStop: round2(p.trailingStop),
          target: round2(p.target),
          trailingTarget: round2(p.trailingTarget),
          premiumTrail: this.premiumTrailView(symbol, p),
        };
      }

      out.symbols[symbol.id] = {
        name: symbol.name,
        contract: symbol.contract || null,
        kind: symbol.kind || 'index',
        lotSize: symbol.lotSize,
        ltp,
        prevClose,
        change: ltp != null && prevClose != null ? Math.round((ltp - prevClose) * 100) / 100 : null,
        changePct: ltp != null && prevClose ? Math.round(((ltp - prevClose) / prevClose) * 10000) / 100 : null,
        lastCandleTimeIST: closed.length ? istTimeStr(closed[closed.length - 1].t) : null,
        lastSession: closed.length ? sessionLabel(closed[closed.length - 1].t) : null,
        liveCandle: this.liveCandleView(ltp, now, forming),
        supertrend: last >= 0 ? Math.round(run.stValue[last] * 100) / 100 : null,
        direction: last >= 0 ? run.direction[last] : null, // -1 bullish, +1 bearish
        ema13: last >= 0 && Number.isFinite(run.ema[last]) ? Math.round(run.ema[last] * 100) / 100 : null,
        support: last >= 0 && Number.isFinite(run.supAt[last]) ? run.supAt[last] : null,
        resistance: last >= 0 && Number.isFinite(run.resAt[last]) ? run.resAt[last] : null,
        position,
        signalsToday: todaySignals,
        dayPoints: Math.round(dayPoints * 100) / 100,
        prediction: openingRead([...(this.fastCandles[symbol.id] || new Map()).values()], ltp, now),
        chart: series.slice(-100).map((c, k, arr) => {
          const gi = series.length - arr.length + k;
          return {
            timeIST: istTimeStr(c.t),
            close: c.close,
            st: Number.isFinite(run.stValue[gi]) && run.stValue[gi] > 0 ? Math.round(run.stValue[gi] * 100) / 100 : null,
            dir: run.direction[gi],
            ema: Number.isFinite(run.ema[gi]) ? Math.round(run.ema[gi] * 100) / 100 : null,
          };
        }),
      };
    }

    // Second strategy lane: same symbols and the same candles as Supertrend.
    // Separate position, signals, locks and paper trades.
    const ceLanes = {};
    for (const symbol of SYMBOLS) {
      const ceEval = this.evaluateCe(symbol, now);
      const ceRun = ceEval.run;
      const ceLast = ceEval.series.length - 1;
      const ceBook = this.optionBooks[symbol.id];
      const ceLtp = Number.isFinite(this.ltp[symbol.id])
        ? this.ltp[symbol.id]
        : ceEval.forming
          ? ceEval.forming.close
          : ceEval.closed.length
            ? ceEval.closed[ceEval.closed.length - 1].close
            : null;
      const ceKey = ceMomentKey(symbol);
      const ceLocked = applyLockFields(ceRun.signals, this.moments[ceKey]);
      const ceStruck = withStrikes(ceLocked, ceEval.series, ceRun, symbol, ceBook, this.optionCandles).map(
        (s) => ({ ...s, strategy: 'CE v3' })
      );
      const ceToday = ceStruck.filter((s) => s.dateKey === todayKey);
      const ceClosed = ceToday.filter((s) => s.points !== undefined);
      const ceDayPoints = ceClosed.reduce((a, s) => a + s.points, 0);
      const ceEntryRow = [...ceStruck].reverse().find((s) => s.type === 'BUY CE');

      let cePosition = null;
      if (ceRun.position) {
        const p = ceRun.position;
        const right = 'CE';
        const strike =
          ceEntryRow && ceEntryRow.right === right ? ceEntryRow.strike : pickStrike(p.entryPrice, symbol, ceBook);
        const key = ceBook && strike != null ? ceBook.instruments[`${strike}|${right}`] : null;
        const livePremium = key && ceBook && ceBook.ltp ? ceBook.ltp[key] : null;
        cePosition = {
          side: p.side,
          label: 'BUY CE',
          entryPrice: p.entryPrice,
          entryTimeIST: istTimeStr(p.entryTime),
          qty: p.qty,
          openPoints: ceLtp != null ? Math.round((ceLtp - p.entryPrice) * 100) / 100 : null,
          strike,
          right,
          premium: round2(livePremium),
          stopLoss: round2(p.activeStop),
          trailingStop: null,
          target: round2(p.activeTarget),
          trailingTarget: null,
          premiumTrail: this.premiumTrailView(symbol, p, ceKey),
        };
      }

      ceLanes[symbol.id] = {
        id: symbol.id,
        name: `${symbol.name} · CE v3`,
        indexName: symbol.name,
        timeframe: `${config.timeframeMinutes}m`,
        ltp: ceLtp,
        lastCandleTimeIST: ceEval.closed.length ? istTimeStr(ceEval.closed[ceEval.closed.length - 1].t) : null,
        liveCandle: this.liveCandleView(ceLtp, now, ceEval.forming),
        emaFast: ceLast >= 0 ? round2(ceRun.emaFast[ceLast]) : null,
        emaPB: ceLast >= 0 ? round2(ceRun.emaPB[ceLast]) : null,
        emaTrend: ceLast >= 0 ? round2(ceRun.emaTrend[ceLast]) : null,
        rsi: ceLast >= 0 ? round2(ceRun.rsi[ceLast]) : null,
        adx: ceLast >= 0 ? round2(ceRun.dmi.adx[ceLast]) : null,
        position: cePosition,
        signalsToday: ceToday,
        dayPoints: Math.round(ceDayPoints * 100) / 100,
        debug: ceRun.debug,
        lotSize: symbol.lotSize,
      };
    }
    out.ceStrategy = ceLanes;

    const trades = [];
    for (const symbol of SYMBOLS) {
      const s = out.symbols[symbol.id];
      if (!s) continue;
      trades.push(
        ...buildPaperTrades({
          index: symbol.name,
          indexId: symbol.id,
          signals: s.signalsToday,
          lotSize: symbol.lotSize,
          markPremium: s.position ? s.position.premium : null,
        }).map((t) => ({ ...t, strategy: 'Supertrend' }))
      );
      const ce = ceLanes[symbol.id];
      if (!ce) continue;
      trades.push(
        ...buildPaperTrades({
          index: symbol.name,
          indexId: ceMomentKey(symbol),
          signals: ce.signalsToday,
          lotSize: symbol.lotSize,
          markPremium: ce.position ? ce.position.premium : null,
        }).map((t) => ({ ...t, strategy: 'CE v3' }))
      );
    }
    trades.sort((a, b) => a.entryT - b.entryT || a.indexId.localeCompare(b.indexId));
    out.paper = summarizePaper(trades);
    out.portfolio = this.livePortfolioView();
    try {
      const plan = updatePaperPlan({ book: out.portfolio, symbols: out.symbols, now });
      out.paperPlan = {
        portfolioValue: plan.portfolioValue,
        sellTotal: plan.sellTotal,
        newBuyCash: plan.newBuyCash,
        newBuyCashStart: plan.newBuyCashStart,
        indexPool: plan.indexPool,
        commodityPool: plan.commodityPool,
        realized: plan.realized,
        unrealized: plan.unrealized,
        total: plan.total,
        holdCount: (plan.hold || []).length,
        sellCount: (plan.sell || []).length,
        trades: viewTrades(plan),
        squareOffSaved: !!plan.squareOffSaved,
      };
    } catch (e) {
      console.error(`[engine] paper plan: ${e.message}`);
      out.paperPlan = null;
    }
    out.megabull = this.megabullView;
    return out;
  }

  async refreshMegaBull() {
    if (!this.megabull || this.megabullSyncing) return;
    this.megabullSyncing = true;
    try {
      this.megabullView = await syncMegaBull(this.megabull, this.state || {});
      if (this.state) {
        this.state = { ...this.state, megabull: this.megabullView };
        this.onUpdate(this.state);
      }
    } catch (e) {
      console.error(`[engine] megabull: ${e.message}`);
      this.megabullView = {
        enabled: true,
        lastError: e.message,
        positions: [],
        openOrders: [],
        executedToday: [],
        log: [],
      };
    } finally {
      this.megabullSyncing = false;
    }
  }

  // Live view of the premium trailing exit for the dashboard. Null when the
  // feature is off, when there is no trail state for this position, or when
  // the position already exited.
  premiumTrailView(symbol, position, trailKey) {
    const tKey = trailKey || symbol.id;
    const mem = this.premiumTrailState[tKey];
    if (!config.premiumTrail || !config.premiumTrail.enabled || !mem || !position || mem.entryTime !== position.entryTime) {
      return null;
    }
    return {
      peak: round2(mem.state.premiumPeak),
      armed: mem.state.armed,
      level: premiumTrailLevel(mem.state, config.premiumTrail),
    };
  }

  async refreshPortfolio(provider) {
    if (!provider || provider.name !== 'UPSTOX' || typeof provider.getPortfolio !== 'function') {
      this.portfolio = null;
      return;
    }
    try {
      this.portfolio = await provider.getPortfolio();
      // Keep the raw rows so live P&L can be priced from feed ticks between polls.
      this.portfolioRows = {
        holdings: this.portfolio.holdingRows || [],
        positions: this.portfolio.positionRows || [],
      };
      const keys = new Set();
      for (const row of [...this.portfolioRows.holdings, ...this.portfolioRows.positions]) {
        const t = row && row.instrument_token != null ? String(row.instrument_token) : null;
        const q = row ? Number(row.quantity) || Number(row.t1_quantity) || 0 : 0;
        if (t && q) keys.add(t);
      }
      this.portfolioKeys = keys;
      this.syncPortfolioFeed();
    } catch (e) {
      const expired = /401|UDAPI100050|Invalid token/i.test(e.message);
      console.error(`[engine] portfolio: ${expired ? 'Upstox session expired' : e.message}`);
      this.portfolio = {
        investment: null,
        pnl: null,
        holdings: 0,
        positions: 0,
        error: expired
          ? 'Upstox session expired. Run npm run login, then restart the dashboard.'
          : 'Could not load the Upstox portfolio.',
      };
    }
  }

  stampEarlyPremium(symbol, signals, book) {
    const day = istDateKey(Date.now());
    return signals.map((s) => {
      if (s.dateKey !== day || (s.type !== 'BUY CE' && s.type !== 'BUY PE')) return s;
      if (!String(s.reason || '').startsWith('5-minute close')) return s;
      const prev = this.earlyMarks[symbol.id];
      if (prev && prev.day === day && prev.t === s.t && Number.isFinite(prev.premium)) {
        return { ...s, premium: prev.premium };
      }
      const right = s.type === 'BUY CE' ? 'CE' : 'PE';
      const strike = pickStrike(s.price, symbol, book);
      const key = book && strike != null ? book.instruments[`${strike}|${right}`] : null;
      const premium = key && book && book.ltp ? round2(book.ltp[key]) : null;
      if (premium == null) return s;
      this.earlyMarks[symbol.id] = { day, t: s.t, premium, strike, right };
      return { ...s, premium };
    });
  }

  loadEarlyMarks() {
    const day = istDateKey(Date.now());
    const file = path.join(__dirname, '..', 'paper', `${day}.json`);
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.earlyMarks = saved.earlyMarks || {};
      this.moments = saved.moments || {};
    } catch (e) {
      if (e && e.code !== 'ENOENT') console.error(`[engine] paper book: ${e.message}`);
      this.earlyMarks = {};
      this.moments = {};
    }
  }

  savePaper() {
    const paper = this.state && this.state.paper;
    if (!paper) return;
    const fp = JSON.stringify(
      (paper.trades || []).map((t) => [t.indexId, t.entryT, t.status, t.entryPremium, t.exitPremium])
    );
    if (fp === this.paperFp) return;
    this.paperFp = fp;
    const day = istDateKey(Date.now());
    const dir = path.join(__dirname, '..', 'paper');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${day}.json`),
      JSON.stringify({ date: day, ...paper, earlyMarks: this.earlyMarks, moments: this.moments, savedAt: new Date().toISOString() }, null, 2)
    );
  }

  publish() {
    this.state = this.computeState();
    // Include live marks so paper-plan P&L and LTPs always redraw the trade screen.
    const plan = this.state.paperPlan;
    const planFp = plan
      ? `${plan.total}|${plan.indexPool}|${plan.commodityPool}|${(plan.trades || [])
          .filter((t) => t.status === 'OPEN')
          .map((t) => `${t.indexId}:${t.last}:${t.pnl}`)
          .join(',')}`
      : '';
    const ltpFp = Object.values(this.state.symbols || {})
      .map((s) => `${s.name}:${s.ltp}`)
      .join('|');
    const fp = `${this.state.feed}|${this.state.updatedAt}|${ltpFp}|${JSON.stringify(this.state.portfolio)}|${planFp}|${JSON.stringify(this.state.paper)}`;
    this.savePaper();
    if (fp !== this.lastFingerprint) {
      this.lastFingerprint = fp;
      this.onUpdate(this.state);
    }
  }

  async tick() {
    // A slow option-chain poll must not overlap the next one. Both write the same candle maps.
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickOnce();
    } finally {
      this.ticking = false;
    }
  }

  async tickOnce() {
    // Try the active provider; on failure, fail over to the next configured one.
    const order = this.active ? [this.active, ...this.providers.filter((p) => p !== this.active)] : this.providers;
    let lastErr = null;
    for (const provider of order) {
      try {
        if (provider !== this.active) {
          console.log(`[engine] using data source: ${provider.name}`);
          this.active = provider;
          await this.loadWarmup(provider);
        }
        await this.refreshToday(provider);
        await this.refreshFast(provider);
        await this.refreshOptions(provider);
        await this.fetchTrackedCandles(provider);
        this.stampAllMoments(Date.now());
        await this.refreshPortfolio(provider);
        this.refreshHoldingTech(provider).catch((e) => console.error(`[engine] technicals: ${e.message}`));
        this.syncFeed();
        this.syncOptionFeed();
        this.syncPortfolioFeed();
        this.publish();
        // New strikes from this pass get their candles, then the book is priced.
        await this.fetchTrackedCandles(provider);
        this.syncOptionFeed();
        if (this.stampAllMoments(Date.now())) this.publish();
        await this.refreshMegaBull();
        return;
      } catch (e) {
        lastErr = e;
        console.error(`[engine] ${provider.name} failed: ${e.message}`);
        if (this.active === provider) this.active = null;
      }
    }
    this.state = { ...this.state, status: 'error', error: lastErr ? lastErr.message : 'all providers failed' };
    this.onUpdate(this.state);
  }

  async start() {
    this.providers = this.buildProviders();
    this.active = this.providers[0];
    console.log(`[engine] warming up with ${this.active.name} ...`);
    this.loadEarlyMarks();
    await this.loadCommodities();
    if (this.megabull) {
      try {
        await this.megabull.loadInstruments();
        console.log('[engine] MegaBull paper API ready (virtual orders only).');
      } catch (e) {
        console.error(`[engine] MegaBull instruments: ${e.message}`);
      }
    }
    await this.loadWarmup(this.active);
    await this.tick();
    this.timer = setInterval(() => this.tick().catch((e) => console.error('[engine] tick error:', e.message)), config.pollSeconds * 1000);
    console.log(`[engine] live. Upstox prices stream on the market feed. ${config.timeframeMinutes}m candles refresh every ${config.pollSeconds}s.`);
  }
}

module.exports = { Engine };
