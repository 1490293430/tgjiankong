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
echo "[1/6] Installing base dependencies..."
if command -v apt >/dev/null 2>&1; then
  apt update -y
  apt install -y ca-certificates curl gnupg lsb-release git >/dev/null
fi

# Install docker if missing
if ! command -v docker >/dev/null 2>&1; then
  echo "[2/6] Installing Docker..."
  install -m 0755 -d /etc/apt/keyrings || true
  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release; echo $VERSION_CODENAME) stable" | tee /etc/apt/sources.list.d/docker.list >/dev/null
  apt update -y
  apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
else
  echo "[2/6] Docker already installed"
fi

# Prepare directory
echo "[3/6] Preparing app directory at ${APP_DIR}..."
mkdir -p "$APP_DIR"

# Clone or update
echo "[4/6] Fetching repository (${MODE})..."
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
echo "[5/6] Configuring environment..."

# Create .env if not exists
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
  else
    # Create default .env if no example exists
    cat > .env << 'ENVEOF'
API_ID=0
API_HASH=
JWT_SECRET=change-this
NODE_ENV=development
PORT=3000
MONGO_URL=mongodb://mongo:27017/tglogs
ALLOWED_ORIGINS=http://localhost,http://localhost:3000
ENVEOF
  fi
fi

# Update JWT_SECRET if it's the default value
if grep -q '^JWT_SECRET=change-this' .env; then
  RAND=$(openssl rand -base64 32)
  sed -i "s/^JWT_SECRET=.*/JWT_SECRET=${RAND}/" .env
fi

if [ -n "${API_ID:-}" ]; then
  sed -i "s/^API_ID=.*/API_ID=${API_ID}/" .env
fi
if [ -n "${API_HASH:-}" ]; then
  sed -i "s/^API_HASH=.*/API_HASH=${API_HASH}/" .env
fi

mkdir -p data/mongo data/session logs/api logs/telethon

# Create default config.json if not exists (prevent Docker from creating it as directory)
if [ ! -f backend/config.json ]; then
  cat > backend/config.json << 'CONFIGEOF'
{
  "keywords": [],
  "channels": [],
  "alert_keywords": [],
  "alert_regex": [],
  "alert_target": "",
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
  "admin": {
    "username": "admin",
    "password_hash": "$2b$10$EixZaYVK1fsbw1ZfbX3OXePaWxn96p36Q6H2V.L7Bl6h8zXRDRJJe"
  }
}
CONFIGEOF
fi

# Up containers
echo "[6/6] Starting services..."
docker compose up -d
sleep 2
docker compose ps || true

cat <<SUCCESS

✅ Deployment finished.
- Web: http://<your-server-ip>
- Login: admin / admin123 (please change after login)
- First-time Telegram login (if needed):
  docker compose exec telethon \\
    python -c "from telethon import TelegramClient; import os; c=TelegramClient('/app/session/telegram', int(os.getenv('API_ID')), os.getenv('API_HASH')); c.start(); print('Login done'); c.disconnect()"

SUCCESS
