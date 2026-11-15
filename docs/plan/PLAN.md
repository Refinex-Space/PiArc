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
| D2：应用标识（bundle id、AppUserModelID）与产品域名 | T08 开工前 | 凭据服务名、URL scheme、安装包都依赖它；以后改动要做数据迁移 |
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
| T04 | [Core NAPI 绑定与事件通道](tasks/T04-core-napi-and-event-channel.md) | 1 | T03 | macOS | xhigh | 大 | S2 | 进行中 | — |
| T05 | [严格校验的 mock provider](tasks/T05-strict-mock-provider.md) | 1 | T02 | macOS | high | 中 | 无 | 未开始 | — |
| T06 | [Agent Host 骨架：Pi SDK 多会话与 AHP](tasks/T06-agent-host-skeleton.md) | 1 | T04、T05 | macOS | xhigh | 大 | S3、S9 | 未开始 | — |
| T07 | [Operations 委托与规范名工具](tasks/T07-operations-delegation-and-canonical-tools.md) | 1 | T06 | macOS | xhigh | 大 | S4 | 未开始 | — |
| T08 | [凭据保险箱](tasks/T08-credential-vault.md) | 1 | T06；D2 | macOS | high | 中 | S5 | 未开始 | — |
| T09 | [Transcript 渲染与 composer 原型](tasks/T09-transcript-and-composer-prototype.md) | 1 | T03 | macOS | xhigh | 大 | S1 | 未开始 | — |
| T10 | [终端验证：libghostty-vt + PTY + 帧协议](tasks/T10-terminal-spike.md) | 1 | T04 | macOS | xhigh | 大 | S7 | 未开始 | — |
| T11 | [沙箱验证：Seatbelt、网络代理与 Job Object](tasks/T11-sandbox-spike.md) | 1 | T07 | macOS | high | 中 | S8 | 未开始 | — |
| T12 | [打包、首次运行与发布清单](tasks/T12-packaging-first-run-and-release-manifest.md) | 1 | T03、T04、T06、T08、T11；D2 | macOS | high | 大 | S6 | 未开始 | — |
| W0 | [Windows：M0 验证项实机确认](tasks/W0-windows-m0-verification.md) | 1 | T08–T12 | Windows | high | 中 | S1、S2、S5–S8（Windows 部分） | 未开始 | — |
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

T04 Core NAPI 绑定与事件通道（开工 2026-11-14；基线 verify 12 项通过；T03 遗留 A03 仍待 Windows CI，分支未推送，不影响本任务）

- [x] 1. `piarc-core`：tokio 运行时、有序关闭、`CancellationToken`、事件合并器（有界通道、默认 16 ms、满时策略不丢事件）、演示事件源；Rust 测试（A01、A02）
- [x] 2. `piarc-napi`：`CoreRuntime.create/shutdown`、演示源启停、同步轻量方法、测试构建的 panic 导出；错误映射与 panic 边界、任务 panic 转错误事件（A08）
- [x] 3. `@napi-rs/cli` 构建脚本、`.d.ts` 生成与 L1 快照并入 verify（A11）
- [x] 4. 主进程：`.node` 路径解析（开发 / `app.asar.unpacked`）、按窗口 `MessageChannelMain`、路由表、结构化克隆 / `ArrayBuffer` 转移（A06）
- [x] 5. preload 事件订阅 API、IPC 命令、白名单快照；渲染进程测试页与统计
- [x] 6. L4：退出不挂起、双窗口路由、panic 后存活、ArrayBuffer、打包产物从 unpacked 加载（A01、A06、A07、A08、A10）——A06 只做了完整性部分：Electron 45 的 `MessagePortMain` 不能转移 `ArrayBuffer`，转移部分待 ADR-0019
- [ ] 7. CI：四个目标预编译与加载测试；本机 darwin-x64 经 Rosetta 加载（A09）
- [ ] 8. `scripts/bench/` 基准（吞吐、事件循环延迟、同步调用、大批次、空闲 RSS），≤ 30 s 正确性版本进 verify
- [ ] 9. 完整基准与 S2 报告、`docs/spikes/README.md`（A03、A04、A05、A12）
- [ ] 10. 文档：两个 crate 的 CLAUDE.md、`apps/desktop/CLAUDE.md`、复用表、架构同步
- [ ] 11. 收尾：verify（A13）、acceptance、PLAN、会话日志

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
| I08 | T02 | Node 的 `JSON.stringify` 把孤立代理项写成 `\udXXX` 转义，serde_json 拒绝这种帧；TS 的 `encodeFrame` 因此直接抛 `TypeError`。模型 SDK 按 UTF-16 切分的流式文本增量可能在代理对中间断开 | T06 在发送 `item/agentMessage/delta` 等文本前处理（例如把末尾的高代理项留到下一个增量），并加测试 |
| I09 | T02 | 帧解码按 serde_json 的递归上限拒绝嵌套超过 127 层的 JSON（TS 实现同样执行）。工具参数等任意 JSON 若更深会被整帧拒绝 | T07 实现工具调用转发时确认可接受；需要更深时评估在 Core 侧放宽并补栈深度保护 |
| I10 | T03 | 发布构建仍接受 Chromium 的 `--remote-debugging-port`（没有对应 fuse，运行时探测 `/json/version` 返回 200）：能以该参数启动 PiArc 的本机进程可经 CDP 在页面中执行脚本并调用 `window.piarc`。威胁等级与 ADR-0018 已接受的本机篡改相同，详见 `docs/spikes/S10-electron-security.md` 第 6 节 | T45 评估在发布构建启动时拒绝或移除该开关（先验证可行性），补回归用例 |
| I11 | T03 | 应用仍使用 Electron 默认菜单，发布构建中也有"Toggle Developer Tools"与"Reload" | T18 替换原生菜单时决定发布构建是否保留开发者工具入口 |

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

## 计划变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-11-14 | v1.0 | 初版：62 个任务（T01–T51、W0–W4、R1–R6），772 个验收项 |
| 2026-11-14 | v1.1 | 应用图标资产放入 `design/brand/`（取自 PiDeck）；T12 新增图标验收项 T12-A14，T35、T50 补充托盘图标与许可证条目；共 773 个验收项 |
