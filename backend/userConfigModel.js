const mongoose = require('mongoose');

// 用户配置模型 - 每个主账号独立的配置（同一主账号下的所有子账号共享配置）
const userConfigSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true
  },
  // 主账号ID：用于数据隔离
  account_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    index: true
  },
  keywords: {
    type: [String],
    default: []
  },
  channels: {
    type: [String],
    default: []
  },
  alert_keywords: {
    type: [String],
    default: []
  },
  alert_regex: {
    type: [String],
    default: []
  },
  alert_target: {
    type: String,
    default: ''
  },
  log_all_messages: {
    type: Boolean,
    default: false
  },
  telegram: {
    api_id: {
      type: Number,
      default: 0
    },
    api_hash: {
      type: String,
      default: ''
    }
  },
  alert_actions: {
    telegram: {
      type: Boolean,
      default: true
    },
    email: {
      enable: {
        type: Boolean,
        default: false
      },
      smtp_host: {
        type: String,
        default: ''
      },
      smtp_port: {
        type: Number,
        default: 465
      },
      username: {
        type: String,
        default: ''
      },
      password: {
        type: String,
        default: ''
      },
      to: {
        type: String,
        default: ''
      }
    },
    webhook: {
      enable: {
        type: Boolean,
        default: false
      },
      url: {
        type: String,
        default: ''
      }
    }
  },
  ai_analysis: {
    enabled: {
      type: Boolean,
      default: false
    },
    openai_api_key: {
      type: String,
      default: ''
    },
    openai_model: {
      type: String,
      default: 'gpt-3.5-turbo'
    },
    openai_base_url: {
      type: String,
      default: 'https://api.openai.com/v1'
    },
    analysis_trigger_type: {
      type: String,
      enum: ['time', 'count'],
      default: 'time'
    },
    time_interval_minutes: {
      type: Number,
      default: 30
    },
    message_count_threshold: {
      type: Number,
      default: 50
    },
    max_messages_per_analysis: {
      type: Number,
      default: 500
    },
    analysis_prompt: {
      type: String,
      default: '请分析以下 Telegram 消息，提供：1) 整体情感倾向（积极/中性/消极）；2) 主要内容分类；3) 关键主题和摘要；4) 重要关键词'
    },
    ai_send_telegram: {
      type: Boolean,
      default: true
    },
    ai_send_email: {
      type: Boolean,
      default: false
    },
    ai_send_webhook: {
      type: Boolean,
      default: false
    },
    ai_trigger_enabled: {
      type: Boolean,
      default: false
    },
    ai_trigger_users: {
      type: [String],
      default: []
    },
    ai_trigger_prompt: {
      type: String,
      default: ''
    }
  }
}, {
  timestamps: true
});

// 创建索引
userConfigSchema.index({ userId: 1 });

module.exports = mongoose.model('UserConfig', userConfigSchema);

