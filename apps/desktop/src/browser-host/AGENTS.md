# 脚本宿主与浏览器 SDK（B2，ADR-0089、ADR-0091）

`Browser` 工具的脚本在这里运行：脚本宿主是一个沙箱渲染进程页面（`piarc-browser-host:` 协议源，没有 Node、网络与文件系统），每次调用一个新宿主，运行结束即销毁。页面只经 preload 暴露的 `window.piarcBrowserHost`（契约在 `src/shared/browser-host.ts`）与主进程通信；主进程实现 CDP 代理、快照与各个绑定，Core 做权限与文件 I/O。Vite 入口与 HTML 由主进程侧的任务提供，这个目录只有页面代码。

## 组成

| 部分 | 位置 | 说明 |
|---|---|---|
| 页面入口 | `host.ts` | 等 `onRun`，装绑定与 SDK，执行脚本，`print` 分批上报输出，`finish` 交回结果；一个宿主只跑一个脚本；超过 `timeoutMs` 先自行结束并带回已有输出 |
| 绑定适配 | `bindings.ts` | 把 `piarcBrowserHost.call` 包成 ego 兼容的 `globalThis.ego`（类型 `sdk/ego-bindings.ts`）：`useTaskSpace` 是本地选择，每个请求带 Space；IPC 答复逐个校验；失败沿用 ego 的形状（多数绑定 resolve `{ error, error_code }`，`snapshot` reject，CDP 发送失败走 `onSendCDPMessageError`，参数错误抛 `TypeError`，用户控制的原因键放进 `error`） |
| SDK | `sdk/` | 从 ego-browser 移植，文件名与布局对照上游（见下表），`LICENSE` 是上游的 MIT 许可 |
| 测试替身 | `testing.ts`、`sdk/page-model.fixture.ts` | `FakeBindings`（内存中的 `globalThis.ego`）、`installBindings`、`fakeCdp`；page-model 的共享夹具。只给 `*.test.ts` 用 |

`tsconfig.json` 是独立工程：ES2024 + DOM，没有 Node 类型，引用 `../shared`。

## 运行流程

1. 主进程发 `BrowserHostRun`；`host.ts` 用 `createEgoBindings` 建 `globalThis.ego`（`defaultSpace` 作为初始选择），`installEgoSdk` 包装绑定（`createTab` 设首选标签，换 Space 与关闭、创建、认领 Space 时作废会话）。
2. `sdk/run.ts` 的 `execute` 用 `AsyncFunction` 编译脚本，助手作为参数注入，正文以 `"use strict"` 开头；`document`、`window`、`location` 等页面全局名以参数遮蔽，使用即抛出带提示的 `ReferenceError`（宿主页面自己的这些对象不让脚本误用）。
3. 编译失败时，`host.ts` 的 `locateSyntaxErrorInPage` 在单独的任务里再编译一次，让 SyntaxError 成为未捕获错误，从页面 `error` 事件取行列（Electron 45 实测：行号是编译后源码的行，脚本第一行是第 4 行，列从 1 起），报错写明行、列与源码行。
4. `console.*` 与 `help()` 经 `sdk/output-sink.ts` 缓冲；`observeOutput` 让宿主每个微任务把新增输出作为 `print` 发出（临时输出，运行没能结束时保留）；运行结束时 `finish` 的 `output` 是权威输出：硬停止（用户控制、Space 已结束）只留下指引一次，其他输出原样保留，未处理的页面列在末尾。
5. 结束后 `disposeEgoSdk` 拒绝未完成的 CDP 请求、释放回调。

## 与上游同步

- 上游：`reference/ego-lite/package/ego-browser/src`，基线提交 `56589ea8b98fd3b17a5d2316bfd8ff7b803d3293`（MIT，Copyright (c) 2026 CitroLabs），登记在 `third-party/sources.json` 的 `ego-browser-sdk`。
- 每个移植文件开头注明上游路径、提交与 MIT，以及一句改动说明；PiArc 新增的文件写明 "PiArc addition"。
- 合入上游更新：在 `reference/ego-lite` 中按文件查看基线到新提交的差异（`package/ego-browser/src/<文件>`），逐处合入对应的移植文件并保持下面的改动；上游新增的 v2 API 同时改 `sdk/public-api-schema.ts`。合入后更新文件头、本文件的改动清单与 `third-party/sources.json` 的提交，测试同样按文件对照移植。
- 不复制上游已删除或这里不移植的文件（见"未移植"）。上游的 `*.test.mjs` 移植为同目录的 `*.test.ts`（Vitest）；`page-model.test.mjs` 很长，拆成 `page-model.test.ts` 与 `page-model.part2…5.test.ts`，按上游顺序，测试名不变。
- 规则与仓库一致：严格 TypeScript、类型感知 ESLint、不加 `eslint-disable`、不用 `any` 与 `!`。CDP 回复与事件经 `sdk/cdp-types.ts` 的 `Wire<T>` 读取（字段都可能缺失，页面控制的值是 `unknown`），类型只取自开发依赖 `devtools-protocol`。

## 文件对照

| 上游 `src/` | 移植 | 说明 |
|---|---|---|
| `browser-runtime.ts` | `sdk/browser-runtime.ts` | CDP 传输、会话、事件、对话框、网络与文件选择拦截 |
| `cdp-eval.ts` | `sdk/cdp-eval.ts` | 只保留 v2 用到的部分 |
| `element-resolver.ts` | `sdk/element-resolver.ts` | |
| `ego-errors.ts` | `sdk/ego-errors.ts` | |
| `format.ts` | `sdk/format.ts` | 本地格式化代替 `util.inspect` |
| `help-runtime.ts` | `sdk/help-runtime.ts` | 只按 schema 渲染 |
| `helpers.ts` | `sdk/helpers.ts` | 只有 v2 助手 |
| `index.ts` | `sdk/index.ts` | 只有 `installEgoSdk`、`disposeEgoSdk` |
| `native-gate.ts` | `sdk/native-gate.ts` | |
| `output-sink.ts` | `sdk/output-sink.ts` | |
| `page-context-guard.ts` | `sdk/page-context-guard.ts` | |
| `page-discovery.ts` | `sdk/page-discovery.ts` | |
| `page-ledger.ts` | `sdk/page-ledger.ts` | |
| `page-model.ts` | `sdk/page-model.ts` | |
| `page-ref-registry.ts` | `sdk/page-ref-registry.ts` | |
| `public-api-schema.ts` | `sdk/public-api-schema.ts` | |
| `ref-map.ts` | `sdk/ref-map.ts` | |
| `run.ts` | `sdk/run.ts` | 只有执行器 |
| `snapshot-result.ts` | `sdk/snapshot-result.ts` | |
| `state.ts` | `sdk/state.ts` | |
| `driver/action-target.ts`、`downloads.ts`、`observe.ts`、`page-actions.ts`、`page-input.ts`、`page-keyboard.ts`、`page-waits.ts`、`scroll-motion.ts` | `sdk/driver/` 同名 | |
| — | `sdk/cdp-types.ts`、`sdk/ego-bindings.ts` | PiArc 新增：CDP 类型、绑定类型 |

## 相对上游的改动

整体：

- v1 兼容层不移植：`helpers.ts` 只导出 v2 的 `profiles`、`listTaskSpaces`、`taskSpace`、`claimTaskSpace`、`takeOverTaskSpace`、`help`，另加 PiArc 的 `requestAccess(hosts, reason)`（B2.6.4，`public-api-schema.ts` 有对应条目）。只被 v1 助手用到的代码随之删除：`driver/pointer`、`keyboard`、`nav`、`waits`、`files`、`load`、`element-ops`、`ref-state`；`observe` 的 `drainEvents`、`snapshotText`、`elementCenter`、`captureScreenshot`；`cdp-eval` 的 `cdp()`、`js()`、`hasReturnStatement`（acorn）；`element-resolver` 的 `resolveElementCenter`、`isRawSelector` 及其内部函数；`browser-runtime` 的 `drainBrowserEvents`、`isNetworkDomainEnabled`、`browserSnapshotRefsToRefMap`。
- 全部改为严格类型：CDP 经 `CdpCall` 与 `Wire<T>`，绑定经 `EgoBindings`；上游读 `x.result || x` 的信封兜底在服务已解包的地方去掉；`a || b` 遇到空串或 0 时保持上游语义（各文件的 `present`、`nonEmpty` 等）。
- Node 替换：`process.platform` → `state.platform`（取自 `navigator.platform`）；`EGO_BROWSER_RESPONSE_TIMEOUT_MS`、`EGO_BROWSER_PAGE_BUDGET` → `state.responseTimeoutMs`、`state.pageBudget`；`node:path` 的绝对路径判断 → 字符串规则（`/…`、`C:\…`、`C:/…`、`\\…`）；`Buffer` → `atob`/`btoa`。

逐个模块：

- `browser-runtime`：入站消息先校验信封（`id` 为数字的响应，或 `method` 为字符串、`params` 为对象的事件）；不发 `egoAutomated.enable`（ADR-0091 第 4 条）；不读非标准的 `targetInfo.parentId`；`Target.detachedFromTarget` 只按被分离的 sessionId 找目标，不读已弃用的 `targetId`。
- `native-gate`：页面里没有 `AsyncLocalStorage`，闸门用显式租约：持有租约期间，同一 Space 的调用加入租约（上游只有嵌套调用如此，并发调用排队），其他 Space 的调用排队直到租约释放（上游嵌套时直接拒绝）。同一 Space 内用 `Promise.all` 并发的页面操作因此会并发执行。
- `page-ledger`：没有文件系统，每个 Space 一份 JSON 文档由主进程在内存保存，经 `ledgerLoad(space)`、`ledgerSave(space, data)` 读写（`''` 表示丢弃；存储端口可注入）；去掉版本文件、锁重试、写冲突、浏览器实例 id（`runtimeInstanceId`）与过期清理，同一 Space 的更新在进程内串行。
- `driver/observe` 与截图：不写文件，`Page.captureScreenshot` 的 PNG 经 `attachImage` 附进工具结果，长边经 CDP `clip.scale` 缩到 1568 px 以内，`page.screenshot()` 返回 `{ image, width, height }`；`path` 选项报错说明图片已附上；删去不可达的 `raw` 分支。快照请求带上页面的 `targetId`。
- `page-model`：`page.fetch` 的 `saveAs` 报错（宿主不能写任意文件，改用 `download.saveAs`）；去掉 SDK 自己的视口溢出提示（`#viewportOverflowHint`，主进程的快照已在视口范围打印 `[more content below the viewport: …]`）；智能体光标经 `animationHighlightMouseToPosition(x, y, targetId)` 带上页面目标；上传服务 `stageUpload`；没有剪贴板服务。
- `driver/page-input`：上传先 `stageUpload(paths)` 由 Core 复制到会话暂存区，`DOM.setFileInputFiles` 只收到暂存副本。
- `driver/page-keyboard`：不碰系统剪贴板；`paste(text)` 先在焦点元素上派发带 `text/plain` 的合成 `paste` 事件，页面没取消时用 `Input.insertText` 插入；`{ html }` 报错。
- `driver/downloads`：主进程决定下载目录（会话暂存区，B2.6.6），不发 `setDownloadBehavior`，没有共享目录、等待标记与文件轮询；完成以 `Page.downloadProgress` 为准；`saveAs(path)` 经 `saveFile(guid, path)` 走 Core 的写权限；`path()` 返回主进程在完成事件里报告的暂存名（`filePath`，缺省为 guid）；`delete()` 只标记删除。
- `driver/action-target`：`accessibleName` 的两个正则在模板字符串里写 `\\s`（上游写 `\s`，进入页面时变成字母 `s`）。
- `help-runtime`：`help()` 直接按 `public-api-schema.ts` 渲染，去掉 acorn 解析 JSDoc 与 `help("legacy", …)`。
- `format`：本地格式化代替 `util.inspect`（深度 6、单行）。
- `output-sink`：没有进程生命周期钩子；新增 `observeOutput`。
- `run`：只有执行器 `execute`，没有 CLI、stdin 与 `agent_helpers.js`；语法错误的位置由注入的定位器给出（见运行流程第 3 步）。
- `index`：只有嵌入路径的 `installEgoSdk`（包装绑定）与 `disposeEgoSdk`；助手与 `console` 不装到全局，作为参数传给脚本。
- `page-context-guard`：改为参数遮蔽（见运行流程第 2 步），提示文字改为"脚本在 PiArc 的脚本宿主里运行"。
- `public-api-schema`：说明文字按 PiArc 的行为改写（截图、下载、粘贴、`fetch` 的 `saveAs`），新增 `requestAccess`。

## 未移植

`learning/`、`env.ts`、`http.ts`（`serverFetch`、`browserFetch`）、`clipboard.ts`、`update-notice.ts`、`skill-migration.ts`、`state.ts` 的工作区与文件写入、`index.ts` 的 CLI 入口、上述 v1 驱动；只测这些内容的上游测试（`learning`、`clipboard`、`update-notice`、`skill-migration`、`skill-package`、`workflows`、`taskspace-e2e`、`real-browser-*`、v1 驱动的测试）。

## 对主进程的依赖

- CDP 经 `{ op: 'cdp', space, message }` 发出，答复与事件经 `onCdp` 回来。除仿真的 Target 子集（`getTargets`、`attachToTarget`、`detachFromTarget`、`setAutoAttach`、`setDiscoverTargets`）外，SDK 还会发 `Target.activateTarget`、`Target.closeTarget`（`page.close`、`finish`、回滚）、`Target.getTargetInfo`，`download.cancel()` 发 `Browser.cancelDownload`；这些被拒时对应操作失败。
- 下载依赖标签会话上的 `Page.downloadWillBegin` 与 `Page.downloadProgress`，完成事件带 `filePath`（暂存名）。
- `print` 是临时输出，`finish` 的 `output` 是完整的权威输出（替换已打印的内容）。

## 命令

| 命令 | 用途 |
|---|---|
| `npx vitest run apps/desktop/src/browser-host` | 本目录全部测试 |
| `npx tsc -b apps/desktop/src/browser-host` | 只构建这个工程（`npm run typecheck` 包含它） |
| `npx eslint apps/desktop/src/browser-host` | lint |
