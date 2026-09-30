'use strict';

// Interactive first-run setup: sets the login password and port, then writes
// config.json (password stored as a bcrypt hash).

const readline = require('readline');
const bcrypt = require('bcryptjs');
const config = require('../src/config');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, opts = {}) =>
  new Promise((resolve) => {
    if (opts.hidden) {
      const stdin = process.stdin;
      process.stdout.write(q);
      stdin.on('data', mask);
      function mask() {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(q + '*'.repeat(rl.line.length));
      }
      rl.question('', (a) => {
        stdin.off('data', mask);
        process.stdout.write('\n');
        resolve(a);
      });
    } else {
      rl.question(q, resolve);
    }
  });

(async () => {
  const cfg = config.load();
  console.log('=== onlinecompress 初始化设置 ===');

  const portStr = await ask(`监听端口 [${cfg.port}]: `);
  if (portStr.trim()) cfg.port = parseInt(portStr.trim(), 10);

  const hostStr = await ask(`监听地址 [${cfg.host}] (建议 127.0.0.1 + 反向代理): `);
  if (hostStr.trim()) cfg.host = hostStr.trim();

  let pw = '';
  for (;;) {
    pw = await ask('设置登录密码: ', { hidden: true });
    if (pw.length < 4) {
      console.log('密码至少 4 位，请重试。');
      continue;
    }
    const pw2 = await ask('再次输入密码: ', { hidden: true });
    if (pw !== pw2) {
      console.log('两次输入不一致，请重试。');
      continue;
    }
    break;
  }
  cfg.passwordHash = await bcrypt.hash(pw, 10);

  config.save(cfg);
  console.log(`\n完成！配置已写入 config.json。用  npm start  启动，访问 http://${cfg.host}:${cfg.port}`);
  rl.close();
})();
