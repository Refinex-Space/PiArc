# piarc-core · tool_io

`ToolIo`：应答 Agent Host 委托的 `fs/*`、`exec/*`、`web/fetch`、`hooks/run`、`context/*` 与工具预检（`policy/*`），以及检查点、回退与 Changes。crate 级的命令、运行时与不变量见上级 [`crates/piarc-core/AGENTS.md`](../../AGENTS.md)；权限规则与 Bash 分析见 [`piarc-policy`](../../../piarc-policy/AGENTS.md)。

## 委托的工具 I/O（`tool_io`）

- `ToolIo` 按会话登记的 `Scope`（工作区根 + cwd + 只读的会话临时目录 `<数据目录>/sessions/<id>/tmp/`，登记时创建）应答 `fs/*`（`piarc-fs`，放在阻塞线程池）与 `exec/*`（`piarc-exec`）；未登记的会话返回 `sessionNotFound`。登记由会话层做（会话 actor 启动时 `open_session`，关闭时 `close_session`）；每个工作区的入站处理者（`sessions/inbound.rs`）只放行本工作区的会话。`cancel_running` 终止会话正在运行的命令而保留会话（回合中断）。`ToolIoConfig.observer`（`ToolIoObserver`）在每个请求执行前被调用，只给测试用（T14-A06 的并发计数）。
- 文件工具的不变量（T16，ADR-0027）在 `tool_io/files.rs`：每个会话一张 `piarc_fs::FileStates`（随会话登记创建、`close_session` 释放；同一 id 重新登记即新表），所有会话共用一组 `PathLocks`；`fs/write`、`fs/spill` 的 `upload` 分段在会话的 `Uploads` 里收齐（同一 id 的目标必须相同，上限 `MAX_UPLOAD_BYTES`）；每次写入后用 `piarc_diff::file_diff` 生成结果的 `diff`。
- T23（ADR-0037）：`tool_io/policy/assess.rs` 由会话规则与各设置层（`Settings::permission_lists`，按内容缓存）建规则集，为 Bash（`BashFacts` 用会话 scope 定位路径、`exec/utility.rs` 的 `Programs` 解析程序）、PowerShell、文件工具与其他工具给出阶梯输入；`hooks.rs` 是第 2、8 步（T25：PreToolUse、PermissionRequest hooks，`updatedInput` 在规则之前替换参数，PermissionRequest 的改写重新裁决，`updatedPermissions` 只写会话与 `.piarc/`，运行前发 `policy/pending`，`if` 条件的匹配 `condition`；两步用本次裁决已读的设置 `HooksService::plan_in`，不再读一遍）；`modes.rs` 管起始模式、跳过权限开关（只读用户层）与 `workspaces.default_mode`；`settings_view.rs` 应答设置页（按来源列规则、编辑 PiArc 可写文件、审计筛选）。自动允许的 Bash 授权带上依赖的程序与路径，执行时钉住程序（`CwdProbe::pin_program`）并重查路径。AHP `policy/tools` 返回整体拒绝的工具。
- T26（ADR-0042）：`policy/plan.rs` 处理计划卡（批准带 `mode` 切换并记入工作区，继续规划把反馈与 UTF-16 锚定的评论作为拒绝理由）与 EnterPlanMode 的切换（结果的 `mode`）；`policy/questions.rs` 应答 `ui/ask`（表单进同一账本，超时取 `askUserQuestion.timeoutSeconds`、计时用 `ToolIoConfig.clock`）；`policy/waits.rs` 是卡片入账、`policy/pending` 与撤下的共用部分。
- 工具预检经 `tool_io::policy` 调用 `piarc-policy`，自动或用户决定写入审计；`core/sessions` 快照的 `approvals` 是窗口使用的待审请求。低层 I/O 需要对应调用的授权，用户中断或连接丢失会取消等待。批准规则以实际受信设置的合并结果为准（ADR-0031）。
- 命令（T17，ADR-0028）在 `tool_io/exec.rs`：shell 每个 Core 探测一次（`exec/shells` 回答，不检查会话：Agent Host 在会话创建过程中、Core 登记它之前就问，工作区入站处理者也放行；Windows 缺 Git Bash 时在 `core/notices` 发一次 `gitBashMissing`，Git Bash 路径只读用户级 `<data>/settings.json` 的 `shell.gitBashPath`）；每个会话一个 shell 目录（`SessionIo.shell_cwd`），未给 `cwd` 的 bash 命令带 `CwdProbe`，结束后越界就回到工作区根；全部命令用 `ProcessTreeSpawner`，超时与阈值取 `ToolIoConfig.exec_limits`。
- 后台（T32，ADR-0049）：`exec/run` 不把超时交给 `CommandRunner`，`Exec::execute` 用任务时钟等 `ExecLimits` 的超时，到时 `to_background` 经 `exec/background.rs` 的 `Switch` 让输出消费者交出捕获内容、登记任务、`watch_to_end` 记录结束；`background: true` 直接 `start_task`。`exec/run` 的令牌在转后台后从 `running` 摘下，回合中断与连接断开不再波及。`tool_io/tasks.rs` 应答 `exec/monitor`（`policy::claim_monitor` 消费同一调用的授权，命令按后台 bash 组装）、`exec/background/list|read|kill`（只认本会话与其子 agent 的任务）；`Place` 决定任务归属的主会话与输出目录。`claim_command` 还核对 `run_in_background` 与批准的参数一致。会话 scope 把主会话的 `tasks/` 登记为只读。
- 输出：每块同时进 `OutputCapture`（结果的 `output`，超出预算全文写 `<会话临时目录>/tool-results/<工具调用 id>.txt`）与显示窗口 `Display`（`exec/output`，待发超过 `DISPLAY_WINDOW` 256 KiB 时丢最旧的块并报 `skipped`），转发任务发完才回响应；连接断开（`Peer::closed`）或 `exec/kill` 停止命令。
- 命令环境 = `ToolIoConfig.command_env`（`CommandEnv`）：`ToolIoConfig::new` 用 Core 自己的环境（`CommandEnv::process`），运行时（`CoreConfig.command_env` 为 `None`）用登录 shell（`CommandEnv::login_shell`，首次命令时解析并缓存）；两者均经 `piarc_exec::env::command_environment`，只缓存准入的 OS、locale 与工具链字段。原环境中影响 shell 解析的变量只保留风险标志；生产审批拒绝请求附加环境（ADR-0035）。`ToolIoConfig` 不能带 `notices`（crate 私有类型），要发通知用 `ToolIo::with_notices`。
- blob 放在 `<数据目录>/sessions/<会话 id>/blobs/`；会话 id 只允许 `[A-Za-z0-9._-]`，不能是 `.`、`..`。
- Composer 的类型、数量、大小和搜索上限由 `composer::info()` 提供。附件只经 `store_attachment` 写入本会话的 `attachments/`，会话的工具 scope 将该目录登记为只读。PDF 在发布到附件目录前通过解析和页数校验。归档保留附件，删除会话清理整个会话目录（ADR-0030）。
- 沙箱（T39，ADR-0056，`tool_io/sandbox.rs`）：`sandbox_with(s, settings)` 由本次裁决已读的设置算出 `Effective`（`piarc_config::sandbox::resolve`、`SandboxConfig.enterprise`、平台与 `sandbox_health`），`for_call` 给 Bash/Monitor 调用 `CallSandbox`（`sandboxed`、`auto`、`unsandboxed`），`prepare` 把它写进阶梯输入（`sandbox_auto`、`unsandboxed`）、授权（`Grant.sandboxed`）与卡片（`sandbox`；沙箱外时 `protected_path` 为真，Core 拒绝仅本次以外的答复）。`claim_command`/`claim_monitor` 返回 `Claimed { pinned, sandboxed }`，`exec_run`、`exec_monitor`、`exec_terminal` 为沙箱命令调 `sandbox_launch`（按当时的设置生成配置、替换代理白名单）；前台命令结束后 `sandbox_report` 填结果的 `sandbox`（`file_denials` 加本条命令期间代理拒绝的主机）并写审计。会话代理在 `SessionState`（`SessionIo.sandbox`）里随第一条沙箱命令启动，`Gate` 实现 `ProxyHooks`（持 `Weak<SessionIo>`，不成环）：本会话允许的主机直接放行，其余经 `sandbox/network.rs` 发网络卡（`post_network_card`，没有 `peer`，回合结束与断连不撤卡，`SandboxConfig.approval_timeout` 到时拒绝），拒绝立即写 `kind: "sandbox"` 审计。`open_sandboxed_session` 是测试用的强制沙箱会话（`SessionState::forced`）。设置页的读写在 `sandbox/view.rs`（`sandbox_view`、`set_sandbox_settings`，只写用户层）。

## Auto 模式的审查（T46，设计增补 `docs/architecture/addenda/T46-auto-mode.md`）

- `policy/review.rs`：`evaluate_call` 的 `question` 在模式为 Auto 且 `piarc_policy::review::reviewable` 时走 `auto_review`：卡片先以 `review: reviewing` 入账（`policy/pending` 停住 Agent Host 的期限，`answer_approval` 对它答 `stale`，快照的 `pendingApprovals` 不计它），经 `Services.review` 的 `ReviewOutlet`（会话层 `sessions/hooks.rs` 的 `HubReviews` 按主会话 id 找到工作区 Agent Host 发 `policy/review`，`call_within` 时限为 `ReviewConfig.timeout` 加 5 s）取回答；`allow` 撤卡并放行一次（`step: "autoReview"`、`source: "reviewer"`，结果带 `review`），`deny` 撤卡并拒绝，`unsure` 与失败在同一条卡上 `revision + 1`、`review: fallback` 带原因交给用户（此时才触发 Notification hooks）。审查期间模式变了答复作废（`discarded`）。
- 每次送审一行 `kind: "autoReview"` 审计（`audit_review`：结局、结论、截断的理由、类别、耗时、token、`inputHash`、`promptId`、拒绝计数，子 agent 带 `agentId`），最终决定照旧一行 `permission`。T48 的 `PermissionDenied` 接在 `ToolIo::reviewer_refused`。
- 状态挂在主会话的 `State.auto`（`AutoState`：`Denials`、审查模型、最近一次不可用的原因、被设置关闭的标记），`State::publish` 把它作为 `SessionView.autoReview` 发出；子 agent 的计数与状态都用主会话的。用户在任何卡上允许（`question` 末尾）或再选 Auto 模式（`session_mode`）解除暂停。
- 可用性在 `modes.rs`：`auto_available` 读 `piarc_config::auto_mode`；`check_mode` 拒绝未启用的 `auto`；`check_auto_mode` 在每次裁决前把设置已关闭 Auto 的会话切回手动并写 `autoModeOff` 审计。会话登记时 `SessionIo.remotes` 经 `piarc_git::remotes` 读一次 git remote。
- 单测：`cargo test -p piarc-core --lib tool_io::policy::tests::t46`（替身审查通道 `Reviewer`；夹具 `Peer::channel(4)` 不读帧，卡片多的用例要像 `Fixture::auto` 那样把帧读掉，否则第五个 `policy/pending` 就阻塞）。

## Memory 与 rules（T22、T24）

- Memory 由 `tool_io/memory.rs` 组装快照，文件发现和导入在 `memory_reader.rs`。外部导入经同一会话的审批账本，由 `policy/memory.rs` 按工作区及规范目标匹配。见 ADR-0033。
- Claude Code rules（T24，ADR-0038）：`memory_reader/rules.rs` 选出 `~/.claude/rules/` 与工作区根 `.claude/rules/` 中要载入的文件（排在各自的 `.claude/CLAUDE.md` 之后），无条件的总是载入，带 `paths:` 的在 `fs/memory` 的 `files` 有匹配文件或 `rules` 点名时载入；快照的 `inactiveRules` 告诉 Agent Host 还有没载入的条件 rules。frontmatter 只用于选择，送达的正文不含它。

## 自动记忆（T47）

- `tool_io/auto_memory.rs` 应答 `memory/status`、`memory/apply`：`policy::claim` 消费同一 `Memory` 调用的授权，未信任项目与子会话拒绝写入，读取的笔记记进会话以便压缩后恢复；每次存、删写一行 `kind: "memory"` 审计（名称、类型、字节数、哈希，不含正文）。`memory.rs` 的 `fs/memory` 快照在开关打开时把 `auto_memory::Store::injected` 的索引作为最后一个文件，托管的 `CLAUDE.md` 排在最前。设置与信任取 `SessionIo.project()`，记忆目录按主 checkout。

## 上下文工程（T27，ADR-0043）

- `tool_io/context.rs` 应答能力 `context` 的三个请求：`context/settings`（`TrustService::permission_settings` 合并的 `/autoCompactEnabled`、`/autoCompactWindow`，窗口夹在 100,000–1,000,000；没有设置服务时返回缺省值）、`fs/changes`（`FileStates::external_changes`：元数据与记录不同才算哈希，同一版本只报告一次，快照不变，所以先读后改照常拦住）、`fs/forgetReads`（`FileStates::forget_read_ranges`，I72）。`fs/read` 带 `restore: true` 且不带 `origin` 时，`policy/grants.rs` 只放行会话文件状态表里、无需审批即可读取的文件（压缩后重注入最近文件）。
- `Op::Compact(Option<String>)` 把 `/compact <重点>` 作为 `session/compact` 的 `instructions` 转给 Agent Host；`Op::ContextUsage` 是 `session/getContextUsage`（NAPI `contextUsage`）。`session/usage` 与其他会话通知一样原样转发给客户端。

## 检查点、回退与 Changes（T28，ADR-0044）

- `checkpoints.rs` 的 `Checkpoints`（对象库 + `piarc-store` 索引 + 保留策略，时钟 `CheckpointConfig.now_ms` 可注入）由运行时打开并启动后台清理（启动后与每 6 小时）；`tool_io/checkpoints.rs` 是文件侧：`turn_started` 建检查点、`fs/write` 记写入（AHP `turnId`，缺省用会话当前回合）、回退预览与执行、撤销、Changes 与按文件 / hunk 丢弃，全部经 `piarc_fs::replace` 在路径锁内核对后写回。设置 `fileCheckpointingEnabled: false`（合并层，`checkpoints_for`）时不建检查点、不存快照。
- 会话侧 `Op::Checkpoint(CheckpointOp)`（`sessions/session/rewind.rs`）：回退与分支切换要求会话空闲且没有在途的 prompt、steer、follow-up（否则 `SessionBusy`），进行期间这些输入同样返回 `SessionBusy`（`OpKind`，R3）；先恢复代码再移动对话（AHP `session/rewind`、`session/switchBranch`，`session_call_within` 等待至多 10 分钟，摘要要调用模型），之后清空会话的文件状态表并在会话路由发 `session/branchChanged`。`fork_session` 的 `ForkPoint::BeforeTurn` 是"从这里分支"；删除会话时一并删除它的检查点记录。
- 单测：`cargo test -p piarc-core --lib tool_io::checkpoints`（A01、A05、A06、A09、A10）与 `--lib tool_io::policy::tests::t28`（设置开关）。

## WebFetch（T29，ADR-0045）

- `tool_io/web.rs` 应答 `web/fetch`：`policy::claim_fetch` 消费同一调用、同一 URL 的 grant（一次批准一次抓取），`piarc_web::Fetcher` 在第一次使用时建（系统信任库），抓取登记在会话的 `running`（键 `web:<调用 id>`），回合中断与连接断开都停止它；每次写 `kind: "webFetch"` 审计。限值与允许列表在 `CoreConfig.web`（`WebConfig`），`createForTests` 读 `PIARC_TEST_WEB_ALLOWLIST`，L2 为有 `web` 段的场景放行 `127.0.0.1`、`localhost`。`assess.rs`、`policy/hooks.rs` 取 WebFetch 主机一律用 `piarc_web::rule_host`。

## WebSearch（T38，ADR-0055）

- `tool_io/web_search.rs`：`web/searchBackend`（不带会话，入站处理者与 `exec/shells` 一样放行）读用户 `settings.json` 的 `webSearch.backend` 与保险箱 `websearch/<后端>` 是否有 key；`web/search` 经 `policy::claim_search` 消费同一调用、同一 `query` 的授权，key 只从保险箱读（`SecretsService::value_of`），请求经 `piarc_web::search::search`（WebFetch 的 `Fetcher`、`Reach::Configured`；端点可由 `CoreConfig.web.search_endpoints` 换成测试服务），登记在会话的 `running`（键 `search:<调用 id>`），写 `kind: "webSearch"` 审计（查询、后端、结果数，不含 key）。设置窗口的读写在 `sessions/web_search.rs`（`Hub::web_search_settings`、`set_web_search_backend`、`set_web_search_key`）。

## Hooks（T25，ADR-0039）

- `hooks/mod.rs` 的 `HooksService` 用 `TrustService::permission_settings` 读 hooks（未信任项目的不生效），`plan`/`execute` 经 `ProcessTreeSpawner` 运行（命令环境首次要解析登录 shell，只在 `plan` 选出 handler 后解析：`ToolIo::run_hooks`、裁决第 2、8 步，`execute` 显式接收它；否则没有 hooks 的输入也要等登录 shell）、写审计（`kind: "hook"`）、发 `core/notices`（`type: "hook"`）、长文本落到 `<会话 tmp>/hooks/`，时长取 `CoreConfig.hooks`。`tool_io/hooks.rs` 应答 `hooks/run`（入站处理者只查 `cwd` 在本工作区内，已关闭会话的 SessionEnd 也能运行）、`user_prompt_submit`（阻断为 `permissionDenied`、`hookBlocked`）与 `notification_hooks`；hook 令牌登记在会话的 `running`，中断与关闭结束其进程树。
- 顺序（T30，ADR-0046）：`hooks_run` 收到 SessionStart（非 `compact`）时先 `HooksService::starting` 登记再运行，`user_prompt_submit` 先 `started` 等登记清零：Agent Host 打开会话时先写出这个 `hooks/run` 再应答，所以登记总在该会话的提示之前。不要在登记之前加 `await`。L2 `hooks-session-start-order` 用慢的 SessionStart hook 锁定它。
- `tool_io/hooks_tests.rs` 用真实 Core（命令环境固定 `PATH`，否则 cargo 的 `DYLD_*` 关掉规则 allow）；Bash 规则 allow 不覆盖文件写入，测会话规则用 `sed -n` 而不是 `touch`。T38 的用例在 `hooks_m3_tests.rs`（`hooks_tests` 的子模块，共用 fixture）。
- T38（ADR-0055）：`HooksService::execute` 给 `Runner` 装上 `http` 端口（`WebPort`，第一次用时建 `Fetcher`）与 `prompt` 端口（`SessionJudge` → `HookOutlet`：`sessions/hooks.rs` 的 `Hub::connect_hooks` 在运行时启动时接上，按主会话 id 找到工作区的 Agent Host 发 `hooks/prompt`）；`Plan` 带上本次设置的 `allowedHttpHookUrls`、`httpHookAllowedEnvVars` 与用户层的 `hookAllowedEnvVars`，变量值取 `Launch.expansion`（登录 shell 环境）。`Facts` 有 `main_session_id` 与 `agent`（子会话从 `Link` 取）：输入的 `session_id`、`transcript_path`、`prompt_id` 用主会话的，子会话另加 `agent_id`、`agent_type`；`new_prompt` 在每次 UserPromptSubmit 生成 `prompt_id`；`effort` 只留在工具类事件、Stop、SubagentStop、PostToolBatch（`policy/evaluate` 的 `effort` 经 `tool_request` 进输入）。`hooks_run` 接受 `subagentStart`、`subagentStop`（subject 为 agent 类型）、`postToolBatch`（`host_request` 组装请求）。
- 项目 hook 的权限更新（I122）：`policy/hooks.rs` 的 `apply_permissions` 看 `RequestAnswer.updated_by`，来源是项目设置层或项目内的 skill、子 agent 定义时，`setMode` 只经 `session_mode` 改本会话，写进 `.piarc/` 的 allow 规则不 `confirm_items`。

## M4 hooks（T41，ADR-0059）

- `tool_io/hooks_m4.rs`：CwdChanged（`exec_run` 结束后 shell 目录变了）、FileChanged（会话的 `WatchSlot`，`watchPaths` 整体替换并带替换序号，上限 `MAX_WATCH_PATHS`，每 `FILE_POLL` 轮询一次文件的存在、大小与修改时间；不要换回 FSEvents：负载下它的流启动会阻塞几十秒）、ConfigChange（`check_config` 把设置文件与 `SessionIo.config_seen` 比对：会话登记时取基线，`sessions/session.rs` 的 `Request::run` 在每个输入前调用，`sessions/workspace.rs` 的 `config_change_hooks` 在设置监听看到变化时调用；阻断时 `SessionIo.config_pins` 记该层旧值，`ToolIo::apply_pins` 在权限裁决（`policy.rs` 的 `session_settings`）与 hooks 规划（`run_hooks` → `HooksService::plan_adjusted`）里施加；`policy_settings` 不可阻断）。UserPromptExpansion 在 `hooks.rs` 的 `user_prompt_expansion`，由 `skills.rs` 的 `expand_command` 在登记 `allowed-tools` 与 hooks 之前调用；InstructionsLoaded、StopFailure、MCP prompt 的 UserPromptExpansion 经 `hooks/run`（`host_event` 的白名单字段）。
- `mcp_tool`：`hooks/mod.rs` 的 `SessionMcp` 端口 → `sessions/hooks.rs` 的 `HookOutlet::mcp_tool` → AHP `hooks/mcpTool`，保留远端错误的结构化类型。`timeout` 和 Core 本地超时均按同一时限写通知和审计，其余远端错误显示原消息。
- 单测：`cargo test -p piarc-core --lib tool_io::hooks::tests::m4`；L2 `hooks-m4-*`。

## 文件根与设置来源（T35，ADR-0052）

- `SessionIo.scope` 的根是会话能读写的文件根，`SessionIo.project` 是设置、规则、信任、审计、模式记忆、memory 设置与 hooks 的来源。普通会话两者相同（`open_session`）；worktree 会话与带 worktree 的子 agent 文件根是 worktree、`project` 是主工作区（`open_session_in`、`open_linked`）。读设置、写"总是允许"规则、写审计、算任务的工作区一律用 `project()`；路径边界、受保护路径、规则里的相对路径、cwd 回退用 `scope.root()`。新增读设置的入口时按这条分。
- `git_runner(workspace)`：worktree 的 git 用命令环境与进程树启动器，git 程序从该 `PATH` 中工作区以外的目录找。
- `gh_runner(workspace)`（G5）：用户的 `gh`（同样从 `PATH` 中工作区以外的目录找，没有时为 `None`）与登录环境的 `GH_HOST`，环境由 `piarc_git::env::gh_env` 生成。`ToolIoConfig.gh_program`（`CoreConfig.gh_program`）只给测试：开发构建的 `createForTests` 由 `PIARC_TEST_GH` 设置，测试从不运行本机的 `gh`。

## 子 agent（T31，ADR-0048）

- `tool_io/subagents.rs`：`agents/list`（`piarc_config::agents::load` 加信任、deny 与上限、合并后的 `modelAliases`）、`subagent/start`（`open_linked`：子会话自己的 `SessionIo`，工作区根与 cwd 同父会话，`Link` 指向主会话；登记定义的 hooks；返回生效模式与警告）、`subagent/finish`（注销、写索引）。经 `Link`：`effective_mode` 取定义与主会话当前模式中更严的一个（每次裁决重新取），`rule_owner` 让"本会话允许"存进主会话，`origin` 给审批卡标来源（快照里并入主会话的条目），`checkpoint_owner` 让写入记在主会话当前回合下，`attached` 列出主会话中断时要一起撤下审批、结束命令的前台子会话（后台的不在内）。
- `isolation: worktree`（T35）：`start_subagent` 经 `child_place` 先建 `.piarc/worktrees/agent-<id>/`（基础为父会话文件根的 HEAD）、以它为子会话文件根并在结果里答 `cwd` 与 `worktree`；`finish_request` 与连接结束都经 `settle_worktree`：无改动且 HEAD 未动时删除 worktree 与分支，否则保留并在 `SubagentFinishResult.worktree` 给出。登记失败时同样清理。
- 子会话的 `policy/evaluate` 声明的 `parentSessionId`、`agentType` 必须与 `Link` 一致（`prepare_call`），否则拒绝。参数规则（`Agent(model:…)` 等，I82）在阶梯输入组装之后由 `assess::param_rules` 施加。
- 定义的 hooks 经 `HooksService::scope_hooks` 以 `subagent` 层登记在子会话 id 下，`unscope_hooks` 撤下；项目级定义要求项目受信任（否则 `hooksUntrusted` 警告）。
- 设置的默认模型与 effort（`model`、`effortLevel`，I113）由 `context.rs` 的 `session_defaults` 给新会话，`model` 的别名经 `ModelAlias::target` 用合并表解析。
- 单测：`cargo test -p piarc-core --lib tool_io::policy::tests::t31`（审批来源与会话规则、模式收紧、中断、定义列表、定义 hooks、参数规则）与 `--lib tool_io::checkpoints`（子 agent 写入归属）。

## Skills、斜杠命令与输出风格（T37，ADR-0054）

- `tool_io/skills.rs`：`resource_catalog`（`piarc_config::skills::load` 在阻塞线程池上，加 `skillOverrides`、`Skill`/`Skill(名称)` deny 与未信任项目的警告）、`skills_view`（合并命令、风格与当前风格）、`skills_request` 应答 `skills/list`（带会话 id 时把该会话可见 skill 的目录记进 `SessionIo.skill_dirs`，`policy::prepare` 把它们作为只读目录交给 Read、Glob、Grep 的裁决）、`skills/invoke`（`policy::claim_skill` 消费同一 `Skill` 调用的授权，`disable-model-invocation` 的拒绝，替换参数，`activate`）、`skills/match`（会话碰过的文件经 `scope.locate` 规范化后相对文件根用 `rules::PathMatcher` 匹配）。设置与信任取 `SessionIo.project()`，发现从 `scope.cwd()` 起。
- `activate`：项目来源且项目未受信任时只回 `untrusted` 警告；否则把 `allowed-tools`（替换变量后）经 `State::grant_turn_rules` 登记在调用所在会话，并经 `HooksService::scope_skill_hooks` 以层 `skill` 登记 hooks（同一 skill 一次，会话关闭时 `close_session` 撤下）。
- `expand_command(session, text)`：`/名称 参数` 是命令文件或可由用户调用的 skill 时返回展开后的正文、`PromptCommand` 与回合授权的 id；内置命令、MCP prompts 与不认识的名字返回 `None`。`user_prompt_expansion` 是 T41 的 UserPromptExpansion 挂载点（T37 原样返回）。调用方是会话层的 `Request::run`（`sessions/session.rs`）：先展开、再以原文跑 UserPromptSubmit；被 hook 阻断、请求失败或答 `queued` 时 `revoke_turn_grant`。
- 单测：`cargo test -p piarc-core --lib tool_io::policy::tests::t37`（回合级免审批、deny 与 ask 优先、下一回合恢复询问、未信任项目、skill hooks、skill 目录只读放行、deny 与 user-only、`paths` 匹配）。

## 后台任务的裁决（T32）

- Monitor 走 `assess::bash_call`，`BashFacts.tool` 为 `Monitor`（`piarc-policy` 用它查规则：`Bash(…)` 覆盖 Monitor，`Monitor(…)` 只管 Monitor），之后去掉只读白名单与 Accept edits 的放行（`allow` 为空时 `allowed = false`）。KillShell 在 `other_call` 里与宿主工具一样是只读。

## 易错点

- 当前用户无权访问的 PATH 条目（Windows 的 PATH 常有 `C:\Windows\system32\config\systemprofile\…`）不取消自动允许（W1）：macOS 的 `tool_io/exec/utility.rs` `first_on_path` 跳过工作区外的这类条目，其余无法检查的条目和工作区内的条目一律改为询问；Windows 由 Git Bash 解析（`probe_git_programs`），bash 自己跳过它们。
