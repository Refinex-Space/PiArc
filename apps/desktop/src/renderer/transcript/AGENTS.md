# Transcript

正式会话与开发原型共用这里的行组件。在 `store/transcript.ts` 的 `SessionTranscript` 归约 Core 事件和历史窗口，在 `rows/RowView.tsx` 按行与条目类型分派组件。新增行时同时覆盖历史、实时和本地化目录。协议、投影与用户输入的约定见 [ADR-0030](../../../../../docs/adr/0030-transcript-and-composer.md)。

## 行与历史

| 行 | 数据与交互 |
|---|---|
| 用户消息 | 用原始提及区间和附件引用显示胶囊。Core 确认前保留乐观行，未送达可原位重发。T28 起带"回退到这里""从这里分支"（`TranscriptServices` 的可选动作，原型页没有）与分支切换控件（`changes/`）。 |
| 回复正文 | Worker 增量解析 Markdown，闭合的代码块才高亮。复制 Markdown 使用源文本，复制纯文本使用块的文本表示。Markdown 的工作区文件目标与外部 URL 在中间结构里分开。前者由所属会话在自己的 Files 面板定位，支持行号和行段；后者沿用主进程原生确认。 |
| 思考块 | 生成中强制展开。结束后默认折叠，有起止时间才显示时长。 |
| 工具组摘要 | 连续工具条目归为一组，按动词、对象、增删行数汇总。展开后显示成员。Read 的文件名可在所属会话的 Files 中打开，并定位到调用的起始行。 |
| Bash 卡 | 读取 `commandExecution.execution` 的 cwd、语义状态、退出码和截断落盘路径。运行满 10 秒才显示计时。 |
| 文件改动卡 | 读取 `fileChange.diff` 的计数、hunk 与降级信息，保留 Core 提供的路径。 |
| 压缩提示 | 使用 `contextCompaction` 中可用的原因和 token 计数；原因 `rewind` 是"从此处摘要"留下的分支摘要（T28）。 |
| 错误卡 | 读取 `turn/completed` 的 `errorKind` 与 `retryable`。`session/uncertain` 有独立提示与重试按钮。 |
| Working 行 | 当前工具、计时、用量、自动重试次数和压缩状态由同一回合的事件驱动。 |
| 子 agent 卡（T31） | `rows/subagent.tsx`：`subagent` 条目的 `subagent`（`SubagentState`，由 `subagent/*` 通知经 `SessionTranscript.onSubagent` 保持最新）给出任务名、类型、颜色、实际模型、状态、耗时、工具调用数、token、后台标记与警告；运行中显示当前活动与停止（`actions.stopSubagent`）。展开后 `ChildTranscript` 经 `actions.subagentTranscript` 读子会话的历史窗口，用同样的行组件只读显示（新的 `SessionTranscript`，不提供重试与回退），状态或工具调用数变化时重新读取。子 agent 条目不进工具组。 |
| 宿主工具（T26） | `rows/harness.tsx`：`TodoWrite` 是任务卡（从参数读清单，Claude Code 的 `in_progress` 换成 `inProgress`），`ExitPlanMode` 是计划卡（状态取条目状态），`AskUserQuestion` 列出结果首行之后的 JSON，`SuggestNextSteps` 是下一步建议（"在此执行"经 `SessionInput`，运行中为 follow-up；"开始新会话"走 `startSession`；没有窗口外壳的原型页不显示按钮）。这四个工具不进工具组（`store/transcript.ts` 的 `OWN_ROW_TOOLS`）。 |

- 思考块、工具与工具组、Bash、文件改动、网页搜索共用 `rows/parts.tsx` 的 `StepRow`（次色动词、主色对象、尾段与结果词、末尾箭头、运行中走光、常显说明行），增删胶囊与复制按钮也在这里；新的工具行先用它，不另写标题行。working 行的活动标记是 PiArc 自己的 `rows/ActivityMark.tsx`。回复的复制与选中本回合只出现在回合的最后一条回复上（`services.ts` 的 `useEndsTurn`，按布尔值订阅，流式期间不触发额外渲染）。
- 行只订阅自己的 ID，工具组额外订阅成员。行级错误边界把单条渲染失败限制在该行。会话页与新建页另由主区的页面边界保护，切换页面后重新挂载，侧栏仍可导航。显示模型文本、命令输出或路径一律用文本节点。
- Pi 历史 entry id 只在所属会话内唯一。窗口共享的 Markdown 结果、流式进度、行高与展开状态使用 `SessionTranscript.cacheKey(id)` 隔离各会话。
- 初次打开读最近 1,000 个 item，向上滚到距顶部 400 px 内再加载一页。重同步用整段历史窗口替换已确认的行，因为同一文本块的历史 ID 与实时 ID 可能不同。
- “选中本回合”按回合 ID 分组（含 steer），缺少标记的旧历史按用户消息分组。先让虚拟列表挂载整个选区，再创建 DOM Range。选择结束后释放额外挂载的行。

## 无障碍（T43）

- 列表是 `role="feed"`、每行 `role="article"`（`TranscriptList` 的 `RowFrame`，子 agent 的转录用 `RowView.tsx` 的 `RowArticle`），名称来自 `row-label.ts` 的 `rowLabel`（与行显示的文字共用消息）；回合运行时 feed `aria-busy`；没有行时（历史读取中、读取失败、空会话）滚动容器不是 feed，由 `shell/Conversation.tsx` 的状态块说明（空 feed 违反 axe 的 `aria-required-children`）。不要改回 `role="log"`：它隐含 `aria-live`，逐字播报流式输出。
- 行 kind 在 `src/shared/row-kinds.ts` 的 `ROW_KINDS`：新增行类型加 kind 与名称（`rowKind` 的穷尽检查），并登记到 `e2e/a11y/states.ts`。
- 会话的 live region 是 `LiveRegion.tsx`（挂在 `Conversation` 的 transcript 上下文里）：运行中的进展至多每 `LIVE_ANNOUNCE.intervalMs` 播报一次，回合结束播报一次结果；节流在 `live-announcer.ts`（可注入时钟，测试用假时钟统计次数）。L4 按文字找回复时限定在 `agent-message` 里，live region 会重复结果。
- 代码高亮的主题在 `highlight/themes.ts`（GitHub 高对比度两套，浅色的注释灰换成主题里更深的灰），`themes.test.ts` 核对每个 token 在代码与 diff 底色上不低于 4.5:1；明暗跟随应用的主题选择（`use-color-scheme.ts`，I186），不只看系统。

## 三档视图（T29）

- `detail.ts`：普通（隐藏 `reasoning` 行与 `reminder` 行）、思考（隐藏 `reminder` 行，默认档，保持 T19 起的显示）、详细（全部显示）。过滤在 `useShownRowIds`，store 里 `reminder` 条目照常归约（T27 的 `HIDDEN_ITEMS` 已去掉）。详细档里 `useExpanded` 的默认值为展开、键加 `detailed:` 前缀，所以详细档的展开选择不影响其他档。选择按会话存在渲染进程内存（`chooseDetail`），不持久化。新增行类型时在 `shownIn` 决定它属于哪一档。

## 节奏与滚动

参数集中在 `constants.ts`。在真实事件流下运行 `npm run bench:t19` 复测，逐帧主线程工作量沿用 S1 的 CDP 口径。计时区间用 composer 的忙闲变化和最终 Markdown 绘制确定。Playwright 在计时后断言正文，避免其反复读取增长中的长消息影响 p99。

| 常量 | 含义 |
|---|---|
| `STREAMING.revealTauMs = 50`、`minCharsPerSecond = 120`、`maxBacklogChars = 400` | 按动画帧追上已收到的文本，尾部至少每秒显示 120 字符，积压至多 400 字符。 |
| `SCROLL_FOLLOW.releasePx = 2`、`resumePx = 40` | 用户向上滚到离底超过 2 px 时解除跟随，向下滚到离底 40 px 以内恢复。 |
| `SCROLL_FOLLOW.buttonPx = 200`、`userInputWindowMs = 150` | 离底超过 200 px 显示“回到底部”，用户输入后的 150 ms 内保留视口。 |
| `VIRTUAL_LIST.overscanViewports = 1` | 可见区上下各多挂载约一屏，尺寸按会话、行 ID 与宽度缓存。 |

宽度变化（经典滚动条出现或消失时占去或让出约 12 px：Windows，以及“显示滚动条”为“始终”或接了鼠标的 macOS）后 `virtualizer.measure()` 会清空全部行高，`TranscriptList` 随即先 `getTotalSize()` 按估算值重算测量结果，再对 DOM 中的行逐一 `resizeItem`：行自己的 ResizeObserver 不会再报告，与旧尺寸比较得不出差值，`measureElement` 又在列表滚动时跳过测量（贴底时宽度变化总伴随一次滚动），任何一步缺了这些行都停在估算高度上互相重叠（W1；`transcript-scroll.e2e.ts` 的变窄用例与 `t19-security.e2e.ts` 展开命令输出时复现）。

行内容和虚拟列表在布局阶段发出贴底请求，同一轮 React 提交的请求合并到绘制前的一个微任务，只读取一次最终布局。贴底时由 ScrollFollow 负责下边界；用户离开底部后，虚拟列表才按行键锚定前插的历史。流式播报直接订阅当前回复，节流器实际发布时才读取并格式化最新进展。`ResizeObserver` 处理尺寸变化。可见内容先增高、列表随后更新尺寸时，这两次提交都可能影响同一帧的滚动位置。

- 审批是 `SessionTranscript.setApprovals` 从 Core 实体快照追加的临时行，历史重载仍显示未处理的请求，重连后的新快照移除旧行。`rows/RowView.tsx` 把审批路由到 `ApprovalCard`、把 `permissionModeChanged` 显示为模式变更记录。快捷键与阅读闸门在 `rows/approval-keys.ts`，由 `approvals/use-approval-keys.ts` 接到各审批卡，仅首个与滚动窗口相交的审批卡可响应。计划卡与提问表单见 [approvals/AGENTS.md](../approvals/AGENTS.md)。
- 会话的计划与任务清单在 `SessionTranscript.harness`（`store/harness.ts`）：历史窗口的 `harness` 给初值，之后跟随 `harness/todo`、`harness/plan`；右栏任务卡片（`TaskPanel.tsx`）与计划面板只读这里。
- 滚动跟随只把按住滚动条后的松开算作用户输入：卡片按钮的点击不能挡住其结果引起的贴底（T26，`scroll-follow.test.ts`）。
