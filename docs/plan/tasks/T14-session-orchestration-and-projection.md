# T14 会话编排与事件投影

| 项 | 内容 |
|---|---|
| 阶段 | 2 M1 可行走骨架 |
| 依赖 | T13 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort xhigh，新会话 |
| 规模 | 大 |
| 关联验证项 | 无 |
| 关联需求 | FR-CH-03（Core 部分）、FR-WS-03 |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T14`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

T06 让 Agent Host 能托管多个会话，但只有最小投影；Core 也还没有会话的概念，只会启动和监管进程。本任务把会话变成 Core 中的一等实体：

- Core 用 actor 管理工作区与会话的生命周期、输入、排队、预热与回收，并通过 NAPI 暴露给主进程；
- Agent Host 按架构第 5.3 节完整投影 Pi 事件，UI 以后只认这套语义；
- 第 6.15 节的回合不变量（工具批次并发、中断补齐、重试不外露）落地。

完成后，主进程可以经 Core API 创建、恢复、fork、关闭会话，发送 prompt、steer、followUp、abort，编辑排队项；应用重启后会话从索引恢复。

## 必读

1. 架构设计：
   - 第 3.2 节"一次用户输入的完整流程"、第 3.3 节"进程模型"
   - 第 5.3 节"会话托管与事件投影"（投影表逐行实现）
   - 第 6.1.2 节"并发""中断"两行、第 6.15 节"回合继续条件""工具并发""中断与降级"三行
   - 第 7.2–7.6 节
   - 第 11 章"打开工作区到 Agent Host 就绪""Agent Host 崩溃后恢复"两行
2. ADR-0009、ADR-0010、ADR-0011。
3. `docs/research/pi-v1.4.0-baseline.md` 第 3.2 节"工具执行"、第 3.3 节"中断与队列"、第 3.4 节"事件与状态"、第 4.3 节。
4. T04、T06、T07、T13 交付的代码与 CLAUDE.md：事件批次通道、`piarc-host`、`projector.ts`、Operations 委托、piarc-store。
5. 实现时查阅：Pi 锁定版本的 `AgentSession` 的 `prompt`/`steer`/`followUp`/`abort`、队列 API 与 `queue_update`、`auto_retry_*` 事件、`AgentSessionRuntime` 的 fork 与切换；pi-agent-core 的工具执行与中断处理。

## 范围

### 要做

- Core：`WorkspaceActor`、`SessionActor`，会话生命周期、输入、排队、预热与空闲回收、事件批次、seq 缺口补齐、实体快照。
- Agent Host：第 5.3 节投影表的完整实现与 golden 测试。
- 第 6.15 节的三条回合不变量，缺的由 Harness Kit 补齐。
- NAPI 会话方法与事件、会话持久化与重启恢复。

### 不做

- 工具语义不变量（T16）、Bash 执行细节与语义退出码的判定表（T17）、权限与审批（T20）。
- 客户端界面（T18、T19）。preload 白名单中的命令由 T18 按需加入。
- 会话分支的切换界面（T28）、子 agent（T31）。

## 交付物

### 1. Core 会话编排

- `WorkspaceActor`：每个已打开工作区一个，持有 Agent Host 监管句柄；打开工作区即启动 Agent Host（预热）；工作区内全部会话空闲超过阈值（默认 30 分钟，可配置）后回收进程，需要时再启动并恢复会话。
- `SessionActor`：每个会话一个，处理 create、resume、fork、close，prompt、steer、followUp、abort，排队项的编辑、删除、重排；会话状态（运行中、空闲、错误、等待审批字段由 T20 填充）与未读由 Core 计算。
- 取消沿会话 → 回合 → 工具调用传播（`CancellationToken`，第 7.2 节）。
- 持久化：会话元数据写 `sessions` 表；应用重启后从索引列出会话，resume 时由 Agent Host 从 Pi JSONL 恢复。

### 2. 事件与快照

- 会话事件经 T04 的通道约 16 ms 合并一批；条目增量的身份为 `sessionId / turnId / itemId`。
- Core 检测到 `seq` 缺口时用 `session/getEntries(since)` 补齐，补齐前后对客户端的事件顺序不乱。
- 实体快照（工作区列表、会话列表）带单调递增的 `revision`。
- 历史条目：Core API 提供 `transcript_window(range)`。历史条目由 Agent Host 的同一个投影器从 Pi entry 生成，不在 Rust 中再写一套投影。

### 3. Agent Host 投影（第 5.3 节）

| Pi 事件 | AHP 事件 |
|---|---|
| 一次 prompt 的首个 `agent_start` / `agent_settled` | `turn/started` / `turn/completed`（带用量汇总） |
| `message_update` 的 `text_delta`、`thinking_delta` | `item/agentMessage/delta`、`item/reasoning/delta`，itemId = `messageId#contentIndex` |
| `tool_execution_start/update/end` | `item/started`、`item/updated`、`item/completed`；item 类型 `commandExecution`、`fileChange`、`mcpToolCall`、`subagent`、`webFetch`、`dynamicToolCall` |
| `compaction_start/end` | `item/contextCompaction`（原因、压缩前后 token） |
| `auto_retry_*` | `turn/retrying`（attempt、maxAttempts、delayMs） |
| `queue_update` | `session/queueChanged`（每个排队项有 id） |
| Harness Kit 写入的自定义 entry | 对应的 Harness 事件 |

- item 状态统一为 `inProgress / completed / failed / declined / interrupted`。成败由工具层给出的语义结果决定（例如 Grep 无匹配算成功），投影器不按退出码猜测。
- 投影 golden 测试（L1）：录制的 Pi 事件序列 → AHP 事件，覆盖上表每一行与每种 item 类型、每种状态。
- 排队：Pi 不支持按项编辑时，Agent Host 自己维护排队表（id、内容、顺序），编辑与重排通过清空并按新顺序重新入队完成，过程中不丢项、不重复。AHP 新增 `queue/delete`、`queue/reorder`（补充型）。

### 4. 回合不变量（第 6.15 节）

- 工具并发：连续的只读、并发安全调用成批并行，单批上限 10；遇到写操作切回串行。
- 中断：abort 时为所有未完成的工具调用补齐"已中断"结果，tool_use / tool_result 配对完整，对应 item 状态为 `interrupted`。
- 重试：限流、过载、5xx 先由 Pi 重试，重试期间不向模型暴露中间错误；界面通过 `turn/retrying` 看到进度。
- 先核对 Pi 锁定版本的实际行为，把"Pi 已满足 / Harness Kit 补齐"逐条写进 `agent-host/CLAUDE.md`。

### 5. Core API

- NAPI：工作区打开与关闭、会话方法、排队操作、`transcript_window`、事件订阅；同步方法只做校验与入队（耗时预算 1 ms），结果经 Promise 或事件返回。
- NAPI 生成的 `.d.ts` 纳入 L1 快照。

## 实现要点

- steer 在当前步骤后插入、followUp 在回合结束后执行，两者都以 Pi 锁定版本的语义为准，差异写进 CLAUDE.md。
- 预热计时从 `open_workspace` 调用到 Agent Host 握手完成并恢复已打开会话为止。
- 空闲回收与重试测试用可注入时钟，不真实等待。
- 测试用 Core 的无头驱动与 T05 的 mock provider；T15 会把这些行为迁入 L2 场景格式，所以测试的工作区夹具、provider 脚本与断言写成数据，便于迁移。

## 验收标准

- [T14-A01] 投影 golden 测试覆盖第 5.3 节投影表的每一行、六种工具 item 类型与五种 item 状态，全部通过。验证：L1 测试输出（列出覆盖矩阵）。
- [T14-A02] Grep 无匹配等语义成功的工具调用投影为 `completed`，工具抛出错误投影为 `failed`。验证：golden 测试。
- [T14-A03] 排队项可编辑、删除、重排，`session/queueChanged` 反映新顺序，回合结束后按新顺序执行且不丢项、不重复。验证：场景测试（mock provider 请求断言）。
- [T14-A04] 运行中 steer 的内容在当前步骤后进入模型请求；followUp 在回合结束后作为新输入执行。验证：场景测试（mock provider 请求断言）。
- [T14-A05] 工具执行中 abort：每个未完成的工具调用都补齐"已中断"结果，下一次请求通过 mock provider 的配对校验，相关 item 状态为 `interrupted`。验证：场景测试。
- [T14-A06] 一条助手消息含 12 个只读调用、1 个写调用、2 个只读调用时，执行批次为 10、2、写、2，任一时刻并行数不超过 10，写调用单独执行。验证：测试（Core 侧并发计数断言）。
- [T14-A07] mock provider 注入 529 与 429 后恢复：客户端收到带 attempt、maxAttempts、delayMs 的 `turn/retrying`，后续发给模型的请求中不含这些错误。验证：场景测试。
- [T14-A08] 故障注入丢弃一条会话通知后，Core 用 `session/getEntries(since)` 补齐，客户端收到的事件完整且有序。验证：故障注入测试。
- [T14-A09] 打开工作区即启动 Agent Host，release 构建下到就绪的时间 10 次测量的最大值不超过 1.0 s；全部会话空闲达到配置阈值后进程被回收，再次 prompt 时自动恢复。验证：测量输出与测试（时钟可注入）。
- [T14-A10] 工作区列表与会话列表快照的 `revision` 单调递增；同一实体的旧 revision 快照不会覆盖新快照。验证：测试。
- [T14-A11] 重启 Core 后会话列表从索引恢复，resume 后发出的下一个请求带有完整历史，`transcript_window` 返回的条目与重启前一致。验证：测试。
- [T14-A12] 会话 create、resume、fork、close 可经 NAPI 调用，`.d.ts` L1 快照已更新。验证：测试与快照文件。
- [T14-A13] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新 `agent-host/CLAUDE.md`：投影规则位置、排队表、回合不变量中"Pi 已满足 / Harness Kit 补齐"清单。
- 创建或更新 `crates/piarc-core` 的 CLAUDE.md：actor 结构、取消传播、预热与回收、快照 revision 规则。
- 在架构第 7.4 节补充新增的 AHP 方法（补充型更新）。
