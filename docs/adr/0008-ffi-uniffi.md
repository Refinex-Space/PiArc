# 0008. Swift ⇄ Rust 绑定使用 UniFFI

- 状态：已接受
- 日期：2026-11-14
- 相关：架构文档第 7.6 节；`docs/research/native-stack.md` 第 2 章

## 背景

Core 是 Rust 静态库，需要同时服务 macOS（Swift）和第二阶段的 Windows（C#，倾向 WinUI 3）。候选方案的现状（原生技术栈调研 2.1–2.5 节）：

- **UniFFI** 0.32.2：一份接口定义生成 Swift、Kotlin，第三方 `uniffi-bindgen-cs`（v0.12.0+v0.32.0）生成 C#；支持 async 与 foreign trait。缺点：仍是 0.x，每个 minor 都不兼容；官方对 Swift 6 只标"部分支持"，几个 async/Sendable 问题尚未修复；Swift 侧 record lift 约 3.7 µs/条。Matrix、Bitwarden、Firefox iOS、Proton 在生产中使用。
- **swift-bridge**：只支持 Swift，曾停更 16 个月。
- **cbindgen + 手写 C ABI**：开销最低（libsignal、Ghostty 采用），但所有权、async、回调全部手写。
- **BoltFFI**：较新，主要靠单人维护。

## 决策

1. 使用 UniFFI，**锁定精确版本**；Swift 与 C# 两端的绑定版本同步升级。
2. 生成的 Swift 代码放在独立的 SwiftPM target，以 Swift 5 语言模式编译；应用主体用 Swift 6，在 UI 层用 actor / `@MainActor` 适配器包住 Core 对象。
3. **接口保持粗粒度**：只暴露少量对象（`CoreRuntime`、`Workspace`、`Session`、`Terminal`、`SettingsStore` 等）；流式事件通过一个 foreign trait 回调下发，Core 端按约 16 ms 合并后再跨 FFI；大块数据（渲染块、diff、终端帧）用扁平 buffer 传递；取消做成显式的 `cancel()`。
4. 热点路径（例如终端帧）实测成为瓶颈时，单独补一条 cbindgen C ABI，不整体替换。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| cbindgen 手写 | 性能与可控性最好 | 维护成本高，C# 端要再写一遍 | 仅用于热点 |
| swift-bridge | Swift 体验好 | 不支持 C#，维护活跃度不稳 | 否决 |
| BoltFFI | 宣称性能更高 | 生态与维护风险 | 观察，不采用 |

## 后果

- 正面：两个平台共享一份接口定义；异步和回调不用手写。
- 负面与代价：UniFFI 升级是有成本的工程任务；Swift 6 严格并发需要适配层隔离。
- 需要配套做的事：M0 验证 async 回调、事件合并、XCFramework 打包和 Xcode 26 默认 MainActor 隔离设置下的编译。

## 重新评估的触发条件

- UniFFI 长期无法支持 Swift 6 严格并发，适配层成本持续上升；
- FFI 开销在性能预算中占比超过 20%。
