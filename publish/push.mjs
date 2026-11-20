// 用 gh 把插件推到 GitHub，可选再提 registry PR。**不需要 git，也不需要 PowerShell 脚本**
// （这台机器的 PowerShell 执行策略禁止跑 .ps1，所以这里用 .mjs）。
//
//   bun publish\push.mjs --dry-run
//   bun publish\push.mjs
//   bun publish\push.mjs --registry        # 顺带 fork + 提 registry PR
//
// token：优先 GITHUB_TOKEN；没有就用 `gh auth token`（gh 已登录即可）。

import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const args = process.argv.slice(2)
const has = (name) => args.includes(`--${name}`)
const flag = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const GH = 'D:\\01_Software\\Portable\\gh\\gh.exe'
const BUN = process.env.MAGPIE_BUN ?? join(process.env.USERPROFILE ?? '', '.cache', 'magpie', 'bun', '1.4.2', 'magpie-bun.exe')


const run = (command, argv, options = {}) => {
  const result = spawnSync(command, argv, { stdio: 'inherit', cwd: root, env: process.env, ...options })
  if (result.status !== 0) throw new Error(`${command} 退出码 ${result.status}`)
}

const capture = (command, argv) => {
  const result = spawnSync(command, argv, { cwd: root, env: process.env, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} 失败：${(result.stderr ?? '').trim().slice(0, 200)}`)
  return (result.stdout ?? '').trim()
}

let token = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim()
let owner = flag('owner')

if (!token) {
  try {
    token = capture(GH, ['auth', 'token'])
  } catch {
    throw new Error('取不到 GitHub token：先 `gh auth login`，或设置 GITHUB_TOKEN')
  }
}
process.env.GITHUB_TOKEN = token
if (owner === '') owner = capture(GH, ['api', 'user', '--jq', '.login'])
console.log(`GitHub 身份：${owner}`)

const passthrough = has('dry-run') ? ['--dry-run'] : []
console.log('\n== 1/2 推代码 ==')
run(BUN, [join(here, 'github-upload.mjs'), '--owner', owner, ...passthrough])

if (has('registry')) {
  console.log('\n== 2/2 提 registry PR ==')
  run(BUN, [join(here, 'open-registry-pr.mjs'), '--owner', owner, ...passthrough])
} else {
  console.log('\n（加 --registry 就会顺手给 magpie-community/plugins 提 PR）')
}
