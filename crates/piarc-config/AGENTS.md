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
| `enterprise`（T47） | 80 | 企业 | 托管设置（Core 读来源后经 `managed::Managed::layer` 插入的值层，没有文件） | 否 |

- Core 一律用 `LayerTable::workspace(data, workspace, home)`（PiArc 四层加 Claude Code 三层，Core 侧经 `DataDirs::layers`）；`LayerTable::piarc` 只有 PiArc 四层，给只测 PiArc 文件的测试用。
- 加一层 = `LayerTable::insert(LayerSpec { id, precedence, scope, source, format, schema, writable, executable })`，合并代码不改。优先级常量在 `layers::precedence`，顺序即 ADR-0005 第 3 条。
- 合并：标量高层覆盖，对象逐键深合并，列表从低到高拼接去重（先出现的保留）；类型不同时高层替换。deny 优先由 `piarc-policy` 求值时保证。
- 校验用 `schema::Shape`（结构化描述，不是 JSON Schema 引擎）：错误带文件、JSON Pointer、原因；有错误的文件整份跳过，未知键只是警告。重载时变无效的文件保留上一份有效内容（`LayerStatus::Stale`），删除的文件变为空层。
- 权限规则按层取：`Settings::permission_lists()`（高到低，项目未受信任时不含项目 allow）、`layer(id)`（某层生效后的值）、`ignored_modes()`（被忽略的项目级 `bypassPermissions`/`auto`，供审计）。设置页的规则编辑经 `edit_permission_rule`（增、改、删一条，只写可写层）。`permissions.enableBypassPermissions` 只由 Core 从用户层读取（T23）。
- 普通设置写入经 `write_value`，审批的规则与目录经 `append_local_permissions` 同次读改写；并发修改由同一进程锁串行。只写 `writable` 的层（`.piarc/` 与用户文件，永不写 `.claude/`）；同目录临时文件 + `sync_all` + rename，现有文件不是 JSON 对象时拒绝且不改动。

## 托管设置（`src/managed.rs`，T47，设计增补 `T47-auto-memory-and-managed-settings.md` 第 5–8 节）

- `Managed::build(来源, 上一份)` 是托管设置唯一的解析与合并：来源由 Core 按从高到低排好（PiArc 的策略、PiArc 的文件与 `managed-settings.d/`、Claude Code 的策略、Claude Code 的文件），Claude Code 文档只保留映射表里 `Active` 与 `Managed` 的键（`claude::project_managed`，`disableBypassPermissionsMode: "disable"` 变成 `enableBypassPermissions: false`）。单个键类型错只丢该键，锁类键（`LOCKS`）类型错按最严值；锁取所有文档里最严的值；`allowManagedMcpServersOnly`、`allowManagedDomainsOnly` 开启时对应列表取最高文档的整条；不是 JSON 对象的文档进 `errors()`（启动时 Core 据此拒绝启动），运行中变坏的保留上一份内容（`stale`）。
- HTTP hook 的 `allowedHttpHookUrls` 与 `httpHookAllowedEnvVars`（ADR-0065）逐键接管，取设置该键的最高托管来源的整份名单。空名单仍锁定，类型错误时记诊断并按空名单处理。普通层只参与未托管键的合并，删掉托管键后普通层的值恢复。
- 只有托管层能设的键是 `ONLY`（四个 `allowManaged*Only`），其他层的这些值在合并中去掉。锁定判断只用 `managed::locked(托管值, 指针)` 与 `taken`（被托管锁接管的列表）；设置窗口经 Core 的 `managed::view` 取同一份结果（渲染进程的 `isManaged` 按同一规则）。写入经 `write_value`、`append_unique`、`edit_permission_rule` 时被锁定的指针返回 `WriteError::Managed`（Core 映射为 `permissionDenied`，`details.reason: "managed"`）。
- `Settings::user_value`（跳过权限与 Auto 模式这类只读用户层的开关）先取托管值；`is_locked`、`managed_rules_only` 给 Core 用。`mcp::McpPolicy::from_settings` 按 `allowedMcpServers`、`deniedMcpServers` 与 `allowManagedMcpServersOnly` 排除 server（企业作用域不经允许列表）；`auto_mode::available` 读托管层的 `disableAutoMode` 与 `permissions.enableAutoMode`。
- 诊断：`Managed::reports()` 每个文档一份 `FileReport`（`kind: enterprise`），Claude Code 文档里不支持的键报"已忽略"。

## 子 agent 定义（`src/agents.rs`，T31，ADR-0048）

- `load(AgentDirs { cwd, data, home })` 按来源顺序（cwd 向上各级的 `.piarc/agents/`，再各级的 `.claude/agents/`，越近越优先、跳过家目录；PiArc 用户 `agents/`；`~/.claude/agents/`）读全部 `*.md`，以 `name` 字段而不是文件名识别类型，同名取第一份整条定义，后面的路径记进 `overrides`。生效的扩展包（`AgentDirs.packages`，T40）的定义排在最后，类型名 `<plugin>:<名称>`，只保留已确认的 hooks 与内联 server。
- `parse` 用 `serde_saphyr` 解析 frontmatter，问题作为 `AgentIssue`（路径、行号、原因）返回，文件不进列表；单个文件上限 `MAX_DEFINITION_BYTES`（256 KiB）。不认识的字段是 `ignoredField`，`isolation` 校验为 `worktree`（T35 起生效），`skills`（预加载 skill）校验后标 `inactiveField`（T48，T37 未接手），`mcpServers` 自 T36 生效：名称引用原样返回，内联定义作为 `Definition.mcp_inline` 交给 Core 检查与展开（`servers()` 返回两者），项目级的 `bypassPermissions`、`auto` 改为 `default` 并标 `projectModeIgnored`，`auto`、`dontAsk` 标 `unsupportedMode`。`tools`、`disallowedTools` 的 `Tool(specifier)` 只保留工具名。
- 定义里的 `hooks` 是可执行项：项目级定义的 hooks 计入 `executables::enumerate`（新增即让项目回到未确认，ADR-0029），由 Core 在信任时作为限定作用域的来源登记。
- 设置键：`modelAliases`（别名 → `provider/model`，对象逐键合并）、`subagents.maxDepth`、`subagents.maxConcurrent`（PiArc 自己的键）；Claude Code 的 `model`、`effortLevel` 生效（新会话的默认模型与 effort，`model` 可为别名，Core 的 `tool_io::context::session_defaults` 解析），`advisorModel` 忽略（Anthropic 服务端的 advisor 工具），`agent` 为 `planned(T48)`。

## Skills、命令文件与输出风格（`src/skills.rs`，T37，ADR-0054）

- `load(ResourceDirs { cwd, data, home })` 按来源顺序（项目优先于用户；同级 `.piarc` > `.claude` > Pi 的目录；项目目录从 cwd 向上，越近越优先、跳过家目录）读 skills（含 `SKILL.md` 的目录，递归到第一个 `SKILL.md` 为止，跳过隐藏项与 `node_modules`；Pi 的两个 skills 目录另认根目录下带 `description` 的 `*.md`）、命令文件（`commands/**/*.md`，名称为相对路径换 `:`；Pi 模板取文件名）与输出风格，每类同名取第一份，后面的路径记进 `overrides`。单个文件上限 `MAX_FILE_BYTES`（256 KiB），名称为 1–64 个字母、数字、`-`、`_`、`.`、`:`（`valid_name`），不合规的是 `ResourceIssue`。
- frontmatter 用 `crate::frontmatter`（与子 agent 定义共用的 `split`、`mapping`、`line_of`）。YAML 无效时与 Claude Code 一样仍加载、所有字段视为未设置并给 `invalidFrontmatter` 警告；类型错的字段单独 `invalidField`。`Skill.fork` 解析 `context: fork` 指定的 agent、前后台选项以及模型与 effort 覆盖。缺省使用默认 agent、后台执行。隔离 skill 的索引只取显式的 `description` 与 `when_to_use`，普通 skill 的缺省描述仍从正文取。普通 skill 上的 `model`、`effort` 报 `unsupportedField`，其余未用字段 `ignoredField`；正文含 `` !`命令` `` 或 ```` ```! ```` 时 `dynamicCommand`（`has_dynamic_command`），正文原样保留。`allowed-tools` 接受列表或以逗号、括号外空白分隔的字符串（`split_tools`）。
- 参数替换只用 `skills::args`（`split` 按 shell 规则切分，`substitute` 的规则见模块文档与 ADR-0054 第 5 条）；`variables` 给 `${CLAUDE_SKILL_DIR}`、`${CLAUDE_SESSION_ID}`、`${CLAUDE_PROJECT_DIR}`。合并后的命令列表只用 `commands(&catalog)`（`BUILT_IN_COMMANDS` 在前，其后按 `rank` 的来源顺序，同来源 skill 先于命令文件），输出风格只用 `styles` 与 `current_style`（`BUILT_IN_STYLES` 在前，同名的自定义风格被内置覆盖）；`skillOverrides` 经 `apply_visibility`。
- 可执行项：`executables::enumerate` 的 `skill_items` 列出工作区根之内项目来源的 skill 与命令文件的 `allowed-tools`（每条一项，名称 `<名称>: <规则>`）与 `hooks`（与设置文件同样的 hook 条目名）。设置键 `outputStyle`、`skillOverrides` 生效（`claude::SETTINGS_KEYS` 与 `schema::PIARC_SETTINGS`），`disableBundledSkills`、`disableSkillShellExecution` 忽略。
- `watch_dirs` 给出 Core 要监听的目录（各来源目录与其下三层子目录）；读取不需要信任，信任只影响 Core 是否施加 `allowed-tools` 与 hooks。
- 项目来源的 skill、命令文件、输出风格与子 agent 定义解析链接后必须仍在持有该来源的项目目录内（`executables::stays_in_project`），否则跳过并报问题：链接会把任意本机文件带进 system prompt 或 `Skill` 结果（R4 E2）。用户来源不限制。
- 信任只覆盖信任清单列出的文件：`executables::covered_by_trust(root, file)`，即 `<根>/{.piarc,.claude,.pi,.agents}/{skills,commands,output-styles,prompts,agents}/…`。worktree 里的副本（`.piarc/worktrees/`）、子目录与根以上目录的项目文件只作为指令加载，`allowed-tools`、hooks、内联 MCP 不生效（R4 E1）；Core 的技能激活、`agents/list` 与定义 hooks 都经它判断，不另写路径判断。

## 扩展包（`src/plugins/`，T40，ADR-0058）

- `plugins::read(目录, 数据目录)` 识别 Claude Code 插件（`.claude-plugin/plugin.json` 或标准布局）与 Pi 包（`package.json` 的 `pi` 字段或约定目录），给出 `Manifest`：skills、命令、子 agent 的路径，合并后的 hooks 与 MCP server（`${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_DATA}` 已替换）、Pi 扩展入口、不支持的组件与问题。`Manifest::executables()` 是可执行项的唯一命名（hook 用 `executables::hook_item_name`，与信任清单相同；server 用 `mcp::trust_item_name` 加池名 `plugin_<plugin>_<server>`；扩展是相对入口；子 agent 的项前缀类型名）。
- 设置键 `plugins`（id → 布尔，`schema::PIARC_SETTINGS`，PiArc 项目层的可执行指针 `/plugins`）：`declarations` 给出生效的声明（信任过滤后，项目层的值盖过用户层），`listed` 给出文件里写的（设置页用），`active(设置, 安装记录, 数据目录)` 给出生效的包。Core 把结果经 `Settings::set_packages` 挂在设置上，消费者只读 `Settings::packages()`。`Active::{hooks, mcp_servers, extensions, restrict_agent}` 只留已确认的项。
- 组件进既有来源：`ResourceDirs.packages`（`skills::load_package`，插件的命令与 skill 名为 `<plugin>:<名称>`，排在所有来源之后）与 `AgentDirs.packages`；`executables::settings_items` 把 `.piarc/` 文件里开启的 `plugins` 列为 `Category::Plugin` 项。Claude Code 的 `enabledPlugins`、`extraKnownMarketplaces` 为忽略（`claude::SETTINGS_KEYS`）。

## MCP 配置（`src/mcp.rs`，T36，ADR-0053）

- `merge(sources, &MergeOptions { trusted, disabled_mcpjson, disabled, enabled, lookup })` 是 MCP 配置唯一的合并实现：`sources` 按优先级从高到低排好（Core 的 `piarc_core::mcp` 负责收集：local、`.piarc/settings.local.json`、`.piarc/settings.json`、`.mcp.json`、用户 `settings.json`、`~/.claude.json` 顶层），同名取第一份整条定义，其余记进 `overridden`；名称须是 1–64 个 `[A-Za-z0-9_-]` 且不含 `__`（`valid_name`），拼成工具名（`-` 换成 `_`）后与先出现的 server 相同的排除并报问题：工具名与规则都以 `mcp__<server>__` 区分 server（R4 M2）。
- 每条定义经 `definition()` 校验：`type` 为 `stdio`、`http`、`streamable-http`（`transport()`），`sse`、`ws`、`websocket` 为不支持并带原因，`headersHelper` 报问题不执行，`timeout` 为毫秒（不低于 `MIN_TIMEOUT_MS`）；`expand_vars` 在 `command`、`args`、`env`、`cwd`、`url`、`headers` 中展开 `${VAR}`、`${VAR:-default}`，没有值的引用保持原文并报问题。`apply_availability` 决定 `ready`、`disabled`（用户选择优先于 `disabledMcpjsonServers`）、`unsupported`、`untrusted`（只有 project 作用域受信任约束）；不可运行的定义不带程序、地址与展开后的值。
- `claude_state_servers(home, workspace)` 读 `~/.claude.json` 的顶层与 `projects[<工作区>]` 段（键与工作区规范化后比较），`local_pointer` 给出后者的 JSON Pointer；`pool_settings(merged)` 读 `mcp.idleTimeoutSeconds`（默认 600）与 `mcp.deferThreshold`（默认 30）。
- 可执行项：`executables::enumerate` 经 `mcp_items()` 列出 `.mcp.json`、`.piarc/settings*.json` 的 `mcpServers` 与项目级子 agent 定义的内联 server，条目名由 `trust_item_name` 给出（名称加程序或地址，再加 `type`、`args`、`env`、`cwd`、`headers`、`oauth`），改了运行什么就是新增项。`.pi/mcp.json` 不再枚举（Pi 的 MCP 扩展不再加载）。

## Claude Code 配置（T24，ADR-0038）

- **键映射表**在 `src/claude.rs` 的 `SETTINGS_KEYS`（`settings.json` 的键）与 `STATE_KEYS`（`~/.claude.json`）：每行是键（嵌套键用点）、状态（`Active` 以同一 JSON Pointer 并入、`Planned(任务)`、`Ignored`）与对应的 PiArc 设置或忽略原因。它是唯一判断：合并只保留 `Active` 的键（`claude::project`，读文件时投影），诊断用 `claude::classify` 分类，表外的键为"未知"。某个键的功能落地时：把这一行改为 `active("…", "/…")`，把键加进 `schema::PIARC_SETTINGS`（测试检查生效的键都是 PiArc 已知的设置），需要信任的值加进 `layers::CLAUDE_EXECUTABLE`。不要在别处另写"这个键算不算"的判断。行的来源是官方 settings 索引，Claude Code 增删键时同步。
- MCP 键（T36）：`~/.claude.json` 的 `mcpServers`（`STATE_KEYS`，诊断里只列 server 名）与 `disabledMcpjsonServers` 生效；`enableAllProjectMcpServers`、`enabledMcpjsonServers` 忽略（项目 server 由 PiArc 的信任决定）；`allowedMcpServers`、`deniedMcpServers` 自 T47 生效（`mcp::McpPolicy`）。
- M2 生效的键：`permissions.allow`、`ask`、`deny`、`defaultMode`、`additionalDirectories`，以及 T25 的 `hooks`（可执行值，信任前移除）、`disableAllHooks`。hooks 的 handler 形状在 `schema.rs` 的 `HOOK_HANDLER`：只检查已知字段的类型，语义与不支持的字段由 `piarc-hooks` 报告。项目层的 allow、`additionalDirectories`、`acceptEdits` 在信任前移除，`bypassPermissions` 与 `auto` 始终移除（与 PiArc 项目层同一套过滤）；生效键类型错误时整份文件跳过，被忽略的键不校验。
- **不写 `.claude/`**：`write.rs` 的所有写入（含 `replace_file`）对路径含 `.claude` 目录或名为 `.claude.json` 的目标返回 `WriteError::ClaudeConfig`（Core 映射为 `permissionDenied`），与层是否标为可写无关。"总是允许"、模式记忆、设置页只写 `.piarc/` 与用户级 PiArc 设置。
- **rules**（`src/rules.rs`）：`rule_files` 递归列出 `*.md`（跟随符号链接，同一目录只访问一次，跳过隐藏项）；`parse` 拆出 frontmatter 的 `paths:`（列表或逗号分隔的字符串，YAML 无效时整个文件按无条件处理）；`PathMatcher` 按 gitignore 语义相对工作区根匹配，Windows 不区分大小写。读取与送达在 `piarc-core::tool_io::memory_reader`。
- **诊断**（`src/diagnostics.rs`）：`Settings::diagnostics()` 按文件（高到低）给出加载状态、生效键（标量带决定它的层，列表为合并）、被覆盖键与覆盖层、忽略键与原因（`unknown`、`ignored`、`planned` + 任务、`untrusted`、`projectMode`）、带行列的问题；`claude_state_report(home, workspace)` 只读 `~/.claude.json` 的键名（值在解析时跳过）。
- **来源类别**（T41，ADR-0059）：`FileReport.kind`（`SourceKind`）区分设置文件、`~/.claude.json` 与 Core 另外报告的来源（`mcpJson`、`memory`、`rule`、`agent`、`skill`、`command`、`outputStyle`、`plugin`、`enterprise`，在 `piarc-core::config_diagnostics::sources` 由各自的加载器生成）；`FileStatus` 另有 `platform`、`ignored`、`notConfigured`，`IgnoreReason` 另有 `unsupported`、`disabled`、`conditional`、`unconfirmed`、`notApproved`、`invalid`，`IgnoredKey.detail` 是该次的具体说明。来源链：设置键的 `KeyReport.source` 是决定值的层，其他来源的被覆盖项用 `sourceFile` 写明覆盖它的文件。新增一种来源 = 加一个 `SourceKind` 与 Core 里一个生成函数，不另建结构。
- 用户价格 `modelPrices`（T41）：`provider/model` → `{input, output, cacheRead, cacheWrite}`（美元 / 百万 token），只由 Core 从用户层读，用量报告用它替换目录价。

## 信任查询的唯一入口

- 项目级可执行配置（hooks、MCP server、权限 allow 规则、插件、Pi 扩展）的消费者一律经 `trust::project_trust(lookup, dir, on_error)` 判断：只有 `Ok(true)` 是信任，错误与 panic 都是不信任。`TrustLookup` 由 `piarc-core::trust` 实现（主 checkout → `project_trust` 表）。不要另写一条"读表判断信任"的路径。
- `Settings` 在项目不受信任时把项目范围各层的 `executable` 指针（PiArc 层为 `/hooks`、`/permissions/allow`、`/permissions/additionalDirectories`）排除在合并之外。项目要求的 `acceptEdits` 同样需要信任，项目设置的 `bypassPermissions` 和 `auto` 在合并前移除，让较低层的选择继续生效。deny、ask 照常生效。Claude Code 层的可执行指针是 `layers::CLAUDE_EXECUTABLE`（另含 `/enabledPlugins`，键生效后同样受信任约束）。
- `executables::enumerate` 只读键名与条目名，不做语义加载；扫描范围见模块文档。新增项 = 当前条目减去信任时的快照（`new_items`），删除的条目不需要再确认。

- 用户级 `modelProviders` 的字段由 `piarc_core::providers` 校验。工作区层设置不参与服务商发现。服务商写入复用 `write_value` 的用户设置互斥和 `write::replace_file` 的同目录原子替换。

- 非执行配置 `memory.readBoth` 控制同一目录是否同时加载两个主 memory 文件，随普通标量合并。
- 自动记忆开关 `autoMemoryEnabled`（T47，与 Claude Code 同名同义）：项目层只能关闭（`true` 在合并前去掉并在诊断中标"已忽略"），托管层设置即锁定；`autoMemoryDirectory` 忽略（位置固定在数据目录）。
- 非执行配置 `autoCompactEnabled`、`autoCompactWindow`（T27，与 Claude Code 同名同义，`claude::SETTINGS_KEYS` 中为生效）随普通标量合并，Core 的 `tool_io::context` 读取并夹取窗口范围。
- 非执行配置 `fileCheckpointingEnabled`（T28，与 Claude Code 同名同义，生效）随普通标量合并：`false` 时 Core 的 `tool_io::checkpoints` 不建检查点、写入不存快照，之后的回合没有代码回退。
- 非执行配置 `askUserQuestion.timeoutSeconds`（T26）是提问表单的超时秒数，随普通标量合并；Claude Code 的 `askUserQuestionTimeout` 仍标为忽略。`plansDirectory` 是 `planned(T48)`：T26 把计划存为会话 entry，R3 决定由 T48 支持批准时把计划另存到该目录（I104）。

## Auto 模式的设置（`src/auto_mode.rs`，T46）

- `auto_mode::read(settings)` 是唯一读取入口：`permissions.enableAutoMode` 与 `autoMode.model` 只读 PiArc 用户层，`autoMode` 的 `environment`、`allow`、`soft_deny`、`hard_deny` 由 PiArc 用户层与 `~/.claude/settings.json` 按序拼接去重（`$defaults` 跳过，单条 500 字符、合计 8,000 字符），`disableAutoMode: "disable"`（Claude Code 的顶层键）任何层都生效。`available` 读托管层（T47）：托管设置关闭 Auto 模式时任何层都开不了。
- 项目层的 `/permissions/enableAutoMode` 与整个 `/autoMode`（`USER_ONLY`）在 `remerge` 中移除并记进 `ignored_auto`，诊断报 `projectAutoMode`；项目层的 `defaultMode: auto` 仍报 `projectMode`。`claude::SETTINGS_KEYS` 中 `autoMode` 的四个列表与 `disableAutoMode` 为生效，`autoMode.classifyAllShell`、`useAutoModeDuringPlan` 为忽略并写原因。

## 沙箱设置（`src/sandbox.rs`，T39，ADR-0056）

- 键沿用 Claude Code：`sandbox.enabled`、`sandbox.autoAllowBashIfSandboxed`、`sandbox.filesystem.denyRead`、`sandbox.network.allowedDomains`（`claude::SETTINGS_KEYS` 为生效，其余 `sandbox.*` 逐条忽略并写原因，`network.allowManagedDomainsOnly` 只在托管设置中生效（T47））。
- 项目层只能收紧：`remerge` 用 `sandbox::loosening` 去掉项目层的 `allowedDomains`、为真的 `autoAllowBashIfSandboxed`、为假的 `enabled`，记进 `ignored_sandbox`，诊断报 `projectSandbox`；Core 在没有沙箱的平台用 `diagnostics::mark_platform_unsupported` 把生效的开启与自动批准改报 `platform`。
- `sandbox::resolve(settings, enterprise, home)` 给出开关、模式、带来源的 `denyRead`（项目文件相对项目根、用户文件相对文件所在目录、`~/` 与 `/`、`//` 照常）与允许域名（用户两层，再加企业来源，去重）。写回只经 `write_value`/`append_unique` 的用户层（网络卡的"加入白名单"用 `append_unique`）。

## 易错点

- 测试一律注入临时家目录（`LayerTable::workspace(.., Some(临时目录))`、Core 的 `CoreConfig.home`），不读本机 `~/.claude`；`None` 不读任何用户级 Claude Code 文件。
- `paths:` 的匹配用 `ignore` 的 gitignore 构建器：根设为 `""`，传入的是已经去掉工作区根的 `/` 分隔相对路径（`rules::relative_to`），不要把绝对路径交给 `matched_path_or_any_parents`（不在根下会 panic）。
- `serde_json` 没开 `preserve_order`：对象按键排序，问题列表与变化键的顺序随之确定，测试按排序断言。
- 变化键是叶子的 JSON Pointer；列表整体算一个叶子（`/permissions/allow`），不逐项报告。

## 参考

- 架构第 6.2.2、6.6.2、6.14、9.1、10.2 节；ADR-0005、ADR-0038。
