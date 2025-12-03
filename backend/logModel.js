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
  }
}, {
  timestamps: true
});

// 创建索引以提高查询性能
logSchema.index({ time: -1 });
logSchema.index({ channelId: 1 });
logSchema.index({ keywords: 1 });

module.exports = mongoose.model('Log', logSchema);
