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
const AIAnalysisService = require('./services/aiAnalysis');

const app = express();

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
    analysis_prompt: '请分析以下 Telegram 消息，提供：1) 整体情感倾向（积极/中性/消极）；2) 主要内容分类；3) 关键主题和摘要；4) 重要关键词',
    ai_send_telegram: true,
    ai_send_email: false,
    ai_send_webhook: false,
    ai_trigger_enabled: false, // 是否启用固定用户触发
    ai_trigger_users: [] // 固定用户列表，当这些用户发送消息时立刻分析
  },
  admin: {
    username: 'admin',
    password_hash: bcrypt.hashSync('admin123', 10) // 默认密码: admin123
  }
};

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
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      console.log('⚠️  配置文件不存在或损坏，正在创建...');
      if (fs.existsSync(CONFIG_PATH)) {
        fs.rmSync(CONFIG_PATH, { recursive: true, force: true });
      }
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
      return defaultConfig;
    }
    throw err;
  }
}

// 初始化配置文件
loadConfig();

// 连接 MongoDB
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/tglogs';
mongoose.connect(MONGO_URL, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB 已连接'))
.catch(err => console.error('❌ MongoDB 连接失败:', err));

// JWT 验证中间件
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: '未授权：缺少 token' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: '未授权：token 无效' });
  }
};

// ===== 认证相关 API =====

// 登录（添加速率限制）
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    const config = loadConfig();
    
    if (username !== config.admin.username) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    
    const valid = await bcrypt.compare(password, config.admin.password_hash);
    if (!valid) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, username });
  } catch (error) {
    res.status(500).json({ error: '登录失败：' + error.message });
  }
});

// 修改密码
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const config = loadConfig();
    
    const valid = await bcrypt.compare(oldPassword, config.admin.password_hash);
    if (!valid) {
      return res.status(401).json({ error: '原密码错误' });
    }
    
    config.admin.password_hash = await bcrypt.hash(newPassword, 10);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    
    res.json({ status: 'ok', message: '密码修改成功' });
  } catch (error) {
    res.status(500).json({ error: '修改密码失败：' + error.message });
  }
});

// ===== 配置相关 API =====

// 获取配置（不包含敏感信息）
app.get('/api/config', authMiddleware, (req, res) => {
  try {
    const config = loadConfig();
    delete config.admin; // 不返回管理员信息
    
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
    
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: '读取配置失败：' + error.message });
  }
});

// 更新配置
app.post('/api/config', authMiddleware, (req, res) => {
  try {
    const currentConfig = loadConfig();
    const incoming = { ...req.body };
    
    // 校验并清理 telegram 字段
    if (incoming.telegram) {
      incoming.telegram.api_id = Number(incoming.telegram.api_id || 0);
      // ✅ 如果前端没有发送 api_hash（因为我们不返回），则保留原有值
      if (!incoming.telegram.api_hash) {
        incoming.telegram.api_hash = currentConfig.telegram?.api_hash || '';
      }
    }
    
    // 校验并保留 AI 配置中的敏感信息
    if (incoming.ai_analysis) {
      // ✅ 如果前端没有发送 API Key（因为我们不返回），则保留原有值
      if (!incoming.ai_analysis.openai_api_key) {
        incoming.ai_analysis.openai_api_key = currentConfig.ai_analysis?.openai_api_key || '';
      }
    }
    
    // 校验并保留邮箱密码
    if (incoming.alert_actions?.email) {
      // ✅ 如果前端没有发送密码（因为我们不返回），则保留原有值
      if (!incoming.alert_actions.email.password) {
        incoming.alert_actions.email.password = currentConfig.alert_actions?.email?.password || '';
      }
    }
    
    const newConfig = {
      ...currentConfig,
      ...incoming,
      admin: currentConfig.admin // 保持管理员配置不变
    };
    
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
    
    // 如果 AI 分析配置有变化，重启定时器
    if (incoming.ai_analysis) {
      setTimeout(() => {
        startAIAnalysisTimer();
        console.log('🔄 AI 分析配置已更新，定时器已重启');
      }, 1000);
    }
    
    res.json({ status: 'ok', message: '配置保存成功' });
  } catch (error) {
    // ✅ 改进的错误处理
    if (process.env.NODE_ENV === 'production') {
      console.error('[CONFIG_ERROR]', { timestamp: new Date().toISOString(), error: error.message });
      res.status(500).json({ error: '保存配置失败' });
    } else {
      res.status(500).json({ error: '保存配置失败：' + error.message });
    }
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
    
    const query = {};
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

// 获取统计信息
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const total = await Log.countDocuments();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayCount = await Log.countDocuments({
      time: { $gte: today }
    });
    
    const alertedCount = await Log.countDocuments({ alerted: true });
    
    const channelStats = await Log.aggregate([
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
    ]);
    
    res.json({
      total,
      todayCount,
      alertedCount,
      channelStats
    });
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
    const log = new Log({
      channel: cleanChannel,
      channelId: channelId || '',
      sender: cleanFrom,
      message: cleanMessage,
      keywords: [cleanKeyword],
      messageId,
      alerted: true
    });
    await log.save();
    
    const config = loadConfig();
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
    const config = loadConfig();
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
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 10;
    const sentiment = req.query.sentiment || '';
    const riskLevel = req.query.riskLevel || '';
    
    const query = {};
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
    const summary = await AISummary.findById(req.params.id);
    
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
    const result = await performAIAnalysis('manual');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: '触发 AI 分析失败：' + error.message });
  }
});

// 内部 API：Telethon 服务调用的 AI 分析接口（不需要认证）
app.post('/api/internal/ai/analyze-now', async (req, res) => {
  try {
    console.log('📋 Telethon 内部 API 调用: AI 分析');
    const result = await performAIAnalysis('user_message');
    res.json(result);
  } catch (error) {
    console.error('❌ 内部 AI 分析请求失败:', error.message);
    res.status(500).json({ error: '触发 AI 分析失败：' + error.message });
  }
});

// 获取 AI 分析统计信息
app.get('/api/ai/stats', authMiddleware, async (req, res) => {
  try {
    const total = await AISummary.countDocuments();
    const totalMessagesAnalyzed = await AISummary.aggregate([
      { $group: { _id: null, total: { $sum: '$message_count' } } }
    ]);
    
    const sentimentStats = await AISummary.aggregate([
      { $group: { _id: '$analysis_result.sentiment', count: { $sum: 1 } } }
    ]);
    
    const riskStats = await AISummary.aggregate([
      { $group: { _id: '$analysis_result.risk_level', count: { $sum: 1 } } }
    ]);
    
    const unanalyzedCount = await Log.countDocuments({ ai_analyzed: false });
    
    const config = loadConfig();
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
    startAIAnalysisTimer();
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
let messageCounter = 0;
let lastAnalysisTime = new Date();

// 执行 AI 批量分析
async function performAIAnalysis(triggerType = 'manual') {
  const config = loadConfig();
  
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
    // 查询未分析的消息
    const unanalyzedMessages = await Log.find({ ai_analyzed: false })
      .sort({ time: -1 })
      .limit(100); // 最多分析最近 100 条

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

    // 调用 AI 分析服务
    const analysisResult = await aiService.analyzeMessages(messagesToAnalyze);

    if (!analysisResult.success) {
      console.error('❌ AI 分析失败:', analysisResult.error);
      return analysisResult;
    }

    // 保存分析结果
    const summary = new AISummary({
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
      { _id: { $in: messageIds } },
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
    
    // 重置消息计数器
    messageCounter = 0;
    lastAnalysisTime = new Date();

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

// 启动 AI 分析定时器
function startAIAnalysisTimer() {
  const config = loadConfig();
  
  if (!config.ai_analysis?.enabled) {
    console.log('⏸️  AI 分析功能未启用');
    return;
  }

  const triggerType = config.ai_analysis.analysis_trigger_type || 'time';
  
  if (triggerType === 'time') {
    const intervalMinutes = config.ai_analysis.time_interval_minutes || 30;
    const intervalMs = intervalMinutes * 60 * 1000;
    
    if (aiAnalysisTimer) {
      clearInterval(aiAnalysisTimer);
    }
    
    aiAnalysisTimer = setInterval(() => {
      console.log(`⏰ 定时触发 AI 分析 (间隔: ${intervalMinutes} 分钟)`);
      performAIAnalysis('time');
    }, intervalMs);
    
    console.log(`✅ AI 定时分析已启动，间隔: ${intervalMinutes} 分钟`);
  } else if (triggerType === 'count') {
    const threshold = config.ai_analysis.message_count_threshold || 50;
    console.log(`✅ AI 计数触发已配置，阈值: ${threshold} 条消息`);
  }
}

// 监听新消息（用于计数触发）
async function checkMessageCountTrigger() {
  const config = loadConfig();
  
  if (!config.ai_analysis?.enabled || config.ai_analysis.analysis_trigger_type !== 'count') {
    return;
  }

  const threshold = config.ai_analysis.message_count_threshold || 50;
  const unanalyzedCount = await Log.countDocuments({ ai_analyzed: false });
  
  if (unanalyzedCount >= threshold) {
    console.log(`📊 未分析消息达到阈值 ${threshold}，触发 AI 分析`);
    await performAIAnalysis('count');
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
  setTimeout(() => {
    startAIAnalysisTimer();
  }, 3000);
});
