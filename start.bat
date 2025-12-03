@echo off
chcp 65001 >nul
echo 🚀 Telegram 监控系统 - 快速启动脚本
echo ==================================
echo.

REM 检查 Docker
docker --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 错误：未安装 Docker，请先安装 Docker Desktop
    echo 📝 访问：https://www.docker.com/products/docker-desktop
    pause
    exit /b 1
)

REM 检查 Docker Compose
docker-compose --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 错误：未安装 Docker Compose
    pause
    exit /b 1
)

echo ✅ Docker 环境检查通过
echo.

REM 检查 .env 文件
if not exist .env (
    echo ⚠️  未找到 .env 文件，复制模板...
    copy .env.example .env >nul
    echo 📝 请编辑 .env 文件，配置 API_ID 和 API_HASH
    echo 📝 获取方式：https://my.telegram.org/apps
    echo.
    pause
    exit /b 0
)

REM 创建必要的目录
echo 📁 创建数据目录...
if not exist data\mongo mkdir data\mongo
if not exist data\session mkdir data\session
if not exist logs\api mkdir logs\api
if not exist logs\telethon mkdir logs\telethon

REM 启动服务
echo 🐳 启动 Docker 容器...
docker-compose up -d

echo.
echo ✅ 服务启动成功！
echo.
echo 📊 查看服务状态：
docker-compose ps
echo.
echo 🌐 访问地址：http://localhost
echo 👤 默认用户名：admin
echo 🔑 默认密码：admin123
echo.
echo 📝 查看日志：
echo   docker-compose logs -f
echo.
echo ⚠️  首次使用需要登录 Telegram 账号：
echo   docker-compose logs -f telethon
echo.
pause
