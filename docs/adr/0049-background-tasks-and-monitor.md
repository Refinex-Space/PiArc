# 0049. 后台任务、Monitor 与 KillShell 的落地（补充）

- 状态：已接受，补充 ADR-0009、ADR-0028、ADR-0037、ADR-0039、ADR-0043、ADR-0048
- 日期：2026-11-20
- 相关：架构第 6.1.4、6.6.3、6.11、7.3、7.4、9.1–9.3、8.2 节；T32；登记事项 I03、I131

## 背景

架构第 6.11 节定了后台任务的形态：`run_in_background` 启动，输出写文件、模型用 Read 查看，`KillShell` 停止，完成以通知注入下一回合，前台命令超时转后台，Monitor 把新增输出逐行回灌；Core 的任务管理器统一管理后台命令、后台子 agent 与 Monitor（第 7.3 节：状态归 Core）。T17 之前的临时行为是超时即终止，T27 预留了 `session/remind`，T31 的后台子 agent 自己经提醒回报。实现时要回答几件基线没写到的事：

- 转后台时进程怎样不重启、输出怎样不丢；Agent Host 崩溃重启时后台命令怎样继续、通知怎样不丢也不重复。
- Monitor 的输出何时进入上下文：回合进行中与会话空闲时各怎么做，怎样限速，怎样不改写历史。
- Monitor 的命令怎样受 Bash 规则、Bash 分析与 `Bash` matcher 的 hooks 约束。
- 后台任务与会话关闭、归档、中断、应用退出的关系；时间相关的逻辑怎样在测试里不靠真实等待。

## 决策

1. **任务管理器在 `piarc-core::tasks`。** `TaskManager` 一个 Core 一份，登记三种任务（`kind`：`command`、`subagent`、`monitor`，T33 加终端类型；表不加 CHECK 约束）。任务有 id（`bg-` 加 12 位十六进制）、发起会话、所属主会话（子 agent 发起的任务归它的主会话）、工作区、标题、命令或 agent 类型、cwd、开始与结束时间、状态（`running` → `completed` / `failed` / `killed` / `interrupted`，结束后不再变）、退出码与信号、语义结果、输出文件与字节数、最新几行。元数据写 `background_tasks`（schema v7 重建该表，原表从未使用）；变化经实体快照 `core/tasks`（`{ revision, tasks }`，按会话所在工作区列出最近的任务）推给客户端，输出带来的变化至多每 `TaskLimits::snapshot_interval` 发一次。
2. **进程在 Core，输出在会话目录。** 命令仍由 `piarc-exec` 的 `CommandRunner` 与 `ProcessTreeSpawner` 运行（macOS 进程组，Windows 每个任务一个 Job Object）。`exec/run` 不再把超时交给 `CommandRunner`：Core 按任务时钟等待，超时后把同一个运行中的命令登记为任务，`OutputCapture` 已收的输出（内存里的或已落盘的全文）交给 `piarc_exec::TaskLog`，之后的输出追加进 `<数据目录>/sessions/<主会话 id>/tasks/<任务 id>.log`，命令的取消令牌从回合与连接上摘下，`exec/run` 以 `task`（`reason: timeout`）作答。`background: true` 的 `exec/run` 一开始就这样做（`reason: requested`）。管道始终被持续读取；`TaskLog` 按原始字节写文件、记字节数、保留尾部若干行。会话（含子会话）的 scope 把主会话的 `tasks/` 登记为只读目录，Read 不经审批即可读取。
3. **结束与终止。** 任务结束的条件：命令退出、`KillShell` 或面板停止（同一个 `TaskManager::stop`：先 `SIGTERM` 整个进程组、宽限后 `SIGKILL`；Windows 终止 Job）、Monitor 超时、会话归档或删除（先停止该会话的任务，再按第 9.3 节清理 `tasks/`）、应用退出。后台命令不随回合中断、会话关闭（窗口里的"关闭会话"）、Agent Host 崩溃或空闲回收结束；Monitor 随会话关闭结束。Core 有序关闭时停止全部运行中的任务并记为 `interrupted`；启动时把数据库里仍是 `running` 的行改为 `interrupted`（上次异常退出），不自动重跑。
4. **KillShell 只停本会话的任务。** AHP `exec/background/kill` 只接受发起会话是请求会话、或所属主会话是请求会话的任务（主会话能停自己子 agent 的任务）；其他会话的任务 id 与不存在的 id 同样返回 `notFound`，不透露它的存在。结果附任务快照与尾部预览，输出文件保留。KillShell 默认不需要审批（第 6.1.4 节）。子 agent 任务的停止经 `subagent/stop` 交给 Agent Host。
5. **完成通知经 Core，按键去重。** 命令与 Monitor 结束时，Core 为发起会话生成一条 `backgroundTask` 提醒（任务 id、命令、退出码、语义状态、耗时、输出路径、尾部预览），在 Core 里挂起，直到看见它送达：会话 actor 在 `reminder` 条目里看到同一来源即标记送达。挂起的提醒在任务结束时、会话打开或恢复时（含 Agent Host 重启后）、以及会话的每个 prompt、steer、follow-up 发给 Agent Host 之前经 `session/remind` 发出（所以"下一回合"一定带上它）。`session/remind` 新增 `key`：Agent Host 按键替换排队中的提醒，分支里已有同键的已送达提醒时不再排队并回答 `delivered: true`，Core 由此重发而不重复。后台子 agent 的报告由 Agent Host 持有，仍按 ADR-0048 第 8 条在同一提醒通道直接排队；Core 只登记、停止与展示它（`subagent/start` 带 `background` 时登记，`subagent/finish` 或连接结束时更新）。
6. **Monitor 的回灌。** AHP `exec/monitor` 在授权之后启动命令（与 `exec/run` 同样消费同一调用的授权，ADR-0031），默认超时 5 分钟、上限 30 分钟（`TaskLimits`）。新增的完整行进入任务的有界缓冲（Agent Host 重启期间也在 Core 里累积），以提醒类型 `monitorOutput`、键 `monitor:<任务 id>` 送给发起会话：回合进行中，有新行且没有在途的发送就立即发送（替换排队中的上一批，Pi 在下一次模型请求前追加），会话空闲时以 `wake: true` 发送，Agent Host 用 Pi 的 `sendCustomMessage(…, { triggerTurn: true })` 开一个回合，提醒消息本身就是回合的输入，转录显示为 Monitor 事件。限速：单次至多 `monitor_batch_lines` 行、`monitor_batch_chars` 字符，超出的写成"省略 N 行，完整输出见 <路径>"；一个 Monitor 送达的总字符达到 `monitor_total_chars` 后停止回灌并告知模型（命令照常运行到结束条件）；两次唤醒至少相隔 `monitor_wake_interval`；设置 `monitor.wakeIdleSession: false` 时不唤醒，空闲期间的新行留到下一回合。只追加消息，不改写已发送的内容，tool_use / tool_result 配对与缓存断点不受影响。
7. **Monitor 的权限与 hooks。** 规则匹配、Bash 分析（拆分、包装剥离、关键路径、越界、解析失败询问）与 Bash 相同：`Bash(npm run *)` 同时匹配 Monitor，`Monitor` 规则也可以写。差别是只读白名单与 Accept edits 的命令不让 Monitor 免审批：Manual 模式下只有 allow 规则覆盖了整条命令中非只读的部分才放行，全部只读的命令仍询问。PreToolUse 与 PermissionRequest hooks 的 matcher 对 Monitor 调用依次按 `Monitor` 与 `Bash` 选取（同一 handler 只运行一次），`tool_name` 仍是 `Monitor`。
8. **时钟与限值集中定义。** `TaskLimits`（Monitor 的超时与限速、唤醒间隔、快照节流、通知预览、读取分段）与任务时钟在 `CoreConfig.tasks`；前台超时仍取 `ExecLimits`。测试与 L2 注入 `ManualClock`，L2 动作 `advance_clock` 推进它，场景不靠真实等待。
9. **能力与协议。** 握手能力 `backgroundTasks`。Agent Host → Core：`exec/run` 的 `background` 与结果的 `task`，`exec/monitor`，`exec/background/list`（本会话与其子 agent 的任务）、`exec/background/read`（按字节偏移分段，结果是 UTF-8 文本、下一偏移与总字节数，至多 `read_chunk` 字节，在字符边界截断）、`exec/background/kill`。Core → Agent Host：`session/remind` 的 `key`、`wake` 与结果的 `delivered`、`turnId`，接受 `monitorOutput`。Core API：`core/tasks` 快照、`readTaskOutput`、`stopTask`（与 KillShell 同一入口，不受会话限制）。
10. **工具。** `Bash` 增加 `run_in_background`（布尔，参数风格对齐 Claude Code）；`KillShell` 的参数是 `shell_id`；`Monitor` 的参数是 `command`、`description` 与可选的 `timeout`（秒，与 PiArc 的 Bash 一致）。描述与结果文案自写，跑原创性检查。

## 备选方案

| 方案 | 结论 | 理由 |
|---|---|---|
| 后台任务挂在 `SessionIo.running` 上，随会话登记 | 否决 | 会话关闭或 Agent Host 重启会丢掉进程句柄；回合中断会结束后台命令 |
| 超时时重新启动命令作为后台任务 | 否决 | 违反"同一进程继续运行"；有副作用的命令会执行两次 |
| 通知只发一次 `session/remind`，由 Agent Host 内存排队 | 否决 | Agent Host 在送达前崩溃时通知丢失；会话空闲时排队可能长期不送达 |
| Monitor 的每批行由 Agent Host 计数限速 | 否决 | Agent Host 重启时缓冲丢失，唤醒节奏要可注入时钟测试，放在 Core 一处 |
| Monitor 的唤醒消息用 `session/prompt` 的用户消息 | 否决 | 会伪造用户输入，hooks 的 UserPromptSubmit 也会运行；带标记的提醒消息语义准确 |
| 后台子 agent 的通知也改由 Core 发出 | 否决 | 报告文本在 Agent Host，已由 ADR-0048 第 8 条的路径可靠送达；Core 登记已足以统一面板与停止 |

## 后果

- 前台命令不再因超时被杀，T17 的超时场景与 `exec_commands` 的超时用例按新行为改写；进程树终止的覆盖由 KillShell、回合中断与应用退出的测试承担。T17 中描述"超时即终止"的验收项需要用户按新行为修改描述（登记事项）。
- 空闲唤醒会自动产生模型请求（I03）：默认开启、唤醒间隔 30 秒，R4 请用户确认默认值。
- 后台命令在会话关闭后仍运行，完成通知在会话下次打开时送达；面板列出工作区内所有会话的任务。
- 子 agent 的完成通知仍在 Agent Host 排队：Agent Host 在送达前崩溃时，由 ADR-0048 第 8 条的重启恢复补发"已中断"。

## 重新评估的触发条件

- T33 增加终端承载的任务类型时，复核进程树清理（portable-pty 不经 `ProcessSpawner`）与输出文件的来源。
- 用户反馈空闲唤醒的费用或频率不合适（R4 复核默认值）。
- Pi 改变 `sendCustomMessage` 在空闲时开启运行的语义，或改变流式期间自定义消息的追加时机。
