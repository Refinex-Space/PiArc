# 0014. Rust Core 以 NAPI-RS 原生模块加载在 Electron 主进程

- 状态：已接受
- 日期：2026-11-14
- 取代：[ADR-0008](0008-ffi-uniffi.md)
- 相关：架构文档第 3.1、7.1、7.2、7.6 章；`docs/research/electron-stack.md` 第 4 节

## 背景

客户端改为 Electron 后（ADR-0013），Core 的调用方从 Swift / C# 变成了 Electron 主进程里的 JavaScript。ADR-0008 选的 UniFFI 没有面向 Node 的官方后端，原来的理由（一份接口同时服务 Swift 与 C#）也不再成立。

调研事实（2026-11-14）：

- **NAPI-RS 3.x**：`napi` 3.16.2（2026-11-11），`@napi-rs/cli` 3.10.12。支持 `ThreadsafeFunction`（任意 Rust 线程回调 JS）、`AsyncTask`、开启 tokio 后的 `async fn`（返回 Promise），并能生成 TypeScript 声明。
- **ABI**：Node-API 跨 Node 大版本 ABI 稳定，按 Node-API 级别加载，不依赖 `NODE_MODULE_VERSION`。升级 Electron 一般不需要重编。NAPI-RS 自己的 CI 不测 Electron，这一点要我们在 CI 中覆盖。
- **Windows**：`napi-sys` 默认通过 `dyn-symbols` 在运行时解析宿主符号，不需要 node-gyp 模块要求的 delay-load hook（依据源码推断）。win32-arm64 可以在 Windows x64 runner 上直接交叉编译。
- **asar**：`.node` 文件要放在 `app.asar.unpacked`。从 Electron 45 起，asar 内文件的 fd 交给原生模块会报 `EBADF`，所以 Core 不能读取 asar 内的文件。
- **先例**：Claude Desktop 的原生绑定是 NAPI-RS 构建的（依据二进制中的字符串推断）；AFFiNE、Bitwarden 等 Electron 应用也在用。

## 决策

1. 新增 `piarc-napi` crate（取代 `piarc-ffi`），用 NAPI-RS 导出 Core API，产出四个目标的 `.node`：darwin-arm64、darwin-x64、win32-x64、win32-arm64。
2. **只在主进程加载 Core。** 渲染进程永远不加载原生模块，只能经 preload 白名单调用主进程转发的命令。
3. **接口保持粗粒度**（沿用原 ADR-0008 的设计）：方法数量少、参数是完整的值对象；同步方法只做校验与入队，单次耗时预算 1 ms；耗时操作一律返回 Promise。
4. **事件流**：Core 约每 16 ms 合并一批事件，通过一个 `ThreadsafeFunction` 交给主进程；主进程不解析内容，按会话转发到各窗口的 MessagePort。大块数据用 `ArrayBuffer` 转移所有权。
5. **错误与 panic**：错误映射为带 `kind` 与 `retryable` 的结构化对象；导出函数在边界捕获 panic，Core 内部错误不能让主进程崩溃。
6. **类型来源**：NAPI-RS 生成 Core API 的 `.d.ts`；业务数据类型来自 `piarc-protocol` 的 JSON Schema（与 AHP 共用）。两者都纳入 L1 快照测试。
7. **打包**：`.node` 放在 `app.asar.unpacked`；Core 需要的资源放在 `Resources/` 或 unpacked 目录，不放进 asar。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| Core 作为独立进程，主进程经 IPC（JSON-RPC）调用 | 崩溃隔离；与 Electron 的 ABI 完全无关 | 多一个进程和一层序列化；事件流延迟与吞吐更差；Core 本来就是应用的事实来源，崩溃隔离收益有限 | 否决；作为下方触发条件中的退路之一 |
| Core 放在 `utilityProcess` 里，渲染进程经 MessagePort 直连 | 主进程事件循环完全不受 Core 影响 | 系统集成能力（通知、菜单、对话框）仍在主进程，命令要多绕一跳；增加启动复杂度 | 先不做；M0 压测不达标时启用 |
| 通过 C ABI + JS FFI 库（koffi 等）调用 | 不用 NAPI 的宏 | 没有类型生成，异步与回调要手写，生态小 | 否决 |
| Core 编译为 WASM 在 JS 中运行 | 无原生模块 | 没有线程、PTY、文件系统与凭据库访问，不满足 Core 的职责 | 否决 |

## 后果

- 正面：Electron 升级通常不需要重编 Core；TypeScript 声明自动生成；Core 的线程与主进程事件循环相互独立。
- 负面与代价：Core 与主进程同处一个进程，Core 的内存问题会影响整个应用；需要为四个目标维护预编译产物；NAPI-RS 在 Electron 中的兼容性要由我们自己的 CI 保证。
- 需要配套做的事：CI 在每次升级 Electron 时，于四个目标上加载 Core 并跑 L1/L2；M0 S2 压测事件吞吐与主进程事件循环延迟。

## 重新评估的触发条件

- M0 或后续性能测试中，主进程事件循环延迟 p99 超过 16 ms 且确认由 Core 调用或事件转发造成：先把 Core 移到 `utilityProcess`，再考虑独立进程；
- Core 的崩溃导致应用崩溃的事件在 Beta 期出现两次以上；
- NAPI-RS 停止维护，或某个 Electron 版本破坏 Node-API 兼容。
