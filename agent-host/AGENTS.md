# @piarc/agent-host

Agent Host：一个 Node 进程，用 Pi SDK 托管一个工作区的多个会话，经 stdin/stdout 上的 AHP 与 Core 通信（架构第 5 章、ADR-0002、ADR-0010）。工具的文件与命令 I/O 全部委托给 Core（ADR-0004、ADR-0020）。不负责权限裁决、hooks 执行、快照、沙箱、凭据持久化（都在 Core）；监管它的是 `crates/piarc-host`。

## 命令

| 命令 | 用途 |
|---|---|
| `npm run build:agent-host` | esbuild 打包到 `agent-host/dist/bundle/agent-host.mjs`，并写 `pi-assets/package.json`；`@piarc/protocol` 从源码打包，不依赖 `tsc` 产物 |
| `npx vitest run agent-host` | 单元测试：出站队列（含回放缓冲、单帧上限）、投影与 golden 测试（`projector.golden.test.ts` 打印覆盖矩阵）、排队表、工具批次、中断补齐、Core 桥接、工具层、凭据存储、信任接管 |
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

## System prompt 与 memory（T22，ADR-0033）

- `runtime/session-registry.ts` 给每个分支创建 `SessionMemory`，在 `before_agent_start` 挂载七段。英文提示词与默认工具指引在 `src/harness/prompts/`，修改后必须运行 `node scripts/dev/check-prompt-originality.mjs` 并更新 [原创性记录](../docs/engineering/prompt-originality.md)。
- `noContextFiles: true` 保留。Core 先加载用户文件，再从根到 cwd 逐级加载；`fs/memory` 返回标明来源的快照。成功的 Read、Write、Edit 和 Glob/Grep 的查询及命中目录触发子目录加载。每次回合从分支记录恢复开场 system，文件变化、子目录文件与跨日日期以 `memoryLazyLoad` 提醒送达（T27 起经 `reminders.ts`，版本摘要在提醒的 `details` 里；分支里旧的 `piarc.memory` 条目仍按原格式回放）。Anthropic 的分段缓存与消息块转换在 `memory-wire.ts`。
- 条件 rules（T24，ADR-0038）：Core 上次快照带 `inactiveRules` 时，Read、Write、Edit 成功后即使目录已访问过，也带上该文件（`files`）再请求一次快照；快照里带 `paths` 的文件是条件 rules，首次出现时以 `rulesMatched` 提醒送达并写入分支条目 `piarc.memoryRules`，之后每次请求都在 `rules` 中带上它们（每会话一次，恢复与分叉沿用分支）。

## 权限预检与历史

- `src/harness/policy.ts` 使用 Pi 1.5.2 的 `tool_call`。Pi 校验工具参数后调用处理器。处理器把规范工具名、会话、工具调用 id 和参数发给 Core，文件路径与工具执行使用同一套解析规则。只有结构正确的 `allowed: true` 放行。
- 参数超过 8 MiB 帧预算时，Host 用 `policy/inputChunk` 逐块送给 Core，再带 `stagedInputBytes` 裁决。Write 分块传原始 content，沿用文件工具的 UTF-16 分片边界，避免 JSON 转义缩小 64 MiB 的文件上限。Core 校验会话、连接、调用、工具、UTF-8 偏移与总长度，重组后的参数同时用于预览与裁决。
- Core 要询问时发送 `policy/pending`。过期通知让 Host 用 `policy/cancel` 撤下旧请求。拒绝反馈通过 Pi 的 `{block:true,reason}` 进入模型下一次请求，实时投影用 `markDeclined`，历史从 `piarc.toolDeclined` 条目恢复状态。
- `session/setPermissionMode` 写入所选分支的 `piarc.permissionMode` 条目，实时与历史都投影为 `permissionModeChanged`。会话打开结果的可选 `permissionMode` 传回该分支最后的显式选择，起始模式的配置优先级由 Core 解析。
- 每次运行前（`before_agent_start`）把当前工具的规范名经 `policy/tools` 交给 Core，Core 返回被不带 specifier 的 deny 规则覆盖的工具，`nextActiveTools` 用 `setActiveTools` 移除它们，规则撤销后恢复；请求失败时保持原列表（每次调用仍经 `policy/evaluate`，ADR-0037）。
- Host 重连恢复时，最后一个模型回复中尚无结果的调用经 `policy/recover` 查询审批失效原因。只给失效调用写入拒绝结果，其余缺失结果按 ADR-0026 补齐。`cargo test -p piarc-testkit --test sessions permissions::` 覆盖真实进程终止、恢复后的模型请求、审批快照与模式历史。

## Hooks（T25，ADR-0039）

- `harness/hooks.ts` 的 `SessionHooks`（Core 启用 `hooks` 能力时每会话一个，排在结果预算之后）把 Pi 的 `session_start`、`session_shutdown`、`tool_result`、`agent_before_settle` 经 `hooks/run` 交给 Core（不在本进程执行命令，失败照常进行）；PreCompact、PostCompact 由 `compaction.ts` 调 `preCompact`、`postCompact`。hook 加的上下文（`additionalContext`、纯文本 stdout）是 `hookContext` 提醒（T27，正文 "Context from a <事件> hook:"），PostToolUse 的替换输出与 `decision: block` 的反馈仍在工具结果里（反馈首行 `[PiArc hook context]`）；Stop 的续跑理由以同格式的 `piarc.reminder` 草稿条目送达。SessionStart 不阻塞会话打开，首个 `before_agent_start` 等它。
- `preflight` 的 `updatedInput` 原地替换 `event.input`，`context`、`stop` 记在 `SessionHooks.notes` 到 `tool_result` 处理；Core 在 hooks 前发 `policy/pending` 停住期限，不要去掉 `policy/evaluate` 的期限。`hooks/run` 无期限，超帧输入由 `fitFrame` 截断（否则 Core 丢帧、回合永远等）。PreCompact 的指令并入 PiArc 自己的摘要请求（`compaction.ts`）。

## 宿主工具（T26，ADR-0042）

- `harness/session-harness.ts` 按 Core 启用的能力（`planMode`、`todo`、`ask`）注册 `EnterPlanMode`、`ExitPlanMode`（`plan-mode.ts`）、`TodoWrite`（`todos.ts`）、`AskUserQuestion`（`questions.ts`，经 `ui/ask`）与 `SuggestNextSteps`（`next-steps.ts`），排在 Core 工具之后；描述在 `tools/profile.ts`，工具指引与提醒文案在 `harness/prompts/`（改后跑原创性检查）。
- 模式切换只走 `PlanMode.record`：模式菜单（`session/setPermissionMode`）与 `policy/evaluate` 结果的 `mode`（EnterPlanMode、批准的计划，在调用执行前）都写 `piarc.permissionMode` 并投影；进出 plan 时排队 `mode` 提醒，模型自己调用的工具结果就是告知（`acknowledge` 撤回提醒）。
- `reminders.ts` 是提醒的唯一通道：`piarc.reminder` 自定义消息在 `before_agent_start` 与带工具结果的 `turn_end` 送达（`memory-wire.ts` 在 Anthropic 线格式上合并），T27 的扩展见下节。任务清单提醒的阈值 `TODO_REMINDER_ROUNDS` = 8（`todos.ts`），从最后一次成功的 TodoWrite 或上一条 `todo` 提醒按分支计数。
- 注入接口：`currentPlan(entries)`、`currentTodos(entries, canonical)`；`session/history` 结果的 `harness` 由它们计算，`harness/todo` 在 TodoWrite 的 `item/completed` 之后发出。

## 上下文工程（T27，ADR-0043）

- **提醒**：`reminders.ts` 的 `Reminders.enqueue(key, { type, source, text, category?, data? })`。类型与入口：`todoStale`（`todos.ts`，键 `todo`）、`planMode`（`plan-mode.ts`，键 `mode`）、`fileModified`（`file-changes.ts`，键 `file:<路径>`）、`backgroundTask`（AHP `session/remind`，`SessionHarness.remind`）、`memoryLazyLoad`/`rulesMatched`（`session-memory.ts`，键 `memory:<路径>`）、`hookContext`（`hooks.ts`，键 `hook:<事件>:<n>`）、`contextRestore`（`compaction.ts` 压缩后直接追加）。`category`（`memory`、`skills`、`conversation`）决定用量归类；新增来源加一种入口，不另写消息类型。`addCollector` 注册送达前运行的收集器（`fs/changes`：分支上有成功的 Read、Write、Edit 才问 Core）。提醒投影为 `reminder` 条目（能力 `context`，实时在 `message_end`，直接追加的经 `Projector.reminder`，历史在 `history.ts`）。
- **压缩**：`compaction-threshold.ts` 是阈值纯函数（T = W − min(O, 20K) − 13K，W = min(模型窗口, `autoCompactWindow`)，`contextWindowOverride` 留给 T29）；`SessionCompaction.apply()` 把 `compaction.reserveTokens = 模型窗口 − T + 1`、`compaction.enabled` 与 `retry.provider.maxRetries = 0` 施加到会话设置。Pi 的 `SettingsManager.reload()`（创建会话时资源加载就会调）清掉内存覆盖值，所以每次运行开始（注册表 `#run` 的 `compaction.prepare()`，先经 `context/settings` 取设置）与切换模型后重新施加；不要在 `SettingsManager.create` 之后、会话创建之前 `applyOverrides`。
- **摘要**：`session_before_compact` 里自己发请求（`prompts/compaction.ts`，改文案后跑原创性检查）。失败时返回 `{ cancel: true }` 并记下原因（Pi 1.5.2 吞掉处理器异常、改用它自己的提示），压缩条目与 `/compact` 回合以该原因失败（`lastFailure`）。摘要请求不经 `before_provider_request`，不带缓存。
- **重注入**：`reinjection.ts` 的 `RESTORE_LIMITS` 是全部上限；skill 正文读分支条目 `piarc.skillInvoked`（`{ name, content }`，T37 写入，`invokedSkills`），最近文件读分支上 Read、Write、Edit 的 `path`（`recentFiles`），内容经 `CoreIo.restoreText`（`fs/read` 的 `restore`）。重注入消息在 `session_compact` 中直接 `appendCustomMessageEntry`：Pi 每次请求都从会话投影重建消息，所以紧接着的请求就带上它（含两步之间的自动压缩）。
- **熔断**：`SessionCompaction.ended()` 在注册表 `#onEvent` 中先于投影器处理 `compaction_end`（`harness.observe`），压缩条目由此带上失败原因、压缩后估算与 `autoCompactStopped`；上限 `AUTO_COMPACT_FAILURE_LIMIT` = 3，状态在内存中（手动压缩成功、新进程复位）。
- **用量**：`context-usage.ts` 在 `context_with_system` 估算（Pi 在这之后才把 system 换成冻结的 `forceSystemPrompt`，所以 system 文本取 `SessionMemory.systemText`，工具取 `getCurrentTools`），回复的 `message_end` 以服务商报告为合计；估算函数只用 `tokens.ts`。`session/usage` 只在 Core 启用 `context` 时发。

## 分支与回退（T28，ADR-0044）

- `runtime/branches.ts` 是分支的唯一实现：回合起点（每个回合第一条 `piarc.input` 的 `from`，旧记录取父条目）、分支点（起点落在同一锚点的回合互为分支，跳过记录、模式与模型变化、system 装载消息与分支摘要）、`rewindToTurn`（leaf 移到起点并追加 `piarc.branch`）、`summarizeFromTurn`（`compaction.ts` 的 `summarizeBranch` 用 T27 的摘要提示，再经 Pi 的 `branchWithSummary`）、`switchTo`、`forkedManager`（`session/fork` 的 `beforeTurn`）。Pi 打开文件时 leaf 在最后一条 entry，所以追加的条目就是持久化的位置；不删除任何 entry。
- 回退与切换之后注册表在同一 id 下关闭并重新打开 Pi 运行时（`#reopen`，source `branch`：不触发 SessionStart/SessionEnd hooks，`seq` 连续），计划、模式、memory、读写记录随分支重新推导；MCP 随之重连。历史窗口与 `session/branches` 通知带分支点（`history.ts`），`branch_summary` 投影为原因 `rewind` 的压缩条目。
- 中断补齐（`harness/interruption.ts`）只把 user、toolResult 或有回复的 assistant 当作末尾：以分支摘要或提醒结尾的对话不是被中断的回合。摘要之后的第一条输入紧跟摘要（两条相邻的 user 消息），`rewind-summarize` 场景因此关闭 `role_order` 检查。

## WebFetch、辅助模型、偏好、Profile 与登录（T29，ADR-0045）

- WebFetch（`harness/web-fetch.ts`，Core 启用 `webFetch` 时由 `SessionHarness.tools()` 注册）：`CoreIo.webFetch` 请 Core 抓取（不在本进程联网，SSRF 与授权绑定在 Core），再经 `harness/auxiliary.ts` 的 `AuxiliaryModel.complete` 按 `prompt` 提取；跨站重定向直接把目标地址作为结果，不调模型。提取提示在 `harness/prompts/web-fetch.ts`（改后跑原创性检查）。辅助调用的用量经 `Projector.auxiliaryUsage` 计入当前回合并写 `piarc.auxiliaryUsage`；其他一次性模型调用也走它，不另建请求。
- 模型偏好（`providers/preferences.ts` 的 `ModelPreferencesStore`，挂在 `Workspace.preferences`）：来自 `core/welcome.modelPreferences` 与 `models/reload.preferences`（`SessionRegistry.setPreferences`）。`models/list` 经 `preferences.apply`；窗口经 `SessionCompaction` 的 `contextWindow`（`contextWindowOverride`）；图片经 `checkImageInput` 与 `installProviderPolicy` 的 `vision`；默认 effort 在 `selectModel` 未指定档位时。
- Tool Profile：`#open` 按会话的模型（指定的，或 `buildSessionContext().model`）选 `DEFAULT`/`conservativeProfile`，保守时 `onlyConservative` 只留 `CONSERVATIVE_TOOLS`，`todoWatch` 用 3 轮且无清单也提醒；实际模型与预测不同就立即重开。`setModel` 或 `setPreferences` 改变 Profile 时空闲会话 `#reopen`，运行中的标 `profileStale`、回合结束后重开。不要在运行中改工具描述（Pi 注册时复制描述）。
- 登录（`providers/login.ts` 的 `Logins`，设置 Host 上）：`models/login/start` 调 `ModelRuntime.login(provider, 'oauth', interaction)`，`notify`/`prompt` 转 `ui/loginInteraction`（无期限，取消经 `AbortSignal`），提问的空答复即取消；`models/logout`。`loginProviders` 列出带 `auth.oauth` 的服务商（Anthropic 的已被 policy 移除）。OAuth 流程模块经 `registerLazyOAuthFlows` 打进 bundle。`--test-oauth-provider` 的 `flow` 可选 `authorizationCode`（本地回环回调）与 `deviceCode`（轮询），对接 `piarc-testkit` 的 mock 授权服务器。

## 多会话的易错点

- 不要调用 `process.chdir`，也不要读 `process.cwd()` 推断会话目录：Pi 按每个会话的 `cwd` 解析工具路径。
- 不要在会话代码里改 `process.env`：bash 工具的子进程继承它，所有会话共享。
- Pi 的 MCP 扩展、默认会话目录、默认 `auth.json` 读进程级的 `getAgentDir()`，不看 SDK 的 `agentDir`。`main.ts` 把 `PI_CODING_AGENT_DIR` 固定为 `<data>/pi`，`SessionRegistry` 构造时校验；测试直接用注册表时也要先设它。
- `SettingsManager.create()` 默认 `projectTrusted: true`：注册表总是传 `false`，由信任钩子改成 Core 的回答。Pi 的 `project_trust` 扩展事件、`<agentDir>/trust.json` 与 `defaultProjectTrust` 只在 Pi 的 CLI 路径生效，SDK 路径不经过它们；不要调用 Pi 的 `resolveProjectTrusted`。
- `ModelRuntime` 是工作区共享的：扩展注册的 provider 对所有会话可见。
- 关闭会话要走 `AgentSessionRuntime.dispose()`：单独的 `session.dispose()` 不发 `session_shutdown`，MCP 不会断开。
- MCP 扩展按会话实例化：同一个 server 被两个会话配置时会起两份进程（共享池是 T36）。
- 扩展加载器的模块级缓存按 cwd 失效，不同 cwd 的会话交替加载文件型扩展会互相清空它；Harness Kit 用内联工厂不受影响。
- Pi 丢弃被中断的 assistant 消息；中断后的对话靠 Harness Kit 补写的结果与中断标记保持角色交替（I18 已处理，ADR-0026）。预检期间中断时，Pi 可能在真实工具结果与补齐结果之间写一条 aborted 回复。模型上下文在 pi-ai 的配对转换之前先移除其本来就会丢弃的失败或中断回复，避免为同一调用发送两次结果。

## 回合、排队与投影（T14，ADR-0026）

- 一个被接受的输入是一个回合：`session/prompt`，或空闲时的 `session/steer`、`session/followUp`（回 `disposition: "started"`）。回合从首个 `agent_start` 到 `agent_settled`；`turn/completed` 带本回合各次回复的用量之和。
- steer 立即交给 Pi（`session.steer`），在当前步骤（本次回复的工具调用全部结束）之后、下一次请求之前进入上下文，属于当前回合；在 Pi 的最后一步之后才到的 steer，回合结束时转为表头的 follow-up。与 Pi 的差异：Pi 自己的 follow-up 在同一次运行里继续、不分回合，所以 follow-up 不交给 Pi，留在排队表里，回合完成后由注册表作为新回合启动。
- 排队表（`queue.ts`）是 id、类别、文本与顺序的唯一来源；任何变化都发 `session/queueChanged`（整张表）。编辑、删除、重排 steer 项会清空 Pi 的队列再按新顺序重新交给 Pi，期间忽略 `queue_update`，结束后按 `getSteeringMessages()` 对齐一次。`session/abort` 先清空排队表并在结果中交回（`returnedQueue`），中断之后不自动开始新回合。
- 投影器只认 `parentToolCallId` 为空的工具事件（工具嵌套调用的子调用不成条目）。条目 id：文本与 reasoning 为 `<messageId>#<contentIndex>`（`messageId` 由投影器生成，历史里是 Pi 的 entry id，两者不同），工具为工具调用 id（实时与历史相同），用户消息为 `<turnId>:user:<n>`（历史里是 entry id）。
- 记录事件的测试钩子在注册表里也记下 `beginTurn`、`markAborting`、`steer`、`followUp`、`takeFollowUp` 这些步骤，golden 测试按同样的顺序回放（`projector.golden.test.ts` 的 `replay` 与 `#onEvent` 保持一致）。

## 回合不变量：Pi 已满足 / Harness Kit 补齐（架构第 6.15 节）

| 不变量 | Pi 1.5.2 已满足 | Harness Kit 补齐 |
|---|---|---|
| 回合继续条件 | 回复里有工具调用才继续；`length` 截断时整条回复的调用判为失败、不执行 | — |
| 工具并发 | 并行模式同时启动一条回复的全部调用（无上限）；有一个 `sequential` 工具时全部串行 | `tool-batches.ts`：所有工具保持并行模式，执行被调度器按批放行：连续的 Read、Glob、Grep 每批至多 10 个，其余调用单独成批，前面的批次全部结束才放行下一批；Pi 不经执行就回答的调用按 `tool_execution_end` 计为结束。包住自定义工具（注册表的 `scheduled`）与所有扩展工具（`extensionsOverride` 替换扩展的 `tools` 映射，之后注册的 MCP 工具也被包住） |
| 中断补齐 | 已开始执行的调用收到 abort 信号后得到错误结果；没开始执行的得到 "Operation aborted"；还没准备的调用没有结果，pi-ai 只在请求里临时补 "No result provided"；被中断的回复写进文件但不进上下文 | `interruption.ts`：`agent_settled` 的 `aborted` 为真时，为没有结果的调用补写 "Interrupted by the user before this tool call finished."，对话不以回复结尾时追加中断标记（会话当前模型、零用量、`rawStopReason: piarc-interrupted`）；会话重新打开时对崩溃留下的未完成回合做同样处理。投影把这些调用的条目标为 `interrupted` |
| 重试 | agent 循环对限流、过载、5xx 重试，发 `auto_retry_*`，失败的那次不进上下文 | 每个会话的设置施加 `retry.provider.maxRetries = 0`（内存覆盖），让服务商 SDK 不静默重试，重试都经 `turn/retrying` 报给界面。T27 起由 `SessionCompaction.apply()` 在每次运行前施加：T14 在 `SettingsManager.create` 之后施加的值会被创建会话时资源加载的 `reload()` 清掉 |

- steer 消息按 Pi 的做法紧跟工具结果，形成相邻的 user 消息（Anthropic API 合并，严格 mock 的 `role_order` 不接受）：steer 场景关闭 `role_order`，其余场景（包括中断之后的请求）全部规则开启。
- 失败（非中断）结束的回合不补中断标记：下一条输入同样会紧跟上一条 user 消息（I67，T27 决定保持：失败的请求没有 assistant 内容，两家线格式都接受相邻的 user 消息，ADR-0043 第 11 条）。

## 模型与服务商（T21）

- `models/list` 以 Pi 1.5.2 的 `ModelRuntime.getAvailable()` 为准，只列出已配置的聊天模型。另返回支持 API key 方式的内置服务商，供设置页使用。从 `pi/models.json` 接入兼容服务时，`api` 明确区分 `anthropic-messages`、`openai-completions` 和 `openai-responses`，`models[].id` 是用户给出的部署 ID。目录联网指 Pi 自己的目录刷新；自定义端点的模型列表只从配置读取。
- `providers/catalog.ts` 先从 Pi 读取上下文、最大输出、视觉、推理档位和缓存元数据。适配器明确标记支持严格工具参数编码时，工具可靠性记作 `verified`（指工具参数可按 schema 约束），其他模型记作 `unknown`。最后按完整的服务商 ID / 模型 ID 合并 PiArc 覆盖表。百炼团队版 `qwen-token-plan-cn/qwen3.6-plus` 的 Pi 目录缺少缓存信息，而百炼用量记录明确包含其缓存 Token，因此覆盖为支持缓存。百炼四个内置 Token Plan 的额度以 Credits 计，切换预览里的 USD 金额显示未知。[阿里云 Token Plan 用量与额度](https://help.aliyun.com/zh/model-studio/token-plan-usage-quota)
- 可选 effort 取 Pi 的 `getSupportedThinkingLevels`，过滤 `minimal`，保留 `off/low/medium/high/xhigh/max` 原值。Host 在调用 `setThinkingLevel` 前核实该档位。切换仅可在空闲时确认；`setModel` 和 `setThinkingLevel` 把会话选择写入 Pi 会话树。预览使用 Pi 的上下文估算及目标档位价格，检查已有 thinking 块的 provider、api、id。自定义模型未提供的缓存写价在 Pi 会变成默认零，Host 单独记录这些模型以显示未知。
- 设置专用 Host 的 `models/credential` 通过 `ModelRuntime.login/logout` 和 Core 保险箱适配层写入。认证信息的 `env` 是单次 SDK 请求的参数。自定义密钥绑定 base URL 和 API；在 SDK 每次解析认证后核对实际目标，不匹配则拒绝发送。空 key 的兼容端点可使用 Core 生成的非秘密固定值。Bedrock 支持 bearer/region 和 profile，Vertex 支持 API key 或带项目、位置的本机 ADC / 服务账号文件。
- `providers/policy.ts` 在首次刷新之前移除 Anthropic 的 OAuth 方式。直接调用返回 `permissionDenied`，`sk-ant-oat` 格式及 Anthropic 的环境 token 也在请求认证时拒绝。流错误内回显的请求密钥在 Pi 持久化前脱敏。该路径的 CI 在 `providers/policy.test.ts`，包含 “removes Anthropic OAuth and rejects direct login” 及实际 SDK 流测试。
- `core/welcome.allowModelNetwork` 给出启动的刷新策略。关闭时只读 Pi 自带目录和同一 agentDir 的 `models-store.json`；`models/reload` 先对齐保险箱快照，再重载模型配置，显式启用网络时由 Pi 的缓存时效策略决定是否请求。设置 Host 与测试夹具可全程离线。

## 凭据适配层

- 启动：`load()` 调 `secrets/getAll`；失败只记日志，之后每个需要凭据的操作重试一次，仍失败就以 Core 的结构化错误拒绝，pi-ai 让该次模型请求失败（会话报错）。不要在失败时回退到 `InMemoryCredentialStore` 或环境变量。
- 读：`read`、`list` 从内存返回，不访问 Core。
- 写：`modify`、`delete` 按 provider 串行，在 Core 的连接级锁（`secrets/lock`，锁 `provider/<id>` 与 `oauth/<id>`）内运行，持锁期间用 `secrets/renew` 续约：用锁结果更新内存 → `fn` → 先改内存 → `secrets/set`/`secrets/delete` → `secrets/unlock`。`modify` 等 Core 存好才完成；写回失败时拒绝，但新值留在内存（轮换后的 refresh token 只在那里）。
- 缓存更新：Core 把每次写入推给所有调用过 `secrets/getAll` 的 Agent Host（`secrets/changed`）；`applyChange` 只接受比已知更大的 `revision`。Core 先订阅、再在同一把保险箱锁下读取条目和快照 revision；新快照会剔除已经删除的凭据、丢弃快照之前的迟到通知，并保留期间收到的更高 revision。别的 Agent Host 刷新过的 token 在下一次加锁时一定能看到（锁结果带当前值），不依赖推送先到。
- 键：API key 在 `provider/<id>`，OAuth 在 `oauth/<id>`，写一个就删另一个；`mcp/*` 不进 Pi 的凭据视图。
- 退出前 `flush()` 等待进行中的写入（`host.ts` 的 `shutdown` 与 `host/shutdown`）。

## 工具层的易错点

- Pi 1.5.2 的 read 在 Operations 之外 `access` 路径、write 与 edit 对路径 `realpath`、grep 自己跑 ripgrep（S4 第 2 节）。升级 Pi 后先跑端到端测试：I/O spy（场景期间对工作区路径零 `fs`、零 `child_process`）与行为对照会发现新的绕过与行为变化。
- Pi 的 `withFileMutationQueue` 按替身排队，不起串行作用；Write、Edit 用 `stand-in.ts` 的 `serialized`。
- 工具 I/O 与会话通知走同一个 stdout：Core 停止读取（事件消费者停住）时工具也等着，这是背压，不是死锁（I19）。
- Windows 上 Node 写管道式 stdout 是同步的（`net.Socket` 对 fd 1、2 的管道 `setBlocking(true)`）：管道满时写入本身阻塞，整个事件循环停住，`OutboundQueue` 几乎不排队，也不会出现 `drain` 等待；Core 恢复读取后一切照常（S9 报告第 5 节）。
- 文本超过 256 Ki 个 UTF-16 码元时以一次上传分段发送（`fs/write`、`fs/spill` 的 `upload`，最后一段到达 Core 才写），不能在代理对中间切；不要再用 `append` 分段（第一段就会截断原文件）。读取按 Core 返回的 `bytesRead` 续读。
- Read 的行号是 Pi 选行之前对文本流的变换（`numberedChunks`），所以 Pi 的截断字节数包含前缀；改行号格式要同步 Profile 的描述、`parity.rs` 的 `comparable` 与 L2 断言。Edit 的 `oldText` 不含行号前缀，Profile 的描述写明了这一点。
- Read 用 `fs/stat(read)` 查询重复并暂存快照，内容送达且文档解析成功后，同一调用以相同范围发送 `completeRead: true` 确认。取消、失败或文件变化不会放行 Edit（ADR-0034）。
- Edit 与 Write 把 Core 返回的 diff 放进结果的 `details.fileDiff`，投影器从这里取（`items.ts` 的 `resultDiff`）；改结果形状时两边一起改。
- 参数 schema 在 Pi 的之上扩展（Read 的 `pages`、Edit 的 `replaceAll`）用 `typebox`（与 Pi 同版本 1.3.27 的直接依赖）。
- Bash 不读 Pi 设置的 `shellPath`、`shellCommandPrefix`（Windows 的 Git Bash 路径是 PiArc 设置 `shell.gitBashPath`），Read 按会话 `SettingsManager.getImageAutoResize()` 读取 `images.autoResize`（I21）；命令环境是 Core 的登录 shell 环境去掉内部变量，Agent Host 不再传 Pi 的 `PI_*` 会话变量。
- Bash 的结果文本在与 Pi 含义相同处用 Pi 的措辞（"Command exited with code N" 等，`parity.rs` 的 Bash 步骤与 L2 断言依赖）；输出保留原样的末尾换行。改措辞时同步对照测试与 `tests/scenarios/exec-*.yaml`。
- 命令的 `details.commandExecution` 由 `shell.ts` 写、`items.ts` 的 `resultExecution` 校验后放进条目的 `execution`（实时与历史都经它）；改形状时两边与协议类型一起改。

相关基线见架构第 5、7 章、ADR-0002、0009、0010、0015、0020、Pi 调研的 v1.5.2 差异，以及 S03、S04、S09 报告。
