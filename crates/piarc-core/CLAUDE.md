# piarc-core

Core 的运行时门面：tokio 多线程运行时、事件队列与合并器、有序关闭、任务监督；`agent_host` 模块把 `piarc-host` 的监管器与生产 I/O（`piarc-exec` 的进程启动器、`SystemClock`）装配起来，是 Agent Host 测试的无头入口（T06）；`tool_io` 应答 Agent Host 委托的 `fs/*`、`exec/*`（T07）；`secrets` 把凭据保险箱提供给所有 Agent Host（`secrets/*`，T08），`identity` 是应用标识的唯一定义。工作区与会话编排由 T13、T14 加入。不负责 JavaScript 绑定（`piarc-napi`）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-core` | 单元测试 + `tests/event_channel.rs`（回调频率、无丢失与顺序、背压、有序关闭、任务 panic、未关闭直接丢弃）+ `tests/tool_io.rs`（越界、流式输出、取消、会话隔离）+ `tests/secrets.rs`（推送、保险箱错误、锁与租约、并发读改写） |
| `cargo clippy -p piarc-core --all-targets -- -D warnings` | lint |

## 运行时与关闭顺序

- `CoreRuntime::start(config, sink)` 建运行时并启动合并器；`shutdown(cb)` 在专用线程上执行：拒绝新请求（`ShuttingDown`）→ 取消根 `CancellationToken` 并等演示事件源结束 → 关闭队列、合并器排空并投递最后一批、等客户端处理完（最多 5 s）→ 合并器丢弃 sink（NAPI 下即释放 `ThreadsafeFunction`）→ `shutdown_timeout` 停运行时 → 回调。
- 回调之后 sink 不会再被调用。`Drop` 未关闭的运行时只做取消与 `shutdown_background`，没有最后一批。
- 长任务从根 token 取子 token；新任务经 `spawn_supervised` 启动：panic 打到 stderr，并作为结构化错误事件发到 `core/errors`。合并器自身 panic 时由监督者直接向 sink 投递一个 `seq` 为 0 的带外批次。

## 事件合并器（`events.rs` 模块文档为准）

- 批次 = 路由键 + 每路由从 1 起连续的批次序号 + 载荷（该路由事件的 UTF-8 JSON 数组）。主进程只看路由键。
- 刷出时机：不早于首个待发事件到达，且距上次刷出至少一个间隔（默认 16 ms，1–1000 ms 可配）。无待发事件时不跑定时器。
- 满时策略，任何情况都不丢事件：最多 1 个在途投递（sink 丢弃 `DeliveryDone` 才算完成），期间继续在待发批次里累积；待发超过 64 MiB 停止读队列，队列（65,536 个事件）满后异步生产者等待，同步调用（`echo`）返回可重试的 `QueueFull`（kind `busy`）。只有 sink 报告 `SinkClosed`（JS 环境已销毁）时才丢弃并计入 `lost`。

## 委托的工具 I/O（`tool_io`）

- `ToolIo` 按会话登记的 `Scope`（工作区根 + cwd）应答 `fs/*`（`piarc-fs`，放在阻塞线程池）与 `exec/*`（`piarc-exec`）；未登记的会话返回 `sessionNotFound`。登记现由测试做（`open_session`），T14 的会话层接手。
- `exec/run` 的输出经入站请求带来的 `Peer` 以 `exec/output` 发回，`forward_output` 先发完再回响应；连接断开（`Peer::closed`）或 `exec/kill` 终止命令。
- 命令环境 = `piarc_host::DEFAULT_ENV_PASSTHROUGH` 中 Core 自己有的变量 + 请求的 `env` 叠加（同名覆盖，Windows 不区分大小写）；凭据不在白名单里。
- blob 放在 `<数据目录>/sessions/<会话 id>/blobs/`；会话 id 只允许 `[A-Za-z0-9._-]`，不能是 `.`、`..`。

## 凭据（`secrets`）

- 一个 Core 只建一个 `SecretsService`，所有 Agent Host 的 `InboundHandler` 共用它（Core 是保险箱唯一写入方）。保险箱在第一次请求时打开，失败只让这次请求失败，下一次重新打开（用户授权钥匙串后不用重启）。保险箱操作放在阻塞线程池。
- 订阅：调用过 `secrets/getAll` 的连接收到每次写入的 `secrets/changed`；每个连接一个推送任务，关闭的连接在下一次推送时移除。
- 锁：`secrets/lock` 一组键一起锁，任一被占就等待；未带 `lockId` 的写入临时锁该键；`unlock`、租约（`DEFAULT_LOCK_LEASE` 30 s）、持有者连接结束都会释放；失效的 `lockId` 写入返回 `secretLockLost`。
- 参数错误不带 serde 的原文（它会引用出错的值，可能是凭据）。不要在日志里写值。
- 测试与 `piarc-testkit` 经本模块的再导出使用 `MemorySecretStore`、`test_master_key_name`（testkit 不能直接依赖 `piarc-secrets`）。
- `identity::APP_IDENTIFIER` 是 D2 落实前的占位值；改它会让已有保险箱找不到主密钥（`PLAN.md` I22）。

## 不变量

- 同步方法（`echo`）只做校验与 `try_send`，不做 I/O、不拿长时间持有的锁（架构第 7.2 节，单次预算 1 ms）。
- 路由键语法：1–128 个 `[A-Za-z0-9._:/-]`；`core/` 前缀保留给 Core 自己的事件，客户端传入会被拒绝。主进程 `src/shared/ipc.ts` 的 `isRouteKey` 与之保持一致。
- 错误映射为 `piarc_protocol::ErrorObject`：`ShuttingDown` → `shuttingDown`，`QueueFull` → `busy`（唯一可重试），参数错误 → `invalidParams`，其余 → `internalError`。
- 演示事件源（`demo.rs`）只给测试与基准用；发布构建的 `piarc-napi` 不导出启动它的函数。

## 易错点

- 不能在运行时线程或 sink 投递所在的线程上调用 `shutdown_blocking`：最后一批要等那个线程处理完。JS 侧用 `shutdown()` 返回的 Promise。
- 不要在异步任务里持有 `Arc<Shared>`：`Shared` 的 `Drop` 会停运行时，在运行时线程里丢弃会出问题。

## 参考

- 架构第 7.2、7.6 节；ADR-0014；`docs/spikes/S02-napi-event-channel.md`。
