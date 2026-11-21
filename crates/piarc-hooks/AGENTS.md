# piarc-hooks

hooks 的通用部分（架构第 6.3 节，ADR-0039、ADR-0055）：配置解析与合并（`HookConfig`）、matcher、三种 handler 的执行器（`Runner`：`command` 经注入的进程启动，`http` 经 `HttpPort`，`prompt` 经 `JudgePort`）、单个 handler 的读法（`Outcome`）与按事件的合并（`Decision`）、`http` 的 URL 白名单与头部插值（`HttpRules`）、`prompt` 的输入填充与判定翻译（`prompt::fill`、`verdict`）、长输出落盘（`spill`）、Stop 续跑上限与审计记录（`audit_detail`）。不读设置文件、不判断信任（`piarc-config`，Core 经 `TrustService::permission_settings` 读取）；不匹配 `if` 规则（Core 用 `piarc-policy` 实现后注入）；不决定事件何时发生、怎样应用结果（`piarc-core::hooks` 与 `tool_io::hooks`、Agent Host 的 `harness/hooks.ts`）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-hooks` | 单元测试：配置与去重、matcher、退出码与 JSON、逐事件合并、落盘、`http` 白名单与插值、`prompt` 的填充与翻译；`runner_tests.rs`（Unix）用 tokio 子进程替身测并行、stdin、超时、取消、两个管道各 2 MB；`runner_remote_tests.rs` 用替身端口测 `http`、`prompt` 的白名单、超时、取消、缺端口与审计细节 |
| `cargo test -p piarc-core --lib tool_io::hooks::tests::m3` | T38 经真实 Core：本地 HTTP 服务上的 `http` hook（决策、只插值白名单变量、URL 白名单、非 2xx、超时、连接失败、纯文本）、替身 outlet 上的 `prompt` hook（阻断理由、`continueOnBlock`、超时与无法解析、审计的模型与 token）、未信任项目、`prompt_id` 与 `effort`、项目 hook 的权限更新不越出信任 |
| `cargo test -p piarc-core --lib tool_io::hooks` | 经真实 Core 的端到端：裁决第 2、8 步、`hooks/run`、信任、审计与落盘、并行与去重、超时与中断后进程树结束（`ProcessTreeSpawner`，macOS 与 Windows） |
| `cargo test -p piarc-testkit --test scenarios -- hooks-` | L2：14 个事件的 `tests/scenarios/hooks-*.yaml`（T38 的 `hooks-m3-subagent`、`hooks-m3-post-tool-batch`、`hooks-m3-prompt`），夹具 `fixtures/hooks/hook.mjs.txt` 记录 stdin |

## 事件与挂载点

| 事件 | 谁观察 | 挂载点 |
|---|---|---|
| UserPromptSubmit | Core | 会话请求发给 Agent Host 之前（`sessions/session.rs`） |
| PreToolUse / PermissionRequest | Core | 裁决第 2、8 步（`tool_io/policy/hooks.rs`），运行前发 `policy/pending` |
| Notification | Core | 新审批卡 `permission_prompt`、回合结束 `idle_prompt` |
| SessionStart、SessionEnd、PostToolUse、PostToolUseFailure、Stop、PreCompact、PostCompact | Agent Host | Pi 事件 → AHP `hooks/run`（`tool_io/hooks.rs` 应答，只接受这些与下面三个，按白名单取字段） |
| SubagentStart（T38） | Agent Host | 子会话首次 `prompt` 之前（`ChildSession.run`）；matcher 是 Core 按 `Link` 取的 agent 类型 |
| SubagentStop（T38） | Agent Host | 子会话的 `agent_before_settle`（取代 Stop）；续跑计数同 Stop |
| PostToolBatch（T38） | Agent Host | Pi `turn_end`（有工具结果、正常完成）；block 让 Agent Host 中止本次运行 |

## 合并规则（`decision.rs` 文件头是全文）

- exit 0：stdout 恰为一个 JSON 对象才按字段读，`hookSpecificOutput.hookEventName` 必须等于本事件；`{…}` 形状但非法是错误；其余是纯文本（SessionStart、UserPromptSubmit 作上下文，PreCompact 作摘要指令）。
- exit 2 按 `HookEvent::exit_two`：阻断、给模型、给用户、忽略；同时读 stdout 的 JSON，其中的理由优先于 stderr。其他退出码、超时、无法启动：非阻断错误，`onFailure: "block"` 时在可阻断事件上阻断。
- PreToolUse：deny > ask > allow，`defer` 按 ask；`updatedInput` 取获胜决定的第一个，没有决定的 handler 的输入只在无人决定时生效。PermissionRequest：deny 优先，allow 的权限更新合并。
- `systemMessage`、`continue: false` 只对 `HookEvent::uses_common_fields` 为真的事件生效；Stop 的 `continue: false` 覆盖 block。
- 工具事件上 matcher 为 `Bash` 的 handler 也选中 Monitor 调用（T32，同 Claude Code；`HookConfig::select`），输入里的 `tool_name` 仍是 `Monitor`。
- 同一 handler（命令、参数、shell、`if` 相同）跨文件只运行一次，保留优先级最高的那份；顺序为设置层高到低。

## handler 类型（T38，ADR-0055）

- `Handler.action` 是 `Action::{Command, Http, Prompt}`；`Handler::kind()` 给 `HandlerKind`。事件收不收某类由 `HookEvent::supports` 决定（Claude Code 的表：SessionStart 只收 command；SessionEnd、Notification、PreCompact、PostCompact、SubagentStart 收 command 与 http；其余三种都收），不收的写 `UnsupportedType` 诊断。
- `Runner::with_http(port, HttpRules)`、`with_judge(port)` 由 Core 每次执行时装上；没装就是 `NotStarted`。远端 handler 的结果是 `RunStatus::Replied`（命令会打印的 JSON，空表示无输出）或 `RunStatus::Failed`（非阻断错误），之后与命令走同一个 `Outcome::read`、`Decision::merge`。
- `http`：`HttpRules.allowed_urls` 是 `allowedHttpHookUrls`（`None` 不限制；`*` 通配，scheme 与主机不分大小写，主机末尾点忽略），不匹配就不发请求；头部的 `$VAR`、`${VAR}` 只在 handler 的 `allowedEnvVars` 与（设置时的）`httpHookAllowedEnvVars` 都列出时取 `HttpRules.env` 的值，否则为空串；回答：2xx 空体无输出、2xx JSON 对象按输出协议读，其他都是非阻断错误。
- `prompt`：`prompt::fill` 把 `$ARGUMENTS` 换成输入 JSON（`\$` 转义，没有占位时接在末尾），`verdict` 把 `{ok, reason, impossible}` 译成该事件的输出 JSON（表在 `prompt.rs` 文件头）。默认超时 30 s（`Timeouts::prompt`）。
- 审计（`audit.rs`）按类型记：命令的程序名与 SHA-256；`http` 的 origin、URL 的 SHA-256 与状态码；`prompt` 的提示 SHA-256、模型与 token。不记 URL 路径、查询与头。
- `RequestAnswer.updated_by`：给出 `updatedPermissions` 的 handler 来源，Core 据此不让项目 hook 的权限更新越出信任（I122）。

## 上限与常量

- `STOP_CONTINUATION_LIMIT` = 8（Stop 与 SubagentStop 共用，Core 在 `hooks/run` 里执行，Agent Host 只计数）；`Timeouts::default()`：600 s、UserPromptSubmit 30 s、SessionEnd 1.5 s（自定上限 60 s）、`prompt` handler 30 s；`RunnerConfig`：终止宽限 2 s、每个管道保留 4 MiB。Core 经 `CoreConfig.hooks` 注入（测试缩短）。
- `spill::LIMIT` 10,000 字符、`PREVIEW` 2,000；PreCompact 的指令用 `spill::cut` 截断，不落盘。

## 不运行的配置（`DiagnosticKind`，进入配置诊断）

后续里程碑的事件（`LATER_EVENTS` 带任务号）、事件不收的 handler 类型、`mcp_tool`（T41）、`agent`、`async`/`asyncRewake`、非工具事件上的 `if`、正则不支持的 matcher（环视、反向引用）；`once` 只是忽略。公开解析函数的错误是 `piarc_hooks::Error`（`error.rs`，I128）。

## ProcessSpawner 注入

- `Runner::new(spawner, launcher, config)`：进程经 `piarc_ports::ProcessSpawner` 启动，程序由 `Launcher::spec` 决定（Core 的 `hooks/launcher.rs`：macOS `/bin/sh -c`，Windows Git Bash 或 PowerShell，`args` 为 exec 形式，环境加 `CLAUDE_PROJECT_DIR`）。本 crate 不依赖 `piarc-exec`（第 7.1 节），dev-dependency 也不行：单元测试用 `runner_tests.rs` 里的 tokio 替身，进程树的验证在 `piarc-core`。
- 停止 = `terminate` → 宽限 → `kill`；进程退出后丢弃句柄（`ProcessTreeSpawner` 由此结束遗留的子孙进程），之后再读完管道（`EXIT_GRACE` 100 ms）。

## 易错点

- `serde_json` 没开 `preserve_order`：同一层的事件按名字排序解析，诊断顺序随之确定，测试按此断言。
- 错误文字的形状 `"<Event> hook error: <what>: <stderr 首行>"` 被 Core 去掉前缀后送到客户端提示行（客户端自己加本地化的标签）；改形状时同步 `piarc-core::hooks::HooksService::notify`。
