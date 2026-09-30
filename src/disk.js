'use strict';

const fs = require('fs');
const config = require('./config');

// Cross-platform free/total space via fs.statfs (Node >= 18).
// bavail = blocks available to unprivileged users; use it for "free".
async function space(dir) {
  try {
    const s = await fs.promises.statfs(dir);
    return {
      totalBytes: s.blocks * s.bsize,
      freeBytes: s.bavail * s.bsize,
    };
  } catch {
    return { totalBytes: 0, freeBytes: 0, unavailable: true };
  }
}

function minFreeBytes() {
  const cfg = config.load();
  return (cfg.minFreeMB || 0) * 1024 * 1024;
}

// Ensure `dir` keeps at least the configured reserve free after `incomingBytes`
// more are written. Returns { ok, freeBytes, needBytes }.
async function check(dir, incomingBytes = 0) {
  const { freeBytes, unavailable } = await space(dir);
  if (unavailable) return { ok: true, freeBytes: 0, unavailable: true }; // don't block if we can't tell
  const needBytes = minFreeBytes() + incomingBytes;
  return { ok: freeBytes >= needBytes, freeBytes, needBytes };
}

module.exports = { space, check, minFreeBytes };
