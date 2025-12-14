
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
import traceback

from telethon import TelegramClient, events
from telethon.sessions import StringSession
import aiohttp
from aiohttp import web
import motor.motor_asyncio
from mongo_index_init import ensure_indexes

# -----------------------
# 配置（ENV 或默认）
# -----------------------
# 兼容多种运行方式（Docker 容器、本地开发）
CONFIG_PATH_ENV = os.getenv("CONFIG_PATH")
DEFAULT_CONFIG_PATH = "/app/config.json"
CONFIG_CANDIDATES = [
    DEFAULT_CONFIG_PATH,
    os.path.join(os.getcwd(), "config.json"),
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend", "config.json")),
]


def resolve_config_path():
    """
    返回配置文件路径：
    - 若设置了 CONFIG_PATH 环境变量，始终优先使用该路径（即使暂时不存在，便于后续写入）。
    - 否则，返回第一个存在的候选路径；若都不存在，则回落到默认路径。
    """
    if CONFIG_PATH_ENV:
        return os.path.abspath(CONFIG_PATH_ENV)
    for candidate in CONFIG_CANDIDATES:
        if candidate and os.path.exists(candidate):
            return os.path.abspath(candidate)
    return os.path.abspath(CONFIG_CANDIDATES[0] or DEFAULT_CONFIG_PATH)


CONFIG_PATH = resolve_config_path()
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
# 使用目录挂载方式，统一路径：/opt/telegram-monitor/data/session
SESSION_BASE_DIR = "/opt/telegram-monitor/data/session"
# 从环境变量获取 SESSION_PREFIX，默认为 "user"
SESSION_PREFIX = os.getenv("SESSION_PREFIX", "user")
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
# 静默连接 MongoDB，不输出日志
mongo_client = motor.motor_asyncio.AsyncIOMotorClient(
    MONGO_URL,
    serverSelectionTimeoutMS=5000,
    connectTimeoutMS=5000,
    socketTimeoutMS=5000
)
db = mongo_client[MONGO_DBNAME]
logs_collection = db["logs"]

# aiohttp session will be created on loop start
http_session: Optional[aiohttp.ClientSession] = None

# config cache and compiled regex
CONFIG_CACHE: Dict[str, Any] = {}
CONFIG_MTIME = 0.0
COMPILED_ALERT_REGEX: List[re.Pattern] = []
KEYWORDS_LC: List[str] = []
ALERT_KEYWORDS_LC: List[str] = []
MONITORED_CHANNELS_SET: set = set()

# async semaphores to limit concurrency for heavy tasks
ai_semaphore = asyncio.Semaphore(AI_CONCURRENCY)
alert_semaphore = asyncio.Semaphore(ALERT_CONCURRENCY)

# shutdown event
SHUTDOWN = asyncio.Event()

# sender 显示名缓存（减少高频消息下重复 get_entity / GetFullUserRequest 的 CPU/网络开销）
SENDER_CACHE_TTL_SEC = float(os.getenv("SENDER_CACHE_TTL_SEC", "3600"))  # 1小时
_SENDER_DISPLAY_CACHE: Dict[str, Any] = {}  # sender_id(str) -> {"sender": str, "ts": float}


# CPU监控 - 使用缓存减少开销，避免频繁调用导致CPU峰值
_cpu_process = None
_cpu_last_check = 0
_cpu_check_interval = 10.0  # 每10秒最多检查一次


# -----------------------
# 工具函数
# -----------------------
def normalize_list(values) -> List[str]:
    """将任意输入转换为去除空白的字符串列表."""
    if values is None:
        return []
    # 已是列表
    if isinstance(values, list):
        result = []
        for v in values:
            s = str(v).strip()
            if s:
                result.append(s)
        return result
    # 如果是字符串，按换行或逗号拆分
    if isinstance(values, str):
        parts = re.split(r"[\n,]", values)
        return [p.strip() for p in parts if p and p.strip()]
    # 其他类型，尝试字符串化
    s = str(values).strip()
    return [s] if s else []

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
        "log_all_messages": True,
        # 控制每条消息的详细调试日志（默认关闭，避免高吞吐时 CPU 被日志打满）
        "debug_verbose_message_logs": False,
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
    global CONFIG_CACHE, CONFIG_MTIME, COMPILED_ALERT_REGEX, CONFIG_PATH
    global KEYWORDS_LC, ALERT_KEYWORDS_LC, MONITORED_CHANNELS_SET
    try:
        # 记录正在加载的配置文件路径
        logger.info("🔍 [配置加载] 开始加载配置文件: %s", CONFIG_PATH)
        
        if not os.path.exists(CONFIG_PATH):
            # 仅当未显式指定 CONFIG_PATH 时才尝试备用路径
            if not CONFIG_PATH_ENV:
                alt_path = resolve_config_path()
                if alt_path != CONFIG_PATH and os.path.exists(alt_path):
                    logger.warning("配置文件不存在，尝试备用路径: %s -> %s", CONFIG_PATH, alt_path)
                    CONFIG_PATH = alt_path
            if not os.path.exists(CONFIG_PATH):
                CONFIG_CACHE = default_config()
                CONFIG_MTIME = 0.0
                COMPILED_ALERT_REGEX = []
                logger.warning("配置文件不存在: %s，使用默认配置（待同步写入）", CONFIG_PATH)
                return

        # 检查路径是否是目录（不应该发生，但如果发生需要处理）
        if os.path.isdir(CONFIG_PATH):
            logger.error("❌ [配置加载] 配置路径是目录而不是文件: %s，无法加载配置", CONFIG_PATH)
            logger.error("   这通常是因为后端创建配置文件时出错，请检查后端日志")
            # 使用默认配置，但记录严重警告
            CONFIG_CACHE = default_config()
            CONFIG_MTIME = 0.0
            COMPILED_ALERT_REGEX = []
            logger.error("   使用默认配置（关键词检测将无法工作），请修复配置文件路径问题")
            return

        mtime = os.path.getmtime(CONFIG_PATH)
        if CONFIG_CACHE and mtime == CONFIG_MTIME:
            logger.debug("🔍 [配置加载] 配置文件未变化，跳过重新加载: %s (mtime: %s)", CONFIG_PATH, mtime)
            return  # no change

        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)

        # normalize fields with defaults
        base = default_config()
        base.update(cfg or {})
        
        # 规范化列表字段，避免 null/对象导致匹配失败
        base["keywords"] = normalize_list(base.get("keywords"))
        base["alert_keywords"] = normalize_list(base.get("alert_keywords"))
        base["channels"] = normalize_list(base.get("channels"))
        base["alert_regex"] = normalize_list(base.get("alert_regex"))
        
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

        logger.info("✅ [配置加载] 配置已加载/更新：keywords=%d alert_keywords=%d regex=%d channels=%d",
                    len(CONFIG_CACHE.get("keywords", [])),
                    len(CONFIG_CACHE.get("alert_keywords", [])),
                    len(COMPILED_ALERT_REGEX),
                    len(CONFIG_CACHE.get("channels", [])))

        # 预计算：lowercase 关键词 + 频道集合（避免每条消息重复 lower/遍历/转换）
        KEYWORDS_LC = [k.lower() for k in (CONFIG_CACHE.get("keywords") or []) if k and str(k).strip()]
        ALERT_KEYWORDS_LC = [k.lower() for k in (CONFIG_CACHE.get("alert_keywords") or []) if k and str(k).strip()]
        MONITORED_CHANNELS_SET = set((CONFIG_CACHE.get("channels") or []))
        
        # 详细日志：显示关键词内容（仅在有关键词时）
        if CONFIG_CACHE.get("keywords"):
            logger.info("📋 [配置加载] 监控关键词: %s", CONFIG_CACHE.get("keywords"))
        else:
            logger.info("📋 [配置加载] 监控关键词: 无")
        if CONFIG_CACHE.get("alert_keywords"):
            logger.info("🔔 [配置加载] 告警关键词: %s", CONFIG_CACHE.get("alert_keywords"))
        else:
            logger.info("🔔 [配置加载] 告警关键词: 无")
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
        # 尽量把 userId 一并传给后端，避免后端每条消息都 Log.findById 查 userId（高 CPU/IO）
        user_id_str = None
        if USER_ID:
            user_id_str = USER_ID
        else:
            cfg = CONFIG_CACHE or default_config()
            if cfg.get("user_id"):
                user_id_str = str(cfg.get("user_id"))

        payload = {
            "log_id": log_id,
            "userId": user_id_str,
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
        logger.info("🔍 [消息发送] 检查客户端连接状态...")
        if not telegram_client.is_connected():
            logger.info("🔍 [消息发送] 客户端未连接，正在连接...")
            await telegram_client.connect()
            logger.info("✅ [消息发送] 客户端已连接")
        else:
            logger.info("✅ [消息发送] 客户端已连接")
        
        # 尝试通过用户名或手机号获取实体
        logger.info("🔍 [消息发送] 正在查找目标: %s", target)
        try:
            entity = await telegram_client.get_entity(target)
            logger.info("✅ [消息发送] 找到目标实体: %s (ID: %s)", getattr(entity, 'username', None) or getattr(entity, 'first_name', None) or 'Unknown', getattr(entity, 'id', 'Unknown'))
        except ValueError as ve:
            # ValueError 通常表示找不到用户
            logger.error("❌ [消息发送] 无法找到目标用户/群组 %s: %s", target, str(ve))
            logger.error("   提示: 请检查用户名是否正确，或确保该用户/群组存在且可访问")
            return False
        except Exception as e:
            logger.error("❌ [消息发送] 获取目标实体失败 %s: %s (类型: %s)", target, str(e), type(e).__name__)
            return False
        
        # 发送消息
        logger.info("📤 [消息发送] 正在发送消息到: %s (消息长度: %d 字符)", target, len(message))
        await telegram_client.send_message(entity, message)
        logger.info("✅ [消息发送] Telegram消息已成功发送到: %s", target)
        return True
    except Exception as e:
        logger.error("❌ [消息发送] 发送Telegram消息失败: %s (类型: %s)", str(e), type(e).__name__)
        import traceback
        logger.error("   错误堆栈: %s", traceback.format_exc())
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
        userId = data.get("userId", "N/A")
        
        logger.info("📨 [消息发送] 收到发送请求 - target: %s, message长度: %d, userId: %s", target, len(message) if message else 0, userId)
        
        if not target or not message:
            logger.error("❌ [消息发送] 缺少必要字段 - target: %s, message: %s", target, "存在" if message else "不存在")
            return web.json_response({"error": "缺少必要字段：target 和 message"}, status=400)
        
        # 处理目标格式（如果包含 @ 符号，保留它；Telegram API 支持带 @ 的用户名）
        clean_target = str(target).strip()
        logger.info("🔍 [消息发送] 准备发送消息到: %s", clean_target)
        
        success = await send_telegram_message_async(clean_target, message)
        if success:
            logger.info("✅ [消息发送] 消息已成功发送到: %s", clean_target)
            return web.json_response({"status": "ok", "message": "消息已发送"})
        else:
            logger.error("❌ [消息发送] 发送失败到: %s", clean_target)
            return web.json_response({"error": "发送失败"}, status=500)
    except Exception as e:
        logger.error("❌ [消息发送] 处理发送Telegram消息请求失败: %s", str(e))
        logger.error("   错误堆栈: %s", traceback.format_exc())
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
    # 默认不在 INFO 打每条消息日志（高吞吐时非常吃 CPU），仅在 debug_verbose_message_logs 开启时输出
    # logger.info("🔔 [消息处理] 收到事件，开始处理...")
    
    # 移除频繁的CPU监控调用，避免每条消息都触发CPU检查导致峰值
    # log_cpu_usage("消息处理开始")
    try:
        # 记录消息接收时间（用于调试延迟问题）
        message_received_time = datetime.utcnow()
        message_event_time = getattr(event.message, 'date', None) if hasattr(event, 'message') and event.message else None
        
        # use cached config only (no IO here)
        config = CONFIG_CACHE or default_config()
        log_all = bool(config.get("log_all_messages", True))
        verbose_logs = bool(config.get("debug_verbose_message_logs", False))

        text = event.raw_text or ""
        if not text:
            if verbose_logs:
                logger.info("⏭️  [消息处理] 消息为空（可能是媒体消息），跳过文本处理")
            return

        # 降 CPU：只做一次 lower，后续关键词匹配复用
        text_lc = text.lower()

        if verbose_logs:
            logger.info("📨 [消息接收] 收到新消息，长度: %d 字符", len(text))

        chat = await event.get_chat()
        channel_id = str(chat.id)
        chat_title = getattr(chat, "title", None)
        chat_username = getattr(chat, "username", None)
        chat_first_name = getattr(chat, "first_name", None)
        chat_last_name = getattr(chat, "last_name", None)

        # 统一对话显示名：
        # - 频道/群：优先 title
        # - 私聊用户：优先 first_name/last_name（不附带 @username）
        # - 兜底：username / Unknown
        if chat_title:
            channel_name = chat_title
        else:
            chat_full_name = " ".join([n for n in [chat_first_name, chat_last_name] if n]) if (chat_first_name or chat_last_name) else None
            if chat_full_name:
                channel_name = chat_full_name
            elif chat_username:
                channel_name = chat_username
            else:
                channel_name = "Unknown"
        # 记录对话解析详情，便于理解“频道/对话名”为何显示为 username
        try:
            logger.info(
                "🔍 [对话解析] chat_id=%s chat_type=%s title=%s username=%s first_name=%s last_name=%s => channel_name=%s",
                getattr(chat, "id", None),
                type(chat).__name__,
                chat_title,
                chat_username,
                chat_first_name,
                chat_last_name,
                channel_name,
            )
        except Exception:
            pass

        # check channel filter（channels 在 load_config_sync 已 normalize 为字符串）
        channel_id_str = str(chat.id)
        if MONITORED_CHANNELS_SET:
            if channel_id_str not in MONITORED_CHANNELS_SET:
                if verbose_logs:
                    logger.info("⏭️  [频道过滤] 频道 %s (ID: %s) 不在监控列表中，跳过消息", channel_name, channel_id_str)
                return
            if verbose_logs:
                logger.info("✅ [频道过滤] 频道 %s (ID: %s) 在监控列表中，继续处理", channel_name, channel_id_str)

        # sender info（带缓存）
        # 先获取 sender 基本信息（用于后续 AI 触发用户匹配：可能需要 username/姓名）
        sender_entity = None
        try:
            sender_entity = await event.get_sender()
        except Exception:
            sender_entity = None

        # 预取 sender_id，便于后续补全
        sender_id = getattr(sender_entity, "id", None) if sender_entity else None
        if not sender_id:
            sender_id = getattr(event, "sender_id", None)

        # 命中缓存则直接使用显示名，并跳过昂贵的补全请求（get_entity / GetFullUserRequest）
        import time as _time
        sender = None
        cached_hit = False
        if sender_id:
            cache_key = str(sender_id)
            cached = _SENDER_DISPLAY_CACHE.get(cache_key)
            if cached and (_time.time() - float(cached.get("ts", 0))) < SENDER_CACHE_TTL_SEC:
                sender = cached.get("sender") or str(sender_id)
                cached_hit = True
                if verbose_logs:
                    logger.debug("♻️  [发件人缓存] 命中 sender_id=%s => %s", sender_id, sender)

        # 如果缺少姓名信息且有 sender_id，再尝试拉取完整实体以补全 first_name/last_name（仅在未命中缓存时）
        if (not cached_hit) and sender_id and (not sender_entity or (not getattr(sender_entity, "first_name", None) and not getattr(sender_entity, "last_name", None))):
            try:
                detailed_entity = await client.get_entity(sender_id)
                sender_entity = sender_entity or detailed_entity
            except Exception:
                # 补全失败时忽略，后续仍会使用已有的 username / id
                detailed_entity = None
        else:
            detailed_entity = None

        # 组装显示名称：优先使用姓名，其次用户名，最后使用ID或频道名
        first_name = getattr(sender_entity, "first_name", None)
        last_name = getattr(sender_entity, "last_name", None)
        username = getattr(sender_entity, "username", None)

        # 如果初次获取为空且补全实体存在，再尝试补全
        if detailed_entity:
            first_name = first_name or getattr(detailed_entity, "first_name", None)
            last_name = last_name or getattr(detailed_entity, "last_name", None)
            username = username or getattr(detailed_entity, "username", None)

        # 如果仍然缺少姓名，再尝试使用 message.from_id 拉取实体
        if not first_name and not last_name:
            try:
                from_id = getattr(event.message, "from_id", None) if hasattr(event, "message") else None
                if from_id:
                    from_entity = await client.get_entity(from_id)
                    first_name = getattr(from_entity, "first_name", None) or first_name
                    last_name = getattr(from_entity, "last_name", None) or last_name
                    username = username or getattr(from_entity, "username", None)
            except Exception:
                pass

        # 如果依然缺少姓名，最后尝试一次 GetFullUserRequest 获取联系人显示名（仅在未命中缓存时）
        if (not cached_hit) and sender_id and not first_name and not last_name:
            try:
                from telethon.tl.functions.users import GetFullUserRequest
                full = await client(GetFullUserRequest(sender_id))
                if full and full.user:
                    first_name = getattr(full.user, "first_name", None) or first_name
                    last_name = getattr(full.user, "last_name", None) or last_name
                    username = username or getattr(full.user, "username", None)
            except Exception:
                pass

        full_name = " ".join([n for n in [first_name, last_name] if n]) if (first_name or last_name) else None

        # 显示规则：有姓名就只显示姓名；没有姓名才显示 @username（不加括号附带）
        # 如果命中缓存，保留缓存的 sender 显示名（避免覆盖）
        if not cached_hit:
            if full_name:
                sender = full_name
            elif username:
                sender = f"@{username}"
            elif sender_id:
                sender = str(sender_id)
            else:
                sender = channel_name
        else:
            # 缓存兜底：确保 sender 不是空
            sender = sender or (str(sender_id) if sender_id else channel_name)

        # 写入缓存（只缓存有 sender_id 的情况）
        if sender_id:
            _SENDER_DISPLAY_CACHE[str(sender_id)] = {"sender": sender, "ts": _time.time()}

        # 记录发件人解析详情（默认只在 verbose_logs 时输出）
        if verbose_logs:
            logger.info("🔍 [发件人解析] sender_id=%s username=%s first_name=%s last_name=%s => sender=%s",
                        sender_id, username, first_name, last_name, sender)

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

        # keyword checks
        keywords_list = config.get("keywords") or []
        alert_keywords_list = config.get("alert_keywords") or []
        if verbose_logs:
            logger.info("🔍 [消息处理] 频道: %s, 发送者: %s, 消息长度: %d", channel_name, sender, len(text))
        
        matched_keywords = []
        # 检查监控关键词
        # 使用预计算的 KEYWORDS_LC，避免每条消息重复 lower + 遍历转换
        if KEYWORDS_LC:
            for idx, k_lc in enumerate(KEYWORDS_LC):
                if k_lc and k_lc in text_lc:
                    # 尽量返回原始关键词（同下标），兜底返回 lower 版本
                    try:
                        matched_keywords.append((keywords_list[idx] if idx < len(keywords_list) else k_lc))
                    except Exception:
                        matched_keywords.append(k_lc)

        # alert keywords (first-match)
        alert_keyword = None
        if ALERT_KEYWORDS_LC:
            for idx, kw_lc in enumerate(ALERT_KEYWORDS_LC):
                if kw_lc and kw_lc in text_lc:
                    alert_keyword = (alert_keywords_list[idx] if idx < len(alert_keywords_list) else kw_lc)
                    if alert_keyword not in matched_keywords:
                        matched_keywords.append(alert_keyword)
                    break

        # compiled regex (precompiled at config load)
        if not alert_keyword and COMPILED_ALERT_REGEX:
            for pattern in COMPILED_ALERT_REGEX:
                if pattern.search(text):
                    alert_keyword = pattern.pattern
                    matched_keywords.append(f"regex:{pattern.pattern}")
                    break

        # save log if needed (async)
        if matched_keywords:
            logger.info("✅ [关键词匹配] 频道=%s 发送者=%s 命中=%s", channel_name, sender, matched_keywords)
        
        if matched_keywords or log_all:
            log_id = await save_log_async(channel_name, channel_id, sender, text, matched_keywords or [], event.id)
            if matched_keywords:
                logger.info("监控触发 | %s | %s", channel_name, matched_keywords)
            elif log_all and verbose_logs:
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
                logger.info("🔔 [告警触发] 关键词: %s (频道: %s, 发送者: %s)", alert_keyword, channel_name, sender)
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
        logger.warning("")
        logger.warning("=" * 60)
        logger.warning("⚠️  未配置 API_ID/API_HASH")
        logger.warning("")
        logger.warning("📱 请通过 Web 界面配置 Telegram API 凭证：")
        logger.warning("   1. 访问 Web 界面")
        logger.warning("   2. 进入 '设置' 标签")
        logger.warning("   3. 展开 'Telegram API 凭证' 卡片")
        logger.warning("   4. 填写 API_ID 和 API_HASH（从 https://my.telegram.org/apps 获取）")
        logger.warning("   5. 点击 '保存 Telegram 凭证' 按钮")
        logger.warning("")
        logger.warning("💡 配置完成后，Telethon 服务将自动重启并开始监控")
        logger.warning("")
        logger.warning("ℹ️  服务将在后台运行，等待配置完成...")
        logger.warning("=" * 60)
        logger.warning("")
        
        # 不退出，而是等待配置完成
        # 定期检查配置是否已更新（每 30 秒检查一次）
        check_count = 0
        while not SHUTDOWN.is_set():
            try:
                await asyncio.sleep(30.0)  # 等待 30 秒
                check_count += 1
                
                # 每 10 次检查（5分钟）输出一次提示
                if check_count % 10 == 0:
                    logger.info("⏳ 仍在等待 API_ID/API_HASH 配置...（已等待 %d 分钟）", check_count // 2)
                
                # 重新加载配置
                await asyncio.get_event_loop().run_in_executor(None, load_config_sync)
                cfg = CONFIG_CACHE or default_config()
                
                # 检查是否已配置 API_ID/API_HASH
                check_api_id = cfg.get("telegram", {}).get("api_id", 0) or 0
                check_api_hash = cfg.get("telegram", {}).get("api_hash", "") or ""
                
                if check_api_id and check_api_id != 0 and check_api_hash:
                    logger.info("✅ 检测到 API_ID/API_HASH 已配置，准备重新启动...")
                    logger.info("📱 API_ID: %s", check_api_id)
                    # 正常退出，让 Docker 重启容器（restart: unless-stopped 会自动重启）
                    import sys
                    sys.exit(0)
            except KeyboardInterrupt:
                # 处理 Ctrl+C
                logger.info("收到中断信号，退出...")
                break
            except Exception as e:
                logger.exception("检查配置时出错: %s", e)
                await asyncio.sleep(30.0)  # 出错时也等待 30 秒
        
        return

    logger.info("📱 使用 API_ID: %s", cfg_api_id)

    # create telethon client
    session_file = None
    if SESSION_STRING:
        client = TelegramClient(StringSession(SESSION_STRING), cfg_api_id, cfg_api_hash)
    else:
        # 动态构建 session 文件名：优先使用配置文件中的 user_id，其次使用环境变量 USER_ID
        # 如果设置了 user_id，格式为：/opt/telegram-monitor/data/session/user_{user_id}.session
        # 否则格式为：/opt/telegram-monitor/data/session/{SESSION_PREFIX}.session
        # active_user_id 已在上面从配置文件或环境变量读取（第 730 行）
        if active_user_id:
            session_base_name = f"{SESSION_PREFIX}_{active_user_id}"
        else:
            session_base_name = SESSION_PREFIX
        session_file = os.path.join(SESSION_BASE_DIR, session_base_name)
        logger.info("使用 Session 文件: %s (SESSION_PREFIX: %s, USER_ID: %s)", session_file, SESSION_PREFIX, active_user_id or "未设置")
        client = TelegramClient(session_file, cfg_api_id, cfg_api_hash)
    
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
                # 如果文件在最近 15 秒内被修改，等待足够的时间确保完全同步
                if time_since_modify < 15:
                    wait_time = max(8.0, 15.0 - time_since_modify)
                    logger.info("🔍 [客户端启动] Session 文件最近被修改（%.1f 秒前），等待 %.1f 秒确保完全同步...", time_since_modify, wait_time)
                    await asyncio.sleep(wait_time)
                    
                    # 等待后再次检查文件大小，确保文件已完全写入
                    if os.path.exists(session_path_with_ext):
                        try:
                            file_stat = os.stat(session_path_with_ext)
                            # Session 文件应该至少 1KB（实际通常为几KB到几十KB）
                            if file_stat.st_size < 1000:
                                logger.warning("⚠️  [客户端启动] Session 文件过小（%d 字节），可能未完全写入，再等待 3 秒...", file_stat.st_size)
                                await asyncio.sleep(3.0)
                                # 再次检查
                                file_stat2 = os.stat(session_path_with_ext)
                                if file_stat2.st_size < 1000:
                                    logger.error("❌ [客户端启动] Session 文件仍然过小（%d 字节），可能文件损坏", file_stat2.st_size)
                        except Exception as stat_error:
                            logger.warning("⚠️  [客户端启动] 无法检查文件大小: %s", str(stat_error))
        
        # 先连接（不触发交互式输入）
        logger.info("🔍 [客户端启动] 正在连接到 Telegram 服务器...")
        
        # 处理 Session 文件锁定问题（多个进程同时访问时可能发生）
        max_connect_retries = 5
        connect_retry_delay = 2.0  # 初始重试延迟（秒）
        connect_success = False
        
        for connect_retry in range(max_connect_retries):
            try:
                await client.connect()
                logger.info("✅ [客户端启动] 已连接到 Telegram 服务器")
                connect_success = True
                break
            except Exception as connect_error:
                error_msg = str(connect_error)
                # 检查是否是数据库锁定错误
                if 'database is locked' in error_msg.lower() or 'OperationalError' in str(type(connect_error)):
                    if connect_retry < max_connect_retries - 1:
                        wait_time = connect_retry_delay * (connect_retry + 1)  # 递增等待时间
                        logger.warning("⚠️  [客户端启动] Session 文件被锁定（可能是其他进程正在使用），等待 %.1f 秒后重试 (%d/%d)...", 
                                     wait_time, connect_retry + 1, max_connect_retries)
                        await asyncio.sleep(wait_time)
                        continue
                    else:
                        logger.error("❌ [客户端启动] Session 文件持续被锁定，已重试 %d 次仍失败", max_connect_retries)
                        logger.error("   可能原因：")
                        logger.error("   1. 有其他容器或进程正在使用同一个 session 文件")
                        logger.error("   2. 之前的容器进程未完全关闭")
                        logger.error("   建议：等待几秒后重启容器，或检查是否有其他容器在使用该 session 文件")
                        raise
                else:
                    # 其他错误直接抛出
                    raise
        
        if not connect_success:
            raise Exception("连接 Telegram 服务器失败：Session 文件被锁定")
        
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
                except Exception as rpc_error:
                    # 检查是否是 RPC 错误（AUTH_KEY_UNREGISTERED，错误代码 401）
                    # Telethon 的 RPC 错误通常有 code 和 message 属性
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
                                import time
                                file_mtime = os.path.getmtime(session_path_with_ext)
                                time_since_modify = time.time() - file_mtime
                                
                                # 如果文件在最近 15 秒内被修改，可能是文件还没完全同步，等待一下
                                if time_since_modify < 15:
                                    wait_time = 15.0 - time_since_modify
                                    logger.warning("⚠️  [授权检查] Session 文件在最近 %.1f 秒内被修改，可能是文件还没完全同步", time_since_modify)
                                    logger.info("⏳ [授权检查] 等待 %.1f 秒后再验证...", wait_time)
                                    await asyncio.sleep(wait_time)
                                    
                                    # 等待后再次尝试验证
                                    try:
                                        await client.disconnect()
                                        await asyncio.sleep(1)
                                        await client.connect()
                                        await client.start()
                                        logger.info("✅ [授权检查] 等待后验证成功，session 有效")
                                        is_authorized = True
                                        start_success = True
                                        break
                                    except Exception as retry_error:
                                        logger.error("❌ [授权检查] 等待后验证仍然失败: %s", str(retry_error))
                                
                                if not is_authorized:
                                    logger.error("🔍 [授权检查] Session 文件存在但认证密钥未注册，可能原因：")
                                    logger.error("   1. Session 文件中的认证密钥已过期或无效")
                                    logger.error("   2. Session 文件是用不同的 API_ID/API_HASH 创建的")
                                    logger.error("   3. Session 文件内容损坏或不完整")
                                    logger.error("   4. Session 文件在写入时没有完全同步")
                                    logger.error("   建议：删除旧的 session 文件后重新登录")
                            else:
                                logger.error("🔍 [授权检查] Session 文件不存在: %s", session_path_with_ext)
                        
                        if not is_authorized:
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
        
        # 尝试获取用户信息，如果成功说明已经启动
        # 添加重试逻辑处理 session 文件锁定问题
        max_get_me_retries = 5
        get_me_retry_delay = 2.0
        get_me_success = False
        
        for get_me_retry in range(max_get_me_retries):
            try:
                me = await client.get_me()
                logger.info("✅ [授权检查] 客户端已启动，已登录为: %s (ID: %s)", getattr(me, "username", None) or getattr(me, "first_name", None), me.id)
                client_started = True
                get_me_success = True
                break
            except Exception as get_me_error:
                error_msg = str(get_me_error)
                # 检查是否是数据库锁定错误
                if 'database is locked' in error_msg.lower() or 'OperationalError' in str(type(get_me_error)):
                    if get_me_retry < max_get_me_retries - 1:
                        wait_time = get_me_retry_delay * (get_me_retry + 1)  # 递增等待时间
                        logger.warning("⚠️  [授权检查] Session 文件被锁定（get_me），等待 %.1f 秒后重试 (%d/%d)...", 
                                     wait_time, get_me_retry + 1, max_get_me_retries)
                        await asyncio.sleep(wait_time)
                        continue
                    else:
                        logger.error("❌ [授权检查] Session 文件持续被锁定（get_me），已重试 %d 次仍失败", max_get_me_retries)
                        logger.error("   可能原因：")
                        logger.error("   1. 有其他容器或进程正在使用同一个 session 文件")
                        logger.error("   2. 之前的容器进程未完全关闭")
                        logger.error("   建议：等待几秒后重启容器，或检查是否有其他容器在使用该 session 文件")
                        # 继续尝试启动客户端
                        break
                else:
                    # 其他错误，可能是客户端未启动
                    logger.info("🔍 [授权检查] get_me 失败（非锁定错误）: %s，将尝试启动客户端", str(get_me_error))
                    break
        
        if not get_me_success:
            # 如果获取用户信息失败，说明需要启动客户端
            logger.info("🔍 [授权检查] 客户端已连接但未启动，尝试启动客户端...")
            try:
                await client.start()
                logger.info("✅ [授权检查] 客户端启动成功，session 有效")
                client_started = True
            except EOFError as eof_error:
                # EOFError 表示尝试了交互式输入，说明 session 无效
                import traceback
                logger.error("🔍 [授权检查] EOFError 详情: %s", str(eof_error))
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
    
    # 注册消息处理器
    client.add_event_handler(lambda e: message_handler(e, client), events.NewMessage())
    logger.info("✅ [事件注册] 已注册 NewMessage 事件处理器")
    
    # 获取用户信息（添加重试逻辑处理 session 文件锁定）
    max_get_me_retries = 5
    get_me_retry_delay = 2.0
    me = None
    
    for get_me_retry in range(max_get_me_retries):
        try:
            me = await client.get_me()
            logger.info("已登录为: %s (ID: %s)", getattr(me, "username", None) or getattr(me, "first_name", None), me.id)
            break
        except Exception as get_me_error:
            error_msg = str(get_me_error)
            # 检查是否是数据库锁定错误
            if 'database is locked' in error_msg.lower() or 'OperationalError' in str(type(get_me_error)):
                if get_me_retry < max_get_me_retries - 1:
                    wait_time = get_me_retry_delay * (get_me_retry + 1)
                    logger.warning("⚠️  [启动] Session 文件被锁定（get_me），等待 %.1f 秒后重试 (%d/%d)...", 
                                 wait_time, get_me_retry + 1, max_get_me_retries)
                    await asyncio.sleep(wait_time)
                    continue
                else:
                    logger.error("❌ [启动] Session 文件持续被锁定（get_me），已重试 %d 次仍失败", max_get_me_retries)
                    raise
            else:
                # 其他错误直接抛出
                raise
    
    if not me:
        raise Exception("无法获取用户信息：Session 文件被锁定")
    
    # 诊断：列出当前加入的对话（用于调试）
    try:
        dialogs = await client.get_dialogs(limit=10)
        logger.info("📋 [诊断] 当前账号已加入的对话数量: %d (显示前10个)", len(await client.get_dialogs()))
        for i, dialog in enumerate(dialogs[:5], 1):
            dialog_name = dialog.name or "Unknown"
            dialog_id = dialog.id
            logger.info("📋 [诊断] 对话 %d: %s (ID: %s)", i, dialog_name, dialog_id)
    except Exception as diag_error:
        logger.warning("⚠️  [诊断] 获取对话列表失败: %s", str(diag_error))
    
    logger.info("📡 [事件监听] 开始监听所有新消息（包括私聊、群组、频道）...")

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
