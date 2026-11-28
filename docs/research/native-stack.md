> 本文是 2026-11-14 的调研快照，由调研过程整理而成，引用时注意时效。版本号与生态现状变化很快。重要事实在用于设计或实现前，请回到原始来源重新核对。
>
> **适用范围变更（2026-11-14）**：客户端已改为 Electron + React（ADR-0013），本文中 macOS / Windows 原生 UI、UniFFI、Sparkle 相关的推荐不再采用，保留作为决策背景。终端（第 6 章）、Node sidecar（第 8 章）、沙箱、同类应用（第 10 章）等部分仍然有效。Electron 技术栈的调研见 [electron-stack.md](electron-stack.md)。

# PiArc 原生技术选型调研报告

- 调研日期：2026-11-14
- 范围：macOS 原生（第一版）、Windows 原生（第二阶段）、Rust 核心、Pi（TypeScript）sidecar
- 方法：按主题分 5 路并行检索（WebSearch / WebFetch / context7 / crates.io / npm / GitHub API），本机（macOS 26.5.2，M1 Max）对部分体积和启动数据做了实测。下列关键事实由主笔二次核对过原始页面：macOS 27 发布、Raycast v2 架构、Pi RPC 协议、libghostty 1.0、mxc-sdk、windows-reactor、UniFFI 版本。其余条目都附了来源，但没有逐条复核。
- 标注约定：**【未确认】** 表示没找到一手来源；**【据报道】** 表示来源是二手报道；**【实测】** 表示在本机跑过；**【估算】** 表示推算值。

---

## 0. 结论速览

| 层 | 推荐 | 备选 / 何时切换 |
|---|---|---|
| macOS UI | **混合**：SwiftUI 负责外壳和 Liquid Glass，AppKit 负责会话流（view-based `NSTableView` + TextKit 2 只读 `NSTextView`）、diff 和终端视图 | spike 不达标时，仅消息区域改用 `WKWebView`（触碰“排除 Web”的边界，需要你拍板） |
| 最低系统 | **macOS 26 Tahoe** | 要覆盖 Sequoia 用户才降到 15，代价是两套视觉方案 |
| Rust↔Swift | **UniFFI 0.32.2**，生成的 Swift 放进独立模块，用 Swift 5 语言模式编译 | 热点路径手写 cbindgen C ABI；BoltFFI 观察 6–12 个月 |
| Rust↔C#（第二阶段） | **uniffi-bindgen-cs v0.12.0+v0.32.0**，和 Swift 端共用一份接口定义 | csbindgen + C ABI |
| Windows UI（第二阶段） | **C# + WinUI 3（Windows App SDK 2.6.x）**，启动前做 PoC | WPF（Raycast 的选择）、GPUI + gpui-component、windows-reactor（preview） |
| 跨平台 Rust UI | **第一版不选** | Windows 阶段如果团队偏 Rust、且能接受非 Fluent 观感，评估 GPUI |
| 流式 Markdown / 高亮 / diff | 都放在 Rust 核心：pulldown-cmark 增量块解析、tree-sitter-highlight 0.27.2、similar 3.2.1；通过 FFI 下发 UTF-16 偏移的 span | imara-diff（超大文件，或需要和 git 行为一致时） |
| 终端 | **portable-pty 0.9.0 + libghostty-vt 1.0（稳定 C ABI）**，原生端自绘 | v1 赶时间就先用 SwiftTerm 1.99.x 过渡 |
| Node sidecar | **沿用 Pi 官方的 Bun 1.4.4 `--compile` 产物**，用 Developer ID 重签（hardened runtime + allow-jit） | 普通 `node` 24/26 LTS 加 Pi 的 bundle（不用 SEA） |
| 沙箱 | macOS：Seatbelt（借助 srt，或仿 Codex 自己生成 profile）+ 本地代理做域名白名单；Windows：MXC + Job Object | 评估 MXC 1.1.0 能否用一套策略覆盖 macOS 和 Windows |
| 凭据 | Rust `keyring-core` 1.0.1 + `apple-native-keyring-store`（protected）/ `windows-native-keyring-store` | — |
| 分发 | **只走 Developer ID + notarytool + Sparkle 2.10.1**，DMG 用 ULMO 并按架构分包；Windows 用 Velopack 1.2.161 + WinGet | MAS 不可行 |

### 0.1 需要修正的任务前提

1. **macOS 27 "Golden Gate" 已于 2026-09-14 正式发布，只支持 Apple silicon**；macOS 26 是最后一个支持 Intel 的版本。所以“macOS 26 Tahoe 是当前系统”这个前提已经过时。来源：https://www.macrumors.com/2026/09/14/apple-releases-macos-golden-gate/ ，https://www.macworld.com/article/3139330/macos-27-golden-gate-has-arrived-heres-what-s-new-on-your-mac.html
2. **Pi 的 RPC 不是 JSON-RPC 2.0**，而是自定义的严格 JSONL：用 `pi --mode rpc` 启动，stdin 写入 `{"id","type",...}` 命令，stdout 返回 `{"type":"response","command","success","data"|"error"}` 和不带 id 的事件流。分帧只能按 LF 切。来源：https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md （主笔已核对）
3. **Pi 官方的 standalone 二进制用 Bun `--compile` 构建，不是 Node SEA**：CI 固定 Bun 1.4.4，Pi 最新 release 是 v1.5.2（2026-11-10）。来源：https://github.com/earendil-works/pi/blob/main/scripts/build-binaries.sh
4. **同类产品里，“原生 UI + Node”的 Raycast 已在 v2 改为“原生壳 + 系统 WebView UI”**；OpenAI Codex App 用的是 Electron。行业主流在往 Web UI 走，PiArc 的全原生路线属于少数派（同路的有 Ghostty、Zed、Warp）。代价和风险见第 10 节。

### 0.2 最大技术风险（建议先做 spike 验证）

**原生流式长文本渲染。** 有开发者依次试过纯 SwiftUI、NSTextView（TextKit 2）、NSCollectionView、自写 TextKit 2，都没做好流式聊天，最后改用 Electron：https://justsitandgrin.im/posts/native-all-the-way-until-you-need-text （2026-05-17）。Raycast v2 也把 “rich text and markdown are simpler” 列为改用 Web 的收益之一。建议在正式开工前用 1–2 周做 spike，验收门槛：10 万 token 流式输出、长会话滚动、跨块选择复制、CPU 和内存指标。

---

## 1. macOS UI 框架

### 1.1 Liquid Glass API 现状

| API | 最低系统 | 要点 | 来源 |
|---|---|---|---|
| SwiftUI `glassEffect(_:in:)` | macOS 26.0 | 默认是 `.regular` 变体加 Capsule 形状 | https://developer.apple.com/documentation/swiftui/view/glasseffect(_:in:) |
| SwiftUI `GlassEffectContainer(spacing:)` | macOS 26.0 | 把多个玻璃形状合并渲染，文档写明能提升性能 | https://developer.apple.com/documentation/swiftui/glasseffectcontainer |
| AppKit `NSGlassEffectView` | macOS 26.0 | 属性：contentView、cornerRadius、style、tintColor、effectIsInteractive | https://developer.apple.com/documentation/appkit/nsglasseffectview |
| AppKit `NSGlassEffectContainerView` | macOS 26.0 | 属性：contentView、spacing，作用是减少渲染 pass | https://developer.apple.com/documentation/appkit/nsglasseffectcontainerview |

macOS 27 的变化：
- 新增系统级的“玻璃透明度”用户滑杆，"refined Liquid Glass look" 自动生效。WWDC26 没看到新的玻璃 API，新增的主要是 toolbar 相关 API（visibilityPriority、ToolbarOverflowMenu）。来源：https://wwdcnotes.com/documentation/wwdc26-269-whats-new-in-swiftui/
- **退出开关会失效**：链接 macOS 27 SDK 编译时，系统会忽略 `UIDesignRequiresCompatibility`。来源：https://developer.apple.com/forums/thread/832543 。Apple 只在 iOS 场景下明确确认过这一点，macOS 端没有单独表态，【未确认】。所以新项目不要指望退出 Liquid Glass。

### 1.2 最低系统版本：推荐 macOS 26

- **装机量**：TelemetryDeck 2026-11-02 的数据（截至 10 月底）只列出了前几个版本：26.7 占 30.82%，26.6 占 21.30%，27.0 占 16.63%，26.5 占 10.84%，27.2 占 7.71%。这几项合计约 87%，都是 26 及以上。来源：https://telemetrydeck.com/survey/apple/macOS/versions/
  - 局限一：页面没给 15.x 的汇总占比，【未确认】。
  - 局限二：样本偏开发者和独立应用用户。PiArc 的用户是专业开发者，这个偏差反而接近目标人群。
  - StatCounter 从 Catalina 之后无法区分 macOS 版本，没法用。
- **选 26 的理由**：
  1. Liquid Glass 的 API 全部要求 26.0+，定在 26 就不用维护两套视觉方案。
  2. macOS 26 运行时自带 SwiftUI 列表优化：超过 10 万项的列表加载快 6 倍，更新最多快 16 倍（WWDC25 session 256，https://developer.apple.com/videos/play/wwdc2025/256/ ）。
  3. 富文本 `TextEditor(text: Binding<AttributedString>)`、SwiftUI 原生 `WebView` 等 API 都要求 26.0+。
  4. 26 仍能覆盖还可以升级的 Intel Mac。
  5. 到 PiArc 首发（大概率在 2027 年）时，26 已经是 N-1 版本。
- **为什么不选 15**：要覆盖 15 就得用 `#available` 分支加 Material 做降级，UI 的 QA 工作量翻倍。15 能拿到的有 `ScrollPosition` 和 Textual 库（要求 15+）。
- **为什么不选 14**：14 带来的 `@Observable` 在 15 和 26 上都可用，14 的装机量已经很低【未直接核实】。
- **Intel 支持**：如果最低版本定 26，理论上要支持 Intel。建议 arm64 作为一等公民；Intel 单独出 DMG，按 Sparkle 统计数据决定是否继续。不要做 Universal 包，否则 sidecar 体积翻倍。

### 1.3 SwiftUI 在长列表和流式文本上的已知问题

1. **`ScrollView + LazyVStack` 加 `scrollTo` 会触发布局 livelock**（主线程 100%）。原因是屏外项的预估高度不断让滚动锚点漂移。修法是改用急切布局的 VStack、无动画滚到底部的一个 1px 哨兵视图、用 LRU 缓存 Markdown 解析结果。来源：https://tacticremote.com/blog/2026-07-03-hunting-a-swiftui-layout-livelock/ （2026-07-03）
2. **SwiftUI `Text` 不能跨视图选择**：`.textSelection` 只在单个 Text 内有效，用块级 Text 拼出来的 Markdown 无法整段选中。来源：https://forums.swift.org/t/how-to-select-text-in-swiftui-on-macos/35188
3. **TextKit 2 本身的问题**：
   - 视口布局时文档高度是估算值，滚动条会跳，Apple 回复这是 "as-designed"；跳到文档末尾也很脆弱。来源：https://blog.krzyzanowskim.com/2025/08/14/textkit-2-the-promised-land/
   - 论坛有人报告超过约 3000 行后滚动退化，`ensureLayout` 要花几秒。来源：https://developer.apple.com/forums/thread/761364
4. **业界做法**：
   - 用 `NSTableView` 承载视图，滚动明显更顺（https://mjtsai.com/blog/2024/04/15/nstableview-with-swiftui ）。SwiftUI `Table` 在 macOS 上有性能问题的报告。
   - Raycast v1 因为崩溃率和性能问题否决了 SwiftUI，改用自定义 AppKit 组件：https://www.raycast.com/blog/how-raycast-api-extensions-work
   - 原生 AI 客户端 FlowDown 用 Lakr233/MarkdownView 4.x，这是纯 UIKit/AppKit 实现，流式更新默认节流到 20fps，并在流式时自动闭合未完成的标记：https://github.com/Lakr233/MarkdownView 。许可证在 GitHub 上显示 NOASSERTION，README 写的是 MIT，【需核实】。

### 1.4 推荐架构

- **SwiftUI**：Scene/窗口、`NavigationSplitView` 侧边栏、设置页、toolbar、inspector、sheet，以及玻璃效果。
- **AppKit**：
  - 会话流用 view-based `NSTableView`，靠它做 cell 复用和行高缓存。
  - 正文用只读 `NSTextView`（TextKit 2）。代码块、diff、工具调用卡片、表格各用一种独立的原生行类型。
  - 流式输出只改最后一行的 `NSTextStorage`（在 `beginEditing`/`endEditing` 之间做局部 replace），主线程按 30–60Hz 合并刷新。
- **代价**：跨块选择要自己补，比如“复制整条消息”“选中本条”。

---

## 2. Rust ↔ Swift / C# 互操作

### 2.1 方案对比

| 方案 | 版本 / 日期 | 优点 | 风险 | 来源 |
|---|---|---|---|---|
| **UniFFI** | 0.32.2（2026-09-23）；0.32.0（2026-06-30） | Swift/Kotlin/C#（第三方）共用一份接口定义；支持 async（Swift async/await）、foreign trait（0.32 新增 `#[uniffi::export(foreign)]`）、`&[u8]` 零拷贝 | 仍是 0.x，每个 minor 版本都 breaking，checksum 跨版本不兼容；**Swift 6 只有 "partial support"**；async future 不支持取消 | https://crates.io/crates/uniffi ，https://github.com/mozilla/uniffi-rs/blob/main/CHANGELOG.md ，https://mozilla.github.io/uniffi-rs/latest/swift/overview.html ，https://mozilla.github.io/uniffi-rs/latest/futures.html |
| swift-bridge | 0.1.59（2026-01-06） | Swift 专用，零拷贝友好 | 0.1.57 到 0.1.58 之间停更 16 个月；Swift 6.2 相关 issue #350、#365 仍为 open；只支持 Swift | https://crates.io/crates/swift-bridge |
| cbindgen + 手写 C ABI | cbindgen 0.29.4（2026-06-09） | 开销最低、完全可控；libsignal、Ghostty 都这么做 | 所有权、async、回调都要手写，维护成本高 | https://crates.io/crates/cbindgen ，https://github.com/signalapp/libsignal/blob/main/rust/bridge/README.md |
| BoltFFI | 0.32.1（2026-10-30），MIT，2025-12 创建 | 支持 Swift async、C# `Task`/`IAsyncEnumerable`；自称“比 UniFFI 快 1000 倍”（项目自测） | 基本靠一个人维护；Sendable 问题 #778 仍为 open；没查到大型生产用户【未确认】 | https://github.com/boltffi/boltffi |
| Crux | 0.20.0（2026-08-07） | 纯核心 + effect 消息的架构 | 是一整套框架，适合 UI 逻辑共享，PiArc 的核心偏服务宿主，用不上；可以借鉴它的消息化思路 | https://github.com/redbadger/crux |
| Diplomat | 0.17.0 | — | **没有 Swift 后端**，排除 | — |

### 2.2 UniFFI 与 Swift 6 的已知问题（截至 2026-11）

- **#2458**：async 代码不满足 Sendable，open，最近一次更新 2026-08，报告环境是 0.32.0 + Swift 6.3.2。这个问题用 `swiftc -typecheck` 测不出来，只有完整编译才失败。
- **#2929**：async foreign trait 在 `.v6` 模式下报硬错误。PR #2943 已于 2026-07-15 合入 main，但**不在 v0.32.2 里**，要等下一个版本。
- **#2818**：Xcode 26 新项目默认 `SWIFT_DEFAULT_ACTOR_ISOLATION=MainActor`，生成代码会编译失败，open。
- **#2803**：Swift 6.2 新增的 `Data.bytes` 和生成代码冲突，open。
- **#3013**：Swift 侧 lift 一条 record 约 3.7µs，Kotlin 只要 0.2–0.3µs，open（2026-09-27）。
- **业界规避方式**：把生成的 Swift 放进独立 package，用 Swift 5 语言模式编译。
  - Matrix matrix-rust-components-swift：`swift-tools-version:5.9`，uniffi 0.32.1。https://github.com/element-hq/matrix-rust-components-swift
  - Bitwarden sdk-swift：Swift 5.7 加 `-suppress-warnings`；sdk-internal 锁定 `uniffi = "=0.32.0"`。https://github.com/bitwarden/sdk-swift ，https://github.com/bitwarden/sdk-internal
  - Mozilla application-services 锁定在一个 git rev 上。https://github.com/mozilla/application-services/blob/main/Cargo.toml

### 2.3 Rust ↔ C#（第二阶段）

| 方案 | 版本 | 要点 |
|---|---|---|
| **uniffi-bindgen-cs**（NordSecurity） | v0.12.0+v0.32.0（2026-11-09），对应 UniFFI 0.32.0 | 支持 async、async trait、callback；要求 .NET 8+；#165（async callback 生成了同步返回类型）open。https://github.com/NordSecurity/uniffi-bindgen-cs |
| csbindgen（Cysharp） | 1.9.8（2026-05-20） | 从 `extern "C"` 生成 DllImport，需要手写 C ABI |
| windows-rs `#[implement]` 写 WinRT 组件 | windows-core 0.100.0 | 技术上可行，但没查到生产案例【未确认】 |

注意：uniffi-bindgen-cs 的版本必须和 Rust 侧 uniffi 严格对齐，所以 Swift 和 C# 两端的升级节奏会互相牵制。

### 2.4 参考项目

| 项目 | 做法 | 来源 |
|---|---|---|
| Firefox iOS / application-services | UniFFI | https://github.com/mozilla/application-services |
| Bitwarden | sdk-internal（Rust）用 UniFFI 生成 sdk-swift / Kotlin | https://github.com/bitwarden/sdk-internal |
| Matrix / Element X iOS | matrix-rust-sdk 用 UniFFI | https://github.com/element-hq/matrix-rust-components-swift |
| Signal libsignal v0.108.0（2026-11-13） | 自研 `#[bridge_fn]` 宏同时生成 FFI（cbindgen）、JNI、Node | https://github.com/signalapp/libsignal |
| 1Password | Rust 核心 + 各平台 UI，用 typeshare 同步类型（typeshare-cli 1.13.4）；具体 FFI 序列化格式【未确认】 | https://1password.com/blog/typeshare-for-rust |
| Proton Mail | 约 80% 是共享 Rust 核心，仓库里有 mail-uniffi crate | https://proton.me/blog/next-generation-proton-mail-mobile-apps |
| Ghostty v1.4.0（2026-10-27） | Zig 核心 + `ghostty.h` C API + Swift/AppKit 应用；**和 PiArc 的形态最接近** | https://github.com/ghostty-org/ghostty |

### 2.5 推荐用法

1. Rust 核心编成 staticlib + XCFramework。生成的 Swift 放在单独的 SwiftPM target，设 `swiftLanguageModes: [.v5]`；App 主体用 Swift 6，在 UI 层用 actor 或 `@MainActor` 适配器包住 Rust 对象。
2. 锁定 uniffi 版本。等 #2943 进入正式版后，Swift 和 C# 两端一起升级。
3. **接口要粗粒度**：
   - 只暴露少量对象（Session、Workspace、Terminal 等）。
   - 流式输出用一个 foreign trait 做事件回调，在 Rust 侧按约 16ms 合并 delta，避免逐 token 跨 FFI，也能规避 #3013 的 lift 开销。
   - 大块数据（diff、span）用扁平 buffer 加 `&[u8]` 传。
   - 取消操作做成显式的 `cancel()`。
4. 终端帧缓冲这类热点如果实测成为瓶颈，再单独补一条 cbindgen C ABI。

---

## 3. Windows 原生 UI（第二阶段）

### 3.1 现状

- **Windows App SDK**：
  - 2.0.1 于 2026-04-29 发布，此后改用 SemVer 并按月发布。当前稳定版 **2.6.5（2026-11-03）**；1.8 线仍在维护，最新 1.8.12。https://github.com/microsoft/WindowsAppSDK/releases
  - 2.0 新增 `SystemBackdropElement`（可以在布局中任意位置放 Mica/Acrylic）。2.6.5 回退了一项 backdrop 改动，说明新合成引擎还在稳定中。
- **WinUI 开源**：2026-08-28 的状态显示 Phase 1–4 已完成，GitHub 成为主开发地；XAML 编译器仍未开源。https://github.com/microsoft/microsoft-ui-xaml/discussions/10700
  - Build 2026 弃用 “WinUI 3” 这个名字：只有一个来源 https://next.ink/254347/interfaces-le-framework-winui-de-microsoft-devient-pleinement-open-source/ ，【据报道，孤证】。
- **C++/WinRT**：2022 年原作者称其进入维护模式，但 3.0 已于 2026-05 发布（支持 C++20 modules），最新 3.0.260818.1：https://github.com/microsoft/cppwinrt/releases 。它没死，只是写 UI 的效率低。
- **微软自家工具的选型**：
  - Windows Terminal v1.26 用 C++/WinRT + WinUI 2.8（XAML Islands）。
  - PowerToys v0.103、Files v4.3 用 C# + WinAppSDK 2.6.5。
  - Dev Home 已归档。
- **.NET**：.NET 11.0.0 是 STS（2026-11-10），.NET 10 是 LTS。WinAppSDK 1.6 起支持 NativeAOT；CsWinRT 3.0 仍是 preview（3.0.0-preview.261104.1），AOT 加 trimming 有坑的报告。
- **用 Rust 直接写 WinUI**：微软在 windows-rs 仓库新出的 **windows-reactor 0.100.0**（2026-09-03，crates.io 总下载 8,121，主笔已核对），定位是 "Declarative Windows UI library for Rust"。它自称 preview，"public APIs may change"，文本密集型控件的覆盖情况【未确认】。https://github.com/microsoft/windows-rs/tree/master/crates/libs/reactor

### 3.2 反面信号

Raycast v2 评估后否决了 WinUI 3，理由是 "still fairly young and not widely battle-tested" 以及微软 UI 框架反复废弃的历史，最终选了 **C# / .NET 8 / WPF** 作为 Windows 原生壳：https://www.raycast.com/blog/a-technical-deep-dive-into-the-new-raycast （2026-05-14，主笔已核对）。

### 3.3 推荐

- 默认路线：**C#（.NET 10 LTS）+ WinUI 3 / WinAppSDK 2.x**。Rust 核心编成 cdylib，经 uniffi-bindgen-cs 生成绑定。主要依据是 PowerToys 和 Files 已经用同一套组合上线。
- 第二阶段启动前做 2 周 PoC，候选三个：WinUI 3、WPF、GPUI。验收项：流式文本、长列表、中文 IME、讲述人（Narrator）、Mica。同时复查 windows-reactor 和 BoltFFI 的成熟度。
- 不选 C++/WinRT 写 UI：效率低，团队技能也不匹配。

---

## 4. 跨平台 Rust 原生 UI（单代码库备选）

| 框架 | 版本（日期） | a11y | IME | 生产案例 | 判断 |
|---|---|---|---|---|---|
| GPUI（官方 crate） | `gpui` 0.2.2（2025-10-22），此后没再发布 | main 分支已接 AccessKit，哪个稳定版开始包含【未确认】 | 有，CJK 边角问题多（Zed issues #9900、#15471、#52192） | Zed（1.0 于 2026-04-29 发布，当前 v1.28.1） | 唯一值得认真考虑的；README 写明 "pre-1.0… breaking changes" |
| gpui-pre（Longbridge 社区快照） | 0.3.12（2026-11-09） | 同上 | 同上 | Longbridge Pro | 实际可用的发布渠道 |
| gpui-component | 0.9.1（2026-11-09），Apache-2.0 | — | — | Longbridge Pro | 75+ 组件、虚拟列表、Markdown、代码编辑器 |
| Slint | 1.18.1（2026-09-21），GPLv3 / Royalty-free（桌面闭源可用）/ 商业授权 | 有 | 有 | 以嵌入式为主 | 流式富文本和跨块选择弱 |
| Iced | 0.14.0（2025-12-07） | **没有**（#552 从 2020 年开到现在） | 0.14 新增 | COSMIC | 缺 a11y，不适合商业产品 |
| Dioxus Native / Blitz | dioxus 0.7.10；blitz 0.3.0-beta.4（2026-10-16） | 列为目标 | — | 无 | beta |
| Makepad | crates.io 停在 1.0.0（2025-05-13） | 没有 | 2026-09 修过 macOS IME | 少 | 生态小 |
| egui | 0.37.0（2026-10-15） | AccessKit | 有 | 工具类软件 | immediate mode，观感像工具 |
| Xilem | 0.4.0（2025-10-29） | AccessKit 优先 | — | 无 | 研究阶段 |

版本来源：`https://crates.io/api/v1/crates/<name>`。GPUI 的说明：https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md 、https://www.gpui.rs/ （原文 "GPUI is tied to Zed"）。Slint 授权：https://slint.dev/pricing 。

**为什么第一版不选：**
1. 都是自绘，拿不到 Liquid Glass 和系统原生控件。GPUI 的窗口背景只有 Opaque、Transparent、Blurred、Mica 几种。“macOS 原生观感”是需求本身。
2. a11y 和中文 IME 都有已知短板，中文输入对 PiArc 是硬需求。
3. 原生菜单、Services、拖放、Quick Look、App Intents 都得自己桥接。
4. GPUI 官方 crate 一年没发布，发布渠道碎片化（gpui-pre、rgpui、open-gpui 等）。用它等于自己锁定某个 Zed commit，承担升级成本。

**什么时候考虑**：第二阶段做 Windows 时，如果团队偏 Rust、愿意锁定 Zed commit、能接受没有 Fluent 原生控件，可以用 GPUI + gpui-component 写 Windows 端，复用 Rust 核心，省掉 C# 这一层。

---

## 5. 高性能文本组件

### 5.1 Markdown

| 库 | 版本 / 时间 | 现状 |
|---|---|---|
| swift-markdown（swiftlang） | 0.9.0（2026-09-21），Apache-2.0 | 基于 cmark-gfm，只产出 AST，不支持增量解析 |
| Down | v0.11.0，最后 push 2023-07 | 实际已停止维护 |
| MarkdownUI（gonzalezreal） | 2.4.1（2024-10-13） | README 写明进入维护模式，新开发转到 Textual |
| Textual | 0.5.0（2026-06-15），MIT，要求 macOS 15+ | 基于 SwiftUI Text，支持选择；代码高亮用 JavaScriptCore 跑 Prism.js；README 没提流式 |
| microsoft/SwiftStreamingMarkdown | v0.7.0（2026-08-02），MIT，macOS 14+ | 每次输入完整文本快照，不是增量 |
| Apple `AttributedString(markdown:)` | macOS 12+ | SwiftUI Text 不渲染块级结构，只适合行内 Markdown |
| **pulldown-cmark**（Rust） | 0.13.6（2026-10-30） | 推荐用于 Rust 侧解析 |
| comrak（Rust） | 0.59.0（2026-11-12） | 完整 GFM，AST 更重 |

**推荐**：在 Rust 核心做块级增量解析。已经定稿的块冻结不再动，只重解析末尾那个块，并补齐未闭合的代码围栏。通过 FFI 下发三种操作：`appendBlock`、`replaceTail`、`finalize`，附带样式 span。会话流不使用任何 SwiftUI Markdown 库。

### 5.2 代码高亮

- **Rust 侧（推荐）**：tree-sitter 和 tree-sitter-highlight 都是 **0.27.2**（2026-11-07），MIT。输出是 `HighlightEvent` 事件流（字节偏移），支持语言注入。https://docs.rs/tree-sitter-highlight/latest/tree_sitter_highlight/
  - **坑**：传给 Swift 前必须把字节偏移转成 UTF-16 偏移，因为 NSString 用的是 UTF-16。
  - 备选 syntect 5.3.0，基于 TextMate 语法。
- **Swift 侧**：
  - SwiftTreeSitter 0.10.0（2026-03-18），已迁到 tree-sitter 组织。
  - Neon 最后的 tag 是 0.6.0（2024-01），仓库已转移，TextKit 2 支持不完整。
  - Highlightr 2.3.0 和 HighlightSwift 1.1.0 都依赖 JavaScriptCore 加 highlight.js，不适合大文件。

### 5.3 代码 / diff 查看器

- **STTextView 2.4.1**（2026-09-08）：TextKit 2，macOS 14+，最成熟。**许可证是 GPL-3.0 或付费商业授权**，闭源产品必须购买。https://github.com/krzyzanowskim/STTextView
- **CodeEditSourceEditor 0.15.2**（2025-09）：MIT，README 写明 "not ready for production use"。
- **CodeEditTextView 0.12.1**（2025-07）：CoreText 自绘，不支持 RTL。
- **推荐**：
  - 只读 diff：自己写 `NSTableView` 行视图，每行一条，配合 Rust 预先算好的行级和词级 span。天然虚拟化，能承载超大 diff。
  - 可编辑代码：第一版交给外部编辑器；以后真要做，再购买 STTextView 商业授权。

### 5.4 Rust diff

- **similar 3.2.1**（2026-10-24），Apache-2.0。支持 Myers、Patience、Histogram 算法，有词级行内 diff、`grouped_ops` 生成 hunk、3.2 新增的三方合并；3.2.1 提速明显（Myers 约 4 倍，Histogram 约 5 倍）。https://github.com/mitsuhiko/similar/blob/main/CHANGELOG.md
- **imara-diff 0.2.0**（2025-06），Apache-2.0。difftastic 和 deno 在用；gitoxide 用它的分支。
- 推荐默认用 similar，超大文件或需要和 git 行为一致时换 imara-diff。similar 3.2.1 之后两者还差多少，没有基准数据，【未确认】。

---

## 6. 终端嵌入

| 方案 | 版本 / 日期 | 许可 | 负责范围 | Windows | 来源 |
|---|---|---|---|---|---|
| **libghostty-vt** | 1.0 于 2026-11-06 发布；vt-1.0.1（2026-11-11） | MIT，依赖树里没有 copyleft | VT 解析、屏幕和回滚、输入编码、搜索和选择、Kitty 图形、带 dirty row 的 render state | 有：x86_64 DLL，MSVC 可通过 import lib 链接 | https://mitchellh.com/writing/libghostty-1-0 （主笔已核对），https://libghostty.tip.ghostty.org/group__render.html |
| GhosttyKit（完整 libghostty，含 Metal 渲染和 PTY） | 随 Ghostty 1.4.0（2026-10-27） | MIT | 完整 surface | 无 | 内部 API，`ghostty.h` "isn't a generally consumable libghostty"：https://mitchellh.com/writing/libghostty-is-coming |
| SwiftTerm | v1.99.3（2026-11-06） | MIT | 纯 Swift 引擎 + AppKit 视图 | 无 | https://github.com/migueldeicaza/SwiftTerm/releases （1.99 是 2.0 的过渡版，API 有破坏性改动） |
| alacritty_terminal | 0.26.0（2026-04-06） | Apache-2.0 | 终端状态 + tty | 有 | crates.io；Zed 用的是 fork 版 |
| portable-pty | 0.9.0（2025-02-11） | MIT | 跨平台 PTY，Windows 走 ConPTY | 有 | crates.io；main 分支有未发布的改动 |
| pty-process | 0.5.4（2026-10-19） | MIT | Unix PTY + tokio | 没看到 ConPTY 支持 | crates.io |

- libghostty 1.0 的 ABI 承诺：严格 semver；全部用 opaque handle；新头文件配旧库时返回 `GHOSTTY_UNSUPPORTED` 而不是崩溃；CI 用 libabigail 和 golden manifest 把关。
  - 产物：macOS 有 dylib 和 XCFramework，Windows 有 DLL、PDB 和静态库。
  - 点名的用户：JetBrains IDE、Neovim、KDE（实验中）、OrbStack、cmux 等。
- Ghostty 1.4.0 已放弃 Windows GUI，建议下游在 Windows 上用 libghostty：https://ghostty.org/docs/install/release-notes/1-4-0
- 第三方 macOS 应用已有在用的：cmux（Swift/AppKit，用 fork 的完整 GhosttyKit）：https://github.com/manaflow-ai/cmux ；生态清单：https://github.com/Uzaaft/awesome-libghostty
- libghostty-vt 的 Rust crate 0.2.2 发布于 1.0 之前，是否已对齐 1.0 ABI，【未确认】。建议直接对 C ABI 用 bindgen 生成绑定，或使用官方预编译产物。

**推荐**：
- Rust 核心用 portable-pty 管 PTY，用 libghostty-vt 持有终端状态，按 dirty row 把快照经 FFI 推给原生端绘制（macOS 先用 CoreText，之后可升级 Metal；Windows 用 DirectWrite）。
- 这样做有三个好处：ABI 稳定；Windows 阶段可以直接复用；终端缓冲区放在核心里，Agent 也能读到终端内容。
- 工作量：终端网格渲染、选择、IME 都要自己写，【估算】需要 3–6 周。v1 时间紧就先用 SwiftTerm 过渡。
- 构建：libghostty 用 Zig 构建，CI 需要装 Zig 工具链，或者直接用官方预编译产物。

---

## 7. Node 运行时作为 sidecar

### 7.1 Pi 本身的情况

- 运行要求 `engines.node >=22.19.0`。依赖以纯 JS 和 wasm 为主（photon、quickjs-wasi）。
- 包里附带一个 52KB 的 N-API 插件 `darwin-platform.node`，用于剪贴板和修饰键状态。
- 【实测】darwin-arm64 的 `pi` 可执行文件 103.0MB，tar.gz 48.1MB，签名是 adhoc + linker-signed，没有 TeamID。所以**必须自己从源码构建，再用 Developer ID 重签**。
- 可以用环境变量 `PI_PACKAGE_DIR`、`PI_CODING_AGENT_DIR`、`PI_SKIP_VERSION_CHECK`、`PI_SELF_UPDATE_COMMAND` 重定向资源和配置目录、控制自更新。**必须关闭 Pi 的自更新**：改动 .app 内容会破坏签名，Pi 版本应随 PiArc 一起走 Sparkle 更新。
- `pi install npm:...` 安装扩展依赖本机的 npm/pnpm/bun，扩展还可能带原生插件。这一项需要单独设计（见 7.3 的 `disable-library-validation`）。

### 7.2 三种运行时对比

| | Node SEA | **Bun --compile** | Deno compile |
|---|---|---|---|
| 最新版本 | Node 26.13.1 LTS（2026-11-10）、24.22.3 LTS；`--build-sea` 自 25.5.0 起提供 | 1.4.4（2026-10-22） | 2.9.8（2026-10-21） |
| 状态 | Stability 1.1；26.x 支持 ESM、`useCodeCache`/`useSnapshot`、实验性 VFS | 生产可用，Pi 和 Claude Code 的官方二进制都用它 | 可用，有 npm 兼容层 |
| hello 体积 | 【实测】node v26 可执行文件 147.4MB；第三方测 25.6.0 SEA 为 93MB | 【实测】89.2MB；第三方测 57MB | 第三方测 2.6.8 为 72MB |
| hello 冷启动 | 【实测】`node hello.js` 中位数 42ms；第三方 SEA 34.1ms | 【实测】中位数 21ms，RSS 8.4MB（node 为 42.6MB）；第三方 18.6ms | 第三方 32.4ms |
| 大型应用（claude-code） | — | 108MB / 510ms；加 `--bytecode` 后 190MB，启动没变快 | 183MB / 740ms |
| native addon | 必须先把 .node 从 assets 写到磁盘再 dlopen | 可直接 require，N-API 由 Bun 自己实现，"大多数"兼容 | 需要 `--self-extracting` |
| Pi 是否验证过 | 否 | **是**（CI 有 smoke test） | 否 |

- 第三方基准：https://notes.billmill.org/dev_blog/2026/02/updated_SEA_benchmarks.html （2026-02，没注明测试机器）。大型应用数据：https://yao-pkg.github.io/pkg/guide/vs-bun-deno （发布方是 pkg，有利益相关）。Node SEA 文档：https://nodejs.org/docs/latest-v26.x/api/single-executable-applications.html
- Pi 在 RPC 模式下“从启动到第一条 response”的耗时**没有实测**。PoC 时用 hyperfine 测。

**推荐**：sidecar 用 Bun 1.4.4 `--compile`，复用 Pi 官方的构建脚本。备选是普通 node 24/26 LTS 加 Pi 的 `dist/bundle/cli.js`：.app 里不需要单文件形态，SEA 只会多出约束。Deno 不选。

### 7.3 签名与公证

- 公证要求每个 Mach-O 都用 Developer ID 签名、开启 hardened runtime、带 secure timestamp，且不能有 `get-task-allow`。https://developer.apple.com/documentation/security/resolving-common-notarization-issues
- **坑：Node 官方二进制自带 `get-task-allow=true`**（【实测】v26.13.1，entitlements 见 https://github.com/nodejs/node/blob/main/tools/osx-entitlements.plist ）。直接嵌入会公证失败，必须用自己的 entitlements 重签。
- 参考样本【实测】：本机 Claude Code 二进制是 Bun v1.4.4 编译，319.6MB，签名 `Developer ID Application: Anthropic PBC`，开了 hardened runtime；entitlements 只有 `allow-jit`、`allow-unsigned-executable-memory`、`disable-library-validation`，外加 apple-events 和 audio-input。
- entitlements 应尽量少。Apple DTS 的意见是 JIT 的正规做法是 `MAP_JIT` 加 `allow-jit`，`disable-library-validation` 会削弱保护：https://developer.apple.com/forums/thread/707743 。建议的顺序：
  - 先只加 `allow-jit`，崩溃了再补 `allow-unsigned-executable-memory`。JSC 在只有 allow-jit 时能否正常运行，【未实测】。
  - 只有要加载第三方签名的 `.node`（用户装的扩展）时，才加 `disable-library-validation`。
- 放置位置（https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle ）：
  - 可执行文件放 `Contents/Helpers/`。
  - `.node` 和 dylib 放 `Contents/Frameworks/`。
  - wasm 和 theme 放 `Contents/Resources/`，用 `PI_PACKAGE_DIR` 指过去。
  - Pi 在这种分离布局下能否找到 native 插件，需要 PoC 验证。
- 手动注入 SEA（postject）要先 `codesign --remove-signature`；用 `--build-sea` 时，生成后再签名即可。

### 7.4 Mac App Store：不可行，只能 Developer ID 直发

- App Review Guidelines 2.4.5：MAS 应用必须沙盒化，不得下载额外代码。2.5.2：不得执行会改变功能的代码。https://developer.apple.com/app-store/review/guidelines/
- Apple DTS（Quinn）：子进程总是继承父进程的沙盒；App Review 要求包内所有代码都沙盒化。做终端类工具的建议是去扩展 Terminal。https://developer.apple.com/forums/thread/685544 、https://developer.apple.com/forums/thread/706390
- AI 编码 Agent 要在用户任意目录执行 git、npm、编译器等命令，这和 App Sandbox 根本冲突。
- 【实测】Claude.app 和 Cursor.app 都是 Developer ID 签名，没有 app-sandbox。Xcode 是 Apple 自家签名，属于豁免，不能当先例。
- **结论：只走 Developer ID 加公证直发。**

---

## 8. 沙箱与安全

### 8.1 macOS Seatbelt

- `man sandbox-exec` 标为 DEPRECATED；SDK 里 `sandbox_init` 标为 `API_DEPRECATED("No longer supported", macos(10.5, 10.8))`。
- 【实测】在 26.5.2 上，`/usr/bin/sandbox-exec` 拦截写入和出站网络都生效。
- Codex（rust-v0.169.0，2026-11-13）写死只用 `/usr/bin/sandbox-exec`：https://github.com/openai/codex （`codex-rs/sandboxing/src/seatbelt.rs`）。Claude Code 也依赖它（经由 srt）。
- **风险**：Apple 没有任何稳定性承诺。开了 App Sandbox 的宿主里能不能再套一层 Seatbelt，【未确认】；PiArc 本来就不开 App Sandbox，影响不大。

### 8.2 Anthropic sandbox-runtime（srt）

- npm `@anthropic-ai/sandbox-runtime` **0.0.83**（2026-11-13），Apache-2.0，标记为 Beta Research Preview。仓库 https://github.com/anthropics/sandbox-runtime ；是否从 anthropic-experimental 迁过来，【未核实】。
- 原理：
  - macOS：sandbox-exec 加动态生成的 Seatbelt profile，网络只允许连到本机代理端口。
  - Linux：bubblewrap 删掉网络命名空间，流量经 Unix socket 走宿主代理；seccomp 拦 Unix socket。
  - 网络：宿主侧起 HTTP 和 SOCKS5 代理，默认拒绝，按域名白名单放行，并拦截 loopback 和云元数据地址。
  - 文件系统：读默认放行，写默认拒绝。强制禁写的有 shell rc 文件、`.git/hooks`、`.git/config`、`.vscode/`、`.mcp.json` 等。
  - Windows 是 alpha：专用本地账户加 WFP 加 write-restricted token，需要一次管理员安装。
- 已知局限：可能被 domain fronting 绕过；代理不解析 TLS 内容；放行 `github.com` 就等于能推送到任意仓库。
- Claude Code 的沙箱就是建在 srt 上：https://code.claude.com/docs/en/sandboxing

### 8.3 Codex 与 Windows 原语

- Codex：Linux 默认用 bubblewrap 加 seccomp，Landlock 只作为旧实现保留。Windows 有三种实现：MXC（推荐，要求 Win11 24H2 build 26100.9278+）、elevated（建独立账户、加防火墙规则）、unelevated（restricted token 加 ACL）。https://learn.chatgpt.com/codex/windows/windows-sandbox ，设计文章：https://www.infoq.com/news/2026/06/codex-windows-sandbox-design/
- **Microsoft Execution Containers（MXC）在 2026-10-07 宣布 GA**。一份 JSON 策略可以跨平台用：Windows 后端是 AppContainer，macOS 是 Seatbelt，Linux 是 Bubblewrap；另有实验性的 MicroVM。MIT 许可，用 Rust 实现。
  - SDK：crates.io **`mxc-sdk` 1.1.0（2026-11-14，主笔已核对）**、npm `@microsoft/mxc-sdk` 1.1.0、NuGet `Microsoft.Mxc.Sdk`。
  - https://github.com/microsoft/mxc
  - 在 macOS 上的网络隔离能力，【未确认】。
- AppContainer 默认把文件、网络、进程都隔离，用来跑任意开发工具链摩擦很大。
- **Job Object** 不提供安全隔离，但 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 能保证宿主退出时清掉整棵进程树，sidecar 必须用它：https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects

### 8.4 凭据存储

- **macOS**：Apple TN3137（2026-09-24 更新）建议用 data protection keychain；file-based keychain 是 "on the road to deprecation"。
  - data protection keychain 的 access group 来自签名 entitlement，必须由 provisioning profile 授权。Developer ID 应用要嵌入 Developer ID provisioning profile 才能用：https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains ，https://developer.apple.com/forums/thread/826107
  - **推论：Node sidecar 这种独立二进制拿不到 data protection keychain。** 凭据应由 Rust 核心在进程内读出，再通过 RPC 交给 Pi。
- **Windows Credential Manager**：单条凭据上限 **2560 字节**（`CRED_MAX_CREDENTIAL_BLOB_SIZE`）。长 OAuth/JWT token 要分片存，或者只存一把 DPAPI 加密密钥。https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw
- **Rust keyring**：
  - `keyring` 4.2.0（2026-08-29）现在只是示例和 CLI 封装。作者要求应用改为依赖 **`keyring-core` 1.0.1**，再加具体的 store crate：`apple-native-keyring-store` 1.0.2（`protected` feature 对应 data protection keychain）、`windows-native-keyring-store` 1.1.0。
  - v3 最后一版是 3.6.3，用 `apple-native`/`windows-native` feature 选后端；v4 把后端拆成了独立 crate。

### 8.5 安全提醒（主笔补充，未验证）

**不要用环境变量把 API Key 传给 Pi。** Pi 执行的 bash 工具和它拉起的子进程会继承环境变量，除非 Pi 主动清理。建议通过 RPC 命令或受控的配置文件传递，并在 PoC 中确认 Pi 子进程的环境变量继承行为。

---

## 9. 分发与更新

### 9.1 macOS

- **Developer ID 加公证**：
  - 所有 Mach-O 都要签名、开 Hardened Runtime、带 `--timestamp`。
  - 2023-11-01 起只接受 `notarytool`，altool 已停用。
  - stapler 能钉 app、DMG、pkg，ZIP 和独立二进制钉不了。
  - https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
- **Sparkle 2.10.1**（2026-10-25）：
  - 2.10.0 把最低系统提到 macOS 12，并移除 CocoaPods。
  - 不要用低于 2.9.6 的版本：2.9.5 和 2.9.6 修了 symlink 和提权相关的安全问题。
  - 签名用 EdDSA（`SUPublicEDKey`），2.9 起校验 feed 签名；`generate_appcast` 自动生成 delta。
  - 支持 `sparkle:hardwareRequirements`（arm64）、分阶段发布、channel。
  - 非沙盒应用可以删掉 Installer XPC service。
  - https://github.com/sparkle-project/Sparkle/releases ，https://sparkle-project.org/documentation/sandboxing/
- **DMG 体积【实测】**：

| 内容 | 原始大小 | UDZO | ULFO | ULMO |
|---|---|---|---|---|
| Node 24.14.1 arm64 | 119.2MB | — | 39.4MB | **29.0MB** |
| Node + Bun 1.4.4 | 207.8MB | 86.9MB | 78.5MB | **58.0MB** |

  - ULMO 要求 macOS 10.15+，解压比 ULFO 慢（拷出 node：ULFO 0.38s，ULMO 1.57s）。不指定 `-size` 时 ULMO 会报错，需要加 `-size`，或者先建 UDRW 再 convert。
  - `strip -x` 能把 node 减小约 20%，但会让签名失效；对 Bun 产物的影响【未验证】。
  - 【估算】PiArc 的 arm64 DMG 包含 Swift 壳、Rust 核心、Bun 编译的 Pi（约 100MB）和 libghostty。ULMO 压缩后大约 40–60MB，sidecar 占大头。对比：Claude Desktop 621MB，Cursor 971MB（【实测】安装后大小）。

### 9.2 Windows

- **Velopack 1.2.161**（2026-09-29，MIT）：
  - SDK 有 C#、Rust、C++、JS。
  - Setup.exe 安装到 `%LocalAppData%`，不弹 UAC。
  - delta 更新用 zstd 按文件打补丁。
  - 1.3 起可以在 macOS/Linux 上直接做 Azure 签名。
  - https://docs.velopack.io/
- **Squirrel.Windows** 已停滞（最后一版 2.0.1，2020-09），继任者就是 Velopack。
- **WinGet**：客户端 v1.29.380，可以作为发布渠道。
- **MSIX 暂不作为主渠道**：
  - full trust 应用可以拉起任意 exe，但 AppData 下新建的文件和 HKCU 写入会被虚拟化，子进程看到的路径和宿主不一致。
  - Claude Desktop 的 MSIX 版正好踩过：扩展目录被重定向，外部 Python 进程找不到文件。https://github.com/anthropics/claude-code/issues/47977 ，https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes
- **代码签名**：
  - Azure Artifact Signing（原 Trusted Signing）：Basic $9.99/月，Premium $99.99/月。
  - **组织可用地区不包含中国大陆**，个人开发者只限美国和加拿大；两个官方页面列出的地区不一致。签名主体在大陆的话，需要买 OV 证书，私钥放 HSM。
  - https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
  - 2026-03-01 起证书最长有效期 460 天。EV 证书不再能直接跳过 SmartScreen。

---

## 10. 同类应用技术栈与经验

| 应用 | UI | 核心 / Agent 通信 | Windows | 来源 |
|---|---|---|---|---|
| Zed | GPUI（Rust 自绘） | 外部 Agent 走 **ACP**（JSON-RPC over stdio，子进程）；ACP 的 Rust SDK `agent-client-protocol` 5.3.0，TS SDK `@agentclientprotocol/sdk` 2.7.0 | 2025-10-15 稳定版（DirectX 11 + DirectWrite） | https://zed.dev/blog/zed-for-windows-is-here ，https://zed.dev/blog/zed-1-0 |
| Warp | 自研 Rust UI（只用矩形、图片、字形三种图元，Metal） | — | 2025-02 GA；客户端 2026-04 以 AGPL-3.0 开源 | https://www.warp.dev/blog/how-warp-works ，https://github.com/warpdotdev/warp |
| Ghostty | Zig 共享核心；macOS 用 Swift/AppKit/SwiftUI + Metal；Linux 用 GTK | libghostty C API | 已放弃 Windows GUI | https://github.com/ghostty-org/ghostty |
| **OpenAI Codex App** | **Electron** | `codex app-server`（Rust），JSONL over stdio，类 JSON-RPC；可用 `generate-ts`/`generate-json-schema` 生成类型 | 2026-03 | https://www.devclass.com/development/2026/02/05/traditional-ides-not-the-right-tool-for-development-with-agentic-ai-openai-claims/4090132 （原话 "built the app in Electron specifically so we can support Windows and Linux"），https://developers.openai.com/codex/app-server |
| ChatGPT macOS | 2024 版据报道是原生；2026 年第三方扫描显示和 Codex 是同一个 Electron 包 | — | 说法冲突 | https://allenpike.com/2025/why-is-chatgpt-so-good-claude/ ，https://desktopinsights.com/apps/chatgpt 【据报道，倾向已转 Electron，未确认】 |
| Claude Desktop | Electron（【实测】5.1231.2，Electron 45.2.1，621MB） | — | 有 | 本机 |
| Cursor | VS Code fork / Electron（【实测】3.30.14，Electron 43.8.9，971MB） | — | 有 | 本机 |
| Windsurf | VS Code fork；2026-06 据报道更名为 Devin Desktop | — | 有 | 【据报道】 |
| **Raycast** | v1：AppKit；**v2（2026）：原生壳 + WKWebView/WebView2 + React** | 见下 | v2：C#/.NET 8/WPF | 见下 |

### 10.1 Raycast 详解

**v1**（2023-05-31，https://www.raycast.com/blog/how-raycast-api-extensions-work ）
- Node 不打进安装包，以免 "bloat the app size with each release"。首次使用扩展前自动下载 Node，每次启动做完整性校验。
- 进程模型：一个 Node 子进程，每个扩展命令跑在一个 worker thread（V8 isolate）里。每个 worker 有堆内存上限，超限直接终止；worker 崩溃只显示错误页，主程序不受影响。
- 通信：**JSON-RPC over stdio**，Swift 侧用 DispatchIO 实现，基于 Apple 语言服务器实现中的一部分。只接受白名单消息（如 `render`、`setClipboard`），用串行队列处理竞态。
- UI：自定义 React reconciler 把组件序列化成 JSON 渲染树，增量更新用 JSON Patch 传，超过一定大小才 gzip。Swift 侧生成 view model，交给自定义 AppKit 组件渲染。SwiftUI 因崩溃率和性能问题被否决；更早的 XPC + JavaScriptCore 方案已放弃。
- 安全：没做进程级沙箱（sandbox-exec 不支持第三方使用，每个扩展一个进程成本太高），靠扩展开源加人工审核。

**v2**（2026-05-14，https://www.raycast.com/blog/a-technical-deep-dive-into-the-new-raycast ，主笔已核对）
- 架构分四部分：
  - 各平台原生壳：macOS 是 Swift/AppKit，Windows 是 C#/.NET 8/WPF。
  - 共享的 React/TS 前端，跑在系统 WebView 里。原文："We're a native app that uses web for its UI"。
  - **一个常驻 Node 进程**，承载业务逻辑、数据库和扩展运行时。
  - Rust：文件索引器（独立进程）、与 iOS 共享的数据层、同步 schema。
- **Node 改为随包分发**，用户不再需要首次下载。
- IPC："a mix of platform message handlers and stdio transport"。接口在一处声明，为各端生成类型化客户端。
- 内存：v1 约 200–300MB，v2 约 350–450MB。v2 中 WebView 120–200MB，Node 后端 150–200MB，Swift 壳约 40MB。
- 否决的方案：
  - WinUI 3：太年轻，加上微软的历史。
  - 两套原生 UI："twice the work without moving any faster"。
  - Electron：不想在 macOS 上捆绑 Chromium。
  - Tauri：太年轻。
  - SwiftUI：性能和控制力不够。
- 体积：第三方扫描显示 2.12.1 的 macOS 包约 245MB：https://desktopinsights.com/apps/raycast 【据报道】。

### 10.2 对 PiArc 的启示

1. **Raycast v1 的进程管理模式可以照搬**：原生宿主监管 Node、stdio 上跑行协议、方法白名单、增量 patch、超过阈值再压缩、崩溃隔离。区别在隔离粒度：Pi 是长时间运行、会执行工具的 Agent，**建议每个会话（或每个工作区）一个 Pi 进程**，而不是 Raycast 的 worker thread。Pi 的 RPC 模式本来就是一个进程对应一个会话。
   - 内存【估算】：Raycast 的数据是 Node 后端 150–200MB；Bun 的基础 RSS 更低，实际要按 Pi 跑真实会话实测。
2. **随包分发并签名 sidecar**。Raycast 也从首次下载改成了随包。
3. **只维护一份协议 schema，生成 Rust、Swift、C#、TS 各端的类型**（Raycast v2 和 Codex 的 `generate-ts` 都这么做）。PiArc 的宿主协议可以评估两条路：直接对接 Pi 原生的 JSONL RPC（最省事），或者让 Rust 核心对外暴露 ACP（以后能接入其他 Agent，和 Zed 生态兼容）。建议 v1 由 Rust 核心对接 Pi 的 RPC，内部事件模型保持中立，不急着上 ACP。
4. **代价要提前看清**：Codex、Claude、Cursor、Raycast v2 都转向了 Web UI，理由都是跨平台速度和富文本的难度。PiArc 选的是 Ghostty 模式（共享核心、各平台原生 UI），要维护两套 UI，且长文本渲染工程量大。这是有意的取舍，前提是原生体验确实构成产品差异化。

---

## 11. 推荐整体架构

```
PiArc.app (Developer ID, Hardened Runtime, 非沙盒)
├─ Contents/MacOS/PiArc            Swift 6 App
│   ├─ SwiftUI：窗口 / 侧边栏 / 设置 / toolbar / Liquid Glass
│   └─ AppKit：会话流 NSTableView + TextKit 2、diff 行视图、终端视图(CoreText→Metal)
│        ↑↓ UniFFI 0.32.x（生成代码独立模块，Swift 5 模式；事件 16ms 合并）
├─ Rust core（staticlib / XCFramework）
│   ├─ sidecar 管理：spawn / 监管 / 重启 pi（--mode rpc，严格 JSONL over stdio，LF 分帧）
│   ├─ Markdown 增量块解析（pulldown-cmark）、tree-sitter-highlight、similar diff → UTF-16 span
│   ├─ PTY（portable-pty）+ libghostty-vt 1.0（dirty row 快照）
│   ├─ 凭据（keyring-core + apple-native-keyring-store protected）
│   └─ 沙箱策略（Seatbelt profile + 本地域名代理；评估 MXC / srt）
├─ Contents/Helpers/pi             Bun 1.4.4 --compile，Developer ID 重签，allow-jit（按需最小增补）
├─ Contents/Frameworks/            darwin-platform.node 等 native addon（单独签名）
└─ Contents/Resources/             Pi 的 wasm / theme（PI_PACKAGE_DIR 指向这里）
更新：Sparkle 2.10.x（EdDSA + delta，按架构分 feed）；分发：DMG(ULMO)
Windows 第二阶段：C# WinUI 3（或 WPF / GPUI，PoC 决定）+ uniffi-bindgen-cs + 同一 Rust core
                  + Job Object + MXC + Velopack + WinGet
```

### 11.1 建议的 PoC 清单（正式开工前）

1. **流式文本 spike**（1–2 周，**决定性**）：NSTableView + TextKit 2，10 万 token 流式输出、1 万条消息滚动、跨块选择复制、中文 IME、VoiceOver。验收指标是 CPU 和内存。
2. **Sidecar spike**：从源码构建 Pi，用 Developer ID 签名公证；验证最小 entitlements 集合、`PI_PACKAGE_DIR` 下的分离布局、Pi RPC 冷启动耗时（hyperfine）、单会话内存、子进程环境变量继承。
3. **FFI spike**：UniFFI 0.32.2 + Swift 6 宿主（生成代码用 Swift 5 模式）、async foreign trait 事件回调、取消、`&[u8]` 吞吐。
4. **终端 spike**：libghostty-vt XCFramework 和 portable-pty 的接入，以及 CoreText 网格渲染的工作量评估。
5. **沙箱 spike**：用 srt 或 MXC 1.1.0 在 macOS 上包住 Pi 的 bash 工具；测网络白名单和写保护。

---

## 12. 不确定项汇总

- Liquid Glass 在 macOS 27 SDK 下无法退出：Apple 只在 iOS 场景下明确确认过。
- macOS 15.x 的装机占比（TelemetryDeck 没有汇总）。
- ChatGPT macOS 当前是否已转 Electron；“WinUI 3 更名”；Windsurf 更名 Devin Desktop：都是二手来源。
- GPUI 从哪个版本开始包含 AccessKit；windows-reactor 对文本密集型控件的覆盖情况。
- libghostty-vt 的 Rust crate 0.2.2 是否对齐 1.0 ABI。
- JSC（Bun）在只有 `allow-jit` 时能否正常运行；Pi 在分离布局下能否找到 native addon；Pi RPC 冷启动耗时和单会话内存。
- MXC 在 macOS 上的网络隔离能力；App Sandbox 宿主内嵌套 Seatbelt。
- similar 3.2.1 和 imara-diff 的性能差距。
- BoltFFI 的生产用户和 foreign trait 支持情况。
- 1Password 的具体 FFI 序列化格式。
- Azure Artifact Signing 可用地区（两个官方页面不一致）。
