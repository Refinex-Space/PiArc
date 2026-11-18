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

## L2 场景运行器（`src/l2/`，T15）

- 夹具：`workspace.fixtures` 把 `tests/scenarios/fixtures/` 下的文件按字节复制进工作区，`expect.fixtures` 按字节比对（CRLF、BOM、GBK、图片、PDF；该目录在 `.gitattributes` 里设为 `-text`）。端点的 `vision: true` 让模型接受图片输入。PDF 夹具用 `piarc-fs` 的 `make_pdf` 生成（手写的 PDF 可能取不到文字，见 `crates/piarc-fs/AGENTS.md`）。
- 场景格式的唯一描述是 `tests/scenarios/schema.json`（`format.rs` 以 `include_str!` 嵌入）：改格式时同时改 schema、`format.rs` 的类型与引用检查、`testing.md` 第 12 节。加载分三遍：schema（报字段的 JSON Pointer）→ serde → 引用检查（id 与文件名、会话与端点、标签先定义后使用、路径不出工作区、mock 脚本自检）。
- 运行器只经 `CoreRuntime` 的公开方法驱动、只读 sink 送达的事件与 `ToolIoObserver`（`gate.rs`）；不复制 Core 的逻辑。每个端点一个 `MockProvider` 与一个 Pi provider（`mock-<端点名>`，模型 `mock-model`），场景经模型的 `x-piarc-scenario` 请求头选择，提示词里没有场景标记。
- 每次运行一个新的临时根（含空格与中文，带进程号与计数）和一个新 Core；结束后删除并在结果里报告。并行的场景各起一个 Agent Host（默认半数核心、至多 4 个）。
- 命令环境（T17，`runner.rs` 的 `command_env`）：L2 的 Core 用登录 shell，但从测试进程环境加 `INTERNAL_PROBES`（`ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS`、`PI_CODING_AGENT_DIR`、`PIARC_L2_INTERNAL`，模拟应用里 Core 的环境）与 `L2_USER_VAR=kept` 起步；Unix 上 `SHELL=/bin/bash`、`HOME` 为本次运行的 `home 家/`，其 `.bash_profile` 把 `home 家/bin`（含 `l2-login-tool`）放进 `PATH` 并设 `L2_LOGIN_PROFILE=loaded`。`exec-env-*` 场景依赖这些名字，改动时同步。
- Composer 输入可声明提及、客户端幂等键与附件夹具。运行器经 Core 的 `store_attachment` 存入附件，输入携带返回的引用。见 `chat-composer-input.yaml`（含手动压缩）与 `turn-classified-errors.yaml`。
- 会话建立时 Agent Host 发一次 `exec/shells`（没有工具调用 id）：`ToolIoObserver` 的计数与批次 Gate 要忽略没有 `tool_call_id` 的请求（`tests/sessions/turns.rs` 的 `Rounds` 已这样做）。
- 动作结束后先等每个被启动的回合 `turn/completed`，再一次性检查全部断言；没有 sleep，等待只有 30 s 安全网。
- 每个请求都必须通过严格 mock 的校验（总是检查）；`approvals` 按声明顺序答复会话快照里的新请求；多出的应答、无人答复的请求或工具名不符都使场景失败。

## 易错点

- Windows：不要把 `canonicalize` 的结果（`\\?\C:\…` 形式）交给 Node 运行脚本，Node 会 `lstat 'C:'` 失败；仓库根用 `CARGO_MANIFEST_DIR` 的上两级。Core 报告的路径不带 `\\?\`，比较时用 harness 的 `canonical()`。
- `credentials.rs` 在 Windows 上用 `tests/agent_host/process-env.ps1` 从 PEB 读另一个进程的环境块（对应 macOS 的 `ps -E`）。
- 慢读者用例按平台断言：Windows 上 Node 写 stdout 同步阻塞，Core 停读期间 Pi 停在第一次模型请求（S9 报告第 5 节）。
- 断流靠 `body.rs` 的 `ScriptBody::aborted`：最后一块之后先返回一次 `Pending` 让 hyper 把已写数据刷到 socket，再返回错误让 hyper 关闭连接。直接返回错误会丢掉已缓冲的事件。挂起（`stalled`）在最后一块之后一直返回 `Pending` 且不唤醒，客户端关闭连接时 hyper 丢弃响应体。
- 参数分段按字符而不是字节计偏移；`split_at` 的每个偏移必须严格递增且落在 `(0, 长度)` 内，加载时检查。
- 工具参数以紧凑 JSON、键按字典序流出（serde_json 默认），断言拼接结果时用同样的序列化。
- Anthropic SDK 的 beta 客户端请求 `/v1/messages?beta=true`；路由只比较路径，记录里保留查询串。
- `restart_core` 之后的新 Core 必须用同一个保险箱主密钥名：`test_master_key_name` 每次调用都生成新名字，存在 `Env` 里复用，否则 Pi 读不到凭据（"No API key found"）。
- Cargo 在 crate 目录里运行测试二进制：harness 收到的相对路径要按仓库根解析（`scenarios.rs` 已处理 `--results`）。
- 工具批次靠 `Gate` 扣住下一批的请求直到整批到齐再放行，不靠计时；某批不完整时回合停住，30 s 后以"never completed"报告。
- `jsonschema` 经 `fluent-uri` 引入 MIT-0 的 `borrow-or-share`，`deny.toml` 为它单独设了许可证例外；升级 `jsonschema` 后例外不再命中时 cargo-deny 会警告。
