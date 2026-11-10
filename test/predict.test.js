'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { openingRead } = require('../src/predict');
const { istToEpoch } = require('../src/time');

const open = istToEpoch('2026-10-16', 9, 15);

function minute(i, high, low) {
  return { t: open + i * 60000, open: low, high, low, close: (high + low) / 2 };
}

test('opening read waits until the first minute closes', () => {
  const read = openingRead([minute(0, 101, 99)], 102, open + 30000);
  assert.strictEqual(read.label, 'Waiting');
  assert.strictEqual(read.side, null);
  assert.ok(read.windows.every((w) => w.ready === false));
});

test('opening read uses 1 minute, then 3, then 5 as each window closes', () => {
  const bars = [minute(0, 110, 100), minute(1, 112, 101), minute(2, 108, 99), minute(3, 111, 102), minute(4, 109, 100)];

  const at1 = openingRead(bars, 111, open + 60000);
  assert.strictEqual(at1.minutes, 1);
  assert.strictEqual(at1.side, 'CALL');
  assert.strictEqual(at1.windows[1].ready, false);

  const at3 = openingRead(bars, 98, open + 3 * 60000);
  assert.strictEqual(at3.minutes, 3);
  assert.strictEqual(at3.side, 'PUT');
  assert.strictEqual(at3.windows[0].bias, 'PUT');

  const at5 = openingRead(bars, 105, open + 5 * 60000);
  assert.strictEqual(at5.minutes, 5);
  assert.strictEqual(at5.label, 'Inside');
  assert.strictEqual(at5.side, null);
  assert.strictEqual(at5.agree, 3);
  assert.ok(at5.windows[2].high >= 112);
  assert.ok(at5.windows[2].low <= 99);
});
