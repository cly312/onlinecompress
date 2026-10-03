'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA_DIR = path.join(ROOT, 'data');

const DEFAULT_PRESET = {
  name: 'H.265 CRF26 (默认)',
  command:
    'ffmpeg -i "{input}" -map 0:v:0 -map 0:a:0? -threads 2 ' +
    '-c:v libx265 -crf 26 -preset fast -x265-params "frame-threads=2:pools=2" ' +
    '-c:a aac -b:a 48k -af "aresample=async=1:first_pts=0" ' +
    '-fps_mode vfr -movflags +faststart "{output}"',
};

const DEFAULT_PORT = 8989;

// Deployment sub-path (e.g. '/abcd1919810') set via BASE_PATH env. nginx strips
// this prefix before proxying to the app; external links must include it.
function basePath() {
  let p = process.env.BASE_PATH || '';
  if (!p || p === '/') return '';
  if (!p.startsWith('/')) p = '/' + p;
  return p.replace(/\/+$/, '');
}
const BASE_PATH = basePath();

function defaultConfig() {
  return {
    port: DEFAULT_PORT,
    host: '127.0.0.1',
    passwordHash: '', // bcrypt hash, set during setup
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    dirs: {
      uploads: path.join(DATA_DIR, 'uploads'),
      outputs: path.join(DATA_DIR, 'outputs'),
      tmp: path.join(DATA_DIR, 'tmp'),
    },
    deleteSourceOnSuccess: false,
    maxDownloads: 1,
    maxCompresses: 1,
    minFreeMB: 1000,
    presets: [DEFAULT_PRESET],
  };
}

let cache = null;

function load() {
  if (cache) return cache;
  let cfg = defaultConfig();
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const disk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      cfg = { ...cfg, ...disk, dirs: { ...cfg.dirs, ...(disk.dirs || {}) } };
    } catch (e) {
      console.error('config.json 解析失败，使用默认配置:', e.message);
    }
  }
  // Environment overrides (useful for first boot / containers)
  if (process.env.PORT) cfg.port = parseInt(process.env.PORT, 10);
  if (process.env.HOST) cfg.host = process.env.HOST;
  if (!cfg.presets || cfg.presets.length === 0) cfg.presets = [DEFAULT_PRESET];
  // A config.json written before port validation existed (or hand-edited) can
  // hold a value listen() rejects, which would throw synchronously at startup
  // and crash-loop the service with no way to reach the UI to fix it. Fall
  // back to the default instead of taking the process down.
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    console.error(`config.json 中的端口无效: ${JSON.stringify(cfg.port)}，已回退到默认端口 ${DEFAULT_PORT}`);
    cfg.port = DEFAULT_PORT;
  }
  cache = cfg;
  ensureDirs(cfg);
  return cfg;
}

function ensureDirs(cfg) {
  for (const d of [DATA_DIR, cfg.dirs.uploads, cfg.dirs.outputs, cfg.dirs.tmp]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function save(cfg) {
  cache = cfg;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  ensureDirs(cfg);
}

module.exports = {
  ROOT,
  DATA_DIR,
  CONFIG_PATH,
  BASE_PATH,
  DEFAULT_PRESET,
  defaultConfig,
  load,
  save,
  ensureDirs,
};
