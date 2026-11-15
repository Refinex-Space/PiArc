# T32 后台任务、Monitor 与 KillShell

| 项 | 内容 |
|---|---|
| 阶段 | 4 M3 多会话与生态 |
| 依赖 | T31 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 中 |
| 关联验证项 | 无 |
| 关联需求 | FR-TL-04 |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T32`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

开发服务器、长构建、CI 轮询这类长任务不能卡住回合。Claude Code 的做法是：命令转到后台，输出写文件，模型按需用 Read 查看；完成时通知模型；Monitor 把新增输出逐行回灌。PiArc 把这些放进 Core 的任务管理器统一管理：进程归 Core 持有（第 7.3 节），Agent Host 崩溃重启不会丢失后台任务。

T17 的前台命令超时目前直接终止，本任务改为转后台；T31 的后台子 agent 也在此纳入统一管理。完成后，后台命令、后台子 agent、Monitor 共用一个任务模型、一个面板、一条完成通知路径。

## 必读

1. 架构设计：
   - 第 6.11 节"后台任务、终端、Monitor"中的 Bash 行为、后台任务、Monitor 三条
   - 第 6.1.4 节（KillShell、Monitor 的默认审批）、第 6.6.3 节"System reminder"
   - 第 7.3 节（后台任务的状态归属）、第 7.4 节（`exec/kill`、`exec/background/list`、`exec/background/read`）
   - 第 9.1 节（会话目录）、第 9.2 节（`background_tasks` 表）、第 9.3 节（会话临时目录清理）
   - 第 8.2 节中的右栏后台任务卡与可停靠面板
2. ADR-0017 决策 1–2：终端与 agent 后台命令的关系。T33 会在本任务的任务管理器上增加终端承载的任务类型。
3. `docs/research/claude-official-capabilities.md` 第 A7.3 节；第 A1 节中 Monitor 一行；第 A2.2 节中 `Bash(...)` 规则同时匹配 Monitor 的说明；第 A3.3 节中 PreToolUse 的 matcher 说明。
4. T17（piarc-exec）、T23（Bash 分析）、T25（hooks matcher）、T27（system reminder 通道）、T31（后台子 agent）交付的代码与 CLAUDE.md。
5. 实现时查阅：Pi 锁定版本中 bash 工具的参数定义与 `BashOperations`，确认在规范名 `Bash` 上增加参数的方式。

## 范围

### 要做

- Core 任务管理器：统一管理后台命令、后台子 agent、Monitor。
- `Bash` 的 `run_in_background`；前台超时转后台。
- `KillShell` 与 `Monitor` 两个工具。
- 完成通知注入下一回合。
- 后台任务面板与右栏后台任务卡。
- 每项行为的 L2 场景与能力 ID。

### 不做

- 终端承载的后台任务与 agent 读屏（T33）。本任务的后台命令走 piarc-exec 的管道与输出文件；任务类型设计成可扩展，T33 在其上增加终端类型。
- 沙箱内执行（T39）。
- 应用退出后继续运行后台命令：应用退出时一律终止。

## 交付物

### 1. 任务管理器（Core）

- 任务模型：`taskId`、`sessionId`、`kind`（`command` / `subagent` / `monitor`，留出扩展位）、标题、命令或 agent 类型、cwd、开始时间、状态（`running` / `completed` / `failed` / `killed` / `interrupted`）、退出码、输出文件路径与字节数。
- 编排在 piarc-core，进程管理在 piarc-exec；元数据写 `background_tasks` 表；以带 `revision` 的实体快照推给客户端。
- Agent Host 崩溃重启不影响运行中的命令；重启后 `exec/background/list` 返回现状，完成通知照常送达。
- 应用退出时有序终止全部后台进程树，状态记为 `interrupted`；重启后显示为已中断，不自动重跑。
- T31 的后台子 agent 迁入：Agent Host 上报子会话生命周期，Core 登记为 `kind: subagent`；从面板停止时中止该子会话。
- 会话归档时清理该会话的任务输出（第 9.3 节）。

### 2. 后台命令与超时转后台

- 规范名 `Bash` 增加 `run_in_background` 参数（参数风格对齐 Claude Code，描述自写）。启动后立即返回任务 ID 与输出文件路径。
- 前台命令达到超时（T17 的默认 2 分钟、上限 10 分钟）时转为后台任务：同一进程继续运行，工具结果说明已转后台，给出任务 ID 与输出路径。
- 这替换了 T17 中"超时即终止"的临时行为。按新行为更新 T17 的相关场景期望；进程树终止的覆盖转到 KillShell 与中断路径。T17 对应验收项的描述需要用户修改：在报告中列出，不改 `acceptance.json`。
- 输出持续读取并写入 `sessions/<sessionId>/tasks/<taskId>.log`；模型用 Read 查看（沿用 T16 对会话临时目录的读取放行）。
- 完成通知：任务结束后，该会话下一回合以 system reminder 注入任务 ID、命令、退出码、语义状态、耗时、输出路径与尾部预览。

### 3. KillShell

- 参数为任务 ID；终止整棵进程树（macOS 进程组先 SIGTERM、超时后 SIGKILL；Windows Job Object），状态记为 `killed`，输出文件保留，结果附尾部预览。
- 只能停止本会话（含其子 agent）启动的任务，其他会话的任务 ID 返回错误。默认不需要审批（第 6.1.4 节）。

### 4. Monitor

- 后台运行命令，把新增输出逐行回灌给模型。默认超时与上限参照官方行为（5 分钟、30 分钟），集中定义、可配置。
- 审批：Manual 模式下需要审批；T23 的 Bash 规则与 Bash 分析同样作用于 Monitor 的命令（`Bash(npm run *)` 同时匹配 Monitor）；hooks 的 `Bash` matcher 同时匹配 Monitor 命令。
- 回灌：回合进行中，新增行在下一次模型请求前以 system reminder 追加；会话空闲时，以带标记的消息唤醒会话，转录中显示为 Monitor 事件。两种情况都受限速约束：单次注入的行数与字符数有上限，超出部分汇总为"省略 N 行，完整输出见文件路径"；总注入量达到上限后停止回灌并告知模型。
- 结束条件：命令退出、超时、KillShell、会话关闭。

### 5. 客户端

- 可停靠的后台任务面板与右栏后台任务卡：按会话列出任务，显示类型、状态、耗时、最新几行输出，提供停止按钮（与 KillShell 走同一个 Core 入口）。
- 查看输出：按偏移分段向 Core 读取（`exec/background/read`），不把整份输出推进渲染进程。

### 6. L2 场景与能力 ID

- 场景 `tests/scenarios/bg-*.yaml`、`tests/scenarios/monitor-*.yaml`，能力 ID 如 `CAP-BG-TIMEOUT-001`、`CAP-MONITOR-RATE-001`。
- 时间相关逻辑用可注入时钟，场景不靠真实等待。

## 实现要点

- 子进程的 stdout/stderr 必须持续读取，否则管道写满后子进程阻塞（claw-code 的教训）。
- 转后台不重启进程：前台等待与后台登记共用同一个进程句柄。
- Windows 上每个任务一个 Job Object，保证 KillShell 与应用退出时整棵进程树被清理；macOS 上用进程组。
- Monitor 的注入只追加消息，不改写历史，不破坏 tool_use / tool_result 配对与缓存断点。Agent Host 重启期间新增行进入有界缓冲，恢复后补送。

## 验收标准

- [T32-A01] `run_in_background` 启动的命令立即返回任务 ID 与输出路径，模型随后用 Read 读到输出。验证：L2 场景。
- [T32-A02] 前台命令超时后转为后台任务，进程未被终止（PID 不变），工具结果说明已转后台。验证：L2 场景（超时调小）。
- [T32-A03] 后台任务完成后，退出码、语义状态与输出路径在该会话下一回合以 system reminder 注入。验证：L2 场景（mock provider 请求断言）。
- [T32-A04] KillShell 终止整棵进程树（含孙进程），状态为 `killed`，输出文件保留。验证：macOS 与 Windows CI 上的测试（进程表断言无残留）。
- [T32-A05] KillShell 无法停止其他会话启动的任务。验证：测试。
- [T32-A06] Monitor 把新增输出按行回灌给模型，超过单次限速或总量上限时截断并说明省略行数与文件路径。验证：L2 场景（mock provider 请求断言）。
- [T32-A07] Monitor 的命令受 Bash 规则、Bash 分析与 `Bash` matcher 的 PreToolUse hooks 约束，Manual 模式下需要审批。验证：L2 场景。
- [T32-A08] 会话空闲时 Monitor 的新增输出唤醒会话，唤醒频率受限速约束。验证：L2 场景（时钟可注入）。
- [T32-A09] Agent Host 被杀并重启后，运行中的后台命令继续运行，完成通知照常送达。验证：故障注入测试。
- [T32-A10] 应用退出时全部后台进程树被终止，重启后这些任务显示为已中断。验证：测试。
- [T32-A11] T31 的后台子 agent 出现在任务管理器中，可从面板停止。验证：L2 场景与 Playwright。
- [T32-A12] 后台任务面板与右栏卡片显示状态、耗时与最新输出，停止按钮生效。验证：Playwright（截图存 `tmp/evidence/T32/`）。
- [T32-A13] `npm run verify` 通过（含 Windows CI 上的进程树测试）。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新 `crates/piarc-exec` 与 `crates/piarc-core` 的 CLAUDE.md：任务管理器位置、状态机、输出路径、Monitor 限速常量的位置、Windows 上的 Job Object 用法。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：任务管理器、带限速的 system reminder 注入。
- 在报告与 `PLAN.md`"登记事项"中写明：T17"超时终止"相关验收项的描述需要用户按新行为修改。
