'use strict';

const crypto = require('crypto');
const config = require('./config');

// Stateless, unauthenticated download links for compression outputs.
// A token is `<fileId>.<expiryMs>.<sig>` where sig is an HMAC over the
// fileId+expiry using the server secret (same one that signs sessions).
// No server-side storage: validity is proven by the signature, and the
// link stops working once the embedded expiry passes. Rotating the secret
// (or losing config.json) invalidates all outstanding links.

const TTL_MS = 24 * 60 * 60 * 1000; // 24h

function sign(fileId, exp) {
  const cfg = config.load();
  return crypto
    .createHmac('sha256', cfg.sessionSecret)
    .update(`dl:v1:${fileId}:${exp}`)
    .digest('base64url');
}

function make(fileId, ttlMs = TTL_MS) {
  const exp = Date.now() + ttlMs;
  return `${fileId}.${exp}.${sign(fileId, exp)}`;
}

// Returns { fileId, exp } for a valid, unexpired token, else null.
function verify(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [fileId, expStr, sig] = parts;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp <= Date.now()) return null;
  const expected = sign(fileId, exp);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null; // length mismatch etc.
  }
  return { fileId, exp };
}

module.exports = { make, verify, TTL_MS };
