
# monitor_async.py
import os
import json
import re
import asyncio
from datetime import datetime
from typing import List, Optional, Dict, Any
import psutil
import logging
import signal

from telethon import TelegramClient, events
from telethon.sessions import StringSession
from telethon.errors import RpcError
import aiohttp
from aiohttp import web
import motor.motor_asyncio
from mongo_index_init import ensure_indexes

# -----------------------
# 配置（ENV 或默认）
# -----------------------
CONFIG_PATH = os.getenv("CONFIG_PATH", "/app/config.json")
MONGO_URL = os.getenv("MONGO_URL", "mongodb://mongo:27017")
MONGO_DBNAME = os.getenv("MONGO_DBNAME", "tglogs")
API_URL = os.getenv("API_URL", "http://api:3000")
# 安全地解析 API_ID，如果为空字符串或无效值则使用 0
api_id_str = os.getenv("API_ID", "0")
try:
    # 尝试转换为整数，如果失败则使用 0
    if api_id_str and api_id_str.strip() and api_id_str.strip().isdigit():
        ENV_API_ID = int(api_id_str.strip())
    else:
        ENV_API_ID = 0
        if api_id_str and api_id_str.strip() and api_id_str.strip() not in ["0", ""]:
            logger.warning("⚠️  环境变量 API_ID 无效: '%s'，将使用 0（请通过配置文件或用户配置设置）", api_id_str)
except (ValueError, AttributeError):
    ENV_API_ID = 0
    logger.warning("⚠️  环境变量 API_ID 解析失败: '%s'，将使用 0（请通过配置文件或用户配置设置）", api_id_str)
ENV_API_HASH = os.getenv("API_HASH", "")
# 统一使用 volume 路径
SESSION_VOLUME_PATH = os.getenv("SESSION_VOLUME_PATH", "/tmp/session_volume")
# 统一使用 volume 路径，格式：/tmp/session_volume/user
# 如果 SESSION_VOLUME_PATH 存在，使用 volume 路径；否则使用环境变量 SESSION_PATH（向后兼容）
OLD_SESSION_PATH = os.getenv("SESSION_PATH", "/app/session/telegram")
if SESSION_VOLUME_PATH and os.path.exists(SESSION_VOLUME_PATH):
    # 统一使用 volume 路径，格式：/tmp/session_volume/user
    SESSION_PATH = os.path.join(SESSION_VOLUME_PATH, "user")
elif OLD_SESSION_PATH.startswith("/tmp/session_volume"):
    # 如果 SESSION_PATH 已经是 volume 路径，直接使用
    SESSION_PATH = OLD_SESSION_PATH
else:
    # 向后兼容：如果没有 volume，使用旧路径（但会迁移到 volume）
    SESSION_PATH = OLD_SESSION_PATH
SESSION_STRING = os.getenv("SESSION_STRING", "").strip()
# 用户ID - 用于数据隔离，从环境变量读取
USER_ID = os.getenv("USER_ID", "").strip()

# 并发限制（可调）
AI_CONCURRENCY = int(os.getenv("AI_CONCURRENCY", "2"))
ALERT_CONCURRENCY = int(os.getenv("ALERT_CONCURRENCY", "4"))

# config reload interval (秒) - 增加到5分钟作为兜底机制（配置变更主要通过HTTP通知立即生效）
CONFIG_RELOAD_INTERVAL = float(os.getenv("CONFIG_RELOAD_INTERVAL", "300.0"))

# -----------------------
# 日志
# -----------------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("tg_monitor")

# -----------------------
# 全局资源（异步安全）
# -----------------------
mongo_client = motor.motor_asyncio.AsyncIOMotorClient(MONGO_URL)
db = mongo_client[MONGO_DBNAME]
logs_collection = db["logs"]

# aiohttp session will be created on loop start
http_session: Optional[aiohttp.ClientSession] = None

# config cache and compiled regex
CONFIG_CACHE: Dict[str, Any] = {}
CONFIG_MTIME = 0.0
COMPILED_ALERT_REGEX: List[re.Pattern] = []

# async semaphores to limit concurrency for heavy tasks
ai_semaphore = asyncio.Semaphore(AI_CONCURRENCY)
alert_semaphore = asyncio.Semaphore(ALERT_CONCURRENCY)

# shutdown event
SHUTDOWN = asyncio.Event()


# CPU监控 - 使用缓存减少开销，避免频繁调用导致CPU峰值
_cpu_process = None
_cpu_last_check = 0
_cpu_check_interval = 10.0  # 每10秒最多检查一次

def log_cpu_usage(tag=""):
    """记录CPU使用率，但限制调用频率以避免自身消耗过多CPU"""
    global _cpu_process, _cpu_last_check
    import time
    
    current_time = time.time()
    # 限制CPU监控频率，避免频繁调用导致CPU峰值
    if current_time - _cpu_last_check < _cpu_check_interval:
        return
    
    try:
        if _cpu_process is None:
            _cpu_process = psutil.Process(os.getpid())
        # 使用interval=0.1而不是None，减少开销
        cpu = _cpu_process.cpu_percent(interval=0.1)
        logger.info(f"[CPU监控] {tag} 当前进程CPU占用: {cpu}%")
        _cpu_last_check = current_time
    except Exception:
        pass  # 忽略CPU监控错误，避免影响主流程


# -----------------------
# default config helper
# -----------------------
def default_config():
    return {
        "telegram": {"api_id": ENV_API_ID or 0, "api_hash": ENV_API_HASH or ""},
        "keywords": [],
        "channels": [],
        "alert_keywords": [],
        "alert_regex": [],
        "alert_target": "me",
        "log_all_messages": False,
        "ai_analysis": {
            "ai_trigger_enabled": False,
            "ai_trigger_users": []
        }
    }


# -----------------------
# async-safe config loader (only reloads when file mtime changes)
# -----------------------
def load_config_sync():
    """Synchronous file read + json load but called rarely by background task.
       We cache result in CONFIG_CACHE for message handler to use without IO.
    """
    global CONFIG_CACHE, CONFIG_MTIME, COMPILED_ALERT_REGEX
    try:
        if not os.path.exists(CONFIG_PATH):
            CONFIG_CACHE = default_config()
            CONFIG_MTIME = 0.0
            COMPILED_ALERT_REGEX = []
            logger.warning("配置文件不存在: %s，使用默认配置", CONFIG_PATH)
            return

        mtime = os.path.getmtime(CONFIG_PATH)
        if CONFIG_CACHE and mtime == CONFIG_MTIME:
            return  # no change

        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)

        # normalize fields with defaults
        base = default_config()
        base.update(cfg or {})
        CONFIG_CACHE = base
        CONFIG_MTIME = mtime

        # compile regex patterns
        patterns = CONFIG_CACHE.get("alert_regex", []) or []
        COMPILED_ALERT_REGEX = []
        for p in patterns:
            try:
                COMPILED_ALERT_REGEX.append(re.compile(p, re.IGNORECASE))
            except re.error:
                logger.warning("无效的正则，跳过: %s", p)

        logger.info("配置已加载/更新：keywords=%d alert_keywords=%d regex=%d channels=%d",
                    len(CONFIG_CACHE.get("keywords", [])),
                    len(CONFIG_CACHE.get("alert_keywords", [])),
                    len(COMPILED_ALERT_REGEX),
                    len(CONFIG_CACHE.get("channels", [])))
    except Exception as e:
        logger.exception("加载配置失败: %s", e)
        CONFIG_CACHE = default_config()
        COMPILED_ALERT_REGEX = []


async def config_reloader_task():
    """后台任务：定期检查配置文件是否变化并加载（同步 IO，但很低频）"""
    loop = asyncio.get_event_loop()
    while not SHUTDOWN.is_set():
        try:
            # import time
            # start_time = time.time()
            # run synchronous loader on loop's executor to avoid blocking event loop if file read is slow
            await loop.run_in_executor(None, load_config_sync)
            # elapsed = time.time() - start_time
            # if elapsed > 0.1:  # 只记录耗时超过100ms的操作
            #     logger.warning(f"[性能监控] 配置重载任务耗时: {elapsed:.3f}秒")
        except Exception as e:
            logger.exception("配置重载任务异常: %s", e)
        # 使用asyncio.sleep而不是wait，更高效
        await asyncio.sleep(CONFIG_RELOAD_INTERVAL)


# -----------------------
# HTTP helpers (aiohttp)
# -----------------------
async def get_json(url: str, timeout: int = 10, silent: bool = False) -> Optional[dict]:
    """
    发送 GET 请求
    :param url: 请求 URL
    :param timeout: 超时时间（秒）
    :param silent: 如果为 True，连接失败时不记录 ERROR（仅 DEBUG），用于可选的辅助功能
    :return: 响应数据或 None
    """
    global http_session
    if http_session is None:
        raise RuntimeError("HTTP session not initialized")
    try:
        async with http_session.get(url, timeout=aiohttp.ClientTimeout(total=timeout)) as resp:
            text = await resp.text()
            if resp.status == 200:
                try:
                    return await resp.json()
                except Exception:
                    return {"raw": text}
            else:
                if not silent:
                    logger.warning("GET %s 返回 %s: %s", url, resp.status, text[:200])
                return None
    except asyncio.CancelledError:
        raise
    except (aiohttp.client_exceptions.ClientConnectorError, 
            aiohttp.client_exceptions.ClientConnectorDNSError) as e:
        if silent:
            logger.debug("GET 请求失败（静默模式）: %s %s", url, str(e)[:100])
        else:
            logger.warning("GET 请求失败（连接错误）: %s %s", url, str(e)[:100])
        return None
    except Exception as e:
        if not silent:
            logger.exception("GET 请求失败: %s %s", url, e)
        else:
            logger.debug("GET 请求失败（静默模式）: %s %s", url, str(e)[:100])
        return None


async def get_json(url: str, timeout: int = 10, silent: bool = False) -> Optional[dict]:
    """
    发送 GET 请求
    :param url: 请求 URL
    :param timeout: 超时时间（秒）
    :param silent: 如果为 True，连接失败时不记录 ERROR（仅 DEBUG），用于可选的辅助功能
    :return: 响应数据或 None
    """
    global http_session
    if http_session is None:
        raise RuntimeError("HTTP session not initialized")
    try:
        async with http_session.get(url, timeout=aiohttp.ClientTimeout(total=timeout)) as resp:
            text = await resp.text()
            if resp.status == 200:
                try:
                    return await resp.json()
                except Exception:
                    return {"raw": text}
            else:
                if not silent:
                    logger.warning("GET %s 返回 %s: %s", url, resp.status, text[:200])
                return None
    except asyncio.CancelledError:
        raise
    except (aiohttp.client_exceptions.ClientConnectorError, 
            aiohttp.client_exceptions.ClientConnectorDNSError) as e:
        if silent:
            logger.debug("GET 请求失败（静默模式）: %s %s", url, str(e)[:100])
        else:
            logger.warning("GET 请求失败（连接错误）: %s %s", url, str(e)[:100])
        return None
    except Exception as e:
        if not silent:
            logger.exception("GET 请求失败: %s %s", url, e)
        else:
            logger.debug("GET 请求失败（静默模式）: %s %s", url, str(e)[:100])
        return None


async def post_json(url: str, payload: dict, timeout: int = 10, silent: bool = False) -> Optional[dict]:
    """
    发送 POST 请求
    :param url: 请求 URL
    :param payload: 请求数据
    :param timeout: 超时时间（秒）
    :param silent: 如果为 True，连接失败时不记录 ERROR（仅 DEBUG），用于可选的辅助功能
    :return: 响应数据或 None
    """
    global http_session
    if http_session is None:
        raise RuntimeError("HTTP session not initialized")
    try:
        async with http_session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=timeout)) as resp:
            text = await resp.text()
            if resp.status == 200:
                try:
                    return await resp.json()
                except Exception:
                    return {"raw": text}
            else:
                if not silent:
                    logger.warning("POST %s 返回 %s: %s", url, resp.status, text[:200])
                return None
    except asyncio.CancelledError:
        raise
    except (aiohttp.client_exceptions.ClientConnectorError, 
            aiohttp.client_exceptions.ClientConnectorDNSError) as e:
        # 连接错误（DNS解析失败、无法连接等）- 根据 silent 参数决定日志级别
        if silent:
            logger.debug("POST 请求失败（静默模式）: %s %s", url, str(e)[:100])
        else:
            logger.warning("POST 请求失败（连接错误）: %s %s", url, str(e)[:100])
        return None
    except Exception as e:
        if not silent:
            logger.exception("POST 请求失败: %s %s", url, e)
        else:
            logger.debug("POST 请求失败（静默模式）: %s %s", url, str(e)[:100])
        return None


# -----------------------
# async DB write
# -----------------------
async def save_log_async(channel, channel_id, sender, message, keywords, message_id):
    try:
        from bson import ObjectId
        
        # 获取userId，如果没有设置则尝试从配置中获取或使用默认值
        userId = None
        if USER_ID:
            try:
                userId = ObjectId(USER_ID)
            except Exception:
                logger.warning("无效的USER_ID环境变量: %s，将尝试从配置获取", USER_ID)
        
        # 如果环境变量中没有，尝试从配置中获取
        if not userId:
            config = CONFIG_CACHE or default_config()
            config_user_id = config.get("user_id")
            if config_user_id:
                try:
                    userId = ObjectId(config_user_id)
                except Exception:
                    pass
        
        # 如果还是没有，记录警告（但继续保存，后端会处理）
        if not userId:
            logger.warning("未设置USER_ID，日志将无法关联到用户。请在环境变量中设置USER_ID或在配置文件中设置user_id")
        
        doc = {
            "channel": channel,
            "channelId": str(channel_id),
            "sender": sender,
            "message": message,
            "keywords": keywords if isinstance(keywords, list) else [keywords],
            "time": datetime.utcnow(),
            "messageId": message_id,
            "alerted": bool(keywords),
            "ai_analyzed": False
        }
        
        # 如果有userId，添加到文档中
        if userId:
            doc["userId"] = userId
        
        res = await logs_collection.insert_one(doc)
        return str(res.inserted_id)
    except Exception as e:
        logger.exception("保存日志失败: %s", e)
        return None


# -----------------------
# AI 分析（异步队列）
# -----------------------
async def trigger_ai_analysis_async(sender_id, client, log_id=None):
    # 移除频繁的CPU监控调用
    # log_cpu_usage("AI分析开始")
    """通过异步 HTTP 调用内部 AI 接口，并把结果发回给用户（限制并发）"""
    async with ai_semaphore:
        try:
            payload = {"trigger_type": "user_message"}
            if log_id:
                payload["log_id"] = log_id
            logger.info("触发 AI 分析: log_id=%s", log_id)
            result = await post_json(f"{API_URL}/api/internal/ai/analyze-now", payload, timeout=120)
            if not result:
                logger.warning("AI 分析无结果")
                return
            if result.get("success"):
                analysis = result.get("analysis", {})
                summary = (
                    "🤖 AI 分析结果\n\n"
                    f"📊 分析消息数: {result.get('message_count', 0)}\n\n"
                    f"整体情感: {analysis.get('sentiment', 'unknown')} (score={analysis.get('sentiment_score', 0)})\n\n"
                    f"风险等级: {analysis.get('risk_level', 'unknown')}\n\n"
                    f"摘要:\n{analysis.get('summary', '无')}\n\n"
                    f"关键词: {', '.join(analysis.get('keywords', []))}"
                )
                try:
                    # 发送给用户（非阻塞）
                    await client.send_message(int(sender_id), summary)
                    logger.info("AI 分析结果已发送给 %s", sender_id)
                    return True
                except Exception as e:
                    logger.exception("发送 AI 结果失败: %s", e)
            else:
                logger.warning("AI 分析返回失败: %s", result.get("error"))
        except Exception as e:
            logger.exception("触发 AI 分析异常: %s", e)
        return False


# -----------------------
# 消息通知（异步，触发前端SSE推送）
# -----------------------
async def notify_new_message_async(log_id, channel, channel_id, sender, message, keywords, alerted):
    """通知后端有新消息，触发SSE推送（非阻塞，不等待结果）"""
    try:
        payload = {
            "log_id": log_id,
            "channel": channel,
            "channelId": str(channel_id),
            "sender": sender,
            "message": message,
            "keywords": keywords if isinstance(keywords, list) else [keywords] if keywords else [],
            "time": datetime.utcnow().isoformat(),
            "alerted": alerted
        }
        # 使用内部API，不需要认证，超时时间短，失败不影响主流程
        # silent=True: 连接失败时只记录 DEBUG，不记录 ERROR/WARNING
        await post_json(f"{API_URL}/api/internal/message-notify", payload, timeout=3, silent=True)
    except Exception as e:
        # 静默失败，不影响主流程（额外保护层）
        logger.debug("通知新消息失败（不影响功能）: %s", e)


# -----------------------
# 告警发送（异步）
# -----------------------
async def send_alert_async(keyword, message, sender, channel, channel_id, message_id):
    async with alert_semaphore:
        # 获取userId用于告警推送
        userId = None
        if USER_ID:
            try:
                from bson import ObjectId
                userId = str(ObjectId(USER_ID))
            except Exception:
                pass
        
        # 如果配置文件中有user_id，也尝试获取
        if not userId:
            config = CONFIG_CACHE or default_config()
            config_user_id = config.get("user_id")
            if config_user_id:
                try:
                    from bson import ObjectId
                    userId = str(ObjectId(config_user_id))
                except Exception:
                    pass
        
        payload = {
            "keyword": keyword,
            "message": message,
            "from": sender,
            "channel": channel,
            "channelId": str(channel_id),
            "messageId": message_id
        }
        
        # 如果有userId，添加到payload中
        if userId:
            payload["userId"] = userId
        
        logger.info("发送告警到 API: %s (userId: %s)", keyword, userId or "未设置")
        # 使用内部API，不需要认证
        result = await post_json(f"{API_URL}/api/internal/alert/push", payload, timeout=10)
        if result is not None:
            logger.info("告警发送成功: %s", keyword)
        else:
            logger.warning("告警发送失败: %s", keyword)


# -----------------------
# Telegram消息发送（异步）
# -----------------------
async def send_telegram_message_async(target: str, message: str) -> bool:
    """
    发送Telegram消息到指定目标
    :param target: 目标（用户名、手机号或用户ID）
    :param message: 消息内容
    :return: 是否发送成功
    """
    global telegram_client
    if not telegram_client:
        logger.warning("⚠️ Telegram客户端未初始化，无法发送消息")
        return False
    
    try:
        if not telegram_client.is_connected():
            await telegram_client.connect()
        
        # 尝试通过用户名或手机号获取实体
        try:
            entity = await telegram_client.get_entity(target)
        except Exception as e:
            logger.error("❌ 无法找到目标用户/群组 %s: %s", target, str(e))
            return False
        
        # 发送消息
        await telegram_client.send_message(entity, message)
        logger.info("✅ Telegram消息已发送到: %s", target)
        return True
    except Exception as e:
        logger.error("❌ 发送Telegram消息失败: %s", str(e))
        return False


# -----------------------
# HTTP服务器用于接收发送消息请求
# -----------------------
async def handle_send_telegram(request):
    """处理发送Telegram消息的HTTP请求"""
    try:
        data = await request.json()
        target = data.get("target")
        message = data.get("message")
        
        if not target or not message:
            return web.json_response({"error": "缺少必要字段：target 和 message"}, status=400)
        
        success = await send_telegram_message_async(target, message)
        if success:
            return web.json_response({"status": "ok", "message": "消息已发送"})
        else:
            return web.json_response({"error": "发送失败"}, status=500)
    except Exception as e:
        logger.error("处理发送Telegram消息请求失败: %s", str(e))
        return web.json_response({"error": str(e)}, status=500)


async def handle_config_reload(request):
    """处理配置重载通知的HTTP请求"""
    try:
        # 立即重新加载配置
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, load_config_sync)
        logger.info("✅ 收到配置重载通知，配置已立即重新加载")
        return web.json_response({"status": "ok", "message": "配置已重新加载"})
    except Exception as e:
        logger.error("处理配置重载通知失败: %s", str(e))
        return web.json_response({"error": str(e)}, status=500)


# -----------------------
# 消息处理器（非阻塞 / 轻量）
# -----------------------
async def message_handler(event, client):
    # 移除频繁的CPU监控调用，避免每条消息都触发CPU检查导致峰值
    # log_cpu_usage("消息处理开始")
    try:
        # 记录消息接收时间（用于调试延迟问题）
        message_received_time = datetime.utcnow()
        message_event_time = getattr(event.message, 'date', None) if hasattr(event, 'message') and event.message else None
        
        # use cached config only (no IO here)
        config = CONFIG_CACHE or default_config()
        log_all = bool(config.get("log_all_messages", False))

        text = event.raw_text or ""
        if not text:
            return

        chat = await event.get_chat()
        channel_id = str(chat.id)
        channel_name = getattr(chat, "title", None) or getattr(chat, "username", None) or "Unknown"

        # check channel filter
        monitored_channels = config.get("channels", []) or []
        if monitored_channels and channel_id not in monitored_channels:
            return

        # sender info
        sender_entity = None
        try:
            sender_entity = await event.get_sender()
        except Exception:
            sender_entity = None

        sender = "Unknown"
        if sender_entity:
            first_name = getattr(sender_entity, "first_name", None)
            last_name = getattr(sender_entity, "last_name", None)
            username = getattr(sender_entity, "username", None)
            full_name = " ".join([n for n in [first_name, last_name] if n]) if (first_name or last_name) else None
            if full_name:
                sender = f"{full_name} (@{username})" if username else full_name
            elif username:
                sender = f"@{username}"
            else:
                sender = str(getattr(sender_entity, "id", "Unknown"))
        else:
            sid = getattr(event, "sender_id", None)
            sender = str(sid) if sid else channel_name

        sender_id = None
        if sender_entity:
            sender_id = getattr(sender_entity, "id", None)
        if not sender_id:
            sender_id = getattr(event, "sender_id", None)

        # ai trigger users normalize
        ai_analysis_config = config.get("ai_analysis", {})
        ai_trigger_enabled = ai_analysis_config.get("ai_trigger_enabled", False)
        ai_trigger_users = ai_analysis_config.get("ai_trigger_users", []) or []
        if isinstance(ai_trigger_users, str):
            ai_trigger_users = [u.strip() for u in ai_trigger_users.splitlines() if u.strip()]

        # 调试日志：显示AI触发配置状态
        if ai_trigger_enabled:
            logger.info("🔍 [AI触发] 功能已启用，触发用户列表: %s", ai_trigger_users)
        else:
            logger.debug("🔍 [AI触发] 功能未启用")

        is_trigger_user = False
        if ai_trigger_enabled and ai_trigger_users and sender_id:
            full_name = None
            if sender_entity:
                first_name = getattr(sender_entity, "first_name", None)
                last_name = getattr(sender_entity, "last_name", None)
                full_name = " ".join([n for n in [first_name, last_name] if n]) if (first_name or last_name) else None

            sender_triggers = [
                str(sender_id),
                f"@{getattr(sender_entity, 'username', '')}" if sender_entity and getattr(sender_entity, "username", None) else None,
                full_name,
                sender
            ]
            sender_triggers = [str(s).strip() for s in sender_triggers if s]
            
            # 规范化触发用户列表（去除空白）
            normalized_trigger_users = [str(u).strip() for u in ai_trigger_users]
            
            # 检查是否匹配（支持大小写不敏感匹配）
            for trigger in normalized_trigger_users:
                for sender_trigger in sender_triggers:
                    if trigger.lower() == sender_trigger.lower() or trigger == sender_trigger:
                        is_trigger_user = True
                        logger.info("✅ 检测到触发用户匹配: %s (触发列表: %s, 发送者: %s)", trigger, normalized_trigger_users, sender_triggers)
                        break
                if is_trigger_user:
                    break

        # keyword checks (cheap)
        matched_keywords = [k for k in (config.get("keywords") or []) if k.lower() in text.lower()]

        # alert keywords (first-match)
        alert_keyword = None
        alert_keywords_list = config.get("alert_keywords") or []
        if alert_keywords_list:
            logger.debug("🔍 [关键词检查] 告警关键词列表: %s", alert_keywords_list)
        for keyword in alert_keywords_list:
            if keyword.lower() in text.lower():
                alert_keyword = keyword
                matched_keywords.append(keyword)
                logger.info("🔔 [告警关键词匹配] 匹配到告警关键词: %s", keyword)
                break

        # compiled regex (precompiled at config load)
        if not alert_keyword and COMPILED_ALERT_REGEX:
            logger.debug("🔍 [关键词检查] 检查告警正则表达式 (%d 个)", len(COMPILED_ALERT_REGEX))
            for pattern in COMPILED_ALERT_REGEX:
                if pattern.search(text):
                    alert_keyword = pattern.pattern
                    matched_keywords.append(f"regex:{pattern.pattern}")
                    logger.info("🔔 [告警正则匹配] 匹配到告警正则: %s", pattern.pattern)
                    break

        # save log if needed (async)
        if matched_keywords or log_all:
            log_id = await save_log_async(channel_name, channel_id, sender, text, matched_keywords or [], event.id)
            if matched_keywords:
                logger.info("监控触发 | %s | %s", channel_name, matched_keywords)
            elif log_all:
                logger.info("已记录消息（全量）| %s", channel_name)

            # 通知后端有新消息（触发SSE推送）
            if log_id:
                asyncio.create_task(notify_new_message_async(
                    log_id, channel_name, channel_id, sender, text, 
                    matched_keywords or [], bool(matched_keywords)
                ))

            # trigger AI analysis (async, limited)
            if is_trigger_user and log_id:
                # schedule but don't await; concurrency controlled inside function
                asyncio.create_task(trigger_ai_analysis_async(sender_id, client, log_id))

            # send alert (async)
            # 告警发送统一通过后端API处理，包括Telegram、邮件、Webhook等
            if alert_keyword:
                logger.info("🔔 [告警触发] 检测到告警关键词: %s，准备发送告警 (频道: %s, 发送者: %s)", alert_keyword, channel_name, sender)
                asyncio.create_task(send_alert_async(alert_keyword, text, sender, channel_name, channel_id, event.id))
    except Exception:
        logger.exception("处理消息失败")
    # 移除频繁的CPU监控调用，避免每条消息都触发CPU检查导致峰值
    # log_cpu_usage("消息处理结束")


# -----------------------
# main 启动
# -----------------------
async def main():

    global http_session

    # 自动建立 Mongo 索引（如果不存在）
    ensure_indexes()

    # create aiohttp session (需要先创建，才能获取用户配置)
    http_session = aiohttp.ClientSession()

    # 首先加载配置文件，检查是否有 user_id
    await asyncio.get_event_loop().run_in_executor(None, load_config_sync)
    cfg = CONFIG_CACHE or default_config()
    
    # 优先从配置文件读取 user_id，如果没有则使用环境变量
    active_user_id = cfg.get("user_id") or USER_ID
    if active_user_id:
        logger.info("📋 使用用户ID: %s (来源: %s)", active_user_id, "配置文件" if cfg.get("user_id") else "环境变量")
    
    # 尝试从用户配置中获取 API_ID 和 API_HASH
    cfg_api_id = ENV_API_ID or 0
    cfg_api_hash = ENV_API_HASH or ""
    
    # 如果配置文件中有 Telegram API 配置，优先使用
    if cfg.get("telegram", {}).get("api_id") and cfg.get("telegram", {}).get("api_hash"):
        cfg_api_id = int(str(cfg.get("telegram", {}).get("api_id", 0)) or "0")
        cfg_api_hash = str(cfg.get("telegram", {}).get("api_hash", "") or "")
        logger.info("✅ 从配置文件获取 Telegram API 配置")
    
    # 如果设置了用户ID，尝试从后端 API 获取用户配置（优先级最高）
    if active_user_id and (cfg_api_id == 0 or not cfg_api_hash):
        try:
            logger.info("从后端 API 获取用户配置 (USER_ID: %s)", active_user_id)
            user_config_url = f"{API_URL}/api/internal/user-config/{active_user_id}"
            user_config = await get_json(user_config_url, timeout=5)
            
            if user_config and user_config.get("telegram"):
                user_api_id = user_config.get("telegram", {}).get("api_id", 0)
                user_api_hash = user_config.get("telegram", {}).get("api_hash", "")
                
                if user_api_id and user_api_hash:
                    cfg_api_id = int(str(user_api_id) or "0") or cfg_api_id
                    cfg_api_hash = str(user_api_hash or "") or cfg_api_hash
                    logger.info("✅ 已从用户配置中获取 API_ID 和 API_HASH (USER_ID: %s)", active_user_id)
                else:
                    logger.warning("⚠️  用户配置中没有设置 API_ID/API_HASH，使用环境变量或全局配置 (USER_ID: %s)", active_user_id)
            else:
                logger.warning("⚠️  无法获取用户配置，使用环境变量或全局配置 (USER_ID: %s)", active_user_id)
        except Exception as e:
            logger.warning("⚠️  获取用户配置失败，使用环境变量或全局配置: %s", str(e))
    
    # 如果还没有获取到，尝试从全局配置文件读取
    if cfg_api_id == 0 or not cfg_api_hash:
        if cfg_api_id == 0:
            cfg_api_id = int(str(cfg.get("telegram", {}).get("api_id", 0)) or "0") or ENV_API_ID or 0
        if not cfg_api_hash:
            cfg_api_hash = str(cfg.get("telegram", {}).get("api_hash", "") or "") or ENV_API_HASH or ""

    if cfg_api_id == 0 or not cfg_api_hash:
        logger.error("❌ 未配置 API_ID/API_HASH，请在以下位置之一设置：")
        logger.error("   1. 环境变量 API_ID 和 API_HASH")
        logger.error("   2. 用户配置中（如果设置了 USER_ID）")
        logger.error("   3. 全局配置文件 %s", CONFIG_PATH)
        return

    logger.info("📱 使用 API_ID: %s", cfg_api_id)

    # create telethon client
    session_file = None
    if SESSION_STRING:
        client = TelegramClient(StringSession(SESSION_STRING), cfg_api_id, cfg_api_hash)
    else:
        # 如果设置了用户ID，使用用户特定的 session 文件
        if active_user_id:
            session_file = f"{SESSION_PATH}_{active_user_id}"
            logger.info("使用用户专属 Session 文件: %s", session_file)
            client = TelegramClient(session_file, cfg_api_id, cfg_api_hash)
        else:
            session_file = SESSION_PATH
            client = TelegramClient(SESSION_PATH, cfg_api_id, cfg_api_hash)
    
    # 检查 session 文件是否存在（如果使用文件 session）
    if session_file and not SESSION_STRING:
        # Telethon 使用 .session 扩展名
        # 如果传入路径是 /app/session/telegram_xxx，实际文件是 /app/session/telegram_xxx.session
        session_path_with_ext = f"{session_file}.session"
        
        # 详细日志：检查文件路径和存在性
        logger.info("🔍 [Session 检查] 开始检查 session 文件...")
        logger.info("🔍 [Session 检查] 基础路径: %s", session_file)
        logger.info("🔍 [Session 检查] 完整路径（带扩展名）: %s", session_path_with_ext)
        logger.info("🔍 [Session 检查] 基础路径存在: %s", os.path.exists(session_file))
        logger.info("🔍 [Session 检查] 完整路径存在: %s", os.path.exists(session_path_with_ext))
        
        # 如果目录存在，列出目录内容
        session_dir = os.path.dirname(session_file)
        if os.path.exists(session_dir):
            logger.info("🔍 [Session 检查] Session 目录存在: %s", session_dir)
            try:
                dir_contents = os.listdir(session_dir)
                logger.info("🔍 [Session 检查] 目录内容: %s", dir_contents)
            except Exception as e:
                logger.warning("🔍 [Session 检查] 无法列出目录内容: %s", e)
        else:
            logger.warning("🔍 [Session 检查] Session 目录不存在: %s", session_dir)
        
        # 如果文件存在，检查文件权限和大小
        if os.path.exists(session_path_with_ext):
            try:
                file_stat = os.stat(session_path_with_ext)
                logger.info("🔍 [Session 检查] Session 文件大小: %d 字节", file_stat.st_size)
                logger.info("🔍 [Session 检查] Session 文件权限: %o", file_stat.st_mode & 0o777)
                logger.info("🔍 [Session 检查] Session 文件修改时间: %s", datetime.fromtimestamp(file_stat.st_mtime))
            except Exception as e:
                logger.warning("🔍 [Session 检查] 无法获取文件信息: %s", e)
        
        session_exists = os.path.exists(session_file) or os.path.exists(session_path_with_ext)
        logger.info("🔍 [Session 检查] Session 文件存在性检查结果: %s", session_exists)
        
        if not session_exists:
            logger.error("")
            logger.error("=" * 60)
            logger.error("❌ Session 文件不存在")
            logger.error("   预期路径: %s", session_file)
            logger.error("   或: %s", session_path_with_ext)
            logger.error("")
            logger.error("📱 请先登录 Telegram 才能开始监控消息：")
            logger.error("   1. 访问 Web 界面")
            logger.error("   2. 进入 '设置' 标签")
            logger.error("   3. 点击 'Telegram 首次登录' 按钮")
            logger.error("   4. 按照提示完成登录（输入手机号和验证码）")
            logger.error("   5. 登录成功后，重启 Telethon 服务：")
            logger.error("      docker compose restart telethon")
            logger.error("")
            logger.error("⚠️  服务将退出，请完成登录后重启服务")
            logger.error("=" * 60)
            logger.error("")
            # 使用 sys.exit(1) 非正常退出，触发 on-failure 重启策略
            # 但限制重启次数，避免无限重启
            import sys
            sys.exit(1)

    # 启动客户端（使用安全的方式避免交互式输入）
    try:
        logger.info("🔍 [客户端启动] 开始连接 Telegram 客户端...")
        logger.info("🔍 [客户端启动] Session 文件路径: %s", session_file if session_file else "StringSession")
        logger.info("🔍 [客户端启动] API_ID: %s", cfg_api_id)
        logger.info("🔍 [客户端启动] API_HASH: %s", "已设置" if cfg_api_hash else "未设置")
        
        # 如果使用文件 session，在启动前等待一小段时间确保文件完全同步
        if session_file and not SESSION_STRING:
            import time
            # 检查 session 文件是否存在，如果存在但刚修改过，等待一下
            session_path_with_ext = f"{session_file}.session"
            if os.path.exists(session_path_with_ext):
                file_mtime = os.path.getmtime(session_path_with_ext)
                time_since_modify = time.time() - file_mtime
                # 如果文件在最近 5 秒内被修改，等待 2 秒确保完全同步
                if time_since_modify < 5:
                    logger.info("🔍 [客户端启动] Session 文件最近被修改（%d 秒前），等待 2 秒确保同步...", int(time_since_modify))
                    await asyncio.sleep(2.0)
        
        # 先连接（不触发交互式输入）
        logger.info("🔍 [客户端启动] 正在连接到 Telegram 服务器...")
        await client.connect()
        logger.info("✅ [客户端启动] 已连接到 Telegram 服务器")
        
        # 在启动前，先尝试检查 session 文件是否可以读取
        if session_file and not SESSION_STRING:
            session_path_with_ext = f"{session_file}.session"
            if os.path.exists(session_path_with_ext):
                try:
                    # 尝试读取 session 文件的前几个字节，验证文件是否可读
                    with open(session_path_with_ext, 'rb') as f:
                        header = f.read(16)
                        logger.info("🔍 [授权检查] Session 文件可读，文件头: %s", header.hex() if header else "空文件")
                        if len(header) == 0:
                            logger.warning("⚠️  [授权检查] Session 文件为空！")
                except Exception as read_error:
                    logger.warning("⚠️  [授权检查] 无法读取 Session 文件: %s", str(read_error))
        
        # 先检查授权状态，避免不必要的 start() 调用
        logger.info("🔍 [授权检查] 检查用户是否已授权...")
        logger.info("🔍 [授权检查] 使用的 API_ID: %s", cfg_api_id)
        logger.info("🔍 [授权检查] 使用的 API_HASH: %s", "已设置" if cfg_api_hash else "未设置")
        logger.info("🔍 [授权检查] Session 文件路径: %s", session_file if session_file else "StringSession")
        
        # 详细记录 session 文件信息
        if session_file and not SESSION_STRING:
            session_path_with_ext = f"{session_file}.session"
            logger.info("🔍 [授权检查] Session 文件完整路径: %s", session_path_with_ext)
            if os.path.exists(session_path_with_ext):
                file_stat = os.stat(session_path_with_ext)
                logger.info("🔍 [授权检查] Session 文件大小: %d 字节", file_stat.st_size)
                logger.info("🔍 [授权检查] Session 文件修改时间: %s", datetime.fromtimestamp(file_stat.st_mtime))
            else:
                logger.warning("⚠️  [授权检查] Session 文件不存在: %s", session_path_with_ext)
        
        # 先尝试检查授权状态
        is_authorized = False
        try:
            is_authorized = await client.is_user_authorized()
            logger.info("🔍 [授权检查] 授权状态: %s", is_authorized)
        except Exception as auth_check_ex:
            logger.warning("⚠️  [授权检查] 检查授权状态时出错: %s，将尝试启动客户端验证", str(auth_check_ex))
            # 如果检查授权状态失败，继续尝试启动客户端
        
        # 如果授权检查返回 False，尝试启动客户端验证（因为 is_user_authorized() 可能不准确）
        if not is_authorized:
            logger.info("🔍 [授权检查] 授权状态为 False，尝试启动客户端验证 session 是否有效...")
            
            # 在启动前，检查 session 文件的完整性
            if session_file and not SESSION_STRING:
                session_path_with_ext = f"{session_file}.session"
                if os.path.exists(session_path_with_ext):
                    try:
                        file_stat = os.stat(session_path_with_ext)
                        logger.info("🔍 [授权检查] Session 文件大小: %d 字节", file_stat.st_size)
                        if file_stat.st_size < 1000:
                            logger.warning("⚠️  [授权检查] Session 文件过小（%d 字节），可能不完整", file_stat.st_size)
                        # 尝试读取文件头验证文件格式
                        with open(session_path_with_ext, 'rb') as f:
                            header = f.read(16)
                            if header.startswith(b'SQLite format 3'):
                                logger.info("🔍 [授权检查] Session 文件格式正确（SQLite）")
                            else:
                                logger.warning("⚠️  [授权检查] Session 文件格式异常，文件头: %s", header.hex()[:32])
                    except Exception as file_check_error:
                        logger.warning("⚠️  [授权检查] 检查 session 文件时出错: %s", str(file_check_error))
            
            # 尝试启动客户端，最多重试 2 次
            max_retries = 2
            retry_count = 0
            start_success = False
            
            while retry_count < max_retries and not start_success:
                try:
                    if retry_count > 0:
                        logger.info("🔍 [授权检查] 重试启动客户端（第 %d 次）...", retry_count + 1)
                        # 重新连接
                        if client.is_connected():
                            await client.disconnect()
                        await asyncio.sleep(1)  # 等待 1 秒后重试
                        await client.connect()
                    
                    # 尝试启动客户端，如果成功说明 session 有效
                    await client.start()
                    logger.info("✅ [授权检查] 客户端启动成功，session 有效（is_user_authorized() 可能不准确）")
                    is_authorized = True
                    start_success = True
                except RpcError as rpc_error:
                    # 检查是否是 AUTH_KEY_UNREGISTERED 错误
                    if hasattr(rpc_error, 'code') and rpc_error.code == 401:
                        # AUTH_KEY_UNREGISTERED 错误，说明 session 文件中的认证密钥无效
                        retry_count = max_retries  # 直接标记为失败，不重试
                        logger.error("🔍 [授权检查] AUTH_KEY_UNREGISTERED 错误: %s", str(rpc_error))
                        logger.error("🔍 [授权检查] Session 文件路径: %s", session_file if session_file else "StringSession")
                        logger.error("🔍 [授权检查] API_ID: %s", cfg_api_id)
                        logger.error("🔍 [授权检查] API_HASH: %s", "已设置" if cfg_api_hash else "未设置")
                        
                        # 检查 session 文件是否存在且可读
                        if session_file and not SESSION_STRING:
                            session_path_with_ext = f"{session_file}.session"
                            if os.path.exists(session_path_with_ext):
                                logger.error("🔍 [授权检查] Session 文件存在但认证密钥未注册，可能原因：")
                                logger.error("   1. Session 文件中的认证密钥已过期或无效")
                                logger.error("   2. Session 文件是用不同的 API_ID/API_HASH 创建的")
                                logger.error("   3. Session 文件内容损坏或不完整")
                                logger.error("   4. Session 文件在写入时没有完全同步")
                                logger.error("   建议：删除旧的 session 文件后重新登录")
                            else:
                                logger.error("🔍 [授权检查] Session 文件不存在: %s", session_path_with_ext)
                        
                        await client.disconnect()
                        logger.error("")
                        logger.error("=" * 60)
                        logger.error("❌ Telegram 客户端未授权，Session 文件中的认证密钥无效")
                        logger.error("")
                        logger.error("📱 请先登录 Telegram 才能开始监控消息：")
                        logger.error("   1. 访问 Web 界面")
                        logger.error("   2. 进入 '设置' 标签")
                        logger.error("   3. 点击 'Telegram 首次登录' 按钮")
                        logger.error("   4. 按照提示完成登录（输入手机号和验证码）")
                        logger.error("   5. 登录成功后，重启 Telethon 服务：")
                        logger.error("      docker compose restart telethon")
                        logger.error("")
                        logger.error("⚠️  服务将退出，请完成登录后重启服务")
                        logger.error("=" * 60)
                        logger.error("")
                        import sys
                        sys.exit(1)
                    else:
                        # 其他 RpcError，可能是网络问题或其他错误
                        retry_count += 1
                        if retry_count >= max_retries:
                            logger.warning("⚠️  [授权检查] RpcError: %s，但继续尝试检查授权状态", str(rpc_error))
                        else:
                            logger.warning("⚠️  [授权检查] RpcError（第 %d 次尝试）: %s，将重试...", retry_count, str(rpc_error))
                except EOFError as eof_error:
                    # EOFError 表示尝试了交互式输入，说明 session 无效
                    retry_count += 1
                    if retry_count >= max_retries:
                        logger.error("🔍 [授权检查] EOFError 详情: %s", str(eof_error))
                        logger.error("🔍 [授权检查] Session 文件路径: %s", session_file if session_file else "StringSession")
                        logger.error("🔍 [授权检查] API_ID: %s", cfg_api_id)
                        logger.error("🔍 [授权检查] API_HASH: %s", "已设置" if cfg_api_hash else "未设置")
                        
                        # 检查 session 文件是否存在且可读
                        if session_file and not SESSION_STRING:
                            session_path_with_ext = f"{session_file}.session"
                            if os.path.exists(session_path_with_ext):
                                logger.error("🔍 [授权检查] Session 文件存在但无法使用，可能原因：")
                                logger.error("   1. Session 文件是用不同的 API_ID/API_HASH 创建的")
                                logger.error("   2. Session 文件内容损坏或不完整")
                                logger.error("   3. Session 文件在写入时没有完全同步")
                                logger.error("   建议：删除旧的 session 文件后重新登录")
                            else:
                                logger.error("🔍 [授权检查] Session 文件不存在: %s", session_path_with_ext)
                        
                        await client.disconnect()
                        logger.error("")
                        logger.error("=" * 60)
                        logger.error("❌ Telegram 客户端未授权，Session 文件无效或不存在")
                        logger.error("")
                        logger.error("📱 请先登录 Telegram 才能开始监控消息：")
                        logger.error("   1. 访问 Web 界面")
                        logger.error("   2. 进入 '设置' 标签")
                        logger.error("   3. 点击 'Telegram 首次登录' 按钮")
                        logger.error("   4. 按照提示完成登录（输入手机号和验证码）")
                        logger.error("   5. 登录成功后，重启 Telethon 服务：")
                        logger.error("      docker compose restart telethon")
                        logger.error("")
                        logger.error("⚠️  服务将退出，请完成登录后重启服务")
                        logger.error("=" * 60)
                        logger.error("")
                        import sys
                        sys.exit(1)
                    else:
                        logger.warning("⚠️  [授权检查] EOFError（第 %d 次尝试），将重试...", retry_count)
                except Exception as start_error:
                    retry_count += 1
                    if retry_count >= max_retries:
                        # 其他错误，可能是网络问题或其他错误
                        logger.warning("⚠️  [授权检查] 启动客户端失败: %s，但继续尝试检查授权状态", str(start_error))
                        # 再次检查授权状态
                        try:
                            is_authorized = await client.is_user_authorized()
                            logger.info("🔍 [授权检查] 重新检查授权状态: %s", is_authorized)
                        except Exception:
                            pass
                    else:
                        logger.warning("⚠️  [授权检查] 启动失败（第 %d 次尝试）: %s，将重试...", retry_count, str(start_error))
        
        if not is_authorized:
            await client.disconnect()
            logger.error("")
            logger.error("=" * 60)
            logger.error("❌ Telegram 客户端未授权，Session 文件无效或不存在")
            logger.error("")
            logger.error("📱 请先登录 Telegram 才能开始监控消息：")
            logger.error("   1. 访问 Web 界面")
            logger.error("   2. 进入 '设置' 标签")
            logger.error("   3. 点击 'Telegram 首次登录' 按钮")
            logger.error("   4. 按照提示完成登录（输入手机号和验证码）")
            logger.error("   5. 登录成功后，重启 Telethon 服务：")
            logger.error("      docker compose restart telethon")
            logger.error("")
            logger.error("⚠️  服务将退出，请完成登录后重启服务")
            logger.error("=" * 60)
            logger.error("")
            import sys
            sys.exit(1)
        
        # 如果已授权但还未启动，使用 start() 方法启动客户端
        if not client.is_connected():
            await client.connect()
        
        # 检查客户端是否已经启动（如果之前已经启动过，就不需要再次启动）
        client_started = False
        try:
            # 尝试获取用户信息，如果成功说明已经启动
            me = await client.get_me()
            logger.info("✅ [授权检查] 客户端已启动，已登录为: %s (ID: %s)", getattr(me, "username", None) or getattr(me, "first_name", None), me.id)
            client_started = True
        except Exception:
            # 如果获取用户信息失败，说明需要启动客户端
            logger.info("🔍 [授权检查] 客户端已连接但未启动，尝试启动客户端...")
            try:
                await client.start()
                logger.info("✅ [授权检查] 客户端启动成功，session 有效")
                client_started = True
            except EOFError as eof_error:
                # EOFError 表示尝试了交互式输入，说明 session 无效
                logger.error("🔍 [授权检查] EOFError 详情: %s", str(eof_error))
            import traceback
            logger.error("🔍 [授权检查] EOFError 堆栈: %s", traceback.format_exc())
            await client.disconnect()
            logger.error("")
            logger.error("=" * 60)
            logger.error("❌ Telegram 客户端未授权，Session 文件无效或不存在")
            logger.error("")
            logger.error("📱 请先登录 Telegram 才能开始监控消息：")
            logger.error("   1. 访问 Web 界面")
            logger.error("   2. 进入 '设置' 标签")
            logger.error("   3. 点击 'Telegram 首次登录' 按钮")
            logger.error("   4. 按照提示完成登录（输入手机号和验证码）")
            logger.error("   5. 登录成功后，重启 Telethon 服务：")
            logger.error("      docker compose restart telethon")
            logger.error("")
            logger.error("⚠️  服务将退出，请完成登录后重启服务")
            logger.error("=" * 60)
            logger.error("")
            # 使用 sys.exit(1) 非正常退出，触发 on-failure 重启策略
            import sys
            sys.exit(1)
        except Exception as start_error:
            # 其他异常，可能是网络问题或其他错误
            # 尝试检查授权状态作为备用方案
            logger.warning("⚠️  [授权检查] start() 失败: %s，尝试检查授权状态...", str(start_error))
            try:
                is_authorized = await client.is_user_authorized()
                logger.info("🔍 [授权检查] 授权状态: %s", is_authorized)
                
                if not is_authorized:
                    await client.disconnect()
                    logger.error("")
                    logger.error("=" * 60)
                    logger.error("❌ Telegram 客户端未授权，Session 文件无效或不存在")
                    logger.error("")
                    logger.error("📱 请先登录 Telegram 才能开始监控消息：")
                    logger.error("   1. 访问 Web 界面")
                    logger.error("   2. 进入 '设置' 标签")
                    logger.error("   3. 点击 'Telegram 首次登录' 按钮")
                    logger.error("   4. 按照提示完成登录（输入手机号和验证码）")
                    logger.error("   5. 登录成功后，重启 Telethon 服务：")
                    logger.error("      docker compose restart telethon")
                    logger.error("")
                    logger.error("⚠️  服务将退出，请完成登录后重启服务")
                    logger.error("=" * 60)
                    logger.error("")
                    import sys
                    sys.exit(1)
                else:
                    # 如果授权状态为 True，但 start() 失败，可能是其他问题
                    # 尝试重新连接并启动
                    logger.warning("⚠️  [授权检查] 授权状态为 True，但 start() 失败，尝试重新连接...")
                    if not client.is_connected():
                        await client.connect()
                    await client.start()
            except Exception as auth_check_error:
                # 检查授权状态也失败，说明 session 确实有问题
                await client.disconnect()
                logger.error("")
                logger.error("=" * 60)
                logger.error("❌ 无法验证 Telegram 客户端授权状态")
                logger.error("🔍 [错误详情] start() 错误: %s", str(start_error))
                logger.error("🔍 [错误详情] 授权检查错误: %s", str(auth_check_error))
                logger.error("")
                logger.error("📱 请先登录 Telegram 才能开始监控消息：")
                logger.error("   1. 访问 Web 界面")
                logger.error("   2. 进入 '设置' 标签")
                logger.error("   3. 点击 'Telegram 首次登录' 按钮")
                logger.error("   4. 按照提示完成登录（输入手机号和验证码）")
                logger.error("   5. 登录成功后，重启 Telethon 服务：")
                logger.error("      docker compose restart telethon")
                logger.error("")
                logger.error("⚠️  服务将退出，请完成登录后重启服务")
                logger.error("=" * 60)
                logger.error("")
                import sys
                sys.exit(1)
    except EOFError as e:
        # 如果遇到 EOFError，说明尝试了交互式输入（session 无效或不存在）
        logger.error("=" * 60)
        logger.error("❌ Session 文件无效，无法启动服务（EOFError）")
        logger.error("🔍 [错误详情] EOFError: %s", str(e))
        logger.error("🔍 [错误详情] Session 文件路径: %s", session_file if session_file else "StringSession")
        logger.error("📱 请先登录 Telegram 才能开始监控消息：")
        logger.error("   1. 访问 Web 界面")
        logger.error("   2. 进入 '设置' 标签")
        logger.error("   3. 点击 'Telegram 首次登录' 按钮")
        logger.error("   4. 按照提示完成登录")
        logger.error("   5. 登录成功后，重启 Telethon 服务：docker compose restart telethon")
        logger.error("=" * 60)
        import sys
        sys.exit(1)
    except Exception as e:
        logger.error("=" * 60)
        logger.error("❌ 启动 Telegram 客户端失败: %s", str(e))
        logger.error("🔍 [错误详情] 异常类型: %s", type(e).__name__)
        logger.error("🔍 [错误详情] Session 文件路径: %s", session_file if session_file else "StringSession")
        logger.error("🔍 [错误详情] API_ID: %s", cfg_api_id)
        logger.error("🔍 [错误详情] API_HASH: %s", "已设置" if cfg_api_hash else "未设置")
        import traceback
        logger.error("🔍 [错误详情] 完整堆栈:\n%s", traceback.format_exc())
        logger.error("📱 请先登录 Telegram 才能开始监控消息：")
        logger.error("   1. 访问 Web 界面")
        logger.error("   2. 进入 '设置' 标签")
        logger.error("   3. 点击 'Telegram 首次登录' 按钮")
        logger.error("   4. 按照提示完成登录")
        logger.error("   5. 登录成功后，重启 Telethon 服务：docker compose restart telethon")
        logger.error("=" * 60)
        import sys
        sys.exit(1)
    
    client.add_event_handler(lambda e: message_handler(e, client), events.NewMessage())
    me = await client.get_me()
    logger.info("已登录为: %s (ID: %s)", getattr(me, "username", None) or getattr(me, "first_name", None), me.id)

    # 保存Telegram客户端实例用于发送消息
    global telegram_client
    telegram_client = client

    # 启动HTTP服务器用于接收发送消息请求和配置重载通知
    app = web.Application()
    app.router.add_post('/api/internal/telegram/send', handle_send_telegram)
    app.router.add_post('/api/internal/config/reload', handle_config_reload)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', 8888)
    await site.start()
    logger.info("📡 HTTP服务器已启动，监听端口 8888，用于接收Telegram消息发送请求")

    # start config reloader background task
    reloader = asyncio.create_task(config_reloader_task())

    logger.info("Telegram 监听服务已启动，等待消息...")

    # run until disconnected or shutdown requested
    try:
        await client.run_until_disconnected()
    finally:
        SHUTDOWN.set()
        reloader.cancel()
        await runner.cleanup()
        await http_session.close()


# graceful shutdown
def _signal_handler(signame):
    logger.info("收到退出信号 %s，准备关闭...", signame)
    SHUTDOWN.set()


if __name__ == "__main__":
    loop = asyncio.get_event_loop()
    for s in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(s, lambda s=s: _signal_handler(s))
        except NotImplementedError:
            # Windows 上 loop.add_signal_handler 可能不可用
            pass
    try:
        loop.run_until_complete(main())
    except Exception:
        logger.exception("服务异常退出")
    finally:
        logger.info("服务已终止")
