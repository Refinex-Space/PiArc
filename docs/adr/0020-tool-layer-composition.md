# 0020. 工具层的组成：Pi 的工具代码加 Core 的 I/O（补充）

- 状态：已接受（补充 ADR-0004 第 3 条，T07）
- 日期：2026-11-15
- 取代：无
- 相关：架构文档第 6.1.1–6.1.3、7.4 节；ADR-0004、ADR-0009 第 8 条；`docs/spikes/S04-operations-delegation.md`

## 背景

ADR-0004 第 3 条决定："Harness Kit 用 Pi 的 `create*Tool(..., { operations })` 重建内置工具，把文件读写和命令执行委托给 Core"。它的前提是 Pi 的内置工具都通过可替换的 `*Operations` 执行 I/O。T07 逐个读了 Pi 1.5.2 的工具实现（S4 第 2 节），这个前提只对一部分工具成立：

- bash、find（给了自定义 `glob`）、ls：全部 I/O 都经 Operations。
- read：读文件经 Operations，但 `resolveReadPathAsync` 先在本进程用 `fs.access` 探测路径与 macOS 拼写变体。
- write、edit：`withFileMutationQueue` 在本进程对目标路径调用 `realpath`。
- grep：自 1.5.1 起总是直接运行 ripgrep，`GrepOperations` 只剩目录判断。

这些本地访问会让 Agent Host 绕过 Core 碰到工作区，T07-A02 要求它们为 0；Agent Host 将来在 Seatbelt 下运行时，这类访问还可能直接失败。T07 的任务约定允许在 Operations 不足时改用 PiArc 注册的同名工具。

## 决策

1. **bash 与 find**：用 Pi 的工厂函数加 `BashOperations`、`FindOperations`，分别委托 `exec/run`（含 `exec/output`、`exec/kill`）与 `fs/stat`、`fs/glob`。暴露为 `Bash`、`Glob`。
2. **read、write、edit**：仍运行 Pi 的工具定义（保留行选择、截断提示、图片处理、模糊匹配、换行符保持、diff），但传给它的 `path` 是一个从不创建的**替身路径**（系统临时目录下 `piarc-stand-in/<uuid>/<文件名>`）。Pi 的本地探测落在替身上；Pi 对替身调用的每个 Operation 由 Core 对真实路径执行；结果与错误中出现的替身换回模型写的路径。真实路径按 Pi 的规则解析（移植 `utils/paths.ts`），Read 的拼写变体由 Core 的 `fs/stat` 逐个确认。暴露为 `Read`、`Write`、`Edit`。
3. **grep**：PiArc 自写同名工具 `Grep`，沿用 Pi 的参数 schema 与输出格式（移植 `grep.ts` 的格式化，MIT），搜索由 Core 用 `ignore`、`grep-searcher` 实现，并采用 Pi 的匹配上限规则。
4. **同一文件的写入串行**：Pi 的 `withFileMutationQueue` 按替身排队，不再起作用；Write 与 Edit 改用 PiArc 自己的队列，键为词法绝对路径（Windows 不区分大小写）。架构第 6.1.2 节"并发"一行的规则不变，实现方式随之更新。
5. **Pi 原生工具**：会话以 `noTools: "builtin"` 加 `excludeTools` 排除 read、bash、powershell、edit、write、grep、find、ls，扩展无法再激活它们。
6. **内容传输**（ADR-0009 第 8 条的落实）：文本以 ≤ 1 MiB 的范围内联传输，不算第 8 条的大块数据；图片等二进制内容由 Core 复制为会话 blob（`<数据目录>/sessions/<会话 id>/blobs/<sha256>`），AHP 只传路径、哈希与大小，Agent Host 读取该文件。这是 Agent Host 经自己的 `fs` 读取的唯一文件，限定在数据目录的 `sessions/` 下。
7. **防回退**：`agent-host/src/tools/` 与 `agent-host/src/harness/` 禁止导入 `fs`、`child_process`（ESLint）；端到端测试用 `NODE_OPTIONS` 预加载的 I/O spy 断言场景期间 Agent Host 对工作区路径零 `fs` 调用、零 `child_process` 调用；行为对照测试比较委托工具与 Pi 原生工具的结果。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| read、write、edit 直接用 Pi 工厂加 Operations | 代码最少，完全按 ADR-0004 原文 | 每次调用在本进程对工作区路径做 1–5 次 `access`/`realpath`，违反"I/O 全部经 Core"，沙箱下可能失败 | 否决 |
| 完整移植 read（约 300 行）与 edit 的匹配和 diff（约 500 行） | 不依赖 Pi 的内部探测方式 | 大量复制，升级 Pi 时要手工同步，丢掉上游修复 | 否决 |
| 在进程级替换 `fs` 函数，把工具执行期间的探测转给 Core | 不改工具代码 | 修改 Node 内置模块，影响整个进程，难以推理与测试 | 否决 |
| grep 用 Pi 工厂，只替换 `isDirectory` | 少写一个工具 | ripgrep 在本进程运行，搜索绕过 Core | 否决（任务约定的退路） |

## 后果

- 正面：六个规范名工具的 I/O 全部在 Core，权限、快照、沙箱与审计（T16、T20、T28、T39）可以挂在 `fs/*`、`exec/*` 上；read、write、edit、bash、find 的行为随 Pi 升级自动跟上；对照测试在 17 个场景上与 Pi 原生一致（1 项有意差异）。
- 负面与代价：替身路径依赖"Pi 的本地探测只用传入的路径字符串"这一实现事实；每次 Read、Write、Edit 在系统临时目录下多几次失败的探测；第三方扩展若用 Pi 的队列写同一文件，不与 Write、Edit 串行（T16 的文件状态表覆盖）；Grep 的格式化逻辑需要随 Pi 手工同步。
- 需要配套做的事：升级 Pi 时先跑 `crates/piarc-testkit/tests/agent_host/` 的 spy 与对照测试；T16 把先读后改、保真写入、diff 移到 Core 时，复核替身路径是否仍需要。

## 重新评估的触发条件

- Pi 的 read、write、edit 增加 Operations 之外、且不按传入路径进行的本地访问（spy 测试失败）；
- Pi 让 grep 的搜索可经 Operations 委托，或去掉路径探测（可以回到纯 Operations 委托）；
- T16 把编辑逻辑整体移到 Core，Pi 的 edit 代码不再使用。
