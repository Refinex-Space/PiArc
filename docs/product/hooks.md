# Hooks 使用说明（M2）

PiArc 读取 Claude Code 格式的 hooks：`~/.claude/settings.json`、`.claude/settings.json`、`.claude/settings.local.json`，以及 PiArc 自己的用户设置、`.piarc/settings.json`、`.piarc/settings.local.json`。写法与 Claude Code 相同（事件 → matcher 组 → handler），本页只列 PiArc 的支持范围和与 Claude Code 不同的地方。设计依据见架构第 6.3 节与 ADR-0039。

## 支持的范围

- 事件：SessionStart、SessionEnd、UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、PostToolUseFailure、Stop、PreCompact、PostCompact、Notification。
- handler 类型：`command`。
- 字段：`type`、`command`、`args`（exec 形式，不经 shell）、`shell`、`timeout`、`if`（工具事件）、`onFailure`、`statusMessage`（读取但不显示）。
- 项目文件（`.claude/`、`.piarc/`）里的 hooks 在信任项目之后才运行；用户级的 hooks 照常运行。`disableAllHooks: true` 关闭全部 hooks。
- 同一个 handler 写在多个文件里时只运行一次。

以下配置不运行，并在设置窗口"配置诊断"页的"PiArc 不运行的 hooks"中列出原因：

- 其他事件（SubagentStart、SubagentStop、PostToolBatch 等，诊断里写明由哪个后续版本支持）；
- `http`、`prompt`、`mcp_tool`、`agent` 类型；
- `async: true` 或 `asyncRewake: true` 的 handler（整条不运行，不会在前台同步执行）；
- 用了环视（`(?=`、`(?!`、`(?<=`、`(?<!`）或反向引用的 matcher：PiArc 的正则不支持这些写法；
- 写在非工具事件上的 `if`。`once` 只对 skill 生效，在设置文件里被忽略。

## 与 Claude Code 的差异

| 项 | PiArc 的行为 |
|---|---|
| `transcript_path` | 指向 Pi 的会话文件（JSONL），格式与 Claude Code 的转录不同；需要对话内容时优先用事件自带的字段（如 Stop 的 `last_assistant_message`、PostCompact 的 `compact_summary`） |
| `tool_input` | 使用 PiArc 工具的参数名，例如文件工具是 `path`（绝对路径）而不是 `file_path`，Edit 是 `edits` 列表 |
| `tool_response` | `{ "content": [...] }`：工具结果的内容块，图片只给 `mimeType` |
| PreToolUse 的 `defer` | 只在 Claude Code 的 `-p` 模式有意义，PiArc 按 `ask` 处理 |
| `updatedPermissions` | 支持 `addRules`（`session`、`localSettings` 写 `.piarc/settings.local.json`、`projectSettings` 写 `.piarc/settings.json`）与 `setMode`（`session`，限 default、acceptEdits、plan）；其余类型、`userSettings` 和 bypass、auto 模式不执行并提示。PiArc 不写 `.claude/` |
| 命令的 shell | macOS 用 `/bin/sh -c`；Windows 用 Git Bash，没有 Git Bash 时用 PowerShell；`shell: "powershell"` 指定 PowerShell；有 `args` 时直接运行 `command`（Windows 上要是真正的可执行文件，不能是 `.cmd`） |
| 环境变量 | 与会话里的工具命令相同（登录 shell 中准入的系统、locale、工具链变量），另加 `CLAUDE_PROJECT_DIR`（工作区根）；不继承 PiArc 进程的其他变量，需要的变量请在命令里自行设置 |
| 超时 | 默认 600 秒，UserPromptSubmit 30 秒，SessionEnd 1.5 秒（自设 `timeout` 最多 60 秒）；超时或回合被中断时结束整棵进程树 |
| Stop | block 或 `additionalContext` 让回合继续，同一回合连续至多 8 次（模型调用工具后重新计数），之后回合结束并提示 |
| Notification | `permission_prompt` 在审批卡出现时、`idle_prompt` 在回合结束时立即触发（Claude Code 等空闲 60 秒） |
| SessionStart | 会话创建、恢复、分叉与压缩后运行（`source` 为 `startup`、`resume`、`fork`、`compact`）；它的上下文随下一次对模型的请求送达 |
| SessionEnd | `reason` 总是 `other`；关闭会话、退出应用、空闲回收 Agent Host 时运行 |
| `systemMessage`、hook 错误 | 显示在窗口顶部的提示行，标出事件 |
| 长输出 | `additionalContext`、`systemMessage`、纯文本 stdout 超过 10,000 字符时写入会话临时目录，只送前 2,000 字符与文件路径；PreCompact 的摘要指令截断到 10,000 字符 |

每次 hook 运行都写入 Core 的审计表（`audit_events`，`kind: "hook"`）：事件、来源文件、程序名与命令摘要、退出码、耗时、判定，命令原文不入库。设置窗口"权限"页的审计视图目前只列权限裁决。
