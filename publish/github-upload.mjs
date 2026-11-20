// 把本插件推到 GitHub —— **不需要装 git**，全走 GitHub REST API。
//
//   GITHUB_TOKEN=ghp_xxx  node publish/github-upload.mjs --owner <你的用户名>
//   node publish/github-upload.mjs --owner <你的用户名> --dry-run      # 只看会传哪些文件
//
// token 权限：repo（新建公开仓库用 `public_repo` 就够）。
// 做的事：建仓库（已存在则复用）→ 用 Git Data API 一次提交全部文件 →
// 写 description/topics → 把 package.json 里的 repository/homepage/bugs 改成真实地址。
//
// 代理：如果 GitHub 直连不通，设置 HTTPS_PROXY=http://127.0.0.1:7890（脚本会用 init.proxy）。

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const has = (name) => args.includes(`--${name}`)

const owner = flag('owner', '')
const repo = flag('repo', 'magpie-accio')
const branch = flag('branch', 'main')
const description = flag('description', 'magpie 插件：网页登录 Accio（阿里 Accio Work，中国版），不需要桌面客户端。')
const dryRun = has('dry-run')
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? flag('token', '')
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? ''

if (owner === '') {
  console.error('缺少 --owner <你的 GitHub 用户名>')
  process.exit(2)
}
if (!dryRun && token === '') {
  console.error('缺少 GITHUB_TOKEN（或 --token）；只想先看一遍就加 --dry-run')
  process.exit(2)
}

const IGNORE_DIRS = new Set(['.git', 'node_modules', '.idea', '.vscode', 'dist', 'coverage'])
const IGNORE_FILES = new Set(['.DS_Store', 'Thumbs.db', 'bun.lock', 'package-lock.json'])

/** 递归收集要上传的文件（相对路径 + 内容）。 */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIRS.has(name) || IGNORE_FILES.has(name)) continue
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) collect(full, out)
    else if (stat.size < 1_000_000) out.push(full)
  }
  return out
}

const files = collect(root).map((full) => ({
  path: relative(root, full).split(sep).join('/'),
  full,
}))

// package.json 里的仓库地址改成真实值
const pkgPath = join(root, 'package.json')
let pkgText = readFileSync(pkgPath, 'utf8')
if (!pkgText.includes(`"repository"`)) {
  const url = `https://github.com/${owner}/${repo}`
  const pkg = JSON.parse(pkgText)
  pkg.repository = { type: 'git', url: `git+${url}.git` }
  pkg.homepage = `${url}#readme`
  pkg.bugs = { url: `${url}/issues` }
  pkgText = `${JSON.stringify(pkg, null, 2)}\n`
  console.log(`· package.json 会补上 repository/homepage/bugs → ${url}`)
}

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'magpie-accio-publisher',
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
    const why = body?.message ?? String(body).slice(0, 200)
    const error = new Error(`GitHub ${init.method ?? 'GET'} ${path} → ${res.status} ${why}`)
    error.status = res.status
    throw error
  }
  return body
}

console.log(`仓库：${owner}/${repo}（分支 ${branch}）`)
console.log(`文件：${files.length} 个`)
for (const file of files) console.log(`  ${file.path}`)

if (dryRun) {
  console.log('\n[dry-run] 未连接 GitHub，也没有改动任何文件。')
  process.exit(0)
}

// 1) 建仓库（已存在就复用）
let created = true
try {
  await api(`/repos/${owner}/${repo}`)
  created = false
} catch (error) {
  if (error.status !== 404) throw error
}
if (created) {
  await api('/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name: repo,
      description,
      private: false,
      has_issues: true,
      has_wiki: false,
      auto_init: false,
    }),
  })
  console.log('· 仓库已创建')
} else {
  console.log('· 仓库已存在，复用')
}

// 2) Git Data API：blob → tree → commit → ref（一次提交，不会产生 N 条提交）
//
// ⚠️ 空仓库不接受 `POST /git/blobs`（GitHub 回 409 "Git Repository is empty"）。
// 所以先看有没有分支：没有就用 Contents API 落一个 README 建出初始提交，
// 再拿它当 parent，把其余文件用一次提交补上。
// ⚠️ 一律按**字节**读、base64 上传：PNG 之类的二进制按 utf8 读会被替换坏
// （第一次推送就是这么把图标推成 6903B 的破图的）。
const uploads = files.map(({ path, full }) => ({
  path,
  base64: path === 'package.json'
    ? Buffer.from(pkgText, 'utf8').toString('base64')
    : readFileSync(full).toString('base64'),
}))

let parent
try {
  const ref = await api(`/repos/${owner}/${repo}/git/ref/heads/${branch}`)
  parent = await api(`/repos/${owner}/${repo}/git/commits/${ref.object.sha}`)
} catch (error) {
  if (error.status !== 404 && error.status !== 409) throw error
  const seed = uploads.find((item) => item.path === 'README.md') ?? uploads[0]
  await api(`/repos/${owner}/${repo}/contents/${seed.path}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: 'chore: seed commit（GitHub 空仓库不能直接建 blob）',
      content: seed.base64,
      branch,
    }),
  })
  const ref = await api(`/repos/${owner}/${repo}/git/ref/heads/${branch}`)
  parent = await api(`/repos/${owner}/${repo}/git/commits/${ref.object.sha}`)
  console.log(`· 空仓库已用 ${seed.path} 建出初始提交`)
}

const blobs = []
for (const upload of uploads) {
  const blob = await api(`/repos/${owner}/${repo}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: upload.base64, encoding: 'base64' }),
  })
  blobs.push({ path: upload.path, mode: '100644', type: 'blob', sha: blob.sha })
}
const tree = await api(`/repos/${owner}/${repo}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ base_tree: parent.tree.sha, tree: blobs }),
})
const pkgVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version
const commit = await api(`/repos/${owner}/${repo}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({
    message: `feat: magpie-accio ${pkgVersion} —— 网页登录 Accio（中国版），目录/倍率/工具调用/额度`,
    tree: tree.sha,
    parents: [parent.sha],
  }),
})
await api(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: commit.sha, force: true }),
})
console.log(`· 已提交 ${uploads.length} 个文件（commit ${commit.sha.slice(0, 7)}）`)

// 3) 仓库元信息
await api(`/repos/${owner}/${repo}`, {
  method: 'PATCH',
  body: JSON.stringify({
    description,
    homepage: `https://github.com/${owner}/${repo}#readme`,
  }),
})
await api(`/repos/${owner}/${repo}/topics`, {
  method: 'PUT',
  body: JSON.stringify({ names: ['magpie', 'magpie-plugin', 'opencode', 'accio', 'alibaba', 'openai-compatible'] }),
})

console.log(`\n完成：https://github.com/${owner}/${repo}`)
const readme = join(root, 'README.md')
if (existsSync(readme)) console.log('下一步：npm 发布 → 见 publish/PUBLISH.md')
