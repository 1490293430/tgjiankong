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

# 恢复多开登录的独立配置文件（config_*.json）
if [ -d "${BACKUP_PATH}/multi_login_configs" ]; then
    if [ -d "${SCRIPT_DIR}/backend" ]; then
        for config_file in "${BACKUP_PATH}/multi_login_configs"/config_*.json; do
            if [ -f "${config_file}" ]; then
                cp "${config_file}" "${SCRIPT_DIR}/backend/$(basename "${config_file}")"
                echo "✅ 已恢复多开登录配置文件: $(basename "${config_file}")"
            fi
        done
    fi
fi

# 恢复 .env 文件
if [ -f "${BACKUP_PATH}/.env" ]; then
    cp "${BACKUP_PATH}/.env" "${SCRIPT_DIR}/.env"
    echo "✅ 已恢复环境变量: .env"
fi

# 恢复 MongoDB 数据（优先使用 mongorestore）
MONGO_CONTAINER="tg_mongo"
MONGO_DB="tglogs"

if [ -d "${BACKUP_PATH}/mongo_dump" ]; then
    echo "📊 恢复 MongoDB 数据库（使用 mongodump 备份）..."
    
    # 检查 MongoDB 容器是否运行
    if docker ps --format '{{.Names}}' | grep -q "^${MONGO_CONTAINER}$"; then
        # 查找数据库备份目录
        DB_BACKUP_PATH="${BACKUP_PATH}/mongo_dump/${MONGO_DB}"
        
        # 如果标准路径不存在，查找子目录
        if [ ! -d "${DB_BACKUP_PATH}" ]; then
            # 检查 mongo_dump 目录下是否直接包含 .bson 文件
            if ls "${BACKUP_PATH}/mongo_dump"/*.bson 1> /dev/null 2>&1; then
                DB_BACKUP_PATH="${BACKUP_PATH}/mongo_dump"
            else
                # 查找包含数据库备份的子目录
                for subdir in "${BACKUP_PATH}/mongo_dump"/*; do
                    if [ -d "$subdir" ] && ls "$subdir"/*.bson 1> /dev/null 2>&1; then
                        DB_BACKUP_PATH="$subdir"
                        break
                    fi
                done
            fi
        fi
        
        if [ -d "${DB_BACKUP_PATH}" ] && ls "${DB_BACKUP_PATH}"/*.bson 1> /dev/null 2>&1; then
            # 复制备份到容器
            echo "📦 复制备份文件到容器..."
            docker cp "${DB_BACKUP_PATH}" "${MONGO_CONTAINER}:/tmp/mongo_restore" 2>/dev/null || {
                echo "⚠️  直接复制失败，尝试创建 tar 文件..."
                TEMP_TAR=$(mktemp)
                tar -cf "${TEMP_TAR}" -C "$(dirname "${DB_BACKUP_PATH}")" "$(basename "${DB_BACKUP_PATH}")" 2>/dev/null
                if [ -f "${TEMP_TAR}" ]; then
                    docker cp "${TEMP_TAR}" "${MONGO_CONTAINER}:/tmp/mongo_restore.tar" 2>/dev/null
                    docker exec "${MONGO_CONTAINER}" tar -xf /tmp/mongo_restore.tar -C /tmp 2>/dev/null
                    docker exec "${MONGO_CONTAINER}" rm -f /tmp/mongo_restore.tar 2>/dev/null
                    rm -f "${TEMP_TAR}"
                fi
            }
            
            # 执行 mongorestore
            echo "🔄 执行 mongorestore..."
            if docker exec "${MONGO_CONTAINER}" mongorestore --db "${MONGO_DB}" --drop --numParallelCollections 4 "/tmp/mongo_restore" 2>/dev/null; then
                echo "✅ MongoDB 数据库已恢复（使用 mongorestore）"
                MONGO_RESTORED=true
            else
                echo "⚠️  mongorestore 失败，将使用文件系统恢复"
                MONGO_RESTORED=false
            fi
            
            # 清理容器内的临时文件
            docker exec "${MONGO_CONTAINER}" rm -rf /tmp/mongo_restore 2>/dev/null || true
        else
            echo "⚠️  未找到有效的 MongoDB 备份数据"
            MONGO_RESTORED=false
        fi
    else
        echo "⚠️  MongoDB 容器未运行，将使用文件系统恢复"
        MONGO_RESTORED=false
    fi
else
    echo "ℹ️  未找到 mongodump 备份，将使用文件系统恢复"
    MONGO_RESTORED=false
fi

# 恢复数据目录（包括 session 和 MongoDB 文件系统备份）
if [ -d "${BACKUP_PATH}/data" ]; then
    if [ "$MONGO_RESTORED" != "true" ] && [ -d "${BACKUP_PATH}/data/mongo" ]; then
        echo "📊 恢复 MongoDB 数据目录（文件系统备份）..."
        if [ -d "${SCRIPT_DIR}/data/mongo" ]; then
            echo "⚠️  MongoDB 数据目录已存在，将备份现有数据..."
            mv "${SCRIPT_DIR}/data/mongo" "${SCRIPT_DIR}/data/mongo.backup.$(date +%Y%m%d_%H%M%S)"
        fi
        mkdir -p "${SCRIPT_DIR}/data"
        cp -r "${BACKUP_PATH}/data/mongo" "${SCRIPT_DIR}/data/mongo"
        echo "✅ 已恢复 MongoDB 数据目录: data/mongo/"
    fi
    
    # 恢复 session 目录
    if [ -d "${BACKUP_PATH}/data/session" ]; then
        echo "📦 恢复 session 文件..."
        if [ -d "${SCRIPT_DIR}/data/session" ]; then
            echo "⚠️  Session 目录已存在，将备份现有数据..."
            mv "${SCRIPT_DIR}/data/session" "${SCRIPT_DIR}/data/session.backup.$(date +%Y%m%d_%H%M%S)"
        fi
        mkdir -p "${SCRIPT_DIR}/data"
        cp -r "${BACKUP_PATH}/data/session" "${SCRIPT_DIR}/data/session"
        echo "✅ 已恢复 session 文件: data/session/"
    fi
fi

# 验证恢复结果
echo ""
echo "🔍 验证恢复结果..."
VERIFY_FAILED=0

# 验证配置文件
if [ ! -f "${SCRIPT_DIR}/backend/config.json" ]; then
    echo "❌ 配置文件恢复失败"
    VERIFY_FAILED=1
else
    echo "✅ 配置文件已恢复"
fi

# 验证 .env 文件
if [ -f "${BACKUP_PATH}/.env" ] && [ ! -f "${SCRIPT_DIR}/.env" ]; then
    echo "❌ 环境变量文件恢复失败"
    VERIFY_FAILED=1
elif [ -f "${SCRIPT_DIR}/.env" ]; then
    echo "✅ 环境变量文件已恢复"
fi

# 验证多开登录配置文件
MULTI_LOGIN_COUNT=$(find "${SCRIPT_DIR}/backend" -maxdepth 1 -name "config_*.json" 2>/dev/null | wc -l)
if [ -d "${BACKUP_PATH}/multi_login_configs" ]; then
    BACKUP_MULTI_COUNT=$(find "${BACKUP_PATH}/multi_login_configs" -name "config_*.json" 2>/dev/null | wc -l)
    if [ "$MULTI_LOGIN_COUNT" -lt "$BACKUP_MULTI_COUNT" ]; then
        echo "⚠️  多开登录配置文件恢复不完整（恢复: ${MULTI_LOGIN_COUNT}, 备份: ${BACKUP_MULTI_COUNT}）"
    else
        echo "✅ 多开登录配置文件已恢复（${MULTI_LOGIN_COUNT} 个）"
    fi
fi

# 验证 MongoDB 数据
if [ "$MONGO_RESTORED" = "true" ]; then
    echo "✅ MongoDB 数据库已恢复（使用 mongorestore）"
elif [ -d "${SCRIPT_DIR}/data/mongo" ]; then
    echo "✅ MongoDB 数据目录已恢复（文件系统备份）"
else
    echo "⚠️  MongoDB 数据未恢复"
fi

# 验证 session 文件
if [ -d "${SCRIPT_DIR}/data/session" ]; then
    SESSION_COUNT=$(find "${SCRIPT_DIR}/data/session" -name "*.session" ! -name "*.session-journal" 2>/dev/null | wc -l)
    if [ "$SESSION_COUNT" -gt 0 ]; then
        echo "✅ Session 文件已恢复（${SESSION_COUNT} 个）"
    else
        echo "⚠️  Session 目录存在但无 session 文件"
    fi
else
    echo "⚠️  Session 目录未恢复"
fi

# 清理临时目录
if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
fi

echo ""
if [ "$VERIFY_FAILED" -eq 0 ]; then
    echo "✅ 恢复完成！所有关键数据已恢复。"
else
    echo "⚠️  恢复完成，但部分数据恢复失败，请检查上述错误信息。"
fi
echo ""
echo "下一步："
echo "1. 检查配置文件是否正确: cat ${SCRIPT_DIR}/backend/config.json"
echo "2. 重启服务: docker-compose restart"
echo "3. 或者完全重启: docker-compose down && docker-compose up -d"
echo "4. 检查服务状态: docker-compose ps"

