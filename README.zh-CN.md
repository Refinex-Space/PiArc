# PiArc

[English](README.md) · **简体中文**

基于 [Pi](https://github.com/earendil-works/pi) 构建的专业 AI 编码 Agent 桌面应用，支持 macOS 与 Windows。

PiArc 想把三件事放在一起：

- **对标 Claude Code 的 Harness 专业度**：带严格编辑不变量的工具体系、权限模式与规则、hooks、子 agent、计划模式、任务清单、上下文工程、检查点与回退、skills、MCP、沙箱。
- **Pi 的多服务商模型层**：Anthropic、OpenAI、Google、DeepSeek、Kimi、Qwen、GLM、OpenRouter、本地模型等，换服务商不换 Harness 行为。
- **一套代码覆盖 macOS 与 Windows**：界面用 Electron + React，Agent 控制面在 Rust 编写的 Core 中。Windows 与 macOS 共用代码，最多晚一个里程碑。

> **当前状态：预发布。** 应用可以从源码运行，也能在 macOS 与 Windows 上打包（见[本地开发与构建](#本地开发与构建)）。下面列出的功能在 macOS 上可用；发布流水线、Windows 为 Beta 补齐与 Beta 验收还没做（见[路线图](#路线图)）。还没有发布正式版本。

## 功能

- 直接沿用已有的 Claude Code 配置：`CLAUDE.md` / `AGENTS.md`、权限规则、hooks、`.claude/agents`、skills、commands、`.mcp.json` 原样读取（PiArc 不会写入 `.claude/`）。
- 按任务选模型，例如只读的探索子 agent 跑在便宜快速的模型上，主会话用更强的模型。
- 结构化审批：带 diff 预览，支持本会话允许与持久规则，全部有审计记录。Auto 模式下由你选定的审查模型答复常规审批，拿不准的仍交给你。
- 基于写前文件快照的确定性回退，支持按文件、按 hunk 丢弃改动。
- 多会话并行，可选 git worktree 隔离；MCP server 按工作区共享，不随会话数复制。
- 内置终端基于 libghostty，agent 也能读取后台终端的屏幕内容。
- Git 工具：按 hunk 暂存，生成提交信息后提交，浏览历史，处理合并与变基冲突，经你自己的 `gh` 创建和审查 GitHub PR。
- 内置浏览器：预览你的应用，agent 也能操作它，和其他工具走同一套审批。
- 语音输入：识别在本机完成，支持中文、英文与中英混合的技术术语。
- 跨会话的自动记忆，以及面向团队的托管设置。
- 启动时间、内存、流式渲染帧时间等性能预算在 macOS 与 Windows 的 CI 中测量，回归会让构建失败。

## 架构概览

```
PiArc（Electron）
├── 渲染进程：React + TypeScript（界面、对话流、输入框、终端视图），沙箱隔离
├── 主进程：TypeScript（窗口、菜单、通知、更新、事件转发）
└── PiArc Core：Rust 原生模块（经 NAPI-RS），加载在主进程
      权限与审批 · hooks · 工具 I/O · 文件快照 · 沙箱 · 配置 · 凭据 · 索引 · diff · 终端
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
- [交付计划：任务看板、执行协议与任务提示词](docs/plan/PLAN.md)

## 仓库结构

```
apps/desktop/     Electron 应用：主进程、preload、React 渲染进程
crates/           PiArc Core 的 Rust workspace，含 NAPI-RS 绑定
agent-host/       基于 Pi SDK 的 TypeScript Agent Host 与 Harness Kit
packages/         共享的 TypeScript 包，例如生成的协议类型
design/tokens/    设计令牌，生成 CSS 变量
design/brand/     应用图标与标记（打包、托盘、界面 logo 的单一来源）
docs/             架构、ADR、需求、调研
reference/        参考仓库的本地只读副本（已加入 gitignore）
```

## 本地开发与构建

所有命令都在仓库根目录执行。完整命令表见 [AGENTS.md](AGENTS.md#命令)。

### 环境要求

| | macOS | Windows |
|---|---|---|
| Node.js | 24（`.nvmrc`） | 24（`.nvmrc`） |
| Rust | 安装 [rustup](https://rustup.rs)；版本由 `rust-toolchain.toml` 锁定，cargo 会自动安装 | 同左 |
| 原生工具链 | Xcode Command Line Tools；打发布包需要完整的 Xcode（快捷指令扩展） | Visual Studio Build Tools（MSVC 与 Windows SDK） |
| 其他 | | Git for Windows（Git Bash）；出安装包需要 .NET 8 SDK |

第一次构建要联网：会下载 libghostty-vt 预编译产物和内置的 node、rg、fd，并校验哈希。

### 安装依赖并从源码运行

```bash
npm ci --ignore-scripts                 # 按 lockfile 安装 npm 依赖（与 CI 相同）
node node_modules/electron/install.js   # 下载 Electron 二进制（--ignore-scripts 不会下载）
npm run build:core                      # 构建 Core 原生模块（开发版）
npm run build:agent-host                # 构建 Agent Host bundle
npm run start -w @piarc/desktop         # 启动应用（热更新）
```

改了 Rust 代码后重新运行 `npm run build:core`，改了 `agent-host/` 后重新运行 `npm run build:agent-host`。从源码运行时，Agent Host 用 PATH 上的 `node` 启动。

在 macOS 上，从源码运行的应用跑在 `node_modules` 里 Electron 自带的 `Electron.app` 中：菜单栏显示 "Electron"，Dock 图标在应用启动后换成 PiArc 的。要看到发布时的样子（应用名、图标、内置 node 与签名分层），打一个开发构建再打开：

```bash
npm run package:desktop -- --flavor development
open apps/desktop/out/development/PiArc-darwin-arm64/PiArc.app
```

### 检查

```bash
node scripts/dev/install-tools.mjs   # 首次：把 cargo-deny、cargo-audit、rg、fd 装进 .tools/
npm run verify                       # 全部 17 项检查，结束时打印汇总表
npm test                             # 只跑 Vitest；另有 npm run lint、npm run typecheck
cargo test -p <crate>                # 只测一个 Rust crate
```

### 打包

打包会先构建 Core 和 Agent Host bundle。`--flavor release`（默认）是给用户用的构建；`--flavor development` 保留端到端测试需要的测试钩子。

**macOS**（DMG 与 ZIP 在 `apps/desktop/out/release/make/`）：

```bash
npm run package:desktop -- --flavor release --arch arm64 --make
# Intel 版：先 rustup target add x86_64-apple-darwin，再用 --arch x64
```

**Windows**（`*-Setup.exe` 在 `apps/desktop/out/release/velopack/win32-x64/`）：

```bash
npm run package:desktop -- --flavor release --arch x64
node scripts/release/pack-windows.mjs --arch x64 --flavor release --versions 0.1.0
```

第二步把锁定版本的 Velopack `vpk` 装进 `.tools/vpk/`，需要 .NET SDK。只要免安装的程序目录时，第一步的 `apps/desktop/out/release/PiArc-win32-x64/PiArc.exe` 就能直接运行。

## 路线图

| 里程碑 | 范围 | 状态 |
|---|---|---|
| M0 | 两个平台上的技术验证：Rust Core 经 NAPI-RS 接入 Electron、流式对话渲染、多会话 Agent Host、凭据、签名与打包、libghostty 终端、沙箱、Electron 安全基线 | 已完成 |
| M1 | 可行走骨架：会话、流式对话、经 Rust Core 执行的核心工具、基础审批、模型设置 | 两个平台已完成 |
| M2 | Harness 核心：权限规则、计划模式、任务清单、hooks、检查点与回退、压缩、Changes 面板 | 两个平台已完成 |
| M3 | 多会话并行、子 agent、后台任务、终端、worktree、MCP、skills 与命令 | 两个平台的功能已交付；内存预算待定 |
| M4 | 沙箱、插件、无障碍、本地化、性能预算进入 CI | macOS 的功能已交付，部分性能预算还未达标；Windows 由 W4 跟进 |
| M5 | macOS 与 Windows 同时 Beta：自动审查模式、自动记忆、企业托管配置、发布流水线 | macOS 已交付 Auto 模式、自动记忆、托管配置与侧边对话；发布流水线、Windows 同步与 Beta 验收待做 |

每个里程碑由 macOS 先达标，Windows 最迟在下一个里程碑结束前达到同样的退出标准。Git 工具、内置浏览器与语音输入是里程碑之外追加的功能。实时的任务看板见 [docs/plan/PLAN.md](docs/plan/PLAN.md)。

## 未签名构建

PiArc 免费开源，发布包不做平台代码签名和公证（[ADR-0018](docs/adr/0018-unsigned-distribution.md)），第一次打开需要你手动放行：

- **macOS**：把 PiArc 拖到"应用程序"文件夹，先打开一次，再到"系统设置 → 隐私与安全性"点**仍要打开**。没有这个按钮时，执行 `xattr -dr com.apple.quarantine /Applications/PiArc.app`，它只对 PiArc 跳过系统的来源检查。新版本会在应用内提示，需要手动下载替换；更新后系统可能再次请求钥匙串访问授权。
- **Windows**：出现 SmartScreen 提示时选**更多信息 → 仍要运行**。之后的更新会自动安装。开启了"智能应用控制"的电脑会拦截未签名程序。

每个版本都会发布一份 SHA-256 校验清单，并用项目自己的密钥签名，应用在更新前会先校验它。

## 合规说明

PiArc 是独立项目，与 Anthropic 无关联，也未获其认可。"Claude" 与 "Claude Code" 是 Anthropic 的商标。

- PiArc **不提供** Claude.ai 订阅登录。使用 Anthropic 模型需要 API key、云厂商凭证（Amazon Bedrock、Google Vertex AI、Microsoft Foundry）或自配网关。
- PiArc 按 clean-room 方式开发：参考项目只用于理解行为，不复制任何专有代码、提示词和品牌资产。见 [ADR-0006](docs/adr/0006-compliance-and-clean-room.md)。

## 参与贡献

项目处于早期阶段。提出改动前请先阅读[架构设计文档](docs/architecture/ARCHITECTURE.md)；其中第 4 章列出的决策只能通过新的 ADR 修改。提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)。

## 许可证

[MIT](LICENSE)

PiArc 基于 Mario Zechner 及贡献者开发的 [Pi](https://github.com/earendil-works/pi)（MIT）构建。
