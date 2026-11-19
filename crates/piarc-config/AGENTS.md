# piarc-config

设置的分层加载、校验、合并、重载与写入，项目信任的查询入口，项目可执行配置的枚举。不监听文件（`piarc-fs` 的监听由 `piarc-core::workspace_settings` 转发过来，两者不互相依赖）；不存信任决定（`piarc-store`）；不解释权限规则与 hooks 的语义（`piarc-policy`、`piarc-hooks`）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-config` | 单元测试 + `tests/settings.rs`（A07、A08 的重载部分）+ `tests/executables.rs`（A13） |

## 层级表

| id | 优先级 | 范围 | 来源 | 可写 |
|---|---|---|---|---|
| `defaults` | 0 | 内置 | `piarc_config::defaults()` | 否 |
| `claudeUser`（T24） | 10 | 用户 | `~/.claude/settings.json` | 否 |
| `user` | 20 | 用户 | `<数据目录>/settings.json` | 是 |
| `claudeProject` / `claudeProjectLocal`（T24） | 30 / 40 | 项目 | `.claude/settings*.json` | 否 |
| `project` / `projectLocal` | 50 / 60 | 项目 | `.piarc/settings.json` / `.piarc/settings.local.json` | 是 |
| `session` | 70 | 会话 | 内存中的值 | 否 |
| `enterprise`（M5） | 80 | 企业 | 托管文件 | 否 |

- 加一层 = `LayerTable::insert(LayerSpec { id, precedence, scope, source, schema, writable, executable })`，合并代码不改。优先级常量在 `layers::precedence`，顺序即 ADR-0005 第 3 条。
- 合并：标量高层覆盖，对象逐键深合并，列表从低到高拼接去重（先出现的保留）；类型不同时高层替换。deny 优先由 `piarc-policy` 求值时保证。
- 校验用 `schema::Shape`（结构化描述，不是 JSON Schema 引擎）：错误带文件、JSON Pointer、原因；有错误的文件整份跳过，未知键只是警告。重载时变无效的文件保留上一份有效内容（`LayerStatus::Stale`），删除的文件变为空层。
- 普通设置写入经 `write_value`，审批的规则与目录经 `append_local_permissions` 同次读改写；并发修改由同一进程锁串行。只写 `writable` 的层（`.piarc/` 与用户文件，永不写 `.claude/`）；同目录临时文件 + `sync_all` + rename，现有文件不是 JSON 对象时拒绝且不改动。

## 信任查询的唯一入口

- 项目级可执行配置（hooks、MCP server、权限 allow 规则、插件、Pi 扩展）的消费者一律经 `trust::project_trust(lookup, dir, on_error)` 判断：只有 `Ok(true)` 是信任，错误与 panic 都是不信任。`TrustLookup` 由 `piarc-core::trust` 实现（主 checkout → `project_trust` 表）。不要另写一条"读表判断信任"的路径。
- `Settings` 在项目不受信任时把项目范围各层的 `executable` 指针（PiArc 层为 `/hooks`、`/permissions/allow`、`/permissions/additionalDirectories`）排除在合并之外。项目要求的 `acceptEdits` 同样需要信任，项目设置的 `bypassPermissions` 和 `auto` 在合并前移除，让较低层的选择继续生效。deny、ask 照常生效。T24 加 `.claude/` 层时给出它们自己的可执行指针（`enabledPlugins` 等）。
- `executables::enumerate` 只读键名与条目名，不做语义加载；扫描范围见模块文档。新增项 = 当前条目减去信任时的快照（`new_items`），删除的条目不需要再确认。

- 用户级 `modelProviders` 的字段由 `piarc_core::providers` 校验。工作区层设置不参与服务商发现。服务商写入复用 `write_value` 的用户设置互斥和 `write::replace_file` 的同目录原子替换。

- 非执行配置 `memory.readBoth` 控制同一目录是否同时加载两个主 memory 文件，随普通标量合并。

## 易错点

- `serde_json` 没开 `preserve_order`：对象按键排序，问题列表与变化键的顺序随之确定，测试按排序断言。
- 变化键是叶子的 JSON Pointer；列表整体算一个叶子（`/permissions/allow`），不逐项报告。

## 参考

- 架构第 6.2.2、6.14、9.1、10.2 节；ADR-0005。
