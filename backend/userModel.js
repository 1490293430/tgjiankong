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

module.exports = mongoose.model('User', userSchema);

