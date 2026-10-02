'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const config = require('./config');

const STATE_PATH = path.join(config.DATA_DIR, 'state.json');

const bus = new EventEmitter();
bus.setMaxListeners(0);

const state = {
  files: new Map(), // id -> MediaFile
  jobs: new Map(), // id -> Job
};

function id() {
  return crypto.randomBytes(8).toString('hex');
}

// ---- persistence (debounced) ----
let saveTimer = null;
let writing = false; // 是否有写入在途，避免两次写竞争同一个 .tmp 文件
let dirtyDuringWrite = false;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (writing) {
      // 上一次写入还没完成：记下脏标记，写完后由收尾逻辑再补一次 persist
      dirtyDuringWrite = true;
      return;
    }
    writing = true;
    const dump = {
      files: [...state.files.values()],
      jobs: [...state.jobs.values()].map((j) => ({ ...j, pid: undefined })),
    };
    // 原子写：先写临时文件再 rename，避免进程中途被 kill 留下半截 JSON
    const tmp = STATE_PATH + '.tmp';
    fs.writeFile(tmp, JSON.stringify(dump), (e) => {
      writing = false;
      if (e) {
        console.error('state 持久化失败:', e.message);
        if (dirtyDuringWrite) { dirtyDuringWrite = false; persist(); }
        return;
      }
      fs.rename(tmp, STATE_PATH, (e2) => {
        if (e2) console.error('state 替换失败:', e2.message);
        if (dirtyDuringWrite) { dirtyDuringWrite = false; persist(); }
      });
    });
  }, 300);
}

function load() {
  if (!fs.existsSync(STATE_PATH)) return;
  try {
    const disk = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    for (const f of disk.files || []) state.files.set(f.id, f);
    for (const j of disk.jobs || []) {
      // Jobs that were mid-flight (compressing/downloading) can't resume —
      // mark them failed, and clean up any half-written output they left.
      // Queued jobs never started, so leave them for queue.tick() to run.
      if (j.state === 'compressing' || j.state === 'downloading') {
        j.state = 'failed';
        j.error = '服务重启，任务中断';
        j.finishedAt = Date.now();
        if (j.type === 'compress') {
          const f = state.files.get(j.fileId);
          if (f) {
            // 半成品写在 .part 临时路径（成功后才 rename 到最终输出），
            // 这里只清理 .part，绝不触碰之前有效压缩产物。
            const out = require('./queue').outputPathFor(f);
            try { fs.unlinkSync(out + '.part'); } catch { /* no leftover output */ }
          }
        }
        // 下载任务中断后必须把文件从 downloading 回写为 download_failed，
        // 否则文件永远显示"下载中"且无法重新排队（僵尸记录）。
        // 与压缩分支对称：下载是直接写 dest（无 .part 保护），需清掉半成品。
        if (j.type === 'download') {
          const f = state.files.get(j.fileId);
          // 只有文件确实卡在 downloading 才动它：万一持久化时序让 job 停在
          // downloading 而 file 已是 ready（刚下载完），不能误删合法产物。
          if (f && f.status === 'downloading') {
            f.status = 'download_failed';
            if (f.path) { try { fs.unlinkSync(f.path); } catch { /* no partial file */ } }
          }
        }
      }
      state.jobs.set(j.id, j);
    }
  } catch (e) {
    console.error('state.json 解析失败:', e.message);
  }
}

// Change events are coalesced so high-frequency updates (progress ticks)
// don't broadcast a full snapshot per mutation.
let emitTimer = null;
function emit() {
  if (emitTimer) return;
  emitTimer = setTimeout(() => {
    emitTimer = null;
    bus.emit('change');
  }, 300);
  persist();
}

// ---- files ----
function addFile(f) {
  const rec = { id: id(), addedAt: Date.now(), status: 'ready', ...f };
  state.files.set(rec.id, rec);
  emit();
  return rec;
}
function getFile(fid) {
  return state.files.get(fid);
}
function updateFile(fid, patch) {
  const f = state.files.get(fid);
  if (!f) return;
  Object.assign(f, patch);
  emit();
  return f;
}
function removeFile(fid) {
  state.files.delete(fid);
  emit();
}
function listFiles() {
  return [...state.files.values()].sort((a, b) => b.addedAt - a.addedAt);
}

// ---- jobs ----
function addJob(j) {
  const rec = { id: id(), createdAt: Date.now(), state: 'queued', progress: {}, ...j };
  state.jobs.set(rec.id, rec);
  emit();
  return rec;
}
function getJob(jid) {
  return state.jobs.get(jid);
}
function updateJob(jid, patch) {
  const j = state.jobs.get(jid);
  if (!j) return;
  Object.assign(j, patch);
  if (patch.progress) j.progress = { ...j.progress, ...patch.progress };
  emit();
  return j;
}
function removeJob(jid) {
  state.jobs.delete(jid);
  emit();
}
function listJobs() {
  return [...state.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

module.exports = {
  bus,
  id,
  load,
  emit,
  addFile,
  getFile,
  updateFile,
  removeFile,
  listFiles,
  addJob,
  getJob,
  updateJob,
  removeJob,
  listJobs,
  state,
};
