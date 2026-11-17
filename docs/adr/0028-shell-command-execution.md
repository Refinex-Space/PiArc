# 0028. Shell 命令的执行：Core 管进程、输出与语义，Bash 与 PowerShell 为 PiArc 自写工具（补充）

- 状态：已接受（补充 ADR-0004 第 3 条；修订 ADR-0020 第 1 条中 bash 的部分，T17）
- 日期：2026-11-17
- 取代：无
- 相关：架构文档第 5.3、5.4、6.1.3、6.2.2、6.11、6.15、15.2 节；ADR-0004、ADR-0020、ADR-0027

## 背景

架构第 6.11 节规定 Bash 的行为：每条命令独立进程，`cd` 在工作区内跨命令保留、越界重置并提示，默认超时 2 分钟、上限 10 分钟，成功输出内联约 30,000 字符、超出落盘并给约 2,000 字符预览，失败输出给出头尾；第 5.3 节要求按语义判断成败（`grep` 无匹配退出码为 1 仍算成功）。T07 的最小实现（ADR-0020 第 1 条）用 Pi 的 bash 工厂加 `BashOperations`，Core 只负责启动与流式输出。

Pi 1.5.2 的 bash 工具与这些要求有三处不可调和：

- 输出由工具自己累积和截断：保留最后 2,000 行或 50 KB，全文由 Agent Host 写到系统临时目录。30,000 字符内联（短行很多时超过 2,000 行）、失败时的头尾、写到会话临时目录都做不到；`BashOperations` 只能决定交给它的字节。
- 退出码非 0 一律 `isError`，并写 "Command exited with code N"。语义成功只能靠在 Operations 里谎报退出码 0，模型就看不到真实退出码。
- 超时没有默认值，由 Agent Host 的计时器发 `exec/kill`；进程树只有 Core 能终止。

## 决策

1. **Core 执行命令的全部行为**（`piarc-exec` 实现，`piarc-core::tool_io::exec` 装配，`exec/run` 返回结构化结果）：
   - 进程：每条命令一个进程，统一用 `ProcessTreeSpawner`（Unix 新进程组、Windows `KILL_ON_JOB_CLOSE` 的 Job）。停止分两步：向进程组发 `SIGTERM`，宽限（默认 2 秒）后 `SIGKILL`；Windows 直接终止 Job。超时、`exec/kill`、回合中断（`cancel_running`）、连接断开、会话关闭都走这条路径；shell 退出后丢弃句柄，命令留在后台的进程随之结束；Core 关闭时运行时丢弃任务也结束整棵树。
   - 超时：请求的 `timeoutMs` 不超过上限（10 分钟，超出按上限执行，结果的 `timeout.requestedMs` 说明），未给时取默认（2 分钟）。T32 之前超时即终止。
   - 工作目录：未给 `cwd` 的命令在会话的"shell 目录"中执行；bash 命令经 `BASH_ENV` 指向的初始化文件装一个 `EXIT` trap，把 `pwd -P` 写到会话临时目录，命令文本、退出码与错误信息不变，`BASH_ENV` 在命令开始前已撤掉（用户自己的 `BASH_ENV` 照样执行并恢复）。最终目录在工作区根或已添加目录内则记住，否则下一条命令回到工作区根，结果的 `cwdReset` 说明；记住的目录被删除时同样回到根。Git Bash 的 `/c/…` 路径先转换为 Windows 路径再判断。显式 `cwd` 不改变 shell 目录；PowerShell 命令在 shell 目录中执行，但不改变它。
   - 输出：stdout 与 stderr 持续读取（不因下游慢而停读管道以外的任何东西），按到达顺序合并并分别按 UTF-8 解码。前 30,000 字符留在内存，超出后全文流式写入 `<会话临时目录>/tool-results/<工具调用 id>.txt`（`piarc_fs::create_spill`，与 ADR-0027 的结果落盘同目录、同命名）；结果给出成功时约 2,000 字符（首尾各半）、失败时首 10,000 与尾 20,000 字符，加省略字符数与文件路径。阈值集中在 `piarc_exec::ExecLimits`，Core 配置可改。
   - 实时输出：`exec/output` 只用于显示。待发数据超过 256 KiB 时丢弃最旧的块并在下一条通知的 `skipped` 中报告字节数，命令与结果不受连接快慢影响。
   - 语义：只有一个简单命令（无管道、控制运算符、子 shell、命令替换）时套用判定表（`grep`/`egrep`/`fgrep`/`rg` 的 1 为无匹配，`diff`/`cmp` 的 1 为有差异，`test`/`[` 的 1 为条件为假），其余只看退出码；PowerShell 只看退出码。结果的 `outcome` 与 `meaning` 给出判断。T23 用 tree-sitter-bash 细化。
   - 环境：以用户登录 shell 的环境为基础（`$SHELL -i -l -c` 打印 `env -0`，10 秒超时，失败时退回 Core 自己的环境并记警告；每个 Core 解析一次）；剔除 `ELECTRON_*`、`PIARC_*`、`PI_*`、Node 的内部变量与登录 shell 的自身状态（清单在 `piarc_exec::env`）；不加入任何凭据。Windows 以进程环境为基础，Git Bash 没有 locale 设置时加 `LANG=C.UTF-8`，PowerShell 先把控制台输出设为 UTF-8。
2. **shell 的选择在 Core**：Unix 用 `/bin/bash`；Windows 依次查用户设置 `shell.gitBashPath`（只读用户级 `settings.json`，项目不能指定可执行文件）、常见安装位置、`PATH` 上 `git.exe` 所在的安装，不用 `PATH` 上其他的 `bash.exe`（`System32\bash.exe` 是 WSL）。PowerShell 优先 `pwsh`，没有时用 Windows PowerShell 5.1（沿用 Pi 的 UTF-8 前缀与 5.1 退出码后缀，MIT）。新方法 `exec/shells` 回答这台机器有哪些 shell（无参数、不依赖会话：Agent Host 在创建会话、Core 还没登记它时就要问；Agent Host 问不到时按平台默认值处理并记日志）；Windows 找不到 Git Bash 时，Core 在 `core/notices` 发一次 `gitBashMissing` 通知（附查找过的位置与 Git for Windows 下载地址）。
3. **Bash 与 PowerShell 是 PiArc 自写的工具**（`agent-host/src/tools/shell.ts`），修订 ADR-0020 第 1 条中 bash 的部分（find 仍用 Pi 工厂）：参数沿用 Pi 的 `command` 与 `timeout`（秒）；与 Pi 含义相同的状态用 Pi 的措辞（"Command exited with code N"、"Command timed out after N seconds"、"Command aborted"），对照测试的 Bash 步骤保持一致；结果的 `isError` 按 Core 的 `outcome`；`details.commandExecution` 带 bash 卡的结构化字段（cwd、退出码或信号、语义状态与含义、耗时、是否超时、超时值、是否截断、全文路径、cwd 重置），投影器放到 `commandExecution` 条目的 `execution`。会话按 `exec/shells` 决定工具集：有 bash 才有 `Bash`，只有 Windows 有 `PowerShell`。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 继续用 Pi 的 bash 工厂，在 `BashOperations` 里改写交给它的输出与退出码 | 保留 ADR-0020 的形态，随 Pi 升级 | 30,000 字符与头尾做不到（Pi 按 2,000 行截断）；语义成功要谎报退出码；全文仍由 Agent Host 写到系统临时目录 | 否决 |
| 截断与语义放在 Agent Host，Core 只做进程 | Core 改动小 | 100 MB 输出要经 AHP 全量传给 Agent Host 再丢弃；落盘要再经 `fs/spill` 写一遍；进程边界之外的工具层管不了资源 | 否决 |
| 取最终目录：在命令文本后追加 `pwd` 或用 `eval` 包装 | 实现简单 | 改变错误信息中的行号与文本（语法错误时 bash 会回显带包装的整行），`exit` 时追加部分不执行 | 否决，用 `BASH_ENV` 加 `EXIT` trap |
| 实时输出背压到命令（通知发不出去就停读管道） | 不丢显示内容 | 连接慢时命令被拖慢甚至卡住，正是 claw-code 的反面教训 | 否决，显示窗口丢旧数据并计数 |

## 后果

- 正面：架构第 6.11 节的 Bash 行为全部落地，并在 Windows 上有同样的工具语义；输出、超时与进程只在 Core 一处处理，T32 的转后台、T39 的沙箱、T23 的命令分析都接在 `exec/run` 上；`commandExecution` 条目可直接驱动 bash 卡（T19）。
- 负面与代价：Bash 的结果格式不再随 Pi 升级自动跟上，与 Grep 一样需要手工同步；命令自己装 `EXIT` trap 或以 `exec` 结束时，下一条命令留在原目录；`exec/run` 未给 `timeoutMs` 时的默认从"不限"变为 2 分钟；登录 shell 会执行用户的配置文件（有超时，失败退回）。
- 需要配套做的事：W1 在 Windows 实机核对 Git Bash 的路径转换、PowerShell 与 Git Bash 的中文输出、Git Bash 缺失时的通知；T19 用 `execution` 画 bash 卡并显示 `core/notices`；T32 把超时改为转后台时更新 `exec-timeout-kills-tree` 场景。

## 重新评估的触发条件

- Pi 的 bash 工具开放输出截断与退出码判定的可配置项（可考虑回到 Pi 的工厂）；
- T23 的 tree-sitter-bash 分析可用（语义判定改用语法树）；
- 用户反馈登录 shell 解析造成启动问题（改为在设置中关闭或指定环境）。
