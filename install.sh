#!/usr/bin/env bash
set -euo pipefail

# onlinecompress 安装脚本 (裸机 / systemd)
# 用法: bash install.sh

cd "$(dirname "$0")"
APP_DIR="$(pwd)"

echo "==> 检查依赖"
if ! command -v node >/dev/null 2>&1; then
  echo "缺少 node。请先安装 Node.js >= 18，例如:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node 版本过低 ($(node -v))，需要 >= 18"; exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo "缺少 ffmpeg/ffprobe。请安装, 例如:  sudo apt update && sudo apt install -y ffmpeg"
  exit 1
fi
echo "node $(node -v) / $(ffmpeg -version | head -n1)"

echo "==> 安装依赖 (npm)"
if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

echo "==> 初始化配置 (端口 / 密码)"
node scripts/setup.js

echo
read -r -p "是否安装 systemd 服务并开机自启? [y/N] " yn
if [[ "$yn" =~ ^[Yy]$ ]]; then
  read -r -p "运行服务的用户 [$(whoami)]: " RUN_USER
  RUN_USER="${RUN_USER:-$(whoami)}"
  NODE_BIN="$(command -v node)"
  SERVICE=/etc/systemd/system/onlinecompress.service
  sudo tee "$SERVICE" >/dev/null <<EOF
[Unit]
Description=onlinecompress video compression service
After=network.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/server.js
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now onlinecompress
  echo "服务已启动:  sudo systemctl status onlinecompress"
else
  echo "手动启动:  npm start"
fi
echo "完成。"
