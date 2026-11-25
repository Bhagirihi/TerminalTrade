'use strict';

// Minimal terminal styling: ANSI colours, on only when stdout is a TTY
// (or FORCE_COLOR is set) and NO_COLOR is unset. Piped or redirected output
// stays plain text, so logs and files are never full of escape codes.
const ENABLED = (process.stdout.isTTY && !process.env.NO_COLOR) || !!process.env.FORCE_COLOR;

function wrap(code) {
  return (s) => (ENABLED ? `\x1b[${code}m${s}\x1b[0m` : String(s));
}

module.exports = {
  enabled: ENABLED,
  bold: wrap('1'),
  dim: wrap('2'),
  green: wrap('32'),
  yellow: wrap('33'),
  red: wrap('31'),
  cyan: wrap('36'),
};
