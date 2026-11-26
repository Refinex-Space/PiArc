# Git 工具、回退与分支（T28、ADR-0084）

右上角的工具 `changes` 自 ADR-0084 起是 Git 工具（标签"Git"，id、命令 id `changes.toggle` 与弹出窗口白名单不变）：仓库内显示 Git 的改动与提交视图，非仓库或没有 Git 时退回本会话的改动（`ChangesPanel.tsx`）。Git 的读写只经 `window.piarc.git(会话 id, 请求, opId?)` 与 `cancelGit(opId)` 到 Core（ADR-0085），渲染进程只校验答复的形状（`git/protocol.ts`）。

渲染进程只呈现 Core 的结果：回退计划、冲突判定、写回、hunk 反向应用与分支切换都在 Core 与 Agent Host（ADR-0044）。数据经 `window.piarc` 的 `rewindPreview`、`rewind`、`undoRewind`、`sessionChanges`、`discardChange`、`switchBranch`、`forkSession(id, beforeTurn)` 取得，返回 JSON 字符串，各自在 `rewind.ts`、`store/changes.ts`、`store/branches.ts` 校验后使用。

## 组成

| 部分 | 位置 | 说明 |
|---|---|---|
| 回退对话框 | `RewindDialog.tsx`、`rewind.ts` | 入口是用户消息行的"回退到这里"与 `/rewind`（Core 的内置命令，`CommandAction::Rewind`，先列出当前分支的消息）。四个选项、要恢复或删除的文件、冲突逐个选"保留 / 覆盖"、Bash 说明；执行后列逐文件结果并提供撤销。纯逻辑（选项、请求、结果解析）在 `rewind.ts` 并有单测 |
| Git 工具与右栏卡片 | `git/GitPanel.tsx`、`git/GitCard.tsx`、`panels.tsx`、`panel-state.ts` | 卡片经 `registerPanel` 注册在右栏（每个会话），工具注册在停靠区并经 `ToolHeaderContent` 占用标题行（视图切换、文件列表开关、范围、跳转到文件、显示菜单；宽度不足 380 px 时后两项进菜单）；`panel-state.ts` 转发卡片和快捷键 `changes.toggle`（Mod+Shift+D）的打开请求 |
| 改动视图 | `git/GitPanel.tsx` 的 `GitChangesView`、`git/FileColumn.tsx`、`git/GitDiff.tsx`、`git/GoToFile.tsx`、`git/model.ts` | 四种范围（全部改动 vs 基础分支、未提交、单个提交、本会话），范围按会话记在 `localStorage`（`piarc.git.scopes.v1`），显示选项记在 `piarc.git.display.v1`；文件列（树或平铺、按类别分组、可拖宽）、提交列表、diff（统一或并排、换行、词级、忽略空白、展开未改动行）、Mod+P 跳转与 F7/Shift+F7 跳到下一处改动；评论按范围存草稿并带范围标题（`comments.ts` 的 `scope`） |
| 提交视图 | `git/CommitView.tsx`、`git/BranchPopup.tsx`、`git/GitPrompts.tsx`、`git/actions.ts` | 同步栏（分支弹窗、领先落后、获取、拉取、推送、进度与取消）、合并或变基中的状态条、三态复选框的文件列表、提交信息（按会话草稿、生成与停止、修正、提交与提交并推送）、选中文件的已暂存与未暂存 hunk 按钮；写操作只经 `actions.ts` 的 `run`，失败变成面板内提示或对话框（检出冲突、推送被拒、首次推送、拉取方式、分支名） |
| 状态 | `git/state.ts` | 每个会话一份：状态、各范围的改动、提交、分支、进度；`core/git` 的 `changed` 让同一仓库的会话刷新，`progress` 给发起操作的会话。刷新时机：显示、窗口获得焦点、回合开始与结束、运行中每 10 秒、可见时每 3 秒探测指纹 |
| 本会话的改动 | `ChangesPanel.tsx`、`DiffBody.tsx` | 范围"本会话"与非仓库时的视图：按 hunk 丢弃只在这里（ADR-0084 第 3 条） |
| 分支切换 | `BranchSwitcher.tsx`、`use-branch-actions.ts` | 有兄弟分支的用户消息显示"‹ 2 / 3 ›"；回退后尚未发送时输入框上方列出可切回的分支（`BranchTail`）；"从这里分支"新建会话，消息经 `drafts.ts` 放进新会话的输入框 |
| diff 行内评论（T42，ADR-0060） | `comments.ts`、`DiffComments.tsx`、`DiffBody.tsx` 的 `Gutter` | 行号是按钮（Shift+点击扩成范围），评论绑定旧侧或新侧的行号范围并带摘录；按会话存 `localStorage`（`piarc.diffComments.<会话 id>`），diff 更新后 `reanchor` 先原位、再同侧按摘录找回，找不到标 `stale` 并保留文本；Mod+Enter（`isSendKey`）或"发送评论"把未失效的评论经 `formatComments` 拼成一条消息，空闲时 `prompt`，运行中 `followUp` 排队。消息格式只在 `formatComments` |
| 语言 | `language.ts` | 扩展名到高亮语言名，名字必须是 highlight worker 认识的（`transcript/highlight/languages.ts`） |

## 不变量

- 破坏性的 Git 操作（回滚、回滚 hunk、强制检出、强制推送、删除未合并分支、打开"始终强制推送"）由主进程原生确认，渲染进程不另弹确认，也不能跳过；回滚与删除分支的撤销只经提示条上的按钮（Core 内存里的记录）。
- 渲染进程不拼 git 命令、不判断受保护分支与信任：按钮的禁用只是提示，Core 再检查一次。
- 提交信息的语言由主进程按界面语言填入，提交指令取设置 `git.commitInstructions`，为空时用目录里的 `git.instructions.default`。
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

改动面板的文件名在当前会话的 Files 中打开，展开箭头独立控制 diff。路径的可达范围由当前会话的工作树确定。

## 易错点

- `.badge` 在 `app.css` 中有固定字号与颜色：面板与对话框的标签用自己的 `change-tag`。
- 高亮语言名不在 worker 的 `GRAMMARS` 里时 worker 抛出 `No grammar for …`，该文件不高亮：新增扩展名映射先查 `workers/highlight.worker.ts` 的 `GRAMMARS`。
