const mongoose = require('mongoose');

const logSchema = new mongoose.Schema({
  channel: {
    type: String,
    required: true
  },
  channelId: {
    type: String,
    required: true
  },
  sender: {
    type: String,
    default: 'Unknown'
  },
  message: {
    type: String,
    required: true
  },
  keywords: [{
    type: String
  }],
  time: {
    type: Date,
    default: Date.now
  },
  messageId: {
    type: Number
  },
  alerted: {
    type: Boolean,
    default: false
  },
  ai_analyzed: {
    type: Boolean,
    default: false
  },
  ai_summary_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AISummary'
  },
  // 记录AI分析被清除的时间戳（用于防止清除后立即被自动分析重新分析）
  ai_cleared_at: {
    type: Date,
    default: null
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false, // 允许为空，兼容旧数据或未设置USER_ID的情况
    index: true
  },
  // 主账号ID：用于数据隔离（同一个主账号下的所有子账号共享数据）
  account_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    index: true
  }
}, {
  timestamps: true
});

// 创建索引以提高查询性能
logSchema.index({ time: -1 });
logSchema.index({ channelId: 1 });
logSchema.index({ keywords: 1 });
logSchema.index({ ai_analyzed: 1 });
// AI 分析/计数触发常用查询：按用户过滤未分析消息，并结合清除冷却窗口
// 复合索引可显著减少 count/find 扫描带来的 CPU/IO
logSchema.index({ userId: 1, ai_analyzed: 1, ai_cleared_at: 1, time: -1 });

module.exports = mongoose.model('Log', logSchema);
