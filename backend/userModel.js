const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 50
  },
  password_hash: {
    type: String,
    required: true
  },
  display_name: {
    type: String,
    trim: true,
    maxlength: 100
  },
  is_active: {
    type: Boolean,
    default: true
  },
  // 主账号ID：如果为空，表示这是主账号；如果有值，表示这是子账号
  parent_account_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  last_login: {
    type: Date
  }
}, {
  timestamps: true
});

// 创建索引
userSchema.index({ username: 1 });
userSchema.index({ is_active: 1 });
userSchema.index({ parent_account_id: 1 });

// 虚拟字段：获取主账号ID（如果自己是主账号，返回自己的ID）
userSchema.virtual('account_id').get(function() {
  return this.parent_account_id || this._id;
});

module.exports = mongoose.model('User', userSchema);

