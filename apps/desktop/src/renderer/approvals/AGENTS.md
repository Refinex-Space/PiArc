# Approvals（T26 起）

计划审批卡、提问表单与计划面板（ADR-0042，架构第 6.5、8.2 节）。T20 的命令、文件改动、权限扩展审批卡仍在 `transcript/rows/ApprovalCard.tsx`；`transcript/rows/RowView.tsx` 按审批卡的 `kind` 分派到这里的 `PlanApprovalCard`、`QuestionForm`。

## 不变量

- 工具审批卡、计划卡、提问表单与 MCP 表单共用 `.approval-box` 外壳（透明行内的细线卡片，宽 `session.approvalWidth`）：一句话标题、淡底参数块、右对齐的决策区，主按钮带键帽（`aria-hidden`，快捷键另由 `aria-keyshortcuts` 声明）；焦点环画在外壳上，不画在透明的行上。
- 所有审批卡共用 `use-approval-keys.ts`：只有首个与滚动窗口相交的卡响应 Mod+Enter、Mod+Shift+Enter、Esc，出现后 400 ms 内与输入法合成期间不响应，Esc 要求卡片有焦点或 composer 为空；composer 里有草稿时 Mod+Enter、Mod+Shift+Enter 留给 composer 发送或排队（`approval-keys.ts` 的 `draftKeeps`，ADR-0103）。计划卡映射为批准并自动接受编辑、批准（之后编辑仍询问）、修改（光标进输入框；卡片在时 Esc 不再停止回合）；提问表单映射为提交、不回答（Mod+Shift+Enter 被吞掉不作答）。
- 答复经 `answer.ts` 发给 Core，名字是卡片的 `requestId`、`revision`、`connectionEpoch`；`stale`、`alreadyHandled` 时请 Core 重发快照，卡片只由新快照移除。
- 计划卡是决策栏（ADR-0103）：不重复计划正文（正文在上方的计划行，完整版在面板），只有标题、"打开计划"、一句说明、评论列表与按钮。左侧"停止"（`window.piarc.abort`，卡片随回合撤下）与"修改"（Esc，把光标放进输入框；有评论时换成"发送 N 条评论"），右侧"批准"（Mod+Shift+Enter，之后编辑仍询问）与"批准并自动接受编辑"（Mod+Enter）。
- 计划批准只发 `allowOnce` 加 `mode`（`acceptEdits` 或 `default`）；只发评论是 `deny` 加 `comments`。等待审阅时输入框发出的消息是对计划的回复（`plan-reply.ts`，`shell/Conversation.tsx` 调用）：先 steer，再 `deny` 加 `via: conversation` 与评论，顺序不能反（Pi 在本批工具之后、下一次请求之前取 steer）；Mod+Enter 排队不答复计划。提问表单每题必须有选项或自由回答才能提交。
- 行内评论的偏移是计划原文的 UTF-16 码元（ADR-0042 第 3 条）。面板显示渲染后的 Markdown（`PlanDocument.tsx`，解析用文件阅读器的 `useParsedDocument`），每块带 `data-src-start`、`data-src-end`；块内把渲染文字按顺序匹配回原文（`plan-source.ts`），选区与评论区间的换算在 `plan-dom.ts`（跳过按钮、`aria-hidden` 等渲染器加的文字）。评论标记与正在评论的段落是 Custom Highlight（`piarc-plan-comment`、`piarc-plan-comment-focus`，样式在 `app.css`），不改动渲染出的 DOM；代码高亮替换文本节点后由 MutationObserver 重画。选中文字弹出 `PlanCommentPopover.tsx`（Enter 保存、Shift+Enter 换行、Esc 关闭，放不下时翻到上方），点已评论的段落重新打开它。评论草稿在本窗口的 `plan-comments.ts`（按 `requestId`），不重叠、按起点排序，答复成功后清空；卡片列表点一条经 `planComments.open` 让面板打开它。
- 计划面板与右栏任务卡片在 `shell/harness-panels.tsx` 注册；面板的 `when` 读 Shell 计算的 `PanelContext.plan`、`tasks`（会话的 harness 状态与待批计划）。卡片出现时用 `showPanel('plan')` 把计划面板调到前面。
- 焦点（T43）：卡片出现时 `use-approval-focus.ts`（由 `useApprovalKeys` 调用，所有卡片共用）把焦点移到首张卡的容器（计划卡在焦点已在 composer 时不移，它邀请用户在那里回复），容器名称来自 `approval-label.ts`（类型与对象）；输入法合成期间等 `compositionend`；出现后 `APPROVAL_DELAY_MS` 内卡片控件上的 Enter、Space 被吞掉。审批快捷键不处理卡片与 composer 之外的文本框里的按键（`approval-keys.ts` 的 `typedElsewhere`）。

## 测试

- `npx vitest run apps/desktop/src/renderer/approvals`：渲染文字与原文的对应（跨加粗、链接、行内代码与块，渲染器加的按钮文字不计）、评论排序、重叠与修改、表单答复。
- `PIARC_EVIDENCE_TASK=plan-mode npx playwright test -c apps/desktop/playwright.config.ts plan-mode --project dev`：错过回合开始的窗口仍显示运行中、各种进入计划模式的路径都流式显示、输入框回复退回计划并排在计划之后、渲染计划上的评论与发送、批准、停止（mock 脚本 `e2e/scenarios/plan-*.json`）。
- `PIARC_EVIDENCE_TASK=T26 npx playwright test -c apps/desktop/playwright.config.ts t26-harness --project dev`：真实 Core、Agent Host 与 mock 下的计划卡、面板评论、两种批准、提问三种题型与超时、任务卡片、下一步建议（mock 脚本 `e2e/scenarios/t26-*.json`）。
