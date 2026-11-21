# S10 Electron 安全基线

- 任务：T03（2026-11-14）
- 范围：S10 中 CSP、导航、IPC、fuses 这一层。Markdown 渲染路径上的 XSS 载荷集由 T09 完成（结果见 `S01-transcript-composer.md` 第 5 节），S10 的整体结论由 R1 汇总。
- 结论：macOS 上 T03 负责的部分**通过**；Windows（W0）**通过**：本机按 CI `desktop` 作业的步骤运行，开发构建打包、L4 两种形态（含全部安全用例）、发布构建打包与 fuse 校验都通过（第 8 节）。

## 1. 验证环境

| 项 | 版本 |
|---|---|
| 系统 | macOS 26.5.2（25F84），arm64 |
| Electron | 45.3.2（npm `latest`；受支持大版本 45、44、43），Chromium 156.0.8078.100，内置 Node 24.22.2（与 `.nvmrc` 一致） |
| Electron Forge | 8.0.1（`plugin-vite`、`plugin-fuses`），`@electron/fuses` 2.1.3 |
| Vite / React | 8.3.8 / 19.3.1，`@vitejs/plugin-react` 6.3.0 |
| Playwright | `@playwright/test` 1.65.1（Electron 支持，不下载浏览器） |
| 本机 Node | 24.14.1（运行脚本与测试；CI 用 `.nvmrc` 的 24.22.2） |

## 2. 做了什么

- `apps/desktop` 三部分工程：主进程、sandboxed preload、React 渲染进程，外加只含 IPC 契约的 `src/shared`。四个 TS 工程分开配置：主进程与 preload 不含 DOM 类型，渲染进程不含 Node 类型。
- 按架构第 10.3 节落实渲染进程加固、preload 白名单、IPC 来源校验、单实例锁与 fuses，位置见第 3 节清单。
- L4 基座：Playwright 驱动两种形态，开发形态（node_modules 中的 Electron + `.vite/` 生产构建，经 `app://` 加载）与开发构建的打包产物；每个用例独立启动、独立 user-data 目录。
- `scripts/ci/check-fuses.mjs`：读打包产物的实际 fuse，与 `apps/desktop/fuses.mjs` 的发布配置逐项比对。
- 变异对照：临时放开 CSP、导航守卫、权限、IPC 来源校验与外链协议白名单，重新打包后运行安全用例，确认用例能发现回退；之后还原。
- 对发布构建做运行时探测：`ELECTRON_RUN_AS_NODE`、`--inspect`、`NODE_OPTIONS`、`--remote-debugging-port`。

## 3. Electron 官方安全清单逐条

清单原文见 `docs/research/electron-stack.md` 第 3 节。"L4"指 `apps/desktop/e2e/` 下的 Playwright 用例，两种形态都运行；"单元"指与源文件同目录的 Vitest 用例。

| # | 清单项 | 落实方式 | 测试或检查 |
|---|---|---|---|
| 1 | 只加载安全内容 | 界面只从 `app://piarc` 加载（注册为 `secure`）；CSP 禁止加载任何远程资源；应用不加载远程页面 | L4 `csp.e2e.ts`（外部 fetch、外部图片被拦）、`app-instance.e2e.ts`（`isSecureContext` 为 true） |
| 2 | 不对远程内容开启 Node 集成 | `nodeIntegration`、`nodeIntegrationInWorker`、`nodeIntegrationInSubFrames` 固定为 false | 单元 `web-preferences.test.ts`；L4 `preload.e2e.ts`（`require`、`process`、`module`、`Buffer` 均为 `undefined`） |
| 3 | 所有渲染进程开启上下文隔离 | `contextIsolation: true` 固定在窗口工厂 | 单元 `web-preferences.test.ts`；L4 `preload.e2e.ts`（页面只看到 `window.piarc`，扫描不到 `ipcRenderer`） |
| 4 | 开启进程沙箱 | `sandbox: true`，并在 `ready` 前调用 `app.enableSandbox()` 全局强制 | 单元 `web-preferences.test.ts`；L4 `preload.e2e.ts`（`app.getAppMetrics()` 报告窗口渲染进程 `sandboxed: true`） |
| 5 | 所有会话设置权限处理器 | `setPermissionRequestHandler`、`setPermissionCheckHandler` 默认拒绝，`setDevicePermissionHandler` 返回 false；放行清单 `PERMISSION_ALLOWLIST` 集中定义，T03 时为空，T09 加入 `clipboard-sanitized-write`（"复制本条消息"按钮用 `navigator.clipboard.writeText`；只写、由 Chromium 净化，读剪贴板仍拒绝）；`session-created` 时对新会话同样安装 | 单元 `permissions.test.ts`（放行清单只有这一项且有理由，`clipboard-read` 等仍拒绝）；L4 `permissions.e2e.ts`（通知、摄像头、地理位置被拒，权限查询为 `denied`）与 `transcript-copy.e2e.ts`（复制按钮写入剪贴板） |
| 6 | 不关闭 `webSecurity` | 固定为 true；`new BrowserWindow` 只允许出现在窗口工厂（ESLint） | 单元 `web-preferences.test.ts`；ESLint `no-restricted-syntax` |
| 7 | 定义 CSP | 主进程在 `protocol.handle` 的每个响应上发送 `Content-Security-Policy` 响应头：`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`，另加 `X-Content-Type-Options: nosniff` | 单元 `csp.test.ts`；L4 `csp.e2e.ts`（响应头存在；注入的内联脚本、内联事件属性、`eval`、`new Function` 都不执行；外部 fetch 与图片触发 `connect-src`、`img-src` 违规） |
| 8 | 不开启 `allowRunningInsecureContent` | 固定为 false | 单元 `web-preferences.test.ts` |
| 9 | 不开启实验特性 | `experimentalFeatures: false` | 单元 `web-preferences.test.ts` |
| 10 | 不使用 `enableBlinkFeatures` | 不设置该项 | 单元 `web-preferences.test.ts`（断言不存在该键） |
| 11 | `<webview>` 不用 `allowpopups` | 不适用：不使用 `<webview>`。`webviewTag: false`，且全局 `will-attach-webview` 一律 `preventDefault` | 单元 `web-preferences.test.ts`；代码 `security/navigation.ts` |
| 12 | `<webview>` 校验选项与参数 | 不适用：同上，任何 `<webview>` 都不允许挂载 | 同上 |
| 13 | 禁止或限制导航 | `will-navigate` 与 `will-redirect` 中解析 origin 后与可信 origin 整串比较，不用前缀；在 `app.on('web-contents-created')` 中给所有 webContents 安装 | 单元 `navigation.test.ts`、`origin.test.ts`；L4 `navigation.e2e.ts`（改 `location`、点击链接、重定向都被拦，窗口留在 `app://piarc/index.html`；同源导航放行） |
| 14 | 禁止或限制新窗口 | `setWindowOpenHandler` 一律返回 `deny`，同样经全局钩子安装 | L4 `external-links.e2e.ts`（`window.open` 与 `target=_blank` 链接被拒，窗口数仍为 1） |
| 15 | 不对不可信内容调用 `shell.openExternal` | 只经 `window.piarc.openExternal`：只放行 `https:`、`http:`、`mailto:`，长度上限 8192，拒绝带用户信息的地址；每个窗口同一时刻最多一个确认框（R1-E5）；主进程弹原生确认框显示规范化后的完整地址（国际化域名显示为 punycode），确认后才打开；对话框与 `shell.openExternal` 经 `ExternalLinkPort` 调用 | 单元 `external-links.test.ts`（端口替身）；L4 `external-links.e2e.ts`（主进程中替换为记录替身：确认后才打开、取消不打开、`javascript:`、`file:`、`data:` 等不弹框直接拒绝） |
| 16 | 使用当前版本的 Electron | 锁定 45.3.2（最新稳定版）；升级节奏按 ADR-0018 第 8 条 | `apps/desktop/package.json` 与 `npm view electron dist-tags` |
| 17 | 校验所有 IPC 消息的发送方 | 所有 `ipcMain.handle` 经 `createIpcRegistrar` 注册（ESLint 禁止直接调用）；先校验 `senderFrame` 非空且 `origin` 与可信 origin 整串相等，否则拒绝并记录日志 | 单元 `sender.test.ts`（空 frame、其他 origin、`app://piarcx` 等前缀相似 origin）；L4 `preload.e2e.ts`（合法调用通过；`data:` 页面与 `app://piarcx` 页面加载同一 preload 后调用被拒） |
| 18 | 不用 `file://`，改用自定义协议 | `protocol.registerSchemesAsPrivileged`（`standard`、`secure`、`supportFetchAPI`，不 `bypassCSP`、不允许 service worker）+ `protocol.handle` 从 `.vite/renderer/main_window`（打包后在 app.asar 内）提供文件，拒绝越出目录的路径；`GrantFileProtocolExtraPrivileges` fuse 关闭 | 单元 `asset-path.test.ts`（路径穿越、编码绕过、错误 host）；L4 `app-instance.e2e.ts`（`location.protocol` 为 `app:`）；`npm run check:fuses` |
| 19 | 检查可修改的 fuses | 发布配置见第 4 节；`strictlyRequireAllFuses: true`；`check-fuses.mjs` 读产物比对 | 单元 `check-fuses.test.mjs`；`npm run check:fuses`；第 5.4 节的运行时探测 |
| 20 | 不向不可信页面暴露 Electron API | preload 经 `contextBridge` 只暴露 `getAppVersion`、`openExternal` 两个函数，不暴露 `ipcRenderer`；返回值在 preload 中校验类型；本任务没有事件 API，以后新增时必须剥掉 Electron 的 event 对象（`apps/desktop/CLAUDE.md`）；preload 只能 `require('electron')`（ESLint 禁止导入 Node 内置模块）。T10 加入六个终端函数：`createTerminal` 只能启动用户的登录 shell（程序、参数、环境不由页面决定，测试用的其他程序只能经开发构建的主进程测试钩子创建）；其余命令在主进程校验参数（尺寸 1–1000、按键消息的字段与长度、输入文本 ≤ 64 Ki 字符）并且只允许操作本窗口创建的终端，窗口销毁、渲染进程崩溃或页面重载时关闭它的终端（R1-E2），终端的事件路由 `term/<id>` 也只有所属窗口能订阅（R1-E4）；帧是拉取请求的返回值（preload 校验为 `Uint8Array`，ADR-0023），事件回调只收到数据，没有 event 对象。T18 加入会话、工作区、信任、偏好、设置窗口与通知计数的 21 个函数（白名单见 `e2e/preload.e2e.ts`，共 31 个）：主进程逐个校验参数（会话 id 按 Core 规则、绝对路径、标题 ≤ 200 字符、偏好只接受白名单键与值、计数 0–9999）；删除会话由主进程弹原生确认框，页面无法绕过；应用事件（`piarc:app.event`：偏好、菜单命令、打开会话、窗口焦点）经 `onAppEvent` 交给页面，同样剥掉 event 对象。信任决定没有原生确认，登记 I79。T19 加入 composer 的 10 个函数（`steer`、`followUp`、`abort`、`compact`、`editQueueItem`、`deleteQueueItem`、`storeAttachment`、`searchFiles`、`cancelFileSearch`、`composerInfo`，共 41 个）：输入在主进程按形状与大小校验（请求键与条目 id 为 1–128 个 `[A-Za-z0-9._:-]`、文本 ≤ 1,000,000 个 UTF-16 码元、提及 ≤ 100、附件 ≤ 10、附件字节 ≤ 33 MiB、搜索根为绝对路径），含义由 Core 校验（提及在文本范围内、附件必须是本会话 `attachments/` 下 Core 存过的文件、附件类型按内容核对、搜索根必须在已知工作区内）。T20 新增 `setPermissionMode`、`answerApproval`（共 43 个）。主进程校验模式与答复字段，永久授权将本次提交的规则、目录逐项列入原生确认框，默认和取消按钮都取消；Core 按会话、请求、版本、连接代次核对并保存。T21 增加 9 个窄方法，用于服务商配置、目录刷新、工作区与会话模型目录、切换预览、模型与 effort 选择。保存时凭据单独传入，页面只查询非密钥元数据；删除服务商由主进程弹出带服务商 ID 的原生确认框。T23 增加权限页的 4 个方法（`permissionRules`、`checkPermissionRule`、`updatePermissionRule`、`auditEvents`，共 56 个）：主进程校验工作区为绝对路径、来源层只能是 PiArc 的可写文件、规则单行且不超过 4,096 字符、审计查询的取值范围；新增或修改 allow 规则先弹主进程原生确认，页面无法绕过。`setPermissionMode` 切换到跳过权限前同样弹原生确认，Core 另核对用户级开关；"总是允许"的原生确认逐行列出全部规则。T24 增加只读的 `configDiagnostics`（共 57 个）：主进程校验工作区为绝对路径，Core 只读取设置文件、不写任何文件。T27 增加只读的 `contextUsage`，`compact` 增加可选的重点说明（主进程按输入文本同样的长度上限校验）。T28 增加 7 个方法（`rewindPreview`、`rewind`、`undoRewind`、`sessionChanges`、`discardChange`、`switchBranch`、`forkSession`，共 65 个）：主进程校验会话 id、回合与条目 id 为 1–128 个 `[A-Za-z0-9._:-]`、回退范围为四个取值之一、文件路径为 Core 给出的不超过 4,096 字符的字符串、版本为 64 位十六进制或 `absent`、hunk 为非负整数；文件是否属于该会话的记录、版本是否仍是当前内容由 Core 在路径锁内核对，回退可经 `undoRewind` 撤销，所以不另弹原生确认。T29 增加 4 个方法（`setModelPreferences`、`startLogin`、`answerLogin`、`logoutProvider`，共 69 个）：主进程校验服务商与登录 id 为 1–128 个 `[A-Za-z0-9._:-]`、偏好与答复为不超过输入文本上限的字符串，偏好的取值范围由 Core 校验；退出登录由主进程弹出带服务商 ID 的原生确认框；登录页不在应用窗口加载，"在浏览器中打开"经 `openExternal` 的原生确认交给系统浏览器，页面拿不到令牌（只收到 `core/login` 上的步骤与结果）。T31 增加 3 个方法（`listAgents`、`stopSubagent`、`subagentTranscript`，共 72 个）：主进程校验工作区为绝对路径、会话 id 按 Core 规则、窗口范围同 `transcriptWindow`；子会话是否属于该父会话的工作区由 Core 经父会话定位，只读转录与停止都不改动文件。T32 增加 2 个方法（`stopTask`、`readTaskOutput`，共 74 个）：主进程校验任务 id 为 `bg-` 加 12 位十六进制、偏移为非负安全整数、长度为 1–65536 或 null；读取由 Core 限制在 64 KiB 一段，页面拿不到整份输出；停止与 KillShell 走同一 Core 入口，只结束任务的进程树或子 agent，不改动文件。T34 去掉 `createTerminal`（没有会话的终端只能经开发构建的测试钩子创建），增加终端面板的 13 个方法（`openSessionTerminal`、`shareTerminal`、`terminalMouse`、`terminalFocus`、`terminalPaste`、`terminalScroll`、`terminalColors`、`terminalClearSelection`、`terminalSelectionText`、`terminalLinkAt`、`terminalSearch`、`terminalScreenText`、`terminalInfo`，共 86 个）与应用事件 `visibility`（ADR-0051）：会话终端归会话，任何窗口可用；写入（输入、按键、粘贴、鼠标按下与松开）、打开会话终端与共享给 agent 都要求该窗口 5 秒内有 Electron 报告的真实输入（`input-event`，页面脚本无法伪造），每会话至多 16 个终端，每窗口每终端一个在途拉帧；主进程校验鼠标消息（动作、按键 1–11、修饰位、有限坐标、点击 1–3）、滚动目标、颜色（`0xRRGGBB`）、粘贴 ≤ 1 MiB 字符、查询 ≤ 1,000 字符、单元格 0–1000，并检查 Core 返回的 JSON 后才交给页面。 | L4 `preload.e2e.ts`（键集合与快照一致、扫描不到 Electron 对象）；ESLint `no-restricted-imports`；单元 `terminal-ipc.test.ts`（无真实输入时写入被拒、会话终端跨窗口与重载可用、页面终端只属本页并随页面关闭、会话上限、在途拉帧上限、非法参数被拒、帧原样作为返回值）；L4 `t34-terminal.e2e.ts` |

## 4. 开发构建与发布构建的差异

| 项 | 发布构建 | 开发构建（`--flavor development` 打包） | 开发服务器模式（`electron-forge start`） |
|---|---|---|---|
| `EnableNodeCliInspectArguments` | 关 | 开（调试打包产物；Playwright 依赖它连接主进程） | 不写 fuse（node_modules 中的 Electron） |
| 其余 8 个 fuse | `RunAsNode` 关、`EnableCookieEncryption` 开、`EnableNodeOptionsEnvironmentVariable` 关、`EnableEmbeddedAsarIntegrityValidation` 开、`OnlyLoadAppFromAsar` 开、`LoadBrowserProcessSpecificV8Snapshot` 关、`GrantFileProtocolExtraPrivileges` 关、`WasmTrapHandlers` 开 | 与发布构建相同 | 不写 fuse |
| 界面来源 | `app://piarc` | `app://piarc` | Vite 开发服务器 `http://localhost:<端口>` |
| CSP | 生产策略 | 生产策略 | 放宽三项：`script-src` 加 `'unsafe-inline'`（React Refresh 预加载脚本）、`style-src` 加 `'unsafe-inline'`（Vite 注入 `<style>`）、`connect-src` 加 `ws://<开发服务器 host>`（HMR） |
| 可信 origin（导航、IPC） | `app://piarc` | `app://piarc` | `app://piarc` 与开发服务器 origin |

- 开发服务器模式的放宽全部在 `apps/desktop/src/main/dev-server.ts`，主进程只在 `import.meta.env.DEV` 为真时调用。打包时它是常量 false，打包工具删掉这些分支：发布构建的 `.vite/build/main.cjs` 中 `unsafe-inline` 出现 0 次（改用编译期常量之前是 1 次，代码不可达但字符串仍在包里）。
- L4 安全用例一律针对生产渲染产物运行，不在开发服务器模式下运行。
- 开发构建与发布构建只差一个 fuse，由单元测试 `check-fuses.test.mjs` 断言，打包后由 `check-fuses.mjs` 分别比对。

## 5. 实测数据

### 5.1 测试

| 检查 | 结果 |
|---|---|
| L4（`npm run test:e2e -w @piarc/desktop`） | 58 项通过：29 个用例 × 开发形态与打包形态，约 50 s |
| 单元（`apps/desktop/src/main/**/*.test.ts`、`scripts/ci/check-fuses.test.mjs`） | 42 项通过，1 项按平台跳过（Windows 反斜杠穿越用例，只在 Windows 运行） |
| ESLint 进程边界规则 | 临时违规文件触发全部 8 条预期错误：两种 `new BrowserWindow`、`ipcMain.handle`、`ipcMain.on`、preload 导入 `node:fs` 与 `path`、渲染进程导入 `electron` 与 `../main/` |
| CI 工作流 | actionlint 1.7.12 无发现 |

### 5.2 变异对照

同时放开五处控制后重新打包，开发形态的 25 个安全用例中 17 个失败：

- 失败（17）：CSP 6 项、导航拦截 3 项、新窗口与非白名单协议 2 项、权限 4 项、外来 origin 与前缀相似 origin 的 IPC 2 项；
- 通过（8）：确认后打开、取消不打开、同源导航、`window.piarc` 键集合、扫描 Electron 对象、Node 全局不可用、OS 沙箱、合法 IPC。这些用例对应的控制没有被放开。

### 5.3 fuses

`npm run check:fuses` 读取 `out/release/PiArc-darwin-arm64/PiArc.app`，9 个 fuse 全部与发布配置一致。临时把配置中的 `EnableCookieEncryption` 改为 false 后重跑，脚本退出码 1，并输出 `EnableCookieEncryption: expected disabled, found enabled`；还原后退出码 0。开发构建产物与开发配置比对同样 9 项一致。打包后 macOS 产物为 ad-hoc 签名（`Signature=adhoc`），`resetAdHocDarwinSignature` 生效。

### 5.4 发布构建的运行时探测

| 探测 | 结果 |
|---|---|
| `ELECTRON_RUN_AS_NODE=1 PiArc -e '…'` | 没有以 Node 运行（未输出标记），正常启动应用 |
| `PiArc --inspect=0` | 没有 `Debugger listening` 输出 |
| `NODE_OPTIONS='--require <不存在的文件>'` | 被忽略，没有模块加载错误 |
| `PiArc --remote-debugging-port=9333` | **生效**：`/json/version` 返回 HTTP 200，见第 6 节第 2 条 |

## 6. 发现

1. **Node 的 URL 解析器不认识 Chromium 的标准协议。** 主进程中 `new URL('app://piarc/index.html').origin` 是 `'null'`，而 Chromium 给页面的 origin 是 `app://piarc`。直接用 `URL.origin` 会让导航守卫拦掉应用内导航。已在 `security/origin.ts` 中对应用协议按 Chromium 的元组 origin 计算，导航与权限判断都经它；IPC 校验用的 `senderFrame.origin` 来自 Chromium，不受影响。
2. **发布构建仍接受 Chromium 的 `--remote-debugging-port`。** 这个开关不受任何 fuse 控制。能以这个参数启动 PiArc 的本机进程可以通过 CDP 在页面中执行脚本，进而调用 `window.piarc`。前提是攻击者已经能以当前用户身份运行程序，与 ADR-0018 已接受的"本机攻击者可篡改应用"属同一威胁等级；有副作用的操作仍要经 Core 的权限裁决。缓解方向是发布构建在启动时拒绝或移除该开关，可行性待验证。登记为 I10，建议 T45 处理。
3. **Playwright 驱动 Electron 依赖 `--inspect`。** 它等待 `Debugger listening` 输出后连接主进程，所以发布构建（`EnableNodeCliInspectArguments` 关闭）无法用 Playwright 驱动。L4 的打包形态因此运行开发构建，它与发布构建只差这一个 fuse；发布构建的 fuse 由 `check:fuses` 与第 5.4 节的探测覆盖。
4. **被拦截的导航会让 Playwright 的定位器一直等待"导航完成"。** L4 用例在拦截之后改为在页面内检查 DOM，可能触发导航的点击用 `page.mouse.click`。写法已记入 `docs/engineering/testing.md` 第 9 节。

## 7. ADR 触发条件

ADR-0013 的触发条件"威胁模型中的某项对策必须放松 Electron 安全基线才能实现"：未触发。开发服务器模式的 CSP 放宽只存在于开发构建，发布构建不含相关代码。

## 8. 后续

- Windows（W0，Windows 11 专业版 25H2，机器见 S2 报告第 8 节）：
  - CI 运行 43827342553 的 Windows `desktop` 作业中，安全与冒烟用例全部通过，只有三个复制用例因剪贴板 CRLF 在两种形态下失败（共 6 项），fuse 校验步骤因此没有运行。
  - 本机修复读剪贴板的辅助函数后（提交 9d6b01b），按同款步骤运行：`package:desktop -- --flavor development`；`test:e2e` 两种形态 138 项全部通过，含新改为 Windows 程序的终端用例与 `agent-host-kill.e2e.ts`；`package:desktop` 发布构建后 `check:fuses` 9 项一致。
  - 下一次推送后 CI 复核。
- T09：Markdown 渲染路径的 XSS 载荷集（已完成：`src/shared/xss-payloads.ts`、`e2e/transcript-security.e2e.ts`；ESLint 禁止渲染进程使用 `innerHTML` 等 HTML 字符串入口）。
- T12：应用标识（D2）确定后，协议名 `app` 与 bundle id（当前为打包工具默认的 `com.github.Electron`）随之确定；签名与安装包。
- T18：替换 Electron 默认菜单；权限放行清单按功能需要增加时，在 `PERMISSION_ALLOWLIST` 中写理由并补用例。
- T45：第 6 节第 2 条（I10）。
