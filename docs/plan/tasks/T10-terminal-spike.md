# T10 终端验证：libghostty-vt + PTY + 帧协议（S7）

| 项 | 内容 |
|---|---|
| 阶段 | 1 M0 技术验证 |
| 依赖 | T04 |
| 执行平台 | macOS（CI 覆盖四个目标的链接；Windows 实机在 W0） |
| 推荐配置 | Opus 5.5，effort xhigh，新会话 |
| 规模 | 大 |
| 关联验证项 | S7（终端：libghostty-vt、PTY、帧协议、渲染器） |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T10`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

ADR-0017 决定终端状态只在 Core 中维护一份：`piarc-term` 用 portable-pty 管 PTY、用 libghostty-vt 持有终端状态，渲染进程只按帧协议绘制。这样 agent 读到的屏幕与用户看到的一致，IPC 流量与程序输出量无关。代价是渲染器要自己做；libghostty-vt 刚发布 1.0，没有官方 Rust 绑定，Windows MSVC 的链接方式也未验证（风险 R15）。

S7 是 M3 终端工作的开工闸门（第 16 章）。通过标准：vim、htop 等 TUI 渲染正确；`cat` 100 MB 时界面帧率稳定、主进程事件循环延迟 p99 ≤ 16 ms；键入回显额外延迟满足第 11 章预算（p95 ≤ 5 ms）；中文输入法候选框与预编辑文本位置正确；formatter 输出与渲染帧逐格一致；四个目标都能链接，win32-arm64 在实机上运行。任一项不达标，按 ADR-0017 第 7 条启用 xterm.js 退路，结论写进报告。

本任务在 macOS 上完成验证，CI 覆盖四个目标的链接；ConPTY、Windows 渲染与回显延迟、win32-arm64 实机运行留给 W0。代码是 T33（无头终端）与 T34（渲染器与面板）的起点。

## 必读

1. ADR-0017 全文。
2. `docs/research/terminal-libghostty.md` 全文，重点第 1.2–1.6 节、第 3 节（ghostty-web 的 `CanvasRenderer` 与已知问题）、第 6 节（PTY）、第 8、9 节。
3. 架构设计：
   - 第 6.11 节中"终端面板"一段
   - 第 7.1 节中 `piarc-term` 的职责与依赖规则
   - 第 11 章中主进程事件循环延迟与终端回显两行
   - 第 10.4 节"合规"（第三方许可证清单）
4. ADR-0006 第 5 条（MIT 代码的复用要求）。
5. T04 交付的事件通道、MessagePort 转发与 CLAUDE.md。
6. 实现时查阅：libghostty-vt 1.0.1 官方文档（terminal、render state、effects、键盘与鼠标编码、formatter、线程约定）与发布目录中的 SHA256SUMS、minisign 签名；portable-pty 的 API 与所选版本的 Windows 修复情况；bindgen 文档；ghostty-web 源码中的 `lib/renderer.ts`（MIT）。

## 范围

### 要做

- `piarc-ghostty-sys`：libghostty-vt 的 `-sys` 层，预编译产物的下载与校验，四个目标的链接；`piarc-term`：最小 safe 封装、PTY 与帧编码。
- PTY 与 IO 线程、effects 注册、render state 增量帧编码；帧格式草案写进 `piarc-protocol`。
- 渲染原型：fork ghostty-web 的 `CanvasRenderer`，由帧协议驱动；键盘输入经 Core 编码后写 PTY。
- 测量与一致性测试；S7 报告与路线结论。

### 不做

- 完整终端面板：多标签、停靠、选区与复制、查找、链接、无障碍（T34）。
- agent 读屏工具、OSC 133 命令边界、search、snapshot 持久化、帧协议定稿（T33）。
- 后台任务与 Monitor 对终端的使用（T32、T33）。

## 交付物

### 1. 绑定与链接

- `-sys` 层：bindgen 生成的绑定提交入库，附重新生成脚本；safe 封装只覆盖本任务用到的 Terminal、RenderState、键盘编码、Formatter。`-sys` 层是独立 crate `piarc-ghostty-sys`（ADR-0017、架构第 7.1 节），`piarc-term → piarc-ghostty-sys` 已登记为依赖规则中的例外。
- 构建脚本下载官方预编译产物（版本精确锁定），用入库的 SHA256 与 minisign 公钥校验，任一失败即构建失败并给出原因；支持离线缓存目录（供 CI 缓存）。
- 链接方式：macOS 静态链接 XCFramework 中的静态库；Windows MSVC 在"官方 DLL 放在 `.node` 旁边"与"lld + 预编译静态库"之间实测选定（调研第 1.3 节：MSVC `link.exe` 不能用其静态库），结论与理由写入报告。
- minisign 校验如果 T12 已经实现则复用，否则在本任务实现并登记到复用表。

### 2. PTY、状态与帧

- portable-pty 启动用户默认 shell，工作目录可配；每个终端一个 IO 线程：读 PTY → 写入解析器。遵守 libghostty-vt 的线程约定：同一 handle 不并发调用，回调中不写同一终端、不阻塞。
- 注册必要的 effects：`WRITE_PTY`（查询应答写回 PTY）、`TITLE_CHANGED`、`BELL`、`RENDER_HOLD`；其余留给 T33。
- 帧编码：render state 两段式更新，只编码脏行。帧包含全局脏状态、光标、颜色、行列表（行 id、视口位置）、脏行单元格（字素与样式索引）、样式表增量；行 id 复用让滚动输出只发新行。编码为二进制 `ArrayBuffer`。
- 帧格式草案写进 `piarc-protocol`：格式说明、Rust 编解码器、往返测试；TS 解码器放在渲染进程侧。T33 定稿 schema 与 L1 样本。
- 拉取式：渲染进程每个 `requestAnimationFrame` 经 MessagePort 请求一帧，Core 没有变化时返回空帧；隐藏的终端不请求，不产生帧。

### 3. 渲染原型

- fork ghostty-web 的 `CanvasRenderer`：保留 MIT 许可证与版权声明，在 vendor 目录写明来源仓库、路径、提交与改动清单；实现由帧协议驱动的 `RemoteRenderable` 数据源。
- 键盘输入：渲染进程把按键事件原样发给 Core，由 libghostty-vt 按当前终端模式编码后写 PTY。
- 输入法：隐藏 textarea 跟随光标，预编辑文本在光标处绘制。
- 原型挂在开发用页面上，不做面板与标签。
- 把 libghostty-vt 与 fork 的渲染器代码登记到第三方许可证清单的来源文件；`THIRD_PARTY_NOTICES` 的生成由 T50 负责。

### 4. 测量与一致性

- `cat` 100 MB 文件：主进程事件循环延迟 p50/p99、渲染进程帧率与长任务、Core 线程 CPU、IPC 字节数。
- 键入回显额外延迟：从键盘事件到回显字符出现在帧中的耗时，减去直接写 PTY 到读回回显的耗时；≥ 200 个样本，报告 p50/p95。
- formatter 纯文本与解码后的渲染帧逐格比较，覆盖普通屏幕、alt screen（vim）、CJK 全角、emoji 与 ZWJ 字素。
- vim 与 htop 渲染截图。htop 未安装时先征得用户同意再安装，或以 `top` 代替并注明。
- macOS 拼音的候选框与预编辑位置：预编辑绘制位置用 CDP 合成自动验证；候选框由系统绘制，需要真实输入法核对，结果写入报告。
- 按 ADR-0017 第 4 条，对 wterm 的 DOM 渲染器做书面评估（接入方式、无障碍、许可证），不实现。

### 5. S7 报告

`docs/spikes/S07-terminal.md`：链接方式、测量数据、一致性结果、截图、wterm 评估、路线结论（正式路线或启用 xterm.js 退路）。macOS 已验证：上述全部；待 W0：ConPTY（含是否随附 `conpty.dll` 与 OpenConsole.exe）、Windows 渲染与回显延迟、微软拼音、win32-arm64 实机运行。更新 `docs/spikes/README.md`。

## 实现要点

- portable-pty 0.9.0 的 Windows `kill()` 判断有误，修复只在 wezterm main 分支（调研第 6 节）。用发布版还是固定 git rev 都要写明理由；git 依赖需要在 cargo-deny 中显式允许。
- 构建脚本联网下载是供应链入口：URL、版本、哈希、公钥集中在一个入库文件中，改动需要评审。
- 主进程只转发帧，不解析拉取请求与帧内容；大帧用 `ArrayBuffer` 转移，复用 T04 的通道。
- 一致性测试在 Rust 中直接解码帧与 formatter 比较；TS 解码器再跑同一组帧样本，保证两侧解码一致。
- `unsafe` 只出现在 `-sys` 层与 safe 封装的边界，每处带 `// SAFETY:` 注释。

## 验收标准

- [T10-A01] darwin-arm64、darwin-x64、win32-x64、win32-arm64 四个目标链接成功，Windows 的链接方式及理由写入报告。验证：本机构建输出与 CI 配置；Windows 运行结果未取得时标 `blocked`，由 W0 核对。
- [T10-A02] 预编译产物的 SHA256 或 minisign 签名任一不匹配时构建失败并给出原因。验证：临时篡改缓存产物与签名后的构建输出。
- [T10-A03] 重新生成脚本产出的绑定与入库版本一致。验证：运行脚本后 `git diff` 为空。
- [T10-A04] PTY 中的 shell 可以输入输出、调整尺寸、检测退出；终端查询（例如设备属性查询）经 `WRITE_PTY` 得到应答。验证：集成测试。
- [T10-A05] 帧只包含脏行；滚动输出时已有行按行 id 复用，帧中只出现新行；编解码往返一致。验证：单元测试。
- [T10-A06] 渲染进程按 rAF 拉取帧，隐藏的终端在测试期间产生 0 帧。验证：Playwright 测试。
- [T10-A07] vim 与 htop（或注明的替代 `top`）渲染正确。验证：`tmp/evidence/T10/` 中的截图与同一时刻 formatter 输出的对照。
- [T10-A08] formatter 纯文本与解码后的帧逐格一致，覆盖普通屏幕、alt screen、CJK 全角、emoji 与 ZWJ 字素；Rust 与 TS 解码器结果相同。验证：测试。
- [T10-A09] `cat` 100 MB 期间主进程事件循环延迟 p99 ≤ 16 ms，渲染进程没有超过 50 ms 的长任务。验证：测量输出。
- [T10-A10] 键入回显额外延迟 p95 ≤ 5 ms（≥ 200 个样本）。验证：测量输出。
- [T10-A11] 隐藏 textarea 跟随光标，预编辑文本绘制在光标处；macOS 拼音的候选框位置有核对结论。验证：基于 CDP 合成的测试、截图与报告。
- [T10-A12] fork 的渲染器代码保留 MIT 许可证与版权声明，来源（仓库、路径、提交）与改动清单齐全，并已登记到第三方许可证清单的来源文件。验证：文件检查。
- [T10-A13] S7 报告含链接方式、测量数据、一致性结果、wterm 评估、路线结论与待 W0 的项，`docs/spikes/README.md` 已更新。验证：文件内容。
- [T10-A14] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 创建 `crates/piarc-term/CLAUDE.md`：绑定的重新生成方法、产物锁定文件、链接方式、线程约定与易错点。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：帧编解码器、预编译产物下载与校验、minisign 校验（本任务实现时）。
- 路线结论为启用退路时，在 `PLAN.md`"登记事项"中登记，提醒 T34 按 ADR-0017 第 7 条执行。
