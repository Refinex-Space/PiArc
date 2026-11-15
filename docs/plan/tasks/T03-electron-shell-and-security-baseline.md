# T03 Electron 应用骨架与安全基线（S10）

| 项 | 内容 |
|---|---|
| 阶段 | 1 M0 技术验证 |
| 依赖 | T02 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort xhigh，新会话 |
| 规模 | 大 |
| 关联验证项 | S10（Electron 安全基线） |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T03`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

PiArc 在 Chromium 中渲染模型输出和仓库内容，提示注入可能变成 XSS，进而调用 preload 暴露的能力（ADR-0013 的新增风险、风险 R13）。安全基线必须在第一行业务界面之前落地，之后的界面任务都在这套约束下工作。

本任务建立 `apps/desktop`：Electron Forge + Vite，主进程、preload、渲染进程三部分，落实第 10.3 节规定的渲染进程加固、preload 白名单、IPC 来源校验与 fuses，并搭好 L4 基座：Playwright 驱动开发模式与打包产物两种形态。

S10 的通过标准（架构第 16 章）：XSS 载荷集全部被拦截；Electron 官方安全清单逐项通过。本任务负责 CSP、导航、IPC、fuses 这一层；Markdown 渲染路径上的 XSS 载荷集由 T09 完成，R1 汇总。S10 的 Windows 结论来自 CI（冒烟、安全用例与 fuse 校验），W0 只补测 CI 无法覆盖的部分。

## 必读

1. 架构设计：
   - 第 3.1–3.4 节（分层、一次用户输入的完整流程、进程模型、仓库结构）
   - 第 8.1 节"进程与模块"
   - 第 10.1 节"威胁模型"中渲染进程注入、应用被当作通用运行时滥用、恶意链接与导航三行
   - 第 10.3 节"进程加固"全文
2. ADR-0013、ADR-0018（第 1 条 fuses）。
3. `docs/research/electron-stack.md` 第 1、2.2、3、6、7 节。
4. T02 交付的 `packages/protocol` 与 CLAUDE.md。
5. 实现时查阅（锁定版本的官方文档）：Electron 的 `protocol.handle`、`registerSchemesAsPrivileged`、`session.webRequest`、`setPermissionRequestHandler`、`setWindowOpenHandler`、`contextBridge`，以及 v45 breaking changes 中 sandboxed preload 的限制；Forge 的 `plugin-vite`、`plugin-fuses`；`@electron/fuses` 的读取接口；Playwright 的 Electron 支持。

## 范围

### 要做

- `apps/desktop` 三部分工程与最小窗口骨架。
- 渲染进程安全基线、preload 白名单、IPC 来源校验、单实例锁。
- fuses 配置（开发构建与发布构建分开）与产物 fuse 校验脚本。
- L4 基座：Playwright 冒烟与安全用例（开发模式与打包产物），截图证据约定。
- S10 报告。

### 不做

- Core 加载与事件通道（T04）；Markdown 渲染与 XSS 渲染载荷集（T09）。
- 安装包与签名（T12）：本任务只用 `electron-forge package` 产出可运行的应用目录。
- 业务界面与设计令牌（T18）、数据目录 `setPath`（T13）、`piarc://` 深链接与单实例参数转交（T35）、系统通知与托盘（T18、T35）。

## 交付物

### 1. 工程

- 开工时查 npm 与 releases.electronjs.org，确认当前受支持的最新稳定大版本并精确锁定（调研快照为 45.3.x）；Forge 及其插件、Vite、React 同样精确锁定（调研快照：Forge 8.0.1、Vite 8.3.x、React 19.3.x）。Electron 内置 Node 的大版本与 `.nvmrc` 不一致时，说明并按 T01 的规则调整。
- 目录按第 3.4 节：`src/main/`、`src/preload/`、`src/renderer/`。三个 TS 工程分别配置：主进程与 preload 不含 DOM 类型，渲染进程不含 Node 类型。
- 渲染进程：React 最小界面，只有三栏窗口骨架的占位。
- `BrowserWindow` 只在一个窗口工厂函数中创建，`webPreferences` 取值固定；ESLint 规则禁止在其他文件 `new BrowserWindow`。

### 2. 安全基线（逐条对应第 10.3 节）

| 项 | 要求 |
|---|---|
| 资源加载 | 自定义协议（`protocol.handle` + `registerSchemesAsPrivileged`）提供界面，不用 `file://`。协议名定义为一个常量，最终名称随应用标识（D2）确定；不用 `piarc://`，它留给深链接 |
| CSP | 主进程以响应头下发：`default-src 'self'`；`script-src 'self'`（无内联脚本、无 `eval`）；`connect-src` 只允许应用协议；`img-src` 只允许应用协议与 `data:` |
| webPreferences | `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`；不用 `<webview>`，不开实验特性与 `enableBlinkFeatures`，不关 `webSecurity`，不开 `allowRunningInsecureContent` |
| 导航 | `will-navigate` 与 `will-redirect` 中用 `new URL()` 比较 origin，只放行应用协议 |
| 新窗口与外链 | `setWindowOpenHandler` 一律 `deny`；外链由主进程弹原生确认框显示目标地址，确认后 `shell.openExternal`，只放行 `https:`、`http:`、`mailto:` |
| 权限 | `setPermissionRequestHandler` 与 `setPermissionCheckHandler` 默认拒绝；放行清单集中定义，本任务为空，后续任务按需加入并写理由 |
| 全局兜底 | 在 `app.on('web-contents-created')` 中给所有 webContents 挂上导航与新窗口处理 |
| 单实例 | `requestSingleInstanceLock`；第二个实例退出并聚焦已有窗口 |

### 3. preload 与 IPC

- `window.piarc` 白名单 API 骨架：本任务只放两三个样板命令（例如读取应用版本、经确认打开外链）；类型来自 `packages/protocol`，需要新类型时按 T02 的流程加入。
- preload 只 `require('electron')`（v45 sandboxed preload 的限制），不暴露 `ipcRenderer`；事件回调剥掉 Electron 的 event 对象再交给页面。
- 主进程的 `ipcMain.handle` 一律经统一注册函数：先校验 `event.senderFrame` 非空且 `origin` 等于应用协议的 origin（比较 origin，不做 URL 前缀匹配），不通过即拒绝并记录日志。

### 4. fuses

- Forge `plugin-fuses` 按 ADR-0018 第 1 条配置，`strictlyRequireAllFuses: true`。开发构建与发布构建分开：开发构建可以放开 `EnableNodeCliInspectArguments` 便于调试，其余与发布构建一致。
- `scripts/ci/check-fuses.mjs`：用 `@electron/fuses` 的读取接口读出打包产物的实际 fuse 状态，与发布配置逐项比对，不一致时列出并退出非 0。提供 `npm run check:fuses`，T12 的打包流程与 T50 的发布流水线调用它。

### 5. L4 测试基座

- Playwright 驱动两种形态：开发模式（加载生产渲染产物，经自定义协议）与 `electron-forge package` 的产物。
- 冒烟用例：窗口出现、骨架渲染、`window.piarc` 可用。安全用例见验收标准。
- 截图与日志证据存放在 `tmp/evidence/<任务编号>/`（不入库），约定写进 `docs/engineering/testing.md` 的 L4 一节。
- CI：macOS 与 Windows runner 都跑冒烟用例、安全用例，并对发布配置的 `package` 产物跑 fuse 校验。

### 6. S10 报告

`docs/spikes/S10-electron-security.md`，结构按 `docs/spikes/README.md`：

- Electron 官方安全清单 20 条逐条一行：落实方式、对应的测试或检查；不适用的写原因（例如不使用 `<webview>`）。
- 开发构建与发布构建的差异清单（fuses、开发服务器模式下的 CSP 放宽）。
- macOS 已验证：本机全部用例与 fuse 校验；Windows：以 CI 运行结果为准，未取得时在报告中注明，由 W0 核对。
- 更新 `docs/spikes/README.md` 中 S10 的状态与报告链接。

## 实现要点

- Vite 开发服务器需要 HMR 连接，React 插件还会注入内联脚本，与 `script-src 'self'` 冲突。开发服务器模式的 CSP 放宽只允许出现在开发构建，放宽项集中在一处并写进 S10 报告；安全用例一律针对生产渲染产物运行。
- 自定义协议用 `standard: true, secure: true` 注册，origin 才稳定。来源校验写成纯函数，接收 `senderFrame` 的最小接口：单元测试覆盖空 frame、其他 origin、前缀相似的 origin（合法 origin 后追加字符），端到端测试证明合法调用能通过。
- 外链确认框与 `shell.openExternal` 经一层可替换的接口调用，测试中替换为可断言的替身，不真的打开浏览器。
- 路径拼接用 `path.join`；Playwright 定位打包产物的可执行文件按平台解析，集中在一个测试辅助函数里。

## 验收标准

- [T03-A01] Electron、Forge 及其插件、Vite、React 精确锁定，Electron 大版本在官方支持的最新 3 个大版本之内。验证：`package.json` 与 `npm view electron` 输出。
- [T03-A02] 开发模式与 `electron-forge package` 产物都能启动并通过 Playwright 冒烟用例。验证：macOS 本机测试输出与截图。
- [T03-A03] CI 配置在 macOS 与 Windows runner 上运行冒烟用例、安全用例与 fuse 校验，配置语法有效。验证：actionlint（或 YAML 解析）输出；Windows 实际运行结果未取得时标 `blocked`，由 W0 核对。
- [T03-A04] 页面中注入的内联脚本、内联事件属性与 `eval` 都不执行，访问外部地址的 `fetch` 与外部图片被 CSP 阻止。验证：Playwright 安全用例。
- [T03-A05] 页面导航到外部地址（修改 `location`、点击链接、重定向）被拦截，窗口仍停留在应用协议页面。验证：Playwright 安全用例。
- [T03-A06] `window.open` 被拒绝；外链经确认后才调用 `shell.openExternal`，`javascript:`、`file:` 及其他非白名单协议被拒绝。验证：Playwright 用例（确认框与 `openExternal` 用替身断言）。
- [T03-A07] `window.piarc` 的键集合与白名单快照完全一致，页面中拿不到 `ipcRenderer`。验证：Playwright 枚举测试。
- [T03-A08] IPC 来源校验拒绝 frame 为空、origin 不同、origin 前缀相似三种情况，合法调用通过。验证：单元测试与端到端测试。
- [T03-A09] 渲染进程中 `require`、`process`、`module`、`Buffer` 均不可用。验证：Playwright 用例。
- [T03-A10] 未放行的权限请求（通知、摄像头、地理位置）被拒绝。验证：Playwright 用例。
- [T03-A11] 页面经自定义协议加载（`location.protocol` 不是 `file:`）；第二个应用实例启动后立即退出并聚焦已有窗口。验证：Playwright 用例。
- [T03-A12] 发布配置 `package` 产物的 fuse 状态与配置一致；临时改动一项配置后 `check-fuses.mjs` 失败并指出该项。验证：脚本输出。
- [T03-A13] S10 报告覆盖官方安全清单 20 条，每条有落实方式与对应测试或检查，`docs/spikes/README.md` 已更新。验证：文件内容。
- [T03-A14] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 创建 `apps/desktop/CLAUDE.md`：三部分的入口、安全基线的位置与不变量（新增 IPC 命令必须经统一注册函数、新增权限放行必须写理由、不得放宽 CSP）、开发构建与发布构建的差异、L4 测试命令。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：IPC 注册与来源校验、外链确认、窗口工厂、`check-fuses.mjs`。
- 根 `CLAUDE.md` 的"命令"一节补上启动、打包、L4 测试命令（实际执行成功后）。
