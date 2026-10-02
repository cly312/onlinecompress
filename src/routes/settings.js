'use strict';

const express = require('express');
const config = require('../config');
const auth = require('../auth');
const disk = require('../disk');

const router = express.Router();

function publicSettings() {
  const cfg = config.load();
  return {
    port: cfg.port,
    host: cfg.host,
    deleteSourceOnSuccess: cfg.deleteSourceOnSuccess,
    maxDownloads: cfg.maxDownloads,
    maxCompresses: cfg.maxCompresses,
    minFreeMB: cfg.minFreeMB,
    presets: cfg.presets,
    hasPassword: !!cfg.passwordHash,
  };
}

router.get('/', (req, res) => res.json(publicSettings()));

// Current free/total space on the data volume (uploads dir).
router.get('/disk', async (req, res) => {
  const cfg = config.load();
  const s = await disk.space(cfg.dirs.uploads);
  res.json({ ...s, minFreeMB: cfg.minFreeMB });
});

// A port outside 1-65535 (or a non-integer) makes listen() throw
// ERR_SOCKET_BAD_PORT, which would crash every future boot with no way to fix
// it from the UI. Validate before writing it to config.json.
const MIN_PORT = 1;
const MAX_PORT = 65535;

function validPort(n) {
  return Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT;
}

router.put('/', async (req, res) => {
  const cfg = config.load();
  const b = req.body || {};
  let restartNeeded = false;

  if (b.port !== undefined && b.port !== null && b.port !== '') {
    const port = Number(b.port);
    if (!validPort(port)) {
      return res.status(400).json({ error: `端口需为 ${MIN_PORT}-${MAX_PORT} 之间的整数` });
    }
    if (port !== cfg.port) {
      cfg.port = port;
      restartNeeded = true;
    }
  }
  if (typeof b.host === 'string' && b.host !== cfg.host) {
    cfg.host = b.host;
    restartNeeded = true;
  }
  if (typeof b.deleteSourceOnSuccess === 'boolean') cfg.deleteSourceOnSuccess = b.deleteSourceOnSuccess;
  // Concurrency limits take effect on the next tick; lowering below the
  // currently-running count just means no new jobs start until slots free up.
  if (typeof b.maxDownloads === 'number' && b.maxDownloads >= 1) cfg.maxDownloads = Math.floor(b.maxDownloads);
  if (typeof b.maxCompresses === 'number' && b.maxCompresses >= 1) cfg.maxCompresses = Math.floor(b.maxCompresses);
  if (typeof b.minFreeMB === 'number' && b.minFreeMB >= 0) cfg.minFreeMB = b.minFreeMB;

  if (b.newPassword) {
    if (String(b.newPassword).length < 4) {
      return res.status(400).json({ error: '密码至少 4 位' });
    }
    cfg.passwordHash = await auth.hash(String(b.newPassword));
  }

  config.save(cfg);
  res.json({ ...publicSettings(), restartNeeded });
});

// ---- presets ----
router.get('/presets', (req, res) => res.json(config.load().presets));

router.post('/presets', (req, res) => {
  const cfg = config.load();
  const { name, command } = req.body || {};
  if (!name || !command) return res.status(400).json({ error: '缺少名称或命令' });
  if (cfg.presets.some((p) => p.name === name)) {
    return res.status(400).json({ error: '同名预设已存在' });
  }
  cfg.presets.push({ name, command });
  config.save(cfg);
  res.json(cfg.presets);
});

router.put('/presets/:name', (req, res) => {
  const cfg = config.load();
  const p = cfg.presets.find((x) => x.name === req.params.name);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (req.body.name && req.body.name !== p.name) {
    if (cfg.presets.some((x) => x.name === req.body.name)) {
      return res.status(400).json({ error: '同名预设已存在' });
    }
    p.name = req.body.name;
  }
  if (req.body.command) p.command = req.body.command;
  config.save(cfg);
  res.json(cfg.presets);
});

router.delete('/presets/:name', (req, res) => {
  const cfg = config.load();
  if (cfg.presets.length <= 1) return res.status(400).json({ error: '至少保留一个预设' });
  cfg.presets = cfg.presets.filter((x) => x.name !== req.params.name);
  config.save(cfg);
  res.json(cfg.presets);
});

module.exports = router;
