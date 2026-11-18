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

## 入口与结构

- `src/main.ts`：进程入口。解析 `--data-dir`、`--bridge-timeout-ms`；设置 `PI_CODING_AGENT_DIR`；接管 stdout（第三方的 `console.log` 改写到 stderr）；SIGTERM/SIGINT 有序退出，第二个信号立即退出。
- `src/host.ts`：与进程无关的主体：握手（`host/hello` → `core/welcome`）、请求分派、`host/shutdown`、stdin 关闭即退出。退出码见 `EXIT`（3 = 协议主版本不符，70 = 出站积压超限）。
- `src/runtime/`：会话注册表（`session-registry.ts`：回合、steer 与 follow-up、fork、history、并发 resume 合并）、投影（`projector.ts` 实时、`history.ts` 会话文件，共用 `items.ts` 的条目构造；规则表在 `projector.ts` 文件头，与架构第 5.3 节一致）、排队表（`queue.ts`）、blob 读取（只接受数据目录 `sessions/` 下的路径）。
- `src/harness/tool-batches.ts`、`src/harness/interruption.ts`：回合不变量的 Harness Kit 部分（工具批次、中断补齐），见下文"回合不变量"。
- `test/golden/`：投影 golden 测试的输入（录制或构造的 Pi 事件，`*.events.json`）与期望输出（`*.expected.json`）；Prettier 不处理这个目录。
- `src/runtime/core-bridge.ts`：向 Core 发请求的唯一入口（统一超时，默认 30 s；`timeoutMs: null` 给等待用户的请求，靠 `signal` 取消）。
- `src/protocol/outbound.ts`：写 stdout 的唯一路径：等 `drain`、合并增量、`item/updated` 只保留最新、写出时分配 `seq`；每个会话保留最近 4,096 条或 8 MiB 已写出的通知供 `session/getEntries` 回放；超过 8 MiB 单帧上限的会话通知不写出、不占 `seq`。
- `src/tools/`：工具层（架构第 6.1 节、ADR-0020、ADR-0027）。`profile.ts` 规范名、默认 Profile（描述原创，ADR-0006）与 `ToolNameMap`；`core-io.ts` 经 Core 桥接发 `fs/*`、`exec/*`（结果在此校验，错误重建为 Node 风格；写给模型的 Core 错误去掉 `<method> failed:` 前缀）；`read.ts`、`write.ts`、`edit.ts` 在替身路径（`stand-in.ts`）上运行 Pi 的工具定义（T16 的扩展：`line-numbers.ts` 行号、`documents.ts` PDF 与 notebook、`replace-all.ts`）；`glob.ts` 用 Pi 工厂加 Operations；`grep.ts` 自写；`shell.ts` 自写 Bash 与 PowerShell（T17，ADR-0028：Core 的 `exec/run` 管超时、进程树、cwd、输出预算与语义，工具只组织文本与 `details.commandExecution`），会话的工具集按 `exec/shells`（`session-registry.ts` 的 `shellsFor`）；`ls.ts` 只提供 `LsOperations`，不暴露。
- `src/harness/tool-results.ts`（T16）：工具结果预算，作为内联扩展挂在每个会话上（`tool_result` 单个 50K 落盘、`context` 单条消息 200K），阈值只改 `TOOL_RESULT_LIMITS` 或注册表选项 `toolResultLimits`。
- `src/harness/project-trust.ts`：Harness Kit 接管 Pi 的项目信任（T13）。`askCoreTrust` 发 `trust/get`，超时、错误响应、结果无法解析、连接已断都按不信任；`takeOverProjectTrust` 给 `createAgentSessionServices` 的 `resourceLoaderReloadOptions.resolveProjectTrust`，会话的 `SettingsManager` 一律以 `projectTrusted: false` 创建，项目级资源（`.pi/extensions/`、`.pi/settings.json`、`.pi/mcp.json` 等）在钩子拿到 Core 的回答后才加载。
- `src/runtime/credentials.ts`：`CoreCredentialStore`，pi-ai 的 `CredentialStore`，经 `secrets/*` 由 Core 的保险箱支撑（ADR-0021）；`host.ts` 在握手后 `load()`，再交给 `ModelRuntime.create({ credentials })`。

## 打包的外部依赖

| 包 | 原因 |
|---|---|
| `@silvia-odwyer/photon-node` | 从自己的包目录加载 `photon_rs_bg.wasm`（图片缩放） |
| `bufferutil`、`utf-8-validate`、`kerberos`、`supports-color` | 可选原生加速或输出着色，导入失败时调用方自行降级 |

其余全部内联（含 jiti）；`scripts/dev/build-agent-host.mjs` 发现其他外部导入就失败。尚未打包：codemode worker、图片缩放 worker、pi-ai 的 OAuth 与 Bedrock 懒加载模块（用到这些功能的任务负责补上，参考 Pi 自己的 `scripts/build-coding-agent-bundle.mjs`）。

## 不变量

- stdout 只写 AHP 帧，且只经 `OutboundQueue`。日志写 stderr，会话相关的行以 `[session <id>] ` 开头（Core 据此打会话标签）。
- 发往 Core 的字符串必须是合法 UTF-16（Rust 端拒绝孤立代理项）：增量走投影器的代理项处理，其他字符串用 `toWellFormed()`。
- `session/prompt` 先回复再开始回合（`setImmediate`），Core 总是先拿到 `turnId`。`requestId` 是幂等键。
- 只从 `@earendil-works/*` 的包入口或 `exports` 声明的子路径导入（ESLint 检查）；Pi 的 API 以锁定版本的类型声明为准。
- 凭据只来自 Core 的保险箱（`CoreCredentialStore`），`pi/` 下不写 `auth.json`；不从环境变量读凭据，也不把凭据放进 `process.env`。日志与错误只写键名（`provider/<id>`），不写值。
- `src/tools/`、`src/harness/` 不导入 `fs`、`fs/promises`、`child_process`（ESLint，含动态导入与 `require`）：文件与命令只经 `CoreIo`。新工具的 I/O 加在 `CoreIo` 上，不在工具里绕开。
- 模型可见名只出现在发给模型的工具定义里；投影的 `item/*`、发往 Core 的 `origin.tool`、规则与 hooks 都用规范名（`ToolNameMap`）。Profile 不能用 Pi 原生工具名（会话把它们排除了）。
- Read、Write、Edit 交给 Pi 的 `path` 是替身：结果与错误里的替身必须换回模型写的路径（`StandIn.restore`/`restoreError`）；Pi 新增对传入路径的 Operation 时，`StandIn.resolve` 抛出"unexpected path"。

## 多会话的易错点

- 不要调用 `process.chdir`，也不要读 `process.cwd()` 推断会话目录：Pi 按每个会话的 `cwd` 解析工具路径。
- 不要在会话代码里改 `process.env`：bash 工具的子进程继承它，所有会话共享。
- Pi 的 MCP 扩展、默认会话目录、默认 `auth.json` 读进程级的 `getAgentDir()`，不看 SDK 的 `agentDir`。`main.ts` 把 `PI_CODING_AGENT_DIR` 固定为 `<data>/pi`，`SessionRegistry` 构造时校验；测试直接用注册表时也要先设它。
- `SettingsManager.create()` 默认 `projectTrusted: true`：注册表总是传 `false`，由信任钩子改成 Core 的回答。Pi 的 `project_trust` 扩展事件、`<agentDir>/trust.json` 与 `defaultProjectTrust` 只在 Pi 的 CLI 路径生效，SDK 路径不经过它们；不要调用 Pi 的 `resolveProjectTrusted`。
- `ModelRuntime` 是工作区共享的：扩展注册的 provider 对所有会话可见。
- 关闭会话要走 `AgentSessionRuntime.dispose()`：单独的 `session.dispose()` 不发 `session_shutdown`，MCP 不会断开。
- MCP 扩展按会话实例化：同一个 server 被两个会话配置时会起两份进程（共享池是 T36）。
- 扩展加载器的模块级缓存按 cwd 失效，不同 cwd 的会话交替加载文件型扩展会互相清空它；Harness Kit 用内联工厂不受影响。
- Pi 丢弃被中断的 assistant 消息；中断后的对话靠 Harness Kit 补写的结果与中断标记保持角色交替（I18 已处理，ADR-0026）。不要在别处再补一份。

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
| 重试 | agent 循环对限流、过载、5xx 重试，发 `auto_retry_*`，失败的那次不进上下文 | 每个会话的设置施加 `retry.provider.maxRetries = 0`（内存覆盖），让服务商 SDK 不静默重试，重试都经 `turn/retrying` 报给界面 |

- steer 消息按 Pi 的做法紧跟工具结果，形成相邻的 user 消息（Anthropic API 合并，严格 mock 的 `role_order` 不接受）：steer 场景关闭 `role_order`，其余场景（包括中断之后的请求）全部规则开启。
- 失败（非中断）结束的回合不补中断标记：下一条输入同样会紧跟上一条 user 消息（`docs/plan/PLAN.md` I67）。

## 凭据适配层

- 启动：`load()` 调 `secrets/getAll`；失败只记日志，之后每个需要凭据的操作重试一次，仍失败就以 Core 的结构化错误拒绝，pi-ai 让该次模型请求失败（会话报错）。不要在失败时回退到 `InMemoryCredentialStore` 或环境变量。
- 读：`read`、`list` 从内存返回，不访问 Core。
- 写：`modify`、`delete` 按 provider 串行，在 Core 的锁（`secrets/lock`，锁 `provider/<id>` 与 `oauth/<id>`）内运行：用锁结果更新内存 → `fn` → 先改内存 → `secrets/set`/`secrets/delete` → `secrets/unlock`。`modify` 等 Core 存好才完成；写回失败时拒绝，但新值留在内存（轮换后的 refresh token 只在那里）。
- 缓存更新：Core 把每次写入推给所有调用过 `secrets/getAll` 的 Agent Host（`secrets/changed`）；`applyChange` 只接受比已知更大的 `revision`。别的 Agent Host 刷新过的 token 在下一次加锁时一定能看到（锁结果带当前值），不依赖推送先到。
- 键：API key 在 `provider/<id>`，OAuth 在 `oauth/<id>`，写一个就删另一个；`mcp/*` 不进 Pi 的凭据视图。
- 退出前 `flush()` 等待进行中的写入（`host.ts` 的 `shutdown` 与 `host/shutdown`）。

## 工具层的易错点

- Pi 1.5.2 的 read 在 Operations 之外 `access` 路径、write 与 edit 对路径 `realpath`、grep 自己跑 ripgrep（S4 第 2 节）。升级 Pi 后先跑端到端测试：I/O spy（场景期间对工作区路径零 `fs`、零 `child_process`）与行为对照会发现新的绕过与行为变化。
- Pi 的 `withFileMutationQueue` 按替身排队，不起串行作用；Write、Edit 用 `stand-in.ts` 的 `serialized`。
- 工具 I/O 与会话通知走同一个 stdout：Core 停止读取（事件消费者停住）时工具也等着，这是背压，不是死锁（I19）。
- Windows 上 Node 写管道式 stdout 是同步的（`net.Socket` 对 fd 1、2 的管道 `setBlocking(true)`）：管道满时写入本身阻塞，整个事件循环停住，`OutboundQueue` 几乎不排队，也不会出现 `drain` 等待；Core 恢复读取后一切照常（S9 报告第 5 节）。
- 文本超过 256 Ki 个 UTF-16 码元时以一次上传分段发送（`fs/write`、`fs/spill` 的 `upload`，最后一段到达 Core 才写），不能在代理对中间切；不要再用 `append` 分段（第一段就会截断原文件）。读取按 Core 返回的 `bytesRead` 续读。
- Read 的行号是 Pi 选行之前对文本流的变换（`numberedChunks`），所以 Pi 的截断字节数包含前缀；改行号格式要同步 Profile 的描述、`parity.rs` 的 `comparable` 与 L2 断言。Edit 的 `oldText` 不含行号前缀，Profile 的描述写明了这一点。
- Read 的查找经 `fs/stat` 的 `read` 登记读取，Core 据此判断重复读取与 Edit 的先读后改；不要为别的用途带 `read` 调 `fs/stat`。
- Edit 与 Write 把 Core 返回的 diff 放进结果的 `details.fileDiff`，投影器从这里取（`items.ts` 的 `resultDiff`）；改结果形状时两边一起改。
- 参数 schema 在 Pi 的之上扩展（Read 的 `pages`、Edit 的 `replaceAll`）用 `typebox`（与 Pi 同版本 1.3.27 的直接依赖）。
- Bash 不读 Pi 设置的 `shellPath`、`shellCommandPrefix`（Windows 的 Git Bash 路径是 PiArc 设置 `shell.gitBashPath`），Read 不读 `images.autoResize`（I21）；命令环境是 Core 的登录 shell 环境去掉内部变量，Agent Host 不再传 Pi 的 `PI_*` 会话变量。
- Bash 的结果文本在与 Pi 含义相同处用 Pi 的措辞（"Command exited with code N" 等，`parity.rs` 的 Bash 步骤与 L2 断言依赖）；输出保留原样的末尾换行。改措辞时同步对照测试与 `tests/scenarios/exec-*.yaml`。
- 命令的 `details.commandExecution` 由 `shell.ts` 写、`items.ts` 的 `resultExecution` 校验后放进条目的 `execution`（实时与历史都经它）；改形状时两边与协议类型一起改。

## 参考

- 架构第 5 章、第 7.4–7.5 节；ADR-0002、ADR-0009、ADR-0010、ADR-0015。
- `docs/research/pi-v1.4.0-baseline.md` 文末"版本差异：v1.5.2"；`docs/spikes/S03-multi-session.md`、`S04-operations-delegation.md`、`S09-ahp-resilience.md`；ADR-0020。
