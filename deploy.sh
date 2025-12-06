#!/bin/bash
# Telegram Monitor 安全部署脚本（带自动备份）

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🚀 Telegram Monitor 安全部署脚本"
echo "=================================="
echo ""

# 检查是否在正确的目录
if [ ! -f "docker-compose.yml" ]; then
    echo "❌ 错误：未找到 docker-compose.yml"
    echo "请确保在项目根目录执行此脚本"
    exit 1
fi

# 自动备份
echo "📦 [1/6] 自动备份现有数据..."
if [ -f "${SCRIPT_DIR}/backup.sh" ]; then
    bash "${SCRIPT_DIR}/backup.sh"
else
    echo "⚠️  备份脚本不存在，跳过备份"
fi
echo ""

# 停止容器
echo "🛑 [2/6] 停止现有容器..."
docker-compose down
echo ""

# 拉取最新代码
echo "📥 [3/6] 拉取最新代码..."
git pull origin main
echo ""

# 确保目录存在
echo "📁 [4/6] 创建必要的目录..."
mkdir -p data/mongo data/session logs/api logs/telethon
echo "✅ 目录已创建"
echo ""

# 保护配置文件：如果配置文件不存在，从备份恢复或使用示例
echo "🔒 [5/6] 检查配置文件..."
if [ ! -f "backend/config.json" ]; then
    echo "⚠️  配置文件不存在，尝试从备份恢复..."
    
    # 查找最新备份
    LATEST_BACKUP=$(ls -t backups/backup_*.tar.gz 2>/dev/null | head -1)
    if [ -n "$LATEST_BACKUP" ]; then
        echo "📥 找到备份: $(basename "$LATEST_BACKUP")"
        TEMP_DIR=$(mktemp -d)
        tar -xzf "$LATEST_BACKUP" -C "$TEMP_DIR" 2>/dev/null || true
        BACKUP_CONFIG=$(find "$TEMP_DIR" -name "config.json" -type f | head -1)
        if [ -n "$BACKUP_CONFIG" ]; then
            cp "$BACKUP_CONFIG" "backend/config.json"
            echo "✅ 已从备份恢复配置文件"
            rm -rf "$TEMP_DIR"
        else
            echo "⚠️  备份中未找到配置文件，使用示例文件"
            cp backend/config.json.example backend/config.json
        fi
    else
        echo "⚠️  未找到备份，使用示例文件"
        if [ -f "backend/config.json.example" ]; then
            cp backend/config.json.example backend/config.json
        else
            echo "❌ 示例文件也不存在，请手动创建配置文件"
            exit 1
        fi
    fi
else
    echo "✅ 配置文件已存在，保持不变"
fi

# 确保 .env 文件存在
if [ ! -f ".env" ]; then
    echo "⚠️  .env 文件不存在，从备份恢复或创建..."
    LATEST_BACKUP=$(ls -t backups/backup_*.tar.gz 2>/dev/null | head -1)
    if [ -n "$LATEST_BACKUP" ]; then
        TEMP_DIR=$(mktemp -d)
        tar -xzf "$LATEST_BACKUP" -C "$TEMP_DIR" 2>/dev/null || true
        BACKUP_ENV=$(find "$TEMP_DIR" -name ".env" -type f | head -1)
        if [ -n "$BACKUP_ENV" ]; then
            cp "$BACKUP_ENV" ".env"
            echo "✅ 已从备份恢复 .env 文件"
            rm -rf "$TEMP_DIR"
        fi
    fi
    
    if [ ! -f ".env" ]; then
        echo "⚠️  创建默认 .env 文件..."
        cat > .env << 'ENVEOF'
API_ID=0
API_HASH=
JWT_SECRET=change-this
NODE_ENV=production
PORT=3000
MONGO_URL=mongodb://mongo:27017/tglogs
ALLOWED_ORIGINS=http://localhost,http://localhost:3000
WEB_PORT=5555
ENVEOF
        # 生成 JWT_SECRET
        if command -v openssl >/dev/null 2>&1; then
            RAND=$(openssl rand -base64 32)
            sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${RAND}|" .env
        fi
    fi
fi
echo ""

# 构建和启动
echo "🔨 [6/6] 构建并启动容器..."
docker-compose build --no-cache
docker-compose up -d
echo ""

echo "⏳ 等待服务启动..."
sleep 10

echo ""
echo "✅ 部署完成！"
echo ""
echo "📊 容器状态："
docker-compose ps

echo ""
echo "📝 查看日志："
echo "  docker-compose logs -f"

echo ""
echo "💡 提示："
echo "  - 如果配置丢失，可以使用 restore.sh 恢复备份"
echo "  - 定期使用 backup.sh 备份数据"

