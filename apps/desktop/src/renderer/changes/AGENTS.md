# Changes、回退与分支（T28）

渲染进程只呈现 Core 的结果：回退计划、冲突判定、写回、hunk 反向应用与分支切换都在 Core 与 Agent Host（ADR-0044）。数据经 `window.piarc` 的 `rewindPreview`、`rewind`、`undoRewind`、`sessionChanges`、`discardChange`、`switchBranch`、`forkSession(id, beforeTurn)` 取得，返回 JSON 字符串，各自在 `rewind.ts`、`store/changes.ts`、`store/branches.ts` 校验后使用。

## 组成

| 部分 | 位置 | 说明 |
|---|---|---|
| 回退对话框 | `RewindDialog.tsx`、`rewind.ts` | 入口是用户消息行的"回退到这里"与 `/rewind`（Core 的内置命令，`CommandAction::Rewind`，先列出当前分支的消息）。四个选项、要恢复或删除的文件、冲突逐个选"保留 / 覆盖"、Bash 说明；执行后列逐文件结果并提供撤销。纯逻辑（选项、请求、结果解析）在 `rewind.ts` 并有单测 |
| Changes 面板与右栏卡片 | `ChangesPanel.tsx`、`DiffBody.tsx`、`panels.tsx`、`panel-state.ts` | 卡片经 `registerPanel` 注册在右栏（每个会话），面板在停靠区，开关状态只在 `panel-state.ts`；快捷键 `changes.toggle`（Mod+Shift+D，`shared/keybindings.ts`） |
| 分支切换 | `BranchSwitcher.tsx`、`use-branch-actions.ts` | 有兄弟分支的用户消息显示"‹ 2 / 3 ›"；回退后尚未发送时输入框上方列出可切回的分支（`BranchTail`）；"从这里分支"新建会话，消息经 `drafts.ts` 放进新会话的输入框 |
| diff 行内评论（T42，ADR-0060） | `comments.ts`、`DiffComments.tsx`、`DiffBody.tsx` 的 `Gutter` | 行号是按钮（Shift+点击扩成范围），评论绑定旧侧或新侧的行号范围并带摘录；按会话存 `localStorage`（`piarc.diffComments.<会话 id>`），diff 更新后 `reanchor` 先原位、再同侧按摘录找回，找不到标 `stale` 并保留文本；Mod+Enter（`isSendKey`）或"发送评论"把未失效的评论经 `formatComments` 拼成一条消息，空闲时 `prompt`，运行中 `followUp` 排队。消息格式只在 `formatComments` |
| 语言 | `language.ts` | 扩展名到高亮语言名，名字必须是 highlight worker 认识的（`transcript/highlight/languages.ts`） |

## 不变量

- 丢弃请求带 Core 给的 `version`（当前内容哈希）；Core 判定文件已变化时显示错误并重新取列表，不在旧 diff 上重试。
- 面板整体降级（`degraded`）时文件默认折叠，展开单个文件才经 `sessionChanges(id, path)` 取它的 diff，以纯文本显示；单文件降级同样显示纯文本，不高亮。二进制文件只能整文件丢弃。
- diff 行是文本节点与高亮 token（`CodeBlock` 的 `Token`，明暗两套颜色跟随 `prefers-color-scheme`），不从字符串建 DOM。
- 回退成功后的消息原文在对话框关闭时才交给输入框（`Conversation.tsx` 的 `rewoundText`）：对话框关闭时把焦点还给打开前的元素，而那条消息的按钮已随回退消失，输入框之后取得焦点。
- 回退与分支切换后 Core 在会话路由上发 `session/branchChanged`，`SessionTranscript` 整段重新加载历史窗口、任务清单与分支点（`store/transcript.ts`），组件不自己拼接行。
- 只被 Bash 改动的文件不在回退与 Changes 里：两处都显示说明（`rewind.bashNote`、`changes.bashNote`）。
- 评论只在渲染进程：Core 与 Agent Host 只看到普通消息。等待审批时审批卡的快捷键在捕获阶段监听整个窗口，评论编辑框里的 Mod+Enter 靠 `approval-keys.ts` 的 `typedElsewhere` 留给编辑框；新加的文本框同样受它保护。

## 测试

- 单测：`npx vitest run apps/desktop/src/renderer/changes apps/desktop/src/renderer/store`（`rewind.test.ts`、`language.test.ts`、`user-row.test.tsx`、`store/changes.test.ts`、`store/branches.test.ts`）。
- L4：`PIARC_EVIDENCE_TASK=T28 npx playwright test -c apps/desktop/playwright.config.ts t28-rewind --project dev`（面板、hunk 与文件丢弃、CRLF 与 BOM、Mod+Shift+D、降级、回退与撤销、焦点、分支切换、从这里分支、`/rewind`），mock 脚本在 `e2e/scenarios/t28-*.json`。
- 评论：单测 `comments.test.ts`（重新定位与失效、消息格式、快捷键）；L4 `PIARC_EVIDENCE_TASK=T42 npx playwright test -c apps/desktop/playwright.config.ts t42-comments --project dev`（两侧与范围、跨文件、编辑与删除、Mod+Enter 一次发送并断言 mock 收到的消息、运行中排队，亮暗截图在 `tmp/evidence/T42/`）。

## 易错点

- `.badge` 在 `app.css` 中有固定字号与颜色：面板与对话框的标签用自己的 `change-tag`。
- 高亮语言名不在 worker 的 `GRAMMARS` 里时 worker 抛出 `No grammar for …`，该文件不高亮：新增扩展名映射先查 `workers/highlight.worker.ts` 的 `GRAMMARS`。
