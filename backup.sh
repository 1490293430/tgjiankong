#!/bin/bash
# Telegram Monitor 数据备份脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${SCRIPT_DIR}/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="backup_${TIMESTAMP}"

echo "📦 开始备份 Telegram Monitor 数据..."

# 创建备份目录
mkdir -p "${BACKUP_DIR}/${BACKUP_NAME}"

# 备份配置文件
if [ -f "${SCRIPT_DIR}/backend/config.json" ]; then
    cp "${SCRIPT_DIR}/backend/config.json" "${BACKUP_DIR}/${BACKUP_NAME}/config.json"
    echo "✅ 已备份配置文件: backend/config.json"
else
    echo "⚠️  配置文件不存在: backend/config.json"
fi

# 备份 .env 文件
if [ -f "${SCRIPT_DIR}/.env" ]; then
    cp "${SCRIPT_DIR}/.env" "${BACKUP_DIR}/${BACKUP_NAME}/.env"
    echo "✅ 已备份环境变量: .env"
fi

# 备份数据目录
if [ -d "${SCRIPT_DIR}/data" ]; then
    if [ "$(ls -A ${SCRIPT_DIR}/data)" ]; then
        cp -r "${SCRIPT_DIR}/data" "${BACKUP_DIR}/${BACKUP_NAME}/data"
        echo "✅ 已备份数据目录: data/"
    else
        echo "⚠️  数据目录为空"
    fi
else
    echo "⚠️  数据目录不存在: data/"
fi

# 创建备份信息文件
cat > "${BACKUP_DIR}/${BACKUP_NAME}/backup_info.txt" <<EOF
备份时间: $(date)
备份路径: ${BACKUP_DIR}/${BACKUP_NAME}
备份内容:
- 配置文件 (backend/config.json)
- 环境变量 (.env)
- 数据目录 (data/)
EOF

# 压缩备份（可选）
cd "${BACKUP_DIR}"
tar -czf "${BACKUP_NAME}.tar.gz" "${BACKUP_NAME}" 2>/dev/null || true
if [ -f "${BACKUP_NAME}.tar.gz" ]; then
    rm -rf "${BACKUP_NAME}"
    echo "✅ 备份已压缩: ${BACKUP_DIR}/${BACKUP_NAME}.tar.gz"
else
    echo "✅ 备份完成: ${BACKUP_DIR}/${BACKUP_NAME}/"
fi

# 清理旧备份（保留最近10个）
echo "🧹 清理旧备份（保留最近10个）..."
ls -t "${BACKUP_DIR}"/backup_*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
ls -dt "${BACKUP_DIR}"/backup_*/ 2>/dev/null | tail -n +11 | xargs -r rm -rf

echo ""
echo "✅ 备份完成！"

# 获取备份的绝对路径
if [ -f "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" ]; then
    # 尝试使用 realpath 或 readlink -f 获取绝对路径，如果失败则使用 cd + pwd 方法
    if command -v realpath >/dev/null 2>&1; then
        BACKUP_PATH=$(realpath "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz")
    elif command -v readlink >/dev/null 2>&1; then
        BACKUP_PATH=$(readlink -f "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz")
    else
        # 使用 cd + pwd 方法获取绝对路径
        BACKUP_PATH=$(cd "${BACKUP_DIR}" && pwd)/${BACKUP_NAME}.tar.gz
    fi
    echo "📁 备份位置: ${BACKUP_PATH}"
else
    # 尝试使用 realpath 或 readlink -f 获取绝对路径，如果失败则使用 cd + pwd 方法
    if command -v realpath >/dev/null 2>&1; then
        BACKUP_PATH=$(realpath "${BACKUP_DIR}/${BACKUP_NAME}")
    elif command -v readlink >/dev/null 2>&1; then
        BACKUP_PATH=$(readlink -f "${BACKUP_DIR}/${BACKUP_NAME}")
    else
        # 使用 cd + pwd 方法获取绝对路径
        BACKUP_PATH=$(cd "${BACKUP_DIR}/${BACKUP_NAME}" && pwd)
    fi
    echo "📁 备份位置: ${BACKUP_PATH}/"
fi

