# piarc-policy

Core 的权限裁决（T20 起，T23 完整版）：Claude Code 格式的规则、tree-sitter-bash 命令分析、裁决阶梯与审批账本。全部是纯函数，不做 I/O；路径解析、程序查找、信任、审计、等待用户由 `piarc_core::tool_io::policy` 串接（`assess.rs` 组装事实，`policy.rs` 走阶梯，`settings_view.rs` 是设置页）。AHP 与客户端共享的类型在 `piarc_protocol::policy`。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-policy` | 单元测试：通配、路径锚点与 gitignore 语义、规则与来源、裁决阶梯与插槽、分析器细节、前缀生成、关键路径 |
| `cargo test -p piarc-policy --test bash_cases -- --nocapture` | 数据驱动的 Bash 用例（`tests/bash_cases.json`，打印条数与类别）与 6,000 次随机输入（不 panic） |
| `cargo test -p piarc-core --lib tool_io::policy::tests -- --test-threads=1 --nocapture` | 经真实 Core 的预检：规则来源与信任、模式、Bash、工具移除、"总是允许"、设置页；`automatic_decision_latency` 是 T20/T23-A13 的 1,000 次计时 |

## 裁决阶梯（`decision.rs`，架构第 6.2.3 节）

| 步 | 内容 | 结论 |
|---|---|---|
| 1 | 企业策略 deny（来源 id 为 `enterprise` 的 deny 命中，M5 才有该层） | 拒绝 |
| 2 | PreToolUse 插槽（T25）：deny → 拒绝；ask → 询问；allow → 跳到第 6 步，但不越过 3、4、5 | |
| 3 | deny 规则（Bash 任一子命令、路径、名称） | 拒绝 |
| 3b | `ExitPlanMode`（T26）：plan 模式询问（`planApproval`，第 8 步插槽不能代答），其他模式拒绝（`NOT_IN_PLAN_MODE`） | |
| 4 | ask 规则、可能命中的 deny（含运行期值的命令）、关键路径删除、无法静态判定、无效的 deny/ask 规则、`requiresUserInteraction` | 询问 |
| 5 | plan：写工具与非只读命令拒绝（`PLAN_MODE_REFUSAL`）；bypass：允许 | |
| 5b | 受保护路径写入（Manual、Accept edits） | 询问 |
| 6 | allow 规则（Bash 每个子命令被规则或只读白名单允许；带通配的命令规则遇到越界或无法定位的路径参数时不算放行，ADR-0047）、PreToolUse allow | 允许 |
| 7 | 越界 → 询问；只读且在会话目录内 → 允许；Accept edits 的编辑与文件命令 → 允许 | |
| 8 | PermissionRequest 插槽（T25，`after_permission_request`），不能批准关键路径删除与需要用户交互的工具 | 询问用户 |

- 插槽的结果由 Core 的 `tool_io::policy::hooks` 填入（T25，PreToolUse 与 PermissionRequest hooks）；`decision/tests.rs` 用替身值验证 allow 只"继续走后续步骤"。`after_permission_request` 不让 hook 批准关键路径删除与需要用户交互的工具。
- `Input.tainted`（命令改 `PATH`、`IFS` 等或带不安全的前置赋值）：第 6、7 步不自动允许，bypass 仍允许。
- 起始模式：会话显式 → 工作区记忆（`workspaces.default_mode`）→ `permissions.defaultMode` → Manual；`bypassPermissions` 只有用户文件里 `permissions.enableBypassPermissions: true` 时可用（`starting_mode`）。

## 规则（`rules.rs`、`pattern.rs`、`paths.rs`）

- 求值 deny → ask → allow，来源只决定报告哪个命中（企业 > 会话 > `.piarc/settings.local.json` > `.piarc/settings.json` > `.claude/` 两层 > 用户 PiArc > `~/.claude`，ADR-0005）。会话规则是用户在本会话"本会话允许"的规则。
- `Bash(…)`、`PowerShell(…)`：`*` 匹配任意文本；末尾 ` *` 且是唯一通配时也匹配裸命令；`:*` 等价。PowerShell 不区分大小写、整条匹配；带 `*` 的 allow 只在命令没有 `; | & ( ) { } $ @ > <` 反引号与换行时生效，deny/ask 也对粗分段（`powershell_segments`）检查，命中段只询问。
- 命令中运行期才知道的部分是 `pattern::DYNAMIC`：allow 必须覆盖所有取值（`covers`），deny 可能命中时询问（`may_match`）。
- `Read(…)` 适用 Read、Glob、Grep；`Edit(…)` 适用 Edit、Write、NotebookEdit；Read 的 deny 也拦写入。`Write(path)`、`Glob(path)`、`Grep(path)` 接受但永不匹配（同 Claude Code）。路径锚点：`//` 根、`~/` 家目录、`/` 规则来源目录（项目与会话为工作区根，用户文件为其所在目录）、其余为会话 cwd；gitignore 语义（无斜杠的名字任意深度、目录命中覆盖其内容、`!` 只对同一来源同一列表的相对规则生效、不能重新包含被排除目录下的文件）；deny/ask 的单段目录模式（`src/**`）在任意深度生效。路径比较用 POSIX 形式（`C:\x` → `/c/x`），卷不区分大小写时折叠大小写。
- `WebFetch(domain:…)`：主机名不区分大小写、去掉末尾点；`*.x` 匹配任意深度子域不含顶级；其他位置的 `*` 只在一个标签内。`Agent(类型)`、`Skill(名称)` 用通配匹配。参数规则（T31，I82）：`工具(键:值)` 的键在 `param_keys` 表里时（Agent：`model`、`effort`、`isolation`、`run_in_background`；Bash、PowerShell、Monitor：`run_in_background`、`timeout`、`dangerouslyDisableSandbox`，Bash 另有 T33 的 `terminal`）解析为 `Spec::Param`，只匹配调用的同名顶层标量参数（值按通配），从不匹配主内容字段；只用于 deny 与 ask，写成 allow 是解析错误；键不在表里时照旧按类型名或命令模式解析。Core 在组装阶梯输入之后经 `assess::param_rules`（`RuleSet::find_param`）施加，设置页的规则检查返回 `parameter` 并标出。
- MCP：`mcp__server__tool`、`mcp__server__*`、`mcp__server`；带 specifier 的 MCP 规则无效。工具名通配：deny/ask 任意位置可用 `*`；allow 只接受 `mcp__<server>__` 之后的通配。
- 无法解析的规则：allow 忽略并报告；deny 与 ask 不丢弃，按更严格的语义对待——它点名的工具的每次调用都询问（读不出工具名时所有工具都询问），并在设置页与审计里列出。
- 裸工具名 deny（含 `Tool(*)`、工具名通配、`mcp__server`）由 `RuleSet::whole_tool` 判断；Agent Host 每次运行前经 AHP `policy/tools` 询问并把这些工具从模型工具列表移除。

## 错误与子 agent

- 公开解析函数（`rules::parse`、`paths::parse`）返回 `piarc_policy::Error`（`InvalidRule`、`InvalidPath`；`kind()`、`retryable()`、`to_error_object()`，T31，I128）。新增失败原因加变体，不返回 `String`。
- 子 agent（T31，ADR-0048）的调用走同一阶梯：Core 的 `tool_io::subagents` 决定生效模式（定义与主会话当前模式中更严的一个）与规则所属会话（主会话：子 agent 卡上的"本会话允许"作用于整棵树），审批卡带 `ApprovalOrigin`（`piarc_protocol::subagent`），审计记子会话与类型。`Agent` 在阶梯里与宿主工具一样是 `read_only`：派出本身不询问，子 agent 的每个调用各自裁决；`Agent(<类型>)` deny 让该类型不能派出，也不出现在工具描述里。

## Bash 分析（`bash/`）

- `analyze` 只用文本：tree-sitter-bash 0.25.1（MIT）解析，线程内复用一个 `Parser`；超过 10,000 字符、语法错误、命令名或脚本是运行期值、`eval`、无法跳过的包装选项、嵌套过深（200 层、10 万节点、`sh -c` 3 层）都进 `unresolved`，裁决为询问。
- 拆分：`&& || ; | |& &`、换行、子 shell、命令组、`$( )`、反引号、`<( )`/`>( )`、`for`/`while`/`if`/`case`/函数体、heredoc 正文里的命令替换（引号定界的 heredoc 不展开）。`cd`/`pushd` 跟踪目录：`||` 与条件体内的变化、`cd -`、`popd`、运行期目标使后续目录为 Unknown。
- 剥离（`wrappers.rs`）：`timeout`、`time`、`nice`、`nohup`、`stdbuf`、`command`（不含 `-v/-V`）、`builtin`、`noglob`、无参 `xargs`、只含安全赋值的 `env`；安全前置赋值名单是 `SAFE_ENV`（locale、终端、颜色、CI、`NODE_ENV`、`RUST_LOG` 等），其余赋值保留并使命令不能自动允许。`walk.rs` 的 `is_special_variable` 是会改变后续命令解析的变量（`PATH`、`IFS`、`HOME`、`LD_*`、`GIT_*`…）。
- exec 包装（`EXEC_WRAPPERS`：`sudo`、`env` 带选项、`watch`、`setsid`、`flock`、带参数的 `xargs`、`find -exec/-delete`、`sh/bash -c` 等）只能被精确规则允许，它们运行的命令作为影子命令参与 deny、ask 与关键路径检查。
- 只读白名单（`readonly.rs` 的 `spec_of`、`git` 子命令表、`BUILTINS`、`PROGRAMS`）：路径操作数必须在会话目录内；危险选项（`sort -o`、`find -exec`、`rg --pre`、`git -c`、`--output` 等）与对通配敏感的命令（find、sort、git）带未加引号的通配时不算只读；经 `xargs` 得到参数的命令不算只读。Accept edits 另接受字面量形式的 `mkdir [-p]`、`touch`、`mv a b`、`cp a b`。
- 自动允许依赖的外部程序（含 exec 型包装和它们执行的同名内建）由 Core 解析（`exec/utility.rs` 的 `Programs`：PATH 不能指向工作区，程序不能在会话可写目录内，文件命令必须在 `/bin`、`/usr/bin`；Windows 只接受 Git 安装 `usr/bin` 与 `mingw64/bin`、`ucrt64/bin`、`clangarm64/bin` 中经探测确认的程序，探测只查 Git 自带的名字、失败不缓存，W2），执行时 `CwdProbe::pin_program` 在 bash 里核对并钉住；路径在执行前按同一 scope 再检查一次。
- 关键路径删除（`critical.rs`）：带递归选项的 `rm`（或指向关键目录的通配）与 `rmdir`，目标为 `/`、一层系统目录及其常见二层、家目录（`~`、`$HOME`、`${HOME}`，以及 Git Bash 里同为家目录的 `$USERPROFILE`、`${USERPROFILE}`，W2）、工作区根及其祖先、`.`/`..`（目录未知时也算）。
- "总是允许"（`prefix.rs`）：每个仍需批准的主命令一条 `Bash(<前缀> *)`；前缀是程序名加子命令（`SUBCOMMAND_TOOLS`，`npm run x` 一类取三段，解释器带脚本或 `-m 模块`）；删除、权限、网络、exec 包装类程序给精确规则；至多 5 条，有关键删除、无法判定、不安全赋值或 ask 命中时不提供。每条建议都验证能覆盖原命令。

## 易错点

- Monitor（T32）：`bash::judge` 按 `Facts::tool()`（缺省 `Bash`）查规则，Core 对 Monitor 传 `Monitor`，于是 `Bash(…)` 规则（`covered_tools`）与 `Monitor(…)` 规则都适用；只读白名单不让 Monitor 免审批由 Core 的 `assess::bash_call` 处理。
- 新增工具要决定它在阶梯里的事实：写工具设 `write`（plan 拒绝），只读工具设 `read_only`，需要用户交互的在 `assess.rs` 给出 `MustAsk { step: "requiresUserInteraction" }`；规则匹配面（名称、路径、域名）在 `assess.rs`。
- 只读白名单的 `valued`（取值选项）只列确实带值的选项：多列会把路径当成值跳过检查（不安全），少列只会把值当路径检查（多问一次）。选项词由 `option_word` 解析（R3）：短选项簇逐字母判断禁用与取值（`-ofile` 即 `-o`），长选项的前缀缩写按 getopt 视同全名，`--x=值` 的值按路径检查，`--files0-from` 一律不算只读；`find` 的起始路径跳过前置选项（`-L`、`-P`、`-f 路径`…）；重定向的设备豁免只认精确名字与 `/dev/fd/<数字>`，`$(< 文件)` 按 `:` 加输入重定向判断。
- 改了白名单或包装名单，更新 `tests/bash_cases.json` 并核对 Windows 探测列表（`PROGRAMS`、`WRAPPED`）。
- 测试里的命令环境要固定 PATH（`Fixture::fixed`）：cargo 在 macOS 上给测试进程设 `DYLD_*`，Core 会正确地关闭依赖程序解析的自动允许。
- 项目文件里新增的 allow 规则是未确认的可执行项，信任重新确认（或经原生确认保存）之前不生效。
