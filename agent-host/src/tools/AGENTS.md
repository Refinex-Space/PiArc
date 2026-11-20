# agent-host · tools

规范名工具（Read、Write、Edit、Bash、PowerShell、Glob、Grep）：Profile、替身路径与 `CoreIo` 委托（ADR-0020）。命令、进程边界与全局不变量见上级 [`agent-host/AGENTS.md`](../../AGENTS.md)。

## 工具层的易错点

- Pi 1.5.2 的 read 在 Operations 之外 `access` 路径、write 与 edit 对路径 `realpath`、grep 自己跑 ripgrep（S4 第 2 节）。升级 Pi 后先跑端到端测试：I/O spy（场景期间对工作区路径零 `fs`、零 `child_process`）与行为对照会发现新的绕过与行为变化。
- Pi 的 `withFileMutationQueue` 按替身排队，不起串行作用；Write、Edit 用 `stand-in.ts` 的 `serialized`。
- 工具 I/O 与会话通知走同一个 stdout：Core 停止读取（事件消费者停住）时工具也等着，这是背压，不是死锁（I19）。
- Windows 上 Node 写管道式 stdout 是同步的（`net.Socket` 对 fd 1、2 的管道 `setBlocking(true)`）：管道满时写入本身阻塞，整个事件循环停住，`OutboundQueue` 几乎不排队，也不会出现 `drain` 等待；Core 恢复读取后一切照常（S9 报告第 5 节）。
- 文本超过 256 Ki 个 UTF-16 码元时以一次上传分段发送（`fs/write`、`fs/spill` 的 `upload`，最后一段到达 Core 才写），不能在代理对中间切；不要再用 `append` 分段（第一段就会截断原文件）。读取按 Core 返回的 `bytesRead` 续读。
- Read 的行号是 Pi 选行之前对文本流的变换（`numberedChunks`），所以 Pi 的截断字节数包含前缀；改行号格式要同步 Profile 的描述、`parity.rs` 的 `comparable` 与 L2 断言。Edit 的 `oldText` 不含行号前缀，Profile 的描述写明了这一点。
- Read 用 `fs/stat(read)` 查询重复并暂存快照，内容送达且文档解析成功后，同一调用以相同范围发送 `completeRead: true` 确认。取消、失败或文件变化不会放行 Edit（ADR-0034）。
- Edit 与 Write 把 Core 返回的 diff 放进结果的 `details.fileDiff`，投影器从这里取（`items.ts` 的 `resultDiff`）；改结果形状时两边一起改。
- 参数 schema 在 Pi 的之上扩展（Read 的 `pages`、Edit 的 `replaceAll`）用 `typebox`（与 Pi 同版本 1.3.27 的直接依赖）。
- Bash 不读 Pi 设置的 `shellPath`、`shellCommandPrefix`（Windows 的 Git Bash 路径是 PiArc 设置 `shell.gitBashPath`），Read 按会话 `SettingsManager.getImageAutoResize()` 读取 `images.autoResize`（I21）；命令环境是 Core 的登录 shell 环境去掉内部变量，Agent Host 不再传 Pi 的 `PI_*` 会话变量。
- Bash 的结果文本在与 Pi 含义相同处用 Pi 的措辞（"Command exited with code N" 等，`parity.rs` 的 Bash 步骤与 L2 断言依赖）；输出保留原样的末尾换行。改措辞时同步对照测试与 `tests/scenarios/exec-*.yaml`。
- 命令的 `details.commandExecution` 由 `shell.ts` 写、`items.ts` 的 `resultExecution` 校验后放进条目的 `execution`（实时与历史都经它）；改形状时两边与协议类型一起改。

相关基线见架构第 5、7 章、ADR-0002、0009、0010、0015、0020、Pi 调研的 v1.5.2 差异，以及 S03、S04、S09 报告。
