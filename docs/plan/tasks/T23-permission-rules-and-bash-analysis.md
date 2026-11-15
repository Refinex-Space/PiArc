# T23 权限规则完整版与 Bash 命令分析

| 项 | 内容 |
|---|---|
| 阶段 | 3 M2 Harness 核心 |
| 依赖 | R2 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort xhigh，新会话 |
| 规模 | 大 |
| 关联验证项 | 无 |
| 关联需求 | FR-PM-01（计划、跳过权限）、FR-PM-03、FR-PM-04 |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T23`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

T20 交付了 M1 的权限：两种模式的默认行为、审批账本、四类审批卡，以及"总是允许"规则的写入。规则语法、Bash 复合命令分析、计划与跳过权限两种模式还没有。用户从 Claude Code 带来的规则（例如 `Bash(npm run *)`、`Read(~/secrets/**)`）不能按原语义生效，`ls && rm -rf build` 这类命令也只能整条判断。

本任务在 piarc-policy 中补齐架构第 6.2 节：完整规则语法与求值顺序、基于 tree-sitter-bash 的命令拆分、计划与跳过权限模式的裁决、按子命令生成"总是允许"规则，以及规则管理与审计查看页。

完成后，Claude Code 格式的权限规则在 PiArc 中按同样语义生效；复合命令里任何一段命中 deny 或 ask，整条命令都会被拦下。

## 必读

1. 架构设计：
   - 第 6.2 节全部（6.2.1 模式、6.2.2 规则、6.2.3 裁决流程）
   - 第 6.1.2 节"路径边界"一行、第 6.15 节"plan 模式"一行、第 9.2 节 `audit_events`、第 11 章"无需用户参与的权限裁决"一行
   - 第 10.1 节威胁表中"提示注入""审批疲劳"两行、第 10.3 节"preload 与 IPC"中关于"总是允许"规则修改的要求
2. ADR-0004、ADR-0005。
3. `docs/research/claude-official-capabilities.md` A2.1–A2.3；`docs/research/harness-reference-notes.md` 第 1.3 节、第 2.1 节第 2 条。
4. T13、T17、T20 交付的代码与 CLAUDE.md：piarc-config 的分层接口、piarc-exec 的命令结构、piarc-policy 的裁决流水线与审批账本、审计表。
5. 实现时查阅：tree-sitter 与 tree-sitter-bash 锁定版本的 Rust API 和语法节点类型；官方 permissions 文档中通配符与路径前缀（`//`、`~/`、`/`、相对路径）的原文语义。

## 范围

### 要做

- 规则语法、全部 specifier 的匹配、求值顺序与来源合并；Bash 命令分析、只读白名单、关键路径删除检测、`PowerShell(…)` 整条匹配。
- `bypassPermissions` 的开启流程与裁决；plan 模式下写操作的拒绝（裁决第 5 步）；模式按工作区记忆；"总是允许"按子命令前缀生成规则。
- 设置窗口"权限"页：规则可视化管理与审计查看。

### 不做

- 裁决第 2 步 PreToolUse 与第 8 步 PermissionRequest 的 hooks（T25）。本任务留出这两个插槽，插槽返回 allow 时继续走后续步骤，用替身插槽测试这一语义。
- plan 模式的工具、进入与退出时的追加消息、计划卡与模式切换界面（T26）；`.claude/settings*.json` 的文件读取与键映射（T24），本任务的合并逻辑面向抽象配置层，覆盖 ADR-0005 的全部层级。
- 企业策略来源（T47，只留第 1 步插槽）、auto 模式（T46）、dontAsk（仅无头，P2）、沙箱内自动批准（T39）、PowerShell 的语法级拆分（第 6.2.2 节：M4 评估）。
- WebFetch、Agent、Skill、MCP 工具本身（T29、T31、T37、T36）。本任务只实现它们的规则匹配，用单测覆盖。

## 交付物

### 1. 规则语法与匹配

| 规则形式 | 适用工具 | 匹配方式 |
|---|---|---|
| `Bash(命令模式)` | Bash（Monitor 在 T32 接入） | 对每个子命令匹配；`*` 匹配任意文本（含空格）；末尾 ` *` 也匹配裸命令，`:*` 为等价写法 |
| `PowerShell(命令模式)` | PowerShell | 对整条命令匹配，不拆分 |
| `Read(路径 glob)` | Read、Grep、Glob | gitignore 风格路径模式；路径前缀语义按官方文档 |
| `Edit(路径 glob)` | Edit、Write | 同上 |
| `WebFetch(domain:…)` | WebFetch | 域名匹配，`domain:*` 为全部 |
| `Agent(类型)`、`Skill(名称)` | Agent、Skill | 名称匹配 |
| `mcp__server__tool`、`mcp__server__*` | MCP 工具 | 工具名匹配；allow 规则不带 specifier |

- 工具名通配：deny 与 ask 可用 `*`、`mcp__*`；allow 只接受 `mcp__<server>__*`。
- 无法解析的规则在审计与设置页报错；无法解析的 deny 规则不能被静默丢弃，处理方式（例如按更严格的语义对待）写进 piarc-policy 的 CLAUDE.md。
- 路径匹配前统一规范化（复用 piarc-fs 的路径规范化能力；Windows 上大小写不敏感、`\` 与 `/` 等价）。

### 2. 裁决流水线

按架构第 6.2.3 节实现第 3–7 步，第 1、2、8 步留插槽。另有三类调用在任何模式下都询问（含 `bypassPermissions` 与存在 allow 规则时）：命中 ask 规则、关键路径删除、`requiresUserInteraction` 类工具。受保护路径写入在 Manual 与 Accept edits 下询问（沿用 T16、T20）。每次裁决把命中的规则、规则来源和结论写入审计表。

### 3. Bash 命令分析

- 用 tree-sitter-bash 解析，拆出子命令：`&&`、`||`、`;`、`|`、`|&`、`&`、换行；子 shell、命令组、命令替换、进程替换、控制结构（for、while、if、case）的循环体与分支。
- 剥离包装：`timeout`、`time`、`nice`、`nohup`、`stdbuf`、`command`、`builtin`、`noglob`、无参 `xargs`、已知安全的前置环境变量赋值；不在安全名单内的赋值（如 `LD_PRELOAD=`、`PATH=`）保留，整条按需要询问处理。
- 判定：deny 与 ask 只要任一子命令命中即生效；allow 要求每个子命令都被规则或只读白名单允许。解析失败、`eval`、命令名为变量等无法静态判定的情况按询问处理。
- 只读白名单维护在 piarc-policy，带测试；`git` 按子命令区分（`git status` 在内，`git push` 不在）。
- 关键路径删除：`rm`/`rmdir` 的递归删除指向 `/`、家目录（含 `~`、`$HOME`）、工作区根、`.` 等，识别 `-rf`、`-fr`、`-r -f`、`--recursive` 等写法。

用例集（≥ 40 条，`crates/piarc-policy/tests/` 下数据驱动，每条写明输入、拆分结果与期望裁决）：

| 类别 | 最少条数 | 覆盖点 |
|---|---|---|
| 简单命令、引号与转义 | 6 | 单引号与双引号内的 `&&`、`;`、`\|` 不拆分；转义字符；含空格与中文的参数 |
| 控制运算符与换行 | 6 | `&&`、`\|\|`、`;`、换行混用；第二段命中 deny |
| 管道与后台 | 4 | `\|`、`\|&`、末尾 `&` |
| 子 shell 与命令组 | 4 | `( … )`、`{ …; }` 内命中 deny 或 ask |
| 命令替换与进程替换 | 5 | `$( … )`、反引号、嵌套替换、`<( … )` |
| 包装命令 | 7 | 每个包装各一条，含多层嵌套包装 |
| 环境变量前缀 | 2 | 安全赋值剥离；不安全赋值导致询问 |
| 重定向与 heredoc | 3 | `>`、`2>&1`、heredoc 正文不被当作命令 |
| 控制结构 | 3 | for、while、if 体内的子命令参与判定 |
| 只读白名单 | 4 | `ls` 与 `lsof` 对 `Bash(ls *)` 的区别；`git status` 与 `git push` |
| 关键路径删除 | 3 | 根、家目录、工作区根，含 allow 规则存在时 |
| 解析失败与不可判定 | 3 | 未闭合引号、`eval`、`$CMD args` |

### 4. 模式

- `bypassPermissions`：设置中显式开启后才出现在模式菜单，选中时再弹一次确认；deny 与 ask 规则、关键路径删除仍生效。项目级配置中的 `bypassPermissions` 与 `auto` 不生效，并在审计中记录被忽略。
- plan 模式：第 5 步拒绝写工具与非只读 Bash 命令，拒绝理由告诉模型先提交计划。所选模式按工作区记忆（`workspaces` 表的默认模式字段），重启后恢复。

### 5. "总是允许"规则生成

- Bash 按子命令生成"命令前缀 + ` *`"规则；前缀取法（命令名加子命令名，如 `git commit`、`npm run build`）写成纯函数并测试。复合命令中已被允许的子命令不再生成；关键路径删除与解析失败的命令不提供"总是允许"。
- 生成的规则在 T20 的编辑框中展示，用户确认后写入 `.piarc/settings.local.json`。

### 6. 权限设置页

- 规则列表按来源分组（会话、`.piarc/settings.local.json`、`.piarc/settings.json`、用户级 PiArc 设置；`.claude/` 来源由 T24 接入后以只读显示）；增、删、改可写来源中的规则，编辑时校验语法；过宽规则（如 `Bash(git *)`）给出提示。新增或修改 allow 类规则时，由主进程弹出原生确认框（第 10.3 节）。
- 审计页：按会话、工具、结论、时间筛选 `audit_events`，显示命中的规则与来源。

### 7. L2 场景与能力 ID

规则匹配、复合命令、白名单、关键路径删除、bypass、plan 拒绝各至少一个场景（`tests/scenarios/perm-*.yaml`），能力 ID 形如 `CAP-PERM-RULE-001`、`CAP-PERM-BASH-001`，登记在 `tests/capabilities.yaml`。

## 实现要点

- Bash 分析是纯函数：输入命令文本与 cwd，输出子命令列表（规范化 argv 与标记）。不做 I/O，便于单测；任意输入都不能 panic（加随机输入测试）。
- 规则与命令比较前，把 argv 用单个空格重新拼接，避免多余空格或引号写法绕过匹配。
- tree-sitter 带 C 代码，Windows MSVC 构建与许可证检查（cargo-deny）都要通过。
- 裁决 p95 ≤ 2 ms（第 11 章）。同一回合内可按命令文本缓存解析结果。

## 验收标准

- [T23-A01] 每种 specifier（Bash、PowerShell、Read 与 Edit 路径 glob、WebFetch domain、Agent、Skill、`mcp__` 及 server 通配）和工具名通配都有匹配与不匹配的单测，且全部通过。验证：测试输出。
- [T23-A02] 求值顺序为 deny → ask → allow、首个命中即决定，allow 不能覆盖 deny；裸工具名 deny 后该工具不出现在模型请求的工具列表中。验证：单测与 mock provider 请求断言。
- [T23-A03] Bash 拆分用例集不少于 40 条、覆盖交付物 3 的全部类别并通过；任一子命令命中 deny 或 ask 即生效，allow 要求全部子命令被允许。验证：测试输出（列出条数与类别）。
- [T23-A04] 解析失败或无法静态判定的命令按询问处理；随机输入测试中解析器不 panic。验证：单测与随机输入测试输出。
- [T23-A05] 只读白名单命令在 Manual 下免审批、白名单外命令询问；PowerShell 命令不拆分，只有整条被规则允许时免审批。验证：场景测试（PowerShell 场景在 Windows CI 上运行）。
- [T23-A06] 关键路径删除在所有模式下都询问，包括 `bypassPermissions` 与存在匹配 allow 规则的情况。验证：测试。
- [T23-A07] 规则来源按 ADR-0005 的顺序合并，列表类键合并、deny 优先；项目级 allow 规则在项目信任前不生效。验证：测试。
- [T23-A08] `bypassPermissions` 需在设置中开启并二次确认后才能选用；项目级配置中的 `bypassPermissions` 与 `auto` 不生效且写入审计。验证：测试与 Playwright 流程。
- [T23-A09] plan 模式下写工具与非只读 Bash 命令在裁决第 5 步被拒绝，模型收到"先提交计划"的拒绝理由。验证：场景测试中的 mock provider 请求断言。
- [T23-A10] 所选模式按工作区记忆，重启应用后恢复。验证：测试。
- [T23-A11] "总是允许"按子命令前缀生成规则：复合命令生成多条、已允许的子命令不重复、关键路径删除不提供该选项；保存前可编辑，写入 `.piarc/settings.local.json`。验证：单测与 Playwright 流程。
- [T23-A12] 权限设置页可增删改可写来源的规则，新增或修改 allow 类规则时出现主进程原生确认；审计页可按会话、工具、结论筛选。验证：Playwright 流程与截图（`tmp/evidence/T23/`）。
- [T23-A13] 无需用户参与的裁决（含 Bash 分析）p95 ≤ 2 ms。验证：Core 基准测试输出。
- [T23-A14] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新 `crates/piarc-policy` 的 CLAUDE.md：流水线步骤与插槽、只读白名单位置、包装与安全环境变量名单、无法解析规则的处理、易错点。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：Bash 命令分析、规则匹配。
