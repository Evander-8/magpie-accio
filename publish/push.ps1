# 用 gh（GitHub CLI）把插件推到 GitHub —— 一条命令。
#
#   .\publish\push.ps1                 # 推 GitHub
#   .\publish\push.ps1 -Registry       # 推 GitHub + 给 magpie 社区 registry 提 PR
#
# 前置：gh 已登录（gh auth status 正常）。没登录就先跑：
#   $env:HTTPS_PROXY="http://127.0.0.1:7890"; gh auth login --hostname github.com --git-protocol https --web --scopes repo,read:org

param(
  [switch]$Registry,
  [string]$Owner = ''
)

$ErrorActionPreference = 'Stop'

$gh = 'D:\01_Software\Portable\gh\gh.exe'
$bun = Join-Path $env:USERPROFILE '.cache\magpie\bun\1.4.2\magpie-bun.exe'
$root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path $gh)) { throw "找不到 gh：$gh（先安装 GitHub CLI）" }
if (-not (Test-Path $bun)) { throw "找不到 bun：$bun（magpie 自带，先用 magpie 跑过一次插件）" }

# GitHub 在这台机器上需要代理；有就带上，没有就不设
if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = 'http://127.0.0.1:7890' }
if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = $env:HTTPS_PROXY }

& $gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "gh 还没登录。先跑：`n  `$env:HTTPS_PROXY=`"$env:HTTPS_PROXY`"; & `"$gh`" auth login --hostname github.com --git-protocol https --web --scopes repo,read:org"
}

# 用 gh 的 token 跑 API 推送脚本（脚本自身不需要 git）
$token = (& $gh auth token).Trim()
if (-not $token) { throw 'gh auth token 取不到 token' }
$env:GITHUB_TOKEN = $token

if ($Owner -eq '') { $Owner = (& $gh api user --jq .login).Trim() }
Write-Host "GitHub 身份：$Owner" -ForegroundColor Cyan

Push-Location $root
try {
  Write-Host "`n== 1/2 推代码 ==" -ForegroundColor Cyan
  & $bun (Join-Path $root 'publish\github-upload.mjs') --owner $Owner
  if ($LASTEXITCODE -ne 0) { throw '推送到 GitHub 失败' }

  if ($Registry) {
    Write-Host "`n== 2/2 给 magpie 社区 registry 提 PR ==" -ForegroundColor Cyan
    & $bun (Join-Path $root 'publish\open-registry-pr.mjs') --owner $Owner
    if ($LASTEXITCODE -ne 0) { throw '提 registry PR 失败' }
  } else {
    Write-Host "`n（加 -Registry 就会顺手给 magpie-community/plugins 提 PR，上架后 magpie 里能搜到）" -ForegroundColor DarkGray
  }
} finally {
  Pop-Location
}

Write-Host "`n剩下 npm 发布（需要 npm token）：" -ForegroundColor Cyan
Write-Host "  cd `"$root`""
Write-Host "  `$env:NPM_CONFIG_TOKEN = `$env:NPM_TOKEN"
Write-Host "  & `"$bun`" publish --access public"
