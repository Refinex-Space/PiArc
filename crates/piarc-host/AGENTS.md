# piarc-host

Core 侧的 Agent Host 监管：启动、握手、stdio 读写、背压、心跳、重启、调用对账、stderr 日志（架构第 7.5 节、ADR-0009）。只依赖 `piarc-protocol` 与 `piarc-ports`；进程经注入的 `ProcessSpawner` 启动，时间经注入的 `Clock`。生产装配在 `piarc-core::agent_host::start`（`piarc-exec` 的启动器 + 系统时钟）。不负责回答 Agent Host 的请求（注入的 `InboundHandler`，T07 起由 `piarc-core::tool_io` 回答 `fs/*`、`exec/*`），也不负责会话编排（`piarc-core::sessions`，T14）。

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
- `restart()`（T13）是计划内重启：`host/shutdown` 后立即启动新进程，`Exited` 的原因为 `Restarted`，不计入 `RestartPolicy`、不退避、不发 `Restarting`；会话照常 `session/resume`。项目信任变化时由 `piarc-core::agent_host::restart_on_trust_change` 调用。
- 跟踪表：`create_session`、`resume_session`、`fork_session` 成功的会话都进入跟踪表；`create_session` 带 Core 选定的 id 而结果未知（`Error::outcome_unknown()`：超时或连接中断）时同样按该 id 跟踪，下一次连接以 `session/resume` 收敛（R1-A3）。`resume_session` 的 `last_seq` 取跟踪值与传入值的较大者。
- 重启后对跟踪表中的会话依次 `session/resume`（带 `lastSeq`）：Agent Host 拒绝或答非所问的会话从跟踪表移除并发 `SessionRestoreFailed`；超时、写队列满的会话保留并发 `SessionRestoreFailed`；连接中途结束时停止本轮，未恢复的会话留到下一次连接（R1-A1）。恢复在命令循环里与关闭、Kill、连接结束一起 `select`：新进程不回答恢复请求时 `shutdown()` 不必等调用超时（R1-A4）。`Kill` 带目标连接的 epoch（心跳判定挂死时），只结束那一次连接，不会误杀之后的新进程（R1-A10）。

- 新连接完成握手时，跟踪的会话可能仍在恢复。会话请求在进入调用账本和写队列之前等待该会话的恢复结果。创建其他会话、心跳和宿主关闭可直接使用连接。恢复中断时仍在等待的请求按未送达处理。

## 背压

- 写：请求经有界队列（`write_queue_frames`，默认 256）写 stdin；满时 `call` 立即返回可重试的 `Error::Busy`，请求不进账本。
- 读：stdout 持续解帧。响应直接交给调用方；会话通知与 `FrameError` 各占一个许可（`event_queue`，默认 1,024），`HostEvents::recv` 取走后释放；许可用完时读取停住，压力传给 Agent Host。生命周期事件不占许可，所以重启、关闭不等消费者。
- 心跳超时只在"没有新帧且读取没有停在投递上"时计为失败，连续 `heartbeat_failures`（2）次判为挂死。

- 模型设置方法依赖握手能力 `models`。工作区的 `allowModelNetwork` 每次握手时从 Core 当前偏好读取，包括同一监管器崩溃重启后的握手。

## 调用对账

- `CallState`：`Sent` → `Terminal`；`session/prompt` 为 `Sent` → `Acknowledged`（回复带 `turnId`）→ `Terminal`（收到同一 `turnId` 的 `turn/completed`）。终态立即移出账本，账本只含在途调用。
- 连接结束时该 epoch 的在途调用变为 `Uncertain`，经 `HostEvent::Uncertain` 上报一次，从不重放；等待中的调用返回 `Error::Uncertain`（不可重试）。
- 状态转换都在读取任务上按帧顺序发生；进程退出后先等读取读完 stdout（最多 2 s）再判定，已回复的调用不会被误标。
- 超时（`Error::Timeout`）不改账本：迟到的回复照样记为终态。

## 入站请求

- 只有 Core 接受了握手（`core/welcome` 已发出）的连接才分发入站请求；握手前或被拒后的请求直接回错误，不到处理者（R1-A7）。同时处理的入站请求至多 `inbound_concurrency`（默认 256）个，许可用完时读取停住（R1-A14，I58）。
- 每个入站请求在独立任务里交给 `InboundHandler::handle(method, params, peer)`；`Peer` 绑定该连接的写队列，`notify::<M>()` 发出的通知与随后的响应同序写出（`exec/output` 先于 `exec/run` 的响应）。写队列满时 `notify` 等待，连接结束时返回 `PeerClosed`；`Peer::closed()` 在连接结束时完成，`is_closed()` 查询是否已结束，`same_connection()` 判断两个 `Peer` 是否同一连接（凭据变更订阅去重）。
- Agent Host 的请求与会话通知共用 stdout：读取停在投递上时（许可用完），后面的请求也读不到，工具 I/O 随之等待（S4 第 10 节，I19）。

## 不变量

- `HostSupervisor::set_permission_mode` 经 `session_call` 向相应会话发送 `session/setPermissionMode`。模式条目由 Agent Host 写入，确认后 Core 才更新会话快照。失联时审批按连接代次作废，恢复请求中缺失的工具结果由 Host 经 `policy/recover` 查询。

- 功能 crate 不直接启动进程、不读系统时钟做判断：经 `ProcessSpawner` 与 `Clock`。超时与心跳间隔用 tokio 计时器。
- 启动环境只含 `DEFAULT_ENV_PASSTHROUGH` 中存在的变量、`PI_SKIP_VERSION_CHECK=1`、`PI_TELEMETRY=0`、`PI_PACKAGE_DIR` 与配置的 `extra_env`；不传凭据。
- 帧错误（非法 JSON、超长帧、批量请求、缺会话头的通知）只报告并丢弃，不断开连接（架构第 7.4 节）。例外是 `connection.rs` 的 `HOST_NOTIFICATIONS`（T36 起只有 `mcp/statusChanged`）：这些工作区级通知没有会话头，作为 `HostEvent::HostNotification { epoch, method, params }` 交给 Core；新增这类通知要加进该列表。
- stderr 每行一个 `tracing` 事件，target `piarc_host::agent_host`，字段 `workspace`、`session`、`epoch`；行长超过 16 KiB 截断。

## 易错点

- 不要在等待 `HostEvents` 之外阻塞消费者却又期待通知继续流动：通知受许可数约束。生命周期事件不受影响。
- Windows 上 Agent Host 写 stdout 是同步的：Core 停读时 Agent Host 整个停住（不再处理 Core 发来的请求），而不是在内存里排队；心跳仍按"读者停在投递上不计失败"的规则不误判（S9 报告第 5 节）。
- 测试用 `tests/support` 的 `FakeSpawner`（脚本化的假 Agent Host，duplex 管道）与 `TestClock`（只在 sleep 时前进）。假 Agent Host 空闲时用 `until_stdin_closes`，它会回答心跳与 `host/shutdown`；否则 `shutdown()` 要等 `shutdown_timeout`。
- `Link` 的克隆不控制 stdin 的关闭：关闭靠 `close_stdin`（`request_shutdown` 与连接结束时触发）。入站任务持有的 `Peer` 也是写队列的发送端，连接结束后要靠 `close_stdin` 让写任务丢弃队列，`Peer::closed()` 才完成（R1-A2）。

## 参考

- 架构第 7.4、7.5 节；ADR-0009、ADR-0010；`docs/spikes/S09-ahp-resilience.md`。
