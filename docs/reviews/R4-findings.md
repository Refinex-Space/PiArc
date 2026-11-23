# R4 · M3 macOS 阶段评审

**2026-11-24 复核：M3（macOS）达标。** Apple M1 Max / 32 GB，macOS arm64，打包开发构建 1b15296，npm run perf:m3 -- --form packaged。12 个稳态样本，3 个并行会话（含独立 worktree）加 1 个子 agent，共享一个 stdio MCP server 且 4 个会话都取得 skills 索引；loadAsDescribed=true。Agent Host RSS 最大 217.9 MB / 270 MB，应用其余进程物理占用最大 270.0 MB / 510 MB。口径按已采纳的 ADR-0063，原始报告 tmp/evidence/partial-closure/m3-memory.json；此前 R5 复测为 229.1 与 263.8 MB。 逐项核对 T31–T38 和 W2 的 120 个验收项，全部为 passing。此前的 T34-A03 已实测通过，T35-A11 按 ADR-0063 完成物理内存复测。 Windows 私有工作集的正式稳态最大值交 W4 实机补验。下文保留初次评审采用 RSS 的记录。

**M3（macOS）未达标，阻塞项只有内存一项。** 第 16 章的退出标准是"3 个并行会话 + 子 agent 场景满足第 11 章内存预算"：Agent Host 达标（4 个活动会话最大 236 MB，上限 270 MB），应用其余进程合计 580 MB，超出 macOS 预算 510 MB。超出的主体是没有会话时就有的基线（约 511 MB），而 RSS 合计把各进程映射的同一份 Electron 框架代码页各算一次：同一负载下这些进程的物理占用（phys_footprint）合计约 250 MB。第 11 章只能收紧，改口径等于放宽，本任务不做。M3 的能力都已交付：能力清单里 M3 及之前没有 `planned` 的能力，L2 174 个通过、0 个失败（2 个 Windows 专属）。四个独立审查共提出 37 条发现，修复其中 10 项缺陷，每项都先有失败的测试；其中 3 项高风险：worktree 与上级目录的 skill、命令和子 agent 定义借用主工作区的信任（E1），项目文件经链接把任意本机文件带进 system prompt（E2），控制字符让终端执行的命令与裁决的文本不同（M1）。其余发现逐条写明不同意的理由，或登记到具体任务（I165–I176）。W2 的 Windows 分支已合并进主线，W2 为"已完成"。

**进入 M4 的前提条件**（不阻塞 T39、W3 开工）：

1. **内存口径由用户决定**（阻塞 M3 的退出判定）：要么接受一份 ADR，把第 11 章"应用全部进程合计"改为物理占用口径并写修订记录（这是放宽，须用户确认）；要么维持 RSS 口径，由 T44 在主进程与渲染进程上做优化，直到 510 MB 以内。在此之前 T35-A11、R4-A01、R4-A03 保持 failing。
2. 推送后看 CI：本分支自 `e0c41ce` 起未推送，W2 推送的运行 44887344674 中 Windows verify 与 Windows L4 各有失败（I166）；T35-A10、T36-A11 等 Windows CI 的验收项仍是 blocked。
3. 用户核对与决定的事项（不阻塞）：T34-A03 的真实拼音输入法核对（I141）；Monitor 唤醒的默认值（I03）；skills 与 Claude Code 的有意差异（I161）；T17-A01 的描述按新行为修改（I136）。
4. 往超过 1,000 行的文件加内容的任务先拆分（I165 列出文件与负责任务）。

**W3 需要重点核对的项**：

| 项 | 为什么 | 怎样核对 |
|---|---|---|
| ConPTY 终端与输入法 | 终端面板的 L4 在 Windows 整体跳过；`pointer.rs` 只在 Unix 编译（I163）；W2 的 CI 运行中 `terminal.e2e.ts` 停拉后多收 2 帧（I166） | 补 `pointer.rs` 的 Windows 变体；终端面板的选区、复制、链接、粘贴、vim、resize 在 Windows 实机走一遍；微软拼音在终端里组字上屏；按 CI trace 定位停拉帧数 |
| 控制字符与终端命令（R4 M1） | Git Bash 的行编辑与 macOS 的 bash 3.2 不同 | `cargo test -p piarc-core --lib terminal::`、`bash_cases` 在 Windows 通过；在智能体终端里试 `echo ok^Utouch x` 被拒绝 |
| MCP 的 `npx` 与 stdio 进程 | `npx` 跑在内置 Node 上、Job Object 结束 server 树，只有 macOS 实测（T36-A06、A11） | `cargo test -p piarc-testkit --test sessions mcp::` 与 L2 `mcp-*`；任务管理器确认 Agent Host 被杀后没有 server 残留 |
| worktree 路径 | 长路径、`.piarc\worktrees\` 下的深路径、大小写不同的同一路径（I147 ①）；R4 的 `covered_by_trust` 按路径前缀比较，大小写或 `\\?\` 写法不同会把可信的 skill 当成不可信（安全的一侧，但会让 `allowed-tools` 失效） | `cargo test -p piarc-git --test worktree`、L2 `worktree-*`、`skill-allowed-tools`、`subagent-worktree` 在 Windows 通过；worktree 会话里调用主工作区的 skill，`allowed-tools` 仍生效 |
| 托盘与后台常驻 | I147 ②⑤ | 深色/浅色任务栏、左键打开、右键菜单、提示里的计数；关闭最后一个窗口后后台运行与退出确认 |
| 多窗口 | 审批在两个窗口的一致性只在 macOS 跑过 L4 | `t35-windows` 与 `sessions` 的双窗口用例在 Windows 通过 |
| `piarc://` 与资源管理器菜单 | I147 ③；R4 E6：链接可以带 UNC 路径，打开前没有确认（I170） | 安装后链接与"Open with PiArc"可用、卸载后注册表项删除；`piarc://open?path=\\host\share` 的行为，记录 Core 是否访问了该共享 |
| 3 会话内存 | Windows 预算 450 MB，M0 已超出（I26） | `npm run perf:m3 -- --out tmp/evidence/W3/m3-memory.json`（场景含共享 MCP 与 skills），同时记下进程的私有工作集，与 R4 的口径分析对照 |
| Windows 基准机性能 | 第 11 章的 Windows 列多为"未测" | 在基准机型（x64 8 核 16 GB NVMe）上跑 `bench:t18`、`bench:s7`、`bench:s2`、`t14-warmup` |
| Narrator / NVDA | 终端与 M3 新界面（后台任务、worktree、命令面板）的读屏只在 macOS 看过 | 终端面板、后台任务面板、命令面板、MCP 与 Skills 设置页用 Narrator 与 NVDA 各走一遍 |
| W2 推送后的 CI 失败 | I166：`piarc-store` 同长度改写的 mtime 判据、`terminal.e2e.ts` 停拉帧数、`t19-composer` 提及断言 | 本机复现后修复；`piarc-store` 的用例改为显式设定不同的 mtime，或在判据里加内容哈希（评估成本） |
| 原子写入覆盖正在读的屏幕文件 | R4 Q4：`terminal/bound.rs` 的写入每 500 ms 重命名覆盖，Core 读取时 Windows 可能拒绝（I175） | 共享终端持续输出时反复 Read 屏幕文件，日志里没有 `cannot write the terminal's screen file` |

## 1. M3 退出标准复测

测量脚本 `scripts/perf/m3-memory.mjs`（`npm run perf:m3`）在 T35 的场景上加了 T35 之后的能力：项目 `.mcp.json` 里的一个 stdio MCP server 被四个会话（含子 agent）共用、每三步调用一次，启动日志只有一行；项目有 8 个 skill，四个首个请求都带 skills 索引。脚本核对这两项，不成立就以退出码 1 结束。详细数据与口径分析在 [`docs/perf/M3-memory.md`](../perf/M3-memory.md) 的"R4 复测"一节，原始结果在 `tmp/evidence/R4/m3-memory-{1,2}.json`、`m3-footprint-2.json`。

| 指标（最大 / 中位，MB） | T35 | R4 第 1 轮 | R4 第 2 轮 | 第 11 章 |
|---|---|---|---|---|
| Agent Host（4 个活动会话） | 238 / 222 | 236 / 230 | 218 / 210 | 150 + 40 × 3 = 270，达标 |
| 应用其余进程合计 | 576 / 566 | 580 / 571 | 577 / 570 | macOS 510，**超出** |
| 应用其余进程的物理占用 | — | — | 298 / 约 250 | （第 11 章不用这个口径） |
| MCP server（单独列出） | — | 75 | 74 | — |

- 环境：Apple M1 Max / 32 GB（不是基准机型 M1 Pro / 16 GB，与 T35 同一台），macOS 26.5.2（25F84），开发构建打包形态（打包于 172d413，Core 为 cargo release 配置），预热 20 s、采样 30 s（13 个样本），两轮。
- 与 T35 的差都在 10% 以内。第 2 轮的 Agent Host 低 8%，是两轮请求节奏的差异；应用其余进程两轮只差 3 MB。
- 定位：空闲（打开工作区、没有会话）时已有约 511 MB（主进程 215、渲染 154、GPU 92、网络 50）；会话只增加约 60 MB，主要在渲染进程（154 → 209）。不连工作区的空闲应用用 `vmmap` 看主进程：RSS 190 MB 中脏页只有 57 MB，其余是共享库的代码页；Core 的 `.node` 空闲时几乎不在内存里。`footprint` 给出的四个应用进程物理占用约 141 MB（空闲）、250 MB（负载）。没有找到本任务内能修的单点：常驻量来自 Electron 与 Chromium 的进程模型，口径决定了这一行能否达标。
- 处理：作为阻塞项写进结论，口径由用户决定（见前提条件 1），I26、I146 交 T44。

## 2. 能力覆盖与验收项

- `node scripts/ci/run-l2.mjs`：176 个场景，174 通过、0 失败、2 个 Windows 专属按平台跳过（`tmp/evidence/R4/run-l2.log`）。重新生成 `docs/product/capabilities.md` 后 `check-capabilities.mjs --results target/l2/results.json`：MISSING 0，capability checks passed；`--milestone M3`：`planned capabilities of M3 and earlier: 0`（`tmp/evidence/R4/capabilities.log`）。能力清单 171 项，active 154，planned 17（M4、M5），blocked 0。
- T31–T38 与 W2 的验收项：W2 12/12 passing；T31、T32、T33、T37、T38 全部 passing。不是 passing 的四项：

| 验收项 | 状态 | 原因 | 本评审 |
|---|---|---|---|
| T34-A03 | blocked | 真实拼音输入法的实测要用户在本机操作（I141）；组件测试与 CDP 合成已通过 | 接受 |
| T35-A10 | blocked | Windows 的右键菜单与 `piarc://` 注册要 Windows CI 或实机（本分支未推送） | 接受，W3 实机核对 |
| T36-A11 | blocked | Windows 上 Agent Host 被杀后没有 MCP server 残留，只有交叉编译（Job Object 与 `taskkill /T` 分支） | 接受，W3 实机核对 |
| T35-A11 | failing | 3 会话内存，应用其余进程超出 | 不接受为 blocked：即第 1 节的阻塞项，R4-A03 因此为 failing |

## 3. W2 确认与登记事项

- W2 在 Windows 分支（`windows/dev`，自 `e0c41ce`）上完成，R4 开工时按用户要求合并进来（b91ad7d）。W2 一侧与本地撞号的改为：登记事项 I146、I147 → I163、I164，架构修订 2.43 → 2.47（PLAN、W2 报告与 W2 的验收证据同步改号）。合并后的基线 verify 有两步失败，都是合并产物：W2 给 T35 的 worktree 测试加的 `#[expect(clippy::too_many_lines)]` 在 T35 拆短之后不再满足（01e190c），以及 `capabilities.md` 漂移（b48a5d7）。
- W2 的报告逐条覆盖了 M2 的两条退出标准（"M2 退出标准的 Windows 证据"一节）与 R3 列出的 9 个重点核对项（"R3 重点核对项"一节，UNC、PowerShell 规则、L3、Git Bash 白名单、hooks、检查点、设置写入的链接、长命令与预算、M2 界面），看板为"已完成"。
- T23–T30 中需要用户更新的验收项：0 项（W2 报告"T23–T30 中等待 Windows 的验收项"一节；R4 复核 `acceptance.json`，T23–T30 全部 passing）。W2 另按用户要求以本机实测关闭了 W1-A05、R3-A07、T32-A04、T32-A13、T33-A02、T33-A12、T33-A14、T34-A14。
- W2 推送后的 CI（运行 44887344674，0ad961c）：macOS verify 通过（I164 因此关闭）；Windows verify 的 `piarc-store` `tests/index.rs:196` 与 Windows L4 的 `terminal.e2e.ts:44`、`t19-composer.e2e.ts:138` 失败，登记 I166 交 W3。
- 登记事项：逐条处理见 `PLAN.md`（每条的"建议处理"列末尾的 **R4** 说明）。关闭：I03、I27、I59、I65、I67、I75、I81、I84、I105（并入 I165）、I111、I129、I135、I140、I150、I151、I152、I162、I164；指定任务：I07（R5 复查）、I25（T51）、I26 与 I146（T44）、I36（T39）、I56（T45）、I61（并入 I173）、I71、I131、I134、I137、I143（T48）、I107、I109、I138（T41）、I117（T39、T46）、I153（T39 开工检查）、I161（用户确认，改则 T48）；等用户：I136、I141、I145、I149。I87：R4 对照官方 settings 索引（code.claude.com/docs/en/settings-reference）复查，175 个 settings.json 键只缺 `enforceAnthropicSignIn`，已补为忽略（282beb5），表里多出的是 `~/.claude.json` 的键；下一次复查在 R5。I07：typescript-eslint 8.73.0 仍为 `typescript <6.1.0`。新登记 I165–I176。

## 4. 重新评估的触发条件

| ADR | 条件 | 结果 |
|---|---|---|
| ADR-0010（进程模型） | M0 或之后发现无法规避的跨会话状态串扰 | 未触发。子 agent 与并发审查没有发现会话之间的状态串扰：深度与并发计数只在 `SubagentRunner`、"本会话允许"按 `rule_owner` 归主会话且缓存键含主会话、子会话的工具过滤与检查点归属都按会话隔离；MCP 连接按设计在工作区内共享。审查发现的 S1–S4 是同一会话树内的取消与通知缺陷，已修复。E1 是信任范围问题，与进程模型无关 |
| ADR-0010 | 单进程崩溃率高到影响体验（例如每 100 会话小时超过 1 次） | 不适用：没有真实使用的崩溃统计（Beta 前没有遥测）；L2、L4 与会话层端到端测试中没有 Agent Host 崩溃 |
| ADR-0017（终端） | S7 中任一项在 M3 不达标：TUI 渲染、大量输出时帧率与事件循环延迟、键入回显延迟、中文输入法 | 未触发。T34 的渲染器：`cat` 100 MB 时主进程事件循环 p99 2.14 ms、键入回显额外延迟 p95 0.67 ms（第 11 章）；vim、top、less 的 L4 通过。中文输入法：组件测试与 CDP 合成通过，真实拼音输入法的实机核对等用户（T34-A03 blocked，I141）——是未核对，不是不达标 |
| ADR-0017 | Windows MSVC 目标无法链接 libghostty-vt，或 win32-arm64 上无法运行 | 未触发：CI 运行 44887344674 的 `core build`（x86_64、aarch64-pc-windows-msvc）与 `core load`（两个 Windows 目标）通过；W2 本机 x64 verify 15/15 |
| ADR-0017 | ghostty-web 迁到 libghostty-vt 1.x 官方 WASM 并发布稳定版，且修复输入法位置与 CSP 加载 | 未触发：npm 上仍是 0.4.0，没有基于 libghostty-vt 1.x 的稳定版（2026-11-21 检索） |
| ADR-0017 | libghostty-vt 的 1.x ABI 承诺被打破 | 未触发：锁定 1.0.1（`ghostty-vt.lock.json`），绑定与预编译产物未变 |

## 5. 独立审查的输入与调度

四个审查者是只读子代理（`read-only-reviewer`，只有读文件与搜索工具），在同一条消息里并行启动，基线 b91ad7d（合并 W2 之后），相互看不到对方。每个审查者拿到审查范围、要回答的问题、代码位置、架构章节、ADR、任务文件与既有测试的位置，要求自己形成结论、给出文件与行号和失败场景、标出"待核实"，并列出检查过且没有问题的部分；没有给出本评审的预判。审查者禁止打开 `reference/` 下的 clean-room 参考。

| 审查 | 范围与文件 | 架构与 ADR |
|---|---|---|
| 子 agent 与并发（S） | 深度与并发计数的唯一来源；取消沿会话 → 子 agent → 工具调用 → 子进程的传播；父子互等与死锁；审批来源与"本会话允许"；子会话状态隔离；任务管理器的竞态；Agent Host 重启时后台任务与子 agent；多窗口审批账本。Agent Host `runtime/subagents.ts`、`subagent-session.ts`、`session-registry.ts`、`harness/subagents/`；Core `sessions/`、`tool_io/subagents*`、`tool_io/tasks.rs`、`tasks/`、`terminal/`、`piarc-host`、`piarc-policy`、`piarc-exec`；客户端审批 | 6.4、6.11、6.12、7.2–7.5、8.1；ADR-0048、0049、0050、0052；T31、T32、T35 |
| MCP 与终端安全（M） | 信任闸门；OAuth token 存储与刷新；stdio server 的环境与孤儿进程；`requiresUserInteraction`；MCP 输出进模型时的截断；终端回调（`CLIPBOARD_READ`、`WRITE_PTY`）；粘贴安全；链接确认；读屏的共享校验；snapshot 的存放与清理；帧协议与输入接口的校验。`agent-host/src/mcp/`、`piarc-config` 与 Core 的 MCP、`piarc-term`、Core `terminal/`、主进程与 preload、渲染进程终端 | 5.6、6.8、6.11、10.1–10.3；ADR-0021、0025、0035、0050、0051、0053；T33、T34、T36 |
| 扩展加载与信任（E） | skills、命令、输出风格、子 agent 定义、MCP、`http`/`prompt` hooks、frontmatter 的 hooks 与 `mcpServers` 在信任前后的行为；`allowed-tools` 免审批的边界；`piarc://` 参数；worktree 共享信任与规则；配置诊断是否列全来源。`piarc-config`、Core `trust.rs`、`config_diagnostics.rs`、`worktrees.rs`、`sessions/`、`tool_io/{skills,subagents,hooks,policy}*`、`hooks/`、`piarc-hooks`、Agent Host 的 trust 与 skills、主进程 `launch.ts` | 6.3、6.4、6.7、6.8、6.12、6.14、8.8、10.1、10.2；ADR-0025、0029、0038、0039、0048、0052–0055；T31、T35–T38 |
| 工程质量（Q） | crate 依赖规则；错误类型化；超长文件与函数；定义了却没接线的代码；测试纪律；AGENTS.md 与代码一致；通用能力复用表；平台差异是否收敛在适配层；6.15 的数值与代码常量 | 6.15、7.1、12；`coding-standards.md`、`testing.md`、`claude-md.md` |

汇总时比对了重复：E5 由 E1 的修复一并解决；M10 与已登记的 I157 重复；Q1 的 `runner.rs`、`format.rs` 与 I150 重复（R4 按 I150 拆分）。审查结论来自读源码，审查者没有运行测试；本评审对每条"确认"的发现先写测试复现。

## 6. 逐项核实与处理

编号与位置指审查基线 b91ad7d。修复的每一项都先写失败的测试（输出在 `tmp/evidence/R4/` 的 `*-red.log`），修复后通过（`*-green.log`）。

| 编号 / 维度 | 位置与失败场景 | 核实结论与处理 |
|---|---|---|
| S1 子 agent | `subagents.ts:331`：父会话的中断监听在 `ChildSession.open` 返回后才挂上；打开期间（含 `subagent/start`、worktree 创建、Pi 会话创建）中断，信号已 abort、事件不会再来，子 agent 跑完整个任务，父会话的 `abort()` 一直等 | 确认（单测：打开挂起时中断，修复前子 agent 照常提问）。挂监听后若已 abort 立即停止。172d413 |
| S2 子 agent | `subagent-session.ts:379`：`run` 只在第一个 await 之前检查一次 abort；压缩准备、SubagentStart hooks、memory 准备期间中断，子 agent 仍发出首个请求 | 确认（L2 `subagent-interrupt-starting`：3 s 的 SubagentStart hook 期间中断，修复前子 agent 发了 1 个请求）。首个 `prompt` 之前再检查。172d413 |
| S3 子 agent | `subagents.ts:221`：`#below` 沿正在运行的父链向上找，中间的子 agent 结束后，它派出的后台孙 agent 不在主会话之下：关闭主会话停不了它、它占着并发名额，报告因父会话不在而丢弃 | 确认（单测：中间子 agent 结束后 `abortBelow('main')` 够不到，修复前失败）。运行记录祖先链，`abortBelow` 按祖先判断，报告送到最近仍打开的会话。1d5bc50 |
| S4 子 agent | `tasks/mod.rs:494`、`tool_io/subagents.rs:497`：子 agent 的后台命令的完成通知挂在子会话 id 下，子会话没有会话 actor，永远送不出；子 agent 结束时不关它的任务，Monitor 一直跑到 KillShell、归档或退出 | 确认（两个单测先红）。通知归主会话（任务本就属于主会话，ADR-0049 第 1 条）；结束子 agent 时关闭它的任务（Monitor 停止，后台命令照常）。daf6f72。子 agent 运行期间收不到自己的 Monitor 新行，登记 I168 交 T48 |
| S5–S10 子 agent | `#reopen` 期间结束的后台子 agent 丢报告；子 agent 的 catalog 在会话打开时定；每个子 agent 留一个等连接关闭的任务；空闲时后台子 agent 的写入记在主会话最后一个回合；对已结束子会话作答返回 `sessionNotFound`；注册失败仍发 `subagent/finish` | 确认（读码），都是低风险：S6 并入 I134（T48），其余登记 I167（T48） |
| E1 扩展与信任 | `executables.rs:121,223` 的信任清单只扫工作区根，`skills.rs:165`、`agents.rs:96` 却从会话 cwd 向上加载；worktree 会话的 cwd 在 `.piarc/worktrees/<名称>/`，其中另一分支的 `.claude/skills`（`allowed-tools: Bash(*)`、hooks）与 `.claude/agents`（hooks、内联 MCP）在主工作区受信任时生效，从未经用户确认；根以上目录的文件同样 | 确认（两个 Core 测试先红：worktree 的 skill 得到 `allowed-tools`、worktree 的定义 hooks 生效）。`piarc_config::executables::covered_by_trust` 定义信任覆盖的文件（根自己的资源目录），清单、skill 激活、`agents/list` 的内联 server、定义 hooks 都经它；其他项目文件只作为指令。cff27f0 |
| E2 扩展与信任 | `skills.rs:466` 的读取跟随链接：未受信任的仓库设 `outputStyle`（不是可执行键）指向链接到 `~/.ssh/…` 的风格文件，内容进 system prompt 第 3 段；`SKILL.md`、子 agent 定义同理 | 确认（两个单测先红）。项目来源的文件解析链接后须仍在项目目录内（`stays_in_project`），否则不读并报问题；用户来源不限。c437180 |
| E3 扩展与信任 | `executables.rs:294`：hook 条目名取 `command`/`prompt`/`url` 中第一个出现的字段，`type` 从 `command` 改为 `http` 后条目名不变，再加 `headers` 与 `allowedEnvVars` 也不变，项目保持受信任 | 确认（单测先红）。按 `type` 取实际运行的字段，并带上 `headers`、`allowedEnvVars`、`model`；没有这些字段的 hook 名字不变，升级后不用重新确认。691df8a |
| E4 扩展与信任 | `hooks/mod.rs:567`：`allowedHttpHookUrls`、`httpHookAllowedEnvVars` 按合并层取，项目层能放宽；`http` hook 不做 SSRF 检查 | 不同意改：两者都是 ADR-0055 的决定（Claude Code 语义的跨层合并；SSRF 检查被否决，本机服务是常见用法）。放宽只影响用户已在信任对话框确认过的项目 hook，E3 修复后 `allowedEnvVars` 已进条目名。登记 I169 交 T47（托管配置下只读托管层） |
| E5 扩展与信任 | `policy/hooks.rs:425`：根以上目录的 skill 或定义的 hook 不算项目来源，其 `updatedPermissions` 会写入并确认 | E1 的修复后这类文件的 hooks 不再登记，问题消失 |
| E6 扩展与信任 | `launch.ts:19`：Windows 上 `piarc://open?path=` 接受 UNC 路径，打开前不确认 | 确认（读码），Windows 专属：登记 I170（W3 核对、T45 加确认） |
| E7 扩展与信任 | `config_diagnostics.rs:53`：没有"将要运行什么"的总览 | 同意，属于配置诊断的完善：I171 交 T41 |
| M1 终端安全 | `terminal/bound.rs:392`：`terminal: true` 的命令原样键入交互式 bash；分析器把控制字符当普通字符，`echo ok^Utouch pwned` 判为只读的 `echo` 免审批，键入后 `^U` 擦掉前文、执行 `touch pwned`；裸回车把一条命令变成两条 | 确认（`bash_cases.json` 的 5 个控制字符用例中 4 个修复前为 allow；Core 用例修复前照常键入）。控制字符使 Bash 分析无法判定（询问），Core 拒绝把它们键入终端。30ef685 |
| M2 MCP 安全 | `piarc-policy/rules.rs:286`：规则按 `mcp__<server>` 前缀匹配，server 名可含 `__`：`github__admin` 的工具落在 `mcp__github` 的 allow 规则之下；`a-b` 与 `a_b` 拼成同一工具前缀 | 确认（单测先红）。server 名不得含 `__`，拼成工具名后与先出现的 server 相同的排除并报问题。bca2f81 |
| M3 MCP 安全 | `piarc-fs/access.rs:18`：文件工具的受保护路径没有 `.mcp.json`（沙箱有），Accept edits 下写它不询问 | 确认（单测先红）。加入 `PROTECTED_FILES`。c7297b0 |
| M4 终端安全 | `piarc-term/session/mod.rs:125`：OSC 52 写剪贴板默认允许，模型运行命令的终端也一样，没有提示 | 部分同意：默认允许是架构 6.11 的决定（与 Ghostty、kitty、Windows Terminal 一致），用户终端不改；智能体终端的默认值与写入提示登记 I172 交 T45 |
| M5–M9 安全 | 终端写入与共享的"近期真实输入"按窗口；取消共享与屏幕文件写入的竞态；未共享的终端也保存明文 snapshot；MCP 图片无总量上限、server 的 stderr 进工具错误；stdio server 的后代按关闭时的快照结束 | M5 需要先攻破渲染进程；M6 的竞态窗口很窄、无法稳定复现（修复思路是 `write_view` 与 `remove_view` 共用锁并在重命名前复查）；其余是加固项。合并登记 I172 交 T45 |
| M10 MCP | OAuth 保险箱键只按 server 名 | 与 I157 重复，维持 I157 |
| M11 终端安全 | `vt/effects.rs:197`：查询应答原样写回 PTY，标题报告、DECRQSS、XTGETTCAP 是否回显程序给的文字 | 不成立：实测 libghostty-vt 1.0.1 对 8 种查询的应答都不含程序设定的文字；加回归测试守住（fc41534） |
| Q1 质量 | 9 个文件超过 1,000 行，I105 的"先拆分"约定没有被遵守，也没有工具检查 | 确认。按 I150 拆分 `l2/runner.rs`（868 行）与 `l2/format.rs`（900 行），3c73ec8；其余 7 个登记 I165，指定往里加内容的任务先拆，T44 加行数检查 |
| Q2 质量 | `piarc-config`、`piarc-exec`、`piarc-diff` 没有错误枚举，若干公开函数返回 `String` 或裸 `io::Result` | 确认。登记 I173（T39、T41、T42、T45），I61 并入 |
| Q3 质量 | 平台分支散在 Core 的 exec、policy、hooks 与 `piarc-config/rules.rs`、Agent Host 的路径代码里；`rules.rs` 的 `paths:` 按 `cfg!(windows)` 决定大小写 | 部分同意：命令环境与 shell 选择属于执行适配，收进适配层交 T39；`paths:` 的大小写判据与文件状态表不一致交 T41（I174） |
| Q4 质量 | 原子写入与 `\\?\` 去前缀的重复实现，`bound.rs` 的写入不 fsync | 确认。I175 交 T45 |
| Q5 质量 | 复用表缺 M3 的 git 与 worktree、`TaskLog`、shell integration、终端选区与停拉 | 确认，补 6 行（含 R4 新增的两条规则）。6ae6cc7 |
| Q6 质量 | AHP `exec/background/list`、`read` 与 NAPI `terminalLastCommand` 没有生产调用方；`Session::command` 只在测试用却登在复用表 | 确认。I176 交 T41 决定接线或删除 |
| Q7 质量 | `agent-host/AGENTS.md` 124 行、`apps/desktop/AGENTS.md` 123 行 | 确认。MCP 一节移到新的 `agent-host/src/mcp/AGENTS.md`，打包一节移到 `apps/desktop/src/main/AGENTS.md`，降到 106、116 行。45e932e |
| Q8 质量 | 依赖真实时钟的否定断言（`pointer.rs:271` 等）；终端面板 L4 在 Windows 整体跳过 | 否定断言登记 I176 交 T44；Windows 跳过已由 I163、W3 覆盖 |
| Q9 质量 | 6.15 的工具并发没写 `Agent`；M3 校准的数值没有写回 6.15 | 确认。6.15 补四行并写明 `Agent`（架构 2.48）；M1–M2 的数值与代码一致 |

修复之外的改动：W2 合并后的过期 lint 期望（01e190c）、测量脚本的 MCP 与 skills 负载（26fc9fd、1af9363）、I87 的键表（282beb5）、能力清单（b48a5d7）、架构 2.48（38895b9）、M3 内存报告（687bc80、9b54be7）。

## 7. 质量门禁

- `npm run verify` 在收尾提交 8a1b0cf（工作区干净）15/15 通过：cargo test、Vitest、L2 174 通过 / 0 失败 / 2 平台跳过、能力覆盖 MISSING 0（`tmp/evidence/R4/verify-final.log`）。开工基线在合并提交 b91ad7d 上 13/15，失败的两步是合并产物，见第 3 节。
- 全量 L4（两种形态，代码与 7e6f0b6 相同，`npm run package:desktop -- --flavor development` 后 `npm run test:e2e -w @piarc/desktop`）：281 通过、5 按平台跳过、7 失败（`tmp/evidence/R4/l4.log`）。`t18-review` 两个形态失败于 `screencapture -l`：运行测试的终端没有"屏幕录制"权限，与 R3 相同（`apps/desktop/AGENTS.md`）。另外 5 个是 T37、T38 之后没有更新的用例与一个时序竞态：`t25-hooks` 仍期望 SubagentStop 被列为暂不运行（T38 已运行它）、`t31-subagents` 期望 skills 的警告写 T37（I159 已改为 T48）、`t19-composer` 在 composer 看起来空闲时就读 mock 的最后一个请求，可能早于新回合（与 R3 在 `t26` 遇到的竞态相同，Windows CI 的 I166 ③ 也是它）。前两者改为断言当前行为，后者改为等请求本身（8a1b0cf）；三个文件两种形态 18/18，提及用例重复 5 次两种形态 10/10（`tmp/evidence/R4/l4-rerun.log`）。
- 修复的红绿日志在 `tmp/evidence/R4/`：`s1-s2-*`、`s1-unit-*`、`s3-*`、`s4-*`、`e1-*`、`e2-*`、`e3-*`、`m1-*`、`m2-*`、`m3-*`。
- Windows 交叉 clippy 没有运行：本任务没有改 `cfg(windows)` 代码、平台模块或带 C 代码的依赖（协议的触发条件）；E1 的路径比较与 M1 的终端拒绝在 Windows 上的表现列入 W3 核对项。
- 本任务没有界面改动（渲染进程与主进程源码未改，只改了 L4 用例），也没有改提示词，不需要截图与原创性检查。

## 附录 · 审查原文要点

### 子 agent 与并发（S）

- 发现：S1–S4 中等，S5–S10 低（见第 6 节）。
- 检查过、没有问题：深度与并发计数（`running()` 检查到 `#starting` 自增之间没有 await）；open 失败与 `child.run` 的路径都会释放名额；工具过滤用隐藏声明加 `tool_call` 闸门；Core 侧模式取更严者且每次裁决重取，"本会话允许"存进主会话；前台子会话的 Core 侧中断（`attached()` 含孙级）；Agent Host 崩溃时后台子 agent 记为 interrupted、worktree 结算；`recover()`；任务状态机终态不变；`check_owner`；审批账本 `claim` 在锁内原子移除，第二个窗口得到 `AlreadyHandled`；关闭顺序。
- 未读：`piarc-host` 监管器、`piarc-exec` 的进程树终止、渲染进程的审批 store。

### MCP 与终端安全（M）

- 发现：M1 高（待核实，已核实并修复），M2、M4 中，M3 中低，M5 低中，M6–M10 低，M11 待核实（不成立）。
- 检查过、没有问题：项目 MCP 的信任闸门（未信任时不下发程序、地址与展开值，`.claude/settings` 的 `mcpServers` 不读）；token 只经 `secrets/*`、刷新有锁；`openExternal` 的原生确认；stdio 环境不传 `process.env`；`requiresUserInteraction` 只能更严；读屏的可见性在 Core 实时判断，未共享的用户终端对模型的 list、read、kill 都是 `notFound`；`CLIPBOARD_READ` 默认拒绝；OSC 8 与 URL 要 Mod+点击并经主进程确认；IPC 输入都有边界；server 留在 Agent Host 的进程组。
- 未深入：pi-mcp 对远程 server 发现元数据、重定向与私网地址的限制。

### 扩展加载与信任（E）

- 发现：E1、E2 高，E3、E4 中，E5–E7 低。
- 检查过、没有问题：未信任项目的 skill 不授权、不登记 hooks；`allowed-tools` 的撤回（回合结束、中断、断连、被阻断、排队）与只落在调用所在会话；项目 hook 的 `setMode` 只改本会话、写进 `.piarc/` 的 allow 不确认进快照；项目级定义的 `bypassPermissions`/`auto` 改为 `default`；`.mcp.json` 只在 Core 合并、条目名含 env 与 headers；`!` 命令不执行；信任查询失败一律不信任；worktree 的设置取主工作区；打开时的 git 状态禁用 fsmonitor 与 filter；深度链接不带提示词、不自动信任。

### 工程质量（Q）

- 发现：Q1–Q3 中，Q4 低中，Q5–Q9 低。
- 6.15 核对：M1–M2 的数值（`MAX_BATCH` 10、20K 与 13K、熔断 3、`RESTORE_LIMITS`、50K/200K/2K）与代码一致；`ExecLimits` 与 AGENTS.md 一致。
- 检查过、没有问题：crate 依赖全部符合 `deps-rules.json`（只有登记的两条例外）；9 处 `too_many_lines` 都用带理由的 `#[expect]`；`unsafe` 只在允许的模块；AGENTS.md 点名的标识符都存在；frontmatter 只有一份解析器；桌面主进程的平台以参数注入。
