const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const nodemailer = require('nodemailer');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const Joi = require('joi');
require('dotenv').config();

const execAsync = promisify(exec);

const Log = require('./logModel');
const AISummary = require('./aiSummaryModel');
const User = require('./userModel');
const UserConfig = require('./userConfigModel');
const AIAnalysisService = require('./services/aiAnalysis');

const app = express();

// SSE 客户端连接池
const sseClients = new Set();

// 临时登录容器管理（userId -> { containerName, createdAt, container }）
const tempLoginContainers = new Map();

// 清理超时的临时容器（30分钟后自动清理）
const TEMP_CONTAINER_TIMEOUT = 30 * 60 * 1000; // 30分钟
setInterval(() => {
  const now = Date.now();
  for (const [userId, info] of tempLoginContainers.entries()) {
    if (now - info.createdAt > TEMP_CONTAINER_TIMEOUT) {
      console.log(`🧹 清理超时的临时登录容器: ${info.containerName} (用户: ${userId})`);
      cleanupTempLoginContainer(userId).catch(err => {
        console.error(`清理临时容器失败:`, err);
      });
    }
  }
}, 5 * 60 * 1000); // 每5分钟检查一次

// 🔒 信任反向代理（用于 X-Forwarded-For 头部，在 Docker + Nginx 环境中必需）
app.set('trust proxy', 1);

app.use(express.json());

// 🔒 配置 CORS
// 注意：由于通过 nginx 反向代理，允许所有源（nginx 会处理安全）
// 如果直接访问 API，可以通过 ALLOWED_ORIGINS 环境变量限制
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : true; // 默认允许所有源（通过 nginx 代理时）

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  maxAge: 3600,
  optionsSuccessStatus: 200
}));

// 🔒 添加安全响应头
app.use(helmet());
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'https:'],
    connectSrc: ["'self'"],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    mediaSrc: ["'self'"],
    frameSrc: ["'none'"],
    upgradeInsecureRequests: []
  }
}));
app.use(helmet.noSniff());
app.use(helmet.xssFilter());
app.use(helmet.frameguard({ action: 'deny' }));
app.disable('x-powered-by');

// 🔒 配置速率限制
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  message: '登录尝试过多，请 5 分钟后再试',
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: 'API 请求过于频繁，请稍后再试',
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', apiLimiter);

const CONFIG_PATH = path.join(__dirname, 'config.json');
// JWT 密钥：
// - 优先使用环境变量 JWT_SECRET（建议强随机值）
// - 若未设置/为空，则生成一次性随机密钥（保证服务可启动，但重启会导致旧 token 失效）
// - 禁止使用硬编码固定默认值（可被轻易伪造 token）
let JWT_SECRET = (process.env.JWT_SECRET || '').toString().trim();
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(48).toString('base64');
  console.error('⚠️  警告：JWT_SECRET 未设置，已生成一次性随机密钥（重启后旧 token 将失效）');
  console.error('⚠️  建议在 .env 中设置持久化的强随机 JWT_SECRET');
}
// 内部接口访问令牌：用于保护 /api/internal/*（建议在生产环境配置强随机值）
const INTERNAL_API_TOKEN = (process.env.INTERNAL_API_TOKEN || '').trim();
const PORT = process.env.PORT || 3000;
// 是否允许系统初始化后继续公开注册（默认不允许，支持配置文件与环境变量）
const ALLOW_PUBLIC_REGISTRATION_ENV = ['1', 'true', 'yes', 'y', 'on'].includes(
  String(process.env.ALLOW_PUBLIC_REGISTRATION || '').toLowerCase().trim()
);

// 🔒 启动时提示 JWT_SECRET（不再允许固定默认值；若未设置将使用一次性随机值）
if (!process.env.JWT_SECRET) {
  console.error('ℹ️  提示：当前未设置 JWT_SECRET（正在使用一次性随机密钥）');
}

// 🔒 启动时提示 INTERNAL_API_TOKEN
if (!INTERNAL_API_TOKEN) {
  console.error('⚠️  警告：INTERNAL_API_TOKEN 未设置！');
  console.error('⚠️  /api/internal/* 将仅依赖网络隔离（强烈建议设置强随机值）');
}

// -----------------------
// 内部 API 安全中间件
// - 优先校验 X-Internal-Token
// - 若未配置 INTERNAL_API_TOKEN，则回退为“仅允许内网/本机来源”
// -----------------------
function normalizeIp(ip) {
  if (!ip) return '';
  const s = String(ip);
  // 处理 ::ffff:127.0.0.1 这类
  return s.startsWith('::ffff:') ? s.slice('::ffff:'.length) : s;
}

function isPrivateIp(ipRaw) {
  const ip = normalizeIp(ipRaw);
  if (!ip) return false;
  // ipv6 loopback / unique local / link local
  if (ip === '::1') return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // fc00::/7
  if (ip.startsWith('fe80:')) return true; // link-local

  // ipv4
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map(p => Number(p));
  if (nums.some(n => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function internalAuthMiddleware(req, res, next) {
  try {
    const headerToken = (req.headers['x-internal-token'] || '').toString().trim();
    if (INTERNAL_API_TOKEN) {
      if (headerToken && headerToken === INTERNAL_API_TOKEN) return next();
      return res.status(403).json({ error: 'Forbidden: internal API token required' });
    }

    // 未配置 token：仅允许内网/本机来源（尽量减少误伤现有部署）
    // 注意：在启用 trust proxy 后，req.ip 会基于 X-Forwarded-For，能有效阻断经 Nginx 代理的外网请求
    const ip = normalizeIp(req.ip || req.connection?.remoteAddress || '');
    if (isPrivateIp(ip)) return next();
    return res.status(403).json({ error: 'Forbidden: internal API restricted' });
  } catch (e) {
    return res.status(500).json({ error: 'Internal auth failed' });
  }
}

// 保护所有内部 API
app.use('/api/internal', internalAuthMiddleware);

// 默认配置
const defaultConfig = {
  // 允许系统初始化后公开注册（默认 false，可被环境变量覆盖初始值）
  allow_public_registration: ALLOW_PUBLIC_REGISTRATION_ENV,
  keywords: [],
  channels: [],
  auto_send_configs: [],
  alert_keywords: [],
  alert_regex: [],
  alert_target: '',
  log_all_messages: true,
  telegram: {
    api_id: 0,
    api_hash: ''
  },
  alert_actions: {
    telegram: true,
    email: {
      enable: false,
      smtp_host: '',
      smtp_port: 465,
      username: '',
      password: '',
      to: ''
    },
    webhook: {
      enable: false,
      url: ''
    }
  },
  ai_analysis: {
    enabled: false,
    openai_api_key: '',
    openai_model: 'gpt-3.5-turbo',
    openai_base_url: 'https://api.openai.com/v1',
    analysis_trigger_type: 'time', // 'time' 或 'count'
    time_interval_minutes: 30,
    message_count_threshold: 50,
    max_messages_per_analysis: 500, // 每次分析的最大消息数，避免token超限
    analysis_prompt: '请分析以下 Telegram 消息，提供：1) 整体情感倾向（积极/中性/消极）；2) 主要内容分类；3) 关键主题和摘要；4) 重要关键词',
    ai_send_telegram: true,
    ai_send_email: false,
    ai_send_webhook: false,
    ai_trigger_enabled: false, // 是否启用固定用户触发
    ai_trigger_users: [], // 固定用户列表，当这些用户发送消息时立刻分析
    ai_trigger_prompt: '' // 固定用户触发的专用提示词，为空时使用空提示词
  },
  admin: {
    username: 'admin',
    password_hash: bcrypt.hashSync('admin123', 10) // 默认密码: admin123
  }
};

// 深度合并配置对象（递归合并嵌套对象）
function deepMergeConfig(target, source) {
  const result = { ...target };
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      // 如果是对象（非数组），递归合并
      result[key] = deepMergeConfig(result[key] || {}, source[key]);
    } else if (!(key in result) || result[key] === null || result[key] === undefined) {
      // 如果目标中没有这个key，或者是null/undefined，使用源值
      result[key] = source[key];
    }
    // 如果目标中已有值且不是null/undefined，保留目标值（不覆盖）
  }
  return result;
}

// 安全读取配置文件（处理目录情况）
function loadConfig() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (stat.isDirectory()) {
      console.error('❌ 错误：config.json 是目录而非文件，正在删除并重建...');
      fs.rmSync(CONFIG_PATH, { recursive: true, force: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
      return defaultConfig;
    }
    const existingConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    
    // 深度合并现有配置和默认配置，确保所有新字段都存在
    const mergedConfig = deepMergeConfig(existingConfig, defaultConfig);
    
    // 如果配置被更新（添加了新字段），保存回文件
    const configChanged = JSON.stringify(mergedConfig) !== JSON.stringify(existingConfig);
    if (configChanged) {
      console.log('📝 检测到配置文件需要更新（添加缺失字段），正在保存...');
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(mergedConfig, null, 2));
    }
    
    return mergedConfig;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      console.log('⚠️  配置文件不存在或损坏，正在创建...');
      if (fs.existsSync(CONFIG_PATH)) {
        fs.rmSync(CONFIG_PATH, { recursive: true, force: true });
      }
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
      return defaultConfig;
    }
    // JSON解析错误，尝试修复
    if (err instanceof SyntaxError) {
      console.error('❌ 配置文件JSON格式错误，正在修复...');
      try {
        // 尝试备份损坏的配置
        const backupPath = CONFIG_PATH + '.backup.' + Date.now();
        if (fs.existsSync(CONFIG_PATH)) {
          fs.copyFileSync(CONFIG_PATH, backupPath);
          console.log(`💾 已备份损坏的配置文件到: ${backupPath}`);
        }
        // 使用默认配置
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
        console.log('✅ 已使用默认配置重建配置文件');
        return defaultConfig;
      } catch (backupErr) {
        console.error('❌ 修复配置文件失败:', backupErr);
        throw err;
      }
    }
    throw err;
  }
}

// 初始化配置文件
loadConfig();

// 获取是否允许公开注册（优先配置文件）
function isPublicRegistrationAllowed() {
  try {
    const cfg = loadConfig();
    return !!cfg.allow_public_registration;
  } catch (e) {
    // 兜底使用环境变量
    return ALLOW_PUBLIC_REGISTRATION_ENV;
  }
}

// ===== 用户配置辅助函数 =====

// 用户配置缓存（避免频繁查询 MongoDB）
const userConfigCache = new Map();
const CONFIG_CACHE_TTL = 60000; // 配置缓存60秒

// 获取主账号ID（用于切换账号功能，如果用户是子账号，返回父账号ID；如果是主账号，返回自己的ID）
async function getAccountId(userId) {
  try {
    const userIdObj = mongoose.Types.ObjectId.isValid(userId) 
      ? (userId instanceof mongoose.Types.ObjectId ? userId : new mongoose.Types.ObjectId(userId))
      : userId;
    
    const user = await User.findById(userIdObj);
    if (!user) {
      return userIdObj; // 如果用户不存在，返回原ID
    }
    
    // 如果有parent_account_id，返回父账号ID；否则返回自己的ID（主账号）
    return user.parent_account_id || user._id;
  } catch (error) {
    console.error('获取主账号ID失败:', error);
    // 出错时返回原ID
    return mongoose.Types.ObjectId.isValid(userId) 
      ? (userId instanceof mongoose.Types.ObjectId ? userId : new mongoose.Types.ObjectId(userId))
      : userId;
  }
}

// 加载用户配置（每个用户独立配置，不共享）
async function loadUserConfig(userId, skipCache = false) {
  try {
    // 确保userId是ObjectId类型
    const userIdObj = mongoose.Types.ObjectId.isValid(userId) 
      ? (userId instanceof mongoose.Types.ObjectId ? userId : new mongoose.Types.ObjectId(userId))
      : userId;
    
    const userIdStr = userIdObj.toString();
    const cacheKey = `user_config_${userIdStr}`;
    
    // 检查缓存（除非跳过缓存）
    if (!skipCache) {
      const cached = userConfigCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < CONFIG_CACHE_TTL) {
        return cached.config;
      }
    }
    
    // 从数据库加载
    let userConfig = await UserConfig.findOne({ userId: userIdObj });
    if (!userConfig) {
      // 如果用户配置不存在，创建默认配置
      userConfig = new UserConfig({ userId: userIdObj });
      await userConfig.save();
    }
    
    // 更新缓存
    userConfigCache.set(cacheKey, {
      config: userConfig,
      timestamp: Date.now()
    });
    
    return userConfig;
  } catch (error) {
    console.error('加载用户配置失败:', error);
    // 返回默认配置对象
    const defaultConfig = {
      keywords: [],
      channels: [],
      auto_send_configs: [],
      alert_keywords: [],
      alert_regex: [],
      alert_target: '',
      log_all_messages: true,
      telegram: { api_id: 0, api_hash: '' },
      alert_actions: {
        telegram: true,
        email: { enable: false, smtp_host: '', smtp_port: 465, username: '', password: '', to: '' },
        webhook: { enable: false, url: '' }
      },
      ai_analysis: {
        enabled: false,
        openai_api_key: '',
        openai_model: 'gpt-3.5-turbo',
        openai_base_url: 'https://api.openai.com/v1',
        analysis_trigger_type: 'time',
        time_interval_minutes: 30,
        message_count_threshold: 50,
        max_messages_per_analysis: 500,
        analysis_prompt: '请分析以下 Telegram 消息，提供：1) 整体情感倾向（积极/中性/消极）；2) 主要内容分类；3) 关键主题和摘要；4) 重要关键词',
        ai_send_telegram: true,
        ai_send_email: false,
        ai_send_webhook: false,
        ai_trigger_enabled: false,
        ai_trigger_users: [],
        ai_trigger_prompt: ''
      },
      multi_login_enabled: false
    };
    return defaultConfig;
  }
}

// 保存用户配置（每个用户独立配置，不共享）
async function saveUserConfig(userId, configData) {
  try {
    // 确保 MongoDB 连接正常
    if (mongoose.connection.readyState !== 1) {
      throw new Error('数据库未连接，请稍后重试');
    }
    
    // 确保userId是ObjectId类型
    const userIdObj = mongoose.Types.ObjectId.isValid(userId) 
      ? (userId instanceof mongoose.Types.ObjectId ? userId : new mongoose.Types.ObjectId(userId))
      : userId;
    
    const userIdStr = userIdObj.toString();
    
    const userConfig = await UserConfig.findOneAndUpdate(
      { userId: userIdObj },
      { $set: { ...configData, userId: userIdObj } },
      { upsert: true, new: true }
    );
    
    // 验证配置是否真的保存成功
    const savedConfig = await UserConfig.findOne({ userId: userIdObj });
    if (!savedConfig) {
      throw new Error('用户配置保存失败：保存后无法找到配置');
    }
    
    // 清除缓存，确保下次读取时获取最新配置
    userConfigCache.delete(`user_config_${userIdStr}`);

    // 事件驱动：配置变更后刷新 count 触发配置缓存（防抖），并对该用户做一次轻量对账
    // 这样可以避免后台定时器周期性查库
    scheduleCountTriggerConfigRefresh(userIdStr);
    
    console.log(`✅ 用户配置已保存到数据库 (userId: ${userId})`);
    return userConfig;
  } catch (error) {
    console.error('保存用户配置失败:', error);
    throw error;
  }
}

function sanitizeAutoSendConfigs(configs) {
  if (!Array.isArray(configs)) return [];

  return configs
    .map((item, index) => {
      const id = String(item?.id || `auto_${Date.now()}_${index}`).trim();
      const target = String(item?.target || '').trim();
      const message = String(item?.message || '').trim();
      const intervalSeconds = Math.max(1, Math.floor(Number(item?.interval_seconds) || 60));
      const targetType = item?.target_type === 'private' ? 'private' : 'group';

      return {
        id: id || `auto_${Date.now()}_${index}`,
        enabled: Boolean(item?.enabled),
        target_type: targetType,
        target,
        message,
        interval_seconds: intervalSeconds
      };
    })
    .filter(item => item.id);
}

const autoSendSchedules = new Map();

function getAutoSendScheduleKey(userId, configId) {
  return `${userId}:${configId}`;
}

function stopAutoSendScheduler() {
  for (const schedule of autoSendSchedules.values()) {
    if (schedule.timeout) {
      clearTimeout(schedule.timeout);
    }
  }
  autoSendSchedules.clear();
}

async function sendAutoTelegramMessage(userId, autoConfig) {
  if (!autoConfig?.enabled || !autoConfig.target || !autoConfig.message) {
    return;
  }

  const telethonUrl = await getTelethonServiceUrl(userId);
  await axios.post(`${telethonUrl}/api/internal/telegram/send`, {
    target: autoConfig.target,
    message: autoConfig.message
  }, {
    timeout: 15000,
    headers: {
      'Content-Type': 'application/json',
      ...(INTERNAL_API_TOKEN ? { 'X-Internal-Token': INTERNAL_API_TOKEN } : {})
    }
  });
}

function scheduleAutoSendItem(userId, autoConfig) {
  const key = getAutoSendScheduleKey(userId, autoConfig.id);
  const intervalMs = Math.max(1, Number(autoConfig.interval_seconds) || 60) * 1000;
  const schedule = {
    timeout: null,
    running: false
  };

  const tick = async () => {
    if (!autoSendSchedules.has(key)) {
      return;
    }

    if (!schedule.running) {
      schedule.running = true;
      try {
        await sendAutoTelegramMessage(userId, autoConfig);
        console.log(`✅ [自动发送] 已发送配置 ${autoConfig.id} 到 ${autoConfig.target} (userId: ${userId})`);
      } catch (error) {
        console.error(`❌ [自动发送] 发送失败 (userId: ${userId}, target: ${autoConfig.target}):`, error.message);
      } finally {
        schedule.running = false;
      }
    }

    if (autoSendSchedules.has(key)) {
      schedule.timeout = setTimeout(tick, intervalMs);
    }
  };

  schedule.timeout = setTimeout(tick, intervalMs);
  autoSendSchedules.set(key, schedule);
}

async function refreshAutoSendScheduler() {
  try {
    stopAutoSendScheduler();

    if (mongoose.connection.readyState !== 1) {
      console.warn('⚠️  [自动发送] MongoDB 未连接，暂不启动自动发送调度器');
      return;
    }

    const configs = await UserConfig.find({ 'auto_send_configs.enabled': true })
      .select('userId auto_send_configs')
      .lean();

    let scheduledCount = 0;
    for (const cfg of configs) {
      const userId = cfg.userId?.toString();
      if (!userId) continue;

      const user = await User.findById(userId).select('is_active').lean();
      if (!user?.is_active) continue;

      for (const autoConfig of sanitizeAutoSendConfigs(cfg.auto_send_configs)) {
        if (!autoConfig.enabled || !autoConfig.target || !autoConfig.message) continue;
        scheduleAutoSendItem(userId, autoConfig);
        scheduledCount += 1;
      }
    }

    console.log(`✅ [自动发送] 调度器已刷新，启用配置数: ${scheduledCount}`);
  } catch (error) {
    console.error('❌ [自动发送] 刷新调度器失败:', error.message);
  }
}

// 初始化默认管理员用户（向后兼容：如果系统已有用户，不再创建；如果没有用户，也不自动创建，让用户注册）
async function initDefaultAdmin() {
  try {
    // 检查系统中是否有任何用户
    const userCount = await User.countDocuments();
    if (userCount === 0) {
      // 系统没有任何用户，但新架构下不再自动创建，让用户通过注册页面创建
      console.log('ℹ️  系统未初始化，请通过注册页面创建第一个账号');
      return;
    }
    
    // 系统已有用户，检查是否已存在admin用户（向后兼容）
    const adminUser = await User.findOne({ username: 'admin' });
    if (!adminUser) {
      console.log('ℹ️  系统已有用户，但admin用户不存在（这在新架构下是正常的）');
    } else {
      console.log('ℹ️  admin用户已存在（向后兼容）');
    }
  } catch (error) {
    console.error('❌ 检查系统用户状态失败:', error);
  }
}

// 连接 MongoDB
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/tglogs';

// 禁用 Mongoose 的所有日志输出
mongoose.set('debug', false);
// 静默处理连接事件（但保留关键错误信息）
mongoose.connection.on('error', (err) => {
  // 只在控制台输出关键错误，不输出详细堆栈
  if (err.message && !err.message.includes('ECONNREFUSED')) {
    console.error('❌ MongoDB 连接错误:', err.message);
  }
});
mongoose.connection.on('disconnected', () => {
  // 静默断开，不输出日志
});
mongoose.connection.on('reconnected', () => {
  refreshAutoSendScheduler().catch(err => {
    console.warn('⚠️  [自动发送] MongoDB 重连后刷新调度器失败:', err.message);
  });
});

mongoose.connect(MONGO_URL, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000, // 5秒超时
  heartbeatFrequencyMS: 10000 // 10秒心跳
})
.then(async () => {
  // 静默连接成功，不输出日志
  // 初始化默认管理员
  await initDefaultAdmin();
  await refreshAutoSendScheduler();
})
.catch((err) => {
  // 静默连接失败，但记录到控制台（不输出到日志）
  // 注意：这里不抛出错误，让服务继续运行，即使 MongoDB 暂时不可用
  // 服务会在后续请求中检查连接状态并返回适当的错误
  // 只在控制台输出关键错误信息
  if (err.message && !err.message.includes('ECONNREFUSED')) {
    console.error('❌ MongoDB 连接失败，请检查 MongoDB 服务是否运行:', err.message);
  }
});

// JWT 验证中间件
const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: '未授权：缺少 token' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // 验证用户是否存在且激活
    const user = await User.findById(decoded.userId);
    if (!user || !user.is_active) {
      return res.status(401).json({ error: '用户不存在或已被禁用' });
    }
    req.user = {
      userId: decoded.userId,
      username: decoded.username,
      userObj: user
    };
    next();
  } catch (error) {
    // 检查是否是 JWT 签名验证失败（可能是 JWT_SECRET 改变了）
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      // 如果是签名错误，提示用户可能是 JWT_SECRET 改变了，需要重新登录
      if (error.name === 'JsonWebTokenError' && error.message && error.message.includes('signature')) {
        return res.status(401).json({ 
          error: '未授权：token 无效。如果您最近设置了 JWT_SECRET，请重新登录以获取新的 token。' 
        });
      }
      return res.status(401).json({ 
        error: error.name === 'TokenExpiredError' 
          ? '未授权：token 已过期，请重新登录' 
          : '未授权：token 无效，请重新登录' 
      });
    }
    return res.status(401).json({ error: '未授权：token 验证失败' });
  }
};

// ===== 认证相关 API =====

// 检查系统是否已初始化（是否有用户）- 公开接口，不需要认证
app.get('/api/auth/check-init', async (req, res) => {
  try {
    // 检查MongoDB连接状态
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ initialized: false, error: '数据库未连接' });
    }
    
    // 检查是否有任何用户
    const userCount = await User.countDocuments();
    // 公开注册策略：
    // - 无用户（首次初始化）一定允许注册
    // - 系统已初始化后，默认关闭公开注册（可通过 ALLOW_PUBLIC_REGISTRATION=true 开启）
    const publicRegistrationAllowed = (userCount === 0) || isPublicRegistrationAllowed();
    res.json({ initialized: userCount > 0, userCount, public_registration_allowed: publicRegistrationAllowed });
  } catch (error) {
    console.error('检查系统初始化状态失败:', error);
    res.status(500).json({ initialized: false, error: '检查失败：' + error.message });
  }
});

// 注册账号（创建主账号）
app.post('/api/auth/register', loginLimiter, async (req, res) => {
  try {
    const { username, password, display_name } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }
    
    if (username.length < 3 || username.length > 50) {
      return res.status(400).json({ error: '用户名长度必须在3-50字符之间' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: '密码长度至少为6位' });
    }

    // 🔒 默认策略：仅允许“首次初始化”注册第一个账号
    // 若确需开放注册，可设置 ALLOW_PUBLIC_REGISTRATION=true
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: '数据库未连接，请稍后重试' });
    }
    const userCount = await User.countDocuments();
    if (userCount > 0 && !isPublicRegistrationAllowed()) {
      return res.status(403).json({ error: '系统已初始化：已关闭公开注册，请使用已有账号登录或由主账号创建子账号' });
    }
    
    // 检查用户名是否已存在
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ error: '用户名已存在' });
    }
    
    // 创建主账号（parent_account_id为null）
    const passwordHash = await bcrypt.hash(password, 10);
    const user = new User({
      username,
      password_hash: passwordHash,
      display_name: display_name || username,
      is_active: true,
      parent_account_id: null // 主账号
    });
    
    // 保存用户
    await user.save();
    
    // 等待一小段时间确保数据写入
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // 验证用户是否真的保存成功
    const savedUser = await User.findById(user._id);
    if (!savedUser) {
      throw new Error('用户保存失败：保存后无法找到用户');
    }
  
  const currentAccountId = currentUser._id; // 主账号ID（用于多开容器检查）
    
    console.log(`✅ 用户已保存到数据库 (userId: ${user._id}, username: ${username})`);
    
    // 创建用户时自动创建默认配置
    try {
      await saveUserConfig(user._id.toString(), {});
    } catch (configError) {
      console.error('⚠️  创建用户配置失败，但用户已创建:', configError);
      // 配置创建失败不影响用户创建成功
    }
    
    // 生成 JWT token（永不过期）
    const token = jwt.sign({ 
      userId: user._id.toString(), 
      username: user.username 
    }, JWT_SECRET);
    
    console.log(`✅ 新账号注册成功 (username: ${username}, userId: ${user._id})`);
    
    res.json({ 
      token, 
      username: user.username,
      displayName: user.display_name || user.username,
      userId: user._id.toString()
    });
  } catch (error) {
    console.error('❌ 注册失败:', error);
    res.status(500).json({ error: '注册失败：' + error.message });
  }
});

// 登录（添加速率限制）
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }
    
    // 检查MongoDB连接状态
    if (mongoose.connection.readyState !== 1) {
      console.error('❌ MongoDB 未连接，状态:', mongoose.connection.readyState);
      return res.status(503).json({ error: '数据库未连接，请稍后重试' });
    }
    
    // 查找用户
    const user = await User.findOne({ username, is_active: true });
    if (!user) {
      console.log(`❌ 登录失败：用户不存在或未激活 (username: ${username})`);
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    
    // 验证密码
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      console.log(`❌ 登录失败：密码错误 (username: ${username})`);
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    
    // 更新最后登录时间
    user.last_login = new Date();
    await user.save();
    
    // 生成 JWT token（永不过期）
    const token = jwt.sign({ 
      userId: user._id.toString(), 
      username: user.username 
    }, JWT_SECRET);
    
    console.log(`✅ 登录成功 (username: ${username}, userId: ${user._id})`);
    res.json({ 
      token, 
      username: user.username,
      displayName: user.display_name || user.username,
      userId: user._id.toString()
    });
  } catch (error) {
    console.error('❌ 登录异常:', error);
    res.status(500).json({ error: '登录失败：' + error.message });
  }
});

// 获取当前用户信息
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = req.user.userObj;
    res.json({
      userId: user._id.toString(),
      username: user.username,
      displayName: user.display_name || user.username,
      isAdmin: user.username === 'admin',
      isMainAccount: !user.parent_account_id
    });
  } catch (error) {
    console.error('获取用户信息失败:', error);
    res.status(500).json({ error: '获取用户信息失败：' + error.message });
  }
});

// 修改密码
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: '原密码和新密码不能为空' });
    }
    
    if (newPassword.length < 6) {
      return res.status(400).json({ error: '新密码长度至少为6位' });
    }
    
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    
    const valid = await bcrypt.compare(oldPassword, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: '原密码错误' });
    }
    
    user.password_hash = await bcrypt.hash(newPassword, 10);
    await user.save();
    
    res.json({ status: 'ok', message: '密码修改成功' });
  } catch (error) {
    res.status(500).json({ error: '修改密码失败：' + error.message });
  }
});

// ===== 管理员中间件（仅允许 admin 用户） =====
const adminMiddleware = async (req, res, next) => {
  try {
    // 先通过身份验证
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: '未授权：缺少 token' });
    }
    
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId);
    
    if (!user || !user.is_active) {
      return res.status(401).json({ error: '用户不存在或已被禁用' });
    }
    
    // 检查是否为 admin 用户
    if (user.username !== 'admin') {
      return res.status(403).json({ error: '权限不足：仅管理员可执行此操作' });
    }
    
    // 设置 req.user
    req.user = {
      userId: decoded.userId,
      username: decoded.username,
      userObj: user
    };
    
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: '未授权：token 无效或已过期' });
    }
    return res.status(500).json({ error: '权限验证失败：' + error.message });
  }
};

// ===== 用户管理 API（仅管理员） =====

// 获取用户列表（主账号可以看到该账号下的所有子账号）
app.get('/api/users', authMiddleware, async (req, res) => {
  try {
    const currentUser = req.user.userObj;
    const accountId = await getAccountId(currentUser._id);
    const accountIdObj = new mongoose.Types.ObjectId(accountId);
    
    // 查询该主账号下的所有账号（包括主账号和子账号）
    const users = await User.find({
      $or: [
        { _id: accountIdObj }, // 主账号
        { parent_account_id: accountIdObj } // 子账号
      ]
    }).select('-password_hash').sort({ created_at: -1 });
    
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: '获取用户列表失败：' + error.message });
  }
});

// 创建子账号（主账号可以创建子账号）
app.post('/api/users', authMiddleware, async (req, res) => {
  try {
    const currentUser = req.user.userObj;
    
    // 只有主账号可以创建子账号
    if (currentUser.parent_account_id) {
      return res.status(403).json({ error: '权限不足：只有主账号可以创建子账号' });
    }
    
    const { username, password, display_name } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }
    
    if (username.length < 3 || username.length > 50) {
      return res.status(400).json({ error: '用户名长度必须在3-50字符之间' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: '密码长度至少为6位' });
    }
    
    // 检查用户名是否已存在
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ error: '用户名已存在' });
    }
    
    // 创建子账号（parent_account_id指向主账号）
    // 主账号的ID就是当前用户的ID
    const accountIdObj = currentUser._id;
    const passwordHash = await bcrypt.hash(password, 10);
    const user = new User({
      username,
      password_hash: passwordHash,
      display_name: display_name || username,
      is_active: true,
      parent_account_id: accountIdObj // 设置为当前主账号的子账号
    });
    
    // 确保 MongoDB 连接正常
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: '数据库未连接，请稍后重试' });
    }
    
    // 保存用户
    await user.save();
    
    // 等待一小段时间确保数据写入
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // 验证用户是否真的保存成功
    const savedUser = await User.findById(user._id);
    if (!savedUser) {
      throw new Error('用户保存失败：保存后无法找到用户');
    }
    
    console.log(`✅ 子账号创建成功 (username: ${username}, parent: ${currentUser.username}, userId: ${user._id})`);
    
    // 创建子账号时自动创建默认配置（每个账号独立配置）
    try {
      await saveUserConfig(user._id.toString(), {});
    } catch (configError) {
      console.error('⚠️  创建用户配置失败，但用户已创建:', configError);
      // 配置创建失败不影响用户创建成功
    }
    
    // 如果是多开模式，确保主账号也有多开容器（如果主账号已登录）
    setTimeout(async () => {
      try {
        const accountConfig = await loadUserConfig(currentAccountId.toString());
        const multiLoginEnabled = accountConfig.multi_login_enabled || false;
        
        if (multiLoginEnabled) {
          console.log(`🔍 [子账号创建] 多开模式已启用，检查主账号是否需要创建多开容器...`);
          
          // 检查主账号是否有session文件
          const PROJECT_ROOT = process.env.PROJECT_ROOT || '/opt/telegram-monitor';
          const mainAccountSessionPath = path.join(PROJECT_ROOT, 'data', 'session', `user_${currentAccountId.toString()}.session`);
          
          if (fs.existsSync(mainAccountSessionPath)) {
            const stats = fs.statSync(mainAccountSessionPath);
            if (stats.isFile() && stats.size > 0) {
              console.log(`✅ [子账号创建] 主账号已登录，检查主账号的多开容器...`);
              
              // 检查主账号的多开容器是否存在
              const Docker = require('dockerode');
              const dockerSocketPaths = [
                '/var/run/docker.sock',
                process.env.DOCKER_HOST?.replace('unix://', '') || null
              ].filter(Boolean);
              
              let docker = null;
              for (const socketPath of dockerSocketPaths) {
                if (fs.existsSync(socketPath)) {
                  try {
                    docker = new Docker({ socketPath });
                    await docker.ping();
                    break;
                  } catch (e) {
                    // 继续尝试
                  }
                }
              }
              
              if (docker) {
                const mainContainerName = `tg_listener_${currentAccountId.toString()}`;
                try {
                  const mainContainer = docker.getContainer(mainContainerName);
                  const mainContainerInfo = await mainContainer.inspect();
                  if (mainContainerInfo.State.Running) {
                    console.log(`✅ [子账号创建] 主账号的多开容器已在运行: ${mainContainerName}`);
                  } else {
                    console.log(`🔄 [子账号创建] 主账号的多开容器存在但未运行，启动中...`);
                    await syncUserConfigAndStartMultiLoginContainer(currentAccountId.toString());
                    console.log(`✅ [子账号创建] 主账号的多开容器已启动`);
                  }
                } catch (containerError) {
                  // 容器不存在，需要创建
                  console.log(`🔄 [子账号创建] 主账号的多开容器不存在，创建中...`);
                  await syncUserConfigAndStartMultiLoginContainer(currentAccountId.toString());
                  console.log(`✅ [子账号创建] 主账号的多开容器已创建并启动`);
                }
              }
            } else {
              console.log(`⏭️  [子账号创建] 主账号未登录，跳过创建多开容器`);
            }
          } else {
            console.log(`⏭️  [子账号创建] 主账号未登录（无session文件），跳过创建多开容器`);
          }
        }
      } catch (multiLoginCheckError) {
        console.warn(`⚠️  [子账号创建] 检查多开模式失败（不影响子账号创建）: ${multiLoginCheckError.message}`);
      }
    }, 500); // 延迟500ms执行，不阻塞响应
    
    res.json({ 
      status: 'ok', 
      message: '子账号创建成功',
      user: {
        _id: user._id,
        username: user.username,
        display_name: user.display_name,
        is_active: user.is_active,
        parent_account_id: user.parent_account_id,
        created_at: user.created_at
      }
    });
  } catch (error) {
    console.error('❌ 创建子账号失败:', error);
    res.status(500).json({ error: '创建子账号失败：' + error.message });
  }
});

// 获取 / 设置公开注册开关（仅主账号）
app.get('/api/admin/public-registration', authMiddleware, async (req, res) => {
  try {
    const currentUser = req.user.userObj;
    if (currentUser.parent_account_id) {
      return res.status(403).json({ error: '仅主账号可设置公开注册开关' });
    }
    return res.json({ enabled: isPublicRegistrationAllowed() });
  } catch (error) {
    console.error('❌ [公开注册] 获取状态失败:', error);
    return res.status(500).json({ error: '获取公开注册状态失败：' + error.message });
  }
});

app.post('/api/admin/public-registration', authMiddleware, async (req, res) => {
  try {
    const currentUser = req.user.userObj;
    if (currentUser.parent_account_id) {
      return res.status(403).json({ error: '仅主账号可设置公开注册开关' });
    }
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: '参数 enabled 必须为布尔值' });
    }
    const cfg = loadConfig();
    cfg.allow_public_registration = enabled;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    console.log(`✅ [公开注册] 已更新: ${enabled ? '开启' : '关闭'}（操作人: ${currentUser.username}）`);
    return res.json({ enabled });
  } catch (error) {
    console.error('❌ [公开注册] 更新失败:', error);
    return res.status(500).json({ error: '更新公开注册状态失败：' + error.message });
  }
});

// 删除子账号（主账号可以删除该账号下的子账号）
app.delete('/api/users/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUser = req.user.userObj;
    const currentAccountId = await getAccountId(currentUser._id);
    console.log(`🗑️ [删除子账号] 请求人: ${currentUser.username}(${currentUser._id}), 目标: ${userId}, 主账号: ${currentAccountId}`);
    
    // 不允许删除自己
    if (userId === currentUser._id.toString()) {
      return res.status(400).json({ error: '不能删除自己的账号' });
    }
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    
    // 不允许删除主账号
    if (!user.parent_account_id) {
      return res.status(400).json({ error: '不能删除主账号' });
    }
    
    // 权限检查：只能删除同一主账号下的子账号
    const targetAccountId = user.parent_account_id;
    if (currentAccountId.toString() !== targetAccountId.toString()) {
      return res.status(403).json({ error: '权限不足：只能删除同一账号下的子账号' });
    }
    
    // 删除子账号及其配置（每个账号独立配置）
    await User.findByIdAndDelete(userId);
    await UserConfig.deleteOne({ userId });
    
    console.log(`✅ [删除子账号] ${currentUser.username} 删除了子账号 ${user.username} (${userId})`);
    res.json({ status: 'ok', message: '子账号删除成功' });
  } catch (error) {
    console.error(`❌ [删除子账号] 失败: ${error.message}`);
    res.status(500).json({ error: '删除子账号失败：' + error.message });
  }
});

// 获取可切换的用户列表（同一主账号下的所有账号）
app.get('/api/users/switchable', authMiddleware, async (req, res) => {
  try {
    const currentUser = req.user.userObj;
    const accountId = await getAccountId(currentUser._id);
    const accountIdObj = new mongoose.Types.ObjectId(accountId);
    
    // 查询该主账号下的所有账号（包括主账号和子账号）
    const users = await User.find({
      $or: [
        { _id: accountIdObj }, // 主账号
        { parent_account_id: accountIdObj } // 子账号
      ],
      is_active: true
    }).select('-password_hash').sort({ created_at: -1 });
    
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: '获取用户列表失败：' + error.message });
  }
});

// 切换账号（同一主账号下的所有账号可以随意切换）
app.post('/api/users/:userId/switch', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUser = req.user.userObj;
    const currentAccountId = await getAccountId(currentUser._id);
    console.log(`🔁 [切换用户] 请求人: ${currentUser.username}(${currentUser._id}), 目标: ${userId}, 主账号: ${currentAccountId}`);
    
    const targetUser = await User.findById(userId);
    if (!targetUser || !targetUser.is_active) {
      console.warn(`⚠️ [切换用户] 目标不存在或禁用: ${userId}`);
      return res.status(404).json({ error: '用户不存在或已被禁用' });
    }
    
    // 获取目标账号的主账号ID
    const targetAccountId = targetUser.parent_account_id || targetUser._id;
    
    // 权限检查：只能切换到同一主账号下的账号
    if (currentAccountId.toString() !== targetAccountId.toString()) {
      console.warn(`⚠️ [切换用户] 权限不足：请求主账号 ${currentAccountId}, 目标主账号 ${targetAccountId}`);
      return res.status(403).json({ error: '权限不足：只能切换到同一账号下的其他用户' });
    }
    
    // 生成目标用户的 JWT token（永不过期）
    const token = jwt.sign({ 
      userId: targetUser._id.toString(), 
      username: targetUser.username 
    }, JWT_SECRET);
    
    // 更新最后登录时间
    targetUser.last_login = new Date();
    await targetUser.save();
    
    // 清除旧用户和新用户的登录状态缓存
    const oldUserId = currentUser._id.toString();
    const newUserId = targetUser._id.toString();
    loginStatusCache.delete(`login_status_${oldUserId}`);
    loginStatusCache.delete(`login_status_${newUserId}`);
    console.log(`🗑️  已清除用户 ${oldUserId} 和 ${newUserId} 的登录状态缓存`);
    
    // 切换用户后，检查 session 文件状态（异步执行，不阻塞响应）
    // 注意：不再自动删除 session 文件，只做状态检测
    setTimeout(async () => {
      try {
        // 检查新用户的 session 文件是否存在
        const sessionExists = await checkSessionFileInVolume(newUserId);
        if (sessionExists) {
          // 如果文件存在，验证它是否有效（仅检测，不删除）
          const userConfig = await loadUserConfig(newUserId);
          const config = userConfig.toObject ? userConfig.toObject() : userConfig;
          const apiId = config.telegram?.api_id || 0;
          const apiHash = config.telegram?.api_hash || '';
          
          if (apiId && apiHash) {
            const sessionPath = `/opt/telegram-monitor/data/session/user_${newUserId}`;
            try {
              // 验证 session 文件是否有效（使用较短的超时）
              const checkResult = await Promise.race([
                execTelethonLoginScript('check', [
                  sessionPath,
                  apiId.toString(),
                  apiHash
                ], 0, true),
                new Promise((_, reject) => 
                  setTimeout(() => reject(new Error('验证超时')), 3000)
                )
              ]);
              
              // 如果验证失败，只记录日志，不删除文件
              if (checkResult && 
                  checkResult.success !== undefined &&
                  !checkResult.success &&
                  !checkResult.logged_in) {
                console.warn(`⚠️  [切换用户] 检测到无效的 session 文件，但不删除（仅状态检测）: ${sessionPath}`);
              }
            } catch (verifyError) {
              // 验证失败（超时或错误），不删除，只记录日志
              console.warn(`⚠️  [切换用户] 验证 session 文件时出错: ${verifyError.message}`);
            }
          }
        }
      } catch (error) {
        console.warn(`⚠️  [切换用户] 检查 session 文件时出错: ${error.message}`);
      }
    }, 1000); // 延迟1秒，确保切换用户响应已返回
    
    // 检查是否启用多开登录（使用主账号的配置）
    const accountConfig = await loadUserConfig(currentAccountId.toString());
    const multiLoginEnabled = accountConfig.multi_login_enabled || false;
    
    // 更新全局配置文件并同步用户配置（异步执行，不阻塞响应）
    setTimeout(async () => {
      try {
        if (multiLoginEnabled) {
          // 多开登录模式：为每个用户创建独立容器
          // 需要确保主容器（tg_listener）被停止，因为多开模式下只使用独立容器
          try {
            const Docker = require('dockerode');
            const dockerSocketPaths = [
              '/var/run/docker.sock',
              process.env.DOCKER_HOST?.replace('unix://', '') || null
            ].filter(Boolean);
            
            let docker = null;
            for (const socketPath of dockerSocketPaths) {
              if (fs.existsSync(socketPath)) {
                try {
                  docker = new Docker({ socketPath });
                  await docker.ping();
                  break;
                } catch (e) {
                  // 继续尝试下一个路径
                }
              }
            }
            
            if (docker) {
              try {
                // 停止主容器（tg_listener），因为多开模式下不使用主容器
                const containers = await docker.listContainers({ all: true });
                const mainContainer = containers.find(c => 
                  c.Names && c.Names.some(name => {
                    const cleanName = name.replace(/^\//, '');
                    return cleanName === 'tg_listener';
                  })
                );
                
                if (mainContainer) {
                  const container = docker.getContainer(mainContainer.Id);
                  const inspect = await container.inspect();
                  if (inspect.State.Running || inspect.State.Restarting) {
                    console.log(`🛑 [切换用户] 多开模式下停止主容器 tg_listener...`);
                    await container.stop({ t: 10 });
                    console.log(`✅ [切换用户] 主容器已停止`);
                  }
                }
              } catch (mainContainerError) {
                console.warn(`⚠️  [切换用户] 停止主容器失败（不影响功能）: ${mainContainerError.message}`);
              }
            }
          } catch (dockerError) {
            console.warn(`⚠️  [切换用户] 连接 Docker 失败（不影响切换用户）: ${dockerError.message}`);
          }
          
          // 启动目标用户的多开容器
          await syncUserConfigAndStartMultiLoginContainer(targetUser._id.toString());
          
          // 如果切换到的不是主账号，确保主账号的多开容器也在运行（如果主账号已登录）
          if (targetUser._id.toString() !== currentAccountId.toString()) {
            try {
              const PROJECT_ROOT = process.env.PROJECT_ROOT || '/opt/telegram-monitor';
              const mainAccountSessionPath = path.join(PROJECT_ROOT, 'data', 'session', `user_${currentAccountId.toString()}.session`);
              
              if (fs.existsSync(mainAccountSessionPath)) {
                const stats = fs.statSync(mainAccountSessionPath);
                if (stats.isFile() && stats.size > 0) {
                  console.log(`🔍 [切换用户] 检查主账号的多开容器...`);
                  
                  const mainContainerName = `tg_listener_${currentAccountId.toString()}`;
                  try {
                    const mainContainer = docker.getContainer(mainContainerName);
                    const mainContainerInfo = await mainContainer.inspect();
                    if (mainContainerInfo.State.Running) {
                      console.log(`✅ [切换用户] 主账号的多开容器已在运行: ${mainContainerName}`);
                    } else {
                      console.log(`🔄 [切换用户] 主账号的多开容器存在但未运行，启动中...`);
                      await syncUserConfigAndStartMultiLoginContainer(currentAccountId.toString());
                      console.log(`✅ [切换用户] 主账号的多开容器已启动`);
                    }
                  } catch (containerError) {
                    // 容器不存在，需要创建
                    console.log(`🔄 [切换用户] 主账号的多开容器不存在，创建中...`);
                    await syncUserConfigAndStartMultiLoginContainer(currentAccountId.toString());
                    console.log(`✅ [切换用户] 主账号的多开容器已创建并启动`);
                  }
                }
              }
            } catch (mainAccountError) {
              console.warn(`⚠️  [切换用户] 检查主账号容器失败（不影响切换用户）: ${mainAccountError.message}`);
            }
          }
        } else {
          // 单开模式：更新全局配置并重启主容器
          // 如果之前是多开模式，先清理多开容器
          try {
            const Docker = require('dockerode');
            const dockerSocketPaths = [
              '/var/run/docker.sock',
              process.env.DOCKER_HOST?.replace('unix://', '') || null
            ].filter(Boolean);
            
            let docker = null;
            for (const socketPath of dockerSocketPaths) {
              if (fs.existsSync(socketPath)) {
                try {
                  docker = new Docker({ socketPath });
                  await docker.ping();
                  break;
                } catch (e) {
                  // 继续尝试下一个路径
                }
              }
            }
            
            if (docker) {
              // 查找当前账号下的所有多开容器（tg_listener_* 格式）
              // 需要找到该账号下的所有用户（包括主账号和子账号）
              const accountId = await getAccountId(targetUser._id.toString());
              const accountIdObj = new mongoose.Types.ObjectId(accountId);
              const User = require('./userModel');
              const accountUsers = await User.find({
                $or: [
                  { _id: accountIdObj },
                  { parent_account_id: accountIdObj }
                ]
              }).select('_id').lean();
              const accountUserIds = accountUsers.map(u => u._id.toString());
              
              const containers = await docker.listContainers({ all: true });
              const multiLoginContainers = containers.filter(c => {
                if (!c.Names || c.Names.length === 0) return false;
                return c.Names.some(name => {
                  const cleanName = name.replace(/^\//, ''); // 移除开头的 /
                  // 匹配格式：tg_listener_${userId}，排除主容器 tg_listener
                  if (cleanName === 'tg_listener') return false;
                  if (cleanName.startsWith('tg_listener_')) {
                    // 提取 userId
                    const containerUserId = cleanName.replace('tg_listener_', '');
                    // 检查是否属于当前账号
                    return accountUserIds.includes(containerUserId);
                  }
                  return false;
                });
              });
              
              if (multiLoginContainers.length > 0) {
                console.log(`🛑 [切换用户] 检测到多开容器，但多开登录已关闭，清理 ${multiLoginContainers.length} 个多开容器...`);
                
                for (const containerInfo of multiLoginContainers) {
                  try {
                    const container = docker.getContainer(containerInfo.Id);
                    const containerName = containerInfo.Names[0]?.replace('/', '') || containerInfo.Id;
                    
                    const inspect = await container.inspect();
                    if (inspect.State.Running || inspect.State.Restarting) {
                      await container.stop({ t: 10 });
                      await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                    
                    await container.remove({ force: true });
                    console.log(`✅ [切换用户] 已删除多开容器: ${containerName}`);
                  } catch (containerError) {
                    console.warn(`⚠️  [切换用户] 删除多开容器失败: ${containerError.message}`);
                  }
                }
              }
            }
          } catch (cleanupError) {
            console.warn(`⚠️  [切换用户] 清理多开容器失败: ${cleanupError.message}`);
          }
          
          await syncUserConfigAndRestartTelethon(targetUser._id.toString());
        }
      } catch (error) {
        console.error('⚠️  切换用户后同步配置失败（不影响切换用户）:', error);
      }
    }, 500); // 延迟500ms，确保切换用户响应已返回
    
    console.log(`✅ [切换用户] ${currentUser.username} -> ${targetUser.username} (userId: ${targetUser._id})`);
    
    res.json({ 
      token, 
      username: targetUser.username,
      displayName: targetUser.display_name || targetUser.username,
      userId: targetUser._id.toString(),
      message: '切换用户成功。Telethon 服务正在重启以应用新配置，请稍候...'
    });
  } catch (error) {
    res.status(500).json({ error: '切换用户失败：' + error.message });
  }
});

// ===== 配置相关 API =====

// 内部 API：Telethon 服务获取用户配置（不需要认证，但需要 USER_ID）
app.get('/api/internal/user-config/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: '无效的用户ID' });
    }
    
    const userConfig = await loadUserConfig(userId);
    const config = userConfig.toObject ? userConfig.toObject() : userConfig;
    
    // 返回完整配置（包括敏感信息，因为这是内部 API）
    res.json(config);
  } catch (error) {
    console.error('获取用户配置失败:', error);
    res.status(500).json({ error: '获取配置失败：' + error.message });
  }
});

// 获取配置（不包含敏感信息）
app.get('/api/config', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const userConfig = await loadUserConfig(userId);
    
    // 转换为前端需要的格式
    const config = userConfig.toObject ? userConfig.toObject() : userConfig;
    
    // 🔒 不返回敏感信息给前端，但返回是否已配置的标志
    if (config.telegram) {
      // 返回一个标志，表示 API_HASH 是否已配置（但不返回实际值）
      config.telegram.api_hash_configured = !!(config.telegram.api_hash && config.telegram.api_hash.trim());
      delete config.telegram.api_hash; // 不返回 API Hash 实际值
    }
    if (config.ai_analysis) {
      delete config.ai_analysis.openai_api_key; // 不返回 OpenAI API Key
    }
    if (config.alert_actions?.email) {
      delete config.alert_actions.email.password; // 不返回邮箱密码
    }
    
    // 删除不需要的字段
    delete config._id;
    delete config.__v;
    delete config.userId;
    delete config.createdAt;
    delete config.updatedAt;
    
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: '读取配置失败：' + error.message });
  }
});

// 更新配置
app.post('/api/config', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const currentConfig = await loadUserConfig(userId);
    const incoming = { ...req.body };
    
    // 校验并清理 telegram 字段
    if (incoming.telegram) {
      incoming.telegram.api_id = Number(incoming.telegram.api_id || 0);
      // ✅ 如果前端没有发送 api_hash（因为我们不返回），则保留原有值
      if (!incoming.telegram.api_hash) {
        incoming.telegram.api_hash = (currentConfig.telegram?.api_hash || '').toString();
      }
    }
    
    // 校验并保留 AI 配置中的敏感信息和完整配置
    if (incoming.ai_analysis) {
      // 合并原有配置，避免关闭时丢失配置
      const existingAI = currentConfig.ai_analysis || {};
      // ✅ 修复：智能合并配置，避免空值覆盖原有配置
      // 对于字符串字段，如果前端发送的是空字符串，则保留原有值
      // 对于其他字段，如果前端发送的值是有效的，则更新；否则保留原有值
      incoming.ai_analysis = {
        ...existingAI,
        // enabled 字段总是更新（因为这是开关状态）
        enabled: incoming.ai_analysis.enabled !== undefined ? Boolean(incoming.ai_analysis.enabled) : existingAI.enabled || false,
        // ✅ 如果前端没有发送 API Key 或发送的是空字符串，则保留原有值
        openai_api_key: (incoming.ai_analysis.openai_api_key && incoming.ai_analysis.openai_api_key.trim()) ? incoming.ai_analysis.openai_api_key.trim() : (existingAI.openai_api_key || ''),
        // 字符串字段：如果前端发送了非空值，则更新；否则保留原有值
        openai_base_url: (incoming.ai_analysis.openai_base_url && incoming.ai_analysis.openai_base_url.trim()) ? incoming.ai_analysis.openai_base_url.trim() : (existingAI.openai_base_url || 'https://api.openai.com/v1'),
        openai_model: (incoming.ai_analysis.openai_model && incoming.ai_analysis.openai_model.trim()) ? incoming.ai_analysis.openai_model.trim() : (existingAI.openai_model || 'gpt-3.5-turbo'),
        analysis_trigger_type: (incoming.ai_analysis.analysis_trigger_type && ['time', 'count'].includes(incoming.ai_analysis.analysis_trigger_type)) ? incoming.ai_analysis.analysis_trigger_type : (existingAI.analysis_trigger_type || 'time'),
        analysis_prompt: (incoming.ai_analysis.analysis_prompt !== undefined && incoming.ai_analysis.analysis_prompt !== null) ? String(incoming.ai_analysis.analysis_prompt) : (existingAI.analysis_prompt || '请分析以下 Telegram 消息，提供：1) 整体情感倾向（积极/中性/消极）；2) 主要内容分类；3) 关键主题和摘要；4) 重要关键词'),
        // 数值字段：确保数值类型正确，如果无效则保留原有值
        message_count_threshold: (incoming.ai_analysis.message_count_threshold !== undefined && incoming.ai_analysis.message_count_threshold !== null && !isNaN(Number(incoming.ai_analysis.message_count_threshold))) ? Number(incoming.ai_analysis.message_count_threshold) : (existingAI.message_count_threshold || 50),
        time_interval_minutes: (incoming.ai_analysis.time_interval_minutes !== undefined && incoming.ai_analysis.time_interval_minutes !== null && !isNaN(Number(incoming.ai_analysis.time_interval_minutes))) ? Number(incoming.ai_analysis.time_interval_minutes) : (existingAI.time_interval_minutes || 30),
        max_messages_per_analysis: (incoming.ai_analysis.max_messages_per_analysis !== undefined && incoming.ai_analysis.max_messages_per_analysis !== null && !isNaN(Number(incoming.ai_analysis.max_messages_per_analysis))) ? Number(incoming.ai_analysis.max_messages_per_analysis) : (existingAI.max_messages_per_analysis || 500),
        // 布尔字段：如果前端发送了值，则更新；否则保留原有值
        ai_send_telegram: incoming.ai_analysis.ai_send_telegram !== undefined ? Boolean(incoming.ai_analysis.ai_send_telegram) : (existingAI.ai_send_telegram !== undefined ? existingAI.ai_send_telegram : true),
        ai_send_email: incoming.ai_analysis.ai_send_email !== undefined ? Boolean(incoming.ai_analysis.ai_send_email) : (existingAI.ai_send_email || false),
        ai_send_webhook: incoming.ai_analysis.ai_send_webhook !== undefined ? Boolean(incoming.ai_analysis.ai_send_webhook) : (existingAI.ai_send_webhook || false),
        // 固定用户触发相关配置
        ai_trigger_enabled: incoming.ai_analysis.ai_trigger_enabled !== undefined ? Boolean(incoming.ai_analysis.ai_trigger_enabled) : (existingAI.ai_trigger_enabled || false),
        ai_trigger_users: incoming.ai_analysis.ai_trigger_users !== undefined ? (Array.isArray(incoming.ai_analysis.ai_trigger_users) ? incoming.ai_analysis.ai_trigger_users : []) : (existingAI.ai_trigger_users || []),
        ai_trigger_prompt: incoming.ai_analysis.ai_trigger_prompt !== undefined ? String(incoming.ai_analysis.ai_trigger_prompt || '') : (existingAI.ai_trigger_prompt || '')
      };
      
      console.log(`📋 [配置保存] ai_analysis 配置 - enabled: ${incoming.ai_analysis.enabled}, trigger_type: ${incoming.ai_analysis.analysis_trigger_type}, count_threshold: ${incoming.ai_analysis.message_count_threshold} (类型: ${typeof incoming.ai_analysis.message_count_threshold}), time_interval: ${incoming.ai_analysis.time_interval_minutes} (类型: ${typeof incoming.ai_analysis.time_interval_minutes}), trigger_enabled: ${incoming.ai_analysis.ai_trigger_enabled}`);
    } else if (currentConfig.ai_analysis) {
      // 如果前端没有发送 ai_analysis，保留原有配置
      incoming.ai_analysis = currentConfig.ai_analysis;
    }
    
    // 校验并保留 alert_actions 配置
    if (incoming.alert_actions) {
      // 合并原有配置，避免丢失未更新的字段
      const existingActions = currentConfig.alert_actions || {};
      incoming.alert_actions = {
        ...existingActions,
        ...incoming.alert_actions
      };
      
      // 特殊处理 email 密码：如果前端没有发送密码（因为我们不返回），则保留原有值
      if (incoming.alert_actions.email) {
        // 特殊处理密码：如果前端没有发送密码（因为我们不返回），则保留原有值
        if (!incoming.alert_actions.email.password || incoming.alert_actions.email.password === '') {
          incoming.alert_actions.email.password = (existingActions.email?.password || '').toString();
        }
        // 确保 email 对象完整，正确处理 false 值和空字符串
        incoming.alert_actions.email = {
          // ✅ 关键修复：正确处理 false 值，如果前端明确发送了 enable 值（包括 false），使用前端值；否则使用数据库中的值
          enable: incoming.alert_actions.email.enable !== undefined 
            ? Boolean(incoming.alert_actions.email.enable)
            : (existingActions.email?.enable !== undefined ? Boolean(existingActions.email.enable) : false),
          // ✅ 修复：正确处理空字符串，不能使用 || 运算符
          smtp_host: incoming.alert_actions.email.smtp_host !== undefined ? String(incoming.alert_actions.email.smtp_host) : (existingActions.email?.smtp_host || ''),
          smtp_port: incoming.alert_actions.email.smtp_port !== undefined ? Number(incoming.alert_actions.email.smtp_port) || 465 : (existingActions.email?.smtp_port || 465),
          username: incoming.alert_actions.email.username !== undefined ? String(incoming.alert_actions.email.username) : (existingActions.email?.username || ''),
          password: incoming.alert_actions.email.password || '',
          to: incoming.alert_actions.email.to !== undefined ? String(incoming.alert_actions.email.to) : (existingActions.email?.to || '')
        };
      } else if (existingActions.email) {
        // ✅ 如果前端没有发送 email 对象，但数据库中有，保留原有配置
        incoming.alert_actions.email = existingActions.email;
      } else {
        // ✅ 如果前端和数据库都没有 email 对象，创建默认对象
        incoming.alert_actions.email = {
          enable: false,
          smtp_host: '',
          smtp_port: 465,
          username: '',
          password: '',
          to: ''
        };
      }
      
      // 确保 webhook 对象完整，正确处理 false 值和空字符串
      if (incoming.alert_actions.webhook) {
        incoming.alert_actions.webhook = {
          // ✅ 关键修复：正确处理 false 值
          enable: incoming.alert_actions.webhook.enable !== undefined ? Boolean(incoming.alert_actions.webhook.enable) : (existingActions.webhook?.enable !== undefined ? existingActions.webhook.enable : false),
          // ✅ 修复：正确处理空字符串
          url: incoming.alert_actions.webhook.url !== undefined ? String(incoming.alert_actions.webhook.url) : (existingActions.webhook?.url || '')
        };
      } else if (existingActions.webhook) {
        // ✅ 如果前端没有发送 webhook 对象，但数据库中有，保留原有配置
        incoming.alert_actions.webhook = existingActions.webhook;
      }
      
      // telegram 可以是布尔值或对象
      if (incoming.alert_actions.telegram === undefined) {
        incoming.alert_actions.telegram = existingActions.telegram !== undefined ? existingActions.telegram : true;
      }
      
      console.log(`📋 [配置保存] alert_actions 配置:`, JSON.stringify(incoming.alert_actions, null, 2));
      // ✅ 验证邮件告警配置
      if (incoming.alert_actions.email) {
        console.log(`📧 [配置保存] 邮件告警配置 - enable: ${incoming.alert_actions.email.enable} (类型: ${typeof incoming.alert_actions.email.enable})`);
        console.log(`📧 [配置保存] 邮件告警配置 - smtp_host: "${incoming.alert_actions.email.smtp_host}", username: "${incoming.alert_actions.email.username}", to: "${incoming.alert_actions.email.to}"`);
      }
      // ✅ 验证 Webhook 配置
      if (incoming.alert_actions.webhook) {
        console.log(`🔗 [配置保存] Webhook 配置 - enable: ${incoming.alert_actions.webhook.enable} (类型: ${typeof incoming.alert_actions.webhook.enable})`);
      }
    } else if (currentConfig.alert_actions) {
      // 如果前端没有发送 alert_actions，保留原有配置
      incoming.alert_actions = currentConfig.alert_actions;
      console.log(`📋 [配置保存] 前端未发送 alert_actions，保留原有配置`);
    }
    
    // 检测 API_ID/API_HASH 是否变化（需要重启 Telethon 服务）
    let telegramConfigChanged = false;
    if (incoming.telegram) {
      const oldApiId = currentConfig.telegram?.api_id || 0;
      const oldApiHash = currentConfig.telegram?.api_hash || '';
      const newApiId = incoming.telegram.api_id || 0;
      const newApiHash = incoming.telegram.api_hash || '';
      
      if (oldApiId !== newApiId || oldApiHash !== newApiHash) {
        telegramConfigChanged = true;
        console.log(`⚠️  检测到 Telegram API 配置变化 (用户ID: ${userId})`);
      }
    }
    
    // 处理多开登录配置
    const oldMultiLoginEnabled = currentConfig.multi_login_enabled || false;
    let newMultiLoginEnabled = oldMultiLoginEnabled;
    let multiLoginStatusChanged = false;
    
    if (incoming.multi_login_enabled !== undefined) {
      newMultiLoginEnabled = Boolean(incoming.multi_login_enabled);
      multiLoginStatusChanged = oldMultiLoginEnabled !== newMultiLoginEnabled;
      console.log(`📋 [配置保存] multi_login_enabled: ${newMultiLoginEnabled} (变化: ${multiLoginStatusChanged ? '是' : '否'})`);
    } else if (currentConfig.multi_login_enabled !== undefined) {
      // 如果前端没有发送，保留原有配置
      newMultiLoginEnabled = currentConfig.multi_login_enabled;
    }
    
    incoming.multi_login_enabled = newMultiLoginEnabled;

    if (incoming.auto_send_configs !== undefined) {
      incoming.auto_send_configs = sanitizeAutoSendConfigs(incoming.auto_send_configs);
      console.log(`📋 [配置保存] auto_send_configs: ${incoming.auto_send_configs.length} 个`);
    } else if (currentConfig.auto_send_configs) {
      incoming.auto_send_configs = currentConfig.auto_send_configs;
    }
    
    // 准备更新数据
    const updateData = {
      ...incoming
    };
    
    // 添加详细日志，检查所有配置项是否正确接收
    console.log(`💾 [配置保存] 准备保存配置到数据库 (userId: ${userId})`);
    console.log(`📋 [配置保存] 接收到的配置字段:`, Object.keys(updateData).join(', '));
    
    // ✅ 验证基础配置项
    if (updateData.alert_keywords !== undefined) {
      console.log(`📋 [配置保存] alert_keywords 值:`, JSON.stringify(updateData.alert_keywords));
      console.log(`📋 [配置保存] alert_keywords 类型:`, typeof updateData.alert_keywords, Array.isArray(updateData.alert_keywords) ? '(数组)' : '(非数组)');
      console.log(`📋 [配置保存] alert_keywords 长度:`, Array.isArray(updateData.alert_keywords) ? updateData.alert_keywords.length : 'N/A');
    } else {
      console.log(`⚠️  [配置保存] alert_keywords 字段未接收到！`);
    }
    if (updateData.keywords !== undefined) {
      console.log(`📋 [配置保存] keywords 值:`, JSON.stringify(updateData.keywords));
      console.log(`📋 [配置保存] keywords 长度:`, Array.isArray(updateData.keywords) ? updateData.keywords.length : 'N/A');
    }
    if (updateData.log_all_messages !== undefined) {
      console.log(`📋 [配置保存] log_all_messages 值: ${updateData.log_all_messages} (类型: ${typeof updateData.log_all_messages})`);
    }
    if (updateData.alert_target !== undefined) {
      console.log(`📋 [配置保存] alert_target 值: "${updateData.alert_target}"`);
    }
    
    // 保存到数据库
    await saveUserConfig(userId, updateData);
    console.log(`✅ [配置保存] 配置已保存到数据库`);
    
    // 立即返回成功响应，不等待同步和重启操作
    // 构建响应消息
    let message = '配置保存成功';
    if (telegramConfigChanged) {
      message += '。⚠️ 检测到 API_ID 或 API_HASH 已更改，Telethon 服务正在后台重启中...';
    } else {
      message += '。配置正在后台同步中...';
    }
    
    res.json({ 
      status: 'ok', 
      message: message,
      requiresRestart: telegramConfigChanged
    });
    
    // 在后台异步执行同步配置和重启操作（不阻塞响应）
    setImmediate(async () => {
      try {
        // 验证保存后的配置
        const savedConfig = await loadUserConfig(userId);
        const savedObj = savedConfig.toObject ? savedConfig.toObject() : savedConfig;
        console.log(`✅ [配置保存] 验证保存结果 - alert_keywords:`, JSON.stringify(savedObj.alert_keywords || []), `(${(savedObj.alert_keywords || []).length} 个)`);
        // ✅ 验证邮件告警配置
        if (savedObj.alert_actions?.email) {
          console.log(`✅ [配置保存] 验证邮件告警配置 - enable: ${savedObj.alert_actions.email.enable} (类型: ${typeof savedObj.alert_actions.email.enable})`);
          console.log(`✅ [配置保存] 验证邮件告警配置 - smtp_host: "${savedObj.alert_actions.email.smtp_host}", username: "${savedObj.alert_actions.email.username}", to: "${savedObj.alert_actions.email.to}"`);
        }
        // ✅ 验证 Webhook 配置
        if (savedObj.alert_actions?.webhook) {
          console.log(`✅ [配置保存] 验证 Webhook 配置 - enable: ${savedObj.alert_actions.webhook.enable} (类型: ${typeof savedObj.alert_actions.webhook.enable})`);
        }
        // ✅ 验证 AI 分析配置
        if (savedObj.ai_analysis) {
          console.log(`✅ [配置保存] 验证 AI 分析配置 - enabled: ${savedObj.ai_analysis.enabled}, trigger_type: ${savedObj.ai_analysis.analysis_trigger_type}`);
        }
      } catch (verifyError) {
        console.error(`❌ [配置保存] 验证保存结果失败:`, verifyError.message);
      }
      
      // 如果Telegram凭证变化，需要重启Telethon服务
      if (telegramConfigChanged) {
        try {
          console.log(`🔄 [配置保存] Telegram凭证已变化，开始同步配置并重启Telethon服务`);
          await syncUserConfigAndRestartTelethon(userId);
          console.log(`✅ [配置保存] Telegram凭证配置已同步，Telethon服务已重启`);
        } catch (syncError) {
          console.error('❌ [配置保存] 同步Telegram凭证配置或重启Telethon失败:', syncError.message);
        }
      } else {
        // 非Telegram凭证配置变化，只同步配置并立即通知Telethon重载（不重启）
        try {
          console.log(`🔄 [配置保存] 开始同步配置到全局文件（立即通知Telethon重载）`);
          const globalConfig = loadConfig();
          const accountId = await getAccountId(userId);
          const accountIdObj = new mongoose.Types.ObjectId(accountId);
          const userConfig = await loadUserConfig(userId.toString());
          if (userConfig) {
            const configObj = userConfig.toObject ? userConfig.toObject() : userConfig;
            
            // 确保 alert_keywords 是数组
            let alertKeywordsArray = [];
            if (Array.isArray(configObj.alert_keywords)) {
              alertKeywordsArray = configObj.alert_keywords;
            } else if (typeof configObj.alert_keywords === 'string') {
              alertKeywordsArray = configObj.alert_keywords.split('\n').map(k => k.trim()).filter(k => k);
            } else if (configObj.alert_keywords) {
              alertKeywordsArray = [configObj.alert_keywords].filter(k => k);
            }
            
            const configToSync = {
              keywords: Array.isArray(configObj.keywords) ? configObj.keywords : (configObj.keywords || []),
              channels: Array.isArray(configObj.channels) ? configObj.channels : (configObj.channels || []),
              alert_keywords: alertKeywordsArray,
              alert_regex: Array.isArray(configObj.alert_regex) ? configObj.alert_regex : (configObj.alert_regex || []),
              log_all_messages: configObj.log_all_messages !== undefined ? configObj.log_all_messages : true,
              alert_target: configObj.alert_target || ''
            };
            
            // 同步 AI 分析配置（包括固定用户触发配置）
            if (configObj.ai_analysis) {
              configToSync.ai_analysis = {
                enabled: configObj.ai_analysis.enabled || false,
                ai_trigger_enabled: configObj.ai_analysis.ai_trigger_enabled || false,
                ai_trigger_users: Array.isArray(configObj.ai_analysis.ai_trigger_users) 
                  ? configObj.ai_analysis.ai_trigger_users 
                  : (typeof configObj.ai_analysis.ai_trigger_users === 'string' 
                      ? configObj.ai_analysis.ai_trigger_users.split('\n').map(u => u.trim()).filter(u => u)
                      : []),
                ai_trigger_prompt: configObj.ai_analysis.ai_trigger_prompt || ''
              };
              console.log(`✅ [配置保存] 已同步固定用户触发配置 - ai_trigger_enabled: ${configToSync.ai_analysis.ai_trigger_enabled}, 触发用户数: ${configToSync.ai_analysis.ai_trigger_users?.length || 0}`);
            }
            
            // 注意：不同步Telegram API配置（只有telegram凭证变化时才同步）
            
            // 更新全局配置，保留其他字段
            Object.assign(globalConfig, configToSync);
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(globalConfig, null, 2));
            console.log(`✅ [配置保存] 配置已同步到全局文件`);
            
            // 多开模式：同步到用户的独立配置文件
            const userConfigPath = path.join(__dirname, `config_${userId}.json`);
            // 检查路径是否是目录（不应该发生，但如果发生需要修复）
            if (fs.existsSync(userConfigPath) && fs.statSync(userConfigPath).isDirectory()) {
              console.error(`❌ [配置保存] 配置文件路径是目录而不是文件: ${userConfigPath}`);
              console.error(`   正在删除错误的目录并重新创建文件...`);
              try {
                fs.rmSync(userConfigPath, { recursive: true, force: true });
                console.log(`✅ [配置保存] 已删除错误的目录: ${userConfigPath}`);
              } catch (rmError) {
                console.error(`❌ [配置保存] 删除目录失败: ${rmError.message}`);
              }
            }
            
            // 构建用户独立配置数据
            const userConfigData = {
              user_id: userId.toString(),
              keywords: configToSync.keywords,
              channels: configToSync.channels,
              alert_keywords: configToSync.alert_keywords,
              alert_regex: configToSync.alert_regex,
              log_all_messages: configToSync.log_all_messages,
              alert_target: configToSync.alert_target
            };
            
            // 如果用户配置中有 Telegram API 配置，也添加到配置文件
            if (configObj.telegram && configObj.telegram.api_id && configObj.telegram.api_hash) {
              userConfigData.telegram = {
                api_id: configObj.telegram.api_id,
                api_hash: configObj.telegram.api_hash
              };
            }
            
            // 同步 AI 分析配置
            if (configObj.ai_analysis) {
              userConfigData.ai_analysis = {
                enabled: configObj.ai_analysis.enabled || false,
                ai_trigger_enabled: configObj.ai_analysis.ai_trigger_enabled || false,
                ai_trigger_users: Array.isArray(configObj.ai_analysis.ai_trigger_users) 
                  ? configObj.ai_analysis.ai_trigger_users 
                  : [],
                ai_trigger_prompt: configObj.ai_analysis.ai_trigger_prompt || ''
              };
            }
            
            // 写入用户独立配置文件
            fs.writeFileSync(userConfigPath, JSON.stringify(userConfigData, null, 2));
            console.log(`✅ [配置保存] 配置已同步到用户独立配置文件: ${userConfigPath}`);
            console.log(`   - keywords: ${configToSync.keywords?.length || 0} 个`);
            console.log(`   - alert_keywords: ${configToSync.alert_keywords?.length || 0} 个 ${configToSync.alert_keywords?.length > 0 ? `(${configToSync.alert_keywords.join(', ')})` : ''}`);
            
            // 立即通知Telethon服务重新加载配置（不阻塞，静默失败）
            // 在多开模式下，通知对应的多开容器；否则通知主容器
            await notifyTelethonConfigReload(userId.toString());
          }
        } catch (syncError) {
          console.warn('⚠️  [配置保存] 同步配置到全局文件失败（不影响配置保存）:', syncError.message);
          console.error('错误堆栈:', syncError.stack);
        }
      }
      
      // 如果 AI 分析配置有变化，重启定时器
      if (incoming.ai_analysis) {
        setTimeout(async () => {
          console.log('🔄 [配置保存] AI 分析配置已更新，重启定时器');
          await startAIAnalysisTimer();
          console.log('✅ [配置保存] AI 分析定时器已重启');
        }, 1000);
      }

      if (incoming.auto_send_configs) {
        setTimeout(async () => {
          console.log('🔄 [配置保存] 自动发送配置已更新，刷新调度器');
          await refreshAutoSendScheduler();
        }, 500);
      }
      
      // 处理多开登录状态变化和配置同步
      if (multiLoginStatusChanged) {
        try {
          const accountId = await getAccountId(userId);
          const accountIdObj = new mongoose.Types.ObjectId(accountId);
          
          if (!newMultiLoginEnabled) {
            // 关闭多开登录：停止并删除所有多开容器
            console.log(`🛑 [配置保存] 多开登录已关闭，开始清理所有多开容器...`);
            
            const Docker = require('dockerode');
            const dockerSocketPaths = [
              '/var/run/docker.sock',
              process.env.DOCKER_HOST?.replace('unix://', '') || null
            ].filter(Boolean);
            
            let docker = null;
            for (const socketPath of dockerSocketPaths) {
              if (fs.existsSync(socketPath)) {
                try {
                  docker = new Docker({ socketPath });
                  await docker.ping();
                  break;
                } catch (e) {
                  // 继续尝试下一个路径
                }
              }
            }
            
            if (docker) {
              try {
                // 查找当前账号下的所有多开容器（tg_listener_* 格式）
                // 需要找到该账号下的所有用户（包括主账号和子账号）
                const accountId = await getAccountId(userId);
                const accountIdObj = new mongoose.Types.ObjectId(accountId);
                const User = require('./userModel');
                const accountUsers = await User.find({
                  $or: [
                    { _id: accountIdObj },
                    { parent_account_id: accountIdObj }
                  ]
                }).select('_id').lean();
                const accountUserIds = accountUsers.map(u => u._id.toString());
                
                console.log(`🔍 [配置保存] 账号 ${accountId} 下有 ${accountUserIds.length} 个用户，查找对应的多开容器...`);
                
                const containers = await docker.listContainers({ all: true });
                const multiLoginContainers = containers.filter(c => {
                  if (!c.Names || c.Names.length === 0) return false;
                  return c.Names.some(name => {
                    const cleanName = name.replace(/^\//, ''); // 移除开头的 /
                    // 匹配格式：tg_listener_${userId}，排除主容器 tg_listener
                    if (cleanName === 'tg_listener') return false;
                    if (cleanName.startsWith('tg_listener_')) {
                      // 提取 userId
                      const containerUserId = cleanName.replace('tg_listener_', '');
                      // 检查是否属于当前账号
                      return accountUserIds.includes(containerUserId);
                    }
                    return false;
                  });
                });
                
                console.log(`🔍 [配置保存] 找到 ${multiLoginContainers.length} 个属于当前账号的多开容器`);
                
                for (const containerInfo of multiLoginContainers) {
                  try {
                    const container = docker.getContainer(containerInfo.Id);
                    const containerName = containerInfo.Names[0]?.replace('/', '') || containerInfo.Id;
                    
                    console.log(`🗑️  [配置保存] 停止并删除多开容器: ${containerName}`);
                    
                    // 停止容器
                    const inspect = await container.inspect();
                    if (inspect.State.Running || inspect.State.Restarting) {
                      await container.stop({ t: 10 });
                      await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                    
                    // 删除容器
                    await container.remove({ force: true });
                    console.log(`✅ [配置保存] 已删除多开容器: ${containerName}`);
                  } catch (containerError) {
                    console.warn(`⚠️  [配置保存] 删除多开容器失败: ${containerError.message}`);
                  }
                }
                
                // 等待多开容器完全停止和删除（确保清理完成）
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                // 重启主容器以应用单开模式
                // 使用主账号ID，确保主容器使用主账号的session文件
                const mainAccountId = accountId.toString();
                console.log(`🔄 [配置保存] 重启主容器以应用单开模式（使用主账号: ${mainAccountId}）...`);
                // 强制重启主容器，忽略多开容器检查（因为正在关闭多开模式）
                await forceRestartMainContainer(mainAccountId);
                console.log(`✅ [配置保存] 多开登录已关闭，主容器已重启（使用主账号: ${mainAccountId}）`);
              } catch (cleanupError) {
                console.error(`❌ [配置保存] 清理多开容器失败: ${cleanupError.message}`);
              }
            } else {
              console.warn(`⚠️  [配置保存] 无法连接到 Docker，跳过多开容器清理`);
            }
          } else {
            // 开启多开登录：为该账号下的所有用户创建多开容器
            console.log(`🔄 [配置保存] 多开登录已开启，为该账号下的所有用户创建多开容器...`);
            try {
              // 先停止主容器，因为多开模式下不使用主容器
              try {
                const Docker = require('dockerode');
                const dockerSocketPaths = [
                  '/var/run/docker.sock',
                  process.env.DOCKER_HOST?.replace('unix://', '') || null
                ].filter(Boolean);
                
                let docker = null;
                for (const socketPath of dockerSocketPaths) {
                  if (fs.existsSync(socketPath)) {
                    try {
                      docker = new Docker({ socketPath });
                      await docker.ping();
                      break;
                    } catch (e) {
                      // 继续尝试下一个路径
                    }
                  }
                }
                
                if (docker) {
                  try {
                    // 停止主容器（tg_listener），因为多开模式下不使用主容器
                    const containers = await docker.listContainers({ all: true });
                    const mainContainer = containers.find(c => 
                      c.Names && c.Names.some(name => {
                        const cleanName = name.replace(/^\//, '');
                        return cleanName === 'tg_listener';
                      })
                    );
                    
                    if (mainContainer) {
                      const container = docker.getContainer(mainContainer.Id);
                      const inspect = await container.inspect();
                      if (inspect.State.Running || inspect.State.Restarting) {
                        console.log(`🛑 [配置保存] 多开登录模式下停止主容器 tg_listener...`);
                        await container.stop({ t: 10 });
                        console.log(`✅ [配置保存] 主容器已停止`);
                      }
                    }
                  } catch (mainContainerError) {
                    console.warn(`⚠️  [配置保存] 停止主容器失败（不影响功能）: ${mainContainerError.message}`);
                  }
                }
              } catch (dockerError) {
                console.warn(`⚠️  [配置保存] 连接 Docker 失败（不影响创建多开容器）: ${dockerError.message}`);
              }
              
              const User = require('./userModel');
              const accountUsers = await User.find({
                $or: [
                  { _id: accountIdObj },
                  { parent_account_id: accountIdObj }
                ]
              }).select('_id').lean();
              
              console.log(`🔍 [配置保存] 账号 ${accountId} 下有 ${accountUsers.length} 个用户，为所有用户创建多开容器...`);
              
              // 为每个用户创建多开容器
              for (const user of accountUsers) {
                try {
                  await syncUserConfigAndStartMultiLoginContainer(user._id.toString());
                  console.log(`✅ [配置保存] 已为用户 ${user._id} 创建多开容器`);
                } catch (createError) {
                  console.error(`❌ [配置保存] 为用户 ${user._id} 创建多开容器失败: ${createError.message}`);
                }
              }
              
              console.log(`✅ [配置保存] 多开登录已开启，已为该账号下的所有用户创建多开容器`);
            } catch (createError) {
              console.error(`❌ [配置保存] 创建多开容器失败: ${createError.message}`);
            }
          }
        } catch (multiLoginError) {
          console.error(`❌ [配置保存] 处理多开登录状态变化失败: ${multiLoginError.message}`);
        }
      } else if (newMultiLoginEnabled) {
        // 如果多开登录已启用，但配置有变化，需要同步更新多开容器的配置文件
        console.log(`🔄 [配置保存] 多开登录已启用，同步更新多开容器配置...`);
        try {
          await syncUserConfigAndStartMultiLoginContainer(userId);
          console.log(`✅ [配置保存] 多开容器配置已同步更新`);
        } catch (syncError) {
          console.warn(`⚠️  [配置保存] 同步多开容器配置失败（不影响配置保存）: ${syncError.message}`);
        }
      }
    });
  } catch (error) {
    // 详细错误日志
    const fileExists = fs.existsSync(CONFIG_PATH);
    const isDirectory = fileExists ? fs.statSync(CONFIG_PATH).isDirectory() : false;
    
    console.error('[CONFIG_SAVE_ERROR]', {
      timestamp: new Date().toISOString(),
      error: error.message,
      errorCode: error.code,
      stack: error.stack,
      configPath: CONFIG_PATH,
      fileExists: fileExists,
      isDirectory: isDirectory
    });
    
    // 返回详细错误信息（帮助用户诊断问题）
    let errorMessage = '保存配置失败';
    
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      errorMessage = '保存配置失败：没有写入权限，请检查 backend/config.json 文件权限。在服务器上执行: chmod 644 backend/config.json';
    } else if (error.code === 'ENOENT') {
      errorMessage = '保存配置失败：配置文件目录不存在';
    } else if (error.code === 'EISDIR' || isDirectory) {
      errorMessage = '保存配置失败：config.json 是目录而不是文件，请删除该目录后重试。在服务器上执行: rm -rf backend/config.json && cp backend/config.json.example backend/config.json';
    } else if (error.message && error.message.includes('JSON')) {
      errorMessage = '保存配置失败：配置数据格式错误，请检查配置内容';
    } else if (error.message) {
      errorMessage = `保存配置失败：${error.message}`;
    }
    
    res.status(500).json({ error: errorMessage });
  }
});

// 保存 Telegram API 凭证并重启 Telethon 服务
app.post('/api/config/telegram', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const currentConfig = await loadUserConfig(userId);
    const { api_id, api_hash } = req.body;
    
    // 验证输入
    const apiIdNum = Number(api_id);
    const apiHashStr = (api_hash || '').toString().trim();
    
    // 验证 API_ID 是否为有效数字
    if (!api_id || isNaN(apiIdNum) || apiIdNum <= 0) {
      return res.status(400).json({ error: 'API_ID 必须是有效的正整数' });
    }
    
    // 验证 API_HASH 是否为空
    if (!apiHashStr) {
      return res.status(400).json({ error: 'API_HASH 不能为空，请填写有效的 Telegram API 凭证' });
    }
    
    // 准备更新数据（直接使用传入的值，不使用旧值作为回退）
    const updateData = {
      telegram: {
        api_id: apiIdNum,
        api_hash: apiHashStr
      }
    };
    
    console.log(`💾 [Telegram凭证保存] API_ID: ${apiIdNum}, API_HASH: ${apiHashStr.substring(0, 8)}...`);
    
    console.log(`💾 [Telegram凭证保存] 准备保存到数据库 (userId: ${userId})`);
    
    // 保存到数据库
    await saveUserConfig(userId, updateData);
    console.log(`✅ [Telegram凭证保存] 配置已保存到数据库`);
    
    // 快速同步配置到文件（不等待重启，异步执行重启）
    try {
      console.log(`🔄 [Telegram凭证保存] 开始同步配置到全局文件`);
      
      // 快速同步配置（只更新配置文件，不重启服务）
      const globalConfig = loadConfig();
      globalConfig.user_id = userId.toString();
      globalConfig.telegram = {
        api_id: apiIdNum,
        api_hash: apiHashStr
      };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(globalConfig, null, 2));
      console.log(`✅ [Telegram凭证保存] 配置已同步到全局文件`);
      
      // 清除用户配置缓存
      userConfigCache.delete(`user_config_${userId}`);
      
      // 如果是多开登录模式，也需要更新独立配置文件
      const userConfigPath = path.join(__dirname, `config_${userId}.json`);
      if (fs.existsSync(userConfigPath)) {
        try {
          const userConfigData = JSON.parse(fs.readFileSync(userConfigPath, 'utf-8'));
          userConfigData.telegram = {
            api_id: apiIdNum,
            api_hash: apiHashStr
          };
          fs.writeFileSync(userConfigPath, JSON.stringify(userConfigData, null, 2));
          console.log(`✅ [Telegram凭证保存] 已更新多开登录配置文件: ${userConfigPath}`);
        } catch (multiConfigError) {
          console.warn('⚠️ [Telegram凭证保存] 更新多开登录配置文件失败:', multiConfigError.message);
        }
      }
      
      // 异步重启 Telethon 服务（不阻塞响应）
      syncUserConfigAndRestartTelethon(userId).catch(err => {
        console.error('⚠️ [Telegram凭证保存] 异步重启Telethon服务失败（不影响保存）:', err.message);
      });
      
      console.log(`✅ [Telegram凭证保存] 配置同步完成，Telethon服务正在后台重启`);
    } catch (syncError) {
      console.error('❌ [Telegram凭证保存] 同步配置失败:', syncError.message);
      // 即使同步失败，配置已保存到数据库，仍然返回成功
      console.warn('⚠️ [Telegram凭证保存] 配置已保存到数据库，但同步到文件失败，Telethon将在下次重载配置时生效');
    }
    
    res.json({ 
      status: 'ok', 
      message: 'Telegram API 凭证保存成功，Telethon 服务正在后台重启'
    });
  } catch (error) {
    console.error('❌ 保存Telegram凭证失败:', error);
    res.status(500).json({ error: '保存失败：' + error.message });
  }
});

// ===== 日志相关 API =====

// ✅ 定义查询验证 schema
const logsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
  keyword: Joi.string().max(500).default(''),
  channelId: Joi.string().max(50).default('')
});

// 获取日志列表（分页）
app.get('/api/logs', authMiddleware, async (req, res) => {
  try {
    // ✅ 验证查询参数
    const { error, value } = logsQuerySchema.validate(req.query);
    if (error) {
      return res.status(400).json({ error: '无效的查询参数：' + error.message });
    }
    
    const { page, pageSize, keyword, channelId } = value;
    
    // 构建查询条件：按用户ID过滤，每个用户数据独立
    const userIdObj = new mongoose.Types.ObjectId(req.user.userId);
    const isAdmin = req.user.username === 'admin';
    
    // 如果是admin用户，可以查看自己的数据 + 没有userId的旧数据
    // 其他用户只能查看自己的数据
    const query = isAdmin 
      ? { $or: [{ userId: userIdObj }, { userId: { $exists: false } }, { userId: null }] }
      : { userId: userIdObj };
    
    if (keyword) {
      // ✅ 清理正则表达式特殊字符（防止 ReDoS）
      const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.message = { $regex: escapedKeyword, $options: 'i' };
    }
    if (channelId) {
      query.channelId = channelId;
    }
    
    const total = await Log.countDocuments(query);
    const logs = await Log.find(query)
      .sort({ time: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize);
    
    res.json({
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      logs
    });
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      res.status(500).json({ error: '获取日志失败' });
    } else {
      res.status(500).json({ error: '获取日志失败：' + error.message });
    }
  }
});

// 删除日志（按用户删除，支持全部删除或按条件删除）
app.delete('/api/logs', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    const isAdmin = username === 'admin';
    const userIdObj = new mongoose.Types.ObjectId(userId);
    
    // 构建删除查询条件：按用户ID过滤，每个用户只能删除自己的日志
    const deleteQuery = isAdmin 
      ? { $or: [{ userId: userIdObj }, { userId: { $exists: false } }, { userId: null }] }
      : { userId: userIdObj };
    
    // 支持可选的条件删除（如按关键词、频道等）
    const { keyword, channelId, beforeDate } = req.body;
    
    if (keyword) {
      const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      deleteQuery.message = { $regex: escapedKeyword, $options: 'i' };
    }
    if (channelId) {
      deleteQuery.channelId = channelId;
    }
    if (beforeDate) {
      deleteQuery.time = { $lt: new Date(beforeDate) };
    }
    
    // 先统计要删除的日志数量
    const deleteCount = await Log.countDocuments(deleteQuery);
    
    if (deleteCount === 0) {
      return res.json({ 
        status: 'ok', 
        message: '没有找到要删除的日志',
        deletedCount: 0
      });
    }
    
    // 执行删除操作
    const result = await Log.deleteMany(deleteQuery);
    
    // 同时删除相关的AI分析结果引用（如果日志被删除，相关的分析结果引用也需要清理）
    // 注意：这里不删除AISummary本身，只是清理引用关系
    
    // 清除统计缓存，强制重新计算
    statsCache.delete(userId);
    
    console.log(`✅ 用户 ${username} (${userId}) 删除了 ${result.deletedCount} 条日志`);
    
    res.json({ 
      status: 'ok', 
      message: `成功删除 ${result.deletedCount} 条日志`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('❌ 删除日志失败:', error);
    res.status(500).json({ error: '删除日志失败：' + error.message });
  }
});

// ===== SSE 实时推送 =====

// SSE 客户端连接池已在文件顶部声明（第25行），无需重复声明

// SSE 事件推送端点
app.get('/api/events', authMiddleware, (req, res) => {
  const userId = req.user.userId;
  
  // 多开登录模式支持：允许同一用户有多个SSE连接（不同标签页/窗口）
  // 不再清理同一用户的旧连接，以支持多开模式下的实时推送
  // 前端会在建立新连接前主动断开旧连接，避免重复连接
  
  // 设置 SSE 响应头（必须严格按照 SSE 规范）
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // 禁用 nginx 缓冲
  // CORS：只有在浏览器带 Origin 时才回显，避免无 Origin 时发送无效组合（Allow-Credentials + *）
  if (req.headers.origin) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  
  // 尽可能降低延迟 & 提升长连接稳定性（尤其在代理/容器/Windows 下）
  try {
    if (req.socket) {
      // 避免 Nagle 聚合带来的小包延迟
      req.socket.setNoDelay(true);
      // 开启 TCP keepalive，降低 NAT/代理空闲回收概率
      req.socket.setKeepAlive(true, 60000);
      // 禁用 socket 超时（SSE 是长连接）
      req.socket.setTimeout(0);
    }
  } catch (e) {
    // 忽略 socket 设置错误
  }

  // 立即刷新响应头，确保连接建立
  res.flushHeaders();

  // 发送 retry 建议（对标准 EventSource 有效；fetch-stream 客户端可忽略）
  // 同时发送一段 padding（常见 2KB）以尽快冲破中间层缓冲，提升“首条消息更及时”
  try {
    res.write(`retry: 5000\n`);
    res.write(`: ${' '.repeat(2048)}\n\n`);
  } catch (e) {
    // ignore
  }

  // 发送初始连接消息
  try {
    const initMessage = JSON.stringify({
      type: 'connected',
      message: '实时推送已连接',
      userId: userId,
      timestamp: new Date().toISOString()
    });
    res.write(`data: ${initMessage}\n\n`);
    // 立即刷新，确保初始消息立即发送
    if (typeof res.flush === 'function') {
      res.flush();
    }
  } catch (err) {
    console.error('SSE 初始化消息发送失败:', err);
    return res.end();
  }

  // 创建客户端信息对象，包含用户ID和连接时间
  const clientInfo = {
    res: res,
    userId: userId,
    connectedAt: Date.now(),
    lastPing: Date.now(),
    heartbeatInterval: null,
    closed: false,
    backpressureCount: 0
  };

  // 将客户端添加到连接池（使用对象而不是直接存储 res）
  sseClients.add(clientInfo);
  
  // 统计该用户的连接数（支持多开模式）
  let userConnectionCount = 0;
  sseClients.forEach(client => {
    if (client.userId === userId) {
      userConnectionCount++;
    }
  });
  console.log(`✅ 用户 ${userId} 的 SSE 连接已建立（该用户连接数: ${userConnectionCount}, 总连接数: ${sseClients.size}）`);

  // 定期发送心跳，保持连接活跃（减少到15秒，确保连接不会超时）
  const heartbeatInterval = setInterval(() => {
    if (sseClients.has(clientInfo)) {
      try {
        // 检查响应对象是否仍然可写
        if (!clientInfo.closed && res.writable && !res.destroyed) {
          const pingMessage = JSON.stringify({
            type: 'ping',
            timestamp: new Date().toISOString()
          });
          const ok = res.write(`data: ${pingMessage}\n\n`);
          if (!ok) {
            // 客户端读取过慢，避免堆积内存：主动断开让客户端重连
            clientInfo.backpressureCount += 1;
            if (clientInfo.backpressureCount >= 2) {
              throw new Error('SSE backpressure (heartbeat)');
            }
            res.once('drain', () => {
              clientInfo.backpressureCount = 0;
            });
          } else {
            // 立即刷新心跳消息
            try {
              if (typeof res.flush === 'function') {
                res.flush();
              }
            } catch (e) {
              // 忽略刷新错误
            }
          }
          clientInfo.lastPing = Date.now();
        } else {
          // 连接已断开
          clearInterval(heartbeatInterval);
          sseClients.delete(clientInfo);
          clientInfo.closed = true;
          res.end();
        }
      } catch (err) {
        // 写入失败，连接可能已断开
        clearInterval(heartbeatInterval);
        sseClients.delete(clientInfo);
        try {
          clientInfo.closed = true;
          res.end();
        } catch (e) {
          // 忽略结束连接时的错误
        }
      }
    } else {
      clearInterval(heartbeatInterval);
    }
  }, 15000); // 15秒心跳（更频繁，确保连接活跃）

  clientInfo.heartbeatInterval = heartbeatInterval;

  // 处理客户端断开连接
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeatInterval);
    sseClients.delete(clientInfo);
    clientInfo.closed = true;
    try {
      if (!res.destroyed && res.writable) {
        res.end();
      }
    } catch (err) {
      // 忽略清理时的错误
    }
  };

  // 监听多种断开事件
  req.on('close', cleanup);
  req.on('error', (err) => {
    console.error('SSE 连接错误:', err);
    cleanup();
  });
  req.on('aborted', () => {
    console.log('SSE 连接被客户端中止');
    cleanup();
  });
  
  res.on('close', cleanup);
  res.on('error', (err) => {
    console.error('SSE 响应错误:', err);
    cleanup();
  });
  
  res.on('finish', () => {
    cleanup();
  });
});

// 推送事件给所有连接的客户端（支持按用户ID过滤）
function broadcastEvent(eventType, data, targetUserId = null) {
  const message = JSON.stringify({ 
    type: eventType, 
    data, 
    timestamp: new Date().toISOString() 
  });
  const formattedMessage = `data: ${message}\n\n`;
  
  // 移除已断开的连接
  const disconnectedClients = [];
  
  sseClients.forEach(clientInfo => {
    try {
      // 如果指定了目标用户ID，只发送给该用户
      if (targetUserId && clientInfo.userId !== targetUserId) {
        return;
      }
      
      const res = clientInfo.res;
      
      // 检查连接是否仍然有效
      if (clientInfo.closed || !res || res.destroyed || !res.writable) {
        disconnectedClients.push(clientInfo);
        return;
      }
      
      // 尝试发送消息
      const ok = res.write(formattedMessage);
      if (!ok) {
        // 慢客户端：避免内存堆积，主动断开让其重连（前端有自动重连+降级刷新）
        clientInfo.backpressureCount = (clientInfo.backpressureCount || 0) + 1;
        disconnectedClients.push(clientInfo);
        try {
          clientInfo.closed = true;
          res.end();
        } catch (e) {
          // ignore
        }
        return;
      } else {
        clientInfo.backpressureCount = 0;
      }
      
      // 立即刷新响应，确保消息立即发送到客户端
      try {
        if (typeof res.flush === 'function') {
          res.flush();
        }
      } catch (e) {
        // 忽略刷新错误
      }
      
      // 更新最后活跃时间
      clientInfo.lastPing = Date.now();
      
    } catch (err) {
      // 连接已断开，标记为待删除
      console.error('SSE 推送消息失败:', err.message);
      disconnectedClients.push(clientInfo);
    }
  });
  
  // 清理断开的连接
  disconnectedClients.forEach(clientInfo => {
    try {
      if (clientInfo.heartbeatInterval) {
        clearInterval(clientInfo.heartbeatInterval);
      }
      if (clientInfo.res && !clientInfo.res.destroyed) {
        clientInfo.closed = true;
        clientInfo.res.end();
      }
    } catch (e) {
      // 忽略清理错误
    }
    sseClients.delete(clientInfo);
  });
}

// 定期清理无效连接（每5分钟）
setInterval(() => {
  const now = Date.now();
  const timeout = 2 * 60 * 1000; // 2分钟无响应视为超时
  const disconnectedClients = [];
  
  sseClients.forEach(clientInfo => {
    try {
      // 检查连接是否超时
      if (now - clientInfo.lastPing > timeout) {
        console.log(`清理超时的 SSE 连接: 用户 ${clientInfo.userId}`);
        disconnectedClients.push(clientInfo);
        return;
      }
      
      // 检查响应对象是否仍然有效
      if (!clientInfo.res || clientInfo.res.destroyed || !clientInfo.res.writable) {
        disconnectedClients.push(clientInfo);
      }
    } catch (err) {
      disconnectedClients.push(clientInfo);
    }
  });
  
  // 清理无效连接
  disconnectedClients.forEach(clientInfo => {
    try {
      if (clientInfo.heartbeatInterval) {
        clearInterval(clientInfo.heartbeatInterval);
      }
      if (clientInfo.res && !clientInfo.res.destroyed) {
        clientInfo.res.end();
      }
    } catch (e) {
      // 忽略清理错误
    }
    sseClients.delete(clientInfo);
  });
  
  if (disconnectedClients.length > 0) {
    console.log(`🧹 清理了 ${disconnectedClients.length} 个无效的 SSE 连接`);
  }
}, 5 * 60 * 1000); // 每5分钟检查一次

// ===== 统计相关 API =====

// 统计信息缓存（按用户缓存，减少MongoDB查询压力）
const statsCache = new Map(); // key: userId, value: { data, time }
const STATS_CACHE_TTL = 10000; // 缓存10秒

// 告警去重缓存：防止同一消息重复发送告警
// key: `${userId}_${channelId}_${messageId}`, value: timestamp
const alertDedupeCache = new Map();
const ALERT_DEDUPE_TTL = 5 * 60 * 1000; // 5分钟内不重复发送同一消息的告警

// 清理过期的告警去重缓存
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of alertDedupeCache.entries()) {
    if (now - timestamp > ALERT_DEDUPE_TTL) {
      alertDedupeCache.delete(key);
    }
  }
}, 60 * 1000); // 每分钟清理一次

// 获取统计信息（带缓存）
app.get('/api/stats', authMiddleware, async (req, res) => {
  // const startTime = Date.now();
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    const isAdmin = username === 'admin';
    const now = Date.now();
    
    // 检查用户缓存是否有效
    const cached = statsCache.get(userId);
    if (cached && (now - cached.time) < STATS_CACHE_TTL) {
      return res.json(cached.data);
    }
    
    // console.log(`[性能监控] /api/stats 开始执行数据库查询...`);
    // const queryStartTime = Date.now();
    
    // 构建查询条件：按用户ID过滤，每个用户数据独立
    const userIdObj = new mongoose.Types.ObjectId(userId);
    const userQuery = isAdmin 
      ? { $or: [{ userId: userIdObj }, { userId: { $exists: false } }, { userId: null }] }
      : { userId: userIdObj };
    
    // 并行执行所有查询以提高效率
    const [total, todayCount, alertedCount, channelStats] = await Promise.all([
      Log.countDocuments(userQuery),
      (() => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayQuery = { ...userQuery, time: { $gte: today } };
        return Log.countDocuments(todayQuery);
      })(),
      Log.countDocuments({ ...userQuery, alerted: true }),
      Log.aggregate([
        {
          $match: userQuery
        },
        {
          $group: {
            _id: '$channel',
            count: { $sum: 1 }
          }
        },
        {
          $sort: { count: -1 }
        },
        {
          $limit: 10
        }
      ])
    ]);
    
    const result = {
      total,
      todayCount,
      alertedCount,
      channelStats
    };
    
    // 更新用户缓存
    statsCache.set(userId, { data: result, time: Date.now() });
    
    // const queryTime = Date.now() - queryStartTime;
    // const totalTime = Date.now() - startTime;
    // console.log(`[性能监控] /api/stats 数据库查询耗时: ${queryTime}ms, 总耗时: ${totalTime}ms`);
    // if (queryTime > 100) {
    //   console.warn(`[性能警告] /api/stats 查询耗时过长: ${queryTime}ms，可能影响性能`);
    // }
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: '获取统计信息失败：' + error.message });
  }
});

// ===== 告警相关 API =====

// 获取 Telethon 服务 URL（根据 userId 和多开模式）
async function getTelethonServiceUrl(userId = null) {
  // 如果没有 userId，使用环境变量或默认服务名
  if (!userId) {
    if (process.env.TELETHON_URL) {
      console.log(`🔗 [Telethon URL] 未提供 userId，使用环境变量 TELETHON_URL: ${process.env.TELETHON_URL}`);
      return process.env.TELETHON_URL;
    }
    console.log(`🔗 [Telethon URL] 未提供 userId，使用默认服务: http://telethon:8888`);
    return 'http://telethon:8888';
  }
  
  // 优先检查是否启用了多开模式（多开模式下必须使用独立容器）
  try {
    const accountId = await getAccountId(userId);
    const accountConfig = await loadUserConfig(accountId.toString());
    const multiLoginEnabled = accountConfig.multi_login_enabled || false;
    
    console.log(`🔍 [Telethon URL] 检查多开模式 - userId: ${userId}, accountId: ${accountId}, multiLoginEnabled: ${multiLoginEnabled}`);
    
    if (multiLoginEnabled) {
      // 多开模式：使用独立容器名称
      // 容器名称格式：tg_listener_${userId}
      // 在 Docker 网络中，可以通过容器名称访问
      const containerUrl = `http://tg_listener_${userId}:8888`;
      console.log(`✅ [Telethon URL] 多开模式，使用容器 URL: ${containerUrl}`);
      return containerUrl;
    } else {
      // 单开模式：使用环境变量或默认服务名
      if (process.env.TELETHON_URL) {
        console.log(`✅ [Telethon URL] 单开模式，使用环境变量 TELETHON_URL: ${process.env.TELETHON_URL}`);
        return process.env.TELETHON_URL;
      }
      console.log(`✅ [Telethon URL] 单开模式，使用默认服务: http://telethon:8888`);
      return 'http://telethon:8888';
    }
  } catch (error) {
    // 如果检查失败，使用环境变量或默认服务名
    console.warn(`⚠️  [Telethon URL] 无法检查多开模式，使用备用方案: ${error.message}`);
    if (process.env.TELETHON_URL) {
      console.warn(`⚠️  [Telethon URL] 使用环境变量 TELETHON_URL: ${process.env.TELETHON_URL}`);
      return process.env.TELETHON_URL;
    }
    console.warn(`⚠️  [Telethon URL] 使用默认服务: http://telethon:8888`);
    return 'http://telethon:8888';
  }
}

function parseBoolEnv(v, defaultValue = false) {
  if (v === undefined || v === null || v === '') return defaultValue;
  const s = String(v).toLowerCase().trim();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return defaultValue;
}

function getDesiredTelethonImageName() {
  return process.env.TELETHON_IMAGE || 'telegram-monitor-telethon:latest';
}

async function waitForContainerRunning(container, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await container.inspect();
    if (info?.State?.Running) return { running: true, status: info.State.Status, info };
    if (info?.State?.Status && ['exited', 'dead'].includes(info.State.Status)) {
      return { running: false, status: info.State.Status, info };
    }
    await new Promise(r => setTimeout(r, 800));
  }
  const info = await container.inspect().catch(() => null);
  return { running: Boolean(info?.State?.Running), status: info?.State?.Status || 'unknown', info };
}

// 内部 API：Telethon 服务调用的告警推送接口（不需要认证）
app.post('/api/internal/alert/push', async (req, res) => {
  try {
    const { keyword, message, from, channel, channelId, messageId, userId } = req.body;
    
    // ✅ 验证必要字段
    if (!keyword || !message) {
      return res.status(400).json({ error: '缺少必要字段：keyword 和 message' });
    }
    
    // ✅ 限制消息长度
    if (message.length > 5000) {
      return res.status(400).json({ error: '消息过长（最大 5000 字符）' });
    }
    
    // ✅ 清理输入
    const cleanKeyword = String(keyword).trim().substring(0, 500);
    const cleanMessage = String(message).trim();
    const cleanFrom = String(from || 'Unknown').trim().substring(0, 200);
    const cleanChannel = String(channel || 'Unknown').trim().substring(0, 200);
    
    // 获取userId（从请求或从日志查询）
    let userIdObj = null;
    if (userId) {
      try {
        userIdObj = new mongoose.Types.ObjectId(userId);
      } catch (e) {
        console.error('无效的userId:', userId);
      }
    }
    
    // 注意：日志已经由Telethon服务保存，这里不再重复保存
    // 前端推送也由Telethon通过notify_new_message_async处理，这里不再重复推送
    
    // 告警去重检查：防止同一消息重复发送告警
    if (userIdObj && channelId && messageId) {
      const dedupeKey = `${userIdObj.toString()}_${channelId}_${messageId}`;
      const lastSentTime = alertDedupeCache.get(dedupeKey);
      if (lastSentTime && (Date.now() - lastSentTime) < ALERT_DEDUPE_TTL) {
        console.log(`⚠️ [告警处理] 告警已发送过，跳过重复发送 - key: ${dedupeKey}`);
        return res.json({ status: 'ok', message: '告警已推送（已去重）' });
      }
      // 记录本次发送时间
      alertDedupeCache.set(dedupeKey, Date.now());
    }
    
    // 加载用户配置发送告警
    if (userIdObj) {
      try {
        const userConfig = await loadUserConfig(userIdObj.toString());
        const config = userConfig.toObject ? userConfig.toObject() : userConfig;
        const actions = config.alert_actions || {};
        
        console.log(`🔍 [告警处理] 加载配置 - userId: ${userIdObj.toString()}`);
        console.log(`🔍 [告警处理] alert_target: ${config.alert_target || '未设置'}`);
        console.log(`🔍 [告警处理] alert_actions:`, JSON.stringify(actions, null, 2));
        
        // 构建告警消息
        const alertMessage = `⚠️ 关键词告警触发

来源：${cleanChannel} (${channelId})
发送者：${cleanFrom}
关键词：${cleanKeyword}
时间：${new Date().toLocaleString('zh-CN')}

消息内容：
${cleanMessage}

${messageId ? `👉 跳转链接：t.me/c/${channelId}/${messageId}` : ''}`;
        
        // Telegram 推送（通过Telethon服务发送）
        // 检查 alert_actions.telegram 是否为 true（布尔值或对象）
        const telegramEnabled = actions?.telegram === true || (typeof actions?.telegram === 'object' && actions.telegram?.enable !== false);
        console.log(`📋 [告警处理] Telegram检查 - userId: ${userIdObj.toString()}, telegramEnabled: ${telegramEnabled}, alert_target: ${config.alert_target || '未设置'}`);
        
        if (telegramEnabled && config.alert_target) {
          try {
            console.log(`📱 [告警处理] 准备发送Telegram告警到: ${config.alert_target}`);
            // 调用Telethon服务的HTTP接口发送消息
            // 使用触发告警的用户的容器来发送消息（userId 是字符串格式）
            const triggerUserId = userIdObj.toString();
            console.log(`🔍 [告警处理] 触发告警的用户ID: ${triggerUserId}`);
            const telethonUrl = await getTelethonServiceUrl(triggerUserId);
            console.log(`🔗 [告警处理] 使用 Telethon 服务 URL: ${telethonUrl} (userId: ${triggerUserId})`);
            console.log(`📤 [告警处理] 发送请求到: ${telethonUrl}/api/internal/telegram/send`);
            console.log(`📤 [告警处理] 请求参数: target=${config.alert_target}, message长度=${alertMessage.length}`);
            
            const response = await axios.post(`${telethonUrl}/api/internal/telegram/send`, {
              target: config.alert_target,
              message: alertMessage,
              userId: triggerUserId  // 传递 userId 以便 Telethon 服务记录日志
            }, {
              timeout: 10000,
              headers: {
                'Content-Type': 'application/json',
                ...(INTERNAL_API_TOKEN ? { 'X-Internal-Token': INTERNAL_API_TOKEN } : {})
              }
            });
            console.log(`✅ [告警处理] Telegram 告警已发送到: ${config.alert_target}, 响应:`, response.data);
          } catch (error) {
            console.error('❌ [告警处理] Telegram 发送失败:', error.message);
            console.error(`❌ [告警处理] 错误代码: ${error.code || 'N/A'}`);
            if (error.response) {
              console.error('❌ [告警处理] 响应状态:', error.response.status, '响应数据:', error.response.data);
            }
            if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
              console.error(`❌ [告警处理] 无法连接到Telethon服务: ${telethonUrl}`);
              console.error(`❌ [告警处理] 请检查容器 ${triggerUserId ? `tg_listener_${triggerUserId}` : 'telethon'} 是否正在运行`);
            }
            if (error.code === 'ETIMEDOUT') {
              console.error(`❌ [告警处理] 连接超时: ${telethonUrl}`);
            }
          }
        } else {
          if (!telegramEnabled) {
            console.log(`⚠️ [告警处理] Telegram告警未启用 - alert_actions.telegram: ${JSON.stringify(actions?.telegram)}`);
          }
          if (!config.alert_target) {
            console.log('⚠️ [告警处理] Telegram告警目标未设置 (alert_target: 空)');
          }
        }
      
        // 邮件推送
        if (actions.email && actions.email.enable) {
          try {
            await sendEmail(actions.email, '⚠️ Telegram 监控告警', alertMessage);
            console.log('📧 [告警处理] 邮件告警已发送');
          } catch (error) {
            console.error('❌ [告警处理] 邮件发送失败:', error.message);
          }
        }
        
        // Webhook 推送
        if (actions.webhook && actions.webhook.enable && actions.webhook.url) {
          try {
            await axios.post(actions.webhook.url, {
              type: 'telegram_alert',
              keyword,
              message,
              from,
              channel,
              channelId,
              messageId,
              timestamp: new Date().toISOString()
            });
            console.log('🔗 [告警处理] Webhook 告警已发送');
          } catch (error) {
            console.error('❌ [告警处理] Webhook 发送失败:', error.message);
          }
        }
      } catch (configError) {
        console.error('❌ [告警处理] 加载用户配置失败:', configError.message);
        console.error('错误堆栈:', configError.stack);
      }
    }
    
    res.json({ status: 'ok', message: '告警已推送' });
  } catch (error) {
    console.error('❌ 内部告警推送失败:', error);
    res.status(500).json({ error: '推送告警失败：' + error.message });
  }
});

// 🚨 推送告警（受保护的API，需要认证）
app.post('/api/alert/push', authMiddleware, async (req, res) => {
  try {
    const { keyword, message, from, channel, channelId, messageId } = req.body;
    
    // ✅ 验证必要字段
    if (!keyword || !message) {
      return res.status(400).json({ error: '缺少必要字段：keyword 和 message' });
    }
    
    // ✅ 限制消息长度
    if (message.length > 5000) {
      return res.status(400).json({ error: '消息过长（最大 5000 字符）' });
    }
    
    // ✅ 清理输入
    const cleanKeyword = String(keyword).trim().substring(0, 500);
    const cleanMessage = String(message).trim();
    const cleanFrom = String(from || 'Unknown').trim().substring(0, 200);
    const cleanChannel = String(channel || 'Unknown').trim().substring(0, 200);
    
    // 保存日志到数据库
    const userId = req.user.userId;
    const userIdObj = new mongoose.Types.ObjectId(userId);
    
    const log = new Log({
      userId: userIdObj,
      channel: cleanChannel,
      channelId: channelId || '',
      sender: cleanFrom,
      message: cleanMessage,
      keywords: [cleanKeyword],
      messageId,
      alerted: true
    });
    await log.save();
    
    // 实时推送新消息事件给前端（只推送给该用户）
    broadcastEvent('new_message', {
      id: log._id,
      userId: userId,
      channel: cleanChannel,
      channelId: channelId || '',
      sender: cleanFrom,
      message: cleanMessage,
      keywords: [cleanKeyword],
      time: log.time,
      alerted: true
    }, userId);
    
    // 推送统计更新事件（只推送给该用户）
    broadcastEvent('stats_updated', { userId: userId }, userId);
    
    const userConfig = await loadUserConfig(userId);
    const config = userConfig.toObject ? userConfig.toObject() : userConfig;
    const actions = config.alert_actions;
    
    // 构建告警消息
    const alertMessage = `⚠️ 关键词告警触发

来源：${cleanChannel} (${channelId})
发送者：${cleanFrom}
关键词：${cleanKeyword}
时间：${new Date().toLocaleString('zh-CN')}

消息内容：
${cleanMessage}

${messageId ? `👉 跳转链接：t.me/c/${channelId}/${messageId}` : ''}`;
    
    // Telegram 推送（通过Telethon服务发送）
    // 检查 alert_actions.telegram 是否为 true（布尔值或对象）
    const telegramEnabled = actions?.telegram === true || (typeof actions?.telegram === 'object' && actions.telegram?.enable !== false);
    if (telegramEnabled && config.alert_target) {
      try {
        console.log(`📱 准备发送Telegram告警到: ${config.alert_target}`);
        // 调用Telethon服务的HTTP接口发送消息
        // 使用触发告警的用户的容器来发送消息
        const telethonUrl = await getTelethonServiceUrl(userIdObj.toString());
        console.log(`🔗 [告警处理] 使用 Telethon 服务 URL: ${telethonUrl} (userId: ${userIdObj.toString()})`);
        await axios.post(`${telethonUrl}/api/internal/telegram/send`, {
          target: config.alert_target,
          message: alertMessage,
          userId: userIdObj.toString()  // 传递 userId 以便 Telethon 服务记录日志
        }, {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json',
            ...(INTERNAL_API_TOKEN ? { 'X-Internal-Token': INTERNAL_API_TOKEN } : {})
          }
        });
        console.log('✅ Telegram 告警已发送到:', config.alert_target);
      } catch (error) {
        console.error('❌ Telegram 发送失败:', error.message);
        if (error.response) {
          console.error('响应状态:', error.response.status, '响应数据:', error.response.data);
        }
      }
    } else {
      if (!telegramEnabled) {
        console.log('⚠️ Telegram告警未启用 (alert_actions.telegram:', actions?.telegram, ')');
      }
      if (!config.alert_target) {
        console.log('⚠️ Telegram告警目标未设置 (alert_target: 空)');
      }
    }
    
    // 邮件推送
    if (actions.email && actions.email.enable) {
      try {
        await sendEmail(actions.email, '⚠️ Telegram 监控告警', alertMessage);
        console.log('邮件告警已发送');
      } catch (error) {
        console.error('邮件发送失败:', error.message);
      }
    }
    
    // Webhook 推送
    if (actions.webhook && actions.webhook.enable && actions.webhook.url) {
      try {
        await axios.post(actions.webhook.url, {
          type: 'telegram_alert',
          keyword,
          message,
          from,
          channel,
          channelId,
          messageId,
          timestamp: new Date().toISOString()
        });
        console.log('Webhook 告警已发送');
      } catch (error) {
        console.error('Webhook 发送失败:', error.message);
      }
    }
    
    res.json({ status: 'ok', message: '告警已推送' });
  } catch (error) {
    res.status(500).json({ error: '推送告警失败：' + error.message });
  }
});

// 测试告警（受保护）：使用当前配置发送一条测试邮件/Webhook
app.post('/api/alert/test', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const userConfig = await loadUserConfig(userId);
    const config = userConfig.toObject ? userConfig.toObject() : userConfig;
    const actions = config.alert_actions || {};

    const keyword = 'TEST_ALERT';
    const message = 'This is a test alert from tg monitor.';
    const from = req.user?.username || 'tester';
    const channel = 'test-channel';
    const channelId = 'test-channel-id';
    const messageId = Date.now();

    const alertMessage = `⚠️ 测试告警

来源：${channel} (${channelId})
发送者：${from}
关键词：${keyword}
时间：${new Date().toLocaleString('zh-CN')}

消息内容：
${message}`;

    const result = { telegram: null, email: null, webhook: null };

    // Telegram 测试（通过Telethon服务发送）
    const telegramEnabled = actions?.telegram === true || (typeof actions?.telegram === 'object' && actions.telegram?.enable !== false);
    if (telegramEnabled && config.alert_target) {
      try {
        console.log(`📱 [测试告警] 准备发送Telegram测试告警到: ${config.alert_target}`);
        const userIdObj = new mongoose.Types.ObjectId(userId);
        const telethonUrl = await getTelethonServiceUrl(userIdObj.toString());
        console.log(`🔗 [测试告警] 使用 Telethon 服务 URL: ${telethonUrl} (userId: ${userIdObj.toString()})`);
        await axios.post(`${telethonUrl}/api/internal/telegram/send`, {
          target: config.alert_target,
          message: alertMessage,
          userId: userIdObj.toString()
        }, {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json',
            ...(INTERNAL_API_TOKEN ? { 'X-Internal-Token': INTERNAL_API_TOKEN } : {})
          }
        });
        console.log('✅ [测试告警] Telegram 测试告警已发送到:', config.alert_target);
        result.telegram = 'sent';
      } catch (error) {
        console.error('❌ [测试告警] Telegram 发送失败:', error.message);
        if (error.response) {
          console.error('响应状态:', error.response.status, '响应数据:', error.response.data);
        }
        result.telegram = `error: ${error.message}`;
      }
    } else {
      if (!telegramEnabled) {
        console.log('⚠️ [测试告警] Telegram告警未启用 (alert_actions.telegram:', actions?.telegram, ')');
        result.telegram = 'disabled (telegram not enabled)';
      } else if (!config.alert_target) {
        console.log('⚠️ [测试告警] Telegram告警目标未设置 (alert_target: 空)');
        result.telegram = 'disabled (alert_target not set)';
      } else {
        result.telegram = 'disabled';
      }
    }

    // 邮件测试
    if (actions.email && actions.email.enable) {
      try {
        await sendEmail(actions.email, '⚠️ Telegram 监控测试告警', alertMessage);
        result.email = 'sent';
      } catch (e) {
        result.email = `error: ${e.message}`;
      }
    } else {
      result.email = 'disabled';
    }

    // Webhook 测试
    if (actions.webhook && actions.webhook.enable && actions.webhook.url) {
      try {
        await axios.post(actions.webhook.url, {
          type: 'telegram_alert_test',
          keyword,
          message,
          from,
          channel,
          channelId,
          messageId,
          timestamp: new Date().toISOString()
        });
        result.webhook = 'sent';
      } catch (e) {
        result.webhook = `error: ${e.message}`;
      }
    } else {
      result.webhook = 'disabled';
    }

    res.json({ status: 'ok', result });
  } catch (error) {
    res.status(500).json({ error: '测试告警失败：' + error.message });
  }
});

// 发送邮件函数
async function sendEmail(emailConfig, subject, text) {
  const transporter = nodemailer.createTransport({
    host: emailConfig.smtp_host,
    port: emailConfig.smtp_port,
    secure: emailConfig.smtp_port === 465,
    auth: {
      user: emailConfig.username,
      pass: emailConfig.password
    }
  });
  
  await transporter.sendMail({
    from: emailConfig.username,
    to: emailConfig.to,
    subject,
    text
  });
}

// ===== AI 分析 API =====

// 获取 AI 分析结果列表
app.get('/api/ai/summary', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 10;
    const sentiment = req.query.sentiment || '';
    const riskLevel = req.query.riskLevel || '';
    
    // 获取主账号ID（用于查询可能使用account_id的数据）
    const accountId = await getAccountId(userId);
    const userIdObj = new mongoose.Types.ObjectId(userId);
    const accountIdObj = new mongoose.Types.ObjectId(accountId);
    
    // 构建查询条件：查询该用户的所有分析结果（包括使用userId和account_id的）
    // admin用户可以查看旧数据（没有userId的）
    const isAdmin = username === 'admin';
    const baseQuery = isAdmin 
      ? { 
          $or: [
            { userId: userIdObj },
            { account_id: accountIdObj },
            { userId: { $exists: false } }, 
            { userId: null }
          ] 
        }
      : { 
          $or: [
            { userId: userIdObj },
            { account_id: accountIdObj }
          ] 
        };
    
    // 添加筛选条件
    const query = { ...baseQuery };
    if (sentiment) {
      query['analysis_result.sentiment'] = sentiment;
    }
    if (riskLevel) {
      query['analysis_result.risk_level'] = riskLevel;
    }
    
    const total = await AISummary.countDocuments(query);
    const summaries = await AISummary.find(query)
      .sort({ analysis_time: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize);
    
    // 为每个分析结果添加频道统计信息
    const summariesWithStats = summaries.map(summary => {
      const channels = {};
      const senders = {};
      
      summary.messages_analyzed.forEach(msg => {
        channels[msg.channel] = (channels[msg.channel] || 0) + 1;
        senders[msg.sender] = (senders[msg.sender] || 0) + 1;
      });
      
      return {
        ...summary.toObject(),
        channel_stats: Object.entries(channels).map(([name, count]) => ({ name, count })),
        sender_stats: Object.entries(senders).map(([name, count]) => ({ name, count })),
        messages_preview: summary.messages_analyzed.slice(0, 3) // 只返回前3条消息预览
      };
    });
    
    res.json({
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      summaries: summariesWithStats
    });
  } catch (error) {
    res.status(500).json({ error: '获取 AI 分析结果失败：' + error.message });
  }
});

// 获取单个 AI 分析详情
app.get('/api/ai/summary/:id', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const summary = await AISummary.findOne({ 
      _id: req.params.id,
      userId: new mongoose.Types.ObjectId(userId)
    });
    
    if (!summary) {
      return res.status(404).json({ error: '分析结果不存在' });
    }
    
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: '获取分析详情失败：' + error.message });
  }
});

// 清除 AI 分析结果
app.delete('/api/ai/summary/clear', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    const userIdObj = new mongoose.Types.ObjectId(userId);
    const isAdmin = username === 'admin';
    
    console.log(`🗑️ [清除分析结果] 开始清除用户 ${userId} (${username}) 的AI分析结果`);
    
    // 获取主账号ID（用于查询可能使用account_id的数据）
    const accountId = await getAccountId(userId);
    const accountIdObj = new mongoose.Types.ObjectId(accountId);
    
    // 构建删除查询条件
    // admin用户可以清除旧的没有userId的记录
    const deleteQuery = isAdmin
      ? {
          $or: [
            { userId: userIdObj },
            { account_id: accountIdObj },
            { userId: { $exists: false } }, // 旧的没有userId的记录
            { userId: null } // 旧的userId为null的记录
          ]
        }
      : {
          $or: [
            { userId: userIdObj },
            { account_id: accountIdObj }
          ]
        };
    
    // 先查询该用户的所有AI分析结果ID（包括使用userId和account_id的，以及旧的没有userId的）
    const summaries = await AISummary.find(deleteQuery).select('_id');
    const summaryIds = summaries.map(s => s._id);
    
    console.log(`🗑️ [清除分析结果] 找到 ${summaryIds.length} 条AI分析结果${isAdmin ? '（包括旧记录）' : ''}`);
    
    // 删除该用户的所有AI分析结果（包括使用userId和account_id的，以及旧的没有userId的）
    const deleteResult = await AISummary.deleteMany(deleteQuery);
    console.log(`🗑️ [清除分析结果] 已删除 ${deleteResult.deletedCount} 条AI分析结果`);
    
    // 重置所有相关的消息标记
    // 1. 重置所有ai_analyzed=true的消息
    // 2. 重置所有ai_summary_id不为null的消息（包括指向已删除分析结果的消息）
    // 3. 重置所有ai_summary_id在summaryIds列表中的消息
    // 4. 设置 ai_cleared_at 时间戳，防止清除后立即被自动分析重新分析
    // admin用户还需要清除旧的没有userId的Log记录
    const clearTimestamp = new Date();
    const logUpdateQuery = isAdmin
      ? {
          $or: [
            { userId: userIdObj, ai_analyzed: true },
            { userId: userIdObj, ai_summary_id: { $ne: null } },
            { account_id: accountIdObj, ai_analyzed: true },
            { account_id: accountIdObj, ai_summary_id: { $ne: null } },
            // 旧的没有userId的Log记录，且ai_summary_id指向已删除的分析结果
            { userId: { $exists: false }, ai_summary_id: { $in: summaryIds } },
            { userId: null, ai_summary_id: { $in: summaryIds } }
          ]
        }
      : {
          $or: [
            { userId: userIdObj, ai_analyzed: true },
            { userId: userIdObj, ai_summary_id: { $ne: null } },
            { account_id: accountIdObj, ai_analyzed: true },
            { account_id: accountIdObj, ai_summary_id: { $ne: null } }
          ]
        };
    
    const updateResult = await Log.updateMany(
      logUpdateQuery,
      { $set: { ai_analyzed: false, ai_summary_id: null, ai_cleared_at: clearTimestamp } }
    );
    
    console.log(`🗑️ [清除分析结果] 已重置 ${updateResult.modifiedCount} 条已分析消息的标记`);
    
    // 再次检查并清理所有指向已删除分析结果的孤立消息标记
    // 这些消息的ai_summary_id指向的分析结果已经不存在了
    const orphanedLogQuery = isAdmin
      ? {
          $or: [
            { userId: userIdObj, ai_summary_id: { $ne: null } },
            { account_id: accountIdObj, ai_summary_id: { $ne: null } },
            // 旧的没有userId的Log记录，且ai_summary_id不为null
            { userId: { $exists: false }, ai_summary_id: { $ne: null } },
            { userId: null, ai_summary_id: { $ne: null } }
          ]
        }
      : {
          $or: [
            { userId: userIdObj, ai_summary_id: { $ne: null } },
            { account_id: accountIdObj, ai_summary_id: { $ne: null } }
          ]
        };
    
    const orphanedUpdateResult = await Log.updateMany(
      orphanedLogQuery,
      { $set: { ai_analyzed: false, ai_summary_id: null, ai_cleared_at: clearTimestamp } }
    );
    
    if (orphanedUpdateResult.modifiedCount > 0) {
      console.log(`🗑️ [清除分析结果] 额外清理了 ${orphanedUpdateResult.modifiedCount} 条孤立消息标记`);
    }
    
    const totalResetLogs = updateResult.modifiedCount + orphanedUpdateResult.modifiedCount;
    console.log(`✅ [清除分析结果] 用户 ${userId} 清除完成 - 删除分析结果: ${deleteResult.deletedCount}, 重置消息标记: ${totalResetLogs}`);
    
    // 清除统计缓存
    statsCache.delete(userId);
    
    // 验证清除结果（使用与删除相同的查询条件）
    const remainingSummaries = await AISummary.countDocuments(deleteQuery);
    const stillAnalyzedLogsQuery = isAdmin
      ? {
          $or: [
            { userId: userIdObj, ai_analyzed: true },
            { account_id: accountIdObj, ai_analyzed: true },
            { userId: { $exists: false }, ai_analyzed: true },
            { userId: null, ai_analyzed: true }
          ]
        }
      : {
          $or: [
            { userId: userIdObj, ai_analyzed: true },
            { account_id: accountIdObj, ai_analyzed: true }
          ]
        };
    const stillAnalyzedLogs = await Log.countDocuments(stillAnalyzedLogsQuery);
    const stillHasSummaryId = await Log.countDocuments(orphanedLogQuery);
    
    if (remainingSummaries > 0 || stillAnalyzedLogs > 0 || stillHasSummaryId > 0) {
      console.warn(`⚠️  [清除分析结果] 警告：仍有残留数据 - 分析结果: ${remainingSummaries}, 已分析消息: ${stillAnalyzedLogs}, 仍有summary_id的消息: ${stillHasSummaryId}`);
    }
    
    res.json({ 
      status: 'ok', 
      message: '清除成功',
      deletedSummaries: deleteResult.deletedCount,
      resetLogs: totalResetLogs,
      remainingSummaries: remainingSummaries,
      stillAnalyzedLogs: stillAnalyzedLogs,
      stillHasSummaryId: stillHasSummaryId
    });
  } catch (error) {
    console.error('❌ 清除AI分析结果失败:', error);
    console.error('错误堆栈:', error.stack);
    res.status(500).json({ error: '清除失败：' + error.message });
  }
});

// 手动触发 AI 分析
app.post('/api/ai/analyze-now', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const result = await performAIAnalysis('manual', null, userId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: '触发 AI 分析失败：' + error.message });
  }
});

// ===== 数据备份与恢复 API =====

// 辅助函数：检测项目根目录（与备份功能使用相同的逻辑）
function detectProjectRoot() {
    // 检查容器内路径
    const containerAppDir = '/app';
    const containerConfigPath = path.join(containerAppDir, 'config.json');
    
    // 如果 /app/config.json 存在，说明在容器内，使用 /app 作为工作目录
    if (fs.existsSync(containerConfigPath)) {
    return containerAppDir;
  }
  
      // 尝试其他路径
      const possibleRootPaths = [
        path.resolve(__dirname, '..'),  // 相对于 server.js 的上级目录
        '/opt/telegram-monitor',        // 常见部署路径
        process.cwd()                   // 当前工作目录
      ];
      
      for (const rootPath of possibleRootPaths) {
        const configPath1 = path.join(rootPath, 'backend', 'config.json');
        const configPath2 = path.join(rootPath, 'config.json');
        
        if (fs.existsSync(configPath1) || fs.existsSync(configPath2)) {
      return rootPath;
        }
      }
      
      // 如果都没找到，使用默认路径
  return path.resolve(__dirname, '..');
}

// 辅助函数：递归复制目录（跨平台，不使用 shell 命令）
function copyDirectorySync(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error(`源目录不存在: ${src}`);
  }
  
  // 创建目标目录
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  
  // 读取源目录内容
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      // 递归复制子目录
      copyDirectorySync(srcPath, destPath);
    } else {
      // 复制文件
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 创建数据备份
app.post('/api/backup', authMiddleware, async (req, res) => {
  try {
    const username = req.user.username;
    
    // 只有admin用户可以执行备份
    if (username !== 'admin') {
      return res.status(403).json({ error: '权限不足：仅管理员可执行备份操作' });
    }
    
    console.log('📦 [备份] 开始创建数据备份...');
    
    // 确定项目根目录（使用统一的检测函数）
    const scriptDir = detectProjectRoot();
    console.log(`📁 [备份] 使用项目根目录: ${scriptDir}`);
    
    const backupDir = path.join(scriptDir, 'backups');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '_');
    const backupName = `backup_${timestamp}`;
    const backupPath = path.join(backupDir, backupName);
    
    console.log(`📁 [备份] 备份目录: ${backupDir}`);
    console.log(`📁 [备份] 备份路径: ${backupPath}`);
    
    // 创建备份目录
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
      console.log(`✅ [备份] 已创建备份目录: ${backupDir}`);
    }
    
    // 创建备份子目录
    fs.mkdirSync(backupPath, { recursive: true });
    
    // 备份配置文件（尝试多个可能的路径）
    const possibleConfigPaths = [
      path.join(scriptDir, 'config.json'),            // 容器内: /app/config.json 或 宿主机: 项目根/config.json
      path.join(scriptDir, 'backend', 'config.json'), // 宿主机: 项目根/backend/config.json
      path.join(__dirname, 'config.json'),            // 相对于 server.js
      '/app/config.json'                               // 容器内绝对路径
    ];
    
    let configBacked = false;
    for (const configPath of possibleConfigPaths) {
      if (fs.existsSync(configPath)) {
        fs.copyFileSync(configPath, path.join(backupPath, 'config.json'));
        console.log(`✅ [备份] 已备份配置文件: ${configPath}`);
        configBacked = true;
        break;
      }
    }
    
    if (!configBacked) {
      console.warn(`⚠️  [备份] 配置文件不存在，尝试过的路径: ${possibleConfigPaths.join(', ')}`);
    }
    
    // 备份多开登录的独立配置文件（config_*.json）
    try {
      const backendDir = path.join(scriptDir, 'backend');
      if (fs.existsSync(backendDir)) {
        const files = fs.readdirSync(backendDir);
        const multiLoginConfigFiles = files.filter(f => f.startsWith('config_') && f.endsWith('.json'));
        if (multiLoginConfigFiles.length > 0) {
          const multiLoginConfigDir = path.join(backupPath, 'multi_login_configs');
          fs.mkdirSync(multiLoginConfigDir, { recursive: true });
          for (const configFile of multiLoginConfigFiles) {
            const sourcePath = path.join(backendDir, configFile);
            const destPath = path.join(multiLoginConfigDir, configFile);
            fs.copyFileSync(sourcePath, destPath);
            console.log(`✅ [备份] 已备份多开登录配置文件: ${configFile}`);
          }
        }
      }
    } catch (multiLoginConfigError) {
      console.warn(`⚠️  [备份] 备份多开登录配置文件失败: ${multiLoginConfigError.message}`);
    }
    
    // 备份 .env 文件（尝试多个可能的路径）
    const possibleEnvPaths = [
      path.join(scriptDir, '.env'),
      '/app/.env',
      path.join(__dirname, '..', '.env')
    ];
    
    let envBacked = false;
    for (const envPath of possibleEnvPaths) {
      if (fs.existsSync(envPath)) {
        fs.copyFileSync(envPath, path.join(backupPath, '.env'));
        console.log(`✅ [备份] 已备份环境变量: ${envPath}`);
        envBacked = true;
        break;
      }
    }
    
    // 备份 MongoDB 数据（使用多种方法，确保数据完整性）
    const mongoBackupPath = path.join(backupPath, 'mongo_dump');
    let mongoBacked = false;
    
    try {
      console.log('📊 [备份] 开始备份 MongoDB 数据...');
      
      const mongoContainerName = 'tg_mongo';
      const mongoDbName = 'tglogs';
      
      // 方法1：使用 Docker API (dockerode) 在容器内执行 mongodump
      try {
        const Docker = require('dockerode');
        const docker = new Docker({ socketPath: '/var/run/docker.sock' });
        const container = docker.getContainer(mongoContainerName);
        
        // 在容器内执行 mongodump
        const exec = await container.exec({
          Cmd: ['mongodump', '--db', mongoDbName, '--out', '/tmp/mongo_backup'],
          AttachStdout: true,
          AttachStderr: true
        });
        
        const stream = await exec.start({ hijack: true, stdin: false });
        await new Promise((resolve, reject) => {
          let output = '';
          stream.on('data', (chunk) => {
            output += chunk.toString();
          });
          stream.on('end', () => {
            resolve(output);
          });
          stream.on('error', reject);
          
          setTimeout(() => {
            stream.destroy();
            reject(new Error('mongodump 执行超时'));
          }, 300000);
        });
        
        // 从容器复制备份文件到宿主机
        const containerBackupPath = `/tmp/mongo_backup/${mongoDbName}`;
        const tarStream = await container.getArchive({ path: containerBackupPath });
        
        // 保存 tar 流到临时文件，然后解压
        const tempTarPath = path.join(backupPath, 'mongo_backup_temp.tar');
        const writeStream = fs.createWriteStream(tempTarPath);
        
        await new Promise((resolve, reject) => {
          tarStream.pipe(writeStream);
          writeStream.on('finish', resolve);
          writeStream.on('error', reject);
          tarStream.on('error', reject);
        });
        
        // 解压 tar 文件（如果 tar 命令可用）
        try {
          fs.mkdirSync(mongoBackupPath, { recursive: true });
          await execAsync(`tar -xf "${tempTarPath}" -C "${mongoBackupPath}" --strip-components=1`, {
            timeout: 300000
          });
          fs.unlinkSync(tempTarPath);
        } catch (tarError) {
          console.warn(`⚠️  [备份] tar 解压失败，尝试使用 Node.js 方法: ${tarError.message}`);
          // 如果 tar 命令不可用，保留 tar 文件，恢复时再处理
        }
        
        // 清理容器内的临时文件
        try {
          const cleanupExec = await container.exec({
            Cmd: ['rm', '-rf', '/tmp/mongo_backup'],
            AttachStdout: true,
            AttachStderr: true
          });
          await cleanupExec.start({ hijack: true, stdin: false });
        } catch (cleanupError) {
          // 忽略清理错误
        }
        
        console.log(`✅ [备份] 已使用 Docker API mongodump 备份 MongoDB 数据: ${mongoBackupPath}`);
        mongoBacked = true;
      } catch (dockerApiError) {
        console.warn(`⚠️  [备份] Docker API mongodump 失败: ${dockerApiError.message}`);
        throw dockerApiError;
      }
    } catch (mongoError) {
      console.warn(`⚠️  [备份] MongoDB 备份失败，尝试文件系统备份: ${mongoError.message}`);
      
      // 回退方案：备份数据目录（文件系统备份）
      // 注意：在容器内，data/mongo 可能没有挂载，需要从宿主机路径查找
    const possibleDataPaths = [
        path.join(scriptDir, 'data'),     // 项目根目录下的 data（宿主机路径）
      '/opt/telegram-monitor/data',     // 常见部署路径
      path.join(__dirname, '..', 'data') // 相对于 server.js
    ];
    
    for (const dataPath of possibleDataPaths) {
      if (fs.existsSync(dataPath)) {
          const mongoDataPath = path.join(dataPath, 'mongo');
          if (fs.existsSync(mongoDataPath)) {
            const dataFiles = fs.readdirSync(mongoDataPath);
        if (dataFiles.length > 0) {
          const backupDataPath = path.join(backupPath, 'data');
          fs.mkdirSync(backupDataPath, { recursive: true });
          
              // 只备份 mongo 子目录
              const backupMongoPath = path.join(backupDataPath, 'mongo');
              copyDirectorySync(mongoDataPath, backupMongoPath);
              
              console.log(`✅ [备份] 已备份 MongoDB 数据目录（文件系统）: ${mongoDataPath}`);
              mongoBacked = true;
              break;
            }
          }
        }
      }
      
      if (!mongoBacked) {
        console.warn(`⚠️  [备份] MongoDB 数据备份失败，尝试过的路径: ${possibleDataPaths.join(', ')}`);
        console.warn(`⚠️  [备份] 注意：MongoDB 数据可能未备份，恢复时可能无法恢复用户配置！`);
      }
    }
    
    // 不再备份 session 目录（包含登录凭证），避免在备份中存储敏感/临时文件
    console.log('ℹ️  [备份] 已跳过 session 目录（不再备份 Telegram 登录凭证）');
    
    // 额外导出用户配置快照（JSON格式，方便查看）
    try {
      console.log('📋 [备份] 导出用户配置快照...');
      const mongoose = require('mongoose');
      const UserConfig = require('./userConfigModel');
      const User = require('./userModel');
      
      // 确保MongoDB连接
      if (mongoose.connection.readyState === 1) {
        const userConfigs = await UserConfig.find({}).lean();
        const users = await User.find({}).select('-password_hash').lean();
        
        const configSnapshot = {
          backup_time: new Date().toISOString(),
          users: users.map(u => ({
            _id: u._id.toString(),
            username: u.username,
            is_active: u.is_active,
            parent_account_id: u.parent_account_id ? u.parent_account_id.toString() : null
          })),
          user_configs: userConfigs.map(uc => ({
            userId: uc.userId.toString(),
            keywords: uc.keywords || [],
            channels: uc.channels || [],
            alert_keywords: uc.alert_keywords || [],
            alert_regex: uc.alert_regex || [],
            alert_target: uc.alert_target || '',
            log_all_messages: uc.log_all_messages !== undefined ? uc.log_all_messages : true,
            telegram: {
              api_id: uc.telegram?.api_id || 0,
              api_hash: uc.telegram?.api_hash ? '***已隐藏***' : ''
            },
            alert_actions: {
              telegram: uc.alert_actions?.telegram !== false,
              email: {
                enable: uc.alert_actions?.email?.enable || false,
                smtp_host: uc.alert_actions?.email?.smtp_host || '',
                smtp_port: uc.alert_actions?.email?.smtp_port || 465,
                username: uc.alert_actions?.email?.username || '',
                to: uc.alert_actions?.email?.to || '',
                password: uc.alert_actions?.email?.password ? '***已隐藏***' : ''
              },
              webhook: {
                enable: uc.alert_actions?.webhook?.enable || false,
                url: uc.alert_actions?.webhook?.url || ''
              }
            },
            ai_analysis: {
              enabled: uc.ai_analysis?.enabled || false,
              openai_api_key: uc.ai_analysis?.openai_api_key ? '***已隐藏***' : '',
              openai_model: uc.ai_analysis?.openai_model || 'gpt-3.5-turbo',
              openai_base_url: uc.ai_analysis?.openai_base_url || 'https://api.openai.com/v1',
              analysis_trigger_type: uc.ai_analysis?.analysis_trigger_type || 'time',
              time_interval_minutes: uc.ai_analysis?.time_interval_minutes || 30,
              message_count_threshold: uc.ai_analysis?.message_count_threshold || 50,
              max_messages_per_analysis: uc.ai_analysis?.max_messages_per_analysis || 500,
              analysis_prompt: uc.ai_analysis?.analysis_prompt || '',
              ai_send_telegram: uc.ai_analysis?.ai_send_telegram !== false,
              ai_send_email: uc.ai_analysis?.ai_send_email || false,
              ai_send_webhook: uc.ai_analysis?.ai_send_webhook || false,
              ai_trigger_enabled: uc.ai_analysis?.ai_trigger_enabled || false,
              ai_trigger_users: uc.ai_analysis?.ai_trigger_users || [],
              ai_trigger_prompt: uc.ai_analysis?.ai_trigger_prompt || ''
            },
            multi_login_enabled: uc.multi_login_enabled || false
          }))
        };
        
        const snapshotPath = path.join(backupPath, 'user_configs_snapshot.json');
        fs.writeFileSync(snapshotPath, JSON.stringify(configSnapshot, null, 2));
        console.log(`✅ [备份] 已导出用户配置快照: ${snapshotPath}`);
      } else {
        console.warn('⚠️  [备份] MongoDB 未连接，跳过用户配置快照导出');
      }
    } catch (snapshotError) {
      console.warn(`⚠️  [备份] 导出用户配置快照失败: ${snapshotError.message}`);
    }
    
    // 创建备份信息文件
    const backupInfoPath = path.join(backupPath, 'backup_info.txt');
    const backupInfo = `备份时间: ${new Date().toLocaleString('zh-CN')}
备份路径: ${backupPath}
备份内容:
- 配置文件 (backend/config.json) - 注意：这只是默认模板，实际配置在MongoDB中
- 多开登录独立配置文件 (multi_login_configs/config_*.json) - 多开登录模式下每个用户的独立配置
- 环境变量 (.env)
- MongoDB 数据库 (使用 ${mongoBacked ? 'mongodump (推荐)' : '文件系统备份'})
  * 包含所有用户配置（keywords, channels, alert_keywords, ai_analysis, multi_login_enabled等）
  * 包含所有用户账号信息
  * 包含所有消息日志
  * 包含所有AI分析结果
- 用户配置快照 (user_configs_snapshot.json) - JSON格式，方便查看
- Session 文件 (Telegram 登录凭证)
  * 单开模式：telegram*.session
  * 多开模式：user_*.session

重要提示：
- 用户的实际配置存储在MongoDB的userconfigs集合中，不在config.json中
- config.json只是默认模板文件
- 恢复时使用mongorestore恢复MongoDB数据即可恢复所有用户配置
`;
    fs.writeFileSync(backupInfoPath, backupInfo);
    
    // 压缩备份（使用系统 tar 命令）
    try {
      const tarPath = `${backupPath}.tar.gz`;
      await execAsync(`tar -czf "${tarPath}" -C "${backupDir}" "${backupName}"`, {
        timeout: 300000
      });
      
      // 删除未压缩的目录
      if (fs.existsSync(backupPath)) {
        fs.rmSync(backupPath, { recursive: true, force: true });
      }
      console.log(`✅ [备份] 备份已压缩: ${tarPath}`);
    } catch (tarError) {
      console.warn('⚠️  [备份] 压缩失败，保留未压缩目录:', tarError.message);
      // 如果压缩失败，至少备份目录已经创建
    }
    
    // 清理旧备份（保留最近10个）
    console.log('🧹 [备份] 清理旧备份（保留最近10个）...');
    const allBackups = [];
    if (fs.existsSync(backupDir)) {
      const files = fs.readdirSync(backupDir);
      for (const file of files) {
        // 支持备份目录和 .tar.gz 压缩文件
        if (file.startsWith('backup_') && (file.endsWith('.tar.gz') || !file.includes('.'))) {
          const filePath = path.join(backupDir, file);
          const stats = fs.statSync(filePath);
          allBackups.push({ name: file, path: filePath, created: stats.birthtime });
        }
      }
      // 按创建时间排序（最新的在前）
      allBackups.sort((a, b) => b.created - a.created);
      // 删除超过10个的旧备份
      for (let i = 10; i < allBackups.length; i++) {
        fs.rmSync(allBackups[i].path, { recursive: true, force: true });
        console.log(`🗑️  [备份] 已删除旧备份: ${allBackups[i].name}`);
      }
    }
    
    console.log('✅ [备份] 备份完成');
    
    // 获取备份文件列表
    const backups = [];
    
    if (fs.existsSync(backupDir)) {
      // 查找所有备份文件
      const files = fs.readdirSync(backupDir);
      for (const file of files) {
        // 支持备份目录和 .tar.gz 压缩文件
        if (file.startsWith('backup_') && (file.endsWith('.tar.gz') || !file.includes('.'))) {
          const filePath = path.join(backupDir, file);
          const stats = fs.statSync(filePath);
          
          // 如果是目录，计算目录总大小
          let totalSize = stats.size;
          if (stats.isDirectory()) {
            const calculateDirSize = (dirPath) => {
              let size = 0;
              try {
                const entries = fs.readdirSync(dirPath);
                for (const entry of entries) {
                  const entryPath = path.join(dirPath, entry);
                  const entryStats = fs.statSync(entryPath);
                  if (entryStats.isDirectory()) {
                    size += calculateDirSize(entryPath);
                  } else {
                    size += entryStats.size;
                  }
                }
              } catch (err) {
                console.warn(`⚠️  [备份] 无法读取目录 ${dirPath}:`, err.message);
              }
              return size;
            };
            totalSize = calculateDirSize(filePath);
          }
          
          backups.push({
            name: file,
            size: totalSize,
            created: stats.birthtime,
            path: filePath
          });
        }
      }
      
      // 按创建时间排序（最新的在前）
      backups.sort((a, b) => b.created - a.created);
    }
    
    res.json({
      status: 'ok',
      message: '备份创建成功',
      backups: backups.slice(0, 10) // 只返回最近10个备份
    });
  } catch (error) {
    console.error('❌ [备份] 备份失败:', error);
    res.status(500).json({ error: '备份失败：' + error.message });
  }
});

// 获取备份列表
app.get('/api/backup/list', authMiddleware, async (req, res) => {
  try {
    const username = req.user.username;
    
    // 只有admin用户可以查看备份列表
    if (username !== 'admin') {
      return res.status(403).json({ error: '权限不足：仅管理员可查看备份列表' });
    }
    
    // 使用统一的路径检测函数
    const scriptDir = detectProjectRoot();
    
    const backupDir = path.join(scriptDir, 'backups');
    console.log(`📁 [备份列表] 使用备份目录: ${backupDir}`);
    
    const backups = [];
    
    if (fs.existsSync(backupDir)) {
      const files = fs.readdirSync(backupDir);
      console.log(`📁 [备份列表] 备份目录中的文件: ${files.join(', ')}`);
      for (const file of files) {
        // 支持备份目录和 .tar.gz 压缩文件
        if (file.startsWith('backup_') && (file.endsWith('.tar.gz') || !file.includes('.'))) {
          const filePath = path.join(backupDir, file);
          const stats = fs.statSync(filePath);
          console.log(`✅ [备份列表] 找到备份文件: ${file} (${stats.size} 字节)`);
          
          // 如果是目录，计算目录总大小
          let totalSize = stats.size;
          if (stats.isDirectory()) {
            const calculateDirSize = (dirPath) => {
              let size = 0;
              try {
                const entries = fs.readdirSync(dirPath);
                for (const entry of entries) {
                  const entryPath = path.join(dirPath, entry);
                  const entryStats = fs.statSync(entryPath);
                  if (entryStats.isDirectory()) {
                    size += calculateDirSize(entryPath);
                  } else {
                    size += entryStats.size;
                  }
                }
              } catch (err) {
                console.warn(`⚠️  [备份列表] 无法读取目录 ${dirPath}:`, err.message);
              }
              return size;
            };
            totalSize = calculateDirSize(filePath);
          }
          
          backups.push({
            name: file,
            size: totalSize,
            created: stats.birthtime,
            path: filePath
          });
        }
      }
      
      // 按创建时间排序（最新的在前）
      backups.sort((a, b) => b.created - a.created);
    } else {
      console.warn(`⚠️  [备份列表] 备份目录不存在: ${backupDir}`);
    }
    
    console.log(`📊 [备份列表] 返回 ${backups.length} 个备份文件`);
    
    res.json({
      status: 'ok',
      backups: backups
    });
  } catch (error) {
    console.error('❌ [备份] 获取备份列表失败:', error);
    res.status(500).json({ error: '获取备份列表失败：' + error.message });
  }
});

// 恢复数据备份
app.post('/api/backup/restore', authMiddleware, async (req, res) => {
  try {
    const username = req.user.username;
    const { backupName } = req.body;
    
    // 只有admin用户可以执行恢复
    if (username !== 'admin') {
      return res.status(403).json({ error: '权限不足：仅管理员可执行恢复操作' });
    }
    
    if (!backupName) {
      return res.status(400).json({ error: '请指定要恢复的备份文件名' });
    }
    
    console.log(`📥 [恢复] 开始恢复备份: ${backupName}`);
    
    // 确定项目根目录（使用统一的检测函数）
    const scriptDir = detectProjectRoot();
    console.log(`📁 [恢复] 使用项目根目录: ${scriptDir}`);
    
    const backupDir = path.join(scriptDir, 'backups');
    const backupPath = path.join(backupDir, backupName);
    
    // 检查备份文件是否存在
    if (!fs.existsSync(backupPath)) {
      console.error(`❌ [恢复] 备份文件不存在: ${backupPath}`);
      return res.status(404).json({ error: `备份文件不存在: ${backupName}` });
    }
    
    const isTarGz = backupName.endsWith('.tar.gz');
    const tempDir = isTarGz ? path.join(scriptDir, 'temp_restore') : null;
    
    try {
      let extractedDir = null;
      
      // 如果是压缩文件，先解压
      if (isTarGz) {
        console.log(`📂 [恢复] 解压备份文件: ${backupName}`);
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        
        try {
        await execAsync(`tar -xzf "${backupPath}" -C "${tempDir}"`, {
          cwd: scriptDir,
          timeout: 300000
        });
          extractedDir = path.join(tempDir, backupName.replace('.tar.gz', ''));
          
          if (!fs.existsSync(extractedDir)) {
            throw new Error(`解压后未找到目录: ${extractedDir}`);
          }
          console.log(`✅ [恢复] 解压完成: ${extractedDir}`);
        } catch (tarError) {
          // 在 Windows 上 tar 命令可能不可用，尝试使用 Node.js 解压
          console.warn(`⚠️  [恢复] tar 命令失败，尝试使用 Node.js 解压: ${tarError.message}`);
          // 这里可以添加使用 Node.js 解压 tar.gz 的逻辑，但为了简化，先报错
          throw new Error(`解压失败: ${tarError.message}。如果是在 Windows 上，请确保已安装 tar 工具或使用 WSL。`);
        }
      } else {
        // 如果是目录，直接使用
        extractedDir = backupPath;
      }
      
      // 恢复配置文件（尝试多个可能的路径）
        const configSource = path.join(extractedDir, 'config.json');
      const possibleConfigDests = [
        path.join(scriptDir, 'backend', 'config.json'),  // 宿主机路径
        path.join(scriptDir, 'config.json'),              // 容器内路径
        path.join(__dirname, 'config.json')               // 相对于 server.js
      ];
      
      let configRestored = false;
        if (fs.existsSync(configSource)) {
        for (const configDest of possibleConfigDests) {
          try {
            // 确保目标目录存在
            const destDir = path.dirname(configDest);
            if (!fs.existsSync(destDir)) {
              fs.mkdirSync(destDir, { recursive: true });
            }
          fs.copyFileSync(configSource, configDest);
            console.log(`✅ [恢复] 已恢复配置文件: ${configDest}`);
            configRestored = true;
            break;
          } catch (copyError) {
            console.warn(`⚠️  [恢复] 无法复制到 ${configDest}: ${copyError.message}`);
          }
        }
        if (!configRestored) {
          console.warn(`⚠️  [恢复] 配置文件恢复失败，尝试过的路径: ${possibleConfigDests.join(', ')}`);
        }
      } else {
        console.warn(`⚠️  [恢复] 备份中未找到配置文件: ${configSource}`);
      }
      
      // 恢复.env文件（尝试多个可能的路径）
        const envSource = path.join(extractedDir, '.env');
      const possibleEnvDests = [
        path.join(scriptDir, '.env'),
        path.join(__dirname, '..', '.env')
      ];
      
      let envRestored = false;
        if (fs.existsSync(envSource)) {
        for (const envDest of possibleEnvDests) {
          try {
          fs.copyFileSync(envSource, envDest);
            console.log(`✅ [恢复] 已恢复环境变量文件: ${envDest}`);
            envRestored = true;
            break;
          } catch (copyError) {
            console.warn(`⚠️  [恢复] 无法复制到 ${envDest}: ${copyError.message}`);
          }
        }
        if (!envRestored) {
          console.warn(`⚠️  [恢复] 环境变量文件恢复失败，尝试过的路径: ${possibleEnvDests.join(', ')}`);
        }
      } else {
        console.warn(`⚠️  [恢复] 备份中未找到环境变量文件: ${envSource}`);
      }
      
      // 恢复多开登录的独立配置文件（config_*.json）
      const multiLoginConfigSource = path.join(extractedDir, 'multi_login_configs');
      if (fs.existsSync(multiLoginConfigSource)) {
        try {
          const backendDir = path.join(scriptDir, 'backend');
          if (fs.existsSync(backendDir)) {
            const configFiles = fs.readdirSync(multiLoginConfigSource);
            for (const configFile of configFiles) {
              if (configFile.startsWith('config_') && configFile.endsWith('.json')) {
                const sourcePath = path.join(multiLoginConfigSource, configFile);
                const destPath = path.join(backendDir, configFile);
                fs.copyFileSync(sourcePath, destPath);
                console.log(`✅ [恢复] 已恢复多开登录配置文件: ${configFile}`);
              }
            }
          }
        } catch (multiLoginConfigError) {
          console.warn(`⚠️  [恢复] 恢复多开登录配置文件失败: ${multiLoginConfigError.message}`);
        }
      }
      
      // 配置项恢复完成，立即返回成功响应
      // MongoDB 和 session 恢复将在后台异步执行
      console.log('✅ [恢复] 配置项恢复完成，立即返回成功响应');
      res.json({
        status: 'ok',
        message: '数据恢复成功'
      });
      
      // 在后台异步执行 MongoDB 和 session 恢复（不阻塞响应）
      (async () => {
        try {
          // 恢复 MongoDB 数据（优先使用 mongorestore）
          const mongoDumpSource = path.join(extractedDir, 'mongo_dump');
          const mongoDataSource = path.join(extractedDir, 'data', 'mongo');
          const mongoContainerName = 'tg_mongo';
          const mongoDbName = 'tglogs';
          
          let mongoRestored = false;
          
          // 方法1：如果存在 mongodump 备份，使用 mongorestore
          if (fs.existsSync(mongoDumpSource)) {
            console.log('📊 [恢复] 检测到 mongodump 备份，使用 mongorestore 恢复...');
            
            try {
              // 查找备份的数据库目录
              // mongodump 可能有两种格式：
              // 1. mongo_dump/tglogs/ (包含数据库名称子目录)
              // 2. mongo_dump/ (直接包含集合文件 .bson)
              let dbBackupPath = null;
              console.log(`🔍 [恢复] 查找数据库备份目录...`);
              
              // 首先检查 mongo_dump 目录是否直接包含 .bson 文件（格式2）
              const mongoDumpFiles = fs.readdirSync(mongoDumpSource);
              const hasBsonFiles = mongoDumpFiles.some(f => f.endsWith('.bson') || f.endsWith('.metadata.json'));
              
              if (hasBsonFiles) {
                // 格式2：集合文件直接在 mongo_dump 目录下
                console.log(`✅ [恢复] 检测到备份格式：集合文件直接在 mongo_dump 目录下`);
                dbBackupPath = mongoDumpSource;
                console.log(`✅ [恢复] 使用备份路径: ${dbBackupPath}`);
              } else {
                // 格式1：查找数据库名称子目录
                dbBackupPath = path.join(mongoDumpSource, mongoDbName);
                console.log(`🔍 [恢复] 查找数据库备份目录: ${dbBackupPath}`);
                
                if (!fs.existsSync(dbBackupPath)) {
                  // 可能备份在子目录中
                  console.log(`🔍 [恢复] 标准路径不存在，查找子目录...`);
                  console.log(`🔍 [恢复] 找到子目录: ${mongoDumpFiles.join(', ')}`);
                  
                  if (mongoDumpFiles.length > 0) {
                    // 查找包含数据库备份的目录
                    for (const subDir of mongoDumpFiles) {
                      const subDirPath = path.join(mongoDumpSource, subDir);
                      const subDirStat = fs.statSync(subDirPath);
                      
                      if (subDirStat.isDirectory()) {
                        // 检查是否是数据库名称目录
                        if (subDir === mongoDbName) {
                          console.log(`✅ [恢复] 找到数据库备份目录: ${subDirPath}`);
                          dbBackupPath = subDirPath;
                          break;
                        }
                        
                        // 检查是否包含集合文件
                        const collections = fs.readdirSync(subDirPath);
                        if (collections.some(c => c.endsWith('.bson') || c.endsWith('.metadata.json'))) {
                          console.log(`✅ [恢复] 找到数据库备份（子目录包含集合）: ${subDirPath}`);
                          dbBackupPath = subDirPath;
                          break;
                        }
                      }
                    }
                  }
                } else {
                  console.log(`✅ [恢复] 找到数据库备份: ${dbBackupPath}`);
                }
              }
              
              if (fs.existsSync(dbBackupPath)) {
                // 使用 Docker API (dockerode) 在容器内执行 mongorestore
                try {
              const Docker = require('dockerode');
              const docker = new Docker({ socketPath: '/var/run/docker.sock' });
              const container = docker.getContainer(mongoContainerName);
              
              console.log(`📦 [恢复] 使用 Docker API 复制备份到容器...`);
              
              // 创建容器内的临时目录
              const execCreate = await container.exec({
                Cmd: ['mkdir', '-p', '/tmp/mongo_restore'],
                AttachStdout: true,
                AttachStderr: true
              });
              const createStream = await execCreate.start({ hijack: true, stdin: false });
              await new Promise((resolve, reject) => {
                createStream.on('end', resolve);
                createStream.on('error', reject);
                createStream.resume(); // 消费流
              });
              
              // 创建 tar 文件
              // 如果 dbBackupPath 就是 mongoDumpSource，说明集合文件直接在 mongo_dump 目录下
              // 需要打包整个目录；否则只打包数据库子目录
              const tempTarPath = path.join(extractedDir, 'mongo_restore_temp.tar');
              let tarDir, tarName, containerBackupPath;
              
              if (dbBackupPath === mongoDumpSource) {
                // 格式2：集合文件直接在 mongo_dump 目录下
                tarDir = path.dirname(mongoDumpSource);
                tarName = path.basename(mongoDumpSource);
                containerBackupPath = `/tmp/mongo_restore/${tarName}`;
                console.log(`📦 [恢复] 备份格式：集合文件直接在目录下，容器路径: ${containerBackupPath}`);
              } else {
                // 格式1：数据库子目录
                tarDir = path.dirname(dbBackupPath);
                tarName = path.basename(dbBackupPath);
                containerBackupPath = `/tmp/mongo_restore/${tarName}`;
                console.log(`📦 [恢复] 备份格式：数据库子目录，容器路径: ${containerBackupPath}`);
              }
              
              console.log(`📦 [恢复] 创建 tar 文件: ${tempTarPath} (从 ${tarDir}/${tarName})`);
              
              try {
                await execAsync(`tar -cf "${tempTarPath}" -C "${tarDir}" "${tarName}"`, {
                  timeout: 300000
                });
              } catch (tarError) {
                console.warn(`⚠️  [恢复] tar 命令失败，尝试使用 Node.js 创建 tar: ${tarError.message}`);
                // 如果 tar 命令不可用，使用 Node.js 的 archiver 或直接复制
                // 由于 dockerode 的 putArchive 需要 tar 格式，我们尝试使用其他方法
                throw new Error(`无法创建 tar 文件，请确保系统已安装 tar 命令`);
              }
              
              // 使用 Docker API 上传 tar 文件到容器
              console.log(`📦 [恢复] 上传 tar 文件到容器...`);
              const tarStream = fs.createReadStream(tempTarPath);
              await container.putArchive(tarStream, {
                path: '/tmp/mongo_restore'
              });
              
              // 删除临时 tar 文件
              try {
                fs.unlinkSync(tempTarPath);
              } catch (unlinkError) {
                console.warn(`⚠️  [恢复] 删除临时 tar 文件失败: ${unlinkError.message}`);
              }
              
              console.log(`📦 [恢复] 备份文件已复制到容器，开始执行 mongorestore...`);
              
              // 在容器内执行 mongorestore
              // 如果备份路径就是 mongo_dump 目录，mongorestore 会自动检测数据库名称
              // 但我们需要指定目标数据库名称
              // 优化：使用并行恢复以加快速度
              const restoreExec = await container.exec({
                Cmd: ['mongorestore', '--db', mongoDbName, '--drop', '--numParallelCollections', '4', containerBackupPath],
                AttachStdout: true,
                AttachStderr: true
              });
              
              const restoreStream = await restoreExec.start({ hijack: true, stdin: false });
              let restoreOutput = '';
              
              await new Promise((resolve, reject) => {
                restoreStream.on('data', (chunk) => {
                  restoreOutput += chunk.toString();
                });
                restoreStream.on('end', () => {
                  if (restoreOutput) {
                    console.log(`📊 [恢复] mongorestore 输出: ${restoreOutput.substring(0, 1000)}`);
                  }
                  resolve();
                });
                restoreStream.on('error', reject);
                
                setTimeout(() => {
                  restoreStream.destroy();
                  reject(new Error('mongorestore 执行超时'));
                }, 300000);
              });
              
              // 清理容器内的临时文件
              try {
                const cleanupExec = await container.exec({
                  Cmd: ['rm', '-rf', '/tmp/mongo_restore'],
                  AttachStdout: true,
                  AttachStderr: true
                });
                await cleanupExec.start({ hijack: true, stdin: false });
              } catch (cleanupError) {
                // 忽略清理错误
              }
              
              console.log(`✅ [恢复] 已使用 Docker API mongorestore 恢复 MongoDB 数据`);
              mongoRestored = true;
            } catch (dockerApiError) {
              console.error(`❌ [恢复] Docker API mongorestore 失败: ${dockerApiError.message}`);
              console.error(`❌ [恢复] 错误堆栈: ${dockerApiError.stack}`);
              console.log('📊 [恢复] 尝试使用 shell 命令...');
              
              // 方法2：尝试使用 shell 命令（如果 Docker CLI 可用）
              try {
                // 先复制备份文件到容器
                const containerBackupPath = `/tmp/mongo_restore/${mongoDbName}`;
                await execAsync(`docker cp "${dbBackupPath}" ${mongoContainerName}:${containerBackupPath}`, {
                  timeout: 300000
                });
                
                // 在容器内执行 mongorestore
                // 优化：使用并行恢复以加快速度
                await execAsync(`docker exec ${mongoContainerName} mongorestore --db ${mongoDbName} --drop --numParallelCollections 4 "${containerBackupPath}"`, {
                  timeout: 300000
                });
                
                // 清理容器内的临时文件
                await execAsync(`docker exec ${mongoContainerName} rm -rf /tmp/mongo_restore`, {
                  timeout: 60000
                }).catch(() => {});
                
                console.log(`✅ [恢复] 已使用 shell 命令 mongorestore 恢复 MongoDB 数据`);
                mongoRestored = true;
              } catch (dockerShellError) {
                console.error(`❌ [恢复] Shell 命令 mongorestore 失败: ${dockerShellError.message}`);
                console.log('📊 [恢复] 尝试使用本地 mongorestore...');
                
                // 方法3：使用本地 mongorestore（如果已安装）
                try {
                  // 优化：使用并行恢复以加快速度
                  await execAsync(`mongorestore --host mongo:27017 --db ${mongoDbName} --drop --numParallelCollections 4 "${dbBackupPath}"`, {
                    timeout: 300000
                  });
                  console.log(`✅ [恢复] 已使用本地 mongorestore 恢复 MongoDB 数据`);
                  mongoRestored = true;
                } catch (localError) {
                  console.error(`❌ [恢复] 本地 mongorestore 失败: ${localError.message}`);
                  throw new Error(`所有 mongorestore 方法都失败: ${localError.message}`);
                }
              }
            }
          } else {
            console.error(`❌ [恢复] 未找到数据库备份目录: ${dbBackupPath}`);
            console.error(`❌ [恢复] mongo_dump 目录内容: ${fs.readdirSync(mongoDumpSource).join(', ')}`);
          }
        } catch (mongoError) {
          console.error(`❌ [恢复] MongoDB 恢复失败: ${mongoError.message}`);
          console.error(`❌ [恢复] 错误堆栈: ${mongoError.stack}`);
        }
      }
      
          // 方法2：如果 mongodump 恢复失败或不存在，使用文件系统恢复
          if (!mongoRestored && fs.existsSync(mongoDataSource)) {
            console.log('📊 [恢复] 使用文件系统恢复 MongoDB 数据...');
            
            const possibleDataDests = [
              path.join(scriptDir, 'data', 'mongo'),
              '/app/data/mongo',  // 容器内路径
              path.join(__dirname, '..', 'data', 'mongo')
            ];
            
            for (const dataDest of possibleDataDests) {
              try {
          // 备份现有数据
          if (fs.existsSync(dataDest)) {
            const backupDataPath = `${dataDest}.backup.${Date.now()}`;
            fs.renameSync(dataDest, backupDataPath);
            console.log(`✅ [恢复] 已备份现有数据到: ${backupDataPath}`);
          }
                
                // 使用 Node.js API 复制目录（跨平台）
                copyDirectorySync(mongoDataSource, dataDest);
                console.log(`✅ [恢复] 已恢复 MongoDB 数据目录: ${dataDest}`);
                mongoRestored = true;
                break;
              } catch (copyError) {
                console.warn(`⚠️  [恢复] 无法复制数据目录到 ${dataDest}: ${copyError.message}`);
              }
            }
          }
          
          if (!mongoRestored) {
            console.warn(`⚠️  [恢复] MongoDB 数据恢复失败`);
          }
          
          // Session 登录凭证不再随备份恢复，防止覆盖现有登录状态
          console.log('ℹ️  [恢复] 已跳过 session 目录恢复（不再从备份还原 Telegram 登录凭证）');
          
          // 清理临时目录
          if (tempDir && fs.existsSync(tempDir)) {
            try {
              fs.rmSync(tempDir, { recursive: true, force: true });
              console.log(`✅ [恢复] 已清理临时目录: ${tempDir}`);
            } catch (cleanError) {
              console.warn(`⚠️  [恢复] 清理临时目录失败: ${cleanError.message}`);
            }
          }
          
          // 验证恢复结果
          console.log('🔍 [恢复] 验证恢复结果...');
          const verifyResults = {
            config: false,
            env: false,
            multiLoginConfigs: false,
            mongo: false
          };
          
          // 验证配置文件
          const configPath = path.join(scriptDir, 'backend', 'config.json');
          if (fs.existsSync(configPath)) {
            verifyResults.config = true;
            console.log('✅ [恢复] 配置文件已恢复');
          } else {
            console.warn('❌ [恢复] 配置文件恢复失败');
          }
          
          // 验证 .env 文件
          const envPath = path.join(scriptDir, '.env');
          if (fs.existsSync(envPath)) {
            verifyResults.env = true;
            console.log('✅ [恢复] 环境变量文件已恢复');
          } else {
            console.warn('⚠️  [恢复] 环境变量文件未恢复（可能备份中不存在）');
          }
          
          // 验证多开登录配置文件
          const multiLoginConfigDir = path.join(extractedDir, 'multi_login_configs');
          if (fs.existsSync(multiLoginConfigDir)) {
            const backendDir = path.join(scriptDir, 'backend');
            const restoredConfigs = fs.readdirSync(backendDir).filter(f => f.startsWith('config_') && f.endsWith('.json'));
            const backupConfigs = fs.readdirSync(multiLoginConfigDir).filter(f => f.startsWith('config_') && f.endsWith('.json'));
            if (restoredConfigs.length >= backupConfigs.length) {
              verifyResults.multiLoginConfigs = true;
              console.log(`✅ [恢复] 多开登录配置文件已恢复（${restoredConfigs.length} 个）`);
            } else {
              console.warn(`⚠️  [恢复] 多开登录配置文件恢复不完整（恢复: ${restoredConfigs.length}, 备份: ${backupConfigs.length}）`);
            }
          }
          
          // 验证 MongoDB 数据
          if (mongoRestored) {
            verifyResults.mongo = true;
            console.log('✅ [恢复] MongoDB 数据库已恢复');
          } else {
            console.warn('⚠️  [恢复] MongoDB 数据未恢复');
          }
          
          // Session 登录凭证不再随备份恢复
          console.log('ℹ️  [恢复] Session 登录凭证未参与恢复（刻意跳过）');
          
          // 输出验证总结
          const allVerified = Object.values(verifyResults).every(v => v || !fs.existsSync(extractedDir)); // 如果备份中不存在某些文件，不算失败
          if (allVerified) {
            console.log('✅ [恢复] 所有关键数据恢复验证通过');
          } else {
            console.warn('⚠️  [恢复] 部分数据恢复验证未通过，请检查上述信息');
          }
          
          console.log('✅ [恢复] 后台数据恢复完成');
          
          // 恢复后检查多开登录状态，如果启用则重新创建独立容器
          try {
            console.log('🔍 [恢复] 检查多开登录状态...');
            const mongoose = require('mongoose');
            const UserConfig = require('./userConfigModel');
            const User = require('./userModel');
            
            if (mongoose.connection.readyState === 1) {
              // 查找所有启用了多开登录的主账号
              const allUserConfigs = await UserConfig.find({}).lean();
              const allUsers = await User.find({}).select('_id username parent_account_id').lean();
              
              // 按主账号分组
              const accountConfigs = new Map();
              for (const userConfig of allUserConfigs) {
                const userId = userConfig.userId.toString();
                const user = allUsers.find(u => u._id.toString() === userId);
                if (user) {
                  // 获取主账号ID
                  const accountId = user.parent_account_id ? user.parent_account_id.toString() : userId;
                  if (!accountConfigs.has(accountId)) {
                    accountConfigs.set(accountId, {
                      accountId,
                      multiLoginEnabled: false,
                      userIds: []
                    });
                  }
                  const accountConfig = accountConfigs.get(accountId);
                  accountConfig.userIds.push(userId);
                  // 如果主账号启用了多开登录，记录
                  if (userId === accountId && userConfig.multi_login_enabled) {
                    accountConfig.multiLoginEnabled = true;
                  }
                }
              }
              
              // 为启用了多开登录的账号重新创建独立容器
              for (const [accountId, accountInfo] of accountConfigs.entries()) {
                if (accountInfo.multiLoginEnabled) {
                  console.log(`🔄 [恢复] 检测到账号 ${accountId} 启用了多开登录，重新创建独立容器...`);
                  for (const userId of accountInfo.userIds) {
                    try {
                      await syncUserConfigAndStartMultiLoginContainer(userId);
                      console.log(`✅ [恢复] 已为用户 ${userId} 创建多开登录容器`);
                    } catch (containerError) {
                      console.warn(`⚠️  [恢复] 为用户 ${userId} 创建多开登录容器失败: ${containerError.message}`);
                    }
                  }
                }
              }
            } else {
              console.warn('⚠️  [恢复] MongoDB 未连接，跳过多开登录容器重建');
            }
          } catch (multiLoginCheckError) {
            console.warn(`⚠️  [恢复] 检查多开登录状态失败: ${multiLoginCheckError.message}`);
          }
        } catch (backgroundError) {
          console.error('❌ [恢复] 后台数据恢复失败:', backgroundError);
          console.error('❌ [恢复] 错误堆栈:', backgroundError.stack);
        }
      })();
    } catch (restoreError) {
      // 清理临时目录
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      throw restoreError;
    }
  } catch (error) {
    console.error('❌ [恢复] 恢复失败:', error);
    res.status(500).json({ error: '恢复失败：' + error.message });
  }
});

// 删除备份
app.delete('/api/backup/:backupName', authMiddleware, async (req, res) => {
  try {
    const username = req.user.username;
    const { backupName } = req.params;
    
    // 只有admin用户可以删除备份
    if (username !== 'admin') {
      return res.status(403).json({ error: '权限不足：仅管理员可删除备份' });
    }
    
    if (!backupName) {
      return res.status(400).json({ error: '请指定要删除的备份文件名' });
    }
    
    console.log(`🗑️  [删除备份] 开始删除备份: ${backupName}`);
    
    // 使用统一的路径检测函数
    const scriptDir = detectProjectRoot();
    
    const backupDir = path.join(scriptDir, 'backups');
    const backupPath = path.join(backupDir, backupName);
    
    console.log(`📁 [删除备份] 使用备份目录: ${backupDir}`);
    console.log(`📁 [删除备份] 备份文件路径: ${backupPath}`);
    
    // 检查备份文件是否存在
    if (!fs.existsSync(backupPath)) {
      console.warn(`⚠️  [删除备份] 备份文件不存在: ${backupPath}`);
      return res.status(404).json({ error: '备份文件不存在' });
    }
    
    // 删除备份文件或目录
    try {
      fs.rmSync(backupPath, { recursive: true, force: true });
      console.log(`✅ [删除备份] 已删除备份: ${backupName}`);
      
      res.json({
        status: 'ok',
        message: '备份删除成功'
      });
    } catch (deleteError) {
      console.error('❌ [删除备份] 删除失败:', deleteError);
      res.status(500).json({ error: '删除失败：' + deleteError.message });
    }
  } catch (error) {
    console.error('❌ [删除备份] 删除备份失败:', error);
    res.status(500).json({ error: '删除备份失败：' + error.message });
  }
});

// 内部 API：Telethon 服务调用的消息通知接口（不需要认证）
// 用于在 Telethon 直接保存消息到 MongoDB 后，通知前端有新消息
app.post('/api/internal/message-notify', async (req, res) => {
  try {
    const body = req.body;
    const items = Array.isArray(body)
      ? body
      : (body && Array.isArray(body.batch) ? body.batch : [body]);

    // 兼容旧 Telethon：单条且缺 userId 时，允许通过 log_id 回查（批量不做回查，避免 DB 负载）
    if (items.length === 1) {
      const it = items[0] || {};
      if (!it.userId && it.log_id) {
        try {
          const log = await Log.findById(it.log_id).select('userId').lean();
          if (log && log.userId) {
            it.userId = log.userId.toString();
          }
        } catch {
          // ignore
        }
      }
      items[0] = it;
    }

    const incrementsByUser = new Map();
    const touchedUsers = new Set();

    for (const it of items) {
      if (!it) continue;
      const log_id = it.log_id;
      const userId = it.userId ? String(it.userId) : null;

      // 安全保护：没有 userId 绝不能 broadcast 给所有 SSE 连接（否则会数据泄漏/串号）
      if (userId) {
        broadcastEvent('new_message', {
          id: log_id,
          userId: userId,
          channel: it.channel || 'Unknown',
          channelId: it.channelId || '',
          sender: it.sender || 'Unknown',
          message: it.message || '',
          keywords: it.keywords || [],
          time: it.time || new Date().toISOString(),
          alerted: it.alerted || false
        }, userId);

        broadcastEvent('stats_updated', { userId: userId }, userId);

        incrementsByUser.set(userId, (incrementsByUser.get(userId) || 0) + 1);
        touchedUsers.add(userId);
      }
    }

    // 事件驱动计数触发：按 userId 聚合增量，一次性加 N
    for (const [userId, inc] of incrementsByUser.entries()) {
      enqueueCountTriggerIncrement(userId, inc);
    }

    // 清除统计缓存：只清除被触及用户，避免清全局
    for (const userId of touchedUsers) {
      statsCache.delete(userId);
    }

    res.json({ status: 'ok', message: '消息通知已推送', batch: items.length });
  } catch (error) {
    console.error('❌ 消息通知推送失败:', error.message);
    res.status(500).json({ error: '推送消息通知失败：' + error.message });
  }
});

// ===== Telegram 登录 API =====

// ===== Telegram 登录辅助函数 =====

// 安全的输入验证函数
function validateInput(input, type = 'string') {
  if (input === null || input === undefined) return null;
  
  const str = String(input).trim();
  
  // 移除所有可能的命令注入字符
  const dangerousChars = /[;&|`$(){}[\]<>'"]/g;
  if (dangerousChars.test(str)) {
    throw new Error('输入包含非法字符');
  }
  
  if (type === 'number') {
    const num = parseInt(str, 10);
    if (isNaN(num) || num <= 0) {
      throw new Error('无效的数字');
    }
    return num;
  }
  
  if (type === 'phone') {
    // 移除所有空格
    const phoneNoSpaces = str.replace(/\s+/g, '');
    // 验证手机号格式（只允许数字和+号）
    if (!/^\+?[1-9]\d{1,14}$/.test(phoneNoSpaces)) {
      throw new Error('无效的手机号格式');
    }
    return phoneNoSpaces;
  }
  
  if (type === 'code') {
    // 验证码只能是数字
    if (!/^\d{1,10}$/.test(str)) {
      throw new Error('验证码只能是数字');
    }
    return str;
  }
  
  return str;
}

// 等待容器就绪（运行中且不在重启状态）
async function waitForContainerReady(container, maxWaitSeconds = 30) {
  const startTime = Date.now();
  const waitInterval = 1000; // 每秒检查一次
  
  while (Date.now() - startTime < maxWaitSeconds * 1000) {
    try {
      const info = await container.inspect();
      const state = info.State;
      
      if (state.Running && !state.Restarting) {
        // 容器正在运行且不在重启状态
        return true;
      }
      
      if (state.Restarting) {
        // 容器正在重启，等待
        console.log(`⏳ 容器 ${info.Name} 正在重启，等待就绪... (已等待 ${Math.floor((Date.now() - startTime) / 1000)} 秒)`);
        await new Promise(resolve => setTimeout(resolve, waitInterval));
        continue;
      }
      
      if (!state.Running) {
        // 容器未运行
        return Promise.reject(new Error(
          `容器 ${info.Name} 未运行。状态: ${state.Status}。请检查容器日志: docker logs ${info.Name}`
        ));
      }
    } catch (e) {
      // 检查失败，继续等待
      await new Promise(resolve => setTimeout(resolve, waitInterval));
      continue;
    }
  }
  
  return Promise.reject(new Error(
    `容器未在 ${maxWaitSeconds} 秒内就绪。请检查容器状态: docker ps -a`
  ));
}

// 清理临时登录容器
async function cleanupTempLoginContainer(userId) {
  const containerInfo = tempLoginContainers.get(userId);
  if (!containerInfo) {
    return; // 没有临时容器
  }
  
  try {
    const Docker = require('dockerode');
    const dockerSocketPaths = [
      '/var/run/docker.sock',
      process.env.DOCKER_HOST?.replace('unix://', '') || null
    ].filter(Boolean);
    
    let docker = null;
    for (const socketPath of dockerSocketPaths) {
      if (fs.existsSync(socketPath)) {
        try {
          docker = new Docker({ socketPath });
          await docker.ping();
          break;
        } catch (e) {
          docker = null;
        }
      }
    }
    
    if (!docker) {
      console.warn('⚠️  无法连接到 Docker daemon，跳过容器清理');
      tempLoginContainers.delete(userId);
      return;
    }
    
    try {
      const container = docker.getContainer(containerInfo.containerName);
      const containerInfo_check = await container.inspect();
      
      // 停止并删除容器
      if (containerInfo_check.State.Running) {
        await container.stop({ t: 5 });
      }
      await container.remove({ force: true });
      console.log(`✅ 已清理临时登录容器: ${containerInfo.containerName}`);
    } catch (err) {
      if (err.statusCode !== 404) {
        console.warn(`⚠️  清理容器 ${containerInfo.containerName} 失败:`, err.message);
      }
      // 容器可能已经不存在了，忽略404错误
    }
    
    tempLoginContainers.delete(userId);
  } catch (error) {
    console.error('清理临时容器时出错:', error);
    tempLoginContainers.delete(userId); // 即使出错也删除记录
  }
}

// 创建或获取临时登录容器
async function getOrCreateTempLoginContainer(userId, configHostPath, sessionHostPath, containerImage, networkName) {
  const Docker = require('dockerode');
  const dockerSocketPaths = [
    '/var/run/docker.sock',
    process.env.DOCKER_HOST?.replace('unix://', '') || null
  ].filter(Boolean);
  
  let docker = null;
  for (const socketPath of dockerSocketPaths) {
    if (fs.existsSync(socketPath)) {
      try {
        docker = new Docker({ socketPath });
        await docker.ping();
        break;
      } catch (e) {
        docker = null;
      }
    }
  }
  
  if (!docker) {
    throw new Error('无法连接到 Docker daemon');
  }
  
  // 使用目录挂载方式，统一路径
  // 如果参数中传入了 sessionHostPath，使用参数值；否则使用默认路径
  const PROJECT_ROOT = process.env.PROJECT_ROOT || '/opt/telegram-monitor';
  const actualSessionHostPath = sessionHostPath || path.join(PROJECT_ROOT, 'data', 'session');
  const sessionContainerPath = '/opt/telegram-monitor/data/session';
  
  // 确保 session 目录存在
  if (!fs.existsSync(actualSessionHostPath)) {
    fs.mkdirSync(actualSessionHostPath, { recursive: true });
    console.log(`✅ [临时容器] 已创建 session 目录: ${actualSessionHostPath}`);
  }
  
  const containerName = `tg_login_${userId}_${Date.now()}`;
  
  console.log(`🔨 [临时容器] 创建临时登录容器: ${containerName}`);
  console.log(`🔨 [临时容器] 使用镜像: ${containerImage}`);
  console.log(`🔨 [临时容器] Session 目录挂载: ${actualSessionHostPath}:${sessionContainerPath}:rw`);
  console.log(`🔨 [临时容器] Config 挂载: ${configHostPath}:/app/config.json:ro`);
  
  // 创建容器配置（长期运行，用于多次执行命令）
  // 使用目录挂载 session
  const containerConfig = {
    Image: containerImage,
    name: containerName,
    Cmd: ['sleep', '3600'], // 让容器保持运行（1小时）
    Env: [
      'PYTHONUNBUFFERED=1'
    ],
    HostConfig: {
      Binds: [
        `${configHostPath}:/app/config.json:ro`,
        `${actualSessionHostPath}:${sessionContainerPath}:rw`  // 使用目录挂载
      ],
      AutoRemove: false // 不自动删除，我们手动管理
    },
    NetworkMode: networkName || 'bridge',
    AttachStdout: true,
    AttachStderr: true
  };
  
  // 创建容器
  const container = await docker.createContainer(containerConfig);
  console.log(`✅ [临时容器] 容器已创建`);
  
  // 启动容器
  await container.start();
  console.log(`✅ [临时容器] 容器已启动`);
  
  // 验证目录挂载
  try {
    const verifyExec = await container.exec({
      Cmd: ['sh', '-c', `test -d ${sessionContainerPath} && ls -la ${sessionContainerPath}/ || echo "目录未挂载"`],
      AttachStdout: true,
      AttachStderr: true
    });
    
    const verifyStream = await verifyExec.start({ hijack: true, stdin: false });
    let verifyOutput = '';
    verifyStream.on('data', (chunk) => {
      verifyOutput += chunk.toString();
    });
    await new Promise((resolve) => {
      verifyStream.on('end', resolve);
    });
    
    console.log(`🔍 [临时容器] Session 目录挂载验证:\n${verifyOutput}`);
  } catch (verifyError) {
    console.warn(`⚠️  [临时容器] Session 目录挂载验证失败: ${verifyError.message}`);
  }
  
  console.log(`✅ [临时容器] 创建临时登录容器: ${containerName} (使用目录挂载: ${sessionHostPath})`);
  
  // 保存容器信息
  tempLoginContainers.set(userId, {
    containerName: containerName,
    createdAt: Date.now(),
    container: container
  });
  
  return containerName;
}

// 检查本地 session 文件是否存在（不依赖容器）
// 缓存已检查过的 session 路径，避免重复文件系统操作
const sessionFileCache = new Map();
const SESSION_CACHE_TTL = 5000; // 5秒缓存

// 检查目录中的 session 文件是否存在（多开模式）
async function checkSessionFileInVolume(userId) {
  try {
    const cacheKey = `session_${userId}`;
    const cached = sessionFileCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < SESSION_CACHE_TTL) {
      console.log(`📋 [检查Session] 使用缓存结果: ${cached.exists ? '存在' : '不存在'}`);
      return cached.exists;
    }
    
    console.log(`🔍 [检查Session] 开始检查用户 ${userId} 的 session 文件...`);
    
    // 使用目录挂载方式，直接检查本地文件系统
    const PROJECT_ROOT = process.env.PROJECT_ROOT || '/opt/telegram-monitor';
    const sessionDir = path.join(PROJECT_ROOT, 'data', 'session');
    const sessionFileName = `user_${userId}.session`;
    const journalFileName = `user_${userId}.session-journal`;
    const sessionFile = path.join(sessionDir, sessionFileName);
    const journalFile = path.join(sessionDir, journalFileName);
    
    console.log(`🔍 [检查Session] Session 目录: ${sessionDir}`);
    console.log(`🔍 [检查Session] 检查文件: ${sessionFileName}`);
    
    // 检查目录是否存在
    if (!fs.existsSync(sessionDir)) {
      console.log(`📂 [检查Session] Session 目录不存在: ${sessionDir}`);
      sessionFileCache.set(cacheKey, { exists: false, timestamp: Date.now() });
      return false;
    }
    
    // 检查 .session 文件
    if (fs.existsSync(sessionFile)) {
      try {
        const stats = fs.statSync(sessionFile);
        if (stats.isFile() && stats.size > 0) {
          console.log(`✅ [检查Session] Session 文件存在: ${sessionFile} (大小: ${stats.size} 字节)`);
          sessionFileCache.set(cacheKey, { exists: true, timestamp: Date.now() });
          return true;
        }
      } catch (err) {
        console.warn(`⚠️  [检查Session] 无法读取 session 文件: ${err.message}`);
      }
    }
    
    // 检查 .session-journal 文件（journal 文件存在也说明已登录）
    if (fs.existsSync(journalFile)) {
      console.log(`✅ [检查Session] Journal 文件存在: ${journalFile}`);
      sessionFileCache.set(cacheKey, { exists: true, timestamp: Date.now() });
      return true;
    }
    
    console.log(`📊 [检查Session] 最终结果: 文件不存在`);
    sessionFileCache.set(cacheKey, { exists: false, timestamp: Date.now() });
    return false;
  } catch (error) {
    console.error('❌ [检查Session] 检查 session 文件失败:', error);
    console.error('❌ [检查Session] 错误堆栈:', error.stack);
    return false;
  }
}

function checkSessionFileExists(sessionPath) {
  try {
    // 检查缓存
    const cacheKey = `session_${sessionPath}`;
    const cached = sessionFileCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < SESSION_CACHE_TTL) {
      return cached.exists;
    }
    
    // sessionPath 是容器内的路径，需要转换为本地路径
    // 容器内路径格式: /app/session/telegram 或 /app/session/telegram_xxx
    // API 容器内路径格式: /app/data/session/telegram 或 /app/data/session/telegram_xxx
    
    // 提取 session 文件名（去掉 /app/session 前缀）
    let sessionFileName = sessionPath.replace('/app/session/', '').replace('/app/session', '');
    if (!sessionFileName) {
      sessionFileName = 'telegram'; // 默认文件名
    }
    
    // 只检查项目的 data/session 路径
    // 容器内挂载路径：/app/data/session（对应宿主机：/opt/telegram-monitor/data/session）
    // 如果容器内路径不存在，尝试宿主机路径
    let sessionDir = '/app/data/session';
    if (!fs.existsSync(sessionDir)) {
      // 如果容器内路径不存在，尝试宿主机路径
      sessionDir = '/opt/telegram-monitor/data/session';
    }
    
    // 检查 .session 文件
    const sessionFile = path.join(sessionDir, `${sessionFileName}.session`);
    if (fs.existsSync(sessionFile)) {
      try {
        const stats = fs.statSync(sessionFile);
        if (stats.isFile() && stats.size > 0) {
          // 缓存结果
          sessionFileCache.set(cacheKey, { exists: true, timestamp: Date.now() });
          return true;
        }
      } catch (err) {
        // 文件存在但无法读取，继续检查 journal 文件
      }
    }
    
    // 检查 .session-journal 文件（journal 文件存在也说明已登录）
    const journalFile = path.join(sessionDir, `${sessionFileName}.session-journal`);
    if (fs.existsSync(journalFile)) {
      // journal 文件存在，也认为已登录
      sessionFileCache.set(cacheKey, { exists: true, timestamp: Date.now() });
      return true;
    }
    
    // 如果精确匹配失败，扫描 session 目录
    // 扫描到第一个有效的 session 文件就返回，如果没找到就继续扫描完所有文件
    if (fs.existsSync(sessionDir)) {
      try {
        const files = fs.readdirSync(sessionDir);
        // 扫描所有文件，找到第一个有效的就返回
        for (const file of files) {
          if (file.endsWith('.session') && !file.endsWith('.session-journal')) {
            const filePath = path.join(sessionDir, file);
            try {
              const stats = fs.statSync(filePath);
              if (stats.isFile() && stats.size > 0) {
                // 找到第一个有效的 session 文件就认为已登录，立即返回
                sessionFileCache.set(cacheKey, { exists: true, timestamp: Date.now() });
                return true;
              }
            } catch (err) {
              continue;
            }
          }
        }
        // 如果 .session 文件都没找到，检查 journal 文件
        for (const file of files) {
          if (file.endsWith('.session-journal')) {
            // journal 文件存在，也认为已登录
            sessionFileCache.set(cacheKey, { exists: true, timestamp: Date.now() });
            return true;
          }
        }
      } catch (err) {
        // 忽略扫描错误
      }
    }
    
    // 缓存未找到的结果
    sessionFileCache.set(cacheKey, { exists: false, timestamp: Date.now() });
    return false;
  } catch (error) {
    console.error('检查 session 文件失败:', error);
    return false;
  }
}

// 获取 Docker 连接和 Telethon 容器（支持创建临时容器用于登录操作）
async function getDockerAndContainer(checkReady = false, allowCreateTemp = false) {
  const Docker = require('dockerode');
  const fs = require('fs');
  
  // 尝试连接 Docker socket（支持多个可能的位置）
  const dockerSocketPaths = [
    '/var/run/docker.sock',
    process.env.DOCKER_HOST?.replace('unix://', '') || null
  ].filter(Boolean);
  
  let docker = null;
  for (const socketPath of dockerSocketPaths) {
    if (fs.existsSync(socketPath)) {
      try {
        docker = new Docker({ socketPath });
        // 测试连接
        await docker.ping();
        break;
      } catch (e) {
        console.error(`无法连接到 Docker socket ${socketPath}:`, e.message);
        docker = null;
      }
    }
  }
  
  if (!docker) {
    return Promise.reject(new Error(
      '无法连接到 Docker daemon。请确保：\n' +
      '1. Docker socket 已挂载到容器：/var/run/docker.sock\n' +
      '2. 容器有权限访问 Docker socket\n' +
      '3. 在 docker-compose.yml 中已添加：\n' +
      '   volumes:\n' +
      '     - /var/run/docker.sock:/var/run/docker.sock'
    ));
  }
  
  // 尝试多个容器名称
  const containerNames = ['tg_listener', 'telethon'];
  let container = null;
  let containerInfo = null;
  
  for (const name of containerNames) {
    try {
      container = docker.getContainer(name);
      // 检查容器是否存在
      const info = await container.inspect();
      
      if (!info) {
        container = null;
        continue;
      }
      
      const state = info.State;
      
      // 检查容器状态
      if (state.Restarting) {
        // 容器正在重启
        if (checkReady) {
          console.log(`⏳ 检测到容器 ${name} 正在重启，等待就绪...`);
          try {
            await waitForContainerReady(container, 30);
            containerInfo = await container.inspect();
          } catch (waitError) {
            return Promise.reject(new Error(
              `容器 ${name} 正在重启中，无法执行命令。请等待容器启动完成后再试。\n` +
              `如果容器持续重启，请检查日志: docker logs ${name}\n` +
              `错误详情: ${waitError.message}`
            ));
          }
        } else {
          return Promise.reject(new Error(
            `容器 ${name} 正在重启中，无法执行命令。请等待容器启动完成（通常需要 10-30 秒）后再试。\n` +
            `如果容器持续重启，请检查日志: docker logs ${name}`
          ));
        }
      } else if (state.Running) {
        // 容器正在运行
        containerInfo = info;
        break;
      } else {
        // 容器存在但未运行，在多开模式下不要启动主容器
        if (name === 'tg_listener') {
          // 检查是否有独立容器在运行（多开模式）
          try {
            // 只获取运行中的容器（all: false 只返回运行中的容器）
            const runningContainers = await docker.listContainers({ all: false });
            const hasMultiLoginContainer = runningContainers.some(c => {
              if (!c.Names || c.Names.length === 0) return false;
              return c.Names.some(containerName => {
                const cleanName = containerName.replace(/^\//, '');
                // 检查是否有独立容器在运行（tg_listener_* 格式）
                return cleanName.startsWith('tg_listener_');
              });
            });
            
            if (hasMultiLoginContainer) {
              console.log(`⏭️  [多开模式] 检测到独立容器正在运行，跳过启动主容器 ${name}`);
              container = null;
              continue; // 跳过主容器，继续查找其他容器
            }
          } catch (checkError) {
            console.warn(`⚠️  检查多开容器状态失败，继续尝试启动主容器: ${checkError.message}`);
          }
        }
        
        // 容器存在但未运行，尝试启动
        console.log(`⚠️  检测到容器 ${name} 已停止，尝试启动...`);
        try {
          await container.start();
          console.log(`✅ 容器 ${name} 已启动，等待就绪...`);
          
          if (checkReady) {
            await waitForContainerReady(container, 30);
          } else {
            // 等待容器启动
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
          
          containerInfo = await container.inspect();
          if (containerInfo.State.Running) {
            console.log(`✅ 容器 ${name} 已成功启动并运行`);
            break;
          }
        } catch (startError) {
          console.error(`❌ 启动容器 ${name} 失败:`, startError.message);
          // 继续尝试下一个容器名称
          container = null;
          continue;
        }
      }
    } catch (e) {
      // 容器不存在或查询失败，尝试下一个
      if (e.statusCode === 404) {
        // 容器不存在
        console.log(`容器 ${name} 不存在`);
      } else {
        console.error(`查询容器 ${name} 状态失败:`, e.message);
      }
      container = null;
      continue;
    }
  }
  
  if (!container || !containerInfo) {
    // 收集所有容器的状态信息，提供更详细的错误提示
    let containerStatusInfo = [];
    for (const name of containerNames) {
      try {
        const tempContainer = docker.getContainer(name);
        const tempInfo = await tempContainer.inspect();
        const state = tempInfo.State;
        let statusText = '未知状态';
        if (state.Running) {
          statusText = '运行中';
        } else if (state.Exited) {
          statusText = `已退出 (退出码: ${state.ExitCode})`;
        } else if (state.Restarting) {
          statusText = '正在重启';
        }
        containerStatusInfo.push(`  - ${name}: ${statusText}`);
      } catch (e) {
        containerStatusInfo.push(`  - ${name}: 不存在`);
      }
    }
    
    return Promise.reject(new Error(
      `无法找到运行中的 Telethon 容器。\n\n` +
      `容器状态：\n${containerStatusInfo.join('\n')}\n\n` +
      `请执行以下操作：\n` +
      `1. 检查容器状态: docker ps -a | grep -E 'tg_listener|telethon'\n` +
      `2. 如果容器已停止，启动容器: docker compose up -d telethon\n` +
      `3. 如果容器不存在，重新创建: docker compose up -d --force-recreate telethon\n` +
      `4. 查看容器日志: docker logs tg_listener`
    ));
  }
  
  return { docker, container, containerInfo };
}

// 使用 Docker SDK 创建临时容器执行登录脚本（当主容器未运行时使用）
// allowCreateTemp: 如果为 false，当容器不存在时不创建新容器，而是返回错误
async function execLoginScriptWithDockerRun(command, args, userId = null, reuseContainer = false, allowCreateTemp = true) {
  const Docker = require('dockerode');
  const dockerSocketPaths = [
    '/var/run/docker.sock',
    process.env.DOCKER_HOST?.replace('unix://', '') || null
  ].filter(Boolean);
  
  let docker = null;
  for (const socketPath of dockerSocketPaths) {
    if (fs.existsSync(socketPath)) {
      try {
        docker = new Docker({ socketPath });
        await docker.ping();
        break;
      } catch (e) {
        console.error(`无法连接到 Docker socket ${socketPath}:`, e.message);
        docker = null;
      }
    }
  }
  
  if (!docker) {
    throw new Error('无法连接到 Docker daemon');
  }
  
  const projectRoot = process.cwd();
  const timeout = 30000; // 30秒超时（登录操作应该很快）
  
  // 如果指定了 userId 且需要复用容器，尝试使用已有容器
  let tempContainerName = null;
  let isReusingContainer = false;
  
  if (userId && reuseContainer) {
    const existing = tempLoginContainers.get(userId);
    if (existing) {
      try {
        const container = docker.getContainer(existing.containerName);
        const containerInfo = await container.inspect();
        if (containerInfo.State.Running) {
          tempContainerName = existing.containerName;
          isReusingContainer = true;
          console.log(`♻️  复用临时登录容器: ${tempContainerName}`);
        }
      } catch (e) {
        // 容器不存在，继续创建新的
        tempLoginContainers.delete(userId);
      }
    }
  }
  
  // 如果需要创建新容器，先获取镜像信息
  let containerImage = null;
  let existingContainerInfo = null;
  
  if (!tempContainerName) {
    // 尝试获取现有容器的配置信息，以复用相同的镜像和配置
    try {
      const existingContainer = docker.getContainer('tg_listener');
      existingContainerInfo = await existingContainer.inspect();
      if (existingContainerInfo && existingContainerInfo.Config && existingContainerInfo.Config.Image) {
        containerImage = existingContainerInfo.Config.Image;
        console.log(`✅ 找到现有容器镜像: ${containerImage}`);
      }
    } catch (e) {
      // 容器不存在，尝试查找镜像
      console.log('⚠️  容器不存在，尝试查找 Telethon 镜像...');
    }
  }
  
  // 如果没找到容器，查找镜像
  if (!containerImage) {
    try {
      const images = await docker.listImages();
      // 查找包含 telethon 或 tg_listener 的镜像
      const telethonImage = images.find(img => {
        if (!img.RepoTags || img.RepoTags.length === 0) return false;
        return img.RepoTags.some(tag => 
          (tag.includes('tg_listener') || tag.includes('telethon')) && !tag.includes('<none>')
        );
      });
      if (telethonImage && telethonImage.RepoTags && telethonImage.RepoTags.length > 0) {
        // 使用第一个标签（通常是完整的镜像名称）
        containerImage = telethonImage.RepoTags.find(tag => !tag.includes('<none>')) || telethonImage.RepoTags[0];
        console.log(`✅ 找到 Telethon 镜像: ${containerImage}`);
      }
    } catch (imgError) {
      console.warn('⚠️  无法查找 Telethon 镜像:', imgError.message);
    }
  }
  
  // 如果还是没找到，尝试使用常见的命名格式
  if (!containerImage) {
    // docker-compose 默认命名格式：项目名_服务名
    const possibleNames = [
      'tgjiankong-telethon',
      'tgjiankong-tg_listener', 
      'telethon-tgjiankong',
      'tg_listener'
    ];
    
    for (const name of possibleNames) {
      try {
        const testImage = docker.getImage(name);
        await testImage.inspect();
        containerImage = name;
        console.log(`✅ 使用镜像: ${containerImage}`);
        break;
      } catch (e) {
        // 继续尝试下一个
      }
    }
  }
  
  if (!containerImage) {
    throw new Error('无法找到 Telethon 镜像。请确保 Telethon 容器镜像已构建。可以运行: docker compose build telethon');
  }
  
  // 获取网络名称（从现有容器或使用默认值）
  let networkName = null;
  if (existingContainerInfo && existingContainerInfo.NetworkSettings && existingContainerInfo.NetworkSettings.Networks) {
    networkName = Object.keys(existingContainerInfo.NetworkSettings.Networks)[0];
  }
  
  // 获取主机路径（从现有容器的挂载配置或使用默认值）
  let configHostPath = path.resolve(projectRoot, 'backend', 'config.json');
  
  if (existingContainerInfo && existingContainerInfo.Mounts) {
    // 从现有容器的挂载信息中获取主机路径
    for (const mount of existingContainerInfo.Mounts) {
      if (mount.Destination === '/app/config.json') {
        configHostPath = mount.Source;
        break;
      }
    }
  }
  
  // 使用目录挂载方式，不需要创建 volume
  // 使用 -u 参数禁用 Python 输出缓冲，确保输出立即刷新
  const execArgs = ['python3', '-u', '/app/login_helper.py', command, ...args];
  
  console.log(`🐳 使用 Docker SDK 执行登录脚本: ${command}`);
  console.log(`   容器: ${tempContainerName}`);
  console.log(`   执行命令: ${execArgs.join(' ')}`);
  
  try {
    let container;
    let shouldRemoveContainer = false;
    
    // 如果容器已存在（复用场景），在容器中使用 exec 执行命令
    if (isReusingContainer && tempContainerName) {
      try {
        container = docker.getContainer(tempContainerName);
        // 检查容器是否存在且运行中
        const containerInfo = await container.inspect();
        if (!containerInfo.State.Running) {
          console.warn(`⚠️  临时容器 ${tempContainerName} 未运行，状态: ${containerInfo.State.Status}，尝试启动...`);
          try {
            await container.start();
            // 等待容器启动
            await new Promise(resolve => setTimeout(resolve, 1000));
          } catch (startError) {
            console.error(`❌ 无法启动容器 ${tempContainerName}: ${startError.message}`);
            // 容器无法启动，创建新容器
            isReusingContainer = false;
            tempContainerName = null;
            tempLoginContainers.delete(userId);
          }
        }
      } catch (inspectError) {
        console.warn(`⚠️  临时容器 ${tempContainerName} 不存在或无法访问: ${inspectError.message}`);
        // 容器不存在，清除记录
        tempLoginContainers.delete(userId);
        // 如果 allowCreateTemp=false，不允许创建新容器，返回错误
        if (!allowCreateTemp) {
          throw new Error(
            `临时登录容器不存在。请先点击"Telegram 首次登录"按钮初始化登录容器。\n\n` +
            `如果容器被意外删除，请重新点击"Telegram 首次登录"按钮。`
          );
        }
        // 如果 allowCreateTemp=true，允许创建新容器
        isReusingContainer = false;
        tempContainerName = null;
      }
      
      // 如果容器仍然可用，使用 exec 执行命令
      if (isReusingContainer && tempContainerName) {
        // 在已有容器中执行命令（使用 exec）
        console.log(`♻️  在已有容器中执行命令: ${tempContainerName}`);
        
        // 创建 exec 实例
        const exec = await container.exec({
          Cmd: execArgs,
          AttachStdout: true,
          AttachStderr: true,
          Env: ['PYTHONUNBUFFERED=1']
        });
        
        // 启动 exec 并获取输出
        const execStream = await exec.start({
          hijack: true,
          stdin: false
        });
        
        let stdout = '';
        let stderr = '';
        
        return new Promise((resolve, reject) => {
          execStream.on('data', (chunk) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            let offset = 0;
            
            while (offset < buffer.length) {
              if (buffer.length - offset < 8) break;
              
              const streamType = buffer[offset];
              const payloadLength = buffer.readUInt32BE(offset + 4);
              
              if (buffer.length - offset < 8 + payloadLength) break;
              
              const payload = buffer.slice(offset + 8, offset + 8 + payloadLength);
              
              if (streamType === 1) {
                stdout += payload.toString();
              } else if (streamType === 2) {
                stderr += payload.toString();
              }
              
              offset += 8 + payloadLength;
            }
          });
          
          execStream.on('end', () => {
            try {
              const outputText = stdout.trim() || stderr.trim();
              let jsonText = outputText;
              const jsonMatch = outputText.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                jsonText = jsonMatch[0];
              }
              const result = JSON.parse(jsonText);
              resolve(result);
            } catch (parseError) {
              reject(new Error(`解析输出失败: ${parseError.message}, 输出: ${stdout || stderr}`));
            }
          });
          
          execStream.on('error', (err) => {
            reject(new Error(`执行失败: ${err.message}`));
          });
        });
      }
    }
    
    // 如果容器不存在或无法复用，根据 allowCreateTemp 决定是否创建新容器
    if (!tempContainerName) {
      // 如果 allowCreateTemp=false，不允许创建新容器，返回错误
      if (!allowCreateTemp) {
        throw new Error(
          `临时登录容器不存在。请先点击"Telegram 首次登录"按钮初始化登录容器。\n\n` +
          `如果容器被意外删除，请重新点击"Telegram 首次登录"按钮。`
        );
      }
      
      // 如果需要创建可复用的容器
      if (userId && reuseContainer) {
        tempContainerName = await getOrCreateTempLoginContainer(userId, configHostPath, null, containerImage, networkName);
        isReusingContainer = true;
      } else {
        // 创建一次性临时容器
        tempContainerName = `tg_login_temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      }
    }
    
    // 使用目录挂载方式
    const PROJECT_ROOT = process.env.PROJECT_ROOT || '/opt/telegram-monitor';
    const sessionHostPath = path.join(PROJECT_ROOT, 'data', 'session');
    const sessionContainerPath = '/opt/telegram-monitor/data/session';
    
    console.log(`🐳 [登录脚本] 创建临时容器: ${tempContainerName}`);
    console.log(`🐳 [登录脚本] 使用镜像: ${containerImage}`);
    console.log(`🐳 [登录脚本] Session 目录挂载: ${sessionHostPath}:${sessionContainerPath}:rw`);
    console.log(`🐳 [登录脚本] Config 挂载: ${configHostPath}:/app/config.json:ro`);
    
    container = await docker.createContainer({
      Image: containerImage,
      name: tempContainerName,
      Cmd: execArgs,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      OpenStdin: false,
      Env: [
        'PYTHONUNBUFFERED=1'  // 禁用 Python 输出缓冲
      ],
      HostConfig: {
        Binds: [
          `${configHostPath}:/app/config.json:ro`,
          `${sessionHostPath}:${sessionContainerPath}:rw`  // 使用目录挂载
        ],
        AutoRemove: !(userId && reuseContainer) // 如果是复用容器，不自动删除
      },
      NetworkMode: networkName || 'bridge' // 登录脚本不需要访问内部网络
    });
    
    console.log(`✅ [登录脚本] 容器已创建`);
    
    // 启动容器
    await container.start();
    // 减少日志输出，提高响应速度
    // console.log(`✅ 临时容器已启动: ${tempContainerName}`);
    
    // 使用 attach 方式实时获取输出（必须在容器启动后）
    let stdout = '';
    let stderr = '';
    let attachResolved = false;
    let hasValidJson = false; // 标记是否已检测到有效 JSON 输出
    
    // 创建 attach 流来实时获取输出
    const attachPromise = new Promise((resolve, reject) => {
      container.attach({ stream: true, stdout: true, stderr: true }, (err, stream) => {
        if (err) {
          console.warn(`⚠️  Attach 失败，将使用 logs 方式: ${err.message}`);
          attachResolved = true;
          return resolve(); // 不阻塞，继续使用 logs 方式
        }
        
        // 解析 Docker 流格式
        stream.on('data', (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          let offset = 0;
          
          while (offset < buffer.length) {
            if (buffer.length - offset < 8) break;
            
            const streamType = buffer[offset];
            const payloadLength = buffer.readUInt32BE(offset + 4);
            
            if (buffer.length - offset < 8 + payloadLength) break;
            
            const payload = buffer.slice(offset + 8, offset + 8 + payloadLength);
            
            if (streamType === 1) { // stdout
              const text = payload.toString();
              stdout += text;
              
              // 一旦检测到有效的 JSON 输出，立即标记可以返回（不等待流结束）
              if (text.includes('{') && (stdout.match(/\{[\s\S]*\}/) || stdout.includes('"success"'))) {
                // 检测到可能的 JSON 输出，准备快速返回
                if (!hasValidJson) {
                  hasValidJson = true;
                }
              }
            } else if (streamType === 2) { // stderr
              const text = payload.toString();
              stderr += text;
              // 只在有错误时输出
              if (text.trim() && !text.includes('INFO')) {
                console.log(`📥 容器错误: ${text.substring(0, 200).replace(/\n/g, '\\n')}`);
              }
            }
            
            offset += 8 + payloadLength;
          }
        });
        
        stream.on('end', () => {
          // 减少日志输出，提高响应速度
          // console.log('✅ Attach 流结束');
          attachResolved = true;
          resolve();
        });
        
        stream.on('error', (err) => {
          console.warn(`⚠️  Attach 流错误: ${err.message}`);
          attachResolved = true;
          resolve(); // 不阻塞，继续使用 logs 方式
        });
      });
    });
    
    // 开始监听输出（不等待完成，在后台运行）
    const attachTask = attachPromise.catch(err => {
      console.warn(`⚠️  Attach Promise 错误: ${err.message}`);
      attachResolved = true;
    });
    
    // 等待容器执行完成（最多等待 timeout 毫秒）
    const waitPromise = container.wait().then(async (data) => {
      // 减少日志输出
      // console.log(`📋 容器已退出，退出码: ${data.StatusCode}`);
      
      // 如果已经有输出，立即处理（不等待 attach 完成）
      let hasOutput = stdout.trim() || stderr.trim();
      
      if (hasValidJson || (hasOutput && stdout.includes('{'))) {
        // 如果已经检测到有效的 JSON 输出，只等待很短时间确保数据完整（减少到 50ms）
        await Promise.race([
          attachTask,
          new Promise(resolve => setTimeout(resolve, 50)) // 只等待 50ms，确保 JSON 完整
        ]);
      } else if (hasOutput) {
        // 如果有输出但不是 JSON，等待稍长时间（减少到 100ms）
        await Promise.race([
          attachTask,
          new Promise(resolve => setTimeout(resolve, 100))
        ]);
      } else {
        // 如果没有输出，等待 attach 完成或超时（减少到 300ms）
        const attachTimeout = new Promise(resolve => setTimeout(() => {
          // console.log('⏱️  Attach 等待超时，使用 logs 获取输出');
          resolve();
        }, 300));
        await Promise.race([attachTask, attachTimeout]);
      }
      
      // 如果 attach 没有获取到输出，或者输出为空，尝试从 logs 获取
      if ((!stdout.trim() && !stderr.trim()) || (!attachResolved && !hasOutput)) {
        console.log('📋 从 logs 获取容器输出...');
        try {
          const logs = await container.logs({
            follow: false,
            stdout: true,
            stderr: true,
            timestamps: false
          });
          
          // 解析日志
          const buffer = Buffer.isBuffer(logs) ? logs : Buffer.from(logs);
          let offset = 0;
          
          while (offset < buffer.length) {
            if (buffer.length - offset < 8) break;
            
            const streamType = buffer[offset];
            const payloadLength = buffer.readUInt32BE(offset + 4);
            
            if (buffer.length - offset < 8 + payloadLength) break;
            
            const payload = buffer.slice(offset + 8, offset + 8 + payloadLength);
            const text = payload.toString();
            
            if (streamType === 1) {
              if (!stdout.includes(text)) { // 避免重复添加
                stdout += text;
              }
            } else if (streamType === 2) {
              if (!stderr.includes(text)) { // 避免重复添加
                stderr += text;
              }
            }
            
            offset += 8 + payloadLength;
          }
          
          // 减少日志输出
          // console.log(`📋 从 logs 获取到 stdout: ${stdout.length} 字节, stderr: ${stderr.length} 字节`);
        } catch (logError) {
          console.warn(`⚠️  获取日志失败: ${logError.message}`);
        }
      }
      
      return data;
    });
    
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`容器执行超时（${timeout/1000}秒）`)), timeout);
    });
    
    await Promise.race([waitPromise, timeoutPromise]);
    
    // 如果已经有输出，不需要等待 attach 任务完成
    if (!stdout.trim() && !stderr.trim()) {
      // 只有在没有输出时才等待 attach 任务
      await attachTask;
    }
    
    // 检查容器退出码
    const containerInfo = await container.inspect();
    const exitCode = containerInfo.State.ExitCode;
    
    // 减少日志输出，只在出错时输出
    // console.log(`📋 容器执行完成，退出码: ${exitCode}`);
    // console.log(`📋 stdout 长度: ${stdout.length}, stderr 长度: ${stderr.length}`);
    
    // 清理容器（AutoRemove 应该已经删除，但为了安全还是尝试清理）
    try {
      await container.remove({ force: true });
    } catch (cleanupError) {
      // 忽略清理错误，容器可能已经自动删除
    }
    
    // 解析结果
    const resultText = stdout.trim() || stderr.trim();
    
    // 如果退出码是 137（OOM Killer），但已有输出，尝试解析
    if (exitCode === 137 && resultText) {
      console.warn(`⚠️  容器被 OOM Killer 终止（退出码: 137），但检测到输出，尝试解析...`);
      console.warn(`⚠️  stdout: ${stdout.substring(0, 500)}`);
      console.warn(`⚠️  stderr: ${stderr.substring(0, 500)}`);
      
      // 首先检查是否有 Telegram API 错误（优先于 OOM 错误）
      if (resultText.includes('AuthRestartError') || resultText.includes('Restart the authorization process')) {
        const errorMatch = resultText.match(/(AuthRestartError[^\n]*|Restart the authorization process[^\n]*)/);
        const errorMsg = errorMatch ? errorMatch[0] : 'Telegram 授权需要重新开始';
        console.error(`❌ 检测到 Telegram API 错误: ${errorMsg}`);
        throw new Error(
          `Telegram API 错误：${errorMsg}\n\n` +
          `这通常表示：\n` +
          `1. Telegram 服务器内部问题\n` +
          `2. 需要重新开始授权流程\n` +
          `3. 请稍后重试或删除旧的 session 文件后重新登录`
        );
      }
      
      // 检查其他 Telegram 错误
      if (resultText.includes('Telegram is having internal issues')) {
        throw new Error(
          `Telegram 服务器内部问题\n\n` +
          `Telegram 服务器当前可能遇到问题，请稍后重试。\n` +
          `如果问题持续，可以尝试：\n` +
          `1. 等待几分钟后重试\n` +
          `2. 删除旧的 session 文件后重新登录`
        );
      }
      
      try {
        // 尝试提取 JSON
        const jsonMatch = resultText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          if (result.success) {
            console.log(`✅ 从被终止的进程中成功解析结果: ${JSON.stringify(result).substring(0, 200)}`);
            return result;
          } else if (result.error) {
            // 如果有错误信息，返回错误
            throw new Error(result.error);
          }
        }
      } catch (parseError) {
        // 如果是我们抛出的错误，直接抛出
        if (parseError.message && (parseError.message.includes('Telegram') || parseError.message.includes('授权'))) {
          throw parseError;
        }
        console.warn(`⚠️  无法解析输出: ${parseError.message}`);
      }
      
      // 如果无法解析或结果不成功，抛出 OOM 错误
      throw new Error(
        `脚本执行被强制终止（退出码: 137，可能是内存不足）\n\n` +
        `可能原因：\n` +
        `1. 容器内存不足\n` +
        `2. 进程执行时间过长被系统终止\n` +
        `3. Docker 容器资源限制\n\n` +
        `建议：\n` +
        `- 检查容器内存使用: docker stats\n` +
        `- 查看系统日志: dmesg | grep -i oom | tail -20\n` +
        `- 检查容器资源限制: docker inspect <container> | grep -A 10 Memory\n` +
        `- 如果内存不足，请增加服务器内存或关闭其他服务\n\n` +
        `输出信息: ${resultText.substring(0, 500)}`
      );
    }
    
    if (!resultText) {
      // 如果没有任何输出，检查容器状态和可能的错误
      const errorDetails = [];
      if (exitCode !== 0) {
        errorDetails.push(`容器退出码: ${exitCode}`);
      }
      if (containerInfo.State.Error) {
        errorDetails.push(`容器错误: ${containerInfo.State.Error}`);
      }
      
      throw new Error(
        `脚本执行无输出。${errorDetails.length > 0 ? errorDetails.join('; ') : ''}\n\n` +
        `可能原因：\n` +
        `1. Python 脚本执行出错但没有输出错误信息\n` +
        `2. 脚本路径或参数错误\n` +
        `3. 容器镜像配置问题\n\n` +
        `建议检查：\n` +
        `- 容器日志: docker logs ${tempContainerName}\n` +
        `- 镜像是否正确: docker images | grep telethon\n` +
        `- 脚本文件是否存在: docker exec ${tempContainerName} ls -la /app/login_helper.py`
      );
    }
    
    // 只在有错误时输出调试信息
    if (stderr.trim() && !stdout.trim()) {
      console.log(`⚠️  stderr 输出: ${stderr.substring(0, 200)}`);
    }
    
    try {
      // 尝试从 stdout 或 stderr 中解析 JSON（login_helper.py 输出到 stdout）
      const outputText = stdout.trim() || stderr.trim();
      
      // 尝试提取 JSON（可能包含其他输出）
      let jsonText = outputText;
      const jsonMatch = outputText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonText = jsonMatch[0];
      }
      
      const result = JSON.parse(jsonText);
      return result;
    } catch (parseError) {
      // 如果无法解析为 JSON，返回错误信息
      const errorMsg = stderr.trim() || stdout.trim() || '未知错误';
      // 只在出错时输出详细错误
      console.error(`❌ 解析 JSON 失败: ${parseError.message}`);
      console.error(`❌ 输出内容: ${errorMsg.substring(0, 500)}`);
      throw new Error(`脚本输出不是有效的 JSON: ${errorMsg.substring(0, 500)}`);
    }
    
  } catch (error) {
    // 确保清理临时容器
    try {
      const tempContainer = docker.getContainer(tempContainerName);
      const containerInfo = await tempContainer.inspect();
      if (containerInfo.State.Running) {
        await tempContainer.stop();
      }
      await tempContainer.remove({ force: true });
    } catch (cleanupError) {
      // 忽略清理错误
    }
    
    // 提供更详细的错误信息
    if (error.message && error.message.includes('超时')) {
      throw error;
    }
    
    if (error.message && error.message.includes('No such image')) {
      throw new Error(
        `无法找到 Telethon 镜像: ${containerImage}\n\n` +
        `请执行以下操作：\n` +
        `1. 确保 Telethon 容器镜像已构建：docker compose build telethon\n` +
        `2. 检查镜像是否存在：docker images | grep telethon\n` +
        `3. 如果镜像不存在，重新构建：docker compose build --no-cache telethon`
      );
    }
    
    if (error.message && error.message.includes('Cannot connect to the Docker daemon')) {
      throw new Error(
        `无法连接到 Docker daemon\n\n` +
        `请确保：\n` +
        `1. Docker socket 已挂载到容器：/var/run/docker.sock\n` +
        `2. 容器有权限访问 Docker socket\n` +
        `3. 在 docker-compose.yml 中已添加挂载配置`
      );
    }
    
    throw new Error(`创建临时容器执行脚本失败: ${error.message}`);
  }
}

// 同步用户配置到全局配置文件并重启 Telethon 服务
async function syncUserConfigAndRestartTelethon(userId) {
  try {
    // 更新全局配置文件中的 user_id
    const globalConfig = loadConfig();
    globalConfig.user_id = userId.toString();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(globalConfig, null, 2));
    console.log(`✅ 已更新全局配置文件中的 user_id 为: ${userId}`);
    
      // 同步用户配置到全局配置文件
      const userConfig = await loadUserConfig(userId.toString());
      if (userConfig) {
        const configObj = userConfig.toObject ? userConfig.toObject() : userConfig;
        
        // 添加详细日志
        console.log(`🔍 [配置同步] 从数据库读取配置 - alert_keywords:`, JSON.stringify(configObj.alert_keywords || []));
        console.log(`🔍 [配置同步] alert_keywords 类型:`, typeof configObj.alert_keywords, Array.isArray(configObj.alert_keywords) ? '(数组)' : '(非数组)');
        
        // 确保 alert_keywords 是数组
        let alertKeywordsArray = [];
        if (Array.isArray(configObj.alert_keywords)) {
          alertKeywordsArray = configObj.alert_keywords;
        } else if (typeof configObj.alert_keywords === 'string') {
          // 如果是字符串，尝试按换行符分割
          alertKeywordsArray = configObj.alert_keywords.split('\n').map(k => k.trim()).filter(k => k);
        } else if (configObj.alert_keywords) {
          // 其他类型，尝试转换为数组
          alertKeywordsArray = [configObj.alert_keywords].filter(k => k);
        }
        
        const configToSync = {
          keywords: Array.isArray(configObj.keywords) ? configObj.keywords : (configObj.keywords || []),
          channels: Array.isArray(configObj.channels) ? configObj.channels : (configObj.channels || []),
          alert_keywords: alertKeywordsArray,
          alert_regex: Array.isArray(configObj.alert_regex) ? configObj.alert_regex : (configObj.alert_regex || []),
          log_all_messages: configObj.log_all_messages !== undefined ? configObj.log_all_messages : true,
          alert_target: configObj.alert_target || ''
        };
        
        console.log(`🔍 [配置同步] 准备同步的配置 - alert_keywords:`, JSON.stringify(configToSync.alert_keywords), `(${configToSync.alert_keywords.length} 个)`);
        
        // 同步 alert_actions 配置（Telethon服务不需要，但后端API需要从数据库读取）
        // 这里只是记录日志，实际使用时从数据库读取
        if (configObj.alert_actions) {
          console.log(`📋 [配置同步] alert_actions 配置:`, JSON.stringify(configObj.alert_actions, null, 2));
        }
        
        // 如果用户配置中有 Telegram API 配置，也同步到全局配置
        if (configObj.telegram && configObj.telegram.api_id && configObj.telegram.api_hash) {
          configToSync.telegram = {
            api_id: configObj.telegram.api_id,
            api_hash: configObj.telegram.api_hash
          };
          console.log(`✅ [配置同步] 已同步用户的 Telegram API 配置到全局配置文件`);
        }
        
        // 同步 AI 分析配置（包括触发相关配置）
        if (configObj.ai_analysis) {
          // 确保 ai_analysis 是一个完整的对象
          configToSync.ai_analysis = {
            enabled: configObj.ai_analysis.enabled || false,
            ai_trigger_enabled: configObj.ai_analysis.ai_trigger_enabled || false,
            ai_trigger_users: Array.isArray(configObj.ai_analysis.ai_trigger_users) 
              ? configObj.ai_analysis.ai_trigger_users 
              : (typeof configObj.ai_analysis.ai_trigger_users === 'string' 
                  ? configObj.ai_analysis.ai_trigger_users.split('\n').map(u => u.trim()).filter(u => u)
                  : []),
            ai_trigger_prompt: configObj.ai_analysis.ai_trigger_prompt || '',
            // 注意：openai_api_key、analysis_trigger_type、message_count_threshold 等不同步到文件
            // 这些配置只在后端API中使用，Telethon服务不需要
          };
          console.log(`✅ [配置同步] 已同步用户的 AI 分析配置到全局配置文件 (ai_trigger_enabled: ${configToSync.ai_analysis.ai_trigger_enabled}, 触发用户数: ${configToSync.ai_analysis.ai_trigger_users?.length || 0})`);
        }
        
        // 更新全局配置，保留其他字段（如 alert_actions 等）
        Object.assign(globalConfig, configToSync);
        
        // 写入配置文件前再次验证
        console.log(`📝 [配置同步] 准备写入配置文件 - alert_keywords:`, JSON.stringify(configToSync.alert_keywords));
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(globalConfig, null, 2));
        
        // 验证写入后的配置文件
        try {
          const verifyConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
          console.log(`✅ [配置同步] 配置文件已写入并验证 - alert_keywords:`, JSON.stringify(verifyConfig.alert_keywords || []), `(${(verifyConfig.alert_keywords || []).length} 个)`);
        } catch (verifyError) {
          console.error(`❌ [配置同步] 验证配置文件失败:`, verifyError.message);
        }
        
        console.log(`✅ [配置同步] 已同步用户配置到全局配置文件 (userId: ${userId})`);
        console.log(`   - alert_target: ${configToSync.alert_target || '未设置'}`);
        console.log(`   - keywords: ${configToSync.keywords?.length || 0} 个`);
        console.log(`   - alert_keywords: ${configToSync.alert_keywords?.length || 0} 个 ${configToSync.alert_keywords?.length > 0 ? `(${configToSync.alert_keywords.join(', ')})` : ''}`);
        console.log(`   - alert_regex: ${configToSync.alert_regex?.length || 0} 个`);
        console.log(`   - channels: ${configToSync.channels?.length || 0} 个`);
      }
    
    // 清除用户配置缓存，确保下次读取时获取最新配置
    userConfigCache.delete(`user_config_${userId}`);
    console.log(`🗑️  已清除用户 ${userId} 的配置缓存`);
    
    // 在重启 Telethon 服务前，等待 500ms 确保配置文件写入完成（减少等待时间）
    console.log(`⏳ [配置同步] 等待配置文件写入完成...`);
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // 重启 Telethon 服务以应用新配置
    const restartSuccess = await restartTelethonService(userId);
    if (restartSuccess) {
      console.log(`✅ 已重启 Telethon 服务以应用用户 ${userId} 的配置`);
    } else {
      console.warn(`⚠️  Telethon 服务重启失败，配置将在下次配置重载时生效（约10秒）`);
    }
    
    return restartSuccess;
  } catch (error) {
    console.error('⚠️  同步用户配置失败（不影响登录）:', error);
    return false;
  }
}

// 强制重启主容器（忽略多开模式检查，用于关闭多开模式时）
async function forceRestartMainContainer(userId = null) {
  try {
    // 先同步配置
    const globalConfig = loadConfig();
    if (userId) {
      globalConfig.user_id = userId.toString();
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(globalConfig, null, 2));
      console.log(`✅ [强制重启] 已更新全局配置文件中的 user_id 为: ${userId}`);
      
      // 同步用户配置
      const userConfig = await loadUserConfig(userId.toString());
      if (userConfig) {
        const configObj = userConfig.toObject ? userConfig.toObject() : userConfig;
        
        const configToSync = {
          keywords: Array.isArray(configObj.keywords) ? configObj.keywords : (configObj.keywords || []),
          channels: Array.isArray(configObj.channels) ? configObj.channels : (configObj.channels || []),
          alert_keywords: Array.isArray(configObj.alert_keywords) ? configObj.alert_keywords : (configObj.alert_keywords || []),
          alert_regex: Array.isArray(configObj.alert_regex) ? configObj.alert_regex : (configObj.alert_regex || []),
          log_all_messages: configObj.log_all_messages !== undefined ? configObj.log_all_messages : true,
          alert_target: configObj.alert_target || ''
        };
        
        if (configObj.telegram && configObj.telegram.api_id && configObj.telegram.api_hash) {
          configToSync.telegram = {
            api_id: configObj.telegram.api_id,
            api_hash: configObj.telegram.api_hash
          };
        }
        
        if (configObj.ai_analysis) {
          configToSync.ai_analysis = {
            enabled: configObj.ai_analysis.enabled || false,
            ai_trigger_enabled: configObj.ai_analysis.ai_trigger_enabled || false,
            ai_trigger_users: Array.isArray(configObj.ai_analysis.ai_trigger_users) 
              ? configObj.ai_analysis.ai_trigger_users 
              : [],
            ai_trigger_prompt: configObj.ai_analysis.ai_trigger_prompt || ''
          };
        }
        
        Object.assign(globalConfig, configToSync);
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(globalConfig, null, 2));
      }
    }
    
    // 强制重启主容器
    const Docker = require('dockerode');
    const dockerSocketPaths = [
      '/var/run/docker.sock',
      process.env.DOCKER_HOST?.replace('unix://', '') || null
    ].filter(Boolean);
    
    let docker = null;
    for (const socketPath of dockerSocketPaths) {
      if (fs.existsSync(socketPath)) {
        try {
          docker = new Docker({ socketPath });
          await docker.ping();
          break;
        } catch (e) {
          docker = null;
        }
      }
    }
    
    if (!docker) {
      throw new Error('无法连接到 Docker daemon');
    }
    
    // 查找主容器
    let container = null;
    const containerNames = ['tg_listener', 'telethon'];
    
    for (const name of containerNames) {
      try {
        container = docker.getContainer(name);
        await container.inspect();
        break;
      } catch (e) {
        container = null;
      }
    }
    
    if (!container) {
      console.warn('⚠️  [强制重启] Telethon 主容器不存在，无法重启');
      return false;
    }
    
    // 检查容器状态并启动/重启
    const containerInfo = await container.inspect();
    const state = containerInfo.State;
    
    if (state.Restarting) {
      console.log('⚠️  [强制重启] 容器正在重启中，先停止容器...');
      await container.stop({ t: 10 });
      await new Promise(resolve => setTimeout(resolve, 2000));
    } else if (state.Running) {
      console.log('🔄 [强制重启] 重启主容器...');
      await container.restart({ t: 10 });
      console.log('✅ [强制重启] 主容器已重启');
      return true;
    }
    
    // 启动容器
    console.log('▶️  [强制重启] 启动主容器...');
    await container.start();
    console.log('✅ [强制重启] 主容器已启动');
    return true;
  } catch (error) {
    console.error('❌ [强制重启] 重启主容器失败:', error.message);
    return false;
  }
}

// 重启 Telethon 服务
async function restartTelethonService(userId = null) {
  try {
    const Docker = require('dockerode');
    const dockerSocketPaths = [
      '/var/run/docker.sock',
      process.env.DOCKER_HOST?.replace('unix://', '') || null
    ].filter(Boolean);
    
    let docker = null;
    for (const socketPath of dockerSocketPaths) {
      if (fs.existsSync(socketPath)) {
        try {
          docker = new Docker({ socketPath });
          await docker.ping();
          break;
        } catch (e) {
          docker = null;
        }
      }
    }
    
    if (!docker) {
      throw new Error('无法连接到 Docker daemon');
    }
    
    // 检查是否启用了多开模式
    let multiLoginEnabled = false;
    if (userId) {
      try {
        const accountId = await getAccountId(userId);
        const accountConfig = await loadUserConfig(accountId.toString());
        multiLoginEnabled = accountConfig.multi_login_enabled || false;
        if (multiLoginEnabled) {
          console.log(`⏭️  [重启服务] 多开模式已启用，跳过重启主容器（应使用独立容器）`);
          return false; // 多开模式下不重启主容器
        }
      } catch (configError) {
        console.warn(`⚠️  [重启服务] 检查多开模式失败，继续重启主容器: ${configError.message}`);
      }
    }
    
    // 检查是否有独立容器在运行（作为额外检查）
    // 注意：只有在 multiLoginEnabled 为 true 时才检查，如果为 false 则强制启动主容器
    if (multiLoginEnabled) {
      try {
        // 只获取运行中的容器（all: false 只返回运行中的容器）
        const runningContainers = await docker.listContainers({ all: false });
        const hasMultiLoginContainer = runningContainers.some(c => {
          if (!c.Names || c.Names.length === 0) return false;
          return c.Names.some(containerName => {
            const cleanName = containerName.replace(/^\//, '');
            return cleanName.startsWith('tg_listener_');
          });
        });
        
        if (hasMultiLoginContainer) {
          console.log(`⏭️  [重启服务] 检测到独立容器正在运行，跳过重启主容器（多开模式）`);
          return false; // 有独立容器运行时，不重启主容器
        }
      } catch (checkError) {
        console.warn(`⚠️  [重启服务] 检查独立容器状态失败，继续重启主容器: ${checkError.message}`);
      }
    } else {
      console.log(`✅ [重启服务] 多开模式已关闭，强制启动主容器（单开模式）`);
    }
    
    // 尝试获取容器
    let container = null;
    const containerNames = ['tg_listener', 'telethon'];
    
    for (const name of containerNames) {
      try {
        container = docker.getContainer(name);
        await container.inspect();
        break;
      } catch (e) {
        container = null;
      }
    }
    
    if (!container) {
      console.warn('⚠️  Telethon 容器不存在，无法重启');
      return false;
    }
    
    // 检查容器状态
    const containerInfo = await container.inspect();
    const state = containerInfo.State;
    
    // 如果提供了 userId，尝试更新容器的环境变量
    // 注意：更新环境变量需要重新创建容器，这里我们只记录日志
    // Telethon 服务会优先从配置文件读取 user_id，所以即使环境变量是旧值也没关系
    if (userId) {
      console.log(`📝 准备重启 Telethon 服务以应用用户 ${userId} 的配置（配置文件已更新）`);
    }
    
    // 如果容器正在重启，先停止它
    if (state.Restarting) {
      console.log('⚠️  容器正在重启中，先停止容器...');
      try {
        await container.stop({ t: 10 }); // 等待最多10秒
        // 等待容器完全停止
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (stopError) {
        console.warn('⚠️  停止容器失败（可能已经停止）:', stopError.message);
      }
    } else if (state.Running) {
      // 如果容器正在运行，直接重启
      await container.restart({ t: 10 });
      console.log('✅ Telethon 服务已重启');
      return true;
    }
    
    // 启动容器
    try {
      await container.start();
      console.log('✅ Telethon 服务已启动');
      return true;
    } catch (startError) {
      // 如果启动失败，可能是容器配置问题
      console.error('⚠️  启动 Telethon 服务失败:', startError.message);
      return false;
    }
  } catch (error) {
    console.error('⚠️  重启 Telethon 服务失败:', error.message);
    return false;
  }
}

// 多开登录：为指定用户创建/启动独立容器
async function syncUserConfigAndStartMultiLoginContainer(userId) {
  try {
    // 同步用户配置到独立配置文件
    const userConfig = await loadUserConfig(userId.toString());
    const configObj = userConfig.toObject ? userConfig.toObject() : userConfig;
    
    // 为每个用户创建独立的配置文件
    const userConfigPath = path.join(__dirname, `config_${userId}.json`);
    
    // 检查路径是否是目录（不应该发生，但如果发生需要修复）
    if (fs.existsSync(userConfigPath) && fs.statSync(userConfigPath).isDirectory()) {
      console.error(`❌ [多开登录] 配置文件路径是目录而不是文件: ${userConfigPath}`);
      console.error(`   正在删除错误的目录并重新创建文件...`);
      try {
        fs.rmSync(userConfigPath, { recursive: true, force: true });
        console.log(`✅ [多开登录] 已删除错误的目录: ${userConfigPath}`);
      } catch (rmError) {
        console.error(`❌ [多开登录] 删除目录失败: ${rmError.message}`);
        throw new Error(`配置文件路径是目录且无法删除: ${userConfigPath}`);
      }
    }
    
    const userConfigData = {
      // 在多开模式下，设置 user_id 让 monitor.py 正确读取
      // monitor.py 会使用 user_id 构建 session 文件名为 user_{user_id}
      // 配合 SESSION_PREFIX='user' 和 USER_ID 环境变量，最终文件名为 user_{userId}
      user_id: userId.toString(),
      keywords: Array.isArray(configObj.keywords) ? configObj.keywords : [],
      channels: Array.isArray(configObj.channels) ? configObj.channels : [],
      alert_keywords: Array.isArray(configObj.alert_keywords) ? configObj.alert_keywords : [],
      alert_regex: Array.isArray(configObj.alert_regex) ? configObj.alert_regex : [],
      log_all_messages: configObj.log_all_messages || false,
      alert_target: configObj.alert_target || ''
    };
    
    // 如果用户配置中有 Telegram API 配置，也添加到配置文件
    if (configObj.telegram && configObj.telegram.api_id && configObj.telegram.api_hash) {
      userConfigData.telegram = {
        api_id: configObj.telegram.api_id,
        api_hash: configObj.telegram.api_hash
      };
    }
    
    // 同步 AI 分析配置
    if (configObj.ai_analysis) {
      userConfigData.ai_analysis = {
        enabled: configObj.ai_analysis.enabled || false,
        ai_trigger_enabled: configObj.ai_analysis.ai_trigger_enabled || false,
        ai_trigger_users: Array.isArray(configObj.ai_analysis.ai_trigger_users) 
          ? configObj.ai_analysis.ai_trigger_users 
          : [],
        ai_trigger_prompt: configObj.ai_analysis.ai_trigger_prompt || ''
      };
    }
    
    fs.writeFileSync(userConfigPath, JSON.stringify(userConfigData, null, 2));
    console.log(`✅ [多开登录] 已创建用户 ${userId} 的独立配置文件: ${userConfigPath}`);
    
    // 启动或重启该用户的独立容器（必须以实际 Running 为准）
    const started = await startMultiLoginContainer(userId.toString());
    return started === true;
  } catch (error) {
    console.error(`❌ [多开登录] 同步用户 ${userId} 配置失败:`, error);
    return false;
  }
}

// 获取或创建 session volume
async function getOrCreateSessionVolume(docker) {
  const volumeName = 'tg_session';
  
  try {
    const volume = docker.getVolume(volumeName);
    const volumeInfo = await volume.inspect();
    console.log(`✅ [Volume] Volume ${volumeName} 已存在`);
    if (volumeInfo && volumeInfo.Mountpoint) {
      console.log(`📂 [Volume] Volume 挂载点: ${volumeInfo.Mountpoint}`);
    }
    return volumeInfo; // 返回 volume 信息，而不仅仅是名称
  } catch (e) {
    // Volume 不存在，创建它
    console.log(`📦 [Volume] 创建 Volume ${volumeName}...`);
    try {
      const volume = await docker.createVolume({
        Name: volumeName,
        Driver: 'local'
      });
      const volumeInfo = await volume.inspect();
      console.log(`✅ [Volume] 已创建 Volume ${volumeName}`);
      if (volumeInfo && volumeInfo.Mountpoint) {
        console.log(`📂 [Volume] Volume 挂载点: ${volumeInfo.Mountpoint}`);
      }
      
      // 迁移旧 session 文件到 volume
      await migrateSessionFilesToVolume(docker, volumeName);
      
      return volumeInfo; // 返回 volume 信息，而不仅仅是名称
    } catch (createError) {
      console.error(`❌ [多开登录] 创建 Volume 失败: ${createError.message}`);
      throw createError;
    }
  }
}

// 获取用于临时容器的镜像名称（优先使用 alpine:latest，如果不存在则使用 telethon 镜像）
async function getTempContainerImage(docker) {
  try {
    // 先尝试使用 alpine:latest（更轻量）
    const alpineImg = docker.getImage('alpine:latest');
    await alpineImg.inspect();
    return 'alpine:latest';
  } catch (e) {
    // alpine:latest 不存在，尝试查找 telethon 镜像
    const images = await docker.listImages();
    for (const img of images) {
      const tags = img.RepoTags || [];
      for (const tag of tags) {
        if ((tag.includes('tg_listener') || tag.includes('telethon')) && !tag.includes('<none>')) {
          return tag;
        }
      }
    }
    // 如果都找不到，尝试使用 python:3.11-slim（作为最后的备选）
    try {
      const pythonImg = docker.getImage('python:3.11-slim');
      await pythonImg.inspect();
      return 'python:3.11-slim';
    } catch (e2) {
      throw new Error('无法找到可用的临时容器镜像（alpine:latest、telethon 或 python:3.11-slim）');
    }
  }
}

// 迁移旧 session 文件到 volume
async function migrateSessionFilesToVolume(docker, volumeName) {
  try {
    console.log(`📦 [多开登录] 开始迁移 session 文件到 volume...`);
    
    // 检查旧 session 目录
    const oldSessionDir = '/opt/telegram-monitor/data/session';
    if (!fs.existsSync(oldSessionDir)) {
      console.log(`ℹ️  [多开登录] 旧 session 目录不存在，跳过迁移`);
      return;
    }
    
    // 读取旧目录中的文件
    const oldFiles = fs.readdirSync(oldSessionDir);
    if (oldFiles.length === 0) {
      console.log(`ℹ️  [多开登录] 旧 session 目录为空，跳过迁移`);
      return;
    }
    
    // 创建一个临时容器来访问 volume 并复制文件
    const tempContainerName = `tg_session_migrate_${Date.now()}`;
    const containerImage = await getTempContainerImage(docker);
    
    try {
      // 创建临时容器
      const tempContainer = await docker.createContainer({
        Image: containerImage,
        name: tempContainerName,
        Cmd: ['sh', '-c', 'sleep 3600'], // 保持容器运行
        HostConfig: {
          Binds: [
            `${oldSessionDir}:/old_session:ro`,
            `${volumeName}:/new_session`
          ]
        }
      });
      
      await tempContainer.start();
      console.log(`✅ [多开登录] 已启动临时容器用于迁移`);
      
      // 在容器内复制文件
      const exec = await tempContainer.exec({
        Cmd: ['sh', '-c', 'cp -r /old_session/* /new_session/ 2>/dev/null || true'],
        AttachStdout: true,
        AttachStderr: true
      });
      
      const stream = await exec.start({ hijack: true, stdin: false });
      await new Promise((resolve, reject) => {
        let output = '';
        stream.on('data', (chunk) => {
          output += chunk.toString();
        });
        stream.on('end', () => {
          resolve(output);
        });
        stream.on('error', reject);
        
        setTimeout(() => {
          stream.destroy();
          resolve(output);
        }, 30000);
      });
      
      // 停止并删除临时容器
      await tempContainer.stop();
      await tempContainer.remove();
      
      console.log(`✅ [多开登录] 已迁移 ${oldFiles.length} 个文件到 volume`);
    } catch (migrateError) {
      console.warn(`⚠️  [多开登录] 迁移 session 文件失败: ${migrateError.message}`);
      // 清理临时容器（如果存在）
      try {
        const tempContainer = docker.getContainer(tempContainerName);
        await tempContainer.stop();
        await tempContainer.remove();
      } catch (e) {
        // 忽略清理错误
      }
    }
  } catch (error) {
    console.warn(`⚠️  [多开登录] 迁移 session 文件时出错: ${error.message}`);
  }
}

// 启动多开登录容器
async function startMultiLoginContainer(userId) {
  try {
    const Docker = require('dockerode');
    const dockerSocketPaths = [
      '/var/run/docker.sock',
      process.env.DOCKER_HOST?.replace('unix://', '') || null
    ].filter(Boolean);
    
    let docker = null;
    for (const socketPath of dockerSocketPaths) {
      if (fs.existsSync(socketPath)) {
        try {
          docker = new Docker({ socketPath });
          await docker.ping();
          break;
        } catch (e) {
          docker = null;
        }
      }
    }
    
    if (!docker) {
      throw new Error('无法连接到 Docker daemon');
    }
    
    // 获取或创建 session volume
    // 使用目录挂载方式，不再使用 volume
    const PROJECT_ROOT = process.env.PROJECT_ROOT || '/opt/telegram-monitor';
    const sessionHostPath = path.join(PROJECT_ROOT, 'data', 'session');
    const sessionContainerPath = '/opt/telegram-monitor/data/session';
    
    // 确保 session 目录存在
    if (!fs.existsSync(sessionHostPath)) {
      fs.mkdirSync(sessionHostPath, { recursive: true });
      console.log(`✅ [多开登录] 已创建 session 目录: ${sessionHostPath}`);
    }
    
    // 加载用户配置以获取 API_ID 和 API_HASH
    const userConfig = await loadUserConfig(userId.toString());
    const configObj = userConfig.toObject ? userConfig.toObject() : userConfig;
    
    const containerName = `tg_listener_${userId}`;
    
    // 使用 docker-compose.yml 中定义的固定网络名称 tg-network
    const networkName = 'tg-network';
    console.log(`🔗 [多开登录] 使用网络: ${networkName}`);
    
    // 使用固定 tag（与 docker compose build 输出一致），避免误选到旧镜像
    let containerImage = getDesiredTelethonImageName();
    let desiredImageId = null;
    try {
      const desiredImgInfo = await docker.getImage(containerImage).inspect();
      desiredImageId = desiredImgInfo?.Id || null;
      console.log(`🔍 [多开登录] 目标 Telethon 镜像: ${containerImage} (${desiredImageId || 'unknown'})`);
    } catch (e) {
      console.warn(`⚠️  [多开登录] 无法 inspect Telethon 镜像 ${containerImage}: ${e.message}，将回退到自动搜索`);
      containerImage = null;
    }

    // 回退：自动搜索一个可用的 telethon 镜像 tag
    if (!containerImage) {
      const images = await docker.listImages();
      for (const img of images) {
        const tags = img.RepoTags || [];
        for (const tag of tags) {
          if ((tag.includes('tg_listener') || tag.includes('telethon')) && !tag.includes('<none>')) {
            containerImage = tag;
            break;
          }
        }
        if (containerImage) break;
      }
      if (!containerImage) throw new Error('无法找到 Telethon 镜像');
      try {
        const desiredImgInfo = await docker.getImage(containerImage).inspect();
        desiredImageId = desiredImgInfo?.Id || null;
        console.log(`🔍 [多开登录] 回退选中 Telethon 镜像: ${containerImage} (${desiredImageId || 'unknown'})`);
      } catch (e) {
        desiredImageId = null;
      }
    }
    
    // 准备环境变量（提升到函数作用域，以便在错误处理中使用）
    // 注意：monitor.py的逻辑：
    // 1. active_user_id = cfg.get("user_id") or USER_ID
    // 2. 如果active_user_id存在，session文件是 SESSION_PREFIX_{active_user_id}
    // 3. 否则直接使用 SESSION_PREFIX
    // 
    // 多开模式：
    //   - SESSION_PREFIX 应该设置为 "user"（固定值）
    //   - USER_ID 设置为 userId
    //   - monitor.py 会自动使用 user_{USER_ID} 作为 session 文件名
    //   - 实际文件：data/session/user_${userId}.session
    const envVars = {
      MONGO_URL: process.env.MONGO_URL || 'mongodb://mongo:27017/tglogs',
      API_URL: process.env.API_URL || 'http://api:3000',
      CONFIG_PATH: `/app/config_${userId}.json`,
      // 多开模式：SESSION_PREFIX 固定为 "user"
      // monitor.py 会根据 USER_ID 自动构建 session 文件名为 user_{USER_ID}
      SESSION_PREFIX: 'user',
      // 与后端一致的内部访问令牌：用于访问 /api/internal/*，否则在开启 INTERNAL_API_TOKEN 后会被 403 拒绝
      ...(INTERNAL_API_TOKEN ? { INTERNAL_API_TOKEN } : {}),
      // 从用户配置中读取 API_ID 和 API_HASH（配置文件已包含这些信息）
      // 如果配置文件中没有，则从环境变量读取（向后兼容）
      API_ID: (configObj.telegram && configObj.telegram.api_id) ? String(configObj.telegram.api_id) : (process.env.API_ID || '0'),
      API_HASH: (configObj.telegram && configObj.telegram.api_hash) ? configObj.telegram.api_hash : (process.env.API_HASH || ''),
      // USER_ID环境变量用于从后端API获取用户配置，同时用于构建session路径
      USER_ID: userId
    };
    
    // 先执行 session 文件迁移（无论容器是否存在都需要检查）
    // 注意：session文件路径说明
    // 单开模式：data/session/telegram.session 或 data/session/telegram_{userId}.session
    // 多开模式：data/session/user_${userId}.session
    // 路径不同，不会冲突
    // 注意：session 文件可能在 backend/data 目录下（容器内路径）或 data/session 目录下（宿主机路径）
    const sessionDir1 = path.join(__dirname, '..', 'data', 'session'); // 宿主机路径
    const sessionDir2 = path.join(__dirname, 'data'); // backend/data 路径
    const oldSessionFile1 = path.join(sessionDir1, 'telegram.session');
    const oldSessionFile2 = path.join(sessionDir1, `telegram_${userId}.session`);
    const oldSessionFile3 = path.join(sessionDir2, 'telegram.session');
    const oldSessionFile4 = path.join(sessionDir2, `telegram_${userId}.session`);
    const sessionFileName = `user_${userId}.session`;
    const sessionFile = path.join(sessionHostPath, sessionFileName);
    
    // 直接检查本地目录中是否已有 session 文件
    let sessionExists = false;
    
    console.log(`🔍 [多开登录] 检查目录中是否存在 session 文件: ${sessionFile}`);
    
    if (fs.existsSync(sessionFile)) {
      try {
        const stats = fs.statSync(sessionFile);
        if (stats.isFile() && stats.size > 0) {
          sessionExists = true;
          console.log(`✅ [多开登录] Session 文件已存在: ${sessionFile} (大小: ${stats.size} 字节)`);
        }
      } catch (err) {
        console.warn(`⚠️  [多开登录] 无法读取 session 文件: ${err.message}`);
      }
    }
    
    // 如果目录中没有 session 文件，且宿主机上有旧文件，则迁移
    if (!sessionExists) {
      console.log(`🔍 [多开登录] Volume 中没有 session 文件，开始查找源文件...`);
      let sourceFile = null;
      // 按优先级查找 session 文件
      console.log(`🔍 [多开登录] 检查路径1: ${oldSessionFile2} (存在: ${fs.existsSync(oldSessionFile2)})`);
      console.log(`🔍 [多开登录] 检查路径2: ${oldSessionFile4} (存在: ${fs.existsSync(oldSessionFile4)})`);
      console.log(`🔍 [多开登录] 检查路径3: ${oldSessionFile1} (存在: ${fs.existsSync(oldSessionFile1)})`);
      console.log(`🔍 [多开登录] 检查路径4: ${oldSessionFile3} (存在: ${fs.existsSync(oldSessionFile3)})`);
      
      if (fs.existsSync(oldSessionFile2)) {
        sourceFile = oldSessionFile2;
        console.log(`✅ [多开登录] 找到 session 文件: ${oldSessionFile2}`);
      } else if (fs.existsSync(oldSessionFile4)) {
        sourceFile = oldSessionFile4;
        console.log(`✅ [多开登录] 找到 session 文件: ${oldSessionFile4}`);
      } else if (fs.existsSync(oldSessionFile1)) {
        sourceFile = oldSessionFile1;
        console.log(`✅ [多开登录] 找到 session 文件: ${oldSessionFile1}`);
      } else if (fs.existsSync(oldSessionFile3)) {
        sourceFile = oldSessionFile3;
        console.log(`✅ [多开登录] 找到 session 文件: ${oldSessionFile3}`);
      }
      
      // 如果还是没找到，尝试查找所有 .session 文件
      if (!sourceFile) {
        console.log(`🔍 [多开登录] 标准路径未找到，搜索所有 .session 文件...`);
        const searchDirs = [sessionDir1, sessionDir2];
        for (const dir of searchDirs) {
          if (fs.existsSync(dir)) {
            try {
              const files = fs.readdirSync(dir);
              console.log(`🔍 [多开登录] 目录 ${dir} 中的文件: ${files.join(', ')}`);
              const sessionFiles = files.filter(f => f.endsWith('.session') && !f.includes('restore'));
              if (sessionFiles.length > 0) {
                // 优先使用包含 userId 的文件，否则使用第一个
                const userIdFile = sessionFiles.find(f => f.includes(userId));
                sourceFile = userIdFile ? path.join(dir, userIdFile) : path.join(dir, sessionFiles[0]);
                console.log(`📦 [多开登录] 找到 session 文件: ${sourceFile}`);
                break;
              }
            } catch (e) {
              console.warn(`⚠️  [多开登录] 读取目录 ${dir} 失败: ${e.message}`);
            }
          } else {
            console.log(`⚠️  [多开登录] 目录不存在: ${dir}`);
          }
        }
      }
      
      if (!sourceFile) {
        console.warn(`⚠️  [多开登录] 未找到任何 session 文件，多开容器可能需要重新登录`);
      } else {
        // 直接复制文件到目标目录
        try {
          fs.copyFileSync(sourceFile, sessionFile);
          console.log(`✅ [多开登录] 已迁移 session 文件: ${path.basename(sourceFile)} -> ${sessionFileName}`);
          
          // 验证文件是否成功复制
          if (fs.existsSync(sessionFile)) {
            const stats = fs.statSync(sessionFile);
            if (stats.isFile() && stats.size > 0) {
              console.log(`✅ [多开登录] 验证成功：session 文件已存在 (大小: ${stats.size} 字节)`);
            } else {
              console.warn(`⚠️  [多开登录] 验证失败：session 文件大小异常`);
            }
          } else {
            console.warn(`⚠️  [多开登录] 验证失败：session 文件不存在`);
          }
        } catch (migrateError) {
          console.warn(`⚠️  [多开登录] 迁移 session 文件失败: ${migrateError.message}`);
        }
      }
    } else {
      console.log(`✅ [多开登录] 目录中已存在 session 文件，跳过迁移`);
    }
    
    // 在检查容器之前，先确保宿主机上的配置文件是文件而不是目录
    // 注意：后端容器挂载 ./backend:/app，所以 __dirname 在容器内是 /app
    // 写入文件时使用 __dirname（会写入到挂载的目录，即宿主机 ./backend）
    // 但挂载容器时需要宿主机的绝对路径
    const projectRoot = process.env.PROJECT_ROOT || '/opt/telegram-monitor';
    const hostConfigPath = path.join(__dirname, `config_${userId}.json`);
    // 计算宿主机的绝对路径用于挂载
    const hostConfigPathForMount = path.join(projectRoot, 'backend', `config_${userId}.json`);
    
    // 强制检查并修复配置文件
    let needDeleteContainerForConfig = false;
    if (fs.existsSync(hostConfigPath)) {
      const configStats = fs.statSync(hostConfigPath);
      if (configStats.isDirectory()) {
        console.error(`❌ [多开登录] 检测到配置文件路径是目录: ${hostConfigPath}`);
        console.error(`   正在删除错误的目录并重新创建文件...`);
        try {
          fs.rmSync(hostConfigPath, { recursive: true, force: true });
          console.log(`✅ [多开登录] 已删除错误的目录: ${hostConfigPath}`);
          
          // 重新创建配置文件
          const userConfig = await loadUserConfig(userId.toString());
          const configObj = userConfig.toObject ? userConfig.toObject() : userConfig;
          
          const userConfigData = {
            user_id: userId.toString(),
            keywords: Array.isArray(configObj.keywords) ? configObj.keywords : [],
            channels: Array.isArray(configObj.channels) ? configObj.channels : [],
            alert_keywords: Array.isArray(configObj.alert_keywords) ? configObj.alert_keywords : [],
            alert_regex: Array.isArray(configObj.alert_regex) ? configObj.alert_regex : [],
            log_all_messages: configObj.log_all_messages || false,
            alert_target: configObj.alert_target || ''
          };
          
          if (configObj.telegram && configObj.telegram.api_id && configObj.telegram.api_hash) {
            userConfigData.telegram = {
              api_id: configObj.telegram.api_id,
              api_hash: configObj.telegram.api_hash
            };
          }
          
          if (configObj.ai_analysis) {
            userConfigData.ai_analysis = {
              enabled: configObj.ai_analysis.enabled || false,
              ai_trigger_enabled: configObj.ai_analysis.ai_trigger_enabled || false,
              ai_trigger_users: Array.isArray(configObj.ai_analysis.ai_trigger_users) 
                ? configObj.ai_analysis.ai_trigger_users 
                : [],
              ai_trigger_prompt: configObj.ai_analysis.ai_trigger_prompt || ''
            };
          }
          
          fs.writeFileSync(hostConfigPath, JSON.stringify(userConfigData, null, 2));
          console.log(`✅ [多开登录] 已重新创建配置文件: ${hostConfigPath}`);
          
          // 标记需要删除容器（因为挂载是静态的，需要重新创建容器才能应用新挂载）
          needDeleteContainerForConfig = true;
          console.log(`🗑️  [多开登录] 配置文件从目录修复为文件，需要删除容器并重新创建以应用新挂载...`);
        } catch (rmError) {
          console.error(`❌ [多开登录] 删除目录失败: ${rmError.message}`);
          throw new Error(`配置文件路径是目录且无法删除: ${hostConfigPath}`);
        }
      }
    }
    
    // 检查容器是否已存在
    let container = null;
    let needRecreate = false;
    try {
      container = docker.getContainer(containerName);
      const containerInfo = await container.inspect();
      console.log(`📦 [多开登录] 容器 ${containerName} 已存在`);

      // 如果镜像已更新（同 tag 新 build），必须删除重建，否则容器仍使用旧 imageId
      if (desiredImageId && containerInfo?.Image && containerInfo.Image !== desiredImageId) {
        console.log(`🔄 [多开登录] 检测到镜像更新，需要重建容器 ${containerName}`);
        console.log(`   - 旧: ${containerInfo.Image}`);
        console.log(`   - 新: ${desiredImageId}`);
        try {
          if (containerInfo.State && (containerInfo.State.Running || containerInfo.State.Restarting)) {
            await container.stop({ t: 10 });
          }
          await container.remove();
          console.log(`✅ [多开登录] 已删除旧镜像容器 ${containerName}，准备重建`);
          needRecreate = true;
          container = null;
        } catch (removeError) {
          console.error(`❌ [多开登录] 删除旧镜像容器失败: ${removeError.message}`);
          // 不抛出，后续仍会尝试继续
        }
      }
      
      // 如果配置文件从目录修复为文件，需要删除容器并重新创建
      if (needDeleteContainerForConfig) {
        console.log(`🗑️  [多开登录] 配置文件已修复，删除容器 ${containerName} 以重新创建（应用新挂载）...`);
        try {
          if (containerInfo.State && containerInfo.State.Running) {
            await container.stop({ t: 10 });
          }
          await container.remove();
          console.log(`✅ [多开登录] 已删除容器 ${containerName}`);
          container = null; // 标记需要重新创建
          needRecreate = true;
        } catch (removeError) {
          console.error(`❌ [多开登录] 删除容器失败: ${removeError.message}`);
          throw new Error(`无法删除容器以修复配置文件挂载: ${removeError.message}`);
        }
      }
      
      // 检查容器的网络配置是否正确
      if (containerInfo.NetworkSettings && containerInfo.NetworkSettings.Networks) {
        const connectedNetworks = Object.keys(containerInfo.NetworkSettings.Networks);
        const isOnCorrectNetwork = connectedNetworks.some(n => 
          n === networkName || 
          n.includes('telegram-monitor') && n.includes('tg-network')
        );
        if (!isOnCorrectNetwork && connectedNetworks.length > 0) {
          console.warn(`⚠️  [多开登录] 容器连接到错误的网络: ${connectedNetworks.join(', ')}，预期: ${networkName}`);
          console.log(`🗑️  [多开登录] 将删除旧容器并重新创建以修复网络配置...`);
          try {
            if (containerInfo.State.Running) {
              await container.stop();
            }
            await container.remove();
            needRecreate = true;
            container = null;
          } catch (removeError) {
            console.warn(`⚠️  [多开登录] 删除旧容器失败: ${removeError.message}`);
          }
        } else if (isOnCorrectNetwork) {
          console.log(`✅ [多开登录] 容器已连接到正确网络: ${connectedNetworks.find(n => n === networkName || n.includes('telegram-monitor'))}`);
        }
      } else {
        console.warn(`⚠️  [多开登录] 容器网络配置异常，将重新创建...`);
        try {
          if (containerInfo.State.Running) {
            await container.stop();
          }
          await container.remove();
          needRecreate = true;
          container = null;
        } catch (removeError) {
          console.warn(`⚠️  [多开登录] 删除旧容器失败: ${removeError.message}`);
        }
      }
      
      // 检查容器的环境变量是否正确（特别是 SESSION_PREFIX）
      if (!needRecreate && containerInfo.Config && containerInfo.Config.Env) {
        const envVars = containerInfo.Config.Env;
        const sessionPrefixEnv = envVars.find(env => env.startsWith('SESSION_PREFIX='));
        if (sessionPrefixEnv) {
          const currentSessionPrefix = sessionPrefixEnv.split('=')[1];
          if (currentSessionPrefix !== 'user') {
            console.warn(`⚠️  [多开登录] 容器使用错误的 SESSION_PREFIX: ${currentSessionPrefix}，应该是 "user"`);
            console.log(`🗑️  [多开登录] 将删除旧容器并重新创建以修复环境变量...`);
            try {
              if (containerInfo.State.Running) {
                await container.stop();
              }
              await container.remove();
              needRecreate = true;
              container = null;
            } catch (removeError) {
              console.warn(`⚠️  [多开登录] 删除旧容器失败: ${removeError.message}`);
            }
          }
        } else {
          console.warn(`⚠️  [多开登录] 容器缺少 SESSION_PREFIX 环境变量，将重新创建...`);
          try {
            if (containerInfo.State.Running) {
              await container.stop();
            }
            await container.remove();
            needRecreate = true;
            container = null;
          } catch (removeError) {
            console.warn(`⚠️  [多开登录] 删除旧容器失败: ${removeError.message}`);
          }
        }
      }
      
      // 检查容器的挂载配置是否正确
      // 如果使用的是 bind mount 而不是 volume，需要重新创建
      // 检查是否错误地挂载了 /app 目录（会导致只读文件系统问题）
      if (!needRecreate && containerInfo.Mounts && containerInfo.Mounts.length > 0) {
        for (const mount of containerInfo.Mounts) {
          // 检查是否错误地挂载了整个 /app 目录（这会导致只读文件系统问题）
          if (mount.Destination === '/app' && mount.Source && !mount.Source.includes('/var/lib/docker/volumes/')) {
            console.warn(`⚠️  [多开登录] 检测到容器错误地挂载了 /app 目录: ${mount.Source} (会导致只读文件系统问题)`);
            console.log(`🗑️  [多开登录] 将删除旧容器并重新创建...`);
            try {
              if (containerInfo.State.Running) {
                await container.stop();
              }
              await container.remove();
              needRecreate = true;
              container = null;
            } catch (removeError) {
              console.warn(`⚠️  [多开登录] 删除旧容器失败: ${removeError.message}`);
            }
            break;
          }
          
          if (mount.Destination === '/app/session' || mount.Destination === '/app/session_data' || mount.Destination === '/tmp/session_volume' || mount.Destination === sessionContainerPath) {
            // 检查挂载目标路径是否正确（应该是 /opt/telegram-monitor/data/session）
            if (mount.Destination !== sessionContainerPath) {
              console.warn(`⚠️  [多开登录] 检测到容器使用错误的挂载路径: ${mount.Destination} (应该是 ${sessionContainerPath})`);
              console.log(`🗑️  [多开登录] 将删除旧容器并重新创建...`);
              try {
                if (containerInfo.State.Running) {
                  await container.stop();
                }
                await container.remove();
                needRecreate = true;
                container = null;
              } catch (removeError) {
                console.warn(`⚠️  [多开登录] 删除旧容器失败: ${removeError.message}`);
                // 继续尝试创建新容器，可能会因为名称冲突而失败
              }
              break;
            }
            // 检查是否使用正确的目录挂载（Source 应该是宿主机路径）
            const isCorrectBindMount = mount.Source && (
              mount.Source === sessionHostPath ||
              mount.Source.includes('data/session')
            );
            
            if (!isCorrectBindMount) {
              console.warn(`⚠️  [多开登录] 检测到容器使用错误的挂载方式: ${mount.Source} (应该是 ${sessionHostPath})`);
              console.log(`🗑️  [多开登录] 将删除旧容器并重新创建...`);
              try {
                if (containerInfo.State.Running) {
                  await container.stop();
                }
                await container.remove();
                needRecreate = true;
                container = null;
              } catch (removeError) {
                console.warn(`⚠️  [多开登录] 删除旧容器失败: ${removeError.message}`);
                // 继续尝试创建新容器，可能会因为名称冲突而失败
              }
              break;
            }
          }
        }
      }
    } catch (e) {
      // 容器不存在，需要创建
      console.log(`📦 [多开登录] 容器 ${containerName} 不存在，准备创建...`);
      container = null;
    }
    
    if (!container || needRecreate) {
      // 查找Telethon镜像
      const images = await docker.listImages();
      let containerImage = null;
      for (const img of images) {
        const tags = img.RepoTags || [];
        for (const tag of tags) {
          if ((tag.includes('tg_listener') || tag.includes('telethon')) && !tag.includes('<none>')) {
            containerImage = tag;
            break;
          }
        }
        if (containerImage) break;
      }
      
      if (!containerImage) {
        // 尝试从docker-compose获取镜像名
        const possibleNames = [
          'tgjiankong-tg_listener',
          'telethon',
          'tg_listener'
        ];
        for (const name of possibleNames) {
          try {
            const img = docker.getImage(name);
            await img.inspect();
            containerImage = name;
            break;
          } catch (e) {
            // 继续查找
          }
        }
      }
      
      if (!containerImage) {
        throw new Error('无法找到 Telethon 镜像');
      }
      
      // 注意：session文件路径说明
      // 单开模式：data/session/telegram.session 或 data/session/telegram_{userId}.session
      // 多开模式：data/session/user_${userId}.session
      // 路径不同，不会冲突
      
      // 检查是否有旧的session文件需要迁移到 volume
      // 如果用户之前使用单开模式，session文件可能是 data/session/telegram.session 或 data/session/telegram_{userId}.session
      // 开启多开后，需要迁移到 volume 中的 user_${userId}.session
      // 注意：session 文件可能在 backend/data 目录下（容器内路径）或 data/session 目录下（宿主机路径）
      const sessionDir1 = path.join(__dirname, '..', 'data', 'session'); // 宿主机路径
      const sessionDir2 = path.join(__dirname, 'data'); // backend/data 路径
      const oldSessionFile1 = path.join(sessionDir1, 'telegram.session');
      const oldSessionFile2 = path.join(sessionDir1, `telegram_${userId}.session`);
      const oldSessionFile3 = path.join(sessionDir2, 'telegram.session');
      const oldSessionFile4 = path.join(sessionDir2, `telegram_${userId}.session`);
      const targetSessionFile = path.join(sessionHostPath, `user_${userId}.session`);
      
      // 直接检查本地目录中是否已有 session 文件
      let sessionExists = false;
      
      console.log(`🔍 [多开登录] 检查目录中是否存在 session 文件: ${targetSessionFile}`);
      
      if (fs.existsSync(targetSessionFile)) {
        try {
          const stats = fs.statSync(targetSessionFile);
          if (stats.isFile() && stats.size > 0) {
            sessionExists = true;
            console.log(`✅ [多开登录] Session 文件已存在: ${targetSessionFile} (大小: ${stats.size} 字节)`);
          }
        } catch (err) {
          console.warn(`⚠️  [多开登录] 无法读取 session 文件: ${err.message}`);
        }
      }
      
      // 如果目录中没有 session 文件，且宿主机上有旧文件，则迁移
      if (!sessionExists) {
        console.log(`🔍 [多开登录] 目录中没有 session 文件，开始查找源文件...`);
        let sourceFile = null;
        // 按优先级查找 session 文件
        console.log(`🔍 [多开登录] 检查路径1: ${oldSessionFile2} (存在: ${fs.existsSync(oldSessionFile2)})`);
        console.log(`🔍 [多开登录] 检查路径2: ${oldSessionFile4} (存在: ${fs.existsSync(oldSessionFile4)})`);
        console.log(`🔍 [多开登录] 检查路径3: ${oldSessionFile1} (存在: ${fs.existsSync(oldSessionFile1)})`);
        console.log(`🔍 [多开登录] 检查路径4: ${oldSessionFile3} (存在: ${fs.existsSync(oldSessionFile3)})`);
        
        if (fs.existsSync(oldSessionFile2)) {
          sourceFile = oldSessionFile2;
          console.log(`✅ [多开登录] 找到 session 文件: ${oldSessionFile2}`);
        } else if (fs.existsSync(oldSessionFile4)) {
          sourceFile = oldSessionFile4;
          console.log(`✅ [多开登录] 找到 session 文件: ${oldSessionFile4}`);
        } else if (fs.existsSync(oldSessionFile1)) {
          sourceFile = oldSessionFile1;
          console.log(`✅ [多开登录] 找到 session 文件: ${oldSessionFile1}`);
        } else if (fs.existsSync(oldSessionFile3)) {
          sourceFile = oldSessionFile3;
          console.log(`✅ [多开登录] 找到 session 文件: ${oldSessionFile3}`);
        }
        
        // 如果还是没找到，尝试查找所有 .session 文件
        if (!sourceFile) {
          console.log(`🔍 [多开登录] 标准路径未找到，搜索所有 .session 文件...`);
          const searchDirs = [sessionDir1, sessionDir2];
          for (const dir of searchDirs) {
            if (fs.existsSync(dir)) {
              try {
                const files = fs.readdirSync(dir);
                console.log(`🔍 [多开登录] 目录 ${dir} 中的文件: ${files.join(', ')}`);
                const sessionFiles = files.filter(f => f.endsWith('.session') && !f.includes('restore'));
                if (sessionFiles.length > 0) {
                  // 优先使用包含 userId 的文件，否则使用第一个
                  const userIdFile = sessionFiles.find(f => f.includes(userId));
                  sourceFile = userIdFile ? path.join(dir, userIdFile) : path.join(dir, sessionFiles[0]);
                  console.log(`📦 [多开登录] 找到 session 文件: ${sourceFile}`);
                  break;
                }
              } catch (e) {
                console.warn(`⚠️  [多开登录] 读取目录 ${dir} 失败: ${e.message}`);
              }
            } else {
              console.log(`⚠️  [多开登录] 目录不存在: ${dir}`);
            }
          }
        }
        
        if (!sourceFile) {
          console.warn(`⚠️  [多开登录] 未找到任何 session 文件，多开容器可能需要重新登录`);
        }
        
        if (sourceFile) {
          try {
            // 直接复制文件到目标目录
            fs.copyFileSync(sourceFile, targetSessionFile);
            console.log(`✅ [多开登录] 已迁移 session 文件: ${path.basename(sourceFile)} -> user_${userId}.session`);
            
            // 验证文件是否成功复制
            if (fs.existsSync(targetSessionFile)) {
              const stats = fs.statSync(targetSessionFile);
              if (stats.isFile() && stats.size > 0) {
                console.log(`✅ [多开登录] 验证成功：session 文件已存在 (大小: ${stats.size} 字节)`);
              } else {
                console.warn(`⚠️  [多开登录] 验证失败：session 文件大小异常`);
              }
            } else {
              console.warn(`⚠️  [多开登录] 验证失败：session 文件不存在`);
            }
          } catch (migrateError) {
            console.warn(`⚠️  [多开登录] 迁移 session 文件失败: ${migrateError.message}`);
          }
        }
      }
      
      
      // 固定使用项目根目录路径
      const projectRoot = process.env.PROJECT_ROOT || '/opt/telegram-monitor';
      
      // 构建配置文件路径
      // 注意：后端容器挂载 ./backend:/app，所以 __dirname 在容器内是 /app
      // 写入文件时使用 __dirname（会写入到挂载的目录，即宿主机 ./backend）
      // 但挂载容器时需要宿主机的绝对路径
      const hostConfigPath = path.join(__dirname, `config_${userId}.json`);
      const hostConfigPathForMount = path.join(projectRoot, 'backend', `config_${userId}.json`);
      const hostLogsPath = path.join(projectRoot, 'logs', 'telethon');
      
      // 确保配置文件存在（如果不存在，重新创建）
      // 检查路径是否是目录（不应该发生，但如果发生需要修复）
      if (fs.existsSync(hostConfigPath) && fs.statSync(hostConfigPath).isDirectory()) {
        console.error(`❌ [多开登录] 配置文件路径是目录而不是文件: ${hostConfigPath}`);
        console.error(`   正在删除错误的目录并重新创建文件...`);
        try {
          fs.rmSync(hostConfigPath, { recursive: true, force: true });
          console.log(`✅ [多开登录] 已删除错误的目录: ${hostConfigPath}`);
        } catch (rmError) {
          console.error(`❌ [多开登录] 删除目录失败: ${rmError.message}`);
          throw new Error(`配置文件路径是目录且无法删除: ${hostConfigPath}`);
        }
      }
      
      if (!fs.existsSync(hostConfigPath)) {
        console.warn(`⚠️  [多开登录] 配置文件不存在: ${hostConfigPath}，重新创建...`);
        const userConfig = await loadUserConfig(userId.toString());
        const configObj = userConfig.toObject ? userConfig.toObject() : userConfig;
        
        const userConfigData = {
          user_id: userId.toString(),
          keywords: Array.isArray(configObj.keywords) ? configObj.keywords : [],
          channels: Array.isArray(configObj.channels) ? configObj.channels : [],
          alert_keywords: Array.isArray(configObj.alert_keywords) ? configObj.alert_keywords : [],
          alert_regex: Array.isArray(configObj.alert_regex) ? configObj.alert_regex : [],
          log_all_messages: configObj.log_all_messages || false,
          alert_target: configObj.alert_target || ''
        };
        
        if (configObj.telegram && configObj.telegram.api_id && configObj.telegram.api_hash) {
          userConfigData.telegram = {
            api_id: configObj.telegram.api_id,
            api_hash: configObj.telegram.api_hash
          };
        }
        
        if (configObj.ai_analysis) {
          userConfigData.ai_analysis = {
            enabled: configObj.ai_analysis.enabled || false,
            ai_trigger_enabled: configObj.ai_analysis.ai_trigger_enabled || false,
            ai_trigger_users: Array.isArray(configObj.ai_analysis.ai_trigger_users) 
              ? configObj.ai_analysis.ai_trigger_users 
              : [],
            ai_trigger_prompt: configObj.ai_analysis.ai_trigger_prompt || ''
          };
        }
        
        // 确保目录存在
        const hostConfigDir = path.dirname(hostConfigPath);
        if (!fs.existsSync(hostConfigDir)) {
          fs.mkdirSync(hostConfigDir, { recursive: true });
          console.log(`✅ [多开登录] 已创建配置目录: ${hostConfigDir}`);
        }
        
        fs.writeFileSync(hostConfigPath, JSON.stringify(userConfigData, null, 2));
        console.log(`✅ [多开登录] 已重新创建配置文件: ${hostConfigPath}`);
      }
      
      // 验证配置文件是文件而不是目录
      const configStats = fs.statSync(hostConfigPath);
      if (!configStats.isFile()) {
        throw new Error(`配置文件 ${hostConfigPath} 是目录而非文件，请删除该目录后重试`);
      }
      
      console.log(`📂 [多开登录] 使用项目根目录: ${projectRoot}`);
      console.log(`📂 [多开登录] 挂载路径: config=${hostConfigPathForMount}:/app/config_${userId}.json:ro, session=${sessionHostPath}:${sessionContainerPath}:rw, logs=${hostLogsPath}`);
      
      // 创建容器
      // 注意：代码在镜像中（通过 Dockerfile COPY），不需要挂载代码目录
      // 只挂载配置文件、session 目录和 logs 目录
      // 配置文件挂载到 /app/config_${userId}.json，通过 CONFIG_PATH 环境变量指定
      
      // 确保 SESSION_PREFIX 正确设置为 'user'
      if (envVars.SESSION_PREFIX !== 'user') {
        console.warn(`⚠️  [多开登录] 检测到 envVars.SESSION_PREFIX 错误: ${envVars.SESSION_PREFIX}，正在修正为 'user'`);
        envVars.SESSION_PREFIX = 'user';
      }
      
      const envArray = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);
      console.log(`🔍 [多开登录] 创建容器环境变量: SESSION_PREFIX=${envVars.SESSION_PREFIX}, USER_ID=${envVars.USER_ID}`);
      
      container = await docker.createContainer({
        Image: containerImage,
        name: containerName,
        Env: envArray,
        HostConfig: {
          Binds: [
            `${hostConfigPathForMount}:/app/config_${userId}.json:ro`,
            `${sessionHostPath}:${sessionContainerPath}:rw`,
            `${hostLogsPath}:/app/logs:rw`
          ],
          NetworkMode: networkName,
          RestartPolicy: { Name: 'unless-stopped' }
        }
      });
      
      console.log(`✅ [多开登录] 已创建容器 ${containerName}`);
      
      // 验证容器的环境变量是否正确
      let containerValid = false;
      let retryCount = 0;
      const maxRetries = 2; // 最多重试2次，避免无限循环
      
      while (!containerValid && retryCount < maxRetries) {
        try {
          const createdContainerInfo = await container.inspect();
          if (createdContainerInfo.Config && createdContainerInfo.Config.Env) {
            const sessionPrefixEnv = createdContainerInfo.Config.Env.find(env => env.startsWith('SESSION_PREFIX='));
            if (sessionPrefixEnv) {
              const actualSessionPrefix = sessionPrefixEnv.split('=')[1];
              if (actualSessionPrefix !== 'user') {
                console.error(`❌ [多开登录] 容器创建后验证失败：SESSION_PREFIX=${actualSessionPrefix}，应该是 'user'`);
                if (retryCount < maxRetries - 1) {
                  console.log(`🗑️  [多开登录] 删除错误容器并重新创建 (重试 ${retryCount + 1}/${maxRetries})...`);
                  await container.remove({ force: true });
                  container = null;
                  // 重新创建容器
                  container = await docker.createContainer({
                    Image: containerImage,
                    name: containerName,
                    Env: envArray,
                    HostConfig: {
                      Binds: [
                        `${hostConfigPathForMount}:/app/config_${userId}.json:ro`,
                        `${sessionHostPath}:${sessionContainerPath}:rw`,
                        `${hostLogsPath}:/app/logs:rw`
                      ],
                      NetworkMode: networkName,
                      RestartPolicy: { Name: 'unless-stopped' }
                    }
                  });
                  console.log(`✅ [多开登录] 已重新创建容器 ${containerName}`);
                  retryCount++;
                  continue;
                } else {
                  throw new Error(`容器环境变量设置错误，已重试 ${maxRetries} 次仍失败`);
                }
              } else {
                console.log(`✅ [多开登录] 容器环境变量验证通过：SESSION_PREFIX=${actualSessionPrefix}`);
                containerValid = true;
              }
            } else {
              console.error(`❌ [多开登录] 容器创建后验证失败：缺少 SESSION_PREFIX 环境变量`);
              if (retryCount < maxRetries - 1) {
                console.log(`🗑️  [多开登录] 删除错误容器并重新创建 (重试 ${retryCount + 1}/${maxRetries})...`);
                await container.remove({ force: true });
                container = null;
                // 重新创建容器
                container = await docker.createContainer({
                  Image: containerImage,
                  name: containerName,
                  Env: envArray,
                  HostConfig: {
                    Binds: [
                      `${hostConfigPath}:/app/config_${userId}.json:ro`,
                      `${sessionHostPath}:${sessionContainerPath}:rw`,
                      `${hostLogsPath}:/app/logs:rw`
                    ],
                    NetworkMode: networkName,
                    RestartPolicy: { Name: 'unless-stopped' }
                  }
                });
                console.log(`✅ [多开登录] 已重新创建容器 ${containerName}`);
                retryCount++;
                continue;
              } else {
                throw new Error(`容器缺少 SESSION_PREFIX 环境变量，已重试 ${maxRetries} 次仍失败`);
              }
            }
          } else {
            console.warn(`⚠️  [多开登录] 无法验证容器环境变量：Config.Env 不存在`);
            containerValid = true; // 如果无法验证，假设容器正确
          }
        } catch (verifyError) {
          if (retryCount < maxRetries - 1 && verifyError.message.includes('No such container')) {
            // 容器已被删除，重新创建
            console.log(`🔄 [多开登录] 容器已被删除，重新创建...`);
            container = await docker.createContainer({
              Image: containerImage,
              name: containerName,
              Env: envArray,
              HostConfig: {
                Binds: [
                  `${hostConfigPath}:/app/config_${userId}.json:ro`,
                  `${sessionHostPath}:${sessionContainerPath}:rw`,
                  `${hostLogsPath}:/app/logs:rw`
                ],
                NetworkMode: networkName,
                RestartPolicy: { Name: 'unless-stopped' }
              }
            });
            console.log(`✅ [多开登录] 已重新创建容器 ${containerName}`);
            retryCount++;
            continue;
          } else {
            throw verifyError;
          }
        }
      }
    }
    
    // 启动或重启容器前，强制检查并修复配置文件
    // 确保配置文件是文件而不是目录
    let needRecreateContainer = false;
    if (fs.existsSync(hostConfigPath)) {
      const configStats = fs.statSync(hostConfigPath);
      if (configStats.isDirectory()) {
        console.error(`❌ [多开登录] 检测到配置文件路径是目录: ${hostConfigPath}`);
        console.error(`   正在删除错误的目录并重新创建文件...`);
        try {
          fs.rmSync(hostConfigPath, { recursive: true, force: true });
          console.log(`✅ [多开登录] 已删除错误的目录: ${hostConfigPath}`);
          
          // 重新创建配置文件
          const userConfig = await loadUserConfig(userId.toString());
          const configObj = userConfig.toObject ? userConfig.toObject() : userConfig;
          
          const userConfigData = {
            user_id: userId.toString(),
            keywords: Array.isArray(configObj.keywords) ? configObj.keywords : [],
            channels: Array.isArray(configObj.channels) ? configObj.channels : [],
            alert_keywords: Array.isArray(configObj.alert_keywords) ? configObj.alert_keywords : [],
            alert_regex: Array.isArray(configObj.alert_regex) ? configObj.alert_regex : [],
            log_all_messages: configObj.log_all_messages || false,
            alert_target: configObj.alert_target || ''
          };
          
          if (configObj.telegram && configObj.telegram.api_id && configObj.telegram.api_hash) {
            userConfigData.telegram = {
              api_id: configObj.telegram.api_id,
              api_hash: configObj.telegram.api_hash
            };
          }
          
          if (configObj.ai_analysis) {
            userConfigData.ai_analysis = {
              enabled: configObj.ai_analysis.enabled || false,
              ai_trigger_enabled: configObj.ai_analysis.ai_trigger_enabled || false,
              ai_trigger_users: Array.isArray(configObj.ai_analysis.ai_trigger_users) 
                ? configObj.ai_analysis.ai_trigger_users 
                : [],
              ai_trigger_prompt: configObj.ai_analysis.ai_trigger_prompt || ''
            };
          }
          
          fs.writeFileSync(hostConfigPath, JSON.stringify(userConfigData, null, 2));
          console.log(`✅ [多开登录] 已重新创建配置文件: ${hostConfigPath}`);
          
          // 如果容器已存在，需要删除并重新创建（因为挂载是静态的）
          if (container) {
            console.log(`🗑️  [多开登录] 配置文件从目录修复为文件，需要删除容器并重新创建以应用新挂载...`);
            needRecreateContainer = true;
          }
        } catch (rmError) {
          console.error(`❌ [多开登录] 删除目录失败: ${rmError.message}`);
          throw new Error(`配置文件路径是目录且无法删除: ${hostConfigPath}`);
        }
      }
    }
    
    // 如果检测到配置文件是目录并已修复，删除容器并重新创建
    if (needRecreateContainer && container) {
      try {
        console.log(`🗑️  [多开登录] 删除容器 ${containerName} 以重新创建（修复配置文件挂载）...`);
        let currentContainerInfo = null;
        try {
          currentContainerInfo = await container.inspect();
        } catch (e) {
          // 容器可能已经不存在
        }
        if (currentContainerInfo && currentContainerInfo.State && currentContainerInfo.State.Running) {
          await container.stop({ t: 10 });
        }
        await container.remove();
        console.log(`✅ [多开登录] 已删除容器 ${containerName}`);
        container = null; // 标记需要重新创建
        needRecreate = true; // 标记需要重新创建容器
      } catch (removeError) {
        console.error(`❌ [多开登录] 删除容器失败: ${removeError.message}`);
        throw new Error(`无法删除容器以修复配置文件挂载: ${removeError.message}`);
      }
    }
    
    // 如果容器不存在或需要重新创建，创建新容器
    if (!container || needRecreate) {
      // 容器创建逻辑在之前的代码中，这里需要确保使用正确的 hostConfigPathForMount
      // 由于 container 变量已设置为 null，代码会继续执行到创建容器的部分
      console.log(`🔄 [多开登录] 容器不存在或已删除，准备重新创建...`);
      // 注意：容器创建逻辑在之前的代码块中，这里只是标记
    }
    
    // 启动或重启容器
    if (container) {
      const containerInfo = await container.inspect();
      if (containerInfo.State.Running) {
        console.log(`🔄 [多开登录] 容器 ${containerName} 正在运行，重启以应用新配置...`);
        try {
          await container.restart({ t: 10 });
          // 等待容器完全重启，确保旧进程完全关闭，session 文件解锁
          console.log(`⏳ [多开登录] 等待容器完全重启（确保 session 文件解锁）...`);
          await new Promise(resolve => setTimeout(resolve, 3000)); // 等待3秒
        } catch (restartError) {
          // 如果重启失败，可能是挂载配置有问题，删除容器并重新创建
          console.warn(`⚠️  [多开登录] 重启容器失败: ${restartError.message}`);
          console.log(`🗑️  [多开登录] 删除旧容器并重新创建...`);
          try {
            await container.stop({ t: 10 });
            await container.remove();
            throw new Error('需要重新创建容器');
          } catch (removeError) {
            throw new Error(`无法删除旧容器: ${removeError.message}`);
          }
        }
      } else {
        // 关键修复：容器存在但未运行（State=created），必须显式 start，否则会一直卡在 created
        console.log(`▶️  [多开登录] 容器 ${containerName} 当前状态为 ${containerInfo.State.Status}，尝试启动...`);
        await container.start();
      }
    } else {
      // 理论上这里不会发生（container 为 null 时前面会创建），保留兜底
      throw new Error('容器对象为空，无法启动（可能创建失败）');
    }
    
    console.log(`✅ [多开登录] 容器 ${containerName} 已请求启动`);

    const waited = await waitForContainerRunning(container, 20000);
    if (!waited.running) {
      console.warn(`⚠️  [多开登录] 容器 ${containerName} 未运行，状态: ${waited.status}`);
      return false;
    }

    console.log(`✅ [多开登录] 容器 ${containerName} 运行正常`);
    return true;
  } catch (error) {
    console.error(`❌ [多开登录] 启动容器失败:`, error);
    return false;
  }
}

// 安全执行 Docker 命令调用登录脚本（使用 Docker SDK）
// allowCreateTemp: 如果为 true，当容器未运行时，创建临时容器执行脚本
async function execTelethonLoginScript(command, args = [], retryCount = 0, allowCreateTemp = true, userId = null, reuseContainer = false) {
  const maxRetries = 3;
  const retryDelay = 1000; // 1秒（减少重试延迟）
  const timeout = 30000; // 30秒超时（减少超时时间，登录操作通常很快）
  
  try {
    // 如果 reuseContainer=true，直接使用临时登录容器，不尝试主容器
    if (userId && reuseContainer) {
      const existing = tempLoginContainers.get(userId);
      if (existing) {
        // 直接使用临时登录容器执行脚本
        console.log('♻️  使用临时登录容器执行脚本:', existing.containerName);
        try {
          return await execLoginScriptWithDockerRun(command, args, userId, reuseContainer, allowCreateTemp);
        } catch (runError) {
          throw new Error(`使用临时登录容器执行脚本失败: ${runError.message}`);
        }
      } else {
        // 临时登录容器不存在
        if (!allowCreateTemp) {
          throw new Error(
            `临时登录容器不存在。请先点击"Telegram 首次登录"按钮初始化登录容器。\n\n` +
            `如果容器被意外删除，请重新点击"Telegram 首次登录"按钮。`
          );
        }
        // 如果 allowCreateTemp=true，允许创建新容器
        console.log('📦 临时登录容器不存在，使用 docker run 执行登录脚本...');
        try {
          return await execLoginScriptWithDockerRun(command, args, userId, reuseContainer, allowCreateTemp);
        } catch (runError) {
          throw new Error(`创建临时登录容器执行脚本失败: ${runError.message}`);
        }
      }
    }
    
    // 如果没有 reuseContainer，尝试使用主容器
    let containerResult;
    try {
      containerResult = await getDockerAndContainer(true, allowCreateTemp);
    } catch (containerError) {
      // 如果 allowCreateTemp=false，不允许创建新容器，直接返回错误
      if (!allowCreateTemp) {
        throw new Error(
          `无法找到登录容器。请先点击"Telegram 首次登录"按钮初始化登录容器。\n\n` +
          `原始错误: ${containerError.message}`
        );
      }
      
      // 如果容器未运行且允许创建临时容器，则使用 docker run 执行脚本
      if (allowCreateTemp && (
        containerError.message.includes('无法找到运行中的 Telethon 容器') ||
        containerError.message.includes('容器不存在') ||
        containerError.message.includes('已退出')
      )) {
        console.log('📦 容器未运行，使用 docker run 执行登录脚本...');
        // 直接使用 docker run 执行脚本，不需要容器运行
        try {
          return await execLoginScriptWithDockerRun(command, args, userId, reuseContainer, allowCreateTemp);
        } catch (runError) {
          // 如果 docker run 也失败，抛出原始错误
          throw new Error(`容器未运行，且 docker run 执行失败: ${runError.message}`);
        }
      } else {
        throw containerError;
      }
    }
    
    const { container } = containerResult;
    
    // 执行命令
    const execArgs = ['python3', '/app/login_helper.py', command, ...args];
    
    return new Promise((resolve, reject) => {
      let timeoutId = null;
      let streamEnded = false;
      
      // 设置超时
      timeoutId = setTimeout(() => {
        if (!streamEnded) {
          streamEnded = true;
          console.error(`❌ 执行脚本超时（${timeout/1000}秒）: ${command} ${args.join(' ')}`);
          reject(new Error(
            `脚本执行超时（${timeout/1000}秒）\n` +
            `可能原因：\n` +
            `1. 网络连接问题，无法连接到 Telegram 服务器\n` +
            `2. 容器资源不足（内存或 CPU）\n` +
            `3. Telegram API 响应慢\n\n` +
            `建议：\n` +
            `- 检查网络连接\n` +
            `- 检查容器状态: docker ps\n` +
            `- 查看容器日志: docker logs tg_listener\n` +
            `- 检查容器资源使用: docker stats tg_listener`
          ));
        }
      }, timeout);
      
      // 创建 exec 实例
      container.exec({
        Cmd: execArgs,
        AttachStdout: true,
        AttachStderr: true
      }, (err, exec) => {
        if (err) {
          if (timeoutId) clearTimeout(timeoutId);
          // 检查是否是容器重启相关的错误
          if (err.message && (
            err.message.includes('restarting') ||
            err.message.includes('stopped/paused') ||
            err.message.includes('409')
          )) {
            // 如果是重启相关错误，且还有重试机会，则重试
            if (retryCount < maxRetries) {
              console.log(`⚠️  容器正在重启，${retryDelay/1000}秒后重试 (${retryCount + 1}/${maxRetries})...`);
              setTimeout(() => {
                execTelethonLoginScript(command, args, retryCount + 1)
                  .then(resolve)
                  .catch(reject);
              }, retryDelay);
              return;
            } else {
              return reject(new Error(
                `创建 exec 实例失败：容器正在重启或暂停。已重试 ${maxRetries} 次。\n` +
                `请等待容器启动完成（通常需要 10-30 秒）后再试。\n` +
                `如果容器持续重启，请检查日志: docker logs tg_listener\n` +
                `原始错误: ${err.message}`
              ));
            }
          }
          return reject(new Error(`创建 exec 实例失败: ${err.message}`));
        }
        
        // 启动 exec
        exec.start({ hijack: true, stdin: false }, (err, stream) => {
          if (err) {
            if (timeoutId) clearTimeout(timeoutId);
            return reject(new Error(`启动 exec 失败: ${err.message}`));
          }
          
          let stdout = '';
          let stderr = '';
          let output = Buffer.alloc(0);
          
          stream.on('data', (chunk) => {
            output = Buffer.concat([output, chunk]);
          });
          
          stream.on('end', () => {
            if (streamEnded) return;
            streamEnded = true;
            if (timeoutId) clearTimeout(timeoutId);
            
            // 解析 Docker 的流格式
            let buffer = output;
            let offset = 0;
            
            while (offset < buffer.length) {
              if (buffer.length - offset < 8) break;
              
              const header = buffer.slice(offset, offset + 8);
              const streamType = header[0];
              const payloadLength = header.readUInt32BE(4);
              
              if (buffer.length - offset < 8 + payloadLength) break;
              
              const payload = buffer.slice(offset + 8, offset + 8 + payloadLength);
              
              if (streamType === 1) { // stdout
                stdout += payload.toString();
              } else if (streamType === 2) { // stderr
                stderr += payload.toString();
              }
              
              offset += 8 + payloadLength;
            }
            
            // 检查执行结果
            exec.inspect((err, data) => {
              if (err) {
                return reject(new Error(`检查 exec 状态失败: ${err.message}`));
              }
              
              if (data.ExitCode === 0) {
                try {
                  const result = JSON.parse(stdout.trim());
                  resolve(result);
                } catch (e) {
                  resolve({ success: false, error: `解析结果失败: ${stdout.trim() || stderr.trim() || '无输出'}` });
                }
              } else if (data.ExitCode === 137) {
                // 退出码 137 = 128 + 9 (SIGKILL)，表示进程被强制终止
                // 但可能已经输出了有效结果，先尝试解析
                console.warn(`⚠️  脚本执行被强制终止（退出码: 137），尝试解析已有输出...`);
                console.warn(`⚠️  stdout: ${stdout.substring(0, 500)}`);
                console.warn(`⚠️  stderr: ${stderr.substring(0, 500)}`);
                
                // 首先检查是否有 Telegram API 错误（优先于 OOM 错误）
                const allOutput = (stdout + stderr).trim();
                if (allOutput) {
                  // 检查常见的 Telegram API 错误
                  if (allOutput.includes('AuthRestartError') || allOutput.includes('Restart the authorization process')) {
                    const errorMatch = allOutput.match(/(AuthRestartError[^\n]*|Restart the authorization process[^\n]*)/);
                    const errorMsg = errorMatch ? errorMatch[0] : 'Telegram 授权需要重新开始';
                    console.error(`❌ 检测到 Telegram API 错误: ${errorMsg}`);
                    return reject(new Error(
                      `Telegram API 错误：${errorMsg}\n\n` +
                      `这通常表示：\n` +
                      `1. Telegram 服务器内部问题\n` +
                      `2. 需要重新开始授权流程\n` +
                      `3. 请稍后重试或删除旧的 session 文件后重新登录`
                    ));
                  }
                  
                  // 检查其他 Telegram 错误
                  if (allOutput.includes('Telegram is having internal issues')) {
                    return reject(new Error(
                      `Telegram 服务器内部问题\n\n` +
                      `Telegram 服务器当前可能遇到问题，请稍后重试。\n` +
                      `如果问题持续，可以尝试：\n` +
                      `1. 等待几分钟后重试\n` +
                      `2. 删除旧的 session 文件后重新登录`
                    ));
                  }
                  
                  // 尝试从 stdout 或 stderr 中解析 JSON
                  const outputText = stdout.trim() || stderr.trim();
                  try {
                    // 尝试提取 JSON
                    const jsonMatch = outputText.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                      const result = JSON.parse(jsonMatch[0]);
                      console.log(`✅ 从被终止的进程中成功解析结果: ${JSON.stringify(result).substring(0, 200)}`);
                      // 如果结果成功，返回结果；否则返回错误信息
                      if (result.success) {
                        return resolve(result);
                      } else if (result.error) {
                        // 如果有错误信息，返回错误
                        return reject(new Error(result.error));
                      }
                    }
                  } catch (parseError) {
                    console.warn(`⚠️  无法解析输出: ${parseError.message}`);
                  }
                }
                
                // 如果无法解析或结果不成功，抛出 OOM 错误
                reject(new Error(
                  `脚本执行被强制终止（退出码: 137，可能是内存不足）\n\n` +
                  `可能原因：\n` +
                  `1. 容器内存不足 (OOM Killer)\n` +
                  `2. 进程执行时间过长被系统终止\n` +
                  `3. Docker 容器资源限制\n\n` +
                  `建议：\n` +
                  `- 检查容器内存使用: docker stats\n` +
                  `- 查看系统日志: dmesg | grep -i oom | tail -20\n` +
                  `- 检查容器资源限制: docker inspect <container> | grep -A 10 Memory\n` +
                  `- 如果内存不足，请增加服务器内存或关闭其他服务\n\n` +
                  `输出信息: ${(stderr || stdout || '无输出').substring(0, 500)}`
                ));
              } else {
                reject(new Error(`脚本执行失败 (退出码: ${data.ExitCode}): ${stderr || stdout || '无输出'}`));
              }
            });
          });
          
          stream.on('error', (err) => {
            if (streamEnded) return;
            streamEnded = true;
            if (timeoutId) clearTimeout(timeoutId);
            reject(new Error(`流错误: ${err.message}`));
          });
        });
      });
    });
  } catch (error) {
    // 如果是容器重启错误，且还有重试机会，则重试
    if (error.message && (
      error.message.includes('restarting') ||
      error.message.includes('stopped/paused') ||
      error.message.includes('重启')
    ) && retryCount < maxRetries) {
      console.log(`⚠️  容器状态异常，${retryDelay/1000}秒后重试 (${retryCount + 1}/${maxRetries})...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
      return execTelethonLoginScript(command, args, retryCount + 1);
    }
    throw error;
  }
}

// 登录状态检查缓存（避免频繁检查）
const loginStatusCache = new Map();
const CACHE_TTL = 30000; // 缓存30秒（从10秒增加到30秒，减少检查频率）

// 获取用户的 session 路径（使用目录挂载方式）
async function getSessionPath(userId) {
  // 使用目录挂载方式
  return `/opt/telegram-monitor/data/session/user_${userId}`;
}

// 检查 Telegram 登录状态（统一使用 volume 路径）
app.get('/api/telegram/login/status', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const forceRefresh = req.query.force === 'true';
    
    // 检查缓存（除非强制刷新）
    if (!forceRefresh) {
      const cacheKey = `login_status_${userId}`;
      const cached = loginStatusCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        // 移除日志输出，减少I/O操作
        return res.json(cached.result);
      }
    }
    
    // 使用目录挂载方式检查 session 文件
    const sessionPath = `/opt/telegram-monitor/data/session/user_${userId}`;
    
    // 先检查缓存中是否已经设置为未登录（删除凭证后立即设置的状态）
    const cacheKey = `login_status_${userId}`;
    const cachedStatus = loginStatusCache.get(cacheKey);
    if (cachedStatus && cachedStatus.result && !cachedStatus.result.logged_in) {
      // 如果缓存中明确标记为未登录，直接返回（避免重新检查文件）
      return res.json(cachedStatus.result);
    }
    
    const sessionExists = await checkSessionFileInVolume(userId);
    
    // 如果 session 文件不存在，直接返回（不需要查询配置）
    if (!sessionExists) {
      const result = {
        logged_in: false,
        message: '未登录（session 文件不存在）'
      };
      // 缓存结果
      loginStatusCache.set(cacheKey, {
        result,
        timestamp: Date.now()
      });
      return res.json(result);
    }
    
    // session 文件存在，检查是否启用多开模式
    // 在多开模式下，如果 session 文件存在就直接返回已登录（不需要验证，避免 database locked）
    let accountId = null;
    let multiLoginEnabled = false;
    try {
      accountId = await getAccountId(userId);
      const accountConfig = await loadUserConfig(accountId.toString());
      multiLoginEnabled = accountConfig.multi_login_enabled || false;
    } catch (checkError) {
      // 如果检查失败，继续使用原来的验证逻辑
      console.warn(`⚠️  [登录状态] 检查多开模式失败: ${checkError.message}`);
    }
    
    // 在多开模式下，如果 session 文件存在，直接返回已登录（避免创建临时容器验证，导致 database locked）
    if (multiLoginEnabled) {
      const quickResult = {
        logged_in: true,
        message: '已登录（session 文件存在）',
        uncertain: false
      };
      loginStatusCache.set(cacheKey, {
        result: quickResult,
        timestamp: Date.now()
      });
      return res.json(quickResult);
    }
    
    // 单开模式下，需要验证 session 文件有效性
    // 尝试从缓存获取配置（避免 MongoDB 查询）
    let config = null;
    const configCacheKey = `user_config_${userId}`;
    const cachedConfig = userConfigCache.get(configCacheKey);
    
    if (cachedConfig && (Date.now() - cachedConfig.timestamp) < CONFIG_CACHE_TTL) {
      config = cachedConfig.config;
    } else {
      // 缓存未命中，查询 MongoDB
      try {
        const userConfig = await loadUserConfig(userId);
        config = userConfig.toObject ? userConfig.toObject() : userConfig;
        // 更新配置缓存
        userConfigCache.set(configCacheKey, {
          config,
          timestamp: Date.now()
        });
      } catch (configError) {
        // 如果无法加载配置，无法验证session有效性，返回未登录
        const result = {
          logged_in: false,
          message: '未登录（无法验证 session 文件有效性）'
        };
        loginStatusCache.set(cacheKey, {
          result,
          timestamp: Date.now()
        });
        return res.json(result);
      }
    }
    
    const apiId = config.telegram?.api_id || 0;
    const apiHash = config.telegram?.api_hash || '';
    
    if (!apiId || !apiHash) {
      // 如果没有配置，无法验证session有效性，返回未登录
      const result = {
        logged_in: false,
        message: '未登录（未配置 API 凭证，无法验证 session 文件）'
      };
      loginStatusCache.set(cacheKey, {
        result,
        timestamp: Date.now()
      });
      return res.json(result);
    }
    
    // 验证输入
    const validatedApiId = validateInput(apiId, 'number');
    const validatedApiHash = validateInput(apiHash);
    
    // 必须验证 session 文件有效性才能返回已登录
    // 如果强制刷新，进行同步验证；否则返回未登录（需要用户点击刷新按钮）
    if (forceRefresh) {
      // 尝试从缓存获取配置（避免 MongoDB 查询）
      let config = null;
      const configCacheKey = `user_config_${userId}`;
      const cachedConfig = userConfigCache.get(configCacheKey);
      
      if (cachedConfig && (Date.now() - cachedConfig.timestamp) < CONFIG_CACHE_TTL) {
        config = cachedConfig.config;
      } else {
        // 缓存未命中，查询 MongoDB
        const userConfig = await loadUserConfig(userId);
        config = userConfig.toObject ? userConfig.toObject() : userConfig;
        // 更新配置缓存
        userConfigCache.set(configCacheKey, {
          config,
          timestamp: Date.now()
        });
      }
      
      const apiId = config.telegram?.api_id || 0;
      const apiHash = config.telegram?.api_hash || '';
      
      if (!apiId || !apiHash) {
        // 即使没有配置，也返回已登录（因为文件存在）
        const quickResult = {
          logged_in: true,
          message: '已登录（session 文件存在）',
          uncertain: false
        };
        loginStatusCache.set(cacheKey, {
          result: quickResult,
          timestamp: Date.now()
        });
        return res.json(quickResult);
      }
      
      // 验证输入
      const validatedApiId = validateInput(apiId, 'number');
      const validatedApiHash = validateInput(apiHash);
      
      // 如果强制刷新，才进行容器验证（但使用较短的超时）
      let checkResult = null;
      let checkError = null;
      
      try {
        // 检查是否启用多开模式
        const accountId = await getAccountId(userId);
        const accountConfig = await loadUserConfig(accountId.toString());
        const multiLoginEnabled = accountConfig.multi_login_enabled || false;
        
        // 使用较短的超时时间（3秒），快速失败
        const quickTimeout = 3000; // 3秒超时（进一步减少）
        checkResult = await Promise.race([
          execTelethonLoginScript('check', [
            sessionPath,
            validatedApiId.toString(),
            validatedApiHash
          ], 0, true, userId, false), // allowCreateTemp = true, userId, reuseContainer = false
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('检查超时（3秒）')), quickTimeout)
          )
        ]);
      } catch (error) {
        checkError = error;
        // 如果验证超时，但 session 文件存在，仍然返回已登录（文件存在说明已经登录过）
        if (error.message && error.message.includes('超时')) {
          console.warn(`⚠️  [登录状态] session 文件验证超时，但文件存在，返回已登录: ${error.message}`);
          const timeoutResult = {
            logged_in: true,
            message: '已登录（session 文件存在，验证超时）',
            uncertain: true
          };
          loginStatusCache.set(cacheKey, {
            result: timeoutResult,
            timestamp: Date.now()
          });
          return res.json(timeoutResult);
        }
        // 其他验证失败，返回未登录
        console.warn(`⚠️  [登录状态] session 文件验证失败: ${error.message}`);
        const failedResult = {
          logged_in: false,
          message: `未登录（session 文件验证失败：${error.message}）`
        };
        loginStatusCache.set(cacheKey, {
          result: failedResult,
          timestamp: Date.now()
        });
        return res.json(failedResult);
      }
      
      // 如果容器验证成功，使用验证结果
      if (checkResult && checkResult.success && checkResult.logged_in) {
        const verifiedResult = {
          logged_in: true,
          message: '已登录',
          user: checkResult.user || null
        };
        loginStatusCache.set(cacheKey, {
          result: verifiedResult,
          timestamp: Date.now()
        });
        return res.json(verifiedResult);
      }
      
      // 如果验证失败，只返回未登录状态，不删除 session 文件
      // 注意：不再自动删除 session 文件，只做状态检测
      if (checkError) {
        // 验证过程出错（如超时、OOM Killer），不删除 session 文件
        console.warn(`⚠️  [登录状态] session 文件验证过程出错: ${checkError.message}`);
        // 已经返回了错误结果，这里直接返回
        return;
      }
      
      // 如果验证失败（文件存在但无效），只返回未登录状态，不删除文件
      if (checkResult && 
          checkResult.success !== undefined && 
          !checkResult.success && 
          !checkResult.logged_in && 
          sessionExists) {
        console.warn(`⚠️  [登录状态] 检测到无效的 session 文件，但不删除（仅状态检测）: ${sessionPath}`);
        
        // 返回未登录状态
        const invalidResult = {
          logged_in: false,
          message: '未登录（session 文件无效）'
        };
        loginStatusCache.set(cacheKey, {
          result: invalidResult,
          timestamp: Date.now()
        });
        return res.json(invalidResult);
      }
    } else {
      // 如果没有强制刷新，不进行验证，直接返回未登录（需要用户点击刷新按钮）
      // 这样可以避免频繁检测，只在用户主动刷新时才验证
      const result = {
        logged_in: false,
        message: '请点击"刷新状态"按钮检查登录状态'
      };
      
      // 缓存结果
      loginStatusCache.set(cacheKey, {
        result,
        timestamp: Date.now()
      });
      
      return res.json(result);
      
      // 以下代码已禁用，不再在后台自动验证
      /*
      // 在后台异步验证并自动删除无效的 session 文件
      setTimeout(async () => {
        try {
          // 使用之前已经加载的配置
          const apiId = config.telegram?.api_id || 0;
          const apiHash = config.telegram?.api_hash || '';
          
          if (apiId && apiHash) {
            // 验证输入
            const validatedApiId = validateInput(apiId, 'number');
            const validatedApiHash = validateInput(apiHash);
            
            // 在后台异步验证（使用较短的超时）
            try {
              const checkResult = await Promise.race([
                execTelethonLoginScript('check', [
                  sessionPath,
                  validatedApiId.toString(),
                  validatedApiHash
                ], 0, true),
                new Promise((_, reject) => 
                  setTimeout(() => reject(new Error('验证超时')), 3000)
                )
              ]);
              
              // 如果验证失败（文件存在但无效），自动删除
              // 注意：只有在明确验证失败（不是系统错误）时才删除
              const isBackgroundValidationError = checkResult && 
                checkResult.success !== undefined &&
                !checkResult.success &&
                !checkResult.logged_in &&
                !checkResult.error; // 没有错误信息
              
              if (isBackgroundValidationError) {
                console.warn(`⚠️  [登录状态] 后台验证发现无效的 session 文件，自动删除: ${sessionPath}`);
                // 调用删除凭证逻辑（只删除 volume 中的文件）
                const Docker = require('dockerode');
                const dockerSocketPaths = [
                  '/var/run/docker.sock',
                  process.env.DOCKER_HOST?.replace('unix://', '') || null
                ].filter(Boolean);
                
                let docker = null;
                for (const socketPath of dockerSocketPaths) {
                  if (fs.existsSync(socketPath)) {
                    try {
                      docker = new Docker({ socketPath });
                      await docker.ping();
                      break;
                    } catch (e) {
                      // 继续尝试下一个路径
                    }
                  }
                }
                
                if (docker) {
                  const volumeName = 'tg_session';
                  const volumeSessionFileName = `user_${userId}.session`;
                  const volumeJournalFileName = `user_${userId}.session-journal`;
                  
                  try {
                    const volume = docker.getVolume(volumeName);
                    await volume.inspect();
                    
                    const tempImage = await getTempContainerImage(docker);
                    const deleteContainerName = `tg_session_auto_delete_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                    
                    const deleteContainer = await docker.createContainer({
                      Image: tempImage,
                      name: deleteContainerName,
                      Cmd: ['sh', '-c', 'sleep 1'],
                      HostConfig: {
                        Binds: [`${volumeName}:/tmp/session_volume`]
                      }
                    });
                    
                    await deleteContainer.start();
                    
                    // 删除 session 文件
                    const deleteExec = await deleteContainer.exec({
                      Cmd: ['sh', '-c', `rm -rf /tmp/session_volume/${volumeSessionFileName} /tmp/session_volume/${volumeJournalFileName} && echo "deleted"`],
                      AttachStdout: true,
                      AttachStderr: true
                    });
                    
                    const deleteStream = await deleteExec.start({ hijack: true, stdin: false });
                    await new Promise((resolve) => {
                      deleteStream.on('end', resolve);
                    });
                    
                    await deleteContainer.stop();
                    await deleteContainer.remove();
                    
                    // 更新缓存
                    const volumeCacheKey = `volume_session_${userId}`;
                    sessionFileCache.set(volumeCacheKey, { exists: false, timestamp: Date.now() });
                    loginStatusCache.set(cacheKey, {
                      result: {
                        logged_in: false,
                        message: '未登录（无效凭证已自动删除）'
                      },
                      timestamp: Date.now()
                    });
                    
                    console.log(`✅ [登录状态] 后台验证已自动删除无效的 session 文件`);
                  } catch (deleteError) {
                    console.warn(`⚠️  [登录状态] 后台验证自动删除无效 session 文件失败: ${deleteError.message}`);
                  }
                }
              }
            } catch (verifyError) {
              // 验证失败（超时或错误），不自动删除，让用户手动处理
              // 静默失败，不影响主流程
            }
          }
        } catch (error) {
          // 静默失败，不影响主流程
        }
      }, 100); // 延迟100ms，确保响应已返回
      */
    }
    
    // 如果 forceRefresh 为 true 但验证失败且没有进入删除逻辑，返回未登录
    // 因为必须验证session有效性才能返回已登录
    const defaultResult = {
      logged_in: false,
      message: '未登录（session 文件验证失败）'
    };
    loginStatusCache.set(cacheKey, {
      result: defaultResult,
      timestamp: Date.now()
    });
    return res.json(defaultResult);
  } catch (error) {
    console.error('❌ [登录状态] 检查失败:', error);
    res.status(500).json({ error: '检查登录状态失败：' + error.message });
  }
});

// 初始化登录容器（在点击"Telegram 首次登录"时调用，提前创建容器）
app.post('/api/telegram/login/init', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // 检查是否已配置 API_ID 和 API_HASH
    const userConfig = await loadUserConfig(userId);
    const config = userConfig.toObject ? userConfig.toObject() : userConfig;
    
    const apiId = config.telegram?.api_id || 0;
    const apiHash = config.telegram?.api_hash || '';
    
    if (!apiId || !apiHash) {
      return res.status(400).json({ error: '请先配置 API_ID 和 API_HASH' });
    }
    
    // 检查是否已有临时容器
    const existing = tempLoginContainers.get(userId);
    if (existing) {
      try {
        const Docker = require('dockerode');
        const docker = new Docker({ socketPath: '/var/run/docker.sock' });
        const container = docker.getContainer(existing.containerName);
        const containerInfo = await container.inspect();
        if (containerInfo.State.Running) {
          console.log(`♻️  临时登录容器已存在: ${existing.containerName}`);
          return res.json({
            success: true,
            message: '登录容器已就绪',
            containerName: existing.containerName
          });
        }
      } catch (e) {
        // 容器不存在，继续创建新的
        tempLoginContainers.delete(userId);
      }
    }
    
    // 提前创建临时登录容器
    try {
      const Docker = require('dockerode');
      const docker = new Docker({ socketPath: '/var/run/docker.sock' });
      
      // 获取项目根目录和配置路径
      const projectRoot = detectProjectRoot();
      const configHostPath = path.resolve(projectRoot, 'backend', 'config.json');
      
      // 获取容器镜像
      let containerImage = null;
      try {
        const existingContainer = docker.getContainer('tg_listener');
        const existingContainerInfo = await existingContainer.inspect();
        if (existingContainerInfo && existingContainerInfo.Config && existingContainerInfo.Config.Image) {
          containerImage = existingContainerInfo.Config.Image;
        }
      } catch (e) {
        // 容器不存在，尝试查找镜像
        const images = await docker.listImages();
        const telethonImage = images.find(img => {
          if (!img.RepoTags || img.RepoTags.length === 0) return false;
          return img.RepoTags.some(tag => 
            (tag.includes('tg_listener') || tag.includes('telethon')) && !tag.includes('<none>')
          );
        });
        if (telethonImage && telethonImage.RepoTags && telethonImage.RepoTags.length > 0) {
          containerImage = telethonImage.RepoTags.find(tag => !tag.includes('<none>')) || telethonImage.RepoTags[0];
        }
      }
      
      if (!containerImage) {
        // 尝试使用常见的命名格式
        const possibleNames = [
          'telegram-monitor-telethon',
          'tgjiankong-telethon',
          'tgjiankong-tg_listener',
          'telethon-tgjiankong',
          'tg_listener'
        ];
        
        for (const name of possibleNames) {
          try {
            const testImage = docker.getImage(name);
            await testImage.inspect();
            containerImage = name;
            break;
          } catch (e) {
            // 继续尝试下一个
          }
        }
      }
      
      if (!containerImage) {
        return res.status(500).json({ error: '无法找到 Telethon 镜像。请确保 Telethon 容器镜像已构建。' });
      }
      
      // 获取网络名称
      let networkName = null;
      try {
        const existingContainer = docker.getContainer('tg_listener');
        const existingContainerInfo = await existingContainer.inspect();
        if (existingContainerInfo && existingContainerInfo.NetworkSettings && existingContainerInfo.NetworkSettings.Networks) {
          networkName = Object.keys(existingContainerInfo.NetworkSettings.Networks)[0];
        }
      } catch (e) {
        // 忽略错误
      }
      
      // 创建临时登录容器
      const containerName = await getOrCreateTempLoginContainer(userId, configHostPath, null, containerImage, networkName);
      
      console.log(`✅ 已提前创建临时登录容器: ${containerName}`);
      
      res.json({
        success: true,
        message: '登录容器已创建，可以开始登录流程',
        containerName: containerName
      });
    } catch (error) {
      console.error('初始化登录容器失败:', error);
      res.status(500).json({ error: '初始化登录容器失败：' + error.message });
    }
  } catch (error) {
    console.error('初始化登录容器请求失败:', error);
    res.status(500).json({ error: '初始化登录容器失败：' + error.message });
  }
});

// 发送验证码请求
app.post('/api/telegram/login/send-code', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { phone } = req.body;
    
    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: '手机号不能为空' });
    }
    
    // 验证手机号格式
    let validatedPhone;
    try {
      validatedPhone = validateInput(phone, 'phone');
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    
    const userConfig = await loadUserConfig(userId);
    const config = userConfig.toObject ? userConfig.toObject() : userConfig;
    
    const apiId = config.telegram?.api_id || 0;
    const apiHash = config.telegram?.api_hash || '';
    
    if (!apiId || !apiHash) {
      return res.status(400).json({ error: '请先配置 API_ID 和 API_HASH' });
    }
    
    // 验证 API 凭证
    let validatedApiId, validatedApiHash;
    try {
      validatedApiId = validateInput(apiId, 'number');
      validatedApiHash = validateInput(apiHash);
    } catch (e) {
      return res.status(400).json({ error: 'API 凭证格式无效' });
    }
    
    // 使用目录挂载方式，统一路径：/opt/telegram-monitor/data/session/{SESSION_PREFIX}
    // 注意：SESSION_PREFIX 应该通过环境变量传递给容器，这里使用 user_${userId} 作为默认值
    const sessionPath = `/opt/telegram-monitor/data/session/user_${userId}`;
    
    try {
      // 使用安全的脚本调用方式，首次登录时创建可复用的临时容器
      const result = await execTelethonLoginScript('send_code', [
        validatedPhone,
        sessionPath,
        validatedApiId.toString(),
        validatedApiHash
      ], 0, false, userId, true); // allowCreateTemp=false（不创建新容器）, reuseContainer=true（复用已有容器）
      
      if (result.success) {
        if (result.already_logged_in) {
          // 已登录，清理临时容器
          await cleanupTempLoginContainer(userId);
          return res.json({
            success: true,
            already_logged_in: true,
            message: `已登录为: ${result.user?.first_name || '未知用户'}`,
            user: result.user
          });
        }
        
        res.json({
          success: true,
          message: `验证码已发送到 ${validatedPhone}`,
          phone_code_hash: result.phone_code_hash,
          session_id: `${userId}_${validatedPhone}_${Date.now()}`
        });
      } else {
        // 发送验证码失败，清理临时容器
        await cleanupTempLoginContainer(userId);
        // 处理 FloodWait 错误
        if (result.flood_wait) {
          return res.status(429).json({ 
            error: result.error || `请求过于频繁，请等待 ${result.flood_wait} 秒后重试`,
            flood_wait: result.flood_wait
          });
        }
        
        res.status(500).json({ error: result.error || '发送验证码失败' });
      }
    } catch (error) {
      console.error('发送验证码失败:', error);
      // 出错时清理临时容器
      await cleanupTempLoginContainer(userId).catch(() => {});
      res.status(500).json({ 
        error: '发送验证码失败：' + error.message 
      });
    }
  } catch (error) {
    console.error('发送验证码请求失败:', error);
    // 出错时清理临时容器
    if (req.user?.userId) {
      await cleanupTempLoginContainer(req.user.userId).catch(() => {});
    }
    res.status(500).json({ error: '发送验证码失败：' + error.message });
  }
});

// 取消登录（清理临时容器）
app.post('/api/telegram/login/cancel', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    await cleanupTempLoginContainer(userId);
    res.json({
      success: true,
      message: '已取消登录，临时容器已清理'
    });
  } catch (error) {
    console.error('取消登录失败:', error);
    res.status(500).json({ error: '取消登录失败：' + error.message });
  }
});

// 使用验证码登录
app.post('/api/telegram/login/verify', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { phone, code, password, phone_code_hash } = req.body;
    
    if (!phone || !code) {
      return res.status(400).json({ error: '手机号和验证码不能为空' });
    }
    
    if (!phone_code_hash) {
      return res.status(400).json({ error: '请先发送验证码请求' });
    }
    
    // 验证输入
    let validatedPhone, validatedCode, validatedPassword, validatedHash;
    try {
      validatedPhone = validateInput(phone, 'phone');
      validatedCode = validateInput(code, 'code');
      validatedHash = validateInput(phone_code_hash);
      validatedPassword = password ? validateInput(password) : null;
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    
    const userConfig = await loadUserConfig(userId);
    const config = userConfig.toObject ? userConfig.toObject() : userConfig;
    
    const apiId = config.telegram?.api_id || 0;
    const apiHash = config.telegram?.api_hash || '';
    
    if (!apiId || !apiHash) {
      return res.status(400).json({ error: '请先配置 API_ID 和 API_HASH' });
    }
    
    // 验证 API 凭证
    let validatedApiId, validatedApiHash;
    try {
      validatedApiId = validateInput(apiId, 'number');
      validatedApiHash = validateInput(apiHash);
    } catch (e) {
      return res.status(400).json({ error: 'API 凭证格式无效' });
    }
    
    // 使用目录挂载方式，统一路径：/opt/telegram-monitor/data/session/{SESSION_PREFIX}
    // 注意：SESSION_PREFIX 应该通过环境变量传递给容器，这里使用 user_${userId} 作为默认值
    const sessionPath = `/opt/telegram-monitor/data/session/user_${userId}`;
    
    try {
      // 使用安全的脚本调用方式，复用已创建的临时容器（不创建新容器）
      const result = await execTelethonLoginScript('sign_in', [
        validatedPhone,
        validatedCode,
        validatedHash,
        validatedPassword || 'None',
        sessionPath,
        validatedApiId.toString(),
        validatedApiHash
      ], 0, false, userId, true); // allowCreateTemp=false（不创建新容器）, reuseContainer=true（复用已有容器）
      
      // 检查是否需要密码（这是正常情况，不是错误）
      if (result.password_required) {
        console.log(`🔐 [登录验证] 需要两步验证密码`);
        // 需要密码，不清理容器（用户可能还要输入密码）
        return res.json({
          success: false,
          password_required: true,
          message: '需要两步验证密码'
        });
      }
      
      if (result.success) {
        console.log(`✅ [登录验证] 登录脚本返回成功`);
        console.log(`📁 [登录验证] Session 路径: ${sessionPath}`);
        
        // 立即清除并更新登录状态缓存，确保前端能正确显示已登录状态
        const cacheKey = `login_status_${userId}`;
        const volumeCacheKey = `volume_session_${userId}`;
        
        // 清除所有相关缓存（包括登录状态缓存和 session 文件缓存）
        loginStatusCache.delete(cacheKey);
        sessionFileCache.delete(volumeCacheKey);
        
        // 立即返回成功响应（不等待文件检查）
        // 文件检查和容器清理在后台异步执行
        res.json({
          success: true,
          message: `登录成功！已登录为: ${result.user?.first_name || result.user?.username || '未知用户'}`,
          user: result.user || null
        });
        
        // 后台异步处理：文件检查和容器清理（不阻塞响应）
        setTimeout(async () => {
          try {
            console.log(`🔍 [登录验证] 后台验证 session 文件...`);
            
            // 等待文件同步完成（后台执行，减少等待时间）
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // 检查本地文件系统（如果使用目录挂载）
            const PROJECT_ROOT = process.env.PROJECT_ROOT || '/opt/telegram-monitor';
            const localSessionPath = path.join(PROJECT_ROOT, 'data', 'session', `user_${userId}.session`);
            const sessionExists = fs.existsSync(localSessionPath);
            
            if (sessionExists) {
              console.log(`✅ [登录验证] Session 文件已存在于本地文件系统`);
              // 更新缓存
              sessionFileCache.set(volumeCacheKey, {
                exists: true,
                timestamp: Date.now()
              });
            }
            
            // 清理临时登录容器
            console.log(`🧹 [登录验证] 清理临时登录容器...`);
            await cleanupTempLoginContainer(userId);
            
            // 更新登录状态缓存
            loginStatusCache.set(cacheKey, {
              result: {
                logged_in: true,
                message: '已登录',
                user: result.user || null
              },
              timestamp: Date.now()
            });
            
            // Telegram 登录成功后，同步用户配置并重启 Telethon 服务（后台异步）
            setTimeout(async () => {
              try {
                console.log(`🔄 [登录验证] 后台同步配置并重启 Telethon 服务...`);
                await syncUserConfigAndRestartTelethon(userId);
              } catch (error) {
                console.error('⚠️  [登录验证] 后台同步配置失败（不影响登录）:', error);
              }
            }, 2000);
            
          } catch (checkError) {
            console.error(`❌ [登录验证] 后台处理失败: ${checkError.message}`);
          }
        }, 100);
      } else {
        if (result.password_required) {
          // 需要密码，不清理容器（用户可能还要输入密码）
          return res.json({
            success: false,
            password_required: true,
            message: '需要两步验证密码'
          });
        }
        
        // 登录失败，清理临时容器
        await cleanupTempLoginContainer(userId);
        res.status(500).json({ 
          error: result.error || '登录失败' 
        });
      }
    } catch (error) {
      console.error('验证登录失败:', error);
      console.error('错误堆栈:', error.stack);
      
      // 出错时清理临时容器
      await cleanupTempLoginContainer(userId).catch(() => {});
      
      // 检查是否是 OOM Killer 错误
      if (error.message && error.message.includes('退出码: 137')) {
        return res.status(500).json({ 
          error: '登录验证时进程被系统终止（内存不足）。\n\n' +
                 '可能原因：\n' +
                 '1. 服务器内存不足\n' +
                 '2. 容器内存限制过低\n\n' +
                 '建议：\n' +
                 '- 检查系统内存: free -h\n' +
                 '- 检查容器内存: docker stats\n' +
                 '- 查看 OOM 日志: dmesg | grep -i oom | tail -20\n' +
                 '- 如果内存不足，请增加服务器内存或关闭其他服务'
        });
      }
      
      // 检查是否是密码需要错误（这是正常的，不是错误）
      if (error.message && error.message.includes('password_required')) {
        return res.status(400).json({ 
          error: '需要两步验证密码',
          password_required: true
        });
      }
      
      res.status(500).json({ 
        error: '验证失败：' + error.message 
      });
    }
  } catch (error) {
    console.error('验证登录请求失败:', error);
    res.status(500).json({ error: '验证失败：' + error.message });
  }
});

// 删除当前用户的 Telegram 登录凭证
app.post('/api/telegram/credentials/delete', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const deletedFiles = [];
    const errors = [];
    
    console.log(`🗑️  [删除凭证] 开始删除用户 ${userId} 的 Telegram 凭证`);
    
    // 0. 先停止 tg_listener 容器，防止它重新创建 session 文件
    try {
      const Docker = require('dockerode');
      const dockerSocketPaths = [
        '/var/run/docker.sock',
        process.env.DOCKER_HOST?.replace('unix://', '') || null
      ].filter(Boolean);
      
      let docker = null;
      for (const socketPath of dockerSocketPaths) {
        if (fs.existsSync(socketPath)) {
          try {
            docker = new Docker({ socketPath });
            await docker.ping();
            break;
          } catch (e) {
            // 继续尝试下一个路径
          }
        }
      }
      
      if (docker) {
        try {
          // 停止所有相关的 listener 容器（包括多开模式的容器）
          const containers = await docker.listContainers({ all: true });
          const listenerContainers = containers.filter(c => 
            c.Names && c.Names.some(name => 
              name.includes('tg_listener') || 
              name.includes(`tg_listener_${userId}`)
            )
          );
          
          for (const containerInfo of listenerContainers) {
            try {
              const container = docker.getContainer(containerInfo.Id);
              const containerName = containerInfo.Names[0]?.replace('/', '') || containerInfo.Id;
              
              // 检查容器是否在运行
              const inspect = await container.inspect();
              if (inspect.State.Running || inspect.State.Restarting) {
                console.log(`🛑 [删除凭证] 停止容器: ${containerName}`);
                await container.stop({ t: 10 }); // 10秒超时
                // 等待容器完全停止
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
            } catch (stopError) {
              console.warn(`⚠️  [删除凭证] 停止容器失败: ${stopError.message}`);
            }
          }
          
          // 等待一段时间，确保容器不会立即重启
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (e) {
          console.warn(`⚠️  [删除凭证] 停止容器时出错: ${e.message}`);
        }
      }
    } catch (error) {
      console.warn(`⚠️  [删除凭证] 停止容器失败: ${error.message}`);
    }
    
    // 1. 删除 Docker volume 中的 session 文件
    try {
      const Docker = require('dockerode');
      const dockerSocketPaths = [
        '/var/run/docker.sock',
        process.env.DOCKER_HOST?.replace('unix://', '') || null
      ].filter(Boolean);
      
      let docker = null;
      for (const socketPath of dockerSocketPaths) {
        if (fs.existsSync(socketPath)) {
          try {
            docker = new Docker({ socketPath });
            await docker.ping();
            break;
          } catch (e) {
            // 继续尝试下一个路径
          }
        }
      }
      
      if (docker) {
        const volumeName = 'tg_session';
        const volumeSessionFileName = `user_${userId}.session`;
        const volumeJournalFileName = `user_${userId}.session-journal`;
        
        try {
          const volume = docker.getVolume(volumeName);
          await volume.inspect();
          
          // 使用临时容器删除 volume 中的文件
          const tempImage = await getTempContainerImage(docker);
          const deleteContainerName = `tg_session_delete_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          
          try {
            const deleteContainer = await docker.createContainer({
              Image: tempImage,
              name: deleteContainerName,
              Cmd: ['sh', '-c', 'sleep 1'],
              HostConfig: {
                Binds: [
                  `${volumeName}:/tmp/session_volume`
                ]
              }
            });
            
            await deleteContainer.start();
            
            // 删除 .session 文件（先检查是否存在，再删除，最后验证）
            try {
              // 先检查文件是否存在
              const checkExec = await deleteContainer.exec({
                Cmd: ['sh', '-c', `test -f /tmp/session_volume/${volumeSessionFileName} && echo "exists" || echo "not_exists"`],
                AttachStdout: true,
                AttachStderr: true
              });
              
              const checkStream = await checkExec.start({ hijack: true, stdin: false });
              let checkOutput = '';
              await new Promise((resolve) => {
                checkStream.on('data', (chunk) => {
                  checkOutput += chunk.toString();
                });
                checkStream.on('end', resolve);
              });
              
              if (checkOutput.trim().includes('exists')) {
                // 文件存在，执行删除
                const deleteExec = await deleteContainer.exec({
                  Cmd: ['sh', '-c', `rm -f /tmp/session_volume/${volumeSessionFileName} && test ! -f /tmp/session_volume/${volumeSessionFileName} && echo "deleted" || echo "delete_failed"`],
                  AttachStdout: true,
                  AttachStderr: true
                });
                
                const deleteStream = await deleteExec.start({ hijack: true, stdin: false });
                let output = '';
                await new Promise((resolve) => {
                  deleteStream.on('data', (chunk) => {
                    output += chunk.toString();
                  });
                  deleteStream.on('end', resolve);
                });
                
                if (output.trim().includes('deleted')) {
                  deletedFiles.push(`volume:${volumeSessionFileName}`);
                  console.log(`✅ [删除凭证] 已删除 volume 中的文件: ${volumeSessionFileName}`);
                } else {
                  console.warn(`⚠️  [删除凭证] 删除 volume 中的 .session 文件失败: ${output.trim()}`);
                  errors.push(`删除 volume 文件失败: ${volumeSessionFileName}`);
                }
              } else {
                console.log(`ℹ️  [删除凭证] volume 中的文件不存在，跳过: ${volumeSessionFileName}`);
              }
            } catch (e) {
              console.warn(`⚠️  [删除凭证] 删除 volume 中的 .session 文件失败: ${e.message}`);
              errors.push(`删除 volume 文件失败: ${e.message}`);
            }
            
            // 删除 .session-journal 文件（先检查是否存在，再删除，最后验证）
            try {
              // 先检查文件是否存在
              const checkJournalExec = await deleteContainer.exec({
                Cmd: ['sh', '-c', `test -f /tmp/session_volume/${volumeJournalFileName} && echo "exists" || echo "not_exists"`],
                AttachStdout: true,
                AttachStderr: true
              });
              
              const checkJournalStream = await checkJournalExec.start({ hijack: true, stdin: false });
              let checkJournalOutput = '';
              await new Promise((resolve) => {
                checkJournalStream.on('data', (chunk) => {
                  checkJournalOutput += chunk.toString();
                });
                checkJournalStream.on('end', resolve);
              });
              
              if (checkJournalOutput.trim().includes('exists')) {
                // 文件存在，执行删除
                const deleteJournalExec = await deleteContainer.exec({
                  Cmd: ['sh', '-c', `rm -f /tmp/session_volume/${volumeJournalFileName} && test ! -f /tmp/session_volume/${volumeJournalFileName} && echo "deleted" || echo "delete_failed"`],
                  AttachStdout: true,
                  AttachStderr: true
                });
                
                const deleteJournalStream = await deleteJournalExec.start({ hijack: true, stdin: false });
                let journalOutput = '';
                await new Promise((resolve) => {
                  deleteJournalStream.on('data', (chunk) => {
                    journalOutput += chunk.toString();
                  });
                  deleteJournalStream.on('end', resolve);
                });
                
                if (journalOutput.trim().includes('deleted')) {
                  deletedFiles.push(`volume:${volumeJournalFileName}`);
                  console.log(`✅ [删除凭证] 已删除 volume 中的文件: ${volumeJournalFileName}`);
                } else {
                  console.warn(`⚠️  [删除凭证] 删除 volume 中的 .session-journal 文件失败: ${journalOutput.trim()}`);
                  errors.push(`删除 volume 文件失败: ${volumeJournalFileName}`);
                }
              } else {
                console.log(`ℹ️  [删除凭证] volume 中的文件不存在，跳过: ${volumeJournalFileName}`);
              }
            } catch (e) {
              console.warn(`⚠️  [删除凭证] 删除 volume 中的 .session-journal 文件失败: ${e.message}`);
              errors.push(`删除 volume 文件失败: ${e.message}`);
            }
            
            await deleteContainer.stop();
            await deleteContainer.remove();
            
            // 等待一小段时间，确保文件系统同步
            await new Promise(resolve => setTimeout(resolve, 500));
          } catch (e) {
            console.warn(`⚠️  [删除凭证] 删除 volume 中的文件失败: ${e.message}`);
            errors.push(`删除 volume 文件失败: ${e.message}`);
          }
        } catch (e) {
          console.log(`ℹ️  [删除凭证] Volume ${volumeName} 不存在，跳过`);
        }
      } else {
        console.warn('⚠️  [删除凭证] 无法连接到 Docker，跳过删除 volume 中的文件');
      }
    } catch (error) {
      console.warn(`⚠️  [删除凭证] 删除 volume 文件时出错: ${error.message}`);
      errors.push(`删除 volume 文件失败: ${error.message}`);
    }
    
    // 2. 删除宿主机路径中的 session 文件
    const sessionDirs = [
      path.join(__dirname, '..', 'data', 'session'), // 宿主机路径
      path.join(__dirname, 'data') // backend/data 路径
    ];
    
    const sessionFileNames = [
      'telegram',
      `telegram_${userId}`
    ];
    
    for (const sessionDir of sessionDirs) {
      if (fs.existsSync(sessionDir)) {
        for (const sessionFileName of sessionFileNames) {
          const sessionFile = path.join(sessionDir, `${sessionFileName}.session`);
          const journalFile = path.join(sessionDir, `${sessionFileName}.session-journal`);
          
          // 删除 .session 文件
          if (fs.existsSync(sessionFile)) {
            try {
              fs.unlinkSync(sessionFile);
              deletedFiles.push(`local:${sessionFile}`);
              console.log(`✅ [删除凭证] 已删除本地文件: ${sessionFile}`);
            } catch (e) {
              console.warn(`⚠️  [删除凭证] 删除本地文件失败: ${sessionFile} - ${e.message}`);
              errors.push(`删除本地文件失败: ${sessionFile}`);
            }
          }
          
          // 删除 .session-journal 文件
          if (fs.existsSync(journalFile)) {
            try {
              fs.unlinkSync(journalFile);
              deletedFiles.push(`local:${journalFile}`);
              console.log(`✅ [删除凭证] 已删除本地文件: ${journalFile}`);
            } catch (e) {
              console.warn(`⚠️  [删除凭证] 删除本地文件失败: ${journalFile} - ${e.message}`);
              errors.push(`删除本地文件失败: ${journalFile}`);
            }
          }
        }
      }
    }
    
    // 3. 清除登录状态缓存，并立即设置为未登录状态
    const cacheKey = `login_status_${userId}`;
    loginStatusCache.delete(cacheKey);
    // 立即设置登录状态为未登录，确保删除后立即生效
    loginStatusCache.set(cacheKey, {
      result: {
        logged_in: false,
        message: '未登录（凭证已删除）'
      },
      timestamp: Date.now()
    });
    
    // 清除 session 文件缓存（包括 volume 和本地路径的缓存）
    sessionFileCache.clear();
    // 明确清除 volume session 缓存，并设置为不存在
    const volumeCacheKey = `volume_session_${userId}`;
    sessionFileCache.delete(volumeCacheKey);
    // 立即设置 volume session 缓存为不存在，确保删除后立即生效
    sessionFileCache.set(volumeCacheKey, { exists: false, timestamp: Date.now() });
    
    // 4. 清除用户配置缓存（如果存在）
    const configCacheKey = `user_config_${userId}`;
    userConfigCache.delete(configCacheKey);
    
    // 5. 立即验证删除结果，确保缓存反映最新状态
    // 重新检查 volume 中的文件是否存在（不使用缓存）
    try {
      const Docker = require('dockerode');
      const dockerSocketPaths = [
        '/var/run/docker.sock',
        process.env.DOCKER_HOST?.replace('unix://', '') || null
      ].filter(Boolean);
      
      let docker = null;
      for (const socketPath of dockerSocketPaths) {
        if (fs.existsSync(socketPath)) {
          try {
            docker = new Docker({ socketPath });
            await docker.ping();
            break;
          } catch (e) {
            // 继续尝试下一个路径
          }
        }
      }
      
      if (docker) {
        const volumeName = 'tg_session';
        const volumeSessionFileName = `user_${userId}.session`;
        
        try {
          const volume = docker.getVolume(volumeName);
          await volume.inspect();
          
          // 使用临时容器验证文件是否真的被删除
          const tempImage = await getTempContainerImage(docker);
          const verifyContainerName = `tg_session_verify_delete_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          
          try {
            const verifyContainer = await docker.createContainer({
              Image: tempImage,
              name: verifyContainerName,
              Cmd: ['sh', '-c', 'sleep 1'],
              HostConfig: {
                Binds: [
                  `${volumeName}:/tmp/session_volume`
                ]
              }
            });
            
            await verifyContainer.start();
            
            const verifyExec = await verifyContainer.exec({
              Cmd: ['sh', '-c', `test -f /tmp/session_volume/${volumeSessionFileName} && echo "exists" || echo "not_exists"`],
              AttachStdout: true,
              AttachStderr: true
            });
            
            const verifyStream = await verifyExec.start({ hijack: true, stdin: false });
            let verifyOutput = '';
            await new Promise((resolve) => {
              verifyStream.on('data', (chunk) => {
                verifyOutput += chunk.toString();
              });
              verifyStream.on('end', resolve);
            });
            
            const stillExists = verifyOutput.trim().includes('exists');
            
            await verifyContainer.stop();
            await verifyContainer.remove();
            
            // 更新缓存为最新状态
            sessionFileCache.set(volumeCacheKey, { exists: stillExists, timestamp: Date.now() });
            
            if (stillExists) {
              console.warn(`⚠️  [删除凭证] 验证发现文件仍然存在: ${volumeSessionFileName}，将再次尝试删除`);
              // 如果文件仍然存在，再次尝试删除（最多重试1次）
              try {
                const retryImage = await getTempContainerImage(docker);
                const retryContainerName = `tg_session_delete_retry_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                
                const retryContainer = await docker.createContainer({
                  Image: retryImage,
                  name: retryContainerName,
                  Cmd: ['sh', '-c', 'sleep 1'],
                  HostConfig: {
                    Binds: [
                      `${volumeName}:/tmp/session_volume`
                    ]
                  }
                });
                
                await retryContainer.start();
                
                // 强制删除（使用 rm -rf 确保删除）
                const retryExec = await retryContainer.exec({
                  Cmd: ['sh', '-c', `rm -rf /tmp/session_volume/${volumeSessionFileName} /tmp/session_volume/${volumeSessionFileName}-journal && test ! -f /tmp/session_volume/${volumeSessionFileName} && echo "deleted" || echo "still_exists"`],
                  AttachStdout: true,
                  AttachStderr: true
                });
                
                const retryStream = await retryExec.start({ hijack: true, stdin: false });
                let retryOutput = '';
                await new Promise((resolve) => {
                  retryStream.on('data', (chunk) => {
                    retryOutput += chunk.toString();
                  });
                  retryStream.on('end', resolve);
                });
                
                await retryContainer.stop();
                await retryContainer.remove();
                
                if (retryOutput.trim().includes('deleted')) {
                  console.log(`✅ [删除凭证] 重试删除成功: ${volumeSessionFileName}`);
                  sessionFileCache.set(volumeCacheKey, { exists: false, timestamp: Date.now() });
                } else {
                  console.warn(`⚠️  [删除凭证] 重试删除后文件仍然存在: ${volumeSessionFileName}`);
                }
              } catch (retryError) {
                console.warn(`⚠️  [删除凭证] 重试删除失败: ${retryError.message}`);
              }
            } else {
              console.log(`✅ [删除凭证] 验证确认文件已删除: ${volumeSessionFileName}`);
            }
          } catch (e) {
            console.warn(`⚠️  [删除凭证] 验证删除结果失败: ${e.message}`);
          }
        } catch (e) {
          // volume 不存在，跳过验证
        }
      }
    } catch (error) {
      console.warn(`⚠️  [删除凭证] 验证删除结果时出错: ${error.message}`);
    }
    
    console.log(`✅ [删除凭证] 删除完成，共删除 ${deletedFiles.length} 个文件`);
    
    // 6. 最后再次验证并更新缓存，确保状态一致
    try {
      const finalCheck = await checkSessionFileInVolume(userId);
      const volumeCacheKey = `volume_session_${userId}`;
      sessionFileCache.set(volumeCacheKey, { exists: finalCheck, timestamp: Date.now() });
      
      if (finalCheck) {
        console.warn(`⚠️  [删除凭证] 最终验证发现文件仍然存在，可能被容器重新创建`);
      } else {
        console.log(`✅ [删除凭证] 最终验证确认文件已完全删除`);
      }
    } catch (finalCheckError) {
      console.warn(`⚠️  [删除凭证] 最终验证失败: ${finalCheckError.message}`);
    }
    
    if (deletedFiles.length === 0 && errors.length === 0) {
      return res.json({
        status: 'ok',
        message: '未找到需要删除的凭证文件（可能已经删除）',
        deleted_files: []
      });
    }
    
    if (errors.length > 0) {
      return res.json({
        status: 'ok',
        message: `已删除 ${deletedFiles.length} 个文件，但有 ${errors.length} 个错误`,
        deleted_files: deletedFiles,
        errors: errors
      });
    }
    
    res.json({
      status: 'ok',
      message: `成功删除 ${deletedFiles.length} 个凭证文件`,
      deleted_files: deletedFiles
    });
  } catch (error) {
    console.error('❌ [删除凭证] 删除失败:', error);
    res.status(500).json({ error: '删除凭证失败：' + error.message });
  }
});

// 通知Telethon服务重新加载配置（不阻塞，静默失败）
async function notifyTelethonConfigReload(userId = null) {
  try {
    // 如果提供了 userId，通知对应的多开容器；否则通知主容器
    if (userId) {
      // 多开模式：通知对应的多开容器
      // 容器名格式：tg_listener_${userId}
      // 在 Docker 网络中，可以通过容器名访问
      const containerName = `tg_listener_${userId}`;
      const telethonUrl = `http://${containerName}:8888`;
      
      try {
        await axios.post(`${telethonUrl}/api/internal/config/reload`, {}, {
          timeout: 5000,
          headers: {
            'Content-Type': 'application/json',
            ...(INTERNAL_API_TOKEN ? { 'X-Internal-Token': INTERNAL_API_TOKEN } : {})
          }
        });
        console.log(`✅ [配置同步] 已通知多开容器 ${containerName} 重新加载配置`);
      } catch (error) {
        // 静默失败，不影响配置保存
        console.warn(`⚠️  [配置同步] 通知多开容器 ${containerName} 重新加载配置失败（不影响配置保存）:`, error.message);
      }
    } else {
      // 单开模式：通知主容器
      const telethonUrl = await getTelethonServiceUrl(userId);
      try {
        await axios.post(`${telethonUrl}/api/internal/config/reload`, {}, {
          timeout: 5000,
          headers: {
            'Content-Type': 'application/json',
            ...(INTERNAL_API_TOKEN ? { 'X-Internal-Token': INTERNAL_API_TOKEN } : {})
          }
        });
        console.log('✅ [配置同步] 已通知Telethon服务重新加载配置');
      } catch (error) {
        // 静默失败，不影响配置保存
        console.warn('⚠️  [配置同步] 通知Telethon服务重新加载配置失败（不影响配置保存）:', error.message);
      }
    }
  } catch (error) {
    // 静默失败，不影响配置保存
    console.warn('⚠️  [配置同步] 通知Telethon服务重新加载配置失败（不影响配置保存）:', error.message);
  }
}

// 内部 API：发送 Telegram 消息（转发到Telethon服务的HTTP服务器）
app.post('/api/internal/telegram/send', async (req, res) => {
  try {
    const { target, message, userId } = req.body;
    
    if (!target || !message) {
      return res.status(400).json({ error: '缺少必要字段：target 和 message' });
    }
    
    // 转发请求到Telethon服务的HTTP服务器
    try {
      const telethonUrl = await getTelethonServiceUrl(userId);
      console.log(`🔗 [Telegram发送] 使用 Telethon 服务 URL: ${telethonUrl} (userId: ${userId || 'N/A'})`);
      await axios.post(`${telethonUrl}/api/internal/telegram/send`, {
        target,
        message
      }, {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          ...(INTERNAL_API_TOKEN ? { 'X-Internal-Token': INTERNAL_API_TOKEN } : {})
        }
      });
      console.log(`📱 Telegram消息已转发到Telethon服务: target=${target}, userId=${userId || 'N/A'}`);
      res.json({ status: 'ok', message: 'Telegram消息已发送' });
    } catch (error) {
      console.error('❌ 转发到Telethon服务失败:', error.message);
      // 如果Telethon服务不可用，返回错误但不阻塞
      res.status(503).json({ error: 'Telegram发送失败：Telethon服务不可用' });
    }
  } catch (error) {
    console.error('❌ Telegram发送请求处理失败:', error);
    res.status(500).json({ error: '处理失败：' + error.message });
  }
});

// 内部 API：Telethon 服务调用的 AI 分析接口（不需要认证）
app.post('/api/internal/ai/analyze-now', async (req, res) => {
  try {
    const { log_id } = req.body;
    console.log('📋 Telethon 内部 API 调用: AI 分析', log_id ? `(单条消息 ID: ${log_id})` : '(全量分析)');
    
    // 从log_id获取userId
    let userId = null;
    if (log_id) {
      const log = await Log.findById(log_id);
      if (log && log.userId) {
        userId = log.userId.toString();
      }
    }
    
    if (!userId) {
      return res.status(400).json({ error: '无法确定用户ID' });
    }
    
    const result = await performAIAnalysis('user_message', log_id, userId);
    res.json(result);
  } catch (error) {
    console.error('❌ 内部 AI 分析请求失败:', error.message);
    res.status(500).json({ error: '触发 AI 分析失败：' + error.message });
  }
});

// 获取 AI 分析统计信息
app.get('/api/ai/stats', authMiddleware, async (req, res) => {
  // const startTime = Date.now();
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    const userIdObj = new mongoose.Types.ObjectId(userId);
    
    // admin用户可以查看旧数据（没有userId的）
    const isAdmin = username === 'admin';
    const userQuery = isAdmin 
      ? { $or: [{ userId: userIdObj }, { userId: { $exists: false } }, { userId: null }] }
      : { userId: userIdObj };
    const logQuery = isAdmin 
      ? { $or: [{ userId: userIdObj }, { userId: { $exists: false } }, { userId: null }], ai_analyzed: false }
      : { userId: userIdObj, ai_analyzed: false };
    
    // const queryStartTime = Date.now();
    // 并行执行所有查询以提高效率
    const [total, totalMessagesAnalyzed, sentimentStats, riskStats, unanalyzedCount] = await Promise.all([
      AISummary.countDocuments(userQuery),
      AISummary.aggregate([
        { $match: userQuery },
        { $group: { _id: null, total: { $sum: '$message_count' } } }
      ]),
      AISummary.aggregate([
        { $match: userQuery },
        { $group: { _id: '$analysis_result.sentiment', count: { $sum: 1 } } }
      ]),
      AISummary.aggregate([
        { $match: userQuery },
        { $group: { _id: '$analysis_result.risk_level', count: { $sum: 1 } } }
      ]),
      Log.countDocuments(logQuery)
    ]);
    
    // const queryTime = Date.now() - queryStartTime;
    // const totalTime = Date.now() - startTime;
    // if (queryTime > 100) {
    //   console.log(`[性能监控] /api/ai/stats 数据库查询耗时: ${queryTime}ms, 总耗时: ${totalTime}ms`);
    // }
    
    const userConfig = await loadUserConfig(userId);
    const config = userConfig.toObject ? userConfig.toObject() : userConfig;
    const aiConfig = config.ai_analysis || {};
    
    res.json({
      total_analyses: total,
      total_messages_analyzed: totalMessagesAnalyzed[0]?.total || 0,
      unanalyzed_messages: unanalyzedCount,
      sentiment_distribution: sentimentStats,
      risk_distribution: riskStats,
      ai_config: {
        enabled: aiConfig.enabled || false,
        model: aiConfig.openai_model || 'gpt-3.5-turbo',
        trigger_type: aiConfig.analysis_trigger_type || 'time',
        time_interval: aiConfig.time_interval_minutes || 30,
        count_threshold: aiConfig.message_count_threshold || 50,
        api_configured: !!(aiConfig.openai_api_key)
      }
    });
  } catch (error) {
    res.status(500).json({ error: '获取 AI 统计信息失败：' + error.message });
  }
});

// 重启 AI 分析定时器（配置更新后调用）
app.post('/api/ai/restart-timer', authMiddleware, async (req, res) => {
  try {
    await startAIAnalysisTimer();
    res.json({ status: 'ok', message: 'AI 分析定时器已重启' });
  } catch (error) {
    res.status(500).json({ error: '重启定时器失败：' + error.message });
  }
});

// ===== 健康检查 =====
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ===== AI 分析功能 =====
// AI分析定时器：
// - 旧实现：每个用户一个 setInterval（用户多时会形成定时器风暴，CPU 峰值明显）
// - 新实现：单一调度器 tick 扫描“到期用户”，并为自动触发加全局并发上限，降低 CPU 峰值
let aiAnalysisTimer = null;
let aiTimeSchedulerTimer = null;
const aiTimeSchedules = new Map(); // userId -> { intervalMs, nextAt, username }
const analyzingLocks = new Map(); // 防止重复提交：存储正在分析的用户ID和触发类型

// 自动触发（time/count）全局并发限制：避免同时跑太多 AI 分析把 CPU 顶满
const AI_AUTO_CONCURRENCY = Math.max(1, Number(process.env.AI_AUTO_CONCURRENCY || 2));
let aiAutoRunning = 0;
const aiAutoWaiters = [];
function acquireAIAutoSlot() {
  return new Promise((resolve) => {
    const grant = () => {
      aiAutoRunning += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        aiAutoRunning = Math.max(0, aiAutoRunning - 1);
        const next = aiAutoWaiters.shift();
        if (next) next();
      });
    };
    if (aiAutoRunning < AI_AUTO_CONCURRENCY) {
      grant();
    } else {
      aiAutoWaiters.push(grant);
    }
  });
}

// 事件驱动的“计数触发”状态（避免每条消息 countDocuments / 每分钟扫库）
const countTriggerConfigMap = new Map(); // userId -> { threshold, username }
const countTriggerCounters = new Map(); // userId -> currentCount
const countTriggerReconcileTimers = new Map(); // userId -> timeoutId
let countTriggerConfigRefreshDebounceTimer = null;
let countTriggerConfigsReady = false; // 启动早期/刷新中：用于避免漏触发
const pendingCountIncrements = new Map(); // userId -> pendingIncrements

function scheduleCountTriggerConfigRefresh(userIdStr = null, delayMs = 800) {
  // 防抖：短时间内多次保存配置只触发一次刷新
  if (countTriggerConfigRefreshDebounceTimer) clearTimeout(countTriggerConfigRefreshDebounceTimer);
  countTriggerConfigRefreshDebounceTimer = setTimeout(async () => {
    countTriggerConfigRefreshDebounceTimer = null;
    await refreshCountTriggerConfigs();
    countTriggerConfigsReady = true;
    await applyPendingCountIncrements();
    // 配置变更后对该用户做一次轻量对账（如果该用户仍启用 count 触发）
    if (userIdStr) {
      await reconcileCountTriggerUserOnce(String(userIdStr));
    }
  }, Math.max(200, delayMs));
}

async function applyPendingCountIncrements() {
  if (pendingCountIncrements.size === 0) return;
  for (const [userIdStr, inc] of pendingCountIncrements.entries()) {
    pendingCountIncrements.delete(userIdStr);
    try {
      await handleCountTriggerOnNewMessage(userIdStr, Number(inc) || 0);
    } catch {
      // ignore
    }
  }
}

async function refreshCountTriggerConfigs() {
  try {
    const configs = await UserConfig.find({
      'ai_analysis.enabled': true,
      'ai_analysis.analysis_trigger_type': 'count'
    }).select('userId ai_analysis.message_count_threshold').lean();

    if (!configs || configs.length === 0) {
      countTriggerConfigMap.clear();
      return;
    }

    const userIds = configs.map(c => c.userId).filter(Boolean);
    const activeUsers = await User.find({ is_active: true, _id: { $in: userIds } })
      .select('_id username')
      .lean();
    const activeUserMap = new Map(activeUsers.map(u => [u._id.toString(), u]));

    countTriggerConfigMap.clear();
    for (const cfg of configs) {
      const userIdStr = (cfg.userId || '').toString();
      const user = activeUserMap.get(userIdStr);
      if (!user) continue;
      const threshold = Math.max(1, Number(cfg?.ai_analysis?.message_count_threshold) || 50);
      countTriggerConfigMap.set(userIdStr, { threshold, username: user.username });
      if (!countTriggerCounters.has(userIdStr)) countTriggerCounters.set(userIdStr, 0);
    }
  } catch (e) {
    // 刷新失败不影响主流程；沿用旧配置
  }
}

async function recheckAndRetriggerIfBacklog(userIdStr, threshold) {
  // 只在触发后做一次快速复查，避免 backlog 很大却只触发一次
  try {
    const userIdObj = new mongoose.Types.ObjectId(userIdStr);
    const clearCooldownTime = new Date(Date.now() - 5 * 60 * 1000);
    const docs = await Log.find({
      userId: userIdObj,
      ai_analyzed: false,
      $or: [
        { ai_cleared_at: null },
        { ai_cleared_at: { $lt: clearCooldownTime } }
      ]
    }).limit(threshold).select('_id').lean();

    if (docs.length >= threshold) {
      let release = null;
      try {
        release = await acquireAIAutoSlot();
        await performAIAnalysis('count', null, userIdStr);
      } finally {
        if (release) release();
      }
    }
  } catch {
    // ignore
  }
}

async function reconcileCountTriggerUserOnce(userIdStr) {
  const cfg = countTriggerConfigMap.get(userIdStr);
  if (!cfg) return;
  await recheckAndRetriggerIfBacklog(userIdStr, cfg.threshold);
}

async function reconcileAllCountTriggersOnce() {
  for (const userIdStr of countTriggerConfigMap.keys()) {
    // 串行对账：每个用户只是一个 limit(threshold) 轻量查询；串行更稳，不制造峰值
    // 真正触发 AI 分析仍会走全局并发限制
    await reconcileCountTriggerUserOnce(userIdStr);
  }
}

function scheduleCountTriggerReconcileOnce(userIdStr, delayMs = 30000) {
  // 防抖：同一用户只保留一个对账计时器
  const prev = countTriggerReconcileTimers.get(userIdStr);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    countTriggerReconcileTimers.delete(userIdStr);
    reconcileCountTriggerUserOnce(userIdStr).catch(() => {});
  }, Math.max(1000, delayMs));
  countTriggerReconcileTimers.set(userIdStr, t);
}

async function handleCountTriggerOnNewMessage(userIdStr, increment = 1) {
  const cfg = countTriggerConfigMap.get(userIdStr);
  if (!cfg) return;

  const threshold = cfg.threshold;
  const inc = Math.max(0, Number(increment) || 0);
  const current = (countTriggerCounters.get(userIdStr) || 0) + inc;
  if (current < threshold) {
    countTriggerCounters.set(userIdStr, current);
    return;
  }

  // 达到阈值：保留余数，触发一次分析（后续 backlog 复查会继续补触发）
  countTriggerCounters.set(userIdStr, current % threshold);
  console.log(`📊 [事件计数触发] 用户 ${cfg.username || userIdStr} 达到阈值 ${threshold}，触发 AI 分析`);

  (async () => {
    let release = null;
    try {
      release = await acquireAIAutoSlot();
      await performAIAnalysis('count', null, userIdStr);
    } catch (e) {
      // 触发失败：安排一次性延迟对账，避免漏触发（不做周期轮询）
      scheduleCountTriggerReconcileOnce(userIdStr, 30000);
    } finally {
      if (release) release();
    }
    await recheckAndRetriggerIfBacklog(userIdStr, threshold);
  })();
}

function enqueueCountTriggerIncrement(userIdStr, inc = 1) {
  const id = String(userIdStr);
  const add = Math.max(0, Number(inc) || 0);
  if (!id || add <= 0) return;

  if (!countTriggerConfigsReady) {
    // 启动早期/首次消息：先缓存增量，触发一次立即刷新，避免漏触发
    pendingCountIncrements.set(id, (pendingCountIncrements.get(id) || 0) + add);
    scheduleCountTriggerConfigRefresh(null, 0);
    return;
  }

  handleCountTriggerOnNewMessage(id, add).catch(() => {});
}

// 执行 AI 批量分析
async function performAIAnalysis(triggerType = 'manual', logId = null, userId = null) {
  if (!userId) {
    return { success: false, error: '用户ID不能为空' };
  }
  
  // 检查是否正在分析（防止重复提交）
  // 对于手动触发和固定用户触发，允许并发（因为用户可能想立即分析）
  // 对于自动触发（count/time），防止重复提交
  const lockKey = `${userId}_${triggerType}`;
  if (triggerType !== 'manual' && triggerType !== 'user_message') {
    if (analyzingLocks.has(lockKey)) {
      const lockTime = analyzingLocks.get(lockKey);
      const lockAge = Date.now() - lockTime;
      // 如果锁超过10分钟，可能是异常情况，清除锁
      if (lockAge > 600000) {
        console.warn(`⚠️  [AI分析] 检测到异常锁（超过10分钟），清除: ${lockKey}`);
        analyzingLocks.delete(lockKey);
      } else {
        console.log(`⏸️  [AI分析] 用户 ${userId} 的 ${triggerType} 分析正在进行中（${Math.round(lockAge/1000)}秒前开始），跳过重复请求`);
        return { success: false, error: '分析正在进行中，请勿重复提交' };
      }
    }
    
    // 设置分析锁
    analyzingLocks.set(lockKey, Date.now());
    console.log(`🔒 [AI分析] 设置分析锁: ${lockKey}`);
  }
  
  try {
    const userConfig = await loadUserConfig(userId);
    const config = userConfig.toObject ? userConfig.toObject() : userConfig;
    
    if (!config.ai_analysis?.enabled) {
      console.log('⏸️  AI 分析功能未启用');
      return { success: false, error: 'AI 分析功能未启用' };
    }

    const aiService = new AIAnalysisService(config.ai_analysis);
    
    if (!aiService.isConfigured()) {
      console.log('⚠️  AI 分析配置不完整');
      return { success: false, error: 'OpenAI API Key 未配置' };
    }
    const userIdObj = new mongoose.Types.ObjectId(userId);
    
    // 查询未分析的消息
    let unanalyzedMessages;
    if (logId) {
      // 如果指定了 logId，只分析这一条消息
      const singleMessage = await Log.findOne({ 
        _id: new mongoose.Types.ObjectId(logId),
        userId: userIdObj
      });
      if (!singleMessage) {
        console.log('❌ 指定的消息不存在');
        return { success: false, error: '指定的消息不存在' };
      }
      unanalyzedMessages = [singleMessage];
      console.log(`🎯 固定用户触发：只分析单条消息 ID: ${logId}`);
    } else {
      // 否则分析所有未分析的消息
      // 使用配置中的最大消息数限制，避免token超限
      const maxMessages = config.ai_analysis?.max_messages_per_analysis || 500;
      
      // 查询未分析的消息（不区分admin，因为这里是按userId查询的）
      // 排除最近被清除的消息（清除后5分钟内不自动分析，防止清除后立即被重新分析）
      const clearCooldownMinutes = 5; // 清除后5分钟内不自动分析
      const clearCooldownTime = new Date(Date.now() - clearCooldownMinutes * 60 * 1000);
      
      // 添加时间窗口检查：排除最近30秒内可能正在被分析的消息
      // 这样可以避免多个触发源同时分析相同的消息
      const analysisCooldownTime = new Date(Date.now() - 30000); // 30秒前
      
      const baseFilter = { 
        userId: userIdObj, 
        ai_analyzed: false,
        $or: [
          { ai_cleared_at: null }, // 从未被清除过
          { ai_cleared_at: { $lt: clearCooldownTime } } // 或者清除时间已经超过5分钟
        ]
      };

      // CPU/IO 优化：不用 countDocuments 全量计数；改为 limit(max+1) 判断是否还有更多
      const docs = await Log.find(baseFilter)
        .sort({ time: -1 })
        .limit(maxMessages + 1);

      const hasMore = docs.length > maxMessages;
      unanalyzedMessages = hasMore ? docs.slice(0, maxMessages) : docs;

      if (hasMore) {
        console.log(`⚠️  未分析消息超过 ${maxMessages}，仅分析最近 ${maxMessages} 条（受最大消息数限制）`);
        console.log(`💡 提示：可以调整"最大消息数"配置，或分批手动分析`);
      }
      
      console.log(`📊 查询到 ${unanalyzedMessages.length} 条未分析消息 (触发方式: ${triggerType}, 最大限制: ${maxMessages})`);
    }

    if (unanalyzedMessages.length === 0) {
      console.log('📭 没有待分析的消息');
      return { success: true, message: '没有待分析的消息', message_count: 0 };
    }

    console.log(`🤖 开始 AI 分析 ${unanalyzedMessages.length} 条消息 (触发方式: ${triggerType})...`);

    // 准备分析数据
    const messagesToAnalyze = unanalyzedMessages.map(log => ({
      text: log.message,
      sender: log.sender,
      channel: log.channel,
      timestamp: log.time
    }));

    // 根据触发类型选择提示词
    let customPrompt = null;
    if (triggerType === 'user_message') {
      // 固定用户触发：使用专用提示词，如果为空则使用空字符串
      customPrompt = config.ai_analysis?.ai_trigger_prompt || '';
      console.log(`📝 固定用户触发使用专用提示词: ${customPrompt ? `"${customPrompt.substring(0, 50)}..."` : '(空)'}`);
    }
    
    // 调用 AI 分析服务
    const analysisResult = await aiService.analyzeMessages(messagesToAnalyze, 0, customPrompt);

    if (!analysisResult.success) {
      console.error('❌ AI 分析失败:', analysisResult.error);
      return analysisResult;
    }

    // 保存分析结果
    const summary = new AISummary({
      userId: userIdObj,
      message_count: unanalyzedMessages.length,
      messages_analyzed: unanalyzedMessages.map(log => ({
        log_id: log._id,
        text: log.message,
        sender: log.sender,
        channel: log.channel,
        timestamp: log.time
      })),
      analysis_result: analysisResult.analysis,
      model_info: {
        model: analysisResult.model,
        tokens_used: analysisResult.tokens_used
      },
      trigger_type: triggerType
    });

    await summary.save();

    // 标记消息为已分析
    // 同时清除 ai_cleared_at 标记，因为消息已经被重新分析
    const messageIds = unanalyzedMessages.map(log => log._id);
    await Log.updateMany(
      { _id: { $in: messageIds }, userId: userIdObj },
      { $set: { ai_analyzed: true, ai_summary_id: summary._id, ai_cleared_at: null } }
    );

    console.log(`✅ AI 分析完成，情感: ${analysisResult.analysis.sentiment}, 风险: ${analysisResult.analysis.risk_level}`);
    
    // 根据配置发送告警
    // 注意：对于固定用户触发（triggerType === 'user_message'），Telethon服务已经发送了结果给触发用户
    // 这里只发送给 alert_target（如果配置了），避免重复发送
    const aiSendTelegram = config.ai_analysis?.ai_send_telegram !== false; // 默认启用
    const aiSendEmail = config.ai_analysis?.ai_send_email || false;
    const aiSendWebhook = config.ai_analysis?.ai_send_webhook || false;
    
    // 对于固定用户触发，Telethon已经发送了结果，这里只发送给 alert_target（如果 alert_target 不是触发用户）
    const shouldSendTelegram = aiSendTelegram && config.alert_target && triggerType !== 'user_message';
    
    if (shouldSendTelegram || aiSendEmail || aiSendWebhook) {
      const alertMessage = `🤖 AI 分析完成\n\n总分析消息数: ${unanalyzedMessages.length}\n情感倾向: ${analysisResult.analysis.sentiment}\n风险等级: ${analysisResult.analysis.risk_level}\n\n摘要:\n${analysisResult.analysis.summary}\n\n关键词: ${(analysisResult.analysis.keywords || []).join(', ')}`;
      
      // 发送 Telegram 告警（直接通过Telethon服务发送）
      // 注意：固定用户触发时，Telethon已经发送了结果，这里不再发送
      if (shouldSendTelegram) {
        try {
          // 直接调用Telethon服务的HTTP接口发送消息
          const telethonUrl = await getTelethonServiceUrl(userId);
          console.log(`🔗 [AI分析] 使用 Telethon 服务 URL: ${telethonUrl}`);
          await axios.post(`${telethonUrl}/api/internal/telegram/send`, {
            target: config.alert_target,
            message: alertMessage
          }, {
            timeout: 10000,
            headers: {
              'Content-Type': 'application/json',
              ...(INTERNAL_API_TOKEN ? { 'X-Internal-Token': INTERNAL_API_TOKEN } : {})
            }
          });
          console.log('📱 AI 分析结果已通过 Telegram 发送到:', config.alert_target);
        } catch (error) {
          console.error('❌ Telegram 发送失败:', error.message);
        }
      } else if (triggerType === 'user_message' && aiSendTelegram) {
        console.log('ℹ️  固定用户触发：Telethon服务已发送分析结果给触发用户，不再发送到 alert_target');
      }
      
      // 发送邮件告警
      if (aiSendEmail && config.alert_actions?.email?.enable) {
        try {
          await sendEmail(config.alert_actions.email, '🤖 AI 分析结果通知', alertMessage);
          console.log('📧 AI 分析结果已通过邮件发送');
        } catch (error) {
          console.error('❌ 邮件发送失败:', error.message);
        }
      }
      
      // 发送 Webhook 告警
      if (aiSendWebhook && config.alert_actions?.webhook?.enable && config.alert_actions.webhook.url) {
        try {
          await axios.post(config.alert_actions.webhook.url, {
            type: 'ai_analysis',
            timestamp: new Date().toISOString(),
            message_count: unanalyzedMessages.length,
            sentiment: analysisResult.analysis.sentiment,
            risk_level: analysisResult.analysis.risk_level,
            summary: analysisResult.analysis.summary,
            keywords: analysisResult.analysis.keywords
          });
          console.log('🔗 AI 分析结果已通过 Webhook 发送');
        } catch (error) {
          console.error('❌ Webhook 发送失败:', error.message);
        }
      }
    }
    
    // 实时推送AI分析完成事件（包含userId以便前端过滤）
    // 实时推送AI分析完成事件（只推送给该用户）
    broadcastEvent('ai_analysis_complete', {
      userId: userId,
      summary_id: summary._id,
      message_count: unanalyzedMessages.length,
      trigger_type: triggerType,
      analysis: analysisResult.analysis
    }, userId);
    
    // 推送AI统计更新事件（只推送给该用户）
    broadcastEvent('ai_stats_updated', { userId: userId }, userId);

    return {
      success: true,
      summary_id: summary._id,
      message_count: unanalyzedMessages.length,
      analysis: analysisResult.analysis
    };

  } catch (error) {
    console.error('❌ AI 分析过程出错:', error);
    return { success: false, error: error.message };
  } finally {
    // 释放分析锁（无论成功还是失败都要释放）
    if (triggerType !== 'manual' && triggerType !== 'user_message') {
      const lockKey = `${userId}_${triggerType}`;
      analyzingLocks.delete(lockKey);
      console.log(`🔓 [AI分析] 释放分析锁: ${lockKey}`);
    }
  }
}

// 启动 AI 分析定时器（为所有启用了AI的用户执行）
async function startAIAnalysisTimer() {
  // 清除所有现有定时器/调度器
  if (aiAnalysisTimer) {
    clearInterval(aiAnalysisTimer);
    aiAnalysisTimer = null;
  }
  if (aiTimeSchedulerTimer) {
    clearInterval(aiTimeSchedulerTimer);
    aiTimeSchedulerTimer = null;
  }
  aiTimeSchedules.clear();
  
  try {
    // 只筛选启用了 time 触发的用户配置，避免对所有 active 用户逐个 loadUserConfig
    const timeConfigs = await UserConfig.find({
      'ai_analysis.enabled': true,
      'ai_analysis.analysis_trigger_type': 'time'
    }).select('userId ai_analysis.time_interval_minutes').lean();

    if (!timeConfigs || timeConfigs.length === 0) {
      console.log('ℹ️  没有用户启用时间间隔触发的AI分析');
      return;
    }

    const userIds = timeConfigs.map(c => c.userId).filter(Boolean);
    const activeUsers = await User.find({ is_active: true, _id: { $in: userIds } })
      .select('_id username')
      .lean();
    const activeUserMap = new Map(activeUsers.map(u => [u._id.toString(), u]));

    for (const cfg of timeConfigs) {
      const userIdStr = (cfg.userId || '').toString();
      const user = activeUserMap.get(userIdStr);
      if (!user) continue; // 非活跃用户跳过

      const intervalMinutes = Number(cfg?.ai_analysis?.time_interval_minutes) || 30;
      const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;
      // 初始 nextAt 加少量抖动，避免所有用户同一时刻触发造成 CPU 峰值
      const jitterMs = Math.floor(Math.random() * Math.min(30000, intervalMs));
      aiTimeSchedules.set(userIdStr, {
        intervalMs,
        nextAt: Date.now() + jitterMs,
        username: user.username
      });
    }

    // 单调度器：每 5 秒检查一次到期用户（轻量），到期则触发并更新 nextAt
    const TICK_MS = 5000;
    aiTimeSchedulerTimer = setInterval(async () => {
      const now = Date.now();
      for (const [userIdStr, sched] of aiTimeSchedules.entries()) {
        if (!sched || !sched.nextAt || now < sched.nextAt) continue;

        // 计算下一次触发时间：使用 now + interval 并叠加少量抖动，避免长期同相位
        const jitter = Math.floor(Math.random() * Math.min(5000, sched.intervalMs));
        sched.nextAt = now + sched.intervalMs + jitter;
        aiTimeSchedules.set(userIdStr, sched);

        // 全局并发限制：只对自动触发（time）生效
        let release = null;
        try {
          release = await acquireAIAutoSlot();
          console.log(`⏰ [定时触发] 用户 ${sched.username || userIdStr} 执行定时 AI 分析`);
          await performAIAnalysis('time', null, userIdStr);
        } catch (err) {
          console.error(`❌ [定时触发] 用户 ${sched.username || userIdStr} AI分析失败:`, err.message);
        } finally {
          if (release) release();
        }
      }
    }, TICK_MS);

    console.log(`✅ AI 定时分析已启动，共 ${aiTimeSchedules.size} 个用户纳入调度（并发上限: ${AI_AUTO_CONCURRENCY}）`);
  } catch (err) {
    console.error('启动AI分析定时器失败:', err);
  }
}

// 监听新消息（用于计数触发）
async function checkMessageCountTrigger() {
  try {
    // 只筛选启用了 count 触发的用户配置，避免每分钟对所有 active 用户逐个 loadUserConfig
    const countConfigs = await UserConfig.find({
      'ai_analysis.enabled': true,
      'ai_analysis.analysis_trigger_type': 'count'
    }).select('userId ai_analysis.message_count_threshold').lean();

    if (!countConfigs || countConfigs.length === 0) {
      return;
    }

    const userIds = countConfigs.map(c => c.userId).filter(Boolean);
    const activeUsers = await User.find({ is_active: true, _id: { $in: userIds } })
      .select('_id username')
      .lean();
    const activeUserMap = new Map(activeUsers.map(u => [u._id.toString(), u]));

    // 排除最近被清除的消息（清除后5分钟内不自动分析）
    const clearCooldownMinutes = 5;
    const clearCooldownTime = new Date(Date.now() - clearCooldownMinutes * 60 * 1000);

    for (const cfg of countConfigs) {
      const userIdStr = (cfg.userId || '').toString();
      const user = activeUserMap.get(userIdStr);
      if (!user) continue;

      const threshold = Math.max(1, Number(cfg?.ai_analysis?.message_count_threshold) || 50);
      const userIdObj = new mongoose.Types.ObjectId(userIdStr);

      // CPU/IO 优化：不用 countDocuments 全量计数，而是 limit(threshold) 早停查询
      // 达到阈值即可触发，避免在数据大时反复扫描。
      const docs = await Log.find({
        userId: userIdObj,
        ai_analyzed: false,
        $or: [
          { ai_cleared_at: null },
          { ai_cleared_at: { $lt: clearCooldownTime } }
        ]
      }).limit(threshold).select('_id').lean();

      if (docs.length >= threshold) {
        console.log(`📊 [计数触发] 用户 ${user.username} 未分析消息达到阈值 ${threshold}（>=），触发 AI 分析`);
        // 全局并发限制：只对自动触发（count）生效
        let release = null;
        try {
          release = await acquireAIAutoSlot();
          await performAIAnalysis('count', null, userIdStr);
        } finally {
          if (release) release();
        }
      }
    }
  } catch (err) {
    console.error('❌ [计数触发检查] 检查消息计数触发失败:', err);
    console.error('错误堆栈:', err.stack);
  }
}

// 已取消兜底轮询：
// - 事件驱动计数触发为主（/api/internal/message-notify）
// - 启动时做一次性对账
// - 触发失败时做一次性延迟对账

// 全局错误处理，防止未捕获的异常导致服务崩溃
process.on('uncaughtException', (error) => {
  console.error('❌ [未捕获异常] 捕获到未处理的异常:', error.message);
  console.error('错误堆栈:', error.stack);
  // 不退出进程，让服务继续运行
  // 在生产环境中，可以考虑重启或记录到日志系统
  // 注意：某些致命错误（如内存不足）仍可能导致进程退出
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ [未处理的 Promise 拒绝] 捕获到未处理的 Promise 拒绝:', reason);
  if (reason instanceof Error) {
    console.error('错误堆栈:', reason.stack);
  }
  // 不退出进程，让服务继续运行
});

// 监听进程退出信号
process.on('SIGTERM', () => {
  console.log('收到 SIGTERM 信号，正在优雅关闭...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('收到 SIGINT 信号，正在优雅关闭...');
  process.exit(0);
});

// 启动时初始化多开登录容器
async function initializeMultiLoginContainers() {
  try {
    console.log('🔄 [启动初始化] 开始检查多开登录模式...');
    
    // 等待数据库连接稳定
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const Docker = require('dockerode');
    const dockerSocketPaths = [
      '/var/run/docker.sock',
      process.env.DOCKER_HOST?.replace('unix://', '') || null
    ].filter(Boolean);
    
    let docker = null;
    for (const socketPath of dockerSocketPaths) {
      if (fs.existsSync(socketPath)) {
        try {
          docker = new Docker({ socketPath });
          await docker.ping();
          break;
        } catch (e) {
          // 继续尝试下一个路径
        }
      }
    }
    
    if (!docker) {
      console.warn('⚠️  [启动初始化] 无法连接到 Docker，跳过多开登录初始化');
      return;
    }
    
    console.log('✅ [启动初始化] Docker 连接成功');
    
    // 获取所有主账号
    const mainAccounts = await User.find({ 
      is_active: true, 
      parent_account_id: null 
    });
    
    console.log(`📋 [启动初始化] 找到 ${mainAccounts.length} 个主账号`);
    
    if (mainAccounts.length === 0) {
      console.log('ℹ️  [启动初始化] 没有主账号，跳过多开登录初始化');
      return;
    }
    
    for (const account of mainAccounts) {
      try {
        const accountConfig = await loadUserConfig(account._id.toString());
        const multiLoginEnabled = accountConfig.multi_login_enabled || false;
        
        if (!multiLoginEnabled) {
          continue; // 该账号未启用多开登录，跳过
        }
        
        console.log(`🔍 [启动初始化] 账号 ${account.username} 已启用多开登录，检查已登录账号...`);
        
        // 停止主容器（如果正在运行）。
        // 关键：如果后续多开容器全部启动失败，需要把主容器恢复启动，避免“收不到消息”
        let mainWasRunning = false;
        let mainContainerRef = null;
        try {
          const containers = await docker.listContainers({ all: true });
          const mainContainer = containers.find(c => {
            if (!c.Names || c.Names.length === 0) return false;
            return c.Names.some(name => {
              const cleanName = name.replace(/^\//, '');
              return cleanName === 'tg_listener';
            });
          });
          
          if (mainContainer) {
            const container = docker.getContainer(mainContainer.Id);
            mainContainerRef = container;
            const inspect = await container.inspect();
            
            // 停止主容器（如果正在运行）
            if (inspect.State.Running || inspect.State.Restarting) {
              mainWasRunning = true;
              console.log(`🛑 [启动初始化] 停止主容器 tg_listener（多开模式下不使用）...`);
              try {
                await container.stop({ t: 10 });
                console.log(`✅ [启动初始化] 主容器已停止`);
                
                // 注意：由于 docker-compose 的 restart: on-failure:5 策略，
                // 主容器在正常停止后不会自动重启（只有在失败退出时才会重启）
                // 但如果 docker-compose up 或重启服务，主容器可能会重新启动
                // 因此每次切换到多开模式时，都需要确保主容器已停止
              } catch (stopError) {
                console.warn(`⚠️  [启动初始化] 停止主容器失败: ${stopError.message}`);
              }
            } else {
              console.log(`ℹ️  [启动初始化] 主容器 tg_listener 已停止，无需操作`);
            }
          }
        } catch (stopError) {
          console.warn(`⚠️  [启动初始化] 停止主容器失败: ${stopError.message}`);
        }
        
        // 获取该账号下的所有用户（包括主账号和子账号）
        const accountIdObj = new mongoose.Types.ObjectId(account._id);
        const accountUsers = await User.find({
          $or: [
            { _id: accountIdObj },
            { parent_account_id: accountIdObj }
          ]
        }).select('_id username is_active').lean();
        
        console.log(`📋 [启动初始化] 账号 ${account.username} 下共有 ${accountUsers.length} 个用户（包括主账号和子账号）`);
        
        // 为每个已登录的用户启动独立容器（必须至少一个 Running 才算多开初始化成功）
        let anyMultiRunning = false;
        for (const user of accountUsers) {
          try {
            const userId = user._id.toString();
            const PROJECT_ROOT = process.env.PROJECT_ROOT || '/opt/telegram-monitor';
            const sessionPath = path.join(PROJECT_ROOT, 'data', 'session', `user_${userId}.session`);
            
            // 检查 session 文件是否存在
            if (fs.existsSync(sessionPath)) {
              const stats = fs.statSync(sessionPath);
              if (stats.isFile() && stats.size > 0) {
                console.log(`✅ [启动初始化] 用户 ${user.username} (${userId}) 已登录，启动独立容器...`);
                
                // 启动该用户的独立容器
                const ok = await syncUserConfigAndStartMultiLoginContainer(userId);
                if (ok) {
                  anyMultiRunning = true;
                }
                
                // 等待一小段时间，避免同时启动太多容器
                await new Promise(resolve => setTimeout(resolve, 1000));
              } else {
                console.log(`⏭️  [启动初始化] 用户 ${user.username} (${userId}) session 文件无效（大小为 0），跳过`);
              }
            } else {
              console.log(`⏭️  [启动初始化] 用户 ${user.username} (${userId}) 未登录（session 文件不存在），跳过`);
            }
          } catch (userError) {
            console.error(`❌ [启动初始化] 启动用户 ${user.username} 的容器失败: ${userError.message}`);
            console.error(`   错误堆栈: ${userError.stack}`);
            // 继续处理下一个用户，不中断整个流程
          }
        }

        // 如果多开容器一个都没跑起来，恢复主监听，避免监听真空
        if (!anyMultiRunning) {
          console.warn(`⚠️  [启动初始化] 账号 ${account.username} 多开容器全部启动失败，将恢复主容器 tg_listener 以保证继续收消息`);
          if (mainWasRunning && mainContainerRef) {
            try {
              await mainContainerRef.start();
              console.log('✅ [启动初始化] 主容器 tg_listener 已恢复启动');
            } catch (e) {
              console.error(`❌ [启动初始化] 恢复主容器失败: ${e.message}`);
            }
          }
        }
      } catch (accountError) {
        console.error(`❌ [启动初始化] 处理账号 ${account.username} 失败: ${accountError.message}`);
      }
    }
    
    console.log('✅ [启动初始化] 多开登录容器初始化完成');
    
    // 验证所有容器是否已启动
    try {
      const containers = await docker.listContainers({ all: true });
      const listenerContainers = containers.filter(c => {
        if (!c.Names || c.Names.length === 0) return false;
        return c.Names.some(name => {
          const cleanName = name.replace(/^\//, '');
          return cleanName.startsWith('tg_listener_');
        });
      });
      
      console.log(`📊 [启动初始化] 当前运行的多开容器数量: ${listenerContainers.length}`);
      for (const container of listenerContainers) {
        const containerName = container.Names[0].replace(/^\//, '');
        const status = container.State === 'running' ? '✅ 运行中' : `⚠️  ${container.State}`;
        console.log(`   - ${containerName}: ${status}`);
      }
    } catch (verifyError) {
      console.warn(`⚠️  [启动初始化] 验证容器状态失败: ${verifyError.message}`);
    }
  } catch (error) {
    console.error('❌ [启动初始化] 初始化多开登录容器失败:', error.message);
    console.error('   错误堆栈:', error.stack);
    // 不抛出错误，让服务继续启动
  }
}

// 自动检测 telethon 镜像更新，并触发多开容器重建（无需手动删容器）
function startTelethonImageAutoUpdater() {
  const enabled = parseBoolEnv(process.env.MULTI_LOGIN_AUTO_UPDATE_IMAGE, true);
  if (!enabled) return;
  // 默认 20 秒会导致频繁 docker inspect（高 CPU/IO），改为更合理的默认值：5 分钟
  const intervalSec = Number(process.env.MULTI_LOGIN_AUTO_UPDATE_INTERVAL_SECONDS || 300);
  const intervalMs = Math.max(30, isNaN(intervalSec) ? 300 : intervalSec) * 1000;

  let lastImageId = null;
  setInterval(async () => {
    try {
      const Docker = require('dockerode');
      const docker = new Docker({ socketPath: '/var/run/docker.sock' });
      const imageName = getDesiredTelethonImageName();
      const imgInfo = await docker.getImage(imageName).inspect();
      const currentId = imgInfo?.Id || null;
      if (!currentId) return;
      if (!lastImageId) {
        lastImageId = currentId;
        return;
      }
      if (currentId !== lastImageId) {
        console.log(`🔄 [多开登录] 检测到 Telethon 镜像更新：${imageName}`);
        console.log(`   - 旧: ${lastImageId}`);
        console.log(`   - 新: ${currentId}`);
        lastImageId = currentId;
        await initializeMultiLoginContainers();
      }
    } catch (e) {
      // 不影响主流程
    }
  }, intervalMs);
}

// 启动服务器
// 在 Docker 容器中必须监听 0.0.0.0，否则其他容器无法访问
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ API 服务运行在端口 ${PORT}`);
  console.log(`📝 默认用户名: admin`);
  console.log(`📝 默认密码: admin123`);
  console.log(`⚠️  请及时修改默认密码！`);
  
  // 启动时初始化多开登录容器（延迟执行，等待数据库连接）
  setTimeout(async () => {
    console.log('⏳ [启动] 等待数据库连接稳定后初始化多开登录容器...');
    await initializeMultiLoginContainers();
  }, 8000); // 延迟8秒，确保数据库连接和用户数据已完全加载
  
  // 启动 AI 分析
  setTimeout(async () => {
    await startAIAnalysisTimer();
  }, 3000);

  // 启动计数触发配置刷新（事件驱动触发需要阈值配置缓存）
  setTimeout(async () => {
    await refreshCountTriggerConfigs();
    countTriggerConfigsReady = true;
    await applyPendingCountIncrements();
    // 启动时一次性对账：补触发可能的 backlog（不再做周期兜底轮询）
    await reconcileAllCountTriggersOnce();
  }, 3500);
});
