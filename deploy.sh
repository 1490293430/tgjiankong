#!/bin/bash

# 🚀 Telegram Monitor 快速部署脚本
# 用途：在服务器上快速部署已修复的版本

set -e

echo "🚀 Telegram Monitor 快速部署脚本"
echo "================================"
echo ""

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'cd /opt/telegram-monitor
git pull origin main
docker-compose up -d
docker-compose ps
RED='\033[0;31m'
NC='\033[0m'

# 配置
APP_DIR="${APP_DIR:-.}"
BACKEND_DIR="$APP_DIR/backend"

# 检查是否在正确的目录
if [ ! -f "$BACKEND_DIR/server.js" ]; then
  echo -e "${RED}❌ 错误：找不到 $BACKEND_DIR/server.js${NC}"
  echo "请从项目根目录运行此脚本"
  exit 1
fi

# ===== 第 1 步：拉取最新代码 =====
echo -e "${YELLOW}[1/5] 拉取最新代码...${NC}"
cd "$APP_DIR"
git pull origin main
echo -e "${GREEN}✓ 代码已更新${NC}"
echo ""

# ===== 第 2 步：安装依赖 =====
echo -e "${YELLOW}[2/5] 安装依赖...${NC}"
cd "$BACKEND_DIR"
npm install --production
echo -e "${GREEN}✓ 依赖已安装${NC}"
echo ""

# ===== 第 3 步：生成 JWT_SECRET =====
echo -e "${YELLOW}[3/5] 配置环境变量...${NC}"
if [ ! -f ".env" ]; then
  echo "创建 .env 文件..."
  cp .env.example .env || cat > .env << 'EOF'
JWT_SECRET=change-this
NODE_ENV=production
PORT=3000
MONGO_URL=mongodb://mongodb:27017/tglogs
ALLOWED_ORIGINS=http://localhost
EOF
fi

# 生成安全的 JWT_SECRET
if grep -q "^JWT_SECRET=change-this" .env || [ -z "$(grep -E '^JWT_SECRET=.+' .env | cut -d= -f2-)" ]; then
  echo "生成随机 JWT_SECRET..."
  JWT_SECRET=$(openssl rand -base64 32)
  sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$JWT_SECRET/" .env
  echo -e "${GREEN}✓ JWT_SECRET 已生成${NC}"
else
  echo -e "${GREEN}✓ JWT_SECRET 已存在（未修改）${NC}"
fi
echo ""

# ===== 第 4 步：验证配置 =====
echo -e "${YELLOW}[4/5] 验证配置...${NC}"

# 检查必要的配置项
configs=("JWT_SECRET" "MONGO_URL" "ALLOWED_ORIGINS")
for config in "${configs[@]}"; do
  if grep -q "^$config=" .env; then
    value=$(grep "^$config=" .env | cut -d= -f2-)
    echo -e "${GREEN}✓${NC} $config 已配置"
  else
    echo -e "${RED}✗${NC} $config 未配置"
    echo "  请编辑 .env 文件添加此配置"
  fi
done
echo ""

# ===== 第 5 步：启动/重启服务 =====
echo -e "${YELLOW}[5/5] 启动服务...${NC}"

if command -v docker-compose &> /dev/null; then
  echo "使用 Docker Compose 启动..."
  cd "$APP_DIR"
  docker-compose up -d backend
  sleep 2
  docker-compose logs backend | head -20
  echo -e "${GREEN}✓ 服务已启动${NC}"
elif command -v pm2 &> /dev/null; then
  echo "使用 PM2 启动..."
  pm2 restart telegram-monitor || pm2 start server.js --name telegram-monitor
  pm2 logs telegram-monitor --lines 20
  echo -e "${GREEN}✓ 服务已启动${NC}"
else
  echo -e "${RED}⚠️  未找到 Docker Compose 或 PM2${NC}"
  echo "请手动启动：node $BACKEND_DIR/server.js"
fi
echo ""

# ===== 验证服务 =====
echo -e "${YELLOW}验证服务运行...${NC}"
sleep 3

if lsof -i :3000 > /dev/null 2>&1; then
  echo -e "${GREEN}✓ 服务正在运行（端口 3000）${NC}"
  
  # 测试 API
  echo -e "${YELLOW}测试 API...${NC}"
  response=$(curl -s -X POST http://localhost:3000/api/alert/push \
    -H "Content-Type: application/json" \
    -d '{"keyword":"test","message":"test"}' || echo '{}')
  
  if echo "$response" | grep -q "未授权"; then
    echo -e "${GREEN}✓ 安全检查通过：无认证端点已被保护${NC}"
  elif echo "$response" | grep -q "error"; then
    echo -e "${YELLOW}⚠️  服务在运行但有错误${NC}"
    echo "  响应：$response"
  fi
else
  echo -e "${RED}✗ 服务未在运行${NC}"
  echo "请检查日志：docker-compose logs backend"
  exit 1
fi
echo ""

# ===== 总结 =====
echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}✓ 部署完成！${NC}"
echo -e "${GREEN}================================${NC}"
echo ""
echo -e "📋 后续步骤："
echo "1. 修改默认密码："
echo "   登录 http://your-server:3000 使用 admin/admin123"
echo "2. 配置 CORS 白名单："
echo "   编辑 backend/.env，设置 ALLOWED_ORIGINS"
echo "3. 配置 HTTPS（推荐）："
echo "   使用 Let's Encrypt 或购买证书"
echo ""
echo -e "🔐 重要提醒："
echo "   - 立即修改默认密码"
echo "   - 保管好 JWT_SECRET（已保存在 .env）"
echo "   - 定期备份数据库"
echo ""
echo -e "📚 文档参考："
echo "   - 完整部署指南：DEPLOYMENT_GUIDE.md"
echo "   - 修复总结：FIXES_SUMMARY.md"
echo ""
