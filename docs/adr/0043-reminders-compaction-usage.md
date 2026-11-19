# 0043. System reminder 通道、压缩与上下文用量（补充）

- 状态：已接受，补充 ADR-0009、ADR-0027、ADR-0033、ADR-0038、ADR-0039、ADR-0042
- 日期：2026-11-19
- 相关：架构第 6.3.2、6.6.3–6.6.5、6.15、7.4、8.2 节；T27

## 背景

架构第 6.6 节规定：动态信息以追加消息送达，不改写 system prompt；压缩用 PiArc 自写的分节摘要提示，按第 6.15 节的公式触发，连续失败后熔断，压缩后重注入关键状态；Agent Host 按类别统计上下文用量。T22（懒加载 memory）、T24（条件 rules）、T25（hooks 上下文）、T26（计划模式与任务清单提醒）各自往对话里追加消息，压缩仍是 Pi 的默认提示，也没有用量上报。T27 落地时，架构没有规定以下细节：提醒的类型与格式；外部修改怎样检测；阈值由 Pi 判断还是由 Harness Kit 判断；熔断的计数口径与复位；重注入的上限与读取方式；用量的估算口径与服务商报告不一致时怎样处理；这些信息经哪些 AHP 方法传递。

## 决策

1. **一个提醒通道。** `agent-host/src/harness/reminders.ts` 的 `Reminders` 是模型可见的运行时提示的唯一出口。每条提醒有类型（`todoStale`、`fileModified`、`planMode`、`backgroundTask`、`memoryLazyLoad`、`rulesMatched`、`hookContext`）、来源（文件路径、hook 事件名、任务名等）与正文；按键排队，同键替换、可撤回。送达是一条不显示的 Pi 自定义消息 `piarc.reminder`，正文首行 `[PiArc reminder]`，其后每条提醒一节（首行 `<类型> (<来源>)`），`details.reminders` 逐条记下 `key`、`type`、`source` 与该类型需要回放的数据（memory 的版本摘要）。送达点：运行开始（`before_agent_start`）与带工具结果的一轮之后（`turn_end`，Pi 1.5.2 把它接在本轮工具结果之后、下一次请求之前）；压缩完成时直接追加到会话（见第 7 条）。Stop hook 的续跑理由在 `agent_before_settle` 以同一格式的条目送达。对话保持只追加，system 与工具定义不变；Anthropic 线格式上提醒并入相邻的 user 消息（`memory-wire.ts`）。
2. **旧入口迁入。** T22 的懒加载与 memory 变化（含跨日日期）是 `memoryLazyLoad`，T24 的条件 rules 是 `rulesMatched`，二者的版本摘要随提醒的 `details` 持久化，恢复与分叉沿用分支；T25 的 `additionalContext`（SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、PostToolUseFailure 与 Stop 的上下文）是 `hookContext`，PostToolUse 的替换输出与 `decision: block` 的反馈仍在工具结果里；T26 的两类是 `planMode`、`todoStale`。`piarc.memory`、`piarc.hookContext` 两个旧的消息类型不再写入；分支里已有的 `piarc.memory` 条目仍按原格式回放版本摘要（旧会话文件兼容）。`backgroundTask` 的入口是 AHP 请求 `session/remind`（Core → Agent Host，只接受该类型），T32 由后台任务管理器调用。
3. **外部修改用请求前的 stat 比对。** 每个提醒送达点之前，Agent Host 发 `fs/changes`；Core 遍历该会话的文件状态表（读过或写过的文件），元数据（大小、修改时间）与记录不同才重新计算哈希，哈希不同（或文件已删除）即返回，并记下已报告的哈希，同一版本只报告一次；记录的快照不变，所以先读后改照常拦住未重新读取的 Edit。不用 notify 监听：监听要为每个读过的文件所在目录持有句柄，事件有合并与延迟、跨卷与网络盘不可靠，并且要另外排除会话自己的写入；请求前比对只在需要时花 O(读过的文件数) 次 stat，结果确定，测试不依赖事件时序。
4. **摘要提示自写，全部触发方式都经它。** `session_before_compact`（manual、threshold、overflow）里 Harness Kit 自己发摘要请求并把结果交回 Pi：PiArc 的 system 文本与分节指令（任务目标、用户要求与约束、关键决策、已改文件、错误与修复、待办、当前进展、继续所需的上下文，固定顺序，文本在 `harness/prompts/compaction.ts`）；待摘要的对话与跨回合的前半段放在同一个请求里（Pi 默认分两次），上一次摘要以 `<previous-summary>` 并入；`/compact` 的重点说明以 "Focus requested by the user" 原样带入，PreCompact hook 的 exit 0 stdout 以 "Instructions from PreCompact hooks" 带入；请求走会话的模型、effort 与 `agent.streamFunction`（凭据经 ModelRuntime 解析），不写提示缓存（`cacheRetention: "none"`），按会话的重试设置用 pi-ai 的 `retryAssistantCall` 重试。摘要末尾附 Harness Kit 从工具调用（规范名）算出的已读与已改文件列表，`details` 记录它们并在下一次压缩时合并。PreCompact block 时取消压缩；PostCompact 收到最终摘要。
5. **阈值由 Pi 的压缩设置表达。** 纯函数 `autoCompactThreshold`（`harness/compaction-threshold.ts`）给出 T = W − min(O, 20,000) − 13,000，W = min(模型窗口, 用户的自动压缩窗口上限)，O 为模型最大输出，窗口可由每模型设置覆盖（T29 接入）；上下文 ≥ T 时压缩。Pi 1.5.2 的判断是 `tokens > window − reserveTokens`，所以 Harness Kit 给会话的 `SettingsManager` 施加 `compaction.reserveTokens = 模型窗口 − T + 1`（同时写进该模型的 `modelOverrides`，压过 Pi 设置文件里的值），`compaction.enabled` 取 `autoCompactEnabled` 与熔断状态。这样 Pi 的三个检查点（发送输入前、两步之间、回合结束后）与上下文溢出的压缩重试都原样生效，不在 Harness Kit 里另写一套触发。用户设置是 `autoCompactEnabled`（默认开）与 `autoCompactWindow`（与 Claude Code 同名同义，取值夹在 100,000–1,000,000），Agent Host 在每次运行开始时经 `context/settings` 向 Core 取一次（模型切换后同样重算）。Pi 的 `SettingsManager.reload()` 会清掉内存覆盖值（资源加载时就会调用），所以覆盖值在每次运行开始时重新施加；T14 的 `retry.provider.maxRetries = 0` 一并移到这里。
6. **熔断按会话计数。** 自动压缩（threshold、overflow）失败（非中断、非 hook 取消），或成功但压缩并重注入后的上下文估算仍 ≥ T，计一次；连续 3 次即停止自动压缩（`compaction.enabled = false`），第 3 次的 `contextCompaction` 条目带 `autoCompactStopped`（`failed` 或 `ineffective`），客户端在压缩提示行写明原因与"手动 /compact 仍可用"。一次有效的自动压缩把计数清零；手动压缩成功或新会话复位熔断。状态在 Agent Host 内存中，进程重启后复位。
7. **压缩后重注入走提醒通道。** `session_compact` 时 Harness Kit 组装一条 `piarc.reminder` 并直接追加到会话（Pi 每次请求都从会话投影重建消息，所以紧接着的请求就带上它；此时没有进行中的工具调用），按顺序：memory（system 中的 memory 段不变；以提醒加载过的子目录 memory、条件 rules，以及内容已不同于 system 的 memory 文件，按 `fs/memory` 的当前磁盘内容重送）、当前计划（`currentPlan`）、任务清单（`currentTodos`）、已调用 skill 的正文（分支条目 `piarc.skillInvoked`，T37 写入）、最近读写的文件（按分支上 Read、Write、Edit 调用的先后，经 Core `fs/read` 读当前内容）。上限常量在 `harness/reinjection.ts`：memory 每个文件 10K、合计 20K token；计划 10K；任务清单 2K；skill 每个 5K、合计 25K（超出部分截断并注明）；文件最多 5 个、每个 20K、合计 50K（放不下的文件只给路径提示）。重注入与用量统计用同一个估算函数。压缩完成时 Agent Host 发 `fs/forgetReads`，Core 清掉文件状态表里的读取范围、保留哈希（I72）：重复读取不再返回指向已被摘要掉的内容的存根，先读后改仍成立。
8. **用量的口径。** 估算函数 `estimateTokens`（`harness/tokens.ts`）为字符数 / 4 向上取整，图片按 4,800 字符，与 Pi 的阈值估算同一口径。每次模型请求前（Pi `context_with_system` 事件）按类别统计：system prompt（system 文本去掉项目上下文与 skills 索引两段）、工具定义（不含 MCP）、MCP 工具（带命名空间的工具）、memory（system 的项目上下文段与 `memoryLazyLoad`、`rulesMatched` 提醒）、skills（skills 索引段与 skill 提醒）、对话（user、assistant、压缩摘要与其他提醒）、工具结果。服务商报告了这次请求的输入（`input + cacheRead + cacheWrite`）时以它为合计，与分类之和的差额记为"未分类"；分类之和大于报告值时各类按比例缩小（最大余数法取整），未分类为 0。经通知 `session/usage` 上报（每次回复结束、压缩之后），`session/getContextUsage` 返回最近一次（没有时现算估算值）；结果带有效窗口、阈值与自动压缩状态。
9. **缓存断点布局不变。** Anthropic 请求保持 T22 的布局：system 两段（静态前缀、项目上下文起的会话段）各一个 `cache_control`，工具定义末尾一个，消息级只有最后一条 user 消息的最后一块一个；提醒与重注入都是 user 侧的追加，压缩前后布局相同，摘要请求不带缓存。mock provider 的 `cache_breakpoint_count`、`cache_breakpoint_position`（`max_message_level: 1`、`last_message_only`）与请求体断言锁定它。
10. **协议与能力。** 握手新增能力 `context`。Agent Host → Core：请求 `context/settings`、`fs/changes`、`fs/forgetReads`，通知 `session/usage`；Core → Agent Host：请求 `session/getContextUsage`、`session/remind`；`session/compact` 新增可选参数 `instructions`；条目新增类型 `reminder`（`reminders` 的类型与来源、`text`，实时与历史一致，客户端默认不渲染，T29 的详细视图显示）；`contextCompaction` 新增可选成员 `autoCompactStopped`。Core API `compact(id, instructions?)`、`contextUsage(id)`，会话快照带最近的用量。
11. **失败回合的对话形态（I67）保持不变。** 失败的请求没有产生 assistant 内容，pi-ai 丢弃出错的回复后下一条输入紧跟上一条 user 消息；Anthropic 与 OpenAI 都接受相邻的 user 消息，压缩的切点也不会落在工具调用与结果之间，所以不补标记。严格 mock 的 `role_order` 只在含失败回合的场景关闭。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| Harness Kit 在请求前自己判断阈值并调用 `session.compact()` | 不依赖 Pi 的设置语义 | 要复制 Pi 的三个检查点与溢出重试；手动压缩会先中断当前运行 | 否决 |
| 外部修改用 notify 监听 | 修改即时得知 | 见第 3 条：句柄、事件合并、跨卷不可靠、要排除自身写入 | 否决 |
| 提醒每次请求临时插入（Pi `context` 事件） | 不写会话文件 | 插入位置随请求变化，破坏前缀缓存，恢复与分叉后不可重现（ADR-0042 已否决） | 否决 |
| 分类之和超过服务商报告值时"未分类"取负数 | 原样反映差额 | 无法画成占比，合计也不再等于报告值 | 否决 |
| 熔断状态写进会话条目 | 进程重启后保留 | 状态与当前设置、模型相关，重启后重试 3 次的代价很小 | 否决 |

## 后果

- 协议在主版本 1.0 内新增第 10 条所列的方法、成员与能力；`npm run gen:protocol` 后补契约样本。
- Claude Code 键 `autoCompactEnabled`、`autoCompactWindow` 改为生效（`piarc_config::claude::SETTINGS_KEYS`），PiArc 设置同名。
- 依赖 `[PiArc memory]`、`[PiArc hook context]` 标记的场景改为 `[PiArc reminder]`。
- 摘要提示与提醒文案纳入原创性检查（`docs/engineering/prompt-originality.md`）。
- 服务端 context editing / compaction 仍是 T48；skill 正文的真实来源是 T37；后台任务提醒的来源是 T32。
