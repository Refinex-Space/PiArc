# T26 计划模式、任务清单、AskUserQuestion 与下一步

| 项 | 内容 |
|---|---|
| 阶段 | 3 M2 Harness 核心 |
| 依赖 | T25 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort xhigh，新会话 |
| 规模 | 大 |
| 关联验证项 | 无 |
| 关联需求 | FR-HN-01、FR-HN-02、FR-HN-03、FR-HN-06、FR-PM-01（计划） |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T26`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

需求场景 S2 是"大改动前先规划"：agent 只读探索，提交计划，用户评论、批准后执行，执行过程有任务清单。这一流程由四个宿主工具驱动：`EnterPlanMode`/`ExitPlanMode`、`TodoWrite`、`AskUserQuestion`、`SuggestNextSteps`。它们由 Harness Kit 注册，对所有服务商一致生效，客户端按工具参数做结构化渲染（`ui-reference-notes.md` 第 4 节）。

T23 已在裁决第 5 步拒绝 plan 模式下的写操作。本任务补上 plan 模式的其余部分：写工具调用在闸门处的拒绝理由、进入与退出时的追加消息、四个工具、计划卡与计划面板、任务卡与任务面板、提问表单和下一步建议。

完成后，S2 的完整流程可以在应用中走通，并由 L2 场景与 Playwright 用例覆盖。

## 必读

1. 架构设计：
   - 第 6.5 节全部、第 6.15 节"plan 模式"一行
   - 第 6.1.4 节中这四个工具的审批默认值、第 6.2.1 节 plan 模式
   - 第 6.6.1 节末段（会话中途变化以追加消息送达）、第 6.6.3 节
   - 第 7.4 节 `ui/ask`、`harness/todo`、`harness/plan`；第 8.2 节（计划卡、任务卡、下一步建议、右栏任务卡片、计划面板）
2. `docs/research/ui-reference-notes.md` 第 4 节；`docs/research/claude-official-capabilities.md` A2.1 中计划批准选项、A1 中这四个工具的说明。
3. T14、T19、T20、T23 交付的代码与 CLAUDE.md：投影、transcript 行组件、审批卡与热键、裁决第 5 步。
4. 实现时查阅：Pi 锁定版本的 `registerTool`、`sendMessage`（自定义消息）、工具结果 `details`、自定义 entry 的写法；Pi 官方示例 `todo.ts`（状态随分支回溯的做法）。

## 范围

### 要做

- `EnterPlanMode`、`ExitPlanMode` 与 plan 模式的工具可见性；计划卡、计划面板、批准时选择后续模式；计划保存为会话 entry。
- `TodoWrite`、任务卡、右栏任务卡片、长时间未更新提醒。
- `AskUserQuestion` 与提问表单（替换 T20 的占位卡）。
- `SuggestNextSteps` 与可点击的下一步建议。
- 供 T27 使用的注入接口：当前计划与任务清单状态的读取，以及一个提醒入队函数。

### 不做

- 通用 system reminder 通道、压缩后重注入（T27）。本任务的提醒走一个最小的 `reminders` 模块（入队函数 + Pi custom message），T27 在同一模块上扩展成统一通道，不另起一套。
- 回退与会话分支界面（T28）；子 agent 中移除这些工具（T31）。
- 三档视图（T29）。

## 交付物

### 1. 计划模式

- 进入方式：环境栏模式菜单选择"计划"，或模型调用 `EnterPlanMode`（不需审批）。进入后**工具列表保持不变**（架构第 6.5 节，避免 prompt cache 失效与 thinking 块丢失）：写工具与非只读命令都在裁决第 5 步被拒绝（T23），拒绝理由写明"当前处于计划模式，请先用 ExitPlanMode 提交计划"；进入与退出时各追加一条消息告知模型当前模式。约束不靠提示词，靠闸门。
- 模型用 `ExitPlanMode` 提交 Markdown 计划。该调用需要审批，审批界面就是计划卡：
  - transcript 中的计划卡显示计划摘要，计划面板（可停靠 tile）显示全文；
  - 用户可在计划面板中选中文本添加行内评论；
  - 三个选项：批准并自动接受编辑、批准并手动审批、继续规划。前两个切换到对应模式并写入转录；"继续规划"把评论作为反馈返回给模型，模式保持 plan。
- 计划文本保存为会话 entry，投影为 `harness/plan`；应用重启与会话恢复后可读回。

### 2. 任务清单

- `TodoWrite` 的参数风格与 Claude Code 一致（规范名兼容），描述文字自写；状态存在工具结果的 `details` 中，当前状态从当前分支上最近一次结果重建，因此随分支回溯。
- Core 从 `item/completed` 取出状态，投影为 `harness/todo`；客户端渲染 transcript 中的任务卡与会话右栏的任务卡片（进行中项高亮，完成计数）。
- 存在未完成项、且连续若干轮工具调用没有更新清单时，经 `reminders` 模块提醒模型。轮数阈值集中定义并写进 Harness Kit 的 CLAUDE.md。

### 3. AskUserQuestion

- 参数支持单选、多选、自由输入（选项外的"其他"）；经 AHP `ui/ask` 到客户端，以审批卡中的提问表单呈现，沿用 T20 的热键、400 ms 防误触与输入法守卫。
- 超时可配置：超时后按问题定义的默认选项继续，没有默认选项时返回"用户未作答"；两种结果对模型都是结构化的。
- 该工具需要用户交互，在任何模式下都显示表单（第 6.2.2 节 `requiresUserInteraction`）。

### 4. SuggestNextSteps

- 宿主工具，模型在回合结束时调用，参数是若干条建议（标题 + 要执行的输入）；调用立即返回，不阻塞回合。
- 客户端在回合末渲染建议，每条提供"在此执行"（作为本会话下一条输入发送）与"开始新会话"（在同一工作区新建会话，以该建议为首条输入）。

### 5. 注入接口与能力 ID

- 导出读取"当前计划"和"当前任务清单"的函数，供 T27 在压缩后重注入。
- 场景放在 `tests/scenarios/plan-*.yaml`、`todo-*.yaml`、`ask-*.yaml`、`next-*.yaml`，能力 ID 形如 `CAP-PLAN-MODE-001`、`CAP-TODO-BRANCH-001`。

## 实现要点

- 进入和退出 plan 模式前后，请求中的 system 与工具定义必须逐字节相同（`claude-official-capabilities.md` C 节"Preserved thinking"）。用 mock provider 的请求记录断言这一点。
- 计划卡与普通审批卡共用审批账本（revision、connectionEpoch），多窗口只接受第一个有效答复。
- 行内评论的锚点用计划文本的 UTF-16 偏移（第 7.7 节），评论随"继续规划"一起发送，格式自定并写进文档。
- 工具描述与提醒文案全部自写，不参照 Claude Code 原文。

## 验收标准

- [T26-A01] plan 模式下写工具调用与非只读 Bash 命令都在裁决处被拒绝，拒绝理由提示先提交计划；进入与退出 plan 模式前后请求中的 system 与工具定义逐字节不变。验证：场景测试中的 mock provider 请求断言。
- [T26-A02] 模型调用 `EnterPlanMode` 后进入 plan 模式且不需审批；`ExitPlanMode` 生成计划卡并等待用户决定。验证：场景测试。
- [T26-A03] 计划卡的"批准并自动接受编辑""批准并手动审批"切换到对应模式并在转录中留下模式切换记录；"继续规划"保持 plan 模式。验证：Playwright 流程与截图（`tmp/evidence/T26/`）。
- [T26-A04] 计划面板中的行内评论随"继续规划"送达模型，内容与锚点正确。验证：Playwright 流程与 mock provider 请求断言。
- [T26-A05] 计划文本保存为会话 entry，应用重启后可读回，注入接口返回同一内容。验证：测试。
- [T26-A06] 任务清单状态随分支回溯：在较早的 entry 处 fork 后，当前清单等于该处的状态。验证：场景测试。
- [T26-A07] 任务卡与右栏任务卡片随 `TodoWrite` 调用更新，进行中项与完成计数显示正确。验证：Playwright 截图。
- [T26-A08] 存在未完成项且连续达到阈值轮数未更新清单时，下一次模型请求中出现提醒消息，system prompt 字节不变。验证：场景测试中的 mock provider 请求断言。
- [T26-A09] AskUserQuestion 的单选、多选、自由输入三种题型都能作答并以结构化结果返回模型；超时后按默认选项继续，无默认选项时返回"用户未作答"。验证：测试（时钟可注入）与 Playwright 流程。
- [T26-A10] 下一步建议的"在此执行"把建议作为本会话下一条输入发送，"开始新会话"新建会话并以建议为首条输入。验证：Playwright 流程与 mock provider 请求断言。
- [T26-A11] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新 `agent-host/CLAUDE.md`：四个宿主工具的位置、`reminders` 模块、注入接口、提醒阈值。
- 更新渲染进程 `approvals` 与 `transcript` 模块的 CLAUDE.md：计划卡、提问表单、任务卡、下一步建议组件。
