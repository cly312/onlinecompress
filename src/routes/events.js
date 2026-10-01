'use strict';

const express = require('express');
const store = require('../store');

const router = express.Router();

// Server-Sent Events: push a snapshot of files+jobs whenever state changes.
// Per-connection throttling keeps idle payloads off the wire; snapshots are
// deduped so identical state is never sent twice.
router.get('/', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let lastPayload = null;
  let pending = false;
  let timer = null;
  let first = true;

  const flush = () => {
    if (!pending || res.writableEnded) return;
    pending = false;
    const payload = JSON.stringify({ files: store.listFiles(), jobs: store.listJobs() });
    if (payload === lastPayload) return;
    lastPayload = payload;
    res.write(`data: ${payload}\n\n`);
  };

  const send = () => {
    pending = true;
    if (first) { // deliver the initial snapshot immediately
      first = false;
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
