import json
import os
import re
import asyncio
from telethon import TelegramClient, events
import pymongo
from datetime import datetime
import requests

# 配置路径
CONFIG_PATH = os.getenv("CONFIG_PATH", "/app/config.json")
MONGO_URL = os.getenv("MONGO_URL", "mongodb://mongo:27017/tglogs")
API_URL = os.getenv("API_URL", "http://api:3000")

# Telegram API 配置（优先从配置文件读取，其次 ENV）
ENV_API_ID = int(os.getenv("API_ID", "0"))
ENV_API_HASH = os.getenv("API_HASH", "")
SESSION_PATH = os.getenv("SESSION_PATH", "/app/session/telegram")

# MongoDB 连接
mongo_client = pymongo.MongoClient(MONGO_URL)
db = mongo_client["tglogs"]
logs_collection = db["logs"]

print("✅ MongoDB 已连接")

def load_config():
    """加载配置文件"""
    try:
        if not os.path.exists(CONFIG_PATH):
            print(f"⚠️  配置文件不存在: {CONFIG_PATH}")
            return {
                "keywords": [],
                "channels": [],
                "alert_keywords": [],
                "alert_regex": [],
                "alert_target": ""
            }
        
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            config = json.load(f)
            return config
    except Exception as e:
        print(f"❌ 加载配置失败: {e}")
        return {
            "keywords": [],
            "channels": [],
            "alert_keywords": [],
            "alert_regex": [],
            "alert_target": ""
        }

def check_keywords(text, keywords):
    """检查文本是否包含关键词"""
    for keyword in keywords:
        if keyword.lower() in text.lower():
            return keyword
    return None

def check_regex(text, patterns):
    """检查文本是否匹配正则表达式"""
    for pattern in patterns:
        try:
            if re.search(pattern, text, re.IGNORECASE):
                return pattern
        except re.error:
            print(f"⚠️  正则表达式错误: {pattern}")
    return None

async def send_alert(keyword, message, sender, channel, channel_id, message_id):
    """发送告警到 API"""
    try:
        data = {
            "keyword": keyword,
            "message": message,
            "from": sender,
            "channel": channel,
            "channelId": str(channel_id),
            "messageId": message_id
        }
        
        response = requests.post(
            f"{API_URL}/api/alert/push",
            json=data,
            timeout=10
        )
        
        if response.status_code == 200:
            print(f"✅ 告警已发送: {keyword}")
        else:
            print(f"⚠️  告警发送失败: {response.status_code}")
    except Exception as e:
        print(f"❌ 发送告警失败: {e}")

async def save_log(channel, channel_id, sender, message, keywords, message_id):
    """保存日志到 MongoDB"""
    try:
        log = {
            "channel": channel,
            "channelId": str(channel_id),
            "sender": sender,
            "message": message,
            "keywords": keywords if isinstance(keywords, list) else [keywords],
            "time": datetime.now(),
            "messageId": message_id,
            "alerted": len(keywords) > 0 if isinstance(keywords, list) else bool(keywords)
        }
        
        logs_collection.insert_one(log)
        print(f"💾 日志已保存: {channel}")
    except Exception as e:
        print(f"❌ 保存日志失败: {e}")

async def message_handler(event, client):
    """消息处理器"""
    try:
        # 加载配置
        config = load_config()
        log_all = bool(config.get("log_all_messages", False))
        
        # 获取消息内容
        text = event.raw_text or ""
        if not text:
            return
        
        # 获取频道信息
        chat = await event.get_chat()
        channel_id = str(chat.id)
        channel_name = getattr(chat, 'title', None) or getattr(chat, 'username', None) or 'Unknown'
        
        # 检查是否监控该频道
        monitored_channels = config.get("channels", [])
        if monitored_channels and channel_id not in monitored_channels:
            return
        
        # 获取发送者信息
        sender = "Unknown"
        if event.sender:
            sender = getattr(event.sender, 'username', None) or \
                     getattr(event.sender, 'first_name', None) or \
                     str(event.sender.id)
        
        # 检查普通关键词
        matched_keywords = []
        for keyword in config.get("keywords", []):
            if keyword.lower() in text.lower():
                matched_keywords.append(keyword)
        
        # 检查告警关键词
        alert_keyword = None
        for keyword in config.get("alert_keywords", []):
            if keyword.lower() in text.lower():
                alert_keyword = keyword
                matched_keywords.append(keyword)
                break
        
        # 检查正则表达式
        if not alert_keyword:
            for pattern in config.get("alert_regex", []):
                try:
                    if re.search(pattern, text, re.IGNORECASE):
                        alert_keyword = pattern
                        matched_keywords.append(f"regex:{pattern}")
                        break
                except re.error:
                    pass
        
        # 如果关键词命中或开启全量记录，则保存日志
        if matched_keywords or log_all:
            await save_log(
                channel_name,
                channel_id,
                sender,
                text,
                matched_keywords if matched_keywords else [],
                event.id
            )
            if matched_keywords:
                print(f"🎯 监控触发 | 频道: {channel_name} | 关键词: {matched_keywords}")
            elif log_all:
                print(f"📝 已记录消息（全量）| 频道: {channel_name}")
            
            # 如果有告警关键词，发送告警
            if alert_keyword:
                await send_alert(
                    alert_keyword,
                    text,
                    sender,
                    channel_name,
                    channel_id,
                    event.id
                )
                
                # 同时发送到自己的 Telegram（Saved Messages）
                try:
                    alert_message = f"""⚠️ 关键词告警触发

来源：{channel_name} ({channel_id})
发送者：{sender}
关键词：{alert_keyword}
时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

消息内容：
{text[:500]}{'...' if len(text) > 500 else ''}

👉 跳转链接：t.me/c/{channel_id.replace('-100', '')}/{event.id}"""
                    
                    await client.send_message("me", alert_message)
                    print(f"📱 告警已发送到 Telegram")
                except Exception as e:
                    print(f"⚠️  发送 Telegram 消息失败: {e}")
    
    except Exception as e:
        print(f"❌ 处理消息失败: {e}")

async def main():
    """主函数"""
    print("🚀 正在启动 Telegram 监听服务...")
    
    # 加载配置并读取 API 凭证
    config = load_config()
    cfg_api_id = int(str(config.get("telegram", {}).get("api_id", ENV_API_ID or 0)) or 0)
    cfg_api_hash = str(config.get("telegram", {}).get("api_hash", ENV_API_HASH or ""))

    if cfg_api_id == 0 or not cfg_api_hash:
        print("❌ 错误：未配置 API_ID/API_HASH。请在 Web 后台的‘配置’页面填写并保存，或设置环境变量 API_ID/API_HASH。")
        print("📝 获取方式：https://my.telegram.org/apps")
        return

    # 创建并启动客户端
    client = TelegramClient(SESSION_PATH, cfg_api_id, cfg_api_hash)
    await client.start()

    # 事件处理绑定
    client.add_event_handler(lambda e: message_handler(e, client), events.NewMessage())

    # 获取当前用户信息
    me = await client.get_me()
    print(f"✅ 已登录为: {me.username or me.first_name} (ID: {me.id})")
    
    # 显示监控信息
    print(f"📊 监控配置:")
    print(f"  - 关键词: {len(config.get('keywords', []))} 个")
    print(f"  - 告警关键词: {len(config.get('alert_keywords', []))} 个")
    print(f"  - 正则表达式: {len(config.get('alert_regex', []))} 个")
    print(f"  - 监控频道: {len(config.get('channels', []))} 个")
    print(f"  - 全量记录: {'开启' if config.get('log_all_messages') else '关闭'}")
    
    if not config.get('channels'):
        print("⚠️  警告：未配置监控频道，将监控所有消息")
    
    print("✅ Telegram 监听服务已启动，等待消息...")
    
    # 保持运行
    await client.run_until_disconnected()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n👋 服务已停止")
    except Exception as e:
        print(f"❌ 服务异常: {e}")
