# piarc-telemetry

日志文件、轮转与保留（T13）；本地指标与诊断包导出在后续任务。不上传任何东西；脱敏是 T45。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-telemetry` | 单元测试 + `tests/rotation.rs`（A06：注入时钟跨天轮转、7 天清理、Core 与 Agent Host 分流） |

## 不变量

- 文件：`<数据目录>/logs/core-YYYY-MM-DD.log` 与 `agent-host-YYYY-MM-DD.log`（target `piarc_host::agent_host`，即 Agent Host 的 stderr）；按 UTC 日期分文件，保留含当天在内 7 天（`RETENTION_DAYS`）。打开时与每次换天时清理，只删本前缀、日期可解析的文件。
- 每个事件先在 `EventWriter` 里攒成整行再一次写入，并发事件不交错。
- 全局 subscriber 一个进程只能装一次：`install` 第一次装上，之后只切换目录；已有别的全局 subscriber（测试夹具）时返回 `Installed::External`，不写文件。Core 关闭时 `detach`。
- 时钟经 `Calendar` 注入；生产用 `SystemCalendar`。

## 参考

- 架构第 9.1、9.3、10.5 节。
