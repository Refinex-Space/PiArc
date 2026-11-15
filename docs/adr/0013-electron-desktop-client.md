# 0013. 桌面客户端改用 Electron + React，macOS 与 Windows 同一代码库推进

- 状态：已接受
- 日期：2026-11-14
- 取代：[ADR-0001](0001-three-tier-native-architecture.md)、[ADR-0007](0007-macos-ui-swiftui-appkit.md)
- 相关：架构文档第 1、3、8、11、15、16 章；`docs/research/electron-stack.md`、`docs/research/native-stack.md` 第 10 章

## 背景

ADR-0001 和 ADR-0007 选择了各平台原生客户端（macOS 用 SwiftUI + AppKit，Windows 第二阶段另写），前提是原生体验构成产品差异化，并接受三项代价：两套 UI、Windows 推迟到 macOS 落地之后、原生流式长文本渲染（风险 R1）。

2026-11-14 产品负责人调整了目标：macOS 与 Windows 同步推进，客户端参照 Claude Desktop 的做法，用 Electron + React 加原生模块。决策依据的事实：

- **同类产品的选择。** Claude Desktop 5.1231.2（本机实测）使用 Electron 45.2.1，内置 Node v24.22.1，Electron 框架 250 MB，整个应用 621 MB。OpenAI 说明 Codex App 选 Electron 是 "specifically so we can support Windows and Linux"。Raycast v2 改为"原生壳 + 系统 WebView + React"，理由是两套原生 UI "twice the work without moving any faster"（`native-stack.md` 第 10 章）。
- **PiArc 本来就要带 JS 运行时。** Pi 只能运行在 Node ≥ 22.19 中，原方案为此内置 119 MB 的 Node（ADR-0003），"比 Electron 小"的优势本来就打了折扣。决策时曾预期 Agent Host 可以复用 Electron 自带的 Node，从而只多出 Chromium；后续调研表明 Electron 自带的 Node 无法满足沙箱、stdio 与 npx 的要求，Agent Host 仍单独内置 Node（ADR-0015）。因此相对原方案的实际增量是整个 Electron 框架（arm64 约 250 MB 安装后体积），新的体积与内存预算见架构文档第 11 章。
- **R1 是原方案最大的技术风险。** 有开发者依次试过 SwiftUI、TextKit 2、NSCollectionView 后改用 Electron；Raycast 也把"富文本和 Markdown 更简单"列为转向 Web 的收益之一。Web 端的 Markdown、代码高亮、公式、富文本输入框都有成熟实现。
- **参考实现同构。** OpenClaudeDesktop 的宿主层用 Electron 44.4.3 + React 19.3 + Vite 8.3，依赖 shiki、xterm.js、ProseMirror、micromark、node-pty，证明这套组合能承载同形态的产品。它的界面组件切自官方应用，不可复用（ADR-0006）。

## 决策

1. **保留三层结构，替换客户端层的技术。** 客户端 / PiArc Core / Agent Host 的分工、厚核心原则、控制面在 Core（ADR-0004）、AHP（ADR-0009）全部不变。客户端层改为 Electron：

   | 部分 | 技术 | 职责 |
   |---|---|---|
   | 主进程 | TypeScript | 窗口、菜单、托盘、通知、深链接、文件关联、更新；加载 Core（ADR-0014）；把 Core 的事件转发给渲染进程。不承载业务逻辑。 |
   | preload | TypeScript | 用 `contextBridge` 暴露一组最小的类型化 API，除此之外渲染进程拿不到任何主进程能力。 |
   | 渲染进程 | React + TypeScript，Vite 构建 | 全部界面。开启 `sandbox` 与 `contextIsolation`，不启用 Node 集成，不加载远程内容。 |

2. **业务逻辑的位置不变。** 主进程的 TypeScript 只做平台集成和转发，渲染进程只做呈现与输入。凡是两个平台都要的逻辑，放进 Core 或 Agent Host，不放进主进程或渲染进程。
3. **一个代码库、一条 CI 覆盖两个平台。** 每个里程碑由 macOS 先达到退出标准，Windows 最迟在下一个里程碑结束前达到同样的标准；Beta 要求两个平台同时达标。
4. **平台专属能力用原生模块补充。** 例如 macOS 的 Quick Look 预览、App Intents，Windows 的跳转列表。用 Rust（经 NAPI-RS）或平台语言编写，按需加入，不作为界面主体。
5. **渲染进程的基础选型。** 长列表虚拟化；Markdown 解析与代码高亮放在 Web Worker 中，不占用界面线程；composer 基于 ProseMirror；终端见 ADR-0017。具体库与版本在 M0 选定并精确锁定。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 维持原生方案（ADR-0001、ADR-0007） | 启动、内存最优；"原生"可以作为卖点 | 两套 UI；Windows 推迟；R1 风险 | 否决：不满足双平台同步推进 |
| Tauri 2 + React | 体积最小；Rust Core 可在同一进程内直接调用 | macOS 用 WebKit、Windows 用 Chromium 内核的 WebView2，输入法、滚动、字体要测两遍；Pi 仍需单独带 Node；Raycast 2026 年评估时认为它"太年轻" | 否决；若体积和内存成为首要约束，它是第二选择 |
| 各平台原生薄壳 + 系统 WebView（Raycast v2 做法） | 不带 Chromium；系统集成最好 | 要维护 Swift 与 C# 两个原生壳，IPC 多一层，对团队规模要求高 | 否决 |
| GPUI、Slint 等 Rust 跨平台 UI | 单代码库，全 Rust | 中文输入法、无障碍有短板；生态小；富文本要自己做 | 否决 |

## 后果

- 正面：
  - 一套界面同时服务 macOS 与 Windows；
  - R1 不复存在；
  - 可以直接使用 Web 生态的成熟组件，参考实现的交互算法能在同一种语言里对照；
  - 前端人才更容易找。
- 负面与代价：
  - 失去"原生、轻量"卖点。对外不再宣称原生或比 Electron 轻，差异化放在 Harness 深度、多模型、工作区共享 MCP 与确定性回退；
  - 内存、启动、安装包预算放宽（架构文档第 11 章）；
  - 新增一类安全风险：模型输出在 Chromium 中渲染，提示词注入可能变成 XSS。必须按架构文档第 10.3 节加固；
  - Chromium 大约每 8 周一个大版本，安全更新需要持续跟进。
- 需要配套做的事：ADR-0014（Core 绑定）、ADR-0015（Agent Host 运行时）、ADR-0016（分发与更新）、ADR-0017（终端）；架构文档第 8 章改写为桌面客户端设计，Windows 路线并入主线里程碑。

## 重新评估的触发条件

- 实测内存或启动时间超出第 11 章预算 30% 以上，且优化后仍无法达标；
- 威胁模型中的某项对策必须放松 Electron 安全基线（例如必须在渲染进程开启 Node 集成）才能实现；
- 双平台同步导致 macOS 里程碑连续两次延期，此时考虑把 Windows 改为固定滞后一个里程碑的跟随模式。
