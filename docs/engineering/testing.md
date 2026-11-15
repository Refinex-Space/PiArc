# 测试规范

测试分层沿用架构第 12.1 节，纪律沿用第 12.6 节。每层的目录、命名与命令以本文为准；某层由后续任务建立时，那个任务负责补全本文对应的小节。

## 1. 分层

| 层 | 内容 | 位置与命名 | 命令 | 运行时机 | 建立任务 |
|---|---|---|---|---|---|
| L0 单元（Rust） | 权限、Bash 分析、hooks 决策、快照、diff、终端状态等纯逻辑 | 同文件 `#[cfg(test)] mod tests`；跨模块的放 `crates/<crate>/tests/*.rs` | `cargo test -p <crate>`；全部：`cargo test --workspace` | 每次提交 | T01 |
| L0 单元（TS） | 投影、工具包装、Harness Kit；渲染进程的 store 归约器、Markdown 增量解析、交互规则纯函数；仓库脚本 | 与源文件同目录：`foo.ts` ↔ `foo.test.ts`，脚本为 `foo.test.mjs` | `npm test`；单个文件：`npx vitest run <路径>` | 每次提交 | T01 |
| L1 契约 | AHP schema 往返、录制事件样本的反序列化与再序列化、Pi 事件到 AHP 投影的 golden、NAPI 导出声明与 preload API 快照 | T02 建立并补充本节 | 由 `npm run verify` 运行 | 每次提交 | T02 |
| L2 场景回放 | 无头运行 Core + 真实 Agent Host，模型侧接严格校验请求的 mock provider，按场景数据文件驱动 | `tests/scenarios/<场景 id>.yaml`，文件名与 `id` 一致；运行器在 `piarc-testkit`，驱动在 `piarc-devcli` | T15 补充 | 每次提交 | T05、T15 |
| L3 行为对齐 | 对真实 Claude Code 录制同一批场景，与 PiArc 做结构化 diff | 有意偏离写在 `tests/l3-allowlist.yaml` | T30 补充 | 每晚 / 手动 | T30 |
| L4 客户端 | Playwright 驱动打包后的 Electron 应用；关键组件视觉快照；录制事件流驱动渲染进程（假 Core） | T03 补充 | T03 补充 | 每次提交（快照）/ 每晚（UI 流程） | T03、T19 |
| 安全回归 | Markdown 与链接渲染的 XSS 载荷集、preload API 越权调用、外部导航拦截（架构第 10.3 节） | T03 建立并补充本节 | 由 `npm run verify` 运行 | 每次提交 | T03 起 |
| 性能 | 架构第 11 章的预算，两个平台分别测量 | T44 补充 | T44 补充 | 每次提交（冒烟）/ 每晚（完整） | T04、T09、T10、T44 |
| 多服务商 | 部分 L2 场景对真实服务商运行 | 与 L2 场景共用，按标记筛选 | 手动或每晚，需要密钥与预算（第 6 节） | 每晚，可选 | R2 起 |

## 2. 质量门禁

`npm run verify`（`scripts/dev/verify.mjs`）按顺序执行全部检查，一步失败后继续执行后续步骤，最后打印汇总表，任一步失败则退出码非 0：

| # | 步骤 | 单独运行 |
|---|---|---|
| 1 | Prettier `--check` | `npx prettier --check .`（写入：`npm run format`） |
| 2 | ESLint | `npm run lint` |
| 3 | `tsc --build` | `npm run typecheck` |
| 4 | Vitest | `npm test` |
| 5 | `cargo fmt --check` | `cargo fmt --all --check` |
| 6 | `cargo clippy` | `cargo clippy --workspace --all-targets --locked -- -D warnings` |
| 7 | `cargo test` | `cargo test --workspace --locked` |
| 8 | cargo-deny | `.tools/bin/cargo-deny check`（先运行 `node scripts/dev/install-tools.mjs`） |
| 9 | crate 依赖规则 | `node scripts/ci/check-crate-deps.mjs` |
| 10 | 验收清单一致性 | `node scripts/plan/check-acceptance.mjs` |

CI（`.github/workflows/ci.yml`）在 `macos-latest`（arm64）与 `windows-latest`（x64）上执行 `npm ci --ignore-scripts` 与 `npm run verify`。后续任务新增的检查（L1 契约、L2 场景、schema 漂移等）都接进 verify，使本地与 CI 运行同一套检查。

执行协议要求的检查点提交只需受影响的包或 crate 通过，例如 `cargo test -p <crate>`、`npx vitest run <路径>`；全量 verify 在开工与收尾时各跑一次。

## 3. 命名

- 测试名描述行为与预期结果：Rust 写 `fn rejects_write_outside_workspace()`，TS 写 `it('rejects a write outside the workspace')`。不写 `test1`、`works`。
- 测试名、场景名必须与断言内容一致：名字说"拒绝"，断言就要检查拒绝。
- 场景文件名与场景 `id` 一致。

## 4. fixture

### 4.1 纪律

- 禁止"找不到 fixture 就直接 return"式的静默通过：fixture 缺失时测试失败。
- 测试 fixture 同时覆盖 LF 与 CRLF、含空格与中文的路径（架构第 15.3 节）。
- 测试需要写文件时在系统临时目录下创建独立目录（路径含空格与中文），结束后清理；不写入仓库工作区。
- L0–L2 不访问网络与真实模型服务商；模型侧一律接 mock provider。

### 4.2 CRLF 夹具目录

`.gitattributes` 把全部文本文件规范为 LF，所以 CRLF 文件在提交时会被改写。需要保留 CRLF 的夹具放在任意 `fixtures/crlf/` 目录下（例如 `tests/fixtures/crlf/`、`crates/piarc-fs/tests/fixtures/crlf/`），该目录按 `**/fixtures/crlf/** -text` 原样存储与检出；`.editorconfig` 也对它取消换行与行尾空白的处理。

提交后用 `git ls-files --eol <路径>` 确认：CRLF 夹具应显示 `i/-text w/-text`（或 `i/crlf`），其余文本文件为 `i/lf w/lf`。

## 5. 测试纪律

- 修 bug 先写能复现问题的失败测试，再修。
- 不通过删除、跳过、放宽测试来让检查通过；不给已有测试加 `skip`、`.only` 或 `#[ignore]`。
- 只在一个平台上有意义的测试用条件编译或条件注册：Rust 用 `#[cfg(windows)]`、`#[cfg(target_os = "macos")]`；TS 用 `it.runIf(process.platform === 'win32')`，并在测试名或注释中写明原因。
- 测试不靠 `sleep` 等待异步结果，用事件、通道或可控的 `Clock` 驱动；同一测试连续运行两次结果相同。
- 测试用来验证正确性：不硬编码只对测试输入成立的值，不为了让测试通过在实现中写特判。

## 6. 测试证据

- 验收证据（命令输出、截图、录屏、性能数据）放在 `tmp/evidence/<任务编号>/`，例如 `tmp/evidence/T09/`。`tmp/` 已被 `.gitignore` 排除，证据不入库。
- `docs/plan/acceptance.json` 的 `evidence` 字段写验证命令与关键输出，或证据文件路径。
- 证据中不得出现凭据、个人信息与用户的真实会话内容。

## 7. 真实服务商测试的成本约束

- 默认测试套件（verify 与 CI 的 PR 流水线）从不调用真实模型服务商。
- 调用会产生费用的服务前先征得用户同意，并说明预计调用次数；测试只用最便宜够用的模型。
- 密钥只从环境变量或凭据库读取，不写入仓库、日志与测试证据；输出中遮蔽密钥。
- 每晚的多服务商场景只在配置了密钥时运行，没有密钥时整体跳过并在输出中注明，不算通过。
