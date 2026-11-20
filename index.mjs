// magpie 插件入口：把 Accio（阿里 Accio Work）当成 magpie 的一条供应商。
//
// 形状是 OpenCode v1 插件（magpie 的插件宿主就是 OpenCode 插件运行时）：
//
//   magpie 网关 → provider.loader().fetch（OpenAI 线格式）
//              → src/accio.mjs 协议层（Gemini 信封 + 私有 SSE）
//              → https://phoenix-gw.alibaba.com
//
// 登录：**不需要 Accio 桌面客户端**。点 magpie 里的「登录」，插件起一个只有回环
// 能连的本地回调服务、给宿主一个授权页地址；用户在网页上登录后授权码回来换
// access/refresh token，之后所有请求都带着它走。
//
// 反向代理（可选）：options.relay.port 有值时，插件还会在 127.0.0.1 上开一个
// OpenAI 兼容端点（/v1/models、/v1/chat/completions），任何客户端都能直接指过来。

import {
  GATEWAY,
  beginLogin,
  buildAuthUrl,
  catalogToModels,
  chat,
  expiresAtMs,
  fetchCatalog,
  fetchUserInfo,
  isExpired,
  isTerminalRefreshError,
  proxyOf,
  refreshCredential,
  setProxy,
  usage as usageOf,
} from './src/accio.mjs'
import { iconDataUri } from './src/icon.mjs'
import { startRelay } from './src/relay.mjs'

export const PROVIDER_ID = 'accio'
const PROVIDER_NAME = 'Accio（阿里）'
const CONFIG_HINT = '在 magpie 的供应商编辑器里点「登录」，用网页登录 Accio 账号即可；本插件不需要 Accio 桌面客户端。'

/** 进程内状态：当前凭据、最近一次目录、反代服务。 */
const state = {
  credential: undefined,
  models: {},
  relay: undefined,
  relayStarted: false,
}

/** 账号级单飞续期：refresh_token 一次性，并发续期会把账号标死。 */
const renewing = new Map()

const safe = (fn, fallback) => {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/**
 * 宿主存的登录态 → 本插件用的凭据。
 *
 * 两种形状都要认：
 *   · `type:'oauth', access, refresh, expires`（OpenCode 口径，magpie 自己存的）；
 *   · `access_token / refresh_token / expires_at`（0.1.0 早期直接 set 进去的旧槽）。
 */
const credentialOf = (auth) => {
  if (auth === null || typeof auth !== 'object') return undefined
  const access = typeof auth.access === 'string' && auth.access !== ''
    ? auth.access
    : (typeof auth.access_token === 'string' ? auth.access_token : '')
  if (access === '') return undefined
  const refresh = typeof auth.refresh === 'string' && auth.refresh !== ''
    ? auth.refresh
    : (typeof auth.refresh_token === 'string' ? auth.refresh_token : '')
  return {
    access_token: access,
    refresh_token: refresh,
    expires_at: expiresAtMs(auth.expires ?? auth.expires_at),
    ...(typeof auth.sgcookie === 'string' && auth.sgcookie !== '' ? { sgcookie: auth.sgcookie } : {}),
  }
}

/**
 * 本插件要交出的两份登录态，形状**不同**，别混：
 *
 * 1. `callback()` 的返回值 —— 宿主的门槛是
 *    `if (!r || r.type !== "success") return failed(r)`，所以必须是 `type:'success'`，
 *    同时又得带 `refresh`（或非空 `access`）让 `keptAs()` 肯收。交 `{type:'oauth'}`
 *    只会得到一句没有任何细节的「the sign-in failed」。
 * 2. 自己调 `client.auth.set` 写槽时 —— 槽要的是 `type:'oauth'`，否则 magpie 的
 *    `renewAt()` 不认（它只看 `stored.type === 'oauth'`），token 到点也不会续。
 *
 * 宿主 `save()` 会把 success 那份重排成 `{type:'oauth', refresh, access, expires, …extra}` 再落盘。
 */
const oauthFields = (credential, accountId) => ({
  access: credential.access_token,
  refresh: credential.refresh_token,
  expires: credential.expires_at,
  ...(typeof credential.sgcookie === 'string' && credential.sgcookie !== '' ? { sgcookie: credential.sgcookie } : {}),
  ...(typeof accountId === 'string' && accountId !== '' ? { accountId } : {}),
})

/** 交给宿主 sign-in 流程的返回值。 */
const sessionOf = (credential, accountId) => ({ type: 'success', ...oauthFields(credential, accountId) })

/** 自己写进账号槽的存储形状。 */
const storedOf = (credential, accountId) => ({ type: 'oauth', ...oauthFields(credential, accountId) })

export default async function AccioPlugin(input, options = {}) {
  const options_ = options ?? {}

  const log = (message, extra) => {
    safe(() => void input?.client?.app?.log?.({
      level: 'info',
      message: `magpie-accio: ${message}`,
      ...(extra === undefined ? {} : { extra }),
    }))
  }
  const toast = (message, variant = 'info') => {
    safe(() => void input?.client?.tui?.showToast?.({ body: { message, variant } }))
    log(message)
  }

  const authGet = input?.client?.auth?.get
  const authSet = input?.client?.auth?.set

  /**
   * 出口代理。magpie 启动插件宿主时已经把系统代理写进
   * `HTTPS_PROXY/HTTP_PROXY/ALL_PROXY`（实测 Bun 的 fetch 会照它走），所以默认不用配置；
   * 想单独指定就用插件选项 `proxy`。
   */
  const envProxy = options_.proxy
    ?? process.env.HTTPS_PROXY ?? process.env.https_proxy
    ?? process.env.HTTP_PROXY ?? process.env.http_proxy
    ?? process.env.ALL_PROXY ?? process.env.all_proxy
    ?? ''
  if (typeof envProxy === 'string' && envProxy.trim() !== '') setProxy(envProxy.trim())
  log(`出口代理：${proxyOf() === '' ? '（无，直连）' : proxyOf()}`)

  const readAuth = async () => {
    try {
      return typeof authGet === 'function' ? await authGet() : undefined
    } catch {
      return undefined
    }
  }

  const safeGet = async (fn) => {
    try {
      return typeof fn === 'function' ? await fn() : undefined
    } catch {
      return undefined
    }
  }

  const saveAuth = async (auth) => {
    try {
      await authSet?.({ path: { id: PROVIDER_ID }, body: auth })
    } catch (error) {
      log(`保存登录态失败：${error?.message ?? error}`)
    }
  }

  /** 续期（单飞）：同一 refresh_token 的并发调用共享一个 Promise。 */
  const renew = (credential) => {
    const key = credential?.refresh_token ?? ''
    const inflight = renewing.get(key)
    if (inflight !== undefined) return inflight
    const task = (async () => {
      try {
        const next = await refreshCredential(credential)
        state.credential = next
        return next
      } finally {
        renewing.delete(key)
      }
    })()
    renewing.set(key, task)
    void task.catch(() => {})
    return task
  }

  /** 拿到一份可用凭据：优先宿主给的 auth，其次内存缓存；临期就续。 */
  const ensure = async (auth) => {
    const base = credentialOf(auth) ?? state.credential
    if (base === undefined) throw new Error(`还没登录 Accio。${CONFIG_HINT}`)
    if (!isExpired(base)) {
      state.credential = base
      return base
    }
    if (base.refresh_token === '') throw new Error('登录态已过期且没有 refresh_token，请重新登录 Accio')
    try {
      const next = await renew(base)
      log('access token 已续期')
      return next
    } catch (error) {
      if (isTerminalRefreshError(error)) throw new Error(`Accio 登录已失效，请重新登录：${error.message}`)
      // 网络抖动之类：用旧凭据试一次，真不行上游会回 401，再由 chat 的硬续期收尾
      log(`续期失败，沿用旧凭据：${error?.message ?? error}`)
      return base
    }
  }

  /** 账号卡片上显示的名字（本插件只做中国版，直接用账号自己的名字）。 */
  const accountNameOf = async (credential) => {
    const info = await fetchUserInfo(credential)
    const label = info?.name ?? info?.email
    return label === undefined ? 'Accio' : label
  }

  /**
   * 一次登录的结果 → 交给宿主。只由 callback() 返回，**不自己再写一遍**：
   * 宿主拿到 callback 的返回值会走 save() 落盘（并规范成 oauth 形状）。
   */
  const persist = async (credential) => {
    state.credential = credential
    return sessionOf(credential, await accountNameOf(credential))
  }

  /**
   * 一次登录会话：起回调服务 → 打开授权页 → 等授权码 → 换 token。
   *
   * 窗口交给**宿主用系统默认浏览器**打开（插件不自己起浏览器）：插件只管回调服务，
   * `authorize()` 回来的 `url` 宿主会开。若宿主额外给了 `openBrowser`，就交给它。
   */
  const startLogin = async () => {
    const started = await beginLogin(
      typeof options_.openBrowser === 'function' ? options_.openBrowser : undefined,
    )
    log(`登录会话已就绪：回调 127.0.0.1:${started.port}，授权页交给默认浏览器打开`)
    void started.result.then(async (credential) => {
      const session = await persist(credential)
      toast(`Accio 登录成功（${session.accountId ?? '已保存'}）`)
    }).catch((error) => {
      toast(`Accio 登录失败：${error?.message ?? error}`, 'error')
    })
    return started
  }

  const loginMethod = (label) => ({
    type: 'oauth',
    label,
    async authorize() {
      const started = await startLogin()
      return {
        url: started.url,
        method: 'auto',
        instructions: started.instructions,
        async callback() {
          return persist(await started.result)
        },
      }
    },
  })

  /** 目录：远端优先，失败用内存里的上一份，再失败用兜底表。 */
  const loadModels = async (auth) => {
    let credential
    try {
      credential = await ensure(auth)
    } catch {
      return catalogToModels([]) // 未登录：给兜底表，别让选择器空着
    }
    try {
      const models = catalogToModels(await fetchCatalog(credential))
      state.models = models
      const names = Object.keys(models)
      const top = names.slice(0, 4).join('、')
      // 名字里已带倍率（`qwen-3-8-flash · x0.03`），日志里给个概览
      log(`目录：${names.length} 个可用模型（${top}${names.length > 4 ? '…' : ''}）`)
      return models
    } catch (error) {
      log(`目录拉取失败，用兜底：${error?.message ?? error}`)
      if (Object.keys(state.models).length > 0) return state.models
      return catalogToModels([])
    }
  }

  /**
   * 旧登录槽升级：0.1.0 早期把 `{type:'success', access_token,…}` 直接 set 进宿主，
   * 而 magpie 只在 `type === 'oauth'` 时才替账号续期。这里顺手写成规范形状，
   * 用户不必重新登录。
   */
  const migrateLegacy = async (auth) => {
    if (auth === null || typeof auth !== 'object' || auth.type === 'oauth') return
    const credential = credentialOf(auth)
    if (credential === undefined) return
    const accountId = typeof auth.accountId === 'string' && auth.accountId !== '' ? auth.accountId : undefined
    await saveAuth(storedOf(credential, accountId))
    log('旧登录槽已升级成 oauth 形状')
  }

  // 反代服务（可选）：options.relay = { port, host?, token? }
  const relayConfig = options_.relay ?? {}
  const relayPort = Number(relayConfig.port)
  if (state.relayStarted === false && Number.isFinite(relayPort) && relayPort > 0) {
    state.relayStarted = true
    try {
      state.relay = await startRelay({
        port: relayPort,
        host: typeof relayConfig.host === 'string' && relayConfig.host !== '' ? relayConfig.host : '127.0.0.1',
        token: typeof relayConfig.token === 'string' ? relayConfig.token : '',
        log,
        getCredential: async () => ensure(await readAuth()),
        getModels: async () => {
          if (Object.keys(state.models).length > 0) return state.models
          return loadModels(await readAuth())
        },
        renew,
      })
      log(`反代已启动：http://${state.relay.host}:${state.relay.port}/v1（OpenAI 兼容）`)
    } catch (error) {
      state.relayStarted = false
      toast(`Accio 反代端口启动失败：${error?.message ?? error}`, 'error')
    }
  }

  return {
    /** 注册供应商条目（不覆盖用户已有配置）。 */
    async config(cfg) {
      cfg.provider ??= {}
      cfg.provider[PROVIDER_ID] ??= {
        name: PROVIDER_NAME,
        npm: '@ai-sdk/openai-compatible',
        api: '',
        models: {},
      }
    },

    auth: {
      provider: PROVIDER_ID,
      refreshLead: 10 * 60 * 1000,
      // 随包 PNG 的 data URI（见 src/icon.mjs）：外链 favicon 实测是 text/html，
      // magpie 渲染不出来就会显示灰色通用方块
      icon: iconDataUri(),

      // authorize() 必须**立刻**返回 {url, method, callback}：
      // 在这里等用户登完，宿主和插件会互相等死。
      methods: [
        loginMethod('登录 Accio（阿里）'),
      ],

      /** 反代出口：magpie 用 OpenAI 线格式把请求交进来，这里换成 Accio 的上行。 */
      async loader(getAuth) {
        // 旧槽（type:'success'）就地升级，否则宿主永远不会替它续期
        void migrateLegacy(await (typeof getAuth === 'function' ? safeGet(getAuth) : readAuth()))
        return {
          // baseURL 不能是空串（宿主据此判「无处可发」）；真正上游在 fetch 里改写
          baseURL: 'https://accio.invalid/v1',
          async fetch(request, init) {
            let body
            try {
              body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
            } catch {
              return Response.json(
                { error: { type: 'invalid_request_error', message: 'accio：请求体不是 JSON' } },
                { status: 400 },
              )
            }
            let credential
            try {
              credential = await ensure(await (typeof getAuth === 'function' ? getAuth() : readAuth()))
            } catch (error) {
              return Response.json(
                { error: { type: 'authentication_error', message: error?.message ?? String(error) } },
                { status: 401 },
              )
            }
            try {
              return await chat(credential, {
                body,
                signal: init?.signal,
                // 硬续期：异常透传，由 chat 决定要不要重发（多账号不串号）
                renew,
              })
            } catch (error) {
              return Response.json(
                { error: { type: 'provider_error', message: `accio：${error?.message ?? String(error)}` } },
                { status: 502 },
              )
            }
          },
        }
      },

      /** 额度卡（只读，不消耗积分）。 */
      async usage(getAuth) {
        let credential
        try {
          credential = await ensure(await (typeof getAuth === 'function' ? getAuth() : readAuth()))
        } catch {
          return { plan: PROVIDER_NAME, windows: [{ name: PROVIDER_NAME, used: 0, display: '未登录' }] }
        }
        try {
          return { plan: PROVIDER_NAME, windows: await usageOf(credential) }
        } catch (error) {
          if (error?.signedOut === true) {
            return { plan: PROVIDER_NAME, windows: [{ name: PROVIDER_NAME, used: 0, display: '登录已失效，请重新登录' }] }
          }
          return { plan: PROVIDER_NAME, windows: [{ name: PROVIDER_NAME, used: 0, display: `额度查询失败：${error?.message ?? error}` }] }
        }
      },

      /**
       * magpie 的续期入口。返回值是「覆盖到旧槽上的字段」——
       * 必须带 `refresh`/`access`/`expires`（宿主只续 oauth 槽）。
       */
      async refresh(auth) {
        const base = credentialOf(auth)
        if (base === undefined) return undefined
        const next = await renew(base)
        const accountId = typeof auth?.accountId === 'string' && auth.accountId !== ''
          ? auth.accountId
          : await accountNameOf(next)
        return oauthFields(next, accountId)
      },
    },

    provider: {
      id: PROVIDER_ID,
      /** 第二个参数带当前账号的 auth（冷启动时内存为空，必须用它）。 */
      async models(_provider, ctx = {}) {
        const auth = ctx?.auth ?? (typeof ctx?.getAuth === 'function' ? await readAuth() : undefined)
        // 列目录是宿主每次都会走的路径，旧槽在这里升级最不容易漏
        await migrateLegacy(auth)
        return loadModels(auth)
      },
    },
  }
}

/** 供单测/排障：当前进程内的凭据与目录（不落盘）。 */
export const __state = state
/** 供单测：登录态形状转换（宿主 keptAs/save 的口径）。 */
export const __sessionOf = sessionOf
export const __storedOf = storedOf
export const __credentialOf = credentialOf
export { GATEWAY, buildAuthUrl }
