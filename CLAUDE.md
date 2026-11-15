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
| `node scripts/dev/install-tools.mjs` | 把锁定版本的 cargo-deny 装进 `.tools/`（不做全局安装）；verify 第 11 步需要它 |
| `npm run verify` | 全部 13 项检查，结束时打印汇总表；开工与收尾各跑一次 |
| `npm run gen:protocol` | 由 `piarc-protocol` 重新生成 `packages/protocol/schema/` 与 `src/generated/`；改了协议类型后运行并提交 |
| `npm run build:core` | 用 `@napi-rs/cli` 构建本机的 Core 开发版 `.node`（`target/piarc-core/development/`）并更新 `.d.ts` 快照；`-- --flavor all` 两种构建都出 |
| `npm run format` | Prettier 写入格式（不处理 Markdown） |
| `npm run lint` | ESLint（类型感知） |
| `npm run typecheck` | `tsc --build`：三个工作区与 `scripts/` |
| `npm test` | Vitest 全部 TS/JS 测试 |
| `npx vitest run <路径>` | 只跑某个目录或文件的测试 |
| `cargo test -p <crate>` | 只跑某个 crate 的测试（检查点提交用） |
| `cargo clippy -p <crate> --all-targets -- -D warnings` | 只检查某个 crate |
| `.tools/bin/cargo-deny check` | 许可证、安全公告、来源检查 |
| `node scripts/ci/check-crate-deps.mjs` | crate 依赖方向检查（规则在 `crates/deps-rules.json`） |
| `node scripts/plan/check-acceptance.mjs` | 验收清单与任务文件一致性检查 |
| `node node_modules/electron/install.js` | 下载 Electron 二进制（`--ignore-scripts` 不会下载）；启动、打包、L4 之前需要 |
| `npm run start -w @piarc/desktop` | 桌面应用开发服务器模式（`electron-forge start`） |
| `npm run package:desktop -- --flavor development` | 开发构建打包到 `apps/desktop/out/development/`，并生成 L4 用的 `.vite/` 生产构建；不带参数为发布构建 |
| `npm run test:e2e -w @piarc/desktop` | L4：Playwright 驱动开发形态与打包产物（先打开发构建） |
| `npm run check:fuses` | 发布构建产物的 fuse 与 `apps/desktop/fuses.mjs` 比对 |
| `npm run bench:s2 -- --form packaged` | S2 基准：事件吞吐、主进程事件循环延迟、同步调用、大批次、空闲内存（先打开发构建） |
| `node scripts/ci/load-core.mjs --module <file.node>` | 在 Node 与 Electron 中加载一个 Core 模块并跑一次事件通道 |
| `cargo run -q -p piarc-testkit --bin piarc-mock-provider -- --port 0 --scenarios <文件或目录>` | 启动严格 mock provider 独立进程：stdout 第一行是端口，stdin 关闭后退出（`testing.md` 第 10 节） |

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
- 不写入凭据、个人信息与本机绝对路径；不打印凭据。
- 不靠删除、跳过、放宽测试或吞掉异常让检查通过。
- 代码、注释、提交信息用英文；设计文档用中文；提交遵循 Conventional Commits。

## 易错点

- TypeScript 锁在 6.0.x：typescript-eslint 8.x 只支持 `<6.1`，升级 TypeScript 前先确认它的支持范围。
- cargo-deny 在 `.tools/bin/`，不在 PATH；`npm run verify` 会先找这里。新机器先运行 `node scripts/dev/install-tools.mjs`。
- `rust-toolchain.toml` 锁定 1.99.1；cargo 命令会自动使用它。
- 在 `.mjs` 脚本里，JSDoc 类型断言对 ESLint 不可见，`JSON.parse` 的结果会触发 `no-unsafe-*`。用 `scripts/lib/repo.mjs` 的 `readJsonFile` 与 `isRecord` 收窄。
- Windows 上不要用 shell 调 npm 命令：用 `resolveBin` 解析入口后以 `node` 运行。
- 改了 `piarc-protocol` 的类型却没运行 `npm run gen:protocol`，verify 的"protocol drift"会失败；新增契约没有样本与反例，"contract samples"会失败。
- 改了 `piarc-napi` 的导出却没运行 `npm run build:core -- --flavor all`，verify 的"Core module + API snapshot"会失败。源码树运行应用、L4 的 `dev` 形态、Vitest 的 Core 集成测试都加载 `target/piarc-core/development/` 下的模块，缺了会直接报错（`package:desktop` 会先构建它）。
- 需要保留 CRLF 的测试夹具放在 `fixtures/crlf/` 目录下，其余文本文件都会被 `.gitattributes` 规范为 LF。
- Vitest 中的 `packages/testkit` 测试会先 `cargo build` mock provider 的 bin，所以 `npm test` 需要 Rust 工具链；L0–L2 测试不访问真实服务商，模型侧一律用 mock provider。
- L4 的 `dev` 形态跑上次打包生成的 `apps/desktop/.vite/`：改了 `apps/desktop/src/` 后先重新 `npm run package:desktop -- --flavor development`。
