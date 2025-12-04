const mongoose = require('mongoose');

// AI 批量分析结果 Schema
const aiSummarySchema = new mongoose.Schema({
  analysis_time: {
    type: Date,
    default: Date.now,
    index: true
  },
  message_count: {
    type: Number,
    required: true
  },
  messages_analyzed: [{
    log_id: mongoose.Schema.Types.ObjectId,
    text: String,
    sender: String,
    channel: String,
    timestamp: Date
  }],
  analysis_result: {
    sentiment: {
      type: String,
      enum: ['positive', 'neutral', 'negative'],
      default: 'neutral'
    },
    sentiment_score: {
      type: Number,
      min: -1,
      max: 1,
      default: 0
    },
    categories: [String],
    summary: String,
    keywords: [String],
    topics: [String],
    risk_level: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'low'
    },
    raw_response: String
  },
  model_info: {
    model: String,
    tokens_used: Number
  },
  trigger_type: {
    type: String,
    enum: ['manual', 'time', 'count'],
    default: 'manual'
  }
}, {
  timestamps: true
});

// 创建索引以提高查询效率
aiSummarySchema.index({ analysis_time: -1 });
aiSummarySchema.index({ 'analysis_result.sentiment': 1 });
aiSummarySchema.index({ 'analysis_result.risk_level': 1 });

const AISummary = mongoose.model('AISummary', aiSummarySchema);

module.exports = AISummary;
