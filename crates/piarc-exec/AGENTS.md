# piarc-exec

进程与 shell 命令（架构第 6.11 节，ADR-0028）：`ProcessSpawner` 的两个实现（只终止直接子进程的 `TokioProcessSpawner`，终止整棵进程树的 `ProcessTreeSpawner`）、`CommandRunner`（超时与两段终止），以及 T17 的命令行为模块：`limits`（阈值）、`capture`（输出预算与落盘）、`semantic`（语义退出码）、`env`（登录 shell 环境与剔除）、`shells`（bash / Git Bash / PowerShell 的探测与参数）、`cwd`（bash 命令的最终目录），以及 T32 的 `task_log`（后台任务的输出文件）与 `OutputCapture::hand_over`，T33 的 `terminal_tree`（终端里 shell 启动的全部进程）。`piarc-core::tool_io::exec` 把它们装配成 `exec/run`，后台任务的编排在 `piarc-core::tasks`。不决定命令能否运行（`piarc-policy`），不生成沙箱配置（`piarc-sandbox`），不管 PTY（`piarc-term`）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-exec` | 全部单元测试；`termination_tests` 是进程树（超时、取消、shell 退出后的后台进程、运行时关闭各自按 PID 确认子孙进程退出）、SIGTERM 先于 SIGKILL、注入时钟上的 2/10 分钟超时（`CommandRunner::with_clock`）、两个管道各 50 MB |
| `cargo test -p piarc-exec termination -- --nocapture` | 只跑终止相关测试并打印 PID 与 100 MB 耗时 |
| `cargo test -p piarc-exec terminal_tree` | 终端进程树（T33）：挂断结束进程组、忽略挂断的进程在宽限后被杀（Unix）；Windows 上结束 Job 终止 shell 与子进程 |
| `cargo clippy -p piarc-exec --all-targets -- -D warnings` | lint；Windows 代码在 macOS 上用根 `AGENTS.md` 的交叉 clippy 命令 |

Core 层的集成测试在 `crates/piarc-core/tests/exec_commands.rs`（cwd、超时、落盘、50 MB、语义、环境、`exec/shells`、Windows 中文输出）与 `tests/tool_io.rs`。

## 终止流程

- 停止 = `ProcessControl::terminate`（Unix 向进程组发 `SIGTERM`；Windows 直接 `TerminateJobObject`）→ 等 `kill_grace`（默认 2 s）→ `kill`（`SIGKILL`）。触发：超时、取消令牌（`exec/kill`、回合中断、连接断开、会话关闭）、输出管道读取错误（标记具体流并报告失败）、输出通道关闭、`run` 的 future 被丢弃（drop guard）。
- 等到 shell 退出后 `watch` 丢弃 `ProcessControl`：`ProcessTreeSpawner` 的句柄丢弃即 `killpg(SIGKILL)` / 关闭 Job，命令留在后台的进程随之结束。所以 shell 先退出时，忽略 `SIGTERM` 的孙进程立刻收到 `SIGKILL`，不再等宽限。
- `TokioProcessSpawner` 只杀直接子进程，Core 的命令不再用它（只剩 T06 的测试与兼容）。

## 后台任务（T32，ADR-0049）

- `task_log.rs` 的 `TaskLog`：按读到的顺序把两个管道的原始字节追加写入文件（不缓冲，模型边跑边 Read），计字节数，按管道切行并保留最后 `TAIL_LINES`（50）行；`write` 返回这块补全的行（Monitor 用）。未完的行超过 `MAX_PENDING_BYTES`（64 KiB）就切成一行，保留的行截到 `MAX_LINE_CHARS`。写失败只停写、不停计数（`error()`）。`read_chunk` 按字节偏移读回文本，不到文件末尾时停在字符边界之前。
- 转后台不重启进程：Core 不把超时交给 `CommandRunner`（`CommandSpec.timeout` 为 `None`），由任务时钟计时；到时输出消费者调 `OutputCapture::hand_over`（已落盘就交出文件，否则交出文本与未完的 UTF-8 字节），Core 把落盘文件改名为任务输出文件后 `TaskLog::resume`，或新建后写入文本。`CommandRunner` 的超时仍给 hooks 等调用方用。
- 停止后台任务就是取消 `CommandRunner::run` 的令牌：与回合中断同一条两段终止路径。Windows 上每个命令（因此每个后台任务）一个 Job Object（`ProcessTreeSpawner`），KillShell 与应用退出终止整个 Job。

## 终端的进程树（`terminal_tree.rs`，T33）

- 终端的 shell 由 PTY 库（`piarc-term`）启动，不经 `ProcessTreeSpawner`，所以 `TerminalTree::attach(pid, tty)` 在启动后收集：macOS 记下 shell 的 pid 与终端设备，结束时先用 `tty_processes::processes_of_tty`（`proc_listpids(PROC_TTY_ONLY)`，唯一的 `unsafe`）列出控制终端是它的全部进程，再挂断（关闭 master）、向它们的全部进程组发 `SIGHUP` 与 `SIGCONT`，等 `HANGUP_GRACE`（2 s）后对剩下的发 `SIGKILL`。交互式 shell 把每个作业放进自己的进程组，只杀 shell 的进程组不够。自己 `setsid` 离开终端的进程（守护进程）不在其中。
- Windows：shell 启动后立刻加入一个 `KILL_ON_JOB_CLOSE` 的 Job Object（`Job::assign_pid`），之后它启动的都在 Job 里，结束即终止 Job，没有宽限。shell 加入 Job 之前（启动后的一瞬间、读到任何输入之前）启动的进程不在 Job 里。
- 列进程要在挂断之前：挂断后进程脱离终端，按终端设备就找不到了。Core 的 `Terminals` 负责在关闭终端与有序关闭时调用 `end` 并等它结束。

## cwd 跟踪（`cwd.rs`）

- 自动允许（只读白名单、自动接受编辑的文件命令，T23）依赖的每个外部程序由 `CwdProbe::pin_program(名称, 路径)` 在启动时核对 Bash 实际解析的文件并锁定物理程序（`hash -p`），解析变化时以 126 退出、不运行命令；名称只接受字母、数字与 `._+-`。Core 发现项目可控的 PATH、用户覆盖或启动脚本时由审批卡决定，人工批准后的命令同样只继承 ADR-0035 所列的字段。
- 不改命令文本：`BASH_ENV` 指向会话临时目录 `exec/<requestId>.bash-env`，内容是 `trap 'builtin pwd -P >| <answer>' EXIT` 加 `unset BASH_ENV`，模型命令不继承用户的 `BASH_ENV`。退出码在 `EXIT` trap 中保持；子 bash 看不到 `BASH_ENV`，不会覆盖答案。
- 没有答案（命令 `exec` 换掉了 shell、自己装了 `EXIT` trap、被杀）时 Core 保持原目录。Windows 上 trap 用 `pwd -W`（不支持时退回 `pwd -P`），答案是 `C:/…`，`msys_to_windows` 转换。不要改回 `pwd -P`：Git Bash 把 `%TEMP%` 挂载为 `/tmp`、把 Git 目录挂载为 `/usr`，这些名字转换不回 Windows 路径，工作区在 `%TEMP%` 下时 `cd` 会被当成越界（W1）。

## 阈值与清单的位置

- `limits.rs` 的 `ExecLimits::default()` 是全部阈值的唯一定义：默认超时 120 s、上限 600 s、内联 30,000 字符、预览 2,000、失败头 10,000 / 尾 20,000、终止宽限 2 s。Core 经 `ToolIoConfig.exec_limits` 传入；Agent Host 的工具描述里写的 120/600 与之对应，改值时一起改。
- 语义退出码表 `semantic::EXIT_ONE_MEANINGS`：`grep`/`egrep`/`fgrep`/`rg` → no matches，`diff`/`cmp` → files differ，`test`/`[` → condition is false。只对单个简单命令（未加引号的 `| & ; \n ( ) ` 与命令替换都算复合）；允许前置 `NAME=value` 与带目录的程序名。
- `env::command_environment` 是 Bash、PowerShell 和 Git Bash 定位探测的继承清单（ADR-0035）。登录 shell 解析与回退均经此筛选。原始环境只用于计算自动审批所需的自定义 shell 标志。Windows 按大小写不敏感匹配字段。

## Windows 差异

- Git Bash 探测顺序见 `shells.rs` 模块文档；不用 `PATH` 上的 `bash.exe`（WSL）。启动 bash 一律用 `shells::bash_invocation`：Windows 上命令放在环境变量 `PIARC_COMMAND` 里，`-c` 只带一段先 `unset` 再 `eval` 的短脚本（输出、退出码、运行期报错与 `-c` 相同，语法错误报 `eval: line N`；W2 在 Git for Windows 2.56 实测退出码为 2、heredoc 保留原样，`exec_commands` 的 `heredocs_and_syntax_errors_through_eval_on_windows` 锁定）。Git Bash 的运行时自己解析 Windows 命令行，12,000 字符、带引号的 `-c` 参数被截断过（CI，T25 的 hook 测试与 `exec_commands` 的长命令用例）。PowerShell 参数沿用 Pi 的 UTF-8 前缀与 5.1 退出码后缀（MIT，`third-party/sources.json` 已登记），前缀占一行，错误位置的行号因此加 1。
- Windows 没有登录 shell：命令继承准入清单筛选后的进程环境（Core 加 `LANG=C.UTF-8` 给没有 locale 的 Git Bash）。`ProcessTreeSpawner` 的 `terminate` 与 `kill` 相同（Job 没有温和终止），退出码为 1，没有 signal。
- 两个启动器在 Windows 上都带 `CREATE_NO_WINDOW`（`spawner::command`，`ProcessTreeSpawner` 再与 `CREATE_SUSPENDED` 合并）：PiArc 是图形界面进程，不加时 git、bash.exe、PowerShell 与 Agent Host 的 node 各自弹出控制台窗口，默认终端为 Windows Terminal 时还会报 `0x800700e8`（W1）。测试 `children_run_without_a_console_window` 先 `FreeConsole` 再启动子进程，模拟图形界面父进程。
- Git Bash 的 `$!` 是 MSYS 的 pid；Windows pid 在 `/proc/<pid>/winpid`（`termination_tests.rs` 的 `LAST_PID`）。
- PowerShell 输出编码、Git Bash 路径转换与中文输出只能在 Windows 上验证：CI 跑 `exec_commands.rs` 的 Windows 用例与 L2 的 `exec-windows-shells`，实机核对留给 W1。

## 易错点

- 公开的文件与进程函数（`TaskLog::create`/`resume`、`task_log::read_chunk`、`TerminalTree::attach`、`CwdProbe::prepare`/`pin_program`）返回 `piarc_exec::Error`（`error.rs`，带 `kind()`、`retryable()`，I173）；Core 经 `piarc_core::error::exec_error_object` 把 `File` 变体按 `piarc_fs::Error::io` 的形状报告（保留 `ENOENT` 等代码与路径）。`CommandRunner::run` 仍返回 `io::Result`：它的失败来自注入的 `ProcessSpawner`。
- 后台任务的 `TaskLog` 由 Core 以 `Arc<Mutex<_>>` 共享给消费者与快照：持锁只做一次写入或读尾部行，不要在锁里等待。
- `ProcessControl::wait` 与 `kill`/`terminate` 都借用 `&mut self`：等待与停止分两步写（`watch` 的 `select!` 只决定原因，`stop_process` 再停）。
- `OutputCapture::push` 在异步任务里同步写文件（`BufWriter`），只在输出超过内联预算后才写；不要在这里做阻塞更久的事。
- 登录 shell 会执行用户的配置文件：测试里用 `/bin/bash` 加临时 `HOME` 的 `.bash_profile`（`env.rs` 的测试、L2 运行器），不要依赖开发机自己的 shell 配置；macOS 的 `/etc/profile` 会经 `path_helper` 重排 `PATH`，断言写"包含"不写"等于"。
- 不要用 tokio 的暂停时钟（`start_paused`）测命令超时：Windows 上子进程管道在阻塞线程池上读，进行中的阻塞任务会阻止暂停时钟自动前进，定时器永远不触发（CI 运行 44116918422 卡到作业超时）。超时走注入的 `Clock`（`CommandRunner::with_clock`），宽限与 `EXIT_GRACE` 仍用 tokio 计时。
- Git Bash 在繁忙的 Windows 机器上启动可能超过几百毫秒：测试等第一段输出或文件出现再动作，不按固定延迟。
