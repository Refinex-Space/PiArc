# R3 · M2 macOS 阶段评审

**M2（macOS）达标，可以进入 M3。** 第 16 章的两条退出标准都满足：第 6 章 M2 能力 46 项全部有 L2 场景，全套 L2 在 macOS 118 个通过、0 个失败（2 个 Windows 专属）；L3 对 Claude Code 2.1.318 的 7 个权限场景与 5 个 hooks 场景 0 个未解释差异，allowlist 每条理由经复核成立。四个独立只读审查共提出 40 条发现：修复 16 项缺陷（其中 Bash 只读白名单的 7 类绕过可让命令不经审批写文件、执行程序或读工作区外文件），每项附先失败后通过的回归测试；用户确认 ADR-0047 并在本任务实现，带通配的命令 allow 规则不再放行工作区外的路径。其余发现逐条给出不同意的理由或登记到具体任务（I120–I128）。

**进入 M3 的前提条件**（都不阻塞 T31 开工）：

1. W2 在 R4 之前完成 Windows 上的 M2 验收（含 W1 遗留的 UNC 项 W1-A05）；W1 在看板上仍为"部分完成"，R3-A07 因此为 blocked。
2. 后续任务往接近 1,000 行的文件加内容前先按领域拆分（I105：`sessions/session.rs` 987、`tool_io/policy.rs` 956、渲染进程 `store/transcript.ts` 941、`piarc-host/src/supervisor.rs` 939 行）。
3. T31、T38 按 I128 给 `piarc-policy`、`piarc-hooks`、`piarc-web` 补错误枚举；T38 按用户决定实现 hooks 环境变量白名单（I93）。
4. T45 处理权限与检查点的遗留项（I120 `Read` deny 对目录搜索不过滤、I121 审计缺口、I126 检查点故障路径）。

**W2 需要重点核对的项**（来自本次审查与 M2 的平台相关改动）：

| 项 | 为什么 | 怎样核对 |
|---|---|---|
| UNC 工作区（W1-A05、I96） | W1 本机 SMB 不可用 | 设 `PIARC_TEST_UNC_SHARE` 运行 `tool_io::policy::tests::windows_paths::a_workspace_on_a_unc_share_is_written_read_and_searched` |
| PowerShell 规则（R3 的 P11、ADR-0047） | `>`、`<` 改为复合字符；带通配规则对路径按词法判断越界（盘符、`~\`、`..\`、`-Name:值`），只有单元测试 | L2 `perm-powershell-whole`、`policy-*-powershell`；在 Windows 上手工核对 `PowerShell(Get-Content *)` 遇到 `C:\Users\…` 时询问 |
| L3 在 Windows（I118） | L3 只在 macOS 跑过，三个 PowerShell 场景排除 | 原生安装的 `claude.exe` 跑 `npm run l3`，评估移出排除清单 |
| Git Bash 下的只读白名单（I84） | R3 重写了选项解析（短选项簇、长选项前缀、`find` 前置选项）并移除 `arch` | Windows L2 `perm-read-only`、`perm-bash-compound`，`cargo test -p piarc-policy --test bash_cases` |
| hooks 的 Windows 执行 | shell 形式经 Git Bash（无则 PowerShell），超时与中断经 Job Object 结束进程树 | `cargo test -p piarc-core --lib tool_io::hooks`、L2 `hooks-*`，任务管理器确认超时后无残留 |
| 检查点与回退 | 对象库与写回的 rename 在 Windows 可能遇到共享冲突；R3 的 D3 修复按显示路径比较记录路径（`\\?\`、大小写） | `cargo test -p piarc-core --lib tool_io::checkpoints`、L2 `rewind-*`、`changes-*`；在 Windows 上把记录的文件换成指向工作区外的 junction 或符号链接后回退 |
| 设置写入的链接检查（R3 的 P8） | Windows 用重解析点判断链接，真实位置经 `canonicalize`（`\\?\` 前缀） | `.piarc` 做成指向 `%USERPROFILE%\.claude` 的 junction 后在设置页保存规则，应被拒绝 |
| 长命令与 `eval`（I102）、权限与 AHP 往返预算（I95、I103） | 只有 CI 覆盖；T23–T30 增加了裁决步骤 | 实机运行 12,000 字符以上的命令与 heredoc；`automatic_decision_latency` 用 release 构建 |
| M2 的界面 | 计划卡、提问表单、任务卡片、Changes 面板、回退对话框、登录与三档视图只在 macOS 跑过 L4 | 全量 L4（两种形态），输入法在提问表单与计划评论中可用 |

## 能力覆盖

基线 `483413b`，macOS arm64。`node scripts/ci/run-l2.mjs` 跑全部 120 个 L2 场景：118 通过、0 失败、2 个 Windows 专属按平台跳过（`exec-windows-shells`、`perm-powershell-whole`）。随后 `node scripts/plan/check-capabilities.mjs --results target/l2/results.json --doc write` 重新生成 `docs/product/capabilities.md`，内容与提交的版本相同，MISSING 0；`--milestone M2` 输出 `planned capabilities of M2 and earlier: 0`，blocked 0。能力清单中里程碑为 M2 的 46 项全部为 `active`，每项至少一个场景。所有修复提交之后，收尾的 `npm run verify` 第 14 步再跑一次全部场景（结果见"质量门禁"）。证据在 `tmp/evidence/R3/l2-start.log`、`capabilities-write.log`、`milestone-M2.log`。

M2 能力来自三处：第 16 章 M2 目标、第 6.0 节里程碑含 M2 的行、第 6.1.4 节 M2 的工具。下表逐项给出能力 ID 与覆盖场景，没有缺口。

| 来源 | M2 能力 | 能力 ID | 覆盖场景 |
|---|---|---|---|
| 16 章、6.0 权限 | 完整规则语法与 deny → ask → allow | CAP-PERM-RULE-001 | perm-rule-match、perm-powershell-whole（Windows）、webfetch-domain-rules |
| 16 章 | Bash 复合命令分析 | CAP-PERM-BASH-001 | perm-bash-compound |
| 16 章 | 只读白名单 | CAP-PERM-READONLY-001 | perm-read-only |
| 16 章 | 关键路径删除总是询问 | CAP-PERM-CRITICAL-001 | perm-critical-delete |
| 16 章 | 无 specifier 的 deny 移除工具 | CAP-PERM-TOOLS-001 | perm-rule-match |
| 16 章 | 规则管理与审计 | CAP-PERM-AUDIT-001 | perm-bash-compound |
| 6.0 权限、6.2.1 | 计划与跳过权限模式 | CAP-PERM-MODE-002 | perm-bypass、perm-critical-delete、perm-plan |
| 16 章、6.0 Plan、6.1.4 EnterPlanMode / ExitPlanMode | 计划模式硬拦截、提交与批准 | CAP-PLAN-MODE-001 | plan-mode-gate、plan-keep-planning、plan-mode-menu-reminder |
| 6.5 | 批准的计划保存为 entry 并恢复 | CAP-PLAN-ENTRY-001 | plan-entry-restart |
| 16 章、6.0、6.1.4 TodoWrite | 任务清单 | CAP-TODO-001 | todo-list |
| 6.5 | 清单随分支回溯 | CAP-TODO-BRANCH-001 | todo-branch-fork |
| 6.5 | 清单过期提醒 | CAP-TODO-REMIND-001 | todo-stale-reminder |
| 16 章、6.1.4 AskUserQuestion | 结构化提问 | CAP-ASK-001 | ask-answers、ask-timeout |
| 6.0 下一步、6.1.4 SuggestNextSteps | 回合末下一步建议 | CAP-NEXT-001 | next-steps |
| 16 章、6.0 Hooks（6.3.2 M2 事件集） | SessionStart / SessionEnd | CAP-HOOK-SESSION-001 | hooks-session-start、hooks-session-start-order、hooks-session-end |
| 同上 | UserPromptSubmit | CAP-HOOK-PROMPT-001 | hooks-user-prompt-submit、hooks-session-start-order |
| 同上 | PreToolUse 参与裁决 | CAP-HOOK-PRE-001 | hooks-pre-tool-use |
| 同上 | PermissionRequest | CAP-HOOK-PERM-001 | hooks-permission-request |
| 同上 | PostToolUse / PostToolUseFailure | CAP-HOOK-POST-001 | hooks-post-tool-use |
| 同上 | Stop 与续跑上限 | CAP-HOOK-STOP-001 | hooks-stop、hooks-stop-limit |
| 同上 | PreCompact / PostCompact | CAP-HOOK-COMPACT-001 | hooks-compact、hooks-pre-compact-block、ctx-compact-focus |
| 同上 | Notification | CAP-HOOK-NOTIFY-001 | hooks-notification |
| 16 章、6.0 Checkpoint | 写前快照 | CAP-CKPT-001 | rewind-code-and-conversation、rewind-code-only |
| 同上 | 回退代码、对话或两者，冲突提示 | CAP-CKPT-REWIND-001 | rewind-code-and-conversation、rewind-conversation-only、rewind-conflict |
| 同上 | 只恢复代码并可撤销 | CAP-REWIND-CODE-001 | rewind-code-only |
| 同上 | 从此处摘要 | CAP-REWIND-SUMMARIZE-001 | rewind-summarize |
| 同上 | 只被命令改动的文件不进快照 | CAP-REWIND-BASH-001 | rewind-bash-only |
| 6.9 | 会话分支与切换 | CAP-SESSION-FORK-001 | rewind-branch-from-message、rewind-code-and-conversation |
| 16 章 | 自动与手动压缩、恢复关键上下文 | CAP-CTX-COMPACT-001 | ctx-compact-threshold、ctx-compact-window-cap、ctx-compact-focus |
| 同上 | 压缩熔断 | CAP-CTX-COMPACT-002 | ctx-compact-breaker |
| 同上 | 压缩后按上限重注入 | CAP-CTX-COMPACT-003 | ctx-compact-restore |
| 16 章 | 上下文用量与分类 | CAP-CTX-USAGE-001 | ctx-usage |
| 6.0 上下文工程 | 统一提醒通道 | CAP-CTX-REMINDER-001 | ctx-reminders |
| 同上 | 外部修改提醒 | CAP-CTX-CHANGED-001 | ctx-file-modified、ctx-reminders |
| 同上 | 缓存断点布局不变 | CAP-CTX-CACHE-001 | ctx-cache-breakpoints |
| 16 章、6.1.4 WebFetch | 本地抓取、辅助模型提取、域名规则 | CAP-TOOL-WEBFETCH-001 | webfetch-extract、webfetch-domain-rules、webfetch-redirects-limits、webfetch-auxiliary-model |
| 16 章 Changes 面板 | 按文件统一 diff、大 diff 降级 | CAP-RV-CHANGES-001 | changes-file-and-hunk |
| 同上 | 按文件或 hunk 丢弃 | CAP-RV-DISCARD-001 | changes-file-and-hunk |
| 同上 | hunk 丢弃保真与过期拒绝 | CAP-CHANGES-HUNK-001 | changes-file-and-hunk |
| 16 章 memory 文件兼容 | CLAUDE.md 层级、导入、懒加载（M1 交付，M2 沿用） | CAP-CTX-MEMORY-001 | context-memory-hierarchy 等 10 个 `context-*` 场景 |
| 同上 | `.claude/rules` 与 `paths:` 条件加载 | CAP-CTX-RULES-001 | config-rules-paths |
| 6.14 配置兼容 | 读取 Claude Code 设置 | CAP-CONFIG-COMPAT-001 | config-merge-order、config-untrusted-project |
| 同上 | 配置诊断（基础） | CAP-CONFIG-DIAG-001 | config-merge-order、config-untrusted-project |
| 6.0 多模型适配（M1–M3） | OAuth 与设备码登录 | CAP-PROVIDER-OAUTH-001 | login-authorization-code、login-device-code |
| 同上 | 每模型设置 | CAP-MODEL-SETTINGS-001 | model-profile-default、model-settings-window-vision |
| 同上 | 辅助模型通道 | CAP-MODEL-AUXILIARY-001 | webfetch-auxiliary-model |
| 同上 | 保守 Tool Profile | CAP-MODEL-PROFILE-001 | model-profile-conservative、model-profile-default |

不属于 M2 的相关项：第 6.0 节"上下文工程"与"多模型适配"跨 M1–M3，其中 skills 正文的重注入（T37）、子 agent 的上下文隔离（T31）在 M3；hooks 的 SubagentStart/Stop、PostToolBatch 与 http、prompt 类型 handler 在 M3（CAP-HOOK-SUBAGENT-001、CAP-HOOK-HANDLER-001 为 `planned`，里程碑 M3）。

## L3 结果

最终运行在全部修复提交之后：`npm run l3`，报告首行 **`L3: PiArc 42d1a44 vs Claude Code 2.1.318; 12 scenario(s), 1 run(s) per side`**。12 个场景（`perm-accept-edits`、`perm-bypass`、`perm-compound`、`perm-default-mode`、`perm-plan`、`perm-rules`、`perm-untrusted`，`hooks-lifecycle`、`hooks-permission-request`、`hooks-post-tool-use`、`hooks-pre-tool-use`、`hooks-stop-limit`）全部 aligned：0 个未解释差异，2,747 处差异由 allowlist 放行，0 个过期条目，录制剥离检查通过。开工时在 `483413b` 上的第一次运行同样 0 个未解释差异（2,749 处放行）；减少的 2 处是 ADR-0047 落地后消失的 `perm-compound` 越界差异，对应的两条 allowlist 条目已删除。报告在 `tmp/l3/report.md`（副本 `tmp/evidence/R3/l3-report.md`），命令输出在 `tmp/evidence/R3/l3.log`、`l3-final.log`。

命令以 1 退出，唯一原因是运行前后 `~/.claude` 的快照有变化：第一次是执行本评审的 Claude Code 会话自己的转录（`projects/-Users-refinex-develop-project-PiArc/<本会话 id>.jsonl` 与四个审查子代理的 `subagents/agent-*.jsonl`），最后两次是 `~/.claude.json` 及其 `backups/` 轮换。被测的 `claude -p` 运行在临时的 `HOME` 与 `CLAUDE_CONFIG_DIR` 下（`scripts/l3/claude-side.mjs`），写不到这两处；（`~/.claude.json` 的核实见下文"质量门禁"。）这是根 `AGENTS.md` 记载的情形：同时开着的 Claude Code 会话会被报告。

### allowlist 逐条复核

逐条对照理由与 ADR、架构和后续任务。没有不成立的理由；需要处理的两类已处理（命令替换由 R3 决定维持，越界路径由 ADR-0047 修复后删除）。

| 条目（场景 / 路径） | 理由摘要 | 复核结论 |
|---|---|---|
| `*` / `tools.Agent`、`ListAgents`、`Skill` | 子 agent 与 skills 尚未实现 | 成立，T31、T37 实现时删除（I117） |
| `*` / `tools.ReportFindings`、`ScheduleWakeup`、`Workflow` | Claude Code 的产品功能，不在 PiArc 需求内 | 成立，无后续 |
| `*` / `tools.ToolSearch`、`DeferredToolPlaceholder` | PiArc 不延迟加载工具，多模型看到同一工具集（6.13） | 成立，T36 评估 MCP 工具多时是否延迟加载 |
| `*` / `tools.EnterPlanMode`、`ExitPlanMode`、`WebFetch` | Claude Code 2.1.318 把它们放在 ToolSearch 后面，PiArc 直接给出 | 成立（ADR-0042、ADR-0045 不延迟加载） |
| `*` / `tools.Grep`、`Glob` | 2.1.318 没有这两个工具；PiArc 保留规范名与 Core 侧 I/O | 成立（6.1、ADR-0020） |
| `*` / `tools.TodoWrite`、`SuggestNextSteps` | PiArc 的清单工具名（I01）与自有下一步工具 | 成立（ADR-0042） |
| `*` / `Read.**`、`Write.**`、`Edit.**`、`Bash.params.description` | 文件工具与 Bash 沿用 Pi 的参数 | 成立（ADR-0020、ADR-0028、6.13） |
| `*` / `Bash.params.run_in_background`、`dangerouslyDisableSandbox` | 后台命令与沙箱逃逸开关尚未实现 | 成立，T32、T39 |
| `*` / `AskUserQuestion.params.*` | 答案由用户在卡片上填，模型不发 | 成立（ADR-0042） |
| `*` / `requests.items[*].keys`、`system.*`、`messages` | 请求选项来自 pi-ai，system 与上下文按 PiArc 自己的分段与提醒通道 | 成立（ADR-0006、ADR-0033、ADR-0043）；工具调用与结果的顺序两侧一致 |
| `perm-compound` / `substitution` 三条 | PiArc 分析命令替换并逐个判定，Claude Code 一律询问 | 成立：R3 维持架构第 6.2.2 节的设计（I116）。命令名是运行期值、`eval`、替换里的输入重定向（R3 修复 P5 之后）仍询问。`follow_up: R3` 已删除 |
| `perm-compound` / `outside` 两条 | allow 规则先于越界检查 | 不再适用：ADR-0047 落地，行为与 Claude Code 一致，条目已删除 |
| `perm-plan` / `asks.write` | PiArc 计划模式直接拒绝写入并提示提交计划，Claude Code 交给询问 | 成立：两侧都没有写入（第 6.2.3 节第 5 步） |
| `perm-plan` / `requests.auxiliary` | Claude Code 在计划模式把非只读命令交给自动模式分类器 | 成立，T46 |
| `perm-untrusted` 四条 | PiArc 不应用未信任项目的起始模式；Claude Code `-p` 应用了 `acceptEdits` | 成立：PiArc 的行为是第 10.2 节的信任闸门要求的 |
| `perm-*` / `edit.input.replace_all` | Claude Code 回放调用时填入 schema 默认值 | 成立，无行为差异 |
| `hooks-*` / `fields.prompt_id`、`fields.effort` | hooks 输入缺两个通用字段 | 成立，T38（I115） |
| `hooks-lifecycle` / `start#0.fields.model` | 官方文档列出该字段，2.1.318 的 `-p` 未发送 | 成立 |
| `hooks-permission-request` 五条 | `-p` 下 PermissionRequest hook 的 allow 不生效、没有 Notification | 成立：`-p` 的 `--permission-prompt-tool` 不能表现文档描述的交互行为（ADR-0039） |
| `excluded` 11 个 L2 场景 | 危险删除、PowerShell 只在 Windows、卡片上的目录与规则选择、Core 重启、rules 属于上下文、手动 `/compact` 需要第二个输入 | 成立；PowerShell 三个由 W2 评估（I118） |

## 前序验收

按 task 精确筛选 `acceptance.json`（`tmp/evidence/R3/acceptance-m2.log`），`node scripts/plan/check-acceptance.mjs` 通过（773 项与任务文件一致）：

| 任务 | passing | blocked |
|---|---:|---:|
| T23 | 14 | 0 |
| T24 | 11 | 0 |
| T25 | 13 | 0 |
| T26 | 11 | 0 |
| T27 | 12 | 0 |
| T28 | 12 | 0 |
| T29 | 11 | 0 |
| T30 | 10 | 0 |
| W1 | 12 | 1 |

W1-A05 为 blocked，原因接受：UNC 共享在 W1 的机器上不可用（SMB 客户端报系统错误 1702），其余路径项（超长路径、保留名、junction、盘符、空格与中文、大小写、编码）都已通过；回归测试已写好，设 `PIARC_TEST_UNC_SHARE` 才运行，由 W2 在 SMB 正常的 Windows 上执行（I96）。

## W1 确认

- 看板：W1 为"部分完成"（完成提交 `b0a510f`），不是"已完成"。原因只有 W1-A05 的 UNC 一项，按协议只有该项通过后才能改为已完成，R3 不能代为关闭，所以 R3-A07 标为 blocked。
- 报告：[`W1-windows-m1-parity.md`](W1-windows-m1-parity.md) 的"M1 退出标准的 Windows 证据"一节逐条覆盖第 16 章 M1 的目标（两种服务商的完整任务、L2 ≥ 20、会话与持久化、六个工具与 PowerShell 经 Core、Manual 与 Accept edits、模型与保险箱、transcript P0 行类型），另有 R2 清单逐项。
- 需要用户更新的 T13–T22 验收项：无。W1 报告写明"T13–T22 中因需要 Windows 而为 blocked 的验收项：无（0 项）"，与 R2 的统计一致；本次复查 T13–T22 共 126 项全部 passing。

## 独立审查的输入与调度

四个审查者是只读的子代理（`read-only-reviewer`，只有读文件与搜索工具），在同一条消息里并行启动，基线 `483413b`，相互看不到对方。每个审查者拿到审查范围、相关文件、架构章节、威胁模型与可参考的 ADR、任务文件和既有测试，要求自己形成结论、给出文件与行号和失败场景、标出"待核实"，没有给出本评审的预判。

| 审查 | 范围与文件 | 架构与 ADR |
|---|---|---|
| 权限与 hooks 安全 | `piarc-policy`（规则、阶梯、`bash/`、账本）、`piarc-hooks`、`piarc-config`（层、Claude Code 兼容、写入、可执行项、信任）、Core 的 `tool_io/policy*`、`tool_io/hooks.rs`、`hooks/`、`trust.rs`，`piarc-exec` 与命令执行的进程树，Agent Host 的 `policy.ts`、`hooks.ts`、`project-trust.ts`、`plan-mode.ts`；关注裁决顺序、hooks allow 不越过 deny/ask、信任闸门、不写 `.claude/`、Bash 分析的绕过、进程树终止、审计完整性 | 6.2、6.3、6.14、10.1、10.2；ADR-0025、0031、0037、0038、0039；T23–T25；`bash_cases.json`、`perm-*`、`policy-*`、`hooks-*` |
| 回退与数据完整性 | `piarc-checkpoint`、`piarc-fs` 的写入路径、Core 的 `checkpoints.rs`、`tool_io/checkpoints.rs`、`tool_io/files.rs`、`sessions/session/rewind.rs`、`piarc-store`，Agent Host 的 `branches.ts`、注册表，Changes 面板与主进程的丢弃；关注快照与索引的写入顺序、冲突检测、清理误删、保真写入、对话分支不改写 JSONL | 6.1.2、6.9、7.7、9.2、9.3、10.1；ADR-0011、0027、0034、0036、0044；T28 |
| 上下文工程与缓存 | system prompt 组装与 memory、提醒通道、压缩阈值与熔断、重注入上限、用量、缓存断点、plan 模式与工具集、提示词原创性（不得打开 `reference/` 中的 clean-room 参考） | 6.5、6.6、6.15；ADR-0026、0033、0042、0043；T22、T26、T27 |
| 工程质量 | T23–T30 新增或改动的 crate 与包；crate 依赖规则、错误类型化、函数与文件长度、测试纪律、AGENTS.md 与代码一致、通用能力复用表、能力 ID 与场景 | 7.1、12；`coding-standards.md`、`testing.md`、`claude-md.md` |

汇总时比对了重复：四份审查之间没有重复的发现（P9 与 Q 系列都提到 `Read` 规则，但对象不同）。审查结论来自读源码，审查者没有运行测试；本评审对每条"确认"的发现都先写测试复现。

## 逐项核实与处理

编号与位置指审查基线 `483413b`。修复的每一项都先写失败的测试（失败输出在 `tmp/evidence/R3/` 的 `*-red.log`），修复后通过（`*-green.log`）。

| 编号 / 维度 | 位置与失败场景 | 核实结论与处理 |
|---|---|---|
| P1 权限 | `bash/readonly.rs:60`：`arch` 在只读白名单，`arch rm -rf src`、`arch -arm64 /bin/sh -c …` 免审批运行，绕过 deny、关键删除与计划模式 | 确认（数据驱动用例先红）。移出白名单。0257c93 |
| P2 权限 | `readonly.rs:406`：短选项簇只拆到 4 个字母，`sort -o/x`、`sort -ooutput`、`tree -o/x` 写文件；长选项前缀（`--out`、`--compress`）不识别 | 确认。选项词按簇逐字母判断禁用与取值，长选项按 getopt 前缀视同全名，`--files0-from` 一律不算只读。0257c93 |
| P3 权限 | `bash/walk.rs:344`：`> /dev/fd/../../x` 与 `> -` 被当作设备 | 确认。设备只认精确名字与 `/dev/fd/<数字>`，`-` 只在 `>&`、`<&` 之后。0257c93 |
| P4 权限 | `readonly.rs:354`：`grep -e.`、`--regexp=`、`--file=`、`-fPAT` 让真实文件被当成模式跳过检查 | 确认。附着形式也算显式模式，附着的值按路径检查。0257c93 |
| P5 权限 | `bash/words.rs:152`：`$(< ~/.ssh/id_rsa)` 的输入重定向被丢弃 | 确认。按 `:` 加该重定向判断。0257c93 |
| P6 权限 | `readonly.rs:368`：`find -L /`、`find -P ~` 的起始路径不检查；`--x=值` 的值不当路径 | 确认。`find` 先跳过前置选项，`--x=值` 的值按路径检查。0257c93 |
| P6b 权限（修复中发现） | `readonly.rs` 的 `uniq`、`xxd` 共用取值表，`uniq -c /外部文件` 把文件当成 `-c` 的值 | 确认（用例先红）。两者分开列取值选项。0257c93 |
| P7 权限 | `sessions/inbound.rs:46`：`hooks/run` 只查 `cwd`，可以用另一工作区打开着的会话 id 运行其 hooks | 确认（单测先红）。打开着的会话必须属于本工作区，已关闭的会话照旧按 `cwd` 检查。532820d |
| P8 权限 | `piarc-config/src/write.rs:226`：只有 projectLocal 查链接，`.piarc` 链到 `~/.claude` 时写 project 层改写了 `~/.claude/settings.json` | 确认（单测先红）。写入按解析链接后的真实位置判断 `.claude`，两个项目层都拒绝链接。56e2fb8 |
| P9 权限 | `assess.rs:189`：`Read(./.env)` deny 对 `Grep` 以目录为参数、Bash 递归读取不生效 | 确认（读码）。需要把 deny 传到 `piarc-fs` 的遍历做结果过滤，登记 I120 交 T45，架构 6.2.2 写明限制 |
| P10 权限 | `executables.rs:186`：信任清单里的 hook 名不含 `args`、`shell`、`if`，`node fmt.js` 换成 `node evil.js` 不触发新增项 | 确认（集成测试先红）。条目名带上三者，不带它们的 hook 名字不变。d6bdefb |
| P11 权限（Windows） | `assess.rs:257`：PowerShell 带 `*` 的 allow 放行带 `>`、`<` 的命令 | 确认（单测先红）。加入复合字符。31107ec |
| P12 权限 | 模式切换、hook `updatedPermissions`、"总是允许"保存的规则、设置页规则编辑不写审计；hook 审计失败只记日志 | 确认（读码）。登记 I121 交 T45 |
| P13 权限 | PermissionRequest hook 的 allow 可代答 ask 规则；hook `setMode` 撤销信任后仍保留；`addRules` 直接并入信任快照 | 部分不同意：代答 ask 规则与 Claude Code 文档一致（hook 在询问出现时运行），不改行为；ADR-0039 未写明，撤销信任后的遗留需要处理。登记 I122 交 T38 |
| P14 权限 | `critical.rs:56`：`rm -rf $HOME/../..`、`"$PWD/.."`、`~root` 不算关键删除，`Bash(rm *)` 下免审批 | 确认（用例先红）。先展开家目录与工作目录再判断，`~user` 算关键。941fc37 |
| P15 权限 | hook 进程树在 macOS 只按进程组；hook 失败默认放行；deny 按归一化文本匹配；跳过权限开关中途关闭不重验；PermissionRequest exit 2 语义 | 进程树：同意，属已知限制 I36，架构 6.3.1 改写为按平台；失败放行：不同意，与 Claude Code 一致（`onFailure: "block"` 可阻断）；其余登记 I123（T38、T45） |
| D1 回退 | `checkpoints.rs:313`、`store.rs:209`：回收先读引用再遍历，期间写入记行并释放钉的对象被删，回退报 Missing | 确认（单测先红）。`ObjectStore::begin_collection` 在读引用之前开始，回收期间释放钉的对象本次保留。b1f065d |
| D2 回退 | `session.rs:589`、`rewind.rs:105`、`session-registry.ts:300`：回退只在开始时查空闲，摘要期间发来的提示开了新回合，随后被重开销毁 | 确认（端到端测试先红）。会话 actor 记录在途的 prompt 与独占的回退、分支切换，互相以 `sessionBusy` 拒绝。b406451 |
| D3 回退 | `tool_io/checkpoints.rs:51`：需审批路径按当前解析结果绑定，记录的文件被换成指向 `~/.zshrc` 的链接后，选择覆盖会写进链接目标 | 确认（单测先红）。批准只覆盖记录的路径：被链接改指的文件在预览中是冲突，写回失败，不经链接写入。2aa6da1 |
| D4 回退 | `tool_io/checkpoints.rs:483`：文件已写回后 `record` 失败，报告与撤销丢失 | 确认（读码），需要注入数据库故障。登记 I126 交 T45 |
| D5、D6、D9 回退 | 先替换后记录的崩溃窗口；记录在路径锁外的乱序；重开失败时报告与 leaf 不一致 | 窗口很短或需故障注入，登记 I126 交 T45 |
| D7、D10、D11 回退 | 快照不含权限位；对象 rename 后不 fsync 目录、无磁盘上限；关闭检查点的回合与先被 Bash 改过的文件在预览里没有提示 | 登记 I127（T44、T42） |
| D8 回退 | `tool_io/checkpoints.rs:715`：hunk 丢弃对解码有损的文件会把非法字节换成 U+FFFD | 部分不同意：实测这类文件的 hunk 丢弃以 `fileModified` 拒绝，字节不变，整文件丢弃恢复原字节；补了防护测试（4dd795e）。提示语不准确，登记 I127 交 T42 |
| C1 上下文 | `tokens.ts:11`：字符数 / 4 对中文低估，重注入上限与"无效压缩"判断偏松 | 确认口径（未用真实分词器量比例）。改口径须改 ADR-0043，登记 I124 交 T41 |
| C2 上下文 | `session-memory.ts:339`：冻结的 system prompt 用 Pi 在处理器之前复制的工具列表，整体 deny 移除的工具仍写进工具指引 | 确认（Pi 源码 `runner.js:1130` 复制选项；L2 断言先红）。按 `pi.getActiveTools()` 过滤。3f7587a |
| C3、C5、C6 上下文 | 小窗口时 T ≤ 0、每模型窗口大于模型窗口；重启后计划模式提醒；`session_compact` 中途抛错计为有效 | 边界情况，登记 I125 交 T48 |
| C4 上下文 | 熔断状态在会话重开时也复位 | 同意记录，不改行为：ADR-0043 已否决持久化（I107），复位范围写入 6.6.4 与 `harness/AGENTS.md`。9519d68 |
| C7 上下文 | 原创性检查没有覆盖参数 schema 的描述与 memory、提醒、中断、结果预算里的固定句子 | 确认。脚本从源码取出这些字面量，3,141 词、0 个匹配窗口。cdaea4d |
| Q1 质量 | `session-registry.ts` 1,030 行 | 确认。组装 Harness 部件移到 `runtime/session-parts.ts`，981 行。e78571c |
| Q2 质量 | `l2/runner.rs` 1,287 行、`format.rs` 1,143 行（I88），`check_actions` 的豁免理由指向 R3 | 确认。拆成 `runner/settings.rs`、`approvals.rs`、`asserts.rs` 与 `format/refs.rs`，去掉豁免；120 个场景不变。e264e05 |
| Q3 质量 | 复用表漏登 T24、T26、T27、T28、T30 的共享能力 | 确认，补 8 行。da11683 |
| Q4 质量 | `piarc-policy`、`piarc-hooks` 无 `error.rs`，解析返回 `String`；`piarc-web` 的错误在 `lib.rs` | 确认。登记 I128 交 T31、T38 |
| Q5 质量 | 三份子目录 AGENTS.md 超过 120 行（I89、I108、I119） | 确认。按任务分节的内容并入 `agent-host/src/{harness,providers,tools}`、`piarc-core/src/{tool_io,sessions}` 的 AGENTS.md。60eaf18 |
| Q6 质量 | 原子写入有多份实现，复用表说法与依赖规则矛盾 | 同意记录：功能 crate 不能互相依赖，多份实现是规则的结果；复用表写明并要求同步修改。da11683 |
| Q7 质量 | `let _ =` 缺注释、`perm-critical-delete` 描述多于断言、`piarc-policy/AGENTS.md` 措辞、`scripts/l3/AGENTS.md` 缺文件 | 确认，逐项改正。7fe9582。审计步骤名为字符串一项并入 I128 |

用户决定（本次会话）：ADR-0047 接受并在 R3 实现（42d1a44：Bash 由 `bash::judge` 定位带通配规则放行的命令中像路径的参数，PowerShell 按词法判断；用例在 `bash_cases.json`、`assess.rs` 单测与 L2 `perm-bash-compound`，L2 先红后绿见 `adr47-l2-red.log`、`adr47-l2-green.log`）；I93 增加用户级 hooks 环境变量白名单，交 T38。

## 登记事项

逐条处理 `PLAN.md` 的登记事项：

- 关闭：I37、I66、I101（Windows CI 已覆盖），I88、I89、I106、I108、I119（R3 落地），I104、I107、I116（R3 决定，I116 经用户确认 ADR-0047 后落地），I93 由用户决定后交 T38。
- 指定处理任务：I78 → T32，I83 → T45，I87 → R4 与 T41（本次没有联网对照官方 settings 索引），I105 → 后续加内容的任务先拆分，I117 → 内容列所列的任务。I07 复查后维持（typescript-eslint 8.73.0 仍只支持 `typescript` `<6.1.0`）。
- 新登记：I120–I128（见上表）。其余事项此前都已写明处理任务或已落地，没有变化。

## 质量门禁

- `npm run verify` 在 `42d1a44`（全部修复已提交）15/15 通过：cargo test、Vitest、L2 118 通过 / 0 失败 / 2 平台跳过、能力覆盖 MISSING 0（`tmp/evidence/R3/verify-final.log`）。
- Windows x64 交叉 Clippy（工作区全部目标）通过（`windows-clippy.log`）；Windows 原生验收由 W2 执行。
- 全量 L4（两种形态，`npm run package:desktop -- --flavor development` 后 `npm run test:e2e -w @piarc/desktop`）：224 通过、5 按平台跳过、4 失败（`tmp/evidence/R3/l4.log`）。`t18-review` 两个形态失败于 `screencapture -l`：运行测试的终端没有"屏幕录制"权限，与合并 W1 时记录的情形相同（`apps/desktop/AGENTS.md`）。`t26-harness` 的"下一步"用例两个形态失败：点击"在此执行"后，界面在新回合开始之前就满足 `idle`，断言读到的请求数还是 2；单独运行通过，`--repeat-each 4` 8 次失败 6 次，撤掉 R3 的会话改动（D2）后同样失败，所以不是 R3 的回归。用例改为等待 mock 收到第 3 个请求（提交见 git log），之后两种形态 40/40 通过（`t26-poll.log`）。
- `~/.claude.json` 的核实：最后一次 L3 结束时它的修改时间是 1795178334，之后没有运行 L3，约 80 秒后它变为 1795178415，写入方是执行评审的 Claude Code 会话本身。
- 本任务没有界面改动；修改的提示词经原创性检查（0 个匹配窗口）。

## 附录 · 审查原文要点

四份审查的原文由子代理返回，下面按维度保留其发现、位置与已核对项（编号由本评审加，P 权限与 hooks、D 回退与数据完整性、C 上下文工程、Q 工程质量）。

### 权限与 hooks 安全

- 权限与 hooks 审查（原文要点）：阶梯顺序、信任闸门、.claude 写保护主路径与设计一致；风险集中在 Bash 只读白名单。
- P1 高：readonly.rs:60 PROGRAMS 含 arch；154-156 Paths::None；324-402 listed。`arch -arm64 /bin/sh -c '…'`、`arch rm -rf ~/proj` 判只读自动允许，绕过 deny、关键删除、plan。修：移除 arch 或归入 EXEC_WRAPPERS。（macOS arch 执行其后程序，待核实）
- P2 高：readonly.rs:406-421 forbidden 单短横只在 letters.len()<=4 且全字母数字时逐字比较；`sort -o/Users/me/.zshrc in`、`sort -ooutput in`、`tree -o/tmp/x` 绕过 → 任意写；长选项前缀缩写 --out=、--compress=（--compress-program 可执行程序，macOS 是否接受缩写待核实）。
- P3 高：walk.rs:344-349 `/dev/fd/` 前缀未规范化 ..；`-` 无条件当设备。`echo x > /dev/fd/../../Users/me/.zshrc`、`cd .git && echo x > -` 自动允许。修：精确集合 + /dev/fd/ 后纯数字；- 只在 >&-、<&-。
- P4 高：readonly.rs:354-355 explicit_pattern 只认精确 -e/-f/--regexp/--file；381-385 AfterFirst 跳过首操作数。`grep -e. ~/.ssh/id_rsa`、`grep --regexp=. .env`、`rg --file=pat target`、`grep -fPAT target` → reads 为空，越界读与 Read deny 绕过。
- P5 高/中：words.rs:152-166 substitution 中 file_redirect 交给 redirect(…, &mut ignored) 后丢弃；`echo "$(< ~/.ssh/id_rsa)"` 只读自动允许。
- P6 中：readonly.rs:368-377 find 遇首个 - 词 break；`find -L / -name id_rsa`、`find -P ~ -type f`、`find -E -f dir` 起始路径不检查；`--files0-from=F`（sort/wc/du）、`diff --from-file=F` 附着值不当路径。
- P7 中：core sessions/inbound.rs:46-52 hooks/run 绕过 sessions 集合检查；tool_io/hooks.rs:166-242 只检查 cwd 在本工作区；可用另一工作区会话 id 运行其 hooks、改 set_transcript、starting() 卡住 B 的 UserPromptSubmit。违反 R1-A13。
- P8 中：config write.rs:226-247 符号链接检查只对 PROJECT_LOCAL；settings_view.rs:217-246（设置页写 project）、policy/hooks.rs:313-330（hook projectSettings）；.piarc → ~/.claude 链接后改写 ~/.claude/settings.json。修：PROJECT 与 PROJECT_LOCAL 都 redirected() 检查，canonicalize 父目录后 is_claude_path。
- P9 中（部分待核实）：assess.rs:189-212 file_call 只用调用 path 对规则求值；grants.rs:171-224；Read(./.env) deny 对 Grep path=. 或 Bash rg/grep -r 无效（无按 deny 过滤结果）。
- P10 中：config executables.rs:186-208 hook 条目名 "{event}[{matcher}] {command}" 不含 args/shell/if；exec 形式 args 变化（fmt.js→evil.js）不触发新增项确认（I63）；piarc-hooks Handler::identity 口径不同。
- P11 中/低（Windows）：assess.rs:257 compound 字符集缺 > <；PowerShell(Get-Content *) 放行 `Get-Content a > C:\…`。
- P12 低：审计缺口：modes.rs:104-126 changed_mode 无审计（含 bypass）；policy/hooks.rs:248-271 updatedPermissions 成功无审计；policy.rs:670-688 audit_detail 无 decision 与保存规则；settings_view.rs:211-273 规则增删改无审计；hooks/mod.rs:371-382 hook 审计失败只 warn。
- P13 低：decision.rs:196-214 after_permission_request 可覆盖 askRule、invalidRule、protectedPath、outsideWorkspace、hookAsk（ADR-0039 未写明 askRule）；hook setMode 写 workspaces.default_mode 撤销信任后仍保留；hook addRules 并入信任快照无 check_permanent。
- P14 低：critical.rs:56-86 漏判 `rm -rf $HOME/../..`、`~root`、`$PWD/..`（只在有 Bash(rm *) allow 时相关）。
- P15 低：hook 进程树 macOS 只用进程组（6.3.1 措辞）；hook 失败默认放行；deny 按归一化文本匹配，`git -C . push` 不命中 Bash(git push *)；policy.rs:109-131 ruling 不重验 enableBypassPermissions；PermissionRequest exit 2 实现为忽略并读 stdout（待核实）。
- 已检查无问题：阶梯顺序（hook allow 越过越界询问，符合"跳到第 6 步"）、updatedInput 重新裁决、PermissionRequest 不覆盖 deny、信任闸门、.claude 写保护主路径、授权绑定、审批账本、计划模式、hook 终止（2 s 后 kill，killpg）、复合/替换/heredoc/sh -c/eval/赋值污染/cd 跟踪。

### 回退与数据完整性

- 回退与数据完整性审查（原文要点）：JSONL 只追加、回退目标、期望哈希写回与 ADR-0011/0044 一致。
- D1 中：core checkpoints.rs:313-325 collect 先取 referenced_snapshots()，checkpoint store.rs:209-246 collect_garbage 后遍历；期间 fs/write put(h)→插行→释放钉（files.rs:183-191；回退侧 tool_io/checkpoints.rs:483-498），h 不在过期 referenced 也无钉 → 被删，索引指向缺失对象，回退/丢弃报 Missing，Changes 隐藏该文件。违反 ADR-0044 第 2 条。修：记录回收周期内释放的钉，或删除时在钉表锁内复核最新引用。
- D2 中：sessions/session.rs:589 start_op 只在入口检查 active_turn；rewind.rs:105-140 rewind_code 后 session/rewind 之间不复查；session-registry.ts:300-314 #checkIdle 在 await summarizeFromTurn 之前，之后不复查，AbortController 永不中止。摘要期间发新提示 → branchWithSummary 在运行中会话上移 leaf 且 #reopen 销毁运行时；代码+对话模式中途新回合 → 文件已回退、对话未动。违反 ADR-0044 第 5 条。修：Core 回退中拒绝 Prompt/Steer/FollowUp；Host await 后复查。
- D3 中（待核实）：tool_io/checkpoints.rs:51-61 scope_for 把 NeedsApproval 当已批准；locate 解析符号链接，不比较与记录路径一致；a.txt 换成指向 ~/.zshrc 的链接后，冲突覆盖写入 ~/.zshrc 或删除链接目标；预览显示记录路径。修：locate 结果须等于记录路径，否则冲突/错误。
- D4 低-中：tool_io/checkpoints.rs:483-489（丢弃 706-710）文件已写回后 cp.record 失败 ? 提前退出，报告丢失、无 restore_id、钉释放后被替换内容可被回收 → 不可撤销。修：记录失败仍返回报告并保持钉。
- D5 低：fs write.rs:171-181 先替换，core files.rs:224-234 后记录；崩溃或 record 失败（只 warn）→ 写入不在回退与 Changes 中。修：替换前写 pending 行。
- D6 低（待核实）：record_write 在路径锁外（files.rs:183），同文件并行两写可能乱序入库，plan_restore 取错 before。
- D7 低：fs restore.rs:111-125、atomic.rs:127-130 快照无权限位，文件被删后恢复丢 0755；无权限位/符号链接用例。
- D8 低（待核实）：tool_io/checkpoints.rs:715-726、text_of 551-561 hunk 丢弃对非法 UTF-8 文件把非法字节替换为 U+FFFD。修：非无损往返时拒绝 hunk 丢弃。
- D9 低（待核实）：session-registry.ts:300-314、524-543；rewind.rs:128-138 rewindToTurn 已追加 piarc.branch 后 #open 失败 → Core 报对话未回退但 leaf 已移动。
- D10 低：checkpoint store.rs:152-159 put 已存在不校验内容；rename 后未 fsync 目录；对象库无磁盘上限。
- D11 低：关闭 fileCheckpointingEnabled 的回合写的文件跨回合回退不报冲突不恢复；先被 Bash 改、后被 agent 写的文件恢复到首次经 Core 写入前。建议预览提示。
- 已检查无问题：plan.rs 回退目标、撤销幂等；replace 锁内期望哈希；对象写入顺序与 GC 范围；referenced 只含 before_hash；文件保真；JSONL 只追加（forkedManager 的 SessionManager.open 在旧版本文件上会触发 Pi 迁移重写，非本变更）；Changes discard 路径限定与版本核对；保留策略。

### 上下文工程与缓存

- 上下文工程审查（原文要点）：无高严重度。常量：OUTPUT_RESERVE_CAP 20000 (compaction-threshold.ts:11)、SAFETY_MARGIN 13000 (:13)、T=W−min(O,20K)−13K (:33-35)、reserve=max(0,W−T+1) (:44-46)、autoCompactWindow 夹 100K–1M (core tool_io/context.rs:28)、AUTO_COMPACT_FAILURE_LIMIT 3 (compaction.ts:78)、RESTORE_LIMITS (reinjection.ts:25-36)、TODO_REMINDER_ROUNDS 8 (todos.ts:32)。
- C1 中：tokens.ts:11-18 字符/4 估算对中文低估；reinjection.ts:163-180 上限、compaction.ts:366/498 #after 无效压缩判断漏报 → 熔断不计数、每回合重压缩（待核实）。修：CJK 权重或用服务商报告校准 #after。
- C2 中（待核实）：session-memory.ts:339-340、policy.ts:239-254、session-registry.ts:724-748；policyGate 在 before_agent_start setActiveTools，但 memory.extension 读 options.selectedTools 快照，冻结的 tool_guidance 可能列出被整体 deny 移除的工具。
- C3 低：compaction-threshold.ts:45 T≤0（小窗口）时每次运行前都压缩；override>模型窗口时 reserve 钳到 0，在模型窗口而非 T 触发；无单测。
- C4 低：compaction.ts:251-254、session-registry.ts:621 熔断状态在 #reopen（回退、切分支、setModel/setPreferences、空闲回收）也复位，比文档范围大。
- C5 低：plan-mode.ts:78、reminders.ts:207-212 #told 初始=mode==plan；delivered 早于落盘，重启后可能不再提醒（闸门仍正确）。
- C6 低：compaction.ts:366、487-498 session_compact 重注入阶段抛错时 #after undefined → 记为有效压缩并清零 strikes。
- C7 低：check-prompt-originality.mjs:15-46 只渲染 Profile description，不含参数 schema 描述（plan-mode.ts:126-131、todos.ts:43-63）与 memory 提醒固定句（session-memory.ts:249）；记录表未标对应改动。
- 已检查无问题：system prompt 冻结、缓存断点（memory-wire.ts:65-103）、plan 模式不改工具集（plan-mode-menu-reminder same_system_as/same_tools_as）、阈值与 Pi 等价、reload/apply 时机、熔断语义、重注入上限、用量缩放、todo 与文件变化提醒。
- 缺失回归测试：中文估算、T≤0/override、首次运行整体 deny、reopen 后熔断、ctx-cache-breakpoints 无 same_tools_as、模型切换与压缩前后工具集不变。

### 工程质量

- 工程质量审查（原文要点）：无高危。依赖方向合规，CLAUDE.md 单行，无 #[ignore]/.skip 进入 M2。
- Q1 中：agent-host/src/runtime/session-registry.ts 1030 行 >1000；I105 最后记录 941（T28），T29/T30 未更新。建议拆 T29 登录/辅助模型逻辑。
- Q2 中：piarc-testkit l2/runner.rs 1287、format.rs 1143；I88 未处理；format.rs:962 check_actions 的 expect 理由写 "R3 splits format.rs (I88)"。
- Q3 中：coding-standards.md 第 4 节复用表漏登 T24（SETTINGS_KEYS、rules::{rule_files,PathMatcher}、diagnostics）、T26（policy/questions.rs、policy/plan.rs）、T27（reminders.ts、compaction-threshold.ts、reinjection.ts）、T28（piarc_checkpoint::plan、Checkpoints）、T30（piarc_testkit::l3、scripts/l3/）。
- Q4 中：piarc-policy、piarc-hooks 无 error.rs，公开解析返回 Result<_,String>：policy rules.rs:125、paths.rs:63；hooks matcher.rs:38、runner.rs:36；config trust.rs:36、rules.rs:109；web ssrf.rs:47；piarc-web FetchError 在 lib.rs、无 Error/Result 别名；piarc-hooks lib.rs 含 run 与 audit_detail 实现；core tool_io/checkpoints.rs:440,466,510、policy/hooks.rs:279,345 String 错误（给用户看，可保留但注释）。规范 2.3/2.1。
- Q5 中：子目录 AGENTS.md 超长：agent-host 155、piarc-core 150、apps/desktop 121（上限 120；I89/I119/I108）。
- Q6 低：原子写入多份实现（checkpoint store.rs:295、config write.rs:343、secrets atomic.rs:41、fs atomic.rs、fs content.rs:168、core attachments.rs:185）；复用表"保真写入"一行说 Core 外复用这里，与依赖规则矛盾；piarc-hooks runner::{stop,EXIT_GRACE} 重写 piarc_exec 两段终止。建议复用表注明。
- Q7 低：let _ = 缺注释（core sessions/login.rs:98,129、tool_io/policy.rs:446、policy/memory.rs:64、policy/questions.rs:254、sessions/session/rewind.rs:168）；perm-critical-delete.yaml 描述含 filesystem root 但只测 ~ 与 .；policy.rs:439 审计步骤字符串匹配；piarc-policy/AGENTS.md requiresUserInteraction 措辞；scripts/l3/AGENTS.md 缺 files.mjs、home-snapshot.mjs。
- 超长：runner.rs 1287、format.rs 1143、piarc-host/tests/resilience.rs 1194（T06，R2 Q04 已记录保留理由）、session-registry.ts 1030；接近：core sessions/session.rs 987、tool_io/policy.rs 956、desktop store/transcript.ts 941、piarc-host supervisor.rs 939。
- 已核对：依赖方向、crate 根文档、5 处 expect 都有 reason、AGENTS.md 常量存在、根命令存在、测试纪律（NOT RUN 打印）、7 个场景断言、L3 allowlist reason。
