# S7 终端验证：libghostty-vt + PTY + 帧协议 + 渲染器

T10，2026-11-15。对应架构第 16 章 S7、ADR-0017、风险 R15。

## 1. 结论

macOS 通过，余下的 Windows 项与真实输入法核对分别交给 CI/W0 与 R1；路线结论为**正式路线**（终端状态在 Core 的 libghostty-vt，渲染进程画 Core 的帧），不启用 xterm.js 退路。

| S7 通过标准 | macOS 结果 |
|---|---|
| vim、htop 等 TUI 渲染正确 | 通过。vim（备用屏幕、语法颜色、行号、中文、emoji）与 top（htop 未安装，以 top 代替）渲染正确，截图时刻页面重建的屏幕与 Core 的 formatter 输出逐字一致（第 7 节） |
| `cat` 100 MB 时界面帧率稳定、主进程事件循环 p99 ≤ 16 ms | 通过。100 MB：事件循环 p99 2.04 ms，渲染进程无超过 50 ms 的任务；持续 1 GB：120 Hz 屏上合成器呈现 680 帧中的 672 帧、丢 1 帧，每帧主线程工作 p99 6.6 ms（第 5.1 节） |
| 键入回显额外延迟 p95 ≤ 5 ms | 通过：p95 0.79 ms（200 个配对样本）。按 ADR-0017 原文让帧经事件 MessagePort 时是 p95 16.2 ms（Chromium 在按键之后把 MessagePort 消息推迟到下一帧之后处理），因此按 ADR-0023（已接受）改为拉取请求的返回值（第 5.2 节） |
| 中文输入法候选框与预编辑文本位置正确 | 预编辑在光标处绘制、隐藏 textarea 跟随光标，CDP 合成验证通过；系统候选框位置需要真实拼音输入法，清单交 R1（第 8 节） |
| formatter 输出与渲染帧逐格一致 | 通过。普通屏幕、备用屏幕、中日韩全角、emoji、ZWJ 与组合字符、宽字符换行、滚动，以及真实 vim，Rust 逐格比较全部一致；TS 解码器对同一组帧得到相同屏幕（第 6 节） |
| 四个目标都能链接，win32-arm64 实机运行 | darwin-arm64、darwin-x64 本机链接通过；Windows 两个目标选定"官方 DLL 放在 `.node` 旁边"，CI 已配置，结果待推送后核对；win32-arm64 实机运行由 W0 做（第 3 节） |

回显问题出在 Electron 的跨进程送达方式，不在 libghostty-vt 或渲染器；xterm.js 退路同样要把数据送进渲染进程，换退路解决不了它，改送达方式解决了它。

## 2. 验证环境

| 项 | 值 |
|---|---|
| 机器 | Apple M1 Max，32 GB，macOS 26.5.2（非基准机型 M1 Pro） |
| 显示 | devicePixelRatio 2。第 5 节的最终数据在内建 Liquid Retina XDR 屏（120 Hz）上测得；ADR-0023 之前经 MessagePort 的那组数据在 5K 外接屏（60 Hz）上测得，两组的帧数不能直接比较 |
| libghostty-vt | 1.0.1 官方预编译产物（`vt-1.0.1`，提交 `108cacb1…`） |
| portable-pty | 0.9.0（crates.io 发布版） |
| Electron | 45.3.2；Rust 1.99.1；NAPI-RS 3.16.2；bindgen-cli 0.73.2（libclang 来自 Xcode 命令行工具，Apple clang 17） |
| 测量形态 | 开发构建的打包产物（`npm run package:desktop -- --flavor development`），与 S1、S2 相同 |

## 3. 绑定与链接

### 3.1 `piarc-ghostty-sys`

- **锁定文件** `crates/piarc-ghostty-sys/ghostty-vt.lock.json`：版本、发布目录、三个压缩包的 SHA-256、minisign 公钥（`RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV`，来自官方安装文档），供应链入口只有这一处。
- **构建脚本** `build.rs`：从缓存取 `<file>` 与 `<file>.minisig`，缺了就用 `curl` 下载（`--proto =https`）；先比 SHA-256，再用 `minisign-verify` 0.3.0（零依赖，MIT）验签；任一不符即构建失败并说明原因，不会悄悄重新下载；通过后用系统 `tar`（macOS 与 Windows 10+ 的 bsdtar 都读 zip；Windows 取 `System32\tar.exe`，避开 Git 自带的 GNU tar）解到 `OUT_DIR`。
- **缓存**：默认 `.tools/cache/ghostty-vt/<版本>/`，`PIARC_GHOSTTY_VT_CACHE` 覆盖，`PIARC_GHOSTTY_VT_OFFLINE=1` 禁止下载。CI 三个作业按作业与目标缓存这个目录，缓存的文件每次使用都重新校验。
- **篡改实验**（A02，输出在 `tmp/evidence/T10/a02/`）：改缓存产物一个字节 → `SHA-256 mismatch: … expects c0f96312…, the file has d919ea49…`；交换签名两个字符 → `minisign signature check failed: The signature verification failed`；改锁定文件中的摘要 → 同样报 SHA-256 不符；还原后构建通过。单元测试用官方 `SHA256SUMS` 与其真实签名覆盖同样的情况，并检查锁定的摘要都在签名过的 `SHA256SUMS` 中。
- **绑定**：bindgen 生成后提交（`src/bindings.rs`，3,712 行，209 个函数，与 DLL 导出数相同），`node scripts/dev/gen-ghostty-bindings.mjs` 重新生成，`--check` 比对。头文件按 C23 编译：`GHOSTTY_ENUM_TYPED` 在 C23 下给枚举固定 `int` 底层类型，否则 clang 把只有非负值的枚举当 `unsigned int`、MSVC 当 `int`，同一份绑定会在两个平台上不同。绑定中没有 `long`（LLP64 与 LP64 唯一会不同的类型），结构体布局由 bindgen 的编译期断言在每个目标上检查。带类型转换的宏（如 `GHOSTTY_STYLE_FLAG_BOLD`）与 `static inline` 的 `ghostty_mode_new` bindgen 读不到，由 safe 封装自己定义。

### 3.2 macOS

XCFramework 里 `macos-arm64_x86_64/libghostty-vt.a` 是双架构静态库，`cargo:rustc-link-lib=static=ghostty-vt` 直接链接，不需要额外的系统库。本机 darwin-arm64 与交叉构建的 darwin-x64（`node scripts/dev/build-core.mjs --flavor all --target x86_64-apple-darwin`，两种构建都产出 Mach-O x86_64）链接通过；x64 的加载由 CI `core-load`（macos-15-intel）运行。

### 3.3 Windows：官方 DLL 放在 `.node` 旁边

选这条路，不选"lld + 预编译静态库"。理由：

1. 官方安装文档写明静态库"不能用 MSVC 的 link.exe"，"With MSVC, use the DLL"；DLL 的导入库 `lib/ghostty-vt.lib` 是给 MSVC 用的。lld + 静态库没有官方支持，gpui-cn 的做法还要改名 compiler_rt 的弱符号，并且要把整个 `.node` 的链接器换成 lld。
2. DLL 只导入 KERNEL32、ntdll 与 UCRT 的 api-ms-win-crt-*（`objdump -p` 核对，x64 与 arm64 相同），不需要另装运行库；导出 209 个 `ghostty_*` 函数。
3. Node 与 Electron 用 libuv 的 `uv_dlopen` 加载 `.node`，它调用 `LoadLibraryExW(path, NULL, LOAD_WITH_ALTERED_SEARCH_PATH)`（libuv `src/win/dl.c`），依赖 DLL 先在 `.node` 所在目录查找，所以放在旁边即可。

落地：`build.rs` 链接导入库（Rust 对 `dylib` 链接的符号生成 dllimport），并把 DLL 所在目录加入链接搜索路径，`cargo test` 运行时 cargo 会把它放进 PATH；`build-core.mjs` 在 Windows 目标上把 `ghostty-vt.dll` 复制到 `.node` 旁边；Forge 把它复制进 `native/` 并用 `asar.unpack` 留在 asar 之外；CI `core-build` 上传 `.node` 与 `.dll`，`core-load` 在同一目录加载。

**未验证**：本机不能链接 MSVC 目标（没有 MSVC 库，安装 cargo-xwin 属于全局安装，未做）。两个 Windows 目标的链接与加载结果要等推送后看 CI；win32-arm64 的 DLL 官方"只构建、从不运行"，实机运行由 W0 做（T10-A01 标为阻塞）。

## 4. PTY、线程与帧

### 4.1 portable-pty 用发布版 0.9.0

0.9.0 的 Windows `ChildKiller::kill` 把成功报成错误（`TerminateProcess` 返回非零时返回 `Err`），修复（wezterm #7709）只在 main 分支。选发布版的理由：git 依赖要拉整个 wezterm 仓库，还会带进 main 上未发布的 windows-sys 迁移，并要在 cargo-deny 里放开 git 来源；而这个缺陷只影响"kill 的返回值"。会话关闭时调用 kill 但不看返回值，以 IO 线程读到 EOF 后 `wait()` 的结果确认退出（`crates/piarc-term/src/session.rs` 文档）。cargo-deny 检查通过。

### 4.2 线程与 effects

- 每个终端两个线程：IO 线程读 PTY（64 KiB 一次），持锁 `vt_write` 后收集 effects；写线程独占 PTY master，负责输入、按终端当前模式编码按键（`ghostty_key_encoder_set_from_terminal` 后编码）与调整尺寸。NAPI 调用只往写线程的通道里放消息，不阻塞主进程。
- 注册的 effects：`WRITE_PTY`（应答经写线程写回，A04 集成测试里 DA1 应答 `CSI ? 62 ; 22 c` 被程序收到）、`TITLE_CHANGED`、`BELL`、`RENDER_HOLD`。回调只往终端的记录里追加，不写终端、不阻塞。
- 同步输出（mode 2026）：hold 开始时回调里把一份备用 render state 更新到当时的屏幕；下一次取帧时与当前 render state 交换，hold 期间返回空帧，超过 1 秒由 Core 关掉该模式。
- 帧：渲染进程每次拉取时，在阻塞线程池上持终端锁做 `begin_update`，放锁后 `end_update` 与编码，帧作为拉取请求（`ipcRenderer.invoke`）的返回值送回（ADR-0023）；libghostty-vt 的脏行标记是保守的（滚动后全部行都会标脏），编码器把脏行与 viewer 已有的内容逐格比较，未变的行只发 5 字节的行 id 引用。
- 事件：标题、响铃、退出以 JSON 发到路由 `term/<id>`（形状是草案，T33 定稿）。

### 4.3 帧格式草案

完整格式写在 `crates/piarc-protocol/src/term_frame.rs` 的模块文档（`term_frame::{encode, decode, Screen}`）。要点：14 字节头（版本、RESET/COLORS/EMPTY/HELD 标志、脏状态、序号、尺寸），光标 6 字节，颜色在变化或重置时才带（778 字节），样式表只发新增项（每项 16 字节，颜色已解析为 RGB），行列表按视口顺序列出每行的行 id，只有 viewer 没有的行带单元格（每格 4 字节加字素的 UTF-8）。没有变化时是 14 字节的空帧。渲染进程的 TS 解码器在 `apps/desktop/src/renderer/terminal/frame/`。

## 5. 测量数据

`npm run bench:s7`（`scripts/bench/s7-terminal.mjs`），JSON 在 `tmp/evidence/T10/bench/`。终端 120 × 40，`/bin/sh`。主进程事件循环延迟按 `monitorEventLoopDelay` 原始值（含 1 ms 采样间隔）；渲染进程用 CDP 追踪，"每帧主线程工作"的口径同 S1。

### 5.1 `cat` 大文件

最终实现（帧作为拉取请求的返回值），内建 120 Hz 屏：

| 项 | 100 MB（`s7-packaged.json`） | 1 GB，持续（`s7-packaged-sustained.json`） |
|---|---|---|
| 耗时与吞吐 | 0.74 s，135 MB/s | 5.7 s，175 MB/s |
| 主进程事件循环延迟 p50 / p99 / 最大 | 1.30 / **2.04** / 21.8 ms | 1.30 / **2.03** / 49.2 ms |
| 渲染进程超过 50 ms 的任务 | **0** | **0** |
| 每帧主线程工作 p50 / p99 | 4.3 / 7.9 ms（80 帧） | 4.3 / 6.6 ms（678 帧） |
| 合成器帧状态 | 呈现 75，无须更新 6 | **呈现 672，丢弃 1**，无须更新 7 |
| Core 解析（`vt_write`）总耗时 | 82 ms，占墙钟 11% | 790 ms，占 14%（约 1.3 GB/s） |
| Core 编码帧 | 227 帧共 44 ms | 1,245 帧共 403 ms（平均 0.32 ms/帧） |
| 行：带单元格 / 引用 | 2,786 / 1,054 | 26,178 / 3,862 |
| IPC：帧字节 / 输出字节 | 1.5 MiB / 101 MiB（1 : 66） | 14.4 MiB / 1,011 MiB（1 : 70） |
| 主进程 CPU（含 Core 全部线程） | 一个核的 77% | 一个核的 84% |

- 页面每个动画帧最多一个在途拉取，120 Hz 屏上每秒约 120 次；计时区间包含键入命令的阶段，每次按键后页面连续拉取直到回显到达，所以平均请求数高于刷新率，其中的空帧（只有 14 字节）也来自这一段。
- 输出快于帧率时每一帧的行都已整屏换新，所以大部分行带单元格；行 id 复用在输出慢于帧率时起作用（单元测试：每输出一行，帧里只有新的一行，A05）。
- IPC 流量由帧率和屏幕大小决定，与输出量无关：1 GB 输出约 14 MiB 帧（约 2.6 MB/s，120 Hz）。
- 最大事件循环延迟（1 GB 时 49 ms）各只出现一次，p99 约 2 ms，与基准脚本的轮询同时发生，没有进一步定位。
- 主进程 CPU 主要是 Core 的 IO 线程（读 PTY 的系统调用加解析），不在主进程的 JavaScript 线程上；它不在第 11 章的预算项里（I29）。
- 帧经 MessagePort 的实现（60 Hz 外接屏）测得：100 MB 时事件循环 p99 1.85 ms、无长任务；1 GB 时每秒绘制 58.9 帧、每帧工作 p99 5.1 ms。那次的 JSON 已被最终数据覆盖，数字记录在此与 ADR-0023。

### 5.2 键入回显

口径：`cat` 运行在规范模式，由内核回显。每个样本先由 Core 直接写一个数字到 PTY 并计时到读回（基线，`terminalProbeEcho`），再在页面里键入一个字母，从 `keydown` 事件的时间戳计到解码出"光标格显示该字母"的帧（完整链路：渲染进程 → 主进程 → Core 键盘编码 → PTY → 解析 → 帧 → 主进程 → 渲染进程）。额外延迟 = 同一对样本的完整链路 − 基线。页面在输入后连续拉取，直到回显到达（最多 50 ms），不等下一个动画帧。

| 送帧方式 | 样本 | 基线 p50 / p95 | 完整链路 p50 / p95 / p99 | 额外延迟 p50 / **p95** |
|---|---|---|---|---|
| 事件 MessagePort（ADR-0017 原文，ADR-0023 之前） | 200 | 0.019 / 0.034 ms | 12.70 / 16.20 / 18.50 ms | 12.68 / **16.18 ms** |
| 拉取请求的返回值，实现前的临时对照（`s7-experiment-invoke-reply.json`） | 200 | 0.018 / 0.032 ms | 0.50 / 0.80 / 0.90 ms | 0.49 / **0.77 ms** |
| 拉取请求的返回值，最终实现（`s7-packaged.json`） | 200 | 0.020 / 0.036 ms | 0.60 / 0.80 / 1.00 ms | 0.57 / **0.79 ms** |
| 同上，`s7-packaged-sustained.json` 中的第二组 | 200 | 0.021 / 0.034 ms | 0.50 / 0.80 / 1.00 ms | 0.49 / **0.78 ms** |

完整链路的计时从 `keydown` 到帧解码完成，不含随后的绘制与上屏（下一次垂直同步）；这一段任何渲染方式都有，不计入"额外延迟"。

定位过程（临时脚本，已删除）：

- 管线本身：页面在普通任务里同时发"按键"与"拉取"，0.4–0.5 ms 收到含回显的帧。
- 在 `keydown` 处理函数里发同样两次调用：`invoke` 本身 0.2–0.7 ms 返回，MessagePort 上的帧却在下一帧的 rAF 回调之后才处理（6.2–14.2 ms）；用 `webContents.sendInputEvent` 注入按键结果相同。
- 推断是 Blink 调度器在离散输入之后优先完成下一帧，期间推迟 MessagePort 类任务；IPC 回复不受影响。按 ADR-0017 原文实现不能满足预算，按协议写成 ADR-0023（修订 ADR-0017 第 3 条），用户采纳后改为拉取请求的返回值并重测，即上表最后两行。

## 6. 一致性

- **Rust**（`crates/piarc-term/tests/consistency.rs`）：五组脚本化输出，每一步取帧、解码、应用到 `Screen`，与 formatter（选区限定为视口）逐行、逐格比较：字素逐个消耗 formatter 的那一行，宽字符的尾格与换行占位格不贡献文字。覆盖带样式的普通屏幕、备用屏幕（进入、绘制、改动、退出后恢复 shell 屏幕）、中日韩全角（含全角拉丁、宽字符在行尾换行）、emoji、ZWJ 家庭序列、国旗、组合重音、滚动输出。全部一致。
- **真实 vim**（`crates/piarc-term/tests/pty.rs`，macOS）：`vim -u NONE` 打开含中文与 emoji 的文件、编辑、退出，三个时刻帧重建的屏幕都等于 formatter 输出。
- **TS 解码器**：同一组帧写成 `apps/desktop/src/renderer/terminal/frame/frame-samples.json`（Rust 测试生成，并检查提交的文件是最新的），`decoder.test.ts` 用 TS 的解码器与 `Screen` 重建，每一格的文字、宽度类别、解析后的样式，以及光标与纯文本都与 Rust 的结果相同。

## 7. TUI 截图

L4 `apps/desktop/e2e/terminal-tui.e2e.ts`（dev 与 packaged 两种形态）等到页面从帧重建的屏幕与 Core 的 formatter 输出相同并保持 300 ms，再截图并保存 formatter 文本（`tmp/evidence/T10/l4/terminal-tui.e2e.ts-*/`）：

- `vim.png` / `vim.formatter.txt`：`vim -u NONE -c 'syntax on' -c 'set number'` 打开一个 Rust 文件。行号、关键字与字符串颜色、中文注释（宽字符在两格内居中）、emoji、`~` 空行与底部消息都正确。
- `top.png` / `top.formatter.txt`：`top -s 2 -o cpu`，整屏每 2 秒重画；表头的反色排序列正确。htop 未安装，按任务说明以 top 代替，没有安装 htop。

## 8. 输入法

- 隐藏 textarea 放在光标格上（字号、行高同终端），系统据此放候选框。
- CDP 合成（L4 `terminal.e2e.ts`）：`Input.imeSetComposition` 输入"ni"再变为"你好"，预编辑在光标处以终端背景铺底、下划线绘制（截图 `ime-preedit.png`），此时 PTY 没有收到任何字节；`Input.insertText` 提交后经 Core 写入 PTY 并回显，光标与 textarea 一起右移四格（两个宽字符）。
- 合成期间的按键（`isComposing` 或 keyCode 229）复用 T09 的输入法守卫，不发给 Core。
- **待实机核对**（交 R1，用户在本机做）：

| 编号 | 步骤 | 期望 |
|---|---|---|
| T1 | `npm run start -w @piarc/desktop` 后打开 `#/terminal-lab`（地址栏不可见时在开发者工具里设置 `location.hash`），切到系统"简体拼音"，在提示符后输入 `nihao` | 候选框出现在光标下方，紧贴光标所在格；预编辑 `ni hao` 画在光标处并带下划线 |
| T2 | 选第一个候选 | "你好"出现在提示符后，光标在其后；候选框消失 |
| T3 | 连续输入三组拼音，中间用空格选词 | 每次候选框都跟着新的光标位置 |
| T4 | 在 vim 插入模式下重复 T1–T3 | 同上；Esc 先取消合成，不退出插入模式 |

## 9. wterm 评估（只评估，不实现）

对象：vercel-labs/wterm（`@wterm/dom` 0.5.10，提交 `1a42b3c6`，2026-11-13），ADR-0017 第 4 条要求评估它的 DOM 渲染器作为无障碍更好的备选数据源接入方式。

- **接入方式**：`WTerm` 接受一个现成的 `core`（`TerminalCore` 接口，`@wterm/core`），渲染器只经这个接口读格子（`getCell`、`getRowId`、`isRowContentDirty`、`getCursor`、滚动区与模式查询）。PiArc 可以写一个由帧驱动的 `TerminalCore`（与本次的 `RemoteRenderable` 同类），`writeString`/`writeRaw` 不做事，`getResponse` 返回空（应答只由 Core 发出）。差距：wterm 的输入在渲染端按 `cursorKeysApp`、Kitty 标志等模式自己编码，PiArc 要求键盘事件原样交给 Core 编码（ADR-0017 第 4 条），接入时要绕开它的编码路径或在帧里同步模式，后者会出现两个编码器；scrollback 接口要求帧协议支持历史行。
- **无障碍**：DOM 行可被系统选中和读屏，另有 `role="log"`、`aria-live="polite"` 的输出播报与输入框的标签；这是相对 Canvas 渲染器的主要优势。
- **安全基线**：它的行渲染用 `row.innerHTML = parts.map((part) => part.html).join("")` 拼 HTML 字符串（文字经 `escapeHTML` 转义）。PiArc 的渲染进程禁止从 HTML 字符串建 DOM（架构第 10.3 节，ESLint 强制），采用前必须 fork 并改成 DOM API，或把它作为变更型例外提出。
- **许可证**：Apache-2.0，在白名单内；需随包附 NOTICE 与许可证文本（T50）。
- **规模**：`@wterm/dom` 源码约 9,900 行，自称实验项目。

结论：作为 T34 的无障碍备选，可行但不是现成替换：需要自写 `TerminalCore`、改掉 `innerHTML`、绕开渲染端按键编码。M0 不采用，T34 做无障碍时再决定是 Canvas 渲染器加一层可访问的文本镜像，还是 fork wterm 的 DOM 渲染器。

## 10. 待 W0 与后续

| 项 | 负责 |
|---|---|
| Windows 两个目标的链接与加载（CI `core-build`、`core-load`，推送后核对）；win32-arm64 实机运行 | W0（T10-A01） |
| ConPTY：resize、Ctrl+C、kill（0.9.0 的 kill 返回值问题由 `wait` 兜底，需实测）、是否随附 `conpty.dll` 与 OpenConsole.exe | W0 |
| Windows 渲染、回显延迟（`npm run bench:s7`）与微软拼音；`terminal.e2e.ts`、`terminal-tui.e2e.ts` 和 `crates/piarc-term/tests/pty.rs` 目前限定 Unix（用 `/bin/sh`、`cat`、`vim`、`top`），W0 换成 Windows 程序后运行 | W0 |
| 真实拼音输入法核对（第 8 节 T1–T4，T10-A11） | R1 |
| 帧协议定稿、JSON Schema 与 L1 样本、终端事件形状、agent 读屏、OSC 133、snapshot | T33 |
| 选区、复制、滚动与 scrollback、链接、查找、无障碍、多窗口同时查看一个终端（现在每个终端只有一个 viewer，换 viewer 时发 RESET 帧）、光标闪烁 | T34 |
