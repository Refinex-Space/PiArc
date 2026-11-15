> 本文是 2026-11-14 的调研快照，由调研过程整理而成，引用时注意时效。内容来自 Anthropic 官方文档（每条附来源 URL），对应 Claude Code 2.1.325、Claude Desktop v5.11492.5。重要事实在用于设计或实现前，请回到原始来源重新核对。

# Claude 官方能力调研（PiArc 竞品对标）

> 抓取日期：**2026-11-14**（所有来源均为当日抓取）
> 调研方法：通过 `llms.txt` 索引批量拉取 code.claude.com（205 页）、platform.claude.com、claude.com/docs 的 Markdown 原文后本地检索；support.claude.com、claude.com/blog 用 WebFetch 抓取；社区批评用 WebSearch + GitHub API。
> 版本基线：Claude Code **2.1.325**（2026-11-13，[changelog](https://code.claude.com/docs/en/changelog)）；Claude Desktop **v5.11492.5**（2026-11-13，内置 Claude Code 2.1.325，[Desktop changelog](https://claude.com/docs/cowork/claude-desktop-changelog)）。
> 当前模型阵容：Claude Fable 5.2、Opus 5.5、Sonnet 5.5、Haiku 5.5，均为 1M 上下文、128K 最大输出、adaptive thinking（[Models overview](https://platform.claude.com/docs/en/models/overview)）。
> 约定：下文 `CC:` 前缀代表 `https://code.claude.com/docs/en/`，`PF:` 代表 `https://platform.claude.com/docs/en/`。例如 `CC:hooks` = https://code.claude.com/docs/en/hooks。

---

## 0. 结论速览（对 PiArc 最关键的 12 点）

1. **Claude Code 已是一个"多表面、同一引擎"的 harness**：CLI、Desktop Code 标签页、VS Code、JetBrains、Web/云端、移动端共享同一引擎与配置（`~/.claude`、`.claude/`、CLAUDE.md、`.mcp.json`）。Desktop 只是该引擎的 GUI 外壳，并内置一份 Claude Code（Desktop changelog 每版标注 "Bundled Claude Code version"）。来源：CC:platforms、CC:desktop#coming-from-the-cli、[Desktop changelog](https://claude.com/docs/cowork/claude-desktop-changelog)。
2. **权限模型 6 种模式**：`default`(UI 名 Manual)、`acceptEdits`、`plan`、`auto`、`dontAsk`、`bypassPermissions`。**v2.1.283 起 auto 成为交互式终端/VS Code 的内置默认模式**，由第二个"分类器模型"代替人审批。规则按 deny → ask → allow 求值，deny 在任何模式（含 bypass）都生效。来源：CC:permission-modes、CC:permissions。
3. **Hooks 共 33 个事件、5 种 handler 类型**（command / http / mcp_tool / prompt / agent），另有插件内 JS 函数式 hook（"mods"）可直接绘制 UI。来源：CC:hooks、CC:plugins/mods/overview。
4. **多 agent 有 5 种形态**：Subagents（会话内，默认后台运行，最多嵌套 3 层、并发 20）、Agent view（`claude agents`，supervisor 守护进程托管后台会话）、Agent teams（实验性）、Dynamic workflows（JS 脚本编排数十到数百个 subagent）、Projects（云端线程）。另有跨会话消息 `ListAgents`/`SendMessage`。来源：CC:agents。
5. **Skills 遵循 Agent Skills 开放标准**（agentskills.io），渐进披露三层：元数据 ~100 tokens 常驻 → SKILL.md 正文触发时加载 → 资源按需。自定义 slash command 已并入 skills。来源：CC:skills、PF:agents-and-tools/agent-skills/overview。
6. **上下文管理**：自动 compaction（可设 auto-compact window 100K–1M）、`/compact`、`/context` 可视化、rewind 菜单里的"从此处/到此处摘要"；compaction 后重新注入 CLAUDE.md、auto memory、plan、skill 正文（单个 5K/总 25K tokens 上限）。来源：CC:context-window、CC:checkpointing。
7. **MCP 工具默认延迟加载（tool search）**：会话启动只加载工具名与 server instructions；支持 stdio / HTTP / SSE(已弃用) / WebSocket，OAuth 2.0，local/project/user 三作用域 + 插件 + claude.ai connectors + managed。来源：CC:mcp。
8. **Agent SDK 本质是"把 Claude Code 二进制当子进程驱动"**：TS 包按平台捆绑原生 Claude Code 二进制，SDK 版本跟随 CC 版本；协议形态为 stream-json + control request（`interrupt`、`setPermissionMode`、`setModel`、`rewindFiles`、`getContextUsage` 等）。来源：CC:agent-sdk/typescript、CC:agent-sdk/overview。
9. **Desktop Code 标签页 UX 要素**：侧边栏会话列表（分组/排序/归档/自动归档）、并行会话（分屏/新窗口）、每会话可开 worktree、可拖拽多窗格（chat/diff/browser/terminal/file/plan/tasks/subagent/iOS Simulator）、diff 行内评论、PR/CI 监控（Auto-fix / Merge when ready）、内置浏览器预览与自验证、side chat（⌘;）、三档视图模式、环境选择（本地/云/SSH/WSL）、Remote Control 同步到手机。来源：CC:desktop。
10. **Desktop 技术栈**：官方文档未直接写"Electron"，但官方资料多处间接证实 Chromium/Node 运行时（`claude_desktop_config.json` 的 `chromiumFlags` 设置、MCPB 文档称 Node.js 随 Claude Desktop 附带）；Anthropic 员工 Boris Cherny 在 HN 上确认使用 Electron 的理由。Cowork 在本机隔离 VM 中运行代码。来源见 B1。
11. **社区对 Desktop 的主要批评集中在内存/CPU/卡顿**：anthropics/claude-code 仓库 `area:desktop` + `perf:memory` 标签 issue 67 个、`perf:cpu` 24 个（2026-11-14 统计），包括主进程内存无界增长到 47 GB、单会话 2.4 GB/70% CPU、每会话复制 stdio MCP（~1 GB/个）等；官方 Desktop changelog 也持续在修冻结与内存增长。来源见 D。
12. **合规红线（对 PiArc 商业模式影响最大）**：Anthropic **不允许第三方应用提供 Claude.ai 登录、或代用户使用 Free/Pro/Max/Ultra 订阅凭证路由请求**；第三方产品应使用 API key 或云厂商凭证。唯一例外是用户在**未修改的 Claude Code 二进制**里用自己的订阅登录。来源：CC:legal-and-compliance、CC:agent-sdk/overview。

---

## A. Claude Code 功能全集（Harness 层）

### A0. 表面与运行位置

| 表面 | 定位 | 关键能力 | 来源 |
| :- | :- | :- | :- |
| CLI | 终端、脚本、远程服务器 | 全功能、Agent SDK、computer use（macOS，Pro/Max/Ultra）、第三方模型提供方 | CC:platforms |
| Desktop（Code 标签页） | 可视化审阅、并行会话、托管部署 | diff 查看器、应用预览、computer use、Dispatch | CC:desktop |
| VS Code 扩展 | IDE 内 | 行内 diff、@mention、计划审阅、集成终端 | CC:vs-code |
| JetBrains 插件 | IDE 内（在 IDE 终端里跑 CLI） | diff 查看、选区共享 | CC:jetbrains |
| Web（claude.ai/code） | 云端长任务 | Anthropic 托管或自托管环境，断开后继续运行；`--cloud` / `--teleport` 迁移 | CC:claude-code-on-the-web |
| Mobile | 外出时启动/监控 | 云会话、Remote Control 本地会话、Dispatch | CC:mobile |

- 本地会话之间共享配置、项目记忆与 MCP；"Claude Code runs the same underlying engine everywhere"。来源：CC:platforms。
- 离开终端时的工作方式：Dispatch（手机派活到 Desktop）、Remote Control（在 claude.ai/code 或手机上驱动本地会话）、Channels（MCP server 向会话推送事件）、Slack、自托管环境、定时任务（CLI/Desktop/云）。来源：CC:platforms#work-when-you-are-away-from-your-terminal。

### A1. 内置工具清单

来源：CC:tools-reference（全部条目），CC:sub-agents#available-tools。"需权限"列为 Manual 模式下是否需要审批。

| 工具 | 说明 | 需权限 |
| :- | :- | :- |
| `Agent` | 派生独立上下文的 subagent；开启 agent teams 时带 `name` 可启动 teammate；开启 fork 模式时可派生继承完整对话的 fork | 否 |
| `Artifact` | 把 HTML/Markdown 发布为 claude.ai 上的私有交互页面（可分享） | 是 |
| `AskUserQuestion` | 向用户提多选题澄清需求；可设 `askUserQuestionTimeout` 自动继续 | 否 |
| `Bash` | 执行 shell 命令 | 是 |
| `CronCreate` / `CronDelete` / `CronList` | 会话级定时/一次性 prompt（随 `--resume` 恢复） | 否 |
| `Edit` | 对文件做定点编辑 | 是 |
| `EndConversation` | 遇持续滥用或用户要求时结束会话 | 否 |
| `EnterPlanMode` / `ExitPlanMode` | 进入计划模式 / 提交计划并请求批准退出 | 否 / 是 |
| `EnterWorktree` / `ExitWorktree` | 创建或进入隔离 git worktree / 退出 | 是 / 否 |
| `Glob` | 按文件名模式查找（结果按 mtime 排序，上限 100）。**macOS/Linux/WSL 默认不提供**，改用 Bash 内嵌的 `bfs`/`ugrep` | 否 |
| `Grep` | 基于 ripgrep 的内容搜索（files_with_matches / content / count）。macOS/Linux/WSL 默认不提供，条件同 Glob | 否 |
| `ListAgents` | 列出可用 `SendMessage` 联系的 agent：subagent、teammate、本机其他会话、（Remote Control 下）云会话 | 否 |
| `ListMcpResourcesTool` / `ReadMcpResourceTool` | 列出 / 读取 MCP 资源 | 否 |
| `LSP` | 语言服务器代码智能：跳转定义、引用、类型、符号、实现、调用层级；每次编辑后自动报告类型错误。需安装 code intelligence 插件 | 否 |
| `Monitor` | 后台运行命令并把每行输出回灌给 Claude（也可订阅 WebSocket）；默认 5 分钟、最长 30 分钟 | 是 |
| `NotebookEdit` | 修改 Jupyter cell | 是 |
| `PowerShell` | 原生执行 PowerShell（Windows） | 是 |
| `PushNotification` | 桌面通知；Remote Control/云会话下推送到手机 | 否 |
| `Read` | 读文件（支持图片、PDF 分页、ipynb）；单次默认上限 25K tokens，整文件 >256KB 需分页 | 否 |
| `RemoteTrigger` | 创建/运行/列出云端定时任务（支撑 `/schedule`） | 否 |
| `ReportFindings` | 以结构化列表上报代码审查发现，供 UI 渲染 | 否 |
| `ScheduleWakeup` | 自节奏 `/loop` 下一轮唤醒时间（1 分钟–1 小时） | 否 |
| `SendFeedback` | 起草反馈报告，用户确认后才发送（v2.1.238+） | 否 |
| `SendMessage` | 给 teammate、可恢复的 subagent、或本机/远端其他会话发消息（v2.1.224+；auto 模式下分类器审查每条消息） | 否 |
| `SendUserFile` | 把会话中生成的文件发送到用户设备（`render`/`attach`） | 否 |
| `ShareOnboardingGuide` | 上传 `ONBOARDING.md` 生成团队分享链接 | 是 |
| `Skill` | 在主对话中执行 skill | 视 skill |
| `SubagentHandback` | auto 模式下本地非 fork subagent 递交最终报告 | 否 |
| `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` | 任务清单工具；**仅在 Opus 4.7、Sonnet 4.6、Haiku 4.5 及更早模型默认提供**，新模型需 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 开启（v2.1.268+） | 否 |
| `TaskOutput` | v2.1.277 已移除（改为用 Read 读后台任务输出文件） | — |
| `TaskStop` | 停止后台任务 / teammate / 命名后台 agent | 否 |
| `TodoWrite` | 旧版清单工具，默认被 Task 工具取代 | 否 |
| `ToolSearch` | tool search 开启时检索并加载延迟工具 | 否 |
| `WaitForMcpServers` | 等待仍在后台连接的 MCP server（仅在 tool search 关闭时出现） | 否 |
| `WebFetch` | 抓取 URL → Markdown → 用独立模型按 prompt 提取（有损）；单次 100K 字符，15 分钟缓存，跨域重定向不自动跟随 | 是 |
| `WebSearch` | 调用 Anthropic web search 后端，单次最多 8 次后端搜索，支持 allowed/blocked domains | 是 |
| `Workflow` | 运行 dynamic workflow（编排大量 subagent 的脚本） | 是 |
| `Write` | 创建/覆盖文件 | 是 |

**关键工具行为（对 harness 设计有参考价值）**

- **Bash**：每条命令独立进程；`cd` 在项目/附加目录内会跨命令保留（越界则重置并提示）；环境变量不保留（可用 `CLAUDE_ENV_FILE` 或 SessionStart hook）；启动时 source `~/.zshrc` 等并捕获 alias/函数。默认超时 2 分钟、上限 10 分钟（`BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS`）。成功输出内联约 30,000 字符，超出则写文件+2,000 字符预览；失败输出给头尾约 10,000 字符。对 `grep/rg/find/diff/test/git diff` 的 exit 1 视为正常。前台命令超时后**自动转后台**而不是被杀。无人值守会话（`-p`、SDK、CI、云）后台命令默认 30 分钟、最长 2 小时。来源：CC:tools-reference#bash-tool-behavior。
- **Edit/Write 与 Read 规则耦合**：`Edit(...)` allow 隐含读权限；`Read(...)` deny 同时阻止 Edit/Write。来源：CC:tools-reference#configure-tools-with-permission-rules-and-hooks。
- **WebFetch 是"有损"的**：先转 Markdown 再用另一次模型调用按提取 prompt 生成结果；预批准一组文档域名；`User-Agent` 以 `Claude-User` 开头，`Accept` 优先 Markdown。来源：CC:tools-reference#webfetch-tool-behavior。
- **Subagent 可用工具**：所有 subagent 移除 `AskUserQuestion`、`EndConversation`、`EnterPlanMode`、`ExitPlanMode`(除非 permissionMode=plan)、`ScheduleWakeup`、`WaitForMcpServers`、`Workflow`，达到深度上限时移除 `Agent`；后台 subagent 只保留 Read/Grep/Glob/LSP/Bash/PowerShell/Edit/Write/NotebookEdit/WebFetch/WebSearch/TodoWrite/Skill/ToolSearch/EnterWorktree/ExitWorktree/Monitor/TaskStop 等 + 全部 MCP 工具。来源：CC:sub-agents#available-tools。
- 工具名同时用于权限规则、subagent `tools` 列表、hook matcher；UI 显示名（如 "Stop Task"）≠ 规范名（`TaskStop`）。来源：CC:permissions#match-all-uses-of-a-tool。

### A2. 权限体系

#### A2.1 Permission modes 全集

来源：CC:permission-modes、CC:desktop#choose-a-permission-mode、CC:hooks#common-input-fields。

| 模式（config 值） | UI 名称 | 无需询问即可执行 | 适用 | 受保护路径写入 | 说明 |
| :- | :- | :- | :- | :- | :- |
| `default`（别名 `manual`） | Manual | 仅读取 | 敏感工作、逐项审阅 | 询问 | hook/SDK 中始终报告为 `"default"` |
| `acceptEdits` | Accept edits / Edit automatically | 读取、文件编辑、常见文件系统命令（mkdir/touch/mv/cp 等） | 边审边迭代 | 询问 | 云会话里 Manual 等价显示为 Accept edits |
| `plan` | Plan | 读取；auto 可用且 `useAutoModeDuringPlan` 开启时，分类器批准的命令也可执行 | 改代码前探索 | 视情况路由分类器或询问 | 计划批准后才允许编辑；`Ctrl+G` 可在编辑器中改计划 |
| `auto` | Auto | 全部，但由后台**分类器模型**逐项审查 | 长任务、减少审批疲劳 | 交分类器判定 | v2.1.283+ 为终端/VS Code 内置默认；需支持的模型；组织可用 `disableAutoMode` 关闭 |
| `dontAsk` | Don't ask | 工作目录内读取 + 预批准工具；其余凡会询问的一律拒绝 | 锁定的 CI/脚本 | 拒绝 | 不在 Shift+Tab 循环里；Desktop 不提供 |
| `bypassPermissions` | Bypass permissions | 全部 | 仅隔离容器/VM | 允许 | 需 `--dangerously-skip-permissions` 等启用；allow 规则在此模式无效；deny 仍生效 |

- **任何模式都不会自动批准**（含 bypass）：显式 `ask` 规则命中的工具；组织设为 `ask` 的 connector 工具；需用户交互的工具（`AskUserQuestion`、标记 `requiresUserInteraction` 的 MCP 工具）；识别出的 `rm`/`rmdir` 关键路径删除；跨会话消息防护；开启 `blockReadsOutsideWorkingDirectories` 时的越界读取；开启 `blockWritesOutsideWorkingDirectories` 时的越界写入。来源：CC:permission-modes#actions-no-mode-auto-approves。
- **起始模式解析顺序**：`--permission-mode` 或 `--dangerously-skip-permissions` → settings 中 `permissions.defaultMode` → 内置默认。注意 `auto`/`bypassPermissions` 写在项目级 `.claude/settings*.json` 中**不生效**（防止仓库提权）。`claude -p` 与 Agent SDK 的内置默认是 `default`。来源：CC:permission-modes#which-mode-a-session-starts-in。
- **切换方式**：CLI `Shift+Tab` 循环（auto → default → acceptEdits → plan → [bypass] → [auto]）；状态栏显示 `⏸ manual mode on` / `⏵⏵ accept edits on` / `⏸ plan mode on` / `⏵⏵ auto mode on` 等；Bash 审批框可选 "Yes, and switch to auto mode"（v2.1.247+）。Desktop 用提示框下方的模式选择器（`Cmd+Shift+M`），Desktop 中 Shift+Tab **不**切换模式；所选模式按文件夹记忆。来源：CC:permission-modes#switch-permission-modes、CC:desktop#keyboard-shortcuts。
- **Plan 批准选项**：Yes, and use auto mode / Yes, manually approve edits / No, keep planning；可选"批准并清空规划上下文"（`showClearContextOnPlanAccept`）。来源：CC:permission-modes#review-and-approve-a-plan。

**Auto 模式分类器**（来源：CC:permission-modes#eliminate-prompts-with-auto-mode）

- 可用条件：所有套餐；Anthropic API 上需 Opus 4.6+/Sonnet 4.6+/Haiku 5.5/Fable；Bedrock/Vertex/Foundry 需 Sonnet 5+/Opus 4.7+/Haiku 5.5/Fable。Sonnet 4.5、Opus 4.5、Haiku 4.5 不支持。
- 默认阻止：`curl | bash` 式下载执行、向外部发送敏感数据、生产部署与迁移、云存储批量删除、授予 IAM/仓库权限、修改共享基础设施、不可逆删除会话前已存在的文件、force push、会泄露密钥的提交、`git reset --hard`/`git clean -fd` 等丢弃未提交改动的操作、改写非本会话创建的 commit、`terraform destroy` 等、写密钥管理器/DNS/TLS、合并无人审批的 PR、给自动化发指令型评论、操作生产 feature flag 等。
- 决策顺序：① allow/ask/deny 规则（若干例外：受保护路径、关键路径删除、`requiresUserInteraction`、按内容匹配的 ask 规则等）→ ② 工作目录内只读与编辑自动通过（首次越界读取会询问）→ ③ 其余交给分类器。分类器也审查 `SendMessage` 发出的每条消息（v2.1.222+）。
- 分类器信任工作目录与会话开始时已配置的 git remote；会话中新增/改指向的 remote 不受信任；可通过 `autoMode` 配置可信基础设施（CC:auto-mode-config）。
- 连续拦截会触发回退阈值（CC:permission-modes#repeated-block-thresholds）。

**受保护路径**（`.git`、`.claude/` 配置等）：default/acceptEdits 询问、auto 交分类器、dontAsk 拒绝、bypass 允许；settings 中的 allow 规则**不能**预批准受保护路径写入。来源：CC:permission-modes#protected-paths。

#### A2.2 权限规则语法

来源：CC:permissions、CC:tools-reference。

- **格式**：`Tool` 或 `Tool(specifier)`；`Bash(*)` 等价 `Bash`。**求值顺序 deny → ask → allow，首个命中即决定，具体性不改变顺序**；allow 无法在 deny 中"挖洞"。
- **裸工具名 deny 会把工具从模型上下文中整体移除**（Claude 看不到该工具）；带 specifier 的 deny 只拦截匹配调用。
- **各工具 specifier**：

| 规则形式 | 适用工具 | 匹配方式 |
| :- | :- | :- |
| `Bash(npm run *)` | Bash、Monitor | 命令模式匹配 |
| `PowerShell(Get-ChildItem *)` | PowerShell | 命令模式匹配 |
| `Read(~/secrets/**)` | Read、Grep、Glob、LSP | 路径模式（gitignore 风格） |
| `Edit(/src/**)` | Edit、Write、NotebookEdit | 路径模式 |
| `Skill(deploy *)` | Skill | skill 名匹配 |
| `Agent(Explore)` | Agent | subagent 类型匹配 |
| `WebFetch(domain:example.com)` | WebFetch | 域名匹配；`domain:*` 全部 |
| `WebSearch` | WebSearch | 无 specifier |
| `mcp__server__tool` / `mcp__server__*` | MCP 工具 | 工具名；allow 规则不能带 specifier |

- **按参数匹配**（仅 deny/ask）：`Agent(model:opus)`、`Agent(isolation:worktree)`、`Bash(run_in_background:true)`；只能匹配顶层标量参数，不能匹配主内容字段（`command`、`file_path` 等，以防复合命令绕过）。
- **通配符**：`*` 匹配任意文本（含空格）；末尾 ` *`（前有空格）也匹配裸命令（`Bash(ls *)` 匹配 `ls` 但不匹配 `lsof`）；`:*` 是末尾通配的等价写法。启动时会对 `Bash(git *)` 这类过宽规则发出警告。
- **复合命令感知**：识别 `&&`、`||`、`;`、`|`、`|&`、`&`、换行；每个子命令都需被允许；deny/ask 只要任一子命令（含子 shell、命令替换、for 循环体）命中即生效。保存"不再询问"时按子命令分别存规则。
- **剥离包装器**：`timeout`、`time`、`nice`、`nohup`、`stdbuf`、`command`、`builtin`、`noglob`、无参 `xargs`、已知安全的前置环境变量赋值。
- **工具名通配**：deny/ask 可用 `"*"`、`"mcp__*"`；allow 只接受 `mcp__<server>__*` 形式。
- **内置只读命令集**无需审批（CC:permissions#read-only-commands）。
- **审批框选项**：Yes / Yes, and don't ask again for `<prefix>` / Yes, and switch to auto mode / No；Tab 可为答复附加评论（Yes 时评论在结果后送达，No 时评论作为拒绝理由）。"不再询问"的 Bash/WebFetch 规则写入仓库根的 `.claude/settings.local.json`（经 worktree 解析到主 checkout）。来源：CC:permissions#permission-system。

#### A2.3 Settings 层级与 managed policy

来源：CC:settings、CC:managed-settings、CC:permissions#settings-precedence。

| 优先级（高→低） | 来源 | 说明 |
| :- | :- | :- |
| 1 | **Managed settings** | 组织下发；用户/项目/`--settings` 均不能覆盖（少数安全敏感键允许更严格的低层值） |
| 2 | 命令行 `--settings <file-or-json>` 及其他 flag | 仅当次会话 |
| 3 | 项目本地 `.claude/settings.local.json` | 个人、不入库 |
| 4 | 共享项目 `.claude/settings.json` | 入库共享 |
| 5 | 用户 `~/.claude/settings.json` | 个人全局 |

- **列表类键合并而非覆盖**（如 `permissions.allow`），例外：`fallbackModel`、`modelPicker`、`availableModels`、`modelSettings`。环境变量不是层级，按键对单独决定。
- **Managed 的 4 种交付方式**：① 服务端下发（claude.ai 管理后台或自托管 Claude apps gateway，启动拉取+每小时轮询）；② MDM/OS 策略（macOS `com.anthropic.claudecode` 配置描述文件；Windows `HKLM\SOFTWARE\Policies\ClaudeCode`，每 30 分钟检查）；③ 文件 `managed-settings.json` + `managed-settings.d/*.json` + `managed-mcp.json`（macOS `/Library/Application Support/ClaudeCode/`、Linux `/etc/claude-code/`、Windows `C:\Program Files\ClaudeCode\`）；④ HKCU 注册表（用户可写，非 admin 源）。默认 `first-wins`（只用最高优先级源），可设 `managedSourcesBehavior: "merge"`。
- **仅 managed 可设置的键（节选）**：`allowManagedPermissionRulesOnly`、`allowManagedHooksOnly`、`allowManagedMcpServersOnly`、`strictKnownMarketplaces`、`blockedMarketplaces`、`strictPluginOnlyCustomization`、`disableSideloadFlags`、`forceRemoteSettingsRefresh`（拉取失败则拒绝启动）、`managedMcpServers`、`policyHelper`（启动时运行可执行文件计算策略）、`sandbox.network.allowManagedDomainsOnly`、`sandbox.filesystem.allowManagedReadPathsOnly`、`channelsEnabled` 等。
- **嵌入宿主**可通过 SDK `managedSettings` 选项追加策略（CC:permissions#settings-precedence）。
- **工作区信任**：项目 `.claude/settings.json` 中的 `permissions.allow` 与 `additionalDirectories` 需接受信任对话框后才生效；`-p`/SDK 不显示信任框但也不应用这些 allow 规则；hooks、`.mcp.json` 等在不同信任状态下行为不同（CC:permissions#what-runs-before-you-trust-a-folder）。
- **hooks/mods 与规则的优先级**：PreToolUse hook 的 `allow` **不能绕过** deny/ask 规则；hook exit 2 在规则之前生效；mod 的 `tool.check` 在 PreToolUse 之后作答，在存在 managed 设置或 Team/Enterprise 登录时不能推翻 deny。plan 模式下 hook 的 allow 对非只读调用无效。来源：CC:permissions#precedence-among-rules-hooks-and-mods。
- settings 键规模：settings-reference 中约 249 个顶层/嵌套键条目，env-vars 约 394 个环境变量（按文档表格计数，CC:settings-reference、CC:env-vars）。


### A3. Hooks

来源：CC:hooks（全部小节）、CC:hooks-guide、CC:permissions#extend-permissions-with-hooks、CC:plugins/mods/overview。

#### A3.1 配置结构、位置与 handler 类型

- 三层嵌套：**hook event** → **matcher group**（过滤）→ **hook handler**（执行体）。同一事件命中的 handler **并行执行**；prompt/agent 类型超过 12 个时排队。跨多个 settings 文件定义的同一 handler 只执行一次。
- 位置：`~/.claude/settings.json`、`.claude/settings.json`、`.claude/settings.local.json`、managed policy、插件 `hooks/hooks.json`、skill frontmatter（skill 调用后至会话结束）、subagent frontmatter（subagent 运行期间）。hooks 跨层级**合并**而非覆盖；`disableAllHooks` 不能关掉 managed hooks；`allowManagedHooksOnly` 只允许 managed（及被 managed 强制启用插件的）hooks。设置/managed/插件 hooks 也在 subagent 内触发（输入带 `agent_id`、`agent_type`）。
- `/hooks` 菜单查看；`--settings '{"disableAllHooks": true}'` 可整体关闭。

**5 种 handler 类型**

| type | 执行方式 | 默认超时 | 专有字段 |
| :- | :- | :- | :- |
| `command` | 运行 shell 命令，JSON 输入走 stdin，结果走 exit code + stdout | 600s（UserPromptSubmit/PreModelSwitch/PostModelSwitch 30s，MessageDisplay 10s） | `command`、`args`（exec 形式，无 shell）、`async`、`asyncRewake`、`shell`（bash/powershell）、`onFailure`（continue/block，v2.1.295+） |
| `http` | 把 JSON 输入 POST 到 URL，响应体用同样的 JSON 输出格式 | 600s | `url`、`headers`（支持 `$VAR` 插值）、`allowedEnvVars`、`onFailure`；受 `allowedHttpHookUrls`、`httpHookAllowedEnvVars` 白名单约束 |
| `mcp_tool` | 调用已配置 MCP server 的某个工具，文本输出等同 stdout | 600s | `server`、`tool`、`input`（支持 `${tool_input.file_path}` 等替换） |
| `prompt` | 单轮 LLM 判定，返回 `{"ok", "reason", "impossible"}` | 30s | `prompt`（`$ARGUMENTS` 占位）、`model` |
| `agent` | 派生可用 Read/Grep/Glob 等工具的 subagent 验证（最多 50 轮），返回 `{ok}`；**实验性** | 60s | 同 prompt |

- 通用字段：`type`、`if`（一条权限规则语法，仅在工具类事件上评估，如 `"Bash(git *)"`、`"Edit(*.ts)"`）、`timeout`、`statusMessage`（自定义 spinner 文案）、`once`（仅 skill frontmatter 中生效）。
- 支持全部 5 种类型的事件：PermissionDenied、PostToolBatch、PostToolUse、PostToolUseFailure、PreToolUse、Stop、SubagentStop、TaskCompleted、TaskCreated、TeammateIdle、UserPromptExpansion、UserPromptSubmit（agent 类型另不支持 PermissionRequest）。
- **Matcher 规则**：`"*"`/空/省略 = 全部；仅含字母数字 `_ - 空格 , |` = 精确匹配（`|`/`,` 分隔多值）；含其他字符 = 非锚定的 JavaScript 正则（`Edit.*` 也匹配 `NotebookEdit`）。插件 subagent 名形如 `my-plugin:reviewer`，需写 `^my-plugin:reviewer$`。
- **Async**：`async: true` 后台运行，不能阻断；结果的 `additionalContext`/`systemMessage` 在下一回合送达。`asyncRewake: true` 在 exit 2 时立即唤醒 Claude（即使空闲），stderr 作为 system reminder。
- 插件也可以用 JS 函数注册 hooks（称为 **mod**），在 Claude Code 进程内运行，可绘制窗格/横幅、改写内置 UI、拦截工具调用或请求、注册立即执行的 `/command`；mod 运行在 CLI、Desktop Code 标签页和 VS Code 中，不受 Bash 沙箱约束。来源：CC:plugins/mods/overview。

#### A3.2 通用输入字段

| 字段 | 说明 |
| :- | :- |
| `session_id` | 会话 ID |
| `prompt_id` | 当前用户 prompt 的 UUID（与 OTel 事件的 `prompt.id` 对应） |
| `transcript_path` | 会话 JSONL 转录路径（异步写入，可能滞后） |
| `cwd` | 当前工作目录 |
| `scratchpad_dir` | 会话 scratchpad 目录（v2.1.257+） |
| `permission_mode` | `default`/`plan`/`acceptEdits`/`auto`/`dontAsk`/`bypassPermissions`（非所有事件都有） |
| `effort` | `{level}`：low/medium/high/xhigh/max（工具上下文事件） |
| `hook_event_name` | 事件名 |
| `agent_id` / `agent_type` | 在 subagent、in-process teammate 或 `--agent` 中触发时出现 |

#### A3.3 事件全集（33 个）

"可阻断"指 exit code 2 的效果；"JSON 决策/输出"指 exit 0 时可返回的事件特有字段（另有通用字段，见 A3.4）。输入列只列事件特有字段（通用字段见上表）。

| # | 事件 | 触发时机 | Matcher 过滤字段 / 取值 | 事件特有输入字段 | 可阻断（exit 2） | JSON 决策 / 输出字段 |
| :- | :- | :- | :- | :- | :- | :- |
| 1 | `SessionStart` | 会话开始或恢复 | 启动方式：`startup`/`resume`/`clear`/`compact`/`fork` | `source`、`model`、`seconds_since_last_response`、`context_tokens`、`prompt_cache_likely_expired`、`estimated_cache_write_usd` | 否（stderr 仅给用户） | `additionalContext`、`initialUserMessage`（-p 模式首条消息）、`sessionTitle`、`watchPaths`、`reloadSkills`；纯文本 stdout 也作为上下文 |
| 2 | `Setup` | 以 `--init-only` 启动，或 `-p` 模式下带 `--init`/`--maintenance` | `init`/`maintenance` | `trigger` | 否（忽略） | 无 |
| 3 | `InstructionsLoaded` | CLAUDE.md 或 `.claude/rules/*.md` 载入上下文（启动时及懒加载时） | 载入原因：`session_start`/`nested_traversal`/`path_glob_match`/`include`/`compact` | `file_path`、`memory_type`、`load_reason` | 否 | 无 |
| 4 | `UserPromptSubmit` | 用户提交 prompt、Claude 处理前；Claude Code 自发起的回合也触发 | 无 | `prompt` | 是：阻止该 prompt | `decision:"block"` + `reason`、`additionalContext`；**不能替换** prompt |
| 5 | `UserPromptExpansion` | 用户输入的 slash 命令/skill 展开为 prompt 前 | 命令名 | `expansion_type`、`command_name`、`command_args`、`command_source`、`prompt` | 是：阻止展开 | `decision:"block"` + `reason`；纯文本 stdout 作为上下文 |
| 6 | `MessageDisplay` | 助手消息文本流式显示时（按已完成行批次多次触发；-p/SDK 下每条消息一次） | 无 | `turn_id`、`message_id`、`index`、`final`、`delta` | 否（显示原文） | `displayContent`：**仅替换屏幕显示**，转录与模型所见保持原文（可用于脱敏/去 markdown） |
| 7 | `PreToolUse` | 工具调用执行前（`EndConversation` 除外） | 工具名（`Bash` 同时匹配 Monitor 命令） | `tool_name`、`tool_input`、`tool_use_id` | 是：阻止调用，stderr 作为拒绝理由给 Claude | `permissionDecision`：`allow`/`deny`/`ask`/`defer`；`permissionDecisionReason`；`updatedInput`（整体替换参数）；`additionalContext`。多 hook 冲突时 deny > defer > ask > allow。`defer` 仅 `-p` 单工具调用时生效，结果 `stop_reason:"tool_deferred"`，供宿主 UI 收集输入后 `--resume` |
| 8 | `PermissionRequest` | 工具调用需要权限决策（即将弹审批框）时 | 工具名 | `tool_name`、`tool_input`、`permission_suggestions` | 否（exit 2 不生效） | `decision.behavior`：`allow`/`deny`；`updatedInput`；`updatedPermissions`（`addRules`/`replaceRules`/`removeRules`/`setMode`/`addDirectories`/`removeDirectories`，`destination`：`session`/`localSettings`/`projectSettings`/`userSettings`）；`message`；`interrupt` |
| 9 | `PermissionDenied` | auto 模式拒绝工具调用（含无分类器结论的拒绝） | 工具名 | `tool_name`、`tool_input`、`tool_use_id`、`reason` | 否 | `retry: true` 告诉模型可重试（无结论的拒绝忽略） |
| 10 | `PostToolUse` | 工具调用成功后 | 工具名 | `tool_name`、`tool_input`、`tool_response`、`tool_use_id`、`duration_ms` | 否（stderr 展示给 Claude） | `decision:"block"` + `reason`（附在结果旁）、`additionalContext`、`classifierContext`（给 auto 分类器的注释）、`updatedToolOutput`（替换工具输出）、`updatedMCPToolOutput` |
| 11 | `PostToolUseFailure` | 工具调用失败后 | 工具名 | `tool_name`、`tool_input`、`tool_use_id`、`error`、`is_interrupt`、`duration_ms` | 否（stderr 给 Claude） | `decision:"block"` + `reason`、`additionalContext`；**不能改写**失败输出 |
| 12 | `PostToolBatch` | 一批并行工具调用全部完成、下一次模型调用前 | 无 | `tool_calls` | 是：在下次模型调用前停止 agentic loop | `decision:"block"` + `reason` |
| 13 | `Notification` | Claude Code 发出通知时 | 通知类型：`permission_prompt`、`idle_prompt`、`auth_success`、`auth_storage_failure`、`elicitation_dialog`、`elicitation_url_dialog`、`elicitation_complete`、`elicitation_response`、`agent_needs_input`、`agent_completed`、`quota_auto_resume_*`、`plugin_notification` | `message`、`title`、`notification_type` | 否 | 无（可用 `terminalSequence` 发桌面通知） |
| 14 | `SubagentStart` | 派生/恢复 subagent，或 in-process teammate 处理新消息 | agent 类型（`general-purpose`、`Explore`、`Plan`、自定义名、插件名） | `agent_id`、`agent_type` | 否 | `additionalContext`（注入 subagent） |
| 15 | `SubagentStop` | subagent 结束 | agent 类型 | `stop_hook_active`、`agent_transcript_path`、`last_assistant_message`、`background_tasks`、`session_crons` | 是：阻止 subagent 停止 | `decision:"block"` + `reason`、`additionalContext` |
| 16 | `TaskCreated` | 通过 `TaskCreate` 创建任务时 | 无 | `task_id`、`task_subject`、`task_description`、`teammate_name`、`team_name` | 是：回滚创建 | exit 2 或 `decision:"block"`（`continue:false` 被忽略） |
| 17 | `TaskCompleted` | 任务被标记完成时 | 无 | 同 TaskCreated | 是：阻止标记完成 | exit 2；`continue:false` + `stopReason` |
| 18 | `Stop` | Claude 完成回复时 | 无 | `stop_hook_active`、`last_assistant_message`、`background_tasks`、`session_crons` | 是：阻止停止、继续对话 | `decision:"block"` + `reason`（必填）、`additionalContext`（非错误反馈并继续） |
| 19 | `StopFailure` | 回合因 API 错误结束 | 错误类型：`rate_limit`、`overloaded`、`authentication_failed`、`oauth_org_not_allowed`、`account_on_hold`、`billing_error`、`invalid_request`、`model_not_found`、`server_error`、`max_output_tokens`、`cloud_credential_error`、`unknown` | `error`、`error_details`、`last_assistant_message` | 否（输出被忽略） | 仅 `terminalSequence` 生效 |
| 20 | `TeammateIdle` | agent team 队友即将空闲 | 无 | `teammate_name`、`team_name` | 是：让队友继续工作 | exit 2；`continue:false` |
| 21 | `ConfigChange` | 会话中配置文件变化 | 来源：`user_settings`/`project_settings`/`local_settings`/`policy_settings`/`skills` | `source`、`file_path` | 是（`policy_settings` 除外） | `decision:"block"` + `reason` |
| 22 | `CwdChanged` | 工作目录变化（如 Claude 执行 `cd`），适合 direnv 类场景 | 无 | `old_cwd`、`new_cwd` | 否 | `watchPaths`（替换 FileChanged 动态监视列表）、`systemMessage` |
| 23 | `DirectoryAdded` | 会话中经 `/add-dir` 或 SDK `register_repo_root` 添加工作目录 | `slash_command`/`register_repo_root` | `directory`、`source` | 否 | 无 |
| 24 | `FileChanged` | 被监视文件在磁盘上变化 | 要监视的字面文件名（如 `.envrc\|.env`） | `file_path`、`event` | 否 | `watchPaths`、`systemMessage` |
| 25 | `WorktreeCreate` | 经 `--worktree`、`isolation:"worktree"` 或后台会话创建 worktree 时；**替换默认 git 行为**（可接入非 git VCS） | 无 | `name` | 是：任何非 0 退出都使创建失败 | command 在 stdout 打印路径；http 返回 `hookSpecificOutput.worktreePath` |
| 26 | `WorktreeRemove` | 移除由 WorktreeCreate hook 创建的 worktree | 无 | `worktree_path` | 是：非 0 且目录仍在则移除失败 | 仅 exit code |
| 27 | `PreCompact` | 上下文压缩前 | `manual`/`auto` | `trigger`、`custom_instructions` | 是：阻止压缩 | `decision:"block"`；exit 0 时 stdout 成为**压缩摘要指令** |
| 28 | `PostCompact` | 压缩完成后 | `manual`/`auto` | `trigger`、`compact_summary` | 否 | 无 |
| 29 | `PreModelSwitch` | 应用用户/客户端请求的模型切换前 | 目标模型规范名（如 `claude-opus-5`、`.*opus.*`） | `from_model`、`to_model`、`requested_model`、`source`、`context_tokens`、`prompt_cache_warm`、`cache_ttl`、`estimated_cache_write_usd`、`pricing` | 是：取消切换 | `permissionDecision`：`allow`（跳过缓存热时的确认）/`deny`/`ask`；`decision:"block"` |
| 30 | `PostModelSwitch` | 会话模型变更后（含自动 fallback、resume 恢复） | 同上 | 同 PreModelSwitch，`source` 多 `auto`/`resume` | 否 | `additionalContext`（随下一请求送达） |
| 31 | `Elicitation` | MCP server 在工具调用中请求用户输入 | MCP server 名 | `mcp_server_name`、`message`、`mode`、`requested_schema`、`url` | 是：拒绝请求、不弹框 | `action`：`accept`（带 `content` 代答）/`decline`/`cancel`；`decision:"block"` |
| 32 | `ElicitationResult` | 用户响应 elicitation 后、回传 server 前 | MCP server 名 | `mcp_server_name`、`action`、`content`、`mode` | 是：响应变为 decline | `action`、`content` |
| 33 | `SessionEnd` | 会话终止 | 原因：`clear`/`resume`/`logout`/`prompt_input_exit`/`other` | `reason` | 否 | 无 |

#### A3.4 Exit code 与 JSON 输出语义

- **exit 0**：成功，应用 JSON 字段（stdout 必须只含一个 JSON 对象，否则按纯文本/解析失败处理）。UserPromptSubmit、UserPromptExpansion、SessionStart、PostModelSwitch 的纯文本 stdout 会加入上下文；PreCompact 的 stdout 成为摘要指令。exit 0 时 Claude 看不到 stderr。
- **exit 2**：阻断性错误（在可阻断事件上停止动作，stderr 作为理由）。
- **其他退出码**：非阻断错误，动作继续（`onFailure:"block"` 的 hook 例外），转录显示 `<hook name> hook error`。
- **通用 JSON 字段**：`continue`（false 时 Claude 完全停止；不等于拒绝 PreToolUse）、`stopReason`、`systemMessage`（给用户的警告；SDK/stream-json 中以 `SDKInformationalMessage` 送达）、`suppressOutput`（无效果）、`terminalSequence`（限 OSC 0/1/2/9/99/777 与 BEL，用于桌面通知/窗口标题）。
- `additionalContext`、`systemMessage`、`initialUserMessage` 及纯 stdout 各自上限 10,000 字符，超出写文件+2,000 字符预览。
- 可改写内容的事件：PreToolUse（`updatedInput`）、PermissionRequest（`decision.updatedInput`）、PostToolUse（`updatedToolOutput`）；UserPromptSubmit 只能附加上下文。
- **决策模式汇总**：top-level `decision`（UserPromptSubmit、UserPromptExpansion、PostToolUse、PostToolUseFailure、PostToolBatch、Stop、SubagentStop、ConfigChange、PreCompact）；`hookSpecificOutput`（PreToolUse、PermissionRequest、PermissionDenied、MessageDisplay、Elicitation*）；仅上下文（SessionStart、SubagentStart、PostModelSwitch）；无决策（Setup、Notification、SessionEnd、PostCompact、InstructionsLoaded、StopFailure、CwdChanged、DirectoryAdded、FileChanged）。
- 安全：hooks 以用户权限运行任意命令，不在 Bash 沙箱内；项目 hooks 受工作区信任约束（CC:hooks#security-considerations、CC:sandboxing#what-runs-outside-the-sandbox）。

### A4. Subagents 与多 Agent 能力

#### A4.1 Subagent 定义格式

来源：CC:sub-agents。

- Markdown 文件 + YAML frontmatter，正文即 system prompt；仅 `name`、`description` 必填。
- **作用域与优先级**：managed settings（1，最高）> `--agents` CLI JSON（2）> 项目 `.claude/agents/`（3，从 cwd 向上逐级扫描，最近者胜）> 用户 `~/.claude/agents/`（4）> 插件 `agents/`（5）。目录递归扫描，身份只由 `name` 决定。

| frontmatter 字段 | 说明 |
| :- | :- |
| `name` / `description` | 必填；`name` ≤256 字符，不能含 `:` |
| `tools` / `disallowedTools` | 工具白名单 / 黑名单（同时设置时 disallowed 优先）；带 specifier 的 disallowed 仍移除整个工具 |
| `model` | `sonnet`/`opus`/`haiku`/`fable`/完整 ID/`inherit` |
| `permissionMode` | 6 种模式之一（插件 subagent 忽略） |
| `maxTurns` | 最大回合数，达到后结果标记为 partial，可恢复继续 |
| `autoCompactWindow` | 该 subagent 的自动压缩窗口（100K–1M，v2.1.296+） |
| `skills` | 启动时预载入的 skill（注入完整正文） |
| `mcpServers` | 引用已配置 server 或内联定义（项目级内联需信任） |
| `hooks` | 仅在该 subagent 运行期间生效的 hooks |
| `memory` | 持久记忆作用域：`user`/`project`/`local` |
| `background` | 始终后台运行 |
| `omitClaudeMd` | 不加载用户/项目/本地 CLAUDE.md |
| `effort` | low/medium/high/xhigh/max |
| `isolation` | `worktree`：在临时 git worktree 中运行（默认从默认分支分出），无改动自动清理 |
| `color` | 任务列表/转录中的显示色 |
| `initialPrompt` | 作为主会话 agent（`--agent`）时自动提交的首条消息 |
| `experimental.cacheTtl` | 该 subagent 请求的 prompt cache TTL（5m/1h） |

#### A4.2 内置 subagent 类型

| 名称 | 模型 | 工具 | 用途 |
| :- | :- | :- | :- |
| `Explore` | 父会话模型（父为 Fable 时按连接方式用 Opus 或 Fable） | 只读，禁 Write/Edit | 代码搜索与探索；调用时指定 quick / medium / very thorough；**不加载 CLAUDE.md 与 git status** |
| `Plan` | 继承父会话 | 只读 | plan 模式下收集上下文；同样不加载 CLAUDE.md |
| `general-purpose` | 父会话模型 | 全部可用工具 | 需要探索+修改的多步任务 |
| `claude` | 跟随模型顺序 | 全部可用工具 | 兜底；也是 Agent view 派发后台会话的默认 agent |
| `statusline-setup` | Sonnet | — | `/statusline` 配置 |
| `claude-code-guide` | Haiku | — | 回答 Claude Code 功能问题 |

- 可用 `Agent(Explore)` 等 deny 规则禁用某类；`CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` 去掉 Explore/Plan；SDK/`-p` 中 `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` 去掉全部内置。来源：CC:sub-agents#built-in-subagents。

#### A4.3 运行方式

- **默认后台运行**：主对话派生的 subagent 默认在后台；后台 subagent 的权限请求浮到主会话，并标明哪个 subagent 在请求，Esc 只拒绝该次调用。`Ctrl+B` 把等待中的命令/subagent 移到后台。完成后结果作为消息回到主对话；`/tasks` 列出所有后台工作。来源：CC:sub-agents#run-subagents-in-foreground-or-background、CC:tools-reference#agent-tool-behavior。
- **Fork 模式**（默认开启）：fork 继承完整对话、同 system prompt 与工具，**共享父会话 prompt cache**（因此比新 subagent 便宜）；`/subtask <task>` 手动派生；fork 不能再 fork。终端下方面板可 ↑↓ 选择、Enter 打开 fork 转录并追加消息、x 停止。来源：CC:sub-agents#fork-the-current-conversation。
- **嵌套**：默认最多 3 层（`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`），终端以树形展示。**并发上限**默认 20（`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`）。来源：CC:sub-agents#let-subagents-spawn-their-own-subagents、#concurrent-subagent-limit。
- **恢复**：可按 agent ID 或名称用 `SendMessage` 恢复已完成的 subagent；subagent 有独立的自动压缩。来源：CC:sub-agents#resume-subagents。
- **检查点限制**：subagent 的编辑通常不进入会话 checkpoint（前台 fork skill 例外）。来源：CC:checkpointing#subagent-edits-not-restored。

#### A4.4 多会话 / 多 agent 形态对比

来源：CC:agents、CC:agent-teams、CC:agent-view、CC:cross-session-messaging、CC:workflows、CC:claude-projects。

| 形态 | 是什么 | 协调者 | 状态 | 关键机制 |
| :- | :- | :- | :- | :- |
| Subagents | 会话内的委派 worker，返回摘要 | Claude（逐回合） | GA | 见上 |
| Agent view（`claude agents`） | 一个屏幕派发并监控多个后台会话（Needs input / Working / Completed） | 用户 | 研究预览 | **Supervisor 后台服务**托管每个会话为独立 Claude Code 进程；空闲约 1 小时停进程、对话留盘可恢复；崩溃自动重启；自动更新后迁移空闲会话；状态在 `~/.claude/daemon/roster.json`、`~/.claude/jobs/<id>/state.json`；派发的会话在编辑前自动进入自己的 worktree；`/background` 把当前会话转后台、`/fork` 复制会话为后台会话 |
| Agent teams | 一个 lead + 多个 teammate（独立 Claude Code 实例），共享任务列表 + 邮箱互发消息 | lead agent | **实验性，默认关闭**（`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`）；Desktop 不支持 | 邮箱为 `~/.claude/teams/{team}/inboxes/{agent}.json`；teammate 显示模式为 in-process（主终端内切换）或 split panes（需 tmux 或 iTerm2）；不自动用 worktree 隔离 |
| Dynamic workflows | Claude 写的 JavaScript 脚本，运行时在后台编排数十到数百个 subagent | 脚本 | 付费套餐可用（Pro 需在 /config 开启） | 中间结果在脚本变量中；同会话内可恢复；`/workflows` 查看；`/effort ultracode` 可让 Claude 自行决定 |
| Projects | claude.ai/code 或 Desktop 中的一个长期对话，Claude 启动并行"线程"（云端或经 Remote Control 在本机） | Claude | 公测（Pro/Max/Ultra） | 线程共享仓库、指令与记忆 |
| 跨会话消息 | `ListAgents` + `SendMessage` 在本机/其他机器/云端会话间传递文本 | 各会话的 Claude | v2.1.224+ 默认开启 | 只传消息不传历史；可设置入站控制；auto 模式分类器审查消息 |
| `/batch` | 把一个大改动拆成 5–30 个 worktree 隔离的 subagent 的 bundled skill | Claude | GA | subagent + worktree 的封装 |

### A5. Skills、Slash commands、Plugins、Output styles、Status line

#### A5.1 Skills

来源：CC:skills、PF:agents-and-tools/agent-skills/overview。

- **标准**：遵循 [Agent Skills](https://agentskills.io) 开放标准；Claude Code 扩展了调用控制、subagent 执行、动态上下文注入。**自定义命令已并入 skills**（`.claude/commands/*.md` 继续可用）。
- **渐进披露**（API 文档）：Level 1 元数据（`name`+`description`，启动即加载，约 100 tokens/skill）→ Level 2 指令（触发时加载 SKILL.md 正文，建议 <5K tokens）→ Level 3+ 资源（按需读取；脚本经 bash 运行，只有输出进入上下文）。Claude Code 中 `description`+`when_to_use` 在 skill 列表里截断到 1,536 字符。
- **位置**：Enterprise（managed 目录 `.claude/skills/`）、Personal `~/.claude/skills/<name>/SKILL.md`、Project `.claude/skills/`、Nested（子目录，处理该目录文件时加载）、`--add-dir`、Plugin（`/plugin-name:skill-name`）、claude.ai 账户同步的 skills（Cowork/云会话/登录同账户的终端）。
- **frontmatter**：`name`、`description`、`when_to_use`、`argument-hint`、`arguments`（`$name` 替换）、`disable-model-invocation`（仅用户可调）、`user-invocable`（false 则仅 Claude 可调）、`allowed-tools`（本回合免审批）、`disallowed-tools`、`model`、`effort`、`context: fork` + `agent` + `background`（在 subagent 中运行）、`hooks`、`paths`（glob，匹配文件时才自动激活）、`shell`、`metadata`、`license`、`compatibility`。
- **动态上下文注入**：`` !`command` `` 与 ```` ```! ```` 块在加载时执行并把输出注入。
- **生命周期**：调用后渲染内容作为一条消息常驻对话，不会在后续回合重读；compaction 后重新附加最近一次调用（每个 5,000 tokens、合计 25,000 tokens）。`/skill-doctor` 统计每个 skill 的上下文成本与使用频率。
- **Bundled skills**：`/doctor`、`/code-review`、`/batch`、`/debug`、`/loop`、`/claude-api`、`/run`、`/verify`、`/simplify`、`/design` 等（与内置命令不同，bundled skill 是 prompt 驱动）。

#### A5.2 Slash commands（内置命令/skill 清单）

来源：CC:commands#all-commands。

`/add-dir` `/advisor` `/agents` `/artifacts` `/auto-mode-setup` `/autocompact` `/autofix-pr` `/background`(`/bg`) `/batch` `/branch` `/btw` `/bug` `/cd` `/chrome` `/claude-api` `/claude-in-chrome` `/clear` `/code-review` `/color` `/compact` `/config` `/context` `/copy` `/cost` `/dataviz` `/debug` `/deep-research` `/design` `/design-sync` `/desktop`(`/app`) `/diff` `/doctor` `/effort` `/exit` `/export` `/fast` `/feedback` `/fewer-permission-prompts` `/focus` `/fork` `/goal` `/heapdump` `/help` `/hooks` `/ide` `/import [codex|gemini|cursor]` `/init` `/insights` `/install-github-app` `/install-slack-app` `/keybindings` `/list-agents` `/login` `/logout` `/loop` `/mcp` `/memory` `/mobile` `/model` `/output-style` `/permissions` `/plan` `/plugin` `/pr-comments` `/privacy-settings` `/recap` `/release-notes` `/reload-plugins` `/reload-skills` `/remote-control`(`/rc`) `/remote-env` `/rename` `/restart` `/resume` `/review` `/rewind`(`/checkpoint`,`/undo`) `/run` `/sandbox` `/schedule` `/security-review` `/simplify` `/skill-doctor` `/skills` `/slides` `/stats` `/status` `/statusline` `/stop` `/subtask` `/tasks`(`/bashes`) `/team-onboarding` `/teleport`(`/tp`) `/terminal-setup` `/theme` `/tui` `/ultrareview` `/update-config` `/usage` `/verify` `/vim` `/voice` `/workflows` 等；`/ultraplan` 已移除。MCP server 的 prompts 也以命令形式暴露。

值得对标的交互型命令：`/btw`（side question，不进入主对话）、`/branch`（对话分支）、`/focus`（只显示最后 prompt + 一行工具摘要 + 最终回复）、`/recap`（会话一句话摘要）、`/goal`（设定完成条件，模型每回合判定是否达成后自动继续）、`/import`（从 Codex/Gemini/Cursor 迁移配置）。

#### A5.3 Plugins 与 marketplace

来源：CC:plugins/overview、CC:plugins/components、CC:plugins/marketplace-reference、CC:plugins/mods/overview。

- 插件 = 目录 + `.claude-plugin/plugin.json` 清单；组件：Skills、Commands、Agents、Hooks（`hooks/hooks.json`）、**hooks module（mod，JS/TS 函数式 hook，可画 UI）**、MCP servers（`.mcp.json`）、LSP servers、Executables、Themes 与 output styles、Channels、Monitors（随插件自动启动的后台监视）；可声明需要用户填写的配置值（安装时弹配置框），有持久数据目录。
- 安装：`/plugin` 的 Discover 标签页、`claude plugin` CLI；作用域 user/project/local；marketplace 是插件目录（Git 仓库、URL、`command` 源等），有 Anthropic 官方 marketplace；组织可用 `strictKnownMarketplaces`、`blockedMarketplaces`、`enabledPlugins` 强制启用等管控；claude.ai 账户同步插件。
- `claude plugin eval` 可对插件写评测套件（CC:plugin-evals）。

#### A5.4 Output styles

来源：CC:output-styles。内置 Default + 4 种：**Proactive**（直接开工、合理假设）、**Concise**（结果先行、去掉铺垫）、**Explanatory**（附 Insight 块解释选择）、**Learning**（留小段代码给用户写）；可写自定义 style（Markdown + frontmatter），插件可携带；通过 `/output-style` 或设置切换。会话中途切换 style 时，新 style 指令以对话消息形式送达，不破坏 system prompt 缓存（v2.1.251+，CC:prompt-caching#changing-output-style）。

#### A5.5 Status line

来源：CC:statusline。`statusLine` 设置配置任意 shell 脚本；脚本 stdin 收到会话 JSON（`session_id`、`model`、`workspace`、`output_style`、`cost`、`context_window`（含 used_percentage 等）、`rate_limits`、`vim`、`agent`、`worktree` 等），stdout 即显示内容；`/statusline` 由内置 `statusline-setup` agent 协助生成。


### A6. Memory 与上下文管理

#### A6.1 CLAUDE.md 层级与加载

来源：CC:memory。

| 作用域 | 位置 | 共享对象 |
| :- | :- | :- |
| Managed policy | macOS `/Library/Application Support/ClaudeCode/CLAUDE.md`；Linux/WSL `/etc/claude-code/CLAUDE.md`；Windows `C:\Program Files\ClaudeCode\CLAUDE.md` | 组织全员 |
| User | `~/.claude/CLAUDE.md` | 本人所有项目 |
| Project | `./CLAUDE.md` 或 `./.claude/CLAUDE.md`（或 `AGENTS.md`，见下） | 团队（入库） |
| Local | `./CLAUDE.local.md`（需自行 gitignore） | 本人当前项目 |

- **加载规则**：从 cwd 向上每级目录的 CLAUDE.md / CLAUDE.local.md 在启动时加载并**拼接**（从根向下排序，越靠近 cwd 越后出现）；子目录中的 CLAUDE.md 在 Claude 读/写该子目录文件时**按需懒加载**。块级 HTML 注释在注入前被剥离。单文件 >4 MiB 跳过。`claudeMdExcludes` 可排除 monorepo 中他人的文件。
- **Imports**：`@path/to/file` 语法，相对路径相对于包含它的文件，最多递归 4 层；代码块内不解析；项目文件中指向工作目录外的导入首次会弹审批框。
- **Rules**：`.claude/rules/**/*.md`，可用 `paths:` frontmatter 限定只在处理匹配文件时载入；支持用户级 `~/.claude/rules/` 与符号链接共享。
- **AGENTS.md**（v2.1.277+）：仓库只有 `AGENTS.md` 时直接读取；同时存在 CLAUDE.md 时默认只读 CLAUDE.md；可在设置中改为两者都读。
- **Auto memory**：Claude 自己写的跨会话笔记，按 `type` 分为 `user`/`feedback`/`project`/`reference`；存于 `~/.claude/projects/<project>/memory/`（同一 git 仓库的所有 worktree 共享），含 `MEMORY.md` 索引 + 每条一个主题文件；每次会话加载 `MEMORY.md` 前 200 行或 25KB；主题文件按需读取；本地默认开启，`/memory` 中切换（`autoMemoryEnabled`），`autoMemoryDirectory` 可改位置；UI 显示 "Saved 2 memories"/"Recalled 2 memories"。subagent 可通过 `memory` 字段拥有独立记忆。
- 记忆是上下文而非强制配置；需要强制的规则应使用 PreToolUse hook。

#### A6.2 上下文窗口与 compaction

来源：CC:how-claude-code-works#the-context-window、CC:context-window、CC:model-config#extended-context、CC:prompt-caching、CC:commands。

- **自动 compaction**：接近上限时自动把对话摘要化；可在 CLAUDE.md 写 "Compact Instructions" 段或 `/compact <focus>` 控制保留重点；若单个大输出导致反复立即填满，会在几次尝试后停止并报 thrashing 错误。
- **Auto-compact window**：`/autocompact 500k`（按模型存入 `modelSettings`）、`autoCompactWindow` 设置、`--autocompact` flag、`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 环境变量，范围 100K–1M。
- **compaction 后保留/重注入的内容**：system prompt 与 output style 保持；项目根 CLAUDE.md 与无作用域 rules、auto memory、plan 文件从磁盘重注入；skill 描述重建（v2.1.304+）；有 git status 快照则重新读取；`paths:` rules 与子目录 CLAUDE.md 按需重新加载；最近读/写的文件最多重读 5 个；已调用 skill 正文重注入（单个 5K、合计 25K tokens）；后台命令与后台 subagent 继续运行；hook 早先添加的上下文随对话一起被摘要。
- **`/context [all]`**：彩色网格可视化上下文占用，给出优化建议（重型工具、记忆膨胀、容量警告）；Desktop 中为 session details 面板的 Context 卡片（百分比 + 按类别明细）。
- **1M 上下文**：Fable、Sonnet 5+、Haiku 5.5、Opus 4.7+ 默认即 1M；Opus 4.6/Sonnet 4.6 需 `[1m]` 变体（按套餐）；Anthropic API 上 1M 无长上下文溢价（Haiku 5.5 在 >100K 时更贵）。
- **Prompt caching 分层**（Claude Code 自动管理）：System prompt（核心指令 + 工具定义）→ Project context（CLAUDE.md、auto memory、无作用域 rules）→ Conversation。前缀精确匹配，system prompt 任何变化都会让后续全部重算；**切换模型会触发一次未命中缓存的慢回合**（每个模型独立缓存）；CLAUDE.md 中途修改不会立即生效（要等 `/clear`/`/compact`/新会话）；plan 模式与 skill 加载以消息形式追加以保护缓存；裸工具名 deny 会改变工具集。PreModelSwitch hook 会拿到 `prompt_cache_warm`、`estimated_cache_write_usd` 用于提示切换代价。
- 其他：`/btw` side question 不写入主对话；`/recap` 会话摘要；`/focus` 精简视图；rewind 菜单的 "Summarize from here / up to here" 可局部摘要（见 A7）。

### A7. Checkpointing、Sandboxing、后台任务、Worktree

#### A7.1 Checkpointing / Rewind

来源：CC:checkpointing。

- 每个开启回合的用户 prompt 前自动创建 checkpoint，跟踪文件编辑工具的改动；保留最近 100 个 checkpoint 的文件快照；随会话保存（resume 后可 rewind）；约 30 天后随清理任务删除。
- `/rewind`（别名 `/checkpoint`、`/undo`）或空输入框按两次 Esc 打开菜单，选中某条 prompt 后：**Restore code and conversation / Restore conversation / Restore code / Summarize from here / Summarize up to here / Never mind**。
- 限制：只被 Bash 改动过的文件不跟踪（被编辑工具改过的文件之后的 Bash 改动会被还原）；subagent 编辑一般不还原；外部/并发会话改动不跟踪 —— 官方明确建议配合 git。
- SDK 中需 `enableFileCheckpointing: true`，用 `rewindFiles(userMessageId, {dryRun})` 还原（CC:agent-sdk/typescript、CC:agent-sdk/file-checkpointing）。

#### A7.2 Sandboxing（Bash 沙箱与网络隔离）

来源：CC:sandboxing、CC:sandbox-environments。

- 范围：OS 强制作用于 Bash、PowerShell、Monitor 命令**及其子进程**；文件工具、MCP server、hooks、LSP、status line 脚本、mods 均在沙箱外（按权限规则约束）。
- 平台：macOS 用 **Seatbelt**；Linux/WSL2 用 **bubblewrap**（独立网络命名空间）；**原生 Windows 不支持沙箱**（需在 WSL2 中运行）。基于开源 `@anthropic-ai/sandbox-runtime`，也可单独用它包裹整个 Claude Code 进程。
- 默认边界：写入仅限工作目录、每用户临时目录、附加目录（受保护路径始终禁写）；读取默认可读大部分机器（可 `denyRead`、`credentials` 收紧）；网络无直连，经本机代理按 `allowedDomains`（初始为空）逐主机检查；环境变量继承（可 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` 清洗、凭据遮蔽）。
- 不走代理的工具（ssh、多数数据库驱动）以及 UDP/QUIC/ICMP 无法出网。
- 两种模式：**auto-allow**（沙箱内命令自动批准）与 **regular permissions**（仍走审批）。注意 v2.1.325 起沙箱内 Bash 默认回到正常审批流，需 `sandbox.autoAllowBashIfSandboxed: true` 才免审批（[changelog 2.1.325](https://code.claude.com/docs/en/changelog)）。
- **Unsandboxed retry 逃生口**：命令在沙箱内失败时 Claude 可带 `dangerouslyDisableSandbox` 重试（需审批，可用 strict sandbox 模式关闭）；`excludedCommands` 指定始终在沙箱外运行的命令。
- 组织可用 managed settings 强制沙箱并锁定域名白名单（`allowManagedDomainsOnly`）。
- 外层隔离方案对比（dev container、自定义容器、VM、sandbox runtime）见 CC:sandbox-environments。

#### A7.3 后台任务

来源：CC:tools-reference#background-commands、CC:interactive-mode、CC:mcp#automatic-backgrounding-of-long-tool-calls。

- Bash `run_in_background: true` 启动后台任务；前台命令超时自动转后台；`/tasks` 列出并可停止；输出写文件，Claude 用 Read 读取（`TaskOutput` 已移除）。
- `Monitor` 工具把后台命令输出逐行回灌，可用于 tail 日志、轮询 CI、监听 WebSocket。
- MCP 工具调用超过 2 分钟自动转后台；MCP tasks 扩展支持服务端长任务（退出会话后仍运行）。
- 后台 subagent、dynamic workflow 同样进入 `/tasks`；Desktop 的 "Background tasks" 窗格展示 subagent、后台 shell 命令与 workflow。
- 无人值守会话后台命令 30 分钟默认/2 小时上限；`-p` 运行在主会话启动的后台命令结束前不会退出。

#### A7.4 Git worktree

来源：CC:worktrees、CC:desktop#run-a-session-in-its-own-worktree。

- `claude --worktree <name>`（`-w`）在 `.claude/worktrees/<name>/` 创建 worktree，分支 `worktree-<name>`；`EnterWorktree`/`ExitWorktree` 工具让 Claude 在会话中途进入/退出；subagent `isolation: worktree`；agent view 派发的会话编辑前自动进入独立 worktree。
- 可选择 base branch、从 PR 分出、`.worktreeinclude` 复制 gitignored 文件（如 `.env`）、复用 worktree 名、用 `WorktreeCreate`/`WorktreeRemove` hook 替换为非 git VCS 逻辑。
- 权限"不再询问"规则、工作区信任、auto memory 都按主 checkout 解析，worktree 间共享。
- 清理：退出时提示；无改动的 subagent worktree 自动清理；Desktop 归档会话约 30 天后删除 worktree。

### A8. MCP 支持

来源：CC:mcp、CC:managed-mcp、CC:mcp-quickstart。

| 维度 | 现状 |
| :- | :- |
| 传输 | **HTTP**（推荐，支持 OAuth）、**SSE**（已弃用）、**stdio**（本地进程）、**WebSocket**（持久双向，适合服务端主动推送；不支持 OAuth 与 `--transport` 参数） |
| 作用域 | **local**（`~/.claude.json`，仅当前项目，默认）、**project**（项目根 `.mcp.json`，入库，需审批/信任）、**user**（`~/.claude.json`，所有项目）；另有插件提供的 server、claude.ai connectors、managed（`managed-mcp.json` 或 `managedMcpServers`）。同名重复时按 local > project > user > plugin > connectors 取整条定义，不合并字段；managed 提供的 server 优先级最高 |
| 认证 | OAuth 2.0（401/403 时在 `/mcp` 标记需认证；自动 refresh token；固定回调端口；预配置 client 凭据；覆盖元数据发现；限制 scopes；认证代理）；`headers` 静态头与 `headersHelper` 动态头（需工作区信任）；`.mcp.json` 支持 `${VAR}` / `${VAR:-default}` 展开 |
| Tool search / 延迟加载 | **默认开启**：启动只加载工具名和 server instructions，按需经 `ToolSearch` 加载定义；无每 server 工具数上限；server instructions 与常驻工具描述截断于 4,096 字符，延迟加载的工具描述 16,384 字符（`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` 可调）；工具 `_meta["anthropic/alwaysLoad"]` 或 server 配置 `alwaysLoad` 控制常驻；`ENABLE_TOOL_SEARCH` 可调（Azure 托管的 Foundry 不支持） |
| 运行时行为 | 动态工具列表更新（`list_changed`）、自动重连、启动失败重试；工具调用超时（`timeout` 字段或 `MCP_TOOL_TIMEOUT`）；超过 2 分钟自动转后台；MCP tasks 扩展；输出超过 10K tokens 警告、默认上限 25K（`MAX_MCP_OUTPUT_TOKENS` 或工具 `_meta["anthropic/maxResultSizeChars"]`）；工具结果可含图片 |
| 交互 | Elicitation（表单/URL 两种模式，终端弹对话框，可由 hook 代答）；`_meta["anthropic/requiresUserInteraction"]` 让工具每次都审批（任何模式）；可标记幂等工具可重试 |
| 资源/提示 | `@server:resource` 引用资源；MCP prompts 作为 slash 命令；MCP Apps（`ui://` 资源，供宿主渲染的页面，SDK 提供 `readMcpResource()` alpha） |
| 其他 | Channels：MCP server 向运行中会话推送事件（研究预览）；`claude mcp serve` 把 Claude Code 本身作为 stdio MCP server；`claude mcp add-from-claude-desktop` 从 Claude Desktop 导入；Desktop 本地 Code 会话额外读取 `claude_desktop_config.json` |

### A9. Claude Agent SDK 与 headless 模式

来源：CC:agent-sdk/overview、CC:agent-sdk/typescript、CC:agent-sdk/python、CC:agent-sdk/permissions、CC:agent-sdk/session-storage、CC:agent-sdk/typescript-v2-preview、CC:headless、CC:legal-and-compliance。

**定位与形态**

- "A library that runs the Claude Code binary"：与 Claude Code 同一套工具、agent loop、上下文管理、权限、会话、hooks、subagents、MCP、skills、plugins；Python 与 TypeScript 两种。其他语言可直接 `claude -p --output-format json/stream-json` 子进程驱动。
- TS 包 `@anthropic-ai/claude-agent-sdk` 以可选依赖形式**捆绑各平台原生 Claude Code 二进制**（如 `-darwin-arm64`），SDK 版本跟踪 CC 版本（例：SDK v0.3.191 捆绑 CC v2.1.191）；可编译为单可执行文件。
- 与 Managed Agents 区分：Managed Agents 是 Anthropic 托管的 agent harness（云沙箱或自托管沙箱；2026-11-12 起可整体自托管），见 C 节。

**API 面（TS 为例）**

- 入口：`query()`（支持 `AsyncIterable<SDKUserMessage>` 流式多轮输入）、`startup()`/`prewarm()`（预热备用进程）、`tool()` + `createSdkMcpServer()`（进程内 MCP 工具）、会话函数 `listSessions()`/`getSessionMessages()`/`getSessionInfo()`/`renameSession()`/`tagSession()`/`forkSession()`、`resolveSettings()`。V2 session API（`unstable_v2_*`）已在 0.3.142 移除。Python 有 `query()` 与 `ClaudeSDKClient`（交互式）。
- `Query` 对象 control 方法：`interrupt()`、`rewindFiles()`、`setPermissionMode()`、`setModel()`、`applyFlagSettings()`、`updateSettings()`、`initializationResult()`、`reinitialize()`、`supportedCommands()`/`supportedModels()`/`supportedAgents()`、`mcpServerStatus()`、`getContextUsage()`（按类别/skill/工具拆分上下文）、`readFile()`、`reloadPlugins()`/`reloadSkills()`/`reloadOutputStyles()`、`seedReadState()`、`reconnectMcpServer()`/`toggleMcpServer()`/`setMcpServers()`/`setMcpPermissionModeOverride()`、`readMcpResource()`、`streamInput()`、`stopTask()`、`backgroundTasks()`、`close()`。
- 关键选项：`allowedTools`/`disallowedTools`/`tools`、`permissionMode`、`canUseTool` 回调（交互审批）、`hooks`（以回调形式注册全部 hook 事件）、`agents`（`AgentDefinition`）、`mcpServers`（stdio/SSE/HTTP/SDK in-process/claude.ai proxy）、`settingSources`（是否加载 user/project/local 设置）、`managedSettings`（嵌入宿主追加策略）、`enableFileCheckpointing`、`thinking`、`plugins`、`SessionStore`（把 JSONL 转录镜像到对象存储/KV/数据库，实现跨主机恢复）。
- **SDK 权限求值顺序**：① hooks（可直接 deny；allow 不跳过后续 deny/ask）→ ② deny 规则（即使 bypass）→ ③ ask 规则（交给 `canUseTool`，即使 bypass）→ ④ permission mode → ⑤ allow 规则 → 其余交给 `canUseTool`。
- **消息协议**：`SDKMessage` 联合类型约 40 种，包括 `assistant`、`user`、`result`（含 `total_cost_usd`、usage、`permission_denials`、`structured_output`、`stop_reason`，如 `tool_deferred`）、`system`（init/各 subtype）、`stream_event` 部分消息、`compact_boundary`、hook started/progress/response、tool progress、task started/progress/updated/notification、background tasks changed、thinking tokens、session state changed、commands changed、notification、rate limit、permission denied、API retry、model refusal fallback、informational 等。

**Headless（`claude -p`）**

- `--output-format text|json|stream-json`；`--json-schema` 结构化输出（结果在 `structured_output`）；`--input-format stream-json` 流式输入；`--include-partial-messages` 获取 token 级增量；最后一行为 `result` 消息。
- `--bare`：跳过 hooks、skills、命令、subagents、插件、MCP、auto memory、CLAUDE.md 的自动发现，且不读 OAuth/钥匙串（只用 API key）——用于可复现的 CI。
- `--permission-mode`、`--allowedTools`、`--permission-prompt-tool <mcp tool>`（权限宿主）、`--permission-prompts none`（无人值守时把会弹框的请求直接拒绝，并告诉模型不要重试）；`permissions.denyInsteadOfPrompting` 持久化同样行为。
- `--resume`/`--continue` 续接；`-p` 运行在后台命令/唤醒未完成前保持打开；SIGTERM 优雅停止。
- **鉴权约束**：bare 模式只用 API key；第三方开发者产品应使用 API key 或云厂商凭证，**不得提供 Claude.ai 登录或代用户使用订阅凭证**；在产品中预装/运行 Claude Code 必须使用未修改的二进制、不得移除其内置登录方式、不得代付/转售用量。品牌：可称 "Claude Agent" 或 "{YourAgent} Powered by Claude"，不得称 "Claude Code"。

### A10. 其他与 harness 相关的能力（简表）

| 能力 | 要点 | 来源 |
| :- | :- | :- |
| 会话管理 | 转录存于 `~/.claude/projects/<project>/<session-id>.jsonl`；`--continue`、`--resume`、`--from-pr`、`/resume` 选择器、命名、导出；`/branch` 对话分支 | CC:sessions |
| 定时任务 | 会话级 `/loop` 与 Cron 工具；Desktop 定时任务；云端定时任务（原 routines，支持 API/GitHub 事件触发） | CC:scheduled-tasks、CC:desktop-scheduled-tasks、CC:routines |
| `/goal` | 设置完成条件，每回合后由模型判定，未达成则自动开始下一回合 | CC:goal |
| Remote Control | 在 claude.ai/code 或手机 App 继续本地会话；代码执行仍在本机；多端同步对话及 subagent/workflow 进度；断网自动重连 | CC:remote-control |
| 云会话 | Anthropic 托管或自托管环境；`--cloud` 发送到云、`--teleport`/`/teleport` 拉回本地；PR auto-fix | CC:claude-code-on-the-web |
| Computer use | CLI 中 macOS 可用（Pro/Max/Ultra，经 `/mcp` 启用）；Desktop 中 macOS/Windows | CC:computer-use、CC:desktop#let-claude-use-your-computer |
| Claude in Chrome | 用已登录浏览器测试 Web 应用、读控制台、自动化表单 | CC:chrome |
| 代码审查 | 本地 `/code-review [low…max|ultra] [--fix] [--comment]`；云端多 agent `ultrareview`；GitHub PR 自动审查 | CC:code-review-local、CC:ultrareview、CC:code-review |
| Code Mode | 实验性：Claude 写 JavaScript 一次执行多个工具调用（auto 模式下整段代码交分类器一次） | CC:code-mode |
| Advisor | `/advisor`：执行模型在关键时刻咨询更强的顾问模型 | CC:advisor |
| Fast mode | `/fast` 更高输出速度（溢价） | CC:fast-mode |
| Effort | `/effort low…max|auto`；`ultrathink`；skill/subagent 可单独设 effort | CC:model-config#adjust-effort-level |
| 模型 | 别名 `default`/`best`/`fable`/`opus`/`sonnet`/`haiku`/`opusplan`/`[1m]`；`fallbackModel` 链；`availableModels` 组织白名单 | CC:model-config |
| 第三方提供方/网关 | Bedrock、Google Cloud Agent Platform、Microsoft Foundry、Claude Platform on AWS、LLM gateway（`ANTHROPIC_BASE_URL`）、Claude apps gateway（自托管） | CC:third-party-integrations、CC:llm-gateway |
| 遥测 | OpenTelemetry 指标/事件，`prompt.id` 与 hook 的 `prompt_id` 对应 | CC:monitoring-usage |
| 迁移 | `/import [codex|gemini|cursor]` 从其他工具导入配置 | CC:commands |


---

## B. Claude Desktop（macOS / Windows）当前形态

### B1. 平台与技术栈

| 项 | 结论 | 来源 / 可信度 |
| :- | :- | :- |
| 平台 | macOS（Universal，Intel + Apple Silicon）、Windows x64 与 ARM64、Linux beta（Ubuntu 22.04+/Debian 12+，apt 或 .deb，x64/arm64） | 官方：CC:desktop、[Install Claude Desktop](https://support.claude.com/en/articles/10065433-install-claude-desktop) |
| 系统要求 | macOS 13 Ventura+；Windows 10+；Cowork 本地 VM 在 Linux 需 KVM、约 25 GB 磁盘、至少 8 GB 内存（运行时 VM 占 4 GB） | 官方：同上 |
| 分发 | macOS `.dmg`（可经 Jamf/Kandji MDM）；Windows MSIX（可静默安装，Intune/SCCM）；Linux 由 apt 更新 | 官方：CC:desktop#deployment、[Deploy Claude Desktop for Windows](https://support.claude.com/en/articles/12622703-deploy-claude-desktop-for-windows) |
| 发布节奏 | 2026-06-05 至 2026-11-13 约 5 个月发布 82 个版本，版本号已到 v5.x；每版注明内置 Claude Code 版本 | 官方：[Claude Desktop changelog](https://claude.com/docs/cowork/claude-desktop-changelog)（本地计数） |
| **UI 技术栈** | **Electron（Chromium + Node.js）**。官方文档未直接写 "Electron"，但有多处官方间接证据：① Desktop changelog 新增 `claude_desktop_config.json` 的 **`chromiumFlags`** 设置（如 `--disable-gpu`，在图形初始化前生效）；② MCPB 文档称 **Node.js "Included with Claude Desktop on macOS and Windows"**；③ Anthropic 员工 Boris Cherny（Claude Code 团队）在 HN 公开解释选择 Electron 的原因（团队有 Electron 背景、Web/桌面共享代码保证一致、"Claude is great at it"） | ①② 官方文档；③ Anthropic 员工公开发言（非官方文档）：[HN 47104973](https://news.ycombinator.com/item?id=47104973)；第三方评论 [Daring Fireball 2026-07-03](https://daringfireball.net/2026/07/claudes_criminally_bad_mac_app_is_an_inside_job) |
| Code 标签页引擎 | 与 CLI 同一引擎，每个 Desktop 版本捆绑一个 Claude Code 版本（v5.11492.5 → CC 2.1.325）；与 CLI 共享配置、CLAUDE.md、MCP、hooks、skills；可用 `/desktop` 或 `claude --desktop --resume <id>` 把 CLI 会话移入 Desktop，Desktop 内 `/resume` 可接续 CLI 会话 | 官方：CC:desktop#coming-from-the-cli、Desktop changelog |
| Cowork 运行时 | "Cowork runs code in an isolated virtual machine on your computer"（Linux 用 QEMU/KVM/virtiofsd；Windows 需 Virtual Machine Platform）；新的统一体验中长任务也可在云端运行 | 官方：[Install Claude Desktop](https://support.claude.com/en/articles/10065433-install-claude-desktop)、[Cowork and chat are one Claude](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude) |

### B2. 功能模块

| 模块 | 当前形态 | 来源 |
| :- | :- | :- |
| **Chat + Cowork（统一）** | 正在灰度：Chat 与 Cowork 合并为同一种对话，不再先选模式，由 Claude 决定用快速回答还是多步执行；Recents 统一列出聊天与 Cowork 任务；合并后不可切回。Cowork = "与 Claude Code 相同的 agentic 架构"，面向知识工作：读写本地文件（仅限已连接文件夹）、子 agent 并行、生成 Excel/PPT/文档；权限模式 Manual / Auto / Skip；删除文件需显式许可；定时任务可在云端运行 | [Cowork overview](https://claude.com/docs/cowork/overview)、[Get started with Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)、[Cowork and chat are one Claude](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude) |
| **Code 标签页** | Claude Code 的 GUI（详见 B3） | CC:desktop |
| **Projects** | 共享文件、指令与上下文；每个项目独立记忆；新版 Projects 以"一个长期对话 + 并行云端线程"形式从 Claude Code 开始灰度 | [What are projects](https://support.claude.com/en/articles/9517075-what-are-projects)、CC:claude-projects |
| **Artifacts** | Claude 产出的可编辑、可分享的设计/文档/仪表盘/小工具，在对话旁打开并保存在 Artifacts 标签页；付费套餐含 Claude Design、Claude Slides、Claude Docs；单个 artifact 默认可存 100 MB 数据 | [What are artifacts](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them)、CC:artifacts |
| **Customize** | 侧边栏统一管理 Connectors、Skills、Plugins（Cowork 从此处取配置并经 claude.ai 账户同步；Cowork **不读** `~/.claude`） | CC:desktop#extend-claude-code、[Cowork overview](https://claude.com/docs/cowork/overview) |
| **Connectors** | 带图形配置流程的 MCP server（远程，经 Anthropic 基础设施访问）；自定义 connector | CC:desktop#connect-external-tools、[Connectors](https://claude.com/docs/connectors/getting-started) |
| **Desktop Extensions（.mcpb）** | MCP Bundle：zip（本地 MCP server + `manifest.json`），一键安装；stdio 本地运行，可访问本地文件/内网，捆绑依赖，离线可用；推荐 Node.js（随 Desktop 附带）；有精选目录、代码签名、API key 加密存储、企业白名单；位置 Settings > Desktop app > Extensions | [Build a desktop extension with MCPB](https://claude.com/docs/connectors/building/mcpb)、[MCPB spec](https://github.com/modelcontextprotocol/mcpb)、[Desktop Extensions 博客](https://www.anthropic.com/engineering/desktop-extensions) |
| **`claude_desktop_config.json`** | 传统本地 MCP 配置；Code 标签页本地会话也会加载其中的 server | CC:desktop#mcp-servers-from-the-claude-desktop-chat-app |
| **Quick entry** | macOS 双击 Option 呼出，支持截图与语音听写；Linux 视 X11/Wayland 而定 | [Quick entry](https://support.claude.com/en/articles/12626668-use-quick-entry-with-claude-desktop-on-mac)、[Install Claude Desktop](https://support.claude.com/en/articles/10065433-install-claude-desktop) |
| **Computer use** | 研究预览，macOS/Windows，Pro/Max/Ultra（不含 Team/Enterprise），默认关闭；macOS 需辅助功能+屏幕录制权限，可后台运行；按 App 分级授权（浏览器仅查看、终端/IDE 仅点击）；优先级：connector > Bash > Chrome > iOS Simulator > computer use | CC:desktop#let-claude-use-your-computer |
| **Dispatch** | Cowork 中的长期 agent：一个对话里描述结果，拆分为多个子任务，各自作为 Cowork 或 Code 会话运行；手机可派活、完成/需审批时推送；新统一体验中对新用户不再提供 | [Dispatch](https://claude.com/docs/cowork/guide/dispatch)、CC:desktop#sessions-from-dispatch、[Cowork and chat are one Claude](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude) |
| **定时任务** | Code 标签页本地定时任务；Cowork 定时任务可在云端运行 | CC:desktop-scheduled-tasks |
| **第三方模型** | 可经 Bedrock / Google Cloud Agent Platform / Foundry / 网关运行完整 Desktop（含 Cowork） | [Claude on third-party platforms](https://claude.com/docs/third-party/claude-desktop/overview)、CC:desktop#feature-comparison |

### B3. Code 标签页交互设计（原生 UI 对标清单）

来源：CC:desktop（各小节）、CC:desktop-quickstart、[Redesigning Claude Code on desktop for parallel agents（2026-04-14）](https://claude.com/blog/claude-code-desktop-redesign)。

**会话与导航**

| 要素 | 细节 |
| :- | :- |
| 会话模型 | 每个会话 = 独立聊天历史 + 项目文件夹 + 独立上下文与改动 |
| 新建会话行 | 提示框下方一行依次为：**环境选择器**（本地 / 云 / SSH / WSL / 已保存环境，`Cmd+Opt+1–9` 快速选）→ **项目文件夹**（云会话改为选仓库，可多仓库）→ **Worktree 开关** → **权限模式选择器** → **模型选择器**（另有 effort 菜单） |
| 侧边栏 | 会话列表，悬停标题出现"分组与排序"；按状态/项目/环境过滤或按项目分组；Archived 标签页；点标题重命名；Dispatch 派生的会话按文件夹归组 |
| 并行 | `Cmd+N` 新建；`Ctrl+Tab` 切换；Option+点击 = **分屏**并排两个会话（焦点窗格高亮、另一侧变暗）；Cmd+点击 = **新窗口** |
| 归档 | 手动归档；PR 合并/关闭后**自动归档**；归档前若 worktree 有未提交改动会询问；本地 worktree 约 30 天后删除 |
| 跨会话 | Claude 可列出/读取/给其他 Code 会话发消息、重命名、归档（归档前出审批卡片，Auto/Bypass 除外）；收到的消息以"来自某会话"卡片显示并可跳回 |
| 建议任务 | Claude 发现当前任务外值得做的事时出卡片：Start（新会话）/ Do it here / Options / Start all |
| 继续到其他表面 | Open in → Cloud（对话以摘要迁移）/ 编辑器 / 文件管理器；Remote Control 开关让会话出现在 claude.ai/code 与手机 App |
| 通知 | 未在查看的会话完成任务时发 OS 通知 |

**工作区窗格**

| 要素 | 细节 |
| :- | :- |
| 窗格系统 | chat、diff、browser、terminal、file、plan、tasks、subagent、iOS Simulator（macOS）；**拖拽表头重排、拖边调整大小**；窄窗口时按钮收进 ⋮ 菜单；窗格可**弹出为独立窗口**再停靠回来；`Cmd+\` 关闭焦点窗格 |
| Session details 面板 | 聊天旁的一组卡片：运行环境（含 Remote Control 开关）、Changes（`+12 -1` 行数、PR 与 CI 状态）、正在运行的内容、**Context 用量百分比**（可展开分类明细） |
| Diff 视图 | 按文件审阅；悬停行号点 **+** 添加行内评论，多条评论 `Cmd+Enter` 一次提交，Claude 据此修改并产生新 diff；为大改动集重写以提速 |
| 代码审查卡片 | `/code-review` 结果按文件分组：Walk through in diff（逐条定位，Fix this one / 忽略）、Apply fixes |
| PR 监控 | Changes 卡片显示 PR 与 CI；⋮ 菜单 **Auto-fix**（修失败的检查并处理他人审查评论）、**Merge when ready**（开启 GitHub auto-merge，默认 squash）；依赖 `gh` CLI |
| 集成终端 | ``Ctrl+` `` 打开，与 Claude 共享工作目录和环境 |
| 文件窗格 | 点击聊天中的路径打开；本地会话可编辑（默认自动保存，可关闭改为手动 Save/Cancel；磁盘变化时 Override/Discard）；云/SSH/WSL 只读；右键：Attach as context / Open in（VS Code、Cursor、Zed）/ Show in Finder / 复制路径 |
| Browser 窗格 | 带标签页的内置浏览器：预览 dev server、HTML/PDF/视频；Claude **自动验证**改动（截图、DOM 检查、点击、填表）；Dev servers 菜单启停服务；Keep cookies；`.claude/launch.json` 配置预览服务；外部网站上的写操作经安全分类器审查，首次操作弹 Allow once / Always allow / Deny；`Cmd+Shift+S` 选取页面元素 |
| 后台任务窗格 | 展示 subagent、后台 shell 命令、dynamic workflow，点击看输出或停止 |
| Side chat | `Cmd+;` 或 `/btw`：可读取主线程上下文但不回写，不落盘 |
| 视图模式 | `Ctrl+O` 循环：Normal（工具调用折叠为摘要）/ Thinking（再加思考摘要）/ Verbose（全部工具调用与中间步骤） |
| 提示框 | Enter 发送；运行中可直接输入纠正（当前动作完成后读取）或点停止；`+` 菜单：附件、skills、connectors、plugins、Add folder；`@` 文件补全；拖放图片/PDF；灰色**建议下一条 prompt**，Tab/→ 接受 |
| 权限交互 | 模式选择器（Manual / Accept edits / Plan / Auto / Bypass），所选模式按文件夹记忆；Manual 下逐个显示 diff 与批准/拒绝按钮；Bypass 需在设置中开启（Team/Enterprise 由组织策略控制）；`dontAsk` 仅 CLI；Plan 只作用于当次会话 |
| 用量 | 提示框下方用量环：点击看套餐用量（所有 Claude Code 表面共享）；`/context` 打印分类明细 |
| 快捷键 | `Cmd+/` 列出全部；`Cmd+N`/`Cmd+W`/`Ctrl+Tab`/`Cmd+Shift+[ ]`/`Esc` 停止/`Cmd+Shift+D` diff/`Cmd+Shift+B` 浏览器/``Ctrl+` `` 终端/`Cmd+;` side chat/`Cmd+Shift+M` 权限菜单/`Cmd+Shift+I` 模型菜单/`Cmd+Shift+E` effort 菜单 |

**环境与远程**

- 已保存环境（本地/SSH，含文件夹、worktree 默认值、环境变量）；本地环境变量编辑器；Desktop 自动设置的环境变量；可关闭扩展思考或设定固定思考预算。
- **SSH 会话**：远程主机运行 Claude Code，支持 ssh config、代理/CA、端口转发、Windows 远程主机、断开时任务继续、自定义 worktree 位置、从链接/命令创建连接、团队预配置与主机白名单、可关闭本地会话只发 SSH。
- **WSL 会话**：在 WSL 2 发行版中运行 Code 会话（CC:desktop-wsl）。
- **云会话**：选择 Cloud 环境，可多仓库，关电脑后继续。
- **iOS Simulator 窗格**：Claude 构建/运行 iOS 应用时自动打开（CC:desktop-ios-simulator）。

### B4. Desktop 与 CLI 的差异

来源：CC:desktop#feature-comparison、#whats-not-available-in-desktop。

| 能力 | CLI | Desktop |
| :- | :- | :- |
| 权限模式 | 全部（含 `dontAsk`） | Manual / Accept edits / Plan / Auto；Bypass 需开启 |
| 第三方模型 | Bedrock / Agent Platform / Foundry | 默认 Anthropic API，可经网关或 3P 部署 |
| MCP | 配置文件 | Connectors UI 或配置文件 |
| 插件 | `/plugin` | 插件管理 UI |
| @文件 | 文本 | 带补全 |
| 附件 | 不支持 | 图片、PDF |
| 会话隔离 | `--worktree` | Worktree 开关 |
| 多会话 | 多个终端 | 侧边栏 |
| 定时任务 | cron / CI | 内置定时任务 |
| Computer use | macOS（经 `/mcp`） | macOS + Windows |
| 脚本/自动化 | `-p`、Agent SDK | 不支持（仅交互） |
| Agent teams | 支持（实验） | **不支持**（改用 dynamic workflows） |
| 终端对话框类命令 | 支持 | `/permissions` 等无参命令返回"isn't available in this environment"；`/config` 打开 Settings |
| 行内代码补全 | — | 不提供 |

### B5. 企业管控

来源：CC:desktop#enterprise-configuration、CC:managed-settings。

- 管理后台开关：是否允许 Desktop 中使用 Claude Code、云会话、Remote Control（HIPAA 组织默认关闭 Desktop）。
- Managed settings 对 Code 标签页同样生效（部分键在 Code 标签页行为不同）；可限制可用权限模式、SSH 主机、外部浏览、预览脚本等；MDM 可限制登录到本组织。
- 遥测：Code 标签页会话经 managed settings 的 `env` 配置 OTel 导出。

---

## C. Claude API 层对 harness 有影响的能力

来源前缀 PF:。当前模型均 1M 上下文、128K 输出（Batch API 加 beta 头可到 300K 输出），见 PF:models/overview。

| 能力 | 要点 | 对 PiArc harness 设计的影响 | 来源 |
| :- | :- | :- | :- |
| **Adaptive thinking** | 当前模型默认 adaptive（Opus 5.5、Fable 5.2 "always on"）；手动 `budget_tokens` 在 4.6 代弃用、之后模型返回 400；返回的 thinking 是**摘要**而非原始推理，`display: "summarized"/"omitted"` 控制是否返回；每个 thinking block 带加密 `signature`，多轮/工具循环中须原样回传；thinking 计为输出 token 并占用 `max_tokens`；工具调用之间可出现 interleaved thinking | 不能再提供"思考 token 预算"滑块，改为 effort；UI 展示思考摘要（对应 Desktop 的 Thinking 视图）；消息存储必须保留 thinking block 与 signature | PF:build-with-claude/thinking、PF:models/overview |
| **Effort** | `output_config.effort`：low / medium / high / xhigh / max；Opus 5.5、Haiku 5.5 默认 medium，其余默认 high；影响所有输出 token（含工具调用数量与详略） | UI 提供 effort 菜单（Desktop `Cmd+Shift+E`）；可按 subagent/skill 单独设置 | PF:build-with-claude/effort |
| **Preserved thinking / prefix check** | thinking block 绑定其之前的 `system`、`tools` 与全部历史消息，以及模型和账户；前缀变化会 400 或被丢弃（`prefix_mismatch_behavior`，响应中 `input_transformations` 说明丢弃情况）；切换到读不了该 block 的模型时 API 静默丢弃且不计费，切回后仍可读；Fable 5.2 能读 Opus/Sonnet/Haiku 5.5 的 block，反之不行；Fable 5.2/Sonnet 5.5/Haiku 5.5 的 block 绑定账户 | **对多模型 harness 影响最大**：会话历史应只追加、不改写；不要按模型维护多份历史；会话中途改 system prompt 或增删工具会破坏 thinking 连续性（动态工具应走 tool search/`defer_loading`）；客户端侧 compaction 改写早期回合会使后续 thinking 失效 | PF:build-with-claude/preserved-thinking、[release notes 2026-11-09](https://platform.claude.com/docs/en/release-notes/overview) |
| **Prompt caching** | 自动缓存（顶层 `cache_control`，断点随对话前移）或显式断点（最多 4 个）；前缀顺序 tools → system → messages；默认 TTL 5 分钟（从请求开始计时，命中即刷新），1 小时 TTL 写入价 2×；5 分钟写入 1.25×；读取为基础价 10%（Opus 5.5/Sonnet 5.5 为 5%，Fable 为 2.5%）；20 block 回溯窗口 | 请求布局必须"稳定前缀在前"；模型切换等于缓存全失（Claude Code 会在缓存热时提示确认）；长时间工具调用可能让 5 分钟缓存过期，需考虑 1h TTL；可在 UI 展示缓存命中率/切换成本 | PF:build-with-claude/prompt-caching、CC:prompt-caching |
| **Context editing** | 服务端策略 `clear_tool_uses_20250919`（超阈值清理最旧工具结果，可连工具输入一起清，`clear_at_least` 控制最少清理量）与 `clear_thinking_20251015`（控制保留多少旧 thinking）；客户端保留完整历史；在 preserved-thinking 模型上服务端编辑不会使 thinking 失效 | 使用 Claude 时可把"旧工具结果清理"交给服务端，避免客户端改写历史；需权衡缓存失效 | PF:build-with-claude/context-editing |
| **Server-side compaction** | 按需 compaction（beta `compact-2026-09-04`，顶层 `compaction` 参数，可保留最近回合、可后台运行、可自定义摘要 prompt、可再次压缩）与阈值 compaction | 对 Claude 模型可直接用 API 摘要；但 PiArc 多模型仍需自有 compaction 逻辑，两者应统一抽象 | PF:build-with-claude/compaction |
| **Memory tool** | `memory_20250818`，客户端工具：Claude 发出对 `/memories` 下文件的 create/read/update/delete 请求，由应用落地到自有存储；开启后 Claude 开工前自动查看记忆目录 | 与 Claude Code 的 auto memory 思路一致；PiArc 可实现为本地目录并与项目记忆 UI 结合 | PF:agents-and-tools/tool-use/memory-tool |
| **Tool search tool** | `tool_search_tool_regex_20251119` / `tool_search_tool_bm25_20251119`，工具定义标 `defer_loading: true`；官方数据：5 个常见 MCP server 定义约 55K tokens，tool search 通常减少 85% 以上；工具数超过 30–50 个后选择准确率下降；也支持自实现客户端 tool search | MCP 多工具场景必备；对非 Claude 模型需自研同类机制以保持跨模型一致 | PF:agents-and-tools/tool-use/tool-search-tool |
| **Programmatic tool calling** | 需 code execution `code_execution_20260120`+；工具定义加 `allowed_callers` 后，Claude 在沙箱容器中写 Python 批量调用工具，每次调用以带 `caller` 字段的 `tool_use` 暂停返回，由客户端执行后继续；中间结果不进上下文 | harness 需处理"来自代码执行容器的工具调用"与容器 ID；与 Claude Code 实验性 Code Mode 理念相同（本地 JS） | PF:agents-and-tools/tool-use/programmatic-tool-calling |
| **Web search / Web fetch（服务端工具）** | web search：`web_search_20250305` 基础 / `20260209` 动态过滤（Claude 写代码过滤结果）/ `20260318` 响应包含控制；web fetch：`web_fetch_20250910`、`20260209`、`20260309`、`20260318`（动态过滤）；均带引用；与这两者同用时 code execution 免费；并非所有云平台都有 | Claude 路径可直接用服务端工具，其他模型需本地实现；Claude Code 自己的 WebFetch 是本地抓取+小模型提取的有损实现，可作为参考 | PF:agents-and-tools/tool-use/web-search-tool、PF:agents-and-tools/tool-use/web-fetch-tool |
| **Token counting** | `messages/count_tokens` 接受与 Messages 相同的输入（system、tools、图片、PDF）；不接受大多数服务端工具 | 用于上下文用量条与"即将压缩"提示；含服务端工具时需估算 | PF:build-with-claude/token-counting |
| **Files API** | 上传一次得 `file_id`，在 `document`/`image`/`container_upload` 中引用；可下载 skills/code execution 生成的文件 | 附件与生成物管理 | PF:build-with-claude/files |
| **Message threads（beta）** | `message-threads-2026-08-12`：首个请求带完整对话与 `thread: {type: "create"}`，之后只发新消息 + `previous_message_id`，省略 system/tools；服务端保存 5 分钟（最长 1 小时），过期返回 404 需全量重放；应用仍是事实来源 | 长 agent 循环降低请求体积与首 token 延迟；harness 需实现重放路径 | PF:build-with-claude/message-threads |
| **Advisor tool（beta）** | `advisor_20260301`：执行模型在生成中途咨询更强的顾问模型 | 可对应"规划用强模型、执行用快模型"；Claude Code 已有 `/advisor` | PF:agents-and-tools/tool-use/advisor-tool |
| **Fast mode** | `speed: "fast"`，Fable 5.2 输出速度最高 2.5×，按溢价计费 | 可作为 UI 开关（Claude Code `/fast`） | [release notes 2026-11-09](https://platform.claude.com/docs/en/release-notes/overview) |
| **Fine-grained tool streaming** | 工具输入边生成边下发，不做服务端缓冲与 JSON 校验 | 大参数（整文件写入）可实时渲染 diff；需容忍不完整 JSON | PF:agents-and-tools/tool-use/fine-grained-tool-streaming |
| **Structured outputs** | 按 schema 约束输出 | 内部辅助调用（标题生成、分类器、摘要）更稳定 | PF:build-with-claude/structured-outputs |
| **MCP connector** | Messages API 直连远程 MCP server，无需自建 MCP client | 云端执行时可用；本地 harness 仍需自有 MCP client | PF:agents-and-tools/mcp-connector |
| **Agent Skills（API）** | 渐进披露三层（见 A5.1）；API 侧在 code execution 容器中运行 | 与 Claude Code skills 同一标准，可直接复用社区 skill | PF:agents-and-tools/agent-skills/overview |
| **Computer use** | Fable 5.2 使用 `computer_toolset_20260801`（旧 `computer_20251124` 在多数平台返回 400） | 若做原生 computer use 需跟进新工具集 | [release notes 2026-11-09](https://platform.claude.com/docs/en/release-notes/overview) |
| **Managed Agents** | Anthropic 托管的 agent harness（Agent / Environment / Session / Events 四个概念），内置 prompt caching 与 compaction；可用 Anthropic 云沙箱或自托管沙箱，2026-11-12 起可整体自托管 | 可选的云端执行后端，或作为参考架构 | PF:managed-agents/overview、[release notes 2026-11-12](https://platform.claude.com/docs/en/release-notes/overview) |

---

## D. 社区对 Claude Desktop 体验的主要批评

> 说明：以下除"官方 changelog"一栏外，均为用户报告或第三方评论，非 Anthropic 官方数据。GitHub issue 位于 Anthropic 官方仓库 anthropics/claude-code，数据由用户自报。

**1. 内存增长与泄漏（问题最集中）**

- anthropics/claude-code 中同时带 `area:desktop` 与 `perf:memory` 标签的 issue 有 **67 个**，带 `perf:cpu` 的 **24 个**（GitHub Search API，2026-11-14 统计；`area:desktop` 共 7,969 个）。
- [#84693](https://github.com/anthropics/claude-code/issues/84693)（2026-08-07，已关闭）：Desktop **Electron 主进程**内存在 16 GB MacBook Air 上约 15 小时内从 261 MB 增长到 47 GB（约 3.7 GB/h），触发 macOS 全局 jetsam；文中引用相关的 #80056（24 小时内 RSS 4.5–5.15 GB）。
- [#77560](https://github.com/anthropics/claude-code/issues/77560)（2026-07-14，标签 `perf:memory`、`perf:cpu`、`area:desktop`）：启动单个 Claude Code 会话后约 **70% CPU、2.4 GB RAM**（MacBook Air M3 16 GB），无风扇机器持续发热。
- [#76268](https://github.com/anthropics/claude-code/issues/76268)：Desktop 让每个会话的进程树常驻——183 个空闲会话、约 2,600 个 MCP sidecar、约 160 GB RSS。
- [#99831](https://github.com/anthropics/claude-code/issues/99831)（2026-10-06，open）：stdio MCP server 按会话重复启动（每个约 1 GB），且不能会话中途启动。
- [#73834](https://github.com/anthropics/claude-code/issues/73834)：artifact 预览渲染进程膨胀到 7.6 GB，导致 Claude Code daemon 驱逐后台会话。
- [#48210](https://github.com/anthropics/claude-code/issues/48210)：单会话 `.jsonl` 增长到 3.7 GB 后启动时 V8 堆 OOM 崩溃。
- Windows：[#96870](https://github.com/anthropics/claude-code/issues/96870)（MSIX 下每个会话子进程泄漏内核非分页池）、[#96299](https://github.com/anthropics/claude-code/issues/96299)（`claude.exe` 会话进程累积不退出）、[#94198](https://github.com/anthropics/claude-code/issues/94198)（CoworkVMService 非分页池泄漏）。

**2. UI 卡顿 / 流式输出时 CPU 飙升 / 切换慢**

- [#48299](https://github.com/anthropics/claude-code/issues/48299)（Linux，64 GB/i9）：打字、滚动、切换面板持续卡顿，且运行越久越严重，报告者判断瓶颈在 Electron 渲染层。
- HN 讨论 "Why is Claude an Electron app?"（[47104973](https://news.ycombinator.com/item?id=47104973)，428 分/458 评论，2026-02）：用户反映流式输出时 UI 卡顿并占满 CPU、切换会话要等约 1 秒、新任务启动卡数秒、后台运行时笔记本发烫、历史搜索基本只按标题。

**3. "非原生"体验**

- John Gruber（[Daring Fireball，2026-07-03](https://daringfireball.net/2026/07/claudes_criminally_bad_mac_app_is_an_inside_job)）称其为 "lazy Electron clunker"，批评跨平台一致性让 Mac 版 "feels just as wrong on all platforms"，并与 ChatGPT 原生 Mac 应用对比；文中把 Electron 选型归因于负责 Cowork 与 Claude Code Desktop 的工程负责人 Felix Rieseberg（Electron 联合维护者）——属评论观点。

**4. 官方 changelog 侧面印证（官方来源）**

[Claude Desktop changelog](https://claude.com/docs/cowork/claude-desktop-changelog) 近几个月持续出现性能修复，例如：v5.1231.0（2026-11-10）"Fixed the Code tab freezing when many sessions are open"；v2.7032.0（2026-09-22）"Fixed the app freezing for a few seconds after launch or reload on some machines, most often on Windows"、"Fixed sessions starting slowly … when many sessions are open"、大仓库新建 worktree 会话时 macOS 卡顿最长半分钟；v2.9939.2（2026-09-24）"Fixed the app using a full CPU core on Windows after archived sessions' worktrees were cleaned up"；v2.110.0（2026-09-15）新增 `chromiumFlags` 以规避 GPU 驱动崩溃，并修复 Windows MSIX 后台下载更新时冻结后重载。更早的内存修复：v1.28929.0（2026-08-11）"Fixed the app's memory use growing without bound during long-running sessions"；v1.37937.0（2026-08-25）修复打开超大转录或大量 subagent 的会话时内存极高、窗口空白；v1.46388.1（2026-09-04）"Fixed memory use on macOS growing steadily while working with files, which could end with the system reporting it had run out of application memory"。（WebSearch 摘要把第一条标为 2026-11，经核对 changelog 原文实为 2026-08-11。）

**对 PiArc 的含义**：可量化的差异化方向是**长会话内存稳定性、多会话（几十到上百个）常驻成本、流式渲染帧率、会话切换延迟、MCP 进程按项目共享而非按会话复制**。建议在 PiArc 立项时就为这几项设基准测试，与 Claude Desktop 同场景对比。

---

## E. 对 PiArc 的设计启示与风险

1. **鉴权/商业模式风险（需优先确认）**：官方明确禁止第三方应用提供 Claude.ai 登录、代用户使用 Free/Pro/Max/Ultra 订阅凭证，或收集/中转 Claude.ai 凭据与会话 token。PiArc 若想让用户"用 Claude 订阅"，只有两条合规路径：① 用户自带 API key 或云厂商凭证；② 在 PiArc 中运行**未修改的 Claude Code 二进制**，由用户在其中通过 Anthropic 自己的流程登录（并遵守不移除登录方式、不代付转售等条件）。品牌上不得把产品或功能称为 "Claude Code"。来源：CC:legal-and-compliance、CC:agent-sdk/overview#branding-guidelines。
2. **Harness 核心抽象可直接对标**：权限（6 模式 + deny/ask/allow 规则 + 分类器）、hooks（33 事件、5 种 handler、exit code/JSON 协议）、subagents（frontmatter 格式）、skills（Agent Skills 标准）、MCP（作用域 + tool search）、CLAUDE.md/AGENTS.md 层级与 auto memory、checkpoint/rewind。兼容这些**文件格式与目录约定**（`.claude/agents`、`.claude/skills`、`.claude/rules`、`.mcp.json`、`settings.json` 的 hooks/permissions 段）可以零成本迁移用户已有配置；Claude Code 自身也提供 `/import codex|gemini|cursor`，说明行业已在互相兼容。
3. **多模型带来的特有约束**：Claude 的 preserved thinking/prefix check 要求历史只追加、system/tools 稳定；prompt caching 要求稳定前缀；模型切换会导致缓存全失和 thinking 丢弃。Pi 作为多模型底座，需要一个"按 provider 能力降级"的消息层（thinking block 透传、按模型选择 compaction 策略、切换模型时提示成本——Claude Code 的 PreModelSwitch hook 已提供 `prompt_cache_warm` 与 `estimated_cache_write_usd`）。
4. **原生 UI 对标清单**直接取 B3：会话侧边栏 + 分屏/多窗口、每会话 worktree、可拖拽窗格、diff 行内评论批量提交、PR/CI 卡片、内置浏览器自验证、side chat、三档视图、Context 百分比卡片、模式/模型/effort 选择器、后台任务窗格、建议任务卡片、Remote Control。
5. **后台会话架构**：Claude Code 已采用 supervisor 守护进程 + 每会话独立进程 + 空闲一小时回收 + 崩溃重启 + 状态落盘（`roster.json`、`jobs/<id>/state.json`）。Desktop 内存问题很大一部分来自"每会话进程树/MCP sidecar 常驻"。PiArc 可在这一点上做差异化（进程池、MCP 共享、空闲回收策略可见可调）。
6. **Windows 原生的已知坑**：Claude Code 沙箱在原生 Windows 不可用（只能 WSL2）；Glob/Grep 在 Windows 默认提供、在类 Unix 默认移除；PowerShell 工具与 Git Bash 依赖；MSIX 下的内核非分页池泄漏（#96870）。

---

## F. 未查到官方来源 / 需谨慎引用的点

1. **Claude Desktop 是 Electron**：官方文档未直接写明。现有官方证据都是间接的（`chromiumFlags` 设置、"Node.js 随 Claude Desktop 附带"），直接确认来自 Anthropic 员工在 HN 的发言与第三方报道。
2. **Desktop 内存/CPU/启动速度的官方基准**：未找到 Anthropic 发布的性能指标或对比数据，D 节数据均为用户自报（GitHub issue、HN、博客）。
3. **Cowork VM 内存占用 9.5–12 GB、启动即加载**：只见于二手博客（WebSearch 摘要），未经官方核实；官方只写了 Linux 上 VM 运行时占 4 GB、需约 25 GB 磁盘。
4. **Desktop 冷启动时间、安装包体积**：未查到官方数据。
5. **Claude Desktop 渲染层/前端框架细节**（React 等）、Code 标签页与内置 Claude Code 进程间的通信协议：未查到官方描述（只能确定 SDK 侧是 stream-json + control request）。
6. **Agent teams 的 Desktop 支持时间表、Agent view 转正时间**：官方只标注"实验性/研究预览"，无路线图。
7. Cowork 的 "Manual / Auto / Skip" 权限模式与 Claude Code 6 种模式的精确对应关系：官方只说 Cowork 有自己的模式体系（CC:permission-modes Desktop 标签页），未给映射。

---

## G. 主要来源索引（均于 2026-11-14 抓取）

**Claude Code（code.claude.com/docs/en/）**
- 工具：https://code.claude.com/docs/en/tools-reference
- 权限模式：https://code.claude.com/docs/en/permission-modes
- 权限规则：https://code.claude.com/docs/en/permissions
- Settings / 层级：https://code.claude.com/docs/en/settings 、https://code.claude.com/docs/en/settings-reference
- Managed settings：https://code.claude.com/docs/en/managed-settings
- Auto mode 配置：https://code.claude.com/docs/en/auto-mode-config
- Hooks 参考 / 指南：https://code.claude.com/docs/en/hooks 、https://code.claude.com/docs/en/hooks-guide
- Subagents：https://code.claude.com/docs/en/sub-agents
- 并行 agent 总览：https://code.claude.com/docs/en/agents
- Agent teams：https://code.claude.com/docs/en/agent-teams
- Agent view：https://code.claude.com/docs/en/agent-view
- 跨会话消息：https://code.claude.com/docs/en/cross-session-messaging
- Dynamic workflows：https://code.claude.com/docs/en/workflows
- Skills：https://code.claude.com/docs/en/skills
- 命令：https://code.claude.com/docs/en/commands
- 插件：https://code.claude.com/docs/en/plugins/overview 、https://code.claude.com/docs/en/plugins/components
- Mods：https://code.claude.com/docs/en/plugins/mods/overview
- Output styles：https://code.claude.com/docs/en/output-styles
- Status line：https://code.claude.com/docs/en/statusline
- Memory：https://code.claude.com/docs/en/memory
- 上下文窗口：https://code.claude.com/docs/en/context-window 、https://code.claude.com/docs/en/how-claude-code-works
- Prompt caching（CC）：https://code.claude.com/docs/en/prompt-caching
- 模型配置：https://code.claude.com/docs/en/model-config
- Checkpointing：https://code.claude.com/docs/en/checkpointing
- 沙箱：https://code.claude.com/docs/en/sandboxing 、https://code.claude.com/docs/en/sandbox-environments
- Worktree：https://code.claude.com/docs/en/worktrees
- MCP：https://code.claude.com/docs/en/mcp
- Agent SDK：https://code.claude.com/docs/en/agent-sdk/overview 、https://code.claude.com/docs/en/agent-sdk/typescript 、https://code.claude.com/docs/en/agent-sdk/python 、https://code.claude.com/docs/en/agent-sdk/permissions 、https://code.claude.com/docs/en/agent-sdk/session-storage
- Headless：https://code.claude.com/docs/en/headless
- Desktop：https://code.claude.com/docs/en/desktop 、https://code.claude.com/docs/en/desktop-quickstart
- 平台对比：https://code.claude.com/docs/en/platforms
- Remote Control / 云：https://code.claude.com/docs/en/remote-control 、https://code.claude.com/docs/en/claude-code-on-the-web
- 法务合规：https://code.claude.com/docs/en/legal-and-compliance
- Changelog：https://code.claude.com/docs/en/changelog

**Claude API（platform.claude.com/docs/en/）**
- 模型：https://platform.claude.com/docs/en/models/overview
- Thinking：https://platform.claude.com/docs/en/build-with-claude/thinking
- Effort：https://platform.claude.com/docs/en/build-with-claude/effort
- Preserved thinking：https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
- Prompt caching：https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Context editing：https://platform.claude.com/docs/en/build-with-claude/context-editing
- Compaction：https://platform.claude.com/docs/en/build-with-claude/compaction
- Context windows：https://platform.claude.com/docs/en/build-with-claude/context-windows
- Token counting：https://platform.claude.com/docs/en/build-with-claude/token-counting
- Files：https://platform.claude.com/docs/en/build-with-claude/files
- Message threads：https://platform.claude.com/docs/en/build-with-claude/message-threads
- Memory tool：https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- Tool search：https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- Programmatic tool calling：https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling
- Web search / fetch：https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool 、https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool
- Advisor：https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool
- Agent Skills：https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- Managed Agents：https://platform.claude.com/docs/en/managed-agents/overview
- Release notes：https://platform.claude.com/docs/en/release-notes/overview

**claude.com / support.claude.com / anthropic.com**
- Claude Desktop changelog：https://claude.com/docs/cowork/claude-desktop-changelog
- Cowork：https://claude.com/docs/cowork/overview 、https://claude.com/docs/cowork/guide/dispatch
- MCPB：https://claude.com/docs/connectors/building/mcpb
- Desktop 重设计博客：https://claude.com/blog/claude-code-desktop-redesign
- Install Claude Desktop：https://support.claude.com/en/articles/10065433-install-claude-desktop
- Get started with Cowork：https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork
- Cowork 与 chat 合并：https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude
- Projects / Artifacts：https://support.claude.com/en/articles/9517075-what-are-projects 、https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them
- Desktop Extensions 工程博客：https://www.anthropic.com/engineering/desktop-extensions

**社区（非官方）**
- HN：https://news.ycombinator.com/item?id=47104973
- Daring Fireball：https://daringfireball.net/2026/07/claudes_criminally_bad_mac_app_is_an_inside_job
- GitHub issues：https://github.com/anthropics/claude-code/issues/84693 、/77560 、/48299 、/76268 、/99831 、/73834 、/48210 、/96870 、/96299 、/94198
