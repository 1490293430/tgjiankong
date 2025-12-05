import json
import os
import re
import asyncio
from telethon import TelegramClient, events
from telethon.sessions import StringSession
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

async def trigger_ai_analysis(sender_id, client):
    """触发 AI 分析并发送结果给指定用户"""
    try:
        # 调用内部 AI 分析接口（不需要认证）
        response = requests.post(
            f"{API_URL}/api/internal/ai/analyze-now",
            json={"trigger_type": "user_message"},
            timeout=30
        )
        
        if response.status_code == 200:
            result = response.json()
            if result.get("success"):
                analysis = result.get("analysis", {})
                summary = f"""
🤖 AI 分析结果

📊 统计信息:
- 分析消息数: {result.get('message_count', 0)}

😊/😐/😔 情感分析:
- 整体情感: {analysis.get('sentiment', 'unknown')}
- 情感分数: {analysis.get('sentiment_score', 0)}

⚠️ 风险评估:
- 风险等级: {analysis.get('risk_level', 'unknown')}

📝 内容摘要:
{analysis.get('summary', '无法生成摘要')}

🔑 关键词:
{', '.join(analysis.get('keywords', []))}
"""
                
                # 发送分析结果给用户
                try:
                    # 尝试通过用户 ID 发送
                    await client.send_message(int(sender_id), summary)
                    print(f"✅ AI 分析结果已发送给用户 {sender_id}")
                except Exception as e:
                    print(f"❌ 发送分析结果失败: {e}")
            else:
                error_msg = result.get("error", "未知错误")
                print(f"❌ AI 分析失败: {error_msg}")
        else:
            print(f"❌ AI 分析请求失败: {response.status_code}")
    except Exception as e:
        print(f"❌ 触发 AI 分析异常: {e}")

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
            "alerted": len(keywords) > 0 if isinstance(keywords, list) else bool(keywords),
            "ai_analyzed": False  # 新消息默认标记为未分析
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
        
        # 获取发送者信息（优先显示真实名字，其次 username，最后 ID）
        sender = "Unknown"
        try:
            sender_entity = await event.get_sender()
        except Exception:
            sender_entity = None

        if sender_entity:
            first_name = getattr(sender_entity, 'first_name', None)
            last_name = getattr(sender_entity, 'last_name', None)
            username = getattr(sender_entity, 'username', None)
            
            # 优先级：真实名字 > @username > ID
            full_name = ' '.join([n for n in [first_name, last_name] if n]) if (first_name or last_name) else None
            
            if full_name:
                # 如果有真实名字，显示 "真实名字 (@username)" 或仅 "真实名字"
                sender = f"{full_name} (@{username})" if username else full_name
            elif username:
                sender = f"@{username}"
            else:
                sender = str(getattr(sender_entity, 'id', 'Unknown'))
        else:
            sid = getattr(event, 'sender_id', None)
            if sid:
                sender = str(sid)
            else:
                sender = channel_name or "Unknown"
        
        # 获取发送者的 ID（用于固定用户触发检查和 AI 分析返回）
        sender_id = None
        if sender_entity:
            sender_id = getattr(sender_entity, 'id', None)
        if not sender_id:
            sender_id = getattr(event, 'sender_id', None)
        
        # 检查是否为固定用户，如果是则立刻触发 AI 分析
        ai_trigger_enabled = config.get("ai_analysis", {}).get("ai_trigger_enabled", False)
        ai_trigger_users = config.get("ai_analysis", {}).get("ai_trigger_users", [])
        
        # 确保 ai_trigger_users 是列表
        if isinstance(ai_trigger_users, str):
            ai_trigger_users = [u.strip() for u in ai_trigger_users.split('\n') if u.strip()]
        
        if ai_trigger_enabled and ai_trigger_users and sender_id:
            # 获取发送者的完整名字
            full_name = None
            if sender_entity:
                first_name = getattr(sender_entity, 'first_name', None)
                last_name = getattr(sender_entity, 'last_name', None)
                full_name = ' '.join([n for n in [first_name, last_name] if n]) if (first_name or last_name) else None
            
            # 检查发送者是否在固定用户列表中（支持用户名、显示名、ID）
            sender_triggers = [
                str(sender_id),  # 数字 ID
                f"@{getattr(sender_entity, 'username', '')}" if sender_entity and getattr(sender_entity, 'username', None) else None,  # @username
                full_name,  # 真实名字
                sender  # 完整的 sender 字符串
            ]
            
            # 清理 None 值
            sender_triggers = [str(s) for s in sender_triggers if s]
            
            print(f"🔍 固定用户检查: 触发用户列表={ai_trigger_users}, 当前发送者={sender}, 发送者ID={sender_id}, 候选匹配列表={sender_triggers}")
            
            for trigger_user in ai_trigger_users:
                trigger_user = trigger_user.strip()
                if trigger_user in sender_triggers:
                    print(f"✅ 固定用户 {sender} 匹配成功，触发 AI 分析（匹配值: {trigger_user}）")
                    asyncio.create_task(trigger_ai_analysis(sender_id, client))
                    break
            else:
                print(f"⏭️  发送者 {sender} 不在固定用户列表中")
        
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
                
                # 发送到 Telegram 目标：优先使用配置的 alert_target，否则发到“保存的消息”（me）
                try:
                    target = (config.get("alert_target") or "me").strip() or "me"
                    # 将纯数字/负数字字符串转换为整数 chat_id（支持 -100... 群/频道）
                    def _normalize_target(t):
                        ts = str(t).strip()
                        if (ts.isdigit()) or (ts.startswith('-') and ts[1:].isdigit()):
                            try:
                                return int(ts)
                            except Exception:
                                return ts
                        return ts

                    target_id = _normalize_target(target)
                    alert_message = f"""⚠️ 关键词告警触发

来源：{channel_name} ({channel_id})
发送者：{sender}
关键词：{alert_keyword}
时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

消息内容：
{text[:500]}{'...' if len(text) > 500 else ''}

👉 跳转链接：t.me/c/{channel_id.replace('-100', '')}/{event.id}"""
                    await client.send_message(target_id, alert_message)
                    print(f"📱 告警已发送到 Telegram: {target}")
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
    cfg_session_string = (
        str(config.get("telegram", {}).get("session_string", "")).strip()
        or os.getenv("SESSION_STRING", "").strip()
    )

    if cfg_api_id == 0 or not cfg_api_hash:
        print("❌ 错误：未配置 API_ID/API_HASH。请在 Web 后台的‘配置’页面填写并保存，或设置环境变量 API_ID/API_HASH。")
        print("📝 获取方式：https://my.telegram.org/apps")
        return

    # 创建并启动客户端
    if cfg_session_string:
        print("🔐 使用会话类型: StringSession (来自配置/环境)")
        client = TelegramClient(StringSession(cfg_session_string), cfg_api_id, cfg_api_hash)
    else:
        print(f"💾 使用会话类型: FileSession @ {SESSION_PATH}")
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
