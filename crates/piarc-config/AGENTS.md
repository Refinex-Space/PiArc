# piarc-config

设置的分层加载、校验、合并、重载与写入（PiArc 与 Claude Code 两种格式），Claude Code 键映射表、rules 解析与配置诊断，项目信任的查询入口，项目可执行配置的枚举。不监听文件（`piarc-fs` 的监听由 `piarc-core::workspace_settings` 转发过来，两者不互相依赖）；不存信任决定（`piarc-store`）；不解释权限规则与 hooks 的语义（`piarc-policy`、`piarc-hooks`）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-config` | 单元测试 + `tests/settings.rs`（T13-A07、A08 的重载部分）+ `tests/executables.rs`（T13-A13）+ `tests/claude.rs`（T24：七层顺序、信任、项目模式、忽略键、损坏文件、家目录注入、`~/.claude.json`、诊断） |

## 层级表

| id | 优先级 | 范围 | 来源 | 可写 |
|---|---|---|---|---|
| `defaults` | 0 | 内置 | `piarc_config::defaults()` | 否 |
| `claudeUser` | 10 | 用户 | `<home>/.claude/settings.json`（有家目录时） | 否 |
| `user` | 20 | 用户 | `<数据目录>/settings.json` | 是 |
| `claudeProject` / `claudeProjectLocal` | 30 / 40 | 项目 | `.claude/settings.json` / `.claude/settings.local.json` | 否 |
| `project` / `projectLocal` | 50 / 60 | 项目 | `.piarc/settings.json` / `.piarc/settings.local.json` | 是 |
| `session` | 70 | 会话 | 内存中的值 | 否 |
| `enterprise`（M5） | 80 | 企业 | 托管文件 | 否 |

- Core 一律用 `LayerTable::workspace(data, workspace, home)`（PiArc 四层加 Claude Code 三层，Core 侧经 `DataDirs::layers`）；`LayerTable::piarc` 只有 PiArc 四层，给只测 PiArc 文件的测试用。
- 加一层 = `LayerTable::insert(LayerSpec { id, precedence, scope, source, format, schema, writable, executable })`，合并代码不改。优先级常量在 `layers::precedence`，顺序即 ADR-0005 第 3 条。
- 合并：标量高层覆盖，对象逐键深合并，列表从低到高拼接去重（先出现的保留）；类型不同时高层替换。deny 优先由 `piarc-policy` 求值时保证。
- 校验用 `schema::Shape`（结构化描述，不是 JSON Schema 引擎）：错误带文件、JSON Pointer、原因；有错误的文件整份跳过，未知键只是警告。重载时变无效的文件保留上一份有效内容（`LayerStatus::Stale`），删除的文件变为空层。
- 权限规则按层取：`Settings::permission_lists()`（高到低，项目未受信任时不含项目 allow）、`layer(id)`（某层生效后的值）、`ignored_modes()`（被忽略的项目级 `bypassPermissions`/`auto`，供审计）。设置页的规则编辑经 `edit_permission_rule`（增、改、删一条，只写可写层）。`permissions.enableBypassPermissions` 只由 Core 从用户层读取（T23）。
- 普通设置写入经 `write_value`，审批的规则与目录经 `append_local_permissions` 同次读改写；并发修改由同一进程锁串行。只写 `writable` 的层（`.piarc/` 与用户文件，永不写 `.claude/`）；同目录临时文件 + `sync_all` + rename，现有文件不是 JSON 对象时拒绝且不改动。

## Claude Code 配置（T24，ADR-0038）

- **键映射表**在 `src/claude.rs` 的 `SETTINGS_KEYS`（`settings.json` 的键）与 `STATE_KEYS`（`~/.claude.json`）：每行是键（嵌套键用点）、状态（`Active` 以同一 JSON Pointer 并入、`Planned(任务)`、`Ignored`）与对应的 PiArc 设置或忽略原因。它是唯一判断：合并只保留 `Active` 的键（`claude::project`，读文件时投影），诊断用 `claude::classify` 分类，表外的键为"未知"。某个键的功能落地时：把这一行改为 `active("…", "/…")`，把键加进 `schema::PIARC_SETTINGS`（测试检查生效的键都是 PiArc 已知的设置），需要信任的值加进 `layers::CLAUDE_EXECUTABLE`。不要在别处另写"这个键算不算"的判断。行的来源是官方 settings 索引，Claude Code 增删键时同步。
- M2 生效的键：`permissions.allow`、`ask`、`deny`、`defaultMode`、`additionalDirectories`，以及 T25 的 `hooks`（可执行值，信任前移除）、`disableAllHooks`。hooks 的 handler 形状在 `schema.rs` 的 `HOOK_HANDLER`：只检查已知字段的类型，语义与不支持的字段由 `piarc-hooks` 报告。项目层的 allow、`additionalDirectories`、`acceptEdits` 在信任前移除，`bypassPermissions` 与 `auto` 始终移除（与 PiArc 项目层同一套过滤）；生效键类型错误时整份文件跳过，被忽略的键不校验。
- **不写 `.claude/`**：`write.rs` 的所有写入（含 `replace_file`）对路径含 `.claude` 目录或名为 `.claude.json` 的目标返回 `WriteError::ClaudeConfig`（Core 映射为 `permissionDenied`），与层是否标为可写无关。"总是允许"、模式记忆、设置页只写 `.piarc/` 与用户级 PiArc 设置。
- **rules**（`src/rules.rs`）：`rule_files` 递归列出 `*.md`（跟随符号链接，同一目录只访问一次，跳过隐藏项）；`parse` 拆出 frontmatter 的 `paths:`（列表或逗号分隔的字符串，YAML 无效时整个文件按无条件处理）；`PathMatcher` 按 gitignore 语义相对工作区根匹配，Windows 不区分大小写。读取与送达在 `piarc-core::tool_io::memory_reader`。
- **诊断**（`src/diagnostics.rs`）：`Settings::diagnostics()` 按文件（高到低）给出加载状态、生效键（标量带决定它的层，列表为合并）、被覆盖键与覆盖层、忽略键与原因（`unknown`、`ignored`、`planned` + 任务、`untrusted`、`projectMode`）、带行列的问题；`claude_state_report(home, workspace)` 只读 `~/.claude.json` 的键名（值在解析时跳过）。

## 信任查询的唯一入口

- 项目级可执行配置（hooks、MCP server、权限 allow 规则、插件、Pi 扩展）的消费者一律经 `trust::project_trust(lookup, dir, on_error)` 判断：只有 `Ok(true)` 是信任，错误与 panic 都是不信任。`TrustLookup` 由 `piarc-core::trust` 实现（主 checkout → `project_trust` 表）。不要另写一条"读表判断信任"的路径。
- `Settings` 在项目不受信任时把项目范围各层的 `executable` 指针（PiArc 层为 `/hooks`、`/permissions/allow`、`/permissions/additionalDirectories`）排除在合并之外。项目要求的 `acceptEdits` 同样需要信任，项目设置的 `bypassPermissions` 和 `auto` 在合并前移除，让较低层的选择继续生效。deny、ask 照常生效。Claude Code 层的可执行指针是 `layers::CLAUDE_EXECUTABLE`（另含 `/enabledPlugins`，键生效后同样受信任约束）。
- `executables::enumerate` 只读键名与条目名，不做语义加载；扫描范围见模块文档。新增项 = 当前条目减去信任时的快照（`new_items`），删除的条目不需要再确认。

- 用户级 `modelProviders` 的字段由 `piarc_core::providers` 校验。工作区层设置不参与服务商发现。服务商写入复用 `write_value` 的用户设置互斥和 `write::replace_file` 的同目录原子替换。

- 非执行配置 `memory.readBoth` 控制同一目录是否同时加载两个主 memory 文件，随普通标量合并。
- 非执行配置 `autoCompactEnabled`、`autoCompactWindow`（T27，与 Claude Code 同名同义，`claude::SETTINGS_KEYS` 中为生效）随普通标量合并，Core 的 `tool_io::context` 读取并夹取窗口范围。
- 非执行配置 `askUserQuestion.timeoutSeconds`（T26）是提问表单的超时秒数，随普通标量合并；Claude Code 的 `askUserQuestionTimeout` 仍标为忽略。`plansDirectory` 仍是 `planned(T26)`：T26 把计划存为会话 entry，未支持计划文件目录（I104，R3 决定）。

## 易错点

- 测试一律注入临时家目录（`LayerTable::workspace(.., Some(临时目录))`、Core 的 `CoreConfig.home`），不读本机 `~/.claude`；`None` 不读任何用户级 Claude Code 文件。
- `paths:` 的匹配用 `ignore` 的 gitignore 构建器：根设为 `""`，传入的是已经去掉工作区根的 `/` 分隔相对路径（`rules::relative_to`），不要把绝对路径交给 `matched_path_or_any_parents`（不在根下会 panic）。
- `serde_json` 没开 `preserve_order`：对象按键排序，问题列表与变化键的顺序随之确定，测试按排序断言。
- 变化键是叶子的 JSON Pointer；列表整体算一个叶子（`/permissions/allow`），不逐项报告。

## 参考

- 架构第 6.2.2、6.6.2、6.14、9.1、10.2 节；ADR-0005、ADR-0038。
