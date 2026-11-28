# 更新日志

PiArc 的重要变化按版本列在这里，新版本在前。格式遵循 [Keep a Changelog 1.1](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。英文版是 [CHANGELOG.md](CHANGELOG.md)，两份列出相同的版本。

每个版本的条目同时是应用内显示的更新说明，写法见 [docs/engineering/release.md](docs/engineering/release.md)。

## [Unreleased]

### 新增

- PiArc 首个公开版本：基于 Pi 的桌面编码智能体，支持 macOS（Apple 芯片与 Intel）和 Windows 11（x64 与 arm64）。
- **智能体 Harness**：先读后改、冲突检测、保持文件编码的读写与编辑；Bash 与 PowerShell 带进程树清理、超时与后台任务；子 agent 可用任意模型；计划模式、任务清单、提问与下一步建议；自动压缩与实时上下文用量。
- **模型**：Anthropic、OpenAI、Gemini、DeepSeek、Kimi、通义千问、GLM、MiniMax、OpenRouter，任意 OpenAI 或 Anthropic 兼容端点，以及本地模型；服务商提供订阅时可以账号登录；每模型设置、别名，以及带估算成本的用量统计。
- **扩展**：skills、斜杠命令、输出风格、插件与 Pi 包，附带包市场；MCP server 按工作区共享，支持 OAuth 与按需加载工具。
- **控制与安全**：带 diff 预览的结构化审批、保存的规则与审计记录；自动审查模式，由你选定的审查模型回答常规审批；按文件、按片段从写入前快照回退；macOS 上带网络白名单的命令沙箱；凭据存放在加密保险箱；面向团队的托管设置。
- **工作台**：并行会话，每个会话可在自己的 git worktree 中运行；基于 libghostty 的终端，共享后智能体可读；Git 工具支持按片段暂存、生成提交信息、历史、合并、变基，以及经你自己的 `gh` 处理 GitHub PR；内置浏览器，智能体经审批后可以操作；文件浏览、全局搜索与侧边对话。
- **语音输入**：离线听写，支持中文、英文与中英混合的技术用语。
- **兼容 Claude Code**：原样读取 `CLAUDE.md` / `AGENTS.md`、权限规则、hooks、`.claude/agents`、skills、命令与 `.mcp.json`，从不写入 `.claude/`，并可导入 Claude Code 的自动记忆。
- **关于与更新**：设置中新增"关于"页，显示应用与组件版本；PiArc 检查新版本，经你的代理下载，核对签名的发布清单后在重启时安装，macOS 与 Windows 都支持。
- 英文与简体中文界面，浅色与深色主题，全键盘操作，支持屏幕阅读器。
- 首次运行引导，一分钟内连好模型。
