# piarc-napi

NAPI-RS 导出层（薄）：把 `piarc_core::CoreRuntime` 暴露为主进程里的 `CoreRuntime` 类，产出各平台 `.node`（ADR-0014）。不放业务逻辑，不被渲染进程加载。

## 命令

| 命令 | 用途 |
|---|---|
| `npm run build:core` | 构建本机的 `development` 版（含 `testing` 导出）到 `target/piarc-core/development/`，并更新 `.d.ts` 快照 |
| `npm run build:core -- --flavor all` | 两种构建都出，两个快照都更新；改了导出后运行并提交快照 |
| `node scripts/dev/build-core.mjs --flavor all --target <triple>` | 交叉构建四个目标之一（需要 `rustup target add <triple>`） |
| `node scripts/ci/check-core-types.mjs` | L1 快照检查（verify 第 4 步），同时留下 Vitest 集成测试要加载的开发构建 |
| `node scripts/ci/load-core.mjs --module <file.node>` | 在 Node 与 Electron 中加载并跑一次事件通道（CI `core-load` 作业） |
| `cargo clippy -p piarc-napi --all-targets --features testing -- -D warnings` | lint（也跑一遍不带 feature 的） |

## 不变量

- `createSession` 可显式选择权限模式，`setPermissionMode` 把选择写入会话，`answerApproval` 校验并答复一张卡；保存永久规则的原生确认在主进程。

- 终端导出（T10）：`createTerminal`、`terminalInput`、`terminalKey`、`terminalResize`、`terminalFrame`（`JsDeferred` 解析为帧字节，主进程把它作为拉取请求的返回值交给窗口，ADR-0023）、`closeTerminal` 在两种构建里都有；`terminalText`、`terminalStats`、`terminalProbeEcho` 只在 `testing`。Windows 的 `.node` 依赖同目录的 `ghostty-vt.dll`（`crates/piarc-term/AGENTS.md`）。

- 每个导出都带 `#[napi(catch_unwind)]`，函数体经 `boundary::call`：Core 错误与 panic 都变成抛出的 `Error`，带 `code` 与 `data: { kind, retryable, details? }`（`piarc_protocol::ErrorObject` 形状）。panic 的 kind 是 `internalError`。
- `onEvents` 是强引用的 `ThreadsafeFunction`（`CalleeHandled = false`），会让 Node 事件循环保持存活；只有 Core 的有序关闭（合并器丢弃 sink）释放它。主进程必须在退出前 `await shutdown()`（`apps/desktop/src/main/core/core-host.ts`）。
- 每次投递用 `call_with_return_value`，回调里丢弃 `DeliveryDone`；监听器抛异常只打 stderr，投递照样算完成。调用返回非 `Ok`（JS 环境已销毁）时报告 `SinkClosed`。
- Promise 用 `JsDeferred` 由 Core 自己的运行时结算，不用 `#[napi] async fn`（它会另起 NAPI-RS 的全局 tokio 运行时）。
- `testing` feature 只给开发构建：演示事件源、`echo`、`eventStats`、`triggerPanic`、`spawnPanickingTask`。发布构建不带。
- `.d.ts` 快照在 `apps/desktop/src/main/core/native/`：`piarc-core.d.ts`（发布）与 `piarc-core.testing.d.ts`（开发），由构建脚本经 Prettier 格式化写入，不手改。字符串枚举生成为类型联合（`constEnum: false`）。
- 会话的文本入口始终把字符串当作用户正文（包括 JSON 文本）。主进程将带提及、附件或指定幂等键的输入交给 `promptInput`、`steerInput`、`followUpInput`（ADR-0030）。

## 易错点

- 改了导出签名不更新快照，verify 的 "Core module + API snapshot" 失败；运行 `npm run build:core -- --flavor all` 后提交。
- 参数是 `ThreadsafeFunction` 时，生成的 `.d.ts` 会写出 Rust 类型别名名，必须用 `#[napi(ts_arg_type = "...")]` 给出 TS 签名。
- Electron 不允许外部 buffer（V8 内存笼），NAPI-RS 退回复制：`Uint8Array::from(Vec<u8>)` 在 Electron 里会多一次拷贝。
- `@napi-rs/cli` 的 `features` 传空数组会生成 `--features ''` 导致 cargo 报错；没有 feature 时不传。

## 参考

- 架构第 7.1、7.6 节；ADR-0014；`crates/piarc-core/AGENTS.md`；`docs/spikes/S02-napi-event-channel.md`。
