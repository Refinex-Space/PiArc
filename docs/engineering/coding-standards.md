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

- `unsafe` 只允许出现在 `-sys` crate（`piarc-ghostty-sys`）、NAPI 边界（`piarc-napi`）与系统接口的 safe 封装模块（`piarc-term` 的 `vt` 模块，T10，与 Windows 专用的 `console` 模块，W0；`piarc-exec` 的 `job` 模块，Windows Job Object，T11）。workspace lints 对 `unsafe_code` 设为 deny；前两个 crate 在 crate 根写 `#![allow(unsafe_code, reason = "...")]` 放开，safe 封装只在模块声明上放开（`#[allow(unsafe_code, reason = "...")] mod vt;`），crate 的其余部分仍然禁止。
- 按输出类型读值的 FFI 辅助函数（传入数据键与输出指针）写成 `unsafe fn`，在 `# Safety` 中写明"类型必须与数据键对应"，调用处的 `// SAFETY:` 写出具体的对应关系。
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

所有工作区继承 `tsconfig.base.json`：`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`、`verbatimModuleSyntax`，`module` 与 `moduleResolution` 为 `NodeNext`。工作区不得放宽这些选项。根 `tsconfig.json` 是 solution 文件，`tsc --build` 构建全部工作区与 `scripts/`（verify 第 2 步，先于 ESLint：类型感知检查经 `dist/` 的声明读取工作区包）。

### 3.2 类型安全

- 禁止 `any`（`@typescript-eslint/no-explicit-any`）。类型确实未知时用 `unknown`，再用类型守卫收窄。
- 来自系统边界的数据（AHP、IPC、NAPI、文件、网络、`JSON.parse`）一律先当作 `unknown`，校验后才使用；不用 `as` 把未校验的数据断言成目标类型。
- 不用非空断言 `!`；用显式判断或抛出带说明的错误。
- 只导入类型时用 `import type`（`consistent-type-imports`）。

### 3.3 模块与边界

- 只用 ESM（`"type": "module"`）；相对导入写 `.js` 扩展名（NodeNext 要求）。
- 每个工作区经 `src/index.ts` 暴露公开 API；跨工作区只按包名导入（例如 `@piarc/protocol`），不导入另一个工作区的内部文件。
- 进程边界（ADR-0013）：
  - 渲染进程不导入 Node 内置模块、Electron、主进程代码或原生模块，只能调用 preload 暴露的白名单 API；preload 不导入 Node 内置模块（沙箱中的 preload 只能 `require("electron")`，其余依赖由打包工具内联）；`new BrowserWindow` 只在窗口工厂、`ipcMain.handle` 只在 IPC 注册函数中出现（`eslint.config.mjs` 的 `desktopProcessBoundaries`，verify 第 3 步）；
  - 主进程只做平台集成与转发，不承载业务逻辑；两个平台都需要的逻辑放进 Core 或 Agent Host。
- `packages/protocol/src/generated/` 由 `piarc-protocol` 的 JSON Schema 生成，不手工编辑（T02）。

### 3.4 Pi 依赖

- `@earendil-works/*` 全部锁定同一精确版本（架构第 5.7 节）。
- 只使用包入口公开导出的 SDK、ExtensionAPI 与类型，以及包的 `package.json` `exports` 声明的子路径（例如 `@earendil-works/pi-ai/api/anthropic-messages.lazy`），禁止其他深度导入（例如 `@earendil-works/pi-ai/dist/...`）。`eslint.config.mjs` 的 `piPublicImports` 按已安装包的 `exports` 生成放行清单，以 `@typescript-eslint/no-restricted-imports` 检查（verify 第 2 步）。

### 3.5 lint

- ESLint 使用 typescript-eslint 的 `strictTypeChecked` 与 `stylisticTypeChecked`，对全部 TS 与 JS 文件做类型感知检查（verify 第 3 步）；`eslint-config-prettier` 关闭与 Prettier 冲突的规则。
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
| 统一检查入口 | `scripts/dev/verify.mjs`（`npm run verify`） | 按顺序运行 15 个检查步骤，失败后继续，最后打印汇总表；新增检查在 `STEPS` 中追加 | T01 |
| crate 依赖方向检查 | `scripts/ci/check-crate-deps.mjs` + `crates/deps-rules.json` | 读取 `cargo metadata`，按层与例外校验 workspace crate 之间的依赖 | T01 |
| 验收清单一致性检查 | `scripts/plan/check-acceptance.mjs` | 比对任务文件中的 `- [Txx-Ayy]` 验收项与 `docs/plan/acceptance.json` | T01 |
| 仓库内工具安装 | `scripts/dev/install-tools.mjs` | 把锁定版本的工具（cargo-deny、ripgrep、fd、bindgen-cli）装进 `.tools/`，不做全局安装；`localToolPath()` 给出可执行文件路径 | T01 |
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
| 事件合并器 | `piarc_core::events`（`EventSink`、`DeliveryDone`、`EventBatch`）；`CoreRuntime::start`（内部的 `spawn_supervised` 是私有函数，Core 内新任务经它启动） | Core 发往客户端的事件一律经它：按路由键合并、每间隔最多一次投递、最多 1 个在途、超过上限对上游背压，不丢事件；任务 panic 转成 `core/errors` 上的错误事件 | T04 |
| NAPI 错误映射与 panic 边界 | `crates/piarc-napi/src/boundary.rs`（`call`、`js_error`） | 每个导出加 `#[napi(catch_unwind)]` 并把函数体放进 `boundary::call`：Core 错误与 panic 都变成带 `code`、`data.kind`、`data.retryable` 的 `Error`；Promise 用 `JsDeferred` 由 Core 运行时结算 | T04 |
| `.node` 构建与路径解析 | `scripts/dev/build-core.mjs`（`npm run build:core`）、`apps/desktop/core-binary.mjs`；运行时 `apps/desktop/src/main/core/native-path.ts`（`resolveCoreModulePath`）与 `load.ts` | 构建、打包、加载 Core 的唯一入口：文件名按 `@napi-rs/cli --platform` 规则，开发构建在 `target/piarc-core/<flavor>/`，打包后从 `app.asar.unpacked/native/` 加载 | T04 |
| 主进程事件路由 | `apps/desktop/src/main/core/router.ts`（`EventRouter`）、`event-ipc.ts` | 路由键 → 窗口表，每窗口一个 `MessageChannelMain`，只按路由键转发；T14 的会话事件、T10 的终端帧走同一条通道 | T04 |
| Core 加载检查与基准 | `scripts/ci/load-core.mjs`（`core-load-check.mjs`）、`scripts/bench/s2-event-channel.mjs`（`npm run bench:s2`） | 在 Node 与 Electron 中加载指定 `.node` 跑一次事件通道；S2 基准测吞吐、事件循环延迟、同步调用、大批次与空闲内存，输出 JSON 与摘要 | T04 |
| mock provider（库与独立进程） | `piarc_testkit::{MockProvider, ScenarioLibrary, Scenario, Script}`；bin `piarc-mock-provider`；TS 侧 `packages/testkit/src/mock-provider.ts`（`buildMockProvider`、`startMockProvider`） | 模拟 Anthropic Messages 与 OpenAI 兼容 Chat Completions 两种流式线格式，按场景脚本逐步应答，可注入 429/529/500/503 与断流；只绑定 `127.0.0.1`；脚本格式见 `testing.md` 第 10 节 | T05 |
| 请求校验器 | `piarc_testkit::{parse_request, validate, Rule, Violation}` | 把两种线格式的请求体解析成中立的 `Request`，按六条规则（配对、角色顺序、工具 schema、system 必要段落、缓存断点数量与位置）给出带规则 ID 与位置的违规；可单独用于断言任意请求体 | T05 |
| 请求记录查询 | `MockProvider::records()`、`RequestLog::snapshot()`；HTTP `GET /_piarc/requests` | 按到达顺序记录原始请求体、线格式、场景选择器、步序号、校验结果与结果类型，凭据头脱敏 | T05 |
| 进程启动与时钟端口 | `piarc_ports::{ProcessSpawner, SpawnSpec, SpawnedProcess, ProcessControl, Clock}`；实现 `piarc_exec::TokioProcessSpawner`、`piarc_core::agent_host::SystemClock` | 功能 crate 启动进程、按时间做决定都经这两个 trait；测试注入内存实现（例如只在 sleep 时前进的时钟）。`TokioProcessSpawner` 只终止直接子进程，要终止整棵进程树用下面的 `ProcessTreeSpawner` | T06 |
| Agent Host 监管器 | `piarc_core::agent_host::start`（`piarc_host::HostSupervisor`、`HostEvents`、`HostConfig`） | 启动 Agent Host、握手、背压、心跳、退避重启、会话恢复、调用对账；Agent Host 的请求经注入的 `InboundHandler` 回答。T14 的会话层在它之上编排 | T06 |
| 脚本化的假 Agent Host | `crates/piarc-host/tests/support`（`FakeSpawner`、`FakeHost`、`TestClock`、`until`） | 内存管道上的确定性故障注入：半帧、非法 JSON、超长帧、崩溃、停读；新增 AHP 行为的监管测试优先用它 | T06 |
| Agent Host 端到端夹具 | `crates/piarc-testkit/tests/agent_host/harness.rs`（`Env`、`Recorder`、`bundle()`） | 打包并启动真实 Agent Host、临时工作区、mock 模型配置、事件记录与 `seq` 断言；T07、T14 的会话场景复用 | T06 |
| Agent Host 出站与 Core 桥接 | `agent-host/src/protocol/outbound.ts`（`OutboundQueue`）、`agent-host/src/runtime/core-bridge.ts`（`CoreBridge`） | Agent Host 写 stdout 只经出站队列（背压、增量合并、写出时分配 `seq`）；向 Core 发请求只经桥接（统一超时、失败即拒绝） | T06 |
| stdio MCP 测试夹具 | `packages/testkit/src/mcp-echo-server.ts` | 一个 `echo` 工具，结果带 server 名、工作目录与 pid，用来证明 MCP 调用到了哪个实例 | T06 |
| 路径限定检查 | `piarc_fs::Scope`（`resolve`、`display`） | 会话的工作区根与 cwd；请求路径接到 cwd、按词法去掉 `.`/`..`、解析符号链接（含悬空链接）后必须在根内，否则 `OutsideWorkspace` 且不触碰目标；结果路径去掉 `\\?\` 前缀。所有按路径操作文件的 Core 代码先经它 | T07 |
| 委托的工具 I/O | Core：`piarc_core::tool_io::ToolIo`（`open_session`、`dispatch`，实现 `InboundHandler`）；Agent Host：`agent-host/src/tools/core-io.ts`（`CoreIo`、`ExecOutputRouter`、`asFileError`） | Agent Host 的文件与命令 I/O 只经它们：`fs/*`、`exec/*` 的类型化请求、结果校验、Node 风格错误重建、`exec/output` 路由；新工具的 I/O 在这里加方法 | T07 |
| 命令执行 | `piarc_exec::CommandRunner`（`CommandSpec`、`OutputChunk`、`CommandExit`） | 程序加参数（shell 由 `piarc_exec::shells` 给出）、stdout/stderr 流式读取（有界通道背压）、退出后的静默宽限、超时与取消的两段终止（`terminate` → 宽限 → `kill`）；进程经注入的 `ProcessSpawner` 启动，命令一律用 `ProcessTreeSpawner`（T17） | T07 |
| 入站请求的通知回传 | `piarc_host::Peer`（`notify`、`closed`） | 入站处理者在回复前向 Agent Host 发通知，与响应同序；连接结束可感知 | T07 |
| UTF-8 分段 | `piarc_protocol::text::incomplete_utf8_suffix` | 分段传输文本时不切断 UTF-8 序列（`fs/read` 的范围、`exec/output` 的流） | T07 |
| 系统凭据库端口 | `piarc_ports::{SecretStore, SecretName, SecretStoreError}`；实现 `piarc_secrets::SystemSecretStore`（keyring-core），替身 `piarc_secrets::MemorySecretStore`（`fail_with` 注入拒绝、锁定、失败） | 系统凭据库只经这个窄 trait 访问，调用会阻塞（可能弹授权），异步代码放到阻塞线程池；测试条目一律用 `test_master_key_name`（`piarc-test.` 前缀） | T08 |
| 凭据保险箱读写 | Core：`piarc_secrets::Vault`（`open`、`get`、`entries`、`set`、`delete`）、`piarc_core::secrets::SecretsService`（`secrets/*`、锁、`secrets/changed` 推送）；Agent Host：`agent-host/src/runtime/credentials.ts`（`CoreCredentialStore`） | 凭据只经它们读写：密文落盘、明文清零、结构化错误（ADR-0021）；Agent Host 里需要凭据的代码经 `ModelRuntime`，不直接调 `secrets/*` | T08 |
| 原子写入 | `piarc_secrets::atomic::{replace, remove_leftovers}` | 同目录临时文件（0600）、`fsync`、rename 覆盖；任一步失败时原文件不变、临时文件删除；打开时清掉崩溃遗留的临时文件 | T08 |
| 应用标识 | `piarc_core::identity::{APP_IDENTIFIER, master_key_name}` | 应用标识的唯一定义（D2：`cn.piarc.desktop`）；凭据库服务名、以后的 bundle id 与 AppUserModelID 都从这里取 | T08 |
| 无明文扫描 | `piarc_testkit::plaintext::{scan, contains}` | 在目录树中逐字节搜索测试埋下的秘密值，可只看某时刻后修改的文件；不跟随符号链接，读不了的文件单独列出；配一个对照文件证明扫描有效 | T08 |
| 输入法守卫 | `apps/desktop/src/renderer/composer/ime-guard.ts`（`isImeComposing`） | 渲染进程里所有键盘处理先调用它：`isComposing`、`keyCode === 229` 或编辑器处于合成中时一律不触发业务；ProseMirror 编辑器在 `handleDOMEvents.keydown` 里调用，让按键整个交给输入法；`@`、`/` 等文本触发同样先查合成状态（架构第 8.5 节） | T09 |
| 滚动跟随判定 | `apps/desktop/src/renderer/transcript/scroll-follow.ts`（`ScrollFollow`）、`use-scroll-follow.ts`（`useScrollFollow`、`pinToBottom`）；阈值在 `transcript/constants.ts` 的 `SCROLL_FOLLOW` | 不访问 DOM 的状态机：只有用户输入（滚轮、触摸、键盘、按住滚动条）后的滚动能解除或恢复跟随，内容增长时由它决定是否贴底、是否显示"回到底部"；后台任务、终端输出等需要贴底的长列表复用它 | T09 |
| 增量 Markdown 解析 | `apps/desktop/src/renderer/transcript/markdown/incremental.ts`（`IncrementalMarkdown`、`parseMarkdown`）、`autoclose.ts`、`to-ir.ts`、`text.ts`（`safeHref`、`decodeCharacterReferences`）；Worker 与客户端：`renderer/workers/markdown.worker.ts`、`markdown/markdown-client.ts`；渲染：`MarkdownView.tsx` | 只重新词法分析不稳定的尾部，流式中闭合未完成的标记，结束时与一次性解析相同；输出块与 span 的中间结构（`ir.ts`），由 React 渲染，原始 HTML 当文本、链接只放行 `https:`/`http:`/`mailto:`。任何渲染模型输出或仓库 Markdown 的界面都经它 | T09 |
| XSS 载荷集 | `apps/desktop/src/shared/xss-payloads.ts`（`XSS_PAYLOADS`、`xssMessage`、`FORBIDDEN_TAGS`、哨兵 `__piarcXssSentinel`） | `<script>`、内联事件属性、`javascript:` 链接（含字符引用编码）、带脚本的 SVG、`<iframe>`、`<style>`、`<object>`/`<embed>`、`<meta>` 刷新、远程与 `data:` 图片、`<form>`；新的渲染不可信内容的界面（diff、工具输出、MCP 结果）用它写安全用例（参照 `e2e/transcript-security.e2e.ts`） | T09 |
| 代码高亮 | `apps/desktop/src/renderer/workers/highlight.worker.ts`、`transcript/highlight/`（`HighlightClient`、`languages.ts`、`CodeBlock.tsx`） | shiki 在 Worker 中用 JavaScript 正则引擎产出结构化 token（不需要放宽 CSP），语法按需加载；结果缓存，超过 `HIGHLIGHT_MAX_CHARS` 的代码不高亮。diff 与文件预览的高亮复用它 | T09 |
| 渲染性能测量 | `scripts/bench/s1-transcript.mjs`（`npm run bench:s1`，`analyzeTrace`、`summarizeFrames`） | 经 CDP 追踪渲染进程：每帧主线程工作量、超过 50 ms 的任务、合成器帧状态；页面的 rAF 间隔与帧率；冷加载与 `app.getAppMetrics()` 内存。T44 的性能预算进 CI 复用 | T09 |
| 终端帧编解码器 | Rust：`piarc_protocol::term_frame::{encode, decode, Screen}`；TS：`apps/desktop/src/renderer/terminal/frame/`（`decodeFrame`、`Screen`） | 草案格式（T33 定稿）的唯一实现：Core 编码、渲染进程解码与重建屏幕；两份实现跑同一组共享样本 `frame-samples.json`（由 `piarc-term` 的一致性测试生成并检查） | T10 |
| 终端会话 | `piarc_term::{Session, SessionConfig, Event}`、`piarc_term::frame::FrameEncoder`；Core 注册表 `piarc_core::terminal`（`CoreRuntime::create_terminal` 等） | PTY + libghostty-vt + IO/写线程 + effects + 按 viewer 的增量帧；读屏用 `Session::viewport_text`（formatter）。T33 的无头终端、T32 的终端承载任务在它之上扩展 | T10 |
| 浏览器按键到终端输入 | 渲染进程 `terminal/keys.ts`（`keyMessage`）；Core `piarc_term::keymap::{key_for_code, key_input}` | 按键事件原样（`code`、字素文本、修饰键）交给 Core，由 libghostty-vt 按终端模式编码；W3C `code` → `GhosttyKey` 映射表 | T10 |
| 预编译产物下载与校验 | `crates/piarc-ghostty-sys/build.rs` + `build/artifact.rs`（`Lock`、`verify`、`sha256_hex`）；锁定文件 `ghostty-vt.lock.json`；脚本侧定位产物 `scripts/lib/ghostty-vt.mjs`（`ghosttyArtifact`） | 锁定文件集中 URL、版本、SHA-256 与公钥；缓存 + 离线开关；SHA-256 与 minisign 任一不符即构建失败并说明。新的预编译二进制按同样方式接入 | T10 |
| minisign 校验 | workspace 依赖 `minisign-verify`（0.3.0，零依赖）；用法 `piarc-ghostty-sys/build/artifact.rs` 的 `verify_minisign` | 只接受预哈希（`ED`）签名，校验受信注释；单元测试用官方真实签名做篡改用例。T12、T50 校验发布清单签名时复用 | T10 |
| 第三方许可证来源登记 | `third-party/sources.json`、`third-party/licenses/` | 不经包管理器进入产物的代码与二进制（预编译库、vendor 的源码）在这里登记版本、来源与许可证文本；T50 生成 `THIRD_PARTY_NOTICES` 时读取 | T10 |
| 终端渲染器（Canvas） | `apps/desktop/src/renderer/terminal/vendor/ghostty-web/renderer.ts`（fork，来源与改动见同目录 README）、`remote-renderable.ts`、`controller.ts`（`TerminalController`） | 帧驱动的 Canvas 绘制、按 rAF 拉取与隐藏不拉取、输入后连续拉取、隐藏 textarea 跟随光标与预编辑绘制；T34 的终端面板从这里开始 | T10 |
| 终端性能测量 | `scripts/bench/s7-terminal.mjs`（`npm run bench:s7`，`writeLogFile`）；页面计数 `__piarcTerminalLab.stats()`；Core 计数 `terminalStats` | `cat` 大文件期间的主进程事件循环、渲染追踪、帧与 IPC 字节、Core 解析与编码耗时；键入回显的配对测量（Core 直写 PTY 的基线 `terminalProbeEcho`）。T44 复用 | T10 |
| 工具名映射 | `agent-host/src/tools/profile.ts`（`ToolNameMap`、`DEFAULT_PROFILE`、`profileWithOverrides`） | 模型可见名 ↔ 规范名双向查询；规则、hooks、事件、Core 一律用规范名，按模型家族调整的 Profile 在这里扩展 | T07 |
| 第三方二进制下载与校验 | `third-party/binaries.lock.json` + `scripts/dev/fetch-binaries.mjs`（`fetchArtefact`、`stageAgentHostRuntime`、`readLock`） | 版本、URL、大小、SHA-256 集中在锁定文件；下载进 `.tools/cache/binaries/`，每次使用都重新校验，不符即失败并删除；node、rg、fd 解包成 Agent Host 运行时（只留 node、npm、npx 与许可证）。新的随包或构建用二进制先登记到锁定文件，许可证登记到 `third-party/sources.json` | T12 |
| 发布清单生成与校验 | 生成：`scripts/release/release-manifest.mjs`（`buildManifest`、`signData`、`verifyData`、`generateKeyPair`）；校验：`piarc_core::release`（`verify_manifest`、`verify_file`、`TrustedKeys`） | 清单格式 `piarc-release-manifest/1`，minisign 预哈希签名（ADR-0024）；Core 先验签后解析、再逐个校验产物，失败为 `releaseIntegrity` 结构化错误；测试密钥在 `scripts/release/test-keys/`，内置公钥只在 `BUILTIN_RELEASE_KEYS` | T12 |
| 打包产物布局与签名检查 | `scripts/ci/check-app-layout.mjs`（`checkAppLayout`、`parseCodesignDisplay`）；布局定义 `apps/desktop/packaging/agent-host-layout.mjs`（`agentHostLayout`） | `Resources/agent-host/` 的文件都在 asar 外、asar 里没有它们；macOS 上 `codesign --verify --deep --strict`、hardened runtime 与 entitlements、node 保留 Node.js Foundation 签名、rg/fd/`.node` 为 ad-hoc；T50 的发布流水线复用 | T12 |
| macOS 分层签名 | `apps/desktop/packaging/macos-sign.mjs`（`resealElectron`、`signResourcesAndBundle`、`signBundle`、`findMachOFiles`） | 写入 fuses 后的 ad-hoc 重签：Electron 整体、Resources 中的 Mach-O 逐个（跳过保留原签名的目录）、bundle 最后且不带 `--deep`；hardened runtime 用 `entitlements.mac.plist` | T12 |
| 在 Pi 工具代码上换掉路径 | `agent-host/src/tools/stand-in.ts`（`StandIn`、`serialized`） | 让 Pi 的工具定义在替身路径上运行、Operations 指向真实路径、结果换回原路径；同一文件的写入串行（ADR-0020） | T07 |
| 行为对照与 I/O spy | `crates/piarc-testkit/tests/agent_host/parity.rs`；`harness.rs` 的 `with_io_spy`、`spy_report`、`offered_tools`、`tool_results_in`、`Core::calls_of`；`packages/testkit/src/io-spy.ts` | 同一脚本对比 Pi 原生工具与委托工具（结果与工作区快照，预期差异登记原因）；证明 Agent Host 不绕过 Core；读取 mock 请求中的工具列表与工具结果（含图片块） | T07 |
| 进程树启动器（进程组 / Job Object） | `piarc_exec::ProcessTreeSpawner`（`ProcessSpawner` 的实现）；Windows 封装 `piarc-exec/src/job.rs` | macOS 新进程组、`killpg(SIGKILL)`；Windows 挂起创建、加入 `KILL_ON_JOB_CLOSE` 且不许 breakaway 的 Job 后再恢复。`kill` 与丢弃句柄都结束整棵树。沙箱命令已用它；T12 启动 Agent Host、T17 的通用命令执行改用它 | T11 |
| 命令包装 | `piarc_exec::{CommandSpec::launcher, Launcher}` | 以包装程序启动 shell（`program args… <shell> -c <命令>`），沙箱与以后其他包装（例如 Windows 隔离方案）都经它，不另写命令执行 | T11 |
| Seatbelt 配置生成 | `piarc_sandbox::{SandboxPolicy, ResolvedPolicy, PROTECTED_PATHS, SessionSandbox, CommandSandbox, platform_sandbox}`；macOS `piarc_sandbox::seatbelt::SeatbeltProfile` | 路径规范化（解析符号链接）、每条命令一份配置、路径经 `-D` 参数传入、受保护路径正则；快照 `crates/piarc-sandbox/tests/snapshots/seatbelt-profile.sbpl`。T12、T39 的 Agent Host 配置复用生成方式 | T11 |
| 沙箱网络代理 | `piarc_sandbox::proxy::{NetworkProxy, Allowlist, Network, SystemNetwork, blocked_reason, DENIED_HEADER}`；环境 `piarc_sandbox::sandbox_env` | 本机 HTTP/`CONNECT` 代理、域名白名单、回环与云元数据拒绝；`Network` 可注入，测试用本机上游（`crates/piarc-sandbox/tests/proxy.rs`）。WebFetch 等需要出站白名单的地方复用白名单与地址检查 | T11 |
| 沙箱会话 | `piarc_core::tool_io::{ToolIo::open_sandboxed_session, SandboxSettings}` | 会话临时目录、会话的代理、`exec/run` 自动包装与进程树终止；T39 的 Bash 沙箱模式在它之上接入 | T11 |
| 配置层级与合并 | `piarc_config::{LayerTable, LayerSpec, Settings, write_value}`、`layers::precedence`、`schema::Shape`；Core 侧 `piarc_core::workspace_settings`（`CoreRuntime::open_settings`） | 来源 + 优先级的有序表，加层不改合并代码；标量覆盖、对象深合并、列表去重；校验带文件、JSON Pointer 与原因，无效文件跳过、重载保留上一份有效内容；只写 `.piarc/` 与用户文件（临时文件 + rename）；Core 监听文件并在 `core/settings` 发变化键。T24 的 `.claude/` 层、会话层、企业层都插到这张表里 | T13 |
| 信任查询 | `piarc_config::project_trust`（`TrustLookup`）；Core `piarc_core::trust::TrustService`（`trust_get`、`view`、`decide`、`revoke`、`subscribe`）；主 checkout `piarc_git::resolve`；Agent Host `agent-host/src/harness/project-trust.ts`（`askCoreTrust`、`takeOverProjectTrust`） | 项目级 hooks、MCP、allow 规则、插件、Pi 扩展的唯一信任判断，任何失败都是不信任；按主 checkout 共享；`executables::enumerate` 与 `new_items` 给出可执行项与新增项；信任变化经 `restart_on_trust_change` 重启工作区的 Agent Host | T13 |
| 审批账本 | `piarc_policy::Ledger`、Core `tool_io::policy` | Core 原子认领、取消与推送审批实体。客户端从最新的会话快照取卡片 | T20 |
| 审批卡和快捷键 | `SessionTranscript.setApprovals`、transcript 行的 `ApprovalCard`，`approval-keys.ts` 的 `approvalKey`、`canAnswerByKey`、`canAlwaysAllow` | 新卡等待、首张可见、输入法与阅读状态都用同一套门控 | T20 |
| JSONL 流式解析 | `piarc_store::jsonl::{LineReader, Parsed}`；Pi 会话元数据 `piarc_store::pi_session::SessionMeta`；索引 `Store::{sync_file, sync_dir, rebuild_index}` | 从字节偏移逐行读，未写完的末行不消费、下次从行首继续；1 MiB 以上的行流式解析不整行缓存；坏行单独报告。读 Pi 会话或其他追加写的 JSONL 都用它 | T13 |
| 数据目录 | 主进程 `apps/desktop/src/main/platform/data-dirs.ts`（`resolveDataDirs`、`applyDataDirs`）；Core `piarc_core::DataDirs`（`create_layout`、`pi_sessions`、`logs` 等） | 两个平台的数据与缓存目录、`--user-data-dir` 覆盖、`ready` 前 `setPath`；Core 内按第 9.1 节取子目录，不在别处拼路径 | T13 |
| 日志文件 | `piarc_telemetry::{install, DailyLog, Calendar}` | 按 UTC 天轮转、保留 7 天、Core 与 Agent Host 分文件；时钟可注入 | T13 |
| SQLite 迁移 | `piarc_store::migrate::{MIGRATIONS, Migration, apply}` | 按版本号顺序、每个迁移一个事务并记录在 `schema_migrations`；新表新字段只追加迁移，写法见 `crates/piarc-store/AGENTS.md` | T13 |
| 目录监听 | `piarc_fs::watch::Watcher` | notify 封装，非递归监听目录，回调给出路径；调用方去抖并重读 | T13 |
| L2 场景运行器 | `piarc_testkit::l2`（`load`、`run`、`run_suite`、`RunnerConfig::build`）；`cargo test -p piarc-testkit --test scenarios`；`piarc-devcli run` | 加载并校验场景文件（`tests/scenarios/schema.json`），在含空格与中文的临时根中驱动 Core 无头运行时 + 真实 Agent Host + 每个端点一个严格 mock，断言事件、文件、请求、工具批次与 Core I/O，输出可读差异与 JSON 报告；新增 Harness 行为写一个场景，见 `testing.md` 第 12 节 | T15 |
| 事件部分匹配断言 | `piarc_testkit::l2::matcher`（`is_subset`、`subset_mismatch`、`check_events`） | 字段子集匹配（对象按键子集、数组逐元素同长度、标量相等）与按会话的有序子序列（含 `any_order` 组）；失败时给出第一个未匹配的期望、乱序位置与附近的实际事件 | T15 |
| 能力覆盖检查 | `scripts/plan/check-capabilities.mjs`、`scripts/lib/capabilities.mjs`；verify 第 14 步（`scripts/ci/run-l2.mjs`） | `tests/capabilities.yaml` 与需求、架构、看板对照；按 L2 报告报 MISSING 与未登记的能力 ID；`--milestone Mx` 列出未完成能力；生成并比对 `docs/product/capabilities.md`；见 `testing.md` 第 13 节 | T15 |
| 路径规范化与访问检查 | `piarc_fs::Scope`（`check`、`resolve`、`locate`、`key`、`label`、`with_added_dir`、`with_read_only_dir`）、`piarc_fs::access`（受保护路径） | 相对路径、`..`、符号链接（含悬空）、`\\?\` 前缀与大小写不敏感的卷：文件 I/O 使用 `Scope::bind` 的目录句柄，审批跨步骤绑定 `DirectoryBinding`（ADR-0036），越界与受保护路径给出 `NeedsApproval`；文件身份比较用 `key`，diff 与消息里的路径用 `label`/`display`。规则见 `crates/piarc-fs/CLAUDE.md` | T16 |
| 保真写入与文件状态 | `piarc_fs::{write, WriteSpec, check_fresh, stat_for_read, FileStates, PathLocks}`、`piarc_fs::encoding`；底层原子替换 `atomic::replace`（crate 内） | 替换已存在的文件：先读后改与外部修改检查、编码与 BOM 保持、按需换成文件的换行风格、同目录临时文件 + rename、失败不留半个文件；编码检测与按范围解码也在这里。Core 以外的写入（例如配置）若要同样的保证，复用这里而不是再写一份 | T16 |
| 结构化 diff | `piarc_diff::file_diff` → `piarc_protocol::diff::FileDiff` | unified 文本与 hunk 同源，超限降级；Changes 面板、审批卡、快照回退都用这份结构 | T16 |
| 工具结果截断与落盘 | Agent Host `agent-host/src/harness/tool-results.ts`（`createToolResultBudget`、`TOOL_RESULT_LIMITS`、`headAndTail`）；Core `fs/spill`（`piarc_fs::spill`、`model_path`） | 单个结果超过 50K 字符落盘、模型收到头尾预览与 `~` 开头的路径；单条消息合计 200K 从最大的开始换成预览且决定可复现；Bash 的输出落盘（T17）、后台任务输出复用同一个落盘位置与路径写法 | T16 |
| 进程树终止 | `piarc_ports::ProcessControl::terminate`（默认即 `kill`）；`piarc_exec::ProcessTreeSpawner`（Unix 进程组 `SIGTERM`/`SIGKILL`，Windows Job）；`CommandRunner` 的超时与取消 | 结束一条命令及其全部子孙进程：先 `terminate`，`kill_grace` 后 `kill`，丢弃句柄结束留在后台的进程；测试用 PID 确认孙进程退出（`piarc-exec/src/termination_tests.rs`） | T17 |
| 登录 shell 环境解析 | `piarc_exec::env::{login_shell_env, command_environment}`；Core `piarc_core::tool_io::CommandEnv` | 用户登录 shell（`-i -l -c` 打印 `env -0`，10 秒超时）的环境，按 ADR-0035 提取系统与工具链字段；Core 每次运行解析一次，仅缓存准入结果。要给子进程用户环境的地方都经它，不另读 shell 配置 | T17 |
| 语义退出码判定 | `piarc_exec::semantic::{interpret, EXIT_ONE_MEANINGS}` | 单个简单命令的退出码 1 是否为答案（`grep` 无匹配、`diff` 有差异、`test` 为假），管道与控制运算符只看退出码；T23 换成语法树判断 | T17 |
| 命令输出预算与落盘 | `piarc_exec::{ExecLimits, OutputCapture, CapturedOutput}`；落盘文件 `piarc_fs::create_spill` | 阈值（超时默认与上限、内联 30,000、预览 2,000、失败头尾、终止宽限）的唯一定义；内存有界，超出预算时全文流式写入会话临时目录 | T17 |
| shell 探测与调用 | `piarc_exec::shells::{detect, Probe, bash_invocation, powershell_args, msys_to_windows}`、`piarc_exec::CwdProbe` | bash / Git Bash / PowerShell 的查找顺序（测试可描述一台假机器）、两种 shell 的参数（bash 还有要加的环境变量）、Git Bash 路径转换、经 `BASH_ENV` 取 bash 命令的最终目录 | T17 |
| 渲染进程 store | `apps/desktop/src/renderer/store/`（`AppStore`、`SessionTranscript`、`StoreConnection`；React 绑定 `hooks.ts`；`status.ts` 的 `badgeOf`、`needsAttention`、`attentionCount`） | Core 事件的唯一归约处：实体快照按 `revision` 门控、未变化的条目保留对象身份；按列表、单个会话、单行订阅（`useSyncExternalStore`）；乐观回显按 `clientId` 对账；"需要处理"与徽标优先级的唯一定义 | T18 |
| 面板与设置页注册 | `apps/desktop/src/renderer/shell/registry.ts`（`registerPanel`，area 为 `rail` 或 `dock`）、`src/renderer/settings/registry.ts`（`registerSettingsPage`） | 右栏卡片、停靠面板、设置页都在所属任务里注册，容器负责布局、尺寸记忆与导航；没有注册内容的区域不显示 | T18 |
| 快捷键注册表 | `apps/desktop/src/shared/keybindings.ts`（`COMMANDS`、`effectiveBindings`、`commandForEvent`、`conflictFor`、`toAccelerator`、`displayKey`） | 命令 id → `Mod` 记法默认键；用户覆盖存于用户级设置；渲染进程按 `KeyboardEvent.code` 匹配，主进程菜单显示同一绑定；按平台换算物理按键判断冲突 | T18 |
| 本地化 | `apps/desktop/src/shared/i18n/`（`Translator`、`resolveLocale`；目录 `en.ts`、`zh-CN.ts`）；渲染进程 `useT()`，主进程 `AppShell.t()` | ICU MessageFormat（intl-messageformat，不用 eval）；英文目录定义消息 id，中文目录类型上必须覆盖全部 id；主进程菜单、原生对话框、通知与渲染进程共用 | T18 |
| 设计令牌 | `design/tokens/*.json` → `npm run gen:tokens`（`scripts/lib/design-tokens.mjs`）→ `src/renderer/theme/tokens.generated.css`、`src/shared/design-tokens.ts`（`COLORS`、`tokenVar`）；检查 `scripts/ci/check-design-tokens.mjs` | 四种颜色模式 × 两档密度；组件只读语义与组件令牌；对比度、品牌与资源检查在 verify 第 15 步 | T18 |
| 客户端偏好 | Core `piarc_core::client_settings`（NAPI `userSettings`、`writeClientSetting`）；主进程 `src/main/preferences.ts`（`PreferenceStore`）；共享 `src/shared/preferences.ts`（`preferencesFrom`、`pointerOf`） | 语言、外观、快捷键覆盖、通知写在用户级 `settings.json`，Core 是唯一写入方；改动推送到所有窗口 | T18 |
| Transcript 行组件分派 | `apps/desktop/src/renderer/store/transcript.ts`（`SessionTranscript`）与 `transcript/rows/RowView.tsx` | 在同一个 store 生成行或组 ID，在 `RowView` 按行类型、协议 item 类型分派。历史与实时共用各行组件、记忆化与行级错误边界，新行补一项组件测试 | T19 |
| 工作区模糊文件匹配 | `CoreRuntime.searchFiles(searchId, root, query, limit)`、`cancelFileSearch(searchId)`、`piarc_fs::fuzzy` | 检查搜索根所属工作区、按忽略规则列文件、对子序列匹配排序，返回相对路径和匹配位置。每个搜索框分配独立 ID，由 Core 取消已过期查询并限定结果数量 | T19 |
| 会话附件存储 | `CoreRuntime.storeAttachment(id, name, mimeType, bytes)`、`piarc_core::composer::attachments`、`piarc_protocol::input::InputAttachment` | UI 经 `composerInfo()` 取 MIME、数量和大小上限，Core 校验内容、以散列存入该会话的 `attachments/`，返回可用于 prompt、steer、follow-up 的引用 | T19 |
| 服务商设置与模型目录 | `piarc_core::sessions::provider_settings`、Agent Host 的 ModelRuntime | 设置变更、凭据更新和可用模型查询复用设置 Host，会话选型经会话 Host | T21 |
| Memory 发现与读取 | Core `tool_io::memory_reader::collect`、AHP `fs/memory` | 从会话范围、用户目录与已访问目录收集来源，处理单文件上限和外部导入决定 | T22 |
| Markdown 中的 `@path` | `memory_reader/markdown.rs` 的 `expand` 与 `Reader::document` | 统一处理代码边界、块注释、相对导入、深度和循环；Core 负责实际打开文件 | T22 |
| 会话上下文追加消息 | Agent Host `harness/session-memory.ts` 的 `SessionMemory` | 由分支记录和内容摘要决定追加内容，送达时保留既有 system 和工具结果；T27 接入统一提醒通道时复用 | T22 |
| 权限规则匹配 | `piarc_policy::rules`（`parse`、`RuleSet::{add_source, find, whole_tool, exact_allow, invalid_for, is_broad}`）、`pattern::Pattern`、`paths::{PathPattern, posix, escape}` | Claude Code 格式的规则：命令通配（含运行期值的确定/可能匹配）、gitignore 路径与四种锚点、WebFetch 域名、Agent/Skill 名称、MCP 与工具名通配；按来源顺序报告命中；无效的 deny/ask 规则让所点名工具的调用询问。新工具的权限匹配在这里加 specifier，不另写匹配 | T23 |
| Bash 命令分析 | `piarc_policy::bash`（`analyze`、`judge`、`classify`、`is_critical_delete`、`suggestions`） | tree-sitter-bash 拆子命令（含替换、控制结构、heredoc）、剥离包装与安全赋值、影子命令、只读白名单、关键路径删除、"总是允许"前缀；纯函数，路径与程序经 `Facts` 由调用方提供。要理解或判定 shell 命令时复用，不用正则或按空格拆分 | T23 |
| 权限裁决阶梯 | `piarc_policy::{decide, after_permission_request, starting_mode, Input}`；Core 侧 `tool_io::policy::assess` | 第 6.2.3 节的八步，企业策略与两个 hooks 插槽；新工具只需给出 `Input` 的事实（写、只读、越界、受保护、规则命中） | T23 |
| hooks 执行器 | `piarc_hooks::{HookConfig, Runner, Outcome, Decision, run}`；Core 侧 `piarc_core::hooks::HooksService`（`run`、`plan`/`execute`）与 `tool_io::hooks` | Claude Code 格式的 hooks：各设置层合并与跨文件去重、matcher、`command` handler 并行执行（stdin 输入、管道并发读完、按事件超时、取消时终止进程树）、退出码与 JSON 按事件合并、审计与 `core/notices` 提示；新事件在 `HookEvent` 加一项并在挂载处调用 `HooksService::run`，不另写执行器 | T25 |
| 上下文输出落盘 | `piarc_hooks::spill::{bound, cut, LIMIT, PREVIEW}` | 给模型或用户的长文本超过 10,000 字符时写入会话临时目录的文件，只送 2,000 字符预览与路径（写失败时说明）；`cut` 截断并加标记。工具结果的预算另见 `fs/spill`（T16） | T25 |
| 内容寻址存储 | `piarc_checkpoint::ObjectStore`（`put`、`get`、`pin`、`contains`、`collect_garbage`）、`hash_of`、`to_hex`/`from_hex` | 按 SHA-256 分桶存字节、相同内容一份、临时文件加 rename 写入、读时校验哈希；`Pin` 在使用期间防止回收，回收只删未引用且未钉住的对象。检查点快照用它，需要按内容去重保存文件的功能复用 | T28 |
| hunk 反向应用 | `piarc_diff::revert_hunks`（`RevertError`） | 对当前文本反向应用 `FileDiff` 的若干 hunk：逐行核对新侧、自下而上应用、恢复的行沿用相邻换行符；不符时报错不改文本。Changes 面板按 hunk 丢弃用它，不在别处重算 diff | T28 |
| 按期望内容写回文件 | `piarc_fs::{replace, Replacement, current_sha256, read_current}`（`restore.rs`） | 用户动作（回退、撤销、丢弃）写回记录的字节：路径锁内核对期望哈希、当前字节先存入对象库、原子替换或删除、会话文件状态表忘记该文件 | T28 |
| SSRF 检查 | `piarc_web::ssrf::{check, classify, Allowlist, Blocked}` | 纯函数：解析出的地址只要有一个属于回环、私有、链路本地、组播、未指定、广播或保留网段（含 IPv6、IPv4 映射、NAT64、6to4 形式）就拒绝整个主机，允许列表按主机名或 IP / CIDR 放行。凡是 Core 代 agent 发起的网络连接都先经它，并只连接它返回的地址（`piarc_web::Fetcher` 的做法） | T29 |
| 网页抓取与 URL 主机 | `piarc_web::{Fetcher, FetchLimits, Outcome, parse_target, rule_host}`、`convert::convert` | 钉住地址的 HTTP/1.1 + rustls 抓取、同站重定向、上限、HTML 转 Markdown；权限规则与 hooks matcher 取 URL 主机一律用 `rule_host`，与实际连接的主机一致 | T29 |
| 辅助模型调用 | `agent-host/src/harness/auxiliary.ts`（`AuxiliaryModel.complete`） | 一次不带工具与对话的模型调用：用设置的辅助模型（不可用时会话模型），经会话的流函数与重试设置，用量计入当前回合并写 `piarc.auxiliaryUsage`；WebFetch 的提取与之后的审查类调用都用它，不另建请求 | T29 |
| mock 授权服务器 | `piarc_testkit::auth_server::{MockAuthServer, AuthBehavior}`；bin `piarc-mock-auth` | OAuth 授权码（回环 redirect）与设备码（轮询）两种流程，可设同意、拒绝、过期；令牌每个实例随机，作明文扫描的针 | T29 |
