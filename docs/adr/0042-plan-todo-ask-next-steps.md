# 0042. 计划模式、任务清单、提问与下一步的宿主工具（补充）

- 状态：已接受，补充 ADR-0009、ADR-0031、ADR-0033、ADR-0037；第 2、3 条的计划卡内容与面板显示由 ADR-0103 修订
- 日期：2026-11-19
- 相关：架构第 6.1.4、6.2.1、6.2.3、6.5、6.6.1、6.6.3、7.4、8.2 节；T26

## 背景

架构第 6.5 节决定四类宿主工具由 Harness Kit 注册、对所有服务商一致生效：计划模式不改工具列表、靠闸门约束，进出各以追加消息告知模型；任务清单存在工具结果的 `details` 中、随分支回溯；提问经 AHP `ui/ask` 到客户端表单；下一步建议在回合末渲染。T26 落地时，架构没有规定以下细节：模型发起的模式切换由谁执行、怎样记进转录；计划卡与普通审批卡怎样共用审批账本；行内评论的锚点与送达格式；提问表单的作答、超时与结果形状；"追加消息"在 Pi 1.5.2 上的投递时机；客户端重新加载后从哪里取当前计划与任务清单。

## 决策

1. **模式仍由 Core 持有。** `EnterPlanMode` 在裁决中按只读工具处理（任何模式都放行，deny 规则与 hooks 照常），允许时 Core 把会话切到 plan（不写工作区记忆：这是模型的选择）。`ExitPlanMode` 在裁决阶梯第 3 步之后有专门一步：plan 模式下必定询问（`planApproval`，PermissionRequest hook 不能代答），其他模式拒绝（"计划模式未开启，没有计划可批准"）。用户批准时选择后续模式（`acceptEdits` 或 `default`），Core 切换并记入工作区记忆，与模式菜单的选择一样。允许调用后的新模式随 `policy/evaluate` 结果的新可选成员 `mode` 交回 Agent Host，Agent Host 在调用执行前把它写成分支条目 `piarc.permissionMode` 并投影为 `permissionModeChanged`，与模式菜单走同一条记录路径。
2. **计划卡是审批卡的一种。** 审批卡新增 `kind: "plan"` 与成员 `plan`（Markdown 原文）；答复新增可选成员 `mode`（批准时必填）、`comments`（继续规划时的行内评论）。批准只接受 `allowOnce`；继续规划是 `deny`，反馈与评论按固定格式作为拒绝理由回给模型，模式保持 plan。计划卡与其他卡共用审批账本（`revision`、`connectionEpoch`、多窗口只接受第一个有效答复）、热键（Mod+Enter 批准并自动接受编辑，Mod+Shift+Enter 批准并手动审批，Esc 继续规划）、400 ms 防误触与输入法守卫。
3. **行内评论用 UTF-16 偏移锚定。** 每条评论 `{start, end, quote, text}`，`start`、`end` 是计划原文的 UTF-16 码元偏移（第 7.7 节），`quote` 必须等于该区间的原文，Core 校验后才接受答复。计划面板以原文（等宽、保留换行）显示计划，选区经 DOM Range 换算成偏移，所以锚点与模型收到的计划逐字对应。送达格式：先一句"用户未批准，plan 模式保持开启，修改计划后再用 ExitPlanMode 提交"，再附"Feedback from the user:"段，再按序列出 `N. On "<引文的 JSON 字符串>" (offsets S-E): <评论>`。
4. **批准的计划是会话 entry。** `ExitPlanMode` 只在用户批准后执行，执行时写自定义 entry `piarc.plan`（`plan`、`toolCallId`、`mode`）并发 AHP 通知 `harness/plan`。分支上最后一条 `piarc.plan` 是当前计划，Agent Host 的 `currentPlan(entries)` 读取它，作为 T27 压缩后重注入的接口；退回的计划不写 entry，只留在 `ExitPlanMode` 的调用条目里。
5. **任务清单在工具结果里。** `TodoWrite` 的参数与 Claude Code 一致（`todos` 的 `content`、`status` 为 pending / in_progress / completed、`activeForm`），每次调用替换整张清单；结果的 `details.todos` 以协议形状（状态 camelCase）保存。当前清单是分支上最后一个成功的 `TodoWrite` 结果（`currentTodos`，注入接口），因此随 fork 与回退回溯，压缩后 entry 仍在分支上。Agent Host 在该调用的 `item/completed` 之后发 `harness/todo`，Core 原样转发给客户端。
6. **提醒走一个模块。** `agent-host/src/harness/reminders.ts` 的 `Reminders` 按键排队提醒，同键后者替换前者、未送达时可撤回；送达是一条不显示的 Pi 自定义消息 `piarc.reminder`（首行 `[PiArc reminder]`，Anthropic 线格式上与相邻 user 消息合并），在运行开始（`before_agent_start`）或一轮工具调用之后（`turn_end`，Pi 1.5.2 在下一次请求前把它接在本轮工具结果之后）发出，持久化在会话中，对话保持只追加，system 与工具定义不变。键 `mode`：模式菜单把 plan 打开或关闭时排队，切回原状态时撤回；模型自己调用 `EnterPlanMode`、`ExitPlanMode` 时工具结果本身就是告知，撤回提醒。键 `todo`：清单有未完成项、且连续 `TODO_REMINDER_ROUNDS`（8）轮工具调用没有更新时排队一条，列出未完成项；计数从最后一次更新或上一条 `todo` 提醒算起，以分支为准。T27 在同一模块上扩展成统一的 system reminder 通道。
7. **提问表单经 `ui/ask`。** `AskUserQuestion`（1–4 题，每题 2–4 个选项，可单选、多选，总能写"其他"自由回答；选项可标 `default`）在裁决中按只读工具处理，工具执行时发 AHP `ui/ask`。Core 把表单作为 `kind: "question"` 的审批卡（成员 `questions`）放进同一账本，答复以 `allowOnce` 加 `answers`（每题 `selected`、`other`）作答，`deny` 为不回答。所以表单在任何模式下都显示（第 6.2.2 节 `requiresUserInteraction`）。超时取合并设置的 `askUserQuestion.timeoutSeconds`（PiArc 设置，未设置不超时），计时用 `ToolIoConfig.clock`（测试注入 `ManualClock`）；超时与作答以账本为准，先取走卡片的一方生效。结果对模型是 JSON：每题 `outcome`（`answered`、`default`、`unanswered`、`declined`）、所选标签与自由回答。回合中断或连接断开时撤下表单，请求以 `cancelled` 结束。T20 在窗口层自动拒绝提问的占位逻辑删除。
8. **下一步建议不需要 Core。** `SuggestNextSteps`（1–4 条，每条 `title` 与 `prompt`）立即返回，不占回合；客户端从调用条目的参数渲染。"在此执行"把 `prompt` 作为本会话的下一条输入（运行中为 follow-up），"开始新会话"在同一工作区走新建会话流程，以 `prompt` 为首条输入。
9. **重新加载时的状态。** `session/history` 的结果新增可选成员 `harness`（`plan`、`todos`），由注入接口从分支计算；客户端加载历史窗口时据此恢复右栏任务卡片与计划面板，之后跟随 `harness/todo`、`harness/plan` 更新。
10. **能力协商。** 握手新增能力 `planMode`（`EnterPlanMode`、`ExitPlanMode`、`harness/plan`、裁决结果的 `mode`）、`todo`（`TodoWrite`、`harness/todo`）、`ask`（`AskUserQuestion`、`ui/ask`）；Core 未启用时 Agent Host 不注册对应工具。`SuggestNextSteps` 不依赖 Core。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| plan 模式移除写工具 | 模型看不到写工具，少一次被拒 | 工具定义变化使提示缓存失效、可能丢弃 thinking 块（第 6.6.1 节） | 否决（架构已定） |
| Agent Host 自己切换模式，再通知 Core | 少一个结果成员 | Core 的裁决与 Agent Host 的记录可能不一致；模式事实不在 Core | 否决 |
| AskUserQuestion 的作答放进 `policy/evaluate` 的 `updatedInput`（Claude Code SDK 的做法） | 不需要新方法 | 架构第 7.4 节已列 `ui/ask`；把作答混进权限结果，超时与默认选项也不好表达 | 否决 |
| 超时在 Agent Host 计时 | Core 不需要时钟 | 计时与账本不在同一处，迟到的答复与超时会竞争；测试要另造假时钟 | 否决 |
| 提醒每次请求临时插入（Pi `context` 事件） | 不写会话文件 | 插入位置随请求变化，破坏前缀缓存，恢复与分叉后不可重现 | 否决 |
| 计划写入 `plansDirectory` 目录的文件 | 与 Claude Code 新版的计划文件一致 | 任务要求计划是会话 entry；目录与文件的生命周期另需设计 | 本任务不做，登记事项 I104 交 R3 决定 |

## 后果

- 协议在主版本 1.0 内新增：通知 `harness/todo`、`harness/plan`，请求 `ui/ask`，审批卡 `kind: "plan"` 与成员 `plan`、`questions`，答复成员 `mode`、`comments`、`answers`，`policy/evaluate` 结果成员 `mode`，`session/history` 结果成员 `harness`，握手能力 `planMode`、`todo`、`ask`。
- `PLAN_MODE_REFUSAL` 的措辞改为指向 ExitPlanMode（"submit your plan with ExitPlanMode"）；依赖原措辞的场景同步更新。
- 默认 Tool Profile 增加五个宿主工具的描述与系统提示中的工具指引；原创性检查的范围扩大到全部工具描述与提醒文案。
- 子 agent 中移除这些工具由 T31 处理；压缩后经注入接口重注入当前计划与清单由 T27 处理。
