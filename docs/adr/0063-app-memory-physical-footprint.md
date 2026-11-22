# 0063. "应用全部进程合计"按物理占用测量

- 状态：提议
- 日期：2026-11-22
- 修订：架构第 11 章"应用全部进程合计（不含 Agent Host，1 窗口）"一行的测量口径，以及第 16 章 M3 退出标准（"3 个并行会话 + 子 agent 场景满足第 11 章内存预算"）中这一行的读法
- 相关：I26、I146、I201；[R4 评审](../reviews/R4-findings.md)第 1 节、[M3 内存](../perf/M3-memory.md)、[性能测量](../engineering/performance.md)第 5.2、6.1 节、[W3 报告](../reviews/W3-windows-m3-parity.md)第 4 节；R5

## 背景

第 11 章的"应用全部进程合计"一行按 RSS 相加（主进程、渲染进程、GPU 与网络等辅助进程），预算 macOS ≤ 510 MB、Windows ≤ 450 MB。这一行从 M0 起在两个平台都超出，是 M3 与 M4 退出判定里唯一的口径问题：

| 测量 | RSS 合计 | 物理占用合计 | 来源 |
|---|---|---|---|
| macOS 空闲（打开工作区、没有会话） | 约 511 MB | 约 141 MB | R4 第 1 节 |
| macOS Nightly（侧栏 100 个会话、打开 1,000 条） | 519 MB | 207 MB | T44，`performance.md` 5.2 |
| macOS 3 会话 + 子 agent + 共享 MCP | 577–580 MB | 约 250 MB（最大 298） | R4 第 1 节 |
| Windows 3 会话 + 子 agent + 共享 MCP | 563–576 MB | 256 MB（私有工作集） | W3 第 4 节 |
| Windows Nightly | 558 MB | 未取 | `performance.md` 6.1 |

- macOS 用 `footprint`（内核的 `phys_footprint`），Windows 用性能计数器的 `WorkingSetPrivate`。两者只计进程独占的物理页（含压缩），不计各进程映射的同一份共享代码页。
- R4 用 `vmmap` 看空闲主进程：RSS 190 MB 中脏页只有 57 MB，其余是 Electron 与系统框架的代码页。每个 Chromium 进程都映射同一份 Electron Framework，RSS 相加把它算了四次。
- 超出的主体在没有会话时就存在：会话与负载只增加约 60 MB（主要是渲染进程）。R4、T44 都没有找到能把 RSS 合计降到 510 MB 以下的单点：常驻量来自 Electron 与 Chromium 的进程模型（主进程、渲染进程、GPU 进程、网络服务进程）。
- 第 11 章规定预算只能收紧，放宽须在修订记录中写明原因；改变口径等于放宽，所以 R4、T44、W3 都没有改，交用户决定（I26）。

## 决策

1. "应用全部进程合计"一行改为**各进程物理占用之和**：macOS 为 `phys_footprint`（`footprint` 工具或 `task_info(TASK_VM_INFO)`），Windows 为私有工作集（`Win32_PerfFormattedData_PerfProc_Process.WorkingSetPrivate`）。进程范围不变：主进程、渲染进程、GPU 与其他辅助进程，不含 Agent Host。
2. 预算数值不变：macOS ≤ 510 MB、Windows ≤ 450 MB。按第 11 章的收紧规则（两个平台都有有效实测、原预算不低于较差值的 2 倍时才收紧），新口径下的较差值是 298 MB 与 256 MB，2 倍为 600 与 520 MB，都高于现有预算，所以不收紧。
3. RSS 合计照常测量、写进 Nightly 报告（`scripts/perf/probe-memory.mjs` 已有 `detail.footprintMB`，W3 的私有工作集读法并入同一探针），作为回归趋势的参考，不作为预算判定。
4. 其他内存行不改口径：主进程（相对裸 Electron 的增量）、渲染进程、Agent Host 与每会话增量仍按 RSS。这些行的超出（I192 主进程增量 32.5 MB、I194 Agent Host 202 MB）不是口径问题，按优化处理。
5. 第 11 章修订记录写明：这是放宽（RSS → 物理占用），原因是 RSS 合计重复计入共享框架页、不反映应用给系统增加的内存压力，以及上表的两平台数据。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| A. 改为物理占用，预算数值不变（本决策） | 反映应用独占的内存，两个平台口径一致；按收紧规则仍留余量 | 是放宽：同一程序在新口径下读数约为旧口径的 40–50% | 推荐 |
| B. 维持 RSS，靠优化降到预算内 | 不改标准 | 空闲基线已超出；超出来自 Chromium 的多进程与共享框架页，关掉硬件加速（去掉 GPU 进程）会损失渲染性能，合并进程不受应用控制；R4、T44 都没找到可行的单点 | 不采纳：不可行，M3、M4 会一直无法判定 |
| C. 维持 RSS，把预算提高到 650 MB | 口径不变 | 放宽的幅度一样大，而数值仍包含重复计入，回归信号被共享页的波动淹没 | 不采纳 |
| D. 改用 PSS（按共享进程数分摊） | 比物理占用更接近"公平份额" | macOS 与 Windows 都没有现成的 PSS；要自己枚举映射并分摊，测量本身成本高 | 不采纳 |

## 后果

- 正面：M3 的内存退出标准在两个平台按同一口径判定（以上表数据，macOS 约 250–298 MB、Windows 256 MB，达标）；M4 退出判定里这一行不再是阻塞项；Nightly 的 `app-memory` 判定有了稳定的口径。
- 负面与代价：标准变宽。若之后某个改动大量增加共享映射（例如加载更大的原生库），新口径看不到 RSS 的增长：Nightly 继续记录 RSS 合计作为参考，回归超过 10% 时人工复核。
- 需要配套做的事（采纳后）：
  - `scripts/perf/metrics.mjs` 的 `app-memory` 改读物理占用（macOS `footprint`、Windows 私有工作集），RSS 合计改为 `detail`；`m3-memory.mjs` 同样；重测两个平台并按 `--update-baseline` 记录基线（原因写本 ADR）。
  - 架构第 11 章这一行与修订记录、第 16 章 M3 状态；`performance.md` 第 4、5、6 节；`docs/perf/M3-memory.md`。
  - T35-A11、R4-A01、R4-A03、W3-A01 由用户按新口径的测量决定是否关闭（验收项的描述写的是"第 11 章内存预算"，口径随第 11 章）。

## 重新评估的触发条件

出现以下任一情况时复核本决策：

- 物理占用合计超过预算的 80%（macOS 408 MB、Windows 360 MB）。
- RSS 合计与物理占用合计的比值明显变化（例如 Electron 升级后共享页的计入方式改变），两者的差不再主要是共享框架页。
- 有了基准机型（M1 Pro / 16 GB、x64 8 核 / 16 GB）的两平台数据，可以按收紧规则重新校准。
