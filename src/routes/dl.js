'use strict';

// Public (no-auth) endpoint that serves a compression output via a signed,
// time-limited token. Mounted OUTSIDE the /api auth guard on purpose so links
// can be shared with people who don't have the login password. The token is
// unguessable and expires (see src/dltoken.js); anyone holding a live link can
// download the file until it expires.

const fs = require('fs');
const express = require('express');

const store = require('../store');
const dltoken = require('../dltoken');

const router = express.Router();

router.get('/:token', (req, res) => {
  const v = dltoken.verify(req.params.token);
  if (!v) return res.status(410).type('text/plain; charset=utf-8').send('链接无效或已过期');
  const f = store.getFile(v.fileId);
  if (!f || !f.outputPath || !fs.existsSync(f.outputPath)) {
    return res.status(404).type('text/plain; charset=utf-8').send('压缩结果不存在或已被删除');
  }
  res.download(f.outputPath, `${f.name}_compressed.mp4`);
});

module.exports = router;
