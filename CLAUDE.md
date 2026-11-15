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
| `node scripts/dev/install-tools.mjs` | 把锁定版本的 cargo-deny 装进 `.tools/`（不做全局安装）；verify 第 8 步需要它 |
| `npm run verify` | 全部 10 项检查，结束时打印汇总表；开工与收尾各跑一次 |
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

## 仓库结构

- `apps/desktop/`：Electron 应用；`agent-host/`：Agent Host；`packages/protocol/`：由 `piarc-protocol` 生成的 TS 类型。三者是 npm workspaces。
- `crates/`：Rust workspace，21 个 crate，职责见各 crate 的 `src/lib.rs` 顶部文档与架构第 7.1 节。
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
- 需要保留 CRLF 的测试夹具放在 `fixtures/crlf/` 目录下，其余文本文件都会被 `.gitattributes` 规范为 LF。
