# 架构决策记录（ADR）

ADR 记录 PiArc 中影响全局、难以回退的决策：选了什么、为什么、放弃了哪些方案、什么情况下需要重新评估。

[架构设计文档](../architecture/ARCHITECTURE.md)描述系统"是什么"，ADR 解释"为什么这样"。两者冲突时以已接受的 ADR 为准，并立即修正架构文档。

## 规则

1. 改变下表任何一条决策，都要新写一份 ADR 来取代旧的。旧 ADR 状态改为"已取代"，并链接到新 ADR。不要直接改写已接受 ADR 的决策内容。
2. 新 ADR 编号顺延，文件名 `NNNN-短标题.md`。模板见 [0000-template.md](0000-template.md)。
3. 每份 ADR 必须写"重新评估的触发条件"。触发条件出现时，在对应里程碑的评审中复核。
4. 状态取值：`提议` / `已接受` / `已取代` / `已废弃`。
5. 新 ADR 只改动旧 ADR 中的个别条款时，在新 ADR 头部写"修订：ADR-XXXX 第 N 条"；旧 ADR 保持"已接受"，并在状态后注明哪一条被哪份 ADR 修订。

## 索引

| 编号 | 标题 | 状态 |
|---|---|---|
| [0001](0001-three-tier-native-architecture.md) | 原生客户端 + Rust 核心 + Pi Agent Host 三层架构 | 已取代 → 0013 |
| [0002](0002-pi-integration-via-sdk-host.md) | 基于 Pi SDK 自研 Agent Host，不 fork Pi、不以官方 RPC 为主协议 | 已接受 |
| [0003](0003-embedded-node-runtime.md) | Agent Host 运行时使用内置 Node LTS | 已取代 → 0015 |
| [0004](0004-harness-control-plane-in-core.md) | Harness 分工：策略在 Core 裁决，Agent 循环在 Pi，工具 I/O 下沉 Core | 已接受 |
| [0005](0005-claude-code-config-compatibility.md) | 兼容 Claude Code 配置生态，PiArc 自有配置独立 | 已接受 |
| [0006](0006-compliance-and-clean-room.md) | 合规红线：禁用 Claude 订阅登录、clean-room、自有品牌 | 已接受 |
| [0007](0007-macos-ui-swiftui-appkit.md) | macOS 客户端：SwiftUI 外壳 + AppKit/TextKit 2 承载高性能视图 | 已取代 → 0013 |
| [0008](0008-ffi-uniffi.md) | Swift ⇄ Rust 绑定使用 UniFFI | 已取代 → 0014 |
| [0009](0009-agent-host-protocol.md) | Core ⇄ Agent Host 使用自有版本化协议 AHP | 已接受 |
| [0010](0010-process-model.md) | 进程模型：每个工作区一个 Agent Host，子 agent 在进程内 | 已接受 |
| [0011](0011-session-storage.md) | 会话以 Pi JSONL 为事实来源，Core 维护 SQLite 索引与文件快照 | 已接受 |
| [0012](0012-distribution-developer-id.md) | 分发走 Developer ID + 公证 + Sparkle，不上 Mac App Store | 已取代 → 0016 |
| [0013](0013-electron-desktop-client.md) | 桌面客户端改用 Electron + React，macOS 与 Windows 同一代码库推进 | 已接受 |
| [0014](0014-core-binding-napi-rs.md) | Rust Core 以 NAPI-RS 原生模块加载在 Electron 主进程 | 已接受（第 4 条被 0019 修订） |
| [0015](0015-agent-host-runtime-bundled-node.md) | Agent Host 继续使用单独内置的 Node LTS，不复用 Electron 自带的 Node | 已接受（第 5 条被 0018 修订） |
| [0016](0016-packaging-signing-updates.md) | 打包、签名与更新：Electron Forge；macOS Developer ID + 公证 + 内置更新；Windows 签名安装包；不上应用商店 | 已取代 → 0018 |
| [0017](0017-terminal-libghostty-vt.md) | 内置终端：终端状态由 Core 中的 libghostty-vt 持有，渲染层可替换 | 已接受（第 3 条被 0023 修订） |
| [0018](0018-unsigned-distribution.md) | 不做平台代码签名：macOS 只做 ad-hoc 签名，Windows 不签名，更新与凭据存储随之调整 | 已接受 |
| [0019](0019-event-batches-copied-not-transferred.md) | 事件批次经主进程转发时复制，不转移 ArrayBuffer（修订 ADR-0014 第 4 条） | 已接受 |
| [0020](0020-tool-layer-composition.md) | 工具层的组成：Pi 的工具代码加 Core 的 I/O（补充 ADR-0004 第 3 条） | 已接受（第 1 条 bash 的部分被 0028 修订） |
| [0021](0021-credential-vault-and-pi-adapter.md) | 凭据保险箱的格式、并发与 Pi 凭据接口适配（补充 ADR-0018 第 5 条） | 已接受 |
| [0022](0022-transcript-rendering-libraries.md) | Transcript 渲染的库选型：@tanstack/react-virtual、marked 词法器、shiki JavaScript 引擎（补充 ADR-0013 第 5 条） | 已接受 |
| [0023](0023-terminal-frames-as-pull-replies.md) | 终端帧作为拉取请求的返回值送达渲染进程，不经事件 MessagePort（修订 ADR-0017 第 3 条） | 已接受 |
| [0024](0024-release-manifest-format.md) | 发布清单的格式、签名与校验位置（补充 ADR-0018 第 4 条） | 已接受 |
| [0025](0025-core-state-and-project-trust.md) | Core 状态的落地：数据目录、SQLite 迁移、按主 checkout 的信任与 Pi 信任接管（补充 ADR-0011、ADR-0005 第 4 条） | 已接受 |
| [0026](0026-turns-queue-and-interrupted-transcript.md) | 回合、排队与中断后的对话形态（补充 ADR-0009、ADR-0010、ADR-0011） | 已接受 |
| [0027](0027-file-tool-invariants.md) | 文件工具不变量的落点：Core 的状态表与写入，Harness Kit 的匹配与结果预算（补充 ADR-0004 第 3 条、ADR-0020） | 已接受 |
| [0028](0028-shell-command-execution.md) | Shell 命令的执行：Core 管进程、输出与语义，Bash 与 PowerShell 为 PiArc 自写工具（补充 ADR-0004 第 3 条，修订 ADR-0020 第 1 条） | 已接受 |
| [0029](0029-client-shell-foundations.md) | 客户端外壳的基础设施：令牌管线、偏好存储、快捷键、本地化、信任闸门与会话元数据（补充 ADR-0013、ADR-0025） | 已接受（第 7 条归档清理由 0030 修订；备选方案"信任决定的原生确认"的结论由 0064 修订） |
| [0030](0030-transcript-and-composer.md) | 会话输入、附件和 transcript 的呈现（补充 ADR-0009、ADR-0013、ADR-0026，修订 ADR-0029 第 7 条） | 已接受 |
| [0031](0031-basic-permissions.md) | M1 权限预检、审批账本与项目信任 | 已接受 |
| [0032](0032-provider-settings-and-model-selection.md) | 服务商设置、凭据更新与会话选型（补充 ADR-0006、0021、0026） | 已接受 |
| [0033](0033-session-prompt-and-memory.md) | 会话提示词快照与外部 memory 导入 | 已接受 |
| [0034](0034-bind-read-and-trust-confirmation.md) | 读取完成后登记、按已展示版本确认项目信任 | 已接受 |
| [0035](0035-command-environment.md) | 工具命令可继承的环境 | 已接受 |
| [0036](0036-bind-file-operations-to-directory-handles.md) | 文件访问与获准目录身份绑定 | 已接受 |
| [0037](0037-permission-rules-and-bash-analysis.md) | 权限规则、Bash 命令分析与模式的落地（补充 ADR-0004、0005、0031） | 已接受（阶梯第 6、7 步被 0047 修订） |
| [0038](0038-claude-code-config-compat.md) | Claude Code 配置兼容层与配置诊断的落地（补充 ADR-0005、0033） | 已接受 |
| [0039](0039-hooks-m2.md) | Hooks 的落地：M2 事件集与 command 类型（补充 ADR-0004、0005、0037） | 已接受 |
| [0040](0040-windows-automatic-permission-budget.md) | Windows 上无需用户参与的权限裁决预算 | 已接受 |
| [0041](0041-windows-ahp-round-trip-budget.md) | Windows 上小文件 fs 操作的 AHP 往返预算 | 已接受 |
| [0042](0042-plan-todo-ask-next-steps.md) | 计划模式、任务清单、提问与下一步的宿主工具（补充 ADR-0009、0031、0033、0037） | 已接受 |
| [0043](0043-reminders-compaction-usage.md) | System reminder 通道、压缩与上下文用量（补充 ADR-0009、0027、0033、0038、0039、0042） | 已接受 |
| [0044](0044-checkpoints-rewind-changes.md) | 检查点、回退、Changes 面板与会话分支的落地（补充 ADR-0009、0011、0026、0027、0030） | 已接受（第 8 条被 0084 取代） |
| [0045](0045-webfetch-sign-in-model-settings.md) | WebFetch、服务商登录、每模型设置与辅助模型的落地（补充 ADR-0004、0006、0021、0032） | 已接受 |
| [0046](0046-l3-behavior-alignment.md) | L3 行为对齐基座的落地（补充 ADR-0005、0006、0039） | 已接受 |
| [0047](0047-outside-paths-before-wildcard-command-rules.md) | 越界路径的询问先于带通配的命令 allow 规则（修订 ADR-0037 阶梯第 6、7 步的顺序） | 已接受 |
| [0048](0048-subagents-and-model-aliases.md) | 子 agent 与模型别名的落地（补充 ADR-0005、0009、0010、0037、0039、0043、0044） | 已接受 |
| [0049](0049-background-tasks-and-monitor.md) | 后台任务、Monitor 与 KillShell 的落地（补充 ADR-0009、0028、0037、0039、0043、0048） | 已接受 |
| [0050](0050-agent-terminal-screen-access.md) | agent 使用终端屏幕的接口：终端承载的任务、`Bash` 的 `terminal` 参数、屏幕文件与共享（补充 ADR-0017、0049） | 已接受 |
| [0051](0051-terminal-panel-and-renderer.md) | 终端面板与渲染器：会话终端归会话、近期真实输入防线与上限、停拉唤醒、选区与滚动在 Core、默认颜色取令牌（补充 ADR-0017、0023、0050） | 已接受 |
| [0052](0052-worktrees-search-windows-and-background.md) | Worktree、全文搜索、多窗口与后台常驻的落地：worktree 位置与命名、文件根与设置来源分开、子 agent 的 worktree 在 `subagent/start` 创建、trigram 全文搜索、`core/activity` 托盘计数、链接只做定位、Windows 注册随 Velopack（补充 ADR-0010、0018、0025、0048） | 已接受 |
| [0053](0053-mcp-extension-and-connection-pool.md) | MCP 扩展与工作区连接池的落地：替换 Pi 的 MCP 扩展、Core 合并配置与 `${VAR}` 展开、租约与空闲断开、roots 按工作区、自写 stdio 传输不脱离进程组、server 环境取命令环境、`ToolSearch` 复用 Pi 的 `tool_search`、OAuth 状态进保险箱、`mcp/statusChanged` 工作区级通知（补充 ADR-0005、0010、0021、0025、0035、0048） | 已接受 |
| [0054](0054-skills-commands-and-output-styles.md) | Skills、斜杠命令与输出风格的落地：Core 发现与解析（项目优先于用户，`.piarc` > `.claude` > Pi）、Pi 的加载关掉、第 3 段输出风格与第 5 段索引、`Skill` 经 `skills/invoke`、Core 在 UserPromptSubmit 之前展开 `/名称`、`allowed-tools` 为回合级 allow 来源、skill hooks 到会话结束、`$1` 起的位置参数（补充 ADR-0005、0025、0029、0033、0037、0039、0043、0048） | 已接受 |
| [0055](0055-websearch-and-hooks-m3.md) | WebSearch 与 M3 hooks 的落地：原生搜索经辅助模型通道在闸门之后单独请求、第三方后端（Brave）经 Core 的 `web/search` 且 key 在保险箱 `websearch/<后端>`（Agent Host 不可读写）、无后端不提供工具、来源链接先确认；`http` 与 `prompt` handler 共用 `piarc_hooks::Runner`、URL 与环境变量白名单、`prompt` 经 `hooks/prompt` 判定；SubagentStart、SubagentStop、PostToolBatch 的挂载与子 agent 的 `agent_id`、`agent_type`；`prompt_id`、`effort`；项目 hook 的权限更新不越过信任 | 已接受 |
| [0056](0056-macos-sandbox-and-agent-host-profile.md) | macOS Bash 沙箱正式版与 Agent Host 配置定稿：沙箱随调用的授权走、配置按命令生成、`sandbox.*` 键与项目只能收紧、自动批准在第 7 步、沙箱外重试任何模式都问且只有仅本次与拒绝、白名单外域名的网络卡、拒绝的识别与审计、不可用时降级并提示、代理加固、Agent Host 只写工作区与数据目录里它自己的位置（补充 ADR-0004、0005、0015、0028、0031、0037） | 已接受 |
| [0057](0057-windows-command-isolation.md) | Windows 上命令与 Agent Host 的隔离方案：到 Beta 维持权限规则 + Job Object 与明确提示，MXC ProcessContainer 列为 Beta 之后的候选（先验证遥测、先用于 Agent Host、Git Bash 修复后再给命令） | 已接受 |
| [0058](0058-plugins-pi-packages-and-mcp-prompts.md) | 插件与 Pi 包：安装记录在 `core.sqlite`、作用域在设置的 `plugins` 键、npm 经内置 npm 且 `--ignore-scripts`、git 锁定提交、可执行项逐项确认（主进程原生确认框）、Pi 扩展经 AHP 交给 Agent Host；MCP prompts 作为 `mcp__<server>__<prompt>` 斜杠命令 | 已接受（补充） |
| [0059](0059-m4-hooks-config-diagnostics-and-usage-cost.md) | M4 hooks 的挂载点与 `watchPaths`、ConfigChange 阻断保留旧值、`mcp_tool` 经 AHP `hooks/mcpTool`；配置诊断按来源类别复用 T24 的报告；用量按请求从 JSONL 派生、目录价或用户价以整数计算，没有价格为"未知" | 已接受（补充） |
| [0060](0060-notebook-edit-actionable-notifications-and-diff-comments.md) | NotebookEdit 只改一个 cell 的字节区间（Rust 与 TS 两份实现共用向量，新 cell 的 id 由调用 id 派生）；通知只放行短命令与小改动，按钮经同一审批账本（`via: notification`，审计来源"通知"）；diff 行内评论是渲染进程草稿，按摘录重新定位，Mod+Enter 一次发送（运行中排队） | 已接受（补充） |
| [0061](0061-accessibility-and-localization.md) | 无障碍与本地化：状态清单与 axe 亮暗零违规（覆盖检查）、transcript 改为 feed 加行名称、5 秒节流的 live region、审批卡取焦点（合成后、400 ms 防误触）、侧栏 90% 叠层与高对比度代码主题、强制颜色用系统按钮色、i18n 检查进 verify 第 16 步、数字日期按应用语言 | 已接受（补充） |
| [0062](0062-security-hardening-threat-map-redaction-and-diagnostics.md) | 安全收口：威胁映射进 verify（测试 ID 对照源文件、待补项随任务完成而失败）、日志写入时脱敏（保险箱的值与常见密钥格式）、诊断包先预览后经原生保存对话框写出、发布构建拒绝远程调试开关并去掉测试页、Pi 自己设置里的包清单不生效、依赖审计流水线与例外清单、审批卡与 diff 显示双向控制字符 | 已接受（补充） |
| [0063](0063-app-memory-physical-footprint.md) | "应用全部进程合计"按物理占用（macOS `phys_footprint`、Windows 私有工作集）测量，预算数值不变，RSS 合计只作参考（修订第 11 章一行的口径，放宽） | 已接受 |
| [0064](0064-trust-decision-native-confirmation.md) | "信任"项目的决定经主进程原生确认，列出将生效的可执行项；暂不信任与撤销不需要（修订 ADR-0029 的备选方案结论） | 已接受（实现登记 I223） |
| [0065](0065-managed-http-hook-allowlists.md) | HTTP hook 的 URL 和请求头变量白名单按键取最高托管来源的整份值，支持空名单。未托管的键继续跨层合并。 | 已接受（修订 ADR-0055 第 8 条） |
| [0066](0066-fork-tool-declarations.md) | fork 继承父会话的工具声明，调用仍受子会话权限及深度限制（修订 ADR-0048 第 4 条） | 已接受 |
| [0067](0067-fork-skill-index-and-grants.md) | 隔离 skill 的索引只用显式描述或名称；授权与 hooks 只交给实际执行的子会话（修订 ADR-0054） | 已接受 |
| [0068](0068-worktree-hook-ownership.md) | hook 创建目录的文件边界、归属登记与非 Git 清理（修订 ADR-0052） | 已接受 |
| [0069](0069-external-session-drafts.md) | 外部快捷操作打开可编辑草稿，用户手动发送（修订 ADR-0052 第 10 条） | 已接受 |
| [0070](0070-in-memory-side-conversations.md) | 独立的内存侧边对话、工具拒绝和无转录来源的用量 | 已接受（补充） |
| [0071](0071-local-esm-chunks.md) | Agent Host 按本地 ESM 分块构建与校验 | 已接受，修订架构第 5.6 节 |
| [0072](0072-macos-local-asset-responses.md) | macOS 通过原生缓冲区交付本地应用资源 | 已接受，升级 Electron 时重新评估 |
| [0073](0073-settings-segmented-control-reference.md) | 桌面前端长期对标 Claude Desktop 的视觉与交互，首项为设置分段控件；PiArc 自有内核与 Harness | 已接受 |
| [0074](0074-workbench-settings.md) | 设置在发起操作的工作台内打开，采用模态面板 | 已接受 |
| [0075](0075-session-tool-tiles.md) | 会话工具右侧分块、比例与窗口生命周期 | 已接受 |
| [0076](0076-project-files.md) | 工作树文件浏览、冲突安全的编辑和独立本地文档预览 | 已接受 |
| [0077](0077-markdown-file-authoring.md) | Markdown 的即时编辑、源码、对照阅读及本地图片目录 | 已接受（补充） |
| [0078](0078-session-pane-reference.md) | 会话主块对标 Claude Desktop 的 Code 会话：参考值取法、会话令牌、Lucide 图标出口与 PiArc 自有 working 标记 | 已接受（补充） |
| [0080](0080-transcript-media-times-and-command-chips.md) | 对话里的 Mermaid、图片、消息时间与输入框的命令芯片 | 已接受（补充） |
| [0081](0081-session-status-marks.md) | 会话状态徽标对齐参考，仍按形状区分 | 已接受 |
| [0082](0082-agent-host-proxy.md) | Agent Host 的网络代理 | 已接受 |
| [0083](0083-provider-accounts-and-checks.md) | 服务商的账号、连接测试、启停与模型发现 | 已接受 |
| [0084](0084-git-panel-scopes.md) | Git 面板的数据来源与范围：全部改动 / 未提交 / 单个提交 / 本会话，回滚只在未提交范围（取代 0044 第 8 条） | 已接受 |
| [0085](0085-git-command-boundaries.md) | Git 命令的执行边界：只读模式命令行覆盖可执行键、写操作只在受信任项目、用户模式环境、参数约束、串行与忙碌、危险操作原生确认、回滚快照、输出脱敏、gh 约束 | 已接受（补充） |
| [0086](0086-commit-message-generation.md) | 提交信息生成：会话级 `session/commitMessage`、Core 组装与扣下敏感文件、语言跟随界面、只填入输入框 | 已接受（补充） |
| [0087](0087-pr-description-and-review.md) | PR 描述与 AI 审查的生成：会话级 `session/gitAssist`（任务 `prDescription`、`review`）、扣下与脱敏同 0086、审查发现由 Core 校验、只呈现不执行 | 已接受（补充） |
| [0088](0088-browser-guests-in-the-security-baseline.md) | 浏览器 guest 进入安全基线：独立分区、按分区识别并走 guest 守卫、不计入真实输入、浏览器出网经 Core 代理做地址检查、THR-13 措辞限定应用窗口 | 已接受 |
| [0089](0089-agent-browser-execution-boundary.md) | 智能体浏览器的执行边界：`Browser` 工具与 `browser/run`、Core 的 `BrowserClient`、沙箱脚本宿主、请求闸门与端口策略、站点卡复用网络卡、CDP 允许名单、文件经 Core | 已接受 |
| [0090](0090-chrome-cookie-import.md) | 从 Chrome 按站点导入登录；浏览器分区 cookie 是保险箱外的凭据（ADR-0021 例外），导入站点每会话审批 | 已接受 |
| [0091](0091-browser-sdk-from-ego-browser.md) | 浏览器 SDK 移植 ego-browser（MIT，上游 `56589ea8`）：保留布局、换绑定、删子系统、严格类型不加豁免 | 已接受（补充） |
| [0092](0092-launch-configs-and-dev-servers.md) | 启动配置（`.piarc/launch.json`、`.claude/launch.json` 只读）、`TaskKind::DevServer`、进程树端口发现、`autoVerify` | 已接受（补充） |
| [0093](0093-tool-result-images-in-transcript.md) | 工具结果图片写入会话 blob 并在 transcript 显示（关闭 I234） | 已接受（补充） |
| [0094](0094-speech-engine-and-base-model.md) | 语音输入的识别引擎、基础模型与运行时按需加载：sherpa-onnx 2.0.1 经自有 `piarc-sherpa-sys` 转发到首次使用时加载的动态库，基础模型换为 X-ASR-zh-en 480 ms INT8，主进程内运行与改为隔离的条件 | 已接受 |
| [0095](0095-bundled-speech-asset-budget.md) | 内置语音资产单列预算：第 11 章非语音预算不变，语音资产安装后 ≤ 230 MB、安装包增量 ≤ 190 MB | 已接受 |
| [0096](0096-microphone-access-in-the-security-baseline.md) | 麦克风进入安全基线：usage description 与只给主程序的 audio-input entitlement（改 THR-14）、真实输入与按窗口路由、Seatbelt 拒绝 Agent Host 与沙箱命令录音、子进程继承授权的剩余风险（THR-18） | 已接受 |
| [0097](0097-speech-model-downloads.md) | 增强语音模型的下载：`piarc_web::download`（HTTPS、逐跳白名单、代理 CONNECT、上限、续传、取消、边下边哈希），按文件从 ModelScope 锁定 revision 下载、不解包，加载前校验（THR-19） | 已接受（补充） |
| [0079](0079-turn-work-grouping.md) | 回合过程的合并与收起：思考并入工具组、运行中展开、之后收起，思考默认折叠 | 已接受（取代 0078 第 6 条一项） |
