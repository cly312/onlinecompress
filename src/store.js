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
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const dump = {
      files: [...state.files.values()],
      jobs: [...state.jobs.values()].map((j) => ({ ...j, pid: undefined })),
    };
    fs.writeFile(STATE_PATH, JSON.stringify(dump), (e) => {
      if (e) console.error('state 持久化失败:', e.message);
    });
  }, 300);
}

function load() {
  if (!fs.existsSync(STATE_PATH)) return;
  try {
    const disk = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    for (const f of disk.files || []) state.files.set(f.id, f);
    for (const j of disk.jobs || []) {
      // Any job that was mid-flight when the process died is now failed.
      if (j.state === 'compressing' || j.state === 'downloading' || j.state === 'queued') {
        j.state = 'failed';
        j.error = '服务重启，任务中断';
        j.finishedAt = Date.now();
      }
      state.jobs.set(j.id, j);
    }
  } catch (e) {
    console.error('state.json 解析失败:', e.message);
  }
}

function emit() {
  bus.emit('change');
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
