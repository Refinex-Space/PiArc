# S1 渲染进程 transcript 与 composer（macOS）

- 任务：T09（2026-11-15）。Windows 部分（微软拼音、Windows 上的性能测量）由 W0 完成。
- 结论（macOS）：**通过**。第 11 章的流式、滚动、冷加载与渲染进程内存四项预算全部满足；跨块选择复制、XSS 载荷、输入法守卫的自动化用例全部通过。第 7 节的 macOS 拼音、日文输入法与触控板人工清单由用户在 T19 确认通过。
- 结论（Windows，W0）：**通过**。L4 的 transcript 与 composer 用例两种形态通过；流式、滚动、冷加载、渲染进程内存四项预算满足；微软拼音实机核对全部符合预期（第 8 节）。全部进程合计 450 MiB，与 macOS 同样超出第 11 章的 450 MB（I26）；日文输入法未验证。
- 库选型：ADR-0022（@tanstack/react-virtual、marked 词法器、shiki JavaScript 正则引擎；composer 为 ProseMirror）。

## 1. 验证环境

| 项 | 值 |
|---|---|
| 机器 | Apple M1 Max，10 核，32 GB（与第 11 章基准机型 M1 Pro / 16 GB 不同） |
| 系统 | macOS 26.5.2（25F84） |
| 显示器 | 外接显示器，60 Hz（`screen.getDisplayMatching().displayFrequency` = 59.997），缩放 2；窗口内容区 1280×800 |
| 运行时 | Electron 45.3.2（Chromium 内置），Node 24.14.1；Playwright 1.65.1 |
| 产物 | `npm run package:desktop -- --flavor development` 的打包产物（`out/development/`），即生产渲染构建 |
| 依赖 | @tanstack/react-virtual 3.14.26、marked 18.2.0、character-entities 2.0.2、@shikijs/core / engine-javascript / langs / themes 4.6.0、prosemirror-* （版本见 ADR-0022） |

## 2. 做了什么

- **原型页** `#/transcript-lab`（`apps/desktop/src/renderer/lab/`）：不接 Core，用协议的 `turn/*`、`item/started`、`item/agentMessage/delta`、`item/completed` 通知驱动一个最小 store；合成器按给定 token/s 回放（每 16 ms 合并一次 delta，与 Core 的合并节奏一致），能生成 1 万条 item 的历史，语料覆盖段落、列表、任务列表、表格、多语言代码、1,200 行代码块、中文与日文、未闭合的围栏与强调、XSS 载荷。
- **transcript**：虚拟列表、Worker 中的增量 Markdown 与 shiki 高亮、安全渲染、流式节奏、滚动跟随与"回到底部"、选择复制与"复制本条消息"。
- **composer**：ProseMirror、`@` 胶囊（固定候选）、空闲与运行中的键位语义、输入法守卫。
- **对比**：两个虚拟列表候选（@tanstack/react-virtual、react-virtuoso）共用同一套行组件与滚动跟随，跑同一组基准与 L4 用例，之后删掉 react-virtuoso（对比时的代码在提交 `0387545`）。
- **测量**：`npm run bench:s1`（`scripts/bench/s1-transcript.mjs`）。帧数据来自 CDP 追踪渲染进程（`Tracing.start`，JSON 流）：每帧主线程工作量、超过 50 ms 的任务、合成器帧状态；页面另记 rAF 间隔与 Long Animation Frame。

### 帧时间的口径

架构第 11 章写"帧时间 p99 ≤ 16 ms"。在 60 Hz 屏上，rAF 间隔与 `AnimationFrame`（LoAF 口径：本帧第一个任务开始到渲染结束）空闲时都约 16.7 ms，不能拿来对照。本报告的"每帧主线程工作"是 CDP 追踪中相邻两次 `BeginMainThreadFrame` 之间渲染主线程顶层任务（`RunTask`）的总耗时：它不超过 16 ms，主线程就不会让该帧错过 60 fps。rAF 间隔、错过的帧（间隔超过 1.5 个显示帧）与合成器丢帧一并给出，作为实际呈现的证据。

## 3. 实测数据（最终构建，`tmp/evidence/T09/bench/s1-packaged-final.json`）

| 指标（第 11 章预算） | 实测 | 结论 |
|---|---|---|
| 100 token/s 流式 60 s：超过 50 ms 的长任务（无） | 0（追踪中的 `RunTask`；页面 `longtask` 与 LoAF 也为 0） | 通过 |
| 同上：帧时间 p99 ≤ 16 ms | 每帧主线程工作 p50 2.7 ms、p95 4.8 ms、p99 5.7 ms、最大 15.3 ms（3,607 帧，无一帧超过 16 ms） | 通过 |
| 同上：实际呈现 | 页面 60.0 fps，rAF 间隔 p99 17.7 ms，错过 0 帧；合成器 3,564 帧全部呈现，丢帧 0 | — |
| 1 万条 item 自动滚动 60 fps | 3,000 px/s 滚动 10 s（30,002 px）：60.1 fps，错过 0 帧，合成器丢帧 0；每帧主线程工作 p99 2.2 ms | 通过（受 60 Hz 屏限制，上限即 60 fps） |
| 1,000 条 item 冷加载 ≤ 300 ms | 5 次：59.8、48.5、51.7、51.0、51.8 ms（中位 51.7 ms）。从数据进入 store 到可见行全部显示解析后的 Markdown、且已绘制一帧 | 通过 |
| 渲染进程内存（1 窗口、1,000 条 item）≤ 220 MB | 179 MiB（新启动、GC 后；空页面 130 MiB） | 通过（原型页没有侧栏的 100 个会话，T18 后复测） |
| 应用全部进程合计 ≤ 450 MB（参考） | 489 MiB：主进程 179（含 Core 与测试驱动）、GPU 82、Utility 48、渲染 179 | 超出；主进程部分已登记为 I12，由 R1 校准 |

两个候选的对比数据（同一组测量，`tmp/evidence/T09/bench/s1-packaged-full.json`）见 ADR-0022：流式时 react-virtuoso 错过 8 帧、合成器丢 13 帧并有一个 108 ms 的长动画帧，冷加载中位 99.6 ms；@tanstack/react-virtual 0 / 0，50.6 ms。L4 滚动跟随用例 tanstack 5/5 通过，virtuoso 3/5（流式增长时有一帧离底约 33 px，`tmp/evidence/T09/compare/scroll-l4-both-lists.txt`）。

Markdown 解析库的对比（Node，同机）：10 KB 混合内容 marked 0.35 ms、mdast 5.6 ms、markdown-it 0.60 ms；3,000 行代码块 0.31 / 14.6 / 0.64 ms（ADR-0022）。

## 4. 调校后的参数

常量集中在 `apps/desktop/src/renderer/transcript/constants.ts`，架构第 8.4 节已同步。

| 常量 | 取值 | 依据 |
|---|---|---|
| `SCROLL_FOLLOW.releasePx` | 2 px | 参考实现取值；用户向上滚动超过即解除，L4 边界用例验证 2 px 不解除、3 px 解除 |
| `SCROLL_FOLLOW.resumePx` | 40 px | 设计系统文档取值；1 px 要求用户精确滚到底，触控板惯性滚动很难做到；L4 验证 41 px 不恢复、40 px 恢复 |
| `SCROLL_FOLLOW.buttonPx` | 200 px | 参考区间 120–200 px 的上端：小幅回看时按钮不闪现；L4 验证 200 px 不显示、201 px 显示 |
| `SCROLL_FOLLOW.userInputWindowMs` | 150 ms | 参考实现的冷却窗口：用户输入后这段时间内的滚动算用户的，也不贴底，避免和滚轮抢视口 |
| `STREAMING.revealTauMs` | 50 ms | 每帧显示未显示部分的 1 − e^(−Δt/τ)；100 token/s（约 400 字符/秒）时显示落后约 20 字符、3 帧，单元测试 `pacer.test.ts` 验证 |
| `STREAMING.minCharsPerSecond` | 120 | 消息尾部的少量字符不会逐个爬出 |
| `STREAMING.maxBacklogChars` | 400 | 一次到达大段文本时显示最多落后 400 字符，不会拖到几秒后 |
| `VIRTUAL_LIST.overscanViewports` | 1 | "可见区上下约一屏"；按像素换算行数 |
| `HIGHLIGHT_MAX_CHARS` | 100,000 | 更长的代码保持纯文本 |

滚动的触控板手感需要真人确认，列在第 7 节。

## 5. XSS 与安全渲染

载荷集 `apps/desktop/src/shared/xss-payloads.ts`（18 个）：`<script>`（块与行内）、`<img onerror>`、`<div onmouseover>`、`javascript:` 链接（Markdown 链接、字符引用编码的 `&#106;avascript:`、自动链接、原始 `<a>`）、带 `<script>` 与 `onload` 的 SVG、`<iframe src>` 与 `srcdoc`、`<style>`、`<object>`/`<embed>`、`<meta>` 刷新、`data:text/html` 图片、远程图片、`<form>`。

| 检查 | 结果 |
|---|---|
| 哨兵 `window.__piarcXssSentinel` | 未被改动（已完成消息、流式消息两种路径；悬停 `onmouseover` 元素、点击 `javascript:` 链接之后） |
| CSP 违规事件 | 0 |
| transcript 内的 `script`、`iframe`、`style`、`svg`、`object`、`embed`、`meta`、`form`、`img`、`link`、`base` 元素 | 0 |
| 任何元素的 `on*` 属性 | 0 |
| 链接目标 | 只有 `https:`、`http:`、`mailto:`；`javascript:`、编码后的 `javascript:`、`data:` 显示为不可点的文本 |
| 对外请求 | 0（远程图片显示为"Image: …"链接，不加载） |
| 载荷原文 | 全部以文本出现在页面上 |
| 链接点击 | 经 `window.piarc.openExternal`，主进程先弹确认框；取消后不打开、窗口不导航 |
| CSP | 页面与两个 Worker 脚本的响应头都等于 `PRODUCTION_CSP`（T03 的值，`csp.ts` 未改动） |
| ESLint | 临时写入 `innerHTML`、`outerHTML`、`insertAdjacentHTML`、`createContextualFragment`、`document.write`、`dangerouslySetInnerHTML` 的文件被拦截，7 个错误（`tmp/evidence/T09/lint/innerhtml-violation.txt`），文件随后删除 |

用例：`apps/desktop/e2e/transcript-security.e2e.ts`、单元测试 `to-ir.test.ts`。

## 6. 输入法与键位（自动化）

Playwright 没有输入法接口，用 CDP 驱动：`Input.imeSetComposition` 产生合成，`Input.insertText` 提交，合成中的按键以 `windowsVirtualKeyCode: 229` 发出（`apps/desktop/e2e/composer.e2e.ts`）。

| 用例 | 结果 |
|---|---|
| 空闲：Enter 发送、Shift+Enter 换行、Mod+Enter 发送、Esc 无动作、空白不发送 | 通过 |
| 运行中：Enter steer、Mod+Enter 排队、Esc 停止、Shift+Enter 换行 | 通过 |
| 合成中（空闲与运行中各一次）：Enter、Esc、`/`、`@`（229）以及合成中带自身键码的 Enter、Esc，合成文本含 `@/` | 无任何动作；合成中的 keydown 全部带 `isComposing` 或 229 |
| 合成开始前到达的 229 Enter / Esc | 无动作、不换行。ProseMirror 此时还不认为在合成，只有守卫能拦住；去掉守卫时该用例失败（变异对照） |
| 合成文本恰为 `@` 或 `/` | 不打开提及、不触发命令；去掉守卫时失败 |
| 合成结束后 | `@` 打开候选、Enter 发送、空输入框里的 `/` 触发命令，恢复正常 |
| `@` 胶囊 | 存储 `{id, label, path}`、显示 `@main.ts`、发送文本 `@apps/desktop/src/main/main.ts`，三者分开 |

实现中发现并修正一处：守卫最初放在 `handleKeyDown`，ProseMirror 随后的 `baseKeymap` 仍会把 229 Enter 当作换行；改为在 `handleDOMEvents.keydown` 中拦截，ProseMirror 的按键处理整个跳过且不 `preventDefault`，按键完整交给输入法。

## 7. macOS 真实输入法与触控板（用户实测）

2026-11-18，用户在 T19 续做时确认下列 M1–M10 均已实测，结果符合预期。覆盖 macOS 简体拼音、日文候选确认与取消、触控板跟随，以及跨块选择与复制。以下保留原始复测步骤。

```bash
npm run package:desktop -- --flavor development
open "apps/desktop/out/development/PiArc-darwin-arm64/PiArc.app"
```

应用打开后按 ⌥⌘I 打开开发者工具，在 Console 执行 `location.hash = '#/transcript-lab'; location.reload()` 进入原型页。

| 编号 | 操作 | 预期 |
|---|---|---|
| M1 | 简体拼音：在输入框输入 `nihao`，候选出现时按 Enter | Enter 只确认拼音（上屏 `nihao` 或按输入法设置上屏），不发送；再按一次 Enter 才发送 |
| M2 | 简体拼音：输入 `ni`，候选出现时按 Esc | 只取消候选，不触发任何动作；点"Set running"后重复，同样不触发停止 |
| M3 | 简体拼音：用数字或空格选字上屏"你好"，然后按 Enter | 发送"你好" |
| M4 | 简体拼音中文标点模式：按 Shift+2、按 `/` | `@` 打开文件候选（这是直接输入，不是合成），空输入框里的 `/` 不报错；如果输入法把它们放进候选框，则在候选框里时不触发 |
| M5 | 在系统设置中添加"日语 – 罗马字"后：输入 `nihon`，按空格转换，候选出现时按 Enter，再按 Enter | 第一次 Enter 确认转换不发送，第二次发送 |
| M6 | 日文：转换中按 Esc | 只取消转换 |
| M7 | 触控板：点"Stream 20 s"，流式中用两指向上轻扫 | 视口立刻停在用户位置，不被拉回底部；出现"Back to bottom" |
| M8 | 触控板：再向下滑到接近底部（约一行以内） | 恢复跟随，之后内容增长时贴底；按钮消失 |
| M9 | 流式中拖动滚动条向上、按 PageUp | 都解除跟随 |
| M10 | 选中一段跨段落和代码块的文字按 ⌘C，粘贴到文本编辑器 | 文本顺序正确、代码缩进保留，不含"ts"语言标签和"Copy Markdown"按钮文字 |

## 8. Windows（W0，2026-11-16）

机器与对照见 S2 报告第 8 节（i5-1340P、16 GB、NVMe，Windows 11 专业版 25H2 26200.9974，x64）。窗口 1280 × 800，缩放 1，显示刷新率 75 Hz（Iris Xe 核显）。

**自动化用例**：L4 的 `transcript-*.e2e.ts`、`composer.e2e.ts` 在开发与打包两种形态通过（本机全量 138 项）。CI 的 Windows 作业原先在三个复制用例上失败：Chromium 在 Windows 上把纯文本以 CRLF 写进剪贴板，用例按 LF 比较，复制内容本身正确。读剪贴板的辅助函数改为把 CRLF 规范为 LF 后通过（提交 9d6b01b）。

**测量**（`npm run bench:s1 -- --form packaged`，`tmp/evidence/W0/bench/s1-packaged.json`）：

| 项 | Windows | 预算 | macOS（第 4 节） |
|---|---|---|---|
| 100 token/s 流式 60 s | 每帧主线程工作 p50 1.6 ms、p99 4.7 ms、max 13.8 ms；超过 50 ms 的任务 0；75 Hz 下帧间隔 p99 13.6 ms，丢帧 0 | 无长任务；帧时间 p99 ≤ 16 ms | p99 5.7 ms |
| 1 万条滚动 10 s | 75.1 fps，每帧工作 p99 2.6 ms；超过 16 ms 的帧 2 个（最长 21.9 ms），合成器丢 1 帧 | 60 fps | 60 fps |
| 冷加载 1,000 条 | 中位 80.9 ms，最大 88.5 ms（5 次） | ≤ 300 ms | 52 ms |
| 渲染进程内存 | 1,000 条时 137 MiB；空页面 96 MiB | ≤ 220 MB | 179 MiB |
| 全部进程合计（不含 Agent Host） | 450.0 MiB（472 MB）：主进程 120 MiB、GPU 137 MiB、Utility 56 MiB、渲染进程 137 MiB | ≤ 450 MB | 489 MiB |

全部进程合计超出预算约 22 MB，与 macOS 的 I26 同类；Windows 的主进程比 macOS 小（120 对 179 MiB），GPU 进程更大，由 R1 与 I12、I26 一起校准。

**微软拼音**：用户在已安装的应用（CI 的开发构建 0.0.2）的 `#/transcript-lab` 中按 `S06-first-run-checklist.md` 第 8.2 节核对，WM1–WM4 全部符合预期：候选框出现时 Enter 只上屏字母不发送，Esc 只取消候选（运行状态下也不停止），选字后 Enter 发送，`@` 打开文件候选、`/` 不报错。日文输入法需要安装语言包，属于系统配置变更，W0 不做，记"未验证"。

**手感**：滚动条拖动与精确式触摸板手感需要人工操作，本次只有自动化的拖动用例（`transcript-scroll.e2e.ts` 的"dragging the scrollbar releases following"通过）。

## 9. 发现与遗留

- **全部进程合计内存超出 450 MB 预算**（489 MiB）：渲染进程本身 179 MiB 在预算内，超出主要来自主进程（179 MiB，含 Core）。主进程预算已登记为 I12，由 R1 按 M0 实测校准；测量方式见 `npm run bench:s1` 的内存部分。
- **原型页随发布构建分发**：`#/transcript-lab` 与 `#/event-probe` 一样在渲染包里（I13 的同类问题），T45 评估剔除。
- **marked 不是逐字符合 CommonMark 的实现**：已用"任意切分下增量结果等于一次性解析"的性质测试守住增量解析，但单次解析本身的边角差异留给 T19 接入真实输出时观察。
- **复制的纯文本形态**：原生复制用 Chromium 的序列化（段落之间空一行，列表项与代码块之间单换行，列表不带符号）；"复制本条消息 / 纯文本"用自有规则（列表带 `•`，块之间空一行）。两者略有不同，T19 可按用户反馈统一。
