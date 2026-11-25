# W3 · Windows M3 达标

**M3 的功能在 Windows 上全部可用，退出标准与 macOS 一样卡在内存一项。** 3 个并行会话加子 agent 时 Agent Host 最大 163 MB（上限 270 MB，达标），应用其余进程最大 576 MB，超出 Windows 预算 450 MB；同一时刻这些进程的私有工作集合计 256 MB，与 macOS 物理占用约 250 MB 的口径分析一致（I26、I146、I201），口径由用户经 ADR 决定。CI 测不到的部分都在 Windows 11 实机核对过：ConPTY 终端与输入法、内置 Node 启动的 MCP、Windows 路径下的 worktree、托盘、多窗口、`piarc://` 与资源管理器右键菜单、讲述人与 NVDA、高对比度。开工时 Windows 基准检查有 5 步失败（T37–T45 只在 macOS 跑过）；W3 修了其中的 10 个 Windows 缺陷，每个都先有在 Windows 上失败的测试。按用户要求，收尾的全量 `npm run verify` 没有运行（W3-A12 为 blocked）。

## 1. 环境

| 项 | 值 |
|---|---|
| 机器 | 华为 KLVG-XX，Intel i5-1340P（4P+8E，16 线程），16 GB，NVMe 1 TB；与 W0 同一台，**不是**第 11 章的基准机型 |
| 系统 | Windows 11 专业版 25H2（26200.9974），x64；Defender 实时保护开启；`LongPathsEnabled=1`；Git for Windows 2.56.0（系统配置 `core.autocrlf=true`） |
| 显示 | Intel Iris Xe 2160×1440 @ 60 Hz，缩放 150% |
| 构建 | 本分支的开发构建打包（`npm run package:desktop -- --flavor development`）；安装包取 CI 运行 45009150917（a6701310）的 Velopack 开发构建，`Setup.exe --silent` 安装到 `%LOCALAPPDATA%\cn.piarc.desktop\`（gh 下载的文件没有网络标记，SmartScreen 未拦截） |
| 读屏 | 讲述人（系统自带）；NVDA 2026.3（用户同意后 winget 安装） |
| arm64 | 没有 arm64 设备，未做 |

测量前用户关闭了 Java、浏览器等大型程序（空闲内存约 6.4 GB）；开工时机器负载高，一次全量 `cargo test` 被 Claude Code 因内存不足中止。

## 2. 核对清单

| 项 | 结论 | 证据 |
|---|---|---|
| 终端（ConPTY） | 通过（修 2 个缺陷后） | L4 `t34-terminal-windows`（新增，8 个用例）、`terminal.e2e`、`pointer_windows.rs`（新增）、`pty_windows.rs`、`read_screen.rs`；截图与 formatter 文本在 `tmp/evidence/W3/l4/` |
| 输入法 | 通过 | 用户实机核对微软拼音（composer 与终端面板）；L4 的 CDP 合成用例 |
| 终端性能 | 通过 | 回显额外延迟 4.29、3.58 ms（1,000 对）；`cat` 100 MB 期间事件循环 p99 与空闲相同 |
| MCP | 通过 | `sessions mcp::` 3 个用例；`perf:m3` 中 4 个会话共用 1 个 server 进程 |
| worktree | 通过（修 2 个缺陷后） | `piarc-git` 新增超过 260 字符与小写盘符用例；L2 `worktree-*`、`subagent-worktree` |
| 托盘 | 通过 | L4 `t35-windows` 的托盘计数；用户实机核对深浅色、左右键、恢复与退出确认 |
| 多窗口 | 通过 | L4 `t35-windows` 两个窗口同一审批 |
| URL 与打开文件夹 | 通过 | 安装后的注册表项、`piarc://open` 与右键菜单命令打开文件夹（`tmp/evidence/W3/registration.txt`） |
| 内存（M3 退出标准） | **未达标** | `tmp/evidence/W3/m3-memory-{1,2}.json`、`m3-private-ws.txt` |
| 性能 | 已测，9 项超出 | `docs/engineering/performance.md` 第 6.1 节 |
| 读屏 | 通过 | `docs/engineering/accessibility.md` 第 3 节的讲述人与 NVDA 两列 |

R4 列出的其他重点项：控制字符与终端命令（R4 M1）：`cargo test -p piarc-policy`（含 `bash_cases`）在 Windows 通过，Core 拒绝含控制字符的终端命令的用例只在 Unix 编译（同一函数，没有平台分支），没有在 Windows 上单独跑；I166 的三项已处理（下节）；I175（Windows 上 rename 覆盖正在读的屏幕文件）未单独压测，L4 中共享终端与屏幕文件的用例通过，留给 R5。

## 3. 发现的问题

**已修复**（每项都先有在 Windows 上失败的测试）：

| # | 缺陷 | 复现 | 修复 |
|---|---|---|---|
| 1 | 插件的 `${CLAUDE_PLUGIN_ROOT}` 展开成 `\\?\C:\…\x/y`：`/` 不是分隔符，Git Bash 跑不了 hook | `cargo test -p piarc-config`、L2 `plugin-hooks` | 74f1ffa |
| 2 | worktree 会话里每个文件都被当作受保护路径（`.piarc/` 之下），Accept edits 也要审批 | L2 `worktree-session-create` 等 4 个 | d667b90 |
| 3 | 子 agent 的 `isolation: worktree` 起不来（git 收到 `//?/C:/…`） | L2 `subagent-worktree` | d667b90 |
| 4 | 内置 npm 装包失败（Node 不能运行 `\\?\` 脚本路径） | `piarc-core --lib plugins::` | 00079ce |
| 5 | git 拒绝超过 260 字符的路径（深的 worktree、包克隆） | `piarc-core --lib plugins::`、`piarc-git` 新用例 | 00079ce（`core.longpaths=true`） |
| 6 | 新的安全公告 RUSTSEC-2026-0592（`url` 2.5.8） | cargo-deny | 03b19a0（用户同意升到 2.5.9） |
| 7 | 会话终端（cmd）在 `C:\Windows` 而不是会话目录启动 | L4 `t34-terminal-windows` 第一个用例 | f4439cc |
| 8 | 终端面板常常空白：会话终端先进任务列表、后进 Core 的终端注册表，窗口的 `term/<id>` 订阅被一次拒绝后不再重试 | L4 4/8 用例空白 | f4439cc（订阅重试，`events.test.ts`） |
| 9 | 同一竞态下网格与颜色只发一次：Core 用打开时的格子尺寸换算指针，选区落在两倍的位置 | L4 选区用例 | f4439cc（`#introduce` 重试） |
| 10 | 测试读到本机真实的 `~/.claude/skills`（Windows 的临时目录在用户主目录下）、`core.autocrlf`、路径分隔符、POSIX 路径的断言、fixture 删除 | 基线的 Vitest、`piarc-config`、`piarc-core` 与 L2 | 123ab3d、4c75df1、74f1ffa |

I166：① `piarc-store` 的用例显式设定 mtime（74f1ffa）；② `terminal.e2e` 等 cmd 的提示符出现后再数帧（123ab3d），本机连跑通过；③ `t19-composer` 的提及断言在 R4 已改为等请求，本机通过。

**登记**（`docs/plan/PLAN.md` 登记事项）：I201 Windows 的 3 会话内存（口径同 I26）；I202 发布构建的 Windows 体积未测；I203 本地深路径的 git 包源超出 git 目录的长度上限；I204 Windows 用户终端是 cmd，没有 shell integration；I205 含中文的长提示符在折行处落格不同；I206 ConPTY 不转发 OSC 11；I207 这台笔记本上超出预算的性能行。另外：I174（平台分支收进适配层）属于代码组织，W3 没有动，交 R5；I83 维持交 T48。

## 4. M3 退出标准的 Windows 结论

**2026-11-25 收尾：达标。** ADR-0063 把"应用全部进程合计"改为物理占用之和（Windows 为私有工作集）之后，按改过的脚本复测：Windows 11 专业版 26200、i5-1340P（12 核 16 线程）/ 16 GB、电源已接；打包开发构建 326d5ba8，`npm run perf:m3 -- --form packaged`（943a1a45 的脚本），两轮：30 s 4 个样本与 60 s 9 个样本，3 个并行会话（含独立 worktree）加 1 个子 agent，共享的 stdio MCP server 只启动 1 次，4 个会话都拿到 MCP 工具与 skills 索引（`loadAsDescribed: true`）。应用其余进程的私有工作集最大 305.7、313.7 MB（中位 302.0、306.0 MB，预算 450 MB，达标；工作集 592–622 MB 只作参考），Agent Host 最大 130.1、162.8 MB（预算 270 MB，达标）。测量时本机还有其他程序（可用内存 3.1–3.3 GB），最大值 313.7 MB 低于 ADR-0063 的复核线 360 MB。W3-A01 据此改为通过，W3 完成。

以下是 W3 首次交付时（2026-11-22，ADR-0063 之前）的结论：

"3 个并行会话 + 子 agent 场景满足第 11 章内存预算"：**未达标**，原因与 macOS 相同（RSS/工作集口径下应用其余进程超出，Agent Host 达标）。M3 的其余能力在 Windows 上实机可用，见第 2 节。R5 据此确认。
