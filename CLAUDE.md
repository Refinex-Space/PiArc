# PiArc

PiArc 是 macOS 与 Windows 上的桌面编码智能体：Electron + React 客户端、Rust Core（经 NAPI-RS 加载在主进程）、基于 Pi SDK 的 Agent Host（独立 Node 进程，经 AHP 与 Core 通信）。架构唯一基线是 `docs/architecture/ARCHITECTURE.md`，文档索引见 `docs/README.md`。

## 交付流程

- 按 `docs/plan/PLAN.md` 的看板从上到下推进。一个任务一个会话：在仓库根目录开新会话，输入 `/task <编号>`（例如 `/task T02`），任务提示词在 `docs/plan/tasks/`。
- 每个任务都严格遵守 `docs/plan/protocol.md`：开工检查、范围与决策分级、质量门禁、验收记录、收尾与最终报告。
- 架构设计是基线，ADR（`docs/adr/`）记录对基线的决策。实现与基线不符时按协议的决策分级处理：补充型直接定并同步文档；变更型写状态为"提议"的 ADR，停下受影响的部分，等用户确认。
- 验收项只在 `docs/plan/acceptance.json` 中改本任务的 `status` 与 `evidence`；不删改描述，不改其他任务的项。
- 每完成一个检查项就更新 `PLAN.md` 的"当前任务检查点"并提交；只提交，不推送。

## 命令

以下命令都在仓库根目录执行成功过。

| 命令 | 用途 |
|---|---|
| `npm ci --ignore-scripts` | 按 lockfile 安装 npm 依赖（CI 同款） |
| `node scripts/dev/install-tools.mjs` | 把锁定版本的 cargo-deny、ripgrep、fd、bindgen-cli 装进 `.tools/`（不做全局安装）；verify 第 11 步需要 cargo-deny，Agent Host 行为对照测试（Pi 原生 grep/find）需要 ripgrep 与 fd，重新生成 libghostty-vt 绑定需要 bindgen |
| `node scripts/dev/gen-ghostty-bindings.mjs [--check]` | 重新生成（或比对）`crates/piarc-ghostty-sys/src/bindings.rs`；只在升级 libghostty-vt 时需要 |
| `npm run verify` | 全部 13 项检查，结束时打印汇总表；开工与收尾各跑一次 |
| `npm run gen:protocol` | 由 `piarc-protocol` 重新生成 `packages/protocol/schema/` 与 `src/generated/`；改了协议类型后运行并提交 |
| `npm run build:agent-host` | esbuild 把 Agent Host 打成 `agent-host/dist/bundle/agent-host.mjs`（另写 `pi-assets/package.json`，运行时以 `PI_PACKAGE_DIR` 指向它） |
| `npm run build:core` | 用 `@napi-rs/cli` 构建本机的 Core 开发版 `.node`（`target/piarc-core/development/`）并更新 `.d.ts` 快照；`-- --flavor all` 两种构建都出 |
| `npm run format` | Prettier 写入格式（不处理 Markdown） |
| `npm run lint` | ESLint（类型感知） |
| `npm run typecheck` | `tsc --build`：三个工作区与 `scripts/` |
| `npm test` | Vitest 全部 TS/JS 测试 |
| `npx vitest run <路径>` | 只跑某个目录或文件的测试 |
| `cargo test -p <crate>` | 只跑某个 crate 的测试（检查点提交用） |
| `cargo clippy -p <crate> --all-targets -- -D warnings` | 只检查某个 crate |
| `LIBSQLITE3_SYS_USE_PKG_CONFIG=1 SQLITE3_LIB_DIR=/nonexistent cargo clippy --target x86_64-pc-windows-msvc --workspace --all-targets -- -D warnings` | 在 macOS 上类型检查与 lint Windows 代码（`cfg(windows)`）；需先 `rustup target add x86_64-pc-windows-msvc`（经用户同意安装），只编译不运行。两个环境变量让 rusqlite 跳过 SQLite C 源码的编译（macOS 上没有 Windows SDK 头文件） |
| `.tools/bin/cargo-deny check` | 许可证、安全公告、来源检查 |
| `PIARC_REQUIRE_KEYCHAIN=1 cargo test -p piarc-secrets --test system_store -- --nocapture` | 真实系统凭据库（macOS 登录钥匙串）中创建、读取、删除测试主密钥；不设该变量时凭据库不可用只打印 NOT RUN |
| `node scripts/ci/check-crate-deps.mjs` | crate 依赖方向检查（规则在 `crates/deps-rules.json`） |
| `node scripts/plan/check-acceptance.mjs` | 验收清单与任务文件一致性检查 |
| `node node_modules/electron/install.js` | 下载 Electron 二进制（`--ignore-scripts` 不会下载）；启动、打包、L4 之前需要 |
| `npm run start -w @piarc/desktop` | 桌面应用开发服务器模式（`electron-forge start`） |
| `npm run package:desktop -- --flavor development` | 开发构建打包到 `apps/desktop/out/development/`，并生成 L4 用的 `.vite/` 生产构建；不带参数为发布构建。会先构建 Core、Agent Host bundle，并按 `third-party/binaries.lock.json` 下载校验内置 node、rg、fd |
| `npm run package:desktop -- --flavor release --arch arm64 --make` | 出 macOS 安装包（DMG 与 ZIP，`apps/desktop/out/release/make/`）；`--arch x64` 需要已安装 `x86_64-apple-darwin` 目标 |
| `node scripts/ci/check-app-layout.mjs --flavor release --arch arm64` | 打包产物的布局与 macOS 签名分层检查 |
| `node scripts/dev/fetch-binaries.mjs [--all]` | 下载并校验锁定的第三方二进制，暂存 Agent Host 运行时（`target/agent-host-runtime/`） |
| `node scripts/release/release-manifest.mjs generate --version <v> --key <密钥> <产物…>` | 生成并签名发布清单（测试密钥在 `scripts/release/test-keys/`）；`verify --pub <公钥> <清单>` 校验 |
| `npm run test:e2e -w @piarc/desktop` | L4：Playwright 驱动开发形态与打包产物（先打开发构建） |
| `npm run check:fuses` | 发布构建产物的 fuse 与 `apps/desktop/fuses.mjs` 比对 |
| `npm run bench:s2 -- --form packaged` | S2 基准：事件吞吐、主进程事件循环延迟、同步调用、大批次、空闲内存（先打开发构建） |
| `npm run bench:s7 -- --form packaged` | S7 基准：终端中 `cat` 大文件（`--megabytes`、`--repeat`）与键入回显配对测量（先打开发构建） |
| `npm run bench:s1 -- --form packaged` | S1 基准：transcript 流式 60 s、万条滚动、千条冷加载、渲染进程内存（CDP 追踪，先打开发构建） |
| `cargo run -p piarc-sandbox --release --example s8-bench` | S8 测量：`sandbox-exec` 每条命令额外耗时、沙箱代理延迟与吞吐（macOS） |
| `node scripts/ci/load-core.mjs --module <file.node>` | 在 Node 与 Electron 中加载一个 Core 模块并跑一次事件通道 |
| `cargo run -q -p piarc-testkit --bin piarc-mock-provider -- --port 0 --scenarios <文件或目录>` | 启动严格 mock provider 独立进程：stdout 第一行是端口，stdin 关闭后退出（`testing.md` 第 10 节） |
| `cargo test -p piarc-testkit --test sessions` | 会话层端到端：Core 的工作区与会话 actor 驱动真实 Agent Host 与 mock（排队、中断、工具批次、重试、缺口补齐、空闲回收、重启恢复） |
| `PIARC_UPDATE_GOLDEN=1 cargo test -p piarc-testkit --test agent_host golden` | 重新录制投影 golden 的 Pi 事件序列（`agent-host/test/golden/`）；之后 `npx vitest run agent-host -u` 更新投影快照。不带变量时只做漂移检查 |
| `cargo run --release -p piarc-testkit --example t14-warmup` | 工作区预热测量：打开到 Agent Host 就绪、打开并恢复会话，10 次取最大值（预算 1 s） |

## 仓库结构

- `apps/desktop/`：Electron 应用（主进程、preload、渲染进程，安全基线与 L4 见其 `CLAUDE.md`）；`agent-host/`：Agent Host；`packages/protocol/`：由 `piarc-protocol` 生成的 TS 类型；`packages/testkit/`：仅测试，用 pi-ai 驱动 mock provider。四者是 npm workspaces。
- `crates/`：Rust workspace，21 个 crate，职责见各 crate 的 `src/lib.rs` 顶部文档与架构第 7.1 节。
- `tests/contracts/`：L1 契约样本（`<契约名>/` 与 `invalid/`）和帧编解码共享用例（`framing/`），流程见 `docs/engineering/testing.md` 第 7 节。
- `scripts/`：跨平台 Node 脚本（`dev/` 本地入口、`ci/` 检查、`plan/` 计划文件检查、`lib/` 公共函数）。
- `docs/engineering/`：编码规范、测试规范、CLAUDE.md 规范。
- `reference/`：只读参考仓库（gitignore），用法与边界见 `docs/plan/references.md`。

## 不变量

- crate 依赖方向：`piarc-napi → piarc-core → 功能 crate → {piarc-protocol, piarc-ports}`，功能 crate 之间不互相依赖；例外逐条登记在 `crates/deps-rules.json`。
- 依赖精确锁定：npm 不用 `^`/`~`；Cargo 依赖只在 `[workspace.dependencies]` 声明；许可证白名单见 `deny.toml`。
- clean-room（ADR-0006）：不复制 `reference/claude-code` 与 `reference/OpenClaudeDesktop` 的代码、提示词和界面组件，不用 Anthropic 品牌资产；不提供 Claude.ai 订阅登录。
- 不写入凭据、个人信息与本机绝对路径；不打印凭据。凭据只存在 Core 的保险箱（`piarc-secrets`）并只经 AHP 交给 Agent Host，不进环境变量、不进 `pi/auth.json`（ADR-0021）。
- 不靠删除、跳过、放宽测试或吞掉异常让检查通过。
- 代码、注释、提交信息用英文；设计文档用中文；提交遵循 Conventional Commits。

## 易错点

- TypeScript 锁在 6.0.x：typescript-eslint 8.x 只支持 `<6.1`，升级 TypeScript 前先确认它的支持范围。
- cargo-deny 在 `.tools/bin/`，不在 PATH；`npm run verify` 会先找这里。新机器先运行 `node scripts/dev/install-tools.mjs`（首次要编译 ripgrep 与 fd，几分钟）。
- `rust-toolchain.toml` 锁定 1.99.1；cargo 命令会自动使用它。
- 在 `.mjs` 脚本里，JSDoc 类型断言对 ESLint 不可见，`JSON.parse` 的结果会触发 `no-unsafe-*`。用 `scripts/lib/repo.mjs` 的 `readJsonFile` 与 `isRecord` 收窄。
- Windows 上不要用 shell 调 npm 命令：用 `resolveBin` 解析入口后以 `node` 运行。
- 改了 `piarc-protocol` 的类型却没运行 `npm run gen:protocol`，verify 的"protocol drift"会失败；新增契约没有样本与反例，"contract samples"会失败。
- 第一次构建 `piarc-ghostty-sys`（任何依赖 `piarc-core` 的构建）会联网下载 libghostty-vt 预编译产物到 `.tools/cache/ghostty-vt/`，并校验 SHA-256 与 minisign 签名；校验失败直接报错，不会重下。离线时设 `PIARC_GHOSTTY_VT_OFFLINE=1` 并预先填好缓存（`PIARC_GHOSTTY_VT_CACHE` 可换目录），详见 `crates/piarc-term/CLAUDE.md`。
- Windows 的 Core 模块依赖同目录下的 `ghostty-vt.dll`：手工拷 `.node` 时要一起拷（`build:core` 与打包会处理）。
- Windows 开发环境：Visual Studio Build Tools（MSVC 与 Windows SDK）、Git for Windows（委托的 Bash 用 Git Bash，终端 L4 用它自带的 vim）、Node 24；`npm run verify` 与 L4 在 Windows 上都能完整运行。Windows 专有的行为差异（ConPTY、同步的 stdout、计时器粒度、`\\?\` 路径）见 `crates/piarc-term`、`agent-host`、`apps/desktop`、`crates/piarc-testkit` 的 CLAUDE.md 与 S2、S7、S9 报告。
- 改了终端帧的编码或格式，要用 `PIARC_UPDATE_FRAME_SAMPLES=1 cargo test -p piarc-term --test consistency` 重写 TS 共享样本，否则 Rust 与 TS 两侧的样本检查都会失败。
- 改了 `piarc-napi` 的导出却没运行 `npm run build:core -- --flavor all`，verify 的"Core module + API snapshot"会失败。源码树运行应用、L4 的 `dev` 形态、Vitest 的 Core 集成测试都加载 `target/piarc-core/development/` 下的模块，缺了会直接报错（`package:desktop` 会先构建它）。
- 需要保留 CRLF 的测试夹具放在 `fixtures/crlf/` 目录下，其余文本文件都会被 `.gitattributes` 规范为 LF。
- Vitest 中的 `packages/testkit` 测试会先 `cargo build` mock provider 的 bin，所以 `npm test` 需要 Rust 工具链；L0–L2 测试不访问真实服务商，模型侧一律用 mock provider。
- 反过来，`cargo test`（`piarc-testkit` 的 `agent_host` 测试）会用 PATH 上的 node 运行 `scripts/dev/build-agent-host.mjs` 打包 Agent Host，需要先 `npm ci --ignore-scripts`。
- Pi 锁定 1.5.2（`@earendil-works/*` 全部同版本，`agent-host` 与 `packages/testkit` 一起升级）；Pi 的 API 以 `node_modules` 中的类型声明或 `reference/pi` 的同一 tag 为准，基线差异见 `docs/research/pi-v1.4.0-baseline.md` 文末。
- L4 的 `dev` 形态跑上次打包生成的 `apps/desktop/.vite/`：改了 `apps/desktop/src/` 后先重新 `npm run package:desktop -- --flavor development`。
- 渲染进程不从 HTML 字符串建 DOM（ESLint 禁止 `innerHTML`、`dangerouslySetInnerHTML` 等）；模型输出经 `transcript/markdown/` 的增量解析与 `MarkdownView` 渲染，代码高亮只用 shiki 的 JavaScript 正则引擎，CSP 不放宽（ADR-0022）。复制相关的 L4 会写系统剪贴板（用例结束后恢复文本）。
- 主进程在 `ready` 前固定 `userData` 与 `sessionData`（`apps/desktop/src/main/platform/data-dirs.ts`）：带 `--user-data-dir=<dir>` 启动时 Core 的数据库、`pi/`、日志与 Chromium 数据都在 `<dir>` 下（L4 的隔离依赖它），否则在 macOS `~/Library/Application Support/PiArc/`、Windows `%LOCALAPPDATA%\PiArc\`。
- 项目级可执行配置（hooks、MCP、allow 规则、插件、Pi 扩展）只经 `piarc_config::project_trust` 判断信任（Core 侧 `piarc_core::trust`，Agent Host 侧 `agent-host/src/harness/project-trust.ts`），失败一律不信任；不要另写读表或读 Pi `trust.json` 的路径（ADR-0025）。
- `cargo test`（含 `npm run verify`）会在登录钥匙串中以 `piarc-test.` 开头的服务名创建并删除测试条目；测试代码只用 `test_master_key_name` 命名条目，不碰 `piarc-core::identity` 的正式服务名。
- `cargo test`（含 verify）中 `piarc-core` 的 `sandbox_commands` 测试经沙箱代理连 `registry.npmjs.org`、`index.crates.io`：离线时这两个用例失败并写明原因。沙箱内命令要联网的工具，配置文件里的代理设置会盖过 `HTTP_PROXY`（`crates/piarc-sandbox/CLAUDE.md`）。
- 测试里用 `vim -u NONE` 时加 `--cmd 'set encoding=utf-8'`：否则 vim 按 locale 选编码，`LANG` 为空的环境（CI runner、某些 IDE 或智能体的子进程）里中文显示成转义（I38）。
- 打包时 `postPackage` 才把内置 node 放进 `.app`，签名分层见 `apps/desktop/CLAUDE.md`；不要对整个 bundle 用 `codesign --deep` 重签，会覆盖 node 的 Node.js 官方签名。
- Windows 安装包由 CI 的 `package-windows` 作业产出（`scripts/release/pack-windows.mjs`，需要 .NET SDK）；Velopack 的 pack id 是应用标识，不能用 `PiArc`（会与数据目录 `%LOCALAPPDATA%\PiArc\` 重合）。
- 升级 Pi 前后跑 golden 录制与漂移检查（见命令表）：投影、排队、中断补齐与工具批次都依赖 Pi 的事件顺序与队列语义（ADR-0026）。
- Agent Host 的工具不碰文件系统与子进程：`agent-host/src/tools/`、`src/harness/` 禁止导入 `fs`、`child_process`，I/O 一律经 AHP `fs/*`、`exec/*` 由 Core 执行（ADR-0004、ADR-0020）；端到端测试的 I/O spy 会抓到绕过。
