// Accio（阿里 Accio Work）协议层：登录 / 目录 / 对话 / 额度。
//
// 这一层不认识 magpie，只认识 HTTP 与 SSE，因此可以脱离宿主单测（test/ 里全是
// 对纯函数的用例，不联网）。
//
// ## 线上形状（2026-11 实测）
//
// ```
// POST {GATEWAY}/api/adk/llm/generateContent?sg_k={md5(requestId)}
//   headers: content-type / accept: text/event-stream / utdid / version / appKey
//   body   : Gemini 风格信封（contents/parts，snake_case）
//            ★ token 必须在 body.token：放 Authorization 头恒回流内 402
//   响应   : SSE，帧 = {content:{parts}, usage_metadata, finish_reason}
//            流内错误 = {error_code, error_message}（HTTP 仍是 200）
// ```
//
// 三个坑：① 上行 model 要 modelCode（`1Drift-…`），展示名只是对外 id；
// ② 工具结果必须 role:user + functionResponse，且紧挨着上一批 functionCall；
// ③ HTTP 200 + text/html 是风控拦截页，不是回复 —— 必须校验 content-type。

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

export const GATEWAY = 'https://phoenix-gw.alibaba.com'
/** 只做中国版：登录页固定 www.accio-ai.com。 */
export const LOGIN_BASE = 'https://www.accio-ai.com'

const TOKEN_EXCHANGE_PATH = '/api/oauth/token'
const REFRESH_PATH = '/api/auth/refresh_token'
const LLM_PATH = '/api/adk/llm/generateContent'
const CATALOG_PATH = '/api/llm/config/v2'
const SUBSCRIPTION_PATH = '/api/entitlement/currentSubscription'
const QUOTA_PATH = '/api/entitlement/quota'
const CALLBACK_PATH = '/auth/callback'

const CLIENT_ID = 'accio-work'
const APP_KEY = 'OneChat'
const APP_VERSION = '0.34.4'

const REQUEST_TIMEOUT_MS = 30_000
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
/** 临期提前量：到这个点之前就续，别等 401。 */
export const EXPIRY_LEAD_MS = 10 * 60 * 1000

/**
 * 出口代理。
 *
 * magpie 启动插件宿主时会把系统代理塞进 `HTTPS_PROXY/HTTP_PROXY/ALL_PROXY`
 * （实测 Bun 的 fetch 会照它走：把代理指到死端口，请求立刻失败），所以默认不用配；
 * 插件选项 `proxy` 给了就显式用 `init.proxy`（Bun 支持），优先于 env。
 */
let proxyUrl = ''

export function setProxy(url) {
  proxyUrl = typeof url === 'string' ? url.trim() : ''
  return proxyUrl
}

export const proxyOf = () => proxyUrl

const net = () => (proxyUrl === '' ? {} : { proxy: proxyUrl })

// ── 小工具 ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 上游 `expiresAt` 是**秒**；> 1e12 才当毫秒看。归一化漏了会「1970 年已过期」。 */
export function expiresAtMs(raw) {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n > 1e12 ? Math.round(n) : Math.round(n * 1000)
}

/** camelCase → snake_case（递归）。`undefined` 的键整个丢掉（null ≠ 缺键）。 */
export function toSnake(value) {
  if (Array.isArray(value)) return value.map(toSnake)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, val] of Object.entries(value)) {
      if (val === undefined) continue
      out[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = toSnake(val)
    }
    return out
  }
  return value
}

const requestIdOf = () => `req-${Date.now()}-${randomUUID().slice(0, 8)}`
export const sgKOf = (requestId) => createHash('md5').update(requestId, 'utf8').digest('hex')
const messageIdOf = (requestId) =>
  createHash('md5').update(`${requestId}:${randomBytes(16).toString('hex')}`, 'utf8').digest('hex')

/**
 * utdid：装机级稳定串。阿里网关拿它当风控基线，缺了会吃到「200 + 拦截页」。
 * 只放进程内存（插件不写宿主文件）。
 */
export function utdidOf() {
  const holder = globalThis
  holder.__accioUtdid ??= `accio-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
  return holder.__accioUtdid
}

/** 展示名 → 对外 id。为空时回退 modelCode。 */
export const slugOf = (name) =>
  String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

// ── 登录：PKCE + 本地 loopback 回调 ──────────────────────────────────────

export function createPkce() {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * 授权页地址。`code_challenge` 不能少 —— 少了登录页按 legacy 客户端处理，
 * 直接弹「请升级客户端」。
 */
export function buildAuthUrl({ redirectUri, state, codeChallenge }) {
  const params = new URLSearchParams({
    return_url: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    client_id: CLIENT_ID,
    ttid: `ttid_${randomBytes(16).toString('hex')}`,
    language: 'zh',
  })
  return `${LOGIN_BASE}/login?${params.toString()}`
}

/** 解析 `{success, code, message, data}` 信封；失败抛带服务端原文的错误。 */
export function unwrapEnvelope(path, status, text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`accio ${path} 返回非 JSON（HTTP ${status}）：${String(text).slice(0, 200)}`)
  }
  if (body?.success !== true) {
    throw new Error(`accio ${path} 失败（${String(body?.code ?? status)} ${String(body?.message ?? '')}）`.trim())
  }
  if (body.data === null || typeof body.data !== 'object') throw new Error(`accio ${path} 响应缺 data 对象`)
  return body.data
}

/** data → 凭据。三件套缺一不可；秒→毫秒在这里一次做完。 */
export function toCredential(path, data, extra = {}) {
  const access = data?.accessToken
  const refresh = data?.refreshToken
  const expires = expiresAtMs(data?.expiresAt)
  if (typeof access !== 'string' || access === '') throw new Error(`accio ${path} 响应缺 accessToken`)
  if (typeof refresh !== 'string' || refresh === '') throw new Error(`accio ${path} 响应缺 refreshToken`)
  if (expires === undefined) throw new Error(`accio ${path} 响应缺 expiresAt（或非正数）`)
  return {
    access_token: access,
    refresh_token: refresh,
    expires_at: expires,
    ...(typeof data.sgcookie === 'string' && data.sgcookie !== '' ? { sgcookie: data.sgcookie } : {}),
    ...extra,
  }
}

export async function exchangeCode({ code, codeVerifier, redirectUri }) {
  const res = await fetch(`${GATEWAY}${TOKEN_EXCHANGE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code, codeVerifier, clientId: CLIENT_ID, redirectUri }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...net(),
  })
  const text = await res.text()
  return toCredential(TOKEN_EXCHANGE_PATH, unwrapEnvelope(TOKEN_EXCHANGE_PATH, res.status, text))
}

const TERMINAL_MARKERS = [
  'invalid_grant', 'invalid refresh token', 'invalid refresh_token', 'refresh token has been used',
  'refresh_token has been used', 'refresh token expired', 'refresh_token expired', 'expired refresh token',
  'not_login',
]

/** refresh_token 真的不能用了（区别于网络抖动）。 */
export const isTerminalRefreshError = (error) => {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return TERMINAL_MARKERS.some((marker) => message.includes(marker))
}

/**
 * 续期。⚠️ 刷新会**轮换** refresh_token：并发续期 = 一个成功、其余 invalid_grant，
 * 失败方还会把好账号标死。调用方必须单飞（index.mjs 的 renew）。
 */
export async function refreshCredential(current) {
  if (typeof current?.refresh_token !== 'string' || current.refresh_token === '') {
    throw new Error('凭据缺少 refresh_token，请重新登录')
  }
  const res = await fetch(`${GATEWAY}${REFRESH_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ accessToken: current.access_token, refreshToken: current.refresh_token }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...net(),
  })
  const text = await res.text()
  const next = toCredential(REFRESH_PATH, unwrapEnvelope(REFRESH_PATH, res.status, text))
  if (typeof current.sgcookie === 'string' && next.sgcookie === undefined) next.sgcookie = current.sgcookie
  return next
}

export const isExpired = (credential, leadMs = EXPIRY_LEAD_MS) => {
  const at = expiresAtMs(credential?.expires_at)
  if (at === undefined) return false
  return at - Date.now() < leadMs
}

/**
 * 起本地回调服务 + 授权地址，**立刻**返回（宿主 authorize() 的硬约定：
 * 在这里等用户登录，宿主和插件会互相等死）。
 */
export async function beginLogin(openBrowser) {
  const pkce = createPkce()
  const state = randomBytes(32).toString('hex')

  let settleOk
  let settleFail
  const result = new Promise((resolve, reject) => {
    settleOk = resolve
    settleFail = reject
  })
  result.catch(() => {}) // 宿主未必 await：先挂 catch，避免 unhandledRejection 带走宿主

  let settled = false
  let timer
  let closed = false

  const page = (title, message) =>
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + `<title>${title}</title></head><body style="font-family:system-ui;padding:2rem">`
    + `<h2>${title}</h2><p>${message}</p></body></html>`

  const finish = (ok, payload) => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    if (!closed) {
      closed = true
      server.close()
    }
    ok ? settleOk(payload) : settleFail(payload)
  }
  const fail = (error) => finish(false, error instanceof Error ? error : new Error(String(error)))

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort ?? 0}`)
    const html = (status, title, message) =>
      response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(title, message))

    if (url.pathname !== CALLBACK_PATH) return html(404, 'Accio 授权', '未知的回调路径')

    const params = url.searchParams
    // state 必须原样匹配：否则本机任何进程都能把别人的授权码塞进你的账号
    if ((params.get('state') ?? '') !== state) {
      html(400, 'Accio 授权失败', 'state 校验失败，请回 magpie 重新发起登录')
      return fail(new Error('accio 回调 state 不匹配（可能是伪造回调）'))
    }
    const errorCode = params.get('error')
    if (errorCode !== null && errorCode !== '') {
      html(400, 'Accio 授权失败', `授权被拒绝：${errorCode}`)
      return fail(new Error(`accio 授权被拒绝（${errorCode}）`))
    }
    const code = params.get('code') ?? ''
    if (code === '') {
      html(400, 'Accio 授权失败', '回调里没有授权码')
      return fail(new Error('accio 回调缺少授权码'))
    }
    // 先回提示页，再后台换 token：用户不用盯着转圈的标签页
    html(200, 'Accio 授权', '授权已收到，可以关闭此页面并回到 magpie。')
    exchangeCode({ code, codeVerifier: pkce.verifier, redirectUri }).then(
      (credential) => finish(true, credential),
      (error) => fail(error),
    )
  })

  timer = setTimeout(() => fail(new Error('accio 登录超时（没收到授权回调）')), LOGIN_TIMEOUT_MS)
  timer.unref?.()

  // 先挂 error 再 listen：EADDRINUSE 是异步 error 事件，不挂会崩宿主进程
  const port = await new Promise((resolve, reject) => {
    let done = false
    server.once('error', (error) => {
      if (done) return
      done = true
      reject(error)
    })
    // 只绑回环：绑全网卡等于让局域网机器也能投伪造的 ?code=
    server.listen(0, '127.0.0.1', () => {
      done = true
      server.on('error', () => {})
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  }).catch((error) => {
    fail(new Error(`accio 回调端口无法监听（${error.message}）`))
    throw error
  })

  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`
  const url = buildAuthUrl({ redirectUri, state, codeChallenge: pkce.challenge })
  if (typeof openBrowser === 'function') {
    try {
      // 允许异步（插件自己起一个干净会话的浏览器）；打开失败不阻断，
      // 地址会回给宿主，由它自己去开
      await openBrowser(url)
    } catch { /* 同上 */ }
  }

  return {
    url,
    port,
    result,
    cancel: (reason = 'accio 登录已取消') => fail(new Error(reason)),
    instructions: `在打开的页面里完成 Accio（阿里）登录，`
      + `完成后本窗口自动继续；也可以手动打开：${url}`,
  }
}

// ── 目录 ──────────────────────────────────────────────────────────────────

/**
 * 远端目录条目归一。
 *
 * 三条筛选规则：
 *   ① `visible !== true` 剔除（服务端不下发的）；
 *   ② **`locked` 非空的剔除**（套餐不够用不了的，如国际区的 GPT 6 Astra）——
 *      拉进选择器只会让人选到一个必然失败的模型；
 *   ③ 没有 `modelCode` 或展示名的剔除（空 id 会让整个目录不可用）。
 */
export function normalizeModel(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  if (raw.visible !== true) return undefined
  if (raw.locked !== null && raw.locked !== undefined) return undefined
  const code = typeof raw.modelCode === 'string' ? raw.modelCode : ''
  if (code === '') return undefined
  const name = typeof raw.modelDisplayName === 'string' ? raw.modelDisplayName : ''
  const contextWindow = Number.isFinite(raw.contextWindow) ? raw.contextWindow : 0
  const multiple = Number.isFinite(raw.effectiveMultiple) ? raw.effectiveMultiple : undefined
  const maxTokens = Number.isFinite(raw.maxTokens) ? raw.maxTokens : undefined
  const efforts = Array.isArray(raw.reasoningEfforts)
    ? raw.reasoningEfforts.filter((e) => typeof e === 'string' && e.trim() !== '')
    : []
  const defaultEffort = typeof raw.defaultReasoningEffort === 'string' && raw.defaultReasoningEffort.trim() !== ''
    ? raw.defaultReasoningEffort
    : undefined
  return {
    id: code,
    name: name === '' ? code : name,
    contextWindow,
    supportsImage: raw.multimodal === true,
    ...(multiple !== undefined ? { multiple } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(efforts.length > 0 ? { efforts } : {}),
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
  }
}

/** `POST /api/llm/config/v2`（token 在 body）→ `data[].modelList[]`，按倍率升序。 */
export function parseCatalog(body) {
  const data = body?.data
  if (!Array.isArray(data)) return []
  const models = []
  for (const group of data) {
    for (const raw of Array.isArray(group?.modelList) ? group.modelList : []) {
      const entry = normalizeModel(raw)
      if (entry !== undefined) models.push(entry)
    }
  }
  // 缺倍率排最后（Infinity - Infinity = NaN 会把 sort 退化成不稳定原序）
  return models.sort((left, right) => {
    if (left.multiple === undefined && right.multiple === undefined) return 0
    if (left.multiple === undefined) return 1
    if (right.multiple === undefined) return -1
    return left.multiple - right.multiple
  })
}

/**
 * 兜底目录（远端目录失败时用）。modelCode 不可手写维护，只兜底；
 * 这份表来自中国区账号，国际区的模型（GPT/Grok）只能靠远端目录。
 */
export const FALLBACK_MODELS = [
  { id: '1Drift-N8kP2Q7wR5mX', name: 'Qwen 3.8 27B', contextWindow: 512_000, supportsImage: true, multiple: 0.013 },
  { id: '1Drift-F8hS3mK7pL2n', name: 'Qwen 3.8 Flash', contextWindow: 1_000_000, supportsImage: true, multiple: 0.03 },
  { id: '1Chronos-F53X9nQ3rT8w', name: 'GLM 5.3 Flash', contextWindow: 1_000_000, supportsImage: true, multiple: 0.03 },
  { id: '1Nova-Q3xM8vJ1rH6z', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000, supportsImage: true, multiple: 0.045 },
  { id: '1Zenith-M27hS2SR5xQ2p', name: 'MiniMax M3', contextWindow: 1_000_000, supportsImage: true, multiple: 0.08 },
  { id: '1Chronos-dX3cV9sA2mK7', name: 'GLM 5.1', contextWindow: 200_000, supportsImage: false, multiple: 0.12 },
  { id: '1Nexus-R3wF8qJ5vB6h', name: 'Standard', contextWindow: 1_000_000, supportsImage: true, multiple: 0.13 },
  { id: '1Drift-A3bM5nK8pQ2w', name: 'Qwen 3.5 A3B', contextWindow: 256_000, supportsImage: false, multiple: 0.13 },
  { id: '1Synapse-G5aJ8wL1dV4s', name: 'Kimi K2.6', contextWindow: 256_000, supportsImage: true, multiple: 0.14 },
  { id: '1Chronos-L53W8nP2qR6m', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImage: false, multiple: 0.16 },
  { id: '1Chronos-G5p2V9sA2mK7', name: 'GLM 5.2', contextWindow: 1_000_000, supportsImage: false, multiple: 0.16 },
  { id: '1Nova-bW7yT4kL9pN2', name: 'DeepSeek V4 Pro', contextWindow: 1_000_000, supportsImage: false, multiple: 0.17 },
  { id: '1Drift-T3TB6WS9a23w', name: 'Qwen 3.8 Max', contextWindow: 1_000_000, supportsImage: true, multiple: 0.44 },
  { id: '1Orbit-I9eY4tK8bW1f', name: 'Professional', contextWindow: 1_000_000, supportsImage: true, multiple: 1 },
  { id: '1Orbit-Q7hN3xR6cP2m', name: 'Ultimate', contextWindow: 1_000_000, supportsImage: true, multiple: 2.8 },
]

/** 展示名 slug ↔ modelCode 的进程内映射（目录刷新时重建）。 */
const modelIndex = []

export function setModelIndex(entries) {
  modelIndex.length = 0
  for (const entry of entries) modelIndex.push({ slug: slugOf(entry.name) || entry.id, code: entry.id, entry })
  return modelIndex
}

export const modelIndexOf = () => modelIndex

/** slug → modelCode。查不到就原样发（让上游报错，别在本地编一个空模型名）。 */
export function codeOf(id) {
  const wanted = String(id ?? '')
  const hit = modelIndex.find((item) => item.slug === wanted || item.code === wanted)
  return hit === undefined ? wanted : hit.code
}

export async function fetchCatalog(credential) {
  const res = await fetch(`${GATEWAY}${CATALOG_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ token: credential.access_token }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...net(),
  })
  if (!res.ok) throw new Error(`accio 目录请求 HTTP ${res.status}`)
  const parsed = parseCatalog(await res.json())
  if (parsed.length === 0) throw new Error('accio 目录里没有可见模型')
  return parsed
}

const variantMap = (entry) => {
  const out = {}
  if (Array.isArray(entry.efforts) && entry.efforts.length > 0) {
    for (const effort of entry.efforts) out[effort] = { reasoning_effort: effort }
  } else if (entry.defaultEffort !== undefined) {
    out[entry.defaultEffort] = { reasoning_effort: entry.defaultEffort }
  }
  return out
}

/**
 * 目录条目 → magpie/OpenCode 的模型描述。
 * ⚠️ 名字里带倍率（`Qwen 3.8 Flash · x0.03`）：倍率就是要花的积分倍数，
 * magpie 没有专门的字段，只能放在名字上给选择器显示。
 * ⚠️ magpie 判「模型能看图」读的是 `capabilities.input.image`，只写顶层不会生效。
 */
export function modelDescriptor(entry) {
  const context = entry.contextWindow > 0 ? entry.contextWindow : 128_000
  return {
    name: entry.multiple !== undefined ? `${entry.name} · x${entry.multiple}` : entry.name,
    limit: { context, output: entry.maxTokens ?? 8_192 },
    tool_call: true,
    capabilities: {
      temperature: true,
      // Accio 关不掉思考：档位只做展示
      reasoning: true,
      attachment: entry.supportsImage === true,
      toolcall: true,
      input: { text: true, image: entry.supportsImage === true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    options: {},
    headers: {},
    variants: variantMap(entry),
    status: 'active',
    release_date: '',
  }
}

/** 目录（含兜底）→ `{ [slug]: modelDescriptor }`，顺带重建 slug→code 映射。 */
export function catalogToModels(entries) {
  const list = Array.isArray(entries) && entries.length > 0 ? entries : FALLBACK_MODELS
  setModelIndex(list)
  const models = {}
  for (const { slug, entry } of modelIndex) models[slug] = modelDescriptor(entry)
  return models
}

// ── OpenAI 请求 → Gemini 信封 ────────────────────────────────────────────

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => typeof block?.text === 'string').map((block) => block.text).join('')
}

const dataUrlOf = (url) => {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(String(url ?? ''))
  return match === null ? undefined : { mimeType: match[1], data: match[2] }
}

/**
 * OpenAI 消息 → `{contents, systemInstruction}`。
 *
 * ⚠️ 工具结果要 `role:user + functionResponse`，**按 name 配对**（OpenAI 的 tool
 * 消息不带 name，得先扫 assistant 的 tool_calls 建 id→name 映射）。
 * ⚠️ functionResponse 必须紧密相邻：工具结果里内嵌的图片先攒着，
 *    等这一批 functionResponse 闭合之后，再作为**单独一条** user 消息追加。
 */
export function serializeMessages(messages) {
  const contents = []
  const system = []
  const toolNames = new Map()
  for (const message of messages) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (typeof call?.id === 'string' && typeof call?.function?.name === 'string') {
          toolNames.set(call.id, call.function.name)
        }
      }
    }
  }

  const pendingImages = []
  const collectToolImages = (content) => {
    if (!Array.isArray(content)) return
    for (const part of content) {
      if (part?.type === 'image_url') {
        const inline = dataUrlOf(part?.image_url?.url)
        if (inline !== undefined) pendingImages.push(inline)
      }
    }
  }
  const flushImages = () => {
    if (pendingImages.length === 0) return
    contents.push({
      role: 'user',
      parts: [{ text: 'Attached image(s) from tool result:' }, ...pendingImages.map((inline) => ({ inlineData: inline }))],
    })
    pendingImages.length = 0
  }

  for (const message of messages) {
    const role = message?.role
    if (role === 'system' || role === 'developer') {
      const text = textOf(message.content)
      if (text !== '') system.push(text)
      continue
    }

    if (role === 'tool') {
      const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : ''
      collectToolImages(message.content)
      // responseJson 只装文本：含图数组整体 stringify 会把巨大 base64 塞进 JSON
      const text = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.filter((part) => typeof part?.text === 'string').map((part) => part.text).join('')
          : JSON.stringify(message.content ?? {})
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { id, name: toolNames.get(id) ?? '', responseJson: text } }],
      })
      continue
    }

    if (role === 'assistant') {
      // 进下一条 model 消息前，上一批 functionResponse 必须已闭合
      flushImages()
      const parts = []
      const text = textOf(message.content)
      if (text !== '') parts.push({ text })
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        parts.push({
          functionCall: {
            id: typeof call?.id === 'string' ? call.id : '',
            name: typeof call?.function?.name === 'string' ? call.function.name : '',
            argsJson: typeof call?.function?.arguments === 'string' ? call.function.arguments : '{}',
          },
        })
      }
      if (parts.length > 0) contents.push({ role: 'model', parts })
      continue
    }

    // user：图片走 Gemini 的 inlineData（只收 base64 data URL）
    const parts = []
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (typeof block?.text === 'string') {
          if (block.text !== '') parts.push({ text: block.text })
          continue
        }
        if (block?.type === 'image_url') {
          const inline = dataUrlOf(block?.image_url?.url)
          if (inline === undefined) throw new Error('accio：图片只支持 base64 data URL，远程图片链接请先下载成 data URL')
          parts.push({ inlineData: inline })
        }
      }
    }
    if (parts.length > 0) {
      contents.push({ role: 'user', parts })
      continue
    }
    const text = textOf(message.content)
    if (text !== '') contents.push({ role: 'user', parts: [{ text }] })
  }

  flushImages()
  return { contents, systemInstruction: system.join('\n\n') }
}

export function toAccioTools(tools) {
  const out = []
  for (const tool of Array.isArray(tools) ? tools : []) {
    const fn = tool?.function
    if (fn === undefined || typeof fn.name !== 'string' || fn.name === '') continue
    out.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      // ⚠️ 必须是字符串：走 toSnake 下钻会改写 schema 里的参数名（filePath → file_path）
      parametersJson: JSON.stringify(fn.parameters ?? { type: 'object', properties: {} }),
    })
  }
  return out.length > 0 ? out : undefined
}

export function buildBody({ model, accessToken, contents, systemInstruction, tools, temperature, maxOutputTokens, stop, requestId }) {
  const camel = {
    model,
    empid: '',
    tenant: '',
    iaiTag: '',
    requestId,
    userRequestId: requestId,
    contents,
    // 必须是字符串：对象形态实测恒回「200 + 流内 400 Invalid request format」
    systemInstruction: systemInstruction === '' ? undefined : systemInstruction,
    tools: tools !== undefined && tools.length > 0 ? tools : undefined,
    temperature,
    maxOutputTokens,
    stopSequences: Array.isArray(stop) && stop.length > 0 ? stop : undefined,
    token: accessToken,
    messageId: messageIdOf(requestId),
    incremental: true,
  }
  const body = toSnake(camel)
  // properties 子树不参与 snake 转换（成功形状里 appKey 是驼峰、normalized_response 是 snake）
  body.properties = { utdid: utdidOf(), version: APP_VERSION, appKey: APP_KEY, normalized_response: 'true' }
  return body
}

export function requestHeaders(credential) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    utdid: utdidOf(),
    version: APP_VERSION,
    appKey: APP_KEY,
  }
  if (typeof credential?.sgcookie === 'string' && credential.sgcookie !== '') headers.sgcookie = credential.sgcookie
  return headers
}

// ── Accio SSE → OpenAI chunks ────────────────────────────────────────────

/** 工具参数分片合并：实测有两种形态（每帧重复完整参数 / 真增量），两种都收。 */
export function mergeToolArgs(fragments) {
  const nonEmpty = fragments.filter((fragment) => fragment !== '')
  if (nonEmpty.length === 0) return ''
  let cumulative = true
  for (let i = 1; i < nonEmpty.length; i += 1) {
    if (!nonEmpty[i].startsWith(nonEmpty[i - 1])) {
      cumulative = false
      break
    }
  }
  if (cumulative) return nonEmpty[nonEmpty.length - 1]
  let merged = ''
  for (const fragment of nonEmpty) merged = fragment.startsWith(merged) ? fragment : merged + fragment
  return merged
}

/** 流内错误帧：带 error_code/error_message 且 error_code !== '200'（200 是成功哨兵）。 */
export function isErrorFrame(frame) {
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return false
  const code = frame.error_code ?? frame.errorCode
  const message = frame.error_message ?? frame.errorMessage
  if ((code === undefined || code === '') && (message === undefined || message === '')) return false
  return String(code ?? '') !== '200'
}

const finishOf = (reason) => (reason === 'MAX_TOKENS' || reason === 'max_tokens' ? 'length' : 'stop')

/**
 * 消费 Accio SSE，产出 OpenAI `chat.completion.chunk` 文本帧。
 *
 * 帧里可能出现：`content.parts[]`（text / functionCall）、顶层 `function_call`、
 * `usage_metadata`、`finish_reason`；工具调用**分片**到达，按 id 缓冲到最后合并。
 * 上游流**没有 [DONE]**，读到 EOF 就是结束。
 */
export async function* accioSseToOpenAi(body, { model, signal } = {}) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const id = `chatcmpl-accio-${Date.now().toString(36)}`
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta, finish = null) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`

  let buffer = ''
  let sawAny = false
  let finishReason
  const usage = {}
  const calls = new Map()

  const noteUsage = (raw) => {
    const source = typeof raw === 'object' && raw !== null ? raw : {}
    const pick = (...keys) => {
      for (const key of keys) {
        const value = source[key]
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value)
      }
      return undefined
    }
    const pairs = [
      ['prompt_tokens', pick('prompt_token_count', 'promptTokenCount')],
      ['completion_tokens', pick('candidates_token_count', 'candidatesTokenCount')],
      ['total_tokens', pick('total_token_count', 'totalTokenCount')],
      ['reasoning_tokens', pick('thoughts_token_count', 'thoughtsTokenCount')],
    ]
    for (const [key, value] of pairs) {
      // 多帧重复播报且早期帧偏小（缓存未命中时），取最大值
      if (value !== undefined && (usage[key] === undefined || value > usage[key])) usage[key] = value
    }
  }

  const handlePart = function* (part) {
    if (part === null || typeof part !== 'object') return
    if (typeof part.text === 'string' && part.text !== '') {
      sawAny = true
      // thought 标记的 part 是思考内容 → reasoning_content，别污染正文
      yield chunk(part.thought === true ? { reasoning_content: part.text } : { content: part.text })
      return
    }
    const call = part.functionCall ?? part.function_call
    if (call !== null && typeof call === 'object') {
      sawAny = true
      const callId = typeof call.id === 'string' && call.id !== '' ? call.id : `call_${calls.size}`
      const name = typeof call.name === 'string' ? call.name : ''
      if (name === '') return // 无名调用整块丢弃（发出去上游 400）
      const state = calls.get(callId) ?? { name, fragments: [], order: calls.size }
      const args = call.args_json ?? call.argsJson
      if (typeof args === 'string' && args !== '') state.fragments.push(args)
      calls.set(callId, state)
    }
  }

  const handleFrame = function* (frame) {
    if (isErrorFrame(frame)) {
      const code = String(frame.error_code ?? frame.errorCode ?? '')
      const message = String(frame.error_message ?? frame.errorMessage ?? '')
      const detail = [code === '' ? '' : `error_code=${code}`, message].filter((s) => s !== '').join(' ')
      throw new Error(`accio ${code === '402' ? '额度或认证失败' : '上游返回错误帧'}（${detail}）`)
    }
    noteUsage(frame.usage_metadata ?? frame.usageMetadata)
    if (typeof frame.finish_reason === 'string' && frame.finish_reason !== '') finishReason = frame.finish_reason
    if (typeof frame.finishReason === 'string' && frame.finishReason !== '') finishReason = frame.finishReason
    const content = frame.content
    if (content !== null && typeof content === 'object' && Array.isArray(content.parts)) {
      for (const part of content.parts) yield* handlePart(part)
    }
    // 顶层 function_call（无 content 信封）是真实形状，丢了工具调用就凭空消失
    const topCall = frame.function_call ?? frame.functionCall
    if (topCall !== null && typeof topCall === 'object') yield* handlePart({ function_call: topCall })
  }

  const processLine = function* (rawLine) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') return
    let frame
    try {
      frame = JSON.parse(payload)
    } catch {
      return
    }
    yield* handleFrame(frame)
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        buffer += decoder.decode()
        if (buffer !== '') for (const line of buffer.split('\n')) yield* processLine(line)
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) yield* processLine(line)
      if (signal?.aborted === true) break
    }
  } finally {
    await reader.cancel?.().catch(() => {})
    reader.releaseLock?.()
  }

  if (!sawAny) throw new Error('accio：模型没有返回任何内容块')

  // 工具调用统一在结尾一次性发出（OpenAI 侧按 index 拼）
  let index = 0
  for (const [callId, state] of calls) {
    yield chunk({
      tool_calls: [{
        index: index++,
        id: callId,
        type: 'function',
        function: { name: state.name, arguments: mergeToolArgs(state.fragments) },
      }],
    })
  }

  yield chunk({}, finishOf(finishReason))
  if (Object.keys(usage).length > 0) {
    const prompt = usage.prompt_tokens ?? 0
    const completion = usage.completion_tokens ?? 0
    const out = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: usage.total_tokens ?? prompt + completion,
    }
    if (usage.reasoning_tokens !== undefined) out.completion_tokens_details = { reasoning_tokens: usage.reasoning_tokens }
    yield `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: out })}\n\n`
  }
  yield 'data: [DONE]\n\n'
}

// ── 发一次对话 ────────────────────────────────────────────────────────────

const isTransportError = (error) => {
  const code = error?.cause?.code ?? error?.code
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'].includes(code) || error?.name === 'TimeoutError'
}

async function fetchWithRetry(fetchOnce, signal, retries = 2) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchOnce()
    } catch (error) {
      lastError = error
      if (signal?.aborted === true || !isTransportError(error) || attempt === retries) throw error
      await sleep(400 * 2 ** attempt)
    }
  }
  throw lastError
}

function errorDetail(text) {
  try {
    const data = JSON.parse(text)
    const parts = [
      data.error_code !== undefined ? `error_code=${String(data.error_code)}` : undefined,
      typeof data.error_message === 'string' ? data.error_message : undefined,
      data.code !== undefined ? `code=${String(data.code)}` : undefined,
      typeof data.message === 'string' ? data.message : undefined,
    ].filter((value) => value !== undefined)
    if (parts.length > 0) return parts.join(' ')
  } catch { /* 非 JSON：原样返回 */ }
  return String(text)
}

const jsonError = (status, type, message) => Response.json({ error: { type, message } }, { status })

function sseResponse(generator) {
  const encoder = new TextEncoder()
  const iterator = generator[Symbol.asyncIterator]()
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next()
        if (done) controller.close()
        else controller.enqueue(encoder.encode(value))
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel() {
      await iterator.return?.().catch(() => {})
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * 反代一次对话：OpenAI 请求体 → Accio 信封 → OpenAI 响应（流式或聚合）。
 *
 * @param {object} credential `{access_token, refresh_token, expires_at, sgcookie?}`
 * @param {{ body: object, signal?: AbortSignal, renew?: (c: object) => Promise<object> }} options
 */
export async function chat(credential, { body: openaiBody, signal, renew }) {
  const slug = String(openaiBody?.model ?? '')
  const maxRaw = Number(openaiBody?.max_tokens ?? openaiBody?.max_completion_tokens)
  const stop = Array.isArray(openaiBody?.stop)
    ? openaiBody.stop.filter((value) => typeof value === 'string' && value !== '')
    : (typeof openaiBody?.stop === 'string' && openaiBody.stop !== '' ? [openaiBody.stop] : [])

  const { contents, systemInstruction } = serializeMessages(
    Array.isArray(openaiBody?.messages) ? openaiBody.messages : [],
  )

  const requestId = requestIdOf()
  const payload = buildBody({
    model: codeOf(slug),
    accessToken: credential.access_token,
    contents,
    systemInstruction,
    tools: toAccioTools(openaiBody?.tools),
    temperature: typeof openaiBody?.temperature === 'number' ? openaiBody.temperature : undefined,
    maxOutputTokens: Number.isSafeInteger(maxRaw) && maxRaw > 0 ? maxRaw : 8192,
    stop,
    requestId,
  })

  const send = (current) => fetchWithRetry(
    () => fetch(`${GATEWAY}${LLM_PATH}?sg_k=${sgKOf(requestId)}`, {
      method: 'POST',
      headers: requestHeaders(current),
      body: JSON.stringify({ ...payload, token: current.access_token }),
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...net(),
    }),
    signal,
  )

  let response = await send(credential)

  // 403 有两种：凭据被撤销（续期重发是对的）与风控拒绝页（不能续期 ——
  // 续期会轮换 refresh_token，把账号标死、还把其它客户端顶下线）
  const deniedType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
  if (response.status === 403 && deniedType === 'text/html') {
    const peek = await response.text().catch(() => '')
    void response.body?.cancel?.().catch?.(() => {})
    return jsonError(403, 'provider_error',
      'accio：推理请求被网关拒绝（403 + HTML 拒绝页），通常是风控而不是凭据过期；'
      + `因此没有触发续期（续期会轮换 refresh_token）。服务端原文：${peek.slice(0, 200)}`)
  }

  if ((response.status === 401 || response.status === 403) && typeof renew === 'function') {
    let renewed
    try {
      renewed = await renew(credential)
    } catch {
      renewed = undefined
    }
    if (renewed !== undefined && renewed.access_token !== credential.access_token) {
      response = await send(renewed)
    }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return jsonError(response.status >= 400 ? response.status : 502, 'provider_error',
      `Accio 返回 HTTP ${response.status}：${errorDetail(text).slice(0, 300)}`)
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (!contentType.includes('text/event-stream')) {
    // HTTP 200 + HTML = 阿里风控拦截页：不校验就会「模型不回复」，排查方向全错
    const peek = await response.text().catch(() => '')
    return jsonError(502, 'provider_error',
      `accio：上游没有返回事件流（content-type: ${contentType || '(空)'}），通常是被风控拦截。`
      + `服务端原文：${peek.slice(0, 200)}`)
  }

  if (openaiBody?.stream !== false) {
    return sseResponse(accioSseToOpenAi(response.body, { model: slug, signal }))
  }

  // 非流式：上游只有流式端点，这里聚合一份 chat.completion
  let text = ''
  let finish = 'stop'
  let usage
  const toolCalls = []
  for await (const piece of accioSseToOpenAi(response.body, { model: slug, signal })) {
    if (!piece.startsWith('data: ') || piece === 'data: [DONE]\n\n') continue
    const parsed = JSON.parse(piece.slice(6))
    const delta = parsed.choices?.[0]?.delta
    if (typeof delta?.content === 'string') text += delta.content
    if (Array.isArray(delta?.tool_calls)) toolCalls.push(...delta.tool_calls)
    if (parsed.choices?.[0]?.finish_reason) finish = parsed.choices[0].finish_reason
    if (parsed.usage) usage = parsed.usage
  }
  return Response.json({
    id: `chatcmpl-accio-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: slug,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls.map((call, index) => ({ ...call, index })) } : {}),
      },
      finish_reason: finish,
    }],
    ...(usage !== undefined ? { usage } : {}),
  })
}

// ── 账号信息（只用于给账号卡片起个名字）────────────────────────────────

/**
 * 账号身份。⚠️ `userinfo` 必须 **POST**，body 的键是 **`accessToken`**，不是 `token`
 * （传 `token` 回 `{"success":false,"code":"400","message":"accessToken accessToken is null"}`）。
 * 拿不到就返回 undefined —— 名字只是展示，不能因为查不到就阻断登录。
 */
export async function fetchUserInfo(credential) {
  try {
    const response = await fetch(`${GATEWAY}/api/auth/userinfo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ accessToken: credential.access_token }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...net(),
    })
    if (!response.ok) return undefined
    const payload = await response.json()
    if (payload?.success !== true) return undefined
    const data = payload.data
    if (data === null || typeof data !== 'object') return undefined
    const pick = (...keys) => {
      for (const key of keys) {
        const value = data[key]
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
      }
      return undefined
    }
    return {
      name: pick('userName', 'desensitizedEmail', 'accioId'),
      email: pick('desensitizedEmail', 'email'),
      id: data.accioId ?? data.userId ?? undefined,
      region: pick('routeRegion'),
    }
  } catch {
    return undefined
  }
}

// ── 额度 ──────────────────────────────────────────────────────────────────

const CREDIT_BUCKETS = [
  { key: 'daily', label: '每日积分' },
  { key: 'monthly', label: '每月积分' },
  { key: 'referral', label: '推荐积分' },
]

/** 余额端点的 token 在 **query**（`?accessToken=…`），缺它 400。 */
async function entitlementGet(path, credential) {
  const url = `${GATEWAY}${path}?accessToken=${encodeURIComponent(credential.access_token)}`
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...net(),
  })
  const text = await response.text().catch(() => '')
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`accio 余额查询不是 JSON（HTTP ${response.status}）：${text.slice(0, 150)}`)
  }
  // 未登录的实测形态是 HTTP 200 + {success:false, code:'401', message:'NOT_LOGIN'}
  const code = String(payload?.code ?? '')
  if (!response.ok || payload?.success === false) {
    if (code === '401' || /NOT_LOGIN/i.test(String(payload?.message ?? ''))) {
      const error = new Error('未登录或登录已过期（NOT_LOGIN），请重新登录 Accio')
      error.signedOut = true
      throw error
    }
    throw new Error(`accio 余额查询失败（HTTP ${response.status} ${String(payload?.message ?? '')}）`.trim())
  }
  return payload?.data
}

/**
 * 额度 → magpie usage windows（只读，不消耗积分）。
 *
 * ⚠️ 免费账号的 `monthly` 实测是 `{total:0, used:0, remaining:0}` —— 这是
 * 「这个桶没开通」，不是「每月额度用光了」。算成 100% 会在卡片上挂一条假红条。
 */
export async function usage(credential) {
  const data = await entitlementGet(SUBSCRIPTION_PATH, credential)
  const entitlement = typeof data?.entitlement === 'object' && data.entitlement !== null ? data.entitlement : undefined
  if (entitlement === undefined) {
    if (typeof data?.remaining !== 'number') return [{ name: 'Accio', used: 0, display: '响应未包含余额字段' }]
    return [{ name: 'Accio', used: 0, display: `剩余 ${data.remaining}` }]
  }

  let dailyResetIso
  try {
    const quota = await entitlementGet(QUOTA_PATH, credential)
    const seconds = Number(quota?.refreshCountdownSeconds)
    if (Number.isFinite(seconds) && seconds > 0) dailyResetIso = new Date(Date.now() + seconds * 1000).toISOString()
  } catch { /* 倒计时缺席就留空，不编造 */ }

  const windows = []
  for (const bucket of CREDIT_BUCKETS) {
    const value = entitlement[bucket.key]
    if (typeof value !== 'object' || value === null) continue
    const remaining = Number(value.remaining)
    if (!Number.isFinite(remaining)) continue
    const used = Number(value.used)
    const total = Number(value.total)
    const hasTotal = Number.isFinite(total) && total > 0
    if (!hasTotal && remaining <= 0) continue
    const percent = hasTotal
      ? Math.max(0, Math.min(100, Math.round(((Number.isFinite(used) ? used : total - remaining) / total) * 100)))
      : 0
    windows.push({
      name: `Accio · ${bucket.label}`,
      used: percent,
      ...(bucket.key === 'daily' && dailyResetIso !== undefined ? { resetsAt: dailyResetIso } : {}),
      ...(hasTotal && remaining <= 0 ? { aside: true } : {}),
      display: hasTotal ? `剩余 ${remaining} / ${total}` : `剩余 ${remaining}（无套餐额度）`,
    })
  }
  if (windows.length > 0) return windows

  // 一个桶都没解析出来：退回服务端的总额（total/remaining 是三类积分之和）
  const remaining = Number(data?.remaining)
  if (Number.isFinite(remaining)) {
    const total = Number(data?.total)
    const hasTotal = Number.isFinite(total) && total > 0
    const percent = hasTotal ? Math.max(0, Math.min(100, Math.round(((total - remaining) / total) * 100))) : 0
    return [{
      name: 'Accio · 积分',
      used: percent,
      display: hasTotal ? `剩余 ${remaining} / ${total}` : `剩余 ${remaining}`,
    }]
  }
  return [{ name: 'Accio', used: 0, display: '已登录（响应里没有余额字段）' }]
}
