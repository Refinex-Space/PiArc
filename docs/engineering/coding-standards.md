# 编码规范

适用于仓库中的全部代码。优先级：架构设计 `docs/architecture/ARCHITECTURE.md` 与 ADR 高于本规范，本规范高于个人习惯。能由工具检查的规则都已接入 `npm run verify`，下文在规则后注明对应的检查；没有注明的靠评审把关。

## 1. 通用

### 1.1 语言

- 代码、注释、标识符、提交信息、日志与错误信息用英文。
- 设计文档（`docs/` 下的架构、ADR、规范、计划、报告）用中文。
- crate 级文档（`//!`）与公开 API 的文档注释用英文。

### 1.2 提交

- 遵循 Conventional Commits：`<type>(<scope>): <subject>`，subject 用英文祈使句、小写开头、不加句号。
- type 取 `feat`、`fix`、`refactor`、`perf`、`test`、`docs`、`build`、`ci`、`chore`。
- scope 用 crate 或工作区名去掉前缀，例如 `core`、`policy`、`desktop`、`agent-host`、`protocol`、`plan`。
- 每个提交可编译、相关测试通过；一个提交只做一件事。

### 1.3 格式化

格式全部交给工具，不手工对齐，也不在评审中讨论格式。

| 文件 | 工具 | 检查 |
|---|---|---|
| TS、JS、JSON、YAML | Prettier（`.prettierrc.json`：单引号、行宽 100、尾逗号） | verify 第 1 步 |
| Rust | rustfmt（`rustfmt.toml`：style edition 2024、LF） | verify 第 6 步 |
| Markdown | 不经 Prettier | — |

Markdown 不进 Prettier：文档中的宽表格每次编辑都会被重新填充空格，产生与内容无关的大段差异。排除清单见 `.prettierignore`。

编码与换行由 `.editorconfig` 和 `.gitattributes` 统一为 UTF-8、LF；需要保留 CRLF 的测试夹具见 `testing.md` 第 4 节。

### 1.4 依赖

- npm 依赖精确锁定，`package.json` 中不出现 `^`、`~`；`package-lock.json` 入库。安装用 `npm install --save-exact`。
- Cargo 依赖只在根 `Cargo.toml` 的 `[workspace.dependencies]` 中声明版本，crate 中一律写 `<name>.workspace = true`（或 `{ workspace = true, features = [...] }`）。`Cargo.lock` 入库，verify 以 `--locked` 运行。
- 新依赖的许可证必须在 `deny.toml` 白名单内（verify 第 11 步）；GPL、AGPL、LGPL 不得进入依赖树。
- 引入依赖前确认没有已有依赖或标准库能满足需求。

### 1.5 平台与路径

遵守架构第 15.3 节：

- 路径一律用 `std::path` / Node `path` 拼接，不写死分隔符；比较路径前先规范化（大小写、符号链接、`\\?\` 前缀）。
- 业务代码里不出现平台分支。平台差异放在 Core 的 trait 实现和主进程的 `platform/` 模块里。
- 脚本用 Node 或 Python 编写，在 macOS 与 Windows 上都能运行。

### 1.6 禁止写入仓库的内容

凭据、个人信息、本机绝对路径；从 `reference/claude-code` 或 `reference/OpenClaudeDesktop` 复制的任何代码、提示词和界面组件（ADR-0006，`docs/plan/references.md`）。

## 2. Rust

### 2.1 crate 与模块组织

- 一个 crate 一个职责，划分见架构第 7.1 节。crate 根文件以 `//!` 文档开头，写三段：职责（Responsibilities）、不负责什么（Not responsible for）、允许依赖的 workspace crate（Allowed workspace dependencies）。
- crate 之间的依赖方向由 `crates/deps-rules.json` 规定、`scripts/ci/check-crate-deps.mjs` 检查（verify 第 12 步）。功能 crate 之间需要协作时经 `piarc-core` 编排。新增不改变方向的单向例外属于补充型决策，在 `deps-rules.json` 中登记并写明理由；反转或绕过依赖链属于变更型决策，先写 ADR。
- `lib.rs` 只做模块声明与公开项的 re-export；实现放在按领域命名的模块中（例如 `rules.rs`、`ledger.rs`），不按技术层命名（不用 `utils.rs`、`helpers.rs`、`types.rs` 收纳杂项）。
- 公开面最小化：默认私有，crate 内共享用 `pub(crate)`，只有其他 crate 需要的项才 `pub`。

### 2.2 命名

- 遵循 Rust API Guidelines：类型与 trait 用 `UpperCamelCase`，函数、方法、模块用 `snake_case`，常量用 `SCREAMING_SNAKE_CASE`。
- 转换方法按开销命名：`as_*`（无开销借用）、`to_*`（有开销）、`into_*`（消耗 self）。
- 布尔量与谓词用 `is_*`、`has_*`、`can_*`。
- 不在类型名里重复 crate 名：`piarc_policy::Rule`，而不是 `piarc_policy::PolicyRule`。

### 2.3 错误

- 每个库 crate 在 `error.rs` 中定义一个 `thiserror` 枚举 `Error`，以及 `pub type Result<T, E = Error> = std::result::Result<T, E>`。
- `Error` 提供两个方法：
  - `kind(&self)`：返回稳定的、可机读的类别（snake_case 字符串或无数据的枚举），调用方按它分支，不解析 message；
  - `retryable(&self) -> bool`：同样的输入再试一次是否可能成功（超时、暂时不可用为 true，校验失败、权限拒绝为 false）。
- 跨 NAPI 与 AHP 时，错误映射为 `piarc-protocol` 中定义的结构化错误 `ErrorObject`（`code`、`message`、`data.kind`、`data.retryable`，可选 `data.details`），不传裸字符串。线上的 `kind` 取 `piarc_protocol::ErrorKind` 的 camelCase 值；新增类别在 `ErrorKind` 中加变体，并从 `rpc_error::code` 的应用错误码段取一个码。
- 库 crate 不用 `anyhow`；`piarc-devcli` 等二进制和测试代码可以用。
- 不吞错误：`let _ = fallible()` 与空的 `Err(_) => {}` 分支必须有注释说明为什么可以忽略。
- 用 `?` 传播并在边界处补充上下文（例如出错的路径），不在每一层重复包装。

### 2.4 panic

- 非测试代码不用 `unwrap()`；`expect("...")` 只用于可以证明不会失败的不变量，消息写明这个不变量。
- `todo!()`、`unimplemented!()`、`dbg!()` 不得提交（workspace lints，verify 第 7 步）。
- panic 不得穿过 NAPI 边界：`piarc-napi` 的每个导出函数在边界处捕获 panic，转成结构化错误；Core 内部错误不能让 Electron 主进程崩溃（ADR-0014）。

### 2.5 I/O 边界与平台代码

- I/O 边界用 `piarc-ports` 中的窄 trait 隔离：`ProcessSpawner`、`FileSystem`、`Clock`、`SecretStore`、`AgentHostTransport`。功能 crate 依赖 trait，不直接调用 `std::process`、`std::fs`、系统时钟或系统凭据库；生产实现由 `piarc-core` 注入，测试用内存实现驱动。
- 进程启动统一经 `ProcessSpawner`（实现在 `piarc-exec`），不在各 crate 里各写一套进程树管理。
- 平台相关代码收敛在 trait 实现后面，用 `#[cfg(target_os = "...")]` 区分；新增平台假设必须经 CI 的 Windows 构建检查。

### 2.6 异步与并发

- Core 内部使用一个 tokio 多线程运行时；工作区与会话用 actor 加消息通道交互，避免共享可变状态加锁（架构第 7.2 节）。
- 长任务接受 `CancellationToken`，取消沿会话 → 回合 → 工具调用 → 子进程传播。
- async 代码中不做阻塞调用；阻塞的文件或 CPU 密集操作放进 `spawn_blocking`。
- NAPI 同步方法只做参数校验与入队，单次耗时预算 1 ms；耗时操作返回 Promise。

### 2.7 规模

- 单函数不超过 80 行。clippy 的 `too_many_lines` 以 80 为阈值（`clippy.toml`），以 deny 级别检查（verify 第 7 步）。确需超过时写 `#[expect(clippy::too_many_lines, reason = "...")]`，理由要说明为什么拆分反而更差（例如一张平铺的匹配表）。
- 单文件不超过 1,000 行。超过时在评审中说明理由，或按领域拆分模块。

### 2.8 unsafe

- `unsafe` 只允许出现在 `-sys` crate（`piarc-ghostty-sys`）与 NAPI 边界（`piarc-napi`）。workspace lints 对 `unsafe_code` 设为 deny；这两个 crate 在 crate 根写 `#![allow(unsafe_code, reason = "...")]` 放开。
- 每个 `unsafe` 块前写 `// SAFETY:` 注释，说明满足了哪些前置条件（clippy `undocumented_unsafe_blocks`，verify 第 7 步）。
- `unsafe fn` 内部的不安全操作也要包在 `unsafe {}` 块中（edition 2024 默认的 `unsafe_op_in_unsafe_fn`）。

### 2.9 lint

- lint 级别统一在根 `Cargo.toml` 的 `[workspace.lints]` 中设置，crate 写 `[lints] workspace = true`，不在 crate 内另设一套。
- 放宽某条 lint 时必须带理由：`#[expect(lint, reason = "...")]` 或 `#[allow(lint, reason = "...")]`，不带 `reason` 会被 `allow_attributes_without_reason` 拒绝。优先用 `#[expect]`：lint 不再触发时它会报警，过期的豁免不会留下。
- verify 以 `cargo clippy --workspace --all-targets --locked -- -D warnings` 运行，任何警告都是失败。

### 2.10 文档注释

- 公开项写 `///` 文档：做什么、错误条件（`# Errors`）、会 panic 的条件（`# Panics`）。
- 注释写"为什么"，不复述代码"做什么"。

## 3. TypeScript

### 3.1 编译选项

所有工作区继承 `tsconfig.base.json`：`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`、`verbatimModuleSyntax`，`module` 与 `moduleResolution` 为 `NodeNext`。工作区不得放宽这些选项。根 `tsconfig.json` 是 solution 文件，`tsc --build` 构建全部工作区与 `scripts/`（verify 第 3 步）。

### 3.2 类型安全

- 禁止 `any`（`@typescript-eslint/no-explicit-any`）。类型确实未知时用 `unknown`，再用类型守卫收窄。
- 来自系统边界的数据（AHP、IPC、NAPI、文件、网络、`JSON.parse`）一律先当作 `unknown`，校验后才使用；不用 `as` 把未校验的数据断言成目标类型。
- 不用非空断言 `!`；用显式判断或抛出带说明的错误。
- 只导入类型时用 `import type`（`consistent-type-imports`）。

### 3.3 模块与边界

- 只用 ESM（`"type": "module"`）；相对导入写 `.js` 扩展名（NodeNext 要求）。
- 每个工作区经 `src/index.ts` 暴露公开 API；跨工作区只按包名导入（例如 `@piarc/protocol`），不导入另一个工作区的内部文件。
- 进程边界（ADR-0013）：
  - 渲染进程不导入 Node 内置模块、Electron、主进程代码或原生模块，只能调用 preload 暴露的白名单 API；preload 只能导入 `electron`；`new BrowserWindow` 只在窗口工厂、`ipcMain.handle` 只在 IPC 注册函数中出现（`eslint.config.mjs` 的 `desktopProcessBoundaries`，verify 第 2 步）；
  - 主进程只做平台集成与转发，不承载业务逻辑；两个平台都需要的逻辑放进 Core 或 Agent Host。
- `packages/protocol/src/generated/` 由 `piarc-protocol` 的 JSON Schema 生成，不手工编辑（T02）。

### 3.4 Pi 依赖

- `@earendil-works/*` 全部锁定同一精确版本（架构第 5.7 节）。
- 只使用包入口公开导出的 SDK、ExtensionAPI 与类型，以及包的 `package.json` `exports` 声明的子路径（例如 `@earendil-works/pi-ai/api/anthropic-messages.lazy`），禁止其他深度导入（例如 `@earendil-works/pi-ai/dist/...`）。`eslint.config.mjs` 的 `piPublicImports` 按已安装包的 `exports` 生成放行清单，以 `@typescript-eslint/no-restricted-imports` 检查（verify 第 2 步）。

### 3.5 lint

- ESLint 使用 typescript-eslint 的 `strictTypeChecked` 与 `stylisticTypeChecked`，对全部 TS 与 JS 文件做类型感知检查（verify 第 2 步）；`eslint-config-prettier` 关闭与 Prettier 冲突的规则。
- `packages/protocol/src/generated/` 是生成代码，只关闭 `consistent-type-definitions` 与 `consistent-indexed-object-style` 两条风格规则（生成器输出的形状），其余规则照常检查（`eslint.config.mjs`）。
- 禁用某条规则时写在最小范围内并说明理由：`// eslint-disable-next-line <rule> -- <reason>`。不再需要的禁用注释会报错（`reportUnusedDisableDirectives`）。

### 3.6 仓库脚本

- `scripts/` 下的脚本用 Node ESM（`.mjs`）编写，类型写在 JSDoc 中，由 `scripts/tsconfig.json`（`checkJs`）参与 `tsc --build` 与类型感知 ESLint。
- JSDoc 的类型断言 `/** @type {T} */ (x)` 对 ESLint 不可见，`x` 仍按 `any` 检查。处理 `JSON.parse` 等返回 `any` 的结果时，先经返回 `unknown` 的函数（`readJsonFile`），再用守卫（`isRecord`）收窄。
- 调用外部命令用 `child_process.spawn` 加参数数组，不拼 shell 字符串。npm 包的命令行入口用 `resolveBin` 解析后以 `node <入口>` 运行，避开 Windows 上的 `.cmd` 包装。
- 可被测试的逻辑写成导出的纯函数；入口代码用 `isMain(import.meta.url)` 判断后才执行。

### 3.7 测试

Vitest，测试文件与源文件放在一起，命名 `*.test.ts`（脚本为 `*.test.mjs`）。分层、目录与纪律见 `testing.md`。

## 4. 通用能力复用

后续任务实现前先查这张表，有现成能力就复用，不就地重写；新增可复用能力时追加一行。

| 能力 | 位置 | 说明 | 登记任务 |
|---|---|---|---|
| 统一检查入口 | `scripts/dev/verify.mjs`（`npm run verify`） | 按顺序运行 13 个检查步骤，失败后继续，最后打印汇总表；新增检查在 `STEPS` 中追加 | T01 |
| crate 依赖方向检查 | `scripts/ci/check-crate-deps.mjs` + `crates/deps-rules.json` | 读取 `cargo metadata`，按层与例外校验 workspace crate 之间的依赖 | T01 |
| 验收清单一致性检查 | `scripts/plan/check-acceptance.mjs` | 比对任务文件中的 `- [Txx-Ayy]` 验收项与 `docs/plan/acceptance.json` | T01 |
| 仓库内工具安装 | `scripts/dev/install-tools.mjs` | 把锁定版本的 Rust 工具（当前为 cargo-deny）装进 `.tools/`，不做全局安装；`localToolPath()` 给出可执行文件路径 | T01 |
| 脚本公共函数 | `scripts/lib/repo.mjs` | `repoRoot`、`isMain`、`run`（继承输出）、`capture`（捕获输出）、`resolveBin`、`readJsonFile`、`isRecord` | T01 |
| AHP 帧编解码器 | Rust：`piarc_protocol::{FrameDecoder, encode_frame}`；TS：`@piarc/protocol` 的 `FrameDecoder`、`encodeFrame` | LF 分帧的 UTF-8 JSON，只处理字节缓冲，不做 I/O；半包缓存、超限帧丢弃到下一个 LF、错误按帧返回；两份实现跑同一份 `tests/contracts/framing/` 用例 | T02 |
| 协议版本协商 | `piarc_protocol::negotiate`、`PROTOCOL_VERSION`（TS 为生成的 `PROTOCOL_VERSION`） | 主版本不同返回 `protocolVersionMismatch`；次版本不同取双方能力交集 | T02 |
| 结构化错误 | `piarc_protocol::{ErrorObject, ErrorData, ErrorKind}`、`rpc_error::code` | JSON-RPC error 对象，`data.kind`、`data.retryable` 必填；跨 AHP 与 NAPI 的错误都用它；crate 错误经 `to_error_object()` 映射 | T02 |
| 协议生成与检查 | `npm run gen:protocol`（`scripts/dev/gen-protocol.mjs`）、`scripts/ci/check-protocol-drift.mjs`、`scripts/ci/check-contract-samples.mjs` | Rust 类型 → JSON Schema → TS 类型；漂移与样本完整性检查在 verify 中运行；新增协议消息的步骤见 `testing.md` 第 7 节 | T02 |
| IPC 注册与来源校验 | `apps/desktop/src/main/ipc/register.ts`（`createIpcRegistrar`）、`ipc/sender.ts`（`isTrustedSender`） | 主进程唯一调用 `ipcMain.handle` 的地方（ESLint 强制）：先校验 `senderFrame` 非空且 origin 与可信 origin 整串相等，不通过就拒绝并记日志；参数作为 `unknown[]` 交给处理函数校验 | T03 |
| origin 计算 | `apps/desktop/src/main/security/origin.ts`（`originOf`） | 主进程中比较 URL 的 origin 一律用它：Node 的 `URL` 把 `app://` 当作不透明 origin，它按 Chromium 的规则还原应用协议的元组 origin | T03 |
| 外链确认 | `apps/desktop/src/main/external-links.ts`（`openExternalLink`、`parseExternalUrl`、`ExternalLinkPort`）、`external-link-port.ts` | 只放行 `https:`、`http:`、`mailto:`；原生确认框显示规范化后的完整地址，确认后才 `shell.openExternal`；测试替换 `ExternalLinkPort` | T03 |
| 窗口工厂 | `apps/desktop/src/main/window.ts`（`createMainWindow`）、`web-preferences.ts`（`secureWebPreferences`） | 唯一允许 `new BrowserWindow` 的地方（ESLint 强制），`webPreferences` 取值固定，只有 preload 路径可变 | T03 |
| 桌面应用打包 | `scripts/dev/package-desktop.mjs`（`npm run package:desktop -- --flavor <release\|development>`） | 以指定构建类型运行 `electron-forge package`，输出到 `apps/desktop/out/<flavor>/`；fuse 配置的单一来源是 `apps/desktop/fuses.mjs` | T03 |
| fuse 校验 | `scripts/ci/check-fuses.mjs`（`npm run check:fuses`） | 用 `@electron/fuses` 读打包产物的实际 fuse，与 `apps/desktop/fuses.mjs` 的配置逐项比对，列出不一致与未配置的 fuse；T12、T50 的流水线调用它 | T03 |
| L4 夹具 | `apps/desktop/e2e/fixtures.ts`、`e2e/app.ts` | 每个用例独立启动应用与 user-data 目录、收集应用日志；两种形态的可执行文件按平台解析 | T03 |
| 事件合并器 | `piarc_core::events`（`EventSink`、`DeliveryDone`、`EventBatch`）；`CoreRuntime::start`、`spawn_supervised` | Core 发往客户端的事件一律经它：按路由键合并、每间隔最多一次投递、最多 1 个在途、超过上限对上游背压，不丢事件；任务 panic 转成 `core/errors` 上的错误事件 | T04 |
| NAPI 错误映射与 panic 边界 | `crates/piarc-napi/src/boundary.rs`（`call`、`js_error`） | 每个导出加 `#[napi(catch_unwind)]` 并把函数体放进 `boundary::call`：Core 错误与 panic 都变成带 `code`、`data.kind`、`data.retryable` 的 `Error`；Promise 用 `JsDeferred` 由 Core 运行时结算 | T04 |
| `.node` 构建与路径解析 | `scripts/dev/build-core.mjs`（`npm run build:core`）、`apps/desktop/core-binary.mjs`；运行时 `apps/desktop/src/main/core/native-path.ts`（`resolveCoreModulePath`）与 `load.ts` | 构建、打包、加载 Core 的唯一入口：文件名按 `@napi-rs/cli --platform` 规则，开发构建在 `target/piarc-core/<flavor>/`，打包后从 `app.asar.unpacked/native/` 加载 | T04 |
| 主进程事件路由 | `apps/desktop/src/main/core/router.ts`（`EventRouter`）、`event-ipc.ts` | 路由键 → 窗口表，每窗口一个 `MessageChannelMain`，只按路由键转发；T14 的会话事件、T10 的终端帧走同一条通道 | T04 |
| Core 加载检查与基准 | `scripts/ci/load-core.mjs`（`core-load-check.mjs`）、`scripts/bench/s2-event-channel.mjs`（`npm run bench:s2`） | 在 Node 与 Electron 中加载指定 `.node` 跑一次事件通道；S2 基准测吞吐、事件循环延迟、同步调用、大批次与空闲内存，输出 JSON 与摘要 | T04 |
| mock provider（库与独立进程） | `piarc_testkit::{MockProvider, ScenarioLibrary, Scenario, Script}`；bin `piarc-mock-provider`；TS 侧 `packages/testkit/src/mock-provider.ts`（`buildMockProvider`、`startMockProvider`） | 模拟 Anthropic Messages 与 OpenAI 兼容 Chat Completions 两种流式线格式，按场景脚本逐步应答，可注入 429/529/500/503 与断流；只绑定 `127.0.0.1`；脚本格式见 `testing.md` 第 10 节 | T05 |
| 请求校验器 | `piarc_testkit::{parse_request, validate, Rule, Violation}` | 把两种线格式的请求体解析成中立的 `Request`，按六条规则（配对、角色顺序、工具 schema、system 必要段落、缓存断点数量与位置）给出带规则 ID 与位置的违规；可单独用于断言任意请求体 | T05 |
| 请求记录查询 | `MockProvider::records()`、`RequestLog::snapshot()`；HTTP `GET /_piarc/requests` | 按到达顺序记录原始请求体、线格式、场景选择器、步序号、校验结果与结果类型，凭据头脱敏 | T05 |
| 进程启动与时钟端口 | `piarc_ports::{ProcessSpawner, SpawnSpec, SpawnedProcess, ProcessControl, Clock}`；实现 `piarc_exec::TokioProcessSpawner`、`piarc_core::agent_host::SystemClock` | 功能 crate 启动进程、按时间做决定都经这两个 trait；测试注入内存实现（例如只在 sleep 时前进的时钟）。当前启动器只终止直接子进程（I17） | T06 |
| Agent Host 监管器 | `piarc_core::agent_host::start`（`piarc_host::HostSupervisor`、`HostEvents`、`HostConfig`） | 启动 Agent Host、握手、背压、心跳、退避重启、会话恢复、调用对账；Agent Host 的请求经注入的 `InboundHandler` 回答。T14 的会话层在它之上编排 | T06 |
| 脚本化的假 Agent Host | `crates/piarc-host/tests/support`（`FakeSpawner`、`FakeHost`、`TestClock`、`until`） | 内存管道上的确定性故障注入：半帧、非法 JSON、超长帧、崩溃、停读；新增 AHP 行为的监管测试优先用它 | T06 |
| Agent Host 端到端夹具 | `crates/piarc-testkit/tests/agent_host/harness.rs`（`Env`、`Recorder`、`bundle()`） | 打包并启动真实 Agent Host、临时工作区、mock 模型配置、事件记录与 `seq` 断言；T07、T14 的会话场景复用 | T06 |
| Agent Host 出站与 Core 桥接 | `agent-host/src/protocol/outbound.ts`（`OutboundQueue`）、`agent-host/src/runtime/core-bridge.ts`（`CoreBridge`） | Agent Host 写 stdout 只经出站队列（背压、增量合并、写出时分配 `seq`）；向 Core 发请求只经桥接（统一超时、失败即拒绝） | T06 |
| stdio MCP 测试夹具 | `packages/testkit/src/mcp-echo-server.ts` | 一个 `echo` 工具，结果带 server 名、工作目录与 pid，用来证明 MCP 调用到了哪个实例 | T06 |
