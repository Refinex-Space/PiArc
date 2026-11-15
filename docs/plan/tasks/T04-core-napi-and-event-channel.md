# T04 Core NAPI 绑定与事件通道（S2）

| 项 | 内容 |
|---|---|
| 阶段 | 1 M0 技术验证 |
| 依赖 | T03 |
| 执行平台 | macOS（CI 同时覆盖 Windows 与四个构建目标） |
| 推荐配置 | Opus 5.5，effort xhigh，新会话 |
| 规模 | 大 |
| 关联验证项 | S2（NAPI-RS Core 接入主进程） |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T04`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

Core 以 NAPI-RS 原生模块加载在 Electron 主进程里（ADR-0014）。主进程的事件循环同时负责窗口与菜单，Core 的事件流一旦占用它，整个应用都会卡。风险 R6 与 ADR-0014 的触发条件指向同一个问题：NAPI 边界的事件吞吐够不够，会不会拖慢主进程。

本任务搭起 Core 到渲染进程的整条事件通道，并用压测回答 S2：

- Rust 侧：`piarc-core` 最小运行时、`piarc-napi` 导出层、约 16 ms 的事件合并；
- 主进程：加载 `.node`，按窗口建立 MessagePort，按路由键原样转发批次；
- 渲染进程：经 preload 订阅事件并计数。

S2 的通过标准（架构第 16 章）：10 万事件/分钟下无丢失；主进程事件循环延迟 p99 ≤ 16 ms；四个目标（darwin-arm64、darwin-x64、win32-x64、win32-arm64）的预编译产物可加载。事件循环延迟超标且确认由 Core 造成时，按 ADR-0014 的触发条件写 ADR 提议（把 Core 移到 `utilityProcess`），停止受影响部分。

这条通道是 T14 会话 API、T10 终端帧的基础；演示事件源只保留给测试与基准。

## 必读

1. 架构设计：
   - 第 3.1 节"分层"
   - 第 7.1 节"Crate 划分"中 `piarc-core`、`piarc-napi` 的职责与依赖规则
   - 第 7.2 节"运行时与并发"
   - 第 7.6 节"Core API（NAPI-RS 导出面）"
   - 第 8.3 节"状态与数据流"（第 5 条：大块数据与 `ArrayBuffer`）
   - 第 11 章中主进程事件循环延迟、Core 事件到渲染进程、主进程内存三行
2. ADR-0014 全文；ADR-0013 第 2 条（主进程不承载业务逻辑）。
3. `docs/research/electron-stack.md` 第 4 节"NAPI-RS"。
4. T02 的结构化错误类型，T03 的 IPC 注册函数、preload 白名单与 L4 基座，以及它们的 CLAUDE.md。
5. 实现时查阅：NAPI-RS 锁定版本的 `ThreadsafeFunction`、`async fn` 与 tokio 运行时、类型映射与 `.d.ts` 生成、交叉编译文档；`@napi-rs/cli` 的构建参数；Electron 的 `MessageChannelMain` 与 `webContents.postMessage`；Node 的 `perf_hooks.monitorEventLoopDelay`。

## 范围

### 要做

- `piarc-core` 最小运行时与 `piarc-napi` 导出层；事件合并器与演示事件源。
- 主进程加载 Core、按窗口转发事件批次；preload 事件订阅；渲染进程计数。
- panic 边界与结构化错误映射。
- 四个目标的预编译与加载测试（CI）。
- 基准脚本与 S2 报告。

### 不做

- 业务 API：工作区、会话等（T13、T14）。
- Agent Host 的启动与 AHP 连接（T06）。
- 终端帧通道（T10）、渲染进程的正式 store（T18）。

## 交付物

### 1. Rust 侧

- `piarc-core`：tokio 多线程运行时，`CoreRuntime` 创建时启动；有序关闭：停止接受新请求 → 停止事件源 → 刷出最后一批 → 释放回调；长任务带 `CancellationToken`。
- 事件合并器：上游事件进入有界通道，按可配置间隔（默认 16 ms）合并成批次。批次由路由键（订阅主题，将来是 `sessionId`）、批次序号与不透明载荷组成；主进程只看路由键，不解析载荷。
- 演示事件源：速率与载荷大小可配置，每个事件带流内连续序号，用于端到端校验丢失与乱序；正式路径不启用。
- `piarc-napi`：`CoreRuntime.create(config, onEvents)`（`onEvents` 为 `ThreadsafeFunction`）、`shutdown()`、演示事件源的启停、一个同步轻量方法（只做校验与入队，用于测同步调用耗时）、一个只在测试构建中存在的 panic 触发导出。
- 错误：Core 错误映射为 T02 的结构化错误形状（`kind`、`retryable`）；导出函数在边界捕获 panic，转成内部错误类别的结构化错误；tokio 任务中的 panic 不被静默吞掉，转成错误事件上报。

### 2. 主进程、preload、渲染进程

- 主进程用一个模块集中解析 `.node` 路径：开发期指向构建输出，打包后从 `app.asar.unpacked` 加载（Forge `plugin-auto-unpack-natives`）。Core 不读取 asar 内的文件（Electron 45 起会 `EBADF`）。
- 每个窗口一个 `MessageChannelMain`，一端交给渲染进程；主进程维护"路由键 → 订阅窗口"表，收到批次后只按路由键转发。
- 载荷编码：小批次用结构化克隆，超过阈值的批次用 `ArrayBuffer` 并转移所有权；阈值实测后确定，写进报告。
- preload 新增事件订阅 API（回调剥掉 event 对象），订阅命令经 T03 的 IPC 注册函数，同步更新 `window.piarc` 白名单快照。
- 渲染进程测试页：订阅、计数、校验序号连续，把统计结果暴露给 Playwright。

### 3. 预编译与加载

- CI 用 `@napi-rs/cli` 构建 darwin-arm64、darwin-x64、win32-x64、win32-arm64 四个 `.node`。
- 加载测试：darwin-arm64 与 win32-x64 在对应 runner 上加载并跑通事件通道。darwin-x64 在 Intel runner 上加载；没有可用 runner 时，先确认能否在 Apple silicon 上经 Rosetta 2 运行 x64 版 Electron 加载，仍不可行则记录。win32-arm64 有 arm64 runner 时加载，没有时至少交叉编译成功，实机加载留给 W0。
- NAPI-RS 生成的 `.d.ts` 纳入 L1 快照测试，并入 verify。

### 4. 基准

脚本放在 `scripts/bench/`，一条命令运行，输出 JSON 结果与摘要：

- 吞吐：10 万事件/分钟持续 5 分钟，渲染进程收到的事件数等于发出数，每个流的序号严格递增；
- 主进程事件循环延迟：基准期间用 `monitorEventLoopDelay` 采样，报告 p50、p99、max；
- 同步 NAPI 调用：≥ 10,000 次调用的 p50、p99；
- 大批次：1 MiB 以上的批次经 `ArrayBuffer` 转移，记录转发耗时；
- 主进程空闲 RSS（含 Core），对照第 11 章 ≤ 120 MB。

正确性用 ≤ 30 秒的短时版本进 verify；性能数字不在 verify 中断言，避免 CI 机器波动造成误报。完整基准在本机运行并写入报告。

### 5. S2 报告

`docs/spikes/S02-napi-event-channel.md`：环境与版本、方法、数据（吞吐、延迟分位数、同步调用、`ArrayBuffer` 阈值、四个目标的构建与加载结果）、结论。macOS 已验证：darwin-arm64 的全部基准、darwin-x64 的加载结果；待 W0：win32-x64 实机基准、win32-arm64 实机加载。更新 `docs/spikes/README.md`。

## 实现要点

- `ThreadsafeFunction` 持有引用时会让 Node 事件循环保持存活：关闭时必须释放，否则应用退出会挂住。测试覆盖"加载 Core 后应用能正常退出"。
- 回调队列的上限与满时策略（阻塞 Core 线程等待，或在合并器中继续累积）要明确，任何策略都不能丢事件，写进 crate 文档。
- 同步方法不做 I/O，不拿可能被长时间持有的锁。
- macOS 上 x64 构建用 `x86_64-apple-darwin` 目标；Windows 两个目标在 x64 runner 上用 MSVC 构建（electron-stack.md 第 4 节）。

## 验收标准

- [T04-A01] `CoreRuntime` 有序关闭后不再触发事件回调，加载 `.node` 的 Electron 应用能正常退出不挂起。验证：Rust 集成测试与 Playwright 测试。
- [T04-A02] 持续事件源下每秒回调次数不超过 `1000 / 合并间隔（ms）` 的 110%，且批次平均包含多于 1 个事件。验证：测试输出。
- [T04-A03] 10 万事件/分钟持续 5 分钟，渲染进程收到的事件数等于发出数，每个流的序号严格递增、无缺口。验证：基准输出中的计数与序号校验。
- [T04-A04] 上述基准期间主进程事件循环延迟 p99 ≤ 16 ms。验证：`monitorEventLoopDelay` 输出。
- [T04-A05] 同步 NAPI 调用 p99 ≤ 1 ms（≥ 10,000 次调用）。验证：基准输出。
- [T04-A06] 1 MiB 以上的批次完整到达渲染进程；基准记录其主进程转发耗时，同期事件循环延迟 p99 不超过 16 ms（按 ADR-0019，批次复制转发，不转移 `ArrayBuffer`）。验证：测试与基准输出。
- [T04-A07] 两个窗口订阅不同路由键时，各自只收到自己的批次。验证：Playwright 测试。
- [T04-A08] 调用测试导出触发 panic 后，调用方收到内部错误类别的结构化错误，主进程存活，后续调用正常。验证：测试。
- [T04-A09] 四个目标都构建成功；darwin-arm64 与 win32-x64 在对应平台加载通过，darwin-x64 与 win32-arm64 的加载结果或替代方式记录在报告中。验证：本机输出、CI 配置与报告；Windows 运行结果未取得时标 `blocked`，由 W0 核对。
- [T04-A10] `package` 产物从 `app.asar.unpacked` 加载 `.node`，事件通道工作。验证：针对打包产物的 Playwright 测试（断言实际加载路径）。
- [T04-A11] NAPI-RS 生成的 `.d.ts` 纳入 L1 快照：临时改动一个导出签名而不更新快照，verify 失败；更新快照后通过。验证：关键输出。
- [T04-A12] S2 报告含吞吐、延迟分位数、同步调用、四个目标构建与加载结果和结论，`docs/spikes/README.md` 已更新。验证：文件内容。
- [T04-A13] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 创建 `crates/piarc-core/CLAUDE.md` 与 `crates/piarc-napi/CLAUDE.md`：运行时与关闭顺序、事件合并器、`ThreadsafeFunction` 生命周期、panic 边界、`.d.ts` 快照的更新方法。
- 更新 `apps/desktop/CLAUDE.md`：`.node` 加载路径、MessagePort 路由表、基准命令。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：事件合并器、NAPI 错误映射与 panic 边界、`.node` 路径解析、基准脚本。
