# Telegram 监控系统（完整可运行项目）

下面包含一个可部署到 VPS 的完整项目结构：
- Python：Telethon 监听 Telegram
- Node.js：REST API 配置中心
- Web：简单网页管理界面

你可以直接复制使用。

---

## 📁 项目目录结构
```
telegram-monitor/
│
├── backend/
│   ├── server.js        # Node.js 配置后端
│   ├── config.json      # 存储配置
│   └── package.json
│
├── telethon/
│   └── monitor.py       # Python 监听脚本
│
└── web/
    └── index.html       # 前端网页
```

---

# 🐍 telethon/monitor.py
```python
import json
from telethon import TelegramClient, events
import os

CONFIG_PATH = "/root/telegram-monitor/backend/config.json"  # 修改为你的路径

api_id = 123456
api_hash = "your_api_hash_here"

client = TelegramClient('session', api_id, api_hash)

def load_config():
    if not os.path.exists(CONFIG_PATH):
        return {"keywords": [], "channels": []}
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

@client.on(events.NewMessage)
async def handler(event):
    cfg = load_config()
    text = event.raw_text
    chat = await event.get_chat()

    # 频道是否被监听
    if str(chat.id) not in cfg.get("channels", []):
        return

    # 是否匹配关键词
    if any(kw in text for kw in cfg.get("keywords", [])):
        await client.send_message("me", f"[监控触发]\n来源：{chat.title}\n内容：{text}")

client.start()
print("Telegram 监听启动...")
client.run_until_disconnected()
```

---

# 🟦 backend/server.js
```javascript
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const CONFIG_PATH = path.join(__dirname, 'config.json');

// 默认配置文件
if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
        keywords: [],
        channels: []
    }, null, 2));
}

// 获取配置
app.get('/config', (req, res) => {
    const data = fs.readFileSync(CONFIG_PATH);
    res.send(JSON.parse(data));
});

// 更新配置
app.post('/config', (req, res) => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2));
    res.send({ status: "ok" });
});

app.listen(3000, () => console.log("配置中心运行在端口 3000"));
```

---

# 📦 backend/package.json
```json
{
  "name": "tg-monitor-api",
  "version": "1.0.0",
  "main": "server.js",
  "dependencies": {
    "express": "^4.18.2"
  }
}
```

---

# 🌐 web/index.html
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Telegram 监控配置面板</title>
</head>
<body>
  <h2>监控关键词（逗号分隔）</h2>
  <input id="kw" style="width: 300px;">

  <h2>监听频道 ID（逗号分隔）</h2>
  <input id="ch" style="width: 300px;">

  <br><br>
  <button onclick="save()">保存配置</button>

  <script>
  async function save() {
    await fetch('/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: document.getElementById('kw').value.split(','),
        channels: document.getElementById('ch').value.split(',')
      })
    });
    alert('保存成功');
  }
  </script>
</body>
</html>
```

---

# 🚀 部署到 VPS 的步骤

## 1. 安装依赖
### Node.js
```
cd backend
npm install
```

### Python
```
pip install telethon
```

## 2. 启动服务（PM2 长期运行）
```
pm install pm2 -g
pm2 start backend/server.js --name api
pm2 start "python3 telethon/monitor.py" --name tg
```

## 3. 用 Nginx 将网页反代到公网
```
location / {
    root /root/telegram-monitor/web;
    try_files $uri $uri/ =404;
}

location /config {
    proxy_pass http://127.0.0.1:3000/config;
}
```

---

# 🎉 你现在已经拥有一个完整的 Telegram 监听系统

如需：
- 增加数据库存储
- 添加账号切换
- 加一个漂亮的后台 UI
- 做成 Docker 一键部署

告诉我即可，我可以继续为你扩展。


---

# 🐳 Docker 一键部署版本
下面新增完整的 Docker 部署结构，包括：
- `docker-compose.yml`
- Node.js Dockerfile
- Python Telethon Dockerfile
- Nginx（反代网页 + API）

文件结构：
```
telegram-monitor/
│
├── backend/
│   ├── server.js
│   ├── config.json
│   ├── package.json
│   └── Dockerfile
│
├── telethon/
│   ├── monitor.py
│   └── Dockerfile
│
├── web/
│   └── index.html
│
└── docker-compose.yml
```

---

# 📄 docker-compose.yml
```yaml
version: '3'
services:
  api:
    build: ./backend
    container_name: tg_api
    volumes:
      - ./backend/config.json:/app/config.json
    ports:
      - "3000:3000"
    restart: always

  telethon:
    build: ./telethon
    container_name: tg_listener
    volumes:
      - ./backend/config.json:/app/config.json
      - ./telethon/session:/app/session
    depends_on:
      - api
    restart: always

  web:
    image: nginx:alpine
    container_name: tg_web
    volumes:
      - ./web:/usr/share/nginx/html:ro
      - ./nginx.conf:/etc/nginx/conf.d/default.conf
    ports:
      - "80:80"
    restart: always
```

---

# 📄 backend/Dockerfile
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

---

# 📄 telethon/Dockerfile
```dockerfile
FROM python:3.10-slim
WORKDIR /app
RUN pip install telethon
COPY . .
EXPOSE 9000
CMD ["python3", "monitor.py"]
```

---

# 📄 nginx.conf（放在项目根目录）
```nginx
server {
    listen 80;

    # 前端网页
    location / {
        root /usr/share/nginx/html;
        try_files $uri $uri/ /index.html;
    }

    # 后端配置 API
    location /config {
        proxy_pass http://api:3000/config;
    }
}
```

---

# 🚀 一键启动
在项目根目录执行：
```
docker-compose up -d
```

然后访问：
```
http://你的服务器IP/
```
即可看到配置面板（自动可用）。

---

如果你需要：
- 自动 HTTPS（Let’s Encrypt）
- 多账号多容器
- 增加数据库（MongoDB/MySQL）
- 完整前端管理后台

我可以继续帮你扩展。

---

# 🗄️ 日志数据库支持（MongoDB + Telethon + API）
下面新增 **完整日志系统**：
- 使用 MongoDB 存储监控命中记录
- Node.js 提供日志 API（分页 / 查询）
- Telethon 推送命中消息到数据库
- Docker-compose 自动启动 mongo

新增文件：
```
telegram-monitor/
│
├── backend/
│   ├── server.js         # 新增日志 API
│   ├── logModel.js       # MongoDB 日志 schema
│   └── Dockerfile
│
├── telethon/
│   ├── monitor.py        # 新增日志写入
│   └── Dockerfile
│
├── web/
│   └── index.html        # 新增日志查看接口按钮
│
└── docker-compose.yml    # 新增 mongo 服务
```

---

# 📄 新增 docker-compose.yml（带 MongoDB）
```yaml
version: '3'
services:
  mongo:
    image: mongo:6
    container_name: tg_mongo
    restart: always
    volumes:
      - ./mongo_data:/data/db
    ports:
      - "27017:27017"

  api:
    build: ./backend
    container_name: tg_api
    environment:
      - MONGO_URL=mongodb://mongo:27017/tglogs
    volumes:
      - ./backend/config.json:/app/config.json
    depends_on:
      - mongo
    ports:
      - "3000:3000"
    restart: always

  telethon:
    build: ./telethon
    container_name: tg_listener
    environment:
      - MONGO_URL=mongodb://mongo:27017/tglogs
    volumes:
      - ./backend/config.json:/app/config.json
      - ./telethon/session:/app/session
    depends_on:
      - mongo
    restart: always

  web:
    image: nginx:alpine
    container_name: tg_web
    volumes:
      - ./web:/usr/share/nginx/html:ro
      - ./nginx.conf:/etc/nginx/conf.d/default.conf
    ports:
      - "80:80"
    restart: always
```

---

# 📄 backend/logModel.js
```javascript
const mongoose = require('mongoose');

const logSchema = new mongoose.Schema({
  channel: String,
  message: String,
  time: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Log', logSchema);
```

---

# 📄 backend/server.js（新增 MongoDB + 日志 API）
```javascript
const express = require('express');
const fs = require('fs');
const mongoose = require('mongoose');
const Log = require('./logModel');

const app = express();
app.use(express.json());

// 连接 MongoDB
mongoose.connect(process.env.MONGO_URL, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log("MongoDB 已连接"));

// 获取配置
app.get('/config', (req, res) => {
  const data = fs.readFileSync('./config.json');
  res.send(JSON.parse(data));
});

// 更新配置
app.post('/config', (req, res) => {
  fs.writeFileSync('./config.json', JSON.stringify(req.body, null, 2));
  res.send({ status: "ok" });
});

// 获取日志（分页）
app.get('/logs', async (req, res) => {
  const page = parseInt(req.query.page || 1);
  const pageSize = 20;

  const logs = await Log.find()
    .sort({ time: -1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize);

  res.send(logs);
});

app.listen(3000, () => console.log("配置中心运行在 3000 端口"));
```

---

# 📄 telethon/monitor.py（新增写入日志到 MongoDB）
```python
import json
from telethon import TelegramClient, events
import pymongo
import os

CONFIG_PATH = "/app/config.json"
MONGO_URL = os.getenv("MONGO_URL")

mongo = pymongo.MongoClient(MONGO_URL)
db = mongo["tglogs"]
logs = db.logs

api_id = 123456
api_hash = "your_api_hash_here"

client = TelegramClient('session', api_id, api_hash)

def load_config():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

@client.on(events.NewMessage)
async def handler(event):
    cfg = load_config()
    text = event.raw_text
    chat = await event.get_chat()

    if str(chat.id) not in cfg.get("channels", []):
        return

    if any(kw in text for kw in cfg.get("keywords", [])):
        # 写入数据库日志
        logs.insert_one({
            "channel": chat.title,
            "message": text,
            "time": event.date
        })

        await client.send_message("me", f"[监控触发]
来源：{chat.title}
内容：{text}")

client.start()
print("Telegram 监听启动（含日志数据库）...")
client.run_until_disconnected()
```

---

# 🌐 web/index.html（新增“查看日志”按钮）
```html
<button onclick="loadLogs()">查看最近日志</button>
<div id="logs"></div>

<script>
async function loadLogs() {
  const res = await fetch('/logs');
  const data = await res.json();
  document.getElementById('logs').innerHTML = data
    .map(x => `<p>[${x.time}] ${x.channel}: ${x.message}</p>`)
    .join('');
}
</script>
```

---

# 🚀 使用方式
```
docker-compose up -d
```
访问：
```
http://你的IP/
```
即可在网页上查看日志。

---

如果你想：
- 日志加入关键字高亮
- 添加“搜索日志”输入框
- 日志使用 SQLite 版本（更轻量）
- 前端换成 Vue 管理后台
告诉我即可继续扩展。

## 关键词告警功能
监听到包含预设关键词的消息后，自动推送到你的 Telegram。

### 配置新增
在 `config.json` 中新增：
```json
{
  "alert_keywords": ["报警", "关键", "error", "fail"],
  "alert_target": "你的Telegram账号或Bot聊天ID"
}
```

### 功能逻辑
- Python Listener 在接收到消息后会检查是否包含 keyword
- 命中后写入 MongoDB
- 立即调用 Node API 转发到你的 Telegram

### API 新增
#### POST /api/alert/push
由 Python 监听器调用
```json
{
  "keyword": "error",
  "message": "xxx",
  "from": "用户",
  "chat_id": 123456
}
```
Node 后端会将通知推送到你的 Telegram。


## 高级告警扩展

### 1. 多种动作触发（邮件 / Webhook / Telegram 同步推送）
新增配置：
```json
{
  "alert_actions": {
    "telegram": true,
    "email": {
      "enable": true,
      "smtp_host": "smtp.example.com",
      "smtp_port": 465,
      "username": "alert@example.com",
      "password": "你的SMTP密码",
      "to": "接收邮箱"
    },
    "webhook": {
      "enable": true,
      "url": "https://your-webhook-endpoint.com/alert"
    }
  }
}
```
监听器命中关键词 → Node API → 根据启用状态依次触发：邮件、Webhook、Telegram。

---

### 2. 富文本告警格式（来源、时间、跳转按钮）
推送格式示例：
```
⚠️ 关键词告警触发

来源：群组名称 (chat_id)
发送者：用户名
时间：2025-01-20 12:30:12

消息内容：
xxx xxx

👉 点击跳转： t.me/c/<chat_id>/<msg_id>
```
Telegram 推送通过 `parse_mode: "HTML"` 支持按钮与格式化内容。

---

### 3. 正则关键词匹配（支持模糊、多规则）
配置支持：
```json
{
  "alert_regex": [
    "错误.+失败",
    "订单.*取消",
    "(退款|chargeback)"
  ]
}
```
Python 监听器逻辑：
- 遍历 `alert_keywords`（普通关键字）
- 遍历 `alert_regex`（正则规则）
- 任意命中 → 触发告警动作

---

## 后台登录安全体系（Admin + 密码）
新增后端配置：
```json
{
  "admin": {
    "username": "admin",
    "password_hash": "bcrypt加密后的密码"
  }
}
```
前端：
- 增加登录页 `/login`
- 输入账号密码后，调用：`POST /api/auth/login`
- Node API：
  - 使用 bcrypt 校验密码
  - 登录成功后返回 JWT Token
- 所有 API 必须携带：
  `Authorization: Bearer <token>`

前端会在 localStorage 缓存 token，刷新不登出；24 小时自动过期。

