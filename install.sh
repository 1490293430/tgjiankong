#!/usr/bin/env bash
set -e

# 检查是否为 root
if [ "$EUID" -ne 0 ]; then 
  echo "❌ 请使用 root 权限运行: sudo bash <(curl -fsSL https://raw.githubusercontent.com/1490293430/tgjiankong/main/install.sh)"
  exit 1
fi

REPO_OWNER="1490293430"
REPO_NAME="tgjiankong"
BRANCH="main"
APP_DIR="/opt/telegram-monitor"

# 解析参数
GH_TOKEN="${GH_TOKEN:-}"
API_ID="${API_ID:-}"
API_HASH="${API_HASH:-}"

# 检测系统类型（Ubuntu/Debian）
if command -v apt >/dev/null 2>&1; then
  OS_TYPE="debian"
elif command -v yum >/dev/null 2>&1; then
  OS_TYPE="rhel"
else
  OS_TYPE="unknown"
fi

# 安装基础依赖
echo "[1/5] 安装基础依赖..."
if [ "$OS_TYPE" = "debian" ]; then
  apt update -y >/dev/null 2>&1
  apt install -y ca-certificates curl git >/dev/null 2>&1
fi

# 安装 Docker（Ubuntu/Debian 快速安装）
if ! command -v docker >/dev/null 2>&1; then
  echo "[2/5] 安装 Docker..."
  if [ "$OS_TYPE" = "debian" ]; then
    # Ubuntu/Debian 使用官方一键安装脚本（最快）
    curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
    systemctl enable --now docker >/dev/null 2>&1
  else
    echo "⚠️  不支持的系统类型，请手动安装 Docker"
    exit 1
  fi
else
  echo "[2/5] Docker 已安装"
fi

# 安装 Docker Compose（如果不存在）
if ! command -v docker-compose >/dev/null 2>&1 && ! docker compose version >/dev/null 2>&1; then
  echo "[3/5] 安装 Docker Compose..."
  if [ "$OS_TYPE" = "debian" ]; then
    # 新版本 Docker 已经包含 compose plugin，只需确保安装
    apt install -y docker-compose-plugin >/dev/null 2>&1 || true
  fi
else
  echo "[3/5] Docker Compose 已安装"
fi

# 准备目录并下载代码
echo "[4/5] 下载代码..."
mkdir -p "$APP_DIR"
cd "$APP_DIR"

if [ -d ".git" ]; then
  git pull origin "$BRANCH" >/dev/null 2>&1 || {
    curl -fsSL "https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/refs/heads/${BRANCH}" | tar -xz --strip-components=1
  }
else
  curl -fsSL "https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/refs/heads/${BRANCH}" | tar -xz --strip-components=1
fi

# 配置环境
echo "[5/5] 配置并启动..."
mkdir -p data/mongo data/session logs/api logs/telethon backups

# 创建 .env
if [ ! -f .env ]; then
  cat > .env <<EOF
API_ID=${API_ID:-0}
API_HASH=${API_HASH:-}
JWT_SECRET=$(openssl rand -base64 32 2>/dev/null || echo "change-this-$(date +%s)")
INTERNAL_API_TOKEN=$(openssl rand -base64 32 2>/dev/null || echo "internal-$(date +%s)")
PROJECT_ROOT=${APP_DIR}
WEB_PORT=5555
MONGO_URL=mongodb://mongo:27017/tglogs
NODE_ENV=production
EOF
fi

# 创建 config.json
if [ ! -f backend/config.json ]; then
  [ -f backend/config.json.example ] && cp backend/config.json.example backend/config.json || cat > backend/config.json <<'EOF'
{
  "keywords": [],
  "channels": [],
  "alert_keywords": [],
  "alert_regex": [],
  "log_all_messages": true,
  "telegram": {"api_id": 0, "api_hash": ""}
}
EOF
fi

# 确保 docker compose 可用（兼容新旧版本）
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  echo "❌ 未找到 docker compose 命令"
  exit 1
fi

# 先停止并清理所有相关容器
echo "清理旧环境..."
if [ -f docker-compose.yml ]; then
  $COMPOSE_CMD down -v 2>/dev/null || true
fi

# 手动停止并删除所有使用 tg-network 的容器
CONTAINERS_IN_NETWORK=$(docker network inspect tg-network --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null || echo "")
if [ -n "$CONTAINERS_IN_NETWORK" ]; then
  echo "  停止使用 tg-network 的容器..."
  echo "$CONTAINERS_IN_NETWORK" | tr ' ' '\n' | grep -v '^$' | while read -r container; do
    docker stop "$container" 2>/dev/null || true
    docker rm "$container" 2>/dev/null || true
  done
  sleep 1
fi

# 删除旧网络（解决标签冲突）
if docker network inspect tg-network >/dev/null 2>&1; then
  echo "  删除旧的 tg-network 网络..."
  docker network rm tg-network 2>/dev/null || true
  sleep 1
fi

# npm-net 是外部网络，如果不存在则创建（可选）
docker network create npm-net 2>/dev/null || true

# 启动服务（compose 会自动创建 tg-network）
echo "构建容器..."
$COMPOSE_CMD build --pull --quiet
echo "启动服务..."
$COMPOSE_CMD up -d

echo ""
echo "✅ 部署完成！"
echo ""
echo "📋 访问地址: http://$(hostname -I | awk '{print $1}' 2>/dev/null || echo 'localhost'):5555"
echo "🔑 首次使用：请打开网页注册第一个账号（建议使用强密码）"
echo ""
echo "📝 查看日志: $COMPOSE_CMD logs -f"
echo "📊 查看状态: $COMPOSE_CMD ps"
