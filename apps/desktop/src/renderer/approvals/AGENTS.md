# Approvals（T26 起）

计划审批卡、提问表单与计划面板（ADR-0042，架构第 6.5、8.2 节）。T20 的命令、文件改动、权限扩展审批卡仍在 `transcript/rows/ApprovalCard.tsx`；`transcript/rows/RowView.tsx` 按审批卡的 `kind` 分派到这里的 `PlanApprovalCard`、`QuestionForm`。

## 不变量

- 所有审批卡共用 `use-approval-keys.ts`：只有首个与滚动窗口相交的卡响应 Mod+Enter、Mod+Shift+Enter、Esc，出现后 400 ms 内与输入法合成期间不响应，Esc 要求卡片有焦点或 composer 为空。计划卡映射为批准并自动接受编辑、批准并手动审批、继续规划；提问表单映射为提交、不回答（Mod+Shift+Enter 被吞掉不作答）。
- 答复经 `answer.ts` 发给 Core，名字是卡片的 `requestId`、`revision`、`connectionEpoch`；`stale`、`alreadyHandled` 时请 Core 重发快照，卡片只由新快照移除。
- 计划批准只发 `allowOnce` 加 `mode`（`acceptEdits` 或 `default`）；继续规划发 `deny` 加反馈与 `comments`。提问表单每题必须有选项或自由回答才能提交。
- 行内评论的偏移是计划原文的 UTF-16 码元：计划面板（`PlanPanel.tsx`）以原文文本节点加 `<mark>` 显示，容器里不能有原文以外的文字（编号用 CSS `::after` 显示），`selection.ts` 用 Range 的 `toString().length` 换算。评论草稿在本窗口的 `plan-comments.ts`（按 `requestId`），不重叠、按起点排序，答复成功后清空。
- 计划面板与右栏任务卡片在 `shell/harness-panels.tsx` 注册；面板的 `when` 读 Shell 计算的 `PanelContext.plan`、`tasks`（会话的 harness 状态与待批计划）。卡片出现时用 `showPanel('plan')` 把计划面板调到前面。
- 焦点（T43）：卡片出现时 `use-approval-focus.ts`（由 `useApprovalKeys` 调用，所有卡片共用）把焦点移到首张卡的容器，容器名称来自 `approval-label.ts`（类型与对象）；输入法合成期间等 `compositionend`；出现后 `APPROVAL_DELAY_MS` 内卡片控件上的 Enter、Space 被吞掉。审批快捷键不处理卡片与 composer 之外的文本框里的按键（`approval-keys.ts` 的 `typedElsewhere`）。

## 测试

- `npx vitest run apps/desktop/src/renderer/approvals`：选区偏移（含代理对与跨 `<mark>`）、评论排序与重叠、表单答复。
- `PIARC_EVIDENCE_TASK=T26 npx playwright test -c apps/desktop/playwright.config.ts t26-harness --project dev`：真实 Core、Agent Host 与 mock 下的计划卡、面板评论、两种批准、提问三种题型与超时、任务卡片、下一步建议（mock 脚本 `e2e/scenarios/t26-*.json`）。
