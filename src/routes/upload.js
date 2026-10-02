'use strict';

// Chunked / resumable upload.
//
// Flow:
//   POST /init          {name, size, fileKey} -> {uploadId, chunkSize, received:[], done?}
//   PUT  /:id/:index    raw body = chunk bytes (any order, retry-safe)
//   POST /:id/complete  -> assembles chunks into data/uploads, creates file record
//   DELETE /:id         -> abort, removes chunk dir
//
// Resumability: chunk index N is considered received iff
// data/tmp/uploads/<uploadId>/<N>.part exists on disk, so progress survives
// both page reloads and server restarts. `fileKey` (client hash of
// name+size+lastModified) lets a reloaded page find the same session.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const express = require('express');
const config = require('../config');
const store = require('../store');
const disk = require('../disk');
const { probeDuration } = require('../ffmpeg');

const router = express.Router();
const cfg = config.load();

const CHUNK_DIR = path.join(config.DATA_DIR, 'tmp', 'uploads');
const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB per chunk

const sessions = new Map(); // uploadId -> {id, fileKey, name, ext, size, createdAt}

function sessionDir(id) {
  // uploadId is server-generated hex; still guard against path traversal.
  if (!/^[a-f0-9]{16,64}$/.test(id)) return null;
  return path.join(CHUNK_DIR, id);
}

function chunkPath(id, index) {
  const d = sessionDir(id);
  return d && path.join(d, `${index}.part`);
}

async function receivedChunks(id) {
  const d = sessionDir(id);
  if (!d) return [];
  try {
    const names = await fsp.readdir(d);
    return names
      .map((n) => (/^(\d+)\.part$/.exec(n) ? parseInt(n, 10) : null))
      .filter((n) => n !== null)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

async function loadSessions() {
  await fsp.mkdir(CHUNK_DIR, { recursive: true });
  const dirs = await fsp.readdir(CHUNK_DIR).catch(() => []);
  for (const dir of dirs) {
    const metaPath = path.join(CHUNK_DIR, dir, 'meta.json');
    try {
      const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
      sessions.set(meta.id, meta);
    } catch {
      // No meta (corrupt/leftover) — drop the orphan dir.
      await fsp.rm(path.join(CHUNK_DIR, dir), { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function writeMeta(meta) {
  const d = sessionDir(meta.id);
  await fsp.mkdir(d, { recursive: true });
  await fsp.writeFile(path.join(d, 'meta.json'), JSON.stringify(meta));
}

// ---- routes ----

router.post('/init', express.json(), async (req, res) => {
  const { name, size, fileKey } = req.body || {};
  if (!name || typeof name !== 'string' || !Number.isFinite(size) || size <= 0) {
    return res.status(400).json({ error: '缺少 name / size' });
  }
  // Reject uploads up front if the incoming size would leave too little free space.
  const r = await disk.check(cfg.dirs.uploads, Number(size));
  if (!r.ok) {
    return res.status(507).json({
      error: `磁盘空间不足：剩余 ${(r.freeBytes / 1e9).toFixed(2)} GB，无法上传（需保留至少 ${(disk.minFreeBytes() / 1e6).toFixed(0)} MB）`,
    });
  }

  // Resume: same file (keyed by client hash) with a live session?
  if (fileKey) {
    for (const s of sessions.values()) {
      if (s.fileKey === fileKey) {
        const received = await receivedChunks(s.id);
        return res.json({ uploadId: s.id, chunkSize: CHUNK_SIZE, received });
      }
    }
  }

  const id = store.id() + store.id();
  const ext = (/\.([^./\\]+)$/.exec(name) || [])[1] || 'mp4';
  const meta = {
    id,
    fileKey: fileKey || null,
    name: String(name),
    ext: String(ext).toLowerCase(),
    size: Number(size),
    createdAt: Date.now(),
  };
  sessions.set(id, meta);
  await writeMeta(meta);
  res.json({ uploadId: id, chunkSize: CHUNK_SIZE, received: [] });
});

// Raw-body chunk upload. Idempotent per index: rewriting a chunk is fine.
router.put('/:id/:index', express.raw({ type: () => true, limit: CHUNK_SIZE * 2 }), async (req, res) => {
  const { id, index } = req.params;
  const p = chunkPath(id, Number(index));
  const s = sessions.get(id);
  if (!s || !p || !/^\d+$/.test(index)) return res.status(404).json({ error: '上传会话不存在' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: '空分片' });
  // Chunk size must match the declared file size: a chunk can never be larger
  // than the file, and the last chunk is exactly the remainder.
  const idx = Number(index);
  const expected = Math.max(0, Math.min(CHUNK_SIZE, s.size - idx * CHUNK_SIZE));
  if (idx >= Math.ceil(s.size / CHUNK_SIZE) || req.body.length > expected) {
    return res.status(400).json({ error: '分片大小超出声明尺寸' });
  }
  // Cumulative cap: written bytes (existing chunks, this index excluded) plus
  // this chunk must never exceed the declared size.
  const d = sessionDir(id);
  let existing = 0;
  try {
    for (const n of await fsp.readdir(d)) {
      const m = /^(\d+)\.part$/.exec(n);
      if (m && Number(m[1]) !== idx) existing += (await fsp.stat(path.join(d, n))).size;
    }
  } catch { /* dir not created yet */ }
  if (existing + req.body.length > s.size) {
    return res.status(400).json({ error: '累计上传量超出声明尺寸' });
  }
  await fsp.mkdir(d, { recursive: true });
  // Write-then-rename so an interrupted write never leaves a valid-looking chunk.
  const tmp = `${p}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, req.body);
  await fsp.rename(tmp, p);
  res.json({ ok: true });
});

router.post('/:id/complete', express.json(), async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: '上传会话不存在' });
  const received = await receivedChunks(s.id);
  const expected = Math.ceil(s.size / CHUNK_SIZE);
  if (received.length < expected) {
    return res.status(409).json({ error: '分片不完整', received, expected });
  }

  // Sum the actual chunk bytes and compare with the declared size — a client
  // that sent short/duplicated chunks would otherwise assemble a broken file.
  let totalBytes = 0;
  for (const idx of received) {
    try {
      totalBytes += (await fsp.stat(chunkPath(s.id, idx))).size;
    } catch {
      return res.status(409).json({ error: '分片读取失败', index: idx });
    }
  }
  if (totalBytes !== s.size) {
    return res.status(409).json({ error: `分片总大小与声明不符（${totalBytes} != ${s.size}）` });
  }

  const dest = path.join(cfg.dirs.uploads, `${store.id()}_${Date.now()}.${s.ext}`);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  // 必须在合并开始前就挂上 error 监听：写流中途出错（如磁盘写满）若无监听器
  // 会变成未捕获异常，直接崩溃整个进程。
  let outError = null;
  out.on('error', (e) => { outError = e; });
  // destroy() 是异步释放句柄，Windows 上句柄未关闭时 unlinkSync 会 EPERM，
  // 所以必须等 close 事件后再删半成品文件。
  const fail = (msg, code) => {
    out.destroy();
    out.on('close', () => { try { fs.unlinkSync(dest); } catch { /* already gone */ } });
    return res.status(code || 500).json({ error: msg });
  };
  try {
    for (const idx of received) {
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(chunkPath(s.id, idx));
        rs.on('error', reject);
        rs.pipe(out, { end: false });
        rs.on('end', resolve);
      });
      if (outError) throw outError;
    }
    // outError 只能在上面的同步检查之后异步发出，那时本监听器已挂上，
    // 因此这里不会漏掉错误，也不必再挂第二个 error 监听器。
    await new Promise((resolve, reject) => {
      out.end(resolve);
      out.on('error', reject);
    });
    if (outError) throw outError;
  } catch (e) {
    console.error('分片合并失败:', e.message);
    return fail('分片合并失败：' + e.message);
  }

  const st = await fsp.stat(dest);
  const base = s.name.replace(/\.[^./\\]+$/, '').replace(/[/\\]/g, '_').replace(/[\x00-\x1f]/g, '').replace(/^\.+/, '').trim() || 'video';
  const rec = store.addFile({
    name: base,
    ext: s.ext,
    sourceType: 'upload',
    path: dest,
    sizeBytes: st.size,
    status: 'ready',
  });
  probeDuration(dest).then((dur) => dur && store.updateFile(rec.id, { durationSec: dur }));

  sessions.delete(s.id);
  await fsp.rm(sessionDir(s.id), { recursive: true, force: true }).catch(() => {});
  res.json(rec);
});

router.delete('/:id', async (req, res) => {
  const id = req.params.id;
  if (!sessions.has(id)) return res.status(404).json({ error: '上传会话不存在' });
  sessions.delete(id);
  await fsp.rm(sessionDir(id), { recursive: true, force: true }).catch(() => {});
  res.json({ ok: true });
});

loadSessions();

module.exports = router;
