# 🚀 服务器部署指南 - 安全修复版本

## 📋 部署前检查清单

在服务器上部署之前，请确保以下步骤已完成：

### ✅ 代码修复完成
- [x] `/api/alert/push` 已添加 `authMiddleware`
- [x] JWT_SECRET 验证已添加
- [x] 速率限制已配置
- [x] CORS 白名单已配置
- [x] Helmet 安全头已添加
- [x] 输入验证已添加
- [x] 错误处理已改进
- [x] 依赖包已安装

### ✅ 环境配置
- [ ] 生成强随机的 JWT_SECRET
- [ ] 配置 ALLOWED_ORIGINS（你的域名）
- [ ] 配置 MONGO_URL（包含认证）
- [ ] 设置 NODE_ENV=production

---

## 🔧 服务器部署步骤

### 第一步：上传代码到服务器

```bash
# 在你的本地机器上
scp -r /path/to/tgjiankong root@your-server:/opt/

# 或使用 git（推荐）
ssh root@your-server
cd /opt/tgjiankong
git pull origin main
```

### 第二步：生成安全的 JWT_SECRET

在服务器上执行：

```bash
cd /opt/tgjiankong/backend

# 生成强随机密钥
JWT_SECRET=$(openssl rand -base64 32)
echo "JWT_SECRET=$JWT_SECRET"

# 更新 .env 文件
sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$JWT_SECRET/" .env
```

### 第三步：配置环境变量

编辑 `backend/.env`：

```bash
nano /opt/tgjiankong/backend/.env
```

关键配置项：

```bash
# ✅ 安全配置
JWT_SECRET=生成的随机值（从第二步复制）
NODE_ENV=production

# ✅ 服务器配置
PORT=3000

# ✅ MongoDB - 包含认证信息
MONGO_URL=mongodb://username:password@mongodb:27017/tglogs

# ✅ CORS 白名单 - 设置为你的域名
ALLOWED_ORIGINS=https://your-domain.com,https://www.your-domain.com
```

### 第四步：安装依赖

```bash
cd /opt/tgjiankong/backend
npm install
```

### 第五步：启动服务

使用 Docker Compose（推荐）：

```bash
cd /opt/tgjiankong

# 启动所有服务
docker-compose up -d

# 查看日志
docker-compose logs -f backend
```

或使用 PM2（如果不用 Docker）：

```bash
npm install -g pm2

cd /opt/tgjiankong/backend
pm2 start server.js --name telegram-monitor
pm2 save
```

### 第六步：验证部署

```bash
# 检查服务是否运行
docker-compose ps
# 或
pm2 list

# 查看日志确认没有错误
docker-compose logs backend
# 或
pm2 logs telegram-monitor
```

---

## 🧪 部署后测试

### 测试 1：验证无认证端点被拒绝

```bash
# 这应该返回 {"error":"未授权"}
curl -X POST http://your-server:3000/api/alert/push \
  -H "Content-Type: application/json" \
  -d '{"keyword":"test","message":"test"}'
```

### 测试 2：验证登录功能

```bash
# 登录获取 token
TOKEN=$(curl -s -X POST http://your-server:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | jq -r '.token')

echo "Token: $TOKEN"

# 用 token 调用受保护端点
curl -X GET http://your-server:3000/api/logs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json"
```

### 测试 3：验证速率限制

```bash
# 快速尝试 6 次登录，第 6 次应被限制
for i in {1..6}; do
  echo "尝试 $i:"
  curl -s -X POST http://your-server:3000/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"wrongpassword"}' | jq '.error'
  sleep 0.5
done

# 第 6 次应返回: "登录尝试过多，请 5 分钟后再试"
```

### 测试 4：验证安全响应头

```bash
curl -I http://your-server:3000/api/config \
  -H "Authorization: Bearer $TOKEN"

# 应该看到这些头：
# X-Content-Type-Options: nosniff
# X-Frame-Options: DENY
# X-XSS-Protection: 1; mode=block
# Content-Security-Policy: ...
```

---

## 🔐 首次登录后立即修改密码

系统使用默认密码 `admin123`，**必须在首次登录后立即修改**！

### 修改密码步骤

1. 登录到仪表板
2. 进入设置/配置页面
3. 找到"修改密码"选项
4. 输入新的强密码（建议：至少 12 字符，包含大小写字母、数字、特殊字符）

**新密码必须满足**：
- 至少 12 个字符
- 包含大小写字母
- 包含数字
- 包含特殊字符（如 !@#$%^&*）

---

## 📊 部署清单

在部署到生产环境前，请确保：

### 安全配置
- [ ] JWT_SECRET 已设置为强随机值（非默认值）
- [ ] NODE_ENV 设置为 production
- [ ] ALLOWED_ORIGINS 配置为你的域名（非 localhost）
- [ ] MongoDB 连接字符串包含认证信息
- [ ] 默认密码已修改

### 系统配置
- [ ] Docker 已安装并运行
- [ ] MongoDB 服务已启动
- [ ] 所需端口已开放（80, 443, 3000）
- [ ] 防火墙规则已配置
- [ ] SSL 证书已配置（HTTPS）

### 功能验证
- [ ] 登录功能正常
- [ ] 日志查询正常
- [ ] 告警推送正常
- [ ] AI 分析正常（如已配置）

### 监控告警
- [ ] 系统监控已配置
- [ ] 错误告警已配置
- [ ] 性能监控已配置
- [ ] 日志收集已配置

---

## 🚨 常见部署问题

### 问题 1：JWT_SECRET 未设置

**症状**：启动时收到"JWT_SECRET 未设置"错误

**解决**：
```bash
# 生成并设置
JWT_SECRET=$(openssl rand -base64 32)
echo "JWT_SECRET=$JWT_SECRET" >> backend/.env

# 重启服务
docker-compose restart backend
```

### 问题 2：MongoDB 连接失败

**症状**：logs 中显示"MongoDB 连接失败"

**解决**：
```bash
# 检查 MongoDB 是否运行
docker-compose ps | grep mongo

# 重启 MongoDB
docker-compose restart mongo

# 检查连接字符串
cat backend/.env | grep MONGO_URL
```

### 问题 3：端口被占用

**症状**：启动时显示"端口 3000 已被占用"

**解决**：
```bash
# 查找占用端口的进程
lsof -i :3000

# 更改端口
sed -i 's/PORT=3000/PORT=3001/' backend/.env
docker-compose up -d
```

### 问题 4：CORS 错误

**症状**：前端请求失败，提示 CORS 错误

**解决**：
```bash
# 检查 ALLOWED_ORIGINS 配置
cat backend/.env | grep ALLOWED_ORIGINS

# 如需修改
nano backend/.env
# 添加你的域名到 ALLOWED_ORIGINS
```

---

## 📈 性能优化

### 增加 Node.js 内存限制

```bash
# 在 docker-compose.yml 中
environment:
  - NODE_OPTIONS=--max_old_space_size=2048
```

### 配置反向代理（Nginx）

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 🔍 监控和维护

### 定期检查日志

```bash
# 查看最近 100 行日志
docker-compose logs --tail 100 backend

# 实时监控日志
docker-compose logs -f backend

# 或使用 PM2
pm2 logs telegram-monitor
```

### 定期备份

```bash
# 备份数据库
docker-compose exec mongo mongodump --out /backup/mongo

# 备份配置
tar -czf /backup/config-$(date +%Y%m%d).tar.gz /opt/tgjiankong/backend/config.json

# 每天自动备份（cron）
0 2 * * * /opt/tgjiankong/backup.sh
```

### 更新依赖

```bash
cd /opt/tgjiankong/backend

# 检查过时的包
npm outdated

# 安全更新
npm update

# 审计安全漏洞
npm audit
npm audit fix
```

---

## 🎯 下一步

部署完成后，建议：

1. **立即修改默认密码**
2. **配置备份策略**
3. **设置监控告警**
4. **定期安全审计**
5. **保持依赖更新**

---

**部署完成后，系统应该达到企业级安全水平！** ✅

