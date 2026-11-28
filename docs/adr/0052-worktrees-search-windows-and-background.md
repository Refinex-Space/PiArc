# 0052. Worktree、全文搜索、多窗口与后台常驻的落地（补充）

- 状态：已接受，补充 ADR-0010 决策 1、ADR-0018 第 3 条、ADR-0025、ADR-0048
- 日期：2026-11-20
- 相关：架构第 3.3、6.4、6.12、7.3、7.4、8.1–8.3、8.8、9.1–9.3、11 章；T35；FR-WS-04、05、06，FR-SY-02、04；登记事项 I80、I129、I143

## 背景

架构第 6.12 节只写了 worktree 的目标行为：新建会话可选独立 worktree、`.worktreeinclude`、归档询问与 30 天清理、子 agent 的 `isolation: worktree`、规则与信任按主 checkout 解析。第 9.2 节给了 `session_fts` 的名字，第 8.8 节列了菜单栏 / 托盘、`piarc://` 与打开文件夹。T35 实现时要定下基线没写到的细节：worktree 放在哪、怎样命名、会话的文件边界与设置来源怎样分开、子 agent 的 worktree 在哪一步创建、中文怎样检索、托盘计数从哪里来、退出什么时候确认、链接能做什么、Windows 的右键菜单怎样注册。

## 决策

1. **位置与命名。** 会话的 worktree 在工作区（必须是 git 工作树的顶层）的 `.piarc/worktrees/<名称>/`，分支 `piarc/<名称>`；名称 1–64 个 `[A-Za-z0-9._-]`、以字母或数字开头、符合 git 分支名规则，留空时取会话 id 的前 8 位。子 agent 的临时 worktree 叫 `agent-<子会话 id 前 8 位>`。基础提交：会话取用户选的分支或提交，缺省为工作区当前 HEAD；子 agent 取父会话工作树的当前 HEAD（父会话自己在 worktree 里时就是那棵 worktree 的 HEAD）。`.worktreeinclude`（gitignore 语法）列出且被 git 忽略的普通文件复制进新 worktree，不复制符号链接与 `.piarc/worktrees/` 下的内容。git 由 Core 用命令环境（用户登录 shell，git 能找到凭据助手与 LFS 过滤器）和进程树启动器运行，git 程序只从该 `PATH` 中工作区以外的目录找。
2. **文件边界与设置来源分开。** worktree 会话在 Core 的工具 I/O 里有两个根：文件操作的 `Scope` 根是 worktree（`.piarc` 是受保护路径，以工作区为根会让 worktree 里的每次写入都要审批），设置、规则、信任、审计、模式记忆与 hooks 的来源是主工作区（`SessionIo.project`）。所以 `.piarc/settings.local.json` 的"总是允许"规则从主 checkout 读取、写回主 checkout；worktree 里的 `CLAUDE.md` 等 memory 文件按分支内容加载。路径型规则（`Edit(/src/**)`）相对 worktree 匹配。worktree 会话属于主工作区，共用它的 Agent Host（ADR-0010 决策 1 不变）。
3. **子 agent 的 worktree 在 `subagent/start` 时创建。** `SubagentStartParams.isolation = worktree` 时 Core 先建 worktree，再登记子会话（文件根是 worktree），在结果里答 `cwd` 与 `worktree`；Agent Host 先登记、后创建子会话的 Pi 运行时（Pi 的会话文件按 cwd 放置）。`subagent/finish` 或连接结束时 Core 检查：没有未提交改动、HEAD 仍是基础提交，就不加 `--force` 删除 worktree 并在分支仍指向基础提交时删除分支；否则都保留，`SubagentFinishResult.worktree` 给出路径与分支，Agent Host 把它接在报告后交给模型。子 agent 的编辑照常记进主会话的检查点（ADR-0048 第 5 条）。
4. **归档与清理。** 归档 worktree 会话时，主进程先向 Core 查 worktree 的未提交改动；有改动就弹原生对话框：保留 worktree 并归档 / 丢弃改动并删除 / 取消（丢弃只能在原生对话框里选）。归档把清理时间记为 30 天后（`sessions.worktree_cleanup_at`，恢复归档时清除）。清理在 Core 启动时与之后每 6 小时运行（时钟与当前时间都可注入）：到期且无改动的 worktree 不加 `--force` 删除目录与 git 的登记、保留分支；仍有改动的只标记 `worktree_confirm`，客户端提示用户删除（原生确认后带 `--force`）或再保留 30 天；git 拒绝或失败时保留现场、记日志，下一轮再试，不重试强删。重新打开一个 worktree 已被清理的会话时，Core 在原路径按原分支重建 worktree。
5. **`.gitignore` 提示。** 创建 worktree 后 Core 用 `git check-ignore` 判断 `.piarc/worktrees/<名称>/` 是否被忽略，结果随创建结果返回；未忽略时客户端提示"加入 .gitignore"，用户确认后 Core 在仓库根的 `.gitignore` 追加 `.piarc/worktrees/`（保留原文件的换行风格，已有等价行时不改）。
6. **全文搜索用 FTS5 的 trigram 分词。** schema v8 新增 `session_text`（每条用户消息与助手正文一行：会话、entry id、角色、时间、正文，正文每条至多 20,000 个字符）与外部内容表 `session_fts`（`tokenize = 'trigram'`），由触发器保持同步；它们与会话行在同一个增量同步事务里写入，整文件重扫时先删该会话的行，"重建索引"清空后重读。trigram 按三个字符的子串建索引，中文、英文与混排都无需分词器即可检索，大小写不敏感；查询按空白分词，所有词都要出现；有不足三个字符的词时改用 `LIKE` 扫描 `session_text`（ASCII 大小写不敏感）。结果按会话分组，摘要与高亮范围（UTF-16 码元）由 Core 计算，客户端只用范围拼出文本节点。子 agent 的会话不进结果。备选的 `unicode61` 分词把连续的汉字当成一个词，无法按子串检索中文；外接 jieba 等分词器要引入 C 扩展或自写 tokenizer，代价高于 trigram 的索引体积。
7. **多窗口。** 任何数量的主窗口共用主进程里的同一个 Core；每个窗口订阅同一批快照，所以同一审批在多个窗口同时显示，Core 的审批账本只接受第一个有效答复，其他窗口的卡片随快照消失。最近获得焦点的主窗口负责菜单命令、系统通知与 Dock 角标。窗口的普通位置、大小与是否最大化在移动、缩放（防抖 500 ms）与关闭时写入数据目录的 `window-state.json`；新窗口沿用它并按 24 px 错开，落在已不存在的显示器上时移回主显示器居中。
8. **后台常驻与托盘计数。** 关闭最后一个窗口不退出（两个平台一样），会话与后台任务继续运行。macOS 菜单栏是 template 图（黑色加透明，系统着色）加计数文字（`▸运行中 ?等待审批`，为零的不显示），Windows 托盘按任务栏明暗选黑或白的 `.ico`、计数在提示文字里，左键打开窗口。图标由 `scripts/dev/export-tray-icons.mjs` 从 `design/brand/mark.svg` 导出，放回 `design/brand/`。计数来自 Core：快照任务在发出会话列表时算出运行中与等待审批的会话（不含归档），变化时发到路由 `core/activity`；主进程只监听这一个路由（`EventRouter.listen`），不自己统计。
9. **退出确认。** 菜单与托盘的"退出"先问 Core 的 `runningWork`（运行中的会话数与后台任务数），有正在进行的工作时原生对话框确认（退出会结束后台任务，ADR-0049）；系统注销等其他退出不询问。
10. **链接与打开文件夹只做定位。** `piarc://open?path=<绝对路径>` 打开文件夹作为工作区，`piarc://session/<id>` 显示会话；其他主机名与参数一律忽略，链接不能携带提示词或命令。命令行参数中的链接与文件夹、第二次启动（单实例锁转交）、macOS 的 `open-url` 与 `open-file`（Dock 图标拖放）、拖到窗口里的文件夹（preload 的 `pathForFile` 取路径）都汇成同一种启动目标，在最近的主窗口里打开；页面挂载前到达的目标排队，页面经 `takeLaunchTargets` 取走。打开的文件夹仍由 Core 校验，没有信任决定或有新增可执行项时立即显示信任对话框。T29 的 OAuth 回调走回环端口，不经 `piarc://`。打包时 macOS 在 Info.plist 声明 URL scheme 与文件夹文档类型；开发运行不认领 scheme。
11. **Windows 的注册随 Velopack（ADR-0018 第 3 条）。** Velopack 的安装与更新钩子用系统目录下的 `reg.exe`（不经 shell）在 `HKCU\Software\Classes` 写入 `piarc` 协议、`Directory\shell\PiArc` 与 `Directory\Background\shell\PiArc` 的"Open with PiArc"，命令为 `"<PiArc.exe>" "%1"`（背景菜单为 `%V`）；卸载钩子删除它们。注册与参数解析是纯函数，单元测试在 Windows CI 上运行；实机核对交 W3。

## 备选方案

| 方案 | 结论 | 理由 |
|---|---|---|
| worktree 放在工作区之外（如数据目录） | 否决 | 架构第 9.1 节定了 `.piarc/worktrees/`；放在仓库里用户在编辑器中能直接看到，worktree 与仓库同生命周期 |
| worktree 会话的 `Scope` 根取主工作区 | 否决 | `.piarc` 是受保护路径，worktree 里的每次写入都要审批；会话还能写主 checkout，失去隔离 |
| 子 agent 的 worktree 用单独的 AHP 请求创建 | 否决 | 要另外处理"建了 worktree 但没登记"的泄漏；并进 `subagent/start` 后清理只有一条路径 |
| 主进程订阅 `core/sessions` 自己统计托盘计数 | 否决 | 任务要求计数来自 Core 的实体快照、不另算一份；`core/activity` 由快照任务按同一份列表计算，载荷很小 |
| 所有退出都确认（`before-quit`） | 否决 | 系统注销、测试驱动的退出会被对话框卡住；用户主动的退出入口只有菜单与托盘 |

## 后果

- 正面：worktree 会话改动互不干扰，规则与信任只有一份；子 agent 可以放手改代码；中文消息可检索；多个窗口看到同一份状态；关窗口不打断后台工作。
- 代价：trigram 索引约为正文的数倍体积（`session_text` 另存一份正文）；`git` 进程在 worktree 创建、状态检查、清理时运行；worktree 会话要求工作区是仓库顶层。
- 需要配套做的事：R4 复测 M3 内存（`npm run perf:m3`，I146）；W3 在 Windows 上实机核对托盘、右键菜单、长路径与大小写不同的 worktree 路径、3 会话内存（I147）。

## 重新评估的触发条件

- 用户需要在仓库子目录作为工作区时也用 worktree；
- `session_fts` 体积或写入耗时成为瓶颈（例如单个会话超过数十万条消息）；
- Velopack 改变安装形式或开始提供 shell 集成，使注册表写入不再必要。
