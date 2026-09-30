'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { parse } = require('shell-quote');

const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';

// ---- safe command template -> argv ----
// The user supplies a raw ffmpeg command with {input}/{output} placeholders.
// We parse it with shell-quote WITHOUT ever going through a shell. If parsing
// yields any operator object (;, &&, |, $(), backticks, redirects, glob...),
// we reject it — that prevents command injection while still allowing the
// full range of ffmpeg flags.
function buildArgs(command, inputPath, outputPath) {
  // Empty env so any $VAR expands to '' rather than leaking process env.
  const parsed = parse(command, {});
  const tokens = [];
  for (const tok of parsed) {
    if (typeof tok === 'string') {
      tokens.push(tok);
    } else if (tok && tok.op === 'glob' && typeof tok.pattern === 'string') {
      // ffmpeg args like "0:a:0?" contain '?'/'*' — literal to ffmpeg, not a shell glob.
      tokens.push(tok.pattern);
    } else {
      // Any control operator (; && || | & > < ( ) ), command substitution, or comment.
      throw new Error('命令中包含不允许的 shell 元字符（如 ; && | $() 等），已拒绝执行');
    }
  }
  const mapped = tokens.map((t) =>
    t.replace(/\{input\}/g, inputPath).replace(/\{output\}/g, outputPath)
  );
  if (mapped.length === 0) throw new Error('命令为空');
  if (path.basename(mapped[0]).replace(/\.exe$/i, '') !== 'ffmpeg') {
    throw new Error('命令必须以 ffmpeg 开头');
  }
  if (!command.includes('{input}')) throw new Error('命令缺少 {input} 占位符');
  if (!command.includes('{output}')) throw new Error('命令缺少 {output} 占位符');
  // Drop the leading "ffmpeg" (we call FFMPEG directly) and inject progress flags.
  const rest = mapped.slice(1);
  return ['-y', '-nostdin', ...rest, '-progress', 'pipe:1', '-nostats'];
}

// ---- duration probe (seconds) ----
function probeDuration(input) {
  return new Promise((resolve) => {
    const p = spawn(FFPROBE, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      input,
    ]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const sec = parseFloat(out.trim());
      resolve(Number.isFinite(sec) && sec > 0 ? sec : null);
    });
  });
}

// ---- run compression ----
// Returns { proc, done } where done is a promise resolving on success and
// rejecting on failure/cancel. onProgress({percent,timeSec,speed,fps,etaSec}).
function runCompress({ command, inputPath, outputPath, duration }, onProgress) {
  const args = buildArgs(command, inputPath, outputPath);
  const proc = spawn(FFMPEG, args, { shell: false });
  let stderrTail = '';
  let killed = false;

  proc.stdout.on('data', (buf) => {
    const text = buf.toString();
    const prog = {};
    for (const line of text.split('\n')) {
      const [k, v] = line.split('=');
      if (!v) continue;
      if (k === 'out_time_ms') prog.timeSec = parseInt(v, 10) / 1e6;
      else if (k === 'out_time_us') prog.timeSec = parseInt(v, 10) / 1e6;
      else if (k === 'speed') prog.speed = parseFloat(v);
      else if (k === 'fps') prog.fps = parseFloat(v);
    }
    if (prog.timeSec != null) {
      if (duration) {
        prog.percent = Math.min(99.9, (prog.timeSec / duration) * 100);
        if (prog.speed > 0) prog.etaSec = Math.max(0, (duration - prog.timeSec) / prog.speed);
      }
      onProgress(prog);
    }
  });

  proc.stderr.on('data', (buf) => {
    stderrTail = (stderrTail + buf.toString()).slice(-4000);
  });

  const done = new Promise((resolve, reject) => {
    proc.on('error', (e) => reject(new Error('无法启动 ffmpeg: ' + e.message)));
    proc.on('close', (code) => {
      if (killed) return reject(Object.assign(new Error('已取消'), { canceled: true }));
      if (code === 0) return resolve();
      reject(new Error('ffmpeg 退出码 ' + code + '\n' + stderrTail.slice(-1500)));
    });
  });

  return {
    proc,
    done,
    cancel() {
      killed = true;
      proc.kill('SIGKILL');
    },
  };
}

module.exports = { FFMPEG, FFPROBE, buildArgs, probeDuration, runCompress };
