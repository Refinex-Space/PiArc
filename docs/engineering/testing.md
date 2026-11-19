# 测试规范

测试分层沿用架构第 12.1 节，纪律沿用第 12.6 节。每层的目录、命名与命令以本文为准；某层由后续任务建立时，那个任务负责补全本文对应的小节。

## 1. 分层

| 层 | 内容 | 位置与命名 | 命令 | 运行时机 | 建立任务 |
|---|---|---|---|---|---|
| L0 单元（Rust） | 权限、Bash 分析、hooks 决策、快照、diff、终端状态等纯逻辑 | 同文件 `#[cfg(test)] mod tests`；跨模块的放 `crates/<crate>/tests/*.rs` | `cargo test -p <crate>`；全部：`cargo test --workspace` | 每次提交 | T01 |
| L0 单元（TS） | 投影、工具包装、Harness Kit；渲染进程的 store 归约器、Markdown 增量解析、交互规则纯函数；仓库脚本 | 与源文件同目录：`foo.ts` ↔ `foo.test.ts`，脚本为 `foo.test.mjs` | `npm test`；单个文件：`npx vitest run <路径>` | 每次提交 | T01 |
| L1 契约 | AHP schema 往返、录制事件样本的反序列化与再序列化、Pi 事件到 AHP 投影的 golden、NAPI 导出声明与 preload API 快照 | 样本：`tests/contracts/<契约名>/*.json`，反例在其下的 `invalid/`；Rust：`crates/piarc-protocol/tests/*.rs`；TS：`packages/protocol/src/*.test.ts`；NAPI 声明快照：`apps/desktop/src/main/core/native/*.d.ts`；见第 7 节 | `cargo test -p piarc-protocol`、`npx vitest run packages/protocol`、`node scripts/ci/check-core-types.mjs`；全部由 `npm run verify` 运行 | 每次提交 | T02、T04 |
| L2 场景回放 | 无头运行 Core + 真实 Agent Host，模型侧接严格校验请求的 mock provider，按场景数据文件驱动 | `tests/scenarios/<场景 id>.yaml`，文件名与 `id` 一致；运行器在 `piarc-testkit`（`src/l2/`），驱动在 `piarc-devcli`；能力清单 `tests/capabilities.yaml`；见第 12、13 节 | `cargo test -p piarc-testkit --test scenarios`；全部（含能力检查）：`node scripts/ci/run-l2.mjs` | 每次提交 | T05、T15 |
| L3 行为对齐 | 对真实 Claude Code 录制同一批场景，与 PiArc 做结构化 diff | 有意偏离写在 `tests/l3-allowlist.yaml` | T30 补充 | 每晚 / 手动 | T30 |
| L4 客户端 | Playwright 驱动 Electron 应用（开发形态与打包产物）；关键组件视觉快照；录制事件流驱动渲染进程（假 Core） | `apps/desktop/e2e/*.e2e.ts`；见第 9 节 | 先 `npm run package:desktop -- --flavor development`，再 `npm run test:e2e -w @piarc/desktop` | 每次提交（CI `desktop` 作业）/ 每晚（UI 流程） | T03、T19 |
| 安全回归 | Markdown 与链接渲染的 XSS 载荷集、preload API 越权调用、外部导航拦截（架构第 10.3 节） | Electron 层：L4 的 `csp`、`navigation`、`external-links`、`preload`、`permissions`、`app-instance` 用例；纯函数（来源校验、外链白名单、CSP、资源路径）：`apps/desktop/src/main/**/*.test.ts`；XSS 载荷集由 T09 加入 | 纯函数部分由 `npm run verify` 运行；Electron 层同 L4 | 每次提交 | T03 起 |
| 性能 | 架构第 11 章的预算，两个平台分别测量 | S2：`scripts/bench/s2-event-channel.mjs`；其余 T44 补充 | `npm run bench:s2`（本机，数字不在 verify 中断言）；其余 T44 补充 | 每次提交（冒烟）/ 每晚（完整） | T04、T09、T10、T44 |
| 多服务商 | 部分 L2 场景对真实服务商运行 | 与 L2 场景共用，按标记筛选 | 手动或每晚，需要密钥与预算（第 8 节） | 每晚，可选 | R2 起 |

## 2. 质量门禁

`npm run verify`（`scripts/dev/verify.mjs`）按顺序执行全部 15 项检查，一步失败后继续执行后续步骤，最后打印汇总表，任一步失败则退出码非 0：

| # | 步骤 | 单独运行 |
|---|---|---|
| 1 | Prettier `--check` | `npx prettier --check .`（写入：`npm run format`） |
| 2 | ESLint | `npm run lint` |
| 3 | `tsc --build` | `npm run typecheck` |
| 4 | Core 模块与 API 快照 | `node scripts/ci/check-core-types.mjs`（构建两种 Core 并比对 `.d.ts` 快照，留下第 5 步要加载的开发构建） |
| 5 | Vitest | `npm test`（含 `core.integration.test.ts`：真实 Core 在 Node 中跑事件通道的短时正确性版本） |
| 6 | `cargo fmt --check` | `cargo fmt --all --check` |
| 7 | `cargo clippy` | `cargo clippy --workspace --all-targets --locked -- -D warnings` |
| 8 | `cargo test` | `cargo test --workspace --locked` |
| 9 | 协议漂移 | `node scripts/ci/check-protocol-drift.mjs` |
| 10 | 契约样本完整性 | `node scripts/ci/check-contract-samples.mjs` |
| 11 | cargo-deny | `.tools/bin/cargo-deny check`（先运行 `node scripts/dev/install-tools.mjs`） |
| 12 | crate 依赖规则 | `node scripts/ci/check-crate-deps.mjs` |
| 13 | 验收清单一致性 | `node scripts/plan/check-acceptance.mjs` |
| 14 | L2 场景与能力清单 | `node scripts/ci/run-l2.mjs`：构建 Agent Host bundle → 全部场景（`cargo test -p piarc-testkit --test scenarios -- --results target/l2/results.json`）→ 能力覆盖与 `capabilities.md` 漂移检查（第 12、13 节） |
| 15 | 设计令牌 | `node scripts/ci/check-design-tokens.mjs`：生成物与 `design/tokens/` 一致、声明的前景 / 背景对在四种颜色模式下达到 WCAG、主色色相与表面色的品牌规则、不打包字体与音频（ADR-0029；试改令牌用 `--tokens <目录>`） |

CI（`.github/workflows/ci.yml`）在 `macos-latest`（arm64）与 `windows-latest`（x64）上执行 `npm ci --ignore-scripts` 与 `npm run verify`。后续任务新增的检查（L1 契约、L2 场景、schema 漂移等）都接进 verify，使本地与 CI 运行同一套检查。verify 作业结束后把 L2 报告（`target/l2/results.json`）上传为 artifact `l2-report-<os>`。

需要打包产物的检查不进 verify，由同一工作流的 `desktop` 作业在两个平台上运行：下载 Electron 二进制、打开发构建（先构建 Core）、跑 L4（第 9 节）、打发布构建、`npm run check:fuses`，证据作为 artifact 上传。四个目标的 Core 预编译由 `core-build` 作业完成，`core-load` 作业在各自架构的 runner（`macos-latest`、`macos-15-intel`、`windows-latest`、`windows-11-arm`）上用 `scripts/ci/load-core.mjs` 在 Node 与 Electron 中加载并跑一次事件通道。

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
- 例外（不访问模型服务商）：`crates/piarc-core/tests/sandbox_commands.rs` 的 `npm install`、`cargo build` 两个用例验证沙箱代理放行真实 registry（S8），经代理连 `registry.npmjs.org`、`index.crates.io`、`static.crates.io`；离线时失败并写明原因，不静默通过。新增访问网络的测试要在这里登记（R1-Q1）。
- 需要系统凭据库的测试（`piarc-secrets` 的 `system_store`）在没有设 `PIARC_REQUIRE_KEYCHAIN=1` 时打印 `NOT RUN` 而不失败：它只证明"没有运行"，不算通过。实机结论以设了该变量的运行为准（T08-A11、W0），CI 是否设置由 T44 决定（R1-Q2）。

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
| 漂移 | `scripts/ci/check-protocol-drift.mjs`（verify 第 9 步） | 在临时目录重新生成，与仓库中的 schema 与生成类型逐字节比较，列出变化、缺失与多余的文件 |
| 样本完整性 | `scripts/ci/check-contract-samples.mjs`（verify 第 10 步） | `contracts.json` 中每个契约至少有一个合法样本和一个反例；不属于任何契约的样本目录也报错 |

### 7.3 新增协议消息的步骤

1. 改 Rust 类型：在 `piarc-protocol` 中定义参数与结果类型和方法标记（实现 `RequestMethod` 或 `NotificationMethod`），并在 `contract.rs` 的 `CONTRACTS` 中登记。请求方法登记两个契约：请求（契约名即方法名）和成功响应（契约名 `<方法>/result`，例如 `session/create/result`；`host/hello` 的响应沿用 `core/welcome`）。
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


### 9.5 transcript 与 composer（T09）

- 用例经 `e2e/transcript.ts` 的 `openLab(page)` 把窗口重载到 `#/transcript-lab` 原型页，再用同一文件里的 `addMessage`、`streamTurn`、`loadHistory`、`setRunning`、`actions`、`scrollState` 等调用页面的 `window.__piarcTranscriptLab`。数据是合成的协议事件（`src/renderer/lab/fixtures/`），不需要 Core 的测试钩子。
- 输入法：Playwright 没有输入法接口，用 CDP 驱动。`Input.imeSetComposition` 产生 `compositionstart`/`compositionupdate`，`Input.insertText` 提交并结束合成，合成中的按键用 `Input.dispatchKeyEvent` 发 `windowsVirtualKeyCode: 229`。ProseMirror 自己在合成中不分发按键，所以还要测合成开始前就到达的 229 按键和合成文本恰为触发字符（`@`、`/`）的情形，否则守卫失效也测不出来（`e2e/composer.e2e.ts`）。真实输入法的核对按 S1 报告的清单人工进行。
- 剪贴板：在主进程读（`clipboard.readText()`），用例包在 `withSavedClipboard` 里，结束后写回原来的文本。
- 安全用例针对渲染不可信内容的界面，用 `src/shared/xss-payloads.ts` 的载荷集：哨兵变量未变、无 CSP 违规、界面内没有载荷要的元素和 `on*` 属性、链接只有 `https:`/`http:`/`mailto:`、没有对外请求、载荷原文以文本出现（`e2e/transcript-security.e2e.ts`）。
- 性能不在 L4 中断言：`npm run bench:s1` 测量并输出 JSON（`tmp/evidence/T09/bench/`），数字写进 S1 报告；T44 把预算接入 CI。

### 9.6 终端（T10）

- 用例经 `e2e/terminal.ts` 的 `openTerminal(app, page, options)` 把窗口重载到 `#/terminal-lab?manual`，经主进程测试钩子 `createTerminal` 启动指定程序（`/bin/sh`、`cat`、`vim`、`top`）并交给页面；断言用页面从帧重建的屏幕（`screenText`）、Core 的 formatter 文本（`coreText`）与双方计数（`labStats`、`coreStats`）。截图前用 `settledScreen` 等页面与 formatter 一致并保持 300 ms。
- 隐藏不拉帧：比较隐藏期间 Core 的帧计数与页面的请求数（都应不变），同时 Core 读到的字节数增加，证明程序一直在输出。
- 等待程序状态时先让程序打印标记（例如 `printf '\033[?1hready\n'`），再按键：Core 按按键到达时的终端模式编码。
- 帧编解码的一致性在 L0：`cargo test -p piarc-term --test consistency` 把帧与 formatter 逐格比较，并生成 TS 共享样本；`npx vitest run apps/desktop/src/renderer/terminal` 用同一样本检查 TS 解码器。
- 性能不在 L4 中断言：`npm run bench:s7` 输出 JSON（`tmp/evidence/T10/bench/`），数字写进 S7 报告。
- 这些 L4 用例与 `crates/piarc-term/tests/pty.rs` 用 Unix 程序，在 Windows 上不运行；ConPTY 与 Windows 程序的版本由 W0 补上。

## 10. 严格 mock provider

L0–L2 的模型侧一律接 `piarc-testkit` 的严格 mock provider（架构第 12.2 节）。它模拟两种流式线格式，先校验每个请求，不合规就返回 400 并写明违反的规则；合规才按场景脚本返回下一步。

### 10.1 运行形态

| 形态 | 用法 | 适用 |
|---|---|---|
| 库 | `MockProvider::start(library).await`（tokio 运行时内）；`port()`、`anthropic_base_url()`、`openai_base_url()`、`records()`、`log()` | Rust 测试 |
| 独立进程 | `piarc-mock-provider --port 0 --scenarios <文件或目录>...`：stdout 第一行是实际端口；stdin 关闭后退出，终止信号按默认处置结束进程 | 跨进程测试（T06 起）；TS 侧用 `packages/testkit/src/mock-provider.ts` 的 `buildMockProvider`、`startMockProvider` |

| 端点 | 作用 |
|---|---|
| `POST /v1/messages` | Anthropic Messages（SSE），客户端 base URL 为 `http://127.0.0.1:<端口>`；接受查询串（Anthropic SDK 的 beta 客户端会加 `?beta=true`） |
| `POST /v1/chat/completions` | OpenAI 兼容 Chat Completions（`data:` 分块），base URL 为 `http://127.0.0.1:<端口>/v1` |
| `GET /_piarc/requests` | 请求记录（JSON 数组），与库的 `records()` 内容相同 |

只绑定 `127.0.0.1`。非流式请求返回 400 `streaming_required`。

### 10.2 场景选择

- 请求头 `x-piarc-scenario: <选择器>`，或首条用户消息中的标记 `[[piarc-scenario:<选择器>]]`；两者都有时以请求头为准。
- 选择器是 `<场景 id>` 或 `<场景 id>#<实例>`。每个选择器单独计数：同一脚本供多个会话并行使用时，各会话用不同实例即可互不影响。
- 一个选择器的第 N 个被接受的请求得到第 N 步；校验未通过的请求不消耗步数；步数用完后返回 400 `scenario_exhausted`。

### 10.3 脚本格式

一个文件（`.json`、`.yaml` 或 `.yml`）一个场景；未知字段一律报错。T15 的场景文件内嵌其中的 `validation` 与 `steps` 两部分（Rust 类型 `Script`）。

```yaml
id: read-then-answer               # ASCII 字母、数字与 . _ -
validation:                        # 可省略，默认全部规则开启
  rules: { cache_breakpoint_position: false }   # 逐条关闭
  required_system_sections: ["<environment>"]  # system 必须包含的文本
  ordered_system_sections: ["<identity>", "<environment>"]  # system 中依次出现的标记
  cache_breakpoints:               # 仅 Anthropic
    max_message_level: 1           # messages 内最多几个断点，默认 1（架构第 6.15 节）
    last_message_only: false       # 消息级断点必须在最后一条消息
steps:
  - text: "Reading the file."      # 默认分 3 段 text 增量
    thinking: "I need the source." # 可选，先输出 reasoning，再输出正文
    chunk_chars: 8                 # 可选，每段的字符数
    chunk_delay_ms: 20             # 可选，相邻线上事件间隔
    tool_calls:
      - id: toolu_read_1           # 可省略，默认 <toolu|call>_mock_<步序号>_<序号>
        name: read_file
        input: { path: "a b/中文.txt" }   # 必须是 JSON 对象
        fragments: 4               # 参数分段数，默认 3；或 split_at: [字符偏移…]
    usage: { input_tokens: 120, output_tokens: 30, cache_read_tokens: 0, cache_write_tokens: 100 }
    stop_reason: tool_use          # 可省略：有工具调用为 tool_use，否则 end_turn；另有 max_tokens
  - text: "Done."
    disconnect_after_events: 3     # 只发前 3 个线上事件，然后断开连接
  - text: "Thinking"
    stall_after_events: 4          # 只发前 4 个线上事件，然后保持连接不再发送，直到客户端断开（中断、杀进程的确定性时点）
  - error:
      kind: rate_limit             # unauthorized 401 | rate_limit 429 | overloaded 529 | server_error 500 | unavailable 503
      retry_after_secs: 2          # 仅 rate_limit，默认 1
      message: "slow down"         # 可省略
```

- 参数按紧凑 JSON 序列化（键按字典序），按字符切分：`split_at` 可以切在字符串值内部和转义序列中间，不会切开一个 UTF-8 字符。
- 用量在 Anthropic 中写入 `message_start` 与 `message_delta`；在 OpenAI 中只在请求带 `stream_options.include_usage` 时追加用量块，`prompt_tokens` 为三类输入之和，缓存读取在 `prompt_tokens_details.cached_tokens`，缓存写入在 `cache_write_tokens`（OpenRouter 扩展，pi-ai 读取它）。
- OpenAI 官方没有 529；mock 仍按脚本返回 529，让两种线格式的重试路径一致。

### 10.4 校验规则

400 的错误体沿用服务商的官方形状（Anthropic：`{"type":"error","error":{"type","message"},"request_id"}`；OpenAI：`{"error":{"message","type","param","code"}}`），另加 `error.code`（第一条违规的规则 ID）与 `error.violations`（全部违规，每条含 `rule`、`message`、`location`）。测试按规则 ID 断言，不解析 message。

| 规则 ID | 检查 |
|---|---|
| `tool_pairing` | 每个工具调用在下一条消息中都有同 id 的结果；无孤立、多余或重复的 id；Anthropic 的 `tool_result` 块排在该消息其他内容之前 |
| `role_order` | Anthropic：user 与 assistant 严格交替，首条与末条为 user（当前模型不支持 assistant 预填），`system` 角色消息不参与交替；OpenAI：`tool` 消息紧跟带 `tool_calls` 的 assistant 消息；两者都拒绝未知角色与空消息列表 |
| `tool_schema` | 名称符合 `^[a-zA-Z0-9_-]{1,128}$`（Anthropic）或 `{1,64}`（OpenAI）且不重复；参数 schema 是对象、顶层 `"type": "object"`、通过 JSON Schema 元 schema 校验；Anthropic 自定义工具必须有 `input_schema`，带 `type` 的内置工具不查 schema |
| `system_sections` | system（Anthropic 的 `system` 与 `system` 角色消息，OpenAI 的 `system`/`developer` 消息）包含场景要求的每段文本，并按顺序匹配 `ordered_system_sections` 中的标记 |
| `cache_breakpoint_count` | Anthropic 的 `cache_control`（含顶层自动缓存）不超过 4 个 |
| `cache_breakpoint_position` | 消息级断点数量与位置符合场景配置；thinking 块与空文本块不能带断点 |

不可关闭的 400：`malformed_request`、`streaming_required`、`scenario_not_selected`、`scenario_not_found`、`scenario_exhausted`；未知端点为 404 `not_found`。

新增规则：在 `crates/piarc-testkit/src/rules.rs` 的 `Rule` 中加变体与 ID，写检查函数并接进 `validate`；可关闭的规则同时加进 `Rule::VALIDATION` 与 `scenario.rs` 的 `RuleSwitches`；补一个触发 400 的测试（`tests/validation.rs`），并更新本节表格与 crate 的 `CLAUDE.md`。

### 10.5 请求记录

每个请求按到达顺序记录：`seq`、`method`、`path`（含查询串）、`format`、`scenario`（选择器）、`step_index`（从 0 开始，未消耗步数时为空）、`headers`（小写名；`authorization`、`x-api-key` 等凭据头的值记为 `<redacted>`）、原始请求体 `body`、校验结果 `violations`（空表示通过）、`outcome`（`streamed`、`disconnected`、`stalled`、`injected_error`、`rejected`）。

## 11. Agent Host 测试

Agent Host 有三层测试（T06 建立）：

| 层 | 位置 | 命令 | 内容 |
|---|---|---|---|
| TS 单元 | `agent-host/src/**/*.test.ts` | `npx vitest run agent-host` | 出站队列（背压、增量合并、`seq`）、投影（含代理项处理）、Core 桥接（超时、断开、错误响应） |
| 监管器故障注入 | `crates/piarc-host/tests/` | `cargo test -p piarc-host` | 脚本化的假 Agent Host 经内存管道运行（`tests/support`），时钟只在 sleep 时前进；覆盖握手、帧错误、挂死、背压、写队列满、连续崩溃、对账、日志 |
| 端到端 | `crates/piarc-testkit/tests/agent_host/` | `cargo test -p piarc-testkit --test agent_host -- --nocapture` | `piarc-core::agent_host` 监管真实 bundle，mock provider 应答，Core 侧用真实 `ToolIo`；多会话隔离、中断、压缩、MCP、杀进程恢复、慢读者；规范名工具、Tool Profile 改名、I/O spy、与 Pi 原生工具的行为对照（T07） |
| AHP 往返计时 | `crates/piarc-testkit/tests/ahp_round_trip.rs` | `cargo test -p piarc-testkit --test ahp_round_trip -- --nocapture` | 最小 Node 客户端代替 Agent Host，计时 2,000 次小文件 `fs/read`（架构第 11 章预算 p95 ≤ 5 ms）；独立测试二进制，计时期间不跑别的测试 |

- 端到端测试先用 PATH 上的 node（或 `PIARC_TEST_NODE`）运行 `scripts/dev/build-agent-host.mjs`，再启动 bundle；环境只给 `PI_OFFLINE=1` 等测试需要的变量，不访问网络。
- 需要在模型流的确定位置中断或杀进程时，用场景步骤的 `stall_after_events`（第 10.3 节），等对应的 `item/agentMessage/delta` 到达后再动作。
- 等待一律等事件或条件，超时只作安全网（`harness::WAIT`、`support::EVENT_WAIT`）。

### 11.1 委托工具的证据（T07）

- **零直接调用**：`harness::with_io_spy` 经 `NODE_OPTIONS=--import` 把 `packages/testkit/src/io-spy.ts` 预加载进 Agent Host，包装 `fs`、`fs/promises`、`child_process` 的全部函数；记录带时间戳，测试按场景窗口（提示词发出到回合结束）断言对工作区路径的 `fs` 调用与 `child_process` 调用为 0。新增工具或升级 Pi 时，把它们加进 `tools.rs` 的全工具场景。
- **行为对照**：`parity.rs` 用同一份脚本在 `--pi-native-tools` 的 Agent Host 与委托工具的 Agent Host 中各跑一遍，比较模型收到的工具结果（`harness::tool_results_in`，工作区路径替换为 `<WS>`）与运行后的工作区快照。有意差异登记在 `EXPECTED_DIFFERENCES` 并写明原因，差异消失或出现新差异都会失败。Pi 原生 grep、find 需要 ripgrep 与 fd：`node scripts/dev/install-tools.mjs` 装进 `.tools/bin`，测试优先用那里的。
- **Core 侧记录**：harness 的 `Core` 处理者记录每个 `fs/*`、`exec/*` 请求的方法、`origin.tool`、请求路径与解析后的路径（`calls_of`），用于断言工具到 AHP 方法的对应与会话隔离。

## 12. L2 场景（T15）

一个场景是一次完整的交互：工作区夹具、各 mock 端点的逐步响应、驱动 Core 的动作、审批应答，以及期望的事件、文件副作用与发给模型的请求（架构第 12.3 节）。场景放在 `tests/scenarios/<id>.yaml`，格式的唯一描述是同目录的 `schema.json`（JSON Schema 2020-12），运行器在 `piarc-testkit` 的 `src/l2/`。

### 12.1 字段

```yaml
id: turn-steer                    # 与文件名一致：小写字母、数字与 -
description: 一句话写清场景证明的行为，与断言一致
capabilities: [CAP-TURN-STEER-001] # tests/capabilities.yaml 中的 ID，至少一个
platforms: [macos]                # 可选，缺省为两个平台；排除平台时必须写 platform_reason
platform_reason: 依赖 /bin/sh     # 报告中列为"跳过（平台）"并带上原因
workspace:
  trusted: false                  # 可选：打开前记录信任决定（缺省不信任）
  files: { 'src/a.ts': "export const a = 1;\n" }   # 相对路径用 /，不能含 ..
  fixtures: { 'gbk.txt': gbk.txt } # 按字节复制 tests/scenarios/fixtures/ 下的文件（CRLF、BOM、GBK、图片、PDF）
providers:                        # mock 端点，可定义多个；名称为小写标签
  main:
    wire: anthropic               # 或 openai
    validation: { rules: { role_order: false } }   # 可选，与第 10.3 节相同
    vision: true                  # 可选：导入的模型夹具接受图片输入（缺省只有文本）
    reasoning: true               # 可选：导入的模型夹具支持 effort
    steps: [...]                  # 与第 10.3 节的 steps 相同
sessions:                         # 可选；缺省为一个会话 main，使用唯一的端点、工作目录为工作区
  a: { provider: one, cwd: 'alpha dir' }
actions: [...]                    # 见 12.2
approvals: []                     # 见 12.3
expect: { events, files, fixtures, requests, request_counts, tool_batches, core_io }   # 见 12.4
```

- 每个端点有自己的 `MockProvider` 与自己的 Pi provider（`mock-<端点名>`，唯一的模型 `mock-model`）；预置模型夹具经 `x-piarc-scenario` 请求头选择脚本。两个会话要并发请求时用两个端点，各自的步数互不影响。
- 提供商设置场景在端点下写 `configure_as: custom` 或 `local`，运行器通过 `CoreRuntime.provider_op` 提交本机 mock URL、线协议和模型 ID。自定义端点使用保险箱中的测试密钥，本地端点无需密钥。这些端点使用首条用户消息中的 `[[piarc-scenario:<场景 id>]]` 选择脚本，切换后同一段历史仍可重放。
- 顶层 `cloud_providers` 接受 `amazon-bedrock` 和 `google-vertex`，仅配置测试凭据。所有会话仍指定 mock 端点。用 `expect.configured_providers` 按 id 校验公开设置字段与模型目录可用性，同时扫描该场景数据目录中的测试密钥明文。
- `workspace.files` 与 `expect.files` 的路径都相对工作区；工作区本身在临时根下的 `work space 工作区`，会话的 `cwd` 相对它。
- `workspace.run_files` 在该次运行的临时根下建立夹具，可设置祖先目录的 memory、模拟家目录 `home 家/`、数据目录 `data 数据/` 或用于审批的相邻文件。`workspace.git: true` 在工作区创建空仓库，便于验证初始 Git 状态。
- 会话通常在动作开始前建立。`sessions.<label>.deferred: true` 将该会话的创建推迟到第一次输入，可验证跨会话的授权与配置。
- 按字节的夹具放在 `tests/scenarios/fixtures/`（`.gitattributes` 设为 `-text`，换行与编码不被 Git 改动）；加载时检查夹具存在。PDF 夹具用 `piarc-fs` 测试里的 `make_pdf` 生成，手写的 PDF 可能取不到文字。

### 12.2 动作

按顺序执行；会话缺省为唯一的会话，有多个会话时必须写 `session`。

| 动作 | 字段 | 做什么 |
|---|---|---|
| `prompt` | `text`、`turn`（标签） | `session_op(Prompt)`，记下回合 id |
| `steer`、`follow_up` | `text`、`item`（标签）、`turn` | 运行中进入排队表（`item` 记下排队项 id）；空闲时直接开始回合（`turn` 记下回合 id） |
| `queue_edit`、`queue_delete`、`queue_reorder` | `item`/`text`；`items`（全部标签的新顺序） | 改排队表 |
| `compact` | — | 经 Core 执行内置 `/compact`，记录这次压缩启动的回合并等待完成 |
| `set_model` | `provider`、`preview` | 预览切换，断言预览字段符合 `preview`，然后经会话 API 确认切换 |
| `set_effort` | `effort` | 经会话 API 设置当前模型支持的档位 |
| `abort` | — | 中断当前回合 |
| `wait` | 事件匹配字段（12.4）+ `count` | 等到至少 `count` 个（缺省 1）匹配的事件已送达 |
| `write_file` | `path`、`content` | 写工作区文件（例如给等待中的命令发信号） |
| `restart_core` | — | 关闭 Core，在同一数据目录上重新启动并打开工作区；会话保持关闭直到 `resume` |
| `resume` | — | `resume_session` 重新打开会话 |

`prompt`、`steer`、`follow_up` 都可带客户端的 `request_id`（重发时沿用），以及 `mentions` 和 `attachments`。提及按 Core 输入格式写 `{path, start, end}`，两个偏移是发送文本中 `@path` 的 UTF-16 起止位置。附件写 `{fixture, mime_type}`；运行器读取 `fixtures/` 中对应文件并调用 Core 的 `store_attachment`，将返回的引用随输入发送。面板的键盘交互在 L4 验证。

动作全部完成后，运行器先等每个被动作启动的回合的 `turn/completed`，再检查全部断言。follow-up 自己启动的回合没有标签，用 `wait: { method: turn/completed, count: N }` 等它们。

### 12.3 审批应答

`approvals` 按顺序回答 `core/sessions` 快照中的新请求（`decision: allow|session|always|deny`，可指定 `tool`、审批卡的 `kind` 和拒绝的 `feedback`）。应答经 Core 公开命令；未声明的请求、工具不匹配、重复或过期答复、未用上的应答都使场景失败。`sessions.<label>.mode` 显式选择起始模式，`set_mode` 操作向当前会话发送模式变更。

### 12.4 断言与匹配规则

| 字段 | 规则 |
|---|---|
| `events` | 每项是 `{ session, method, params, turn }`，或 `{ any_order: [...] }`。按会话分别做**有序子序列**匹配：每项匹配的事件必须在上一项之后；`any_order` 组内的事件顺序任意（每个成员取第一个未用的匹配），组整体在上一项之后、下一项之前；组内成员必须属于同一会话。不同会话之间不比较顺序 |
| 事件的字段匹配 | `params` 是**字段子集**：对象只比较写出的键（id、`seq`、时间戳不写就不比较），数组长度必须相同并逐元素按子集比较，标量相等；`turn` 要求 `params.turnId` 等于该标签记下的回合 id |
| `files` | 路径 → 完整内容（UTF-8，逐字节相等），或 `null` 表示文件不存在；没写的文件不检查 |
| `fixtures` | 路径 → `tests/scenarios/fixtures/` 下的文件名：工作区文件与它逐字节相等（非 UTF-8 编码、BOM、CRLF 用它断言），失败时给出第一处不同的字节偏移与前后的字节 |
| `requests` | 按端点名（只有一个端点时可省略）与请求序号（`index`，从 0 开始）断言：`roles`（消息角色顺序）、`tools`（工具名集合，恰好相等）、`tools_include`、`tools_exclude`、`user_texts`（每条有文本的 user 消息的文本，按顺序）、`last_user_text`、`contains`、`not_contains`（原始请求体子串）、`tool_results`（全部工具结果按顺序：`id`，可选 `is_error`（仅 Anthropic）与 `contains`）、`body`（请求体的字段子集） |
| `requests` 中的上下文断言 | `same_system_as` 填同一端点较早的请求序号，比较完整 system 块或 system/developer 消息的文本字节、分块与字段。用 `occurrences` 指定子串在原始请求体中的出现次数，用 `user_message_contains` 检查同一条 user 消息含有列出的全部文本 |
| `request_counts` | 每个端点收到的请求数，恰好相等 |
| （总是检查） | 每个请求都通过严格 mock 的校验；被拒的请求列出规则 ID |
| `tool_batches` | 工具调用 id 的分批：Core 收到的委托请求按这些批次成组到达。运行器经 Core 的 `ToolIoObserver` 扣住下一批的请求，整批到齐才一起放行；另一批的调用提前到达即失败。不靠计时 |
| `core_io` | `{ call, method }`：Core 为该工具调用回答过这个 AHP 方法（例如 `fs/read`、`exec/run`），证明工具经 Core 执行 |

失败输出：事件给出第一个未匹配的期望项、上一个匹配的位置、乱序时匹配事件的实际位置、同方法事件中第一个不符的字段，以及该会话附近的实际事件（去掉 `seq`、`sessionId`、`ts`）；文件给出第一处不同的行号与两边的全文（带行号）；请求给出端点、序号与不符的字段。一个场景的全部失败一起报告。

### 12.5 运行方式与取舍

- **自定义 test harness**（`crates/piarc-testkit/tests/scenarios.rs`，`harness = false`）：每个场景文件是一个测试，按 id 筛选（`-- <id>`、`--exact`、`--list`、`--test-threads <n>`），输出 `test <id> ... ok|FAILED|ignored, 跳过（平台）: <原因>` 与汇总；`--results <文件>` 写 JSON 报告（相对路径按仓库根解析）。不引入数据驱动测试库：需要的只是筛选、并行与报告。该目标设了 `test = false`，不在 `cargo test --workspace` 中重复运行，由 verify 第 14 步运行。
- **进程不复用**：每个场景一个新的临时根（路径含空格与中文）、一个新的 `CoreRuntime` 与 Agent Host，结束后删除临时根。实测单个场景（含 Core 与 Agent Host 冷启动）0.4–4 s，并行时偏长；换来会话、工作区、保险箱与 mock 步数的完全隔离；场景之间按线程并行（缺省半数核心、至多 4 个）补回总时长。
- 场景一个失败不影响其他场景的执行与报告；同一场景连续运行两次结果相同（`l2_runner.rs` 检查），没有 sleep，等待只有 30 s 安全网。
- `piarc-devcli` 用同一个运行器：`run <文件或目录> [--json <文件>]`（见 `crates/piarc-devcli/AGENTS.md`）。

- **命令环境**（T17）：L2 的 Core 以准备好的登录 shell 起命令环境：测试进程环境加上应用里 Core 会带的内部变量（`ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS`、`PI_CODING_AGENT_DIR`、`PIARC_L2_INTERNAL`）与 `L2_USER_VAR=kept`，Unix 上 `/bin/bash` 加本次运行的 `HOME`（`.bash_profile` 往 `PATH` 加含 `l2-login-tool` 的目录）。环境剔除与登录 `PATH` 的场景因此不依赖开发机的 shell 配置（`crates/piarc-testkit/src/l2/fixtures.rs` 的 `command_env`）。

### 12.6 新增一个 L2 场景

1. 在 `tests/capabilities.yaml` 找到能力 ID（没有时按第 13 节新增并在报告中说明）；实现了它的任务把状态改为 `active`。
2. 写 `tests/scenarios/<id>.yaml`：先写 mock 的逐步响应，再写动作，最后写断言；名字与 `description` 和断言一致。
3. 运行 `cargo test -p piarc-testkit --test scenarios -- <id> --exact`；故意改坏一条断言确认它会失败，再改回来。
4. 运行 `node scripts/ci/run-l2.mjs`；能力状态变化后用 `node scripts/plan/check-capabilities.mjs --results target/l2/results.json --doc write` 重新生成 `docs/product/capabilities.md` 并提交。
5. 只在一个平台上成立的场景写 `platforms` 与 `platform_reason`。

### 12.7 调试

- 单个场景串行运行：`cargo run -q -p piarc-devcli -- run tests/scenarios/<id>.yaml --threads 1`。
- 动作失败时报告附带最后 12 个事件与每个请求的结果类型和违规规则；mock 的完整请求体在 `MockProvider::records()`（运行器的 `RunOutcome` 不保留临时根）。
- 格式错误在加载时报告文件与字段的 JSON Pointer，例如 `/expect/request_counts/main: "one" is not of type "integer"`。

会话侧栏场景可用 `set_prefs` 修改标题、置顶与归档，`check_stored_session.fields` 检查数据库行（null 表示已删除），`delete_session` 经 Core 删除。`check_trust.fields` 检查 Core 提供给信任对话框的清单与决定。事件断言的 `method: core/sessions` 选择指定会话在实际快照中的那一行；通知呈现和用户点击由 L4 验证。

## 13. 能力清单（T15）

### 13.1 格式

`tests/capabilities.yaml` 登记 M1–M5 的全部 Harness 能力（架构第 12.4 节）：

```yaml
capabilities:
  - id: CAP-TURN-STEER-001        # CAP-<领域>-<能力>-<三位序号>，稳定，不重编号、不复用
    title: '运行中 steer：……'      # 一句话
    milestone: M1                 # M1–M5
    refs: [FR-CH-03, ARCH-5.3]    # 需求编号（需求第 4 章）和/或架构章节号
    task: T14                     # 实现它的任务（看板上的编号）
    status: active                # planned | active | blocked
    # blocked 时必须有 reason 与 link（issue 或登记事项编号）
client_only:                      # 行为全在客户端、由 L4 验证的需求
  - { ref: FR-CH-05, reason: '……', task: T29 }
```

领域前缀：`SESSION`、`TURN`、`CHAT`、`TRUST`、`WT`、`PROVIDER`、`MODEL`、`USAGE`、`TOOL`、`BG`、`TERM`、`SANDBOX`、`PERM`、`PLAN`、`TODO`、`ASK`、`NEXT`、`AGENT`、`STYLE`、`HOOK`、`CTX`、`MEM`、`EXT`、`CONFIG`、`SKILL`、`CMD`、`MCP`、`PLUGIN`、`CKPT`、`RV`、`SYS`。新领域在本节登记。

### 13.2 规则

| 检查 | 失败条件 |
|---|---|
| 清单本身 | ID 格式不对或重复；里程碑、状态取值非法；`blocked` 缺 `reason` 或 `link`；`refs` 中的需求编号不在需求第 4 章、架构章节号不是 `ARCHITECTURE.md` 的标题；`task` 不在看板上；需求第 4 章的某个编号既没有被任何能力引用、也不在 `client_only` 中 |
| 覆盖（需要 L2 报告） | `active` 能力没有任何场景引用：输出 `MISSING <ID>`；场景引用了清单中没有的 ID；报告来自筛选过的运行。`planned` 能力没有场景不失败；`blocked` 能力显示为 BLOCKED，不失败 |
| 里程碑门禁 | `--milestone Mx` 列出里程碑不晚于 Mx、仍为 `planned` 的能力，按任务分组并带上看板状态；任务已完成而能力仍为 `planned` 时失败 |
| 文档漂移 | `docs/product/capabilities.md` 与清单和 L2 报告重新生成的结果不同 |

`capabilities.md` 的内容只取决于清单与场景（ID、描述、里程碑、引用、任务、覆盖场景、状态），按 ID 排序，不含耗时与平台：同一份绿色结果在两个平台上生成同一个文件；被平台排除的场景仍算覆盖，名字后注明适用平台。覆盖它的场景失败时状态显示"失败"。

### 13.3 命令

| 命令 | 用途 |
|---|---|
| `node scripts/plan/check-capabilities.mjs` | 只检查清单 |
| `node scripts/plan/check-capabilities.mjs --results target/l2/results.json --doc check` | 覆盖检查与文档漂移（verify 第 14 步） |
| `node scripts/plan/check-capabilities.mjs --results target/l2/results.json --doc write` | 重新生成 `docs/product/capabilities.md` |
| `node scripts/plan/check-capabilities.mjs --milestone M2` | 评审任务（R2–R6）用：列出 M2 及之前未完成的能力 |

L2 报告来自 `cargo test -p piarc-testkit --test scenarios -- --results target/l2/results.json` 或 `cargo run -p piarc-devcli -- run tests/scenarios --json <文件>`。
