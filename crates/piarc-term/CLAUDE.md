# piarc-term

终端会话（ADR-0017）：portable-pty 管 PTY，libghostty-vt 持有终端状态，按 viewer 编码增量帧（格式在 `piarc_protocol::term_frame`）。libghostty-vt 的原始绑定、预编译产物的下载与校验在 `piarc-ghostty-sys`（本文件一并说明）。不负责渲染（`apps/desktop/src/renderer/terminal/`）与 Core 的终端注册表（`piarc-core::terminal`）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-term` | safe 封装（effects、render state、键盘编码、formatter、render hold）、帧编码器、键位表；`tests/pty.rs` 真实 PTY（Unix）；`tests/consistency.rs` 帧与 formatter 逐格比较 |
| `PIARC_UPDATE_FRAME_SAMPLES=1 cargo test -p piarc-term --test consistency` | 改了帧编码或格式后重写 TS 共享样本 `apps/desktop/src/renderer/terminal/frame/frame-samples.json`（不带变量时只检查它是最新的） |
| `cargo test -p piarc-ghostty-sys` | 产物校验（官方 `SHA256SUMS` 及其真实签名）与链接冒烟 |
| `node scripts/dev/gen-ghostty-bindings.mjs [--check]` | 用 `.tools/bin/bindgen`（`install-tools.mjs`，0.73.2）重新生成 `piarc-ghostty-sys/src/bindings.rs`；`--check` 只比对 |

## 预编译产物与链接

- 供应链入口只有 `crates/piarc-ghostty-sys/ghostty-vt.lock.json`（版本、URL、SHA-256、minisign 公钥）；改它要评审，摘要要与官方签名过的 `SHA256SUMS` 一致（单元测试检查）。
- `build.rs`：缓存（默认 `.tools/cache/ghostty-vt/<版本>/`，`PIARC_GHOSTTY_VT_CACHE` 覆盖，`PIARC_GHOSTTY_VT_OFFLINE=1` 禁止下载）缺文件时用 `curl` 下载 → 校验 SHA-256 → 校验 `.minisig` → `tar` 解到 `OUT_DIR`。校验失败直接失败并说明，不会自动重下；确认缓存坏了就删掉那个文件和它的 `.minisig`。
- macOS 静态链接 XCFramework 的 `libghostty-vt.a`；Windows MSVC 链接 `ghostty-vt.dll` 的导入库，DLL 必须在 `.node` 旁边（`build-core.mjs` 复制、Forge 放进 `native/` 并留在 asar 外，`apps/desktop/core-binary.mjs` 的 `CORE_WINDOWS_DLLS`）。理由见 `docs/spikes/S07-terminal.md` 第 3 节。
- 绑定按 C23 生成（枚举统一为 `int`）；带类型转换的宏与 `static inline` 函数不在绑定里，safe 封装自己定义（如 `MODE_SYNCHRONIZED_OUTPUT`、`keymap::MOD_*`）。

## 不变量

- `unsafe` 只在 `piarc-ghostty-sys` 与本 crate 的 `vt` 模块；其余模块用 `vt` 的 safe API。按输出类型读值的 FFI 辅助函数都是 `unsafe fn`，调用处写明数据键与类型的对应。
- libghostty-vt 的线程约定：同一 handle 不并发调用（`Terminal`、`RenderState`、`KeyEncoder` 是 `Send` 不是 `Sync`，共享时放在 `Mutex` 里）；回调只往 `Effects` 记录追加，不写终端、不阻塞；取帧时只在 `begin_update` 期间持终端锁。
- IO 线程读 PTY 并 `vt_write`；写线程独占 PTY master（输入、键盘编码、尺寸、查询应答）。`Session` 的 `write`/`key`/`resize` 只发消息，不阻塞调用者；`frame` 会等终端锁，调用方放到阻塞线程池（`piarc-core::terminal`）。
- 帧编码器按 viewer 记住它持有的行与样式；换 viewer 或 `full` 请求时发 RESET 帧。脏行要与已发内容逐格比较后再决定发不发（libghostty-vt 滚动后把所有行标脏）。
- 关闭会话时不信 `ChildKiller::kill` 的返回值（portable-pty 0.9.0 在 Windows 上把成功报成错误），退出以 IO 线程的 `wait` 为准。

## 易错点

- `GhosttyBuffer`/`GhosttyString` 的指针只在调用期间有效；按键文本由事件借用（不复制），编码后要清空。
- 写过空格的格子有文本 `" "`，从未写过的格子文本为空；两者在纯文本里都是空格。
- formatter 默认格式化整个屏幕（含 scrollback）；只要视口时要设视口选区（`vt::viewport_text`）。
- PTY 集成测试设 `PS1`、`ENV` 避开用户的 shell 配置；Windows 下这些测试不编译（ConPTY 由 W0 验证）。

## 参考

- ADR-0017、ADR-0023；架构第 6.11、7.1 节；`docs/spikes/S07-terminal.md`；`docs/research/terminal-libghostty.md`。
