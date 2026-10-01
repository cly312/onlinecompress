'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { FFMPEG, probeDuration } = require('./ffmpeg');
const disk = require('./disk');

// Download an m3u8 playlist into a local .ts file using ffmpeg stream copy
// (no re-encode). Progress is reported from ffmpeg's -progress output; the
// total duration is probed first when possible.
async function downloadM3u8(url, outPath, onProgress, ref) {
  const duration = await probeDuration(url);
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
    }
  });
  proc.stderr.on('data', (b) => (tail = (tail + b).slice(-3000)));
  return new Promise((resolve, reject) => {
    proc.on('error', (e) => reject(new Error('ffmpeg 启动失败: ' + e.message)));
    proc.on('close', (code) => {
      if (ref && ref.canceled) return reject(Object.assign(new Error('已取消'), { canceled: true }));
      code === 0 ? resolve() : reject(new Error('m3u8 下载失败 (退出码 ' + code + ')\n' + tail.slice(-1200)));
    });
  });
}

// Download a direct URL (mp4/ts/...) with byte progress via streaming fetch.
async function downloadDirect(url, outPath, onProgress, ref) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('下载失败 HTTP ' + res.status);
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  // If the server advertises a size, make sure it fits before we start writing.
  if (total) {
    const sp = await disk.check(path.dirname(outPath), total);
    if (!sp.ok) throw new Error(`磁盘空间不足，剩余 ${(sp.freeBytes / 1e9).toFixed(2)} GB，文件约 ${(total / 1e9).toFixed(2)} GB`);
  }
  const out = fs.createWriteStream(outPath);
  let received = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      if (ref && ref.canceled) throw Object.assign(new Error('已取消'), { canceled: true });
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      out.write(Buffer.from(value));
      if (total) onProgress({ percent: Math.min(99.9, (received / total) * 100), bytes: received });
      else onProgress({ bytes: received });
    }
  } finally {
    out.close();
  }
}

module.exports = { downloadM3u8, downloadDirect };
