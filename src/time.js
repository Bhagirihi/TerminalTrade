'use strict';

// IST has no daylight-saving, so a fixed +05:30 offset is exact.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function pad(n) {
  return String(n).padStart(2, '0');
}

// Break an epoch-ms timestamp into IST wall-clock parts.
function istParts(epochMs) {
  const d = new Date(epochMs + IST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(), // 0 = Sunday
  };
}

function istDateKey(epochMs) {
  const p = istParts(epochMs);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function istTimeStr(epochMs) {
  const p = istParts(epochMs);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

function istFullStr(epochMs) {
  return `${istDateKey(epochMs)} ${istTimeStr(epochMs)} IST`;
}

// Epoch ms for a given IST wall-clock time (dateKey = 'YYYY-MM-DD', hh, mm).
function istToEpoch(dateKey, hh, mm) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - IST_OFFSET_MS;
}

module.exports = { IST_OFFSET_MS, istParts, istDateKey, istTimeStr, istFullStr, istToEpoch };
