'use strict';

const express = require('express');
const store = require('../store');

const router = express.Router();

// Server-Sent Events: push state changes to the browser.
// The first message is a full snapshot; afterwards only incremental patches
// (changed files/jobs + removed ids) are sent, so a running job's progress
// tick costs a few dozen bytes instead of re-sending every record.
// Per-connection throttling (1s) keeps idle payloads off the wire.
router.get('/', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // id -> serialized JSON of the last version sent to this client
  let sentFiles = new Map();
  let sentJobs = new Map();
  let pending = false;
  let timer = null;
  let first = true;

  const track = (map, items) => {
    const updated = [];
    const seen = new Set();
    for (const it of items) {
      seen.add(it.id);
      const s = JSON.stringify(it);
      if (map.get(it.id) !== s) {
        map.set(it.id, s);
        updated.push(it);
      }
    }
    const removed = [];
    for (const id of map.keys()) {
      if (!seen.has(id)) {
        removed.push(id);
        map.delete(id);
      }
    }
    return { updated, removed };
  };

  const flush = () => {
    if (!pending || res.writableEnded) return;
    pending = false;
    if (first) {
      first = false;
      const files = store.listFiles();
      const jobs = store.listJobs();
      for (const f of files) sentFiles.set(f.id, JSON.stringify(f));
      for (const j of jobs) sentJobs.set(j.id, JSON.stringify(j));
      res.write(`data: ${JSON.stringify({ full: true, files, jobs })}\n\n`);
      return;
    }
    const f = track(sentFiles, store.listFiles());
    const j = track(sentJobs, store.listJobs());
    if (!f.updated.length && !f.removed.length && !j.updated.length && !j.removed.length) return;
    res.write(`data: ${JSON.stringify({
      files: f.updated,
      jobs: j.updated,
      removedFiles: f.removed,
      removedJobs: j.removed,
    })}\n\n`);
  };

  const send = () => {
    pending = true;
    if (first) { // deliver the initial snapshot immediately
      flush();
      return;
    }
    if (timer) return; // a send is already scheduled
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, 1000);
  };

  send(); // initial snapshot
  store.bus.on('change', send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(ping);
    if (timer) clearTimeout(timer);
    store.bus.off('change', send);
  });
});

module.exports = router;
