// 往 magpie 社区插件目录（magpie-community/plugins 的 registry.json）提一个 PR，
// 让插件出现在 magpie 的 **Plugins → 市场/搜索** 里。**不需要装 git**。
//
//   GITHUB_TOKEN=ghp_xxx node publish/open-registry-pr.mjs
//   node publish/open-registry-pr.mjs --dry-run        # 只做本地校验：能不能加、加在哪
//
// 前置：npm 上已经有 `magpie-accio` 这个包（registry 的 `package` 字段是 npm 包名）。
// token 权限：public_repo（要 fork 上游 + 在你 fork 里提交）。
//
// 做的事：fork 上游 → 在 fork 上建分支 → 把 publish/registry-entry.json 插到
// registry.json 的 plugins 数组开头（文本插入，保留上游原有排版）→ 开 PR。

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const entry = JSON.parse(readFileSync(join(here, 'registry-entry.json'), 'utf8'))
const ownerOverride = process.argv.includes('--owner')
  ? process.argv[process.argv.indexOf('--owner') + 1]
  : ''

const UPSTREAM = 'magpie-community/plugins'
const FILE_PATH = 'registry.json'
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const has = (name) => args.includes(`--${name}`)
const dryRun = has('dry-run')
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? flag('token', '')
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? ''

if (!dryRun && token === '') {
  console.error('缺少 GITHUB_TOKEN（或 --token）；本地校验请加 --dry-run')
  process.exit(2)
}

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'magpie-accio-registry-pr',
      'x-github-api-version': '2022-11-28',
      ...(init.headers ?? {}),
    },
    ...(proxy === '' ? {} : { proxy }),
  })
  const text = await res.text()
  let body
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    body = text
  }
  if (!res.ok) {
    const error = new Error(`GitHub ${init.method ?? 'GET'} ${path} → ${res.status} ${body?.message ?? String(body).slice(0, 160)}`)
    error.status = res.status
    throw error
  }
  return body
}

/** 把条目插到 `"plugins": [` 之后（文本插入，不动别人的排版）。 */
export function insertEntry(registryText, pluginEntry) {
  const marker = registryText.indexOf('"plugins": [')
  if (marker < 0) throw new Error('registry.json 里找不到 "plugins": [')
  const lineEnd = registryText.indexOf('\n', marker)
  if (lineEnd < 0) throw new Error('registry.json 的 "plugins": [ 后面没有换行')
  const oneLine = JSON.stringify(pluginEntry)
  const indent = '    '
  const insertion = `\n${indent}${oneLine},`
  return registryText.slice(0, lineEnd) + insertion + registryText.slice(lineEnd)
}

const checkNoDuplicate = (registryText) => {
  const registry = JSON.parse(registryText)
  const same = (registry.plugins ?? []).filter((p) => p.package === entry.package)
  if (same.length > 0) throw new Error(`registry 里已经有 ${entry.package} 了`)
  return registry
}

// ── 先做纯本地校验（离线也要过）─────────────────────────────────────────
const sample = readFileSync(join(here, 'registry-entry.sample.json'), 'utf8')
const probe = { ...entry, icon: entry.icon.replace('GITHUB_OWNER', 'someone') }
const patched = insertEntry(sample, probe)
const parsed = JSON.parse(patched)
if (!parsed.plugins.some((p) => p.package === entry.package)) throw new Error('插入后校验失败：条目没进去')
if (parsed.plugins.length !== JSON.parse(sample).plugins.length + 1) throw new Error('插入后校验失败：条目数不对')
console.log('· 插入逻辑自检通过（样例 registry 上验证，JSON 仍可解析）')
console.log(`· 条目：${entry.package} · providers=${(entry.providers ?? []).join(',')} · community=${entry.community}`)
console.log(`· 图标：${entry.icon}`)

if (dryRun) {
  console.log('\n[dry-run] 未连接 GitHub。真实运行会：fork → 分支 magpie-accio-registry → 提交 registry.json → 开 PR')
  process.exit(0)
}

// ── 真实流程 ────────────────────────────────────────────────────────────
const me = await api('/user')
const owner = me.login
if (ownerOverride !== '' && ownerOverride !== owner) {
  console.log(`· 注意：token 属于 ${owner}，--owner 写的是 ${ownerOverride}；图标地址用 --owner 的值`)
}
const iconOwner = ownerOverride !== '' ? ownerOverride : owner
entry.icon = `https://raw.githubusercontent.com/${iconOwner}/magpie-accio/main/icons/accio-128.png`
console.log(`· 身份：${owner}`)

const upstream = await api(`/repos/${UPSTREAM}`)
const base = upstream.default_branch

// 1) fork（已有则复用）
try {
  await api(`/repos/${owner}/plugins`)
  console.log(`· 复用已有 fork：${owner}/plugins`)
} catch (error) {
  if (error.status !== 404) throw error
  await api(`/repos/${UPSTREAM}/forks`, { method: 'POST', body: JSON.stringify({ default_branch_only: true }) })
  console.log('· 已发起 fork，等它落地…')
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    try {
      await api(`/repos/${owner}/plugins`)
      break
    } catch { /* 还没好 */ }
  }
}

// 2) 读上游 registry.json（走 API，拿 sha）
const upstreamFile = await api(`/repos/${UPSTREAM}/contents/${FILE_PATH}?ref=${base}`)
const registryText = Buffer.from(upstreamFile.content, 'base64').toString('utf8')
checkNoDuplicate(registryText)

// 3) 在 fork 上建分支并提交
const ref = await api(`/repos/${owner}/plugins/git/ref/heads/${base}`)
const branchName = 'magpie-accio-registry'
try {
  await api(`/repos/${owner}/plugins/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: ref.object.sha }),
  })
} catch (error) {
  if (error.status !== 422) throw error // 分支已存在就用它
}

const forkFile = await api(`/repos/${owner}/plugins/contents/${FILE_PATH}?ref=${branchName}`)
const forkText = Buffer.from(forkFile.content, 'base64').toString('utf8')
checkNoDuplicate(forkText)
const nextText = insertEntry(forkText, entry)

await api(`/repos/${owner}/plugins/contents/${FILE_PATH}`, {
  method: 'PUT',
  body: JSON.stringify({
    message: `registry: add ${entry.package} (${entry.name})`,
    content: Buffer.from(nextText, 'utf8').toString('base64'),
    sha: forkFile.sha,
    branch: branchName,
  }),
})
console.log('· registry.json 已提交到 fork')

// 4) 开 PR
const pr = await api(`/repos/${UPSTREAM}/pulls`, {
  method: 'POST',
  body: JSON.stringify({
    title: `registry: add ${entry.package} (${entry.name})`,
    head: `${owner}:${branchName}`,
    base,
    body: [
      `Adds **${entry.name}** (\`${entry.package}\`) to the registry.`,
      '',
      entry.summary.en,
      '',
      '- providers: ' + (entry.providers ?? []).join(', '),
      '- npm: https://www.npmjs.com/package/' + entry.package,
      '- repo: https://github.com/' + (flag('repo-owner', owner)) + '/magpie-accio',
      '',
      'Signed-in on the plugin: web OAuth (PKCE + loopback callback) — no vendor desktop app.',
    ].join('\n'),
  }),
})
console.log(`\nPR 已创建：${pr.html_url}`)
