# dsh-sound-alert —— DSH 授权 / 选择 声音提醒

DSH 需要**你授权**（工具调用审批）或**让你做选择**（`ask_user_question` / 计划复核）时，
在页面播放提示音并弹出提醒卡片，让你不用一直盯着界面。

```
┌──────────────────────────────┐          🔔 左下角小铃铛（常驻，半透明）
│ 授权  需要你授权              │          点一下 = 开关声音
│ 工具：pwsh                    │          点 ▾ / 右键 = 打开设置面板
│ 原因：需要写入工作区外的文件…  │
│ [知道了]            12:30:05  │          ← 提醒卡片（最多同时 3 张）
└──────────────────────────────┘
```

---

## 一、触发时机

插件在宿主进程里**旁听**两个 Cordis waterfall 事件，看不见也改不了任何授权结果：

| 事件 | 什么时候触发 | 对应你的操作 |
|---|---|---|
| `approval/request` | 某个工具调用需要授权（审批策略 = `ask`） | 点「允许 / 拒绝」 |
| `user-questions/request` | `ask_user_question`、计划复核（`plan-review`）等需要选择 | 选选项或填写回答 |

旁听是**完全透明**的：监听器以 `prepend` 注册在 waterfall 最外层，立刻 `return next()`
把链路交回原有应答者（浏览器应答 UI / ACP / 其他应答者），自身异常全部吞掉。
卸载本插件后行为与安装前**完全一致**。

> 为什么必须 `prepend`：waterfall 里「先注册的是外层」，而浏览器接上后
> `dsh-api-remotes` 会注册一个把请求转发给页面、并以页面答案直接 settle 的监听器
> （只有它自己认不出来时才会调用 `next()`）。排在那之后就会永远收不到事件。

### 只有「确实在等人」才响

请求发出后 **500ms** 内若已被应答（机器应答者、auto-review、fail-closed 的
`unavailable` 等），不会响铃；超过后仍未被应答才提醒。请求被应答的瞬间会推送
`resolved`，页面立刻停止重复提醒。

---

## 二、页面行为

- **位置**：默认停在**右下角**（不会再压住左侧侧边栏底部的设置按钮），
  并且**整组可拖动** —— 按住铃铛拖到任意位置，松手自动吸附到最近的一个角
  （右下 / 左下 / 右上 / 左上），位置记在设置里；设置面板里也能直接选。
  提醒卡片与设置面板都跟着铃铛所在的角走（在下方则向上堆叠，在上方则向下堆叠）。
- **提示音**：Web Audio 合成，无需音频文件。5 种音色：叮、叮咚（默认）、三连升调、铃铛、急促警报。
- **提醒卡片**：显示「授权 / 选择」徽标、工具名或问题正文与选项、时间；点「知道了」关闭。
  同一时刻最多 3 张，30 秒自动淡出。
- **重复提醒**：未处理时按间隔重复（默认每 5 秒，最多 10 次）。以下任一情况立即停止：
  请求被应答 / 你在页面上点了任何地方或按了任意键 / 点掉卡片 / 达到次数上限。
- **标题闪烁**：未处理时页面标题前面加 `🔔 `。
- **实时通道**：SSE（`/dsh-sound-alert/events`）为主 + 4 秒轮询兜底。
  隐藏的标签页里浏览器会把 `setInterval` 节流到一分钟级，而网络事件不节流，
  所以切到别的标签页也照样能及时响。

### 多实例同时监听（重要）

本机常常同时跑多个 DSH 实例（例如 `dsh web` 占 3080、Electron 桌面端占 19387），
**「需要你授权/选择」的事件只由真正跑着那个会话的实例发出**。如果只监听本页所在的
实例，你在 3080 的页面上就永远听不到桌面端实例（19387）找你授权的提示音 ——
本机实测确实如此（我这边会话的真实 `approval/request`、`user-questions/request`
全部落在 19387，3080 一条都没有）。

因此页面脚本会**同时监听本页实例 + 一组额外地址**（默认
`http://127.0.0.1:3080`、`http://127.0.0.1:19387`，可在设置面板里增删）。
两类来源各自独立编序，因此提醒内部按「来源#seq」去重；
来自其它实例的卡片右上角会标出 `来自 127.0.0.1:19387`。
对端没装插件或已关闭时静默休眠，5 分钟后再试，不会污染控制台。

> 跨源访问依赖宿主路由上的 `Access-Control-Allow-Origin: *`（JSON 与 SSE 路由都已设置）。
> 于是**只要保持其中一个页面（如 3080）开着并刷新过，两个实例的提醒都能听到**。

### 设置面板（右下角铃铛旁的 ▾，或右键铃铛）

启用开关 · 提示音 · **铃铛位置** · 音量 · 未处理时重复间隔 · 重复上限 · 弹出卡片 · 标题闪烁 ·
**额外监听的 DSH 地址** · 试听 · 模拟一条提醒 · 恢复默认。
设置存在浏览器 `localStorage`（键 `dsh-sound-alert.settings.v1`）。

> **浏览器自动播放限制**：页面必须先有一次用户交互才允许出声。插件会在你第一次
> 点击/按键后**补响**这一次提醒；哪怕不出声，卡片和标题提醒也一定会出现。

---

## 三、安装（已装好）

### web profile（`http://127.0.0.1:3080/`）—— 正规 bundle 安装

已作为 **bundle** 登记进 profile：

```jsonc
// $DSH_HOME/profiles/web/package.json
"dependencies": { "dsh-sound-alert": "link:<本仓库绝对路径>" },
"dsh": { "profile": { "bundles": [ ..., "dsh-sound-alert" ] } }
```

安装命令（就是 DSH 官方插件页「本地目录路径」那一栏背后执行的同一件事）：

```powershell
dsh plugin --profile web add link:<本仓库绝对路径>
```

因为它现在是**已安装的包 + bundle 层**，所以会出现在 DSH 的**插件配置/插件清单**里
（带 `package.json` 的 `meta.title`、`icon.svg` 与 `locale/zh.json` 显示名），
也能从插件页面直接禁用或卸载。

> **为什么之前看不到**：上一版是用「profile 补丁层 + 绝对路径 insert」挂载的。
> 那种方式只把一行插件插入配置树，**没有把它登记成已安装的包**，因此运行完全正常，
> 但依赖清单 / bundle 列表 / 插件配置页里都不会出现它 —— 这也是你之前没找到的原因。

### desktop profile（`http://127.0.0.1:19387`）—— 补丁层挂载

`desktop` profile 被 Electron 独占，CLI 不允许对它执行 `dsh plugin`，所以那里仍用
`$DSH_HOME/profiles/desktop/cordis.patch.yml` 里的「绝对路径 insert」。
这个实例正是**你这个会话真正运行的地方**，必须保留（3080 的页面靠跨实例监听它）。

### 卸载 / 回滚

```powershell
# web profile（正规卸载）
dsh plugin --profile web remove dsh-sound-alert
# desktop profile：删除 cordis.patch.yml 里那条 - insert: 条目
```

安装前的原始文件备份（**本仓库不含该目录**，仅为本地留档）：
`web-package.json.orig`、`web-pnpm-lock.yaml.orig`、`web-cordis.patch.yml.orig`、
`desktop-cordis.patch.yml.orig`。

---

## 四、目录结构与迭代

```
dsh-sound-alert/
├─ package.json          # dsh.bundle.patch 声明；main/exports -> lib/entry.mjs
├─ cordis.patch.yml      # bundle 挂载声明（bundle 安装时由 DSH 读取）
├─ icon.svg  locale/     # 插件配置页用的图标与中英文显示名
├─ lib/
│  ├─ entry.mjs          # 稳定入口：静态 name/inject + 动态导入实现（见下）
│  ├─ host.mjs           # 宿主实现：事件旁听、SSE、HTTP 路由、tapIndex 注入
│  └─ widget.js          # 页面脚本：提示音、卡片、设置面板、多来源 SSE/轮询
├─ test/smoke.mjs        # 最小 DOM 冒烟测试（39 项断言）
└─ README.md
```

**改了代码怎么生效**

| 改的文件 | 生效方式 |
|---|---|
| `lib/widget.js` | 宿主每次请求都重新读盘，**刷新页面**即可 |
| `lib/host.mjs` | 入口 `entry.mjs` 每次激活都用 `?rev=<mtime>` 动态导入实现，所以只要让该条目重新激活一次即可（改一下 patch/重装，或 HMR 重载配置树），无需重启 DSH |

`lib/entry.mjs` 之所以存在：DSH 的宿主模块按 URL 缓存，且已有条目的入口路径
**不能原地修改**（loader 的 `tree.update` 明确排除 `name`）。所以入口保持静态、
实现按版本参数动态导入。

**改完先跑冒烟测试**（不需要浏览器）：

```powershell
cd <本仓库>
node test\smoke.mjs      # 期望输出 SMOKE PASS
```

它用一个极简 DOM 桩把 `lib/widget.js` 真跑一遍：启动 → 收到提醒 → 弹卡片 →
开设置面板 → 切四角 → 拖动吸附 → **轻点 ▾ / 铃铛** → 关面板 → 校验持久化，
用来抓只会在浏览器控制台暴露的拼写/未定义/属性错位问题。

> 桩里的 `dispatch` 会像真实 DOM 一样从目标向上冒泡 —— 这一点是必须的：
> 停靠组靠冒泡才能收到子按钮的 `pointerdown`。

### 一个已经踩过的坑：指针捕获会吃掉子按钮的 click

拖动实现最初在 `pointerdown` 就调用了 `setPointerCapture`。结果 Chromium 会把随后的
`click` **重定向到被捕获的 dock 本身**，于是 🔔 和 ▾ 的 click 处理器永远收不到事件
（表现为「点了没反应」）。现在只在**真正越过拖动阈值**时才捕获，并且让 `pointerup`
自己也能按 `pointerdown` 的目标执行动作，两条路径用时间戳互斥，不会重复执行。
`test/smoke.mjs` 里专门有 5 条断言覆盖这条路径。

### 另一个坑：原生 `<select>` 的弹出列表不跟面板配色

面板是深色的，但原生 `<select>` 弹出的选项列表由浏览器按**文档级**配色绘制
（DSH 页面是浅色），于是白底列表 + 面板继承来的浅色文字 = 未选中项几乎看不见；
`color-scheme: dark` 只影响收起状态的控件，改 `option` 配色在各浏览器上也不可靠。

现在设置面板里的所有选项（提示音 / 铃铛位置 / 未处理时重复 / 重复上限）都换成
**面板内自绘的分段选择**（`choiceField` + `.dsa-chip`），配色完全跟着面板走，
不会再出现深浅打架，也不再弹出系统样式的浮层。`test/smoke.mjs` 里有断言确保
面板中不再出现任何原生 `select` 元素。

---

## 五、对外接口

| 路由 | 方法 | 说明 |
|---|---|---|
| `/dsh-sound-alert/state.json` | GET | `{ok, seq, serverTime, graceMs, alerts:[最近 25 条]}` |
| `/dsh-sound-alert/events` | GET | SSE：`snapshot` / `alert` / `resolved`，15 秒心跳 |
| `/dsh-sound-alert/alert.js` | GET | 页面脚本（每请求读盘、`no-store`） |
| `/dsh-sound-alert/health.json` | GET | 自检：包路径、脚本可读性、`build` 版本、SSE 连接数 |
| `/dsh-sound-alert/test.json` | POST | 注入一条模拟提醒（`?kind=question` 可选），8 秒后自动解除 |
| `/dsh-sound-alert/ack.json` | POST | 页面上报「已看过」水位（`?upto=<seq>`） |

另有 `tapIndex` 向 index.html 注入 `<script defer src="/dsh-sound-alert/alert.js"></script>`（幂等）。

快速自检：

```powershell
Invoke-WebRequest http://127.0.0.1:19387/dsh-sound-alert/health.json -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:19387/dsh-sound-alert/test.json -Method POST -UseBasicParsing
```

---

## 六、验证结果

**已在开发机上端到端验证**

| 项 | 证据 |
|---|---|
| 补丁层热组装 | 追加条目后约 10 秒插件在 `127.0.0.1:3080` 上线，未重启 `dsh web` |
| 路由 | `health.json` / `state.json` / `alert.js` 均 200，`alert.js` 内容与磁盘一致 |
| index 注入 | 用带 token 的请求取回 3080 的 index.html，末尾确有注入的 `<script defer src="/dsh-sound-alert/alert.js">` |
| SSE 推送 | 连通即 `snapshot`；注入提醒立刻 `alert`；8 秒后 `resolved` |
| 页面脚本 | 浏览器 `streams=1`，且页面自己点过「模拟一条提醒」（服务端收到该请求） |
| **真实授权事件** | 19387 记录到 `kind=approval, toolName="write", callId=call_00_ET_…`，`sessionId` 为真实会话 |
| **真实选择事件** | 19387 记录到两次 `kind=question`，携带真实问题文本与选项 |
| **提示音** | 已确认「听到了，很清楚」 |
| **跨实例监听** | 只从 19387 发出的提醒，在 3080 的页面上听到，卡片标注「来自 127.0.0.1:19387」 |
| **bundle 安装** | `dsh plugin --profile web add link:…` 后依赖与 bundles 列表均登记，插件仍在线（`build=2`），小鲸鱼链接未受影响 |
| **出现在插件配置页** | 已确认「设置 → 插件」里能看到 `dsh-sound-alert` |
| **位置不再遮挡** | 已确认铃铛在右下角、不再压住左侧侧边栏底部的设置按钮 |
| **拖拽与四角吸附** | 已确认拖动与自动吸附生效 |
| **轻点 ▽ 打开设置面板** | 已确认修复后在页面上能正常打开 |
| **轻点铃铛切换开关** | 已确认能在 🔔 / 🔕 之间切换 |
| **分段选择改色** | 已确认原下拉列表未选中项看不清，已改为面板内自绘分段选择 |
| **页面脚本回归** | `node test/smoke.mjs` 39 项断言全通过（位置/吸附/拖动/轻点按钮/分段选择/卡片/面板/持久化） |

**已知限制**

- 提醒是全局队列，多个浏览器标签页各自会响一次（同一实例内按来源#seq 去重）；
- 页面脚本不感知 DSH 的会话切换，只展示提醒内容，不跳转到对应会话；
- 额外地址默认写死 3080 / 19387，换端口需在设置面板里改；
- 必须**至少有一个加载过插件的页面开着**才会响（页面关了就没有监听者）；
- 插件被热重载/服务器重启的那一瞬间，页面的 SSE 会收到不可恢复错误，
  已做 3 秒后手动重连兜底；重连前仍有 4 秒轮询在跑，不会漏提醒；
- 提示音用 Web Audio 合成，Safari 上首次交互前同样无声（会补响）。
