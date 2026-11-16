# M0 技术验证

M0 用代码验证架构中依赖运行时行为、读文档无法确认的假设。验证项与通过标准以[架构设计第 16 章](../architecture/ARCHITECTURE.md#16-路线图与里程碑)的"M0 spike 清单"为准，这里只跟踪进度。每项在 macOS 与 Windows 上分别给结论。

每项完成后在本目录写一份报告 `Sxx-短标题.md`，内容包括：

- 验证环境与版本；
- 做了什么；
- 实测数据；
- 结论（通过 / 有条件通过 / 不通过）。

不通过或有条件通过的项，必须按对应 ADR 的触发条件处理，需要时提 ADR。

| 编号 | 验证内容 | macOS（任务） | Windows（任务） | 报告 |
|---|---|---|---|---|
| S1 | 渲染进程 transcript 与 composer：流式、滚动、选择、输入法 | 有条件通过（R1 改判：composer 的真实输入法与日文未核对，T19 补做；T09：100 token/s 流式 60 s 无长任务、每帧主线程工作 p99 5.7 ms；万条滚动 60 fps；千条冷加载 52 ms；渲染进程 179 MiB；XSS 载荷全部为文本、CSP 未改；CDP 输入法用例通过；真实拼音/日文输入法与触控板手感待用户核对，见报告第 7 节；库选型 ADR-0022） | 有条件通过（R1 改判：日文输入法未验证，W1 补做；W0：L4 两种形态通过；流式每帧工作 p99 4.7 ms、75 Hz 滚动 75 fps、千条冷加载 81 ms、渲染进程 137 MiB；微软拼音实机核对全部符合预期；全部进程 450 MiB 与 macOS 同样超预算，I26；日文输入法未验证） | [S01-transcript-composer.md](S01-transcript-composer.md) |
| S2 | NAPI-RS Core 接入主进程：事件吞吐、事件循环延迟、四个目标 | 通过（T04：吞吐、延迟、同步调用、大批次、darwin 两个目标加载通过；大批次按 ADR-0019 复制转发；空闲内存预算待 R1 校准，I12） | 通过（R1 按校准后的口径：超出同机空闲基线 0.23 ms；W0-A04 的改判待用户确认；W0：x64 与 arm64 加载通过（arm64 为 CI 的 arm64 实机 runner）；50 万事件无丢失无乱序，同步调用 p99 0.008 ms，空闲主进程 108 MB；事件循环延迟原始值 p99 16.81 ms，受 Windows 约 15.6 ms 计时器粒度支配，空闲基线 p99 16.58 ms，测量口径交 R1） | [S02-napi-event-channel.md](S02-napi-event-channel.md) |
| S3 | Agent Host 同进程多会话互不串扰 | 通过（T06：工具副作用、中断、压缩、MCP 均按会话隔离；中断后的对话形态待 T14（I18），MCP 共享池待 T36） | 通过（W0 本机 `cargo test -p piarc-testkit --test agent_host` 12 项通过；CI 的 verify 在更早的失败处停止，W0 修复后由下次 CI 复核） | [S03-multi-session.md](S03-multi-session.md) |
| S4 | Operations 委托与规范名工具 | 通过（T07：六个规范名工具的 I/O 全部经 Core，场景期间 Agent Host 零直接调用，17 个对照场景 16 个一致、1 个有意差异，`fs/read` 往返 p95 约 0.2 ms；read/write/edit 用替身路径、grep 自写，见 ADR-0020） | 通过（W0 本机：工具委托、Profile 改名、I/O spy 与对照场景通过，Windows 上 Bash 用 Git Bash） | [S04-operations-delegation.md](S04-operations-delegation.md) |
| S5 | 凭据保险箱与 Pi 凭据接口适配 | 通过（T08：篡改任一字节都读不出条目，主密钥状态表在登录钥匙串实测；Pi 1.5.2 的注入点是异步 `CredentialStore`；两个 Agent Host 三个会话只刷新一次 token；数据目录、日志、临时目录与进程环境中无明文，见 ADR-0021；更新后的钥匙串弹窗次数待 T12） | 通过（W0：凭据管理器实机创建、读取、删除与主密钥缺失；数据目录与临时目录无明文；Agent Host 与 MCP server 的进程环境经 PEB 读取无凭据） | [S05-credential-vault.md](S05-credential-vault.md) |
| S6 | 未签名打包、首次运行、内置 Node 与发布清单 | 有条件通过（T12：arm64、x64 的 DMG 与 ZIP 本机产出，分层 ad-hoc 签名与 fuse 检查通过，内置 node 保留官方签名；hardened runtime 需配 `disable-library-validation` 才能启用，已启用并实测阻止 DYLD 注入；打包产物经 `sandbox-exec` 宽松配置完成 mock 对话，bash、grep、find、git、`worker_threads`、npx 拉起 MCP、原生模块正常，越界写入 `EPERM`；发布清单签名与三种篡改用例通过（ADR-0024）；DMG 168.8 MB、安装后 449.0 MB；钥匙串每次更新弹 1 次（实机确认）；系统通知可用，允许后横幅显示，但程序侧 `show` 不反映是否允许（I43）；Gatekeeper 开启时的首次打开未验证（实机关着 Gatekeeper，无 macOS 15 设备，I42）） | 有条件通过（W0：按用户安装无 UAC，AUMID 与图标一致，已安装应用经 Job Object 完成 mock 对话，`Update.exe apply` 0.0.2 → 0.0.1 → 0.0.2 可行，卸载清理程序文件与登记，Defender 无报警；安装包 225 MB、安装后 521 MB 超预算（I45）；本机关着 SmartScreen"检查应用和文件"与系统通知，放行流程与横幅无法观察（I49）；卸载留下 Electron 默认 userData（I48）） | [S06-packaging-first-run.md](S06-packaging-first-run.md)、[检查清单](S06-first-run-checklist.md) |
| S7 | 终端：libghostty-vt、PTY、帧协议、渲染器 | 通过（T10：vim/top 渲染正确，帧与 formatter 逐格一致；`cat` 100 MB 主进程事件循环 p99 2.04 ms、无长任务，持续 1 GB 时合成器丢 1 帧；键入回显额外延迟 p95 0.79 ms（帧作为拉取请求的返回值，ADR-0023）；darwin 两个目标链接通过；真实拼音候选框核对全部符合预期（报告第 8 节）；路线结论：正式路线，不启用 xterm.js 退路） | 通过（R1 按校准后的口径：两组样本 p95 之差 −0.85 ms；W0-A10 的改判待用户确认；W0：修复 ConPTY 两处缺陷（自行退出无 `Exited`、继承的忽略 Ctrl+C）；vim 与整屏刷新渲染正确、帧与 formatter 一致、resize/Ctrl+C/终止正常；100 MB 输出期间主进程 p99 14.3 ms；回显额外延迟原始 p95 6.9 ms 但均值 −0.1 ms，测量口径交 R1；不随附 conpty.dll；微软拼音实机核对全部符合预期；arm64 上的终端运行经 CI 的 `core-load` 通过） | [S07-terminal.md](S07-terminal.md) |
| S8 | 沙箱：Seatbelt 与网络代理；Job Object | 通过（T11：写入限于工作区、会话临时目录与附加目录，23 项受保护路径与 `denyRead` 生效；代理按白名单放行、拒绝回环与云元数据地址，绕过代理的连接全部失败；git、npm install、cargo build、python 正常；停止后进程组为空；每条命令额外 8.4 ms（p50），代理每请求额外约 0.1 ms） | 通过（W0：Job Object 终止三级进程树；`taskkill /F` 结束主进程后，Agent Host 与其经 npx 启动的 7 个进程全部退出；Core 直接启动的普通命令尚未进 Job，I33/T17） | [S08-sandbox.md](S08-sandbox.md) |
| S9 | AHP 握手、背压、崩溃重启与对账 | 通过（T06：六类故障注入全部通过；写队列满时返回可重试的 `busy`；进程树清理待 T17（I17）） | 通过（W0 本机：注入与真实进程用例通过；Windows 上 Node 写管道式 stdout 是同步的，Core 停读时 Agent Host 整体停住而不是在内存中排队，内存有界、不丢失、不误判挂死的结论不变，见 S9 报告） | [S09-ahp-resilience.md](S09-ahp-resilience.md) |
| S10 | Electron 安全基线 | 通过（T03：CSP、导航、IPC、fuses 通过；T09：XSS 载荷集通过，剪贴板写入加入权限放行清单；R1：审查确认并修复 4 个渲染与 IPC 缺陷） | 通过（W0 本机按 CI 同款步骤：开发构建 L4 两种形态 138 项通过、发布构建 9 个 fuse 一致；CI 的 Windows L4 曾因剪贴板 CRLF 失败，已修） | [S10-electron-security.md](S10-electron-security.md) |

M0 的汇总结论与进入 M1 的前提见 [M0-summary.md](M0-summary.md)：**有条件进入 M1**（R1，2026-11-16）。
