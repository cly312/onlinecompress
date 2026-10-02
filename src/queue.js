'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');
const config = require('./config');
const disk = require('./disk');
const { probeDuration, runCompress } = require('./ffmpeg');
const { downloadM3u8, downloadDirect } = require('./download');

// Per-type concurrency: downloads and compresses each have their own limit
// (config.maxDownloads / config.maxCompresses), so e.g. a slow download
// doesn't block compressions of already-ready files.
const running = new Map(); // jobId -> { cancel() }

function runningCount(type) {
  let n = 0;
  for (const job of store.listJobs()) {
    if (running.has(job.id) && job.type === type) n++;
  }
  return n;
}

function limitFor(type) {
  const cfg = config.load();
  const n = type === 'download' ? cfg.maxDownloads : cfg.maxCompresses;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

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
  // Oldest queued first (store keeps newest-first, hence the reverse).
  const queued = store.listJobs().reverse().filter((j) => j.state === 'queued');
  // Seed slots with running counts so re-entrant ticks can't oversubscribe.
  const slots = {
    download: Math.max(0, limitFor('download') - runningCount('download')),
    compress: Math.max(0, limitFor('compress') - runningCount('compress')),
  };
  for (const job of queued) {
    // A freshly started job stays 'queued' until its first await; never start twice.
    if (running.has(job.id)) continue;
    const type = job.type === 'download' ? 'download' : 'compress';
    if (slots[type] <= 0) continue;
    slots[type]--;
    runJob(job);
  }
}

async function runJob(job) {
  const file = store.getFile(job.fileId);
  if (!file) {
    store.updateJob(job.id, { state: 'failed', error: '源文件不存在', finishedAt: Date.now() });
    return tick();
  }
  const ctl = {
    canceled: false,
    proc: null,
    // 由实际执行方（如 runCompress）注册的取消函数——它会在内部设 killed
    // 标志，使 close 事件走 canceled 分支；没有时退回直接杀进程。
    cancelFn: null,
  };
  running.set(job.id, {
    cancel() {
      ctl.canceled = true;
      if (ctl.cancelFn) ctl.cancelFn();
      else if (ctl.proc) ctl.proc.kill('SIGKILL');
    },
  });
  store.updateJob(job.id, { startedAt: Date.now() });

  try {
    if (job.type === 'download') {
      await doDownload(job, file, ctl);
      // Downloads don't "compress" — record just the source size + duration.
      store.updateJob(job.id, {
        stats: {
          sourceBytes: safeSize(file.path),
          outputBytes: null,
          ratioPct: null,
          elapsedMs: Date.now() - job.startedAt,
        },
      });
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
    running.delete(job.id);
    tick();
  }
}

async function doDownload(job, file, ctl) {
  // runJob 注册 running map 后到首个 await 前有一个取消竞态窗口：
  // ctl.canceled 置位但没人再检查，任务会照常跑完——开头显式检查。
  if (ctl.canceled) throw Object.assign(new Error('已取消'), { canceled: true });
  const cfg = config.load();
  const space = await disk.check(cfg.dirs.uploads);
  if (ctl.canceled) throw Object.assign(new Error('已取消'), { canceled: true });
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
  if (ctl.canceled) throw Object.assign(new Error('已取消'), { canceled: true });
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
  if (ctl.canceled) throw Object.assign(new Error('已取消'), { canceled: true });
  if (file.status !== 'ready' || !file.path) throw new Error('源文件尚未就绪');
  const cfg = config.load();
  // Reserve the configured minimum plus a rough estimate (source size) for the output.
  const space = await disk.check(cfg.dirs.outputs, file.sizeBytes || 0);
  if (ctl.canceled) throw Object.assign(new Error('已取消'), { canceled: true });
  if (!space.ok) throw new Error(`磁盘空间不足，剩余 ${(space.freeBytes / 1e9).toFixed(2)} GB，无法写入输出`);
  store.updateJob(job.id, { state: 'compressing', progress: {} });
  const output = outputPathFor(file);
  // Write to a .part temp file and rename on success, so an interrupted
  // compress never clobbers a previously valid output at the final path.
  const tmpOutput = output + '.part';
  const duration = file.durationSec || (await probeDuration(file.path));
  // probeDuration 可能耗时数秒，spawn 前再查一次，避免取消后仍启动压缩。
  if (ctl.canceled) throw Object.assign(new Error('已取消'), { canceled: true });

  const runner = runCompress(
    { command: job.command, inputPath: file.path, outputPath: tmpOutput, duration },
    (p) => store.updateJob(job.id, { progress: p })
  );
  ctl.proc = runner.proc;
  ctl.cancelFn = runner.cancel;
  try {
    await runner.done;
  } catch (e) {
    try { fs.unlinkSync(tmpOutput); } catch { /* already gone */ }
    throw e;
  }
  fs.renameSync(tmpOutput, output);

  const sSize = safeSize(file.path);
  const oSize = safeSize(output);
  store.updateJob(job.id, {
    state: 'done',
    progress: { percent: 100 },
    outputPath: output,
    finishedAt: Date.now(),
    stats: {
      sourceBytes: sSize,
      outputBytes: oSize,
      ratioPct: sSize > 0 ? Math.round((oSize / sSize) * 1000) / 10 : null,
      elapsedMs: Date.now() - job.startedAt,
    },
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
  const r = running.get(jobId);
  if (r) {
    r.cancel();
    return true;
  }
  if (job.state === 'queued') {
    store.updateJob(jobId, { state: 'canceled', finishedAt: Date.now() });
    // 回写文件状态，避免文件页上留下永远卡在 pending 的僵尸记录
    if (job.type === 'download') store.updateFile(job.fileId, { status: 'download_failed' });
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
