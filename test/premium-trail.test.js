'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPremiumTrail, updatePremiumTrail, premiumTrailLevel, DEFAULTS } = require('../src/premium-trail');

const cfg = { activatePts: 40, keepFrac: 0.7, thetaStopOn: true, maxLossFrac: 0.35 };

test('premium trail: inert without a finite live premium (peak untouched)', () => {
  const s = createPremiumTrail(200);
  assert.deepEqual(updatePremiumTrail(s, NaN, cfg), { exit: null, level: null });
  assert.deepEqual(updatePremiumTrail(s, null, cfg), { exit: null, level: null });
  assert.strictEqual(s.premiumPeak, 200);
  assert.strictEqual(s.armed, false);
});

test('premium trail: peak ratchets one way only', () => {
  const s = createPremiumTrail(200);
  updatePremiumTrail(s, 260, cfg);
  assert.strictEqual(s.premiumPeak, 260);
  updatePremiumTrail(s, 230, cfg); // pullback: peak must not move down
  assert.strictEqual(s.premiumPeak, 260);
});

test('premium trail: arms at activatePts and exits on giveback', () => {
  const s = createPremiumTrail(200);
  assert.strictEqual(updatePremiumTrail(s, 210, cfg).exit, null);
  assert.strictEqual(s.armed, false);
  assert.strictEqual(updatePremiumTrail(s, 250, cfg).exit, null); // arms here (+50 >= 40)
  assert.strictEqual(s.armed, true);
  // level = 200 + 0.7 * 50 = 235 ; 240 is above it -> hold
  assert.strictEqual(updatePremiumTrail(s, 240, cfg).exit, null);
  // 230 <= 235 and still above entry -> trailing exit
  const r = updatePremiumTrail(s, 230, cfg);
  assert.strictEqual(r.exit, 'trailing');
  assert.strictEqual(r.level, 235);
});

test('premium trail: trailing exit can never book a loss', () => {
  const s = createPremiumTrail(200);
  s.armed = true;
  s.premiumPeak = 260; // level = 200 + 0.7*60 = 242
  // premium fell under entry but theta stop (-35% -> 130) not hit: no exit at all
  assert.strictEqual(updatePremiumTrail(s, 195, cfg).exit, null);
  assert.strictEqual(updatePremiumTrail(s, 200, cfg).exit, null);
});

test('premium theta stop fires at -35% even before arming', () => {
  const s = createPremiumTrail(200);
  const r = updatePremiumTrail(s, 129, cfg);
  assert.strictEqual(r.exit, 'theta');
  assert.strictEqual(r.level, 130);
  const s2 = createPremiumTrail(200);
  assert.strictEqual(updatePremiumTrail(s2, 131, cfg).exit, null);
});

test('premium theta stop can be switched off', () => {
  const s = createPremiumTrail(200);
  assert.strictEqual(updatePremiumTrail(s, 100, { ...cfg, thetaStopOn: false }).exit, null);
});

test('premiumTrailLevel: null until armed, then entry + keepFrac * peak profit', () => {
  const s = createPremiumTrail(200);
  assert.strictEqual(premiumTrailLevel(s, cfg), null);
  s.armed = true;
  s.premiumPeak = 300;
  assert.strictEqual(premiumTrailLevel(s, cfg), 270); // 200 + 0.7*100
});

test('premium trail: defaults match the design doc', () => {
  assert.deepEqual(DEFAULTS, { activatePts: 40, keepFrac: 0.7, thetaStopOn: true, maxLossFrac: 0.35 });
});
