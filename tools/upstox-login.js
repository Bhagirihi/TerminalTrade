'use strict';

// Opens the Upstox login page, catches the redirect, and writes the daily
// access token into .env as UPSTOX_ACCESS_TOKEN.
// UPSTOX_REDIRECT_URI must match the redirect URL on the Upstox app.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ENV_PATH = path.join(__dirname, '..', '.env');
const DEFAULT_REDIRECT = 'http://127.0.0.1:5000/';

function loadEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

function saveToken(token) {
  let text = fs.readFileSync(ENV_PATH, 'utf8');
  if (/^UPSTOX_ACCESS_TOKEN=.*$/m.test(text)) {
    text = text.replace(/^UPSTOX_ACCESS_TOKEN=.*$/m, `UPSTOX_ACCESS_TOKEN=${token}`);
  } else {
    if (!text.endsWith('\n')) text += '\n';
    text += `UPSTOX_ACCESS_TOKEN=${token}\n`;
  }
  fs.writeFileSync(ENV_PATH, text);
}

function openBrowser(url) {
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

const env = loadEnv(ENV_PATH);
const apiKey = env.UPSTOX_API_KEY;
const apiSecret = env.UPSTOX_API_SECRET;
const redirectUri = env.UPSTOX_REDIRECT_URI || DEFAULT_REDIRECT;

if (!apiKey || !apiSecret) {
  console.error('Set UPSTOX_API_KEY and UPSTOX_API_SECRET in .env first.');
  process.exit(1);
}

let redirect;
try {
  redirect = new URL(redirectUri);
} catch (_) {
  console.error(`UPSTOX_REDIRECT_URI is not a valid URL: ${redirectUri}`);
  process.exit(1);
}

const state = crypto.randomBytes(16).toString('hex');
const authUrl = new URL('https://api.upstox.com/v2/login/authorization/dialog');
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('client_id', apiKey);
authUrl.searchParams.set('redirect_uri', redirectUri);
authUrl.searchParams.set('state', state);

const port = Number(redirect.port || (redirect.protocol === 'https:' ? 443 : 80));
const host = redirect.hostname;

function shutdown(server, code) {
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 500).unref();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  const err = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');

  if (!code && !err) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Waiting for the Upstox login redirect.');
    return;
  }
  if (err) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<p>Upstox login failed: ${err}</p>`);
    console.error(`Upstox login failed: ${err}`);
    shutdown(server, 1);
    return;
  }
  if (returnedState !== state) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<p>Login state did not match. Close this tab and run npm run login again.</p>');
    console.error('State mismatch. Login aborted.');
    shutdown(server, 1);
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
      console.error(`Token exchange failed: ${msg}`);
      shutdown(server, 1);
      return;
    }
    saveToken(json.access_token);
    const who = json.user_name || json.user_id || 'Upstox';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<p>Logged in as ${who}. Access token saved. You can close this tab.</p>`);
    console.log(`Logged in as ${who}. Access token saved to .env.`);
    shutdown(server, 0);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<p>Token exchange failed. See the terminal.</p>');
    console.error(e.message);
    shutdown(server, 1);
  }
});

server.on('error', (e) => {
  console.error(`Cannot listen on ${redirectUri}: ${e.message}`);
  console.error('UPSTOX_REDIRECT_URI must match the redirect URL registered on your Upstox app.');
  process.exit(1);
});

server.listen(port, host, () => {
  console.log('Waiting for Upstox login.');
  console.log(`Redirect URI (must match the app): ${redirectUri}`);
  console.log(authUrl.toString());
  openBrowser(authUrl.toString());
});

setTimeout(() => {
  console.error('Login timed out after 5 minutes.');
  shutdown(server, 1);
}, 5 * 60 * 1000);
