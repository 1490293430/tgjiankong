#!/usr/bin/env bash
set -e

# 检查是否为 root
if [ "$EUID" -ne 0 ]; then 
  echo "❌ 请使用 root 权限运行: sudo bash uninstall.sh"
  exit 1
fi

APP_DIR="/opt/telegram-monitor"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 如果从项目目录运行，使用当前目录
if [ -f "$SCRIPT_DIR/docker-compose.yml" ]; then
  APP_DIR="$SCRIPT_DIR"
fi

cd "$APP_DIR" 2>/dev/null || {
  echo "⚠️  未找到安装目录: $APP_DIR"
  echo "💡 提示：如果安装在自定义目录，请手动指定："
  echo "   sudo APP_DIR=/your/path bash uninstall.sh"
  exit 1
}

echo "🗑️  Telegram Monitor 卸载脚本"
echo "=================================="
echo ""
echo "⚠️  警告：此操作将删除所有容器和数据！"
echo "📂 安装目录: $APP_DIR"
echo ""

# 确认操作
read -p "确定要卸载吗？(输入 yes 确认): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "❌ 已取消卸载"
  exit 0
fi

# 确保 docker compose 可用
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  COMPOSE_CMD="docker-compose"
fi

# 停止并删除容器
echo ""
echo "[1/4] 停止并删除容器..."
if [ -f docker-compose.yml ]; then
  $COMPOSE_CMD down -v 2>/dev/null || true
  echo "✅ 容器已停止并删除"
else
  echo "⚠️  未找到 docker-compose.yml，跳过容器清理"
fi

# 删除独立容器（多开模式的容器）
echo ""
echo "[2/4] 清理多开登录容器..."
CONTAINERS=$(docker ps -a --filter "name=tg_listener_" --format "{{.Names}}" 2>/dev/null || true)
if [ -n "$CONTAINERS" ]; then
  echo "$CONTAINERS" | while read -r container; do
    docker stop "$container" 2>/dev/null || true
    docker rm "$container" 2>/dev/null || true
    echo "  ✅ 已删除容器: $container"
  done
else
  echo "  ℹ️  未找到多开登录容器"
fi

# 删除网络（如果存在且没有被其他容器使用）
echo ""
echo "[3/4] 清理 Docker 网络..."
if docker network inspect tg-network >/dev/null 2>&1; then
  # 检查是否有容器在使用
  CONTAINERS_IN_NETWORK=$(docker network inspect tg-network --format '{{len .Containers}}' 2>/dev/null || echo "0")
  if [ "$CONTAINERS_IN_NETWORK" = "0" ]; then
    docker network rm tg-network 2>/dev/null && echo "  ✅ 已删除网络: tg-network" || echo "  ⚠️  删除网络失败（可能正在被使用）"
  else
    echo "  ℹ️  网络 tg-network 正在被使用，跳过删除"
  fi
else
  echo "  ℹ️  网络 tg-network 不存在"
fi

# npm-net 是外部网络，不删除（可能被其他服务使用）
echo "  ℹ️  保留外部网络 npm-net（可能被其他服务使用）"

# 询问是否删除数据
echo ""
echo "[4/4] 数据清理选项..."
echo ""
echo "请选择数据清理方式："
echo "  1) 保留所有数据（推荐，可后续手动删除）"
echo "  2) 删除所有数据（包括数据库、session 文件等）"
echo "  3) 仅删除代码，保留数据目录"
echo ""
read -p "请选择 (1/2/3，默认 1): " DATA_CHOICE
DATA_CHOICE="${DATA_CHOICE:-1}"

case "$DATA_CHOICE" in
  1)
    echo "✅ 保留所有数据"
    echo "📂 数据目录位置: $APP_DIR/data/"
    ;;
  2)
    echo "🗑️  删除所有数据..."
    if [ -d "$APP_DIR/data" ]; then
      rm -rf "$APP_DIR/data"
      echo "  ✅ 已删除数据目录"
    fi
    if [ -d "$APP_DIR/logs" ]; then
      rm -rf "$APP_DIR/logs"
      echo "  ✅ 已删除日志目录"
    fi
    if [ -d "$APP_DIR/backups" ]; then
      rm -rf "$APP_DIR/backups"
      echo "  ✅ 已删除备份目录"
    fi
    ;;
  3)
    echo "✅ 仅删除代码，保留数据"
    ;;
esac

# 询问是否删除代码目录
if [ "$DATA_CHOICE" != "2" ]; then
  echo ""
  read -p "是否删除整个安装目录？(y/N): " DELETE_DIR
  if [ "$DELETE_DIR" = "y" ] || [ "$DELETE_DIR" = "Y" ]; then
    if [ "$APP_DIR" != "/" ] && [ -d "$APP_DIR" ]; then
      cd /
      rm -rf "$APP_DIR"
      echo "  ✅ 已删除安装目录: $APP_DIR"
    fi
  else
    echo "  ✅ 保留安装目录: $APP_DIR"
  fi
else
  # 如果删除了所有数据，询问是否删除代码
  echo ""
  read -p "是否删除代码目录？(y/N): " DELETE_CODE
  if [ "$DELETE_CODE" = "y" ] || [ "$DELETE_CODE" = "Y" ]; then
    if [ "$APP_DIR" != "/" ] && [ -d "$APP_DIR" ]; then
      # 只删除代码，保留目录结构
      cd "$APP_DIR"
      find . -maxdepth 1 ! -name "." ! -name "data" ! -name "logs" ! -name "backups" -exec rm -rf {} + 2>/dev/null || true
      echo "  ✅ 已删除代码文件（保留数据目录结构）"
    fi
  fi
fi

echo ""
echo "✅ 卸载完成！"
echo ""
echo "📝 提示："
if [ "$DATA_CHOICE" = "1" ]; then
  echo "  - 数据已保留在: $APP_DIR/data/"
  echo "  - 如需完全删除，可手动删除目录: rm -rf $APP_DIR"
fi
echo "  - 如需重新安装，请运行: bash <(curl -fsSL https://raw.githubusercontent.com/1490293430/tgjiankong/main/install.sh)"

