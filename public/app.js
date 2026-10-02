'use strict';

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
let STATE = { files: [], jobs: [] };
let PRESETS = [];
let selected = new Set();

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {},
    ...opts,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('未登录');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
}

function fmtBytes(n) {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + u[i];
}
function fmtDur(s) {
  if (s == null) return '—';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(sec).padStart(2, '0');
}

// A file can be selected if its source is ready to compress OR it already has
// a compression result (so its download link can be copied even after the
// source was auto-deleted).
const isSelectable = (f) => f.status === 'ready' || !!f.outputPath;

// Copy text to the clipboard, with a fallback for non-secure (http) contexts
// where navigator.clipboard is unavailable. Returns true on success.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// ---------- auth ----------
function showLogin() {
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden');
}
function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  initSSE();
  loadSettings();
  refreshDisk();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
    $('#login-err').textContent = '';
    showApp();
  } catch (err) {
    $('#login-err').textContent = err.message;
  }
});
$('#logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  location.reload();
});

// ---------- tabs ----------
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    ['files', 'jobs', 'settings'].forEach((t) => {
      $('#tab-' + t).classList.toggle('hidden', t !== btn.dataset.tab);
    });
  });
});

// ---------- SSE ----------
function initSSE() {
  if (initSSE._src) return;
  const src = new EventSource('/api/events');
  initSSE._src = src;
  src.onmessage = (e) => {
    STATE = JSON.parse(e.data);
    renderFiles();
    renderJobs();
    refreshDisk();
  };
  src.onerror = () => {}; // browser auto-reconnects
}

// ---------- disk space ----------
let _diskT = 0;
async function refreshDisk() {
  if (Date.now() - _diskT < 4000) return; // throttle
  _diskT = Date.now();
  try {
    const d = await api('/api/settings/disk');
    const el = $('#disk');
    if (d.unavailable || !d.totalBytes) { el.textContent = ''; return; }
    const usedPct = ((d.totalBytes - d.freeBytes) / d.totalBytes) * 100;
    const low = d.freeBytes < (d.minFreeMB || 0) * 1024 * 1024 * 1.5;
    el.className = 'diskbar' + (low ? ' low' : '');
    el.innerHTML = `磁盘：剩余 <b>${fmtBytes(d.freeBytes)}</b> / ${fmtBytes(d.totalBytes)}
      <span class="track"><div style="width:${usedPct.toFixed(1)}%"></div></span>
      ${low ? '空间偏低' : ''}`;
  } catch {}
}

// ---------- files ----------
function renderFiles() {
  const list = $('#file-list');
  list.innerHTML = '';
  // Drop selections for files that are gone or no longer selectable.
  const readyIds = new Set(STATE.files.filter(isSelectable).map((f) => f.id));
  for (const id of selected) if (!readyIds.has(id)) selected.delete(id);
  for (const f of STATE.files) {
    const el = document.createElement('div');
    el.className = 'item';
    const canSelect = isSelectable(f);
    const checked = selected.has(f.id) ? 'checked' : '';
    el.innerHTML = `
      <div class="top">
        <input type="checkbox" class="sel" data-id="${f.id}" ${checked} ${canSelect ? '' : 'disabled'} />
        <div>
          <div class="name" title="${esc(f.name)}.${esc(f.ext || '')}">${esc(truncName(f.name))}.${esc(f.ext || '')}</div>
          <div class="meta">${statusLabel(f.status)} · ${fmtBytes(f.sizeBytes)} · 时长 ${fmtDur(f.durationSec)}${f.sourceType === 'url' ? ' · 链接' : ''}</div>
        </div>
        <span class="badge st-${f.status}">${statusLabel(f.status)}</span>
        <div class="actions">
          ${f.outputPath ? `<a class="ghost" href="/api/files/${f.id}/output">下载结果</a>` : ''}
          <button class="ghost del" data-id="${f.id}">删除</button>
        </div>
      </div>`;
    list.appendChild(el);
  }
  $$('.sel').forEach((c) => c.addEventListener('change', (e) => {
    const id = e.target.dataset.id;
    e.target.checked ? selected.add(id) : selected.delete(id);
    syncSelectAll();
  }));
  $$('#file-list .del').forEach((b) => b.addEventListener('click', () => delFile(b.dataset.id)));
  syncSelectAll();
}

// Keep the "全选" checkbox in sync with individual selections.
function syncSelectAll() {
  const sa = $('#select-all');
  const ready = STATE.files.filter(isSelectable);
  const n = ready.filter((f) => selected.has(f.id)).length;
  sa.checked = n > 0 && n === ready.length;
  sa.indeterminate = n > 0 && n < ready.length;
}

// 文件名超过 20 个字符时，只显示前 20 个并加省略号
function truncName(s, max = 20) {
  s = String(s);
  return s.length > max ? s.slice(0, max) + '……' : s;
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function statusLabel(s) {
  return { ready: '就绪', pending: '等待下载', downloading: '下载中', download_failed: '下载失败', source_deleted: '源已删除' }[s] || s;
}

// ---- chunked resumable upload ----
const CHUNK_SIZE = 4 * 1024 * 1024; // must match server chunk size
const CHUNK_RETRIES = 5;

function fileKey(f) {
  return `${encodeURIComponent(f.name)}_${f.size}_${f.lastModified}`;
}

// Send one XHR with cancel support. Rejects with AbortError if the signal is
// already aborted or gets aborted mid-flight; cleans up its abort listener.
function sendXhr(method, url, body, signal, headers) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('上传已取消', 'AbortError'));
    const xhr = new XMLHttpRequest();
    let onAbort = null;
    if (signal) {
      onAbort = () => xhr.abort();
      signal.addEventListener('abort', onAbort);
    }
    const done = (fn, arg) => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      fn(arg);
    };
    xhr.open(method, url);
    for (const [k, v] of Object.entries(headers || {})) xhr.setRequestHeader(k, v);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON body */ }
      done(resolve, { status: xhr.status, data });
    };
    xhr.onerror = () => done(reject, new Error('网络错误'));
    xhr.onabort = () => done(reject, new DOMException('上传已取消', 'AbortError'));
    xhr.send(body);
  });
}

// Upload one file in chunks; returns the created file record.
// Resumable: asks the server which chunks it already has and only sends the
// missing ones, so a page reload or network blip continues where it stopped.
// `signal` (AbortSignal) cancels the upload: in-flight chunk XHR is aborted
// and the server-side session (chunk files) is deleted.
function uploadFileChunked(f, onProgress, signal) {
  const total = Math.ceil(f.size / CHUNK_SIZE);
  const chunkSize = (i) => Math.min(CHUNK_SIZE, f.size - i * CHUNK_SIZE);
  return (async () => {
    const { status, data: init } = await sendXhr('POST', '/api/upload/init',
      JSON.stringify({ name: f.name, size: f.size, fileKey: fileKey(f) }),
      signal, { 'Content-Type': 'application/json' });
    if (status !== 200) throw new Error('初始化上传失败');

    const have = new Set(init.received);
    let sent = 0;
    for (const i of have) sent += chunkSize(i);

    const uploadChunk = async (i) => {
      const start = i * CHUNK_SIZE;
      const blob = f.slice(start, start + chunkSize(i));
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await sendXhr('PUT', `/api/upload/${init.uploadId}/${i}`, blob, signal);
          if (r.status >= 400) throw new Error(`分片 ${i} 上传失败`);
          return;
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          if (attempt >= CHUNK_RETRIES) throw err;
          await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 10000)));
          if (signal?.aborted) throw new DOMException('上传已取消', 'AbortError');
        }
      }
    };

    try {
      for (let i = 0; i < total; i++) {
        if (have.has(i)) continue;
        await uploadChunk(i);
        sent += chunkSize(i);
        onProgress(sent / f.size);
      }
      const r = await sendXhr('POST', `/api/upload/${init.uploadId}/complete`, '{}',
        signal, { 'Content-Type': 'application/json' });
      if (r.status >= 400) throw new Error('合并分片失败');
      return r.data;
    } catch (err) {
      // Cancel or permanent failure: remove the server-side session so no
      // chunk files are left behind.
      fetch(`/api/upload/${init.uploadId}`, { method: 'DELETE' }).catch(() => {});
      throw err;
    }
  })();
}

// ---- cancel upload ----
let uploadCtl = null; // AbortController for the current upload batch, if any

// Per-file upload rows: each file gets its own progress bar and status line.
const uploadRows = new Map(); // fileKey -> {el}

function uploadStatusRow(f) {
  const el = document.createElement('div');
  el.className = 'item upload-item';
  el.innerHTML = `
    <div class="top">
      <div>
        <div class="name" title="${esc(f.name)}">${esc(truncName(f.name))}</div>
        <div class="meta upload-meta">等待中 · ${fmtBytes(f.size)}</div>
      </div>
      <span class="badge st-queued">排队中</span>
    </div>
    <div class="bar"><div style="width:0%"></div></div>`;
  return el;
}

function renderUploadList() {
  const wrap = $('#upload-list');
  const row = $('#upload-row');
  wrap.innerHTML = '';
  if (!uploadRows.size) {
    wrap.classList.add('hidden');
    row.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  row.classList.remove('hidden');
  for (const u of uploadRows.values()) wrap.appendChild(u.el);
}

function setUploadRow(f, { pct, state, text }) {
  const u = uploadRows.get(fileKey(f));
  if (!u) return;
  if (pct != null) u.el.querySelector('.bar > div').style.width = pct.toFixed(1) + '%';
  const badge = u.el.querySelector('.badge');
  const meta = u.el.querySelector('.upload-meta');
  if (state === 'uploading') { badge.className = 'badge st-compressing'; badge.textContent = '上传中'; }
  else if (state === 'done') { badge.className = 'badge st-done'; badge.textContent = '完成'; }
  else if (state === 'failed') { badge.className = 'badge st-failed'; badge.textContent = '失败'; }
  else if (state === 'canceled') { badge.className = 'badge st-download_failed'; badge.textContent = '已取消'; }
  else if (state === 'queued') { badge.className = 'badge st-queued'; badge.textContent = '排队中'; }
  if (text != null) meta.textContent = text;
}

function removeUploadRow(f) {
  uploadRows.delete(fileKey(f));
  renderUploadList();
}

$('#cancel-upload').addEventListener('click', () => {
  if (uploadCtl) uploadCtl.abort();
});

$('#file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  if (uploadCtl) { toast('已有上传在进行中，请等待完成或先取消'); return; }
  const ctl = new AbortController();
  uploadCtl = ctl;
  for (const f of files) uploadRows.set(fileKey(f), { el: uploadStatusRow(f) });
  renderUploadList();

  // Upload files one at a time; each has its own progress row.
  let doneCount = 0;
  let failCount = 0;
  for (const f of files) {
    setUploadRow(f, { state: 'uploading', text: '上传中 · ' + fmtBytes(f.size) });
    try {
      await uploadFileChunked(f, (p) => {
        setUploadRow(f, { pct: p * 100, text: `上传中 ${(p * 100).toFixed(0)}% · ${fmtBytes(f.size)}` });
      }, ctl.signal);
      setUploadRow(f, { pct: 100, state: 'done', text: '完成 · ' + fmtBytes(f.size) });
      doneCount++;
      setTimeout(() => removeUploadRow(f), 3000);
    } catch (err) {
      if (err.name === 'AbortError') {
        setUploadRow(f, { state: 'canceled', text: '已取消，临时文件已清理' });
        setTimeout(() => removeUploadRow(f), 3000);
        break;
      }
      setUploadRow(f, { state: 'failed', text: '失败：' + err.message });
      failCount++;
      setTimeout(() => removeUploadRow(f), 8000);
    }
  }

  uploadCtl = null;
  if (!ctl.signal.aborted) {
    if (failCount) toast(`上传完成：${doneCount} 成功，${failCount} 失败`);
    else if (doneCount) toast(`已上传 ${doneCount} 个文件`);
  }
});

$('#add-url').addEventListener('click', async () => {
  const raw = $('#url-input').value.trim();
  if (!raw) return;
  const urls = raw.split(/[\r\n]+/).map((u) => u.trim()).filter(Boolean);
  try {
    const r = await api('/api/files/urls', { method: 'POST', body: JSON.stringify({ urls }) });
    $('#url-input').value = '';
    let msg = `已添加 ${r.created.length} 个链接，开始下载`;
    if (r.errors && r.errors.length) msg += `（${r.errors.length} 个无效已跳过）`;
    toast(msg);
  } catch (err) { toast(err.message); }
});

async function delFile(id) {
  if (!confirm('删除该文件？')) return;
  try { await api('/api/files/' + id + '?output=1', { method: 'DELETE' }); selected.delete(id); }
  catch (err) { toast(err.message); }
}

$('#del-selected').addEventListener('click', async () => {
  const ids = [...selected];
  if (!ids.length) return toast('请先选择文件');
  if (!confirm(`删除选中的 ${ids.length} 个文件？`)) return;
  try {
    const r = await api('/api/files/batch-delete', { method: 'POST', body: JSON.stringify({ ids, output: 1 }) });
    ids.forEach((id) => selected.delete(id));
    toast(`已删除 ${r.removed} 个文件`);
  } catch (err) { toast(err.message); }
});

$('#copy-links').addEventListener('click', async () => {
  const ids = [...selected];
  if (!ids.length) return toast('请先选择文件');
  try {
    const r = await api('/api/files/links', { method: 'POST', body: JSON.stringify({ ids }) });
    if (!r.links.length) return toast('选中文件均无压缩结果，无可复制链接');
    const text = r.links.join('\n');
    const ok = await copyText(text);
    let msg = `已复制 ${r.links.length} 个下载链接（${r.ttlHours}h 内有效）`;
    if (r.skipped) msg += `，跳过 ${r.skipped} 个无结果`;
    if (ok) {
      toast(msg);
    } else {
      // Clipboard blocked (e.g. non-HTTPS): let the user copy manually.
      prompt('自动复制失败，请手动复制以下链接：', text);
    }
  } catch (err) { toast(err.message); }
});

// ---------- compress controls ----------
$('#select-all').addEventListener('change', (e) => {
  selected.clear();
  if (e.target.checked) STATE.files.filter(isSelectable).forEach((f) => selected.add(f.id));
  renderFiles();
});

$('#edit-cmd').addEventListener('click', () => {
  const box = $('#cmd-box');
  box.classList.toggle('hidden');
  if (!box.classList.contains('hidden') && !box.value) {
    const p = PRESETS.find((x) => x.name === $('#preset-select').value) || PRESETS[0];
    box.value = p ? p.command : '';
  }
});
$('#preset-select').addEventListener('change', () => {
  const box = $('#cmd-box');
  if (!box.classList.contains('hidden')) {
    const p = PRESETS.find((x) => x.name === $('#preset-select').value);
    if (p) box.value = p.command;
  }
});

$('#start-btn').addEventListener('click', async () => {
  // Only files with a ready source can be (re)compressed; selections may also
  // include result-only files (kept selectable for link copying) — skip those.
  const fileIds = [...selected].filter((id) => {
    const f = STATE.files.find((x) => x.id === id);
    return f && f.status === 'ready';
  });
  if (!fileIds.length) return toast('请先选择就绪的文件');
  const body = { fileIds };
  const box = $('#cmd-box');
  if (!box.classList.contains('hidden') && box.value.trim()) body.command = box.value.trim();
  else body.presetName = $('#preset-select').value;
  try {
    const r = await api('/api/jobs', { method: 'POST', body: JSON.stringify(body) });
    toast(r.skipped ? `已加入 ${r.created.length} 个压缩任务，跳过 ${r.skipped} 个（文件未就绪）` : `已加入 ${r.created.length} 个压缩任务`);
    selected.clear();
    $('#select-all').checked = false;
    renderFiles();
    document.querySelector('.tab[data-tab=jobs]').click();
  } catch (err) { toast(err.message); }
});

// ---------- compress all ----------
$('#compress-all').addEventListener('click', async () => {
  if (!confirm('将所有「没有压缩结果且不在压缩队列」的文件加入队列？')) return;
  const body = {};
  const box = $('#cmd-box');
  if (!box.classList.contains('hidden') && box.value.trim()) body.command = box.value.trim();
  else body.presetName = $('#preset-select').value;
  try {
    const jobs = await api('/api/jobs/compress-all', { method: 'POST', body: JSON.stringify(body) });
    if (!jobs.length) return toast('没有符合条件（无结果且未在队列中）的文件');
    toast(`已加入 ${jobs.length} 个压缩任务`);
    document.querySelector('.tab[data-tab=jobs]').click();
  } catch (err) { toast(err.message); }
});

// ---------- jobs ----------
function renderJobs() {
  const list = $('#job-list');
  list.innerHTML = '';
  if (!STATE.jobs.length) { list.innerHTML = '<p class="hint">暂无任务</p>'; return; }
  for (const j of STATE.jobs) {
    const f = STATE.files.find((x) => x.id === j.fileId);
    const name = f ? `${f.name}.${f.ext || ''}` : j.fileId;
    const displayName = f ? `${truncName(f.name)}.${f.ext || ''}` : j.fileId;
    const p = j.progress || {};
    const pct = p.percent != null ? p.percent.toFixed(1) + '%' : '';
    const active = ['queued', 'downloading', 'compressing'].includes(j.state);
    let detail = j.state === 'compressing'
      ? `${pct} · ${p.speed ? p.speed + 'x' : ''} ${p.fps ? '· ' + Math.round(p.fps) + 'fps' : ''} ${p.etaSec != null ? '· 剩 ' + fmtDur(p.etaSec) : ''}`
      : j.state === 'downloading' ? `下载中 ${pct}` : (j.error || jobStateLabel(j.state));
    if (j.state === 'done' && j.stats) {
      const s = j.stats;
      const parts = [];
      if (s.sourceBytes != null) parts.push(`源 ${fmtBytes(s.sourceBytes)}`);
      if (s.outputBytes != null) parts.push(`输出 ${fmtBytes(s.outputBytes)}`);
      if (s.ratioPct != null) parts.push(`压缩率 ${s.ratioPct}%`);
      if (s.elapsedMs != null) parts.push(`耗时 ${fmtDur(s.elapsedMs / 1000)}`);
      if (parts.length) detail = parts.join(' · ');
    }
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `
      <div class="top">
        <div>
          <div class="name" title="${esc(name)}">${esc(displayName)} <span class="hint">${j.type === 'download' ? '[下载]' : '[压缩]'}</span></div>
          <div class="meta">${esc(detail)}</div>
        </div>
        <span class="badge st-${j.state}">${jobStateLabel(j.state)}</span>
        <div class="actions">
          ${active ? `<button class="ghost cancel" data-id="${j.id}">取消</button>` : `<button class="ghost rmjob" data-id="${j.id}">清除</button>`}
        </div>
      </div>
      ${active && j.type !== 'download' || (j.type==='download'&&j.state==='downloading') ? `<div class="bar"><div style="width:${p.percent || 0}%"></div></div>` : ''}`;
    list.appendChild(el);
  }
  $$('#job-list .cancel').forEach((b) => b.addEventListener('click', () => api('/api/jobs/' + b.dataset.id + '/cancel', { method: 'POST' })));
  $$('#job-list .rmjob').forEach((b) => b.addEventListener('click', () => api('/api/jobs/' + b.dataset.id, { method: 'DELETE' }).catch((e) => toast(e.message))));
}
function jobStateLabel(s) {
  return { queued: '排队中', downloading: '下载中', compressing: '压缩中', done: '完成', failed: '失败', canceled: '已取消' }[s] || s;
}

$('#clear-finished').addEventListener('click', async () => {
  try {
    const r = await api('/api/jobs/clear-finished', { method: 'POST' });
    toast(r.removed ? `已清除 ${r.removed} 个任务` : '没有已完成的任务');
  } catch (err) { toast(err.message); }
});

// ---------- settings ----------
async function loadSettings() {
  const s = await api('/api/settings');
  PRESETS = s.presets || [];
  $('#s-port').value = s.port;
  $('#s-host').value = s.host;
  $('#s-maxdl').value = s.maxDownloads;
  $('#s-maxcp').value = s.maxCompresses;
  $('#s-minfree').value = s.minFreeMB;
  $('#s-delsrc').checked = s.deleteSourceOnSuccess;
  renderPresetSelect();
  renderPresetList();
}

function renderPresetSelect() {
  const sel = $('#preset-select');
  const cur = sel.value;
  sel.innerHTML = '';
  for (const p of PRESETS) {
    const o = document.createElement('option');
    o.value = p.name; o.textContent = p.name;
    sel.appendChild(o);
  }
  if (cur) sel.value = cur;
}

function renderPresetList() {
  const box = $('#preset-list');
  box.innerHTML = '';
  for (const p of PRESETS) {
    const row = document.createElement('div');
    row.className = 'preset-row';
    row.innerHTML = `
      <div style="flex:1">
        <input type="text" class="pn" value="${esc(p.name)}" style="width:100%;margin-bottom:6px" />
        <textarea class="pc" rows="4">${esc(p.command)}</textarea>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <button class="btn save">保存</button>
        <button class="ghost del">删除</button>
      </div>`;
    row.querySelector('.save').addEventListener('click', () =>
      api('/api/settings/presets/' + encodeURIComponent(p.name), { method: 'PUT', body: JSON.stringify({ name: row.querySelector('.pn').value, command: row.querySelector('.pc').value }) })
        .then(loadSettings).then(() => toast('已保存')).catch((e) => toast(e.message)));
    row.querySelector('.del').addEventListener('click', () => {
      if (!confirm('删除该预设？')) return;
      api('/api/settings/presets/' + encodeURIComponent(p.name), { method: 'DELETE' }).then(loadSettings).catch((e) => toast(e.message));
    });
    box.appendChild(row);
  }
}

$('#save-settings').addEventListener('click', async () => {
  const body = {
    port: parseInt($('#s-port').value, 10),
    host: $('#s-host').value.trim(),
    maxDownloads: parseInt($('#s-maxdl').value, 10),
    maxCompresses: parseInt($('#s-maxcp').value, 10),
    minFreeMB: parseInt($('#s-minfree').value, 10),
    deleteSourceOnSuccess: $('#s-delsrc').checked,
  };
  if ($('#s-pw').value) body.newPassword = $('#s-pw').value;
  try {
    const r = await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    $('#s-pw').value = '';
    $('#restart-hint').textContent = r.restartNeeded ? '端口/地址已更改，需重启服务生效。' : '';
    toast('设置已保存');
    loadSettings();
  } catch (e) { toast(e.message); }
});

$('#add-preset').addEventListener('click', async () => {
  const name = $('#np-name').value.trim();
  const command = $('#np-cmd').value.trim();
  if (!name || !command) return toast('请填写名称和命令');
  try {
    await api('/api/settings/presets', { method: 'POST', body: JSON.stringify({ name, command }) });
    $('#np-name').value = ''; $('#np-cmd').value = '';
    loadSettings(); toast('已添加');
  } catch (e) { toast(e.message); }
});

// ---------- boot ----------
(async () => {
  try {
    const s = await api('/api/auth/status');
    s.authed ? showApp() : showLogin();
  } catch { showLogin(); }
})();
