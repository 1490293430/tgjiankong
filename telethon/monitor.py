
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
import aiohttp
import motor.motor_asyncio
from mongo_index_init import ensure_indexes

# -----------------------
# 配置（ENV 或默认）
# -----------------------
CONFIG_PATH = os.getenv("CONFIG_PATH", "/app/config.json")
MONGO_URL = os.getenv("MONGO_URL", "mongodb://mongo:27017")
MONGO_DBNAME = os.getenv("MONGO_DBNAME", "tglogs")
API_URL = os.getenv("API_URL", "http://api:3000")
ENV_API_ID = int(os.getenv("API_ID", "0"))
ENV_API_HASH = os.getenv("API_HASH", "")
SESSION_PATH = os.getenv("SESSION_PATH", "/app/session/telegram")
SESSION_STRING = os.getenv("SESSION_STRING", "").strip()
# 用户ID - 用于数据隔离，从环境变量读取
USER_ID = os.getenv("USER_ID", "").strip()

# 并发限制（可调）
AI_CONCURRENCY = int(os.getenv("AI_CONCURRENCY", "2"))
ALERT_CONCURRENCY = int(os.getenv("ALERT_CONCURRENCY", "4"))

# config reload interval (秒) - 增加到10秒以减少CPU开销
CONFIG_RELOAD_INTERVAL = float(os.getenv("CONFIG_RELOAD_INTERVAL", "10.0"))

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
        payload = {
            "keyword": keyword,
            "message": message,
            "from": sender,
            "channel": channel,
            "channelId": str(channel_id),
            "messageId": message_id
        }
        logger.info("发送告警到 API: %s", keyword)
        result = await post_json(f"{API_URL}/api/alert/push", payload, timeout=10)
        if result is not None:
            logger.info("告警发送成功: %s", keyword)
        else:
            logger.warning("告警发送失败: %s", keyword)


# -----------------------
# 消息处理器（非阻塞 / 轻量）
# -----------------------
async def message_handler(event, client):
    # 移除频繁的CPU监控调用，避免每条消息都触发CPU检查导致峰值
    # log_cpu_usage("消息处理开始")
    try:
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
        ai_trigger_enabled = config.get("ai_analysis", {}).get("ai_trigger_enabled", False)
        ai_trigger_users = config.get("ai_analysis", {}).get("ai_trigger_users", []) or []
        if isinstance(ai_trigger_users, str):
            ai_trigger_users = [u.strip() for u in ai_trigger_users.splitlines() if u.strip()]

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
            sender_triggers = [str(s) for s in sender_triggers if s]
            for trigger in ai_trigger_users:
                if str(trigger).strip() in sender_triggers:
                    is_trigger_user = True
                    break

        # keyword checks (cheap)
        matched_keywords = [k for k in (config.get("keywords") or []) if k.lower() in text.lower()]

        # alert keywords (first-match)
        alert_keyword = None
        for keyword in (config.get("alert_keywords") or []):
            if keyword.lower() in text.lower():
                alert_keyword = keyword
                matched_keywords.append(keyword)
                break

        # compiled regex (precompiled at config load)
        if not alert_keyword:
            for pattern in COMPILED_ALERT_REGEX:
                if pattern.search(text):
                    alert_keyword = pattern.pattern
                    matched_keywords.append(f"regex:{pattern.pattern}")
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
            if alert_keyword:
                asyncio.create_task(send_alert_async(alert_keyword, text, sender, channel_name, channel_id, event.id))

                # send telegram alert message (non-blocking)
                try:
                    target = (config.get("alert_target") or "me").strip() or "me"
                    def _normalize_target(t):
                        ts = str(t).strip()
                        if (ts.isdigit()) or (ts.startswith("-") and ts[1:].isdigit()):
                            try:
                                return int(ts)
                            except Exception:
                                return ts
                        return ts
                    target_id = _normalize_target(target)
                    alert_message = (
                        f"⚠️ 关键词告警触发\n\n来源：{channel_name} ({channel_id})\n发送者：{sender}\n关键词：{alert_keyword}\n时间：{datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')}\n\n消息内容：\n{text[:500]}{'...' if len(text) > 500 else ''}\n"
                    )
                    await client.send_message(target_id, alert_message)
                    logger.info("告警已发送到 Telegram: %s", target)
                except Exception:
                    logger.exception("发送 Telegram 告警失败")
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
    if SESSION_STRING:
        client = TelegramClient(StringSession(SESSION_STRING), cfg_api_id, cfg_api_hash)
    else:
        # 如果设置了用户ID，使用用户特定的 session 文件
        if active_user_id:
            session_file = f"{SESSION_PATH}_{active_user_id}"
            logger.info("使用用户专属 Session 文件: %s", session_file)
            client = TelegramClient(session_file, cfg_api_id, cfg_api_hash)
        else:
            client = TelegramClient(SESSION_PATH, cfg_api_id, cfg_api_hash)

    await client.start()
    client.add_event_handler(lambda e: message_handler(e, client), events.NewMessage())
    me = await client.get_me()
    logger.info("已登录为: %s (ID: %s)", getattr(me, "username", None) or getattr(me, "first_name", None), me.id)

    # start config reloader background task
    reloader = asyncio.create_task(config_reloader_task())

    logger.info("Telegram 监听服务已启动，等待消息...")

    # run until disconnected or shutdown requested
    try:
        await client.run_until_disconnected()
    finally:
        SHUTDOWN.set()
        reloader.cancel()
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
