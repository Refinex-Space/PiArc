# @piarc/desktop

Electron 客户端：主进程只做平台集成与转发，渲染进程只做呈现，业务逻辑在 Core 与 Agent Host（ADR-0013）。transcript 与 composer 的库选型见 ADR-0022。

## 命令

在仓库根目录执行。新机器或 `npm ci --ignore-scripts` 之后先下载 Electron 二进制：`node node_modules/electron/install.js`。

| 命令 | 用途 |
|---|---|
| `npm run build:core` | 构建 Core 的开发版 `.node`（`target/piarc-core/development/`）；源码树运行、`dev` 形态与 Vitest 集成测试都加载它 |
| `npm run start -w @piarc/desktop` | 开发服务器模式（`electron-forge start`，HMR，放宽的开发 CSP） |
| `npm run package:desktop` | 发布构建打包到 `apps/desktop/out/release/`（发布 fuses）；先构建该类型的 Core、Agent Host bundle，并下载校验内置 node、rg、fd |
| `npm run package:desktop -- --flavor development` | 同上，打包到 `out/development/`，同时生成 `.vite/` 生产构建；L4 前必须运行 |
| `npm run package:desktop -- --flavor release --arch x64 --make` | 指定架构并出安装包：macOS 为 `out/<flavor>/make/dmg/<arch>/*.dmg` 与 `make/zip/darwin/<arch>/*.zip`（x64 需 `rustup target add x86_64-apple-darwin`） |
| `node scripts/ci/check-app-layout.mjs --flavor <f> [--arch <a>] [--json <file>]` | 打包产物的布局（第 5.6 节）与 macOS 签名分层检查（21 项） |
| `node scripts/release/pack-windows.mjs --arch x64 --flavor development --versions 0.0.1,0.0.2` | Windows：vpk 打 Velopack 安装包（CI 中运行，需要 .NET SDK） |
| `node scripts/dev/s6-probe.mjs serve\|variant\|agent-host\|notify\|keychain …` | S6 首次运行检查清单中要人在场的步骤（驱动已安装的开发构建，见 `docs/spikes/S06-first-run-checklist.md`） |
| `npm run test:e2e -w @piarc/desktop` | L4：两种形态（`dev`、`packaged`）的冒烟与安全用例；`PIARC_EVIDENCE_TASK=Txx` 把证据写到 `tmp/evidence/Txx/l4/` |
| `npm run check:fuses` | 读 `out/release/` 产物的 fuse 与 `fuses.mjs` 比对；`-- --flavor development` 查开发构建 |
| `npx vitest run apps/desktop` | 主进程纯函数的单元测试，以及 `core.integration.test.ts`（真实 Core 在 Node 中跑事件通道，需先 `npm run build:core`） |
| `npm run bench:s2 -- --form packaged` | S2 基准（默认 10 万事件/分钟 × 5 分钟），JSON 写到 `tmp/evidence/T04/bench/`；`--minutes 0.5` 快速版 |
| `npm run bench:s1 -- --form packaged` | S1 基准（transcript）：100 token/s 流式 60 s、1 万条滚动、1,000 条冷加载、渲染进程内存；帧数据来自 CDP 追踪，JSON 写到 `tmp/evidence/T09/bench/`；`--seconds`、`--scroll-seconds`、`--cold-runs` 可调 |
| `npm run bench:s7 -- --form packaged` | S7 基准（终端）：`cat` 大文件与键入回显，JSON 写到 `tmp/evidence/T10/bench/` |
| `npx vitest run apps/desktop/src/renderer` | 渲染进程纯逻辑的单元测试：增量 Markdown、自动闭合、转换与链接净化、滚动跟随、流式节奏、store、复制、composer |

## 结构

- `src/main/main.ts`：主进程入口，只做生命周期与模块装配。`src/preload/preload.ts`：`window.piarc`。`src/renderer/`：React，入口 `index.html` → `main.tsx`。`src/shared/ipc.ts`：通道名与 `PiarcApi` 类型，三方共用。
- 四个 TS 工程分开：`src/main`、`src/preload` 不含 DOM 类型，`src/renderer` 不含 Node 类型；`tsconfig.config.json` 管 Forge、Vite、Playwright 配置与 `fuses.mjs`，`e2e/` 是 L4。
- 安全基线（架构第 10.3 节，逐条对照见 `docs/spikes/S10-electron-security.md`）：
  - `app-scheme.ts`、`app-protocol.ts`、`asset-path.ts`：`app://piarc` 自定义协议与路径校验；
  - `security/csp.ts`：生产 CSP；`dev-server.ts`：开发服务器模式的全部放宽；
  - `security/navigation.ts`：导航、重定向、新窗口、`<webview>` 守卫；`security/permissions.ts`：权限默认拒绝与放行清单；`security/origin.ts`：origin 计算；
  - `ipc/register.ts`、`ipc/sender.ts`：IPC 注册与来源校验；`external-links.ts`：外链确认；
  - `window.ts`、`web-preferences.ts`：窗口工厂与固定的 webPreferences。
- Core（T04，ADR-0014）在 `src/main/core/`：
  - `native-path.ts`：`.node` 路径的唯一解析处。源码树指向 `target/piarc-core/development/`，打包后是 `app.asar.unpacked/native/<名>`（`forge.config.ts` 的 `packageAfterCopy` 拷入，`plugin-auto-unpack-natives` 移出 asar）；`load.ts` 用 `process.dlopen` 加载并校验导出；
  - `core-host.ts`：窗口打开前启动 Core，`will-quit` 时先 `await shutdown()` 再退出；
  - `router.ts`：路由键 → 窗口表，每次 Core 投递给每个订阅窗口发一条消息，不读载荷；`event-ipc.ts`：每次页面加载一个 `MessageChannelMain`（`port2` 经 `EVENTS_PORT_CHANNEL` 交给 preload），`subscribe`/`unsubscribe` 两个命令；
  - `test-hooks.ts`：加载的是开发版 Core 时才装 `globalThis.__piarcTestHooks`（类型在 `src/shared/test-hooks.ts`），L4 与基准经 `app.evaluate` 使用；
  - `native/*.d.ts`：NAPI-RS 生成的 L1 快照，不手改。
- `src/renderer/probe/`：`#/event-probe` 测试页，订阅、计数、校验序号，经 `globalThis.__piarcEventProbe` 暴露统计（类型在 `src/shared/event-probe.ts`）。
- transcript（T09，架构第 8.4 节）在 `src/renderer/transcript/`：
  - `item-store.ts`：最小 store，把协议的 `turn/*`、`item/*` 通知归约成行，按行订阅（T18 的正式 store 取代它）；`streaming-driver.ts`：一个 rAF 循环按 `pacer.ts` 的节奏把流式消息喂给 Markdown Worker；
  - `markdown/`：`incremental.ts`（只重新词法分析不稳定的尾部）、`autoclose.ts`、`to-ir.ts`（marked 词法单元 → `ir.ts` 的块与 span）、`text.ts`（字符引用解码、`safeHref`）、`MarkdownView.tsx`（只用 React 元素渲染）、`markdown-client.ts`；
  - `highlight/`：`languages.ts`（别名与支持的语言）、`highlight-client.ts`（结果缓存）、`CodeBlock.tsx`；
  - `scroll-follow.ts`（状态机）、`use-scroll-follow.ts`（接到滚动元素）、`TranscriptList.tsx`（@tanstack/react-virtual 虚拟列表）、`row-heights.ts`、`Rows.tsx`、`copy.ts`、`Transcript.tsx`；
  - 常量集中在 `constants.ts`：`SCROLL_FOLLOW`（解除、恢复、按钮阈值与用户输入窗口）、`STREAMING`（流式节奏）、`VIRTUAL_LIST`（预渲染范围与估算参数）。
- Worker 在 `src/renderer/workers/`，以 ES module 从应用协议加载（`vite.renderer.config.ts` 的 `worker.format: 'es'`），同样受 CSP 约束：
  - `markdown.worker.ts`：请求 `append`（流式文档追加，`final` 结束）、`parse`（成批解析已完成的文档）、`drop`；响应 `updates`，每个文档给 `keep`（保留前几个块，同一对象）与之后的 `blocks`。类型与守卫在 `transcript/markdown/protocol.ts`；
  - `highlight.worker.ts`：shiki core + JavaScript 正则引擎，请求 `highlight`（`id`、语言 id、代码），响应 `highlighted`（每行的 token：文本、明暗两套颜色、字形位）或 `failed`。类型在 `transcript/highlight/protocol.ts`；
- composer（T09）在 `src/renderer/composer/`：`schema.ts`（段落与 mention 节点）、`mention-plugin.ts`、`serialize.ts`（发送文本、mention 数据、显示片段三者分开）、`intents.ts`（键位语义）、`ime-guard.ts`、`Composer.tsx`。
- 终端（T10，ADR-0017）：主进程 `src/main/core/terminal-ipc.ts`（六个命令、终端归属，帧原样作为拉取请求的返回值交回，ADR-0023）；渲染进程 `src/renderer/terminal/`：`frame/`（帧解码器与 `Screen`，共享样本 `frame-samples.json` 由 Rust 生成）、`remote-renderable.ts`、`controller.ts`（rAF 拉取、隐藏不拉取、输入后连续拉取、键盘与输入法）、`keys.ts`、`TerminalLab.tsx`（`#/terminal-lab`，`?manual` 不自带 shell，`globalThis.__piarcTerminalLab`，类型在 `src/shared/terminal-lab.ts`）；`vendor/ghostty-web/` 是 fork 的 `CanvasRenderer`（MIT，来源与改动见其 README）。
- 打包（T12，架构第 5.6、10.3、13.2 节）在 `packaging/`：
  - `agent-host-layout.mjs`：`Resources/agent-host/` 的布局（`agentHostLayout`）与拷入（`copyAgentHostResources`，在 `forge.config.ts` 的 `postPackage` 中，签名之前）；Core 的 `BundledRuntime` 解析同样的相对路径；
  - `macos-sign.mjs`：分层 ad-hoc 签名：先 `--deep` 重签 Electron（此时还没有 agent-host），再逐个签 Resources 中的 Mach-O（跳过内置 node），最后不带 `--deep` 签 bundle；hardened runtime 与 `entitlements.mac.plist`（只有 `allow-jit`、`disable-library-validation`）；
  - `maker-dmg.mjs`：用 `hdiutil` 出 DMG 的 Forge maker（maker-dmg 依赖要安装脚本编译的原生模块）；ZIP 用 `@electron-forge/maker-zip`；
  - `velopack-runtime.mjs`：Windows 构建把 Velopack 绑定（只含目标架构的 `.node`）拷进 app.asar 的 `node_modules/`；主进程 `src/main/platform/velopack.ts` 在最开始运行它的钩子；
  - 图标取 `design/brand/icon`（`.icns`/`.ico`），bundle id 与 AppUserModelID 取应用标识（`app-identity.mjs`、`src/main/app-identity.ts`，`app-identity.test.mjs` 保证与 Rust 的定义一致）。
- `src/renderer/lab/`：`#/transcript-lab` 原型页，用 `fixtures/` 的合成事件驱动 transcript 与 composer，经 `globalThis.__piarcTranscriptLab` 给 L4 与 S1 基准用（类型在 `src/shared/transcript-lab.ts`）。XSS 载荷集在 `src/shared/xss-payloads.ts`。

## 不变量

- 新增 IPC 命令：在 `src/shared/ipc.ts` 加通道与 `PiarcApi` 成员，处理函数经 `registerHandler` 注册（ESLint 禁止直接 `ipcMain.handle`），参数当作 `unknown` 校验；同步更新 `e2e/preload.e2e.ts` 的键快照与 S10 报告。
- preload 不暴露 `ipcRenderer`，只能 `require('electron')`（ESLint 禁止 Node 内置模块）；以后的事件 API 必须剥掉 Electron 的 event 对象再交给页面回调。
- 新增权限放行：在 `PERMISSION_ALLOWLIST` 加条目并写 `reason`，补 L4 用例，记入 S10 报告。
- 不得放宽 `PRODUCTION_CSP`。开发服务器模式的放宽只放在 `dev-server.ts`，主进程只在 `import.meta.env.DEV` 下调用，打包时被删除。
- 窗口只经 `createMainWindow` 创建（ESLint 禁止别处 `new BrowserWindow`）；导航与新窗口守卫由 `app.on('web-contents-created')` 装到所有 webContents。
- 外链只放行 `https:`、`http:`、`mailto:`（不带用户信息），必须先经原生确认框，每个窗口同一时刻最多一个（`LinkConfirmations`）。
- 主进程比较 origin 用 `originOf`，不用前缀匹配，也不直接用 `new URL(x).origin`。
- 主进程只按路由键转发事件批次，不解析载荷；批次一律经结构化克隆复制（Electron 45 的 `MessagePortMain` 只能转移端口，ADR-0019）；不要尝试转移 `ArrayBuffer`。
- 终端：窗口只能用自己创建的终端（`TerminalOwners`），创建它的页面消失（窗口销毁、渲染进程崩溃、重载）时关闭它的终端；主进程不解析拉取请求与帧。改 `vendor/ghostty-web/` 下的代码要同步其 README 的改动清单，保留 MIT 声明。
- 渲染进程不加载原生模块；Core 只经主进程（`window.piarc.subscribeEvents` 等）。页面回调只收到批次，没有 Electron 的 event 对象。
- 安全渲染（架构第 10.3 节）：渲染进程不从 HTML 字符串建 DOM，ESLint 禁止 `innerHTML`、`outerHTML`、`dangerouslySetInnerHTML`、`insertAdjacentHTML`、`createContextualFragment`、`setHTMLUnsafe`、`document.write`；模型输出里的原始 HTML 作为 `html` 节点按文本显示；链接只保留 `safeHref` 通过的 `https:`、`http:`、`mailto:`，点击经 `window.piarc.openExternal`（主进程确认框）；图片不加载，显示为链接；代码高亮只输出 token 与颜色。
- 高亮不放宽 CSP：shiki 用 `@shikijs/engine-javascript`，不用需要 `wasm-unsafe-eval` 的 Oniguruma 引擎；语法按需加载，每种一个 chunk，`GRAMMARS` 与 `languages.ts` 的别名表一起改。
- 输入法守卫：所有键盘处理先过 `isImeComposing`（`isComposing`、`keyCode === 229`、`view.composing`）。composer 在 `handleDOMEvents.keydown` 里先拦，ProseMirror 的按键处理整个跳过且不 `preventDefault`；`handleTextInput` 里的 `@`、`/` 触发也先查 `view.composing`。
- 滚动跟随只认用户输入（滚轮、触摸、键盘、按住滚动条）引起的滚动；贴底在 ResizeObserver 回调里做（布局后、绘制前），阈值只改 `constants.ts`。
- 流式期间只有流式那一行重新渲染：行组件按 id 订阅 store 与解析结果，块组件按对象身份记忆化；改动时用 L4 的渲染计数用例（`transcript-render.e2e.ts`）验证。

## 打包产物的测试入口（S6）

- 开发构建的 Core 导出 `agentHostProbe`（从 `process.resourcesPath` 下的 `agent-host/` 按生产方式启动 Agent Host，跑一轮对话）与 `keychainProbe`；主进程测试钩子另有 `showNotification`。模型经测试数据目录的 `pi/models.json` 指向 mock provider，不需要额外的启动参数；发布构建没有这些导出。
- `e2e/agent-host.e2e.ts`、`e2e/agent-host-kill.e2e.ts`、`e2e/notification.e2e.ts` 只在 `packaged` 项目运行（`playwright.config.ts` 的 `testIgnore`）：`dev` 形态没有 `Resources/agent-host/`，签名也是 Electron 自己的。`agent-host-kill.e2e.ts` 只在 Windows 运行：回合进行中 `taskkill /F` 主进程，检查 Job Object 结束 Agent Host 的整棵进程树（S8）。两者共用 `e2e/agent-host.ts` 的 `startMock`。

## 开发构建与发布构建

- fuse 配置的单一来源是 `fuses.mjs`；`PIARC_BUILD_FLAVOR`（由 `package:desktop --flavor` 设置）选择配置，默认 `release`。开发构建只多开 `EnableNodeCliInspectArguments`，L4 的打包形态靠它被 Playwright 驱动。
- `electron-forge start` 用 node_modules 中的 Electron，不写 fuse；界面来自 Vite 开发服务器，开发服务器 origin 加入可信 origin，CSP 放宽三项（见 `dev-server.ts`）。

## 易错点

- `dev` 形态跑的是上次打包生成的 `.vite/`：改了 `src/` 要重新 `package:desktop -- --flavor development`；`electron-forge start` 会清掉 `.vite/renderer`，之后 L4 报 "Production bundle not found"。
- Node 的 `URL` 不认识 Chromium 注册的标准协议：`new URL('app://piarc/').origin` 是 `'null'`。
- 导航被取消后 Playwright 定位器会一直等导航完成：拦截之后用 `page.evaluate` 检查，会触发导航的点击用 `page.mouse.click`。
- 发布构建仍接受 Chromium 的 `--remote-debugging-port`（没有对应 fuse），登记为 I10。
- 应用启动早期打印的日志行，L4 夹具接上 stdout 之前就被读走了；要断言启动状态，用测试钩子读主进程状态，不等日志。
- `monitorEventLoopDelay` 记录的是两次采样之间的完整间隔，每个值都含采样间隔（钩子用 1 ms）；比较预算时按原始值算偏保守。Windows 默认计时器粒度约 15.6 ms，1 ms 的采样实际约 15.6 ms 一次，空闲的 Node 就是 p50 15.6 ms、p99 16.6 ms（S2 报告第 8 节）：在 Windows 上要和同机空闲基线一起看。
- 基准与 L4 都要开发版 Core：发布版没有测试钩子，`expectTestHooks` 会直接报错提示重新打开发构建。
- Electron 的 `contentTracing` 输出 protobuf 追踪；要 JSON 就用 CDP 的 `Tracing.start`（`streamFormat: 'json'`），S1 基准就是这样做的。
- 帧时间的口径：rAF 间隔与 `AnimationFrame`（LoAF 口径）在 60 Hz 屏上空闲时也约 16.7 ms，不能拿来和"p99 ≤ 16 ms"比；S1 基准用两次 `BeginMainThreadFrame` 之间主线程任务的总耗时（每帧工作量）。
- 复制相关的 L4 会写系统剪贴板：用例经 `withSavedClipboard` 读出原内容、结束后写回（只恢复文本）。Windows 上 Chromium 以 CRLF 写纯文本，`readClipboard` 已规范为 LF。
- Windows 上的系统通知：Electron 先发 `show`，系统拒绝（未经安装、没有带 AUMID 的开始菜单快捷方式，或用户关了通知）时再发 `failed`；以最后一个事件为准。
- L4 里 `app.process().pid` 不一定是主进程（Windows 上可能是 Playwright 前面的启动器）：要主进程 pid 用 `app.evaluate(() => process.pid)`。
- 从 Node 调 PowerShell 时关掉它的 stdin（`stdio: ['ignore', …]`），否则命令打印完结果还会一直等 stdin。
- ProseMirror 自己在合成期间不分发按键，所以只测合成中的按键测不出守卫是否生效；`composer.e2e.ts` 另有"合成开始前到达的 229 按键"和"合成文本恰为 `@`、`/`"两类用例，去掉守卫时它们会失败。
- 页面处理按键之后，经事件 MessagePort 投来的消息要到下一帧的 rAF 之后才被处理（`invoke` 的回复不受影响）：所以终端帧作为 `requestTerminalFrame` 的返回值送达，不要改回事件端口（ADR-0023，S7 报告第 5.2 节）。
- 终端 L4（`terminal.e2e.ts`、`terminal-tui.e2e.ts`）按平台选程序：macOS 用 `/bin/sh`、`cat`、`vim`、`top`；Windows 用 cmd（`PROMPT=$$$S`）、PowerShell、Git 自带的 vim（由 `git --exec-path` 找到）与 `e2e/programs/show-keys.ts`（Node 直接运行 `.ts`）。ConPTY 下 conhost 会重新编码按键，Windows 版的按键用例只断言按键到达程序。
- 不要在 `postPackage` 之前把内置 node 放进 bundle：fuses 插件与 `resealElectron` 的 `--deep` 会把它改成 ad-hoc 签名。新增随包的 Mach-O 文件放在 Resources 下即可，`signResourcesAndBundle` 会扫描签名；要保留原签名的目录加进 `keepSigned`。
- 本机 Gatekeeper 评估被关闭时（`spctl --status` 为 `assessments disabled`），`spctl --assess` 一律显示 accepted，不能作为首次打开的证据；首次运行检查要在开启 Gatekeeper 的机器上做。
- MCP 夹具要先 `npm pack` 再经 `npx --package <tgz>` 启动：`npx <目录>` 会链接目录并 chmod 其中的 bin，在 Agent Host 的 Seatbelt 下被拒绝（真实 MCP 包来自 registry 的 tarball，不受影响）。
- 贴底依赖 ResizeObserver 观察列表的尺寸容器（`TranscriptList` 的 sizer）：换虚拟列表实现时要保证内容增长能在同一帧报告尺寸变化，react-virtuoso 做不到（ADR-0022）。

## 参考

- 架构第 3.4、6.11、7.6、8.1–8.5、10.3、11 章；ADR-0013、ADR-0014、ADR-0017、ADR-0018 第 1 条、ADR-0022、ADR-0023；`docs/spikes/S10-electron-security.md`、`S02-napi-event-channel.md`、`S01-transcript-composer.md`、`S07-terminal.md`；`docs/engineering/testing.md` 第 9 节。
