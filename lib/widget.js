/**
 * dsh-sound-alert — 页面脚本（Client half）
 * ============================================================================
 * 由宿主插件通过 tapIndex 注入到 DSH Web 页面：
 *   <script defer src="/dsh-sound-alert/alert.js"></script>
 *
 * 职责：
 *   1. 通过 SSE（/dsh-sound-alert/events）实时接收「需要授权 / 需要选择」提醒，
 *      并用 1s～4s 轮询 /dsh-sound-alert/state.json 兜底（隐藏标签页里定时器会被
 *      浏览器节流，而网络事件不会，所以 SSE 是主通道）。两路按 seq 去重。
 *   2. 播放提示音（Web Audio 合成，无需音频文件），弹出提醒卡片，闪烁标题。
 *   3. 在用户尚未处理时按设定间隔重复提醒，直到：请求被应答 / 用户操作了页面 /
 *      卡片被点掉 / 达到重复上限。
 *   4. 左下角小铃铛 + 设置面板（开关、音色、音量、重复策略、试听、模拟提醒）。
 *
 * 全部动态文本都用 textContent 写入，避免把工具名/问题正文当 HTML 解析。
 */

(function () {
  'use strict'

  if (window.__dshSoundAlert) return
  window.__dshSoundAlert = true

  var BASE = '/dsh-sound-alert'

  /**
   * 连接基址。
   *
   * Web（dsh web）页面本身就是 Host 发出来的，相对路径即可。
   * 桌面端窗口来自 `dsh-app://app/`：非 dist 路径会被转发给 Host（所以 fetch 用相对
   * 路径也行），但**流式响应走不了那条转发**，DSH 为此专门通过
   * `__DSH_TRANSPORT__.streamBaseUrl` 给出 Host 的 origin。这里统一取它，
   * 两个界面就都能连上（本插件路由不鉴权，且返回 `Access-Control-Allow-Origin: *`，
   * 因此跨源直连同样成立）。
   */
  var TRANSPORT = globalThis.__DSH_TRANSPORT__ || {}
  var HOST_BASE = typeof TRANSPORT.streamBaseUrl === 'string' && TRANSPORT.streamBaseUrl !== ''
    ? String(TRANSPORT.streamBaseUrl).replace(/\/+$/, '')
    : ''

  function endpoint(path) {
    return HOST_BASE + BASE + path
  }

  /**
   * 某个来源上某个路由的完整地址。
   * 本页实例走 {@link endpoint}（桌面端因此指向 Host origin）；
   * 额外来源是别的 DSH 实例，直接用自己的 origin，不能叠加 HOST_BASE。
   */
  function urlFor(source, path) {
    return source.key === 'local' ? endpoint(path) : source.base + BASE + path
  }

  var STORE_KEY = 'dsh-sound-alert.settings.v1'
  var POLL_MS = 4000
  /** 一个来源连续失败多少次后进入休眠（仅对额外来源）。 */
  var SOURCE_FAIL_LIMIT = 4
  /** 休眠来源的重试间隔。 */
  var SOURCE_RETRY_MS = 5 * 60 * 1000
  /** 本机常常同时跑多个 DSH 实例（例如 dsh web 与桌面端各占一个端口），
   *  而「需要你授权/选择」的事件只由跑着那个会话的实例发出。默认把这两个常见
   *  地址一并纳入监听，任一实例找你都会响。可在设置面板里增删。 */
  var AUTO_PEERS = ['http://127.0.0.1:3080', 'http://127.0.0.1:19387']
  /** 页面刚打开时，多久以内的未决提醒仍然值得响一次（避免刷新后漏提醒）。 */
  var LOAD_GRACE_MS = 45000
  /** 超过这个时长的未决提醒视为陈旧，不再驱动重复提醒。 */
  var PENDING_TTL_MS = 10 * 60 * 1000
  /** 卡片自动消失时间。 */
  var CARD_TTL_MS = 30000
  var MAX_CARDS = 3
  var TITLE_FLAG = '🔔 '

  var DEFAULTS = {
    enabled: true,
    volume: 0.6,
    tone: 'dingdong',
    repeatMs: 5000,
    repeatMax: 10,
    toast: true,
    flashTitle: true,
    peers: AUTO_PEERS.slice(),
    /** 铃铛停靠的角：br 右下（默认）/ bl 左下 / tr 右上 / tl 左上。 */
    bellCorner: 'br',
    /** 系统通知：窗口最小化 / 不在前台时也弹在屏幕上（桌面端为 Windows 通知）。 */
    desktopNotify: true,
  }

  var TONES = {
    ding: { label: '叮（单音）', chip: '叮', notes: [[880, 0, 0.45]] },
    dingdong: { label: '叮咚（默认）', chip: '叮咚', notes: [[988, 0, 0.26], [740, 0.19, 0.55]] },
    ascending: { label: '三连升调', chip: '三连升调', notes: [[660, 0, 0.16], [880, 0.15, 0.16], [1320, 0.3, 0.42]] },
    bell: { label: '铃铛', chip: '铃铛', notes: [[1046, 0, 1.1], [1568, 0.02, 0.8], [2093, 0.03, 0.5]] },
    alarm: { label: '急促警报', chip: '警报', notes: [[1000, 0, 0.13], [1000, 0.19, 0.13], [1000, 0.38, 0.13], [1000, 0.57, 0.13]] },
  }

  var REPEAT_CHOICES = [
    ['0', '不重复'],
    ['3000', '3 秒'],
    ['5000', '5 秒'],
    ['8000', '8 秒'],
    ['10000', '10 秒'],
    ['15000', '15 秒'],
    ['30000', '30 秒'],
  ]
  var MAX_CHOICES = [1, 3, 5, 10, 20, 50]

  // ------------------------------------------------------------------ 设置

  function loadSettings() {
    var saved = {}
    try {
      saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}
    } catch (err) {
      saved = {}
    }
    var out = {}
    for (var key in DEFAULTS) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue
      out[key] = Object.prototype.hasOwnProperty.call(saved, key) ? saved[key] : DEFAULTS[key]
    }
    out.volume = clamp01(Number(out.volume))
    if (!TONES[out.tone]) out.tone = DEFAULTS.tone
    out.repeatMs = Math.max(0, Number(out.repeatMs) || 0)
    out.repeatMax = Math.max(1, Number(out.repeatMax) || DEFAULTS.repeatMax)
    out.enabled = out.enabled !== false
    out.toast = out.toast !== false
    out.flashTitle = out.flashTitle !== false
    if (!Array.isArray(out.peers)) out.peers = DEFAULTS.peers.slice()
    if (['br', 'bl', 'tr', 'tl'].indexOf(out.bellCorner) === -1) out.bellCorner = DEFAULTS.bellCorner
    out.desktopNotify = out.desktopNotify !== false
    return out
  }

  /** 归一化一个「额外监听的 DSH 地址」，得到 origin；非法输入返回空。 */
  function normalizePeer(raw) {
    var text = String(raw === undefined || raw === null ? '' : raw).trim()
    if (!text) return ''
    if (!/^https?:\/\//i.test(text)) text = 'http://' + text
    try {
      return new URL(text).origin
    } catch (err) {
      return ''
    }
  }

  /** 需要额外监听的来源（去掉与本页同源的、去掉重复的）。 */
  function peerOrigins() {
    var out = []
    var list = Array.isArray(settings.peers) ? settings.peers : []
    for (var i = 0; i < list.length; i += 1) {
      var origin = normalizePeer(list[i])
      // HOST_BASE 指向的就是本页实例（桌面端页面来自 dsh-app://app/，
      // 但实际连的是 Host），不能既算 local 又算对端，否则同一条提醒会响两次。
      if (!origin || origin === location.origin || origin === HOST_BASE) continue
      if (out.indexOf(origin) === -1) out.push(origin)
    }
    return out
  }

  function clamp01(value) {
    if (!isFinite(value)) return DEFAULTS.volume
    return Math.min(1, Math.max(0, value))
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(settings))
    } catch (err) {}
  }

  var settings = loadSettings()

  // ------------------------------------------------------------ 提示音引擎

  var audioCtx = null
  var everInteracted = false
  var missedWhileLocked = 0

  function audioContext() {
    if (audioCtx) return audioCtx
    var Ctor = window.AudioContext || window.webkitAudioContext
    if (!Ctor) return null
    try {
      audioCtx = new Ctor()
    } catch (err) {
      audioCtx = null
    }
    return audioCtx
  }

  /** 播放一段合成提示音；返回是否真的发出了声音。 */
  function playTone() {
    if (!settings.enabled) return false
    var volume = clamp01(Number(settings.volume))
    if (volume <= 0) return false
    var ac = audioContext()
    if (!ac) return false
    if (ac.state === 'suspended') {
      try { ac.resume() } catch (err) {}
    }
    if (!everInteracted && ac.state !== 'running') {
      // 浏览器自动播放策略：还没有用户手势，先把这次提醒记账，等手势到来补响。
      missedWhileLocked += 1
      return false
    }
    var spec = TONES[settings.tone] || TONES[DEFAULTS.tone]
    var start = ac.currentTime + 0.02
    var master = ac.createGain()
    master.gain.value = 1
    master.connect(ac.destination)
    for (var i = 0; i < spec.notes.length; i += 1) {
      var note = spec.notes[i]
      var freq = note[0]
      var offset = note[1]
      var duration = note[2]
      var osc = ac.createOscillator()
      var gain = ac.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      var t0 = start + offset
      var peak = Math.max(0.0001, 0.85 * volume)
      gain.gain.setValueAtTime(0.0001, t0)
      gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)
      osc.connect(gain)
      gain.connect(master)
      osc.start(t0)
      osc.stop(t0 + duration + 0.06)
    }
    return true
  }

  function unlockAudio() {
    everInteracted = true
    var ac = audioContext()
    if (ac && ac.state === 'suspended') {
      try { ac.resume() } catch (err) {}
    }
    if (missedWhileLocked > 0) {
      missedWhileLocked = 0
      playTone()
    }
  }

  // -------------------------------------------------------------- 提醒状态

  // 提醒的唯一标识是「来源#seq」：本机每个 DSH 实例各自从 1 开始编号，
  // 只按 seq 去重会把不同实例的提醒混在一起。
  var seen = {}          // id -> true，已处理过的提醒
  var seenCount = 0
  var pending = {}       // id -> alert，未决（宿主判定尚未被应答）
  var pendingCount = 0
  var cards = {}         // id -> DOM 节点
  var cardOrder = []
  var repeatTimer = null
  var repeatDone = 0
  var alarmActive = false

  function alertId(sourceKey, alert) {
    return sourceKey + '#' + alert.seq
  }

  /** 给提醒打上来源与唯一 id（就地修改宿主返回的对象）。 */
  function annotate(alert, source) {
    alert.__id = alertId(source.key, alert)
    alert.__source = source.key
    alert.__label = source.key === 'local' ? location.host : source.key.replace(/^https?:\/\//, '')
    return alert
  }

  function pruneSeen() {
    if (seenCount <= 500) return
    seen = {}
    seenCount = 0
  }

  function refreshPendingMeta() {
    pendingCount = Object.keys(pending).length
    applyTitleFlag(pendingCount > 0 && settings.flashTitle)
  }

  function setPending(alert) {
    if (!alert || !alert.__id) return
    if (alert.resolved) {
      if (pending[alert.__id]) {
        delete pending[alert.__id]
        fadeCard(alert.__id)
      }
    } else {
      pending[alert.__id] = alert
    }
    refreshPendingMeta()
  }

  /** 用某个来源的快照重建该来源的未决集合（丢弃已解除与陈旧的）。 */
  function syncPendingFromList(list, source) {
    var next = {}
    var now = Date.now()
    for (var i = 0; i < list.length; i += 1) {
      var alert = annotate(list[i], source)
      if (!alert || typeof alert.seq !== 'number') continue
      if (alert.resolved) continue
      if (now - alert.ts > PENDING_TTL_MS) continue
      next[alert.__id] = alert
    }
    for (var id in pending) {
      if (pending[id].__source !== source.key) continue
      if (!Object.prototype.hasOwnProperty.call(next, id)) fadeCard(id)
    }
    for (var key in next) pending[key] = next[key]
    refreshPendingMeta()
  }

  /**
   * 处理一批提醒。
   * @param list - 提醒数组
   * @param source - 来源（'local' 或对端 origin）
   * @param bootstrap - 是否是该来源的第一份快照
   */
  function handleAlerts(list, source, bootstrap) {
    if (!Array.isArray(list)) return
    var now = Date.now()
    var fresh = []
    for (var i = 0; i < list.length; i += 1) {
      var alert = list[i]
      if (!alert || typeof alert.seq !== 'number') continue
      annotate(alert, source)
      // maxSeq 让去重在 seen 被裁剪后依然成立，避免旧提醒被当成新提醒重响。
      var known = seen[alert.__id] === true || alert.seq <= (source.maxSeq || 0)
      if (alert.seq > (source.maxSeq || 0)) source.maxSeq = alert.seq
      if (known) {
        setPending(alert)
        continue
      }
      seen[alert.__id] = true
      seenCount += 1
      setPending(alert)
      if (bootstrap) {
        // 首次快照只补报「刚刚发生、且还没被处理」的提醒，避免刷新页面时重复响。
        if (!alert.resolved && now - alert.ts <= LOAD_GRACE_MS) fresh.push(alert)
      } else {
        fresh.push(alert)
      }
    }
    pruneSeen()
    if (fresh.length === 0) {
      reconcileAlarm()
      return
    }
    // 响铃优先：即使某张卡片渲染失败，也必须响，并且不能影响其它卡片与后续轮询。
    try {
      startAlarm()
    } catch (err) {}
    for (var j = 0; j < fresh.length; j += 1) {
      try {
        showCard(fresh[j])
      } catch (err) {}
      try {
        notifyNative(fresh[j])
      } catch (err) {}
    }
  }

  function reconcileAlarm() {
    if (pendingCount === 0 && !hasCards()) stopAlarm()
  }

  function hasCards() {
    return cardOrder.length > 0
  }

  // ------------------------------------------------------------ 重复提醒

  function startAlarm() {
    stopAlarm()
    alarmActive = true
    repeatDone = 0
    renderBell()
    playTone()
    scheduleRepeat()
  }

  function scheduleRepeat() {
    var every = Math.max(0, Number(settings.repeatMs) || 0)
    if (every <= 0) return
    repeatTimer = setTimeout(function () {
      repeatTimer = null
      if (!alarmActive) return
      if (pendingCount === 0) return stopAlarm()
      repeatDone += 1
      if (repeatDone >= Math.max(1, Number(settings.repeatMax) || 1)) return stopAlarm()
      playTone()
      scheduleRepeat()
    }, every)
  }

  function stopAlarm() {
    alarmActive = false
    if (repeatTimer) {
      clearTimeout(repeatTimer)
      repeatTimer = null
    }
    renderBell()
  }

  /** 用户明确知道了：停止重复，并清掉卡片。 */
  function acknowledge(id) {
    stopAlarm()
    if (typeof id === 'string' && id) {
      fadeCard(id)
      return
    }
    var ids = cardOrder.slice()
    for (var i = 0; i < ids.length; i += 1) fadeCard(ids[i])
  }

  // ---------------------------------------------------------- 系统通知

  /** 浏览器/Electron 是否提供通知能力。 */
  function notificationApi() {
    return typeof Notification === 'function' ? Notification : null
  }

  /** 通知能力的当前状态。 */
  function nativeNotifyState() {
    var api = notificationApi()
    return { hasApi: !!api, permission: api ? String(api.permission) : 'none' }
  }

  var lastNotifyResult = ''

  /**
   * 把页面侧的通知状态上报给宿主，随 `/dsh-sound-alert/health.json` 回读。
   * 这样在看不到浏览器控制台（桌面端）时也能定位「通知没弹出来」。
   *
   * 注意：刻意不带 `Content-Type: application/json` —— 那会触发 CORS 预检，
   * 而跨源直连 Host 时预检没有对应的 OPTIONS 处理。默认的 text/plain 属于
   * CORS 安全列表类型，不需要预检。
   */
  function reportDiag(extra) {
    try {
      var state = nativeNotifyState()
      var payload = {
        hasApi: state.hasApi,
        permission: state.permission,
        enabled: !!settings.desktopNotify,
        hidden: document.hidden === true,
        focused: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
        visibility: String(document.visibilityState || ''),
        href: String(location.href || ''),
      }
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) payload[key] = extra[key]
      }
      lastNotifyResult = String(payload.attempt || '') + (payload.error ? ' ' + payload.error : '')
      fetch(endpoint('/diag.json'), { method: 'POST', body: JSON.stringify(payload) }).catch(function () {})
    } catch (err) {}
  }

  /** 把一条提醒弹成系统通知（桌面端即 Windows 通知，最小化也能看见）。 */
  function notifyNative(alert) {
    if (!settings.desktopNotify) return
    var state = nativeNotifyState()
    if (!state.hasApi || state.permission !== 'granted') {
      reportDiag({ attempt: 'skipped', reason: state.hasApi ? state.permission : 'no-api' })
      return
    }
    try {
      var isQuestion = alert.kind === 'question'
      var lines = []
      if (isQuestion) {
        var questions = Array.isArray(alert.questions) ? alert.questions : []
        for (var i = 0; i < questions.length && i < 3; i += 1) {
          var q = questions[i] || {}
          lines.push((q.header ? q.header + '：' : '') + (q.question || ''))
          if (q.options && q.options.length) lines.push('选项：' + q.options.join(' / '))
        }
      } else {
        lines.push('工具：' + (alert.toolName || '未知工具'))
        if (alert.reason) lines.push(alert.reason)
      }
      var body = lines.filter(Boolean).join('\n')
      if (body.length > 220) body = body.slice(0, 220) + '…'
      showNotification(isQuestion ? 'DSH 需要你选择' : 'DSH 需要你授权', body, alert.__id || 'dsh-sound-alert', 'alert')
    } catch (err) {
      reportDiag({ attempt: 'error', error: String((err && err.message) || err).slice(0, 200) })
    }
  }

  /** 真正构造一条系统通知，并把结果上报。 */
  function showNotification(title, body, tag, attempt) {
    try {
      // silent：声音由插件自己的提示音负责，避免系统通知再响一次。
      var note = new Notification(title, { body: body, tag: tag, silent: true })
      note.onclick = function () {
        try { window.focus() } catch (err) {}
        try { note.close() } catch (err) {}
      }
      reportDiag({ attempt: attempt + '-shown', title: title, tag: tag })
      return true
    } catch (err) {
      reportDiag({ attempt: attempt + '-error', error: String((err && err.message) || err).slice(0, 200) })
      return false
    }
  }

  /** 权限还是 default 时申请一次（浏览器会要求用户手势，所以放在首次交互后）。 */
  function requestNotifyPermission() {
    try {
      var api = notificationApi()
      if (!api || api.permission !== 'default') return
      var result = api.requestPermission()
      if (result && typeof result.then === 'function') result.then(function () {}, function () {})
    } catch (err) {}
  }

  /** 只把本实例（同源）的已看水位回报给本实例宿主。 */
  function reportAck() {
    try {
      var maxSeq = 0
      for (var id in seen) {
        if (id.indexOf('local#') !== 0) continue
        var n = Number(id.slice(6))
        if (isFinite(n) && n > maxSeq) maxSeq = n
      }
      if (maxSeq > 0) fetch(endpoint('/ack.json') + '?upto=' + maxSeq, { method: 'POST' }).catch(function () {})
    } catch (err) {}
  }

  // ------------------------------------------------------------ 标题闪烁

  var titleBase = null

  function applyTitleFlag(on) {
    if (on) {
      var current = document.title || ''
      if (current.indexOf(TITLE_FLAG) !== 0) {
        titleBase = current
        document.title = TITLE_FLAG + current
      }
    } else if ((document.title || '').indexOf(TITLE_FLAG) === 0) {
      document.title = document.title.slice(TITLE_FLAG.length)
      titleBase = null
    }
  }

  // -------------------------------------------------------------- 样式与 DOM

  var CSS = [
    '.dsa-root{position:fixed;z-index:9500;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;}',
    '.dsa-cards{position:fixed;z-index:9500;display:flex;gap:8px;max-width:380px;}',
    '.dsa-card{background:rgba(22,26,38,.97);color:#eef2ff;border:1px solid rgba(122,152,255,.45);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.35);padding:10px 12px;font-size:13px;line-height:1.5;opacity:0;transform:translateY(8px);transition:opacity .18s ease,transform .18s ease;}',
    '.dsa-card.dsa-in{opacity:1;transform:translateY(0);}',
    '.dsa-card.dsa-out{opacity:0;transform:translateY(8px);}',
    '.dsa-head{display:flex;align-items:center;gap:6px;margin-bottom:4px;}',
    '.dsa-badge{font-size:11px;padding:1px 6px;border-radius:6px;background:#3b5bdb;color:#fff;flex:0 0 auto;}',
    '.dsa-badge.dsa-q{background:#0f7b6c;}',
    '.dsa-title{font-weight:600;}',
    '.dsa-src{margin-left:auto;color:#93a4d8;font-size:10.5px;flex:0 0 auto;}',
    '.dsa-peerbox{margin-top:8px;}',
    '.dsa-peerbox textarea{width:100%;box-sizing:border-box;resize:vertical;background:#1b2130;color:#eef2ff;border:1px solid rgba(140,165,255,.35);border-radius:7px;padding:5px 7px;font-size:11.5px;font-family:ui-monospace,Consolas,monospace;}',
    '.dsa-row{color:#c7d2fe;word-break:break-word;}',
    '.dsa-row b{color:#fff;font-weight:600;}',
    '.dsa-opt{color:#a5b4fc;}',
    '.dsa-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px;}',
    '.dsa-time{color:#93a4d8;font-size:11px;}',
    '.dsa-ack{cursor:pointer;border:1px solid rgba(140,165,255,.5);background:transparent;color:#dbe4ff;border-radius:8px;padding:3px 10px;font-size:12px;}',
    '.dsa-ack:hover{background:rgba(120,150,255,.18);}',
    '.dsa-dock{position:fixed;z-index:9510;display:flex;align-items:center;gap:3px;opacity:.32;transition:opacity .16s ease;touch-action:none;}',
    '.dsa-dock:hover{opacity:1;}',
    '.dsa-dock.dsa-dragging{opacity:1;transition:none;cursor:grabbing;}',
    '.dsa-bell{width:28px;height:28px;border-radius:50%;border:1px solid rgba(140,160,220,.45);background:rgba(22,26,38,.72);color:#cfd8ff;font-size:14px;line-height:1;cursor:pointer;transition:transform .16s ease;padding:0;}',
    '.dsa-bell:hover{transform:scale(1.08);}',
    '.dsa-bell.dsa-off{color:#8b93a8;}',
    '.dsa-bell.dsa-ring{animation:dsa-ring .9s ease-in-out infinite;}',
    '@keyframes dsa-ring{0%,100%{transform:rotate(0)}25%{transform:rotate(-14deg)}75%{transform:rotate(14deg)}}',
    '.dsa-caret{width:15px;height:22px;border-radius:6px;border:1px solid rgba(140,160,220,.35);background:rgba(22,26,38,.6);color:#cfd8ff;font-size:9px;line-height:1;cursor:pointer;padding:0;}',
    '.dsa-caret:hover{background:rgba(60,72,110,.8);}',
    '.dsa-panel{position:fixed;z-index:9520;width:270px;background:rgba(22,26,38,.98);color:#eef2ff;border:1px solid rgba(122,152,255,.4);border-radius:12px;box-shadow:0 14px 40px rgba(0,0,0,.4);padding:12px;font-size:12.5px;color-scheme:dark;}',
    '.dsa-panel h4{margin:0 0 8px;font-size:13px;font-weight:600;}',
    '.dsa-panel label{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:7px 0;color:#c7d2fe;}',
    '.dsa-panel input[type=range]{background:rgba(255,255,255,.06);border:1px solid rgba(140,165,255,.35);border-radius:7px;padding:0;width:130px;}',
    '.dsa-field{margin:9px 0;}',
    '.dsa-field-label{color:#c7d2fe;margin-bottom:5px;}',
    '.dsa-choice{display:flex;flex-wrap:wrap;gap:4px;}',
    '.dsa-chip{cursor:pointer;border:1px solid rgba(140,165,255,.35);background:rgba(255,255,255,.07);color:#dbe4ff;border-radius:7px;padding:3px 8px;font-size:11.5px;line-height:1.3;}',
    '.dsa-chip:hover{background:rgba(120,150,255,.22);}',
    '.dsa-chip.dsa-chip-on{background:#3b5bdb;border-color:#7c9cff;color:#fff;font-weight:600;}',
    '.dsa-actions{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;}',
    '.dsa-actions button{flex:1 1 auto;cursor:pointer;border:1px solid rgba(140,165,255,.45);background:transparent;color:#dbe4ff;border-radius:8px;padding:5px 8px;font-size:12px;}',
    '.dsa-actions button:hover{background:rgba(120,150,255,.18);}',
    '.dsa-hint{margin-top:8px;color:#8f9dc4;font-size:11px;line-height:1.45;}',
  ].join('')

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  var cardsHost = null
  var dock = null
  var bell = null
  var caret = null
  var panel = null

  // 停靠位置：默认右下角（`br`），可拖动吸附到任意一角并记住。
  var INSET = 12
  var DRAG_THRESHOLD_SQ = 25
  var pos = { corner: settings.bellCorner || 'br' }
  var dragState = null
  var lastDragAt = 0
  var lastActivateAt = 0

  function isRightCorner(corner) {
    return corner === 'br' || corner === 'tr'
  }

  function isBottomCorner(corner) {
    return corner === 'br' || corner === 'bl'
  }

  /** 用 left/top/right/bottom 像素表达「贴到某一角」：CSS 无法对 auto 做插值。 */
  function placeAtCorner(node, corner, gapX, gapY) {
    node.style.left = isRightCorner(corner) ? 'auto' : gapX + 'px'
    node.style.right = isRightCorner(corner) ? gapX + 'px' : 'auto'
    node.style.top = isBottomCorner(corner) ? 'auto' : gapY + 'px'
    node.style.bottom = isBottomCorner(corner) ? gapY + 'px' : 'auto'
  }

  /** 提醒卡片与设置面板都跟着铃铛所在的角走。 */
  function applyCorner() {
    if (dock) {
      dock.style.left = 'auto'
      dock.style.right = 'auto'
      dock.style.top = 'auto'
      dock.style.bottom = 'auto'
      placeAtCorner(dock, pos.corner, INSET, INSET)
    }
    if (cardsHost) {
      cardsHost.style.left = 'auto'
      cardsHost.style.right = 'auto'
      cardsHost.style.top = 'auto'
      cardsHost.style.bottom = 'auto'
      cardsHost.style.flexDirection = isBottomCorner(pos.corner) ? 'column-reverse' : 'column'
      placeAtCorner(cardsHost, pos.corner, INSET, INSET + 40)
    }
    if (panel) {
      panel.style.left = 'auto'
      panel.style.right = 'auto'
      panel.style.top = 'auto'
      panel.style.bottom = 'auto'
      // 面板比铃铛宽，靠左角时贴左，靠右角时贴右。
      var gapX = isRightCorner(pos.corner) ? INSET : INSET
      panel.style.width = Math.min(270, Math.max(220, window.innerWidth - INSET * 2)) + 'px'
      placeAtCorner(panel, pos.corner, gapX, INSET + 40)
    }
  }

  function snapCorner() {
    if (!dock) return
    var rect = dock.getBoundingClientRect()
    var horizontal = rect.left + rect.width / 2 < window.innerWidth / 2 ? 'l' : 'r'
    var vertical = rect.top + rect.height / 2 < window.innerHeight / 2 ? 't' : 'b'
    pos.corner = vertical + horizontal
    settings.bellCorner = pos.corner
    saveSettings()
    applyCorner()
  }

  /** 点一下铃铛：开关声音。 */
  function toggleEnabled() {
    settings.enabled = !settings.enabled
    saveSettings()
    renderBell()
    if (settings.enabled) playTone()
    if (panel) renderPanel()
  }

  /** 从按下的元素向内找到应该执行的动作（指针捕获会把 click 重定向到 dock，
   *  所以不能只依赖子元素自己的 click 处理器）。 */
  function activateFrom(node) {
    var cursor = node
    while (cursor) {
      if (cursor === caret) { openPanel(); return true }
      if (cursor === bell) { toggleEnabled(); return true }
      if (cursor === dock) return false
      cursor = cursor.parentNode
    }
    return false
  }

  /** pointerup 已经触发过动作时，抑制紧随其后的 click，避免一次点击执行两遍。 */
  function alreadyActivated() {
    return Date.now() - lastActivateAt < 500
  }

  /** 拖动整个停靠组：超过阈值才算拖动，否则交给 click。 */
  function enableDockDrag() {
    dock.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return
      // 注意：这里不能调用 setPointerCapture —— 一旦捕获，后续 click 会被重定向到
      // dock 本身，子按钮（🔔 / ▾）的 click 处理器就再也收不到了。只在真正开始拖动时捕获。
      dragState = {
        x: event.clientX,
        y: event.clientY,
        moved: false,
        id: event.pointerId,
        pressed: event.target,
      }
    })
    dock.addEventListener('pointermove', function (event) {
      if (!dragState) return
      var dx = event.clientX - dragState.x
      var dy = event.clientY - dragState.y
      if (!dragState.moved) {
        if (dx * dx + dy * dy < DRAG_THRESHOLD_SQ) return
        dragState.moved = true
        try { dock.setPointerCapture(dragState.id) } catch (err) {}
        dock.classList.add('dsa-dragging')
      }
      var rect = dock.getBoundingClientRect()
      var left = Math.min(Math.max(4, event.clientX - rect.width / 2), window.innerWidth - rect.width - 4)
      var top = Math.min(Math.max(4, event.clientY - rect.height / 2), window.innerHeight - rect.height - 4)
      dock.style.left = left + 'px'
      dock.style.top = top + 'px'
      dock.style.right = 'auto'
      dock.style.bottom = 'auto'
    })
    function endDrag(event) {
      if (!dragState) return
      var state = dragState
      dragState = null
      dock.classList.remove('dsa-dragging')
      try { dock.releasePointerCapture(state.id) } catch (err) {}
      if (state.moved) {
        lastDragAt = Date.now()
        snapCorner()
        return
      }
      // 没拖动 = 一次点击：直接用 pointerdown 的目标执行动作。
      // 这样即使 click 被指针捕获重定向，按钮依然可用。
      if (event.type === 'pointerup' && activateFrom(state.pressed)) lastActivateAt = Date.now()
    }
    dock.addEventListener('pointerup', endDrag)
    dock.addEventListener('pointercancel', endDrag)
    window.addEventListener('resize', function () { applyCorner() })
  }

  function ensureDom() {
    if (dock) return true
    if (!document.body) return false
    var style = document.createElement('style')
    style.setAttribute('data-dsh-sound-alert', '1')
    style.textContent = CSS
    document.head.appendChild(style)

    cardsHost = el('div', 'dsa-cards')
    document.body.appendChild(cardsHost)

    dock = el('div', 'dsa-dock')
    dock.title = '提醒音：左键开关声音 · ▾ 或右键打开设置 · 按住可拖到任意一角'

    bell = el('button', 'dsa-bell', '🔔')
    bell.type = 'button'
    bell.addEventListener('click', function (event) {
      if (alreadyActivated() || Date.now() - lastDragAt < 300) return
      if (event.altKey || event.shiftKey) return openPanel()
      toggleEnabled()
    })
    bell.addEventListener('contextmenu', function (event) {
      event.preventDefault()
      openPanel()
    })

    caret = el('button', 'dsa-caret', '▾')
    caret.type = 'button'
    caret.title = '提醒音设置'
    caret.addEventListener('click', function (event) {
      event.stopPropagation()
      if (alreadyActivated() || Date.now() - lastDragAt < 300) return
      openPanel()
    })

    dock.appendChild(bell)
    dock.appendChild(caret)
    document.body.appendChild(dock)
    enableDockDrag()
    applyCorner()

    renderBell()
    return true
  }

  function renderBell() {
    if (!bell) return
    bell.textContent = settings.enabled ? '🔔' : '🔕'
    bell.classList.toggle('dsa-off', !settings.enabled)
    var ring = alarmActive && pendingCount > 0
    bell.classList.toggle('dsa-ring', !!ring)
  }

  // ---------------------------------------------------------------- 卡片

  function showCard(alert) {
    if (!settings.toast) return
    if (!ensureDom()) return
    if (!alert.__id || cards[alert.__id]) return

    var card = el('div', 'dsa-card')
    card.setAttribute('data-alert-id', alert.__id)

    var head = el('div', 'dsa-head')
    var isQuestion = alert.kind === 'question'
    head.appendChild(el('span', 'dsa-badge' + (isQuestion ? ' dsa-q' : ''), isQuestion ? '选择' : '授权'))
    head.appendChild(el('span', 'dsa-title', alert.title || (isQuestion ? '需要你选择' : '需要你授权')))
    if (alert.__source !== 'local') {
      head.appendChild(el('span', 'dsa-src', '来自 ' + alert.__label))
    }
    card.appendChild(head)

    if (isQuestion) {
      var questions = Array.isArray(alert.questions) ? alert.questions : []
      for (var i = 0; i < questions.length; i += 1) {
        var q = questions[i] || {}
        var line = el('div', 'dsa-row')
        if (q.header) {
          line.appendChild(el('b', null, q.header + '：'))
        }
        line.appendChild(document.createTextNode(q.question || '（未提供问题文本）'))
        if (q.multiSelect) line.appendChild(el('span', 'dsa-opt', '（可多选）'))
        card.appendChild(line)
        if (q.options && q.options.length) {
          card.appendChild(el('div', 'dsa-row dsa-opt', '选项：' + q.options.join(' / ')))
        }
      }
      if (alert.count > questions.length) {
        card.appendChild(el('div', 'dsa-row dsa-opt', '还有 ' + (alert.count - questions.length) + ' 个问题…'))
      }
    } else {
      var toolLine = el('div', 'dsa-row')
      toolLine.appendChild(el('b', null, '工具：'))
      toolLine.appendChild(document.createTextNode(alert.toolName || '未知工具'))
      card.appendChild(toolLine)
      if (alert.reason) {
        var reasonLine = el('div', 'dsa-row')
        reasonLine.appendChild(el('b', null, '原因：'))
        reasonLine.appendChild(document.createTextNode(alert.reason))
        card.appendChild(reasonLine)
      }
    }

    var foot = el('div', 'dsa-foot')
    var ack = el('button', 'dsa-ack', '知道了')
    ack.type = 'button'
    ack.addEventListener('click', function (event) {
      event.stopPropagation()
      acknowledge(alert.__id)
      reportAck()
    })
    foot.appendChild(ack)
    foot.appendChild(el('span', 'dsa-time', formatTime(alert.ts)))
    card.appendChild(foot)

    cardsHost.appendChild(card)
    cards[alert.__id] = card
    cardOrder.push(alert.__id)
    while (cardOrder.length > MAX_CARDS) {
      var oldest = cardOrder.shift()
      removeCardNow(oldest)
    }
    requestAnimationFrame(function () { card.classList.add('dsa-in') })

    var ttl = setTimeout(function () { fadeCard(alert.__id) }, CARD_TTL_MS)
    card.__dsaTtl = ttl
  }

  function removeCardNow(id) {
    var card = cards[id]
    if (!card) return
    if (card.__dsaTtl) clearTimeout(card.__dsaTtl)
    if (card.parentNode) card.parentNode.removeChild(card)
    delete cards[id]
    var index = cardOrder.indexOf(id)
    if (index >= 0) cardOrder.splice(index, 1)
  }

  function fadeCard(id) {
    var card = cards[id]
    if (!card) return
    card.classList.add('dsa-out')
    setTimeout(function () { removeCardNow(id) }, 200)
  }

  function formatTime(ts) {
    try {
      var d = new Date(Number(ts) || Date.now())
      var pad = function (n) { return n < 10 ? '0' + n : String(n) }
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    } catch (err) {
      return ''
    }
  }

  // -------------------------------------------------------------- 设置面板

  function openPanel() {
    if (panel) return closePanel()
    if (!ensureDom()) return
    panel = el('div', 'dsa-panel')
    renderPanel()
    document.body.appendChild(panel)
    applyCorner()
    setTimeout(function () {
      document.addEventListener('pointerdown', onOutside, true)
    }, 0)
  }

  function closePanel() {
    document.removeEventListener('pointerdown', onOutside, true)
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel)
    panel = null
  }

  function onOutside(event) {
    if (!panel) return
    if (panel.contains(event.target)) return
    if (dock && dock.contains(event.target)) return
    closePanel()
  }

  function row(labelText, control) {
    var wrapper = el('label')
    wrapper.appendChild(el('span', null, labelText))
    wrapper.appendChild(control)
    return wrapper
  }

  /**
   * 自绘的分段选择，替代原生 <select>。
   *
   * 原生下拉的弹出列表由浏览器用「文档级」配色绘制（DSH 页面是浅色），而面板本身是深色，
   * 结果是白底列表 + 继承来的浅色文字 = 未选中项几乎不可见，且无法可靠地用 option CSS 修正。
   * 这里完全自绘，配色永远跟着面板走。
   *
   * @param labelText - 行标题
   * @param options - [[value, label], ...]
   * @param value - 当前值
   * @param onPick - 选中回调，参数是字符串值
   */
  function choiceField(labelText, options, value, onPick) {
    var field = el('div', 'dsa-field')
    field.appendChild(el('div', 'dsa-field-label', labelText))
    var group = el('div', 'dsa-choice')
    for (var i = 0; i < options.length; i += 1) {
      var chip = el(
        'button',
        'dsa-chip' + (String(options[i][0]) === String(value) ? ' dsa-chip-on' : ''),
        options[i][1],
      )
      chip.type = 'button'
      bindChip(chip, options[i][0], onPick)
      group.appendChild(chip)
    }
    field.appendChild(group)
    return field
  }

  function bindChip(chip, chipValue, onPick) {
    chip.addEventListener('click', function () {
      onPick(String(chipValue))
      renderPanel()
    })
  }

  function renderPanel() {
    if (!panel) return
    while (panel.firstChild) panel.removeChild(panel.firstChild)
    panel.appendChild(el('h4', null, '提醒音设置'))

    var toggle = el('input')
    toggle.type = 'checkbox'
    toggle.checked = !!settings.enabled
    toggle.addEventListener('change', function () {
      settings.enabled = toggle.checked
      saveSettings()
      renderBell()
      if (settings.enabled) playTone()
    })
    panel.appendChild(row('启用提醒音', toggle))

    var toneOptions = []
    for (var id in TONES) {
      if (!Object.prototype.hasOwnProperty.call(TONES, id)) continue
      toneOptions.push([id, TONES[id].chip])
    }
    panel.appendChild(choiceField('提示音', toneOptions, settings.tone, function (picked) {
      settings.tone = picked
      saveSettings()
      playTone()
    }))

    panel.appendChild(choiceField('铃铛位置', [
      ['br', '右下'],
      ['bl', '左下'],
      ['tr', '右上'],
      ['tl', '左上'],
    ], pos.corner, function (picked) {
      pos.corner = picked
      settings.bellCorner = picked
      saveSettings()
      applyCorner()
    }))

    var vol = el('input')
    vol.type = 'range'
    vol.min = '0'
    vol.max = '1'
    vol.step = '0.05'
    vol.value = String(settings.volume)
    vol.addEventListener('input', function () {
      settings.volume = clamp01(Number(vol.value))
    })
    vol.addEventListener('change', function () {
      saveSettings()
      playTone()
    })
    panel.appendChild(row('音量', vol))

    var repeatOptions = []
    for (var i = 0; i < REPEAT_CHOICES.length; i += 1) repeatOptions.push(REPEAT_CHOICES[i])
    panel.appendChild(choiceField('未处理时重复', repeatOptions, settings.repeatMs, function (picked) {
      settings.repeatMs = Number(picked) || 0
      saveSettings()
    }))

    var maxOptions = []
    for (var k = 0; k < MAX_CHOICES.length; k += 1) maxOptions.push([String(MAX_CHOICES[k]), MAX_CHOICES[k] + ' 次'])
    panel.appendChild(choiceField('重复上限', maxOptions, settings.repeatMax, function (picked) {
      settings.repeatMax = Number(picked) || DEFAULTS.repeatMax
      saveSettings()
    }))

    var toastOn = el('input')
    toastOn.type = 'checkbox'
    toastOn.checked = !!settings.toast
    toastOn.addEventListener('change', function () {
      settings.toast = toastOn.checked
      saveSettings()
    })
    panel.appendChild(row('弹出提醒卡片', toastOn))

    var titleOn = el('input')
    titleOn.type = 'checkbox'
    titleOn.checked = !!settings.flashTitle
    titleOn.addEventListener('change', function () {
      settings.flashTitle = titleOn.checked
      saveSettings()
      applyTitleFlag(pendingCount > 0 && settings.flashTitle)
    })
    panel.appendChild(row('标题闪烁提醒', titleOn))

    var notifyOn = el('input')
    notifyOn.type = 'checkbox'
    notifyOn.checked = !!settings.desktopNotify
    notifyOn.addEventListener('change', function () {
      settings.desktopNotify = notifyOn.checked
      saveSettings()
      if (settings.desktopNotify) requestNotifyPermission()
      renderPanel()
    })
    panel.appendChild(row('系统通知（最小化也可见）', notifyOn))

    var notifyApi = notificationApi()
    var notifyState = nativeNotifyState()
    var notifyHint = '收到提醒时同时弹一条系统通知（桌面端即 Windows 通知），最小化也能看见。'
    if (!notifyApi) notifyHint = '当前环境不提供 Notification，无法弹系统通知。'
    else if (notifyState.permission === 'denied') notifyHint = '系统通知已被拒绝：需要在 Windows 通知设置或浏览器站点设置里允许后再启用。'
    else if (notifyState.permission === 'default') notifyHint = '还没有通知权限：点一下页面任意位置会弹出授权请求（桌面端通常已默认授予）。'
    panel.appendChild(el('div', 'dsa-hint', notifyHint))
    panel.appendChild(el('div', 'dsa-hint', '通知能力：' + (notifyApi ? 'Notification 可用，permission=' + notifyState.permission : '不可用') + (lastNotifyResult ? '；最近一次：' + lastNotifyResult : '')))

    var notifyTest = el('button', null, '测试系统通知')
    notifyTest.type = 'button'
    notifyTest.addEventListener('click', function () {
      if (!notificationApi()) {
        reportDiag({ attempt: 'manual-no-api' })
        renderPanel()
        return
      }
      if (notificationApi().permission !== 'granted') requestNotifyPermission()
      showNotification('DSH 提醒音测试', '这是一条系统通知测试，用来确认窗口外也能看见。', 'dsh-sound-alert-test', 'manual')
      renderPanel()
    })
    panel.appendChild(notifyTest)

    var peerBox = el('div', 'dsa-peerbox')
    peerBox.appendChild(el('div', 'dsa-hint', '额外监听的 DSH 地址（每行一个，留空＝只监听本页所在的实例）'))
    var peerArea = document.createElement('textarea')
    peerArea.rows = 3
    peerArea.spellcheck = false
    peerArea.value = (Array.isArray(settings.peers) ? settings.peers : []).join('\n')
    peerArea.addEventListener('change', function () {
      settings.peers = peerArea.value.split(/[\s,;]+/).filter(function (item) { return !!item })
      saveSettings()
      refreshExtraSources()
      renderPanel()
    })
    peerBox.appendChild(peerArea)
    panel.appendChild(peerBox)

    var actions = el('div', 'dsa-actions')
    var test = el('button', null, '试听')
    test.type = 'button'
    test.addEventListener('click', function () { playTone() })
    actions.appendChild(test)

    var simulate = el('button', null, '模拟一条提醒')
    simulate.type = 'button'
    simulate.addEventListener('click', function () {
      fetch(endpoint('/test.json'), { method: 'POST' }).catch(function () {})
    })
    actions.appendChild(simulate)

    var reset = el('button', null, '恢复默认')
    reset.type = 'button'
    reset.addEventListener('click', function () {
      var next = {}
      for (var key in DEFAULTS) {
        if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) next[key] = DEFAULTS[key]
      }
      settings = next
      saveSettings()
      renderBell()
      renderPanel()
      refreshExtraSources()
      applyTitleFlag(pendingCount > 0 && settings.flashTitle)
    })
    actions.appendChild(reset)
    panel.appendChild(actions)

    panel.appendChild(el('div', 'dsa-hint', '提示：浏览器要求先与页面交互一次才允许自动播放声音；本插件会在你首次点击/按键后补响。未处理时可按上面的间隔重复提醒，你一操作页面或点掉卡片就会停止。'))
  }

  // ---------------------------------------------------------------- 传输层

  // 一个「来源」= 本页所在的 DSH 实例（local）或本机另一个 DSH 实例（peer）。
  // 每个来源各自 SSE + 轮询，提醒按「来源#seq」去重，所以多个实例同时在线也不会串。
  var sources = {}

  function applySnapshot(data, source) {
    if (!data || data.ok === false) return
    var list = Array.isArray(data.alerts) ? data.alerts : []
    handleAlerts(list, source, !source.booted)
    syncPendingFromList(list, source)
    source.booted = true
  }

  function connectSse(source) {
    if (!window.EventSource) return
    try {
      source.es = new EventSource(urlFor(source, '/events'))
    } catch (err) {
      source.es = null
      return
    }
    source.es.addEventListener('snapshot', function (event) {
      try { applySnapshot(JSON.parse(event.data), source) } catch (err) {}
    })
    source.es.addEventListener('alert', function (event) {
      try { handleAlerts([JSON.parse(event.data)], source, false) } catch (err) {}
    })
    source.es.addEventListener('resolved', function (event) {
      try {
        var info = JSON.parse(event.data)
        if (!info || typeof info.seq !== 'number') return
        var id = alertId(source.key, info)
        if (pending[id]) delete pending[id]
        fadeCard(id)
        refreshPendingMeta()
        reconcileAlarm()
      } catch (err) {}
    })
    // EventSource 只在网络错误时自动重连；插件被热重载/服务器重启的那一瞬间，
    // 这个路由会短暂消失并返回 404 或错误的 Content-Type，浏览器会把这类错误当作
    // 不可恢复（readyState=CLOSED）而彻底放弃。这里手动补一次重连，
    // 否则就只剩 4 秒轮询兜底，隐藏标签页里会被节流到一分钟级。
    source.es.onerror = function () {
      var es = source.es
      if (!es || es.readyState !== 2) return // 2 = CLOSED（不可恢复）
      try { es.close() } catch (err) {}
      source.es = null
      if (source.reconnect) clearTimeout(source.reconnect)
      source.reconnect = setTimeout(function () {
        source.reconnect = null
        if (!source.asleep) connectSse(source)
      }, 3000)
    }
  }

  function pollSource(source) {
    if (source.asleep) return
    var controller = typeof AbortController === 'function' ? new AbortController() : null
    var timer = setTimeout(function () {
      if (controller) controller.abort()
    }, 10000)
    fetch(urlFor(source, '/state.json'), {
      cache: 'no-store',
      signal: controller ? controller.signal : undefined,
    })
      .then(function (response) {
        if (!response.ok) throw new Error('http ' + response.status)
        return response.json()
      })
      .then(function (data) {
        source.fails = 0
        applySnapshot(data, source)
      })
      .catch(function () {
        source.fails += 1
        // 对端实例可能没装本插件或已经关掉：休眠一段时间再试，避免刷控制台。
        if (source.key !== 'local' && source.fails >= SOURCE_FAIL_LIMIT) sleepSource(source)
      })
      .then(function () { clearTimeout(timer) })
  }

  function sleepSource(source) {
    if (source.asleep) return
    source.asleep = true
    if (source.es) {
      try { source.es.close() } catch (err) {}
      source.es = null
    }
    if (source.timer) {
      clearInterval(source.timer)
      source.timer = null
    }
    source.retry = setTimeout(function () {
      source.asleep = false
      source.fails = 0
      connectSse(source)
      pollSource(source)
      source.timer = setInterval(function () { pollSource(source) }, POLL_MS)
    }, SOURCE_RETRY_MS)
  }

  function startSource(key, base) {
    if (sources[key]) return
    var source = {
      key: key,
      base: base,
      es: null,
      timer: null,
      retry: null,
      reconnect: null,
      fails: 0,
      asleep: false,
      booted: false,
      maxSeq: 0,
    }
    sources[key] = source
    connectSse(source)
    pollSource(source)
    source.timer = setInterval(function () { pollSource(source) }, POLL_MS)
  }

  /** 唤醒一个休眠来源并重新建立连接。 */
  function wakeSource(source) {
    if (source.retry) {
      clearTimeout(source.retry)
      source.retry = null
    }
    source.asleep = false
    source.fails = 0
    connectSse(source)
    pollSource(source)
    if (source.timer) clearInterval(source.timer)
    source.timer = setInterval(function () { pollSource(source) }, POLL_MS)
  }

  /** 按当前设置补齐本页 + 额外来源（同源永远监听）。 */
  function syncSources() {
    startSource('local', '')
    var peers = peerOrigins()
    for (var i = 0; i < peers.length; i += 1) startSource(peers[i], peers[i])
  }

  /** 设置改完后重算额外来源：新地址接上，被移除的地址休眠。 */
  function refreshExtraSources() {
    var peers = peerOrigins()
    for (var key in sources) {
      if (key === 'local') continue
      if (peers.indexOf(key) === -1) sleepSource(sources[key])
    }
    for (var i = 0; i < peers.length; i += 1) {
      var existing = sources[peers[i]]
      if (!existing) startSource(peers[i], peers[i])
      else if (existing.asleep) wakeSource(existing)
    }
  }

  function pollAllSources() {
    for (var key in sources) pollSource(sources[key])
  }

  // ------------------------------------------------------------ 用户交互

  function onAnyUserGesture() {
    unlockAudio()
    // 浏览器要求申请通知权限必须由用户手势触发，所以放在首次交互之后。
    requestNotifyPermission()
    if (alarmActive) {
      // 人已经回到电脑前：停止重复提醒，但卡片留着等他处理。
      stopAlarm()
      renderBell()
    }
  }

  function onVisibility() {
    if (!document.hidden) pollAllSources()
  }

  // ---------------------------------------------------------------- 启动

  function boot() {
    if (!ensureDom()) {
      setTimeout(boot, 200)
      return
    }
    document.addEventListener('pointerdown', onAnyUserGesture, true)
    document.addEventListener('keydown', onAnyUserGesture, true)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', function () { pollAllSources() })
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && panel) closePanel()
    })

    syncSources()
    // 开机就上报一次页面侧状态（通知能力/权限/窗口可见性），随时可从宿主的
    // /dsh-sound-alert/health.json 读回，便于远程定位问题。
    reportDiag({ attempt: 'boot' })

    window.__dshSoundAlertApi = {
      test: function () { playTone() },
      simulate: function () { return fetch(endpoint('/test.json'), { method: 'POST' }) },
      notify: function () { return showNotification('DSH 提醒音测试', '手动触发的系统通知测试。', 'dsh-sound-alert-test', 'manual') },
      settings: function () { return settings },
      sources: function () { return sources },
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
