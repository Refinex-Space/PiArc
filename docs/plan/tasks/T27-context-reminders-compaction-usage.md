# T27 上下文工程：system reminder、压缩与用量

| 项 | 内容 |
|---|---|
| 阶段 | 3 M2 Harness 核心 |
| 依赖 | T26 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort xhigh，新会话 |
| 规模 | 大 |
| 关联验证项 | 无 |
| 关联需求 | FR-CX-03、FR-CX-04 |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T27`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

长会话能否保持质量，取决于三件事：动态信息不改写 system prompt（保住缓存与 thinking 连续性），上下文快满时压缩得及时且不丢关键状态，用户看得到上下文被什么占用。目前 memory 懒加载（T22）、rules 注入（T24）、hooks 上下文（T25）、任务清单提醒（T26）各自往对话里追加消息，压缩用的是 Pi 默认的摘要提示，也没有用量显示。

本任务把这些追加统一为一个 system reminder 通道，用 PiArc 自写的分节摘要提示替换 Pi 默认提示，按第 6.15 节的公式触发自动压缩并在压缩后重注入关键状态，同时提供按类别统计的上下文用量与界面。

完成后，压缩的触发、熔断、重注入与缓存断点位置都由 mock provider 请求断言锁定。

## 必读

1. 架构设计：
   - 第 6.6.1 节（段顺序与稳定性）、第 6.6.3–6.6.5 节
   - 第 6.15 节"自动压缩触发""压缩熔断""压缩摘要结构""压缩后恢复""缓存断点"五行
   - 第 6.3.2 节 PreCompact/PostCompact；第 8.2 节环境栏用量环与右栏上下文卡片
2. `docs/research/harness-reference-notes.md` 第 1.4 节；`docs/research/claude-official-capabilities.md` A6.2 与 C 节（Preserved thinking、Prompt caching）。
3. T22、T24、T25、T26 交付的代码与 CLAUDE.md：system prompt 组装、懒加载注入、hooks 的 PreCompact/PostCompact 挂载、`reminders` 模块与计划/任务清单注入接口。
4. 实现时查阅：Pi 锁定版本的压缩实现与设置项（manual / threshold / overflow 触发、`session_before_compact` 可替换的内容）、`sendMessage` 自定义消息、上下文 token 估算方式；pi-ai 的缓存策略。

## 范围

### 要做

- system reminder 统一通道，并把 T22、T24、T25、T26 的注入迁入。
- 压缩：自写摘要提示、阈值公式、自动压缩窗口上限设置、`/compact [重点]`、与 PreCompact/PostCompact 的衔接、熔断、压缩后重注入。
- 上下文用量统计、用量环与分类明细、压缩按钮。
- 缓存断点位置的 mock 断言。

### 不做

- Anthropic 服务端 context editing / compaction（T48）。
- 三档视图中"详细"档对 reminder 的展示（T29）。本任务把 reminder 投影为带标记的 item，默认不渲染。
- skill 的加载与 Skill 工具（T37）：重注入中的 skill 正文槽位按上限实现，用模拟的调用记录测试，T37 接入真实数据。
- 后台任务完成通知的来源（T32）：本任务提供该类 reminder 的入口。

## 交付物

### 1. system reminder 通道

- 在 T26 的 `reminders` 模块上扩展：每条提醒带类型（`todoStale`、`fileModified`、`planMode`、`backgroundTask`、`memoryLazyLoad`、`rulesMatched`、`hookContext`）、来源与正文，以 Pi custom message 追加，不改写已发送的 system prompt。
- 外部修改提醒：本会话读过的文件在下次模型请求前被外部修改时提醒模型。检测方式（请求前对文件状态表做 stat 比对，或用 notify 监听）二选一并写明理由。
- T22 的懒加载、T24 的 rules 注入、T25 的 `additionalContext` 全部改走本通道，删除各自的旧注入代码。
- 投影为带 `reminder` 标记的 item，客户端默认不渲染。

### 2. 压缩

- 摘要提示：经 `session_before_compact` 替换为 PiArc 自写的分节摘要提示，节固定为任务目标、关键决策、已改文件、错误与修复、待办、当前进展（可增节，结构写进文档）。提示词原创，提交前自查并在报告中记录自查方式。
- 触发阈值：当前上下文 ≥ W − min(O, 20K) − 13K（token）。O 为模型最大输出；W 为模型上下文窗口与用户设置的"自动压缩窗口上限"中的较小值（例如对 1M 窗口的模型限定 300K）。能用 Pi 的压缩设置表达就配置 Pi，不能时由 Harness Kit 在请求前判断并触发，选择理由写进文档。
- `/compact [重点]`：重点说明原样带入摘要请求。
- PreCompact 返回 block 时不压缩；exit 0 的 stdout 作为摘要指令并入摘要请求；PostCompact 收到摘要（挂载由 T25 完成，本任务保证与自写提示的衔接）。
- 熔断：同一会话连续 3 次自动压缩失败，或压缩后上下文仍不低于阈值，即停止自动压缩，向用户显示原因（压缩提示行），手动 `/compact` 仍可用。
- 压缩后重注入（全部经 reminder 通道，单个与合计都有上限）：

| 内容 | 规则 |
|---|---|
| memory | system prompt 中的 memory 段不变；以提醒形式加载过的子目录 memory、`paths:` rules 与会话中途的 memory 变更，按当前磁盘内容重新注入 |
| 当前计划 | 来自 T26 注入接口 |
| 任务清单状态 | 来自 T26 注入接口 |
| 已调用的 skill 正文 | 单个 ≤ 5K token，合计 ≤ 25K token |
| 最近读写的文件 | 最多 5 个，合计 ≤ 50K token，经 Core `fs/read` 读取当前内容；超出上限的只给路径提示 |

### 3. 上下文用量

- Agent Host 按类别统计：system prompt、工具定义、MCP 工具、memory、skills、对话、工具结果；经 `session/usage` 上报，`session/getContextUsage` 可查询。
- 真实服务商下以服务商报告的输入 token 为准，分类估算与之的差额计入"未分类"并在明细中显示。
- 客户端：环境栏用量环（75%、90% 两级提示）；会话右栏上下文卡片显示百分比、分类明细与压缩按钮（等价于不带重点的 `/compact`）。

### 4. 缓存断点

- Anthropic 线格式：system 分静态段与动态段分别缓存，每个请求只有一个消息级缓存断点；reminder 追加、压缩前后都保持这一布局。其他服务商按 pi-ai 的缓存策略。
- 用 T05 mock provider 的缓存断点校验断言位置与数量。

### 5. L2 场景与能力 ID

场景放在 `tests/scenarios/ctx-*.yaml`（用小窗口模型配置触发压缩），能力 ID 形如 `CAP-CTX-COMPACT-001`、`CAP-CTX-REMIND-001`、`CAP-CTX-USAGE-001`。

## 实现要点

- 阈值计算写成纯函数并单测边界（恰好等于阈值时触发，少 1 token 不触发）。模型窗口与最大输出来自 T21 的能力表；T29 的每模型设置可以覆盖窗口值，接口按此预留。
- 重注入的 token 计数与用量统计用同一套估算函数，避免两处口径不一致。
- reminder 正文与摘要提示都是 PiArc 自写文本，不参照 Claude Code 原文。
- 熔断状态按会话保存，新会话或用户手动压缩成功后复位。

## 验收标准

- [T27-A01] 上下文达到 W − min(O, 20K) − 13K 时触发自动压缩，少 1 token 时不触发；设置自动压缩窗口上限后 W 取较小值。验证：阈值函数单测与小窗口场景测试。
- [T27-A02] 摘要请求使用 PiArc 自写的分节摘要提示；`/compact 重点` 的重点说明出现在摘要请求中。验证：mock provider 请求断言。
- [T27-A03] PreCompact 返回 block 时不压缩；其 stdout 摘要指令出现在摘要请求中；PostCompact 收到摘要。验证：场景测试与 mock provider 请求断言。
- [T27-A04] 连续 3 次自动压缩失败或无效后停止自动压缩并向用户显示原因，手动 `/compact` 仍可执行。验证：场景测试。
- [T27-A05] 压缩后的请求中重注入了 memory、当前计划、任务清单、skill 正文（单个 ≤ 5K、合计 ≤ 25K token）和最多 5 个最近文件（合计 ≤ 50K token），超出上限的部分被截断或只给路径。验证：mock provider 请求断言。
- [T27-A06] 七类 reminder（`backgroundTask` 经测试入口触发）都以追加消息送达，注入前后 system prompt 字节一致；T22、T24、T25 的旧注入代码已删除。验证：mock provider 请求断言与代码检索（旧注入入口无引用）。
- [T27-A07] 本会话读过的文件被外部修改后，下一次模型请求中出现修改提醒。验证：场景测试。
- [T27-A08] mock provider 下各类别用量合计等于请求的输入 token；真实服务商口径下差额计入"未分类"。验证：测试。
- [T27-A09] 用量环在 75% 与 90% 显示两级提示，上下文卡片显示分类明细，压缩按钮触发压缩。验证：Playwright 流程与截图（`tmp/evidence/T27/`）。
- [T27-A10] Anthropic 请求的缓存断点位置与数量符合交付物 4，在 reminder 追加与压缩前后都成立。验证：mock provider 缓存断点断言。
- [T27-A11] 摘要提示与 reminder 文案的原创性自查已完成并记录在报告中。验证：报告内容。
- [T27-A12] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新 `agent-host/CLAUDE.md`：reminder 类型与入口、压缩阈值函数位置、重注入上限常量、熔断状态。
- 第 6.15 节中的数值若经场景调整，写回该表（补充型更新）。
