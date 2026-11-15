# 0017. 内置终端：终端状态由 Core 中的 libghostty-vt 持有，渲染层可替换

- 状态：已接受
- 日期：2026-11-14
- 取代：无
- 相关：架构文档第 6.11、7.1、16 章；`docs/research/terminal-libghostty.md`

## 背景

PiArc 的终端有两种用途：

1. 用户可交互的终端面板；
2. agent 的后台命令、Monitor 类工具。agent 必须能在界面没打开时读到当前屏幕内容（无头读屏）。

产品负责人要求终端基于 libghostty，以获得更稳定的性能。调研事实（2026-11-14，详见调研文档）：

- **libghostty-vt 1.0.1**（2026-11-11，MIT）提供终端状态、带两层脏标记和跨帧行 id 的 render state、Kitty / legacy 键盘编码、鼠标编码、选区手势、搜索、formatter（plain / VT / HTML）、snapshot。它**不做渲染**。C ABI 自 1.0 起稳定，snapshot 字节格式不在承诺内。官方预编译产物覆盖 macOS（XCFramework，仅静态库）、Windows x64 与 arm64（gnu ABI；arm64 只构建、从未运行；MSVC 的 link.exe 不能用其静态库，应改用 DLL）、wasm32。从源码构建必须用 Zig 0.17。
- **没有官方 Rust crate。** 社区 crate 要么还没对齐 1.0，要么刚发布。
- **ghostty-web**（npm 稳定版 0.4.0，2025-12-09）没有迁到 libghostty-vt 1.0，基于 2025-12 的快照加补丁；只有 Canvas 2D 渲染；WASM 以 data: URI 内联，严格 CSP 下会被拦；中日韩输入法的预编辑文本不显示、候选框位置有问题；几乎没有无障碍支持；维护不活跃。
- **xterm.js 6** 加 WebGL 插件成熟；VS Code 在 pty host 中用 `@xterm/headless` 维护一份无头副本，再加 serialize 重放。
- **PTY**：portable-pty 0.9.0 支持 ConPTY，仍是 2025-02 的版本；node-pty 1.1.0 基于 N-API。

## 决策

1. **终端状态只在 Core 中维护一份。** `piarc-term` 用 portable-pty 管 PTY，用 libghostty-vt 持有每个终端的状态。每个终端一个 IO 线程负责读 PTY 和写入解析器；查询应答（`WRITE_PTY`）、标题、工作目录、OSC 133 语义提示符等副作用回调由 Core 注册和处理。
2. **agent 直接在 Core 里读屏。** 用 formatter 输出纯文本形式的屏幕和 scrollback，用 OSC 133 判断命令边界与退出状态，用 search API 查找，整个过程不依赖界面。用户看到的屏幕和 agent 读到的屏幕来自同一个终端实例。
3. **渲染进程只画帧，不解析 VT。** Core 按 render state 生成增量帧：光标、颜色、行列表（行 id、视口位置、行内选区）、脏行的单元格、样式表增量，编码成二进制 `ArrayBuffer`，经 MessagePort 送到渲染进程。由渲染进程按 `requestAnimationFrame` 节奏拉取，Core 不主动推送；隐藏的终端不产生帧；同步输出模式下遵守 render hold。
4. **渲染层可替换。** 第一版渲染器从 ghostty-web 的 `CanvasRenderer`（MIT，输入是 `IRenderable` 接口，与其 WASM 终端解耦）fork 改造，实现由帧协议驱动的数据源。键盘、鼠标、粘贴事件原样发给 Core，由 libghostty-vt 按当前终端模式编码后写入 PTY。输入法用跟随光标的隐藏 textarea，并在光标处绘制预编辑文本。M0 同时评估 wterm 的 DOM 渲染器（Apache-2.0，只更新脏行，原生选区与屏幕阅读器可用）作为无障碍更好的备选数据源接入方式。
5. **绑定方式。** 自己维护一个很薄的 `-sys` crate：bindgen 生成的绑定提交进仓库，链接官方预编译产物并校验 SHA256 与 minisign 签名；safe 封装只覆盖 PiArc 用到的 API。版本精确锁定。
6. **持久化。** Core 在退出时与定期把终端 snapshot 写盘，用于应用重启后恢复；snapshot 版本不一致时降级为 formatter 输出的 VT 重放，再不行就只恢复纯文本。
7. **退路。** 如果自研渲染器在 M0 或 M3 无法达标：Core 侧不变，仍是唯一权威；渲染进程改用 xterm.js 6 + WebGL 插件，按"字节流副本"模式接收同一份输出，重连时由 Core 用 formatter 输出 VT 重放；渲染端产生的查询应答一律丢弃，只认 Core 的应答。退路用 xterm.js，不用 ghostty-web。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| ghostty-web 在渲染进程解析和渲染，Core 只转发字节流 | 现成，MVP 约 1 周 | agent 无法无头读屏；大量输出时全部字节过 IPC 并在界面线程同步解析；渲染进程重载即丢状态；ghostty-web 自身成熟度问题 | 否决 |
| Core 与渲染进程各解析一遍同一字节流（ghostty-web 显示） | 渲染器现成，agent 可读屏 | 两个解析器版本不同，agent 与用户看到的屏幕只能"最终一致"；需要过滤重复应答、按字节序对齐 resize、做流控；ghostty-web 的问题全部继承 | 否决 |
| 同上，但渲染端用官方 1.0.1 WASM 加自研渲染器 | 两侧解析一致；scrollback 与选区可在本地完成 | 渲染器照样要写，还要维护双解析、有序 resize 与流控，投入产出不如本决策 | 否决 |
| xterm.js（含 `@xterm/headless` 副本） | 最成熟，VS Code 同款 | agent 与用户的屏幕由两个仿真器算出；不满足"基于 libghostty"的要求 | 作为退路 |

## 后果

- 正面：
  - agent 读屏与用户所见在构造上一致；
  - IPC 流量由帧率和变化行数决定，与程序输出量无关，`cat` 大文件也不会冲击界面线程；
  - 渲染进程崩溃或重载时只需重拉一帧；
  - 解析与状态更新在 Core 的 Rust 线程中进行，不占主进程事件循环。
- 负面与代价：
  - 渲染器、选区界面、输入法、查找、链接、基础无障碍都要自己做，粗估 1 人 5.5–7 周（Core 侧约 2 周、渲染器 2–3 周、其余 1.5–2 周）；
  - 键入回显多经过一次进程内 IPC，延迟需要在 M0 实测；
  - CI 要处理 libghostty-vt 的预编译产物与 Windows 链接方式。
- 需要配套做的事：
  - 帧协议纳入 `piarc-protocol` 的 schema 与 L1 契约测试；
  - 第三方许可证清单加入 libghostty-vt 与 fork 的 ghostty-web 渲染器代码（MIT，保留版权声明）。

## 重新评估的触发条件

- M0 S7 中任一项不达标：TUI 渲染正确性、大量输出时的帧率与主进程事件循环延迟、键入回显延迟、中文输入法；
- Windows MSVC 目标无法链接 libghostty-vt，或 win32-arm64 上无法运行；
- ghostty-web 迁到 libghostty-vt 1.x 官方 WASM 并发布稳定版，且修复了输入法位置与 CSP 加载问题，此时可以重新评估直接复用它的渲染层；
- libghostty-vt 的 1.x ABI 承诺被打破。
