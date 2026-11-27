# piarc-core

Core 的运行时门面：tokio 多线程运行时、事件队列与合并器、有序关闭、任务监督；`agent_host` 模块把 `piarc-host` 的监管器与生产 I/O（`piarc-exec` 的进程启动器、`SystemClock`）装配起来，是 Agent Host 测试的无头入口（T06）；`tool_io` 应答 Agent Host 委托的 `fs/*`、`exec/*`（T07），沙箱命令经 `piarc-sandbox` 包装（T11，T39 起按裁决与当时的设置，见 `src/tool_io/AGENTS.md`）；`secrets` 把凭据保险箱提供给所有 Agent Host（`secrets/*`，T08），`identity` 是应用标识的唯一定义；`terminal` 是终端的注册表（T10），T33 起会话的终端作为后台任务运行；`dirs`、`storage`、`trust`、`workspace_settings` 是数据目录、数据库、项目信任与工作区设置（T13）；`sessions` 是工作区与会话的编排（T14），`clock` 是空闲计时用的时钟；`client_settings` 读写用户级 `settings.json` 中的客户端偏好（T18）。运行时门面的状态与会话方法分别在 `runtime/state.rs` 与 `runtime/sessions.rs`。会话删除的原生确认先从 Core 读取目标标题和工作区，并显示同一会话 ID。不负责 JavaScript 绑定（`piarc-napi`）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-core` | 单元测试 + `tests/event_channel.rs`（回调频率、无丢失与顺序、背压、有序关闭、任务 panic、未关闭直接丢弃）+ `tests/tool_io.rs`（越界需要询问、流式输出、取消、会话隔离）+ `tests/file_invariants.rs`（T16：先读后改、外部修改、重复读取、上传与 diff、受保护路径、spill、编码）+ `tests/secrets.rs`（推送、保险箱错误、锁与租约、并发读改写） |
| `cargo test -p piarc-core --test exec_commands -- --nocapture` | 命令（T17）：cd 跨命令保留与越界重置、超时与截断的上限、落盘与预览、两个管道各 50 MB、语义退出码、环境剔除、`exec/shells`；Windows 上另有 PowerShell 与 Git Bash 的中文输出 |
| `cargo test -p piarc-core --test sandbox` | 沙箱会话（macOS）：写入范围、受保护路径、`denyRead`、绕过代理、流式与退出码、`exec/kill` 后进程组为空（T17 起 shell 以 `SIGTERM` 结束）、关闭会话停止代理 |
| `cargo test -p piarc-core --test sandbox_commands -- --nocapture` | 沙箱内 git、python、cargo build、npm install（后两项连真实 registry，连不上就失败并说明） |
| `cargo test -p piarc-core --test agent_host_profile` | Agent Host 的定稿 Seatbelt 配置在真实 `sandbox-exec` 上：工作区、`pi/`、`agent-host/`、会话临时目录写得进，主目录、用户设置、数据库、保险箱、用户级 skills、受保护路径写不进（T39） |
| `cargo test -p piarc-core --test release -- --nocapture` | 发布清单校验（T12-A08）：有效、篡改内容、篡改哈希与大小、未列出、换密钥、无内置公钥，打印结构化错误 |
| `cargo test -p piarc-core --test agent_host_probe` | 探针在 Core 运行时上启动进程（运行时开着 I/O）、Agent Host 未握手就退出时报告错误（Unix） |
| `cargo test -p piarc-core --test state` | 数据目录布局、信任按主 checkout（真实 git 夹具）、重启后保留与撤销、`trust/get` 故障注入、信任视图与新增项、设置文件变化事件（T13） |
| `cargo test -p piarc-testkit --test sessions` | 会话层端到端（真实 Agent Host + mock）：排队、steer 与 follow-up、中断、工具批次、重试、缺口补齐、空闲回收、快照 revision、fork 与关闭、重启恢复（T14） |
| `cargo run --release -p piarc-testkit --example t14-warmup` | 打开工作区到 Agent Host 就绪的 10 次测量（T14-A09） |
| `cargo test -p piarc-core --test background_tasks` | 后台命令（T32）：`background` 立即作答并写输出文件、KillShell 结束整棵进程树（含忽略 SIGTERM 的孙进程）并保留输出、其他会话停不了、Monitor 以任务运行；单测 `--lib tasks::`（通知、Monitor 节奏与手动时钟、权限范围、子 agent 状态、分段读取） |
| `cargo test -p piarc-core --test terminal` | 终端：`term/<id>` 事件、经回调取帧、错误类别、关闭终端与关闭 Core 都结束整棵进程树（自成进程组的作业、忽略 HUP/TERM 的进程，Unix；Windows 版在 `tests/terminal_windows.rs`） |
| `cargo test -p piarc-core --lib terminal::` | 会话终端（T33）：会话目录与命令环境、没有 locale 时补 UTF-8、智能体的终端任务（退出码、命令结束通知、屏幕文件与 formatter 一致）、未共享的终端模型看不到、退出时保存与关闭时丢弃 snapshot |
| `cargo test -p piarc-core --lib provider_accounts` 与 `cargo test -p piarc-testkit --test sessions accounts::` | 同一服务商多个账号（ADR-0083）：再次登录、切换、移除、登录失败放回、同名账号去重，`account/` 只给 Core；端到端另有连接测试与停用后工作区看不到模型 |
| `cargo test -p piarc-core --lib network` 与 `cargo test -p piarc-testkit --test sessions network::` | 代理（ADR-0082）：地址校验、设置读取与生效值、环境变量；真实 Agent Host 在系统代理变化后空闲重启并带上代理变量、本机 mock 直连、相同代理不重启、回合进行中不重启 |
| `cargo test -p piarc-core --lib mcp::` | MCP 配置（T36）：未信任项目的 server 等待信任、各来源与同名取舍、用户启停与 `disabledMcpjsonServers`、子 agent 的内联 server、配置诊断不展开变量；`--lib host_probe` 含探针的 `mcp/servers` |
| `cargo test -p piarc-core --lib tool_io::policy::tests::dev_servers` 与 `--lib ports` | 开发服务器与端口发现（ADR-0092）：未信任不启动、真实 node 服务就绪后停止结束进程树、失败带最后 20 行、就绪超时、`autoPort`、智能体按指纹询问一次、`autoVerify` 每回合一次、后台命令的监听端口进 `ports` 事件（要 PATH 上有 node） |
| `cargo clippy -p piarc-core --all-targets -- -D warnings` | lint |

## 运行时与关闭顺序

- `CoreRuntime::start(config, sink)` 建运行时并启动合并器；`shutdown(cb)` 在专用线程上执行：拒绝新请求（`ShuttingDown`）→ 取消根 `CancellationToken` 并等演示事件源结束 → 关闭队列、合并器排空并投递最后一批、等客户端处理完（最多 5 s）→ 合并器丢弃 sink（NAPI 下即释放 `ThreadsafeFunction`）→ `shutdown_timeout` 停运行时 → 回调。
- 回调之后 sink 不会再被调用。`Drop` 未关闭的运行时只做取消与 `shutdown_background`，没有最后一批。
- 长任务从根 token 取子 token；新任务经 `spawn_supervised` 启动：panic 打到 stderr，并作为结构化错误事件发到 `core/errors`。合并器自身 panic 时由监督者直接向 sink 投递一个 `seq` 为 0 的带外批次。

## 事件合并器（`events.rs` 模块文档为准）

- 批次 = 路由键 + 每路由从 1 起连续的批次序号 + 载荷（该路由事件的 UTF-8 JSON 数组）。主进程只看路由键。
- 刷出时机：不早于首个待发事件到达，且距上次刷出至少一个间隔（默认 16 ms，1–1000 ms 可配）。无待发事件时不跑定时器。
- 满时策略，任何情况都不丢事件：最多 1 个在途投递（sink 丢弃 `DeliveryDone` 才算完成），期间继续在待发批次里累积；待发超过 64 MiB 停止读队列，队列（65,536 个事件）满后异步生产者等待，同步调用（`echo`）返回可重试的 `QueueFull`（kind `busy`）。只有 sink 报告 `SinkClosed`（JS 环境已销毁）时才丢弃并计入 `lost`。

## 凭据（`secrets`）

- 一个 Core 只建一个 `SecretsService`，所有 Agent Host 的 `InboundHandler` 共用它（Core 是保险箱唯一写入方）。保险箱在第一次请求时打开，失败只让这次请求失败，下一次重新打开（用户授权钥匙串后不用重启）。保险箱操作放在阻塞线程池。
- 订阅：调用过 `secrets/getAll` 的连接收到每次写入的 `secrets/changed`；每个连接一个推送任务，关闭的连接在下一次推送时移除。
- 锁：`secrets/lock` 一组键一起锁，任一被占就等待；未带 `lockId` 的写入临时锁该键；`unlock`、租约（`DEFAULT_LOCK_LEASE` 30 s）、持有者连接结束都会释放；失效的 `lockId` 写入返回 `secretLockLost`。
- 参数错误不带 serde 的原文（它会引用出错的值，可能是凭据）。不要在日志里写值。
- `websearch/` 键只给 Core 自己（T38，`CORE_ONLY_PREFIXES`）：Agent Host 的 `secrets/get`、`set`、`delete`、`lock` 点名它们一律 `permissionDenied`，`secrets/getAll` 不列出，写入不推送 `secrets/changed`。Core 自己读写用 `value_of`、`store_value`（后者以一个内部 peer 取同样的写锁）。
- 测试与 `piarc-testkit` 经本模块的再导出使用 `MemorySecretStore`、`test_master_key_name`（testkit 不能直接依赖 `piarc-secrets`）。
- `identity::APP_IDENTIFIER` 是 D2 决定的应用标识 `cn.piarc.desktop`（bundle id 与 AppUserModelID 也取它）。发布后不能再改：改了保险箱找不到主密钥，系统授权也要重给。

## 打包的 Agent Host 与 S6 探针（T12）

- `agent_host::start` 一律用 `ProcessTreeSpawner`；`start_bundled` 从打包产物启动（布局、环境变量与 Seatbelt 包装见 `crates/piarc-host/AGENTS.md`）。T39 起 `start_for` 的开发启动（`AgentHostLaunch::Custom`）在 macOS 上同样套定稿配置并设 `agent_host_env`；`agent_host::start` 直接启动（Agent Host 协议测试）不套。Core 的 tokio 运行时开着 I/O（`enable_io`），在它上面监管子进程、跑代理都依赖这一点。
- 打包探针先由 Core 生成会话 ID、在 `ToolIo` 登记工作区，再以同一 ID 发 `session/create`。Agent Host 在打开会话时就会查询 `memory/status`。
- `host_probe`、`keychain_probe` 只给测试用：开发构建的 `piarc-napi` 导出 `agentHostProbe`、`keychainProbe`，发布构建不导出。钥匙串探针的条目固定为 `piarc-test.s6-keychain.credential-vault`（构建 A 写、构建 B 读要同一个名字），不碰 `identity` 的正式条目。

## 发布清单（`release`，ADR-0024）

- `verify_manifest` 先验签后解析，只接受预哈希签名；`verify_file` 先比大小再流式算 SHA-256。所有失败是 `ReleaseError`，类别 `releaseIntegrity`（读不了文件为 `ioError`），`details.reason` 区分原因，调用方一律拒绝更新。
- `BUILTIN_RELEASE_KEYS` 在 T50 之前为空：没有信任的公钥时任何清单都被拒绝。不要把 `scripts/release/test-keys/` 的测试公钥放进去。
- 测试样本由 Node 的 `scripts/release/release-manifest.mjs` 签名（`tests/fixtures/release/`，`.gitattributes` 设为 `-text` 保持字节不变），换测试密钥后按该目录 README 重写。

## 终端（`terminal`，T10、T33，ADR-0017、ADR-0050）

- `Terminals`（`terminal/mod.rs`）持有全部终端：每个是 `piarc_term::Session`、它的进程树（`piarc_exec::TerminalTree`，启动后立即收集）和可选的会话绑定（`terminal/bound.rs`）。事件以 JSON 发到 `term/<id>`：IO 线程上用 `EventSender::blocking_send`，不能在运行时线程调用。
- 启动、取帧、读屏、搜索、粘贴、回显探针都在阻塞线程池上，结果经回调交给 NAPI；`create_terminal` 只同步校验尺寸（1–1000）与绝对 cwd。`write`/`key`/`mouse`/`focus` 只入队（写队列满时 `busy`）。
- 会话的终端（`open`）：用户的（`ToolIo::open_user_terminal`，登录 shell）与智能体的（`exec/run` 带 `terminal`，bash 或 Git Bash，键入审批过的命令）都是 `TaskKind::Terminal` 的后台任务，在会话的 shell 目录、以 T17 的命令环境（没有 locale 时补 UTF-8；智能体的 bash 终端在 macOS 上另设 `BASH_SILENCE_DEPRECATION_WARNING=1`，免得系统 bash 的 zsh 提示进入模型读的屏幕）启动，沙箱会话套同一个沙箱包装。屏幕文件 `tasks/<任务 id>.log` 每 500 ms 有变化时重写，命令结束通知与读取之前也重写；只有智能体自己的终端和用户共享的终端写屏幕文件、对模型可见（`tasks/terminal.rs` 的 `TerminalViews`）。智能体的命令结束时先挂通知，再把退出码写到仍在运行的任务上。
- 关闭：`close` 对会话终端经任务停止（`StopBy::User`），watch 循环再 `close_now`（应用退出时保留 snapshot，其余丢弃）；`close_now` 挂断并结束进程树（宽限 2 s 后 `SIGKILL`）。有序关闭第 1 步 `Terminals::shutdown` 停止全部会话终端、关闭其余终端，并等每棵树的挂断、宽限与 kill 都结束才返回（之前只等 shell 退出，忽略挂断的进程会活过 Core）。
- T34（ADR-0051）：视口滚动、清除选区、默认颜色只入写队列；选区文本与 OSC 8 链接在阻塞线程池上；取帧可带 `park`（`terminal_frame_parking`），停拉的 viewer 由 `term/<id>` 的 `output` 事件唤醒。`cargo test -p piarc-core --test terminal` 的 `selection_scrolling_links_and_parking_go_through_core` 覆盖这些入口。
- 测试夹具不要在 `for` 头部的表达式里拿 `entries` 的锁：守卫活到循环结束，循环体里再取同一把锁就自锁（T33 实测卡死）。

## 数据目录与状态（T13）

- `CoreConfig.dirs`（NAPI 的 `dataDir` + `cacheDir`，主进程算好传入）为 `None` 时没有数据库、设置、信任与日志文件，只给事件通道的测试与基准用；`storage()`、`trust()` 返回 `NoDataDirectory`。
- 启动时：建第 9.1 节的目录 → `piarc_telemetry::install(<data>/logs)`（进程级，只装一次；关闭时 `detach`）→ 打开并迁移 `core.sqlite`（同步，只在启动做一次）→ 后台增量同步 `pi/sessions/` 的索引 → 启动会话层（`Hub`、快照任务）。每个回合结束后会话 actor 增量同步索引并写入该会话的 Core 列（`set_session_state`）。
- 有序关闭的最后关闭数据库（`Storage::close`）：NAPI 的 `CoreRuntime` 对象要等 GC 才释放，Windows 不能删除打开着的文件（I66）。关闭后 `Storage::with`/`run` 返回 `ShuttingDown`。
- `Storage` 是 `Store` 加互斥锁，经阻塞线程池使用；不要在异步任务里拿着锁等待。
- 信任（`trust`）：`TrustService::trust_get` 应答 `trust/get`，任何失败（包括清单不完整、快照损坏、目录解析不了、数据库错、任务 panic）都答 `trusted: false`，只有参数格式错时回 `invalidParams`；查询一律经 `piarc_config::project_trust`。肯定决定须带用户看到的清单版本；遇到版本变化向客户端返回最新视图，保持原决定。同一项目的 linked worktree 需要反向登记（ADR-0034）。成功的 `decide`、`revoke` 广播 `TrustChange`；`agent_host::restart_on_trust_change` 订阅它，对同一主 checkout 调 `HostSupervisor::restart`（不计入崩溃退避，会话自动恢复）。T14 的工作区 actor 负责为每个工作区启动这个任务。
- 设置（`workspace_settings`）：`CoreRuntime::open_settings(workspace)` 加载四层并用 `piarc_fs::watch` 监听各层文件所在目录（`.piarc/` 不存在时监听工作区本身），去抖 150 ms 后重载。目录注册和补注册独立于通知投递，注册到新目录后补读；每 2 秒只核对设置层文件的存在、大小与修改时间，变化时也重载。重载后向 `core/settings` 发 `{ workspace, changed, issues }`。信任变化同样触发重新合并。

## 后台任务（`tasks`，T32，ADR-0049）

- `TaskManager`（`tasks/mod.rs`）一个 Core 一份，由运行时建好经 `ToolIo::with_tasks` 交给工具 I/O，`start` 时把数据库里遗留的 `running` 改为 `interrupted`、载入最近任务并开始发 `core/tasks` 快照；`set_outlet` 接上会话层（`sessions::HubOutlet`：送通知、停子 agent，持弱引用避免环）。`ToolIo::new` 自带一个无数据库的管理器（测试）。
- 状态机：`running` → `completed`（语义成功；Monitor 到时也是，`meaning` 写明）/ `failed` / `killed`（KillShell、面板、会话归档删除、Monitor 随会话关闭）/ `interrupted`（应用退出、承载子 agent 的连接结束）。停止原因 `StopBy` 决定状态与是否通知；结束后不再变。
- 输出文件 `<数据目录>/sessions/<主会话 id>/tasks/<任务 id>.log`（`tasks::task_file`），子 agent 的任务也在主会话目录下。归档清理 `tasks/`，删除会话一并删 `background_tasks` 行。
- 通知：`Notice` 挂在管理器里直到 `delivered`（会话 actor 看到 `reminder` 条目，或 `session/remind` 答 `delivered`）；`sessions/session/notices.rs` 负责发送（任务结束、会话打开或恢复、每个 prompt/steer/follow-up 之前）。Monitor 的批次与限速在 `tasks/feed.rs`、节奏在 `tasks/monitor.rs`；全部限值在 `tasks/limits.rs` 的 `TaskLimits`（`CoreConfig.tasks`），计时用 `TasksConfig.clock`（前台超时、Monitor 超时与唤醒都用它，测试与 L2 注入 `ManualClock`）。
- 有序关闭：`Hub::shutdown` 先 `TaskManager::shutdown`（并发停止全部、等结束、把最终行写进数据库），再关工作区与数据库。

## 从 Chrome 导入登录（`browser::import`，ADR-0090）

- `ChromeImports`（Hub 的 `Ctx.chrome`，`CoreConfig.chrome`：Chrome 的目录与密钥来源，缺省为 `CoreConfig.home` 下的平台位置与系统钥匙串或 DPAPI；`createForTests` 一律用固定测试密钥，`PIARC_TEST_CHROME_ROOT` 指向夹具目录）：`profiles`、`sites` 只读名称与条数；`import` 在主进程原生确认之后由 NAPI `chromeImport` 调用：读一次密钥、解密、把每个值登记给 `piarc_telemetry::remember_secret`、先写 `browser_imports` 记录再答复（主进程随后写分区，所以有导入 cookie 的站点一定有记录）、写一行 `kind: "browserImport"` 审计（只有站点与条数），答复是 `Zeroizing` 的 JSON 文本，NAPI 交给 V8 后清零。`forget` 删记录并审计。记录按 `workspace_key`（规范化后的路径）存。
- 站点卡（`tool_io/policy/site.rs`）不信客户端的 `sensitive`：主机是导入站点或其子域名时 Core 自己标为敏感（读不到记录也按敏感），所以规则与 bypass 不放行、没有"总是允许"。
- 测试：`cargo test -p piarc-core --lib browser::import` 与 `--lib tool_io::policy::tests::browser_import`。

## 开发服务器与端口发现（ADR-0092，设计增补 `browser.md` B4）

- 启动配置只经 `piarc_config::launch` 读（项目取 `SessionIo.project()`，`${workspaceFolder}` 与 `cwd` 取文件根）；服务是 `TaskKind::DevServer` 的后台任务（`tool_io/dev_servers.rs`：沙箱外、会话的命令环境、`start_task`），状态与审批指纹在 `DevServers`（ToolIo 一份），每次变化在 `core/browser` 发 `servers`。项目不受信任时拒绝启动（`ToolIo::project_trusted`，同一份权限设置）；智能体的启动经 `tool_io/policy/dev_server.rs` 的卡片（绑定正在运行的 `Browser` 调用）。
- 进程树：`start_task` 与转后台的命令经 `CommandRunner::run_reporting` 记下 pid，`TaskManager::set_tree` 登记（`tasks/trees.rs`）；终端由 `terminal/bound.rs` 登记 `TerminalTree::listen_tree`。`ports.rs` 在桌面客户端登记后每 `SCAN_INTERVAL`（1.5 s）经 `piarc_exec::listeners` 扫描全部运行中任务的树，按主会话发变化了的 `ports`（含启动配置声明的端口）。
- `autoVerify`：`fs/write` 成功后 `dev_file_written` 判断是否是运行中服务目录下的前端文件，经 `TaskManager::remind_once_per_turn` 留一条 `browserVerify` 通知（`turn_started` 清除每回合标记），文案在 Agent Host 的 `harness/prompts/browser-notices.ts`。

## MCP（`mcp`，T36，ADR-0053）

- `McpConfigSource`（Core 一份，工作区入站处理器共用）应答 `mcp/servers`：用 `TrustService::permission_settings` 加载设置（与权限裁决同一份），收集 local、project、user 三个作用域的来源交给 `piarc_config::mcp::merge`，`${VAR}` 用 `ToolIo::expansion_environment`（登录 shell 环境去掉 PiArc 内部变量）展开，`env` 是命令环境（ADR-0035）。启停选择存 `core.sqlite` 的 `mcp_servers`（`set_enabled`）。子 agent 的内联 server 由 `tool_io/subagents.rs` 在 `agents/list` 中经 `inline_servers` 检查与展开。
- 添加（ADR-0101）：`McpConfigSource::add_server`（`mcp/add.rs`）只接受 stdio 的 `command`/`args`/`env` 或 HTTP 的 `url`，拒绝任何来源已用的名字，写用户级 `settings.json` 或 `.piarc/settings.local.json`；后者经 `TrustService::confirm_items` 并入已有的信任决定（主进程已原生确认）。NAPI `mcpAddServer` 答复写入后重读的 `McpStatus`。
- 状态与操作经 `Hub::{mcp_status, mcp_reconnect, mcp_set_enabled, mcp_login}`（`sessions/mcp.rs`，NAPI `mcpStatus` 等）：工作区有运行中的 Agent Host 时转给它，没有时 `status_from_config` 按配置回答（可运行的为 `idle`）。Agent Host 的 `mcp/statusChanged` 以 `HostEvent::HostNotification` 到达工作区 actor，加上 `workspace` 发到路由 `core/mcp`（`MCP_ROUTE`）。MCP 登录沿用 T29 的登录记录与 `core/login`，provider 为 `mcp:<server>`。
- `policy/evaluate` 的 `requiresUserInteraction` 经 `tool_io::policy` 的 `requires_user_interaction` 成为必须询问的一步并清空可保存的规则；`ToolSearch` 在只读宿主工具里。配置诊断报告的 `mcp` 由 `diagnostics()` 给出（不展开变量）。打包产物的探针（`host_probe`）只用 `<数据目录>/settings.json` 的 `mcpServers` 回答（`settings_file_servers`）。

## 扩展包（`plugins`，T40，ADR-0058）

- `PluginManager`（`plugins/mod.rs`，Hub 的 `sessions/plugins.rs` 每次操作新建）：安装（本地目录原地用；npm 经 `plugins/fetch.rs` 的内置 npm、`--ignore-scripts`；git 经 `piarc_git::package` 克隆并锁定提交）、更新、开关（写用户 `settings.json` 或 `.piarc/settings.json` 的 `plugins.<id>`，开启时把原生确认列出的项记为已确认，项目作用域的新清单项经 `TrustService::confirm_items` 并入信任快照）、确认、卸载，每次写 `audit_events`（`kind: "plugin"`）。记录在 `piarc-store` 的 `packages`；Hub 在每次改动后向运行中的 Agent Host 发 `resources/reload`。node 取 `AgentHostLaunch::node()`。
- `TrustService::permission_settings` 在有 `plugins` 声明时读记录并 `set_packages`（`trust.rs` 的 `attach_packages`），hooks（`config_with` 的层 `plugin:<id>`）、MCP（`mcp.rs` 的 `plugin_sources`，作用域 `plugin`）、skills（`tool_io/skills.rs`）、子 agent（`tool_io/subagents.rs` 的 `definitions_in`）与 AHP `plugins/extensions`（`plugins::extensions`）都用这一份。信任视图把 `.piarc/` 开启的包的可执行项列为 `plugin:<id>` 项（`package_items`），信任时记为已确认（`confirm_listed_packages`），它们不计入新增项。
- 测试：`cargo test -p piarc-core --lib plugins::`（npm 的进程与参数、postinstall 未运行；作用域、开关、卸载与审计；未信任项目与信任后加载；git 更新后新项不运行直到确认）。

## 用量与成本（`usage`，T41，ADR-0059）

- `usage.rs` 是计价的唯一实现：单价换成每 token 的皮美元（`Pricing`），没有分档按合计算、有分档逐请求选档（`calculateCost` 的规则，1 小时缓存写入按输入价两倍），`u128` 精确求和后才转美元；`PriceBook` 先用户的 `modelPrices` 后目录价，都没有为 `Unknown`（成本 `None`，报告标 `partial`）。`report` 沿 `subagent_parent` 把子会话计入主会话并单独列出，辅助调用按用途列出。共享向量 `tests/usage/cost-vectors.json` 由 pi-ai 的 `calculateCost` 算出，`usage_tests.rs` 与 `agent-host/src/providers/usage-costs.test.ts` 都按它核对。
- `sessions/usage.rs`：`Hub::usage_report`、`session_usage`、`set_model_price`（NAPI `usageReport`、`sessionUsage`、`setModelPrice`）。生成报告前先向运行中的 Agent Host 取一次 `models/list` 记下目录价（`record_prices`，`workspace_models` 与服务商设置也记），再增量同步会话索引。
- 测试：`cargo test -p piarc-core --lib usage::`。

## 配置诊断的其他来源（`config_diagnostics/sources.rs`，T41，ADR-0059）

- `.mcp.json`（`crate::mcp::merged_config`）、memory 文件与导入（`tool_io::memory_documents`，从正文的 `[Memory source: …]` 等标记取导入）、rules、子 agent 定义、skills、命令、输出风格（`piarc_config::{agents, skills, rules}`）、包（`PluginManager::list`）与企业占位，各是一份 `FileReport`。`Hub::config_diagnostics` 先定工作区再取包列表交给 `report_with`。设置监听每次重载都发 `core/settings`，并监听工作区根目录与 rules、agents 目录。
- 测试：`cargo test -p piarc-core --test state sources`（每类来源一个夹具、信任前后、运行中新增 rule 后刷新）与 `--lib config_diagnostics`。

## Skills 与输出风格（T37，ADR-0054）

- 设置监听（`workspace_settings.rs`）同时监听 skills、命令与输出风格的目录（`piarc_config::skills::watch_dirs`，只取工作区、数据目录与家目录之下的），每次重载与信任变化推进 `WorkspaceSettings::changes`；工作区 actor 启动时开 `reload_resources` 任务，Agent Host 运行时发 `resources/reload`（不启动它）。
- `sessions/skills.rs` 是 `Hub` 的 `list_commands`、`list_skills`（有运行中的 Agent Host 时问 `resources/listCommands`、`resources/listSkills`，否则 Core 按文件回答）与 `set_output_style`（工作区写 `.piarc/settings.local.json` 并立即对运行中的 Agent Host 发 `resources/reload`，不带工作区写用户级 `settings.json`）；NAPI `listCommands`、`listSkills`、`setOutputStyle`。内置命令只在 `piarc_config::skills::BUILT_IN_COMMANDS` 定义，`composer::info` 不再带命令列表。

## 托管设置（`managed`，T47，设计增补 `T47-auto-memory-and-managed-settings.md` 第 5–8 节）

- `ManagedSettings`（Core 一份，`DataDirs::managed()`）经 `piarc_ports::PolicyStore` 读管理员来源（应用里是 `managed::store::SystemPolicy`：macOS 的 managed preferences plist 与 `/Library/Application Support/{PiArc,ClaudeCode}/`，Windows 的 `HKLM\SOFTWARE\Policies\{PiArc,ClaudeCode}` 与注册表给出的 Program Files；用户名与 Program Files 不取自环境变量），交给 `piarc_config::managed::Managed::build`，结果是 `Snapshot`（托管值、`CLAUDE.md` 文档、Claude Code 的 `managed-mcp.json`）。`DataDirs::layers` 把它的 `enterprise` 层加进每张设置表，读设置的入口都自动带上，不要另建表。
- 启动时同步读取（`ManagedSettings::load`），文档不是 JSON 对象时 `CoreRuntime::start` 返回 `Error::ManagedSettings`（kind `managedSettingsInvalid`，`details` 带位置与行列，主进程据此显示本地化对话框并退出）；之后每 `ManagedConfig::poll`（`DEFAULT_POLL` 60 s）重读一次，指纹变化才换快照并推进 `changes()`；工作区设置监听（`workspace_settings.rs` 的 `remanage`）据此替换 `enterprise` 层并发 `core/settings`，`ConfigChange` 以 `policy_settings` 运行且不可阻断。
- 测试只用 `managed::store::FixedPolicy`（同样的布局放在测试选的目录下，Windows 的注册表换成 `HKCU` 下的测试键）：L2 的 `managed` 段、`createForTests` 的 `PIARC_TEST_MANAGED_ROOT`（轮询 200 ms）。不要让测试读本机的系统位置。
- 锁定：`client_settings`、`tool_io/policy/settings_view.rs`、沙箱与 Auto 模式的设置写入、插件开关、MCP 启停、记忆开关都经 `piarc_config` 的写入函数，被锁定的指针返回 `permissionDenied`（`details.reason: "managed"`）；`Hub::managed_settings`（NAPI `managedSettings`）给设置窗口锁定视图（`piarc_config::managed::view`）。hooks 在 `allowManagedHooksOnly` 下跳过非托管来源并写审计（`hooks/mod.rs`）。
- 测试：`cargo test -p piarc-core --lib managed::` 与 `--lib tool_io::policy::tests::t47`。

## 自动记忆（`auto_memory`，T47，设计增补第 1–4 节）

- `auto_memory::Store` 是记忆目录唯一的读写方：`<数据目录>/auto-memory/<目录名-路径哈希12位>/`，键取主 checkout（`piarc_git::resolve(..).main`，worktree 共用），主题文件的 frontmatter 与索引 `MEMORY.md` 都由 Core 写，模型不写索引；上限 `MAX_TOPIC_BYTES`、`MAX_TOPICS`、`INDEX_LINES`、`INDEX_BYTES`。`import_claude` 只读 `~/.claude/projects/<项目键>/memory/`（`claude_dir`）复制一次，不写 `.claude/`。
- 模型侧在 `tool_io/auto_memory.rs`：`memory/status`（开关与是否给 `Memory` 工具：未信任项目、子会话没有工具）、`memory/apply`（消费同一调用的授权，读、存、删，每次改动一行 `kind: "memory"` 审计）；`fs/memory` 快照的最后一个文件是截断后的索引（`kind: "autoMemory"`）。开关的读取只经 `auto_memory_on`。 信任和开关在实际读取主题时也要检查，包括压缩恢复。索引可在未信任主会话加载，200 行与 25 KiB 包含标题和截断提示。导入与编辑按记忆目录取同一把写锁，同名目标即使格式损坏也保留。
- 用户侧在 `sessions/memory.rs`：`Hub::memory_view`、`memory_edit`（NAPI `memoryView`、`memoryEdit`：存、删、全部删除、导入、开关），改动同样写 `kind: "memory"` 审计（`by: user`、`import`），开关经设置写入函数（用户层或 `.piarc/settings.local.json`，项目只能关闭）。
- 测试：`cargo test -p piarc-core --lib auto_memory` 与 `--lib tool_io::policy::tests::t47`；L2 `memory-auto-*`。

## 子目录说明

- `src/tool_io/AGENTS.md`：委托的工具 I/O、工具预检、memory 与 rules、上下文工程、检查点与回退、WebFetch、hooks（T16–T30）。
- `src/sessions/AGENTS.md`：会话编排、登录与模型偏好、服务商设置 Host（T14、T21、T29）。

## 不变量

- 同步方法（`echo`）只做校验与 `try_send`，不做 I/O、不拿长时间持有的锁（架构第 7.2 节，单次预算 1 ms）。
- 路由键语法：1–128 个 `[A-Za-z0-9._:/-]`；`core/` 前缀保留给 Core 自己的事件（`core/errors`、`core/settings`），客户端传入会被拒绝。主进程 `src/shared/ipc.ts` 的 `isRouteKey` 与之保持一致。
- 错误映射为 `piarc_protocol::ErrorObject`：`ShuttingDown` → `shuttingDown`，`QueueFull` → `busy`，参数错误 → `invalidParams`，功能 crate 的错误（`Feature`）保留它们自己的 kind 与 `retryable`，其余 → `internalError`。
- 演示事件源（`demo.rs`）只给测试与基准用；发布构建的 `piarc-napi` 不导出启动它的函数。

- 家目录（T24）：`CoreConfig.home` 默认是进程家目录，`open_state` 经 `DataDirs::with_home` 放进 `Storage` 的目录；凡是读设置的地方都用 `DataDirs::layers(workspace)`（PiArc 与 Claude Code 七层），不要直接调 `LayerTable::piarc`。测试、L2、`createForTests` 都注入临时目录，从不读本机 `~/.claude`。
- 配置诊断（T24）：`config_diagnostics::report` 用 `TrustService::permission_settings` 加载（与权限裁决同一份），附上 `~/.claude.json` 的键名报告；经 `Hub::config_diagnostics` 与 `CoreRuntime::config_diagnostics`（NAPI `configDiagnostics`）对外。写 `.claude/` 的任何尝试返回 `permissionDenied`（`piarc_config::WriteError::ClaudeConfig`）。

## 易错点

- 不能在运行时线程或 sink 投递所在的线程上调用 `shutdown_blocking`：最后一批要等那个线程处理完。JS 侧用 `shutdown()` 返回的 Promise。
- 不要在异步任务里持有 `Arc<Shared>`：`Shared` 的 `Drop` 会停运行时，在运行时线程里丢弃会出问题。
- 会话层的回调（`on_done`）在 Core 的运行时线程上调用；`open_workspace` 等方法本身只入队，等结果用回调或 NAPI 的 Promise。
- 不要在 `Hub` 的路由锁里 await（`std::sync::Mutex` 的守卫跨 await 会让 future 不是 `Send`）：先在块里取出要的句柄，再 await。
- Windows 测试持有 `piarc_fs::Scope` 时删不掉它打开的目录（ADR-0036 不共享删除）：先 `drop` scope 再清理临时目录。
- 测试里的保险箱主密钥名（`test_master_key_name`）带随机后缀：同一个数据目录上重启 Core 时要复用同一个名字，否则保险箱返回 `masterKeyMissing`，Agent Host 拿不到凭据。

## 参考

- 架构第 7.2、7.6 节；ADR-0014；`docs/spikes/S02-napi-event-channel.md`。
