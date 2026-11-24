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

1. **开新会话**：在仓库根目录启动 Claude Code 或 ChatGPT（Codex），或在已有会话中输入 `/clear`（Codex CLI 为 `/new`，桌面版新建对话）。一个任务一个会话，不要在同一个会话里连续做两个任务。
2. **设置模型与思考强度**：按看板 effort 列的推荐值设置，对应关系见下面的"思考强度对照"。
   - Claude Code：模型用 Opus 5.5，用 `/effort high` 或 `/effort xhigh` 设置。
   - ChatGPT（Codex）：模型用 GPT-6.2 Astra，在模型选择器里选"高"或"极高"（CLI：`/model` 选 `gpt-6.2-astra` 后选 high 或 xhigh）。Astra 的默认是"轻度"，每个会话开始前确认已经切换。
3. **启动任务**：输入 `/task T05`（Codex 中为 `$task T05`；把编号换成要做的任务），或者把 `docs/plan/tasks/` 下对应文件的全部内容粘贴进去，两种方式等价。
4. **可选：设置完成条件**：长任务可以再输入一条 `/goal`，例如 `/goal docs/plan/acceptance.json 中 T05 的验收项全部为 passing 或 blocked，且 PLAN.md 中 T05 的状态为已完成`。
5. **看报告**：任务结束时智能体给出固定格式的报告。重点看"验收结果"中的失败与阻塞项，以及"遗留与风险"中需要你决定的事。
6. **推送**：智能体只提交不推送。确认无误后由你执行 `git push`。

### 思考强度对照

| 看板 effort | Claude Code（Opus 5.5） | ChatGPT（GPT-6.2 Astra） | 用在什么任务 |
|---|---|---|---|
| high | `/effort high` | 高（`high`） | 范围清楚的实现、评审、Windows 对齐 |
| xhigh | `/effort xhigh` | 极高（`xhigh`） | 跨进程、跨语言或改核心不变量的长任务 |

- 两家官方对这两档的定义一致：high 用于复杂推理、困难的编码与 agent 任务；xhigh 用于需要长时间运行的 agent 与编码任务。所以按同名档位对应。
- 不用"轻度"和"中"：每个任务都是带质量门禁的完整交付，这两档省下的额度换不回返工的时间。
- Max 只作为升级手段：同一任务连续两个会话卡在同一个质量门禁上，或者续做时发现上一轮漏掉了关键问题，再把这个任务升到 Max。两家都说明 Max 用更多时间和额度换取有限的提升，不作为默认值。
- 不用 Ultra：它让 Codex 自行派出子 agent 并行工作，与"一个任务一个会话、按检查点提交"的协议冲突，并行改动还会互相覆盖。
- GPT-6.2 Astra 的系统卡记录了一个退步：遇到阻碍时，它比上一代更容易在最终答复里略过不提。Codex 自带的开发者提示能明显缓解这一点；看报告时仍要对照"验收结果"逐项核实。

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

带关口的任务：T12（实机）、T18（视觉）、T39（Windows 隔离方案以 ADR 提议的形式请你决定）、T46（设计）、T47（设计）、T49（实机：快捷指令）、T50（实机：推送、受保护环境与密钥、批准签名步骤）、R1（实机：T09 留下的 macOS 输入法核对清单）、T51 与 W0–W4（实机：系统放行、输入法、读屏等需要你在真实系统界面上操作的步骤）。

macOS 任务结束时，凡是要靠 Windows CI 证明的验收项都会先标为 `blocked`（智能体不推送，拿不到 CI 结果），任务显示"部分完成"。你推送后，下一个任务开工时会按 CI 结果关闭这些项（执行协议"开工"第 4 步）。

### 需要你提前准备的事

| 事项 | 最晚在 | 说明 |
|---|---|---|
| ~~D2：应用标识（bundle id、AppUserModelID）与产品域名~~ | T08 开工前 | **已决定**（2026-11-15）：域名 `piarc.cn`，应用标识 `cn.piarc.desktop`；发布后不能再改 |
| D6：Intel（x64）版本是否发布 | T12 开工前 | 没有决定时按需求规格的建议首发 x64，之后按使用统计决定是否继续 |
| D3：视觉品牌的主色与字标（图标已定，见 `design/brand/`） | T18 开工前 | **主色已定**（2026-11-18，T18 视觉关口确认 indigo 方向）；名称字标仍待定；Pi logo 的使用许可在 R6 前确认 |
| Windows 11 电脑 | W0 开工前 | 有 arm64 设备时也请准备，用于验证 win32-arm64 |
| 一家真实模型服务商的 API key（可选） | R2 开工前 | M1 退出标准中的"真实服务商完整任务"；调用前会先说明预计费用 |
| ~~本机安装 Claude Code CLI~~ | T30 开工前 | **已就绪**（T30 时本机为 2.1.318）：L3 行为对齐运行 `claude`，只连本地 mock，不需要 Anthropic 账号 |

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
| 1 M0 技术验证 | Electron 安全基线、NAPI 事件通道、mock provider、Agent Host 多会话与 AHP、Operations 委托、凭据保险箱、transcript 渲染、终端、沙箱、打包与首次运行；S1–S10 两个平台的结论 | T03–T12、W0 | R1 | 已完成（有条件进入 M1） |
| 2 M1 可行走骨架 | 存储与信任、会话编排与投影、L2 场景、文件工具与 Bash、客户端外壳、transcript 与 composer、基础审批、模型与凭据、system prompt 与 memory | T13–T22 | R2 | 已完成（macOS 达标；Windows 由 W1 达标，UNC 由 W2 补验） |
| 3 M2 Harness 核心 | 权限规则与 Bash 分析、配置兼容层、hooks、计划模式与任务清单、压缩与用量、检查点与回退、WebFetch 与登录、L3 对齐；Windows 达到 M1 | W1、T23–T30 | R3 | 已完成（macOS 达标，R3；Windows 的 M1 由 W1 达标，UNC 由 W2 补验；Windows 的 M2 由 W2 达标） |
| 4 M3 多会话与生态 | 子 agent、后台任务、终端、worktree 与并行会话、MCP、skills 与命令、WebSearch 与 hooks 扩展；Windows 达到 M2 | W2、T31–T38 | R4 | M3 能力已交付；macOS 未达标（内存口径待用户决定，R4）；Windows 的 M2 由 W2 达标 |
| 5 M4 安全与打磨 | 沙箱、插件、配置诊断与用量、NotebookEdit 与通知、无障碍与本地化、性能预算、安全收口；Windows 达到 M3 | W3、T39–T45 | R5 | M4（macOS）未达标（R5）：九项目标已交付，安全威胁表本地逐条有测试（CI 待推送），性能一条不满足（流式帧、主进程增量、Agent Host 内存超出；应用内存口径待 ADR-0063）；Windows 的 M3 由 W3 确认（内存同口径），M4 由 W4 验收 |
| 6 M5 Beta | Auto 模式、自动记忆与托管配置、M5 补全、侧边对话与平台快捷操作、发布流水线；Windows 达到 M4 并与 Beta 同步；两平台端到端验收 | T46–T50、W4、T51 | R6 | 未开始 |

## 任务看板

状态取值：未开始、进行中、部分完成（有 `blocked` 验收项）、已完成、阻塞（等待用户……）。"完成提交"填任务最后一个提交的短哈希。

| 编号 | 任务 | 阶段 | 依赖 | 平台 | effort（Opus / Astra） | 规模 | 验证项 | 状态 | 完成提交 |
|---|---|---|---|---|---|---|---|---|---|
| T01 | [仓库脚手架、工程规范与质量门禁](tasks/T01-scaffold-and-quality-gates.md) | 0 | 无 | macOS | high / 高 | 大 | 无 | 已完成 | 47fb1e9 |
| T02 | [协议单一来源与契约测试基座](tasks/T02-protocol-and-contract-tests.md) | 0 | T01 | macOS | high / 高 | 中 | 无 | 已完成 | ce41191 |
| T03 | [Electron 应用骨架与安全基线](tasks/T03-electron-shell-and-security-baseline.md) | 1 | T02 | macOS | xhigh / 极高 | 大 | S10 | 已完成 | 63eabea |
| T04 | [Core NAPI 绑定与事件通道](tasks/T04-core-napi-and-event-channel.md) | 1 | T03 | macOS | xhigh / 极高 | 大 | S2 | 已完成 | aa2817f |
| T05 | [严格校验的 mock provider](tasks/T05-strict-mock-provider.md) | 1 | T02 | macOS | high / 高 | 中 | 无 | 已完成 | 1487154 |
| T06 | [Agent Host 骨架：Pi SDK 多会话与 AHP](tasks/T06-agent-host-skeleton.md) | 1 | T04、T05 | macOS | xhigh / 极高 | 大 | S3、S9 | 已完成 | 2214b08 |
| T07 | [Operations 委托与规范名工具](tasks/T07-operations-delegation-and-canonical-tools.md) | 1 | T06 | macOS | xhigh / 极高 | 大 | S4 | 已完成 | 3a8744f |
| T08 | [凭据保险箱](tasks/T08-credential-vault.md) | 1 | T06；D2 | macOS | high / 高 | 中 | S5 | 已完成 | 83dc25b |
| T09 | [Transcript 渲染与 composer 原型](tasks/T09-transcript-and-composer-prototype.md) | 1 | T03 | macOS | xhigh / 极高 | 大 | S1 | 已完成 | 9c0738d |
| T10 | [终端验证：libghostty-vt + PTY + 帧协议](tasks/T10-terminal-spike.md) | 1 | T04 | macOS | xhigh / 极高 | 大 | S7 | 已完成 | e2c302d |
| T11 | [沙箱验证：Seatbelt、网络代理与 Job Object](tasks/T11-sandbox-spike.md) | 1 | T07 | macOS | high / 高 | 中 | S8 | 已完成 | 1b92a25 |
| T12 | [打包、首次运行与发布清单](tasks/T12-packaging-first-run-and-release-manifest.md) | 1 | T03、T04、T06、T08、T11；D2 | macOS | high / 高 | 大 | S6 | 已完成 | 815c32d |
| W0 | [Windows：M0 验证项实机确认](tasks/W0-windows-m0-verification.md) | 1 | T08–T12 | Windows | high / 高 | 中 | S1、S2、S5–S8（Windows 部分） | 已完成 | f278039 |
| R1 | [M0 评审与收口](tasks/R1-m0-review.md) | 1 | W0 | macOS | high / 高 | 中 | S1–S10 汇总 | 已完成 | 6eef36d |
| T13 | [存储、数据目录、配置与项目信任](tasks/T13-storage-config-and-trust.md) | 2 | R1（结论为进入 M1） | macOS | high / 高 | 大 | 无 | 已完成 | 12ad055 |
| T14 | [会话编排与事件投影](tasks/T14-session-orchestration-and-projection.md) | 2 | T13 | macOS | xhigh / 极高 | 大 | 无 | 已完成 | eedccea |
| T15 | [无头驱动、L2 场景运行器与能力清单](tasks/T15-devcli-l2-scenarios-and-capabilities.md) | 2 | T14 | macOS | high / 高 | 中 | 无 | 已完成 | 5546027 |
| T16 | [文件工具与编辑不变量](tasks/T16-file-tools-invariants.md) | 2 | T15 | macOS | xhigh / 极高 | 大 | 无 | 已完成 | ea75a25 |
| T17 | [Bash / PowerShell 执行与进程管理](tasks/T17-bash-powershell-execution.md) | 2 | T16 | macOS | high / 高 | 大 | 无 | 已完成 | d154ab3 |
| T18 | [客户端外壳、会话列表、设置窗口与信任对话框](tasks/T18-client-shell-and-session-list.md) | 2 | T17；D3 | macOS | xhigh / 极高 | 大 | 无 | 已完成 | 6b1d5f0 |
| T19 | [Transcript 与 composer 正式版](tasks/T19-transcript-and-composer.md) | 2 | T18 | macOS | xhigh / 极高 | 大 | 无 | 已完成 | 0b72964 |
| T20 | [基础权限与审批](tasks/T20-basic-permissions-and-approvals.md) | 2 | T19 | macOS | xhigh / 极高 | 大 | 无 | 已完成 | ee03128 |
| T21 | [模型、服务商与凭据设置](tasks/T21-models-providers-and-credentials.md) | 2 | T20 | macOS | high / 高 | 大 | 无 | 已完成 | e5f3b65 |
| T22 | [System prompt 组装与 memory 文件](tasks/T22-system-prompt-and-memory-files.md) | 2 | T21 | macOS | high / 高 | 中 | 无 | 已完成 | 9843eb5 |
| R2 | [M1 评审](tasks/R2-m1-review.md) | 2 | T22 | macOS | high / 高 | 中 | 无 | 已完成 | f63ac3d |
| W1 | [Windows：M1 达标](tasks/W1-windows-m1-parity.md) | 3 | R2 | Windows | high / 高 | 中 | 无 | 已完成 | b0a510f |
| T23 | [权限规则完整版与 Bash 命令分析](tasks/T23-permission-rules-and-bash-analysis.md) | 3 | R2 | macOS | xhigh / 极高 | 大 | 无 | 已完成 | 8a1f38b |
| T24 | [Claude Code 配置兼容层与配置诊断（基础）](tasks/T24-claude-code-config-compat.md) | 3 | T23 | macOS | high / 高 | 中 | 无 | 已完成 | ae5c8e6 |
| T25 | [Hooks（M2 事件集与 command 类型）](tasks/T25-hooks-m2.md) | 3 | T24 | macOS | xhigh / 极高 | 大 | 无 | 已完成 | 30a4f17 |
| T26 | [计划模式、任务清单、AskUserQuestion 与下一步](tasks/T26-plan-mode-todo-ask-next-steps.md) | 3 | T25 | macOS | xhigh / 极高 | 大 | 无 | 已完成 | 23630e3 |
| T27 | [上下文工程：system reminder、压缩与用量](tasks/T27-context-reminders-compaction-usage.md) | 3 | T26 | macOS | xhigh / 极高 | 大 | 无 | 已完成 | b0b2641 |
| T28 | [检查点、回退与 Changes 面板](tasks/T28-checkpoints-rewind-changes.md) | 3 | T27 | macOS | xhigh / 极高 | 大 | 无 | 已完成 | c849475 |
| T29 | [WebFetch、登录与模型设置补全、三档视图](tasks/T29-webfetch-login-model-settings-views.md) | 3 | T28 | macOS | high / 高 | 中 | 无 | 已完成 | 7f9e79b |
| T30 | [L3 行为对齐基座](tasks/T30-l3-behavior-alignment.md) | 3 | T29 | macOS | high / 高 | 中 | 无 | 已完成 | f52b5aa |
| R3 | [M2 评审](tasks/R3-m2-review.md) | 3 | T30、W1 | macOS | high / 高 | 中 | 无 | 已完成 | 8e2b4a2 |
| W2 | [Windows：M2 达标](tasks/W2-windows-m2-parity.md) | 4 | R3 | Windows | high / 高 | 中 | 无 | 已完成 | 45124e4 |
| T31 | [子 agent 与模型别名](tasks/T31-subagents-and-model-aliases.md) | 4 | R3 | macOS | xhigh / 极高 | 大 | 无 | 已完成 | 7ec1971 |
| T32 | [后台任务、Monitor 与 KillShell](tasks/T32-background-tasks-and-monitor.md) | 4 | T31 | macOS | high / 高 | 中 | 无 | 已完成 | ef39d43 |
| T33 | [无头终端（Core 侧）](tasks/T33-headless-terminal.md) | 4 | T32 | macOS | xhigh / 极高 | 大 | 无 | 已完成 | 33f4bf9 |
| T34 | [终端渲染器与终端面板](tasks/T34-terminal-renderer-and-panel.md) | 4 | T33 | macOS | xhigh / 极高 | 大 | 无 | 已完成 | 5ab5a2a |
| T35 | [Worktree、并行会话、多窗口、全文搜索与后台常驻](tasks/T35-worktrees-parallel-sessions-and-windows.md) | 4 | T34 | macOS | high / 高 | 大 | 无 | 已完成 | 15cbab1 |
| T36 | [MCP 共享连接池](tasks/T36-mcp-connection-pool.md) | 4 | T35 | macOS | xhigh / 极高 | 大 | 无 | 已完成 | ca3d873 |
| T37 | [Skills、斜杠命令、命令面板与输出风格](tasks/T37-skills-commands-and-output-styles.md) | 4 | T36 | macOS | high / 高 | 大 | 无 | 已完成 | b9012bb |
| T38 | [WebSearch 与 hooks 扩展（M3）](tasks/T38-websearch-and-hooks-m3.md) | 4 | T37 | macOS | high / 高 | 中 | 无 | 已完成 | fc9c022 |
| R4 | [M3 评审](tasks/R4-m3-review.md) | 4 | T38、W2 | macOS | high / 高 | 中 | 无 | 已完成 | ab27901 |
| W3 | [Windows：M3 达标](tasks/W3-windows-m3-parity.md) | 5 | R4（建议在 T43、T44 之后，需要读屏清单与性能测量脚本） | Windows | high / 高 | 中 | 无 | 部分完成 | 9879474 |
| T39 | [macOS 沙箱正式版与 Windows 隔离评估](tasks/T39-sandbox-and-windows-isolation.md) | 5 | R4 | macOS | xhigh / 极高 | 大 | 无 | 已完成 | 607809d |
| T40 | [插件、Pi 包与 MCP prompts](tasks/T40-plugins-pi-packages-mcp-prompts.md) | 5 | T39（只阻塞在 Windows 设计关口时也可开始） | macOS | high / 高 | 大 | 无 | 已完成 | c4e5f75 |
| T41 | [配置诊断完善、M4 hooks 事件与用量成本](tasks/T41-config-diagnostics-hooks-m4-usage.md) | 5 | T40 | macOS | high / 高 | 中 | 无 | 已完成 | 10fbeff |
| T42 | [NotebookEdit、可操作通知与 diff 行内评论](tasks/T42-notebook-notifications-diff-comments.md) | 5 | T41 | macOS | high / 高 | 中 | 无 | 已完成 | 27ba9d1 |
| T43 | [无障碍与本地化](tasks/T43-accessibility-and-localization.md) | 5 | T42 | macOS | high / 高 | 中 | 无 | 部分完成 | 00b452b |
| T44 | [性能预算进 CI 与长跑测试](tasks/T44-performance-budgets-in-ci.md) | 5 | T43 | macOS | high / 高 | 中 | 无 | 已完成 | ff9b112 |
| T45 | [安全收口：威胁模型逐条测试、隐私与诊断包](tasks/T45-security-hardening-and-privacy.md) | 5 | T44 | macOS | xhigh / 极高 | 中 | 无 | 部分完成 | c970cd6 |
| R5 | [M4 评审](tasks/R5-m4-review.md) | 5 | T45、W3 | macOS | high / 高 | 中 | 无 | 已完成 | e37fcdc |
| T46 | [Auto 模式（审查模型）](tasks/T46-auto-mode.md) | 6 | R5 | macOS | xhigh / 极高 | 大 | 无 | 已完成 | 84a4d07 |
| T47 | [自动记忆与企业托管配置](tasks/T47-auto-memory-and-managed-settings.md) | 6 | T46 | macOS | xhigh / 极高 | 大 | 无 | 已完成 | 9212335 |
| T48 | [M5 Harness 补全](tasks/T48-m5-harness-completion.md) | 6 | T47 | macOS | high / 高 | 大 | 无 | 已完成 | 14d01a0 |
| T49 | [侧边对话与平台快捷操作](tasks/T49-side-chat-and-platform-shortcuts.md) | 6 | T48 | macOS | high / 高 | 中 | 无 | 已完成 | f11a450 |
| T50 | [发布流水线与更新](tasks/T50-release-pipeline-and-updates.md) | 6 | T49 | macOS | high / 高 | 大 | 无 | 未开始 | — |
| W4 | [Windows：M4 达标与 Beta 同步](tasks/W4-windows-m4-parity-and-beta.md) | 6 | R5、T50 | Windows | high / 高 | 中 | 无 | 未开始 | — |
| T51 | [Beta 端到端验收](tasks/T51-beta-acceptance.md) | 6 | W4 | macOS 与 Windows | high / 高 | 大 | 无 | 未开始 | — |
| R6 | [Beta 发布评审](tasks/R6-beta-release-review.md) | 6 | T51 | macOS | high / 高 | 中 | 无 | 未开始 | — |

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

## 登记事项

任务执行中发现、但不属于本任务范围的问题，在这里登记：编号（I01 起）、发现于哪个任务、内容、建议由哪个任务处理。处理完成后在"建议处理"一列注明"已落地"与位置。

| 编号 | 发现于 | 内容 | 建议处理 |
|---|---|---|---|
| I01 | 制定计划 | Claude Code 当前默认使用 TaskCreate / TaskUpdate 等任务工具，TodoWrite 已是旧版（`claude-official-capabilities.md`）。PiArc 的规范名仍是 TodoWrite，权限规则与 L3 比对会出现差异 | T26 评估是否增加兼容映射；T30 先把差异写入 L3 allowlist；**T26 评估：不加映射**。PiArc 的清单工具只有 `TodoWrite`（规范名，参数与 Claude Code 一致），`TaskCreate`/`TaskUpdate` 是拆成多次调用的另一种接口，模型可见名之间映射会让规则与 hooks 的 matcher 对不上；写 `TaskCreate(…)` 规则或 matcher 的用户需要改写为 `TodoWrite`，T30 仍把差异写入 L3 allowlist；**已落地（T30）**：`tests/l3-allowlist.yaml` 的 `requests.items[*].tools.TodoWrite` 条目 |
| I02 | 制定计划 | FR-MD-05 要求 skills 能引用模型别名，但架构第 6.7 节的 skill frontmatter 没有 `model` 字段 | T37 评估：支持则补架构与实现，不支持则改需求描述；**T37**：任务范围把 skill 的 `model`、`effort` 定为解析后标暂不支持（Claude Code 中它们只在本回合或 `context: fork` 的子 agent 里生效），诊断标 T48；建议 T48 随 `context: fork` 一起实现（模型说明经 `resolveModel`，别名可用），届时 FR-MD-05 的 skills 部分落地，需求描述不改 |
| I03 | 制定计划 | Monitor 在会话空闲时唤醒会话（按 Claude Code 官方行为）会自动产生模型费用 | T32 实现时提供开关与限速，R4 请用户确认默认值；**已落地（T32）**：设置 `monitor.wakeIdleSession`（合并层，默认 true，关掉时新行只排队、不唤醒）与唤醒间隔 30 s（`piarc_core::tasks::TaskLimits::monitor_wake_interval`），单批与总量限速同在 `TaskLimits`；R4 请用户确认默认值；**已关闭（R4）**：默认值保持（唤醒开、间隔 30 s，与 Claude Code 的唤醒行为一致，限速在 `TaskLimits`），列入 R4 报告请用户确认；设置页入口见 I138 |
| I04 | 制定计划 | macOS App Intents 在 ad-hoc 签名下能否工作，M0 没有验证（需要 Xcode 生成的元数据随包分发） | T49 先做可行性原型；不可行时写 ADR 提议。若想提前知道结论，可在 R1 时追加一次快速验证；R1 决定：不在 R1 追加验证，T49 先做可行性原型（不影响 M1） |
| I05 | 制定计划 | 架构第 6.10 节说 MCP server 在沙箱外，但 stdio MCP server 由 Agent Host 启动，会继承 Agent Host 的 Seatbelt 写入限制（第 10.3 节） | T39 定稿 Agent Host 配置时澄清并更新架构；放宽写入范围属于变更型；**T36**：stdio MCP server 由 PiArc 自写的传输启动、留在 Agent Host 的进程组（为了不留孤儿进程，ADR-0053 第 8 条），所以仍继承 Agent Host 的 Seatbelt；npm 缓存与临时目录指向数据目录，registry 包可用，问题留给 T39；**已落地（T39）**：第 6.10 节的"MCP server 在沙箱外"指 Bash 沙箱；stdio MCP server 在 Agent Host 的定稿配置之下，经内置 npx 启动的 registry 包可以完成工具调用，不需要放宽（ADR-0056 第 12 条，`sessions sandbox::the_agent_host_profile_keeps_extensions_and_mcp_servers_in_their_places`），架构 6.10、10.3 已更新 |
| I06 | T01 | `npm audit` 报告 8 个 moderate（GHSA-g3hv-75wg-m249，minimatch 经 eslint 10.14 与 typescript-eslint 8.72 引入，仅开发工具链，不进安装包）；架构第 13.3 节要求的 `npm audit`、`cargo-audit` 尚未接入 CI（cargo-deny 的 advisories 已覆盖 RustSec 数据库） | 上游修复后升级 eslint 与 typescript-eslint；T45 或 T50 把 `npm audit --omit=dev` 接入 CI；**T45**：`npm audit` 与 cargo-audit 接入（`npm run audit:deps`，CI `deps-security.yml` 在依赖改动与每天运行）；minimatch GHSA-g3hv-75wg-m249 仍在（只在开发工具链）：修复版 eslint 10.15.0 与 typescript-eslint 8.73.0 的新规则 `no-unsafe-class-instance-assignment` 对 Electron `BrowserWindow.fromWebContents` 报 9 处误报，暂不升级，写入 `tests/security/audit-exceptions.yaml`（复查 2027-01-31） |
| I07 | T01 | TypeScript 7.0 已发布，typescript-eslint 8.72 只支持 `<6.1`，仓库锁在 TypeScript 6.0.3 | 各评审任务按月复查 typescript-eslint 的支持范围，支持后再升级；**R3 复查（2026-11-20）**：最新 typescript-eslint 8.73.0 对 `typescript` 仍为 `<6.1.0`（只为 TypeScript 7 的 `@typescript/native` 预览版另开支持），保持 6.0.3，R4 再查；**R4 复查（2026-11-21）**：typescript-eslint 8.73.0 仍为 `typescript` `<6.1.0`，保持 6.0.x，R5 再查 |
| I08 | T02 | Node 的 `JSON.stringify` 把孤立代理项写成 `\udXXX` 转义，serde_json 拒绝这种帧；TS 的 `encodeFrame` 因此直接抛 `TypeError`。模型 SDK 按 UTF-16 切分的流式文本增量可能在代理对中间断开 | 已落地（T06）：`agent-host/src/runtime/projector.ts` 把增量末尾的高代理项留到下一个增量，无法配对的代理项替换为 U+FFFD，其余发往 Core 的字符串用 `toWellFormed()`；测试 `projector.test.ts` |
| I09 | T02 | 帧解码按 serde_json 的递归上限拒绝嵌套超过 127 层的 JSON（TS 实现同样执行）。工具参数等任意 JSON 若更深会被整帧拒绝 | 已确认（T07）：`fs/*`、`exec/*` 的参数是扁平结构；模型给的工具参数只出现在 `item/*` 通知里，超过 127 层时该帧被 Core 拒绝、工具照常执行，现有工具 schema 都很浅，可以接受（`docs/spikes/S04-operations-delegation.md` 第 10 节）。T14 投影时若要保住这类帧，对深层参数做截断；已落地（T14）：`agent-host/src/runtime/items.ts` 把嵌套超过 64 层的工具参数换成一条说明（`MAX_ARGUMENT_DEPTH`），帧不再被拒；测试 `agent-host/src/runtime/items.test.ts` |
| I10 | T03 | 发布构建仍接受 Chromium 的 `--remote-debugging-port`（没有对应 fuse，运行时探测 `/json/version` 返回 200）：能以该参数启动 PiArc 的本机进程可经 CDP 在页面中执行脚本并调用 `window.piarc`。威胁等级与 ADR-0018 已接受的本机篡改相同，详见 `docs/spikes/S10-electron-security.md` 第 6 节 | T45 评估在发布构建启动时拒绝或移除该开关（先验证可行性），补回归用例；**已落地（T45）**：发布构建的主进程在 `ready` 前移除 `--remote-debugging-port`、`--remote-debugging-pipe` 并退出（`security/runtime-switches.ts`）；`scripts/ci/check-release-runtime.mjs` 在打包产物上验证（带未写 fuse 的 Electron 对照），CI `desktop` 作业运行 |
| I11 | T03 | 应用仍使用 Electron 默认菜单，发布构建中也有"Toggle Developer Tools"与"Reload" | T18 替换原生菜单时决定发布构建是否保留开发者工具入口；**已落地（T18）**：原生菜单由 `src/main/menu.ts` 构建，重新加载与开发者工具只在开发构建出现（加载开发版 Core 或开发服务器），发布构建没有 |
| I12 | T04 | 架构第 11 章"主进程内存（含 Core，空闲）≤ 120 MB"低于 Electron 自身基线：macOS arm64 上裸 Electron 45.3.2 开一个空窗口主进程 RSS 约 155 MB，PiArc 含 Core 160–164 MB（Core 与应用代码约 5–8 MB），数据见 `docs/spikes/S02-napi-event-channel.md` 第 4.4 节 | R1 按 M0 实测校准该预算（放宽要在第 18 章写明原因），可改为"相对裸 Electron 的增量"；W0 补 Windows 数据；已落地（R1）：第 11 章改为"相对同平台同版本裸 Electron 的增量 ≤ 24 MB"（放宽原因见架构第 18 章 v2.17），实测增量 macOS 5–8 MB、Windows 12 MB |
| I13 | T04 | 渲染进程的 `#/event-probe` 测试页随发布构建的渲染包分发（发布版 Core 没有演示事件源与测试钩子，页面只能订阅、计数） | T45 评估是否在发布构建中剔除测试页；**已落地（T45）**：测试页只在开发构建的单独 chunk 里（`renderer/test-pages.tsx`，构建期常量 `__PIARC_RELEASE_BUILD__`），`check-app-layout.mjs --flavor release` 核对发布构建没有它们（CSS 里无代码的 `.lab`、`.probe` 选择器仍在） |
| I14 | T05 | `packages/testkit` 把 `@earendil-works/pi-ai` 精确锁定为 1.5.2（任务开工时 npm 上的最新稳定版），尚未与 Agent Host 统一 | 已落地（T06）：Pi 锁定 1.5.2，`agent-host` 与 `packages/testkit` 的 `@earendil-works/*` 同为 1.5.2，lockfile 中无第二个版本 |
| I15 | T05 | pi-ai 的 API 实现（`anthropicMessagesApi`、`openAICompletionsApi`）只经公开子路径 `@earendil-works/pi-ai/api/<api>.lazy` 导出，主入口不导出；`packages/testkit` 使用了它们 | 已落地（T06）：`eslint.config.mjs` 的 `piPublicImports` 按各包 `exports` 放行子路径，只禁未导出的路径 |
| I16 | T06 | Pi 1.5.1 起 `cacheWarming` 默认为 `"idle"`：会话空闲时最多 30 分钟内自动发请求保温提示缓存（模型配置了 `promptCache` 才会触发），会产生模型费用；Agent Host 目前沿用 Pi 默认值 | T21 生成 `pi/settings.json` 时显式设定，T27 的用量与成本界面说明这类请求；默认值请用户在 R2 确认；T21 已落地，R2 复核缺省 off 并保留显式值，避免空闲时产生非交互请求。；T27：用量卡片只显示上下文占用，不涉及费用；空闲保温请求的说明随 T41 的用量与成本界面（缺省 off 不变） |
| I17 | T06 | `piarc-exec` 的 `TokioProcessSpawner` 只终止直接子进程：Agent Host 被杀时，它启动的子进程（bash 命令、MCP server）不随之结束；架构第 5.6 节要求的进程组（macOS）与 Job Object（`KILL_ON_JOB_CLOSE`，Windows）尚未实现。需要 `killpg` 或 Win32 API，而 `unsafe` 只允许在 sys 与 NAPI crate | 部分落地（T11）：`piarc_exec::ProcessTreeSpawner` 实现了进程组（nix 的 `killpg`）与 Job Object（`piarc-exec` 的 `job` 模块），沙箱命令已用它；T12、T17 的接入见 I33；**已落地（T17）**：Core 的全部命令改用 `ProcessTreeSpawner` |
| I18 | T06 | Pi 1.5.2 中断一个回合后，下一次请求丢弃被中断的 assistant 消息，出现两条相邻的 user 消息（Anthropic API 会合并它们，严格 mock 的 `role_order` 拒绝）。PiArc 需要决定中断后的对话形态（例如像 Claude Code 那样补一条中断标记），S3/S9 的中断场景暂时关闭了 `role_order` | T14 定义中断后的 transcript 形态并恢复 `role_order`；T27 对齐压缩与中断标记；已落地（T14，ADR-0026）：中断后 Harness Kit 补写已中断的工具结果与 assistant 中断标记（`agent-host/src/harness/interruption.ts`），重新打开会话时同样收尾；S3、S9 的中断场景与 T14-A05 开着 `role_order`。steer 紧跟工具结果仍是相邻 user 消息（ADR-0026 后果一节），含 steer 的场景关闭 `role_order` |
| I19 | T07 | 工具的 `fs/*`、`exec/*` 请求与会话通知共用 Agent Host 的 stdout：Core 的事件消费者停住、读取停在投递上时，后面的工具请求也读不到，工具随之等待（背压，不丢失）。T06 的慢读者测试因此改为用不存在的工具制造通知 | T14 的事件消费者持续取走事件，不在消费路径上做阻塞等待；R1 评估是否需要让请求帧绕开通知背压（例如单独的通道）；R1 决定：不新增独立的请求通道（改变 AHP 传输属变更型）；T14 的事件消费者持续取走事件、不在消费路径阻塞，R2 用 T14 的场景测通知洪峰下的工具 I/O 延迟，超标时再写 ADR；已落地（T14）：每次启动监管器配一个消费任务持续取走 `HostEvents`，会话 actor 不在处理路径上等待 Agent Host（`crates/piarc-core/src/sessions/workspace.rs`）；会话邮箱（1,024）满时消费任务等待，是有意的背压。R2 实测 2,048 个 wire delta 后同连接 Read 返回夹具内容，Core 收到 fs/stat 到收到 fs/read 间隔 2.058 ms（单次，非预算）。W1 重测 Windows 背压 |
| I20 | T07 | Pi 1.5.2 的 `createAgentSessionRuntime` 在会话创建时于 Agent Host 本进程 `existsSync(cwd)`（`assertSessionCwdExists`），是 Agent Host 对工作区路径唯一的直接访问（只读元数据，场景期间为 0） | T14 决定接受（写入架构）或由 Core 在 `session/create` 前检查；T39 的 Agent Host Seatbelt 配置允许对工作区的元数据读取；已落地（T14）：接受 Pi 的 `existsSync(cwd)`，Core 在 `session/create` 前规范化并确认 cwd 是工作区内已存在的目录（架构 7.4 节，`crates/piarc-core/src/sessions/mod.rs`） |
| I21 | T07 | 委托工具不读 Pi 设置中的 `shellPath`、`shellCommandPrefix`（Bash）与 `images.autoResize`（Read），取默认值；命令环境是 Core 的白名单环境加 Pi 的会话变量，不含 Agent Host 内部的 `PI_*` 变量 | T17 接上 shell 相关设置（与 Git Bash 探测一起），T21 生成 Pi 设置时决定图片缩放并让 Read 读取；**已落地（T17）**：Bash 改为 PiArc 自写（ADR-0028），Windows 的 Git Bash 路径由 PiArc 设置 `shell.gitBashPath` 指定，Pi 的 `shellPath`、`shellCommandPrefix` 不再适用；命令环境改为登录 shell 环境去掉内部变量，不再传 Pi 的 `PI_*` 会话变量；T21 已接入 Pi 设置中的 images.autoResize，缺省 true |
| I22 | T08 | D2（应用标识）尚未落实，`piarc-core::identity::APP_IDENTIFIER` 是占位值 `PiArc.pending-D2`，凭据库服务名 `PiArc.pending-D2.credential-vault` 由它生成。改成正式标识后，用占位标识存过凭据的构建找不到主密钥，保险箱返回 `masterKeyMissing` | 已落地（2026-11-15）：D2 定为域名 `piarc.cn`、应用标识 `cn.piarc.desktop`，`APP_IDENTIFIER` 已替换，T08-A12 通过。占位标识只用于未发布的开发构建，无需迁移；T12 用同一常量设置 bundle id 与 AppUserModelID |
| I23 | T08 | Agent Host 的 `secrets/lock` 请求超时（桥接默认 30 s）后 Core 才授予的锁无人释放，要等 30 s 租约到期，期间同一 provider 的写入等待；pi-ai 的取消信号只取消排队，同样可能留下这种锁 | 影响限于同一 provider 的写入延迟；R1 评估是否让 Core 在授予前检查请求方是否仍在等待（例如锁请求带截止时间）；R1：与 R1-C9、A5 合并为 I57，交 T21；T21 已落地：截止时间、迟到授予回收与续约 |
| I24 | T09 | transcript 原型页 `#/transcript-lab` 与合成夹具（`src/renderer/lab/`）随发布构建的渲染包分发，与 I13 的 `#/event-probe` 同类 | T45 与 I13 一起评估在发布构建中剔除测试页；**已落地（T45）**：见 I13 |
| I25 | T09 | 真实输入法（macOS 简体拼音、日文）与触控板滚动手感需要人工核对，清单见 `docs/spikes/S01-transcript-composer.md` 第 7 节（M1–M10）；自动化部分已用 CDP 合成通过 | 用户核对后把结果告诉智能体补记到 S1 报告；R1 汇总 S1 时检查；R1：macOS composer 的真实输入法与触控板核对交 T19，R2 检查；日文输入法两个平台都未验证（T19、W1）；**T19 用户确认 macOS M1–M10 人工核对通过**（S01 第 7 节），Windows 日文输入法留 W1；W1：微软拼音实机通过，用户决定不安装日文语言包，Windows 日文仍未验证；**R4**：Windows 日文输入法仍未验证，交 T51 的两平台验收（用户决定装语言包时） |
| I26 | T09 | S1 基准中应用全部进程合计 489 MiB，超出第 11 章"不含 Agent Host 的全部进程 ≤ 450 MB"；渲染进程 179 MiB 在预算内，超出主要来自主进程（179 MiB，含 Core 与测试驱动） | R1 与 I12 一起按 M0 实测校准；W0 补 Windows 数据；已落地（R1）：进程合计改为 macOS ≤ 510 MB（放宽原因见架构 v2.17）、Windows ≤ 450 MB；两平台实测仍超出，交 T44，R4 复核；**R4 复核**：3 会话 + 子 agent + 共享 MCP 时应用其余进程 RSS 合计 577–580 MB，仍超出；同负载 phys_footprint 约 250 MB，超出主要是各进程重复计入的共享框架页（R4 评审）。预算不放宽，交 T44：定测量口径（需 ADR）或优化；**T44**：Nightly 测量（侧栏 100 个会话、打开 1,000 条）RSS 合计 519 MB 仍超出，同一时刻 `footprint` 物理占用合计 207 MB（`probe-memory.mjs` 的 `detail.footprintMB`）；T44 没有改口径（改口径等于放宽，须由用户经 ADR 决定），两种读数都进 Nightly 报告，交 R5 与用户决定；**R5**：写 ADR-0063（提议）：这一行改按物理占用（macOS `phys_footprint`、Windows 私有工作集）测量、预算数值不变，属放宽，等用户决定；在此之前 M3、M4 的这一行仍判为超出；**R5（用户采纳 ADR-0063）**：`app-memory` 与 `perf:m3` 改按物理占用（`scripts/perf/lib.mjs` 的 `appFootprint`），macOS 实测 Nightly 场景 208 MB、3 会话场景最大 264 MB，达标，基线按新口径更新；**已关闭** |
| I27 | T10 | 终端的 L4（`terminal.e2e.ts`、`terminal-tui.e2e.ts`）与 `crates/piarc-term/tests/pty.rs`、`crates/piarc-core/tests/terminal.rs` 使用 `/bin/sh`、`cat`、`vim`、`top`，在 Windows 上不运行；ConPTY 的 resize、Ctrl+C、kill（portable-pty 0.9.0 的 kill 返回值问题由 `wait` 兜底）与是否随附 `conpty.dll`/OpenConsole.exe 未验证 | W0 补 Windows 程序版本的用例并实测 ConPTY；S7 报告第 10 节；**已关闭（R4）**：W0 已补 Windows 程序版本的用例（`pty_windows.rs`、`terminal_windows.rs`）并实测 ConPTY，不随附 `conpty.dll`（S7 第 10 节） |
| I28 | T10 | PTY 子进程由 portable-pty 启动，不经 `ProcessSpawner`，没有进程组或 Job Object：终端里的程序再起的子进程不随终端关闭而结束 | 已落地（T33）：`piarc_exec::TerminalTree`（macOS 按终端设备收集全部进程组，挂断、宽限 2 s 后 `SIGKILL`；Windows 启动后加入 Job Object），关闭终端与有序关闭都等它结束；测试 `crates/piarc-core/tests/terminal.rs`、`terminal_windows.rs` |
| I29 | T10 | `cat` 以约 190 MB/s 输出时主进程 CPU（含 Core 全部线程）约为一个核的 74%，主要是 IO 线程读 PTY 与解析；第 11 章没有对应预算 | T44 把终端吞吐纳入性能回归时评估（例如增大读块、合并读） |
| I30 | T10 | `#/terminal-lab` 原型页随发布构建的渲染包分发；发布构建的 `window.piarc` 也有七个终端函数（`createTerminal` 只能启动登录 shell），与 I13、I24 同类 | T34 接入正式终端面板时收口；T45 与 I13、I24 一起评估剔除原型页；T34 部分落地：`window.piarc` 不再有 `createTerminal`，原型页只能接开发构建测试钩子创建的终端；原型页本身仍随发布构建分发，交 T45 与 I13、I24 一起处理；**已落地（T45）**：原型页随 I13 一起移出发布构建 |
| I31 | T10 | 真实拼音输入法的候选框位置未核对，清单见 `docs/spikes/S07-terminal.md` 第 8 节（T1–T4） | 已落地（2026-11-16）：智能体经 computer-use 在本机用系统"简体拼音"实测，T1–T4 全部符合预期，结果见 S7 报告第 8 节；T10-A11 改为通过 |
| I32 | T10 | T09 的 L4 `transcript-scroll.e2e.ts` 中 "the wheel releases and resumes following" 在一次全量运行中失败（dev 形态，内容增长时离底 31 px，期望 ≤ 1 px），单独重跑 10 次（两种形态各 5 次）都通过；本机此时的主屏是 120 Hz | T19 接手 transcript 时检查贴底在高刷新率下的时序；T44 把 L4 的偶发失败纳入统计；2026-11-16 在 CI 的 `desktop L4 (macos-latest)`（packaged，https://github.com/Refinex-Space/PiArc/actions/runs/43855932047）再次失败，离底同为 31 px；2026-11-18 再次出现在 CI 的 `desktop L4 (macos-latest)`（packaged，"keeps the bottom in view while a reply streams" 离底 21 px，https://github.com/Refinex-Space/PiArc/actions/runs/44214484957），同一提交前一次运行中通过；2026-11-18 第三次出现在 CI 的 `desktop L4 (macos-latest)`（packaged，同一用例离底 32 px，https://github.com/Refinex-Space/PiArc/actions/runs/44255962868）；2026-11-18 第四次（dev，同一用例离底 36 px，https://github.com/Refinex-Space/PiArc/actions/runs/44264407935），macOS CI 已连续三次运行失败，不再是偶发。初步判断（未验证）：贴底只在 sizer 的 ResizeObserver 回调里做，而 sizer 的高度要等虚拟列表测量行高之后的 React 重渲染才更新；浏览器在同一帧内不再投递比上一轮更浅的元素（sizer 是行的父元素），流式行变高的那一帧可能先画出来再贴底。T19 先用 CPU 降速（CDP `Emulation.setCPUThrottlingRate`）在本机稳定复现，再在提交后的布局阶段贴底；**T19 已修复并验证**，行及列表提交后在布局阶段贴底，120 Hz、4 倍 CPU 降速共 1,938 帧最大离底 0 px |
| I33 | T11 | 进程树终止的接口已就绪：`piarc_exec::ProcessTreeSpawner`（`ProcessSpawner` 的实现；macOS 新进程组 + `killpg`，Windows 挂起创建后加入 `KILL_ON_JOB_CLOSE`、不许 breakaway 的 Job 再恢复；`kill` 与丢弃句柄都结束整棵树，丢弃也会结束命令留在后台的进程）。目前只有沙箱会话的 `exec/run` 用它 | 部分落地（T12）：`piarc_core::agent_host::start` 与 `start_bundled` 改用 `ProcessTreeSpawner`（W0 实机核对 Agent Host 被杀时子进程随之结束）；T17 让 `ToolIo` 的普通命令也用它，并决定后台进程在命令结束时是否保留（与 T32 的后台任务一起）。W0 补充：Windows 的 Git Bash 没有真正的 `exec`，命令总是 bash.exe 的子进程，所以现在取消或超时一个委托的 Bash 命令时，命令本身（不只是它的后台进程）都继续运行（`piarc-exec` 的 `cancelling_kills_the_command` 中 `sleep.exe` 活满 30 s），T17 在 Windows 上必须改用 `ProcessTreeSpawner`；**已落地（T17）**：`ToolIo` 的全部命令用它，命令结束时留在后台的进程随之结束（`run_in_background` 由 T32 提供）；Windows 取消与超时结束整棵树由 `piarc-exec` 的终止测试在 Windows CI 上验证 |
| I34 | T11 | 沙箱把 `CARGO_HOME` 指向会话临时目录（防止缓存投毒，S8 报告第 4 节），沙箱内读不到 `~/.cargo/config.toml` 的镜像源设置；每个会话第一次安装或构建是冷缓存 | T39 决定是否把用户的 Cargo 配置（不含凭据）复制进会话，以及是否提供共享只读缓存；**已关闭（T39）**：不复制用户的 Cargo 配置（可能含 registry token），也不提供共享缓存；镜像源由用户在命令环境里设 `CARGO_REGISTRIES_*`，或经沙箱外重试（ADR-0056 第 12 条） |
| I35 | T11 | 沙箱内不能绑定端口、不能连 Unix socket（本地测试服务器、Docker、ssh-agent 不可用），`git init`/`clone`/`config` 因 `.git/config`、`.git/hooks` 受保护而失败；`GIT_CONFIG_COUNT` 被沙箱用来指定代理，命令继承的同类变量失效 | T39 评估"允许本机绑定""允许写 `.git/config`"两个选项与 Unix socket 白名单，设置页写明这些限制；**已关闭（T39）**：不加"允许本机绑定""允许写 `.git/config`"与 Unix socket 白名单，这些限制写在设置页"沙箱"（ADR-0056 第 12 条） |
| I36 | T11 | macOS 的进程组终止不覆盖主动 `setsid`/`setpgid` 的后代：它们仍在沙箱里，但停止命令后会活下来（Windows 的 Job 无此问题） | T17 实现通用进程管理时评估是否需要按后代追踪（例如记录会话内的进程并在停止时扫描） ；R2 保留该限制，T32 后台任务实现时复核脱离进程组的后代清理；**R4**：T32 未改（后台任务仍按进程组结束），限制写在架构 6.3.1；交 T39（macOS 沙箱定稿时评估按后代追踪）；**已关闭（T39）**：脱离进程组的后代仍在沙箱内，停止命令时不追踪，限制保留并写入 ADR-0056 第 12 条与架构 6.10 |
| I37 | T11 | `piarc-exec` 的 Windows 代码（`job.rs` 与 `tree.rs` 的 Windows 部分）只在本机做了类型检查与 lint（用户同意后安装了 `x86_64-pc-windows-msvc` 目标，`cargo clippy --target x86_64-pc-windows-msvc --workspace --all-targets -- -D warnings` 通过），没有运行；同一检查发现 T07 的 `crates/piarc-core/tests/tool_io.rs` 在 Windows 上有两处 `unused_mut`（会让 Windows CI 的 clippy 步骤失败），T11 已修 | 用户推送后由下一个任务的开工检查核对 Windows CI 并关闭 T11-A10；失败时修复后再关闭；**已关闭（R3）**：T11-A10 已为 passing，之后各次 Windows CI 均运行 `piarc-exec` 的 Windows 代码 |
| I38 | T12 | `piarc-term` 的 PTY 用例 `vim_on_the_alternate_screen_matches_the_formatter` 依赖 UTF-8 locale：`LANG` 为空的 shell（本次智能体会话的环境）里 vim 把中文显示成转义，`cargo test`（含 verify）失败；设 `LANG=en_US.UTF-8` 后通过 | 已落地（2026-11-16）：`pty.rs`、`pty_windows.rs` 与 L4 `terminal-tui.e2e.ts` 的 vim 都加 `--cmd 'set encoding=utf-8'`，在读文件之前固定编码；Windows CI 的 `verify`、`desktop L4` 因此失败过（运行 43855932047），根 `CLAUDE.md` 易错点已改写 |
| I39 | T12 | 内置 node 保留 Node.js 官方签名（ADR-0018），其 entitlements 含 `get-task-allow` 与 `allow-dyld-environment-variables`：同一用户的进程可以调试附加 Agent Host，读到 Core 交给它的凭据（PiArc 自身已用 hardened runtime 挡住注入，S6 报告第 3 节）。Core 以最小环境启动 node，不传 `DYLD_*` | T45 评估（例如凭据只在用时经 AHP 取、缩短驻留时间，或重新评估是否对 node 重签去掉 `get-task-allow`，后者涉及 ADR-0018，属变更型）；**T45 评估**：维持已接受风险（威胁映射 THR-14，ADR-0018）。按需取凭据、缩短驻留要改 ADR-0021 的适配层（每次请求向 Core 取），收益有限：能调试附加 Agent Host 的同用户进程已能读取用户的其他一切；去掉 `get-task-allow` 要重签 node，与 ADR-0018 冲突 |
| I40 | T12 | 在 Agent Host 的宽松 Seatbelt 下，`npx <本地目录>` 形式的 MCP server 启动失败：npm 链接目录后 `chmod` 其 bin，文件在可写目录之外（`EPERM`）。registry 包（tarball）不受影响 | T36 接入 MCP 配置时给出明确错误提示或改用 `npm pack` 后的路径；T39 定稿 Agent Host 配置时一并评估；**已落地（T36）**：`npx` 拉起的 server 因 Seatbelt 以 `EPERM` 失败时，连接错误提示改用 registry 包或 `npm pack` 后的 tarball（`agent-host/src/mcp/connection.ts`）；L4 `agent-host.e2e.ts` 与 `sessions mcp::an_npx_server_runs_on_the_agent_hosts_node_without_a_system_node` 用 tarball 经内置 npx 启动；Agent Host 配置的定稿仍在 T39；**T39**：Agent Host 定稿配置下 tarball 与 registry 包经内置 npx 启动可用，`npx <本地目录>` 仍因 chmod 被拒，维持 T36 的提示（ADR-0056 第 12 条） |
| I41 | T12 | macOS arm64 安装后体积 449.0 MB，预算 450 MB 只余约 1 MB（内置 node 145 MiB、Electron Framework 250 MiB）；任何新增随包内容都会超出 | R1 决定：校准预算（写明原因）或裁剪（npm 的 docs/man 约 3.2 MiB、压缩 bundle 等），T44 把体积纳入回归；R1 决定：不放宽，T44 裁剪（npm 文档与 man 页等），R5 复核；**T44**：发布构建安装后 466.3 MB（Core 的 `.node` 37.5 MB、Agent Host bundle 16.5 MB 都比 M0 大）；`apps/desktop/packaging/trim.mjs` 去掉 npm 的 docs 与 man、Electron 中英文以外的语言包，并 strip 发布构建 Core 的本地符号 |
| I42 | T12 | S6 中 Gatekeeper 开启时的首次打开没有验证："仍要打开"是否出现、`xattr -dr com.apple.quarantine` 备选、Gatekeeper 是否单独拦截内置 node（以及带隔离属性的 rg、fd）。用户的 Mac（macOS 26.5.2）`spctl --status` 为 `assessments disabled`，从 `127.0.0.1` 经 Safari 下载的 DMG 也没有 `com.apple.quarantine`；没有 macOS 15 设备。检查清单与 `scripts/dev/s6-probe.mjs` 可直接复用 | R1 汇总 M0 时安排：在开着 Gatekeeper 的 Mac（26 与 15）上、用从 GitHub 等外部地址下载的 DMG 重做检查清单第 2、3 项；最晚 T50 首次发布前完成，结果补进 S6 报告；R1：T50 首次发布前在开启 Gatekeeper 的 Mac（26 与 15）上完成，R6 检查 |
| I43 | T12 | ad-hoc 签名的 PiArc 的系统通知可用（允许后横幅显示，实机确认），但用户未允许通知时 Electron 仍发 `show`、不发 `failed`（Windows 上不同：系统拒绝时 `show` 之后再发 `failed`，W0），程序侧事件不能用来决定是否退回应用内提醒；另外应用退出时 Electron 删除已投递的通知，通知中心里的条目随之消失 | T18/T35 做系统通知时：通知之外总给应用内提醒与 Dock 角标，或经原生模块读取 `UNUserNotificationCenter` 的授权设置；T35 的后台运行设计考虑通知随应用退出被删除；**T18 部分已落地**（ADR-0029）：会话需要处理时总给应用内提醒与 Dock 弹跳（Windows 闪烁任务栏），窗口不在前台且通知开启时另发系统通知，计数显示在 Dock 角标；关闭窗口后的后台运行与通知随应用退出被删除仍交 T35；T35：关闭最后一个窗口后应用常驻菜单栏 / 托盘，只在用户从菜单或托盘退出时退出，通知随应用退出被删除的影响随之变小 |
| I44 | W0 | Windows 上两项测量的口径失效：①`monitorEventLoopDelay` 受约 15.6 ms 的计时器粒度支配，空闲 Node 就是 p99 16.58 ms，S2 满载原始 p99 16.81 ms（W0-A04 按原始值未达标）；②终端回显的配对相减被 ConPTY 两次独立往返的 0–16 ms 抖动淹没，均值 −0.12 ms 而 p95 6.86 ms（W0-A10）。预算未改 | R1 校准 Windows 的测量方法（扣除同机空闲基线，或改测回调执行时长、在 Core 内分段打点），再据此改判 W0-A04、A10；已落地（R1）：口径校准写入第 11 章（Windows 事件循环取超出同机空闲基线的部分，回显取两组样本 p95 之差），按此 W0-A04 为 0.23 ms、W0-A10 为 −0.85 ms；用户在 R1 中授权改判，W0-A04、A10 改为通过，W0 改为已完成；W1 按新口径复测 |
| I45 | W0 | Windows 体积超预算：CI 的 `Setup.exe`（开发构建）225.3 MB > 200 MB；本机发布构建打包目录 516.4 MB > 450 MB（Electron 本体约 360 MiB、内置 node 约 102 MiB），安装后体积见 S6 第 9 节 | R1 与 I41 一起决定（裁剪 locales、校准 Windows 预算等），T44 纳入回归；R1 决定：不放宽，T44 裁剪（locales、单架构安装包、`dxcompiler.dll` 是否需要），R5 复核 |
| I46 | W0 | Windows 上 Node 写管道式 stdout 是同步的：Core 停止读取时 Agent Host 整个事件循环停住，连 Core 发来的请求（中断、关闭）也处理不了，直到 Core 恢复读取；macOS 上它会继续在内存里排队 | T14 的事件消费者持续取走事件（同 I19）；R1 评估是否需要让 Agent Host 的 AHP 写入在 Windows 上异步（例如单独的管道而不是 fd 1）；R1：同 I19，T14 持续消费，不改 Windows 上的写入方式；已落地（T14）：同 I19 |
| I47 | W0 | win32-arm64 上 libghostty-vt 的实际运行尚无结果：CI 只做过加载，W0 给 `core-load-check.mjs` 加了终端检查，要下一次推送后的 `core-load`（`windows-11-arm`）才有结果 | 已落地（2026-11-16）：提交 3ae1d23 的 CI（https://github.com/Refinex-Space/PiArc/actions/runs/43855932047）中 `core load (aarch64-pc-windows-msvc)` 通过，node 24.22.2 与 Electron 45.3.2 的开发版、发布版都报 `terminal ok` |
| I48 | W0 | 主进程没有按架构第 9.1 节用 `app.setPath('userData', …)` 固定数据目录：Windows 上 Electron 默认把 userData（Chromium 缓存、本地存储）放在漫游的 `%APPDATA%\PiArc\`，卸载后留在那里（实测 71 个文件 9.5 MiB）；macOS 的默认位置恰好与架构一致 | T13 设定数据目录时一并设 `userData`；T50 决定卸载时是否提供删除数据的选项；已落地（T13）：`apps/desktop/src/main/platform/data-dirs.ts` 在 `ready` 前把 `userData` 设为 `%LOCALAPPDATA%\PiArc\`、`sessionData` 设为其下 `Cache\Chromium\`（Windows 上待 CI 确认，T13-A02）；卸载选项仍交 T50 |
| I49 | W0 | Windows 上 SmartScreen 的"更多信息 → 仍要运行"流程没有观察到：W0 的机器关着"检查应用和文件"（安装包带 `ZoneId=3`，没有拦截），智能应用控制也是关的；系统通知总开关关闭，横幅也没看到（程序侧正确收到 `failed`） | R1 与 I42 一起安排：在开着"检查应用和文件"与通知的 Windows 11 上，用浏览器下载的安装包重做 S6 检查清单第 8 节 W3 与通知；最晚 T50 首次发布前；R1：T50 首次发布前，与 I42 一起，R6 检查 |
| I50 | R1 | 渲染进程没有 React 错误边界：任何一个组件抛错都会卸载整个 root（R1-E1 的后果） | T19 给 transcript 行与整页加错误边界，单条内容出错只影响该行；**T19 已落地**，RowBoundary 和 PageBoundary 的组件测试覆盖单行与整页异常隔离 |
| I51 | R1 | 终端是页面可调用的命令执行通道：`createTerminal` + `terminalInput` 不经 Core 权限裁决，与架构第 10.3 节"有副作用的操作仍要经 Core 的权限裁决"不一致；每窗口终端数与在途拉帧请求没有上限（R1-E3、E6）。发布构建现在也带着原型终端的函数（I30） | T34 决定防线（例如要求近期真实用户输入）与上限并写入 10.3；若以文档例外接受，属于放松安全基线，写 ADR 提议。T34 之前 T45 与 I30 一起评估发布构建去掉终端函数；已落地（T34，ADR-0051）：会话终端归会话；终端的写入、打开与共享要求窗口 5 秒内有 Electron 报告的真实输入（`input-event`），每会话至多 16 个终端、每窗口每终端一个在途拉帧，写入第 10.3 节 |
| I52 | R1 | ESLint 进程边界规则只拦 `ipcMain.<method>`，不拦 `webContents.ipc` 与别名；导航守卫没有 `will-frame-navigate`（当前由 CSP 挡住）；渲染进程规则拦不住 Node 专用 npm 包（R1-E7、Q12） | T45 补规则与守卫，S10 第 13、17 项的措辞改准；**已落地（T45）**：ESLint 另拒绝 `webContents.ipc`、`ipcMain` 的别名与 `electron.ipcMain`；导航守卫加 `will-frame-navigate`；S10 第 13、17 项改准。渲染进程的 Node 专用包：内置模块的入口已按名字禁止，依赖它们的包在沙箱渲染进程里打包或运行即失败，不另加规则 |
| I53 | R1 | `piarc_fs::read_blob` 把整个文件读进 Core 所在的主进程内存，没有大小上限（R1-C1） | T16 给 blob 模式设上限并流式写入；已落地（T16）：超过 32 MiB（`MAX_BLOB_BYTES`）报 `EFBIG`，边读边算哈希写入临时文件再 rename，不再整文件进内存（`crates/piarc-fs/src/content.rs`）；PDF 同样受这个上限 |
| I54 | R1 | 沙箱代理：accept 失败（EMFILE）立即重试空转，没有连接数上限与读头、空闲、上游 connect 超时；地址黑名单不含私网、CGNAT、ULA；明文 HTTP 转发保留客户端的 `Host`（R1-C3、C10） | T39 定稿代理时处理，或在 6.10 写明不防的范围；**已落地（T39）**：连接上限 256、读请求头与连上游各 30 秒、隧道空闲 10 分钟、accept 失败退避、转发的 `Host` 改为目标主机（`crates/piarc-sandbox/tests/proxy.rs`）；私网地址不拦，理由写在 ADR-0056 第 10 条与架构 6.10 |
| I55 | R1 | 终端：`createTerminal` 在主进程 JS 线程同步 `openpty` 与 spawn（未测耗时，违反 7.2 的 1 ms 预算）；IO、写入、等待线程与取帧等 `spawn_blocking` 回调没有 panic 防护；IO 线程把 `Interrupted` 当作输出结束；查询应答队列无界且与按键共用写线程（R1-C4–C7） | T33（`spawn_blocking` 回调 panic 时以带 `kind` 的错误结算 Promise 一项 T14 一并处理）；T14 已落地其中一项：`crates/piarc-core/src/terminal.rs` 的 `guarded` 把 `spawn_blocking` 回调的 panic 结算为 `internalError`（测试同文件）；其余已落地（T33）：`createTerminal` 在阻塞线程池上启动并返回 Promise，IO/写/等待线程包在 `piarc_term::session::threads::guarded` 里（panic 变成 `failed` 事件），`Interrupted` 重试，写队列有界（`WRITER_QUEUE` 256，满时 `busy`；查询应答仍经同一个写线程以保持与输入的顺序） |
| I56 | R1 | 执行路径：`exec_run` 在 `sandbox.launch()` 失败时遗留 `running` 条目；`exec/kill` 与 `exec/run` 分在两个任务处理，kill 先到会丢失中断；`Tree::kill` 在 leader 被回收后仍用旧 pgid（R1-C8、C11、A11、A15） | T17 重写执行路径时一并处理，补可注入失败的测试；**R4 复核**：沙箱包装失败时的 `running` 条目已清理（`exec_run`）；`exec/kill` 早于 `exec/run` 登记时仍答 `killed: false`、leader 回收后的 pgid 未复核，交 T45；**T45 评估，交 R5**：执行路径的正确性（不是威胁映射的对策）；R5 写可注入失败的测试后修；**R5**：仍未处理，交 T48（执行路径：`exec/kill` 早于 `exec/run` 登记、leader 回收后的 pgid），先写可注入失败的测试；进入 R6 前完成 |
| I57 | R1 | 凭据：锁的解锁与带 `lockId` 的写入不校验持有者连接；30 s 租约不续期，OAuth 刷新加钥匙串弹窗超过租约时，轮换后的 refresh token 只留在内存；服务商错误原文经 `errorMessage` 进入日志与界面，是否可能回显密钥未核实（R1-C9、A5、A15） | T21（与 I23 一起）；日志脱敏覆盖 `errorMessage` 由 T45 验证；T21 已绑定持锁连接并为长操作续约，已检查和脱敏服务商响应里的凭据回显；T45 复核全链路日志；**已落地（T45）**：日志写入时统一脱敏（`piarc_telemetry::redact`：保险箱里的值与常见密钥格式），覆盖经 tracing 的任何文本（含 `errorMessage`）与 Agent Host 的 stderr；`crates/piarc-testkit/tests/credential_leaks.rs` 注入已知密钥后扫描日志与数据目录 |
| I58 | R1 | AHP 会话层：`session/create`、`session/resume` 超时后两端状态不一致；恢复循环在 `select!` 之外串行执行，挂住时不响应关闭与 Kill；Agent Host 出站帧没有单帧上限（可能超过 Core 的 8 MiB）；被拒或未完成握手的连接仍分派请求；命令通道的 `Kill` 不带 epoch；`ToolIo` 的会话表不绑定连接；入站请求任务数无上界；同 id 的并发 `session/resume` 会建两个运行时（R1-A3、A4、A6、A7、A10、A13、A14、A15） | T14 接手会话编排时处理，补故障注入用例；已落地（T14）：`piarc-host` 跟踪带 Core 选定 id 的创建与恢复并在结果未知时以 `session/resume` 对账（A3）、恢复在命令循环的 `select` 里（A4）、`Kill` 带 epoch（A10）、握手前与被拒的连接不分派请求（A7）、入站并发上限 256（A14），故障注入用例在 `crates/piarc-host/tests/resilience.rs`；Agent Host 出站单帧上限（A6，`agent-host/src/protocol/outbound.ts`）、并发 `session/resume` 去重（A15，`session-registry.ts`）；`ToolIo` 的会话按工作区绑定（A13，`crates/piarc-core/src/sessions/inbound.rs`） |
| I59 | R1 | 测试用固定时长等待异步结果：`transcript-scroll.e2e.ts`（与 I32 的偶发失败位置一致）、`terminal.e2e.ts`、`e2e/terminal.ts`、`e2e/core.ts`、`agent-host/src/runtime/credentials.test.ts`（R1-Q3） | T19 改 transcript 用例并关闭 I32；T34 改终端用例；T21 改凭据测试；**T19 已完成 transcript 部分**，等待实际滚动、条目增长与跟随状态；T21 将凭据测试中的固定断言等待替换为实际请求或缓存值的等待；T34 检查了终端用例：等待异步结果的地方都是轮询条件（`waitForScreen`、`waitForPanel`、`settledPanel`、等光标停止），剩下的固定时长只用于"一段时间内没有拉帧"的反向断言与让在途请求落地（`terminal.e2e.ts`、`t34-terminal-tui.e2e.ts`）；**已关闭（R4）**：T21 的凭据测试剩下的 `setTimeout` 都在桩函数里模拟刷新耗时，不是等待异步结果 |
| I60 | R1 | 测试与脚本：CI 没设 `PIARC_REQUIRE_KEYCHAIN`，凭据库测试在 CI 上可能只是 NOT RUN（`system_store.rs` 的 `let _ = tx.send` 也缺注释）；基准脚本复制了 `e2e/app.ts` 的应用定位逻辑；`fetch-binaries.mjs` 的完整性校验与若干脚本没有单元测试（R1-Q2、Q4、Q7） | T44 决定 CI 的凭据库测试并让基准复用 `e2e/app.ts`；T50 给 `fetch-binaries.mjs` 补测试 |
| I61 | R1 | `piarc-exec` 没有带 `kind()`、`retryable()` 的 `Error`，直接返回 `io::Result`；`piarc-ports` 的 `SecretStoreError` 同样没有（只放 trait，可豁免）（R1-Q5） | T17 定义 `piarc-exec::Error`，并把 `piarc-ports` 的豁免写进 `coding-standards.md` 2.3 ；R2 已修复管道读取失败的错误传播（ee48bc0）。T32 接入后台任务时统一前后台命令错误的 kind 与 retryable；**R4**：`piarc-exec` 仍没有错误枚举，并入 I173（T39）；**已关闭（T39）**：`piarc_exec::Error` 落地（75ad53c，见 I173） |
| I62 | T13 | 生产路径上还没有调用方：`agent_host::restart_on_trust_change`（信任变化重启工作区的 Agent Host）、`CoreRuntime::open_settings`（工作区设置与 `core/settings` 事件）、运行中会话文件的增量索引同步（`Storage::sync_sessions`）都只由测试驱动，启动时只做一次索引同步 | T14 的工作区 actor 打开工作区时启动这三项，会话文件变化（或回合结束）时触发增量同步；已落地（T14）：工作区 actor 打开时启动设置监听与信任变化重启，每个回合结束后增量同步会话索引（`crates/piarc-core/src/sessions/workspace.rs`、`session.rs`） |
| I63 | T13 | 信任后新增的可执行项（`TrustView.newItems`）在再次确认之前已经生效：`trust/get` 只看决定，不看快照；例如 `git pull` 带来的新 hooks 会在下一次重启后加载 | T18 的对话框接入时决定闸门：新增项未确认前 `trust/get` 返回不信任，或各消费者只启用快照内的条目；若改变 `trust/get` 语义，按协议同主版本内新增可选成员；**已落地（T18，ADR-0029）**：有快照之外的新增项时 `trust/get` 与信任视图都答不信任，客户端只列新增项请用户确认；测试 `crates/piarc-core/tests/state.rs`、L4 `t18-trust.e2e.ts` |
| I64 | T13 | 日志按 UTC 日期分文件（`piarc-telemetry`，没有引入时区库）：东八区用户的"某天的日志"跨两个文件 | T45（诊断包）评估是否改为本地日期，改动只在 `rotation::Day::of`；**T45 评估**：维持 UTC：诊断包带上保留期内的全部日志文件，跨文件不影响；改本地日期要处理时区与夏令时变化的边界，收益不抵 |
| I65 | T13 | 新增的 Windows 首次运行项未在 Windows 上执行过：真实 git 夹具（`piarc-git`、`piarc-core --test state`）、notify 的 `ReadDirectoryChangesW` 监听、bundled SQLite 的 MSVC 编译、`data-dirs.ts` 的 win32 分支 | 推送后看 Windows CI；失败时由下一个任务开工检查按协议处理（T13-A02 为 blocked）；已确认（T14 开工检查，运行 43879135441）：Windows 上 `cargo test`（真实 git 夹具、notify、bundled SQLite 的 MSVC 编译）与 `data-dirs.test.ts` 通过，唯一失败见 I66；**已关闭（R4）**：T14 开工检查已确认，I66 另行关闭 |
| I66 | T14 开工检查 | Windows CI（运行 43879135441）中 `core.integration.test.ts` 的 T13 用例清理临时目录时 EPERM：`CoreRuntime.shutdown()` 之后 Core 仍持有数据目录里的文件（数据库连接随 NAPI 对象存活到 GC），Windows 不能删除打开的文件；macOS 上不报错。同一运行的 `cargo test`、`data-dirs.test.ts` 与 Windows L4 均通过 | T14：有序关闭最后一步关闭数据库，补测试；推送后看 Windows CI；已落地（T14，提交 8a95b84）：有序关闭最后关闭数据库（`Storage::close`），测试 `crates/piarc-core/tests/state.rs` 与 `apps/desktop/src/main/core/core.integration.test.ts`；Windows CI 尚未运行（推送后看）；**已关闭（R3）**：此后 Windows CI 多次运行 `core.integration.test.ts`（最近一次运行 44542131720 通过） |
| I67 | T14 | 回合以失败（非中断）结束时不补中断标记：pi-ai 丢弃出错的 assistant 消息，下一条输入会紧跟上一条 user 消息（Anthropic API 合并，严格 mock 的 `role_order` 拒绝）。中断的回合已由 ADR-0026 补齐 | T27 与压缩、中断标记一起决定失败回合的对话形态；T27 决定保持（ADR-0043 第 11 条）：失败的请求没有 assistant 内容，两家线格式都接受相邻的 user 消息，压缩的切点不落在工具调用与结果之间；含失败回合的场景关闭 `role_order`；**已关闭（R4）**：T27 已决定（ADR-0043 第 11 条） |
| I68 | T14 | 实时条目与历史条目的 id 不同：文本与 reasoning 实时为 `<投影器生成的 messageId>#<序号>`，历史为 `<entry id>#<序号>`；用户消息实时为 `<turnId>:user:<n>`，历史为 entry id；工具调用两边相同（`agent-host/CLAUDE.md`）。客户端不能按 id 把重新加载的窗口与流式条目合并 | T19 的 transcript 重载以 `transcript_window` 整段替换，或由 T19 决定在 `turn/completed` 后补发 entry id 的映射；**T19 已落地**，重同步整窗替换，历史条目携带可选 turnId |
| I69 | T15 | L2 运行器还没有审批请求的观测点：T20 之前 Core 不发审批请求，场景声明的 `approvals` 一律判失败（`piarc_testkit::l2::runner` 的 `assert_all`）。审批落地后场景要能按顺序应答审批，并在请求没被应答或应答没被用上时失败 | T20 经 Core 的公开接口（事件或回调）把审批请求交给运行器，改 `runner.rs` 与 `testing.md` 第 12.3 节，把审批场景写成 L2；**T20 已落地**，运行器按快照顺序应答，检查应答数量、工具名与待审数量 |
| I70 | T16 开工检查 | T15 推送后的 CI 运行 44031571343（T14 的运行 44021743399 已出现）：① Windows `cargo test` 中 `tests/sessions/lifecycle.rs` 用 `canonicalize` 的结果（带 `\\?\` 前缀）与 Core 报告的工作区路径比较，永远找不到工作区；② 两个平台 L4 的 `agent-host.e2e.ts` 仍按 T14 之前的条目类型筛选（Bash 与 MCP 调用已改为 `commandExecution`、`mcpToolCall`）。都是测试缺陷，产品行为无误 | 已落地（T16）：比较前去掉 `\\?\` 前缀；L4 按条目的 `tool` 字段筛选并断言各自的条目类型；CI 运行 44069688031 确认：Windows 的 `lifecycle` 测试与两个平台 L4 的 `agent-host.e2e.ts` 均通过 |
| I71 | T16 | PDF 文本用 lopdf 0.46 的 `extract_text`：资源以内联字典写在页树节点上（被页面继承）时取不到文字，空格与换行也不如 `pdf-extract`；`pdf-extract` 0.12 锁 lopdf 0.42，引入已停止维护的 `ttf-parser`（RUSTSEC-2026-0192），cargo-deny 拒绝 | 有服务商原生 PDF 输入的任务（T29 模型设置或 M2 之后）评估把 PDF 作为文档块交给支持的模型；`pdf-extract` 升级到新 lopdf 后换回（ADR-0027 触发条件）；T29 复核：锁定的 pi-ai 1.5.2 的 `UserMessage.content` 仍只接受文本与图像块，没有把 PDF 作为文档块交给服务商的入口，保持现状；**R4**：锁定的 pi-ai 1.5.2 仍不接受文档块，交 T48（Pi 升级或服务商文档输入时复核） |
| I72 | T16 | 重复读取的存根依赖"上一次 Read 的结果还在上下文里"：压缩（T27）删掉旧结果后，存根会指向模型已经看不到的内容 | T27 在压缩完成时清掉会话状态表里的读取范围（保留哈希，先读后改仍然成立），在 `piarc_fs::FileStates` 上加一个方法并经 AHP 或会话层调用；已落地（T27）：`piarc_fs::FileStates::forget_read_ranges`，压缩完成时 Agent Host 发 `fs/forgetReads`（`crates/piarc-core/tests/file_invariants.rs` 的 `external_changes_and_forgotten_reads`） |
| I73 | T16 | 子 agent（T31）在 Agent Host 进程内运行，若沿用父会话的 `sessionId` 调 `fs/*`，读取会记在父会话的状态表里 | T31 给子 agent 的工具调用一个自己的会话 id，并在 Core 以同一工作区 `ToolIo::open_session` 登记（各自一张状态表），或在 `fs/*` 请求上加子 agent 标识；**已落地（T31）**：子会话经 AHP `subagent/start` 以自己的会话 id 在 Core 登记（`ToolIo::open_linked`，各自一张文件状态表，ADR-0048） |
| I74 | T16 | 工具结果阈值（50K、200K、预览 2K）集中在 `TOOL_RESULT_LIMITS` 并可经注册表选项覆盖，但没有用户可改的设置项；Bash 的内联上限（6.11 的 30K）尚未接入 | T17 接 Bash 输出落盘时复用 `fs/spill` 与同一位置；是否开放为用户设置由 T24 的配置兼容层决定；**已落地（T17）**：Bash 的输出预算在 Core（`piarc_exec::ExecLimits`，内联 30,000、预览 2,000、失败头尾），全文写在同一目录（`piarc_fs::create_spill`，`tool-results/<工具调用 id>.txt`）；用户设置仍由 T24 决定 |
| I75 | T17 | PowerShell 命令在会话的 shell 目录中执行，但 `Set-Location` 不跨命令保留（只有 bash 带目录探针，ADR-0028）；PowerShell 的前缀独占一行，错误信息中的行号比用户命令多 1 | W1 在 Windows 实机看是否影响使用；需要时为 PowerShell 加 `try/finally` 包装的目录探针；W1：验收流程中未造成问题，保留；**已关闭（R4）**：W1、W2 实机均未造成问题，限制保留并写在 ADR-0028 |
| I76 | T17 | Core 在 `core/notices` 发 `gitBashMissing`（Windows 缺 Git Bash 时），客户端还没有显示它；`commandExecution.execution`（bash 卡数据）也还没有界面 | T18 显示 `core/notices`（含下载链接），T19 用 `execution` 画 bash 卡；**T18 已落地 `core/notices` 的显示**（主区顶部的提示条，带下载按钮，经外链确认打开）；bash 卡仍交 T19；**T19 已落地**，BashCard 展示 execution 字段 |
| I77 | T17 | 登录 shell 的环境在每个 Core 第一次执行命令时解析（`$SHELL -i -l -c`，最多 10 s）：用户配置很重时第一条命令会多等这段时间；解析失败只记警告并退回 Core 的环境 | T44 的性能任务测启动后首条命令的耗时，必要时改为 Core 启动后后台预解析；设置诊断（T40）显示解析失败的原因 |
| I78 | T17 | 语义退出码只认单个简单命令：`cd src && grep x f` 这类常见写法按退出码判失败（ADR-0028 第 1 条） | T23 用 tree-sitter-bash 的语法树判定最后执行的命令后细化；**T23 未处理**（任务范围不含退出码），`piarc_policy::bash::analyze` 已可给出各子命令，交 T30 或 T48 细化（`&&` 链中前段的退出码 1 也可能来自 `cd`，需要按执行顺序判断）；**R3 指定 T32**：T32 统一前后台命令的结果与退出码时按 `piarc_policy::bash::analyze` 的执行顺序判断最后执行的命令 |
| I79 | T18 | 信任决定（`decideProjectTrust`）由渲染进程发出、没有主进程的原生确认：渲染进程被注入时可以静默信任项目、启用其 hooks 与 MCP。审批卡（T20）同样在渲染进程作答；第 10.3 节只要求"总是允许"类规则的修改走原生确认 | T45 评估信任决定是否也走主进程原生确认（ADR-0029 备选方案）；**T45 评估，交 R5 由用户决定**：残余风险是渲染进程被注入后能静默信任项目、启用其 hooks 与 MCP；现有防线是渲染进程加固（CSP、无 HTML 入口、XSS 载荷在全部渲染面的测试、畸形 IPC 参数测试）。可选做法：对"信任"（不含"暂不信任"）弹主进程原生确认，列出可执行项的类别与数量；代价是每个新工作区多一次确认，并改变 ADR-0029 记录的决定，建议 R5 写 ADR 提议请用户决定；**R5**：写 ADR-0064（提议）："信任"经主进程原生确认（安全审查 S3 独立得出同一结论），等用户决定；采纳后由 M5 的第一个任务或单独小任务实现；**R5**：用户采纳 ADR-0064，实现登记 I223 |
| I80 | T18 | 信任变化只重启 Hub 路由表里已有的工作区：工作区刚打开、Agent Host 已启动但还没登记进路由表的极短窗口内做出的决定，不会让它重启（新进程启动时自己查信任，只有那一刻之前已经查过的进程会沿用旧答案） | R2 核实 workspace actor 在路由登记前开始预热。T35 在多窗口验收中验证并消除这一窗口，重启须覆盖已开始预热的工作区；**已落地（T35）**：`Hub::trust_changed` 记下变化的 checkout 与代次，`Hub::workspace` 登记新开的工作区后补发它打开期间漏掉的变化（`crates/piarc-core/src/sessions/mod.rs`，单测 `a_workspace_opening_sees_the_trust_changes_after_it_started`） |
| I81 | T18 | `crates/piarc-core/src/runtime.rs` 已超过 1,000 行（T17 时 1,080 行，T18 增加会话元数据、客户端设置与信任重启的薄包装后约 1,150 行），超出 `coding-standards.md` 的单文件上限 | R2 已拆分 runtime/state.rs 与 runtime/sessions.rs，runtime.rs 808 行（b426028）；**已关闭（R4）**：R2 已拆分 |
| I82 | T23 | 按参数匹配的规则（`Agent(model:opus)`、`Bash(run_in_background:true)`）没有实现：现在分别解析为 Agent 类型名与命令模式，永不匹配，deny 意图会落空 | T31 接入 Agent 工具时按 Claude Code 语义实现（只用于 deny/ask，不匹配主内容字段），并在设置页标出；**已落地（T31）**：`piarc_policy::rules::Spec::Param`（`param_keys` 表）与 Core 的 `assess::param_rules`，只用于 deny/ask，设置页经 `check_rule` 的 `parameter` 标出（ADR-0048 第 12 条） |
| I83 | T23 | PowerShell 只做整条匹配与粗分段（不解析 AST、不规范化别名，`Get-ChildItem` 规则不覆盖 `gci`）；Windows 上 PowerShell 没有只读白名单 | M4 评估 PowerShell 语法级分析（架构第 6.2.2 节），同时决定别名表；**R3 指定 T45**（M4，与 W3 在 Windows 上核对）；**T45 评估，交 W3/T48**：PowerShell 语法级分析要解析器与 Windows 实机核对，不在安全收口内新增 |
| I84 | T23 | Windows 上只读白名单与文件命令的自动允许依赖 Git Bash 探测（`usr/bin`、`mingw64/bin` 中的同名程序），macOS 只能交叉 clippy；`perm-read-only` 等场景在 Windows CI 首次运行 | W1 在 Windows 11 上核对探测结果、钉住与 `perm-*` 场景，必要时调整 `PROGRAMS`/`WRAPPED`；**CI 已核对**：运行 44522160246 的 Windows L2 `perm-read-only`、`perm-powershell-whole` 通过，实机核对仍留给 W2；**已关闭（R4）**：W2 实机核对并修复（F2、F3：探测不缓存失败、`ucrt64`、提速） |
| I85 | T23 | T20 时期"总是允许"为 Write 保存的 `Write(路径)` 规则在 T23 语义下不匹配（Claude Code 只认 `Edit(路径)`）；现有用户文件里的这类规则会被设置页列出但不起作用 | T24 的配置诊断提示改写为 `Edit(…)`；正式发布前的用户数据只有测试数据，不做迁移；**已落地（T24）**：权限页对 `Write(…)`、`NotebookEdit(…)`、`Glob(…)`、`Grep(…)` 规则显示"永不匹配，请改写为 Edit(…)/Read(…)"（`settings_view::check_rule` 的 `suggestion`，L4 `t24-diagnostics.e2e.ts`） |
| I86 | T24 | `~/.claude/` 不存在时设置监听退到最近的已存在祖先（通常是家目录本身，非递归）：家目录里任何文件的变化都会触发一次去抖后的七层重读 | T44 测量空闲时的重读频率；需要时改为只在 `.claude` 条目出现时重读 |
| I87 | T24 | 键映射表（`piarc_config::claude::SETTINGS_KEYS`）是 2026-11-18 官方 settings 索引的快照；Claude Code 新增的键在更新表之前按"未知"列为忽略 | 各评审任务对照官方索引复查一次；实现对应功能的任务（ADR-0038 后果一节列出）把行改为生效；**R3 未复查**（需联网对照官方 settings 索引）：交 R4 复查，T41 的配置诊断完善时同步表格 |
| I88 | T24 | `crates/piarc-testkit/src/l2/runner.rs` 在 T24 之前已超过 1,000 行（1,070），T24 加入 `.claude` 快照比对与诊断断言后约 1,110 行，超出 `coding-standards.md` 的单文件上限；T25 加入 `rejected`、`core/notices` 事件与 `json_lines` 后 runner.rs 1,151 行、`format.rs` 1,004 行 | R3 把运行器按驱动、断言、Core 调用拆成子模块，`format.rs` 一并拆分；T26 的新格式放进 `l2/harness_spec.rs` 与 `l2/runner/harness.rs`，`runner.rs` 仍增至约 1,170 行、`format.rs` 1,035 行；T28 的新格式放进 `l2/checkpoint_spec.rs` 与 `l2/runner/checkpoints.rs`，`runner.rs` 1,177 行、`format.rs` 1,121 行（新动作的分派与校验）；**已落地（R3，e264e05）**：运行器拆出 `runner/settings.rs`、`approvals.rs`、`asserts.rs`（runner.rs 976 行），引用检查拆到 `format/refs.rs`（format.rs 878 行），`check_actions` 拆为标签与引用两步、去掉 `too_many_lines` 豁免 |
| I89 | T25 | `agent-host/AGENTS.md`（126 行）与 `crates/piarc-core/AGENTS.md`（128 行）超过子目录 120 行上限（T25 之前已是 121、123 行），T25 各加了一节 hooks | R3 精简两份文件，把能从代码或 ADR 得到的段落改为链接；T26 各加一节宿主工具后为 133、131 行；**已落地（R3，60eaf18）**：按任务分节的说明并入 `agent-host/src/harness`、`providers`、`tools` 的 AGENTS.md（agent-host 72 行） |
| I90 | T25 | 没有配置 hooks 时，每次工具结果、回合结束、会话打开、压缩仍各有一次 `hooks/run` 往返，Core 每次重读设置文件判断有无 handler | T44 测量对工具密集回合的影响；需要时 Core 在 `hooks/run` 结果里给出配置了 handler 的事件，Agent Host 缓存到设置变化 |
| I91 | T25 | hook 的审计记录（`audit_events`，`kind: "hook"`）没有界面：权限页的审计视图只查 `kind: "permission"` | T41（配置诊断完善）或 T45（诊断包）提供查看；**T45 评估，交 T48**：诊断包不含审计（审计记录含命令文本与路径，属会话内容）；hook 审计的查看并入权限页审计的类别筛选 |
| I92 | T25 | PreCompact 带摘要指令时 Agent Host 用 Pi 导出的 `compact()` 自己生成摘要，绕过 Pi 默认路径中的虚拟模型路由与重试回调（Pi 1.5.2 不回读 `customInstructions`） | T27 接管压缩时复核；Pi 支持回读后改回默认路径；已落地（T27）：所有压缩都由 Harness Kit 发自写摘要请求（`agent-host/src/harness/compaction.ts`），按会话的重试设置用 `retryAssistantCall` 重试；PiArc 的模型列表没有虚拟模型，摘要请求走会话所选模型 |
| I93 | T25 | hook 命令只继承 ADR-0035 准入的环境加 `CLAUDE_PROJECT_DIR`，与 Claude Code 继承完整环境不同：依赖自定义变量（通知 webhook 地址、令牌）的 hook 拿不到它们 | R3 请用户决定是否增加用户级的 hooks 环境变量白名单设置；**R3：等待用户决定**（见 R3 评审结论）；在用户决定前保持 ADR-0035 的准入环境；**用户决定（R3）**：增加用户级的 hooks 环境变量白名单设置（只读用户层，不读项目层），交 T38 实现；**T38 已落地**：用户级 `settings.json` 的 `hookAllowedEnvVars`（只读用户层），列出的变量从登录 shell 环境加进命令 hook 的环境（ADR-0055 第 14 条，`piarc_core::hooks::launcher`） |
| I94 | T25 | Agent Host 能以伪造的输入调用 `hooks/run`（限 7 个事件与本工作区），触发用户已配置的 hook | T45 评估把 PostToolUse 绑定到 Core 已授权的工具调用、把 Stop 绑定到进行中的回合；**T45 评估，交 R5**：把 PostToolUse 绑定到 Core 已授权的调用、Stop 绑定到进行中的回合要在 `hooks/run` 入口查授权账本，属 THR-03（Agent Host 内的恶意扩展伪造事件）的纵深防御；R5 实现并补 L2；**R5**：交 T48（THR-03 的纵深防御：`hooks/run` 入口查授权账本），进入 R6 前完成 |
| I95 | W1 | Windows 上无需用户参与的权限裁决 p95 3.4–8.9 ms、小文件 AHP 往返 p95 5.0–9.3 ms，超出原 2 ms、5 ms：耗时分散在 NTFS 元数据调用与 ADR-0036 从卷根逐级绑定目录上。用户采纳 ADR-0040（Windows ≤ 10 ms）与 ADR-0041（Windows ≤ 15 ms）。W1 机器上 10 ms 余量很小：安静时 7.7–8.9 ms，全量 L4 刚结束时一次 11.2 ms 使 verify 失败、复跑通过（CI 3.35 ms） | T23：一次裁决内只规范化、解析 checkout 一次，评估按设置监听与信任广播失效的缓存；T44：从工作区根句柄开始绑定（须评审 ADR-0036 的安全论证），两平台纳入性能回归并复核能否收紧；**W2 复测**（同一台机器，release）：自动裁决 1,000 次 p95 3.55 ms，`fs/read` 往返 2,000 次 p95 5.23 ms |
| I96 | W1 | UNC 工作区未能实机验证：用户建了临时共享，但本机 SMB 客户端不可用（`net view \localhost` 报系统错误 1702）。回归测试 `tool_io::policy::tests::windows_paths::a_workspace_on_a_unc_share_is_written_read_and_searched` 已写好，设 `PIARC_TEST_UNC_SHARE`（共享测试的临时目录，`TMP` 指向它）才运行，否则打印 NOT RUN | W2 在 SMB 正常的 Windows 上运行；或 T44 评估在 CI 设置该变量（runner 为管理员，可用管理共享；改 CI 前确认）；**已关闭（W2）**：本机 SMB 文件访问可用（1702 只是 `net view` 的浏览接口），以系统的 `C$` 管理共享指向临时目录运行通过（测试的 `fs/glob` 参数补齐，08fc09e） |
| I97 | W1 | verify 的 `cargo test --workspace` 没有 `--no-fail-fast`：Windows CI 自 R2 起在第一个失败的测试目标处停止，另外 4 个目标的 Windows 失败一直没有暴露（W1 修复，见 W1 报告） | T44 评估 verify 与 CI 改用 `--no-fail-fast`（改 CI 前确认） |
| I98 | W1 | 系统通知的点击：横幅仍在屏幕上时点击，PiArc 打开对应会话（W1 修复通知对象被回收的问题后实测）；Toast 进入通知中心后点击走 COM 激活，只聚焦窗口、不打开会话。开发构建（L4 `dev` 形态直接运行 `node_modules` 的 electron.exe、本机打包产物）与正式版共用 AUMID `cn.piarc.desktop`，Electron 为每个程序各注册一个 Toast 激活器，W1 中点击通知中心的 Toast 启动了空白的 electron.exe | T42（可操作通知）：激活参数带会话 id、经 `second-instance` 打开；开发构建用独立 AUMID，避免开发机上的串用 |
| I99 | W1 | 通知实测中有两次运行在 30–60 s 内没有任何通知请求（窗口已最小化、会话已在等待审批），之后同样的操作立即发出；原因未查明 | T42 复核通知触发条件（窗口最小化、渲染进程节流） |
| I100 | W1 | 设置页"刷新模型目录"勾选框是受控组件，要等设置 Host 启动（正式路径首次约 1 s）答复后才改变状态，期间点击看起来没有反应 | T29 补全模型设置时给出进行中状态；**已落地（T29）**：勾选框保存期间显示所选值与"正在保存…"（`settings/ProvidersPage.tsx`），L4 与 ego-browser 核对 |
| I101 | 合并 W1 后的 CI | Windows CI 的 L4 `r2-workflow`（dev 形态）偶发：运行 44522160246 中应用在 60 s 内没有启动完成，清理时 Chromium 仍占着数据目录的 `lockfile`（EBUSY），没有应用日志；同一用例的 packaged 形态与另一协议通过，R2 的运行 44453549786 中它以另一断言失败 | **已查明并修复**：它是 dev 项目里第一个用 `mock` 夹具的用例，mock provider 在测试里首次编译，Windows runner 上用完了 60 s（运行 44533872761 的 trace：`mock` 夹具 60 s）；Playwright 的 `globalSetup` 先编译它（`e2e/global-setup.ts`）；**已关闭（R3）**：修复已在之后的 Windows CI 通过（运行 44542131720） |
| I102 | 合并 W1 后的 CI | Windows 上 bash 命令经环境变量 `PIARC_COMMAND` 与 `eval` 执行（Git Bash 截断过 12,000 字符的 `-c` 参数）：语法错误报 `eval: line N`，退出码可能是 1 而不是 2；截断的确切位置未在 Windows 上定位，只有 CI 覆盖 | W2 实机核对长命令、heredoc 与语法错误的表现；**W2 实机已核对**：2 万字符以上带引号括号的命令完整执行，heredoc（含中文、引号定界不展开）保留原样，语法错误退出码 2、报 `eval: line 2: syntax error…`（`exec_commands` 的 Windows 用例），关闭 |
| I103 | 合并 W1 后的 CI | 权限裁决计时在 CI 上与同一测试二进制的其他测试混跑时只是在测 runner：同一断言相邻两次运行 p50 0.84 / 1.44 ms。verify 第 8 步改为先跳过它跑全部测试、再单独运行（`scripts/ci/cargo-test.mjs`），预算不变。运行 44533872761 单独运行后 Windows p95 1.38 ms（预算 10 ms），macOS runner 仍 2.67 ms（debug，本机 0.67 ms）；随后改为按 T23-A13 的验收方式用 release 构建（本机 p95 390 µs） | release 下仍超预算时，按 I95 评审缓存设置的 ADR；T44 把计时纳入性能回归，并在架构第 11 章写明构建配置 |
| I104 | T26 | 架构第 6.14 节原把 Claude Code 的 `plansDirectory`（计划文件目录）列为 T26 支持的键；T26 按任务要求把批准的计划存为会话 entry（`piarc.plan`），没有写计划文件，键映射表仍为 `planned(T26)` | R3 决定：由后续任务支持（批准时把计划另存到该目录）并改映射表的任务号，或改为忽略并注明原因；**已决定（R3，1bfcf34）**：计划仍以会话 entry 为准，T48 增加批准时把计划另存到 `plansDirectory`，键映射表改为 `planned(T48)` |
| I105 | T26 | `agent-host/src/runtime/session-registry.ts` 999 行、`crates/piarc-core/src/tool_io/policy.rs` 943 行，接近单文件 1,000 行上限（T26 已把注册表的辅助函数移到 `session-helpers.ts`、审批等待移到 `policy/waits.rs`） | T27 扩展提醒通道时把逻辑放在 `harness/reminders.ts` 与 `SessionHarness`，不再往注册表里加；R3 复核；T27：逻辑放在 `harness/` 新模块，模型切换移到 `runtime/session-models.ts`，注册表 983 行；T28：分支与回退放在 `runtime/branches.ts`，会话类型移到 `session-types.ts`，注册表 941 行；Core 的回退流程放在 `sessions/session/rewind.rs`，`sessions/session.rs` 987 行；**R3**：注册表 1,030 行，组装 Harness 部件移到 `runtime/session-parts.ts` 后 981 行（e78571c）；接近上限的还有 `sessions/session.rs` 987 行、`tool_io/policy.rs` 956 行、渲染进程 `store/transcript.ts` 941 行、`piarc-host/src/supervisor.rs` 939 行，后续往这些文件加内容的任务（T31、T32、T35）先按领域拆分；**T31**：子 agent 放在新模块（`runtime/subagents.ts`、`runtime/subagent-session.ts`、`runtime/session-runtime.ts`、Core `tool_io/subagents.rs`、`sessions/subagents.rs`），注册表降到 921 行；`sessions/session.rs` 开工时已 1,033 行，模式、模型、排队表请求移到 `session/changes.rs` 后 939 行；`tool_io/policy.rs` 997 行、`store/transcript.ts` 989 行仍接近上限，T32、T35 往里加内容前先拆分；**已关闭（R4）**：拆分约定没有被遵守，多个文件已过 1,000 行，并入 I165 统一处理 |
| I106 | T27 | 架构第 4 章的 ADR 表没有 ADR-0042 一行（T26 未补；T27 已加 0043） | R3 复核时补齐；**已落地（R3，架构 v2.38）**：第 4 章补上 ADR-0042 |
| I107 | T27 | `autoCompactEnabled`、`autoCompactWindow` 只能写在设置文件里（PiArc 与 Claude Code 的设置层），设置窗口没有对应控件；熔断状态在 Agent Host 内存中，进程重启后复位 | T29 的每模型设置与常规设置页加控件；R3 决定熔断状态是否需要持久化；**已决定（R3）**：不持久化（ADR-0043 已否决），复位范围写入第 6.6.4 节与 `agent-host/src/harness/AGENTS.md`（含会话重开）；**R4**：熔断已决定；设置页控件 T29 未加（渲染进程没有这两个键），交 T41 |
| I108 | T28 | `crates/piarc-core/AGENTS.md`（142 行）与 `agent-host/AGENTS.md`（148 行）超过子目录 120 行上限（T28 之前已是 136、142 行）；`apps/desktop/AGENTS.md` 120 行到达上限 | R3 精简：能从代码或规范得到的段落改为一行链接，按任务分节的说明并入子目录 AGENTS.md；**已落地（R3，60eaf18）**：`piarc-core` 的任务分节并入 `src/tool_io`、`src/sessions` 的 AGENTS.md（93 行），`apps/desktop` 117 行 |
| I109 | T28 | `fileCheckpointingEnabled` 只能写在设置文件里（PiArc 与 Claude Code 的设置层），设置窗口没有对应控件（同 I107） | T29 的常规设置页加控件；**R4**：设置页控件 T29 未加，交 T41 |
| I110 | T28 | 架构第 7.7 节原定 T28 补词级 diff 与 UTF-16 偏移；Changes 面板按行显示、按 hunk 丢弃，没有用到，未实现 | 需要的任务（T42 diff 行内评论）在 `piarc-diff` 中补，不在渲染进程另算 |
| I111 | T28 | 回退与分支切换在同一 id 下重建 Pi 会话，该会话的 MCP 连接随之重连（ADR-0044 第 6 条的代价） | T36 共享连接池落地后复核：重建会话不再重连；**已复核（T36）**：MCP 连接在工作区池中，重开会话只交还再取回租约（空闲时间内），server 进程不变（`agent-host/src/mcp/pool.test.ts` 的 "a session reopened under the same id keeps the server process"）；**已关闭（R4）**：T36 已复核 |
| I112 | T29 | WebFetch 不走用户的 HTTP 代理（`HTTPS_PROXY` 等与系统代理都不读），也不接受 gzip 等内容编码（请求 `identity`，服务器仍压缩时报错）；需要代理才能访问外网的环境里 WebFetch 会失败 | T38（WebSearch 同样联网）一起决定代理来源与是否支持压缩；改动在 `piarc-web`，SSRF 检查仍须作用于最终连接的地址（经代理时检查目标主机解析结果）；**T38 决定**：维持 ADR-0045 的现状（不走代理、请求 `identity`），WebSearch 的第三方后端同样；交 T45 与网络设置一起决定代理来源与压缩（ADR-0055 第 6 条）；**T45 评估，交 T48**：代理与压缩是可用性问题，不是安全对策；SSRF 约束保持 |
| I113 | T29 | Claude Code 设置键 `model`、`effortLevel` 原定 T29（架构第 6.14 节）；`model` 的取值是 Claude Code 的模型别名，要等 T31 的别名表，本任务未接入，配置诊断中仍列为后续任务支持的键 | T31 接入模型别名时一并支持 `model` 与 `effortLevel`（作为新会话的默认模型与 effort），更新 `SETTINGS_KEYS`；**已落地（T31）**：`model`（可为别名）、`effortLevel` 生效为新会话的默认模型与 effort（`tool_io::context::session_defaults`、`session/create` 的 `defaultModel`/`defaultEffort`），`SETTINGS_KEYS` 已更新，L2 `model-default-setting` |
| I114 | T29 收尾 | 本机 macOS 的 FSEvents 投递变慢：`cargo test -p piarc-core --test state` 的两个设置监听用例（`editing_settings_while_running_…`、`editing_claude_code_settings_while_running_…`）在 20 s 内收不到设置事件，T28 收尾提交 75af7b3 上同样失败（T29 开工基线时通过）；`piarc-fs` 的 `reports_changes_in_a_watched_directory` 要约 10 s 才收到第一个事件（平时不到 1 s）；`sudo killall fseventsd` 后仍如此；当时系统数据卷已用 93%，IDE 正在建索引。T29 未改动设置监听与 `piarc-fs::watch` | 环境恢复（释放磁盘、重启）后在本机重跑 `cargo test -p piarc-core --test state` 与 `npm run verify`，通过后把 T29-A11 改为 passing；仍失败则另开任务排查 notify 8.2.1 的 FSEvents 后端，不放宽等待时间。2026-11-20 经用户同意已 `cargo clean`（收回约 145 GB，数据卷降到 77%）、IDEA 排除构建目录，用户在系统设置中把 `~/develop` 加入聚焦隐私并重启后复测：`piarc-fs` 监听测试 0.06 s、`piarc-core --test state` 7/7（0.71 s），7f9e79b 上 `npm run verify` 15/15；**已解决**（环境原因，未改代码），T29-A11 改为 passing |
| I115 | T30 | L3 发现 hooks 输入缺 Claude Code 2.1.318 的两个通用字段：每个事件的 `prompt_id`、工具事件与 Stop 的 `effort`（`tests/l3-allowlist.yaml` 中 `follow_up: T38` 的两条） | T38 扩展 hooks 时在 Core 的 `hooks::input` 补上：会话当前提示的 id（Core 观察 UserPromptSubmit 时生成）与会话模型的 effort（无 effort 的模型省略）；补完删掉 allowlist 条目；**T38 已落地**：`prompt_id`（Core 在每次 UserPromptSubmit 生成，子 agent 沿用主会话的）与工具事件、Stop、SubagentStop、PostToolBatch 的 `effort`（ADR-0055 第 13 条，`hooks_m3_tests::inputs_carry_the_prompt_id_and_the_effort_of_tool_events`）；allowlist 中 `prompt_id` 一条已删，`effort` 一条改为说明有意差异的理由 |
| I116 | T30 | L3 发现两处权限裁决与 Claude Code 2.1.318 不同：命令替换（`echo $(whoami)`）PiArc 按其中每个命令判断而直接运行，Claude Code 询问；allow 规则（阶梯第 6 步）先于越界检查（第 7 步），`Bash(awk *)` 让 `awk … ../outside.txt` 不询问，Claude Code 询问（`perm-compound` 的 `follow_up: R3` 条目） | R3 决定是否改阶梯顺序或对命令替换询问（改阶梯属于变更型，需 ADR）；改了就删掉对应 allowlist 条目；**已决定（R3）**：命令替换维持架构第 6.2.2 节的分析（allowlist 理由改写，不再等 R3）；阶梯顺序属变更型，写 ADR-0047（提议：越界路径先于带通配的命令 allow 规则），等待用户确认；**已落地（R3）**：用户确认 ADR-0047，带通配的命令规则不放行越界路径（`bash::judge`、`assess::powershell_call`），L3 `perm-compound` 的 `outside` 两条 allowlist 条目已删除 |
| I117 | T30 | L3 记录的工具集与参数偏离各有后续任务：`Agent`、`ListAgents`（T31）、`Skill`（T37）、Bash 的 `run_in_background`（T32）与 `dangerouslyDisableSandbox`（T39）、`ToolSearch` 与延迟加载的工具（T36 评估 MCP 工具多时是否延迟加载）、plan 模式下非只读命令交给自动模式分类器（T46） | 各任务实现时用 `npm run l3` 复核，对应 allowlist 条目不再匹配时删除（否则命令失败）；I01 的 TodoWrite 差异已写入 allowlist；**R3**：负责任务即内容列所列的 T31、T32、T36、T37、T39、T46；**T31 已复核**：`Agent` 的 `model`、`effort` 改为 `{type:"string", enum}` 后不再有差异，条目已删除；`ListAgents` 保留并写明理由（PiArc 没有 agent teams，后台运行经提醒回报），不再挂后续任务（`npm run l3` 于 ba159ff：12 个场景 0 条未解释差异、0 条过时条目）；**T36 已复核**：PiArc 只在会话的 MCP 工具超过 `mcp.deferThreshold` 时提供 `ToolSearch`，内置工具从不延迟（ADR-0053）；`ToolSearch`、`DeferredToolPlaceholder` 条目改写理由并去掉 `follow_up`；同时补上 T32 漏登的 `Monitor`、`KillShell`（Claude Code 2.1.318 不预先声明）并删除不再匹配的 `run_in_background` 条目（T32 起 Bash 已有该参数）。`npm run l3` 于 24f4059：12 个场景 0 条未解释差异、0 条过时条目。剩余负责任务 T37、T39、T46；**R4**：T37 已完成；剩余负责任务 T39、T46；**T39 已复核**：Bash 有 `dangerouslyDisableSandbox`（描述自写），条目删除（4b640b4）；`npm run l3` 于 4b640b4 之前的工作区：12 个场景 0 条未解释差异、0 条过时条目（`~/.claude` 的变化来自同时开着的 Claude Code 会话）。剩余负责任务 T46；**T46 已复核**：计划模式的硬拦截保持不变（增补第 6.3 节，`useAutoModeDuringPlan` 忽略），`perm-plan` 的 `requests.auxiliary` 条目改写为有意偏离并去掉 `follow_up`；`npm run l3 -- --filter perm-plan` 于 294c83a 之后的工作区：该条目仍匹配、0 条过时条目，另有与 T46 无关的差异见 I224；I117 关闭 |
| I118 | T30 | L3 只在 macOS 上运行：PowerShell 场景（`perm-powershell-whole`、`policy-*-powershell`）排除；Windows 上 Node 不经 shell 启动不了 npm 安装的 `claude.cmd`，需要原生安装器的 `claude.exe` | W2 评估在 Windows 上运行 L3（安装方式、PowerShell 场景），通过后把这三个场景移出排除清单；**已关闭（W2）**：Windows 上用锁定版本平台包自带的 `claude.exe` 运行，12 个场景 0 未解释、0 过期；Windows 版没有 PowerShell 工具，三个场景保留排除并更新理由；allowlist 增加 `platforms`（edfaa51） |
| I119 | T30 收尾 | `crates/piarc-core/AGENTS.md` 已有 150 行，超过子目录 120 行的上限（T29 收尾时已是 149 行，T30 加了一行 hooks 顺序） | R3 整理：把可从代码或 `testing.md` 得到的段落改为链接；**已落地（R3）**：同 I108 |
| I120 | R3 | `Read(…)` deny 按调用的路径参数匹配：Grep、Glob 以目录为参数时结果里仍有被拒文件（`Read(./.env)` 时 `Grep` 在 `.` 中搜出 `.env` 的行），Bash 的 `grep -r`、`rg` 同样不受约束（R3 审查 P9） | T45：Core 执行 `fs/grep`、`fs/glob` 时把 Read deny 编译为排除集合作用于结果；Bash 递归读取在文档写明限制（架构第 6.2.2 节已写）；**T45 评估，交 R5**：做法——`fs/grep`、`fs/glob` 在 Core 返回前用本会话设置里 `Read(…)` deny 的路径规则（`piarc_policy::paths::PathPattern::matches`，上下文同 `tool_io/policy/assess.rs` 的 `Places`）过滤结果，放在 `tool_io/files.rs`（`mod.rs` 已近 1,000 行）；补 L2：`Read(./.env)` deny 时 Grep 搜不出 `.env` 的行、Glob 不列它；映射到 THR-01 的"deny 规则"；**已落地（R5）**：cf76d24，Core 在 `fs/grep`、`fs/glob` 返回前去掉 `Read(…)` deny 覆盖的文件（`tool_io/files.rs` 的 `without_denied_*`），L2 `sec-read-deny-search`；Bash 递归读取的限制写在架构第 6.2.2 节 |
| I121 | R3 | 审计缺口：权限模式切换（含跳过权限）、hook `updatedPermissions` 的成功应用、"总是允许"保存的规则与选项、设置页的规则增删改都不写审计；hook 审计写入失败只记日志，而权限审计失败即拒绝（R3 审查 P12） | T45：按第 6.2.3 节"审批结果、规则命中、hooks 决定都写入审计表"补齐，并统一失败口径；**T45 评估，交 R5**：按原方案补齐审计并统一失败口径（THR-06"审计可查"）；**R5**：交 T48（审计补齐与失败口径统一，THR-06），进入 R6 前完成 |
| I122 | R3 | hook 的权限效力：PermissionRequest hook 的 allow 能代答 `askRule`、`protectedPath`、`outsideWorkspace`（与 Claude Code 文档一致，ADR-0039 未写明 ask 规则）；hook 的 `setMode` 写进 `workspaces.default_mode`，撤销信任后仍保留；hook 的 `addRules` 直接并入信任快照（R3 审查 P13） | T38 扩展 hooks 时在 ADR-0039 写明 ask 规则的语义，撤销信任时清掉项目 hook 写入的模式记忆与规则；**T38 已落地**：ADR-0055 第 16 条补充 ADR-0039（hook 可代答 ask 规则、受保护路径与越界询问，不能代答关键路径删除与 `requiresUserInteraction`）；项目 hook 的 `setMode` 只改本会话、写进 `.piarc/` 的 allow 规则不确认进信任快照，撤销信任后不残留，无需另做清理（`hooks_m3_tests::a_project_hooks_permission_updates_stay_within_its_trust`） |
| I123 | R3 | 其余权限边角：会话中途关掉 `enableBypassPermissions` 后已在跳过权限的会话不重新校验；deny 按归一化文本匹配，`git -C . push` 不命中 `Bash(git push *)`；PermissionRequest 的 exit 2 实现为"忽略并读 stdout"，未对照官方文档核实（R3 审查 P15） | T38（hooks 语义核对）、T45（跳过权限的撤销、deny 的已知局限写进设置页说明）；**T38 核对**：官方文档中 PermissionRequest 的 exit 2 不生效、权限流程照常，与 T25 的实现一致（ADR-0055 背景）；跳过权限的撤销与 deny 的已知局限仍归 T45；**T45 评估，交 R5**：跳过权限关掉后对已在该模式的会话重新校验、deny 局限写进设置页说明；**R5**：交 T48（跳过权限关掉后重新校验、deny 局限写进设置页） |
| I124 | R3 | token 估算按"字符数 / 4"（ADR-0043 第 8 条），中文为主的内容低估 2–4 倍：重注入上限按估算放行，压缩后"无效"判断可能漏报，熔断不计数（R3 审查 C1，未用真实分词器核实比例） | T41（用量与成本）评估按服务商报告校准 `#after` 或给非 ASCII 更保守的权重；改估算口径须改 ADR-0043 |
| I125 | R3 | 压缩边角：模型窗口很小（T ≤ 0）时每次运行前都压缩、每模型窗口大于模型窗口时 Pi 的 `reserveTokens` 钳到 0；Agent Host 重启后计划模式提醒可能不再送达（闸门仍拒绝写入）；`session_compact` 处理中途抛错时该次压缩被记为有效（R3 审查 C3、C5、C6） | T48（M5 Harness 补全）补单测与处理 |
| I126 | R3 | 检查点的故障路径：回退写回文件后 `record` 失败时报告与 `restore_id` 丢失、钉住释放（不可撤销）；先替换后记录，崩溃窗口内的写入不进回退与 Changes；记录在路径锁外，同一文件并行两写可能乱序入库；`#reopen` 失败时 Core 报对话未回退而 leaf 已移动（R3 审查 D4、D5、D6、D9） | T45：注入数据库与重开失败的测试，记录失败时仍返回报告并保持钉住，按 ADR-0044 评估在替换前写待定行；**T45 评估，交 R5**：检查点的故障路径属数据完整性，不是威胁映射的对策；**R5**：交 T48（检查点故障路径，数据完整性；先写注入失败的测试） |
| I127 | R3 | 检查点加固：快照不含权限位（被删后重建的 `run.sh` 丢可执行位）；对象 rename 后不 fsync 目录；对象库只按检查点数量保留、没有磁盘上限；关闭 `fileCheckpointingEnabled` 的回合与"先被 Bash 改过"的文件在回退预览里没有提示；hunk 丢弃对解码有损的文件以 `fileModified` 拒绝，提示语不准确（R3 审查 D7、D8、D10、D11） | T44（磁盘上限与长跑）、T42（Changes 与回退预览的提示） |
| I128 | R3 | `piarc-policy`、`piarc-hooks` 没有 `error.rs`，公开解析函数返回 `Result<_, String>`；`piarc-web` 的 `FetchError` 写在 `lib.rs`，`piarc-hooks/src/lib.rs` 含实现；审计步骤名是字符串（`policy.rs` 按字符串匹配 `hookDeny` 等）（R3 审查 Q4） | T31（`piarc-policy` 加 `Agent` 规则时）与 T38（`piarc-hooks`、`piarc-web`）按编码规范 2.1、2.3 补错误枚举并把实现移出 `lib.rs`；**T31 已落地 `piarc-policy` 部分**：`piarc_policy::Error`（`error.rs`，`kind()`、`retryable()`、`to_error_object()`），`rules::parse`、`paths::parse` 返回它；`piarc-hooks`、`piarc-web` 与审计步骤名仍归 T38；**T38 已落地 `piarc-hooks`、`piarc-web` 部分**：`piarc_hooks::Error`（`error.rs`），执行移到 `run.rs` 等模块，`lib.rs` 只剩导出与 `STOP_CONTINUATION_LIMIT`；`piarc_web::FetchError` 移到 `error.rs`；审计步骤名是 AHP 与审计表的对外值，维持字符串（ADR-0055 第 15 条） |
| I129 | T31 | 子 agent frontmatter 的 `isolation`（T35）、`mcpServers`（T36）、`skills`（T37）只解析与校验，设置页与子 agent 卡标"暂未生效"（`inactiveField`）；带 `isolation: worktree` 的调用返回明确错误，不在主工作树中运行 | 对应任务实现时让字段生效、去掉 `inactiveField` 警告，并更新 L2 `subagent-denied-type` 的 worktree 断言；T35：`isolation: worktree` 生效（`inactiveField` 警告去掉，L2 `subagent-denied-type` 改为断言非 git 仓库的错误，T31 的 L4 改断言 `skills`）；T36：`mcpServers` 生效（`inactiveField` 警告去掉；按名称引用复用工作区池，内联定义由 Core 在 `agents/list` 中检查与展开，项目级的信任前不启动；L2 `mcp-subagent-servers`、`mcp-subagent-untrusted`）；**已关闭（R4）**：`isolation`、`mcpServers` 已生效，`skills` 见 I159（T48） |
| I130 | T31 | Claude Code 设置键 `agent`（主线程以某个子 agent 的身份运行）在 `SETTINGS_KEYS` 中为 `planned(T48)` | T48 与 fork 子 agent 一起实现 |
| I131 | T31 | 子会话的条目增量不下发（架构 7.6 的 `parentSessionId`）：进度是父会话 `subagent` 条目的 `SubagentState`，卡片展开后按状态或工具调用数变化重新读取转录，子 agent 的长回复不实时显示 | R4 评估；T32 的后台任务面板需要实时显示子会话时实现带 `parentSessionId` 的增量；T32 的后台任务面板对子 agent 只显示状态与停止（转录仍在子 agent 卡里看），没有用到子会话增量，仍待 R4 评估；**R4 评估**：M3 不需要（子 agent 卡按状态变化重读转录，后台任务面板不显示子会话正文）；长回复实时显示交 T48 |
| I132 | T31 | 每个子会话各起一份 MCP server 进程（Pi 的 MCP 扩展按会话实例化），前台多个子 agent 并行时进程数随之增加 | T36 的 MCP 连接池覆盖子会话；**已落地（T36）**：子会话与主会话共用工作区的 MCP 池，同一 server 只有一份进程（L2 `mcp-subagent-servers`） |
| I133 | T31 | 子会话在 Core 的登记（`ToolIo::open_linked`）不带沙箱；目前会话层还不开沙箱会话（只有测试使用 `open_sandboxed_session`） | T39 让会话进沙箱时，子会话随主会话进入同一沙箱策略；**已落地（T39）**：命令是否进沙箱在裁决时按会话当时的设置决定（`Effective::for_call`），子会话与主会话读同一份工作区设置，所以随主会话进入同一策略；登记不需要携带沙箱 |
| I134 | T31 | `Agent` 工具描述里的可选类型与可派出的定义在会话打开时确定，定义文件变化后要重新打开会话才生效；新增的 `Agent(类型)` deny 规则仍由 Core 在每次调用时按最新规则裁决 | T37 的 `resources/reload` 一并刷新子 agent 列表；**R4**：T37 的 `resources/reload` 只让 skills 失效，子 agent 列表与上限（`maxConcurrent`、`maxDepth`）、别名表仍在会话打开时定（R4 S6），交 T48 |
| I135 | T31 | 辅助模型的别名（`modelProviders.auxiliaryAlias`）只按用户级 `modelAliases` 解析：模型偏好不随工作区变，工作区 `.piarc/settings.json` 的别名对辅助模型不起作用 | R4 评估是否需要按工作区解析；**已关闭（R4 评估）**：不按工作区解析。模型偏好与辅助模型是用户级设置（ADR-0045），工作区别名只影响子 agent 与会话模型；有需求时再提 |
| I136 | T32 | T17-A01 的描述仍写"命令超时后整棵进程树被终止"：T32 起超时转为后台任务（同一进程继续运行），进程树终止的覆盖转到 KillShell、回合中断与应用退出（`exec-timeout-kills-tree` 已改为转后台后 KillShell）。能力 `CAP-EXEC-TIMEOUT-001`、`CAP-TOOL-BASH-002` 的标题已按新行为更新 | 用户按新行为修改 `acceptance.json` 与 T17 任务文件中 A01 的描述（协议不允许任务自行改写验收描述）；**R4**：仍等用户修改（列入 R4 报告） |
| I137 | T32 | 挂起的完成通知只在 Core 内存里：应用退出前已结束但还没送达的通知、以及因退出而中断的任务，重启后不告知模型（面板显示已中断） | R4 评估是否把挂起的通知写进 `background_tasks` 并在会话打开时补送；**R4 评估**：值得做（重启后模型不知道已结束的后台命令），需要把挂起通知写进 `background_tasks` 并在会话打开时补送，交 T48 |
| I138 | T32 | `monitor.wakeIdleSession` 只能在设置文件里改，唤醒间隔与 Monitor 限值没有用户入口（`TaskLimits` 默认值） | R4 与 I03 一起确认默认值；需要入口时由 T41（配置与设置完善）在设置页暴露；**R4**：默认值见 I03；设置页入口交 T41 |
| I139 | T32 | `core/tasks` 快照是全局最近 200 个任务的整表，每次变化至多每 250 ms 推一次（带每个任务的最后几行）：任务多、输出频繁时载荷偏大 | T44 的性能预算里测一次，必要时按工作区或会话分路由 |
| I140 | T33 | L3 的 `perm-compound`（Claude Code 2.1.318）有 12 条未解释差异：PiArc 的请求多出 `KillShell`、`Monitor` 两个工具（T32 加入，allowlist 没有对应条目）；L3 不在 verify 中，只在 Nightly 运行 | 下次运行 L3 的任务（或 R4）确认 Claude Code 该版本的对应工具（名称与是否在 `-p` 下提供）后补 allowlist 条目或参数映射；**已关闭（R4）**：T36 已在 allowlist 补上 `Monitor`、`KillShell`（I117），`npm run l3` 0 条未解释差异 |
| I141 | T34 | T34 首次验收缺少正式终端面板的系统拼音候选框截图，组件测试与 CDP 合成已通过；R4 时仍待补验 | **已关闭**。W3 在 Windows 上核对了微软拼音（W3-A03）。2026-11-24 在 macOS 正式会话终端面板用系统简体拼音通过 S7 第 8 节 T1–T4：shell 与 Vim 中的候选框随光标移动、选词只写入一次、Esc 取消合成且保留 Vim 插入模式。截图与逐词记录见 `tmp/evidence/T34/native-ime/`，T34-A03 已通过 |
| I142 | T34 | W3 的 Windows 核对项：① 微软拼音在终端面板中的预编辑与候选框位置（同 I141 的 T1–T4）；② ConPTY 下面板中的 vim（Git 自带）、htop 或 PowerShell 进程表的渲染与缩放；③ Ctrl+C：有选区时复制、无选区时中断程序，Ctrl+Shift+C 总是复制，Ctrl+V 粘贴；④ 面板隐藏与窗口最小化时拉帧为 0（`visibility` 应用事件在 Windows 上的行为）；⑤ `t34-terminal*.e2e.ts` 在 Windows 上整体跳过（用例键入 POSIX shell 命令），W3 写 Windows 版（PowerShell 或 cmd、Git 的 vim）后去掉跳过 | W3；**已落地（W3）**：①③④ 实机与 L4 通过；② Git 的 vim、less 与 PowerShell 进程表在缩放前后与 formatter 一致；⑤ `t34-terminal-windows.e2e.ts`（8 个用例），POSIX 两个文件仍在 Windows 跳过并指向它 |
| I143 | T34 | 应用重启后被中断的会话终端（任务 `interrupted`，T33 已保存 snapshot）在面板中没有"恢复"入口：Core 的 `openSessionTerminal` 支持 `restore`，界面未提供 | T35（并行会话与多窗口）或 M4 的终端完善时加入；T35 未加入（并行会话与多窗口不依赖它），留给 M4 的终端完善；**R4**：交 T48（M5 补全中的终端完善） |
| I144 | T34 | axe 检查发现存量对比度缺陷：`:root[data-app] button { color: inherit }` 的优先级高于 `.button-primary`，全应用主按钮文字为深色（对比度 2.87）；T34 把三条主按钮规则移到 `:root[data-app]` 下修复，T18 视觉关口的截图里主按钮文字颜色与现在不同 | 已落地（T34）；T43 的无障碍检查覆盖全部界面 |
| I145 | T34 | 测试机没有 htop：T34-A01 的全屏重绘程序用 top 代替（与 T10 相同，未全局安装 htop） | 需要 htop 截图时由用户决定是否 `brew install htop`；**R4**：仍由用户决定（列入 R4 报告） |
| I146 | T35 | M3 内存（`npm run perf:m3`，[报告](../perf/M3-memory.md)）：3 个并行会话（1 个在 worktree）加 1 个子 agent 时 Agent Host 最大 238 MB（预算 270 MB，达标），应用其余进程合计最大 576 MB，超出 macOS 预算 510 MB（T35-A11 failing）；没有会话时的基线已有 505 MB（不连测试驱动 466 MB：主进程 193、渲染 137、GPU 86、网络 51），会话只增加约 65 MB（渲染进程约 50 MB）；主进程从 M0 的 160–164 MB 增到 193 MB，JavaScript 堆只有 6–7 MB，增长在原生部分 | R4 风险：复测并逐项定位主进程原生内存（Core 各子系统常驻量）与渲染进程的实时 transcript 缓存；T44 把这一行纳入 CI 预算；预算不放宽；**R4 复测**：见 I26 与 R4 评审第 1 节：Agent Host 达标（最大 236 MB ≤ 270），应用其余进程 RSS 合计 580 MB 仍超出；列为 M3 退出标准的阻塞项，交 T44；**T44**：这一行进了 Nightly（`app-memory`，按 RSS 判定），见 I26；**R5**：按 ADR-0063 的口径 3 会话 + 子 agent 场景应用其余进程物理占用最大 264 MB（≤ 510）、Agent Host 最大 229 MB（≤ 270），达标；**已关闭** |
| I147 | T35 | W3 的 Windows 核对项：① worktree 路径（长路径、`.piarc\worktrees\` 下的深路径、大小写不同的同一路径）与 git for Windows 的 `worktree add`/`remove`；② 托盘图标（深色/浅色任务栏切换、左键打开窗口、右键菜单、提示文字里的计数）；③ 安装后 `piarc://` 与资源管理器"Open with PiArc"（文件夹与文件夹空白处），卸载后注册表项被删除；④ `npm run perf:m3` 的 3 会话内存（Windows 预算 450 MB）；⑤ 关闭最后一个窗口后后台运行与退出确认 | W3；**已落地（W3）**：①长路径（新用例）、中文与空格、小写盘符；②托盘用户实机核对；③安装后 `piarc://` 与两个右键项可用，卸载后的注册表清理未核对（留给 W4 的安装与更新验收）；④见 I201；⑤ `t35-windows` 通过 |
| I148 | T35 | Claude Code 的设置键 `worktree`（worktree 选项）原标 `planned(T35)`；T35 只实现了 PiArc 自己的 worktree 流程，没有逐个子键对照官方语义，改标 `planned(T48)` | T48 与 WorktreeCreate/WorktreeRemove hooks 一起核对子键并决定生效或忽略 |
| I149 | T35 | T35-A08 的菜单栏截图没有拍到：运行测试的终端没有"屏幕录制"权限（`screencapture` 报 could not create image from rect，与 T18 的 `t18-review` 相同）。托盘的标题、提示文字、菜单项由测试钩子从真实 `Tray` 读回（`tmp/evidence/T35/l4/…/tray.json`），窗口截图齐全 | 用户在本机开一个会话、关闭窗口，看菜单栏图标旁的 `▸1` 与菜单中的等待审批会话；需要截图证据时给终端屏幕录制权限后重跑 `t35-windows` |
| I150 | T35 | `crates/piarc-testkit/src/l2/runner.rs` 1,054 行，超过单文件 1,000 行（T34 后已是 1,049 行；T35 的新增动作放在 `runner/worktrees.rs`，只在分派处加了几行） | R4 整理：把动作分派按领域拆到 `runner/` 子模块；T36 在分派处又加了几行（`runner.rs` 1,061 行），`format.rs` 开工时已是 1,025 行（未登记），T36 加了场景顶层 `mcp_http` 与动作 `mcp_sign_in` 后为 1,052 行；R4 一并拆分（类型按领域移到 `*_spec.rs`）；**已关闭（R4）**：`runner.rs` 868 行（`runner/env.rs`）、`format.rs` 900 行（`format/expect.rs`），3c73ec8 |
| I151 | T35 | worktree 会话要求工作区是 git 工作树的顶层（`git rev-parse --show-toplevel`）；把仓库子目录作为工作区时新建表单说明原因、不提供 worktree，子 agent 的 `isolation: worktree` 返回错误 | 有需求时评估：worktree 建在仓库顶层的 `.piarc/worktrees/`、会话 cwd 落在 worktree 内对应的子目录（ADR-0052 的重新评估条件之一）；**已关闭（R4）**：作为 ADR-0052 的重新评估条件保留，有用户需要时按该条件处理 |
| I152 | T35 | 全文搜索索引 JSONL 里的全部消息，回退或切换分支后不在当前分支上的消息也会被搜到；点击这类结果时提示"这条消息不在对话的当前分支上"。正在运行的会话里实时显示的行没有 Pi 的 entry id，定位只在会话空闲时从历史重读后进行 | R4 评估是否在索引里标记分支（需要按 leaf 计算可达性）；**已关闭（R4 评估）**：不在索引里标记分支（每次同步要按 leaf 算可达性）；点击时的提示保留 |
| I153 | T36 开工检查 | 远端 CI 运行 44868949621（e0c41ce，T35 中途的提交，此前 R3 开工的运行 44731794641 起 Windows 已红，未记录）两平台失败：① 两平台 clippy `too_many_lines`（`crates/piarc-git/tests/worktree.rs:154`，本地 c4094dd 的 verify 已通过，应已修复）；② Windows `piarc-core` 单测 8 个失败：`tool_io::checkpoints` 3 个（回退结果的路径是绝对路径而不是相对路径）、`policy::tests::t23::always_allow_saves_one_rule_per_subcommand`（多存 `Bash(ls *)`）、`t31` 4 个（清理测试目录时 os error 32，文件被占用）；③ Windows L2 12 个失败（`rewind-*` 6 个、`subagent-*` 4 个、`changes-file-and-hunk`、`monitor-rate-limit`）；④ macOS L2 `bg-completion-reminder`（请求里出现了不该有的 `has ended.`，本地通过）；⑤ L4：macOS `t34-terminal*` 6 个、Windows `t19-composer`、`t28-rewind` 7 个。fail-fast 使 T32–T34 的 Windows 进程树测试没有跑到，T32-A04/A13、T33-A02/A12/A14、T34-A14 仍为 blocked | 用户推送当前 HEAD 后复核：Windows 部分交 W2（M2 的 Windows 达标覆盖 T23、T28）与 W3（T31–T35），macOS runner 上的 L2/L4 失败由下一个开工检查按新 CI 定位；用户决定先继续 T36；**R4**：Windows 部分已由 W2 修复；W2 推送后的运行 44887344674 中 macOS verify 通过，Windows 仍有 3 个失败（见 I166），macOS L4 被取消，交 T39 开工检查按新 CI 定位 |
| I154 | T36 | Pi 扩展经 `registerMcpServer` 或 `mcp_servers_change` 动态加入的 MCP server 不接入 PiArc 的池（Pi 的 MCP 扩展不再加载，ADR-0053 第 1 条） | T40（插件与 Pi 包）接入：经 Core 的配置与信任进 `mcp/servers`，作用域 `plugin`；**已落地（T40）**：插件的 `.mcp.json` 与清单 `mcpServers` 经 Core 进 `mcp/servers`（作用域 `plugin`，名为 `plugin_<plugin>_<server>`，只含已确认的项）；Pi 扩展在运行时经 `registerMcpServer` 动态加入的 server 仍不接入（PiArc 的 MCP 扩展替换 Pi 的，ADR-0053），列入 ADR-0058 后果 |
| I155 | T36 | MCP 资源（`resources/list`、`resources/read`）没有暴露给模型（Claude Code 有列出与读取资源的工具）；prompts 作为斜杠命令同样未做（架构第 6.8 节缺口） | T40 与 MCP prompts 斜杠命令一起评估：经池取连接（`coding-standards.md` 复用表的 MCP 连接池）；**T40**：prompts 已落地（ADR-0058 第 15、16 条，`mcp__<server>__<prompt>` 斜杠命令）；MCP 资源工具（`resources/list`、`resources/read`）仍未暴露，交 T48 与 elicitation 一起评估 |
| I156 | T36 | `headersHelper`（运行命令生成 HTTP 请求头）不执行，只报为配置问题；需要它的 server 要改成静态 `headers` 或 OAuth | **T47 已评估**：企业配置沿用 `piarc_config::mcp` 的解析，`headersHelper` 仍在诊断中标为不支持。第一版使用静态 `headers` 或 OAuth。若要运行助手命令，需另行设计其信任、执行与审计。 |
| I157 | T36 | MCP 的 OAuth 状态按 server 名存在保险箱键 `mcp/<server>`：两个工作区各有一个同名而地址不同的 server 时，pi-mcp 只用地址相同的状态，登录一个会覆盖另一个的 token（需要重新登录） | **T47 已复核，迁移待单独实施**：托管同名定义优先选取。pi-mcp 1.5.2 的 `oauth/provider.js` 在读取状态时核对 `serverUrl`，PiArc 的 `vaultKey` 仍只用名称；同名不同地址的登录会覆盖旧状态、需要重新登录。区分地址需一并迁移旧保险箱键和刷新锁。 |
| I158 | T37 | 暂不支持的 skill frontmatter 字段：`context: fork`、`agent`、`background`（在子 agent 中运行 skill）与 `model`、`effort`，诊断标 T48；`disallowed-tools`、`shell` 与 `metadata`、`license`、`compatibility` 等标忽略；输出风格的 `force-for-plugin` 标 T40 | T48（`context: fork` 一组与 `model`、`effort`）、T40（插件风格）；**T40**：插件的输出风格整体列为不支持（ADR-0058 第 14 条），`force-for-plugin` 维持忽略 |
| I159 | T37 | 子 agent 定义的 `skills`（启动时预加载 skill 正文）仍未生效，警告的接手任务由 T37 改为 T48 | T48 与 `context: fork` 一起实现（经 Core 读取正文，不走 `Skill` 调用的授权） |
| I160 | T37 | Pi 自带的 skills 与 prompt templates 加载已关掉（ADR-0054），Pi 设置里 `skills`、`prompts` 列出的额外路径与 Pi 包携带的 skills、模板不再生效；项目根以下子目录的 `.claude/skills`（Claude Code 的嵌套 skill）与 `--add-dir` 目录的 skills 也不加载 | T40（Pi 包与插件）一并接入；嵌套 skill 由 T48 评估；**T40**：Pi 包携带的 skills 与 prompt templates 经 Core 的发现加载（`ResourceDirs.packages`）；Pi 设置里 `skills`、`prompts` 列出的额外路径、嵌套 skill 与 `--add-dir` 仍不加载，交 T48 |
| I161 | T37 | 与 Claude Code 的有意差异：同名 skill 项目级优先于个人级（Claude Code 相反，PiArc 与设置层、子 agent 定义一致）；位置参数 `$1` 起（Claude Code 当前文档 `$0` 起，`$ARGUMENTS[N]` 两者一致）；经排队的 follow-up 发出的命令不带 `allowed-tools` 的回合授权（它开始的回合照常询问）；`skillListingBudgetFraction`、`skillListingMaxDescChars` 未实现（索引描述固定截断到 1,536 字符） | R4 请用户确认这几处差异；有 L3 场景涉及时写入 `tests/l3-allowlist.yaml`；**R4**：差异保持（理由见内容列），列入 R4 报告请用户确认；用户要改时交 T48 |
| I162 | T38 | 服务商原生搜索只接了 Anthropic Messages（`web_search_20250305`）：OpenAI Responses 的 `web_search`、Gemini 的 Google Search grounding 未接，这些模型只能用第三方后端（Brave）；第三方后端也只有 Brave 一家（ADR-0055 第 3、4 条） | 有用户需要时在 `agent-host/src/providers/web-search.ts` 加适配、在 `piarc_web::search` 加后端；mock provider 同步补对应的结果块；**已关闭（R4）**：写在 ADR-0055 第 3、4 条，有用户需要时按该处加适配 |
| I163 | W2 | `crates/piarc-term/tests/pointer.rs` 只在 Unix 上编译：T34 的选区、滚动、唤醒与默认颜色在 Windows 上没有 Core 侧用例（Windows 上 0 个） | W3 补 Windows 变体；**已落地（W3）**：`crates/piarc-term/tests/pointer_windows.rs`（5 个用例；OSC 11 应答见 I206） |
| I164 | W2 | macOS CI（运行 44868949621，e0c41ce）的 L2 `bg-completion-reminder` 失败，Windows 本机与 CI 上通过；W2 在 Windows 上无法复现 | T35（macOS）收尾前核对，修复或登记；**已关闭（R4）**：W2 推送后的 CI 运行 44887344674 中 macOS verify（含该场景）通过，R4 本机全量 L2 通过 |
| I165 | R4 | 超过 1,000 行的文件（R4 Q1，I105 的约定未被遵守）：`piarc-config/src/skills.rs` 1,162、`agent-host/src/tools/core-io.ts` 1,065、`tool_io/policy.rs` 1,053、`tool_io/exec.rs` 1,045、`piarc-napi/src/sessions.rs` 1,041、`sessions/session.rs` 1,033、`agent-host/src/runtime/session-registry.ts` 1,027 行；接近上限的有渲染进程 `store/transcript.ts` 989、`piarc-host/src/supervisor.rs` 940 行；没有工具检查 | 往这些文件加内容的任务先按领域拆分：T39（`exec.rs`、`policy.rs`）、T40（`skills.rs`、`session-registry.ts`）、T41（`session.rs`、`piarc-napi/src/sessions.rs`）、T42（`core-io.ts`）；T44 在 verify 加行数检查（超过的文件须在白名单里写理由）；**T39**：`tool_io/exec.rs`、`tool_io/policy.rs` 已按领域拆分（68b8a66） |
| I166 | R4 | W2 推送后的 CI 运行 44887344674（`windows/dev` 0ad961c）Windows 失败：① `piarc-store` `tests/index.rs:196` 同长度改写在同一时间戳刻度内完成时 mtime 不变，同步判为未变（Windows runner 的时间戳粒度）；② L4 `terminal.e2e.ts:44`（dev）停拉后多收到 2 帧（11 > 9）；③ L4 `t19-composer.e2e.ts:138`（packaged）断言时最后一个请求还是上一条文本。W2 本机 verify 15/15 | W3：①给测试显式设不同的 mtime 或在同步判据里加入内容哈希（评估成本）；②③按 CI trace 定位，计时类断言改为等条件；**已落地（W3）**：①用例显式设定 mtime；② `terminal.e2e` 等 cmd 的提示符后再数帧；③ R4 已改，本机通过 |
| I167 | R4 | 子 agent 的低风险项（R4 S5、S7–S10）：`#reopen` 期间结束的后台子 agent 丢报告与状态条目；每个子 agent 在 Core 留一个等连接关闭的任务；空闲时后台子 agent 的写入记在主会话最后一个回合的检查点；对已结束子会话的审批作答返回 `sessionNotFound` 而不是 `stale`；注册失败时仍发 `subagent/finish` | T48 |
| I168 | R4 | 子 agent 自己的后台通知（R4 S4 的余项）：S4 修复后子 agent 的后台命令结束通知送到主会话、子 agent 结束时其 Monitor 停止；子 agent 运行期间收不到自己的 Monitor 新行与命令结束通知（Core 没有子会话的会话 actor，`session/remind` 只到主会话） | T48：经 Agent Host 的子会话送达，或把子 agent 的 Monitor 归主会话并在工具结果里说明 |
| I169 | R4 | `allowedHttpHookUrls`、`httpHookAllowedEnvVars` 按 Claude Code 语义跨层合并，项目层能放宽用户层的限制；`http` hook 不做 SSRF 检查（R4 E4，ADR-0055 第 8 条与否决项）。R4 不改：放宽只影响用户已在信任对话框确认的项目 hook，E3 修复后 `allowedEnvVars` 已进条目名 | **已落地（T47，ADR-0065）**：两份名单逐键取最高托管来源的整份值，空名单仍生效。移除托管键时恢复跨层合并。回归见 `piarc-config` 的 `managed_http_hook_lists` 测试。 |
| I170 | R4 | Windows 上 `piarc://open?path=` 接受 UNC 路径，打开前没有确认：Core 打开工作区时会访问 `\\host\share`（可能泄露 NetNTLM）（R4 E6） | W3 核对 Core 对 UNC 工作区的处理；T45 对来自链接的路径先经主进程原生确认，或拒绝 UNC 与 `\\?\`；**已落地（T45）**：`piarc://open?path=` 拒绝以两个分隔符开头的路径（UNC、`\\?\`、`\\.\`、`//host`），`launch.test.ts` 的 THR-13 用例；命令行与拖入的文件夹不变，W3 在 Windows 上核对 Core 对 UNC 工作区的处理；**W3**：Windows 实机 `piarc://open?path=%5C%5Cw3-nohost%5Cshare` 被主进程拒绝，Core 与 Agent Host 的日志里都没有该主机 |
| I171 | R4 | 配置诊断没有"将要运行什么"的总览：生效的 hooks（三种 handler）、skill 与子 agent 定义里的 hooks 与 `allowed-tools`、插件不在一处（R4 E7） | T41（配置诊断完善） |
| I172 | R4 | MCP 与终端的加固项（R4 M4–M9）：OSC 52 写剪贴板默认允许（架构 6.11 的决定），对模型运行命令的终端也一样，没有提示；终端写入、共享的"近期真实输入"按窗口而不是按终端与动作，`allowUnsafe` 由渲染进程给；取消共享与屏幕文件写入的竞态（`write_view` 与 `remove_view` 不共用锁，取消后文件可能被重写）；未共享的用户终端也保存明文 snapshot、默认权限、崩溃后遗留；MCP 结果的图片没有总量上限、server 的 stderr 尾部进工具错误；stdio server 的后代按关闭时的 PID 快照结束 | T45；**T45 评估，交 R5**：逐项处理（OSC 52 默认允许、真实输入按终端与动作、取消共享与屏幕文件写入的竞态、未共享终端的 snapshot、MCP 图片总量与 stderr、stdio 后代按 PID 快照）；**R5**：交 T48，逐项处理；其中"未共享终端的明文 snapshot"与"取消共享与屏幕文件写入的竞态"进入 R6 前完成 |
| I173 | R4 | 错误类型化（R4 Q2，R3 I128 之后的余项）：`piarc-config`、`piarc-exec`、`piarc-diff` 没有错误枚举，`piarc_config::{mcp::claude_state_servers, rules::PathMatcher::new, trust::TrustLookup::lookup}` 返回 `String`，`piarc-exec` 的 `TaskLog`、`TerminalTree`、`cwd` 返回裸 `io::Result`，`piarc-git` 的 `GitError`、`checkout::Error` 没有 `kind()`/`retryable()`，`piarc_web::ssrf::Allowlist::new`、`piarc_hooks` 的端口返回 `String` | T41（`piarc-config`）、T39（`piarc-exec`）、T42（`piarc-diff`、`piarc-git`）、T45（`piarc-web`、`piarc-hooks`）；**T39**：`piarc-exec` 部分落地（75ad53c：`TaskLog`、`read_chunk`、`TerminalTree::attach`、`CwdProbe` 返回带 `kind()`/`retryable()` 的 `piarc_exec::Error`，Core 经 `error::exec_error_object` 保留 `ENOENT` 等代码）；其余按原分派；**T45 评估，交 R5**：`piarc-web`、`piarc-hooks` 的错误枚举属代码质量；**R5**：交 T48；工程质量审查 Q5 另列出 `piarc-config` 的 `plugins/manifest.rs::read`（`Result<_, String>`）与 `piarc-telemetry` 的 `bundle.rs`、`zip.rs`（裸 `io::Result`），一并处理 |
| I174 | R4 | 平台分支散在业务代码里（R4 Q3）：Core `tool_io/exec.rs`、`exec/utility.rs`、`policy/assess.rs`、`hooks/launcher.rs`，`piarc-config/src/rules.rs`（`paths:` 是否区分大小写按 `cfg!(windows)`，而文件状态按卷判断：macOS 默认卷不区分大小写时 `SRC/a.ts` 不匹配 `src/**`），Agent Host `tools/paths.ts`、`runtime/session-helpers.ts` | T39 收进适配层；`rules.rs` 的大小写判据交 T41；**T39 转交 W3**：所列分支多数是 Windows 专有路径（Git Bash 的程序探测、`LANG=C.UTF-8`、MSYS 路径换算、hooks 的 PowerShell 回退），T39 在 macOS 上只能交叉编译、不能运行，搬进适配层后要在 Windows 上跑 `exec_commands`、`exec-windows-shells` 与 hooks 测试才算验证；T39 没有往业务代码新增平台分支（沙箱的平台差异在 `piarc_sandbox::platform`）；**W3 交 R5**：属于代码组织，W3 优先实机核对与缺陷修复，没有搬动；W3 新增的修复都没有在业务代码里加平台分支 |
| I175 | R4 | 原子写入与 `\\?\` 去前缀的重复实现（R4 Q4）：`piarc-core/src/terminal/bound.rs` 的 `write_atomically`（不 fsync、临时名固定）、`piarc-term` 的 `snapshot.rs`、`shell.rs`、Core `composer/attachments.rs`；`strip_verbatim` 有四份（`piarc-git`、Core `sessions/mod.rs`、`piarc-config/rules.rs`、`piarc-exec/cwd.rs`） | T45：Core 内改用 `piarc_secrets::atomic::replace`，功能 crate 内的副本按复用表同步语义；Windows 上 rename 覆盖正在被读的屏幕文件由 W3 核对；**T45 评估，交 R5**：原子写入副本属代码质量；**W3**：未单独压测 rename 覆盖正在读的屏幕文件，L4 的共享终端与读屏幕文件用例在 Windows 通过；仍交 R5；**R5**：交 T48；工程质量审查 Q6：`piarc-core/src/sessions/mod.rs` 的 `strip_verbatim` 副本对 `\\?\UNC\` 的处理与 `piarc_git::strip_verbatim` 不同，改用后者；复用表已补登（e64b420） |
| I176 | R4 | 定义了却没有生产调用方的接口（R4 Q6）：AHP `exec/background/list`、`exec/background/read`（Agent Host 不调用）、NAPI `terminalLastCommand`、`piarc_term::Session::{command, wait_command}`（只在测试中用却登在复用表）；依赖真实时钟的否定断言（`piarc-term/tests/pointer.rs:271`、`terminal/tests.rs:441`、`t34-terminal-tui.e2e.ts` 的 `waitForTimeout`） | T41 决定接线或删除；否定断言的计时交 T44；**T41 决定**：NAPI `terminalLastCommand` 与 Core `Terminals::last_command` 没有调用方，已删除（10fbeff）；`piarc_term::Session::{command, wait_command}` 保留为 shell integration 测试的支撑，复用表已改写；AHP `exec/background/list`、`exec/background/read` 删除（模型读后台输出走 Read 输出文件），连同只剩 schema 导出的 `TerminalCommand` 类型与依赖它们的 16 处测试断言（任务归属的检查改到真实路径）交 R5 执行；**R5**：删除 `exec/background/list|read` 交 T48（协议与 16 处断言一起改）；否定断言的真实时钟另见工程质量审查 Q4（`t40-plugins.e2e.ts:155`、`t43-keyboard.e2e.ts:77`），同交 T48 |
| I177 | T39 | ADR-0057（Windows 命令隔离）已于 2026-11-21 由用户采纳：到 Beta 维持现状（权限规则 + Job Object，界面提示不可用）；MXC `processcontainer` 列为 Beta 之后的候选，需要一个评估任务：从 `mxc-sdk` 源码自建并以 ETW 核对遥测关闭；先用作 Agent Host 的第二道防线（模型请求、会话 JSONL、npx 拉起的 MCP server 照常）；Bash 等 Git Bash 问题（MXC #1061、#1729）修复或改用 PowerShell / BusyBox 版 MinGit 后再进容器；系统不支持时明确提示不可用。ADR 第 5 条的实验：`windows-11-arm` 与本机虚拟机上的 ProcessContainer 探测、标准用户运行、Model 2 加本地代理的网络边界、Git Bash 管道与 `npm ci`/`cargo build`/`pip`、Job Object 嵌套、非管理员调用 `NetworkIsolationSetAppContainerConfig` | R6（Beta 发布评审）之后安排评估任务，实验代码不进发布产物；ADR-0057 的重新评估条件之一提前出现时提前安排；满足全部条件才以实验性、默认关闭的选项引入 |
| I178 | T39 | 后台命令与 Monitor 在沙箱中被 Seatbelt 拒绝的文件操作不进结果说明与审计：`sandbox_report` 只在前台命令结束时按输出识别（代理拒绝对所有命令照常审计） | T45 安全收口时决定是否在任务结束时扫描输出文件尾部并补审计与完成通知的说明；**T45 评估，交 R5**：在任务结束时扫描输出文件尾部补审计与说明；**R5**：交 T48（任务结束时扫描输出文件尾部补审计与说明） |
| I179 | T39 | Pi 1.5.2 的 `SettingsManager.withLock` 读设置也经 proper-lockfile 在 `.pi/` 下建 `settings.json.lock`；Agent Host 定稿配置因此单独放行这个名字（`.pi` 其余仍受保护），不放行时 13 个 L2 场景的压缩失败 | 升级 Pi 时复核锁文件的名字与位置（`crates/piarc-sandbox/src/seatbelt/agent-host.sbpl`），变化时更新模板与 golden |
| I180 | T39 | ADR-0057 接受了 Windows 上没有 OS 级沙箱：经批准的命令可以写工作区外与外传数据，Agent Host 没有第二道防线（架构 10.3） | T45 的威胁模型与安全测试把它列为已接受风险，并核对设置页、环境栏、配置诊断的"不可用"提示仍在；**已落地（T45）**：威胁映射 THR-03、THR-05 的已接受风险（ADR-0057），测试 `CAP-SANDBOX-WINDOWS-001`（设置开启沙箱与自动批准时命令仍出卡、配置诊断标"本平台不生效"，Windows CI 运行） |
| I181 | T40 | 插件的 mods、LSP、monitors、channels、themes、output styles、workflows、`bin/`（加进 Bash 的 PATH）、`userConfig`（安装时填写的配置值与 `${user_config.KEY}`）与 `dependencies` 列为不支持；hook 进程拿不到 `CLAUDE_PLUGIN_ROOT`、`CLAUDE_PLUGIN_DATA`、`CLAUDE_PLUGIN_OPTION_*` 环境变量（只在命令文本中替换） | `bin/`、`userConfig` 与 hook 环境变量按需求评估，建议 T48；mods 不支持（架构第 6.7 节） |
| I182 | T40 | 插件 skill 与命令文件的 `allowed-tools`、hooks 不生效（不在包的可执行项里，ADR-0058 第 12 条）；Pi 包的扩展不在子 agent 的会话里加载 | 需要时把它们纳入可执行项（逐项确认），由 T48 评估 |
| I183 | T40 | 配置诊断还没有插件来源的展示：诊断 API 能从各组件的 `plugin` 字段与 `packagesList` 得到来源，界面未列出 | T41（配置诊断完善）；**已落地**（T41，ADR-0059）：诊断按来源类别列出插件与 Pi 包（`config_diagnostics/sources.rs` 的 `packages`） |
| I184 | T41 | 用量的目录价只在 Core 见过某模型的 `models/list` 之后才有（打开过会话、设置页或生成报告时有运行中的 Agent Host）；从未出现在这些列表里的模型在用量页显示"未知"，直到再次列出 | 可接受的现状；需要时让生成报告在没有运行中 Agent Host 时临时起设置 Host 取一次目录，交 R5 评估 |
| I185 | T41 | 全量 L2 并行时，T13 的设置监听（FSEvents）事件可能迟到几十秒：ConfigChange 已改为每个输入前核对，不受影响；配置诊断页的自动刷新、skills 与命令变化后的 `resources/reload` 仍依赖它 | R5 评估是否让这些消费方在使用前同样核对（或改为轮询少量固定文件）；**R5**：负载下（本机负载均值约 5–6）`crates/piarc-core/tests/state.rs` 的 `editing_settings_while_running…` 在 3 次全量 verify 中超时 2 次（20 s 内没有设置事件），单独运行通过：设置监听本身在负载下迟到，不只是 L2 并行。交 T48：配置诊断与 `resources/reload` 的消费方在使用前核对文件（同 ConfigChange 的做法），测试改为等确定的信号；不放宽等待时间 **已关闭（1b15296）**。注册监听目录期间，Core 继续重载设置和投递事件，每 2 秒核对设置层文件。Agent Host 在运行前核对技能与输出风格，打开的诊断页在恢复焦点时重读，可见期间定时复查。阻塞监听注册的回归、原先超时的两条配置编辑用例和默认并发全量均通过。 |
| I186 | T42 | 代码高亮的明暗配色跟随系统的 `prefers-color-scheme`（`transcript/use-color-scheme.ts`），不跟随应用的主题选择：系统为浅色、应用选深色时，Changes 面板与 transcript 代码块的 token 用浅色配色画在深色底上，对比度不足（`tmp/evidence/T42/` 的 `comments-saved-dark.png` 可见） | T43（无障碍与对比度）：让 `useDarkScheme` 读 `<html>` 的 `data-color-mode`，或在主进程按偏好设置 `nativeTheme.themeSource`；**已落地（T43）**：`useDarkScheme` 按应用的主题选择（`system` 时才看系统），代码高亮另换为高对比度主题（`transcript/highlight/themes.ts`，ADR-0061） |
| I187 | T42 | 可操作通知的实机核对：macOS 横幅与按钮的截图需要终端有"屏幕录制"权限（本机 `screencapture` 报 could not create image from display，T42-A06 标 blocked）；Windows Toast 按钮的实机点击 | macOS 截图由用户授权屏幕录制后用 `PIARC_CAPTURE_NOTIFICATION=1 PIARC_EVIDENCE_TASK=T42 npx playwright test -c apps/desktop/playwright.config.ts t42-notify --project dev` 补拍；Windows 并入 W4 **已关闭**。macOS 正式通知横幅和展开按钮截图、原生点击及通知不可用时的独立降级测试均已补齐，见 T42-A06。 |
| I188 | T43 | VoiceOver 实际操作核对未做：`docs/engineering/accessibility.md` 第 3 节的 10 项读屏清单需要人在 macOS 上开 VoiceOver 逐项操作，T43 时用户不在场（T43-A10 标 blocked）；自动化已覆盖行名称、节流播报、审批卡焦点与 axe | 用户按清单操作后把结论填入 VoiceOver 一列，问题登记后由 R5 或后续任务修；Narrator 与 NVDA 由 W3 按同一清单执行；**W3**：讲述人与 NVDA 两列由用户实机核对，全部通过；VoiceOver 一列仍待用户 **2026-11-24**：已有四项的部分 macOS 原生字幕，按用户要求结束旁白；逐项结果及剩余实测范围见无障碍文档第 3 节。 |
| I189 | T44 | 渲染进程重载或崩溃后，transcript 0.1–0.2 s 内重新可见、回合不中断，但正在流式输出的那条回复要到回合结束（约 7 s 后）才重新出现：新文档只拿到快照里已完成的条目，没有补上进行中条目已流出的文字（`scripts/perf/probe-recovery.mjs` 的 `streamingReplyMs`） | 第 11 章"≤ 2 s、会话不中断"按 transcript 可见计，已达标；进行中条目的补齐交 R5 评估（Core 快照带进行中条目的已有文字，或渲染进程重连后请求补齐） |
| I190 | T44 | 空闲 CPU：会话打开、终端面板显示 shell、什么都不运行时，应用全部进程加 Agent Host 合计约 3.6%（一个核心），其中 GPU 进程约 1.7%、渲染进程约 1.5%，窗口隐藏后几乎不变（隐藏时 rAF 回调与终端帧都是 0）；第 11 章阈值定为 ≤ 5% | R5 定位隐藏窗口下 GPU 与渲染进程仍在做的工作（`--cpu-prof`、CDP 追踪），目标是隐藏时接近 0；收紧阈值须有两个平台的数据；**R5**：在预算内（≤ 5%），并入 I222 的性能任务定位隐藏时 GPU 与渲染进程的工作 |
| I191 | T44 | 流式渲染（100 token/s、60 s）每帧主线程工作 p99 16.4 ms，超出预算 12 ms（T19 时 8.8 ms、T20 时 7.3 ms；15 s 的 PR 冒烟版 9.7 ms，回复越长越慢）。CPU profile 的热点是 TanStack Virtual 的 `_retryClampedAdjustment → getMaxScrollOffset`（读 `scrollHeight` 强制布局，行尺寸每变一次就读一次）。只替换渲染进程代码二分：T29（c575995）、T35（30f35f8）、T43 前后（b9a8045、当前）都是 p99 约 15.5 ms，回归不在 T29 之后的渲染进程代码；更早的渲染进程与当前主进程不兼容，没能测 | 交 R5：二分 T20–T29 之间的 Core 与主进程（事件批次的节奏与大小），并让跟随底部时的行增高不走被夹住的滚动调整（或每帧只调整一次）；修复后更新 Nightly 基线；**R5**：仍超出，阻塞 M4 的性能退出标准；并入 I222。性能审查 P10 指出 `LiveRegion` 每次行变更对整段文本 `words()`、`row-label.ts` 的 `excerpt` 先规整后截取，作为候选一并测量 **macOS 已达标（R5 收尾复核）**：8.41 ms，预算 12 ms。原始结果见 performance.md 第 5.2.2 节。 |
| I192 | T44 | 主进程内存（含 Core，空闲）相对裸 Electron 的增量 31 MiB（32.5 MB），超出预算 24 MB（M0 为 5–8 MB）：M1–M4 加进 Core 的子系统空闲时就常驻 | R5 逐项定位空闲时常驻的 Core 子系统（`vmmap`、`footprint`），能延后初始化的延后；预算不放宽；**R5**：仍超出，阻塞 M4 的性能退出标准；并入 I222 **macOS 已达标（R5 收尾复核）**：23.10 MB，预算 24 MB。原始结果见 performance.md 第 5.2.2 节。 |
| I193 | T44 | 打开工作区到 Agent Host 就绪（含恢复会话）0.96 s，在预算 1.0 s 内但只余 4%；T14 时 0.28–0.32 s（同为 release 构建，10 次） | R5 定位变慢的步骤（16.5 MB 的 Agent Host bundle 加载，MCP、skills、插件与 Pi 扩展的发现），Nightly 基线持续监控；**R5**：性能审查 P3 发现探针把汇总行算作第 11 个样本并取中位，而 T14 与第 11 章按 10 次最大判定；9f5ec0a 改为取最大。R5 的本机 Nightly 结果见 R5 评审第 1.2 节；并入 I222 **macOS 已达标（R5 收尾复核）**：903.90 ms，预算 1000 ms。原始结果见 performance.md 第 5.2.2 节。 |
| I194 | T44 | Agent Host 内存（1 个会话持续运行 mock 回合）202 MB，超出预算 150 MB（M0 为 165–168 MB，无会话 157 MB）；每多一个活动会话只加约 10 MB，超出部分在没有会话时就已存在（16.5 MB 的 bundle、Pi 与依赖的模块图） | R5 定位 Agent Host 启动后的常驻量（`--heap-prof`、按需加载 MCP、插件与扩展相关模块）；预算不放宽，技术债第 5 条；**R5**：仍超出，阻塞 M4 的性能退出标准；并入 I222 **macOS 已达标（R5 收尾复核）**：142.97 MB，预算 150 MB。原始结果见 performance.md 第 5.2.2 节。 |
| I195 | T44 | 8 小时长会话内存增长（第 11 章 ≤ 10%）没有本机实测：用户于 2026-11-22 决定去除 T44 的 8 小时长跑验收项（原 T44-A06）。负载、采样与判定已实现（`scripts/perf/long-run.mjs`，`node scripts/perf/run.mjs --lane long --absolute`），Nightly 每天在两个平台跑 1 小时的缩短版（预热 10 分钟、每 5 分钟采样）做趋势监控；几小时后才显现的缓慢泄漏可能发现不了 | 发布前（R6 或 M5 退出前）在本机或自托管 runner 上补跑一次完整 8 小时，结果写入 `docs/engineering/performance.md` 第 5.4 节 |
| I196 | T45 | Electron 45.4.1 于 2026-11-19 发布（锁定的是 45.3.2，2026-11-13），同一大版本的补丁 | R5 按架构第 13.4 节评估升级（四个目标的 L1/L2/L4 与性能），T45 未升级以免作废 L4 与性能基线；**R5**：不在评审中升级（会作废 L4 与性能基线）；随 T50 发布流水线或 I222 的性能任务升级，两者先到者做，按第 13.4 节复测四个目标 |
| I197 | T45 | L2、会话测试与 agent_host 测试给 Agent Host 设 `PI_OFFLINE=1`，应用不设：Pi 只在联网时才走的路径（包自动安装、远程模型目录）在这些测试里看不到，T45 修的 Pi 包安装缺口因此一直没被测到 | R5 评估 L2 去掉 `PI_OFFLINE`（mock 场景没有内置服务商的凭据，不会请求远程目录）；`crates/piarc-testkit/tests/egress.rs` 已按应用方式运行；**R5**：交 T48 评估（L2 去掉 `PI_OFFLINE` 后 mock 场景是否仍不请求远程目录） |
| I198 | T45 | Windows 与 Linux 上 Chromium 的拼写检查从 Google CDN（`redirector.gvt1.com`）下载 Hunspell 词典，只含语言代码，已列入 `docs/security/egress.md`，`t45-egress` 在 Windows 上允许这个主机 | W3 实测下载时机，决定保留或用 `session.setSpellCheckerEnabled(false)` 关闭；**W3**：已安装的应用启动、打开两个工作区与窗口后，数据目录没有 `Dictionaries`（启动时不下载）；首次在输入框键入时是否下载留给 W4 用 `t45-egress` 核对 |
| I199 | T45 | `t45-xss` 的设置面覆盖 MCP、扩展包与配置诊断；服务商名称、子 agent 定义、skills 页同样渲染外部文本 | R5 把同一断言扩展到这些页；**R5**：交 T48（THR-11 的覆盖），进入 R6 前完成 |
| I200 | T45 | 威胁映射 THR-09（更新通道被劫持）的"HTTPS"与"私钥只在需要维护者审批的发布环境中使用"两项是 `deferred`（任务 T50）：更新流程与发布流水线还没有 | T50 实现更新流程后为 THR-09 补测试（清单校验接进更新、篡改拒绝、受保护环境），把这两项改为 automated 并更新映射；T50 完成后 `check-threats.mjs` 会因待补项的任务已完成而失败，迫使更新 |
| I201 | W3 | Windows 的 M3 内存（`npm run perf:m3`，i5-1340P / 16 GB）：Agent Host 最大 163 MB（≤ 270），应用其余进程最大 576、563 MB，超出 Windows 预算 450 MB（GPU 进程约 205–216 MB，浏览器 143–150、渲染 150–156、网络 58）；私有工作集合计 256 MB（工作集 537 MB）。Nightly 的 `app-memory` 558 MB | 与 I26、I146 同一口径问题，用户经 ADR 决定口径或由优化达标；R5 汇总两个平台；**R5**：ADR-0063 采纳，Windows 按私有工作集判定（W3 测得 256 MB ≤ 450）；W4 用改过的 `perf:m3` 复测确认 |
| I202 | W3 | Windows 发布构建的安装包与安装后体积没有实测：本机没有 .NET SDK，`pack-windows.mjs` 只在 CI 运行；CI 的开发构建 `Setup.exe` 235.9 MB、安装后 551.5 MB（未裁剪，T44 的 `trim.mjs` 只在发布构建） | T50 的发布流水线在 CI 上量发布构建，并纳入 Nightly 的 `installer-size`、`installed-size`；超出时按 I41 裁剪 |
| I203 | W3 | Git 包源的克隆目录照搬源路径（`<pi>/git/local/<整条本地路径>`）：本地深路径的 `file://` 源让 git 目录超过 Git for Windows 约 220 字符的上限（`'$GIT_DIR' too big`，`core.longpaths` 管不到），安装失败；远端源（`github.com/<owner>/<repo>`）不受影响 | R5 评估：本地源的克隆目录改用短名（例如路径哈希），或安装前检查长度并给出说明；**R5**：Windows 专属，交 W4 实测并决定（短名或安装前检查长度） |
| I204 | W3 | Windows 上用户打开的会话终端是 `%COMSPEC%`（cmd.exe，`piarc_term::default_shell`）：PiArc 的 PowerShell 与 Git Bash shell integration 用不上，没有 OSC 133 命令边界与 OSC 7 目录 | T48 的终端完善：Windows 的默认 shell 改为 PowerShell 或可在设置中选择（需用户决定） |
| I205 | W3 | ConPTY 下含中文的长提示符（会话目录很深时）折行处，conhost 与 Core 对行末宽字符的落格不同：其后的字符被覆盖、行号差一（L4 用 `prompt $$$S` 避开，`t34-terminal-windows.e2e.ts`） | T48：在 Windows 实机写复现（piarc-term 的 ConPTY 用例），对照 conhost 的折行规则定位，必要时登记到 libghostty-vt |
| I206 | W3 | ConPTY 不转发程序的 OSC 11 查询：程序读不到 PiArc 主题的背景色（vim 等的背景检测退回默认）；OSC 8 链接与鼠标跟踪照常经过 | 记录为平台限制（`crates/piarc-term/AGENTS.md`）；Windows Terminal 的 ConPTY 直通模式可用时再评估 |
| I207 | W3 | 这台 Windows 笔记本（非基准机型，Defender 开启，缩放 150%）上超出预算的行：冷启动 1,075 ms、首 token 额外 122 ms、主进程增量 29.3 MB、流式帧 p99 49.3 ms 与长任务 25、万条滚动 35 fps、权限裁决 p95 12.4 ms（W1 为 8.4–8.9 ms，T23 之后的规则集与 Bash 分析）；`npm run verify` 中的权限计时用例在这台机器上因此失败 | R5：在 Windows 基准机型或 CI Nightly 上判定；流式帧与滚动和 I191 一起定位渲染进程，权限裁决在 Windows 上做剖析；**R5**：交 W4：在基准机型或 CI 的 Nightly（记录 `github-x64` 基线后）上判定；流式帧与滚动并入 I222 |
| I208 | T45 | T35–T44 的代码第一次上 Windows CI（7cbf259，[run 45011543956](https://github.com/Refinex-Space/PiArc/actions/runs/45011543956)），Windows verify 失败：L2 12 个场景（`plugin-agents`、`plugin-commands`、`plugin-hooks`、`plugin-mcp`、`plugin-skills`、`skill-invoke`、`hooks-m4-mcp-tool`、`subagent-worktree`、`worktree-archive-cleanup`、`worktree-parallel-sessions`、`worktree-session-create`、`worktree-session-rules`；可见原因有工具结果带 `\\?\` 前缀、worktree 会话的 Write 意外要审批、`git worktree list` 没有子 agent 的 worktree、MCP server 报未配置）；Vitest `agent-host/src/harness/skills/session-skills.test.ts`（paths skill）与 `apps/desktop/src/main/launch.test.ts`（"ignoring switches" 用例写死 POSIX 路径，Windows 上解析成 `D:\home\me…`）；cargo test `piarc-config` 的 `plugins::tests::a_plugin_lists_its_components_executables_and_unsupported_parts`；第 17 步因映射到的 `CAP-PLUGIN-001`、`CAP-PLUGIN-HOOKS-001`、`CAP-PERM-RULE-001` 有场景失败，`threat-coverage.md` 与 Windows 结果不一致（连带失败） | W3（已合并进 `macos/dev`）修了插件路径的 `\\?\`、worktree 会话被当作受保护路径、子 agent worktree、内置 npm、测试读到本机 `~/.claude/skills`，以及上述 Vitest 与 `piarc-config` 用例；`hooks-m4-mcp-tool` 不在 W3 的改动里。合并后由下一次 CI 的 Windows verify 复核，仍失败的交 R5；**R5**：W3 合并后 CI 运行 45024661885（de98771）的 Windows verify 结果见 R5 评审第 1.1 节 |
| I209 | T45 | Windows L4（同一 run）：`t35-windows` "a main window comes back where it was after a restart" 重启后宽度 1100 变 1024（`window-state.json` 正确，runner 屏幕只有 1024 宽时窗口被收进工作区）；`t44-recovery` 的 `expect.poll` 第一次调用就抛 `Render frame was disposed`（poll 不重试抛错，应用日志只有一次重载，重载本身正常）；被 THR-13 引用的两个终端 OSC 8 用例（`t34-terminal`、`t45-xss`）在 Windows 上按设计跳过 | R5：t35 按显示器工作区取期望位置；t44 的 poll 回调捕获重载中的错误并返回 false（W3 没有改这两个用例）。W3 的 `t34-terminal-windows` "the find bar counts matches; links open only when confirmed" 在 Windows 上覆盖 OSC 8 链接，但没有登记进威胁映射；R5 把它映射到 THR-13，并给 `t45-xss` 的 OSC 8 用例补 Windows 版；**R5**：t35 的窗口位置按工作区计算、t44 的 poll 容忍重载中的帧（cc4ec00）；运行 45024661885 里新增的 `t34-terminal-windows` "a hidden panel and a minimized window…" 两种形态失败（显示后不追帧，疑为 Windows runner 窗口不在前台时 Ctrl+\` 未送达），与 THR-13 的 Windows OSC 8 映射一起交 W4（I220） |
| I210 | T45 | macOS L4（同一 run）8 处失败：`t18-sessions` "rename, pin, filter, archive and delete sessions…"（dev）、`t34-terminal` "dragging, double and triple clicks select…"（两种形态）、`t35-windows` 窗口位置（`window-state.json` 与期望不符，两种形态）、`t35-worktrees` "starts a session in its own worktree…"（两种形态）、`transcript-scroll` "release, resume and button thresholds"（dev）；`t34-terminal`、`t35-windows` 在 T45 本地 dev 形态通过，原因未逐个查（同一 run 的 `preload` OS 沙箱用例是取指标的竞争，已由 T45 修复） | R5 逐个查原因并修复；修好前 CI 的 macOS L4 作业不会绿；**R5**：`t35-worktrees` 是真实缺陷（提示的长路径把按钮挤到侧栏下面，1024 px 屏），已修（cc4ec00，先有失败的 L4）；`t35-windows` 已改（cc4ec00）；`t34-terminal` 双击选词、`t18-sessions` 归档后临时目录、`terminal.e2e` 帧数三处本机在 1024×677 窗口下不能复现，交推送后的 CI 复核（下一个任务开工时，下载 trace 定位） |
| I211 | R5 | 沙箱的受保护路径不覆盖 bare 仓库布局与 `.git` 文件的 gitdir 重定向（安全审查 S2，待实测）：沙箱命令在工作区子目录写 `HEAD`、`objects/`、`refs/`、`config`，或写内容为 `gitdir: ../x` 的 `.git` 文件，用户之后在那里运行 git 会执行 config 里的命令 | T48：在真实 `sandbox-exec` 下写复现，再决定保护方式（保护这些名字的创建，或命令环境设 `safe.bareRepository=explicit`）；进入 R6 前完成 |
| I212 | R5 | 原生确认框直接显示 Core 或页面给的文字（安全审查 S4、S7）：插件确认的项名与沙箱确认的域名没有长度与条数上限，不处理控制字符与双向控制字符，可以伪装或把真正要看的项挤出可见区 | T48：主进程对确认框的每项截断、显示双向控制字符（同 `transcript/reveal.ts` 的规则）并写总数；进入 R6 前完成 |
| I213 | R5 | 插件更新后已确认项按名字保留（安全审查 S6）：扩展入口与 hook 引用的包内脚本内容可以整个换掉而名字不变，仍视为已确认；更新与安装没有原生确认、不显示新旧提交 | T48：确认记录绑定提交或完整性，内容变化的项重新确认，或更新时经原生确认显示 `旧 → 新`；进入 R6 前完成 |
| I214 | R5 | 沙箱代理的加固（安全审查 S9、S10）：代理在 `127.0.0.1` 上没有认证，任何本机进程都能触发域名卡、卡片不显示发起的命令、没有频率限制；地址检查不挡 IPv4 兼容地址（`::a.b.c.d`）与 NAT64（`64:ff9b::/96`） | T48：每会话令牌（`Proxy-Authorization` 进沙箱环境）、卡片带命令与并发上限、补两类地址 |
| I215 | R5 | 工作区内的目录来源包对文件工具没有保护（安全审查 S13，待核实）：Accept edits 下 agent 能改包里被 hook 引用的脚本或扩展入口，下次加载时执行 | T48：已安装包的 `path` 进文件工具的受保护写路径，补 L2 |
| I216 | R5 | 性能门禁的余项（性能审查 P4、P6、P7、P9、P11 与待核实项）：小值指标的 `floor` 让相对阈值远大于 10%（AHP 往返约 +104%）；event-channel、terminal 等探针忽略退出码、可能读到上次的输出文件；`main-loop-p99` 的负载约 100 事件/秒，远低于 M0 的 10 万/分钟；FileChanged 的 500 ms 轮询与"无轮询"的写法；PR 流式探针 15 s 未在 `how` 写明；权限裁决探针不覆盖沙箱路径 | I222 的性能任务按多次运行的方差重定 `floor`，探针退出码进 `errors` 并在运行前清掉输出文件，登记 s2 的事件循环为指标，第 11 章写明"未配置 FileChanged 时" |
| I217 | R5 | 无障碍审查的余项：状态清单漏项（终端粘贴确认框、沙箱网络卡与 MemoryImport 审批变体、菜单、Toasts、快捷键录制态、信任对话框的变体等）与覆盖检查按文件计数可被绕过（A1）；审批卡答复后焦点落到 body、第二张卡不取焦点（A7）；终端查找条与重命名框每次渲染抢焦点、关闭标签与评论编辑后焦点丢失（A8–A10）；diff 表没有名称（A11 余项）；虚拟列表里的 `role=alert` 行重挂载时重复播报（A12，待读屏核实）；Toasts 动态插入 live region、8 s 自动消失（A13）；composer 候选框没有 combobox 关联（A15）；`role=tab` 没有方向键（A16）；`Dialog` 的可聚焦选择器（A17）；相同文本不再播报（A19）；溢出检查覆盖面（A20） | T48（无障碍补修与状态清单补登），T51 的 Beta 验收按 `docs/engineering/accessibility.md` 第 3 节复核读屏 |
| I218 | R5 | i18n 检查的盲区（无障碍审查 A4 余项）：只查 JSX，`.ts` 文件、带插值的模板、三元表达式的字符串分支、主进程的函数调用实参不查；实际漏网的有 `src/main/main.ts` 的 `dialog.showErrorBox('PiArc could not start', …)`（Core 加载失败的对话框只有英文） | T48：扩展 `check-i18n.mjs` 的规则并修掉漏网项；Core 加载失败时没有 `AppShell`，用独立的双语常量 |
| I219 | R5 | 插件模块的同步 I/O 与静默忽略（工程质量审查 Q2、Q11、Q12）：`plugins/mod.rs`、`fetch.rs` 在 async 函数里直接 `remove_dir_all`、`canonicalize`、读写文件，`let _ =` 没有注释，卸载时删数据目录失败不进结果；`FileWatch.paths` 只给测试读、`SandboxTestNetwork` 与 `open_sandboxed_session` 在生产代码里导出；整文件 macOS 门控的测试没有 NOT RUN 说明 | T48 |
| I220 | R5 | THR-13 的 OSC 8 对策在 Windows 上没有运行的测试（工程质量审查 Q3，同 I209）：映射的 `t34-terminal` 与 `t45-xss` 的 OSC 8 用例在 Windows 跳过，`t45-xss` 的跳过理由写"Windows 变体在 W3"但没有变体；`t34-terminal-windows.e2e.ts` 的链接用例没进映射 | W4：补 `t45-xss` 的 Windows 变体（PowerShell 或 node 输出转义序列）、把 Windows 用例加进 THR-13 的映射并更新跳过理由 **已补实现及映射**：Windows 正常链接和拒绝未知协议的真实终端用例已接入，发布探针独立于 L4 结果。双平台 CI 证据由 T45-A02 跟踪。 |
| I221 | R5 | 超长的说明与源文件（工程质量审查 Q8、Q9）：`crates/piarc-core/AGENTS.md` 138 行、`apps/desktop/AGENTS.md` 122 行（上限 120）；`piarc-store/src/index.rs` 1,017 行（M4 越线）、`piarc-config/src/skills.rs` 1,271 行；T42 的 Core 侧约定（`policy/notify.rs`、`policy/notebook.rs`、通知答复只能仅本次允许或拒绝、审计来源 `notification`）没进 AGENTS.md | 下一个往这些文件加内容的任务先拆分（同 I165 的约定）；T42 的约定由 T48 补进 `crates/piarc-core/src/tool_io/AGENTS.md` |
| I222 | R5 | M4 的性能退出标准未达标的行（macOS 本机，非基准机型）：流式帧 p99 16.4 ms > 12 ms（I191）、主进程增量 32.5 MB > 24 MB（I192）、Agent Host 202 MB > 150 MB（I194）、打开工作区到就绪按 10 次最大判定（I193，R5 的测量见评审第 1.2 节）；应用全部进程合计按 RSS 超出（I26，口径见 ADR-0063）。PR 与 Nightly 门禁在 CI 上原来不判任何值（性能审查 P1，9f5ec0a 修复），CI 两个 runner 类别还没有基线 | 新增一个性能达标任务（计划变更，需用户确认排期；建议在 T46 之前或与 M5 并行、R6 之前完成），处理 I190–I194、I216，并在推送后从 CI 工件记录 `github-arm64`、`github-x64` 的 PR 与 Nightly 基线 **macOS 预算已闭环**，五次 PR 和本机完整 Nightly 通过。GitHub 托管 runner 的基线及 W4 实机项仍按平台跟踪。 |
| I223 | R5 | 实现 ADR-0064（用户采纳）："信任"项目的决定经主进程原生确认，列出将生效的可执行项（取自 Core 的信任视图，同一版本），信任对话框的"信任"直接触发它，取消答 `cancelled`；暂不信任与撤销不确认；`t45-ipc-hardening` 加入伪造的信任决定，THR-02、THR-11 的映射各加一行，`t18-trust` 等用例代答原生确认 | M5 内的单独小任务或并入 T48，R6 之前完成（实现前 I79 的残余风险仍在） |
| I224 | T46 | `npm run l3`（Claude Code 2.1.318）在 T46 之前就有的缺口：`config-diag-sources` 与 `hooks-m4-*` 六个 L2 场景（T41）既没有 L3 镜像也没有在 `tests/l3-allowlist.yaml` 排除；`perm-plan` 有 5 条未解释差异，都是 PiArc 请求里的 `NotebookEdit` 工具（T42 加入，Claude Code 在 `-p` 下不声明它）。L3 不在 verify 中，只在 Nightly 运行，所以 Nightly 目前会失败。T46 只为自己的 `perm-auto-*` 场景加了排除 | R6 或下一个运行 L3 的任务：为这七个场景写 L3 镜像或排除理由，为 `NotebookEdit` 补 allowlist 条目（确认 Claude Code 该版本的对应工具） |
| I225 | T46 | T48 的 `PermissionDenied` hook 接入点：Core `crates/piarc-core/src/tool_io/policy/review.rs` 的 `ToolIo::reviewer_refused`（审查模型答 `deny`、`autoReview` 审计已写、拒绝结果交回模型之前；参数是本次调用的 `Call` 与审查结论 `ToolReview`）。只有审查模型的拒绝触发；超时、服务商错误、无法解析、不可用都转人工，不触发 | T48 在这里运行 `PermissionDenied` hooks（输入带审查模型、理由与类别），hook 的 `retry` 等输出按 Claude Code 的语义接入 |
| I226 | T46 | `audit_events` 没有统一的保留期限：T46 的 `autoReview` 行（每次送审一行，含截断的理由与输入哈希）与其他审计行一样随数据库保留，不自动清理（设计增补第 4.3 节） | R6 评估审计的统一保留期限与清理方式 |
| I227 | T47 | R5 推送后的 CI 运行 45036807604（提交 ee97d82）开工核对：`verify (windows-latest)` 两步失败：第 7 步 Windows clippy 报 `plugins/tests.rs` 的 `file_url` 未使用（只有 `cfg(unix)` 的用例用它，R5 的 8cdd10b 引入；T47 开工时已加 `#[cfg(unix)]`，本机 Windows 交叉 clippy 通过），第 8 步 `exec_commands` 的 `heredocs_and_syntax_errors_through_eval_on_windows` 断言输出以 `start` 开头，实际 bash 的语法错误行先于 `start` 到达（stdout 与 stderr 两个管道的先后在繁忙的 runner 上不固定，W2 起的用例此前在 Windows CI 通过）；`desktop L4` 两个平台各 3 处失败：macOS 是 I210 已登记的 `t34-terminal` 选区用例（两种形态）与 I32 的 `transcript-scroll` 阈值用例，Windows 是 `t34-terminal-windows` "hidden … shown again they catch up"（两种形态）与 `t18-sessions` "rename … survives a restart"（packaged）。R5-A01、T45-A02 因此仍为 blocked | W4：`exec_commands` 的输出顺序（合并两个管道或改为不依赖先后的断言须先确认 Core 的合并语义）、两个 Windows L4 用例在 Windows 实机复现；下一次推送后复核 Windows clippy。**bbc6b60 复核**：[Windows L4](https://github.com/Refinex-Space/PiArc/actions/runs/45119779192/job/137510807936) 的会话归档通过。T34 的 dev 用例等不到 PowerShell 报告子进程 PID；dev 和 packaged 两种形态重新显示面板后均只读到 tick 1。三项继续由 W4 核对。 **T47 收尾**：[9212335 的 Windows L4](https://github.com/Refinex-Space/PiArc/actions/runs/45159997698/job/137642677946) 仅终端隐藏后重显用例在 dev 和 packaged 各失败一次。此前 [8d31bf2 的 L4](https://github.com/Refinex-Space/PiArc/actions/runs/45141919344/job/137581947186) 还出现过 T18 会话归档与 T35 worktree 归档后目录仍在。W4 实机复核这些行为。Windows clippy、Git Bash 语法诊断及完整 verify 已通过。 |
| I228 | T47 核对 CI | [e7262b0 的 macOS verify](https://github.com/Refinex-Space/PiArc/actions/runs/45110810423/job/137482483262) 还报出两项：权限裁决延迟 p95 2.009917 ms（I103），L2 的 `sec-malicious-repo-new-item` 在提示步骤收到 `SessionNotFound`，随后能力文档与威胁映射检查随该场景失败。本机 e2ffefa 同一预算与场景均通过。 | 后续 CI 复核；如重现，分别沿 I103 和项目信任变化后的会话重开顺序定位。**bbc6b60 复核**：[macOS verify](https://github.com/Refinex-Space/PiArc/actions/runs/45119779192/job/137510807623) 的 L2 为 239 通过、3 项仅 Windows；权限裁决 p95 为 2.544375 ms，仍超 2 ms 预算，沿 I103 跟进。 **9212335 复核**：[macOS CI](https://github.com/Refinex-Space/PiArc/actions/runs/45159997698/job/137642677879) 的 L2 全部适用场景通过。权限裁决 p95 为 3.011083 ms；T33 的终端任务快照还出现一次 shell 提示符先后到达导致的不一致。本机同提交全量 verify 通过。 |
| I229 | T49 | Windows 跳转列表的任务栏和开始菜单实机验收 | W4：安装 Velopack 构建后依次打开两个测试工作区。右键任务栏与开始菜单中的 PiArc，核对最近顺序。依次选一个工作区、“新建会话”和“打开文件夹”，确认复用进程、原窗口草稿保留、没有自动发送。移除一个最近条目，再打开其他工作区，确认被移除的条目没有被重新添加。 |

## 技术债

评审任务（R1–R6）汇总的技术债，按影响排序。每条的细节、负责任务与检查时间点在对应的登记事项中。

| # | 来源 | 内容 | 影响 | 处理 |
|---|---|---|---|---|
| 1 | R1 | 委托的普通命令不在进程树里：取消或 Agent Host 崩溃后命令继续运行（Windows 上连命令本身也活着），执行路径的状态泄漏与竞态（I33、I56） | 孤儿进程可能继续修改工作区 | T17 |
| 2 | R1 | 终端输入不经 Core 权限裁决、发布构建带着原型终端；终端线程没有 panic 防护、`createTerminal` 同步阻塞主进程（I51、I55、I30） | 渲染进程被注入时可执行命令；终端静默失效 | T33、T34 已处理 I55、I51 与 `createTerminal`；原型页已于 T45 移出发布构建 |
| 3 | R1 | AHP 会话层的超时对账、恢复可中断性、单帧上限、握手前分派、过期 Kill（I58） | 会话集合在两端分叉、退出被卡住 | T14 |
| 4 | R1 | 凭据锁不绑定连接、租约不续期，刷新时可能丢失轮换后的 token（I23、I57） | 用户需要重新登录 | 已于 T21 处理 |
| 5 | R1 | 内存与体积超出第 11 章预算：进程合计、Agent Host 单会话、Windows 体积（I26、I41、I45） | M3/M4 退出标准不达标 | T44 |
| 6 | R1 | 沙箱代理没有连接上限与超时，不拦私网（I54） | 沙箱内命令可耗尽主进程的文件描述符 | 已于 T39 处理（上限与超时；私网不拦，写明理由） |
| 7 | R1 | 测试用固定时长等待、基准复制了 L4 的定位逻辑、供应链校验脚本没有测试（I32、I59、I60） | 偶发失败与检查失效 | T19、T34、T44、T50 |
| 8 | R1 | 渲染进程没有错误边界；`read_blob` 无大小上限（I50、I53） | 一条坏内容卸载整个界面；大文件占满主进程内存 | T19、T16（I53 已由 T16 落地） |
| 9 | R1 | `piarc-exec` 没有结构化 `Error`；`piarc-testkit/src/lib.rs` 含实现（T15 已移出 `parse_request`）；ESLint 进程边界规则覆盖面窄（I61、R1-Q11、I52） | 边界错误无法分类；规范一致性 | `piarc-exec` 已于 T39 处理（I173）；ESLint 进程边界规则已于 T45 补齐（I52）；T15 |

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

### 2026-11-16 W0 部分完成（提交 f278039）
- 环境：Windows 11 专业版 25H2（26200.9974）x64，i5-1340P / 16 GB / NVMe；VS Build Tools 2026（MSVC 14.51）、Git for Windows、Node 24.13.1；依赖与 `.tools/` 经本机代理安装；`gh` 由用户登录后读取 CI 日志与产物
- 交付：CI 失败的根因（release 夹具 `.dmg` 未入库）与 6 处只在 Windows 出现的测试问题（9d6b01b、8264191）；ConPTY 两处产品缺陷——自行退出无 `Exited`、继承的忽略 Ctrl+C（1c6750b，新 `tests/pty_windows.rs`、`console` 模块）；终端 L4 与 S7 基准的 Windows 版（15ce450）；L4 `agent-host-kill.e2e.ts`、`load-core` 的终端检查（83cada8）；Windows 进程环境检查 `process-env.ps1`（e8959fc）；S1–S10 报告的 Windows 部分、检查清单第 8 节、CLAUDE.md（7e2f310 与收尾提交）
- 实机（用户操作）：安全设置截图、Edge 下载、安装、微软拼音（composer WM1–WM4、终端 WT1–WT4 全部通过）、卸载；智能体检查安装位置与 AUMID、图标、mock 对话、`Update.exe apply` 0.0.2 → 0.0.1 → 0.0.2、卸载残留
- 验收：W0 13 项通过、2 项未达标（A04 事件循环延迟原始 p99 16.81 ms、A10 回显额外延迟原始 p95 6.86 ms，都是 Windows 计时器粒度与 ConPTY 抖动造成的测量口径问题，I44 交 R1）；前序任务关闭 T03-A03、T04-A09、T10-A01、T11-A10、T12-A04、A12、A14，T03、T04、T11、T12 改为已完成，T10 仍余 A11（macOS 拼音，R1）
- 决策：未写 ADR。补充型：`piarc-term` 的 `unsafe` 范围增加 Windows 专用 `console` 模块（编码规范 2.8）；不随附 `conpty.dll`；Windows 上 stdout 同步写的背压形态按平台断言，其余结论不变；A06 把卸载后留下的用户数据目录视为数据而非程序残留（I48），A07 以"本机无法观察"加原因关闭（I49）
- 遗留：I44–I49；I33 补充 Windows 证据（委托的 Bash 被取消后命令本身继续运行，T17 必须改用 `ProcessTreeSpawner`）；I47 要下一次 CI 的 arm64 `core-load`；用户需在 Windows 上推送

### 2026-11-16 T10 已完成（提交 e2c302d）
- 环境：macOS 26.5.2（MacBook Pro，BenQ 外接屏），已安装的开发构建 `/Applications/PiArc.app`（T12 构建 B）
- 交付：S7 报告第 8 节 T1–T4 的真实拼音结果（智能体经 computer-use 以前台键盘事件输入，截图 `tmp/evidence/T10/ime/`）
- 验收：T10 14 项全部通过（A11 由阻塞改为通过）
- 决策：无
- 遗留：I31 已落地；后台方式投递的按键不经过输入法，真实输入法核对必须用前台键盘事件（S7 第 8 节）。W0 的 A04、A10（Windows 测量口径，I44）仍交 R1，需要 Windows 电脑

### 2026-11-16 CI 核对（提交 3ae1d23 的运行 43855932047）
- 结果：`core-build`、`core-load` 四个目标与四个打包作业通过；win32-arm64 的加载检查报 `terminal ok`，I47 已落地
- 失败与处理：`desktop L4 (windows-latest)` 的 `terminal-tui.e2e.ts` vim 用例两种形态失败——runner 未设 `LANG`，Git 的 vim 在 `-u NONE` 下按 latin1 读文件、中文显示为字节转义（本机清空 locale 变量复现，54c63bd 用 `--cmd 'set encoding=utf-8'` 修复，Windows 待下一次 CI 确认）；`verify (windows-latest)` 的 `cargo test` 因同一原因失败在 `piarc-term --test pty_windows` 的 vim 用例，macOS 版 `pty.rs` 同修（I38 已落地）；`desktop L4 (macos-latest)` 的 `transcript-scroll.e2e.ts` "the wheel releases and resumes following"（packaged）离底 31 px，即 I32，按登记交 T19/T44
- 未推送：e2c302d、bdd540a、54c63bd 与本条记录

### 2026-11-16 R1 已完成（提交 6eef36d）
- 结论：**有条件进入 M1**，T13 可以开始。没有不通过的验证项，没有触发 ADR 的重新评估；前提条件 7 项（W1 复测 Windows 口径、T19/W1 的真实输入法与日文、M1 任务处理 I50 与 I53、I56–I59、T44 的内存与体积、T50 的首次运行放行、T33/T34 的终端），检查点 R2–R6，见 `docs/spikes/M0-summary.md` 第 9 节
- 交付：`docs/spikes/M0-summary.md`（总表、ADR 触发条件检查表、ADR-0015/0018 的 M0 事项、预算校准、登记事项归属）；`docs/reviews/R1-findings.md`（四个只读子代理的 48 条发现与处理）；12 个缺陷修复（渲染进程崩溃、终端孤儿与订阅归属、外链确认框、并发 blob、合并器下溢、Agent Host 断开后命令不取消、恢复会话丢失、心跳两处、工具请求的孤立代理项）；架构 v2.17（第 11 章逐行实测与校准、3.4、10.3、14、15.2、16 章同步）；`third-party/sources.json` 登记 Pi 移植代码与 Pi 字形；`testing.md` 登记网络与凭据库测试的例外；CLAUDE.md 精简；终端 L4 固定 UTF-8 locale
- 验收：12 项通过，0 项阻塞；经用户授权按校准口径改判 W0-A04、A10，W0 改为已完成（计划变更记录 v1.3）
- 决策：未写 ADR；预算收紧 3 行、放宽 2 行（主进程内存改为相对裸 Electron 的增量，macOS 进程合计 510 MB），原因写在架构第 18 章；Windows 的事件循环与回显改用对抖动稳健的口径；I19/I46 不新增独立请求通道
- 遗留：I50–I61（审查中范围较大的问题，已指派）；技术债 9 条；S1 macOS composer 的真实输入法核对交 T19；分支未推送

### 2026-11-16 T13 部分完成（完成提交 12ad055）
- 结果：13 项验收通过，T13-A02 阻塞（等待 Windows CI 的 Vitest 输出；macOS 上两个平台的路径纯函数与 `ready` 前设置均已验证）
- 交付：`piarc-store`（迁移框架、6 张表 + `session_files`、JSONL 流式解析、增量同步与重建；100 MiB 会话堆峰值 +14.08 MiB）；`piarc-telemetry`（UTC 按天轮转、保留 7 天、Core 与 Agent Host 分文件）；`piarc-config`（层级表、结构化 schema、合并、重载保留有效内容、写接口、信任查询入口、可执行项枚举与新增项）；`piarc-git`（主 checkout 解析）；`piarc-fs::watch`（notify）；`piarc-core`（`DataDirs`、`Storage`、`TrustService`/`trust/get`、`workspace_settings` 与 `core/settings` 事件、`restart_on_trust_change`）；`piarc-host`（计划内 `restart`）；NAPI（`dataDir`/`cacheDir`、`rebuildSessionIndex`、`projectTrust`、`decideProjectTrust`、`revokeProjectTrust`）；主进程 `platform/data-dirs.ts`；Agent Host `harness/project-trust.ts`（经 `resolveProjectTrust` 接管 Pi 信任）
- 决策：ADR-0025（补充）；`deny.toml` 为 notify 加 CC0-1.0 单 crate 例外；rusqlite 0.41.1（`bundled`）；Windows 交叉 clippy 需 `LIBSQLITE3_SYS_USE_PKG_CONFIG=1 SQLITE3_LIB_DIR=…`；设置校验用自写的结构化 `Shape`，不引入 JSON Schema 引擎；`piarc-config` 写文件自带原子替换（不能依赖 `piarc-secrets::atomic`）
- 验证：`npm run verify` 13/13；L4 138 passed、1 skipped；Agent Host 端到端 13 passed；Windows 交叉 clippy 通过
- 遗留：I62–I65；未推送

### 2026-11-17 T14 已完成（完成提交 eedccea）
- 结果：13 项验收全部通过；开工检查中 Windows CI 确认 T13-A02 通过，T13 改为已完成，同一运行发现的 I66 已修复
- 交付：`piarc-protocol`（steer、followUp、fork、排队表三种操作、getEntries、history；完整条目模型与 `item/updated`、`item/reasoning/delta`、`turn/retrying`、`session/queueChanged`、`harness/entry`；`queueItemNotFound`）；Agent Host（第 5.3 节完整投影与历史投影、golden 录制与快照、排队表、回放缓冲、出站单帧上限、并发 resume 去重、工具批次调度、中断补齐、重试覆盖）；`piarc-host`（resume/fork 跟踪、结果未知的创建对账、I58）；`piarc-core::sessions`（Hub、WorkspaceActor、SessionActor、快照任务、按工作区绑定的入站处理、预热与空闲回收、seq 缺口补齐、重启恢复、`transcript_window`、I62 接线）、`clock::ManualClock`、有序关闭关闭数据库（I66）、终端回调 panic 结算（I55 一项）；`piarc-store` 的会话状态列；NAPI 的工作区、会话、排队与 transcript 导出及 `.d.ts` 快照；`piarc-testkit` 的会话层端到端测试与预热测量
- 决策：ADR-0026（补充：回合、排队与中断后的对话形态）；架构 v2.19；I20 接受 Pi 的 `existsSync(cwd)`，Core 在创建前校验 cwd
- 验证：`npm run verify` 13/13；会话端到端 10 passed；golden 11 passed；预热 release 10 次最大 279.5 ms（打开并恢复 309.5 ms）
- 遗留：I67、I68；T14 的改动未在 Windows 上运行（I66 的修复待 Windows CI）；未推送

### 2026-11-17 T15 部分完成（完成提交 5546027）

- 结果：11 项验收中 10 项通过；T15-A09（Windows CI 上的 L2 步骤）待推送后的 Windows CI，标为 blocked
- 交付：`piarc-testkit` 的 `l2` 模块（场景格式与 `tests/scenarios/schema.json`、运行器、事件部分匹配、请求与文件断言、工具批次 Gate、并行 suite 与 JSON 报告）与自定义 harness 的 `scenarios` 测试目标；`piarc-devcli`（run/list、JSON 报告）；14 个首批场景；`tests/capabilities.yaml`（111 项、8 个仅客户端需求）、`scripts/plan/check-capabilities.mjs` 与生成的 `docs/product/capabilities.md`；verify 第 14 步 `scripts/ci/run-l2.mjs` 与 CI 上传 L2 报告；发布产物检查新增"无开发工具"；mock 请求增加工具结果内容；`parse_request` 移出 lib.rs（R1-Q11）
- 决策：自定义 test harness（不引入数据驱动测试库）；每个场景独立的 Core 与 Agent Host（不复用进程）；每个 mock 端点一个 Pi provider、按请求头选场景；`client_only` 列出由 L4 验证的需求；新增 `yaml` 2.9.0 开发依赖；架构 v2.20
- 验证：`npm run verify` 14/14；L2 14 passed；l2_runner 5 passed；发布构建布局检查 22/22
- 遗留：I69（T20 接入审批观测点）；T15-A09 待 Windows CI；未推送

### 2026-11-17 T16 部分完成（完成提交 ea75a25）

- 结果：11 项验收中 9 项通过；T16-A03（Windows CI 上的编码与换行测试输出）与 T16-A11（Windows CI 上的 verify 与 L2）待推送后的 Windows CI，标为 blocked。开工检查按 CI 运行 44031571343 关闭 T15-A09（T15 改为已完成），同一运行暴露的两处 T14 测试缺陷记为 I70 并修复（L4 打包形态已在 macOS 上验证）
- 交付：`piarc-protocol`（`FileDiff`、`fs/stat` 的 `read` 与 `unchanged`、`fs/read` 的 `requireFresh` 与 `encoding`、`fs/write` 的 `lineEndings`/`upload`/`diff`、`fs/spill`、`fs/pdf`、`fileChange.diff`、四个错误类别）；`piarc-fs`（`access` 受保护路径与需要询问、`Scope::check`/`key`/大小写探测、`FileStates` 与 `PathLocks`、`encoding`（encoding_rs + chardetng）、`atomic`、`write`、`spill`、`pdf`（lopdf 0.46）、blob 上限与流式复制、编码缓存）；`piarc-diff`（similar，hunk 与降级）；`piarc-core::tool_io::files`（状态表、上传、diff、`adjudicate`）；Agent Host（Read 行号、存根、PDF、notebook、非视觉模型去掉图片；Edit 的 `requireFresh` 与 `replaceAll`；Write 的 `matchFile`；上传分段；`harness/tool-results.ts`；投影带 diff）；L2 格式的 `fixtures`、`vision`、`expect.fixtures` 与 12 个 `tools-*` 场景、10 个能力 ID
- 决策：ADR-0027（补充）；架构 v2.21；PDF 改用 lopdf 0.46（pdf-extract 引入已停止维护的 ttf-parser）；agent-host 增加与 Pi 同版本的 `typebox` 直接依赖；Read 不参与结果预算；越界由 `outsideWorkspace` 改为需要询问（T20 前 `permissionDenied`）
- 验证：`npm run verify` 14/14（Vitest 823 passed、L2 26 passed、MISSING 0）；Windows 交叉 clippy 通过；对照测试 20 步一致；L4 `agent-host.e2e.ts`（packaged）通过
- 遗留：I71–I74；T16 的改动未在 Windows 上运行；未推送

### 2026-11-17 T16 已完成（CI 运行 44069688031）

- 用户推送后核对提交 cfe664b 的 CI：16 个作业全部成功。verify (windows-latest) 14/14，L2 26 passed（含 12 个 `tools-*` 场景）、MISSING 0；cargo test 无失败（含编码保真、写入失败与路径大小写的单元测试）。T16-A03、T16-A11 改为 passing，T16 改为已完成
- I70 确认修复：Windows 的 `lifecycle` 测试与 macOS、Windows L4 的 `agent-host.e2e.ts`（packaged）通过

### 2026-11-17 T17 部分完成（完成提交 d154ab3）

- 结果：13 项验收中 9 项通过；T17-A01、A11、A12、A13 的 Windows 部分待推送后的 Windows CI，标为 blocked（macOS 部分均已验证）
- 交付：`piarc-exec`（`limits` 阈值、`capture` 输出预算与流式落盘、`semantic` 语义退出码、`env` 登录 shell 环境与内部变量剔除、`shells` 的 bash / Git Bash / PowerShell 探测与参数、`cwd` 的 `BASH_ENV` 目录探针、`CommandRunner` 的超时与 SIGTERM → 宽限 → SIGKILL、drop guard）；`piarc-ports::ProcessControl::terminate`；`piarc-protocol`（`exec/run` 的 `shell`、`timeoutMs` 与结构化结果、`exec/output` 的 `skipped`、`exec/shells`、`commandExecution.execution`）；`piarc-core::tool_io::exec`（全部命令用 `ProcessTreeSpawner`、会话 shell 目录、显示窗口、`CommandEnv`、`core/notices` 的 `gitBashMissing`）；`piarc-fs::create_spill`；`piarc-config` 的 `shell.gitBashPath`；Agent Host 的 `tools/shell.ts`（自写 Bash 与 PowerShell，按 `exec/shells` 决定工具集）、投影的 `execution`、golden 重录；L2 运行器的准备好的登录 shell 环境与 10 个 `exec-*` 场景、10 个能力 ID
- 决策：ADR-0028（补充，修订 ADR-0020 第 1 条的 bash 部分：Pi 的 bash 工具截断方式、退出码判定与超时都改不了，改为 PiArc 自写，沿用 Pi 的参数与状态措辞）；架构 v2.22；cwd 用 `BASH_ENV` + `EXIT` trap（不改命令文本）；实时输出走 256 KiB 显示窗口（连接慢时丢旧数据，不拖慢命令）；命令结束时后台进程随之结束；`exec/run` 未给超时时默认 2 分钟；沙箱测试的退出信号由 9 改为 15（先 SIGTERM）
- 验证：`npm run verify` 14/14（Vitest 849 passed、cargo test 446 passed、L2 35 passed 1 skipped、MISSING 0）；Windows 交叉 clippy 通过；agent_host 端到端 14 passed（含对照测试 Bash 三步一致）；sessions 10 passed
- 遗留：I75–I78；T17 的 Windows 部分未在 Windows 上运行；未推送

### 2026-11-18 T17 的 CI 核对（提交 b533040 的运行 44116918422）

- 结果：core build、core load、四个打包作业通过；`verify (macos-latest)`、`desktop L4 (windows-latest)` 失败，`verify (windows-latest)` 卡住后被 60 分钟作业超时取消，`desktop L4 (macos-latest)` 随之取消
- 原因与修复：
  - Windows L4 的 packaged 形态 `agent-host.e2e.ts` 中 Bash 为 failed（"Tool Bash not found"）：Agent Host 在创建会话时问 `exec/shells`，此时 Core 还没登记该会话，答 `sessionNotFound`，Agent Host 按平台默认值（Windows 无 bash）建了工具集；macOS 的默认值恰好有 bash 而掩盖了问题，`tools.rs` 又过滤掉了这个请求。e377be8 让 `exec/shells` 不依赖会话（工作区入站也放行），e2e 改为断言它成功；7d8c5c0 把参数改为可选 `sessionId`（空结构体生成的空接口过不了 ESLint）
  - Windows verify 卡在 `timeouts_default_to_two_minutes_and_stop_at_ten`：Windows 上 tokio 在阻塞线程池读子进程管道，阻塞任务阻止暂停时钟自动前进，10 分钟的定时器永远不触发。2656691 给 `CommandRunner` 注入时钟（`with_clock`），测试记录截止时间并手动放行
  - macOS verify 的 `event_channel.rs` `ordered_shutdown_flushes_the_last_batch_then_never_delivers_again`（T04 的测试）：释放时间取自测试线程读到消息的时刻，繁忙的 runner 上会晚于关闭回调的时间戳。e377be8 改为在 `Drop` 中取时间
- 本次已在 Windows 上通过的部分：`piarc-exec` 的进程树测试（含按 `/proc/<pid>/winpid` 确认孙进程退出的超时、取消、后台进程、运行时关闭、50 MB）、`piarc-core --test exec_commands` 8/8（含 PowerShell 与 Git Bash 中文输出、`/c/` 路径转换后的 cd 保留）、`tool_io` 6/6；Windows 的 L2 场景没有跑到
- 本机：`npm run verify` 14/14；L4 全部 138 passed、1 skipped（含 packaged 的 `agent-host.e2e.ts`）
- T17-A01、A11、A12、A13 仍为 blocked，等下一次推送的 Windows CI；未推送

### 2026-11-18 T17 的第二次 CI 核对（提交 0aae401 的运行 44133509553）

- 结果：`desktop L4 (windows-latest)` 通过（含上次失败的 packaged `agent-host.e2e.ts`），Windows 的 core build 与打包通过；`verify (windows-latest)` 失败 2 步，其余 macOS 作业因此被取消
- Windows 上已通过：`piarc-exec` 全部测试（含改用注入时钟的超时测试）、`exec_commands` 8/8，L2 中 T17 的 8 个场景全部通过（`exec-windows-shells` 的 Git Bash 与 PowerShell 中文输出、`/c/` 路径转换后 cd 保留；`exec-timeout-kills-tree`、`exec-abort-kills-tree` 的子孙进程终止；`exec-cwd-carry-over`、`exec-output-budget`、`exec-exit-code-meaning`、`exec-env-internal-vars`、`exec-streaming-output`）
- 失败原因：T17 起 Windows 会话多一个 `PowerShell` 工具，四个旧 L2 场景（`provider-openai-wire`、`tools-model-sees-canonical-names`、两个 `trust-*`）与 `agent_host` 的 `tools.rs` 两个用例把工具列表写死为六个；`capabilities.md` 的差异只是这些失败场景让能力显示为"失败"。154c5ea 改为按包含检查规范名、按排除检查 Pi 原生名，端到端的工具列表随平台
- 本机：`npm run verify` 14/14
- T17-A01、A11、A12、A13 仍为 blocked，等下一次推送的 Windows CI；未推送

### 2026-11-18 T17 的第三次 CI 核对（提交 ca229c2 的运行 44209310729）

- 结果：两个平台的 `desktop L4`、全部 core build / core load / 打包通过；`verify (windows-latest)` 只有 `cargo test` 一步失败，L2 34 passed、2 skipped（T17 的 8 个适用场景全部通过）；`verify (macos-latest)` 只有 `cargo test` 一步失败
- 原因与修复（e11f37d，都是测试环境问题，T17 的功能代码不变）：
  - macOS `sandbox_commands` 的 `cargo_build_with_a_crates_io_dependency`：T17 起命令拿到调用方的环境，CI 作业设的 `CARGO_TERM_COLOR=always` 让 cargo 输出带颜色转义，"Downloaded itoa" 的子串检查落空（本机设同一变量复现）。测试的命令环境固定 `CARGO_TERM_COLOR=never`
  - Windows `parity`：对照测试的 Pi 原生 Agent Host 只有透传环境，没有 `ProgramFiles`，Pi 自己的 bash 查找退回 5 s 超时的 `where bash.exe`，繁忙的 runner 上偶尔超时（步骤 12、13 报 "No bash shell found"，步骤 14 正常）。原生一侧补上 `ProgramFiles`、`ProgramFiles(x86)`
- 本机：`CARGO_TERM_COLOR=always npm run verify` 14/14
- T17-A01、A11、A12、A13 仍为 blocked，等下一次推送的 Windows CI；未推送

### 2026-11-18 T17 已完成（CI 运行 44214484957）

- 用户推送后核对提交 9e6cd3e 的 CI：verify 两个平台 14/14 通过（Windows：Vitest 851 passed、cargo test 418 passed、L2 34 passed 2 skipped、MISSING 0），desktop L4 (windows-latest)、全部 core build / core load / 打包通过。T17-A01、A11、A12、A13 改为 passing，T17 改为已完成
- `desktop L4 (macos-latest)` 失败于 `transcript-scroll.e2e.ts` 的贴底用例（离底 21 px），即 I32 的偶发失败，T17 未改渲染进程；已在 I32 中补记，仍交 T19/T44

### 2026-11-18 T18 阻塞（等待用户确认视觉方向）

- 交付：Core 会话元数据命令（重命名、置顶、归档清临时目录、删除先关闭再删 JSONL 与临时目录，schema v2 `custom_title`）、信任闸门（有未确认新增项时不信任，I63）、客户端偏好读写（`client_settings`）；三个 Core 竞态修复（信任决定后立即建会话、Agent Host 启动中做信任决定、首个进程连上时恢复正在创建的会话）与启动同步后重发会话快照，各有失败在先的 testkit 用例；设计令牌管线（`design/tokens/`、`npm run gen:tokens`、verify 第 15 步：漂移、168 对 WCAG、品牌与资源）；ICU MessageFormat（intl-messageformat 12.1.4）中英目录；快捷键注册表；原生菜单（I11）；窗口外观（隐藏标题栏 + vibrancy / Mica + 覆盖层）；渲染进程 store（revision 门控、clientId 对账、细粒度订阅，happy-dom 渲染计数）；三栏窗口骨架与注册式右栏、面板区；侧栏分组、徽标、过滤、置顶、归档、重命名、删除；新建会话（乐观消息、失败回滚）；信任对话框；设置窗口（通用、外观、快捷键）；通知、Dock 角标、应用内提醒；`core/notices` 提示条；L4 流程 6 个文件；`npm run bench:t18`
- 验收：12 项通过；A03 阻塞（视觉关口），A04 阻塞（Windows 部分等 CI）
- 决策：ADR-0029（补充）：令牌管线、偏好存储、快捷键、本地化、信任闸门、信任重启在应答前生效、会话元数据；架构 v2.23
- 遗留：I79（信任决定没有原生确认，T45）、I80（信任变化可能漏掉刚打开、未登记路由的工作区）、I81（`runtime.rs` 超过 1,000 行，R2）；L4 用 `PIARC_TEST_MEMORY_KEYCHAIN` 让开发构建的保险箱主密钥放在内存（每次重新打包的 ad-hoc 签名都会触发钥匙串授权弹窗）；未推送

### 2026-11-18 T18 部分完成（提交 6b1d5f0）

- 用户在视觉关口确认视觉方向（中性冷灰 + indigo 主色、系统字体）：T18-A03 改为 passing，D3 的主色落实（需求规格第 7 节、架构 8.6、ADR-0029 同步），名称字标仍待定
- 验收：13 项通过，1 项阻塞（A04 的 Windows 部分：推送后看 CI 的 `desktop L4 (windows-latest)` 冒烟；实机外观在 W1）
- 未推送

### 2026-11-18 T18 的 CI 核对（提交 4fb3b28 的运行 44250455860）

- 结果：verify 两个平台通过；`desktop L4` 两个平台失败（其余作业通过）。Windows 的冒烟用例（`smoke.e2e.ts`，带 Mica 配置启动应用）两种形态都通过
- 原因与修复：
  - 新会话在第一条回复写入文件前没有标题，通知写成 "New session finished"、侧栏显示"新会话"（两个平台的 `t18-attention`）：会话 actor 记下发出的第一条消息，快照在索引还没有标题时用它；testkit 用例 `a_new_session_is_listed_under_its_first_message_while_it_runs` 先失败后通过
  - Windows 上用例结束时删除工作区目录 EBUSY（应用还占着 Agent Host 的工作目录与设置监听）：`workspaces` 夹具先关闭应用再删除，带重试
  - Windows 上评审用例用 CSS 属性选择器匹配含反斜杠的路径：改为按文件夹名称过滤
  - macOS 的 `core-events.e2e.ts` "a batch above 1 MiB" 偶发 "no Core test hooks"：钩子在 `app.whenReady` 后安装，`expectTestHooks` 改为等待最多 15 s
- 本机：L4 全量 154 passed、1 skipped（两种形态）
- T18-A04 仍为 blocked，等下一次推送的 Windows CI 全部通过后关闭；未推送

### 2026-11-18 T18 的第二次 CI 核对（提交 73f7181 的运行 44255962868）

- 结果：verify（macOS）通过；verify（Windows）、`desktop L4` 两个平台失败
- 原因与修复：
  - Windows verify：`piarc-core` 的 `secrets` 测试 `locks_serialize_writers_until_unlocked` 用 300 ms 的锁租期，慢的 runner 上租期在解锁前到期，第二个写入方提前拿到锁。该用例改用 30 s 租期；到期行为由同文件的 `a_lock_ends_after_its_lease_or_when_its_connection_ends` 单独覆盖（仍为 300 ms）
  - Windows L4 `t18-attention`："Object has been destroyed"：`focusMain` 在上一个窗口关闭时取到了已销毁的窗口。`focusMain`、评审用例的 `captureMain` 与前台轮询都先过滤 `isDestroyed()`
  - macOS L4 `core-events` "the app quits normally while Core is streaming events" 超时：T18 起主窗口在偏好读完后才打开，`openProbe` 用"下一个出现的窗口"拿到的是主窗口而不是探针。改为在打开前记下已有页面，取新出现的、地址是探针的那一页（同一用例开两个探针也能区分）
  - macOS L4 `transcript-render` "a streaming delta re-renders only the streaming row" 多渲染了 `history-21`：T18 的 `app.css` 的元素级规则（`box-sizing`、`body` 字体与行高、表单元素、`kbd`、`:focus-visible`）也作用于 T09/T10 的原型页，改变了行高与虚拟列表的测量。这些规则改为只在应用自己的窗口生效（`<html data-app>`，由 `main.tsx` 在主窗口与设置窗口设置），原型页恢复 T18 之前的样式
  - macOS L4 `transcript-scroll` "keeps the bottom in view while a reply streams"（packaged，离底 32 px）：已登记的 I32，本次未改
- 本机：L4 全量 154 passed、1 skipped（两种形态，重新打包开发构建之后）；`cargo test -p piarc-core --test secrets` 6 passed；ESLint、`tsc --build`、Prettier、`cargo fmt --check`、设计令牌检查、`npx vitest run apps/desktop`（215 passed、1 skipped）通过。未重跑完整的 `npm run verify`
- T18-A04 仍为 blocked；未推送

### 2026-11-18 T18 的第三次 CI 核对（提交 6b323e0 的运行 44264407935）

- 结果：verify 两个平台通过；`desktop L4 (windows-latest)` 通过（155 passed，两种形态，含 `smoke.e2e.ts` 以 Mica 配置启动与全部 `t18-*`）；`desktop L4 (macos-latest)` 只有 `transcript-scroll` "keeps the bottom in view while a reply streams"（dev，离底 36 px）失败，即 I32（已补记录）
- T18-A04 改为 passing（evidence 写 run 链接），T18 从"部分完成"改为"已完成"（按协议开工检查中"等待 Windows CI"的规则）
- I32 仍交 T19；macOS CI 在它修复前会继续间歇失败

### 2026-11-18 T19 已完成（验收提交 0b72964）

- 14/14 项通过。历史窗口与 Core 实时事件使用同一组行组件，覆盖九种 P0 行、思考状态、错误、工作状态和连接中断；支持复制 Markdown / 纯文本，以及整回合选择（含 steer、跨页与历史）。
- Composer 支持工作区文件提及、内置命令、图片与 PDF 附件、插话、排队、编辑删除、停止与未送达重发。用户确认归档保留附件副本，只清理临时输出；删除会话时一并清除附件。pi-ai 1.5.2 支持图像块，PDF 经 Core 提取文本。详见 ADR-0030、架构 v2.24 和两个模块的 AGENTS.md。
- 续做时修复了会话切换后重发丢失、相同历史条目 ID 在不同会话串用缓存、steer 切断回合选区、Agent Host 重启期间立即重试先于会话恢复，以及归档清掉附件副本的问题。T14 的 NAPI 纯文本调用继续可用。全量验证还定位到并发打开工作区时重复注册 FSEvents 的等待，改为批量注册后默认并发的 Rust sessions 20/20。
- 验证：`npm run verify` 15/15；Vitest 952 passed、1 skipped；L2 37 passed、1 个 Windows 专用、MISSING 0；`npm run package:desktop -- --flavor development` 后相关 Electron L4 108/108 通过。证据在 `tmp/evidence/T19/`（`verify.log`、`regression.log`、亮暗截图及本地 ego-browser 提及实测截图）。用户确认 S01 第 7 节的 macOS M1–M10 已实测通过。
- `npm run bench:t19`：M1 Max、60 Hz，真实路径 7,005 个 mock token / 67.58 s；帧主线程工作 p99 8.768 ms，超过 50 ms 的任务 0；万条滚动 59.996 fps；五次千条冷加载与已缓存切换最大分别为 63.9、29.1 ms。原始数据在 `tmp/evidence/T19/bench/t19.bench.ts-real-Core-transcript-budgets/timings.json`。120 Hz、4 倍 CPU 降速下 8 次测量最大离底 0 px。
- 只在 macOS 实施与验收；Windows CI 等用户推送，Windows 输入法实测属 W1。I67 的失败回合历史语义留 T27。下一个任务是 macOS 上的 T20。

### 2026-11-19 T20 已完成（验收提交 ee03128）

- 验收 A01–A14 全部通过。macOS arm64，基线 `1c8ad0e` 和收尾 `2730864` 的 `npm run verify` 均通过 15 项。收尾 L2 47 通过，另 1 项为 Windows 专有，能力覆盖 MISSING 0。逐项命令与输出见 `acceptance.json` 和 `tmp/evidence/T20/`。
- 交付：Core 纯裁决、审批账本、精确规则和审计，绑定到实际工具操作的授权，Agent Host 的预检、超时与中断处理、会话模式 entry，客户端四类审批卡、热键与阅读门控、原生确认和模式菜单。设置和账本字段见 ADR-0031。用户确认把项目的自动接受编辑与额外目录纳入信任快照。
- 参考：核对安装的 Pi 1.5.2 的 `tool_call`、`appendEntry`、中断和工具配对；Core 对照 Pi 的 MIT 编辑匹配语义校验实际写入，出处登记在 `third-party/sources.json`。UI 依据交互研究记录自行实现。
- 收尾修复：macOS 的设置监听首次注册与 Host 启动并行，注册后重读以覆盖启动期间的改动。预检中断时保留尚待补齐的工具项，在模型转换前过滤已丢弃的中断回复。严格 mock 的配对回归连续 6 次通过，默认并发 Rust 会话集成 24/24。
- 自动裁决 1,000 次 p95 0.526 ms（预算 2 ms）。Electron dev/packaged 相关 L4 共 34/34，重新打包后的审批专项 4/4；ego-browser 在本地假 Core 实际验证了阅读闸门、规则编辑与快捷键。仅使用测试数据。Windows 目标 Core/exec Clippy 已通过，原生 Windows 行为留 CI；macOS 的 PowerShell 场景通过测试工具验证 Core 的询问决定。
- 下一项为 macOS 上的 T21。本地提交，未推送。

### 2026-11-19 T21 已完成（验收提交 e5f3b65）

- 11/11 项通过。设置页支持内置服务商、Bedrock/Vertex、自定义端点与本地模型。自定义端点可选三种线协议，模型列表每行一个 ID。凭据经设置 Host 更新保险箱，异常退出后按变更记录恢复。模型选择、缓存代价、effort、图片降级与合规策略见 ADR-0032、架构 v2.26。
- 两种 mock 线格式各完成一次含工具的对话；切换模型与 effort 后用实际请求验证重启恢复。四项 T21 能力已接入 L2。真实付费服务商未调用。
- 开工与收尾 `npm run verify` 均通过全部 15 项。修正 NAPI 声明与一个样本的格式后最终门禁全绿；L2 49 项通过、1 项仅适用 Windows。T20 自动权限裁决 1,000 次独立复测 p95 为 0.429416 ms，预算保持 2 ms。
- Electron 开发和打包形态的 T21 与 preload 专项 18/18；扩展回归 32 项中一项在 mock 编译等待时超时，构建完成后原用例独立通过。ego-browser 使用本地测试数据实际操作，证据在 `tmp/evidence/T21/`。Windows 目标 Core/Host/NAPI/testkit 交叉 Clippy 通过，Windows 凭据管理器实测交 W1。
- 下一项为 macOS 上的 T22。本地提交，未推送。

### 2026-11-19 T22 已完成（验收提交 9843eb5）

- 11 项验收全部通过。开工和收尾 `npm run verify` 均为 15/15；macOS 完整 L2 59 通过、1 个 Windows 专用场景按平台跳过。T22 两种线格式的 10 个场景全部通过，覆盖清单 MISSING 0。
- Core 收集用户、祖先和首次访问目录中的 memory，外部导入通过 T20 卡片取得精确许可。用户拒绝时模型收到说明与反馈。设置窗口可同时启用两个主文件。Agent Host 从分支恢复冻结的 system，文件及日期变化通过追加消息送达。见 ADR-0033。
- 实际请求验证开场到首条输入之间的编辑、跨回合与恢复后的原始 system 字节、Anthropic 两个缓存块，以及懒加载与去重。原创性检查比对 3533 份参考文本，253 词提示词的连续 10 词匹配为零。
- 回归修复包括 OAuth 测试会话的 Core 范围登记，以及上一回合完成通知误取消下一回合 memory 扫描。后者用确定性审批账本测试覆盖，队列用例连跑 20/20，完整 sessions 26/26。
- Electron 开发和打包两种形态的 T22 L4 为 4/4。用 ego-browser 操作了设置与审批卡。证据在 `tmp/evidence/T22/`。相关 crate 的 Windows 目标交叉 Clippy 通过，Windows 原生执行留待 CI。下一个任务为 macOS 上的 R2。

### 2026-11-19 · R2 M1 阶段评审（macOS arm64）

- M1（macOS）按 R2 口径达标。基线 d57c72e，验收提交 f63ac3d；11/11 项 passing。详见 [R2 评审](../reviews/R2-findings.md)。
- 两种严格 mock 线格式在 dev 与 packaged 的 Git 夹具中均通过；真实百炼 qwen-flash 5 次请求，按公布原价估算 ¥0.0021612。本地 deepseek-r1:7b 未发工具调用。仅使用隔离数据与获准的测试凭据。
- 四项独立只读审查和全部原文已归档。修复 13 项运行时问题，接受并实施 ADR-0034、0035、0036。I19 实测、I81 门面拆分、L2 能力映射和 W1 检查表见评审文件。
- 开工与最终 verify 均 15/15；最终 Electron L4 52/52，L2 61 passed、0 failed、1 Windows 专属，M1 planned 0、blocked 0、MISSING 0。两次 ego-browser 操作使用本地渲染器与测试数据；Windows x64 交叉 Clippy 通过，原生验收由 W1 执行。
- 可开始 W1（Windows 11）或 T23（macOS）。建议先 W1 核对 UNC、目录共享删除、Job Object、凭据与桌面交互，再回到 T23；W1 最迟在 R3 前完成。仅本地提交。

### 2026-11-18 T23 部分完成（验收提交 8a1f38b）

- 交付：`piarc-policy` 的 Claude Code 规则语法与全部 specifier、裁决阶梯（第 3–7 步与第 1、2、8 步插槽）、tree-sitter-bash 命令分析（拆分、包装与安全环境变量剥离、只读白名单、关键路径删除、按子命令的"总是允许"前缀）；Core 组装规则来源与信任、程序钉住、模式（plan 第 5 步拒绝、bypass 用户开关与原生二次确认、项目级 bypass/auto 忽略并审计、按工作区记忆）、AHP `policy/tools` 移除整体 deny 的工具；设置窗口"权限"页与审计筛选。见 ADR-0037、架构 v2.29。
- 验收：13 项通过，1 项阻塞（A05 的 PowerShell 场景 `perm-powershell-whole` 只在 Windows CI 运行；只读白名单部分已在 macOS 通过）。开工基线 b654341 与收尾 `npm run verify` 均 15/15；L2 67 通过、2 个按平台跳过，能力覆盖 MISSING 0。
- Bash 用例 73 条（12 类），随机输入 6,000 条无 panic；release 构建自动裁决 1,000 次 p95 388 µs（预算 2 ms）。Electron dev 与 packaged 的 T23、T20、preload L4 22/22；ego-browser 用本地假 Core 与测试数据操作了权限页与审计。证据在 `tmp/evidence/T23/`。
- 收尾修复：Agent Host 端到端 harness 应答 `policy/tools`（不接入 Core 权限服务）；A10 增加重新打开数据库后读回模式的断言。macOS 上用占位 C 工具链（`scripts/dev/c-placeholder.mjs`）完成 Windows 目标的整个 workspace 交叉 Clippy。
- 登记 I82–I85（按参数匹配的规则、PowerShell 语法分析与别名、Windows 只读白名单依赖 Git Bash 探测、T20 时期的 `Write(路径)` 规则）；I78 不在本任务范围，保持登记。
- 下一项：macOS 上的 T24；Windows 上的 W1 同时核对 A05 与 I84。本地提交，未推送。

### 2026-11-18 T24 已完成（验收提交 ae5c8e6）

- 交付：`piarc-config` 加入 `~/.claude/settings.json`、`.claude/settings.json`、`.claude/settings.local.json` 三层（ADR-0005 顺序，同一套信任与项目模式过滤），键映射表 `claude::SETTINGS_KEYS` 是合并与诊断共用的唯一判断（M2 生效 `permissions.allow/ask/deny/defaultMode/additionalDirectories`），写入一律拒绝 `.claude/` 与 `.claude.json`；`CoreConfig.home` 取代 `memory_home` 并经 `DataDirs::layers` 到达所有设置读取；`.claude/rules/` 与 `~/.claude/rules/` 作为 memory 文档载入，`paths:` 条件 rules 经 `fs/memory` 新增的 `files`/`rules`/`inactiveRules` 在首次读写匹配文件时以 `piarc.memory` 消息送达、`piarc.memoryRules` 记账；配置诊断 Core API、NAPI `configDiagnostics`、设置窗口"配置诊断"页；权限页提示永不匹配的 `Write(…)` 等规则（I85 落地）。见 ADR-0038、架构 v2.30。
- 验收：11/11 通过。开工基线 363b0d6 与收尾 `npm run verify` 均 15/15；L2 70 通过、2 个按平台跳过，新增 `config-merge-order`、`config-untrusted-project`、`config-rules-paths`，每个场景前后比对 Claude Code 配置快照；能力 CAP-CONFIG-COMPAT-001、CAP-CONFIG-DIAG-001、CAP-CTX-RULES-001 改为 active，MISSING 0。Electron dev 与 packaged 的 T24、T23、T22、preload L4 24/24；ego-browser 用本地渲染器与测试数据操作了诊断页。Windows 目标整个 workspace 的交叉 Clippy 通过。证据在 `tmp/evidence/T24/`。
- 第 10.2 节"新增可执行项再次确认"：T13/T18 的快照机制本来就扫描 `.claude/settings*.json` 的 allow、hooks、`enabledPlugins`，本任务未扩展。
- 范围外修复：T23 改了审批卡标签后 `t22-memory.e2e.ts` 仍用旧标签，已改为新标签（行为未变）。
- 登记 I86（家目录监听的重读频率）、I87（键映射表随官方索引更新）、I88（L2 运行器超过 1,000 行）。
- 下一项：macOS 上的 T25（hooks，把映射表中的 `hooks`、`disableAllHooks` 改为生效）；Windows 上的 W1 同时核对 T23-A05 与 I84。本地提交，未推送。

### 2026-11-19 T25 部分完成（验收提交 30a4f17）

- 交付：新 crate `piarc-hooks`（配置合并与跨文件去重、matcher、经注入 `ProcessSpawner` 的并行执行器、退出码与 JSON 的逐事件合并、长输出落盘、Stop 续跑上限 8）；Core 的 `HooksService`（与权限裁决同一份设置与信任、每个 handler 一行审计、`core/notices` 提示）接入裁决第 2、8 步（`updatedInput` 在规则之前替换参数，PermissionRequest 的改写重新裁决，`updatedPermissions` 只写会话与 `.piarc/`）、UserPromptSubmit 与 Notification；AHP `hooks/run`（能力 `hooks`）让 Agent Host 报告 SessionStart、SessionEnd、PostToolUse、PostToolUseFailure、Stop、PreCompact、PostCompact；`policy/evaluate` 结果与会话输入的新成员；键映射表 `hooks`、`disableAllHooks` 生效；客户端提示行显示 hook 消息与错误，配置诊断列出不运行的 hooks。见 ADR-0039、架构 v2.31、`docs/product/hooks.md`。
- 验收：12 项通过，1 项阻塞（A09 的 Windows 部分：进程树测试已过 Windows 目标交叉 Clippy，需推送后由 Windows CI 运行；macOS 已通过）。开工基线 aae28a4 与收尾 `npm run verify` 均 15/15；L2 81 通过、2 个按平台跳过，新增 11 个 `hooks-*.yaml`，8 个 CAP-HOOK 能力改为 active，MISSING 0。
- Electron dev 与 packaged 的 T25、T24、T23、T22、T20、preload L4 通过（packaged 跑 T25、T24、preload 9/9）；ego-browser 用本地渲染器与假 Core 数据操作了提示行（关闭、语言切换、5 条上限）与配置诊断页。证据在 `tmp/evidence/T25/`。
- 实现中的修正：Agent Host 的 `hooks/run` 遇到超过一个 AHP 帧的输入（大 Write）会让回合挂住，改为截断长字符串；PreToolUse hooks 可能运行超过 30 秒的传输期限，Core 改为运行前发 `policy/pending`（保留 T20 对无应答 Core 的期限）。
- 范围外调整：T24 的 L4 与 `piarc-config` 测试原先断言 `hooks` 为"待支持（T25）"，改为生效后的表现。
- 登记 I89–I94；I88 补充 `format.rs` 与 runner 的行数。
- 下一项：macOS 上的 T26（计划模式、任务清单、AskUserQuestion 与下一步）；Windows 上的 W1 同时核对 T23-A05、T25-A09 与 I84。本地提交，未推送。

### 2026-11-19 W1 部分完成（验收提交 b0a510f）

- Windows 11 专业版 25H2 x64，起点 b654341。起点基线红（两平台 ESLint、Windows `cargo test`、L4），用户决定并入 W1 修复；因内存不足第一次 verify 被系统终止，用户释放内存后重跑。
- 验收：12 项通过，1 项阻塞（A05 的 UNC：本机 SMB 客户端报系统错误 1702，I96）。最终 `npm run verify` 15/15；L2 本机 60 通过；全量 L4 修复前 199/199、最终构建 198/199（`t18-review` 悬停被实机鼠标打断，复跑通过）。用户实机核对微软拼音 7 项、Toast 与任务栏计数、安装；同意在凭据管理器与 `%LOCALAPPDATA%\PiArc` 留下正式条目。
- 修复 10 个 Windows 缺陷（均先红后绿）：verify 先 tsc 后 ESLint；Git Bash 挂载目录的 cwd（`pwd -W`）；PATH 中无权访问的条目；保留设备名与以点或空格结尾的名字；transcript 列表宽度变化后行重叠；S6 探针预检；子进程不带 `CREATE_NO_WINDOW` 弹出终端窗口；通知对象被回收导致点击无效；任务栏计数图标锯齿。另修 6 处只在 Windows 暴露的测试缺陷（Windows CI 因 fail-fast 从未跑到，I97）。
- 决策：ADR-0040（Windows 权限裁决 p95 ≤ 10 ms）、ADR-0041（Windows 小文件 AHP 往返 p95 ≤ 15 ms），用户采纳；架构 v2.29（并入本地时改为 v2.32）。报告 [W1](../reviews/W1-windows-m1-parity.md)。
- 遗留：I95–I100；I25 日文输入法、I49 SmartScreen 仍未验证。T13–T22 中没有因需要 Windows 而阻塞的验收项。下一步：用户推送后回到 macOS 做 T23。本地提交，未推送。

### 2026-11-19 并入 W1（macOS）

- 把远程分支上的 W1 提交合并到本地 T23–T25 之后（merge，保留双方提交号）。W1 的编号与本地撞号，按用户决定改 W1 一侧：ADR-0037、0038 → ADR-0040、0041，登记事项 I82–I87 → I95–I100，架构 v2.29 → v2.32；本地 T23–T25 的编号不变。
- 冲突处理：W1 在 Windows `safe_search` 中跳过无权访问的 PATH 条目，T23 已改为 Git Bash 探测与程序钉住，该函数不存在；同样的语义移到 `tool_io/exec/utility.rs` 的 `first_on_path`，W1 的 Windows 回归测试改为经 `probe_git_programs` 断言。权限裁决的延迟测试保留 T23 的步骤检查与 W1 的 Windows 预算（ADR-0040）。
- 合并后 verify 15/15；macOS 全量 L4 首次 15 个失败，均早于本次合并或由两边衔接产生，已修复：
  - T25：每个 Core 的第一次输入都先等 hooks 的登录 shell 环境（没有 hooks 也等），这期间第二次 Enter 与第一条竞争被拒为 busy（`t19-composer`、`t19-errors`）；改为 `plan` 选出 handler 后才解析（b44bcee，先红后绿的 Core 测试）。
  - T23：只读白名单让 `sleep`、`cat`、`echo` 在手动模式免审批，等审批卡的 L4 夹具改用 `env …`（`t18-attention`、`t19-composer`、`t19-security`、`t19-transcript`；W1 的 `w1-windows-shells` 同改，只能在 Windows 上验证）；探针补答 `policy/tools`（`agent-host.e2e` packaged）。
  - 虚拟列表变窄后行重叠：W1 的重测因比较旧尺寸、且滚动中 `measureElement` 不测量而无效，本机滚动条占宽度时 `t19-security` 偶发（撤掉 W1 改动 4 次 2 败、保留时 4 次 4 败）；新增确定性的 L4 变窄用例后修复（c2ae5c0，修复后 3/3 与 4/4 通过）。
- 修复后全量 L4 202 通过、5 个按平台跳过，`t18-review` 两个形态失败：本机运行测试的终端没有"屏幕录制"权限，`screencapture -l` 对任意窗口都报 `could not create image from window`（已写入 `apps/desktop/AGENTS.md`）。证据在 `tmp/evidence/merge-W1/`。
- W1 的起点 b654341 早于 T23–T25：T23-A05、T25-A09、I84 的 Windows 部分仍要推送后由 Windows CI 或下一次 Windows 会话核对。本地提交，未推送。

### 2026-11-19 推送后的 CI（macOS 会话）

- 运行 44514850116（b6405ce）：打包与 L4 全部卡在 Vite 解析不到 `@piarc/protocol`（T23 在主进程、渲染进程加了值导入，CI 打包前不跑 `tsc --build`），改为从源码打包（7c34902）；两个平台的权限裁决计时超预算；Windows 上 T25 长 context 的 hook 用例失败，补了诊断（78badbc）。
- 本地优化（不改"每次裁决读最新磁盘状态"）：hooks 的第 2、8 步复用本次裁决已读的设置（fccf1f2，生产路径 p50 725→560 µs），信任查找复用已解析的 checkout（1891d90，→515 µs）。
- 运行 44522160246（1891d90）：打包 4 个作业通过；L4 首次跑完（macOS 203/1 失败，Windows 207/2 失败）；T23-A05、T25-A09 的 Windows 部分通过，两任务改为已完成。仍失败的处理：
  - Windows hook 诊断显示 12,000 字符的 `-c` 被 Git Bash 截断（bash 报未闭合引号，exit 2 被当作阻断）。Bash 工具同样受影响；Windows 上改为经环境变量传命令（0e02852，I102）。
  - 计时：CI 上 p50 两次相差近一倍，四类调用同步变慢，判定为 runner 噪声；verify 第 8 步单独运行计时测试（8299a6f，I103）。
  - L4：首页在文件夹打开完成时重新挂载、清掉了回滚的草稿（真实竞态，294b76b，带确定性 L4）；Windows 徽标用例在渲染进程收到焦点前离开会话（f689ba1）；`r2-workflow` 启动超时登记 I101。
- 本机：verify 15/15，计时单独运行 p50 501 µs、p95 693 µs；Windows 目标交叉 clippy 通过。
- 运行 44533872761（03f42ae）：Windows 计时单独运行 p95 1.38 ms 通过，macOS runner 仍 2.67 ms（debug）；cargo 不再停在 piarc-core 后暴露两项：Windows 上 Bash 用例的虚构根 `/w` 被当作盘符（1afc48b），macOS runner 保留 `DYLD_*` 使 sessions 的 `sleep` 等审批（2406257）；计时按 T23-A13 改用 release 构建（41b5408）；Windows L4 的 `r2-workflow` 是第一个用 mock 的用例、在时限内现编 mock provider（05d226b，I101 已查明）。
- 运行 44542131720（05d226b）全部通过：两平台 verify 15/15（计时 release 单独运行 macOS p95 0.43 ms、Windows 1.19 ms），Windows L4 211/211，macOS L4 206 通过、5 个按平台跳过（macOS arm64 runner 容量不足，作业两次排队 15 分钟未分到机器被取消，第三次重跑完成），打包与 Core 构建、加载全部通过。

### 2026-11-19 T26 已完成（验收提交 23630e3）

- 交付：五个宿主工具（`EnterPlanMode`、`ExitPlanMode`、`TodoWrite`、`AskUserQuestion`、`SuggestNextSteps`）按握手能力 `planMode`、`todo`、`ask` 注册；Core 持有模式，ExitPlanMode 在 plan 模式必问（计划卡）、其他模式拒绝，批准时带后续模式切换并记入工作区，继续规划把反馈与 UTF-16 锚定的行内评论作为拒绝理由；`ui/ask` 把提问表单放进同一审批账本，超时取 `askUserQuestion.timeoutSeconds`（注入时钟）；批准的计划写 `piarc.plan`、任务清单存在 TodoWrite 结果的 `details`，注入接口 `currentPlan`、`currentTodos`，`session/history` 带 `harness`；`reminders` 模块（`piarc.reminder`，模式开关与 8 轮未更新清单）；客户端计划审批卡、计划面板（行内评论）、提问表单（替换 T20 占位）、任务卡与右栏任务卡片、下一步建议。见 ADR-0042、架构 v2.33。
- 验收：11/11 通过。开工基线 c163249 与收尾 `npm run verify` 均 15/15；L2 91 通过、2 个按平台跳过，新增 10 个 `plan-*`、`todo-*`、`ask-*`、`next-*` 场景（运行器加计划与提问答复、`fork`、`check_harness`、`same_tools_as`），CAP-PLAN-MODE-001、CAP-TODO-001、CAP-ASK-001、CAP-NEXT-001 改为 active，新增 CAP-PLAN-ENTRY-001、CAP-TODO-BRANCH-001、CAP-TODO-REMIND-001，MISSING 0。
- L4：T26 五个流程 dev 与 packaged 各 5/5；全量 L4 212 通过、5 个按平台跳过，`t18-review` 两个形态因本机终端没有"屏幕录制"权限失败（已知），`t19-errors` 两例因与 Windows 交叉 Clippy 同时运行、mock 编译等 cargo 锁超时，单独重跑 4/4 通过。ego-browser 用本地渲染器与假 Core 操作了中文界面的计划面板评论（偏移 9–25）与提问表单（Mod+Enter 提交）。Windows 目标整个 workspace 的交叉 Clippy 通过。证据在 `tmp/evidence/T26/`。
- 实现中的修正：T19 的滚动跟随把窗口内任何一次 `pointerup` 都当作 150 ms 的滚动输入，卡片按钮答复后的内容变化因此不贴底，停靠面板出现时尤其明显；改为只有按住滚动条后的松开才算（先写失败的单测）。`hooks-pre-tool-use` 的 `not_contains: three` 与新工具描述撞词，改了描述措辞。原创性检查扩大到工具描述与提醒文案（1,498 词，0 匹配窗口）。
- 登记 I104（`plansDirectory` 未在 T26 支持，R3 决定）、I105（注册表与 Core policy.rs 接近 1,000 行）；I01 评估为不加 TaskCreate 映射；I88、I89 补充行数。
- 下一项：macOS 上的 T27（上下文工程：system reminder、压缩与用量）。本地提交，未推送。

### 2026-11-19 T27 已完成（验收提交 b0b2641）

- 交付：提醒统一通道（`agent-host/src/harness/reminders.ts`：类型 `todoStale`、`fileModified`、`planMode`、`backgroundTask`、`memoryLazyLoad`、`rulesMatched`、`hookContext` 与压缩重注入的 `contextRestore`，带来源、长度、用量类别与回放数据），T22 懒加载、T24 条件 rules、T25 的 `additionalContext` 迁入并删除旧注入（`piarc.memory`、`piarc.hookContext` 不再写入）；外部修改用送达前的 stat 比对（Core `fs/changes`）；自写分节摘要提示接管全部压缩，阈值 W − min(O, 20K) − 13K 经 Pi 的 `compaction.reserveTokens` 生效，`autoCompactEnabled`/`autoCompactWindow` 生效，连续 3 次失败或无效熔断；压缩后按上限重注入 memory、计划、任务清单、skill 正文（`piarc.skillInvoked` 槽位）与最近 5 个文件（`fs/read` 的 `restore`），`fs/forgetReads` 清读取范围（I72）；按类别的上下文用量（`session/usage`、`session/getContextUsage`）；客户端用量环（75%/90%）、右栏上下文卡片与立即压缩、`/compact <重点>`。见 ADR-0043、架构 v2.34。
- 验收：12/12 通过。开工基线 d808f82 与收尾 `npm run verify` 均 15/15；L2 100 通过、2 个按平台跳过，新增 9 个 `ctx-*` 场景（运行器加 `context_window`、`max_tokens`、`compact.instructions`、`check_usage`），CAP-CTX-REMINDER-001、CAP-CTX-COMPACT-001、CAP-CTX-USAGE-001 改为 active，新增 CAP-CTX-COMPACT-002、003、CAP-CTX-CHANGED-001、CAP-CTX-CACHE-001，MISSING 0；agent_host 新增后台任务提醒与 skill 重注入两个端到端用例。
- L4：`t27-context` 与受影响的 `t26-harness`、`preload` dev 与 packaged 各通过；全量 L4 214 通过、5 个按平台跳过，`t18-review` 两个形态因本机终端没有"屏幕录制"权限失败（已知），`t26-harness` 任务卡片一例因上下文卡片抢了右栏第一个标签失败，已把上下文卡片排在任务卡片之后并重跑通过。ego-browser 用本地渲染器与假 Core 操作了中文界面的用量环三级、上下文卡片、立即压缩与熔断提示。Windows 目标整个 workspace 的交叉 Clippy 通过。证据在 `tmp/evidence/T27/`。
- 实现中的修正：T14 在 `SettingsManager.create` 之后施加的 `retry.provider.maxRetries = 0` 会被创建会话时资源加载的 `reload()` 清掉，实际没有生效；改为与压缩设置一起在每次运行前施加，并补了复现 Pi 行为的单测。Pi 在 `context_with_system` 之后才把 system 换成冻结的提示，用量改为按冻结文本计算。第一次收尾 verify 中 `piarc-core` 的 `editing_claude_code_settings_while_running…`（文件监听）在全量并行负载下超时一次，单独与整组重跑 5/5 通过，第二次 verify 全部通过。
- 登记 I106（架构第 4 章缺 ADR-0042）、I107（压缩设置无界面控件、熔断状态不持久化）；I16、I67、I72、I92、I105 已处理或更新。
- 下一项：macOS 上的 T28（检查点、回退与 Changes 面板）。本地提交，未推送。

### 2026-11-19 T28 已完成（验收提交 c849475）

- 交付：`piarc-checkpoint`（内容寻址对象库：分桶、去重、读时校验、钉住与回收；回退 / 撤销 / Changes 基线的计划函数；保留策略），`piarc-store` schema v5（`checkpoints`、`checkpoint_files`、`checkpoint_sessions`）；`piarc-fs` 在写入的路径锁内先存旧字节、`replace` 写回原语；`piarc-diff` 的 `revert_hunks` 与面板降级阈值；Core 的回合检查点、写入记录（AHP `fs/write` 的 `turnId`）、回退预览与执行（冲突逐个选择、逐文件结果、第一个失败即停、撤销）、Changes 与按文件 / hunk 丢弃（版本核对）、后台保留与回收；Agent Host 的回合起点 `from`、`session/rewind`（分支、摘要）、`session/switchBranch`、`session/fork` 的 `beforeTurn`、历史与 `session/branches` 中的分支点，分支变化后同一 id 重建会话；客户端的"回退到这里""从这里分支"、`/rewind`、回退对话框、Changes 面板与右栏改动卡片（Mod+Shift+D）、分支切换控件。Claude Code 的 `fileCheckpointingEnabled` 生效。见 ADR-0044、架构 v2.35。
- 验收：12/12 通过。开工基线 59e55a2 与收尾 `npm run verify` 均 15/15（收尾第一次 Prettier 报 4 个契约样本未格式化，8f339ee 后重跑通过）；L2 110 个场景（macOS 跳过 2 个）、MISSING 0，新增 8 个 `rewind-*`、`changes-*` 场景与 7 个运行器动作；CAP-CKPT-001、CAP-CKPT-REWIND-001、CAP-RV-CHANGES-001、CAP-RV-DISCARD-001、CAP-SESSION-FORK-001 改为 active，新增 CAP-REWIND-CODE-001、CAP-REWIND-SUMMARIZE-001、CAP-REWIND-BASH-001、CAP-CHANGES-HUNK-001。
- L4：`t28-rewind` 三个流程 dev 与 packaged 各 3/3；全量 L4 221 通过、5 个按平台跳过，`t18-review` 两个形态因本机终端没有"屏幕录制"权限失败（已知），`t18-sessions` 管理会话一例在全量运行中悬停后菜单按钮不可见、单独重跑 3/3 通过；`t19-composer` 的命令面板断言因新增 `/rewind` 更新为 4 条。ego-browser 用已构建的渲染器回放真实 Core 录下的应答，在中文界面实际操作了 Changes 面板（hunk 与文件丢弃、Mod+Shift+D）、回退对话框（选项切换、Esc 取消、执行、撤销）、发送新消息后的分支切换、从这里分支与 `/rewind`，以及深色模式。Windows 目标整个 workspace 的交叉 Clippy 通过。证据在 `tmp/evidence/T28/`（`l4/`、`ego/`）。
- 实现中的修正：重新打开以分支摘要结尾的会话时 T14 的中断补齐误追加中断标记，`interruption.ts` 改为只把 user、toolResult 与有回复的 assistant 当作末尾（补了单测）；ego-browser 核对发现回退后输入框没有焦点（对话框关闭时把焦点还给已随回退消失的按钮），改为对话框关闭后再放回消息，先写了失败的 L4 断言；空的 Changes 面板不再显示 +0 −0；协议类型 `ChangedFile` 与 T27 同名冲突，改名 `ChangesFile`。任务文件未提 `fileCheckpointingEnabled`，按架构第 6.14 节与键映射表在本任务落地。
- 登记 I108（三个 AGENTS.md 超过或到达行数上限）、I109（`fileCheckpointingEnabled` 无界面控件）、I110（词级 diff 与 UTF-16 偏移未实现，交 T42）、I111（回退与分支切换重连 MCP，T36 复核）；I88、I105 更新。
- 下一项：macOS 上的 T29（WebFetch、登录与模型设置补全、三档视图）。本地提交，未推送。

### 2026-11-20 T29 已完成（提交 7f9e79b）

- 交付：新功能 crate `piarc-web`（SSRF 纯函数与表驱动单测、只连接检查过的地址、每次重定向复查、同站跟随跨站返回、`FetchLimits` 上限、htmd 转 Markdown、`rule_host`）；AHP `web/fetch`（绑定已获准的同一调用与 URL，一次批准一次抓取，审计 `webFetch`）与 Agent Host 的 WebFetch 工具（经辅助模型提取，结果作为工具结果）；辅助模型通道 `harness/auxiliary.ts`，用量计入回合；OAuth 授权码与设备码登录（`models/login/*`、`models/logout`、`ui/loginInteraction`，能力 `login`；Core `Logins` 单活跃登录、15 分钟超时，凭据只进保险箱；mock 授权服务器 `piarc-mock-auth`）；每模型设置（显示名、上下文窗口、图片输入、默认 effort、Tool Profile）与辅助模型，存用户级 `modelProviders`，经 `core/welcome.modelPreferences`、`models/reload.preferences` 下发；低可靠性模型（无密钥本地端点）的保守 Tool Profile；transcript 普通 / 思考 / 详细三档视图；设置页登录与模型设置区块。见 ADR-0045、架构 v2.36。
- 验收：11/11 通过。A11 先因本机环境阻塞：提交 0134d9d 上 `npm run verify` 14/15，第 8 步只有 `piarc-core --test state` 的两个设置监听用例因本机 FSEvents 投递变慢失败（T28 收尾提交上同样失败，T29 未改动监听），`--no-fail-fast` 补跑 86 个目标 745 通过、仅这 2 例失败；清理磁盘（本仓库与另两个项目的 `target/` 共收回约 450 GB）、Spotlight 排除 `~/develop` 并重启后，7f9e79b 上 15/15 通过（I114 已解决）；L2 119 个场景 117 通过、2 个按平台跳过、MISSING 0，新增 9 个 `webfetch-*`、`model-*`、`login-*` 场景；CAP-TOOL-WEBFETCH-001、CAP-MODEL-SETTINGS-001、CAP-PROVIDER-OAUTH-001 改为 active，新增 CAP-MODEL-AUXILIARY-001、CAP-MODEL-PROFILE-001。
- L4（只跑本任务与受影响的规格，dev 形态）：`preload`、`t19-transcript`、`t21-models`、`t27-context`、`t29-login-models`、`t29-views`、`transcript-render`、`transcript-scroll` 共 25/25 通过。ego-browser 在回放环境中实际操作三档视图（键盘、深色）、中文界面的登录对话框（焦点、Enter、Esc 取消）、模型设置校验与保存、辅助模型；发现并修了三处：登录步骤到达后焦点不在对话框内（先写失败的 L4 断言）、reminder 行覆盖行内边距、可靠性原文未本地化。Windows 目标交叉 Clippy 通过；提示词原创性检查 0 匹配。证据在 `tmp/evidence/T29/`（`l4/`、`verify/`、截图）。
- 流程调整（用户要求加快推进）：`npm run verify -- --baseline` 在上次全量通过后只改了 `docs/` 时复用其结果；全量 verify 只在收尾跑一次，过程中跑局部检查；L4 只跑本任务与受影响的规格、只用 dev 形态（`protocol.md`、`scripts/dev/verify.mjs`）。
- 登记 I112（WebFetch 不走代理、不接受压缩编码，交 T38）、I113（`model`、`effortLevel` 键移到 T31）、I114（本机 FSEvents 投递变慢，A11 阻塞）；I100 落地，I71 复核。
- 下一项：macOS 上的 T30（L3 行为对齐基座）。本地提交，未推送。


### 2026-11-20 T30 已完成（提交 f52b5aa）

- 交付：`npm run l3`（`scripts/l3/`）一条命令完成前提检查、`~/.claude` 前后快照、PiArc 侧（`piarc-devcli l3`，L2 运行器的 L3 采集 `runner/l3.rs`）、Claude Code 侧（临时 `CLAUDE_CONFIG_DIR`/`HOME`、假 key、mock base URL、`--permission-prompt-tool` 夹具 MCP server）、剥离检查、归一化、按字段路径的 diff、allowlist 与报告（`tmp/l3/`）；mock 的 L3 模式（`Mode::L3`、`--l3`：只保留协议规则、只记白名单结构、流式辅助请求不占步数）；L2 新增 `{{workspace}}` 占位与审批的 `call`；`tests/l3/scenarios/` 12 个场景（权限 7、hooks 5）对照 21 个 L2 场景，`tests/l3-allowlist.yaml` 列出全部有意偏离（各附理由）与 11 个无法用 `-p` 复现的场景；剥离检查脚本与单测并入 verify；Nightly 工作流 `.github/workflows/l3-nightly.yml`（锁定 Claude Code 2.1.318，不用密钥，每侧两次，上传报告）。见 ADR-0046、架构 v2.37、`testing.md` 第 14 节。
- 首批比对发现并修正一处 PiArc 偏差：会话第一个提示的 UserPromptSubmit hooks 可能先于 SessionStart hooks 运行（重复运行时先后不定），Core 现在让 UserPromptSubmit 等该会话的 SessionStart 结束（先写失败的 L2 `hooks-session-start-order`，d353d75）。其余差异逐条写入 allowlist：工具集与参数风格（Pi 参数、延迟加载工具、Claude Code 独有工具）、请求选项与提示布局、命令替换与 allow 规则先于越界检查（R3 决定）、plan 模式与分类器、未信任项目的起始模式、hooks 输入缺 `prompt_id`/`effort`（T38）、`-p` 下 PermissionRequest hook 不生效与无 Notification。
- 验收：10/10 通过。`npm run l3 -- --repeat 2`（f52b5aa）12 个场景 0 个未解释差异、2749 个差异被放行、0 个过期条目，两侧重复运行一致，剥离检查 48 个文件通过，`~/.claude` 5278 项前后不变；PATH 无 `claude` 时提示并以 2 退出；缺理由与过期条目使命令失败；`npm run verify` 15/15，L2 118 通过、2 个按平台跳过。证据在 `tmp/evidence/T30/`。
- 登记 I115（hooks 输入的 `prompt_id`、`effort`，T38）、I116（命令替换与阶梯顺序，R3）、I117（工具集偏离的后续任务）、I118（L3 在 Windows 上运行，W2）、I119（`piarc-core` 的 AGENTS.md 超长，R3）；I01 落地。
- 下一项：macOS 上的 R3（M2 评审，依赖 T30 与 W1；W1 为部分完成，只剩 UNC 路径验证，开工时按协议判断是否影响评审）。本地提交，未推送。

### 2026-11-20 R3 部分完成（提交 8e2b4a2）

- macOS arm64，基线 483413b（复用 f52b5aa 的全量 verify）。W1 为部分完成，只剩 UNC（W1-A05），不影响 macOS 的评审；R3-A07 因 W1 不是"已完成"而 blocked，其余 10 项通过。
- 结论：**M2（macOS）达标，可以进入 M3**，见 [R3 评审](../reviews/R3-findings.md)。M2 能力 46 项全部有 L2 场景，L2 118 通过、2 个 Windows 专属；L3 在 42d1a44 对 Claude Code 2.1.318 的 12 个权限与 hooks 场景 0 个未解释差异，allowlist 逐条复核成立。
- 四个独立只读审查（权限与 hooks、回退与数据完整性、上下文工程、工程质量）共 40 条发现，修复 16 项缺陷，每项先红后绿：Bash 只读白名单 7 类绕过（`arch`、短选项簇与长选项前缀、`grep -e.`、`find -L`、`/dev/fd/..`、`$(< f)`、`uniq -c`，0257c93）、关键删除漏判（941fc37）、`hooks/run` 跨工作区（532820d）、`.piarc` 链到 `.claude`（56e2fb8）、信任清单的 hook 参数（d6bdefb）、PowerShell 重定向（31107ec）、对象回收竞态（b1f065d）、回退期间开新回合（b406451）、回退经链接写出（2aa6da1）、冻结的 system prompt 列出被拒工具（3f7587a）。
- 用户决定：接受 ADR-0047 并在 R3 实现（42d1a44，带通配的命令规则不放行越界路径，L3 少两条差异）；I93 增加用户级 hooks 环境变量白名单，交 T38。I104 交 T48，I107 维持不持久化。
- 整理：L2 运行器与格式校验拆分（e264e05，I88）、注册表拆出 `session-parts.ts`（e78571c）、三份超长 AGENTS.md 拆到子目录（60eaf18）、复用表补 M2 能力（da11683）、原创性检查覆盖参数描述与提醒句（cdaea4d，3,141 词 0 匹配）；架构 v2.38；登记 I120–I128，登记事项逐条关闭或指定任务。
- 全量 L4 224 通过、5 跳过；`t18-review` 因终端无屏幕录制权限失败（已知），`t26-harness` 的"下一步"是测试等待竞态（撤掉 D2 仍失败），改为等待实际请求后 40/40（8e2b4a2）。Windows 交叉 Clippy 通过。证据在 `tmp/evidence/R3/`。
- 下一项：macOS 上的 T31 与 Windows 上的 W2 都可开始；建议先 W2（R4 之前必须完成，并关闭 W1-A05），T31 可同时在 macOS 推进。本地提交，未推送。

### 2026-11-20 T32 部分完成（提交 ef39d43）

- 交付：Core 任务管理器 `piarc-core::tasks`（`TaskManager`：任务模型与状态机、`background_tasks` schema v7、`core/tasks` 带 `revision` 的快照、停止与权限范围、分段读取、应用退出记 `interrupted`、归档与删除清理）；`piarc-exec` 的 `TaskLog` 与 `OutputCapture::hand_over`；`exec/run` 的 `background` 与前台超时转后台（任务时钟计时、同一进程继续）、`exec/monitor`、`exec/background/list|read|kill`；完成通知挂起到送达、按类型与来源去重、在 prompt 前补送；Monitor 的批次、总量限速与空闲唤醒（`session/remind` 的 `key`、`wake`）；Monitor 走 Bash 规则与分析（不享受只读白名单），`Bash` matcher 的 hooks 匹配 Monitor；后台子 agent 登记为 `kind: subagent`、面板可停；Agent Host 的 `run_in_background`、`KillShell`、`Monitor` 与 `wake` 回合；客户端右栏后台任务卡、停靠面板（分段读输出、停止）、命令卡的后台状态、Monitor 事件行，IPC `stopTask`、`readTaskOutput`；L2 `bg-*` 5 个、`monitor-*` 4 个与 `exec-timeout-kills-tree` 改写、能力 ID 9 个；运行器 `advance_clock`、`stop_task`、`task_limits` 与 mock 的 `{{result:…}}` 占位符；会话层故障注入 `tests/sessions/tasks.rs`；L4 `t32-background.e2e.ts`。
- 验收：11 项通过，A04（进程树测试的 Windows 部分）与 A13（verify 的 Windows CI 部分）等待用户推送后的 Windows CI，标 blocked。`npm run verify` 15/15（ef39d43，Vitest 1430 passed、L2 143 passed 2 个按平台跳过）；Windows 交叉 clippy 通过；L4 t32 2/2 与受影响的 preload、t29-views、t31-subagents 13/13（dev 形态，截图在 `tmp/evidence/T32/`）；原创性检查 4,846 词 0 匹配。
- 决策：ADR-0049（补充）；架构 2.40。后台子 agent 的报告仍由 Agent Host 在同一提醒通道送达（ADR-0048 第 8 条不变），Core 只登记、停止与展示；Monitor 到时记为 `completed`；后台命令不随会话关闭结束。
- 登记 I136（T17-A01 描述需用户修改）、I137（挂起通知不持久化）、I138（唤醒开关与限值的入口）、I139（`core/tasks` 快照载荷）；I03 落地开关与限速，待 R4 确认默认值。
- 下一项：macOS 上的 T33（无头终端，依赖 T32）；Windows 上的 W2 仍可进行。本地提交，未推送。


### 2026-11-21 W2 已完成（提交 45124e4，Windows 11 x64，分支 `windows/dev`）

- 结论：M2 在 Windows 上达标，见 `docs/reviews/W2-windows-m2-parity.md`。L2 149 个场景中 145 个通过、4 个 macOS 专属跳过，MISSING 0；L3 对锁定的 Claude Code 2.1.318（本地平台包的 `claude.exe`）12 个场景 0 未解释、0 过期，`--repeat 2` 一致；M2 的 L4 17/17（dev 形态）；`npm run verify` 15/15。
- 起点基线是红的（CI 运行 44731794641、44868949621）：并入修复 7 个 Windows 平台缺陷，均先有失败测试——检查点路径标签（cafffc1）、Git Bash 程序探测失败被缓存与 `ucrt64`（91f9994）及提速（c54271b）、Monitor 分块输出丢失唤醒（db82eae）、归档时 hook 持有会话（c45ffdd）、`$USERPROFILE` 不算关键路径删除（6110364）、子 agent 场景的 Windows 工具集（82082b6）；另修 5 处测试问题。
- 用户在本会话要求认领其他"部分完成"任务的 Windows 侧：W1-A05（UNC 用 `C$` 管理共享补验）、R3-A07、T32-A04/A13、T33-A02/A12/A14、T34-A14 以本机 Windows 实测关闭（非 CI，evidence 已注明）；W1、R3、T32、T33 改为已完成，T34 仍有 A03（macOS 输入法）。
- 决策：L3 的 allowlist 增加 `platforms`（Windows 版 Claude Code 的工具集不同）；W2 与 macOS 上进行中的 T35 并行（用户安排），W2 检查点单列，未改 T35 的内容（86a8bf1 误勾选 T35 的检查项，45124e4 已恢复）。架构 2.47（W2 分支上为 2.43，合并时改号）标注 M2 的 Windows 达标。
- 登记：关闭 I96、I102、I118，I95 复测；新增 I163（pointer 测试只在 Unix）、I164（macOS CI 的 `bg-completion-reminder`；W2 分支上编为 I146、I147，合并时改号）。
- T35 的 Windows 侧（A10）：用户决定等 macOS 的 T35 完成第 8、9 项后在 Windows 上实测关闭。
- 下一项：macOS 上继续 T35；推送 `windows/dev` 后在 macOS 合并。

## 计划变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-11-14 | v1.0 | 初版：62 个任务（T01–T51、W0–W4、R1–R6），772 个验收项 |
| 2026-11-14 | v1.1 | 应用图标资产放入 `design/brand/`（取自 PiDeck）；T12 新增图标验收项 T12-A14，T35、T50 补充托盘图标与许可证条目；共 773 个验收项 |
| 2026-11-16 | v1.3 | 用户在 R1 中授权按第 11 章校准后的 Windows 测量口径改判 W0-A04、W0-A10（只改 `status` 与 `evidence`，描述不变），W0 由部分完成改为已完成；验收项总数不变 |
| 2026-11-15 | v1.2 | 用户授权在 T04 中决定 ADR-0019，决定采纳；T04-A06 由"超过阈值的批次以 `ArrayBuffer` 转移、主进程侧缓冲区已分离"改为"1 MiB 以上的批次完整到达渲染进程，基准记录主进程转发耗时，同期事件循环延迟 p99 ≤ 16 ms"（任务文件与 `acceptance.json` 同步修改）；验收项总数不变 |

### 2026-11-20 T31 已完成（提交 7ec1971）
- 交付：子 agent 定义的发现、解析与合并（`piarc_config::agents`，五个来源、警告与带行号的问题、项目级模式限制）与内置 general-purpose、Explore、Plan；`Agent` 工具与同进程子会话运行时（`runtime/subagents.ts`、`subagent-session.ts`、`session-runtime.ts`：上下文隔离、隐藏声明加闸门的工具过滤、深度 3 与并发 8 的唯一计数、`maxTurns` partial、前台与后台、中断与关闭、重启恢复）；模型别名表（`modelAliases`、`providers/aliases.ts` 的 `resolveModel`、设置页别名一节、辅助模型可选别名、`model`/`effortLevel` 作为新会话默认，I113）；Core 的子会话登记与链接（`tool_io/subagents.rs`：独立文件状态表 I73、模式取更严者、会话规则与检查点归主会话、审批卡来源、定义 hooks 限定作用域与信任、运行中不被空闲回收）、参数规则 I82 与 `piarc_policy::Error` I128、schema v6 父子索引、`subagent/*` 通知、Core API `listAgents`/`stopSubagent`/`subagentTranscript`；客户端子 agent 卡与只读子会话转录、审批来源、设置页 Subagents；L2 `subagent-*` 16 个与 `model-default-setting`，能力 ID 8 个启用；L4 `t31-subagents.e2e.ts`；会话层崩溃与空闲回收用例
- 验收：14 项通过，0 项阻塞
- 决策：ADR-0048（补充：定义由 Core 读、子会话经 `subagent/start` 登记、隐藏声明加闸门而非 `setActiveTools`、计数只在 Agent Host、超限不排队、后台不随中断结束、别名表在设置中由 Agent Host 解析、`advisorModel` 忽略、`agent` 交 T48）；架构 2.39；`Agent` 的 `model`/`effort` 写成 string enum（L3 无差异，`Agent` allowlist 条目删除，I117）；`sessions/session.rs` 拆出 `session/changes.rs`（I105）
- 遗留：I129–I135（暂未生效的 frontmatter 字段、`agent` 键、子会话增量、子会话 MCP 进程、子会话沙箱、类型列表刷新、辅助模型别名的工作区解析）；ego-browser 不能操作 Electron 窗口，前端改动经 Playwright 驱动开发构建验证

### 2026-11-20 T33 部分完成（提交 33f4bf9）

- 交付：`piarc-term` 的副作用回调（查询应答、标题、目录、铃声、OSC 133、剪贴板读拒绝与写可关、render hold 由 Core 计时结束）、读屏与分步搜索、OSC 133 命令记录与等待、帧格式第 2 版（滚动条、选区；`TermFrame` schema 与 L1 样本）、键盘（legacy、Kitty）、鼠标、粘贴、焦点编码、snapshot 三级降级、zsh/bash/PowerShell 的 shell integration、有界写队列与线程 panic 防护；`piarc-exec::TerminalTree`（macOS 按终端设备收集进程组，Windows Job Object）；Core 的 `terminal/`（会话终端作为 `terminal` 类任务、屏幕文件、共享校验、命令结束提醒与任务退出码、退出时保存 snapshot、关闭与有序关闭等进程树结束）；`exec/run` 的 `terminal` 与 Bash 的 `terminal` 参数、能力 `terminalTasks`；NAPI 的会话终端、鼠标、焦点、粘贴、读屏、搜索、终端信息导出，`createTerminal` 改为 Promise；渲染进程解析终端任务，S7 基准的 `--headless`。
- 验收：11 项通过；A02（Git Bash 与 PowerShell 的 OSC 133）、A12（进程树测试的 Windows 部分）、A14（verify 的 Windows CI 部分）等待用户推送后的 Windows CI，标 blocked。`npm run verify` 15/15（33f4bf9，Vitest 1438 passed、L2 145 passed 2 个按平台跳过）；Windows 交叉 clippy 通过；L4 t33-terminal、terminal、terminal-tui、t32-background 9/9（dev 形态，截图在 `tmp/evidence/T33/`）；无头 cat 100 MB 主进程事件循环 p99 1.40–1.52 ms；原创性检查 5,082 词 0 匹配；L3 用本机 Claude Code 2.1.318 跑 `perm-compound`，`Bash.params.terminal` 由新 allowlist 条目解释。
- 决策：ADR-0050（补充）；架构 2.41。实现中定下的补充：终端环境没有 locale 时补 UTF-8（macOS `en_US.UTF-8`），否则 bash 把键入的中文改坏；模型的命令结束时先挂提醒再把退出码写到仍在运行的任务上（L2 以此确定地等待）；模型的 bash 终端在 macOS 上关掉系统 bash 的 zsh 提示；scrollback 只按行数限制（libghostty-vt 默认 10,000 字节上限是 T10 遗留缺陷）；有序关闭等每棵进程树的宽限与 kill 结束（修复前忽略挂断的进程活过 Core）。
- 登记：I28、I55 已落地；新增 I140（L3 的 `KillShell`、`Monitor` 差异没有 allowlist 条目）。共享开关的界面与终端面板交 T34。
- 下一项：macOS 上的 T34（终端渲染器与终端面板，依赖 T33）；Windows 上的 W2 仍可进行。本地提交，未推送。

### 2026-11-20 T34 部分完成（提交 991f323）

- 路线：S7 的正式路线（fork 的 Canvas 渲染器由帧协议驱动），没有启用 xterm.js 退路。
- 交付：piarc-term 的选区手势、选区文本、视口滚动、OSC 8 链接、默认颜色与停拉唤醒（`vt/selection.rs`、写线程上的 `session/pointer.rs`，`Event::Output`）；Core 与 NAPI 的 `terminalScroll`、`terminalClearSelection`、`terminalSelectionText`、`terminalLinkAt`、`terminalSetColors`、`terminalFrame` 的 `park`、鼠标 `clicks`；协议 `TerminalEvent::Output`、`TerminalScroll`、`TerminalLink`；主进程终端 IPC 重写（会话终端归会话、近期真实输入防线、每会话 16 个与每窗口每终端一个在途拉帧的上限，`window.piarc` 去掉 `createTerminal`、新增 13 个终端命令与 `visibility` 应用事件）；渲染器（设备像素绘制、选区与查找高亮、链接下划线、光标闪烁与减少动效、Powerline、令牌颜色）、视图控制器（rAF 拉帧、停拉、可见性、适配、输入与输入法、指针、复制粘贴）、终端面板（标签、重命名、关闭、共享开关、查找、以文本查看、附加到消息、Ctrl+\`）、composer 片段胶囊、后台任务卡的“在终端面板中打开”；L2 动作 `open_terminal`/`type_terminal`/`share_terminal` 与场景 `term-user-share`、能力 CAP-TERM-SHARE-001；L4 `t34-terminal.e2e.ts`（7）与 `t34-terminal-tui.e2e.ts`（4）。
- 验收：12 项通过；A03（真实拼音输入法的实测截图，I141）等待用户在本机操作，A14（verify 的 Windows CI 部分）等待用户推送后的 Windows CI，标 blocked。`npm run verify` 15/15（991f323，Vitest 1452 passed、cargo test 875 passed、L2 146 passed 2 个按平台跳过）；Windows 交叉 clippy 通过；T34 L4 11/11 与受影响的 preload、terminal、terminal-tui、t32、t33、t19-composer、t18-settings、composer、external-links 通过（dev 形态，截图在 `tmp/evidence/T34/`）；S7 基准 cat 100 MB 主进程事件循环 p99 2.14 ms、回显额外 p95 0.68 ms、IPC 0.7 MiB/101 MiB。
- 决策：ADR-0051（补充）；架构 2.42。axe 发现并修复两处存量问题：主按钮文字对比度（全应用，I144）与 tablist 子元素；`window.piarc` 共 86 个函数。
- 登记：I30、I51、I59 更新（I51 落地）；新增 I141（真实拼音核对）、I142（W3 的 Windows 核对项与 t34 L4 的 Windows 版）、I143（重启后恢复终端的入口）、I144、I145（没有 htop，用 top）。
- 下一项：macOS 上的 T35（Worktree、并行会话、多窗口，依赖 T34）；Windows 上的 W2 仍可进行。本地提交，未推送。

### 2026-11-20 T35 部分完成（提交 c4094dd）
- 交付：`piarc-git` 的 git 运行器与 worktree（创建、基础分支、`.worktreeinclude`、`.gitignore` 追加、改动、删除保留分支、恢复）；`piarc-store` 迁移 8（会话的 worktree 列、`session_text` + FTS5 trigram 的 `session_fts`、增量与重建、搜索与高亮）；Core 的 `worktrees`（保留期清理、可注入时钟）、worktree 会话（文件根是 worktree、设置与信任来自 `SessionIo.project`）、子 agent `isolation: worktree`（`subagent/start` 的 `isolation`、`subagent/finish` 的 `worktree`）、`search_sessions`、`core/activity`、I80 的补发；NAPI 新增 worktree、搜索与 `runningWork`；主进程多窗口与窗口状态、菜单栏 / 托盘与退出确认、`piarc://` 与 open-file、拖入文件夹、Windows 右键菜单与 Velopack hooks；渲染进程的新建会话 worktree 选项、归档询问、环境栏 worktree、侧栏搜索与定位、在新窗口打开；托盘图标导出脚本；`npm run perf:m3` 与 `docs/perf/M3-memory.md`；L2 5 个新场景、L4 `t35-worktrees`、`t35-windows`
- 验收：10 项通过；A10（Windows CI）blocked，等用户推送；A11 failing：应用其余进程合计最大 576 MB，超出 macOS 预算 510 MB（Agent Host 238 MB，预算 270 MB，达标），登记 I146，预算不放宽。`npm run verify` 15/15（c4094dd，Vitest 1472 passed、cargo test 889 passed、L2 151 passed 2 个按平台跳过）；Windows 交叉 clippy 通过；T35 L4 6/6 与受影响的 preload、app-instance、smoke、t18-sessions、t18-attention、t20-approvals、t31-subagents 通过（dev 形态，截图在 `tmp/evidence/T35/`）；提示词原创性 5,118 词 0 处重合
- 决策：ADR-0052（补充）；架构 2.43；`window.piarc` 共 94 个函数；Claude Code 设置键 `worktree` 改标 T48（I148）
- 登记：I80 落地、I129、I43、I143 更新；新增 I146（M3 内存超预算，R4）、I147（W3 的 Windows 核对项）、I148、I149（菜单栏截图需要屏幕录制权限）、I150（runner.rs 超 1,000 行）、I151（worktree 需要仓库顶层）、I152（搜索命中回退前的分支、运行中定位）
- 下一项：macOS 上的 T36（MCP 共享连接池，依赖 T35）；Windows 上的 W2 仍可进行。本地提交，未推送。

### 2026-11-21 T36 部分完成（提交 ca3d873）
- 交付：PiArc 的 MCP 扩展替换 Pi 的（不加载 codemode，不读 `.pi/mcp.json`、`mcp-auth.json`）。Core 合并 local > project > user 的配置（`piarc_config::mcp`、`piarc_core::mcp`：`.mcp.json`、`~/.claude.json` 的 user 与 local、PiArc 用户与 `.piarc/` 设置，同名取整条，`${VAR}` 展开，SSE/WebSocket 标不支持，信任与按工作区的启停，schema v9 `mcp_servers`），AHP `mcp/servers|status|reconnect|setEnabled|login` 与工作区级通知 `mcp/statusChanged`（`core/mcp`）。Agent Host 的工作区连接池（`agent-host/src/mcp/`：租约、空闲断开、退避重连、工具缓存与 `list_changed`、roots 为工作区根与活动 worktree）、自写 stdio 传输（server 留在 Agent Host 的进程组，环境取命令环境并前置内置 Node）、超过阈值经 `ToolSearch` 延迟加载、instructions 进第 6 段与 `mcpChanged` 提醒、`requiresUserInteraction` 任何模式询问、OAuth 状态进保险箱 `mcp/<server>`、子 agent 的 `mcpServers`。设置窗口的 MCP 页、配置诊断的 MCP 部分、`agentHostProbe` 回答 `mcp/servers`。夹具：独立实现的 stdio 与 Streamable HTTP（含 OAuth）server，8 个 `mcp-*.yaml` 场景，能力 CAP-MCP-* 9 项为已实现
- 验收：13 项通过；A11（Windows CI）blocked，macOS 上 SIGKILL 与正常关闭两种情况都不留 server 进程，等用户推送。`npm run verify` 15/15（ca3d873，Vitest 1,524 passed、cargo test 915 passed、L2 159 passed 2 个按平台跳过）；Windows 交叉 clippy 通过；L4 `t36-mcp` 在 dev 与 packaged 两种形态通过（dev 连跑 3 次），受影响的 preload、t18-trust、t24-diagnostics、t29、t31、打包形态 `agent-host.e2e.ts` 通过；`t18-review` 在本机因终端没有屏幕录制权限失败（与 I149 相同，非本任务引起）；`npm run l3` 12 个场景 0 条未解释差异、0 条过时条目；提示词原创性 5,587 词 0 个匹配窗口
- 决策：ADR-0053（补充）；架构 2.44；`window.piarc` 共 98 个函数；server 不再继承 Agent Host 的 `PI_PACKAGE_DIR` 等内部变量（打包形态 L4 的断言随之改为"不存在"）；`~/.claude.json` 的 `mcpServers` 与 `disabledMcpjsonServers` 生效，`enableAllProjectMcpServers`、`enabledMcpjsonServers` 忽略，`allowedMcpServers`、`deniedMcpServers` 改标 T47
- 登记：I05、I40（落地）、I111（复核）、I117（T36 部分复核，并补上 T32 漏登的 L3 条目）、I129、I132（落地）、I150 更新；新增 I153（开工时远端 CI 两平台失败）、I154（Pi 扩展注册的 MCP server，T40）、I155（MCP 资源工具与 prompts，T40）、I156（`headersHelper`，T47）、I157（OAuth 状态按 server 名存键，同名不同地址会互相覆盖）
- 下一项：macOS 上的 T37（Skills、斜杠命令、命令面板与输出风格，依赖 T36）；Windows 上的 W2 仍可进行。本地提交，未推送。

### 2026-11-21 T37 已完成（提交 b9012bb）
- 交付：`piarc-config` 的 `skills`（skills、命令文件、Pi 模板与输出风格的发现与同名取舍、frontmatter、`args` 参数替换、合并命令列表、`watch_dirs`）与共用的 `frontmatter`，项目 skill 与命令的 `allowed-tools`、`hooks` 计入可执行项，`outputStyle`、`skillOverrides` 生效；协议 `skills` 模块（`skills/list|invoke|match`、`resources/listSkills|listCommands|reload`、`PromptCommand`，提醒 `skillsChanged`、`outputStyle`，能力 `skills`）；Core 的 `tool_io/skills.rs`（目录、`Skill` 授权消费、回合级 `allowed-tools` 来源 `skill`、skill hooks 作用域、skill 目录只读放行、`expand_command` 与 UserPromptExpansion 挂载点）、设置监听扩到 skills 目录并发 `resources/reload`、`Hub` 的 `list_commands`/`list_skills`/`set_output_style` 与 NAPI；Agent Host 关掉 Pi 的 skills 与模板，`SessionSkills`（第 3、5 段、变化与 `paths` 提醒、`piarc.skillInvoked`）、`Skill` 工具、命令输入记录；客户端的 `/` 面板（来源分组、共享模糊匹配、参数提示）、内置命令、输出风格对话框、Mod+K 命令面板、"Skills 与插件"设置页；L2 6 个新场景、L4 `t37-commands`
- 验收：14 项全部通过。`npm run verify` 15/15（b9012bb，Vitest 1,583 passed、cargo test 934 passed、L2 165 passed 2 个按平台跳过）；L4 `t37-` 4/4 与受影响的 preload、composer、t18-settings、t19-composer、t27-context、t28-rewind、smoke 通过（dev 形态，截图在 `tmp/evidence/T37/`）；提示词原创性 6,102 词 0 个匹配窗口
- 决策：ADR-0054（补充）；架构 2.45；`window.piarc` 新增 `listCommands`、`listSkills`、`setOutputStyle`；`composerInfo` 不再带命令列表（内置命令只在 `BUILT_IN_COMMANDS`）；`config-merge-order`、`t19-composer` 与两处 Rust 测试的"T37 计划中"示例随功能落地改为新的事实（`plansDirectory`、7 个内置命令）；L2 的 `check_worktree` 改为等待 Core 异步写入的记录（满载下偶发读早）
- 登记：I02 更新；新增 I158（暂不支持的 frontmatter 字段：`context: fork` 一组与 `model`、`effort` → T48）、I159（子 agent 的 `skills` 预加载 → T48）、I160（Pi 设置与 Pi 包的 skills、模板、嵌套 skill → T40/T48）、I161（与 Claude Code 的有意差异，R4 确认）
- 下一项：macOS 上的 T38（WebSearch 与 hooks 扩展，依赖 T37）；Windows 上的 W2 仍可进行。本地提交，未推送。

### 2026-11-21 T38 已完成（提交 fc9c022）
- 交付：`piarc-hooks` 的 `http`、`prompt` handler（`Action`、`HttpPort`、`JudgePort`，事件与 handler 组合诊断）、SubagentStart、SubagentStop、PostToolBatch 与决策合并、`error.rs`（I128）；`piarc-web` 的 `Fetcher::call`（`Reach::Configured`）与 `search`（`Backend` 接口、Brave）、`error.rs`；协议 `web/search`、`web/searchBackend`、`hooks/prompt`、`Item::WebSearch`、`nativeWebSearch`、`policy/evaluate` 与 `hooks/run` 的 `effort`；Core 的 hooks 网络与模型端口、`prompt_id`/`effort`（I115）、`hookAllowedEnvVars`（I93）、项目 hook 的权限更新不越过信任（I122）、`web/search` 与只在 Core 的保险箱键 `websearch/*`、设置 API 与 NAPI；Agent Host 的 `WebSearch`（原生经辅助模型通道、第三方经 Core）、`providers/web-search.ts`、`hooks/prompt` 判定、三个新事件的挂载；渲染进程的搜索结果卡片与来源链接、设置页"网页搜索"一节与每模型的原生搜索选项；mock provider 的搜索结果块与本地 mock 搜索服务；L2 7 个新场景、L4 `t38-websearch`
- 验收：13 项全部通过。`npm run verify` 15/15（fc9c022，Vitest 1,611 passed、cargo test 967 passed、L2 172 passed 2 个按平台跳过）；L4 `t38-` 2/2 与受影响的 preload、t29-、t18-settings、transcript- 通过（dev 形态，截图在 `tmp/evidence/T38/`）；`npm run l3` 12 个场景 0 条未解释差异；提示词原创性 6,479 词 0 个匹配窗口
- 决策：ADR-0055（补充）；架构 2.46；`window.piarc` 新增 `webSearchSettings`、`setWebSearchBackend`、`setWebSearchKey`（共 104 个函数）；`allowedHttpHookUrls`、`httpHookAllowedEnvVars` 生效。测试调整：PostToolBatch 让每轮工具调用多一次 `hooks/run` 往返，`bg-completion-reminder` 原先"第二次请求不含通知"的断言依赖时序（多了这次往返后，通知可能在同一回合的下一次请求就送达），改为断言第三次请求中两个任务的结束通知各出现一次；`agent_host` 的背压测试改为断言 Core 回答 PostToolBatch 之前不发出下一次请求，队列上限的比较把请求字节计入。新 hooks-m3 场景在 L3 allowlist 中按理由排除
- 登记：I93、I115、I122、I128（落地）、I112（改交 T45）、I123（核对）；新增 I162（OpenAI Responses、Gemini 的原生搜索与更多第三方后端）
- 下一项：R4（M3 评审）依赖 T38 与 W2，W2 在 Windows 上进行；macOS 上暂无可开始的任务。本地提交，未推送。

### 2026-11-21 R4 部分完成（提交 8a1b0cf）
- 开工：用户要求先把 `origin/windows/dev` 的 W2 合并进来（b91ad7d，W2 一侧改号 I146/I147 → I163/I164、架构 2.43 → 2.47）；合并后基线 13/15，两步失败是合并产物（过期的 `#[expect]` 01e190c、capabilities 漂移 b48a5d7）。W2 推送后的 CI 44887344674：macOS verify 通过，Windows verify 与 L4 各有失败（I166）；本分支未推送，T35-A10、T36-A11 仍 blocked。
- 结论：M3（macOS）未达标，阻塞项只有内存：Agent Host 最大 236 MB（≤ 270），应用其余进程 RSS 合计 580 MB（> 510，phys_footprint 约 250 MB）；测量脚本加了共享 stdio MCP server 与 skills 索引（26fc9fd、1af9363）。M3 能力全部有 L2 场景，M3 及之前没有 planned 能力。
- 审查：四个只读子代理并行，37 条发现；修复 10 项（S1、S2 172d413，S3 1d5bc50，S4 daf6f72，E1 cff27f0，E2 c437180，E3 691df8a，M1 30ef685，M2 bca2f81，M3 c7297b0），每项先红后绿；M11 不成立并加守护测试（fc41534）；E4、M4 写明不同意的理由。另做 I150 拆分（3c73ec8）、AGENTS.md 回到 120 行内（45e932e）、复用表补 6 行（6ae6cc7）、I87 对照官方 settings 索引（282beb5）、三个过期 L4 用例（8a1b0cf）。
- 验收：A02、A04–A11 通过；A01、A03 failing（内存）。`npm run verify` 15/15（8a1b0cf）；全量 L4 两种形态 281 通过、5 跳过、7 失败（`t18-review` 无屏幕录制权限；其余 5 个修复后 18/18）。
- 决策：没有新 ADR；内存口径的改变等于放宽，留给用户决定（建议在 T44 之前写 ADR 提议）。架构 2.48。
- 登记：逐条处理全部登记事项（58ef052），新增 I165–I176。
- 下一项：T39（macOS）与 W3（Windows）都可以开始；建议先推送本分支看 CI，再在 Windows 上做 W3（它要核对 R4 的 Windows 项与 I166），macOS 上同时进行 T39。本地提交，未推送。

### 2026-11-21 T39 阻塞（等待用户确认 ADR-0057）
- 交付：`piarc-config` 的 `sandbox`（`sandbox.*` 键、用户与企业来源合并、项目只能收紧的 `loosening`、`IgnoreReason::{ProjectSandbox, Platform}`、`append_unique`）；`piarc-sandbox` 的会话沙箱（每条命令按当时设置生成配置、`platform_sandbox`、拒绝识别 `denials`、Agent Host 定稿配置模板与 golden）与代理加固（运行中换白名单、`ProxyHooks` 询问与拒绝回报、连接上限与超时、`Host` 改写）；`piarc-policy` 阶梯的 `sandbox_auto`（第 7 步）与 `unsandboxed`（任何模式必问）；协议 `ExecRunResult.sandbox`、`ApprovalRequest.sandbox`/`domain`、`SandboxNetwork` 卡；Core 的 `tool_io/sandbox.rs`（`Effective`、`CallSandbox`、会话代理与 `Gate`、审计 `kind: "sandbox"`、不可用降级与提示）、`sandbox/network.rs`（网络卡：仅本次、本会话、加入白名单、拒绝，60 s 超时）、`sandbox/view.rs`（设置页读写）、Agent Host 两种启动都套定稿配置；NAPI `sandboxSettings`、`setSandboxSettings`；Agent Host Bash 的 `dangerouslyDisableSandbox` 与失败说明（`sandbox-report.ts`）；客户端设置页"沙箱"、审计页"沙箱拒绝"筛选、审批卡的沙箱标记与网络卡、环境栏提示、Windows"沙箱不可用"；`piarc_exec::Error`（I173）；L2 11 个 `sandbox-*` 场景、会话层 `sandbox::` 3 个、`agent_host_profile`、L4 `t39-sandbox`
- 验收：14 项通过，A12（Windows CI）blocked。`npm run verify` 15/15（18e3db9，Vitest 1,621 passed、cargo test 1,001 passed、L2 184 passed 3 个按平台跳过）；Windows 交叉 clippy 全工作区通过（顺带修好 I165 拆分时漏掉的 Windows 导入）；L4 `t39-` 2 passed（Windows 用例跳过，截图在 `tmp/evidence/T39/`）与受影响的 preload、t20、t23、t24（dev）、打包形态 `agent-host.e2e.ts` 通过；`npm run l3` 12 个场景 0 条未解释差异、0 条过时条目（`~/.claude` 的变化来自同时开着的 Claude Code 会话）；提示词原创性 6,677 词 0 个匹配窗口
- 决策：ADR-0056（补充，已接受：命令是否进沙箱在裁决时决定并随授权走、自动批准在第 7 步、沙箱外重试与网络卡任何模式都问且 hooks 不代答、项目只能收紧、代理加固与私网不拦、Agent Host 定稿配置与 Pi 设置锁的放行、登记事项 I05/I34/I35/I36/I40/I54/I133 的处理）；ADR-0057（变更型，提议：Windows 命令隔离，推荐 Beta 前维持现状、Beta 后在 R6 评估 MXC `processcontainer`）；架构 2.49；`window.piarc` 共 106 个函数
- 登记：I05、I34、I35、I36、I40、I54、I61、I117、I133、I165、I173 更新或关闭；I174 转交 W3；新增 I177（ADR-0057 待决定）、I178（后台命令与 Monitor 的文件拒绝不进说明与审计，T45）、I179（Pi 设置锁的位置，升级 Pi 时复核）
- 下一项：macOS 部分已全部完成，T40 可以开工；Windows 隔离等 ADR-0057 的决定（在新会话中说"采纳 ADR-0057"或"否决 ADR-0057，理由是……"，再 `/task T39`）。本地提交，未推送。

### 2026-11-21 T39 部分完成（提交 607809d）
- 用户采纳 ADR-0057：状态改"已接受"；架构 2.50 同步第 4 章、6.10 节 Windows 一条（到 Beta 维持现状，MXC ProcessContainer 为 Beta 之后的候选及其前提）、10.3 节（Windows 的 Agent Host 没有第二道防线，计入已接受风险）、15.2 节沙箱一行与第 14 章 R16；根目录与 `piarc-sandbox` 的 AGENTS.md 去掉"提议"；A13 证据注明接受
- 验收：14 项通过，A12（Windows CI）仍为 blocked，看板改为"部分完成"；只改了文档，`npm run verify -- --baseline` 通过
- 登记：I177 改为 Beta 之后的 MXC 评估任务与 ADR 第 5 条的实验（R6 之后安排）；新增 I180（T45 威胁模型把 Windows 无 OS 沙箱列为已接受风险）
- 下一项：macOS 上的 T40（插件、Pi 包与 MCP prompts）；Windows 上的 W3。A12 在用户推送后由下一个任务的开工检查按 Windows CI 关闭。本地提交，未推送。

### 2026-11-21 T40 已完成（提交 c4e5f75）
- 交付：`piarc-config::plugins`（识别 Claude Code 插件与 Pi 包、组件与不支持的部分、可执行项的唯一命名、设置键 `plugins` 的声明与生效的包、只留已确认的 hooks/MCP/扩展/子 agent 项），skills、命令与子 agent 的发现接上包来源（`<plugin>:<名称>`，排在最后）；`piarc-store` schema v10 `packages`；`piarc-git::package`（克隆锁定提交、显式更新）；`piarc-core::plugins`（`PluginManager`：本地目录、git、内置 npm 且 `--ignore-scripts` 的安装，开关、确认、更新、卸载与 `kind: "plugin"` 审计；`permission_settings` 挂上生效的包，hooks 层 `plugin:<id>`、MCP 作用域 `plugin`；信任视图列出包的可执行项、信任即确认）；AHP `plugins/extensions`（能力 `plugins`）与 NAPI `packages*`；Agent Host 以 `additionalExtensionPaths` 加载已确认的 Pi 扩展、`resources/reload` 时重开有变化的会话并刷新 MCP 池，连接池的 MCP prompts（`prompts/list`、`list_changed`、`prompts/get`）作为 `mcp__<server>__<prompt>` 斜杠命令；设置页"Skills 与插件"的插件部分与主进程原生确认（`NativeConfirm`，开发构建测试钩子代答）；L2 格式的 `packages` 与 `check_commands`，8 个新场景，`check-app-layout.mjs` 的发布版测试导出检查
- 验收：11 项全部通过。`npm run verify` 15/15（c4e5f75，Vitest 1,636 passed、L2 192 passed 3 个按平台跳过）；L4 `t40-` 与受影响的 preload、t18-settings、t37- 共 14 passed（dev 形态，截图与确认框文字在 `tmp/evidence/T40/`）；发布打包后 `check-app-layout.mjs --flavor release` 23/23
- 决策：ADR-0058（补充）；架构 2.51；`window.piarc` 共 112 个函数。Pi 包不写进 `pi/settings.json`，改经 AHP 交给 Agent Host（Pi 的 `resolve()` 会为缺失的包运行带安装脚本的 npm，且全局生效，见 ADR-0058 第 13 条）；可执行项逐项确认，包的新增项不让项目回到未信任；Claude Code 的 `enabledPlugins`、`extraKnownMarketplaces` 改为忽略
- 登记：I154、I155、I158、I160 更新；新增 I181（插件不支持的组件与 hook 环境变量）、I182（插件 skill 与命令的 `allowed-tools`、hooks 不生效，子 agent 不加载包的扩展）、I183（配置诊断的插件来源，T41）
- 下一项：macOS 上的 T41（配置诊断完善、M4 hooks 事件与用量成本）；Windows 上的 W3。本地提交，未推送。

### 2026-11-21 T41 已完成（提交 10fbeff）

- 交付：M4 hooks（`piarc-hooks` 新事件与 `mcp_tool` handler、`mcp_tool::fill`、`McpToolPort`；Core 的 `tool_io/hooks_m4.rs`：CwdChanged、FileChanged（`watchPaths` 轮询，上限 64）、ConfigChange（每个输入前与设置监听时核对，阻断钉住旧值并作用于权限与 hooks）；UserPromptExpansion 在命令与 skill 展开处；Agent Host 的 InstructionsLoaded、StopFailure（`stopFailureType`）、MCP prompt 展开的 hook 与 `hooks/mcpTool` 应答）；用量与成本（`piarc-store` schema v11 `usage_records`、`model_prices`，`piarc-core::usage` 整数计价，`CatalogModel.cost`，NAPI `usageReport`、`sessionUsage`、`setModelPrice`，右栏用量卡片与设置"用量"页）；配置诊断全部来源（`SourceKind`、新状态与忽略原因，`config_diagnostics/sources.rs`，设置监听另监听根目录与 rules、agents 目录，诊断页按来源分组）
- 验收：13 项全部通过。`npm run verify` 15/15（10fbeff，Vitest 1,658 passed，L2 198 passed 3 个按平台跳过）；L4 `t41-`（用量与诊断）与受影响的 `t24-diagnostics` 共 3 passed（dev 形态，截图在 `tmp/evidence/T41/`）
- 决策：ADR-0059（补充）；架构 2.52；`window.piarc` 共 115 个函数。FileChanged 改为轮询而不是 notify（全量 L2 下 FSEvents 流启动阻塞几十秒，CwdChanged 后的回合会卡住）；ConfigChange 不只依赖文件事件，每个输入前核对（权限裁决每次读文件，事件迟到会让被阻断的变更先生效）；成本按请求存行、查询时计价（可改价、可分档），没有价格为"未知"
- 登记：I176 由 T41 决定（删除 `terminalLastCommand`；`exec/background/list|read` 删除交 R5）；I183 已落地；新增 I184（目录价只在见过模型列表后才有）、I185（设置监听在高负载下的迟到对其他消费方的影响）
- 下一项：macOS 上的 T42（NotebookEdit、可操作通知与 diff 行内评论）。本地提交，未推送。

### 2026-11-21 T42 部分完成（提交 868065b）

- 交付：NotebookEdit（`piarc_fs::notebook` 只改一个 cell 的字节区间、按文件风格重写被改的 cell、替换代码 cell 清空输出、旧版 notebook 按序号定位、新 cell 的 id 由调用 id 派生；Agent Host 的 `tools/notebook-text.ts` 同一算法，两边跑 `tests/notebook/` 共享向量；Core 的 `tool_io/policy/notebook.rs` 算批准结果与审批卡 diff，`Edit(...)` 规则、受保护路径、检查点与 hooks 同文件工具；Tool Profile、提示词与 5 个 L2 场景）；可操作通知（Core 的 `notificationAllow` 与通知答复检查 `tool_io/policy/notify.rs`、审计来源 `notification`，协议 `AnswerVia`；主进程 `NotificationPort` 与按钮经同一 `answerApproval`，未采用的答复以 `approvalNotice` 提示；设置页在系统不支持通知时说明原因；L2 审批应答的 `via`、`notification_allow` 与场景 `notify-approval`）；diff 行内评论（`changes/comments.ts` 与 `DiffComments.tsx`：两侧与范围、跨文件、编辑删除、`localStorage` 草稿、按摘录重新定位与"已失效"、Mod+Enter 一次发送、运行中排队；FR-RV-04 改为 `client_only`）；顺带修复：等待审批时审批卡的捕获阶段快捷键吞掉其他文本框里的 Mod+Enter（`approval-keys.ts` 的 `typedElsewhere`）
- 验收：10 项通过，A06（macOS 通知横幅截图，缺屏幕录制权限）与 A07（Windows CI）blocked，看板为"部分完成"。`npm run verify` 15/15（868065b，Vitest 1,681 passed，L2 204 passed 3 个按平台跳过；首次全量在 e60bd4d 因 i18n 测试缺新占位符的样例值失败，已补）；L4 `t42-` 2 passed 与受影响的 `t28-rewind` 3 passed、`t20-approvals` passed（dev 形态，截图在 `tmp/evidence/T42/`）；提示词原创性检查 0 个匹配窗口
- 决策：ADR-0060（补充）；架构 2.53；没有新增 IPC 命令（`window.piarc` 仍为 115 个函数），应用状态加 `notificationsSupported`、应用事件加 `approvalNotice`。notebook 不解析再序列化（避免整文件 diff）；通知只放行能在通知里读完的请求（短单行命令、增删不超过 12 行的改动）；评论不进 Core
- 登记：新增 I186（代码高亮配色跟随系统而非应用主题，T43）、I187（通知横幅截图与 Windows Toast 实机核对，W4）
- 下一项：macOS 上的 T43（无障碍与本地化）。A06 在用户给终端"屏幕录制"权限后补拍，A07 在用户推送后由下一个任务的开工检查按 Windows CI 关闭。本地提交，未推送。

### 2026-11-21 T43 部分完成（提交 00b452b）

- 交付：状态清单 `apps/desktop/e2e/a11y/states.ts`（57 条）与 `t43-a11y` 旅程（亮暗 axe 114 次零违规）、覆盖检查 `e2e/a11y/states.test.ts`；transcript 由 `log` 改为 `feed`，行名称 `transcript/row-label.ts`（`src/shared/row-kinds.ts`）；节流 live region（`LiveRegion.tsx`、`live-announcer.ts`、`LIVE_ANNOUNCE` 5 s）；审批卡焦点与名称（`approvals/use-approval-focus.ts`、`approval-label.ts`，合成后移动、400 ms 防误触）；键盘：侧栏分隔条进 `nav`、右栏与停靠区有名称且分隔条可用方向键、关掉含焦点的停靠面板时焦点回输入框、`Dialog` 的 `focusKey`（模型切换预览丢焦点）、composer 与附件按钮的焦点环、审批快捷键不吞其他文本框的按键；颜色：侧栏 90% 叠层、GitHub 高对比度代码主题并跟随应用主题（I186）、diff 行号 24 px、强制颜色下主按钮用系统按钮色与状态点形状、输出风格列表去掉嵌套交互、标题层级；本地化：`scripts/ci/check-i18n.mjs`（verify 第 16 步）、`format.number`/`format.dateTime`、外链确认与 Markdown 标签走目录、中文复数 `one` 改 `=1`、设置导航行随长名称增高；`docs/engineering/accessibility.md`（规则、检查、读屏清单）；L4 `t43-a11y`、`t43-keyboard`、`t43-approval-focus`、`t43-locales`；T29 的 OAuth 辅助函数移到 `e2e/oauth.ts`
- 验收：10 项通过，A10（VoiceOver 实际操作）blocked，看板为"部分完成"。`npm run verify` 16/16（00b452b，Vitest 1,696 passed，L2 204 passed 3 个按平台跳过）；开发打包后全量 dev L4 160 passed，`external-links` 两例因确认框改为跟随应用语言而按旧英文断言失败、已改为中英文都接受并通过，`t18-review` 因终端没有"屏幕录制"权限 `screencapture` 失败（已知环境限制，`apps/desktop/AGENTS.md`）
- 决策：ADR-0061（补充）；架构 2.54；verify 增为 16 步；`window.piarc` 函数数不变（没有新增 IPC）
- 登记：I186 已落地；新增 I188（VoiceOver 实际核对待用户，Narrator 与 NVDA 由 W3 按同一清单）
- 下一项：macOS 上的 T44（性能预算进 CI 与长跑测试）。A10 在用户按 `docs/engineering/accessibility.md` 第 3 节操作 VoiceOver 后补结论。本地提交，未推送。

### 2026-11-22 T44 部分完成（提交 a5f6146）

- 交付：测量框架 `scripts/perf/`（`metrics.mjs` 第 11 章每行的指标、预算、探针、流水线与回归下限，`EXCLUDED` 只有 Beta 期崩溃率；`chapter11.mjs` 与 `metrics.test.mjs` 覆盖检查；`gate.mjs` 绝对预算与相对基线 10% 两道判定，基线按平台、机器类别、流水线分存于 `scripts/perf/baselines/`，只经 `--update-baseline "<原因>"` 更新，`--from-report` 判定或记录另一台机器的报告；`run.mjs` 把 T14/T18/T19/T20/S1/S2/S7 的基准作为探针并新增 `probe-memory`、`probe-sessions`、`probe-first-token`、`probe-idle`、`probe-recovery`、`probe-size`、`long-run`；`lib.mjs` 公用驱动，`m3-memory.mjs` 改用它）；流水线（`ci.yml` 的 desktop 作业跑 PR 冒烟，`perf-nightly.yml` 两平台完整测量与 1 小时长跑）；主进程在渲染进程崩溃后自动重载（每分钟至多 3 次）；体积裁剪 `apps/desktop/packaging/trim.mjs`（npm 文档与 man、Electron 中英文以外的语言包、strip 发布构建 Core 的本地符号：安装后 466.3 → 446.6 MB）；`docs/engineering/performance.md`；本机 Nightly 与 PR 基线（`m1-max-32g`）
- 验收：A01、A02、A03、A05、A07、A08 通过；A04 failing（5 次 PR 冒烟：两次是回归下限小于自然波动，已按实测调大；三次在远程桌面运行时受负载干扰；用户要求停止，未在安静环境下重跑）；A09 未运行全量 verify（用户要求停止，已跑 prettier、tsc、相关 ESLint 与 Vitest、验收清单检查）；原 A06（本机 8 小时长跑）由用户决定去除，看板为"部分完成"
- 决策：架构 2.55（第 11 章补 T44 实测、空闲 CPU 阈值 ≤ 5%，不收紧任何预算）；用户决定去除本机 8 小时长跑（I195）；应用内存的口径未改（I26，改口径须用户经 ADR 决定）
- 登记：新增 I189（重载后进行中的回复到回合结束才出现）、I190（空闲 CPU 约 3.6%，隐藏时仍有 GPU 与渲染进程工作）、I191（流式帧 p99 16.4 ms，T20 之后的回归，渲染进程二分已排除 T29 之后的代码）、I192（主进程空闲增量 32.5 MB）、I193（工作区就绪 0.96 s，余量 4%）、I194（Agent Host 202 MB）、I195（8 小时长跑未做）；I26、I41、I146 追加 T44 结果
- 下一项：T45（安全收口），用户手动开新会话指派。A04 在安静环境（不开远程桌面）下重跑 5 次后改状态；A09 在下一次全量 verify 后补记。本地提交，未推送。

### 2026-11-22 T45 部分完成（提交 c970cd6）

- 交付：威胁映射 `tests/security/threats.yaml`（第 10.1 节 14 条威胁、59 个对策、165 个测试 ID）、`scripts/lib/threats.mjs` 与 `scripts/ci/check-threats.mjs`（verify 第 17 步，含反向检查与 `docs/security/threat-coverage.md` 漂移检查）；补测试：L2 `sec-inject-repo-file`、`sec-inject-webfetch`、`sec-inject-mcp`、`sec-malicious-repo-untrusted`、`sec-malicious-repo-new-item`、`sec-pi-settings-packages`（能力 3 个），`credential_leaks.rs`、`egress.rs`、`thr04-*` 会话夹具，L4 `t45-diagnostics`、`t45-ipc-hardening`、`t45-xss`、`t45-egress`；修 THR-03 缺口：Pi 设置里的 `packages` 不再由 Agent Host 安装（`agent-host/src/runtime/pi-settings.ts`，先有失败的 L2）；日志写入时脱敏 `piarc-telemetry::redact`（保险箱值由 Core 每次保险箱操作后登记，加常见密钥格式），诊断包 `bundle.rs`/`zip.rs`、Core `prepare_diagnostics`/`export_diagnostics`、NAPI 与 IPC 两个函数、配置诊断页"诊断包"一节（预览后经原生保存对话框写出）；依赖审计 `npm run audit:deps`（npm audit、cargo-audit 0.23.0 进 `.tools/`、cargo-deny、npm 发布依赖许可证）、例外清单 `tests/security/audit-exceptions.yaml`、`deps-security.yml`、PR 模板；发布构建移除 `--remote-debugging-port`/`--remote-debugging-pipe` 并退出、测试页只在开发构建的 chunk（构建期常量 `__PIARC_RELEASE_BUILD__`），`scripts/ci/check-release-runtime.mjs` 与 `check-app-layout.mjs` 检查并进 CI desktop 作业；ESLint 拦 `webContents.ipc` 与 `ipcMain` 别名，导航守卫加 `will-frame-navigate`（只管子框架）；`piarc://open` 拒绝 UNC 与设备路径；`openSettings`、`notifyAttention`、`openExternal` 对畸形参数抛 `TypeError`；XSS 载荷 18 → 28 类，审批卡、diff、Changes 与代码块把双向控制字符显示为 `[U+XXXX]`（`transcript/reveal.ts`，先有失败测试）；文档 `docs/security/electron-checklist.md`、`docs/security/egress.md`、`testing.md` 第 16 节、`crates/piarc-telemetry/AGENTS.md`
- 验收：12 项通过，A02（威胁映射测试在 macOS 与 Windows CI 上的结果）blocked，等推送后的 CI，看板为"部分完成"。`npm run verify` 17/17（c970cd6，L2 213 个场景 210 通过、3 个按平台跳过）；`check-release-runtime.mjs` 在发布构建上 8 项通过（对开发构建跑同样的探测会失败）；发布构建布局 24/24；T45 与波及的 L4（dev 形态）通过，`t18-review` 因终端没有"屏幕录制"权限失败（已知环境限制）；A01 的删除映射与改错测试名两次失败、恢复后通过的输出在 `tmp/evidence/T45/a01-*.txt`。A01 描述写"13 行"，第 10.1 节现为 14 行（同一用户进程注入一行编为 THR-14），描述由用户决定是否修改
- 决策：ADR-0062（补充）；架构 2.56（第 10.1 节对策补充与拆行、10.2、10.5）；verify 增为 17 步；`window.piarc` 增加 `prepareDiagnostics`、`exportDiagnostics`；minimatch 中危公告进例外清单而不升级 eslint（新规则误报）；信任决定是否走原生确认（I79）交 R5 由用户经 ADR 决定
- 登记：I06（审计已接入）、I10、I13、I24、I30、I52、I57、I170、I180 落地；I39、I64 评估后维持；I56、I79、I94、I120、I121、I123、I126、I172、I173、I175、I178 交 R5，I83 交 W3/T48，I91、I112 交 T48；新增 I196（Electron 45.4.1）、I197（`PI_OFFLINE` 遮住 Pi 的联网路径）、I198（Windows 拼写词典下载）、I199（XSS 扩展到其余设置页）、I200（T50 为 THR-09 补测试）
- 下一项：R5（M4 评审）依赖 W3，W3 在 Windows 上进行；推送后按 CI 关闭 T45-A02。本地提交，未推送。

### 2026-11-22 W3 部分完成（提交 9879474）

- 开工：用户要求先把 `origin/docs/architecture-design` 合并进 `windows/dev`（快进到 a6701310，无冲突）。基线 verify 全量 12/17：T37–T45 只在 macOS 跑过，Windows 失败按 W2 的先例并入本任务；`url` 2.5.8 的新公告经用户同意升到 2.5.9。机器负载高、一次全量 `cargo test` 因内存不足被中止，用户腾出机器后再测量；NVDA 经用户同意用 winget 安装。
- 交付：修复 10 个 Windows 缺陷（插件路径的 `\\?\`、worktree 会话全被当作受保护路径、子 agent worktree、内置 npm、git 一律 `core.longpaths=true`、会话终端在 `C:\Windows` 启动、终端面板的订阅与网格在 Core 认得终端前被拒后不再重试、测试读到本机 `~/.claude/skills` 等）；新增 `pointer_windows.rs`（I163）、`t34-terminal-windows.e2e.ts`（I142）、长路径与小写盘符的 worktree 用例；`docs/engineering/performance.md` 第 6.1 节 Windows 实测；无障碍清单的讲述人与 NVDA 两列；[W3 报告](../reviews/W3-windows-m3-parity.md)；架构 2.57
- 验收：A02–A11 通过（A03、A07、A10 由用户实机核对）；A01 failing（应用其余进程 576 MB > 450 MB，与 macOS 同一阻塞项）；A12 blocked（用户要求跳过收尾的全量 verify，局部检查与 L4 26 个用例通过）。按 Windows 结果关闭 T35-A10、T36-A11（T36 改为已完成，T35 仍因 A11 内存为部分完成）
- 决策：没有新 ADR；L2 与 L4 的临时工作区在 Windows 上放到 `%PUBLIC%`（测试隔离，不改产品的向上查找）；终端面板对被拒的订阅、颜色与网格重试，而不是改 Core 的任务登记顺序
- 登记：新增 I201–I207；I141、I142、I147、I163、I166、I170、I174、I175、I188、I198 更新
- 下一项：R5（M4 评审，macOS）依赖 T45 与 W3；W3-A12 在下一次全量 verify 后补记，M3 的内存口径仍待用户决定（I26、I201）。本地提交，未推送：请在 Windows 上推送 `windows/dev`，再回到 macOS 继续。

### 2026-11-22 T45 跟进 CI（提交 7cbf259、ea69d38）

- 起因：推送后 a670131 的 Dependency security 失败，原因是 T45 本地验证之后新发布的 RUSTSEC-2026-0592（`url` 2.5.8 的 `Url::origin()` 处理嵌套 `blob:` 时栈溢出，经 `piarc-web`；PiArc 没有调用 `Url::origin()`）。7cbf259 把 `url` 升到 2.5.9（`form_urlencoded` 随之升到 1.2.3）；`npm run audit:deps`、`cargo-deny check` 通过，本机 `npm run verify` 17/17 于 7cbf259
- CI（7cbf259，run 45011543956）：Dependency security、macOS verify、两个平台的打包、core build 与 core load 通过；macOS L4、Windows L4、Windows verify 失败。映射用例里只有 `preload.e2e.ts` 的 OS 沙箱用例失败（macOS dev 形态，取指标早于渲染进程出现，返回 null），ea69d38 先等指标出现再断言 `sandboxed === true`，本机 preload 两种形态 14 项通过；其余失败来自 T35–T44 第一次上 Windows CI 与 macOS L4，登记为 I208–I210（W3 已用 I201–I207）
- 验收：T45-A02 仍为 blocked（证据写了这次 CI 的结果），T45 仍为"部分完成"；其余 12 项不变
- 下一项：推送 ea69d38；合并 W3 后重跑 CI 复核 I208；I209、I210 交 R5；Windows 与 macOS 的 CI 全部通过后关闭 A02

### 2026-11-22 R5 阻塞（等待用户确认 ADR-0063、ADR-0064；提交 4b7c223）

- 开工：合并 W3 后的基线 verify 14/17（W3 带来的 Prettier 问题 a94a03c 已修；`state.rs` 设置监听用例负载下超时，单独通过；第 17 步是进行中的改动）。CI 运行 45024661885（W3 的 de98771）：两个平台 verify 的威胁映射通过，Windows L2 199/0（I208 解决），失败的 Prettier 与 Windows 的 `state::sources` 路径断言已修（e682784）。
- 结论：**M4（macOS）未达标，阻塞在性能一条**。安全威胁表本地逐条有测试（14 条各抽查一个，补 THR-11、THR-14 映射），两个平台 CI 等推送；R5 复测本机 Nightly 主进程增量 35.6 MB、应用全部进程合计 530 MB（RSS）、Agent Host 196 MB、流式帧 p99 16.2 ms 超出。九项 M4 目标都有任务与验收证据；T41 遗留的两个 `planned` 能力补 L2 后，M4 及之前没有 `planned`。
- 审查：四个只读子代理并行，57 条发现；修复或部分修复 21 项，每项先红后绿：S1 Agent Host 的子进程能写 Pi 自动加载的 `<pi>/extensions` 与 Core 当作用户来源读的 `<pi>/skills`、`<pi>/prompts`（4f6de69）、S5 克隆的包经自带 `.npmrc` 让 npm 运行任意程序（8cdd10b）、P1 性能门禁在 CI 上不判任何值与 P3 工作区就绪的口径（9f5ec0a）、S4 关闭沙箱不确认（977173b）、S8 脱敏漏下划线名（306d957）、S11（f30813a）、I120 Read deny 不管 Grep/Glob 结果（cf76d24）、I210 提示的长路径把按钮挤到侧栏下（cc4ec00）、无障碍 A2/A3/A4/A5/A6/A11/A14 与工程文档 Q7/Q8；不同意 3 项写理由，其余登记。
- 验收：A04–A10 通过；A01 blocked（两个平台 CI 待推送）；A02 failing（性能超出）；A03 failing（T44-A04、T44-A09 未完成，W3-A01 内存）。`npm run verify` 17/17（4b7c223）；全量 L4 两种形态 341 通过、23 平台跳过、3 失败（`t18-review` 屏幕录制权限 ×2，`t34-terminal` 一次面板空白、重跑 3/3 通过）。
- 决策：ADR-0063（提议，放宽）"应用全部进程合计"按物理占用测量；ADR-0064（提议）"信任"经主进程原生确认（I79、S3）；新增 L2 动作 `check_cost`；架构 2.58。
- 登记：交 R5 的 26 项逐条处理（I120 落地；I26、I79 写 ADR；I56、I94、I121、I123、I126、I172、I173、I175、I176、I178、I197、I199 交 T48 并在 R6 前完成；I190–I194、I196 交性能任务；I203、I207 交 W4）；新增 I211–I222。**进入 M5 前必须处理**：用户决定 ADR-0063 与 ADR-0064；为 I222 的性能达标任务排期（计划变更）；推送本分支并看 CI（R5-A01、T39-A12、T42-A07、T45-A02），从 CI 工件记录 `github-arm64`、`github-x64` 的 PR 与 Nightly 基线（R5 起缺基线的 CI 性能步骤会失败）。
- 下一项：T46（Auto 模式，macOS，设计关口）依赖 R5：用户可以在决定 ADR-0063、ADR-0064 并为性能任务排期后开工，T46 的设计增补不依赖这几项；W4（Windows：M4 达标与 Beta 同步）依赖 R5 与 T50，要等 macOS 上的 T50 完成后才在 Windows 上做。本地提交，未推送。

### 2026-11-22 R5 部分完成（用户采纳 ADR-0063、ADR-0064；提交 f7b05b7）

- 用户确认 ADR-0063 与 ADR-0064：两者状态改"已接受"，ADR-0029 状态注明被 0064 修订，架构 2.59（第 4 章、第 11 章"应用全部进程合计"改按物理占用，修订记录写明放宽与原因；第 16 章 M3 按新口径达标；10.2 节）。
- ADR-0063 的配套：`scripts/perf/lib.mjs` 新增 `physicalFootprints`、`appFootprint`（macOS `footprint`、Windows `WorkingSetPrivate`），`probe-memory.mjs` 的 `app-memory` 与 `m3-memory.mjs` 的 `appOtherMB` 改为物理占用，RSS 之和留作参考；本机实测 `app-memory` 208 MB（3 次中位）、3 会话场景最大 264 MB、Agent Host 最大 229 MB，都在预算内；Nightly 基线的 `app-memory` 按新口径更新（原因写在基线文件）。Windows 的读法没有在本机运行，W4 复测。
- ADR-0064 的实现登记 I223（M5 内，R6 前）。I26、I146 关闭，I201、I79 更新。
- 验收：R5-A02 仍 failing（流式帧 p99、主进程增量、Agent Host 内存三行，交 I222）；R5-A03 仍 failing（T44-A04、T44-A09；T35-A11、R4-A01、R4-A03、W3-A01 是别的任务的项，按新口径的数据见 R5 评审第 1.2 节，由用户决定是否关闭）；R5-A01 blocked（CI）；其余通过。看板改为"部分完成"。
- 下一项：T46（macOS，设计关口）可以开工，与 I222 的性能达标任务（需排期）并行；W4（Windows）依赖 R5 与 T50。本地提交，未推送。

### 2026-11-22 T46 阻塞（等待用户确认设计增补）

- 开工：基线 `npm run verify -- --baseline` 全量 16/17，第 8 步只有 I185 的设置监听用例在负载下超时，单独重跑通过；R5 为部分完成，遗留的性能三行与 CI 不影响本任务。R5 推送后的 CI 运行 45036807604 开工时仍在进行，R5-A01 等 blocked 项留到下一次开工核对。
- 交付：设计增补 [`docs/architecture/addenda/T46-auto-mode.md`](../architecture/addenda/T46-auto-mode.md)：只有阶梯结论为通用询问（`step: "ask"`）的调用在 PermissionRequest hooks 之后送审；Core 经新的 `policy/review`（Core → Agent Host）发起，Agent Host 从分支取用户消息与近期调用、经辅助模型通道调用；输入排除工具结果、网页、MCP 返回、助手正文、memory 与 hook 注入；输出为单一工具调用 `record_review`，Core 再校验；失败一律转审批卡（超时 30 s），连续 3 次或累计 20 次拒绝后暂停；审计 `kind: "autoReview"`；用量用途 `autoReview`；启用只在 PiArc 用户级并经原生确认，项目级的 `autoMode`、`enableAutoMode` 忽略并进配置诊断。行为参照 Claude Code 官方 `permission-modes`、`auto-mode-config`（2026-11-22 重新核对）。
- 验收：A01 blocked（等待用户确认）；其余未开始。
- 下一项：用户确认增补第 9 节的 12 个要点（可逐条改选备选）后，再次 `/task T46` 进入实现。本地提交，未推送。

### 2026-11-22 T46 部分完成（Auto 模式，等待 Windows CI）

- 确认：用户在本会话回复"全部按推荐"，设计增补第 9 节 12 个要点全部取推荐，A01 记为通过，看板改回进行中。
- 交付：协议 `PermissionMode::Auto`、审批卡的 `review`（审查中 / 转人工与原因）、`policy/review`（Core → Agent Host）、`ToolReview`、`AutoReviewStatus`、`CatalogModel.reviewer`；`piarc-policy` 的 `review` 模块（可审范围只认 `step == "ask"`、结论再校验与截断、`Denials`、`REVIEW_TIMEOUT`）与阶梯第 7 步 Auto 同 Accept edits；`piarc-config::auto_mode`（用户级读取、项目层移除并报 `projectAutoMode`、`disableAutoMode`）；`piarc-git::remotes`；Core `tool_io/policy/review.rs`（审查中卡片、`HubReviews` 经会话层发 `policy/review`、失败归一转卡、`autoReview` 审计、计数挂主会话、T48 触发点 `reviewer_refused`）与 `modes.rs` 的可用性与设置关闭时转手动；Agent Host `harness/auto-review.ts`（经历史投影取用户原话与近期调用，`record_review` 单一工具）、单一提示词文件 `prompts/auto-review.ts`、辅助通道的工具与缓存选项、分支条目 `piarc.autoReview` 与工具条目的 `review`；客户端的设置一节、模式菜单、审批卡状态、调用标识、环境栏状态、审计类别与用量标签；L2 17 个 `perm-auto-*` 场景与 8 个 `CAP-PERM-AUTO-*` 能力，格式新增 `strict_tools`、`review_timeout_ms` 与审批的 `review`。
- 验证：`npm run verify` 17/17 通过于 84a4d07；L4 `t46-auto-review` 与波及的 t20、t23、t26 共 10 个用例通过，截图在 `tmp/evidence/T46/`；提示词原创性比对 0 个匹配窗口；`npm run l3 -- --filter perm-plan`：本任务改写的条目仍匹配，另有 T41、T42 留下的缺口登记为 I224。
- 验收：A01–A12 通过；A13 blocked（macOS verify 已过，Windows CI 的 L2 要等推送）。看板改为"部分完成"。
- 登记：I224（L3 既有缺口）、I225（T48 的 `PermissionDenied` 接入点）、I226（审计保留期限，R6）；I117 关闭。
- 下一项：T47（自动记忆与企业托管配置，macOS，设计关口）依赖 T46，可以开工；I222 的性能达标任务仍待排期；W4（Windows）依赖 R5 与 T50。本地提交，未推送。

### 2026-11-22 T47 阻塞（等待用户确认设计增补）

- 开工：基线 `npm run verify -- --baseline` 通过（84a4d07 之后只改了 `docs/`，复用全量结果）；T46 为部分完成，遗留的 A13 只等 Windows CI，不影响本任务。R5 推送后的 CI 运行 45036807604 已结束：T39-A12（Windows L2 `sandbox-windows-not-applied` 与 L4 `t39-sandbox` 的 Windows 用例）与 T42-A07（Windows Vitest 的 `attention.test.ts`）通过并改为 passing，T39 改为已完成；Windows verify 的 clippy 失败（`plugins/tests.rs` 的 `file_url` 在 Windows 上未使用）已修（0227a4d，本机 Windows 交叉 clippy 通过），`exec_commands` 的输出顺序与两个平台 L4 的其余失败登记 I227，R5-A01、T45-A02 仍为 blocked。
- 交付：设计增补 [`docs/architecture/addenda/T47-auto-memory-and-managed-settings.md`](../architecture/addenda/T47-auto-memory-and-managed-settings.md)：记忆存在 `<数据目录>/auto-memory/<项目键>/`（主 checkout 算出，worktree 共享），模型只经宿主工具 `Memory`（读、保存、删除，只收记忆名）经 Core 读写并写审计，索引由 Core 生成，第 4 段注入前 200 行或 25 KB，压缩后有变化时重注入；记忆页、`/memory`、transcript 提示，项目层只能关闭；托管配置为优先级 80 的 `enterprise` 层，来源为 macOS `/Library/Managed Preferences/cn.piarc.desktop.plist` 与 `/Library/Application Support/PiArc/`、Windows `HKLM\SOFTWARE\Policies\PiArc` 与 `Program Files\PiArc\`，多来源合并（锁取最严），兼容读取 Claude Code 的托管文件、偏好域、`HKLM` 键、托管 `CLAUDE.md` 与 `managed-mcp.json`；格式错误拒绝启动，每 60 s 检查变化，`ConfigChange` 不可阻断；第一版托管专属键为 `allowManagedHooksOnly`、`allowManagedPermissionRulesOnly`、`allowManagedMcpServersOnly`、`sandbox.network.allowManagedDomainsOnly`。行为参照 Claude Code 官方 `memory`、`settings`、`managed-settings`、`managed-mcp`、`hooks`、`permissions`（2026-11-22 重新核对）。
- 验收：A01 blocked（等待用户确认）；其余未开始。
- 下一项：用户确认增补第 11 节的 10 个要点（可逐条改选备选）后，再次 `/task T47` 进入实现。本地提交，未推送。

### 2026-11-22 T47（实现，部分完成）

- 交付：托管设置（`piarc_config::managed` 合并与锁、`piarc_core::managed` 各平台来源、启动拒绝与 60 s 轮询、`enterprise` 层、托管 hooks/MCP/沙箱/权限/Auto 模式键、写入锁定）；自动记忆（Core 的 `auto_memory::Store` 与审计、`Memory` 工具与第 4 段注入、压缩后恢复）；客户端的记忆页、`/memory`、transcript 的 Memory 行与"在设置中打开"、托管横幅与锁定标识、本地化启动错误对话框；L2 `memory-auto-*`、`managed-*`；L4 `t47-memory.e2e.ts`；提示词原创性检查 0 命中（8,533 词）。修复：设置窗口导航不更新地址导致 `openSettings(page)` 失效；macOS 上托管变化要等设置监听的首次 FSEvents 注册（负载下十几秒，9f98aea，先写复现测试）。
- 验收：A02–A12 passing；A13 blocked（用户要求跳过验证收尾：最终提交上未跑全量 `npm run verify`，`docs/product/capabilities.md` 未重新生成，Windows 注册表测试待 CI）。
- 未做：`coding-standards.md` 复用表（托管来源读取、托管锁定判断）、S10 报告第 20 行补 T47 的 4 个 IPC 方法、设计增补的实现细化一节；登记事项 I156、I157、I169 的 T47 评估未处理。
- 下一项：跑 `npm run verify`（必要时先按 L2 结果重新生成 `capabilities.md`），补上述文档，推送后按 Windows CI 关闭 A13。本地提交，未推送。

### 2026-11-23 T47 续做（macOS 验收通过，等待 Windows CI）

- 修复与决策：用户委托裁决 I169，采纳 [ADR-0065](../adr/0065-managed-http-hook-allowlists.md)。管理员可独立限定 HTTP hook 的 URL 和请求头变量，空列表有效（41d9b0c）。记忆索引连同标题和截断提示遵守 200 行、25 KiB 的上限；撤销信任后保留索引，拒绝模型继续读取主题和压缩恢复正文。同名文件即使损坏也由导入保留，更改按项目串行（3d85cde）。以上问题均先运行失败测试再修复。
- 交付：补齐工程规范复用表、S10 第 20 项的 4 个 IPC 方法和设计增补第 9.1 节。按完整 L2 报告更新能力清单，T47 六项能力有场景。I156 已评估，动态请求头命令仍由配置诊断标为不支持；I157 已复核，同名不同地址的 OAuth 状态仍需单独迁移。
- 全量验收：干净提交 d0b3109 上 `RUST_TEST_THREADS=2 npm run verify` 17/17 PASS。Vitest 164 个文件、1,796 项通过、1 项跳过；L2 239 通过、0 失败、3 项仅 Windows，199 项 active 能力 MISSING 0。`PIARC_EVIDENCE_TASK=T47 npx playwright test -c apps/desktop/playwright.config.ts t47- preload.e2e --project dev --output=tmp/evidence/T47/closeout-l4` 9/9。日志在 `tmp/evidence/T47/verify-d0b3109-j2.log` 和 `tmp/evidence/T47/closeout-electron.log`。
- 验证中修复两套托管 JSON 夹具的格式（e7262b0），并让 Agent Host 测试夹具按生产顺序在 Core 登记会话后再向 Host 发起创建，校验打开时的记忆状态查询（d0b3109，18 项 Agent Host 测试通过）。本机默认并发的全量运行曾分别在 macOS 设置监听、沙箱联网构建用例超时，两者单独复测通过；最终运行限定 Rust 测试并发数为 2，沿用原断言和超时。
- A01–A12 passing；A13 blocked，只缺包含夹具修复的 Windows 原生 CI 验收。[CI 45110810423](https://github.com/Refinex-Space/PiArc/actions/runs/45110810423) 对应 e7262b0。看板下一项为 T48（macOS），其实现不依赖注册表原生测试。

### 2026-11-23 T47 核对 Windows CI（本地修复 e2ffefa）

- [Windows verify 45110810423](https://github.com/Refinex-Space/PiArc/actions/runs/45110810423/job/137482483164)（e7262b0）已实际运行注册表读取和排除用户策略的两项测试，均通过。Windows L2 227 通过、15 项按平台跳过。17 步中只有 Rust 测试未通过。
- Windows 新发现的两项失败均已定位。A04 的工作树夹具把 verbatim 路径传给 Git，创建 worktree 时即报错，尚未执行记忆共享断言。夹具现复用 `piarc_git::canonical`。T46 审查回退用例可能在读取“审查中”卡片前收到脚本回复，版本断言比较了同一个版本；现每轮读取初始版本后才放行回复，仍逐项检查版本递增和拒绝过期答复。生产代码无改动。旧提交的 macOS CI 另有两项待复核，见 I228。
- 修复后在 macOS 定向重跑两项用例均通过，`piarc-core` 的 Windows x64 交叉 Clippy 通过。在干净提交 e2ffefa 上，`RUST_TEST_THREADS=2 npm run verify` 17/17 PASS，L2 239 通过、3 项仅 Windows，MISSING 0。完整日志在 `tmp/evidence/T47/verify-windows-followup.log`。
- A01–A03、A05–A12 通过；A04 和 A13 等待含 e2ffefa 的 Windows 原生 CI。看板下一项为 T48（macOS），两项遗留仅涉及 Windows 验收。

### 2026-11-23 T47：Windows worktree 验收通过，A13 待复验

- [Windows verify 45119779192](https://github.com/Refinex-Space/PiArc/actions/runs/45119779192/job/137510807884) 对应 bbc6b60。worktree 共享与仓库隔离、两项原生注册表测试及 T46 审查状态测试通过，Windows L2 为 227 通过、15 项按平台跳过。A04 已标 passing。
- [Windows L4](https://github.com/Refinex-Space/PiArc/actions/runs/45119779192/job/137510807936) 中 T47 的记忆页、托管锁定、命令面板及打包探针 7/7 通过。整项 342 通过、3 失败、28 跳过。3 个失败均在 T34 终端，详见 I227，继续由 W4 跟进。
- Windows verify 16/17，唯一失败是 I227 中 Git Bash 语法错误用例的输出前缀。7ab91c5 只调整测试夹具，将前置标记和语法诊断送入同一管道，继续检查前缀、行号、退出码和后续命令未执行。根据 ADR-0028，跨管道输出按到达顺序合并。
- 本机在干净提交 7ab91c5 上运行 `RUST_TEST_THREADS=2 npm run verify` 17/17 PASS，L2 239 通过、3 项仅 Windows；Windows x64 的 `exec_commands` 交叉 Clippy 通过。原生 Windows 验收仍需包含该提交的 verify。A01–A12 passing，A13 blocked。

### 2026-11-23 T47 已完成（验收提交 9212335）

- A01–A13 全部 passing。macOS arm64 在干净提交 9212335 上运行 `RUST_TEST_THREADS=1 npm run verify`，17/17 通过。[Windows x64 原生 verify](https://github.com/Refinex-Space/PiArc/actions/runs/45159997698/job/137642677414) 同一提交也为 17/17。注册表读取、排除用户策略、worktree 共享及仓库隔离均有通过记录。L2 在 macOS 为 239 通过、3 项仅 Windows，在 Windows 为 227 通过、15 项按平台跳过。
- 修复复验中发现的问题：配置诊断核对覆盖来源的完整路径（8d31bf2）；共享 MCP 进程的测试按规范路径核对工作区并校验两个会话得到同一非零 PID（c333144）。MCP hook 的 Agent Host 超时先于 Core 返回时，原来报告普通中断，审计也失去超时标记；9212335 透传 AHP 的 `timeout`，两端都生成同一通知及审计。远端先超时的回归和 L2 `hooks-m4-mcp-tool` 在 Windows 均通过，期限与中断行为保留。
- [Windows 桌面 L4](https://github.com/Refinex-Space/PiArc/actions/runs/45159997698/job/137642677946) 的 T47 相关 7 项全部通过。整个作业 343 通过、2 失败、28 跳过，剩余的两项均是 T34 终端恢复，继续由 I227/W4 跟进。macOS CI 的独立问题见 I228。
- 看板下一项为 T48（M5 Harness 补全，macOS）。

### 2026-11-23 T48 部分完成（实现提交 03b7ed1，待原生环境验收）

- 压缩设置按模型选择 `client` 或 `anthropic-server`；恢复时保留原始 JSONL，失败回退。fork 子会话、`/subtask` 与隔离 skill 已接入。Core 分发七个 M5 hooks，pi-mcp 1.5.2 的公开接口支持表单与 URL 询问。目录归属在 schema v12 登记。协议正反样本覆盖 217 个契约。没有调用付费模型、提交上游 issue 或推送本分支。
- 用户委托本次会话裁决 ADR-0066、0067、0068，三者均已接受：fork 保留声明而执行权受限，隔离 skill 的授权绑定实际执行者，hook 目录在无法核实改动时保留。本次按任务文件的 12 项验收收尾；R5 另派的 I56、I94、I121、I123、I126、I172、I173、I175、I176、I178、I197、I199 仍按登记记录跟进。
- **通过 A01、A03、A04**：真实 SessionRegistry 对两个协议的严格 mock 发出 14 个请求；上下文 21,000 越过 14,904 阈值，两种服务端策略各 0 次本地摘要，两个客户端对照各 1 次。重启后恢复摘要所在位置，旧文件字节前缀保留。fork 逐字节比较实际 HTTP 的 system 与工具，并检查助手发起消息、父历史和缓存标记。证据在 `tmp/evidence/T48/compaction-high-water.json`、`fork-wire.log`。
- **阻塞 A02、A05–A12**：权限、hook 目录操作、模型切换、MCP 表单与 URL 已有实际 Core、SDK 或 DOM 定向测试。macOS 原生 Seatbelt 在本会话中返回 `sandbox_apply: Operation not permitted`。最终独立完整 L2 共 254 项：247 项打开工作区超时，4 项启动设置 Host 失败，3 项仅适用 Windows。Electron Playwright 启动收到 SIGABRT，ego-browser 无法建立 macOS XPC 连接。无桌面验收截图。Windows x64 的全工作区交叉 Clippy 通过，T48 的原生 Windows CI 未运行。
- 在干净提交 03b7ed1 运行 `npm run verify` 为 12/17（`tmp/evidence/T48/verify.log`）。同提交独立构建两种 Core 模块、API 声明快照及 renderer 通过；Core 单测 237 项通过，独立计时测试也通过。受限模块涉及 NAPI 与 bundle 目录清理、进程检查、真实 Seatbelt、L2 和缺少其报告的威胁映射。单独核对威胁映射通过（14 条威胁、59 个对策、170 个测试 ID）。
- A11 的 10 项能力均已登记，本次生成与漂移复核均为 MISSING 0；环境生成稿保存在 `tmp/evidence/T48/capabilities-final.md`，报告在 `l2-final.json`。在可运行 Seatbelt 与 Electron 的 macOS 会话中重新跑全量 L2 和 T48 Playwright，用成功的 L2 报告重新生成 `docs/product/capabilities.md`，提交后执行 `npm run verify` 并核对对应 Windows CI。开工时还按协议用既有 CI 原始日志关闭了 T46-A13 和 R5-A01。
- 看板下一项 T49 在 macOS 执行。当前环境不能建立绿色开工基线，优先复验 T48。

### 2026-11-23 T49 已完成（全量验证提交 f11a450）

- 12 项验收全部通过。侧边对话从已完成回合取得上下文，独立停止，关面板丢弃，工具拒绝与用量单列。专用外部草稿路由与侧边会话设计见 ADR-0069、ADR-0070。
- macOS arm64 的 `npm run verify` 17/17，完整 L2 252 项通过、3 项仅适用于 Windows，能力覆盖 MISSING 0。桌面定向 Playwright 的 dev、packaged 各 12/12，ego-browser 实操、侧边面板亮暗 axe 检查通过。证据在 `tmp/evidence/T49/verify-final.log`、`native-playwright-final.log`、`ego-native-side-chat.png`。
- 用户在快捷指令中找到并运行原型，又在正式包确认工作区正确、草稿原样显示、没有自动发送；本次接受文字记录代替截图。两个 macOS 发布架构的打包、动作元数据、签名与 fuse 均有 CI 记录，见 [工程记录](../engineering/app-intents.md)。
- [Windows x64 CI](https://github.com/Refinex-Space/PiArc/actions/runs/45201604327/job/137786269417) 在 cdb81a0 上的跳转列表与启动路由测试通过，整个 Vitest 1844/1844。该版 Windows 全量为 16/17，唯一失败的 Rust 命令清单断言已在 6a562f6 补齐并通过本机全量。Windows 菜单的实机显示与点击由 W4 按 I229 验证。下一项为 T50（macOS）。

### 2026-11-24 T34 已完成，I185 已修复

- 14/14 项通过。W2 补验了 Windows 全量；本次补齐正式终端面板的 macOS 简体拼音。shell 与 Vim 均逐键输入、空格选词，shell 写出的文件精确等于“你好世界测试”。Vim 中 Esc 只取消新的合成，继续输入 x，保存后只有“你好世界测试x”及换行。9 张系统截图和逐次光标位置在 `tmp/evidence/T34/native-ime/`。
- I185 的失败先在阻塞监听注册、未送达资源通知、诊断页未收到文件事件三种情况下复现。修复后的定向 Vitest 9/9，Core 状态集成 8/8，诊断页 T24/T41 Electron 用例、ego-browser 的可见与回窗刷新均通过。T34 初次面板回归 11/11；修复后一次 Vim 用例在初始屏幕超时，原样复跑通过。
- `1b15296` 的默认并发 `npm run verify` 17/17；修复前的两次全量均为 16/17。输出分别在 `tmp/evidence/T34/native-ime/verify-i185.log`、`verify.log`、`verify-final.log`。

### 2026-11-24 T48 已完成

12/12 项通过。macOS 全量 L2 已跑过原来受环境阻塞的故障回退、fork、M5 hooks、MCP elicitation 等全部 12 个专项场景。fork 和 elicitation 的 Electron 用例本轮通过，model-switch 首次在夹具启动时超时，单独复跑通过。cdb81a0 的两个平台 CI 也分别在 dev 和 packaged 通过上述三个桌面用例。[Windows L2](https://github.com/Refinex-Space/PiArc/actions/runs/45201604327/job/137786269417)。

### 2026-11-24 W3 补记 Windows 全量验证

W3-A12 已由 1e24074 的 Windows CI 17/17 补齐。按 ADR-0063 回看旧内存报告，单次私有工作集 256 MB 达标，缺少正式稳态采样窗口的最大值；W3-A01 已明确为待 Windows 实机重测，W3 保留“部分完成”。

### 2026-11-24 T44 补记全量验证

A09 已由后继代码上的两次全量 17/17 补齐。A04 按同一提交连续五次 PR 性能冒烟单独判定。

### 2026-11-24 T42 已完成

macOS 系统显示了模拟会话的审批标题和命令，展开后两项可操作，原生“Allow once”作答通过。通知不可用的用例验证了设置说明及应用内审批。Windows 通知验收沿用 W3 的既有记录。证据见 `acceptance.json` 的 T42-A06。

### 2026-11-24 T35 已完成

Apple M1 Max / 32 GB，macOS arm64，打包开发构建 1b15296，npm run perf:m3 -- --form packaged。12 个稳态样本，3 个并行会话（含独立 worktree）加 1 个子 agent，共享一个 stdio MCP server 且 4 个会话都取得 skills 索引；loadAsDescribed=true。Agent Host RSS 最大 217.9 MB / 270 MB，应用其余进程物理占用最大 270.0 MB / 510 MB。口径按已采纳的 ADR-0063，原始报告 tmp/evidence/partial-closure/m3-memory.json；此前 R5 复测为 229.1 与 263.8 MB。

### 2026-11-24 R4 已完成

逐项核对 T31–T38 和 W2 的 120 个验收项，全部为 passing。此前的 T34-A03 已实测通过，T35-A11 按 ADR-0063 完成物理内存复测。 内存原始数据、预算和 macOS 退出结论见 `docs/reviews/R4-findings.md` 收尾复核。

### 2026-11-24 T44 已完成

提交 0cbecdc，Mac M1 Max / 32 GB、接电、打包开发构建，连续执行 5 次 node scripts/perf/run.mjs --lane pr --runs 3 --machine m1-max-32g。五次退出码均为 0，每次 10 个指标均取得 3 轮结果，无探针错误和回归。打包后独占运行性能测量，最终全仓验证另外串行执行。每次执行前后核对 Git HEAD，完整日志与逐轮 report.json 保存在 tmp/evidence/partial-closure/pr-five-0cbecdcbb5e7752bce441f9f2851097c724b742d。 结合已通过的 A09，T44 的 8 项验收全部 passing。

### 2026-11-24 R5 补齐 M4 能力与依赖验收

逐项核对 T39–T45、W3 的 95 项，92 项通过；有证据边界的阻塞项为 T43-A10（未实测的 VoiceOver 操作与播报）、T45-A02（新增 Windows 终端用例和双平台发布探针的 CI 记录）、W3-A01（Windows 实机的新版私有工作集时间序列）。第 16 章 M4 九项与任务证据见 R5-findings.md 第 1.3 节。完整 L2 的能力覆盖 MISSING 0，M4 及之前 planned 0。 全部性能预算由 R5-A02 单独判定。

### 2026-11-24 R5 已完成（macOS）

Apple M1 Max / 32 GB、macOS arm64、接电。提交 0cbecdc 执行 node scripts/perf/run.mjs --lane nightly --absolute --machine m1-max-32g，25/25 个指标同时通过绝对预算及已有相对基线，无错误。打包运行时代码与 0cbecdc 一致。主进程 RSS 增量 23.10/24 MB，单活动会话 Agent Host 142.97/150 MB，流式帧 p99 8.41/12 ms。结果在 tmp/evidence/partial-closure/nightly-full-results/report.json。Windows 数据及 W4 归属见 R5-findings.md 第 1.2 节与 W4 清单。 第 16 章及评审索引已同步。

### 2026-11-24 桌面交互焦点（计划外维护，提交 88cc245）

- 编辑框、附件、分段单选、菜单与终端分别标记当前焦点目标。鼠标点入文本框显示 1 px 灰阶边线，键盘导航显示 2 px 轮廓。使用规则见 `docs/engineering/accessibility.md`。
- macOS 上 `npm run verify` 17/17；`t43-keyboard`、`t43-a11y` 的 Electron dev 回归 13/13，61 个状态在明暗主题下共 122 份 axe 报告，零违规。14 种背景在四种主题下的焦点色对比度最低为 3.27:1。
- ego-browser 实操与 Chromium、Firefox、WebKit 的本地控件检查通过。截图、axe 与全量验证报告在 `tmp/evidence/focus-state/`。Windows 原生显示效果尚未复核。

### 2026-11-24 桌面导航列表间距（计划外维护，提交 642f53c、fa2fe4f）

- 设置与会话导航、搜索命中、模型与输出风格、弹出菜单、命令面板和输入候选共用纵向布局。实测设置行在舒适模式高 32 px、间隔 4 px，紧凑模式高 26 px、间隔 3 px。点击两行间的留白保留当前页。
- 修复前复现设置导航间距为 0 px、命令面板键盘选中末项时可见比例为 0。修复后 ego-browser 在浅色、深色及 250 px 高的窗口验证了间距、滚动和键盘操作；含换行说明的 24 项菜单在窗口边缘可达首尾。真实 Electron 中测量了会话、搜索、菜单、文件提及、命令及风格选择的相邻背景。
- macOS 上 `npm run verify` 17/17，L2 252 项通过、3 项仅适用于 Windows。桌面 dev 独立复跑 36/36，61 个状态各两种主题的 axe 报告零违规。首次扩展回归发现旧命令清单缺少已登记的两项，已补齐精确数量与顺序断言；一次与其他窗口测试重叠的试跑中快捷键重绑断言超时，独立复跑通过。证据在 `tmp/evidence/list-spacing/` 与 `tmp/evidence/list-spacing-recheck/`。Windows 原生显示未实测。

### 2026-11-24 桌面前端对标决策与共享分段控件（提交 d3c8556、9a8488d）

- ADR-0073 已接受。桌面前端以 Claude Desktop 的视觉与交互为长期基准，按组件逐项对齐，后端采用 PiArc 自有 Core、Agent Host 与 Pi Harness。
- 外观、沙箱与会话视图切换共用原生单选组和一个装饰性选中面。对照 OpenClaudeDesktop `next-4.16336.0` 的 Default transcript view 实测，舒适/紧凑模式的高度、圆角、字号、行高、内距均一致。在相同英文标签下，系统字体渲染的控件总宽相差约 1.0–3.4 CSS px。中文点击、按压、方向键、托管禁用、强制颜色和减少动效经本地操作核对。
- macOS 上 `npm run verify` 17/17，L2 252 项通过、3 项仅适用于 Windows。Electron dev 独立复跑 23 项通过、1 项仅适用于 Windows；61 个状态的 122 份明暗主题 axe 报告零违规。一次试跑等待 Electron 首个窗口超时，复跑整组通过。参考渲染、PiArc 截图、状态与动画数据在 `tmp/evidence/segmented-control/`；Windows 原生显示未复核。

### 2026-11-24 共享按钮与次级操作表面（提交 d78e86a、d5f9b4d、6939e75）

- 设置操作使用共享原生 Button，普通、主要、低优先级和危险操作各有对应状态。加载沿用原标签的布局，显示进度标记并阻止重复激活。权限页的添加规则延用原有编辑和确认流程。
- 在隔离的 OpenClaudeDesktop next-4.16336.0 账户页测量 Refresh，并与 PiArc 同标签复核。两档的可见高度、水平内距、圆角、默认填充、内缘与微投影一致；同标签自然宽度随系统字体略有差异。ego-browser 实际操作了明暗主题的规则编辑、取消和键盘焦点；四种主题/密度组合验证悬停、按压、禁用、加载及尺寸稳定。强制颜色与减少动效已在浏览器模拟。
- macOS 在 6939e75 上执行 `npm run verify`，17/17 通过，L2 252 通过、3 项仅适用于 Windows。Electron dev 的相关回归 37/37；61 个状态各两种主题的 122 份 axe 报告零违规。截图、参考测量与验证日志在 `tmp/evidence/button-surfaces/`；Windows 11 原生显示未复核。
