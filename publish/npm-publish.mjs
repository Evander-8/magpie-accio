// 发布到 npm，可选再提 registry PR。**用 .mjs 而不是 .ps1**：这台机器的 PowerShell
// 执行策略禁止跑脚本（`... 因为在此系统上禁止运行脚本`）。
//
//   $env:NPM_TOKEN = "npm_xxx"
//   bun publish\npm-publish.mjs
//   bun publish\npm-publish.mjs --registry        # 发 npm + 提 registry PR（上架 magpie 市场）
//   bun publish\npm-publish.mjs --dry-run         # 只打包，不真发
//
// 注意：npm 发布**公开且不可撤回**，同一个版本号不能重发。

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

const BUN = process.env.MAGPIE_BUN ?? join(process.env.USERPROFILE ?? '', '.cache', 'magpie', 'bun', '1.4.2', 'magpie-bun.exe')
const GH = 'D:\\01_Software\\Portable\\gh\\gh.exe'

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const token = (flag('token') || process.env.NPM_TOKEN || process.env.NPM_CONFIG_TOKEN || '').trim()

if (!token) {
  console.error(`缺少 npm token（当前包：${pkg.name}@${pkg.version}）

  1) 注册账号：https://www.npmjs.com/signup
     · 用户名随意，公开包不需要组织（unscoped 直接就能发）
     · 邮箱要能收信：npm 会发验证码/验证链接
  2) 开 2FA（npm 现在发布基本都要求）：头像 → Account Settings → Two-Factor Authentication → TOTP
  3) 生成 token：头像 → Access Tokens → Generate New Token
     · 简单版：Classic Token → Automation（绕过 OTP，适合脚本）
     · 更细：Granular Access Token → Packages and scopes: Read and write / All packages，勾 Bypass 2FA
  4) 回来执行：
     $env:NPM_TOKEN = "npm_xxx"
     bun publish\\npm-publish.mjs --registry
`)
  process.exit(2)
}

process.env.NPM_CONFIG_TOKEN = token

// 先验证 token（顺带看包名是否已被别人占用）
const whoamiRes = await fetch('https://registry.npmjs.org/-/whoami', {
  headers: { authorization: `Bearer ${token}` },
  ...(process.env.HTTPS_PROXY ? { proxy: process.env.HTTPS_PROXY } : {}),
})
if (!whoamiRes.ok) {
  console.error(`token 无效：npm /-/whoami -> HTTP ${whoamiRes.status}（401 = token 过期或类型不对）`)
  process.exit(2)
}
const me = await whoamiRes.json()
console.log(`npm 账号：${me.username}`)

const exists = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name).replace('%40', '@')}`, {
  ...(process.env.HTTPS_PROXY ? { proxy: process.env.HTTPS_PROXY } : {}),
})
if (exists.ok) {
  const meta = await exists.json()
  const owners = (meta.maintainers ?? []).map((m) => m.name)
  if (!owners.includes(me.username)) {
    console.error(`包名 ${pkg.name} 已被 ${owners.join(', ')} 占用，换名字（改 package.json 的 name）后再发。`)
    process.exit(2)
  }
  console.log(`包名 ${pkg.name} 已存在且属于你，将发布 ${pkg.version}`)
} else if (exists.status === 404) {
  console.log(`包名 ${pkg.name} 可用（首次发布）`)
} else {
  console.warn(`包名查询返回 ${exists.status}，继续尝试发布`)
}

const run = (argv) => {
  const result = spawnSync(BUN, argv, { stdio: 'inherit', cwd: root, env: process.env })
  if (result.status !== 0) throw new Error(`bun ${argv.join(' ')} 退出码 ${result.status}`)
}

console.log('\n== 1/2 发布到 npm ==')
run(['publish', '--access', 'public', ...(has('dry-run') ? ['--dry-run'] : [])])

if (has('registry') && !has('dry-run')) {
  if (!process.env.HTTPS_PROXY) process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
  const auth = spawnSync(GH, ['auth', 'token'], { encoding: 'utf8' })
  if (auth.status !== 0) throw new Error('提 PR 需要 gh 已登录（gh auth login）')
  process.env.GITHUB_TOKEN = (auth.stdout ?? '').trim()
  const login = spawnSync(GH, ['api', 'user', '--jq', '.login'], { encoding: 'utf8' })
  const owner = (login.stdout ?? '').trim()

  console.log('\n== 2/2 提 registry PR ==')
  run([join(here, 'open-registry-pr.mjs'), '--owner', owner])
} else {
  console.log('\n（加 --registry 就会顺手给 magpie-community/plugins 提 PR）')
}
