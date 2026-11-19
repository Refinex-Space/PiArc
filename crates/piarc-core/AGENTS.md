# piarc-core

Core 的运行时门面：tokio 多线程运行时、事件队列与合并器、有序关闭、任务监督；`agent_host` 模块把 `piarc-host` 的监管器与生产 I/O（`piarc-exec` 的进程启动器、`SystemClock`）装配起来，是 Agent Host 测试的无头入口（T06）；`tool_io` 应答 Agent Host 委托的 `fs/*`、`exec/*`（T07），沙箱会话的命令经 `piarc-sandbox` 包装（T11）；`secrets` 把凭据保险箱提供给所有 Agent Host（`secrets/*`，T08），`identity` 是应用标识的唯一定义；`terminal` 是终端会话的注册表（T10）；`dirs`、`storage`、`trust`、`workspace_settings` 是数据目录、数据库、项目信任与工作区设置（T13）；`sessions` 是工作区与会话的编排（T14），`clock` 是空闲计时用的时钟；`client_settings` 读写用户级 `settings.json` 中的客户端偏好（T18）。运行时门面的状态与会话方法分别在 `runtime/state.rs` 与 `runtime/sessions.rs`。会话删除的原生确认先从 Core 读取目标标题和工作区，并显示同一会话 ID。不负责 JavaScript 绑定（`piarc-napi`）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-core` | 单元测试 + `tests/event_channel.rs`（回调频率、无丢失与顺序、背压、有序关闭、任务 panic、未关闭直接丢弃）+ `tests/tool_io.rs`（越界需要询问、流式输出、取消、会话隔离）+ `tests/file_invariants.rs`（T16：先读后改、外部修改、重复读取、上传与 diff、受保护路径、spill、编码）+ `tests/secrets.rs`（推送、保险箱错误、锁与租约、并发读改写） |
| `cargo test -p piarc-core --test exec_commands -- --nocapture` | 命令（T17）：cd 跨命令保留与越界重置、超时与截断的上限、落盘与预览、两个管道各 50 MB、语义退出码、环境剔除、`exec/shells`；Windows 上另有 PowerShell 与 Git Bash 的中文输出 |
| `cargo test -p piarc-core --test sandbox` | 沙箱会话（macOS）：写入范围、受保护路径、`denyRead`、绕过代理、流式与退出码、`exec/kill` 后进程组为空（T17 起 shell 以 `SIGTERM` 结束）、关闭会话停止代理 |
| `cargo test -p piarc-core --test sandbox_commands -- --nocapture` | 沙箱内 git、python、cargo build、npm install（后两项连真实 registry，连不上就失败并说明） |
| `cargo test -p piarc-core --test release -- --nocapture` | 发布清单校验（T12-A08）：有效、篡改内容、篡改哈希与大小、未列出、换密钥、无内置公钥，打印结构化错误 |
| `cargo test -p piarc-core --test agent_host_probe` | 探针在 Core 运行时上启动进程（运行时开着 I/O）、Agent Host 未握手就退出时报告错误（Unix） |
| `cargo test -p piarc-core --test state` | 数据目录布局、信任按主 checkout（真实 git 夹具）、重启后保留与撤销、`trust/get` 故障注入、信任视图与新增项、设置文件变化事件（T13） |
| `cargo test -p piarc-testkit --test sessions` | 会话层端到端（真实 Agent Host + mock）：排队、steer 与 follow-up、中断、工具批次、重试、缺口补齐、空闲回收、快照 revision、fork 与关闭、重启恢复（T14） |
| `cargo run --release -p piarc-testkit --example t14-warmup` | 打开工作区到 Agent Host 就绪的 10 次测量（T14-A09） |
| `cargo test -p piarc-core --test terminal` | 终端：`term/<id>` 事件、经回调取帧、错误类别、关闭时结束终端（Unix） |
| `cargo clippy -p piarc-core --all-targets -- -D warnings` | lint |

## 运行时与关闭顺序

- `CoreRuntime::start(config, sink)` 建运行时并启动合并器；`shutdown(cb)` 在专用线程上执行：拒绝新请求（`ShuttingDown`）→ 取消根 `CancellationToken` 并等演示事件源结束 → 关闭队列、合并器排空并投递最后一批、等客户端处理完（最多 5 s）→ 合并器丢弃 sink（NAPI 下即释放 `ThreadsafeFunction`）→ `shutdown_timeout` 停运行时 → 回调。
- 回调之后 sink 不会再被调用。`Drop` 未关闭的运行时只做取消与 `shutdown_background`，没有最后一批。
- 长任务从根 token 取子 token；新任务经 `spawn_supervised` 启动：panic 打到 stderr，并作为结构化错误事件发到 `core/errors`。合并器自身 panic 时由监督者直接向 sink 投递一个 `seq` 为 0 的带外批次。

## 事件合并器（`events.rs` 模块文档为准）

- 批次 = 路由键 + 每路由从 1 起连续的批次序号 + 载荷（该路由事件的 UTF-8 JSON 数组）。主进程只看路由键。
- 刷出时机：不早于首个待发事件到达，且距上次刷出至少一个间隔（默认 16 ms，1–1000 ms 可配）。无待发事件时不跑定时器。
- 满时策略，任何情况都不丢事件：最多 1 个在途投递（sink 丢弃 `DeliveryDone` 才算完成），期间继续在待发批次里累积；待发超过 64 MiB 停止读队列，队列（65,536 个事件）满后异步生产者等待，同步调用（`echo`）返回可重试的 `QueueFull`（kind `busy`）。只有 sink 报告 `SinkClosed`（JS 环境已销毁）时才丢弃并计入 `lost`。

## 委托的工具 I/O（`tool_io`）

- `ToolIo` 按会话登记的 `Scope`（工作区根 + cwd + 只读的会话临时目录 `<数据目录>/sessions/<id>/tmp/`，登记时创建）应答 `fs/*`（`piarc-fs`，放在阻塞线程池）与 `exec/*`（`piarc-exec`）；未登记的会话返回 `sessionNotFound`。登记由会话层做（会话 actor 启动时 `open_session`，关闭时 `close_session`）；每个工作区的入站处理者（`sessions/inbound.rs`）只放行本工作区的会话。`cancel_running` 终止会话正在运行的命令而保留会话（回合中断）。`ToolIoConfig.observer`（`ToolIoObserver`）在每个请求执行前被调用，只给测试用（T14-A06 的并发计数）。
- 文件工具的不变量（T16，ADR-0027）在 `tool_io/files.rs`：每个会话一张 `piarc_fs::FileStates`（随会话登记创建、`close_session` 释放；同一 id 重新登记即新表），所有会话共用一组 `PathLocks`；`fs/write`、`fs/spill` 的 `upload` 分段在会话的 `Uploads` 里收齐（同一 id 的目标必须相同，上限 `MAX_UPLOAD_BYTES`）；每次写入后用 `piarc_diff::file_diff` 生成结果的 `diff`。
- T23（ADR-0037）：`tool_io/policy/assess.rs` 由会话规则与各设置层（`Settings::permission_lists`，按内容缓存）建规则集，为 Bash（`BashFacts` 用会话 scope 定位路径、`exec/utility.rs` 的 `Programs` 解析程序）、PowerShell、文件工具与其他工具给出阶梯输入；`hooks.rs` 是第 2、8 步（T25：PreToolUse、PermissionRequest hooks，`updatedInput` 在规则之前替换参数，PermissionRequest 的改写重新裁决，`updatedPermissions` 只写会话与 `.piarc/`，运行前发 `policy/pending`，`if` 条件的匹配 `condition`；两步用本次裁决已读的设置 `HooksService::plan_in`，不再读一遍）；`modes.rs` 管起始模式、跳过权限开关（只读用户层）与 `workspaces.default_mode`；`settings_view.rs` 应答设置页（按来源列规则、编辑 PiArc 可写文件、审计筛选）。自动允许的 Bash 授权带上依赖的程序与路径，执行时钉住程序（`CwdProbe::pin_program`）并重查路径。AHP `policy/tools` 返回整体拒绝的工具。
- T26（ADR-0042）：`policy/plan.rs` 处理计划卡（批准带 `mode` 切换并记入工作区，继续规划把反馈与 UTF-16 锚定的评论作为拒绝理由）与 EnterPlanMode 的切换（结果的 `mode`）；`policy/questions.rs` 应答 `ui/ask`（表单进同一账本，超时取 `askUserQuestion.timeoutSeconds`、计时用 `ToolIoConfig.clock`）；`policy/waits.rs` 是卡片入账、`policy/pending` 与撤下的共用部分。
- 工具预检经 `tool_io::policy` 调用 `piarc-policy`，自动或用户决定写入审计；`core/sessions` 快照的 `approvals` 是窗口使用的待审请求。低层 I/O 需要对应调用的授权，用户中断或连接丢失会取消等待。批准规则以实际受信设置的合并结果为准（ADR-0031）。
- 命令（T17，ADR-0028）在 `tool_io/exec.rs`：shell 每个 Core 探测一次（`exec/shells` 回答，不检查会话：Agent Host 在会话创建过程中、Core 登记它之前就问，工作区入站处理者也放行；Windows 缺 Git Bash 时在 `core/notices` 发一次 `gitBashMissing`，Git Bash 路径只读用户级 `<data>/settings.json` 的 `shell.gitBashPath`）；每个会话一个 shell 目录（`SessionIo.shell_cwd`），未给 `cwd` 的 bash 命令带 `CwdProbe`，结束后越界就回到工作区根；全部命令用 `ProcessTreeSpawner`，超时与阈值取 `ToolIoConfig.exec_limits`。
- 输出：每块同时进 `OutputCapture`（结果的 `output`，超出预算全文写 `<会话临时目录>/tool-results/<工具调用 id>.txt`）与显示窗口 `Display`（`exec/output`，待发超过 `DISPLAY_WINDOW` 256 KiB 时丢最旧的块并报 `skipped`），转发任务发完才回响应；连接断开（`Peer::closed`）或 `exec/kill` 停止命令。
- 命令环境 = `ToolIoConfig.command_env`（`CommandEnv`）：`ToolIoConfig::new` 用 Core 自己的环境（`CommandEnv::process`），运行时（`CoreConfig.command_env` 为 `None`）用登录 shell（`CommandEnv::login_shell`，首次命令时解析并缓存）；两者均经 `piarc_exec::env::command_environment`，只缓存准入的 OS、locale 与工具链字段。原环境中影响 shell 解析的变量只保留风险标志；生产审批拒绝请求附加环境（ADR-0035）。`ToolIoConfig` 不能带 `notices`（crate 私有类型），要发通知用 `ToolIo::with_notices`。
- blob 放在 `<数据目录>/sessions/<会话 id>/blobs/`；会话 id 只允许 `[A-Za-z0-9._-]`，不能是 `.`、`..`。
- Composer 的类型、数量、大小和搜索上限由 `composer::info()` 提供。附件只经 `store_attachment` 写入本会话的 `attachments/`，会话的工具 scope 将该目录登记为只读。PDF 在发布到附件目录前通过解析和页数校验。归档保留附件，删除会话清理整个会话目录（ADR-0030）。
- 沙箱会话（T11）：`open_sandboxed_session` 建 `<数据目录>/sessions/<会话 id>/tmp/`、启动会话代理（`piarc_sandbox::SessionSandbox`）；`exec/run` 加上 `sandbox-exec` 包装与沙箱变量（同名覆盖请求的 `env`），用 `ProcessTreeSpawner` 运行。非 macOS 返回 `internalError`。代理随 `SessionIo` 释放而停止（`close_session` 后、最后一个运行中的命令结束时）。

## 上下文工程（T27，ADR-0043）

- `tool_io/context.rs` 应答能力 `context` 的三个请求：`context/settings`（`TrustService::permission_settings` 合并的 `/autoCompactEnabled`、`/autoCompactWindow`，窗口夹在 100,000–1,000,000；没有设置服务时返回缺省值）、`fs/changes`（`FileStates::external_changes`：元数据与记录不同才算哈希，同一版本只报告一次，快照不变，所以先读后改照常拦住）、`fs/forgetReads`（`FileStates::forget_read_ranges`，I72）。`fs/read` 带 `restore: true` 且不带 `origin` 时，`policy/grants.rs` 只放行会话文件状态表里、无需审批即可读取的文件（压缩后重注入最近文件）。
- `Op::Compact(Option<String>)` 把 `/compact <重点>` 作为 `session/compact` 的 `instructions` 转给 Agent Host；`Op::ContextUsage` 是 `session/getContextUsage`（NAPI `contextUsage`）。`session/usage` 与其他会话通知一样原样转发给客户端。

## Hooks（T25，ADR-0039）

- `hooks/mod.rs` 的 `HooksService` 用 `TrustService::permission_settings` 读 hooks（未信任项目的不生效），`plan`/`execute` 经 `ProcessTreeSpawner` 运行（命令环境首次要解析登录 shell，只在 `plan` 选出 handler 后解析：`ToolIo::run_hooks`、裁决第 2、8 步，`execute` 显式接收它；否则没有 hooks 的输入也要等登录 shell）、写审计（`kind: "hook"`）、发 `core/notices`（`type: "hook"`）、长文本落到 `<会话 tmp>/hooks/`，时长取 `CoreConfig.hooks`。`tool_io/hooks.rs` 应答 `hooks/run`（入站处理者只查 `cwd` 在本工作区内，已关闭会话的 SessionEnd 也能运行）、`user_prompt_submit`（阻断为 `permissionDenied`、`hookBlocked`）与 `notification_hooks`；hook 令牌登记在会话的 `running`，中断与关闭结束其进程树。
- `tool_io/hooks_tests.rs` 用真实 Core（命令环境固定 `PATH`，否则 cargo 的 `DYLD_*` 关掉规则 allow）；Bash 规则 allow 不覆盖文件写入，测会话规则用 `sed -n` 而不是 `touch`。

## 凭据（`secrets`）

- 一个 Core 只建一个 `SecretsService`，所有 Agent Host 的 `InboundHandler` 共用它（Core 是保险箱唯一写入方）。保险箱在第一次请求时打开，失败只让这次请求失败，下一次重新打开（用户授权钥匙串后不用重启）。保险箱操作放在阻塞线程池。
- 订阅：调用过 `secrets/getAll` 的连接收到每次写入的 `secrets/changed`；每个连接一个推送任务，关闭的连接在下一次推送时移除。
- 锁：`secrets/lock` 一组键一起锁，任一被占就等待；未带 `lockId` 的写入临时锁该键；`unlock`、租约（`DEFAULT_LOCK_LEASE` 30 s）、持有者连接结束都会释放；失效的 `lockId` 写入返回 `secretLockLost`。
- 参数错误不带 serde 的原文（它会引用出错的值，可能是凭据）。不要在日志里写值。
- 测试与 `piarc-testkit` 经本模块的再导出使用 `MemorySecretStore`、`test_master_key_name`（testkit 不能直接依赖 `piarc-secrets`）。
- `identity::APP_IDENTIFIER` 是 D2 决定的应用标识 `cn.piarc.desktop`（bundle id 与 AppUserModelID 也取它）。发布后不能再改：改了保险箱找不到主密钥，系统授权也要重给。

## 模型与服务商设置（T21）

- `providers.rs` 校验设置并生成 `pi/models.json`。公开配置写入用户级 `settings.json` 的 `modelProviders`；生成的无密钥端点使用固定的公共占位值。已经导入的同名端点会阻止新增操作。
- `sessions/provider_settings.rs` 为每次设置操作启动受监督的专用 Host，仅向它提供保险箱服务。它在 `agent-host/settings/` 工作，通过 `ModelRuntime.login/logout` 保存凭据，操作后关闭。变更完成后向已运行的工作区发送 `models/reload`；稍后启动的工作区在握手时读取当前刷新开关。
- 配置变更先在 `agent-host/provider-change.json` 记录公开目标和变更 ID。若设置 Host 或 Core 中断，下一次打开工作区或设置时从新 Host 查询已持久化凭据的变更 ID，恢复对应的公开配置和端点投影。恢复记录、诊断、客户端回应均不带密钥。
- 变更端点地址或线协议时须重新提交或清除密钥。自定义凭据在保险箱内绑定端点与协议，随 AHP 交给 Host。云厂商字段放在 Pi 的单次请求 credential.env 中。进程环境使用启动器既有的白名单。

## 打包的 Agent Host 与 S6 探针（T12）

- `agent_host::start` 一律用 `ProcessTreeSpawner`；`start_bundled` 从打包产物启动（布局、环境变量与 Seatbelt 包装见 `crates/piarc-host/AGENTS.md`）。Core 的 tokio 运行时开着 I/O（`enable_io`），在它上面监管子进程、跑代理都依赖这一点。
- `host_probe`、`keychain_probe` 只给测试用：开发构建的 `piarc-napi` 导出 `agentHostProbe`、`keychainProbe`，发布构建不导出。钥匙串探针的条目固定为 `piarc-test.s6-keychain.credential-vault`（构建 A 写、构建 B 读要同一个名字），不碰 `identity` 的正式条目。

## 发布清单（`release`，ADR-0024）

- `verify_manifest` 先验签后解析，只接受预哈希签名；`verify_file` 先比大小再流式算 SHA-256。所有失败是 `ReleaseError`，类别 `releaseIntegrity`（读不了文件为 `ioError`），`details.reason` 区分原因，调用方一律拒绝更新。
- `BUILTIN_RELEASE_KEYS` 在 T50 之前为空：没有信任的公钥时任何清单都被拒绝。不要把 `scripts/release/test-keys/` 的测试公钥放进去。
- 测试样本由 Node 的 `scripts/release/release-manifest.mjs` 签名（`tests/fixtures/release/`，`.gitattributes` 设为 `-text` 保持字节不变），换测试密钥后按该目录 README 重写。

## 终端（`terminal`）

- 注册表持有 `piarc_term::Session`；`create_terminal` 校验尺寸（1–1000）与绝对 cwd，事件（标题、响铃、退出）以 JSON 发到 `term/<id>`：IO 线程上用 `EventSender::blocking_send`，不能在运行时线程调用。
- 取帧、读屏、回显探针都放到阻塞线程池，结果经回调交给 NAPI；关闭 Core 时先关掉全部终端（有序关闭第 2 步）。

## 数据目录与状态（T13）

- `CoreConfig.dirs`（NAPI 的 `dataDir` + `cacheDir`，主进程算好传入）为 `None` 时没有数据库、设置、信任与日志文件，只给事件通道的测试与基准用；`storage()`、`trust()` 返回 `NoDataDirectory`。
- 启动时：建第 9.1 节的目录 → `piarc_telemetry::install(<data>/logs)`（进程级，只装一次；关闭时 `detach`）→ 打开并迁移 `core.sqlite`（同步，只在启动做一次）→ 后台增量同步 `pi/sessions/` 的索引 → 启动会话层（`Hub`、快照任务）。每个回合结束后会话 actor 增量同步索引并写入该会话的 Core 列（`set_session_state`）。
- 有序关闭的最后关闭数据库（`Storage::close`）：NAPI 的 `CoreRuntime` 对象要等 GC 才释放，Windows 不能删除打开着的文件（I66）。关闭后 `Storage::with`/`run` 返回 `ShuttingDown`。
- `Storage` 是 `Store` 加互斥锁，经阻塞线程池使用；不要在异步任务里拿着锁等待。
- 信任（`trust`）：`TrustService::trust_get` 应答 `trust/get`，任何失败（包括清单不完整、快照损坏、目录解析不了、数据库错、任务 panic）都答 `trusted: false`，只有参数格式错时回 `invalidParams`；查询一律经 `piarc_config::project_trust`。肯定决定须带用户看到的清单版本；遇到版本变化向客户端返回最新视图，保持原决定。同一项目的 linked worktree 需要反向登记（ADR-0034）。成功的 `decide`、`revoke` 广播 `TrustChange`；`agent_host::restart_on_trust_change` 订阅它，对同一主 checkout 调 `HostSupervisor::restart`（不计入崩溃退避，会话自动恢复）。T14 的工作区 actor 负责为每个工作区启动这个任务。
- 设置（`workspace_settings`）：`CoreRuntime::open_settings(workspace)` 加载四层并用 `piarc_fs::watch` 监听各层文件所在目录（`.piarc/` 不存在时监听工作区本身），去抖 150 ms 后重载；有变化键或问题变化时向 `core/settings` 发 `{ workspace, changed, issues }`。信任变化同样触发重新合并。

## 会话编排（`sessions`，T14，ADR-0026）

- 结构：`Hub` 是 API 入口，只持路由表（工作区路径 → `WorkspaceHandle`，会话 id → `SessionHandle`），锁不跨 await。`WorkspaceActor`（`sessions/workspace.rs`）持有监管器；`SessionActor`（`sessions/session.rs`）持有会话状态；快照任务（`sessions/snapshot.rs`）发 `core/workspaces`、`core/sessions`。actor 之间只经消息通信，都不在自己的循环里等待 Agent Host：启动、恢复、请求、关闭都以任务执行，结果经邮箱回来。
- 事件：每次启动监管器配一个消费任务，持续取走 `HostEvents`：会话通知、恢复结果、未决调用发给会话 actor 的有界邮箱（1,024，满时消费任务等待，即背压），生命周期事件发给工作区 actor（带启动代次，旧监管器的事件被忽略）。
- seq：会话 actor 只按 `last_seq + 1` 交付；缺口后的通知暂存，`session/getEntries(last)` 补齐后先交付补到的再交付暂存的；补不齐时发 `session/resync` 并从下一条继续。重新打开会话时以 `last_seq` 作为 `session/resume` 的 `lastSeq`。
- 状态：`turn/started` → `running`；`turn/completed` → `idle`（失败为 `error`）并置未读；恢复失败、Agent Host 放弃重启、在途回合未决都为 `error`。忙闲（有请求在途或回合进行中）报给工作区 actor。
- 预热与回收：打开工作区即启动 Agent Host（`open_workspace` 在连接成功、已打开的会话恢复后才返回）；没有忙的会话、没有等待中的获取时按注入的 `Clock` 计时，`idle_timeout`（默认 30 分钟）到期且计时代次未变则 `host/shutdown`，状态 `reclaimed`；之后任何需要 Agent Host 的请求重新启动它并恢复打开中的会话（epoch 1 时由工作区 actor 恢复，崩溃重启时由监管器恢复）。测试用 `clock::ManualClock`。
- 取消：根 token → 会话 token（关闭时取消，进行中的请求停止等待）→ 回合中断时 `ToolIo::cancel_running` → 命令自己的 token 结束进程。
- 快照 revision：每个列表一个计数器，只在快照任务里递增并发出，所以按发出顺序严格递增；一批同时到达的变化合成一个快照。列表 = 数据库（最近的工作区、会话索引）+ actor 报告的实时状态（实时字段优先）。
- 会话 id：`create` 用 Core 生成的 UUID；创建超时或连接中断时以 `session/resume` 收敛。工作区路径与 cwd 先规范化并确认是已存在的目录，cwd 必须在工作区内（I20）。
- 会话元数据（T18，ADR-0029）：`Op::Prefs`（标题、置顶、归档）经 `CoreRuntime::session_op` 走 `Hub::set_prefs`：打开的会话先记在 actor 里（`LiveSession.prefs` 覆盖快照，随下次索引同步写入），未打开的直接写索引；归档时关闭会话并清理临时输出，保留历史 JSONL 和 `attachments/`（ADR-0030）。`Hub::delete_session` 先关闭会话，再删 `pi/sessions/` 下的 JSONL（不在其下的拒绝）、临时目录与索引行。会话链接带 `in_host`：工作区首个进程连上时只恢复已在 Agent Host 中打开过的会话，正在创建的不恢复。启动时的索引同步结束后 `reload_snapshots`。
- 客户端偏好（`client_settings`）：可写 `language`、`appearance`、`keybindings`、`notifications`，以及布尔偏好 `/memory/readBoth`，经 `piarc_config::write_value`；读取返回整份文件（不存在为 `{}`）。
- I62 已接上：工作区 actor 打开时启动设置监听（`WorkspaceSettings`）。macOS 的首次 FSEvents 注册在阻塞线程池进行，与 Host 握手并行。注册完成后重新读取设置，显式 `open_settings` 仍等待监听就绪。回合结束时同步索引。信任变化重启（T18 起）：`CoreRuntime::trust_view`（决定）与 `revoke_trust` 在应答前调 `Hub::trust_changed`，同一主 checkout 的工作区 actor 先把状态置为 `Restarting`（之后的请求等新进程就绪）再调 `HostSupervisor::restart`，所以信任对话框之后立即创建的会话落在新进程上；`agent_host::restart_on_trust_change` 只剩监管器层面的测试使用。

## 不变量

- 同步方法（`echo`）只做校验与 `try_send`，不做 I/O、不拿长时间持有的锁（架构第 7.2 节，单次预算 1 ms）。
- 路由键语法：1–128 个 `[A-Za-z0-9._:/-]`；`core/` 前缀保留给 Core 自己的事件（`core/errors`、`core/settings`），客户端传入会被拒绝。主进程 `src/shared/ipc.ts` 的 `isRouteKey` 与之保持一致。
- 错误映射为 `piarc_protocol::ErrorObject`：`ShuttingDown` → `shuttingDown`，`QueueFull` → `busy`，参数错误 → `invalidParams`，功能 crate 的错误（`Feature`）保留它们自己的 kind 与 `retryable`，其余 → `internalError`。
- 演示事件源（`demo.rs`）只给测试与基准用；发布构建的 `piarc-napi` 不导出启动它的函数。

- Memory 由 `tool_io/memory.rs` 组装快照，文件发现和导入在 `memory_reader.rs`。外部导入经同一会话的审批账本，由 `policy/memory.rs` 按工作区及规范目标匹配。见 ADR-0033。
- 家目录（T24）：`CoreConfig.home` 默认是进程家目录，`open_state` 经 `DataDirs::with_home` 放进 `Storage` 的目录；凡是读设置的地方都用 `DataDirs::layers(workspace)`（PiArc 与 Claude Code 七层），不要直接调 `LayerTable::piarc`。测试、L2、`createForTests` 都注入临时目录，从不读本机 `~/.claude`。
- Claude Code rules（T24，ADR-0038）：`memory_reader/rules.rs` 选出 `~/.claude/rules/` 与工作区根 `.claude/rules/` 中要载入的文件（排在各自的 `.claude/CLAUDE.md` 之后），无条件的总是载入，带 `paths:` 的在 `fs/memory` 的 `files` 有匹配文件或 `rules` 点名时载入；快照的 `inactiveRules` 告诉 Agent Host 还有没载入的条件 rules。frontmatter 只用于选择，送达的正文不含它。
- 配置诊断（T24）：`config_diagnostics::report` 用 `TrustService::permission_settings` 加载（与权限裁决同一份），附上 `~/.claude.json` 的键名报告；经 `Hub::config_diagnostics` 与 `CoreRuntime::config_diagnostics`（NAPI `configDiagnostics`）对外。写 `.claude/` 的任何尝试返回 `permissionDenied`（`piarc_config::WriteError::ClaudeConfig`）。

## 易错点

- 不能在运行时线程或 sink 投递所在的线程上调用 `shutdown_blocking`：最后一批要等那个线程处理完。JS 侧用 `shutdown()` 返回的 Promise。
- 不要在异步任务里持有 `Arc<Shared>`：`Shared` 的 `Drop` 会停运行时，在运行时线程里丢弃会出问题。
- 会话层的回调（`on_done`）在 Core 的运行时线程上调用；`open_workspace` 等方法本身只入队，等结果用回调或 NAPI 的 Promise。
- 不要在 `Hub` 的路由锁里 await（`std::sync::Mutex` 的守卫跨 await 会让 future 不是 `Send`）：先在块里取出要的句柄，再 await。
- 当前用户无权访问的 PATH 条目（Windows 的 PATH 常有 `C:\Windows\system32\config\systemprofile\…`）不取消自动允许（W1）：macOS 的 `tool_io/exec/utility.rs` `first_on_path` 跳过工作区外的这类条目，其余无法检查的条目和工作区内的条目一律改为询问；Windows 由 Git Bash 解析（`probe_git_programs`），bash 自己跳过它们。
- Windows 测试持有 `piarc_fs::Scope` 时删不掉它打开的目录（ADR-0036 不共享删除）：先 `drop` scope 再清理临时目录。
- 测试里的保险箱主密钥名（`test_master_key_name`）带随机后缀：同一个数据目录上重启 Core 时要复用同一个名字，否则保险箱返回 `masterKeyMissing`，Agent Host 拿不到凭据。

## 参考

- 架构第 7.2、7.6 节；ADR-0014；`docs/spikes/S02-napi-event-channel.md`。
