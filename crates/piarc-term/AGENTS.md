# piarc-term

终端会话（ADR-0017）：portable-pty 管 PTY，libghostty-vt 持有终端状态，按 viewer 编码增量帧（格式第 2 版，定义在 `piarc_protocol::term_frame`）。T34 起还有：选区手势、选区文本、视口滚动与 OSC 8 链接（`vt/selection.rs`）、写线程上的指针事件（`session/pointer.rs`）、默认颜色、停拉后的 `Event::Output`。T33 起还有：副作用回调（`vt/effects.rs`）、读屏与搜索（`vt/formatter.rs`、`vt/search.rs`）、OSC 133 命令记录（`commands.rs`）、终端的保存与恢复（`snapshot.rs`）、shell integration（`shell.rs` 与 `shell-integration/`）、鼠标与粘贴编码。libghostty-vt 的原始绑定、预编译产物的下载与校验在 `piarc-ghostty-sys`（本文件一并说明）。不负责渲染（`apps/desktop/src/renderer/terminal/`）、Core 的终端注册表与会话终端任务（`piarc-core::terminal`），也不负责进程树（`piarc-exec::TerminalTree`）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-term` | safe 封装（effects、render state、键盘与鼠标编码、粘贴、formatter、搜索、snapshot、render hold）、命令记录、帧编码器、键位表；`tests/pty.rs` 真实 PTY（Unix，含隐藏终端不出帧）、`tests/pty_windows.rs` 真实 ConPTY（Windows：cmd、PowerShell、Git 自带的 vim）；`tests/consistency.rs` 帧与 formatter 逐格比较；`tests/read_screen.rs` 读屏与 render state 逐格一致（宽字符、折行、alt screen）、1 万行 scrollback 搜索不阻塞写入、snapshot 三级降级 |
| `cargo test -p piarc-term --test pointer` | T34：真实 PTY 中的拖选与双击（帧带回选区列）、键入清除选区、滚轮与 scrollback、跟踪鼠标的程序收到按下（Shift 时选区）、停拉后输出唤醒一次、默认颜色进入帧与 OSC 11 应答 |
| `cargo test -p piarc-term --test shell_integration` | 真实 zsh 与 bash（macOS）的 OSC 133 命令边界、退出码与 OSC 7；`shell_integration_windows.rs` 是 Git Bash 与 PowerShell（Windows CI） |
| `PIARC_UPDATE_FRAME_SAMPLES=1 cargo test -p piarc-term --test consistency` | 改了帧编码或格式后重写 TS 共享样本 `apps/desktop/src/renderer/terminal/frame/frame-samples.json`（不带变量时只检查它是最新的） |
| `cargo test -p piarc-ghostty-sys` | 产物校验（官方 `SHA256SUMS` 及其真实签名）与链接冒烟 |
| `node scripts/dev/gen-ghostty-bindings.mjs [--check]` | 用 `.tools/bin/bindgen`（`install-tools.mjs`，0.73.2）重新生成 `piarc-ghostty-sys/src/bindings.rs`；`--check` 只比对 |

## 预编译产物与链接

- 供应链入口只有 `crates/piarc-ghostty-sys/ghostty-vt.lock.json`（版本、URL、SHA-256、minisign 公钥）；改它要评审，摘要要与官方签名过的 `SHA256SUMS` 一致（单元测试检查）。
- `build.rs`：缓存（默认 `.tools/cache/ghostty-vt/<版本>/`，`PIARC_GHOSTTY_VT_CACHE` 覆盖，`PIARC_GHOSTTY_VT_OFFLINE=1` 禁止下载）缺文件时用 `curl` 下载 → 校验 SHA-256 → 校验 `.minisig` → `tar` 解到 `OUT_DIR`。校验失败直接失败并说明，不会自动重下；确认缓存坏了就删掉那个文件和它的 `.minisig`。
- macOS 静态链接 XCFramework 的 `libghostty-vt.a`；Windows MSVC 链接 `ghostty-vt.dll` 的导入库，DLL 必须在 `.node` 旁边（`build-core.mjs` 复制、Forge 放进 `native/` 并留在 asar 外，`apps/desktop/core-binary.mjs` 的 `CORE_WINDOWS_DLLS`）。理由见 `docs/spikes/S07-terminal.md` 第 3 节。
- 绑定按 C23 生成（枚举统一为 `int`）；带类型转换的宏与 `static inline` 函数不在绑定里，safe 封装自己定义（如 `MODE_SYNCHRONIZED_OUTPUT`、`keymap::MOD_*`）。

## 线程模型

- 每个 `Session` 三个线程：`piarc-term-io` 读 PTY（64 KiB 一块，`Interrupted` 重试）并在终端锁内 `vt_write`、处理副作用；`piarc-term-writer` 独占 PTY master，按顺序写输入、键盘与鼠标编码、粘贴、尺寸与查询应答；`piarc-term-wait` 等程序退出。三个线程的主体都包在 `guarded` 里：panic 变成 `Event::Failed`，不拖垮进程。
- 写队列有界（`WRITER_QUEUE` 256 条）：`write`/`key`/`mouse`/`focus` 用 `try_send`，满了返回 `Busy`，不阻塞调用者；`paste` 等写线程答复（它要先读终端模式）。
- 事件（`Event`：标题、目录、铃声、命令开始与结束、剪贴板、退出、失败）在 IO 线程上调用 `EventHandler`：处理函数不能阻塞，Core 只做入队。
- 取帧、读屏、搜索、保存都要终端锁，调用方放到阻塞线程池；搜索分步进行，每步之间放开锁，所以长时间搜索时输出照常进入（`vt/search.rs`）。

## 指针、选区与视口（T34，ADR-0051）

- 指针事件经写线程（与按键同一队列，保持顺序）：程序跟踪鼠标（模式 9/1000/1002/1003）且不是按住 Shift 的左键时交给鼠标编码器；否则左键驱动 `SelectionGesture`（点击次数由 viewer 给出，内部换成相隔 1 ns 或 10 s 的时间），滚轮在主屏滚动视口、在备用屏且开启 1007 时发方向键。进行中的选区拖动不因模式变化而改道。
- 选区是终端自己的跟踪状态（`OPT_SELECTION`），帧经 render state 带回每行的选区列；选区文本用 formatter（合并折行、去行尾空格）。`Input`（键入、上屏文本、批准的命令）与按键、粘贴之后回到底部并清除选区；查询应答用 `Bytes`，不影响视口。
- `frame_parking(.., park)` 在持终端锁时置唤醒标记，帧非空时清除；IO 线程写入后见到标记就发一次 `Event::Output`。
- 拖动经过网格中线才包含该格（与终端惯例一致），测试按格的左右部分取坐标。

## 副作用回调（`vt/effects.rs`）

- 回调在 `vt_write` 内被 libghostty-vt 调用，只往 `Effects` 追加记录（应答字节、标题、目录、铃声、OSC 133 标记、剪贴板），不写终端、不阻塞、不分配终端资源以外的东西；IO 线程在 `vt_write` 返回后取走记录再处理（应答交给写线程，事件交给处理函数）。
- OSC 133 标记带一个 tracked point（`vt/tracked.rs`）记住它在网格中的位置：只能在持终端锁时创建、读取与释放，`commands.rs` 用它们算出命令输出的范围（最多保留 `MAX_COMMANDS` 64 条）。
- `CLIPBOARD_READ` 一律拒绝（只在 Kitty 粘贴事件的答复期间放行那一次）；`CLIPBOARD_WRITE` 由 `SessionConfig.clipboard_write` 决定，只接受标准剪贴板位置的 `text/*`，长度有上限（`CLIPBOARD_WRITE_MAX_BYTES`）。
- `RENDER_HOLD`：回调只记下 hold 开始，时间由会话的时钟（`SessionConfig.now`，测试注入）盖戳；hold 期间取帧返回开始时的画面，超过 `HOLD_TIMEOUT`（1 s）Core 侧主动结束 hold。
- scrollback 字节上限设为不限（`SCROLLBACK_MAX_BYTES`），行数上限由 `SessionConfig.scrollback_lines` 决定：libghostty-vt 默认的 10,000 字节上限会让大部分 scrollback 立即丢失（T10 留下的缺陷，T33 修正）。

## 保存与恢复（`snapshot.rs`）

- 文件 `sessions/<主会话 id>/terminals/<任务 id>.snap`（由 Core 决定路径），同一屏幕存三份：libghostty-vt 的 snapshot、formatter 的 VT 重放、纯文本，各带 FNV-1a 哈希。文件头记 libghostty-vt 版本与 `SNAPSHOT_FORMAT`。
- 恢复依次尝试：版本与格式都一致且能解码 → snapshot；否则在新终端里重放 VT → 重放段损坏时只恢复纯文本。结果（`Restored::Snapshot`/`Replay`/`Text`）告诉调用方用了哪一级。

## shell integration（`shell.rs`、`shell-integration/`）

- 脚本为 PiArc 自写（OSC 序列与 ZDOTDIR、包装 prompt 的思路与 Ghostty、VS Code 相同，没有复制它们的代码），`include_str!` 编进 crate，由 `shell::install` 写到 Core 数据目录的 `shell-integration/`，经 `PIARC_SHELL_INTEGRATION` 告诉脚本自己的位置。不改用户的任何启动文件。
- zsh：`ZDOTDIR` 指向 `zsh/`，其 `.zshenv` 还原用户的 `ZDOTDIR` 并读用户的 `.zshenv`，再装 precmd/preexec。bash（含 Git Bash）：`--rcfile piarc.bash -i`，脚本先按交互式（`PIARC_SHELL_LOGIN` 时按登录 shell）读用户文件，再加 `PROMPT_COMMAND` 与 `DEBUG` trap（bash 3.2 没有 `PS0`）。PowerShell：`-NoExit -Command . piarc.ps1`，包装 `prompt` 与 PSReadLine 的 Enter。其他 shell 原样启动，没有命令边界。
- 命令行以 `cmdline_url`（百分号编码）放在 OSC 133 C 里；bash 3.2 的 `printf %d "'c"` 对 0x7f 以上的字节给负数，编码时要 `& 255`。shell 处在 C locale 时 readline 把高位字节当 Meta 键，Core 给没有 locale 的终端补一个 UTF-8 locale（`piarc-core::tool_io::exec::terminal_env`）。

## 升级 libghostty-vt 的检查项

1. 改 `ghostty-vt.lock.json`，`node scripts/dev/gen-ghostty-bindings.mjs` 重新生成绑定并看 diff：回调签名、选项键、数据键、枚举值的变化都要在 `vt` 模块对应处理。
2. 判断 snapshot 格式是否变了：变了就把 `snapshot::SNAPSHOT_FORMAT` 加一（旧文件自动降级为 VT 重放）；`tests/read_screen.rs` 的 snapshot 用例与降级用例必须通过。
3. 检查默认值是否变化：scrollback 字节上限、formatter 的 extras、键盘与鼠标编码的选项。
4. `PIARC_UPDATE_FRAME_SAMPLES=1 cargo test -p piarc-term --test consistency` 检查帧样本是否漂移；有漂移先查清原因。
5. 两个平台的 `cargo test -p piarc-term`（Windows 上含 shell integration 测试）。

## 不变量

- `unsafe` 只在 `piarc-ghostty-sys` 与本 crate 的 `vt` 模块、Windows 专用的 `console` 模块（一次 `SetConsoleCtrlHandler`）；其余模块用 `vt` 的 safe API。按输出类型读值的 FFI 辅助函数都是 `unsafe fn`，调用处写明数据键与类型的对应。
- libghostty-vt 的线程约定：同一 handle 不并发调用（`Terminal`、`RenderState`、`KeyEncoder` 是 `Send` 不是 `Sync`，共享时放在 `Mutex` 里）；回调只往 `Effects` 记录追加，不写终端、不阻塞；取帧时只在 `begin_update` 期间持终端锁。
- IO 线程读 PTY 并 `vt_write`；写线程独占 PTY master（输入、键盘编码、尺寸、查询应答）。`Session` 的 `write`/`key`/`resize` 只发消息，不阻塞调用者；`frame` 会等终端锁，调用方放到阻塞线程池（`piarc-core::terminal`）。
- 帧编码器按 viewer 记住它持有的行与样式；换 viewer 或 `full` 请求时发 RESET 帧。脏行要与已发内容逐格比较后再决定发不发（libghostty-vt 滚动后把所有行标脏）。
- 关闭会话时不信 `ChildKiller::kill` 的返回值（portable-pty 0.9.0 在 Windows 上把成功报成错误），退出以等待线程的 `wait` 为准。
- 退出：等待线程 `wait` 程序，IO 线程读到输出结束后取它的退出码再发 `Exited`。Windows 上 ConPTY 只在伪控制台关闭时结束输出，所以等待线程在程序退出后让写线程结束、释放 master（W0 实测：不这样做时自行退出的程序永远没有 `Exited`）。
- Windows 上启动程序前清掉本进程"忽略 Ctrl+C"的标志（`console` 模块）：它会被子进程继承，PiArc 若被这样的进程启动，终端里的 Ctrl+C 就不起作用（W0 在智能体会话中实测复现）。

## 易错点

- `GhosttyBuffer`/`GhosttyString` 的指针只在调用期间有效；按键文本由事件借用（不复制），编码后要清空。
- 写过空格的格子有文本 `" "`，从未写过的格子文本为空；两者在纯文本里都是空格。
- `TextRange::LastRows(n)` 是去掉末尾空行之后的最后 n 行（光标下面的空白不算）；按 libghostty-vt 的页粒度裁剪 scrollback，测试要写足够多的行（几千行）才会真的丢掉旧行。
- shell integration 测试里 macOS 的临时目录是 `/var/…`，OSC 7 报的是 `/private/var/…`：比较前 `canonicalize`；等命令结束事件要循环收，不要假设只来一个。
- formatter 默认格式化整个屏幕（含 scrollback）；只要视口时要设视口选区（`vt::viewport_text`）。
- PTY 集成测试设 `PS1`、`ENV` 避开用户的 shell 配置；Windows 版（`pty_windows.rs`）用 `PROMPT=$$$S` 得到 `$ ` 提示符，屏幕文本会去掉行尾空格，判断提示符时比较 `$`。
- ConPTY 下回车写 `\r`（字节 0x0D）；在 cmd 里判断 Ctrl+C 生效要等命令的第一行真实输出（例如 ping 的 `TTL=`），只等回显的命令行会在程序启动前就发出 Ctrl+C。
- 不随附 `conpty.dll`/OpenConsole.exe：portable-pty 0.9.0 先按 DLL 搜索路径找 `conpty.dll`，找不到才用系统 `kernel32` 的 ConPTY；PiArc 用系统的（S7 报告第 10 节）。

## 参考

- ADR-0017、ADR-0023；架构第 6.11、7.1 节；`docs/spikes/S07-terminal.md`；`docs/research/terminal-libghostty.md`。
