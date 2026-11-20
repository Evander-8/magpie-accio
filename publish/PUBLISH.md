# 发布与上架（让 magpie 里能搜到）

## 当前进度（2026-11-20）

| 步骤 | 状态 |
| --- | --- |
| GitHub 仓库 | ✅ https://github.com/Evander-8/magpie-accio（public，19 个文件，description + topics 已设） |
| 图标 | ✅ 官网 mark（`s.alicdn.com/.../24-24.svg`）→ headless Edge 渲成 48/128/256 PNG（白底圆角），仓库里的字节与本机一致 |
| npm 发布 | ⛔ 卡在这里：没有 npm token（`magpie-accio` 名字实测未被占用） |
| registry PR | ⏸ 等 npm 有包之后再提（脚本已就绪，一条命令） |

工具：GitHub CLI 已装在 `D:\01_Software\Portable\gh\gh.exe`（v2.105.0），已登录 `Evander-8`，
PAT 由 `gh auth token` 提供；这台机器 **没有 git**，所以推送走 GitHub REST API（`publish/github-upload.mjs`）。

```powershell
# 已跑过、以后重复推用这条（gh 已登录的话 token 自动取）
$env:GITHUB_TOKEN = (& "D:\01_Software\Portable\gh\gh.exe" auth token).Trim()
$env:HTTPS_PROXY  = "http://127.0.0.1:7890"
& "$env:USERPROFILE\.cache\magpie\bun\1.4.2\magpie-bun.exe" publish\github-upload.mjs --owner Evander-8
```

> 二进制文件必须按**字节** base64 上传。第一版脚本把 PNG 当 utf8 读，推上去的图标是坏图
> （6903B vs 本地 3872B）；现在改为 `readFileSync(path)` 取 Buffer，四个图标与本机 sha256 一致。

本地装的是**路径依赖**：`magpie plugin add "D:\...\magpie-accio"`。要出现在 magpie 的
**Plugins 页面 / 搜索结果**里，还差两步，而这两步都需要**你的账号**：

```
① npm 发布    magpie-accio            → 需要 npm token
② registry PR magpie-community/plugins → 需要 GitHub token（public_repo 就够，已有）
```

顺带一提：`magpie-accio` 这个名字在 npm 上**还没被占用**（实测 registry 返回 404），
magpie 社区 registry 目前 126 条里也**没有** Accio 专用条目（只有 `magpie-providers-hub`
里面的 `hub-accio` 渠道），所以上架不会撞名。

两个脚本都**不需要装 git**，全走 GitHub / npm 的 HTTP API。

---

## 0. 准备 token

| 用途 | 需要的权限 | 放哪 |
| --- | --- | --- |
| 建仓库并推代码 | classic token `public_repo`（或 fine-grained：`Contents: read/write` + `Administration: write`） | 环境变量 `GITHUB_TOKEN` |
| 给 registry 提 PR | 同上（要 fork + 提交） | 同一个 `GITHUB_TOKEN` |
| npm 发布 | npm 账号的 Automation token | 环境变量 `NPM_TOKEN` |

```powershell
$env:GITHUB_TOKEN = "ghp_xxx"
$env:NPM_TOKEN    = "npm_xxx"
# GitHub 直连不通时（本机常见）：
$env:HTTPS_PROXY  = "http://127.0.0.1:7890"
```

---

## 1. 推代码到 GitHub

先空跑一遍看会传哪些文件（不联网、不改任何东西）：

```powershell
& "C:\Users\<你>\.cache\magpie\bun\1.4.2\magpie-bun.exe" publish\github-upload.mjs --owner <你的GitHub用户名> --dry-run
```

真推：

```powershell
& "C:\Users\<你>\.cache\magpie\bun\1.4.2\magpie-bun.exe" publish\github-upload.mjs --owner <你的GitHub用户名>
```

脚本会：建公开仓库 `magpie-accio`（已存在则复用）→ 用 Git Data API **一次提交**全部文件
（15 个，含 `icons/`、`src/`、`test/`、`publish/`）→ 把 `package.json` 的
`repository/homepage/bugs` 改成真实地址（只在提交内容里改，不动你本地文件）→ 写
description 与 topics。

> 想用 git 的话等价命令：`git init && git add -A && git commit -m "feat: magpie-accio" &&
> git remote add origin https://github.com/<你>/magpie-accio.git && git push -u origin main`
> —— 本机没装 git，所以上面给的是 API 版。

## 2. 发布到 npm

**需要 npm 账号**（公开包不需要组织，unscoped 直接发）：

1. 注册：<https://www.npmjs.com/signup> —— 用户名随意，邮箱要能收信。
2. 开 2FA：头像 → Account Settings → Two-Factor Authentication → TOTP（npm 现在发布基本都要求）。
3. 生成 token：头像 → Access Tokens → Generate New Token
   - 简单版：**Classic Token → Automation**（绕过 OTP，脚本用这个最省事）
   - 更细：**Granular Access Token** → Packages and scopes = `Read and write`、Packages = `All packages`、勾 `Bypass 2FA`
4. 发布（`bun publish` 认 `NPM_CONFIG_TOKEN` 这个环境变量，实测由「无 token」变成「401」即证明它读到了）：

```powershell
cd "D:\03_Personal\AI Agent\Deepseek Harness默认空间\magpie-accio"
$env:NPM_TOKEN = "npm_xxx"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
& "$env:USERPROFILE\.cache\magpie\bun\1.4.2\magpie-bun.exe" publish\npm-publish.mjs --registry
```

`publish/npm-publish.mjs` 会先 `GET /-/whoami` 校验 token、查包名归属（不是你的就直接停），
再 `bun publish --access public`，最后（带 `--registry`）调用 `open-registry-pr.mjs` 提 PR。
`--dry-run` 只打包不发。

> ⚠️ 这台机器的 PowerShell 执行策略禁止运行 `.ps1`（`... 因为在此系统上禁止运行脚本`），
> 所以所有辅助脚本都是 `.mjs`，用 magpie 自带的 bun 跑。

发布前可以先自检包内容（**包目录在中文路径下时，`bun pm pack` 要指定输出目录**）：

```powershell
& "...\magpie-bun.exe" pm pack --destination C:\Users\<你>\AppData\Local\Temp\accio-pack
tar -tzf C:\Users\<你>\AppData\Local\Temp\accio-pack\magpie-accio-0.2.2.tgz
```

预期 15 个文件：`package.json / LICENSE / README.md / index.mjs / icons/*.png / publish/* / src/*`。
当前实测：未压缩 114.55KB，压缩 47.64KB。

`package.json` 的 `files` 已经把 `index.mjs / src / icons / publish / README.md / LICENSE` 列好了，
不会把测试与临时文件带进包里（`test/` 不在 files 里，但仓库里有）。

## 3. 提 registry PR（这一步决定"搜得到"）

```powershell
& "...\magpie-bun.exe" publish\open-registry-pr.mjs --dry-run     # 先本地校验插入逻辑
& "...\magpie-bun.exe" publish\open-registry-pr.mjs               # 真跑：fork → 分支 → 提交 → 开 PR
```

它做的事：

1. fork `magpie-community/plugins`（已有 fork 就复用）；
2. 在 fork 上建分支 `magpie-accio-registry`；
3. 把 `publish/registry-entry.json` **文本插入**到 `registry.json` 的 `"plugins": [` 之后
   （保留上游原有排版，diff 只有一行）；
4. 向上游开 PR，标题 `registry: add magpie-accio (Accio (阿里))`。

插入的条目长这样（字段与现有 126 条一致）：

```json
{ "package": "magpie-accio", "name": "Accio (阿里)", "providers": ["accio"], "community": true,
  "icon": "https://raw.githubusercontent.com/<你>/magpie-accio/main/icons/accio-128.png",
  "summary": { "en": "…", "zh": "…" } }
```

字段含义：`package` = npm 包名（**必须先发布到 npm**，registry 只存名字）；
`providers` = 插件注册的供应商 id；`community: true` = 第三方插件（审核会看）；
`icon` 必须是 **https** 地址（magpie 不替你下载，它只存这个字符串）；
`summary.en/zh` 会显示在插件卡片上。

> 图标就用仓库里的 `icons/accio-128.png`（随包，data URI 已内嵌到 `auth.icon`，
> 所以**本地路径安装也有图标**，不依赖 registry）。

## 4. 验证

```powershell
# 名字能装了（等价于用 registry）
magpie plugin add magpie-accio

# 供应商还在
magpie plugin list
```

然后 magpie 的 **Plugins 页面**里搜 `Accio`：市场列表是按 registry 拉的，页面底部会显示
“供应商列表 · 5 分钟前”，刚合并的条目刷新一次就能看到。

---

## 为什么会“没有图标”，以及已经怎么修

magpie 的 `host.js` 里 `iconOf()` 只认两种字符串：

```js
/^(https:\/\/|data:image\/)/i.test(s) && s.length <= 3 << 19
```

我们原来写的 `https://www.accio-ai.com/favicon.ico` **符合正则**，所以 magpie 收下了 ——
但那个地址实测返回的是 `text/html`（30KB 的 SPA 页面，magic `da 20 20`），渲染必然失败，
界面上就是灰色通用方块。

现在改成：`icons/accio-128.png`（随包 PNG，3KB）在运行时读成 **`data:image/png;base64,…`**
（4.1KB），`auth.icon` 直接给这个 URI —— 离线可用、不需要任何外部请求。
`package.json` 里不再写 `magpie.icon`（`auth.icon` 优先，写了反而两处要同步）。
