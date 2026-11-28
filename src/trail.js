'use strict';

// Trailing stop — reading B, the user's pick (27 Nov 2026): the stop
// trails 5% behind the highest premium since entry, arms once the peak
// is 5% up, and never sits below breakeven once armed. It only moves up.
//
//   peak < entry × 1.05   → trail = initial SL (not armed)
//   peak ≥ entry × 1.05   → trail = max(entry, peak × 0.95)
//
// Bought at 100: peak 104 → stop 95; peak 105 → stop 100 (breakeven);
// peak 110 → stop 104.50; peak 115 → stop 109.25.
//
// The live broker SL-M stays at the fixed −5% level — V3 has no
// order-modify call to move it. The trail is enforced by the loop's own
// exit (paper closes at the trail level; live sells at market after
// cancelling the SL-M), with the SL-M as the backstop if the loop dies.
const TRAIL_ARM = 1.05;
const TRAIL_GAP = 0.95;

function trailStop(entry, sl, peak) {
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(sl)) return sl;
  if (!Number.isFinite(peak) || peak < entry * TRAIL_ARM) return sl;
  return +Math.max(entry, peak * TRAIL_GAP).toFixed(2);
}

// The stop that actually protects the position right now: the trailed
// stop once armed, else the fixed SL. Old ledger rows have no peak —
// they trail from the entry price, which leaves the fixed SL in force.
function effectiveSl(pos) {
  const peak = pos.peak != null ? pos.peak : pos.entry;
  return trailStop(pos.entry, pos.sl, peak);
}

// Which 5% step the peak has reached (0 = not armed): 1 at +5%, 2 at
// +10%, … — the loop logs only when the step rises, so a grinding rise
// doesn't spam the log with a line per tick.
function trailStep(entry, peak) {
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(peak)) return 0;
  if (peak < entry * TRAIL_ARM) return 0;
  // +1e-9 absorbs binary float error at exact 5% boundaries
  // (1.15 − 1.05 reads as 0.09999999999999987, which would undercount).
  return Math.floor((peak / entry - TRAIL_ARM) / 0.05 + 1e-9) + 1;
}

module.exports = { TRAIL_ARM, TRAIL_GAP, trailStop, effectiveSl, trailStep };
