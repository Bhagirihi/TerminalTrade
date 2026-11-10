'use strict';

// Full-screen terminal view of the same state the browser dashboard renders.

const RESET = '\x1b[0m';

function paint(code, text) {
  return `\x1b[${code}m${text}${RESET}`;
}

const dim = (t) => paint('2', t);
const bold = (t) => paint('1', t);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const amber = (t) => paint('33', t);
const purple = (t) => paint('35', t);

function visLen(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
}

function clipAnsi(s, n) {
  if (n <= 0) return '';
  let vis = 0;
  let out = '';
  let i = 0;
  const str = String(s);
  while (i < str.length && vis < n) {
    if (str[i] === '\x1b') {
      const m = str.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += str[i];
    vis += 1;
    i += 1;
  }
  if (visLen(str) > n && out.includes('\x1b[')) out += RESET;
  return out;
}

function padAnsi(s, n) {
  const clipped = clipAnsi(s, n);
  const gap = n - visLen(clipped);
  return gap > 0 ? clipped + ' '.repeat(gap) : clipped;
}

function investedAmount(t) {
  if (t.investment != null && Number.isFinite(Number(t.investment))) return Number(t.investment);
  if (t.entryPremium == null || t.qty == null) return null;
  const n = Number(t.entryPremium) * Number(t.qty);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function fmt(x, d = 2) {
  if (x == null || Number.isNaN(Number(x))) return '—';
  return Number(x).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtStrike(strike, right) {
  if (strike == null) return '—';
  const n = Number(strike).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  return right ? `${n} ${right}` : n;
}

function money(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return (n > 0 ? '+' : '') + fmt(n);
}

function signed(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return (n >= 0 ? '+' : '') + fmt(n);
}

function pnlColor(n, text) {
  if (n == null || Number.isNaN(Number(n))) return text;
  return n >= 0 ? green(text) : red(text);
}

function sigColor(type, text) {
  if (type === 'BUY CE') return green(text);
  if (type === 'BUY PE') return red(text);
  if (type === 'SQOFF') return purple(text);
  return amber(text);
}

function rule(width) {
  return dim('─'.repeat(Math.max(0, width)));
}

function fitColumns(defs, width) {
  const chosen = [];
  let used = 0;
  const ordered = [...defs].sort((a, b) => a.pri - b.pri);
  for (const col of ordered) {
    const gap = chosen.length ? 2 : 0;
    if (used + gap + col.min <= width) {
      chosen.push({ ...col, w: col.min });
      used += gap + col.min;
    }
  }
  chosen.sort((a, b) => a.order - b.order);
  const flex = chosen.filter((c) => c.flex);
  let extra = width - used;
  let i = 0;
  const grow = flex.length ? flex : chosen;
  while (extra > 0 && grow.length) {
    grow[i % grow.length].w += 1;
    extra -= 1;
    i += 1;
    if (i > grow.length * 80) break;
  }
  return chosen;
}

function cell(text, w, align) {
  const raw = String(text);
  const clipped = visLen(raw) > w ? `${raw.slice(0, Math.max(0, w - 1))}…` : raw;
  return align === 'right' ? clipped.padStart(w) : clipped.padEnd(w);
}

function renderTable(defs, records, width) {
  const cols = fitColumns(defs, width);
  if (!cols.length) return [];
  const header = cols.map((c) => dim(cell(c.title, c.w, c.align))).join('  ');
  const body = records.map((rec) =>
    cols
      .map((c) => {
        const value = c.value(rec);
        const text = cell(value.text, c.w, c.align);
        return value.color ? value.color(text) : text;
      })
      .join('  ')
  );
  return [header, ...body];
}

function badge(state) {
  const srcNames = {
    UPSTOX: 'UPSTOX',
    ANGELONE: 'ANGEL ONE — LIVE',
    FIXTURE: 'FIXTURE — TEST DATA (not live)',
  };
  if (state.status === 'error') return red('ERROR: ' + (state.error || ''));
  if (state.feed === 'upstox') return green('UPSTOX — REALTIME');
  const label = srcNames[state.source] || (state.status === 'starting' ? 'connecting…' : state.status || 'connecting…');
  const live = state.source === 'UPSTOX' || state.source === 'ANGELONE';
  return live ? green(label) : amber(label);
}

function currentStrike(id, s) {
  if (s.atmStrike != null) return s.atmStrike;
  if (s.ltp == null || Number.isNaN(Number(s.ltp))) return null;
  const step = id === 'BANKNIFTY' ? 100 : 50;
  return Math.round(Number(s.ltp) / step) * step;
}

function joinChips(parts, width) {
  const gap = '  ';
  const lines = [];
  let line = '';
  for (const part of parts) {
    const next = line ? line + gap + part : part;
    if (line && visLen(next) > width) {
      lines.push(line);
      line = part;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function fact(label, value) {
  return `${dim(label)} ${value}`;
}

function factLines(parts, width) {
  return joinChips(parts, width).map((line) => clipAnsi(line, width));
}

function levelsLines(id, s, width) {
  return factLines(
    [
      fact('Strike', fmtStrike(currentStrike(id, s))),
      fact('Support', fmt(s.support)),
      fact('Resistance', fmt(s.resistance)),
    ],
    width
  );
}

function predictLines(s, width) {
  const p = s.prediction;
  if (!p || !p.minutes) return [];
  const ink = p.side === 'CALL' ? green : p.side === 'PUT' ? red : dim;
  const words = {
    Bullish: 'Opening leans up',
    Bearish: 'Opening leans down',
    Inside: 'Price is inside the opening range',
    Waiting: 'Opening range is not ready',
    'Before open': 'Before the open',
  };
  const lead = (p.windows || []).find((w) => w.minutes === p.minutes && w.ready);
  const range = lead && lead.low != null ? ` (${fmt(lead.low)}–${fmt(lead.high)})` : '';
  return [clipAnsi(ink(`${words[p.label] || p.label}${range}`), width)];
}

function positionLines(s, width) {
  if (!s.position) return [dim('No open position')];
  const p = s.position;
  const mark = (t) => paint(p.side === 'LONG' ? '1;32' : '1;31', t);
  const pts = p.openPoints == null ? '—' : `${signed(p.openPoints)} pts`;
  const head = factLines(
    [
      mark(p.label),
      fmtStrike(p.strike, p.right),
      fact('premium', fmt(p.premium)),
      fact('qty', p.qty == null ? '—' : String(p.qty)),
      pnlColor(p.openPoints, pts),
    ],
    width
  );
  const bits = [fact('stop', fmt(p.stopLoss)), fact('target', fmt(p.target))];
  if (p.trailingStop != null) bits.push(fact('trail', fmt(p.trailingStop)));
  if (p.trailingTarget != null) bits.push(fact('trail target', fmt(p.trailingTarget)));
  if (p.premiumTrail && p.premiumTrail.armed && p.premiumTrail.level != null) {
    bits.push(fact('premium trail', fmt(p.premiumTrail.level)));
  }
  return [...head, ...factLines(bits, width)];
}

function laneHead(name, right, width) {
  const left = bold(name);
  const gap = Math.max(2, width - visLen(left) - visLen(right));
  return clipAnsi(left + ' '.repeat(gap) + right, width);
}

function positionBlock(position, width) {
  if (!position) return [dim('No open position')];
  return positionLines({ position }, width).filter((line) => plain(line).trim());
}

function friendlyBlock(block) {
  return String(block || '')
    .replace(/EMA50/g, 'EMA 50')
    .replace(/EMA20/g, 'EMA 20')
    .replace(/EMA9/g, 'EMA 9');
}

function v2Lines(ce, width) {
  if (!ce) return [];
  const day = pnlColor(ce.dayPoints, `today ${fmt(ce.dayPoints)} pts`);
  const d = ce.debug || {};
  const used = `${d.tradesToday ?? 0} of ${d.maxTradesDay ?? 3} trades today`;
  const lines = [
    '',
    laneHead('V2  Pullback', day, width),
    ...factLines(
      [
        fact('EMA 9', fmt(ce.emaFast)),
        fact('EMA 20', fmt(ce.emaPB)),
        fact('EMA 50', fmt(ce.emaTrend)),
        fact('RSI', fmt(ce.rsi)),
        fact('ADX', fmt(ce.adx)),
      ],
      width
    ),
    ...positionBlock(ce.position, width),
  ];
  if (ce.position) {
    lines.push(clipAnsi(dim(used), width));
  } else if (d.dailyLocked) {
    lines.push(clipAnsi(red(`Stopped for the day. ${used}.`), width));
  } else if (d.block) {
    lines.push(clipAnsi(amber(`Not a trade. ${friendlyBlock(d.block)}.`), width));
    lines.push(clipAnsi(dim(used), width));
  } else {
    lines.push(clipAnsi(green(`Ready to buy a call. ${used}.`), width));
  }
  return lines;
}

function renderCard(id, s, width, ce) {
  const lines = [];
  const trend = s.direction == null ? dim('—') : s.direction < 0 ? green('BULLISH') : red('BEARISH');
  const price = `${bold(fmt(s.ltp))}  ${trend}`;
  const name = bold(s.name || id);
  const titleGap = Math.max(1, width - visLen(name) - visLen(price));
  lines.push(clipAnsi(name + ' '.repeat(titleGap) + price, width));

  const chg = s.change == null ? dim('—') : pnlColor(s.change, `${signed(s.change)} (${s.changePct >= 0 ? '+' : ''}${fmt(s.changePct)}%)`);
  lines.push(clipAnsi(chg, width));

  const day = pnlColor(s.dayPoints, `today ${fmt(s.dayPoints)} pts`);
  lines.push(...levelsLines(id, s, width));
  lines.push(...predictLines(s, width));
  lines.push('');
  lines.push(laneHead('V1  Supertrend', day, width));
  const candle = s.liveCandle && s.liveCandle.timeIST ? green(`${s.liveCandle.timeIST} live`) : (s.lastCandleTimeIST || '—');
  lines.push(
    ...factLines(
      [fact('Supertrend', fmt(s.supertrend)), fact('EMA 13', fmt(s.ema13)), fact('Candle', candle)],
      width
    )
  );
  lines.push(...positionBlock(s.position, width));
  lines.push(...v2Lines(ce, width));
  return lines;
}

function sideBySide(left, right, width) {
  const gap = 2;
  const col = Math.floor((width - gap) / 2);
  const n = Math.max(left.length, right.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(padAnsi(left[i] || '', col) + '  ' + clipAnsi(right[i] || '', width - col - gap));
  }
  return out;
}

const PAPER_COLS = [
  { key: 'index', title: 'Index', min: 9, pri: 0, order: 0, value: (t) => ({ text: t.index || '—' }) },
  {
    key: 'strike',
    title: 'Strike',
    min: 10,
    pri: 1,
    order: 1,
    value: (t) => ({ text: fmtStrike(t.strike, t.right) }),
  },
  { key: 'entry', title: 'Entry', min: 12, pri: 2, order: 2, value: (t) => ({ text: t.entryAt || t.entryTime || '—' }) },
  { key: 'in', title: 'In', min: 7, pri: 8, order: 3, align: 'right', value: (t) => ({ text: fmt(t.entryPremium) }) },
  { key: 'qty', title: 'Qty', min: 4, pri: 6, order: 4, align: 'right', value: (t) => ({ text: t.qty == null ? '—' : String(t.qty) }) },
  { key: 'invest', title: 'Invested', min: 9, pri: 7, order: 5, align: 'right', value: (t) => ({ text: fmt(investedAmount(t)) }) },
  { key: 'exit', title: 'Exit', min: 12, pri: 3, order: 6, value: (t) => ({ text: t.exitAt || t.exitTime || '—' }) },
  {
    key: 'out',
    title: 'Out',
    min: 7,
    pri: 10,
    order: 7,
    align: 'right',
    value: (t) => ({ text: fmt(t.status === 'OPEN' ? t.markPremium : t.exitPremium) }),
  },
  { key: 'pts', title: 'Pts', min: 6, pri: 11, order: 8, align: 'right', value: (t) => ({ text: t.premiumPoints == null ? '—' : fmt(t.premiumPoints) }) },
  {
    key: 'pnl',
    title: 'P&L',
    min: 10,
    pri: 5,
    order: 9,
    align: 'right',
    value: (t) => ({ text: money(t.pnl), color: (text) => pnlColor(t.pnl, text) }),
  },
  {
    key: 'status',
    title: 'Status',
    min: 6,
    pri: 4,
    order: 10,
    value: (t) => {
      const label = t.status === 'OPEN' ? 'OPEN' : 'CLOSED';
      return { text: label, color: t.status === 'OPEN' ? green : amber };
    },
  },
  {
    key: 'reason',
    title: 'Why',
    min: 20,
    pri: 8,
    order: 11,
    flex: true,
    value: (t) => ({ text: t.status === 'OPEN' ? t.entryReason || '—' : t.exitReason || '—' }),
  },
  { key: 'strat', title: 'Strategy', min: 8, pri: 9, order: 12, value: (t) => ({ text: t.strategy === 'CE v3' ? 'V2' : 'V1' }) },
];

const SIGNAL_COLS = [
  { key: 'time', title: 'Time', min: 5, pri: 0, order: 0, value: (s) => ({ text: s.timeIST || '—' }) },
  { key: 'index', title: 'Index', min: 9, pri: 1, order: 1, value: (s) => ({ text: s.index || '—' }) },
  { key: 'type', title: 'Signal', min: 7, pri: 2, order: 2, value: (s) => ({ text: s.type || '—', color: (text) => sigColor(s.type, text) }) },
  { key: 'strike', title: 'Strike', min: 10, pri: 3, order: 3, value: (s) => ({ text: fmtStrike(s.strike, s.right) }) },
  { key: 'prem', title: 'Premium', min: 8, pri: 6, order: 4, align: 'right', value: (s) => ({ text: fmt(s.premium) }) },
  { key: 'stop', title: 'Stop', min: 9, pri: 8, order: 5, align: 'right', value: (s) => ({ text: fmt(s.stopLoss) }) },
  { key: 'target', title: 'Target', min: 9, pri: 9, order: 6, align: 'right', value: (s) => ({ text: fmt(s.target) }) },
  { key: 'pts', title: 'Pts', min: 7, pri: 7, order: 7, align: 'right', value: (s) => ({ text: s.points == null ? '—' : signed(s.points) }) },
  { key: 'reason', title: 'Why', min: 38, pri: 4, order: 8, flex: true, value: (s) => ({ text: s.reason || '—' }) },
  { key: 'strat', title: 'Strategy', min: 8, pri: 5, order: 9, value: (s) => ({ text: s.strategy === 'CE v3' ? 'V2' : 'V1' }) },
];

function portfolioLine(state, width) {
  const book = state && state.portfolio;
  const title = bold('Upstox portfolio');
  if (!book) return clipAnsi(title + '  ' + dim('—'), width);
  if (book.error) return clipAnsi(title + '  ' + dim(book.error), width);
  const liveBadge = book.live ? green('● LIVE') : dim('○ poll');
  const inv = dim(`Investment ${fmt(book.investment)}`);
  const pct = book.investment ? ` (${signed((book.pnl / book.investment) * 100)}%)` : '';
  const pnl = pnlColor(book.pnl, `P&L ${money(book.pnl)}${pct}`);
  const counts = dim(`${book.holdings || 0} holdings · ${book.positions || 0} F&O`);
  return clipAnsi(`${title}  ${liveBadge}  ${inv}  ${pnl}  ${counts}`, width);
}

function plain(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

// Keep the paper book and the signal list when the terminal is short.
// Extra card rows are what get dropped.
function fitBody(lines, budget) {
  if (lines.length <= budget) return lines;
  const paperAt = lines.findIndex((line) => plain(line).startsWith('Paper trades'));
  if (paperAt < 0) return lines.slice(lines.length - budget);
  const tail = lines.slice(paperAt);
  if (tail.length >= budget) return tail.slice(tail.length - budget);
  return [...lines.slice(0, budget - tail.length), ...tail];
}

function sectionTitle(title, extra, width) {
  if (!extra) return bold(title);
  const gap = Math.max(1, width - visLen(title) - visLen(extra) - 0);
  return clipAnsi(bold(title) + ' '.repeat(gap) + extra, width);
}

function renderDashboard(state, opts = {}) {
  const width = Math.max(20, opts.width || 80);
  const height = Math.max(8, opts.height || 24);
  const symbols = Object.entries((state && state.symbols) || {});
  const side = symbols.length >= 2 && width >= 160;

  const lines = [];
  const title = bold('NIFTY · BANKNIFTY');
  const mark = badge(state || {});
  const gap = Math.max(1, width - visLen(title) - visLen(mark));
  lines.push(clipAnsi(title + ' '.repeat(gap) + mark, width));
  const clock = state && state.updatedAt ? state.updatedAt : 'waiting';
  const session = dim('15-minute candles');
  const when = dim(clock);
  const metaGap = Math.max(1, width - visLen(session) - visLen(when) - 2);
  const meta = visLen(session) + visLen(when) + 2 <= width
    ? session + ' '.repeat(metaGap) + when
    : dim(clipAnsi(clock, width));
  lines.push(clipAnsi(meta, width));
  lines.push(clipAnsi(portfolioLine(state, width), width));
  lines.push(rule(width));

  const ceById = (state && state.ceStrategy) || {};
  const col = side ? Math.floor((width - 2) / 2) : width;
  const cards = symbols.map(([id, s]) => renderCard(id, s, col, ceById[id]));
  if (!cards.length) {
    lines.push(dim(state && state.status === 'error' ? state.error || 'Engine error' : 'Waiting for market data…'));
  } else if (side) {
    for (let i = 0; i < cards.length; i += 2) {
      if (i) lines.push(rule(width));
      lines.push(...sideBySide(cards[i], cards[i + 1] || [], width));
    }
  } else {
    cards.forEach((card, i) => {
      if (i) lines.push('');
      lines.push(...card);
    });
  }
  lines.push(rule(width));
  const paper = (state && state.paper) || { trades: [] };
  const trades = paper.trades || [];
  const stratTotal = (name) => {
    const rows = trades.filter((t) => t.strategy === name);
    if (!rows.some((t) => t.pnl != null)) return null;
    return rows.reduce((a, t) => a + (t.pnl || 0), 0);
  };
  const hasV1 = trades.some((t) => t.strategy === 'Supertrend');
  const hasV2 = trades.some((t) => t.strategy === 'CE v3');
  let paperExtra = '';
  if (trades.length && paper.total == null) paperExtra = dim('premium pending');
  else if (trades.length && hasV1 && hasV2) {
    const v1 = stratTotal('Supertrend');
    const v2 = stratTotal('CE v3');
    paperExtra = `V1 ${v1 == null ? 'premium pending' : money(v1)} · V2 ${v2 == null ? 'premium pending' : money(v2)} · total ${money(paper.total)}`;
  } else if (trades.length) {
    paperExtra = pnlColor(paper.total, money(paper.total));
    if (paper.unpriced) paperExtra += '  ' + dim(`${paper.unpriced} unpriced`);
  }
  lines.push(sectionTitle('Paper trades', paperExtra, width));
  if (!trades.length) lines.push(dim('No paper trades yet today.'));
  else lines.push(...renderTable(PAPER_COLS, trades, width));

  lines.push('');
  lines.push(bold('Today\'s signals'));
  const signals = [];
  for (const [, s] of symbols) {
    for (const sig of s.signalsToday || []) signals.push({ ...sig, index: s.name });
  }
  for (const [, ce] of Object.entries((state && state.ceStrategy) || {})) {
    for (const sig of ce.signalsToday || []) signals.push({ ...sig, index: ce.indexName || ce.name });
  }
  signals.sort((a, b) => (a.t || 0) - (b.t || 0));
  if (!signals.length) lines.push(dim('No signals yet today.'));
  else lines.push(...renderTable(SIGNAL_COLS, signals, width));

  const hint = dim('Signals only. No orders are sent. Flat at 15:10.');
  const quit = dim('q quit');
  const url = opts.url ? dim(opts.url) : '';
  const footBits = [hint, url, quit].filter(Boolean);
  let foot = footBits[0];
  for (const bit of footBits.slice(1)) {
    if (visLen(foot) + 2 + visLen(bit) <= width) foot += '  ' + bit;
  }

  const log = opts.log ? String(opts.log) : '';
  const footer = [];
  if (visLen(log)) footer.push(clipAnsi(dim(log), width));
  footer.push(foot);
  const bodyBudget = Math.max(0, height - footer.length);
  let body = fitBody(lines, bodyBudget);
  while (body.length < bodyBudget) body.push('');
  return [...body, ...footer]
    .slice(0, height)
    .map((line) => padAnsi(line, width))
    .join('\n');
}

function openTerminal({ url, getState, render }) {
  if (!process.stdout.isTTY) {
    console.log(`Terminal UI needs an interactive terminal. Dashboard: ${url}`);
    return null;
  }

  const logs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  const note = (args) => {
    const line = args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
    if (/^\[upstox-feed\] live /.test(line)) return;
    logs.push(line);
    if (logs.length > 12) logs.shift();
  };
  console.log = (...args) => note(args);
  console.warn = (...args) => note(args);
  console.error = (...args) => note(args);

  let closed = false;
  const restore = () => {
    if (closed) return;
    closed = true;
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch (_) { /* already restored */ }
    }
    process.stdout.write('\x1b[?25h\x1b[?1049l');
  };

  process.stdout.write('\x1b[?1049h\x1b[?25l');
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (key) => {
      if (key === 'q' || key === 'Q' || key === '\u0003') {
        restore();
        process.exit(0);
      }
    });
  }
  process.on('exit', restore);
  process.on('SIGTERM', () => {
    restore();
    process.exit(0);
  });

  let timer = null;
  const paintScreen = () => {
    const width = Math.max(20, (process.stdout.columns || 80) - 1);
    const height = process.stdout.rows || 24;
    const drawFrame = render || renderDashboard;
    const frame = drawFrame(getState() || { status: 'starting', symbols: {} }, {
      width,
      height,
      url,
      log: logs.length ? logs[logs.length - 1] : '',
    });
    process.stdout.write(`\x1b[H\x1b[J${frame}`);
  };

  const draw = () => {
    if (closed) return;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!closed) paintScreen();
    }, 80);
  };

  process.stdout.on('resize', paintScreen);
  paintScreen();
  return { draw, restore };
}

module.exports = { renderDashboard, openTerminal };
