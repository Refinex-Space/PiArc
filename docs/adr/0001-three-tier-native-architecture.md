# 0001. 原生客户端 + Rust 核心 + Pi Agent Host 三层架构

- 状态：已取代（2026-11-14 被 [ADR-0013](0013-electron-desktop-client.md) 取代）
- 日期：2026-11-14
- 相关：架构文档第 3 章

## 背景

PiArc 要同时满足四个要求：

1. 体验对标 Claude Desktop 的 Code 能力，但启动、内存、系统集成要明显优于 Electron 应用；
2. 以 Pi 为 Agent 底座，复用它的多服务商模型层和 agent 循环；
3. macOS 先落地，Windows 随后跟进，第二个平台要尽量复用第一个平台的成果；
4. 提供 Claude Code 级别的 Harness：权限、hooks、子 agent、plan、checkpoint、沙箱等。

Pi 是 TypeScript 实现，只能运行在 Node ≥ 22.19 或 Bun 中（`reference/pi/package.json` engines）。原生 UI 不能直接调用它，必须跨进程。

## 决策

系统分三层，各自独立演进：

| 层 | 技术 | 职责 |
|---|---|---|
| 客户端（Client） | macOS：Swift 6 + SwiftUI/AppKit；Windows：第二阶段选定 | 只负责呈现和输入。不做业务决策，不直接访问模型或执行工具。 |
| 核心（PiArc Core） | Rust，以静态库形式链接进客户端 | 平台无关的业务逻辑：会话编排、权限裁决、hooks 执行、工具 I/O、文件快照、沙箱、配置、凭据、索引、渲染预处理。 |
| Agent Host | TypeScript，基于 Pi SDK，运行在内置 Node 中的子进程 | agent 循环、模型调用、上下文组装、压缩、Harness 扩展（子 agent、plan、todo 等）。 |

原则是"厚核心、薄客户端"：任何 Windows 也需要的逻辑都放进 Core 或 Agent Host，不放在 Swift 里。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| Electron / Tauri + Web UI | 一套 UI 跑两个平台，富文本好做 | 违背产品前提（启动、内存、系统集成）；Tauri 仍是 Web 渲染 | 否决 |
| GPUI / Slint 等跨平台 Rust UI | 单代码库，全 Rust | 拿不到 Liquid Glass 和原生控件，中文输入法、无障碍有短板；GPUI 官方 crate 发版停滞 | 第一版不选，Windows 阶段可作备选 |
| 用 Rust 重写 agent 循环，Pi 只当模型层 | 少一个运行时 | 丢掉 Pi 的工具、会话、扩展生态，pi-ai 本身也是 TS，仍需 Node | 否决 |
| 两层：Swift 直接驱动 Pi 子进程 | 结构简单 | 业务逻辑会落在 Swift 里，Windows 无法复用 | 否决 |

## 后果

- 正面：Windows 阶段只需重写客户端层；Core 和 Agent Host 可以脱离 UI 做无头测试。
- 负面与代价：应用内多一个 Node 运行时（体积和内存见 ADR-0003）；跨两道进程/语言边界，协议设计和契约测试成为一等工作。
- 需要配套做的事：Core 从第一天起在 CI 中同时编译 macOS 与 Windows 目标，防止混入平台假设。

## 重新评估的触发条件

- M0 技术验证中，原生流式长文本渲染达不到性能预算（见架构文档第 14 章风险 R1）；
- Pi 被替换为其他 Agent 底座。
