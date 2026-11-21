# @piarc/agent-host

Agent Host：一个 Node 进程，用 Pi SDK 托管一个工作区的多个会话，经 stdin/stdout 上的 AHP 与 Core 通信（架构第 5 章、ADR-0002、ADR-0010）。工具的文件与命令 I/O 全部委托给 Core（ADR-0004、ADR-0020）。不负责权限裁决、hooks 执行、快照、沙箱、凭据持久化（都在 Core）；监管它的是 `crates/piarc-host`。

## 命令

| 命令 | 用途 |
|---|---|
| `npm run build:agent-host` | esbuild 打包到 `agent-host/dist/bundle/agent-host.mjs`，并写 `pi-assets/package.json`；`@piarc/protocol` 从源码打包，不依赖 `tsc` 产物 |
| `npx vitest run agent-host` | 单元测试：出站队列（含回放缓冲、单帧上限）、投影与 golden 测试（`projector.golden.test.ts` 打印覆盖矩阵）、排队表、工具批次、中断补齐、Core 桥接、工具层、凭据存储、信任接管、MCP 连接池（`src/mcp/pool.test.ts`，手动时钟） |
| `npx vitest run agent-host -u` | golden 录制更新后重写投影的期望输出（`test/golden/*.expected.json`，提交前逐个审阅） |
| `PIARC_UPDATE_GOLDEN=1 cargo test -p piarc-testkit --test agent_host golden` | 用真实 Agent Host 与 mock 重新录制 golden 输入（`test/golden/*.events.json`）；不带变量时只核对 Pi 产生的事件类型没有变化 |
| `cargo test -p piarc-testkit --test agent_host -- --nocapture` | 端到端：Core 监管真实 bundle、mock provider 应答（S3、S4、S5 与进程级 S9；`trust.rs` 是 T13 的项目扩展随信任加载与撤销）；测试会先自己打包 |
| `node agent-host/dist/bundle/agent-host.mjs --data-dir <dir>` | 手动运行；需设 `PI_PACKAGE_DIR=<bundle>/pi-assets`，stdout 只走 AHP 帧。`--tool-profile <json>` 覆盖默认 Profile 的名称与描述、`--pi-native-tools` 换回 Pi 原生工具、`--test-oauth-provider <json>` 注册接本地 token 端点的 OAuth provider、`--test-record-events <dir>` 把每个会话的原始 Pi 事件与注册表的步骤写成 `<dir>/<sessionId>.jsonl`、`--test-drop-seq <n>` 让 seq 为 n 的会话通知不写出（仍进回放缓冲），都只给测试用，Core 不传 |

## 入口与进程边界

- `src/main.ts` 设置 Pi 数据目录并把第三方 stdout 日志改写到 stderr。首次退出信号启动有序关闭，第二次立即退出。`src/host.ts` 处理握手、分派与关闭，主版本不兼容退出码为 3，出站积压超限为 70。
- `runtime/session-registry.ts` 管理会话与恢复。实时投影和历史回放共用 `items.ts`；投影规则见 `projector.ts` 文件头和 `test/golden/`。工具批次、中断补齐与结果预算在 `harness/`，50K/200K 阈值统一由 `TOOL_RESULT_LIMITS` 提供。
- `CoreBridge` 默认等待 30 秒。审批请求只有收到匹配的 `policy/pending` 后才停表，中断或断连会取消等待。`OutboundQueue` 写出时分配 seq，每会话保留最近 4,096 条或 8 MiB 通知供回放；超 8 MiB 的单条通知不占 seq。
- `tools/profile.ts` 负责规范名与模型可见名的映射，`tools/core-io.ts` 负责委托 I/O。文件工具的替身路径、shell 探测及结果格式见下文。项目资源必须等待 `harness/project-trust.ts` 的 Core 信任答复；凭据只经 `runtime/credentials.ts` 的 `CoreCredentialStore`。
- `scripts/dev/build-agent-host.mjs` 只允许外置 `@silvia-odwyer/photon-node`（从包目录加载 WASM）及可选的 `bufferutil`、`utf-8-validate`、`kerberos`、`supports-color`。其余导入内联。codemode worker 与图片缩放 worker 尚未打包；Bedrock 与 pi-ai 的 OAuth 流程（T29）经公开加载器（`registerLazyBedrockProvider`、`registerLazyOAuthFlows`）纳入 bundle。

## 不变量

- stdout 只写 AHP 帧，且只经 `OutboundQueue`。日志写 stderr，会话相关的行以 `[session <id>] ` 开头（Core 据此打会话标签）。
- 发往 Core 的字符串必须是合法 UTF-16（Rust 端拒绝孤立代理项）：增量走投影器的代理项处理，其他字符串用 `toWellFormed()`。
- `session/prompt` 先回复再开始回合（`setImmediate`），Core 总是先拿到 `turnId`。`requestId` 是幂等键。
- 只从 `@earendil-works/*` 的包入口或 `exports` 声明的子路径导入（ESLint 检查）；Pi 的 API 以锁定版本的类型声明为准。
- 凭据只来自 Core 的保险箱（`CoreCredentialStore`），`pi/` 下不写 `auth.json`；不从环境变量读凭据，也不把凭据放进 `process.env`。日志与错误只写键名（`provider/<id>`），不写值。
- `src/tools/`、`src/harness/` 不导入 `fs`、`fs/promises`、`child_process`（ESLint，含动态导入与 `require`）：文件与命令只经 `CoreIo`。新工具的 I/O 加在 `CoreIo` 上，不在工具里绕开。
- 模型可见名只出现在发给模型的工具定义里；投影的 `item/*`、发往 Core 的 `origin.tool`、规则与 hooks 都用规范名（`ToolNameMap`）。Profile 不能用 Pi 原生工具名（会话把它们排除了）。
- Read、Write、Edit 交给 Pi 的 `path` 是替身：结果与错误里的替身必须换回模型写的路径（`StandIn.restore`/`restoreError`）；Pi 新增对传入路径的 Operation 时，`StandIn.resolve` 抛出"unexpected path"。

## 会话输入（ADR-0030）

- 锁定的 pi-ai 1.5.2 在 `UserMessage.content` 接受字符串或文本与图像块。图片读取 blob 后作为图像块交给 Pi。PDF 经 `fs/pdf` 读取前 20 页以内的文本，后续页可按路径用 Read 的 `pages` 参数读取。升级 pi-ai 时复核 `types.d.ts` 是否支持文档输入。
- 每次交付用户消息前写 `piarc.input` 记录 `turnId`，带提及或附件时还记录原始正文和元数据。手动压缩前记录 `{turnId, action: "compact"}`。历史窗口输出 `turnId`，旧文件按最近用户消息的 entry id 分组。编辑排队文本会清除失效的提及区间，保留已经准备好的附件。
- 每条模型回复结束时投影 `turn/usage`（本回合累计量）。`turn/completed` 的错误分类在 `runtime/turn-errors.ts` 计算，客户端按 `errorKind`、`retryable` 呈现。

## 分支与回退（T28，ADR-0044）

- `runtime/branches.ts` 是分支的唯一实现：回合起点（每个回合第一条 `piarc.input` 的 `from`，旧记录取父条目）、分支点（起点落在同一锚点的回合互为分支，跳过记录、模式与模型变化、system 装载消息与分支摘要）、`rewindToTurn`（leaf 移到起点并追加 `piarc.branch`）、`summarizeFromTurn`（`compaction.ts` 的 `summarizeBranch` 用 T27 的摘要提示，再经 Pi 的 `branchWithSummary`）、`switchTo`、`forkedManager`（`session/fork` 的 `beforeTurn`）。Pi 打开文件时 leaf 在最后一条 entry，所以追加的条目就是持久化的位置；不删除任何 entry。
- 回退与切换之后注册表在同一 id 下关闭并重新打开 Pi 运行时（`#reopen`，source `branch`：不触发 SessionStart/SessionEnd hooks，`seq` 连续），计划、模式、memory、读写记录随分支重新推导；MCP 连接在池中，重开只交还再取回租约，不重连（T36，I111）。历史窗口与 `session/branches` 通知带分支点（`history.ts`），`branch_summary` 投影为原因 `rewind` 的压缩条目。
- 中断补齐（`harness/interruption.ts`）只把 user、toolResult 或有回复的 assistant 当作末尾：以分支摘要或提醒结尾的对话不是被中断的回合。摘要之后的第一条输入紧跟摘要（两条相邻的 user 消息），`rewind-summarize` 场景因此关闭 `role_order` 检查。

## 子 agent（T31，ADR-0048）

- 位置：`harness/subagents/` 是工具侧（`agent-tool.ts` 的 `Agent` 工具、`definitions.ts` 的内置类型与 `agents/list` 解析、`tool-filter.ts` 的过滤），`runtime/subagents.ts` 的 `SubagentRunner` 是运行与计数，`runtime/subagent-session.ts` 的 `ChildSession` 是一个子会话（打开、运行、结束），`runtime/session-runtime.ts` 是主会话与子会话共用的 Pi 运行时工厂。提示词在 `harness/prompts/subagents.ts`（改后跑原创性检查）。
- 工具过滤顺序：父会话当前工具 → 定义的 `tools` → 减去 `disallowedTools`（优先）→ 减去 `PARENT_ONLY_TOOLS`（`AskUserQuestion`、`EnterPlanMode`、`ExitPlanMode`、`SuggestNextSteps`）→ 深度到上限时减去 `Agent`。实现是每个工具的 `prepareLoadout` 返回 `hiddenDeclarations` 加 `tool_call` 闸门，不要改成 `setActiveTools`：被它移除的工具，调用在闸门之前就以 "Tool X not found" 结束，后注册的 MCP 工具默认激活。
- 深度与并发只在 `SubagentRunner` 计数（`#runs` 树加启动中的 `#starting` 占位，同一回复里并行的 `Agent` 调用不会一起越过上限）；上限来自 Core 的 `agents/list`。超限立即返回错误结果，不排队（前台子 agent 各自等自己的子 agent，排队会死锁）。
- 子会话先经 `subagent/start` 在 Core 登记再请求模型：没登记的会话 id 调 `fs/*`、`exec/*` 得到 `sessionNotFound`。子会话的 Pi 事件不发给 Core（Core 没有它的会话 actor）：进度汇总成 `SubagentState`，经父会话 `Agent` 调用的 `onUpdate`（`subagent` 条目的 `item/updated`）与 `subagent/*` 通知发出，最终状态另写父会话的 `piarc.subagentState` 条目供历史使用。
- 子会话 JSONL 首条是 `piarc.subagent`（父会话、类型）；身份段换成定义正文（`Persona`），`omitProjectContext` 的类型不加载 memory 与 git 状态；Tool Profile 按子会话自己的模型选；hooks 不发 SessionStart、Stop、SessionEnd，改发 SubagentStart（首次 `prompt` 之前，上下文进首个请求）与 SubagentStop（T38）。
- `isolation: worktree`（T35，ADR-0052）：调用参数或定义要求时，`ChildSession.open` 先 `subagent/start`（带 `isolation`）再按 Core 答的 `cwd` 创建 Pi 会话（会话文件按 cwd 放置，所以登记在前，`sessionFile` 不再随登记发送）；结束时 `finishInCore` 返回保留下来的 worktree，`#execute` 把 `worktreeKept` 的说明接在报告后。打开失败时照常 `subagent/finish`，Core 据此清理。
- `maxTurns` 到达后中止并把结果标 `partial`：报告取最后一条真实回复，跳过中断补齐写的标记（`isInterruptionMarker`）。前台运行随调用的 abort 信号中止（父会话中断）；后台运行不随中断结束，`close` 与 `subagent/stop` 中止它，结束后经 `harness.remind` 的 `backgroundTask` 提醒回报；进程重启后 `recover()` 把记录中仍在运行的后台运行标为 `interrupted` 并提醒。
- 同进程易错点：子会话与主会话共用工作区的 MCP 池（T36，见 `src/mcp/AGENTS.md`）；扩展加载器的模块级缓存按 cwd 失效，子会话与父会话 cwd 相同不受影响；不要在子会话代码里改 `process.env` 或读 `process.cwd()`。

## 后台任务（T32，ADR-0049）

- 能力 `backgroundTasks` 打开时：`Bash`/`PowerShell` 有 `run_in_background`，结果带 `task` 时文案说明转后台与输出文件（`tools/shell.ts` 的 `taskText`）；`harness/task-tools.ts` 注册 `KillShell`（`shell_id` → `exec/background/kill`，`notFound` 换成给模型的说明）与 `Monitor`（`exec/monitor`）。结果文案在 `harness/prompts/tasks.ts`（改后跑原创性检查）。
- 能力 `terminalTasks`（T33，ADR-0050）：`Bash`（不含 PowerShell）有 PiArc 自有的 `terminal`，为真时隐含后台，命令在会话的 PiArc 终端里运行；结果文案说明屏幕文件与命令结束通知（`taskText` 的终端分支）。L3 allowlist 登记了这个有意偏离。
- `session/remind` 进 `SessionRegistry.remind`：`SessionHarness.remind` 带 `key` 时文本原样、同键替换、分支上已有同类型同来源的已送达提醒就答 `delivered`；`wake` 且会话空闲时开一个 `wake` 回合：写 `piarc.input`（`action: wake`）后以排队的提醒消息 `sendCustomMessage(…, { triggerTurn: true })` 启动运行。`wake` 回合不是分支点（`branches.ts`），历史里提醒条目归入该回合（`history.ts`）。
- 后台子 agent 的通知仍由 Agent Host 排队（ADR-0048），Core 只登记与停止它的任务。

## Skills、命令与输出风格（T37，ADR-0054）

- 发现在 Core（`piarc_config::skills`）：项目优先于用户，同级 `.piarc` > `.claude` > Pi 的目录（`.pi/skills`、`.agents/skills`、`<数据目录>/pi/skills`、`~/.agents/skills`；命令另有 `.pi/prompts`、`<数据目录>/pi/prompts`），项目目录从 cwd 向上。Agent Host 只经 `skills/list`（带会话 id）取结果：会话运行时传 `noSkills: true`、`noPromptTemplates: true`，Pi 不加载、不列出、不展开 `/skill:` 与模板。不要在 Agent Host 读 skill 或命令文件，也不要改回 Pi 的资源加载器（`allowed-tools` 与 hooks 要由 Core 判断）。
- `harness/skills/session-skills.ts` 的 `SessionSkills`（能力 `skills`，每会话一个，`session-parts.ts` 建）：`catalog()` 缓存 Core 的回答，`resources/reload`（`SessionRegistry.reloadResources`）只让它失效，下一次运行前重新取；`sections()` 在冻结 system prompt 时给出第 3 段（输出风格）与第 5 段（索引，描述截断到 `SKILL_INDEX_DESCRIPTION_CHARS`），并写 `piarc.skillsIndex`、`piarc.outputStyle`；它的扩展在 `before_agent_start` 比对分支上的记录，变化以 `skillsChanged`（键 `skills:index`）、`outputStyle`（键 `style`）提醒送达，在 `tool_result` 对 Read、Write、Edit 的文件经 `skills/match` 激活 `paths` skill（`piarc.skillsActive`，提醒键 `skills:paths`）。扩展排在 `harness.extensions()` 最前（memory 之后、提醒送达之前）。
- `Skill` 工具（`harness/skills/skill-tool.ts`）只在会话打开时模型有可调用的 skill 才注册（工具集整个会话不变）；执行经 `skills/invoke`（Core 消费同一调用的授权、替换参数、登记回合级 `allowed-tools` 与 skill 的 hooks），正文是工具结果，并写 `piarc.skillInvoked` 供 T27 的重注入；同一正文再次加载只回答已加载。描述与结果文案在 `harness/prompts/skills.ts`，内置输出风格的指令在 `harness/prompts/output-styles.ts`（改后跑原创性检查）。
- `allowed-tools` 的传递：Agent Host 不传规则。用户的 `/名称` 由 Core 在 UserPromptSubmit 之前展开并直接登记；模型的 `Skill` 调用经 `policy/evaluate`（只读，`Skill(名称)` 规则）后由 `skills/invoke` 登记。`session/prompt`、`session/steer`、`session/followUp` 的 `command` 进 `UserInput.command`：`piarc.input` 记下用户输入的原文与命令（`inputRecord`），`userMessage` 条目显示原文并带 `command`，历史不要求消息以原文开头；skill 的 `/名称` 另写 `piarc.skillInvoked`（`SessionSkills.invokedByUser`）。
- `resources/listSkills`、`resources/listCommands` 由注册表的 `resources(cwd)` 取 Core 的 `skills/list` 回答；插件与 MCP prompts（T40）在这里并入。

## 扩展包与 MCP prompts（T40，ADR-0058）

- Pi 包的扩展：能力 `plugins` 打开时，注册表 `#open` 经 `runtime/plugin-extensions.ts` 的 `pluginExtensions` 取 Core 的 `plugins/extensions`（已确认的入口文件，任何失败都不加载），作为 `additionalExtensionPaths` 交给 Pi（`session-runtime.ts`）；不要把包写进 `pi/settings.json`（Pi 会为缺失的包运行带脚本的 npm）。`resources/reload` 时 `changedExtensions` 比对，变化的空闲会话立即重开，运行中的回合结束后重开（`profileStale`），并让 MCP 池 `refresh()`。子 agent 的会话不加载包的扩展。
- MCP prompts：`src/mcp/prompts.ts`（命令名、参数对应、文本拼接）、连接的 `prompts`/`getPrompt`、池的 `prompts()`/`getPrompt()`；`resources/listCommands` 经 `withPromptCommands` 接在 Core 的命令后，输入经 `expandInput` 在 `#prepare` 之前展开（Core 已展开过的输入不动）。

## WebSearch 与 M3 hooks（T38，ADR-0055）

- 后端选择：`SessionHarness.prepareWebSearch(model)` 在会话打开时（`tools()` 之前，注册表 `#open` 与 `ChildSession`）决定是否注册 `WebSearch`：Core 开了能力 `webSearch`，且会话模型能原生搜索（`ModelPreferencesStore.nativeWebSearch`：用户的每模型设置，否则 `nativeSearchKnown`，即服务商 `anthropic` 的 Anthropic Messages 模型）或 `web/searchBackend` 报告有第三方后端。Pi 选的模型与预测不同且原生能力不同时重新决定并重开（同 Profile 的做法）。执行时再按当时的会话模型选：原生 → 辅助模型通道（会话模型，`onPayload`/`onProviderStreamEvent`），否则 `CoreIo.webSearch`（`web/search`），都没有时工具结果是 `NO_SEARCH_BACKEND`。
- 服务商适配只在 `providers/web-search.ts`（`nativeSearch` 返回加工具与读结果块的一对钩子，`nativeSearchCapability` 给能力表）；新增服务商的原生搜索加在这里，工具代码（`harness/web-search.ts`）只认 `WebSearchSource`。结果条目的 `details.webSearch`（查询、后端、来源）由 `items.ts` 投影成 `webSearch` 条目。文案在 `harness/prompts/web-search.ts`（改后跑原创性检查）。
- `hooks/prompt`（Core → Agent Host）：`SessionRegistry.judgeHook` → `harness/hook-judge.ts` 的 `judgeHook`（`model` 经 `resolveModel`，别名表取 Core 的 `agents/list`；缺省辅助模型；`AbortSignal.timeout`），判定提示在 `harness/prompts/hook-judge.ts`。只回答模型的原文，解析与翻译在 Core。
- M3 hooks 的挂载见 `src/harness/AGENTS.md`；`effort`（`SessionHarness.effort()`，`off` 时没有）随 `policy/evaluate` 与工具类事件、Stop/SubagentStop/PostToolBatch 的 `hooks/run` 发出。

## 子目录说明

- `src/harness/AGENTS.md`：system prompt 与 memory、权限预检、hooks、宿主工具、上下文工程（提醒、压缩、重注入、熔断、用量）、回合不变量的补齐。
- `src/providers/AGENTS.md`：模型与服务商、凭据适配层、每模型偏好、Tool Profile 选择、登录、WebFetch 的辅助模型。
- `src/mcp/AGENTS.md`：MCP 连接池、stdio 传输、暴露与 `ToolSearch`、OAuth 与子 agent 的内联 server（T36，ADR-0053）。
- `src/tools/AGENTS.md`：工具层的易错点（Pi 的 Operations 绕过、替身路径、上传分段、行号、Bash 结果格式）。

## 多会话的易错点

- 不要调用 `process.chdir`，也不要读 `process.cwd()` 推断会话目录：Pi 按每个会话的 `cwd` 解析工具路径。
- 不要在会话代码里改 `process.env`：bash 工具的子进程继承它，所有会话共享。
- Pi 的默认会话目录、默认 `auth.json` 读进程级的 `getAgentDir()`，不看 SDK 的 `agentDir`（Pi 的 MCP 扩展也是，T36 起不再加载）。`main.ts` 把 `PI_CODING_AGENT_DIR` 固定为 `<data>/pi`，`SessionRegistry` 构造时校验；测试直接用注册表时也要先设它。
- `SettingsManager.create()` 默认 `projectTrusted: true`：注册表总是传 `false`，由信任钩子改成 Core 的回答。Pi 的 `project_trust` 扩展事件、`<agentDir>/trust.json` 与 `defaultProjectTrust` 只在 Pi 的 CLI 路径生效，SDK 路径不经过它们；不要调用 Pi 的 `resolveProjectTrusted`。
- `ModelRuntime` 是工作区共享的：扩展注册的 provider 对所有会话可见。
- 关闭会话要走 `AgentSessionRuntime.dispose()`：单独的 `session.dispose()` 不发 `session_shutdown`，会话占着的 MCP 租约不会交还，池不会空闲断开。
- 一个 MCP server 在工作区只有一份连接（T36 的池）：不要在会话或子会话里另起 MCP 客户端。
- 扩展加载器的模块级缓存按 cwd 失效，不同 cwd 的会话交替加载文件型扩展会互相清空它；Harness Kit 用内联工厂不受影响。
- Pi 丢弃被中断的 assistant 消息；中断后的对话靠 Harness Kit 补写的结果与中断标记保持角色交替（I18 已处理，ADR-0026）。预检期间中断时，Pi 可能在真实工具结果与补齐结果之间写一条 aborted 回复。模型上下文在 pi-ai 的配对转换之前先移除其本来就会丢弃的失败或中断回复，避免为同一调用发送两次结果。

## 回合、排队与投影（T14，ADR-0026）

- 一个被接受的输入是一个回合：`session/prompt`，或空闲时的 `session/steer`、`session/followUp`（回 `disposition: "started"`）。回合从首个 `agent_start` 到 `agent_settled`；`turn/completed` 带本回合各次回复的用量之和。
- steer 立即交给 Pi（`session.steer`），在当前步骤（本次回复的工具调用全部结束）之后、下一次请求之前进入上下文，属于当前回合；在 Pi 的最后一步之后才到的 steer，回合结束时转为表头的 follow-up。与 Pi 的差异：Pi 自己的 follow-up 在同一次运行里继续、不分回合，所以 follow-up 不交给 Pi，留在排队表里，回合完成后由注册表作为新回合启动。
- 排队表（`queue.ts`）是 id、类别、文本与顺序的唯一来源；任何变化都发 `session/queueChanged`（整张表）。编辑、删除、重排 steer 项会清空 Pi 的队列再按新顺序重新交给 Pi，期间忽略 `queue_update`，结束后按 `getSteeringMessages()` 对齐一次。`session/abort` 先清空排队表并在结果中交回（`returnedQueue`），中断之后不自动开始新回合。
- 投影器只认 `parentToolCallId` 为空的工具事件（工具嵌套调用的子调用不成条目）。条目 id：文本与 reasoning 为 `<messageId>#<contentIndex>`（`messageId` 由投影器生成，历史里是 Pi 的 entry id，两者不同），工具为工具调用 id（实时与历史相同），用户消息为 `<turnId>:user:<n>`（历史里是 entry id）。
- 记录事件的测试钩子在注册表里也记下 `beginTurn`、`markAborting`、`steer`、`followUp`、`takeFollowUp` 这些步骤，golden 测试按同样的顺序回放（`projector.golden.test.ts` 的 `replay` 与 `#onEvent` 保持一致）。

