'use strict';

// Opens the Upstox login page, catches the redirect, and writes the daily
// access token into .env as UPSTOX_ACCESS_TOKEN.
// After success, redirects the browser to MUHURAT_AFTER_LOGIN_URL when set,
// otherwise to the preferred host (default :3001/).

const {
  runInteractiveUpstoxLogin,
  muhuratWebRootUrl,
} = require('../src/upstox-auth');

(async () => {
  try {
    const successUrl = process.env.MUHURAT_AFTER_LOGIN_URL || muhuratWebRootUrl();
    const result = await runInteractiveUpstoxLogin({ successUrl });
    console.log(`Logged in as ${result.userName}. Access token saved to .env.`);
    if (result.successUrl) console.log(`Opening ${result.successUrl}`);
    process.exit(0);
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
})();
