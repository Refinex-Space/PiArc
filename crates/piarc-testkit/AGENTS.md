# piarc-testkit

仅测试用的支持 crate：严格校验请求的 mock provider（架构第 12.2 节）、L2 场景运行器与事件断言（`src/l2/`，T15，架构第 12.3 节），以及 Agent Host 与会话层的端到端测试（`tests/agent_host/`、`tests/sessions/`）。发布的 crate 不得依赖它（`crates/deps-rules.json` 的 testsupport 层）。完整说明（端点、场景选择、脚本格式、规则表、记录字段）在 `docs/engineering/testing.md` 第 10 节，crate 文档（`src/lib.rs`）有同一份脚本格式。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-testkit` | 单元测试 + `tests/` 下的集成测试（线格式、校验规则、场景选择与故障注入、独立进程） |
| `cargo test -p piarc-testkit --test validation -- --nocapture` | 打印每条规则的 400 说明（验收证据用） |
| `cargo run -q -p piarc-testkit --bin piarc-mock-provider -- --port 0 --scenarios packages/testkit/scenarios` | 手动起一个独立进程：第一行打印端口，回车或关闭 stdin 后退出 |
| `npx vitest run packages/testkit` | pi-ai 对 mock 的两种线格式往返（会先 `cargo build` 这个 bin） |
| `cargo test -p piarc-testkit --test agent_host -- --nocapture` | S3、S4 与进程级 S9：`piarc-core::agent_host` 监管真实 Agent Host bundle（测试先运行 `node scripts/dev/build-agent-host.mjs`），mock 库形态应答，Core 侧用真实 `ToolIo`；需要 PATH 上的 node（或 `PIARC_TEST_NODE`）。`parity.rs` 还需要 ripgrep 与 fd（`.tools/bin` 或 PATH） |
| `cargo test -p piarc-testkit --test agent_host golden` | T14 的 golden 漂移检查：重新录制 Pi 事件序列，与 `agent-host/test/golden/*.events.json` 比对；`PIARC_UPDATE_GOLDEN=1` 时改写录制文件（之后 `npx vitest run agent-host -u` 更新投影快照） |
| `cargo test -p piarc-testkit --test sessions` | T14：经 `piarc_core::CoreRuntime` 的会话层端到端（真实 Agent Host + mock，`tests/sessions/`） |
| `cargo run --release -p piarc-testkit --example t14-warmup` | T14-A09：打开工作区到就绪、打开并恢复会话的 10 次测量，超过 1 s 预算即失败 |
| `cargo test -p piarc-testkit --test ahp_round_trip -- --nocapture` | T07-A10：`fs/read` 的 AHP 往返计时（独立测试二进制，计时期间不跑别的测试） |
| `cargo test -p piarc-testkit --test scenarios` | L2：`tests/scenarios/*.yaml` 每个文件一个测试（自定义 harness）；`-- <id> --exact` 只跑一个，`-- --results target/l2/results.json` 写 JSON 报告（相对路径按仓库根解析）。`test = false`：不在 `cargo test --workspace` 里，由 verify 第 14 步运行 |
| `cargo test -p piarc-testkit --test l2_runner -- --nocapture` | 运行器自身：格式错误、可读差异、未用的审批应答、重复运行与临时目录清理 |

## 两种运行形态

- L3 模式（T30）：`MockProvider::start_with(library, port, Mode::L3)`、bin 的 `--l3`。只保留协议规则（关闭 `system_sections`、`cache_breakpoint_position`），记录的 `body` 为空、`structure` 是 `l3::structure` 的白名单结构；流式的辅助请求（无工具，`l3::classify`）得到 `l3::AUXILIARY_REPLY` 且不消耗步数。不要在 L3 记录里加回原始内容（ADR-0006）。

- 库：`MockProvider::start(library).await`，必须在 tokio 运行时内调用；每个测试起自己的实例，步数计数天然隔离。
- 独立进程：`piarc-mock-provider`，`--port 0` 取空闲端口，stdout 第一行是端口；stdin 到 EOF 就退出。父进程退出前关闭它的 stdin。

## 规则 ID

可关闭：`tool_pairing`、`role_order`、`tool_schema`、`system_sections`、`cache_breakpoint_count`、`cache_breakpoint_position`。不可关闭：`malformed_request`、`streaming_required`、`scenario_not_selected`、`scenario_not_found`、`scenario_exhausted`、`not_found`。ID 是对外契约（测试按它断言），不要改名。

## 新增校验规则

1. `src/rules.rs`：`Rule` 加变体与 `id()`；写检查函数（只看 `Request`，不看原始 JSON）并接进 `validate`。
2. 可关闭的规则：加进 `Rule::VALIDATION` 与 `src/scenario.rs` 的 `RuleSwitches`（字段名与 ID 相同）。
3. 规则需要的新信息先加到 `src/request.rs` 的中立结构，再在 `anthropic.rs`、`openai.rs` 的 `parse` 里填充。
4. `tests/validation.rs` 加一个经 HTTP 触发 400 的测试，断言 `error.code` 与位置；同步 `testing.md` 第 10.4 节。

## 不变量

- 校验器与编码器分开：`rules.rs` 只依赖 `request.rs`；线格式细节只在 `anthropic.rs`、`openai.rs`。
- mock 不含场景特判，脚本是数据；不为某个测试硬编码响应。
- 被校验拒绝的请求不消耗步数；注入错误、断流（`disconnect_after_events`）与挂起（`stall_after_events`）消耗步数（模拟客户端重试时下一步应答）。
- 只绑定 `127.0.0.1`；记录里凭据头的值一律 `<redacted>`。
- 对客户端发来的未知字段宽容，对规则覆盖的结构严格。新增对某个客户端（pi-ai 等）的兼容前，先在其锁定版本源码里确认它实际发出的形状。

## Agent Host 端到端测试

- `cargo test -p piarc-testkit --test agent_host policy_faults` 注入 Core 错误、超时与非法回复，检查真实模型请求中的错误结果和工作区副作用。`cargo test -p piarc-testkit --test sessions permissions::` 使用真实 Core 审批账本检查双窗口答复、Host 进程被杀后的恢复、模式切换条目与整进程重启。

- `tests/agent_host/harness.rs`：每个测试一个临时根目录（含空格与中文），`data/pi/models.json` 定义 provider `piarc-mock` 与 `mock-large`（200k）、`mock-small`（32k）两个模型。`mock-small` 的请求一律以请求头选择场景 `small-window`：压缩会替换首条 user 消息，消息里的场景标记随之消失。
- 等待一律等事件或条件（`Recorder::until`、`turn_completed`），超时只作安全网。
- 中断或杀进程的时点靠场景步骤的 `stall_after_events`。中断后的对话由 Harness Kit 补齐（ADR-0026），这类场景开着 `role_order`；只有含 steer 的场景关闭它（steer 按 Pi 的做法紧跟工具结果，形成相邻的 user 消息）。
- `golden.rs`：用 `--test-record-events <目录>` 让 Agent Host 把 Pi 的原始事件与注册表的步骤（回合接受、中断、排队）写到 `<目录>/<会话 id>.jsonl`，按场景录制 `agent-host/test/golden/` 的输入。平时只检查已提交的录制与 Pi 现在产生的事件类型一致；投影的期望输出是 Vitest 文件快照。
- Core 侧的 `Core` 处理者回答 `trust/get`，并把 `fs/*`、`exec/*` 交给真实的 `ToolIo`、记录每次调用（`calls_of`）。会话一律经 `open()` 打开：它在 `session/create` 之后把 cwd 登记为该会话的工作区根，否则工具请求会得到 `sessionNotFound`。
- `tools.rs`（A01、A02、A04、A05）、`parity.rs`（A06，Pi 原生工具 vs 委托工具；T16 起脚本在每次 Edit 前先 Read，比较 Read 结果时去掉行号）与 `with_io_spy`（`NODE_OPTIONS` 预加载 `packages/testkit/src/io-spy.ts`）是 S4 的证据。spy 记录带时间戳，按场景窗口判定；会话创建时 Pi 的 `existsSync(cwd)` 是已知的唯一一次（I20）。
- 工具的 I/O 要 Core 读 stdout 才能进行：让 Core 停读的测试（背压）不能等真实工具完成，用不存在的工具名制造通知。
- `mock-vision` 模型接受图片输入，`tool_results_in` 把图片块写成 `[image <类型> <base64>]`。
- Core 侧的 `secrets/*` 由 `Env.secrets`（真实 `SecretsService`，保险箱在测试数据目录，主密钥在 `Env.key_store` 这个内存替身里）回答；同一个 `Env` 的所有 Agent Host 共用它，就像一个 Core。要注入凭据库失败，对 `env.key_store` 调 `fail_with`。
- `credentials.rs`（S5）：`--test-oauth-provider` 与 `token_server.rs`（refresh token 用过即失效）验证登录、只刷新一次、无明文与进程环境；`capture_logs()` 把 Core 的 tracing（含 Agent Host 的 stderr）写到一个文件供扫描，整个测试二进制只装一次。
- 无明文扫描用库里的 `piarc_testkit::plaintext::scan`：逐字节、不跟随符号链接、读不了的文件单独列出；先放一个对照文件证明扫描路径有效。

## 会话层端到端测试（`tests/sessions/`，T14）

- `support.rs`：`Env` 起 mock、写 `models.json`、用 `CoreConfig` 启动真实 `CoreRuntime`（`AgentHostLaunch::Custom` 指向测试打包的 bundle，`SecretStoreSetup` 用内存保险箱，`ManualClock` 控制空闲回收）；`Events` 收集 sink 的批次，`wait` 等某路由上满足条件的事件。同一个 `Env` 上重启 Core 复用同一个主密钥名。
- `ToolIoConfig.observer` 记录同时进行的 `fs/*` 调用数（A06 的批次上限）；`--test-drop-seq <n>` 让 Agent Host 不写出第 n 条通知（A08 的缺口补齐）。
- 场景在 `tests/sessions/scenarios/`；等事件一律经 `Events::wait`，合并器按 16 ms 刷出。

- `provider_settings_crud_keeps_credentials_in_the_vault` 通过公开设置 API 增改删四类提供商，扫描数据目录与进程环境，另起 Host 验证删除结果。跨平台进程环境检查与 T08 共用 `tests/support/process_environment.rs`。

## L2 场景运行器（`src/l2/`，T15）

- 夹具：`workspace.fixtures` 把 `tests/scenarios/fixtures/` 下的文件按字节复制进工作区，`expect.fixtures` 按字节比对（CRLF、BOM、GBK、图片、PDF；该目录在 `.gitattributes` 里设为 `-text`）。端点的 `vision: true` 让模型接受图片输入。PDF 夹具用 `piarc-fs` 的 `make_pdf` 生成（手写的 PDF 可能取不到文字，见 `crates/piarc-fs/AGENTS.md`）。
- 场景格式的唯一描述是 `tests/scenarios/schema.json`（`format.rs` 以 `include_str!` 嵌入）：改格式时同时改 schema、`format.rs` 的类型与引用检查、`testing.md` 第 12 节。加载分三遍：schema（报字段的 JSON Pointer）→ serde → 引用检查（id 与文件名、会话与端点、标签先定义后使用、路径不出工作区、mock 脚本自检）。
- 运行器只经 `CoreRuntime` 的公开方法驱动、只读 sink 送达的事件与 `ToolIoObserver`（`gate.rs`）；不复制 Core 的逻辑。每个端点一个 `MockProvider` 与一个 Pi provider（`mock-<端点名>`，模型 `mock-model`），预置端点经模型的 `x-piarc-scenario` 请求头选择脚本，`configure_as` 端点经首条用户消息的场景标记选择。
- 每次运行一个新的临时根（含空格与中文，带进程号与计数）和一个新 Core；结束后删除并在结果里报告。并行的场景各起一个 Agent Host（默认半数核心、至多 4 个）。
- 命令环境（T17，`fixtures.rs` 的 `command_env`）：L2 的 Core 用登录 shell，但从测试进程环境加 `INTERNAL_PROBES`（`ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS`、`PI_CODING_AGENT_DIR`、`PIARC_L2_INTERNAL`，模拟应用里 Core 的环境）与 `L2_USER_VAR=kept` 起步；Unix 上 `SHELL=/bin/bash`、`HOME` 为本次运行的 `home 家/`，其 `.bash_profile` 把 `home 家/bin`（含 `l2-login-tool`）放进 `PATH` 并设 `L2_LOGIN_PROFILE=loaded`。`exec-env-*` 场景依赖这些名字，改动时同步。
- Composer 输入可声明提及、客户端幂等键与附件夹具。运行器经 Core 的 `store_attachment` 存入附件，输入携带返回的引用。见 `chat-composer-input.yaml`（含手动压缩）与 `turn-classified-errors.yaml`。
- 会话建立时 Agent Host 发一次 `exec/shells`（没有工具调用 id）：`ToolIoObserver` 的计数与批次 Gate 要忽略没有 `tool_call_id` 的请求（`tests/sessions/turns.rs` 的 `Rounds` 已这样做）。
- T22 的 `context-*.yaml` 用真实请求比较 system 与追加消息。Core 的 `home` 指向同一次运行的 `home 家/`，`workspace.run_files` 可在隔离的临时根准备用户 memory 和外部导入。
- 动作结束后先等每个被启动的回合 `turn/completed`，再一次性检查全部断言；没有 sleep，等待只有 30 s 安全网。
- 会话的 `mode` 与 `set_mode` 接受四种模式（T23）；跳过权限要用户级开关，场景用 `workspace.run_files` 写 `data 数据/settings.json`（运行器的数据目录）。只读白名单命令不再发审批，要审批的命令用 `env echo`、`sed`、`printenv`。
- T24：每个场景在 Core 启动前与关闭后比对运行根下的 Claude Code 配置快照（`fixtures.rs` 的 `claude_snapshot`），有变化即以 `claude_config` 失败；`config-*.yaml` 用 `run_files` 的 `home 家/.claude/…` 准备用户级文件，`expect.config_diagnostics` 在回合结束后取 Core 的配置诊断做子集比较（`checks.rs` 先把 `files` 列表按层 id 转成对象）。Bash 分析会剥掉裸 `env` 包装，规则匹配的是剥离后的命令：要证明某个 allow 规则生效，用 `sed`、`awk` 这类不被剥离又不在只读白名单里的命令。规则断言的 glob 文字要避开工具描述里出现的示例（Grep 的描述含 `src/**/*.ts`）。
- T25：`hooks-*.yaml` 用 `workspace.fixtures` 把 `fixtures/hooks/hook.mjs.txt` 复制成 `hook.mjs`（不以 `.mjs` 入库，避开 ESLint 与 tsc），命令写 `node hook.mjs <名字>`；它把 stdin 记到 `hook-log/<名字>.jsonl`（`types` 记每个字段的类型，用来断言值未知的通用字段），按 `hook-plans/<名字>.json` 应答（可用 `sequence` 逐次变化）。`expect.json_lines` 断言这些记录（断言前等文件写满行数，后台运行的 Notification hook 需要），输入动作的 `rejected` 断言 Core 拒绝该输入，会话的 `core/notices`（hook 提示）作为该会话的 `events` 参与匹配。`tool_results` 断言的是请求里全部工具结果，要按顺序列出之前的 id。
- T26：审批应答可带 `mode`（计划批准）、`comments`（按 `quote` 第一次出现处算 UTF-16 偏移）、`answers`（提问表单），`decision: wait` 不作答让表单超时；动作 `fork`（在某条回复的 entry 处分叉，新会话占用一个 `deferred` 会话标签）与 `check_harness`；请求断言 `same_tools_as` 比较原始工具定义字节。实现在 `src/l2/harness_spec.rs` 与 `src/l2/runner/harness.rs`。
- T27：端点可写 `context_window`、`max_tokens`（导入的模型夹具），`compact` 动作可带 `instructions`，`check_usage` 读 Core 的 `contextUsage` 并总是检查类别之和等于 `tokens`（`src/l2/context_spec.rs`、`runner/harness.rs`）。`ctx-*.yaml` 用它们锁定阈值边界、熔断、重注入、提醒、外部修改、用量与缓存断点。L4 或 agent_host 测试里压缩后 mock 按首条 user 消息选场景时，脚本里的摘要文本要带 `[[piarc-scenario:<id>]]`（压缩后首条 user 消息就是摘要）。
- T28：动作 `rewind`、`undo_rewind`、`check_changes`、`discard`、`switch_branch`、`check_branch`、`check_files` 与 `fork` 的 `before_turn`（`src/l2/checkpoint_spec.rs`、`runner/checkpoints.rs`，字段见 `testing.md` 12.2）；`rewind-*.yaml`、`changes-*.yaml` 覆盖四个选项、冲突、只被 Bash 改动的文件、hunk 丢弃与 CRLF/BOM 夹具（`fixtures/changes/`）、分支切换与从这里分支。
- `tests/agent_host/context.rs`（T27）：L2 经 Core 公开 API 驱动不到的两条路径——`session/remind`（后台任务提醒）与压缩后重注入 skill 正文（向会话 JSONL 追加模拟的 `piarc.skillInvoked` 条目后 `session/resume`）。agent_host 测试的 Core 替身对 `context/settings`、`fs/changes`、`fs/forgetReads` 由 `ToolIo` 应答（无设置服务时取缺省值）；列举 Core 调用的断言要把这些没有工具调用 id 的请求排除在外。
- T31：端点的 `model` 改模型 id（缺省 `mock-model`），会话的 `settings_model: true` 不带模型创建（设置的 `model`、`effortLevel` 生效），审批应答的 `subagent: { type, description }` 核对卡片的子 agent 来源（`approvals.rs` 的 `check_card` 统一检查调用、类型与来源）。`subagent-*.yaml` 用不同端点区分父子会话的请求；`tests/sessions/lifecycle.rs` 的后台子 agent 用例（`bg-subagent*.yaml`）检查运行期间空闲计时不回收 Agent Host、子会话不进会话列表。
- T32：L2 的 Core 用 `ManualClock` 作任务时钟（`Env.clock`，跨 `restart_core` 保留），动作 `advance_clock` 推进它、`stop_task` 停止会话最新的运行中任务；顶层 `task_limits` 缩小 Monitor 限值；`core/tasks` 的任务行按 `ownerSessionId` 作为会话事件参与匹配（`runner.rs` 的 `observed`）。mock 的工具参数占位符 `{{result:<调用 id>:<正则>}}`（`server.rs` 的 `fill_results`）在应答时取本次请求里该工具结果的捕获组。`tests/sessions/tasks.rs` 是 Agent Host 崩溃后后台命令继续与通知送达（A09）、退出时进程树结束与重启后显示已中断（A10）；`record_host_pid`/`kill_host` 在 `support.rs`。
- T34：动作 `open_terminal`（经 Core 的 `open_session_terminal` 为用户打开会话终端，记为该会话最近的终端）、`type_terminal`（`terminal_write`）、`share_terminal`（`set_terminal_shared`），实现在 `runner/terminals.rs`；`term-user-share.yaml` 用它们验证未共享时没有屏幕文件、共享后提醒给出位置且 Read 可读、取消后又看不到。
- T35：工作区可写 `git_commit`（以固定身份提交初始文件）与 `git_branches`；会话可写 `worktree: { name?, base? }`（经 `create_worktree_session` 创建）；动作 `sweep_worktrees`（立即清理一次，按会话标签集合比对删除与等待的）、`check_worktree`（Core 记录的 worktree 字段子集：`path` 相对工作区、`branch`、`exists`、`removed`、`cleanupDue`、`confirm`）、`remove_worktree`、`keep_worktree`、`check_git`（在工作区运行 git，`contains`/`not_contains`/`lines`）、`search`（会话标签集合与摘要文字）。worktree 的到期按任务时钟（`advance_clock`）计算，清理计时器的间隔设成 100 年，只有 `sweep_worktrees` 触发清理。实现在 `src/l2/worktree_spec.rs`、`runner/worktrees.rs`。
- T36：顶层 `mcp_http`（`src/l2/runner/mcp.rs`）为每个名字起一个 `MockMcpServer`（`src/mcp_server.rs`：Streamable HTTP 的 `/mcp`，可选的 OAuth：RFC 9728/8414 元数据、动态注册、PKCE S256 的授权码与轮换的 refresh token），工作区文件里的 `{{mcp_http:<名字>}}` 换成它的地址、`{{mcp_echo}}` 换成 `packages/testkit/src/mcp-echo-server.ts` 的绝对路径；动作 `mcp_sign_in`（`server`、`outcome`）经 Core 的 `mcp_login` 登录，运行器代替浏览器跟随授权页。`mcp-*.yaml` 覆盖共享进程、延迟加载与 `ToolSearch`、规则与 `requiresUserInteraction`、`list_changed` 的提醒、未信任项目、子 agent 的 server 与 OAuth。`tests/sessions/mcp.rs` 是 OAuth 端到端（A07）、无孤儿进程（A11）与没有系统 node 时 `npx` 跑在内置 Node 上（A06）；agent_host 测试的 `Core` 替身经 `Env.mcp` 回答 `mcp/servers`（`harness.rs` 的 `mcp_servers`）。
- T37：动作 `set_output_style`（`name` 可省略，经 Core 的 `set_output_style` 写工作区的 `.piarc/settings.local.json`，并让运行中的 Agent Host 立即重新取 skills 与风格）；`skill-*.yaml`、`command-expand.yaml`、`style-switch.yaml` 覆盖索引、`Skill` 的加载与重注入、skill 的 hooks、`allowed-tools` 的回合边界、`paths`、斜杠命令展开与输出风格切换。命令与 skill 文件写在 `workspace.files`，用户级的写在 `run_files` 的 `home 家/.claude/…`。
- T38：mock 的步骤可带 `web_search`（`query`、`results`（`title`、`url`、可选 `page_age`、`cited_text`）或 `error`），按 Anthropic 线格式在正文前流出 `server_tool_use`、整块的 `web_search_tool_result` 与正文的 `citations_delta`，`message_delta` 的 `usage.server_tool_use.web_search_requests` 为 1（OpenAI 格式的步骤拒绝它）。L2 有 `web` 段时 Brave Search 的端点指向它（`/res/v1/web/search` 的页面就是搜索结果），动作 `set_web_search_key` 经 Core 的 `set_web_search_key` 把 key 存进保险箱，`expect.absent_on_disk` 在运行结束后用 `plaintext::scan` 扫数据、工作区、家目录与缓存目录。会话在 key 存好之后才能拿到 `WebSearch`（工具集在会话打开时决定），这类场景把会话设为 `deferred`。原生搜索的辅助请求消耗同一端点的一步。
- 每个请求都必须通过严格 mock 的校验（总是检查）；`approvals` 按声明顺序答复会话快照里的新请求；多出的应答、无人答复的请求或工具名不符都使场景失败。

- T40：顶层 `packages`（`src/l2/package_spec.rs`、`runner/packages.rs`）在打开工作区前经 Core 的 `package_install` 安装 `run_files` 写的包目录（`source: git` 先做成一个提交再从 `file://` 克隆），缺省开启并确认全部可执行项（`confirm: false`、`enable: false` 可关）；动作 `check_commands`（`present`、`absent`）轮询 Core 的命令列表至多 10 s。`plugin-*.yaml`、`pi-package-git.yaml`、`mcp-prompts.yaml` 用它们；夹具 server 的 `MCP_ECHO_PROMPTS=1` 提供 prompts。
- T30：端点脚本工具参数里的 `{{workspace}}` 换成工作区绝对路径（`runner/env.rs` 的 `fill_workspace`）；审批应答可带 `call`（运行器取卡片所属的、已开始未结束的同名工具调用，`runner/l3.rs` 的 `pending_call`）。`run_l3` 以 L3 模式运行并在删除临时根之前采集结构（请求结构、工具条目状态、按 `call` 作答的询问、回合状态、文件 hash、`.l3/*.jsonl`），没有应答点名的卡片拒绝而不是失败；`piarc-devcli l3` 写出它。
- T29：顶层 `web`（`src/l2/web.rs`）起本地网页服务器，`{{web}}`/`{{web_alt}}` 在页面与端点的工具参数中替换为 `http://127.0.0.1:<端口>` 与 `http://localhost:<端口>`（两个不同的主机），Core 的 WebFetch 允许列表只为这些场景放行这两个主机；WebFetch 的提取是一次额外的模型请求，脚本里要为它留一步（同一端点，或 `modelProviders.auxiliary` 指向的另一个端点）。顶层 `oauth`（`login_spec.rs`、`runner/login.rs`）起 mock 授权服务器并给每个 Agent Host 注册 `piarc-test-oauth`，动作 `sign_in`（运行器代替浏览器跟随授权页的重定向，或在第一步取消；只认 `authUrl`/`deviceCode`/`prompt` 为可操作的步，进度可能先到）与 `sign_out`。每模型设置与辅助模型用 `run_files` 写 `data 数据/settings.json` 的 `modelProviders`；`configure_as: local` 的端点模型是低可靠性（保守 Tool Profile）。
- mock 授权服务器（`src/auth_server.rs`，bin `piarc-mock-auth`：stdout 第一行端口，stdin 每行 `approve`/`deny`/`expire` 改决定，EOF 退出；`--pending-polls` 控制设备码轮询多少次后决定，L4 用 30 次约 3 s 以便截图）。`tests/sessions/login.rs` 经 Core 公开 API 跑授权码、设备码、拒绝、过期、取消与手工粘贴代码，并扫描数据目录无明文。

## 易错点

- Windows：不要把 `canonicalize` 的结果（`\\?\C:\…` 形式）交给 Node 运行脚本，Node 会 `lstat 'C:'` 失败；仓库根用 `CARGO_MANIFEST_DIR` 的上两级。Core 报告的路径不带 `\\?\`，比较时用 harness 的 `canonical()`。
- `credentials.rs` 在 Windows 上用 `tests/agent_host/process-env.ps1` 从 PEB 读另一个进程的环境块（对应 macOS 的 `ps -E`）。
- 慢读者用例按平台断言：Windows 上 Node 写 stdout 同步阻塞，Core 停读期间 Pi 停在第一次模型请求（S9 报告第 5 节）。T27 起会话读写过文件后，每轮送达提醒前要等 Core 应答 `fs/changes`：慢读者用例只调用不存在的工具，不触发它。
- 断流靠 `body.rs` 的 `ScriptBody::aborted`：最后一块之后先返回一次 `Pending` 让 hyper 把已写数据刷到 socket，再返回错误让 hyper 关闭连接。直接返回错误会丢掉已缓冲的事件。挂起（`stalled`）在最后一块之后一直返回 `Pending` 且不唤醒，客户端关闭连接时 hyper 丢弃响应体。
- 参数分段按字符而不是字节计偏移；`split_at` 的每个偏移必须严格递增且落在 `(0, 长度)` 内，加载时检查。
- 工具参数以紧凑 JSON、键按字典序流出（serde_json 默认），断言拼接结果时用同样的序列化。
- Anthropic SDK 的 beta 客户端请求 `/v1/messages?beta=true`；路由只比较路径，记录里保留查询串。
- `restart_core` 之后的新 Core 必须用同一个保险箱主密钥名：`test_master_key_name` 每次调用都生成新名字，存在 `Env` 里复用，否则 Pi 读不到凭据（"No API key found"）。
- Cargo 在 crate 目录里运行测试二进制：harness 收到的相对路径要按仓库根解析（`scenarios.rs` 已处理 `--results`）。
- 工具批次靠 `Gate` 扣住下一批的请求直到整批到齐再放行，不靠计时；某批不完整时回合停住，30 s 后以"never completed"报告。
- `jsonschema` 经 `fluent-uri` 引入 MIT-0 的 `borrow-or-share`，`deny.toml` 为它单独设了许可证例外；升级 `jsonschema` 后例外不再命中时 cargo-deny 会警告。
