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
    // 调试日志开关：默认关闭，避免高吞吐时 CPU 花在字符串处理/打印上
    // 可通过环境变量 AI_ANALYSIS_DEBUG_LOGS=true 打开
    this.debugLogs = String(process.env.AI_ANALYSIS_DEBUG_LOGS || '').toLowerCase() === 'true';
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
      // 构建分析内容（过滤系统自发的告警/分析推送，减少噪音；同时去重重复刷屏）
      const seen = new Set();
      const filtered = [];
      for (const msg of messages) {
        const text = String(msg?.text || '');
        if (!text) continue;
        // 过滤本系统生成的告警/分析消息（避免 AI 被“自己生成的内容”污染）
        if (text.startsWith('⚠️ 关键词告警触发') || text.startsWith('🤖 AI 分析完成')) {
          continue;
        }
        const key = `${msg?.channel || ''}||${msg?.sender || ''}||${text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        filtered.push(msg);
      }

      const messageTexts = filtered.map((msg, idx) => {
        return `[${idx + 1}] 来自 ${msg.sender || '未知'} 在 ${msg.channel || '未知频道'}:\n${msg.text}`;
      }).join('\n\n');

      // 使用自定义提示词或默认提示词
      const promptToUse = customPrompt !== null ? customPrompt : this.prompt;
      
      console.log(`🔄 AI 分析请求 (消息数: ${messageCount}, 超时: ${timeout/1000}秒, 重试: ${retryCount}/${maxRetries}, 提示词: ${promptToUse ? `"${promptToUse.substring(0, 30)}..."` : '(空)'})`);

      // 构建用户消息内容
      // 定义严格的JSON格式要求
      const jsonFormatExample = `{
  "sentiment": "neutral",
  "sentiment_score": 0.0,
  "categories": ["分类1", "分类2"],
  "summary": "把最终输出写在这里（允许较长）。如需分行，请在字符串内使用 \\\\n 表示换行（不要在引号内直接写真实换行符）。",
  "keywords": ["关键词1", "关键词2"],
  "topics": ["话题1", "话题2"],
  "risk_level": "low"
}`;
      
      let userContent = '';
      if (promptToUse && promptToUse.trim()) {
        // 如果有提示词：严格遵守提示词的输出结构，但把最终报告放进 summary 字段（仍然只返回 JSON）
        userContent = `${promptToUse}\n\n【Telegram 群聊天记录原文】\n${messageTexts}\n\n重要：\n- 你必须只返回一个有效的JSON对象，不要包含任何其他文本、解释或代码块标记。\n- 你必须严格遵守上方提示词的“输出结构/特殊规则/最终额外输出”。\n- 你的最终完整报告必须写入 summary 字段。\n- summary 如需分行，请在字符串内使用 \\\\n 表示换行（不要在引号内直接写真实换行符）。\n\nJSON格式如下：\n${jsonFormatExample}\n\n字段说明：\n- sentiment: 整体情感，必须是 \"positive\"、\"neutral\" 或 \"negative\" 之一\n- sentiment_score: 情感分数，-1到1之间的数字\n- categories: 主要内容分类，字符串数组\n- summary: 最终报告（可较长，允许用 \\\\n 表示分行）\n- keywords: 关键词列表，字符串数组，最多10个\n- topics: 主要话题，字符串数组\n- risk_level: 风险等级，必须是 \"low\"、\"medium\" 或 \"high\" 之一\n\n请严格按照上述格式返回JSON，不要添加任何其他内容。`;
      } else {
        // 如果提示词为空，只发送消息内容和严格的JSON格式要求
        userContent = `请分析以下消息内容，并返回JSON格式的分析结果。\n\n消息内容：\n${messageTexts}\n\n重要：你必须只返回一个有效的JSON对象，不要包含任何其他文本、解释或代码块标记。JSON格式如下：\n${jsonFormatExample}\n\n字段说明：\n- sentiment: 整体情感，必须是 "positive"、"neutral" 或 "negative" 之一\n- sentiment_score: 情感分数，-1到1之间的数字\n- categories: 主要内容分类，字符串数组\n- summary: 消息摘要（允许较长）。如需分行，请在字符串内使用 \\n 表示换行（不要在引号内直接写真实换行符）。\n- keywords: 关键词列表，字符串数组，最多10个\n- topics: 主要话题，字符串数组\n- risk_level: 风险等级，必须是 "low"、"medium" 或 "high" 之一\n\n请严格按照上述格式返回JSON，不要添加任何其他内容。`;
      }

      // 调用 OpenAI API
      const response = await axios.post(
        `${this.baseUrl}/chat/completions`,
        {
          model: this.model,
          messages: [
            {
              role: 'system',
              content: '你是一个专业的消息分析助手。你必须只返回一个有效的JSON对象（允许包含空白与换行）。不要输出任何额外文本、解释或代码块标记。务必让JSON可被严格解析。'
            },
            {
              role: 'user',
              content: userContent
            }
          ],
          temperature: 0.3, // 降低温度以提高JSON格式的一致性
          max_tokens: 2000  // 增加token限制，确保完整返回分析结果
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
      const content = response.data.choices?.[0]?.message?.content || '';
      
      // 检查内容是否为空
      if (!content || content.trim().length === 0) {
        console.error(`❌ [AI解析] API返回内容为空`);
        if (this.debugLogs) {
          console.error(`❌ [AI解析] 完整响应:`, JSON.stringify(response.data, null, 2));
        }
        
        // 检查是否有 finish_reason
        const finishReason = response.data.choices?.[0]?.finish_reason;
        if (finishReason) {
          console.error(`❌ [AI解析] finish_reason: ${finishReason}`);
          
          // 如果是长度限制，说明内容被截断
          if (finishReason === 'length') {
            throw new Error('AI 返回内容被截断（达到最大 token 限制），请增加 max_tokens 或减少消息数量');
          }
          
          // 如果是内容过滤，说明内容被过滤
          if (finishReason === 'content_filter') {
            throw new Error('AI 返回内容被过滤（可能包含敏感内容）');
          }
        }
        
        throw new Error('AI API 返回内容为空，可能是 API 配置问题或模型响应异常');
      }
      
      if (this.debugLogs) {
        console.log(`✅ [AI解析] 收到内容，长度: ${content.length} 字符`);
      }
      
      // 尝试解析 JSON
      let analysisResult;
      try {
        // 清理可能的代码块标记和多余空白
        let cleanContent = content
          .replace(/```json\n?/gi, '')  // 移除 ```json
          .replace(/```\n?/g, '')       // 移除 ```
          .replace(/^[\s\n]*/, '')      // 移除开头的空白和换行
          .replace(/[\s\n]*$/, '')      // 移除结尾的空白和换行
          .trim();
        
        // 尝试提取JSON对象（处理可能的额外文本）
        // 使用更精确的正则，匹配完整的JSON对象（支持嵌套）
        let jsonMatch = cleanContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          cleanContent = jsonMatch[0];
        } else {
          // 如果正则匹配失败，尝试查找第一个 { 到最后一个 } 之间的内容
          const firstBrace = cleanContent.indexOf('{');
          const lastBrace = cleanContent.lastIndexOf('}');
          if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            cleanContent = cleanContent.substring(firstBrace, lastBrace + 1);
          }
        }
        
        // 尝试修复常见的JSON格式问题
        // 1. 修复末尾多余的逗号（在对象和数组的最后一个元素后）
        cleanContent = cleanContent.replace(/,(\s*[}\]])/g, '$1');
        
        // 2. 修复未转义的控制字符（但保留换行符，因为可能在字符串中）
        // 只移除真正的控制字符，保留 \n, \r, \t 等转义序列
        cleanContent = cleanContent.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
        
        // 3. 尝试修复单引号（只在键名和字符串值中使用，但要小心处理）
        // 先尝试直接解析，如果失败再尝试修复单引号
        
        if (this.debugLogs) {
          console.log(`🔍 [AI解析] 原始内容长度: ${content.length}, 清理后长度: ${cleanContent.length}`);
          console.log(`🔍 [AI解析] 清理后的内容前500字符: ${cleanContent.substring(0, 500)}`);
        }
        
        // 尝试解析JSON
        try {
          analysisResult = JSON.parse(cleanContent);
        } catch (innerParseError) {
          // 如果第一次解析失败，尝试更激进的修复
          console.warn(`⚠️  [AI解析] 第一次JSON解析失败，尝试修复: ${innerParseError.message}`);
          
          // 尝试找到最外层的JSON对象（通过括号匹配）
          let braceCount = 0;
          let startIdx = -1;
          let endIdx = -1;
          for (let i = 0; i < cleanContent.length; i++) {
            if (cleanContent[i] === '{') {
              if (braceCount === 0) startIdx = i;
              braceCount++;
            } else if (cleanContent[i] === '}') {
              braceCount--;
              if (braceCount === 0) {
                endIdx = i;
                break;
              }
            }
          }
          
          if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
            let extractedJson = cleanContent.substring(startIdx, endIdx + 1);
            
            // 尝试修复单引号（只在键名和字符串值中使用）
            // 使用更智能的方法：只在键名和字符串值中替换单引号
            extractedJson = extractedJson.replace(/([{,]\s*)'([^']+)'(\s*:)/g, '$1"$2"$3'); // 键名
            extractedJson = extractedJson.replace(/:\s*'([^']*)'/g, ': "$1"'); // 字符串值
            
            // 再次修复末尾逗号
            extractedJson = extractedJson.replace(/,(\s*[}\]])/g, '$1');
            
            try {
              analysisResult = JSON.parse(extractedJson);
              if (this.debugLogs) {
                console.log(`✅ [AI解析] 修复后JSON解析成功`);
              }
            } catch (secondParseError) {
              // 如果还是失败，尝试最后一个方法：提取所有可能的字段
              console.warn(`⚠️  [AI解析] 修复后仍然失败: ${secondParseError.message}`);
              throw innerParseError; // 抛出原始错误，让外层catch处理
            }
          } else {
            throw innerParseError; // 如果找不到JSON对象，抛出原始错误
          }
        }
        
        if (this.debugLogs) {
          console.log(`✅ [AI解析] JSON解析成功，字段: ${Object.keys(analysisResult).join(', ')}`);
        }
        
        // 标准化 sentiment 值（支持中英文）
        if (analysisResult.sentiment) {
          const sentimentLower = String(analysisResult.sentiment).toLowerCase();
          if (sentimentLower.includes('积极') || sentimentLower.includes('positive')) {
            analysisResult.sentiment = 'positive';
          } else if (sentimentLower.includes('消极') || sentimentLower.includes('negative')) {
            analysisResult.sentiment = 'negative';
          } else {
            analysisResult.sentiment = 'neutral';
          }
        }
        
        // 标准化 risk_level 值（支持中英文）
        if (analysisResult.risk_level) {
          const riskLower = String(analysisResult.risk_level).toLowerCase();
          if (riskLower.includes('高') || riskLower.includes('high')) {
            analysisResult.risk_level = 'high';
          } else if (riskLower.includes('中') || riskLower.includes('medium')) {
            analysisResult.risk_level = 'medium';
          } else {
            analysisResult.risk_level = 'low';
          }
        }
        
        // 确保 summary 字段有值且是纯文本（不是JSON字符串）
        if (!analysisResult.summary || analysisResult.summary.trim() === '') {
          // 如果 summary 为空，尝试从其他字段生成摘要
          const topics = (analysisResult.topics || []).join('、');
          const categories = (analysisResult.categories || []).join('、');
          const keywords = (analysisResult.keywords || []).slice(0, 5).join('、');
          
          if (topics || categories) {
            analysisResult.summary = `主要话题：${topics || categories}${keywords ? `；关键词：${keywords}` : ''}`;
          } else if (content.length > 0) {
            // 如果都没有，从原始响应中提取前500字作为摘要（增加长度）
            analysisResult.summary = content.substring(0, 500).replace(/\n/g, ' ').trim();
          } else {
            analysisResult.summary = '暂无摘要（AI未返回有效内容）';
          }
        } else {
          // 如果 summary 存在，确保它是纯文本（不是JSON字符串）
          let summaryText = String(analysisResult.summary);
          
          // 如果 summary 看起来像JSON字符串，尝试解析
          if (summaryText.trim().startsWith('{') || summaryText.trim().startsWith('[')) {
            try {
              const parsed = JSON.parse(summaryText);
              // 如果解析成功，尝试提取文本内容
              if (typeof parsed === 'string') {
                summaryText = parsed;
              } else if (parsed.summary) {
                summaryText = String(parsed.summary);
              } else if (parsed.text) {
                summaryText = String(parsed.text);
              } else {
                // 如果无法提取，使用原始内容的前500字符
                summaryText = summaryText.substring(0, 500).replace(/\n/g, ' ').trim();
              }
            } catch (e) {
              // 解析失败，移除JSON格式标记，保留文本内容
              summaryText = summaryText
                .replace(/^[\s\n]*\{[\s\n]*/, '')
                .replace(/[\s\n]*\}[\s\n]*$/, '')
                .replace(/^[\s\n]*\[[\s\n]*/, '')
                .replace(/[\s\n]*\][\s\n]*$/, '')
                .replace(/["']/g, '')
                .trim();
            }
          }
          
          // 清理可能的JSON格式标记和转义字符
          summaryText = summaryText
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\'/g, "'")
            .replace(/```json\n?/gi, '')
            .replace(/```\n?/g, '')
            .trim();
          
          // 限制长度（放宽上限，避免把用户模板压缩成一句话）
          if (summaryText.length > 4000) {
            summaryText = summaryText.substring(0, 4000) + '...';
          }
          
          analysisResult.summary = summaryText;
        }
        
        // 确保其他必需字段有默认值
        if (!analysisResult.sentiment) analysisResult.sentiment = 'neutral';
        if (analysisResult.sentiment_score === undefined) analysisResult.sentiment_score = 0;
        if (!analysisResult.categories || analysisResult.categories.length === 0) analysisResult.categories = ['未分类'];
        if (!analysisResult.keywords) analysisResult.keywords = [];
        if (!analysisResult.topics) analysisResult.topics = [];
        if (!analysisResult.risk_level) analysisResult.risk_level = 'low';
        
        // 确保数组字段是数组类型
        if (!Array.isArray(analysisResult.categories)) {
          analysisResult.categories = [String(analysisResult.categories || '未分类')];
        }
        if (!Array.isArray(analysisResult.keywords)) {
          analysisResult.keywords = analysisResult.keywords ? [String(analysisResult.keywords)] : [];
        }
        if (!Array.isArray(analysisResult.topics)) {
          analysisResult.topics = analysisResult.topics ? [String(analysisResult.topics)] : [];
        }
        
        // 保存原始响应
        analysisResult.raw_response = content;
        
        if (this.debugLogs) {
          console.log(`✅ [AI解析] 解析结果 - sentiment: ${analysisResult.sentiment}, risk_level: ${analysisResult.risk_level}, summary长度: ${analysisResult.summary?.length || 0}`);
        }
      } catch (parseError) {
        // 如果 JSON 解析失败，尝试从原始文本中提取摘要
        console.error(`❌ [AI解析] JSON解析失败: ${parseError.message}`);
        if (this.debugLogs) {
          console.error(`❌ [AI解析] 原始内容前1000字符: ${content.substring(0, 1000)}`);
        }
        
        // 尝试从文本中提取结构化信息
        let extractedSummary = '';
        let extractedSentiment = 'neutral';
        let extractedRisk = 'low';
        let extractedKeywords = [];
        let extractedCategories = ['未分类'];
        
        // 如果内容不为空，尝试提取摘要
        if (content && content.trim().length > 0) {
          // 尝试提取摘要（优先查找summary字段）
          const summaryMatch = content.match(/summary[：:]\s*([^\n]+)/i) || 
                              content.match(/摘要[：:]\s*([^\n]+)/i) ||
                              content.match(/内容[：:]\s*([^\n]+)/i);
          
          if (summaryMatch && summaryMatch[1].trim().length > 0) {
            extractedSummary = summaryMatch[1].trim().substring(0, 1000); // 增加到1000字符
          } else {
            // 如果没有找到明确的摘要字段，提取前500字符作为摘要
            extractedSummary = content.replace(/\n+/g, ' ').trim().substring(0, 500);
          }
          
          // 如果提取的摘要为空或太短，使用更长的内容
          if (extractedSummary.length < 20) {
            extractedSummary = content.replace(/\n+/g, ' ').trim().substring(0, 1000);
          }
        }
        
        // 如果还是没有摘要，使用默认值
        if (!extractedSummary || extractedSummary.trim().length === 0) {
          if (!content || content.trim().length === 0) {
            extractedSummary = 'AI API 返回内容为空，可能是 API 配置问题、模型响应异常或达到 token 限制。';
          } else {
            extractedSummary = 'AI返回了内容，但格式无法解析。原始内容已保存。';
          }
        }
        
        // 尝试从文本中提取情感和风险信息
        const contentLower = content.toLowerCase();
        if (contentLower.includes('积极') || contentLower.includes('positive') || contentLower.includes('正面') || contentLower.includes('乐观')) {
          extractedSentiment = 'positive';
        } else if (contentLower.includes('消极') || contentLower.includes('negative') || contentLower.includes('负面') || contentLower.includes('悲观')) {
          extractedSentiment = 'negative';
        }
        
        if (contentLower.includes('高风险') || contentLower.includes('high risk') || contentLower.includes('危险')) {
          extractedRisk = 'high';
        } else if (contentLower.includes('中风险') || contentLower.includes('medium risk') || contentLower.includes('中等风险')) {
          extractedRisk = 'medium';
        }
        
        // 尝试提取关键词（从原始内容中）
        const keywordMatch = content.match(/关键词[：:]\s*([^\n]+)/i) || 
                            content.match(/keywords[：:]\s*([^\n]+)/i) ||
                            content.match(/key\s*words[：:]\s*([^\n]+)/i);
        if (keywordMatch) {
          extractedKeywords = keywordMatch[1].split(/[，,、;；\s]+/).map(k => k.trim()).filter(k => k && k.length > 0);
        }
        
        // 尝试提取分类
        const categoryMatch = content.match(/分类[：:]\s*([^\n]+)/i) || 
                             content.match(/categories[：:]\s*([^\n]+)/i) ||
                             content.match(/category[：:]\s*([^\n]+)/i);
        if (categoryMatch) {
          extractedCategories = categoryMatch[1].split(/[，,、;；\s]+/).map(c => c.trim()).filter(c => c && c.length > 0);
        }
        
        analysisResult = {
          sentiment: extractedSentiment,
          sentiment_score: 0,
          categories: extractedCategories.length > 0 ? extractedCategories : ['未分类'],
          summary: extractedSummary,
          keywords: extractedKeywords,
          topics: [],
          risk_level: extractedRisk,
          raw_response: content,
          parse_error: parseError.message
        };
        
        console.warn(`⚠️  [AI解析] 使用降级解析 - sentiment: ${extractedSentiment}, risk_level: ${extractedRisk}, summary长度: ${extractedSummary.length}`);
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
