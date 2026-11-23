# T47 设计增补：自动记忆与企业托管配置

- 状态：已确认（2026-11-22，用户确认第 11 节 10 个要点全部按推荐）；实现中
- 日期：2026-11-22
- 任务：[T47](../../plan/tasks/T47-auto-memory-and-managed-settings.md)，需求 FR-CX-05；架构第 6.14 节"企业托管配置"
- 补充的基线：架构第 6.6.1 节第 4 段、第 6.6.2 节末条、第 6.6.4 节（压缩后重注入）、第 6.2.2–6.2.3 节（规则来源与裁决第 1 步）、第 6.3.1 节（只允许托管 hooks）、第 6.8 节（MCP 的企业来源）、第 6.12 节、第 6.14 节、第 9.1 节、第 10.2 节、第 15.2 节；不改动已定内容，R6 并入正文
- 依据的 ADR：0004（控制面在 Core）、0005（配置兼容与合并顺序）、0006（clean-room）、0025（数据目录与信任）、0033（memory）、0038（Claude Code 配置兼容）、0039、0055（hooks）、0043（提醒与重注入）、0053（MCP）、0056（沙箱）、0058（插件）、0059（配置诊断与 ConfigChange）、0062（诊断包）
- 行为参照：Claude Code 官方文档 `memory`、`settings`、`managed-settings`、`managed-mcp`、`server-managed-settings`、`hooks`、`permissions`（2026-11-22 重新核对）。只学行为，记忆的工具描述、注入说明与引导文字全部自写

## 0. 结论

1. 自动记忆存在 PiArc 数据目录的 `auto-memory/<项目键>/`，项目键由仓库主 checkout 算出，同一仓库的 worktree 共享，不同仓库隔离。格式与 Claude Code 相同：`MEMORY.md` 索引加每条一个主题文件。
2. 模型只经一个专门的宿主工具 `Memory` 读写记忆（读、保存、删除），工具不收路径、只收记忆名；读写由 Core 在记忆目录内完成并写审计。文件工具对记忆目录没有任何豁免。索引由 Core 从主题文件生成，模型不直接写 `MEMORY.md`。
3. 新会话把索引放在 system prompt 第 4 段末尾，前 200 行或 25 KB（先到为准）；主题文件只在 `Memory` 读取后进入上下文。压缩后索引有变化时重注入，会话中途的变化以 `memoryLazyLoad` 提醒送达。
4. 自动记忆可见、可编辑、可关闭：transcript 显示"已保存记忆""已调用记忆"，设置有"记忆"页，`/memory` 打开它；关闭后不注入、`Memory` 不在工具列表里。项目层只能关闭它。
5. 托管配置是合并顺序的最高层（ADR-0005 第 3 条第一位）：标量不可被覆盖，对象逐键合并，列表合并且托管 deny 在裁决第 1 步生效。被托管设置的键在设置界面显示锁定标识、不可编辑，Core 拒绝对它们的写入。
6. 只有管理员才能写的位置算托管来源：macOS 的 `/Library/Managed Preferences/` 与 `/Library/Application Support/PiArc/`，Windows 的 `HKLM\SOFTWARE\Policies\PiArc` 与 `Program Files\PiArc\`。`HKCU`、用户偏好、数据目录、`C:\ProgramData`、环境变量都不是。多个托管来源同时存在时合并。
7. 兼容读取 Claude Code 的托管文件、托管偏好域与 `HKLM` 策略键、托管 `CLAUDE.md` 与 `managed-mcp.json`（只读），支持的键生效，其余在配置诊断中列为"已忽略"。
8. 托管来源无法解析时 PiArc 拒绝启动并写明来源与位置（与 Claude Code 一致）；运行中变坏时保留上一份有效内容并提示。托管配置每 60 s 检查一次，变化后在下一次检查内生效；`ConfigChange` hook 对托管来源照常运行但不能阻断。
9. 第一版的托管专属键：`allowManagedHooksOnly`、`allowManagedPermissionRulesOnly`、`allowManagedMcpServersOnly`（配合 `allowedMcpServers`、`deniedMcpServers`）、`sandbox.network.allowManagedDomainsOnly`；禁用 Auto 模式与跳过权限用已有的键在托管层锁定。

## 1. 记忆存储

### 1.1 位置

| 项 | 规定 |
|---|---|
| 根目录 | `<数据目录>/auto-memory/`。与数据目录根的 `MEMORY.md`（T22，用户自己写的全局 memory）是两回事，名称刻意不同 |
| 每个项目一个目录 | `auto-memory/<项目键>/`，项目键 = 主 checkout 目录名（只留 `[A-Za-z0-9._-]`，至多 40 个字符）+ `-` + 规范路径 SHA-256 的前 12 位十六进制 |
| 主 checkout | 与项目信任同一解析（`piarc_git::resolve`，ADR-0025）：linked worktree（含 `.piarc/worktrees/<名称>/` 与子 agent 的 worktree）归主仓库，submodule 是独立项目，非 git 目录取自身规范路径 |
| 规范路径 | `canonicalize` 后去掉 Windows 的 `\\?\`（`piarc_git::strip_verbatim`），Windows 上转小写再算哈希（文件系统不区分大小写，第 15.3 节） |
| 目录标记 | 目录里另有 `project.json`（规范路径、创建时间），设置页据此显示属于哪个项目 |
| 进程边界 | 只有 Core 读写这个目录。Agent Host 的定稿 Seatbelt 配置不允许写数据目录的这一部分（T39 的可写位置不含它），沙箱内的命令同样写不进 |

worktree 会话的 `SessionIo.project` 是主工作区（T35），所以记忆的项目键一律从 `project()` 算出，与"总是允许"规则、信任走同一条路。

### 1.2 格式

`MEMORY.md`（索引，由 Core 生成）：

```markdown
# Auto memory

- [deploy-steps](deploy-steps.md) (project, 2026-11-20) — Staging deploys go through the release script, never kubectl
- [prefers-pnpm](prefers-pnpm.md) (feedback, 2026-11-18) — Use pnpm in this repo; npm lockfiles get rejected in review
```

每行一条，按修改时间从新到旧，括号里是类型与日期。

主题文件 `<名称>.md`：

```markdown
---
name: deploy-steps
description: Staging deploys go through the release script, never kubectl
type: project
modified: 2026-11-20T09:14:03Z
session: 3f9c2a7e-…
---

<正文>
```

| 字段 | 规定 |
|---|---|
| `name` | 1–64 个 `[a-z0-9_-]`，以字母或数字开头；即文件名 |
| `description` | 单行，至多 200 个字符；进入索引 |
| `type` | `user`、`feedback`、`project`、`reference`（与 Claude Code 相同） |
| `modified` | Core 写入时的 UTC 时间（ISO 8601） |
| `session` | 最后写入它的 PiArc 会话 id；设置页编辑为 `user`，导入为 `import` |

frontmatter 由 Core 按工具参数生成，模型给不出 `modified`、`session`，也伪造不了它们。

### 1.3 上限

| 项 | 上限 | 超出时 |
|---|---|---|
| 主题正文 | 16 KiB（UTF-8） | `save` 失败，结果说明上限 |
| 每个项目的主题数 | 200 | `save` 新主题失败，提示先合并或删除 |
| 注入的索引 | 前 200 行或 25 KB，先到为准（与 Claude Code 相同） | 截断处加一行说明还有多少条未列出、可用 `Memory` 读取完整索引 |
| 单次 `read` 的完整索引 | 不截断（至多 200 条） | — |

### 1.4 Claude Code 记忆的导入

- 只读、一次性、由用户发起：设置的"记忆"页在找到 Claude Code 的记忆目录时显示"从 Claude Code 导入（N 条）"。
- 查找位置：`<家目录>/.claude/projects/<Claude Code 项目键>/memory/`，项目键按 Claude Code 的规则由同一个主 checkout 路径得出（字母与数字以外的字符换成 `-`）。家目录取 `CoreConfig.home`，测试注入临时目录。`autoMemoryDirectory` 改过位置的不查找。
- 导入读取每个主题 `.md`（不读它的 `MEMORY.md`，索引由 Core 重新生成）：有 frontmatter 的取 `name`、`description`、`type`；没有的以文件名为名、类型记为 `project`、描述取正文第一行。名称已存在的跳过并列出，其余复制进 PiArc 的目录，`session: import`，每条一行审计。
- 永不写 `.claude/` 与 `~/.claude/`（ADR-0005 第 2 条）：导入只读源文件，T24 的写入拒绝与 L2 的 Claude Code 配置快照比对继续生效。
- 不把 Claude Code 的目录作为第二个实时来源：两边同时写同一份笔记会互相覆盖，Claude Code 的提示词也不是为 PiArc 的工具写的。

## 2. 记忆写入

### 2.1 `Memory` 工具

模型只经宿主工具 `Memory` 读写记忆，参数：

| 参数 | 说明 |
|---|---|
| `action` | `read`、`save`、`delete` |
| `name` | 记忆名。`save`、`delete` 必填；`read` 不带时返回完整索引，带时返回该主题 |
| `type` | `save` 必填，四种类型之一 |
| `description` | `save` 必填，单行 |
| `content` | `save` 必填，Markdown 正文，整篇替换 |

- 不提供按行替换：主题短（至多 16 KiB），整篇替换让 Core 的校验与审计简单，也不会留下半改的文件。
- 结果：`read` 返回元数据头（类型、修改时间、写入的会话）加正文；`save` 返回"已新建 / 已更新"与新的索引行；`delete` 返回删除的名称。
- 名称换成文件由 Core 完成，路径只可能是 `<记忆目录>/<名称>.md`；名称不合规时直接拒绝，不存在路径穿越的输入。
- 工具描述与第 2 段的使用指引（什么值得记、什么不记：可从代码或 git 得出的事实、凭据、只对本次对话有用的内容；一条事实一个主题；先读后改，避免重复）由 PiArc 自写，放在 `agent-host/src/harness/prompts/auto-memory.ts`，改后跑原创性检查。

### 2.2 经 Core 执行

调用路径与 `Skill` 相同（T37）：`tool_call` 闸门 → `policy/evaluate` 裁决 → Agent Host 执行工具时发 AHP `memory/apply`（Agent Host → Core）→ Core 消费同一调用的授权（`policy::claim_*`）→ 在项目记忆目录的锁内读写 → 回答。

| 项 | 规定 |
|---|---|
| 并发 | 每个项目一把锁（多个会话、多个窗口共用）；写主题与重写索引在同一次加锁内，都用同目录临时文件 + `sync_all` + rename |
| 审计 | 每次 `save`、`delete` 一行 `audit_events`（`kind: "memory"`）：动作、项目键、名称、类型、字节数、内容 SHA-256、会话 id、工具调用 id、执行者（`agent`）；设置页的编辑与删除、导入同样各写一行（执行者 `user`、`import`）。`read` 不写审计 |
| 路径边界 | 文件工具（Read、Write、Edit、Glob、Grep、Bash、PowerShell）对记忆目录没有豁免：它在工作区外，按越界询问。`Memory` 自身不经路径边界检查，因为它不收路径 |
| 诊断包 | 记忆目录不进诊断包（与会话内容同等对待，ADR-0062） |

### 2.3 审批

- `Memory` 在阶梯第 7 步按"模式默认"允许，所有模式相同（含 plan 模式：记忆不是代码改动，与 TodoWrite 一样）。
- 规则与 hooks 照常适用：`Memory` 的 deny、ask 规则（不带 specifier）与 PreToolUse、PostToolUse hooks（matcher `Memory`）都生效，想逐次确认的用户写一条 `ask` 规则即可。
- Auto 模式不送审：它在第 7 步已允许，不是通用询问（T46 增补第 6.1 节）。

### 2.4 未信任的项目

- 推荐：项目未受信任时照常注入已有的索引（记忆在用户自己的数据目录里，不来自仓库），但不提供 `Memory` 工具，模型既不保存也不读主题。
- 理由：记忆的风险是把一次提示注入持久化到之后的会话；用户没有信任的仓库最可能夹带注入。信任变化时 Core 已会重启该工作区的 Agent Host（T13），会话重开后工具集按新状态决定。

### 2.5 子 agent

子会话既不注入索引、也没有 `Memory` 工具（与 Claude Code 一致：主会话的自动记忆不进子 agent）。T48 的 fork 子 agent 继承主会话上下文，届时按 fork 的规则处理；子 agent 定义的 `memory` 字段不在本任务范围。

## 3. 记忆注入

### 3.1 新会话

- Core 的 `fs/memory` 快照在最后加一个 `MemoryFile`，新增可选字段 `kind: "autoMemory"`，`content` 是截断后的索引（1.3），`path` 是 `MEMORY.md` 的路径。
- Agent Host 组装第 4 段时把它放在全部 memory 文件与 rules 之后，前面加一段自写的说明：这些是本项目以前的会话里由智能体保存的笔记，可能过时；与用户当前的要求或仓库文件冲突时以后者为准；细节用 `Memory` 读取。每个索引行自带类型与日期，来源由此可见。
- 第 2 段的工具指引只在有 `Memory` 工具时出现。
- 关闭自动记忆、未信任项目里没有 `Memory` 工具时的说明改为不提工具（只有索引）。

### 3.2 主题文件

主题正文只经 `Memory` 的 `read` 进入上下文，是工具结果，受 `harness/tool-results.ts` 的结果预算约束；第 4 段只有索引。

### 3.3 会话中途的变化

- 索引在快照里，内容摘要随 T27 的 memory 版本记录一起比较：别的会话或用户在设置页改了记忆后，下一次运行前以 `memoryLazyLoad` 提醒（键 `memory:<索引路径>`）送达新的索引，不改写已发送的 system prompt。
- 本会话自己的 `save`、`delete` 不触发这条提醒：`memory/apply` 的结果带新的索引摘要，Agent Host 记下它；模型已经从工具结果知道了变化。
- 关闭自动记忆后，已打开的会话收到一条提醒说明记忆已关闭，Core 拒绝之后的 `Memory` 调用；工具列表在会话重开时才变（保持工具定义稳定，第 6.6.1 节）。新会话直接没有工具与索引。

### 3.4 压缩后重注入

- 冻结的 system prompt 在压缩后保留，开场的索引仍在。
- `contextRestore`（T27）新增"自动记忆"一项：当前索引与 system prompt 中的版本不同时附上当前索引；再附上本会话读过或保存过的主题，从新到旧。
- 上限加进 `harness/reinjection.ts` 的 `RESTORE_LIMITS`：索引按 1.3 的注入上限；主题至多 5 个、合计 10K token，放不下的只给名称。

## 4. 用户可见性

### 4.1 transcript

| 调用 | 默认视图 |
|---|---|
| `save` | "已保存记忆 · <名称>"；同一回合连续多次合并为"已保存 N 条记忆" |
| `read`（带名称） | "已调用记忆 · <名称>"；连续多次合并为"已调用 N 条记忆" |
| `read`（索引）、`delete` | "已查看记忆索引"、"已删除记忆 · <名称>" |

展开后显示内容；行尾的"在设置中打开"跳到记忆页的该条。失败的调用照常显示错误。注入的索引本身不在 transcript 里显示，详细视图的上下文用量把它计入 memory 类别。

### 4.2 设置的"记忆"页

- 开关：
  - "自动记忆"：用户级，写 `settings.json` 的 `autoMemoryEnabled`（默认开）。
  - "在此项目中使用"：写 `.piarc/settings.local.json` 的 `autoMemoryEnabled: false`，打开即删除该键。
  - 被托管锁定时两个开关都显示锁定标识、不可操作（第 5.4 节）。
- 列表：当前工作区所属项目的全部记忆（名称、类型、描述、修改时间、写入来源：会话标题或"你"或"导入"），按类型筛选。
- 单条：查看、编辑描述、类型与正文（保存经 Core，同样受 1.3 的上限，写审计）、删除（二次确认）。
- "删除此项目的全部记忆"（二次确认）、"在访达 / 资源管理器中显示"、"从 Claude Code 导入"（1.4）。
- 空状态说明自动记忆是什么、存在哪里。

### 4.3 开关与作用域

| 层 | `autoMemoryEnabled` |
|---|---|
| 托管 | 设置即锁定（`false` 在所有项目关闭，`true` 让用户与项目都关不掉） |
| 用户（PiArc `settings.json`、`~/.claude/settings.json`） | 开或关 |
| 项目（`.piarc/` 两个文件、`.claude/` 两个文件） | 只能关闭：项目层的 `true` 去掉并在配置诊断中标"已忽略"（与 T39 沙箱的"项目只能收紧"同一做法），仓库不能替用户打开 |

`autoMemoryDirectory` 标为"已忽略"：PiArc 的位置固定在数据目录（1.1），由设置决定的目录会让一个项目文件把记忆写到任意位置。

### 4.4 内置命令

`/memory` 是新的内置命令（`piarc_config::skills::BUILT_IN_COMMANDS`），在客户端执行：打开设置窗口的记忆页并定位到当前工作区。

## 5. 托管格式

### 5.1 PiArc 自有的托管文件

| 项 | 规定 |
|---|---|
| 主文件 | `managed-settings.json`：JSON 对象，键与 PiArc 的 `settings.json` 相同，另加第 5.3 节的托管专属键 |
| 片段目录 | 同目录的 `managed-settings.d/`：只读 `*.json`，跳过隐藏文件与其他扩展名；按文件名排序（建议数字前缀） |
| 文件内合并 | 先主文件，再按序合并片段：标量后者胜出，对象逐键深合并，列表拼接去重（与设置层的合并同一实现） |
| 托管 memory | 同目录的 `CLAUDE.md`：作为第 4 段的第一份 memory 文档，标注来源为组织托管，不受 `memory.readBoth` 与信任影响，用户不能排除 |
| 托管偏好 / 注册表 | 一个文档，内容等同 `managed-settings.json`（第 6 节） |

### 5.2 合并与锁定

- 全部托管来源（第 6 节）先合并成一个值，作为 `LayerTable` 中优先级 80 的 `enterprise` 层（`Scope::Enterprise`，`Source::Value`），合并代码不变。
- 标量：托管层的值胜出，会话、项目、用户各层的同一键都被覆盖，配置诊断标"被托管覆盖"。
- 对象：逐键合并，锁定按叶子。
- 列表：托管条目加入合并结果，用户删不掉它们；其他层的条目照常合并（下面的专属键另有规定）。
- 权限规则：托管 deny 走裁决第 1 步（`piarc_policy::decide` 已有的 `enterprise` 槽），托管 ask、allow 在第 4、6 步，来源标 `enterprise`。
- hooks：托管层的 hooks 与其他层合并；`disableAllHooks` 只有在托管层设置时才能关掉托管 hooks（与 Claude Code 相同）。
- 信任：托管层不是项目层，不受项目信任约束；托管 hooks 与 MCP server 在未信任的项目里照常生效。
- `permissions.defaultMode` 被托管时只决定起始模式；会话里切换模式不受影响。要禁止某种模式用下一节的锁。

### 5.3 托管专属键与候选键

| 键 | 含义 | 第一版 |
|---|---|---|
| `allowManagedHooksOnly` | 只运行托管层的 hooks 与托管层开启的插件的 hooks；用户、项目、Claude Code 各层、其他插件、skill 与子 agent 定义里的 hooks 都不运行，每个被跳过的 handler 在它本该运行时写一行 `kind: "hook"` 审计（`outcome: "skipped"`、`reason: "managedOnly"`） | 纳入（任务要求） |
| `allowManagedPermissionRulesOnly` | 权限规则只取托管层：用户、项目、Claude Code 文件里的 allow、ask、deny 都不参与裁决（诊断标"被托管忽略"）；会话内的"本会话允许"照常可用，审批卡不提供"总是允许"（它写的文件规则不会生效） | 纳入 |
| `allowManagedMcpServersOnly` | `allowedMcpServers` 只取托管层的；`deniedMcpServers` 仍从各层合并 | 纳入，同时把 T24 标为 T47 的 `allowedMcpServers`、`deniedMcpServers` 改为生效（第 5.5 节） |
| `sandbox.network.allowManagedDomainsOnly` | 沙箱代理只放行托管层的 `sandbox.network.allowedDomains` 与托管层的 `WebFetch(domain:…)` allow 规则；其余域名直接拒绝、不弹网络卡，写 `kind: "sandbox"` 审计 | 纳入（T39 已标 T47） |
| 禁用 Auto 模式 | 托管层的 `disableAutoMode: "disable"` 或 `permissions.enableAutoMode: false`：Auto 不可用且锁定（`piarc_config::auto_mode::available` 的 `organization_disabled`） | 纳入，用已有的键 |
| 禁用跳过权限 | 托管层的 `permissions.enableBypassPermissions: false`；Claude Code 托管文件的 `permissions.disableBypassPermissionsMode: "disable"` 映射为它 | 纳入，用已有的键 |
| `autoMemoryEnabled` | 托管层设置即锁定（4.3） | 纳入，用已有的键 |
| `sandbox.filesystem.allowManagedReadPathsOnly` | PiArc 的沙箱没有 `allowRead` | 不纳入，诊断"已忽略" |
| `strictPluginOnlyCustomization`、`strictKnownMarketplaces`、`blockedMarketplaces`、`disableCommandPluginSources`、`disableSideloadFlags` | PiArc 没有插件市场与命令行侧载 | 不纳入 |
| `managedSourcesBehavior` | PiArc 总是合并（第 6.3 节） | 不纳入 |
| `policyHelper`、`forceRemoteSettingsRefresh`、`claudeMd`、`managedMcpServers`、`allowAllClaudeAiMcps`、`channelsEnabled`、登录与模型限制类键 | 任务范围外（没有服务端、启动时不运行策略程序）或第一版不做 | 不纳入 |

托管专属键只在托管层生效；写在用户或项目文件里时在诊断中标"已忽略（只在托管设置中有效）"。

### 5.4 锁定显示

- Core 提供托管状态（新 Core API `managedSettings`）：各来源的加载状态与位置、被锁定的 JSON Pointer 列表、列表键里来自托管层的条目。渲染进程只经一个判断函数（`isManaged(pointer)` 与列表条目版）决定是否显示锁定标识，不在各页另写判断。
- 显示：控件旁的锁形标识与说明"由组织管理"，控件不可操作；列表里托管的条目不能删改，其余条目照常编辑；设置窗口顶部在有托管配置时显示一行提示并链接到配置诊断。
- Core 拒绝对被锁定指针的写入（`write_value`、`append_unique`、`edit_permission_rule`、插件开关、MCP 启停、沙箱与 Auto 模式的设置写入、记忆开关），错误为 `permissionDenied`，`details.reason: "managed"`。渲染进程的禁用只是呈现，不是边界。
- 覆盖的设置页：权限（规则、默认模式、跳过权限开关）、沙箱、Auto 审查、MCP、插件、模型与服务商的默认模型与 effort、输出风格、记忆；其余页的控件按同一判断函数自动生效。

### 5.5 MCP 的企业来源

- 托管层的 `mcpServers` 作为 `enterprise` 作用域交给 `piarc_config::mcp::merge`（T36 预留的最高作用域），同名取托管的整条定义；用户不能删除，可以在设置页对自己停用。
- `allowedMcpServers`、`deniedMcpServers` 的条目与 Claude Code 相同：每条只有 `serverName`、`serverCommand`（命令与参数逐个相等）、`serverUrl`（`*` 通配，主机不区分大小写）之一。判断顺序：deny 命中即排除；`allowedMcpServers` 没有在任何层设置时全部允许；设置了时远程 server 须匹配 `serverUrl` 条目（列表没有 `serverUrl` 条目时才看 `serverName`），stdio server 须匹配 `serverCommand` 条目（同理）。企业作用域的 server 不经 allowlist 检查。被排除的 server 状态为 `disabled` 并写明原因。
- Claude Code 的 `managed-mcp.json` 见第 7 节。

## 6. 交付方式

### 6.1 管理员来源

| 来源 | macOS | Windows |
|---|---|---|
| 托管偏好 / 策略 | `/Library/Managed Preferences/cn.piarc.desktop.plist`（设备通道）与 `/Library/Managed Preferences/<当前用户名>/cn.piarc.desktop.plist`（用户通道）；偏好域即 D2 的应用标识 `cn.piarc.desktop` | `HKLM\SOFTWARE\Policies\PiArc` 的值 `Settings`（`REG_SZ` 或 `REG_EXPAND_SZ`，内容为 JSON 对象；读 64 位视图） |
| 文件 | `/Library/Application Support/PiArc/managed-settings.json`、`managed-settings.d/`、`CLAUDE.md` | `<Program Files>\PiArc\` 下的同名文件 |

- 托管偏好经配置描述文件（MDM 的自定义设置载荷）下发，系统写在 `/Library/Managed Preferences/`，只有 root 能写。PiArc 直接读这两个 plist 文件（二进制或 XML）：字典→对象、数组→数组、字符串、布尔、整数、实数照转；日期与二进制数据项无效，该键忽略并报问题。用户名取系统账户数据库（按 uid），不取 `USER`、`HOME` 等环境变量。
- `<Program Files>` 取 `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion` 的 `ProgramFilesDir`，不取环境变量 `ProgramFiles`（用户变量可以覆盖它）。
- 不读 `CFPreferences` 的普通偏好：`~/Library/Preferences/cn.piarc.desktop.plist` 用户可写。

### 6.2 不是管理员来源的位置

以下位置的内容一律不获得托管优先级，PiArc 不读取它们作为托管配置：`HKCU\SOFTWARE\Policies\PiArc` 与 `HKCU\SOFTWARE\Policies\ClaudeCode`、`~/Library/Preferences/` 下的偏好、PiArc 数据目录与家目录下任何名为 `managed-settings.json` 的文件、`C:\ProgramData\` 下的目录（普通用户可以在那里新建文件夹）、环境变量与命令行参数。

### 6.3 多个来源同时存在

- 合并，不取其一。顺序（高到低）：PiArc 托管偏好 / 策略 → PiArc 托管文件 → Claude Code 托管偏好 / 策略 → Claude Code 托管文件（第 7 节）。
- 规则：
  - 锁类键（`allowManaged*Only`、`disableAutoMode`、`permissions.enableBypassPermissions: false`、`permissions.enableAutoMode: false`）取最严：任一来源开启即开启。
  - 其他标量按来源顺序，高者胜出。
  - 列表拼接去重；但 `allowedMcpServers` 与 `sandbox.network.allowedDomains` 在对应的 `allowManaged*Only` 开启时取设置了它的最高来源的整份，不做并集（并集会放宽白名单）。
  - `mcpServers` 同名取高者的整条定义。
- 理由：同一台电脑上的几个来源都由管理员放置，合并让每一份的 deny 与锁都生效；只取一份会让较低来源的限制悄悄失效。Claude Code 默认只取一份，它的 `managedSourcesBehavior` 在 PiArc 里忽略。
- 配置诊断按来源各列一份报告（第 8.3 节），合并后的值在"企业"层下显示。

### 6.4 测试与注入

- 根路径（macOS 的系统根、Windows 的 Program Files）、托管偏好目录与注册表键路径都在 `CoreConfig.managed` 中，可注入。测试把它们指向临时目录与 `HKCU\Software\PiArcTest-<随机>\…`，从不写系统目录与 `HKLM`。
- 发布构建固定系统位置：注入只在 `createForTests` 与开发构建的测试入口里可用，发布构建没有任何能改托管来源位置的环境变量、命令行参数或设置（否则用户能把托管配置指向空目录）。`check-app-layout.mjs` 核对发布构建没有测试入口（T40 已有同类检查）。

## 7. Claude Code 兼容

| Claude Code 来源 | macOS | Windows | 处理 |
|---|---|---|---|
| 托管文件 | `/Library/Application Support/ClaudeCode/managed-settings.json` 与 `managed-settings.d/` | `<Program Files>\ClaudeCode\` 下同名 | 读取。按 Claude Code 格式经 `claude::SETTINGS_KEYS` 投影（生效的键并入），另加第 5.3 节纳入的托管专属键；其余键在诊断中列为"已忽略"并写原因 |
| 托管偏好 / 策略 | `/Library/Managed Preferences/com.anthropic.claudecode.plist`（设备与用户通道） | `HKLM\SOFTWARE\Policies\ClaudeCode` 的 `Settings` | 推荐读取，处理同上 |
| `HKCU\SOFTWARE\Policies\ClaudeCode` | — | 用户可写 | 不读（6.2） |
| 托管 `CLAUDE.md` | `/Library/Application Support/ClaudeCode/CLAUDE.md` | `<Program Files>\ClaudeCode\CLAUDE.md` | 推荐读取：排在 PiArc 托管 `CLAUDE.md` 之后、用户 memory 之前，标注来源，不可排除 |
| `managed-mcp.json` | 同目录 | 同目录 | 推荐读取：它的 `mcpServers` 成为企业作用域的 server，并且独占：存在时用户、项目、`~/.claude.json`、插件的 server 都不可用（与 Claude Code 相同；空的 `mcpServers` 即关闭 MCP） |
| 服务端下发、`~/.claude/remote-settings.json` | — | — | 不读（PiArc 没有服务端，缓存文件用户可写） |
| Linux 路径（`/etc/claude-code/`） | — | — | 不适用 |

- 被 Claude Code 文件设置的键同样锁定：用户看到的锁定说明写"由组织管理（Claude Code 托管设置）"。
- 夹具：macOS 与 Windows 两套目录布局（`Library/Application Support/ClaudeCode/…`、`Program Files/ClaudeCode/…`）放在测试夹具里，经注入的根路径加载；Windows 注册表的读取只在 Windows 编译与运行，CI 的 Windows runner 跑对应测试。

## 8. 异常与变更

### 8.1 格式错误

| 情况 | 行为 |
|---|---|
| 启动时任一管理员来源存在但不是合法的 JSON 对象（文件、片段、plist、`HKLM` 值；含语法错误、顶层不是对象、编码错误） | 拒绝启动：主进程显示本地化的原生错误对话框，写明来源位置与行列（plist 写解析错误），然后退出。与 Claude Code 一致：管理员来源只有管理员能写，坏了说明策略本身有问题，带病运行会让策略失效 |
| 来源不存在、空文件 | 不是错误（空文件按 `{}`） |
| 系统拒绝读取（权限） | 跳过该来源，诊断标"无法读取"，启动照常 |
| 合法 JSON 但某个键类型错误 | 只丢弃该键并报问题，其余键生效；锁类键（第 6.3 节）类型错误时按最严处理；`allowedMcpServers` 无效时按空白名单处理，单个无效条目去掉 |
| 运行中变为无效 | 保留上一份有效内容（`LayerStatus::Stale`），`core/notices` 提示一次并在诊断中标"解析错误，沿用上次内容"；下次启动时仍无效则拒绝启动 |

Core 启动失败时返回结构化错误 `managedSettingsInvalid`（`details` 带来源与位置，不带内容），主进程据此选文案；这条路径也修掉 I218 指出的"Core 加载失败对话框只有英文"中与本任务相关的部分。

### 8.2 变化检测

- Core 启动时同步读取全部来源（在打开任何工作区之前），第一次裁决就带着托管配置。
- 之后每 60 s 读一次全部来源（文件、片段目录的列表与内容、plist、注册表值），内容哈希不同才重新合并；间隔在 `ManagedConfig.poll` 中可注入，测试用 100 ms。读取量很小（几个小文件与一个注册表值），不用文件监听：`/Library` 下的监听与注册表通知都要另写平台代码，60 s 的轮询足以满足"下一次检查内生效"。
- 生效：新的企业层对每个打开的工作区发 `core/settings`（变化的键）与 `core/managed`（托管状态，设置页刷新锁定标识），向运行中的 Agent Host 发 `resources/reload`（hooks、MCP、skills 重新取）；权限裁决、hooks 规划与沙箱配置本来就按次读取设置，下一次调用即用新值。会话打开时决定的工具集（`Memory` 是否出现）对新会话与重开的会话生效。

### 8.3 配置诊断

- 每个托管来源一份 `FileReport`（`SourceKind::Enterprise`，T41 已预留）：位置、状态（已加载、不存在、解析错误、无法读取、沿用上次内容）、生效键、被更高托管来源覆盖的键、已忽略的键（Claude Code 不支持的键、只在 PiArc 无意义的键、托管专属键之外放错层的键）与问题。
- 原"企业（未配置）"占位改为真实来源列表；没有任何托管来源时仍显示一行"未配置"。
- 普通设置文件的报告里，被托管覆盖的键标"被托管覆盖"并指向来源。

### 8.4 `ConfigChange`

- 托管配置的每次变化对打开的会话运行 `ConfigChange` hooks，`source: "policy_settings"`，`file_path` 为来源位置（注册表来源写键路径）；hook 的阻断不生效（T41 已有：`policy_settings` 不能阻断，`hooks_m4.rs`）。
- Claude Code 对 MDM 下发的变化不触发这个 hook；PiArc 一律触发、一律不可阻断，让审计 hook 看到每次策略变化。

## 9. 实现落点

| 部分 | 位置 |
|---|---|
| 协议 | `piarc-protocol`：`memory/apply`（Agent Host → Core，能力 `autoMemory`）、`MemoryFile.kind`、Core API 的记忆页类型与托管状态（`ManagedSettingsState`、来源状态、锁定列表）、错误 `managedSettingsInvalid`；`npm run gen:protocol` 与契约样本 |
| 托管解析与合并 | `piarc-config::managed`：来源文档 → 合并值（第 6.3 节规则）、每来源报告、托管专属键表、Claude Code 托管文档经 `claude::SETTINGS_KEYS` 投影、`locked(pointer)` 判断；`claude.rs` 中 `autoMemoryEnabled`、`allowedMcpServers`、`deniedMcpServers`、`sandbox.network.allowManagedDomainsOnly` 改为生效，`autoMemoryDirectory` 改为忽略 |
| 平台读取 | `piarc-ports` 新增窄 trait（读托管来源，返回原始文档与位置），实现在 `piarc-core::managed`：文件与片段（两平台）、plist（macOS，`plist` crate）、注册表（Windows，`windows-registry` crate）；库的选择按补充型决策处理并过 cargo-deny |
| Core 装配 | `piarc-core::managed`：启动读取、轮询、快照；`DataDirs::layers` 插入 `enterprise` 层（所有读设置的入口自动带上，`tool_io/memory.rs`、`hooks_m4.rs` 两处直接建表的改用它）；写入的锁定检查；诊断来源；`ConfigChange` |
| 接入预留入口 | hooks：`piarc_hooks::HookConfig` 的托管专属与 `disableAllHooks` 语义、跳过审计；权限：`assess.rs` 的企业来源与 `allowManagedPermissionRulesOnly`；MCP：`mcp::merge` 的企业作用域、allow/deny 过滤、`managed-mcp.json` 独占；沙箱：`SandboxConfig.enterprise` 与 `allowManagedDomainsOnly`；Auto 模式：`auto_mode::available`；插件：托管层的 `plugins` 锁定开关 |
| 自动记忆 | `piarc-core` 新模块：项目键、目录、锁、主题与索引、导入、审计；`tool_io` 应答 `memory/apply` 并消费授权；`fs/memory` 快照加索引 |
| Agent Host | `harness/auto-memory.ts`（`Memory` 工具、第 2 段指引、本会话写入后的摘要记录）、`prompts/auto-memory.ts`、`reinjection.ts` 的新上限、投影的 transcript 行 |
| 客户端 | 设置的"记忆"页、锁定标识与判断函数、`/memory`、transcript 行、托管配置无效时的启动错误对话框；新页面与行类型登记到 `e2e/a11y/states.ts`（T43） |
| L2 与能力 | `tests/scenarios/memory-auto-*.yaml`、`managed-*.yaml`，能力 `CAP-CX-AUTOMEM-*`、`CAP-CFG-MANAGED-*` |
| 文档 | `crates/piarc-config`、`agent-host` 的 AGENTS.md；`coding-standards.md` 复用表登记"托管来源读取""托管锁定判断" |

测试要点：托管优先级矩阵（同一键在会话、项目、用户、托管层同时设置，托管胜出；列表合并且托管 deny 在第 1 步拒绝）；非管理员来源（6.2）放了配置也不生效；两套 Claude Code 布局的夹具；格式错误的四种情况；轮询生效与 `ConfigChange` 不可阻断；记忆的 worktree 共享与仓库隔离、导入前后 `.claude/` 快照不变、关闭后请求里没有索引与工具。

## 10. 与已有设计的关系

- 第 6.6.2 节："自动记忆列为 M5"由本增补落地；T22 的数据目录 `MEMORY.md` 不变。
- 第 6.14 节兼容矩阵"企业托管配置"一行：由 M5 改为"部分"（第 5.3 节与第 7 节列出的范围）。
- 第 6.8 节的 MCP 来源顺序"企业 > 本地 > 项目 > 用户 > 插件"不变，企业作用域由第 5.5 节与第 7 节填入。
- ADR-0005 第 3 条的合并顺序不变；托管来源内部的合并（第 6.3 节）是补充。

## 11. 需要用户确认的要点

| # | 要点 | 推荐 | 备选 |
|---|---|---|---|
| 1 | 记忆写入是否需要审批 | 不需要：`Memory` 只能写记忆目录，每次写入有审计与 transcript 提示，用户可加 `Memory` 的 ask 或 deny 规则（2.3） | 手动模式下 `save`、`delete` 逐次询问 |
| 2 | 未信任项目的记忆策略 | 注入已有的索引，不提供 `Memory` 工具（2.4） | A：与受信任项目相同；B：完全不用自动记忆（不注入、不写） |
| 3 | 记忆的位置、索引与导入 | 数据目录 `auto-memory/<项目键>/`，索引由 Core 生成；Claude Code 的记忆只读、由用户在设置页一次性导入（1.1、1.4、2.1） | 把 Claude Code 的记忆目录作为第二个只读来源实时读取；或由模型自己维护 `MEMORY.md`（与 Claude Code 相同） |
| 4 | 第一版支持的托管专属键 | 第 5.3 节"纳入"的七行：`allowManagedHooksOnly`、`allowManagedPermissionRulesOnly`、`allowManagedMcpServersOnly`（含 allow/deny 列表）、`sandbox.network.allowManagedDomainsOnly`，以及用已有键锁定的禁用 Auto 模式、禁用跳过权限、自动记忆开关 | 只做任务要求的 `allowManagedHooksOnly`，其余留到 T48 |
| 5 | 管理员来源的判定 | 第 6.1 节的四类位置；第 6.2 节（含 `HKCU`、用户偏好、`C:\ProgramData`、数据目录、环境变量）都不算；Program Files 与用户名都不从环境变量取 | 与 Claude Code 相同，在没有管理员来源时把 `HKCU` 作为最低一级托管来源 |
| 6 | 多个托管来源同时存在 | 合并：锁取最严、标量按来源顺序、白名单在锁开启时取最高来源的整份（6.3） | 只取最高的一个来源（Claude Code 的默认） |
| 7 | 托管来源格式错误 | 启动时拒绝启动并写明来源与位置；运行中变坏沿用上次内容并提示；单个键类型错误只丢该键、锁类键按最严（8.1） | 启动照常，跳过坏来源，在诊断与提示条中告警（策略在修好前不生效） |
| 8 | 是否读取 Claude Code 的托管偏好域、`HKLM` 策略键、托管 `CLAUDE.md` 与 `managed-mcp.json` | 都读取（只读）；`HKCU` 不读（第 7 节） | 只读 Claude Code 的托管文件（`managed-settings.json` 与片段） |
| 9 | 变化检测与生效时间 | 每 60 s 读一次全部来源，变化在下一次检查内生效；托管变化一律触发不可阻断的 `ConfigChange`（8.2、8.4） | 文件用监听即时生效、托管偏好与注册表每 30 分钟检查（Claude Code 的节奏） |
| 10 | 项目层能否打开自动记忆 | 不能，项目层只能关闭（4.3） | 与其他标量键相同，项目层可以打开或关闭 |
