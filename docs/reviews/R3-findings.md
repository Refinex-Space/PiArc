# R3 · M2 macOS 阶段评审

（结论待汇总）

## 能力覆盖

基线 `483413b`，macOS arm64。`node scripts/ci/run-l2.mjs` 跑全部 120 个 L2 场景：118 通过、0 失败、2 个 Windows 专属按平台跳过（`exec-windows-shells`、`perm-powershell-whole`）。随后 `node scripts/plan/check-capabilities.mjs --results target/l2/results.json --doc write` 重新生成 `docs/product/capabilities.md`，内容与提交的版本相同，MISSING 0；`--milestone M2` 输出 `planned capabilities of M2 and earlier: 0`，blocked 0。能力清单中里程碑为 M2 的 46 项全部为 `active`，每项至少一个场景。证据在 `tmp/evidence/R3/l2-start.log`、`capabilities-write.log`、`milestone-M2.log`。

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

`npm run l3`，报告首行：**`L3: PiArc 483413b vs Claude Code 2.1.318; 12 scenario(s), 1 run(s) per side`**。12 个场景（7 个权限、5 个 hooks）全部 aligned：0 个未解释差异，2,749 处差异由 allowlist 放行，0 个过期条目；录制剥离检查 24 个文件通过。命令以 1 退出，唯一原因是 `~/.claude` 前后快照中 5 个文件变化，全部是执行本次评审的 Claude Code 会话自己的转录（`projects/-Users-refinex-develop-project-PiArc/<本会话 id>.jsonl` 及其 4 个审查子代理的 `subagents/agent-*.jsonl`），不是被测的 `claude -p`（它运行在临时 `CLAUDE_CONFIG_DIR` 与 `HOME` 下）。这是根 `AGENTS.md` 易错点记载的情形（"同时开着的 Claude Code 会话写会话记录也会被报告"）。报告在 `tmp/l3/report.md`，命令输出在 `tmp/evidence/R3/l3.log`。

### allowlist 逐条复核

（待补）

## 前序验收

（待补）

## W1 确认

（待补）

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
