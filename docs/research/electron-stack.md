> 本文是 2026-11-14 的调研快照，由调研过程整理而成，引用时注意时效。Electron 约 8 周一个大版本，版本号变化很快。重要事实在用于设计或实现前，请回到原始来源重新核对。结论已写入 ADR-0013 至 ADR-0016。

# PiArc Electron 技术栈调研（ADR 事实底稿）

- 日期：2026-11-14
- 范围：Electron + React + TypeScript + Vite，macOS arm64 优先，Windows x64/arm64 同一代码库
- 已有调研不重复：`docs/research/native-stack.md`（Windows Job Object、MXC、Velopack、WinGet、签名、Seatbelt）与 `docs/research/claude-official-capabilities.md` B 节（Claude Desktop）
- 标记约定：【实测】本机实际执行或读取；【推测】基于证据的推断；【未确认】没有找到一手来源
- 引用约定：Electron 文档引自 GitHub tag `v45.3.2`（npm 发布于 2026-11-13），链接形如 `https://github.com/electron/electron/blob/v45.3.2/docs/...`，对应官网 `https://www.electronjs.org/docs/latest/...`。npm/crates 版本均于 2026-11-14 查询 registry。

---

## 0. 结论速览

1. **当前稳定版是 Electron 45**：npm `latest` 为 45.3.2（2026-11-13），releases 页已列出 45.3.3（2026-11-14，Chromium 156.0.8078.100，Node 24.22.3）。官方只支持最新 3 个稳定大版本，8 周一个大版本。Electron 44 起最低要求 macOS 13，Windows 最低 Windows 10。
2. **Agent Host 运行时建议选 B，单独打包 Node 24 LTS**。理由如下：
   - `utilityProcess` 的 stdin 只能是 `ignore`，进程由 Chromium `ServiceProcessHost` 拉起，无法给单个进程套 `sandbox-exec`。Electron 源码注释写明它"currently not sandboxed"。
   - 用 `ELECTRON_RUN_AS_NODE` 拉起 Electron 自身可以套 Seatbelt，但前提是不关闭 `runAsNode` fuse。这和官方安全清单第 19 条相反，Claude Desktop 也关掉了这个 fuse【实测】。
   - Electron 不带 npm/npx。非 Node-API 的原生模块按 Node ABI 预编译，在 Electron 里加载不了。要加载第三方 `.node`，还得在主可执行文件上开 `disable-library-validation`。
   - 同类应用里，Cursor 3.30.14 就单独带了 node v24.22.1（122.5 MB），并把它加到 MCP stdio 子进程的 PATH 里【实测】。
3. **打包与更新建议**：用 Electron Forge 8.0.1 构建打包，它是官方工具，Vite 插件已转正。macOS 走 Electron 内置 `autoUpdater`（Squirrel.Mac），v45 起支持断点续传和二进制 delta，Claude Desktop 用的也是它【实测】。Windows 的安装和更新在 M0 对比 Velopack 和 MSIX 后再定，默认倾向 Velopack。electron-builder 26.18.0 + electron-updater 6.8.11 是备选，官方明确说它"do not come with official support"。
4. **NAPI-RS 3.x（napi 3.16.2）适合做 Core**：Node-API ABI 稳定，升级 Electron 一般不需要重编。`napi-sys` 默认用 `dyn-symbols` 在运行时解析宿主符号，所以 Windows 上不依赖 `node.lib` 和 delay-load hook【推测，依据源码】。ThreadsafeFunction、AsyncTask、tokio `async fn` 都支持。win32-arm64 可以在 Windows x64 runner 上直接交叉编译。
5. **Electron 45 没有 Liquid Glass API**：PR #50415（`setGlassEffect` 等）于 2026-06-30 被作者关闭，未合并。目前只能用 `vibrancy`。Electron 45 用 macOS 26.5 SDK 构建【实测】，系统绘制的标题栏和菜单会随系统更新外观【推测】。
6. **Windows 原生没有可直接用的 OS 沙箱**。Claude Code 文档写明 "On native Windows, Claude Code runs commands unsandboxed"，要求 WSL2。可选方案有 MXC ProcessContainer（要求 Win11 24H2 26100.9278+）、AppContainer、Windows Sandbox（不支持 Home 版，同一时间只能开一个实例），以及只能用于清理进程树的 Job Object。
7. **前端库版本**：React 19.3.1（2026-10-14）、Vite 8.3.8（2026-11-11）、react-virtuoso 4.18.22（MIT）、@tanstack/react-virtual 3.14.26（MIT，virtual-core 3.16.0 起新增 `anchorTo: 'end'` 和 `followOnAppend`，专门面向聊天场景）。@virtuoso.dev/message-list 1.19.6 是商业授权。

---

## 1. Electron 版本、支持策略、最低系统

| 事实 | 内容 | 来源（日期） |
|---|---|---|
| 当前稳定版 | npm `latest` = **45.3.2**（2026-11-13T00:47Z）；releases 页列出 **45.3.3**（2026-11-14，Chromium 156.0.8078.100，Node 24.22.3，状态仍为 Building） | https://registry.npmjs.org/electron （2026-11-14 查询）；https://releases.electronjs.org/ （2026-11-14） |
| 45.0.0 | npm 发布于 2026-10-21；Chromium 156.0.8078.48、Node v24.22.0、V8 15.6 | https://github.com/electron/electron/releases/tag/v45.0.0 |
| 其他受支持线 | 44.11.3（Chromium 152，Node 24.22.2）、43.8.10（Chromium 150，Node 24.22.1） | https://releases.electronjs.org/ |
| 预发布 | 46.0.0-alpha.10（2026-11-11/12，Chromium 159，Node 26.13.0）；47 nightly | 同上 |
| 时间表 | 45 stable 2026-10-20，EOL 2027-04-27†；46 stable 2027-01-05†（M160，Node v26.13.0）；47 stable 2027-03-02†（M164）。† 为暂定 | https://releases.electronjs.org/schedule |
| 支持策略 | "Electron's official support policy is the latest 3 stable releases"；"We only support the latest minor release for each stable release series" | https://github.com/electron/electron/blob/v45.3.2/docs/tutorial/electron-timelines.md |
| 节奏 | 每 8 周一个大版本，alpha 和 beta 各 4 周；跟随 Chromium 偶数版本；Node 偶数版进入 Active LTS 后升级主干 | 同上 |
| 最低 macOS | "macOS (Ventura and up)"；Electron 44 起移除 macOS 12："macOS 13 (Ventura) or later will be required to run Electron v44.0.0 and higher" | https://github.com/electron/electron/blob/v45.3.2/README.md ；`docs/breaking-changes.md`（44.0 节） |
| 最低 Windows | Windows 10 及以上，x64/arm64；**45 起只发布 64 位**（不再有 ia32） | README；v45.0.0 release notes |
| 包体参考 | `electron-v45.3.2-darwin-arm64.zip` 121.0 MB；`win32-x64.zip` 158.3 MB；`win32-arm64.zip` 156.1 MB | GitHub release v45.3.2 assets（2026-11-13） |
| 本机样本 | Claude Desktop 5.1231.2：Electron Framework 45.2.1，`minos 13.0`、`sdk 26.5`，LSMinimumSystemVersion 13.0【实测】 | `otool -l`、Info.plist |

**对 ADR 的影响**：一个大版本的支持期大约 24 周，45 的 EOL 是 2027-04-27。按季度升级 Electron 是硬性要求。Electron 46 会把内置 Node 升到 26.13，如果走方案 A，Agent Host 的 Node 大版本会跟着 Electron 一起变。

---

## 2. Agent Host 运行时：utilityProcess / RUN_AS_NODE / fuses

### 2.1 `utilityProcess.fork` 的能力与限制

来源：https://github.com/electron/electron/blob/v45.3.2/docs/api/utility-process.md ；`docs/tutorial/process-model.md`；源码 `shell/browser/api/electron_api_utility_process.cc`（v45.3.2）

- **定位**：作用等同 Node 的 `child_process.fork`，但用 Chromium Services API 拉起。官方说明是 "runs in a Node.js environment, meaning it has the ability to `require` modules and use all of Node.js APIs"，适合运行 "untrusted services, CPU intensive tasks or crash prone components"。
- **stdio 限制**：只能配置 stdout/stderr（`pipe`/`inherit`/`ignore`）。原文是 "Configuring `stdin` to any property other than `ignore` is not supported and will result in an error"。因此 **Core 和 Agent Host 之间的 JSON-RPC 不能走 stdin**，只能用 `process.parentPort` 或 `MessagePortMain`，或者让 Agent Host 自己去连 Core 开的 UDS/命名管道。
- **其他选项**：`env`、`execArgv`、`cwd`、`serviceName`、`session`/`partition`、`respondToAuthRequestsFromMainProcess`，以及两个 macOS 专属选项：
  - `allowLoadingUnsignedLibraries`：改用 `Helper (Plugin).app` 启动，这个 helper 可以带 `disable-library-validation`。
  - `disclaim`：让子进程在 TCC 上自己承担责任，官方描述为 "useful when launching processes that run third-party or otherwise untrusted code"。
- 只能在 `app` 的 `ready` 事件之后调用。
- **能否套 Seatbelt**：不能单独给某个 utility process 套 wrapper。
  - 源码里进程由 `content::ServiceProcessHost::Launch(...)` 拉起，只有 `WithExtraCommandLineSwitches`/`WithEnvironment`/`WithChildFlags`/`WithDisclaimResponsibility` 这几个入口，没有 wrapper。
  - 源码注释："Currently utility process is not sandboxed"。
  - Chromium 有一个调试开关 `--utility-cmd-prefix`，定义见 https://chromium.googlesource.com/chromium/src/+/main/content/public/common/content_switches.cc 。它作用于所有 utility process，注释写的是 "Useful values might be 'valgrind'"，不能当产品功能用【推测】。
- **完整 Node 能力**：
  - child_process 可用。证据是 VS Code 扩展宿主、Claude Desktop 的 pty-host 都跑在 utility process 里，后者加载 node-pty 原生模块【实测，见 2.4】。
  - 原生模块可用。在 macOS 上加载未签名或第三方签名的库，需要 `allowLoadingUnsignedLibraries: true`。
  - worker_threads 官方没有单独说明，按 "all of Node.js APIs" 应当可用【推测】。
  - **限制**：子进程里的 `process.execPath` 指向 Electron helper。凡是 `child_process.fork` 或 `spawn(process.execPath)` 的代码，都依赖 `ELECTRON_RUN_AS_NODE`。fuse 一关，`child_process.fork` 直接抛错（见 2.2）。

### 2.2 `ELECTRON_RUN_AS_NODE` 与 fuses

- `ELECTRON_RUN_AS_NODE`：让 Electron 可执行文件"Starts the process as a normal Node.js process"。
  - 不支持 `--openssl-config`、`--use-bundled-ca`、`--use-openssl-ca`、`--force-fips`、`--enable-fips`，原因是 Electron 用 BoringSSL 构建 Node 的 crypto。
  - fuse `runAsNode` 关闭后，这个变量会被忽略。
  - 来源：https://github.com/electron/electron/blob/v45.3.2/docs/api/environment-variables.md
- `runAsNode` fuse：默认开启。原文："With this fuse disabled, `child_process.fork` throws ... Instead, we recommend that you use Utility Processes"。关掉它是为了防 "living off the land" 攻击。来源：https://github.com/electron/electron/blob/v45.3.2/docs/tutorial/fuses.md
- 安全清单第 19 条："Some fuses, like `runAsNode` and `nodeCliInspect`, allow the application to behave differently when run from the command line ... can be used to execute commands on the device through your application"。
- **@electron/fuses 2.1.3**（2026-06-29，当前 latest）的 `FuseV1Options` 共 9 项【实测，读 `dist/config.d.ts`】：

| # | 名称 | 默认 | 用途 |
|---|---|---|---|
| 0 | `RunAsNode` | 开 | 是否认 `ELECTRON_RUN_AS_NODE` |
| 1 | `EnableCookieEncryption` | 关 | 用 OS 密钥加密 cookie（单向迁移） |
| 2 | `EnableNodeOptionsEnvironmentVariable` | 开 | 是否认 `NODE_OPTIONS`/`NODE_EXTRA_CA_CERTS` |
| 3 | `EnableNodeCliInspectArguments` | 开 | `--inspect`、SIGUSR1 |
| 4 | `EnableEmbeddedAsarIntegrityValidation` | 关 | 校验 app.asar（macOS 16+、Windows 30+） |
| 5 | `OnlyLoadAppFromAsar` | 关 | 只从 app.asar 加载 |
| 6 | `LoadBrowserProcessSpecificV8Snapshot` | 关 | 主进程使用独立 V8 snapshot |
| 7 | `GrantFileProtocolExtraPrivileges` | 开 | `file://` 的额外特权 |
| 8 | `WasmTrapHandlers` | 开 | Wasm 越界陷阱用信号处理 |

  - 另有 `strictlyRequireAllFuses` 配置项（建议设为 true，防止升级后漏配新 fuse）和 `resetAdHocDarwinSignature`。
- **fuse 在 Electron Framework 二进制里，所有 helper 共用**。不能只给某一个可执行文件开 `RunAsNode`【推测，依据 fuse 机制：签名前翻转二进制位】。

### 2.3 能否给 Agent Host 套 `sandbox-exec`

| 拉起方式 | 能否套 Seatbelt | stdio JSON-RPC | 代价 |
|---|---|---|---|
| `utilityProcess.fork` | ✗ 无 wrapper 入口；进程本身无沙箱 | ✗ 无 stdin | 只能让进程启动后自己调用 `sandbox_init*`（私有/已废弃 API）【推测，可做 spike】 |
| Rust Core 或 `child_process.spawn('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, entry], { env: { ELECTRON_RUN_AS_NODE: '1' } })` | ✓ | ✓ | 必须保留 `RunAsNode` fuse；主可执行文件的 entitlements 同时作用于 Agent Host |
| Rust Core 拉起 `sandbox-exec … <bundled node> entry`（方案 B） | ✓ | ✓ | 多约 119 MB；需要自己重签 node（去掉 `get-task-allow`，见 native-stack.md 7.3） |

Claude Desktop 已有先例：它用 `child_process` 包了一层 `/usr/bin/sandbox-exec -p <profile> -D …` 来启动自家原生 helper（Simulator sidecar），代码里有 `{cmd:"/usr/bin/sandbox-exec",args:["-p",xr,...]}`【实测，读 app.asar】。说明 "Electron 主进程 → sandbox-exec → 原生可执行文件" 这条路在生产环境里有人在用。

### 2.4 同类应用怎么做【实测为主】

| 应用 | Electron | RunAsNode fuse | Agent/扩展宿主 | 备注 |
|---|---|---|---|---|
| VS Code（main 分支，1.147.0-dev） | `nativeBuild.target` 43.8.9 | 未用 @electron/fuses（代码搜索无 `FuseV1Options`）；`code` CLI shim、git askpass 依赖 `ELECTRON_RUN_AS_NODE`【推测：fuse 保持开启】 | 扩展宿主 = `utilityProcess.fork`，`allowLoadingUnsignedLibraries: true`、`respondToAuthRequestsFromMainProcess: true` | 源码 `src/vs/platform/extensions/electron-main/extensionHostStarter.ts`、`src/vs/platform/utilityProcess/electron-main/utilityProcess.ts`（GitHub main，2026-11-14）；最新 release 1.146.0（2026-11-11） |
| Claude Desktop 5.1231.2 | 45.2.1 | **Disabled**；`NodeOptions` 关、`NodeCliInspect` 关、`EmbeddedAsarIntegrity` 开、`OnlyLoadAppFromAsar` 开、`CookieEncryption` 开、`GrantFileProtocolExtraPrivileges` 仍开 | MCP Node server 跑在 utility process "nodeHost" 里（argv 传入口文件，用 MessagePort 通信），并改写 `ChildProcess.prototype.spawn`，拦截对内置 node 的 self-exec（`.built-in-node-refused`、`self-exec-blocked`）；pty-host、shell 环境提取、worker 都用 `utilityProcess.fork`，部分加了 `disclaim` | `npx @electron/fuses read --app`；asar 字符串检索（对压缩代码的语义解读属【推测】）。主程序 entitlements 只有 `allow-jit`，Plugin helper 有 `disable-library-validation`。带 `embedded.provisionprofile` 和 keychain-access-groups。`claude-native-binding.node` 中能看到 napi-rs 运行时字符串（"Create Custom GC ThreadsafeFunction in napi_register_module_v1"），是 Rust NAPI-RS 插件【推测】 |
| Cursor 3.30.14 | 43.8.9 | **Enabled**（其余 fuse 基本为默认值） | `resources/helpers/node`（v24.22.1，122.5 MB，单独签名，TeamID HX7739G8FX）；`mcpStdioSpawnEnvironment` 把 helpers 目录加到 PATH 前面；另有 `cursorsandbox` 原生 helper 和 `agent-host-import` | 本机检查；node 的 entitlements 含 `disable-library-validation`、`allow-jit` 等 |

### 2.5 结论：方案 A 与方案 B

**建议 B：单独打包 Node 24 LTS（当前 24.22.3，2026-11-10，与 Electron 45.3.3 内置 Node 同版本）**，由 Rust Core 直接拉起 `/usr/bin/sandbox-exec -f <profile> -D WORKSPACE=… <node> agent-host.mjs`。Core 自己管 stdio 管道，Windows 上再挂 Job Object。Electron 应用本身关闭 `RunAsNode`、`NodeOptions`、`NodeCliInspect`，打开 ASAR integrity 和 `OnlyLoadAppFromAsar`，做法与 Claude Desktop 一致。

不选 A 的理由：

1. `utilityProcess` 既不能套 Seatbelt，也不支持 stdin，与 "Agent Host 在 Seatbelt 下运行、走 stdio JSON-RPC" 这两条需求都冲突。
2. 走 RUN_AS_NODE 能套 Seatbelt，但有三个问题：
   - 必须保留 `RunAsNode` fuse，违反官方安全清单第 19 条。
   - 主可执行文件的 entitlements 会作用于 Agent Host 和它的所有子进程。MCP server 通过 npx 装进来的第三方 `.node` 要加载，就得给主 app 加 `disable-library-validation`，等于削弱整个主进程。
   - Agent Host 的 Node 版本会被 Electron 升级节奏牵着走（46 会升到 Node 26.13）。
3. npx 场景：
   - Electron 没有 npm/npx，A 方案仍要另外带 npm，还要写 `node` shim。
   - Electron 的 `NODE_MODULE_VERSION` 和 Node 不一样，按 Node ABI 预编译的非 Node-API 原生模块装不上（官方文档原文："native modules you use will need to be recompiled for Electron"，见 `docs/tutorial/using-native-node-modules.md`）。
   - B 方案带完整的 Node 发行包（node + npm + npx），把 `bin` 加到 Agent Host 的 PATH 前面即可。Cursor 的做法相同。

B 的代价：

- 体积：node 原始约 119 MB/arch（native-stack.md 实测 24.14.1 arm64 为 119.2 MB，DMG ULMO 压缩后 29.0 MB）。官方压缩包大小：darwin-arm64 tar.xz 27.5 MB，win-x64 zip 37.8 MB，win-arm64 zip 33.8 MB（https://nodejs.org/dist/v24.22.3/ ，2026-11-14）。
- 安全更新：要跟 Node LTS 的安全发布同步（11-10 刚发布 24.22.3/26.13.1，均标记 security）。
- 签名：要自己用 entitlements 重签 node（`allow-jit`；只有在需要加载第三方 `.node` 时才给这个 node 单独加 `disable-library-validation`，不影响主 app）。
- Agent Host 的 JS 包**不能放进 app.asar**，因为独立 node 读不了 asar。要放到 `Resources/` 或 `app.asar.unpacked/`，Seatbelt profile 也要放行这些路径的读取。

可以留到 M0 再看的折中方案：

- 用 `utilityProcess` 跑受信任的内部 helper（例如 shell 环境提取），不跑 Agent Host。
- "utilityProcess + Rust 插件在子进程里自行调用 Seatbelt"可以省掉 Agent Host 那份 node。但 npx 仍然需要一个 node（除非依赖用户自己装的 node），实际省不了多少，私有 API 风险也高，不建议作为主路径。

---

## 3. Electron 官方安全清单（20 条）

来源：https://github.com/electron/electron/blob/v45.3.2/docs/tutorial/security.md （官网 https://www.electronjs.org/docs/latest/tutorial/security ）

1. Only load secure content（只加载 HTTPS 等安全内容）
2. Do not enable Node.js integration for remote content（自 5.0.0 起为默认）
3. Enable context isolation in all renderers（自 12.0.0 起为默认）。注意："disabling context isolation ... also disables process sandboxing"
4. Enable process sandboxing（自 20.0.0 起为默认；可用 `app.enableSandbox()` 全局强制）
5. Use `ses.setPermissionRequestHandler()` in all sessions that load remote content。v45 起屏幕捕获权限名改为 `display-capture`
6. Do not disable `webSecurity`
7. Define a `Content-Security-Policy`（推荐 `script-src 'self'`）。首选 HTTP header（`webRequest.onHeadersReceived`）；`file://` 只能用 `<meta>`
8. Do not enable `allowRunningInsecureContent`
9. Do not enable experimental features
10. Do not use `enableBlinkFeatures`
11. `<webview>`: Do not use `allowpopups`
12. `<webview>`: Verify options and params
13. Disable or limit navigation（`will-navigate` 中用 `new URL()` 比较 origin，不要用 `startsWith`）
14. Disable or limit creation of new windows（`setWindowOpenHandler` 默认返回 `deny`，外链交给 `shell.openExternal`）
15. Do not use `shell.openExternal` with untrusted content
16. Use a current version of Electron
17. Validate the `sender` of all IPC messages（用 `e.senderFrame.origin` 对照白名单。原文："Use the origin, not the URL"；frame 可能为 null）
18. Avoid usage of the `file://` protocol and prefer usage of custom protocols（用 `protocol.handle` + `protocol.registerSchemesAsPrivileged`；不用 `file://` 时应关闭 `GrantFileProtocolExtraPrivileges` fuse）
19. Check which fuses you can change
20. Do not expose Electron APIs to untrusted web content（preload 里不要直接暴露 `ipcRenderer.on`，回调要剥掉 event 对象再传）

补充：

- ASAR integrity 支持 macOS（16.0+）和 Windows（30.0+），由 `EnableEmbeddedAsarIntegrityValidation` 开启，要同时开 `OnlyLoadAppFromAsar`，否则可以绕过。Forge 7.4.0+ / Packager 18.3.1+ 会自动写入 header hash。来源：`docs/tutorial/asar-integrity.md`。
- v45 的 sandboxed preload 不再提供 `Buffer`/`setImmediate` 以及 `events`/`timers`/`url` 的 shim。preload 只能 `require('electron')`，要用 Web API 替代或自行打包 polyfill。来源：`docs/breaking-changes.md` 45.0 节。

**对 PiArc 的建议**【推测】：

- 渲染进程全部 sandbox + contextIsolation。
- UI 用自定义协议（如 `piarc://`）提供，不用 `file://`。
- preload 只暴露窄接口。
- 主进程所有 `ipcMain.handle` 都校验 `senderFrame.origin`。
- 外链一律走 `setWindowOpenHandler` 返回 deny，再由主进程用 `shell.openExternal` 打开，并做协议白名单。
- 模型输出渲染出的 Markdown/HTML 一律视为不可信内容（CSP 禁止 inline script）。

---

## 4. NAPI-RS

| 事实 | 内容 | 来源（日期） |
|---|---|---|
| crate 版本 | `napi` **3.16.2**（2026-11-11）；`napi-derive` 3.7.1；`napi-build` 2.6.0；`napi-sys` 3.4.1。napi 3.0.0 发布于 2025-07-17 | https://crates.io/crates/napi （API 查询 2026-11-14） |
| CLI | `@napi-rs/cli` **3.10.12**（2026-11-03）。CLI 自身要求 Node `>=23.5.0 \|\| ^22.13.0 \|\| ^20.17.0`；v3 工作区 MSRV Rust 1.88 | npm；https://github.com/napi-rs/website/blob/main/content/docs/more/support-compatibility.en.mdx |
| ABI | "A native binary built against Node-API level N can generally load on later Node.js releases that still provide level N, without rebuilding for every Node major"。napi-rs CI 测 Node 22/24/26，**不测 Electron** | 同上 |
| Electron 兼容 | Electron 官方文档对一般原生模块的说法是 "will need to be recompiled for Electron"（因为 NODE_MODULE_VERSION/BoringSSL）。Node-API 模块不依赖 NODE_MODULE_VERSION，按 Node-API 级别加载【推测】。napi-rs 官方博客列举 AFFiNE、Bitwarden 等 Electron 应用在用。Claude Desktop 的 `claude-native-binding.node` 也是 napi-rs 构建【推测，依据字符串】 | `docs/tutorial/using-native-node-modules.md`；`content/blog/announce-v3.en.mdx` |
| Windows 链接 | `napi-sys` 默认 feature 是 `dyn-symbols`（依赖 `libloading`），运行时从宿主进程解析 N-API 符号。Electron 文档要求 node-gyp 模块带 `win_delay_load_hook`（因为 electron.exe 里没有 node.dll），napi-rs 走 dyn-symbols 可以绕开这个问题【推测，依据源码】 | https://github.com/napi-rs/napi-rs/blob/main/crates/sys/Cargo.toml |
| 线程回调 | `ThreadsafeFunction<T, R>`：任意 Rust 线程都能 `call(…, Blocking/NonBlocking)` 回调 JS，适合 Core 往外推事件流 | `content/docs/concepts/threadsafe-function.en.mdx` |
| 异步 | `Task`/`AsyncTask`：在 libuv 线程池里跑 `compute`，支持 AbortSignal；`async fn`：开启 `async`/`tokio_rt` feature 后由内置 tokio runtime 执行，返回 Promise | `async-task.en.mdx`、`async-fn.en.mdx` |
| 交叉编译 | `aarch64-apple-darwin` 用 macOS runner 原生编译；`x86_64-pc-windows-msvc` 和 `aarch64-pc-windows-msvc` 在 `windows-latest`（x64）上不加参数即可（"MSVC cross-links x64, x86 and arm64 natively"）；在 macOS/Linux 上用 `-x`（cargo-xwin，需要 clang，受微软许可约束）。依赖 Apple framework 的 crate 必须有真实的 macOS SDK | `content/docs/cross-build.en.mdx` |
| asar | `process.dlopen`（require .node）遇到 asar 内的文件会先解压到临时目录，官方建议用 `--unpack *.node` 放到 `app.asar.unpacked`。Forge 用 `@electron-forge/plugin-auto-unpack-natives` 8.0.1，electron-builder 用 `asarUnpack` 和 `smartUnpack`（默认 true） | `docs/tutorial/asar-archives.md`；npm；app-builder-lib 26.18.0 `scheme.json` |
| v45 注意 | asar 内 `fs.open` 返回的 fd 只能给 `fs` 用，交给原生插件或 child_process stdio 会报 `EBADF`。**Rust Core 不要读 asar 里的文件**，资源应放在 unpacked 目录或 `Resources/` | `docs/breaking-changes.md` 45.0 节 |

---

## 5. 打包、签名、更新

### 5.1 工具版本（npm，2026-11-14 查询）

| 包 | 版本 | 日期 |
|---|---|---|
| `@electron-forge/cli` | 8.0.1 | 2026-09-29 |
| `@electron-forge/plugin-vite` / `plugin-fuses` / `maker-dmg` / `maker-squirrel` / `maker-msix` | 8.0.1 | 2026-09-29 |
| `electron-builder` | 26.18.0（`next` = 27.0.0-alpha.14） | 2026-10-20 |
| `electron-updater` | 6.8.11（`next` = 7.0.0-alpha.13） | 2026-10-20 |
| `@electron/notarize` | 3.1.2 | 2026-10-09 |
| `@electron/osx-sign` | 2.7.2 | 2026-10-25 |
| `@electron/windows-sign` | 2.1.0 | 2026-09-09 |
| `@electron/packager` | 20.3.0 | 2026-08-11 |
| `@electron/rebuild` | 4.2.1 | 2026-10-06 |
| `@electron/asar` | 4.3.2 | 2026-11-12 |
| `electron-winstaller`（Squirrel.Windows） | 5.4.4 | 2026-07-01 |
| `update-electron-app` | 3.3.0 | 2026-06-28 |
| `velopack`（npm） | `latest` = 1.3.39-g8d2844f（GitHub 上标为 Pre-release）；GitHub Latest = 1.2.161 | 2026-10-17 / 2026-09-29 |
| `electron-vite`（社区） | 6.0.0 | 2026-10-14 |

### 5.2 Forge 与 electron-builder

- **官方立场**：Forge 是 Electron 官方工具。electron-builder 和 Hydraulic Conveyor 属于第三方，原文："maintained by members of the Electron community, and do not come with official support from the Electron project"，并指出 electron-builder "replaces features and modules used by the Electron maintainers (such as the auto-updater) with custom ones"。来源：https://github.com/electron/electron/blob/v45.3.2/docs/tutorial/forge-overview.md
- **Forge 8**（2026-09-29）要点：
  - 全部改为 ESM，要求 Node 22.17+。
  - `plugin-vite` 转为稳定版，目标 Vite 8，支持 `hotRestart`。
  - `publish` 改名为 `release`。
  - PKG 公证、MSIX `outputFileName`。
  - 来源：https://github.com/electron/forge/releases/tag/v8.0.1
- **electron-builder 26.x**：
  - Windows 目标有 NSIS（默认，可自动更新）、NSIS-web、MSI、AppX，以及已废弃的 Squirrel.Windows（原文 "maintained, but deprecated. Please use nsis"）。
  - Azure 签名用 `win.azureSignOptions`（26.18.0 的 scheme 中存在）。
  - master 分支文档（v27 alpha）新增 `msix` 目标，签名改为 `win.sign.type: "azure" | "hsm" | "pkcs11" | "signtool"`（标注 Beta）。
  - electron-updater 能更新的目标：macOS DMG（**必须同时出 zip**）、Windows NSIS、Linux AppImage/DEB/RPM/Pacman；"Squirrel.Windows is not supported"。支持分阶段发布、多种 provider，Windows 上校验签名。
  - 来源：https://github.com/electron-userland/electron-builder/tree/master/website/docs （features/auto-update.md、squirrel-windows.md、features/code-signing/code-signing-win.md，2026-11-14）。

### 5.3 macOS：签名、公证、自动更新

- **Electron 内置 `autoUpdater`（Squirrel.Mac）**：
  - 要求应用已签名（"This is a requirement of Squirrel.Mac"），只装 ZIP，受 ATS 约束。
  - v45 起下载流式写盘，支持断点续传（服务端需提供 ETag/Last-Modified 和 Range）。更新条目可以带 `sha256`/`size` 做校验，也可以带 `delta`（用 Sparkle `BinaryDelta create` 生成，从某个 `from_version` 打补丁，补丁打完仍要过签名校验，失败则回退到全量 ZIP）。
  - 来源：https://github.com/electron/electron/blob/v45.3.2/docs/api/auto-updater.md ；https://github.com/Squirrel/Squirrel.Mac （仓库 2026-10-15 仍有提交）。
- **静态托管**：`autoUpdater` 支持 `serverType: 'json'`，可以直接读 S3/R2 上的 `RELEASES.json`。Forge 的 ZIP maker 用 `macUpdateManifestBaseUrl` 生成这个文件；客户端可以用 `update-electron-app` 的 `UpdateSourceType.StaticStorage`。来源：`docs/tutorial/updates.md`。
- **Claude Desktop 的做法**：bundle 内有 `Squirrel.framework`，Info.plist 有 `ElectronSquirrelPreventDowngrades`，asar 里没有 `electron-updater` 字符串，说明用的是内置 autoUpdater【实测】。
- **公证**：
  - `@electron/notarize` 3.1.2 只用 notarytool。前提是 Xcode 13+、Developer ID、hardened runtime + `allow-jit`。
  - 原文："If you are using Electron 11 or below, you must add the `com.apple.security.cs.allow-unsigned-executable-memory` entitlement ... When using version 12+, this entitlement should not be applied"。
  - 认证方式支持 app 专用密码 + Team ID，或 App Store Connect API Key。
  - 来源：https://github.com/electron/notarize
  - Apple 侧的要求（notarytool、hardened runtime、`get-task-allow`）见 native-stack.md 7.3 和 9.1。
- **需要签名才能用的 macOS API**：通知（Electron 42 起改用 `UNNotification`，"requires that an application be code-signed"）、autoUpdater、`safeStorage`/cookie 加密（访问钥匙串）。来源：`docs/breaking-changes.md` 42.0 节；`docs/tutorial/fuses.md`。

### 5.4 Windows：安装器、更新、签名

- **Electron 内置 `autoUpdater`（Windows）**：按打包方式自动选择机制：
  - MSIX 包（用 electron-windows-msix 构建，通过 `process.windowsStore` 检测）走 MSIX 更新器，支持直链或 JSON feed，`allowAnyVersion` 允许降级。
  - 传统安装器走 Squirrel.Windows，需要处理 `--squirrel-firstrun`，AUMID 格式为 `com.squirrel.PACKAGE_ID.EXE`。
  - 来源：`docs/api/auto-updater.md`。
- **Squirrel.Windows 上游停滞**：最后一个 release 是 2.0.1（2020-09-27），仓库最后推送 2024-07-24（https://github.com/Squirrel/Squirrel.Windows ）。electron/windows-installer 仍在维护（2026-11-01 有推送）。
- **Velopack**：
  - 官方 JS/Electron 指南以 Forge 为前提，要求在入口最早处调用 `VelopackApp.build().run()`，并移除 `electron-squirrel-startup` 和 `maker-squirrel`。
  - 用 Vite/Rollup 时要把 `velopack` 的 `.node` 设为 external。
  - 已知问题：vite/rollup 下 `checkForUpdatesAsync` 可能报 `invalid peer certificate: UnknownIssuer`。
  - 来源：https://github.com/velopack/velopack.docs/blob/master/docs/getting-started/javascript.mdx 。其他特性（按用户安装、不弹 UAC、zstd delta、1.3 起可在 macOS/Linux 上做 Azure 签名）见 native-stack.md 9.2。
- **MSIX**：
  - Forge 有 `maker-msix` 8.0.1。
  - Windows 11 才有的 MSIX 特性：shared package container、mutable package directories、persistent identity。
  - full trust 应用的 AppData 虚拟化问题见 native-stack.md 9.2（anthropics/claude-code#47977）。
  - 来源：https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/distribution-feature-status （ms.date 2026-08-24）。
- **Claude Desktop 在 Windows 上**：
  - 官方原文："We offer MSIX packages for Windows deployments via Microsoft Intune, SCCM, Group Policy, or PowerShell"，"The Claude MSIX is packaged as a per-user application"。分 x64 和 arm64 两个 MSIX，另提供 `ClaudeSetup.exe`。默认约每 4 小时检查一次更新，可用 `disableAutoUpdates` 关闭。
  - 来源：https://support.claude.com/en/articles/12622703-deploy-claude-desktop-for-windows （页面只写了 "Updated over a week ago"，2026-11-14 抓取）。
  - `ClaudeSetup.exe` 内部是什么技术【未确认】。
- **SmartScreen 与 EV**：原文："Prior to 2024, Extended Validation (EV) code signing certificates granted immediate SmartScreen reputation ... no certificate type (OV or EV) grants an immediate bypass"。信誉由文件 hash 和签名者证书两方面积累，签名身份保持不变才能把信誉延续下去。来源：同上 distribution-feature-status（Last reviewed August 2026）。
- **Azure Artifact Signing**（原 Trusted Signing）：
  - Public Trust 面向的组织所在地：美国、加拿大、欧盟、英国、澳大利亚、新西兰、日本、韩国、新加坡、瑞士、挪威、以色列。个人开发者仅限美国和加拿大。Private Trust 不受地域限制。
  - 不支持免费、试用或赞助订阅。身份验证需要 1–20 个工作日。
  - 不签发 EV，"no plan to issue EV certificates in the future"。
  - **中国大陆主体不在可用名单内**。
  - 来源：https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart （updated_at 2026-10-08）；https://learn.microsoft.com/en-us/azure/artifact-signing/faq （updated_at 2026-10-27）。价格和证书有效期见 native-stack.md 9.2。
- **WinGet**：客户端最新 v1.29.380（2026-09-21），1.30 处于 preview。https://github.com/microsoft/winget-cli/releases

### 5.5 打包与更新建议

- **构建和打包统一用 Forge 8**：
  - `plugin-vite`
  - `plugin-fuses`：配置 `strictlyRequireAllFuses: true`；`RunAsNode`/`NodeOptions`/`NodeCliInspect` 设为 false；`EmbeddedAsarIntegrity`/`OnlyLoadAppFromAsar`/`CookieEncryption` 设为 true；`GrantFileProtocolExtraPrivileges` 设为 false
  - `plugin-auto-unpack-natives`
  - 理由：官方维护，ASAR integrity 自动处理，和 Electron 的更新路径一致。
- **macOS**：Forge 的 `osxSign`/`osxNotarize` 加上 DMG + ZIP maker，更新用内置 autoUpdater 的 JSON feed 放在静态存储上。delta 补丁用 Sparkle `BinaryDelta` 生成，属于可选优化。
- **Windows**：M0 做一个两天左右的 spike，比较 Velopack 和 MSIX（Forge `maker-msix` + 内置 autoUpdater 的 MSIX 支持）。默认倾向 Velopack，理由是没有 MSIX 文件虚拟化问题、按用户安装不弹 UAC、有 delta。如果 Velopack 和 Forge/Vite 集成问题多，退回 electron-builder NSIS + electron-updater，并接受第三方工具的风险。
- **Windows 签名**：先确认 PiArc 的签名主体是否在 Artifact Signing 可用地区。不在的话，买 OV 证书，私钥放云 HSM（electron-builder 的 HSM/PKCS#11 方式，或者 Forge 的 `@electron/windows-sign` 自定义 hook）。不要为了 SmartScreen 去买 EV。

---

## 6. macOS 26 集成

| 主题 | 现状 | 来源 |
|---|---|---|
| Liquid Glass | **Electron 45 和 main 分支文档里都没有** glass 相关 API。PR #50415 "feat: add native Liquid Glass support on macOS 26+"（作者 felixrieseberg，计划提供 `win.setGlassEffect()`、`setGlassEffectRegions()`、`isGlassEffectSupported()`，基于 `NSGlassEffectView`）在 2026-03-22 提交，带过 `target/42-x-y`、`43-x-y` 和 `wip` 标签，**2026-06-30 由作者关闭，未合并**。社区包 `electron-liquid-glass` 1.1.1 最后发布于 2025-09-17 | https://github.com/electron/electron/pull/50415 ；npm |
| vibrancy | `vibrancy` 可选值：`appearance-based`/`titlebar`/`selection`/`menu`/`popover`/`sidebar`/`header`/`sheet`/`window`/`hud`/`fullscreen-ui`/`tooltip`/`content`/`under-window`/`under-page`；`visualEffectState` 可选 `followWindow`/`active`/`inactive`；Windows 用 `backgroundMaterial`（`mica`/`acrylic`/`tabbed`） | `docs/api/structures/base-window-options.md` |
| 系统外观 | Electron 45.2.1 framework 的 `sdk 26.5`【实测】，链接 macOS 26 SDK 的应用，系统绘制的标题栏、红绿灯、菜单和对话框会随系统更新外观【推测】。macOS 26 下窗口圆角与 SDK 不一致的问题 issue #47514 仍开着（2025-11-25 重新打开） | `otool -l`；https://github.com/electron/electron/issues/47514 |
| 标题栏 | `titleBarStyle: hidden/hiddenInset/customButtonsOnHover`，`trafficLightPosition`，`titleBarOverlay`（WCO） | 同上 |
| 原生菜单 | `Menu.setApplicationMenu`，`role` 预设；不需要默认菜单时尽早调用 `Menu.setApplicationMenu(null)`，有利于启动速度；v45 起 macOS 14+ 的 `MenuItem` 支持 `badge` | `docs/api/menu.md`；`docs/tutorial/performance.md`；v45.0.0 notes |
| 通知 | Electron 42 起改用 `UNNotification`，**未签名的应用会触发 `failed` 事件** | `docs/tutorial/notifications.md`；breaking-changes 42.0 |
| Dock | `app.dock` 的 `setMenu`/`setBadge`/`bounce` 等；v45 新增 macOS app shim（窗口可以挂在另一个 Dock 图标下） | `docs/tutorial/macos-dock.md`；v45.0.0 notes |
| Deep link | `app.setAsDefaultProtocolClient`；macOS 上要在 `ready` 之前注册 `open-url`；Windows/Linux 走 `second-instance`，需配合 `requestSingleInstanceLock`；Info.plist 的 `CFBundleURLTypes` 由 Forge `packagerConfig.protocols` 生成 | `docs/tutorial/launch-app-from-url-in-another-app.md` |
| 文件关联 | Electron 没有运行时 API。靠打包工具写 `CFBundleDocumentTypes`（Packager 用 `extendInfo`，electron-builder 用 `fileAssociations`），运行时监听 `app.on('open-file')`【推测：文档里没有专门的教程页】 | — |
| 全局快捷键 | `globalShortcut`；部分媒体键需要 "trusted accessibility client" 授权 | `docs/api/global-shortcut.md` |
| Passkey | v45 新增 `app.configureWebAuthn()`（iCloud 钥匙串 passkey） | v45.0.0 notes |

---

## 7. 启动与内存优化

官方 Performance 清单共 8 条（https://github.com/electron/electron/blob/v45.3.2/docs/tutorial/performance.md ）：

1. Carelessly including modules：先用 `--cpu-prof`/`--heap-prof` 测出依赖的加载成本。文中举例：`request` 加载约 0.5 s，`node-fetch` 不到 50 ms，测于作者本机。
2. Loading and running code too soon：延迟加载，把重活推到首屏之后（文中以 VS Code 先显示文本、后做高亮为例）。
3. Blocking the main process：长时间 CPU 任务交给 worker threads 或独立进程；避免同步 IPC 和 `@electron/remote`；只用异步 I/O。
4. Blocking the renderer process：用 `requestIdleCallback`、Web Worker。
5. Unnecessary polyfills。
6. Unnecessary or blocking network requests：字体等资源打进包里。
7. Bundle your code：打成单文件，减少 `require` 开销。
8. Call `Menu.setApplicationMenu(null)` when you do not need a default menu（要在 `ready` 之前调用）。

其他事实：

- **V8 snapshot**：
  - 官方只在 fuse 文档里提到。`LoadBrowserProcessSpecificV8Snapshot` 让主进程使用 `browser_v8_context_snapshot.bin`，`electron-mksnapshot`（45.3.2，2026-11-13）用来生成 snapshot。
  - 代价，原文："When the main process runs on a custom V8 snapshot ... Electron bootstraps the main process's Node.js environment from source instead of from its embedded Node.js startup snapshot ... This costs part of the main-process startup time the embedded snapshot otherwise saves"。
  - v45 起这个 fuse 在 macOS arm64、Linux x64、Windows x64 的主进程上可用（v45.0.0 notes）。
- **`v8.setFlagsFromString`、Node 编译缓存（`module.enableCompileCache`）**：Electron 文档里没有推荐，Electron 内能否使用【未确认】。
- **官方基线数字**：没有找到 Electron 官方发布的启动时间或内存基线【未确认】。只有本机样本：Claude Desktop 安装后 621 MB，其中 Electron Framework 250 MB【实测】。
- **对 PiArc 的建议**【推测】：
  - 主进程只做窗口、IPC 路由和 Core 加载；Core 的重活在 Rust 线程里跑，用 TSFN 回调。
  - Agent Host 是独立进程，不影响首屏。
  - 渲染进程按路由拆包，终端和 diff 组件懒加载。
  - M0 用 `--cpu-prof` 和 `app.getAppMetrics()` 建立基线。

---

## 8. Windows 子进程树隔离

| 选项 | 是否真实存在 / 状态 | 要点 | 来源（日期） |
|---|---|---|---|
| Claude Code 的说法 | ✓ 已核实 | 原文："The sandbox runs on macOS, Linux, and WSL2. On native Windows, Claude Code runs commands unsandboxed. To use the sandbox on a Windows machine, run Claude Code inside a WSL2 distribution"；开启 `failIfUnavailable` 时在原生 Windows 上会直接退出；WSL1 不支持 | https://code.claude.com/docs/en/sandboxing （2026-11-14 抓取） |
| **MXC**（Microsoft eXecution Container） | ✓ 是微软的真实 SDK，MIT 许可 | 仓库创建于 2026-02-06。GitHub release v1.0.0（2026-10-07）、v1.0.1（2026-10-17）；npm `@microsoft/mxc-sdk` 1.1.0（2026-11-14）。Windows 默认后端 `processcontainer`（基于 BaseContainer，ACL 语义与 `ALL_APPLICATION_PACKAGES` 相同，属于 AppContainer 一族【推测】）。实验性后端：`windows_sandbox`、`microvm`（仅 x64）、`hyperlight`，另有 `wslc`、`isolation_session`。macOS 后端是 seatbelt，Linux 是 bubblewrap。Process Isolation 最低要求 Win11 24H2/25H2 build 26100/26200.**9278**（KB5120998，2026-08）。**Windows release 构建会发送不可关闭的 Required 遥测**（4 类事件） | https://github.com/microsoft/mxc （README、docs/backends/process-container/os-version-support.md、filesystem.md） |
| AppContainer | ✓ | 隔离凭据、设备、文件、网络、进程、窗口；默认拒绝，跑开发工具链摩擦大（见 native-stack.md 8.3） | https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation （ms.date 2025-07-08） |
| Win32 app isolation | 预览版 | 基于 AppContainer，要求 Win11 24H2+ 并以 MSIX 打包，"This feature is in preview" | https://learn.microsoft.com/en-us/windows/win32/secauthz/app-isolation-overview （updated 2025-05-15） |
| Windows Sandbox | ✓ | 基于 Hyper-V 的一次性 VM；只支持 Pro/Enterprise/Education，**不支持 Home**；"doesn't allow multiple instances to run simultaneously"；默认开网络。不适合给每个工作区开一个实例 | https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/ （updated 2026-10-08） |
| Job Object | ✓ | 不提供安全隔离，但 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 能保证宿主退出时整棵进程树被清掉，**必须使用** | native-stack.md 8.3 |
| Codex 方案、srt Windows alpha | — | MXC / elevated（独立账户 + 防火墙）/ unelevated（restricted token + ACL）；srt 用专用本地账户 + WFP + write-restricted token | native-stack.md 8.2、8.3 |

**建议**【推测】：

- Windows 首版只用 Job Object 管进程树，**不承诺 OS 沙箱**。UI 上要像 Claude Code 一样明示"Windows 原生环境下命令不在沙箱中运行"。
- MXC ProcessContainer 放到后续阶段评估，前提是用户基数中 Win11 24H2 26100.9278+ 的占比足够，并且接受它的遥测。
- 不建议把 WSL2 作为首版前置要求。

---

## 9. 前端库（长对话流式渲染）

| 包 | 版本 | 日期 | 备注 |
|---|---|---|---|
| `react` / `react-dom` | **19.3.1** | 2026-10-14 | 19.3.0 发布于 2026-09-09，新增 `<ViewTransition />`、`addTransitionType`（https://react.dev/blog/2026/09/09/react-19-3 ）；19.3.1 改进 RSC 传输协议，同日还发布了 19.2.9/19.1.10/19.0.9 |
| `vite` | **8.3.8** | 2026-11-11 | 8.0.0 发布于 2026-03-12；engines `^20.19.0 \|\| >=22.12.0`；Forge 8 的 Vite 插件目标就是 Vite 8 |
| `react-virtuoso` | **4.18.22**（MIT） | 2026-11-12 | 类型定义里有 `followOutput`、`alignToBottom`、`firstItemIndex`（往前插入时保持位置）、`initialTopMostItemIndex`、`atBottomStateChange`、`atBottomThreshold`【实测，读 d.ts】；用 ResizeObserver 自动处理高度变化 |
| `@virtuoso.dev/message-list` | 1.19.6（**Commercial**） | 2026-11-13 | 专为聊天设计。原文："distributed under a commercial license"，需要 `VirtuosoMessageListLicense licenseKey`；scroll modifier 支持 `auto-scroll-to-bottom`、`items-change`（示例演示了机器人回复流式变长时跟随滚动）；价格【未确认】 |
| `@tanstack/react-virtual` | **3.14.26**（MIT，依赖 virtual-core 3.19.11） | 2026-11-03 | virtual-core **3.16.0**（2026-05-25）起：`anchorTo: 'end'`（原文 "for chat, logs, and reverse/inverted feeds"，往前插入时保持当前可见项不动）、`followOnAppend`（只在已处于底部时跟随新内容）、`scrollEndThreshold`、`isAtEnd()`/`getDistanceFromEnd()`/`scrollToEnd()`/`cancelScroll()`；后续多个补丁修了 end-anchor 和 iOS 相关问题 |

来源：npm registry（2026-11-14）；https://github.com/facebook/react/releases ；https://tanstack.com/virtual/latest/docs/api/virtualizer ；https://github.com/TanStack/virtual/blob/main/packages/virtual-core/CHANGELOG.md ；https://virtuoso.dev/message-list/

**建议**【推测】：

- 首选 @tanstack/react-virtual 3.14.x：MIT，headless，有 `anchorTo: 'end'` + `followOnAppend`。
- react-virtuoso 4.x 作为备选，开箱即用程度更高。
- 只有在 M0 实测两者都扛不住"流式消息持续变高并跟随底部"时，才考虑付费的 Message List。
- 不管选哪个，流式 token 都要在 Core 侧或渲染进程里批量合并，按每帧一次更新，不要每个 token 触发一次 React 更新。

---

## 10. M0 需要回答的问题

1. **Seatbelt profile 能否跑通**：bundled node + Pi 1.5.2（npm latest，2026-11-10，engines `>=22.19.0`）在 profile 下能否完成 bash/grep/find（Pi 用 child_process 实现）、git、`npx` 拉 MCP server、worker_threads（Pi 有 `image-resize-worker.js`）。写入范围限定为工作区、app 数据目录和临时目录。
2. **library validation**：给 bundled node 开 hardened runtime 并只加 `allow-jit` 后，npx 装进来的含原生模块的 MCP server（如 better-sqlite3、sharp）能否加载？加载失败的话，是否只给这个 node 加 `disable-library-validation`？
3. **Pi 的路径解析**：Pi 用 `process.execPath` 推导资源目录（`dist/config.js`、`dist/utils/photon.js`）。换成 bundled node 加独立目录布局后，是否需要用 `PI_PACKAGE_DIR` 覆盖？
4. **npx 用谁的 node**：优先用 bundled node，还是用户 shell PATH 里的 node（Claude Desktop 有 "Shell Environment Extractor"）？版本冲突和 PATH 注入的风险怎么处理？
5. **Core 拉起进程**：Rust 拉起 `sandbox-exec`/node 并管 stdio，Windows 用 `CreateProcess` 加 Job Object，测量 stdout 流到渲染进程的吞吐和延迟（TSFN → 主进程 → `MessagePortMain` → 渲染进程）。TCC 归属问题：Electron 的 `disclaim` 只对 utilityProcess 有效，Rust 拉起的子进程需要单独研究 responsibility disclaim【未确认】。
6. **asar 布局**：Agent Host 的 JS bundle、node、`.node` 文件都放在 asar 外（v45 起 asar fd 限制变严），ASAR integrity 只覆盖 app.asar，asar 外文件的完整性靠代码签名（macOS 会封装进 `_CodeSignature`）【推测】。
7. **fuse 组合回归**：关掉 `RunAsNode`/`NodeOptions`/`NodeCliInspect`、`GrantFileProtocolExtraPrivileges` 后，确认 Forge、Vite、DevTools 调试流程没有问题。开发构建和发布构建的 fuse 配置分开。
8. **Windows 安装与更新 spike**：Velopack 1.2.161 对比 MSIX，看 Forge/Vite 集成、delta 大小、按用户安装、卸载清理。确认签名主体是否符合 Artifact Signing 资格。
9. **Liquid Glass**：接受只用 vibrancy，还是自己写 NAPI 插件封装 `NSGlassEffectView`（参考已关闭的 PR #50415 的实现思路，自行承担维护）？
10. **Electron 升级节奏**：按季度跟进大版本。Electron 46（2027-01-05†）会把内置 Node 升到 26，主进程和 Core 插件要回归测试。NAPI-RS 插件在 Windows arm64 上需要实际验证"不重编也能在新版 Electron 加载"。
11. **基线测量**：冷启动到首屏、主进程/渲染进程/Agent Host 的 RSS、50k token 对话的滚动帧率，目标值在 M0 结束时写进 ADR。

---

## 11. 主要来源索引（2026-11-14 抓取或查询）

- Electron 文档（tag v45.3.2）：`README.md`、`docs/tutorial/{electron-timelines,security,fuses,performance,asar-archives,asar-integrity,using-native-node-modules,process-model,updates,forge-overview,distribution-overview,launch-app-from-url-in-another-app,notifications,macos-dock,multithreading}.md`、`docs/api/{utility-process,environment-variables,auto-updater,process,global-shortcut,menu,protocol}.md`、`docs/api/structures/base-window-options.md`、`docs/breaking-changes.md` — https://github.com/electron/electron/tree/v45.3.2/docs
- Electron 源码：`shell/browser/api/electron_api_utility_process.cc`（v45.3.2）
- https://releases.electronjs.org/ ，https://releases.electronjs.org/schedule
- https://github.com/electron/electron/releases/tag/v45.0.0 ，release v45.3.2 assets
- https://github.com/electron/electron/pull/50415 ，https://github.com/electron/electron/issues/47514
- https://chromium.googlesource.com/chromium/src/+/main/content/public/common/content_switches.cc
- @electron/fuses 2.1.3 tarball（`dist/config.d.ts`）
- https://github.com/electron/forge/releases/tag/v8.0.1 ，https://github.com/electron/notarize ，https://github.com/Squirrel/Squirrel.Mac ，https://github.com/Squirrel/Squirrel.Windows
- https://github.com/electron-userland/electron-builder/tree/master/website/docs ；app-builder-lib 26.18.0 `scheme.json`
- https://github.com/velopack/velopack.docs/blob/master/docs/getting-started/javascript.mdx ，https://github.com/velopack/velopack/releases
- https://github.com/microsoft/vscode （main：`package.json`、`extensionHostStarter.ts`、`utilityProcess.ts`）
- https://github.com/napi-rs/website （`content/docs/*`），https://github.com/napi-rs/napi-rs/blob/main/crates/sys/Cargo.toml ，https://crates.io/crates/napi
- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/distribution-feature-status
- https://learn.microsoft.com/en-us/azure/artifact-signing/{overview,quickstart,faq}
- https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation ，https://learn.microsoft.com/en-us/windows/win32/secauthz/app-isolation-overview
- https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/
- https://github.com/microsoft/mxc ，https://github.com/microsoft/winget-cli/releases
- https://code.claude.com/docs/en/sandboxing ，https://support.claude.com/en/articles/12622703-deploy-claude-desktop-for-windows
- https://nodejs.org/dist/index.json
- https://tanstack.com/virtual/latest/docs/api/virtualizer ，https://virtuoso.dev/message-list/ ，https://github.com/facebook/react/releases
- 本机样本【实测】：`/Applications/Claude.app`（5.1231.2）、`/Applications/Cursor.app`（3.30.14）的 fuse、entitlements、bundle 布局和 asar 字符串
