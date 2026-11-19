# 0041. Windows 上小文件 fs 操作的 AHP 往返预算

- 状态：已接受（2026-11-19，用户在 W1 会话中采纳）
- 日期：2026-11-19
- 修订：架构第 11 章"AHP 往返（小文件 fs 操作）"一行（p95 ≤ 5 ms）的 Windows 口径
- 相关：T07-A10、W1、[ADR-0036](0036-bind-file-operations-to-directory-handles.md)、[ADR-0040](0040-windows-automatic-permission-budget.md)、`crates/piarc-testkit/tests/ahp_round_trip.rs`

## 背景

第 11 章要求小文件 fs 操作的 AHP 往返 p95 ≤ 5 ms。macOS 实测 0.19–0.22 ms；Windows 在 W0 时断言通过，数值未记录。

R2 实施 ADR-0036 之后，每次文件访问都要先绑定获准的目录：

- 从卷根逐级打开目录，每一级都检查是否为重解析点并取身份；
- 再规范化一次路径，确认原位置仍是同一个目录对象。

工作区在 `C:\Users\…\AppData\Local\Temp\…` 下时约 9 级，一次读取约 30 次文件元数据调用。W1 实机（Defender 实时保护开启）测得：

| 运行方式 | p50 | p95 | p99 |
|---|---|---|---|
| 单独运行 `cargo test -p piarc-testkit --test ahp_round_trip` | 3.32 ms | 5.04 ms | 7.76 ms |
| `cargo test --workspace` 中顺序运行 | 5.11 ms | 9.32 ms | 12.52 ms |

所以 Windows 上的 `cargo test`（`npm run verify` 第 8 步）因这项断言失败。原因与 ADR-0040 相同：NTFS 加 Defender 下每次元数据调用约 50–150 µs，ADR-0036 的绑定又不能省掉。

## 决策

1. 第 11 章这一行按平台给预算：macOS 保持 p95 ≤ 5 ms；Windows 为 p95 ≤ 15 ms。
2. `small_fs_reads_round_trip_within_the_budget` 按运行平台断言对应预算，打印的测量值不变。
3. 不改变 ADR-0036 的绑定语义。
4. 优化交给 T44：从会话已持有的工作区根句柄开始绑定，不从卷根重新逐级打开；只把工作区根之上的各级作为一次性校验。这项改动涉及 ADR-0036 的安全论证，须单独评审。

## 备选方案

- **在 W1 中改为从工作区根句柄开始绑定**：能把 Windows 的读取降回 1–2 ms 量级，但改变 ADR-0036 刚经 R2 评审的安全实现（工作区根之上的目录被替换时的行为），不适合在平台验收中顺带做。
- **只在 Windows 上把测试移出 `cargo test`**：属于削弱测试，不采用。

## 后果

- Windows 上每次文件工具调用多出几毫秒，相对模型往返可以忽略。Glob、Grep 一次调用只绑定一次，不随文件数放大。
- 第 11 章又多一行平台口径。T44 优化后应复核能否收紧。

## 重新评估的触发条件

- T44 的绑定优化落地；
- 用户反馈大量小文件读写（例如批量 Read）在 Windows 上明显变慢。
