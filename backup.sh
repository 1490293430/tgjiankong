#!/bin/bash
# Telegram Monitor 数据备份脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${SCRIPT_DIR}/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="backup_${TIMESTAMP}"

echo "📦 开始备份 Telegram Monitor 数据..."

# 创建备份目录（确保主目录存在）
mkdir -p "${BACKUP_DIR}"
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

# 备份 MongoDB 数据库（使用 mongodump 导出，确保数据重构时能完整恢复）
echo "🗄️  备份 MongoDB 数据库..."
MONGO_CONTAINER="tg_mongo"
MONGO_DB="tglogs"

# 临时禁用错误退出，允许 MongoDB 备份失败
set +e

if docker ps --format '{{.Names}}' | grep -q "^${MONGO_CONTAINER}$"; then
    # MongoDB 容器正在运行，使用 mongodump 导出
    MONGO_DUMP_DIR="${BACKUP_DIR}/${BACKUP_NAME}/mongo_dump"
    mkdir -p "${MONGO_DUMP_DIR}"
    
    # 尝试使用 mongodump 导出数据库
    DUMP_SUCCESS=false
    if docker exec "${MONGO_CONTAINER}" mongodump --db="${MONGO_DB}" --out=/tmp/mongo_dump --quiet 2>/dev/null; then
        # 从容器中复制导出的数据
        if docker cp "${MONGO_CONTAINER}:/tmp/mongo_dump/${MONGO_DB}" "${MONGO_DUMP_DIR}/" 2>/dev/null; then
            # 清理容器内的临时文件
            docker exec "${MONGO_CONTAINER}" rm -rf /tmp/mongo_dump 2>/dev/null || true
            
            if [ -d "${MONGO_DUMP_DIR}/${MONGO_DB}" ] && [ "$(ls -A ${MONGO_DUMP_DIR}/${MONGO_DB} 2>/dev/null)" ]; then
                echo "✅ 已备份 MongoDB 数据库: ${MONGO_DB} (mongodump)"
                DUMP_SUCCESS=true
            else
                echo "⚠️  MongoDB 数据库导出目录为空"
                rm -rf "${MONGO_DUMP_DIR}"
            fi
        else
            echo "⚠️  无法从容器复制 MongoDB 导出数据"
            docker exec "${MONGO_CONTAINER}" rm -rf /tmp/mongo_dump 2>/dev/null || true
            rm -rf "${MONGO_DUMP_DIR}"
        fi
    else
        echo "⚠️  MongoDB 数据库导出失败（尝试使用 mongosh 导出）"
        # 尝试使用 mongosh 导出（MongoDB 6+）
        if docker exec "${MONGO_CONTAINER}" mongosh "${MONGO_DB}" --quiet --eval "db.getCollectionNames()" >/dev/null 2>&1; then
            echo "   提示：MongoDB 容器运行正常，但 mongodump 可能不可用"
            echo "   将使用数据文件备份作为替代方案"
        fi
        rm -rf "${MONGO_DUMP_DIR}"
    fi
else
    echo "⚠️  MongoDB 容器未运行，跳过数据库导出"
    echo "   提示：如果 MongoDB 数据文件在 data/mongo/ 目录中，将通过数据目录备份"
fi

# 恢复错误退出
set -e

# 备份数据目录（包括 MongoDB 数据文件，作为备用）
if [ -d "${SCRIPT_DIR}/data" ]; then
    if [ "$(ls -A ${SCRIPT_DIR}/data 2>/dev/null)" ]; then
        # 排除 mongo 目录（如果已经用 mongodump 备份了）
        if [ -d "${BACKUP_DIR}/${BACKUP_NAME}/mongo_dump/${MONGO_DB}" ]; then
            # 只备份 session 目录
            if [ -d "${SCRIPT_DIR}/data/session" ]; then
                mkdir -p "${BACKUP_DIR}/${BACKUP_NAME}/data"
                cp -r "${SCRIPT_DIR}/data/session" "${BACKUP_DIR}/${BACKUP_NAME}/data/session" 2>/dev/null || true
                echo "✅ 已备份 session 目录: data/session/"
            fi
            # 也备份 mongo 目录作为备用（以防 mongodump 不完整）
            if [ -d "${SCRIPT_DIR}/data/mongo" ]; then
                mkdir -p "${BACKUP_DIR}/${BACKUP_NAME}/data"
                cp -r "${SCRIPT_DIR}/data/mongo" "${BACKUP_DIR}/${BACKUP_NAME}/data/mongo" 2>/dev/null || true
                echo "✅ 已备份 MongoDB 数据文件: data/mongo/ (备用)"
            fi
        else
            # 如果没有 mongodump 备份，完整备份 data 目录
            cp -r "${SCRIPT_DIR}/data" "${BACKUP_DIR}/${BACKUP_NAME}/data"
            echo "✅ 已备份数据目录: data/"
        fi
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
- MongoDB 数据库导出 (mongo_dump/) - 用于数据重构
- 数据目录 (data/) - 包含 session 和 MongoDB 数据文件（备用）
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

