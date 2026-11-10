'use strict';

// Screen delivery holdings with the 50-day average and the simple 14-day RSI.
// Reads a JSON file when one is passed, otherwise the Upstox long-term book.
// In a terminal, prices refresh from Upstox every few seconds.
// Prints labels only. Nothing is sent to the broker.

const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');
const { istDateKey, istParts } = require('../src/time');
const { UpstoxProvider } = require('../src/data/upstox');
const { screenHolding, holdingInput } = require('../src/portfolio-screen');
const { commentOnBook } = require('../src/gemini');

const REFRESH_MS = 5000;
const BOOK_REFRESH_MS = 60000;
const GEMINI_REFRESH_MS = 10 * 60 * 1000;
const GEMINI_CACHE = path.join(__dirname, '..', 'cache', 'gemini-book.json');

function shiftDate(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function loadFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = Array.isArray(raw) ? raw : Object.entries(raw).map(([ticker, details]) => ({ ticker, ...details }));
  return rows.map((row) => ({
    ticker: row.ticker || row.tradingsymbol || row.symbol,
    instrumentKey: row.instrumentKey || row.instrument_token || '',
    buyPrice: Number(row.buyPrice != null ? row.buyPrice : row.buy_price != null ? row.buy_price : row.average_price),
    quantity: Number(row.quantity),
    closes: Array.isArray(row.closes) ? row.closes.map(Number) : null,
  }));
}

const paint = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
const dim = (t) => paint('2', t);
const bold = (t) => paint('1', t);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const amber = (t) => paint('33', t);

function num(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const PLAIN = {
  'SELL / CUT LOSS': { title: 'Look at selling', ink: red, head: (t) => paint('1;31', t), note: 'The price is under the average of the last 50 closes, and the loss is already more than 10%.' },
  'BOOK PROFIT / REVIEW': { title: 'Has run up', ink: amber, head: (t) => paint('1;33', t), note: 'Most of the last 14 sessions were up. That can cool off. This is not a sell order.' },
  'HOLD / REVIEW': { title: 'Nothing urgent', ink: dim, head: (t) => paint('1;2', t), note: 'Neither check is strong enough to flag this.' },
  REVIEW: { title: 'Not enough data', ink: dim, head: (t) => paint('1;2', t), note: 'There are not enough daily prices, or the buy price is missing.' },
  KEEP: { title: 'Holding up', ink: green, head: (t) => paint('1;32', t), note: 'The price is above the average of the last 50 closes, and the loss is smaller than 5%.' },
};

function plainOf(action) {
  return PLAIN[action] || { title: action || 'Review', ink: dim, head: (t) => bold(t), note: '' };
}

function visLen(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
}

function wrap(text, width) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  const limit = Math.max(8, width);
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (cur && next.length > limit) {
      lines.push(cur);
      cur = word;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function cardRow(left, right, inner, border) {
  const gap = inner - visLen(left) - visLen(right || '');
  const body = gap > 0 ? left + ' '.repeat(gap) + (right || '') : left;
  const pad = Math.max(0, inner - visLen(body));
  return border('│') + body + ' '.repeat(pad) + border('│');
}

const ACTION_ORDER = ['SELL / CUT LOSS', 'BOOK PROFIT / REVIEW', 'HOLD / REVIEW', 'REVIEW', 'KEEP'];

function rupeeResult(row) {
  if (row.currentPrice == null || row.buyPrice == null || row.quantity == null) return null;
  if (!Number.isFinite(row.currentPrice) || !Number.isFinite(row.buyPrice) || !Number.isFinite(row.quantity)) return null;
  return (row.currentPrice - row.buyPrice) * row.quantity;
}

function invested(row) {
  if (row.buyPrice == null || row.quantity == null) return null;
  if (!Number.isFinite(row.buyPrice) || !Number.isFinite(row.quantity)) return null;
  return row.buyPrice * row.quantity;
}

function signedNum(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n >= 0 ? green(`+${num(n)}`) : red(num(n));
}

function termWidth() {
  const fromEnv = Number(process.env.COLUMNS);
  const cols = process.stdout.columns || (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 100);
  return Math.max(48, cols - 1);
}

function columnCount(width, n) {
  if (n <= 1) return 1;
  const minCol = 42;
  const fit = Math.floor((width + 2) / (minCol + 2));
  return Math.max(1, Math.min(n, fit, 4));
}

function pushPair(lines, left, right, inner, border) {
  if (!visLen(right) || visLen(left) + visLen(right) + 1 <= inner) {
    lines.push(cardRow(left, right, inner, border));
    return;
  }
  lines.push(cardRow(left, '', inner, border));
  lines.push(cardRow(` ${String(right).trim()}`, '', inner, border));
}

function stockCard(row, inner) {
  const plain = plainOf(row.action);
  const border = plain.ink;
  const pct = row.pnlPct == null ? '—' : `${row.pnlPct > 0 ? '+' : ''}${num(row.pnlPct)}%`;
  const pctText = row.pnlPct == null ? pct : row.pnlPct >= 0 ? green(pct) : red(pct);
  const result = rupeeResult(row);
  const resultText = result == null ? 'Result —' : `Result ${result >= 0 ? green('+' + num(result)) : red(num(result))}`;
  const shares = row.quantity == null ? '—' : `${row.quantity} shares`;
  const rsi = row.rsi == null ? '' : `RSI ${num(row.rsi)}`;
  let note = plain.note;
  if (row.action === 'KEEP' && row.pnlPct > 0) note = 'Price is above the 50-day average, and this position is in profit.';
  if (row.action === 'REVIEW' && row.reason && !row.reason.startsWith('Not enough')) note = row.reason;
  const priceLine = ` Paid ${num(row.buyPrice)}    Now ${num(row.currentPrice)}`;
  const avg = row.sma50 == null ? '' : `50-day ${num(row.sma50)}`;
  const lines = [
    border('┌' + '─'.repeat(inner) + '┐'),
    cardRow(` ${bold(row.ticker)}`, `${pctText} `, inner, border),
    cardRow(` ${resultText}`, `${shares} `, inner, border),
  ];
  pushPair(lines, priceLine, avg ? `${avg} ` : '', inner, border);
  if (rsi || row.live) pushPair(lines, dim(` ${rsi || 'RSI —'}`), row.live ? dim('live ') : '', inner, border);
  for (const line of wrap(note, inner - 2)) lines.push(cardRow(dim(` ${line}`), '', inner, border));
  lines.push(border('└' + '─'.repeat(inner) + '┘'));
  return lines;
}

function drawSlice(rows, width) {
  const gap = 2;
  const n = rows.length;
  const col = Math.floor((width - gap * (n - 1)) / n);
  const extra = width - (col * n + gap * (n - 1));
  const drawn = rows.map((row, i) => stockCard(row, col - 2 + (i === n - 1 ? extra : 0)));
  const height = Math.max(...drawn.map((card) => card.length));
  const widths = rows.map((_, i) => col + (i === n - 1 ? extra : 0));
  const out = [];
  for (let line = 0; line < height; line++) {
    out.push(drawn.map((card, i) => card[line] || ' '.repeat(widths[i])).join(' '.repeat(gap)));
  }
  return out;
}

function placeCards(cards, width) {
  const cols = columnCount(width, cards.length);
  const out = [];
  for (let i = 0; i < cards.length; i += cols) {
    if (i) out.push('');
    out.push(...drawSlice(cards.slice(i, i + cols), width));
  }
  return out;
}

function clockLabel(now) {
  const p = istParts(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)} IST`;
}

function dateLabel(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${day} ${months[month - 1]} ${year}`;
}

function coverLines(rows, width) {
  let gain = 0;
  let loss = 0;
  const winners = [];
  for (const row of rows) {
    const n = rupeeResult(row);
    if (n == null || n === 0) continue;
    if (n > 0) {
      gain += n;
      winners.push(row);
    } else {
      loss += n;
    }
  }
  winners.sort((a, b) => rupeeResult(b) - rupeeResult(a));
  const lines = [];
  if (!winners.length) {
    lines.push('No holding is in profit, so none of them covers the loss.');
  } else {
    const chips = winners.map((row) => `${row.ticker} +${num(rupeeResult(row))}`).join('   ');
    lines.push(`In profit now, reducing the loss:  ${chips}`);
    const ahead = gain + loss;
    if (loss === 0) lines.push(`These are ahead by ${num(gain)}.`);
    else if (ahead >= 0) lines.push(`Together ${num(gain)} covers the ${num(Math.abs(loss))} loss. The book is ahead by ${num(ahead)}.`);
    else lines.push(`Together ${num(gain)} against losses of ${num(Math.abs(loss))}. Still short ${num(Math.abs(ahead))}.`);
  }
  lines.push('No stock is suggested to buy. A live price cannot cover a loss and then promise a profit.');
  return lines.flatMap((line) => wrap(line, width));
}

function renderFrame(rows, status) {
  const width = termWidth();
  const groups = new Map();
  for (const row of rows) {
    const key = row.action || 'REVIEW';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const list of groups.values()) list.sort((a, b) => (a.pnlPct ?? 0) - (b.pnlPct ?? 0));
  const investedSum = rows.reduce((sum, row) => sum + (invested(row) || 0), 0);
  const resultSum = rows.reduce((sum, row) => {
    const n = rupeeResult(row);
    return n == null ? sum : sum + n;
  }, 0);
  const counts = ACTION_ORDER.filter((name) => groups.has(name))
    .map((name) => `${groups.get(name).length} ${plainOf(name).title.toLowerCase()}`)
    .join('  ·  ');

  const lines = ['', bold(`Your stocks · ${status.dateLabel} · ${clockLabel(status.now)}`)];
  lines.push(`${rows.length} holdings    paid ${num(investedSum)}    result ${signedNum(resultSum)}`);
  if (counts) lines.push(dim(counts));
  lines.push('');
  for (const line of coverLines(rows, width)) lines.push(dim(line));
  if (status.error) lines.push(red(status.error));
  if (status.gemini || status.geminiError) {
    lines.push('');
    lines.push(...geminiBox(status, width));
  }

  const names = [...groups.keys()].sort((a, b) => {
    const ia = ACTION_ORDER.indexOf(a);
    const ib = ACTION_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  for (const name of names) {
    const plain = plainOf(name);
    lines.push('');
    lines.push(`${plain.head(plain.title)}  ${dim(String(groups.get(name).length))}`);
    lines.push(...placeCards(groups.get(name), width));
  }
  lines.push('');
  lines.push(dim(status.footer));
  lines.push('');
  return lines.join('\n');
}

function parseGemini(text) {
  const clean = String(text || '')
    .replace(/\*\*/g, '')
    .replace(/^\s*[*\-]\s+/gm, '')
    .trim();
  const summary = [];
  const technical = [];
  const risks = [];
  for (const line of clean.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed || /clear understanding of the underlying fundamentals/i.test(trimmed)) continue;
    if (/^technical\b/i.test(trimmed)) technical.push(trimmed.replace(/^technical\s*[:\-]\s*/i, ''));
    else if (/^risk\b/i.test(trimmed)) risks.push(trimmed.replace(/^risk\s*[:\-]\s*/i, ''));
    else if (/^summary\b/i.test(trimmed)) summary.push(trimmed.replace(/^summary\s*[:\-]\s*/i, ''));
    else if (!risks.length && !technical.length) summary.push(trimmed);
    else if (technical.length && !risks.length) technical.push(trimmed);
    else risks.push(trimmed);
  }
  return { summary: summary.join(' '), technical: technical.slice(0, 2), risks: risks.slice(0, 2) };
}

function geminiStatusLine(status) {
  const checked = status.geminiAt ? clockLabel(status.geminiAt) : '';
  const next = status.geminiAt ? clockLabel(status.geminiAt + GEMINI_REFRESH_MS) : '';
  if (status.geminiStatus === 'waiting') return `Labels changed. This note stays until ${next}.`;
  if (status.geminiStatus === 'fresh') return `Updated ${checked}. Next look ${next}, only if a label changes.`;
  if (checked) return `Saved from ${checked}. Same labels, so Gemini was not called again.`;
  return 'Gemini was not called.';
}

function geminiBox(status, width) {
  const inner = Math.max(20, width - 2);
  const border = dim;
  const parsed = parseGemini(status.gemini);
  const lines = [border('┌' + '─'.repeat(inner) + '┐'), cardRow(` ${bold('Gemini')}`, dim('not an order '), inner, border)];
  const summary = parsed.summary || status.geminiError || 'Waiting for the first note.';
  for (const line of wrap(summary, inner - 2)) lines.push(cardRow(` ${line}`, '', inner, border));
  for (const point of parsed.technical || []) {
    const wrapped = wrap(point, inner - 12);
    wrapped.forEach((line, i) => lines.push(cardRow(dim(i ? `           ${line}` : ` Technical ${line}`), '', inner, border)));
  }
  for (const risk of parsed.risks) {
    const wrapped = wrap(risk, inner - 9);
    wrapped.forEach((line, i) => lines.push(cardRow(dim(i ? `        ${line}` : ` Risk   ${line}`), '', inner, border)));
  }
  if (status.geminiError && parsed.summary) {
    for (const line of wrap(status.geminiError, inner - 2)) lines.push(cardRow(red(` ${line}`), '', inner, border));
  }
  for (const line of wrap(geminiStatusLine(status), inner - 2)) lines.push(cardRow(dim(` ${line}`), '', inner, border));
  lines.push(border('└' + '─'.repeat(inner) + '┘'));
  return lines;
}

function bookSignature(rows) {
  return rows
    .map((row) => [row.ticker, row.quantity, row.action, row.pnlPct == null ? '' : Math.round(row.pnlPct)].join(':'))
    .sort()
    .join('|');
}

function readGeminiCache() {
  try {
    const saved = JSON.parse(fs.readFileSync(GEMINI_CACHE, 'utf8'));
    if (!saved || typeof saved.text !== 'string' || typeof saved.signature !== 'string') return null;
    return saved;
  } catch (_) {
    return null;
  }
}

function writeGeminiCache(state) {
  fs.mkdirSync(path.dirname(GEMINI_CACHE), { recursive: true });
  fs.writeFileSync(GEMINI_CACHE, JSON.stringify({
    signature: state.geminiSignature,
    text: state.gemini,
    at: state.geminiAt,
  }));
}

function writeFrame(text) {
  if (process.stdout.isTTY) process.stdout.write(`\x1b[H\x1b[J${text}`);
  else process.stdout.write(`${text}\n`);
}

function closesOf(holding, cache) {
  if (holding.closes && holding.closes.length) return holding.closes;
  const hit = holding.instrumentKey ? cache.get(holding.instrumentKey) : null;
  return hit && hit.closes ? hit.closes : [];
}

function priceRow(holding, cache, quotes) {
  const raw = closesOf(holding, cache);
  const series = raw
    .map((c) => (c && c.close != null ? c.close : c))
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const live = holding.instrumentKey ? quotes.get(holding.instrumentKey) : undefined;
  if (Number.isFinite(live) && series.length) series[series.length - 1] = live;
  const row = screenHolding({ ...holding, closes: series });
  row.live = Number.isFinite(live);
  if (Number.isFinite(live) && row.currentPrice == null && Number.isFinite(Number(holding.buyPrice)) && Number(holding.buyPrice) !== 0) {
    const buy = Number(holding.buyPrice);
    row.currentPrice = Math.round(live * 100) / 100;
    row.buyPrice = Math.round(buy * 100) / 100;
    row.pnlPct = Math.round(((live - buy) / buy) * 10000) / 100;
    row.quantity = holding.quantity;
  }
  const cached = holding.instrumentKey ? cache.get(holding.instrumentKey) : null;
  if (cached && cached.error && row.action === 'REVIEW') row.reason = cached.error;
  return row;
}

async function closesFor(provider, holding, toDate) {
  if (holding.closes && holding.closes.length) return holding.closes;
  if (!holding.instrumentKey || !provider) return [];
  const fromDate = shiftDate(toDate, -200);
  return provider.getDailyCandles(holding.instrumentKey, fromDate, toDate);
}

async function ensureCandles(state) {
  for (const holding of state.holdings) {
    const key = holding.instrumentKey;
    if (!key || state.candles.has(key) || (holding.closes && holding.closes.length)) continue;
    try {
      const closes = await closesFor(state.provider, holding, state.toDate);
      state.candles.set(key, { closes });
    } catch (err) {
      state.candles.set(key, { closes: [], error: err.message });
    }
  }
}

async function refreshQuotes(state) {
  const keys = state.holdings.map((row) => row.instrumentKey).filter(Boolean);
  if (!state.provider || !keys.length) return;
  const book = await state.provider.getLtps(keys);
  for (const [key, px] of book) state.quotes.set(key, px);
  state.quotedAt = Date.now();
}

async function reloadBook(state) {
  if (state.file || !state.provider) return;
  const book = await state.provider.getPortfolio();
  state.holdings = (book.holdingRows || []).map(holdingInput).filter((row) => row.quantity);
}

function footerFor(state) {
  if (state.live) return 'Prices every 5s · Gemini at most every 10 min, and only if a label changes · q quit';
  if (state.provider && state.holdings.some((row) => row.instrumentKey)) return 'One snapshot. Open this in a terminal for live prices.';
  return 'Daily closes. Live prices need an Upstox instrument key.';
}

function paintState(state, error) {
  const rows = state.holdings.map((holding) => priceRow(holding, state.candles, state.quotes));
  writeFrame(renderFrame(rows, {
    dateLabel: dateLabel(state.toDate),
    now: Date.now(),
    error: error || '',
    gemini: state.gemini || '',
    geminiError: state.geminiError || '',
    geminiAt: state.geminiAt || 0,
    geminiStatus: state.geminiStatus || '',
    footer: footerFor(state),
  }));
}

async function refreshGemini(state) {
  if (!config.geminiKeys.length) return;
  const rows = state.holdings.map((holding) => priceRow(holding, state.candles, state.quotes));
  const signature = bookSignature(rows);
  const age = Date.now() - (state.geminiAt || 0);
  if (state.gemini && signature === state.geminiSignature) {
    state.geminiStatus = 'saved';
    return;
  }
  if (state.gemini && age < GEMINI_REFRESH_MS) {
    state.geminiStatus = 'waiting';
    return;
  }
  try {
    state.gemini = await commentOnBook(rows, `${dateLabel(state.toDate)} ${clockLabel(Date.now())}`);
    state.geminiAt = Date.now();
    state.geminiSignature = signature;
    state.geminiStatus = 'fresh';
    state.geminiError = '';
    writeGeminiCache(state);
  } catch (err) {
    state.geminiError = err.message;
    state.geminiStatus = state.gemini ? 'saved' : '';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const file = process.argv[2] ? path.resolve(process.argv[2]) : '';
  const state = {
    file,
    toDate: istDateKey(Date.now()),
    holdings: [],
    provider: null,
    candles: new Map(),
    quotes: new Map(),
    live: false,
    gemini: '',
    geminiAt: 0,
    geminiSignature: '',
    geminiStatus: '',
    geminiError: '',
  };
  const savedNote = readGeminiCache();
  if (savedNote) {
    state.gemini = savedNote.text;
    state.geminiAt = Number(savedNote.at) || 0;
    state.geminiSignature = savedNote.signature;
    state.geminiStatus = 'saved';
  }

  if (file) {
    state.holdings = loadFile(file);
  } else if (!config.upstox.accessToken) {
    console.error('Pass a holdings JSON file, or set UPSTOX_ACCESS_TOKEN in .env.');
    process.exit(1);
  } else {
    state.provider = new UpstoxProvider(config.upstox.accessToken);
    await reloadBook(state);
  }

  const needsCandles = state.holdings.some((row) => !row.closes || !row.closes.length);
  if (needsCandles && !state.provider) {
    if (!config.upstox.accessToken) {
      console.error('The file has no closes. Set UPSTOX_ACCESS_TOKEN so daily candles can be loaded.');
      process.exit(1);
    }
    state.provider = new UpstoxProvider(config.upstox.accessToken);
  }

  await ensureCandles(state);
  let quoteError = '';
  try {
    await refreshQuotes(state);
  } catch (err) {
    quoteError = err.message;
  }

  const tty = Boolean(process.stdout.isTTY);
  const canLive = tty && state.provider && state.holdings.some((row) => row.instrumentKey);
  state.live = canLive;
  if (!state.holdings.length) {
    console.log('No delivery holdings to show.');
    return;
  }
  await refreshGemini(state);
  paintState(state, quoteError);
  if (!canLive) return;

  process.stdout.write('\x1b[?25l');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    process.stdout.write('\x1b[?25h\n');
    try { process.stdin.setRawMode(false); } catch (_) { /* already restored */ }
    process.exit(0);
  };
  process.stdin.on('data', (buf) => {
    const key = buf[0];
    if (key === 3 || key === 113 || key === 81) stop();
  });
  process.on('SIGINT', stop);
  process.on('SIGWINCH', () => {
    if (!stopped) paintState(state, quoteError);
  });

  let nextBook = Date.now() + BOOK_REFRESH_MS;
  while (!stopped) {
    await sleep(REFRESH_MS);
    if (stopped) break;
    try {
      if (!state.file && Date.now() >= nextBook) {
        await reloadBook(state);
        await ensureCandles(state);
        nextBook = Date.now() + BOOK_REFRESH_MS;
      }
      await refreshQuotes(state);
      await refreshGemini(state);
      quoteError = '';
    } catch (err) {
      quoteError = err.message;
    }
    if (!stopped) paintState(state, quoteError);
  }
}

main().catch((err) => {
  if (process.stdout.isTTY) process.stdout.write('\x1b[?25h');
  console.error(err.message);
  process.exit(1);
});
