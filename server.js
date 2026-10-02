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
// req.ip is the key for the login brute-force throttle, so it must never be
// client-controllable. With "trust proxy" on, Express derives req.ip from the
// rightmost X-Forwarded-For entry — which is whatever the client sent unless a
// reverse proxy rewrites the header. Trusting one hop by default therefore let
// anyone bypass the throttle with a single forged X-Forwarded-For.
//
// Default is OFF: req.ip is then the real TCP peer address, so the throttle
// holds. Set PROXY_NUM=<hops> ONLY when a proxy you control sets
// X-Forwarded-For itself (nginx: proxy_set_header X-Forwarded-For $remote_addr
// or $proxy_add_x_forwarded_for). Omitting that line forwards the client's
// header verbatim and re-opens the bypass.
function proxyHops() {
  const raw = process.env.PROXY_NUM;
  if (raw === undefined || raw.trim() === '') return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}
const PROXY_HOPS = proxyHops();
app.set('trust proxy', PROXY_HOPS);
if (PROXY_HOPS > 0) {
  console.warn(
    `[!] 已信任 ${PROXY_HOPS} 跳代理的 X-Forwarded-For。请确认该代理显式设置了该头` +
      '（nginx: proxy_set_header X-Forwarded-For $remote_addr;），否则登录限速仍可被伪造 IP 绕过。'
  );
}
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
