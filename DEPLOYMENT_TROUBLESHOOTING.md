# 部署诊断和修复指南

## 📋 当前问题分析

从您的服务器日志可以看到以下问题：

### 1. 容器命名问题
```
ERROR: No such service: tg_api
```
**原因**：docker-compose.yml 中的服务名称与实际容器名称不匹配

**实际配置**：
- 服务名称：`api`（在 docker-compose.yml 中）
- 容器名称：`tg_api`（通过 container_name 指定）

**解决方案**：使用服务名称而不是容器名称
```bash
# ❌ 错误
docker-compose restart tg_api

# ✓ 正确
docker-compose restart api
```

### 2. NPM 容器配置问题
```
OCI runtime exec failed: exec: "wget": executable file not found in $PATH
```
**原因**：npm（Nginx Proxy Manager）容器中缺少 wget，无法执行健康检查

**解决方案**：使用 curl 代替 wget（npm 容器基于 Alpine，有 curl）
```bash
docker exec npm curl -s http://tg_api:3000/health
```

---

## ✅ 快速修复步骤

### 第 1 步：验证容器正在运行
```bash
cd /opt/telegram-monitor

# 查看所有容器
docker-compose ps

# 应该看到：
# NAME           IMAGE              STATUS
# tg_mongo       mongo:6            Up (healthy)
# tg_api         api_latest         Up (health: starting)
# tg_listener    telethon_latest    Up
# tg_web         nginx:alpine       Up (health: starting)
```

### 第 2 步：查看后端日志（已确认正常）
```bash
docker-compose logs api --tail 20

# 看到以下输出表示成功：
# ✅ API 服务运行在端口 3000
# ✅ MongoDB 已连接
```

### 第 3 步：使用正确的命令重启容器
```bash
# 重启后端容器
docker-compose restart api

# 等待容器启动
sleep 5

# 查看日志
docker-compose logs api --tail 20
```

### 第 4 步：测试 API 健康状态
```bash
# 方法 1：直接从主机测试
curl http://localhost:3000/health

# 方法 2：从容器内测试
docker exec tg_api curl -s http://localhost:3000/health

# 方法 3：从 npm 容器测试（如果有）
docker exec npm curl -s http://tg_api:3000/health

# 期望响应：
# {"status":"ok","time":"2025-12-04T..."}
```

### 第 5 步：验证 NPM 反向代理配置
```bash
# 查看当前 NPM 配置（如果使用内部 Nginx）
docker exec tg_web cat /etc/nginx/conf.d/default.conf

# 检查是否指向正确的上游服务
# 应该看到：proxy_pass http://api:3000/api/
```

---

## 🔧 常见命令参考

| 操作 | 命令 |
|------|------|
| 重启所有容器 | `docker-compose restart` |
| 重启特定服务 | `docker-compose restart api` |
| 查看服务日志 | `docker-compose logs api --tail 50` |
| 查看实时日志 | `docker-compose logs -f api` |
| 进入容器 | `docker exec -it tg_api /bin/sh` |
| 健康检查 | `docker ps` (STATUS 列显示健康状态) |

---

## 🚀 NPM 反向代理配置

如果您使用外部 NPM（Nginx Proxy Manager），需要：

**当前（错误）配置：**
- Forward Hostname/IP: `tg_web` 或 `tg_web.tg-network`
- Forward Port: `80`

**正确配置：**
- Forward Hostname/IP: `tg_api` 或 `172.25.0.3`
- Forward Port: `3000`

---

## 📊 系统状态检查清单

- [ ] Docker 服务运行中
- [ ] 所有容器状态为 "Up"
- [ ] tg_api 健康检查通过
- [ ] MongoDB 已连接
- [ ] 可以访问 http://your-server:3000/health
- [ ] 可以访问 http://your-domain/health（通过 NPM）

---

## 📞 如果仍有问题

### 完全重启服务
```bash
cd /opt/telegram-monitor

# 停止所有服务
docker-compose down

# 清理旧容器
docker-compose ps -a | grep telegram-monitor || true

# 重新启动
docker-compose up -d

# 等待启动完成
sleep 10

# 查看状态
docker-compose ps
docker-compose logs api --tail 20
```

### 检查系统日志
```bash
# 查看 Docker 守护进程日志
journalctl -u docker -n 50

# 查看所有容器错误
docker-compose logs --tail 100 | grep -i error
```

### 重新构建镜像
```bash
# 强制重新构建（修复依赖问题）
docker-compose build --no-cache

# 重新启动
docker-compose up -d
```

---

## 💾 备份和恢复

### 备份数据库
```bash
docker exec tg_mongo mongodump --out /tmp/backup
docker cp tg_mongo:/tmp/backup ./backup-$(date +%Y%m%d)
```

### 恢复数据库
```bash
docker cp ./backup-20251204 tg_mongo:/tmp/
docker exec tg_mongo mongorestore /tmp/backup
```

---

## 🔐 安全检查

- [ ] 修改了默认密码（admin/admin123）
- [ ] JWT_SECRET 已设置为强密钥
- [ ] CORS 白名单已配置
- [ ] 启用了 HTTPS（推荐）
- [ ] 定期备份数据库

---

## 📝 下一步

1. **立即**：运行 `docker-compose ps` 验证容器状态
2. **测试**：访问 http://your-server:3000 确认后端工作
3. **配置**：更新 NPM 反向代理指向正确的上游服务
4. **安全**：修改默认密码
5. **监控**：定期检查日志 `docker-compose logs api`
