'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('./config');

// Simple stateless auth for a single-password self-hosted tool.
// A login sets a signed cookie; the signature is an HMAC over a constant
// using a server secret persisted in config.json, so sessions survive
// restarts but are invalidated if the secret is rotated.

const COOKIE = 'ocsess';

function token() {
  const cfg = config.load();
  return crypto.createHmac('sha256', cfg.sessionSecret).update('authed:v1').digest('hex');
}

function isAuthed(req) {
  const c = req.cookies && req.cookies[COOKIE];
  if (!c) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(c), Buffer.from(token()));
  } catch {
    return false;
  }
}

// ---- brute-force throttle (in-memory, per-IP) ----
const attempts = new Map(); // ip -> { count, until }
const MAX = 5;
const LOCK_MS = 5 * 60 * 1000;

function throttled(ip) {
  const a = attempts.get(ip);
  return a && a.until > Date.now();
}

function recordFail(ip) {
  const a = attempts.get(ip) || { count: 0, until: 0 };
  a.count += 1;
  if (a.count >= MAX) {
    a.until = Date.now() + LOCK_MS;
    a.count = 0;
  }
  attempts.set(ip, a);
}

function clearFail(ip) {
  attempts.delete(ip);
}

async function verifyPassword(password) {
  const cfg = config.load();
  if (!cfg.passwordHash) return false;
  return bcrypt.compare(password, cfg.passwordHash);
}

function setLoginCookie(res) {
  res.cookie(COOKIE, token(), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 3600 * 1000,
  });
}

function clearLoginCookie(res) {
  res.clearCookie(COOKIE);
}

// Middleware guarding API routes.
function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

module.exports = {
  COOKIE,
  isAuthed,
  throttled,
  recordFail,
  clearFail,
  verifyPassword,
  setLoginCookie,
  clearLoginCookie,
  requireAuth,
  hash: (pw) => bcrypt.hash(pw, 10),
};
