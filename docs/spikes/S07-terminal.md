# S7 终端验证：libghostty-vt + PTY + 帧协议 + 渲染器

T10，2026-11-15。对应架构第 16 章 S7、ADR-0017、风险 R15。

## 1. 结论

macOS 通过（真实拼音的候选框核对 2026-11-16 补做，全部符合预期，第 8 节）；路线结论为**正式路线**（终端状态在 Core 的 libghostty-vt，渲染进程画 Core 的帧），不启用 xterm.js 退路。

Windows（W0，第 11 节）**有条件通过**：

- **ConPTY 两处缺陷已修复**：程序自行退出后收不到 `Exited`；启动者忽略 Ctrl+C 时，这个状态会传给终端里的程序。
- **通过的项**：TUI 渲染、帧与 formatter 逐格一致、resize、Ctrl+C、终止进程；打包产物中的 DLL 链接方式可用；输出 100 MB 期间主进程事件循环 p99 14.34 ms。
- **未达标的项**：键入回显额外延迟按原始配对口径 p95 6.86 ms，超出 5 ms。均值是 −0.12 ms，完整路径在各分位上都不比直接写 PTY 慢，超出的部分来自 ConPTY 两次独立往返的抖动，这套测量方法在 Windows 上需要 R1 校准。
- **实机核对**：微软拼音的候选框与预编辑位置全部符合预期（第 11.4 节）。
- **win32-arm64**：CI 的 `core-load`（`windows-11-arm`）中 libghostty-vt 在 node 与 Electron 里实际运行终端通过（I47）。

| S7 通过标准 | macOS 结果 |
|---|---|
| vim、htop 等 TUI 渲染正确 | 通过。vim（备用屏幕、语法颜色、行号、中文、emoji）与 top（htop 未安装，以 top 代替）渲染正确，截图时刻页面重建的屏幕与 Core 的 formatter 输出逐字一致（第 7 节） |
| `cat` 100 MB 时界面帧率稳定、主进程事件循环 p99 ≤ 16 ms | 通过。100 MB：事件循环 p99 2.04 ms，渲染进程无超过 50 ms 的任务；持续 1 GB：120 Hz 屏上合成器呈现 680 帧中的 672 帧、丢 1 帧，每帧主线程工作 p99 6.6 ms（第 5.1 节） |
| 键入回显额外延迟 p95 ≤ 5 ms | 通过：p95 0.79 ms（200 个配对样本）。按 ADR-0017 原文让帧经事件 MessagePort 时是 p95 16.2 ms（Chromium 在按键之后把 MessagePort 消息推迟到下一帧之后处理），因此按 ADR-0023（已接受）改为拉取请求的返回值（第 5.2 节） |
| 中文输入法候选框与预编辑文本位置正确 | 通过。预编辑在光标处绘制、隐藏 textarea 跟随光标，CDP 合成验证通过；系统"简体拼音"实测 T1–T4 全部符合预期（第 8 节） |
| formatter 输出与渲染帧逐格一致 | 通过。普通屏幕、备用屏幕、中日韩全角、emoji、ZWJ 与组合字符、宽字符换行、滚动，以及真实 vim，Rust 逐格比较全部一致；TS 解码器对同一组帧得到相同屏幕（第 6 节） |
| 四个目标都能链接，win32-arm64 实机运行 | darwin-arm64、darwin-x64 本机链接通过；Windows 两个目标选定"官方 DLL 放在 `.node` 旁边"，CI `core-build` 两个目标通过，`core-load` 在 x64 与 arm64 runner 上加载通过；win32-arm64 上 libghostty-vt 的实际运行经加载检查新增的终端检查在 CI 中通过（第 3 节、第 11 节） |

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

**W0 结果**：CI 运行 43827342553 中 `core-build` 的两个 Windows 目标链接通过，`core-load` 在 `windows-latest` 与 `windows-11-arm`（arm64 实机 runner）上把 `.node` 与旁边的 `ghostty-vt.dll` 一起加载通过；Windows 11 本机 MSVC 14.51 构建通过，打包产物（`app.asar.unpacked/native/` 下的 `.node` 与 DLL）的终端 L4 通过。win32-arm64 的 DLL 官方"只构建、从不运行"：加载已在 arm64 上成功，而加载检查此前不调用终端，W0 给它加了终端检查（第 11 节）。下一次 CI（运行 43855932047，2026-11-16）中 arm64 的 node 与 Electron、开发版与发布版都报 `terminal ok`，libghostty-vt 在 win32-arm64 上实际运行通过。

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
- **真实拼音核对**（清单 T1–T4，结果见表后）：

| 编号 | 步骤 | 期望 |
|---|---|---|
| T1 | `npm run start -w @piarc/desktop` 后打开 `#/terminal-lab`（地址栏不可见时在开发者工具里设置 `location.hash`），切到系统"简体拼音"，在提示符后输入 `nihao` | 候选框出现在光标下方，紧贴光标所在格；预编辑 `ni hao` 画在光标处并带下划线 |
| T2 | 选第一个候选 | "你好"出现在提示符后，光标在其后；候选框消失 |
| T3 | 连续输入三组拼音，中间用空格选词 | 每次候选框都跟着新的光标位置 |
| T4 | 在 vim 插入模式下重复 T1–T3 | 同上；Esc 先取消合成，不退出插入模式 |

结果（2026-11-16，macOS 26.5.2，BenQ 外接屏；已安装的开发构建 `/Applications/PiArc.app` 的 `#/terminal-lab`，zsh 与 `vim -u NONE -N`；智能体经 computer-use 以前台键盘事件逐键输入，截图在 `tmp/evidence/T10/ime/`）：T1–T4 全部符合预期。

| 编号 | 观察 |
|---|---|
| T1 | 候选框（你好、👋、你好吗……）出现在光标所在行的下一行，左端对齐预编辑起点；预编辑 `ni hao` 画在提示符后并带下划线 |
| T2 | 空格选第一个候选后"你好"出现在提示符后，光标在其后，候选框消失 |
| T3 | 依次输入 `shijie`、`ceshi` 并用空格选词，每次候选框都移到新的预编辑起点下方，最后一行为"你好世界测试" |
| T4 | vim 插入模式下 T1–T3 同样正确（第一行行首合成时候选框贴着窗口左边）；输入 `ceshi` 合成中按 Esc，预编辑消失、没有字符写入，状态行仍为 `-- INSERT --` |

后台方式（不把应用调到前台、按键直接投递给进程）发出的按键不经过输入法，字母会直接写进 shell；真实输入法的核对必须用前台键盘事件。

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
| Windows 两个目标的链接与加载；ConPTY；Windows 渲染、回显延迟与终端用例的 Windows 版本 | W0 已完成（第 11 节） |
| win32-arm64 上 libghostty-vt 的实际运行（加载检查新增的终端检查，下一次 CI 的 `core-load`） | 已完成（2026-11-16 CI，`terminal ok`） |
| 微软拼音的候选框与预编辑位置（第 11 节 WT1–WT4） | W0 已完成，全部符合预期 |
| Windows 上键入回显额外延迟的测量口径 | R1 |
| 真实拼音输入法核对（第 8 节 T1–T4，T10-A11） | 已完成（2026-11-16），全部符合预期 |
| 帧协议定稿、JSON Schema 与 L1 样本、终端事件形状、agent 读屏、OSC 133、snapshot | T33 |
| 选区、复制、滚动与 scrollback、链接、查找、无障碍、多窗口同时查看一个终端（现在每个终端只有一个 viewer，换 viewer 时发 RESET 帧）、光标闪烁 | T34 已完成（ADR-0051），走本报告的正式路线；多窗口同时查看留给 T35 |

## 11. Windows（W0，2026-11-16）

机器与对照见 S2 报告第 8 节（i5-1340P、16 GB、NVMe，Windows 11 专业版 25H2 26200.9974，x64）。显卡为 Intel Iris Xe 核显。

### 11.1 ConPTY

`crates/piarc-term/tests/pty_windows.rs` 把 `pty.rs` 的用例换成 Windows 程序（cmd.exe 带 `PROMPT=$$$S`、PowerShell、Git for Windows 自带的 vim），并新增 Ctrl+C 用例，10 项通过：

| 用例 | 程序 | 结果 |
|---|---|---|
| 输入与输出 | cmd：`for /L %i in (42,1,42) do @echo piarc-42` | 通过 |
| 键事件编码后写入 | cmd：`echo k` 逐键发送 | 通过 |
| 调整尺寸 | `resize(100, 30)` 后 PowerShell 读 `$Host.UI.RawUI.WindowSize` | `size 30 100`，帧尺寸 100 × 30 |
| Ctrl+C | cmd 中 `ping -n 30` 出现第一行回复后写 0x03 | ping 被中断，后续命令立即执行 |
| 退出码 | `cmd /C exit 7` | `Exited { code: 7 }` |
| 关闭即终止 | 关闭会话 | 收到 `Exited`，之后写入报 `Closed` |
| 标题与响铃 | PowerShell 设窗口标题、写 BEL | 标题 `piarc title`（ConPTY 另外先报一次程序路径作标题）、响铃 1 次 |
| 帧重建与 formatter 一致 | PowerShell 输出带颜色的中文 | 一致 |
| 回显探针 | cmd 的行输入回显 | < 1 s |
| vim 备用屏幕 | Git 的 vim 打开含中文与 emoji 的文件、编辑、`:q!` | 运行中与退出后帧与 formatter 一致，退出码 0 |

实测发现并修复两处缺陷（提交 1c6750b，补充型，未写 ADR）：

1. **程序自行退出后没有 `Exited`。** ConPTY 只在伪控制台关闭（`ClosePseudoConsole`）时结束输出管道，而会话原先等读到输出结束才 `wait` 程序，伪控制台又要到会话关闭才释放，形成循环等待。现在由单独的等待线程 `wait`，Windows 上程序退出后让写线程结束、释放 master，读线程随之读到结束，再取等待线程的退出码。`the_exit_code_is_reported` 与 vim 用例修复前超时、修复后通过。
2. **Ctrl+C 不起作用。** 进程"忽略 Ctrl+C"的状态（`SetConsoleCtrlHandler(NULL, TRUE)` 或新进程组）会被子进程继承；本次会话由智能体的进程链启动，cmd 与 ping 继承了这个状态，0x03 到达 conhost 后没有产生 `CTRL_C_EVENT`。从干净的进程树（WMI 启动）运行同一个测试二进制则通过。PiArc 被这样的进程启动时，用户在终端里按 Ctrl+C 同样无效，所以 `piarc-term` 在启动程序前清掉本进程的这个标志（新 `console` 模块里的一次 `SetConsoleCtrlHandler(NULL, FALSE)`，编码规范 2.8 已登记）。修复后在同一会话中连续通过。

`kill`：portable-pty 0.9.0 在 Windows 上把成功报成错误，`close` 不信它的返回值，退出以等待线程为准；"关闭即终止"用例通过。

**是否随附 `conpty.dll` 与 OpenConsole.exe：不随附。** portable-pty 0.9.0 先按 DLL 搜索路径找 `conpty.dll`，找不到才用系统 kernel32 的 ConPTY。Windows 11 25H2 自带的 ConPTY 能跑通 cmd、PowerShell、MSYS2 程序（vim）、备用屏幕、标题、响铃与 resize，没有发现非要新版 conhost 才能解决的问题。随附会增加约 1–2 MB，还要跟随 Windows Terminal 发版更新。只有出现系统 ConPTY 解决不了的缺陷时再随附，并固定版本与校验和。

**ConPTY 与 macOS 的差异**：conhost 把终端发来的按键解析成控制台按键事件，再按程序自己的输入模式重新编码。程序打开 DECCKM 后，Core 发出的 `ESC O A` 到 Node 程序那里变成 `ESC [ A`，所以"按终端模式编码"只能由键盘编码器的单元测试验证（L4 的 Windows 版断言 ↑ 到达程序）。

### 11.2 L4 与 TUI

`terminal.e2e.ts`、`terminal-tui.e2e.ts` 在 Windows 上去掉跳过、改用 Windows 程序，开发与打包两种形态都通过：

- shell 用 cmd；隐藏终端用 PowerShell 循环；键位用 `e2e/programs/show-keys.ts`；输入法 CDP 合成在光标处绘制预编辑，提交后经 Core 回显；
- TUI 用 Git 的 vim（语法颜色、行号、中文注释、emoji、`~` 行），另一个用 PowerShell 每 2 秒清屏重绘的进程表代替 top。截图与 formatter 文本在 `tmp/evidence/W0/l4/terminal-tui.e2e.ts-*/`，页面重建的屏幕与 Core 的 formatter 输出逐字一致。

### 11.3 测量

`npm run bench:s7 -- --form packaged`（`tmp/evidence/W0/bench/s7-packaged.json`）在 cmd 中 `type` 100 MB 文件；回显改用原始模式的 Node 回显程序（`scripts/bench/echo-program.mjs`），因为 ConPTY 下 cooked 模式的行回显由 conhost 完成，cmd 会把每一行当命令执行。

| 项 | Windows | 预算 | macOS（第 5 节） |
|---|---|---|---|
| 输出 100 MB | 105.8 s（约 1 MB/s） | — | 约 190 MB/s |
| 主进程事件循环延迟 | p50 4.12 ms，p99 14.34 ms，max 189 ms（单次） | p99 ≤ 16 ms | p99 2.04 ms |
| 渲染进程 | 每秒绘制 72.1 帧；每帧主线程工作 p50 9.35 ms、p99 20.78 ms；超过 50 ms 的任务 0 个 | 无长任务 | p99 6.6 ms |
| Core | `vt_write` 2.18 s（墙钟的 2.1%）；10,304 帧编码共 10.2 s | — | — |
| 主进程 CPU | 一个核的 48% | — | 74% |
| 键入回显（200 个配对样本） | 直接写 PTY p50 3.14 / p95 10.13 ms；完整路径 p50 2.70 / p95 9.30 ms；额外 p50 1.04 / p95 6.95 ms，均值 0.05 ms | 额外 p95 ≤ 5 ms | 额外 p95 0.79 ms |
| 同上，1,000 个样本（`s7-echo-1000.json`） | 直接 p50 3.12 / p95 9.85 / p99 14.07 ms；完整 p50 2.70 / p95 9.00 / p99 14.50 ms；额外 p50 0.52 / p95 6.86 ms，均值 −0.12 ms | | |

分析：

- **吞吐的瓶颈在 conhost。** Core 解析只占墙钟的 2.1%，每秒 72 帧都按时拉取；ConPTY 把程序的输出先画进自己的缓冲区，再按帧把变化转成 VT 发出，所以 `type` 大文件只有约 1 MB/s（ConPTY 发出的是重绘序列，Core 收到 101 MiB）。这是 ConPTY 的上限，不是 PiArc 的；主进程与渲染进程在这期间都没有长任务。
- **回显的配对相减在 Windows 上失效。** 每个样本的两半是两次独立的 ConPTY 往返，各自带 0–16 ms 的抖动（conhost 按自己的帧节奏刷新输出），相减得到以 0 为中心的宽分布：均值 −0.12 ms，而 p95 6.86 ms。完整路径在 p50、p95 上都不比直接写 PTY 慢，客户端路径（渲染进程 → 主进程 → Core 键盘编码 → … → 帧 → 渲染进程）没有测出可见的额外延迟。按原始口径记为"超出预算"，不改预算；R1 校准 Windows 上的测量方法（例如在 Core 内分别打点客户端路径的两段）。
- 渲染进程每帧工作 p99 20.8 ms 高于 macOS，可能的原因是核显，以及 ConPTY 每帧重绘整屏：本次发送了 303,060 行，复用的只有 2,060 行。没有超过 50 ms 的任务，帧率稳定在 72 帧/秒。

### 11.4 微软拼音

用户在已安装的应用的 `#/terminal-lab`（cmd）中按 `S06-first-run-checklist.md` 第 8.2 节核对，WT1–WT4 全部符合预期：候选框紧贴光标所在格，预编辑画在光标处并带下划线；选词后"你好"出现在提示符后、光标随之移动；连续输入时候选框跟随光标；Git 的 vim 插入模式下同样正确，合成中的 Esc 只取消合成、不退出插入模式。
