# T25 Hooks（M2 事件集与 command 类型）

| 项 | 内容 |
|---|---|
| 阶段 | 3 M2 Harness 核心 |
| 依赖 | T24 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort xhigh，新会话 |
| 规模 | 大 |
| 关联验证项 | 无 |
| 关联需求 | FR-HN-05（M2 部分） |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T25`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

hooks 让用户在 agent 生命周期的固定时机运行自己的命令：拦截危险调用、自动格式化、注入上下文、阻止过早结束。Claude Code 用户已经在 `.claude/settings.json` 里写了这些配置，PiArc 要原样执行。hooks 会运行任意命令，所以执行全部在 Core，受项目信任约束并写审计（ADR-0004、风险 R12）。

本任务新建 piarc-hooks：配置解析与合并、matcher、command 类型执行器、决策协议与决策合并；把 M2 的 11 个事件挂到 Core 与 Harness Kit 的对应时机，并接入 T23 在裁决流水线中留出的第 2 步与第 8 步。

完成后，M2 事件集的每个事件都有 L2 场景覆盖，exit code 与 JSON 决策的语义与 Claude Code 官方文档一致。

## 必读

1. 架构设计：第 6.3 节全部、第 6.2.3 节"裁决流程"、第 7.1 节依赖规则、第 7.4 节 `hooks/run`、第 9.2 节 `audit_events`、第 10.2 节。
2. ADR-0004、ADR-0005。
3. `docs/research/claude-official-capabilities.md` A3.1–A3.4（配置结构、通用输入字段、事件全集、exit code 与 JSON 语义）；`docs/research/harness-reference-notes.md` 第 2.1 节第 2、3 条与第 2.2 节第 3 条。
4. T17、T23、T24 交付的代码与 CLAUDE.md：piarc-exec 的进程树终止、裁决流水线插槽、配置键映射表。
5. 实现时查阅：Pi 锁定版本中 `session_start`、`session_shutdown`、`tool_result`、`agent_before_settle`、`session_before_compact`、`session_compact` 的签名与可改写字段；官方 hooks 文档原文（matcher 规则、各事件输入与输出字段）。

## 范围

### 要做

- 配置解析与多来源合并（ADR-0005 的同一组 settings 文件；同一 handler 跨文件只执行一次）。
- matcher、command handler 执行器、决策协议、决策合并。
- 下表 11 个事件的挂载与场景。
- 项目 hooks 的信任闸门；每次执行写审计。

### 不做

- `http` 与 `prompt` handler、SubagentStart/SubagentStop、PostToolBatch（T38）。
- M4 事件与 `mcp_tool` handler（T41）；M5 事件（T48）；`agent` handler（未排期）。
- 插件、skill、子 agent frontmatter 中的 hooks（随 T40、T37、T31 接入）；企业"只允许托管 hooks"（T47）。
- `async`、`asyncRewake` 等后台执行字段：解析后在诊断中标为不支持，不静默执行。
- 压缩本身与 PiArc 摘要提示（T27）。本任务挂载 PreCompact/PostCompact，并保证 PreCompact 的阻断与摘要指令能传给压缩流程。

## 交付物

### 1. M2 事件与挂载点

| 事件 | 挂载点 | 可阻断 | 主要决策字段 |
|---|---|---|---|
| SessionStart | Core 会话创建与恢复；Pi `session_start` | 否 | `additionalContext`、纯文本 stdout 作为上下文 |
| SessionEnd | Core 会话关闭；Pi `session_shutdown` | 否 | 无 |
| UserPromptSubmit | Core 把输入发给 Agent Host 之前 | 是 | `decision: "block"` + `reason`、`additionalContext`；不能替换 prompt |
| PreToolUse | 裁决第 2 步 | 是 | `hookSpecificOutput.permissionDecision`（allow/deny/ask）、`permissionDecisionReason`、`updatedInput`、`additionalContext` |
| PermissionRequest | 裁决第 8 步，弹审批卡之前 | 否 | `decision.behavior`（allow/deny）、`updatedInput`、`message`、`interrupt` |
| PostToolUse | Pi `tool_result`（成功） | 否 | `decision: "block"` + `reason`、`additionalContext`、`updatedToolOutput` |
| PostToolUseFailure | Pi `tool_result`（失败） | 否 | `decision: "block"` + `reason`、`additionalContext`；不能改写输出 |
| Stop | Pi `agent_before_settle` | 是 | `decision: "block"` + `reason`（以 reason 续跑一轮） |
| PreCompact | Pi `session_before_compact` | 是 | `decision: "block"`；exit 0 时 stdout 作为摘要指令 |
| PostCompact | Pi `session_compact` | 否 | 无（输入带摘要） |
| Notification | Core 发出通知时（等待审批、回合完成等） | 否 | 无 |

- 通用字段：`continue`、`stopReason`、`systemMessage` 对所有事件生效；`systemMessage` 与非阻断错误以事件上报，客户端用现有提示行显示。
- 输入 JSON：通用字段 `session_id`、`transcript_path`、`cwd`、`permission_mode`、`hook_event_name`，加上各事件特有字段（按官方文档）。`transcript_path` 指向 Pi 的 JSONL，格式与 Claude Code 不同，写进用户文档。
- `PermissionRequest` 的 `updatedPermissions` 本任务支持 `addRules`、`setMode`，写入目标限于会话与 `.piarc/` 文件（不写 `.claude/`）；其余操作在诊断中标为不支持。

### 2. 执行器

- command 类型：子进程从 stdin 读输入 JSON，读取 exit code、stdout 与 stderr；同一事件命中的多个 handler 并行执行。
- 超时：默认 600 秒，UserPromptSubmit 30 秒，handler 可用 `timeout` 覆盖；超时或会话取消时终止整棵进程树（macOS 进程组、Windows Job Object）。
- 进程启动与终止经窄 trait（如 `ProcessSpawner`）注入，由 piarc-core 提供基于 piarc-exec 的实现；piarc-hooks 不直接依赖 piarc-exec（第 7.1 节依赖规则）。
- `additionalContext`、`systemMessage`、纯文本 stdout 各自超过 10,000 字符时写入会话临时目录，只送 2,000 字符预览与路径。

### 3. 决策协议与合并

- exit 0：stdout 恰好是一个 JSON 对象时按字段处理，否则按纯文本处理（只有允许纯文本上下文的事件使用它）。exit 2：阻断，stderr 作为理由回给模型。其他退出码：非阻断错误，动作继续，记录并提示用户。
- PreToolUse 多个 handler 冲突时 deny > ask > allow。`defer` 只在 Claude Code 的 `-p` 模式有意义，PiArc 按 `ask` 处理并在文档中说明。
- hooks 的 allow 只表示"未阻断"，后续 deny、ask 规则与 plan 模式的拒绝照常生效（第 6.2.3 节）。
- Stop：block 时以 reason 续跑一轮，输入的 `stop_hook_active` 置为 true；连续阻断达到上限后停止续跑并提示用户。上限集中定义，取值写进架构第 6.3.1 节。

### 4. 信任与审计

- 项目级 hooks（`.piarc/settings*.json`、`.claude/settings*.json`）在项目信任前不执行；用户级 hooks 照常执行。
- 每次执行写 `audit_events`：事件、handler 来源文件、命令摘要、exit code、耗时、决策、是否超时。

### 5. L2 场景与能力 ID

- 每个事件至少一个场景（`tests/scenarios/hooks-*.yaml`），hook 命令是夹具脚本：按场景参数输出 JSON 或退出码，并把收到的 stdin 记录下来供断言。能力 ID 形如 `CAP-HOOK-PRE-001`。
- 夹具脚本用 Node 编写，保证两个平台都能运行。

## 实现要点

- matcher：`*`、空或省略匹配全部；只含字母数字与 `_`、`-`、空格、`,`、`|` 时按精确值匹配；其他按非锚定正则匹配。官方语义基于 JavaScript 正则，所选 Rust 正则库不支持的语法（例如环视）要明确报错并列进诊断。
- 配置解析接入 T24 的键映射表，把 `hooks` 与 `disableAllHooks` 改为"生效"。
- Windows 上 command 的执行方式（经 Git Bash 还是 PowerShell）以官方文档的 `shell` 字段语义为准，默认行为写进文档。
- 并行执行的 handler 输出各自读完，避免管道缓冲死锁（harness-reference-notes 第 2.2 节第 6 条）。

## 验收标准

- [T25-A01] 交付物 1 表中 11 个事件各有至少一个 L2 场景且通过，能力 ID 已登记，无 MISSING。验证：场景运行输出与能力清单。
- [T25-A02] 每个事件的 hook 收到的输入 JSON 含通用字段与该事件的特有字段。验证：场景中对夹具记录的 stdin 断言。
- [T25-A03] exit 2 阻断动作，stderr 作为理由出现在下一次模型请求中；其他非 0 退出码不阻断，并向用户提示错误。验证：场景测试与 mock provider 请求断言。
- [T25-A04] PreToolUse 的 deny、ask、allow 与 `updatedInput` 生效；多个 handler 冲突时按 deny > ask > allow 合并。验证：场景测试。
- [T25-A05] PreToolUse 返回 allow 时，后续 deny 规则、ask 规则与 plan 模式的拒绝仍然生效。验证：测试。
- [T25-A06] PostToolUse 的 `updatedToolOutput` 替换模型看到的工具结果、`additionalContext` 被追加；PostToolUseFailure 不能改写失败输出。验证：mock provider 请求断言。
- [T25-A07] Stop 返回 block 时以 reason 续跑一轮；连续阻断达到上限后停止续跑并提示用户。验证：场景测试。
- [T25-A08] PreCompact 可以阻断压缩，exit 0 的 stdout 作为摘要指令出现在摘要请求中；PostCompact 收到摘要。验证：场景测试与 mock provider 请求断言。
- [T25-A09] handler 超时或会话取消时整棵进程树被终止，默认超时为 600 秒、UserPromptSubmit 为 30 秒（测试中时长可注入）。验证：macOS 本机测试与 Windows CI 测试输出。
- [T25-A10] 同一事件的多个 handler 并行执行；同一 handler 定义在多个文件中时只执行一次。验证：测试。
- [T25-A11] 未信任项目的项目级 hooks 不执行，用户级 hooks 照常执行，信任后项目级 hooks 生效。验证：测试。
- [T25-A12] 每次 hook 执行都写入审计记录（事件、来源、exit code、耗时、决策）；超过 10,000 字符的上下文输出落盘并只送预览。验证：测试。
- [T25-A13] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 创建或更新 `crates/piarc-hooks` 的 CLAUDE.md：事件挂载点、决策合并规则、Stop 续跑上限、不支持的字段、`ProcessSpawner` 注入方式。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：hooks 执行器、上下文输出落盘。
