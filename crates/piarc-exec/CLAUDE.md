# piarc-exec

进程管理：`ProcessSpawner` 的两个实现——只终止直接子进程的 `TokioProcessSpawner`（T06）与终止整棵进程树的 `ProcessTreeSpawner`（T11）——以及 AHP `exec/run` 背后的 `CommandRunner`（T07）。`piarc-core` 注入启动器；本 crate 不决定命令能否运行（`piarc-policy`），不生成沙箱配置（`piarc-sandbox`），不管 PTY（`piarc-term`）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-exec` | 启动器与命令执行：输出、退出码、流式、取消、缺失的工作目录、包装程序；进程树（Unix 子孙进程随 kill/丢弃结束；Windows 父 → 子 → 孙三级与 Job 标志，只在 Windows 编译运行） |
| `cargo clippy -p piarc-exec --all-targets -- -D warnings` | lint |

`exec/run` 经 AHP 的集成测试在 `crates/piarc-core/tests/tool_io.rs`。

## CommandRunner

- 用 bash 运行（`bash -c <命令>`）：Unix 为 `/bin/bash`，否则 PATH 上的 `bash`；Windows 为 `%ProgramFiles%\Git\bin\bash.exe`、`%ProgramFiles(x86)%` 下的同名文件，否则 PATH 上的 `bash.exe`。与 Pi 原生 bash 工具一致；Git Bash 缺失的探测与提示是 T17 的。
- 环境由调用方给全（`SpawnSpec.env`，不继承）；stdin 立即关闭。
- stdout、stderr 每次读取（最多 64 KiB）作为一个 `OutputChunk` 发到有界通道；通道满时停止读取，命令的管道写满后被阻塞。通道关闭或令牌取消时终止命令。
- shell 退出后继续读，直到两个管道都关闭或安静 `EXIT_GRACE`（100 ms）：后台进程可能一直占着管道，命令最后的输出又不能丢（Pi 的 `waitForChildProcess` 同样的规则）。

## ProcessTreeSpawner（`tree.rs` 模块文档为准）

- Unix：`process_group(0)`，`kill` 与丢弃句柄都 `killpg(SIGKILL)`（nix，不写 `unsafe`）；组为空时的 `ESRCH` 当作成功。主动 `setsid`/`setpgid` 的后代不受影响。
- Windows：`CREATE_SUSPENDED` 创建 → 放进 `KILL_ON_JOB_CLOSE`、无 breakaway 标志的 Job → 用 Toolhelp 找到主线程并恢复。`kill` = `TerminateJobObject`（退出码 1），丢弃 = 关闭 Job 句柄。`job.rs` 是本 crate 唯一的 `unsafe`（编码规范 2.8）。
- 丢弃句柄在命令结束后也会结束整棵树：命令留在后台的进程随之结束（与 Windows 关闭 Job 一致）。
- 注入方式：`piarc-core` 构造后交给使用方（沙箱命令已用；T12 启动 Agent Host、T17 的通用命令执行改用它，`PLAN.md` 登记事项）。
- `CommandSpec::launcher` 以包装程序启动 shell（`program args… <shell> -c <命令>`），沙箱的 `sandbox-exec` 经它进入。

## `exec/run` 的通知格式（由 `piarc-core::tool_io` 发出）

`exec/output` `{ requestId, stream, seq, data }`：`seq` 跨 stdout、stderr 从 1 递增；`data` 按流解 UTF-8，被切断的序列留到下一块，命令结束时剩下的字节变为 U+FFFD；全部写在 `exec/run` 的响应之前。响应 `{ exitCode?, signal?, killed }`。

## T17 要叠加的

- 把 `ProcessTreeSpawner` 用于全部命令（I17；现在只有沙箱会话用它）。
- 超时（现在由 Agent Host 的 Bash 工具经 `exec/kill` 实现）、转后台、输出落盘、`cd` 保留、语义退出码；PowerShell 工具与 Git Bash 探测。

## 易错点

- `ProcessControl::wait` 与 `kill` 都借用 `&mut self`：等待与取消要分两步写（`watch` 函数），不能在同一个 `select!` 分支里既等又杀。
- 测试里的命令用 `exec sleep`，让 shell 被替换，终止直接子进程即可结束管道；不用 `exec` 时后台进程会占住管道直到 `EXIT_GRACE`。Windows 的 Git Bash（MSYS）没有真正的 `exec`：`sleep.exe` 仍是 bash.exe 的子进程，`TokioProcessSpawner` 取消时只杀 bash，`sleep` 活到自己结束（W0 实测，`cancelling_kills_the_command` 因此在 Windows 上要 30 s 才结束测试进程；I33，T17 改用 `ProcessTreeSpawner`）。
- Git Bash 在繁忙的 Windows 机器上启动可能超过几百毫秒：测试不要按固定延迟假设命令已经开始输出，等第一段输出再动作。
- Windows 代码在 macOS 上只能做类型检查与 lint（`cargo clippy --target x86_64-pc-windows-msvc -p piarc-exec --all-targets -- -D warnings`，需先 `rustup target add x86_64-pc-windows-msvc`）；Job Object 的测试只在 Windows CI 运行。
