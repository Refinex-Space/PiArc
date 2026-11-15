# T15 无头驱动、L2 场景运行器与能力清单

| 项 | 内容 |
|---|---|
| 阶段 | 2 M1 可行走骨架 |
| 依赖 | T14 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 中 |
| 关联验证项 | 无 |
| 关联需求 | 无（测试基础设施；需求第 8 节"验收方式"依赖它） |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T15`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

从 T16 起，每个 Harness 行为都要用 L2 场景证明：无头运行 Core + 真实 Agent Host，模型侧接 T05 的严格 mock provider，按数据文件驱动，同时断言事件、文件副作用和发给模型的请求。能力完成状态由测试结果生成，不手工勾选，避免 claw-code 那种"两份能力清单互相矛盾"的漂移（`harness-reference-notes.md` 第 2.2 节）。

本任务建立这套基础设施：`piarc-devcli`、场景格式与运行器、能力清单与覆盖检查，并把 T14 及之前的行为补成首批场景。

完成后，新增一个 Harness 行为的标准做法是：写一个 YAML 场景，登记一个能力 ID，`npm run verify` 在两个平台上跑它。

## 必读

1. 架构设计：
   - 第 12.1–12.4 节（测试分层、严格 mock provider、场景数据文件、能力清单与覆盖）、第 12.6 节"测试纪律"
   - 第 7.1 节（piarc-testkit、piarc-devcli 的职责）
2. `docs/research/harness-reference-notes.md` 第 2.2 节第 9 条、第 2.3 节。
3. `docs/engineering/testing.md`。
4. T05、T06、T14 交付的代码与 CLAUDE.md：mock provider 的场景脚本与请求记录、Core 无头驱动、T14 中写成数据的测试夹具。

## 范围

### 要做

- `piarc-devcli`：不经 UI 运行 Core + 真实 Agent Host + mock provider，不随应用发布。
- 场景格式（YAML）、JSON Schema 与文档；运行器与可读差异输出；每个场景一个独立测试。
- `tests/capabilities.yaml`、覆盖检查（MISSING）、`docs/product/capabilities.md` 生成与漂移检查。
- 首批 ≥ 10 个场景（T14 及之前的行为）；L2 并入 `npm run verify`，两个平台 CI 都跑。

### 不做

- L3 行为对齐（T30）、L4 客户端测试（已由 T03 建立）。
- 新的 Harness 行为。本任务只把已有行为写成场景；发现与架构不符的行为时登记事项，不在本任务修复。

## 交付物

### 1. piarc-devcli

- Rust 二进制（`crates/piarc-devcli`），直接使用 piarc-core（不经 NAPI），启动 esbuild 打包后的 Agent Host 与 piarc-testkit 中的 mock provider。
- 命令行至少支持：运行单个场景、运行目录下全部场景、以 JSON 输出结果（供能力清单生成使用）。
- 打包检查：发布产物中不包含 devcli（在 T12 的产物检查脚本中加一条断言）。

### 2. 场景格式

一个场景描述一次完整的交互，字段与第 12.3 节一一对应：

```yaml
id: tools-read-basic            # 与文件名一致
capabilities: [CAP-TOOL-READ-001]
platforms: [macos, windows]     # 可选，缺省为两个平台
workspace:                      # 工作区夹具：初始文件
  files: { "src/a.ts": "export const a = 1;\n" }
providers:                      # mock provider 端点与逐步响应脚本，可定义多个
  main:
    wire: anthropic             # 或 openai
    steps: [...]
approvals: []                   # 审批应答序列
expect:
  events: [...]                 # 期望事件序列，部分匹配
  files: { ... }                # 期望的文件副作用
  requests: [...]               # 期望的请求断言（按端点名与请求序号）
```

- 一个场景可以定义多个 mock 端点（多服务商切换、子 agent 与辅助模型等后续场景要用），请求断言按端点名区分。
- 期望事件按"有序子序列 + 字段子集"匹配，忽略 id 与时间戳。
- `approvals`：按顺序回答 Core 发出的审批请求。T20 之前 Core 不产生审批请求；场景声明了应答却没有收到审批请求时判为失败，不静默通过。
- 格式写成 JSON Schema（`tests/scenarios/schema.json`），并在 `testing.md` 中写一节说明每个字段与匹配规则。

### 3. 运行器

- 位于 piarc-testkit（第 7.1 节）。每个场景在独立的临时目录中运行（路径含空格与中文），结束后清理。
- 每个场景是一个独立测试：可按名称单独运行，一个场景失败不影响其他场景执行与报告。
- 失败输出可读：期望事件未匹配时给出第一个未匹配的期望项与附近的实际事件；文件副作用给出差异；请求断言给出请求序号与不符的字段。
- 同一场景连续运行两次结果相同（确定性），不靠 sleep 等待。

### 4. 能力清单

- `tests/capabilities.yaml`：稳定 ID（`CAP-<领域>-<能力>-<三位序号>`，如 `CAP-TOOL-READ-001`）、描述、里程碑、对应需求编号、状态。
- **一次登记完整清单**：按需求规格第 4 章与架构第 6 章（含 6.0 能力矩阵、6.14 兼容矩阵）把 M1–M5 的全部能力登记进来。后续任务只改状态、补场景，不临时发明能力；确需新增时在报告中说明。
- 状态取值：
  - `planned`：尚未实现，不要求场景，`capabilities.md` 中显示"计划中"；
  - `active`：已实现，必须至少被一个场景引用，否则输出 MISSING 并使检查失败；
  - `blocked`：因外部原因（例如上游不支持）暂时无法实现，必须带 `reason` 与 `link`（issue 或登记事项编号），显示为 BLOCKED，不使检查失败。
- 实现某项能力的任务负责把它从 `planned` 改为 `active` 并补上场景。
- 双向映射：场景引用了清单中不存在的 ID 时检查失败。
- 里程碑门禁：`node scripts/plan/check-capabilities.mjs --milestone M2` 这类命令列出里程碑不晚于 M2、仍为 `planned` 的能力，供评审任务（R2–R6）使用。
- `docs/product/capabilities.md` 由命令从 L2 结果 JSON 生成（ID、描述、里程碑、覆盖场景、状态），排序稳定；verify 中重新生成并与已提交文件比较，不一致即失败，提示运行生成命令。

### 5. 首批场景（≥ 10 个）

从 T06、T07、T13、T14 已有的行为中选取，至少覆盖：两会话不同 cwd 互不串扰、六个规范名工具经 Core 执行、模型看到的工具名为规范名、未信任工作区不加载项目 Pi 扩展、steer、followUp、排队编辑、中断补齐配对、工具批次并发、可恢复错误重试。

### 6. 并入 verify

- `npm run verify` 增加 L2 步骤：先构建 Agent Host bundle，再运行全部场景，再做能力覆盖检查与 `capabilities.md` 漂移检查。
- 两个平台 CI 都运行；`platforms` 字段排除的场景在报告中列为"跳过（平台）"，并写明原因。

## 实现要点

- 第 12.6 节：找不到夹具或 mock 脚本时测试失败，不能直接 return。场景名与断言内容一致。
- 运行器只做"驱动 + 断言"，不复制 Core 的业务逻辑；需要 Core 提供的观测点（例如审批请求事件）通过公开接口获取。
- 数据驱动的 Rust 测试可以用自定义 test harness（`harness = false`）或数据驱动测试库实现，选定后写进 `testing.md`。
- 场景运行要快：Agent Host 每个场景冷启动的开销计入测试时长，必要时复用进程但保证会话与工作区隔离，选择写进 testing.md。

## 验收标准

- [T15-A01] 场景格式有 JSON Schema 与 `testing.md` 中的字段说明；字段缺失或类型错误的场景文件被拒绝，错误指出文件与字段。验证：测试。
- [T15-A02] `piarc-devcli` 不经 UI 运行单个场景与整个目录，并输出 JSON 结果；打包产物检查确认发布产物中没有 devcli。验证：命令输出与检查脚本输出。
- [T15-A03] 首批不少于 10 个场景全部通过，覆盖交付物 5 列出的行为；每个场景作为独立测试出现在测试报告中。验证：测试输出（列出场景名）。
- [T15-A04] 分别故意改坏一个场景的期望事件、期望文件、期望请求，运行器失败并给出可读差异；恢复后通过。验证：三次运行的关键输出。
- [T15-A05] 声明了审批应答但没有收到审批请求的场景判为失败。验证：测试。
- [T15-A06] 同一场景连续运行两次结果一致；场景在含空格与中文的临时路径中运行，结束后临时目录被清理。验证：测试。
- [T15-A07] `active` 能力的全部覆盖场景被删掉时输出 MISSING 并失败；`planned` 能力没有场景时不失败；`blocked` 能力缺少 `reason` 或 `link` 时失败；场景引用不存在的能力 ID 时失败。验证：四次运行的关键输出。
- [T15-A08] `docs/product/capabilities.md` 由命令生成且与测试结果一致；手工改动它后 verify 失败。验证：生成命令与 verify 的关键输出。
- [T15-A09] Windows CI 上 L2 步骤运行并通过。验证：CI 日志。
- [T15-A10] `tests/capabilities.yaml` 已登记 M1–M5 的完整能力清单，每项都能对应到需求编号或架构章节；`--milestone M1` 列出的未完成能力与 M1 剩余任务一致。验证：清单统计输出与抽查记录。
- [T15-A11] `npm run verify` 通过，输出中包含 L2 场景数与能力覆盖结果。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新 `docs/engineering/testing.md`：场景格式、能力 ID 命名、新增一个 L2 场景的步骤、运行与调试命令。
- 创建或更新 `crates/piarc-testkit` 与 `crates/piarc-devcli` 的 CLAUDE.md。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：场景运行器、事件部分匹配断言、能力覆盖检查。
