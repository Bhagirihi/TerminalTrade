'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isUpstoxAuthError, muhuratWebRootUrl } = require('../src/upstox-auth');
const { pageUrl, preferredUrl } = require('../src/muhurat-web');

describe('upstox-auth', () => {
  it('detects Upstox auth failures', () => {
    assert.equal(isUpstoxAuthError('Upstox 401: {"errors":[{"errorCode":"UDAPI100050"}]}'), true);
    assert.equal(isUpstoxAuthError('Invalid token'), true);
    assert.equal(isUpstoxAuthError('Upstox 429: Too Many Request'), false);
    assert.equal(isUpstoxAuthError('UPSTOX_ACCESS_TOKEN missing'), false);
  });

  it('prefers Oracle/public host for muhurat root URL', () => {
    const prev = {
      port: process.env.MUHURAT_WEB_PORT,
      host: process.env.MUHURAT_WEB_HOST,
      primary: process.env.UPSTOX_STATIC_IP_PRIMARY,
      after: process.env.MUHURAT_AFTER_LOGIN_URL,
      open: process.env.MUHURAT_WEB_OPEN_HOST,
      afterHost: process.env.MUHURAT_AFTER_LOGIN_HOST,
    };
    process.env.MUHURAT_WEB_PORT = '3001';
    process.env.MUHURAT_WEB_HOST = '130.210.26.188';
    delete process.env.MUHURAT_AFTER_LOGIN_URL;
    delete process.env.MUHURAT_WEB_OPEN_HOST;
    delete process.env.MUHURAT_AFTER_LOGIN_HOST;
    try {
      assert.equal(pageUrl('130.210.26.188', 3001), 'http://130.210.26.188:3001/');
      assert.equal(preferredUrl(3001), 'http://130.210.26.188:3001/');
      assert.equal(muhuratWebRootUrl(), 'http://130.210.26.188:3001/');
    } finally {
      for (const [k, v] of Object.entries({
        MUHURAT_WEB_PORT: prev.port,
        MUHURAT_WEB_HOST: prev.host,
        UPSTOX_STATIC_IP_PRIMARY: prev.primary,
        MUHURAT_AFTER_LOGIN_URL: prev.after,
        MUHURAT_WEB_OPEN_HOST: prev.open,
        MUHURAT_AFTER_LOGIN_HOST: prev.afterHost,
      })) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
