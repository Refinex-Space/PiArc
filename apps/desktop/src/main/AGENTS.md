# apps/desktop · src/main

主进程：窗口、菜单、托盘、启动目标、平台集成与 Core 的加载转发（ADR-0013、ADR-0014）。应用级的命令、安全基线与 L4 见上级 [`apps/desktop/AGENTS.md`](../../AGENTS.md)。

## 命令

| 命令 | 用途 |
|---|---|
| `npx vitest run apps/desktop/src/main` | 主进程纯函数：启动目标解析、窗口状态的放置、托盘的计数与菜单、Windows 注册表命令、路由、IPC 校验 |
| `node scripts/dev/export-tray-icons.mjs [--check]` | 从 `design/brand/mark.svg` 导出菜单栏 template 图与 Windows 托盘 `.ico` 到 `design/brand/`（`--check` 只比对） |
| `PIARC_EVIDENCE_TASK=T35 npx playwright test -c apps/desktop/playwright.config.ts t35- --project dev` | T35 L4：worktree 会话与归档询问、搜索定位、两个窗口的审批、无窗口后台运行与托盘计数、退出确认、链接与第二次启动、窗口状态（截图在 `tmp/evidence/T35/`） |

## 窗口（T35，ADR-0052）

- `AppShell` 管任意多个主窗口：最近获得焦点的是"当前"主窗口（菜单命令、系统通知、Dock 角标只认它）；全部窗口共用一个 Core、订阅同一批快照，审批的先到答复由 Core 的账本裁定。
- 设置在发起操作的工作台中显示为模态面板。`settingsOpen` IPC 将调用窗口绑定到 `LaunchTarget` 的 `settings` 分支；应用菜单选取最近聚焦的工作台，无窗口时先创建工作台。打开请求沿用 `takeLaunchTargets` 的就绪队列，同页重复定位（例如记忆笔记）也会送达。
- 首次主窗口以 1200 × 800 DIP 为基准，居中放入主显示器的工作区。正常最小尺寸为 960 × 600 DIP；当显示器工作区更小时，原生最小尺寸按轴缩小至可用范围。
- 窗口状态：主窗口移动、缩放（防抖 500 ms）与关闭时写 `<userData>/window-state.json`（`platform/window-state.ts`，同目录临时文件 + rename）；新窗口按 24 px 错开，`placeWindow` 把落在已不存在显示器上的窗口移回主显示器居中。
- 关闭最后一个窗口不退出（两个平台一样）。退出只经菜单与托盘的 `app.quit` 命令（`platform/quit.ts`）：Core 的 `runningWork()` 报告有运行中的会话或后台任务时先弹原生确认；系统注销、测试驱动的 `app.quit()` 不询问。不要把确认挂到 `before-quit` 上。

## 应用内更新（ADR-0111）

- 调度与命令在 `core/updates-ipc.ts`（`UpdateScheduler`：启动 30 s 后检查，之后每小时看一次是否满 24 h，读偏好 `updates.autoCheck`；`installUpdate`：取 Core 的安装计划 → `mayQuit` → 平台步骤 → `app.quit()`）。平台步骤在 `platform/update-installer.ts`：macOS 用 `platform/mac-update.ts`（`bundleOf`、`replaceable` 拒绝 App Translocation 与不可写目录、`stageMacUpdate` 用 `ditto -x -k` 解压到同卷的 `.PiArc.app.update-<版本>/` 并用 `plutil` 核对 `CFBundleIdentifier` 与 `CFBundleShortVersionString`、`startSwap` 以分离的 `/bin/sh` 运行 `SWAP_SCRIPT`，日志在 `<缓存>/updates/install.log`），Windows 用 `platform/windows-update.ts`（Velopack `UpdateManager` 以 Core 下载的目录为源，版本必须与 Core 校验的一致）。源码树运行（`!app.isPackaged`）一律答 `manual`。替换脚本的单测在真实 `/bin/sh` 上替换与回滚（`mac-update.test.ts`，只在 macOS 运行）。

## 托盘（`platform/tray.ts`）

- 计数只来自 Core：快照任务在路由 `core/activity` 发运行中与等待审批的会话数和等待审批的会话（不含归档），主进程经 `EventRouter.listen` 只监听这一个路由；不要在主进程订阅 `core/sessions` 自己统计。
- macOS：`trayTemplate.png`（+ `@2x`）设为 template 图，计数作为标题 `▸运行中 ?等待审批`。Windows：按 `nativeTheme.shouldUseDarkColorsForSystemIntegratedUI` 选 `tray-dark.ico`（白）或 `tray-light.ico`（黑），左键打开窗口，计数在提示文字里。图标目录：打包时在 `process.resourcesPath`（Forge `extraResource`），源码树运行时在仓库的 `design/brand/`。

## 防止休眠（`platform/keep-awake.ts`，ADR-0109）

- 偏好 `power.keepAwake`（默认开）且 `core/activity` 的 `running` 大于 0 时持有一个 `prevent-app-suspension` 阻止器，否则立即释放；`main.ts` 在读到偏好后、偏好变化时与每批 activity 调用 `KeepAwake`，`will-quit` 时 `dispose`。运行数只取这个路由，后台命令与终端不计入。Electron 调用经 `PowerBlocker` 端口（单测用替身），测试钩子 `keepAwake()` 读是否持有；`e2e/keep-awake.e2e.ts` 在 macOS 上另用 `pmset -g assertions` 核对 `NoIdleSleepAssertion`。

## 启动目标（`launch.ts`）

- `piarc://open?path=<绝对路径>` 与 `piarc://session/<id>` 只做定位；这两种链接继续忽略提示词。T49 专用的 `piarc://draft?path=…&text=…` 只预填新会话草稿，由用户手动发送。T29 的 OAuth 回调走回环端口，不经这里。
- 命令行：第 0 个参数是可执行文件；`process.defaultApp`（`electron <app>`）时第一个非开关参数是应用路径要跳过（Playwright 会把自己的开关放在它前面，不能按固定位置跳）。两个固定的跳转列表开关打开新会话或文件夹选择器，其他开关忽略，相对路径按工作目录解析。
- 来源都汇成 `LaunchTarget`：启动参数、第二次启动（`second-instance` 带 argv 与工作目录）、macOS `open-url`/`open-file`（要在 `ready` 之前注册，先进 `early` 队列）、拖入窗口的文件夹（preload `pathForFile`）。窗口页面挂载前的目标排在 `AppShell` 的队列里，页面经 `takeLaunchTargets` 取走，之后的目标作为 `launch` 应用事件送达。主进程不检查路径是否为目录，交给 Core 的 `openWorkspace`。
- macOS 的 scheme 与文件夹文档类型在 `forge.config.ts` 的 `protocols`、`extendInfo`；只有打包构建调用 `setAsDefaultProtocolClient`。Windows 的注册在 `platform/windows-shell.ts`（`HKCU\Software\Classes`，系统目录的 `reg.exe`，不经 shell），由 `platform/velopack.ts` 的安装、更新、卸载钩子运行。

## 系统通知（`platform/attention.ts`，T18、T42）

- 系统通知只经 `NotificationPort`（`ELECTRON_NOTIFICATIONS` 是 Electron 的实现）：测试换成替身，断言按钮与 `answerApproval` 的参数；不要在别处 `new Notification`。
- 等待审批的通知按卡片的 `notificationAllow`（Core 在 `tool_io/policy/notify.rs` 判定：普通短命令、小改动）给"仅本次允许"与"拒绝"，否则只给"打开"；主进程不自己判断风险。按钮经 `connect` 接上的 `answerApproval` 答复，带 `via: notification` 与卡片的 `requestId`、`revision`、`connectionEpoch`，与审批卡走同一账本；没被采用的答复以应用事件 `approvalNotice` 告诉窗口。开发构建的测试钩子 `notificationAction` 模拟按下按钮（`e2e/t42-notify.e2e.ts`）。
- macOS 上 Electron 对关掉通知的用户也报 `show`，所以通知之外总有 Dock 弹跳与应用内提醒（I43）；`notificationsSupported` 为假时设置页说明原因。

## 易错点

- 截取菜单栏需要终端有"屏幕录制"权限；L4 用测试钩子 `tray()` 读标题、提示与菜单项，不依赖截图。
- 测试钩子 `launch`、`quit`、`mainWindows`、`tray` 只在开发版 Core 时安装（`core/test-hooks.ts`）。

## 打包产物与构建形态（S6）

- 开发构建的 Core 导出 `agentHostProbe`（从 `process.resourcesPath` 下的 `agent-host/` 按生产方式启动 Agent Host，跑一轮对话）与 `keychainProbe`；主进程测试钩子另有 `showNotification`。模型经测试数据目录的 `pi/models.json` 指向 mock provider，MCP server 来自测试数据目录 `settings.json` 的 `mcpServers`（T36，探针只读这一处），不需要额外的启动参数；发布构建没有这些导出。
- `e2e/agent-host.e2e.ts`、`e2e/agent-host-kill.e2e.ts`、`e2e/notification.e2e.ts` 只在 `packaged` 项目运行（`playwright.config.ts` 的 `testIgnore`）：`dev` 形态没有 `Resources/agent-host/`，签名也是 Electron 自己的。`agent-host-kill.e2e.ts` 只在 Windows 运行：回合进行中 `taskkill /F` 主进程，检查 Job Object 结束 Agent Host 的整棵进程树（S8）。两者共用 `e2e/agent-host.ts` 的 `startMock`。
- fuse 配置的单一来源是 `fuses.mjs`；`PIARC_BUILD_FLAVOR`（由 `package:desktop --flavor` 设置）选择配置，默认 `release`。开发构建只多开 `EnableNodeCliInspectArguments`，L4 的打包形态靠它被 Playwright 驱动。
- `electron-forge start` 用 node_modules 中的 Electron，不写 fuse，bundle 的名称与图标也是 Electron 的（主进程在未打包时用 `app.dock.setIcon` 换上 `design/brand/icon.iconset/icon_512x512@2x.png`，只改 Dock）；界面来自 Vite 开发服务器，开发服务器 origin 加入可信 origin，CSP 放宽三项（见 `dev-server.ts`）。
- `app-protocol.ts` 的两个传输共用资源范围、方法、MIME 和安全头。macOS 的原生缓冲区回调是 ADR-0072 的限定例外；升级 Electron 时同时复测资源契约与主进程内存。

项目文件菜单和预览采用 [ADR-0076](../../../../docs/adr/0076-project-files.md)。工作树由 Core 绑定。专用文档来源只供当前窗口的文件呈现；它没有工作台 IPC 权限。系统编辑器只从已知安装目录选择，文件名作为独立进程参数。
