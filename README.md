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

手动：

docker compose down
rm -rf /opt/telegram-monitor
cd /opt
git clone https://github.com/1490293430/tgjiankong.git telegram-monitor
cd telegram-monitor
docker compose up -d --build



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

## 🔑 获取方式

### 1. 获取 Telegram API_ID 和 API_HASH

这是使用本系统**必须**的配置项，用于连接 Telegram API。

**步骤：**

1. 访问 [https://my.telegram.org/apps](https://my.telegram.org/apps)
2. 使用你的 Telegram 账号登录
3. 点击 **"Create new application"** 或 **"创建新应用"**
4. 填写应用信息：
   - **App title**（应用名称）：任意名称，如 "Telegram Monitor"
   - **Short name**（短名称）：任意短名称，如 "tgmonitor"
   - **Platform**（平台）：选择 **Other**（其他）
   - **Description**（描述）：可选，任意描述
5. 创建完成后，你会看到：
   - **api_id**：一串数字（如 `12345678`）
   - **api_hash**：一串字母数字组合（如 `abcdef1234567890abcdef1234567890`）

**⚠️ 重要提示：**
- 请妥善保管你的 `api_id` 和 `api_hash`，不要泄露给他人
- 每个 Telegram 账号只能创建一个应用
- 如果忘记或丢失，可以重新登录查看

### 2. 获取频道 ID

用于指定要监控的 Telegram 频道或群组。

**方法一：使用机器人（推荐）**

1. 在 Telegram 中找到 [@userinfobot](https://t.me/userinfobot) 或 [@getidsbot](https://t.me/getidsbot)
2. 向机器人转发一条来自目标频道/群组的消息
3. 机器人会返回该频道/群组的 ID（通常是负数，如 `-1001234567890`）

**方法二：从频道链接获取**

- 频道链接格式：`https://t.me/channelname`
- 频道 ID 可能是 `@channelname` 或数字 ID（如 `-1001234567890`）
- 公开频道通常可以直接使用 `@channelname`

**方法三：从频道信息获取**

1. 打开目标频道
2. 点击频道名称查看详情
3. 如果频道是公开的，可以看到用户名（如 `@channelname`）
4. 如果是私有频道，需要使用方法一获取数字 ID

**💡 提示：**
- 留空频道 ID 将监控所有可访问的频道和群组
- 支持同时监控多个频道，每行一个 ID

### 3. 获取 Telegram 用户 ID（用于告警）

用于接收告警消息的目标用户。

**方法一：使用机器人（推荐）**

1. 在 Telegram 中找到 [@userinfobot](https://t.me/userinfobot)
2. 向机器人发送任意消息
3. 机器人会返回你的用户 ID（一串数字，如 `123456789`）

**方法二：使用 @getidsbot**

1. 在 Telegram 中找到 [@getidsbot](https://t.me/getidsbot)
2. 向机器人发送任意消息
3. 机器人会返回你的用户 ID

**💡 提示：**
- 用户 ID 是纯数字，不需要 `@` 符号
- 也可以使用用户名（如 `@username`），但需要确保该用户已启动机器人

### 4. 获取 OpenAI API Key（可选，用于 AI 分析）

如果启用 AI 分析功能，需要配置 OpenAI API Key。

**步骤：**

1. 访问 [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. 登录或注册 OpenAI 账号
3. 点击 **"Create new secret key"** 或 **"创建新的密钥"**
4. 填写密钥名称（可选）
5. 复制生成的 API Key（格式如 `sk-...`，只显示一次，请妥善保存）

**⚠️ 重要提示：**
- API Key 只显示一次，请立即复制保存
- 如果忘记，需要删除旧密钥并创建新密钥
- 使用 OpenAI API 会产生费用，请查看 [定价页面](https://openai.com/pricing)
- 支持使用其他兼容 OpenAI API 的服务（如 Azure OpenAI、本地部署的模型等）

**💡 提示：**
- 如果不使用 AI 分析功能，可以不配置此项
- 可以在系统配置中随时启用或禁用 AI 分析

### 5. 生成 JWT_SECRET（安全密钥）

`JWT_SECRET` 用于签名和验证 JWT token，确保用户认证安全。**生产环境必须配置**。

**⚠️ 重要提示：**
- 如果不设置 `JWT_SECRET`，系统会自动生成一次性随机密钥
- 重启服务后，旧的 token 将失效，用户需要重新登录
- 生产环境强烈建议设置固定的强随机密钥

**生成方法（任选一种）：**

**方法一：使用 OpenSSL（推荐，Linux/macOS）**

```bash
openssl rand -base64 48
```

**方法二：使用 Python**

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

**方法三：使用 Node.js**

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

**方法四：使用 PowerShell（Windows）**

```powershell
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Minimum 0 -Maximum 256 }))
```

**配置方法：**

生成后，将密钥添加到 `.env` 文件：

```env
JWT_SECRET=你生成的密钥
```

**🔄 更新生效：**

配置后执行 `docker compose up -d` 即可自动生效，无需额外操作。详见"升级到新版本"章节。

**💡 提示：**
- 密钥长度建议至少 32 字符
- 不要使用简单密码或可预测的值
- 妥善保管密钥，泄露后可能导致安全风险
- ⚠️ 如果之前未设置过 `JWT_SECRET`，首次设置后所有用户需要重新登录

### 6. 生成 INTERNAL_API_TOKEN（内部 API 令牌）

`INTERNAL_API_TOKEN` 用于保护内部 API 接口（`/api/internal/*`），防止未授权访问。

**⚠️ 重要提示：**
- 如果不设置 `INTERNAL_API_TOKEN`，内部 API 将仅依赖网络隔离（仅允许内网访问）
- 生产环境强烈建议设置强随机令牌以提高安全性

**生成方法（任选一种）：**

**方法一：使用 OpenSSL（推荐，Linux/macOS）**

```bash
openssl rand -hex 32
```

**方法二：使用 Python**

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

**方法三：使用 Node.js**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**方法四：使用 PowerShell（Windows）**

```powershell
-join ((48..57) + (65..70) | Get-Random -Count 64 | ForEach-Object {[char]$_})
```

**配置方法：**

生成后，将令牌添加到 `.env` 文件：

```env
INTERNAL_API_TOKEN=你生成的令牌
```

**🔄 更新生效：**

配置后执行 `docker compose up -d` 即可自动生效，无需额外操作。详见"升级到新版本"章节。

**💡 提示：**
- 令牌长度建议至少 32 字符（64 个十六进制字符）
- 不要使用简单密码或可预测的值
- 妥善保管令牌，泄露后可能导致内部 API 被未授权访问
- 内部服务调用时需要在请求头中携带：`X-Internal-Token: 你的令牌`
- ✅ 首次设置或更新后，会自动应用到所有内部服务调用

## 📖 使用指南

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

**⚠️ 环境变量更新注意事项：**

如果在 `.env` 文件中配置了 `JWT_SECRET` 和 `INTERNAL_API_TOKEN`，执行上述更新命令后：

1. **环境变量会自动生效** - Docker Compose 会自动读取 `.env` 文件中的环境变量
2. **无需额外操作** - `docker compose up -d` 会重新加载环境变量并重启容器
3. **对现有项目的影响：**
   - **JWT_SECRET**：
     - ✅ 如果之前已设置过 `JWT_SECRET`，更新后继续使用，**不会影响已登录用户**
     - ⚠️ 如果之前未设置（使用自动生成的临时密钥），现在首次设置后，**所有用户需要重新登录**（因为旧的 token 会失效）
   - **INTERNAL_API_TOKEN**：
     - ✅ 如果之前已设置过，更新后继续使用，**不影响服务**
     - ✅ 如果之前未设置（仅依赖内网隔离），现在首次设置后，**会增强安全性**，不影响现有功能
     - ⚠️ 如果修改了已存在的 `INTERNAL_API_TOKEN`，需要确保所有内部服务调用都使用新的 token

**最佳实践：**

1. **首次部署时**就设置这两个值，避免后续更新导致用户需要重新登录：
   ```bash
   # 生成并添加到 .env
   echo "JWT_SECRET=$(openssl rand -base64 48)" >> .env
   echo "INTERNAL_API_TOKEN=$(openssl rand -hex 32)" >> .env
   ```

2. **更新时检查** `.env` 文件是否存在且包含这两个值：
   ```bash
   cd /opt/telegram-monitor
   # 如果 .env 不存在，从 .env.example 复制
   [ ! -f .env ] && cp .env.example .env
   # 检查并生成缺失的值
   if ! grep -q "^JWT_SECRET=" .env || grep -q "^JWT_SECRET=change-this" .env; then
     sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -base64 48)|" .env || \
     echo "JWT_SECRET=$(openssl rand -base64 48)" >> .env
   fi
   if ! grep -q "^INTERNAL_API_TOKEN=" .env || grep -q "^INTERNAL_API_TOKEN=change-this" .env; then
     sed -i "s|^INTERNAL_API_TOKEN=.*|INTERNAL_API_TOKEN=$(openssl rand -hex 32)|" .env || \
     echo "INTERNAL_API_TOKEN=$(openssl rand -hex 32)" >> .env
   fi
   # 然后执行更新
   git pull origin main
   docker compose build
   docker compose up -d
   ```

3. **验证更新**：
   ```bash
   # 查看容器日志，确认环境变量已加载
   docker compose logs api | grep -i "JWT_SECRET\|INTERNAL_API_TOKEN"
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
| `JWT_SECRET` | JWT 签名密钥（详见"获取方式"章节） | ⚠️ 建议设置 | 自动生成（重启后失效） |
| `INTERNAL_API_TOKEN` | 内部 API 访问令牌（详见"获取方式"章节） | ⚠️ 建议设置 | 仅内网访问 |
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
