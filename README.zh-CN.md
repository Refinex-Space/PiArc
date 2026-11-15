# PiArc

[English](README.md) · **简体中文**

基于 [Pi](https://github.com/earendil-works/pi) 构建的原生专业 AI 编码 Agent 桌面应用。

PiArc 想把三件事放在一起：

- **对标 Claude Code 的 Harness 专业度**：带严格编辑不变量的工具体系、权限模式与规则、hooks、子 agent、计划模式、任务清单、上下文工程、检查点与回退、skills、MCP、沙箱。
- **Pi 的多服务商模型层**：Anthropic、OpenAI、Google、DeepSeek、Kimi、Qwen、GLM、OpenRouter、本地模型等，换服务商不换 Harness 行为。
- **真正的原生桌面应用**：先做 macOS（SwiftUI + AppKit），之后做 Windows 原生客户端。不用 Electron，不用 Web UI 外壳。

> **当前状态：设计阶段。** 需求和架构已经确定，实现从 M0 技术验证开始，仓库里还没有可运行的代码。

## 计划中的亮点

- 直接沿用已有的 Claude Code 配置：`CLAUDE.md` / `AGENTS.md`、权限规则、hooks、`.claude/agents`、skills、commands、`.mcp.json` 原样读取（PiArc 不会写入 `.claude/`）。
- 按任务选模型，例如只读的探索子 agent 跑在便宜快速的模型上，主会话用更强的模型。
- 结构化审批：带 diff 预览，支持本会话允许与持久规则，全部有审计记录。
- 基于写前文件快照的确定性回退，支持按文件、按 hunk 丢弃改动。
- 多会话并行，可选 git worktree 隔离；MCP server 按工作区共享，不随会话数复制。
- 启动时间、内存、流式渲染帧时间等性能预算进入 CI。

## 架构概览

```
PiArc.app（一个进程）
├── 客户端：Swift 6，SwiftUI 外壳 + AppKit/TextKit 2 承载对话流、diff、终端
└── PiArc Core：Rust 静态库（经 UniFFI 调用）
      权限与审批 · hooks · 工具 I/O · 文件快照 · 沙箱 · 配置 · 钥匙串 · 索引 · 渲染预处理
          │  AHP：版本化的 JSON-RPC，走 stdio
          ▼
Agent Host（每个工作区一个 Node 进程）
└── Pi SDK + Harness Kit（PiArc 编写的 Pi 扩展）
      agent 循环 · 模型服务商 · 上下文组装 · 压缩 · 子 agent · 计划 · 任务清单
```

详细文档：

- [架构设计文档](docs/architecture/ARCHITECTURE.md)
- [需求规格](docs/product/REQUIREMENTS.md)
- [架构决策记录（ADR）](docs/adr/README.md)
- [调研资料与参考源清单](docs/research/)

## 仓库结构

```
apps/macos/       macOS 客户端（规划中）
apps/windows/     Windows 客户端（第二阶段）
crates/           PiArc Core 的 Rust workspace（规划中）
agent-host/       基于 Pi SDK 的 TypeScript Agent Host 与 Harness Kit（规划中）
design/tokens/    设计令牌，各平台的单一来源（规划中）
docs/             架构、ADR、需求、调研
reference/        参考仓库的本地只读副本（已加入 gitignore）
```

## 路线图

| 里程碑 | 范围 |
|---|---|
| M0 | 技术验证：原生对话流渲染、UniFFI、多会话 Agent Host、钥匙串凭据、Node 签名公证、终端、沙箱 |
| M1 | 可行走骨架：会话、流式对话、经 Rust Core 执行的核心工具、基础审批、模型设置 |
| M2 | Harness 核心：权限规则、计划模式、任务清单、hooks、检查点与回退、压缩、Changes 面板 |
| M3 | 多会话并行、子 agent、后台任务、终端、worktree、MCP、skills 与命令 |
| M4 | 沙箱、插件、无障碍、本地化、性能预算进入 CI |
| M5 | Beta：自动审查模式、自动记忆、企业托管配置、发布流水线 |
| W0–W3 | 基于同一个 Core 的 Windows 原生客户端 |

## 合规说明

PiArc 是独立项目，与 Anthropic 无关联，也未获其认可。"Claude" 与 "Claude Code" 是 Anthropic 的商标。

- PiArc **不提供** Claude.ai 订阅登录。使用 Anthropic 模型需要 API key、云厂商凭证（Amazon Bedrock、Google Vertex AI、Microsoft Foundry）或自配网关。
- PiArc 按 clean-room 方式开发：参考项目只用于理解行为，不复制任何专有代码、提示词和品牌资产。见 [ADR-0006](docs/adr/0006-compliance-and-clean-room.md)。

## 参与贡献

项目处于早期阶段。提出改动前请先阅读[架构设计文档](docs/architecture/ARCHITECTURE.md)；其中第 4 章列出的决策只能通过新的 ADR 修改。提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)。

## 许可证

[MIT](LICENSE)

PiArc 基于 Mario Zechner 及贡献者开发的 [Pi](https://github.com/earendil-works/pi)（MIT）构建。
