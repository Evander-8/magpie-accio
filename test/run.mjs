// 离线自测：不联网、不碰 magpie，直接把协议层与插件入口跑一遍。
//
// 跑法：`node test/run.mjs`（或 magpie 自带的 bun：`magpie-bun.exe test/run.mjs`）

import assert from 'node:assert/strict'

import {
  buildAuthUrl,
  buildBody,
  catalogToModels,
  chat,
  codeOf,
  expiresAtMs,
  isErrorFrame,
  mergeToolArgs,
  parseCatalog,
  serializeMessages,
  setModelIndex,
  slugOf,
  toCredential,
  toSnake,
  unwrapEnvelope,
  accioSseToOpenAi,
} from '../src/accio.mjs'
import { startRelay } from '../src/relay.mjs'

const realFetch = globalThis.fetch
const tests = []
const test = (name, fn) => tests.push({ name, fn })

// ── 工具 ──────────────────────────────────────────────────────────────────

const sseOf = (frames) => {
  const encoder = new TextEncoder()
  const text = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

const collect = async (generator) => {
  const out = []
  for await (const piece of generator) out.push(piece)
  return out
}

const chunkOf = (line) => {
  if (!line.startsWith('data: ')) return undefined
  const payload = line.slice(6).trim()
  return payload === '[DONE]' ? undefined : JSON.parse(payload)
}

/** 换掉全局 fetch，返回记录器；`restore()` 还原。 */
const stubFetch = (handler) => {
  const calls = []
  globalThis.fetch = async (input, init) => {
    const record = { url: String(input), init }
    calls.push(record)
    return handler(record, calls.length)
  }
  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch
    },
  }
}

// ── 协议层 ────────────────────────────────────────────────────────────────

test('toSnake：递归改键、丢掉 undefined', () => {
  const out = toSnake({ aB: 1, nested: { cD: [{ eF: 2 }] }, gone: undefined })
  assert.deepEqual(out, { a_b: 1, nested: { c_d: [{ e_f: 2 }] } })
})

test('expiresAtMs：秒归一化成毫秒，非法值为 undefined', () => {
  assert.equal(expiresAtMs(1_700_000_000), 1_700_000_000_000)
  assert.equal(expiresAtMs(1_700_000_000_000), 1_700_000_000_000)
  assert.equal(expiresAtMs(0), undefined)
  assert.equal(expiresAtMs('nope'), undefined)
})

test('buildAuthUrl：PKCE 参数齐、没有 code_challenge 会被登录页判为旧客户端', () => {
  const url = new URL(buildAuthUrl({
    region: 'global',
    redirectUri: 'http://127.0.0.1:1234/auth/callback',
    state: 'st',
    codeChallenge: 'chal',
  }))
  assert.equal(url.origin, 'https://www.accio-ai.com')
  assert.equal(url.pathname, '/login')
  assert.equal(url.searchParams.get('return_url'), 'http://127.0.0.1:1234/auth/callback')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('code_challenge'), 'chal')
  assert.equal(url.searchParams.get('client_id'), 'accio-work')
  assert.equal(url.searchParams.get('state'), 'st')
})

test('unwrapEnvelope / toCredential：信封与三件套校验', () => {
  assert.deepEqual(unwrapEnvelope('/x', 200, '{"success":true,"data":{"a":1}}'), { a: 1 })
  assert.throws(() => unwrapEnvelope('/x', 200, '{"success":false,"code":"401","message":"NOT_LOGIN"}'), /NOT_LOGIN/)
  assert.throws(() => unwrapEnvelope('/x', 200, 'not json'), /非 JSON/)

  const credential = toCredential('/x', { accessToken: 'a', refreshToken: 'r', expiresAt: 1_700_000_000 })
  assert.deepEqual(credential, { access_token: 'a', refresh_token: 'r', expires_at: 1_700_000_000_000 })
  assert.throws(() => toCredential('/x', { accessToken: 'a', expiresAt: 1 }), /refreshToken/)
})

test('slugOf：展示名 → 对外 id', () => {
  assert.equal(slugOf('Qwen 3.8 Flash'), 'qwen-3-8-flash')
  assert.equal(slugOf('GLM-5.3'), 'glm-5-3')
  assert.equal(slugOf(''), '')
})

test('parseCatalog：剔除不可见、按倍率升序、缺倍率排最后', () => {
  const models = parseCatalog({
    data: [
      {
        modelList: [
          { modelCode: 'B', modelDisplayName: 'Big', visible: true, effectiveMultiple: 2.8, contextWindow: 1_000_000 },
          { modelCode: 'H', modelDisplayName: 'Hidden', visible: false, effectiveMultiple: 0.01 },
          { modelCode: 'A', modelDisplayName: 'Cheap', visible: true, effectiveMultiple: 0.03, multimodal: true },
          { modelCode: 'N', modelDisplayName: 'NoMultiplier', visible: true },
        ],
      },
    ],
  })
  assert.deepEqual(models.map((m) => m.id), ['A', 'B', 'N'])
  assert.equal(models[0].supportsImage, true)
  assert.equal(models[1].contextWindow, 1_000_000)
})

test('catalogToModels：slug 目录 + modelCode 映射 + capabilities.input.image', () => {
  const models = catalogToModels([
    { id: '1Drift-F8hS3mK7pL2n', name: 'Qwen 3.8 Flash', contextWindow: 1_000_000, supportsImage: true, multiple: 0.03, efforts: ['low', 'high'] },
  ])
  const id = 'qwen-3-8-flash'
  assert.ok(models[id], '目录里应有 slug 键')
  assert.equal(models[id].limit.context, 1_000_000)
  assert.equal(models[id].capabilities.input.image, true)
  assert.deepEqual(Object.keys(models[id].variants), ['low', 'high'])
  assert.equal(codeOf(id), '1Drift-F8hS3mK7pL2n')
  assert.equal(codeOf('1Drift-F8hS3mK7pL2n'), '1Drift-F8hS3mK7pL2n')
  assert.equal(codeOf('unknown-model'), 'unknown-model')
})

test('locked 模型不拉取；可用模型名字带倍率', () => {
  const entries = [
    { modelCode: 'ASTRA', modelDisplayName: 'GPT 6 Astra', visible: true, effectiveMultiple: 3.5, locked: { plan: 'pro' } },
    { modelCode: 'SOL', modelDisplayName: 'GPT 6.2 Sol', visible: true, effectiveMultiple: 2.2, locked: {} },
    { modelCode: 'LUNA', modelDisplayName: 'GPT 5.6 Luna', visible: true, effectiveMultiple: 0.09, locked: null },
    { modelCode: 'HIDDEN', modelDisplayName: 'Hidden', visible: false, effectiveMultiple: 0.01 },
  ]
  const parsed = parseCatalog({ data: [{ modelList: entries }] })
  assert.deepEqual(parsed.map((m) => m.id), ['LUNA'], 'locked（不管是什么形状）与不可见的都不该进目录')

  const models = catalogToModels(parsed)
  assert.equal(models['gpt-5-6-luna'].name, 'GPT 5.6 Luna · x0.09', '可用模型的名字要带倍率')
  assert.equal(models['gpt-6-astra'], undefined)
  assert.equal(models['gpt-6-2-sol'], undefined)
})

test('倍率：没有倍率的条目光名字，不加后缀', () => {
  const models = catalogToModels([{ id: 'X', name: 'Mystery', contextWindow: 1000 }])
  assert.equal(models.mystery.name, 'Mystery')
})

test('serializeMessages：system 合并、工具结果按 name 配对', () => {
  const { contents, systemInstruction } = serializeMessages([
    { role: 'system', content: '你是助手' },
    { role: 'system', content: [{ type: 'text', text: '再补一句' }] },
    { role: 'user', content: '读一下 a.txt' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '文件内容' },
    { role: 'assistant', content: '读完了' },
  ])

  assert.equal(systemInstruction, '你是助手\n\n再补一句')
  assert.deepEqual(contents[0], { role: 'user', parts: [{ text: '读一下 a.txt' }] })
  assert.deepEqual(contents[1], {
    role: 'model',
    parts: [{ functionCall: { id: 'call_1', name: 'read_file', argsJson: '{"path":"a.txt"}' } }],
  })
  assert.deepEqual(contents[2], {
    role: 'user',
    parts: [{ functionResponse: { id: 'call_1', name: 'read_file', responseJson: '文件内容' } }],
  })
  assert.deepEqual(contents[3], { role: 'model', parts: [{ text: '读完了' }] })
})

test('serializeMessages：工具结果里的图片挪到 functionResponse 之后', () => {
  const png = 'data:image/png;base64,AAAA'
  const { contents } = serializeMessages([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shot', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: '截图好了' }, { type: 'image_url', image_url: { url: png } }] },
  ])
  assert.equal(contents.length, 3)
  assert.ok(contents[1].parts[0].functionResponse, 'functionResponse 必须紧邻')
  assert.equal(contents[2].role, 'user')
  assert.deepEqual(contents[2].parts[1], { inlineData: { mimeType: 'image/png', data: 'AAAA' } })
})

test('buildBody：token 在 body、system_instruction 是字符串、工具的 schema 不下钻', () => {
  setModelIndex([{ id: 'CODE', name: 'Cheap' }])
  const body = buildBody({
    model: 'CODE',
    accessToken: 'tok',
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    systemInstruction: 'sys',
    tools: [{ name: 'f', description: '', parametersJson: JSON.stringify({ type: 'object', properties: { filePath: { type: 'string' } } }) }],
    temperature: 0.3,
    maxOutputTokens: 100,
    requestId: 'req-1',
  })

  assert.equal(body.token, 'tok')
  assert.equal(body.model, 'CODE')
  assert.equal(body.system_instruction, 'sys')
  assert.equal(typeof body.system_instruction, 'string')
  assert.equal(typeof body.tools[0].parameters_json, 'string')
  assert.match(body.tools[0].parameters_json, /filePath/, 'schema 里的参数名不能被 snake 化')
  assert.equal(body.max_output_tokens, 100)
  assert.equal(body.message_id.length, 32)
  assert.deepEqual(body.properties, {
    utdid: body.properties.utdid,
    version: '0.34.4',
    appKey: 'OneChat',
    normalized_response: 'true',
  })
})

test('mergeToolArgs：累计式与增量式都要拼对', () => {
  // 上游真实形态：首帧空、后续帧重复整份参数（互为前缀）
  assert.equal(mergeToolArgs(['', '{"a":1}', '{"a":1}']), '{"a":1}')
  assert.equal(mergeToolArgs(['{"a":1', '{"a":1,"b":2}']), '{"a":1,"b":2}')
  // 也有真增量：后帧接在前帧尾巴上
  assert.equal(mergeToolArgs(['{"pa', 'th":"a.txt"}']), '{"path":"a.txt"}')
  assert.equal(mergeToolArgs([]), '')
})

test('isErrorFrame：200 是成功哨兵', () => {
  assert.equal(isErrorFrame({ error_code: '402', error_message: 'unauthorized' }), true)
  assert.equal(isErrorFrame({ error_code: '200' }), false)
  assert.equal(isErrorFrame({ content: {} }), false)
})

test('accioSseToOpenAi：正文/思维链/工具调用/用量', async () => {
  const frames = [
    { content: { parts: [{ text: '先想一下', thought: true }] } },
    { content: { parts: [{ text: '你好' }] } },
    { function_call: { id: 'call_9', name: 'read_file', args_json: '{"pa' } },
    { function_call: { id: 'call_9', name: 'read_file', args_json: 'th":"a.txt"}' } },
    { usage_metadata: { prompt_token_count: 10, candidates_token_count: 5, total_token_count: 15, thoughts_token_count: 3 }, finish_reason: 'STOP' },
  ]
  const chunks = (await collect(accioSseToOpenAi(sseOf(frames), { model: 'qwen-3-8-flash' })))
    .map(chunkOf)
    .filter(Boolean)

  const deltas = chunks.map((chunk) => chunk.choices?.[0]?.delta).filter(Boolean)
  assert.deepEqual(deltas[0], { reasoning_content: '先想一下' })
  assert.deepEqual(deltas[1], { content: '你好' })

  const toolCall = deltas.find((delta) => Array.isArray(delta.tool_calls))?.tool_calls[0]
  assert.equal(toolCall.id, 'call_9')
  assert.equal(toolCall.function.name, 'read_file')
  assert.equal(toolCall.function.arguments, '{"path":"a.txt"}')

  const finish = chunks.find((chunk) => chunk.choices?.[0]?.finish_reason)
  assert.equal(finish.choices[0].finish_reason, 'stop')

  const usage = chunks.find((chunk) => chunk.usage)?.usage
  assert.equal(usage.prompt_tokens, 10)
  assert.equal(usage.completion_tokens, 5)
  assert.deepEqual(usage.completion_tokens_details, { reasoning_tokens: 3 })
})

test('accioSseToOpenAi：空流报错，不假装回复', async () => {
  await assert.rejects(collect(accioSseToOpenAi(sseOf([]), { model: 'm' })), /没有返回任何内容块/)
})

// ── 反代一次对话 ──────────────────────────────────────────────────────────

const credential = { access_token: 'tok-1', refresh_token: 'ref-1', expires_at: Date.now() + 3_600_000, region: 'cn' }

test('chat：请求形状正确（sg_k / token 在 body / 信封）', async () => {
  setModelIndex([{ id: '1Drift-F8hS3mK7pL2n', name: 'Qwen 3.8 Flash' }])
  const stub = stubFetch(() => new Response(sseOf([
    { content: { parts: [{ text: '好的' }] } },
    { finish_reason: 'STOP' },
  ]), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  try {
    const response = await chat(credential, {
      body: {
        model: 'qwen-3-8-flash',
        stream: true,
        messages: [{ role: 'user', content: '你好' }],
        max_tokens: 256,
      },
    })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.match(text, /"content":"好的"/)
    assert.match(text, /data: \[DONE\]/)

    const sent = JSON.parse(stub.calls[0].init.body)
    const url = new URL(stub.calls[0].url)
    assert.equal(url.pathname, '/api/adk/llm/generateContent')
    assert.match(url.searchParams.get('sg_k') ?? '', /^[0-9a-f]{32}$/)
    assert.equal(sent.token, 'tok-1')
    assert.equal(sent.model, '1Drift-F8hS3mK7pL2n', '上行必须是 modelCode')
    assert.equal(sent.max_output_tokens, 256)
    assert.equal(sent.contents[0].parts[0].text, '你好')
    assert.equal(stub.calls[0].init.headers.appKey, 'OneChat')
    assert.equal(stub.calls[0].init.headers.Authorization, undefined, 'token 不放 Authorization')
  } finally {
    stub.restore()
  }
})

test('chat：HTTP 200 + HTML 当风控拦截，不当作回复', async () => {
  const stub = stubFetch(() => new Response('<html>punish</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
  try {
    const response = await chat(credential, { body: { model: 'm', messages: [{ role: 'user', content: 'x' }] } })
    assert.equal(response.status, 502)
    const payload = await response.json()
    assert.match(payload.error.message, /风控/)
  } finally {
    stub.restore()
  }
})

test('chat：401 硬续期一次并换掉 body.token', async () => {
  setModelIndex([{ id: 'CODE1', name: 'Any' }])
  let attempt = 0
  const stub = stubFetch(() => {
    attempt += 1
    if (attempt === 1) return new Response('unauthorized', { status: 401 })
    return new Response(sseOf([{ content: { parts: [{ text: '续期后成功' }] } }]), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  })
  try {
    const response = await chat(credential, {
      body: { model: 'ANY', stream: true, messages: [{ role: 'user', content: 'x' }] },
      renew: async () => ({ ...credential, access_token: 'tok-2' }),
    })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /续期后成功/)
    assert.equal(JSON.parse(stub.calls[1].init.body).token, 'tok-2')
  } finally {
    stub.restore()
  }
})

test('chat：非流式聚合成 chat.completion', async () => {
  setModelIndex([{ id: 'CODE2', name: 'Any' }])
  const stub = stubFetch(() => new Response(sseOf([
    { content: { parts: [{ text: '甲' }] } },
    { content: { parts: [{ text: '乙' }] } },
    { usage_metadata: { prompt_token_count: 3, candidates_token_count: 2, total_token_count: 5 }, finish_reason: 'MAX_TOKENS' },
  ]), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  try {
    const response = await chat(credential, {
      body: { model: 'ANY2', stream: false, messages: [{ role: 'user', content: 'x' }] },
    })
    const payload = await response.json()
    assert.equal(payload.object, 'chat.completion')
    assert.equal(payload.choices[0].message.content, '甲乙')
    assert.equal(payload.choices[0].finish_reason, 'length')
    assert.equal(payload.usage.total_tokens, 5)
  } finally {
    stub.restore()
  }
})

// ── 本地反代服务 ──────────────────────────────────────────────────────────

test('relay：/v1/models 与 /v1/chat/completions 可用，且只服务回环', async () => {
  const stub = stubFetch(() => new Response(sseOf([{ content: { parts: [{ text: '来自反代' }] } }]), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  }))
  const relay = await startRelay({
    port: 0,
    token: '',
    getCredential: async () => credential,
    getModels: async () => ({ 'qwen-3-8-flash': { name: 'Qwen 3.8 Flash', limit: { context: 1_000_000 } } }),
  })
  try {
    const models = await realFetch(`http://127.0.0.1:${relay.port}/v1/models`).then((r) => r.json())
    assert.equal(models.object, 'list')
    assert.equal(models.data[0].id, 'qwen-3-8-flash')

    const response = await realFetch(`http://127.0.0.1:${relay.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-3-8-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /来自反代/)
  } finally {
    stub.restore()
    await relay.close()
  }
})

test('relay：配置 token 后没带 token 就 401', async () => {
  const relay = await startRelay({
    port: 0,
    token: 'secret',
    getCredential: async () => credential,
    getModels: async () => ({}),
  })
  try {
    const denied = await realFetch(`http://127.0.0.1:${relay.port}/v1/models`)
    assert.equal(denied.status, 401)
    const allowed = await realFetch(`http://127.0.0.1:${relay.port}/v1/models`, {
      headers: { authorization: 'Bearer secret' },
    })
    assert.equal(allowed.status, 200)
  } finally {
    await relay.close()
  }
})

// ── 插件入口（宿主契约）────────────────────────────────────────────────────

const fakeInput = () => {
  const saved = []
  const logs = []
  return {
    saved,
    logs,
    input: {
      client: {
        auth: {
          get: async () => undefined,
          set: async (payload) => {
            saved.push(payload)
          },
        },
        tui: { showToast: () => {} },
        app: { log: (entry) => logs.push(entry) },
      },
    },
  }
}

test('plugin：注册供应商、单个登录入口、目录兜底', async () => {
  const { default: AccioPlugin } = await import('../index.mjs')
  const { input } = fakeInput()
  const plugin = await AccioPlugin(input, {})

  assert.equal(plugin.auth.provider, 'accio')
  assert.equal(plugin.provider.id, 'accio')
  assert.equal(plugin.auth.methods.length, 1, '只做中国版：只有一个登录入口')
  assert.equal(plugin.auth.methods[0].type, 'oauth')
  assert.match(plugin.auth.methods[0].label, /Accio/)

  const cfg = {}
  await plugin.config(cfg)
  assert.equal(cfg.provider.accio.npm, '@ai-sdk/openai-compatible')

  await plugin.config(cfg)
  assert.equal(cfg.provider.accio.namespace, undefined, 'config 只补缺，不覆盖')

  // 没有登录态：目录用兜底表，别让模型选择器空着
  const models = await plugin.provider.models({}, {})
  assert.ok(Object.keys(models).length >= 15)
  assert.ok(models['deepseek-v4-pro'])

  // 没登录就发请求：明确的 401，而不是崩掉
  const loader = await plugin.auth.loader(async () => undefined)
  const denied = await loader.fetch('https://accio.invalid/v1/chat/completions', {
    body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(denied.status, 401)
  assert.match((await denied.json()).error.message, /还没登录/)

  // 额度卡：未登录也不报成「查询失败」
  const usage = await plugin.auth.usage(async () => undefined)
  assert.equal(usage.windows[0].display, '未登录')
})

test('plugin：authorize 立刻返回 {url, method, callback}，窗口交给默认浏览器（不带 opened）', async () => {
  const { default: AccioPlugin } = await import('../index.mjs')
  const { input } = fakeInput()
  // 假 openBrowser：不去真开浏览器，只验证契约
  const opened = []
  const plugin = await AccioPlugin(input, { openBrowser: (url) => opened.push(url) })

  const startedAt = Date.now()
  const flow = await plugin.auth.methods[0].authorize()
  assert.ok(Date.now() - startedAt < 2000, 'authorize 必须马上返回')
  assert.equal(flow.method, 'auto')
  assert.equal(typeof flow.callback, 'function')
  assert.equal(flow.opened, undefined, '插件不再自己开窗口：不该带 opened:true')
  assert.deepEqual(opened, [flow.url], '只在宿主的 openBrowser 可用时才由它打开')
  const url = new URL(flow.url)
  assert.equal(url.origin, 'https://www.accio-ai.com')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.match(url.searchParams.get('return_url') ?? '', /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
})

test('icon：随包 PNG 变成 data URI，宿主收得下', async () => {
  const { iconDataUri, iconAcceptedByHost } = await import('../src/icon.mjs')
  const uri = iconDataUri()
  assert.ok(uri.startsWith('data:image/png;base64,'), '必须是 PNG data URI')
  assert.ok(iconAcceptedByHost(uri), '宿主的 iconOf 只认 https:// 与 data:image/')

  const bytes = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64')
  assert.deepEqual([...bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG 魔数')

  // 反例：本地路径宿主不收；外链 favicon 虽然符合规则，但 Accio 那个地址
  // 返回的是 text/html（30KB 的 SPA 页面），渲染不出图 —— 所以不再用它
  assert.equal(iconAcceptedByHost('icons/accio-128.png'), false)
  assert.equal(iconAcceptedByHost('https://www.accio-ai.com/favicon.ico'), true)
})

test('plugin：auth.icon 是随包 data URI，不是外链', async () => {
  const { default: AccioPlugin } = await import('../index.mjs')
  const { input } = fakeInput()
  const plugin = await AccioPlugin(input, {})
  assert.match(plugin.auth.icon, /^data:image\/png;base64,/)
})

test('plugin：用宿主给的 auth 反代（带 refresh 前先续期）', async () => {
  const { default: AccioPlugin } = await import('../index.mjs')
  const { input, saved } = fakeInput()
  const plugin = await AccioPlugin(input, {})

  const stub = stubFetch(() => new Response(sseOf([{ content: { parts: [{ text: '反代成功' }] } }]), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  }))
  try {
    const expired = {
      type: 'oauth',
      access: 'old',
      refresh: 'ref',
      expires: 1_700_000_000_000, // 早已过期（离到期还有负的时间）
      region: 'cn',
      accountId: 'A',
    }
    // 续期端点也走被 stub 的 fetch：先返回一份新凭据
    const loader = await plugin.auth.loader(async () => expired)
    assert.equal(typeof loader.fetch, 'function')

    const response = await loader.fetch('https://accio.invalid/v1/chat/completions', {
      body: JSON.stringify({ model: 'deepseek-v4-pro', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    // 第一次 fetch 是续期（被 stub 成 SSE，不是 JSON 信封 → 续期失败 → 沿用旧凭据 → 再发一次也成功）
    assert.equal(response.status, 200)
    assert.match(await response.text(), /反代成功/)
    assert.ok(saved.length === 0, '反代过程不该写账号槽')
  } finally {
    stub.restore()
  }
})

// ── 登录态形状 / 额度（对着线上真实响应写死）─────────────────────────────

/** magpie 宿主 keptAs() 的等价物（host.js 原文）。 */
const hostKeptAs = (r) => {
  if (!r || typeof r !== 'object') return null
  if ('refresh' in r || 'key' in r) return r
  if (typeof r.access === 'string' && r.access) return { ...r, refresh: '' }
  return null
}

test('sessionOf / storedOf：宿主的两道门都得过', async () => {
  const { __sessionOf, __storedOf, __credentialOf } = await import('../index.mjs')
  const credential = { access_token: 'acc', refresh_token: 'ref', expires_at: 1_797_773_678_000, region: 'global', sgcookie: 'sg' }

  // 第一道门：signingIn() 里 `if (!r || r.type !== 'success') return failed(r)`
  const session = __sessionOf(credential, 'A')
  assert.equal(session.type, 'success', 'callback 返回值必须是 type:success')
  // 第二道门：keptAs() 只认 refresh/key/access
  assert.ok(hostKeptAs(session), 'callback 的返回值必须被 keptAs 收下')

  const { type, refresh, access, expires, ...extra } = session
  assert.equal(access, 'acc')
  assert.equal(refresh, 'ref')
  assert.equal(expires, 1_797_773_678_000)
  assert.equal(extra.sgcookie, 'sg')
  assert.equal(extra.accountId, 'A')

  // 自己写槽时必须是 oauth（magpie 的 renewAt() 只认这个）
  const stored = __storedOf(credential, 'A')
  assert.equal(stored.type, 'oauth')
  assert.equal(stored.access, 'acc')
  assert.equal(stored.refresh, 'ref')

  // 旧槽（snake_case）也要能读回来
  assert.deepEqual(__credentialOf({ type: 'success', access_token: 'a', refresh_token: 'r', expires_at: 1_700_000_000_000, region: 'cn' }), {
    access_token: 'a', refresh_token: 'r', expires_at: 1_700_000_000_000,
  })
  // 新槽（magpie 存的 oauth）同样能读
  assert.deepEqual(__credentialOf({ type: 'oauth', access: 'a2', refresh: 'r2', expires: 1_700_000_000_000, region: 'global' }), {
    access_token: 'a2', refresh_token: 'r2', expires_at: 1_700_000_000_000,
  })
})

test('出口代理：显式设置后每个请求都带 init.proxy', async () => {
  const { setProxy, proxyOf } = await import('../src/accio.mjs')
  setProxy('http://127.0.0.1:7890')
  assert.equal(proxyOf(), 'http://127.0.0.1:7890')

  const stub = stubFetch(() => new Response(sseOf([{ content: { parts: [{ text: 'ok' }] } }]), {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  }))
  try {
    await chat(
      { access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3_600_000, region: 'global' },
      { body: { model: 'm', messages: [{ role: 'user', content: 'x' }] } },
    )
    assert.equal(stub.calls[0].init.proxy, 'http://127.0.0.1:7890')
  } finally {
    stub.restore()
    setProxy('')
  }
})

test('选项 proxy 为空串时不能挡住宿主的 HTTPS_PROXY', async () => {
  const { default: AccioPlugin } = await import('../index.mjs')
  const { proxyOf, setProxy } = await import('../src/accio.mjs')
  const backup = { ...process.env }
  try {
    setProxy('')
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
    delete process.env.ALL_PROXY
    delete process.env.HTTP_PROXY
    const { input } = fakeInput()
    await AccioPlugin(input, { proxy: '' })
    assert.equal(proxyOf(), 'http://127.0.0.1:7890', 'host 选项默认空串，应回落到宿主代理')

    setProxy('')
    await AccioPlugin(input, { proxy: 'http://127.0.0.1:9999' })
    assert.equal(proxyOf(), 'http://127.0.0.1:9999', '显式写了就用它')
  } finally {
    process.env = backup
    setProxy('')
  }
})

test('usage：免费账号的 monthly{total:0} 不能算成「已用 100%」', async () => {
  const { usage } = await import('../src/accio.mjs')
  // 下面两份响应是 2026-11-20 真机抓的原文（FREE 套餐）
  const subscription = {
    success: true, code: '200', message: '0',
    data: {
      hasQuotaPlan: false, total: 520, remaining: 519, type: 'FREE',
      entitlement: {
        monthly: { plan: 'monthly', total: 0, used: 0, remaining: 0, nextBillingDate: '2026-12-20 05:04:36' },
        referral: { plan: 'referral', total: 500, used: 0, remaining: 500 },
        daily: { plan: 'daily', total: 20, used: 1, remaining: 19 },
      },
    },
  }
  const quota = { success: true, code: '200', message: '0', data: { usagePercent: 0, refreshCountdownSeconds: 86_400 } }

  const stub = stubFetch((record) => {
    const body = record.url.includes('/currentSubscription') ? subscription : quota
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  try {
    const windows = await usage({ access_token: 'tok' })
    assert.deepEqual(windows.map((w) => w.name), ['Accio · 每日积分', 'Accio · 推荐积分'], '未开通的「每月积分」不该出现')
    assert.equal(windows[0].used, 5)
    assert.equal(windows[0].display, '剩余 19 / 20')
    assert.ok(windows[0].resetsAt, '每日额度刷新时刻要带上')
    assert.equal(windows[1].display, '剩余 500 / 500')
  } finally {
    stub.restore()
  }
})

test('usage：只剩总余额时退回一行总额', async () => {
  const { usage } = await import('../src/accio.mjs')
  const stub = stubFetch(() => new Response(JSON.stringify({
    success: true, data: { total: 520, remaining: 390, entitlement: {} },
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  try {
    const windows = await usage({ access_token: 'tok' })
    assert.equal(windows.length, 1)
    assert.equal(windows[0].display, '剩余 390 / 520')
    assert.equal(windows[0].used, 25)
  } finally {
    stub.restore()
  }
})

test('fetchUserInfo：body 键是 accessToken（token 会回 400）', async () => {
  const { fetchUserInfo } = await import('../src/accio.mjs')
  const stub = stubFetch(() => new Response(JSON.stringify({
    success: true,
    data: { userId: '1', accioId: '4500122570229', userName: 'A', email: null, desensitizedEmail: 'z***6@gmail.com', routeRegion: 'CN' },
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  try {
    const info = await fetchUserInfo({ access_token: 'tok' })
    assert.equal(JSON.parse(stub.calls[0].init.body).accessToken, 'tok')
    assert.equal(info.name, 'A')
    assert.equal(info.region, 'CN')
  } finally {
    stub.restore()
  }
})

test('plugin.auth.refresh：返回的字段里必须有 refresh（宿主只续 oauth 槽）', async () => {
  const { default: AccioPlugin } = await import('../index.mjs')
  const { input } = fakeInput()
  const plugin = await AccioPlugin(input, {})

  const stub = stubFetch(() => new Response(JSON.stringify({
    success: true,
    data: { accessToken: 'acc2', refreshToken: 'ref2', expiresAt: 1_800_000_000, sgcookie: 'sg2' },
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  try {
    const next = await plugin.auth.refresh({
      type: 'oauth', access: 'acc1', refresh: 'ref1', expires: 1_700_000_000_000, region: 'cn', accountId: 'A',
    })
    assert.ok(hostKeptAs(next), '续期结果也必须能被 keptAs 收下')
    assert.equal(next.access, 'acc2')
    assert.equal(next.refresh, 'ref2')
    assert.equal(next.expires, 1_800_000_000_000)
    assert.equal(next.accountId, 'A')
  } finally {
    stub.restore()
  }
})

test('plugin：旧槽在 loader 里被升级成 oauth（否则 magpie 永不续期）', async () => {
  const { default: AccioPlugin } = await import('../index.mjs')
  const { input, saved } = fakeInput()
  const plugin = await AccioPlugin(input, {})
  const legacy = {
    type: 'success',
    channel: 'accio',
    access_token: 'old-acc',
    refresh_token: 'old-ref',
    expires_at: Date.now() + 3_600_000,
    expires: Date.now() + 3_600_000,
    region: 'global',
    accountId: 'A',
  }
  await plugin.auth.loader(async () => legacy)
  // 迁移是异步挂上去的，等一个微任务循环
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(saved.length, 1)
  assert.equal(saved[0].body.type, 'oauth')
  assert.equal(saved[0].body.access, 'old-acc')
  assert.equal(saved[0].body.refresh, 'old-ref')
})

// ── 跑 ────────────────────────────────────────────────────────────────────

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}`)
    console.log(`     ${error?.message ?? error}`)
    if (error?.stack) console.log(error.stack.split('\n').slice(1, 4).join('\n'))
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`)
process.exit(failed === 0 ? 0 : 1)
