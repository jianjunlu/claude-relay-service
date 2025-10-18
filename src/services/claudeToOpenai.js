/**
 * Claude 到 OpenAI 格式转换服务
 * 处理 Claude API 格式与 OpenAI API 格式之间的转换
 */

const logger = require('../utils/logger')

class ClaudeToOpenAIConverter {
  constructor() {
    // 记录每个会话的流式状态，保证多请求互不干扰
    this._streamStates = new Map()
  }

  /**
   * 将 Claude 请求格式转换为 OpenAI 格式
   * @param {Object} claudeRequest - Claude 格式的请求
   * @returns {Object} OpenAI 格式的请求
   */
  convertRequest(claudeRequest) {
    const openaiRequest = {
      model: claudeRequest.model,
      messages: this._convertMessages(claudeRequest),
      stream: claudeRequest.stream || false
    }

    // 使用 max_completion_tokens 而不是 max_tokens（OpenAI 新标准）
    if (claudeRequest.max_tokens) {
      openaiRequest.max_completion_tokens = claudeRequest.max_tokens
    }

    // 处理停止序列
    if (claudeRequest.stop_sequences) {
      openaiRequest.stop = claudeRequest.stop_sequences
    }

    // 处理温度参数
    if (claudeRequest.temperature !== undefined) {
      openaiRequest.temperature = claudeRequest.temperature
    }

    // 处理 top_p 参数
    if (claudeRequest.top_p !== undefined) {
      openaiRequest.top_p = claudeRequest.top_p
    }

    // 处理工具调用
    if (claudeRequest.tools) {
      openaiRequest.tools = this._convertTools(claudeRequest.tools)

      if (claudeRequest.tool_choice) {
        const { toolChoice, parallelToolCalls } = this._convertToolChoice(claudeRequest.tool_choice)
        openaiRequest.tool_choice = toolChoice
        if (parallelToolCalls === false) {
          openaiRequest.parallel_tool_calls = false
        }
      }
    }

    // 处理元数据
    if (claudeRequest.metadata) {
      openaiRequest.metadata = {}
      for (const [key, value] of Object.entries(claudeRequest.metadata)) {
        if (value !== undefined && value !== null) {
          openaiRequest.metadata[key] = typeof value === 'string' ? value : JSON.stringify(value)
        }
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
    const choice = openaiResponse.choices?.[0]
    if (!choice) {
      throw new Error('Invalid OpenAI response: "choices" array is empty or missing.')
    }

    const { message } = choice
    const content = []

    // 处理文本内容
    if (message.content !== null && message.content !== undefined) {
      content.push({
        type: 'text',
        text: message.content,
        citations: null
      })
    }

    // 处理 reasoning_content（思考内容）
    // 这是非标准字段，由 DeepSeek-R1 引入，现已被广泛采用
    if (message.reasoning_content) {
      content.push({
        type: 'thinking',
        thinking: message.reasoning_content,
        signature: ''
      })
    }

    // 处理工具调用
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.type === 'function') {
          let input = toolCall.function.arguments
          try {
            input = JSON.parse(toolCall.function.arguments)
          } catch (e) {
            // 保持字符串格式
          }

          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input
          })
        }
      }
    }

    const claudeResponse = {
      id: openaiResponse.id || `msg_${this._generateId()}`,
      type: 'message',
      role: 'assistant',
      content,
      model: openaiResponse.model,
      stop_reason: this._mapStopReason(choice.finish_reason),
      stop_sequence: null,
      usage: {
        cache_creation: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        input_tokens: openaiResponse.usage?.prompt_tokens || 0,
        output_tokens: openaiResponse.usage?.completion_tokens || 0,
        server_tool_use: null,
        service_tier: 'standard'
      }
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

    const sessionKey = sessionId || 'default'
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
          this._resetStreamState(sessionKey)
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

    return convertedEvents.length > 0 ? `${convertedEvents.join('\n')}\n` : ''
  }

  /**
   * 获取或初始化流式状态
   */
  _getStreamState(sessionId) {
    const key = sessionId || 'default'
    if (!this._streamStates.has(key)) {
      this._streamStates.set(key, {
        messageStarted: false,
        textBlockStarted: false,
        thinkingBlockStarted: false,
        toolBlocks: new Map(),
        contentBlockIndex: 0,
        inputTokens: 0,
        outputTokens: 0
      })
    }

    const state = this._streamStates.get(key)
    if (!state.toolBlocks || typeof state.toolBlocks.clear !== 'function') {
      state.toolBlocks = new Map()
    }
    return state
  }

  /**
   * 重置流式状态
   */
  _resetStreamState(sessionId) {
    const key = sessionId || 'default'
    this._streamStates.delete(key)
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
      if (typeof claudeRequest.system === 'string') {
        openaiMessages.push({
          role: 'system',
          content: claudeRequest.system
        })
      } else if (Array.isArray(claudeRequest.system)) {
        // 系统消息是数组时，提取所有文本内容
        let text = ''
        for (const part of claudeRequest.system) {
          if (part.type === 'text') {
            text += part.text
          }
        }
        if (text) {
          openaiMessages.push({
            role: 'system',
            content: text
          })
        }
      }
    }

    // 转换用户/助手消息
    for (const msg of claudeRequest.messages) {
      const converted = this._convertMessageContent(msg)

      // 处理不同类型的消息
      if (Array.isArray(converted)) {
        // 多个消息（例如工具结果消息）
        openaiMessages.push(...converted)
      } else if (converted) {
        // 单个消息
        openaiMessages.push(converted)
      }
    }

    return openaiMessages
  }

  /**
   * 转换消息内容
   * @returns {Object|Array} 返回 OpenAI 消息对象或消息数组
   */
  _convertMessageContent(msg) {
    const { content, role } = msg

    // 字符串内容直接返回
    if (typeof content === 'string') {
      return {
        role,
        content
      }
    }

    // 数组内容需要转换
    if (Array.isArray(content)) {
      const textParts = []
      const contentParts = []
      const toolCalls = []
      const toolResults = []

      // 遍历所有内容块
      for (const contentBlock of content) {
        if (contentBlock.type === 'text') {
          const textPart = { type: 'text', text: contentBlock.text }
          textParts.push(textPart)
          contentParts.push(textPart)
        } else if (contentBlock.type === 'image') {
          // Claude 的 image 格式转换为 OpenAI 的 image_url
          const { source } = contentBlock
          let imageUrl

          if (source.type === 'base64') {
            imageUrl = `data:${source.media_type};base64,${source.data}`
          } else if (source.type === 'url') {
            imageUrl = source.url
          }

          if (imageUrl) {
            contentParts.push({
              type: 'image_url',
              image_url: { url: imageUrl }
            })
          }
        } else if (contentBlock.type === 'document') {
          // 处理文档内容块
          let base64Content = null
          if (contentBlock.source.type === 'base64') {
            base64Content = contentBlock.source.data
          } else if (contentBlock.source.type === 'text') {
            base64Content = Buffer.from(contentBlock.source.data).toString('base64')
          } else if (contentBlock.source.type === 'content') {
            if (typeof contentBlock.source.content === 'string') {
              base64Content = Buffer.from(contentBlock.source.content).toString('base64')
            }
          }

          if (base64Content) {
            contentParts.push({
              type: 'file',
              file: {
                file_data: base64Content,
                filename: contentBlock.title || undefined
              }
            })
          }
        } else if (contentBlock.type === 'tool_use') {
          // 助手消息中的工具调用
          toolCalls.push({
            type: 'function',
            id: contentBlock.id,
            function: {
              name: contentBlock.name,
              arguments: JSON.stringify(contentBlock.input)
            }
          })
        } else if (contentBlock.type === 'tool_result') {
          // 工具结果需要转换为单独的 tool 角色消息
          let toolContent = ''
          if (typeof contentBlock.content === 'string') {
            toolContent = contentBlock.content
          } else if (Array.isArray(contentBlock.content)) {
            const parts = []
            for (const part of contentBlock.content) {
              if (part.type === 'text') {
                parts.push({ type: 'text', text: part.text })
              }
            }
            toolContent = parts
          }

          toolResults.push({
            role: 'tool',
            tool_call_id: contentBlock.tool_use_id,
            content: toolContent
          })
        } else if (contentBlock.type === 'thinking') {
          // 思考内容（extended thinking）
          // 注意：这是非标准字段，但被许多模型支持
          // 暂时忽略，因为 OpenAI 标准 API 不直接支持
          logger.debug('Skipping thinking block in conversion')
        }
      }

      // 如果有工具结果，返回工具结果消息数组
      if (toolResults.length > 0) {
        return toolResults
      }

      // 助手消息：需要包含文本和工具调用
      if (role === 'assistant') {
        if (textParts.length > 0 || toolCalls.length > 0) {
          return {
            role: 'assistant',
            content: textParts.length > 0 ? textParts : null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined
          }
        }
      }

      // 用户消息：可以包含多模态内容
      if (role === 'user') {
        if (contentParts.length > 0) {
          return {
            role: 'user',
            content: contentParts
          }
        }
      }
    }

    // 默认返回
    return {
      role,
      content: typeof content === 'string' ? content : ''
    }
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
   * @returns {Object} { toolChoice, parallelToolCalls }
   */
  _convertToolChoice(toolChoice) {
    let result = 'auto'
    let parallelToolCalls = true

    if (!toolChoice) {
      return { toolChoice: result, parallelToolCalls }
    }

    switch (toolChoice.type) {
      case 'auto':
        result = 'auto'
        parallelToolCalls = !toolChoice.disable_parallel_tool_use
        break
      case 'any':
        result = 'required'
        parallelToolCalls = !toolChoice.disable_parallel_tool_use
        break
      case 'tool':
        result = {
          type: 'function',
          function: {
            name: toolChoice.name
          }
        }
        parallelToolCalls = !toolChoice.disable_parallel_tool_use
        break
      case 'none':
        result = 'none'
        break
      default:
        result = 'auto'
    }

    return { toolChoice: result, parallelToolCalls }
  }

  /**
   * 转换停止原因
   */
  _mapStopReason(openaiReason) {
    const mapping = {
      stop: 'end_turn',
      length: 'max_tokens',
      tool_calls: 'tool_use',
      function_call: 'tool_use',
      content_filter: 'refusal'
    }
    return mapping[openaiReason] || 'end_turn'
  }

  /**
   * 转换流式事件
   */
  _convertStreamEvent(openaiChunk, sessionId) {
    const events = []
    const state = this._getStreamState(sessionId)
    const choices = Array.isArray(openaiChunk.choices) ? openaiChunk.choices : []

    if (choices.length === 0) {
      return events
    }

    const choice = choices[0] || {}
    const delta = choice.delta || {}

    // 初始化消息
    if (delta.role && !state.messageStarted) {
      state.messageStarted = true
      state.textBlockStarted = false
      state.thinkingBlockStarted = false
      state.toolBlocks.clear()
      state.contentBlockIndex = 0
      state.inputTokens = 0
      state.outputTokens = 0

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
            usage: {
              cache_creation: null,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
              input_tokens: 0,
              output_tokens: 0,
              server_tool_use: null,
              service_tier: 'standard'
            }
          }
        })}`
      )
      events.push('')
    }

    // 处理文本内容
    if (delta.content) {
      // 停止已开始的其他块
      if (state.thinkingBlockStarted) {
        // 发送签名 delta 和停止事件
        events.push('event: content_block_delta')
        events.push(
          `data: ${JSON.stringify({
            type: 'content_block_delta',
            index: state.contentBlockIndex,
            delta: {
              type: 'signature_delta',
              signature: ''
            }
          })}`
        )
        events.push('')
        events.push('event: content_block_stop')
        events.push(
          `data: ${JSON.stringify({
            type: 'content_block_stop',
            index: state.contentBlockIndex
          })}`
        )
        events.push('')
        state.contentBlockIndex++
        state.thinkingBlockStarted = false
      }

      if (state.toolBlocks.size > 0) {
        for (const [index] of state.toolBlocks) {
          events.push('event: content_block_stop')
          events.push(
            `data: ${JSON.stringify({
              type: 'content_block_stop',
              index
            })}`
          )
          events.push('')
        }
        state.toolBlocks.clear()
        state.contentBlockIndex =
          Math.max(state.contentBlockIndex, ...Array.from(state.toolBlocks.keys())) + 1
      }

      // 开始文本块
      if (!state.textBlockStarted) {
        events.push('event: content_block_start')
        events.push(
          `data: ${JSON.stringify({
            type: 'content_block_start',
            index: state.contentBlockIndex,
            content_block: {
              type: 'text',
              text: '',
              citations: null
            }
          })}`
        )
        events.push('')
        state.textBlockStarted = true
      }

      // 发送文本增量
      events.push('event: content_block_delta')
      events.push(
        `data: ${JSON.stringify({
          type: 'content_block_delta',
          index: state.contentBlockIndex,
          delta: {
            type: 'text_delta',
            text: delta.content
          }
        })}`
      )
      events.push('')
    }
    // 处理思考内容（reasoning_content）
    else if (delta.reasoning_content) {
      // 停止已开始的其他块
      if (state.textBlockStarted) {
        events.push('event: content_block_stop')
        events.push(
          `data: ${JSON.stringify({
            type: 'content_block_stop',
            index: state.contentBlockIndex
          })}`
        )
        events.push('')
        state.contentBlockIndex++
        state.textBlockStarted = false
      }

      if (state.toolBlocks.size > 0) {
        for (const [index] of state.toolBlocks) {
          events.push('event: content_block_stop')
          events.push(
            `data: ${JSON.stringify({
              type: 'content_block_stop',
              index
            })}`
          )
          events.push('')
        }
        state.toolBlocks.clear()
        state.contentBlockIndex =
          Math.max(state.contentBlockIndex, ...Array.from(state.toolBlocks.keys())) + 1
      }

      // 开始思考块
      if (!state.thinkingBlockStarted) {
        events.push('event: content_block_start')
        events.push(
          `data: ${JSON.stringify({
            type: 'content_block_start',
            index: state.contentBlockIndex,
            content_block: {
              type: 'thinking',
              thinking: '',
              signature: ''
            }
          })}`
        )
        events.push('')
        state.thinkingBlockStarted = true
      }

      // 发送思考增量
      events.push('event: content_block_delta')
      events.push(
        `data: ${JSON.stringify({
          type: 'content_block_delta',
          index: state.contentBlockIndex,
          delta: {
            type: 'thinking_delta',
            thinking: delta.reasoning_content
          }
        })}`
      )
      events.push('')
    }
    // 处理工具调用
    else if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      // 停止已开始的文本或思考块
      if (state.textBlockStarted) {
        events.push('event: content_block_stop')
        events.push(
          `data: ${JSON.stringify({
            type: 'content_block_stop',
            index: state.contentBlockIndex
          })}`
        )
        events.push('')
        state.contentBlockIndex++
        state.textBlockStarted = false
      }

      if (state.thinkingBlockStarted) {
        events.push('event: content_block_delta')
        events.push(
          `data: ${JSON.stringify({
            type: 'content_block_delta',
            index: state.contentBlockIndex,
            delta: {
              type: 'signature_delta',
              signature: ''
            }
          })}`
        )
        events.push('')
        events.push('event: content_block_stop')
        events.push(
          `data: ${JSON.stringify({
            type: 'content_block_stop',
            index: state.contentBlockIndex
          })}`
        )
        events.push('')
        state.contentBlockIndex++
        state.thinkingBlockStarted = false
      }

      for (const toolCall of delta.tool_calls) {
        const index = toolCall.index ?? 0

        // 新工具调用开始
        if (toolCall.id) {
          // 关闭之前的工具块
          if (state.toolBlocks.has(index)) {
            events.push('event: content_block_stop')
            events.push(
              `data: ${JSON.stringify({
                type: 'content_block_stop',
                index
              })}`
            )
            events.push('')
          }

          const toolId = toolCall.id
          const toolName = toolCall.function?.name || ''

          state.toolBlocks.set(index, {
            started: true,
            id: toolId,
            name: toolName
          })

          // 开始新工具使用块
          events.push('event: content_block_start')
          events.push(
            `data: ${JSON.stringify({
              type: 'content_block_start',
              index,
              content_block: {
                type: 'tool_use',
                id: toolId,
                name: toolName,
                input: {}
              }
            })}`
          )
          events.push('')
        }

        // 累积工具参数
        if (toolCall.function?.arguments) {
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

    // 处理使用统计信息
    if (openaiChunk.usage) {
      if (openaiChunk.usage.prompt_tokens) {
        state.inputTokens = openaiChunk.usage.prompt_tokens
      }
      if (openaiChunk.usage.completion_tokens) {
        state.outputTokens = openaiChunk.usage.completion_tokens
      }
    }

    // 检查完成
    if (choice.finish_reason) {
      // 关闭当前内容块
      if (state.thinkingBlockStarted) {
        events.push('event: content_block_delta')
        events.push(
          `data: ${JSON.stringify({
            type: 'content_block_delta',
            index: state.contentBlockIndex,
            delta: {
              type: 'signature_delta',
              signature: ''
            }
          })}`
        )
        events.push('')
        events.push('event: content_block_stop')
        events.push(
          `data: ${JSON.stringify({
            type: 'content_block_stop',
            index: state.contentBlockIndex
          })}`
        )
        events.push('')
        state.thinkingBlockStarted = false
      }

      if (state.textBlockStarted) {
        events.push('event: content_block_stop')
        events.push(
          `data: ${JSON.stringify({
            type: 'content_block_stop',
            index: state.contentBlockIndex
          })}`
        )
        events.push('')
        state.textBlockStarted = false
      }

      if (state.toolBlocks.size > 0) {
        for (const [index] of state.toolBlocks) {
          events.push('event: content_block_stop')
          events.push(
            `data: ${JSON.stringify({
              type: 'content_block_stop',
              index
            })}`
          )
          events.push('')
        }
        state.toolBlocks.clear()
      }

      // 发送 message_delta 与停止原因和使用统计
      const messageDelta = {
        type: 'message_delta',
        delta: {
          stop_reason: this._mapStopReason(choice.finish_reason),
          stop_sequence: null
        },
        usage: {
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          input_tokens: 0,
          output_tokens: state.inputTokens + state.outputTokens,
          server_tool_use: null
        }
      }

      events.push('event: message_delta')
      events.push(`data: ${JSON.stringify(messageDelta)}`)
      events.push('')
    }

    return events
  }

  /**
   * 生成随机 ID
   */
  _generateId() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
  }
}

module.exports = new ClaudeToOpenAIConverter()
