'use strict';

// Maps today's Supertrend / CE signals onto MegaBull paper orders.
// BUY CE / BUY PE → BUY the option (long premium). EXIT / SQOFF → SELL to flatten.
// Signals only drive MegaBull virtual orders — nothing goes to Upstox.

const fs = require('fs');
const path = require('path');
const { istDateKey } = require('./time');

const PAPER_DIR = path.join(__dirname, '..', 'paper');

function dayFile(day) {
  return path.join(PAPER_DIR, `megabull-${day}.json`);
}

function loadBook(day) {
  try {
    const saved = JSON.parse(fs.readFileSync(dayFile(day), 'utf8'));
    if (!saved || saved.date !== day) return emptyBook(day);
    return {
      ...emptyBook(day),
      ...saved,
      sent: saved.sent && typeof saved.sent === 'object' ? saved.sent : {},
      log: Array.isArray(saved.log) ? saved.log : [],
    };
  } catch (_) {
    return emptyBook(day);
  }
}

function emptyBook(day) {
  return { date: day, sent: {}, log: [], lastError: '', profile: null, positions: [], orders: { open: [], executed: [] } };
}

function saveBook(book) {
  fs.mkdirSync(PAPER_DIR, { recursive: true });
  fs.writeFileSync(dayFile(book.date), JSON.stringify(book, null, 2));
}

function signalKey(sig, indexId) {
  return [indexId, sig.strategy || 'Supertrend', sig.type, sig.t, sig.strike, sig.right || ''].join('|');
}

function collectEntries(state) {
  const rows = [];
  for (const id of ['NIFTY', 'BANKNIFTY']) {
    const symbol = state.symbols && state.symbols[id];
    if (!symbol) continue;
    for (const sig of symbol.signalsToday || []) {
      rows.push({ ...sig, indexId: id, indexName: symbol.name, lotSize: symbol.lotSize || 65, strategy: sig.strategy || 'Supertrend' });
    }
    const ce = state.ceStrategy && state.ceStrategy[id];
    if (!ce) continue;
    for (const sig of ce.signalsToday || []) {
      rows.push({
        ...sig,
        indexId: id,
        indexName: ce.indexName || symbol.name,
        lotSize: ce.lotSize || symbol.lotSize || 65,
        strategy: 'CE v3',
      });
    }
  }
  rows.sort((a, b) => (a.t || 0) - (b.t || 0));
  return rows;
}

function isEntry(type) {
  return type === 'BUY CE' || type === 'BUY PE';
}

function isExit(type) {
  return type === 'EXIT CE' || type === 'EXIT PE' || type === 'SQOFF';
}

async function placeForSignal(client, sig) {
  if (!isEntry(sig.type) && !isExit(sig.type)) return null;
  const right = sig.right || (sig.type.includes('PE') ? 'PE' : 'CE');
  let instrument = null;
  if (sig.strike != null) {
    instrument = await client.resolveOption({
      indexId: sig.indexId,
      strike: sig.strike,
      right,
    });
  }
  if (!instrument) {
    throw new Error(`No MegaBull option for ${sig.indexId} ${sig.strike} ${right}`);
  }
  const side = isEntry(sig.type) ? 'BUY' : 'SELL';
  const qty = Number(sig.qty) || Number(sig.lotSize) || 65;
  const order = await client.placeOrder({
    instrumentToken: instrument.instrumentToken,
    qty,
    type: side,
    duration: 'MIS',
    orderType: 'MKT',
    price: sig.premium != null ? Number(sig.premium) : undefined,
  });
  return {
    order,
    instrument: {
      token: instrument.instrumentToken,
      name: instrument.instrumentName,
      tradingSymbol: instrument.tradingSymbol,
    },
  };
}

async function syncMegaBull(client, state, now = Date.now()) {
  if (!client || !client.enabled()) return null;
  const day = istDateKey(now);
  const book = loadBook(day);
  try {
    book.profile = await client.getProfile();
    book.positions = await client.getPositions();
    book.orders = await client.getOrders();
  } catch (err) {
    book.lastError = err.message;
    saveBook(book);
    return viewOf(book);
  }

  const signals = collectEntries(state);
  for (const sig of signals) {
    if (!isEntry(sig.type) && !isExit(sig.type)) continue;
    const key = signalKey(sig, sig.indexId);
    if (book.sent[key]) continue;
    // Exits only after we have placed an entry for that index/strategy today.
    if (isExit(sig.type)) {
      const hasEntry = Object.keys(book.sent).some((k) => {
        const row = book.sent[k];
        return row && row.indexId === sig.indexId && row.strategy === sig.strategy && row.side === 'BUY';
      });
      if (!hasEntry) continue;
    }
    try {
      const placed = await placeForSignal(client, sig);
      book.sent[key] = {
        indexId: sig.indexId,
        strategy: sig.strategy,
        type: sig.type,
        side: isEntry(sig.type) ? 'BUY' : 'SELL',
        strike: sig.strike,
        right: sig.right,
        orderId: placed.order && placed.order.id,
        status: placed.order && placed.order.status,
        price: placed.order && placed.order.price,
        qty: placed.order && placed.order.qty,
        instrumentName: placed.instrument.name,
        tradingSymbol: placed.instrument.tradingSymbol,
        at: new Date().toISOString(),
      };
      book.log.push({ ...book.sent[key], signalTime: sig.timeIST, reason: sig.reason });
      book.lastError = '';
    } catch (err) {
      book.lastError = err.message;
      book.log.push({
        indexId: sig.indexId,
        type: sig.type,
        strike: sig.strike,
        error: err.message,
        at: new Date().toISOString(),
      });
      // Stop further orders this pass so one bad strike does not spam.
      break;
    }
  }

  try {
    book.positions = await client.getPositions();
    book.orders = await client.getOrders();
    book.profile = await client.getProfile();
  } catch (_) {
    /* keep prior snapshot */
  }
  saveBook(book);
  return viewOf(book);
}

function viewOf(book) {
  const positions = (book.positions || []).filter((p) => p && Number(p.qty) !== 0);
  const openPnl = positions.reduce((sum, p) => sum + (Number(p.pl) || 0), 0);
  return {
    enabled: true,
    virtualMoneyLeft: book.profile ? book.profile.virtualMoneyLeft : null,
    virtualMoney: book.profile ? book.profile.virtualMoney : null,
    brokerage: book.profile ? book.profile.brokerage : null,
    positions,
    openOrders: (book.orders && book.orders.open) || [],
    executedToday: ((book.orders && book.orders.executed) || []).slice(-12),
    log: (book.log || []).slice(-12),
    lastError: book.lastError || '',
    openPnl,
  };
}

module.exports = { syncMegaBull, loadBook, signalKey, collectEntries };
