# piarc-hooks

hooks 的通用部分（架构第 6.3 节，ADR-0039）：配置解析与合并（`HookConfig`）、matcher、`command` 执行器（`Runner`）、单个 handler 的读法（`Outcome`）与按事件的合并（`Decision`）、长输出落盘（`spill`）、Stop 续跑上限与审计记录。不读设置文件、不判断信任（`piarc-config`，Core 经 `TrustService::permission_settings` 读取）；不匹配 `if` 规则（Core 用 `piarc-policy` 实现后注入）；不决定事件何时发生、怎样应用结果（`piarc-core::hooks` 与 `tool_io::hooks`、Agent Host 的 `harness/hooks.ts`）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-hooks` | 单元测试：配置与去重、matcher、退出码与 JSON、逐事件合并、落盘；`runner_tests.rs`（Unix）用 tokio 子进程替身测并行、stdin、超时、取消、两个管道各 2 MB |
| `cargo test -p piarc-core --lib tool_io::hooks` | 经真实 Core 的端到端：裁决第 2、8 步、`hooks/run`、信任、审计与落盘、并行与去重、超时与中断后进程树结束（`ProcessTreeSpawner`，macOS 与 Windows） |
| `cargo test -p piarc-testkit --test scenarios -- hooks-` | L2：11 个事件的 `tests/scenarios/hooks-*.yaml`，夹具 `fixtures/hooks/hook.mjs.txt` 记录 stdin |

## 事件与挂载点

| 事件 | 谁观察 | 挂载点 |
|---|---|---|
| UserPromptSubmit | Core | 会话请求发给 Agent Host 之前（`sessions/session.rs`） |
| PreToolUse / PermissionRequest | Core | 裁决第 2、8 步（`tool_io/policy/hooks.rs`），运行前发 `policy/pending` |
| Notification | Core | 新审批卡 `permission_prompt`、回合结束 `idle_prompt` |
| SessionStart、SessionEnd、PostToolUse、PostToolUseFailure、Stop、PreCompact、PostCompact | Agent Host | Pi 事件 → AHP `hooks/run`（`tool_io/hooks.rs` 应答，只接受这 7 个，按白名单取字段） |

## 合并规则（`decision.rs` 文件头是全文）

- exit 0：stdout 恰为一个 JSON 对象才按字段读，`hookSpecificOutput.hookEventName` 必须等于本事件；`{…}` 形状但非法是错误；其余是纯文本（SessionStart、UserPromptSubmit 作上下文，PreCompact 作摘要指令）。
- exit 2 按 `HookEvent::exit_two`：阻断、给模型、给用户、忽略；同时读 stdout 的 JSON，其中的理由优先于 stderr。其他退出码、超时、无法启动：非阻断错误，`onFailure: "block"` 时在可阻断事件上阻断。
- PreToolUse：deny > ask > allow，`defer` 按 ask；`updatedInput` 取获胜决定的第一个，没有决定的 handler 的输入只在无人决定时生效。PermissionRequest：deny 优先，allow 的权限更新合并。
- `systemMessage`、`continue: false` 只对 `HookEvent::uses_common_fields` 为真的事件生效；Stop 的 `continue: false` 覆盖 block。
- 同一 handler（命令、参数、shell、`if` 相同）跨文件只运行一次，保留优先级最高的那份；顺序为设置层高到低。

## 上限与常量

- `STOP_CONTINUATION_LIMIT` = 8（Core 在 `hooks/run` 里执行，Agent Host 只计数）；`Timeouts::default()`：600 s、UserPromptSubmit 30 s、SessionEnd 1.5 s（自定上限 60 s）；`RunnerConfig`：终止宽限 2 s、每个管道保留 4 MiB。Core 经 `CoreConfig.hooks` 注入（测试缩短）。
- `spill::LIMIT` 10,000 字符、`PREVIEW` 2,000；PreCompact 的指令用 `spill::cut` 截断，不落盘。

## 不运行的配置（`DiagnosticKind`，进入配置诊断）

后续里程碑的事件（`LATER_EVENTS` 带任务号）、`http`/`prompt`（T38）、`mcp_tool`（T41）、`agent`、`async`/`asyncRewake`、非工具事件上的 `if`、正则不支持的 matcher（环视、反向引用）；`once` 只是忽略。

## ProcessSpawner 注入

- `Runner::new(spawner, launcher, config)`：进程经 `piarc_ports::ProcessSpawner` 启动，程序由 `Launcher::spec` 决定（Core 的 `hooks/launcher.rs`：macOS `/bin/sh -c`，Windows Git Bash 或 PowerShell，`args` 为 exec 形式，环境加 `CLAUDE_PROJECT_DIR`）。本 crate 不依赖 `piarc-exec`（第 7.1 节），dev-dependency 也不行：单元测试用 `runner_tests.rs` 里的 tokio 替身，进程树的验证在 `piarc-core`。
- 停止 = `terminate` → 宽限 → `kill`；进程退出后丢弃句柄（`ProcessTreeSpawner` 由此结束遗留的子孙进程），之后再读完管道（`EXIT_GRACE` 100 ms）。

## 易错点

- `serde_json` 没开 `preserve_order`：同一层的事件按名字排序解析，诊断顺序随之确定，测试按此断言。
- 错误文字的形状 `"<Event> hook error: <what>: <stderr 首行>"` 被 Core 去掉前缀后送到客户端提示行（客户端自己加本地化的标签）；改形状时同步 `piarc-core::hooks::HooksService::notify`。
