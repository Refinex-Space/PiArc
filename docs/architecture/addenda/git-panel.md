# Git 面板（G1–G5）设计增补

- 日期：2026-11-25
- 状态：G1、G2 实施中；G3–G5 待排期
- 决策：[ADR-0084](../../adr/0084-git-panel-scopes.md)（数据来源与范围，取代 ADR-0044 第 8 条）、[ADR-0085](../../adr/0085-git-command-boundaries.md)（Git 命令的执行边界）、[ADR-0086](../../adr/0086-commit-message-generation.md)（提交信息生成）
- 参考：Claude Desktop `next-4.16336.0`（ADR-0073，只研读行为与视觉）；Rebased / IntelliJ git4idea（只参考功能与 git 命令行，不移植代码、不照抄文案）

## 1. 背景与目标

会话右上角的【改动】工具现在只显示会话检查点：基线是本会话第一次写入前的内容，只覆盖经 Core 写入的文件，Bash 改动与用户自己的修改都看不到（ADR-0044 第 8 条）。Claude Desktop 的同名面板读 Git：默认显示当前分支相对基础分支的全部改动，可以换成"未提交改动"或单个提交，不在 Git 仓库时才退回会话改动。它没有暂存、提交、分支与同步，提交和 PR 都是给 agent 发一句固定提示。

用户写完代码后仍要回到 IDEA、Rebased 或终端去看改动、整理暂存、提交、切分支和推送。目标是把【改动】重构为【Git】工具：

1. 改动视图与 Claude Desktop 的 Changes 面板逐项对齐（布局、范围、文件列、diff 显示、状态、快捷键）。
2. 在此之上提供 IDEA 级的提交、分支与同步能力，安全边界与 PiArc 的信任、凭据、审批模型一致。
3. 设置里新增"Git"页。

## 2. 范围

### 2.1 分期

| 期 | 内容 | 状态 |
|---|---|---|
| G1 | 改动视图对齐（四种范围、标题行、文件列、跳转到文件、diff 显示设置、提交区、大 diff、各状态）、Git 工具改名与图标、右栏卡片、Git 设置页（分支、推送与拉取、提交三节） | 本次 |
| G2 | 提交视图（勾选即暂存、按 hunk 暂存与回滚、提交 / 修正 / 提交并推送、AI 生成提交信息）、分支弹窗（检出、新建、重命名、删除与恢复、跟踪、智能检出）、同步（获取、拉取、推送、被拒处理、安全强推、受保护分支）、仓库进行中状态条（冲突列表、标记已解决、继续、中止） | 本次 |
| G3 | 日志（提交图、筛选、提交详情、cherry-pick、revert、reset、从提交新建分支或标签）、stash 管理、删除远程分支、自动获取、图片 diff | 待排期 |
| G4 | 冲突解决（冲突对话框：用我的 / 用他们的 / 合并；三方合并视图）、合并与变基操作、交互式变基 | 待排期 |
| G5 | GitHub PR（经用户的 `gh`：创建、草稿、状态与检查、合并方法）、AI 审查（结果内联或单独）、PR 指令；对应的设置项 | 待排期 |
| W | Windows 实机对齐（GCM、Git Bash、`\\?\` 路径、CRLF） | 待排期 |

### 2.2 本次不做

日志图与提交操作、stash 管理界面（智能检出内部使用 stash 除外）、三方合并视图、"用我的 / 用他们的"、合并与变基入口、交互式变基、PR 与审查、PiArc 自己的 askpass 输入框、GPG 密钥配置、子模块操作（gitlink 改动只显示）、多仓库根、行级（非 hunk）暂存、blame 与文件历史、自动获取、图片 diff、非 UTF-8 文件内容的正确解码（按 UTF-8 宽松解码显示）、项目级 Git 设置。

Claude Desktop 有而 PiArc 有意不做或推迟的：PR 状态带与"创建 PR"按钮（G5）、"Viewed"标记、编辑器"Open in"子菜单、图片对比对话框（G3）。

PiArc 有意偏离 Claude Desktop 的：保留按 hunk 丢弃（只在"本会话"范围）与 Git 回滚（只在"未提交"范围与提交视图）；新增"本会话"范围；新增提交视图、分支弹窗与同步。

## 3. 需求与验收标准

可观察点统一用 `data-testid`（下文写作 `#id`）、磁盘与仓库状态（`git` 命令输出）、mock provider 收到的请求、原生确认测试钩子（`answerConfirm`/`confirmations`）。L4 夹具见第 5.4 节。

### 3.1 G1：改动视图

**A1 范围与数据来源**
- A1.1 Git 仓库内默认范围为"全部改动"。`#git-file[data-path]` 的集合等于 `git diff --name-only <merge-base(base, HEAD)>` 加上 `git ls-files --others --exclude-standard` 的并集（重命名按新路径）。
- A1.2 "未提交改动"的集合等于 `git diff --name-only HEAD` 加未跟踪文件；"单个提交"的集合等于 `git show --name-only --format= <sha>`；"本会话改动"等于现有 `sessionChanges` 的文件集合。
- A1.3 基础分支按顺序推断：worktree 会话的创建基础分支 → `origin/HEAD` → `origin/main` → `origin/master` → 本地 `main` → 本地 `master` → 当前分支。四个夹具各断言一次范围按钮文字 `#git-scope` 为"<基础分支> → 工作区"。"比较对象"子菜单选中别的本地分支后，文件集合按新基础分支计算。
- A1.4 选中的范围按会话记住（关闭再打开面板、重载窗口后保持）；单提交范围的提交不再位于 base..HEAD 时（amend、rebase、reset）退回"全部改动"。
- A1.5 非 Git 目录：只有"本会话改动"范围，`#git-not-repo-note` 说明"这个文件夹不是 Git 仓库，只显示本会话经 PiArc 写入的改动"；没有找到 git 程序时 `#git-missing` 说明并给出安装链接（经原生确认后打开浏览器）。
- A1.6 空仓库（没有提交）：没有"全部改动"与提交区；"未提交改动"以空树为基线，所有文件为新增。detached HEAD：范围按钮显示"HEAD → 工作区"。

**A2 标题行**（Git 工具分块的标题行，ToolHeaderSlot）
- A2.1 从左到右：视图切换 `#git-view`（"改动 / 提交"分段，宽度 < 380 时只显示图标）、文件列表开关 `#git-files-toggle`（`aria-pressed`）、范围按钮 `#git-scope`；右侧：跳转到文件 `#git-goto`、设置菜单 `#git-menu`，之后是分块自带的固定、弹出、最大化、关闭。
- A2.2 分块宽度 250 px 时标题行不溢出：文件列表开关与跳转到文件收进设置菜单；L4 在 250 px 下检查 `scrollWidth <= clientWidth`。
- A2.3 快捷键：Mod+Shift+D 开关 Git 工具（沿用 `changes.toggle`）；焦点在 Git 工具内时 Mod+P 打开跳转到文件、Mod+Shift+Y 开关文件列；焦点在别处时这两个快捷键仍属于 Files（`files.quick`、`files.tree`），L4 两边各测一次。
- A2.4 设置菜单四组：文件列（显示文件、按文件夹分组、分开测试 / 构建 / 生成文件）、折叠（全部折叠、全部展开；大 diff 时展开禁用并说明原因）、显示（并排、自动换行、高亮改动的词、隐藏空白改动）、刷新。没有可显示的 diff 时只有"刷新"。显示设置全局记住（默认：统一视图、换行开、词级开、隐藏空白关）。

**A3 文件列**
- A3.1 默认宽 240，可在 160–640 之间拖动（`#git-files-divider`，键盘 ←/→ 每次 16、Home/End 到最小 / 最大，双击复位）；拖到 79 时文件列隐藏，`#git-files-toggle` 变为未按下；分块宽度 < 400 时文件列不显示，开关禁用。宽度、可见性、树或平铺、按类别分组全局记住。
- A3.2 树模式合并单子目录链（`a/b/c` 一行）；平铺模式显示文件名与灰色目录。排序逐段、数字感知，树模式目录在前。
- A3.3 按类别分组时依次为源文件、测试文件、构建文件、生成文件；组标题带数量；含当前文件的组自动展开。
- A3.4 行内容：文件图标、名称、`+N −M`（加号绿、减号红，减号为 U+2212），二进制没有计数。
- A3.5 点击行：该文件成为当前项（`aria-current`），在 diff 列展开并滚到顶部。键盘：↑/↓/Home/End 移动焦点，Enter 选中并把焦点交给 diff，Shift+F10 打开行菜单。
- A3.6 行菜单：作为上下文附加（把路径加入输入框草稿）、复制 ▸ 绝对路径 / 相对路径 / 文件名、打开文件（Files 工具）、在 Finder 中显示（Windows：在资源管理器中显示）；"本会话"范围多"丢弃此文件的改动"；"未提交"范围多"回滚改动…"（G2）。已删除的文件没有打开与显示。
- A3.7 提交区：当前分支领先基础分支时在文件列底部显示"提交 N"（可折叠，最多占列高 40%）：第一行"全部改动"，工作区不干净时第二行"未提交改动"，之后是提交行（标题；第二行为短哈希 · 作者 · 相对时间），最多 100 条，多出的显示"还有 N 个更早的提交未显示"。点击提交行切到单提交范围；行菜单"复制提交哈希"。

**A4 跳转到文件**
- A4.1 `#git-goto-input`（占位"搜索改动的文件"）对当前范围的文件做子序列模糊匹配，文件名命中优先，重命名的旧路径也可搜到；最多 100 行，多出的提示继续输入；没有结果显示"没有匹配的文件"。Enter 选中并展开该文件，Esc 关闭。

**A5 diff 列**
- A5.1 每个文件一个分节，文件头 32 px 粘性：折叠箭头、文件图标、文件名 + 灰色目录（窄时目录淡出）、标签、`+N −M`、悬停或聚焦时出现"打开文件"、"更多操作"菜单（同行菜单）。
- A5.2 标签：新文件（文件名绿色，读屏"新文件"）、已删除（红色）、由 X 重命名（提示"旧路径 → 新路径"）、二进制、过大无法显示、仅空白改动、已设为可执行 / 不再可执行。没有正文的文件（纯重命名、二进制、只改权限）折叠箭头禁用。
- A5.3 统一视图：单列行号（至少 3ch）、`+`/`-` 标记、整行底色。并排视图：分块正文宽度 ≥ 560 时生效，否则退回统一视图（设置菜单项提示"需要更宽的面板"）；左右以 2 px 分隔，删除块与新增块逐行对齐，缺行留空。
- A5.4 词级高亮：成对的删除行与新增行按词计算差异，改动的词加 3 px 圆角底色；单行超过 1000 字符时跳过。计算在 worker 中进行。
- A5.5 隐藏空白改动：后端以 `-w` 重算；只有空白改动的文件显示"仅空白改动"标签；有行内评论的文件不受影响。开启时按 hunk 的操作禁用。
- A5.6 未改动行折叠：hunk 之间的未改动行显示为分隔行"N 行未改动"，点击上 / 下 / 两侧每次展开 100 行（按需取文件全文，单侧上限 5 MiB）。
- A5.7 F7 / Shift+F7 跳到下一个 / 上一个改动块并滚到视口中部，跳过折叠的文件。
- A5.8 大 diff：增删合计超过 5,000 行时所有文件初始折叠，顶部横幅"diff 较大，文件已折叠，选择文件后展开"；后端扣留 patch（超过 300 个文件、20,000 行或 1 MiB）时展开单个文件才取它的 diff，同时最多取 4 个。
- A5.9 语法高亮沿用 shiki JavaScript 引擎与现有 worker；超过 100,000 字符、2,000 行或单行 1,000 字符时纯文本显示。
- A5.10 行内评论（T42）在四种范围都可用。发送的消息写明范围（"全部改动，相对 main（merge-base abc1234）"、"未提交改动"、"提交 abc1234"、"本会话改动"）；评论草稿记下所属范围与提交，只在同一范围重新定位。

**A6 状态**
- A6.1 加载：超过 1 s 才显示 `#git-loading`（`page.clock` 断言 0.9 s 时不存在、1.1 s 时存在）。
- A6.2 失败：`role=alert` 的 `#git-failed`"无法读取改动"与"重试"按钮；错误原文只进日志（已脱敏）。
- A6.3 空：`#git-empty`"没有可显示的改动"；未提交范围为"没有未提交改动"，此时有提交的分支仍显示文件列与提交区。
- A6.4 切换范围时旧内容保留，200 ms 后变暗到 60%（`data-stale`），新内容到达后替换。
- A6.5 仓库超过 10,000 个改动条目或单次查询超过 20 s：显示已取得的部分与 `#git-truncated` 说明原因（例如未忽略的 `node_modules`）。
- A6.6 刷新时机：窗口获得焦点、回合开始与结束、本会话回合运行中每 10 s、面板可见时每 3 s 比对仓库指纹（`HEAD`、`index`、`packed-refs`、`refs/heads` 等的大小与修改时间）、自身操作完成后、手动刷新。diff 只在状态的变化键（路径、状态、计数、HEAD、基础 oid）变化时重取。

**A7 工具与右栏**
- A7.1 工具按钮 `#tool-changes` 的标签与提示为"Git"，图标为 lucide `GitBranch`（经 `shell/icons.tsx`）；面板 id、命令 id、弹出窗口白名单不变。
- A7.2 右栏卡片标题"Git"：仓库内显示当前分支、`↑领先 ↓落后`、未提交文件数与 `+/−`，"打开"按钮；非仓库显示本会话改动合计（现状）。

**A8 Git 设置页**（`#settings-page-git`，导航位于"代理"之后）
- A8.1 分支：分支前缀（文本，默认空，最长 64，提示"新建分支时预填，不影响 worktree 会话的 `piarc/<名称>` 分支"）；受保护分支（标签输入，默认 `main`、`master`，支持 `*` 通配，最多 32 项）。
- A8.2 推送与拉取：拉取方式分段控件（跟随 Git 配置 / 合并 / 变基 / 仅快进，默认跟随 Git 配置）；始终强制推送开关（默认关，说明"推送时使用 `--force-with-lease`，受保护分支除外"），打开时主进程原生确认。
- A8.3 提交：提交指令多行文本（默认填入当前界面语言的默认指令，最长 8 KiB，"恢复默认"按钮；与默认相同时不写入设置）；说明"生成提交信息时交给模型；提交信息的语言跟随界面语言（当前：简体中文）"。
- A8.4 设置写入用户级 `settings.json` 的 `git` 对象；托管锁定的项显示锁定标识且不可改；项目级 `git` 键忽略并进配置诊断。
- A8.5 G5 才加入的设置（PR 合并方法、创建草稿 PR、PR 指令、审查结果呈现方式）本次不显示占位控件。

### 3.2 G2：提交、分支与同步

**B1 提交视图**（`#git-view` 选"提交"）
- B1.1 布局：左列（默认 300，200–520）自上而下为同步栏、进行中状态条（有时）、文件列表、提交信息框；右列为选中文件的 diff。分块宽度 < 560 时只显示左列，选中文件后左列换成该文件的 diff，顶部有"返回"。
- B1.2 文件列表分组：冲突（有时）、改动（已跟踪）、未跟踪；组标题带数量与组复选框。行：三态复选框（`aria-checked` 为 `true` 全部暂存 / `mixed` 部分暂存 / `false` 未暂存）、状态字母（M、A、D、R、C、U、?，颜色取设计令牌）、文件图标、名称与灰色目录、`+/−`。
- B1.3 勾选文件后 `git diff --cached --name-only` 包含它；取消勾选后不包含；勾选未跟踪文件等于 `git add`；勾选已删除文件等于暂存删除；组复选框作用于全组。空仓库取消暂存用 `git rm --cached`。
- B1.4 选中文件的 diff 分两段："已暂存"（HEAD ↔ index）与"未暂存"（index ↔ 工作区）。已暂存段每个 hunk 有"取消暂存此块"；未暂存段每个 hunk 有"暂存此块"与"回滚此块"。二进制、只改权限、带 filter 属性（含 LFS）的文件、隐藏空白开启时没有 hunk 按钮。
- B1.5 hunk 操作的陈旧防护：请求带路径、段、hunk 序号、hunk 内容哈希、工作区文件 SHA-256、index 条目 oid；Core 在仓库写锁内重新生成 patch 并核对，任何一项不符返回 `stale`，`git diff --cached` 与工作区字节都不变，界面提示"文件已变化，已刷新"并刷新。
- B1.6 行与 hunk 的回滚（含"未提交"范围的回滚）先经主进程原生确认（列出文件数与前 10 个路径，或"回滚 1 个改动块"），执行前把工作区字节与 index 条目存入快照；完成后 toast 提供"撤销"，撤销后文件 SHA-256 与回滚前相同、暂存状态恢复；撤销前文件又被改动的，撤销被拒并说明。

**B2 提交信息框**
- B2.1 多行输入框 `#git-commit-message`，占位"提交信息（Mod+Enter 提交）"；首行超过 72 字符时计数变为警告色。草稿按会话保存在 `localStorage`，提交成功后清空。
- B2.2 提交按钮 `#git-commit` 为拆分按钮：提交 / 提交并推送。没有已暂存改动（且未选修正）、信息为空、项目未受信任、仓库处于冲突中、正在提交时禁用，提示写明原因。
- B2.3 提交执行 `git commit --cleanup=strip -F -`（信息经 stdin），按用户配置运行 hooks；成功后 `git log -1 --format=%s` 等于信息首行，toast 显示短哈希与标题。hook 失败时显示其输出（脱敏、截断到 4 KiB），信息保留。
- B2.4 "修正上次提交"复选框：勾选时输入框为空则填入上次提交信息；上次提交已推送到上游时提示"修正后需要强制推送"；修正允许没有暂存改动。空仓库没有此项。
- B2.5 提交前检查：没有设置 `user.name`/`user.email` 时提交按钮旁显示错误与"在终端中设置"（在会话终端中填入命令、不执行）；detached HEAD 提交前应用内确认。
- B2.6 提交并推送：提交成功后按 B4.3 推送；推送失败时提交保留、显示推送错误。

**B3 生成提交信息**
- B3.1 输入框右上角"生成"按钮 `#git-generate`。没有已暂存改动（且未选修正）或没有可用模型时禁用，提示写明原因并链接到服务商设置。
- B3.2 点击后 mock provider 收到一次辅助请求：system 为 PiArc 的提交信息提示词；user 内容含提交指令原文、语言要求（界面为简体中文时要求中文描述，英文界面要求英文，Conventional Commits 的类型关键字保持英文）、分支名、最近 10 条提交标题、已暂存文件清单与 diff。
- B3.3 diff 预算：合计不超过 32 KiB、单文件不超过 8 KiB；超出的文件只给路径与计数。以下文件只给路径：二进制、匹配权限规则 `Read(...)` deny 的路径、`.env*`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`id_rsa*`、`id_ed25519*`、`.npmrc`、`.pypirc`、锁文件（`package-lock.json`、`yarn.lock`、`pnpm-lock.yaml`、`Cargo.lock` 等只给计数）。正文经 `piarc_telemetry::redact`（新增 PEM 私钥与 URL userinfo 规则）。diff 中的指令性文本只出现在 user 内容的 diff 段落里。
- B3.4 生成中按钮变为"停止"；输入框显示"正在生成…"。结果替换输入框内容，可用 Mod+Z 撤回；结果去掉控制字符与代码围栏，最长 4 KiB。停止后输入框不变。
- B3.5 生成期间暂存内容变化时，结果下方提示"暂存内容已变化"并给出"重新生成"。
- B3.6 失败时输入框下方显示错误（服务商错误分类沿用 `error.kind.*`）；辅助模型不可用、退回会话模型时显示"使用会话模型 <名称> 生成"。
- B3.7 用量记在该会话 `auxiliary/commitMessage`，用量页显示"提交信息"；审计不记内容，只记模型、token 数、发送与扣下的文件数。

**B4 同步**
- B4.1 同步栏 `#git-sync`：分支按钮 `#git-branch`（`⎇ 名称`，有上游时显示 `↑领先 ↓落后`）、获取 `#git-fetch`、拉取 `#git-pull`、推送 `#git-push`（显示待推送数）。进行中的操作显示进度与"取消"；取消后进程树全部结束。
- B4.2 获取：`git fetch --all --prune --progress`；完成后领先 / 落后更新。
- B4.3 推送：当前分支有上游时直接推送；没有上游时弹出推送对话框（远端选择：只列出已配置的远端；分支名默认同名；"设为上游"默认勾选），执行 `git push --porcelain --progress --set-upstream <远端> HEAD:refs/heads/<名称>`。"始终强制推送"开启且分支不受保护时，推送带 `--force-with-lease=refs/heads/<名称>:<本地远端跟踪 oid> --force-if-includes`。
- B4.4 推送被拒（非快进）：对话框"推送被拒绝：远端有本地没有的提交"，选项：拉取后推送、安全强制推送（受保护分支上不存在）、取消。安全强推经主进程原生确认（显示分支、远端、远端旧 oid、本地新 oid），参数必须带 `--force-with-lease=<ref>:<oid>` 与 `--force-if-includes`；租约过期被拒时提示"远端在上次获取后又有更新"并给出"获取"。受保护分支的强推在调用 git 之前由 Core 拒绝。
- B4.5 拉取：当前分支没有上游时提示并给出"设置上游"；按设置的拉取方式：跟随 Git 配置为 `git pull`，合并为 `--no-rebase`，变基为 `--rebase`，仅快进为 `--ff-only`。git 要求选择合并方式时（分叉且未配置），对话框让用户选合并或变基，可勾选"记住"写入设置。
- B4.6 凭据失败（publickey、认证失败、需要用户名、host key 校验失败、终端提示被禁用）归为 `auth`：说明原因并提供"在终端中运行"——打开会话终端并填入等价命令（不执行），用户在终端完成口令或 host key 确认后回到面板重试。
- B4.7 远端错误文本、进度文本与远端 URL 显示前去掉 userinfo 与 ANSI 转义。

**B5 分支弹窗**（点击 `#git-branch`）
- B5.1 顶部搜索框（过滤分支与操作），操作：新建分支…、检出标签或修订…。分组：最近（reflog 中最近检出的 5 个，不含当前）、本地（当前分支置顶并打勾，名称按 `/` 分组为可折叠目录）、远程（按远端，再按 `/` 分组）。本地分支有上游时显示 `↑ ↓`。
- B5.2 键盘：输入即过滤，↑/↓ 移动，Enter 检出，→ 打开该分支的操作子菜单，Esc 关闭。
- B5.3 本地分支的操作：检出、从此新建分支…、推送（当前分支）、重命名…、删除（当前分支禁用）、设置跟踪分支 ▸ / 取消跟踪。远程分支的操作：检出（本地没有同名分支时创建跟踪分支；已有时检出本地分支）、从此新建分支…。
- B5.4 新建分支对话框：名称预填分支前缀；基于当前 HEAD 或所选分支；"检出分支"默认勾选；名称经 `git check-ref-format --branch` 校验，以 `-` 开头、已存在、含空白时内联报错。
- B5.5 删除：`git branch -d`；未完全合并时主进程原生确认（显示未合并提交数）后 `-D`。删除后 toast"已删除分支 X"带"恢复"，恢复后 `git rev-parse X` 等于删除前的 oid，上游设置一并恢复。
- B5.6 检出：工作区的本地改动会被覆盖时，对话框列出文件并提供：智能检出（`git stash push` → 检出 → `git stash pop`）、强制检出（丢弃这些改动，主进程原生确认）、取消。未跟踪文件会被覆盖时列出文件，只能取消。智能检出恢复时出现冲突：保留 stash，提示其名称，进入 B6 的冲突状态。检出被其他 worktree 占用的分支时说明原因。

**B6 进行中状态条**
- B6.1 仓库处于合并、变基、拣选、还原或存在未合并路径时，提交视图顶部 `#git-state` 显示状态（"正在合并 origin/main"、"正在变基到 main（3/5）"、"正在拣选 abc1234"、"有未解决的冲突"）与冲突数。
- B6.2 冲突组的文件：打开文件（Files 工具）、标记为已解决（`git add`；文件仍含冲突标记 `<<<<<<<` 时应用内确认）。
- B6.3 继续（没有未合并路径时可用）：变基 `rebase --continue`、合并 `commit --no-edit`、拣选 / 还原 `--continue`，编辑器一律不打开。中止（应用内确认）：对应的 `--abort`。变基额外有跳过。

**B7 危险操作与并发**
- B7.1 会改动工作区的操作（检出、智能 / 强制检出、拉取、回滚、继续、中止、跳过）在同一文件根下任一会话有运行中的回合时禁用，提示列出会话标题；Core 同样拒绝（`sessionBusy`）。完成后从这些会话的文件状态表移除受影响的路径（agent 下次 Edit 前必须重新 Read）。
- B7.2 Git 写操作在同一仓库（common dir）上串行；遇到 `index.lock` 不删除，短暂退避重试两次后报"另一个 Git 进程正在使用这个仓库"并给出重试。
- B7.3 所有写操作要求窗口近期有真实输入（弹出窗口经 `bindToolInput` 计入）；页面伪造调用在没有真实输入时被拒，仓库字节与 ref 不变。
- B7.4 原生确认的操作：Git 回滚、强制检出、安全强推（含推送被拒后的强推）、删除未完全合并的分支、打开"始终强制推送"。确认框里的分支、远端、oid、文件数与路径取自 Core，路径经 `transcript/reveal.ts` 同等规则显示双向控制字符。取消确认后仓库不变。
- B7.5 每次推送、强推、回滚、强制检出、删除分支写一行 `kind: "git"` 审计（操作、仓库、分支、远端、oid、文件数；不含文件内容与提交信息正文）。

**B8 信任**
- B8.1 未受信任的项目里 Git 工具只读：查看四种范围与提交视图，写操作入口替换为"信任此项目后可提交与同步"，点击走 ADR-0064 的原生确认。Core 对未受信任项目的写请求返回 `untrusted`。
- B8.2 "本会话"范围的丢弃沿用 ADR-0044，不受此限制。

### 3.3 通用

- C1 全部文案进 `src/shared/i18n/` 的中英文目录，verify 第 16 步通过。
- C2 新面板状态、对话框、设置页登记到 `apps/desktop/e2e/a11y/states.ts`，axe 亮暗零违规；中英文截图无溢出。
- C3 键盘可达：标题行 Tab 顺序为视图切换 → 文件列表开关 → 范围 → 跳转 → 设置菜单 → 分块控件；文件列与提交列表为 roving tabindex；所有对话框打开时焦点在首个可操作项、关闭后回到触发者。
- C4 XSS：分支名、提交标题、作者、文件名、远端错误文本含载荷时页面不执行（`expectInertDocument`）。
- C5 IPC：`git` 与 `cancelGit` 收到畸形参数返回结构化错误（`t45-ipc-hardening` 自动覆盖）；每种写操作补参数注入用例（以 `-` 开头的分支或路径、URL 形式的远端、pathspec 魔法、越界路径）。
- C6 带 `\\?\` 前缀的工作区根：status、changes、stage 的结果与普通写法逐字段相同（Rust 测试，Windows CI）。
- C7 `npm run verify` 17 项全部通过。

## 4. 设计

### 4.1 总体

```
渲染进程 changes/            主进程 core/git-ipc.ts          Core piarc_core::git           piarc-git
GitPanel ─ window.piarc.git ─▶ 校验 · 近期输入 · 原生确认 ─▶ gitRequest(session, json) ─▶ status/diff/log/refs/
           window.piarc.cancelGit                              文件根 · 信任 · 忙碌 · 锁       index/commit/branch/remote
           onAppEvent(git) ◀─ core/git 路由（进度、完成）◀──── 快照 · 审计 · 事件               exec（只读 / 用户两种模式）
                                                              │
                                                              └ session/commitMessage ─▶ Agent Host harness/commit-message.ts
                                                                                         （辅助模型通道）
```

### 4.2 piarc-git（功能 crate，只依赖 piarc-protocol、piarc-ports）

- `exec.rs`：在现有 `Git` 之上增加两种模式。
  - **只读模式**（面板自动发起的全部查询）：读取用户的系统与全局配置；命令行以 `-c` 覆盖会执行程序的键（命令行优先级高于仓库配置与 include）：`core.fsmonitor=false`、`core.hooksPath=<空设备>`、`log.showSignature=false`、`core.pager=cat`、`diff.external=`、`gc.auto=0`、`maintenance.auto=false`、`core.quotePath=false`；先在同一配置集下枚举 `filter.*.(clean|smudge|process)`，逐个清空并设 `filter.<驱动>.required=false`；diff 类命令加 `--no-ext-diff --no-textconv`，log 加 `--no-show-signature`。环境：ADR-0035 准入字段 + `HOME`、`XDG_CONFIG_HOME`，清掉继承的全部 `GIT_*`，再设 `GIT_OPTIONAL_LOCKS=0`、`GIT_NO_LAZY_FETCH=1`、`GIT_ALLOW_PROTOCOL=`（不允许任何传输）、`GIT_TERMINAL_PROMPT=0`、`GIT_PAGER=cat`、`GIT_LITERAL_PATHSPECS=1`、`LC_ALL=C`。
  - **用户模式**（用户点击的写操作，只在受信任项目）：用户完整配置，hooks 与 filter 照常运行；环境为 ADR-0035 准入字段 + `HOME`、`XDG_CONFIG_HOME`、`SSH_AUTH_SOCK`、`SSH_AGENT_PID`、`GNUPGHOME`、代理变量（`http_proxy`、`https_proxy`、`all_proxy`、`no_proxy` 大小写两种），清掉继承的 `GIT_*`，再设 `GIT_TERMINAL_PROMPT=0`、`SSH_ASKPASS_REQUIRE=never`、`GIT_EDITOR=true`、`GIT_SEQUENCE_EDITOR=true`、`GIT_MERGE_AUTOEDIT=no`、`GIT_LITERAL_PATHSPECS=1`；网络命令加 `-c protocol.ext.allow=never`。不经 Agent Host 代理或沙箱代理。
  - 执行器能力：stdout 上限 16 MiB（超出报 `truncated`）、stderr 流式读取（进度回调，保留末尾 8 KiB）、取消令牌（结束进程树）、按操作的超时（只读 20 s、本地写 60 s、网络 10 min）、stdin 输入。
  - 参数安全：修订参数前加 `--end-of-options`，路径放在 `--` 之后且由调用方保证是文件根内的相对路径；`check_branch_name`（`git check-ref-format --branch` + 不以 `-` 开头 + 无控制字符）；远端名只接受 `git remote` 列出的名字。
- `status.rs`：`status --porcelain=v2 -z --branch --untracked-files=all`，解析 `# branch.*`（oid、head、upstream、ab）、`1`/`2`/`u`/`?` 条目；仓库状态读 `--git-path` 下的 `MERGE_HEAD`、`rebase-merge/`、`rebase-apply/`、`CHERRY_PICK_HEAD`、`REVERT_HEAD` 与变基进度；条目超过 10,000 时截断。计数：`diff --numstat -z HEAD` 加未跟踪文件进程内计数（前 8,000 字节有 NUL 即二进制，超过 1 MiB 不计行）。指纹：`HEAD`、`index`、`packed-refs`、`refs/heads`、`refs/remotes`、`MERGE_HEAD`、`rebase-*` 的大小与修改时间。
- `diff.rs`：按范围取文件清单（`diff --name-status -z --find-renames` 与 `--numstat -z`）与 patch（`diff --no-color --no-ext-diff --no-textconv --find-renames --src-prefix=a/ --dst-prefix=b/ -U3 [-w]`），未跟踪文件用 `diff --no-index -- <空设备> <路径>`；解析 `diff --git` 头（引号路径、模式变化、新建 / 删除、相似度、重命名、`Binary files differ`）、`@@` hunk、`\ No newline at end of file`，产出 `FileDiff`（与 `piarc-diff` 同一协议形状，单文件降级规则同第 7.7 节）。预算：超过 300 个文件、20,000 行或 patch 合计 1 MiB 时扣留 patch，单文件按需取（上限 5 MiB）。`file_text`：`cat-file blob <rev>:<path>` 或读工作区，上限 5 MiB。基础分支推断与 merge-base 也在此。
- `log.rs`：`log --no-show-signature -z --max-count=101 --format=%H%x1f%h%x1f%an%x1f%ct%x1f%s <base>..HEAD` 与 `rev-list --count`。
- `refs.rs`：`for-each-ref` 列出本地与远程分支（oid、上游、领先落后、提交时间、HEAD 标记）；最近检出取 `reflog` 的 `checkout: moving from A to B`；远端名取 `git remote`。
- `index.rs`：整文件暂存（`add -A -- <路径>`）、取消暂存（`restore --staged --`，空仓库 `rm --cached -r --`）、hunk 暂存 / 取消暂存 / 回滚：锁内重跑对应段的 `git diff -U3`（原始字节），按序号取 hunk、核对内容哈希、工作区 SHA-256 与 index oid，构造"文件头 + 该 hunk"的 patch，分别以 `apply --cached`、`apply --cached --reverse`、`apply --reverse`（作用于工作区）应用。patch 永远由 Core 生成，不接收渲染进程给的 patch。
- `commit.rs`：身份检查（`git var GIT_AUTHOR_IDENT`）、`commit [--amend] [--signoff] --cleanup=strip -F -`、上次提交信息与是否已推送。
- `branch_ops.rs`：`switch [--detach]`、`switch -c`、`branch <名称> <起点>`、`branch -m`、`branch -d/-D`（返回删除前 oid 与上游）、恢复、`branch --set-upstream-to` / `--unset-upstream`、智能检出（`stash push -m "piarc: checkout <A> → <B>"` → `switch` → `stash pop`，冲突时保留 stash）；本地改动或未跟踪文件会被覆盖的错误解析出文件清单。
- `remote_ops.rs`：fetch、pull（四种方式与"需要选择合并方式"的识别）、push（`--porcelain` 输出解析：`rejected (non-fast-forward)`、`(fetch first)`、`(stale info)`、钩子拒绝）、进度解析（`Counting/Compressing/Receiving/Writing objects`、`Resolving deltas` 的百分比）、凭据失败分类。进行中操作：`rebase/merge/cherry-pick/revert --continue|--abort|--skip`。

### 4.3 piarc-protocol

新文件 `git.rs`：`GitRequest`（按 `op` 标记的枚举：`probe`、`status`、`changes`、`fileDiff`、`fileText`、`commits`、`branches`、`stage`、`unstage`、`stageHunk`、`unstageHunk`、`rollback`、`undoRollback`、`commit`、`commitMessage`、`checkout`、`createBranch`、`renameBranch`、`deleteBranch`、`restoreBranch`、`setUpstream`、`fetch`、`pull`、`push`、`continue`、`abort`、`skip`、`markResolved`、`describe`）与结果类型：`GitStatus`、`GitChanges { scope, base?, head, files: GitFileChange[], withheld, truncated }`、`GitFileChange { path, oldPath?, status, binary, mode?, added, removed, diff?: FileDiff, flags }`、`GitCommitRow`、`GitBranches`、`GitOpResult`、`GitError { kind: notRepo | gitMissing | untrusted | sessionBusy | stale | busy | auth | rejected | conflict | protected | invalid | failed | cancelled, … }`、`GitEvent`（`progress`、`finished`）。AHP 新增 `session/commitMessage` 请求与结果（第 4.6 节）及握手能力 `commitMessage`。运行 `npm run gen:protocol`，补 L1 契约样本与反例。

### 4.4 piarc-core

- 新模块 `git/`：
  - `mod.rs`：`GitService`，按会话解析文件根（worktree 会话为 worktree，否则工作区）与项目（`SessionIo.project()`，设置与信任来源）；git 程序经 `git_runner` 解析（登录 shell 的 PATH，排除工作区内的 git）。
  - `ops.rs`：把 `GitRequest` 分派到 piarc-git；只读操作不加锁；写操作先查信任（`piarc_core::trust`，未信任返回 `untrusted`）、再查忙碌（会改动工作区的操作要求同一文件根下所有会话空闲，否则 `sessionBusy`）、再取该 common dir 的 `tokio::Mutex`；`index.lock` 退避两次。
  - `guards.rs`：受保护分支只在这里判断（用户级 `git.protectedBranches`，`*` 通配）；强推必须带期望 oid；`describe` 为原生确认返回事实（分支、远端、旧 / 新 oid、未合并提交数、受影响文件）。
  - `restore.rs`：回滚前在路径锁内把工作区字节存入 `piarc_checkpoint::ObjectStore`，写 `checkpoint_files` 记录（新操作 `gitRestore`；同批次的 `gitRestoreIndex` 记录指向保存 index 条目 mode、oid 与暂存状态的小对象）；会话没有检查点时补建。`plan` 与 Changes 视图排除这两种操作。撤销经 `piarc_fs::replace` 核对回滚后的哈希写回，再恢复 index 条目（`update-index --cacheinfo`）。完成后从同一文件根下各会话的文件状态表移除这些路径。
  - `commit_message.rs`：组装 `session/commitMessage` 的输入（第 3.2 节 B3.3 的预算、只给路径的规则、`permissions` 的 `Read` deny 规则经 `piarc-policy` 匹配、`redact`），经会话 actor 发给 Agent Host（Agent Host 被回收时由 actor 重新拉起），超时 60 s，用量按 purpose `commitMessage` 记账。
  - 审计：`kind: "git"`。
  - 事件：Core 路由 `core/git`（`progress`、`finished`，带 `opId`）。
- `piarc-checkpoint`：`Operation` 新增 `GitRestore`、`GitRestoreIndex`；`plan` 排除。
- `piarc-telemetry::redact`：新增 PEM 私钥块与 `scheme://<token>@host` 形式的 userinfo 规则。
- 设置：`piarc-config` 的 `PIARC_SETTINGS` 新增 `git` 对象（`branchPrefix`、`protectedBranches`、`pullMode`、`alwaysForcePush`、`commitInstructions`，长度上限同第 3.1 节 A8），`client_settings` 的写入白名单加入 `/git/...`；只读用户级与托管层，项目级忽略并进配置诊断。

### 4.5 NAPI 与主进程

- NAPI：`gitRequest(sessionId, requestJson) -> Promise<string>`、`cancelGit(opId)`；跑 `npm run build:core -- --flavor all` 更新快照。
- 主进程 `src/main/core/git-ipc.ts`：IPC `piarc:git.request`、`piarc:git.cancel`；按 `op` 严格校验（会话 id、相对路径、长度上限、枚举值、hunk 标识格式）；写操作调用 `requireInput`（`bindToolInput` 的面板类型加 `changes`，弹出窗口计入）；B7.4 所列操作先请 Core `describe`，以原生确认展示事实，确认后带回 Core 给出的期望值执行（Core 再核对，避免确认后状态变化）；`/git/alwaysForcePush` 写为 `true` 时同样原生确认。locale 由主进程填入 `commitMessage` 请求（`PreferenceStore.locale()`）。L4 用现有确认测试钩子。
- preload：`git(sessionId, request)`、`cancelGit(opId)`；`e2e/preload.e2e.ts` 键快照更新。

### 4.6 Agent Host：提交信息

- AHP `session/commitMessage`（Core → Agent Host，会话级）：参数 `sessionId`、`language`（`en` | `zh-CN`）、`instructions`（≤ 8 KiB）、`branch`、`recentSubjects`（≤ 10）、`files`（路径、状态、计数、扣下原因）、`diff`（≤ 32 KiB）、`amend?`（上次信息）；结果 `text`、`model`、`fallback`（是否退回会话模型）。
- `harness/commit-message.ts` 经 `auxiliary.complete`（purpose `commitMessage`，输出上限 600 token），提示词在 `harness/prompts/commit-message.ts`（PiArc 自写，跑原创性检查）；输出去掉代码围栏与控制字符，截到 4 KiB。

### 4.7 渲染进程

保留 `apps/desktop/src/renderer/changes/` 与面板 id `changes`，新增 `changes/git/`：

| 文件 | 内容 |
|---|---|
| `GitPanel.tsx` | 视图切换、标题行内容（经 `ToolHeaderContent`）、窄宽度收纳规则、面板内快捷键 |
| `store.ts`、`api.ts` | 按会话的 Git 状态（状态、范围、changes、提交、分支、进行中的操作）、刷新时机（A6.6）、请求代际 |
| `scope.ts`、`ScopeMenu.tsx` | 范围模型（会话记忆、退回规则）、范围按钮与菜单（比较对象、提交子菜单带搜索） |
| `file-list-model.ts`、`FileColumn.tsx` | 树 / 平铺、类别规则、排序、键盘、行菜单、提交区 |
| `go-to-file.ts`、`GoToFile.tsx` | 模糊匹配与弹层 |
| `diff-view-model.ts`、`DiffView.tsx` | 文件分节、粘性头、标签、并排配对、未改动行折叠与展开、F7 导航、大 diff 折叠与按需加载 |
| `word-diff.ts`、`workers/word-diff.worker.ts` | 词级差异 |
| `CommitView.tsx`、`CommitList.tsx`、`CommitMessage.tsx` | 提交视图、三态勾选与分组、提交信息框与生成 |
| `SyncBar.tsx`、`BranchPopup.tsx`、`branch-model.ts` | 同步栏、分支弹窗（分组、搜索、子菜单） |
| `RepoStateBar.tsx`、`dialogs.tsx` | 进行中状态条；新建 / 重命名分支、推送目标、检出冲突、推送被拒、需要选择合并方式等对话框 |

- `DiffBody.tsx` 升级为可配置：统一 / 并排、换行、词级、hunk 操作按钮；"本会话"范围沿用其丢弃按钮与 T42 评论。
- `comments.ts`：草稿增加 `scope` 字段，消息写明范围。
- `panels.tsx`、`WorkbenchPanels.tsx`、`shell/icons.tsx`：标签"Git"、图标 `GitBranch`；`ToolTiles.tsx` 的自定义标题列表加入 `changes`。
- 设置：`settings/GitPage.tsx`，`pages.tsx` 中 order 38，`SettingsIcon.tsx` 加图标；`shared/preferences.ts` 增加 `git` 偏好与指针。
- 颜色先复用 `diff.*` 与现有语义令牌；状态字母缺对比度时在 `design/tokens/` 新增并跑 `npm run gen:tokens`。

### 4.8 迁移与兼容

- 不改 SQLite DDL：`checkpoint_files.operation` 新增两个取值。
- 面板 id、命令 id、用户自定义快捷键、工具布局的 sessionStorage 都不变。
- 旧的 T42 评论草稿没有 `scope`，按"本会话改动"处理。
- 现有 L4（`t28-rewind`、`t42-comments` 等）的工作区不是 Git 仓库时自动落到"本会话"范围；是仓库的夹具按新默认范围更新断言。

### 4.9 文档

- ADR-0084、0085、0086；`docs/adr/README.md` 索引；ADR-0044 状态注明第 8 条被 0084 取代。
- 架构文档：第 4 章 ADR 表、6.9 节（Changes 面板改为 Git 面板）、7.6 节（Core API `gitRequest`、`cancelGit`、事件 `core/git`）、7.7 节（Git diff 的来源与降级）、8.2 节（Git 工具、提交视图、分支弹窗、设置页）、10.1 节新增威胁行"恶意仓库的 Git 配置"（THR-15），版本号与修订记录。
- `tests/security/threats.yaml` 与 `docs/security/threat-coverage.md`（`--doc write`）。
- `AGENTS.md` 不变量与命令表、`crates/piarc-git/src/lib.rs` 顶部文档、`apps/desktop/src/renderer/changes/AGENTS.md`、`agent-host/AGENTS.md`；`docs/engineering/prompt-originality.md`。
- `docs/plan/PLAN.md`：计划外维护记录、G3–G5 与 W 登记为待排期事项。

## 5. 测试计划

### 5.1 Rust（`cargo test -p piarc-git`、`-p piarc-core --lib git::`）

真实临时仓库，路径含空格与中文，`HOME` 与 `GIT_CONFIG_GLOBAL` 指向临时目录，`commit.gpgsign=false`、`init.defaultBranch=main`。

| 编号 | 场景 | 预期 |
|---|---|---|
| R1 | porcelain v2 解析：普通、重命名、复制、未合并、未跟踪、领先落后、无上游、detached、空仓库 | 字段与夹具一致 |
| R2 | diff 解析：重命名 + 修改、二进制、权限位、符号链接、CRLF 与 `core.autocrlf=true`、BOM、末行无换行、引号路径、非 UTF-8 文件名（Unix）、扣留与按需取 | `FileDiff`、标签、计数、路径正确 |
| R3 | 恶意配置：仓库本地与 include 文件里的 `core.fsmonitor`、`core.hooksPath`、`filter.x.clean/smudge/process`、`diff.x.textconv`、`diff.x.command`、`diff.external`、`log.showSignature` + `gpg.program`、`core.pager`，各指向写标记文件的脚本；全局配置里的同类键也测一次；跑全部只读操作 | 标记文件都不存在（`thr15_readonly_git_runs_no_repo_program`） |
| R4 | hunk 暂存前外部修改工作区文件或 index | `stale`，index oid 与工作区字节不变 |
| R5 | 本地裸仓库作远端：另一个克隆先推送 | 被拒归类为非快进；租约过期的强推被拒；受保护分支的强推在调用 git 前被拒；强推参数含 `--force-with-lease=<ref>:<oid>` 与 `--force-if-includes` |
| R6 | 受信任项目的提交运行 pre-commit hook；未信任项目的写请求 | hook 运行；`untrusted`（`thr02_git_writes_wait_for_trust`） |
| R7 | 回滚 → 撤销；撤销前文件被改 | 字节与暂存状态复原；撤销被拒 |
| R8 | 参数注入：以 `-` 开头的分支与路径、URL 形式的远端、`:(top)` pathspec、越界路径 | `invalid`，未调用 git（`thr11_git_rejects_option_like_args`） |
| R9 | 忙碌：同一文件根的会话运行中时检出 / 拉取 / 回滚 | `sessionBusy` |
| R10 | `index.lock` 存在 | 退避后 `busy`，锁文件未被删除 |
| R11 | git 输出与远端 URL 含 `https://token@host`、`user:pass@` | 结果与日志中不含 token（`thr04_git_output_strips_url_userinfo`） |
| R12 | 智能检出：pop 冲突 | stash 保留，状态为有冲突 |
| R13 | 基础分支推断四种夹具、浅克隆没有 merge-base、基础分支被删除 | 按顺序推断；没有 merge-base 时退回"未提交" |

`cargo test -p piarc-testkit --test credential_leaks` 扩展：登录环境放假的 `GITHUB_TOKEN` 与保险箱已知密钥，断言不出现在 git 与 hook 进程的环境里。

### 5.2 Agent Host 与会话（`npx vitest run agent-host/src/harness/commit-message.test.ts`、`cargo test -p piarc-testkit --test sessions commit_message`）

- 真实 Agent Host + mock provider：zh-CN 与 en 两种语言要求、提交指令原文、diff 截断、`.env` 与 `id_rsa` 只有路径、diff 里的 "ignore previous instructions" 只出现在 user 内容的 diff 段落、用量出现在 `auxiliary/commitMessage`、Agent Host 被回收后自动拉起。
- 契约：`session/commitMessage` 请求与结果的样本和反例。

### 5.3 Vitest（渲染进程模型与主进程）

范围模型（记忆、退回）、文件列（树合并、平铺、类别规则、排序、键盘）、跳转到文件排序、并排配对与未改动行折叠、词级差异（> 1000 字符跳过）、三态勾选归约、分支分组与搜索、评论草稿的范围、`git-ipc` 参数校验与确认流程、偏好的 `git` 指针。

### 5.4 L4（Playwright，`PIARC_EVIDENCE_TASK=G1|G2 npx playwright test -c apps/desktop/playwright.config.ts git- --project dev`）

夹具：工作区为临时仓库（L4 放在系统临时目录下的隔离位置，Windows 放 `%PUBLIC%`），远端为同机裸仓库，第二个克隆用于制造"远端有新提交"；git 环境同 5.1。

| 编号 | 流程 | 断言 |
|---|---|---|
| E1 | 改动视图：打开 → 四种范围 → 比较对象 → 提交区切单提交 → Mod+P 跳转 → F7 → 并排 / 换行 / 隐藏空白 → 行内评论发送 | 各 testid 状态；mock 收到的评论消息写明范围 |
| E2 | 窄宽度：分块 250 px | 标题行无溢出，收纳项在设置菜单里 |
| E3 | 提交：勾选 → 暂存 hunk → 生成（中文界面）→ 修改 → 提交并推送 | `git diff --cached`；mock 请求要求中文；裸仓库 `rev-parse` 等于本地 HEAD |
| E4 | 分支：新建（前缀预填）→ 重命名 → 删除未合并分支（原生确认）→ 恢复；有改动时智能检出；强制检出取消 | `git branch` 与工作区字节 |
| E5 | 推送被拒 → 拉取后推送；再造被拒 → 安全强推（确认）；受保护分支没有强推项 | 裸仓库 ref；确认框文字含分支与 oid |
| E6 | 拉取冲突 → 状态条 → 打开文件 → 修复 → 标记已解决 → 继续；另一次中止 | 仓库状态与日志 |
| E7 | 运行中的回合期间检出与拉取禁用 | 按钮禁用与提示 |
| E8 | 未受信任项目 | 写入口替换为信任提示；Core 拒绝 |
| E9 | 伪造调用：没有真实输入的写请求；取消原生确认 | 被拒；仓库不变 |
| E10 | 设置页：各项保存到 `settings.json`；打开始终强制推送需原生确认；恢复默认 | 文件内容 |
| E11 | axe 亮暗、中英文截图、XSS 载荷（分支名、提交标题、文件名、远端错误） | 0 违规、无溢出、页面无执行 |
| E12 | 非 Git 目录、空仓库、detached HEAD | 对应状态 |

截图写到 `tmp/evidence/G1/`、`tmp/evidence/G2/`。

## 6. 风险与待确认

| 风险 | 处理 |
|---|---|
| 推送与拉取依赖用户已有的 ssh-agent 与 credential helper；带口令的密钥、首次连接的 host key 在面板里会失败 | B4.6 的"在终端中运行"兜底；PiArc 自己的 askpass 列入后续 |
| 读取全局配置后，用户全局配置里的可执行键仍可能运行 | 只读模式在命令行覆盖全部已知可执行键并枚举 filter；R3 覆盖全局配置；新出现的可执行键在升级 git 时复核（ADR-0085 触发条件） |
| 受信任之后，仓库本地 git 配置可以在写操作中运行程序 | ADR-0085 登记为接受的风险，与在终端运行 git 等价 |
| 非 UTF-8 文件按 UTF-8 宽松解码显示 | 记录为已知限制；按 hunk 操作用原始字节，不受影响 |
| 大仓库 status 慢 | 上限 10,000 条与 20 s，超出降级并说明；运行中每 10 s 的刷新只在面板可见时进行 |
| Windows 上 GCM 可能弹出登录窗；`\\?\` 路径 | 用户操作时允许 GCM 交互；W 期实机核对 |
| 提交信息把已暂存内容发给模型服务商 | 只在用户点击时发送；预算、只给路径的规则、redact；设置页说明 |

## 7. 实施步骤

每步完成后提交（Conventional Commits）并更新 `docs/plan/PLAN.md` 的检查点。

| # | 内容 | 验证 |
|---|---|---|
| 1 | 本设计增补、ADR-0084/0085/0086、ADR 索引、ADR-0044 状态、PLAN 记录 | `node scripts/plan/check-acceptance.mjs`；`npm run verify -- --baseline` |
| 2 | piarc-git 执行器两种模式、输出上限、取消、进度、参数校验（R3、R8、R10、R11） | `cargo test -p piarc-git`；`cargo clippy -p piarc-git --all-targets -- -D warnings` |
| 3 | piarc-git 只读操作：status、diff、log、refs、file_text、基础分支（R1、R2、R13） | 同上 |
| 4 | piarc-protocol `git.rs`、AHP `session/commitMessage` 类型与契约样本 | `npm run gen:protocol`；`cargo test -p piarc-protocol` |
| 5 | piarc-core `git/` 只读路径、指纹、`core/git` 路由；NAPI `gitRequest`/`cancelGit` | `cargo test -p piarc-core --lib git::`；`npm run build:core -- --flavor all` |
| 6 | 主进程 `git-ipc.ts`、preload、类型 | `npx vitest run apps/desktop/src/main/core/git-ipc.test.ts`；`npm run typecheck` |
| 7 | 渲染进程 G1：改动视图、标题行、范围、文件列、跳转、diff 升级、状态、评论范围、工具改名、右栏卡片 | `npx vitest run apps/desktop/src/renderer/changes`；`npm run lint` |
| 8 | 设置：schema、写入白名单、偏好、Git 设置页 | `cargo test -p piarc-config`；`cargo test -p piarc-core --lib client_settings`；Vitest |
| 9 | piarc-git 与 Core 写操作：index、hunk、回滚与快照、提交、分支、远端、进行中操作、信任、忙碌、锁、审计（R4–R7、R9、R12） | `cargo test -p piarc-git`；`cargo test -p piarc-core --lib git::` |
| 10 | 提交信息：Core 组装、AHP、Agent Host harness 与提示词、用量 | 第 5.2 节命令；`node scripts/dev/check-prompt-originality.mjs` |
| 11 | 渲染进程 G2：提交视图、提交信息框与生成、同步栏、分支弹窗与对话框、状态条、原生确认 | Vitest；`npm run lint` |
| 12 | L4 E1–E12、a11y 登记、i18n、威胁映射、受影响的现有测试 | `npm run package:desktop -- --flavor development`；第 5.4 节命令；`node scripts/ci/check-i18n.mjs`；`node scripts/ci/check-threats.mjs` |
| 13 | 文档同步（架构、AGENTS.md）、全量 verify、对照本增补复核 | `npm run verify` |

## 附录：评审裁决

| # | 意见 | 来源 | 决定 | 理由 |
|---|---|---|---|---|
| 1 | 只读查询读取系统与全局配置，命令行 `-c` 覆盖可执行键 | architect | 采纳 | 隔离全局与系统配置会丢 `autocrlf` 等，Windows 上 diff 全错、hunk patch 对不上（`git_status.rs:75-101`） |
| 2 | 只读查询保持 `GIT_CONFIG_GLOBAL=/dev/null`，单独传 excludesFile | security、test | 不采纳 | 与第 1 条冲突；安全诉求由命令行覆盖 + 枚举 filter + R3（含全局配置）满足 |
| 3 | 补 `--no-ext-diff --no-textconv`、`log.showSignature=false`、`--no-show-signature`、pager、`GIT_NO_LAZY_FETCH`、`GIT_ALLOW_PROTOCOL=`、不加 `safe.directory=*` | security、test | 采纳 | 这些键会执行程序或触发网络 |
| 4 | 未受信任项目里写操作只读，提示信任 | security、architect | 采纳 | 与 ADR-0025 一致；仓库本地配置是可执行配置 |
| 5 | 用户写操作的环境为准入字段 + 显式白名单，清掉 `GIT_*`，`SSH_ASKPASS_REQUIRE=never`，网络命令 `protocol.ext.allow=never`，不经 PiArc 代理 | security、architect | 采纳 | 不把登录环境里的凭据带进 git；ADR-0035 只覆盖模型命令，补充 ADR |
| 6 | 远端只接受已配置的名字；分支名校验；`--end-of-options`；路径在 `--` 后并 `GIT_LITERAL_PATHSPECS=1`；hunk 接口只收标识，patch 由 Core 生成 | security、architect | 采纳 | 防止页面注入外传仓库或执行命令（`worktree.rs:258` 先例） |
| 7 | 写操作要求近期真实输入；危险操作原生确认，事实取自 Core；审计 `kind: "git"` | security、test | 采纳 | 与 ADR-0064、T35 原生确认一致；`terminal-ipc.ts:199-232` |
| 8 | git 回滚逐 hunk 也走原生确认 | security | 采纳 | 回滚改动用户未提交的工作；有快照撤销仍保持与 T35 一致；代价是 hunk 回滚多一次确认 |
| 9 | 输出、进度与 URL 去 userinfo；redact 补 token@host 与 PEM；credential_leaks 扩展 | security | 采纳 | `redact.rs:107` 漏掉只有用户名的形式 |
| 10 | 提交信息：deny 规则与敏感文件只给路径、预算、locale 枚举、指令 8 KiB、输出 4 KiB、只填入输入框 | security | 采纳 | 数据外发与注入面 |
| 11 | `gh` 约束（白名单子命令、`GH_PROMPT_DISABLED` 等） | security | 采纳，记入 ADR-0085 供 G5 | 本次不用 gh |
| 12 | 会改工作区的操作在同一文件根有会话运行时拒绝；完成后清文件状态表 | product、architect | 采纳 | ADR-0044 回退的先例；避免替换 agent 正在编辑的文件 |
| 13 | 写操作按 common dir 串行；`index.lock` 不删、退避、可重试 | architect、product | 采纳 | 与 agent 的 git 竞争 |
| 14 | hunk 暂存用 `git apply --cached`，Core 锁内重生成原始字节 patch，核对哈希；特定文件禁用 hunk 操作 | architect | 采纳 | `FileDiff.unified` 是有损字符串，不能用于 apply |
| 15 | IDEA 式构造 index 内容 | 草案 | 不采纳 | 需自行处理换行转换与 filter |
| 16 | 回滚快照用新操作 `gitRestore`，排除于回退计划与 Changes 视图；记 index 条目 | architect、product | 采纳 | 不污染"本会话"基线；撤销能恢复暂存状态 |
| 17 | 回滚只在"未提交"范围与提交视图 | product | 采纳 | "全部改动"含已提交内容，回滚到 HEAD 会误导 |
| 18 | 提交视图分已暂存 / 未暂存两段 diff | product | 采纳 | 部分暂存时两侧 hunk 边界不同 |
| 19 | 标题行在 250 px 不溢出；分支与同步移到提交视图 | product | 采纳 | `tool-layout.ts:34` 最小 250 |
| 20 | 进入提交视图把范围锁为"未提交" | product | 部分采纳 | 提交视图有自己的数据（status + 两段 diff），不复用范围；改动视图的范围不变 |
| 21 | G2 带最小进行中状态条（标记已解决、继续、中止） | product | 采纳 | 否则拉取冲突后无法在面板闭环 |
| 22 | G2 只列冲突与中止，继续放 G4 | test | 不采纳 | 与第 21 条冲突；继续与标记已解决成本低，三方合并仍在 G4 |
| 23 | 凭据失败"在终端中运行" | product | 采纳 | askpass 前的兜底 |
| 24 | 快捷键 Mod+P、Mod+Shift+Y 与 Files 冲突，按焦点区分并补 L4 | test | 采纳 | `keybindings.ts:36-37` |
| 25 | 保留面板 id `changes`、命令 id，只改标签与图标 | architect、test | 采纳 | 不使用户的快捷键自定义失效，不打断威胁映射 |
| 26 | 不改右栏卡片 | architect | 不采纳 | 卡片若继续显示检查点合计，会与默认的 Git 范围数字不一致 |
| 27 | 不新增 git 色令牌，先复用 | architect | 采纳 | 有缺口再加 |
| 28 | 分支前缀默认空；自动获取推迟；拉取方式默认跟随 Git 配置 | product、architect、security | 采纳 | 避免与 worktree 的 `piarc/` 混淆；后台网络与凭据风险；尊重用户 git 习惯 |
| 29 | 提交信息不复用 `hooks/prompt`，新增会话级 `session/commitMessage`，Agent Host 被回收时重新拉起 | architect | 采纳 | `hooks.rs:44-48` 未运行时直接失败 |
| 30 | 退回会话模型时告知、无模型禁用、结果可撤回、暂存变化标过时 | product | 采纳 | `auxiliary.ts:85-97` |
| 31 | 新增 L2 动作 `git_commit_message` | test | 不采纳 | 用 testkit 会话测试覆盖同一链路，不扩展 L2 schema |
| 32 | 仓库变化不用 notify，可见时轮询指纹 | architect | 采纳 | FSEvents 已知问题；成本低 |
| 33 | NAPI 一个通用入口，preload 两个命令 | architect | 采纳 | `projectFiles` 先例；IPC 加固测试自动覆盖 |
| 34 | 评论消息与草稿带范围 | product | 采纳 | 单提交范围的行号不对应当前文件（`comments.ts:98`） |
| 35 | 空仓库、超大仓库上限 | product、test | 采纳 | 参考版有 1 万条 / 20 s 上限 |
| 36 | 验收改写为可观察断言 | test | 采纳 | 第 3 节 |
| 37 | PR 相关设置推迟到 G5，不放占位 | product | 采纳 | ADR-0078"不做空壳"；交付说明写明 |
