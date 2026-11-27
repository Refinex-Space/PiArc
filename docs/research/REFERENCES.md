# 参考源清单（References）

PiArc 在设计阶段研读了以下开源仓库。为了随时查阅和核对，本地在仓库根目录的 `reference/` 下各放一份只读副本。该目录已写入 `.gitignore`，不进入版本库。

## 清单

| 目录 | 上游 | 固定版本 | 许可证 | 用途 |
|---|---|---|---|---|
| `reference/pi` | https://github.com/earendil-works/pi | `b4afdddf44e0`（v1.5.2，与 `agent-host` 锁定的 npm 版本一致；设计阶段调研用的是 v1.4.0 `4a080252f06c`） | MIT | Agent 底座。SDK、扩展 API、RPC、会话格式、多服务商层。PiArc 以 npm 依赖方式使用，不 fork。 |
| `reference/claude-code` | https://github.com/claude-code-best/claude-code | `963e0013184e` | 仓库无 LICENSE 文件；原作为 Anthropic 专有软件，见下文"使用边界" | 社区复原的 Claude Code 工程。用于理解 Harness 设计思路：主循环、工具、权限、hooks、子 agent、上下文工程。 |
| `reference/claw-code` | https://github.com/ultraworkers/claw-code | `508b4d862d42` | MIT | 用 Rust 复刻 Claude Code Harness 的实验项目。参考 crate 划分、mock 服务与行为对齐测试方法。 |
| `reference/OpenClaudeDesktop` | https://github.com/oleyyu/OpenClaudeDesktop | `62f08512e012` | 仓库声明 MIT，但含官方应用切出的组件，见下文 | Claude Desktop Code 界面复刻（Electron 44.4.3 + React 19.3 + Vite 8.3）。参考信息架构、交互流程、Electron 宿主层结构，以及 UI 与内核之间的协议（Codex app-server v2）。 |
| `reference/open-claude-ui` | https://github.com/Caho1/open-claude-ui | `be395eb4b783` | MIT | 逆向还原的 Claude 设计系统与交互物理。参考令牌结构、动效参数、滚动跟随、IME 守卫等工程经验。 |
| `reference/ego-lite` | https://github.com/citrolabs/ego-lite | `56589ea8b98f` | MIT | 智能体浏览器 SDK 与使用说明，内置浏览器的移植来源（ADR-0091）。 |
| `reference/vscode` | https://github.com/microsoft/vscode | `727002e46c72`（稀疏检出 integrated browser） | MIT | 内置浏览器的宿主、CDP 代理、遮挡与分区。 |
| `reference/playwright` | https://github.com/microsoft/playwright | `80290e838ba5`（稀疏检出 `packages/injected` 与 MCP 工具） | Apache-2.0 | ARIA 快照、可操作性检查、浏览器工具设计。 |
| `reference/chrome-devtools-mcp` | https://github.com/ChromeDevTools/chrome-devtools-mcp | `761c5e0850a3` | Apache-2.0 | CDP 上的智能体调试工具。 |
| `reference/react-grab` | https://github.com/aidenybai/react-grab | `c695bdbaea10` | MIT | 元素到组件与源码位置。 |
| `reference/bippy` | https://github.com/aidenybai/bippy | `fbafc407ca31` | MIT | React fiber 与 source map 符号化。 |
| `reference/ZCode` | https://github.com/zai-org/ZCode | `a4b4445141eb` | Apache-2.0 | 内置浏览器的设计文档与踩坑记录。 |
| `reference/PI-Desktop` | https://github.com/vastsa/PI-Desktop | `720bbe15de8d` | LGPL-3.0-or-later | WebContentsView 后台宿主与 CDP 白名单（只学机制）。 |

## 使用边界

OpenClaudeDesktop 同时作为桌面前端的视觉与交互基准（[ADR-0073](../adr/0073-settings-segmented-control-reference.md)）。PiArc 的代码、提示词和视觉资产都由我们自己编写，遵循 clean-room 原则：

1. **不复制源码和提示词。** `claude-code` 复原的是 Anthropic 的专有产品，`OpenClaudeDesktop` 的 `app/src/generated/` 是从官方应用中切出的组件。即使仓库标注了开源许可证，这些内容的著作权也不属于仓库作者。我们提炼行为、状态机、信息结构和可观察的 UI 规格，由 PiArc 独立实现。
2. **不使用 Anthropic 的品牌资产。** 包括 logo、专有字体、提示音、标志性品牌色（例如 Clay `#d97757`）和整体视觉识别。PiArc 保留自己的品牌标识，组件外观与交互可逐项复刻或高度参考 Claude Desktop。
3. **MIT 仓库（`pi`、`claw-code`、`open-claude-ui` 中作者原创的部分）可以按许可证复用**，复用时保留版权声明，并在 PR 中注明来源。
   - PiArc 改用 Electron + React 后（ADR-0013），和 `OpenClaudeDesktop`、`open-claude-ui` 用的是同一种技术，复制代码变得很顺手，边界因此要更明确：`OpenClaudeDesktop` 的 `app/src/generated/` 及其他由生成器从官方应用切出的文件一律不得复制，改写后也不行；它的宿主层只有确认为作者原创的文件才能逐个按 MIT 复用。`open-claude-ui` 的交互逻辑（滚动跟随、输入法守卫、悬停意图等）可以按 MIT 复用；它的视觉组件和设计令牌还原的是 Claude 的外观，不使用。
4. **Claude 的能力以官方文档为准。** 社区复原工程中有大量魔改特性，不能当作官方行为引用。

## 在新机器上复现 `reference/`

在仓库根目录执行（macOS 与 Windows 通用，需要 git）：

```bash
git clone https://github.com/earendil-works/pi.git reference/pi
git -C reference/pi checkout b4afdddf44e059c67ccf5097e5317d913521b470   # tag v1.5.2

git clone https://github.com/claude-code-best/claude-code.git reference/claude-code
git -C reference/claude-code checkout 963e0013184ecc1521289a0fc7d5da4bb6e45356

git clone https://github.com/ultraworkers/claw-code.git reference/claw-code
git -C reference/claw-code checkout 508b4d862d42a5fa5bde8df5b2d3670f4d4ca324

git clone https://github.com/oleyyu/OpenClaudeDesktop.git reference/OpenClaudeDesktop
git -C reference/OpenClaudeDesktop checkout 62f08512e012d832c1e856693a0d64d8a7327d03

git clone https://github.com/Caho1/open-claude-ui.git reference/open-claude-ui
git -C reference/open-claude-ui checkout be395eb4b783cad3148fd9a4ef7641a3d198dd52
```

升级某个参考源时，`git -C reference/<name> pull`，然后更新本表的"固定版本"列。设计文档中引用参考源的结论应当注明对应版本。

## 检索提示

每个副本都有自己的 git 根目录，因此：

- 在仓库根目录做全局搜索时不会扫到 `reference/`，日常开发不受干扰；
- 需要查参考源时，把路径显式写到 `reference/<name>/...`，ripgrep / Grep / Glob 能正常命中。
