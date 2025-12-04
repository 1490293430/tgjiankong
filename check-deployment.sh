#!/bin/bash

# 🔒 安全修复部署检查脚本
# 用途：在部署到服务器前验证所有安全修复已正确应用

set -e

BACKEND_DIR="./backend"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🔒 === 安全修复部署前检查 ===" 
echo ""

# 计数器
PASSED=0
FAILED=0

# 检查函数
check() {
  local description=$1
  local command=$2
  
  if eval "$command" > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} $description"
    ((PASSED++))
  else
    echo -e "${RED}✗${NC} $description"
    ((FAILED++))
  fi
}

# ===== 依赖检查 =====
echo -e "${YELLOW}📦 检查依赖包${NC}"
check "express-rate-limit 已安装" "[ -d $BACKEND_DIR/node_modules/express-rate-limit ]"
check "helmet 已安装" "[ -d $BACKEND_DIR/node_modules/helmet ]"
check "joi 已安装" "[ -d $BACKEND_DIR/node_modules/joi ]"
echo ""

# ===== 代码修复检查 =====
echo -e "${YELLOW}🔧 检查代码修复${NC}"
check "/api/alert/push 已添加认证" "grep -q 'app.post.*\/api\/alert\/push.*authMiddleware' $BACKEND_DIR/server.js"
check "登录端点已添加速率限制" "grep -q 'app.post.*\/api\/auth\/login.*loginLimiter' $BACKEND_DIR/server.js"
check "JWT_SECRET 验证已添加" "grep -q 'process.env.JWT_SECRET.*-change' $BACKEND_DIR/server.js"
check "Helmet 已配置" "grep -q 'require.*helmet' $BACKEND_DIR/server.js"
check "CORS 已配置为白名单" "grep -q 'ALLOWED_ORIGINS' $BACKEND_DIR/server.js"
check "输入验证已添加" "grep -q 'logsQuerySchema' $BACKEND_DIR/server.js"
check "apiLimiter 已配置" "grep -q 'const apiLimiter' $BACKEND_DIR/server.js"
echo ""

# ===== 环境配置检查 =====
echo -e "${YELLOW}⚙️  检查环境配置${NC}"
if [ -f "$BACKEND_DIR/.env" ]; then
  echo -e "${GREEN}✓${NC} .env 文件已创建"
  ((PASSED++))
  
  if grep -q 'JWT_SECRET=' "$BACKEND_DIR/.env"; then
    echo -e "${GREEN}✓${NC} JWT_SECRET 配置项已存在"
    ((PASSED++))
  else
    echo -e "${RED}✗${NC} JWT_SECRET 配置项缺失"
    ((FAILED++))
  fi
  
  if grep -q 'ALLOWED_ORIGINS=' "$BACKEND_DIR/.env"; then
    echo -e "${GREEN}✓${NC} ALLOWED_ORIGINS 配置项已存在"
    ((PASSED++))
  else
    echo -e "${RED}✗${NC} ALLOWED_ORIGINS 配置项缺失"
    ((FAILED++))
  fi
else
  echo -e "${RED}✗${NC} .env 文件不存在"
  ((FAILED++))
fi
echo ""

# ===== 语法检查 =====
echo -e "${YELLOW}✓ 检查 JavaScript 语法${NC}"
if node -c "$BACKEND_DIR/server.js" > /dev/null 2>&1; then
  echo -e "${GREEN}✓${NC} server.js 语法正确"
  ((PASSED++))
else
  echo -e "${RED}✗${NC} server.js 语法有问题"
  ((FAILED++))
fi
echo ""

# ===== 总结 =====
echo -e "${YELLOW}📊 检查结果${NC}"
echo -e "通过: ${GREEN}$PASSED${NC}"
echo -e "失败: ${RED}$FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}✓ 所有检查已通过！可以部署到服务器${NC}"
  exit 0
else
  echo -e "${RED}✗ 还有 $FAILED 个检查失败，请修复后再部署${NC}"
  exit 1
fi
