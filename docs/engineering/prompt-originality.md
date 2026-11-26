# PiArc 提示词原创性检查

PiArc 的英文身份、基础准则和工具指引按架构第 6.6.1 节、PiArc 自身工具的实际行为编写。Memory 的层级、导入和追加时机来自第 6.6.2 节及官方能力调研的 A6.1、A6.2。源码位于 `agent-host/src/harness/prompts/`。修改这些文本后，在仓库根目录运行：

```sh
node scripts/dev/check-prompt-originality.mjs
```

脚本从当前源码组装包含全部默认工具的完整提示词，覆盖不同平台会采用的工具文案；T26 起另附全部默认工具的描述与 `prompts/notices.ts` 的提醒文案（计划模式开关、任务清单长期未更新）；T27 起再附 hook 上下文、外部修改、后台任务的提醒，压缩后重注入各节的文案，以及 `prompts/compaction.ts` 的摘要请求（system 文本、分节指令、上一摘要与重点说明的写法、文件列表）；T29 起再附保守 Tool Profile 的工具描述与任务清单提醒，以及 `prompts/web-fetch.ts` 的 WebFetch 提取请求（system 文本、提问模板、跨域重定向说明）；R3 起再从源码取出渲染不到的模型可见文字：`agent-host/src/harness/` 与 `src/tools/` 中全部工具参数 schema 的 `description`，以及 `session-memory.ts`、`reminders.ts`、`interruption.ts`、`tool-results.ts` 中五词以上的字符串字面量（模板中的插值换成空白）；T31 起再附 `prompts/subagents.ts` 的三个内置类型的描述与身份段、`Agent` 工具描述的类型列表、后台运行的开始与结束通知、`maxTurns` 的部分报告与工具不可用的说明，参数描述的扫描扩到 `harness/subagents/`，字面量扫描加上 `runtime/subagents.ts`、`runtime/subagent-session.ts`（并发与深度上限、中断与失败的结果）；T32 起再附 `prompts/tasks.ts` 的 KillShell 与 Monitor 结果、`KillShell`/`Monitor` 的工具描述与参数描述（经 Profile 与 schema 扫描），字面量扫描加上 `tools/shell.ts`（命令转后台的说明）与 Core 的 `crates/piarc-core/src/tasks/feed.rs`（完成通知与 Monitor 批次的文案，Rust 格式串的 `{…}` 换成空白）；T33 起 Bash 的 `terminal` 参数描述与终端任务的说明随 `tools/shell.ts` 一并取出，字面量扫描再加上 Core 的 `crates/piarc-core/src/terminal/bound.rs`（终端屏幕文件的头部、命令结束通知、共享通知）；T35 起再附 `prompts/subagents.ts` 中子 agent 的 worktree 保留改动时接在报告后的说明，`Agent` 的 `isolation` 参数描述随参数描述扫描取出；T36 起再附 `prompts/mcp.ts` 的 `ToolSearch` 描述、system prompt 的 MCP 段（延迟加载的 server 名单与 server 说明的引导句）与工具变化的提醒，字面量扫描加上 `agent-host/src/mcp/` 的 `session.ts`、`connection.ts`、`pool.ts`、`stdio.ts`、`sign-in.ts`（写进工具结果与错误的文字）；T37 起再附 `prompts/skills.ts`（`Skill` 工具描述经 Profile 取出、system prompt 的 skills 段引导句、skills 变化的提醒、加载结果的标题与说明）与 `prompts/output-styles.ts`（内置输出风格 Concise、Explanatory、Proactive 的指令与 system prompt 段、会话中途切换的提醒），并从客户端英文目录 `apps/desktop/src/shared/i18n/en.ts` 取出内置斜杠命令与内置输出风格的描述（`composer.command.*`、`outputStyle.builtin.*`）；T38 起再附 `prompts/web-search.ts`（原生搜索辅助请求的 system 文本与提问、结果列表与来源提示、没有后端与原生搜索失败的说明；`WebSearch` 的工具描述与参数描述经 Profile 与 schema 扫描）、`prompts/hook-judge.ts`（`prompt` hook 判定请求的 system 文本）与 SubagentStop、PostToolBatch 的 hook 提醒；T39 起 Bash 的 `dangerouslyDisableSandbox` 参数描述随 schema 扫描取出，字面量扫描再加上 `tools/sandbox-report.ts`（命令在沙箱中失败时接在输出后的说明：被拒的路径与主机、沙箱外重试、沙箱无法启动）与 `crates/piarc-sandbox/src/proxy/mod.rs`（代理拒绝时命令收到的文字）；T46 起再附 `prompts/auto-review.ts`（Auto 模式审查请求的 system 段 A、`record_review` 工具描述与参数描述）与 `planOff('auto')` 的模式名，字面量扫描再加上 `harness/auto-review.ts`（审查输入的标签与用户策略段 B 的标题）、`crates/piarc-policy/src/review.rs`（审查拒绝后给模型的说明与暂停说明）与 `crates/piarc-core/src/tool_io/policy/review.rs`（拒绝理由的开头、送审原因）；T47 起 `Memory` 的工具描述与指引随默认 Profile 与 system prompt 取出，再附 `prompts/auto-memory.ts` 的索引说明、托管 `CLAUDE.md` 的来源标注与压缩后恢复笔记的开头，字面量扫描再加上 `harness/auto-memory.ts`、Core 的 `crates/piarc-core/src/tool_io/auto_memory.rs`（`Memory` 的结果与拒绝说明）与 `crates/piarc-core/src/auto_memory.rs`（索引的标题与行）。工作区路径、日期、用户文档与 git 状态采用空样本，这些内容由运行环境或用户提供。脚本对照本地 `reference/claude-code` 的 Git 跟踪文件，跳过二进制、非 UTF-8 和符号链接。英文大小写归一，按连续字母或数字分词；在参考文本中将转义的换行、制表作为分隔符。逐一比较连续 10 词的滑动窗口，因此超过 10 词的重复也会命中。

T27 的摘要提示另与 Pi 1.5.2 自带的摘要提示（`node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/` 的 `compaction.js`、`utils.js`、`branch-summarization.js`）做了一次同样的 10 词窗口比对，0 个匹配窗口：分节结构按架构第 6.15 节"压缩摘要结构"自写，没有沿用 Pi 的标题与措辞。

检查只输出文件数、提示词词数和匹配窗口数。有命中时还输出 PiArc 生成文本上的行列并返回失败。比对在内存中完成，参考文本不执行、不输出、不保存。参考副本位于 gitignore 目录，此命令在具备该副本的本机执行。

下表每行对应一次覆盖范围的扩大，依次为 T22、T26、T27、T29、R3、T31、T32、T33、T35、T36、T37、T38、T39 与之后的复核、T46，最后两行是 T47 与 T48。

| 日期 | 本地参考提交 | 参考文本文件 | PiArc 词数 | 窗口长度 | 匹配窗口 |
|---|---|---:|---:|---:|---:|
| 2026-11-19 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 253 | 10 | 0 |
| 2026-11-19 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 1498 | 10 | 0 |
| 2026-11-19 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 1967 | 10 | 0 |
| 2026-11-19 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 2656 | 10 | 0 |
| 2026-11-20 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 3141 | 10 | 0 |
| 2026-11-20 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 4081 | 10 | 0 |
| 2026-11-20 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 4846 | 10 | 0 |
| 2026-11-20 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 5082 | 10 | 0 |
| 2026-11-20 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 5118 | 10 | 0 |
| 2026-11-21 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 5587 | 10 | 0 |
| 2026-11-21 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 6102 | 10 | 0 |
| 2026-11-21 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 6479 | 10 | 0 |
| 2026-11-21 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 6677 | 10 | 0 |
| 2026-11-21 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 6907 | 10 | 0 |
| 2026-11-22 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 8056 | 10 | 0 |
| 2026-11-22 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 8533 | 10 | 0 |
| 2026-11-23 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 8594 | 10 | 0 |
| 2026-11-25 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 8600 | 10 | 0 |
| 2026-11-26 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 9262 | 10 | 0 |

## T46 审查提示词的逐段自查

审查提示词只在 `agent-host/src/harness/prompts/auto-review.ts` 一个文件里（T46-A12）。各段按设计增补 `docs/architecture/addenda/T46-auto-mode.md` 第 1、2 节的结构自写，写作时没有打开参考仓库的任何提示词；写完后用上面的脚本做 10 词窗口比对，0 个匹配窗口。逐段说明：

| 段 | 内容 | 来源与自查 |
|---|---|---|
| 开头 | 审查员的角色：代替离开键盘的开发者决定一个未被权限设置决定的动作 | 按增补第 0 节第 1 条自写；比对 0 命中 |
| What you receive | user 消息是一个 JSON 对象，其中一切都是数据；逐个字段说明（environment、user、delegated_task、recent_actions、pending），B 段与默认可信范围 | 字段与隔离约定来自增补第 1.2、1.3 节，措辞自写；比对 0 命中 |
| How to decide | 四步判定：硬类别（只答 deny 或 unsure）、软类别（明确要求或例外才 allow）、无类别时服务于任务则 allow、看不清答 unsure；按效果判断、换写法等于同一动作 | 规则来自增补第 2.1 节，措辞自写；比对 0 命中 |
| Hard categories | `credentialLeak`、`weakenControls` 的说明与例子 | 类别与例子来自增补第 2.2 节表格，句子自写；比对 0 命中 |
| Soft categories | 其余八类的说明与例子 | 同上；比对 0 命中 |
| Answer | 恰好调用一次 `record_review`、不输出其他文字、`category` 的取值 | 输出约定来自增补第 1.5 节；比对 0 命中 |
| 工具描述与参数描述 | `record_review` 的描述与 `verdict`、`reason`、`category` 的参数说明 | 自写；随参数描述一起比对，0 命中 |
| B 段标题 | "The developer's additions" 与四个列表的标题、空列表写 "(none)" | `harness/auto-review.ts` 的 `policySection`，字面量扫描比对，0 命中 |
| 拒绝说明 | Core 给模型的拒绝理由开头、`DENIAL_NOTE`、`PAUSE_NOTE` | `piarc-policy` 与 Core 的 `review.rs`，字面量扫描比对，0 命中 |

## Git 面板的提交信息提示词（ADR-0086）

提示词在 `agent-host/src/harness/prompts/commit-message.ts`（system 段、两种语言要求、修正时的说明），user 消息的块标签与文件行在 `harness/commit-message.ts`。按 ADR-0086 第 3 条自写，写作时没有打开参考仓库的提示词；2026-11-25 用上面的脚本做 10 词窗口比对，0 个匹配窗口。2026-11-26 起脚本的渲染清单明确列入这些文字（此前渲染清单没有它们），与 ADR-0087 的提示词一起重新比对，0 个匹配窗口。

## PR 描述与审查的提示词（ADR-0087）

提示词在 `agent-host/src/harness/prompts/git-assist.ts`（PR 描述与审查的 system 段、两种语言要求），user 消息的块标签与文件行在 `harness/git-assist.ts`。按 ADR-0087 自写，写作时没有打开参考仓库的提示词；审查答复的 JSON 形状是 PiArc 自定的（`summary`、`findings` 的 `path`、`line`、`severity`、`title`、`body`）。2026-11-26 用上面的脚本做 10 词窗口比对，0 个匹配窗口。
