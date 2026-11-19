# piarc-exec

进程与 shell 命令（架构第 6.11 节，ADR-0028）：`ProcessSpawner` 的两个实现（只终止直接子进程的 `TokioProcessSpawner`，终止整棵进程树的 `ProcessTreeSpawner`）、`CommandRunner`（超时与两段终止），以及 T17 的命令行为模块：`limits`（阈值）、`capture`（输出预算与落盘）、`semantic`（语义退出码）、`env`（登录 shell 环境与剔除）、`shells`（bash / Git Bash / PowerShell 的探测与参数）、`cwd`（bash 命令的最终目录）。`piarc-core::tool_io::exec` 把它们装配成 `exec/run`。不决定命令能否运行（`piarc-policy`），不生成沙箱配置（`piarc-sandbox`），不管 PTY（`piarc-term`）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-exec` | 全部单元测试；`termination_tests` 是进程树（超时、取消、shell 退出后的后台进程、运行时关闭各自按 PID 确认子孙进程退出）、SIGTERM 先于 SIGKILL、注入时钟上的 2/10 分钟超时（`CommandRunner::with_clock`）、两个管道各 50 MB |
| `cargo test -p piarc-exec termination -- --nocapture` | 只跑终止相关测试并打印 PID 与 100 MB 耗时 |
| `cargo clippy -p piarc-exec --all-targets -- -D warnings` | lint；Windows 代码在 macOS 上用根 `AGENTS.md` 的交叉 clippy 命令 |

Core 层的集成测试在 `crates/piarc-core/tests/exec_commands.rs`（cwd、超时、落盘、50 MB、语义、环境、`exec/shells`、Windows 中文输出）与 `tests/tool_io.rs`。

## 终止流程

- 停止 = `ProcessControl::terminate`（Unix 向进程组发 `SIGTERM`；Windows 直接 `TerminateJobObject`）→ 等 `kill_grace`（默认 2 s）→ `kill`（`SIGKILL`）。触发：超时、取消令牌（`exec/kill`、回合中断、连接断开、会话关闭）、输出管道读取错误（标记具体流并报告失败）、输出通道关闭、`run` 的 future 被丢弃（drop guard）。
- 等到 shell 退出后 `watch` 丢弃 `ProcessControl`：`ProcessTreeSpawner` 的句柄丢弃即 `killpg(SIGKILL)` / 关闭 Job，命令留在后台的进程随之结束。所以 shell 先退出时，忽略 `SIGTERM` 的孙进程立刻收到 `SIGKILL`，不再等宽限。
- `TokioProcessSpawner` 只杀直接子进程，Core 的命令不再用它（只剩 T06 的测试与兼容）。

## cwd 跟踪（`cwd.rs`）

- 自动接受编辑放行的系统文件命令由 `CwdProbe::pin_utility` 在启动时核对 Bash 实际解析的文件并锁定物理程序。Core 发现项目可控的 PATH、用户覆盖或启动脚本时由审批卡决定，人工批准后按原有 shell 环境执行。
- 不改命令文本：`BASH_ENV` 指向会话临时目录 `exec/<requestId>.bash-env`，内容是 `trap 'builtin pwd -P >| <answer>' EXIT` 加 `unset BASH_ENV`（用户原有的 `BASH_ENV` 则先 `export` 回去再 source）。退出码在 `EXIT` trap 中保持；子 bash 看不到 `BASH_ENV`，不会覆盖答案。
- 没有答案（命令 `exec` 换掉了 shell、自己装了 `EXIT` trap、被杀）时 Core 保持原目录。Windows 上答案是 `/c/…`，`msys_to_windows` 转换；`/tmp`、`/usr` 等 Git 自己的目录转换不了，按越界处理。

## 阈值与清单的位置

- `limits.rs` 的 `ExecLimits::default()` 是全部阈值的唯一定义：默认超时 120 s、上限 600 s、内联 30,000 字符、预览 2,000、失败头 10,000 / 尾 20,000、终止宽限 2 s。Core 经 `ToolIoConfig.exec_limits` 传入；Agent Host 的工具描述里写的 120/600 与之对应，改值时一起改。
- 语义退出码表 `semantic::EXIT_ONE_MEANINGS`：`grep`/`egrep`/`fgrep`/`rg` → no matches，`diff`/`cmp` → files differ，`test`/`[` → condition is false。只对单个简单命令（未加引号的 `| & ; \n ( ) ` 与命令替换都算复合）；允许前置 `NAME=value` 与带目录的程序名。
- 环境剔除清单 `env::{INTERNAL_PREFIXES, INTERNAL_NAMES, SHELL_STATE}`：`ELECTRON_*`、`PIARC_*`、`PI_*`，`NODE_OPTIONS` 等 Node/Electron 变量，`_`、`SHLVL`、`PWD`、`OLDPWD`。Windows 上不区分大小写。

## Windows 差异

- Git Bash 探测顺序见 `shells.rs` 模块文档；不用 `PATH` 上的 `bash.exe`（WSL）。PowerShell 参数沿用 Pi 的 UTF-8 前缀与 5.1 退出码后缀（MIT，`third-party/sources.json` 已登记），前缀占一行，错误位置的行号因此加 1。
- Windows 没有登录 shell：环境就是进程环境（Core 加 `LANG=C.UTF-8` 给没有 locale 的 Git Bash）。`ProcessTreeSpawner` 的 `terminate` 与 `kill` 相同（Job 没有温和终止），退出码为 1，没有 signal。
- Git Bash 的 `$!` 是 MSYS 的 pid；Windows pid 在 `/proc/<pid>/winpid`（`termination_tests.rs` 的 `LAST_PID`）。
- PowerShell 输出编码、Git Bash 路径转换与中文输出只能在 Windows 上验证：CI 跑 `exec_commands.rs` 的 Windows 用例与 L2 的 `exec-windows-shells`，实机核对留给 W1。

## 易错点

- `ProcessControl::wait` 与 `kill`/`terminate` 都借用 `&mut self`：等待与停止分两步写（`watch` 的 `select!` 只决定原因，`stop_process` 再停）。
- `OutputCapture::push` 在异步任务里同步写文件（`BufWriter`），只在输出超过内联预算后才写；不要在这里做阻塞更久的事。
- 登录 shell 会执行用户的配置文件：测试里用 `/bin/bash` 加临时 `HOME` 的 `.bash_profile`（`env.rs` 的测试、L2 运行器），不要依赖开发机自己的 shell 配置；macOS 的 `/etc/profile` 会经 `path_helper` 重排 `PATH`，断言写"包含"不写"等于"。
- 不要用 tokio 的暂停时钟（`start_paused`）测命令超时：Windows 上子进程管道在阻塞线程池上读，进行中的阻塞任务会阻止暂停时钟自动前进，定时器永远不触发（CI 运行 44116918422 卡到作业超时）。超时走注入的 `Clock`（`CommandRunner::with_clock`），宽限与 `EXIT_GRACE` 仍用 tokio 计时。
- Git Bash 在繁忙的 Windows 机器上启动可能超过几百毫秒：测试等第一段输出或文件出现再动作，不按固定延迟。
