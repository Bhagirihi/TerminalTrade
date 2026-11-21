'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAutoApprove } = require('../src/muhurat-approve');

test('resolveAutoApprove paper arms paper without live', () => {
  const prev = process.env.MUHURAT_AUTO_APPROVE;
  process.env.MUHURAT_AUTO_APPROVE = 'paper';
  try {
    const g = resolveAutoApprove({
      defaultBudget: 20000,
      stockDefault: 15000,
      optionsDefault: 25000,
      liveAvailable: true,
      wantStock: true,
      wantOptions: true,
    });
    assert.ok(g);
    assert.equal(g.paper, true);
    assert.equal(g.approved, false);
    assert.equal(g.stockBudget, 15000);
    assert.equal(g.optionsBudget, 25000);
  } finally {
    if (prev == null) delete process.env.MUHURAT_AUTO_APPROVE;
    else process.env.MUHURAT_AUTO_APPROVE = prev;
  }
});

test('resolveAutoApprove live requires liveAvailable', () => {
  const prev = process.env.MUHURAT_AUTO_APPROVE;
  process.env.MUHURAT_AUTO_APPROVE = 'live';
  try {
    const blocked = resolveAutoApprove({
      stockDefault: 15000,
      optionsDefault: 25000,
      liveAvailable: false,
      wantStock: true,
      wantOptions: true,
    });
    assert.equal(blocked.approved, false);
    assert.equal(blocked.paper, false);

    const ok = resolveAutoApprove({
      stockDefault: 15000,
      optionsDefault: 25000,
      liveAvailable: true,
      wantStock: true,
      wantOptions: true,
    });
    assert.equal(ok.approved, true);
    assert.equal(ok.paper, false);
  } finally {
    if (prev == null) delete process.env.MUHURAT_AUTO_APPROVE;
    else process.env.MUHURAT_AUTO_APPROVE = prev;
  }
});

test('resolveAutoApprove empty returns null', () => {
  const prev = process.env.MUHURAT_AUTO_APPROVE;
  delete process.env.MUHURAT_AUTO_APPROVE;
  try {
    assert.equal(resolveAutoApprove({ stockDefault: 10_000, optionsDefault: 10_000 }), null);
  } finally {
    if (prev == null) delete process.env.MUHURAT_AUTO_APPROVE;
    else process.env.MUHURAT_AUTO_APPROVE = prev;
  }
});
