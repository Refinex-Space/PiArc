# 参考源码

仓库根目录的 `reference/` 下有五个参考仓库的只读副本（已加入 `.gitignore`，清单、固定版本与复现方法见 [`docs/research/REFERENCES.md`](../research/REFERENCES.md)）。它们是"可以查阅的经验"，不是"可以照搬的答案"：架构设计已经定下方向，参考的目的是少走弯路、看清别人踩过的坑。

## 使用方法

**先定问题，再去看。** 带着具体问题查阅。例如"Pi 的 `tool_call` 事件在 handler 抛异常时如何处理"，而不是泛泛地"看看别人怎么做"。

查到之后按三步处理，结论写进任务报告或相关 ADR：

1. **分析**：它解决的问题与我们的是否相同？它的前提在我们这里是否成立？例如单进程 CLI、终端界面、只有一个会话。
2. **评估**：采纳、改造后采纳、不采纳，各给一句理由。与架构设计或 ADR 冲突的，不采纳。
3. **记录**：采纳或改造采纳的，在代码注释或提交说明里注明出处（仓库、路径、版本），以及改造了什么、为什么。

**禁止**：

- 为了"参考过"而把不需要的东西加进来；
- 复制 `claude-code` 中的任何代码或提示词原文；
- 复制 `OpenClaudeDesktop` 中的界面组件。尤其是 `app/src/generated/` 下由生成器从官方应用切出的文件，改写后也不行；
- 使用 `open-claude-ui` 的视觉组件与设计令牌（它们还原的是 Claude 的外观）；
- 未注明出处地复制其他仓库中的非平凡代码。复制的代码必须符合原许可证。

## 仓库清单

| 仓库 | 路径 | 许可证 | 适合查什么 | 注意 |
|---|---|---|---|---|
| Pi | `reference/pi` | MIT | SDK 与扩展 API 的真实签名和行为；会话 JSONL；压缩；工具与 Operations；pi-ai 的服务商与线格式；pi-mcp | **以 PiArc 锁定的版本为准**，见下节 |
| claude-code（社区复原） | `reference/claude-code` | 无许可证，原为 Anthropic 专有软件 | Harness 机制：主循环、工具并发、压缩、权限判定顺序、hooks、子 agent。已提炼的要点见 `docs/research/harness-reference-notes.md`，优先读它 | **只学机制，禁止复制任何代码和提示词**。社区版有魔改，行为以官方文档（`docs/research/claude-official-capabilities.md`）为准 |
| claw-code | `reference/claw-code` | MIT | Rust 侧的 crate 划分、窄 trait 隔离 I/O、权限阶梯、parity 测试方法；以及它的反面教训 | 实验项目，质量参差，教训见 `harness-reference-notes.md` 第 2 节 |
| OpenClaudeDesktop | `reference/OpenClaudeDesktop` | 声明 MIT，但含官方应用切出的组件 | 信息架构、交互流程、Electron 宿主层结构、UI 与内核之间的协议语义（Codex app-server v2 风格） | 前端可研读对应源码并测量渲染结果，逐项复刻视觉和交互，由 PiArc 独立实现（ADR-0073）。已提炼的要点见 `docs/research/ui-reference-notes.md` |
| open-claude-ui | `reference/open-claude-ui` | MIT | 交互物理：滚动跟随、输入法守卫、拖拽死区、悬停意图、动效参数 | 只复用交互逻辑（MIT，注明出处），不用视觉组件与令牌 |
| ego-lite | `reference/ego-lite` | MIT | 智能体浏览器 SDK（`package/ego-browser/src`）、原生绑定与快照规格（`docs/`）、使用说明（`package/ego-browser/skill-body/SKILL.md`） | 按 ADR-0091 移植到 `apps/desktop/src/browser-host/sdk/`，保留版权与上游提交；浏览器本体闭源，快照自写 |
| VS Code（integrated browser 部分） | `reference/vscode`（稀疏：`src/vs/platform/browserView`、`src/vs/workbench/contrib/browserView`） | MIT | 浏览器级 CDP 代理（`common/cdp/proxy.ts`）、WebContentsView 宿主、遮挡占位、分区与网络过滤、设备模拟 | CDP 代理可按 MIT 改编并注明出处；其余只学机制 |
| Playwright（injected 部分） | `reference/playwright`（稀疏：`packages/injected`、`packages/playwright-core/src/tools`） | Apache-2.0 | ARIA 快照与 ref 稳定性、可操作性检查、MCP 工具设计 | 只学机制；复制需保留 NOTICE |
| chrome-devtools-mcp | `reference/chrome-devtools-mcp` | Apache-2.0 | 智能体的 console、network、性能 trace、模拟工具在纯 CDP 上的做法 | 只学机制 |
| react-grab、bippy | `reference/react-grab`、`reference/bippy` | MIT | 元素 → 组件栈 → 源码位置（React 18/19、source map） | 逻辑可按 MIT 改编并注明出处 |
| ZCode | `reference/ZCode` | Apache-2.0 | 内置浏览器的踩坑记录（`docs/browser-use/`）、元素上下文、权限治理、本地 HTML 协议 | 只学机制；不走 `<webview>` 路线 |
| PI-Desktop | `reference/PI-Desktop` | LGPL-3.0-or-later | WebContentsView 后台宿主、CDP 白名单与超时恢复 | **只学机制，不复制代码**（LGPL 义务） |

## 读 Pi 的锁定版本

PiArc 锁定的 Pi 版本是 v1.5.2（T06，`agent-host/package.json`），`reference/pi` 检出同一 tag（`b4afddd`）。读 Pi 时：

1. **首选**已安装的包：`node_modules/@earendil-works/<包名>/` 下的 `dist/` 与类型声明，这就是实际运行的代码。
2. **其次**参考仓库的对应 tag：先 `git -C reference/pi fetch --tags`，再用 `git -C reference/pi show <tag>:<路径>` 读文件、`git -C reference/pi grep <模式> <tag> -- <目录>` 搜索。
3. **不要**直接读 `reference/pi` 工作区的文件，除非已经确认它检出的就是锁定版本。

`docs/research/pi-v1.4.0-baseline.md` 第 0–11 节的文件:行号针对 v1.4.0，文末"版本差异：v1.5.2"一节针对锁定版本。两者不同时，以锁定版本的源码为准，并按执行协议的"决策分级"处理差异。

## 按主题的查阅指引

| 你在做 | 先看 |
|---|---|
| Pi 的 SDK、扩展事件、工具与 Operations | Pi 锁定版本（见上节），`pi-v1.4.0-baseline.md` |
| 权限判定顺序、hooks 决策协议、子 agent 行为 | `claude-official-capabilities.md`（官方行为），`harness-reference-notes.md`；需要细节时再看 claude-code（只看机制） |
| 压缩摘要的结构与保留策略 | `harness-reference-notes.md` 1.4、Pi 的压缩实现 |
| Rust crate 的边界与测试替身 | claw-code（注意它的反面教训） |
| 宿主注入工具（任务清单、下一步）、UI ⇄ 内核协议语义 | `ui-reference-notes.md` 第 4、5 节；OpenClaudeDesktop 的宿主层（只看思路） |
| 滚动跟随、输入法守卫、拖拽与悬停的交互参数 | `ui-reference-notes.md` 第 2、3、7 节；open-claude-ui 的交互逻辑 |
| Electron 安全、fuses、打包与更新 | `docs/research/electron-stack.md` 与 Electron 锁定版本的官方文档 |
| 终端（libghostty-vt、帧协议、渲染器） | `docs/research/terminal-libghostty.md`、ADR-0017、libghostty-vt 官方文档 |
