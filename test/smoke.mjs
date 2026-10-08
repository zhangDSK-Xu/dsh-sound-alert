/**
 * 最小 DOM 冒烟测试：在 Node 里用一个极简 DOM 桩把 lib/widget.js 真正跑起来，
 * 覆盖「启动 → 收到提醒 → 弹卡片 → 开设置面板 → 切四角 → 关面板」这条主路径，
 * 用来抓拼写错误、未定义函数、属性访问错位这类只会在浏览器控制台暴露的问题。
 *
 * 用法： node test/smoke.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WIDGET = path.join(HERE, '..', 'lib', 'widget.js')

let failures = 0
function check(label, condition, extra) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${extra === undefined ? '' : ' → ' + extra}`)
  }
}

function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    attrs: {},
    listeners: {},
    textContent: '',
    title: '',
    type: '',
    value: '',
    checked: false,
    rows: 0,
    spellcheck: true,
    min: '',
    max: '',
    step: '',
    hidden: false,
    __classes: [],
    appendChild(child) {
      child.parentNode = node
      node.children.push(child)
      return child
    },
    removeChild(child) {
      node.children = node.children.filter((item) => item !== child)
      child.parentNode = null
      return child
    },
    setAttribute(key, value) {
      node.attrs[key] = value
    },
    getAttribute(key) {
      return node.attrs[key]
    },
    addEventListener(type, fn) {
      ;(node.listeners[type] ||= []).push(fn)
    },
    removeEventListener(type, fn) {
      node.listeners[type] = (node.listeners[type] || []).filter((item) => item !== fn)
    },
    dispatch(type, event) {
      // 真实 DOM 会从目标向上冒泡，dock 上的 pointerdown/pointerup 才会收到子按钮的事件。
      let stopped = false
      const ev = Object.assign(
        {
          type,
          target: node,
          preventDefault() {},
          stopPropagation() {
            stopped = true
          },
          button: 0,
        },
        event,
      )
      let cursor = node
      while (cursor && !stopped) {
        for (const fn of (cursor.listeners[type] || []).slice()) fn(ev)
        cursor = cursor.parentNode
      }
    },
    contains(other) {
      if (other === node) return true
      return node.children.some((child) => child.contains(other))
    },
    getBoundingClientRect() {
      // 让桩rect反映拖动写入的 inline left/top，否则吸附判定永远停在初始位置。
      const set = (value, fallback) =>
        value === undefined || value === '' || value === 'auto' ? fallback : parseFloat(value)
      const left = set(node.style.left, 12)
      const top = set(node.style.top, 844)
      return { left, top, right: left + 63, bottom: top + 28, width: 63, height: 28 }
    },
    get firstChild() {
      return node.children[0] || null
    },
  }
  Object.defineProperty(node, 'className', {
    get() {
      return node.__classes.join(' ')
    },
    set(value) {
      node.__classes = String(value || '').split(/\s+/).filter(Boolean)
    },
  })
  node.classList = {
    add(name) {
      if (!node.__classes.includes(name)) node.__classes.push(name)
    },
    remove(name) {
      node.__classes = node.__classes.filter((item) => item !== name)
    },
    toggle(name, force) {
      const has = node.__classes.includes(name)
      const want = force === undefined ? !has : !!force
      if (want && !has) node.__classes.push(name)
      if (!want && has) node.__classes = node.__classes.filter((item) => item !== name)
    },
    contains(name) {
      return node.__classes.includes(name)
    },
  }
  return node
}

function find(node, predicate, out = []) {
  if (predicate(node)) out.push(node)
  for (const child of node.children) find(child, predicate, out)
  return out
}

const body = makeNode('body')
const head = makeNode('head')
const documentListeners = {}

const document = {
  head,
  body,
  title: 'DSH',
  readyState: 'complete',
  hidden: false,
  createElement: makeNode,
  createTextNode(text) {
    return { nodeType: 3, textContent: String(text), children: [], __classes: [], contains: () => false }
  },
  addEventListener(type, fn) {
    ;(documentListeners[type] ||= []).push(fn)
  },
  removeEventListener(type, fn) {
    documentListeners[type] = (documentListeners[type] || []).filter((item) => item !== fn)
  },
}

const storage = new Map()
const statePayload = {
  ok: true,
  seq: 1,
  alerts: [
    {
      seq: 1,
      ts: Date.now(),
      resolved: false,
      kind: 'approval',
      title: '需要你授权',
      toolName: 'write',
      callId: 'call_test',
      reason: '冒烟测试',
      sessionId: null,
    },
  ],
}

let fetchCalls = 0
/** 对端实例（19387）当成「没装插件」返回 404，才能只测同源那一路。 */
async function fetchStub(url, options) {
  const target = String(url)
  if (target.startsWith('http://127.0.0.1:19387')) return { ok: false, status: 404, json: async () => ({}) }
  fetchCalls += 1
  if (target.includes('/test.json')) return { ok: true, status: 200, json: async () => ({ ok: true }) }
  if (target.includes('/state.json')) return { ok: true, status: 200, json: async () => statePayload }
  return { ok: false, status: 404, json: async () => ({}) }
}

/** 递归收集节点文本，替代会被循环引用卡住的 JSON.stringify。 */
function textOf(node) {
  if (!node) return ''
  let out = String(node.textContent || '')
  for (const child of node.children || []) out += ' ' + textOf(child)
  return out
}

const windowListeners = {}
const windowStub = {
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener(type, fn) {
    ;(windowListeners[type] ||= []).push(fn)
  },
  removeEventListener(type, fn) {
    windowListeners[type] = (windowListeners[type] || []).filter((item) => item !== fn)
  },
}

const sandbox = {
  document,
  window: windowStub,
  location: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', href: 'http://127.0.0.1:3080/' },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
  },
  fetch: fetchStub,
  URL,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
}
sandbox.globalThis = sandbox

console.log('dsh-sound-alert widget smoke test')
const code = fs.readFileSync(WIDGET, 'utf8')

let error = null
try {
  vm.runInNewContext(code, sandbox, { filename: 'widget.js' })
} catch (err) {
  error = err
}
check('脚本可执行且无抛错', error === null, error && error.stack)

check('幂等守卫已置位', windowStub.__dshSoundAlert === true)
check('对外 API 已暴露', !!windowStub.__dshSoundAlertApi)

await new Promise((resolve) => setTimeout(resolve, 20))
await new Promise((resolve) => setTimeout(resolve, 20))

const dock = find(body, (node) => node.__classes.includes('dsa-dock'))[0]
check('已创建右下角停靠组', !!dock)
check('停靠组默认贴右下角', dock && dock.style.right === '12px' && dock.style.bottom === '12px', dock && JSON.stringify(dock.style))
check('未设置左上偏移', dock && dock.style.left === 'auto' && dock.style.top === 'auto')

const bellBtn = find(body, (node) => node.__classes.includes('dsa-bell'))[0]
const caretBtn = find(body, (node) => node.__classes.includes('dsa-caret'))[0]
check('铃铛按钮存在', !!bellBtn)
check('设置按钮存在', !!caretBtn)
check('铃铛初始可点击且已开音', bellBtn && bellBtn.textContent === '🔔', bellBtn && bellBtn.textContent)

const cards = find(body, (node) => node.__classes.includes('dsa-card'))
check('收到提醒后弹出了卡片', cards.length === 1, 'cards=' + cards.length)
const cardText = cards[0] ? textOf(cards[0]) : ''
check('卡片带授权标题', cardText.includes('需要你授权'), cardText.slice(0, 80))
check('卡片带工具名', cardText.includes('write'), cardText.slice(0, 80))
check('卡片带原因', cardText.includes('冒烟测试'), cardText.slice(0, 80))
check('卡片容器在右下角上方', find(body, (n) => n.__classes.includes('dsa-cards'))[0].style.bottom === '52px')
check('标题已加铃铛前缀', document.title.indexOf('🔔 ') === 0, JSON.stringify(document.title))
console.log('      卡片内容: ' + cardText.replace(/\s+/g, ' ').trim().slice(0, 120))

// 点「知道了」应停掉重复提醒并淡出卡片
const ack = find(cards[0], (node) => node.__classes.includes('dsa-ack'))[0]
check('卡片有「知道了」按钮', !!ack)
ack.dispatch('click')

// 打开设置面板
caretBtn.dispatch('click')
await new Promise((resolve) => setTimeout(resolve, 0))
const panel = find(body, (node) => node.__classes.includes('dsa-panel'))[0]
check('设置面板已打开', !!panel)
check('面板贴右下角', panel && panel.style.right === '12px' && panel.style.bottom === '52px', panel && JSON.stringify(panel.style))

const findChip = (container, text) =>
  find(container, (n) => n.__classes.includes('dsa-chip') && String(n.textContent) === text)[0]

check('面板内有铃铛位置分段选择', !!findChip(panel, '左上'))
findChip(panel, '左上').dispatch('click')
check('选「左上」后停靠组贴左上', dock.style.left === '12px' && dock.style.top === '12px', JSON.stringify(dock.style))
check('选中的分段有选中态', findChip(panel, '左上').__classes.includes('dsa-chip-on'))
check('切角后卡片容器跟随', find(body, (n) => n.__classes.includes('dsa-cards'))[0].style.left === '12px')

findChip(panel, '右上').dispatch('click')
const cardsHost = find(body, (n) => n.__classes.includes('dsa-cards'))[0]
check('右上角时卡片改为向下堆叠', cardsHost.style.flexDirection === 'column', cardsHost.style.flexDirection)
check('右上角时面板贴右上', panel.style.right === '12px' && panel.style.top === '52px', JSON.stringify(panel.style))

// 分段选择替代了原生 select：不会再弹出系统浅色列表
check('面板里已无原生 select', find(panel, (n) => n.tagName === 'SELECT').length === 0)

findChip(panel, '铃铛').dispatch('click')
check('点「铃铛」分段能切换提示音', windowStub.__dshSoundAlertApi.settings().tone === 'bell', windowStub.__dshSoundAlertApi.settings().tone)
findChip(panel, '叮咚').dispatch('click')
check('切回「叮咚」分段', windowStub.__dshSoundAlertApi.settings().tone === 'dingdong')

findChip(panel, '10 秒').dispatch('click')
check('点「10 秒」分段能改重复间隔', windowStub.__dshSoundAlertApi.settings().repeatMs === 10000, String(windowStub.__dshSoundAlertApi.settings().repeatMs))
findChip(panel, '不重复').dispatch('click')
check('点「不重复」分段能关掉重复', windowStub.__dshSoundAlertApi.settings().repeatMs === 0)

findChip(panel, '20 次').dispatch('click')
check('点「20 次」分段能改重复上限', windowStub.__dshSoundAlertApi.settings().repeatMax === 20, String(windowStub.__dshSoundAlertApi.settings().repeatMax))

// 拖动：超过阈值后应吸附到最近的角
const before = dock.style.left
dock.dispatch('pointerdown', { clientX: 70, clientY: 860, pointerId: 1 })
dock.dispatch('pointermove', { clientX: 700, clientY: 120, pointerId: 1 })
check('拖动中改用 left/top 跟手', dock.style.left !== 'auto' || before === '12px', JSON.stringify(dock.style))
dock.dispatch('pointerup', { clientX: 700, clientY: 120, pointerId: 1 })
check('松手后吸附到靠近的角（左上）', dock.style.left === '12px' && dock.style.top === '12px', JSON.stringify(dock.style))

// 关面板：面板外按下
documentListeners.pointerdown.forEach((fn) => fn({ target: makeNode('div') }))
check('点击面板外会关闭面板', !find(body, (node) => node.__classes.includes('dsa-panel')).length)

// 真实点击路径：指针在 ▾ 上按下、在 dock 上抬起。
// （指针捕获会把 click 重定向到 dock，子元素收不到 click，所以这条路径必须自己生效。）
caretBtn.dispatch('pointerdown', { clientX: 60, clientY: 858, pointerId: 7 })
dock.dispatch('pointerup', { clientX: 60, clientY: 858, pointerId: 7 })
await new Promise((resolve) => setTimeout(resolve, 0))
check('轻点 ▾ 能打开设置面板（pointerup 路径）', find(body, (n) => n.__classes.includes('dsa-panel')).length === 1)

caretBtn.dispatch('pointerdown', { clientX: 60, clientY: 858, pointerId: 8 })
dock.dispatch('pointerup', { clientX: 60, clientY: 858, pointerId: 8 })
await new Promise((resolve) => setTimeout(resolve, 0))
check('再次轻点 ▾ 能关闭设置面板', find(body, (n) => n.__classes.includes('dsa-panel')).length === 0)

// 轻点铃铛（同一路径）应切换开关，而不是打开面板
const enabledBefore = windowStub.__dshSoundAlertApi.settings().enabled
bellBtn.dispatch('pointerdown', { clientX: 30, clientY: 858, pointerId: 9 })
dock.dispatch('pointerup', { clientX: 30, clientY: 858, pointerId: 9 })
await new Promise((resolve) => setTimeout(resolve, 0))
check('轻点铃铛切换声音开关', windowStub.__dshSoundAlertApi.settings().enabled !== enabledBefore)
check('轻点铃铛不会误开面板', find(body, (n) => n.__classes.includes('dsa-panel')).length === 0)
bellBtn.dispatch('pointerdown', { clientX: 30, clientY: 858, pointerId: 10 })
dock.dispatch('pointerup', { clientX: 30, clientY: 858, pointerId: 10 })
await new Promise((resolve) => setTimeout(resolve, 0))
check('再次轻点铃铛恢复开关', windowStub.__dshSoundAlertApi.settings().enabled === enabledBefore)

// 校验设置持久化
const saved = JSON.parse(storage.get('dsh-sound-alert.settings.v1') || '{}')
check('设置已写入 localStorage', saved.bellCorner === 'tl', JSON.stringify(saved.bellCorner))
check('已发起轮询请求', fetchCalls > 0, 'calls=' + fetchCalls)

// ---------------------------------------------------------- 桌面端（dsh-app://app/）
// 桌面窗口来自 dsh-app://app/，页面通过 __DSH_TRANSPORT__.streamBaseUrl 拿到 Host 的
// origin（相对路径的流式请求会被 IPC 转发缓冲掉）。这里验证：
//   1) 请求一律改走该 origin；2) 不会把同一个 Host 又当成「额外实例」重复监听。
{
  const dBody = makeNode('body')
  const dHead = makeNode('head')
  const urls = []
  // 模拟「窗口最小化」：hidden=true、没有焦点，于是应当补一条系统通知。
  const nativeNotes = []
  class StubNotification {
    constructor(title, options) {
      this.title = title
      this.options = options || {}
      this.closed = false
      nativeNotes.push(this)
    }
    close() {
      this.closed = true
    }
  }
  StubNotification.permission = 'granted'
  const dWindow = { innerWidth: 1440, innerHeight: 900, addEventListener() {}, removeEventListener() {}, focus() {} }
  const dSandbox = {
    __DSH_TRANSPORT__: { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:19387' },
    Notification: StubNotification,
    document: {
      head: dHead,
      body: dBody,
      title: 'DSH',
      readyState: 'complete',
      hidden: true,
      hasFocus: () => false,
      createElement: makeNode,
      createTextNode(text) {
        return { nodeType: 3, textContent: String(text), children: [], __classes: [], contains: () => false }
      },
      addEventListener() {},
      removeEventListener() {},
    },
    window: dWindow,
    location: { origin: 'dsh-app://app', host: 'app', href: 'dsh-app://app/' },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: async (url) => {
      urls.push(String(url))
      const alerts = String(url).includes('127.0.0.1:19387')
        ? [{
          seq: 1,
          ts: Date.now(),
          resolved: false,
          kind: 'approval',
          title: '需要你授权',
          toolName: 'write',
          reason: '系统通知冒烟测试',
        }]
        : []
      return { ok: true, status: 200, json: async () => ({ ok: true, seq: alerts.length, alerts }) }
    },
    URL,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
  }
  dSandbox.globalThis = dSandbox
  vm.runInNewContext(code, dSandbox, { filename: 'widget.desktop.js' })
  await new Promise((resolve) => setTimeout(resolve, 20))

  const desktopSources = Object.keys(dWindow.__dshSoundAlertApi.sources())
  check('桌面端：本页实例走 Host origin', desktopSources.includes('local'))
  check(
    '桌面端：不会把同一个 Host 重复算作额外实例',
    !desktopSources.includes('http://127.0.0.1:19387'),
    JSON.stringify(desktopSources),
  )
  check(
    '桌面端：额外来源只剩真正不同的实例',
    desktopSources.length === 2 && desktopSources.includes('http://127.0.0.1:3080'),
    JSON.stringify(desktopSources),
  )
  check(
    '桌面端：本页实例的请求指向 Host origin',
    urls.includes('http://127.0.0.1:19387/dsh-sound-alert/state.json'),
    urls.slice(0, 3).join(' , ') || '(无请求)',
  )
  check(
    '桌面端：对端来源用自己的 origin，不叠加 Host 基址',
    urls.some((u) => u.startsWith('http://127.0.0.1:3080/dsh-sound-alert/')),
    urls.join(' , '),
  )

  // 系统通知：窗口最小化时也要弹在屏幕上
  check('桌面端：窗口最小化时弹了系统通知', nativeNotes.length === 1, 'notes=' + nativeNotes.length)
  const note = nativeNotes[0]
  check('通知标题标明是授权请求', note && note.title === 'DSH 需要你授权', note && note.title)
  check(
    '通知正文带工具名与原因',
    note && String(note.options.body).includes('write') && String(note.options.body).includes('系统通知冒烟测试'),
    note && note.options.body,
  )
  check('通知用 silent 避免和插件提示音重复响', note && note.options.silent === true, String(note && note.options.silent))
  check('通知带 tag，同一条提醒不会重复弹', note && note.options.tag === 'local#1', String(note && note.options.tag))
}

console.log(failures === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
