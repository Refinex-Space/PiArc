# piarc-host

Core 侧的 Agent Host 监管：启动、握手、stdio 读写、背压、心跳、重启、调用对账、stderr 日志（架构第 7.5 节、ADR-0009）。只依赖 `piarc-protocol` 与 `piarc-ports`；进程经注入的 `ProcessSpawner` 启动，时间经注入的 `Clock`。生产装配在 `piarc-core::agent_host::start`（`piarc-exec` 的启动器 + 系统时钟）。不负责回答 Agent Host 的请求（注入的 `InboundHandler`，T07 起由 `piarc-core::tool_io` 回答 `fs/*`、`exec/*`），也不负责会话编排（T14）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-host` | 单元测试 + `tests/resilience.rs`（S9 故障注入）+ `tests/logging.rs` |
| `cargo test -p piarc-host --test resilience -- --nocapture --test-threads 1` | 打印 S9 报告引用的观察值 |
| `cargo clippy -p piarc-host --all-targets -- -D warnings` | lint |

真实进程的测试在 `crates/piarc-testkit/tests/agent_host/`（需要 node，测试会先打包 Agent Host）；打包产物上的启动路径由 L4 `apps/desktop/e2e/agent-host.e2e.ts` 覆盖（`npm run package:desktop -- --flavor development` 之后）。

## 打包后的启动路径（T12）

- 装配在 `piarc-core::agent_host::start_bundled`：`BundledRuntime::locate(<process.resourcesPath>)` 找到 `agent-host/` 下的 node、`agent-host.mjs`、`pi-assets/`；`host_config` 生成本 crate 的 `HostConfig`。
- 环境变量：`DEFAULT_ENV_PASSTHROUGH` 去掉 `PATH`、`TMPDIR` 后照常透传；`extra_env` 设 `PATH`（内置 Node 的 `bin`、rg/fd 的 `bin/` 在前）、`TMPDIR` 与 `npm_config_cache`（数据目录下 `agent-host/tmp`、`agent-host/npm-cache`）、`npm_config_update_notifier=false`；`PI_PACKAGE_DIR` 经 `pi_package_dir`。
- macOS 的宽松 Seatbelt 配置在 `piarc-sandbox`（`agent_host_launch`，快照 `tests/snapshots/agent-host-profile.sbpl`）；Core 用 `LauncherSpawner` 把每次启动包成 `sandbox-exec -p … -- <node> …`，内层是 `ProcessTreeSpawner`。本 crate 不感知包装，重启时同样经过它。

## 重启策略

- 任何非 `shutdown` 的结束（崩溃、启动失败、握手超时、心跳判定挂死、`kill()`）都计入 `RestartPolicy`：退避 1、2、4、8、16 s（上限 30 s），10 分钟滑动窗口内最多 5 次重启，下一次失败发 `GaveUp` 并停止。
- 握手被拒（主版本不同、`host/hello` 格式错误）不重启，直接 `Stopped`。
- 重启后对经 `create_session` 打开的会话依次 `session/resume`（带 `lastSeq`），失败的会话从跟踪表移除并发 `SessionRestoreFailed`。

## 背压

- 写：请求经有界队列（`write_queue_frames`，默认 256）写 stdin；满时 `call` 立即返回可重试的 `Error::Busy`，请求不进账本。
- 读：stdout 持续解帧。响应直接交给调用方；会话通知与 `FrameError` 各占一个许可（`event_queue`，默认 1,024），`HostEvents::recv` 取走后释放；许可用完时读取停住，压力传给 Agent Host。生命周期事件不占许可，所以重启、关闭不等消费者。
- 心跳超时只在"没有新帧且读取没有停在投递上"时计为失败，连续 `heartbeat_failures`（2）次判为挂死。

## 调用对账

- `CallState`：`Sent` → `Terminal`；`session/prompt` 为 `Sent` → `Acknowledged`（回复带 `turnId`）→ `Terminal`（收到同一 `turnId` 的 `turn/completed`）。终态立即移出账本，账本只含在途调用。
- 连接结束时该 epoch 的在途调用变为 `Uncertain`，经 `HostEvent::Uncertain` 上报一次，从不重放；等待中的调用返回 `Error::Uncertain`（不可重试）。
- 状态转换都在读取任务上按帧顺序发生；进程退出后先等读取读完 stdout（最多 2 s）再判定，已回复的调用不会被误标。
- 超时（`Error::Timeout`）不改账本：迟到的回复照样记为终态。

## 入站请求

- 每个入站请求在独立任务里交给 `InboundHandler::handle(method, params, peer)`；`Peer` 绑定该连接的写队列，`notify::<M>()` 发出的通知与随后的响应同序写出（`exec/output` 先于 `exec/run` 的响应）。写队列满时 `notify` 等待，连接结束时返回 `PeerClosed`；`Peer::closed()` 在连接结束时完成，`is_closed()` 查询是否已结束，`same_connection()` 判断两个 `Peer` 是否同一连接（凭据变更订阅去重）。
- Agent Host 的请求与会话通知共用 stdout：读取停在投递上时（许可用完），后面的请求也读不到，工具 I/O 随之等待（S4 第 10 节，I19）。

## 不变量

- 功能 crate 不直接启动进程、不读系统时钟做判断：经 `ProcessSpawner` 与 `Clock`。超时与心跳间隔用 tokio 计时器。
- 启动环境只含 `DEFAULT_ENV_PASSTHROUGH` 中存在的变量、`PI_SKIP_VERSION_CHECK=1`、`PI_TELEMETRY=0`、`PI_PACKAGE_DIR` 与配置的 `extra_env`；不传凭据。
- 帧错误（非法 JSON、超长帧、批量请求、缺会话头的通知）只报告并丢弃，不断开连接（架构第 7.4 节）。
- stderr 每行一个 `tracing` 事件，target `piarc_host::agent_host`，字段 `workspace`、`session`、`epoch`；行长超过 16 KiB 截断。

## 易错点

- 不要在等待 `HostEvents` 之外阻塞消费者却又期待通知继续流动：通知受许可数约束。生命周期事件不受影响。
- Windows 上 Agent Host 写 stdout 是同步的：Core 停读时 Agent Host 整个停住（不再处理 Core 发来的请求），而不是在内存里排队；心跳仍按"读者停在投递上不计失败"的规则不误判（S9 报告第 5 节）。
- 测试用 `tests/support` 的 `FakeSpawner`（脚本化的假 Agent Host，duplex 管道）与 `TestClock`（只在 sleep 时前进）。假 Agent Host 空闲时用 `until_stdin_closes`，它会回答心跳与 `host/shutdown`；否则 `shutdown()` 要等 `shutdown_timeout`。
- `Link` 的克隆不控制 stdin 的关闭：关闭靠 `close_stdin`（`request_shutdown` 与连接结束时触发）。入站任务持有的 `Peer` 也是写队列的发送端，连接结束后要靠 `close_stdin` 让写任务丢弃队列，`Peer::closed()` 才完成（R1-A2）。

## 参考

- 架构第 7.4、7.5 节；ADR-0009、ADR-0010；`docs/spikes/S09-ahp-resilience.md`。
