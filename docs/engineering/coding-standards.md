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
| Rust | rustfmt（`rustfmt.toml`：style edition 2024、LF） | verify 第 5 步 |
| Markdown | 不经 Prettier | — |

Markdown 不进 Prettier：文档中的宽表格每次编辑都会被重新填充空格，产生与内容无关的大段差异。排除清单见 `.prettierignore`。

编码与换行由 `.editorconfig` 和 `.gitattributes` 统一为 UTF-8、LF；需要保留 CRLF 的测试夹具见 `testing.md` 第 4 节。

### 1.4 依赖

- npm 依赖精确锁定，`package.json` 中不出现 `^`、`~`；`package-lock.json` 入库。安装用 `npm install --save-exact`。
- Cargo 依赖只在根 `Cargo.toml` 的 `[workspace.dependencies]` 中声明版本，crate 中一律写 `<name>.workspace = true`（或 `{ workspace = true, features = [...] }`）。`Cargo.lock` 入库，verify 以 `--locked` 运行。
- 新依赖的许可证必须在 `deny.toml` 白名单内（verify 第 8 步）；GPL、AGPL、LGPL 不得进入依赖树。
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
- crate 之间的依赖方向由 `crates/deps-rules.json` 规定、`scripts/ci/check-crate-deps.mjs` 检查（verify 第 9 步）。功能 crate 之间需要协作时经 `piarc-core` 编排。新增不改变方向的单向例外属于补充型决策，在 `deps-rules.json` 中登记并写明理由；反转或绕过依赖链属于变更型决策，先写 ADR。
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
- 跨 NAPI 与 AHP 时，错误映射为 `piarc-protocol` 中定义的结构化错误（至少含 `kind`、`retryable`、`message`），不传裸字符串。
- 库 crate 不用 `anyhow`；`piarc-devcli` 等二进制和测试代码可以用。
- 不吞错误：`let _ = fallible()` 与空的 `Err(_) => {}` 分支必须有注释说明为什么可以忽略。
- 用 `?` 传播并在边界处补充上下文（例如出错的路径），不在每一层重复包装。

### 2.4 panic

- 非测试代码不用 `unwrap()`；`expect("...")` 只用于可以证明不会失败的不变量，消息写明这个不变量。
- `todo!()`、`unimplemented!()`、`dbg!()` 不得提交（workspace lints，verify 第 6 步）。
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

- 单函数不超过 80 行。clippy 的 `too_many_lines` 以 80 为阈值（`clippy.toml`），以 deny 级别检查（verify 第 6 步）。确需超过时写 `#[expect(clippy::too_many_lines, reason = "...")]`，理由要说明为什么拆分反而更差（例如一张平铺的匹配表）。
- 单文件不超过 1,000 行。超过时在评审中说明理由，或按领域拆分模块。

### 2.8 unsafe

- `unsafe` 只允许出现在 `-sys` crate（`piarc-ghostty-sys`）与 NAPI 边界（`piarc-napi`）。workspace lints 对 `unsafe_code` 设为 deny；这两个 crate 在 crate 根写 `#![allow(unsafe_code, reason = "...")]` 放开。
- 每个 `unsafe` 块前写 `// SAFETY:` 注释，说明满足了哪些前置条件（clippy `undocumented_unsafe_blocks`，verify 第 6 步）。
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
  - 渲染进程不导入 Node 内置模块、主进程代码或原生模块，只能调用 preload 暴露的白名单 API；
  - 主进程只做平台集成与转发，不承载业务逻辑；两个平台都需要的逻辑放进 Core 或 Agent Host。
- `packages/protocol/src/generated/` 由 `piarc-protocol` 的 JSON Schema 生成，不手工编辑（T02）。

### 3.4 Pi 依赖

- `@earendil-works/*` 全部锁定同一精确版本（架构第 5.7 节）。
- 只使用包入口公开导出的 SDK、ExtensionAPI 与类型，禁止深度导入（例如 `@earendil-works/pi-ai/dist/...`）。T06 用 ESLint 规则落地这条禁令。

### 3.5 lint

- ESLint 使用 typescript-eslint 的 `strictTypeChecked` 与 `stylisticTypeChecked`，对全部 TS 与 JS 文件做类型感知检查（verify 第 2 步）；`eslint-config-prettier` 关闭与 Prettier 冲突的规则。
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
| 统一检查入口 | `scripts/dev/verify.mjs`（`npm run verify`） | 按顺序运行 10 个检查步骤，失败后继续，最后打印汇总表；新增检查在 `STEPS` 中追加 | T01 |
| crate 依赖方向检查 | `scripts/ci/check-crate-deps.mjs` + `crates/deps-rules.json` | 读取 `cargo metadata`，按层与例外校验 workspace crate 之间的依赖 | T01 |
| 验收清单一致性检查 | `scripts/plan/check-acceptance.mjs` | 比对任务文件中的 `- [Txx-Ayy]` 验收项与 `docs/plan/acceptance.json` | T01 |
| 仓库内工具安装 | `scripts/dev/install-tools.mjs` | 把锁定版本的 Rust 工具（当前为 cargo-deny）装进 `.tools/`，不做全局安装；`localToolPath()` 给出可执行文件路径 | T01 |
| 脚本公共函数 | `scripts/lib/repo.mjs` | `repoRoot`、`isMain`、`run`（继承输出）、`capture`（捕获输出）、`resolveBin`、`readJsonFile`、`isRecord` | T01 |
