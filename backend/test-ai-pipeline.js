/**
 * AI 分析链路测试脚本
 * 用途：
 * 1. 插入虚假测试消息到数据库
 * 2. 验证消息是否标记为 ai_analyzed=false
 * 3. 手动触发 AI 分析
 * 4. 验证分析结果是否保存
 */

const mongoose = require('mongoose');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const Log = require('./logModel');
const AISummary = require('./aiSummaryModel');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/tglogs';
const API_URL = process.env.API_URL || 'http://localhost:3000';
const CONFIG_PATH = path.join(__dirname, 'config.json');

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

// 获取 JWT Token（用于手动分析）
async function getToken() {
  try {
    const response = await axios.post(`${API_URL}/api/auth/login`, {
      username: 'admin',
      password: 'admin123'
    });
    return response.data.token;
  } catch (error) {
    console.error('❌ 获取 token 失败:', error.message);
    return null;
  }
}

// 主测试流程
async function runTest() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║          AI 分析链路端到端测试                              ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  try {
    // 连接 MongoDB
    console.log('📊 [步骤 1] 连接 MongoDB...');
    await mongoose.connect(MONGO_URL, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ MongoDB 已连接\n');

    // 第 1 阶段：插入测试消息
    console.log('📝 [步骤 2] 插入虚假测试消息到数据库...');
    console.log('─'.repeat(60));

    const testMessages = [
      {
        channel: '测试频道_001',
        channelId: '-1001234567890',
        sender: '测试用户_A',
        message: '这是一条正面情绪的测试消息。我对最新的产品非常满意，质量很好！😊',
        keywords: ['满意', '好'],
        messageId: Math.floor(Math.random() * 1000000),
        ai_analyzed: false
      },
      {
        channel: '测试频道_001',
        channelId: '-1001234567890',
        sender: '测试用户_B',
        message: '出现了一个严重的系统故障，所有用户都无法登录。这很紧急！🚨',
        keywords: ['故障', '紧急'],
        messageId: Math.floor(Math.random() * 1000000),
        ai_analyzed: false
      },
      {
        channel: '测试频道_002',
        channelId: '-1009876543210',
        sender: '测试用户_C',
        message: '今天的天气真不错，但销售数据下降了 15%。需要分析一下原因。',
        keywords: ['销售', '下降'],
        messageId: Math.floor(Math.random() * 1000000),
        ai_analyzed: false
      }
    ];

    const insertedLogs = await Log.insertMany(testMessages);
    console.log(`✅ 成功插入 ${insertedLogs.length} 条测试消息`);
    insertedLogs.forEach((log, idx) => {
      console.log(`   ${idx + 1}. ID: ${log._id} | 发送者: ${log.sender}`);
    });
    console.log();

    // 第 2 阶段：验证消息状态
    console.log('🔍 [步骤 3] 验证消息状态...');
    console.log('─'.repeat(60));

    const unanalyzedCount = await Log.countDocuments({ ai_analyzed: false });
    const analyzedCount = await Log.countDocuments({ ai_analyzed: true });

    console.log(`✅ 待分析消息: ${unanalyzedCount} 条`);
    console.log(`✅ 已分析消息: ${analyzedCount} 条`);
    console.log();

    if (unanalyzedCount === 0) {
      console.error('❌ 没有待分析的消息！测试失败。');
      process.exit(1);
    }

    // 第 3 阶段：获取 Token 并触发分析
    console.log('🤖 [步骤 4] 触发 AI 分析...');
    console.log('─'.repeat(60));

    const token = await getToken();
    if (!token) {
      console.error('❌ 无法获取认证 token');
      process.exit(1);
    }
    console.log('✅ 获取认证 token 成功\n');

    console.log('⏳ 正在调用 API 触发 AI 分析...');
    try {
      const analysisResponse = await axios.post(
        `${API_URL}/api/ai/analyze-now`,
        {},
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          timeout: 60000
        }
      );

      const result = analysisResponse.data;
      console.log('\n📊 AI 分析结果:');
      console.log('─'.repeat(60));

      if (result.success) {
        console.log(`✅ 分析成功！`);
        console.log(`   分析 ID: ${result.summary_id}`);
        console.log(`   消息数: ${result.message_count}`);
        console.log(`   情感: ${result.analysis?.sentiment || '未知'}`);
        console.log(`   风险等级: ${result.analysis?.risk_level || '未知'}`);
        console.log(`   关键词: ${(result.analysis?.keywords || []).join(', ') || '无'}`);
        console.log(`   摘要: ${result.analysis?.summary ? result.analysis.summary.substring(0, 100) + '...' : '无'}`);
      } else {
        console.log(`❌ 分析失败: ${result.error || result.message}`);
        console.log('\n🔧 可能的原因：');
        console.log('   1. AI 分析功能未启用');
        console.log('   2. OpenAI API Key 未配置或无效');
        console.log('   3. OpenAI API 服务不可用');
      }
    } catch (error) {
      console.log(`❌ API 调用失败: ${error.message}`);
      if (error.response?.data) {
        console.log('   错误详情:', error.response.data);
      }
    }
    console.log();

    // 第 4 阶段：验证分析结果
    console.log('✅ [步骤 5] 验证分析结果...');
    console.log('─'.repeat(60));

    const updatedUnanalyzedCount = await Log.countDocuments({ ai_analyzed: false });
    const updatedAnalyzedCount = await Log.countDocuments({ ai_analyzed: true });
    const totalSummaries = await AISummary.countDocuments();

    console.log(`✅ 待分析消息: ${updatedUnanalyzedCount} 条 (之前: ${unanalyzedCount})`);
    console.log(`✅ 已分析消息: ${updatedAnalyzedCount} 条 (之前: ${analyzedCount})`);
    console.log(`✅ 分析结果总数: ${totalSummaries} 条`);
    console.log();

    // 显示最新的分析结果
    if (totalSummaries > 0) {
      console.log('📋 最新分析结果:');
      console.log('─'.repeat(60));
      const latestSummary = await AISummary.findOne().sort({ createdAt: -1 });
      
      if (latestSummary) {
        console.log(`分析 ID: ${latestSummary._id}`);
        console.log(`分析时间: ${new Date(latestSummary.createdAt).toLocaleString('zh-CN')}`);
        console.log(`触发方式: ${latestSummary.trigger_type}`);
        console.log(`分析消息数: ${latestSummary.message_count}`);
        console.log(`情感倾向: ${latestSummary.analysis_result?.sentiment}`);
        console.log(`风险等级: ${latestSummary.analysis_result?.risk_level}`);
        console.log(`关键词: ${(latestSummary.analysis_result?.keywords || []).join(', ')}`);
        console.log(`主要话题: ${(latestSummary.analysis_result?.topics || []).join(', ')}`);
        console.log(`分类: ${(latestSummary.analysis_result?.categories || []).join(', ')}`);
        console.log();
      }
    }

    // 总结
    console.log('📊 [步骤 6] 测试总结');
    console.log('═'.repeat(60));

    console.log('\n✅ 链路验证结果:\n');

    const checks = [
      {
        name: '1. 数据库连接',
        status: true,
        details: 'MongoDB 已连接'
      },
      {
        name: '2. 消息插入',
        status: insertedLogs.length === testMessages.length,
        details: `插入 ${insertedLogs.length}/${testMessages.length} 条消息`
      },
      {
        name: '3. 消息状态标记',
        status: unanalyzedCount > 0,
        details: `${unanalyzedCount} 条消息标记为 ai_analyzed=false`
      },
      {
        name: '4. 认证 Token',
        status: !!token,
        details: token ? '成功获取 token' : '获取 token 失败'
      },
      {
        name: '5. API 分析调用',
        status: updatedAnalyzedCount > analyzedCount,
        details: `已分析消息从 ${analyzedCount} 增加到 ${updatedAnalyzedCount}`
      },
      {
        name: '6. 分析结果保存',
        status: totalSummaries > 0,
        details: `已保存 ${totalSummaries} 个分析结果`
      }
    ];

    checks.forEach(check => {
      const icon = check.status ? '✅' : '❌';
      console.log(`${icon} ${check.name}`);
      console.log(`   ${check.details}`);
    });

    const allPassed = checks.every(c => c.status);
    console.log('\n' + '═'.repeat(60));
    if (allPassed) {
      console.log('🎉 所有链路检查均已通过！AI 分析功能正常工作。\n');
    } else {
      console.log('⚠️  部分链路检查未通过，请查看上方详情并排查问题。\n');
    }

  } catch (error) {
    console.error('\n❌ 测试过程出错:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
  } finally {
    await mongoose.disconnect();
    console.log('✅ 数据库连接已关闭\n');
  }
}

// 运行测试
if (require.main === module) {
  runTest();
}

module.exports = { runTest };
