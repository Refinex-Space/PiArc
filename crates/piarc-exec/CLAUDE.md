# piarc-exec

进程管理：`ProcessSpawner` 的 tokio 实现（T06），以及 AHP `exec/run` 背后的 `CommandRunner`（T07）。`piarc-core` 注入启动器；本 crate 不决定命令能否运行（`piarc-policy`），不生成沙箱配置（`piarc-sandbox`），不管 PTY（`piarc-term`）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-exec` | 启动器与命令执行：输出、退出码、流式、取消、缺失的工作目录 |
| `cargo clippy -p piarc-exec --all-targets -- -D warnings` | lint |

`exec/run` 经 AHP 的集成测试在 `crates/piarc-core/tests/tool_io.rs`。

## CommandRunner

- 用 bash 运行（`bash -c <命令>`）：Unix 为 `/bin/bash`，否则 PATH 上的 `bash`；Windows 为 `%ProgramFiles%\Git\bin\bash.exe`、`%ProgramFiles(x86)%` 下的同名文件，否则 PATH 上的 `bash.exe`。与 Pi 原生 bash 工具一致；Git Bash 缺失的探测与提示是 T17 的。
- 环境由调用方给全（`SpawnSpec.env`，不继承）；stdin 立即关闭。
- stdout、stderr 每次读取（最多 64 KiB）作为一个 `OutputChunk` 发到有界通道；通道满时停止读取，命令的管道写满后被阻塞。通道关闭或令牌取消时终止命令。
- shell 退出后继续读，直到两个管道都关闭或安静 `EXIT_GRACE`（100 ms）：后台进程可能一直占着管道，命令最后的输出又不能丢（Pi 的 `waitForChildProcess` 同样的规则）。

## `exec/run` 的通知格式（由 `piarc-core::tool_io` 发出）

`exec/output` `{ requestId, stream, seq, data }`：`seq` 跨 stdout、stderr 从 1 递增；`data` 按流解 UTF-8，被切断的序列留到下一块，命令结束时剩下的字节变为 U+FFFD；全部写在 `exec/run` 的响应之前。响应 `{ exitCode?, signal?, killed }`。

## T17 要叠加的

- 进程组（macOS）与 Job Object（Windows）终止整棵进程树（I17）；现在只终止直接子进程。
- 超时（现在由 Agent Host 的 Bash 工具经 `exec/kill` 实现）、转后台、输出落盘、`cd` 保留、语义退出码；PowerShell 工具与 Git Bash 探测。

## 易错点

- `ProcessControl::wait` 与 `kill` 都借用 `&mut self`：等待与取消要分两步写（`watch` 函数），不能在同一个 `select!` 分支里既等又杀。
- 测试里的命令用 `exec sleep`，让 shell 被替换，终止直接子进程即可结束管道；不用 `exec` 时后台进程会占住管道直到 `EXIT_GRACE`。
