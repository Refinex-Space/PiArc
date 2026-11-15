# 测试规范

测试分层沿用架构第 12.1 节，纪律沿用第 12.6 节。每层的目录、命名与命令以本文为准；某层由后续任务建立时，那个任务负责补全本文对应的小节。

## 1. 分层

| 层 | 内容 | 位置与命名 | 命令 | 运行时机 | 建立任务 |
|---|---|---|---|---|---|
| L0 单元（Rust） | 权限、Bash 分析、hooks 决策、快照、diff、终端状态等纯逻辑 | 同文件 `#[cfg(test)] mod tests`；跨模块的放 `crates/<crate>/tests/*.rs` | `cargo test -p <crate>`；全部：`cargo test --workspace` | 每次提交 | T01 |
| L0 单元（TS） | 投影、工具包装、Harness Kit；渲染进程的 store 归约器、Markdown 增量解析、交互规则纯函数；仓库脚本 | 与源文件同目录：`foo.ts` ↔ `foo.test.ts`，脚本为 `foo.test.mjs` | `npm test`；单个文件：`npx vitest run <路径>` | 每次提交 | T01 |
| L1 契约 | AHP schema 往返、录制事件样本的反序列化与再序列化、Pi 事件到 AHP 投影的 golden、NAPI 导出声明与 preload API 快照 | 样本：`tests/contracts/<契约名>/*.json`，反例在其下的 `invalid/`；Rust：`crates/piarc-protocol/tests/*.rs`；TS：`packages/protocol/src/*.test.ts`；NAPI 声明快照：`apps/desktop/src/main/core/native/*.d.ts`；见第 7 节 | `cargo test -p piarc-protocol`、`npx vitest run packages/protocol`、`node scripts/ci/check-core-types.mjs`；全部由 `npm run verify` 运行 | 每次提交 | T02、T04 |
| L2 场景回放 | 无头运行 Core + 真实 Agent Host，模型侧接严格校验请求的 mock provider，按场景数据文件驱动 | `tests/scenarios/<场景 id>.yaml`，文件名与 `id` 一致；运行器在 `piarc-testkit`，驱动在 `piarc-devcli`；模型侧的 mock provider 见第 10 节 | T15 补充 | 每次提交 | T05、T15 |
| L3 行为对齐 | 对真实 Claude Code 录制同一批场景，与 PiArc 做结构化 diff | 有意偏离写在 `tests/l3-allowlist.yaml` | T30 补充 | 每晚 / 手动 | T30 |
| L4 客户端 | Playwright 驱动 Electron 应用（开发形态与打包产物）；关键组件视觉快照；录制事件流驱动渲染进程（假 Core） | `apps/desktop/e2e/*.e2e.ts`；见第 9 节 | 先 `npm run package:desktop -- --flavor development`，再 `npm run test:e2e -w @piarc/desktop` | 每次提交（CI `desktop` 作业）/ 每晚（UI 流程） | T03、T19 |
| 安全回归 | Markdown 与链接渲染的 XSS 载荷集、preload API 越权调用、外部导航拦截（架构第 10.3 节） | Electron 层：L4 的 `csp`、`navigation`、`external-links`、`preload`、`permissions`、`app-instance` 用例；纯函数（来源校验、外链白名单、CSP、资源路径）：`apps/desktop/src/main/**/*.test.ts`；XSS 载荷集由 T09 加入 | 纯函数部分由 `npm run verify` 运行；Electron 层同 L4 | 每次提交 | T03 起 |
| 性能 | 架构第 11 章的预算，两个平台分别测量 | S2：`scripts/bench/s2-event-channel.mjs`；其余 T44 补充 | `npm run bench:s2`（本机，数字不在 verify 中断言）；其余 T44 补充 | 每次提交（冒烟）/ 每晚（完整） | T04、T09、T10、T44 |
| 多服务商 | 部分 L2 场景对真实服务商运行 | 与 L2 场景共用，按标记筛选 | 手动或每晚，需要密钥与预算（第 8 节） | 每晚，可选 | R2 起 |

## 2. 质量门禁

`npm run verify`（`scripts/dev/verify.mjs`）按顺序执行全部 13 项检查，一步失败后继续执行后续步骤，最后打印汇总表，任一步失败则退出码非 0：

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

CI（`.github/workflows/ci.yml`）在 `macos-latest`（arm64）与 `windows-latest`（x64）上执行 `npm ci --ignore-scripts` 与 `npm run verify`。后续任务新增的检查（L1 契约、L2 场景、schema 漂移等）都接进 verify，使本地与 CI 运行同一套检查。

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
  cache_breakpoints:               # 仅 Anthropic
    max_message_level: 1           # messages 内最多几个断点，默认 1（架构第 6.15 节）
    last_message_only: false       # 消息级断点必须在最后一条消息
steps:
  - text: "Reading the file."      # 分 3 段 text 增量
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
      kind: rate_limit             # rate_limit 429 | overloaded 529 | server_error 500 | unavailable 503
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
| `system_sections` | system（Anthropic 的 `system` 与 `system` 角色消息，OpenAI 的 `system`/`developer` 消息）包含场景要求的每段文本 |
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
