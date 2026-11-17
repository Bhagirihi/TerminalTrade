'use strict';

// Shared Upstox OAuth login (same flow as `npm run login`).
// Opens the broker dialog, catches the redirect, writes UPSTOX_ACCESS_TOKEN.

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

function muhuratWebRootUrl() {
  // Prefer Oracle/public host (MUHURAT_WEB_HOST / UPSTOX_STATIC_IP_PRIMARY) — not localhost.
  const { preferredUrl, pageUrl, webPortOf } = require('./muhurat-web');
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

/**
 * Interactive Upstox login (browser OAuth). Resolves with { token, userName }.
 * On success, optionally opens/redirects to successUrl (muhurat UI root).
 */
function runInteractiveUpstoxLogin(opts = {}) {
  const envPath = opts.envPath || DEFAULT_ENV_PATH;
  const fileEnv = loadEnvFile(envPath);
  const apiKey = opts.apiKey || process.env.UPSTOX_API_KEY || fileEnv.UPSTOX_API_KEY;
  const apiSecret = opts.apiSecret || process.env.UPSTOX_API_SECRET || fileEnv.UPSTOX_API_SECRET;
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
  const authUrl = new URL('https://api.upstox.com/v2/login/authorization/dialog');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', apiKey);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);

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
          res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<p>Could not get an access token: ${msg}</p>`);
          finish(new Error(`Token exchange failed: ${msg}`));
          return;
        }
        saveTokenToEnv(json.access_token, envPath);
        const who = json.user_name || json.user_id || 'Upstox';
        const go = successUrl
          ? `<p>Logged in as ${who}. Opening Muhurat…</p>
             <p><a href="${successUrl}">${successUrl}</a></p>
             <script>location.replace(${JSON.stringify(successUrl)});</script>`
          : `<p>Logged in as ${who}. Access token saved. You can close this tab.</p>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(go);
        if (successUrl) openBrowser(successUrl);
        finish(null, { token: json.access_token, userName: who, successUrl: successUrl || null });
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
  runInteractiveUpstoxLogin,
  DEFAULT_ENV_PATH,
  DEFAULT_REDIRECT,
};
