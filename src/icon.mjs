// 供应商图标。
//
// magpie 的规则（`host.js` 的 `iconOf`）：`auth.icon` 必须是 **https:// 或 data:image/**
// 开头的字符串，长度 ≤ 3MB，然后它原样存进 `internal/provider` 展示，**不会替你去下载**。
//
// 所以这里不再写外链 favicon：`https://www.accio-ai.com/favicon.ico` 实测返回的是
// `text/html`（30KB 的 SPA 页面），magpie 拿到一坨 HTML 渲染不出来。
// 图标现在是**官网的那个 mark**：站点 <link rel="icon"> 指向
// `https://s.alicdn.com/@img/imgextra/i4/O1CN01L3EOoU1IfPQXGpYhJ_!!6000000000920-55-tps-24-24.svg`
// （1372 字节的 SVG，A 字 + 青绿渐变），随包存成 icons/accio-official.svg，
// 再用 headless Edge 渲染成 48/128/256 的 PNG（白底圆角，深色界面里也看得见）。
// 这里把 PNG 读成 data URI —— 离线可用、不依赖外链、不依赖 registry。

import { readFileSync } from 'node:fs'

const CANDIDATES = [
  new URL('../icons/accio-128.png', import.meta.url),
  new URL('../icons/accio-256.png', import.meta.url),
]

let cached

/** @returns {string} `data:image/png;base64,…`，读不到图时是空串（宿主就显示通用方块）。 */
export function iconDataUri() {
  if (cached !== undefined) return cached
  for (const file of CANDIDATES) {
    try {
      const bytes = readFileSync(file)
      cached = `data:image/png;base64,${bytes.toString('base64')}`
      return cached
    } catch { /* 试下一个 */ }
  }
  cached = ''
  return cached
}

/** 宿主 `iconOf` 的等价校验：不是 https/data:image 或超过 3MB 就当没有图标。 */
export const iconAcceptedByHost = (value) => {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length <= 3 << 19 && /^(https:\/\/|data:image\/)/i.test(text)
}
