# onlinecompress — 自托管在线视频压缩工具

基于 **ffmpeg + Node.js** 的自用视频压缩 Web 工具，运行在 Linux 上。浏览器里登录后可上传本地视频或添加视频链接（mp4 / ts / m3u8 等），用可自定义的 ffmpeg 指令逐个压缩，输出统一为 `<源文件名>_compressed.mp4`。

## 功能

- 单密码登录（bcrypt 哈希存储 + 登录限速）。
- 三个页面：**文件** / **压缩进程** / **设置**。
- 上传本地文件，或粘贴链接添加：
  - `m3u8` 链接先用 ffmpeg `-c copy` 下载/合并为本地 `.ts`，再压缩；
  - `mp4`/`ts` 等直链流式下载。
- 压缩指令支持 **预设 + 临时编辑原始命令**，用 `{input}` / `{output}` 占位符。默认预设为 H.265 CRF26。
- **队列并发**：下载与压缩各自有并发上限（设置页可调，默认均为 1），互不抢占，其余排队。
- 实时进度（SSE）：百分比、已处理时长、speed、fps、ETA；可取消。
- 输出固定 mp4，命名 `<源名去后缀>_compressed.mp4`。
- **分享下载链接**：文件页勾选文件后点「复制下载链接」，即可复制若干条以换行分隔的**免登录**下载直链（指向压缩结果，**24 小时**后自动失效）；未压缩、无结果的选中项自动跳过。链接经服务端密钥 HMAC 签名、不可伪造，无需持久化存储。
- 源文件保留策略可在设置页配置（保留 / 成功后自动删源）。
- **磁盘空间检查**：上传、云下载、开始压缩前都会校验剩余空间，低于「最少保留」阈值时拒绝并提示；文件页顶部实时显示磁盘占用条。

## 安装（裸机 + systemd）

前置：Node.js ≥ 18、ffmpeg / ffprobe。

```bash
git clone <repo> /opt/onlinecompress   # 或上传代码到该目录
cd /opt/onlinecompress
bash install.sh                        # 检查依赖 → npm 安装 → 设置端口/密码 → 可选装 systemd
```

手动方式：

```bash
npm install --omit=dev
npm run setup       # 设置端口与登录密码
npm start
```

访问 `http://<host>:<port>`。

## 安全提示（重要）

本工具会执行 ffmpeg 命令，**请勿裸奔公网**：

- 默认监听 `127.0.0.1`，建议前置 nginx/caddy 反向代理并启用 HTTPS，或仅在内网/加防火墙访问。
- 自定义命令通过 `shell-quote` 解析为参数数组后 **不经过 shell** 直接执行，遇到 `;`、`&&`、`|`、`$()`、反引号等一律拒绝，且强制以 `ffmpeg` 开头，避免命令注入。
- 「复制下载链接」生成的 `/dl/<token>` 直链 **无需登录** 即可下载对应压缩结果（这是有意设计，便于分享）。token 由服务端 `sessionSecret` 签名、24h 过期，无法猜测或伪造；如需提前作废所有已发出的链接，可轮换 `config.json` 中的 `sessionSecret`（同时会使所有登录会话失效）。
- 建议用非 root 的受限用户运行（systemd `User=`）。

## 目录

- `data/uploads` 上传与云下载的源文件
- `data/outputs` 压缩结果
- `data/tmp` 临时文件
- `data/state.json` 文件/任务持久化（重启恢复）
- `config.json` 配置（端口、密码哈希、目录、预设、保留策略、磁盘最少保留 `minFreeMB`）

## 环境变量（可选覆盖）

- `PORT` / `HOST`：覆盖监听端口/地址（首次启动或容器场景方便）。
- `FFMPEG_BIN` / `FFPROBE_BIN`：自定义 ffmpeg/ffprobe 路径。

## 常用运维

```bash
sudo systemctl status onlinecompress
sudo systemctl restart onlinecompress   # 修改端口后需重启
journalctl -u onlinecompress -f         # 查看日志
```
