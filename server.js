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
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Public: login page assets + login endpoint.
app.use('/api/auth', require('./src/routes/auth'));

// Public: unauthenticated, signed & time-limited download links to outputs.
app.use('/dl', require('./src/routes/dl'));

// Everything else requires auth.
app.use('/api', auth.requireAuth);
app.use('/api/files', require('./src/routes/files'));
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
