# T33 无头终端（Core 侧）

| 项 | 内容 |
|---|---|
| 阶段 | 4 M3 多会话与生态 |
| 依赖 | T32 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort xhigh，新会话 |
| 规模 | 大 |
| 关联验证项 | 无（前提：S7 报告的路线结论） |
| 关联需求 | FR-TL-05（Core 部分） |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T33`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

ADR-0017 规定：终端状态只在 Core 中由 libghostty-vt 维护一份；agent 在 Core 里读屏，不依赖界面；渲染进程只画帧，输入由 Core 编码。T10 已完成 `-sys` 层、PTY、帧协议草案与渲染原型，S7 报告给出了路线结论，W0 补充了 Windows 结论。

本任务把 `piarc-term` 做成正式实现：完整的副作用回调、读屏、命令边界、搜索、snapshot 持久化、帧协议与输入编码定稿，以及 agent 使用终端屏幕的接口。T34 在此基础上做渲染器与终端面板。

S7 结论即使启用了 xterm.js 退路，本任务的范围也不变：退路只替换渲染端，Core 仍是唯一权威（ADR-0017 第 7 条）。退路下本任务额外提供字节流副本通道，以及基于 formatter VT 输出的重放接口，供 T34 使用。

## 必读

1. ADR-0017 全文。
2. `docs/spikes/S07-*.md`（T10 产出，含 W0 的 Windows 结论）：路线结论、链接方式、帧协议草案、测量数据、遗留问题。
3. `docs/research/terminal-libghostty.md` 第 1 节（尤其 1.2 C API、1.5 线程模型、1.6 稳定性承诺）、第 8 节、第 9 节。
4. 架构设计：第 6.11 节中的终端面板一条、第 7.1 节（piarc-term）、第 7.3 节（终端状态归属）、第 9.1 节（会话目录）、第 15.2 节（PTY 一行）。
5. T10 的 `piarc-term` 代码与 CLAUDE.md；T17 的环境变量构造；T32 的任务管理器。
6. 实现时查阅：
   - libghostty-vt 锁定版本的文档与头文件：effects、render state 两段式更新、formatter、search、snapshot、key/mouse/paste/focus 编码；
   - portable-pty 锁定版本的 API；Windows ConPTY 的接入方式按 S7/W0 的结论。

## 范围

### 要做

- 终端会话生命周期与每终端 IO 线程。
- 副作用回调：`WRITE_PTY`、`TITLE_CHANGED`、`PWD_CHANGED`、`BELL`、`SEMANTIC_PROMPT`、`CLIPBOARD_READ`/`CLIPBOARD_WRITE`、`RENDER_HOLD`。
- 读屏、OSC 133 命令边界与退出状态、搜索。
- 帧协议与输入编码定稿（schema + L1 样本）、帧拉取接口。
- snapshot 持久化与降级恢复。
- 终端与会话共享 cwd 与环境；shell integration 注入。
- agent 使用终端屏幕的接口（先写补充 ADR）。

### 不做

- Canvas 渲染器、终端面板、IME、选区界面与 Core 侧选区手势 API、查找界面、链接（T34）。
- agent 向交互终端写入输入：等同执行命令，本任务不开放。
- Kitty graphics 图像协议（未排期）。

## 交付物

### 1. 终端会话与 IO 线程

- Core 中的终端注册表：`terminalId` → PTY、libghostty-vt 终端、render state、所属会话与工作区；create、resize、close。
- 每终端一个 IO 线程：读 PTY 写入解析器。线程模型遵守调研文档第 1.5 节：同一 handle 不并发调用；回调里不写同一个终端、不阻塞，只把事件投递到通道，由 Core 在回调之外处理。
- 关闭终端或应用退出时终止 shell 进程树（macOS 进程组，Windows Job Object）。终端与 T32 的任务一样由 Core 统一管理。

### 2. 副作用回调

| 回调 | 处理 |
|---|---|
| `WRITE_PTY` | 查询应答写回 PTY，是唯一的应答来源 |
| `TITLE_CHANGED`、`PWD_CHANGED`、`BELL` | 进入 Core 事件流，供面板标题、cwd 显示与提示使用 |
| `SEMANTIC_PROMPT` | 维护 OSC 133 命令边界表（第 3 节） |
| `CLIPBOARD_WRITE` | 交给客户端写系统剪贴板，可在设置中关闭 |
| `CLIPBOARD_READ` | 默认拒绝，返回空 |
| `RENDER_HOLD` | hold 期间冻结 render state，不产生新帧；超时由 Core 主动结束 hold |

### 3. 读屏、命令边界与搜索

- 读屏 API：formatter 的 PLAIN 输出（unwrap、trim 可选），可取当前屏幕、scrollback、最近 N 行；alt screen 下返回当前显示的屏幕。
- 命令边界：根据 OSC 133 记录每条命令的提示符、输入、输出区间与退出码；提供"最近一条命令"查询与"等待命令结束"（带超时）。
- 搜索：用 search API 分步执行，放在后台线程，只在喂数据时持锁，不阻塞 IO 线程写入。

### 4. 帧协议与输入编码定稿

- 在 `piarc-protocol` 中定稿帧格式：全局脏状态、光标、颜色、行列表（行 id、视口位置、行内选区）、脏行的单元格、样式表增量；二进制布局写进协议文档；schema 与 L1 golden 样本纳入契约测试。
- 帧拉取接口（NAPI）：渲染端按 `requestAnimationFrame` 拉取，Core 不主动推送；隐藏的终端不产生帧；帧数据以 `ArrayBuffer` 转移。
- 输入编码接口：键盘（legacy 与 Kitty 键盘协议，按当前终端模式）、鼠标（按当前鼠标模式）、粘贴（bracketed paste 与粘贴安全检查）、焦点（mode 1004）。T34 只负责把原始事件交给这些接口。
- 退路时额外提供：字节流副本通道（同一份 PTY 输出）与重连时的 VT 重放（formatter VT 输出）。

### 5. snapshot 持久化与降级

- 退出时与定期把每个终端的 snapshot 写入 `sessions/<sessionId>/terminals/<terminalId>.snap`，文件头记录 libghostty-vt 版本与 snapshot 格式版本。
- 恢复顺序：版本一致时 snapshot 解码；不一致时用保存的 formatter VT 输出重放；再失败只恢复纯文本。snapshot 格式不在 ABI 承诺内（调研文档 1.6），降级路径必须可测。
- 会话归档时随会话目录清理。

### 6. cwd、环境与 shell integration

- 新终端以会话 cwd（含 worktree）启动；环境变量用 T17 的同一构造逻辑生成，再加上终端需要的 `TERM`、`COLORTERM` 与 shell integration 变量；不传凭据。
- shell integration：为 zsh、bash、PowerShell（Windows 上还有 Git Bash）注入发出 OSC 133 的脚本，不修改用户的 rc 文件。可参考 Ghostty 的 shell integration（MIT，保留声明并注明出处）。

### 7. agent 使用终端屏幕的接口

先写补充 ADR（编号取 `docs/adr/` 最大编号加一），再实现。约束：

- agent 读到的内容来自 Core 的 formatter，与用户在面板看到的是同一终端实例，不读原始字节。
- 终端内容不自动进入模型上下文（第 6.11 节）。agent 只能读取自己启动的终端承载任务，以及用户在界面上明确共享给 agent 的终端。共享开关的界面由 T34 做，共享状态与读取时的校验在本任务实现。
- 规范名工具的参数与语义保持 Claude Code 兼容。需要新增模型可见的参数或宿主工具时，按 Tool Profile 处理，并在 `tests/l3-allowlist.yaml` 写明有意偏离。

推荐方案：在 T32 的任务管理器上增加"终端承载"任务类型（PTY + libghostty-vt）；对这类任务，后台任务读取返回 formatter 的屏幕与 scrollback 纯文本，以及最近一条命令的边界与退出码；Monitor 按 OSC 133 边界与新增行回灌。模型如何选用终端承载在 ADR 中定，写明与 L3 对齐的取舍。

### 8. 测试与能力 ID

- Rust 单元测试覆盖回调、读屏、命令边界、搜索、snapshot、编码；L1 覆盖帧协议；L2 场景覆盖 agent 接口，能力 ID 如 `CAP-TERM-READ-001`。
- 测试用确定性的输入序列驱动解析器，不依赖真实 shell 的输出时序；需要真实 shell 的用例在两个平台 CI 上都跑。

## 实现要点

- libghostty-vt 版本精确锁定，与 snapshot 文件头一致；升级时把 snapshot 兼容性作为检查项写进 `crates/piarc-term/CLAUDE.md`。
- render state 用两段式更新，只在 `begin_update` 时持终端锁，避免拉帧阻塞 IO 线程。
- 大量输出（`cat` 100 MB）时 IO 线程与拉帧都不进入主进程事件循环；NAPI 同步方法只做入队（第 7.2 节）。

## 验收标准

- [T33-A01] 读屏 API 返回的纯文本与终端状态逐格一致，覆盖宽字符、折行与 alt screen。验证：Rust 测试（与 render state 逐格比较）。
- [T33-A02] OSC 133 正确识别命令的开始、结束与退出码：macOS 上 zsh 与 bash，Windows CI 上 Git Bash 与 PowerShell。验证：测试。
- [T33-A03] 查询应答（设备属性、光标位置报告）经 `WRITE_PTY` 写回 PTY；标题、工作目录、铃声进入 Core 事件流；`CLIPBOARD_READ` 默认被拒绝。验证：测试。
- [T33-A04] `RENDER_HOLD` 期间不产生新帧，超时后 Core 主动结束 hold。验证：测试（时钟可注入）。
- [T33-A05] 在 1 万行 scrollback 中搜索返回正确位置，搜索期间 IO 线程写入不被阻塞。验证：测试。
- [T33-A06] snapshot 恢复后的屏幕与 scrollback 与保存前一致；版本头不一致时降级为 VT 重放，重放失败时恢复纯文本。验证：测试。
- [T33-A07] 帧协议有 schema 与 L1 golden 样本；帧只含脏行；隐藏的终端不产生帧。验证：L1 契约测试与单元测试。
- [T33-A08] 键盘、鼠标、粘贴、焦点事件按当前终端模式编码，覆盖 legacy 与 Kitty 键盘协议、SGR 鼠标、bracketed paste。验证：测试。
- [T33-A09] 新终端以会话 cwd（含 worktree）启动，环境变量来自 T17 的构造逻辑且不含凭据。验证：测试。
- [T33-A10] agent 接口的补充 ADR 已写；界面未打开时，agent 读到终端承载任务的屏幕内容与最近一条命令的退出码，内容与 formatter 输出一致。验证：ADR 文件与 L2 场景。
- [T33-A11] agent 无法读取未被用户共享的终端。验证：测试。
- [T33-A12] 关闭终端或应用退出时 shell 进程树被终止。验证：macOS 与 Windows CI 上的测试。
- [T33-A13] 无头状态下 `cat` 100 MB 期间主进程事件循环延迟 p99 ≤ 16 ms。验证：测量输出。
- [T33-A14] `npm run verify` 通过（含 Windows CI 上的 piarc-term 测试）。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新 `crates/piarc-term` 的 CLAUDE.md：线程模型、回调处理规则、snapshot 版本与降级、shell integration 脚本的位置与来源、libghostty-vt 升级检查项。
- 帧协议定稿后更新架构第 6.11 节与协议文档；agent 接口 ADR 对架构的影响一并同步。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：读屏 API、命令边界查询。
