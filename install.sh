#!/usr/bin/env bash
set -euo pipefail

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
  echo "❌ This script must be run as root"
  echo "Please run: sudo bash <(curl -fsSL https://raw.githubusercontent.com/1490293430/tgjiankong/main/install.sh)"
  exit 1
fi

# Telegram Monitor - One line installer
# Usage examples:
#  - Non-interactive (recommended):
#      GH_TOKEN=xxxx API_ID=123456 API_HASH=yyyy bash <(curl -fsSL https://raw.githubusercontent.com/1490293430/tgjiankong/main/install.sh)
#  - Or with flags:
#      bash <(curl -fsSL https://raw.githubusercontent.com/1490293430/tgjiankong/main/install.sh) -t xxxx -i 123456 -s yyyy -b main -d /opt/telegram-monitor

REPO_OWNER="1490293430"
REPO_NAME="tgjiankong"
BRANCH="main"
APP_DIR="/opt/telegram-monitor"
MODE="codeload"   # default: codeload for public; use https with GH_TOKEN for private

usage() {
  cat <<EOF
Telegram Monitor one-line installer

Options:
  -t <token>      GitHub Token (Fine-grained or Classic, repo read)
  -i <api_id>     Telegram API_ID
  -s <api_hash>   Telegram API_HASH
  -b <branch>     Git branch (default: main)
  -d <dir>        Install directory (default: /opt/telegram-monitor)
  -m <mode>       fetch mode: https|ssh|codeload (default: https)
  -h              Show help

Environment variables supported:
  GH_TOKEN, API_ID, API_HASH

Examples:
  GH_TOKEN=xxxx API_ID=123456 API_HASH=yyyy bash <(curl -fsSL https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/install.sh)
EOF
}

# Parse flags
while getopts ":t:i:s:b:d:m:h" opt; do
  case $opt in
    t) GH_TOKEN="$OPTARG" ;;
    i) API_ID="$OPTARG" ;;
    s) API_HASH="$OPTARG" ;;
    b) BRANCH="$OPTARG" ;;
    d) APP_DIR="$OPTARG" ;;
    m) MODE="$OPTARG" ;;
    h) usage; exit 0 ;;
    :) echo "Option -$OPTARG requires an argument"; usage; exit 1 ;;
    \?) echo "Unknown option -$OPTARG"; usage; exit 1 ;;
  esac
done

# Read from env if not set by flags
GH_TOKEN="${GH_TOKEN:-${TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-""}}}}"
API_ID="${API_ID:-${API_ID:-""}}"
API_HASH="${API_HASH:-${API_HASH:-""}}"

# Ensure deps
echo "[1/7] Installing base dependencies..."
if command -v apt >/dev/null 2>&1; then
  apt update -y
  apt install -y ca-certificates curl gnupg lsb-release git >/dev/null
fi

# Install docker if missing
if ! command -v docker >/dev/null 2>&1; then
  echo "[2/7] Installing Docker..."
  install -m 0755 -d /etc/apt/keyrings || true
  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release; echo $VERSION_CODENAME) stable" | tee /etc/apt/sources.list.d/docker.list >/dev/null
  apt update -y
  apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
else
  echo "[2/7] Docker already installed"
fi

# Prepare directory
echo "[3/7] Preparing app directory at ${APP_DIR}..."
mkdir -p "$APP_DIR"

# Clone or update
echo "[4/7] Fetching repository (${MODE})..."
if [ ! -d "$APP_DIR/.git" ]; then
  case "$MODE" in
    ssh)
      git clone -b "$BRANCH" git@github.com:${REPO_OWNER}/${REPO_NAME}.git "$APP_DIR";;
    codeload)
      curl -fsSL "https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/refs/heads/${BRANCH}" -o /tmp/${REPO_NAME}.tar.gz
      tar -xzf /tmp/${REPO_NAME}.tar.gz -C "$APP_DIR" --strip-components=1;;
    https|*)
      if [ -z "${GH_TOKEN:-}" ]; then
        # Try public download via codeload fallback
        echo "No GH_TOKEN provided; attempting public download via codeload..."
        curl -fsSL "https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/refs/heads/${BRANCH}" -o /tmp/${REPO_NAME}.tar.gz
        tar -xzf /tmp/${REPO_NAME}.tar.gz -C "$APP_DIR" --strip-components=1
      else
        git -c http.extraHeader="Authorization: Bearer $GH_TOKEN" clone -b "$BRANCH" https://github.com/${REPO_OWNER}/${REPO_NAME}.git "$APP_DIR"
      fi;;
  esac
else
  cd "$APP_DIR"
  case "$MODE" in
    ssh)
      git pull --ff-only;;
    codeload)
      curl -fsSL "https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/refs/heads/${BRANCH}" -o /tmp/${REPO_NAME}.tar.gz
      tar -xzf /tmp/${REPO_NAME}.tar.gz -C "$APP_DIR" --strip-components=1;;
    https|*)
      if [ -z "${GH_TOKEN:-}" ]; then
        echo "No GH_TOKEN; refreshing from public codeload..."
        curl -fsSL "https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/refs/heads/${BRANCH}" -o /tmp/${REPO_NAME}.tar.gz
        tar -xzf /tmp/${REPO_NAME}.tar.gz -C "$APP_DIR" --strip-components=1
      else
        git -c http.extraHeader="Authorization: Bearer $GH_TOKEN" pull --ff-only
      fi;;
  esac
fi

cd "$APP_DIR"

# Configure ENV
echo "[5/8] Configuring environment..."

# Create .env if not exists
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "✅ Created .env from .env.example"
    # 清理 .env.example 中可能存在的占位符
    sed -i "s|^API_ID=.*你的.*|API_ID=0|" .env
    sed -i "s|^API_HASH=.*你的.*|API_HASH=|" .env
  else
    # Create default .env if no example exists
    cat > .env << 'ENVEOF'
API_ID=0
API_HASH=
JWT_SECRET=change-this
NODE_ENV=production
PORT=3000
MONGO_URL=mongodb://mongo:27017/tglogs
ALLOWED_ORIGINS=http://localhost,http://localhost:3000
WEB_PORT=5555
PROJECT_ROOT=/opt/telegram-monitor
ENVEOF
    echo "✅ Created default .env file"
  fi
fi

# 清理现有 .env 文件中的占位符（如果存在）
if [ -f .env ]; then
  # 检查并清理 API_ID 占位符
  if grep -q "^API_ID=.*你的" .env || grep -q "^API_ID=.*placeholder" .env || grep -q "^API_ID=.*example" .env; then
    sed -i "s|^API_ID=.*|API_ID=0|" .env
    echo "⚠️  检测到 .env 文件中的 API_ID 占位符，已清理为 0"
  fi
  # 检查并清理 API_HASH 占位符
  if grep -q "^API_HASH=.*你的" .env || grep -q "^API_HASH=.*placeholder" .env || grep -q "^API_HASH=.*example" .env; then
    sed -i "s|^API_HASH=.*|API_HASH=|" .env
    echo "⚠️  检测到 .env 文件中的 API_HASH 占位符，已清理为空"
  fi
fi

# Update PROJECT_ROOT in .env if it's different
if grep -q "^PROJECT_ROOT=" .env; then
  sed -i "s|^PROJECT_ROOT=.*|PROJECT_ROOT=${APP_DIR}|" .env
else
  echo "PROJECT_ROOT=${APP_DIR}" >> .env
fi

# Update JWT_SECRET if it's the default value
if grep -q '^JWT_SECRET=change-this' .env; then
  RAND=$(openssl rand -base64 32)
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${RAND}|" .env
fi

# 更新 API_ID（验证是否为有效数字）
if [ -n "${API_ID:-}" ]; then
  # 检查是否为有效数字（不是占位符）
  if [[ "${API_ID}" =~ ^[0-9]+$ ]] && [ "${API_ID}" != "0" ]; then
    sed -i "s|^API_ID=.*|API_ID=${API_ID}|" .env
    echo "✅ 已设置 API_ID: ${API_ID}"
  else
    echo "⚠️  API_ID 无效或为占位符，跳过设置（请稍后手动配置）"
  fi
fi

# 更新 API_HASH（验证是否为空或占位符）
if [ -n "${API_HASH:-}" ]; then
  # 检查是否为占位符（包含"你的"等中文字符）
  if [[ "${API_HASH}" =~ (你的|请填写|placeholder|example) ]]; then
    echo "⚠️  API_HASH 包含占位符文本，跳过设置（请稍后手动配置）"
  else
    sed -i "s|^API_HASH=.*|API_HASH=${API_HASH}|" .env
    echo "✅ 已设置 API_HASH"
  fi
fi

mkdir -p data/mongo data/session logs/api logs/telethon backups

# Create default config.json if not exists (prevent Docker from creating it as directory)
if [ ! -f backend/config.json ]; then
  if [ -f backend/config.json.example ]; then
    cp backend/config.json.example backend/config.json
    echo "✅ Created backend/config.json from example"
  else
    # Create minimal config.json if example doesn't exist
    cat > backend/config.json << 'CONFIGEOF'
{
  "keywords": [],
  "channels": [],
  "alert_keywords": [],
  "alert_regex": [],
  "alert_target": "",
  "log_all_messages": false,
  "telegram": {
    "api_id": 0,
    "api_hash": ""
  },
  "alert_actions": {
    "telegram": true,
    "email": {
      "enable": false,
      "smtp_host": "",
      "smtp_port": 465,
      "username": "",
      "password": "",
      "to": ""
    },
    "webhook": {
      "enable": false,
      "url": ""
    }
  },
  "ai_analysis": {
    "enabled": false,
    "openai_api_key": "",
    "openai_model": "gpt-3.5-turbo",
    "openai_base_url": "https://api.openai.com/v1",
    "analysis_trigger_type": "time",
    "time_interval_minutes": 30,
    "message_count_threshold": 50,
    "max_messages_per_analysis": 500,
    "analysis_prompt": "请分析以下 Telegram 消息，提供：1) 整体情感倾向（积极/中性/消极）；2) 主要内容分类；3) 关键主题和摘要；4) 重要关键词",
    "ai_send_telegram": true,
    "ai_send_email": false,
    "ai_send_webhook": false,
    "ai_trigger_enabled": false,
    "ai_trigger_users": [],
    "ai_trigger_prompt": ""
  }
}
CONFIGEOF
    echo "✅ Created minimal backend/config.json"
  fi
fi

# Create Docker network if not exists (for npm-net, optional for NPM reverse proxy)
echo "[6/8] Creating Docker networks..."
if ! docker network ls | grep -q "npm-net"; then
  if docker network create npm-net 2>/dev/null; then
    echo "✅ Created npm-net network (optional, for NPM reverse proxy)"
  else
    echo "⚠️  npm-net network creation failed (will be created by docker-compose if needed)"
  fi
else
  echo "✅ npm-net network already exists"
fi

# Create Docker volume if not exists
if ! docker volume ls | grep -q "tg_session"; then
  docker volume create tg_session
  echo "✅ Created tg_session volume"
else
  echo "✅ tg_session volume already exists"
fi

# Build & Up containers
echo "[7/8] Building containers..."
cd "$APP_DIR"
docker compose build --pull

echo "[8/8] Starting services..."
docker compose down 2>/dev/null || true  # 确保干净启动

# 尝试启动服务，如果 npm-net 网络不存在导致失败，创建它后重试
if ! docker compose up -d 2>&1 | tee /tmp/docker-compose-up.log; then
  if grep -q "network.*npm-net.*not found" /tmp/docker-compose-up.log || grep -q "network.*npm-net.*does not exist" /tmp/docker-compose-up.log; then
    echo "⚠️  npm-net network not found, creating it..."
    docker network create npm-net 2>/dev/null || true
    echo "🔄 Retrying docker compose up..."
    docker compose up -d
  else
    echo "❌ Failed to start services. Check logs above."
    exit 1
  fi
fi
rm -f /tmp/docker-compose-up.log

echo ""
echo "等待服务启动（30秒）..."
sleep 30

# 显示容器状态
echo ""
echo "📊 容器状态："
docker compose ps || true

# 验证服务运行状态
echo ""
echo "[验证] 检查服务健康状态..."

# 检查 API 服务
API_OK=false
for i in {1..12}; do
  if docker compose logs api --tail 10 2>/dev/null | grep -q "API 服务运行在端口"; then
    echo "✅ API 服务正常运行"
    API_OK=true
    break
  fi
  echo "   等待 API 服务启动... ($i/12)"
  sleep 5
done

if [ "$API_OK" = false ]; then
  echo "⚠️  API 服务启动可能有问题，查看日志："
  docker compose logs api --tail 30
fi

# 检查 MongoDB
if docker compose ps mongo 2>/dev/null | grep -q "Up"; then
  echo "✅ MongoDB 容器运行中"
else
  echo "⚠️  MongoDB 容器未运行"
fi

# 检查 Telegram 监听服务
if docker compose ps telethon 2>/dev/null | grep -q "Up"; then
  echo "✅ Telegram 监听服务运行中"
else
  echo "⚠️  Telegram 监听服务未运行"
fi

# 检查 Web 服务
# 从.env文件读取WEB_PORT，如果没有则使用默认值
if [ -f "$APP_DIR/.env" ]; then
  WEB_PORT=$(grep "^WEB_PORT=" "$APP_DIR/.env" 2>/dev/null | cut -d'=' -f2 | tr -d '"' || echo "5555")
else
  WEB_PORT="${WEB_PORT:-5555}"
fi
WEB_PORT="${WEB_PORT:-5555}"

if docker compose ps web 2>/dev/null | grep -q "Up"; then
  echo "✅ Web 服务运行中（端口: $WEB_PORT）"
else
  echo "⚠️  Web 服务未运行"
fi

# 获取服务器IP地址（用于显示访问信息）
SERVER_IP=$(hostname -I | awk '{print $1}' 2>/dev/null || curl -s ifconfig.me 2>/dev/null || echo "your-server-ip")

cat <<SUCCESS

✅ 部署完成！

📋 访问信息：
- 前端：http://${SERVER_IP}:${WEB_PORT}
- API：http://${SERVER_IP}:3000
- 默认登录：admin / admin123（⚠️  请立即修改密码！）

📝 首次 Telegram 登录（推荐通过 Web 界面）：
  1. 访问 http://${SERVER_IP}:${WEB_PORT}
  2. 登录后台（admin / admin123）
  3. 进入"设置"标签
  4. 配置 API_ID 和 API_HASH
  5. 点击"Telegram 首次登录"按钮
  6. 按照提示完成登录

  或者使用命令行（需要先配置 API_ID 和 API_HASH）：
  cd ${APP_DIR}
  docker compose exec telethon python3 /app/login_helper.py check /tmp/session_volume/user_$(docker compose exec -T api node -e "const mongoose=require('mongoose'); mongoose.connect(process.env.MONGO_URL||'mongodb://mongo:27017/tglogs'); const User=require('./userModel'); User.findOne({username:'admin'}).then(u=>{if(u)console.log(u._id.toString()); process.exit(0);})" 2>/dev/null | head -1) $(grep API_ID .env | cut -d'=' -f2) $(grep API_HASH .env | cut -d'=' -f2) || echo "请先通过 Web 界面配置 API_ID 和 API_HASH"

🔧 常用命令：
  查看状态：docker compose ps
  查看日志：docker compose logs api -f
  重启服务：docker compose restart api
  停止服务：docker compose down

🔐 安全提醒：
  1. 立即修改默认密码
  2. 配置 HTTPS（推荐使用 NPM）
  3. 定期备份数据库

SUCCESS

