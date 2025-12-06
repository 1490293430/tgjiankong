# 切换账号使用不同 API_ID/API_HASH 使用指南

## ✅ 功能已实现

现在系统支持切换账号时自动使用对应的 API_ID 和 API_HASH！

## 🚀 使用方法

### 步骤 1：在前端设置用户配置

1. 登录系统，切换到要配置的账号
2. 进入 **⚙️ 设置** -> **Telegram API 配置**
3. 填写该账号的 `API_ID` 和 `API_HASH`
4. 点击 **💾 保存配置**

### 步骤 2：设置环境变量 USER_ID

编辑 `.env` 文件或 `docker-compose.yml`，设置要使用的用户 ID：

```bash
# .env 文件
USER_ID=用户的ObjectId
```

或者在 `docker-compose.yml` 中：

```yaml
telethon:
  environment:
    - USER_ID=${USER_ID:-}
```

### 步骤 3：重启 Telethon 服务

```bash
docker compose restart telethon
```

### 步骤 4：验证

查看 Telethon 日志，确认是否使用了正确的配置：

```bash
docker compose logs telethon -f
```

您应该看到类似这样的日志：
```
从后端 API 获取用户配置 (USER_ID: 67f1234567890abcdef12345)
✅ 已从用户配置中获取 API_ID 和 API_HASH (USER_ID: 67f1234567890abcdef12345)
📱 使用 API_ID: 12345678
使用用户专属 Session 文件: /app/session/telegram_67f1234567890abcdef12345
```

## 📋 工作原理

1. **Telethon 启动时**：
   - 如果设置了 `USER_ID` 环境变量，会从后端 API 获取该用户的配置
   - 优先使用用户配置中的 `api_id` 和 `api_hash`
   - 如果用户配置中没有，则回退到环境变量或全局配置文件

2. **Session 文件隔离**：
   - 每个用户使用独立的 Session 文件（格式：`telegram_用户ID`）
   - 这样不同用户可以使用不同的 Telegram 账号

3. **配置优先级**（从高到低）：
   1. 用户配置（如果设置了 USER_ID 且用户配置中有）
   2. 环境变量 `API_ID` 和 `API_HASH`
   3. 全局配置文件 `backend/config.json`

## 🔄 切换账号流程

### 切换到用户 A：

```bash
# 1. 编辑 .env 文件
USER_ID=用户A的ObjectId

# 2. 重启服务
docker compose restart telethon
```

### 切换到用户 B：

```bash
# 1. 编辑 .env 文件
USER_ID=用户B的ObjectId

# 2. 重启服务
docker compose restart telethon
```

## ⚠️ 重要提示

1. **每次只能监控一个账号**
   - Telethon 服务是全局的，一次只能连接一个 Telegram 账号
   - 切换账号需要重启 Telethon 服务

2. **Session 文件**
   - 每个用户使用独立的 Session 文件
   - 首次使用需要登录 Telegram（输入验证码）

3. **获取用户 ID**
   - 可以在 MongoDB 中查看 `users` 集合
   - 或者在前端界面通过开发者工具查看

## 📝 示例

假设您有两个用户：

- **用户 A**：用户名 `alice`，用户ID `67f1234567890abcdef12345`
- **用户 B**：用户名 `bob`，用户ID `67f0987654321fedcba09876`

### 切换到用户 A：

1. 用户 A 在前端设置：
   - API_ID: `12345678`
   - API_HASH: `abcd1234efgh5678`

2. 设置环境变量：
   ```bash
   USER_ID=67f1234567890abcdef12345
   ```

3. 重启服务：
   ```bash
   docker compose restart telethon
   ```

4. Telethon 会自动使用用户 A 的 API_ID/API_HASH 和专属 Session 文件

### 切换到用户 B：

1. 用户 B 在前端设置：
   - API_ID: `87654321`
   - API_HASH: `wxyz9876stuv5432`

2. 修改环境变量：
   ```bash
   USER_ID=67f0987654321fedcba09876
   ```

3. 重启服务：
   ```bash
   docker compose restart telethon
   ```

4. Telethon 会自动切换到用户 B 的配置

## 🎯 优势

- ✅ **自动切换**：设置好 USER_ID 后，Telethon 自动使用对应用户的配置
- ✅ **Session 隔离**：每个用户使用独立的 Session，不会互相干扰
- ✅ **配置隔离**：每个用户的 API_ID/API_HASH 完全独立
- ✅ **向后兼容**：如果没有设置 USER_ID，仍然使用原有的全局配置方式

## 🔧 故障排查

### 问题：Telethon 启动失败，提示未配置 API_ID/API_HASH

**解决**：
1. 检查用户是否在前端设置了 API_ID 和 API_HASH
2. 检查 USER_ID 环境变量是否正确
3. 检查后端 API 是否正常运行

### 问题：使用了错误的配置

**解决**：
1. 查看 Telethon 日志，确认使用的配置来源
2. 检查用户配置中是否有 API_ID/API_HASH
3. 确认 USER_ID 环境变量是否正确

### 问题：Session 文件冲突

**解决**：
- 系统已自动处理，每个用户使用独立的 Session 文件
- Session 文件格式：`telegram_用户ID`

