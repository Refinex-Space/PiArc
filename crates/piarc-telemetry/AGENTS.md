# piarc-telemetry

日志文件、轮转与保留（T13）；日志与诊断包的脱敏、诊断包的组装与 ZIP（T45，ADR-0062）。不上传任何东西：PiArc 没有遥测（外连清单见 `docs/security/egress.md`）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-telemetry` | 单元测试（脱敏规则、诊断包、ZIP 与 CRC-32）+ `tests/rotation.rs`（A06：注入时钟跨天轮转、7 天清理、Core 与 Agent Host 分流）+ `tests/redaction.rs`（Core 与 Agent Host 的行写进文件前已脱敏） |
| `cargo test -p piarc-core --test diagnostics` | Core 导出真实的诊断包并逐个条目扫描（凭据、会话内容、主目录、保险箱与数据库） |
| `cargo test -p piarc-testkit --test credential_leaks` | 保险箱里的已知密钥不在 Agent Host 与 Bash 子进程的环境、日志文件与数据目录里 |

## 不变量

- 文件：`<数据目录>/logs/core-YYYY-MM-DD.log` 与 `agent-host-YYYY-MM-DD.log`（target `piarc_host::agent_host`，即 Agent Host 的 stderr）；按 UTC 日期分文件，保留含当天在内 7 天（`RETENTION_DAYS`）。打开时与每次换天时清理，只删本前缀、日期可解析的文件。
- 每个事件先在 `EventWriter` 里攒成整行再一次写入，并发事件不交错；写入前整行经 `redact::redact`（Core 与 Agent Host 的行同一处理，不要在别处另写一份过滤）。
- 全局 subscriber 一个进程只能装一次：`install` 第一次装上，之后只切换目录；已有别的全局 subscriber（测试夹具）时返回 `Installed::External`，不写文件。Core 关闭时 `detach`。同一进程里并发的多个 Core 会把日志目录切来切去：要断言日志内容的测试放在自己的测试二进制里（`credential_leaks.rs`、`diagnostics.rs` 就是这样）。
- 时钟经 `Calendar` 注入；生产用 `SystemCalendar`。

## 脱敏规则（`src/redact.rs`）

- 已知凭据值：Core 在每次保险箱操作后把每个条目的字符串值交给 `remember_secrets_in`（`piarc-core/src/secrets.rs` 的 `remember_values`）；少于 `MIN_SECRET_LEN`（12）个字符或含空白的值不记，避免误伤普通词。替换为 `[REDACTED:secret]`。
- 格式规则（`PATTERNS`，按顺序，每条只替换存放密钥的捕获组）：JWT、服务商 key 前缀（`sk-`、`sk_live_`、`AIza`、`ya29.`、`ghp_`、`github_pat_`、`glpat-`、`xox?-`、`xai-`、`gsk_`、`hf_`、`npm_`）、云厂商 access key id（`AKIA`/`ASIA`…、`LTAI`、`AKID`）、`Bearer`/`Basic` 之后的凭据（保留前缀）、URL 用户信息里的密码、名字表明是密钥的字段值（`apiKey`、`authorization`、`access_token`、`token`、`client_secret`、`password` 等，保留键名）。已经是占位符的值与 `Bearer`/`Basic` 本身不再替换。
- 新增密钥格式：在 `PATTERNS` 加一条并在 `redact_tests.rs` 加正反例（`ordinary_log_lines_are_left_alone` 守住误报）。
- `redact_home` 只给诊断包用：主目录（两种分隔符、JSON 里的双反斜杠、忽略大小写）后面跟分隔符、引号、空白或行尾时换成 `~`，更长的同名前缀目录不动。

## 诊断包（`src/bundle.rs`、`src/zip.rs`）

- 内容：`logs/` 下 Core 与 Agent Host 的日志文件（保留期内全部）、`versions.json`（客户端传入的应用、Electron、Chromium、Node、平台版本加 Core 与协议版本）、`settings/settings.json`、`settings/pi-settings.json`、`settings/pi-models.json`（存在时）、`config-diagnostics.json`（工作区的配置诊断）、`manifest.json`（文件清单、按类别的替换计数、`EXCLUDED`）。
- 每个文件先经 `redact` 再经 `redact_home`；JSON 设置与诊断另替换名字表明是密钥的键（以 `key`、`token`、`secret`、`password` 结尾，或 `authorization`、`cookie`、`credentials`）与 `env`、`headers` 下的全部字符串值，`${NAME}` 引用保留。
- 永不包含（`EXCLUDED`）：`secrets.vault`、`core.sqlite`、`sessions/`、`pi/sessions/`、`checkpoints/`、`agent-host/`。加文件只经 `BundleInput`，不要把数据目录整个打进去。
- 流程：Core 的 `Hub::prepare_diagnostics` 组装并只保留最近一份，答 manifest 与 id；`export_diagnostics(id, path)` 写同一份（主进程的保存对话框选了路径才调用）。ZIP 是 stored 条目、UTF-8 文件名、CRC-32，先写同目录的临时文件再改名。

## 参考

- 架构第 9.1、9.3、10.5 节；ADR-0062。
