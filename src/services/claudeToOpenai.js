/**
 * Claude 到 OpenAI 格式转换服务
 * 处理 Claude API 格式与 OpenAI API 格式之间的转换
 */

const logger = require('../utils/logger')

class ClaudeToOpenAIConverter {
  constructor() {
    // 停止原因映射
    this.stopReasonMapping = {
      stop: 'end_turn',
      length: 'max_tokens',
      tool_calls: 'tool_use',
      content_filter: 'end_turn'
    }
  }

  /**
   * 将 Claude 请求格式转换为 OpenAI 格式
   * @param {Object} claudeRequest - Claude 格式的请求
   * @returns {Object} OpenAI 格式的请求
   */
  convertRequest(claudeRequest) {
    const openaiRequest = {
      model: this._mapClaudeModelToOpenAI(claudeRequest.model),
      messages: this._convertMessages(claudeRequest),
      max_tokens: claudeRequest.max_tokens,
      temperature: claudeRequest.temperature,
      top_p: claudeRequest.top_p,
      stream: claudeRequest.stream || false
    }

    // 处理停止序列
    if (claudeRequest.stop_sequences) {
      openaiRequest.stop = claudeRequest.stop_sequences
    }

    // 处理工具调用
    if (claudeRequest.tools) {
      openaiRequest.tools = this._convertTools(claudeRequest.tools)
      if (claudeRequest.tool_choice) {
        openaiRequest.tool_choice = this._convertToolChoice(claudeRequest.tool_choice)
      }
    }

    logger.debug('📝 Converted Claude request to OpenAI format:', {
      model: openaiRequest.model,
      messageCount: openaiRequest.messages.length,
      stream: openaiRequest.stream
    })

    return openaiRequest
  }

  /**
   * 将 OpenAI 响应格式转换为 Claude 格式
   * @param {Object} openaiResponse - OpenAI 格式的响应
   * @returns {Object} Claude 格式的响应
   */
  convertResponse(openaiResponse) {
    const choice = openaiResponse.choices[0]
    const message = choice.message

    const claudeResponse = {
      id: `msg_${this._generateId()}`,
      type: 'message',
      role: 'assistant',
      content: this._convertMessageContent(message),
      model: openaiResponse.model,
      stop_reason: this._mapStopReason(choice.finish_reason),
      stop_sequence: null,
      usage: this._convertUsage(openaiResponse.usage)
    }

    logger.debug('📝 Converted OpenAI response to Claude format:', {
      responseId: claudeResponse.id,
      stopReason: claudeResponse.stop_reason,
      usage: claudeResponse.usage
    })

    return claudeResponse
  }

  /**
   * 转换流式响应的单个数据块
   * @param {String} chunk - OpenAI SSE 数据块
   * @returns {String} Claude 格式的 SSE 数据块
   */
  convertStreamChunk(chunk, sessionId) {
    if (!chunk || chunk.trim() === '') {
      return ''
    }

    const lines = chunk.split('\n')
    const convertedEvents = []

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.substring(6)
        
        if (data === '[DONE]') {
          // OpenAI 的 [DONE] 转换为 Claude 的 message_stop
          convertedEvents.push('event: message_stop')
          convertedEvents.push('data: {"type":"message_stop"}')
          convertedEvents.push('')
          continue
        }

        try {
          const openaiChunk = JSON.parse(data)
          const claudeEvents = this._convertStreamEvent(openaiChunk, sessionId)
          
          if (claudeEvents && claudeEvents.length > 0) {
            convertedEvents.push(...claudeEvents)
          }
        } catch (e) {
          // 跳过无法解析的数据
          continue
        }
      }
    }

    return convertedEvents.length > 0 ? convertedEvents.join('\n') + '\n' : ''
  }

  /**
   * 映射 Claude 模型到 OpenAI 模型
   */
  _mapClaudeModelToOpenAI(claudeModel) {
    // Claude 模型映射到对应的 OpenAI 模型
    const modelMapping = {
      'claude-opus-4-20250514': 'gpt-4o',
      'claude-sonnet-4-20250514': 'gpt-4o',
      'claude-3-7-sonnet-20250219': 'gpt-4o',
      'claude-3-5-sonnet-20241022': 'gpt-4o',
      'claude-3-5-sonnet-20240620': 'gpt-4o',
      'claude-3-opus-20240229': 'gpt-4-turbo',
      'claude-3-sonnet-20240229': 'gpt-4-turbo',
      'claude-3-haiku-20240307': 'gpt-4o-mini'
    }

    return modelMapping[claudeModel] || 'gpt-4o'
  }

  /**
   * 转换消息格式
   */
  _convertMessages(claudeRequest) {
    const openaiMessages = []

    // 添加系统消息
    if (claudeRequest.system) {
      openaiMessages.push({
        role: 'system',
        content: claudeRequest.system
      })
    }

    // 转换用户/助手消息
    for (const msg of claudeRequest.messages) {
      const openaiMsg = {
        role: msg.role,
        content: this._convertMessageContent(msg)
      }

      openaiMessages.push(openaiMsg)
    }

    return openaiMessages
  }

  /**
   * 转换消息内容
   */
  _convertMessageContent(msg) {
    const { content } = msg

    // 字符串内容直接返回
    if (typeof content === 'string') {
      return content
    }

    // 数组内容需要转换
    if (Array.isArray(content)) {
      // 检查是否包含工具调用
      const hasToolUse = content.some((item) => item.type === 'tool_use')
      const hasToolResult = content.some((item) => item.type === 'tool_result')

      if (hasToolUse) {
        // 提取文本和工具调用
        const textParts = content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('')

        return textParts || null
      }

      if (hasToolResult) {
        // 工具结果转换为文本
        return content
          .map((item) => {
            if (item.type === 'tool_result') {
              return typeof item.content === 'string'
                ? item.content
                : JSON.stringify(item.content)
            }
            return item.text || ''
          })
          .join('\n')
      }

      // 转换多模态内容
      return content.map((item) => {
        if (item.type === 'text') {
          return {
            type: 'text',
            text: item.text
          }
        } else if (item.type === 'image') {
          // Claude 的 image 格式转换为 OpenAI 的 image_url
          const { source } = item
          let imageUrl

          if (source.type === 'base64') {
            imageUrl = `data:${source.media_type};base64,${source.data}`
          } else if (source.type === 'url') {
            imageUrl = source.url
          }

          return {
            type: 'image_url',
            image_url: {
              url: imageUrl
            }
          }
        }
        return item
      })
    }

    return content
  }

  /**
   * 转换工具定义
   */
  _convertTools(tools) {
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema
      }
    }))
  }

  /**
   * 转换工具选择
   */
  _convertToolChoice(toolChoice) {
    if (!toolChoice || toolChoice.type === 'auto') {
      return 'auto'
    }
    if (toolChoice.type === 'none') {
      return 'none'
    }
    if (toolChoice.type === 'any') {
      return 'required'
    }
    if (toolChoice.type === 'tool') {
      return {
        type: 'function',
        function: {
          name: toolChoice.name
        }
      }
    }
    return 'auto'
  }

  /**
   * 转换停止原因
   */
  _mapStopReason(openaiReason) {
    return this.stopReasonMapping[openaiReason] || 'end_turn'
  }

  /**
   * 转换使用统计
   */
  _convertUsage(openaiUsage) {
    if (!openaiUsage) {
      return {
        input_tokens: 0,
        output_tokens: 0
      }
    }

    return {
      input_tokens: openaiUsage.prompt_tokens || 0,
      output_tokens: openaiUsage.completion_tokens || 0
    }
  }

  /**
   * 转换流式事件
   */
  _convertStreamEvent(openaiChunk, sessionId) {
    const events = []
    const { choices } = openaiChunk

    if (!choices || choices.length === 0) {
      return events
    }

    const choice = choices[0]
    const { delta } = choice

    // 检查是否是第一个chunk（包含role）
    if (delta.role) {
      // message_start 事件
      events.push('event: message_start')
      events.push(
        `data: ${JSON.stringify({
          type: 'message_start',
          message: {
            id: sessionId || `msg_${this._generateId()}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model: openaiChunk.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        })}`
      )
      events.push('')
    }

    // 处理内容增量
    if (delta.content) {
      // content_block_start（首次）
      if (!this._lastContentBlockStarted) {
        events.push('event: content_block_start')
        events.push(
          `data: ${JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'text',
              text: ''
            }
          })}`
        )
        events.push('')
        this._lastContentBlockStarted = true
      }

      // content_block_delta
      events.push('event: content_block_delta')
      events.push(
        `data: ${JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: delta.content
          }
        })}`
      )
      events.push('')
    }

    // 处理工具调用
    if (delta.tool_calls) {
      for (const toolCall of delta.tool_calls) {
        const index = toolCall.index || 0

        if (toolCall.id) {
          // tool_use 开始
          events.push('event: content_block_start')
          events.push(
            `data: ${JSON.stringify({
              type: 'content_block_start',
              index,
              content_block: {
                type: 'tool_use',
                id: toolCall.id,
                name: toolCall.function?.name || '',
                input: {}
              }
            })}`
          )
          events.push('')
        }

        if (toolCall.function?.arguments) {
          // tool_use 参数增量
          events.push('event: content_block_delta')
          events.push(
            `data: ${JSON.stringify({
              type: 'content_block_delta',
              index,
              delta: {
                type: 'input_json_delta',
                partial_json: toolCall.function.arguments
              }
            })}`
          )
          events.push('')
        }
      }
    }

    // 处理结束
    if (choice.finish_reason) {
      // content_block_stop
      if (this._lastContentBlockStarted || delta.tool_calls) {
        events.push('event: content_block_stop')
        events.push(
          `data: ${JSON.stringify({
            type: 'content_block_stop',
            index: 0
          })}`
        )
        events.push('')
      }

      // message_delta
      events.push('event: message_delta')
      events.push(
        `data: ${JSON.stringify({
          type: 'message_delta',
          delta: {
            stop_reason: this._mapStopReason(choice.finish_reason),
            stop_sequence: null
          },
          usage: openaiChunk.usage ? this._convertUsage(openaiChunk.usage) : undefined
        })}`
      )
      events.push('')

      // 重置状态
      this._lastContentBlockStarted = false
    }

    return events
  }

  /**
   * 生成随机 ID
   */
  _generateId() {
    return (
      Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
    )
  }
}

module.exports = new ClaudeToOpenAIConverter()
