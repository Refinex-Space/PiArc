# piarc-core · sessions

工作区与会话的编排（T14 起）：`Hub`、工作区与会话 actor、快照、登录与服务商设置 Host。crate 级的命令、运行时与不变量见上级 [`crates/piarc-core/AGENTS.md`](../../AGENTS.md)。

## 会话编排（`sessions`，T14，ADR-0026）

- 结构：`Hub` 是 API 入口，只持路由表（工作区路径 → `WorkspaceHandle`，会话 id → `SessionHandle`），锁不跨 await。`WorkspaceActor`（`sessions/workspace.rs`）持有监管器；`SessionActor`（`sessions/session.rs`）持有会话状态；快照任务（`sessions/snapshot.rs`）发 `core/workspaces`、`core/sessions`。actor 之间只经消息通信，都不在自己的循环里等待 Agent Host：启动、恢复、请求、关闭都以任务执行，结果经邮箱回来。
- 事件：每次启动监管器配一个消费任务，持续取走 `HostEvents`：会话通知、恢复结果、未决调用发给会话 actor 的有界邮箱（1,024，满时消费任务等待，即背压），生命周期事件发给工作区 actor（带启动代次，旧监管器的事件被忽略）。
- seq：会话 actor 只按 `last_seq + 1` 交付；缺口后的通知暂存，`session/getEntries(last)` 补齐后先交付补到的再交付暂存的；补不齐时发 `session/resync` 并从下一条继续。重新打开会话时以 `last_seq` 作为 `session/resume` 的 `lastSeq`。
- 状态：`turn/started` → `running`；`turn/completed` → `idle`（失败为 `error`）并置未读；恢复失败、Agent Host 放弃重启、在途回合未决都为 `error`。忙闲（有请求在途或回合进行中）报给工作区 actor。
- 预热与回收：打开工作区即启动 Agent Host（`open_workspace` 在连接成功、已打开的会话恢复后才返回）；没有忙的会话、没有等待中的获取时按注入的 `Clock` 计时，`idle_timeout`（默认 30 分钟）到期且计时代次未变则 `host/shutdown`，状态 `reclaimed`；之后任何需要 Agent Host 的请求重新启动它并恢复打开中的会话（epoch 1 时由工作区 actor 恢复，崩溃重启时由监管器恢复）。测试用 `clock::ManualClock`。
- 取消：根 token → 会话 token（关闭时取消，进行中的请求停止等待）→ 回合中断时 `ToolIo::cancel_running` → 命令自己的 token 结束进程。
- 快照 revision：每个列表一个计数器，只在快照任务里递增并发出，所以按发出顺序严格递增；一批同时到达的变化合成一个快照。列表 = 数据库（最近的工作区、会话索引）+ actor 报告的实时状态（实时字段优先）。
- 会话 id：`create` 用 Core 生成的 UUID；创建超时或连接中断时以 `session/resume` 收敛。工作区路径与 cwd 先规范化并确认是已存在的目录，cwd 必须在工作区内（I20）。
- 会话元数据（T18，ADR-0029）：`Op::Prefs`（标题、置顶、归档）经 `CoreRuntime::session_op` 走 `Hub::set_prefs`：打开的会话先记在 actor 里（`LiveSession.prefs` 覆盖快照，随下次索引同步写入），未打开的直接写索引；归档时关闭会话并清理临时输出，保留历史 JSONL 和 `attachments/`（ADR-0030）；归档与删除在关闭前取 `ToolIo::session_hold`、关闭后等 Core 放开会话（至多 10 s）再删目录：仍在运行的 hook 持有会话的 `Scope`，Windows 上删不掉它打开的目录（W2）。`Hub::delete_session` 先关闭会话，再删 `pi/sessions/` 下的 JSONL（不在其下的拒绝）、临时目录与索引行。会话链接带 `in_host`：工作区首个进程连上时只恢复已在 Agent Host 中打开过的会话，正在创建的不恢复。启动时的索引同步结束后 `reload_snapshots`。
- 客户端偏好（`client_settings`）：可写 `language`、`appearance`、`keybindings`、`notifications`，以及布尔偏好 `/memory/readBoth`，经 `piarc_config::write_value`；读取返回整份文件（不存在为 `{}`）。
- I62 已接上：工作区 actor 打开时启动设置监听（`WorkspaceSettings`）。macOS 的首次 FSEvents 注册在阻塞线程池进行，与 Host 握手并行。注册完成后重新读取设置，显式 `open_settings` 仍等待监听就绪。回合结束时同步索引。信任变化重启（T18 起）：`CoreRuntime::trust_view`（决定）与 `revoke_trust` 在应答前调 `Hub::trust_changed`，同一主 checkout 的工作区 actor 先把状态置为 `Restarting`（之后的请求等新进程就绪）再调 `HostSupervisor::restart`，所以信任对话框之后立即创建的会话落在新进程上；`agent_host::restart_on_trust_change` 只剩监管器层面的测试使用。

## 后台任务（T32，ADR-0049）

- 会话 actor 把 `turn/started`、`turn/completed` 报给任务管理器（Monitor 的唤醒判断），在 `reminder` 条目里认出 `backgroundTask`/`monitorOutput` 的来源并报告送达（`session/notices.rs` 的 `reminders_delivered`），收到 `SessionMsg::Notices` 时一轮一轮地发送挂起的通知（`send_notices`，在途时合并）；`Restored`、`create`/`resume` 之后与每个 prompt/steer/follow-up 发出前也发送（`notices::deliver`）。唤醒前读合并设置 `monitor.wakeIdleSession`（`ToolIo::monitor_wake_allowed`），关掉时以不唤醒的方式发出。
- 归档与删除先 `TaskManager::session_removed` 再清理目录；关闭会话结束其 Monitor（后台命令照常运行）；`Hub::stop_task`/`read_task_output` 是面板的停止与读取（NAPI `stopTask`、`readTaskOutput`）；`HubOutlet` 实现 `TaskOutlet`。

## 子 agent（T31，ADR-0048）

- `sessions/inbound.rs` 应答 `agents/list`、`subagent/start`、`subagent/finish`：父会话必须属于本工作区；登记后子会话 id 进入工作区的 `SessionSet`（它的 `fs/*`、`exec/*` 才能通过），并经 `Activity` 报为忙碌（运行中的后台子 agent 让空闲计时不回收 Agent Host），`subagent/finish` 或连接结束（每个子会话一个 `peer.closed()` 观察任务）时撤销并写索引。
- `sessions/subagents.rs` 是 `Hub` 的 `list_agents`（经 `resources/listAgents`）、`stop_subagent`（`subagent/stop`）、`subagent_transcript`（核对子会话属于该父会话后，按父会话的位置读子会话的历史窗口）。快照（`snapshot.rs`）把子会话排除在会话列表之外（`SnapshotMsg::Subagent`），子会话的审批卡并入主会话的条目。
- `providers.rs` 的 `Settings` 存 `aliases`（用户级 `modelAliases`）与 `auxiliary_alias`（`modelProviders.auxiliaryAlias`），`preferences()` 把别名解析成具体模型再交给 Agent Host。NAPI：`listAgents`、`stopSubagent`、`subagentTranscript`。

## 登录与模型偏好（T29，ADR-0045）

- 登录（`sessions/login.rs`）：`Hub::login` 持 `provider_writer` 锁，为本次登录启动设置 Host（入站处理者 `SettingsInbound`：保险箱 + `ui/loginInteraction`），`call_within` 等 `models/login/start` 至多 15 分钟；`Logins` 一次只允许一个登录，每一步发 `core/login`（`started`、`interaction`、`succeeded`/`failed`/`cancelled` 与 `message`），`answer_login(id, None)` 取消（Core 再发 `models/login/cancel`）。新的提问顶替旧提问，进度不顶替。设置 Host 的启动经 `settings_host_with`，同样应用 `tune_host`（测试注入 `--test-oauth-provider`）。
- 模型偏好：`providers::Settings` 的 `models`、`auxiliary` 存在用户级 `modelProviders`（`Operation::Preferences` 校验后写入，`toolReliability` 不能由用户设）；`Settings::preferences()` 给 `local` 类服务商的模型加 `toolReliability: low`。`Ctx.model_preferences` 由握手（`HostConfig.model_preferences`）与 `reload_models`（`ModelsReloadParams.preferences`）下发；服务商增删也会刷新它。设置视图另带 `loginProviders` 与 `catalogModels`（设置 Host 不带偏好，是目录原值）。
- NAPI：`setModelPreferences`、`startLogin`、`answerLogin`、`logoutProvider`。`cargo test -p piarc-core --lib tool_io::policy::tests::t29` 覆盖授权绑定、审计、内网拒绝与域名规则；登录的端到端在 `piarc-testkit` 的 `tests/sessions/login.rs`。

## 模型与服务商设置（T21）

- `providers.rs` 校验设置并生成 `pi/models.json`。公开配置写入用户级 `settings.json` 的 `modelProviders`；生成的无密钥端点使用固定的公共占位值。已经导入的同名端点会阻止新增操作。
- `sessions/provider_settings.rs` 为每次设置操作启动受监督的专用 Host，仅向它提供保险箱服务。它在 `agent-host/settings/` 工作，通过 `ModelRuntime.login/logout` 保存凭据，操作后关闭。变更完成后向已运行的工作区发送 `models/reload`；稍后启动的工作区在握手时读取当前刷新开关。
- 配置变更先在 `agent-host/provider-change.json` 记录公开目标和变更 ID。若设置 Host 或 Core 中断，下一次打开工作区或设置时从新 Host 查询已持久化凭据的变更 ID，恢复对应的公开配置和端点投影。恢复记录、诊断、客户端回应均不带密钥。
- 变更端点地址或线协议时须重新提交或清除密钥。自定义凭据在保险箱内绑定端点与协议，随 AHP 交给 Host。云厂商字段放在 Pi 的单次请求 credential.env 中。进程环境使用启动器既有的白名单。
