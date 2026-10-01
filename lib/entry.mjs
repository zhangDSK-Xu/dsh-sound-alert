/**
 * dsh-sound-alert — 稳定入口（stable entry）
 * ============================================================================
 * DSH 的宿主模块按 URL 缓存（Node ESM 语义），直接改实现文件不会热生效。
 * 所以入口只做一件事：每次激活时用「带缓存破坏参数」的 URL 动态导入真正的实现
 * `lib/host.mjs`。
 *
 * 好处：改完 host.mjs / widget.js 之后，只要让 profile 的补丁层重新组装一次
 * （改动 cordis.patch.yml 触发 HMR）即可生效，不需要重启 DSH。
 *
 * `name` / `inject` 必须是静态导出（加载器要在导入后立刻读取），
 * 只有 `apply` 是动态委派。
 */

import fs from 'node:fs'

export const name = 'dsh-sound-alert'
export const inject = ['webServer']

const IMPL = new URL('./host.mjs', import.meta.url)

/** 用实现文件的修改时间作为版本号；取不到就退化成当前时间。 */
function revision() {
  try {
    return String(fs.statSync(IMPL).mtimeMs)
  } catch (err) {
    return String(Date.now())
  }
}

export async function apply(ctx) {
  const url = new URL(IMPL.href)
  url.searchParams.set('rev', revision())
  const impl = await import(url.href)
  return impl.apply(ctx)
}
