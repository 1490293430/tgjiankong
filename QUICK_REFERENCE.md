# 🚀 Telegram Monitor 服务器快速参考卡

## 立即执行（修复您当前的问题）

### 第 1 步：连接到服务器
```bash
ssh root@your-server-ip
cd /opt/telegram-monitor
```

### 第 2 步：拉取最新修复
```bash
git pull origin main
```

### 第 3 步：验证容器正在运行
```bash
# 使用正确的服务名称重启
docker-compose restart api

# 等待启动
sleep 5

# 查看状态（应该显示 "Up"）
docker-compose ps
```

### 第 4 步：检查后端日志
```bash
# 查看最后 20 行日志
docker-compose logs api --tail 20

# 应该看到：
# ✅ API 服务运行在端口 3000
# ✅ MongoDB 已连接
```

### 第 5 步：测试 API（使用 curl 代替 wget）
```bash
# 从主机测试
curl http://localhost:3000/health

# 或从容器内测试
docker exec tg_api curl -s http://localhost:3000/health
```

---

## 常见问题和解决方案

### ❌ "No such service: tg_api"
**原因**：docker-compose 服务名称是 `api`，不是 `tg_api`

**✓ 正确命令**：
```bash
# ✓ 使用服务名称
docker-compose restart api

# ✓ 使用容器名称查看日志
docker logs tg_api --tail 20
```

### ❌ "wget: executable file not found"
**原因**：npm/nginx 容器中没有 wget

**✓ 使用 curl 代替**：
```bash
# ✓ curl 在所有 Alpine 容器中可用
docker exec tg_api curl -s http://localhost:3000/health
docker exec tg_web curl -s http://localhost
```

### ❌ "Cannot connect to API"
**原因**：可能是健康检查配置不兼容

**✓ 已修复**：在最新版本中已从 wget 改为 curl

**更新方法**：
```bash
# 拉取最新 docker-compose.yml
git pull origin main

# 重建镜像
docker-compose build --no-cache

# 重启容器
docker-compose up -d
```

---

## 完整命令参考

| 命令 | 说明 |
|------|------|
| `docker-compose ps` | 查看所有容器状态 |
| `docker-compose restart api` | 重启后端容器 |
| `docker-compose logs api -f` | 查看实时日志 |
| `docker-compose logs api --tail 50` | 查看最后 50 行 |
| `docker exec tg_api curl http://localhost:3000/health` | 测试 API |
| `docker-compose down` | 停止所有容器 |
| `docker-compose up -d` | 启动所有容器 |
| `docker-compose logs mongo --tail 20` | 查看数据库日志 |

---

## 部署检查清单

在访问应用前，确保：

- [ ] `docker-compose ps` 显示所有容器都是 "Up"
- [ ] `docker-compose logs api --tail 5` 显示 "API 服务运行在端口 3000"
- [ ] `docker-compose logs api --tail 10` 显示 "MongoDB 已连接"
- [ ] `curl http://localhost:3000/health` 返回 JSON 响应
- [ ] NPM 反向代理指向 `tg_api:3000`（如果使用 NPM）

---

## NPM 反向代理配置

如果您使用 Nginx Proxy Manager，配置应该是：

**域名**：tg.970108.xyz
- Forward Hostname/IP: `tg_api` 或 `api`
- Forward Port: `3000`
- Websockets Support: 启用（如果使用）

**测试**：
```bash
curl https://tg.970108.xyz/health
```

---

## 文件说明

- `install.sh` - 一键部署脚本（已修复）
- `docker-compose.yml` - 容器编排（已改进）
- `fix-deployment.sh` - 诊断和修复脚本
- `DEPLOYMENT_TROUBLESHOOTING.md` - 详细故障排除指南

---

## 运行最新诊断脚本

```bash
# 复制脚本（如果还没有）
scp fix-deployment.sh root@your-server:/opt/telegram-monitor/

# 在服务器上运行
cd /opt/telegram-monitor
chmod +x fix-deployment.sh
./fix-deployment.sh
```

---

## 紧急重启（如果一切都坏了）

```bash
cd /opt/telegram-monitor

# 停止所有容器
docker-compose down

# 完全清理（谨慎！会删除容器但保留卷）
docker-compose down -v

# 从头启动
docker-compose build --no-cache
docker-compose up -d

# 等待启动完成
sleep 15

# 查看状态
docker-compose ps
docker-compose logs api --tail 30
```

---

## 支持和诊断

如果问题持续存在，收集诊断信息：

```bash
# 收集系统信息
docker version > /tmp/docker-info.txt
docker-compose version >> /tmp/docker-info.txt
docker ps -a >> /tmp/docker-info.txt

# 收集容器日志
docker-compose logs --tail 100 > /tmp/compose-logs.txt

# 收集网络信息
docker network inspect telegram-monitor_tg-network > /tmp/network-info.txt

# 查看文件
cat /tmp/docker-info.txt
cat /tmp/compose-logs.txt | head -50
```

---

## 📚 更多资源

- [部署故障排除指南](DEPLOYMENT_TROUBLESHOOTING.md)
- [完整部署步骤](DEPLOY_DEBIAN.md)
- [项目 README](README.md)

---

## 💡 提示

- 保持容器日志清洁：`docker logs --tail 1000` 查看完整历史
- 定期备份数据：`docker exec tg_mongo mongodump --archive > backup.archive`
- 监控资源使用：`docker stats`
- 检查网络连接：`docker network inspect telegram-monitor_tg-network`

---

**最后更新**：2025-12-04
**版本**：2.0（改进健康检查，使用 curl 替代 wget）
