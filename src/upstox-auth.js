'use strict';

// Shared Upstox OAuth login (same flow as `npm run login` on main).
// Opens the broker dialog, catches the redirect, writes UPSTOX_ACCESS_TOKEN.
//
// V3 note: on main, muhuratWebRootUrl() resolves the post-login URL through
// the Muhurat web server (src/muhurat-web.js). V3 has no web UI yet, so the
// URL helpers it needs (preferredUrl / pageUrl / webPortOf) are inlined below
// with the same logic, stdlib only. The OAuth flow itself is unchanged.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEFAULT_ENV_PATH = path.join(ROOT, '.env');
const DEFAULT_REDIRECT = 'http://127.0.0.1:5000/';

function loadEnvFile(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

function saveTokenToEnv(token, envPath = DEFAULT_ENV_PATH) {
  let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  if (/^UPSTOX_ACCESS_TOKEN=.*$/m.test(text)) {
    text = text.replace(/^UPSTOX_ACCESS_TOKEN=.*$/m, `UPSTOX_ACCESS_TOKEN=${token}`);
  } else {
    if (text && !text.endsWith('\n')) text += '\n';
    text += `UPSTOX_ACCESS_TOKEN=${token}\n`;
  }
  fs.writeFileSync(envPath, text);
  process.env.UPSTOX_ACCESS_TOKEN = token;
  try {
    const { config } = require('./config');
    if (config && config.upstox) config.upstox.accessToken = token;
  } catch (_) {
    /* config may not be loaded yet */
  }
  return envPath;
}

function openBrowser(url) {
  if (!url) return;
  if (process.env.TERMUX_VERSION) {
    execFile('termux-open-url', [url], (err) => {
      if (err) console.log(url);
    });
    return;
  }
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args, () => {});
}

function isUpstoxAuthError(err) {
  const msg = String((err && err.message) || err || '');
  return (
    /(?:^|\D)401(?:\D|$)/.test(msg)
    || /UDAPI100050/i.test(msg)
    || /Invalid token/i.test(msg)
    || /Unauthorized/i.test(msg)
    || /session expired/i.test(msg)
    || /token expired/i.test(msg)
  );
}

// --- Post-login URL helpers (same logic as src/muhurat-web.js on main) ---
// Inlined here so the login stands alone on V3 without the web UI server.
const os = require('os');

function lanHost() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      const v4 = net.family === 'IPv4' || net.family === 4;
      if (v4 && !net.internal) return net.address;
    }
  }
  return null;
}

function webPortOf() {
  // Prefer 3001 so the UI does not collide with Supertrend on :3000.
  const n = Number(process.env.MUHURAT_WEB_PORT || 3001);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return 3001;
}

function publicHostOf() {
  const raw = String(
    process.env.MUHURAT_WEB_HOST
    || process.env.MUHURAT_PUBLIC_HOST
    || process.env.UPSTOX_STATIC_IP_PRIMARY
    || ''
  ).trim();
  if (!raw) return null;
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    || null;
}

function pageUrl(host, port) {
  if (!host) return null;
  return `http://${host}:${port}/`;
}

/** Best URL for users/login redirect: Oracle/public → LAN → localhost. */
function preferredUrl(port = webPortOf()) {
  return pageUrl(publicHostOf(), port)
    || pageUrl(lanHost(), port)
    || pageUrl('127.0.0.1', port);
}

function muhuratWebRootUrl() {
  // Prefer Oracle/public host (MUHURAT_WEB_HOST / UPSTOX_STATIC_IP_PRIMARY) — not localhost.
  const override = String(
    process.env.MUHURAT_AFTER_LOGIN_URL
    || process.env.MUHURAT_AFTER_LOGIN_HOST
    || process.env.MUHURAT_WEB_OPEN_HOST
    || ''
  ).trim();
  if (override) {
    if (/^https?:\/\//i.test(override)) {
      return override.endsWith('/') ? override : `${override}/`;
    }
    return pageUrl(override.replace(/:\d+$/, ''), webPortOf());
  }
  return preferredUrl();
}

/** OAuth callback URL served by muhurat web (must be registered on the Upstox app). */
function webUpstoxRedirectUri() {
  const explicit = String(
    process.env.UPSTOX_WEB_REDIRECT_URI
    || process.env.MUHURAT_UPSTOX_REDIRECT_URI
    || ''
  ).trim();
  if (explicit) return explicit;
  const root = muhuratWebRootUrl();
  return new URL('auth/upstox/callback', root).toString();
}

function upstoxCredentials(opts = {}) {
  const envPath = opts.envPath || DEFAULT_ENV_PATH;
  const fileEnv = loadEnvFile(envPath);
  return {
    envPath,
    apiKey: opts.apiKey || process.env.UPSTOX_API_KEY || fileEnv.UPSTOX_API_KEY || '',
    apiSecret: opts.apiSecret || process.env.UPSTOX_API_SECRET || fileEnv.UPSTOX_API_SECRET || '',
    accessToken: process.env.UPSTOX_ACCESS_TOKEN || fileEnv.UPSTOX_ACCESS_TOKEN || '',
  };
}

function upstoxLinkStatus() {
  const { apiKey, apiSecret, accessToken } = upstoxCredentials();
  return {
    linked: Boolean(accessToken),
    hasAppKeys: Boolean(apiKey && apiSecret),
    redirectUri: webUpstoxRedirectUri(),
  };
}

function buildUpstoxAuthUrl({ apiKey, redirectUri, state }) {
  const authUrl = new URL('https://api.upstox.com/v2/login/authorization/dialog');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', apiKey);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  return authUrl.toString();
}

async function exchangeUpstoxCode({ code, apiKey, apiSecret, redirectUri }) {
  const body = new URLSearchParams({
    code,
    client_id: apiKey,
    client_secret: apiSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const tokenRes = await fetch('https://api.upstox.com/v2/login/authorization/token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !json.access_token) {
    const msg = json.message || json.error || `HTTP ${tokenRes.status}`;
    throw new Error(`Token exchange failed: ${msg}`);
  }
  return {
    token: json.access_token,
    userName: json.user_name || json.user_id || 'Upstox',
  };
}

/**
 * Interactive Upstox login (browser OAuth). Resolves with { token, userName }.
 * On success, optionally opens/redirects to successUrl (muhurat UI root).
 */
function runInteractiveUpstoxLogin(opts = {}) {
  const creds = upstoxCredentials(opts);
  const { envPath, apiKey, apiSecret } = creds;
  const fileEnv = loadEnvFile(envPath);
  const redirectUri = opts.redirectUri
    || process.env.UPSTOX_REDIRECT_URI
    || fileEnv.UPSTOX_REDIRECT_URI
    || DEFAULT_REDIRECT;
  const successUrl = opts.successUrl != null ? opts.successUrl : muhuratWebRootUrl();
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 5 * 60 * 1000;
  const shouldOpen = opts.openBrowser !== false;

  if (!apiKey || !apiSecret) {
    return Promise.reject(new Error('Set UPSTOX_API_KEY and UPSTOX_API_SECRET in .env first.'));
  }

  let redirect;
  try {
    redirect = new URL(redirectUri);
  } catch (_) {
    return Promise.reject(new Error(`UPSTOX_REDIRECT_URI is not a valid URL: ${redirectUri}`));
  }

  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = new URL(buildUpstoxAuthUrl({ apiKey, redirectUri, state }));

  const port = Number(redirect.port || (redirect.protocol === 'https:' ? 443 : 80));
  const host = redirect.hostname;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const done = () => (err ? reject(err) : resolve(value));
      try {
        server.close(() => done());
        setTimeout(done, 500).unref();
      } catch (_) {
        done();
      }
    };

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, redirectUri);
      const errParam = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      if (!code && !errParam) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Waiting for the Upstox login redirect.');
        return;
      }
      if (errParam) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<p>Upstox login failed: ${errParam}</p>`);
        finish(new Error(`Upstox login failed: ${errParam}`));
        return;
      }
      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<p>Login state did not match. Close this tab and run npm run login again.</p>');
        finish(new Error('State mismatch. Login aborted.'));
        return;
      }

      try {
        const exchanged = await exchangeUpstoxCode({ code, apiKey, apiSecret, redirectUri });
        saveTokenToEnv(exchanged.token, envPath);
        const who = exchanged.userName;
        const go = successUrl
          ? `<p>Logged in as ${who}. Opening Muhurat…</p>
             <p><a href="${successUrl}">${successUrl}</a></p>
             <script>location.replace(${JSON.stringify(successUrl)});</script>`
          : `<p>Logged in as ${who}. Access token saved. You can close this tab.</p>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(go);
        if (successUrl) openBrowser(successUrl);
        finish(null, { token: exchanged.token, userName: who, successUrl: successUrl || null });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<p>Token exchange failed. See the terminal.</p>');
        finish(e);
      }
    });

    server.on('error', (e) => {
      finish(new Error(
        `Cannot listen on ${redirectUri}: ${e.message}. `
        + 'UPSTOX_REDIRECT_URI must match the redirect URL registered on your Upstox app.'
      ));
    });

    server.listen(port, host, () => {
      console.log('Waiting for Upstox login.');
      console.log(`Redirect URI (must match the app): ${redirectUri}`);
      if (successUrl) console.log(`After login → ${successUrl}`);
      console.log(authUrl.toString());
      if (shouldOpen) openBrowser(authUrl.toString());
    });

    timer = setTimeout(() => {
      finish(new Error('Login timed out after 5 minutes.'));
    }, timeoutMs);
  });
}

module.exports = {
  loadEnvFile,
  saveTokenToEnv,
  openBrowser,
  isUpstoxAuthError,
  muhuratWebRootUrl,
  webUpstoxRedirectUri,
  upstoxCredentials,
  upstoxLinkStatus,
  buildUpstoxAuthUrl,
  exchangeUpstoxCode,
  runInteractiveUpstoxLogin,
  DEFAULT_ENV_PATH,
  DEFAULT_REDIRECT,
};
