# 0007. macOS 客户端：SwiftUI 外壳 + AppKit/TextKit 2 承载高性能视图

- 状态：已取代（2026-11-14 被 [ADR-0013](0013-electron-desktop-client.md) 取代）
- 日期：2026-11-14
- 相关：架构文档第 8 章；`docs/research/native-stack.md` 第 1、5、6 章

## 背景

- 会话流需要承载流式 Markdown、代码块、diff、工具卡片，单个会话可能上万行、十万级 token。
- SwiftUI 在这类场景有已知问题：`ScrollView + LazyVStack` 配合 `scrollTo` 会出现布局死循环；`Text` 不能跨视图选择（原生技术栈调研 1.3 节）。Raycast v1 因性能和崩溃率否决了 SwiftUI，转向自定义 AppKit 组件。
- Liquid Glass 的 API（`glassEffect`、`NSGlassEffectView` 等）全部要求 macOS 26.0+。macOS 27 已于 2026-09 发布且只支持 Apple silicon；macOS 26 是最后一个支持 Intel 的版本。TelemetryDeck 2026-11 数据中 26 及以上约占 87%（样本偏开发者）。
- STTextView 是 GPL/商业双许可，CodeEdit 系列组件自述未到生产可用。

## 决策

1. **最低系统版本 macOS 26。** arm64 为一等公民；Intel 单独出包，是否继续支持按升级统计数据决定。不做 Universal 包（会让内嵌 Node 体积翻倍）。
2. **SwiftUI 负责外壳**：Scene 与窗口、`NavigationSplitView` 侧栏、toolbar、inspector、设置（`Settings` 场景）、sheet、表单、Liquid Glass 材质。
3. **AppKit 负责高性能视图**，通过 `NSViewRepresentable` / `NSViewControllerRepresentable` 嵌入：
   - 会话流：view-based `NSTableView`（单元复用、行高缓存），每种行类型一个原生视图（正文、代码块、diff、工具卡、审批卡、子 agent 卡）；
   - 正文：只读 `NSTextView`（TextKit 2）。流式只修改最后一行的 `NSTextStorage`，主线程以 30–60 Hz 合并刷新；
   - diff 视图、文件查看器：自研（基于 TextKit 2），不引入 GPL 组件；
   - 终端：见第 4 条。
4. **终端**：PTY 由 Core 中的 `portable-pty` 管理；终端仿真用 libghostty-vt（1.0，2026-11-06 发布，MIT，稳定 C ABI，提供 XCFramework 与 Windows DLL），渲染层自研。M2 之前可以用 SwiftTerm 过渡。
5. **Markdown 解析、代码高亮、diff 计算都在 Core 完成**（pulldown-cmark、tree-sitter-highlight、similar），以"块 + 样式 span"的形式下发，客户端只负责排版和绘制。偏移在 Core 中统一转换为 UTF-16，避免 Swift 侧重复换算。
6. 平台惯例优先：原生标题栏 + `NSToolbar`、`NSMenu` 右键菜单、source list 侧栏、`NSSplitViewController` 分栏、系统快捷键约定、Reduce Motion / 高对比度 / VoiceOver 适配。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 纯 SwiftUI | 代码量最少 | 长列表和流式文本有已知性能与选择问题 | 否决 |
| 纯 AppKit | 性能最可控 | 设置、表单、玻璃材质等开发效率低 | 否决 |
| 消息区用 WKWebView | 富文本和 Markdown 最好做 | 触碰"排除 Web 技术"的产品边界 | 仅作为风险 R1 的退路，启用前须产品负责人决定 |
| 最低版本 macOS 15 | 覆盖更广 | 需要维护两套视觉方案，UI QA 翻倍 | 否决 |

## 后果

- 正面：滚动、选择、输入法、无障碍都走系统实现；性能问题可以逐个定位到具体视图。
- 负面与代价：跨块选择、"复制整条消息"要自己实现；SwiftUI 与 AppKit 的桥接需要明确的状态归属规则（架构文档第 8.3 节）。
- 需要配套做的事：M0 用 1–2 周验证流式渲染（10 万 token 流式、万条消息滚动、跨块选择、中文输入法），达不到预算时启动风险 R1 的决策流程。

## 重新评估的触发条件

- M0 流式渲染验证失败；
- SwiftUI 修复上述长列表与文本选择问题，并经实测达到预算。
