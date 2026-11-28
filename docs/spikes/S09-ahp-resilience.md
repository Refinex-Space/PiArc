# S9 AHP 握手、背压、崩溃重启与调用对账

- 任务：T06（2026-11-15）
- 范围：Core 侧 `piarc-host` 监管 Agent Host 的握手、帧错误、背压、心跳、重启与调用对账，在故障注入下是否行为正确（ADR-0009 的前提）。
- 结论：macOS **通过**。六类注入全部按 ADR-0009 与架构第 7.5 节的规定处理，Core 不崩溃，不触发 ADR-0009 的重新评估。背压方式选定为"写队列满时新请求返回可重试的 `busy`"（第 4 节）。Windows（W0）**通过**，背压的表现形式不同，结论不变（第 5 节）。

## 1. 验证环境

与 S3 相同（`S03-multi-session.md` 第 1 节）：macOS 26.5.2 arm64，Node 24.14.1，Pi 1.5.2，Rust 1.99.1，tokio 1.54.1。

## 2. 做了什么

两层测试：

| 层 | 位置 | 替身 | 覆盖 |
|---|---|---|---|
| 确定性故障注入 | `crates/piarc-host/tests/resilience.rs`、`logging.rs` | 内存中的进程启动器（`tests/support`）：每次"启动"运行一段脚本化的假 Agent Host，经 tokio duplex 管道收发字节，能按脚本发半帧、非法 JSON、超长帧、批量请求、崩溃或不再读 stdin；测试时钟只在 sleep 时前进 | 握手、帧错误、挂死、背压、写队列满、连续崩溃、对账、日志 |
| 真实进程 | `crates/piarc-testkit/tests/agent_host/` | 真实 Agent Host bundle 与 mock provider；mock 新增 `stall_after_events`：发出前 N 个事件后保持连接不再发送，用于在确定的时点中断或杀进程 | 进行中的提示词期间杀进程、慢读者 |

两层都不靠 sleep 判断结果：等待的是事件或条件，超时只作安全网。

## 3. 注入与结果

| 注入 | 期望 | 结果 | 测试 |
|---|---|---|---|
| 进行中的提示词期间杀掉 Agent Host | 检测到退出，退避重启，恢复会话；进行中的请求标为 `uncertain` | 通过。假 Agent Host：`session/prompt` 已确认（`acknowledged`）、`session/abort` 已发送未回复（`sent`），杀进程后两者都报为 `uncertain`，等待中的 `abort` 调用返回不可重试的 `Uncertain` 错误；1 s 后重启（epoch 2），Core 以 `session/resume`（带 `lastSeq`）恢复会话，不重放任何调用。真实 Agent Host：在模型流挂起时 SIGKILL，`Exited{reason: Killed, signal: 9}` → `Uncertain`（该提示词）→ `Restarting{attempt: 1, delay: 1s}` → `Connected{epoch: 2}` → `SessionRestored{restored_messages: 2}`；恢复后的会话继续对话，请求中仍有第一条提示词；该会话的 `seq` 跨两个连接从 1 连续到 10 | `killing_the_host_mid_prompt_…`（两层各一个） |
| Agent Host 输出半帧后挂起 | 超时后按挂死处理，Core 不崩溃 | 通过。半帧留在解码器缓冲中；心跳（测试中 20 ms 间隔、20 ms 超时）连续两次无响应且期间没有任何新帧，判为挂死并 SIGKILL：`Exited{reason: Hung}`，随后重启，新连接上的调用正常 | `a_half_frame_followed_by_silence_…` |
| 非法 JSON、超长帧 | 记录错误，丢弃该帧，Core 不崩溃 | 通过。依次注入非法 JSON、超过上限（测试中 1 KiB）的帧、JSON 数组（批量请求）、缺少会话头的通知，得到 `FrameError` 事件 `[parseError, frameTooLarge, invalidRequest, invalidRequest]` 与 `tracing` 警告；连接不中断，之后的通知与调用照常处理。按架构第 7.4 节，超长帧丢弃到下一个 LF，不断开重连 | `invalid_json_oversized_frames_and_batches_…` |
| Core 读取变慢 | 背压生效，Agent Host 不无限缓冲，内存有界 | 通过。假 Agent Host 连续发 5,000 条通知，Core 的事件队列 8、管道 4 KiB、消费者不读：假 Agent Host 写到第 51 条后被阻塞；恢复读取后 5,000 条按序到达，期间心跳不把它判为挂死。真实 Agent Host：事件队列 1，一个回合产生 205 条通知、891 KB，Core 停止读取期间 Agent Host 的出站队列峰值 758 KB（低于本回合产生的总量），全部通知按序到达、`seq` 连续，进程没有被杀 | `a_slow_event_consumer_…`、`a_slow_core_reader_…` |
| 主版本不匹配的 `host/hello` | 握手被拒绝，错误可读 | 通过。Core 回 `-32000`、`data.kind: protocolVersionMismatch`、`details: {local: "1.0", remote: "2.0"}`，消息为 "protocol major version mismatch: local speaks 1.0, remote speaks 2.0; update the older side so both use the same major version"；Core 报 `HandshakeRejected`、`Exited{reason: HandshakeRejected}`、`Stopped`，不重启。真实 Agent Host（Core 改说 `2.0`）记录 `handshake failed` 后以退出码 3 退出 | `refuses_a_different_major_version_…`、`the_real_agent_host_exits_readably_…` |
| 10 分钟内连续崩溃 6 次 | 第 6 次后停止重启并上报 | 通过。每次握手后立即以退出码 1 退出：6 次崩溃、5 次重启（退避 1、2、4、8、16 s，测试时钟共前进 31 s），第 6 次崩溃后 `GaveUp{restarts: 5}`、`Stopped`，之后的调用返回 `shuttingDown`。10 分钟窗口的滑动在 `restart.rs` 的单元测试中验证 | `gives_up_after_the_sixth_crash_…` |

另外验证的行为：

- 握手成功时交换版本与能力：假 Agent Host 宣告 `1.0`、`[todo, planMode]`，Core 支持 `[planMode, subagents]`，`core/welcome` 为 `{protocol: "1.0", enabled: ["planMode"], workspace, connectionEpoch: 1}`。真实 Agent Host 宣告 Pi 版本 `1.5.2`、能力为空。
- 10 s 内没有 `host/hello`：杀进程，按崩溃计入重启策略（`HandshakeTimeout`）。
- `host/shutdown`：Agent Host 关闭所有会话、回复后以 0 退出，Core 不重启。消费者完全不读事件时，关闭与重启也照常完成（`shutdown_and_restarts_never_wait_for_a_consumer_that_stopped_reading`）。
- 连接未建立时的调用返回可重试的 `hostUnavailable`。
- stderr 每行进入 `tracing`（target `piarc_host::agent_host`），字段 `workspace`、`session`（取自 `[session <id>] ` 前缀）、`epoch`。

## 4. 设计取舍

- **写入背压：返回可重试错误，不等待。** Core 发往 Agent Host 的帧经有界队列（默认 256 帧）写入 stdin；队列满时 `call` 立即返回 `busy`（`retryable: true`），请求不进入对账账本。选它而不是"等待"：与 Core 事件通道的同步调用一致（T04 的 `busy`），调用方能立即知道 Agent Host 不再读 stdin，内存上限是队列容量。测试：`a_full_write_queue_refuses_new_calls_with_a_retryable_busy_error`（stdin 管道 1 KiB、队列 4：第 6 个调用得到 `busy`）。
- **读取背压：读者等消费者。** stdout 持续读取并解帧；响应直接交给等待的调用方，不进事件队列。会话通知与帧错误每条占一个许可（默认 1,024），消费者取走后释放；许可用完时读者停在投递上，不再读 stdout，压力传到 Agent Host。监管器自身的生命周期事件（连接、退出、`uncertain`、重启、停止）不占许可，所以消费者停住时重启与关闭仍能完成。
- **心跳与背压的区分。** 心跳超时只在"期间没有收到任何帧，且读者没有停在投递上"时计为失败，连续 2 次视为挂死。被背压的 Agent Host 仍活着，不会被误杀。
- **Agent Host 侧不无限缓冲。** Agent Host 只经出站队列写 stdout：`write()` 返回 false 后等 `drain` 再写下一帧；等待中的同一条目的文本增量合并成一帧，所以积压按产生的文本量增长、不按增量条数增长；`seq` 在写出时分配，合并不产生缺口。积压超过 64 MiB 时 Agent Host 记录错误并以退出码 70 退出，由 Core 重启，内存因此有上限。
- **`seq` 跨重启连续。** Core 记录每个会话收到的最大 `seq`，重启后在 `session/resume` 中以可选的 `lastSeq` 传回；新的 Agent Host 从下一个数继续编号（协议补充，架构第 7.4 节同步）。
- **不重放。** `uncertain` 的调用只上报，由会话层决定重试或提示用户（ADR-0009 第 5 条）；`session/prompt` 的 `requestId` 是幂等键，同一个 Agent Host 进程内重复的键返回已开始的回合，不再请求模型（S3 第一个测试中验证）；重启后的新进程不认识旧键，这正是 Core 不自动重放的原因。

## 5. 结论与后续

- S9 在 macOS 上通过，ADR-0009 的前提成立。
- I17：`piarc-exec` 的进程启动器只终止直接子进程。Agent Host 被杀时，它启动的 bash 命令与 MCP server 不随之结束；进程组与 Job Object 由 T17 实现，T12 接入。
- 会话通知的缺口补齐（`session/getEntries(since)`）与投影到客户端由 T14 完成。
- Windows（W0，Windows 11 专业版 25H2，机器见 S2 报告第 8 节）：`crates/piarc-host` 的注入用例与 `piarc-testkit` 的真实进程用例在本机通过。CI 运行 43827342553 的 verify 作业在更早的失败处停止，没有跑到这些用例。
- **Windows 上 Node 写管道式 stdout 是同步的**（Node 的 `net.Socket` 对 Windows 上 fd 1、2 的管道调用 `setBlocking(true)`）。实验：父进程停读 3 秒，子进程的 32 次 64 KiB 写入就阻塞 3 秒，期间定时器一次也没有运行，`writableLength` 始终为 0。所以 Core 停止读取时，Agent Host 的事件循环停在写入上，而不是像 macOS 那样在出站队列里排队、继续完成回合。慢读者用例（事件队列 1、一个回合 207 条通知、892 KB）在 Windows 上的结果：
  - Core 停读期间，Pi 停在第一次模型请求，不会发第二次；
  - 恢复读取后回合完成，通知按序到达、`seq` 连续，进程没有被判为挂死；
  - 出站队列峰值 4.4 KB（macOS 758 KB）。

  第 3 节的"内存有界、不丢失、不误判挂死"仍然成立。不同的是，停读期间 Agent Host 不能再处理任何东西，包括 Core 发来的请求。Core 的事件消费者应持续取走事件（I19），这一点在 Windows 上更重要。用例按平台断言（提交 9d6b01b），其余断言两个平台相同。
