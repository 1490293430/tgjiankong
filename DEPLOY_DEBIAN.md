# 🐧 Debian 12 部署指南

完整的 Telegram 监控系统在 Debian 12 上的部署教程。

## ⚡️ 极简一键部署（Git 说明）

公开仓库（无需 Token）：

```bash
API_ID=你的API_ID \
API_HASH=你的API_HASH \
bash <(curl -fsSL https://raw.githubusercontent.com/1490293430/tgjiankong/main/install.sh)
```

私有仓库（需 GitHub Token，仅 Contents: Read 权限）：

```bash
# 更安全的交互式，不在 history 留痕
read -rsp "GitHub Token: " GH_TOKEN; echo
read -rsp "Telegram API_ID: " API_ID; echo
read -rsp "Telegram API_HASH: " API_HASH; echo

curl -fsSL -H "Authorization: Bearer $GH_TOKEN" \
    https://raw.githubusercontent.com/1490293430/tgjiankong/main/install.sh \
    | GH_TOKEN="$GH_TOKEN" API_ID="$API_ID" API_HASH="$API_HASH" bash
```

可选：使用 SSH Deploy Key（免 Token 拉代码）
- 在服务器生成密钥：`ssh-keygen -t ed25519 -C "vps-deploy" -f ~/.ssh/id_ed25519 -N ""`
- 将公钥添加到 GitHub 仓库 Settings → Deploy keys（Read access）
- 运行安装脚本并指定 SSH 模式：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/1490293430/tgjiankong/main/install.sh) -m ssh -i 你的API_ID -s 你的API_HASH
```

完成后访问 `http://你的服务器IP`，默认账号 `admin` / `admin123`（请尽快修改）。

## 📋 系统要求

- Debian 12 (Bookworm)
- 至少 1GB RAM
- 10GB 可用磁盘空间
- Root 或 sudo 权限
- 稳定的网络连接

## 🚀 方式一：Docker 部署（推荐）

### 1. 安装 Docker

```bash
# 更新系统
sudo apt update
sudo apt upgrade -y

# 安装必要的依赖
sudo apt install -y ca-certificates curl gnupg lsb-release

# 添加 Docker 官方 GPG 密钥
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# 添加 Docker 仓库
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# 安装 Docker
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 启动 Docker 服务
sudo systemctl enable docker
sudo systemctl start docker

# 验证安装
sudo docker --version
sudo docker compose version
```

### 2. 配置用户权限（可选）

```bash
# 将当前用户添加到 docker 组，避免每次使用 sudo
sudo usermod -aG docker $USER

# 重新登录以使权限生效
# 或者执行：
newgrp docker
```

### 3. 下载项目

```bash
# 使用 git（推荐）
sudo apt install -y git
git clone <your-repo-url> /opt/telegram-monitor
cd /opt/telegram-monitor

# 或者直接上传文件到服务器
# 使用 scp, sftp 或其他方式
```

### 4. 配置环境变量

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑配置文件
nano .env
```

在 `.env` 文件中配置：

```env
# Telegram API 配置（必须）
API_ID=你的API_ID
API_HASH=你的API_HASH

# JWT 密钥（建议修改）
JWT_SECRET=your-random-secret-key-here

# Web 端口
WEB_PORT=80
```

> **获取 Telegram API 凭证：**
> 1. 访问 https://my.telegram.org/apps
> 2. 使用手机号登录
> 3. 创建应用获取 api_id 和 api_hash

### 5. 创建数据目录

```bash
# 创建必要的目录
mkdir -p data/mongo
mkdir -p data/session
mkdir -p logs/api
mkdir -p logs/telethon

# 设置权限
chmod -R 755 data logs
```

### 6. 启动服务

```bash
# 启动所有服务
sudo docker compose up -d

# 查看服务状态
sudo docker compose ps

# 查看日志
sudo docker compose logs -f
```

### 7. Telegram 账号登录

首次运行需要登录 Telegram 账号：

```bash
# 查看 telethon 服务日志
sudo docker compose logs -f telethon

# 如果需要交互式登录，执行：
sudo docker compose exec telethon python -c "
from telethon import TelegramClient
import os

api_id = int(os.getenv('API_ID'))
api_hash = os.getenv('API_HASH')

client = TelegramClient('/app/session/telegram', api_id, api_hash)
client.start()
print('登录成功！')
client.disconnect()
"
```

按照提示输入：
1. 手机号（国际格式，如：+8613800138000）
2. 验证码（Telegram 发送的）
3. 如果启用了两步验证，输入密码

### 8. 访问 Web 界面

```bash
# 获取服务器 IP
ip addr show | grep "inet " | grep -v 127.0.0.1

# 在浏览器中访问
http://服务器IP地址
```

**默认登录信息：**
- 用户名：`admin`
- 密码：`admin123`

> ⚠️ 登录后请立即修改密码！

### 9. 配置防火墙

```bash
# 安装 ufw
sudo apt install -y ufw

# 允许 SSH（重要！避免被锁在外面）
sudo ufw allow 22/tcp

# 允许 HTTP（Web 访问）
sudo ufw allow 80/tcp

# 如果使用 HTTPS
sudo ufw allow 443/tcp

# Docker 方式不需要开放其他端口
# MongoDB、API 都在内部网络中通信

# 启用防火墙
sudo ufw enable

# 查看状态
sudo ufw status numbered
```

**注意：** Docker 部署时，MongoDB (27017)、API (3000) 等端口都在容器内部网络，**不需要**对外开放。只需开放 Web 访问端口（80/443）。

## 🔧 方式二：手动部署（不推荐）

如果无法使用 Docker，可以手动部署各个组件。

### 1. 安装依赖

```bash
# 更新系统
sudo apt update
sudo apt upgrade -y

# 安装 Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# 安装 Python 3 和 pip
sudo apt install -y python3 python3-pip python3-venv

# 安装 MongoDB
sudo apt install -y gnupg curl
curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | \
   sudo gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor

echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] http://repo.mongodb.org/apt/debian bookworm/mongodb-org/7.0 main" | \
   sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list

sudo apt update
sudo apt install -y mongodb-org

# 启动 MongoDB
sudo systemctl enable mongod
sudo systemctl start mongod

# 安装 Nginx
sudo apt install -y nginx
```

### 2. 配置项目

```bash
# 创建项目目录
sudo mkdir -p /opt/telegram-monitor
cd /opt/telegram-monitor

# 上传项目文件到此目录
```

### 3. 配置 Backend

```bash
cd /opt/telegram-monitor/backend

# 安装依赖
npm install --production

# 创建配置文件
cp config.json.example config.json
nano config.json

# 创建 systemd 服务
sudo nano /etc/systemd/system/telegram-api.service
```

`telegram-api.service` 内容：

```ini
[Unit]
Description=Telegram Monitor API
After=mongod.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/telegram-monitor/backend
Environment="NODE_ENV=production"
Environment="MONGO_URL=mongodb://localhost:27017/tglogs"
Environment="JWT_SECRET=your-secret-key"
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable telegram-api
sudo systemctl start telegram-api
sudo systemctl status telegram-api
```

### 4. 配置 Telethon

```bash
cd /opt/telegram-monitor/telethon

# 创建虚拟环境
python3 -m venv venv
source venv/bin/activate

# 安装依赖
pip install -r requirements.txt

# 创建 systemd 服务
sudo nano /etc/systemd/system/telegram-listener.service
```

`telegram-listener.service` 内容：

```ini
[Unit]
Description=Telegram Monitor Listener
After=mongod.service telegram-api.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/telegram-monitor/telethon
Environment="API_ID=你的API_ID"
Environment="API_HASH=你的API_HASH"
Environment="MONGO_URL=mongodb://localhost:27017/tglogs"
Environment="API_URL=http://localhost:3000"
Environment="CONFIG_PATH=/opt/telegram-monitor/backend/config.json"
Environment="SESSION_PATH=/opt/telegram-monitor/data/session/telegram"
ExecStart=/opt/telegram-monitor/telethon/venv/bin/python monitor.py
Restart=always

[Install]
WantedBy=multi-user.target
```

首次启动需要手动登录：

```bash
cd /opt/telegram-monitor/telethon
source venv/bin/activate

# 设置环境变量
export API_ID=你的API_ID
export API_HASH=你的API_HASH
export SESSION_PATH=/opt/telegram-monitor/data/session/telegram
mkdir -p /opt/telegram-monitor/data/session

# 运行登录
python monitor.py
# 按提示输入手机号和验证码

# 登录完成后，启动服务
sudo systemctl enable telegram-listener
sudo systemctl start telegram-listener
sudo systemctl status telegram-listener
```

### 5. 配置 Nginx

```bash
# 设置文件权限
sudo chown -R www-data:www-data /opt/telegram-monitor/web

# 备份默认配置
sudo cp /etc/nginx/sites-available/default /etc/nginx/sites-available/default.bak

# 编辑配置
sudo nano /etc/nginx/sites-available/telegram-monitor
```

`telegram-monitor` 配置内容：

```nginx
server {
    listen 80;
    server_name _;
    
    # 增加请求体大小限制
    client_max_body_size 10M;
    
    # 前端静态文件
    location / {
        root /opt/telegram-monitor/web;
        try_files $uri $uri/ /index.html;
        
        location ~* \.(jpg|jpeg|png|gif|ico|css|js)$ {
            expires 7d;
            add_header Cache-Control "public, immutable";
        }
    }
    
    # API 代理
    location /api/ {
        proxy_pass http://localhost:3000/api/;
        proxy_http_version 1.1;
        
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
    
    # 健康检查
    location /health {
        proxy_pass http://localhost:3000/health;
        access_log off;
    }
    
    # Gzip 压缩
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml text/javascript application/x-javascript application/xml+rss application/json;
    
    # 安全头
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
}
```

启用配置：

```bash
# 创建软链接
sudo ln -s /etc/nginx/sites-available/telegram-monitor /etc/nginx/sites-enabled/

# 删除默认配置
sudo rm /etc/nginx/sites-enabled/default

# 测试配置
sudo nginx -t

# 重启 Nginx
sudo systemctl restart nginx
```

### 6. 配置防火墙（手动部署）

```bash
# 安装 ufw
sudo apt install -y ufw

# 允许 SSH
sudo ufw allow 22/tcp

# 允许 HTTP/HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# 手动部署不需要开放内部端口
# MongoDB (27017) 只监听 localhost
# API (3000) 通过 Nginx 反向代理

# 启用防火墙
sudo ufw enable
sudo ufw status
```

## 📊 服务管理

### Docker 方式

```bash
# 查看服务状态
sudo docker compose ps

# 查看日志
sudo docker compose logs -f
sudo docker compose logs api
sudo docker compose logs telethon

# 重启服务
sudo docker compose restart

# 停止服务
sudo docker compose stop

# 启动服务
sudo docker compose start

# 完全停止并删除容器
sudo docker compose down

# 重新构建并启动
sudo docker compose up -d --build
```

### 手动部署方式

```bash
# 查看服务状态
sudo systemctl status telegram-api
sudo systemctl status telegram-listener
sudo systemctl status mongod
sudo systemctl status nginx

# 查看日志
sudo journalctl -u telegram-api -f
sudo journalctl -u telegram-listener -f

# 重启服务
sudo systemctl restart telegram-api
sudo systemctl restart telegram-listener
sudo systemctl restart nginx

# 停止服务
sudo systemctl stop telegram-api
sudo systemctl stop telegram-listener
```

## 🔒 配置 HTTPS（推荐）

使用 Let's Encrypt 免费 SSL 证书：

```bash
# 安装 Certbot
sudo apt install -y certbot python3-certbot-nginx

# 获取证书（替换为你的域名）
sudo certbot --nginx -d yourdomain.com

# 自动续期测试
sudo certbot renew --dry-run
```

修改 `.env` 或 `docker-compose.yml` 中的 `WEB_PORT`：

```bash
# Docker 方式
nano .env
# 修改 WEB_PORT=443

# 重启服务
sudo docker compose down
sudo docker compose up -d
```

## 🔧 故障排查

### 检查端口占用

```bash
# 检查端口 80
sudo ss -tulpn | grep :80

# 检查端口 3000
sudo ss -tulpn | grep :3000

# 检查 MongoDB 端口
sudo ss -tulpn | grep :27017
```

### 查看 Docker 日志

```bash
# 查看所有容器日志
sudo docker compose logs

# 查看特定容器
sudo docker compose logs telethon
sudo docker compose logs api

# 实时跟踪日志
sudo docker compose logs -f --tail=100
```

### MongoDB 连接问题

```bash
# 检查 MongoDB 状态
sudo systemctl status mongod

# 测试连接
mongosh --eval "db.adminCommand('ping')"

# 查看 MongoDB 日志
sudo journalctl -u mongod -f
```

### 无法访问 Web 界面

```bash
# 检查 Nginx 状态
sudo systemctl status nginx

# 测试 Nginx 配置
sudo nginx -t

# 查看 Nginx 错误日志
sudo tail -f /var/log/nginx/error.log

# 检查防火墙
sudo ufw status
```

### Telethon 无法连接

```bash
# 检查环境变量
sudo docker compose exec telethon env | grep API

# 删除 session 重新登录
sudo docker compose down
sudo rm -rf data/session/*
sudo docker compose up -d

# 查看详细日志
sudo docker compose logs telethon
```

## 📈 性能优化

### 1. MongoDB 索引优化

```bash
# 连接 MongoDB
mongosh tglogs

# 创建索引
db.logs.createIndex({ time: -1 })
db.logs.createIndex({ channelId: 1 })
db.logs.createIndex({ keywords: 1 })
db.logs.createIndex({ time: -1, channelId: 1 })
```

### 2. 日志轮转

创建 `/etc/logrotate.d/telegram-monitor`：

```bash
sudo nano /etc/logrotate.d/telegram-monitor
```

内容：

```
/opt/telegram-monitor/logs/**/*.log {
    daily
    rotate 7
    compress
    delaycompress
    notifempty
    create 0644 www-data www-data
    sharedscripts
}
```

### 3. 系统资源限制

编辑 systemd 服务文件，添加资源限制：

```ini
[Service]
MemoryLimit=512M
CPUQuota=50%
```

## 🔄 更新升级

### Docker 方式

```bash
cd /opt/telegram-monitor

# 拉取最新代码
git pull

# 重新构建并启动
sudo docker compose down
sudo docker compose up -d --build

# 查看状态
sudo docker compose ps
```

### 手动部署方式

```bash
cd /opt/telegram-monitor

# 备份配置
cp backend/config.json backend/config.json.bak

# 拉取最新代码
git pull

# 更新 backend
cd backend
npm install
sudo systemctl restart telegram-api

# 更新 telethon
cd ../telethon
source venv/bin/activate
pip install -r requirements.txt
sudo systemctl restart telegram-listener

# 重启 Nginx
sudo systemctl restart nginx
```

## 🗄️ 备份与恢复

### 备份

```bash
# 创建备份目录
sudo mkdir -p /backup/telegram-monitor

# 备份 MongoDB
sudo mongodump --db=tglogs --out=/backup/telegram-monitor/mongodb-$(date +%Y%m%d)

# 备份配置和 session
sudo tar -czf /backup/telegram-monitor/config-$(date +%Y%m%d).tar.gz \
    /opt/telegram-monitor/backend/config.json \
    /opt/telegram-monitor/data/session

# 备份脚本
sudo nano /root/backup-telegram-monitor.sh
```

备份脚本内容：

```bash
#!/bin/bash
BACKUP_DIR="/backup/telegram-monitor"
DATE=$(date +%Y%m%d)

mkdir -p $BACKUP_DIR

# 备份 MongoDB
mongodump --db=tglogs --out=$BACKUP_DIR/mongodb-$DATE

# 备份配置
tar -czf $BACKUP_DIR/config-$DATE.tar.gz \
    /opt/telegram-monitor/backend/config.json \
    /opt/telegram-monitor/data/session

# 删除 7 天前的备份
find $BACKUP_DIR -name "mongodb-*" -mtime +7 -exec rm -rf {} \;
find $BACKUP_DIR -name "config-*" -mtime +7 -delete

echo "备份完成: $DATE"
```

设置定时备份：

```bash
sudo chmod +x /root/backup-telegram-monitor.sh

# 添加到 crontab（每天凌晨 2 点）
sudo crontab -e
# 添加：
0 2 * * * /root/backup-telegram-monitor.sh >> /var/log/telegram-backup.log 2>&1
```

### 恢复

```bash
# 恢复 MongoDB
sudo mongorestore --db=tglogs /backup/telegram-monitor/mongodb-20250101/tglogs/

# 恢复配置
sudo tar -xzf /backup/telegram-monitor/config-20250101.tar.gz -C /

# 重启服务
sudo docker compose restart
# 或
sudo systemctl restart telegram-api telegram-listener
```

## 📞 技术支持

如遇问题，请检查：
1. 服务日志
2. 系统资源使用情况
3. 网络连接状态
4. 防火墙配置

---

**部署完成后别忘了：**
- ✅ 修改默认密码
- ✅ 配置防火墙
- ✅ 设置定时备份
- ✅ 配置 HTTPS（如果使用域名）
- ✅ 监控系统资源
