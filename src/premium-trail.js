'use strict';

// Premium-based trailing exit for long-option positions.
//
// BUY CE and BUY PE are both long premium, so one rule covers both; the side
// only labels the exit. This is the premium twin of the index-based trailing
// target in strategy.js: it locks in a fraction of the best premium seen and
// exits on giveback, and the trailing leg can never turn a winner into a loser.
//
// The theta stop is the second half: it caps premium decay (theta / IV crush)
// even when the index has not moved enough to trip any index exit.
//
// state = { entryPremium, premiumPeak, armed }
// cfg   = { activatePts, keepFrac, thetaStopOn, maxLossFrac }
//
// updatePremiumTrail(state, livePremium, cfg)
//   -> { exit: null | 'trailing' | 'theta', level } ; mutates state in place.
//
// Rules, in order:
//  - livePremium not finite            -> inert, { exit: null } (peak untouched)
//  - premiumPeak = max(premiumPeak, livePremium)      (one-way ratchet, never loosens)
//  - theta stop (if thetaStopOn): livePremium <= entryPremium * (1 - maxLossFrac)
//    -> { exit: 'theta' }
//  - arm when (premiumPeak - entryPremium) >= activatePts
//  - trailing (if armed): level = entryPremium + keepFrac * (premiumPeak - entryPremium);
//    livePremium <= level && livePremium > entryPremium -> { exit: 'trailing' }
//
// Signals only: callers turn an exit into an EXIT CE / EXIT PE signal.
// Nothing here places orders.

const DEFAULTS = {
  activatePts: 40, // arm the trail once peak premium profit reaches this (premium points)
  keepFrac: 0.7, // keep this fraction of the peak premium profit; tolerate the rest as giveback
  thetaStopOn: true, // exit at -maxLossFrac of entry premium even with no arming
  maxLossFrac: 0.35, // theta stop: out when premium falls this fraction below entry
};

function createPremiumTrail(entryPremium) {
  return { entryPremium, premiumPeak: entryPremium, armed: false };
}

function clampKeepFrac(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return DEFAULTS.keepFrac;
  return Math.min(0.95, Math.max(0.05, n)); // degenerate 0/1 configs would exit on any tick
}

// The live "would exit at" premium level once armed; null when not armed.
// Display helper only — updatePremiumTrail is the decider.
function premiumTrailLevel(state, cfg = {}) {
  if (!state || !state.armed || !Number.isFinite(state.entryPremium) || !Number.isFinite(state.premiumPeak)) {
    return null;
  }
  const keep = clampKeepFrac(cfg.keepFrac);
  return round2(state.entryPremium + keep * (state.premiumPeak - state.entryPremium));
}

function updatePremiumTrail(state, livePremium, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  if (!state || !Number.isFinite(state.entryPremium) || !Number.isFinite(livePremium)) {
    return { exit: null, level: null };
  }
  if (livePremium > state.premiumPeak) state.premiumPeak = livePremium;
  const { entryPremium, premiumPeak } = state;

  if (c.thetaStopOn && livePremium <= entryPremium * (1 - c.maxLossFrac)) {
    return { exit: 'theta', level: round2(entryPremium * (1 - c.maxLossFrac)) };
  }
  if (!state.armed && premiumPeak - entryPremium >= c.activatePts) state.armed = true;
  if (state.armed) {
    const level = premiumTrailLevel(state, c);
    if (level != null && livePremium <= level && livePremium > entryPremium) {
      return { exit: 'trailing', level };
    }
  }
  return { exit: null, level: null };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

module.exports = { createPremiumTrail, updatePremiumTrail, premiumTrailLevel, DEFAULTS };
