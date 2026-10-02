'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { FFMPEG, probeDuration } = require('./ffmpeg');
const disk = require('./disk');
const { assertPublicUrl } = require('./ssrf');

// Re-check free disk space this often while downloading (256 MiB), so an
// endless / unknown-size stream can't silently fill the disk to the reserve.
const DISK_CHECK_INTERVAL = 256 * 1024 * 1024;

// Shared periodic guard used by both download paths. Throws when the free
// space would dip below the configured reserve.
function makeDiskGuard(outPath) {
  let lastCheck = 0;
  return async function diskGuard(force) {
    const now = Date.now();
    if (!force && now - lastCheck < 5000) return;
    lastCheck = now;
    const sp = await disk.check(path.dirname(outPath));
    if (!sp.ok) {
      throw new Error(`磁盘空间不足，已中止下载（剩余 ${(sp.freeBytes / 1e9).toFixed(2)} GB）`);
    }
  };
}

// Download an m3u8 playlist into a local .ts file using ffmpeg stream copy
// (no re-encode). Progress is reported from ffmpeg's -progress output; the
// total duration is probed first when possible.
async function downloadM3u8(url, outPath, onProgress, ref) {
  // Re-verify the URL right before use (TOCTOU: DNS may have changed since submit).
  await assertPublicUrl(url);
  const duration = await probeDuration(url);
  const diskGuard = makeDiskGuard(outPath);
  let received = 0;
  let diskGuardFailed = false;
  const args = [
    '-y', '-nostdin',
    '-i', url,
    '-c', 'copy',
    '-f', 'mpegts',
    outPath,
    '-progress', 'pipe:1', '-nostats',
  ];
  const proc = spawn(FFMPEG, args, { shell: false });
  if (ref) ref.proc = proc;
  let tail = '';
  proc.stdout.on('data', (buf) => {
    for (const line of buf.toString().split('\n')) {
      const [k, v] = line.split('=');
      if (k === 'out_time_ms' && v) {
        const t = parseInt(v, 10) / 1e6;
        onProgress(duration ? { percent: Math.min(99.9, (t / duration) * 100), timeSec: t } : { timeSec: t });
      }
      // m3u8 writes have no Content-Length; use ffmpeg's total_size progress
      // report (-progress goes to stdout) as a bytes-written proxy for disk checks.
      if (k === 'total_size' && v) {
        const total = parseInt(v, 10);
        if (total - received > DISK_CHECK_INTERVAL) {
          received = total;
          diskGuard(true).catch(() => {
            if (ref && !ref.canceled) {
              ref.canceled = true;
              diskGuardFailed = true;
              if (ref.proc) ref.proc.kill('SIGKILL');
            }
          });
        }
      }
    }
  });
  proc.stderr.on('data', (b) => {
    tail = (tail + b).slice(-3000);
  });
  const ctl = ref;
  return new Promise((resolve, reject) => {
    proc.on('error', (e) => reject(new Error('ffmpeg 启动失败: ' + e.message)));
    proc.on('close', (code) => {
      // canceled 既可能来自用户取消，也可能来自磁盘守卫——用消息区分，避免误导。
      if (ref && ref.canceled) {
        return reject(Object.assign(new Error(diskGuardFailed ? '磁盘空间不足，已中止下载' : '已取消'), { canceled: true }));
      }
      code === 0 ? resolve() : reject(new Error('m3u8 下载失败 (退出码 ' + code + ')\n' + tail.slice(-1200)));
    });
  });
}

// Follow redirects manually so every hop goes through assertPublicUrl — with
// redirect: 'follow' a public URL could 302 into an internal/metadata address
// and bypass the SSRF guard entirely. Caps the chain at 5 hops.
async function fetchChecked(rawUrl) {
  let url = rawUrl;
  for (let hops = 0; ; hops++) {
    await assertPublicUrl(url);
    const res = await fetch(url, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      res.body?.cancel?.().catch(() => {});
      if (hops >= 5) throw new Error('重定向次数过多');
      // location may be relative — resolve against the current URL.
      url = new URL(res.headers.get('location'), url).href;
      continue;
    }
    return res;
  }
}

// Download a direct URL (mp4/ts/...) with byte progress via streaming fetch.
async function downloadDirect(url, outPath, onProgress, ref) {
  // Re-verify the URL right before use (TOCTOU: DNS may have changed since submit).
  const res = await fetchChecked(url);
  if (!res.ok) throw new Error('下载失败 HTTP ' + res.status);
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  // If the server advertises a size, make sure it fits before we start writing.
  if (total) {
    const sp = await disk.check(path.dirname(outPath), total);
    if (!sp.ok) throw new Error(`磁盘空间不足，剩余 ${(sp.freeBytes / 1e9).toFixed(2)} GB，文件约 ${(total / 1e9).toFixed(2)} GB`);
  }
  // Unknown-size responses can stream forever — keep checking the disk as we go.
  const diskGuard = makeDiskGuard(outPath);
  let lastGuard = 0;
  const out = fs.createWriteStream(outPath);
  let received = 0;
  // A write error (e.g. disk full) must be observed, otherwise it becomes an
  // uncaught exception that crashes the whole process. It is also surfaced
  // through the promise below so a pending drain wait can't deadlock.
  const writeError = new Promise((_, rej) => out.on('error', (e) => rej(e)));
  const reader = res.body.getReader();
  try {
    for (;;) {
      if (ref && ref.canceled) throw Object.assign(new Error('已取消'), { canceled: true });
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      // Respect backpressure: wait for the stream to drain when the write
      // buffer is full, so data doesn't pile up in memory. Races against a
      // write error so a failed write can't leave us waiting forever.
      if (!out.write(Buffer.from(value))) {
        await Promise.race([writeError, new Promise((r) => out.once('drain', r))]);
      }
      // Periodic disk-space guard (rate-limited to once per 5s) for streams
      // with no usable Content-Length.
      if ((!total || total === 0) && received - lastGuard > DISK_CHECK_INTERVAL) {
        lastGuard = received;
        await diskGuard(true);
      }
      if (total) onProgress({ percent: Math.min(99.9, (received / total) * 100), bytes: received });
      else onProgress({ bytes: received });
    }
  } finally {
    // Breaking out of the loop on `done` leaves the reader with no pending read,
    // but an early exit (cancel, disk guard, write error) can leave the socket
    // half-read. reader.cancel() closes/releases it — without this, undici holds
    // the socket until keep-alive times out and every download leaks an fd.
    // The release lock is already drained by the time we get here, so this
    // can't block; failures are already surfaced through the caller's error.
    reader.cancel().catch(() => {});
    out.close();
  }
}

module.exports = { downloadM3u8, downloadDirect };
