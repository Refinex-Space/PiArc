# 0048. 子 agent 与模型别名的落地（补充）

- 状态：已接受，补充 ADR-0005、ADR-0009、ADR-0010、ADR-0037、ADR-0039、ADR-0043、ADR-0044
- 日期：2026-11-20
- 相关：架构第 6.2.3、6.4、6.9、6.13、6.14、7.4、9.2、8.2 节；T31；登记事项 I73、I82、I113、I117、I128

## 背景

架构第 6.4 节定了子 agent 的形态：同一 Agent Host 进程内的子会话（ADR-0010），独立上下文，按定义过滤工具，深度 3、并发 8，审批在主会话显示，编辑进入快照。第 6.13 节定了模型别名表。实现时要回答几件基线没写到的事：

- 定义文件谁来读。读定义要知道家目录、项目信任，定义里的 `hooks` 要由 Core 执行（ADR-0039）；而运行子会话、解析模型在 Agent Host。
- Core 怎么认识子会话。子会话的 `fs/*`、`exec/*`、`policy/evaluate` 要有自己的会话 id（I73：沿用父会话 id 会把读取记进父会话的状态表），又要按主会话的模式、规则与回合裁决和记账。
- 工具过滤怎样同时作用于模型看到的工具和 `tool_call` 闸门。Pi 1.5.2 中，被 `setActiveTools` 移除的工具，调用在 `tool_call` 之前就得到 "Tool X not found"，闸门根本不运行；之后注册的工具（MCP）默认是激活的。
- 后台子 agent 与主会话中断、关闭、Agent Host 重启的关系。
- 别名表存在哪里，谁解析；Claude Code 的 `model`、`effortLevel`、`advisorModel`、`agent` 键怎么处理（I113）。

## 决策

1. **定义由 Core 读，Agent Host 加内置类型。** `piarc_config::agents` 按来源顺序（项目 `.piarc/agents/` > 项目 `.claude/agents/`，两者从 cwd 向上、越近越优先，跳过家目录 > PiArc 用户 `agents/` > `~/.claude/agents/` > 插件）发现并解析，同名取优先级最高的整条定义，被覆盖的路径记在 `overrides`。frontmatter 用 YAML 解析，错误带文件与行号（`AgentIssue`）；单个文件超过 `MAX_DEFINITION_BYTES` 不读。不认识的字段是 `ignoredField` 警告，`isolation`、`mcpServers`、`skills` 解析并校验但标 `inactiveField`（T35、T36、T37 接手）；项目级定义的 `bypassPermissions`、`auto` 按 `default` 处理并标 `projectModeIgnored`，用户级的 `auto`、`dontAsk` 标 `unsupportedMode`。Agent Host 经 AHP `agents/list`（Agent Host → Core）取合并结果、深度与并发上限、别名表和被 `Agent(<类型>)` deny 的内置类型，再并入 `general-purpose`、`Explore`、`Plan`（身份段与描述是 PiArc 自写的提示词）。客户端经 Core API `listAgents` → AHP `resources/listAgents` 取同一份列表，Agent Host 补上每个类型解析到的模型与别名回退警告。
2. **子会话先在 Core 登记再运行。** Agent Host 打开子会话后、首次请求模型前发请求 `subagent/start`（不是通知，所以 Core 一定先于子会话的第一个工具请求知道它）。Core 为子会话建自己的 `SessionIo`（自己的文件状态表，工作区根与 cwd 同父会话，I73），挂一个指向主会话（树根）的 `Link`，返回生效的权限模式与警告；`subagent/finish` 注销并把子会话写进索引。连接断开时，按连接登记的观察者注销该连接上的子会话。子会话 JSONL 的第一条是 `piarc.subagent` 自定义条目（父会话、类型），`sessions` 表的 `subagent_parent`、`subagent_type`（schema v6）由它派生，重建索引时还原；会话列表不含子会话。
3. **子会话的事件不发给 Core。** Agent Host 把子会话的运行汇总成 `SubagentState`（类型、颜色、实际模型、effort、状态、开始时间、耗时、工具调用数、token、当前活动、转录路径、错误、警告），作为父会话 `subagent` 条目的进度（`item/updated`）和父会话路由上的 `subagent/started`、`subagent/progress`（节流、可替换）、`subagent/completed` 通知。子会话转录由客户端经 Core API `subagentTranscript(parent, child, …)` 读：Core 核对子会话属于该父会话后，按父会话的位置向 Agent Host 读历史窗口。
4. **工具过滤用隐藏声明加闸门，不用 `setActiveTools`。** 顺序：父会话当前工具（已去掉整体 deny）→ 定义的 `tools` → 减去 `disallowedTools`（带 specifier 的项也移除整个工具，优先于 `tools`）→ 减去 `AskUserQuestion`、`EnterPlanMode`、`ExitPlanMode`、`SuggestNextSteps` → 到达深度上限时减去 `Agent`。子会话注册全部工具，每个工具的 `prepareLoadout` 以 `hiddenDeclarations` 把集合外的工具从模型请求里隐藏；隐藏的工具仍可调用，调用到达 `tool_call` 闸门并被拒绝（结果说明该工具对这个子 agent 不可用）。模型看到的工具与 `setActiveTools` 相同，闸门却总能运行，后注册的 MCP 工具也一样被隐藏。
5. **深度与并发只在 Agent Host 的 `SubagentRunner` 计数。** 一棵树（主会话及其全部后代）一份计数，启动中的子会话先占位，同一回复里并行的 `Agent` 调用不会一起越过上限。上限来自合并设置的 `subagents.maxDepth`、`subagents.maxConcurrent`（默认 3、8，至少 1），由 Core 在 `agents/list` 中下发。超过并发上限的调用立即得到写明上限与当前运行数的错误结果，不排队。`Agent` 是并发安全的工具（`tool-batches.ts`），同一回复的多个调用在同一批里并行。
6. **权限按主会话走。** 子会话的 `policy/evaluate` 带 `parentSessionId` 与 `agentType`，Core 用 `Link` 核对声明的来源。生效模式取定义的模式与主会话**当前**模式中更严的一个，每次裁决重新取（主会话切换模式立即影响子会话）；定义更宽松时按主会话模式并给 `modeClamped` 警告。审批卡带 `ApprovalOrigin`，出现在主会话的审批快照；"本会话允许"的规则存在主会话，作用于整棵树；拒绝只影响该次调用；审计记下子会话与类型。
7. **检查点归主会话的回合。** 子会话经 Core 的写入记在主会话当前回合的检查点下，`checkpoint_files.subagent_session` 记子会话 id；回退主会话时一起恢复（ADR-0044 的规则不变）。
8. **前台与后台。** 前台运行时，父会话的 `Agent` 调用等待，报告即工具结果；`maxTurns` 到达后停止，结果标 `partial` 并附已有内容。后台运行（定义的 `background: true` 或调用的 `run_in_background`）时，调用立即返回运行 id，结束后报告经 T27 的 `backgroundTask` 提醒进入父会话的下一次请求，父会话追加 `piarc.subagentState` 条目让历史显示最终状态。主会话中断时，Agent Host 经调用的 abort 信号中止前台运行，Core 同时撤下这些子会话的审批并结束其命令；后台运行不受中断影响。关闭会话中止它下面的全部运行，客户端可经 `stopSubagent` 停止一个。在 Core 登记着的子会话算作工作区忙碌，所以主会话的回合结束后，空闲计时不会回收仍有后台运行的 Agent Host。Agent Host 重启后打开父会话时，记录中仍在运行的后台运行标为 `interrupted` 并发提醒；前台运行随父会话的未完成回合按 ADR-0026 补齐。
9. **定义的 hooks 是限定作用域的来源。** `start_subagent` 把定义里的 `hooks` 以 `subagent` 层登记在子会话 id 下，`subagent/finish` 撤下；只匹配该子会话的事件。项目级定义的 hooks 计入信任清单的可执行项（ADR-0029：新增的项让项目回到未确认），项目不受信任时不登记并给 `hooksUntrusted` 警告。子会话不触发 SessionStart、Stop、SessionEnd hooks（SubagentStart/SubagentStop 是 T38）。
10. **别名表存在设置里，Agent Host 解析。** 表是设置键 `modelAliases`（别名 → `provider/model`），用户级 `settings.json` 与工作区 `.piarc/settings.json` 按键合并，Core 随 `agents/list` 下发合并后的表。`agent-host/src/providers/aliases.ts` 的 `resolveModel` 是唯一的模型说明解析器：`inherit` → 别名（`haiku`、`sonnet`、`opus` 未单独设置时跟随 `fast`、`balanced`、`strong`）→ `provider/model` → 在可用模型中唯一的模型 id；别名未设置或目标不可用时回退到 `inherit` 并给 `aliasFallback` 警告，无法解析时报错并列出别名。`effort` 经 T21 的档位表，不支持时用模型默认并给 `effortUnsupported` 警告。Core 只在下发设置值之前查表（`ModelAlias::target`）：辅助模型可以指向别名（存为 `modelProviders.auxiliaryAlias`，按用户级表解析，因为模型偏好不随工作区变），设置键 `model` 的别名按该工作区的合并表解析。
11. **Claude Code 键。** `model`、`effortLevel` 生效为新会话的默认模型与 effort（I113，`session/create` 的 `defaultModel`、`defaultEffort`，会话自己的选择优先）；`advisorModel` 忽略，原因写明它属于 Anthropic 服务端的 advisor 工具，PiArc 没有；`agent`（主线程作为某个子 agent 运行）交给 T48。
12. **参数规则（I82）。** `Agent(model:opus)`、`Agent(isolation:worktree)`、`Bash(run_in_background:true)` 这类 `键:值` 规则只用于 deny 与 ask，只匹配调用的顶层标量参数（`Agent`：`model`、`effort`、`isolation`、`run_in_background`；Bash、PowerShell、Monitor：`run_in_background`、`timeout`、`dangerouslyDisableSandbox`），不匹配主内容字段；写成 allow 规则是解析错误。键不在表里时照旧按类型名或命令模式解析。设置页标出参数规则匹配的参数。
13. **`Agent` 工具的参数结构对齐 Claude Code。** `description`、`prompt` 必填，`subagent_type`、`model`、`effort`、`isolation`、`run_in_background` 可选；`model`、`effort` 写成 `{ type: "string", enum }`（Google 一类服务商不接受 `anyOf`/`const`）。`isolation: worktree` 在 T35 之前返回明确错误，不在主工作树中运行。描述与参数说明是 PiArc 自写的文字。L3 比对中 `Agent` 不再有差异；`ListAgents` 留在 allowlist（PiArc 没有 agent teams，后台运行经提醒回报）。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| Agent Host 自己读定义文件 | 少一次 AHP 往返 | Agent Host 不碰文件系统（ADR-0004、ADR-0020）；hooks 与信任在 Core，要再传一遍 | 否决 |
| 子会话沿用父会话 id，在 `fs/*` 请求上加子 agent 标识 | 不用登记 | 文件状态表、命令、审批、检查点每处都要分辨同一 id 下的两个会话 | 否决（I73 的第一种做法被采用） |
| 以通知报告子会话开始 | 简单 | 通知与子会话的第一个工具请求之间没有先后保证 | 否决 |
| 用 `setActiveTools` 过滤 | 与架构原文一致 | 被移除工具的调用在闸门之前就以 "not found" 结束；后注册的 MCP 工具默认激活 | 否决 |
| 并发超限时排队 | 调用不失败 | 前台子 agent 各自等自己的子 agent，排队会互相等待而死锁 | 否决 |
| 主会话中断也中止后台运行 | 一个按钮停全部 | 后台运行的意义就是不随当前回合结束；单独停止有卡片上的按钮 | 否决 |
| 别名在 Core 全部解析好再下发 | 一个解析点 | Core 不知道 Agent Host 当前可用的模型与凭据，回退与报错无从判断 | 否决 |

## 后果

- 正面：用户现有的 `.claude/agents/*.md` 直接可用，不支持的字段在设置页与卡片上说明；子 agent 的编辑进入快照、可以回退；审批、规则、模式、hooks 都沿用一套机制。
- 正面：别名把探索类工作放到便宜模型上，同一张表供子 agent、辅助模型与 `model` 设置使用。
- 负面与代价：子会话与父会话同进程，Pi 的模块级状态（扩展加载器缓存、MCP 客户端）照常按会话实例化，每个子会话的 MCP server 各起一份进程（共享池是 T36）。已打开的会话在重新打开前沿用打开时的类型列表。沙箱会话派出的子会话在 T39 之前不进沙箱。
- 需要配套做的事：T32 把后台运行纳入任务管理器；T35 实现 `isolation: worktree`；T36、T37 让 `mcpServers`、`skills` 生效；T38 加 SubagentStart/SubagentStop hooks；T48 处理 fork 子 agent 与 `agent` 键。

## 重新评估的触发条件

- Pi 让 `setActiveTools` 移除的工具也经过 `tool_call`，或去掉 `prepareLoadout` 的 `hiddenDeclarations`。
- 子会话的内存占用使单个 Agent Host 超出第 15 章的预算，需要按子会话拆进程。
- Claude Code 改变 `Agent` 工具的参数结构或子 agent 定义的字段（L3 Nightly 会报告）。
- 用户需要在工作区之间使用不同的辅助模型别名。
