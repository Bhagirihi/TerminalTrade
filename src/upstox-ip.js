'use strict';

// Upstox static-IP allowlist helpers.
// Configure the same IPs in the Upstox developer app Static IPs panel.

function allowedStaticIps() {
  const fromList = String(process.env.UPSTOX_STATIC_IPS || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const primary = String(process.env.UPSTOX_STATIC_IP_PRIMARY || '').trim();
  const secondary = String(process.env.UPSTOX_STATIC_IP_SECONDARY || '').trim();
  const out = [];
  const push = (ip) => {
    if (ip && !out.includes(ip)) out.push(ip);
  };
  push(primary);
  push(secondary);
  for (const ip of fromList) push(ip);
  return out;
}

async function fetchPublicIpv4(timeoutMs = 5000) {
  const urls = [
    'https://api.ipify.org',
    'https://ipv4.icanhazip.com',
  ];
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ip = String(await res.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
      throw new Error(`Bad IP payload: ${ip.slice(0, 40)}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Could not resolve public IPv4');
}

async function checkEgressIp() {
  const allowed = allowedStaticIps();
  let current = null;
  let error = '';
  try {
    current = await fetchPublicIpv4();
  } catch (e) {
    error = e.message || String(e);
  }
  const ok = Boolean(current && allowed.length && allowed.includes(current));
  const unmatched = Boolean(current && allowed.length && !allowed.includes(current));
  return {
    current,
    allowed,
    ok,
    unmatched,
    error,
    hint: unmatched
      ? `Public IP ${current} is not in Upstox allowlist (${allowed.join(', ')}). Route via primary ${allowed[0] || '—'} (VPN/proxy/VPS) or update Upstox Static IPs.`
      : (!allowed.length
        ? 'Set UPSTOX_STATIC_IP_PRIMARY / UPSTOX_STATIC_IP_SECONDARY in .env to match Upstox Static IPs.'
        : (error ? `Could not detect public IP: ${error}` : `Egress IP ${current} matches allowlist.`)),
  };
}

function staticIpHint() {
  const allowed = allowedStaticIps();
  if (!allowed.length) {
    return 'Fix Upstox Static IPs / restart after login.';
  }
  return `Upstox allowlist: primary ${allowed[0]}${allowed[1] ? ` · secondary ${allowed[1]}` : ''}. Run from that network/VPN or set UPSTOX_HTTPS_PROXY to a host on the primary IP.`;
}

module.exports = {
  allowedStaticIps,
  fetchPublicIpv4,
  checkEgressIp,
  staticIpHint,
};
