# T48 M5 Harness 补全

| 项 | 内容 |
|---|---|
| 阶段 | 6 M5 Beta |
| 依赖 | T47 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 大 |
| 关联验证项 | 无 |
| 关联需求 | FR-HN-05（M5 部分）、FR-HN-04（fork 子 agent）、FR-EX-01（skills `context: fork`）、FR-CX-03（服务端压缩策略）、FR-EX-03（MCP elicitation） |
| 需要的用户决定 | 无 |
| 关口 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T48`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

架构第 6 章把几项 Harness 能力明确排到了 M5：Anthropic 服务端的 context editing 与 compaction（第 6.6.4 节）、继承历史并共享缓存的 fork 子 agent（第 6.15 节）、skills 的 `context: fork`（第 6.7 节）、M5 的 hooks 事件（第 6.3.2 节），以及 MCP elicitation（第 6.8 节）。本任务把它们补齐，每项都有 L2 场景和能力 ID。

MCP elicitation 依赖 pi-mcp 客户端能否处理服务端发来的 elicitation 请求。T36 已用 PiArc 的 MCP 扩展替换了 Pi 内置扩展，但底层仍是 pi-mcp 客户端。锁定版本不支持时，按"交付物 5"的规则登记并标为阻塞，不 fork Pi，不打补丁。

完成后，第 6 章中标为 M5 的 Harness 能力在 `capabilities.md` 中全部有覆盖，或带着明确的上游阻塞原因。

## 必读

1. 架构设计：
   - 第 6.3.2 节"事件映射与分期"、第 6.4 节"子 agent"、第 6.6.4 节"压缩"、第 6.7 节（skills）、第 6.8 节（MCP 缺口）
   - 第 6.12 节"Worktree"、第 6.13 节（切换代价提示）、第 6.15 节（子 agent 隔离、缓存断点两行）
2. ADR-0002、ADR-0010。
3. `docs/research/claude-official-capabilities.md`：A3.3 节第 9、25、26、29–32 号事件、A4.3 节"Fork 模式"、A5.1 节 skills frontmatter、A8 节（elicitation）、C 节 Context editing、Server-side compaction、Prompt caching。
4. `docs/research/pi-v1.4.0-baseline.md` 第 4.3、4.4、4.6 节（`context_edit` entry、compaction、`before_provider_request`）与第 7.1 节（pi-mcp 缺口）。
5. T27（压缩抽象）、T31（子 agent）、T35（worktree）、T36（MCP 扩展）、T37（skills）、T46（Auto 模式的拒绝触发点）的代码与 CLAUDE.md。
6. 实现时查阅：
   - Pi 锁定版本中 `before_provider_request`、`context_edit` entry、会话 fork 的签名与行为；
   - pi-mcp 锁定版本客户端的请求 handler 注册方式；
   - Anthropic 官方文档中 context editing 与 compaction 的当前参数与 beta 头（调研文档是快照，以官方当前版本为准）。

## 范围

### 要做

- 服务端 context editing 与 compaction 作为可选的压缩策略，与客户端压缩统一抽象。
- fork 子 agent；skills `context: fork`。
- M5 hooks 事件：WorktreeCreate/WorktreeRemove、PreModelSwitch/PostModelSwitch、Elicitation/ElicitationResult、PermissionDenied。
- MCP elicitation（表单与 URL 两种模式），取决于 pi-mcp 锁定版本。

### 不做

- 未排期的 hooks 事件与 `agent` handler 类型（第 6.3.2 节"未排期"行）。
- MCP sampling、resources/subscribe（第 6.8 节缺口，未排期）。
- 修改 Pi 或 pi-mcp 源码、维护补丁（ADR-0002）。

## 交付物

### 1. 压缩策略抽象与服务端策略

- 在 T27 的压缩实现之上抽出策略接口：`client`（现有实现）与 `anthropic-server`（context editing、compaction）。同一时刻只有一种策略负责压缩，不会重复压缩。
- 服务端策略只对能力表标明支持的 Anthropic 模型可选，按模型在设置中开启；请求参数经 `before_provider_request` 注入（以锁定版本的签名为准）。
- 服务端返回错误或模型不支持时退回客户端策略并提示用户。
- 会话历史只追加：服务端编辑后的会话可以恢复，恢复后的请求前缀正确。PreCompact/PostCompact 对服务端策略的语义写入架构第 6.6.4 节。

### 2. fork 子 agent

- 继承父会话截至 fork 点的完整历史，使用与父会话相同的 system prompt 和工具定义，以共享 prompt cache；fork 不能再 fork。
- 触发方式（`Agent` 工具参数与用户命令）按官方文档描述的行为对齐，参数名写入架构第 6.4 节。
- 编辑进入快照，审批在主会话显示并标明来源，与 T31 一致。

### 3. skills `context: fork`

- 带 `context: fork` 的 skill 在子 agent 中运行，`agent`、`background` 字段生效；主会话只收到结果，不包含 skill 正文。

### 4. M5 hooks 事件

| 事件 | 挂载点 | 要求 |
|---|---|---|
| WorktreeCreate / WorktreeRemove | T35 的 worktree 创建与移除 | 配置了 hook 时替换默认 git 行为：command 在 stdout 打印路径；非 0 退出使创建或移除失败并给出原因 |
| PreModelSwitch / PostModelSwitch | T21 的会话内切换模型 | 输入含原模型、目标模型、上下文 token、缓存是否仍热、估算的缓存写入成本；Pre 可允许、拒绝、询问；Post 的 `additionalContext` 随下一个请求送达 |
| PermissionDenied | T46 的审查模型拒绝路径 | 输入含工具名、参数、理由；返回 `retry: true` 时告诉模型可以重试 |
| Elicitation / ElicitationResult | 交付物 5 的 elicitation 流程 | Elicitation 可代答或阻断；ElicitationResult 可修改用户的回答 |

每个事件的输入字段与决策字段以 `claude-official-capabilities.md` A3.3 节为准，差异记入 `tests/l3-allowlist.yaml` 并写明理由。

### 5. MCP elicitation

- 先查 pi-mcp 锁定版本：客户端能否声明 elicitation 能力、能否注册服务端请求的 handler。
- 支持时：表单模式渲染为客户端对话框，URL 模式经主进程确认后用系统浏览器打开；接受、拒绝、取消回传 server；接入 Elicitation 与 ElicitationResult hooks。
- 不支持时：
  1. 写好上游 issue 草稿（现象、需要的接口、最小复现），经用户同意后提交或交用户提交，链接记入 `PLAN.md`"登记事项"；
  2. MCP 设置页对该能力显示"暂不支持"；
  3. 相关验收项标 `blocked`，`evidence` 写明上游原因与登记事项编号；
  4. Elicitation 与 ElicitationResult 的 hook 分发仍实现并做单元测试，L2 场景随 elicitation 一起阻塞。

### 6. L2 场景与能力 ID

- 每项一个以上场景，能力 ID 例如 `CAP-CX-COMPACT-SERVER-001`、`CAP-AGENT-FORK-001`、`CAP-HOOK-PREMODELSWITCH-001`。
- elicitation 场景用一个最小的 MCP server 测试夹具，按表单与 URL 模式各发一次请求。

## 实现要点

- fork 共享缓存的前提是前缀逐字节一致：fork 的首个请求不能多出、少出或改动任何 system 段与工具定义。用 mock provider 直接比对字节。
- 服务端压缩改变的是服务端视图，不改写本地 JSONL；本地仍保留完整历史，上下文用量环按服务端返回的用量更新。
- 真实 Anthropic 服务端行为无法用 mock 完全代表。需要用真实 API 验证时，先说明调用次数并征得用户同意，只用最便宜够用的模型。

## 验收标准

- [T48-A01] 对支持的 Anthropic 模型开启服务端策略后，请求带上配置的 context editing 或 compaction 参数，客户端压缩不触发；关闭时或非 Anthropic 模型沿用客户端压缩。验证：mock provider 请求断言（两种线格式各一个场景）。
- [T48-A02] 服务端策略返回错误或模型不支持时退回客户端压缩并提示用户。验证：L2 场景（故障注入）。
- [T48-A03] 服务端压缩后的会话重启恢复，恢复后的请求前缀与历史一致，本地 JSONL 未被改写。验证：测试。
- [T48-A04] fork 子 agent 首个请求的 system 与工具定义和父会话最近一次请求逐字节一致，消息前缀等于父会话截至 fork 点的历史，缓存断点符合第 6.15 节。验证：mock provider 请求断言。
- [T48-A05] fork 子 agent 不能再 fork；其编辑可回退；其审批在主会话显示并标明来源。验证：L2 场景与 Playwright。
- [T48-A06] `context: fork` 的 skill 在子 agent 中运行，`agent` 与 `background` 字段生效，主会话请求中不含 skill 正文。验证：L2 场景与 mock provider 请求断言。
- [T48-A07] 配置 WorktreeCreate/WorktreeRemove hook 后，worktree 路径取自 hook 输出，非 0 退出使创建或移除失败并显示原因。验证：L2 场景。
- [T48-A08] PreModelSwitch 的输入含原模型、目标模型、上下文 token、缓存状态与估算成本，拒绝时切换取消、询问时显示确认；PostModelSwitch 的 `additionalContext` 出现在下一个请求中。验证：L2 场景与 mock provider 请求断言。
- [T48-A09] 审查模型拒绝时触发 PermissionDenied；hook 返回 `retry: true` 时，给模型的工具结果说明可以重试。验证：L2 场景与 mock provider 请求断言。
- [T48-A10] MCP elicitation 表单与 URL 两种模式可完成接受、拒绝、取消，Elicitation hook 可代答或阻断，ElicitationResult 可修改回答；pi-mcp 锁定版本不支持时，上游 issue 已按规则处理、`PLAN.md` 已登记、MCP 设置页显示"暂不支持"，本项标 `blocked` 并写明原因。验证：L2 场景与 Playwright，或登记记录与截图。
- [T48-A11] 本任务新增的能力全部登记在 `tests/capabilities.yaml`，生成的 `capabilities.md` 中除已登记的上游阻塞项外没有 MISSING。验证：生成命令输出。
- [T48-A12] `npm run verify` 通过（含 Windows CI 上的 L2 场景）。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新架构第 6.3.2、6.4、6.6.4、6.7、6.8 节中 M5 项的实现状态与语义说明（补充型）。
- 更新 `agent-host` 与 `crates/piarc-hooks` 的 CLAUDE.md：压缩策略接口、fork 的前缀一致要求、M5 事件的挂载点。
- elicitation 被阻塞时，在 `PLAN.md`"登记事项"中写明解除条件（pi-mcp 发布支持的版本号）与需要恢复的验收项。
