# 🎯 立即在服务器上执行

## ⚡ 快速修复（5 分钟）

在您的 Debian 服务器上执行以下命令：

```bash
# 连接到服务器
ssh root@your-server-ip

# 进入项目目录
cd /opt/telegram-monitor

# 拉取最新修复代码
git pull origin main

# 停止现有容器
docker-compose down

# 重新构建并启动（这会修复所有问题）
docker-compose build --no-cache && docker-compose up -d

# 等待容器启动
sleep 10

# 验证所有容器都在运行
docker-compose ps

# 查看后端日志（确认 API 正常运行）
docker-compose logs api --tail 20
```

## ✅ 预期结果

执行上述命令后，您应该看到：

### 容器状态
```
NAME          IMAGE              STATUS
tg_mongo      mongo:6            Up (healthy)
tg_api        <image>            Up (health: starting)
tg_listener   <image>            Up
tg_web        nginx:alpine       Up (health: starting)
```

### 后端日志
```
✅ API 服务运行在端口 3000
📝 默认用户名: admin
📝 默认密码: admin123
⚠️  请及时修改默认密码！
✅ MongoDB 已连接
⏸️  AI 分析功能未启用
```

## 🔍 验证 API 正常工作

```bash
# 从服务器本地测试
curl http://localhost:3000/health

# 从 npm 容器测试（如果使用 NPM）
docker exec npm curl -s http://tg_api:3000/health
```

应该返回类似：
```json
{"status":"ok","time":"2025-12-04T14:59:07.481Z"}
```

## 🌐 通过 NPM 域名访问

如果使用 Nginx Proxy Manager，确保配置正确：

1. 登录 NPM 管理界面
2. 编辑 `tg.970108.xyz` 代理配置
3. 检查以下设置：
   ```
   Forward Hostname/IP: tg_api
   Forward Port: 3000
   ```
4. 保存并测试：
   ```bash
   curl https://tg.970108.xyz/health
   ```

## 📝 修改默认密码

1. 访问 https://tg.970108.xyz
2. 使用 `admin / admin123` 登录
3. 进入设置页面修改密码
4. **重要**：使用强密码（12+ 字符，包含大小写、数字、特殊字符）

## 🔧 常用命令

```bash
# 查看实时日志
docker-compose logs -f api

# 重启 API 服务
docker-compose restart api

# 查看所有日志
docker-compose logs api --tail 100

# 停止所有服务
docker-compose down

# 启动所有服务
docker-compose up -d

# 检查网络连接
docker network inspect telegram-monitor_tg-network
```

## ❓ 如果仍有问题

### 问题：容器无法启动
```bash
# 查看完整日志
docker-compose logs

# 完全重建
docker-compose build --no-cache
docker-compose up -d
```

### 问题：无法通过 NPM 访问
```bash
# 检查 NPM 容器是否在同一网络
docker network inspect telegram-monitor_tg-network

# 验证 API 容器在线
docker exec tg_api curl -s http://localhost:3000/health

# 更新 NPM 配置为 tg_api:3000
```

### 问题：MongoDB 连接错误
```bash
# 查看 MongoDB 日志
docker-compose logs mongo

# 检查数据卷
docker volume ls | grep telegram

# 重新创建数据库
docker-compose down -v
docker-compose up -d
```

## 📊 修复内容

✅ 修复 docker-compose.yml 健康检查（wget → curl）
✅ 添加生产环境配置
✅ 改进 install.sh 部署脚本
✅ 添加完整故障排除指南
✅ 创建诊断工具脚本

## 📚 更多信息

- **快速参考**：`QUICK_REFERENCE.md`
- **详细指南**：`DEPLOYMENT_TROUBLESHOOTING.md`
- **修复总结**：`SERVER_FIXES_SUMMARY.md`
- **部署指南**：`DEPLOY_DEBIAN.md`

---

**状态**：✅ 所有修复已提交到 GitHub
**Commit**：4e2c253（2025-12-04）
**分支**：main
