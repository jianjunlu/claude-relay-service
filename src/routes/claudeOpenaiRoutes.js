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
const axios = require('axios')
const ProxyHelper = require('../utils/proxyHelper')
const config = require('../../config/config')

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
  const apiUrl = accountData.baseApi || accountData.apiUrl || 'https://api.openai.com'
  const targetUrl = `${apiUrl.replace(/\/$/, '')}/chat/completions`

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accountData.apiKey}`,
    'User-Agent': accountData.userAgent || 'crs/1.0'
  }

  const requestOptions = {
    method: 'POST',
    url: targetUrl,
    headers,
    data: openaiRequest,
    timeout: (config && config.requestTimeout) || 600000,
    responseType: isStream ? 'stream' : 'json',
    validateStatus: () => true
  }

  if (accountData.proxy) {
    const proxyAgent = ProxyHelper.createProxyAgent(accountData.proxy)
    if (proxyAgent) {
      requestOptions.httpsAgent = proxyAgent
      requestOptions.proxy = false
    }
  }

  try {
    const response = await axios(requestOptions)

    if (isStream) {
      if (response.status >= 400) {
        const chunks = []
        await new Promise((resolve) => {
          response.data.on('data', (chunk) => chunks.push(chunk))
          response.data.on('end', resolve)
          response.data.on('error', resolve)
          setTimeout(resolve, 5000)
        })

        const body = Buffer.concat(chunks).toString()
        const error = new Error('OpenAI stream request failed')
        error.status = response.status
        error.headers = response.headers
        error.body = body
        throw error
      }

      return response.data
    }

    const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)

    return {
      statusCode: response.status,
      headers: response.headers,
      body
    }
  } catch (error) {
    if (error.response) {
      const errorBody =
        typeof error.response.data === 'string'
          ? error.response.data
          : JSON.stringify(error.response.data)

      error.status = error.response.status
      error.headers = error.response.headers
      error.body = errorBody
    }

    throw error
  }
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
                  // 尝试从完整的 data 行中提取 usage 对象
                  const dataMatch = line.match(/data:\s*({.+})/)
                  if (dataMatch) {
                    const chunkData = JSON.parse(dataMatch[1])
                    if (chunkData.usage) {
                      totalInputTokens = chunkData.usage.prompt_tokens || 0
                      totalOutputTokens = chunkData.usage.completion_tokens || 0
                    }
                  }
                }
              } catch (e) {
                // 忽略解析错误，不打印日志避免噪音
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

          // 请求成功，检查并移除限流状态（使用 then/catch 避免阻塞）
          unifiedOpenAIScheduler
            .isAccountRateLimited(accountId)
            .then((isRateLimited) => {
              if (isRateLimited) {
                logger.info(
                  `✅ Removing rate limit for OpenAI account ${accountId} after successful Claude-OpenAI stream`
                )
                return unifiedOpenAIScheduler.removeAccountRateLimit(accountId, accountType)
              }
            })
            .catch((error) => {
              logger.error(`❌ Failed to check/remove rate limit for account ${accountId}:`, error)
            })

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

        const status = error.status || error.response?.status || 500
        let errorPayload = {
          type: 'error',
          error: {
            type: 'api_error',
            message: 'Failed to connect to OpenAI API'
          }
        }

        // 处理 429 限流错误
        if (status === 429) {
          logger.warn(
            `🚫 Rate limit detected for OpenAI account ${accountId} (Claude-OpenAI stream)`
          )

          // 解析响应体中的限流信息
          let resetsInSeconds = null
          let errorData = null

          try {
            if (error.body) {
              errorData = JSON.parse(error.body)

              // 解析重置时间 - 支持多种格式
              if (errorData.msg && typeof errorData.msg === 'string') {
                // 匹配时间格式：2025-10-16 19:53:36 UTC+8
                const timeMatch = errorData.msg.match(
                  /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC\+(\d+)/
                )
                if (timeMatch) {
                  const [, timeStr, offsetHours] = timeMatch
                  const resetTime = new Date(`${timeStr}+0${offsetHours}:00`)
                  const now = new Date()
                  resetsInSeconds = Math.max(
                    0,
                    Math.ceil((resetTime.getTime() - now.getTime()) / 1000)
                  )
                  logger.info(
                    `🕐 Claude-OpenAI rate limit will reset in ${resetsInSeconds} seconds (${Math.ceil(resetsInSeconds / 60)} minutes)`
                  )
                }
              }

              if (!resetsInSeconds && errorData.resets_in_seconds) {
                resetsInSeconds = errorData.resets_in_seconds
              }
            }

            if (!resetsInSeconds) {
              logger.warn(
                '⚠️ Could not extract reset time from 429 response, using default 60 minutes'
              )
            }
          } catch (parseError) {
            logger.error('⚠️ Failed to parse rate limit error:', parseError)
          }

          // 标记账户为限流状态
          try {
            await unifiedOpenAIScheduler.markAccountRateLimited(
              accountId,
              accountType,
              null, // sessionHash - 流式请求通常不需要会话映射
              resetsInSeconds
            )
            logger.info(`✅ Marked OpenAI account ${accountId} as rate limited`)
          } catch (markError) {
            logger.error('❌ Failed to mark account as rate limited:', markError)
          }
        }

        if (error.body) {
          try {
            const parsed = JSON.parse(error.body)
            if (parsed && typeof parsed === 'object') {
              errorPayload = parsed
            }
          } catch (_) {
            errorPayload.error.message = error.body
          }
        } else if (error.message) {
          errorPayload.error.message = error.message
        }

        if (!res.headersSent) {
          res.status(status).json(errorPayload)
        } else {
          res.end()
        }
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

        // 请求成功，检查并移除限流状态
        const isRateLimited = await unifiedOpenAIScheduler.isAccountRateLimited(accountId)
        if (isRateLimited) {
          logger.info(
            `✅ Removing rate limit for OpenAI account ${accountId} after successful Claude-OpenAI request`
          )
          await unifiedOpenAIScheduler.removeAccountRateLimit(accountId, accountType)
        }

        // 返回 Claude 格式响应
        res.json(claudeResponse)

        const duration = Date.now() - startTime
        logger.info(`✅ Claude-OpenAI request completed in ${duration}ms`)
      } catch (error) {
        logger.error('❌ Failed to send request to OpenAI:', error)

        const status = error.status || error.response?.status || 500
        let errorPayload = {
          type: 'error',
          error: {
            type: 'api_error',
            message: 'Failed to connect to OpenAI API'
          }
        }

        // 处理 429 限流错误
        if (status === 429) {
          logger.warn(
            `🚫 Rate limit detected for OpenAI account ${accountId} (Claude-OpenAI non-stream)`
          )

          // 解析响应体中的限流信息
          let resetsInSeconds = null
          let errorData = null

          try {
            if (error.body) {
              errorData = JSON.parse(error.body)

              // 解析重置时间 - 支持多种格式
              if (errorData.msg && typeof errorData.msg === 'string') {
                // 匹配时间格式：2025-10-16 19:53:36 UTC+8
                const timeMatch = errorData.msg.match(
                  /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC\+(\d+)/
                )
                if (timeMatch) {
                  const [, timeStr, offsetHours] = timeMatch
                  const resetTime = new Date(`${timeStr}+0${offsetHours}:00`)
                  const now = new Date()
                  resetsInSeconds = Math.max(
                    0,
                    Math.ceil((resetTime.getTime() - now.getTime()) / 1000)
                  )
                  logger.info(
                    `🕐 Claude-OpenAI rate limit will reset in ${resetsInSeconds} seconds (${Math.ceil(resetsInSeconds / 60)} minutes)`
                  )
                }
              }

              if (!resetsInSeconds && errorData.resets_in_seconds) {
                resetsInSeconds = errorData.resets_in_seconds
              }
            }

            if (!resetsInSeconds) {
              logger.warn(
                '⚠️ Could not extract reset time from 429 response, using default 60 minutes'
              )
            }
          } catch (parseError) {
            logger.error('⚠️ Failed to parse rate limit error:', parseError)
          }

          // 标记账户为限流状态
          try {
            await unifiedOpenAIScheduler.markAccountRateLimited(
              accountId,
              accountType,
              null, // sessionHash - 非流式请求通常不需要会话映射
              resetsInSeconds
            )
            logger.info(`✅ Marked OpenAI account ${accountId} as rate limited`)
          } catch (markError) {
            logger.error('❌ Failed to mark account as rate limited:', markError)
          }
        }

        if (error.body) {
          try {
            const parsed = JSON.parse(error.body)
            if (parsed && typeof parsed === 'object') {
              errorPayload = parsed
            }
          } catch (_) {
            errorPayload.error.message = error.body
          }
        } else if (error.message) {
          errorPayload.error.message = error.message
        }

        return res.status(status).json(errorPayload)
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
