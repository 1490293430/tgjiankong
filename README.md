# 🐳 Telegram 监控系统 - Docker 一键部署

[![Docker](https://img.shields.io/badge/Docker-Ready-blue)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

一个功能完整的 Telegram 消息监控系统，支持关键词监控、智能告警、AI 分析、日志记录等功能。使用 Docker 一键部署，开箱即用。

## ✨ 功能特性

- 🔍 **关键词监控** - 支持普通关键词、正则表达式匹配
- 🤖 **AI 智能分析** - 基于 OpenAI API 的消息情感分析和摘要生成
- 📱 **多渠道告警** - Telegram、邮件、Webhook 多种告警方式
- 📊 **数据统计** - 实时统计消息数量、告警次数、AI 分析统计
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

### 环境要求

- Linux 服务器（Debian/Ubuntu 推荐）
- 至少 1GB RAM
- 至少 5GB 可用磁盘空间
- 网络可访问 Telegram API

### 一键部署

**无需 GitHub Token（公开仓库）：**

```bash
sudo bash <(curl -fsSL https://raw.githubusercontent.com/1490293430/tgjiankong/main/install.sh)


一键卸载：
sudo bash uninstall.sh
```

**使用环境变量（推荐）：**

```bash
API_ID=你的API_ID \
API_HASH=你的API_HASH \
sudo bash <(curl -fsSL https://raw.githubusercontent.com/1490293430/tgjiankong/main/install.sh)
```

**使用命令行参数：**

```bash
sudo bash <(curl -fsSL https://raw.githubusercontent.com/1490293430/tgjiankong/main/install.sh) \
  -i 你的API_ID \
  -s 你的API_HASH \
  -d /opt/telegram-monitor
```

> 💡 **提示：** 脚本会自动安装 Docker（如未安装）、下载代码、构建镜像并启动所有服务。

### 首次启动

1. **访问后台**
   - 部署完成后，访问 `http://你的服务器IP:5555`
   - 默认用户名：`admin`
   - 默认密码：`admin123`
   - ⚠️ **第一时间修改默认密码！**

2. **配置 Telegram API**
   - 进入 **⚙️ 配置** 标签
   - 填写 `API_ID` 和 `API_HASH`（从 https://my.telegram.org/apps 获取）
   - 点击 **💾 保存配置**

3. **首次登录 Telegram**
   - 保存配置后，查看 Telethon 容器日志：
     ```bash
     docker compose logs telethon -f
     ```
   - 如果显示需要登录，执行交互式登录：
     ```bash
     cd /opt/telegram-monitor
     docker compose exec telethon python -c "from telethon import TelegramClient; import os; c=TelegramClient('/app/session/telegram', int(os.getenv('API_ID')), os.getenv('API_HASH')); c.start(); print('登录成功'); c.disconnect()"
     ```
   - 按提示输入你的 Telegram 账号和验证码
   - 登录成功后，session 会自动保存，无需每次都登录

4. **配置监控规则**
   - 添加 **监控频道**（频道 ID，留空则监控所有可访问的频道）
   - 添加 **监控关键词**（每行一个）
   - 添加 **告警关键词**（匹配到这些词会触发告警）
   - 可选：添加 **正则表达式** 规则
   - 可选：勾选 **记录所有消息**
   - 点击 **💾 保存配置**

5. **配置告警方式**
   - **Telegram 告警**：设置告警目标（你的用户 ID 或 @username）
   - **邮件告警**（可选）：配置 SMTP 参数
   - **Webhook 告警**（可选）：提供接收 URL
   - 点击 **💾 保存配置**

6. **配置 AI 分析（可选）**
   - 在 **🤖 AI 分析** 标签中配置
   - 填写 OpenAI API Key
   - 选择分析触发方式（定时触发或消息数量触发）
   - 配置分析提示词和发送方式
   - 点击 **💾 保存配置**

## 📖 使用指南

### 获取频道 ID

- 方法一：使用 [@userinfobot](https://t.me/userinfobot) 转发频道消息获取
- 方法二：使用 [@getidsbot](https://t.me/getidsbot) 获取
- 方法三：频道链接格式 `https://t.me/channelname`，ID 通常是 `@channelname` 或负数（如 `-1001234567890`）

### 配置 AI 分析

AI 分析功能支持以下触发方式：

1. **定时触发**：每隔指定分钟数自动分析未分析的消息
2. **消息数量触发**：当未分析消息达到指定数量时自动分析
3. **固定用户触发**：当指定用户发送消息时立即分析

每种触发方式都可以配置专用的提示词，实现不同的分析需求。

### 查看日志和统计

- **📊 仪表盘**：查看实时统计信息
- **📝 日志**：查看所有监控记录，支持关键词搜索
- **🤖 AI 分析**：查看 AI 分析摘要和统计

## 🔧 常用命令

```bash
cd /opt/telegram-monitor

# 查看服务状态
docker compose ps

# 查看实时日志
docker compose logs -f api
docker compose logs -f telethon

# 重启服务
docker compose restart

# 重启特定服务
docker compose restart api
docker compose restart telethon

# 停止服务
docker compose down

# 停止并删除数据（危险！）
docker compose down -v
```

## 🔧 高级配置

### 修改 Web 端口

编辑 `.env` 文件：

```env
WEB_PORT=8080
```

然后重启服务：

```bash
docker compose down
docker compose up -d
```

### 数据持久化

所有数据都保存在以下目录：

```
/opt/telegram-monitor/
├── data/
│   ├── mongo/          # MongoDB 数据库文件
│   └── session/        # Telegram session 文件
├── logs/               # 应用日志
│   ├── api/
│   └── telethon/
└── backend/
    └── config.json     # 配置文件（包含所有配置）
```

**备份数据：**
```bash
# 使用自动备份脚本（推荐）
bash backup.sh

# 或手动备份
tar -czf backup_$(date +%Y%m%d).tar.gz data/ backend/config.json .env
```

**恢复数据：**
```bash
# 使用自动恢复脚本
bash restore.sh

# 或手动恢复
tar -xzf backup_YYYYMMDD.tar.gz
```

### 升级到新版本

```bash
cd /opt/telegram-monitor
git pull origin main
docker compose build
docker compose up -d
```

## 🛠️ 故障排查

### Telethon 无法连接

**问题：** 日志显示连接超时或认证失败

**解决方案：**
1. 检查 `.env` 中的 `API_ID` 和 `API_HASH` 是否正确
2. 确认网络可以访问 Telegram 服务器
3. 删除 session 文件重新登录：
   ```bash
   docker compose down
   rm -rf data/session/*
   docker compose up -d
   ```

### MongoDB 连接失败

**问题：** API 日志显示 MongoDB 连接错误

**解决方案：**
```bash
# 检查 MongoDB 服务状态
docker compose ps mongo

# 查看 MongoDB 日志
docker compose logs mongo

# 重启 MongoDB
docker compose restart mongo
```

### Web 界面无法访问

**问题：** 浏览器显示无法连接

**解决方案：**
1. 检查服务是否正常运行：
   ```bash
   docker compose ps
   ```
2. 检查端口是否被占用：
   ```bash
   netstat -tulpn | grep :5555
   ```
3. 查看 Web 服务日志：
   ```bash
   docker compose logs web
   ```

### AI 分析功能不工作

**问题：** AI 分析未执行或失败

**解决方案：**
1. 检查 AI 分析配置是否已启用
2. 检查 OpenAI API Key 是否正确
3. 查看 API 日志中的错误信息：
   ```bash
   docker compose logs api | grep -i "ai\|openai"
   ```
4. 检查是否达到了触发条件（定时或消息数量）

## 🔐 安全建议

1. **修改默认密码** - 首次登录后立即修改
2. **使用强 JWT_SECRET** - 安装脚本会自动生成，无需手动配置
3. **启用防火墙** - 仅开放必要端口（如 5555）
4. **定期备份** - 使用 `bash backup.sh` 自动备份，或手动备份 `data/` 目录和 `backend/config.json`
5. **使用 HTTPS** - 生产环境建议配置 SSL 证书（可使用 Nginx Proxy Manager）
6. **限制访问** - 配置 IP 白名单或使用 VPN 访问

## 📝 环境变量说明

| 变量名 | 说明 | 必填 | 默认值 |
|--------|------|------|--------|
| `API_ID` | Telegram API ID | ✅ | - |
| `API_HASH` | Telegram API Hash | ✅ | - |
| `JWT_SECRET` | JWT 签名密钥 | ✅ | 自动生成 |
| `WEB_PORT` | Web 服务端口 | ❌ | 5555 |
| `MONGO_URL` | MongoDB 连接地址 | ❌ | mongodb://mongo:27017/tglogs |
| `PORT` | API 服务端口 | ❌ | 3000 |

## 🤝 常见问题 (FAQ)

**Q: 如何获取 Telegram API_ID 和 API_HASH？**  
A: 访问 https://my.telegram.org/apps 登录后创建应用即可获取

**Q: 如何获取频道 ID？**  
A: 转发频道消息给 @userinfobot 或 @getidsbot，或使用频道链接

**Q: 可以同时监控多个账号吗？**  
A: 当前版本仅支持单账号，多账号支持将在后续版本提供

**Q: 支持监控私聊消息吗？**  
A: 支持，只要你的账号可以访问该对话

**Q: AI 分析使用哪个模型？**  
A: 默认使用 `gpt-3.5-turbo`，可在配置中修改为其他 OpenAI 兼容的模型

**Q: 邮件告警怎么配置？**  
A: 
- QQ 邮箱：SMTP 服务器 `smtp.qq.com`，端口 `465`，密码用授权码
- 163 邮箱：SMTP 服务器 `smtp.163.com`，端口 `465`，密码用授权码
- Gmail：SMTP 服务器 `smtp.gmail.com`，端口 `587`，密码用应用专用密码
- 配置完成后点击"📩 发送测试告警"按钮验证

**Q: 如何重置密码？**  
A: 停止服务后删除 `backend/config.json`，重启服务后使用默认密码 `admin123` 登录

**Q: 数据会丢失吗？**  
A: 不会，所有数据都保存在 `data/` 目录中，只要不删除该目录，数据就不会丢失

## 📄 开源协议

MIT License - 详见 [LICENSE](LICENSE) 文件

## 🙏 致谢

- [Telethon](https://github.com/LonamiWebs/Telethon) - Telegram 客户端库
- [Express.js](https://expressjs.com/) - Node.js Web 框架
- [MongoDB](https://www.mongodb.com/) - NoSQL 数据库
- [Docker](https://www.docker.com/) - 容器化平台

## 📮 贡献

欢迎提交 Issue 和 Pull Request！

---

**⭐ 如果这个项目对你有帮助，请给个 Star 支持一下！**
