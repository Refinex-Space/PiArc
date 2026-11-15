# 0003. Agent Host 运行时使用内置 Node LTS

- 状态：已取代（2026-11-14 被 [ADR-0015](0015-agent-host-runtime-bundled-node.md) 取代）
- 日期：2026-11-14
- 相关：架构文档第 5.6、13 章

## 背景

Agent Host 需要一个 JS 运行时随应用分发，不能依赖用户机器上已装的 Node。调研中的实测数据（Darwin 25.5 arm64，配置目录为空，离线）：

| 方案 | 未压缩体积 | 冷启动到首个响应 | RSS |
|---|---|---|---|
| Node 24 + Pi 官方 esbuild bundle | 约 135 MB（node 本体 119 MB） | 250–300 ms | 约 120 MB |
| Bun `--compile` 单文件 | 约 99 MB | 约 355 ms（首次 1.85 s） | 约 90 MB |

DMG 使用 ULMO 压缩时，Node 本体可从 119 MB 压到约 29 MB（原生技术栈调研实测）。Pi 官方的独立二进制和 Claude Code 都用 Bun 编译；Pi 的 npm 分发、codemode worker 的官方路径则基于 Node。

另外两个事实：

- MCP 生态里大量 stdio server 用 `npx` 启动，Pi 的插件包安装也调用 npm（`core/package-manager.ts`）；
- Node 官方 macOS 二进制带 `get-task-allow` entitlement，不重签直接嵌入无法公证。所有内嵌可执行文件本来就要用我们的 Developer ID 重签，这一条不构成阻断。

## 决策

1. 内置 Node 当期 Active LTS（版本写在构建清单中，撰写时实测版本为 24.x，满足 Pi 的 ≥ 22.19 要求），以及对应的 npm/npx。
2. Agent Host 用 esbuild 打成单个 bundle，与 Node 一起放进 `PiArc.app/Contents/Resources/agent-host/`。
3. 所有内嵌二进制（node、rg、fd、原生 addon）用 PiArc 的 Developer ID 重签，开启 hardened runtime，entitlements 从最小集开始（`com.apple.security.cs.allow-jit`），按 M0 验证结果逐项补充，每项写明原因。
4. 内置的 node/npx 同时提供给 MCP stdio server 和 Pi 插件包安装使用：Core 启动这些子进程时把内置 Node 的目录放在 PATH 前面。
5. 禁用 Pi 的自更新和版本检查（`PI_SKIP_VERSION_CHECK`，以及按需设置 `PI_OFFLINE`），Agent Host 只随应用整体更新，避免破坏签名。
6. 预置 `rg`、`fd`，避免 Pi 首次使用 grep/find 时从 GitHub 下载（`utils/tools-manager.ts`）。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| Bun `--compile` | 体积和内存略小；与 Pi 官方二进制、Claude Code 同路线 | 不能直接给 MCP 的 `npx` 和 Pi 插件包安装使用；冷启动略慢；codemode 需要走官方 `dist/bun/cli.js` 入口 | 作为 M0 实测对照，满足下方触发条件时切换 |
| Node SEA | 单文件 | 体积与 Node 相同，Pi 没有这条官方路径 | 否决 |
| 依赖用户安装的 Node | 应用最小 | 首次使用门槛高，版本不可控 | 否决 |

## 后果

- 正面：MCP 和插件包生态开箱即用，不要求用户装 Node；Agent Host 走 Pi 官方测试最充分的 Node 路径。
- 负面与代价：安装包和常驻内存都比"纯原生"多出一个 Node（约 120 MB RSS/进程）。PiArc 的"轻量"优势主要体现在 UI 进程、启动速度和多会话的增量成本上，不体现在安装包总大小上。对外宣传时必须如实表述。
- 需要配套做的事：M0 验证重签后的 Node 能通过公证，并跑通 V8 JIT；体积和内存纳入 CI 预算（架构文档第 11 章）。

## 重新评估的触发条件

- M0 验证中 Node 方案无法公证或需要过宽的 entitlements；
- 实测多会话场景下 Agent Host 内存超出预算 30% 以上，而 Bun 方案能满足；
- Pi 上游放弃 Node 支持。
