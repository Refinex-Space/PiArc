# 调研资料

设计阶段的调研快照（2026-11-14）。这些是带日期的资料，引用时注意时效；用于设计或实现的事实，请回到原始来源重新核对。

| 文件 | 内容 |
|---|---|
| [REFERENCES.md](REFERENCES.md) | 参考仓库清单、固定版本、使用边界、在新机器上复现 `reference/` 的方法 |
| [claude-official-capabilities.md](claude-official-capabilities.md) | Claude Code / Claude Desktop / Claude API 的官方能力全集（工具、权限、hooks、子 agent、skills、MCP、Desktop UX、API 约束），每条附官方来源 |
| [pi-v1.4.0-baseline.md](pi-v1.4.0-baseline.md) | Pi v1.4.0 源码分析：分层、agent 循环、扩展 API、会话、RPC、构建分发、能力缺口、发布节奏，带文件:行号证据 |
| [harness-reference-notes.md](harness-reference-notes.md) | 从 Claude Code 复原工程与 claw-code 提炼的 Harness 设计要点与反面教训 |
| [ui-reference-notes.md](ui-reference-notes.md) | 从 Claude Desktop 界面复刻与设计系统还原中提炼的信息架构、交互阈值、协议语义与品牌边界 |
| [native-stack.md](native-stack.md) | 原生技术选型：macOS UI、Rust ⇄ Swift/C#、Windows UI、文本与终端组件、Node sidecar、沙箱、分发 |
| [scripts/](scripts/) | 调研中使用的测量脚本（Pi RPC 冷启动与内存、CHANGELOG 不兼容变更统计） |
