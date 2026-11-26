# apps/desktop · src/main/browser

内置浏览器的主进程部分（ADR-0088–0093，设计增补 `docs/architecture/addenda/browser.md`）：用户的标签与面板（B1），以及智能体的 `Browser` 工具在主进程这一侧的全部（B2）。权限、审计、站点卡与文件读写的判断在 Core；这里只装配、转发与按 Core 的回答执行。

## 模块

| 模块 | 职责 |
|---|---|
| `service.ts` | `BrowserService`：每会话的 Space 与标签、视图摆放、提示条、下载、恢复（只恢复归用户的标签）；给智能体侧的 `agentModel`、`gatedPage`、`agentPagesOn`、`userPorts`，以及 `setGate`、`setControl` 两个安装点 |
| `partitions.ts`、`guest-session.ts`、`request-rules.ts` | 分区命名与识别；guest 分区的代理、权限、下载、请求规则（协议、链路本地、PiArc 端口），再交给可选的请求闸门 |
| `tab.ts`、`view-host.ts`、`keymap.ts` | 一个标签的 `WebContentsView`、导航守卫、设备模拟；视图挂载与停车窗口；页面内的键位 |
| `workspace-files.ts`、`address.ts` | `piarc-browse:` 工作区文件；地址栏解析 |
| `file-grants.ts` | "打开 HTML 文件…"选的工作区外文件（B1.6.2）：该文件所在目录以自己的 `piarc-browse://<令牌>/` 提供，解析链接后不出目录，标签关闭即撤销 |
| `recents.ts`、`suggestions.ts`、`start-page.ts` | 每工作区的最近访问（`<userData>/browser/recents.json`，原子写）；地址栏建议的排序（历史、标签、本地服务）；起始页的请求（启动配置、用户点击运行与停止、建议）与 SDK `servers()` 的结果形状 |
| `dev-servers.ts` | Core 的 `core/browser` `ports`/`servers` 快照（按主会话）：闸门放行的端口（监听中与启动配置声明的）、每会话每端口一次的就绪通知、失败通知（ADR-0092） |
| `agent-runtime.ts` | 装配智能体侧：Space、闸门、绑定、脚本宿主、Core 桥；`main.ts` 注册宿主 IPC 与 `core/browser` 路由 |
| `agent-bridge.ts` | 启动时 `attachBrowserClient`；`core/browser` 的 `run` 交给脚本宿主、答复经 `answerBrowserRun`，`cancel` 结束宿主 |
| `script-host.ts`、`host-session.ts` | 每次调用一个新的沙箱宿主（预热一个），超时与崩溃结束运行并带回已打印的输出，用户可停止；宿主分区只服务自己的页面，其余请求全部取消 |
| `host-bindings.ts` | 宿主每个绑定请求的校验与分派（脚本能直接调用 `window.piarcBrowserHost`，按不可信输入处理）；截图附件经 `nativeImage` 解码后按真实尺寸缩到长边 1,568 px，超过 3.75 MiB 降质为 JPEG（`fitImage`，B2.6.7）；被拒的 CDP 方法与页面被拒的权限记进本次调用（审计行、工具结果） |
| `agent-spaces.ts` | ego 语义的 Space：数字 id、`agent` / `agentDelegatedToUser` / `user`、每会话至多 4 个、用户自己的标签只报数量；用户接管、交还；页面账本（按会话与 id，与 Space 的存续无关） |
| `cdp-proxy.ts`、`cdp-policy.ts` | 给 SDK 的浏览器级 CDP：只答本 Space 的 `Target.*` 与 `Browser.getVersion`，页面命令经允许名单（B2.6.5）后转给标签的 debugger，OOPIF 子会话映射为虚拟 id |
| `agent-gate.ts` | 请求闸门（B2.6.1–B2.6.4）：智能体控制的 Space 里每个请求按会话与本次调用的授权、本会话的本机端口（用户打开过的、会话进程树监听的、启动配置声明的）判断，文档与框架问 Core（站点卡），其余拦截并记入本次调用的结果 |
| `snapshot.ts`、`frames.ts` | ego 规格的快照（DOMSnapshot + 无障碍树，OOPIF 拼接）；标签的 OOPIF 会话自动附着 |
| `cursor.ts` | 智能体光标与动作标签（隔离 world、closed shadow root、`pointer-events: none`） |
| `browser-ipc.ts` | 面板命令的校验（含 `control`：接管、交还、停止） |
| `chrome-import.ts`、`import-ipc.ts` | 从 Chrome 导入登录（B5.1–B5.4，ADR-0090）：设置页的命令、原生确认（`NativeConfirm`）、经 Core 解密后写入工作区的持久分区（`cookies.set`），页面只拿到每站点的条数；移除先删分区里的 cookie 再删 Core 的记录；"退出即清空"模式下答 `unavailable`；导入站点（含子域名）给闸门的 `importedHost`，按工作区缓存 |
| `throttling.ts` | B5.6：隐藏的页面节流（`setBackgroundThrottling`），只有调用正在运行的智能体 Space 不节流；`service.ts` 在 Space 状态变化时施加 |
| `console-log.ts`、`site-zoom.ts`、`live-reload.ts`、`quarantine.ts` | 每个标签的 console（最近 1,000 条，按序号增量读）；按分区与站点记住缩放（持久分区写 `zoom.json`）；工作区页面跟随文件改动刷新（经 Core 解析路径、`fs.watch` 只作失效通知）；下载完成补 quarantine / `Zone.Identifier` |
| `agent-downloads.ts`、`state-reminders.ts` | 运行中调用的标签下载写进会话的下载目录并以 CDP 事件报给 SDK，保存经 Core `browserFiles`（B2.6.6）；两次调用之间用户改动的 Space 经 Core `browserState` 成为下一次请求前的提醒（B2.7.3） |
| `picker.ts`、`element-context.ts`、`source-map.ts`、`capture.ts` | B3：CDP Overlay 拾取（只认 `Overlay.inspectNodeRequested`，智能体驱动页面时拒绝）与右键"加入对话"；元素上下文（DOM 事实在隔离 world、框架事实在页面 world，主进程逐项校验与截断）；React 19 `_debugStack` 经同源 source map 定位，源码路径 realpath 后必须在工作区内；可见、整页、元素截图 |

## 不变量

- 智能体的页面只经 `agent-gate.ts` 放行新主机：不要在别处给智能体的标签开例外；Core 的 `browserSite` 是唯一能让用户批准新站点的入口，卡片绑定正在运行的那次调用。
- 脚本宿主只经 `registerHostHandler` 的通道与主进程通信，且只应答正在运行的那次调用的宿主；宿主分区不能联网（`host-session.ts`）。新增绑定先在 `src/shared/browser-host.ts` 加形状，再在 `host-bindings.ts` 校验。
- CDP 方法的放行只改 `cdp-policy.ts`，每加一类在 `cdp-policy.test.ts` 加用例；被拒的方法进本次调用的审计。
- 智能体控制的 Space 的标签不写进会话的恢复清单（`service.ts` 的 `#save`），用户接管或智能体完成后归用户的才写。
- Core 的错误类别与主机字符串一律当数据显示（`revealBidi`），不拼进 HTML。
- 导入的 cookie 值只在 `chrome-import.ts` 里从 Core 的答复写进分区，不进日志、错误与页面；`cookies.set` 失败只计数（Chromium 的错误可能引用值）。不要对浏览器分区调用 `partitions.guest(…, () => undefined)` 取 session：那会让分区以后不再装守卫与代理，用 `persistentPartition`（`session.fromPartition`）。

## 测试

| 命令 | 内容 |
|---|---|
| `npx vitest run apps/desktop/src/main/browser` | 主进程纯逻辑：地址、请求规则、分区、视图摆放、快照（录制的 CDP 夹具）、CDP 代理与允许名单、闸门、桥、宿主页面路径 |
| `PIARC_EVIDENCE_TASK=browser npx playwright test -c apps/desktop/playwright.config.ts browser- --project dev` | L4：`browser-basic`（B1 面板、隔离、遮挡、停车、工作区文件、地址栏单层焦点环）与 `browser-agent`（经测试钩子 `browserScript` 跑脚本：快照、填写、点击、截图、闸门、控制条、宿主隔离 THR-05、超时、CDP 拒绝；mock 模型的 `Browser` 调用端到端与 transcript 截图）。先 `npm run package:desktop -- --flavor development` |

## 易错点

- `electron-forge start` 会清掉 `.vite/renderer`，之后 `dev` 形态的 L4 报 "Production bundle not found"：重新打开发构建。
- 宿主页面的 `print` 是临时输出：一行输出在静默一段时间后立即同步发出（脚本之后可能死循环、到不了微任务），连续输出按微任务合并；`finish` 的输出是权威结果。
- 附加 CDP 之后 JS 对话框仍由 Electron 弹原生框，`prompt()` 不可用（B1.3.3 的偏差，见设计增补）。
