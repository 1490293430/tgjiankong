/**
 * AI 分析诊断脚本
 * 用于检查：
 * 1. 是否有新消息被记录到数据库
 * 2. 消息是否标记为 ai_analyzed: false
 * 3. AI 配置是否正确
 * 4. OpenAI API Key 是否配置
 */

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const Log = require('./logModel');
const AISummary = require('./aiSummaryModel');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/tglogs';

// 加载配置
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error('❌ 无法读取配置文件:', err.message);
  }
  return {};
}

async function diagnose() {
  console.log('\n🔍 开始诊断 AI 分析功能...\n');
  
  try {
    // 连接 MongoDB
    console.log('📊 连接 MongoDB...');
    await mongoose.connect(MONGO_URL, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ MongoDB 已连接\n');
    
    // 1. 检查数据库中的消息
    console.log('📝 检查数据库消息状态:');
    console.log('─'.repeat(60));
    
    const totalLogs = await Log.countDocuments();
    const unanalyzedLogs = await Log.countDocuments({ ai_analyzed: false });
    const analyzedLogs = await Log.countDocuments({ ai_analyzed: true });
    
    console.log(`总消息数: ${totalLogs}`);
    console.log(`待分析消息: ${unanalyzedLogs}`);
    console.log(`已分析消息: ${analyzedLogs}`);
    console.log();
    
    // 2. 显示最近的未分析消息
    if (unanalyzedLogs > 0) {
      console.log('📌 最近的未分析消息:');
      console.log('─'.repeat(60));
      const recentUnanalyzed = await Log.find({ ai_analyzed: false })
        .sort({ time: -1 })
        .limit(5)
        .select('channel sender message time keywords');
      
      recentUnanalyzed.forEach((log, idx) => {
        console.log(`${idx + 1}. [${new Date(log.time).toLocaleString('zh-CN')}]`);
        console.log(`   频道: ${log.channel}`);
        console.log(`   发送者: ${log.sender}`);
        console.log(`   消息: ${log.message.substring(0, 50)}${log.message.length > 50 ? '...' : ''}`);
        console.log(`   关键词: ${log.keywords.join(', ') || '(无)'}`);
        console.log();
      });
    } else {
      console.log('⚠️  没有待分析的消息\n');
    }
    
    // 3. 检查 AI 分析统计
    console.log('🤖 AI 分析统计:');
    console.log('─'.repeat(60));
    
    const totalAnalyses = await AISummary.countDocuments();
    const totalMessagesAnalyzed = await AISummary.aggregate([
      { $group: { _id: null, total: { $sum: '$message_count' } } }
    ]);
    
    console.log(`总分析次数: ${totalAnalyses}`);
    console.log(`已分析消息总数: ${totalMessagesAnalyzed[0]?.total || 0}`);
    console.log();
    
    // 4. 检查 AI 配置
    console.log('⚙️  AI 功能配置:');
    console.log('─'.repeat(60));
    
    const config = loadConfig();
    const aiConfig = config.ai_analysis || {};
    
    console.log(`启用状态: ${aiConfig.enabled ? '✅ 已启用' : '❌ 未启用'}`);
    console.log(`API Key 配置: ${aiConfig.openai_api_key ? '✅ 已配置' : '❌ 未配置'}`);
    console.log(`模型: ${aiConfig.openai_model || 'gpt-3.5-turbo'}`);
    console.log(`触发方式: ${aiConfig.analysis_trigger_type || 'time'}`);
    
    if (aiConfig.analysis_trigger_type === 'time') {
      console.log(`定时间隔: ${aiConfig.time_interval_minutes || 30} 分钟`);
    } else if (aiConfig.analysis_trigger_type === 'count') {
      console.log(`消息阈值: ${aiConfig.message_count_threshold || 50} 条`);
    }
    console.log();
    
    // 5. 给出建议
    console.log('💡 诊断结果:');
    console.log('─'.repeat(60));
    
    if (!aiConfig.enabled) {
      console.log('❌ AI 分析功能未启用');
      console.log('   → 请在 config.json 中设置 "ai_analysis.enabled": true');
    } else if (!aiConfig.openai_api_key) {
      console.log('❌ OpenAI API Key 未配置');
      console.log('   → 请在 config.json 中设置 "ai_analysis.openai_api_key"');
    } else if (totalLogs === 0) {
      console.log('⚠️  数据库中没有任何消息');
      console.log('   → Telethon 监控进程可能未正确运行');
      console.log('   → 请检查 Telethon 容器日志: docker-compose logs telethon');
    } else if (unanalyzedLogs === 0) {
      console.log('✅ 所有消息都已分析完成！');
    } else {
      console.log('✅ 有 ' + unanalyzedLogs + ' 条消息等待分析');
      console.log('   → 如果启用了定时分析，会在下次定时时自动分析');
      console.log('   → 可以点击"立即分析"按钮手动触发分析');
    }
    
    console.log('\n');
    
  } catch (error) {
    console.error('❌ 诊断失败:', error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

// 运行诊断
diagnose();
