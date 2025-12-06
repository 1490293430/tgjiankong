#!/bin/bash
# Telegram Monitor 数据恢复脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${SCRIPT_DIR}/backups"

echo "📥 Telegram Monitor 数据恢复工具"
echo "=================================="
echo ""

# 列出可用的备份
if [ ! -d "${BACKUP_DIR}" ] || [ -z "$(ls -A ${BACKUP_DIR} 2>/dev/null)" ]; then
    echo "❌ 未找到备份文件！"
    exit 1
fi

echo "可用的备份："
echo ""
BACKUPS=()
INDEX=1

# 查找所有备份（.tar.gz 和目录）
for backup in $(ls -t "${BACKUP_DIR}"/backup_*.* 2>/dev/null | head -20); do
    BACKUP_NAME=$(basename "$backup" | sed 's/\.tar\.gz$//')
    BACKUP_DATE=$(echo "$BACKUP_NAME" | sed 's/backup_//' | sed 's/_/ /')
    echo "  [$INDEX] $BACKUP_NAME ($BACKUP_DATE)"
    BACKUPS[$INDEX]="$backup"
    INDEX=$((INDEX + 1))
done

for backup in $(ls -dt "${BACKUP_DIR}"/backup_*/ 2>/dev/null | head -20); do
    BACKUP_NAME=$(basename "$backup")
    BACKUP_DATE=$(echo "$BACKUP_NAME" | sed 's/backup_//' | sed 's/_/ /')
    echo "  [$INDEX] $BACKUP_NAME/ ($BACKUP_DATE)"
    BACKUPS[$INDEX]="$backup"
    INDEX=$((INDEX + 1))
done

echo ""
read -p "请选择要恢复的备份编号: " choice

if [ -z "${BACKUPS[$choice]}" ]; then
    echo "❌ 无效的选择！"
    exit 1
fi

SELECTED_BACKUP="${BACKUPS[$choice]}"
echo ""
echo "📦 选择的备份: $(basename "$SELECTED_BACKUP")"
echo ""

# 确认
read -p "⚠️  恢复备份将覆盖现有配置和数据，是否继续？(yes/no): " confirm
if [ "$confirm" != "yes" ]; then
    echo "❌ 已取消恢复"
    exit 0
fi

# 如果是压缩文件，先解压
if [[ "$SELECTED_BACKUP" == *.tar.gz ]]; then
    echo "📂 解压备份文件..."
    TEMP_DIR=$(mktemp -d)
    tar -xzf "$SELECTED_BACKUP" -C "$TEMP_DIR"
    BACKUP_PATH="$TEMP_DIR/$(basename "$SELECTED_BACKUP" .tar.gz)"
else
    BACKUP_PATH="$SELECTED_BACKUP"
fi

# 恢复配置文件
if [ -f "${BACKUP_PATH}/config.json" ]; then
    cp "${BACKUP_PATH}/config.json" "${SCRIPT_DIR}/backend/config.json"
    echo "✅ 已恢复配置文件: backend/config.json"
else
    echo "⚠️  备份中未找到配置文件"
fi

# 恢复 .env 文件
if [ -f "${BACKUP_PATH}/.env" ]; then
    cp "${BACKUP_PATH}/.env" "${SCRIPT_DIR}/.env"
    echo "✅ 已恢复环境变量: .env"
fi

# 恢复数据目录
if [ -d "${BACKUP_PATH}/data" ]; then
    if [ -d "${SCRIPT_DIR}/data" ]; then
        echo "⚠️  数据目录已存在，将备份现有数据..."
        mv "${SCRIPT_DIR}/data" "${SCRIPT_DIR}/data.backup.$(date +%Y%m%d_%H%M%S)"
    fi
    cp -r "${BACKUP_PATH}/data" "${SCRIPT_DIR}/data"
    echo "✅ 已恢复数据目录: data/"
fi

# 清理临时目录
if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
fi

echo ""
echo "✅ 恢复完成！"
echo ""
echo "下一步："
echo "1. 检查配置文件是否正确: cat ${SCRIPT_DIR}/backend/config.json"
echo "2. 重启服务: docker-compose restart"
echo "3. 或者完全重启: docker-compose down && docker-compose up -d"

