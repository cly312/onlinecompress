'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const config = require('../config');
const store = require('../store');
const queue = require('../queue');
const disk = require('../disk');
const dltoken = require('../dltoken');
const { assertPublicUrl } = require('../ssrf');

const router = express.Router();
const cfg = config.load();

function sanitizeBase(name) {
  const base = name.replace(/\.[^./\\]+$/, ''); // strip extension
  return (
    base
      .replace(/[/\\]/g, '_')
      .replace(/[\x00-\x1f]/g, '')
      .replace(/^\.+/, '')
      .trim() || 'video'
  );
}
function extOf(name) {
  const m = /\.([^./\\]+)$/.exec(name);
  return m ? m[1].toLowerCase() : 'mp4';
}

router.get('/', (req, res) => res.json(store.listFiles()));

// Legacy single-request upload was replaced by chunked /api/upload/*.
// Tell stale clients (cached old app.js) to refresh instead of a bare 404.
router.post('/upload', (req, res) => {
  res.status(410).json({ error: '上传接口已更新，请刷新页面后重试' });
});

// Create a file record for a remote URL and queue its download job.
// `name` is an optional custom base name (extension stripped) for the saved file.
function addUrlFile(url, name) {
  const clean = url.split(/[?#]/)[0];
  const rawName = typeof name === 'string' ? name.trim() : '';
  const base = rawName ? sanitizeBase(rawName) : '';
  const rec = store.addFile({
    name: base || sanitizeBase(path.basename(clean) || 'remote'),
    ext: extOf(clean),
    sourceType: 'url',
    srcUrl: url,
    status: 'pending',
  });
  // Queue a download job (single-concurrency, shared with compression).
  const job = store.addJob({ type: 'download', fileId: rec.id });
  queue.enqueue(job);
  return rec;
}

router.post('/url', async (req, res) => {
  const { url, name } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: '请输入有效的 http(s) 链接' });
  }
  try {
    await assertPublicUrl(url);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const r = await disk.check(cfg.dirs.uploads);
  if (!r.ok) {
    return res.status(507).json({
      error: `磁盘空间不足：剩余 ${(r.freeBytes / 1e9).toFixed(2)} GB（需保留至少 ${(disk.minFreeBytes() / 1e6).toFixed(0)} MB）`,
    });
  }
  res.json(addUrlFile(url, name));
});

// Batch: accept multiple links (array, or newline-separated string).
router.post('/urls', async (req, res) => {
  let { urls, names } = req.body || {};
  if (typeof urls === 'string') urls = urls.split(/[\r\n]+/);
  // Preserve blank entries while treating CRLF as a single line break.
  if (typeof names === 'string') names = names.split(/\r\n|\r|\n/);
  if (!Array.isArray(urls)) return res.status(400).json({ error: '缺少链接列表' });
  const cleaned = urls.map((u) => String(u).trim()).filter(Boolean);
  if (!cleaned.length) return res.status(400).json({ error: '未提供有效链接' });
  const r = await disk.check(cfg.dirs.uploads);
  if (!r.ok) {
    return res.status(507).json({
      error: `磁盘空间不足：剩余 ${(r.freeBytes / 1e9).toFixed(2)} GB（需保留至少 ${(disk.minFreeBytes() / 1e6).toFixed(0)} MB）`,
    });
  }
  const created = [];
  const errors = [];
  // names 与 cleaned 一一对应；仅对实际尝试处理的链接消耗一个名字，
  // 避免「无效链接被跳过后，后续链接拿到错误的名字」。
  let nameIdx = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const url = cleaned[i];
    const name = Array.isArray(names) ? names[nameIdx++] : undefined;
    if (!/^https?:\/\//i.test(url)) { errors.push({ url, error: '无效链接' }); continue; }
    try {
      await assertPublicUrl(url);
    } catch (e) {
      errors.push({ url, error: e.message });
      continue;
    }
    created.push(addUrlFile(url, name));
  }
  res.json({ created, errors });
});

// Mint unauthenticated, 24h download links for the given files. Files without
// an existing compression result are skipped (reported via `skipped`).
router.post('/links', (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: '缺少 ids' });
  // Honor the reverse proxy's scheme/host so shared links are correct behind nginx/caddy.
  const proto = (req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const base = `${proto}://${host}${config.BASE_PATH}`;
  const links = [];
  let skipped = 0;
  for (const fid of ids) {
    const f = store.getFile(fid);
    if (!f || !f.outputPath || !fs.existsSync(f.outputPath)) {
      skipped++;
      continue;
    }
    links.push(`${base}/dl/${dltoken.make(f.id)}`);
  }
  res.json({ links, skipped, ttlHours: Math.round(dltoken.TTL_MS / 3600000) });
});

// Delete a file's associated jobs: cancel in-flight ones (so a running
// compress/download stops writing output for a file that no longer exists),
// and drop finished/queued records so the jobs page doesn't show stale entries.
function purgeFileJobs(fid) {
  for (const job of store.listJobs()) {
    if (job.fileId !== fid) continue;
    // cancel only flips in-flight/queued jobs to canceled; remove the record
    // either way so the jobs page doesn't keep entries for a deleted file.
    queue.cancel(job.id);
    store.removeJob(job.id);
  }
}

// Batch delete: remove multiple files (and optionally their outputs) at once.
router.post('/batch-delete', (req, res) => {
  const { ids, output } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: '缺少 ids' });
  let removed = 0;
  for (const fid of ids) {
    const f = store.getFile(fid);
    if (!f) continue;
    purgeFileJobs(f.id);
    try {
      if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
      if (output && f.outputPath && fs.existsSync(f.outputPath)) fs.unlinkSync(f.outputPath);
    } catch (e) {
      console.error('删除文件失败:', e.message);
    }
    store.removeFile(f.id);
    removed++;
  }
  res.json({ ok: true, removed });
});

router.delete('/:id', (req, res) => {
  const f = store.getFile(req.params.id);
  if (!f) return res.status(404).json({ error: 'not found' });
  const alsoOutput = req.query.output === '1';
  purgeFileJobs(f.id);
  try {
    if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
    if (alsoOutput && f.outputPath && fs.existsSync(f.outputPath)) fs.unlinkSync(f.outputPath);
  } catch (e) {
    console.error('删除文件失败:', e.message);
  }
  store.removeFile(f.id);
  res.json({ ok: true });
});

router.get('/:id/output', (req, res) => {
  const f = store.getFile(req.params.id);
  if (!f || !f.outputPath || !fs.existsSync(f.outputPath)) {
    return res.status(404).json({ error: '输出文件不存在' });
  }
  res.download(f.outputPath, `${f.name}_compressed.mp4`);
});

module.exports = router;
