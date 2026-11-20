// 可选的反向代理：在 127.0.0.1 上开一个 OpenAI 兼容端点，把请求转给 Accio。
//
// 为什么还要它：magpie 的供应商入口已经够 DSH/agent 用了；但「反代」本身
// 也是有用的 —— curl、Chatbox、其它只认 /v1 的工具都能直接指过来，而不必
// 经过 magpie 网关。
//
// 只绑回环地址；配置了 token 就要求 `Authorization: Bearer <token>`。

import { createServer } from 'node:http'
import { chat } from './accio.mjs'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}

const json = (response, status, payload) => {
  const text = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...CORS,
  })
  response.end(text)
}

const readBody = async (request) => {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 32 * 1024 * 1024) throw new Error('请求体超过 32MB')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const isLoopback = (address) =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'

/**
 * @param {{
 *   port: number, host?: string, token?: string,
 *   log?: (message: string) => void,
 *   getCredential: () => Promise<object>,
 *   getModels: () => Promise<Record<string, any>>,
 * }} options
 */
export async function startRelay(options) {
  const host = options.host ?? '127.0.0.1'
  const token = options.token ?? ''
  const log = options.log ?? (() => {})

  const authorised = (request) => {
    if (!isLoopback(request.socket.remoteAddress ?? '')) return false
    if (token === '') return true
    const header = String(request.headers.authorization ?? '')
    return header === `Bearer ${token}`
  }

  const server = createServer(async (request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, CORS).end()
      return
    }

    const url = new URL(request.url ?? '/', `http://${host}:${options.port}`)

    if (url.pathname === '/health') {
      json(response, 200, { ok: true, service: 'magpie-accio-relay' })
      return
    }

    if (!authorised(request)) {
      json(response, 401, { error: { type: 'authentication_error', message: '需要 loopback 来源或正确的 Bearer token' } })
      return
    }

    if (request.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      try {
        const models = await options.getModels()
        json(response, 200, {
          object: 'list',
          data: Object.entries(models).map(([id, model]) => ({
            id,
            object: 'model',
            owned_by: 'accio',
            ...(typeof model?.name === 'string' ? { name: model.name } : {}),
            ...(typeof model?.limit?.context === 'number' ? { context_window: model.limit.context } : {}),
          })),
        })
      } catch (error) {
        json(response, 502, { error: { type: 'provider_error', message: error?.message ?? String(error) } })
      }
      return
    }

    const isChat = request.method === 'POST'
      && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')

    if (!isChat) {
      json(response, 404, { error: { type: 'invalid_request_error', message: `未知路径：${url.pathname}` } })
      return
    }

    let body
    try {
      body = JSON.parse(await readBody(request))
    } catch (error) {
      json(response, 400, { error: { type: 'invalid_request_error', message: error?.message ?? '请求体不是 JSON' } })
      return
    }

    // 客户端断开就中止上游，别让被丢掉的流继续扣积分
    const controller = new AbortController()
    request.on('close', () => {
      if (!response.writableEnded) controller.abort()
    })

    let upstream
    try {
      const credential = await options.getCredential()
      upstream = await chat(credential, {
        body,
        signal: controller.signal,
        renew: options.renew,
      })
    } catch (error) {
      if (controller.signal.aborted) return
      json(response, 502, { error: { type: 'provider_error', message: error?.message ?? String(error) } })
      return
    }

    const headers = {
      'cache-control': 'no-store',
      ...CORS,
      ...(upstream.headers.get('content-type') === null
        ? {}
        : { 'content-type': upstream.headers.get('content-type') }),
    }
    response.writeHead(upstream.status, headers)

    if (upstream.body === null) {
      response.end()
      return
    }
    const reader = upstream.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        response.write(value)
      }
    } catch (error) {
      log(`反代流中断：${error?.message ?? error}`)
    } finally {
      response.end()
      await reader.cancel?.().catch(() => {})
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, host, () => {
      server.on('error', (error) => log(`反代服务错误：${error?.message ?? error}`))
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : options.port

  return {
    host,
    port,
    url: `http://${host}:${port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
