'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');
const config = require('./config');
const disk = require('./disk');
const { probeDuration, runCompress } = require('./ffmpeg');
const { downloadM3u8, downloadDirect } = require('./download');

let running = null; // { jobId, cancel() }

function outputPathFor(file) {
  const cfg = config.load();
  // Prefix with the file id so different sources that share a base name don't
  // collide on one output file — a collision would let one compression
  // overwrite another's result (so their download links serve the wrong
  // video) and let deleting one file wipe the output others still link to.
  // The user-facing download name stays `${file.name}_compressed.mp4`: both
  // /dl and /api/files/:id/output pass it as res.download's second argument.
  return path.join(cfg.dirs.outputs, `${file.id}_${file.name}_compressed.mp4`);
}

function enqueue(job) {
  tick();
  return job;
}

function tick() {
  if (running) return;
  const next = store.listJobs().reverse().find((j) => j.state === 'queued');
  if (!next) return;
  runJob(next);
}

async function runJob(job) {
  const file = store.getFile(job.fileId);
  if (!file) {
    store.updateJob(job.id, { state: 'failed', error: '源文件不存在', finishedAt: Date.now() });
    return tick();
  }
  const ctl = { canceled: false, proc: null };
  running = {
    jobId: job.id,
    cancel() {
      ctl.canceled = true;
      if (ctl.proc) ctl.proc.kill('SIGKILL');
    },
  };
  store.updateJob(job.id, { startedAt: Date.now() });

  try {
    if (job.type === 'download') {
      await doDownload(job, file, ctl);
    } else {
      await doCompress(job, file, ctl);
    }
  } catch (e) {
    const canceled = e && e.canceled;
    store.updateJob(job.id, {
      state: canceled ? 'canceled' : 'failed',
      error: canceled ? '已取消' : e.message,
      finishedAt: Date.now(),
    });
    if (job.type === 'download') store.updateFile(file.id, { status: 'download_failed' });
  } finally {
    running = null;
    tick();
  }
}

async function doDownload(job, file, ctl) {
  const cfg = config.load();
  const space = await disk.check(cfg.dirs.uploads);
  if (!space.ok) throw new Error(`磁盘空间不足，剩余 ${(space.freeBytes / 1e9).toFixed(2)} GB`);
  store.updateJob(job.id, { state: 'downloading', progress: {} });
  store.updateFile(file.id, { status: 'downloading' });
  const isM3u8 = file.ext === 'm3u8' || /\.m3u8(\?|$)/i.test(file.srcUrl || '');
  const outName = isM3u8 ? `${file.name}.ts` : `${file.name}.${file.ext || 'mp4'}`;
  const dest = path.join(cfg.dirs.uploads, `${file.id}_${outName}`);

  const onP = (p) => store.updateJob(job.id, { progress: p });
  if (isM3u8) {
    await downloadM3u8(file.srcUrl, dest, onP, ctl);
  } else {
    await downloadDirect(file.srcUrl, dest, onP, ctl);
  }
  const duration = await probeDuration(dest);
  store.updateFile(file.id, {
    status: 'ready',
    path: dest,
    ext: isM3u8 ? 'ts' : file.ext,
    sizeBytes: safeSize(dest),
    durationSec: duration,
  });
  store.updateJob(job.id, { state: 'done', progress: { percent: 100 }, finishedAt: Date.now() });
}

async function doCompress(job, file, ctl) {
  if (file.status !== 'ready' || !file.path) throw new Error('源文件尚未就绪');
  const cfg = config.load();
  // Reserve the configured minimum plus a rough estimate (source size) for the output.
  const space = await disk.check(cfg.dirs.outputs, file.sizeBytes || 0);
  if (!space.ok) throw new Error(`磁盘空间不足，剩余 ${(space.freeBytes / 1e9).toFixed(2)} GB，无法写入输出`);
  store.updateJob(job.id, { state: 'compressing', progress: {} });
  const output = outputPathFor(file);
  const duration = file.durationSec || (await probeDuration(file.path));

  const runner = runCompress(
    { command: job.command, inputPath: file.path, outputPath: output, duration },
    (p) => store.updateJob(job.id, { progress: p })
  );
  ctl.proc = runner.proc;
  await runner.done;

  store.updateJob(job.id, {
    state: 'done',
    progress: { percent: 100 },
    outputPath: output,
    finishedAt: Date.now(),
  });
  store.updateFile(file.id, { outputPath: output });

  if (config.load().deleteSourceOnSuccess) {
    try {
      if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
      store.updateFile(file.id, { status: 'source_deleted', path: null });
    } catch (e) {
      console.error('删除源文件失败:', e.message);
    }
  }
}

function cancel(jobId) {
  const job = store.getJob(jobId);
  if (!job) return false;
  if (running && running.jobId === jobId) {
    running.cancel();
    return true;
  }
  if (job.state === 'queued') {
    store.updateJob(jobId, { state: 'canceled', finishedAt: Date.now() });
    return true;
  }
  return false;
}

function safeSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

module.exports = { enqueue, tick, cancel, outputPathFor, running: () => running };
