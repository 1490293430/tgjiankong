#!/bin/bash

# 🔧 Telegram Monitor 快速修复脚本
# 用途：自动诊断和修复常见部署问题

set -e

echo "🔧 Telegram Monitor 快速修复脚本"
echo "===================================="
echo ""

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# 检查是否在项目目录
if [ ! -f "docker-compose.yml" ]; then
  echo -e "${RED}❌ 错误：找不到 docker-compose.yml${NC}"
  echo "请从项目根目录运行此脚本（如：/opt/telegram-monitor）"
  exit 1
fi

echo -e "${BLUE}1. 检查 Docker 状态${NC}"
echo "---"

# 检查 Docker
if ! command -v docker &> /dev/null; then
  echo -e "${RED}❌ Docker 未安装${NC}"
  exit 1
fi

if ! command -v docker-compose &> /dev/null; then
  echo -e "${RED}❌ Docker Compose 未安装${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Docker 和 Docker Compose 已安装${NC}"
echo ""

# 检查 Docker 守护进程
if ! docker ps &> /dev/null; then
  echo -e "${RED}❌ Docker 守护进程未运行${NC}"
  echo "尝试启动 Docker..."
  systemctl start docker 2>/dev/null || service docker start 2>/dev/null || {
    echo -e "${RED}❌ 无法启动 Docker 服务${NC}"
    exit 1
  }
  sleep 3
fi

echo -e "${GREEN}✓ Docker 守护进程运行中${NC}"
echo ""

echo -e "${BLUE}2. 检查容器状态${NC}"
echo "---"

# 显示容器状态
docker-compose ps

echo ""
echo -e "${BLUE}3. 修复和重启${NC}"
echo "---"

# 检查容器是否需要重启
CONTAINERS_DOWN=0
for container in "api" "mongo" "telethon" "web"; do
  if ! docker-compose ps $container 2>/dev/null | grep -q "Up"; then
    CONTAINERS_DOWN=$((CONTAINERS_DOWN + 1))
    echo -e "${YELLOW}⚠ $container 容器未运行，准备重启...${NC}"
  fi
done

if [ $CONTAINERS_DOWN -gt 0 ]; then
  echo -e "${YELLOW}检测到 $CONTAINERS_DOWN 个容器未运行，执行重启...${NC}"
  echo ""
  
  # 拉取最新代码
  echo -e "${YELLOW}正在拉取最新代码...${NC}"
  git pull origin main 2>/dev/null || echo -e "${YELLOW}⚠ 无法拉取代码（可能不是 git 仓库）${NC}"
  echo ""
  
  # 重建镜像（如果需要）
  echo -e "${YELLOW}正在重建 Docker 镜像...${NC}"
  docker-compose build 2>&1 | grep -E "Building|Digest" || echo "镜像已是最新"
  echo ""
  
  # 启动容器
  echo -e "${YELLOW}正在启动容器...${NC}"
  docker-compose up -d
  
  # 等待容器启动
  echo -e "${YELLOW}等待容器启动（10 秒）...${NC}"
  sleep 10
else
  echo -e "${GREEN}✓ 所有容器已运行${NC}"
fi

echo ""
echo -e "${BLUE}4. 验证服务健康状态${NC}"
echo "---"

# 检查后端日志
echo -e "${YELLOW}检查后端服务状态...${NC}"
if docker-compose logs api --tail 5 2>/dev/null | grep -q "API 服务运行在端口 3000"; then
  echo -e "${GREEN}✓ API 服务正常运行${NC}"
else
  echo -e "${YELLOW}⚠ 无法确认 API 服务状态，查看完整日志...${NC}"
  docker-compose logs api --tail 20
fi

echo ""

# 检查 MongoDB 连接
echo -e "${YELLOW}检查 MongoDB 连接...${NC}"
if docker-compose logs api --tail 10 2>/dev/null | grep -q "MongoDB 已连接"; then
  echo -e "${GREEN}✓ MongoDB 连接正常${NC}"
else
  echo -e "${RED}✗ MongoDB 连接可能有问题${NC}"
  echo -e "${YELLOW}查看 MongoDB 日志：${NC}"
  docker-compose logs mongo --tail 10
fi

echo ""

# 测试 API 端点
echo -e "${YELLOW}测试 API 端点...${NC}"
if docker exec tg_api curl -s http://localhost:3000/health &>/dev/null; then
  health_response=$(docker exec tg_api curl -s http://localhost:3000/health)
  echo -e "${GREEN}✓ API 健康检查通过${NC}"
  echo "  响应: $health_response"
else
  echo -e "${YELLOW}⚠ 无法执行健康检查（curl 可能不可用）${NC}"
fi

echo ""
echo -e "${BLUE}5. 网络诊断${NC}"
echo "---"

# 检查网络
if docker network inspect telegram-monitor_tg-network &>/dev/null; then
  echo -e "${GREEN}✓ Docker 网络已创建${NC}"
  
  # 显示网络中的容器
  echo -e "${YELLOW}网络中的容器：${NC}"
  docker network inspect telegram-monitor_tg-network | grep -E '"Name": "tg_|"IPv4Address"' | sed 's/.*"Name": "\(.*\)".*/\1/' | paste - -
else
  echo -e "${RED}✗ Docker 网络不存在${NC}"
fi

echo ""
echo -e "${BLUE}6. 清理和优化${NC}"
echo "---"

# 清理悬空镜像（可选）
echo -e "${YELLOW}检查并清理未使用的资源...${NC}"
DANGLING=$(docker images -f "dangling=true" -q | wc -l)
if [ $DANGLING -gt 0 ]; then
  echo -e "${YELLOW}发现 $DANGLING 个未使用的镜像，选择清理...${NC}"
  read -p "是否删除悬空镜像？ (y/n) " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    docker images -f "dangling=true" -q | xargs docker rmi 2>/dev/null || true
    echo -e "${GREEN}✓ 已清理${NC}"
  fi
fi

echo ""
echo -e "${BLUE}===================================${NC}"
echo -e "${GREEN}✓ 诊断和修复完成！${NC}"
echo -e "${BLUE}===================================${NC}"
echo ""

# 最终状态
echo -e "${YELLOW}最终容器状态：${NC}"
docker-compose ps

echo ""
echo -e "${BLUE}常用命令：${NC}"
echo "  查看实时日志: docker-compose logs -f api"
echo "  查看后端状态: docker-compose logs api --tail 50"
echo "  查看数据库状态: docker-compose logs mongo --tail 20"
echo "  停止服务: docker-compose down"
echo "  完全重启: docker-compose restart"
echo ""

echo -e "${BLUE}📝 接下来的步骤：${NC}"
echo "1. 验证 NPM 反向代理配置（如果使用）"
echo "2. 修改默认密码（admin/admin123）"
echo "3. 配置 CORS 白名单（如需要）"
echo "4. 定期检查日志"
echo ""
