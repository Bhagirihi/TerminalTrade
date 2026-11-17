'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  parseEnvText,
  userArgFromArgv,
  activateProfile,
} = require('../src/user-profiles');

test('parseEnvText reads KEY=VALUE', () => {
  const m = parseEnvText('FOO=bar\n# c\nBAZ=1\n');
  assert.equal(m.FOO, 'bar');
  assert.equal(m.BAZ, '1');
});

test('userArgFromArgv reads --user=', () => {
  assert.equal(userArgFromArgv(['node', 'x', '--user=a']), 'a');
  assert.equal(userArgFromArgv(['node', 'x', '--user', 'b']), 'b');
});

test('activateProfile loads user env over process.env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muhurat-user-'));
  const envFile = path.join(dir, 'a.env');
  fs.writeFileSync(envFile, 'UPSTOX_ACCESS_TOKEN=tok-a\nMUHURAT_BUDGET_STOCK=5000\n');
  const prev = process.env.UPSTOX_ACCESS_TOKEN;
  try {
    process.env.UPSTOX_ACCESS_TOKEN = 'root-token';
    const active = activateProfile({
      id: 'a',
      name: 'User A',
      broker: 'upstox',
      env: envFile,
    });
    assert.equal(active.id, 'a');
    assert.equal(process.env.UPSTOX_ACCESS_TOKEN, 'tok-a');
    assert.equal(process.env.MUHURAT_BUDGET_STOCK, '5000');
    assert.equal(process.env.MUHURAT_USER, 'a');
  } finally {
    if (prev == null) delete process.env.UPSTOX_ACCESS_TOKEN;
    else process.env.UPSTOX_ACCESS_TOKEN = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
