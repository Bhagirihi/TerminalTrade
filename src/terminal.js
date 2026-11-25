'use strict';

// Minimal terminal styling: ANSI colours, on only when stdout is a TTY
// (or FORCE_COLOR is set) and NO_COLOR is unset. Piped or redirected output
// stays plain text, so logs and files are never full of escape codes.
const ENABLED = (process.stdout.isTTY && !process.env.NO_COLOR) || !!process.env.FORCE_COLOR;

function wrap(code) {
  return (s) => (ENABLED ? `\x1b[${code}m${s}\x1b[0m` : String(s));
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s) { return String(s).replace(ANSI_RE, ''); }
function visibleLength(s) { return stripAnsi(s).length; }

// A bordered card around body lines, titled in the top border:
//   ┌─ NIFTY · 12:45 IST ─────────────────┐
//   │ ✓ TRADE: BUY ...                    │
//   └─────────────────────────────────────┘
// Width follows the longest visible line (ANSI codes don't count), so
// coloured text never breaks the border.
function card(title, lines) {
  const body = (lines || []).map((l) => String(l));
  const w = Math.max(visibleLength(title) + 1, ...body.map(visibleLength));
  const pad = (l) => l + ' '.repeat(Math.max(0, w - visibleLength(l)));
  const out = [];
  out.push(`┌─ ${title} ${'─'.repeat(Math.max(0, w - visibleLength(title) - 1))}┐`);
  for (const l of body) out.push(`│ ${pad(l)} │`);
  out.push(`└${'─'.repeat(w + 2)}┘`);
  return out.join('\n');
}

module.exports = {
  enabled: ENABLED,
  bold: wrap('1'),
  dim: wrap('2'),
  green: wrap('32'),
  yellow: wrap('33'),
  red: wrap('31'),
  cyan: wrap('36'),
  stripAnsi,
  visibleLength,
  card,
};
