# 0002. 基于 Pi SDK 自研 Agent Host，不 fork Pi、不以官方 RPC 为主协议

- 状态：已接受
- 日期：2026-11-14
- 相关：架构文档第 5 章；`docs/research/pi-v1.4.0-baseline.md`

## 背景

Pi 提供三种集成方式（`reference/pi/packages/coding-agent/docs/rpc.md`、`sdk.md`）：

- **SDK**：`createAgentSession()` 在 Node 进程内直接操作会话、模型、工具、扩展；
- **RPC 模式**：`pi --mode rpc`，stdin/stdout 上的严格 LF 分隔 JSONL；
- **扩展**：TypeScript 模块，可以拦截工具调用、注册工具/命令/provider、改写上下文。

Pi 官方 RPC 对 PiArc 有这些缺口（Pi 调研第 4.8 节，已核实）：

- 一个进程同一时刻只有一个活动会话；
- 没有协议版本握手、没有登录命令、没有会话列表、没有按请求取消；
- 扩展 UI 子协议只支持字符串形式的 select/confirm/input/editor，承载不了结构化审批卡、diff 预览、子 agent 树。

Pi 的发布节奏很快：2026-06 以来 coding-agent 51 个版本中有 9 个带不兼容变更，RPC 协议历史上也出现过不兼容修改。上游对新贡献者的 issue/PR 默认自动关闭。

## 决策

1. PiArc 编写自己的 Node 程序 `piarc-agent-host`，以 npm 依赖方式使用 `@earendil-works/pi-coding-agent`、`pi-ai`、`pi-agent-core`、`pi-mcp`，**锁定精确版本，整套同版本升级**。
2. Agent Host 通过 SDK（`createAgentSession`、`AgentSessionRuntime`、`ModelRuntime`、`SessionManager`、`DefaultResourceLoader` 的 `extensionFactories`）托管会话，对 Core 暴露 PiArc 自有协议 AHP（见 ADR-0009）。
3. Harness 能力写成随 Agent Host 静态打包的 Pi 扩展（内部称 Harness Kit），不依赖运行时从磁盘加载 PiArc 自己的扩展。
4. **不 fork Pi。** 必须修改 Pi 才能实现的能力，先在上游提 issue 争取扩展点；短期内用 `patch-package` 形式的小补丁集维护，补丁清单和原因记录在 `agent-host/patches/README.md`，每次升级逐条复核。
5. 只依赖 Pi 的公开导出（包入口导出的 SDK、ExtensionAPI、类型），禁止深度 import 内部文件。
6. 保留 `pi --mode rpc` 作为诊断手段，不作为产品主路径。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 官方 RPC + 自定义入口 `main(args, { extensionFactories })` | 复用官方命令分发，协议由上游维护 | 上述缺口都要靠 hack 补（字符串里塞 JSON、侧信道）；多会话、登录、版本握手迟早要换 SDK，到时还要重写 Rust 适配层 | 否决，Pi 调研 agent 的首选方案，主 agent 裁决不采纳 |
| fork Pi 深度改造 | 完全可控 | 失去上游多服务商更新；按发布节奏，合并成本会持续累积 | 否决 |
| chord 作为宿主协议 | 有类型化契约 | coding-agent 已不依赖 chord；协议只有 TS 定义，1.3.0 一个版本内从 v2 升到 v4 | 否决 |

## 后果

- 正面：Agent Host 用 TypeScript 直接调用 SDK，Pi 的不兼容变更在 `tsc` 编译期暴露；如果走 JSONL 协议，同样的漂移只能靠回放测试在运行时发现。登录（`ModelRuntime.login` 的交互回调）、凭据（`ModelRuntime.create({ credentials })`）、多会话都能直接接入。
- 负面与代价：需要自己维护命令分发层（可参照 `modes/rpc/rpc-mode.ts` 的语义）；要跟进 SDK 接口变化。
- 需要配套做的事：建立 Pi 升级流程：读 CHANGELOG 的 Breaking Changes → 升级 → 编译 → 跑 L1/L2 测试（架构文档第 12 章）→ 更新 `docs/research/pi-v1.4.0-baseline.md` 中的版本基线。

## 重新评估的触发条件

- Pi 官方 RPC 补齐了多会话、版本握手、结构化扩展 UI；
- Pi 的 SDK 出现无法通过公开 API 规避的阻断性变化；
- 连续两个季度补丁集超过 10 个，说明"不 fork"已名存实亡。
