# 能力清单

> 由 `node scripts/plan/check-capabilities.mjs --results <L2 报告> --doc write` 根据 `tests/capabilities.yaml` 与 L2 场景结果生成，不要手工编辑。格式与规则见 `docs/engineering/testing.md` 第 13 节。

状态：**已实现** = `active` 且至少一个 L2 场景覆盖；**计划中** = `planned`；**BLOCKED** = 因外部原因暂缓；**MISSING** = `active` 却没有场景；**失败** = 覆盖它的场景没有通过。

## 汇总

| 里程碑 | 能力数 | 已实现 | 计划中 | BLOCKED |
|---|---|---|---|---|
| M1 | 61 | 61 | 0 | 0 |
| M2 | 46 | 46 | 0 | 0 |
| M3 | 47 | 47 | 0 | 0 |
| M4 | 31 | 31 | 0 | 0 |
| M5 | 25 | 24 | 1 | 0 |

## M1

| ID | 能力 | 需求与架构 | 任务 | 覆盖场景 | 状态 |
|---|---|---|---|---|---|
| CAP-CHAT-ATTACH-001 | 图片与 PDF 附件送达模型 | FR-CH-02 | T19 | `chat-composer-input` | 已实现 |
| CAP-CHAT-MENTION-001 | 输入中的 `@` 文件提及与 `/` 命令解析后送达模型 | FR-CH-02 | T19 | `chat-composer-input` | 已实现 |
| CAP-CTX-MEMORY-001 | CLAUDE.md、AGENTS.md、CLAUDE.local.md 层级，`@import` 与子目录懒加载 | FR-CX-01、ARCH-6.6.2、ARCH-6.14 | T22 | `context-memory-external-approval`<br>`context-memory-external-deny`<br>`context-memory-file-tools`<br>`context-memory-hierarchy`<br>`context-memory-imports`<br>`context-memory-lazy`<br>`context-memory-read-both`<br>`context-memory-updated`<br>`context-system-sections`<br>`context-system-stable` | 已实现 |
| CAP-CTX-PROMPT-001 | 分段 system prompt（静态段与动态段分别缓存，每个请求一个消息级缓存断点） | ARCH-6.6.1、ARCH-6.15 | T22 | `context-memory-updated`<br>`context-system-sections`<br>`context-system-stable` | 已实现 |
| CAP-EXEC-ABORT-001 | 中断回合时正在执行的命令连同子孙进程一起终止，条目为 interrupted | FR-TL-01、ARCH-6.11、ARCH-15.2 | T17 | `exec-abort-kills-tree` | 已实现 |
| CAP-EXEC-CWD-001 | cd 在工作区内跨命令保留；越出工作区时下一条命令回到工作区根并说明原因 | FR-TL-01、ARCH-6.11 | T17 | `exec-cwd-carry-over` | 已实现 |
| CAP-EXEC-ENV-001 | 命令环境不含 Electron、Node、Pi、PiArc 的内部变量与任何凭据 | ARCH-5.4、ARCH-6.11 | T17 | `exec-env-internal-vars` | 已实现 |
| CAP-EXEC-EXITCODE-001 | grep 无匹配、diff 有差异等退出码 1 按语义判为成功，结果与条目说明含义 | FR-TL-02、ARCH-5.3 | T17 | `exec-exit-code-meaning` | 已实现 |
| CAP-EXEC-GITBASH-001 | Windows 上 Bash 经 Git Bash 执行，中文输出不乱码，/c/ 形式路径转换后做边界判断 | ARCH-6.2.2、ARCH-15.2 | T17 | `exec-windows-shells`（仅 windows） | 已实现 |
| CAP-EXEC-LOGINENV-001 | 命令环境以用户登录 shell 的环境为基础，profile 中配置的 PATH 生效 | ARCH-6.11 | T17 | `exec-env-login-path`（仅 macos） | 已实现 |
| CAP-EXEC-OUTPUT-001 | 成功输出超过 30,000 字符时落盘并给约 2,000 字符预览与路径；失败输出给头部与尾部 | FR-TL-02、ARCH-6.11、ARCH-6.15 | T17 | `exec-output-budget` | 已实现 |
| CAP-EXEC-STREAM-001 | 命令输出在结束前以条目增量到达客户端；完成的条目带 bash 卡的结构化字段 | FR-TL-02、ARCH-5.3、ARCH-6.1.3 | T17 | `exec-streaming-output` | 已实现 |
| CAP-EXEC-TIMEOUT-001 | 命令超时（默认 2 分钟、上限 10 分钟）后转为后台任务继续运行（T32 替换 T17 的终止），结果说明转后台、任务 id 与输出文件 | FR-TL-01、ARCH-6.11 | T17 | `exec-timeout-kills-tree` | 已实现 |
| CAP-EXT-PI-001 | 信任的项目 Pi 扩展被加载，其注册的工具可被模型调用 | ARCH-5.5、ARCH-10.2 | T13 | `trust-trusted-loads-project-extension` | 已实现 |
| CAP-MODEL-SWITCH-001 | 会话内切换模型与 effort，提示切换代价 | FR-MD-03、ARCH-6.13 | T21 | `provider-settings-models`<br>`turn-model-effort` | 已实现 |
| CAP-PERM-APPROVAL-001 | 结构化审批：仅本次、本会话、总是允许、拒绝并反馈 | FR-PM-02、ARCH-6.2.3 | T20 | `policy-extra-directory`<br>`policy-save-rule`<br>`policy-session-rule`<br>`subagent-approval` | 已实现 |
| CAP-PERM-MODE-001 | 手动与自动接受编辑两种权限模式 | FR-PM-01、ARCH-6.2.1 | T20 | `policy-accept-edits`<br>`policy-accept-edits-powershell`<br>`policy-manual`<br>`policy-manual-powershell`<br>`policy-mode-restore`<br>`policy-shell-boundary`<br>`policy-untrusted` | 已实现 |
| CAP-PROVIDER-ANTHROPIC-001 | Anthropic Messages 线格式的服务商 | FR-MD-01、ARCH-6.13 | T06 | `chat-basic` | 已实现 |
| CAP-PROVIDER-CLOUD-001 | 云厂商凭证与本地模型服务商 | FR-MD-01 | T21 | `provider-settings-models` | 已实现 |
| CAP-PROVIDER-CONFIG-001 | 配置服务商与 API key；凭据只存在 Core 的保险箱并经 AHP 交给 Agent Host | FR-MD-01、ARCH-5.4 | T21 | `provider-settings-models` | 已实现 |
| CAP-PROVIDER-OPENAI-001 | OpenAI 兼容端点的服务商（流式正文、工具调用与工具结果） | FR-MD-01、ARCH-6.13 | T06 | `provider-openai-wire` | 已实现 |
| CAP-SESSION-MANAGE-001 | 新建、重命名、置顶、归档、删除会话 | FR-WS-03 | T18 | `session-manage` | 已实现 |
| CAP-SESSION-MULTI-001 | 同一工作区的多个会话同时运行，各自的工作目录与请求互不串扰 | ARCH-5.2、ARCH-5.3 | T14 | `sessions-two-cwds-isolated` | 已实现 |
| CAP-SESSION-PERSIST-001 | 会话持久化，Core 重启后可恢复并带着完整历史继续 | FR-WS-03、ARCH-9 | T14 | `sessions-persist-across-restart` | 已实现 |
| CAP-SESSION-STATUS-001 | Core 快照送达会话状态、待答审批数和未读标记，客户端按优先级显示徽标 | FR-WS-02 | T20 | `policy-session-rule` | 已实现 |
| CAP-SESSION-TURN-001 | 输入开始一个回合，正文与工具调用以条目事件流式送达客户端 | FR-CH-01、ARCH-5.3 | T14 | `chat-basic` | 已实现 |
| CAP-SYS-NOTIFY-001 | 会话完成或等待审批时发出通知事件 | FR-SY-01 | T20 | `policy-session-rule` | 已实现 |
| CAP-TOOL-BASH-001 | Bash 经 Core 执行命令并返回输出 | FR-TL-01、ARCH-6.1.4 | T07 | `tools-canonical-via-core` | 已实现 |
| CAP-TOOL-BASH-002 | Bash 终止整个进程树（KillShell、中断；T32 起超时转后台），输出给出语义成败 | FR-TL-01、FR-TL-02、ARCH-6.11 | T17 | `exec-exit-code-meaning`<br>`exec-timeout-kills-tree` | 已实现 |
| CAP-TOOL-CORE-001 | 工具的文件与命令 I/O 全部经 Core 的 AHP fs/exec 方法执行 | FR-TL-01、ARCH-6.1.3 | T07 | `tools-canonical-via-core` | 已实现 |
| CAP-TOOL-DIFF-001 | 每次文件变更的 fileChange 条目带 Core 生成的 unified diff 与 hunk | FR-TL-01、ARCH-6.1.2、ARCH-7.7 | T16 | `tools-file-change-diff` | 已实现 |
| CAP-TOOL-EDIT-001 | Edit 按文本替换修改文件 | FR-TL-01、ARCH-6.1.4 | T07 | `tools-canonical-via-core` | 已实现 |
| CAP-TOOL-EDIT-002 | 编辑不变量：先读后写、外部修改检测、多处匹配拒绝、编码与换行保持 | FR-TL-01、ARCH-6.1.2 | T16 | `tools-edit-detects-external-change`<br>`tools-edit-preserves-encoding`<br>`tools-edit-requires-read`<br>`tools-edit-unique-match` | 已实现 |
| CAP-TOOL-EDIT-EXTERNAL-001 | 读取后文件被外部修改，Edit 报错并要求重新读取，文件保持外部修改后的内容 | FR-TL-01、ARCH-6.1.2 | T16 | `tools-edit-detects-external-change` | 已实现 |
| CAP-TOOL-EDIT-READFIRST-001 | 对已存在的文件 Edit 或 Write 前，本会话必须读过它，否则报错并要求先 Read，文件不变 | FR-TL-01、ARCH-6.1.2 | T16 | `tools-edit-requires-read`<br>`tools-read-failed-retry` | 已实现 |
| CAP-TOOL-EDIT-UNIQUE-001 | Edit 的旧文本必须唯一出现或显式 replaceAll；多处匹配报出次数、零匹配报错，都不改文件 | FR-TL-01、ARCH-6.1.2 | T16 | `tools-edit-unique-match` | 已实现 |
| CAP-TOOL-GLOB-001 | Glob 由 Core 按模式列出文件 | FR-TL-01、ARCH-6.1.4 | T07 | `tools-canonical-via-core` | 已实现 |
| CAP-TOOL-GREP-001 | Grep 由 Core 搜索文件内容 | FR-TL-01、ARCH-6.1.4 | T07 | `tools-canonical-via-core` | 已实现 |
| CAP-TOOL-OUTPUT-001 | 超长工具结果落盘，模型收到预览与路径；单条消息的工具结果有总上限 | FR-TL-02、ARCH-6.15 | T16 | `tools-output-spill` | 已实现 |
| CAP-TOOL-PATH-BOUNDARY-001 | 会话目录之外的读写需要询问；审批落地（T20）之前按拒绝处理并说明理由 | FR-TL-01、ARCH-6.1.2 | T16 | `policy-extra-directory`<br>`tools-path-boundary` | 已实现 |
| CAP-TOOL-PATH-PROTECTED-001 | 受保护路径（.git/、.piarc/、.claude/、.pi/、shell 配置文件）的写入需要询问，T20 之前按拒绝处理 | FR-TL-01、ARCH-6.1.2 | T16 | `tools-protected-paths` | 已实现 |
| CAP-TOOL-POWERSHELL-001 | Windows 上的 PowerShell 工具 | ARCH-6.1.4、ARCH-6.2.2 | T17 | `exec-shell-tools-macos`（仅 macos）<br>`exec-windows-shells`（仅 windows） | 已实现 |
| CAP-TOOL-PROFILE-001 | 模型看到的工具名是规范名，不出现 Pi 原生工具名 | ARCH-6.1.1 | T07 | `tools-model-sees-canonical-names` | 已实现 |
| CAP-TOOL-READ-001 | Read 读取工作区文本文件 | FR-TL-01、ARCH-6.1.4 | T07 | `tools-canonical-via-core` | 已实现 |
| CAP-TOOL-READ-002 | Read 带行号分页、图片、PDF 分页与 ipynb | FR-TL-01、ARCH-6.1.4 | T16 | `tools-read-formats` | 已实现 |
| CAP-TOOL-REREAD-001 | 文件自上次读取后未变化时 Read 返回简短存根 | ARCH-6.15 | T16 | `tools-read-failed-retry`<br>`tools-read-repeat-stub` | 已实现 |
| CAP-TOOL-SEARCH-LIMITS-001 | Grep 与 Glob 遵守 .gitignore，Grep 跳过二进制文件，结果超过上限时截断并说明 | FR-TL-01、ARCH-6.1.3 | T16 | `tools-search-ignore-and-limits` | 已实现 |
| CAP-TOOL-WRITE-001 | Write 创建与覆盖文件 | FR-TL-01、ARCH-6.1.4 | T07 | `tools-canonical-via-core` | 已实现 |
| CAP-TOOL-WRITE-FIDELITY-001 | Edit 与 Write 保留文件的换行风格、BOM 与编码，只改目标文本，原子替换 | FR-TL-01、ARCH-6.1.2 | T16 | `tools-edit-preserves-encoding` | 已实现 |
| CAP-TOOL-WRITE-SERIAL-001 | 写同一文件的工具调用串行执行，结果按调用顺序叠加 | ARCH-6.1.2、ARCH-6.15 | T16 | `tools-write-serial` | 已实现 |
| CAP-TRUST-DIALOG-001 | 首次打开工作区时列出将启用的可执行配置并记录用户的信任决定 | FR-WS-01、ARCH-10.2 | T18 | `trust-trusted-loads-project-extension` | 已实现 |
| CAP-TRUST-PROJECT-001 | 未信任的工作区不加载项目级可执行配置（Pi 扩展等）；信任后加载 | FR-WS-01、ARCH-10.2 | T13 | `trust-trusted-loads-project-extension`<br>`trust-untrusted-skips-project-extension` | 已实现 |
| CAP-TURN-BATCH-001 | 连续的只读工具调用成批并行（单批至多 10 个），写操作单独执行 | ARCH-6.15 | T14 | `turn-tool-batches` | 已实现 |
| CAP-TURN-ERROR-001 | 不可恢复的错误按类别报告，可重试，未送达的消息可重发 | FR-CH-06 | T19 | `turn-classified-errors` | 已实现 |
| CAP-TURN-FOLLOWUP-001 | 运行中排队的 follow-up 在回合结束后作为新回合执行 | FR-CH-03 | T14 | `turn-follow-up` | 已实现 |
| CAP-TURN-INTERRUPT-001 | 停止回合时为未完成的工具调用补齐结果，下一次请求配对完整、角色交替 | FR-CH-03、ARCH-6.15 | T14 | `turn-interrupt-pairs-tool-calls` | 已实现 |
| CAP-TURN-QUEUE-001 | 排队项可编辑、删除、重排，按新顺序各执行一次 | FR-CH-03 | T14 | `turn-queue-edit-reorder` | 已实现 |
| CAP-TURN-REASONING-001 | 思考内容以 reasoning 条目流式送达，effort 映射到服务商参数 | FR-CH-01、FR-MD-03、ARCH-6.13 | T21 | `turn-model-effort` | 已实现 |
| CAP-TURN-RETRY-001 | 限流、过载与 5xx 自动重试，每次重试报给客户端，失败的尝试不进入上下文 | FR-CH-04、FR-CH-06、ARCH-6.15 | T14 | `turn-retry-recoverable-errors` | 已实现 |
| CAP-TURN-STATUS-001 | 回合进行中提供当前工具、计时、token、重试次数与压缩状态 | FR-CH-04 | T19 | `chat-composer-input`<br>`turn-classified-errors` | 已实现 |
| CAP-TURN-STEER-001 | 运行中 steer：消息在当前步骤之后进入本回合的下一次请求 | FR-CH-03、ARCH-5.3 | T14 | `turn-steer` | 已实现 |

## M2

| ID | 能力 | 需求与架构 | 任务 | 覆盖场景 | 状态 |
|---|---|---|---|---|---|
| CAP-ASK-001 | AskUserQuestion 结构化提问 | FR-HN-03、ARCH-6.5 | T26 | `ask-answers`<br>`ask-timeout` | 已实现 |
| CAP-CHANGES-HUNK-001 | 按 hunk 丢弃只撤销该处改动，CRLF 与 BOM 保真，过期的 diff 被拒绝，agent 需重新读取 | FR-RV-02、ARCH-7.7 | T28 | `changes-file-and-hunk` | 已实现 |
| CAP-CKPT-001 | 每次写入前保存快照，形成检查点 | FR-RV-03、ARCH-6.9 | T28 | `rewind-code-and-conversation`<br>`rewind-code-only` | 已实现 |
| CAP-CKPT-REWIND-001 | 回退：恢复代码与对话、只恢复对话或只恢复代码，冲突时提示 | FR-RV-03、ARCH-6.9 | T28 | `rewind-code-and-conversation`<br>`rewind-conflict`<br>`rewind-conversation-only`<br>`subagent-checkpoint` | 已实现 |
| CAP-CONFIG-COMPAT-001 | 读取 Claude Code 的 `.claude/settings*.json`（permissions 等与 PiArc 功能对应的键） | ARCH-6.14 | T24 | `config-merge-order`<br>`config-untrusted-project`<br>`model-default-setting` | 已实现 |
| CAP-CONFIG-DIAG-001 | 配置诊断：每个配置文件的加载状态与生效、覆盖、忽略的键（基础） | FR-EX-05、ARCH-6.14 | T24 | `config-merge-order`<br>`config-untrusted-project` | 已实现 |
| CAP-CTX-CACHE-001 | reminder 追加与压缩前后保持 Anthropic 缓存断点布局 | ARCH-6.6.1、ARCH-6.15 | T27 | `ctx-cache-breakpoints` | 已实现 |
| CAP-CTX-CHANGED-001 | 读过的文件被外部修改后，下一次模型请求带修改提醒 | ARCH-6.6.3 | T27 | `ctx-file-modified`<br>`ctx-reminders` | 已实现 |
| CAP-CTX-COMPACT-001 | 自动压缩与手动 `/compact`，熔断与压缩后恢复关键上下文 | FR-CX-03、ARCH-6.6.4、ARCH-6.15 | T27 | `ctx-compact-focus`<br>`ctx-compact-threshold`<br>`ctx-compact-window-cap`<br>`subagent-compaction` | 已实现 |
| CAP-CTX-COMPACT-002 | 连续 3 次自动压缩失败或无效后停止自动压缩并提示，手动 `/compact` 仍可用 | FR-CX-03、ARCH-6.6.4、ARCH-6.15 | T27 | `ctx-compact-breaker` | 已实现 |
| CAP-CTX-COMPACT-003 | 压缩后按上限重注入 memory、计划、任务清单、skill 正文与最近文件 | FR-CX-03、ARCH-6.6.4、ARCH-6.15 | T27 | `ctx-compact-restore` | 已实现 |
| CAP-CTX-REMINDER-001 | 动态信息经 system reminder 送达，不破坏缓存 | ARCH-6.6.3 | T27 | `ctx-reminders`<br>`subagent-background` | 已实现 |
| CAP-CTX-RULES-001 | `.claude/rules` 与 `paths:` 条件加载 | FR-CX-02、ARCH-6.14 | T24 | `config-rules-paths` | 已实现 |
| CAP-CTX-USAGE-001 | 上下文用量与分类明细 | FR-CX-04、ARCH-6.6.5 | T27 | `ctx-usage` | 已实现 |
| CAP-HOOK-COMPACT-001 | PreCompact 与 PostCompact hooks | FR-HN-05、ARCH-6.3.2 | T25 | `ctx-compact-focus`<br>`hooks-compact`<br>`hooks-pre-compact-block` | 已实现 |
| CAP-HOOK-NOTIFY-001 | Notification hook | FR-HN-05、ARCH-6.3.2 | T25 | `hooks-archive-during-hook`<br>`hooks-notification` | 已实现 |
| CAP-HOOK-PERM-001 | PermissionRequest hook | FR-HN-05、ARCH-6.3.2 | T25 | `hooks-permission-request` | 已实现 |
| CAP-HOOK-POST-001 | PostToolUse 与 PostToolUseFailure hooks（可改写输出、追加上下文） | FR-HN-05、ARCH-6.3.2 | T25 | `hooks-post-tool-use` | 已实现 |
| CAP-HOOK-PRE-001 | PreToolUse hook 参与权限裁决 | FR-HN-05、ARCH-6.3.2、ARCH-6.2.3 | T25 | `hooks-pre-tool-use` | 已实现 |
| CAP-HOOK-PROMPT-001 | UserPromptSubmit hook | FR-HN-05、ARCH-6.3.2 | T25 | `hooks-session-start-order`<br>`hooks-user-prompt-submit` | 已实现 |
| CAP-HOOK-SESSION-001 | SessionStart 与 SessionEnd hooks | FR-HN-05、ARCH-6.3.2 | T25 | `hooks-session-end`<br>`hooks-session-start`<br>`hooks-session-start-order` | 已实现 |
| CAP-HOOK-STOP-001 | Stop hook（block 时续跑一轮，带防循环计数） | FR-HN-05、ARCH-6.3.2 | T25 | `hooks-stop`<br>`hooks-stop-limit` | 已实现 |
| CAP-MODEL-AUXILIARY-001 | 辅助模型调用通道：设置中指定辅助模型（未设置时用会话模型），用量计入会话 | FR-TL-03、ARCH-6.13 | T29 | `webfetch-auxiliary-model` | 已实现 |
| CAP-MODEL-PROFILE-001 | 工具调用可靠性低的模型使用保守 Tool Profile，可在每模型设置中改回默认 | FR-MD-04、ARCH-6.13、ARCH-6.1.1 | T29 | `model-profile-conservative`<br>`model-profile-default` | 已实现 |
| CAP-MODEL-SETTINGS-001 | 每个模型的显示名、上下文窗口、图片输入与默认 effort | FR-MD-04 | T29 | `model-profile-default`<br>`model-settings-window-vision` | 已实现 |
| CAP-NEXT-001 | 回合结束时的"下一步"建议 | FR-HN-06、ARCH-6.5 | T26 | `next-steps` | 已实现 |
| CAP-PERM-AUDIT-001 | 规则管理与审计记录 | FR-PM-04 | T23 | `perm-bash-compound` | 已实现 |
| CAP-PERM-BASH-001 | Bash 复合命令逐个子命令判定 | FR-PM-03、ARCH-6.2.2 | T23 | `perm-bash-compound` | 已实现 |
| CAP-PERM-CRITICAL-001 | 关键路径删除在任何模式下都询问，包括跳过权限与存在匹配的 allow 规则 | FR-PM-03、ARCH-6.2.2 | T23 | `perm-critical-delete` | 已实现 |
| CAP-PERM-MODE-002 | 计划与跳过权限模式（跳过权限需显式开启并二次确认） | FR-PM-01、ARCH-6.2.1 | T23 | `perm-bypass`<br>`perm-critical-delete`<br>`perm-plan` | 已实现 |
| CAP-PERM-READONLY-001 | 内置只读命令白名单在手动模式下免审批，路径越界或夹带其他命令时询问 | FR-PM-03、ARCH-6.2.2 | T23 | `perm-read-only` | 已实现 |
| CAP-PERM-RULE-001 | 兼容 Claude Code 的规则语法，按 deny → ask → allow 裁决 | FR-PM-03、ARCH-6.2.2 | T23 | `perm-powershell-whole`（仅 windows）<br>`perm-rule-match`<br>`sec-read-deny-search`<br>`subagent-denied-type`<br>`webfetch-domain-rules`<br>`worktree-session-rules` | 已实现 |
| CAP-PERM-TOOLS-001 | 不带 specifier 的 deny 规则把工具从模型请求的工具列表中移除 | FR-PM-03、ARCH-6.2.2 | T23 | `perm-rule-match` | 已实现 |
| CAP-PLAN-ENTRY-001 | 批准的计划保存为会话 entry，重启与恢复后经注入接口读回 | FR-HN-01、ARCH-6.5 | T26 | `plan-entry-restart` | 已实现 |
| CAP-PLAN-MODE-001 | 计划模式：写工具与非只读命令被硬拦截，提交计划，批准时选择后续模式 | FR-HN-01、ARCH-6.5、ARCH-6.15 | T26 | `plan-keep-planning`<br>`plan-mode-gate`<br>`plan-mode-menu-reminder` | 已实现 |
| CAP-PROVIDER-OAUTH-001 | 服务商的 OAuth 与设备码登录（不含 Anthropic 订阅登录） | FR-MD-02、ARCH-5.4 | T29 | `login-authorization-code`<br>`login-device-code` | 已实现 |
| CAP-REWIND-BASH-001 | 只被命令改动的文件不进快照，回退预览与 Changes 视图不列出，回退时保留 | FR-RV-03、ARCH-6.9 | T28 | `rewind-bash-only` | 已实现 |
| CAP-REWIND-CODE-001 | 只恢复代码：文件回到所选回合开始前（新建的删除），对话不动，agent 改文件前重新读取，可撤销 | FR-RV-03、ARCH-6.9 | T28 | `rewind-code-only` | 已实现 |
| CAP-REWIND-SUMMARIZE-001 | 从此处摘要：所选回合及之后的对话写成分支摘要（自写的分节摘要提示），文件不动 | FR-RV-03、ARCH-6.9、ARCH-6.6.4 | T28 | `rewind-summarize` | 已实现 |
| CAP-RV-CHANGES-001 | 会话改动按文件给出统一 diff，大 diff 降级 | FR-RV-01、ARCH-7.7 | T28 | `changes-file-and-hunk` | 已实现 |
| CAP-RV-DISCARD-001 | 按文件或按 hunk 丢弃改动 | FR-RV-02 | T28 | `changes-file-and-hunk` | 已实现 |
| CAP-SESSION-FORK-001 | 从某条消息分出会话分支并在分支间切换 | FR-WS-07、ARCH-6.9 | T28 | `rewind-branch-from-message`<br>`rewind-code-and-conversation` | 已实现 |
| CAP-TODO-001 | 任务清单由模型维护，结构化送达客户端，压缩后保留 | FR-HN-02、ARCH-6.5 | T26 | `todo-list` | 已实现 |
| CAP-TODO-BRANCH-001 | 任务清单随分支回溯：在较早 entry 处 fork 后，清单等于该处的状态 | FR-HN-02、ARCH-6.5 | T26 | `todo-branch-fork` | 已实现 |
| CAP-TODO-REMIND-001 | 存在未完成项且连续若干轮工具调用未更新清单时，以追加消息提醒模型 | FR-HN-02、ARCH-6.6.3 | T26 | `todo-stale-reminder` | 已实现 |
| CAP-TOOL-WEBFETCH-001 | WebFetch 本地抓取转 Markdown，辅助模型按提示提取，受域名规则约束 | FR-TL-03、ARCH-6.1.4 | T29 | `webfetch-auxiliary-model`<br>`webfetch-domain-rules`<br>`webfetch-extract`<br>`webfetch-redirects-limits` | 已实现 |

## M3

| ID | 能力 | 需求与架构 | 任务 | 覆盖场景 | 状态 |
|---|---|---|---|---|---|
| CAP-AGENT-APPROVAL-001 | 子 agent 的审批卡出现在主会话并标明来源，模式不比主会话宽松 | FR-HN-04、ARCH-6.4、ARCH-6.2.3 | T31 | `subagent-approval` | 已实现 |
| CAP-AGENT-CHECKPOINT-001 | 子 agent 改动的文件进入主会话当前回合的检查点，回退时恢复 | FR-HN-04、ARCH-6.9 | T31 | `subagent-checkpoint` | 已实现 |
| CAP-AGENT-DEF-001 | 读取 `.claude/agents` 与 `.piarc/agents` 的子 agent 定义，内置 general-purpose、Explore、Plan | FR-HN-04、ARCH-6.4 | T31 | `subagent-denied-type`<br>`subagent-general-purpose`<br>`subagent-tool-filter` | 已实现 |
| CAP-AGENT-FILTER-001 | 子 agent 的工具按 tools、disallowedTools 过滤并移除提问与计划工具，调用被移除的工具在闸门处拒绝 | FR-HN-04、ARCH-6.4 | T31 | `subagent-explore-fast`<br>`subagent-tool-filter` | 已实现 |
| CAP-AGENT-HOOKS-001 | 子 agent 定义中的 hooks 只在其运行期间生效，项目级定义的 hooks 信任前不执行 | FR-HN-04、ARCH-6.3.1 | T31 | `subagent-hooks`<br>`subagent-hooks-untrusted` | 已实现 |
| CAP-AGENT-INTERRUPT-001 | 中断主会话时进行中的子 agent 一并中止，未完成的工具调用补齐已中断结果 | FR-HN-04、ARCH-6.15 | T31 | `subagent-interrupt`<br>`subagent-interrupt-starting` | 已实现 |
| CAP-AGENT-LIMIT-001 | 子 agent 深度上限移除 Agent 工具，并发上限立即返回说明上限的错误 | FR-HN-04、ARCH-6.4 | T31 | `subagent-concurrency`<br>`subagent-depth` | 已实现 |
| CAP-AGENT-RUN-001 | 子 agent 使用任意服务商模型、可后台运行、最多 3 层、默认不继承父会话历史 | FR-HN-04、ARCH-6.4、ARCH-6.15 | T31 | `subagent-background`<br>`subagent-compaction`<br>`subagent-explore-fast`<br>`subagent-general-purpose`<br>`subagent-max-turns`<br>`subagent-worktree` | 已实现 |
| CAP-BG-COMMAND-001 | run_in_background 启动的命令立即返回任务 id 与输出文件，模型用 Read 读取输出 | FR-TL-04、ARCH-6.11 | T32 | `bg-run-in-background` | 已实现 |
| CAP-BG-KILL-001 | KillShell 终止整棵进程树并保留输出，只能停止本会话（含子 agent）的任务 | FR-TL-04、ARCH-6.11 | T32 | `exec-timeout-kills-tree` | 已实现 |
| CAP-BG-MONITOR-001 | Monitor 后台运行命令，把新增输出按行回灌给模型 | FR-TL-04、ARCH-6.11 | T32 | `monitor-wake-idle` | 已实现 |
| CAP-BG-NOTICE-001 | 后台任务结束后，任务 id、命令、退出码与语义、耗时、输出文件与尾部预览在下一回合以 system reminder 注入 | FR-TL-04、ARCH-6.6、ARCH-6.11 | T32 | `bg-completion-reminder` | 已实现 |
| CAP-BG-SUBAGENT-001 | 后台子 agent 进入任务管理器，可从面板停止，状态记为 killed | FR-TL-04、FR-HN-04、ARCH-6.11 | T32 | `bg-subagent-stop` | 已实现 |
| CAP-BG-TIMEOUT-001 | 前台命令超时后转为后台任务，同一进程继续运行，工具结果说明已转后台 | FR-TL-04、ARCH-6.11 | T32 | `bg-timeout-to-background` | 已实现 |
| CAP-CMD-001 | 自定义斜杠命令（`.claude/commands`、Pi prompt templates） | FR-EX-02、ARCH-6.7 | T37 | `command-expand` | 已实现 |
| CAP-CMD-EXPAND-001 | `/名称 参数` 由 Core 在 UserPromptSubmit 之前展开（`$ARGUMENTS`、位置参数与命名参数），转录显示用户输入的原文，可由用户调用的 skill 同样展开 | FR-EX-02、ARCH-6.7 | T37 | `command-expand` | 已实现 |
| CAP-HOOK-HANDLER-001 | http 与 prompt 类型的 hook handler（prompt 经辅助模型单轮判定） | FR-HN-05、ARCH-6.3.2 | T38 | `hooks-m3-prompt` | 已实现 |
| CAP-HOOK-SUBAGENT-001 | SubagentStart、SubagentStop 与 PostToolBatch hooks；子 agent 内的 hooks 输入带 agent_id、agent_type | FR-HN-05、ARCH-6.3.2 | T38 | `hooks-m3-post-tool-batch`<br>`hooks-m3-subagent` | 已实现 |
| CAP-MCP-CHANGES-001 | server instructions 进入 system prompt 第 6 段；工具集因 `list_changed` 或连接变化而改变时以追加消息送达，system prompt 不变 | FR-EX-03、ARCH-6.6.1、ARCH-6.8 | T36 | `mcp-tools-changed` | 已实现 |
| CAP-MCP-CONFIG-001 | MCP 配置来源（`.mcp.json`、`~/.claude.json` 的 user 与 local、PiArc 用户与 `.piarc/` 设置）、同名按"企业 > 本地 > 项目 > 用户 > 插件"取整条定义、`${VAR}` 展开、SSE 与 WebSocket 标为不支持 | FR-EX-03、ARCH-6.8、ARCH-6.14 | T36 | `mcp-untrusted-project` | 已实现 |
| CAP-MCP-DEFER-001 | 工具多时延迟加载（ToolSearch） | FR-EX-03、ARCH-6.1.4、ARCH-6.8 | T36 | `mcp-defer-toolsearch` | 已实现 |
| CAP-MCP-OAUTH-001 | MCP 的 OAuth | FR-EX-03、ARCH-6.8 | T36 | `mcp-http-oauth` | 已实现 |
| CAP-MCP-PERM-001 | `mcp__server__tool` 与 `mcp__server__*` 规则生效，带 `requiresUserInteraction` 标记的工具在任何模式下都询问 | FR-EX-03、ARCH-6.2.2、ARCH-6.8 | T36 | `mcp-rules-interaction` | 已实现 |
| CAP-MCP-POOL-001 | MCP 工作区共享连接池 | FR-EX-03、ARCH-6.8 | T36 | `mcp-pool-shared` | 已实现 |
| CAP-MCP-SUBAGENT-001 | 子 agent 定义的 `mcpServers`：按名称引用的 server 复用连接池，内联 server 只在该子 agent 运行期间连接 | FR-HN-04、FR-EX-03、ARCH-6.4、ARCH-6.8 | T36 | `mcp-subagent-servers`<br>`mcp-subagent-untrusted` | 已实现 |
| CAP-MCP-TRANSPORT-001 | MCP 的 stdio 与 Streamable HTTP 传输 | FR-EX-03、ARCH-6.8 | T36 | `mcp-http-oauth`<br>`mcp-pool-shared` | 已实现 |
| CAP-MCP-TRUST-001 | 未信任项目的 MCP server（`.mcp.json`、`.piarc/` 设置、项目级子 agent 的内联定义）不连接、不启动进程 | FR-EX-03、ARCH-6.8、ARCH-10.2 | T36 | `mcp-subagent-untrusted`<br>`mcp-untrusted-project` | 已实现 |
| CAP-MODEL-ALIAS-001 | 模型别名表供子 agent 与 skills 引用 | FR-MD-05 | T31 | `model-default-setting`<br>`subagent-degrade`<br>`subagent-explore-fast`<br>`subagent-model-aliases` | 已实现 |
| CAP-MODEL-DEGRADE-001 | 按模型能力降级（例如不支持图片输入时的处理） | ARCH-6.13 | T31 | `subagent-degrade` | 已实现 |
| CAP-MONITOR-PERM-001 | Monitor 的命令受 Bash 规则、Bash 分析与 Bash matcher 的 PreToolUse hooks 约束，Manual 模式下需要审批 | FR-TL-04、FR-PM-03、ARCH-6.2、ARCH-6.3 | T32 | `monitor-hooks-bash-matcher`<br>`monitor-permissions` | 已实现 |
| CAP-MONITOR-RATE-001 | Monitor 单次回灌受行数与字符数上限约束，超出时说明省略行数与输出文件；总量到上限后停止回灌并告知模型 | FR-TL-04、ARCH-6.11 | T32 | `monitor-rate-limit` | 已实现 |
| CAP-MONITOR-WAKE-001 | 会话空闲时 Monitor 的新增输出唤醒会话，唤醒频率受限速约束 | FR-TL-04、ARCH-6.11 | T32 | `monitor-wake-idle` | 已实现 |
| CAP-SESSION-PARALLEL-001 | 跨工作区与多窗口的会话并行运行 | FR-WS-05 | T35 | `worktree-parallel-sessions` | 已实现 |
| CAP-SESSION-SEARCH-001 | 会话全文搜索 | FR-WS-04、ARCH-9.2 | T35 | `worktree-session-create` | 已实现 |
| CAP-SKILL-001 | Skills（Agent Skills 标准；`.claude/skills`、`.piarc/skills`、用户级），渐进加载 | FR-EX-01、ARCH-6.7 | T37 | `skill-index` | 已实现 |
| CAP-SKILL-ALLOWED-001 | `allowed-tools` 在调用 skill 的回合内免审批，下一回合恢复询问，deny 与 ask 规则仍然优先 | FR-EX-01、ARCH-6.2.3、ARCH-6.7 | T37 | `skill-allowed-tools` | 已实现 |
| CAP-SKILL-INDEX-001 | system prompt 第 5 段只列模型可调用的 skill 名称与截断后的描述，`disable-model-invocation` 的不列 | FR-EX-01、ARCH-6.6.1、ARCH-6.7 | T37 | `skill-index` | 已实现 |
| CAP-SKILL-INVOKE-001 | `Skill` 工具加载正文并完成参数替换，正文留在对话中、压缩后按上限重注入，frontmatter 的 `hooks` 从调用起生效 | FR-EX-01、ARCH-6.6.4、ARCH-6.7 | T37 | `skill-invoke` | 已实现 |
| CAP-SKILL-PATHS-001 | 带 `paths` 的 skill 在处理匹配文件后才进入索引，以追加消息送达 | FR-EX-01、ARCH-6.7 | T37 | `skill-paths` | 已实现 |
| CAP-STYLE-001 | 输出风格切换与自定义 | FR-HN-07、ARCH-6.7 | T37 | `style-switch` | 已实现 |
| CAP-STYLE-SWITCH-001 | 新会话把当前输出风格放在 system prompt 第 3 段；会话中途切换以追加消息送达，已发送的 system prompt 不变 | FR-HN-07、ARCH-6.6.1、ARCH-6.7 | T37 | `style-switch` | 已实现 |
| CAP-TERM-READ-001 | agent 用 terminal 运行的命令进入会话的终端并作为后台任务运行；命令结束后提醒退出码与屏幕末尾，Read 任务文件得到屏幕文本与最近一条命令的结果 | FR-TL-05、ARCH-6.11 | T33 | `term-agent-command` | 已实现 |
| CAP-TERM-SCREEN-001 | 集成终端与会话共享目录和环境，agent 可读取后台终端的屏幕内容 | FR-TL-05、ARCH-6.11 | T33 | `term-agent-command`<br>`term-agent-env`（仅 macos） | 已实现 |
| CAP-TERM-SHARE-001 | 用户在终端面板中打开的终端默认不给 agent；用户打开共享后 agent 得到屏幕的位置并能读取，取消共享后又看不到 | FR-TL-05、ARCH-6.11 | T34 | `term-user-share`（仅 macos） | 已实现 |
| CAP-TOOL-WEBSEARCH-001 | WebSearch 可配置后端：服务商原生搜索优先、其次第三方搜索 API（key 只在保险箱），结果带来源，经同一权限裁决与 hooks，无可用后端时不提供 | FR-TL-03、ARCH-6.1.4 | T38 | `websearch-native`<br>`websearch-rules`<br>`websearch-third-party`<br>`websearch-unavailable` | 已实现 |
| CAP-WT-AGENT-001 | 子 agent 可在独立 worktree 中隔离运行 | ARCH-6.12 | T35 | `subagent-worktree` | 已实现 |
| CAP-WT-SESSION-001 | 新建会话可选在独立 git worktree 中运行，归档时处理未提交改动 | FR-WS-06、ARCH-6.12 | T35 | `worktree-archive-cleanup`<br>`worktree-parallel-sessions`<br>`worktree-session-create`<br>`worktree-session-rules` | 已实现 |

## M4

| ID | 能力 | 需求与架构 | 任务 | 覆盖场景 | 状态 |
|---|---|---|---|---|---|
| CAP-CONFIG-DIAG-002 | 配置诊断完善（全部配置来源） | FR-EX-05 | T41 | `config-diag-sources` | 已实现 |
| CAP-HOOK-CONFIGCHANGE-001 | ConfigChange hooks：会话中设置文件变化时运行，block 让该变更不在本会话生效（企业来源不可阻断） | FR-HN-05、ARCH-6.3.2 | T41 | `hooks-m4-config-change` | 已实现 |
| CAP-HOOK-CWDCHANGED-001 | CwdChanged hooks：命令改变会话的持久 cwd 后运行，watchPaths 替换监视列表 | FR-HN-05、ARCH-6.3.2 | T41 | `hooks-m4-cwd-file-changed` | 已实现 |
| CAP-HOOK-EXPANSION-001 | UserPromptExpansion hooks：斜杠命令、skill 与 MCP prompt 展开前运行，exit 2 或 decision block 阻止展开，纯文本 stdout 作为上下文 | FR-HN-05、ARCH-6.3.2 | T41 | `hooks-m4-expansion` | 已实现 |
| CAP-HOOK-FILECHANGED-001 | FileChanged hooks：watchPaths 中的文件在磁盘上变化时运行，监视上限 64 个 | FR-HN-05、ARCH-6.3.2 | T41 | `hooks-m4-cwd-file-changed` | 已实现 |
| CAP-HOOK-INSTRUCTIONS-001 | InstructionsLoaded hooks：memory 文件与 rules 进入上下文时运行，matcher 为加载原因 | FR-HN-05、ARCH-6.3.2 | T41 | `hooks-m4-instructions-loaded` | 已实现 |
| CAP-HOOK-MCPTOOL-001 | mcp_tool hook handler：调用工作区已连接 MCP server 的工具，input 模板按 hook 输入替换，返回文本按决策协议解析 | FR-HN-05、ARCH-6.3.2 | T41 | `hooks-m4-mcp-tool` | 已实现 |
| CAP-HOOK-STOPFAILURE-001 | StopFailure hooks：回合因 API 错误在重试用尽后结束时运行，matcher 为错误类型，输出被忽略 | FR-HN-05、ARCH-6.3.2 | T41 | `hooks-m4-stop-failure` | 已实现 |
| CAP-MCP-PROMPTS-001 | MCP prompts 作为斜杠命令 `mcp__<server>__<prompt>`：位置参数、必填检查、只送文本内容，`prompts/list_changed` 后命令列表更新 | ARCH-6.7、ARCH-6.8 | T40 | `mcp-prompts` | 已实现 |
| CAP-PIPKG-GIT-001 | Pi 包从 git 安装并锁定提交，确认后 `pi` 字段声明的扩展、skills、prompt templates 生效，themes 不加载 | FR-EX-04、ARCH-6.7 | T40 | `pi-package-git` | 已实现 |
| CAP-PLUGIN-001 | 插件：Claude Code 插件目录与 Pi 包，启用前展示来源与能力 | FR-EX-04、ARCH-6.7、ARCH-6.14 | T40 | `plugin-commands` | 已实现 |
| CAP-PLUGIN-AGENTS-001 | 插件的子 agent 定义是 `<plugin>:<名称>` 类型，可由 Agent 工具调用 | FR-EX-04、ARCH-6.4、ARCH-6.7 | T40 | `plugin-agents` | 已实现 |
| CAP-PLUGIN-COMMANDS-001 | 插件的命令文件是 `<plugin>:<路径>` 斜杠命令，展开时替换参数与 `${CLAUDE_PLUGIN_ROOT}`，不覆盖项目与用户的同名命令 | FR-EX-04、ARCH-6.7 | T40 | `plugin-commands` | 已实现 |
| CAP-PLUGIN-HOOKS-001 | 插件的 `hooks/hooks.json` 在启用且确认后于对应事件运行；未确认的 hook 不运行 | FR-EX-04、ARCH-6.3、ARCH-6.7 | T40 | `plugin-hooks` | 已实现 |
| CAP-PLUGIN-MCP-001 | 插件的 `.mcp.json` server 以 `plugin_<plugin>_<server>` 加入连接池（优先级最低）并暴露工具 | FR-EX-04、ARCH-6.7、ARCH-6.8 | T40 | `plugin-mcp` | 已实现 |
| CAP-PLUGIN-SKILLS-001 | 插件的 skill 以 `<plugin>:<名称>` 进入索引并可由 Skill 工具加载 | FR-EX-04、ARCH-6.7 | T40 | `plugin-skills` | 已实现 |
| CAP-PLUGIN-TRUST-001 | 未信任项目的项目作用域插件与 Pi 包不加载：无 hook、无 MCP 连接、无扩展、无命令 | FR-EX-04、ARCH-10.2 | T40 | `plugin-untrusted-project` | 已实现 |
| CAP-SANDBOX-AUTO-001 | "沙箱内自动批准"模式下沙箱内的 Bash 命令不弹审批，deny、ask 规则、关键路径删除与计划模式照常拦截 | FR-TL-07、ARCH-6.2.3、ARCH-6.10 | T39 | `sandbox-auto-allow`（仅 macos）<br>`sandbox-auto-ask-rule`（仅 macos）<br>`sandbox-auto-critical-delete`（仅 macos）<br>`sandbox-auto-deny-rule`（仅 macos）<br>`sandbox-auto-plan`（仅 macos） | 已实现 |
| CAP-SANDBOX-MACOS-001 | macOS 上 Bash 在 Seatbelt 中执行，文件写入与网络按白名单放行 | FR-TL-07、ARCH-6.10 | T39 | `sandbox-ask-writes`（仅 macos） | 已实现 |
| CAP-SANDBOX-PATHS-001 | 前台命令、run_in_background 后台命令与 Monitor 命令都在沙箱内执行 | FR-TL-07、ARCH-6.10、ARCH-6.11 | T39 | `sandbox-launch-paths`（仅 macos）<br>`sandbox-terminal`（仅 macos） | 已实现 |
| CAP-SANDBOX-PROJECT-001 | 项目级配置只能收紧沙箱：自动批准与白名单域名不生效并在配置诊断中标出 | FR-TL-07、ARCH-6.2.1、ARCH-6.10 | T39 | `sandbox-project-tightens`（仅 macos） | 已实现 |
| CAP-SANDBOX-RETRY-001 | 沙箱外重试（dangerouslyDisableSandbox）在任何模式都询问，只有仅本次与拒绝，hooks 不能代答 | FR-TL-07、ARCH-6.10 | T39 | `sandbox-unsandboxed-retry`（仅 macos） | 已实现 |
| CAP-SANDBOX-WINDOWS-001 | Windows 上命令的隔离方案（第一版只做进程树管理，见需求 D7） | FR-TL-07、ARCH-6.10 | T39 | `sandbox-windows-not-applied`（仅 windows） | 已实现 |
| CAP-SEC-INJECTION-001 | 仓库文件、WebFetch 内容、MCP 返回内容诱导的破坏性命令进入审批，审批卡带完整命令；关键路径删除在跳过权限下仍询问 | ARCH-10.1、ARCH-6.2 | T45 | `sec-inject-mcp`<br>`sec-inject-repo-file`<br>`sec-inject-webfetch` | 已实现 |
| CAP-SEC-MALICIOUS-REPO-001 | 带全部种类项目级可执行配置的仓库在信任前零执行；信任后新增的可执行项在再次确认前不运行 | ARCH-10.1、ARCH-10.2 | T45 | `sec-malicious-repo-new-item`<br>`sec-malicious-repo-untrusted` | 已实现 |
| CAP-SEC-PI-PACKAGES-001 | Pi 设置（项目 `.pi/settings.json`、`<数据目录>/pi/settings.json`）的 `packages` 不由 Agent Host 安装：不运行安装脚本、不加载其扩展 | ARCH-10.1、ARCH-6.7 | T45 | `sec-pi-settings-packages` | 已实现 |
| CAP-SYS-NOTIFY-002 | 在通知中直接允许或拒绝 | FR-SY-03 | T42 | `notify-approval` | 已实现 |
| CAP-TOOL-NOTEBOOK-001 | NotebookEdit 编辑 Jupyter cell（插入、替换、删除，未改动的部分逐字节不变） | FR-TL-06、ARCH-6.1.4 | T42 | `notebook-edit-delete`<br>`notebook-edit-insert`<br>`notebook-edit-replace` | 已实现 |
| CAP-TOOL-NOTEBOOK-ERRORS-001 | NotebookEdit 的先读后改、外部修改与不存在的 cell 报错，无 id 的旧版 notebook 按序号定位 | FR-TL-06、ARCH-6.1.2 | T42 | `notebook-edit-errors` | 已实现 |
| CAP-TOOL-NOTEBOOK-PERMISSIONS-001 | NotebookEdit 受 Edit(...) 规则、受保护路径与模式约束，hooks 按规范名匹配，写入进检查点可回退 | FR-TL-06、ARCH-6.9 | T42 | `notebook-edit-permissions` | 已实现 |
| CAP-USAGE-COST-001 | 按会话、按模型统计用量与成本 | FR-MD-06 | T41 | `usage-cost-session` | 已实现 |

## M5

| ID | 能力 | 需求与架构 | 任务 | 覆盖场景 | 状态 |
|---|---|---|---|---|---|
| CAP-AGENT-FORK-001 | fork 子 agent 继承分支历史及父会话的 system 与工具前缀，审批和检查点归主会话 | FR-HN-04、ARCH-6.4、ARCH-6.15 | T48 | `subagent-fork` | 已实现 |
| CAP-CHAT-SIDE-001 | 侧边对话基于当前上下文提问，不写入主对话 | FR-CH-08 | T49 | — | 计划中 |
| CAP-CONFIG-MANAGED-001 | 企业托管配置是最高层：托管 deny 在裁决第 1 步生效，列表与其他层合并，标量覆盖其他层 | ARCH-6.14、ARCH-6.2.3 | T47 | `managed-precedence` | 已实现 |
| CAP-CONFIG-MANAGED-CHANGE-001 | 托管配置变化在下一次检查内生效，ConfigChange hook 不能阻断，运行中变坏的文件沿用上次内容 | ARCH-6.14、ARCH-6.3.2 | T47 | `managed-change` | 已实现 |
| CAP-CONFIG-MANAGED-CLAUDE-001 | 兼容读取 Claude Code 的托管文件（macOS 与 Windows 两套布局），不支持的键在配置诊断中列为已忽略 | ARCH-6.14 | T47 | `managed-claude-code-macos`<br>`managed-claude-code-windows` | 已实现 |
| CAP-CONFIG-MANAGED-HOOKS-001 | "只允许托管 hooks"：只运行托管 hooks，跳过的 hooks 写入审计 | ARCH-6.3.1 | T47 | `managed-hooks-only` | 已实现 |
| CAP-CX-COMPACT-SERVER-001 | 按模型启用 Anthropic 服务端清理或压缩，出错时退回客户端，恢复时保留服务端上下文 | FR-CX-03、ARCH-6.6.4 | T48 | `ctx-server-clear`<br>`ctx-server-compact`<br>`ctx-server-fallback`<br>`ctx-server-openai` | 已实现 |
| CAP-HOOK-ELICITATION-001 | Elicitation 可代答或阻断 MCP 请求，ElicitationResult 可修改用户的回答 | FR-HN-05、FR-EX-03、ARCH-6.3.2、ARCH-6.8 | T48 | `mcp-elicitation-hooks` | 已实现 |
| CAP-HOOK-M5-001 | WorktreeCreate、WorktreeRemove、PreModelSwitch、PostModelSwitch、Elicitation、ElicitationResult、PermissionDenied hooks | FR-HN-05、ARCH-6.3.2 | T48 | `hooks-m5-model-switch`<br>`hooks-m5-permission-denied`<br>`hooks-m5-worktree`<br>`mcp-elicitation-hooks` | 已实现 |
| CAP-HOOK-PERMISSIONDENIED-001 | Auto 审查拒绝后执行 PermissionDenied hook，并将重试提示随拒绝结果返回 | FR-HN-05、ARCH-6.3.2 | T48 | `hooks-m5-permission-denied` | 已实现 |
| CAP-HOOK-POSTMODELSWITCH-001 | PostModelSwitch 的补充上下文随下一次模型请求送达 | FR-HN-05、ARCH-6.3.2、ARCH-6.13 | T48 | `hooks-m5-model-switch` | 已实现 |
| CAP-HOOK-PREMODELSWITCH-001 | PreModelSwitch 提供模型、上下文与缓存成本，可允许、拒绝或询问 | FR-HN-05、ARCH-6.3.2、ARCH-6.13 | T48 | `hooks-m5-model-switch` | 已实现 |
| CAP-HOOK-WORKTREE-001 | WorktreeCreate 与 WorktreeRemove 接管受管理 worktree 的创建和移除，失败时保留原因 | FR-HN-05、ARCH-6.3.2、ARCH-6.12 | T48 | `hooks-m5-worktree` | 已实现 |
| CAP-MCP-ELICITATION-001 | MCP 表单与 URL 请求从所属会话接收接受、拒绝、取消结果，打开 URL 需原生确认 | FR-EX-03、ARCH-6.8 | T48 | `mcp-elicitation`<br>`mcp-elicitation-hooks` | 已实现 |
| CAP-MEM-AUTO-001 | 自动记忆：模型经 `Memory` 工具由 Core 保存笔记并审计，新会话第 4 段带索引，笔记正文读取后才进上下文，压缩后恢复 | FR-CX-05、ARCH-6.6.2 | T47 | `memory-auto-compact`<br>`memory-auto-save` | 已实现 |
| CAP-MEM-AUTO-OFF-001 | 自动记忆关闭或项目未受信任时没有 `Memory` 工具（关闭时也没有索引）；项目文件只能关闭自动记忆 | FR-CX-05、ARCH-10.2 | T47 | `memory-auto-off`<br>`memory-auto-untrusted` | 已实现 |
| CAP-PERM-AUTO-001 | 自动审查模式：可配置的审查模型代替人审批，决策可审计 | FR-PM-06、ARCH-6.0 | T46 | `perm-auto-allow` | 已实现 |
| CAP-PERM-AUTO-ALLOW-001 | 审查模型答允许、拒绝、不确定时分别执行一次、拒绝并把理由回给模型、转人工审批卡 | FR-PM-06、ARCH-6.2.3 | T46 | `perm-auto-allow`<br>`perm-auto-deny`<br>`perm-auto-unsure` | 已实现 |
| CAP-PERM-AUTO-FALLBACK-001 | 审查超时、服务商错误、输出无法解析、结论不在枚举内、审查模型不可用一律转人工，工具不执行 | FR-PM-06、ARCH-6.2.3 | T46 | `perm-auto-invalid-verdict`<br>`perm-auto-provider-error`<br>`perm-auto-timeout`<br>`perm-auto-unavailable`<br>`perm-auto-unparsable` | 已实现 |
| CAP-PERM-AUTO-INPUT-001 | 审查请求只含用户的话、调用与策略：工具结果、网页、助手正文与 memory 不进入 | FR-PM-06、ARCH-10.1 | T46 | `perm-auto-request-shape` | 已实现 |
| CAP-PERM-AUTO-ORDER-001 | deny、ask 规则与始终询问的类别先于审查，PermissionRequest hooks 在审查之前，这些情况不发审查请求 | FR-PM-06、ARCH-6.2.3 | T46 | `perm-auto-always-ask`<br>`perm-auto-ask-rule`<br>`perm-auto-deny-rule`<br>`perm-auto-hooks-first`<br>`perm-auto-unsandboxed`（仅 macos） | 已实现 |
| CAP-PERM-AUTO-PAUSE-001 | 连续拒绝达到阈值后暂停自动审查、改由人工审批，用户允许一次后恢复 | FR-PM-06、ARCH-10.1 | T46 | `perm-auto-pause` | 已实现 |
| CAP-PERM-AUTO-SCOPE-001 | Auto 模式只在用户级设置开启；项目级的开关、审查模型、策略与可信基础设施不生效并在配置诊断中标为已忽略 | FR-PM-06、ARCH-6.2.1、ARCH-10.2 | T46 | `perm-auto-project-ignored` | 已实现 |
| CAP-PERM-AUTO-SUBAGENT-001 | 子 agent 的调用按主会话的 Auto 模式送审，并行子 agent 的审查并发进行，审计标明来源 | FR-PM-06、ARCH-6.4 | T46 | `perm-auto-subagents` | 已实现 |
| CAP-SKILL-FORK-001 | 带 `context: fork` 的 skill 在指定子 agent 中执行，主会话只接收结果 | FR-EX-01、ARCH-6.7 | T48 | `skill-fork`<br>`skill-fork-background` | 已实现 |

## 由客户端测试（L4）验证的需求

| 需求 | 原因 | 任务 |
|---|---|---|
| FR-CH-05 | 三档视图只改变客户端的展示 | T29 |
| FR-CH-07 | 复制消息与选中回合是客户端交互 | T19 |
| FR-PM-05 | 审批热键、防误触、阅读闸门与输入法守卫是客户端交互规则 | T20 |
| FR-RV-04 | diff 行内评论是渲染进程的草稿，批量发送是普通的 prompt 或排队消息，由 L4 验证 | T42 |
| FR-SY-02 | 关窗后后台常驻、菜单栏与系统托盘属于 Electron 主进程 | T35 |
| FR-SY-04 | URL scheme 与从文件管理器打开属于 Electron 主进程 | T35 |
| FR-SY-05 | 快捷键与命令面板是客户端交互 | T18 |
| FR-SY-06 | 更新与发布清单校验在打包与主进程中，由发布流水线与 L4 验证 | T50 |
| FR-SY-07 | App Intents、快捷指令与跳转列表属于平台集成 | T49 |
