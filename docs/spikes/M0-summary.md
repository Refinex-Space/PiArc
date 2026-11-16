# M0 总结与进入 M1 的结论

R1（2026-11-16）。依据 S1–S10 报告、T02–T12 与 W0 的验收项、四个独立审查（[`docs/reviews/R1-findings.md`](../reviews/R1-findings.md)）与 CI 运行 [43855932047](https://github.com/Refinex-Space/PiArc/actions/runs/43855932047)。

## 1. 结论：有条件进入 M1

T13 可以开始。十个验证项没有一项不通过，没有触发任何 ADR 的重新评估，架构的三层结构、NAPI 进程内加载、同进程多会话、Operations 委托、凭据保险箱、libghostty-vt 终端路线、未签名分发都按原决策进入 M1。

"有条件"指下面的项目在给定时间点前必须处理，它们都不阻塞 T13，也都有负责任务（第 9 节）：

1. W0-A04、W0-A10 两个 Windows 测量项按原始口径为 `failing`，按本次校准的口径（第 7 节）都在预算内；用户在 R1 中授权改判，两项已改为 `passing`。W1 按新口径复测一次，R3 检查。
2. 首次运行的系统放行流程没有在开启 Gatekeeper、SmartScreen 的机器上观察到（I42、I49），由 T50 在首次发布前完成。
3. Windows 的安装包与安装后体积、两个平台的进程合计内存、Agent Host 单会话内存超出预算，不放宽，由 T44 优化并在 R4、R5 复核。
4. 真实输入法与触控板的人工核对还有缺口：macOS 的 S1 清单（M1–M10，I25）与两个平台的日文输入法，由 T19 与 W1 补做，R2、R3 检查。
5. 审查登记给 M1 任务的健壮性问题（I50、I53、I56、I57、I58、I59）在各自任务内处理，R2 复核。

## 2. 总表

结论取值：通过 / 有条件通过 / 不通过 / 未验证。Windows 的 S3、S4、S9、S10 以 W0 本机与 CI 运行为依据。

| 编号 | 验证内容 | macOS | Windows | 关键数据 | 报告 |
|---|---|---|---|---|---|
| S1 | transcript 与 composer | 有条件通过 | 有条件通过 | 100 token/s 流式每帧主线程工作 p99 5.7 ms（Windows 4.7 ms），无长任务；万条滚动 60 fps（Windows 75 Hz 屏 75 fps）；千条冷加载 52 ms（81 ms）；渲染进程 179 MiB（137 MiB）；XSS 载荷全部为文本。条件：macOS 真实输入法与触控板核对（M1–M10）未做，日文输入法两个平台都未验证 | [S01](S01-transcript-composer.md) |
| S2 | NAPI 事件通道 | 通过 | 通过（按校准口径） | 50 万事件无丢失无乱序；事件循环 p99 3.58 ms；Windows 原始 p99 16.81 ms，同机空闲基线 16.58 ms，超出基线 0.23 ms；同步调用 p99 ≤ 0.008 ms；四个目标加载通过 | [S02](S02-napi-event-channel.md) |
| S3 | 同进程多会话 | 通过 | 通过 | 工具、中断、压缩、MCP 按会话隔离；两个会话 169 MB（每会话一个进程约 2 × 158 MB） | [S03](S03-multi-session.md) |
| S4 | Operations 委托 | 通过 | 通过 | 六个规范名工具的 I/O 全部经 Core，场景期间零直接调用；17 个对照场景 16 个一致、1 个有意差异；`fs/read` 往返 p95 约 0.2 ms | [S04](S04-operations-delegation.md) |
| S5 | 凭据保险箱 | 通过 | 通过 | 篡改任一字节即拒读；两个 Agent Host 三个会话只刷新一次；磁盘、日志、环境变量无明文；macOS 每次更新钥匙串弹 1 次 | [S05](S05-credential-vault.md) |
| S6 | 未签名打包与首次运行 | 有条件通过 | 有条件通过 | macOS DMG 168.8 MB、安装后 449.0 MB；hardened runtime 可用（需 `disable-library-validation`）；清单签名的篡改用例全部拒绝；Windows 安装包 225 MB、安装后 521 MB（超预算）；Velopack 未签名安装、相邻版本更新、卸载可用。条件：Gatekeeper/SmartScreen 开启时的放行流程未观察（I42、I49） | [S06](S06-packaging-first-run.md) |
| S7 | 终端 | 通过 | 通过（按校准口径） | vim/top 渲染与 formatter 逐格一致；`cat` 100 MB 事件循环 p99 2.04 ms（Windows 14.34 ms）；回显额外延迟 p95 0.79 ms；Windows 两组样本 p95 之差 −0.85 ms（原始配对 6.86 ms）；真实拼音（macOS）与微软拼音核对通过；win32-arm64 实际运行通过 | [S07](S07-terminal.md) |
| S8 | 沙箱与进程树 | 通过 | 通过 | 写入与网络限制生效，常见构建命令可运行；每条命令额外 8.4 ms；Windows Job Object 结束三级进程树，主进程被强杀后 Agent Host 子树 7 个进程全部退出 | [S08](S08-sandbox.md) |
| S9 | AHP 握手、背压、重启与对账 | 通过 | 通过 | 六类故障注入通过；写队列满返回可重试的 `busy`；Windows 上 stdout 同步写，停读时 Agent Host 整体停住，内存有界、不丢失、不误判 | [S09](S09-ahp-resilience.md) |
| S10 | Electron 安全基线 | 通过 | 通过 | 官方清单 20 项逐条落实；变异对照 25 个安全用例中 17 个失败（证明用例有效）；发布构建 9 个 fuse 一致；R1 审查确认并修复 4 个渲染与 IPC 缺陷（R1-E1、E2、E4、E5） | [S10](S10-electron-security.md) |

S1 的 macOS 结论由"通过"改为"有条件通过"：第 16 章 S1 的通过标准包含"中文、日文输入法在两个平台正常"，macOS 的拼音只有 CDP 合成与终端侧的真实核对（S7），composer 的真实核对与两个平台的日文都没有做。S2、S7 的 Windows 结论按第 7 节的测量口径给出。

## 3. 有条件通过与未验证的项

| 项 | 条件 | 风险 | 跟进 |
|---|---|---|---|
| S1：composer 的真实输入法（macOS 简体拼音 M1–M4）、触控板手感（M7–M8） | 用真实输入法与触控板按 S1 报告第 7 节核对 | 合成事件与真实输入法的事件序列不同；终端侧的真实拼音已通过（S7 第 8 节），composer 用同一套守卫 | T19 正式 composer 时核对，R2 检查 |
| S1：日文输入法（两个平台，M5–M6） | 需要安装输入法，属于系统配置变更，需用户操作 | 日文的转换与候选行为与中文不同 | T19（macOS）、W1（Windows），R2、R3 检查 |
| S6：Gatekeeper 开启时的首次打开（macOS 15 与 26）、内置 node 是否被单独拦截；SmartScreen 放行（Windows） | 在开启 Gatekeeper 与"检查应用和文件"的机器上，用从外部地址下载的安装包重做检查清单 | 首次运行指引可能与实际界面不符；内置 node 被拦会让 Agent Host 无法启动 | T50 首次发布前完成（I42、I49），R6 检查 |
| S6：安装与安装后体积 | Windows 超预算 13%、16%；macOS 安装后只余约 1 MB | 任何新增随包内容都会超出 | T44 裁剪（locales、npm 文档、单架构安装包等），R5 检查 |
| S6：TCC 责任归属 | 只有机制分析，没有实测弹窗归属 | 文件夹授权以 PiArc 的名义弹出，每次更新失效 | T39 定稿 Agent Host 配置时实测 |
| S2、S7：Windows 测量口径 | 已按第 7 节的口径改判 W0-A04、A10（用户授权） | 无（数据本身显示没有可见的额外延迟） | W1 按新口径复测一次，R3 检查 |

## 4. 对后续任务有影响的结论

| 结论 | 影响的任务 |
|---|---|
| 终端走正式路线（Core 的 libghostty-vt + fork 的 Canvas 渲染器），不启用 xterm.js 退路；帧作为拉取请求的返回值送达（ADR-0023）；Windows 用官方 DLL，不随附 conpty.dll | T33、T34、W2 |
| transcript 选定 @tanstack/react-virtual、marked 词法器、shiki JavaScript 引擎（ADR-0022）；帧时间按"每帧主线程工作"计；滚动阈值 2/40/200 px | T19、T44 |
| 事件批次一律复制转发，不转移 `ArrayBuffer`（ADR-0019）；Core 不必移到 `utilityProcess` | T14、T19 |
| 沙箱受保护路径清单比 6.1.2 窄（`.git/` 整体可写，只保护 hooks 与 config）；缓存指向会话临时目录；不能绑定端口与连 Unix socket | T16、T17、T39 |
| 进程树：Agent Host 已用 `ProcessTreeSpawner`（macOS 进程组、Windows Job Object）；委托的普通命令还没有，Windows 上取消命令时命令本身继续运行 | T17（I33，必须）、T33（I28） |
| Windows 上 Agent Host 写 stdout 是同步的：Core 停读时 Agent Host 整个停住 | T14 的事件消费者必须持续取走事件（I19、I46）；不新增独立通道 |
| 凭据注入点是 pi-ai 的异步 `CredentialStore`，Core 是唯一写入方（ADR-0021）；租约与锁的加固 | T21（I23、I57） |
| hardened runtime 开启，entitlements 为 `allow-jit` 与 `disable-library-validation`；内置 node 保留官方签名（含 `get-task-allow`） | T45（I39）、T50 |
| 系统通知可用，但 macOS 上 `show` 不反映是否允许，应用退出时已投递的通知被删除 | T18、T35、T42（I43） |
| 主进程没有设 `userData`，Windows 上卸载后留下 `%APPDATA%\PiArc\` | T13（I48） |
| 发布构建仍带原型页与终端函数；终端输入不经 Core 权限裁决 | T34、T45（I13、I24、I30、I51） |
| AHP 会话层的超时对账、恢复的可中断性等健壮性问题 | T14（I58） |

## 5. ADR 触发条件检查表

"是否触发"取值：未触发 / 触发 / 未发生（与 M0 无关的外部条件）。M0 没有触发任何条件，因此没有新的 ADR 提议。

| ADR | 触发条件（原文） | M0 证据 | 是否触发 |
|---|---|---|---|
| 0013 | 实测内存或启动时间超出第 11 章预算 30% 以上，且优化后仍无法达标 | 启动时间未测。macOS 主进程 160–164 MB，比初始预算 120 MB 高 37%，但同版本裸 Electron 一个空窗口就是 155–157 MB，PiArc 的增量只有 5–8 MB；Windows 主进程 108 MB 在预算内。其余超出的内存行（进程合计 +5–14%、Agent Host 单会话 +12%）都不到 30%。第 11 章写明这些是待 M0 校准的初始值，主进程一行按裸 Electron 基线校准（第 7 节） | 未触发 |
| 0013 | 威胁模型中的某项对策必须放松 Electron 安全基线才能实现 | S10：开发服务器的 CSP 放宽只在开发构建；T09 加入的 `clipboard-sanitized-write` 只写、经 Chromium 净化。R1-E3：终端输入不经 Core 权限裁决与 10.3 的表述不一致，但它是终端面板的设计行为，不是为某项对策放松基线（I51 由 T34 决定防线） | 未触发 |
| 0013 | 双平台同步导致 macOS 里程碑连续两次延期 | M0 按计划完成，W0 与 macOS 任务交替进行 | 未触发 |
| 0014 | 主进程事件循环延迟 p99 超过 16 ms 且确认由 Core 调用或事件转发造成 | macOS p99 3.58 ms；Windows 原始 p99 16.81 ms，但同机空闲 Node 为 16.58 ms，每次投递的转发 p99 0.214 ms，超出部分来自计时器粒度，不是 Core（S2 第 8 节） | 未触发 |
| 0014 | Core 的崩溃导致应用崩溃的事件在 Beta 期出现两次以上 | Beta 前不适用；NAPI 导出全部经 `catch_unwind`，L4 的 `triggerPanic` 得到 `internalError` | 未发生 |
| 0014 | NAPI-RS 停止维护，或某个 Electron 版本破坏 Node-API 兼容 | napi 3.16.2 在 Electron 45.3.2 的四个目标上加载通过 | 未发生 |
| 0015 | Electron 提供可以单独套沙箱、支持 stdin 的子进程方式，且 Agent Host 不再需要 npm/npx | Electron 45 的 `utilityProcess` 仍不能套 Seatbelt、stdin 只能 `ignore`；S6 中 npx 拉起 MCP 与原生模块安装都依赖内置 npm | 未发生 |
| 0015 | 内置 Node 无法公证，或需要过宽的 entitlements | 不公证（ADR-0018）。内置 node 保留 Node.js 官方签名，其中 `get-task-allow`、`allow-dyld-environment-variables` 偏宽（I39），但这是保留官方签名的结果，运行本身不需要它们；去掉它们要重签，涉及 ADR-0018，由 T45 评估 | 未触发（风险 I39 交 T45） |
| 0015 | 实测多会话场景下 Agent Host 内存超出预算 30% 以上 | 两个会话各跑完一个回合 188–191 MB，预算 150 + 40 = 190 MB，超出不到 1%；单会话 165–168 MB 超出 12%（交 T44） | 未触发 |
| 0015 | Pi 上游放弃 Node 支持 | Pi 1.5.2 仍是 Node 包 | 未发生 |
| 0016 | （已被 0018 取代）Apple 或微软调整应用商店政策；Velopack 与 MSIX 都无法满足按用户安装、增量更新、签名校验；需要 MDM/Intune；Forge 停止维护 | 已取代，条件由 0018 承接。Velopack 实测按用户安装、相邻版本更新可用；清单签名校验在 Core 中实现，接入 Velopack 更新流程由 T50 完成 | 未触发 |
| 0017 | M0 S7 中任一项不达标：TUI 渲染正确性、大量输出时的帧率与主进程事件循环延迟、键入回显延迟、中文输入法 | macOS 全部达标。Windows 的回显按原始配对口径 p95 6.86 ms，但两组样本的 p95 之差为 −0.85 ms，完整路径在各分位都不比直接写 PTY 慢，超出来自 ConPTY 两次独立往返的抖动；按第 7 节的口径达标 | 未触发 |
| 0017 | Windows MSVC 目标无法链接 libghostty-vt，或 win32-arm64 上无法运行 | 官方 DLL 放在 `.node` 旁边，两个 Windows 目标构建与加载通过；arm64 的终端运行在 CI 中报 `terminal ok`（I47） | 未触发 |
| 0017 | ghostty-web 迁到 libghostty-vt 1.x 官方 WASM 并发布稳定版，且修复了输入法位置与 CSP 加载问题 | npm 上 ghostty-web 仍为 0.4.0（2026-11-16 查询） | 未发生 |
| 0017 | libghostty-vt 的 1.x ABI 承诺被打破 | 锁定 1.0.1，绑定 `--check` 一致 | 未发生 |
| 0018 | 项目公开并发布第一个版本后，申请 SignPath 免费签名 | 尚未发布 | 未发生（T50 发布后执行） |
| 0018 | 用户反馈中"安装受阻"或"停留在旧版本"成为主要问题 | 尚无用户 | 未发生 |
| 0018 | 出现愿意承担 Apple 开发者计划费用的赞助方或组织主体 | 无 | 未发生 |
| 0018 | Apple 进一步收紧未公证应用的运行方式，例如对 ad-hoc 签名应用也不再提供"仍要打开" | 用户的 Mac 关着 Gatekeeper，没有观察到放行流程（I42） | 未验证（T50 首次发布前在开启 Gatekeeper 的机器上确认） |
| 0004（S4） | AHP 往返延迟成为可感知瓶颈（工具调用 p95 > 20 ms） | 小文件 `fs/read` 往返 p95 0.19–0.22 ms；Windows 的同一断言（≤ 5 ms）通过 | 未触发 |
| 0004（S4） | Pi 移除或大幅修改 `*Operations` 接口 | Pi 1.5.2 的 Operations 仍在，但不足以做到零绕过：read/write/edit 在 Operations 之外探测路径、grep 直接运行 ripgrep；ADR-0020（补充）用替身路径与自写 Grep 解决，运行时 spy 与对照测试把关升级 | 未触发 |
| 0009（S9） | stdio 吞吐成为瓶颈（例如大量终端输出导致事件延迟 p95 > 50 ms） | 终端帧不经 AHP；S9 慢读者用例在 macOS、Windows 都不丢失、不误判；Windows 上同步写让停读的影响更大（I46），由 T14 持续消费解决 | 未触发 |
| 0009（S9） | 决定把 Core 拆成独立守护进程，供 CLI 或远程客户端共用 | 没有这个决定 | 未发生 |
| 0010（S3） | M0 或之后发现无法规避的跨会话状态串扰 | S3 四项隔离通过；进程级全局状态（`process.env`、`getAgentDir()`）已固定；R1 审查没有发现串扰路径（R1-A13 是需要恶意扩展的加固项） | 未触发 |
| 0010（S3） | 单进程崩溃率高到影响体验（例如每 100 会话小时超过 1 次） | M0 没有长时间运行的数据 | 未发生（T44 长跑测试与 Beta 统计） |

## 6. ADR-0015 与 ADR-0018 留给 M0 的事项

| 事项 | 来源 | 结论 | 证据或负责任务 |
|---|---|---|---|
| hardened runtime 能否在 ad-hoc 签名下启用 | ADR-0018 第 2 条 | 能，但必须同时给 `disable-library-validation`（ad-hoc 签名没有 Team ID）；已启用，实测阻止 `DYLD_INSERT_LIBRARIES` 注入 | S6 第 3 节，架构 10.3 |
| 内置 node 的签名与 entitlements | ADR-0015 第 5 条（被 0018 修订） | 保留 Node.js 官方签名，不重签；官方 entitlements 偏宽（I39） | S6 第 3 节；T45 评估 I39 |
| 系统通知（`UNNotification`）在 ad-hoc 签名下是否可用 | ADR-0018 第 6 条 | 可用，不需要降级；但 `show` 不反映是否允许，退出时已投递的通知被删除 | S6 第 5 节；T18、T35 按 I43 设计 |
| 钥匙串每次更新的弹窗次数 | ADR-0018 第 5 条、S5 | 1 次（实机确认） | S6 第 10 节 |
| `LoadBrowserProcessSpecificV8Snapshot` fuse | ADR-0018 第 1 条 | 维持关闭：M0 没有测量启动收益 | T44 测量启动时间时决定，R5 检查 |
| Velopack 接入 | ADR-0018 第 3、4 条 | 未签名打包、按用户安装、相邻版本更新、卸载可用；更新前校验清单签名的接入方式未实现 | S6 第 9 节；T50 把 `piarc_core::release` 接入更新流程 |
| 发布清单签名校验 | ADR-0018 第 4 条 | Core 校验通过，篡改、换密钥、无公钥全部拒绝（ADR-0024） | S6 第 6 节 |
| 首次运行："仍要打开"（macOS 15 与 26）、Gatekeeper 是否单独拦截内置 node | ADR-0018 第 2 条 | 未验证（本机关着 Gatekeeper，没有 macOS 15 设备） | T50 首次发布前（I42），R6 检查 |
| SmartScreen 放行 | ADR-0018 第 3 条 | 未观察到（本机关着"检查应用和文件"） | T50 首次发布前（I49），R6 检查 |
| TCC 责任归属 | ADR-0015 配套 | 机制分析：Core 启动的子进程以 PiArc 为负责方，授权记在 PiArc 的代码身份上、每次更新失效；未实测 | T39 用 MCP server 读 `~/Documents` 实测 |
| npx 拉起 MCP 与原生模块加载 | ADR-0015 配套 | registry 包可用，`@napi-rs/lzma` 原生模块加载通过；`npx <本地目录>` 在 Seatbelt 下失败（I40） | S6 第 4.3 节；T36 处理 I40 |
| Seatbelt 下的 bash/grep/find、git、`worker_threads` | ADR-0015 配套 | 全部正常，越界写入 `EPERM` | S6 第 4.2 节 |
| Pi 资源定位（`PI_PACKAGE_DIR`） | ADR-0015 配套 | 需要：打包时写 `pi-assets/package.json`，运行时以 `PI_PACKAGE_DIR` 指向它 | 架构 5.6 |
| 安装包增量 | ADR-0015 配套 | 内置 node 在 macOS 占 145 MiB（安装后）、Windows 102 MiB | S6 第 8、9.2 节 |

## 7. 性能预算校准

第 11 章逐行写了两个平台的 M0 实测值、原预算与校准后预算（架构 v2.17），这里只列改动与口径。

收紧规则：两个平台都有有效实测值，且原预算不低于两者中较差值的 2 倍时，收紧为较差值的 2 倍（向上取两位有效数字）；只有一个平台的数据、某个平台的口径无效、或 M0 的场景不覆盖该行条件时不改。余量取 1 倍：M0 测的是原型（没有侧栏、真实会话与存储），正式实现的工作量更大，两台测量机也都不是基准机型。

| 行 | 原预算 | 校准后 | 依据 |
|---|---|---|---|
| 流式渲染的帧时间 | p99 ≤ 16 ms | 每帧主线程工作 p99 ≤ 12 ms | macOS 5.7 ms、Windows 4.7 ms；口径按 S1 第 2 节（rAF 间隔在 60 Hz 屏上本身就是 16.7 ms，不能对照） |
| 冷加载 1,000 条 item | ≤ 300 ms | ≤ 170 ms | macOS 52 ms、Windows 81 ms |
| Core 事件到渲染进程（主进程转发） | p95 ≤ 5 ms | p95 ≤ 1.1 ms | macOS 0.50 ms、Windows ≤ 0.21 ms（每次投递，常规批次） |
| 主进程内存（含 Core，空闲） | ≤ 120 MB | 相对同平台同版本裸 Electron 的增量 ≤ 24 MB（**放宽**，原因见架构第 18 章修订记录） | 120 MB 低于 macOS 上裸 Electron 自身的 155 MB；Windows 裸 Electron 96 MB，原预算隐含的增量正是 24 MB；实测增量 macOS 5–8 MB、Windows 12 MB |
| 应用全部进程合计 | ≤ 450 MB | macOS ≤ 510 MB（**放宽**），Windows ≤ 450 MB 不变 | macOS 按主进程基线的同等差额（155 − 96 ≈ 59 MB）调整；两平台的实测仍超出（macOS 513 MB 含测试驱动，Windows 472 MB），交 T44 |

测量口径的校准（预算值不变）：

- **主进程事件循环延迟**：计时器粒度粗于 1 ms 的平台（Windows 默认约 15.6 ms），以同机、同口径、同一轮测得的空闲基线为零点，取"满载 p99 − 空闲 p99"。按此 W0 的 S2 为 0.23 ms（16.81 − 16.58）。
- **终端键入回显的额外延迟**：两组样本各 ≥ 1,000 个，取"完整路径 p95 − 直接写 PTY p95"。逐对相减在 ConPTY 下会把两次独立往返的 0–16 ms 抖动相加，得到以 0 为中心的宽分布。按此 W0 的 S7 为 −0.85 ms（9.00 − 9.85），macOS 为 0.76 ms，与逐对口径的 0.79 ms 一致。
- 两项都由 T44 写进基准脚本并在 CI 中执行；W1 在 Windows 上按新口径复测一次。

超出预算、不放宽的行（作为问题处理）：

| 行 | 预算 | 实测 | 处理 |
|---|---|---|---|
| 应用全部进程合计 | macOS 510 MB / Windows 450 MB | macOS 513 MB（含约 27 MB 测试驱动与原型页）、Windows 472 MB（GPU 进程 137 MiB） | T44 在 T18 的正式外壳上复测并优化，R4（M3 退出标准含内存预算）复核 |
| Agent Host 内存（1 个活动会话） | ≤ 150 MB | macOS 165–168 MB（空闲无会话就有 157 MB）；Windows 未测 | T44 分析启动时的堆与模块加载（Pi bundle 15 MB），R4 复核 |
| 安装包体积 | ≤ 200 MB | macOS 168.8 MB；Windows 225.3 MB（开发构建） | T44 裁剪（不需要的 locales 48.8 MiB、单架构安装包等），R5 复核 |
| 安装后体积 | ≤ 450 MB | macOS 449.0 MB（余约 1 MB）；Windows 521.3 MB（Electron 本体约 360 MiB） | T44 裁剪（npm 文档与 man 页、locales、`dxcompiler.dll` 是否需要），R5 复核；裁剪后仍超出时，在 R5 按第 11 章规则决定 |

未测的行（冷启动、Agent Host 就绪、首 token 额外延迟、8 小时内存增长、会话切换的缓存命中、权限裁决、空闲 CPU、两类崩溃恢复）由 T44 测量；权限裁决由 T20 先给出基准。

## 8. 验收项与登记事项

- T02–T12 的 144 个验收项与 W0 的 15 项全部 `passing`。W0-A04、A10 原为 `failing`，按第 7 节的口径达标，用户在 R1 中授权改判（执行协议只允许任务改自己的验收项，所以先请用户确认；计划变更记录 v1.3）。
- M0 的登记事项 I01–I49 在 `PLAN.md` 中逐条有归属；R1 决定的几项：

| 编号 | R1 的决定 |
|---|---|
| I04 | App Intents 的可行性不在 R1 追加验证，留给 T49 的原型（不影响 M1） |
| I12、I26 | 按第 7 节校准：主进程改为相对裸 Electron 的增量，进程合计分平台；仍超出的部分交 T44 |
| I19、I46 | 不新增独立的请求通道（会改变 AHP 的传输，属变更型）：T14 的事件消费者持续取走事件，不在消费路径上阻塞；R2 用 T14 的场景测工具 I/O 在通知洪峰下的延迟，超标时再写 ADR |
| I23 | 与审查发现 R1-C9、A5 合并为 I57，交 T21 |
| I25 | macOS 的 composer 真实输入法与触控板核对交 T19，R2 检查 |
| I41、I45 | 不放宽体积预算，T44 裁剪，R5 复核 |
| I42、I49 | T50 首次发布前在开启 Gatekeeper、SmartScreen 的机器上完成，R6 检查 |
| I44 | 口径按第 7 节校准；W0-A04、A10 经用户授权改判为通过，W1 按新口径复测 |

- R1 新增 I50–I61（审查发现中范围较大的部分），负责任务见 `PLAN.md`。

## 9. 前提条件

| # | 条件 | 负责 | 检查时间点 |
|---|---|---|---|
| 1 | W1 按第 7 节的口径在 Windows 上复测事件循环延迟与回显延迟（W0-A04、A10 已改判） | W1 | R3 |
| 2 | macOS composer 的真实输入法与触控板核对（S1 M1–M4、M7–M10），两个平台的日文输入法 | T19（macOS）、W1（Windows） | R2、R3 |
| 3 | 健壮性问题 I50、I53、I56、I57、I58、I59 在各自任务中处理，T14 的事件消费者不阻塞（I19、I46） | T14、T16、T17、T19、T21 | R2 |
| 4 | 进程合计内存与 Agent Host 单会话内存回到预算内 | T44 | R4 |
| 5 | 体积回到预算内；`LoadBrowserProcessSpecificV8Snapshot` 有结论；未测的预算行有数据 | T44 | R5 |
| 6 | 首次运行的系统放行流程（Gatekeeper、SmartScreen）实机确认，Velopack 更新接入清单校验 | T50 | R6（首次发布前） |
| 7 | 终端的防线与上限（I51），终端线程与同步创建（I55） | T33、T34 | R4 |
