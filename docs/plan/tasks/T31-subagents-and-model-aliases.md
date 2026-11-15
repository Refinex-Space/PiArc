# T31 子 agent 与模型别名

| 项 | 内容 |
|---|---|
| 阶段 | 4 M3 多会话与生态 |
| 依赖 | R3 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort xhigh，新会话 |
| 规模 | 大 |
| 关联验证项 | 无 |
| 关联需求 | FR-HN-04、FR-MD-05 |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T31`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

子 agent 让主会话把探索、调研这类会撑满上下文的工作派给独立上下文去做，只拿回摘要。PiArc 的子 agent 有两个差异点：在同一个 Agent Host 进程内运行（ADR-0010，不为每个子 agent 多开一个约 120 MB 的进程）；可以跑在任意服务商的模型上，经模型别名表映射，例如 Explore 用便宜快速的模型。

本任务交付 `Agent` 工具、子 agent 定义加载、子会话运行时、模型别名表、审批来源标注、父子索引与子 agent 卡。完成后，用户现有的 `.claude/agents/*.md` 可以直接使用，子 agent 的编辑与主会话一样进入快照、可以回退。

## 必读

1. 架构设计：
   - 第 6.4 节"子 agent"、第 6.13 节"多模型适配"
   - 第 6.15 节中"子 agent 隔离"一行
   - 第 6.2.3 节中的审批账本（所属会话 / 子 agent）、第 6.9 节"Checkpoint 与 Rewind"
   - 第 7.4 节（`subagent/*` 通知）、第 7.6 节（条目增量的 `parentSessionId`）、第 9.2 节（`sessions` 表的父会话字段）
   - 第 8.2 节中的子 agent 卡
2. ADR-0005（来源顺序）、ADR-0010。
3. `docs/research/claude-official-capabilities.md` 第 A4.1–A4.3 节，以及第 A1 节末尾"Subagent 可用工具"。
4. `docs/research/harness-reference-notes.md` 第 1.5 节。
5. T14（会话编排与投影）、T20/T23（裁决与审批账本）、T21（模型能力表与 effort 映射）、T27（压缩与 system reminder）、T28（检查点）交付的代码与 CLAUDE.md。
6. 实现时查阅：Pi 锁定版本中 `createAgentSession` 的参数（工具集、模型、`SessionManager`、资源加载器）、`setActiveTools`、`registerTool` 的 `onUpdate`；Pi 官方示例 `examples/extensions/subagent/` 只看事件转发与用量统计的思路（它为每个子 agent 起子进程，PiArc 不采用）。

## 范围

### 要做

- 子 agent 定义的发现、解析与合并；三个内置类型。
- `Agent` 工具与 Harness Kit 中的子会话运行时：上下文隔离、工具过滤、深度与并发上限、前台与后台两种运行方式。
- 模型别名表：解析逻辑，以及设置窗口"模型与服务商"页中的别名编辑。
- 子 agent 审批的来源标注；子会话 JSONL 与父子索引；子 agent 的编辑进入快照。
- 客户端子 agent 卡与子会话转录查看。
- 每项行为的 L2 场景与能力 ID。

### 不做

- 后台子 agent 纳入统一任务管理器与后台任务面板（T32）。本任务保证后台子 agent 能运行、完成后注入通知，生命周期接口留给 T32 接管。
- `isolation: worktree`（T35）。T35 之前，定义了该字段的子 agent 启动时返回明确错误，不在主工作树中静默运行。
- frontmatter 中 `mcpServers`（T36）、`skills`（T37）的运行时效果。本任务完成解析与校验，UI 中标注"暂未生效"。
- SubagentStart / SubagentStop hooks（T38）、fork 子 agent（继承历史、共享缓存，T48）。

## 交付物

### 1. 定义来源与解析

- 来源与优先级（同名时取优先级高的整条定义，与 ADR-0005 的顺序一致）：项目 `.piarc/agents/` > 项目 `.claude/agents/`（两者都从 cwd 向上查找，越近越优先）> PiArc 用户目录 `agents/` > `~/.claude/agents/` > 插件（预留接口，T40 接入）。
- frontmatter：`name`、`description` 必填；支持 `tools`、`disallowedTools`、`model`、`permissionMode`、`maxTurns`、`skills`、`mcpServers`、`hooks`、`isolation`、`background`、`effort`、`color`；正文作为子 agent 的身份段。
- 其他字段（例如 `memory`、`autoCompactWindow`、`initialPrompt`）保留在解析结果中，在设置页与子 agent 卡上提示"PiArc 不支持，已忽略"；解析错误给出文件与行号。
- 项目级定义的 `permissionMode` 为 `bypassPermissions` 或 `auto` 时不生效（与第 6.2.1 节的项目级限制一致），按 `default` 处理并提示。
- AHP `resources/listAgents` 返回合并后的列表，每条带来源、被覆盖关系与警告。

### 2. 内置类型

| 类型 | 工具 | 上下文 | 默认模型 |
|---|---|---|---|
| `general-purpose` | 全部可用工具（扣除第 3 节的移除项） | 按第 6.6.1 节组装 | `inherit` |
| `Explore` | 只读工具 | 不加载 memory 文件与 git 状态 | `fast`；别名未配置时为 `inherit` |
| `Plan` | 只读工具 | 不加载 memory 文件与 git 状态 | `inherit` |

内置类型的身份段与描述由 PiArc 自写。

### 3. 子会话运行时（Harness Kit）

- `Agent` 工具的参数风格对齐 Claude Code（以 T30 的 L3 录制中的工具定义结构为准），描述文字自写。
- 在同一 Agent Host 中用 `createAgentSession` 创建子会话：cwd 与父会话相同；独立的 `SessionManager` 与 JSONL；首条消息只含任务描述，不继承父会话历史；独立压缩；独立的文件状态表（T16 预留的按会话隔离接口），子 agent 编辑前必须自己读过文件。
- 工具过滤顺序：父会话当前可用工具（已扣除无 specifier 的 deny）→ `tools` 白名单 → `disallowedTools`（同时设置时 disallowed 优先，带 specifier 的也移除整个工具）→ 移除 `AskUserQuestion`、`EnterPlanMode`、`ExitPlanMode` 与宿主 UI 工具（如 `SuggestNextSteps`）→ 达到深度上限时移除 `Agent`。过滤同时作用于 `setActiveTools` 与 `tool_call` 闸门，调用被移除的工具在闸门处拒绝。
- 深度上限默认 3，并发上限默认 8（每个主会话及其全部后代合计），都可配置，计数只在会话注册表中维护一份。超出并发上限时 `Agent` 立即返回错误结果，说明上限与当前运行数，不排队。
- `maxTurns` 到达后停止，结果标记为 partial。`permissionMode` 只能等于或严于主会话当前模式，更宽松的取值按主会话模式处理并提示。
- 前台：父会话的 `Agent` 调用等待子会话结束，进度经 `onUpdate` 投影为 `subagent` item 的 `item/updated`，最终报告作为工具结果返回。
- 后台（定义中 `background: true` 或调用参数指定）：`Agent` 立即返回任务 ID；完成后摘要与转录路径经 T27 的 system reminder 通道注入主会话下一回合。主会话关闭时后台子 agent 被中止，状态为 interrupted。
- 中断：主会话中断时取消沿父 → 子传播，所有未完成的工具调用补齐"已中断"结果（第 6.15 节）。

### 4. 模型别名表

- 别名 `fast`、`balanced`、`strong`，以及 `haiku`、`sonnet`、`opus`（默认分别跟随 `fast`、`balanced`、`strong`，可单独设置）。取值为 `provider/model` 全名。
- 解析顺序：`inherit` → 别名 → `provider/model` 全名；别名未配置时回退为 `inherit` 并在子 agent 卡上提示；无法解析时返回错误并列出可用别名。
- 存放在用户级 PiArc 设置，工作区 `.piarc/settings.json` 可覆盖。`effort` 经 T21 的映射，模型不支持的档位回退到模型默认并提示。
- 解析器放在 Agent Host 的共享位置，T37、T38 复用；T29 的"辅助模型"设置从此可以指向别名。设置窗口"模型与服务商"页新增别名一节：每个别名选择已配置的模型，显示能力摘要。

### 5. 审批、快照与索引（Core）

- 子 agent 的工具调用走同一个 `policy/evaluate`，请求带子会话 ID、`parentSessionId` 与 agent 类型；审批账本记录来源。审批卡出现在主会话，标明"来自子 agent：名称（类型）"；拒绝只影响该次调用。在子 agent 的审批卡上选"本会话允许"，作用于整个主会话树。
- 子 agent 经 Core 的写操作计入主会话当前回合的检查点，记录子会话 ID；回退主会话时一并恢复。
- `Agent(类型)` 规则（T23 已实现匹配）作用于 `Agent` 调用：被 deny 的类型不能派出，也不出现在工具描述的可选类型中。
- frontmatter 中的 `hooks` 经 T25 的 hooks 引擎作为限定作用域的来源接入，只在该子 agent 运行期间生效；项目级定义中的 hooks 在信任前不执行。
- `sessions` 表记录父子关系与子会话 JSONL 路径，重建索引时还原；子会话不出现在侧栏会话列表中，从子 agent 卡进入；`subagent/*` 通知覆盖开始、进度、结束。

### 6. 客户端子 agent 卡

- 显示名称、类型、颜色、实际模型、状态、耗时、工具调用数、token；后台标记；停止按钮；警告（被忽略的字段、别名回退）。
- 展开后以只读方式查看子会话转录，复用 transcript 组件。

### 7. L2 场景与能力 ID

场景 `tests/scenarios/subagent-*.yaml`，能力 ID 如 `CAP-AGENT-FILTER-001`、`CAP-MODEL-ALIAS-001`。断言覆盖子会话首个请求的消息与工具列表、mock provider 收到的模型 ID、审批事件的来源字段、检查点记录。

## 实现要点

- 父子会话同进程，串扰风险在 Pi 的模块级状态上（资源加载器、凭据缓存、MCP 客户端）。以 T06 的 S3 结论和 `agent-host/CLAUDE.md` 的易错点为起点逐一确认。
- 并发超限直接报错而不排队：多个前台子 agent 各自再派子 agent 时，排队会让父子互相等待而死锁。
- Agent Host 崩溃时子会话随之中断：进行中的前台子 agent 使父会话的 `Agent` 调用按 ADR-0009 标为 `uncertain`；后台子 agent 标为 interrupted 并通知主会话。
- 子 agent 的 system prompt 按第 6.6.1 节的分段组装，身份段换成定义正文；保持段落稳定，便于缓存。

## 验收标准

- [T31-A01] 定义文件的 frontmatter 字段全部正确解析，同名定义按来源优先级取整条；不支持的字段与解析错误（含文件与行号）在设置页和子 agent 卡上提示。验证：单元测试与 Playwright 截图。
- [T31-A02] Explore 与 Plan 只有只读工具，首个请求不含 memory 文件与 git 状态；general-purpose 拥有除移除项之外的全部工具。验证：L2 场景的 mock provider 请求断言。
- [T31-A03] 子 agent 的首个模型请求只含任务描述，不含父会话历史；子会话压缩后父会话历史不变。验证：L2 场景（mock 请求断言）。
- [T31-A04] `tools` 与 `disallowedTools` 生效且 disallowed 优先；`AskUserQuestion`、`EnterPlanMode`、`ExitPlanMode` 被移除；模型调用被移除的工具时在闸门处被拒绝。验证：L2 场景。
- [T31-A05] 第 3 层子 agent 没有 `Agent` 工具；并发达到上限（测试中调小）时 `Agent` 立即返回说明上限的错误结果。验证：L2 场景。
- [T31-A06] `fast`/`balanced`/`strong`、`haiku`/`sonnet`/`opus`、`provider/model`、`inherit` 各自解析到正确的模型，未配置的别名回退为 `inherit` 并提示。验证：单元测试与 L2 场景中 mock 收到的模型 ID。
- [T31-A07] 子 agent 需要审批时，审批卡出现在主会话并标明子 agent 名称与类型，拒绝只影响该次调用。验证：Playwright（截图存 `tmp/evidence/T31/`）。
- [T31-A08] 前台子 agent 的最终报告作为 `Agent` 工具结果返回；后台子 agent 完成后，摘要在主会话下一回合以 system reminder 注入。验证：L2 场景（mock 请求断言）。
- [T31-A09] 子会话转录写入独立 JSONL，`sessions` 表记录父子关系，重建索引后父子关系不变。验证：测试。
- [T31-A10] 子 agent 改动的文件进入主会话检查点，回退到该回合之前时恢复原样。验证：L2 场景。
- [T31-A11] 项目级定义中的 `bypassPermissions`、`auto` 不生效，子 agent 的模式不比主会话宽松；定义中的 `hooks` 只在该子 agent 运行期间生效，项目级定义的 hooks 在信任前不执行。验证：测试与 L2 场景。
- [T31-A12] 中断主会话时进行中的子 agent 一并中止，未完成的工具调用都补齐"已中断"结果。验证：L2 场景（mock provider 配对校验通过）。
- [T31-A13] 子 agent 卡显示类型、模型、状态、耗时与工具调用数，可展开查看子会话转录、可停止。验证：组件测试与 Playwright 截图。
- [T31-A14] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新 `agent-host/CLAUDE.md`：子会话运行时的位置、工具过滤顺序、深度与并发计数的唯一来源、同进程易错点。
- 更新 `crates/piarc-policy` 与 `crates/piarc-checkpoint` 的 CLAUDE.md：审批来源字段、子 agent 写入的检查点归属。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：模型别名解析器、子 agent 定义加载器。
- 在 `PLAN.md`"登记事项"中列出暂未生效的 frontmatter 字段及接手任务（`isolation` → T35、`mcpServers` → T36、`skills` → T37）。
