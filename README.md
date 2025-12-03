# 🐳 Telegram 监控系统 - Docker 一键部署

[![Docker](https://img.shields.io/badge/Docker-Ready-blue)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

一个功能完整的 Telegram 消息监控系统，支持关键词监控、智能告警、日志记录等功能。使用 Docker 一键部署，开箱即用。

## ✨ 功能特性

- 🔍 **关键词监控** - 支持普通关键词、正则表达式匹配
- 📱 **多渠道告警** - Telegram、邮件、Webhook 多种告警方式
- 📊 **数据统计** - 实时统计消息数量、告警次数
- 📝 **日志记录** - MongoDB 存储所有监控记录，支持搜索和分页
- 🔐 **安全认证** - JWT token 认证，密码加密存储
- 🎨 **现代界面** - 响应式设计，支持移动端访问
- 🐳 **Docker 部署** - 一键启动所有服务，无需复杂配置

## 📋 系统架构

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Nginx     │────▶│  Node.js    │────▶│  MongoDB    │
│  (Web UI)   │     │   (API)     │     │  (Database) │
└─────────────┘     └─────────────┘     └─────────────┘
                            ▲
                            │
                    ┌───────┴────────┐
                    │  Telethon      │
                    │  (Listener)    │
                    └────────────────┘
```

## 🚀 快速开始

### 前置要求

- Docker 20.10+
- Docker Compose 1.29+
- Telegram API 凭证（从 https://my.telegram.org/apps 获取）

### 1. 克隆或下载项目

```bash
git clone <your-repo-url>
cd telegram-monitor
```

### 2. 配置环境变量

复制环境变量模板并编辑：

```bash
copy .env.example .env
```

编辑 `.env` 文件，填入你的 Telegram API 配置：

```env
API_ID=你的API_ID
API_HASH=你的API_HASH
JWT_SECRET=自定义一个随机密钥
WEB_PORT=80
```

> **获取 Telegram API 凭证：**
> 1. 访问 https://my.telegram.org/apps
> 2. 使用你的手机号登录
> 3. 创建应用，获取 `api_id` 和 `api_hash`

### 3. 启动服务

```bash
docker-compose up -d
```

等待所有服务启动完成（首次启动需要下载镜像，约 3-5 分钟）。

### 4. 首次登录 Telegram

由于 Telethon 需要登录 Telegram 账号，首次启动需要进行验证：

```bash
# 查看 telethon 服务日志
docker-compose logs -f telethon
```

按照提示输入手机号和验证码：

```bash
# 进入容器交互模式
docker exec -it tg_listener python monitor.py
```

或者在主机上运行验证脚本（推荐）：

```bash
# Windows PowerShell
docker-compose exec telethon python -c "from telethon import TelegramClient; import os; client = TelegramClient('/app/session/telegram', int(os.getenv('API_ID')), os.getenv('API_HASH')); client.start()"
```

验证完成后，session 文件会保存在 `data/session/` 目录中。

### 5. 访问 Web 界面

打开浏览器访问：

```
http://localhost
```

**默认登录信息：**
- 用户名：`admin`
- 密码：`admin123`

> ⚠️ **安全提示**：首次登录后请立即修改默认密码！

## 📖 使用指南

### 配置监控关键词

1. 登录后进入 **"⚙️ 配置"** 标签
2. 在 **"普通关键词"** 中添加要监控的词（每行一个）
3. 在 **"告警关键词"** 中添加需要触发告警的词
4. 可选：添加正则表达式规则实现更复杂的匹配
5. 点击 **"💾 保存配置"**

### 配置监控频道

1. 获取频道 ID：
   - 方法一：使用 [@userinfobot](https://t.me/userinfobot) 转发频道消息获取
   - 方法二：使用 [@getidsbot](https://t.me/getidsbot) 获取
2. 在配置页面的 **"监控频道"** 中添加频道 ID（每行一个）
3. 留空则监控所有可访问的频道

### 配置告警

支持三种告警方式：

#### 1. Telegram 告警（默认启用）
- 填写 **"Telegram 告警目标"**（你的用户 ID 或 @username）
- 触发告警时会自动发送到你的 Telegram

#### 2. 邮件告警
- 勾选 **"启用邮件告警"**
- 配置 SMTP 服务器信息
- 推荐使用 Gmail、Outlook 等支持 SMTP 的邮箱

#### 3. Webhook 告警
- 勾选 **"启用 Webhook 告警"**
- 填入你的 Webhook 接收地址
- 系统会以 POST 方式发送 JSON 数据

### 查看日志

进入 **"📝 日志"** 标签：
- 查看所有监控记录
- 支持关键词搜索
- 支持分页浏览
- 显示触发关键词、来源频道、消息内容等

## 🔧 高级配置

### 修改 Web 端口

编辑 `.env` 文件：

```env
WEB_PORT=8080
```

重启服务：

```bash
docker-compose down
docker-compose up -d
```

### 数据持久化

所有数据都保存在以下目录：

```
tgjiankong/
├── data/
│   ├── mongo/          # MongoDB 数据库文件
│   └── session/        # Telegram session 文件
├── logs/               # 应用日志
│   ├── api/
│   └── telethon/
└── backend/
    └── config.json     # 配置文件
```

**备份数据：** 只需备份 `data/` 和 `backend/config.json`

### 查看服务日志

```bash
# 查看所有服务日志
docker-compose logs

# 查看特定服务日志
docker-compose logs api
docker-compose logs telethon

# 实时跟踪日志
docker-compose logs -f telethon
```

### 重启服务

```bash
# 重启所有服务
docker-compose restart

# 重启特定服务
docker-compose restart telethon
```

### 停止服务

```bash
# 停止服务（保留数据）
docker-compose stop

# 完全删除服务（保留数据）
docker-compose down

# 删除服务和数据（危险操作！）
docker-compose down -v
```

## 🛠️ 故障排查

### Telethon 无法连接

**问题：** 日志显示连接超时或认证失败

**解决方案：**
1. 检查 `.env` 中的 `API_ID` 和 `API_HASH` 是否正确
2. 确认网络可以访问 Telegram 服务器
3. 删除 session 文件重新登录：
   ```bash
   docker-compose down
   rm -rf data/session/*
   docker-compose up -d
   ```

### MongoDB 连接失败

**问题：** API 日志显示 MongoDB 连接错误

**解决方案：**
```bash
# 检查 MongoDB 服务状态
docker-compose ps mongo

# 查看 MongoDB 日志
docker-compose logs mongo

# 重启 MongoDB
docker-compose restart mongo
```

### Web 界面无法访问

**问题：** 浏览器显示无法连接

**解决方案：**
1. 检查服务是否正常运行：
   ```bash
   docker-compose ps
   ```
2. 检查端口占用：
   ```bash
   # Windows
   netstat -ano | findstr :80
   ```
3. 查看 Nginx 日志：
   ```bash
   docker-compose logs web
   ```

### 无法登录后台

**问题：** 输入用户名密码后提示错误

**解决方案：**
1. 使用默认凭证：`admin` / `admin123`
2. 如果忘记密码，可以重置 `backend/config.json`：
   ```bash
   docker-compose down
   rm backend/config.json
   docker-compose up -d
   ```

## 📊 系统监控

### 健康检查

所有服务都配置了健康检查：

```bash
# 查看服务健康状态
docker-compose ps

# 输出示例
NAME          STATUS                    PORTS
tg_api        Up (healthy)             
tg_listener   Up
tg_mongo      Up (healthy)
tg_web        Up (healthy)             0.0.0.0:80->80/tcp
```

### 资源使用

```bash
# 查看容器资源使用情况
docker stats
```

## 🔐 安全建议

1. **修改默认密码** - 首次登录后立即修改
2. **使用强密码** - JWT_SECRET 使用随机字符串
3. **启用防火墙** - 仅开放必要端口
4. **定期备份** - 备份 data 目录和配置文件
5. **使用 HTTPS** - 生产环境建议配置 SSL 证书
6. **限制访问** - 使用 Nginx 配置 IP 白名单

### 配置 HTTPS（可选）

使用 Let's Encrypt 免费证书：

1. 安装 certbot
2. 获取证书
3. 修改 `nginx.conf` 添加 SSL 配置
4. 重启服务

详细教程：https://certbot.eff.org/

## 📝 环境变量说明

| 变量名 | 说明 | 必填 | 默认值 |
|--------|------|------|--------|
| `API_ID` | Telegram API ID | ✅ | - |
| `API_HASH` | Telegram API Hash | ✅ | - |
| `JWT_SECRET` | JWT 签名密钥 | ✅ | - |
| `WEB_PORT` | Web 服务端口 | ❌ | 80 |
| `MONGO_URL` | MongoDB 连接地址 | ❌ | mongodb://mongo:27017/tglogs |
| `PORT` | API 服务端口 | ❌ | 3000 |

## 🤝 常见问题 (FAQ)

**Q: 如何获取频道 ID？**
A: 转发频道消息给 @userinfobot 或 @getidsbot

**Q: 可以同时监控多个账号吗？**
A: 当前版本仅支持单账号，多账号支持将在后续版本提供

**Q: 支持监控私聊消息吗？**
A: 支持，只要你的账号可以访问该对话

**Q: 如何升级到新版本？**
A: 拉取最新代码，执行 `docker-compose down` 和 `docker-compose up -d --build`

**Q: 数据存储在哪里？**
A: MongoDB 数据在 `data/mongo/`，session 在 `data/session/`

## 📄 开源协议

MIT License - 详见 [LICENSE](LICENSE) 文件

## 🙏 致谢

- [Telethon](https://github.com/LonamiWebs/Telethon) - Telegram 客户端库
- [Express.js](https://expressjs.com/) - Node.js Web 框架
- [MongoDB](https://www.mongodb.com/) - NoSQL 数据库
- [Docker](https://www.docker.com/) - 容器化平台

## 📮 联系方式

如有问题或建议，欢迎提交 Issue 或 Pull Request。

---

**⭐ 如果这个项目对你有帮助，请给个 Star 支持一下！**
