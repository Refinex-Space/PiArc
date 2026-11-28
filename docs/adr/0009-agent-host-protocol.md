# 0009. Core ⇄ Agent Host 使用自有版本化协议 AHP

- 状态：已接受
- 日期：2026-11-14
- 相关：架构文档第 7.4 节、第 5.3 节

## 背景

Core 与 Agent Host 之间的通信需求：

- 双向请求：Core 要命令会话（prompt、steer、abort、fork、compact…）；Agent Host 要向 Core 询问权限、执行 hooks、委托文件与命令 I/O、读取凭据。
- 高频流式事件：文本增量、工具进度、bash 输出。
- 断线重连与崩溃恢复：Agent Host 崩溃后，Core 要知道哪些请求结果不确定。
- 版本协商：Agent Host 和 Core 随应用一起发布，但开发期和回滚时可能不一致。

参考：Pi 官方 RPC 是自定义 JSONL（不是 JSON-RPC 2.0），且缺版本握手（ADR-0002）；OpenClaudeDesktop 用 Codex app-server v2 协议（JSON-RPC over stdio，thread/turn/item 模型）驱动内核；claw-code 的教训是权限请求必须是"事件 + 回应"的异步双向通道，不能是阻塞回调。

## 决策

1. **传输**：Agent Host 子进程的 stdin/stdout，严格按 LF 分帧的 UTF-8 JSON（与 Pi 相同的帧规则：不用会把 U+2028/2029 当换行的行读取器）；stderr 只用于日志。
2. **消息格式**：JSON-RPC 2.0 形态的 request / response / notification，双向都可以发起请求。
3. **握手**：连接建立后 Agent Host 先发 `host/hello`（协议版本、Pi 版本、能力列表），Core 回 `core/welcome`（协议版本、启用的能力）。主版本不一致时拒绝连接并给出可读错误。
4. **事件信封**：所有会话事件带 `{sessionId, seq, ts, type, payload}`，`seq` 在会话内单调递增，Core 断线后可以按 `seq` 请求回放。
5. **调用对账**：会改变状态的请求带 `requestId`（幂等键）。Agent Host 重启后，Core 把未完成请求标记为 `uncertain`，由会话层决定重试或提示用户（借鉴 claw-code SDK 的 Accepted → Running → Terminal / Uncertain 状态机）。
6. **语义模型**：会话（Session）→ 回合（Turn）→ 条目（Item），条目类型覆盖 agent 消息、思考、工具调用、命令执行、文件变更、审批、子 agent、压缩、错误。这套模型与 Codex app-server 和 ACP 的语义接近，便于以后桥接外部内核。
7. **单一 schema 来源**：协议类型定义在 Rust crate `piarc-protocol` 中，导出 JSON Schema，再生成 TypeScript 类型供 Agent Host 使用；双端都有录制样本的往返契约测试。
8. **大块数据走引用**：图片、长输出、文件内容在 AHP 中只传路径或内容哈希，由 Core 管理实体。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 直接沿用 Pi RPC 的 JSONL 格式 | 少一层转换 | 见 ADR-0002 的缺口 | 否决 |
| 直接采用 Codex app-server v2 或 ACP | 现成协议，可接入现有客户端 | 我们需要的权限、hooks、I/O 委托等宿主回调不在其范围内；协议演进不受控 | 借鉴语义，不直接采用；ACP 作为对外接口在 P2 考虑 |
| gRPC / Cap'n Proto | 强类型、性能好 | Node 与 Rust 两端引入重依赖；stdio 场景收益有限 | 否决 |

## 后果

- 正面：协议演进完全可控；版本不一致能被明确发现；崩溃恢复有据可依。
- 负面与代价：需要维护 schema、代码生成和契约测试。
- 需要配套做的事：`piarc-protocol` 是 M0 第一个落地的 crate。

## 重新评估的触发条件

- stdio 吞吐成为瓶颈（例如大量终端输出导致事件延迟 p95 > 50 ms）；
- 决定把 Core 拆成独立守护进程，供 CLI 或远程客户端共用。
