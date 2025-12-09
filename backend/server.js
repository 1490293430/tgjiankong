const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
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
    
    console.log(`✅ 用户配置已保存到数据库 (userId: ${userId})`);
    return userConfig;
  } catch (error) {
    console.error('保存用户配置失败:', error);
    throw error;
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
mongoose.connect(MONGO_URL, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(async () => {
  console.log('✅ MongoDB 已连接');
  console.log(`📊 MongoDB 连接字符串: ${MONGO_URL.replace(/\/\/.*@/, '//***:***@')}`); // 隐藏密码
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

// 检查系统是否已初始化（是否有用户）- 公开接口，不需要认证
app.get('/api/auth/check-init', async (req, res) => {
  try {
    // 检查MongoDB连接状态
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ initialized: false, error: '数据库未连接' });
    }
    
    // 检查是否有任何用户
    const userCount = await User.countDocuments();
    res.json({ initialized: userCount > 0, userCount });
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
    
    // 检查用户名是否已存在
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ error: '用户名已存在' });
    }
    
    // 确保 MongoDB 连接正常
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: '数据库未连接，请稍后重试' });
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
    
    console.log(`✅ 用户已保存到数据库 (userId: ${user._id}, username: ${username})`);
    
    // 创建用户时自动创建默认配置
    try {
      await saveUserConfig(user._id.toString(), {});
    } catch (configError) {
      console.error('⚠️  创建用户配置失败，但用户已创建:', configError);
      // 配置创建失败不影响用户创建成功
    }
    
    // 生成 JWT token
    const token = jwt.sign({ 
      userId: user._id.toString(), 
      username: user.username 
    }, JWT_SECRET, { expiresIn: '24h' });
    
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

// 删除子账号（主账号可以删除该账号下的子账号）
app.delete('/api/users/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUser = req.user.userObj;
    const currentAccountId = await getAccountId(currentUser._id);
    
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
    
    res.json({ status: 'ok', message: '子账号删除成功' });
  } catch (error) {
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
    
    const targetUser = await User.findById(userId);
    if (!targetUser || !targetUser.is_active) {
      return res.status(404).json({ error: '用户不存在或已被禁用' });
    }
    
    // 获取目标账号的主账号ID
    const targetAccountId = targetUser.parent_account_id || targetUser._id;
    
    // 权限检查：只能切换到同一主账号下的账号
    if (currentAccountId.toString() !== targetAccountId.toString()) {
      return res.status(403).json({ error: '权限不足：只能切换到同一账号下的其他用户' });
    }
    
    // 生成目标用户的 JWT token
    const token = jwt.sign({ 
      userId: targetUser._id.toString(), 
      username: targetUser.username 
    }, JWT_SECRET, { expiresIn: '24h' });
    
    // 更新最后登录时间
    targetUser.last_login = new Date();
    await targetUser.save();
    
    // 更新全局配置文件并同步用户配置（异步执行，不阻塞响应）
    setTimeout(async () => {
      try {
        await syncUserConfigAndRestartTelethon(targetUser._id.toString());
      } catch (error) {
        console.error('⚠️  切换用户后同步配置失败（不影响切换用户）:', error);
      }
    }, 500); // 延迟500ms，确保切换用户响应已返回
    
    console.log(`✅ 用户 ${currentUser.username} 切换到用户: ${targetUser.username} (userId: ${targetUser._id})`);
    
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
        openai_api_key: incoming.ai_analysis.openai_api_key || existingAI.openai_api_key || '',
        // 确保数值类型正确（前端可能发送字符串）
        message_count_threshold: Number(incoming.ai_analysis.message_count_threshold) || existingAI.message_count_threshold || 50,
        time_interval_minutes: Number(incoming.ai_analysis.time_interval_minutes) || existingAI.time_interval_minutes || 30,
        max_messages_per_analysis: Number(incoming.ai_analysis.max_messages_per_analysis) || existingAI.max_messages_per_analysis || 500
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
      
      // 同步配置到全局配置文件（不重启Telethon，因为只有API凭证才需要重启）
      try {
        console.log(`🔄 [配置保存] 开始同步配置到全局文件（不重启Telethon）`);
        // 只同步配置，不重启Telethon
        const globalConfig = loadConfig();
        const accountId = await getAccountId(userId);
        const accountIdObj = new mongoose.Types.ObjectId(accountId);
        const userConfig = await loadUserConfig(userId.toString());
        if (userConfig) {
          const configObj = userConfig.toObject ? userConfig.toObject() : userConfig;
          
          const configToSync = {
            keywords: Array.isArray(configObj.keywords) ? configObj.keywords : (configObj.keywords || []),
            channels: Array.isArray(configObj.channels) ? configObj.channels : (configObj.channels || []),
            alert_keywords: Array.isArray(configObj.alert_keywords) ? configObj.alert_keywords : (configObj.alert_keywords || []),
            alert_regex: Array.isArray(configObj.alert_regex) ? configObj.alert_regex : (configObj.alert_regex || []),
            log_all_messages: configObj.log_all_messages || false,
            alert_target: configObj.alert_target || ''
          };
          
          // 更新全局配置，保留其他字段
          Object.assign(globalConfig, configToSync);
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(globalConfig, null, 2));
          console.log(`✅ [配置保存] 配置已同步到全局文件（不重启Telethon）`);
        }
      } catch (syncError) {
        console.warn('⚠️  [配置保存] 同步配置到全局文件失败（不影响配置保存）:', syncError.message);
        console.error('错误堆栈:', syncError.stack);
      }
      
      // 如果 AI 分析配置有变化，重启定时器
      if (incoming.ai_analysis) {
        setTimeout(async () => {
          console.log('🔄 [配置保存] AI 分析配置已更新，重启定时器');
          await startAIAnalysisTimer();
          console.log('✅ [配置保存] AI 分析定时器已重启');
        }, 1000);
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
    
    if (!api_id) {
      return res.status(400).json({ error: 'API_ID 不能为空' });
    }
    
    // 准备更新数据
    const updateData = {
      telegram: {
        api_id: Number(api_id),
        api_hash: api_hash || (currentConfig.telegram?.api_hash || '').toString()
      }
    };
    
    console.log(`💾 [Telegram凭证保存] 准备保存到数据库 (userId: ${userId})`);
    
    // 保存到数据库
    await saveUserConfig(userId, updateData);
    console.log(`✅ [Telegram凭证保存] 配置已保存到数据库`);
    
    // 同步配置并重启Telethon服务（同步执行，因为需要等待重启完成）
    try {
      console.log(`🔄 [Telegram凭证保存] 开始同步配置到全局文件并重启Telethon服务`);
      await syncUserConfigAndRestartTelethon(userId);
      console.log(`✅ [Telegram凭证保存] 配置同步完成，Telethon服务已重启`);
    } catch (syncError) {
      console.error('❌ [Telegram凭证保存] 同步配置或重启Telethon失败:', syncError.message);
      console.error('错误堆栈:', syncError.stack);
      return res.status(500).json({ 
        error: '配置已保存，但重启Telethon服务失败：' + syncError.message 
      });
    }
    
    res.json({ 
      status: 'ok', 
      message: 'Telegram API 凭证保存成功，Telethon 服务已重启'
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
  
  // 清理同一用户之前的旧连接（避免多个连接）
  const disconnectedClients = [];
  sseClients.forEach(clientInfo => {
    if (clientInfo.userId === userId) {
      // 发现同一用户的旧连接，断开它
      try {
        if (clientInfo.heartbeatInterval) {
          clearInterval(clientInfo.heartbeatInterval);
        }
        if (clientInfo.res && !clientInfo.res.destroyed && clientInfo.res.writable) {
          clientInfo.res.end();
        }
      } catch (e) {
        // 忽略清理错误
      }
      disconnectedClients.push(clientInfo);
    }
  });
  disconnectedClients.forEach(clientInfo => {
    sseClients.delete(clientInfo);
  });
  
  if (disconnectedClients.length > 0) {
    console.log(`🧹 清理了 ${disconnectedClients.length} 个用户 ${userId} 的旧 SSE 连接`);
  }
  
  // 设置 SSE 响应头（必须严格按照 SSE 规范）
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // 禁用 nginx 缓冲
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  // 立即刷新响应头，确保连接建立
  res.flushHeaders();

  // 发送初始连接消息
  try {
    const initMessage = JSON.stringify({
      type: 'connected',
      message: '实时推送已连接',
      userId: userId,
      timestamp: new Date().toISOString()
    });
    res.write(`data: ${initMessage}\n\n`);
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
    heartbeatInterval: null
  };

  // 将客户端添加到连接池（使用对象而不是直接存储 res）
  sseClients.add(clientInfo);
  console.log(`✅ 用户 ${userId} 的 SSE 连接已建立（当前连接数: ${sseClients.size}）`);

  // 定期发送心跳，保持连接活跃（减少到15秒，确保连接不会超时）
  const heartbeatInterval = setInterval(() => {
    if (sseClients.has(clientInfo)) {
      try {
        // 检查响应对象是否仍然可写
        if (res.writable && !res.destroyed) {
          const pingMessage = JSON.stringify({
            type: 'ping',
            timestamp: new Date().toISOString()
          });
          res.write(`data: ${pingMessage}\n\n`);
          clientInfo.lastPing = Date.now();
        } else {
          // 连接已断开
          clearInterval(heartbeatInterval);
          sseClients.delete(clientInfo);
          res.end();
        }
      } catch (err) {
        // 写入失败，连接可能已断开
        clearInterval(heartbeatInterval);
        sseClients.delete(clientInfo);
        try {
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
  const cleanup = () => {
    clearInterval(heartbeatInterval);
    sseClients.delete(clientInfo);
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
      if (!res || res.destroyed || !res.writable) {
        disconnectedClients.push(clientInfo);
        return;
      }
      
      // 尝试发送消息
      res.write(formattedMessage);
      
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
    
    // 如果提供了userId，保存日志到数据库
    if (userIdObj) {
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
      
      // 清除统计缓存
      statsCache.delete(userId);
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
            const telethonUrl = process.env.TELETHON_URL || 'http://telethon:8888';
            const response = await axios.post(`${telethonUrl}/api/internal/telegram/send`, {
              target: config.alert_target,
              message: alertMessage
            }, {
              timeout: 10000,
              headers: {
                'Content-Type': 'application/json'
              }
            });
            console.log(`✅ [告警处理] Telegram 告警已发送到: ${config.alert_target}, 响应:`, response.data);
          } catch (error) {
            console.error('❌ [告警处理] Telegram 发送失败:', error.message);
            if (error.response) {
              console.error('响应状态:', error.response.status, '响应数据:', error.response.data);
            }
            if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
              console.error('❌ 无法连接到Telethon服务，请检查服务是否运行: http://telethon:8888');
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
        await axios.post(`${process.env.TELETHON_URL || 'http://telethon:8888'}/api/internal/telegram/send`, {
          target: config.alert_target,
          message: alertMessage
        }, {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json'
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

// 创建数据备份
app.post('/api/backup', authMiddleware, async (req, res) => {
  try {
    const username = req.user.username;
    
    // 只有admin用户可以执行备份
    if (username !== 'admin') {
      return res.status(403).json({ error: '权限不足：仅管理员可执行备份操作' });
    }
    
    console.log('📦 [备份] 开始创建数据备份...');
    
    // 确定项目根目录
    // 在容器内，server.js 在 /app/server.js，所以 __dirname 是 /app
    // 但配置文件在 /app/config.json（因为挂载了 ./backend:/app）
    // 项目根目录应该是 /app 的上级目录，但容器内没有挂载
    // 所以我们需要使用 /app 作为工作目录，但备份应该保存到挂载的目录
    
    // 检查容器内路径
    const containerAppDir = '/app';
    const containerConfigPath = path.join(containerAppDir, 'config.json');
    
    // 确定项目根目录（容器内）
    let scriptDir = null;
    
    // 如果 /app/config.json 存在，说明在容器内，使用 /app 作为工作目录
    if (fs.existsSync(containerConfigPath)) {
      scriptDir = containerAppDir;
      console.log(`📁 [备份] 检测到容器内路径，使用: ${scriptDir}`);
    } else {
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
          scriptDir = rootPath;
          console.log(`📁 [备份] 检测到项目根目录: ${scriptDir}`);
          break;
        }
      }
      
      // 如果都没找到，使用默认路径
      if (!scriptDir) {
        scriptDir = path.resolve(__dirname, '..');
        console.log(`📁 [备份] 使用默认项目根目录: ${scriptDir}`);
      }
    }
    
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
    
    // 备份数据目录（尝试多个可能的路径）
    // 注意：在容器内，data 目录可能挂载在不同的位置
    const possibleDataPaths = [
      '/app/data',                      // 容器内挂载的 data 目录（如果挂载了）
      path.join(scriptDir, 'data'),     // 项目根目录下的 data
      '/opt/telegram-monitor/data',     // 常见部署路径
      path.join(__dirname, '..', 'data') // 相对于 server.js
    ];
    
    let dataBacked = false;
    for (const dataPath of possibleDataPaths) {
      if (fs.existsSync(dataPath)) {
        const dataFiles = fs.readdirSync(dataPath);
        if (dataFiles.length > 0) {
          const backupDataPath = path.join(backupPath, 'data');
          fs.mkdirSync(backupDataPath, { recursive: true });
          
          // 复制数据目录内容
          for (const item of dataFiles) {
            const sourcePath = path.join(dataPath, item);
            const destPath = path.join(backupDataPath, item);
            const stat = fs.statSync(sourcePath);
            
            if (stat.isDirectory()) {
              // 递归复制目录
              const copyDir = (src, dest) => {
                fs.mkdirSync(dest, { recursive: true });
                const entries = fs.readdirSync(src);
                for (const entry of entries) {
                  const srcPath = path.join(src, entry);
                  const destPath = path.join(dest, entry);
                  const entryStat = fs.statSync(srcPath);
                  if (entryStat.isDirectory()) {
                    copyDir(srcPath, destPath);
                  } else {
                    fs.copyFileSync(srcPath, destPath);
                  }
                }
              };
              copyDir(sourcePath, destPath);
            } else {
              fs.copyFileSync(sourcePath, destPath);
            }
          }
          console.log(`✅ [备份] 已备份数据目录: ${dataPath}`);
          dataBacked = true;
          break; // 找到数据目录后退出循环
        } else {
          console.warn(`⚠️  [备份] 数据目录为空: ${dataPath}`);
        }
      }
    }
    
    if (!dataBacked) {
      console.warn(`⚠️  [备份] 数据目录不存在，尝试过的路径: ${possibleDataPaths.join(', ')}`);
    }
    
    // 创建备份信息文件
    const backupInfoPath = path.join(backupPath, 'backup_info.txt');
    const backupInfo = `备份时间: ${new Date().toLocaleString('zh-CN')}
备份路径: ${backupPath}
备份内容:
- 配置文件 (backend/config.json)
- 环境变量 (.env)
- 数据目录 (data/)
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
    
    // 使用与备份创建相同的路径检测逻辑
    const containerAppDir = '/app';
    const containerConfigPath = path.join(containerAppDir, 'config.json');
    
    let scriptDir = null;
    
    // 如果 /app/config.json 存在，说明在容器内，使用 /app 作为工作目录
    if (fs.existsSync(containerConfigPath)) {
      scriptDir = containerAppDir;
    } else {
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
          scriptDir = rootPath;
          break;
        }
      }
      
      // 如果都没找到，使用默认路径
      if (!scriptDir) {
        scriptDir = path.resolve(__dirname, '..');
      }
    }
    
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
    
    const scriptDir = path.resolve(__dirname, '..');
    const backupDir = path.join(scriptDir, 'backups');
    const backupPath = path.join(backupDir, backupName);
    
    // 检查备份文件是否存在
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: '备份文件不存在' });
    }
    
    // 执行恢复脚本（通过传入备份文件名）
    const restoreScript = path.join(scriptDir, 'restore.sh');
    
    if (!fs.existsSync(restoreScript)) {
      return res.status(500).json({ error: '恢复脚本不存在' });
    }
    
    // 由于restore.sh是交互式的，我们需要创建一个非交互式版本
    // 或者直接执行恢复操作
    const isTarGz = backupName.endsWith('.tar.gz');
    const tempDir = isTarGz ? path.join(scriptDir, 'temp_restore') : null;
    
    try {
      // 如果是压缩文件，先解压
      if (isTarGz) {
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        await execAsync(`tar -xzf "${backupPath}" -C "${tempDir}"`, {
          cwd: scriptDir,
          timeout: 300000
        });
        
        const extractedDir = path.join(tempDir, backupName.replace('.tar.gz', ''));
        
        // 恢复配置文件
        const configSource = path.join(extractedDir, 'config.json');
        const configDest = path.join(scriptDir, 'backend', 'config.json');
        if (fs.existsSync(configSource)) {
          fs.copyFileSync(configSource, configDest);
          console.log('✅ [恢复] 已恢复配置文件');
        }
        
        // 恢复.env文件
        const envSource = path.join(extractedDir, '.env');
        const envDest = path.join(scriptDir, '.env');
        if (fs.existsSync(envSource)) {
          fs.copyFileSync(envSource, envDest);
          console.log('✅ [恢复] 已恢复环境变量文件');
        }
        
        // 恢复数据目录
        const dataSource = path.join(extractedDir, 'data');
        const dataDest = path.join(scriptDir, 'data');
        if (fs.existsSync(dataSource)) {
          // 备份现有数据
          if (fs.existsSync(dataDest)) {
            const backupDataPath = `${dataDest}.backup.${Date.now()}`;
            fs.renameSync(dataDest, backupDataPath);
            console.log(`✅ [恢复] 已备份现有数据到: ${backupDataPath}`);
          }
          // 复制恢复数据
          await execAsync(`cp -r "${dataSource}" "${dataDest}"`, {
            cwd: scriptDir,
            timeout: 300000
          });
          console.log('✅ [恢复] 已恢复数据目录');
        }
        
        // 清理临时目录
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      } else {
        // 如果是目录
        const configSource = path.join(backupPath, 'config.json');
        const configDest = path.join(scriptDir, 'backend', 'config.json');
        if (fs.existsSync(configSource)) {
          fs.copyFileSync(configSource, configDest);
          console.log('✅ [恢复] 已恢复配置文件');
        }
        
        const envSource = path.join(backupPath, '.env');
        const envDest = path.join(scriptDir, '.env');
        if (fs.existsSync(envSource)) {
          fs.copyFileSync(envSource, envDest);
          console.log('✅ [恢复] 已恢复环境变量文件');
        }
        
        const dataSource = path.join(backupPath, 'data');
        const dataDest = path.join(scriptDir, 'data');
        if (fs.existsSync(dataSource)) {
          if (fs.existsSync(dataDest)) {
            const backupDataPath = `${dataDest}.backup.${Date.now()}`;
            fs.renameSync(dataDest, backupDataPath);
            console.log(`✅ [恢复] 已备份现有数据到: ${backupDataPath}`);
          }
          await execAsync(`cp -r "${dataSource}" "${dataDest}"`, {
            cwd: scriptDir,
            timeout: 300000
          });
          console.log('✅ [恢复] 已恢复数据目录');
        }
      }
      
      console.log('✅ [恢复] 恢复完成');
      
      res.json({
        status: 'ok',
        message: '数据恢复成功，请重启服务以应用更改'
      });
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
    
    // 使用与备份创建和列表相同的路径检测逻辑
    const containerAppDir = '/app';
    const containerConfigPath = path.join(containerAppDir, 'config.json');
    
    let scriptDir = null;
    
    // 如果 /app/config.json 存在，说明在容器内，使用 /app 作为工作目录
    if (fs.existsSync(containerConfigPath)) {
      scriptDir = containerAppDir;
    } else {
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
          scriptDir = rootPath;
          break;
        }
      }
      
      // 如果都没找到，使用默认路径
      if (!scriptDir) {
        scriptDir = path.resolve(__dirname, '..');
      }
    }
    
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
    
    // 推送新消息事件给前端（只推送给该用户）
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
    }, userId);
    
    // 推送统计更新事件（只推送给该用户）
    broadcastEvent('stats_updated', { userId: userId }, userId);
    
    // 如果启用了消息数量阈值触发，立即检查是否达到阈值
    if (userId) {
      try {
        const userConfig = await loadUserConfig(userId);
        const config = userConfig.toObject ? userConfig.toObject() : userConfig;
        
        // 添加调试日志
        console.log(`🔍 [消息通知] 检查AI分析触发 - userId: ${userId}, enabled: ${config.ai_analysis?.enabled}, trigger_type: ${config.ai_analysis?.analysis_trigger_type}`);
        
        if (config.ai_analysis?.enabled && config.ai_analysis.analysis_trigger_type === 'count') {
          const threshold = Number(config.ai_analysis.message_count_threshold) || 50;
          const userIdObj = new mongoose.Types.ObjectId(userId);
          const unanalyzedCount = await Log.countDocuments({ 
            userId: userIdObj,
            ai_analyzed: false 
          });
          
          console.log(`🔍 [消息通知] 消息计数检查 - userId: ${userId}, 阈值: ${threshold} (类型: ${typeof threshold}), 未分析数量: ${unanalyzedCount} (类型: ${typeof unanalyzedCount})`);
          
          // 确保阈值和数量都是数字类型进行比较
          if (Number(unanalyzedCount) >= Number(threshold)) {
            console.log(`📊 [消息通知触发] 用户 ${userId} 未分析消息达到阈值 ${threshold}（当前: ${unanalyzedCount}），立即触发 AI 分析`);
            // 异步触发，不阻塞响应
            performAIAnalysis('count', null, userId).catch(err => {
              console.error(`❌ [消息通知触发] 触发 AI 分析失败:`, err.message);
            });
          } else {
            console.log(`⏸️  [消息通知] 用户 ${userId} 未分析消息 ${unanalyzedCount} < 阈值 ${threshold}，未触发`);
          }
        }
      } catch (err) {
        // 详细错误日志
        console.error('❌ 检查消息数量阈值失败:', err.message);
        console.error('错误堆栈:', err.stack);
      }
    }
    
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
  
  const containerName = `tg_login_${userId}_${Date.now()}`;
  
  // 创建容器配置（长期运行，用于多次执行命令）
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
        `${sessionHostPath}:/app/session`
      ],
      AutoRemove: false // 不自动删除，我们手动管理
    },
    NetworkMode: networkName || 'bridge',
    AttachStdout: true,
    AttachStderr: true
  };
  
  // 创建容器
  const container = await docker.createContainer(containerConfig);
  
  // 启动容器
  await container.start();
  
  console.log(`✅ 创建临时登录容器: ${containerName}`);
  
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
async function execLoginScriptWithDockerRun(command, args, userId = null, reuseContainer = false) {
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
  let sessionHostPath = path.resolve(projectRoot, 'data', 'session');
  
  if (existingContainerInfo && existingContainerInfo.Mounts) {
    // 从现有容器的挂载信息中获取主机路径
    for (const mount of existingContainerInfo.Mounts) {
      if (mount.Destination === '/app/config.json') {
        configHostPath = mount.Source;
      } else if (mount.Destination === '/app/session') {
        sessionHostPath = mount.Source;
      }
    }
  }
  
    // 如果需要创建可复用的容器
    if (!tempContainerName && userId && reuseContainer) {
      // 创建可重用的临时容器（长期运行，用于多次执行命令）
      tempContainerName = await getOrCreateTempLoginContainer(userId, configHostPath, sessionHostPath, containerImage, networkName);
      isReusingContainer = true;
    } else if (!tempContainerName) {
      // 创建一次性临时容器
      tempContainerName = `tg_login_temp_${Date.now()}`;
    }
  }
  
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
      container = docker.getContainer(tempContainerName);
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
    
    // 创建新的一次性容器
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
          `${sessionHostPath}:/app/session`
        ],
        AutoRemove: !(userId && reuseContainer) // 如果是复用容器，不自动删除
      },
      NetworkMode: networkName || 'bridge' // 登录脚本不需要访问内部网络
    });
    
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
          log_all_messages: configObj.log_all_messages || false,
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
    
    // 重启 Telethon 服务以应用新配置
    const restartSuccess = await restartTelethonService();
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

// 重启 Telethon 服务
async function restartTelethonService() {
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

// 安全执行 Docker 命令调用登录脚本（使用 Docker SDK）
// allowCreateTemp: 如果为 true，当容器未运行时，创建临时容器执行脚本
async function execTelethonLoginScript(command, args = [], retryCount = 0, allowCreateTemp = true, userId = null, reuseContainer = false) {
  const maxRetries = 3;
  const retryDelay = 1000; // 1秒（减少重试延迟）
  const timeout = 30000; // 30秒超时（减少超时时间，登录操作通常很快）
  
  try {
    // 获取容器并等待就绪（如果正在重启）
    // 对于登录操作（send_code, sign_in），允许创建临时容器
    let containerResult;
    try {
      containerResult = await getDockerAndContainer(true, allowCreateTemp);
    } catch (containerError) {
      // 如果容器未运行且允许创建临时容器，则使用 docker run 执行脚本
      if (allowCreateTemp && (
        containerError.message.includes('无法找到运行中的 Telethon 容器') ||
        containerError.message.includes('容器不存在') ||
        containerError.message.includes('已退出')
      )) {
        console.log('📦 容器未运行，使用 docker run 执行登录脚本...');
        // 直接使用 docker run 执行脚本，不需要容器运行
        try {
          return await execLoginScriptWithDockerRun(command, args, userId, reuseContainer);
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
                reject(new Error(
                  `脚本执行被强制终止（退出码: 137）\n` +
                  `可能原因：\n` +
                  `1. 容器内存不足 (OOM Killer)\n` +
                  `2. 进程执行时间过长被系统终止\n` +
                  `3. Docker 容器资源限制\n\n` +
                  `建议：\n` +
                  `- 检查容器内存使用: docker stats tg_listener\n` +
                  `- 查看系统日志: dmesg | grep -i oom\n` +
                  `- 检查容器资源限制: docker inspect tg_listener | grep -A 10 Memory\n` +
                  `- 尝试增加容器内存限制或优化脚本执行时间\n` +
                  `- 输出: ${stderr || stdout || '无输出'}`
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

// 用户配置缓存（避免频繁查询 MongoDB）
const userConfigCache = new Map();
const CONFIG_CACHE_TTL = 60000; // 配置缓存60秒

// 检查 Telegram 登录状态（优化版本，提高准确性）
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
    
    // 快速检查 session 文件（不依赖 MongoDB 查询）
    const sessionPath = userId 
      ? `/app/session/telegram_${userId}`
      : '/app/session/telegram';
    
    const sessionExists = checkSessionFileExists(sessionPath);
    
    // 如果 session 文件不存在，直接返回（不需要查询配置）
    if (!sessionExists) {
      const result = {
        logged_in: false,
        message: '未登录（session 文件不存在）'
      };
      // 缓存结果
      loginStatusCache.set(`login_status_${userId}`, {
        result,
        timestamp: Date.now()
      });
      return res.json(result);
    }
    
    // session 文件存在，快速返回已登录状态（不等待容器验证，提高速度）
    const quickResult = {
      logged_in: true,
      message: '已登录（session 文件存在）',
      uncertain: false
    };
    
    // 缓存成功结果
    loginStatusCache.set(`login_status_${userId}`, {
      result: quickResult,
      timestamp: Date.now()
    });
    
    // 如果强制刷新，才加载配置并进行容器验证
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
        return res.json(quickResult); // 即使没有配置，也返回已登录（因为文件存在）
      }
      
      // 验证输入
      const validatedApiId = validateInput(apiId, 'number');
      const validatedApiHash = validateInput(apiHash);
      
      // 如果强制刷新，才进行容器验证（但使用较短的超时）
      let checkResult = null;
      let checkError = null;
      
      try {
        // 使用较短的超时时间（3秒），快速失败
        const quickTimeout = 3000; // 3秒超时（进一步减少）
        checkResult = await Promise.race([
          execTelethonLoginScript('check', [
            sessionPath,
            validatedApiId.toString(),
            validatedApiHash
          ], 0, true), // allowCreateTemp = true
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('检查超时（3秒）')), quickTimeout)
          )
        ]);
      } catch (error) {
        checkError = error;
        // 容器验证失败不影响结果，因为文件存在就认为已登录
      }
      
      // 如果容器验证成功，使用验证结果
      if (checkResult && checkResult.success && checkResult.logged_in) {
        const verifiedResult = {
          logged_in: true,
          message: '已登录',
          user: checkResult.user || null
        };
        loginStatusCache.set(`login_status_${userId}`, {
          result: verifiedResult,
          timestamp: Date.now()
        });
        return res.json(verifiedResult);
      }
    }
    
    // 默认返回快速结果（基于文件存在）
    return res.json(quickResult);
  } catch (error) {
    console.error('❌ [登录状态] 检查失败:', error);
    res.status(500).json({ error: '检查登录状态失败：' + error.message });
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
    
    const sessionPath = userId 
      ? `/app/session/telegram_${userId}`
      : '/app/session/telegram';
    
    try {
      // 使用安全的脚本调用方式，首次登录时创建可复用的临时容器
      const result = await execTelethonLoginScript('send_code', [
        validatedPhone,
        sessionPath,
        validatedApiId.toString(),
        validatedApiHash
      ], 0, true, userId, true); // allowCreateTemp=true, reuseContainer=true
      
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
    
    const sessionPath = userId 
      ? `/app/session/telegram_${userId}`
      : '/app/session/telegram';
    
    try {
      // 使用安全的脚本调用方式，复用已创建的临时容器
      const result = await execTelethonLoginScript('sign_in', [
        validatedPhone,
        validatedCode,
        validatedHash,
        validatedPassword || 'None',
        sessionPath,
        validatedApiId.toString(),
        validatedApiHash
      ], 0, true, userId, true); // allowCreateTemp=true, reuseContainer=true
      
      if (result.success) {
        // 登录成功，清理临时容器
        await cleanupTempLoginContainer(userId);
        // Telegram 登录成功后，同步用户配置并重启 Telethon 服务
        // 异步执行，不阻塞响应
        setTimeout(async () => {
          try {
            console.log(`🔄 Telegram 登录成功，开始同步用户 ${userId} 的配置并重启 Telethon 服务...`);
            
            // 等待一小段时间确保 session 文件完全写入（减少等待时间）
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // 验证 session 文件是否已生成
            const sessionPath = userId 
              ? `/app/session/telegram_${userId}`
              : '/app/session/telegram';
            const sessionExists = checkSessionFileExists(sessionPath);
            
            if (sessionExists) {
              console.log(`✅ Session 文件已确认存在: ${sessionPath}`);
            } else {
              console.warn(`⚠️  Session 文件可能还未完全写入，但继续尝试重启...`);
            }
            
            await syncUserConfigAndRestartTelethon(userId);
          } catch (error) {
            console.error('⚠️  Telegram 登录后同步配置失败（不影响登录）:', error);
          }
        }, 100);
        
        res.json({
          success: true,
          message: result.message || '登录成功！',
          user: result.user
        });
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
      // 出错时清理临时容器
      await cleanupTempLoginContainer(userId).catch(() => {});
      res.status(500).json({ 
        error: '验证失败：' + error.message 
      });
    }
  } catch (error) {
    console.error('验证登录请求失败:', error);
    res.status(500).json({ error: '验证失败：' + error.message });
  }
});

// 内部 API：发送 Telegram 消息（转发到Telethon服务的HTTP服务器）
app.post('/api/internal/telegram/send', async (req, res) => {
  try {
    const { target, message, userId } = req.body;
    
    if (!target || !message) {
      return res.status(400).json({ error: '缺少必要字段：target 和 message' });
    }
    
    // 转发请求到Telethon服务的HTTP服务器
    try {
      await axios.post(`${process.env.TELETHON_URL || 'http://telethon:8888'}/api/internal/telegram/send`, {
        target,
        message
      }, {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json'
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
// AI分析定时器（保留以兼容性，但不再使用全局定时器，改为每个用户独立定时器）
let aiAnalysisTimer = null; 
const userAITimers = new Map(); // 存储每个用户的定时器
const analyzingLocks = new Map(); // 防止重复提交：存储正在分析的用户ID和触发类型

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
      
      // 查询未分析的消息（不区分admin，因为这里是按userId查询的）
      // 排除最近被清除的消息（清除后5分钟内不自动分析，防止清除后立即被重新分析）
      const clearCooldownMinutes = 5; // 清除后5分钟内不自动分析
      const clearCooldownTime = new Date(Date.now() - clearCooldownMinutes * 60 * 1000);
      
      // 添加时间窗口检查：排除最近30秒内可能正在被分析的消息
      // 这样可以避免多个触发源同时分析相同的消息
      const analysisCooldownTime = new Date(Date.now() - 30000); // 30秒前
      
      const query = Log.find({ 
        userId: userIdObj, 
        ai_analyzed: false,
        $or: [
          { ai_cleared_at: null }, // 从未被清除过
          { ai_cleared_at: { $lt: clearCooldownTime } } // 或者清除时间已经超过5分钟
        ],
        // 排除最近30秒内可能正在被分析的消息（通过检查更新时间）
        $and: [
          {
            $or: [
              { updated_at: { $exists: false } }, // 没有更新时间字段（旧数据）
              { updated_at: { $lt: analysisCooldownTime } } // 或者更新时间在30秒前
            ]
          }
        ]
      }).sort({ time: -1 }).limit(maxMessages);
      unanalyzedMessages = await query;
      
      // 检查是否有更多未分析的消息（排除最近被清除的消息）
      const totalUnanalyzed = await Log.countDocuments({ 
        userId: userIdObj, 
        ai_analyzed: false,
        $or: [
          { ai_cleared_at: null },
          { ai_cleared_at: { $lt: clearCooldownTime } }
        ]
      });
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
    // 同时清除 ai_cleared_at 标记，因为消息已经被重新分析
    const messageIds = unanalyzedMessages.map(log => log._id);
    await Log.updateMany(
      { _id: { $in: messageIds }, userId: userIdObj },
      { $set: { ai_analyzed: true, ai_summary_id: summary._id, ai_cleared_at: null } }
    );

    console.log(`✅ AI 分析完成，情感: ${analysisResult.analysis.sentiment}, 风险: ${analysisResult.analysis.risk_level}`);
    
    // 根据配置发送告警
    const aiSendTelegram = config.ai_analysis?.ai_send_telegram !== false; // 默认启用
    const aiSendEmail = config.ai_analysis?.ai_send_email || false;
    const aiSendWebhook = config.ai_analysis?.ai_send_webhook || false;
    
    if (aiSendTelegram || aiSendEmail || aiSendWebhook) {
      const alertMessage = `🤖 AI 分析完成\n\n总分析消息数: ${unanalyzedMessages.length}\n情感倾向: ${analysisResult.analysis.sentiment}\n风险等级: ${analysisResult.analysis.risk_level}\n\n摘要:\n${analysisResult.analysis.summary}\n\n关键词: ${(analysisResult.analysis.keywords || []).join(', ')}`;
      
      // 发送 Telegram 告警（直接通过Telethon服务发送）
      if (aiSendTelegram && config.alert_target) {
        try {
          // 直接调用Telethon服务的HTTP接口发送消息
          await axios.post(`${process.env.TELETHON_URL || 'http://telethon:8888'}/api/internal/telegram/send`, {
            target: config.alert_target,
            message: alertMessage
          }, {
            timeout: 10000,
            headers: {
              'Content-Type': 'application/json'
            }
          });
          console.log('📱 AI 分析结果已通过 Telegram 发送到:', config.alert_target);
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
  // 清除所有现有定时器（包括旧的全局定时器）
  if (aiAnalysisTimer) {
    clearInterval(aiAnalysisTimer);
    aiAnalysisTimer = null;
  }
  userAITimers.forEach((timer) => clearInterval(timer));
  userAITimers.clear();
  
  try {
    const users = await User.find({ is_active: true });
    
    for (const user of users) {
      try {
        const userConfig = await loadUserConfig(user._id);
        const config = userConfig.toObject ? userConfig.toObject() : userConfig;
        
        console.log(`🔍 [定时器启动] 用户: ${user.username}, enabled: ${config.ai_analysis?.enabled}, trigger_type: ${config.ai_analysis?.analysis_trigger_type}`);
        
        if (!config.ai_analysis?.enabled || config.ai_analysis.analysis_trigger_type !== 'time') {
          console.log(`⏭️  [定时器启动] 用户 ${user.username} 未启用时间间隔触发的AI分析，跳过`);
          continue;
        }
        
        // 使用用户配置的时间间隔（确保是数字类型）
        const intervalMinutes = Number(config.ai_analysis.time_interval_minutes) || 30;
        const intervalMs = intervalMinutes * 60 * 1000;
        
        console.log(`🔍 [定时器启动] 用户: ${user.username}, 间隔: ${intervalMinutes} 分钟 (${intervalMs}ms, 类型: ${typeof intervalMinutes})`);
        
        // 为每个用户创建独立的定时器
        const timer = setInterval(async () => {
          try {
            console.log(`⏰ [定时触发] 为用户 ${user.username} 执行定时 AI 分析（间隔: ${intervalMinutes} 分钟）`);
            await performAIAnalysis('time', null, user._id.toString());
          } catch (err) {
            console.error(`❌ [定时触发] 为用户 ${user.username} 执行AI分析失败:`, err.message);
            console.error('错误堆栈:', err.stack);
          }
        }, intervalMs);
        
        userAITimers.set(user._id.toString(), timer);
        console.log(`✅ [定时器启动] 为用户 ${user.username} 启动 AI 定时分析，间隔: ${intervalMinutes} 分钟`);
      } catch (err) {
        console.error(`❌ [定时器启动] 为用户 ${user.username} 启动AI分析定时器失败:`, err.message);
        console.error('错误堆栈:', err.stack);
      }
    }
    
    if (userAITimers.size > 0) {
      console.log(`✅ AI 定时分析已启动，共 ${userAITimers.size} 个用户的定时器`);
    } else {
      console.log(`ℹ️  没有用户启用时间间隔触发的AI分析`);
    }
  } catch (err) {
    console.error('启动AI分析定时器失败:', err);
  }
}

// 监听新消息（用于计数触发）
async function checkMessageCountTrigger() {
  try {
    const users = await User.find({ is_active: true });
    
    for (const user of users) {
      try {
        const userConfig = await loadUserConfig(user._id);
        const config = userConfig.toObject ? userConfig.toObject() : userConfig;
        
        console.log(`🔍 [计数触发检查] 用户: ${user.username}, enabled: ${config.ai_analysis?.enabled}, trigger_type: ${config.ai_analysis?.analysis_trigger_type}`);
        
        if (!config.ai_analysis?.enabled || config.ai_analysis.analysis_trigger_type !== 'count') {
          continue;
        }
        
        const threshold = Number(config.ai_analysis.message_count_threshold) || 50;
        const userIdObj = new mongoose.Types.ObjectId(user._id);
        
        // 排除最近被清除的消息（清除后5分钟内不自动分析）
        const clearCooldownMinutes = 5;
        const clearCooldownTime = new Date(Date.now() - clearCooldownMinutes * 60 * 1000);
        
        const unanalyzedCount = await Log.countDocuments({ 
          userId: userIdObj,
          ai_analyzed: false,
          $or: [
            { ai_cleared_at: null }, // 从未被清除过
            { ai_cleared_at: { $lt: clearCooldownTime } } // 或者清除时间已经超过5分钟
          ]
        });
        
        console.log(`🔍 [计数触发检查] 用户: ${user.username}, 阈值: ${threshold} (类型: ${typeof threshold}), 未分析数量: ${unanalyzedCount} (类型: ${typeof unanalyzedCount})`);
        
        // 确保阈值和数量都是数字类型进行比较
        if (Number(unanalyzedCount) >= Number(threshold)) {
          console.log(`📊 [计数触发] 用户 ${user.username} 未分析消息达到阈值 ${threshold}（当前: ${unanalyzedCount}），触发 AI 分析`);
          await performAIAnalysis('count', null, user._id.toString());
        } else {
          console.log(`⏸️  [计数触发检查] 用户 ${user.username} 未分析消息 ${unanalyzedCount} < 阈值 ${threshold}，未触发`);
        }
      } catch (err) {
        console.error(`❌ [计数触发检查] 检查用户 ${user.username} 消息计数触发失败:`, err.message);
        console.error('错误堆栈:', err.stack);
      }
    }
  } catch (err) {
    console.error('❌ [计数触发检查] 检查消息计数触发失败:', err);
    console.error('错误堆栈:', err.stack);
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
