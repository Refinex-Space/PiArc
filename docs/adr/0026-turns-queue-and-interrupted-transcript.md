# 0026. 回合、排队与中断后的对话形态（补充 ADR-0009、ADR-0010、ADR-0011）

- 状态：已接受（补充）
- 日期：2026-11-17
- 取代：无
- 相关：[ADR-0009](0009-agent-host-protocol.md) 第 4、5 条，[ADR-0010](0010-process-model.md) 第 4 条，[ADR-0011](0011-session-storage.md) 第 1 条；架构文档第 5.3、6.1.2、6.15、7.4–7.6 节

## 背景

T14 把会话做成 Core 的一等实体，并按第 5.3 节完整投影 Pi 的事件。架构规定了"一个用户输入一个 turn""排队项可编辑""中断时补齐已中断结果""重试期间不向模型暴露中间错误""Core 用 `getEntries(since)` 补齐 seq 缺口"，没有规定实现方式。核对 Pi 1.5.2（`node_modules/@earendil-works/*` 的锁定版本）后，下面几点决定了做法：

- **follow-up 与回合**：`AgentSession.followUp()` 把消息交给 agent 循环，循环在本该停下时取出它、在同一次运行里继续，整个过程只有一个 `agent_start` 与一个 `agent_settled`（`pi-agent-core/dist/agent-loop.js` 的外层循环）。直接用它，一次运行里会有多个用户输入。
- **排队**：`steer()`、`followUp()` 只接受文本，Pi 的队列是字符串数组，`queue_update` 只报字符串；没有按项编辑的接口，只有整体 `clearQueue()`。消息送达时 Pi 删除第一个相同文本（`agent-session.js` 的 `message_start` 处理）。
- **中断**：被中断或出错的 assistant 消息仍写进会话文件，但 pi-ai 发请求前把它丢掉（`transform-messages.js`）；中断时还没开始准备的工具调用没有结果，pi-ai 在每次请求里临时补一条 "No result provided"，不落盘。于是中断后的下一次请求出现两条相邻的 user 消息（PLAN.md I18）。
- **工具并发**：并行模式下一条回复的所有工具调用同时执行、没有上限；只要有一个工具声明 `executionMode: "sequential"`，整条回复改为串行。
- **重试**：Pi 的 agent 循环对限流、过载、5xx 自动重试，发出 `auto_retry_start/end`，并把失败的那次回复从上下文中删去（`_omitRecoveryAttempt`）；但服务商 SDK 自己也会静默重试同类错误（Anthropic SDK 默认 2 次），那时 Pi 看不到错误，界面也就收不到进度。
- 会话 JSONL 按会话写入、只追加（ADR-0011），中断后补的内容一旦写入就随文件长期存在。

## 决策

1. **回合**：Agent Host 接受的每个输入是一个回合：`session/prompt`，或会话空闲时的 `session/steer`、`session/followUp`。回合从该输入的首个 `agent_start` 到 Pi 的 `agent_settled`。follow-up 不交给 Pi 的队列：它留在 Agent Host 的排队表里，上一个回合完成（`turn/completed` 已发出）后由 Agent Host 作为下一个回合的输入启动，按排队顺序逐个执行。steer 立即交给 Pi，在当前步骤（本次回复的工具调用执行完）之后、下一次模型请求之前进入上下文，属于当前回合。
2. **排队表**：Agent Host 给每个排队项分配 id，表中记录类别（steer / followUp）、文本与顺序，每次变化发 `session/queueChanged`（整张表）。编辑、删除、重排 steer 项时清空 Pi 的队列再按新顺序重新交给 Pi，期间收到的 `queue_update` 不处理，结束后按 Pi 的列表对齐一次；Pi 送达的 steer 项按 `queue_update` 对齐后移出表。回合结束时 Pi 还没送达的 steer 项转为表头的 follow-up。`session/abort` 清空排队表，结果中带回原来的各项（`returnedQueue`），被中断的回合之后不自动开始新回合。
3. **中断后的对话形态**：回合以中断结束时（`agent_settled` 的 `aborted` 为真），Harness Kit 在 Pi 的会话文件中补写：
   - 最后一条有效回复里每个没有结果的工具调用，补一条错误结果，文本为 "Interrupted by the user before this tool call finished."；
   - 如果模型可见的对话不以回复结尾，再追加一条 assistant 消息 "[The user interrupted this turn.]"（中断标记）。它的 provider、model、api 取会话当前的模型（Pi 从最后一条 assistant 消息推断恢复后的模型），用量为零，`rawStopReason` 为 `piarc-interrupted`（Pi 只把该字段用于调试）。

   会话被重新打开（`session/resume`）时做同样的检查：上一个进程崩溃或被杀时留下的未完成回合按同样方式收尾；以回复结尾的对话不受影响。历史投影（`session/history`）不显示中断标记；被中断的回复按 `interrupted` 显示。
4. **工具批次**：所有工具都以 Pi 的并行模式注册，由 Harness Kit 的调度器控制执行：按回复中的顺序，连续的只读并发安全调用（规范名 Read、Glob、Grep）组成至多 10 个的批次，其他调用单独成批；前面的批次全部结束后下一批才开始。Pi 不经执行就给出结果的调用（被拒、工具不存在、参数无效）按 `tool_execution_end` 计为结束。调度器包住 Agent Host 自己定义的工具，并经资源加载器的 `extensionsOverride` 包住所有扩展注册的工具（包括之后才注册的 MCP 工具）。
5. **重试**：Agent Host 对每个会话的设置施加 `retry.provider.maxRetries = 0`（内存中的覆盖，不写文件），让重试只发生在 Pi 的 agent 循环里：每次重试发 `turn/retrying`（attempt、maxAttempts、delayMs），失败的那次不进入后续请求。
6. **seq 缺口**：Agent Host 为每个会话保留最近写出的通知（至多 4,096 条或 8 MiB），`session/getEntries(since)` 返回 `seq` 大于 `since` 的部分及它们是否完整。Core 发现缺口时暂存后续通知，补齐后按 `seq` 顺序交给客户端；回放缓冲已经丢掉缺失的通知时，Core 向客户端发 `session/resync`，由客户端改用 `transcript_window` 重新加载。超过单帧上限的会话通知不写出、不占 `seq`，只记日志。
7. **会话 id**：`session/create` 带 Core 生成的 id。请求超时或连接中断时 Core 仍按该 id 跟踪会话，以 `session/resume` 收敛两端状态（ADR-0009 第 5 条的对账）。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| follow-up 交给 Pi 的队列，投影器在用户消息处切分回合 | 少一层排队 | 一次 Pi 运行包含多个回合，`turn/completed` 的用量与状态无法按回合区分；编辑仍需清空重排 | 否决 |
| 排队项全部留在 Agent Host，steer 在 `turn_end` 时再交给 Pi | 编辑不需要重排 Pi 的队列 | `turn_end` 之后 Pi 立即轮询 steering，交接时机由 Pi 的事件顺序决定，容易错过一个步骤 | 否决 |
| 中断后不落盘，只在请求前补齐 | 不改会话文件 | 要改 Pi 或 pi-ai 的请求组装；会话文件在 PiArc 与 Pi CLI 中看到的内容不一致 | 否决 |
| 中断标记用 user 消息（例如"[已中断]"） | 与部分产品的做法一致 | 后面紧跟用户的下一条输入，仍是两条相邻的 user 消息 | 否决 |
| 保留 SDK 的静默重试 | 少一处覆盖 | 界面看不到重试进度，与第 6.15 节不符 | 否决 |
| 缺口时直接让客户端重载 | 不需要回放缓冲 | 一条通知丢失就要重载整段 transcript，流式文本中的增量无法从会话文件恢复 | 作为回放缓冲不完整时的退路 |

## 后果

- 正面：回合、用量与状态一一对应；排队项可以按 id 编辑；中断后的请求在严格校验下合法（tool_use / tool_result 成对、角色交替），S3、S9 的中断场景恢复全部校验规则；重试进度对界面可见。
- 负面与代价：会话文件里多出中断后补写的结果与标记（Pi CLI 打开同一文件时能看到它们）；steer 的编辑要清空并重排 Pi 的队列，依赖 Pi 的 `clearQueue()` 与 `getSteeringMessages()` 语义；工具调度依赖 Pi 把扩展工具存在扩展对象的 `tools` 映射中（`extensions/loader.js` 的 `registerTool`）。steer 消息仍按 Pi 的做法紧跟工具结果，形成相邻的 user 消息（Anthropic API 会合并），严格 mock 的 steer 场景关闭 `role_order`。
- 需要配套做的事：T20 的策略闸门拒绝调用时调用 `Projector.markDeclined`；T27 让压缩与中断标记的处理一致；升级 Pi 时先跑 golden 录制（`PIARC_UPDATE_GOLDEN=1 cargo test -p piarc-testkit --test agent_host golden`）与 Agent Host 端到端测试。

## 重新评估的触发条件

- Pi 提供按项编辑排队消息的接口，或改变 follow-up、steer 的送达时机；
- Pi 或 pi-ai 改变对中断回复与孤立工具调用的处理（例如自己补齐并落盘）；
- Pi 提供执行层面的工具并发上限或批次控制；
- 回放缓冲的容量在真实使用中不足以覆盖常见的缺口（`session/resync` 频繁出现）。
