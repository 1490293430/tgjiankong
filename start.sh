#!/bin/bash

echo "🚀 Telegram 监控系统 - 快速启动脚本"
echo "=================================="

# 检查 Docker
if ! command -v docker &> /dev/null; then
    echo "❌ 错误：未安装 Docker，请先安装 Docker"
    echo "📝 访问：https://docs.docker.com/get-docker/"
    exit 1
fi

# 检查 Docker Compose
if ! command -v docker-compose &> /dev/null; then
    echo "❌ 错误：未安装 Docker Compose"
    exit 1
fi

echo "✅ Docker 环境检查通过"

# 检查 .env 文件
if [ ! -f .env ]; then
    echo "⚠️  未找到 .env 文件，复制模板..."
    cp .env.example .env
    echo "📝 请编辑 .env 文件，配置 API_ID 和 API_HASH"
    echo "📝 获取方式：https://my.telegram.org/apps"
    exit 0
fi

# 创建必要的目录
echo "📁 创建数据目录..."
mkdir -p data/mongo
mkdir -p data/session
mkdir -p logs/api
mkdir -p logs/telethon

# 启动服务
echo "🐳 启动 Docker 容器..."
docker-compose up -d

echo ""
echo "✅ 服务启动成功！"
echo ""
echo "📊 查看服务状态："
docker-compose ps
echo ""
echo "🌐 访问地址：http://localhost"
echo "👤 默认用户名：admin"
echo "🔑 默认密码：admin123"
echo ""
echo "📝 查看日志："
echo "  docker-compose logs -f"
echo ""
echo "⚠️  首次使用需要登录 Telegram 账号："
echo "  docker-compose logs -f telethon"
echo ""
