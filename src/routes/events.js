'use strict';

const express = require('express');
const store = require('../store');

const router = express.Router();

// Server-Sent Events: push a snapshot of files+jobs whenever state changes.
router.get('/', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = () => {
    const payload = JSON.stringify({ files: store.listFiles(), jobs: store.listJobs() });
    res.write(`data: ${payload}\n\n`);
  };

  send(); // initial snapshot
  store.bus.on('change', send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(ping);
    store.bus.off('change', send);
  });
});

module.exports = router;
