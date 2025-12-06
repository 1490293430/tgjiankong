const axios = require('axios');

/**
 * AI 分析服务 - 使用 OpenAI API 批量分析 Telegram 消息
 */
class AIAnalysisService {
  constructor(config) {
    this.config = config;
    this.apiKey = config.openai_api_key;
    this.model = config.openai_model || 'gpt-3.5-turbo';
    this.baseUrl = config.openai_base_url || 'https://api.openai.com/v1';
    this.prompt = config.analysis_prompt || '请分析以下消息';
  }

  /**
   * 批量分析消息（带重试机制）
   * @param {Array} messages - 消息数组，每个消息包含 {text, sender, channel, timestamp}
   * @param {Number} retryCount - 当前重试次数（内部使用）
   * @param {String} customPrompt - 自定义提示词，如果提供则覆盖默认提示词
   * @returns {Promise<Object>} 分析结果
   */
  async analyzeMessages(messages, retryCount = 0, customPrompt = null) {
    if (!this.apiKey) {
      throw new Error('OpenAI API Key 未配置');
    }

    if (!messages || messages.length === 0) {
      return {
        success: false,
        error: '没有需要分析的消息'
      };
    }

    // 根据消息数量动态计算超时时间
    // 少量消息（<100条）：60秒
    // 中等消息（100-1000条）：120秒
    // 大量消息（1000-10000条）：300秒
    const messageCount = messages.length;
    let timeout = 60000; // 默认60秒
    if (messageCount >= 1000) {
      timeout = 300000; // 300秒（5分钟）
    } else if (messageCount >= 100) {
      timeout = 120000; // 120秒（2分钟）
    }

    const maxRetries = 3; // 最多重试3次
    const retryDelay = Math.pow(2, retryCount) * 1000; // 指数退避：1秒、2秒、4秒

    try {
      // 构建分析内容
      const messageTexts = messages.map((msg, idx) => {
        return `[${idx + 1}] 来自 ${msg.sender || '未知'} 在 ${msg.channel || '未知频道'}:\n${msg.text}`;
      }).join('\n\n');

      // 使用自定义提示词或默认提示词
      const promptToUse = customPrompt !== null ? customPrompt : this.prompt;
      
      console.log(`🔄 AI 分析请求 (消息数: ${messageCount}, 超时: ${timeout/1000}秒, 重试: ${retryCount}/${maxRetries}, 提示词: ${promptToUse ? `"${promptToUse.substring(0, 30)}..."` : '(空)'})`);

      // 构建用户消息内容
      let userContent = '';
      if (promptToUse && promptToUse.trim()) {
        // 如果有提示词，使用提示词格式
        userContent = `${promptToUse}\n\n消息内容：\n${messageTexts}\n\n请返回 JSON 格式，包含以下字段：\n- sentiment: 整体情感（positive/neutral/negative）\n- sentiment_score: 情感分数（-1到1之间）\n- categories: 主要内容分类（数组）\n- summary: 消息摘要（不超过200字）\n- keywords: 关键词列表（数组，最多10个）\n- topics: 主要话题（数组）\n- risk_level: 风险等级（low/medium/high）`;
      } else {
        // 如果提示词为空，只发送消息内容和JSON格式要求
        userContent = `消息内容：\n${messageTexts}\n\n请返回 JSON 格式，包含以下字段：\n- sentiment: 整体情感（positive/neutral/negative）\n- sentiment_score: 情感分数（-1到1之间）\n- categories: 主要内容分类（数组）\n- summary: 消息摘要（不超过200字）\n- keywords: 关键词列表（数组，最多10个）\n- topics: 主要话题（数组）\n- risk_level: 风险等级（low/medium/high）`;
      }

      // 调用 OpenAI API
      const response = await axios.post(
        `${this.baseUrl}/chat/completions`,
        {
          model: this.model,
          messages: [
            {
              role: 'system',
              content: '你是一个专业的消息分析助手，擅长分析 Telegram 群组消息的情感、内容和趋势。请用简洁的中文回复。'
            },
            {
              role: 'user',
              content: userContent
            }
          ],
          temperature: 0.7,
          max_tokens: 1000
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: timeout
        }
      );

      // 解析返回结果
      const content = response.data.choices[0].message.content;
      
      // 尝试解析 JSON
      let analysisResult;
      try {
        // 清理可能的代码块标记
        const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        analysisResult = JSON.parse(cleanContent);
        
        // 确保 summary 字段有值
        if (!analysisResult.summary || analysisResult.summary.trim() === '') {
          // 如果 summary 为空，尝试从其他字段生成摘要
          const topics = (analysisResult.topics || []).join('、');
          const categories = (analysisResult.categories || []).join('、');
          const keywords = (analysisResult.keywords || []).slice(0, 5).join('、');
          
          if (topics || categories) {
            analysisResult.summary = `主要话题：${topics || categories}${keywords ? `；关键词：${keywords}` : ''}`;
          } else if (content.length > 0) {
            // 如果都没有，从原始响应中提取前200字作为摘要
            analysisResult.summary = content.substring(0, 200).replace(/\n/g, ' ').trim();
          } else {
            analysisResult.summary = '暂无摘要（AI未返回有效内容）';
          }
        }
        
        // 确保其他必需字段有默认值
        if (!analysisResult.sentiment) analysisResult.sentiment = 'neutral';
        if (analysisResult.sentiment_score === undefined) analysisResult.sentiment_score = 0;
        if (!analysisResult.categories || analysisResult.categories.length === 0) analysisResult.categories = ['未分类'];
        if (!analysisResult.keywords) analysisResult.keywords = [];
        if (!analysisResult.topics) analysisResult.topics = [];
        if (!analysisResult.risk_level) analysisResult.risk_level = 'low';
        
        // 保存原始响应
        analysisResult.raw_response = content;
      } catch (parseError) {
        // 如果 JSON 解析失败，尝试从原始文本中提取摘要
        const extractedSummary = content.length > 0 ? content.substring(0, 200).replace(/\n/g, ' ').trim() : '无法解析AI返回内容';
        
        analysisResult = {
          sentiment: 'neutral',
          sentiment_score: 0,
          categories: ['未分类'],
          summary: extractedSummary,
          keywords: [],
          topics: [],
          risk_level: 'low',
          raw_response: content
        };
      }

      return {
        success: true,
        analysis: analysisResult,
        message_count: messages.length,
        model: this.model,
        analyzed_at: new Date(),
        tokens_used: response.data.usage?.total_tokens || 0
      };

    } catch (error) {
      // 详细错误信息
      let errorDetail = error.message;
      let shouldRetry = false;
      let statusCode = null;

      if (error.response) {
        statusCode = error.response.status;
        errorDetail = `API 错误 ${statusCode}: ${error.response.data?.error?.message || error.response.statusText}`;
        
        // 判断是否应该重试
        // 5xx 服务器错误和 429 限流错误可以重试
        // 4xx 客户端错误（除了429）不应该重试
        if (statusCode >= 500 || statusCode === 429) {
          shouldRetry = true;
        }
      } else if (error.code === 'ECONNABORTED') {
        // 超时错误可以重试
        errorDetail = `请求超时（${timeout/1000}秒），将重试`;
        shouldRetry = true;
      } else if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
        // 网络错误可以重试
        errorDetail = `网络错误: ${error.message}，将重试`;
        shouldRetry = true;
      }

      // 如果应该重试且未达到最大重试次数
      if (shouldRetry && retryCount < maxRetries) {
        console.warn(`⚠️  AI 分析失败，${retryDelay/1000}秒后重试 (${retryCount + 1}/${maxRetries}): ${errorDetail}`);
        
        // 等待后重试
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        
        // 递归重试（保留自定义提示词）
        return await this.analyzeMessages(messages, retryCount + 1, customPrompt);
      }

      // 不重试或已达到最大重试次数
      console.error(`❌ AI 分析失败 (已重试 ${retryCount} 次):`, errorDetail);
      
      return {
        success: false,
        error: errorDetail,
        message_count: messages.length,
        retry_count: retryCount
      };
    }
  }

  /**
   * 检查配置是否有效
   */
  isConfigured() {
    return !!(this.apiKey && this.model);
  }

  /**
   * 获取当前配置信息
   */
  getConfig() {
    return {
      model: this.model,
      base_url: this.baseUrl,
      api_key_configured: !!this.apiKey,
      trigger_type: this.config.analysis_trigger_type,
      time_interval: this.config.time_interval_minutes,
      count_threshold: this.config.message_count_threshold
    };
  }
}

module.exports = AIAnalysisService;
