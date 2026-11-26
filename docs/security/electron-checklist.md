# Electron 安全清单复核

- 任务：T45（2026-11-22），复核 T03 的 S10 基线（[S10 报告](../spikes/S10-electron-security.md)第 3 节）。
- 依据：锁定的 Electron 45.3.2（`apps/desktop/package.json`）的官方清单 [`docs/tutorial/security.md` @ v45.3.2](https://github.com/electron/electron/blob/v45.3.2/docs/tutorial/security.md)，20 项；与当天 `main` 分支的同一文件逐行一致（无新增、删除或改名的条目）。S10 时也是 45.3.2，清单原文没有变化，差异全部来自 PiArc 自身在 T04–T45 的改动。
- 结论：20 项全部落实，每项有测试或检查；T45 补了清单之外的五处（第 2 节）。测试 ID 的写法与 `tests/security/threats.yaml` 相同：`vitest:`、`l4:` 为 Vitest 与 Playwright 用例的文件与标题，`ci:` 为打包产物上的检查脚本。

## 1. 逐条

| # | 清单项 | 落实方式（45.3.2） | 测试 ID | 与 S10 的差异 |
|---|---|---|---|---|
| 1 | Only load secure content | 界面只从 `app://piarc`（`standard`、`secure`）加载；CSP 不允许任何远程资源；应用不加载远程页面 | `l4:apps/desktop/e2e/csp.e2e.ts::blocks fetch to an external address`、`l4:apps/desktop/e2e/csp.e2e.ts::blocks an external image`、`l4:apps/desktop/e2e/app-instance.e2e.ts::loads the window over the app scheme, not file:` | 无 |
| 2 | Do not enable Node.js integration for remote content | `nodeIntegration`、`nodeIntegrationInWorker`、`nodeIntegrationInSubFrames` 固定为 false | `vitest:apps/desktop/src/main/web-preferences.test.ts::fixes the security-relevant preferences`、`l4:apps/desktop/e2e/preload.e2e.ts::require, process, module and Buffer are not defined in the page` | 所有工作台均经 `createMainWindow` 使用 `secureWebPreferences`；设置面板由所属工作台渲染，原生确认归属发起请求的窗口 |
| 3 | Enable context isolation in all renderers | `contextIsolation: true` 固定 | `vitest:apps/desktop/src/main/web-preferences.test.ts::fixes the security-relevant preferences`、`l4:apps/desktop/e2e/preload.e2e.ts::the page cannot reach ipcRenderer or other Electron objects` | 同上 |
| 4 | Enable process sandboxing | `sandbox: true`，`ready` 前 `app.enableSandbox()` | `l4:apps/desktop/e2e/preload.e2e.ts::the window renderer runs in the OS-level sandbox` | 无 |
| 5 | Use `ses.setPermissionRequestHandler()` in all sessions that load remote content | 请求、检查、设备三个处理器默认拒绝，`session-created` 时对新会话同样安装；放行清单只有 `clipboard-sanitized-write`（复制按钮，带理由） | `vitest:apps/desktop/src/main/security/permissions.test.ts::grants allowlisted permissions to trusted origins only`、`l4:apps/desktop/e2e/permissions.e2e.ts::reports the permissions as denied to permission queries` | T09 加入 `clipboard-sanitized-write`；之后没有新增 |
| 6 | Do not disable `webSecurity` | 固定为 true；`new BrowserWindow` 只允许在窗口工厂（ESLint） | `vitest:apps/desktop/src/main/web-preferences.test.ts::fixes the security-relevant preferences` | 无 |
| 7 | Define a `Content-Security-Policy` and use restrictive rules | `protocol.handle` 的每个响应带 `PRODUCTION_CSP`：`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`；Worker 同样（T09） | `vitest:apps/desktop/src/main/security/csp.test.ts::allows no inline code or eval`、`l4:apps/desktop/e2e/csp.e2e.ts::does not run an injected inline script`、`l4:apps/desktop/e2e/transcript-security.e2e.ts::serves the page and its workers with the CSP of T03` | 策略原样；T09 起 Worker 脚本同样带它 |
| 8 | Do not enable `allowRunningInsecureContent` | 固定为 false | `vitest:apps/desktop/src/main/web-preferences.test.ts::fixes the security-relevant preferences` | 无 |
| 9 | Do not enable experimental features | `experimentalFeatures: false` | 同上 | 无 |
| 10 | Do not use `enableBlinkFeatures` | 不设置 | 同上（断言没有该键） | 无 |
| 11 | `<webview>`: Do not use `allowpopups` | 不适用：`webviewTag: false`，全局 `will-attach-webview` 一律取消 | `vitest:apps/desktop/src/main/web-preferences.test.ts::fixes the security-relevant preferences` | 无 |
| 12 | `<webview>`: Verify options and params | 不适用：同上 | 同上 | 无 |
| 13 | Disable or limit navigation | `will-navigate`、`will-redirect` 与 T45 新增的 `will-frame-navigate`（子框架）用 Chromium 的元组 origin 整串比较，只放行 `app://piarc`；装在 `web-contents-created` 上，所有 webContents 都有 | `vitest:apps/desktop/src/main/security/navigation.test.ts::THR-13 cancels main-frame, subframe and redirect navigations away from the app origin`、`l4:apps/desktop/e2e/navigation.e2e.ts::blocks changing location to an external address`、`l4:apps/desktop/e2e/navigation.e2e.ts::blocks a redirect from an app page to an external address` | S10 第 13 项说"在 will-navigate 与 will-redirect 中"拦截导航；子框架的导航不经 `will-navigate`（I52），当时由 CSP 的 `frame-ancestors` 与渲染进程不建 `<iframe>` 挡住，T45 补上 `will-frame-navigate`，措辞改为三个事件 |
| 14 | Disable or limit creation of new windows | `setWindowOpenHandler` 一律 `deny`；窗口只由主进程的工厂创建（设置窗口、多主窗口也是主进程按菜单或命令建的） | `l4:apps/desktop/e2e/external-links.e2e.ts::denies window.open and target=_blank links` | 无 |
| 15 | Do not use `shell.openExternal` with untrusted content | 只经 `window.piarc.openExternal`：只放行 `https:`、`http:`、`mailto:`，不带用户信息，长度上限 8192，每窗口同时最多一个原生确认框，确认后才打开；终端的 OSC 8 链接与搜索来源同一条路；T45 起非字符串参数是调用错误（`TypeError`），不允许的字符串照旧答 `false` | `vitest:apps/desktop/src/main/external-links.test.ts::rejects every other scheme`、`l4:apps/desktop/e2e/external-links.e2e.ts::rejects javascript:, file: and other schemes without asking`、`l4:apps/desktop/e2e/t45-xss.e2e.ts::THR-13 OSC 8 links with script and data targets in the terminal neither open nor navigate` | 入口从一个增到三处调用（transcript 链接、终端链接、搜索来源），全部经同一个 IPC |
| 16 | Use a current version of Electron | 45.3.2，受支持的大版本 45、44、43 之内；升级节奏按 ADR-0018 第 8 条与架构第 13.4 节；依赖安全流水线（`deps-security.yml`）每天跑。2026-11-22 核对：`latest` 是 45.4.1（2026-11-19 发布），同一大版本的补丁，登记为 I196 由 R5 按第 13.4 节评估跟进 | `npm view electron dist-tags`、`ci:scripts/ci/audit-deps.mjs` | 版本未变；T45 起有每天的依赖安全检查 |
| 17 | Validate the `sender` of all IPC messages | 全部 117 个命令经 `createIpcRegistrar` 注册，先校验 `senderFrame` 非空且 origin 与可信 origin 整串相等；每个处理函数把参数当 `unknown` 校验；ESLint 禁止直接 `ipcMain.handle`，T45 起也禁止 `webContents.ipc`、`ipcMain` 的别名与经模块对象的访问 | `vitest:apps/desktop/src/main/ipc/sender.test.ts::rejects origins that only start with the app origin`、`l4:apps/desktop/e2e/preload.e2e.ts::IPC from another origin is rejected`、`l4:apps/desktop/e2e/t45-ipc-hardening.e2e.ts::THR-11 every window.piarc command answers malformed arguments with a structured error and the main process lives` | S10 时 2 个命令，现在 117 个；S10 第 17 项说"ESLint 禁止直接调用"只覆盖 `ipcMain.<method>`（I52），T45 补了另外三种写法，措辞改为"只经 `registerHandler`" |
| 18 | Avoid usage of the `file://` protocol and prefer usage of custom protocols | `protocol.registerSchemesAsPrivileged`（`standard`、`secure`、`supportFetchAPI`，不 `bypassCSP`）+ `protocol.handle` 从 asar 提供，拒绝越出目录的路径；`GrantFileProtocolExtraPrivileges` fuse 关闭 | `vitest:apps/desktop/src/main/asset-path.test.ts::rejects paths that leave the bundle`、`l4:apps/desktop/e2e/app-instance.e2e.ts::loads the window over the app scheme, not file:`、`ci:scripts/ci/check-fuses.mjs` | 无 |
| 19 | Check which fuses you can change | 发布构建：`RunAsNode`、`EnableNodeOptionsEnvironmentVariable`、`EnableNodeCliInspectArguments`、`GrantFileProtocolExtraPrivileges` 关；`EnableEmbeddedAsarIntegrityValidation`、`OnlyLoadAppFromAsar`、`EnableCookieEncryption` 开；`strictlyRequireAllFuses`；开发构建只多开 `EnableNodeCliInspectArguments` | `vitest:scripts/ci/check-fuses.test.mjs::release settings follow ADR-0018 rule 1`、`ci:scripts/ci/check-fuses.mjs`、`ci:scripts/ci/check-release-runtime.mjs#run-as-node`、`#node-options`、`#inspect` | S10 第 5.4 节是一次手工探测；T45 把它做成 CI 里每次跑的 `check-release-runtime.mjs`，每项带一个在未写 fuse 的 Electron 上的对照 |
| 20 | Do not expose Electron APIs to untrusted web content | preload 经 `contextBridge` 只暴露 117 个窄函数，不暴露 `ipcRenderer`；事件回调剥掉 event 对象；preload 只能 `require('electron')`；返回值在 preload 中校验形状；有副作用的命令仍经 Core 的裁决，"总是允许"、allow 规则、沙箱放宽、扩展包开启、删除会话、退出登录等经主进程原生确认 | `l4:apps/desktop/e2e/preload.e2e.ts::window.piarc exposes exactly the allowlisted functions`、`l4:apps/desktop/e2e/t45-ipc-hardening.e2e.ts::THR-11 allow rules, always-allow answers and sandbox loosening from the page wait for the native confirmation` | 函数从 2 个增到 117 个（S10 第 20 行逐任务记录了每批）；T45 用畸形参数逐个调用全部命令 |

## 2. 清单之外（T45）

| 项 | 做法 | 测试 ID |
|---|---|---|
| Chromium 的远程调试开关（I10） | 没有 fuse 关得掉 `--remote-debugging-port`/`--remote-debugging-pipe`；发布构建在 `ready` 之前移除它们并退出，开发构建保留（Playwright 依赖） | `vitest:apps/desktop/src/main/security/runtime-switches.test.ts::THR-12 removes and reports the remote debugging switches and nothing else`、`ci:scripts/ci/check-release-runtime.mjs#remote-debugging-port` |
| 测试页随发布构建分发（I13、I24、I30） | 事件探针、transcript 与终端原型页放在只有开发构建才生成的 chunk 里，发布构建的渲染进程没有它们 | `ci:scripts/ci/check-app-layout.mjs`（"release renderer has no test pages"） |
| 子框架导航（I52） | `will-frame-navigate` 同样只放行应用 origin | 见第 13 项 |
| IPC 的其他注册方式（I52） | ESLint 拒绝 `webContents.ipc`、`ipcMain` 的别名与 `electron.ipcMain` | 见第 17 项；临时违规文件触发 5 条错误（T45 实测） |
| 双向控制字符 | 审批卡、diff、代码与文件路径把 U+202E 等显示成可见的 `[U+XXXX]`，界面上的文字就是要运行的文字 | `vitest:apps/desktop/src/renderer/transcript/reveal.test.ts::THR-01 shows every bidirectional control as a visible marker, in place`、`l4:apps/desktop/e2e/t45-xss.e2e.ts::THR-11 approval cards, the Changes diff and its comments show the payloads as text` |

## 3. 内置浏览器的 guest（ADR-0088，2026-11-26）

预览面板的标签是加载远程内容的 `WebContentsView`，不是应用窗口。第 1 节的各项对它们的落实方式如下；应用窗口的做法不变。

| 清单项 | guest 的做法 | 测试 ID |
|---|---|---|
| 1、2、3、4、6、8、9 | 每个标签 `sandbox`、`contextIsolation`、`webSecurity` 开，`nodeIntegration*`、`allowRunningInsecureContent`、`experimentalFeatures` 关，不带 preload；只有 `plugins` 打开（内置 PDF 查看器）；每个工作区一个分区，与应用窗口的会话分开 | `l4:apps/desktop/e2e/browser-basic.e2e.ts::THR-11 guests reach neither the preload nor Node` |
| 5 | guest 分区的权限请求只在用户控制的标签上显示面板提示（允许本次、拒绝，30 s 无响应即拒绝），设备选择与客户端证书一律拒绝；智能体控制的标签一律拒绝 | `l4:apps/desktop/e2e/browser-basic.e2e.ts::opens local pages in tabs on the panel viewport, follows links and popups` |
| 13、14 | 导航只放行 `http(s)`、`data:`（子框架）、`about:` 与工作区协议；`window.open` 与 `target=_blank` 在同一 Space 新建标签，`mailto:` 经第 15 项的外链确认，其他协议拒绝；`will-attach-webview` 取消 | `vitest:apps/desktop/src/main/browser/request-rules.test.ts::lets the main frame load web pages and workspace files only`、`vitest:apps/desktop/src/main/browser/request-rules.test.ts::THR-16 refuses %s (%s)` |
| 18 | 工作区文件经 `piarc-browse://<会话令牌>/` 提供，路径解析后必须在会话文件根内，点开头的段与越界路径拒绝；`file://` 不在 guest 中加载 | `vitest:apps/desktop/src/main/browser/workspace-files.test.ts::THR-16 refuses %s` |
| 20 | guest 没有任何 preload；智能体脚本的宿主页面只有 `window.piarcBrowserHost` 一个窄接口，只应答正在运行的那次调用，宿主分区不能联网 | `vitest:apps/desktop/src/main/browser/host-session.test.ts::allows scripts only from the host and no connections`、`l4:apps/desktop/e2e/browser-agent.e2e.ts::THR-05: the script host reaches nothing on the network` |
| 远程调试 | CDP 只经进程内的 `webContents.debugger`，只挂在 guest 上；智能体的 SDK 经主进程的代理与允许名单使用它，发布构建仍不开调试端口 | `vitest:apps/desktop/src/main/browser/cdp-proxy.test.ts::refuses methods outside the policy and records them` |

清单原文没有提到、PiArc 仍按需要落实的：`setPermissionCheckHandler`（第 5 项一并安装）、拼写检查词典的下载（Windows 与 Linux 才有，列入[外连清单](egress.md)）。
