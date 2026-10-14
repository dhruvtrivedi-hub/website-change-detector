import dns from 'node:dns/promises';
import net from 'node:net';

// Public pages only: refuse localhost, private ranges, link-local/metadata IPs, and URLs with credentials.

function isPrivateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('::ffff:')) {
    const tail = v6.slice(7);
    return net.isIPv4(tail) ? isPrivateV4(tail) : true;
  }
  return v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb');
}

const cache = new Map(); // hostname -> expiry (ms) for hosts already verified public
const TTL = 60_000;

export async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) URLs are allowed');
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Only public pages can be monitored');
  }

  const hit = cache.get(host);
  if (hit && hit > Date.now()) return url;

  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Only public pages can be monitored');
  } else {
    let addrs;
    try {
      addrs = await dns.lookup(host, { all: true });
    } catch {
      throw new Error(`Could not resolve ${host}`);
    }
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
      throw new Error('Only public pages can be monitored');
    }
  }
  cache.set(host, Date.now() + TTL);
  return url;
}

// Normalise so the same page is stored (and fetched) once: strip hash, default ports, lowercase host.
export function normalizeUrl(raw) {
  const u = new URL(raw);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
  if (u.pathname === '') u.pathname = '/';
  return u.toString();
}
