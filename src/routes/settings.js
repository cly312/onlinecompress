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
    defaultThreads: cfg.defaultThreads,
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

router.put('/', async (req, res) => {
  const cfg = config.load();
  const b = req.body || {};
  let restartNeeded = false;

  if (typeof b.port === 'number' && b.port !== cfg.port) {
    cfg.port = b.port;
    restartNeeded = true;
  }
  if (typeof b.host === 'string' && b.host !== cfg.host) {
    cfg.host = b.host;
    restartNeeded = true;
  }
  if (typeof b.deleteSourceOnSuccess === 'boolean') cfg.deleteSourceOnSuccess = b.deleteSourceOnSuccess;
  if (typeof b.defaultThreads === 'number') cfg.defaultThreads = b.defaultThreads;
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
  if (req.body.command) p.command = req.body.command;
  if (req.body.name) p.name = req.body.name;
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
