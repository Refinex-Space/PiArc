# R1 评审发现（M0 → M1）

R1 用四个只读子代理按维度并行审查 M0 的代码（2026-11-16）。每个子代理只拿到维度、范围与必读材料，没有拿到主代理的判断。下面逐条记录子代理的原始发现（位置、失败场景、子代理给的严重程度与依据），以及主代理的核实结论与处理。

- 核实结论："确认"表示能复现，或能指出具体代码路径；"部分确认"表示代码路径成立但后果比原描述小；"不同意"写明理由。
- 处理：修复的写提交（先写失败测试再修，每个修复单独提交）；范围大的写登记事项编号（`docs/plan/PLAN.md`"登记事项"）或技术债；涉及架构变更的写 ADR。
- 编号：E = Electron 安全与 IPC，C = Core/NAPI 并发与错误边界，A = Agent Host/AHP 健壮性，Q = 工程质量与 CLAUDE.md 一致性。

汇总表在文末。

## E：Electron 安全与 IPC

审查范围：`apps/desktop/`、Forge 配置、fuses、CSP、打包。子代理报告"没有发现安全边界被突破的问题"，另列出已核对无问题的部分：fuses、webPreferences、IPC 入口的来源校验、自定义协议、权限处理器、外链白名单、开发放宽、测试钩子、preload 暴露面、Markdown 路径。

### R1-E1 围栏代码块的语言名为 `constructor` 等原型成员时渲染进程崩溃

- 子代理评级：高。依据：架构 10.1 把模型输出与仓库内容当作不可信输入。
- 位置：`apps/desktop/src/renderer/transcript/highlight/languages.ts:57-65`、`highlight-client.ts:38-79`、`CodeBlock.tsx:51-76`、`renderer/main.tsx:30`
- 失败场景：围栏的 info string 为 `constructor`（或 `toString`、`valueOf` 等）时，`ALIASES[lang]` 经原型链返回函数，`supports()` 为真，`worker.postMessage` 携带函数抛 `DataCloneError`，异常进入 `useEffect`；渲染进程没有错误边界，整个 React root 卸载。`__proto__` 则让该块永远停在 pending。
- 核实：**确认**。新单元测试 `languages.test.ts` 在修复前 18 个用例中 4 个失败（`supports('__proto__')` 等为真）。
- 处理：已修复（8a6e3e5）：只查自有键（`Object.hasOwn`）。渲染进程没有错误边界一事登记 I50（T19）。

### R1-E2 终端只在 `webContents` 销毁时关闭，页面重载或渲染进程崩溃后 PTY 成为孤儿

- 子代理评级：中。依据：`terminal-ipc.ts:41` 的注释声称窗口崩溃时关闭终端。
- 位置：`apps/desktop/src/main/core/terminal-ipc.ts:41-63`
- 失败场景：页面创建终端后重载（默认菜单有 Reload）或渲染进程崩溃，`webContents` 不销毁，旧终端的 shell 继续运行，新页面不知道旧 id，无人能操作或关闭，直到窗口关闭。
- 核实：**确认**。新用例"closes the terminals of a page that reloads or crashes"修复前失败。
- 处理：已修复（d50b9a2）：主框架开始新文档的导航（`did-start-navigation`，非同文档）与 `render-process-gone` 时关闭该窗口的终端；哈希路由不受影响。S10 报告与 `apps/desktop/CLAUDE.md` 同步。

### R1-E3 终端是页面可调用的命令执行通道，不经 Core 的权限裁决

- 子代理评级：中。依据：架构 10.3"即使渲染进程被攻破，有副作用的操作（执行命令、写文件…）仍要经 Core 的权限裁决"。
- 位置：`apps/desktop/src/main/core/terminal-ipc.ts:107-131`、`apps/desktop/src/preload/preload.ts:148-173`
- 失败场景：渲染进程被注入后，脚本调用 `createTerminal` 再 `terminalInput(id, "curl … | sh\n")`，以用户身份执行任意命令；主进程只校验来源、参数形状与归属。
- 核实：**确认**（代码路径：`terminalCreate` 只校验来源、尺寸与归属，`terminalInput` 原样写入 PTY）。终端面板本身是用户的交互式 shell（ADR-0017），输入不经 Core 权限裁决是设计内的，但第 10.3 节没有把它列为例外；发布构建现在也带着原型终端的七个函数（I30），渲染进程被注入时就能执行命令。
- 处理：登记 I51（T34）：决定终端输入的防线（例如要求近期真实用户输入）与每窗口终端数上限，并在 10.3 写明；若以文档例外接受，属于放松安全基线，写 ADR 提议。T34 之前由 T45 与 I30 一起评估发布构建是否去掉终端函数。

### R1-E4 事件路由订阅没有归属校验，任一窗口可订阅他窗终端的 `term/<id>` 事件

- 子代理评级：低（多窗口上线后为中）。依据：S10 第 3 节第 20 行"只允许操作本窗口创建的终端"。
- 位置：`apps/desktop/src/main/core/event-ipc.ts:17-24`、`router.ts:54-67`
- 失败场景：窗口 B 调 `subscribeEvents('term/' + idOfA, cb)`，收到 A 终端的标题、响铃与退出事件。
- 核实：**确认**。新用例 `event-ipc.test.ts`“refuses routes the window may not observe”修复前失败。
- 处理：已修复（15857e6）：订阅经授权函数，`term/<id>` 只有所属窗口能订阅（`TerminalOwners.mayObserve`）；会话路由的授权由 T14、T35 接入同一钩子。

### R1-E5 外链确认框没有节流，也不要求用户手势

- 子代理评级：低。依据：架构 10.1"审批疲劳与误点"。
- 位置：`apps/desktop/src/main/ipc/handlers.ts:12-14`、`external-link-port.ts:9-24`
- 失败场景：页面脚本循环调用 `openExternal`，模态确认框堆叠，诱导误点；带 userinfo 的地址（`https://github.com@evil.example/`）没有警示。
- 核实：**确认**。新用例（带用户信息的地址、同一窗口的第二个确认框）修复前失败。
- 处理：已修复（c7173d8）：拒绝带用户信息的 URL；`LinkConfirmations` 让每个窗口同一时刻最多一个确认框。

### R1-E6 单个窗口可无限创建终端，拉帧请求没有在途上限

- 子代理评级：低（加固）。
- 位置：`apps/desktop/src/main/core/terminal-ipc.ts:107-156`
- 失败场景：页面循环 `createTerminal` 耗尽 PTY 与进程；`requestTerminalFrame` 的在途数只靠渲染端自律。
- 核实：**确认**（代码路径）。渲染端每帧最多一个在途拉取是约定，主进程没有上限。
- 处理：登记 I51（T34，与 E3 一起定每窗口终端数与在途拉取上限）。

### R1-E7 进程边界的 ESLint 规则只拦直接写法；导航守卫没有 `will-frame-navigate`

- 子代理评级：低。依据：S10 第 13、17 项。
- 位置：`eslint.config.mjs:216-223`、`apps/desktop/src/main/security/navigation.ts:34-55`
- 失败场景：`webContents.ipc.handle`、`ipcMain` 别名不在规则内，可绕过 `createIpcRegistrar`（当前代码没有这种用法）；子框架导航走 `will-frame-navigate`，当前由 CSP 的 `frame-ancestors`/`default-src` 挡住。
- 核实：**部分确认**。规则确实只拦 `ipcMain.<method>`，当前代码没有绕过的写法；子框架导航当前被 CSP 挡住，没有可用的绕过。
- 处理：登记 I52（T45）：规则加上 `webContents.ipc` 与别名形式，`guardWebContents` 加 `will-frame-navigate`；S10 第 13、17 项的措辞随之改准。

## C：Core/NAPI 并发与错误边界

审查范围：`piarc-core`、`piarc-napi`、`piarc-term`、`piarc-secrets`、`piarc-sandbox`、`piarc-exec`、`piarc-fs`。子代理另列出已核对无问题的部分：`unsafe` 只在允许的模块且 `SAFETY` 注释与不变量相符、NAPI 导出全部经 `boundary::call` 与 `catch_unwind`、关闭顺序与重复关闭、非测试代码无 `unwrap`/`expect`、凭据不进 `Debug` 与错误信息。

### R1-C1 `read_blob` 的临时文件名只含 pid，并发读同一内容会写出截断的 blob 并被复用

- 子代理评级：中。依据：`crates/piarc-fs/CLAUDE.md`"先写临时名再 rename"。
- 位置：`crates/piarc-fs/src/content.rs:71-81`
- 失败场景：同一会话并发两个 blob 模式的 `fs/read` 读同一张图片，两个阻塞线程写同一个 `<sha256>.partial-<pid>`，后到者截断先到者；先完成者 rename，另一个 rename 失败返回 `ENOENT`；blob 存在即复用，不再校验。另：`read_to_end` 无大小上限。
- 核实：**确认**。新用例 `concurrent_blob_reads_of_the_same_content_all_succeed_with_an_intact_blob` 修复前失败（blob 为 0 字节）。
- 处理：已修复（8f158c8）：每次写入用带进程内序号的临时名。`read_to_end` 没有大小上限登记 I53（T16）。

### R1-C2 事件合并器在 `SinkClosed` 路径上 `in_flight -= 1` 下溢

- 子代理评级：低。
- 位置：`crates/piarc-core/src/events.rs:135-143`、`:355`、`:414-427`；`crates/piarc-napi/src/sink.rs:61-80`
- 失败场景：`deliver` 返回 `SinkClosed` 时回调闭包连同 `DeliveryDone` 被释放，`Drop` 发出 `Done`，而 `in_flight` 没有加 1；发布构建回绕为 `usize::MAX`，关闭时等满 5 s 并打印错误数字，开发构建 panic。
- 核实：**确认**。新用例 `a_closed_sink_drops_events_and_shutdown_does_not_wait_for_a_delivery` 修复前失败：debug 构建中合并器 panic（`attempt to subtract with overflow`），随后投递了 `core/errors`。
- 处理：已修复（00f805e）：失败的投递也计入在途，被丢弃的 `DeliveryDone` 发出的信号与之抵消。

### R1-C3 沙箱代理的 accept 循环在 EMFILE 时空转，没有连接数上限与超时

- 子代理评级：中。依据：架构 6.10，代理是沙箱命令唯一的网络出口。
- 位置：`crates/piarc-sandbox/src/proxy/mod.rs:115-143`、`:245-258`
- 失败场景：沙箱内命令开大量连接，耗尽与 Core 同进程的文件描述符；accept 返回 EMFILE 后立即 `continue`，空转占满一个 worker；没有读头超时、空闲超时、上游 connect 超时与并发上限。
- 核实：**确认**（`accept_loop` 中 `Err(_) => continue`，每连接一个任务，无上限与超时）。代理只用于沙箱会话，T39 之前生产路径不启用沙箱。
- 处理：登记 I54（T39）：accept 失败退避、每会话连接上限、读头/空闲/上游 connect 超时。

### R1-C4 `createTerminal` 在 JS 主线程同步创建 PTY 与进程

- 子代理评级：中。依据：架构 7.2"单次 NAPI 同步调用的耗时预算为 1 ms"。
- 位置：`crates/piarc-napi/src/terminal.rs:85-99` → `piarc-core/src/runtime.rs:300-303` → `piarc-core/src/terminal.rs:146` → `piarc-term/src/session.rs:200-284`
- 失败场景：主进程在同步导出里 `openpty`、fork/exec（Windows 为 ConPTY 与 `CreateProcess`）、创建三个线程，期间事件循环被卡住。
- 核实：**确认**（`CoreRuntime::create_terminal` 是同步导出，内部 `openpty` 与 spawn）。耗时没有测量；终端目前只在原型页使用。
- 处理：登记 I55（T33）：改为 Promise（`JsDeferred` + 阻塞线程池）并实测两平台耗时。

### R1-C5 终端的 IO、写入、等待线程与若干 `spawn_blocking` 没有 panic 防护

- 子代理评级：中（未确认）。依据：`piarc-napi`"panic 与错误都变成带 `code` 与 `data.kind` 的 `Error`"。
- 位置：`crates/piarc-term/src/session.rs:248-277`、`:505-553`；`crates/piarc-core/src/terminal.rs:121-132`、`:179-181`
- 失败场景：IO 线程 panic 后不发 `Exited`，会话留在注册表、程序继续运行而屏幕不再更新；`spawn_blocking` 闭包 panic 时 `JsDeferred` 被丢弃，Promise 以没有 `data.kind` 的泛化消息拒绝。
- 核实：**确认**代码路径（线程闭包与 `spawn_blocking` 回调都没有 `catch_unwind`）；没有已知的 panic 触发点。
- 处理：登记 I55（T33：终端线程 panic 时发 `Exited` 或错误事件；T14：`spawn_blocking` 回调 panic 时以带 `kind` 的错误结算 Promise）。

### R1-C6 终端 IO 线程把任何读错误都当作输出结束

- 子代理评级：低（未确认）。
- 位置：`crates/piarc-term/src/session.rs:514-517`
- 失败场景：`read` 返回 `Interrupted` 时也结束读取，程序仍在运行而输出永久停止。
- 核实：**部分确认**：`Ok(0) | Err(_) => break` 确实把 `Interrupted` 当作结束；Electron 主进程的信号处理器是否带 `SA_RESTART` 没有验证，无法构造失败用例。
- 处理：登记 I55（T33：对 `Interrupted` 重试）。

### R1-C7 终端查询应答经无界通道排队，并与按键共用写线程

- 子代理评级：低（未确认）。
- 位置：`crates/piarc-term/src/session.rs:245`、`:540-568`；`vt/effects.rs:86`
- 失败场景：程序大量发查询序列而不读 stdin 时，应答队列无上限增长，排在后面的 Ctrl+C 与 resize 等待阻塞的写入。
- 核实：**部分确认**：应答通道无界、与按键共用写线程属实；PTY 写入是否会长时间阻塞取决于平台，没有复现。
- 处理：登记 I55（T33：应答队列设上限，按键与 resize 走优先通道）。

### R1-C8 `exec_run` 在 `sandbox.launch()` 失败时遗留 `running` 条目（同 R1-A11）

- 子代理评级：低。
- 位置：`crates/piarc-core/src/tool_io.rs:338-343`
- 失败场景：沙箱策略无法表达时提前返回，`requestId` 一直被判为运行中，`exec/kill` 对它返回 `killed: true` 而实际没有进程。
- 核实：**确认**（代码路径：`running.insert` 在 `sandbox.launch()?` 之前）。沙箱策略在打开会话时已解析，现有代码里 `launch()` 无法被构造失败，写不出失败用例。
- 处理：登记 I56（T17 重写执行路径时用 drop guard 清理，并补可注入失败的测试）。

### R1-C9 凭据锁的解锁与带 `lockId` 的写入不校验调用方连接

- 子代理评级：低（加固）。
- 位置：`crates/piarc-core/src/secrets.rs:200-205`、`:282-296`、`:358-376`
- 失败场景：任一连接知道别的连接的 `lockId`（64 位随机数，只回给持有者）就能解锁或写入。
- 核实：**确认**（`release` 与带 `lockId` 的写入不比较持有者连接）。`lockId` 为 64 位随机数、只回给持有者，需要先泄漏。
- 处理：登记 I57（T21，与 I23 一起）。

### R1-C10 沙箱代理的地址黑名单不含私网，明文转发保留客户端的 `Host`

- 子代理评级：低（设计范围内）。
- 位置：`crates/piarc-sandbox/src/proxy/address.rs:23-39`、`proxy/mod.rs:330-334`
- 失败场景：白名单通配域名的子域名解析到 RFC1918、CGNAT、ULA 时代理照连；明文 HTTP 的 `Host` 与 URI 不一致时原样转发。
- 核实：**确认**，属于文档范围内的设计（只拦回环、未指定、链路本地与云元数据）；威胁模型没有写明私网不在保护范围。
- 处理：登记 I54（T39：默认拒绝私网、CGNAT、ULA，转发时把 `Host` 改为 URI 的 authority，或在 6.10 写明范围）。

### R1-C11 `Tree::kill` 在 leader 被回收后仍用旧 pgid（未确认）

- 子代理评级：低（未确认）。
- 位置：`crates/piarc-exec/src/tree.rs:85-100`
- 失败场景：leader 已回收且组内无成员时，pgid 理论上可被复用，`kill`/`Drop` 向无关进程组发 `SIGKILL`。
- 核实：**不同意按缺陷处理**：只有 leader 已回收、组内无成员、pid 又恰好被复用为新进程组的 leader 时才会误杀，窗口极小；macOS 的进程组终止本来就由 T17 重做（I36）。
- 处理：登记 I56（T17 在进程管理正式版中记录 leader 是否已回收）。

## A：Agent Host / AHP 健壮性

审查范围：`agent-host/`、`piarc-host`、`piarc-protocol`、`packages/protocol`，以及 `piarc-core` 中的 `agent_host`、`tool_io`、`secrets`。子代理报告没有确认的凭据泄露或跨会话串扰；另列出已核对无问题的部分：两份帧编解码器一致（唯一差异是 `1e999` 这类数值）、版本协商与重复握手、出站队列有上界、桥接请求有超时、按 `sessionId` 分区、凭据日志只写键名。

### R1-A1 重启恢复时一次崩溃或超时把所有待恢复会话永久移出跟踪表

- 子代理评级：中。依据：ADR-0009 第 5 条、S9 第 3 节。
- 位置：`crates/piarc-host/src/supervisor.rs:491-493`、`:603-637`
- 失败场景：重启后逐个 `session/resume`，中途 Agent Host 再崩溃或某次 resume 超时，`Err` 分支一律 `sessions.remove`，剩余会话因连接已断同样失败被移除；下次重启一个也不恢复。
- 核实：**确认**。新用例 `a_crash_during_restore_keeps_the_sessions_for_the_next_restart` 修复前失败（连接中断后两个会话都报 `SessionRestoreFailed` 并被移除）。
- 处理：已修复（f99a76f）：连接中途结束时停止本轮、保留会话；只有 Agent Host 拒绝（`Remote`、`MalformedResult`）才移除；超时与写队列满保留并报告。

### R1-A2 真实连接断开时 `Peer::closed()` 不触发，安静的命令在 Agent Host 崩溃后继续运行

- 子代理评级：中。依据：`crates/piarc-core/CLAUDE.md`"连接断开（`Peer::closed`）终止命令"。
- 位置：`crates/piarc-host/src/connection.rs:327-346`、`:447-467`；`supervisor.rs:641-659`；`inbound.rs:70-72`；`piarc-core/src/tool_io.rs:360-368`；`secrets.rs:326-384`
- 失败场景：`exec/run` 执行不输出的长命令后 Agent Host 崩溃；写队列的发送端仍被运行中的任务与订阅表持有，`write_frames` 不退出，`Peer::closed()` 不完成，命令不被取消；它由 Core 启动，不在 Agent Host 的进程树里。
- 核实：**确认**。新用例 `a_crash_ends_the_peers_of_requests_still_running` 修复前失败（崩溃后 5 s 内 `Peer::closed()` 不完成）。
- 处理：已修复（dc1f2ad）：连接结束时触发 `close_stdin`，写任务丢弃队列，`Peer::closed()` 随之完成，委托的命令被取消。

### R1-A3 `session/create`、`session/resume` 超时后两端状态不一致

- 子代理评级：中（MCP 冷启动耗时未实测）。依据：ADR-0009 第 5 条。
- 位置：`crates/piarc-host/src/supervisor.rs:167-192`、`:626-633`；`agent-host/src/runtime/session-registry.ts:216-245`
- 失败场景：`npx` 型 MCP server 冷启动让创建超过 30 s，Core 返回 `Timeout` 不登记，Agent Host 随后完成创建，留下 Core 不知道的会话；重试再建一个。
- 核实：**确认**代码路径（`create_session`、`session/resume` 超时后 Core 不登记、不补偿）；MCP 冷启动是否会超过 30 s 没有实测。
- 处理：登记 I58（T14：由 Core 生成会话 id，或超时后按 id 补偿 `session/close`）。

### R1-A4 恢复循环串行且不响应关闭与 Kill

- 子代理评级：中。
- 位置：`crates/piarc-host/src/supervisor.rs:491-496`
- 失败场景：重启后的 Agent Host 在 resume 时挂住，N 个会话 × 30 s 内 `commands` 与 `exited` 都不被轮询，`HostSupervisor::shutdown()` 一直等，应用退出被卡住。
- 核实：**确认**（`restore_sessions` 在 `select!` 之前串行执行）。R1-A1 的修复让连接中断时立即停止本轮，剩下的场景是恢复时挂住。
- 处理：登记 I58（T14：恢复放进可被关闭与 Kill 打断的分支）。

### R1-A5 锁租约在 OAuth 刷新途中到期，轮换后的 refresh token 只留在内存

- 子代理评级：中。依据：ADR-0021"轮换后的 token 不丢"。
- 位置：`agent-host/src/runtime/credentials.ts:217-250`、`:352-392`；`crates/piarc-core/src/secrets.rs:47-49`、`:276-355`
- 失败场景：刷新加保险箱打开（含钥匙串弹窗）超过 30 s 租约，`secrets/set` 得到 `secretLockLost`，新 token 只在内存；服务商已轮换时磁盘上的旧 token 作废。
- 核实：**确认**代码路径（租约固定 30 s 不续期，`modify` 在持锁期间做网络刷新）。
- 处理：登记 I57（T21：租约可续期，或 `secretLockLost` 时以临时锁写回轮换后的 token）。

### R1-A6 Agent Host 出站帧没有大小上限，与 Core 的 8 MiB 帧限不一致

- 子代理评级：低。
- 位置：`agent-host/src/protocol/outbound.ts:46-47`、`:103-174`；`crates/piarc-host/src/config.rs:107`
- 失败场景：停读期间同一条目的增量合并成超过 8 MiB 的单帧，被 Core 当作 `frameTooLarge` 丢弃，`seq` 出现缺口。
- 核实：**确认**代码路径（合并只受 64 MiB 积压上限约束）。需要长时间停读加单项大文本才会触发，文本增量的丢失会被 `item/completed` 的全文修复。
- 处理：登记 I58（T14：合并时设单帧上限）。

### R1-A7 握手被拒或未完成的连接，读取任务仍把请求交给入站处理者

- 子代理评级：低（加固）。
- 位置：`crates/piarc-host/src/connection.rs:235-249`、`:422-470`
- 失败场景：收到 `host/hello` 后检查失效；被拒的进程在退出等待窗口内发 `fs/*`、`exec/*`、`secrets/getAll` 仍被执行；握手前的通知早于 `Connected` 投递。
- 核实：**确认**（`hello.take()` 之后不再检查握手是否被接受）。Agent Host 是 Core 自己启动的进程，属加固项。
- 处理：登记 I58（T14）。

### R1-A8 心跳任务遇到非超时错误就永久退出

- 子代理评级：低。
- 位置：`crates/piarc-host/src/supervisor.rs:590`
- 失败场景：`host/ping` 返回 `Remote` 或 `MalformedResult` 时该连接的挂死检测被静默关闭。
- 核实：**确认**。新用例 `an_error_answer_to_a_heartbeat_does_not_stop_hang_detection` 修复前失败（错误应答之后再挂住，20 s 内没有 `Exited`）。
- 处理：已修复（396c116）：只在连接已结束时退出心跳任务；错误应答算作存活。

### R1-A9 `FrameError` 的投递不置 `delivering`

- 子代理评级：低。
- 位置：`crates/piarc-host/src/connection.rs:484-538`
- 失败场景：读者停在 `FrameError` 的投递上时，心跳不知道它在被背压，可能误判挂死。
- 核实：**确认**。新用例 `a_consumer_held_back_by_frame_errors_does_not_get_the_host_killed` 修复前失败。
- 处理：已修复（c800fa1）：投递 `FrameError` 时同样置 `delivering`。

### R1-A10 过期的 `Kill` 命令可能杀掉刚重启的健康进程

- 子代理评级：低。
- 位置：`crates/piarc-host/src/supervisor.rs:452-458`、`:499-503`、`:596`
- 失败场景：心跳刚发 `Kill(Hung)`，进程同时自行退出；下一个连接的 `serve` 消费这条命令，杀掉新进程并消耗重启名额。
- 核实：**确认**代码路径（命令通道中的 `Kill` 不带 epoch）。
- 处理：登记 I58（T14：命令带 epoch，丢弃过期的 `Kill`）。

### R1-A11 `exec_run` 在沙箱启动失败时泄漏 `running` 条目

- 与 R1-C8 相同，见该条。
- 核实：同 R1-C8。
- 处理：登记 I56（T17）。

### R1-A12 工具发往 Core 的字符串没有 `toWellFormed`，`encodeFrame` 抛错时留下挂起项

- 子代理评级：低。依据：`agent-host/CLAUDE.md` 不变量"其他字符串用 `toWellFormed()`"。
- 位置：`agent-host/src/tools/`、`agent-host/src/runtime/core-bridge.ts:63-85`、`protocol/outbound.ts:75-78`
- 失败场景：模型给的路径或命令含孤立代理项，`encodeFrame` 在 Promise 执行器里抛 `TypeError`，`#pending` 条目与 abort 监听已登记，`exec/run` 无超时时永不清理。
- 核实：**确认**。新用例（`core-io.test.ts` 的孤立代理项路径、`core-bridge.test.ts` 的发送失败）修复前失败。
- 处理：已修复（1ac1470）：`CoreIo` 发出的每个请求经 `wellFormedJson`（与投影共用 `protocol/well-formed.ts`），`CoreBridge` 发送失败时结算并移除挂起项。

### R1-A13 `ToolIo` 的会话表只按 `sessionId` 索引，不绑定连接

- 子代理评级：低（加固）。
- 位置：`crates/piarc-core/src/tool_io.rs:236-247`、`:393-406`
- 失败场景：多个 Agent Host 共用一个 `ToolIo`，知道别的会话 id 就能以该会话的范围做 `fs/*`、`exec/*`。
- 核实：**确认**（`ToolIo` 的会话表只按 `sessionId` 索引）。需要 Agent Host 内的恶意扩展才能利用。
- 处理：登记 I58（T14：`open_session` 记录所属连接，分派时校验）。

### R1-A14 入站请求处理任务数没有上界

- 子代理评级：低（加固）。
- 位置：`crates/piarc-host/src/connection.rs:447-467`
- 失败场景：每个入站请求一个 `tokio::spawn`，没有并发上限，连接结束时不统一取消。
- 核实：**确认**（每个入站请求一个 `tokio::spawn`）。正常模型调用不会触及。
- 处理：登记 I58（T14：并发上限，连接结束时统一取消）。

### R1-A15 子代理列为"未确认"的三项

- （a）`exec/kill` 与 `exec/run` 分在两个任务处理，kill 先到时得到 `killed: false`，命令随后照常启动（`agent-host/src/tools/bash.ts:49-55`、`tool_io.rs:313-340`）；（b）同 id 的并发 `session/resume` 会创建两个运行时（`session-registry.ts:90-100`、`:239`）；（c）`errorMessage` 可能带出服务商错误原文（`session-registry.ts:265-266`）。
- 核实：（a）**确认**代码路径，窗口极小；（b）**确认**代码路径，Core 侧恢复是串行的，只有外部并发调用会触发；（c）**未确认**：pi-ai 的错误文本是否可能回显密钥没有核实。
- 处理：（a）登记 I56（T17）；（b）登记 I58（T14）；（c）登记 I57（T21 核实 pi-ai 的错误文本，T45 的日志脱敏覆盖 `errorMessage`）。

## Q：工程质量与 CLAUDE.md 一致性

审查范围：整个仓库。子代理另列出已核对无问题的部分：没有 `TODO(Txx)` 等标记；没有 `#[ignore]`、`.only`、`it.skip`、注释掉的断言（`agent-host-kill.e2e.ts` 的按平台跳过与 `asset-path.test.ts` 的 `it.runIf` 符合规范）；npm 与 Cargo 依赖全部精确锁定；`deny.toml` 只有一条带理由的例外；依赖方向除 Q10 外与规则一致；没有本机路径与凭据样式字符串；根与 `apps/desktop` 的 CLAUDE.md 中的命令、参数、脚本都存在；行数均在上限内（根 96、`apps/desktop` 116、`agent-host` 80，其余更短）。

### R1-Q1 默认 `cargo test`（含 verify）访问真实 npm 与 crates.io

- 子代理评级：中。依据：`testing.md` 4.1“L0–L2 不访问网络”。
- 位置：`crates/piarc-core/tests/sandbox_commands.rs:4-43`；根 `CLAUDE.md` 易错点
- 失败场景或后果：沙箱内的 `npm install`、`cargo build` 经代理连 registry，离线或 registry 抖动时 verify 失败；规范没有登记这个例外。
- 核实：**确认**。根 `CLAUDE.md` 已写明这两个用例连真实 registry，但 `testing.md` 没有登记例外。
- 处理：已处理（4a830a5）：`testing.md` 4.1 登记这项例外；用例验证的就是沙箱代理放行真实 registry，改成本地假 registry 会失去意义，保留。

### R1-Q2 真实凭据库测试在不可用时打印 NOT RUN 后以通过收尾

- 子代理评级：中。依据：`testing.md` 4.1、架构 12.6。
- 位置：`crates/piarc-secrets/tests/system_store.rs:23-45`；`.github/workflows/ci.yml:63-64`
- 失败场景或后果：CI 没设 `PIARC_REQUIRE_KEYCHAIN`，凭据库不可用时测试为绿、没有断言；同文件 31 行 `let _ = tx.send(f())` 没有注释。
- 核实：**确认**。CI 没有设 `PIARC_REQUIRE_KEYCHAIN`；实机结论来自 T08（macOS 登录钥匙串）与 W0（Windows 凭据管理器）设了该变量的运行。
- 处理：已处理（4a830a5）：`testing.md` 4.1 写明 NOT RUN 不算通过；CI 是否设置与 `let _ = tx.send(f())` 的注释登记 I60（T44）。

### R1-Q3 e2e 与单元测试用固定时长等待异步结果

- 子代理评级：中。依据：`testing.md` 5“测试不靠 sleep 等待异步结果”。
- 位置：`apps/desktop/e2e/transcript-scroll.e2e.ts:50-133`、`terminal.e2e.ts:34,60`、`terminal.ts:94,157`、`core.ts:76`；`agent-host/src/runtime/credentials.test.ts:311-566`
- 失败场景或后果：结果依赖机器与刷新率；I32 的偶发失败就在 `transcript-scroll.e2e.ts` 的固定 300–400 ms 等待处。`terminal.e2e.ts:63` 的 1500 ms 是有意的负向观察窗口。
- 核实：**确认**。`transcript-scroll.e2e.ts` 的固定等待与 I32 的偶发失败位置一致；`terminal.e2e.ts:63` 的负向观察窗口可以保留。
- 处理：登记 I59（T19 改 transcript 用例并处理 I32，T34 改终端用例，T21 把 `credentials.test.ts` 改为等条件）。

### R1-Q4 基准脚本就地重写了 L4 夹具的应用定位逻辑

- 子代理评级：中。依据：`coding-standards.md` 第 4 节复用表、3.6。
- 位置：`scripts/bench/s2-event-channel.mjs:79-110`、`s1-transcript.mjs:196-225`，对照 `apps/desktop/e2e/app.ts:30-78`
- 失败场景或后果：两份副本不检查 `.vite/renderer` 是否存在、不处理其他平台、用 `JSON.parse` 而不是 `readJsonFile`。
- 核实：**确认**（两份副本缺 `.vite/renderer` 检查，也没用 `readJsonFile`）。
- 处理：登记 I60（T44 把基准改为复用 `e2e/app.ts` 的定位函数）。

### R1-Q5 `piarc-exec` 与 `piarc-ports` 没有按 2.3 定义带 `kind()`、`retryable()` 的 `Error`

- 子代理评级：中。依据：`coding-standards.md` 2.3。
- 位置：`crates/piarc-exec/src/command.rs:125` 等返回 `io::Result`；`crates/piarc-ports/src/secret.rs:17`
- 失败场景或后果：边界上无法把执行错误映射为结构化错误。
- 核实：**确认**。`piarc-ports` 只放 trait，`SecretStoreError` 由实现方映射，可以豁免；`piarc-exec` 没有 `error.rs` 属实。
- 处理：登记 I61（T17 为 `piarc-exec` 定义 `Error`，并把 `piarc-ports` 的豁免写进 `coding-standards.md` 2.3）。

### R1-Q6 复用代码的来源登记不全

- 子代理评级：中。依据：`coding-standards.md` 第 4 节“第三方许可证来源登记”、`design/brand/README.md:33`。
- 位置：`agent-host/src/tools/paths.ts:4-6`、`grep.ts:6`、`crates/piarc-fs/src/image.rs:3-4`、`agent-host/src/runtime/credentials.test.ts:6-7`（移植自 Pi，MIT）；`design/brand/mark.svg` 与 `mark.LICENSE`
- 失败场景或后果：这些都不在 `third-party/sources.json`，T50 据它生成的第三方声明会漏掉它们。
- 核实：**确认**。
- 处理：已修复（e7a62af）：`third-party/sources.json` 增加 `pi-source-ports`（许可证 `third-party/licenses/pi-1.5.2.LICENSE`）与 `thesvg-pi-mark`。

### R1-Q7 `fetch-binaries.mjs` 的完整性校验没有单元测试

- 子代理评级：中。依据：`coding-standards.md` 3.6、`testing.md` 5。
- 位置：`scripts/dev/fetch-binaries.mjs:75-134`；同类 `scripts/bench/s1-transcript.mjs` 的导出纯函数、`install-tools.mjs`、`pack-windows.mjs`、`gen-protocol.mjs`
- 失败场景或后果：大小不符、哈希不符、缓存损坏后删除三条分支没有测试。
- 核实：**确认**。
- 处理：登记 I60（T50 给 `fetch-binaries.mjs` 的三条校验分支补单元测试；其余脚本的测试由 T44 评估）。

### R1-Q8 CLAUDE.md 违反规范第 3 节“不写”清单

- 子代理评级：中。依据：`docs/engineering/claude-md.md` 第 3 节。
- 位置：`apps/desktop/CLAUDE.md` 结构一节（116 行，上限 120）、`agent-host/CLAUDE.md` 入口与结构；`crates/piarc-exec/CLAUDE.md`“T17 要叠加的”、`piarc-fs/CLAUDE.md`“T16 与之后要叠加的”、`piarc-core/CLAUDE.md` 首段
- 失败场景或后果：逐文件说明与任务进度最容易过时，`apps/desktop/CLAUDE.md` 下一次改动就会超限。
- 核实：**确认**。
- 处理：已处理（CLAUDE.md 收口提交，见文末汇总）：删去逐文件说明与任务进度，改为指向代码与架构的链接。

### R1-Q9 测试夹具的 package.json 描述指向已知会失败的启动方式

- 子代理评级：低。
- 位置：`packages/testkit/src/mcp-probe-server/package.json:5`
- 失败场景或后果：描述写 `npx -y <this directory>`，而这种方式在 Agent Host 的 Seatbelt 下失败（I40），L4 实际用 `npm pack` 加 `--package`。
- 核实：**确认**。
- 处理：已修复（e7a62af）。

### R1-Q10 `deps-rules.json` 有一条实际不存在的依赖边

- 子代理评级：低。依据：`coding-standards.md` 2.1。
- 位置：`crates/deps-rules.json:69-73`（`piarc-fs → piarc-checkpoint`）；`crates/piarc-fs/Cargo.toml` 没有该依赖
- 失败场景或后果：检查脚本不发现未使用的例外，预留的例外让以后加这条依赖时不再触发评审。
- 核实：**不同意**：这条例外是 T01 按架构第 7.1、6.9 节预先登记的（写入前存快照），理由写明了方向与原因，要等 T16、T28 才有实际依赖。检查脚本不报告未使用的例外，不影响依赖方向的正确性。
- 处理：不改。T28 接入 `piarc-checkpoint` 时确认它仍然需要。

### R1-Q11 `piarc-testkit/src/lib.rs` 含实现

- 子代理评级：低。依据：`coding-standards.md` 2.1。
- 位置：`crates/piarc-testkit/src/lib.rs:126-140`（`parse_request`）
- 失败场景或后果：`lib.rs` 只应做模块声明与 re-export。
- 核实：**确认**。
- 处理：技术债（T15 接手 `piarc-testkit` 时把 `parse_request` 移到模块中）。

### R1-Q12 ESLint 的 preload 规则弱于 `coding-standards.md` 的表述

- 子代理评级：低。
- 位置：`eslint.config.mjs:226-256`；`coding-standards.md` 3.3
- 失败场景或后果：规范写“preload 只能导入 `electron`”，规则只禁 Node 内置模块；渲染进程规则也拦不住 Node 专用的 npm 原生模块。
- 核实：**确认**：`coding-standards.md` 的措辞比规则强。
- 处理：已修复（e7a62af）：改为“preload 不导入 Node 内置模块”。渲染进程拦不住 Node 专用 npm 包一事登记 I52（T45）。

### R1-Q13 小范围文档漂移

- 子代理评级：低。
- 位置：`coding-standards.md:175`（install-tools 只写 cargo-deny）、`:188`（`spawn_supervised` 是私有函数）；根 `Cargo.toml:59`（不是字母序）、`:103`（注释写 `allow`，规范与代码用 `expect`）；架构 3.4（缺 `packages/testkit`、`third-party/` 等，列出不存在的 `design/tokens/`、`tests/scenarios/`）；`.gitignore:56`（不存在的 `apps/desktop/build/`）；`.nvmrc` 24.22.2 与内置 node 24.22.3；`docs/reviews/README.md` 的 R1 状态
- 失败场景或后果：文档与代码不一致。
- 核实：**确认**（`.nvmrc` 24.22.2 与内置 24.22.3 同属 24 LTS，第 13.1 节的“同一 LTS”成立，这一项不算漂移）。
- 处理：已修复：`coding-standards.md`、`Cargo.toml`、`.gitignore`（e7a62af）；架构 3.4 在架构同步提交中更新；`docs/reviews/README.md` 的 R1 状态在收尾时更新。

### R1-Q14 一处没有注释的 `let _ =`

- 子代理评级：低。依据：`coding-standards.md` 2.3。
- 位置：`crates/piarc-core/src/secrets.rs:388`
- 失败场景或后果：丢弃 `changes.send` 的结果没有说明理由。
- 核实：**确认**。
- 处理：已修复（e7a62af）。

### R1-Q15 生成文件超过 1,000 行没有写明豁免

- 子代理评级：低。依据：`coding-standards.md` 2.7。
- 位置：`crates/piarc-ghostty-sys/src/bindings.rs`（3,712 行，bindgen 生成）
- 失败场景或后果：规范要求超限在评审中写明豁免。
- 核实：**确认**，生成文件。
- 处理：豁免：`bindings.rs` 由 `scripts/dev/gen-ghostty-bindings.mjs` 生成并由 `--check` 比对，不手改，不受 1,000 行上限约束（本条即评审中的豁免记录）。

## 汇总

共 48 条（E 7、C 11、A 15、Q 15）。其中先写失败测试再修复的缺陷 12 条，各自单独提交；文档与配置的修正 7 条；其余登记到 `docs/plan/PLAN.md` 的 I50–I61（负责任务写在登记事项中）、技术债或写明不同意的理由。没有需要 ADR 的发现：R1-E3 若以文档例外接受，由 T34 写 ADR 提议。

| 编号 | 发现 | 子代理评级 | 核实 | 处理 |
|---|---|---|---|---|
| R1-E1 | 围栏代码块的语言名为 `constructor` 等原型成员时渲染进程崩溃 | 高 | 确认 | 修复 8a6e3e5；登记 I50 |
| R1-E2 | 终端只在 `webContents` 销毁时关闭，页面重载或渲染进程崩溃后 PTY 成为孤儿 | 中 | 确认 | 修复 d50b9a2 |
| R1-E3 | 终端是页面可调用的命令执行通道，不经 Core 的权限裁决 | 中 | 确认 | 登记 I30、I51 |
| R1-E4 | 事件路由订阅没有归属校验，任一窗口可订阅他窗终端的 `term/<id>` 事件 | 低 | 确认 | 修复 15857e6 |
| R1-E5 | 外链确认框没有节流，也不要求用户手势 | 低 | 确认 | 修复 c7173d8 |
| R1-E6 | 单个窗口可无限创建终端，拉帧请求没有在途上限 | 低 | 确认 | 登记 I51 |
| R1-E7 | 进程边界的 ESLint 规则只拦直接写法；导航守卫没有 `will-frame-navigate` | 低 | 部分确认 | 登记 I52 |
| R1-C1 | `read_blob` 的临时文件名只含 pid，并发读同一内容会写出截断的 blob 并被复用 | 中 | 确认 | 修复 8f158c8；登记 I53 |
| R1-C2 | 事件合并器在 `SinkClosed` 路径上 `in_flight -= 1` 下溢 | 低 | 确认 | 修复 00f805e |
| R1-C3 | 沙箱代理的 accept 循环在 EMFILE 时空转，没有连接数上限与超时 | 中 | 确认 | 登记 I54 |
| R1-C4 | `createTerminal` 在 JS 主线程同步创建 PTY 与进程 | 中 | 确认 | 登记 I55 |
| R1-C5 | 终端的 IO、写入、等待线程与若干 `spawn_blocking` 没有 panic 防护 | 中 | 确认 | 登记 I55 |
| R1-C6 | 终端 IO 线程把任何读错误都当作输出结束 | 低 | 部分确认 | 登记 I55 |
| R1-C7 | 终端查询应答经无界通道排队，并与按键共用写线程 | 低 | 部分确认 | 登记 I55 |
| R1-C8 | `exec_run` 在 `sandbox.launch()` 失败时遗留 `running` 条目（同 R1-A11） | 低 | 确认 | 登记 I56 |
| R1-C9 | 凭据锁的解锁与带 `lockId` 的写入不校验调用方连接 | 低 | 确认 | 登记 I23、I57 |
| R1-C10 | 沙箱代理的地址黑名单不含私网，明文转发保留客户端的 `Host` | 低 | 确认 | 登记 I54 |
| R1-C11 | `Tree::kill` 在 leader 被回收后仍用旧 pgid（未确认） | 低 | 不同意 | 登记 I56 |
| R1-A1 | 重启恢复时一次崩溃或超时把所有待恢复会话永久移出跟踪表 | 中 | 确认 | 修复 f99a76f |
| R1-A2 | 真实连接断开时 `Peer::closed()` 不触发，安静的命令在 Agent Host 崩溃后继续运行 | 中 | 确认 | 修复 dc1f2ad |
| R1-A3 | `session/create`、`session/resume` 超时后两端状态不一致 | 中 | 确认 | 登记 I58 |
| R1-A4 | 恢复循环串行且不响应关闭与 Kill | 中 | 确认 | 登记 I58 |
| R1-A5 | 锁租约在 OAuth 刷新途中到期，轮换后的 refresh token 只留在内存 | 中 | 确认 | 登记 I57 |
| R1-A6 | Agent Host 出站帧没有大小上限，与 Core 的 8 MiB 帧限不一致 | 低 | 确认 | 登记 I58 |
| R1-A7 | 握手被拒或未完成的连接，读取任务仍把请求交给入站处理者 | 低 | 确认 | 登记 I58 |
| R1-A8 | 心跳任务遇到非超时错误就永久退出 | 低 | 确认 | 修复 396c116 |
| R1-A9 | `FrameError` 的投递不置 `delivering` | 低 | 确认 | 修复 c800fa1 |
| R1-A10 | 过期的 `Kill` 命令可能杀掉刚重启的健康进程 | 低 | 确认 | 登记 I58 |
| R1-A11 | `exec_run` 在沙箱启动失败时泄漏 `running` 条目 | 低 | 确认（同 R1-C8） | 登记 I56 |
| R1-A12 | 工具发往 Core 的字符串没有 `toWellFormed`，`encodeFrame` 抛错时留下挂起项 | 低 | 确认 | 修复 1ac1470 |
| R1-A13 | `ToolIo` 的会话表只按 `sessionId` 索引，不绑定连接 | 低 | 确认 | 登记 I58 |
| R1-A14 | 入站请求处理任务数没有上界 | 低 | 确认 | 登记 I58 |
| R1-A15 | 子代理列为"未确认"的三项 | 未确认 | 确认 2 项、未确认 1 项 | 登记 I56、I57、I58 |
| R1-Q1 | 默认 `cargo test`（含 verify）访问真实 npm 与 crates.io | 中 | 确认 | 修复 4a830a5 |
| R1-Q2 | 真实凭据库测试在不可用时打印 NOT RUN 后以通过收尾 | 中 | 确认 | 修复 4a830a5；登记 I60 |
| R1-Q3 | e2e 与单元测试用固定时长等待异步结果 | 中 | 确认 | 登记 I32、I59 |
| R1-Q4 | 基准脚本就地重写了 L4 夹具的应用定位逻辑 | 中 | 确认 | 登记 I60 |
| R1-Q5 | `piarc-exec` 与 `piarc-ports` 没有按 2.3 定义带 `kind()`、`retryable()` 的 `Error` | 中 | 确认 | 登记 I61 |
| R1-Q6 | 复用代码的来源登记不全 | 中 | 确认 | 修复 e7a62af |
| R1-Q7 | `fetch-binaries.mjs` 的完整性校验没有单元测试 | 中 | 确认 | 登记 I60 |
| R1-Q8 | CLAUDE.md 违反规范第 3 节“不写”清单 | 中 | 确认 | 已处理 |
| R1-Q9 | 测试夹具的 package.json 描述指向已知会失败的启动方式 | 低 | 确认 | 修复 e7a62af |
| R1-Q10 | `deps-rules.json` 有一条实际不存在的依赖边 | 低 | 不同意 | 不改（见条目） |
| R1-Q11 | `piarc-testkit/src/lib.rs` 含实现 | 低 | 确认 | 技术债 |
| R1-Q12 | ESLint 的 preload 规则弱于 `coding-standards.md` 的表述 | 低 | 确认 | 修复 e7a62af；登记 I52 |
| R1-Q13 | 小范围文档漂移 | 低 | 确认 | 修复 e7a62af |
| R1-Q14 | 一处没有注释的 `let _ =` | 低 | 确认 | 修复 e7a62af |
| R1-Q15 | 生成文件超过 1,000 行没有写明豁免 | 低 | 确认 | 豁免（见条目） |
