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
