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
| S1 | 渲染进程 transcript 与 composer：流式、滚动、选择、输入法 | 通过（T09：100 token/s 流式 60 s 无长任务、每帧主线程工作 p99 5.7 ms；万条滚动 60 fps；千条冷加载 52 ms；渲染进程 179 MiB；XSS 载荷全部为文本、CSP 未改；CDP 输入法用例通过；真实拼音/日文输入法与触控板手感待用户核对，见报告第 7 节；库选型 ADR-0022） | 未开始（W0：微软拼音、Windows 性能测量） | [S01-transcript-composer.md](S01-transcript-composer.md) |
| S2 | NAPI-RS Core 接入主进程：事件吞吐、事件循环延迟、四个目标 | 通过（T04：吞吐、延迟、同步调用、大批次、darwin 两个目标加载通过；大批次按 ADR-0019 复制转发；空闲内存预算待 R1 校准，I12） | 待 CI 结果与 W0（`core-load` 作业已配置；实机基准与 win32-arm64 实机加载留给 W0） | [S02-napi-event-channel.md](S02-napi-event-channel.md) |
| S3 | Agent Host 同进程多会话互不串扰 | 通过（T06：工具副作用、中断、压缩、MCP 均按会话隔离；中断后的对话形态待 T14（I18），MCP 共享池待 T36） | 待 CI 结果（同一组测试在 `verify` 中运行） | [S03-multi-session.md](S03-multi-session.md) |
| S4 | Operations 委托与规范名工具 | 通过（T07：六个规范名工具的 I/O 全部经 Core，场景期间 Agent Host 零直接调用，17 个对照场景 16 个一致、1 个有意差异，`fs/read` 往返 p95 约 0.2 ms；read/write/edit 用替身路径、grep 自写，见 ADR-0020） | 待 CI 结果（同一组测试在 `verify` 中运行，未取得时由 W0 核对） | [S04-operations-delegation.md](S04-operations-delegation.md) |
| S5 | 凭据保险箱与 Pi 凭据接口适配 | 通过（T08：篡改任一字节都读不出条目，主密钥状态表在登录钥匙串实测；Pi 1.5.2 的注入点是异步 `CredentialStore`；两个 Agent Host 三个会话只刷新一次 token；数据目录、日志、临时目录与进程环境中无明文，见 ADR-0021；更新后的钥匙串弹窗次数待 T12） | 待 W0（凭据管理器实机、数据目录扫描与进程环境；替身测试与编译在 `verify` 中运行） | [S05-credential-vault.md](S05-credential-vault.md) |
| S6 | 未签名打包、首次运行、内置 Node 与发布清单 | 有条件通过（T12：arm64、x64 的 DMG 与 ZIP 本机产出，分层 ad-hoc 签名与 fuse 检查通过，内置 node 保留官方签名；hardened runtime 需配 `disable-library-validation` 才能启用，已启用并实测阻止 DYLD 注入；打包产物经 `sandbox-exec` 宽松配置完成 mock 对话，bash、grep、find、git、`worker_threads`、npx 拉起 MCP、原生模块正常，越界写入 `EPERM`；发布清单签名与三种篡改用例通过（ADR-0024）；DMG 168.8 MB、安装后 449.0 MB；钥匙串每次更新弹 1 次（实机确认）；通知能注册但程序侧 `show` 不反映是否允许（I43）；Gatekeeper 开启时的首次打开未验证（实机关着 Gatekeeper，无 macOS 15 设备，I42）） | 待 CI 结果与 W0（`package-windows` 作业出 x64、arm64 Velopack 安装包，相邻两个版本；安装、更新、SmartScreen、智能应用控制、体积留给 W0） | [S06-packaging-first-run.md](S06-packaging-first-run.md)、[检查清单](S06-first-run-checklist.md) |
| S7 | 终端：libghostty-vt、PTY、帧协议、渲染器 | 通过（T10：vim/top 渲染正确，帧与 formatter 逐格一致；`cat` 100 MB 主进程事件循环 p99 2.04 ms、无长任务，持续 1 GB 时合成器丢 1 帧；键入回显额外延迟 p95 0.79 ms（帧作为拉取请求的返回值，ADR-0023）；darwin 两个目标链接通过；真实拼音候选框待用户核对，报告第 8 节；路线结论：正式路线，不启用 xterm.js 退路） | 待 CI 结果与 W0（Windows 选定官方 DLL 放在 `.node` 旁边，`core-build`/`core-load` 已配置；ConPTY、渲染与回显、微软拼音、win32-arm64 实机运行留给 W0） | [S07-terminal.md](S07-terminal.md) |
| S8 | 沙箱：Seatbelt 与网络代理；Job Object | 通过（T11：写入限于工作区、会话临时目录与附加目录，23 项受保护路径与 `denyRead` 生效；代理按白名单放行、拒绝回环与云元数据地址，绕过代理的连接全部失败；git、npm install、cargo build、python 正常；停止后进程组为空；每条命令额外 8.4 ms（p50），代理每请求额外约 0.1 ms） | 待 CI 结果与 W0（Job Object 三级进程树单测在 `verify` 中运行；实机终止进程树与 Agent Host 场景留给 W0） | [S08-sandbox.md](S08-sandbox.md) |
| S9 | AHP 握手、背压、崩溃重启与对账 | 通过（T06：六类故障注入全部通过；写队列满时返回可重试的 `busy`；进程树清理待 T17（I17）） | 待 CI 结果（同一组测试在 `verify` 中运行） | [S09-ahp-resilience.md](S09-ahp-resilience.md) |
| S10 | Electron 安全基线 | 部分完成（T03：CSP、导航、IPC、fuses 通过；T09：XSS 载荷集通过，剪贴板写入加入权限放行清单） | 待 CI 结果（T03 已配置 `desktop` 作业） | [S10-electron-security.md](S10-electron-security.md) |

M0 的汇总结论与进入 M1 的前提由 R1 写入 `M0-summary.md`。
