# T38 WebSearch 与 hooks 扩展（M3）

| 项 | 内容 |
|---|---|
| 阶段 | 4 M3 多会话与生态 |
| 依赖 | T37 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 中 |
| 关联验证项 | 无 |
| 关联需求 | FR-TL-03（WebSearch）、FR-HN-05（M3 部分） |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T38`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

本任务补齐 M3 中两块较小的能力：

- **WebSearch**：可配置后端，服务商原生搜索优先，其次第三方搜索 API，结果标注来源。Pi 没有这个工具（基线文档第 9 节第 12 行）。
- **hooks 扩展**：T25 只做了 command handler 与 M2 事件。本任务加 `http` 与 `prompt` 两种 handler，以及 M3 事件 SubagentStart、SubagentStop、PostToolBatch。

## 必读

1. 架构设计：
   - 第 6.1.4 节中 WebSearch 一行、第 6.13 节（模型能力表中的服务端工具支持）
   - 第 6.3 节"Hooks"全部、第 6.2.3 节（hooks 在裁决流程中的位置）、第 6.4 节"子 agent"
   - 第 10.1 节、第 10.2 节
2. `docs/research/claude-official-capabilities.md`：第 A1 节中 WebSearch 一行；第 A3.1 节（handler 类型与通用字段）、第 A3.2 节、第 A3.3 节中第 12、14、15 行、第 A3.4 节。
3. T25（piarc-hooks）、T29（WebFetch 的 HTTP 客户端与 SSRF 防护、辅助模型调用通道）、T31（子 agent 运行时、别名解析器）、T37（skill frontmatter）交付的代码与 CLAUDE.md。
4. 实现时查阅：
   - pi-ai 锁定版本对服务商服务端工具（原生网页搜索）的支持方式；
   - 各服务商原生搜索的官方文档与线格式；
   - 选定的第三方搜索 API 的官方文档。

## 范围

### 要做

- `WebSearch` 工具：原生后端、第三方后端、结果来源标注、设置项。
- hooks 的 `http` 与 `prompt` handler。
- M3 事件：SubagentStart、SubagentStop、PostToolBatch；子 agent 内触发的 hooks 输入带 `agent_id`、`agent_type`。

### 不做

- `mcp_tool` handler 与 M4 事件（T41）；M5 事件（T48）；`agent` handler（未排期）。
- 子 agent 与 skill frontmatter 中 hooks 的作用域（T31、T37，按 T25 的安排）。
- WebSearch 结果的二次抓取（由模型自行调用 WebFetch）。

## 交付物

### 1. WebSearch

- 规范名 `WebSearch`，参数风格对齐 Claude Code（以 T30 的 L3 录制中的工具定义结构为准），描述自写。Manual 模式下需要审批（第 6.1.4 节），`WebSearch` 规则与 PreToolUse hooks 照常生效。
- 后端选择：当前模型在能力表中支持原生搜索、且 pi-ai 能传递该服务端工具时用原生后端；否则用设置中配置的第三方后端；都不可用时 `WebSearch` 不进入模型的工具集，设置页说明原因。
- 原生后端的接法：模型调用的仍是 PiArc 的 `WebSearch` 工具，Core 裁决通过后，用辅助模型调用通道（T29）向同一服务商发一次带原生搜索工具的请求，取回结果。这样审批、hooks 与审计对所有后端一致。若改为把服务端工具直接加进主请求，搜索会绕过 `tool_call` 闸门，属于变更型决策，先写 ADR 提议。
- 第三方后端：定义后端适配接口，至少实现一个有公开 API 文档的服务，选型理由写进报告；API key 存保险箱；网络请求复用 WebFetch 的 HTTP 客户端、超时与大小上限。
- 结果统一为标题、URL、摘要，工具结果与 transcript 都标注来源；transcript 中的来源链接按第 8.5 节先确认再打开。
- mock：扩展 T05 的 mock provider，按服务商官方线格式模拟原生搜索的结果块；第三方后端用本地 mock 搜索服务。

### 2. `http` handler

- 在 Core 中执行：把 hook 输入 JSON POST 到配置的 URL，响应体按与 command 相同的 JSON 决策协议解析。
- 兼容键：`url`、`headers`（`$VAR` 插值只允许 `allowedEnvVars` 中列出的变量）、`timeout`（默认 600 秒）；设置中的 `allowedHttpHookUrls`、`httpHookAllowedEnvVars` 白名单生效，白名单外的 URL 不发请求。
- 非 2xx、超时、连接失败按非阻断错误处理；具体语义以官方文档为准，实现时核对。

### 3. `prompt` handler

- 用辅助模型调用通道做单轮判定：`prompt` 中的 `$ARGUMENTS` 替换为 hook 输入 JSON；可选 `model`，经 T31 的别名解析器解析；默认超时 30 秒。
- 返回 `{ok, reason}`：`ok: false` 在可阻断事件上按阻断处理，理由回给模型；超时、解析失败按非阻断错误处理。包装判定请求的提示词由 PiArc 原创。
- 每次调用的模型与 token 写入审计。

### 4. 事件与 handler 的组合

- 哪些事件支持 `http`、`prompt` 以官方文档为准（第 A3.1 节列出了支持全部类型的事件），实现时核对；不支持的组合在配置诊断中标注并忽略。
- hooks 的 allow 不能绕过后续 deny 与 ask（第 6.2.3 节），新 handler 同样适用；项目级 `http` 与 `prompt` hooks 在信任前不执行。

### 5. M3 事件

| 事件 | 挂载点 | 行为 |
|---|---|---|
| SubagentStart | T31 子会话创建时 | matcher 为 agent 类型；输入带 `agent_id`、`agent_type`；`additionalContext` 注入子 agent 的首个请求 |
| SubagentStop | 子会话结束前 | 输入带 `stop_hook_active`、`agent_transcript_path`、`last_assistant_message`；block 时子 agent 带理由续跑一轮，防循环计数与 Stop 一致 |
| PostToolBatch | Pi `turn_end` | 一批工具调用全部完成、下一次模型请求前触发；输入带 `tool_calls`；block 时停止循环并带理由 |

- 子 agent 内触发的所有 hooks（PreToolUse 等）输入都带 `agent_id`、`agent_type`。

### 6. 测试与能力 ID

- 场景 `tests/scenarios/websearch-*.yaml`、`tests/scenarios/hooks-m3-*.yaml`，能力 ID 如 `CAP-TOOL-WEBSEARCH-001`、`CAP-HOOK-HTTP-001`、`CAP-HOOK-SUBAGENT-001`。

## 实现要点

- `http` 与 `prompt` handler 复用 T25 的决策合并与超时取消框架，不另写一套执行器（claw-code 的反面教训）。
- `prompt` handler 会产生模型费用，测试一律用 mock provider。
- 原生搜索的线格式各服务商不同，适配放在 Agent Host 的服务商策略目录（第 5.2 节 `providers/`），不散落在工具代码里。

## 验收标准

- [T38-A01] WebSearch 经原生后端（mock provider 模拟服务端搜索）返回带来源的结果。验证：L2 场景。
- [T38-A02] 当前模型不支持原生搜索时使用配置的第三方后端（本地 mock 搜索服务），API key 只存在保险箱中。验证：L2 场景与磁盘扫描。
- [T38-A03] 没有可用后端时 `WebSearch` 不在模型的工具集中，设置页说明原因。验证：mock provider 请求断言与 Playwright。
- [T38-A04] WebSearch 在 Manual 模式下需要审批，原生后端与第三方后端都经过 `WebSearch` 规则与 PreToolUse hooks。验证：L2 场景。
- [T38-A05] transcript 中的搜索结果显示来源链接，点击后先确认再打开。验证：Playwright（截图存 `tmp/evidence/T38/`）。
- [T38-A06] `http` handler：响应体 JSON 的决策字段生效；非 2xx、超时与连接失败按非阻断错误处理；白名单外的 URL 不发请求；header 只插值白名单内的环境变量。验证：测试（本地 mock HTTP 服务）。
- [T38-A07] `prompt` handler：辅助模型返回 `ok: false` 时在可阻断事件上阻断并把理由回给模型；超时与解析失败按非阻断错误处理。验证：测试（mock provider）。
- [T38-A08] SubagentStart 按 agent 类型匹配，`additionalContext` 出现在子 agent 的首个请求中。验证：L2 场景（mock 请求断言）。
- [T38-A09] SubagentStop 返回 block 时子 agent 带理由续跑一轮，防循环计数生效。验证：L2 场景。
- [T38-A10] PostToolBatch 在一批工具调用完成后、下一次模型请求前触发，block 时停止循环并带理由。验证：L2 场景。
- [T38-A11] 子 agent 内触发的 hooks（含 PreToolUse、PostToolUse 与子 agent frontmatter 中的 hooks）输入都带 `agent_id` 与 `agent_type`。验证：L2 场景。
- [T38-A12] 未信任项目中的 `http` 与 `prompt` hooks 不执行。验证：测试。
- [T38-A13] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新 `crates/piarc-hooks` 的 CLAUDE.md：handler 类型、白名单设置、新事件的挂载点；更新 `agent-host/CLAUDE.md`：WebSearch 后端选择与服务商适配位置。
- 第三方搜索后端的选型与原生后端的接法若形成 ADR，同步架构第 6.1.4 节。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：辅助模型单轮判定、搜索后端适配接口。
