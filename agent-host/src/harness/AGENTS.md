# agent-host · harness

Harness Kit：PiArc 写的 Pi 扩展（system prompt 与 memory、权限预检、hooks、宿主工具、提醒与压缩、工具批次与中断补齐、结果预算）。不导入 `fs`、`child_process`，I/O 只经 `CoreIo`。命令、进程边界与全局不变量见上级 [`agent-host/AGENTS.md`](../../AGENTS.md)。

## System prompt 与 memory（T22，ADR-0033）

- `runtime/session-registry.ts` 给每个分支创建 `SessionMemory`，在 `before_agent_start` 挂载七段。英文提示词与默认工具指引在 `src/harness/prompts/`，修改后必须运行 `node scripts/dev/check-prompt-originality.mjs` 并更新 [原创性记录](../docs/engineering/prompt-originality.md)。
- `noContextFiles: true` 保留。Core 先加载用户文件，再从根到 cwd 逐级加载；`fs/memory` 返回标明来源的快照。成功的 Read、Write、Edit 和 Glob/Grep 的查询及命中目录触发子目录加载。每次回合从分支记录恢复开场 system，文件变化、子目录文件与跨日日期以 `memoryLazyLoad` 提醒送达（T27 起经 `reminders.ts`，版本摘要在提醒的 `details` 里；分支里旧的 `piarc.memory` 条目仍按原格式回放）。Anthropic 的分段缓存与消息块转换在 `memory-wire.ts`。
- 条件 rules（T24，ADR-0038）：Core 上次快照带 `inactiveRules` 时，Read、Write、Edit 成功后即使目录已访问过，也带上该文件（`files`）再请求一次快照；快照里带 `paths` 的文件是条件 rules，首次出现时以 `rulesMatched` 提醒送达并写入分支条目 `piarc.memoryRules`，之后每次请求都在 `rules` 中带上它们（每会话一次，恢复与分叉沿用分支）。

## 权限预检与历史

- `src/harness/policy.ts` 使用 Pi 1.5.2 的 `tool_call`。Pi 校验工具参数后调用处理器。处理器把规范工具名、会话、工具调用 id 和参数发给 Core，文件路径与工具执行使用同一套解析规则。只有结构正确的 `allowed: true` 放行。
- 参数超过 8 MiB 帧预算时，Host 用 `policy/inputChunk` 逐块送给 Core，再带 `stagedInputBytes` 裁决。Write 分块传原始 content，沿用文件工具的 UTF-16 分片边界，避免 JSON 转义缩小 64 MiB 的文件上限。Core 校验会话、连接、调用、工具、UTF-8 偏移与总长度，重组后的参数同时用于预览与裁决。
- Core 要询问时发送 `policy/pending`。过期通知让 Host 用 `policy/cancel` 撤下旧请求。拒绝反馈通过 Pi 的 `{block:true,reason}` 进入模型下一次请求，实时投影用 `markDeclined`，历史从 `piarc.toolDeclined` 条目恢复状态。
- `session/setPermissionMode` 写入所选分支的 `piarc.permissionMode` 条目，实时与历史都投影为 `permissionModeChanged`。会话打开结果的可选 `permissionMode` 传回该分支最后的显式选择，起始模式的配置优先级由 Core 解析。
- 每次运行前（`before_agent_start`）把当前工具的规范名经 `policy/tools` 交给 Core，Core 返回被不带 specifier 的 deny 规则覆盖的工具，`nextActiveTools` 用 `setActiveTools` 移除它们，规则撤销后恢复；请求失败时保持原列表（每次调用仍经 `policy/evaluate`，ADR-0037）。
- Host 重连恢复时，最后一个模型回复中尚无结果的调用经 `policy/recover` 查询审批失效原因。只给失效调用写入拒绝结果，其余缺失结果按 ADR-0026 补齐。`cargo test -p piarc-testkit --test sessions permissions::` 覆盖真实进程终止、恢复后的模型请求、审批快照与模式历史。

## Hooks（T25，ADR-0039）

- `harness/hooks.ts` 的 `SessionHooks`（Core 启用 `hooks` 能力时每会话一个，排在结果预算之后）把 Pi 的 `session_start`、`session_shutdown`、`tool_result`、`agent_before_settle` 经 `hooks/run` 交给 Core（不在本进程执行命令，失败照常进行）；PreCompact、PostCompact 由 `compaction.ts` 调 `preCompact`、`postCompact`。hook 加的上下文（`additionalContext`、纯文本 stdout）是 `hookContext` 提醒（T27，正文 "Context from a <事件> hook:"），PostToolUse 的替换输出与 `decision: block` 的反馈仍在工具结果里（反馈首行 `[PiArc hook context]`）；Stop 的续跑理由以同格式的 `piarc.reminder` 草稿条目送达。SessionStart 不阻塞会话打开，首个 `before_agent_start` 等它。
- `preflight` 的 `updatedInput` 原地替换 `event.input`，`context`、`stop` 记在 `SessionHooks.notes` 到 `tool_result` 处理；Core 在 hooks 前发 `policy/pending` 停住期限，不要去掉 `policy/evaluate` 的期限。`hooks/run` 无期限，超帧输入由 `fitFrame` 截断（否则 Core 丢帧、回合永远等）。PreCompact 的指令并入 PiArc 自己的摘要请求（`compaction.ts`）。

## 宿主工具（T26，ADR-0042）

- `harness/session-harness.ts` 按 Core 启用的能力（`planMode`、`todo`、`ask`）注册 `EnterPlanMode`、`ExitPlanMode`（`plan-mode.ts`）、`TodoWrite`（`todos.ts`）、`AskUserQuestion`（`questions.ts`，经 `ui/ask`）与 `SuggestNextSteps`（`next-steps.ts`），排在 Core 工具之后；描述在 `tools/profile.ts`，工具指引与提醒文案在 `harness/prompts/`（改后跑原创性检查）。
- 模式切换只走 `PlanMode.record`：模式菜单（`session/setPermissionMode`）与 `policy/evaluate` 结果的 `mode`（EnterPlanMode、批准的计划，在调用执行前）都写 `piarc.permissionMode` 并投影；进出 plan 时排队 `mode` 提醒，模型自己调用的工具结果就是告知（`acknowledge` 撤回提醒）。
- `reminders.ts` 是提醒的唯一通道：`piarc.reminder` 自定义消息在 `before_agent_start` 与带工具结果的 `turn_end` 送达（`memory-wire.ts` 在 Anthropic 线格式上合并），T27 的扩展见下节。任务清单提醒的阈值 `TODO_REMINDER_ROUNDS` = 8（`todos.ts`），从最后一次成功的 TodoWrite 或上一条 `todo` 提醒按分支计数。
- `Agent`（T31，ADR-0048）在 Core 启用 `subagents` 时注册（`SessionHarness` 的 `agents` 宿主），描述列出可用类型（被 deny 的类型不列）；它在 `tool-batches.ts` 的 `CONCURRENCY_SAFE_TOOLS` 里，同一回复的多个调用并行。参数结构对齐 Claude Code，`model`、`effort` 写成 `{ type: "string", enum }`（`anyOf`/`const` 会被部分服务商拒绝）。子会话运行时与过滤见上级 `agent-host/AGENTS.md`。
- 注入接口：`currentPlan(entries)`、`currentTodos(entries, canonical)`；`session/history` 结果的 `harness` 由它们计算，`harness/todo` 在 TodoWrite 的 `item/completed` 之后发出。

## 上下文工程（T27，ADR-0043）

- **提醒**：`reminders.ts` 的 `Reminders.enqueue(key, { type, source, text, category?, data? })`。T32 加 `monitorOutput`（AHP `session/remind` 带 `key` 的入口，键 `monitor:<任务 id>`；`TYPES` 白名单要同步，否则分支记录被过滤、去重失效）。类型与入口：`todoStale`（`todos.ts`，键 `todo`）、`planMode`（`plan-mode.ts`，键 `mode`）、`fileModified`（`file-changes.ts`，键 `file:<路径>`）、`backgroundTask`（AHP `session/remind`，`SessionHarness.remind`）、`memoryLazyLoad`/`rulesMatched`（`session-memory.ts`，键 `memory:<路径>`）、`hookContext`（`hooks.ts`，键 `hook:<事件>:<n>`）、`contextRestore`（`compaction.ts` 压缩后直接追加）、`mcpChanged`（T36，`src/mcp/session.ts`，键 `mcp:<server>`：工具增减与新的 server 说明）。`category`（`memory`、`skills`、`conversation`）决定用量归类；新增来源加一种入口，不另写消息类型。`addCollector` 注册送达前运行的收集器（`fs/changes`：分支上有成功的 Read、Write、Edit 才问 Core）。提醒投影为 `reminder` 条目（能力 `context`，实时在 `message_end`，直接追加的经 `Projector.reminder`，历史在 `history.ts`）。
- **压缩**：`compaction-threshold.ts` 是阈值纯函数（T = W − min(O, 20K) − 13K，W = min(模型窗口, `autoCompactWindow`)，`contextWindowOverride` 留给 T29）；`SessionCompaction.apply()` 把 `compaction.reserveTokens = 模型窗口 − T + 1`、`compaction.enabled` 与 `retry.provider.maxRetries = 0` 施加到会话设置。Pi 的 `SettingsManager.reload()`（创建会话时资源加载就会调）清掉内存覆盖值，所以每次运行开始（注册表 `#run` 的 `compaction.prepare()`，先经 `context/settings` 取设置）与切换模型后重新施加；不要在 `SettingsManager.create` 之后、会话创建之前 `applyOverrides`。
- **摘要**：`session_before_compact` 里自己发请求（`prompts/compaction.ts`，改文案后跑原创性检查）。失败时返回 `{ cancel: true }` 并记下原因（Pi 1.5.2 吞掉处理器异常、改用它自己的提示），压缩条目与 `/compact` 回合以该原因失败（`lastFailure`）。摘要请求不经 `before_provider_request`，不带缓存。
- **重注入**：`reinjection.ts` 的 `RESTORE_LIMITS` 是全部上限；skill 正文读分支条目 `piarc.skillInvoked`（`{ name, content }`，T37 写入，`invokedSkills`），最近文件读分支上 Read、Write、Edit 的 `path`（`recentFiles`），内容经 `CoreIo.restoreText`（`fs/read` 的 `restore`）。重注入消息在 `session_compact` 中直接 `appendCustomMessageEntry`：Pi 每次请求都从会话投影重建消息，所以紧接着的请求就带上它（含两步之间的自动压缩）。
- **熔断**：`SessionCompaction.ended()` 在注册表 `#onEvent` 中先于投影器处理 `compaction_end`（`harness.observe`），压缩条目由此带上失败原因、压缩后估算与 `autoCompactStopped`；上限 `AUTO_COMPACT_FAILURE_LIMIT` = 3，状态在内存中：手动压缩成功、会话重开（回退、切换分支、Profile 变化、空闲回收）与新进程都复位（R3 维持不持久化，I107）。
- **用量**：`context-usage.ts` 在 `context_with_system` 估算（Pi 在这之后才把 system 换成冻结的 `forceSystemPrompt`，所以 system 文本取 `SessionMemory.systemText`，工具取 `getCurrentTools`），回复的 `message_end` 以服务商报告为合计；估算函数只用 `tokens.ts`。`session/usage` 只在 Core 启用 `context` 时发。

## 回合不变量：Pi 已满足 / Harness Kit 补齐（架构第 6.15 节）

| 不变量 | Pi 1.5.2 已满足 | Harness Kit 补齐 |
|---|---|---|
| 回合继续条件 | 回复里有工具调用才继续；`length` 截断时整条回复的调用判为失败、不执行 | — |
| 工具并发 | 并行模式同时启动一条回复的全部调用（无上限）；有一个 `sequential` 工具时全部串行 | `tool-batches.ts`：所有工具保持并行模式，执行被调度器按批放行：连续的 Read、Glob、Grep 每批至多 10 个，其余调用单独成批，前面的批次全部结束才放行下一批；Pi 不经执行就回答的调用按 `tool_execution_end` 计为结束。包住自定义工具（注册表的 `scheduled`）与所有扩展工具（`extensionsOverride` 替换扩展的 `tools` 映射，之后注册的 MCP 工具也被包住） |
| 中断补齐 | 已开始执行的调用收到 abort 信号后得到错误结果；没开始执行的得到 "Operation aborted"；还没准备的调用没有结果，pi-ai 只在请求里临时补 "No result provided"；被中断的回复写进文件但不进上下文 | `interruption.ts`：`agent_settled` 的 `aborted` 为真时，为没有结果的调用补写 "Interrupted by the user before this tool call finished."，对话不以回复结尾时追加中断标记（会话当前模型、零用量、`rawStopReason: piarc-interrupted`）；会话重新打开时对崩溃留下的未完成回合做同样处理。投影把这些调用的条目标为 `interrupted` |
| 重试 | agent 循环对限流、过载、5xx 重试，发 `auto_retry_*`，失败的那次不进上下文 | 每个会话的设置施加 `retry.provider.maxRetries = 0`（内存覆盖），让服务商 SDK 不静默重试，重试都经 `turn/retrying` 报给界面。T27 起由 `SessionCompaction.apply()` 在每次运行前施加：T14 在 `SettingsManager.create` 之后施加的值会被创建会话时资源加载的 `reload()` 清掉 |

- steer 消息按 Pi 的做法紧跟工具结果，形成相邻的 user 消息（Anthropic API 合并，严格 mock 的 `role_order` 不接受）：steer 场景关闭 `role_order`，其余场景（包括中断之后的请求）全部规则开启。
- 失败（非中断）结束的回合不补中断标记：下一条输入同样会紧跟上一条 user 消息（I67，T27 决定保持：失败的请求没有 assistant 内容，两家线格式都接受相邻的 user 消息，ADR-0043 第 11 条）。
