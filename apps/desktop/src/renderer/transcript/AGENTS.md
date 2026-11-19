# Transcript

正式会话与开发原型共用这里的行组件。在 `store/transcript.ts` 的 `SessionTranscript` 归约 Core 事件和历史窗口，在 `rows/RowView.tsx` 按行与条目类型分派组件。新增行时同时覆盖历史、实时和本地化目录。协议、投影与用户输入的约定见 [ADR-0030](../../../../../docs/adr/0030-transcript-and-composer.md)。

## 行与历史

| 行 | 数据与交互 |
|---|---|
| 用户消息 | 用原始提及区间和附件引用显示胶囊。Core 确认前保留乐观行，未送达可原位重发。 |
| 回复正文 | Worker 增量解析 Markdown，闭合的代码块才高亮。复制 Markdown 使用源文本，复制纯文本使用块的文本表示。 |
| 思考块 | 生成中强制展开。结束后默认折叠，有起止时间才显示时长。 |
| 工具组摘要 | 连续工具条目归为一组，按动词、对象、增删行数汇总。展开后显示成员。 |
| Bash 卡 | 读取 `commandExecution.execution` 的 cwd、语义状态、退出码和截断落盘路径。运行满 10 秒才显示计时。 |
| 文件改动卡 | 读取 `fileChange.diff` 的计数、hunk 与降级信息，保留 Core 提供的路径。 |
| 压缩提示 | 使用 `contextCompaction` 中可用的原因和 token 计数。 |
| 错误卡 | 读取 `turn/completed` 的 `errorKind` 与 `retryable`。`session/uncertain` 有独立提示与重试按钮。 |
| Working 行 | 当前工具、计时、用量、自动重试次数和压缩状态由同一回合的事件驱动。 |

- 行只订阅自己的 ID，工具组额外订阅成员。行级错误边界把单条渲染失败限制在该行。会话页与新建页另由主区的页面边界保护，切换页面后重新挂载，侧栏仍可导航。显示模型文本、命令输出或路径一律用文本节点。
- Pi 历史 entry id 只在所属会话内唯一。窗口共享的 Markdown 结果、流式进度、行高与展开状态使用 `SessionTranscript.cacheKey(id)` 隔离各会话。
- 初次打开读最近 1,000 个 item，向上滚到距顶部 400 px 内再加载一页。重同步用整段历史窗口替换已确认的行，因为同一文本块的历史 ID 与实时 ID 可能不同。
- “选中本回合”按回合 ID 分组（含 steer），缺少标记的旧历史按用户消息分组。先让虚拟列表挂载整个选区，再创建 DOM Range。选择结束后释放额外挂载的行。

## 节奏与滚动

参数集中在 `constants.ts`。在真实事件流下运行 `npm run bench:t19` 复测，逐帧主线程工作量沿用 S1 的 CDP 口径。计时区间用 composer 的忙闲变化和最终 Markdown 绘制确定。Playwright 在计时后断言正文，避免其反复读取增长中的长消息影响 p99。

| 常量 | 含义 |
|---|---|
| `STREAMING.revealTauMs = 50`、`minCharsPerSecond = 120`、`maxBacklogChars = 400` | 按动画帧追上已收到的文本，尾部至少每秒显示 120 字符，积压至多 400 字符。 |
| `SCROLL_FOLLOW.releasePx = 2`、`resumePx = 40` | 用户向上滚到离底超过 2 px 时解除跟随，向下滚到离底 40 px 以内恢复。 |
| `SCROLL_FOLLOW.buttonPx = 200`、`userInputWindowMs = 150` | 离底超过 200 px 显示“回到底部”，用户输入后的 150 ms 内保留视口。 |
| `VIRTUAL_LIST.overscanViewports = 1` | 可见区上下各多挂载约一屏，尺寸按会话、行 ID 与宽度缓存。 |

宽度变化（经典滚动条出现或消失时占去或让出约 12 px：Windows，以及“显示滚动条”为“始终”或接了鼠标的 macOS）后 `virtualizer.measure()` 会清空全部行高，`TranscriptList` 随即先 `getTotalSize()` 按估算值重算测量结果，再对 DOM 中的行逐一 `resizeItem`：行自己的 ResizeObserver 不会再报告，与旧尺寸比较得不出差值，`measureElement` 又在列表滚动时跳过测量（贴底时宽度变化总伴随一次滚动），任何一步缺了这些行都停在估算高度上互相重叠（W1；`transcript-scroll.e2e.ts` 的变窄用例与 `t19-security.e2e.ts` 展开命令输出时复现）。

行内容和虚拟列表提交后在布局阶段检查贴底。`ResizeObserver` 处理尺寸变化。可见内容先增高、列表随后更新尺寸时，这两次提交都可能影响同一帧的滚动位置。

- 审批是 `SessionTranscript.setApprovals` 从 Core 实体快照追加的临时行，历史重载仍显示未处理的请求，重连后的新快照移除旧行。`rows/RowView.tsx` 把审批路由到 `ApprovalCard`、把 `permissionModeChanged` 显示为模式变更记录。快捷键与阅读闸门在 `rows/approval-keys.ts`，仅首个与滚动窗口相交的审批卡可响应。提问表单由 `shell/use-unsupported-questions.ts` 在窗口层拒绝，切换会话不影响答复。
