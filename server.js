'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./src/config');
const auth = require('./src/auth');
const store = require('./src/store');
const queue = require('./src/queue');

const cfg = config.load();
store.load();
// Resume any jobs that were left queued before a clean restart.
queue.tick();

const app = express();
// Behind nginx/caddy, req.ip would always be the proxy IP — every client's
// failed logins would share one lock. Trust the first proxy hop so X-Forwarded-For
// resolves to the real client (set PROXY_NUM=2 for two proxy hops, etc.).
app.set('trust proxy', Number(process.env.PROXY_NUM) > 0 ? Number(process.env.PROXY_NUM) : 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Public: login page assets + login endpoint.
app.use('/api/auth', require('./src/routes/auth'));

// Public: unauthenticated, signed & time-limited download links to outputs.
app.use('/dl', require('./src/routes/dl'));

// Everything else requires auth.
app.use('/api', auth.requireAuth);
app.use('/api/files', require('./src/routes/files'));
// Chunked resumable uploads: /api/upload/init, /api/upload/:id/:index, ...
app.use('/api/upload', require('./src/routes/upload'));
app.use('/api/jobs', require('./src/routes/jobs'));
app.use('/api/settings', require('./src/routes/settings'));
app.use('/api/events', require('./src/routes/events'));

// Static frontend (login gate handled client-side + API 401s).
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'server error' });
});

if (!cfg.passwordHash) {
  console.warn('\n[!] 尚未设置登录密码。请先运行:  npm run setup\n');
}

app.listen(cfg.port, cfg.host, () => {
  console.log(`onlinecompress 运行于 http://${cfg.host}:${cfg.port}`);
});
