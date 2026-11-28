# 0039. Hooks 的落地：M2 事件集与 command 类型（补充）

- 状态：已接受，补充 ADR-0004、ADR-0005、ADR-0037
- 日期：2026-11-19
- 相关：架构第 6.2.3、6.3、6.14、7.1、7.4、9.2、10.2 节；T25

## 背景

架构第 6.3 节决定 hooks 全部在 Core 执行、配置与决策协议兼容 Claude Code，第 6.2.3 节为裁决流程留出第 2、8 步，第 7.4 节列出 AHP `hooks/run`。T25 落地 M2 的 11 个事件时，架构没有规定以下细节：Agent Host 观察到的事件怎样交给 Core；命令用哪个 shell、继承什么环境；Stop 续跑的上限和计数；`updatedInput` 怎样避免绕过 deny 规则；PermissionRequest 的 `updatedPermissions` 能写到哪里；可能运行几分钟的 PreToolUse hooks 与 Agent Host 的 30 秒传输期限怎样共存；Pi 1.5.2 的压缩事件不回读摘要指令时 PreCompact 怎样生效；用户在哪里看到 hook 的消息与错误、哪些配置不运行。

## 决策

1. **新 crate `piarc-hooks` 只做通用部分。** 配置解析与合并（各设置层高到低，同一 handler——命令、参数、shell、`if` 相同——跨文件只运行一次，`disableAllHooks` 全部关闭）、matcher（Claude Code 规则；正则用 `regex` crate，环视、反向引用等它不支持的语法报出原因，该组不运行）、执行器、决策协议与合并、长输出落盘、`Stop` 续跑上限 `STOP_CONTINUATION_LIMIT`、审计记录的形状。进程经注入的 `ProcessSpawner` 启动（Core 注入 `piarc-exec` 的 `ProcessTreeSpawner`），程序由注入的 `Launcher` 决定；crate 不依赖 `piarc-exec`、`piarc-policy`、`piarc-config`。
2. **Core 负责把它接到 PiArc。** `piarc-core::hooks::HooksService` 用与权限裁决相同的 `TrustService::permission_settings` 读取 hooks，所以未信任项目的 `.piarc/settings*.json`、`.claude/settings*.json` 中的 hooks 不运行，用户级照常运行；每个 handler 一行 `audit_events`（`kind: "hook"`：事件、层与文件、JSON Pointer、程序名与命令的 SHA-256、退出码、耗时、是否超时或被取消、判定）；`systemMessage`、`stopReason`、非阻断错误与 PreCompact 的阻断理由以 `core/notices`（`{type: "hook", id, sessionId, event, level, message}`）送给客户端。`additionalContext`、`systemMessage`、纯文本 stdout、反馈各自超过 10,000 字符时写入会话临时目录 `hooks/`，只送 2,000 字符预览与路径；PreCompact 的指令在 10,000 字符处截断并加标记。
3. **事件的挂载。** Core 自己观察 UserPromptSubmit（`session/prompt`、`steer`、`followUp` 发给 Agent Host 之前；阻断时请求以 `permissionDenied`、`details.reason: "hookBlocked"` 失败，上下文随新的可选参数 `hookContext` 送达）、PreToolUse 与 PermissionRequest（裁决第 2、8 步）、Notification（新的审批卡 `permission_prompt`，回合结束 `idle_prompt`）。其余 7 个事件由 Agent Host 在 Pi 1.5.2 的事件上经新的 AHP 方法 `hooks/run`（Agent Host → Core，能力 `hooks`）报告：`session_start`（不阻塞会话打开，首个回合开始前等待其结果）、`session_shutdown`、`tool_result`（成功与失败分开）、`agent_before_settle`、`session_before_compact`、`session_compact`（随后以 `source: "compact"` 再跑一次 SessionStart）。Core 只接受这 7 个事件，按事件白名单取 Agent Host 给的特有字段并自己填写通用字段；`cwd` 必须在该连接的工作区内，会话已在 Core 关闭（SessionEnd）时也能运行。
4. **执行方式。** shell 形式在 macOS 用 `/bin/sh -c`，Windows 用 Git Bash，没有 Git Bash 时或 `shell: "powershell"` 用 PowerShell；`args` 存在时为 exec 形式，不经 shell。环境是会话工具命令的环境（ADR-0035 准入的变量）加 `CLAUDE_PROJECT_DIR`（工作区根）；Claude Code 让 hook 继承完整的进程环境，PiArc 不这样做，免得把 Core 进程里的变量交给项目配置的命令。工作目录是会话 cwd（不存在时为工作区根）。同一事件的 handler 并行运行，stdin 写入输入 JSON 后关闭，stdout 与 stderr 并发读完（各保留前 4 MiB）。超时：默认 600 秒，UserPromptSubmit 30 秒，SessionEnd 1.5 秒（handler 的 `timeout` 至多到 60 秒，与官方一致，关闭会话不被 hook 拖住）；超时、回合中断、连接断开时先 `terminate`、2 秒后 `kill`，进程退出后丢弃句柄结束整棵进程树。时长由 `CoreConfig.hooks` 注入。
5. **决策协议。** exit 0 时 stdout 恰为一个 JSON 对象才按字段读，`hookSpecificOutput.hookEventName` 必须是本事件；以 `{` 开头 `}` 结尾却不是合法 JSON 为错误；其余是纯文本，只在 SessionStart、UserPromptSubmit（上下文）与 PreCompact（摘要指令）使用。exit 2 的走向按官方逐事件：阻断（PreToolUse、UserPromptSubmit、Stop、PreCompact）、给模型（PostToolUse、PostToolUseFailure）、给用户（SessionStart、SessionEnd、PostCompact）、忽略（PermissionRequest、Notification）；同时读 stdout 的 JSON，其中的理由优先于 stderr。其他退出码、超时、无法启动是非阻断错误，动作继续并提示用户；`onFailure: "block"` 使它们在可阻断的事件上阻断。PreToolUse 多个 handler 按 deny > ask > allow 合并（`defer` 只在 Claude Code 的 `-p` 模式有意义，按 ask 处理），理由取获胜决定的第一个；PermissionRequest deny 优先于 allow。
6. **hook 不能绕过规则。** PreToolUse 的 `updatedInput` 在第 3–7 步之前替换参数，规则看到的是改写后的调用；allow 只表示"未阻断"（ADR-0037）。PermissionRequest 的 allow 带 `updatedInput` 时，新参数重新经过裁决，命中 deny 拒绝、命中 ask 规则或必须询问的检查仍然询问用户。改写后的参数（去掉 Agent Host 内部字段）随 `policy/evaluate` 结果的新可选成员 `updatedInput` 交回 Agent Host，后者原地替换 Pi 的 `event.input`；结果另有 `context`（PreToolUse 的 `additionalContext`，随工具结果送达）与 `stop`（`continue: false`，或 PermissionRequest deny 带 `interrupt`）。
7. **`updatedPermissions` 的范围。** 支持 `addRules`（`session` 只接受 allow；`localSettings`、`projectSettings` 分别写 `.piarc/settings.local.json`、`.piarc/settings.json`，经 `edit_permission_rule`，新增的 allow 规则作为已确认项并入信任快照，与原生确认保存的规则一样）与 `setMode`（`session`，限 default、acceptEdits、plan）。`userSettings`、`replaceRules`、`removeRules`、目录类更新、bypass 与 auto 模式不执行，以提示告诉用户；永不写 `.claude/`。
8. **长时间的预检。** Core 在运行 PreToolUse 或 PermissionRequest hooks 之前向 Agent Host 发 `policy/pending`，停止该调用的 30 秒传输期限；Core 完全不回答时 Agent Host 仍按期限拒绝（T20 的行为不变）。`hooks/run` 本身不设传输期限，由 Core 的 hook 超时约束；输入大于一个 AHP 帧（8 MiB）时，Agent Host 把其中的长字符串截到 16 K 字符并注明，仍放不下就不发送并记日志。
9. **Stop 续跑。** block 或 `additionalContext` 让回合继续：Agent Host 在 `agent_before_settle` 追加一条不显示的自定义消息（`piarc.hookContext`，以 `[PiArc hook context]` 开头，Anthropic 线格式上与相邻的 user 消息合并）并要求再请求一次。连续续跑计数在模型调用工具或新的运行开始时归零；达到 `STOP_CONTINUATION_LIMIT`（8，与 Claude Code 相同）后 Core 不再返回 block 并提示用户。只在运行正常完成时触发（中断与请求失败不触发，后者是 M4 的 StopFailure）。
10. **PreCompact 的指令。** Pi 1.5.2 的 `session_before_compact` 不回读 `customInstructions`：有指令时 Agent Host 用 Pi 导出的 `compact()`、会话当前模型与流函数自己生成摘要，作为扩展结果交回 Pi。阻断时取消压缩。T27 接管 PiArc 自己的摘要提示时复核这一点。
11. **不运行的配置看得见。** 后续里程碑的事件、`http`/`prompt`/`mcp_tool`/`agent` handler、`async`/`asyncRewake` handler、非工具事件上的 `if`、正则不支持的 matcher 不运行；`once` 被忽略。它们进入配置诊断（Core 的报告新增 `hooks` 列表，设置窗口"配置诊断"页列出）。`if` 在工具事件上按一条 deny 规则的语义用 `piarc-policy` 匹配（Bash 任一子命令命中即运行，无法拆分的命令运行，规则无效时运行）。键映射表中 `hooks`、`disableAllHooks` 改为生效，`/hooks` 仍是需要信任的可执行值。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| Agent Host 在 Node 中执行 hooks | 少一次往返 | 违反 ADR-0004（任意命令在 Core 执行、受信任约束、写审计），Windows 要另写进程树终止 | 否决 |
| Core 在会话关闭时自己运行 SessionEnd | 不依赖 Agent Host | 应用退出、空闲回收时 Pi 的 `session_shutdown` 也要覆盖，两处会重复或遗漏 | 否决，统一由 Pi 事件触发，Core 接受已关闭会话的 `hooks/run` |
| `policy/evaluate` 去掉传输期限 | 简单 | Core 丢失请求时回合永远等待，T20 的故障测试失效 | 否决，改为 hooks 开始前发 `policy/pending` |
| hook 继承 Core 的完整环境（Claude Code 的做法） | 兼容性最好 | 项目 hook 会拿到 Core 进程里的全部变量；与工具命令的准入规则不一致 | 否决 |
| 不支持 `if`，或忽略后照常运行 | 实现省 | 守卫型 hook 会对所有调用生效或完全失效 | 否决，按 deny 规则语义实现 |
| SessionStart 阻塞会话打开 | 上下文一定先到 | `session/create` 的 30 秒期限会被慢 hook 打断 | 否决，首个回合前等待 |

## 后果

- 正面：Claude Code 用户的 hooks 原样生效；所有 hook 命令受同一信任、超时、进程树与审计约束；hook 改写的参数和权限更新都经过规则。
- 负面与代价：每次工具结果、回合结束、会话打开都有一次 `hooks/run` 往返（没有 hook 时 Core 只读设置即返回）；`if` 与权限规则共用匹配器，规则语法变化时两者一起变；PreCompact 带指令时绕过 Pi 默认摘要路径中的虚拟模型路由与重试回调；Agent Host 被攻破时可以用伪造的输入调用用户已配置的 hooks（只限 7 个事件和本工作区，残余风险由 M4 的进程隔离收窄）。
- 需要配套做的事：T27 复核 PreCompact 指令的传递；T32 给 Stop 的 `background_tasks` 填入后台任务；T38、T41、T48 增加事件与 handler 类型并把诊断中的对应项移除；T40 接入插件 hooks。

## 重新评估的触发条件

- Pi 的 `session_before_compact` 开始回读摘要指令，或 `tool_result`、`agent_before_settle` 的语义变化；
- Claude Code 改变 hooks 的退出码、JSON 字段、超时或去重语义；
- `hooks/run` 往返在性能基准中成为可见的延迟。
