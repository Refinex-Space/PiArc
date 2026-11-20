# piarc-store

Core 的数据库 `<数据目录>/core.sqlite`（rusqlite，SQLite 随 `bundled` 编译进来）：带版本的迁移、第 9.2 节的表、Pi 会话 JSONL 的流式只读解析与会话索引。不决定信任、不解析 checkout（`piarc-config`、`piarc-git`，由 `piarc-core` 组合）；不写 Pi 的 JSONL。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-store` | 单元测试 + `tests/migrations.rs`（A01）+ `tests/index.rs`（A03、A05）+ `tests/memory.rs`（A04） |
| `cargo test -p piarc-store --test memory -- --nocapture` | 打印 100 MiB 会话文件建索引的堆峰值与耗时 |

## 迁移的写法

- 在 `src/migrate.rs` 的 `MIGRATIONS` 末尾追加 `Migration { version: 下一个编号, name, sql: include_str!("sql/NNNN_名称.sql") }`。已发布的迁移永不修改、不重排。
- 每个迁移与它的 `schema_migrations` 行在同一个 `IMMEDIATE` 事务里执行，SQL 里不写 `BEGIN`/`COMMIT`；失败整体回滚，后面的迁移不再尝试，数据库停在上一版本。
- 数据库记录的版本比本构建知道的新（新版本写过）时，`Store::open` 返回 `SchemaTooNew`，不降级。
- 表用 `STRICT`；时间是 Unix 毫秒；路径列存 UTF-8 文本（非 UTF-8 路径拒绝为 `NonUtf8Path`）。

- schema v5（T28，ADR-0044）：`checkpoints`（自增 id 即回合顺序，会话与回合 id 唯一）、`checkpoint_files`（自增 id 即写入顺序，前后内容的十六进制 SHA-256，空值表示文件不存在，`operation` 为 `create`/`modify`/`restore`/`undo`/`discard`，`restore_id` 是恢复批次，随检查点级联删除）、`checkpoint_sessions`（最近访问时间，30 天清理用）。读写在 `src/checkpoints.rs`，规则在 `piarc-checkpoint`，编排在 `piarc-core::checkpoints`；`referenced_snapshots` 是回收时仍被引用的哈希集合。
- schema v6（T31，ADR-0048）：`sessions.subagent_parent`、`subagent_type`（从子会话 JSONL 的 `piarc.subagent` 自定义条目派生，`pi_session.rs` 宽松解析，属于重建时清空重读的派生列）、`checkpoint_files.subagent_session`（写入来自哪个子会话）。会话列表不含子会话由 Core 的快照过滤，索引照常收录。
- schema v4 在 `session_files` 保存文件标识与修改时间：同长度重写或文件替换时重扫。迁移后的空值在首次同步时补齐。
- schema v3 的 `memory_imports` 以工作区和规范文件路径为组合主键。永久 memory 导入许可独立于工具规则和 checkout 的项目信任。

## 会话索引（`src/index.rs`）

- `sessions` 前半是从 JSONL 派生的列（标题来源 `name`/`first_message`、模型、用量累计、时间、格式版本、`index_status`），后半（`workspace_path`、`status`、`worktree`、`pinned`、`archived`、`unread`，schema v2 起还有 `custom_title`）是 Core 自己的状态。`set_session_prefs` 只改给出的字段（索引还没有该行时返回 false），`remove_session` 删除行与同步状态并返回文件路径（文件由调用方删除）；`SessionRecord::title` 的优先级是 `custom_title` > `name` > `first_message`。重建只清派生列与 `session_files`，Core 的列保留；文件不在了的行删除。
- 增量同步状态在 `session_files`：已读到的字节偏移（最后一个完整行之后）、该行起点与 SHA-256、最后一个 entry id、跳过的行数。文件长度等于偏移 → 不变；变长且末行哈希一致 → 从偏移续读；变短或末行变了 → 整文件重扫。
- 末行没有 `\n` 是 Pi 还没写完（`appendFileSync` 不加锁）：不报错、不前进偏移，补全后再读。坏行跳过并计入报告（`SyncReport::skipped_lines`），由 Core 写日志。
- 已知格式版本 1–3（`pi_session::KNOWN_VERSIONS`，Pi 1.5.2 写 3）。其他版本或首行不是 header：该会话 `index_status = unavailable`、`index_error` 写原因，同步不失败。升级 Pi 时先核对 `session-manager.ts` 的 `CURRENT_SESSION_VERSION` 与 entry 类型。
- 折叠必须对文件顺序满足结合律（求和、后写覆盖、只设一次），增量结果才与全量重建逐列相同（`tests/index.rs` 随机追加对比）。新增派生列时同步 `rebuild_index` 的清空语句与 `session_from_row`。

按会话读权限审计用 `Store::session_audit_events`，通过会话索引取最近记录并保持时间和行 id 的倒序。设置页的审计用 `filter_audit_events`（会话、工作区、类别，以及 detail JSON 里的工具与结论，`json_extract`）。`set_workspace_mode`、`workspace_mode` 读写工作区记住的权限模式（T23）。

## 内存

- 行在 1 MiB（`jsonl::BUFFERED_LINE_LIMIT`）以内整行读入缓冲区解析；更长的行从文件流式解析，不整行缓存。entry 只解码索引要的字段，图片 base64、工具参数等由 serde 跳过；不要给 `Entry` 加 `#[serde(flatten)]`（会把未知字段缓存起来）。
- SQLite 页缓存每连接 `CACHE_KIB`（2 MiB）。A04 实测：100 MiB 文件 Rust 堆峰值 +14 MiB。

## 易错点

- 在 macOS 上做 Windows 交叉 clippy 时，bundled SQLite 的 C 源码缺 Windows SDK 头文件编不过：设 `LIBSQLITE3_SYS_USE_PKG_CONFIG=1 SQLITE3_LIB_DIR=<任意目录>` 跳过 C 编译（只检查，不链接）。
- `Store` 不是 `Sync`：Core 用 `piarc_core::storage::Storage`（互斥锁 + 阻塞线程池），不要在异步任务里直接持有它做 I/O。

## 参考

- 架构第 9.1–9.3 节；ADR-0011、ADR-0044；`docs/research/pi-v1.4.0-baseline.md` 第 4.3 节。
