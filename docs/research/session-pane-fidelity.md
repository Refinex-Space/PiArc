# 会话主块对标差异表

> 2026-11-25 快照。参考 OpenClaudeDesktop `next-4.16336.0`（下称 REF，路径相对 `reference/OpenClaudeDesktop/next-4.16336.0/app`），对象是 Code 会话的主块：标题行、对话区、审批卡与输入区。决策记录见 [ADR-0078](../adr/0078-session-pane-reference.md)。数值单位为 CSS px 与 ms。

## 读法

- REF 运行在 `data-density=comfortable` 与 `data-cds-fizzy-lake="color panels type"` 下，下表的参考值都按这个组合换算。REF 的 compact 档对应 PiArc 的紧凑密度。
- REF 的对话字号随"聊天文字大小"变化（默认 m = 15/21）。PiArc 没有这项设置，舒适档取 m，紧凑档取 s（14/20），简体中文行高加到 24 和 22。
- 颜色只对齐层级（主文字、次文字、淡底、细线、强调、危险），色值仍取 PiArc 的令牌。REF 的主按钮是近黑色，PiArc 全应用的主按钮是强调色，本表沿用 PiArc。
- "处理"列：复刻＝按参考数值实现；改造＝保留参考的结构与层级，按 PiArc 的数据或约束调整；不适用＝PiArc 没有对应能力，或与不变量冲突。
- "状态"列：实现并截图核对后写"已对齐"与证据位置；不适用的写理由。证据目录是 `tmp/evidence/session-pane/`（本地，不入库），画廊截图由 `apps/desktop/e2e/session-pane.e2e.ts` 生成。

## 1. 基础令牌

| 项 | 参考来源 | 实测规格 | PiArc 现状 | 处理 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| 控件高度 | `public/assets/v1/c6a992d55-*.css`（`.cds-root` 与 panels 覆盖） | 舒适 28，紧凑 24；xs 24/20；嵌套 22/18 | `size.buttonHeight` 28/24 | 复用，新增嵌套高度 | 令牌生成与画廊测量 | 待实现 |
| 圆角 | 同上 | 控件 8/6，卡片 12/10，胶囊 5.5/4.5，代码块 8 | `radius.button` 8/6，`radius.lg` 10 | 新增会话卡片、胶囊圆角 | 同上 | 待实现 |
| 内距与间距 | 同上 | pad 6/8/12/16（紧凑 4/6/8/12），gap 8/12/16 | `space.1–5` 4/8/12/16/24 | 新增 pad-xs 6/4 | 同上 | 待实现 |
| 文字 | 同上与 `.epitaxy-transcript-typography` | 正文 15/21，卡片 body 14/20，footnote 13/17，caption 12/17，代码 13/19；CJK 正文行高 24 | `fontSize` 11/12/13/15/20，行高 1.55 | 新增会话字阶（含紧凑与中文行高） | 同上 | 待实现 |
| 层级色 | 同上（fizzy color） | 主 90%、次 60%、淡 47% 黑；淡底 5%、悬停 10%、细线 8%（暗色 5%、10%、4%） | 有主、次、禁用文字与不透明边框 | 新增淡底、淡底悬停、细线三个语义令牌 | 对比度检查与 axe | 待实现 |
| 动效 | 同上 | fast 60，snap 120（cubic-bezier(.32,.72,0,1)），base 200，slow 450；ease-out cubic-bezier(.165,.84,.44,1)；按下缩放 .975 | `motion.surface` 60、`fast` 120、`normal` 200，一条曲线 | 新增 snap 与 ease-out 曲线、显隐延迟 100 | 画廊录屏逐帧 | 待实现 |
| 焦点 | 同上（`--cds-focus-shadow`） | 1 px 强调色外圈加 6 px 柔光；行级为内嵌 1 px 强调色 | 全局 `border.focus` 描边 | 改造：沿用 PiArc 焦点色，行级用内嵌 1 px | 键盘走查截图 | 待实现 |
| 图标 | `src/generated/cds-core/shared-frame.mjs` | 图标字体，xs 12（线宽 1）、sm 16（1.25）、md 20（1.25） | 自绘 16 px 线框图标 | 改造：Lucide 经 `shell/icons.tsx` 统一出口，固定线宽 | 截图 | 待实现 |

## 2. 标题行

| 项 | 参考来源 | 实测规格 | PiArc 现状 | 处理 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| 行高与分隔 | `generated/titlebar-frame/*`、`src/source-titlebar.css` | 32 行高加上下 4 内距，底部 1 px 细线，总高约 44 | 44 px 标题栏（`size.titlebarHeight`） | 复刻细线与内距 | 截图测量 | 待实现 |
| 标题 | 同上 | 14/20、字重 500，可点重命名：悬停淡底、左右 6 内距、圆角 8 | 标题按钮与重命名输入 | 复刻 | 悬停、重命名截图 | 待实现 |
| 工具按钮 | 同上与 `src/code-ui.jsx` | 32×32 幽灵按钮，图标 20，间距 4，按下态淡灰底，tooltip 带快捷键 | `IconButton` 与会话工具 | 复刻尺寸与按下态 | 开合状态截图 | 待实现 |
| 溢出菜单 | `generated/code-current-v4/titlebar-fold-*` | 空间不足时按钮依次折入 "View options" | 窄窗由工具布局处理 | 不适用：PiArc 窄窗已由 ADR-0075 的分块布局切换，不再折叠标题按钮 | — | 不适用 |

## 3. 输入区

| 项 | 参考来源 | 实测规格 | PiArc 现状 | 处理 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| 外壳 | `src/source-composer.css`、`generated/code-composer-v4/chat-composer-shell.mjs` | 单行高 44，内距 8，圆角 14，亮 #fff 暗 #303030；1 px 细线环加 0 4 20 3.5% 阴影，聚焦 7.5%；200 ms 过渡 | 46 高、圆角 15、阴影 5.5% | 复刻 | 两档密度测量 | 已对齐：`gallery/composer/` 的 working、conversation 与 menu-mode |
| 编辑区 | `chat-composer-layout.mjs`、`source-composer-editor.css` | 15/21，最高 min(384, 40svh) 后内部滚动，占位色 #878787 | 15/24，自动增高 | 复刻行高与最高值 | 多行、长文截图 | 已对齐：`gallery/composer/` 的 working、conversation 与 menu-mode |
| 占位文字 | `src/composer-placeholder.mjs` | 空闲 "Type / for commands"；运行中 "⏎ to send, ⌘⏎ to queue for later" | 一句长占位；运行中提示在框下另起一行 | 改造：空闲短占位，运行中把 steer 与排队写进占位，删除框下提示行 | 截图、读屏名称 | 已对齐：`gallery/composer/` 的 working、conversation 与 menu-mode |
| 附件 | `composer-attachment-tiles.mjs` | 120×120 方块，圆角 12，细线环，右上 20 圆形移除按钮悬停才显示 | 文字胶囊 "IMG/PDF" | 改造：PiArc 发送前没有缩略图数据，做成 120×44 的文件卡（图标、名称、大小），移除按钮同参考 | 截图 | 待实现 |
| 提及 | `source-composer-editor.jsx` | 编辑器内是强调色文字，悬停淡底光晕，无胶囊底色 | 胶囊底色 | 复刻 | 截图 | 待实现 |
| `/` 面板 | `src/source-slash-menu.{jsx,css}` | 宽 240–512，最高 384，行高 28，左右 10，圆角 14，面板内距 6；匹配字加粗；描述在行尾 | 分组列表，行高 24 | 复刻尺寸；分组标题保留（PiArc 的命令来源有意义） | 键盘、筛选截图 | 已对齐：`gallery/composer/picker-*`、`menu-add-*` |
| `@` 面板 | `src/source-mention-dropdown.{jsx,css}` | 宽 420（有描述 560），行内距 (28−20)/2×8，16 图标 | 35rem 宽列表 | 复刻 | 截图 | 已对齐：`gallery/composer/picker-*`、`menu-add-*` |
| 添加菜单 | `src/source-composer-add-menu.jsx`、`src/source-menu.css` | 28 幽灵按钮；菜单最小 128、最大 320，圆角 12，内距 4，行内距 4×8 | `MenuPopup` | 复刻菜单尺寸（共享 `Menu`） | 截图 | 已对齐：`gallery/composer/picker-*`、`menu-add-*` |
| 发送与停止 | `composer-send-cell.mjs` | 28×28 幽灵图标按钮，图标 20；运行中草稿为空显示停止，有草稿显示发送；切换淡入 120（延迟 80）淡出 80；500 ms 内反向点击忽略 | 两个按钮同时出现 | 复刻 | 运行中切换录屏 | 已对齐：`gallery/composer/` 的 working、conversation 与 menu-mode |
| 麦克风 | 同上 | 空草稿时显示听写按钮 | 无听写 | 不适用：PiArc 没有听写能力 | — | 不适用 |
| Bash 模式与历史检索 | `src/source-composer.jsx` | `!` 进入命令模式；↑ 历史检索条 | 无 | 不适用：PiArc 没有这两项能力 | — | 不适用 |
| 排队条 | `src/source-queued-messages.{jsx,css}`、`generated/queued-bar-v4/*` | 折叠行高 44、圆角 12、淡底，"{n} 条排队 · 下一条预览"；展开后行内距 5，悬停显示操作；进出 120 ms 位移 6 | 列表 | 复刻（编辑、删除沿用现有 IPC；PiArc 没有拖动排序与"立即发送"） | 截图 | 已对齐：`gallery/composer/` 的 working、conversation 与 menu-mode |
| 提示带 | `src/source-session-notices.{jsx,css}` | 卡片圆角 12、细线环、页面底色，严重程度只体现在图标；200 ms 位移 4 出现 | `NoticeBar` 在主区顶部，整条警告底色 | 改造：会话提示移到输入框上方并用参考样式；全局提示仍在顶部 | 截图 | 待实现 |
| 环境栏 | `src/source-composer-row-chin.jsx`、`composer-row-chin.mjs` | 卡片下方 8，xs 行高 24，字号 13/20，次文字色；模型（推理强度作尾词）→ 模式 → 用量环；按钮内距 6、圆角 6 | 普通文字按钮，模型与强度分开 | 复刻顺序与尺寸；强度合并为模型按钮的尾词，菜单仍分开（快捷键不变） | 截图 | 已对齐：`gallery/composer/` 的 working、conversation 与 menu-mode |
| 用量环 | `usage-ring.mjs` | 24 按钮内 14 px 圆环，线宽 2，<75 强调、75–89 警告、≥90 危险，弧长 300 ms | `UsageRing` | 复刻 | 三档截图 | 待实现 |
| 模式菜单 | `src/source-permission-menu.{jsx,css}` | 标题 "Mode"，每行名称加说明，选中强调色勾，行尾数字快捷键 | `MenuPopup` 带说明 | 复刻 | 截图 | 已对齐：`gallery/composer/` 的 working、conversation 与 menu-mode |

## 4. 对话区与消息

| 项 | 参考来源 | 实测规格 | PiArc 现状 | 处理 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| 阅读列 | `src/source-transcript.{jsx,css}` | 宽 768，两侧留白 32（容器 ≤560 时 16），上下内距 48 | 768 加 16 内距 | 复刻 | 宽、窄窗测量 | 已对齐：`gallery/messages/` 的 conversation、messages |
| 回合间距 | `generated/code-transcript/c97f58e7c-*.mjs` | 用户消息上方 24（紧凑 20），回复内块间 20（紧凑 16） | 每行上下 8 | 复刻 | 测量 | 已对齐：`gallery/messages/` 的 conversation、messages |
| 上下渐隐 | 同上 | 顶部 32、底部 48 渐隐条，随滚动显隐 | 无 | 复刻（滚动驱动动画不可用时省略） | 截图 | 已对齐：顶部 32、底部 48 渐隐条由滚动驱动，减少动效与强制颜色下不画；`gallery/messages/markdown-*` |
| 回到底部 | `src/source-transcript.jsx` | 高 24、左右 6、圆角 8、距底 8 居中，细线环阴影，16 px 向下图标；有待审批时前加 6 px 强调点与 "Needs your input"；150 ms 淡入 | 文字胶囊 "回到底部" | 复刻，待审批变体用 PiArc 审批数据 | 截图 | 待实现 |
| 用户消息 | `generated/code-transcript/shared-2-*.mjs` | 右对齐，最宽 85%，内距 12×16，圆角 12，淡底 5%，15/21 | 640 宽、圆角 10、`action.surface` | 复刻 | 截图 | 已对齐：`gallery/messages/` 的 conversation、messages |
| 长消息折叠 | 同上 | 超过 300 高折到 200，底部 48 渐隐，"Show more/less" | 无 | 复刻 | 截图 | 已对齐：`gallery/messages/` 的 conversation、messages |
| 用户消息操作 | `code-transcript.mjs`（工具栏） | 气泡下右对齐，24 按钮 16 图标间距 3；悬停延迟 100 后 120 ms 淡入，离开 60 ms；顺序：复制、回退、分叉 | 文字按钮：复制、选中本回合、回退、分支 | 复刻为图标按钮加 tooltip；保留"选中本回合" | 悬停、焦点截图 | 已对齐：`gallery/messages/` 的 conversation、messages |
| 时间戳 | 同上 | 操作条首位相对时间 | 行模型没有时间 | 不适用：历史条目不带可靠时间 | — | 不适用 |
| 回复正文 | `c80ec48f8-*.mjs`、`chat-prose.mjs` | 15/21，段落内缩 4，行尾留白 clamp(0,(100%−384)×.175,56) | 15/1.55 | 复刻 | 截图 | 已对齐：`gallery/messages/` 的 conversation、messages |
| 回复操作 | 同上 | 最近一条常显，其余悬停显示；复制（勾 1200）等图标按钮 | 文字按钮：复制 Markdown、复制文本、选中本回合 | 复刻为图标按钮；反馈与章节不适用 | 截图 | 已对齐（改造）：只在回合最后一条回复下出现（与参考的回合尾操作一致），悬停或聚焦时显示；`gallery/messages/` |
| 新回复入场 | 同上 | 透明加 10 px 上移，1.1 s 弹簧 | 无 | 改造：只做 200 ms 淡入与 6 px 上移，避免流式时整块位移 | 录屏 | 已对齐（改造）：生成中的回复与发送中的消息 200 ms 淡入加 6 px 位移，滚动挂载的旧行不动画 |
| 未送达与发送中 | `shared-2-*.mjs` | 发送中次色脉冲；失败行下 caption 危险色 "Failed to send" 加 "Retry" | 文字状态 | 复刻 | 截图 | 待实现 |

## 5. Markdown 与代码块

| 项 | 参考来源 | 实测规格 | PiArc 现状 | 处理 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| 标题 | 主 CSS `.prose` 与 reply-type 覆盖 | h1/h2 17/24，h3–h6 15/21，字重 580；上方 3F/2.5F/2F/1.667F（F=11.25），下方 7.5 | 浏览器默认比例 | 复刻 | 截图 | 已对齐：`gallery/messages/markdown-*`（代码块保持横向滚动不软换行，与现有复制和测试一致） |
| 段落与列表 | 同上 | 块间 11.25；列表缩进 30，项内距 7.5、项间 3.75，标记次色；任务列表勾选框强调色 | 部分 | 复刻 | 截图 | 已对齐：`gallery/messages/markdown-*`（代码块保持横向滚动不软换行，与现有复制和测试一致） |
| 引用与分隔线 | 同上 | 左 4 px 细线、内距 1em、次色；hr 0.5 px | 有 | 复刻 | 截图 | 已对齐：`gallery/messages/markdown-*`（代码块保持横向滚动不软换行，与现有复制和测试一致） |
| 表格 | 同上 | 外框圆角 8 细线，表头字重 500 淡底，单元格 .4375em×.75em，最小宽 96，横向滚动 | 基础表格 | 复刻；"展开表格"对话框不适用（横向滚动足够） | 截图 | 已对齐：`gallery/messages/markdown-*`（代码块保持横向滚动不软换行，与现有复制和测试一致） |
| 行内代码 | 同上 | 等宽 .9em，危险色字，淡底，0.5 px 细线，圆角 .4em | 选中色底 | 复刻 | 截图 | 已对齐：`gallery/messages/markdown-*`（代码块保持横向滚动不软换行，与现有复制和测试一致） |
| 链接 | 同上 | 强调色，常驻下划线（偏移 3，40% 色），悬停全色，60 ms | 有 | 复刻 | 截图 | 已对齐：`gallery/messages/markdown-*`（代码块保持横向滚动不软换行，与现有复制和测试一致） |
| 代码块 | `c19e90103-*.mjs`、`src/source-code-block.css` | 圆角 8，内嵌 1 px 细线，13/19，上下 12、左 10+1ch；右侧按钮栏：复制图标（勾 1200）吸顶；语言标签 caption 次色 | 语言标签加文字复制 | 复刻；"运行"按钮不适用 | 截图、复制 | 已对齐：`gallery/messages/markdown-*`（代码块保持横向滚动不软换行，与现有复制和测试一致） |
| 数学公式 | 同上 | KaTeX，块级可横向滚动、可聚焦 | KaTeX | 复刻滚动与焦点 | 截图 | 已对齐（改造）：`math`、`latex` 代码块按 KaTeX MathML 显示，可横向滚动；对话解析器不识别行内 `$…$`，避免金额误判；`gallery/messages/markdown-*` |

## 6. 思考块

| 项 | 参考来源 | 实测规格 | PiArc 现状 | 处理 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| 标题行 | `generated/transcript-rows/group-status.mjs`、`generated/chat-thinking/*` | 一行 20，正文字号，淡色；悬停转次色；"Thought for Ns"；箭头 16 在文字后，展开转 90°（60 ms） | 三角字符在前 | 复刻 | 截图 | 已对齐：`gallery/thinking/` |
| 正文 | 同上 | 上 8，14/20 次色，pre-wrap；不做高度动画 | 次色斜体 | 复刻 | 截图 | 已对齐：`gallery/thinking/` |
| 生成中 | 同上与 `CdsShimmer` | 标签走光 3 s 线性；减少动效时纯色 | 静态文字 | 复刻，生成中仍强制展开（PiArc 不变量） | 录屏、减少动效截图 | 已对齐（改造）：标签走光，生成中仍强制展开并隐藏箭头（PiArc 不变量）；`gallery/thinking/` |

## 7. 工具行、工具组与 diff

| 项 | 参考来源 | 实测规格 | PiArc 现状 | 处理 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| 单行 | `generated/working-line-v4/turn-status.mjs` | 高 28/24，左右外扩 6；动词次色、对象主色；末尾 12 px 实心右箭头，展开转 90°（60 ms）；无悬停底色，整行可点；超长末尾 24 px 渐隐 | 圆点加文字摘要 | 复刻 | 截图 | 已对齐：`gallery/tools/` 的 tools、conversation 与 *-open-* |
| 状态词 | 同上 | 运行中走光，等待审批 "Needs approval" 警告色，失败 "Failed" 危险色，停止与拒绝次色 | 彩色圆点 | 复刻（状态与结果来自 Core） | 截图 | 已对齐（改造）：运行中走光，失败、拒绝、中断用结果词；"Needs approval" 不放在工具行上，待审批由审批卡与 working 行承担；`gallery/tools/` |
| 组摘要 | `generated/transcript-rows/rows-c24951e9f-*.mjs` | "Read 2 files, edited a file, ran a command"，只大写首词，最多三类加 "and N more actions" | "Read 3 files · Edited a.ts" | 复刻（中文按同样结构） | 截图 | 已对齐（改造）：保留 PiArc 的"· 分隔"句式与中英文案，动词次色、对象主色；单个调用展开直接显示内容，多个调用展开为细线卡片；`gallery/tools/` |
| 增删胶囊 | `generated/transcript-rows/diff-counts.mjs` | 高 22/18，caption 12 字重 500，圆角 5.5，左右 8，绿红 20% 底 | 彩色文字 | 复刻 | 截图 | 已对齐：`gallery/tools/` 的 tools、conversation 与 *-open-* |
| 展开成员卡 | `turn-status.mjs` | 上 8 下 6；卡片圆角 12，1 px 细线环，分隔线；成员格内距 8×12，行距 37；无高度动画 | 缩进列表 | 复刻 | 截图 | 已对齐：`gallery/tools/` 的 tools、conversation 与 *-open-* |
| 命令卡 | `generated/transcript-rows/turn-mark.mjs`（`xd`、`Na`） | 命令行代码底圆角 8，`$` 前缀次色；输出最高 400 滚动，失败时输出危险色；复制悬停显示 | 卡片加文字按钮 | 复刻；退出码与 cwd 改作尾部次色段（PiArc 有这些数据） | 截图 | 已对齐（改造）：行内"Ran ‹命令›"，退出码与时长作尾段，后台任务、截断与超时作常显说明行，展开后是 `$` 命令卡与输出；`gallery/tools/tools-open-*` |
| 文件改动 | `src/source-diff*.css`、`source-file-tool.css` | 行号列 3ch，增删行底色混合 12%（暗 20%），符号列 2ch，最高 400 滚动 | 表格 diff | 复刻 | 截图 | 已对齐：`gallery/tools/` 的 tools、conversation 与 *-open-* |
| 搜索、网页、MCP、通用 | `source-generic-tool.css` | 参数一行一项：键名等宽 70% 不透明，值次色；输出 400 滚动 | 预览 30 行 | 复刻 | 截图 | 已对齐：`gallery/tools/` 的 tools、conversation 与 *-open-* |
| 网页搜索 | 同上 | 行 "Searched web {query}"，正文为来源链接 | 卡片 | 改造：来源列表沿用原生确认 | 截图 | 已对齐（改造）："Searched web ‹查询›"，来源默认展开，链接仍经原生确认；`gallery/tools/` |
| 回合末改动卡 | `generated/r3b-transcript/turn-edits-card.mjs` | "Edited N files" 加 Undo、See all | 无 | 不适用：本期只改呈现；回合级撤销已有回退与 Changes 入口 | — | 不适用 |

## 8. working 行

| 项 | 参考来源 | 实测规格 | PiArc 现状 | 处理 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| 布局 | `generated/working-line-v4/working-line.mjs` | 最小高 28；20 px 标记槽悬挂进左侧留白（槽宽 20 加间距 12），文字与正文对齐 | 转圈加文字 | 复刻 | 测量 | 已对齐：`gallery/working/working-*`（窄于 560 px 时标记不悬挂，放进留白内） |
| 标记 | `activity-mark.mjs`、`spark-thinking.json` | 30 fps 精灵图，按活动换图；离场 400 ms，入场延迟 150 淡入 200 | CSS 转圈 | 改造：PiArc 自有标记（P、i 两字的 10 个方块按笔画依次点亮），思考慢、工具快、待审批静止加琥珀色脉冲；不使用火花标记 | 录屏、减少动效 | 已对齐（改造）：PiArc 的 P、i 十格标记，思考 1.8 s 一轮、执行工具 1 s 一轮，等待审批时整体以警告色 2 s 呼吸；入场延迟 150 ms 淡入 200 ms；逐帧证据 `gallery/working/mark-tool-*` |
| 文案 | 同上 | 停止中 > 重试 > 压缩 > 工具进行时 > "Working…"；思考分档 15/30/45/60 s | 当前工具名与 "Working" | 复刻优先级；思考分档文案自写 | 截图 | 已对齐（改造）：压缩 > 当前工具 > "Working"，待审批时改为"Needs your input"；工具标签保留 PiArc 的"工具 · 对象"句式；切换时 120 ms 上移 3 px 淡入 |
| 计时与 token | `elapsed-clock.mjs`、`count-tween.mjs` | 2 s 后出现，"12s / 1m 5s"，按整秒对齐；token 首次 1200 ms 计数补间 | 立即显示 "7 s"、token 数 | 复刻 | 截图 | 已对齐（改造）：2 s 后出现，沿用 PiArc 的本地化时长格式；token 数不做补间（每秒随计时刷新） |
| 待审批 | `source-approval-card.jsx` | 行内 "Needs your input" 警告色胶囊 | 无 | 复刻（PiArc 的待审批数） | 截图 | 已对齐：`gallery/working/approval-command-*` |

## 9. 审批卡

| 项 | 参考来源 | 实测规格 | PiArc 现状 | 处理 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| 外壳 | `src/source-approval-card.{jsx,css}` | 嵌在对话里，最宽 480，内距 16，圆角 12，1 px 细线环，无阴影无底色；块间 24；最高 60vh 内部滚动、边缘 28 渐隐；160 ms 淡入 | 全宽卡片、粗边框 | 复刻 | 各类卡截图 | 已对齐（改造）：最宽 560（PiArc 多一个"总是允许"，480 放不下四个决策），内距 16、圆角 12、细线环、无阴影无底色，最高 60vh，160 ms 淡入；获得焦点时卡片画 1 px 外框；`gallery/approvals/` |
| 标题 | `generated/question-card/card-header.mjs` | 14/20 字重 520 一句话 "Allow … to run?" | "Run command? Bash" 加徽标 | 复刻句式，助手名用 "PiArc 的智能体"（不用模型名） | 中英文截图 | 已对齐：一句话标题（命令、修改文件），参数块淡底圆角 5；`gallery/approvals/` |
| 参数块 | 同上 | 淡底、圆角 5、内距 12×16，13/19 等宽次色，pre-wrap | 代码块 | 复刻 | 截图 | 已对齐：一句话标题（命令、修改文件），参数块淡底圆角 5；`gallery/approvals/` |
| 决策按钮 | `generated/cowork-approval/shared-10-*.mjs` | 右对齐；拒绝与允许组间 16，组内 12；高 28；"Allow once" 主按钮带 ⌘↵ 键帽（18 高，圆角 4）；卡宽 ≤420 时纵排撑满 | 四个同级按钮 | 复刻层级；主色沿用 PiArc 强调色 | 截图、窄窗 | 已对齐（改造）：右对齐，拒绝 → 总是允许 → 本会话允许 → 仅本次（主按钮带 Ctrl/⌘ + Enter 键帽，其余热键用 aria-keyshortcuts）；主色沿用 PiArc 强调色；窄卡纵排；保留"Decline"文案 |
| 拒绝反馈 | `src/source-approval-card.jsx` | 行首 "Add feedback" 文字按钮，点开两行文本框；有内容时拒绝改名 "Deny with feedback" | 常驻输入框 | 复刻 | 截图 | 已对齐（改造）："Add feedback"移到详情末尾，点开两行文本框并聚焦，有内容时按钮变为"Decline with feedback"；t20、t22 先点开再填写 |
| 总是允许的规则 | — | 参考只给前缀说明 | 可编辑规则文本框，原生确认 | 改造：规则编辑收进 "Always allow…" 的展开区，原生确认不变（PiArc 不变量） | 截图、T23 L4 | 已对齐（改造）：规则编辑、长参数展开后才可总是允许、400 ms 防误触、首张可见卡响应、输入法守卫与原生确认全部保留；闸门提示放在决策行上方；t20、t23、t43-approval-focus 通过 |
| 阅读闸门 | `src/approval-read-gate-model.mjs` | 首末行都上屏才算读过；未读时允许按钮禁用并提示 "Scroll through …" | 展开后才允许"总是允许" | 改造：保留 PiArc 闸门逻辑（`approval-keys.ts`），提示文案与位置按参考 | 键盘与 L4 | 已对齐（改造）：规则编辑、长参数展开后才可总是允许、400 ms 防误触、首张可见卡响应、输入法守卫与原生确认全部保留；闸门提示放在决策行上方；t20、t23、t43-approval-focus 通过 |
| 热键 | `src/card-hotkeys-model.mjs` | Esc 拒绝，⌘↵ 允许一次，⇧⌘↵ 持久允许；400 ms 防误触；首张可见卡响应 | 同语义 | 保留，补键帽显示 | T20、T43 L4 | 已对齐（改造）：规则编辑、长参数展开后才可总是允许、400 ms 防误触、首张可见卡响应、输入法守卫与原生确认全部保留；闸门提示放在决策行上方；t20、t23、t43-approval-focus 通过 |
| 网络、沙箱、MCP、计划、提问 | `source-approval-card.jsx`、`source-plan-card.jsx`、`source-question-card.jsx` | 各自标题句式；计划卡只给 "Open plan"；提问卡行内距 16、单选 20 px 圆、分隔线 | 各自组件 | 复刻；计划卡保留预览折叠（PiArc 计划面板可不在场） | 截图 | 已对齐（改造）：同一卡片外壳；计划卡保留预览、评论与反馈（计划面板不一定在场）；提问卡每题一条淡底标题条、分隔线选项行、18 px 强调色单选；MCP 表单仍在对话框里填写；t26、t22 通过 |
| 答复后 | 同上 | 工具卡立即卸载；提问留下问答回执 | 行移除 | 复刻 | L4 | 已对齐：卡片由 Core 新快照移除，工具行继续显示其结果；提问留下问答行 |

## 10. 宿主卡片与状态行

| 项 | 参考来源 | 实测规格 | PiArc 现状 | 处理 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| 任务清单 | `generated/turn-box/turn-box.mjs`、`todo-list.mjs` | 卡片圆角 12 内嵌细线，内距 16，行距 8；完成 16 px 实心勾次色不划线，进行中转圈，待办空心圆 | 列表加 "1/3 done" | 复刻；保留计数 | 截图 | 已对齐（改造）：圆角 12 细线卡片、内距 16、行距 8，完成为 16 px 实心勾次色不划线，进行中转圈，待办空心圆；保留"1/3 done"计数；`gallery/cards/` |
| 下一步 | 同上 | 内距 16，回顾次色、问题主色，最多两个按钮首个为主；300 ms 位移 4 入场 | 卡片 | 复刻 | 截图 | 已对齐（改造）：同一卡片，首条建议的"Run here"为主按钮；PiArc 的建议是多条"标题 + 提示"，不是一句回顾加问题；`gallery/cards/` |
| 子 agent 卡 | `src/source-agent.{jsx,css}` | 行 "Ran agent {name}" 加模型；卡片内嵌细线圆角 8、悬停淡底 | 卡片 | 复刻；停止按钮保留（PiArc 有） | 截图 | 待实现 |
| 工作流、提案、评审发现 | `workflow-card-v4`、`proposal-group-v4`、`review-findings-v4` | — | 无 | 不适用：PiArc 没有这些能力 | — | 不适用 |
| 错误卡 | `src/source-turn-error.{jsx,css}` | 最小宽 min(480,100%)，圆角 12，细线环；淡底标题条 12×16 加 16 图标；"View details" 折叠；主按钮在最后 | 文本加按钮 | 复刻 | 截图 | 待实现 |
| 压缩提示 | `c80ec48f8-*.mjs` | 状态行样式（运行中走光），"Compacted conversation" | 两侧细线的居中文字 | 复刻 | 截图 | 待实现 |
| 模式变更 | — | 参考没有对应行 | 次色整行文字 | 改造：按状态行样式设计 | 截图 | 待实现 |
| 空会话与加载失败 | `src/source-transcript-states.{jsx,css}`、`generated/session-load-error/*` | 居中，标题 14/20 主色，说明 13/17，主按钮 "Retry" | 绝对定位文字 | 复刻（加载失败加重试） | 截图 | 待实现 |
| 加载骨架 | 同上 | 气泡条加三段灰条，2 s 呼吸，0.5 s 后淡入 | "加载中"文字 | 复刻 | 截图 | 待实现 |
| 选中与复制 | `src/source-transcript-selection.jsx` | 选中后浮条 "Start a side chat"、"Reply" | 系统选中 | 不适用：本期不新增会话间交互入口 | — | 不适用 |

## 统计

尚未开始实现。
