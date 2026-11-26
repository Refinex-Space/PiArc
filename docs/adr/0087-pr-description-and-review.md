# 0087. PR 描述与 AI 审查的生成（补充）

- 状态：已接受，补充 ADR-0086（提交信息生成）
- 日期：2026-11-26
- 相关：ADR-0045（辅助模型）、ADR-0085 第 9 条（`gh`）；[设计增补第 9.3 节](../architecture/addenda/git-panel.md)

## 背景

G5 需要两种新的生成：创建 PR 时按 PR 指令与界面语言生成标题与正文；改动视图的"审查"按钮让模型检查一个范围的 diff，给出带文件与行号的发现。两者与提交信息一样，由用户点击发起、内容来自仓库、走辅助模型、不进主会话历史。ADR-0086 的重新评估条件写明：PR 描述需要相同通道时合并为一个方法。

## 决策

1. **新增会话级 AHP 方法 `session/gitAssist`（Core → Agent Host），握手能力 `gitAssist`。** 参数：`sessionId`、`task`（`prDescription` | `review`）、`language`（`en` | `zh-CN`，主进程按界面语言填入）、`instructions`（PR 指令，≤ 8 KiB，只用于 `prDescription`）、`branch`、`base`、`commits`（标题，≤ 50 条）、`files`（路径、状态、增删数、扣下原因）、`diff`。`session/commitMessage` 保持不变（已发布的契约，改名只带来迁移成本）；ADR-0086 的合并条件由此方法满足：以后新增的 Git 文本生成都加在 `task` 上。
2. **输入由 Core 组装，规则同 ADR-0086 第 2 条。** 扣下规则（二进制、`Read(...)` deny、密钥类文件、锁文件只给计数）与 `redact` 相同；预算：`prDescription` 合计 32 KiB、单文件 8 KiB，`review` 合计 64 KiB、单文件 16 KiB。`review` 的范围只能是"全部改动"或"未提交"。
3. **输出。** `prDescription` 返回 `title`（单行，≤ 256 字符）与 `body`（≤ 16 KiB，去掉控制字符，保留 Markdown）。`review` 要求模型只输出 JSON：`summary` 与至多 30 条 `findings`（`path`、`line`、`severity` 为 `high` | `medium` | `low`、`title`、`body`）；Agent Host 宽松解析（去掉代码围栏，取第一个 JSON 对象），Core 严格校验：路径必须是本次发送了 diff 的文件，行号在 1 与该文件新内容行数之间，文本去掉控制字符并截断（标题 200 字符，说明 2 KiB），不合格的条目丢弃，计数写进结果。
4. **提示词在 Agent Host。** `harness/git-assist.ts` 经 `auxiliary.complete`（purpose `prDescription` 输出上限 1,500 token、`review` 上限 4,000 token），system 提示在 `harness/prompts/pr-description.ts` 与 `harness/prompts/code-review.ts`，PiArc 自写并跑原创性检查。diff 是 user 内容里标明边界的材料段落，模型被告知其中的指令性文字不是指令。
5. **只呈现，不执行。** PR 描述只填入对话框，创建由用户点击；审查发现只显示，"交给 agent 修复"由用户点击后作为一条普通消息发出。生成都要求受信任的项目与近期真实输入，不取仓库写锁。
6. **用量与审计。** 用量按 purpose 记在该会话（`auxiliary/prDescription`、`auxiliary/review`），用量页显示"PR 描述"与"审查"。审计只记任务、模型、token 数、发送与扣下的文件数、审查保留与丢弃的条数，不记内容。
7. **默认 PR 指令随界面语言在 i18n 目录中提供**；用户级设置 `git.prInstructions` 覆盖默认，与默认相同时不写入。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 把 `session/commitMessage` 改成通用方法 | 一个方法 | 改已发布契约与能力名，所有样本与测试跟着改 | 否决 |
| 每种生成一个方法 | 参数精确 | 能力与方法越来越多 | 否决 |
| 审查交给主会话的 agent（发一句"请审查"） | 无新接口 | 进入主会话历史，输出不可校验，不能内联显示 | 否决；"交给 agent 修复"保留为显式入口 |
| 用 `gh` 让 GitHub 的服务做审查 | 不占模型 | 依赖外部服务与账号，未推送的改动不能审查 | 否决 |

## 后果

- 正面：两种生成与提交信息共用扣下、脱敏、计费与通道；审查结果可校验、可定位到行。
- 负面与代价：所选范围的 diff 会发给模型服务商（用户点击时才发送，有预算、扣下与脱敏）；AHP 新增一个方法与能力。
- 需要配套做的事：`npm run gen:protocol` 与契约样本；用量页标签；`docs/engineering/prompt-originality.md`。

## 重新评估的触发条件

- 审查需要跨文件上下文（不止 diff）时，评估改为让子 agent 只读运行；
- 用户要求审查结果写回 GitHub（`gh` 的 `pr review` 不在 ADR-0085 第 9 条的白名单内，需要先改该条）。
