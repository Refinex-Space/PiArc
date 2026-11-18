# 能力清单

> 由 `node scripts/plan/check-capabilities.mjs --results <L2 报告> --doc write` 根据 `tests/capabilities.yaml` 与 L2 场景结果生成，不要手工编辑。格式与规则见 `docs/engineering/testing.md` 第 13 节。

状态：**已实现** = `active` 且至少一个 L2 场景覆盖；**计划中** = `planned`；**BLOCKED** = 因外部原因暂缓；**MISSING** = `active` 却没有场景；**失败** = 覆盖它的场景没有通过。

## 汇总

| 里程碑 | 能力数 | 已实现 | 计划中 | BLOCKED |
|---|---|---|---|---|
| M1 | 61 | 57 | 4 | 0 |
| M2 | 30 | 0 | 30 | 0 |
| M3 | 21 | 0 | 21 | 0 |
| M4 | 10 | 0 | 10 | 0 |
| M5 | 7 | 0 | 7 | 0 |

## M1

| ID | 能力 | 需求与架构 | 任务 | 覆盖场景 | 状态 |
|---|---|---|---|---|---|
| CAP-CHAT-ATTACH-001 | 图片与 PDF 附件送达模型 | FR-CH-02 | T19 | `chat-composer-input` | 已实现 |
| CAP-CHAT-MENTION-001 | 输入中的 `@` 文件提及与 `/` 命令解析后送达模型 | FR-CH-02 | T19 | `chat-composer-input` | 已实现 |
| CAP-CTX-MEMORY-001 | CLAUDE.md、AGENTS.md、CLAUDE.local.md 层级，`@import` 与子目录懒加载 | FR-CX-01、ARCH-6.6.2、ARCH-6.14 | T22 | — | 计划中 |
| CAP-CTX-PROMPT-001 | 分段 system prompt（静态段与动态段分别缓存，每个请求一个消息级缓存断点） | ARCH-6.6.1、ARCH-6.15 | T22 | — | 计划中 |
| CAP-EXEC-ABORT-001 | 中断回合时正在执行的命令连同子孙进程一起终止，条目为 interrupted | FR-TL-01、ARCH-6.11、ARCH-15.2 | T17 | `exec-abort-kills-tree` | 已实现 |
| CAP-EXEC-CWD-001 | cd 在工作区内跨命令保留；越出工作区时下一条命令回到工作区根并说明原因 | FR-TL-01、ARCH-6.11 | T17 | `exec-cwd-carry-over` | 已实现 |
| CAP-EXEC-ENV-001 | 命令环境不含 Electron、Node、Pi、PiArc 的内部变量与任何凭据 | ARCH-5.4、ARCH-6.11 | T17 | `exec-env-internal-vars` | 已实现 |
| CAP-EXEC-EXITCODE-001 | grep 无匹配、diff 有差异等退出码 1 按语义判为成功，结果与条目说明含义 | FR-TL-02、ARCH-5.3 | T17 | `exec-exit-code-meaning` | 已实现 |
| CAP-EXEC-GITBASH-001 | Windows 上 Bash 经 Git Bash 执行，中文输出不乱码，/c/ 形式路径转换后做边界判断 | ARCH-6.2.2、ARCH-15.2 | T17 | `exec-windows-shells`（仅 windows） | 已实现 |
| CAP-EXEC-LOGINENV-001 | 命令环境以用户登录 shell 的环境为基础，profile 中配置的 PATH 生效 | ARCH-6.11 | T17 | `exec-env-login-path`（仅 macos） | 已实现 |
| CAP-EXEC-OUTPUT-001 | 成功输出超过 30,000 字符时落盘并给约 2,000 字符预览与路径；失败输出给头部与尾部 | FR-TL-02、ARCH-6.11、ARCH-6.15 | T17 | `exec-output-budget` | 已实现 |
| CAP-EXEC-STREAM-001 | 命令输出在结束前以条目增量到达客户端；完成的条目带 bash 卡的结构化字段 | FR-TL-02、ARCH-5.3、ARCH-6.1.3 | T17 | `exec-streaming-output` | 已实现 |
| CAP-EXEC-TIMEOUT-001 | 命令超时（默认 2 分钟、上限 10 分钟）后整棵进程树被终止，结果带已有输出与超时说明 | FR-TL-01、ARCH-6.11 | T17 | `exec-timeout-kills-tree` | 已实现 |
| CAP-EXT-PI-001 | 信任的项目 Pi 扩展被加载，其注册的工具可被模型调用 | ARCH-5.5、ARCH-10.2 | T13 | `trust-trusted-loads-project-extension` | 已实现 |
| CAP-MODEL-SWITCH-001 | 会话内切换模型与 effort，提示切换代价 | FR-MD-03、ARCH-6.13 | T21 | `provider-settings-models`<br>`turn-model-effort` | 已实现 |
| CAP-PERM-APPROVAL-001 | 结构化审批：仅本次、本会话、总是允许、拒绝并反馈 | FR-PM-02、ARCH-6.2.3 | T20 | `policy-extra-directory`<br>`policy-save-rule`<br>`policy-session-rule` | 已实现 |
| CAP-PERM-MODE-001 | 手动与自动接受编辑两种权限模式 | FR-PM-01、ARCH-6.2.1 | T20 | `policy-accept-edits`<br>`policy-accept-edits-powershell`<br>`policy-manual`<br>`policy-manual-powershell`<br>`policy-mode-restore`<br>`policy-shell-boundary`<br>`policy-untrusted` | 已实现 |
| CAP-PROVIDER-ANTHROPIC-001 | Anthropic Messages 线格式的服务商 | FR-MD-01、ARCH-6.13 | T06 | `chat-basic` | 已实现 |
| CAP-PROVIDER-CLOUD-001 | 云厂商凭证与本地模型服务商 | FR-MD-01 | T21 | `provider-settings-models` | 已实现 |
| CAP-PROVIDER-CONFIG-001 | 配置服务商与 API key；凭据只存在 Core 的保险箱并经 AHP 交给 Agent Host | FR-MD-01、ARCH-5.4 | T21 | `provider-settings-models` | 已实现 |
| CAP-PROVIDER-OPENAI-001 | OpenAI 兼容端点的服务商（流式正文、工具调用与工具结果） | FR-MD-01、ARCH-6.13 | T06 | `provider-openai-wire` | 已实现 |
| CAP-SESSION-MANAGE-001 | 新建、重命名、置顶、归档、删除会话 | FR-WS-03 | T18 | — | 计划中 |
| CAP-SESSION-MULTI-001 | 同一工作区的多个会话同时运行，各自的工作目录与请求互不串扰 | ARCH-5.2、ARCH-5.3 | T14 | `sessions-two-cwds-isolated` | 已实现 |
| CAP-SESSION-PERSIST-001 | 会话持久化，Core 重启后可恢复并带着完整历史继续 | FR-WS-03、ARCH-9 | T14 | `sessions-persist-across-restart` | 已实现 |
| CAP-SESSION-STATUS-001 | Core 计算会话状态（错误 > 等待审批 > 运行中 > 未读 > 空闲）并随会话列表快照送达 | FR-WS-02 | T20 | `policy-session-rule` | 已实现 |
| CAP-SESSION-TURN-001 | 输入开始一个回合，正文与工具调用以条目事件流式送达客户端 | FR-CH-01、ARCH-5.3 | T14 | `chat-basic` | 已实现 |
| CAP-SYS-NOTIFY-001 | 会话完成或等待审批时发出通知事件 | FR-SY-01 | T20 | `policy-session-rule` | 已实现 |
| CAP-TOOL-BASH-001 | Bash 经 Core 执行命令并返回输出 | FR-TL-01、ARCH-6.1.4 | T07 | `tools-canonical-via-core` | 已实现 |
| CAP-TOOL-BASH-002 | Bash 超时终止整个进程树，输出给出语义成败 | FR-TL-01、FR-TL-02、ARCH-6.11 | T17 | `exec-exit-code-meaning`<br>`exec-timeout-kills-tree` | 已实现 |
| CAP-TOOL-CORE-001 | 工具的文件与命令 I/O 全部经 Core 的 AHP fs/exec 方法执行 | FR-TL-01、ARCH-6.1.3 | T07 | `tools-canonical-via-core` | 已实现 |
| CAP-TOOL-DIFF-001 | 每次文件变更的 fileChange 条目带 Core 生成的 unified diff 与 hunk | FR-TL-01、ARCH-6.1.2、ARCH-7.7 | T16 | `tools-file-change-diff` | 已实现 |
| CAP-TOOL-EDIT-001 | Edit 按文本替换修改文件 | FR-TL-01、ARCH-6.1.4 | T07 | `tools-canonical-via-core` | 已实现 |
| CAP-TOOL-EDIT-002 | 编辑不变量：先读后写、外部修改检测、多处匹配拒绝、编码与换行保持 | FR-TL-01、ARCH-6.1.2 | T16 | `tools-edit-detects-external-change`<br>`tools-edit-preserves-encoding`<br>`tools-edit-requires-read`<br>`tools-edit-unique-match` | 已实现 |
| CAP-TOOL-EDIT-EXTERNAL-001 | 读取后文件被外部修改，Edit 报错并要求重新读取，文件保持外部修改后的内容 | FR-TL-01、ARCH-6.1.2 | T16 | `tools-edit-detects-external-change` | 已实现 |
| CAP-TOOL-EDIT-READFIRST-001 | 对已存在的文件 Edit 或 Write 前，本会话必须读过它，否则报错并要求先 Read，文件不变 | FR-TL-01、ARCH-6.1.2 | T16 | `tools-edit-requires-read` | 已实现 |
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
| CAP-TOOL-REREAD-001 | 文件自上次读取后未变化时 Read 返回简短存根 | ARCH-6.15 | T16 | `tools-read-repeat-stub` | 已实现 |
| CAP-TOOL-SEARCH-LIMITS-001 | Grep 与 Glob 遵守 .gitignore，Grep 跳过二进制文件，结果超过上限时截断并说明 | FR-TL-01、ARCH-6.1.3 | T16 | `tools-search-ignore-and-limits` | 已实现 |
| CAP-TOOL-WRITE-001 | Write 创建与覆盖文件 | FR-TL-01、ARCH-6.1.4 | T07 | `tools-canonical-via-core` | 已实现 |
| CAP-TOOL-WRITE-FIDELITY-001 | Edit 与 Write 保留文件的换行风格、BOM 与编码，只改目标文本，原子替换 | FR-TL-01、ARCH-6.1.2 | T16 | `tools-edit-preserves-encoding` | 已实现 |
| CAP-TOOL-WRITE-SERIAL-001 | 写同一文件的工具调用串行执行，结果按调用顺序叠加 | ARCH-6.1.2、ARCH-6.15 | T16 | `tools-write-serial` | 已实现 |
| CAP-TRUST-DIALOG-001 | 首次打开工作区时列出将启用的可执行配置并记录用户的信任决定 | FR-WS-01、ARCH-10.2 | T18 | — | 计划中 |
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
| CAP-ASK-001 | AskUserQuestion 结构化提问 | FR-HN-03、ARCH-6.5 | T26 | — | 计划中 |
| CAP-CKPT-001 | 每次写入前保存快照，形成检查点 | FR-RV-03、ARCH-6.9 | T28 | — | 计划中 |
| CAP-CKPT-REWIND-001 | 回退：恢复代码与对话、只恢复对话或只恢复代码，冲突时提示 | FR-RV-03、ARCH-6.9 | T28 | — | 计划中 |
| CAP-CONFIG-COMPAT-001 | 读取 Claude Code 的 `.claude/settings*.json`（permissions 等与 PiArc 功能对应的键） | ARCH-6.14 | T24 | — | 计划中 |
| CAP-CONFIG-DIAG-001 | 配置诊断：每个配置文件的加载状态与生效、覆盖、忽略的键（基础） | FR-EX-05、ARCH-6.14 | T24 | — | 计划中 |
| CAP-CTX-COMPACT-001 | 自动压缩与手动 `/compact`，熔断与压缩后恢复关键上下文 | FR-CX-03、ARCH-6.6.4、ARCH-6.15 | T27 | — | 计划中 |
| CAP-CTX-REMINDER-001 | 动态信息经 system reminder 送达，不破坏缓存 | ARCH-6.6.3 | T27 | — | 计划中 |
| CAP-CTX-RULES-001 | `.claude/rules` 与 `paths:` 条件加载 | FR-CX-02、ARCH-6.14 | T24 | — | 计划中 |
| CAP-CTX-USAGE-001 | 上下文用量与分类明细 | FR-CX-04、ARCH-6.6.5 | T27 | — | 计划中 |
| CAP-HOOK-COMPACT-001 | PreCompact 与 PostCompact hooks | FR-HN-05、ARCH-6.3.2 | T25 | — | 计划中 |
| CAP-HOOK-NOTIFY-001 | Notification hook | FR-HN-05、ARCH-6.3.2 | T25 | — | 计划中 |
| CAP-HOOK-PERM-001 | PermissionRequest hook | FR-HN-05、ARCH-6.3.2 | T25 | — | 计划中 |
| CAP-HOOK-POST-001 | PostToolUse 与 PostToolUseFailure hooks（可改写输出、追加上下文） | FR-HN-05、ARCH-6.3.2 | T25 | — | 计划中 |
| CAP-HOOK-PRE-001 | PreToolUse hook 参与权限裁决 | FR-HN-05、ARCH-6.3.2、ARCH-6.2.3 | T25 | — | 计划中 |
| CAP-HOOK-PROMPT-001 | UserPromptSubmit hook | FR-HN-05、ARCH-6.3.2 | T25 | — | 计划中 |
| CAP-HOOK-SESSION-001 | SessionStart 与 SessionEnd hooks | FR-HN-05、ARCH-6.3.2 | T25 | — | 计划中 |
| CAP-HOOK-STOP-001 | Stop hook（block 时续跑一轮，带防循环计数） | FR-HN-05、ARCH-6.3.2 | T25 | — | 计划中 |
| CAP-MODEL-SETTINGS-001 | 每个模型的显示名、上下文窗口、图片输入与默认 effort | FR-MD-04 | T29 | — | 计划中 |
| CAP-NEXT-001 | 回合结束时的"下一步"建议 | FR-HN-06、ARCH-6.5 | T26 | — | 计划中 |
| CAP-PERM-AUDIT-001 | 规则管理与审计记录 | FR-PM-04 | T23 | — | 计划中 |
| CAP-PERM-BASH-001 | Bash 复合命令逐个子命令判定 | FR-PM-03、ARCH-6.2.2 | T23 | — | 计划中 |
| CAP-PERM-MODE-002 | 计划与跳过权限模式（跳过权限需显式开启并二次确认） | FR-PM-01、ARCH-6.2.1 | T23 | — | 计划中 |
| CAP-PERM-RULE-001 | 兼容 Claude Code 的规则语法，按 deny → ask → allow 裁决 | FR-PM-03、ARCH-6.2.2 | T23 | — | 计划中 |
| CAP-PLAN-MODE-001 | 计划模式：写工具与非只读命令被硬拦截，提交计划，批准时选择后续模式 | FR-HN-01、ARCH-6.5、ARCH-6.15 | T26 | — | 计划中 |
| CAP-PROVIDER-OAUTH-001 | 服务商的 OAuth 与设备码登录（不含 Anthropic 订阅登录） | FR-MD-02、ARCH-5.4 | T29 | — | 计划中 |
| CAP-RV-CHANGES-001 | 会话改动按文件给出统一 diff，大 diff 降级 | FR-RV-01、ARCH-7.7 | T28 | — | 计划中 |
| CAP-RV-DISCARD-001 | 按文件或按 hunk 丢弃改动 | FR-RV-02 | T28 | — | 计划中 |
| CAP-SESSION-FORK-001 | 从某条消息分出会话分支并在分支间切换 | FR-WS-07、ARCH-6.9 | T28 | — | 计划中 |
| CAP-TODO-001 | 任务清单由模型维护，结构化送达客户端，压缩后保留 | FR-HN-02、ARCH-6.5 | T26 | — | 计划中 |
| CAP-TOOL-WEBFETCH-001 | WebFetch 本地抓取转 Markdown，辅助模型按提示提取，受域名规则约束 | FR-TL-03、ARCH-6.1.4 | T29 | — | 计划中 |

## M3

| ID | 能力 | 需求与架构 | 任务 | 覆盖场景 | 状态 |
|---|---|---|---|---|---|
| CAP-AGENT-DEF-001 | 读取 `.claude/agents` 与 `.piarc/agents` 的子 agent 定义，内置 general-purpose、Explore、Plan | FR-HN-04、ARCH-6.4 | T31 | — | 计划中 |
| CAP-AGENT-RUN-001 | 子 agent 使用任意服务商模型、可后台运行、最多 3 层、默认不继承父会话历史 | FR-HN-04、ARCH-6.4、ARCH-6.15 | T31 | — | 计划中 |
| CAP-BG-COMMAND-001 | 后台命令、超时转后台与 KillShell | FR-TL-04、ARCH-6.11 | T32 | — | 计划中 |
| CAP-BG-MONITOR-001 | Monitor 监视后台任务输出并唤醒会话 | FR-TL-04、ARCH-6.11 | T32 | — | 计划中 |
| CAP-CMD-001 | 自定义斜杠命令（`.claude/commands`、Pi prompt templates） | FR-EX-02、ARCH-6.7 | T37 | — | 计划中 |
| CAP-HOOK-HANDLER-001 | http 与 prompt 类型的 hook handler | FR-HN-05、ARCH-6.3.2 | T38 | — | 计划中 |
| CAP-HOOK-SUBAGENT-001 | SubagentStart、SubagentStop 与 PostToolBatch hooks | FR-HN-05、ARCH-6.3.2 | T38 | — | 计划中 |
| CAP-MCP-DEFER-001 | 工具多时延迟加载（ToolSearch） | FR-EX-03、ARCH-6.1.4、ARCH-6.8 | T36 | — | 计划中 |
| CAP-MCP-OAUTH-001 | MCP 的 OAuth | FR-EX-03、ARCH-6.8 | T36 | — | 计划中 |
| CAP-MCP-POOL-001 | MCP 工作区共享连接池 | FR-EX-03、ARCH-6.8 | T36 | — | 计划中 |
| CAP-MCP-TRANSPORT-001 | MCP 的 stdio 与 Streamable HTTP 传输 | FR-EX-03、ARCH-6.8 | T36 | — | 计划中 |
| CAP-MODEL-ALIAS-001 | 模型别名表供子 agent 与 skills 引用 | FR-MD-05 | T31 | — | 计划中 |
| CAP-MODEL-DEGRADE-001 | 按模型能力降级（例如不支持图片输入时的处理） | ARCH-6.13 | T31 | — | 计划中 |
| CAP-SESSION-PARALLEL-001 | 跨工作区与多窗口的会话并行运行 | FR-WS-05 | T35 | — | 计划中 |
| CAP-SESSION-SEARCH-001 | 会话全文搜索 | FR-WS-04、ARCH-9.2 | T35 | — | 计划中 |
| CAP-SKILL-001 | Skills（Agent Skills 标准；`.claude/skills`、`.piarc/skills`、用户级），渐进加载 | FR-EX-01、ARCH-6.7 | T37 | — | 计划中 |
| CAP-STYLE-001 | 输出风格切换与自定义 | FR-HN-07、ARCH-6.7 | T37 | — | 计划中 |
| CAP-TERM-SCREEN-001 | 集成终端与会话共享目录和环境，agent 可读取后台终端的屏幕内容 | FR-TL-05、ARCH-6.11 | T33 | — | 计划中 |
| CAP-TOOL-WEBSEARCH-001 | WebSearch 可配置后端 | FR-TL-03、ARCH-6.1.4 | T38 | — | 计划中 |
| CAP-WT-AGENT-001 | 子 agent 可在独立 worktree 中隔离运行 | ARCH-6.12 | T35 | — | 计划中 |
| CAP-WT-SESSION-001 | 新建会话可选在独立 git worktree 中运行，归档时处理未提交改动 | FR-WS-06、ARCH-6.12 | T35 | — | 计划中 |

## M4

| ID | 能力 | 需求与架构 | 任务 | 覆盖场景 | 状态 |
|---|---|---|---|---|---|
| CAP-CONFIG-DIAG-002 | 配置诊断完善（全部配置来源） | FR-EX-05 | T41 | — | 计划中 |
| CAP-HOOK-M4-001 | UserPromptExpansion、InstructionsLoaded、CwdChanged、FileChanged、ConfigChange、StopFailure hooks 与 mcp_tool handler | FR-HN-05、ARCH-6.3.2 | T41 | — | 计划中 |
| CAP-MCP-PROMPTS-001 | MCP prompts | ARCH-6.8 | T40 | — | 计划中 |
| CAP-PLUGIN-001 | 插件：Claude Code 插件目录与 Pi 包，启用前展示来源与能力 | FR-EX-04、ARCH-6.7、ARCH-6.14 | T40 | — | 计划中 |
| CAP-RV-COMMENT-001 | diff 行内评论批量发送给 agent | FR-RV-04 | T42 | — | 计划中 |
| CAP-SANDBOX-MACOS-001 | macOS 上 Bash 在 Seatbelt 中执行，文件写入与网络按白名单放行 | FR-TL-07、ARCH-6.10 | T39 | — | 计划中 |
| CAP-SANDBOX-WINDOWS-001 | Windows 上命令的隔离方案（第一版只做进程树管理，见需求 D7） | FR-TL-07、ARCH-6.10 | T39 | — | 计划中 |
| CAP-SYS-NOTIFY-002 | 在通知中直接允许或拒绝 | FR-SY-03 | T42 | — | 计划中 |
| CAP-TOOL-NOTEBOOK-001 | NotebookEdit 编辑 Jupyter cell | FR-TL-06、ARCH-6.1.4 | T42 | — | 计划中 |
| CAP-USAGE-COST-001 | 按会话、按模型统计用量与成本 | FR-MD-06 | T41 | — | 计划中 |

## M5

| ID | 能力 | 需求与架构 | 任务 | 覆盖场景 | 状态 |
|---|---|---|---|---|---|
| CAP-AGENT-FORK-001 | fork 模式子 agent 继承父会话历史并共享缓存 | ARCH-6.15 | T48 | — | 计划中 |
| CAP-CHAT-SIDE-001 | 侧边对话基于当前上下文提问，不写入主对话 | FR-CH-08 | T49 | — | 计划中 |
| CAP-CONFIG-MANAGED-001 | 企业托管配置（兼容读取 Claude Code 的托管文件） | ARCH-6.14 | T47 | — | 计划中 |
| CAP-HOOK-M5-001 | WorktreeCreate、WorktreeRemove、PreModelSwitch、PostModelSwitch、Elicitation、ElicitationResult、PermissionDenied hooks | FR-HN-05、ARCH-6.3.2 | T48 | — | 计划中 |
| CAP-MEM-AUTO-001 | 自动记忆（跨会话笔记） | FR-CX-05 | T47 | — | 计划中 |
| CAP-PERM-AUTO-001 | 自动审查模式：可配置的审查模型代替人审批，决策可审计 | FR-PM-06、ARCH-6.0 | T46 | — | 计划中 |
| CAP-SKILL-FORK-001 | skill 的 `context: fork` | ARCH-6.14 | T48 | — | 计划中 |

## 由客户端测试（L4）验证的需求

| 需求 | 原因 | 任务 |
|---|---|---|
| FR-CH-05 | 三档视图只改变客户端的展示 | T29 |
| FR-CH-07 | 复制消息与选中回合是客户端交互 | T19 |
| FR-PM-05 | 审批热键、防误触、阅读闸门与输入法守卫是客户端交互规则 | T20 |
| FR-SY-02 | 关窗后后台常驻、菜单栏与系统托盘属于 Electron 主进程 | T35 |
| FR-SY-04 | URL scheme 与从文件管理器打开属于 Electron 主进程 | T35 |
| FR-SY-05 | 快捷键与命令面板是客户端交互 | T18 |
| FR-SY-06 | 更新与发布清单校验在打包与主进程中，由发布流水线与 L4 验证 | T50 |
| FR-SY-07 | App Intents、快捷指令与跳转列表属于平台集成 | T49 |
