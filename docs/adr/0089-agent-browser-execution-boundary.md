# 0089. 智能体浏览器的执行边界

- 状态：已接受（2026-11-26 用户确认）
- 日期：2026-11-26
- 修订：ADR-0013"主进程只做平台集成与转发"（增加浏览器平台集成）
- 相关：ADR-0004（策略在 Core、工具 I/O 下沉 Core）、ADR-0020（Agent Host 不碰 I/O）、ADR-0031（审批绑定同一调用）、ADR-0036（句柄读写）、ADR-0045（WebFetch）、ADR-0049（任务）、ADR-0056（沙箱网络卡）、ADR-0088、ADR-0091；[设计增补](../architecture/addenda/browser.md)

## 背景

用户决定：智能体用 ego 风格的 JS 驱动内置浏览器，脚本跑在沙箱化的 Chromium 渲染进程里，没有文件、网络、子进程能力，默认不逐次审批，外站按域名审批。这是仓库里第一个在 Electron 里执行的智能体工具，也是第一次 Core 向客户端发起"请求—应答"。ego-lite 原版的脚本跑在完整 Node 里，安全由外层 CLI 的 Bash 审批承担，不能照搬。

## 决策

1. **工具与链路。** Agent Host 注册 `Browser` 工具（`script`、`description?`、`timeoutMs?`），能力 `browser` 由 Core 在有桌面客户端且设置 `browser.agentEnabled` 为真时开启。调用经 `policy/evaluate` 裁决后发 AHP `browser/run`；Core 的 `tool_io::browser` 用 `claim_browser` 消费本次授权，经 `BrowserClient` trait 交给客户端。主进程的实现监听路由 `core/browser` 的 `runRequested`，执行后经 NAPI `answerBrowserRun` 应答；主进程启动时 `attachBrowserClient` 登记，没有登记时 Core 立即答 `browserUnavailable`。L2 由 testkit 实现同一 trait。
2. **工具级裁决。** `Browser` 在阶梯第 7 步按"不改工作区的主机工具"处理：default、acceptEdits、auto、bypass 放行，plan 放行但只允许本地地址；deny/ask 规则 `Browser` 照常生效。运行登记在会话 `running`（`browser:<callId>`），中断、断连、会话关闭即取消；同一会话串行。
3. **脚本宿主。** 每次调用一个新的沙箱渲染进程（预热一个备用），调用结束即销毁：独立内存分区、`piarc-browser-host:` 协议源（不是 `app://piarc`）、CSP `default-src 'none'; script-src piarc-browser-host: 'unsafe-eval'; connect-src 'none'`、分区内全部请求取消、WebRTC 不可用、权限全拒。只有 preload 暴露的绑定可用；主进程按发送者 webContents id 与运行状态鉴权，运行结束后的调用被拒；超时（默认 120 s，上限 600 s）即 `forcefullyCrashRenderer`。SDK 与模型脚本在同一宿主内，SDK 的跨调用状态（ledger）经绑定存在主进程、按 Space 保存。
4. **主进程承担浏览器平台集成。** CDP（每标签 `webContents.debugger`，OOPIF 用 flatten 子会话）、给 SDK 的浏览器级 CDP 代理（Target 子集，改编自 VS Code 的 MIT 实现）、快照（CDP 无障碍树与 DOMSnapshot）、视图、控制权状态在主进程；策略、审批、审计、文件 I/O、代理在 Core。
5. **请求闸门。** 智能体 Space 的标签按 `webContentsId` 归属，分区 `webRequest` 对每个请求判定：loopback 与本地开发域名走端口策略（只放行本会话任务、终端、开发服务器进程树正在监听的端口、启动配置声明的端口、用户本人打开过的端口；PiArc 端口拒绝；其余询问）；工作区文件协议放行；已获准主机放行；主框架未获准则挂起并发站点卡，子资源未获准则拦截并计入结果。无法归属的请求在任一智能体标签打开该站点期间按智能体策略判定。主进程用 Core 推来的授权快照本地判定，未命中才问 Core。
6. **站点卡。** 复用沙箱网络卡（ADR-0056）的挂起与应答机制，但绑定正在运行的调用、运行结束即撤卡。选项：允许一次（本次运行）、本会话允许（默认）、总是允许（写用户设置的 `Browser(domain:…)`）、拒绝。auto 模式送审（T46），bypass 放行，plan 拒绝非本地；导入过登录的站点与私网地址在任何模式都问且没有"总是允许"。同一运行的待批主机合并为一张卡。
7. **CDP 允许名单。** 只放行 Page、Runtime、DOM、DOMSnapshot、Accessibility、CSS（只读）、Input、Emulation、Overlay、Log、Network（不含 cookie 与请求头改写）、Performance 与本 Space 内的 Target 子集；导航类方法进请求闸门；`DOM.setFileInputFiles`、下载目录、新文档脚本只经绑定；运行结束与接管时清除注入脚本、拦截与模拟设置。被拒方法写审计。
8. **文件。** 上传：每个路径经 Core 读权限裁决，Core 用句柄复制到 `<会话 tmp>/browser/uploads/` 后交给 Chromium。下载：智能体标签写入 `<会话 tmp>/browser/downloads/`，`saveAs` 与 `screenshot({ path })` 经 Core 写入并走写权限。脚本内没有 Node API。
9. **页面内容是数据。** 工具结果整体放在带 nonce 的 `<browser-output>` 边界里；工具说明写明边界内的文字不是指令；截图作为 image 块（数量与尺寸有上限）。审计 `kind: "browser"` 记脚本哈希、主机、被拦主机、被拒方法、卡片结果，不记脚本与页面内容。
10. **控制权。** Space 三态（`agent`、`agentDelegatedToUser`、`user`）在主进程；运行中视图上方覆盖透明遮罩视图，用户须显式接管；接管后智能体调用得到 `EGO_TASK_SPACE_USER_IN_CONTROL`；"停止"只取消本次调用。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 照搬 ego：Node 进程执行脚本 | 与上游一致，脚本可用 Node API | 等于不经 Bash 分析的任意代码执行；每次审批则体验差；Windows 无沙箱 | 用户否决 |
| QuickJS（wasm）解释器 | 自带中断与内存上限，没有 Web API | 新依赖；SDK 要跑在解释器里，性能与调试代价大 | 记为备选，宿主隔离出现缺口时启用 |
| Node `vm` / `utilityProcess` | 简单 | `vm` 不是安全边界；`utilityProcess` 无沙箱 | 否决 |
| 离散工具（playwright-mcp 风格） | 审批粒度细 | 一步一次往返，失去代码模式的效率，与用户选择不符 | 否决 |
| 只审批顶层导航 | 简单 | `evaluate(fetch)`、img、beacon、WebSocket 可外传 | 否决 |
| 新增 `browserSite` 审批类型 | 语义专一 | 与网络卡重复一套挂起、超时、撤卡逻辑 | 否决，复用网络卡 |

## 后果

- 正面：脚本只能做浏览器操作；审批落在"去哪个主机、哪个本机端口、读写哪个文件"这些用户能判断的点上；Core 仍是唯一的策略与审计来源。
- 负面与代价：主进程新增浏览器平台模块与 CDP 代码；宿主每次调用一个渲染进程（备用预热抵消延迟）；在已获准站点上，智能体能读取页面可见的数据（localStorage、DOM 中的令牌），站点卡文案写明。
- 需要配套做的事：`piarc-protocol` 新方法与路由、`gen:protocol`、`build:core`、L1 样本、L2 假客户端、`tests/l3-allowlist.yaml`、提示词原创性检查、THR-16 对策与测试。

## 重新评估的触发条件

- 宿主隔离出现可利用的缺口（渲染进程沙箱逃逸、绑定越权），切换到 QuickJS 方案；
- 用户频繁为同一类本地端口审批，评估扩大端口自动放行的来源；
- Electron 的 `webContents.debugger` 失去与 DevTools 共存或 flatten 子会话能力。
