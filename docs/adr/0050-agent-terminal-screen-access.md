# 0050. agent 使用终端屏幕的接口（补充）

- 状态：已接受，补充 ADR-0017 第 2 条、ADR-0049
- 日期：2026-11-20
- 相关：架构第 6.11、7.3、9.1 节；T33；FR-TL-05；登记事项 I28

## 背景

ADR-0017 第 2 条定了 agent 读屏的来源：Core 里的 libghostty-vt，用 formatter 输出纯文本，用 OSC 133 判断命令边界与退出码，与用户看到的是同一个终端实例。第 6.11 节又规定终端内容不自动进入模型上下文。T33 的 `piarc-term` 已经提供读屏、命令边界与等待、搜索；还要回答几件基线没写到的事：

- agent 怎样得到一个终端，模型怎样选用它。Claude Code 没有终端的概念，它的后台命令输出写文件、模型用 Read 读（`TaskOutput` 已在 2.1.277 移除）。
- 模型读到什么、何时读到；读屏结果与 formatter 的一致性怎样保证。
- 用户自己的终端怎样才让 agent 看见，看见之后怎样收回。
- 终端由谁管理生命周期、怎样与 T32 的后台任务统一。

## 决策

1. **终端承载的任务。** T32 的任务管理器增加任务类型 `terminal`，不另建注册表：每个属于会话的终端都登记为一个任务（所属会话、工作区、标题、cwd、状态），没有会话的终端（原型页、测试）不登记。任务记录终端的来源：`agent`（模型启动）或 `user`（用户在面板中打开），以及是否共享给 agent。状态沿用 T32：shell 退出为 `completed`/`failed`，KillShell 与关闭终端为 `killed`，应用退出为 `interrupted`。
2. **模型怎样启动终端任务。** `Bash` 增加可选参数 `terminal`（布尔，PiArc 自有）：为真时命令在一个终端里后台运行，隐含 `run_in_background`。权限与 `run_in_background` 的 Bash 完全相同（规则、Bash 分析、`Bash` matcher 的 hooks、审批卡），审批卡注明"在终端中运行"。Core 以交互式 bash（Windows 为 Git Bash）加 PiArc 的 shell integration 打开终端：工作目录是会话的 shell 目录，环境来自 T17 的构造（ADR-0035，不含凭据），沙箱会话加同样的沙箱包装；等第一个提示符出现后把命令作为输入写入。命令结束后 shell 保留，用户可以在面板里接着用；任务在 shell 退出、KillShell、用户关闭、会话归档或删除、应用退出时结束。
3. **模型读什么。** 任务的输出路径指向 Core 维护的"屏幕文件"（`tasks/<任务 id>.log`），模型照常用 Read 读取，与 Claude Code 读后台输出的习惯一致。文件第一行说明终端与最近一条命令（命令行、是否结束、退出码），其后是 formatter 输出的屏幕与 scrollback 纯文本（折行还原、去掉行尾空格；alternate screen 上是当前屏幕）。它不是原始字节流：TUI 的重绘、颜色与光标移动都已由 libghostty-vt 解析。Core 在输出变化后至多每 500 ms 重写一次，并在发出通知、`exec/background/read`、`readTaskOutput` 之前立即重写，所以模型在命令结束通知之后读到的就是那一刻 formatter 的输出。
4. **命令结束的通知。** 模型启动的命令按 OSC 133 结束时，Core 为发起会话挂起一条 `backgroundTask` 提醒（任务 id、命令行、退出码、屏幕文件路径、最后几行），送达规则与 T32 相同（挂起到送达、按来源去重）。之后用户在同一终端里运行的命令不再通知。
5. **用户终端的共享。** 用户打开的终端默认不给 agent：`exec/background/list` 不列出，`exec/background/read` 返回 `notFound`，没有屏幕文件（Read 读不到）。用户在界面上共享（Core API `setTerminalShared`，界面由 T34 做）后，Core 写出屏幕文件并为该会话挂起一条提醒，说明终端名称、任务 id 与屏幕文件路径（只给位置，不给内容）；取消共享删除屏幕文件并恢复不可见。每次读取都在 Core 侧核对共享状态。KillShell 不能停止用户的终端（同样返回 `notFound`）。
6. **不开放写入。** agent 不能向任何交互终端写入输入（等同执行命令，任务范围外）；模型启动的终端只在开头写入一次已获批准的命令。
7. **Monitor 不扩展到终端。** TUI 整屏重绘时"新增行"没有确定的含义；命令结束通知加按需 Read 已覆盖"等命令结束再看结果"的用法。
8. **协议。** 握手能力 `terminalTasks`。`exec/run` 增加 `terminal`（与 `background` 一起出现）；`TaskKind` 增加 `terminal`，`BackgroundTask` 增加 `terminal`（终端句柄、来源、是否共享）。终端事件（标题、工作目录、响铃、命令开始与结束、剪贴板、退出）的形状在 `piarc-protocol::terminal`，经 `term/<id>` 路由发给客户端。

## 与 L3 对齐的取舍

`Bash` 多出一个模型可见参数 `terminal`，在 `tests/l3-allowlist.yaml` 登记为 PiArc 自有的有意偏离。其余都沿用 Claude Code 的形态：后台运行、输出文件加 Read、KillShell、结束提醒。没有新增宿主工具：读屏、命令边界都由 Core 写进模型已经会读的文件。

## 备选方案

| 方案 | 结论 | 理由 |
|---|---|---|
| 新增宿主工具 `TerminalRead`（或恢复 `BashOutput`） | 否决 | 多一个工具名就多一套规则、hooks matcher 与 L3 偏离；Read 读文件已经是后台输出的通道 |
| 所有 `run_in_background` 命令都放进终端 | 否决 | 程序在 PTY 里会输出颜色与进度条、stdout 与 stderr 合流，T32 的输出文件与语义退出码随之改变 |
| 屏幕文件写原始字节流 | 否决 | 违反 ADR-0017 第 2 条：agent 读到的要与用户看到的同一屏幕一致，原始字节里的重绘对模型不可读 |
| Read 时由 Core 即时渲染（拦截 `fs/read`） | 否决 | 文件工具的不变量（读取记录、编码、diff）会被特殊路径打乱；定时重写加通知前重写已满足一致性 |
| 用户终端默认对 agent 可见 | 否决 | 第 6.11 节：终端内容不自动进入模型上下文 |
| Monitor 回灌终端新增行 | 否决 | 见第 7 条 |

## 后果

- 模型多一个 `Bash` 参数；工具描述与结果文案自写，跑原创性检查。
- 终端的进程树由 Core 统一结束（macOS 结束挂在该 PTY 上的全部进程，Windows 为 Job Object，I28），与 T32 的后台任务一样随会话归档、删除与应用退出结束。
- 共享开关的界面在 T34；T33 只提供 Core API 与校验。

## 重新评估的触发条件

- Claude Code 增加终端或读屏的工具（L3 出现新的工具差异）。
- 模型频繁用 Read 轮询屏幕文件造成上下文浪费（再评估 Monitor 回灌或增量读取）。
- libghostty-vt 的 formatter 输出改变（屏幕文件格式随之变化，L2 场景会报告）。
