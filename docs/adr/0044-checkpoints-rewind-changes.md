# 0044. 检查点、回退、Changes 面板与会话分支的落地（补充）

- 状态：已接受，补充 ADR-0009、ADR-0011、ADR-0026、ADR-0027、ADR-0030
- 日期：2026-11-19
- 相关：架构第 6.9、7.1、7.4、7.6、7.7、8.2、9.1–9.3 节；T28

## 背景

ADR-0011 规定：Core 在每次经它的写入之前把原文件存入内容寻址存储，按"会话 + 用户回合"建索引；代码回退由 Core 完成，对话回退复用 Pi 的会话树（在指定 entry 处分支或移动 leaf，原分支保留）；每会话保留 100 个检查点，30 天未访问的会话清理快照。T28 落地时以下细节没有规定：检查点用哪个标识与 Pi 的回合对应；索引怎样落表、和对象写入的先后；回退跨越多个回合、经过分支或之前的回退时恢复到哪个内容；冲突怎样判定；恢复中途失败怎样撤销；对话回退之后 Agent Host 内按分支推导的状态怎样更新；Pi 只把 leaf 放在内存里，回退后的位置怎样保留到下次打开；"从此处摘要"用哪段提示；Changes 面板的基线与丢弃怎样保证不在过期的 diff 上操作。

## 决策

1. **检查点的键是会话加 PiArc 回合 id。** 回合 id（`turn-<uuid>`）在 ADR-0030 起随每条用户消息写进 Pi JSONL 的 `piarc.input` 条目，与用户消息一一对应，实时与历史的 transcript 行都带它；Core 在 `turn/started` 时就知道它，而用户消息的 entry id 要到 Pi 写完该消息后才有，Core 也收不到。所以 ADR-0011 的"用户回合 entry id"以回合 id 表示。Core 在会话 actor 交付 `turn/started` 时建检查点（同一回合只建一次）；`fs/write` 新增可选的 `turnId`，Agent Host 填当前回合，Core 用它把写入挂到检查点上（没有该行时当场补建，没有 `turnId` 时用该会话最近的检查点）。压缩回合同样有检查点，没有写入。
2. **表与对象。** schema v5：`checkpoints`（自增 id 即时间顺序、会话、回合 id、创建时间，会话与回合唯一）、`checkpoint_files`（自增 id 即写入顺序、所属检查点、路径、前后内容的 SHA-256，空值表示文件不存在、操作 `create`/`modify`/`restore`/`undo`/`discard`、恢复批次 id）、`checkpoint_sessions`（会话最近访问时间）。对象存在 `<数据目录>/checkpoints/objects/<哈希前两位>/<64 位哈希>`，经同目录临时文件与 rename 写入，相同内容只有一份，读出时校验哈希。顺序：`piarc-fs` 在写入的路径锁内、原子替换之前把旧字节存入对象库（`fs → checkpoint` 例外，ADR-0011 第 3 条），替换成功后 Core 才写 `checkpoint_files`；替换失败留下的对象由回收清掉。对象从存入到索引写完一直被钉住（进程内引用计数），回收跳过钉住的哈希，存入在钉住之后检查文件是否存在，所以回收与写入交错时索引不会指向已删除的对象。
3. **代码恢复按时间计算。** "恢复到回合 T 开始前"取该会话中检查点 id 不小于 T 的全部文件记录：每个路径的目标内容是其中第一条记录的"之前"内容（不存在则删除），冲突比对用最后一条记录的"之后"哈希。工作区只有一份，所以不论对话经过哪些分支、之前做过几次回退，按时间都能得到 T 开始时的文件内容。当前内容等于目标的跳过；等于最后的"之后"哈希的直接恢复；都不等（外部或 Bash 改过、文件被删）列为冲突，用户逐个选"用快照覆盖"或"保留当前"，或取消整个回退（不改任何文件）。只被 Bash 改过的文件不在记录里，界面写明并建议配合 git。
4. **执行、逐文件结果与撤销。** 恢复按路径顺序逐个进行：路径锁内重读当前内容，与预览时的哈希不同就判为该文件失败（期间又被改了），否则把当前内容存入对象库，再原子替换为目标内容或删除，最后从会话的文件状态表移除该路径（agent 下次 Edit 前必须重新 Read）。第一个失败即停止，报告每个文件的结果（已恢复、已删除、保留、失败、未执行）。每次恢复有一个批次 id，成功的每个文件写一条 `restore` 记录（"之前"为恢复前的内容、"之后"为恢复后的内容），挂在该会话最新的检查点上，因此后续的冲突判定与 Changes 基线都把恢复计入。撤销按批次 id 把仍处于恢复后内容的文件写回恢复前的内容（写 `undo` 记录），已被再次改动的文件列为冲突、不覆盖。写回直接用快照字节，编码、BOM 与换行原样保留。工作区外或受保护路径上的文件（当初经审批写入）出现在预览里并标明，用户确认回退即视为对这些路径的批准，Core 用 `Scope::for_bound_path` 绑定后写回。
5. **对话回退在 Agent Host 中移动 leaf 并持久化位置。** 每个回合第一条 `piarc.input` 新增 `from`：回合开始时（自动压缩之前）的 leaf id，`null` 表示会话开头。AHP 新增 `session/rewind`（`{ sessionId, turnId, mode: "branch" | "summarize" }`）：`branch` 把 leaf 移到 `from`（旧文件没有 `from` 时取该条目的父条目），追加自定义条目 `piarc.branch`（`{ turnId, fromLeaf }`，模型不可见）；`summarize` 用 T27 的摘要提示（`harness/prompts/compaction.ts`）把 `from` 之后到当前 leaf 的对话写成摘要，经 Pi 的 `branchWithSummary(from, …)` 追加 `branch_summary` 条目（Pi 把它作为"从分支返回"的摘要交给模型）。Pi 打开会话文件时把 leaf 放在最后一条 entry，所以追加的条目就是持久化的位置：空闲回收、进程重启之后仍停在回退后的分支。原分支的 entry 全部保留，Core 仍然只读 JSONL。结果带目标用户消息的原文，客户端放回输入框（与 Claude Code 一致）。会话必须空闲。
6. **分支变化后在同一 id 下重建会话对象。** 计划模式、memory 快照、条件 rules、读写过的文件等状态由 Agent Host 在打开会话时从分支推导。回退与分支切换之后，注册表关闭该会话的 Pi 运行时并在同一 id 下从文件重新打开（不触发 SessionEnd、SessionStart hooks，不清回放缓冲，`seq` 连续），所以分支上的任务清单、计划与模式随之切换，不在各模块里另写一套重新推导。代价是该会话的 MCP 连接随之重连（T36 的共享连接池之后不再有这一代价）。Core 收到结果后在会话路由上发 `session/branchChanged`，客户端整段重新加载 transcript 窗口与任务清单。
7. **分支切换与分支点。** AHP 新增 `session/switchBranch`（`{ sessionId, entryId }`）：leaf 移到给定的分支末端，同样追加 `piarc.branch` 并重建。分支点按回合计算：一个回合的起点条目（`from`）下面有多个回合时，这些回合互为分支。`session/history` 的结果新增可选的 `branches`：当前分支上每个有兄弟回合的回合 id、它在兄弟中的序号，以及每个兄弟的末端 entry id（该子树中最后写入的条目）与首条用户消息的预览；用户消息落在已有分支的位置时 Agent Host 发通知 `session/branches`（同样的列表）。客户端在用户消息行上按回合 id 显示"‹ 2 / 3 ›"。"从这里分支"沿用 T14 的 fork：`session/fork` 新增可选的 `beforeTurn`，新会话的对话到该回合的 `from` 为止（第一个回合时为空会话），客户端把该消息放回新会话的输入框。
8. **Changes 面板。** 会话改过的每个路径：基线是最早一条记录的"之前"内容（不存在即新建文件），当前内容从磁盘读，两者相同的不列出；`piarc_diff::file_diff` 给出统一 diff 与 hunk，文件内容按 `piarc-fs` 的编码检测解码、去掉 BOM。单文件沿用第 7.7 节的降级；面板超过 300 个文件或合计 5,000 行增删时整体降级：只给路径与计数，客户端展开单个文件时再取它的 diff，并以纯文本显示。每个文件带版本（当前内容的哈希，不存在为 `absent`）。按文件丢弃写回基线（新建文件则删除）；按 hunk 丢弃由 `piarc_diff::revert_hunks` 对当前文本反向应用 hunk（逐行核对 hunk 的新侧，多个 hunk 自下而上应用；恢复的行沿用相邻行的换行符，没有相邻行时取文件中出现的第一种换行），再按原编码写回。两者都要求请求带的版本等于路径锁内读到的当前哈希，否则报"文件已变化，请刷新"，不在旧 diff 上操作；成功后写 `discard` 记录并从文件状态表移除该路径。二进制文件只能整文件丢弃。
9. **保留与回收。** `piarc_checkpoint::RetentionPolicy`（每会话 100 个检查点、30 天未访问，经 `CoreConfig` 可改，时钟经 `piarc_ports::Clock` 注入）。会话的访问时间在会话打开与建检查点时更新。每个回合结束后在后台删掉该会话超出数量的最早检查点（连同其文件记录）；Core 启动后与之后每 6 小时在后台删掉超过期限未访问的会话的全部检查点，然后回收：列出对象目录，删除不被任何记录引用、也没有被钉住的对象。正在执行的回退、撤销与丢弃钉住它们要读的对象。删除最早的检查点会让 Changes 的基线前移到最早仍保留的记录，回退列表中这些回合不再提供代码恢复。
10. **协议与 Core API。** 握手新增能力 `checkpoints`（Agent Host 声明，Core 启用后才发 `session/rewind`、`session/switchBranch` 与 `session/fork` 的 `beforeTurn`）。AHP 新增：Core → Agent Host 的请求 `session/rewind`、`session/switchBranch`，Agent Host → Core 的通知 `session/branches`；`fs/write` 的 `turnId`、`session/fork` 的 `beforeTurn`、`session/history` 结果的 `branches` 为新增的可选成员。Core API 新增 `rewindPreview(id, turnId)`、`rewind(id, request)`、`undoRewind(id, restoreId)`、`sessionChanges(id, path?)`、`discardChange(id, request)`、`switchBranch(id, entryId)`；`forkSession` 新增可选的 `beforeTurn`；事件 `session/branchChanged`。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 检查点键用用户消息的 entry id | 与 ADR-0011 字面一致 | Core 在写入时拿不到它，要新增上报并处理到达顺序；回合 id 已经与它一一对应 | 否决 |
| 恢复只看目标回合到当前分支末端的记录 | 与对话分支对应 | 之前"只恢复对话"留下的改动、已被回退的分支上的改动会被漏掉或重复撤销，结果不再是"回合开始前的文件" | 否决 |
| 回退后只在内存中移动 leaf | 不写 JSONL | 空闲回收、进程重启、重新打开后回到旧分支，回退悄悄失效 | 否决 |
| 回退后在各模块里重新推导分支状态 | 不重连 MCP | 计划模式、memory、条件 rules、文件读写记录各有缓存，漏掉一个就把旧分支的状态带进新分支 | 否决 |
| 用 Pi 的 `navigateTree` 实现两种回退 | 少写代码 | 目标为用户消息时 leaf 落在其父条目（`piarc.input`）而不是回合起点；摘要用 Pi 自己的提示 | 否决，只用 Pi 的 `branchWithSummary` 与会话树 |
| hunk 丢弃由客户端提交改后的全文 | Core 少一个函数 | 客户端要处理编码与换行，且无法在路径锁内核对 | 否决 |

## 后果

- 协议在主版本 1.0 内新增第 10 条所列的方法、成员与能力；`npm run gen:protocol` 后补契约样本。
- `piarc-fs` 依赖 `piarc-checkpoint`（`crates/deps-rules.json` 已登记的单向例外）；`piarc-checkpoint` 不依赖任何功能 crate，索引的读写在 `piarc-store`，编排在 `piarc-core::checkpoints`。
- 每次回退与分支切换会重连该会话的 MCP server；会话文件里多出 `piarc.branch` 条目。
- 复用表登记内容寻址存储（`piarc_checkpoint::ObjectStore`）与 hunk 反向应用（`piarc_diff::revert_hunks`）。
- Claude Code 的 `fileCheckpointingEnabled` 随本 ADR 生效（键映射表改为生效、加入 PiArc 设置）：合并后为 `false` 时 Core 不建检查点、写入不存快照，之后的回合没有代码回退；之前记录的回合仍可恢复。设置读不出时保持开启。
- 摘要回退之后的第一条输入紧跟 `branch_summary`（Pi 以 user 角色交给模型），请求里出现两条相邻的 user 消息；两家线格式都接受（同 ADR-0043 第 11 条的失败回合），`rewind-summarize` 场景关闭 `role_order` 检查。
- 中断补齐（T14）把以分支摘要或提醒结尾的对话误判为被中断的回合，重新打开时追加中断标记：`harness/interruption.ts` 改为只把 user、toolResult 与有回复的 assistant 当作末尾。

## 重新评估的触发条件

- Pi 持久化 leaf 位置，或提供不重建会话就能切换分支的接口；
- 子 agent（T31）的写入进入快照时，回退需要跨会话合并记录；
- 用户需要覆盖 Bash 改动的回退（ADR-0011 的 git 影子仓库备选）。
