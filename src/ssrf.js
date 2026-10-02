'use strict';

const dns = require('dns').promises;
const net = require('net');

// SSRF guard for user-supplied download URLs: reject loopback, private/link-local
// and cloud-metadata addresses. Called on submit (routes) and again right before
// the actual fetch (download.js), so a DNS change can't slip past the check.

function ipIsBlocked(ip) {
  // IPv6 with embedded IPv4 (e.g. ::ffff:127.0.0.1) — unwrap and re-check.
  const v4 = /^(::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4) return ipIsBlocked(v4[2]);

  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
    if (a === 169 && b === 254) return true; // link-local (AWS/GCP/Azure metadata 169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved 240/4 + broadcast
    return false;
  }

  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase().replace(/%.*$/, ''); // strip zone id
    if (v === '::' || v === '::1') return true; // unspecified, loopback
    if (/^f[cd]/.test(v)) return true; // fc00::/7 unique-local
    if (/^fe[89ab]/.test(v)) return true; // fe80::/10 link-local
    if (/^ff/.test(v)) return true; // multicast
    if (/^2001:db8:/.test(v)) return true; // documentation range
    // NAT64 well-known prefix 64:ff9b::/96 and 464 bits — conservative: reject
    if (v.startsWith('64:ff9b')) return true;
    return false;
  }

  return true; // not a parseable IP — fail closed
}

async function assertPublicUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('无效的 URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('仅支持 http(s) 链接');
  }
  // Credentials in the URL can be used to confuse parsers — reject outright.
  if (u.username || u.password) throw new Error('URL 不应包含用户名/密码');

  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (ipIsBlocked(host)) throw new Error('不允许访问内网/保留地址');
    return;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('不允许访问内网/保留地址');
  }

  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('无法解析该域名');
  }
  if (!addrs.length || addrs.some((a) => ipIsBlocked(a.address))) {
    throw new Error('该域名解析到内网/保留地址，已拒绝');
  }
}

module.exports = { assertPublicUrl, ipIsBlocked };
