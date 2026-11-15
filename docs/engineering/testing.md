# 测试规范

测试分层沿用架构第 12.1 节，纪律沿用第 12.6 节。每层的目录、命名与命令以本文为准；某层由后续任务建立时，那个任务负责补全本文对应的小节。

## 1. 分层

| 层 | 内容 | 位置与命名 | 命令 | 运行时机 | 建立任务 |
|---|---|---|---|---|---|
| L0 单元（Rust） | 权限、Bash 分析、hooks 决策、快照、diff、终端状态等纯逻辑 | 同文件 `#[cfg(test)] mod tests`；跨模块的放 `crates/<crate>/tests/*.rs` | `cargo test -p <crate>`；全部：`cargo test --workspace` | 每次提交 | T01 |
| L0 单元（TS） | 投影、工具包装、Harness Kit；渲染进程的 store 归约器、Markdown 增量解析、交互规则纯函数；仓库脚本 | 与源文件同目录：`foo.ts` ↔ `foo.test.ts`，脚本为 `foo.test.mjs` | `npm test`；单个文件：`npx vitest run <路径>` | 每次提交 | T01 |
| L1 契约 | AHP schema 往返、录制事件样本的反序列化与再序列化、Pi 事件到 AHP 投影的 golden、NAPI 导出声明与 preload API 快照 | 样本：`tests/contracts/<契约名>/*.json`，反例在其下的 `invalid/`；Rust：`crates/piarc-protocol/tests/*.rs`；TS：`packages/protocol/src/*.test.ts`；见第 7 节 | `cargo test -p piarc-protocol`、`npx vitest run packages/protocol`；全部由 `npm run verify` 运行 | 每次提交 | T02 |
| L2 场景回放 | 无头运行 Core + 真实 Agent Host，模型侧接严格校验请求的 mock provider，按场景数据文件驱动 | `tests/scenarios/<场景 id>.yaml`，文件名与 `id` 一致；运行器在 `piarc-testkit`，驱动在 `piarc-devcli` | T15 补充 | 每次提交 | T05、T15 |
| L3 行为对齐 | 对真实 Claude Code 录制同一批场景，与 PiArc 做结构化 diff | 有意偏离写在 `tests/l3-allowlist.yaml` | T30 补充 | 每晚 / 手动 | T30 |
| L4 客户端 | Playwright 驱动 Electron 应用（开发形态与打包产物）；关键组件视觉快照；录制事件流驱动渲染进程（假 Core） | `apps/desktop/e2e/*.e2e.ts`；见第 9 节 | 先 `npm run package:desktop -- --flavor development`，再 `npm run test:e2e -w @piarc/desktop` | 每次提交（CI `desktop` 作业）/ 每晚（UI 流程） | T03、T19 |
| 安全回归 | Markdown 与链接渲染的 XSS 载荷集、preload API 越权调用、外部导航拦截（架构第 10.3 节） | Electron 层：L4 的 `csp`、`navigation`、`external-links`、`preload`、`permissions`、`app-instance` 用例；纯函数（来源校验、外链白名单、CSP、资源路径）：`apps/desktop/src/main/**/*.test.ts`；XSS 载荷集由 T09 加入 | 纯函数部分由 `npm run verify` 运行；Electron 层同 L4 | 每次提交 | T03 起 |
| 性能 | 架构第 11 章的预算，两个平台分别测量 | T44 补充 | T44 补充 | 每次提交（冒烟）/ 每晚（完整） | T04、T09、T10、T44 |
| 多服务商 | 部分 L2 场景对真实服务商运行 | 与 L2 场景共用，按标记筛选 | 手动或每晚，需要密钥与预算（第 8 节） | 每晚，可选 | R2 起 |

## 2. 质量门禁

`npm run verify`（`scripts/dev/verify.mjs`）按顺序执行全部 12 项检查，一步失败后继续执行后续步骤，最后打印汇总表，任一步失败则退出码非 0：

| # | 步骤 | 单独运行 |
|---|---|---|
| 1 | Prettier `--check` | `npx prettier --check .`（写入：`npm run format`） |
| 2 | ESLint | `npm run lint` |
| 3 | `tsc --build` | `npm run typecheck` |
| 4 | Vitest | `npm test` |
| 5 | `cargo fmt --check` | `cargo fmt --all --check` |
| 6 | `cargo clippy` | `cargo clippy --workspace --all-targets --locked -- -D warnings` |
| 7 | `cargo test` | `cargo test --workspace --locked` |
| 8 | 协议漂移 | `node scripts/ci/check-protocol-drift.mjs` |
| 9 | 契约样本完整性 | `node scripts/ci/check-contract-samples.mjs` |
| 10 | cargo-deny | `.tools/bin/cargo-deny check`（先运行 `node scripts/dev/install-tools.mjs`） |
| 11 | crate 依赖规则 | `node scripts/ci/check-crate-deps.mjs` |
| 12 | 验收清单一致性 | `node scripts/plan/check-acceptance.mjs` |

CI（`.github/workflows/ci.yml`）在 `macos-latest`（arm64）与 `windows-latest`（x64）上执行 `npm ci --ignore-scripts` 与 `npm run verify`。后续任务新增的检查（L1 契约、L2 场景、schema 漂移等）都接进 verify，使本地与 CI 运行同一套检查。

需要打包产物的检查不进 verify，由同一工作流的 `desktop` 作业在两个平台上运行：下载 Electron 二进制、打开发构建、跑 L4（第 9 节）、打发布构建、`npm run check:fuses`，证据作为 artifact 上传。

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

- 验收证据（命令输出、截图、录屏、性能数据）放在 `tmp/evidence/<任务编号>/`，例如 `tmp/evidence/T09/`。`tmp/` 已被 `.gitignore` 排除，证据不入库。L4 的截图与日志在其下的 `l4/` 子目录（第 9.4 节）。
- `docs/plan/acceptance.json` 的 `evidence` 字段写验证命令与关键输出，或证据文件路径。
- 证据中不得出现凭据、个人信息与用户的真实会话内容。

## 7. L1 契约

协议类型只在 Rust crate `piarc-protocol` 中定义（ADR-0009 第 7 条）。`npm run gen:protocol` 运行它的 `export-schema`，把 JSON Schema 与契约清单写到 `packages/protocol/schema/`，再生成 `packages/protocol/src/generated/` 的 TS 类型。

### 7.1 契约与样本

- 契约清单是 `piarc-protocol` 的 `CONTRACTS`，导出为 `packages/protocol/schema/contracts.json`。每个方法消息（请求、成功响应、通知）与每个顶层消息类型（`jsonrpc/*`、`envelope/*`）各是一个契约，`schema` 字段指向 `ahp.schema.json` 中 `$defs` 下的定义。
- 契约名就是样本目录：`host/hello` 的样本放在 `tests/contracts/host/hello/`。目录下每个 `*.json` 是一个完整的合法消息，`invalid/` 下的 `*.json` 是反例。反例覆盖三类：缺必填字段、枚举值非法、类型错误；结构上的约束（例如响应中 `result` 与 `error` 同时出现）也写成反例。
- `tests/contracts/framing/` 不是契约，是帧编解码器 Rust 与 TS 两份实现共用的字节级用例（`decode.json`、`encode.json`）。
- 样本文件经 Prettier 格式化；字符串中的 U+2028、U+2029 写成 `\u2028`、`\u2029` 转义，便于阅读。

### 7.2 检查

| 检查 | 位置 | 内容 |
|---|---|---|
| Rust 往返 | `crates/piarc-protocol/tests/contracts.rs` | 合法样本反序列化为契约的 Rust 类型再序列化，按 JSON 语义与原样本相等；反例反序列化失败 |
| TS 校验与往返 | `packages/protocol/src/contracts.test.ts` | ajv（draft 2020-12，strict）按导出的 schema 校验：合法样本通过并经 `JSON.parse` → `JSON.stringify` 往返不变，反例失败 |
| 帧编解码 | `crates/piarc-protocol/tests/framing.rs`、`packages/protocol/src/framing.test.ts` | 两份实现跑同一份 `tests/contracts/framing/` 用例 |
| 漂移 | `scripts/ci/check-protocol-drift.mjs`（verify 第 8 步） | 在临时目录重新生成，与仓库中的 schema 与生成类型逐字节比较，列出变化、缺失与多余的文件 |
| 样本完整性 | `scripts/ci/check-contract-samples.mjs`（verify 第 9 步） | `contracts.json` 中每个契约至少有一个合法样本和一个反例；不属于任何契约的样本目录也报错 |

### 7.3 新增协议消息的步骤

1. 改 Rust 类型：在 `piarc-protocol` 中定义参数与结果类型和方法标记（实现 `RequestMethod` 或 `NotificationMethod`），并在 `contract.rs` 的 `CONTRACTS` 中登记。请求方法登记两个契约：请求（契约名即方法名）和成功响应（自定名称，例如 `host/hello` 的响应是 `core/welcome`）。
2. 运行 `npm run gen:protocol`，提交 `packages/protocol/schema/` 与 `packages/protocol/src/generated/` 的变化。
3. 在 `tests/contracts/<契约名>/` 下加合法样本，在 `invalid/` 下加反例。
4. 跑两侧测试：`cargo test -p piarc-protocol` 与 `npx vitest run packages/protocol`；再跑 `node scripts/ci/check-protocol-drift.mjs` 与 `node scripts/ci/check-contract-samples.mjs`。

同一主版本内只做向后兼容的改动：新增成员必须可选；新方法与已有成员的新枚举值只发给启用了相应能力的对端；删除、改名或把可选改成必填要升主版本。规则全文在 `piarc-protocol` 的 crate 文档中。

## 8. 真实服务商测试的成本约束

- 默认测试套件（verify 与 CI 的 PR 流水线）从不调用真实模型服务商。
- 调用会产生费用的服务前先征得用户同意，并说明预计调用次数；测试只用最便宜够用的模型。
- 密钥只从环境变量或凭据库读取，不写入仓库、日志与测试证据；输出中遮蔽密钥。
- 每晚的多服务商场景只在配置了密钥时运行，没有密钥时整体跳过并在输出中注明，不算通过。

## 9. L4 客户端（Electron）

### 9.1 两种形态

Playwright 配置在 `apps/desktop/playwright.config.ts`，两个 project 跑同一批用例：

| project | 启动的程序 | 加载的代码 |
|---|---|---|
| `dev` | node_modules 中的 Electron，应用目录为 `apps/desktop` | `.vite/` 中的生产构建，界面经 `app://piarc` 加载 |
| `packaged` | `apps/desktop/out/development/` 中的开发构建打包产物 | app.asar 中的同一份生产构建 |

两种形态都要先运行 `npm run package:desktop -- --flavor development`：打包会在 `apps/desktop/.vite/` 生成生产构建，并在 `out/development/` 生成产物。改了 `apps/desktop/src/` 的代码后要重新打包，否则 L4 跑的是旧代码。`electron-forge start` 会清掉 `.vite/` 并换成开发服务器构建，之后 `dev` 形态会报"Production bundle not found"，重新打包即可。

打包形态用开发构建，是因为 Playwright 要用 `--inspect` 连接主进程，而发布构建关闭了 `EnableNodeCliInspectArguments`。两者只差这一个 fuse（`apps/desktop/fuses.mjs`），发布构建的 fuse 由 `npm run check:fuses` 校验。

### 9.2 夹具

`apps/desktop/e2e/fixtures.ts` 为每个用例：

- 在系统临时目录建独立的 user-data 目录（路径含空格与中文），以 `--user-data-dir` 传给应用，用例结束后删除；单实例锁也绑定这个目录，所以用例之间、用例与本机已运行的 PiArc 之间互不影响；
- 启动应用（`app`），等第一个窗口渲染出骨架（`page`）；
- 收集应用的 stdout 与 stderr（`appLog`），`appLog.waitFor(/…/)` 等待某行日志出现，用例结束时写入证据目录；
- `test.use({ appArgs: [...] })` 为整个文件追加命令行参数。

可执行文件的位置按平台解析，集中在 `apps/desktop/e2e/app.ts` 的 `appCommand` 与 `packagedExecutable`；用例需要自己启动进程（例如第二个实例）时也用 `appCommand`。

### 9.3 写用例的要点

- 安全用例一律针对生产渲染产物运行，不在开发服务器模式下运行。
- 页面中的检查用 `page.evaluate`；主进程中的检查与替身用 `app.evaluate`。对话框、`shell.openExternal` 等会产生外部效果的调用，在主进程中替换为记录调用的替身，不真的打开浏览器（见 `external-links.e2e.ts`）。
- 导航被主进程取消后，Playwright 的定位器会一直等待导航结束：拦截之后改在 `page.evaluate` 中检查 DOM；会触发导航的点击用 `page.mouse.click`，不用 `locator.click`。
- 等待 CSP 违规事件等异步结果时设上限，让缺失的事件以明确的值失败，而不是等到用例超时。
- 用例超时 60 s，单 worker 串行运行（每个用例都会打开真实窗口）。

### 9.4 证据

设置 `PIARC_EVIDENCE_TASK=<任务编号>` 后，输出写到 `tmp/evidence/<任务编号>/l4/<用例>/`：`app.log`（应用日志）、用例自己保存的截图（例如冒烟用例的 `window.png`），失败时还有 `trace.zip`（`npx playwright show-trace <路径>` 查看）。不设置时目录名为 `L4`；CI 用 `ci` 并上传为 artifact。Playwright 每次运行前会清空这个 `l4/` 目录。

