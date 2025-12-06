const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const Joi = require('joi');
require('dotenv').config();

const Log = require('./logModel');
const AISummary = require('./aiSummaryModel');
const User = require('./userModel');
const UserConfig = require('./userConfigModel');
const AIAnalysisService = require('./services/aiAnalysis');

const app = express();

// SSE 客户端连接池
const sseClients = new Set();

// 🔒 信任反向代理（用于 X-Forwarded-For 头部，在 Docker + Nginx 环境中必需）
app.set('trust proxy', 1);

app.use(express.json());

// 🔒 配置 CORS 白名单
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost', 'http://localhost:3000', 'http://127.0.0.1'];

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
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
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';
const PORT = process.env.PORT || 3000;

// 🔒 启动时验证 JWT_SECRET
if (!process.env.JWT_SECRET || JWT_SECRET === 'your-secret-key-change-this') {
  console.error('❌ 致命错误：JWT_SECRET 未设置或使用默认值！');
  console.error('请设置环境变量 JWT_SECRET 为强随机值（使用 install.sh 或手动设置）');
  process.exit(1);
}

// 默认配置
const defaultConfig = {
  keywords: [],
  channels: [],
  alert_keywords: [],
  alert_regex: [],
  alert_target: '',
  log_all_messages: false,
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

// ===== 用户配置辅助函数 =====

// 加载用户配置
async function loadUserConfig(userId) {
  try {
    // 确保userId是ObjectId类型
    const userIdObj = mongoose.Types.ObjectId.isValid(userId) 
      ? (userId instanceof mongoose.Types.ObjectId ? userId : new mongoose.Types.ObjectId(userId))
      : userId;
    
    let userConfig = await UserConfig.findOne({ userId: userIdObj });
    if (!userConfig) {
      // 如果用户配置不存在，创建默认配置
      userConfig = new UserConfig({ userId: userIdObj });
      await userConfig.save();
    }
    return userConfig;
  } catch (error) {
    console.error('加载用户配置失败:', error);
    // 返回默认配置对象
    return {
      keywords: [],
      channels: [],
      alert_keywords: [],
      alert_regex: [],
      alert_target: '',
      log_all_messages: false,
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
      }
    };
  }
}

// 保存用户配置
async function saveUserConfig(userId, configData) {
  try {
    // 确保userId是ObjectId类型
    const userIdObj = mongoose.Types.ObjectId.isValid(userId) 
      ? (userId instanceof mongoose.Types.ObjectId ? userId : new mongoose.Types.ObjectId(userId))
      : userId;
    
    const userConfig = await UserConfig.findOneAndUpdate(
      { userId: userIdObj },
      { $set: { ...configData, userId: userIdObj } },
      { upsert: true, new: true }
    );
    return userConfig;
  } catch (error) {
    console.error('保存用户配置失败:', error);
    throw error;
  }
}

// 初始化默认管理员用户
async function initDefaultAdmin() {
  try {
    // 检查是否已存在admin用户
    const adminUser = await User.findOne({ username: 'admin' });
    if (!adminUser) {
      // 创建默认管理员用户
      const passwordHash = await bcrypt.hash('admin123', 10);
      const admin = new User({
        username: 'admin',
        password_hash: passwordHash,
        display_name: 'Administrator',
        is_active: true
      });
      await admin.save();
      console.log('✅ 默认管理员用户已创建 (username: admin, password: admin123)');
    } else {
      console.log('ℹ️  管理员用户已存在');
    }
  } catch (error) {
    console.error('❌ 初始化默认管理员失败:', error);
  }
}

// 连接 MongoDB
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/tglogs';
mongoose.connect(MONGO_URL, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(async () => {
  console.log('✅ MongoDB 已连接');
  // 初始化默认管理员
  await initDefaultAdmin();
})
.catch(err => console.error('❌ MongoDB 连接失败:', err));

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
    return res.status(401).json({ error: '未授权：token 无效' });
  }
};

// ===== 认证相关 API =====

// 登录（添加速率限制）
// 多用户登录
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
    
    // 生成 JWT token
    const token = jwt.sign({ 
      userId: user._id.toString(), 
      username: user.username 
    }, JWT_SECRET, { expiresIn: '24h' });
    
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

// 获取用户列表（仅管理员）
app.get('/api/users', adminMiddleware, async (req, res) => {
  try {
    const users = await User.find({}).select('-password_hash').sort({ created_at: -1 });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: '获取用户列表失败：' + error.message });
  }
});

// 创建用户（仅管理员）
app.post('/api/users', adminMiddleware, async (req, res) => {
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
    
    // 检查用户名是否已存在
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ error: '用户名已存在' });
    }
    
    const passwordHash = await bcrypt.hash(password, 10);
    const user = new User({
      username,
      password_hash: passwordHash,
      display_name: display_name || username,
      is_active: true
    });
    await user.save();
    
    // 创建用户时自动创建默认配置
    await saveUserConfig(user._id.toString(), {});
    
    res.json({ 
      status: 'ok', 
      message: '用户创建成功',
      user: {
        _id: user._id,
        username: user.username,
        display_name: user.display_name,
        is_active: user.is_active,
        created_at: user.created_at
      }
    });
  } catch (error) {
    res.status(500).json({ error: '创建用户失败：' + error.message });
  }
});

// 删除用户（仅管理员）
app.delete('/api/users/:userId', adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user.userId;
    
    // 不允许删除自己
    if (userId === currentUserId) {
      return res.status(400).json({ error: '不能删除自己的账号' });
    }
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    
    // 不允许删除 admin 用户
    if (user.username === 'admin') {
      return res.status(400).json({ error: '不能删除管理员账号' });
    }
    
    // 删除用户及其配置
    await User.findByIdAndDelete(userId);
    await UserConfig.deleteOne({ userId });
    
    res.json({ status: 'ok', message: '用户删除成功' });
  } catch (error) {
    res.status(500).json({ error: '删除用户失败：' + error.message });
  }
});

// ===== 配置相关 API =====

// 获取配置（不包含敏感信息）
app.get('/api/config', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const userConfig = await loadUserConfig(userId);
    
    // 转换为前端需要的格式
    const config = userConfig.toObject ? userConfig.toObject() : userConfig;
    
    // 🔒 不返回敏感信息给前端
    if (config.telegram) {
      delete config.telegram.api_hash; // 不返回 API Hash
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
      // 保留所有原有配置，只更新前端发送的字段
      incoming.ai_analysis = {
        ...existingAI,
        ...incoming.ai_analysis,
        // ✅ 如果前端没有发送 API Key（因为我们不返回），则保留原有值
        openai_api_key: incoming.ai_analysis.openai_api_key || existingAI.openai_api_key || ''
      };
    } else if (currentConfig.ai_analysis) {
      // 如果前端没有发送 ai_analysis，保留原有配置
      incoming.ai_analysis = currentConfig.ai_analysis;
    }
    
    // 校验并保留邮箱密码
    if (incoming.alert_actions?.email) {
      // ✅ 如果前端没有发送密码（因为我们不返回），则保留原有值
      if (!incoming.alert_actions.email.password) {
        incoming.alert_actions.email.password = (currentConfig.alert_actions?.email?.password || '').toString();
      }
    }
    
    // 准备更新数据
    const updateData = {
      ...incoming
    };
    
    // 保存到数据库
    await saveUserConfig(userId, updateData);
    
    // 如果 AI 分析配置有变化，重启定时器
    if (incoming.ai_analysis) {
      setTimeout(async () => {
        await startAIAnalysisTimer();
        console.log('🔄 AI 分析配置已更新，定时器已重启');
      }, 1000);
    }
    
    res.json({ status: 'ok', message: '配置保存成功' });
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
    
    const query = { userId: req.user.userId }; // 添加用户ID过滤
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

// ===== SSE 实时推送 =====

// SSE 客户端连接池已在文件顶部声明（第22行），无需重复声明

// SSE 事件推送端点
app.get('/api/events', authMiddleware, (req, res) => {
  // 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // 禁用 nginx 缓冲

  // 发送初始连接消息
  res.write('data: {"type":"connected","message":"实时推送已连接"}\n\n');

  // 将客户端添加到连接池
  sseClients.add(res);

  // 客户端断开连接时清理
  req.on('close', () => {
    sseClients.delete(res);
    res.end();
  });

  // 定期发送心跳，保持连接活跃
  const heartbeatInterval = setInterval(() => {
    if (sseClients.has(res)) {
      try {
        res.write('data: {"type":"ping"}\n\n');
      } catch (err) {
        clearInterval(heartbeatInterval);
        sseClients.delete(res);
        res.end();
      }
    } else {
      clearInterval(heartbeatInterval);
    }
  }, 30000); // 30秒心跳

  // 清理心跳定时器
  req.on('close', () => {
    clearInterval(heartbeatInterval);
  });
});

// 推送事件给所有连接的客户端
function broadcastEvent(eventType, data) {
  const message = JSON.stringify({ type: eventType, data, timestamp: new Date().toISOString() });
  const formattedMessage = `data: ${message}\n\n`;
  
  // 移除已断开的连接
  const disconnectedClients = [];
  
  sseClients.forEach(client => {
    try {
      client.write(formattedMessage);
    } catch (err) {
      // 连接已断开，标记为待删除
      disconnectedClients.push(client);
    }
  });
  
  // 清理断开的连接
  disconnectedClients.forEach(client => {
    sseClients.delete(client);
  });
}

// ===== 统计相关 API =====

// 统计信息缓存（按用户缓存，减少MongoDB查询压力）
const statsCache = new Map(); // key: userId, value: { data, time }
const STATS_CACHE_TTL = 10000; // 缓存10秒

// 获取统计信息（带缓存）
app.get('/api/stats', authMiddleware, async (req, res) => {
  // const startTime = Date.now();
  try {
    const userId = req.user.userId;
    const now = Date.now();
    
    // 检查用户缓存是否有效
    const cached = statsCache.get(userId);
    if (cached && (now - cached.time) < STATS_CACHE_TTL) {
      return res.json(cached.data);
    }
    
    // console.log(`[性能监控] /api/stats 开始执行数据库查询...`);
    // const queryStartTime = Date.now();
    
    // 并行执行所有查询以提高效率
    const userIdObj = new mongoose.Types.ObjectId(userId);
    const [total, todayCount, alertedCount, channelStats] = await Promise.all([
      Log.countDocuments({ userId: userIdObj }),
      (() => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return Log.countDocuments({ userId: userIdObj, time: { $gte: today } });
      })(),
      Log.countDocuments({ userId: userIdObj, alerted: true }),
      Log.aggregate([
        {
          $match: { userId: userIdObj }
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

// 🚨 推送告警（CRITICAL FIX：添加 authMiddleware）
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
    const log = new Log({
      userId: new mongoose.Types.ObjectId(userId),
      channel: cleanChannel,
      channelId: channelId || '',
      sender: cleanFrom,
      message: cleanMessage,
      keywords: [cleanKeyword],
      messageId,
      alerted: true
    });
    await log.save();
    
    // 实时推送新消息事件给前端（包含userId以便前端过滤）
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
    });
    
    // 推送统计更新事件（包含userId以便前端过滤）
    broadcastEvent('stats_updated', { userId: userId });
    
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
    
    // Telegram 推送
    if (actions.telegram && config.alert_target) {
      // 这里需要 Python 脚本配合发送
      console.log('Telegram 告警已触发');
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

    const result = { telegram: 'handled-by-telethon', email: null, webhook: null };

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
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 10;
    const sentiment = req.query.sentiment || '';
    const riskLevel = req.query.riskLevel || '';
    
    const query = { userId: new mongoose.Types.ObjectId(userId) };
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

// 内部 API：Telethon 服务调用的消息通知接口（不需要认证）
// 用于在 Telethon 直接保存消息到 MongoDB 后，通知前端有新消息
app.post('/api/internal/message-notify', async (req, res) => {
  try {
    const { log_id, channel, channelId, sender, message, keywords, time, alerted } = req.body;
    
    // 从log_id获取userId
    let userId = null;
    if (log_id) {
      try {
        const log = await Log.findById(log_id);
        if (log && log.userId) {
          userId = log.userId.toString();
        }
      } catch (err) {
        console.error('获取日志userId失败:', err);
      }
    }
    
    // 推送新消息事件给前端（包含userId以便前端过滤）
    broadcastEvent('new_message', {
      id: log_id,
      userId: userId,
      channel: channel || 'Unknown',
      channelId: channelId || '',
      sender: sender || 'Unknown',
      message: message || '',
      keywords: keywords || [],
      time: time || new Date().toISOString(),
      alerted: alerted || false
    });
    
    // 推送统计更新事件（包含userId以便前端过滤）
    broadcastEvent('stats_updated', { userId: userId });
    
    // 清除统计缓存（如果有userId，只清除该用户的缓存；否则清除所有）
    if (userId) {
      statsCache.delete(userId);
    } else {
      statsCache.clear();
    }
    
    res.json({ status: 'ok', message: '消息通知已推送' });
  } catch (error) {
    console.error('❌ 消息通知推送失败:', error.message);
    res.status(500).json({ error: '推送消息通知失败：' + error.message });
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
    const userIdObj = new mongoose.Types.ObjectId(userId);
    
    // const queryStartTime = Date.now();
    // 并行执行所有查询以提高效率
    const [total, totalMessagesAnalyzed, sentimentStats, riskStats, unanalyzedCount] = await Promise.all([
      AISummary.countDocuments({ userId: userIdObj }),
      AISummary.aggregate([
        { $match: { userId: userIdObj } },
        { $group: { _id: null, total: { $sum: '$message_count' } } }
      ]),
      AISummary.aggregate([
        { $match: { userId: userIdObj } },
        { $group: { _id: '$analysis_result.sentiment', count: { $sum: 1 } } }
      ]),
      AISummary.aggregate([
        { $match: { userId: userIdObj } },
        { $group: { _id: '$analysis_result.risk_level', count: { $sum: 1 } } }
      ]),
      Log.countDocuments({ userId: userIdObj, ai_analyzed: false })
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
let aiAnalysisTimer = null;

// 执行 AI 批量分析
async function performAIAnalysis(triggerType = 'manual', logId = null, userId = null) {
  if (!userId) {
    return { success: false, error: '用户ID不能为空' };
  }
  
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

  try {
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
      
      const query = Log.find({ userId: userIdObj, ai_analyzed: false }).sort({ time: -1 }).limit(maxMessages);
      unanalyzedMessages = await query;
      
      // 检查是否有更多未分析的消息
      const totalUnanalyzed = await Log.countDocuments({ userId: userIdObj, ai_analyzed: false });
      if (totalUnanalyzed > maxMessages) {
        console.log(`⚠️  未分析消息总数: ${totalUnanalyzed}，但只分析最近 ${maxMessages} 条（受最大消息数限制）`);
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
    const messageIds = unanalyzedMessages.map(log => log._id);
    await Log.updateMany(
      { _id: { $in: messageIds }, userId: userIdObj },
      { $set: { ai_analyzed: true, ai_summary_id: summary._id } }
    );

    console.log(`✅ AI 分析完成，情感: ${analysisResult.analysis.sentiment}, 风险: ${analysisResult.analysis.risk_level}`);
    
    // 根据配置发送告警
    const aiSendTelegram = config.ai_analysis?.ai_send_telegram !== false; // 默认启用
    const aiSendEmail = config.ai_analysis?.ai_send_email || false;
    const aiSendWebhook = config.ai_analysis?.ai_send_webhook || false;
    
    if (aiSendTelegram || aiSendEmail || aiSendWebhook) {
      const alertMessage = `🤖 AI 分析完成\n\n总分析消息数: ${unanalyzedMessages.length}\n情感倾向: ${analysisResult.analysis.sentiment}\n风险等级: ${analysisResult.analysis.risk_level}\n\n摘要:\n${analysisResult.analysis.summary}\n\n关键词: ${(analysisResult.analysis.keywords || []).join(', ')}`;
      
      // 发送 Telegram 告警
      if (aiSendTelegram && config.alert_target) {
        try {
          // 这里需要通过监听服务发送，暂时记录日志
          console.log('📱 AI 分析结果将通过 Telegram 发送至:', config.alert_target);
        } catch (error) {
          console.error('❌ Telegram 发送失败:', error.message);
        }
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
    broadcastEvent('ai_analysis_complete', {
      userId: userId,
      summary_id: summary._id,
      message_count: unanalyzedMessages.length,
      trigger_type: triggerType,
      analysis: analysisResult.analysis
    });
    
    // 推送AI统计更新事件（包含userId以便前端过滤）
    broadcastEvent('ai_stats_updated', { userId: userId });

    return {
      success: true,
      summary_id: summary._id,
      message_count: unanalyzedMessages.length,
      analysis: analysisResult.analysis
    };

  } catch (error) {
    console.error('❌ AI 分析过程出错:', error);
    return { success: false, error: error.message };
  }
}

// 启动 AI 分析定时器（为所有启用了AI的用户执行）
async function startAIAnalysisTimer() {
  if (aiAnalysisTimer) {
    clearInterval(aiAnalysisTimer);
  }
  
  // 为所有用户执行定时分析
  const performAnalysisForAllUsers = async () => {
    try {
      const users = await User.find({ is_active: true });
      
      for (const user of users) {
        try {
          const userConfig = await loadUserConfig(user._id);
          const config = userConfig.toObject ? userConfig.toObject() : userConfig;
          
          if (!config.ai_analysis?.enabled || config.ai_analysis.analysis_trigger_type !== 'time') {
            continue;
          }
          
          console.log(`⏰ 为用户 ${user.username} 执行定时 AI 分析`);
          await performAIAnalysis('time', null, user._id.toString());
        } catch (err) {
          console.error(`为用户 ${user.username} 执行AI分析失败:`, err.message);
        }
      }
    } catch (err) {
      console.error('执行定时AI分析失败:', err);
    }
  };
  
  // 使用30分钟作为默认间隔（实际应该从每个用户的配置读取，这里简化处理）
  const intervalMs = 30 * 60 * 1000; // 30分钟
  aiAnalysisTimer = setInterval(performAnalysisForAllUsers, intervalMs);
  
  console.log(`✅ AI 定时分析已启动，间隔: 30 分钟（为所有启用AI的用户执行）`);
}

// 监听新消息（用于计数触发）
async function checkMessageCountTrigger() {
  try {
    const users = await User.find({ is_active: true });
    
    for (const user of users) {
      try {
        const userConfig = await loadUserConfig(user._id);
        const config = userConfig.toObject ? userConfig.toObject() : userConfig;
        
        if (!config.ai_analysis?.enabled || config.ai_analysis.analysis_trigger_type !== 'count') {
          continue;
        }
        
        const threshold = config.ai_analysis.message_count_threshold || 50;
        const userIdObj = new mongoose.Types.ObjectId(user._id);
        const unanalyzedCount = await Log.countDocuments({ 
          userId: userIdObj,
          ai_analyzed: false 
        });
        
        if (unanalyzedCount >= threshold) {
          console.log(`📊 用户 ${user.username} 未分析消息达到阈值 ${threshold}，触发 AI 分析`);
          await performAIAnalysis('count', null, user._id.toString());
        }
      } catch (err) {
        console.error(`检查用户 ${user.username} 消息计数触发失败:`, err.message);
      }
    }
  } catch (err) {
    console.error('检查消息计数触发失败:', err);
  }
}

// 定期检查消息计数（每分钟检查一次）
setInterval(checkMessageCountTrigger, 60000);

// 启动服务器
app.listen(PORT, () => {
  console.log(`✅ API 服务运行在端口 ${PORT}`);
  console.log(`📝 默认用户名: admin`);
  console.log(`📝 默认密码: admin123`);
  console.log(`⚠️  请及时修改默认密码！`);
  
  // 启动 AI 分析
  setTimeout(async () => {
    await startAIAnalysisTimer();
  }, 3000);
});
