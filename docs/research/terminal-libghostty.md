> 本文是 2026-11-14 的调研快照，由调研过程整理而成，引用时注意时效。版本号与生态现状变化很快。重要事实在用于设计或实现前，请回到原始来源重新核对。结论已写入 ADR-0017。

# 内置终端选型调研：libghostty-vt / ghostty-web / xterm.js / PTY

调研日期：2026-11-14。前置材料：`docs/research/native-stack.md` 第 6 节（不重复其中已核对的内容）。

标注约定：
- 【未确认】：没能在一手来源里核实。
- 【推测】：根据已核实事实推断，未实测。
- 【估算】：工作量或带宽的粗估。
- 未加标注的事实都附了来源 URL 和访问日期（2026-11-14）。

---

## 0. 结论

**推荐 (a)：终端状态以 Rust Core 里的 libghostty-vt 为唯一权威；渲染层可以替换。**

- Core 用 portable-pty 管 PTY，用 libghostty-vt 1.0.1 持有每个会话的终端状态。
- Agent 直接在 Core 里读屏幕（formatter），不依赖 UI 是否打开。
- 渲染进程只拿 Core 推来的增量帧（按 row id 复用、只发脏行）来画，自己不解析 VT。
- 第一版渲染器从 ghostty-web 的 `CanvasRenderer`（MIT，输入是 `IRenderable` 接口）fork 改造，不从零写。
- 回退方案用 xterm.js 6，不用 ghostty-web：渲染层改为"字节流 + VT 重放"的副本模式，Core 仍是权威。

**为什么不选 (b)/(c)**：

1. (b) 做不到 Agent 无头读屏，最后一定要补一个 Core 侧解析器，实际就变成 (c)。
2. ghostty-web 还没迁到 libghostty-vt 1.0。它基于 2025-12-01 的 Ghostty 快照加 64KB 补丁，最近一个稳定版是 2025-12-09 的 0.4.0，维护活跃度低。另外有 CJK IME 和屏幕阅读器方面的未解决 issue，这两点 PiArc 的用户都会碰到。
3. (c) 两侧都解析同一字节流。要保证 Agent 看到的和用户看到的一致，必须两侧版本相同、resize 按字节序对齐、查询应答去重。用 ghostty-web 时第一条做不到。改用官方 1.0.1 WASM 自建渲染层能做到，但渲染器还是得自己写，工作量并不比 (a) 少，复杂度却更高。

---

## 1. libghostty-vt 1.x

### 1.1 版本

| 项 | 事实 | 来源 |
|---|---|---|
| 最新版本 | **1.0.1**，tag `vt-1.0.1`，tagger 时间 2026-11-11T20:10:46Z，指向提交 `108cacb17ed8990840cd14abfce43d8ed8503ca1` | `gh api repos/ghostty-org/ghostty/git/tags/e9dc690b…`；https://lib.ghostty.org/vt/ （首页写 "The latest version of libghostty-vt is 1.0.1"） |
| 1.0.0 | tag `vt-1.0.0`，2026-11-06T22:55:16Z | 同上 |
| 发布形式 | 和 Ghostty app 分开发版，有独立版本号和 `vt-X.Y.Z` tag。GitHub Releases 页面**没有** vt 的 release 条目，产物发在 `https://release.files.ghostty.org/libghostty-vt/VERSION/` | https://lib.ghostty.org/vt/installing.html |
| 许可 | MIT，依赖树里没有 copyleft（simdutf、Highway、Wuffs） | https://mitchellh.com/writing/libghostty-1-0 |

1.0.1 的主要变化（https://lib.ghostty.org/vt/release-notes.html ）：
- 新增 Windows x86_64 / aarch64 预编译 zip。
- 修复：render state 更新失败时，未完成的行会被错误地标成 clean（可能导致崩溃）。
- 修复：OSC 133 提示符在改列宽后残留。
- 修复：同时增行、减列时，scrollback 下拉不正确。
- 按行数限制 scrollback 时的吞吐与按字节限制持平。在 1000 行限制下，ASCII 吞吐 Linux 从 298 提到 1,983 MB/s，macOS 从 2,214 提到 4,093 MB/s。这是厂商自测数字。

### 1.2 C API 覆盖

头文件 `ghostty/vt.h` 汇总了下列子头文件（https://lib.ghostty.org/vt/vt_8h.html ）：
`terminal.h render.h formatter.h screen.h grid_ref.h grid_ref_tracked.h key.h mouse.h focus.h paste.h selection.h search.h snapshot.h kitty_graphics.h modes.h osc.h sgr.h style.h color.h unicode.h size_report.h io.h sys.h wasm.h` 等。

| 能力 | API / 说明 | 来源 |
|---|---|---|
| 终端状态 | `GhosttyTerminal`：`ghostty_terminal_new/vt_write/resize/get/set`，覆盖屏幕、光标、scrollback、modes | https://lib.ghostty.org/vt/group__terminal.html |
| 渲染状态与脏跟踪 | `GhosttyRenderState`：`update`，或两段式 `begin_update`（需要终端锁）+ `end_update`（只碰自身内存）。脏状态分两层：全局 `DIRTY_FALSE/PARTIAL/FULL`，加每行 dirty 标记；`row_iterator_next_dirty` 只遍历脏行；`ghostty_render_state_clean()` 一次清掉两层。行数据包括 `CELLS`、`SELECTION`（行内选区区间）、`VIEWPORT_Y`、`ID`（跨帧行身份，可以识别"只是滚动了"的行）。支持 overscan（视口上下多抓几行，用于平滑滚动） | https://lib.ghostty.org/vt/guide-rendering.html ，https://lib.ghostty.org/vt/group__render.html ，https://lib.ghostty.org/vt/struct_ghostty_render_state_row_id.html |
| Render hold（同步输出 2026） | `GHOSTTY_TERMINAL_OPT_RENDER_HOLD` 回调：hold 开始时更新一次 render state，之后保持不动，避免半帧。超时要宿主自己结束 hold | guide-rendering.html |
| 键盘编码 | legacy 编码和 Kitty keyboard protocol | https://lib.ghostty.org/vt/group__api__input.html |
| 鼠标编码 | X10 / UTF-8 / SGR / URxvt / SGR-Pixels | 同上 |
| focus、paste | mode 1004；粘贴安全检查（`GHOSTTY_REJECTED`），bracketed paste | 同上 |
| 选区 | `select_word / select_word_between / select_line`；手势 API 把原始指针事件直接转成选区（双击拖动等），可以用 OSC 133 语义边界 | https://lib.ghostty.org/vt/guide-selection.html |
| 搜索 | `GhosttySearch` 分步 `tick`，可以放到后台线程，只在 feed 时拿终端锁 | https://lib.ghostty.org/vt/guide-search.html |
| 序列化（文本） | Formatter 输出 plain、VT、HTML 三种格式，可选 unwrap、trim、只取选区；extras 可以附带 palette、modes、滚动区域、tabstops、pwd、键盘模式、光标、样式、超链接、charsets 等状态 | https://lib.ghostty.org/vt/group__formatter.html |
| 序列化（完整状态） | **Snapshot**：`ghostty_snapshot_encode*` 把整个终端编码成字节；decoder 可以一次恢复，也可以先到 `READY`（已经可渲染、可接收实时输入），再按新到旧逐页补回历史。包含未完成的 VT 输入（需要先开 `CONTINUATION_MAX_BYTES`） | https://lib.ghostty.org/vt/guide-snapshots.html |
| 副作用回调（effects） | 共 19 个：`WRITE_PTY`（查询应答）、`BELL`、`TITLE_CHANGED`、`PWD_CHANGED`、`CLIPBOARD_READ/WRITE`、`DESKTOP_NOTIFICATION`、`PROGRESS_REPORT`、`SEMANTIC_PROMPT`（OSC 133）、`RENDER_HOLD` 等。**默认全部关闭**："a program that asks a question gets no answer"，注册后才生效 | https://lib.ghostty.org/vt/guide-effects.html |
| 可裁剪特性 | 用 `-Dvt-features` 裁掉 formatter、input_encode、kitty_graphics、render_state、search、selection、snapshot 等；被裁掉的函数仍然存在，调用时返回 `GHOSTTY_UNSUPPORTED` | https://lib.ghostty.org/vt/features.html |

**是否渲染：不渲染。**
- 文档的说法是 render state "is a copy of everything you need to draw one frame"，示例程序 "has no GUI window and doesn't use a real PTY"（https://lib.ghostty.org/vt/ ）。
- 字体光栅化、字形缓存、GPU 绘制都由宿主负责。

### 1.3 平台与预编译产物

| 平台 | CI 状态 | 官方预编译 | 来源 |
|---|---|---|---|
| macOS 13+ arm64 / x86_64 | 构建并测试 | `ghostty-vt-1.0.1.xcframework.zip`（16,451,728 B），**只有静态库**（macOS arm64+x86_64、iOS、iOS sim），没有 macOS dylib 预编译 | installing.html；SHA256SUMS |
| Windows x86_64 | 构建并测试 | `ghostty-vt-1.0.1-x86_64-windows-gnu.zip`（6,874,910 B）：DLL、PDB、import lib、static lib、头文件、CMake、pkg-config | installing.html |
| **Windows arm64** | **只构建不运行**：原文 "The arm64 zip is built the same way, in CI and at release, but never run." | `ghostty-vt-1.0.1-aarch64-windows-gnu.zip`（6,159,503 B） | installing.html；博客平台表把 Windows arm64 列为 build-only |
| **wasm32** | wasm32-freestanding 构建并测试；WASI 只构建 | `ghostty-vt-1.0.1-small.wasm`（845,526 B，体积优先，官方建议 web 默认用这个）和 `ghostty-vt-1.0.1.wasm`（1,243,719 B，转义序列密集时快 10–20%）。freestanding 构建**没有 Kitty graphics**（需要时钟） | installing.html；features.html |
| Linux / FreeBSD | 构建并测试 | 不提供预编译，需要从源码构建 | installing.html |

Windows 链接要注意：
- 官方 zip 是 gnu ABI。官方文档说 MSVC 应该用 DLL，原因是 "The static library works with clang, mingw and Zig, but not with MSVC's link.exe"。
- DLL 只依赖 ntdll、kernel32 和 UCRT，不需要另装运行库。
- 第三方 crate `ghostty-vt-sys`（gpui-cn）的 README 写道：`*-pc-windows-msvc` 使用预编译静态库时 "Needs lld"，否则从源码用 Zig 构建。
- `libghostty-rs` 的 CI 在 `x86_64-pc-windows-msvc` 上测试过从源码构建的静态链接（见第 2 节）。
- 所以 NAPI-RS 默认的 MSVC 目标能否直接静态链接官方预编译库，属于【未确认】，需要在 M0 验证。

### 1.4 构建要求

- 所有从源码构建的方式都**要求 Zig 0.17**，其他小版本会直接报错退出；Zig 版本不在 ABI 承诺范围内（installing.html）。
- Zig 0.17.0 于 2026-10-01 发布，0.17.1 于 2026-11-02 发布（https://ziglang.org/download/index.json ）。
- 要用 release tarball，不要用 GitHub 自动生成的 tag 归档；后者缺少构建库所需的文件，会去构建 Ghostty app。在源码 checkout 里构建要加 `-Demit-lib-vt`。
- 离线构建用 `libghostty-vt-1.0.1-deps.tar.gz`。所有产物带 minisign 签名，并附 SHA256SUMS。

### 1.5 线程模型（https://lib.ghostty.org/vt/conventions.html ）

- 库自己不创建线程。
- 同一个 handle（以及从它借出的 handle）上的调用不能并发；共享内容的不同 handle 可以放在不同线程。
- 回调在触发它的那次调用所在的线程上同步执行。库里没有"主线程"的概念。
- 典型做法：IO 线程负责 `vt_write`，渲染线程持锁做 `render_state_begin_update`，解锁后再做 `end_update`。
- 回调里**不能**再写同一个终端，因为它不可重入。回调里也不要阻塞（guide-effects.html）。

### 1.6 稳定性承诺

- C ABI 从 1.0 起稳定。1.x 的 minor 版本只做增量：加函数、加类型、加枚举值、在 sized struct 末尾加字段。行为变化会以新函数名发布，旧函数标为 `GHOSTTY_DEPRECATED`（https://lib.ghostty.org/vt/stability.html ）。
- **Snapshot 字节格式不在 ABI 承诺内**。"Snapshot format version 1 is a work in progress and doesn't carry a binary-compatibility guarantee"（guide-snapshots.html）。
- 推论：Core 和渲染端如果要互传 snapshot，或者要持久化到磁盘，必须使用同一个 libghostty-vt 版本，并为格式不兼容准备降级路径。

---

## 2. Rust 绑定

| crate | 最新版本 / 日期 | 维护者 | 是否对齐 1.x | 构建方式 | 来源 |
|---|---|---|---|---|---|
| `libghostty-vt` / `libghostty-vt-sys` | **0.2.2 / 2026-09-28**（早于 1.0） | Uzaaft（Ghostty 贡献者，awesome-libghostty 作者），**不是** ghostty-org 官方仓库 | crates.io 版本**没对齐**。main 分支 2026-11-11 提交 "vt-sys: update to vt-1.0.1"，`build.rs` 固定 `GHOSTTY_COMMIT = 108cacb1…`（即 vt-1.0.1）。之后还在合入带 `!` 的破坏性提交（`vt/alloc!`、`vt!: reorganize modules`），**1.0 对齐版尚未发布** | MSRV 1.96；需要 Zig 0.17.x，构建时拉取 Ghostty 源码再用 Zig 编译；可选 `pkg-config` / `link-dynamic`；CI 覆盖 macOS、Linux、iOS check、wasm32/wasm64、Windows msvc 和 gnu（静态+动态），**没有 Windows arm64** | https://crates.io/crates/libghostty-vt ；https://github.com/Uzaaft/libghostty-rs （README、build.rs、.github/workflows/windows-ci.yml） |
| `ghostty-vt` / `ghostty-vt-sys` | **0.9.0+ghostty-vt.1.0.1 / 2026-11-14** | prabirshrestha，为 gpui-cn 开发 | 对齐 vt-1.0.1 | macOS/iOS/Windows-gnu 下载官方预编译库并按 `GHOSTTY.lock` 校验 sha256，不需要 Zig；MSVC 加 `GHOSTTY_VT_PREBUILT_MSVC=1` 可以用预编译静态库，但需要 lld；其他平台用 Zig 从源码构建。绑定代码已预生成并提交，不需要 bindgen | https://crates.io/crates/ghostty-vt ；https://github.com/prabirshrestha/gpui-cn/tree/main/crates/ghostty-vt-sys |
| `ghostty-vt-rs-sys` | 0.3.0 / 2026-11-07 | nklmilojevic | 描述里写 "with prebuilt static libraries"，是否对齐 1.0.1 属于【未确认】 | 预编译静态库 | https://crates.io/crates/ghostty-vt-rs-sys |

结论：
- 目前没有官方 Rust crate。
- 由于 1.x ABI 稳定、头文件不大，**最稳的做法是自己维护一个很薄的 `-sys` 层**：bindgen 只跑一次，生成结果提交进仓库；链接官方预编译产物并校验 SHA256。
- safe 封装只写 PiArc 用得到的部分：Terminal、RenderState、Formatter、KeyEncoder、MouseEncoder、Selection、Search、Snapshot。
- 可以参考 libghostty-rs main 的封装方式和 gpui-cn 处理 Windows 链接的办法（重命名 compiler_rt 弱符号），但不直接依赖一个还在做破坏性改动的上游。【推测】

---

## 3. ghostty-web

| 项 | 事实 | 来源 |
|---|---|---|
| 仓库 | https://github.com/coder/ghostty-web ，MIT，3,062 stars，创建于 2025-11-10，最后 push 2026-11-07 | `gh api repos/coder/ghostty-web` |
| npm 版本 | `latest` = **0.4.0（2025-12-09）**；`next` = 0.4.0-next.21.g640db46（2026-10-28） | `npm view ghostty-web` |
| 基于哪个 libghostty | **不是 libghostty-vt 1.0**。`ghostty` 子模块指向 `5714ed07…`，提交时间 2025-12-01（"zsh: improve minimum version check (#9772)"）；另外带一个 64,769 字节的 `patches/ghostty-wasm-api.patch`。README 原话："This library will eventually consume a native Ghostty WASM distribution once available"。官方 WASM 1.0.0 发布于 2026-11-06，截至 2026-11-14 ghostty-web 还没迁移 | 子模块 sha 与 patches 目录；README |
| 渲染 | **Canvas 2D**（`renderer.ts` 里的 `canvas.getContext('2d')`）。没有 WebGL；issue #155 "WebGL Renderer" 未关闭，社区 fork 有 WIP 的 webgpu/webgl 分支 | lib/renderer.ts；issues #155 |
| 渲染器接口 | `CanvasRenderer` 读取 `IRenderable`（`getLine/getCursor/getDimensions/isRowDirty/clearDirty/getGraphemeString`）和 `IScrollbackProvider`，**和 WASM 终端是解耦的** | lib/renderer.ts |
| WASM 体积 | 0.4.0 为 423,045 B，next.21 为 423,939 B（未压缩）。JS 包约 682KB，因为 WASM 以 data: URI 内联在里面 | `npm pack` 后的文件列表 |
| xterm.js API 兼容 | 有 `write/writeln/paste/input/resize/clear/reset/focus/blur/loadAddon`、选区相关方法、`attachCustomKeyEventHandler`、`registerLinkProvider`、scroll 系列、`buffer`、`onData/onResize/onBell/onTitleChange/onScroll/onRender/onCursorMove`。**缺** decorations、markers、`parser.registerOscHandler` 等解析器钩子【以源码列出的公开成员为准】 | lib/terminal.ts |
| 插件 | fit：内置 `FitAddon`。web-links：内置 OSC 8 和 URL 正则两种 link provider。search、serialize、webgl：都没有。unicode：Ghostty 原生处理字素簇，`unicode` 属性只是兼容桩 | lib/addons、lib/providers |
| IME | 处理 composition 事件，`compositionend` 时提交；**不在光标处绘制预编辑文本**（代码注释："rely on the browser's input method editor UI"）；隐藏 textarea 固定在 (0,0)。未关闭 issue：#97 CJK 输入位置异常，#119 韩文 IME 不可用 | lib/input-handler.ts、lib/terminal.ts；issues |
| 无障碍 | 只给输入框加了 `aria-label`。issue #187 "terminal output has no accessible representation"（2026-08-01）未关闭 | issues #187 |
| 其他已知问题（未关闭） | #210 释放后写入导致内存越界；#208 每个动画帧都重绘，包括内容没变和终端隐藏时；#189 render() 抛一次异常后渲染循环永久停止；#188 CSP 下 WASM 走 data: URI 被拦，`init()` 不能指定 wasm 路径；#203 Alt+键不发 ESC 前缀；#204 Linux/Windows 上 Ctrl+Shift+C 发送 ^C；#192 `attachCustomKeyEventHandler` 返回值语义和 xterm.js 相反 | `gh api repos/coder/ghostty-web/issues` |
| 维护活跃度 | 2026 年的提交集中在 2 月、6 月和 10 月；10 月那次只是 CI 升级 Node。issue #156 "ghostty-web roadmap"（2026-04-19）询问项目去向，维护者没有回复 | commits；issue #156 |
| 已知用户 | **coder/mux**：Electron 44，Agent 开发桌面应用；锁定 `ghostty-web 0.4.0-next.7.g03ead6e`，后端用 `@xterm/headless ^6.0.0` + `@xterm/addon-serialize` 维护状态，PTY 用 `@lydell/node-pty 1.1.0`。另外有 vscode-bootty、webterm、RemoteTTYs、Obsidian 插件等 | https://github.com/coder/mux/blob/main/package.json ；src/node/services/terminalService.ts；awesome-libghostty |
| 查询应答 | 把 DA/DSR 应答通过 `onData` 发出，和用户输入走同一个出口 | lib/terminal.ts `processTerminalResponses` |

mux 代码里能直接看到 ghostty-web 的成熟度问题：
- `Terminal.reset()` 会释放 WASM 终端再新建一个，但选区管理器和输入处理器仍持有旧实例，下一次写入时 "memory access out of bounds"。
- 渲染端写入时可能 "intermittently" 抛出 "memory access out of bounds"。

出处：https://github.com/coder/mux/blob/main/src/browser/components/TerminalView/TerminalView.tsx 中 `writeScreenState` 的注释。

---

## 4. 其他在 web / Electron 中使用 libghostty-vt 的项目

| 项目 | 做法 | 状态 | 来源 |
|---|---|---|---|
| **vercel-labs/wterm**（`@wterm/*` 0.5.10，2026-11-08，Apache-2.0，3.7k stars） | DOM 渲染（只更新脏行；原生选区、浏览器查找、屏幕阅读器都能用），可选 WebGL2；IME 预编辑文本显示在终端光标处；`TerminalCore` 接口可插拔，`WorkerCore` 是异步模型（"Writes return before they are parsed… arrive with the next update"）。`@wterm/ghostty` 核心基于 **Ghostty v1.3.1 源码加补丁**，不是 1.0 官方 WASM | 自称 "Vercel Labs Experiment" | https://github.com/vercel-labs/wterm ；packages/@wterm/ghostty/zig/build.zig.zon |
| wiedymi/restty（npm 0.3.0，2026-09-05，MIT） | libghostty-vt WASM，WebGPU 渲染，WebGL2 兜底，TS 文本整形；有 xterm 兼容层和 `restty/headless` | README 写 "early-release" | https://github.com/wiedymi/restty |
| coder/libghostty-vt-node（`@coder/libghostty-vt-node` 0.1.0-beta.0） | Node-API 绑定：feed、resize、`getVisibleText`、结构化 `snapshot()`、`encodeMouse`；明确不负责渲染。固定 Ghostty v1.4.0 源码，需要 Zig 0.17.0 | beta，3 stars | https://github.com/coder/libghostty-vt-node |
| philipp-spiess/electron-libghostty | 把完整 GhosttyKit 的原生 macOS 视图叠在 Electron 窗口上 | 预览版，只支持 macOS；计划改用 shared texture | https://github.com/philipp-spiess/electron-libghostty |
| vscode-bootty | VS Code 扩展，ghostty-web 的 fork，Canvas2D 渲染 | README 承认 WASM 构建没为 web 环境优化过 | https://github.com/alleneubank/vscode-bootty |

我**没有找到**"原生后端持有 libghostty-vt，把 render state 推到 web canvas/WebGL 去画"的公开项目。【未确认】也就是说，这条路没有现成实现可以照搬。

---

## 5. xterm.js 对照

| 项 | 事实 | 来源 |
|---|---|---|
| `@xterm/xterm` | 稳定版 **6.0.0（2025-12-22）**；beta 6.1.0-beta.337（2026-11-08） | npm |
| `@xterm/addon-webgl` | 稳定版 0.19.0（2025-12-22）；beta 0.20.0-beta.330 | npm |
| 其他插件 | `@xterm/headless` 6.0.0；serialize 0.14.0；fit 0.11.0；search 0.16.0；web-links 0.12.0；unicode11 0.9.0；unicode-graphemes 0.4.0（README 标注 "experimental"）；image 0.9.0；ligatures 0.10.0 | npm；addons/addon-unicode-graphemes/README.md |
| 6.0.0 要点 | 支持同步输出 DEC 2026、OSC 52、ESM；滚动条换成 VS Code 的实现；修复部分 IME 重复输入；搜索加了缓存 | https://github.com/xtermjs/xterm.js/releases/tag/6.0.0 |
| VS Code | main 分支依赖 `@xterm/xterm ^6.1.0-beta.336`、`addon-webgl ^0.20.0-beta.329`、`@xterm/headless ^6.1.0-beta.334`、`node-pty ^1.2.0-beta.18`。`src/vs/platform/terminal/node/ptyService.ts` 在 pty host 里用 `@xterm/headless` 加 `XtermSerializer` 维护无头副本，重连时重放 | https://github.com/microsoft/vscode/blob/main/package.json ；ptyService.ts |
| Unicode 正确性（相关 issue） | #6274 国旗 emoji 被拆成两个字形（2026-10-29 已关闭）；#6251 unicode-graphemes 把 31 个不可见格式字符算作占格；#6256 日文 IME 不显示当前转换段；#4867 缅甸文；#2570 不支持 XTPUSHSGR/XTPOPSGR | GitHub issues |
| 吞吐对比 | **没找到公开的 xterm.js 与 ghostty-web（或 libghostty-vt WASM）正面基准**。ghostty-web 仓库有 `bench/versus.ts`（mitata），但没有公布结果。libghostty-vt 的原生吞吐数字只有厂商自测（见 1.1）。WASM 下的吞吐【未确认】 | coder/ghostty-web/bench；WebSearch |

xterm.js 的强项是成熟度：
- IME 由 CompositionHelper 处理，textarea 跟随光标。
- 有 `screenReaderMode`。
- 插件齐全。
- 在 VS Code 中经过大规模长期使用。

它的弱项在 Unicode 和字素簇的边角情况，以及解析器是纯 JS 实现。

---

## 6. PTY：portable-pty 和 node-pty

| 项 | portable-pty | node-pty |
|---|---|---|
| 最新版本 | **0.9.0（2025-02-11）**，没有更新的发布。wezterm main 分支上 `pty/Cargo.toml` 仍是 0.9.0，有未发布的改动：Windows `kill()` 修复（#7709，2026-06-07，TerminateProcess 返回非零才表示成功，0.9.0 判断反了）、winapi 换成 windows-sys（#8073，2026-08-25） | **1.1.0（2025-12-22）**；beta 1.2.0-beta.18（2026-10-23）。VS Code 用的是 beta；mux 用的 fork 是 `@lydell/node-pty 1.2.0-beta.18` |
| Windows | ConPTY，通过 kernel32 调用；**优先加载放在旁边的 `conpty.dll` + OpenConsole.exe**（`pty/src/win/pseudocon.rs`），标志位 `INHERIT_CURSOR / RESIZE_QUIRK / WIN32_INPUT_MODE` | ConPTY（1809+），旧系统回退到 winpty。包内自带 ConPTY **1.23.251008001** 的 `conpty.dll` + `OpenConsole.exe`（x64、arm64） |
| Electron 构建 | 编进 Core 的 NAPI 插件，没有额外原生模块 | 1.x 基于 N-API（`node-addon-api ^7.1.0`）；包内带 darwin-arm64/x64 和 win32-x64/arm64 预编译（Linux 没有），安装脚本 `node scripts/prebuild.js \|\| node-gyp rebuild`。因为是 N-API，按说不用为每个 Electron 版本重新编译【推测】。README 写明 "not thread safe" |
| 来源 | https://crates.io/crates/portable-pty ；https://github.com/wezterm/wezterm/tree/main/pty | `npm view node-pty`；`npm pack node-pty@1.1.0` 后的文件列表和 README |

结论：
- **PTY 放在 Core 里，用 portable-pty。**
- Agent 后台 shell 和 Monitor 都在 Core，PTY 如果放在 JS 主进程，Core 的工具 I/O 就要反向依赖 JS，和"Core 负责工具 I/O、沙箱、权限"的划分冲突。
- 建议依赖锁定 wezterm main 的某个 git rev，或者 vendor 一份，以拿到 Windows `kill()` 修复。
- Windows 包里随附 `conpty.dll` + `OpenConsole.exe`，做法同 node-pty 和 WezTerm。这对 ConPTY 的渲染和输入正确性影响很大【推测】。

---

## 7. 三种架构对比

共同前提：PTY 在 Core；Core 的 NAPI 插件跑在 Electron 主进程；渲染端到 Core 走 `MessageChannelMain` 端口，传 ArrayBuffer。

| 维度 | (a) Core 持有状态 + 推帧 + 自研渲染 | (b) ghostty-web 在渲染端 + 字节流 | (c) Core 权威 + ghostty-web 显示（同一字节流） |
|---|---|---|---|
| Agent 无头读屏 | 有，就是同一个对象 | **没有**，要另外补 | 有 |
| Agent 屏幕与用户屏幕一致性 | **构造上一致**（同一实例、同一 render state） | — | **只是最终一致**。两套解析器版本不同（1.0.1 和 2025-12 快照加补丁），reflow、OSC 133 等行为可能不一样（1.0.1 恰好修了 OSC 133 改列宽残留）；resize 必须按字节序对齐；ghostty-web 会自己应答 DA/DSR，Core 也会应答，**需要打补丁或过滤** |
| IPC 带宽 | 由帧率和变化行数决定，和输出量**无关**。用 row id 复用后，滚动输出只发新行。粗估每行约 2KB（200 列 × 约 10 B），一整帧约 100KB，60fps 上限约 6MB/s；隐藏的终端不发【估算】 | 等于 PTY 输出速率。`cat` 大文件时全部字节都要过 IPC，并在渲染进程**主线程**同步解析（ghostty-web 的 write 是同步调用） | 和 (b) 一样，外加 Core 也要解析一遍；要做流控，渲染端跟不上时丢流再重同步 |
| 渲染进程重载 / 会话恢复 | 重新要一帧全量即可，几乎零成本；scrollback 按需取 | 状态丢失，除非另外保存 | 要靠 Core 用 formatter 输出 VT（加 extras）后，先 RIS 再重放（mux 用 xterm serialize 就是这么做的），恢复是近似的；snapshot 格式和 ghostty-web 不兼容 |
| App 重启后恢复 | Core 持久化 snapshot，版本不一致时降级到 VT 或纯文本 | 无 | 同 (a) |
| 输入链路 | 键盘事件经 IPC 到 Core，由 libghostty 编码后写 PTY，多一跳进程内 IPC（亚毫秒级）【推测】 | 渲染端编码后发字节 | 渲染端编码（ghostty-web 自己的模式状态） |
| 渲染器工作量 | 要写 Canvas 渲染、选区 UI、IME、滚动、查找 UI、链接、a11y。可以 fork ghostty-web 的 `CanvasRenderer`（接口解耦），也可以评估 wterm DOM 渲染器配一个自定义 RemoteCore【推测】 | 现成 | 现成，但要绕开或修掉第 3 节列的问题 |
| IME（中文用户关键） | 自己做：textarea 跟随光标，绘制预编辑文本 | 有已知问题（#97、#119，预编辑不显示） | 同 (b) |
| Windows | x64 DLL 有测试；arm64 只构建不运行；MSVC 链接方式要验证 | WASM 与平台无关 | 两边的风险叠加 |
| 成熟度风险 | 主要在我们自己的渲染器；libghostty-vt 1.0.1 本身风险低（JetBrains、Neovim 等在用，持续 AFL++ fuzz） | 高：上游停在 0.4.0，基于旧快照，维护不活跃 | 高，原因同 (b)，再加双解析器的一致性问题 |
| 工作量【估算，1 人】 | Core 侧（终端线程、effects、帧编码协议、编码器、选区和搜索、formatter 和 snapshot）约 2 周；渲染器（基于 fork）2–3 周；IME、剪贴板、滚动、查找、链接、基础 a11y 1.5–2 周。**合计约 5.5–7 周** | MVP 约 1 周，但不满足需求 (2) | Core 侧约 1.5 周；ghostty-web 集成、应答去重、有序 resize、重连重放、流控约 1.5 周；**MVP 约 3 周**，之后修 ghostty-web 或维护 fork 的长尾成本无法估计 |

补充说明：
- **(c) 的变体 (c′)**：渲染端改用官方 `ghostty-vt-1.0.1-small.wasm`（846KB，和 Core 同版本）加自研渲染。这样两侧解析一致，重载时可以用 snapshot 精确恢复（先 READY 再补历史）。它比 (a) 多出的只有一点：滚动 scrollback 和选区可以在渲染端本地完成，不用往返 Core。代价是渲染器照样要写，还要维护双解析、有序 resize 和流控。按投入产出看，(c′) 不如 (a)。
- **主进程负载**：(a) 中，解析和 render state 更新都在 Core 的 Rust 线程里做，主进程 JS 只负责把帧转给 MessagePort（每个可见终端每秒最多 60 次）。如果以后主进程事件循环成了瓶颈，可以把 Core 挪到 `utilityProcess`，渲染端协议不用改【推测】。

---

## 8. 推荐方案

### 8.1 选 (a)，同时把"渲染层可替换"作为明确的设计约束

1. **Core（Rust）**
   - 每个会话一个 IO 线程：portable-pty 读取，然后 `ghostty_terminal_vt_write`。
   - 注册 `WRITE_PTY`、`TITLE_CHANGED`、`PWD_CHANGED`、`BELL`、`SEMANTIC_PROMPT`、`CLIPBOARD_*`、`RENDER_HOLD` 等回调。
   - 每个可见终端一个 `GhosttyRenderState`，用两段式更新，只在 `begin_update` 时持锁。
2. **帧协议**
   - 帧内容：全局脏状态、光标、颜色、行列表（row id、viewport_y、行内选区）、脏行的 cells（码点或字素加样式索引）、样式表增量。
   - 编码成二进制 ArrayBuffer，经 MessagePort 发出；按 rAF 节奏拉取，不由 Core 主动推送。尊重 render hold。
3. **Agent 接口**
   - 用 formatter（PLAIN、unwrap、trim）读当前屏幕和 scrollback。
   - 用 OSC 133 语义提示符判断命令边界和退出状态。
   - 用 search API 查找。
   - 整个过程不依赖渲染端。
4. **渲染端（React 里的一个组件）**
   - fork ghostty-web `CanvasRenderer`，实现一个由帧协议驱动的 `RemoteRenderable`。
   - 键盘、鼠标、粘贴事件原样发给 Core 编码（用 Kitty 键盘协议和鼠标模式时，Core 知道当前模式状态）。
   - IME：隐藏 textarea 跟随光标，在光标处绘制预编辑文本。
   - 选区：指针事件发给 Core 的 selection gesture API，选区结果通过帧里的行内区间带回来。
5. **持久化**：Core 定期或在退出时把 snapshot 写盘；版本不一致时降级为 formatter VT 重放。

### 8.2 回退方案（渲染器做不出来或延期时）

- Core 侧不变，仍是权威。
- 渲染端切到"字节流副本模式"：xterm.js 6 加 WebGL 插件，喂同一份字节流。重连时 Core 用 formatter VT 输出加 RIS 重放，模式同 VS Code 和 mux。
- 渲染端的查询应答要丢弃（只认 Core 的 `WRITE_PTY`）。
- 回退时**用 xterm.js，不用 ghostty-web**：xterm.js 的 IME、a11y、插件和维护状况都明显更好。
- 代价：Agent 屏幕和用户屏幕由两个不同的仿真器算出，边角情况（字素簇、reflow）可能不一致。这一点要写进已知限制。

### 8.3 什么情况下改选 ghostty-web

满足以下全部条件时，可以重新评估把 ghostty-web 当作 (c) 的显示层：
- ghostty-web 切到官方 libghostty-vt 1.x WASM 并发布稳定版；
- CJK IME 位置问题（#97）和 CSP 加载问题（#188）已修复；
- 维护者回应了路线图（#156）。

截至 2026-11-14，这三条都不满足。

---

## 9. M0 spike 要回答的问题

1. **链接**
   - NAPI-RS（napi 3.16.2，2026-11-11）在 `aarch64-apple-darwin` 上静态链接 XCFramework 里的 `libghostty-vt.a` 是否顺利？
   - 在 `x86_64-pc-windows-msvc` 上该选哪条路：官方 DLL 放在 `.node` 旁边（Node 的 dlopen 能否从 .node 所在目录找到依赖 DLL，【未确认】）、lld 加预编译静态库（gpui-cn 的做法）、还是在 CI 里用 Zig 0.17 从源码编译？
   - `aarch64-pc-windows-msvc` 能否链接并实际运行（官方从没跑过 arm64 zip）？
2. **绑定**：自建 `-sys`（bindgen 生成后提交）和直接用 libghostty-rs main（固定 rev）比，哪个维护成本低？libghostty-rs 何时发布对齐 1.0 的版本？
3. **延迟**：键盘输入到回显上屏的端到端延迟（两跳进程内 IPC 加 PTY），目标 p50 < 10ms、p99 < 25ms【估算目标】；和 xterm.js 直连字节流的方案对比。
4. **吞吐**：`cat` 100MB 文件、`yes`、`find /` 时，Core CPU 占用、帧率、IPC 字节数，以及主进程事件循环延迟。同时验证 1.0.1 的 scrollback 限制配置（按行还是按字节）。
5. **渲染器**：fork ghostty-web `CanvasRenderer` 改造成 RemoteRenderable 的工作量；CJK 全角、emoji、ZWJ 字素、powerline 字形的显示效果；DPR 为小数时的接缝（ghostty-web #198 提到过）。另外评估 wterm DOM 渲染器配自定义 `TerminalCore` 能否作为 a11y 更好的备选。
6. **IME**：macOS 拼音和 Windows 微软拼音下，候选框位置和预编辑文本显示是否正确。
7. **Snapshot**：重启恢复的耗时和体积（1 万行 scrollback）；格式版本不一致时的降级路径。
8. **ConPTY**：随附 `conpty.dll` 1.23.x 加 OpenConsole.exe 后，portable-pty 在 Windows 11 x64/arm64 上 resize、Ctrl+C、kill（需要 #7709 修复）是否正常。
9. **Agent 读屏一致性**：对同一会话，验证 formatter 输出和渲染端看到的帧逐格一致（(a) 下应当恒等）；alt screen（vim/htop）时 Agent 读到的是什么。

---

## 10. 来源（访问日期均为 2026-11-14）

- libghostty-vt 文档首页：https://lib.ghostty.org/vt/
- 安装与产物：https://lib.ghostty.org/vt/installing.html
- 发布说明：https://lib.ghostty.org/vt/release-notes.html
- 稳定性：https://lib.ghostty.org/vt/stability.html
- 约定与线程：https://lib.ghostty.org/vt/conventions.html
- 渲染：https://lib.ghostty.org/vt/guide-rendering.html
- 快照：https://lib.ghostty.org/vt/guide-snapshots.html
- Effects：https://lib.ghostty.org/vt/guide-effects.html
- 可选特性：https://lib.ghostty.org/vt/features.html
- WASM API：https://lib.ghostty.org/vt/group__wasm.html
- Formatter：https://lib.ghostty.org/vt/group__formatter.html
- 产物目录与校验：https://release.files.ghostty.org/libghostty-vt/1.0.1/SHA256SUMS
- 1.0 发布博客：https://mitchellh.com/writing/libghostty-1-0
- Ghostty tag：`gh api repos/ghostty-org/ghostty/git/tags/{6b38d55f…, e9dc690b…}`
- Zig 版本：https://ziglang.org/download/index.json
- libghostty-rs：https://github.com/Uzaaft/libghostty-rs ，https://crates.io/crates/libghostty-vt
- gpui-cn ghostty-vt-sys：https://github.com/prabirshrestha/gpui-cn/tree/main/crates/ghostty-vt-sys ，https://crates.io/crates/ghostty-vt
- ghostty-web：https://github.com/coder/ghostty-web ，https://www.npmjs.com/package/ghostty-web
- coder/mux：https://github.com/coder/mux （package.json、src/node/services/terminalService.ts、src/browser/components/TerminalView/TerminalView.tsx）
- awesome-libghostty：https://github.com/Uzaaft/awesome-libghostty
- wterm：https://github.com/vercel-labs/wterm
- restty：https://github.com/wiedymi/restty
- libghostty-vt-node：https://github.com/coder/libghostty-vt-node
- electron-libghostty：https://github.com/philipp-spiess/electron-libghostty
- xterm.js 6.0.0：https://github.com/xtermjs/xterm.js/releases/tag/6.0.0 ；npm `@xterm/*`
- VS Code：https://github.com/microsoft/vscode/blob/main/package.json ，src/vs/platform/terminal/node/ptyService.ts
- portable-pty：https://crates.io/crates/portable-pty ，https://github.com/wezterm/wezterm/tree/main/pty ，https://github.com/wezterm/wezterm/pull/7709
- node-pty：https://www.npmjs.com/package/node-pty （以 1.1.0 tarball 内容为准）
- napi：https://crates.io/crates/napi ；Electron：npm `electron` 45.3.2（2026-11-13）
