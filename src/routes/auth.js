'use strict';

const express = require('express');
const auth = require('../auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  const ip = req.ip;
  if (auth.throttled(ip)) {
    return res.status(429).json({ error: '尝试过多，请稍后再试' });
  }
  const { password } = req.body || {};
  if (!password || !(await auth.verifyPassword(password))) {
    auth.recordFail(ip);
    return res.status(401).json({ error: '密码错误' });
  }
  auth.clearFail(ip);
  auth.setLoginCookie(res);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  auth.clearLoginCookie(res);
  res.json({ ok: true });
});

router.get('/status', (req, res) => {
  res.json({ authed: auth.isAuthed(req) });
});

module.exports = router;
