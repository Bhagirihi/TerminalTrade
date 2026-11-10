'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkEnv, checkSessionClock, formatChecks } = require('../src/muhurat-checks');

test('checkEnv reports budget and token fields', async () => {
  const rows = await checkEnv();
  assert.ok(rows.some((r) => r.id === 'BUDGET'));
  assert.ok(rows.some((r) => r.id === 'UPSTOX_TOKEN'));
  assert.ok(rows.some((r) => r.id === 'SESSION'));
});

test('checkSessionClock returns a clock row', () => {
  const rows = checkSessionClock();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'CLOCK');
  assert.ok(['pass', 'warn'].includes(rows[0].status));
});

test('formatChecks includes PASS or FAIL tags', () => {
  const text = formatChecks({
    ok: false,
    ms: 12,
    at: '2026-11-08 13:00 IST',
    checks: [
      { id: 'UPSTOX_TOKEN', status: 'pass', detail: 'ok' },
      { id: 'UPSTOX_LTP', status: 'fail', detail: 'bad' },
    ],
    failed: [{ id: 'UPSTOX_LTP' }],
    warned: [],
  });
  assert.match(text, /PASS/);
  assert.match(text, /FAIL/);
  assert.match(text, /Stopped/);
});
