# PiArc

PiArc 是 macOS 与 Windows 上的桌面编码智能体：Electron + React 客户端、Rust Core（经 NAPI-RS 加载在主进程）、基于 Pi SDK 的 Agent Host（独立 Node 进程，经 AHP 与 Core 通信）。架构唯一基线是 `docs/architecture/ARCHITECTURE.md`，文档索引见 `docs/README.md`。

## 交付流程

- 按 `docs/plan/PLAN.md` 的看板从上到下推进。一个任务一个会话：在仓库根目录开新会话，输入 `/task <编号>`（例如 `/task T02`），任务提示词在 `docs/plan/tasks/`。
- 每个任务都严格遵守 `docs/plan/protocol.md`：开工检查、范围与决策分级、质量门禁、验收记录、收尾与最终报告。
- 架构设计是基线，ADR（`docs/adr/`）记录对基线的决策。实现与基线不符时按协议的决策分级处理：补充型直接定并同步文档；变更型写状态为"提议"的 ADR，停下受影响的部分，等用户确认。
- 验收项只在 `docs/plan/acceptance.json` 中改本任务的 `status` 与 `evidence`；不删改描述，不改其他任务的项。
- 每完成一个检查项就更新 `PLAN.md` 的"当前任务检查点"并提交；只提交，不推送。
- 项目说明写在各目录的 `AGENTS.md`（Claude Code 与 Codex 共用）；同目录的 `CLAUDE.md` 只有一行 `@AGENTS.md`，不往里写内容。新建子目录说明时两个文件一起建。

## 命令

以下命令都在仓库根目录执行成功过。

| 命令 | 用途 |
|---|---|
| `npm ci --ignore-scripts` | 按 lockfile 安装 npm 依赖（CI 同款） |
| `node scripts/dev/install-tools.mjs` | 把锁定版本的 cargo-deny、ripgrep、fd、bindgen-cli 装进 `.tools/`（不做全局安装）；verify 第 11 步需要 cargo-deny，Agent Host 行为对照测试（Pi 原生 grep/find）需要 ripgrep 与 fd，重新生成 libghostty-vt 绑定需要 bindgen |
| `node scripts/dev/gen-ghostty-bindings.mjs [--check]` | 重新生成（或比对）`crates/piarc-ghostty-sys/src/bindings.rs`；只在升级 libghostty-vt 时需要 |
| `npm run verify` | 全部 16 项检查，结束时打印汇总表；收尾跑一次（先提交代码），全部通过且工作区干净时记下提交 |
| `npm run verify -- --baseline` | 开工基线：上次全量通过之后只改了 `docs/` 时只查改动文件与验收清单，否则跑全量（`docs/plan/protocol.md`） |
| `npm run gen:tokens` | 由 `design/tokens/` 生成渲染进程的 CSS 自定义属性与共享的 TS 常量；改令牌后运行并提交（verify 第 15 步检查漂移、对比度与品牌，ADR-0029） |
| `node scripts/ci/check-i18n.mjs` | verify 第 16 步：中英文目录键与占位符一致、ICU 有效、只用该语言有的复数类别、引用的键存在、渲染进程与主进程没有硬编码文字与不带 locale 的格式化（规则见 `docs/engineering/accessibility.md`） |
| `PIARC_EVIDENCE_TASK=T43 npx playwright test -c apps/desktop/playwright.config.ts t43- --project dev` | T43 无障碍：状态清单全部状态的 axe（亮暗，报告在 `tmp/evidence/T43/axe/`）、审批卡焦点、只用键盘的流程与系统偏好、中英文截图与溢出检查 |
| `node scripts/dev/check-prompt-originality.mjs` | 修改 Harness 英文提示词或工具指引后，在含本地参考副本的机器上做连续 10 词比对，更新 `docs/engineering/prompt-originality.md` |
| `npm run gen:protocol` | 由 `piarc-protocol` 重新生成 `packages/protocol/schema/` 与 `src/generated/`；改了协议类型后运行并提交 |
| `npm run build:agent-host` | esbuild 把 Agent Host 打成 `agent-host/dist/bundle/agent-host.mjs`（另写 `pi-assets/package.json`，运行时以 `PI_PACKAGE_DIR` 指向它） |
| `npm run build:core` | 用 `@napi-rs/cli` 构建本机的 Core 开发版 `.node`（`target/piarc-core/development/`）并更新 `.d.ts` 快照；`-- --flavor all` 两种构建都出 |
| `npm run format` | Prettier 写入格式（不处理 Markdown） |
| `npm run lint` | ESLint（类型感知） |
| `npm run typecheck` | `tsc --build`：四个工作区与 `scripts/` |
| `npm test` | Vitest 全部 TS/JS 测试 |
| `npx vitest run <路径>` | 只跑某个目录或文件的测试 |
| `cargo test -p <crate>` | 只跑某个 crate 的测试（检查点提交用） |
| `cargo clippy -p <crate> --all-targets -- -D warnings` | 只检查某个 crate |
| `LIBSQLITE3_SYS_USE_PKG_CONFIG=1 SQLITE3_LIB_DIR=/nonexistent CC_x86_64_pc_windows_msvc=$PWD/scripts/dev/c-placeholder.mjs AR_x86_64_pc_windows_msvc=$PWD/scripts/dev/c-placeholder.mjs cargo clippy --target x86_64-pc-windows-msvc --workspace --all-targets -- -D warnings` | 在 macOS 上类型检查与 lint Windows 代码（`cfg(windows)`）；需先 `rustup target add x86_64-pc-windows-msvc`（经用户同意安装），只编译不运行。macOS 上没有 Windows SDK 头文件：前两个变量让 rusqlite 跳过 SQLite，后两个让 tree-sitter 等 C 依赖只生成占位目标文件（clippy 不链接） |
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
| `npm run bench:s7 -- --form packaged` | S7 基准：终端中 `cat` 大文件（`--megabytes`、`--repeat`）与键入回显配对测量（先打开发构建）；`--headless` 只测没有页面拉帧的终端（T33-A13，结果在 `tmp/evidence/T33/bench/`） |
| `npm run bench:t18` | T18 冷启动：打包产物以 100 个会话的数据目录冷启动 10 次，测到侧栏就绪（预算 1.0 s，先打开发构建） |
| `npm run bench:t19` | 正式会话的流式渲染、万条滚动、缓存切换与千条冷加载基准。先打开发构建，在前台运行 |
| `npm run bench:s1 -- --form packaged` | S1 基准：transcript 流式 60 s、万条滚动、千条冷加载、渲染进程内存（CDP 追踪，先打开发构建） |
| `cargo run -p piarc-sandbox --release --example s8-bench` | S8 测量：`sandbox-exec` 每条命令额外耗时、沙箱代理延迟与吞吐（macOS） |
| `node scripts/ci/load-core.mjs --module <file.node>` | 在 Node 与 Electron 中加载一个 Core 模块并跑一次事件通道 |
| `cargo run -q -p piarc-testkit --bin piarc-mock-provider -- --port 0 --scenarios <文件或目录>` | 启动严格 mock provider 独立进程：stdout 第一行是端口，stdin 关闭后退出（`testing.md` 第 10 节） |
| `cargo run -q -p piarc-testkit --bin piarc-mock-auth -- --port 0` | 启动 mock OAuth 授权服务器（授权码与设备码）：stdout 第一行是端口，stdin 每行 `approve`/`deny`/`expire` 改决定，关闭后退出 |
| `cargo test -p piarc-testkit --test sessions login` | 服务商登录端到端（T29）：授权码、设备码、拒绝、过期、取消、手工粘贴代码，保险箱与无明文扫描 |
| `npm run l3` | L3（T30）：同一个严格 mock 服务 PiArc 与真实的 `claude -p`，比对请求结构与行为轨迹，报告在 `tmp/l3/`；`-- --repeat 2` 检查同侧可重复，`-- --filter <id>` 只跑部分场景。需要 PATH 上有 `claude`（Nightly 锁定的版本见 `.github/workflows/l3-nightly.yml`，全局安装先征得同意；Windows 上用该版本 npm 平台包自带的 `claude.exe`，见 `testing.md` 第 14 节），不访问真实服务商（`testing.md` 第 14 节） |
| `node scripts/ci/run-l2.mjs` | verify 第 14 步：构建 Agent Host bundle → 全部 L2 场景（报告写到 `target/l2/results.json`）→ 能力覆盖与 `docs/product/capabilities.md` 漂移检查 |
| `cargo test -p piarc-testkit --test scenarios -- <id> --exact` | 只跑一个 L2 场景（`tests/scenarios/<id>.yaml`）；不加筛选跑全部，`-- --results <文件>` 写报告 |
| `cargo run -q -p piarc-devcli -- run tests/scenarios [--json <文件>]` | 不经 UI 运行一个场景文件或整个目录，输出 JSON 报告 |
| `node scripts/plan/check-capabilities.mjs [--milestone M2]` | 检查能力清单；`--milestone` 列出该里程碑及之前未完成的能力；`--results <报告> --doc write` 重新生成 `capabilities.md` |
| `cargo test -p piarc-policy --test bash_cases -- --nocapture` | T23 的 Bash 分析数据驱动用例（`crates/piarc-policy/tests/bash_cases.json`，打印条数与类别）与随机输入测试 |
| `cargo test -p piarc-core --lib terminal::` 与 `cargo test -p piarc-core --test terminal` | T33 终端：会话目录与命令环境、智能体的终端任务与屏幕文件、未共享的终端模型看不到、snapshot 保存与丢弃；关闭终端与关闭 Core 都结束整棵进程树（Windows 版 `--test terminal_windows`）。shell integration 在 `cargo test -p piarc-term --test shell_integration`（Windows：`shell_integration_windows`） |
| `PIARC_EVIDENCE_TASK=T34 npx playwright test -c apps/desktop/playwright.config.ts t34- --project dev` | T34 终端面板 L4：标签与会话目录、关闭结束进程树、选区复制与附加到消息、查找、链接确认、共享、重载恢复、无障碍与 axe、vim/top/less 与缩放、键鼠与 bracketed paste、隐藏与最小化不拉帧、输入法（先打开发构建或重建渲染进程）；`cargo test -p piarc-term --test pointer` 是 Core 侧的选区、滚动、唤醒与默认颜色 |
| `cargo test -p piarc-core --test background_tasks` | T32 后台命令：`background` 立即作答、KillShell 结束整棵进程树并保留输出、其他会话停不了、Monitor 以任务运行；`cargo test -p piarc-testkit --test sessions tasks::` 是 Agent Host 被杀后后台命令继续与通知送达、退出时进程树结束与重启后显示已中断 |
| `cargo test -p piarc-testkit --test sessions` | 会话层端到端：Core 的工作区与会话 actor 驱动真实 Agent Host 与 mock（排队、中断、工具批次、重试、缺口补齐、空闲回收、重启恢复） |
| `cargo test -p piarc-core --lib tool_io::hooks` | hooks 经真实 Core：裁决第 2、8 步、`hooks/run`、信任、审计与落盘、并行与去重、超时与中断后整棵进程树结束（T25）；L2 为 `cargo test -p piarc-testkit --test scenarios -- hooks-` |
| `PIARC_UPDATE_GOLDEN=1 cargo test -p piarc-testkit --test agent_host golden` | 重新录制投影 golden 的 Pi 事件序列（`agent-host/test/golden/`）；之后 `npx vitest run agent-host -u` 更新投影快照。不带变量时只做漂移检查 |
| `cargo run --release -p piarc-testkit --example t14-warmup` | 工作区预热测量：打开到 Agent Host 就绪、打开并恢复会话，10 次取最大值（预算 1 s） |
| `npm run perf:m3 -- [--form packaged\|dev] [--warmup 20] [--seconds 30]` | M3 内存（T35）：1 个窗口、同一工作区 3 个并行会话（1 个在 worktree）加 1 个子 agent 持续流式与调用工具，采样 Agent Host 与应用各进程，对照第 11 章预算，结果在 `tmp/evidence/T35/m3-memory.json`、报告在 `docs/perf/M3-memory.md`（先打开发构建） |
| `cargo test -p piarc-git --test worktree` 与 `cargo test -p piarc-store --test search` | T35 worktree（创建、`.worktreeinclude`、改动、移除保留分支、子 agent 分支）与全文搜索（中文、英文、混排、增量、重建一致）；L2 为 `cargo test -p piarc-testkit --test scenarios -- worktree- subagent-worktree` |
| `node scripts/dev/export-tray-icons.mjs [--check]` | 从 `design/brand/mark.svg` 重新导出菜单栏与托盘图标（改了 mark 后运行并提交） |
| `cargo test -p piarc-testkit --test sessions mcp::` | T36 MCP 端到端：OAuth 登录、刷新与重新登录（token 只在保险箱）、Agent Host 退出或被杀后没有 MCP server 进程、`npx` server 在没有系统 node 的 PATH 下跑在内置 Node 上；L2 为 `cargo test -p piarc-testkit --test scenarios -- mcp-`，池的单测为 `npx vitest run agent-host/src/mcp` |
| `PIARC_EVIDENCE_TASK=T36 npx playwright test -c apps/desktop/playwright.config.ts t36- --project dev` | T36 的 MCP 设置页与配置诊断：来源、作用域、传输、状态、工具数，停用结束进程、启用与重连起新进程，SSE/WebSocket 标为不支持（截图在 `tmp/evidence/T36/`） |
| `cargo test -p piarc-config --lib skills` 与 `cargo test -p piarc-core --lib tool_io::policy::tests::t37` | T37 skills、命令与输出风格：发现与同名取舍、frontmatter、参数替换、`!` 命令标为不支持、合并命令列表；回合级 `allowed-tools`、未信任项目、skill 的 hooks、skill 目录只读放行；L2 为 `cargo test -p piarc-testkit --test scenarios -- skill- command- style-`，Agent Host 侧 `npx vitest run agent-host/src/harness/skills` |
| `PIARC_EVIDENCE_TASK=T37 npx playwright test -c apps/desktop/playwright.config.ts t37- --project dev` | T37 的 `/` 命令面板（来源分组、模糊搜索、参数提示、输入法的 `/` 不打开）、内置命令、会话中途切换输出风格、Mod+K 与改快捷键、Skills 与插件设置页（截图在 `tmp/evidence/T37/`） |
| `cargo test -p piarc-core --lib tool_io::hooks::tests::m3` 与 `--lib tool_io::policy::tests::t38` | T38：`http` hook 经本地 HTTP 服务（决策、白名单变量插值、URL 白名单、非 2xx/超时/连接失败不阻断）、`prompt` hook（阻断理由、超时与无法解析不阻断、审计模型与 token）、未信任项目、`prompt_id` 与 `effort`、项目 hook 的权限更新；`web/search` 的授权绑定、保险箱 key（Agent Host 读不到）、审计；L2 为 `cargo test -p piarc-testkit --test scenarios -- websearch- hooks-m3-` |
| `PIARC_EVIDENCE_TASK=T38 npx playwright test -c apps/desktop/playwright.config.ts t38- --project dev` | T38 的搜索来源链接（点击先经原生确认）与设置页"网页搜索"一节的可用与不可用说明、保存 key（截图在 `tmp/evidence/T38/`） |
| `cargo test -p piarc-testkit --test sessions sandbox::`、`cargo test -p piarc-core --test agent_host_profile` 与 `PIARC_EVIDENCE_TASK=T39 npx playwright test -c apps/desktop/playwright.config.ts t39- --project dev` | T39 沙箱：真实 Agent Host 在定稿配置下（测试扩展写主目录失败、npx MCP 只写允许的位置）、网络卡与白名单热更新、经 Bash 工具的构建命令（npm、cargo 连真实 registry）；配置在真实 `sandbox-exec` 上的读写；设置页、审计"沙箱拒绝"、沙箱与网络卡（截图在 `tmp/evidence/T39/`）；L2 为 `cargo test -p piarc-testkit --test scenarios -- sandbox-` |
| `cargo test -p piarc-core --lib plugins::`、`cargo test -p piarc-config plugins` 与 `PIARC_EVIDENCE_TASK=T40 npx playwright test -c apps/desktop/playwright.config.ts t40- --project dev` | T40 插件与 Pi 包：内置 npm 的进程与 `--ignore-scripts`（postinstall 不运行）、git 锁定与更新后新项待确认、作用域与开关、未信任项目不加载、审计；设置页与主进程原生确认（测试钩子代答，截图在 `tmp/evidence/T40/`）；L2 为 `cargo test -p piarc-testkit --test scenarios -- plugin- pi-package- mcp-prompts`。`node scripts/ci/check-app-layout.mjs --flavor release` 核对发布构建没有测试钩子 |
| `cargo test -p piarc-core --lib tool_io::hooks::tests::m4`、`--lib usage::`、`--test state sources` 与 `PIARC_EVIDENCE_TASK=T41 npx playwright test -c apps/desktop/playwright.config.ts t41- --project dev` | T41：ConfigChange 阻断后本会话保留旧值（权限与 hooks）、企业来源不可阻断、监视列表上限；计价与 pi-ai `calculateCost` 的共享向量、子 agent 计入主会话、用户价与未知价；全部配置来源的诊断与运行中刷新；右栏用量卡片、"用量"页与改价、诊断页的来源分组（截图在 `tmp/evidence/T41/`）；L2 为 `cargo test -p piarc-testkit --test scenarios -- hooks-m4-` |

## 仓库结构

- `design/tokens/`：设计令牌的单一来源（色板、明暗阶梯、语义层、组件层、尺度、对比度对，ADR-0029）；`design/brand/` 是图标。
- `apps/desktop/`：Electron 应用（主进程、preload、渲染进程，安全基线与 L4 见其 `AGENTS.md`）；`agent-host/`：Agent Host；`packages/protocol/`：由 `piarc-protocol` 生成的 TS 类型；`packages/testkit/`：仅测试，用 pi-ai 驱动 mock provider。四者是 npm workspaces。
- `crates/`：Rust workspace，22 个 crate，职责见各 crate 的 `src/lib.rs` 顶部文档与架构第 7.1 节。
- `tests/scenarios/`：L2 场景（`schema.json` 是格式）；`tests/capabilities.yaml`：M1–M5 能力清单，生成 `docs/product/capabilities.md`（`testing.md` 第 12、13 节）。
- `tests/l3/scenarios/`：L3 场景（`tests/l3/schema.json`），`tests/l3-allowlist.yaml` 是有意偏离与排除清单；脚本在 `scripts/l3/`（`testing.md` 第 14 节）。
- `tests/contracts/`：L1 契约样本（`<契约名>/` 与 `invalid/`）和帧编解码共享用例（`framing/`），流程见 `docs/engineering/testing.md` 第 7 节。
- `scripts/`：跨平台 Node 脚本（`dev/` 本地入口、`ci/` 检查、`plan/` 计划文件检查、`lib/` 公共函数）。
- `docs/engineering/`：编码规范、测试规范、AGENTS.md 规范。
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
- 第一次构建 `piarc-ghostty-sys`（任何依赖 `piarc-core` 的构建）会联网下载 libghostty-vt 预编译产物到 `.tools/cache/ghostty-vt/`，并校验 SHA-256 与 minisign 签名；校验失败直接报错，不会重下。离线时设 `PIARC_GHOSTTY_VT_OFFLINE=1` 并预先填好缓存（`PIARC_GHOSTTY_VT_CACHE` 可换目录），详见 `crates/piarc-term/AGENTS.md`。
- Windows 的 Core 模块依赖同目录下的 `ghostty-vt.dll`：手工拷 `.node` 时要一起拷（`build:core` 与打包会处理）。
- Windows 开发环境：Visual Studio Build Tools（MSVC 与 Windows SDK）、Git for Windows（委托的 Bash 用 Git Bash，终端 L4 用它自带的 vim）、Node 24；`npm run verify` 与 L4 在 Windows 上都能完整运行。Windows 专有的行为差异（ConPTY、同步的 stdout、计时器粒度、`\\?\` 路径）见 `crates/piarc-term`、`agent-host`、`apps/desktop`、`crates/piarc-testkit` 的 AGENTS.md 与 S2、S7、S9 报告。
- 改了终端帧的编码或格式，要用 `PIARC_UPDATE_FRAME_SAMPLES=1 cargo test -p piarc-term --test consistency` 重写 TS 共享样本、用 `PIARC_UPDATE_TERM_FRAME_SAMPLES=1 cargo test -p piarc-protocol --test term_frame` 重写 L1 样本（`tests/contracts/term-frame/`），否则 Rust 与 TS 两侧的样本检查都会失败；`scripts/ci/core-load-check.mjs` 的 `frameRows` 也按格式版本读帧。
- 改了 `piarc-napi` 的导出却没运行 `npm run build:core -- --flavor all`，verify 的"Core module + API snapshot"会失败。源码树运行应用、L4 的 `dev` 形态、Vitest 的 Core 集成测试都加载 `target/piarc-core/development/` 下的模块，缺了会直接报错（`package:desktop` 会先构建它）。
- 需要保留 CRLF 的测试夹具放在 `fixtures/crlf/` 目录下，L2 场景的按字节夹具放在 `tests/scenarios/fixtures/`（两处都是 `-text`），其余文本文件都会被 `.gitattributes` 规范为 LF。
- Vitest 中的 `packages/testkit` 测试会先 `cargo build` mock provider 的 bin，所以 `npm test` 需要 Rust 工具链；L0–L2 测试不访问真实服务商，模型侧一律用 mock provider。
- 反过来，`cargo test`（`piarc-testkit` 的 `agent_host` 测试）会用 PATH 上的 node 运行 `scripts/dev/build-agent-host.mjs` 打包 Agent Host，需要先 `npm ci --ignore-scripts`。
- Pi 锁定 1.5.2（`@earendil-works/*` 全部同版本，`agent-host` 与 `packages/testkit` 一起升级）；Pi 的 API 以 `node_modules` 中的类型声明或 `reference/pi` 的同一 tag 为准，基线差异见 `docs/research/pi-v1.4.0-baseline.md` 文末。
- L4 的 `dev` 形态跑上次打包生成的 `apps/desktop/.vite/`：改了 `apps/desktop/src/` 后先重新 `npm run package:desktop -- --flavor development`。
- 渲染进程不从 HTML 字符串建 DOM（ESLint 禁止 `innerHTML`、`dangerouslySetInnerHTML` 等）；模型输出经 `transcript/markdown/` 的增量解析与 `MarkdownView` 渲染，代码高亮只用 shiki 的 JavaScript 正则引擎，CSP 不放宽（ADR-0022）。复制相关的 L4 会写系统剪贴板（用例结束后恢复文本）。
- 主进程在 `ready` 前固定 `userData` 与 `sessionData`（`apps/desktop/src/main/platform/data-dirs.ts`）：带 `--user-data-dir=<dir>` 启动时 Core 的数据库、`pi/`、日志与 Chromium 数据都在 `<dir>` 下（L4 的隔离依赖它），否则在 macOS `~/Library/Application Support/PiArc/`、Windows `%LOCALAPPDATA%\PiArc\`。
- 项目级可执行配置（hooks、MCP、allow 规则、插件、Pi 扩展）只经 `piarc_config::project_trust` 判断信任（Core 侧 `piarc_core::trust`，Agent Host 侧 `agent-host/src/harness/project-trust.ts`），失败一律不信任；不要另写读表或读 Pi `trust.json` 的路径（ADR-0025）。有未确认的新增可执行项时项目不受信任（ADR-0029，I63）。项目的 skill、命令、输出风格与子 agent 定义：信任只覆盖根自己资源目录里的文件（`piarc_config::executables::covered_by_trust`，worktree 里的副本与根以上目录的不算），解析链接后出了项目目录的不读（`stays_in_project`，R4）。
- Claude Code 的配置只读（ADR-0005、ADR-0038）：`.claude/settings*.json` 与 `~/.claude/settings.json` 和 PiArc 设置同表合并，一个键生效与否只看 `piarc_config::claude::SETTINGS_KEYS`（实现某个键的功能时改这一行，不另写判断）；`piarc-config` 的写入拒绝 `.claude/` 与 `.claude.json`，L2 每个场景比对 Claude Code 配置快照。用户级 Claude Code 文件从 `CoreConfig.home` 读：测试、L2、L4（`<user data>/test-home`）一律注入临时目录，不读本机 `~/.claude`。
- 界面颜色、字号、间距只来自设计令牌（`var(--piarc-…)`），界面字符串只经 `src/shared/i18n/` 的目录（英文与简体中文同键）；verify 第 15 步拒绝对比度不达标、主色落在橙色 / 陶土色、打包字体或音频的改动。
- 无障碍与本地化（T43，规则在 `docs/engineering/accessibility.md`）：新增设置页、面板、对话框或 transcript 行类型要登记到 `apps/desktop/e2e/a11y/states.ts` 并接到 `t43-a11y` 的旅程（Vitest 的覆盖检查拒绝没登记的）；transcript 是 `feed` 不是 `log`，流式进展只经会话的节流 live region；中文没有 `one` 复数类别（用 `=1`）；数字与日期用应用上下文的 `format`，不调不带 locale 的 `toLocaleString()`（verify 第 16 步）。
- `cargo test`（含 `npm run verify`）会在登录钥匙串中以 `piarc-test.` 开头的服务名创建并删除测试条目；测试代码只用 `test_master_key_name` 命名条目，不碰 `piarc-core::identity` 的正式服务名。
- `cargo test`（含 verify）中 `piarc-core` 的 `sandbox_commands` 测试经沙箱代理连 `registry.npmjs.org`、`index.crates.io`：离线时这两个用例失败并写明原因。沙箱内命令要联网的工具，配置文件里的代理设置会盖过 `HTTP_PROXY`（`crates/piarc-sandbox/AGENTS.md`）。
- 测试里用 `vim -u NONE` 时加 `--cmd 'set encoding=utf-8'`：否则 vim 按 locale 选编码，`LANG` 为空的环境（CI runner、某些 IDE 或智能体的子进程）里中文显示成转义（I38）。
- T21 服务商设置通过 Core 的设置 Host 调用 Pi 的 ModelRuntime 更新保险箱；自定义端点在用户设置中保存协议、基础地址和模型 ID，Core 生成隔离目录下的 `pi/models.json`。不要把密钥写入该文件或传入进程环境。设置变更中断时由 Core 对照保险箱恢复，见 ADR-0032。百炼 Token Plan 的内置提供商、两种协议的北京端点和套餐模型选择见 [Pi 调研](docs/research/pi-v1.4.0-baseline.md#t21-自定义提供商线协议与可用模型v152)。
- 打包时 `postPackage` 才把内置 node 放进 `.app`，签名分层见 `apps/desktop/AGENTS.md`；不要对整个 bundle 用 `codesign --deep` 重签，会覆盖 node 的 Node.js 官方签名。
- Windows 安装包由 CI 的 `package-windows` 作业产出（`scripts/release/pack-windows.mjs`，需要 .NET SDK）；Velopack 的 pack id 是应用标识，不能用 `PiArc`（会与数据目录 `%LOCALAPPDATA%\PiArc\` 重合）。
- L2 场景目标（`--test scenarios`）设了 `test = false`，`cargo test --workspace` 不跑它，只有 verify 第 14 步与显式 `--test scenarios` 跑。新增或改动场景、改能力状态后重新生成 `docs/product/capabilities.md`（手改会被漂移检查拒绝）；`active` 能力没有场景时报 MISSING。
- 升级 Pi 前后跑 golden 录制与漂移检查（见命令表）：投影、排队、中断补齐与工具批次都依赖 Pi 的事件顺序与队列语义（ADR-0026）。
- 文件工具的不变量（先读后改、外部修改、编码与换行保持、原子替换、diff、越界与受保护路径）在 Core 的 `piarc-fs` 与 `tool_io/files.rs`，结果预算在 Agent Host 的 `harness/tool-results.ts`（ADR-0027）。Read 完成内容解析后才按调用提交快照（ADR-0034）。文件工具和预览均通过获准的目录句柄读写（ADR-0036）。替换已存在的文件只经 `piarc_fs::write`；会话目录外与受保护路径的操作只标记需要询问，由 Core 的 `tool_io::policy` 裁决，只有绑定到同一调用的 I/O 可使用审批结果（ADR-0031）。
- 权限规则与 Bash 分析在 `piarc-policy`（规则语法、阶梯、只读白名单、关键路径删除与"总是允许"前缀见其 AGENTS.md），Core 侧组装在 `tool_io::policy::assess`（ADR-0037）。只读白名单里的命令（`echo`、`ls`、`cat`、`git status`…）在手动模式下免审批：要求审批的 L2/L4 夹具用不在白名单的命令（`env echo`、`sed`、`printenv`）。项目文件里新加的 allow 规则是未确认的可执行项，信任重新确认前不生效；跳过权限的开关只读用户级 `settings.json` 的 `permissions.enableBypassPermissions`。
- Bash 与 PowerShell 是 PiArc 自写的工具，命令的进程树终止、超时（默认 2 分钟、上限 10 分钟）、cwd 跟踪、输出预算与落盘、语义退出码都在 Core 的 `exec/run`（`piarc-exec` + `piarc-core::tool_io::exec`，ADR-0028）；阈值只改 `piarc_exec::ExecLimits`。命令环境来自用户登录 shell（每个 Core 首次执行命令时解析），仅向命令传入 ADR-0035 准入的系统、locale、工具链变量。
- Agent Host 的工具不碰文件系统与子进程：`agent-host/src/tools/`、`src/harness/` 禁止导入 `fs`、`child_process`，I/O 一律经 AHP `fs/*`、`exec/*` 由 Core 执行（ADR-0004、ADR-0020）；端到端测试的 I/O spy 会抓到绕过。
- 上下文工程（T27，ADR-0043）：模型可见的运行时提示只经 `agent-host/src/harness/reminders.ts`（`piarc.reminder`，类型见 `agent-host/AGENTS.md`），不要另写自定义消息类型或改写已发送的 system prompt；压缩阈值只在 `harness/compaction-threshold.ts`，重注入上限只在 `harness/reinjection.ts` 的 `RESTORE_LIMITS`，熔断次数只在 `AUTO_COMPACT_FAILURE_LIMIT`。Pi 的会话设置覆盖值会被 `SettingsManager.reload()` 清掉，一律经 `SessionCompaction.apply()` 在每次运行前施加。摘要提示与提醒文案改动后跑原创性检查。
- 检查点（T28，ADR-0044）：快照只覆盖经 Core 的文件写入（`piarc-fs` 在路径锁内先存旧字节，`fs → checkpoint` 例外），只被 Bash 改动的文件不在其中；回退、撤销、丢弃一律经 `piarc_fs::replace` 核对期望哈希后写回并留记录，规则在 `piarc_checkpoint::plan`。对话回退只在 Agent Host 的 `runtime/branches.ts` 移动 leaf 并追加条目，不删 JSONL（ADR-0011），之后在同一 id 下重建 Pi 会话。设置 `fileCheckpointingEnabled: false` 关掉快照。
- WebFetch（T29，ADR-0045）：网络请求只在 Core（`piarc-web` 经 AHP `web/fetch`，绑定已获准的同一调用、同一 URL），SSRF 检查后只连接检查过的地址；允许列表只来自 `CoreConfig.web`（测试的 `PIARC_TEST_WEB_ALLOWLIST`、L2 的 `web` 段），不要从项目设置读。规则与 hooks 取 URL 主机一律用 `piarc_web::rule_host`。提取经 Agent Host 的辅助模型通道（`harness/auxiliary.ts`），网页只作为提问材料、结果是工具结果。登录交互经 `core/login` 到客户端，凭据只进保险箱；每模型设置与辅助模型只经 Core 的 `setModelPreferences` 写用户级 `modelProviders`。
- L3（T30，ADR-0046）：Claude Code 只在临时 `CLAUDE_CONFIG_DIR` 与 `HOME`、假 key、指向本地 mock 的 base URL 下运行，录制只写白名单结构（`scripts/l3/check-recordings.mjs` 把关），不得把 Claude Code 的提示词或工具描述写进任何文件、日志或终端输出；调试只打印长度与 hash。命令运行前后比较本机 `~/.claude`，同时开着的 Claude Code 会话写会话记录也会被报告。allowlist 中修好的条目要删掉（不再匹配即失败）；PiArc 的偏差先写能复现的 L2 场景再修。
- 子 agent（T31，ADR-0048）：定义由 Core 读（`piarc_config::agents`），子会话在同一 Agent Host 内运行（`agent-host/src/runtime/subagents.ts` 是深度与并发的唯一计数），运行前经 `subagent/start` 在 Core 登记自己的会话 id 并链接主会话：模式取更严者、"本会话允许"与检查点归主会话、审批卡标来源。工具过滤用 Pi 的隐藏声明加 `tool_call` 闸门，不要改成 `setActiveTools`（被移除工具的调用会绕过闸门）。模型说明只经 `agent-host/src/providers/aliases.ts` 的 `resolveModel` 解析，别名表是设置键 `modelAliases`。
- 后台任务（T32，ADR-0049）：后台命令、后台子 agent、Monitor 都登记在 Core 的 `piarc_core::tasks::TaskManager`（状态机、`background_tasks`、`core/tasks` 快照、停止、分段读取），T33 的终端任务加一种 `TaskKind`，不另建注册表。前台超时由任务时钟计时、同一进程转后台（不要把超时交回 `CommandRunner`）；后台命令不随回合中断、会话关闭、Agent Host 崩溃结束，归档或删除会话、KillShell、面板、应用退出才结束。模型可见的后台通知只经 Core 挂起的 `Notice` 与带 `key` 的 `session/remind`（送达以 `reminder` 条目为准），Monitor 限值只在 `TaskLimits`。Monitor 的命令走 Bash 规则与分析但不享受只读白名单；`Bash` matcher 的 hooks 也匹配 Monitor。L2 用 `advance_clock` 推进任务时钟，不靠真实等待。
- Worktree（T35，ADR-0052）：worktree 操作只经 `piarc-git::worktree`（Core 用命令环境与进程树启动器运行 git），位置 `.piarc/worktrees/<名称>/`、分支 `piarc/<名称>`；worktree 会话的文件根是 worktree、设置与信任的来源是主工作区（`SessionIo.project`），读设置的新入口用 `project()`。清理与归档只删目录、保留分支，不加 `--force` 重试；丢弃改动只能由用户在主进程的原生对话框里选。托盘计数只来自 Core 的 `core/activity`；`piarc://` 只做定位（`src/main/launch.ts`）。
- 终端面板（T34，ADR-0051）：渲染进程只画 Core 的帧，选区、滚动、链接与按键编码都在 Core（指针事件与按键走同一个写线程）；空闲视图停拉，由 `term/<id>` 的 `output` 事件唤醒。面板只打开会话终端（归会话，重载不关闭）；主进程对终端的写入、打开与共享要求窗口近期真实输入（`input-event`），所以 L4 一律用真实输入路径驱动终端。
- 终端（T33，ADR-0050）：会话的终端是 `TaskKind::Terminal` 的后台任务（Core 的 `terminal/bound.rs`），模型读的是 Core 写的屏幕文件（formatter 输出），不是原始字节；用户的终端只在共享后对模型可见，读取时在 Core 核对。终端环境来自 T17 的构造，没有 locale 时补 UTF-8（否则 bash 在 C locale 下把键入的中文变成 Meta 键）。进程树由 `piarc_exec::TerminalTree` 结束，有序关闭要等它（含宽限后的 `SIGKILL`）。升级 libghostty-vt 按 `crates/piarc-term/AGENTS.md` 的检查项判断 `SNAPSHOT_FORMAT`。
- MCP（T36，ADR-0053）：配置只在 Core 合并（`piarc_config::mcp::merge`，Core 的 `piarc_core::mcp` 应答 `mcp/servers`：来源、同名取舍、`${VAR}` 展开、信任、按工作区的启停），连接池只在 Agent Host 的 `agent-host/src/mcp/`（每工作区一份连接，租约、空闲断开、退避重连）；不要另读 `.mcp.json` 或 `~/.claude.json`，也不要恢复 Pi 的 `createMcpExtension()`。stdio server 用 PiArc 自写的传输留在 Agent Host 的进程组（pi-mcp 的 `StdioTransport` 会脱离它），环境取 Core 的命令环境、PATH 前置内置 Node。OAuth 状态只在保险箱键 `mcp/<server>`，不出现 `mcp-auth.json`。工具超过 `mcp.deferThreshold` 时经 `ToolSearch`（Pi 的 `tool_search` 换规范名）延迟加载，变化只经 `mcpChanged` 提醒。`mcp/statusChanged` 是没有会话头的工作区级通知（`piarc-host` 的 `HOST_NOTIFICATIONS`），Core 转到 `core/mcp`。
- Skills、斜杠命令与输出风格（T37，ADR-0054）：发现与解析只在 Core（`piarc_config::skills`，项目优先于用户，同级 `.piarc` > `.claude` > Pi 的目录），Agent Host 关掉 Pi 自带的 skills 与 prompt templates、只经 `skills/list` 取结果；不要在 Agent Host 读 skill 或命令文件。`/名称` 由 Core 在 UserPromptSubmit 之前展开（`ToolIo::expand_command`，T41 的 UserPromptExpansion 挂在其后），内置命令在客户端执行、只映射已有功能（名称只在 `BUILT_IN_COMMANDS`）。`allowed-tools` 是回合级 allow 来源 `skill`（`policy::State::grant_turn_rules`，回合结束、中断、断连或进入排队即撤回），skill 的 hooks 到会话结束；项目来源要求项目受信任，并计入可执行项。参数替换只用 `piarc_config::skills::args`（位置参数从 `$1` 起）。输出风格在第 3 段、skills 索引在第 5 段，中途变化只经 `skillsChanged`、`outputStyle` 提醒，不改写已发送的 system prompt。
- WebSearch 与 M3 hooks（T38，ADR-0055）：`WebSearch` 是 PiArc 的工具，经同一闸门裁决后才搜索：原生后端是辅助模型通道向会话模型发一次只带服务商搜索工具的请求（线格式只在 `agent-host/src/providers/web-search.ts`），不要把服务端工具加进主请求（会绕过闸门）；第三方后端只经 Core 的 `web/search`（`piarc_web::search::Backend`，key 在保险箱 `websearch/<后端>`，这类键 Agent Host 读、写、锁都不行）。工具集在会话打开时决定（`prepareWebSearch`），中途配好的后端要新会话才有。`http`、`prompt` hook 与命令共用 `piarc_hooks::Runner`（端口注入），不另写执行器；`prompt` 的模型调用只经 Agent Host 的 `hooks/prompt`。子会话里的 hooks 输入带 `agent_id`、`agent_type` 且 `session_id` 是主会话的；项目 hook 的 `updatedPermissions` 不写工作区模式记忆、不确认进信任快照。
- 沙箱（T39，ADR-0056）：命令是否进沙箱在 `policy/evaluate` 决定并随授权走（`tool_io/sandbox.rs`），配置按命令从当时的设置生成，不要缓存或在会话打开时决定；自动批准只在阶梯第 7 步，沙箱外重试（`dangerouslyDisableSandbox`）与白名单外域名的网络卡在任何模式都问、hooks 不代答；项目文件只能收紧（`piarc_config::sandbox::loosening`）。Agent Host 在 macOS 上（打包与开发两种启动）运行于定稿配置，只能写工作区、`<数据目录>/pi`、`agent-host/`、`sessions/*/tmp`：测试里让 Agent Host 或其子进程写的文件放在这些位置（`crates/piarc-sandbox/AGENTS.md`）。Windows 没有 OS 沙箱（D7），到 Beta 维持现状，MXC ProcessContainer 为 Beta 之后的候选（ADR-0057）。
- 插件与 Pi 包（T40，ADR-0058）：安装、开关、确认只经 Core 的 `piarc_core::plugins`（记录在 `packages` 表，开关在设置的 `plugins` 键，项目文件里的是可执行配置）；npm 只经内置 npm 且带 `--ignore-scripts`，不提供放开脚本的开关；包的可执行项（hooks、MCP server、Pi 扩展、子 agent 的 hooks 与内联 server）逐项确认，确认只在主进程原生对话框里完成（`NativeConfirm`），渲染进程不能单独开启。读设置的地方经 `Settings::packages()` 取生效的包；Pi 扩展经 AHP `plugins/extensions` 交给 Agent Host，不要写进 `pi/settings.json`。MCP prompts 在 Agent Host 的池里实现（`agent-host/src/mcp/prompts.ts`）。
- M4 hooks、配置诊断与用量（T41，ADR-0059）：StopFailure 的错误类型只在 `agent-host/src/runtime/turn-errors.ts` 的 `stopFailureType` 映射；`mcp_tool` hook 经 AHP `hooks/mcpTool` 交给 Agent Host 的工作区池，不在 Core 另起 MCP 客户端；ConfigChange 阻断的层值只经 `ToolIo::apply_pins` 施加（权限裁决与 hooks 规划都要用它）。配置诊断的新来源加一个 `piarc_config::SourceKind` 与 `config_diagnostics/sources.rs` 的生成函数，用该功能自己的加载器，不另写判断。成本只在 `piarc_core::usage` 计算（整数皮美元，规则同 pi-ai `calculateCost`），没有价格的模型成本是 `None`（界面"未知"），不要当成 0；用户价格只读用户级 `modelPrices`。
- Hooks（T25，ADR-0039）：hook 命令只在 Core 运行（`piarc-hooks` 解析、匹配、执行、合并，`piarc-core::hooks` 读设置与信任、写审计），Agent Host 只经 `hooks/run` 报告 Pi 事件并应用结果；新增事件在 `HookEvent` 加一项、在挂载处调 `HooksService::run`，不另写执行器。Stop 续跑上限只在 `piarc_hooks::STOP_CONTINUATION_LIMIT`。L2 的 hook 夹具是 `tests/scenarios/fixtures/hooks/hook.mjs.txt`（复制成 `hook.mjs` 运行）。
