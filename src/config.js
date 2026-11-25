'use strict';

const fs = require('fs');
const path = require('path');

// Minimal .env loader (KEY=VALUE lines) so the project has no extra deps for config.
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

loadEnv();

const config = {
  port: Number(process.env.PORT || 3000),
  pollSeconds: Number(process.env.POLL_SECONDS || 20),
  timeframeMinutes: Number(process.env.TIMEFRAME_MINUTES || 15),
  dataSource: (process.env.DATA_SOURCE || 'auto').toLowerCase(), // auto | upstox | angelone | fixture
  warmupDays: 7,

  upstox: {
    accessToken: process.env.UPSTOX_ACCESS_TOKEN || '',
  },

  angel: {
    apiKey: process.env.ANGEL_API_KEY || '',
    clientCode: process.env.ANGEL_CLIENT_CODE || '',
    password: process.env.ANGEL_PASSWORD || '',
    totpSecret: process.env.ANGEL_TOTP_SECRET || '',
    jwtToken: process.env.ANGEL_JWT_TOKEN || '', // optional: paste a ready JWT instead of auto-login
    localIP: process.env.ANGEL_LOCAL_IP || '127.0.0.1',
    publicIP: process.env.ANGEL_PUBLIC_IP || '127.0.0.1',
    macAddress: process.env.ANGEL_MAC_ADDRESS || '00:00:00:00:00:00',
  },

  fixtureDir: process.env.FIXTURE_DIR || '',
  // Loopback by default. HOST=0.0.0.0 opens the dashboard on the LAN, and
  // non-local clients then receive the market state without the Upstox portfolio.
  host: process.env.HOST || '127.0.0.1',
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 15000),
  geminiKeys: [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3].filter(Boolean),

  // --- Premium-based trailing exit (live engine only, default OFF) ---
  // Trails the option premium itself instead of the index: arms once peak
  // premium profit reaches activatePts, then exits on giveback keeping
  // keepFrac of the peak premium profit (never books a loss); plus a theta
  // stop that exits at -maxLossFrac of entry premium even without arming.
  // Enable on paper first, review, then decide. See
  // ../trading/premium-trailing-exit-design.md for the full design.
  premiumTrail: {
    enabled: process.env.PREMIUM_TRAIL === 'true',
    activatePts: Number(process.env.PREMIUM_TRAIL_ACTIVATE_PTS || 40),
    keepFrac: Number(process.env.PREMIUM_TRAIL_KEEP_FRAC || 0.7),
    thetaStopOn: process.env.PREMIUM_THETA_STOP !== 'false',
    maxLossFrac: Number(process.env.PREMIUM_THETA_MAX_LOSS_FRAC || 0.35),
    staleMs: Number(process.env.PREMIUM_TRAIL_STALE_MS || 60000),
  },

  // Supertrend lane defaults from the 5-year 15m A/B on cached Upstox bars:
  // flip-only entries + EMA-13 exit only after 4 bars → better PF than baseline,
  // fewer scratch trades, R:R still above 1.
  strategy: {
    flipOnly: process.env.STRATEGY_FLIP_ONLY !== 'false',
    emaExit: process.env.STRATEGY_EMA_EXIT !== 'false',
    emaExitBars: Number(process.env.STRATEGY_EMA_EXIT_BARS || 4),
  },

  // Paper plan: Gold/Silver front-month sample lost in the short backtest, so
  // only Crude uses the commodity ₹50,000 pool unless overridden.
  paperCommodities: (process.env.PAPER_COMMODITIES || 'CRUDE')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),

  // MegaBull virtual paper broker (https://megabull.in/paper-trading-api-india.html).
  // When set, today's BUY CE/PE and exits are mirrored as MIS market orders there.
  megabull: {
    apiKey: process.env.MEGABULL_API_KEY || '',
    enabled: process.env.MEGABULL_PAPER !== 'false',
  },
};

// The two instruments, with each broker's identifiers and the lot sizes
// Current NSE market lots: Nifty 65, Bank Nifty 30.
const SYMBOLS = [
  {
    id: 'NIFTY',
    name: 'NIFTY 50',
    lotSize: 65,
    strikeStep: 50,
    upstoxKey: 'NSE_INDEX|Nifty 50',
    angel: { exchange: 'NSE', tradingsymbol: 'NIFTY', symboltoken: '99926000' },
  },
  {
    id: 'BANKNIFTY',
    name: 'BANKNIFTY',
    lotSize: 30,
    strikeStep: 100,
    upstoxKey: 'NSE_INDEX|Nifty Bank',
    angel: { exchange: 'NSE', tradingsymbol: 'BANKNIFTY', symboltoken: '99926009' },
  },
];

function angelConfigured() {
  const a = config.angel;
  return Boolean(a.apiKey && (a.jwtToken || (a.clientCode && a.password && a.totpSecret)));
}

module.exports = { config, SYMBOLS, angelConfigured };
