# 无障碍与本地化

PiArc 的界面要能只用键盘完成全部功能，在 VoiceOver、Narrator、NVDA 下可用，遵循减少动态效果、高对比度与 Windows 强制颜色，并提供简体中文与英文（NFR-06、NFR-07，架构第 8.7 节）。这份文档写规则、自动化检查的维护方式和读屏核对清单；实现位置见 `apps/desktop/AGENTS.md` 的 T43 一条。

## 1. 规则

**语义与名称**

- 控件用原生元素（`button`、`input`、`select`）；只有在原生元素做不到时才加 `role`，并补齐它要求的属性（例如可聚焦的 `separator` 要有 `aria-valuenow`、`aria-valuemin`、`aria-valuemax`）。
- 每个控件都有可访问名称，且名称包含可见文字（WCAG 2.5.3）：快捷键按钮用 `aria-labelledby` 组合命令名与按键，不用另写一段 `aria-label` 盖掉可见文字。
- 可访问名称与可见文案共用 i18n 目录，不另写一套。
- 每块区域在一个 landmark 里：侧栏是 `nav`，会话主区是 `main`，右栏与停靠区是各自带名称的 `aside`。同类 landmark 名称不同。
- 标题层级连续：页面 `h1`，区块 `h2`，区块内的分组 `h3`。

**transcript**

- 消息列表是 `role="feed"`，每行是 `role="article"`，名称来自 `transcript/row-label.ts`（"工具调用：读取 notes.txt，完成"），回合运行时 `aria-busy`。不要改回 `role="log"`：它隐含 `aria-live`，会逐字播报流式输出。
- 新增行类型时在 `src/shared/row-kinds.ts` 加一个 kind、在 `row-label.ts` 写它的名称（类型检查要求），并在状态清单里加一条。
- 流式进展只经会话的 live region（`transcript/LiveRegion.tsx`，`aria-live="polite"`）播报：回合运行中至多每 `LIVE_ANNOUNCE.intervalMs`（5 秒）一次，回合结束时播报一次结果。节流在 `transcript/live-announcer.ts`。

**焦点**

- 键盘导航用 `:focus-visible` 显示 2 px 的单层轮廓。一般控件把轮廓画在边框内，行内链接、实心主按钮、分隔条与原生勾选控件在外侧留出间距。焦点色取 `border.focus`，在普通与高对比度的明暗主题中与相邻表面均须达到 3:1。强制颜色沿用系统色。
- 由可见元素代画焦点时，用 `:has(具体目标:focus-visible)` 限定归属。编辑消息时标记编辑框，Tab 到附件时只标记附件标签。分段单选由原生 radio 接收焦点；选中面是装饰层，键盘聚焦选中项时隐藏它的边缘阴影，在对应标签上画单层轮廓；弹出菜单标记当前活动菜单项。`:focus-within` 适合让整行的操作按钮保持可见。
- 浏览器也会让鼠标点入的文本输入匹配 `:focus-visible`。应用窗口记录本次聚焦的输入方式。指针聚焦用 `:focus` 在输入框边缘显示 1 px 的轮廓，继续打字时保持；鼠标点入终端时由终端光标反馈。下一次键盘移动焦点时恢复 2 px 指示器。
- 对话框（`shell/Dialog.tsx`）打开时焦点进入、Tab 不出框、Esc 关闭、关闭后焦点回到打开它的元素；内容原地换掉时传 `focusKey`，否则原来的焦点元素被移除，焦点落到 `<body>`。
- 审批卡出现时焦点移到卡片容器（`approvals/use-approval-focus.ts`），卡片名称写明类型与对象（`approvals/approval-label.ts`）；输入法合成期间等合成结束；出现后 400 ms 内卡片里的 Enter、Space 不生效。审批快捷键不拦截卡片与 composer 之外的文本框（`typedElsewhere`）。
- 关掉含焦点的停靠面板（终端、Changes）时，焦点交给会话的输入框。
- Tab 顺序按区域：侧栏 → 会话主区 → 右栏 → 停靠区。

**操作按钮**

- 设置次级操作以 OpenClaudeDesktop `next-4.16336.0` 账户页的 Refresh 和 Manage keys 为基准（`app/src/source-account-settings.jsx`、`source-settings-button.css`）。小号表面在舒适 / 紧凑密度下高 28 / 20 px、圆角 7 / 5 px、水平内距 10 / 6 px。普通号高 28 / 24 px。原生按钮热区至少高 24 px。
- 软填充、内缘和阴影由装饰层绘制。悬停和按压按参考使用 60 ms 表面过渡，键盘操作继续使用 `:focus-visible` 单轮廓。等待时原标签保留在布局和无障碍树中，按钮暴露 `aria-busy`，阻止再次激活。强制颜色使用系统按钮色，减少动效时进度标记静止。

**纵向交互列表**

- 设置导航与会话行沿用侧栏行高（舒适 32 px、紧凑 26 px）及中圆角。菜单和候选行用小圆角、按内容增高，名称、说明与文件路径可占多行。水平内距沿用各组件的间距令牌。
- 将 `.interactive-list` 放在排列可操作行的容器上。行间留出一个 `space.1`（舒适 4 px、紧凑 3 px），由各行绘制悬停和选中背景。留白不接收行操作。含详细内容的 Changes 文件组沿用 `space.2`。
- 滚动候选列表时键盘焦点留在输入框或菜单上，方向键应让当前项完整可见。设置侧栏在较矮窗口里可以独立滚动。

**颜色与动效**

- 颜色只来自设计令牌；文字对比度 4.5:1（大字与图形 3:1），verify 第 15 步检查令牌对，axe 检查实际页面。
- 代码高亮用 GitHub 高对比度主题（`transcript/highlight/themes.ts`），每个 token 在代码背景与 diff 增删底色上都不低于 4.5:1（`themes.test.ts`），并跟随应用的主题选择。
- 侧栏在 macOS vibrancy / Windows Mica 上叠一层 90% 的自身底色，axe 看不到系统材质，按白底计算也达标。
- 状态不只靠颜色：徽标靠形状和字符（`!`、`?`），工具状态点有隐藏文字与 `title`；强制颜色下改用系统色的形状（`forced-color-adjust: none` 只用于这些小标记）。
- 强制颜色下主按钮用 `ButtonFace`/`ButtonText`：系统会在文字后面画 Canvas 色的衬底，反色方案的文字会被盖住。
- `prefers-reduced-motion` 或应用内开关打开时 `data-reduce-motion="true"`，动画与过渡时长为 0。`prefers-contrast: more` 选高对比度令牌。
- 可点击的小目标至少 24 × 24 px，或与相邻目标间隔 24 px（WCAG 2.5.8），例如 diff 行号按钮。

**本地化**

- 界面字符串只来自 `apps/desktop/src/shared/i18n/` 的目录（ICU MessageFormat，英文与简体中文同键）；主进程的菜单、原生对话框、通知同样经 `AppShell.t()`。
- 中文只有 `other` 一个复数类别：要按数量区分措辞时写 `=1 {…}`，`one {…}` 在中文里永远不匹配。
- 数字与日期按应用语言格式化：渲染进程用应用上下文的 `format.number`、`format.dateTime`（`app/app-context.tsx`），不调不带 locale 的 `toLocaleString()`。
- 产品名、文件名、协议名等固定写法用 `// i18n-exempt: <理由>` 注释说明，检查脚本放行。

## 2. 自动化检查

| 检查 | 位置 | 何时失败 |
|---|---|---|
| axe（WCAG 2.0–2.2 A/AA 与最佳实践），亮色与暗色 | `apps/desktop/e2e/t43-a11y.e2e.ts`，报告在 `tmp/evidence/<任务>/axe/` | 状态清单里任何一条有违规，或有一条本次运行没到达 |
| 状态清单覆盖 | `apps/desktop/e2e/a11y/states.test.ts`（Vitest，verify 第 5 步） | 渲染进程注册的设置页（`registerSettingsPage`）、面板（`registerPanel`）、渲染 `<Dialog>` 的文件、transcript 行 kind（`ROW_KINDS`）有没登记的 |
| i18n | `scripts/ci/check-i18n.mjs`（verify 第 16 步） | 两种语言键集合不同；ICU 无效；两种语言占位符不同；用了语言没有的复数类别；`t('…')` 引用不存在的键；渲染进程或主进程有硬编码的用户可见文字；不带 locale 的 `toLocaleString()` |
| 行名称、live region 节流、审批卡焦点 | `row-label.test.tsx`、`LiveRegion.test.tsx`、`live-announcer.test.ts`、`e2e/t43-approval-focus.e2e.ts` | 任何一种行没有名称，或中英文名称不对；流式期间更新频率超过节流间隔；卡片不取焦点或 400 ms 内键盘能激活 |
| 键盘与系统偏好 | `e2e/t43-keyboard.e2e.ts` | 只用键盘走不完流程；Tab 跨区域顺序不对；有焦点停靠点没有可见焦点环；减少动效、高对比度、强制颜色不生效 |
| 中英文截断与溢出 | `e2e/t43-locales.e2e.ts`，截图在 `tmp/evidence/<任务>/locales/` | 按钮、标签页、导航项、表头、徽标的文字超出自身的框 |

**状态清单的维护**：清单在 `apps/desktop/e2e/a11y/states.ts`，每条一个页面或组件状态（`id` 按区域：`window:`、`settings:`、`row:`、`approval:`、`panel:`、`dialog:`、`state:`）。新增页面、面板、对话框或行类型时：

1. 在清单里加一条（设置页写 `page`，面板写 `panel`，对话框写 `source`，行写 `row`）；
2. 在 `t43-a11y.e2e.ts` 里找到能到达它的旅程，到达后调 `checkState(page, '<id>')`；没有合适的旅程就新写一个；
3. 跑 `PIARC_EVIDENCE_TASK=<任务> npx playwright test -c apps/desktop/playwright.config.ts t43-a11y --project dev`，看 `axe/` 下的报告。修违规，不禁用规则。

`checkState` 在亮色与暗色下各跑一次 axe；Electron 里要 `setLegacyMode(true)`（axe 合并结果用的额外页面打不开）。

## 3. 读屏核对清单

VoiceOver（macOS）、Narrator 与 NVDA（Windows）共用这份清单，每项一列结论。自动化一栏写已经由测试保证的部分；读屏软件实际读出的内容只能人工核对。Narrator 与 NVDA 由 W3 在 Windows 上按此清单执行。

| # | 项目 | 操作 | 期望 | 自动化 | VoiceOver | Narrator | NVDA |
|---|---|---|---|---|---|---|---|
| 1 | 会话列表与状态徽标 | VO 进入侧栏，逐个读会话 | 读出会话标题与状态（运行中、等待审批、出错、未读），归属的工作区分组 | 徽标有 `role="img"` 与本地化名称；axe 通过 | 部分核对：会话标题、当前页及等待审批徽标已播报；组名、运行中、出错及未读徽标未实测 | 通过（W3） | 通过（W3） |
| 2 | transcript 行描述 | 在消息列表里逐个文章（VO+→ 或 feed 导航）读 | 每行先读描述（"工具调用：读取 notes.txt，完成"），再可进入读正文 | `row-label.test.tsx` 覆盖全部行类型的中英文名称；行是 `feed` 里的 `article` | 未实测逐行导航及正文播报 | 通过（W3） | 通过（W3） |
| 3 | 流式播报 | 发一条消息，等回复流式输出 | 运行中隔几秒读一次进展（"正在撰写回复：已写 120 个词"），不逐字读；结束时读一次结果 | `LiveRegion.test.tsx`：100 token/s 下按 5 秒间隔更新，结果只播报一次 | 未实测进展的播报间隔和结束播报次数 | 通过（W3） | 通过（W3） |
| 4 | 命令审批卡 | 让智能体运行需要审批的命令 | 焦点到卡片，读出"需要你的批准。运行命令？<命令>"；Tab 到按钮；400 ms 内的 Enter 不生效 | `t43-approval-focus.e2e.ts` | 部分核对：命令卡自动聚焦，读出 env echo hello，Tab 到反馈框；按钮和防误触未在旁白下复核 | 通过（W3） | 通过（W3） |
| 5 | 文件改动审批卡 | 让智能体写文件 | 同上，读出文件路径；能读到 diff | 同上；axe 通过 | 部分核对：文件路径及 diff 区标题已播报；未读完改动正文 | 通过（W3） | 通过（W3） |
| 6 | 权限扩展审批卡 | 读取工作区外的文件 | 同上，读出目录或路径 | 同上 | 已显示目录，未取得旁白读出该目录的证据 | 通过（W3） | 通过（W3） |
| 7 | 提问表单 | 智能体提问 | 焦点到表单，读出问题；单选、多选、自由回答可用键盘完成 | 同上；`t43-keyboard.e2e.ts` 用键盘作答 | 部分核对：读出问题、SQLite 单选及 CSV、JSON 多选状态；自由回答提交未实测 | 通过（W3） | 通过（W3） |
| 8 | Changes 与评论 | Mod+Shift+D 打开 Changes，Tab 到行号按钮，Enter 写评论 | 行号按钮读出"评论第 N 行（新版本）"；编辑框有名称；保存后评论可读 | `t43-keyboard.e2e.ts`；axe 通过 | 未实测行号、编辑框和保存后评论的播报 | 通过（W3） | 通过（W3） |
| 9 | 设置页 | Mod+, 打开设置，逐页浏览 | 导航读出页名；每个控件有名称；分组标题可用标题导航跳转 | axe 通过（11 页，亮暗）；键盘改主题 | 未实测设置控件与标题转子导航 | 通过（W3） | 通过（W3） |
| 10 | 终端面板 | Ctrl+\` 进入终端，输入命令，"以文本查看屏幕" | 输入框读作"终端 <名称>"；查找结果数播报；文本视图可逐行读；再按 Ctrl+\` 回到输入框 | T34 L4 与 `t43-keyboard.e2e.ts` | 未实测终端标签、查找、逐行浏览及返回输入框 | 通过（W3） | 通过（W3） |

**VoiceOver 的核对方式**：系统设置 → 辅助功能 → VoiceOver 打开（或 Cmd+F5），用 VO 键（Control+Option）加方向键浏览，VO+U 打开转子按标题、landmark、表单控件跳转。AppleScript 驱动 VoiceOver 需要在系统设置里允许"使用 AppleScript 控制 VoiceOver"，只在用户同意后打开。

**Windows 的结论（W3，2026-11-22）**：用户在 Windows 11 25H2 上用讲述人与 NVDA 2026.3 逐项操作已安装的 PiArc（CI 运行 45009150917 的开发构建），10 项都通过；高对比度主题（系统"对比度主题"）下文字、按钮与焦点环都可辨认。

**2026-11-24 核对记录**：在隔离的 PiArc 开发包用 macOS 26.5.2 系统 VoiceOver 核对。第 1、4、5、7 项有部分原生字幕，其他项的实测范围见表。已按用户要求结束旁白操作。15 张原生字幕截图和逐项结果保存在 `tmp/evidence/partial-closure/t43-voiceover/`；T43-A10 仍为 `blocked`。
