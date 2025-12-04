# 🔧 服务器问题修复方案

## 📋 问题总结

根据您在服务器上的日志，遇到了以下问题：

### 1. ❌ "No such service: tg_api"
```bash
ERROR: No such service: tg_api
```

**原因**：docker-compose.yml 中的服务名称是 `api`，不是 `tg_api`
- `api` = docker-compose 中定义的服务名称
- `tg_api` = container_name 指定的容器名称

**✓ 修复**：使用正确的服务名称
```bash
# ❌ 错误
docker-compose restart tg_api

# ✓ 正确
docker-compose restart api
```

### 2. ❌ "wget: executable file not found"
```bash
OCI runtime exec failed: exec: "wget": executable file not found in $PATH
```

**原因**：健康检查配置使用 wget，但 Alpine 容器中没有预装

**✓ 修复**：已更新 docker-compose.yml 使用 curl（所有 Alpine 镜像都有 curl）

---

## 🚀 立即执行的步骤

### 步骤 1：拉取最新修复代码
```bash
ssh root@your-server-ip
cd /opt/telegram-monitor
git pull origin main
```

**新增文件**：
- `QUICK_REFERENCE.md` - 快速参考卡
- `DEPLOYMENT_TROUBLESHOOTING.md` - 详细故障排除
- `fix-deployment.sh` - 自动诊断脚本
- 更新：`docker-compose.yml`（修复 wget → curl）
- 更新：`install.sh`（改进部署）

### 步骤 2：重新部署容器
```bash
# 停止现有容器
docker-compose down

# 使用最新配置启动
docker-compose build --no-cache
docker-compose up -d

# 等待启动完成
sleep 10

# 检查状态
docker-compose ps
```

### 步骤 3：验证服务正常运行
```bash
# 查看后端日志
docker-compose logs api --tail 20

# 应该看到：
# ✅ API 服务运行在端口 3000
# ✅ MongoDB 已连接

# 测试 API
docker exec tg_api curl -s http://localhost:3000/health
```

### 步骤 4：测试通过反向代理访问（NPM）
```bash
# 测试 NPM 连接
curl https://tg.970108.xyz/health

# 如果仍然出现 404，检查 NPM 配置：
# Forward Hostname/IP: tg_api（或 api）
# Forward Port: 3000
```

---

## 📝 改进清单

### docker-compose.yml 改进
✅ 将健康检查从 `wget` 改为 `curl`（第 40 行）
✅ 添加 `NODE_ENV=production` 环境变量
✅ 将 web 容器健康检查也改为 curl

### install.sh 改进
✅ 添加 Docker 构建步骤
✅ 改进服务启动验证
✅ 添加中文日志输出
✅ 改进错误提示

### 新增文件
✅ `QUICK_REFERENCE.md` - 快速参考
✅ `DEPLOYMENT_TROUBLESHOOTING.md` - 详细指南
✅ `fix-deployment.sh` - 自动诊断工具

---

## 🔍 使用诊断脚本

如果问题未完全解决，可以使用新的诊断脚本：

```bash
# 复制脚本（如果还没有）
wget https://raw.githubusercontent.com/1490293430/tgjiankong/main/fix-deployment.sh
chmod +x fix-deployment.sh

# 运行诊断
./fix-deployment.sh

# 脚本会：
# 1. 检查 Docker 状态
# 2. 显示容器状态
# 3. 检查服务健康
# 4. 测试网络连接
# 5. 清理未使用资源
# 6. 提供修复建议
```

---

## ✅ 完整修复步骤（从头开始）

如果一切都出问题了，使用完全重建：

```bash
cd /opt/telegram-monitor

# 第 1 步：备份数据（重要！）
docker exec tg_mongo mongodump --out /tmp/backup
docker cp tg_mongo:/tmp/backup ./backup-$(date +%Y%m%d)

# 第 2 步：拉取最新代码
git pull origin main

# 第 3 步：完全停止并清理
docker-compose down -v

# 第 4 步：重新构建镜像
docker-compose build --no-cache

# 第 5 步：启动所有服务
docker-compose up -d

# 第 6 步：等待启动
sleep 15

# 第 7 步：验证
docker-compose ps
docker-compose logs api --tail 30
```

---

## 🔧 常用命令速查表

```bash
# 查看容器状态
docker-compose ps

# 查看实时日志
docker-compose logs -f api

# 查看历史日志
docker-compose logs api --tail 50

# 重启服务
docker-compose restart api

# 重启所有服务
docker-compose restart

# 停止服务
docker-compose down

# 启动服务
docker-compose up -d

# 进入容器
docker exec -it tg_api /bin/sh

# 测试后端
docker exec tg_api curl -s http://localhost:3000/health

# 检查网络
docker network inspect telegram-monitor_tg-network

# 查看 MongoDB
docker-compose logs mongo --tail 20

# 监控资源使用
docker stats
```

---

## 📊 修复前后对比

### 修复前
| 操作 | 结果 |
|------|------|
| `docker-compose restart tg_api` | ❌ ERROR: No such service |
| 健康检查 | ❌ wget: command not found |
| `docker exec npm wget ...` | ❌ No wget in container |

### 修复后
| 操作 | 结果 |
|------|------|
| `docker-compose restart api` | ✅ Restarting tg_api |
| 健康检查 | ✅ curl 自动执行 |
| `docker exec tg_api curl ...` | ✅ {"status":"ok",...} |

---

## 🆘 如果仍有问题

### 收集诊断信息
```bash
# 系统信息
docker version > /tmp/diag.txt
docker-compose version >> /tmp/diag.txt

# 容器状态
docker ps -a >> /tmp/diag.txt
docker-compose ps >> /tmp/diag.txt

# 日志
docker-compose logs --tail 200 > /tmp/logs.txt

# 网络
docker network inspect telegram-monitor_tg-network > /tmp/network.txt

# 导出诊断文件
scp root@server:/tmp/diag.txt ./
scp root@server:/tmp/logs.txt ./
```

### NPM 配置问题

如果通过 NPM 仍无法访问：

1. 进入 NPM 管理界面
2. 编辑 tg.970108.xyz 代理配置
3. 确保：
   - Forward Hostname/IP: `tg_api` 或 `api`
   - Forward Port: `3000`
   - Scheme: `http://`（不是 https）
4. 测试连接

---

## 📚 相关文档

- [快速参考卡](QUICK_REFERENCE.md) - 常用命令和故障排除
- [详细故障排除](DEPLOYMENT_TROUBLESHOOTING.md) - 完整问题解决方案
- [部署指南](DEPLOY_DEBIAN.md) - 完整部署步骤
- [README](README.md) - 项目概述

---

## 🎯 下一步行动

1. **立即**：
   ```bash
   cd /opt/telegram-monitor
   git pull origin main
   docker-compose pull
   docker-compose restart
   ```

2. **验证**：
   ```bash
   docker-compose ps
   docker-compose logs api --tail 20
   curl http://localhost:3000/health
   ```

3. **测试**：
   访问 https://tg.970108.xyz 并登录

4. **安全**：
   修改默认密码

---

**最后更新**：2025-12-04
**版本**：2.1（修复 wget 问题，优化安装脚本）
**Git Commit**：2f9c56f
