# 架构决策记录（ADR）

ADR 记录 PiArc 中影响全局、难以回退的决策：选了什么、为什么、放弃了哪些方案、什么情况下需要重新评估。

[架构设计文档](../architecture/ARCHITECTURE.md)描述系统"是什么"，ADR 解释"为什么这样"。两者冲突时以已接受的 ADR 为准，并立即修正架构文档。

## 规则

1. 改变下表任何一条决策，都要新写一份 ADR 来取代旧的。旧 ADR 状态改为"已取代"，并链接到新 ADR。不要直接改写已接受 ADR 的决策内容。
2. 新 ADR 编号顺延，文件名 `NNNN-短标题.md`。模板见 [0000-template.md](0000-template.md)。
3. 每份 ADR 必须写"重新评估的触发条件"。触发条件出现时，在对应里程碑的评审中复核。
4. 状态取值：`提议` / `已接受` / `已取代` / `已废弃`。

## 索引

| 编号 | 标题 | 状态 |
|---|---|---|
| [0001](0001-three-tier-native-architecture.md) | 原生客户端 + Rust 核心 + Pi Agent Host 三层架构 | 已接受 |
| [0002](0002-pi-integration-via-sdk-host.md) | 基于 Pi SDK 自研 Agent Host，不 fork Pi、不以官方 RPC 为主协议 | 已接受 |
| [0003](0003-embedded-node-runtime.md) | Agent Host 运行时使用内置 Node LTS | 已接受 |
| [0004](0004-harness-control-plane-in-core.md) | Harness 分工：策略在 Core 裁决，Agent 循环在 Pi，工具 I/O 下沉 Core | 已接受 |
| [0005](0005-claude-code-config-compatibility.md) | 兼容 Claude Code 配置生态，PiArc 自有配置独立 | 已接受 |
| [0006](0006-compliance-and-clean-room.md) | 合规红线：禁用 Claude 订阅登录、clean-room、自有品牌 | 已接受 |
| [0007](0007-macos-ui-swiftui-appkit.md) | macOS 客户端：SwiftUI 外壳 + AppKit/TextKit 2 承载高性能视图 | 已接受 |
| [0008](0008-ffi-uniffi.md) | Swift ⇄ Rust 绑定使用 UniFFI | 已接受 |
| [0009](0009-agent-host-protocol.md) | Core ⇄ Agent Host 使用自有版本化协议 AHP | 已接受 |
| [0010](0010-process-model.md) | 进程模型：每个工作区一个 Agent Host，子 agent 在进程内 | 已接受 |
| [0011](0011-session-storage.md) | 会话以 Pi JSONL 为事实来源，Core 维护 SQLite 索引与文件快照 | 已接受 |
| [0012](0012-distribution-developer-id.md) | 分发走 Developer ID + 公证 + Sparkle，不上 Mac App Store | 已接受 |
