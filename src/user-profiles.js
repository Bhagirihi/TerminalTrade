'use strict';

// Per-friend profiles: login id → users/<id>.env (broker tokens, budgets, static IP).
// Shared defaults stay in root .env; user file overrides.

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');

const ROOT = path.join(__dirname, '..');
const USERS_DIR = path.join(ROOT, 'users');
const ACCOUNTS_PATH = path.join(USERS_DIR, 'accounts.json');

function parseEnvText(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function applyEnvMap(map, { override = true } = {}) {
  for (const [k, v] of Object.entries(map || {})) {
    if (!override && process.env[k] != null && process.env[k] !== '') continue;
    process.env[k] = v;
  }
}

function loadEnvFile(filePath, opts = {}) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  applyEnvMap(parseEnvText(fs.readFileSync(filePath, 'utf8')), opts);
  return true;
}

function userEnvPath(userId) {
  const id = String(userId || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(id)) return null;
  return path.join(USERS_DIR, `${id}.env`);
}

function readAccounts() {
  if (!fs.existsSync(ACCOUNTS_PATH)) return { users: [] };
  try {
    const j = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
    return { users: Array.isArray(j.users) ? j.users : [] };
  } catch (_) {
    return { users: [] };
  }
}

function listProfiles() {
  const accounts = readAccounts().users;
  if (accounts.length) {
    return accounts.map((u) => ({
      id: String(u.id || '').toLowerCase(),
      name: u.name || u.id,
      broker: u.broker || 'upstox',
      env: u.env || `${u.id}.env`,
      pin: u.pin != null ? String(u.pin) : '',
    })).filter((u) => u.id);
  }
  // Fallback: any users/*.env (except examples)
  if (!fs.existsSync(USERS_DIR)) return [];
  return fs.readdirSync(USERS_DIR)
    .filter((f) => f.endsWith('.env') && !f.endsWith('.example'))
    .map((f) => {
      const id = f.replace(/\.env$/, '');
      return { id, name: id, broker: 'upstox', env: f, pin: '' };
    });
}

function findProfile(userId) {
  const id = String(userId || '').trim().toLowerCase();
  return listProfiles().find((u) => u.id === id) || null;
}

function userArgFromArgv(argv = process.argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (a === '--user' || a === '--User') {
      return String(argv[i + 1] || '').trim().toLowerCase() || null;
    }
    if (a.startsWith('--user=')) return a.slice('--user='.length).trim().toLowerCase() || null;
  }
  if (process.env.npm_config_user && process.env.npm_config_user !== 'true') {
    return String(process.env.npm_config_user).trim().toLowerCase();
  }
  return null;
}

function wantsLoginPrompt(argv = process.argv) {
  if (process.env.MUHURAT_LOGIN === 'true') return true;
  return argv.some((a) => {
    const s = String(a);
    return s === '--login' || s === '--Login' || /^--?login$/i.test(s);
  });
}

function activateProfile(profile) {
  if (!profile || !profile.id) throw new Error('No user profile');
  const envFile = path.isAbsolute(profile.env)
    ? profile.env
    : path.join(USERS_DIR, profile.env || `${profile.id}.env`);
  if (!fs.existsSync(envFile)) {
    throw new Error(`Missing env for user "${profile.id}": ${envFile}`);
  }
  // Root .env = shared defaults (already loaded). User file wins.
  loadEnvFile(envFile, { override: true });
  process.env.MUHURAT_USER = profile.id;
  process.env.MUHURAT_USER_NAME = profile.name || profile.id;
  process.env.MUHURAT_USER_BROKER = profile.broker || 'upstox';
  return {
    id: profile.id,
    name: profile.name || profile.id,
    broker: profile.broker || 'upstox',
    envFile,
  };
}

function activateUserId(userId) {
  const profile = findProfile(userId);
  if (!profile) {
    const envPath = userEnvPath(userId);
    if (envPath && fs.existsSync(envPath)) {
      return activateProfile({ id: userId, name: userId, broker: 'upstox', env: `${userId}.env` });
    }
    throw new Error(`Unknown user "${userId}". Add users/${userId}.env and users/accounts.json`);
  }
  return activateProfile(profile);
}

async function promptLogin() {
  const profiles = listProfiles();
  if (!profiles.length) {
    throw new Error('No user profiles. Create users/accounts.json and users/<id>.env (see users/README.md)');
  }
  if (!process.stdin.isTTY) {
    throw new Error('Login needs a TTY. Use: npm run muhurat2 -- --user=<id>');
  }
  const rl = readline.createInterface({ input, output });
  try {
    console.log('');
    console.log('Users: ' + profiles.map((p) => `${p.id} (${p.broker})`).join(', '));
    const id = String(await rl.question('Login user id: ')).trim().toLowerCase();
    const profile = findProfile(id);
    if (!profile) throw new Error(`Unknown user "${id}"`);
    if (profile.pin) {
      const pin = String(await rl.question('PIN: ')).trim();
      if (pin !== String(profile.pin)) throw new Error('Invalid PIN');
    }
    return activateProfile(profile);
  } finally {
    rl.close();
  }
}

async function resolveAndActivateUser(argv = process.argv) {
  const fromArg = userArgFromArgv(argv) || (process.env.MUHURAT_USER || '').trim().toLowerCase();
  if (fromArg) return activateUserId(fromArg);
  if (wantsLoginPrompt(argv)) return promptLogin();
  // No user → keep root .env only (single-user mode).
  return null;
}

module.exports = {
  USERS_DIR,
  ACCOUNTS_PATH,
  parseEnvText,
  loadEnvFile,
  listProfiles,
  findProfile,
  userArgFromArgv,
  wantsLoginPrompt,
  activateProfile,
  activateUserId,
  promptLogin,
  resolveAndActivateUser,
  userEnvPath,
};
