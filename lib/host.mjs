/**
 * dsh-sound-alert — 宿主插件（Host half）
 * ============================================================================
 * DSH 需要你「授权」或「做出选择」时，把这次请求推送给浏览器页面，由页面播放
 * 提示音并弹出提醒卡片。
 *
 * 两个触发源（都是 Cordis 的 waterfall 事件，注册普通监听器即可旁听）：
 *   1. `approval/request`        —— 工具调用需要你授权（approval 策略 = ask）。
 *   2. `user-questions/request`  —— ask_user_question / 计划复核需要你选择。
 *
 * 旁听必须完全透明：立即 `return next()`，绝不阻塞、绝不吃掉下游应答者，
 * 自身任何异常都吞掉，保证授权链与未安装本插件时完全一致。
 *
 * 只有当请求在宽限期后仍未被应答（说明确实在等人）时才提醒，
 * 这样被自动应答者（如 auto-review、无应答者 fail-closed）立即处理的请求不会响铃。
 *
 * 对外接口（全部挂在 `/dsh-sound-alert/` 下）：
 *   GET  /dsh-sound-alert/state.json   当前提醒状态（最近 N 条 + seq + 未决列表）
 *   GET  /dsh-sound-alert/events       SSE 实时推送（snapshot / alert / resolved）
 *   GET  /dsh-sound-alert/alert.js     页面脚本（每次请求从磁盘读取，便于热改）
 *   GET  /dsh-sound-alert/health.json  自检
 *   POST /dsh-sound-alert/test.json    注入一条模拟提醒（自测整条链路）
 *   另外通过 tapIndex 向 index.html 注入 <script defer src=".../alert.js">
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 包根目录：lib/host.mjs -> 包根，保证插件可随包整体搬迁。 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WIDGET_FILE = path.join(PACKAGE_ROOT, 'lib', 'widget.js')

const BASE = '/dsh-sound-alert'
const SCRIPT_TAG = `<script defer src="${BASE}/alert.js"></script>`

/** 保留的提醒条数上限（环形裁剪），避免长时间运行后内存增长。 */
const MAX_ALERTS = 60
/** 请求必须超过这个时长仍未被应答，才认为「确实在等人」。 */
const HUMAN_PENDING_MS = 500
/** 模拟提醒的自动解除时间，避免自测时无限重复响铃。 */
const TEST_TTL_MS = 8000
/** SSE 心跳间隔，避免中间层因空闲断开长连接。 */
const SSE_PING_MS = 15000

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
}

export const name = 'dsh-sound-alert'
export const inject = ['webServer']

/** 截断文本，防止超长工具名/问题体把状态负载撑大。 */
function clip(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text.length === 0) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 尽量读出会话 id，仅用于展示定位；任何形状变化都不应影响提醒。 */
function sessionIdOf(agent) {
  try {
    const session = agent && agent.session
    if (!session) return null
    if (session.header && typeof session.header.id === 'string') return session.header.id
    if (typeof session.id === 'string') return session.id
  } catch (err) {}
  return null
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { ...JSON_HEADERS, 'Content-Length': String(Buffer.byteLength(body)) })
  res.end(body)
}

export function apply(ctx) {
  let seq = 0
  let dismissedUpTo = 0
  /** 按 seq 升序保存的最近提醒；旧条目被环形裁剪。 */
  const alerts = []
  /** 活着的 SSE 连接。 */
  const streams = new Set()
  const disposers = []
  let widgetCache = { mtimeMs: -1, text: '' }

  // ---------------------------------------------------------------- 状态写入

  function broadcast(event, payload) {
    if (streams.size === 0) return
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
    for (const stream of Array.from(streams)) {
      try {
        stream.res.write(frame)
      } catch (err) {
        streams.delete(stream)
      }
    }
  }

  function record(alert) {
    seq += 1
    const entry = { seq, ts: Date.now(), resolved: false, resolvedTs: null, outcome: null, ...alert }
    alerts.push(entry)
    while (alerts.length > MAX_ALERTS) alerts.shift()
    broadcast('alert', entry)
    return entry
  }

  function resolve(entry, outcome) {
    if (!entry || entry.resolved) return
    entry.resolved = true
    entry.resolvedTs = Date.now()
    entry.outcome = typeof outcome === 'string' ? outcome : null
    broadcast('resolved', { seq: entry.seq, resolvedTs: entry.resolvedTs, outcome: entry.outcome })
  }

  /**
   * 旁听一次「需要人做决定」的请求。
   *
   * @param kind - 'approval' | 'question'
   * @param payload - 展示用字段
   * @param answer - 下游 waterfall 的返回值（决定被做出来时 settle）
   */
  function watch(kind, payload, answer) {
    const startedAt = Date.now()
    let settled = false
    let entry = null

    const onSettled = (outcome) => {
      settled = true
      resolve(entry, outcome)
    }
    Promise.resolve(answer).then(
      (outcome) => onSettled(outcome),
      () => onSettled(null),
    )

    const timer = setTimeout(() => {
      if (settled) return // 已被（人或机器）应答：不需要提醒
      entry = record({ kind, startedAt, ...payload })
    }, HUMAN_PENDING_MS)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  // ------------------------------------------------------- 两个「需要人」事件

  // 必须 prepend：waterfall 里「先注册的是外层」，而浏览器客户端接上后
  // dsh-api-remotes 会注册一个把请求转发给页面、并直接以页面答案 settle 的监听器
  // （它只在自己认不出来时才调用 next()）。若本插件排在那之后，页面一接上我们就
  // 永远收不到事件。放在最外层 + 立即 next() 既保证一定旁听到，也完全不改变原有
  // 的授权 / 应答行为。
  const OBSERVE = { prepend: true }

  // 授权请求：request = { agent, toolName, callId?, reason?, displayReason?, signal }
  ctx.on('approval/request', (request, next) => {
    const answer = next()
    try {
      const req = request || {}
      watch('approval', {
        title: '需要你授权',
        toolName: clip(req.toolName, 120) || '未知工具',
        callId: typeof req.callId === 'string' ? req.callId : null,
        reason: clip(req.displayReason || req.reason, 300),
        sessionId: sessionIdOf(req.agent),
      }, answer)
    } catch (err) {}
    return answer
  }, OBSERVE)

  // 选择请求：request = { questions: [...], agent?, callId?, signal }
  ctx.on('user-questions/request', (request, next) => {
    const answer = next()
    try {
      const req = request || {}
      const list = Array.isArray(req.questions) ? req.questions : []
      watch('question', {
        title: '需要你选择',
        callId: typeof req.callId === 'string' ? req.callId : null,
        count: list.length,
        sessionId: sessionIdOf(req.agent),
        questions: list.slice(0, 4).map((q) => ({
          header: clip(q && q.header, 120),
          question: clip(q && q.question, 400),
          multiSelect: !!(q && q.multiSelect),
          intent: q && q.intent && typeof q.intent.kind === 'string' ? clip(q.intent.kind, 60) : null,
          options: (q && Array.isArray(q.options) ? q.options : [])
            .slice(0, 10)
            .map((option) => clip(option && option.label, 120))
            .filter(Boolean),
        })),
      }, answer)
    } catch (err) {}
    return answer
  }, OBSERVE)

  // ------------------------------------------------------------------- 状态

  function statePayload() {
    return {
      ok: true,
      plugin: name,
      version: 1,
      seq,
      dismissedUpTo,
      serverTime: Date.now(),
      graceMs: HUMAN_PENDING_MS,
      alerts: alerts.slice(-25),
    }
  }

  function readWidget() {
    const stat = fs.statSync(WIDGET_FILE)
    if (widgetCache.mtimeMs !== stat.mtimeMs) {
      widgetCache = { mtimeMs: stat.mtimeMs, text: fs.readFileSync(WIDGET_FILE, 'utf8') }
    }
    return widgetCache.text
  }

  // ------------------------------------------------------------------- 路由

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/state.json`,
    handler: (req, res) => {
      try {
        sendJson(res, 200, statePayload())
      } catch (err) {
        sendJson(res, 200, { ok: false, error: String((err && err.message) || err).slice(0, 200) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/health.json`,
    handler: (req, res) => {
      sendJson(res, 200, {
        ok: true,
        plugin: name,
        build: 2,
        packageRoot: PACKAGE_ROOT,
        widgetFile: WIDGET_FILE,
        widgetReadable: (() => { try { return fs.statSync(WIDGET_FILE).size > 0 } catch (err) { return false } })(),
        seq,
        alerts: alerts.length,
        streams: streams.size,
      })
    },
  }))

  // SSE：隐藏标签页里 setInterval 会被浏览器节流，而网络事件不会，
  // 所以实时提醒必须以 SSE 为主、轮询为辅（页面两者都挂，按 seq 去重）。
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/events`,
    handler: (req, res) => {
      try {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Access-Control-Allow-Origin': '*',
        })
        res.write(': connected\n\n')
        res.write(`retry: 2000\nevent: snapshot\ndata: ${JSON.stringify(statePayload())}\n\n`)

        const stream = { res }
        streams.add(stream)
        const ping = setInterval(() => {
          try {
            res.write(': ping\n\n')
          } catch (err) {}
        }, SSE_PING_MS)
        if (ping && typeof ping.unref === 'function') ping.unref()

        const cleanup = () => {
          clearInterval(ping)
          streams.delete(stream)
        }
        req.on('close', cleanup)
        req.on('error', cleanup)
        res.on('close', cleanup)
        res.on('error', cleanup)
      } catch (err) {
        try { res.end() } catch (ignored) {}
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/test.json`,
    handler: (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'use POST' })
        return
      }
      try {
        const kind = /kind=question/i.test(String(req.url || '')) ? 'question' : 'approval'
        const entry = kind === 'question'
          ? record({
            kind,
            title: '需要你选择',
            callId: null,
            count: 1,
            sessionId: null,
            synthetic: true,
            questions: [{
              header: '模拟提醒',
              question: '这是一条模拟的选择请求，用来验证提示音和提醒卡片。',
              multiSelect: false,
              intent: null,
              options: ['选项 A', '选项 B', '选项 C'],
            }],
          })
          : record({
            kind,
            title: '需要你授权',
            toolName: '模拟工具',
            callId: null,
            reason: '这是一条模拟的授权请求，用来验证提示音和提醒卡片。',
            sessionId: null,
            synthetic: true,
          })
        const ttl = setTimeout(() => resolve(entry, 'allowed-once'), TEST_TTL_MS)
        if (ttl && typeof ttl.unref === 'function') ttl.unref()
        sendJson(res, 200, { ok: true, seq: entry.seq, kind })
      } catch (err) {
        sendJson(res, 200, { ok: false, error: String((err && err.message) || err).slice(0, 200) })
      }
    },
  }))

  // 页面脚本每次请求重新读盘：改 lib/widget.js 后只需刷新页面，无需重载插件。
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/alert.js`,
    handler: (req, res) => {
      try {
        const text = readWidget()
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': String(Buffer.byteLength(text)),
        })
        res.end(text)
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(`sound-alert widget unavailable: ${String((err && err.message) || err)}`)
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/ack.json`,
    handler: (req, res) => {
      // 页面点掉卡片时上报，宿主据此记住「已看过」水位（仅用于诊断展示）。
      try {
        const upto = Number(new URL(String(req.url || '/'), 'http://localhost').searchParams.get('upto'))
        if (Number.isFinite(upto) && upto > dismissedUpTo) dismissedUpTo = upto
      } catch (err) {}
      sendJson(res, 200, { ok: true, dismissedUpTo })
    },
  }))

  disposers.push(ctx.webServer.tapIndex((html) => {
    if (typeof html !== 'string') return html
    if (html.indexOf(`${BASE}/alert.js`) !== -1) return html
    if (html.indexOf('</body>') !== -1) return html.replace('</body>', `${SCRIPT_TAG}</body>`)
    return html + SCRIPT_TAG
  }))

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose() } catch (err) {}
    }
    for (const stream of Array.from(streams)) {
      try { stream.res.end() } catch (err) {}
    }
    streams.clear()
  }, 'dsh-sound-alert: routes')
}
