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

// Sub-path deployment (e.g. behind nginx at http://host:80/abcd1919810/).
// Set BASE_PATH=/abcd1919810 and have nginx proxy that prefix to this app
// with the prefix stripped. All routes and the frontend's asset/API paths
// are then relative to that base.
const BASE_PATH = config.BASE_PATH;
if (BASE_PATH) console.log(`[*] BASE_PATH=${BASE_PATH}（子路径模式：nginx 剥离该前缀后反代到本服务）`);
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
// index: false — index.html is served (with base-path rewriting) below.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Serve index.html with asset paths and a window.BASE_PATH global rewritten
// to the deployment sub-path, so the frontend works under /prefix/ via nginx.
// Register both '/' (direct access) and BASE_PATH. NOTE: only the
// prefix-STRIPPING proxy mode is fully supported (README's config) — static
// files and API routes live at the root, so a proxy that forwards the prefix
// would 404 on everything except this HTML entry.
app.get(['/', BASE_PATH || '/'].filter((p, i, a) => a.indexOf(p) === i), (req, res) => {
  const html = require('fs').readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
    .replace(/(href|src)="\/(?!\/)/g, `$1="${BASE_PATH}/`)
    .replace('<script src=', `<script>window.BASE_PATH=${JSON.stringify(BASE_PATH)}</script><script src=`);
  res.type('html').send(html);
});

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
