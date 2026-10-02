'use strict';

const express = require('express');
const config = require('../config');
const store = require('../store');
const queue = require('../queue');

const router = express.Router();

function resolveCommand({ command, presetName }) {
  if (command && command.trim()) return command.trim();
  const cfg = config.load();
  const preset =
    cfg.presets.find((p) => p.name === presetName) || cfg.presets[0];
  return preset.command;
}

router.get('/', (req, res) => res.json(store.listJobs()));

router.post('/', (req, res) => {
  const { fileIds, presetName, command } = req.body || {};
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    return res.status(400).json({ error: '未选择文件' });
  }
  const cmd = resolveCommand({ command, presetName });
  if (!cmd.includes('{input}') || !cmd.includes('{output}')) {
    return res.status(400).json({ error: '命令必须包含 {input} 和 {output} 占位符' });
  }
  // Same dedupe as /compress-all: never queue two compress jobs for the
  // same file, otherwise both write the same .part output and corrupt it.
  const active = new Set(
    store
      .listJobs()
      .filter((j) => j.type === 'compress' && ['queued', 'compressing'].includes(j.state))
      .map((j) => j.fileId)
  );
  const created = [];
  let skipped = 0;
  for (const fid of fileIds) {
    const file = store.getFile(fid);
    if (!file || file.status !== 'ready' || !file.path || active.has(fid)) {
      skipped++;
      continue;
    }
    active.add(fid);
    const job = store.addJob({ type: 'compress', fileId: fid, command: cmd, presetName });
    queue.enqueue(job);
    created.push(job);
  }
  res.json({ created, skipped });
});

// One-click: queue every file that has no compression result and isn't
// already in the compress queue.
router.post('/compress-all', (req, res) => {
  const { presetName, command } = req.body || {};
  const cmd = resolveCommand({ command, presetName });
  if (!cmd.includes('{input}') || !cmd.includes('{output}')) {
    return res.status(400).json({ error: '命令必须包含 {input} 和 {output} 占位符' });
  }
  const active = new Set(
    store
      .listJobs()
      .filter((j) => j.type === 'compress' && ['queued', 'compressing'].includes(j.state))
      .map((j) => j.fileId)
  );
  const created = [];
  for (const f of store.listFiles()) {
    if (f.status !== 'ready' || f.outputPath || active.has(f.id)) continue;
    const job = store.addJob({ type: 'compress', fileId: f.id, command: cmd, presetName });
    queue.enqueue(job);
    active.add(f.id);
    created.push(job);
  }
  res.json(created);
});

router.post('/clear-finished', (req, res) => {
  const finished = store
    .listJobs()
    .filter((j) => ['done', 'failed', 'canceled'].includes(j.state));
  for (const j of finished) store.removeJob(j.id);
  res.json({ ok: true, removed: finished.length });
});

router.post('/:id/cancel', (req, res) => {
  const ok = queue.cancel(req.params.id);
  res.json({ ok });
});

router.delete('/:id', (req, res) => {
  const job = store.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  if (['queued', 'downloading', 'compressing'].includes(job.state)) {
    return res.status(400).json({ error: '任务进行中，请先取消' });
  }
  store.removeJob(job.id);
  res.json({ ok: true });
});

module.exports = router;
