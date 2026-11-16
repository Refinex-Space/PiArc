# PiArc 交付计划

这份文件是 PiArc 从 0 到 1 的交付总控台，记录：

- 怎么用任务提示词推进项目；
- 每个任务的状态；
- 进行中任务的检查点；
- 每次会话的记录。

每个任务开工时都先读它，收尾时都更新它。

| 文件 | 作用 |
|---|---|
| `docs/plan/PLAN.md`（本文件） | 看板、覆盖关系、检查点、登记事项、会话日志 |
| [`docs/plan/protocol.md`](protocol.md) | 执行协议：每个任务都必须遵守的开工、纪律、决策分级、门禁、收尾与报告规则 |
| [`docs/plan/tasks/`](tasks/) | 每个任务一份提示词，`/task <编号>` 启动 |
| [`docs/plan/acceptance.json`](acceptance.json) | 全部验收项，判断任务是否完成的唯一依据 |
| [`docs/plan/references.md`](references.md) | 参考源码的使用方法与边界 |
| [`docs/spikes/`](../spikes/README.md) | M0 验证项（S1–S10）的跟踪表与报告 |

## 怎么使用

### 开工前（只做一次）

1. **生成根 `CLAUDE.md`（推荐）**：在仓库根目录运行 `/dev-flow:deep-init`。T01 会在其中补上"交付流程"与"命令"两节；不运行也可以，T01 会按模板创建。
2. **提交规划文件**：执行协议的开工检查要求工作区干净，所以规划文件提交之后才能开始 T01。由你确认后执行：

   ```bash
   git add docs .claude
   git commit -m "docs: add delivery plan, execution protocol and task prompts"
   ```

   规划文件在当前分支提交即可，是否合并到 `main` 由你决定。

3. **准备第二台电脑**：W0 起需要一台 Windows 11 电脑，W 系列任务在那里执行。见下文"Windows 任务"。

### 每个任务的步骤

1. **开新会话**：在仓库根目录启动 Claude Code，或在已有会话中输入 `/clear`。一个任务一个会话，不要在同一个会话里连续做两个任务。
2. **设置模型与 effort**：模型用 Opus 5.5；effort 按看板中的推荐值，用 `/effort high` 或 `/effort xhigh` 设置。
3. **启动任务**：输入 `/task T05`（把编号换成要做的任务），或者把 `docs/plan/tasks/` 下对应文件的全部内容粘贴进去，两种方式等价。
4. **可选：设置完成条件**：长任务可以再输入一条 `/goal`，例如 `/goal docs/plan/acceptance.json 中 T05 的验收项全部为 passing 或 blocked，且 PLAN.md 中 T05 的状态为已完成`。
5. **看报告**：任务结束时智能体给出固定格式的报告。重点看"验收结果"中的失败与阻塞项，以及"遗留与风险"中需要你决定的事。
6. **推送**：智能体只提交不推送。确认无误后由你执行 `git push`。

### 中断了怎么办

会话中断、电脑休眠、你手动停止都没关系。开新会话，再输入一次 `/task T05` 即可：

- 执行协议会识别出任务处于"进行中"；
- 从"当前任务检查点"继续，不会从头再做。

### 需要你做决定的时候

任务会在三种情况下停下来等你：

| 情况 | 你看到什么 | 你要做什么 |
|---|---|---|
| 变更型 ADR | 一份状态为"提议"的 ADR，看板状态为"阻塞（等待用户确认 ADR-xxxx）" | 读完 ADR，在新会话中说"采纳 ADR-00xx"或"否决 ADR-00xx，理由是……"，然后再次 `/task` 该任务 |
| 任务关口 | 设计增补、截图证据或实机操作清单，看板状态为"阻塞（等待用户……）" | 按报告确认或完成实机操作，在新会话中再次 `/task` 该任务并附上你的意见或结果 |
| 需要的用户决定 | 任务头部列出的 D 编号（需求规格第 7 节）尚未落实 | 在需求规格中给出决定，再继续该任务 |

带关口的任务：T12（实机）、T18（视觉）、T39（Windows 隔离方案以 ADR 提议的形式请你决定）、T46（设计）、T47（设计）、T49（实机：快捷指令）、T50（实机：推送、受保护环境与密钥、批准签名步骤）、R1（实机：T09、T10 留下的 macOS 输入法核对清单）、T51 与 W0–W4（实机：系统放行、输入法、读屏等需要你在真实系统界面上操作的步骤）。

macOS 任务结束时，凡是要靠 Windows CI 证明的验收项都会先标为 `blocked`（智能体不推送，拿不到 CI 结果），任务显示"部分完成"。你推送后，下一个任务开工时会按 CI 结果关闭这些项（执行协议"开工"第 4 步）。

### 需要你提前准备的事

| 事项 | 最晚在 | 说明 |
|---|---|---|
| ~~D2：应用标识（bundle id、AppUserModelID）与产品域名~~ | T08 开工前 | **已决定**（2026-11-15）：域名 `piarc.cn`，应用标识 `cn.piarc.desktop`；发布后不能再改 |
| D6：Intel（x64）版本是否发布 | T12 开工前 | 没有决定时按需求规格的建议首发 x64，之后按使用统计决定是否继续 |
| D3：视觉品牌的主色与字标（图标已定，见 `design/brand/`） | T18 开工前 | 没有时 T18 用中性临时令牌，并在视觉关口请你确认；Pi logo 的使用许可在 R6 前确认 |
| Windows 11 电脑 | W0 开工前 | 有 arm64 设备时也请准备，用于验证 win32-arm64 |
| 一家真实模型服务商的 API key（可选） | R2 开工前 | M1 退出标准中的"真实服务商完整任务"；调用前会先说明预计费用 |
| 本机安装 Claude Code CLI | T30 开工前 | L3 行为对齐需要运行 `claude`（只连本地 mock，不需要 Anthropic 账号） |

### Windows 任务

- 每个里程碑由 macOS 先达标，Windows 最迟在下一个里程碑结束前达到同样的标准（架构第 15.1 节）。
- W 系列任务在 Windows 11 电脑上执行，流程如下：
  1. 先在 macOS 上推送；
  2. 在 Windows 电脑上 `git pull`，开新会话 `/task W1`；
  3. 完成后在 Windows 上推送，回到 macOS `git pull` 再继续。
- 同一时间只在一台电脑上执行一个任务，避免 `PLAN.md` 冲突。

### 执行顺序

- 按看板从上到下执行。评审任务（R1–R6）是阶段门，不能跳过：它们的结论决定能否进入下一阶段。
- W1、W2、W3 排在各自阶段的第一个，表示阶段门一过就可以做。最晚必须在下一个评审之前完成，你可以按 Windows 电脑的空闲时间推迟。
- M3、M4 中依赖较少的任务可以按优先级调整顺序，但必须保持看板中的依赖关系；调整后在"计划变更记录"中写一行。

## 阶段

| 阶段 | 内容 | 任务 | 阶段门 | 状态 |
|---|---|---|---|---|
| 0 工程基座 | 脚手架、质量门禁、工程规范、协议与契约测试 | T01–T02 | — | 已完成 |
| 1 M0 技术验证 | Electron 安全基线、NAPI 事件通道、mock provider、Agent Host 多会话与 AHP、Operations 委托、凭据保险箱、transcript 渲染、终端、沙箱、打包与首次运行；S1–S10 两个平台的结论 | T03–T12、W0 | R1 | 进行中 |
| 2 M1 可行走骨架 | 存储与信任、会话编排与投影、L2 场景、文件工具与 Bash、客户端外壳、transcript 与 composer、基础审批、模型与凭据、system prompt 与 memory | T13–T22 | R2 | 未开始 |
| 3 M2 Harness 核心 | 权限规则与 Bash 分析、配置兼容层、hooks、计划模式与任务清单、压缩与用量、检查点与回退、WebFetch 与登录、L3 对齐；Windows 达到 M1 | W1、T23–T30 | R3 | 未开始 |
| 4 M3 多会话与生态 | 子 agent、后台任务、终端、worktree 与并行会话、MCP、skills 与命令、WebSearch 与 hooks 扩展；Windows 达到 M2 | W2、T31–T38 | R4 | 未开始 |
| 5 M4 安全与打磨 | 沙箱、插件、配置诊断与用量、NotebookEdit 与通知、无障碍与本地化、性能预算、安全收口；Windows 达到 M3 | W3、T39–T45 | R5 | 未开始 |
| 6 M5 Beta | Auto 模式、自动记忆与托管配置、M5 补全、侧边对话与平台快捷操作、发布流水线；Windows 达到 M4 并与 Beta 同步；两平台端到端验收 | T46–T50、W4、T51 | R6 | 未开始 |

## 任务看板

状态取值：未开始、进行中、部分完成（有 `blocked` 验收项）、已完成、阻塞（等待用户……）。"完成提交"填任务最后一个提交的短哈希。

| 编号 | 任务 | 阶段 | 依赖 | 平台 | effort | 规模 | 验证项 | 状态 | 完成提交 |
|---|---|---|---|---|---|---|---|---|---|
| T01 | [仓库脚手架、工程规范与质量门禁](tasks/T01-scaffold-and-quality-gates.md) | 0 | 无 | macOS | high | 大 | 无 | 已完成 | 47fb1e9 |
| T02 | [协议单一来源与契约测试基座](tasks/T02-protocol-and-contract-tests.md) | 0 | T01 | macOS | high | 中 | 无 | 已完成 | ce41191 |
| T03 | [Electron 应用骨架与安全基线](tasks/T03-electron-shell-and-security-baseline.md) | 1 | T02 | macOS | xhigh | 大 | S10 | 部分完成 | 63eabea |
| T04 | [Core NAPI 绑定与事件通道](tasks/T04-core-napi-and-event-channel.md) | 1 | T03 | macOS | xhigh | 大 | S2 | 已完成 | aa2817f |
| T05 | [严格校验的 mock provider](tasks/T05-strict-mock-provider.md) | 1 | T02 | macOS | high | 中 | 无 | 已完成 | 1487154 |
| T06 | [Agent Host 骨架：Pi SDK 多会话与 AHP](tasks/T06-agent-host-skeleton.md) | 1 | T04、T05 | macOS | xhigh | 大 | S3、S9 | 已完成 | 2214b08 |
| T07 | [Operations 委托与规范名工具](tasks/T07-operations-delegation-and-canonical-tools.md) | 1 | T06 | macOS | xhigh | 大 | S4 | 已完成 | 3a8744f |
| T08 | [凭据保险箱](tasks/T08-credential-vault.md) | 1 | T06；D2 | macOS | high | 中 | S5 | 已完成 | 83dc25b |
| T09 | [Transcript 渲染与 composer 原型](tasks/T09-transcript-and-composer-prototype.md) | 1 | T03 | macOS | xhigh | 大 | S1 | 已完成 | 9c0738d |
| T10 | [终端验证：libghostty-vt + PTY + 帧协议](tasks/T10-terminal-spike.md) | 1 | T04 | macOS | xhigh | 大 | S7 | 部分完成 | ff591d6 |
| T11 | [沙箱验证：Seatbelt、网络代理与 Job Object](tasks/T11-sandbox-spike.md) | 1 | T07 | macOS | high | 中 | S8 | 已完成 | 1b92a25 |
| T12 | [打包、首次运行与发布清单](tasks/T12-packaging-first-run-and-release-manifest.md) | 1 | T03、T04、T06、T08、T11；D2 | macOS | high | 大 | S6 | 部分完成 | 815c32d |
| W0 | [Windows：M0 验证项实机确认](tasks/W0-windows-m0-verification.md) | 1 | T08–T12 | Windows | high | 中 | S1、S2、S5–S8（Windows 部分） | 进行中 | — |
| R1 | [M0 评审与收口](tasks/R1-m0-review.md) | 1 | W0 | macOS | high | 中 | S1–S10 汇总 | 未开始 | — |
| T13 | [存储、数据目录、配置与项目信任](tasks/T13-storage-config-and-trust.md) | 2 | R1（结论为进入 M1） | macOS | high | 大 | 无 | 未开始 | — |
| T14 | [会话编排与事件投影](tasks/T14-session-orchestration-and-projection.md) | 2 | T13 | macOS | xhigh | 大 | 无 | 未开始 | — |
| T15 | [无头驱动、L2 场景运行器与能力清单](tasks/T15-devcli-l2-scenarios-and-capabilities.md) | 2 | T14 | macOS | high | 中 | 无 | 未开始 | — |
| T16 | [文件工具与编辑不变量](tasks/T16-file-tools-invariants.md) | 2 | T15 | macOS | xhigh | 大 | 无 | 未开始 | — |
| T17 | [Bash / PowerShell 执行与进程管理](tasks/T17-bash-powershell-execution.md) | 2 | T16 | macOS | high | 大 | 无 | 未开始 | — |
| T18 | [客户端外壳、会话列表、设置窗口与信任对话框](tasks/T18-client-shell-and-session-list.md) | 2 | T17；D3 | macOS | xhigh | 大 | 无 | 未开始 | — |
| T19 | [Transcript 与 composer 正式版](tasks/T19-transcript-and-composer.md) | 2 | T18 | macOS | xhigh | 大 | 无 | 未开始 | — |
| T20 | [基础权限与审批](tasks/T20-basic-permissions-and-approvals.md) | 2 | T19 | macOS | xhigh | 大 | 无 | 未开始 | — |
| T21 | [模型、服务商与凭据设置](tasks/T21-models-providers-and-credentials.md) | 2 | T20 | macOS | high | 大 | 无 | 未开始 | — |
| T22 | [System prompt 组装与 memory 文件](tasks/T22-system-prompt-and-memory-files.md) | 2 | T21 | macOS | high | 中 | 无 | 未开始 | — |
| R2 | [M1 评审](tasks/R2-m1-review.md) | 2 | T22 | macOS | high | 中 | 无 | 未开始 | — |
| W1 | [Windows：M1 达标](tasks/W1-windows-m1-parity.md) | 3 | R2 | Windows | high | 中 | 无 | 未开始 | — |
| T23 | [权限规则完整版与 Bash 命令分析](tasks/T23-permission-rules-and-bash-analysis.md) | 3 | R2 | macOS | xhigh | 大 | 无 | 未开始 | — |
| T24 | [Claude Code 配置兼容层与配置诊断（基础）](tasks/T24-claude-code-config-compat.md) | 3 | T23 | macOS | high | 中 | 无 | 未开始 | — |
| T25 | [Hooks（M2 事件集与 command 类型）](tasks/T25-hooks-m2.md) | 3 | T24 | macOS | xhigh | 大 | 无 | 未开始 | — |
| T26 | [计划模式、任务清单、AskUserQuestion 与下一步](tasks/T26-plan-mode-todo-ask-next-steps.md) | 3 | T25 | macOS | xhigh | 大 | 无 | 未开始 | — |
| T27 | [上下文工程：system reminder、压缩与用量](tasks/T27-context-reminders-compaction-usage.md) | 3 | T26 | macOS | xhigh | 大 | 无 | 未开始 | — |
| T28 | [检查点、回退与 Changes 面板](tasks/T28-checkpoints-rewind-changes.md) | 3 | T27 | macOS | xhigh | 大 | 无 | 未开始 | — |
| T29 | [WebFetch、登录与模型设置补全、三档视图](tasks/T29-webfetch-login-model-settings-views.md) | 3 | T28 | macOS | high | 中 | 无 | 未开始 | — |
| T30 | [L3 行为对齐基座](tasks/T30-l3-behavior-alignment.md) | 3 | T29 | macOS | high | 中 | 无 | 未开始 | — |
| R3 | [M2 评审](tasks/R3-m2-review.md) | 3 | T30、W1 | macOS | high | 中 | 无 | 未开始 | — |
| W2 | [Windows：M2 达标](tasks/W2-windows-m2-parity.md) | 4 | R3 | Windows | high | 中 | 无 | 未开始 | — |
| T31 | [子 agent 与模型别名](tasks/T31-subagents-and-model-aliases.md) | 4 | R3 | macOS | xhigh | 大 | 无 | 未开始 | — |
| T32 | [后台任务、Monitor 与 KillShell](tasks/T32-background-tasks-and-monitor.md) | 4 | T31 | macOS | high | 中 | 无 | 未开始 | — |
| T33 | [无头终端（Core 侧）](tasks/T33-headless-terminal.md) | 4 | T32 | macOS | xhigh | 大 | 无 | 未开始 | — |
| T34 | [终端渲染器与终端面板](tasks/T34-terminal-renderer-and-panel.md) | 4 | T33 | macOS | xhigh | 大 | 无 | 未开始 | — |
| T35 | [Worktree、并行会话、多窗口、全文搜索与后台常驻](tasks/T35-worktrees-parallel-sessions-and-windows.md) | 4 | T34 | macOS | high | 大 | 无 | 未开始 | — |
| T36 | [MCP 共享连接池](tasks/T36-mcp-connection-pool.md) | 4 | T35 | macOS | xhigh | 大 | 无 | 未开始 | — |
| T37 | [Skills、斜杠命令、命令面板与输出风格](tasks/T37-skills-commands-and-output-styles.md) | 4 | T36 | macOS | high | 大 | 无 | 未开始 | — |
| T38 | [WebSearch 与 hooks 扩展（M3）](tasks/T38-websearch-and-hooks-m3.md) | 4 | T37 | macOS | high | 中 | 无 | 未开始 | — |
| R4 | [M3 评审](tasks/R4-m3-review.md) | 4 | T38、W2 | macOS | high | 中 | 无 | 未开始 | — |
| W3 | [Windows：M3 达标](tasks/W3-windows-m3-parity.md) | 5 | R4（建议在 T43、T44 之后，需要读屏清单与性能测量脚本） | Windows | high | 中 | 无 | 未开始 | — |
| T39 | [macOS 沙箱正式版与 Windows 隔离评估](tasks/T39-sandbox-and-windows-isolation.md) | 5 | R4 | macOS | xhigh | 大 | 无 | 未开始 | — |
| T40 | [插件、Pi 包与 MCP prompts](tasks/T40-plugins-pi-packages-mcp-prompts.md) | 5 | T39（只阻塞在 Windows 设计关口时也可开始） | macOS | high | 大 | 无 | 未开始 | — |
| T41 | [配置诊断完善、M4 hooks 事件与用量成本](tasks/T41-config-diagnostics-hooks-m4-usage.md) | 5 | T40 | macOS | high | 中 | 无 | 未开始 | — |
| T42 | [NotebookEdit、可操作通知与 diff 行内评论](tasks/T42-notebook-notifications-diff-comments.md) | 5 | T41 | macOS | high | 中 | 无 | 未开始 | — |
| T43 | [无障碍与本地化](tasks/T43-accessibility-and-localization.md) | 5 | T42 | macOS | high | 中 | 无 | 未开始 | — |
| T44 | [性能预算进 CI 与长跑测试](tasks/T44-performance-budgets-in-ci.md) | 5 | T43 | macOS | high | 中 | 无 | 未开始 | — |
| T45 | [安全收口：威胁模型逐条测试、隐私与诊断包](tasks/T45-security-hardening-and-privacy.md) | 5 | T44 | macOS | xhigh | 中 | 无 | 未开始 | — |
| R5 | [M4 评审](tasks/R5-m4-review.md) | 5 | T45、W3 | macOS | high | 中 | 无 | 未开始 | — |
| T46 | [Auto 模式（审查模型）](tasks/T46-auto-mode.md) | 6 | R5 | macOS | xhigh | 大 | 无 | 未开始 | — |
| T47 | [自动记忆与企业托管配置](tasks/T47-auto-memory-and-managed-settings.md) | 6 | T46 | macOS | xhigh | 大 | 无 | 未开始 | — |
| T48 | [M5 Harness 补全](tasks/T48-m5-harness-completion.md) | 6 | T47 | macOS | high | 大 | 无 | 未开始 | — |
| T49 | [侧边对话与平台快捷操作](tasks/T49-side-chat-and-platform-shortcuts.md) | 6 | T48 | macOS | high | 中 | 无 | 未开始 | — |
| T50 | [发布流水线与更新](tasks/T50-release-pipeline-and-updates.md) | 6 | T49 | macOS | high | 大 | 无 | 未开始 | — |
| W4 | [Windows：M4 达标与 Beta 同步](tasks/W4-windows-m4-parity-and-beta.md) | 6 | R5、T50 | Windows | high | 中 | 无 | 未开始 | — |
| T51 | [Beta 端到端验收](tasks/T51-beta-acceptance.md) | 6 | W4 | macOS 与 Windows | high | 大 | 无 | 未开始 | — |
| R6 | [Beta 发布评审](tasks/R6-beta-release-review.md) | 6 | T51 | macOS | high | 中 | 无 | 未开始 | — |

## 架构覆盖

架构设计的每个章节都有任务负责落地。修改计划时，先检查这张表，确保没有章节失去负责的任务。

| 架构章节 | 落地任务 |
|---|---|
| 1 目标与原则；14 风险 | 各评审任务（R1–R6）逐项复核 |
| 3 总体架构（分层、进程模型、仓库结构） | T01、T03、T04、T06、T14、T35 |
| 4 关键决策（ADR） | 各任务按 ADR 实现；R1–R6 复核触发条件 |
| 5.1–5.3 Agent Host 结构与事件投影 | T06、T14 |
| 5.4 凭据与登录 | T08、T21、T29 |
| 5.5 Pi 配置隔离 | T06、T13 |
| 5.6 运行时与打包 | T12、T50 |
| 5.7 跟随上游 | T06（锁版本、禁深度 import），R1–R6 复核 |
| 6.1 工具体系与不变量 | T07、T16、T17；各工具见能力矩阵 |
| 6.2 权限系统 | T20、T23、T46 |
| 6.3 Hooks | T25、T38、T41、T48 |
| 6.4 子 agent | T31、T48 |
| 6.5 计划模式、任务清单、下一步、提问 | T26 |
| 6.6 上下文工程 | T22、T24、T27、T47、T48 |
| 6.7 Skills、命令、插件、输出风格 | T37、T40、T48 |
| 6.8 MCP | T36、T40、T48 |
| 6.9 Checkpoint 与 Rewind | T28 |
| 6.10 沙箱 | T11、T39 |
| 6.11 后台任务、终端、Monitor | T10、T17、T32、T33、T34 |
| 6.12 Worktree 与并行会话 | T35 |
| 6.13 多模型适配 | T21、T29、T31 |
| 6.14 Claude Code 配置兼容矩阵 | T22、T23、T24、T25、T31、T36、T37、T40、T47 |
| 6.15 工程不变量 | T14、T16、T27 |
| 7.1–7.3 Crate 划分、运行时、状态归属 | T01、T04、T13、T14 |
| 7.4–7.5 AHP 与 Agent Host 监管 | T02、T06、T14 |
| 7.6 Core API（NAPI-RS） | T04、T14 |
| 7.7 diff 与预处理 | T16、T28 |
| 8.1–8.3 进程与模块、信息架构、数据流 | T03、T18、T19 |
| 8.4–8.5 Transcript 渲染与交互规范 | T09、T19、T20 |
| 8.6 设计语言 | T18 |
| 8.7 无障碍与本地化 | T18（脚手架）、T43 |
| 8.8 平台集成 | T18、T35、T42、T49 |
| 9 数据与存储 | T13、T28、T35 |
| 10.1 威胁模型 | T45（逐条测试），各功能任务实现对策 |
| 10.2 项目信任 | T13、T18 |
| 10.3 进程加固 | T03、T12、T39 |
| 10.4 合规 | 执行协议、T21、T22、T50 |
| 10.5 隐私与遥测 | T45 |
| 11 性能预算 | T04、T09、T10、R1（校准）、T44（进 CI） |
| 12 质量保障与测试 | T01（L0）、T02（L1）、T05 与 T15（L2）、T30（L3）、T03 与 T19（L4） |
| 13 工程结构、构建与发布 | T01、T12、T50 |
| 15 Windows 平台适配 | W0–W4，以及 CI 双平台 |
| 16 路线图与里程碑 | 本看板 |

## 需求覆盖

| 需求 | 落地任务 |
|---|---|
| FR-WS-01、02、03 | T13、T14、T18 |
| FR-WS-04、05、06 | T35 |
| FR-WS-07 | T28 |
| FR-CH-01、02、04、06、07 | T09、T19 |
| FR-CH-03 | T14、T19 |
| FR-CH-05 | T29 |
| FR-CH-08 | T49 |
| FR-MD-01、03 | T21 |
| FR-MD-02、04 | T29 |
| FR-MD-05 | T31 |
| FR-MD-06 | T41 |
| FR-TL-01、02 | T16、T17 |
| FR-TL-03 | T29（WebFetch）、T38（WebSearch） |
| FR-TL-04 | T32 |
| FR-TL-05 | T33、T34 |
| FR-TL-06 | T42 |
| FR-TL-07 | T39 |
| FR-PM-01 | T20（手动、自动接受编辑）、T23（跳过权限）、T26（计划） |
| FR-PM-02、05 | T20 |
| FR-PM-03、04 | T23 |
| FR-PM-06 | T46 |
| FR-HN-01、02、03、06 | T26 |
| FR-HN-04 | T31 |
| FR-HN-05 | T25、T38、T41、T48 |
| FR-HN-07 | T37 |
| FR-CX-01 | T22 |
| FR-CX-02 | T24 |
| FR-CX-03、04 | T27 |
| FR-CX-05 | T47 |
| FR-EX-01、02 | T37 |
| FR-EX-03 | T36 |
| FR-EX-04 | T40 |
| FR-EX-05 | T24（基础）、T41 |
| FR-RV-01、02、03 | T28 |
| FR-RV-04 | T42 |
| FR-SY-01 | T18 |
| FR-SY-02、04 | T35 |
| FR-SY-03 | T42 |
| FR-SY-05 | T18（快捷键自定义）、T37（命令面板） |
| FR-SY-06 | T50 |
| FR-SY-07 | T49 |
| NFR-01 性能 | T44，R1 校准 |
| NFR-02 可靠性 | T06、T14 |
| NFR-03、04 安全与隐私 | T03、T20、T45 |
| NFR-05 合规 | 执行协议、T21、T22、T50 |
| NFR-06、07 无障碍与本地化 | T18、T43 |
| NFR-08、09 平台与可移植性 | T01（CI 双平台）、W0–W4 |
| NFR-10 可维护性 | T02、T06 |
| 核心场景 S1–S9（需求第 3 章） | T51 |

## M0 验证项

| 编号 | 验证内容 | macOS 负责任务 | Windows 负责任务 | 报告 |
|---|---|---|---|---|
| S1 | 渲染进程 transcript 与 composer：流式、滚动、选择、输入法 | T09 | W0 | `docs/spikes/S01-*.md` |
| S2 | NAPI-RS Core 接入主进程：事件吞吐、事件循环延迟、四个目标 | T04 | W0 | `docs/spikes/S02-*.md` |
| S3 | Agent Host 同进程多会话互不串扰 | T06 | CI | `docs/spikes/S03-multi-session.md` |
| S4 | Operations 委托与规范名工具 | T07 | CI | `docs/spikes/S04-*.md` |
| S5 | 凭据保险箱与 Pi 凭据接口适配 | T08 | W0 | `docs/spikes/S05-*.md` |
| S6 | 未签名打包、首次运行、内置 Node 与发布清单 | T12 | W0 | `docs/spikes/S06-*.md` |
| S7 | 终端：libghostty-vt、PTY、帧协议、渲染器 | T10 | W0 | `docs/spikes/S07-*.md` |
| S8 | 沙箱：Seatbelt 与网络代理；Job Object | T11 | W0 | `docs/spikes/S08-*.md` |
| S9 | AHP 握手、背压、崩溃重启与对账 | T06 | CI | `docs/spikes/S09-ahp-resilience.md` |
| S10 | Electron 安全基线 | T03 | CI | `docs/spikes/S10-*.md` |

## 当前任务检查点

进行中的任务在这里维护自己的检查清单，每完成一项就勾选并提交。任务完成时清空本节。

W0（Windows 11 实机，2026-11-16 开工；同时闭环 T03、T04、T10、T11、T12 中的 Windows 验收项）：

- [x] 环境：npm 依赖、Electron、`.tools/`（经本机代理）；机器信息已采集
- [x] 基线修复（9d6b01b、1c6750b、15ce450）：CI 的 verify 两个平台失败（release 夹具 `.dmg` 被 `.gitignore` 排除、`core-io.test.ts` 的 `/w` 在 Windows 被 Pi 解析为 `W:\`），desktop L4 Windows 失败（剪贴板 CRLF）
- [ ] 基线 `npm run verify` 在 Windows 通过（W0-A15）
- [x] CI 结果关闭 T04-A09、T10-A01、T12-A04；本机关闭 T11-A10（T04、T11 改为已完成）
- [ ] T03-A03：本机按 CI 同款步骤跑 L4 与 fuse 校验（W0-A13）
- [ ] S2：开发与打包形态加载、`bench:s2` 完整基准（W0-A04）
- [ ] S5：凭据管理器实机测试、数据目录无明文扫描（W0-A05）
- [ ] S7：终端用例的 Windows 版本（ConPTY、TUI、formatter 一致）、`bench:s7`、随附 conpty 的结论（W0-A09、A10 自动化部分）
- [ ] S8：Job Object 进程树与结束主进程（W0-A12）
- [ ] S1：T09 自动化测试、`bench:s1`（W0-A02）
- [ ] arm64：CI `windows-11-arm` 结果或"未验证"（W0-A11）
- [ ] 实机关口（用户）：SmartScreen、智能应用控制、安装/卸载/更新、Defender、微软拼音（composer 与终端）（W0-A03、A06、A07、A08、A10 IME、T12-A12、T12-A14）
- [ ] 报告 Windows 部分、spikes README、CLAUDE.md、收尾（W0-A01、A14）

## 登记事项

任务执行中发现、但不属于本任务范围的问题，在这里登记：编号（I01 起）、发现于哪个任务、内容、建议由哪个任务处理。处理完成后在"建议处理"一列注明"已落地"与位置。

| 编号 | 发现于 | 内容 | 建议处理 |
|---|---|---|---|
| I01 | 制定计划 | Claude Code 当前默认使用 TaskCreate / TaskUpdate 等任务工具，TodoWrite 已是旧版（`claude-official-capabilities.md`）。PiArc 的规范名仍是 TodoWrite，权限规则与 L3 比对会出现差异 | T26 评估是否增加兼容映射；T30 先把差异写入 L3 allowlist |
| I02 | 制定计划 | FR-MD-05 要求 skills 能引用模型别名，但架构第 6.7 节的 skill frontmatter 没有 `model` 字段 | T37 评估：支持则补架构与实现，不支持则改需求描述 |
| I03 | 制定计划 | Monitor 在会话空闲时唤醒会话（按 Claude Code 官方行为）会自动产生模型费用 | T32 实现时提供开关与限速，R4 请用户确认默认值 |
| I04 | 制定计划 | macOS App Intents 在 ad-hoc 签名下能否工作，M0 没有验证（需要 Xcode 生成的元数据随包分发） | T49 先做可行性原型；不可行时写 ADR 提议。若想提前知道结论，可在 R1 时追加一次快速验证 |
| I05 | 制定计划 | 架构第 6.10 节说 MCP server 在沙箱外，但 stdio MCP server 由 Agent Host 启动，会继承 Agent Host 的 Seatbelt 写入限制（第 10.3 节） | T39 定稿 Agent Host 配置时澄清并更新架构；放宽写入范围属于变更型 |
| I06 | T01 | `npm audit` 报告 8 个 moderate（GHSA-g3hv-75wg-m249，minimatch 经 eslint 10.14 与 typescript-eslint 8.72 引入，仅开发工具链，不进安装包）；架构第 13.3 节要求的 `npm audit`、`cargo-audit` 尚未接入 CI（cargo-deny 的 advisories 已覆盖 RustSec 数据库） | 上游修复后升级 eslint 与 typescript-eslint；T45 或 T50 把 `npm audit --omit=dev` 接入 CI |
| I07 | T01 | TypeScript 7.0 已发布，typescript-eslint 8.72 只支持 `<6.1`，仓库锁在 TypeScript 6.0.3 | 各评审任务按月复查 typescript-eslint 的支持范围，支持后再升级 |
| I08 | T02 | Node 的 `JSON.stringify` 把孤立代理项写成 `\udXXX` 转义，serde_json 拒绝这种帧；TS 的 `encodeFrame` 因此直接抛 `TypeError`。模型 SDK 按 UTF-16 切分的流式文本增量可能在代理对中间断开 | 已落地（T06）：`agent-host/src/runtime/projector.ts` 把增量末尾的高代理项留到下一个增量，无法配对的代理项替换为 U+FFFD，其余发往 Core 的字符串用 `toWellFormed()`；测试 `projector.test.ts` |
| I09 | T02 | 帧解码按 serde_json 的递归上限拒绝嵌套超过 127 层的 JSON（TS 实现同样执行）。工具参数等任意 JSON 若更深会被整帧拒绝 | 已确认（T07）：`fs/*`、`exec/*` 的参数是扁平结构；模型给的工具参数只出现在 `item/*` 通知里，超过 127 层时该帧被 Core 拒绝、工具照常执行，现有工具 schema 都很浅，可以接受（`docs/spikes/S04-operations-delegation.md` 第 10 节）。T14 投影时若要保住这类帧，对深层参数做截断 |
| I10 | T03 | 发布构建仍接受 Chromium 的 `--remote-debugging-port`（没有对应 fuse，运行时探测 `/json/version` 返回 200）：能以该参数启动 PiArc 的本机进程可经 CDP 在页面中执行脚本并调用 `window.piarc`。威胁等级与 ADR-0018 已接受的本机篡改相同，详见 `docs/spikes/S10-electron-security.md` 第 6 节 | T45 评估在发布构建启动时拒绝或移除该开关（先验证可行性），补回归用例 |
| I11 | T03 | 应用仍使用 Electron 默认菜单，发布构建中也有"Toggle Developer Tools"与"Reload" | T18 替换原生菜单时决定发布构建是否保留开发者工具入口 |
| I12 | T04 | 架构第 11 章"主进程内存（含 Core，空闲）≤ 120 MB"低于 Electron 自身基线：macOS arm64 上裸 Electron 45.3.2 开一个空窗口主进程 RSS 约 155 MB，PiArc 含 Core 160–164 MB（Core 与应用代码约 5–8 MB），数据见 `docs/spikes/S02-napi-event-channel.md` 第 4.4 节 | R1 按 M0 实测校准该预算（放宽要在第 18 章写明原因），可改为"相对裸 Electron 的增量"；W0 补 Windows 数据 |
| I13 | T04 | 渲染进程的 `#/event-probe` 测试页随发布构建的渲染包分发（发布版 Core 没有演示事件源与测试钩子，页面只能订阅、计数） | T45 评估是否在发布构建中剔除测试页 |
| I14 | T05 | `packages/testkit` 把 `@earendil-works/pi-ai` 精确锁定为 1.5.2（任务开工时 npm 上的最新稳定版），尚未与 Agent Host 统一 | 已落地（T06）：Pi 锁定 1.5.2，`agent-host` 与 `packages/testkit` 的 `@earendil-works/*` 同为 1.5.2，lockfile 中无第二个版本 |
| I15 | T05 | pi-ai 的 API 实现（`anthropicMessagesApi`、`openAICompletionsApi`）只经公开子路径 `@earendil-works/pi-ai/api/<api>.lazy` 导出，主入口不导出；`packages/testkit` 使用了它们 | 已落地（T06）：`eslint.config.mjs` 的 `piPublicImports` 按各包 `exports` 放行子路径，只禁未导出的路径 |
| I16 | T06 | Pi 1.5.1 起 `cacheWarming` 默认为 `"idle"`：会话空闲时最多 30 分钟内自动发请求保温提示缓存（模型配置了 `promptCache` 才会触发），会产生模型费用；Agent Host 目前沿用 Pi 默认值 | T21 生成 `pi/settings.json` 时显式设定，T27 的用量与成本界面说明这类请求；默认值请用户在 R2 确认 |
| I17 | T06 | `piarc-exec` 的 `TokioProcessSpawner` 只终止直接子进程：Agent Host 被杀时，它启动的子进程（bash 命令、MCP server）不随之结束；架构第 5.6 节要求的进程组（macOS）与 Job Object（`KILL_ON_JOB_CLOSE`，Windows）尚未实现。需要 `killpg` 或 Win32 API，而 `unsafe` 只允许在 sys 与 NAPI crate | 部分落地（T11）：`piarc_exec::ProcessTreeSpawner` 实现了进程组（nix 的 `killpg`）与 Job Object（`piarc-exec` 的 `job` 模块），沙箱命令已用它；T12、T17 的接入见 I33 |
| I18 | T06 | Pi 1.5.2 中断一个回合后，下一次请求丢弃被中断的 assistant 消息，出现两条相邻的 user 消息（Anthropic API 会合并它们，严格 mock 的 `role_order` 拒绝）。PiArc 需要决定中断后的对话形态（例如像 Claude Code 那样补一条中断标记），S3/S9 的中断场景暂时关闭了 `role_order` | T14 定义中断后的 transcript 形态并恢复 `role_order`；T27 对齐压缩与中断标记 |
| I19 | T07 | 工具的 `fs/*`、`exec/*` 请求与会话通知共用 Agent Host 的 stdout：Core 的事件消费者停住、读取停在投递上时，后面的工具请求也读不到，工具随之等待（背压，不丢失）。T06 的慢读者测试因此改为用不存在的工具制造通知 | T14 的事件消费者持续取走事件，不在消费路径上做阻塞等待；R1 评估是否需要让请求帧绕开通知背压（例如单独的通道） |
| I20 | T07 | Pi 1.5.2 的 `createAgentSessionRuntime` 在会话创建时于 Agent Host 本进程 `existsSync(cwd)`（`assertSessionCwdExists`），是 Agent Host 对工作区路径唯一的直接访问（只读元数据，场景期间为 0） | T14 决定接受（写入架构）或由 Core 在 `session/create` 前检查；T39 的 Agent Host Seatbelt 配置允许对工作区的元数据读取 |
| I21 | T07 | 委托工具不读 Pi 设置中的 `shellPath`、`shellCommandPrefix`（Bash）与 `images.autoResize`（Read），取默认值；命令环境是 Core 的白名单环境加 Pi 的会话变量，不含 Agent Host 内部的 `PI_*` 变量 | T17 接上 shell 相关设置（与 Git Bash 探测一起），T21 生成 Pi 设置时决定图片缩放并让 Read 读取 |
| I22 | T08 | D2（应用标识）尚未落实，`piarc-core::identity::APP_IDENTIFIER` 是占位值 `PiArc.pending-D2`，凭据库服务名 `PiArc.pending-D2.credential-vault` 由它生成。改成正式标识后，用占位标识存过凭据的构建找不到主密钥，保险箱返回 `masterKeyMissing` | 已落地（2026-11-15）：D2 定为域名 `piarc.cn`、应用标识 `cn.piarc.desktop`，`APP_IDENTIFIER` 已替换，T08-A12 通过。占位标识只用于未发布的开发构建，无需迁移；T12 用同一常量设置 bundle id 与 AppUserModelID |
| I23 | T08 | Agent Host 的 `secrets/lock` 请求超时（桥接默认 30 s）后 Core 才授予的锁无人释放，要等 30 s 租约到期，期间同一 provider 的写入等待；pi-ai 的取消信号只取消排队，同样可能留下这种锁 | 影响限于同一 provider 的写入延迟；R1 评估是否让 Core 在授予前检查请求方是否仍在等待（例如锁请求带截止时间） |
| I24 | T09 | transcript 原型页 `#/transcript-lab` 与合成夹具（`src/renderer/lab/`）随发布构建的渲染包分发，与 I13 的 `#/event-probe` 同类 | T45 与 I13 一起评估在发布构建中剔除测试页 |
| I25 | T09 | 真实输入法（macOS 简体拼音、日文）与触控板滚动手感需要人工核对，清单见 `docs/spikes/S01-transcript-composer.md` 第 7 节（M1–M10）；自动化部分已用 CDP 合成通过 | 用户核对后把结果告诉智能体补记到 S1 报告；R1 汇总 S1 时检查 |
| I26 | T09 | S1 基准中应用全部进程合计 489 MiB，超出第 11 章"不含 Agent Host 的全部进程 ≤ 450 MB"；渲染进程 179 MiB 在预算内，超出主要来自主进程（179 MiB，含 Core 与测试驱动） | R1 与 I12 一起按 M0 实测校准；W0 补 Windows 数据 |
| I27 | T10 | 终端的 L4（`terminal.e2e.ts`、`terminal-tui.e2e.ts`）与 `crates/piarc-term/tests/pty.rs`、`crates/piarc-core/tests/terminal.rs` 使用 `/bin/sh`、`cat`、`vim`、`top`，在 Windows 上不运行；ConPTY 的 resize、Ctrl+C、kill（portable-pty 0.9.0 的 kill 返回值问题由 `wait` 兜底）与是否随附 `conpty.dll`/OpenConsole.exe 未验证 | W0 补 Windows 程序版本的用例并实测 ConPTY；S7 报告第 10 节 |
| I28 | T10 | PTY 子进程由 portable-pty 启动，不经 `ProcessSpawner`，没有进程组或 Job Object：终端里的程序再起的子进程不随终端关闭而结束 | T33 引入终端承载的任务时决定（与 I17 一起，在 `piarc-exec` 的进程树管理落地后接入） |
| I29 | T10 | `cat` 以约 190 MB/s 输出时主进程 CPU（含 Core 全部线程）约为一个核的 74%，主要是 IO 线程读 PTY 与解析；第 11 章没有对应预算 | T44 把终端吞吐纳入性能回归时评估（例如增大读块、合并读） |
| I30 | T10 | `#/terminal-lab` 原型页随发布构建的渲染包分发；发布构建的 `window.piarc` 也有七个终端函数（`createTerminal` 只能启动登录 shell），与 I13、I24 同类 | T34 接入正式终端面板时收口；T45 与 I13、I24 一起评估剔除原型页 |
| I31 | T10 | 真实拼音输入法的候选框位置未核对，清单见 `docs/spikes/S07-terminal.md` 第 8 节（T1–T4） | 用户核对后把结果告诉智能体补记到 S7 报告；R1 汇总 S7 时检查（同 I25） |
| I32 | T10 | T09 的 L4 `transcript-scroll.e2e.ts` 中 "the wheel releases and resumes following" 在一次全量运行中失败（dev 形态，内容增长时离底 31 px，期望 ≤ 1 px），单独重跑 10 次（两种形态各 5 次）都通过；本机此时的主屏是 120 Hz | T19 接手 transcript 时检查贴底在高刷新率下的时序；T44 把 L4 的偶发失败纳入统计 |
| I33 | T11 | 进程树终止的接口已就绪：`piarc_exec::ProcessTreeSpawner`（`ProcessSpawner` 的实现；macOS 新进程组 + `killpg`，Windows 挂起创建后加入 `KILL_ON_JOB_CLOSE`、不许 breakaway 的 Job 再恢复；`kill` 与丢弃句柄都结束整棵树，丢弃也会结束命令留在后台的进程）。目前只有沙箱会话的 `exec/run` 用它 | 部分落地（T12）：`piarc_core::agent_host::start` 与 `start_bundled` 改用 `ProcessTreeSpawner`（W0 实机核对 Agent Host 被杀时子进程随之结束）；T17 让 `ToolIo` 的普通命令也用它，并决定后台进程在命令结束时是否保留（与 T32 的后台任务一起） |
| I34 | T11 | 沙箱把 `CARGO_HOME` 指向会话临时目录（防止缓存投毒，S8 报告第 4 节），沙箱内读不到 `~/.cargo/config.toml` 的镜像源设置；每个会话第一次安装或构建是冷缓存 | T39 决定是否把用户的 Cargo 配置（不含凭据）复制进会话，以及是否提供共享只读缓存 |
| I35 | T11 | 沙箱内不能绑定端口、不能连 Unix socket（本地测试服务器、Docker、ssh-agent 不可用），`git init`/`clone`/`config` 因 `.git/config`、`.git/hooks` 受保护而失败；`GIT_CONFIG_COUNT` 被沙箱用来指定代理，命令继承的同类变量失效 | T39 评估"允许本机绑定""允许写 `.git/config`"两个选项与 Unix socket 白名单，设置页写明这些限制 |
| I36 | T11 | macOS 的进程组终止不覆盖主动 `setsid`/`setpgid` 的后代：它们仍在沙箱里，但停止命令后会活下来（Windows 的 Job 无此问题） | T17 实现通用进程管理时评估是否需要按后代追踪（例如记录会话内的进程并在停止时扫描） |
| I37 | T11 | `piarc-exec` 的 Windows 代码（`job.rs` 与 `tree.rs` 的 Windows 部分）只在本机做了类型检查与 lint（用户同意后安装了 `x86_64-pc-windows-msvc` 目标，`cargo clippy --target x86_64-pc-windows-msvc --workspace --all-targets -- -D warnings` 通过），没有运行；同一检查发现 T07 的 `crates/piarc-core/tests/tool_io.rs` 在 Windows 上有两处 `unused_mut`（会让 Windows CI 的 clippy 步骤失败），T11 已修 | 用户推送后由下一个任务的开工检查核对 Windows CI 并关闭 T11-A10；失败时修复后再关闭 |
| I38 | T12 | `piarc-term` 的 PTY 用例 `vim_on_the_alternate_screen_matches_the_formatter` 依赖 UTF-8 locale：`LANG` 为空的 shell（本次智能体会话的环境）里 vim 把中文显示成转义，`cargo test`（含 verify）失败；设 `LANG=en_US.UTF-8` 后通过 | T33 或 R1：测试的 `SessionConfig` 显式设 `LANG`/`LC_CTYPE`，不依赖调用方环境；在此之前根 `CLAUDE.md` 的易错点已写明 |
| I39 | T12 | 内置 node 保留 Node.js 官方签名（ADR-0018），其 entitlements 含 `get-task-allow` 与 `allow-dyld-environment-variables`：同一用户的进程可以调试附加 Agent Host，读到 Core 交给它的凭据（PiArc 自身已用 hardened runtime 挡住注入，S6 报告第 3 节）。Core 以最小环境启动 node，不传 `DYLD_*` | T45 评估（例如凭据只在用时经 AHP 取、缩短驻留时间，或重新评估是否对 node 重签去掉 `get-task-allow`，后者涉及 ADR-0018，属变更型） |
| I40 | T12 | 在 Agent Host 的宽松 Seatbelt 下，`npx <本地目录>` 形式的 MCP server 启动失败：npm 链接目录后 `chmod` 其 bin，文件在可写目录之外（`EPERM`）。registry 包（tarball）不受影响 | T36 接入 MCP 配置时给出明确错误提示或改用 `npm pack` 后的路径；T39 定稿 Agent Host 配置时一并评估 |
| I41 | T12 | macOS arm64 安装后体积 449.0 MB，预算 450 MB 只余约 1 MB（内置 node 145 MiB、Electron Framework 250 MiB）；任何新增随包内容都会超出 | R1 决定：校准预算（写明原因）或裁剪（npm 的 docs/man 约 3.2 MiB、压缩 bundle 等），T44 把体积纳入回归 |
| I42 | T12 | S6 中 Gatekeeper 开启时的首次打开没有验证："仍要打开"是否出现、`xattr -dr com.apple.quarantine` 备选、Gatekeeper 是否单独拦截内置 node（以及带隔离属性的 rg、fd）。用户的 Mac（macOS 26.5.2）`spctl --status` 为 `assessments disabled`，从 `127.0.0.1` 经 Safari 下载的 DMG 也没有 `com.apple.quarantine`；没有 macOS 15 设备。检查清单与 `scripts/dev/s6-probe.mjs` 可直接复用 | R1 汇总 M0 时安排：在开着 Gatekeeper 的 Mac（26 与 15）上、用从 GitHub 等外部地址下载的 DMG 重做检查清单第 2、3 项；最晚 T50 首次发布前完成，结果补进 S6 报告 |
| I43 | T12 | ad-hoc 签名的 PiArc 的系统通知可用（允许后横幅显示，实机确认），但用户未允许通知时 Electron 仍发 `show`、不发 `failed`，程序侧事件不能用来决定是否退回应用内提醒；另外应用退出时 Electron 删除已投递的通知，通知中心里的条目随之消失 | T18/T35 做系统通知时：通知之外总给应用内提醒与 Dock 角标，或经原生模块读取 `UNUserNotificationCenter` 的授权设置；T35 的后台运行设计考虑通知随应用退出被删除 |

## 技术债

评审任务（R1–R6）汇总的技术债，按影响排序。

（暂无）

## 会话日志

每个任务收尾时在末尾追加一条，格式：

```text
### 2026-11-20 T01 已完成（提交 abc1234）
- 交付：……
- 验收：12 项通过，0 项阻塞
- 决策：ADR-00xx ……
- 遗留：……
```

### 2026-11-14 T01 已完成（提交 47fb1e9）
- 交付：npm workspaces（apps/desktop、agent-host、packages/protocol）与 TS 工具链（TypeScript 6.0.3、ESLint 10 类型感知、Prettier、Vitest 5）；Cargo workspace 21 个 crate 骨架、workspace lints、rustfmt/clippy/deny 配置、toolchain 1.99.1；`npm run verify`（10 步）、`check-crate-deps.mjs` + `crates/deps-rules.json`、`check-acceptance.mjs`、`install-tools.mjs`（cargo-deny 0.20.2 装进 `.tools/`）；`.editorconfig`、`.gitattributes`、CI（macOS + Windows）；三份工程规范、两份 `.claude/rules`、根 `CLAUDE.md`
- 验收：12 项通过，0 项阻塞（Windows CI 待首次推送后观察）
- 决策：未写 ADR；架构 7.1 补充链外 crate 的层位置（v2.3）；cargo-deny 仓库内安装而非全局安装；TypeScript 锁 6.0.x；`.nvmrc` 按"满两周"取 24.22.2
- 遗留：I06（npm audit 与开发依赖公告）、I07（TypeScript 7）

### 2026-11-14 T02 已完成（提交 ce41191）
- 交付：`piarc-protocol` 骨架类型（JSON-RPC 消息、结构化错误与错误码段、`host/hello`/`core/welcome` 与 `negotiate`、会话事件头、turn/item 最小通知）、契约注册表 `CONTRACTS`、`export-schema`；LF 帧编解码器 Rust 与 TS 各一份；`npm run gen:protocol`（json-schema-to-typescript 16.0.0）、`check-protocol-drift.mjs`、`check-contract-samples.mjs` 接入 verify（共 12 步）；`tests/contracts/` 12 个契约的 22 个样本与 41 个反例、27 个解码与 3 个编码共享用例；ajv 8.20.0 契约测试；两份子目录 CLAUDE.md、testing.md 第 7 节
- 验收：11 项通过，0 项阻塞（A10 的 Windows runner 实际运行待推送后观察）
- 决策：未写 ADR；架构 v2.4（帧编解码器放在 `piarc-protocol`，7.4 增加消息约定）；TS 解码器对齐 serde_json 的嵌套与孤立代理项规则
- 遗留：I08（流式文本的孤立代理项，T06）、I09（嵌套上限，T07）

### 2026-11-14 T03 部分完成（提交 63eabea）
- 交付：`apps/desktop` 三部分工程（Electron 45.3.2、Forge 8.0.1、Vite 8.3.8、React 19.3.1，精确锁定；main/preload/renderer/shared 四个 TS 工程）；`app://piarc` 自定义协议 + CSP 响应头、固定 webPreferences 的窗口工厂、全局导航/重定向/新窗口/webview 守卫、权限默认拒绝、IPC 统一注册与来源校验、外链确认、单实例锁；ESLint 进程边界规则；`apps/desktop/fuses.mjs`（发布/开发两套）、`scripts/ci/check-fuses.mjs`（`npm run check:fuses`）、`scripts/dev/package-desktop.mjs`；L4 基座（Playwright 开发形态与打包形态，29 个用例 × 2）；CI `desktop` 作业；S10 报告、testing.md 第 9 节、`apps/desktop/CLAUDE.md`
- 验收：13 项通过，1 项阻塞（A03：Windows CI 实际结果待推送后核对）
- 决策：未写 ADR；架构 v2.5（3.4 增加 `src/shared/`，10.3 写明协议名、权限检查处理器、开发/发布构建 fuse 差异与 L4 打包形态）；L4 打包形态用开发构建（Playwright 需要 `--inspect`）；开发服务器放宽经 `import.meta.env.DEV` 在打包时删除；主进程 origin 比较经 `originOf`（Node 的 URL 不认识 Chromium 标准协议）
- 遗留：I10（发布构建接受 `--remote-debugging-port`，T45）、I11（默认菜单，T18）；本机 `gh` 未登录，未查前序 CI

### 2026-11-15 T04 阻塞（等待用户确认 ADR-0019）
- 交付：`piarc-core` 运行时（tokio 多线程、事件合并器与背压、有序关闭、任务监督、演示事件源）；`piarc-napi`（`CoreRuntime.create/shutdown/state`、`ThreadsafeFunction` 事件回调、panic 边界与结构化错误、`testing` feature）；协议新增 `shuttingDown`、`busy`；`npm run build:core`（`@napi-rs/cli` 3.10.12）与 `.d.ts` L1 快照（verify 第 4 步，verify 共 13 步）；主进程 `.node` 路径解析、`EventRouter` 与每页面一个 `MessageChannelMain`、退出前关闭 Core；preload `subscribeEvents`/`unsubscribeEvents`；`#/event-probe` 测试页与主进程测试钩子；Forge 拷入 Core + `plugin-auto-unpack-natives`；Vitest 集成测试、L4 `core-events` 6 个用例 × 2；CI `core-build`/`core-load` 四目标；`npm run bench:s2`、`scripts/ci/load-core.mjs`；S2 报告、ADR-0019（提议）、三份 CLAUDE.md、架构 v2.6
- 验收：11 项通过，2 项阻塞（A06：Electron 45 不能转移 `ArrayBuffer`，待 ADR-0019；A09：Windows 两个目标待 CI/W0）
- 决策：ADR-0019（提议，变更型）；架构 v2.6 补充 7.2、7.6、13.2；Promise 用 `JsDeferred` 不用 `#[napi] async fn`；演示事件源等测试导出只在开发构建；verify 的短时正确性版本在 Node 宿主中跑（CI verify 作业没有 Electron）；基准的事件循环延迟按 1 ms 采样、报告原始值
- 遗留：I12（主进程内存预算校准，R1）、I13（发布构建剔除测试页，T45）；T03-A03 与本任务 A09 的 Windows 结果都需推送后核对

### 2026-11-15 T04 部分完成（提交 aa2817f）
- 交付：用户授权由智能体决定 ADR-0019，决定采纳：ADR-0019 改"已接受"，ADR-0014 注明第 4 条被修订，架构 v2.7（8.3 第 5 条、7.6、R6、第 4 章）；T04-A06 按 ADR 改写并以现有 L4、Vitest 与基准证据通过；S2 报告 macOS 结论改为通过
- 验收：12 项通过，1 项阻塞（A09：Windows 两个目标的 `core-build`/`core-load` 结果待推送后核对，实机部分由 W0 做）
- 决策：ADR-0019 已接受（批次一律复制转发）；A06 描述按用户授权改写，见计划变更记录 v1.2
- 遗留：I12、I13；T03-A03 与 T04-A09 待 Windows CI

### 2026-11-15 T05 已完成（提交 1487154）
- 交付：`piarc-testkit` 严格 mock provider——两种流式线格式编码（Anthropic Messages SSE、OpenAI Chat Completions 分块）、serde 场景脚本（JSON/YAML，未知字段报错，多步、参数分段与 `split_at`、429/529/500/503 与断流注入）、线格式中立的请求模型与六条校验规则（400 带官方错误形状 + 规则 ID 与位置）、请求记录（库 API 与 `GET /_piarc/requests`）、库形态 `MockProvider` 与 bin `piarc-mock-provider`；新 npm 工作区 `packages/testkit`（pi-ai 1.5.2 精确锁定）两种线格式的工具调用往返；testing.md 第 10 节、架构 v2.8（12.2 补充）、两份 CLAUDE.md、复用表三行
- 验收：12 项通过，0 项阻塞
- 决策：未写 ADR；HTTP 用 hyper 1.12 + hyper-util + http-body-util（自定义响应体以控制断流），YAML 用 serde-saphyr 2.1.1，元 schema 校验用 jsonschema 0.61.2；`deny.toml` 为 MIT-0 的 `borrow-or-share` 加单 crate 许可证例外；场景选择器支持 `<id>#<实例>` 独立计数
- 遗留：I14（T06 统一 pi-ai 版本）、I15（T06 的深度导入规则放行 `exports` 子路径）；本机 `gh` 已登录但分支未推送，T03-A03、T04-A09 的 Windows CI 仍待推送后核对

### 2026-11-15 T06 已完成（提交 2214b08）
- 交付：Pi 锁定 1.5.2（`agent-host` 与 `packages/testkit` 统一，基线文档追加"版本差异"，`reference/pi` 检出 v1.5.2）；ESLint 按 `exports` 禁止深度导入；协议新增 `host/ping`、`host/shutdown`、`session/create|resume|prompt|abort|close`、`trust/get`、`dynamicToolCall` 条目、`turn/completed.errorMessage`、5 个错误类别，响应契约名 `<方法>/result`，`session/resume` 带 `lastSeq`；`agent-host`（stdio 接管、握手、会话注册表、最小投影、出站队列、Core 桥接、esbuild 单文件 bundle `npm run build:agent-host`）；`piarc-ports` 的 `ProcessSpawner`/`Clock`、`piarc-exec` 的 tokio 启动器、`piarc-host` 监管器（握手、有界写队列与 `busy`、按许可的读背压、心跳、退避重启、会话恢复、调用对账、stderr→tracing）、`piarc-core::agent_host`；mock 新增 `stall_after_events`；stdio MCP 夹具；S3/S9 测试与两份报告；两份新 CLAUDE.md、架构 v2.9
- 验收：12 项通过，0 项阻塞（S3、S9 的 Windows 结果由 CI 的 `verify` 作业给出，待推送后核对）
- 决策：未写 ADR；架构 v2.9 补充；写入背压选"写队列满立即返回可重试 `busy`"；生命周期事件不占读背压许可；`seq` 写出时分配、跨重启以 `lastSeq` 续编；信任经 `trust/get`；`PI_CODING_AGENT_DIR` 固定到 PiArc 目录；凭据只在内存
- 遗留：I16（`cacheWarming` 默认值）、I17（进程树清理，T17）、I18（中断后相邻 user 消息，T14）；本机 node 24.14.1 与 `.nvmrc` 24.22.2 不一致；分支未推送，T03-A03、T04-A09 的 Windows CI 仍待核对

### 2026-11-15 T07 已完成（提交 3a8744f）
- 交付：协议新增 `fs/stat|read|write|mkdir|list|glob|grep`、`exec/run|kill` 与 Core → Agent Host 通知 `exec/output`，错误类别 `notFound`、`outsideWorkspace`、`ioError`，20 个契约的样本与反例；`piarc-fs`（`Scope` 路径限定、按范围读、blob、写、mkdir、stat 与图片嗅探、list、fd 规则的 glob、ripgrep 库的 grep）；`piarc-exec` 的 `CommandRunner`（bash、流式、取消）；`piarc-host` 的 `Peer`（入站处理者回传通知）；`piarc-core::tool_io::ToolIo`；Agent Host 工具层 `agent-host/src/tools/`（六个规范名工具、默认 Profile、`ToolNameMap`、替身路径、`CoreIo`），ESLint 禁止 tools/harness 导入 `fs`、`child_process`；端到端测试（全工具场景、Profile 改名、I/O spy、与 Pi 原生工具的行为对照、S3 改用委托工具）、AHP 往返计时；`install-tools.mjs` 加 ripgrep 15.2.0、fd 10.5.0；S4 报告、ADR-0020、架构 v2.10、testing.md 11.1、复用表、八份 CLAUDE.md
- 验收：13 项通过，0 项阻塞（Windows 由 CI 的 `verify` 运行同一组测试，分支未推送，待核对；未取得时由 W0 核对）
- 决策：ADR-0020（补充，已接受）：read/write/edit 在替身路径上运行 Pi 的工具代码，bash/find 用 Operations，grep 自写，写入用 Harness Kit 的队列串行；文本以 ≤ 1 MiB 范围内联、图片以 blob 引用；Bash 用 bash（与 Pi 原生一致），命令环境为 Core 白名单加 Pi 会话变量；超时与中断经 `exec/kill`
- 遗留：I19（工具 I/O 排在受背压的通知之后）、I20（Pi 会话创建时的 cwd 检查）、I21（委托工具未读的 Pi 设置）；T03-A03、T04-A09 的 Windows CI 仍待推送后核对

### 2026-11-15 T08 部分完成（提交 80f3133）
- 交付：`piarc-ports::SecretStore`；`piarc-secrets`（保险箱格式 v1：AES-256-GCM、头部作附加数据、每次写入新 nonce、原子替换；主密钥状态表；`SystemSecretStore` 经 keyring-core 用 macOS 登录钥匙串与 Windows 凭据管理器；`MemorySecretStore` 替身）；协议 `secrets/getAll|get|set|delete|lock|unlock` 与通知 `secrets/changed`、五个错误类别、13 个契约的样本与反例；`piarc-core::secrets::SecretsService`（懒打开与重试、变更推送、键锁与租约）与 `identity`（应用标识占位）；`piarc-host::Peer` 的 `is_closed`、`same_connection`；Agent Host `CoreCredentialStore`（pi-ai `CredentialStore`）与测试专用 `--test-oauth-provider`；端到端凭据测试、本地 token 端点、`piarc_testkit::plaintext` 扫描；S5 报告、ADR-0021、架构 v2.11、复用表、六份 CLAUDE.md（新增 `piarc-secrets`）
- 验收：13 项通过，1 项阻塞（A12：D2 未落实，服务名由集中定义的占位应用标识生成）
- 决策：ADR-0021（补充，已接受）：Pi 1.5.2 的凭据注入点是异步 `CredentialStore`（R11 不出现）；Core 是唯一写入方，变更推送给所有 Agent Host，读改写在 Core 的键锁内（两个 Agent Host 只刷新一次）；`modify` 先改内存、等 Core 存好再完成，失败时请求失败（会话报错）；macOS 用登录钥匙串而非 data protection keychain
- 遗留：I22（D2 占位应用标识与迁移）、I23（超时后授予的锁要等租约）；待 W0：凭据管理器实机、Windows 数据目录与进程环境扫描；待 T12：两次构建之间的钥匙串弹窗次数；T03-A03、T04-A09 的 Windows CI 仍待推送后核对

### 2026-11-15 T08 已完成（提交 83dc25b）
- 交付：用户决定 D2（域名 `piarc.cn`，应用标识 `cn.piarc.desktop`），写入需求规格第 7 节；`piarc-core::identity::APP_IDENTIFIER` 由占位值改为正式标识，凭据库服务名为 `cn.piarc.desktop.credential-vault`；ADR-0021、架构、S5 报告与 CLAUDE.md 同步
- 验收：14 项通过，0 项阻塞（A12 由阻塞改为通过，verify 13 步全部通过）
- 遗留：I23；待 W0、T12 的项见上一条记录

### 2026-11-15 T09 已完成（提交 9c0738d）
- 交付：渲染进程 transcript 原型（`#/transcript-lab`，协议事件驱动的最小 store、流式驱动与节奏、@tanstack/react-virtual 列表、滚动跟随状态机与"回到底部"、复制本条消息）；Markdown Worker（marked 词法器的增量解析、自动闭合、块与 span 中间结构、字符引用解码与 `safeHref`）；高亮 Worker（shiki core + JavaScript 正则引擎，token 级输出，语法按需加载）；ProseMirror composer（@ 胶囊、空闲/运行中键位、输入法守卫在 `handleDOMEvents.keydown`）；夹具（token/s 回放、1 万条历史、XSS 载荷集 `src/shared/xss-payloads.ts`）；ESLint 禁止渲染进程的 HTML 字符串入口；权限放行 `clipboard-sanitized-write`；`npm run bench:s1`（CDP 追踪）；L4 五个文件 27 个用例；S1 报告、ADR-0022、架构 v2.12、S10 报告、testing.md 9.5、复用表六行、两份 CLAUDE.md
- 验收：13 项通过，0 项阻塞
- 决策：ADR-0022（补充，已接受）：@tanstack/react-virtual（virtuoso 同组测量下流式掉帧、冷加载慢一倍、增长时贴底晚一帧）、marked 词法器（比 mdast 快 17–50 倍）、shiki JavaScript 引擎（不放宽 CSP）；帧时间按每帧主线程工作量计（60 Hz 屏上 rAF 间隔不能对照 16 ms）；滚动阈值取 2/40/200 px 与 150 ms 输入窗口；transcript 滚动条改为自绘（覆盖式滚动条不可拖动）
- 遗留：I24（原型页随发布包分发，T45）、I25（真实输入法与触控板待用户核对，S1 报告第 7 节）、I26（全部进程内存 489 MiB，R1）；T03-A03、T04-A09 的 Windows CI 仍待推送后核对（分支未推送）

### 2026-11-15 T10 阻塞（等待用户确认 ADR-0023）
- 交付：`piarc-ghostty-sys`（锁定文件、`build.rs` 下载与 SHA-256 + minisign 校验、离线缓存、bindgen 绑定入库与 `gen-ghostty-bindings.mjs`、macOS 静态链接、Windows 官方 DLL 随 `.node`）；`piarc-term`（`vt` safe 封装：Terminal + 四个 effects、RenderState、KeyEncoder、formatter；PTY 会话的 IO 与写线程、同步输出 hold、按 viewer 的增量帧编码与行 id 复用、W3C 键位表）；`piarc_protocol::term_frame` 帧格式草案、编解码与 `Screen`；Core 终端注册表与 `term/<id>` 事件；NAPI 终端导出；主进程终端 IPC（归属校验）与 preload API；渲染原型 `#/terminal-lab`（fork 的 ghostty-web `CanvasRenderer`、TS 解码器、rAF 拉取、隐藏不拉取、键盘与输入法）；`third-party/sources.json`；`npm run bench:s7`；S7 报告、ADR-0023（提议）、架构 v2.13、testing.md 9.6、复用表八行、`crates/piarc-term/CLAUDE.md` 与五份 CLAUDE.md 更新
- 验收：11 项通过，3 项阻塞（A01：Windows CI 待推送、win32-arm64 实机待 W0；A10：回显经 MessagePort p95 16.2 ms，待 ADR-0023；A11：真实拼音候选框待 R1）
- 决策：ADR-0023（提议，变更型）：终端帧作为拉取请求的返回值送达，实测 p95 0.77 ms；未写 ADR 的取舍：portable-pty 用发布版 0.9.0（kill 返回值以 `wait` 兜底）、Windows 选 DLL 而非 lld + 静态库、绑定按 C23 生成、`unsafe` 放开到 `piarc-term` 的 `vt` 模块（编码规范 2.8）、htop 未安装以 top 代替、wterm 只评估不采用
- 遗留：I27（终端测试只在 Unix）、I28（PTY 子进程不经 `ProcessSpawner`）、I29（高吞吐时主进程 CPU）、I30（原型页与终端 IPC 随发布构建）、I31（真实拼音核对）；T03-A03、T04-A09、T10-A01 的 Windows CI 仍待推送后核对

### 2026-11-15 T10 部分完成（提交 ff591d6）
- 交付：用户采纳 ADR-0023：ADR-0023 改"已接受"，ADR-0017 注明第 3 条被修订，架构 v2.14（第 4 章、6.11、7.6，8.3 新增第 6 条）；终端帧改为 `requestTerminalFrame` 的返回值（主进程处理函数返回 Core 的帧，preload 校验后返回，去掉 `onTerminalFrame` 与路由器的 `postToWindow`），单元、L4 键快照、S10 报告与 CLAUDE.md 同步；重打包后 L4 两种形态 136 项通过，`npm run bench:s7` 重测，S7 报告与 spikes README 更新为通过
- 验收：12 项通过，2 项阻塞（A01：Windows CI 待推送、win32-arm64 实机待 W0；A11：真实拼音候选框待 R1）
- 决策：ADR-0023 已接受（终端帧作为拉取请求的返回值，回显额外延迟 p95 0.79 ms）；8.3 的新规则追加为第 6 条，不顺延第 5 条（ADR-0014、ADR-0019 引用它）
- 遗留：I27–I31 见上一条记录；新增 I32（T09 滚动用例偶发失败）；T03-A03、T04-A09、T10-A01 的 Windows CI 仍待推送后核对

### 2026-11-15 T11 部分完成（提交 1b92a25）
- 交付：`piarc-exec` 的 `ProcessTreeSpawner`（macOS 进程组 + nix `killpg`；Windows 挂起创建、加入 `KILL_ON_JOB_CLOSE` 且无 breakaway 的 Job 后恢复，`job` 模块是唯一的 `unsafe`）与 `CommandSpec::launcher`；`piarc-sandbox`：`SandboxPolicy`/`ResolvedPolicy`（真实路径）、`PROTECTED_PATHS`（23 项）、每命令一份 Seatbelt 配置（路径经 `-D` 传入、基础配置拷自 Codex，Apache-2.0）与快照、`sandbox_env`（代理变量、工具自身的代理覆盖、缓存指向会话临时目录）、`NetworkProxy`（HTTP 与 `CONNECT`、精确与 `*.` 白名单、拒绝回环与云元数据、可注入 `Network`）、`SessionSandbox`、`s8-bench`；Core `ToolIo::open_sandboxed_session`；测试 `piarc-sandbox/tests/proxy.rs`、`piarc-core/tests/sandbox.rs`、`sandbox_commands.rs`；S8 报告、spikes README、架构 v2.15（6.10 受保护路径与原型，7.1 `unsafe` 范围）、编码规范 2.8 与复用表五行、`piarc-sandbox/CLAUDE.md` 与三份 CLAUDE.md 更新、`third-party/sources.json` 登记 Codex 基础配置
- 验收：12 项通过，1 项阻塞（A10：Job Object 三级进程树单测待 Windows CI，本机已对 Windows 目标做类型检查与 lint；实机待 W0）
- 决策：沙箱受保护路径清单比 6.1.2 窄（`.git/` 整体可写，只保护 hooks 与 config 等，代价是沙箱内 `git init`/`clone`/`config` 失败）；缓存经环境变量指向会话临时目录而不放开用户缓存（防缓存投毒，代价是冷缓存与读不到 `~/.cargo/config.toml`）；Cargo、git、npm 的配置文件优先于代理变量，沙箱另设 `CARGO_HTTP_PROXY`、`npm_config_*proxy`、`PIP_PROXY`、`GIT_CONFIG_*`；`unsafe` 放开到 `piarc-exec` 的 `job` 模块（与 T10 的 `vt` 同类，补充型，未写 ADR）；进程树丢弃句柄时也结束命令留下的后台进程；经用户同意安装 `x86_64-pc-windows-msvc` 目标，顺带修了 T07 测试中两处 Windows 才有的 `unused_mut`
- 遗留：I33（T12、T17 改用 `ProcessTreeSpawner`）、I34（Cargo 配置与冷缓存，T39）、I35（不能绑定端口与连 Unix socket、git init 失败，T39）、I36（`setsid` 脱离进程组，T17）、I37（T11-A10 待 Windows CI）；T03-A03、T04-A09、T10-A01 的 Windows CI 仍待推送后核对

### 2026-11-16 T12 阻塞（等待用户实机操作）
- 交付：`third-party/binaries.lock.json` + `scripts/dev/fetch-binaries.mjs`（node 24.22.3、rg 15.2.0、fd 10.5.0、vpk 1.2.161 的版本与 SHA-256）；`apps/desktop/packaging/`（`Resources/agent-host/` 布局、分层 ad-hoc 签名与 hardened runtime、hdiutil DMG maker、Velopack 绑定）、maker-zip、图标与 bundle id 取自 `design/brand/` 与应用标识；`package:desktop` 加 `--arch`、`--make`；`scripts/ci/check-app-layout.mjs`；`piarc-sandbox` 的 Agent Host 宽松配置与 `agent_host_launch`；`piarc-core::agent_host::{BundledRuntime, start_bundled, LauncherSpawner}`、Agent Host 改用 `ProcessTreeSpawner`（I33）、Core 运行时开启 I/O；测试入口 `host_probe`/`agentHostProbe`、`keychain_probe`/`keychainProbe`、主进程 `showNotification`；L4 `agent-host.e2e.ts`、`notification.e2e.ts`；npx 拉起的 MCP 探针夹具；`scripts/release/release-manifest.mjs`（minisign 格式、测试密钥）与 `piarc_core::release`（错误类别 `releaseIntegrity`）；Windows：主进程 Velopack 钩子与 AppUserModelID、`scripts/release/pack-windows.mjs`；CI `package-macos`、`package-windows`；检查清单与 `scripts/dev/s6-probe.mjs`；S6 报告、ADR-0024、架构 v2.16、四份 CLAUDE.md、复用表
- 验收：8 项通过，7 项阻塞（A04：CI 产物待推送；A09、A11：实机关口；A10：横幅待目视，程序侧通过；A12、A14：Windows 部分待 CI；A13：首次运行结论待补）
- 决策：ADR-0024（补充，已接受）：发布清单格式与 Core 校验；hardened runtime 启用（需 `disable-library-validation`，实测阻止 DYLD 注入）；DMG 用自写 hdiutil maker；Agent Host 用 `sandbox-exec -p`（同沙箱命令）；Agent Host 的 tmp 与 npm 缓存放数据目录下 `agent-host/`；Velopack pack id 用应用标识（`PiArc` 会与数据目录重合）；CI 的 Windows 安装包用开发构建（W0 需要测试入口）
- 遗留：I38（PTY 用例依赖 UTF-8 locale）、I39（内置 node 的 `get-task-allow`）、I40（`npx <本地目录>` 在 Seatbelt 下失败）、I41（安装后体积余量约 1 MB）；本机 Gatekeeper 评估被关闭，首次打开须在开启 Gatekeeper 的机器上做；分支未推送，T03-A03、T04-A09、T10-A01、T11-A10 与本任务 A04 的 CI 仍待核对

### 2026-11-16 T12 部分完成（提交 32ed668）
- 交付：用户实机（macOS 26.5.2）按检查清单操作，智能体用 computer use 查看系统设置并驱动钥匙串探针；实测发现钥匙串探针的键名不合保险箱规则，先写失败测试再修复（89c560f），重打构建 A、B；检查清单第 7 节、S6 报告第 5、10、11 节、spikes README、架构 8.8 记录结果
- 验收：11 项通过，4 项阻塞（A04：CI 产物待推送；A10：允许通知后的横幅目视待补；A12、A14：Windows 部分待 CI/W0）
- 决策：A09 按"各项有结论，未验证项写明原因"关闭；Gatekeeper 开启时的首次打开未验证，作为 I42 交 R1 安排
- 遗留：I42（Gatekeeper 开启时的首次打开、macOS 15）、I43（通知的 `show` 不反映是否允许）；I38–I41 见上一条记录；分支未推送，前序任务与本任务 A04 的 Windows CI 仍待核对

### 2026-11-16 T12 部分完成（提交 815c32d）
- 交付：系统通知实机复测：用户打开 PiArc 的"允许通知"后横幅显示（目视确认，统一日志 `displaying as banner`）；查明第一次没看到横幅的原因是探针 8 秒后关闭应用、Electron 退出时删除已投递的通知，`notify` 改为默认停留 30 秒
- 验收：12 项通过，3 项阻塞（A04：CI 产物待推送；A12、A14：Windows 部分待 CI/W0）
- 遗留：I42（Gatekeeper 开启时的首次打开、macOS 15）；I43 更新为"通知可用，但 `show` 不反映是否允许、退出时通知被删除"

## 计划变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-11-14 | v1.0 | 初版：62 个任务（T01–T51、W0–W4、R1–R6），772 个验收项 |
| 2026-11-14 | v1.1 | 应用图标资产放入 `design/brand/`（取自 PiDeck）；T12 新增图标验收项 T12-A14，T35、T50 补充托盘图标与许可证条目；共 773 个验收项 |
| 2026-11-15 | v1.2 | 用户授权在 T04 中决定 ADR-0019，决定采纳；T04-A06 由"超过阈值的批次以 `ArrayBuffer` 转移、主进程侧缓冲区已分离"改为"1 MiB 以上的批次完整到达渲染进程，基准记录主进程转发耗时，同期事件循环延迟 p99 ≤ 16 ms"（任务文件与 `acceptance.json` 同步修改）；验收项总数不变 |
