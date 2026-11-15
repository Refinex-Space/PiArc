# 0019. 事件批次经主进程转发时复制，不转移 ArrayBuffer

- 状态：已接受
- 日期：2026-11-15（提议）；2026-11-15 接受（用户授权在 T04 中按本 ADR 决定）
- 取代：无
- 修订：ADR-0014 第 4 条（"大块数据用 `ArrayBuffer` 转移所有权"）
- 相关：架构文档第 7.6、8.3 节（第 5 条）；`docs/spikes/S02-napi-event-channel.md`；T04-A06

## 背景

ADR-0014 第 4 条与架构第 8.3 节第 5 条规定：单批超过阈值时用 `ArrayBuffer` 转移所有权，不复制。T04 实现事件通道时发现，Electron 45 的主进程做不到这一点。

事实（Electron 45.3.2，2026-11-14 核对）：

- `MessagePortMain.postMessage(message, transfer)` 的 `transfer` 只接受 `MessagePortMain`。源码 `shell/browser/api/message_port.cc` 把转移列表交给 `DisentanglePorts`，逐项校验是否为端口；`message` 由 `electron::SerializeV8Value` 用 V8 `ValueSerializer` 序列化，`ArrayBuffer` 的内容被复制进消息。类型声明同样写作 `transfer?: MessagePortMain[]`。
- 本机实测：在主进程把 2 MiB 的 `ArrayBuffer` 放进转移列表，`postMessage` 抛出 `Port at index 0 is not a valid port`；不放进转移列表时消息正常送达，主进程侧 `byteLength` 仍是 2,097,152。
- `webContents.postMessage` 与 `ipcRenderer` 的转移列表同样只接受端口。渲染进程里，`contextBridge` 对可结构化克隆的类型也是复制（官方文档的类型支持表）。
- 链路上还有一次与此无关的复制：Electron 启用了 V8 内存笼，不允许外部 buffer，NAPI-RS 把 Rust 的 `Vec<u8>` 交给 JavaScript 时退回 `napi_create_buffer_copy`。

因此"转发后主进程侧缓冲区已分离"在 Electron 45 上无法实现。为了让验收通过而在发送后把本地缓冲区手动分离，只是做样子，并不减少复制，不采用。

复制的实际代价（S2 基准，M1 Max，打包形态，每批一个事件）：

| 批次大小 | 主进程转发耗时 p50 | 最大 | 同期事件循环延迟 p99 |
|---|---|---|---|
| 1 MiB | 0.67 ms | 4.81 ms | 3.38 ms |
| 4 MiB | 1.68 ms | 2.29 ms | 3.16 ms |
| 8 MiB | 1.96 ms | 3.03 ms | 3.09 ms |

转发耗时包括结构化克隆，事件循环延迟按 `monitorEventLoopDelay` 的原始值计（含 1 ms 采样间隔）。常规负载（10 万事件/分钟，每批约 5 KiB）下每次转发 p95 为 0.50 ms。8 MiB 的批次也只用 2 ms 左右，远低于第 11 章的 16 ms 事件循环预算与 5 ms 转发预算。

## 决策

1. 事件批次在主进程一律以结构化克隆转发，不区分大小，不设"转移阈值"。主进程照旧只看路由键，不解析载荷。
2. 批次载荷保持二进制（`Uint8Array`，内容是该路由事件的 UTF-8 JSON 数组）：每一跳只有一次内存拷贝，不经过 JavaScript 字符串的编码转换。
3. 修订 ADR-0014 第 4 条与架构第 8.3 节第 5 条：去掉"超过阈值用 `ArrayBuffer` 转移所有权"，改为"大块数据以二进制载荷复制转发；单批转发耗时计入第 11 章'Core 事件到渲染进程'的预算"。第 7.6 节同步。
4. 大块内容（长 transcript 窗口、长 diff）的体量仍应从源头控制：Core 合并器按路由键分批，渲染进程按需拉取窗口（T14、T19 设计 `transcript_window` 时沿用）。
5. 验收项 T04-A06 改写为可验证的形式："1 MiB 以上的批次完整到达渲染进程；基准记录其主进程转发耗时，同期事件循环延迟 p99 不超过 16 ms"（用户授权按本 ADR 修改，记入交付计划的计划变更记录）。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 接受复制，载荷保持二进制（本决策） | 不改 Electron；实测 8 MiB 转发约 2 ms；实现已就绪 | 大块数据每一跳复制一次，内存峰值短时翻倍 | 采纳 |
| 发送后手动分离主进程侧缓冲区（`structuredClone(buf, { transfer })` 等） | 能让 `byteLength` 变成 0，满足原验收项字面 | 复制一次也没有省，只是让测试通过；属于为测试写特判 | 否决 |
| Core 移到 `utilityProcess`，渲染进程经 MessagePort 直连（ADR-0014 的退路） | 主进程不再经手批次 | `utilityProcess` 的 `parentPort` 与 `MessagePortMain` 是同一实现，同样只能转移端口；复制仍在，只是换了进程 | 不解决本问题；按 ADR-0014 原有触发条件另行评估 |
| 页面直接持有 MessagePort（preload 把端口转给主世界） | 省掉 `contextBridge` 在渲染进程内的一次复制 | 主进程那次复制仍在；页面拿到原始端口，偏离"preload 回调剥掉 event 对象"的约定 | 暂不采用；渲染进程内这次复制没有单独测量，基准中探针页按时收完了全部事件 |
| `SharedArrayBuffer` | 零复制 | 需要跨源隔离（COOP/COEP），主进程不能把它发给沙箱化的渲染进程 | 否决 |
| 给 Electron 打补丁或等上游支持转移 `ArrayBuffer` | 真正的零复制 | 维护自有补丁的成本高；上游没有对应计划 | 否决；上游支持后再评估 |

## 后果

- 正面：事件通道只有一种转发方式，主进程代码更简单；行为与 Electron 的真实能力一致；成本有基准数据支撑。
- 负面与代价：大块数据在主进程与渲染进程各复制一次（加上 NAPI 边界的一次），内存峰值短时增加批次大小的数倍；超大批次（几十 MiB）的转发耗时会接近预算，需要在源头控制批次大小。
- 需要配套做的事：ADR-0014 注明第 4 条被本 ADR 修订，架构第 7.6、8.3、14 章同步（架构 v2.7）；T04-A06 改写；T44 把大批次转发耗时纳入性能回归。

## 重新评估的触发条件

出现以下任一情况时复核本决策：

- Electron 的 `MessagePortMain` 或 `webContents.postMessage` 支持转移 `ArrayBuffer`；
- 性能测试中单批转发耗时 p95 超过 5 ms，或大批次期间主进程事件循环延迟 p99 超过 16 ms；
- 出现必须一次推送数十 MiB 数据到渲染进程的功能。
