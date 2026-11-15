# 参考源清单（References）

PiArc 在设计阶段研读了以下开源仓库。为了随时查阅和核对，本地在仓库根目录的 `reference/` 下各放一份只读副本。该目录已写入 `.gitignore`，不进入版本库。

## 清单

| 目录 | 上游 | 固定版本 | 许可证 | 用途 |
|---|---|---|---|---|
| `reference/pi` | https://github.com/earendil-works/pi | `4a080252f06c`（v1.4.0） | MIT | Agent 底座。SDK、扩展 API、RPC、会话格式、多服务商层。PiArc 以 npm 依赖方式使用，不 fork。 |
| `reference/claude-code` | https://github.com/claude-code-best/claude-code | `963e0013184e` | 仓库无 LICENSE 文件；原作为 Anthropic 专有软件，见下文"使用边界" | 社区复原的 Claude Code 工程。用于理解 Harness 设计思路：主循环、工具、权限、hooks、子 agent、上下文工程。 |
| `reference/claw-code` | https://github.com/ultraworkers/claw-code | `508b4d862d42` | MIT | 用 Rust 复刻 Claude Code Harness 的实验项目。参考 crate 划分、mock 服务与行为对齐测试方法。 |
| `reference/OpenClaudeDesktop` | https://github.com/oleyyu/OpenClaudeDesktop | `62f08512e012` | 仓库声明 MIT，但含官方应用切出的组件，见下文 | Claude Desktop Code 界面复刻。参考信息架构、交互流程，以及 UI 与内核之间的协议（Codex app-server v2）。 |
| `reference/open-claude-ui` | https://github.com/Caho1/open-claude-ui | `be395eb4b783` | MIT | 逆向还原的 Claude 设计系统与交互物理。参考令牌结构、动效参数、滚动跟随、IME 守卫等工程经验。 |

## 使用边界

这些仓库只用于学习设计思路和核对行为。PiArc 的代码、提示词和视觉资产都由我们自己编写，遵循 clean-room 原则：

1. **不复制源码和提示词。** `claude-code` 复原的是 Anthropic 的专有产品，`OpenClaudeDesktop` 的 `app/src/generated/` 是从官方应用中切出的组件。即使仓库标注了开源许可证，这些内容的著作权也不属于仓库作者。我们只提炼行为、状态机和信息结构，再用自己的实现表达。
2. **不使用 Anthropic 的品牌资产。** 包括 logo、专有字体、提示音、标志性品牌色（例如 Clay `#d97757`）和整体视觉识别。PiArc 对标的是 Claude Desktop 的交互能力，视觉上保持自己的品牌。
3. **MIT 仓库（`pi`、`claw-code`、`open-claude-ui` 中作者原创的部分）可以按许可证复用**，复用时保留版权声明，并在 PR 中注明来源。
4. **Claude 的能力以官方文档为准。** 社区复原工程中有大量魔改特性，不能当作官方行为引用。

## 在新机器上复现 `reference/`

在仓库根目录执行（macOS 与 Windows 通用，需要 git）：

```bash
git clone https://github.com/earendil-works/pi.git reference/pi
git -C reference/pi checkout 4a080252f06caf63a525d7873c5d94d3c23887e0

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
