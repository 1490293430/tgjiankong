const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const axios = require('axios');
require('dotenv').config();

const Log = require('./logModel');

const app = express();
app.use(express.json());
app.use(cors());

const CONFIG_PATH = path.join(__dirname, 'config.json');
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';
const PORT = process.env.PORT || 3000;

// 默认配置
const defaultConfig = {
  keywords: [],
  channels: [],
  alert_keywords: [],
  alert_regex: [],
  alert_target: '',
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
  admin: {
    username: 'admin',
    password_hash: bcrypt.hashSync('admin123', 10) // 默认密码: admin123
  }
};

// 初始化配置文件
if (!fs.existsSync(CONFIG_PATH)) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
}

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

// 登录
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    
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
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    
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
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    delete config.admin; // 不返回管理员信息
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: '读取配置失败：' + error.message });
  }
});

// 更新配置
app.post('/api/config', authMiddleware, (req, res) => {
  try {
    const currentConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const newConfig = {
      ...currentConfig,
      ...req.body,
      admin: currentConfig.admin // 保持管理员配置不变
    };
    
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
    res.json({ status: 'ok', message: '配置保存成功' });
  } catch (error) {
    res.status(500).json({ error: '保存配置失败：' + error.message });
  }
});

// ===== 日志相关 API =====

// 获取日志列表（分页）
app.get('/api/logs', authMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 20;
    const keyword = req.query.keyword || '';
    const channelId = req.query.channelId || '';
    
    const query = {};
    if (keyword) {
      query.message = { $regex: keyword, $options: 'i' };
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
    res.status(500).json({ error: '获取日志失败：' + error.message });
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

// 推送告警
app.post('/api/alert/push', async (req, res) => {
  try {
    const { keyword, message, from, channel, channelId, messageId } = req.body;
    
    // 保存日志到数据库
    const log = new Log({
      channel: channel || 'Unknown',
      channelId: channelId || '',
      sender: from || 'Unknown',
      message,
      keywords: [keyword],
      messageId,
      alerted: true
    });
    await log.save();
    
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const actions = config.alert_actions;
    
    // 构建告警消息
    const alertMessage = `⚠️ 关键词告警触发

来源：${channel} (${channelId})
发送者：${from}
关键词：${keyword}
时间：${new Date().toLocaleString('zh-CN')}

消息内容：
${message}

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

// ===== 健康检查 =====
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`✅ API 服务运行在端口 ${PORT}`);
  console.log(`📝 默认用户名: admin`);
  console.log(`📝 默认密码: admin123`);
  console.log(`⚠️  请及时修改默认密码！`);
});
