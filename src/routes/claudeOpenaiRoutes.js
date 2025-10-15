/**
 * Claude 兼容的 OpenAI API 路由
 * 提供 Claude 格式的 API 接口，内部转发到 OpenAI
 */

const express = require('express')
const router = express.Router()
const logger = require('../utils/logger')
const { authenticateApiKey } = require('../middleware/auth')
const claudeToOpenai = require('../services/claudeToOpenai')
const apiKeyService = require('../services/apiKeyService')
const unifiedOpenAIScheduler = require('../services/unifiedOpenAIScheduler')
const openaiAccountService = require('../services/openaiAccountService')
const openaiResponsesAccountService = require('../services/openaiResponsesAccountService')
const { updateRateLimitCounters } = require('../utils/rateLimitHelper')
const https = require('https')
const http = require('http')
const { URL } = require('url')

// 🔧 辅助函数：检查 API Key 权限
function checkPermissions(apiKeyData, requiredPermission = 'openai') {
  const permissions = apiKeyData.permissions || 'all'
  return permissions === 'all' || permissions === requiredPermission
}

function queueRateLimitUpdate(rateLimitInfo, usageSummary, model, context = '') {
  if (!rateLimitInfo) {
    return
  }

  const label = context ? ` (${context})` : ''

  updateRateLimitCounters(rateLimitInfo, usageSummary, model)
    .then(({ totalTokens, totalCost }) => {
      if (totalTokens > 0) {
        logger.api(`📊 Updated rate limit token count${label}: +${totalTokens} tokens`)
      }
      if (typeof totalCost === 'number' && totalCost > 0) {
        logger.api(`💰 Updated rate limit cost count${label}: +$${totalCost.toFixed(6)}`)
      }
    })
    .catch((error) => {
      logger.error(`❌ Failed to update rate limit counters${label}:`, error)
    })
}

// 🔧 发送请求到 OpenAI API
async function sendToOpenAI(openaiRequest, accountData, isStream = false) {
  return new Promise((resolve, reject) => {
    // OpenAI Responses 账户使用 baseApi 字段，标准 OpenAI 账户使用 apiUrl 字段
    const apiUrl = accountData.baseApi || accountData.apiUrl || 'https://api.openai.com'
    const url = new URL(`${apiUrl}/chat/completions`)
    logger.info(
      `🌐 OpenAI API URL: ${url.toString()}, agent: ${accountData.userAgent}, apikey: ${accountData.apiKey}`
    )

    const requestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accountData.apiKey}`,
        'User-Agent': accountData.userAgent || 'crs/1.0'
      }
    }

    const client = url.protocol === 'https:' ? https : http
    const req = client.request(requestOptions, (res) => {
      if (isStream) {
        // 流式响应直接返回响应对象
        resolve(res)
      } else {
        // 非流式响应收集完整数据
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data
          })
        })
      }
    })

    req.on('error', (error) => {
      reject(error)
    })

    req.write(JSON.stringify(openaiRequest))
    req.end()
  })
}

// 🔧 处理消息请求的核心函数
async function handleMessagesRequest(req, res, apiKeyData) {
  const startTime = Date.now()

  try {
    // 检查权限
    if (!checkPermissions(apiKeyData, 'openai')) {
      return res.status(403).json({
        type: 'error',
        error: {
          type: 'permission_error',
          message: 'This API key does not have permission to access OpenAI'
        }
      })
    }

    // 记录原始请求
    logger.debug('📥 Received Claude format request:', {
      model: req.body.model,
      messageCount: req.body.messages?.length,
      stream: req.body.stream,
      maxTokens: req.body.max_tokens
    })

    // 转换 Claude 请求为 OpenAI 格式
    const openaiRequest = claudeToOpenai.convertRequest(req.body)

    // 检查模型限制
    if (apiKeyData.enableModelRestriction && apiKeyData.restrictedModels?.length > 0) {
      if (!apiKeyData.restrictedModels.includes(req.body.model)) {
        return res.status(403).json({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: `Model ${req.body.model} is not allowed for this API key`
          }
        })
      }
    }

    // 选择可用的 OpenAI 账户
    let accountSelection
    try {
      accountSelection = await unifiedOpenAIScheduler.selectAccountForApiKey(
        apiKeyData,
        null, // sessionHash - OpenAI 不需要 sticky session
        openaiRequest.model
      )
    } catch (error) {
      logger.error('❌ Failed to select OpenAI account:', error)
      return res.status(503).json({
        type: 'error',
        error: {
          type: 'overloaded_error',
          message: 'No available OpenAI accounts'
        }
      })
    }

    const { accountId, accountType } = accountSelection
    let { accountData } = accountSelection

    if (!accountData || accountData.apiKey === '***') {
      try {
        if (accountType === 'openai-responses') {
          accountData = await openaiResponsesAccountService.getAccount(accountId)
        } else if (accountType === 'openai') {
          accountData = await openaiAccountService.getAccount(accountId)
        }
      } catch (fetchError) {
        logger.error('❌ Failed to load OpenAI account details:', fetchError)
        accountData = null
      }
    }

    if (!accountData || !accountData.apiKey || accountData.apiKey === '***') {
      logger.error('❌ OpenAI account data is invalid or missing API key', {
        accountId,
        accountType
      })
      return res.status(503).json({
        type: 'error',
        error: {
          type: 'configuration_error',
          message: 'Selected OpenAI account is misconfigured'
        }
      })
    }
    // 处理流式请求
    if (openaiRequest.stream) {
      logger.info(`🌊 Processing Claude-OpenAI stream request for model: ${req.body.model}`)

      // 设置 SSE 响应头
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')

      try {
        // 发送流式请求到 OpenAI
        const openaiStream = await sendToOpenAI(openaiRequest, accountData, true)

        // 生成会话ID
        const sessionId = `msg_${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 15)}`

        let buffer = ''
        let totalInputTokens = 0
        let totalOutputTokens = 0

        openaiStream.on('data', (chunk) => {
          buffer += chunk.toString()
          logger.info(`🔄 Received OpenAI stream chunk: ${buffer}`)
          // 处理完整的 SSE 消息
          const lines = buffer.split('\n\n')
          buffer = lines.pop() || '' // 保留不完整的消息

          for (const line of lines) {
            if (line.trim()) {
              // 转换 OpenAI SSE 格式为 Claude 格式
              const claudeChunk = claudeToOpenai.convertStreamChunk(line, sessionId)

              // 尝试提取 usage 信息
              try {
                if (line.includes('"usage"')) {
                  const match = line.match(/"usage":\s*{[^}]+}/)
                  if (match) {
                    const usageJson = `{${match[0]}}`
                    const { usage } = JSON.parse(usageJson)
                    if (usage) {
                      totalInputTokens = usage.prompt_tokens || 0
                      totalOutputTokens = usage.completion_tokens || 0
                    }
                  }
                }
              } catch (e) {
                // 忽略解析错误
                logger.warn('⚠️ Failed to parse usage from stream chunk:', e)
              }

              if (claudeChunk) {
                res.write(claudeChunk)
              }
            }
          }
        })

        openaiStream.on('end', () => {
          // 确保发送 message_stop 事件
          res.write('event: message_stop\n')
          res.write('data: {"type":"message_stop"}\n\n')
          res.end()

          // 记录使用统计
          if (totalInputTokens > 0 || totalOutputTokens > 0) {
            const usage = {
              input_tokens: totalInputTokens,
              output_tokens: totalOutputTokens
            }

            apiKeyService
              .recordUsageWithDetails(apiKeyData.id, usage, req.body.model, accountId)
              .catch((error) => {
                logger.error('❌ Failed to record usage:', error)
              })

            queueRateLimitUpdate(
              req.rateLimitInfo,
              {
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
                cacheCreateTokens: 0,
                cacheReadTokens: 0
              },
              req.body.model,
              'claude-openai-stream'
            )
          }

          const duration = Date.now() - startTime
          logger.info(`✅ Claude-OpenAI stream request completed in ${duration}ms`)
        })

        openaiStream.on('error', (error) => {
          logger.error('❌ OpenAI stream error:', error)
          res.end()
        })

        // 处理客户端断开
        req.on('close', () => {
          logger.info('🔌 Client disconnected')
          openaiStream.destroy()
        })
      } catch (error) {
        logger.error('❌ Failed to initiate OpenAI stream:', error)
        res.status(500).json({
          type: 'error',
          error: {
            type: 'api_error',
            message: 'Failed to connect to OpenAI API'
          }
        })
      }
    } else {
      // 非流式请求
      logger.info(`📄 Processing Claude-OpenAI non-stream request for model: ${req.body.model}`)

      try {
        // 发送请求到 OpenAI
        const openaiResponse = await sendToOpenAI(openaiRequest, accountData, false)

        // 解析 OpenAI 响应
        let openaiData
        try {
          openaiData = JSON.parse(openaiResponse.body)
        } catch (error) {
          logger.error('❌ Failed to parse OpenAI response:', error)
          return res.status(502).json({
            type: 'error',
            error: {
              type: 'api_error',
              message: 'Invalid response from OpenAI API'
            }
          })
        }

        // 处理错误响应
        if (openaiResponse.statusCode >= 400) {
          return res.status(openaiResponse.statusCode).json({
            type: 'error',
            error: {
              type: openaiData.error?.type || 'api_error',
              message: openaiData.error?.message || 'OpenAI API error'
            }
          })
        }

        // 转换为 Claude 格式
        const claudeResponse = claudeToOpenai.convertResponse(openaiData)

        // 记录使用统计
        if (openaiData.usage) {
          const usage = {
            input_tokens: openaiData.usage.prompt_tokens || 0,
            output_tokens: openaiData.usage.completion_tokens || 0
          }

          apiKeyService
            .recordUsageWithDetails(apiKeyData.id, usage, req.body.model, accountId)
            .catch((error) => {
              logger.error('❌ Failed to record usage:', error)
            })

          queueRateLimitUpdate(
            req.rateLimitInfo,
            {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              cacheCreateTokens: 0,
              cacheReadTokens: 0
            },
            req.body.model,
            'claude-openai-non-stream'
          )
        }

        // 返回 Claude 格式响应
        res.json(claudeResponse)

        const duration = Date.now() - startTime
        logger.info(`✅ Claude-OpenAI request completed in ${duration}ms`)
      } catch (error) {
        logger.error('❌ Failed to send request to OpenAI:', error)
        res.status(500).json({
          type: 'error',
          error: {
            type: 'api_error',
            message: 'Failed to connect to OpenAI API'
          }
        })
      }
    }
  } catch (error) {
    logger.error('❌ Claude-OpenAI request error:', error)

    const status = error.status || 500
    res.status(status).json({
      type: 'error',
      error: {
        type: 'api_error',
        message: error.message || 'Internal server error'
      }
    })
  }
  return undefined
}

// 🚀 Claude 兼容的消息端点
router.post('/v1/messages', authenticateApiKey, async (req, res) => {
  await handleMessagesRequest(req, res, req.apiKey)
})

module.exports = router
