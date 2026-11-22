# 性能测量

架构第 11 章的预算是发布门槛（NFR-01）。本文说明每项指标怎样自动测量、门禁怎样判定、基线怎样更新，以及 macOS 本机的实测数据。测量框架在 `scripts/perf/`（T44），之前各任务的基准（S1、S2、S7、T14、T18、T19、T20、T35）都作为它的探针运行，口径以本文为准。

## 1. 框架

| 文件 | 作用 |
|---|---|
| `scripts/perf/metrics.mjs` | 指标表：每项指标对应第 11 章的一行（`row`）、预算（按平台不同时是对象）、单位、方向、探针、所在流水线（`pr`、`nightly`、`long`）与回归下限（`floor`）；`EXCLUDED` 写明不测的行与理由 |
| `scripts/perf/chapter11.mjs` | 从架构文档读出第 11 章预算表的各行 |
| `scripts/perf/metrics.test.mjs` | 覆盖检查：第 11 章每一行都要有指标或排除理由，指标的 `row` 也必须仍在表中（Vitest，随 `npm test` 与 verify 运行） |
| `scripts/perf/gate.mjs` | 两道判定（第 2 节）、失败输出、机器类别与基线文件 |
| `scripts/perf/run.mjs` | 入口：按流水线运行探针、取中位数、判定、写报告 `tmp/perf/<lane>/report.json`，更新基线 |
| `scripts/perf/lib.mjs` | 共用的打点与启动工具：mock provider、模型配置、启动打包产物、打开工作区与会话、进程树与内存快照、分位数 |
| `scripts/perf/probe-*.mjs`、`long-run.mjs` | 新增的探针；每个都能单独运行（`--out <file.json>`），输出 `{ values, samples, detail }` |

覆盖检查的效果：临时在第 11 章表中加一行"临时指标（演示）"，`npx vitest run scripts/perf/metrics.test.mjs` 失败并列出 `unmeasured: ['临时指标（演示）']`，撤销后通过（`tmp/evidence/T44/a01-coverage-failure.txt`）。

一次运行的过程：`run.mjs` 选出流水线里的指标，按探针分组；每个探针在独立子进程中运行 N 次（N 在 `run.mjs` 的 `PROBES` 中按流水线设定，`--runs` 可覆盖），每项指标取 N 次结果的中位数（预算本身是分位数的，探针内部先算分位数）。探针失败记为错误，整次运行失败。

测量前固定的环境：只测打包产物（`apps/desktop/out/development/`，`--form dev` 只用于调试探针），不开开发者工具，窗口内容区固定为 1280×800，每个探针先做一次不计入的预热（冷启动除外，它测的就是冷启动）。macOS 上本机运行时记录是否接电源（第 5 节）。

时钟：同一进程内的区间用该进程的单调时钟（`performance.now()`、`Instant`）。跨进程的区间不比较两个进程的时钟：冷启动以渲染进程的打点相对进程启动的时间（`performance.timeOrigin` 起算）为准；Core 事件到渲染进程只计主进程转发这一段（主进程内的单调时钟，S2 的口径）；首 token 额外延迟在渲染进程内从调用 `prompt` 计到回复文字上屏，对照组在同一个 Node 进程内计时。两侧都在同一台机器上、同一个 mock 下测量，差值不含时钟偏差。

## 2. 门禁

每个值经两道判定（`gate.mjs` 的 `judge`）：

1. **绝对预算**：带 `--absolute` 时比较第 11 章的预算（按平台取值）。第 11 章的预算以基准机型为准，托管 CI runner 不是基准机型，所以 CI 不加 `--absolute`；达标结论来自基准机或注明配置的本机实测（第 5 节）。
2. **相对基线**：与同平台、同机器类别的基线比较，变差超过 10% **且**超过该指标的 `floor` 就失败。`floor` 是该单位下有意义的最小变化（例如 AHP 往返 0.1 ms、冷启动 30 ms），避免接近 0 的值上 10% 只反映噪声。没有基线时只记录。

失败时的输出写明指标、当前值（几次运行的中位数）、预算与基线，退出码为 1，例如（第 5.5 节的演示）：

```
FAIL over budget — core-to-renderer-p95: current 2.62 ms (median of 1 runs), budget 1.10 ms, baseline 0.72 ms
FAIL regressed more than 10% — core-to-renderer-p95: current 2.62 ms (median of 1 runs), budget 1.10 ms, baseline 0.72 ms
```

### 2.1 机器类别与基线

基线按平台、机器类别与流水线分文件存放：`scripts/perf/baselines/<platform>-<machine>-<lane>.json`（PR 冒烟的负载比 Nightly 短，两者的值不能互比）。机器类别取 `--machine`，否则取环境变量 `PIARC_PERF_MACHINE`，CI 上默认 `github-<arch>`，本机默认 `local`。同一类别的机器才能互相比较，换了机器就换一个类别名。

基线只经显式命令更新，并在提交说明中写明原因：

```sh
# 在本机测量并记为基线（原因写进文件）
node scripts/perf/run.mjs --lane nightly --absolute --machine m1-max-32g --update-baseline "T44: first local baseline"
# 用 CI 的报告（Nightly 作业上传的 perf-nightly-<os> 工件）记录该 runner 类别的基线
node scripts/perf/run.mjs --lane nightly --from-report <下载的 report.json> --machine github-arm64 --update-baseline "<原因>"
git add scripts/perf/baselines && git commit -m "perf: update the <machine> baseline (<原因>)"
```

`--from-report` 不测量，只判定（或记录）另一台机器写的报告，预算与基线文件按报告里的平台选。只更新这次测到的指标，其余指标的旧基线保留。

纪律：

- 性能确实因有意的改动变差时，先确认没有更好的做法，再更新基线，提交说明写清楚原因与新旧值；不要为了让检查通过而更新基线。
- 优化后数值明显变好时也更新基线，否则后续回归要累积超过 10% 才会被发现。
- 第 11 章的预算只能收紧；放宽属于变更型决策（ADR）。

## 3. 流水线

| 流水线 | 在哪里运行 | 内容 | 命令 |
|---|---|---|---|
| PR 冒烟 | `ci.yml` 的 desktop 作业（macOS 与 Windows，打包开发构建之后） | 标 `pr` 的 10 项，较短的负载，每个探针运行 3 次取中位数；只做回归判定 | `node scripts/perf/run.mjs --lane pr --runs 3` |
| Nightly | `perf-nightly.yml`（每天北京时间 03:00，macOS 与 Windows） | 除长跑外的全部指标；另打发布安装包测体积；之后运行缩短版长跑（1 小时） | `node scripts/perf/run.mjs --lane nightly`，`PIARC_LONG_RUN_HOURS=1 node scripts/perf/run.mjs --lane long` |
| 长跑 | 本机或自托管 runner | 8 小时长会话的内存增长 | `node scripts/perf/run.mjs --lane long --absolute` |

两个工作流都上传 `tmp/perf/` 下的报告。托管 runner 单个 job 最长 6 小时，Nightly 作业的上限设为 240 分钟（完整测量约 1 小时、缩短版长跑 1 小时、打包约半小时），8 小时长跑放不进托管 runner。`scripts/perf/workflows.test.mjs` 解析两个工作流，核对上述步骤与命令。

噪声：PR 冒烟在同一提交上连续运行 5 次全部通过之后才接入（第 5.3 节）。噪声大的指标（内存、空闲 CPU、首 token、恢复、滚动帧率）只放 Nightly。

## 4. 指标与测量方法

"探针"一列是 `metrics.mjs` 的 `probe`；"PR"一列标出进入 PR 冒烟的项（PR 中的负载较短，见"方法"）。

| 第 11 章的行 | 指标 | 探针与复用的代码 | 方法与口径 | PR |
|---|---|---|---|---|
| 冷启动到可交互窗口 | `cold-start` | `cold-start`：T18 `scripts/bench/t18-cold-start.mjs` | 数据目录有 100 个会话；Playwright 启动打包产物，到渲染进程打点 `piarc:sidebar-ready`（Core 的会话列表上屏）；T18 的 10 次取中位数 | 是 |
| 打开工作区到 Agent Host 就绪 | `workspace-ready` | `workspace`：T14 `t14-warmup` 示例（release 构建） | Core 的 `open_workspace` 到 Agent Host 握手完成并恢复一个有历史的会话；10 次取中位数 | 是 |
| PiArc 引入的首 token 额外延迟 | `first-token-overhead` | `probe-first-token.mjs` | 同一个严格 mock（立即作答）：应用内从 `window.piarc.prompt()` 到回复的文字上屏，减去同一进程内直接用 Pi SDK（`createAgentSession`，内存会话、无工具）从 `prompt()` 到首个 `text_delta`；各 20 次（预热 1 次）取中位数之差。应用一侧多算了一次 React 提交与绘制 | 否 |
| 主进程内存（含 Core，空闲） | `main-memory-delta` | `event-channel`：S2 `bench:s2` 的空闲测量 | 不连调试器启动打包产物（空数据目录），静置 10 s 后 5 次采样主进程 RSS 的中位数，减去同机同轮裸 Electron（一个空窗口）的同一测量 | 否 |
| 渲染进程内存 | `renderer-memory` | `probe-memory.mjs`（T18 的会话夹具） | 侧栏 100 个会话、打开其中 1,000 条 item 的会话；渲染进程 GC（CDP）后静置，`getAppMetrics()` 的工作集 | 否 |
| 应用全部进程合计 | `app-memory` | 同上 | 同一夹具下 `getAppMetrics()` 全部进程工作集之和（不含 Agent Host）；macOS 另在报告的 `detail.footprintMB` 记各进程的物理占用（`footprint`），仅供参考（I26） | 否 |
| Agent Host 内存 | `agent-host-memory` | `probe-sessions.mjs`（T35 `m3-memory.mjs` 的打点） | 1 个会话持续运行 mock 回合时 Agent Host 的 RSS（`ps` / CIM） | 否 |
| 每增加一个活动会话的内存增量 | `agent-host-per-session` | 同上 | 每个会话数各起一个新应用（避免 GC 顺序的影响），3 个会话时与 1 个会话时 Agent Host RSS 之差除以 2 | 否 |
| 8 小时长会话内存增长 | `long-run-growth-{main,renderer,agent-host}` | `long-run.mjs` | 第 4.1 节 | 否 |
| 流式渲染（100 token/s） | `stream-frame-p99`、`stream-long-tasks` | `transcript`：T19 `e2e/t19.bench.ts`（CDP 追踪，S1 第 2 节的口径） | 真实链路 + mock 以 100 token/s 流式输出 60 s（PR 15 s，`PIARC_BENCH_SCALE=0.25`）；相邻两次 `BeginMainThreadFrame` 之间主线程任务总耗时的 p99，与超过 50 ms 的任务数 | 是 |
| 万条 item 的 transcript 滚动 | `scroll-fps` | 同上 | 1 万条 item，以 3,000 px/s 脚本化滚动，每秒动画帧数（取整，屏幕刷新率 60 Hz 时上限 60） | 否 |
| 会话切换 | `switch-cached`、`switch-cold` | 同上 | 点击到可见行绘制完成（`requestAnimationFrame` 之后的打点）；已缓存的会话与未加载的 1,000 条会话各 5 次取最大值 | 是 |
| 主进程事件循环延迟 | `main-loop-p99` | `probe-sessions.mjs` | 3 个会话同时流式输出与调用工具时，主进程 `monitorEventLoopDelay`（1 ms 分辨率）的 p99；Windows 上减去同轮空闲的 p99（计时器粒度，第 11 章） | 是 |
| Core 事件到渲染进程 | `core-to-renderer-p95` | `event-channel`：S2 `bench:s2` | 每分钟 10 万事件下主进程每次投递的转发耗时 p95 | 是 |
| AHP 往返（小文件 fs 操作） | `ahp-round-trip-p95` | `ahp`：契约测试 `ahp_round_trip` | Core 与真实 Agent Host 客户端之间 4 KB 文件 `fs/read` 的往返 p95 | 是 |
| 无需用户参与的权限裁决 | `policy-decision-p95` | `policy`：`tool_io::policy::tests::automatic_decision_latency`（release） | 代表性规则集与 Bash 命令集 1,000 次 `policy/evaluate` 的 p95（含路径、配置、信任与 SQLite 审计） | 是 |
| 终端键入回显的额外延迟 | `terminal-echo-p95` | `terminal`：S7 `bench:s7` | 完整路径（渲染进程键入到屏幕帧）p95 减去直接写 PTY 的 p95，各 ≥ 200 对 | 否 |
| 安装包体积 | `installer-size` | `probe-size.mjs` | 发布构建的 macOS arm64 DMG / Windows x64 Velopack `Setup.exe`；MB = 10^6 字节 | 否 |
| 安装后体积 | `installed-size` | 同上 | `.app` 目录 / 打包后的应用目录（Velopack 安装的就是它），逐文件求和、不跟随链接 | 否 |
| 空闲 CPU | `idle-cpu-visible`、`idle-cpu-hidden`、`hidden-frames` | `probe-idle.mjs` | 会话打开、终端面板显示 shell、什么都不运行；窗口可见与隐藏各 60 s，全部应用进程（`getAppMetrics().cpu.cumulativeCPUUsage`）加 Agent Host（`ps` / CIM）的 CPU 时间之和，折合一个核心的百分比；隐藏期间页面 `requestAnimationFrame` 回调数与终端面板收到的帧数之和 | 否 |
| Agent Host 崩溃后恢复 | `agent-host-recovery` | `probe-recovery.mjs` | 回合空闲时杀 Agent Host 进程，到同一会话对新提示作答（回复上屏） | 否 |
| 渲染进程崩溃或重载后恢复 | `renderer-recovery` | 同上 | mock 回合流式输出中重载页面，到新文档里的 transcript 可见；同时核对回合继续、mock 收到的请求数不变（会话不中断）。渲染进程崩溃（`forcefullyCrashRenderer`）由主进程自动重载（每分钟最多 3 次），同样计时，记在报告 `detail` 中 | 否 |
| Beta 期无崩溃会话率 | —（`EXCLUDED`） | — | 依赖 Beta 期用户同意后的崩溃统计，不进 CI，由 T51、R6 跟踪 | — |

### 4.1 长跑

`scripts/perf/long-run.mjs`：一个窗口、一个会话，`acceptEdits` 模式。每 30 s 发一个提示，mock 的这个回合先读文件、写文件、启动一个后台命令，再流式回答；同时在会话的终端里键入一条输出命令。前 30 分钟预热，之后每 10 分钟采样主进程、渲染进程（`getAppMetrics()`）与 Agent Host（RSS）的内存；增长率 =（最后一次采样 − 稳态第一次采样）/ 稳态第一次采样，三者分别判定 ≤ 10%。采样边测边写入输出文件，中途中断也留有数据。

Nightly 运行 1 小时的缩短版（`PIARC_LONG_RUN_HOURS=1`：预热 10 分钟、每 5 分钟采样），只做趋势监控。

## 5. macOS 实测

### 5.1 环境

| 项 | 值 |
|---|---|
| 机型 | MacBook Pro（MacBookPro18,2），Apple M1 Max，32 GB；**不是**第 11 章的基准机型（M1 Pro / 16 GB），结论按"注明配置的本机"记 |
| 系统 | macOS 26.5.2（25F84） |
| 电源 | 接电源充电（测量开始时电量 43%，`pmset -g batt` 记在 `tmp/evidence/T44/nightly-local.txt` 第一行），省电模式关闭 |
| 显示器 | 60 Hz（滚动帧率的上限即 60 fps） |
| 构建 | 打包的开发构建（`apps/desktop/out/development/`）；体积量发布构建；工作区就绪与权限裁决的 Core 测量用 release 构建 |
| 机器类别 | `m1-max-32g`；基线 `scripts/perf/baselines/darwin-m1-max-32g-{nightly,pr}.json` |
| 日期 | 2026-11-21（Nightly）、2026-11-22（PR 冒烟、长跑、体积复测） |

### 5.2 Nightly 全部指标

命令：`node scripts/perf/run.mjs --lane nightly --absolute --machine m1-max-32g`（报告 `tmp/evidence/T44/nightly-report.json`）。"次数"是该探针的运行次数，值是各次的中位数。

| 第 11 章的行 | 指标 | 实测 | 预算 | 次数 | 结论 |
|---|---|---|---|---|---|
| 冷启动到可交互窗口 | `cold-start` | 440 ms | ≤ 1,000 ms | 1（每次内含 10 次启动，取中位） | 达标 |
| 打开工作区到 Agent Host 就绪 | `workspace-ready` | 955 ms | ≤ 1,000 ms | 1（10 次中位） | 达标，余量 4%（I193） |
| PiArc 引入的首 token 额外延迟 | `first-token-overhead` | 24.3 ms（PiArc 26.1 ms，Pi SDK 1.8 ms） | ≤ 50 ms | 1（各 20 次） | 达标 |
| 主进程内存（含 Core，空闲） | `main-memory-delta` | 32.5 MB（主进程 186 MiB，裸 Electron 155 MiB） | ≤ 24 MB | 1（各 5 次采样） | **超出**（I192） |
| 渲染进程内存 | `renderer-memory` | 173 MB | ≤ 220 MB | 3 | 达标 |
| 应用全部进程合计 | `app-memory` | 519 MB（主进程 210、渲染 173、GPU 86、网络 50）；物理占用合计 207 MB | ≤ 510 MB | 3 | **超出**（I26） |
| Agent Host 内存 | `agent-host-memory` | 202 MB | ≤ 150 MB | 3 | **超出**（I194） |
| 每增加一个活动会话的内存增量 | `agent-host-per-session` | 10.5 MB | ≤ 40 MB | 3 | 达标 |
| 主进程事件循环延迟 | `main-loop-p99` | 2.7 ms | ≤ 16 ms | 3 | 达标 |
| 流式渲染（100 token/s） | `stream-frame-p99`、`stream-long-tasks` | p99 16.4 ms，长任务 0 | ≤ 12 ms，0 | 1 | **帧工作超出**（I191），长任务达标 |
| 万条 item 的 transcript 滚动 | `scroll-fps` | 60.0 fps | 60 fps | 1 | 达标 |
| 会话切换 | `switch-cached`、`switch-cold` | 28.8 ms、62.1 ms（各 5 次最大） | ≤ 100 ms、≤ 170 ms | 1 | 达标 |
| Core 事件到渲染进程 | `core-to-renderer-p95` | 0.22 ms | ≤ 1.1 ms | 1 | 达标 |
| AHP 往返 | `ahp-round-trip-p95` | 0.25 ms | ≤ 5 ms | 3 | 达标 |
| 无需用户参与的权限裁决 | `policy-decision-p95` | 0.69 ms | ≤ 2 ms | 3 | 达标 |
| 终端键入回显的额外延迟 | `terminal-echo-p95` | 0.67 ms | ≤ 5 ms | 1 | 达标 |
| 安装包体积 | `installer-size` | 176.2 MB（裁剪前 180.5 MB） | ≤ 200 MB | 1 | 达标 |
| 安装后体积 | `installed-size` | 446.6 MB（裁剪前 466.3 MB） | ≤ 450 MB | 1 | 达标（裁剪后，I41） |
| 空闲 CPU | `idle-cpu-visible`、`idle-cpu-hidden`、`hidden-frames` | 3.6%、3.5%、0 | ≤ 5%、≤ 5%、0 | 1 | 达标（I190） |
| Agent Host 崩溃后恢复 | `agent-host-recovery` | 1.44 s | ≤ 3 s | 3 | 达标 |
| 渲染进程崩溃或重载后恢复 | `renderer-recovery` | 0.22 s（重载），0.21 s（崩溃） | ≤ 2 s，会话不中断 | 3 | 达标（I189） |
| 8 小时长会话内存增长 | `long-run-growth-*` | 未测（第 5.4 节） | ≤ 10% | — | 未测（I195） |
| Beta 期无崩溃会话率 | — | 不测（`EXCLUDED`） | ≥ 99.5% | — | T51、R6 |

说明：

- 空闲 CPU 按进程：可见时 GPU 1.68%、渲染 1.49%、主进程 0.25%、Agent Host 0.18%；隐藏时 GPU 1.83%、渲染 1.48%、主进程 0.16%、Agent Host 0.02%。隐藏 60 s 内页面 rAF 回调 0 次、终端帧 0 帧。阈值 5% 依据这组实测定出，写入第 11 章（v2.55）。
- 流式帧的回归：同一测量在 T19（2026-11-18）为 p99 8.8 ms、T20 为 7.3 ms；PR 冒烟的 15 s 版为 9.7–9.9 ms，60 s 版为 16.4 ms，回复越长每帧工作越多。定位过程与结论见 I191。
- 内存一行的口径：RSS 把各进程映射的同一份 Electron 框架页各算一次；物理占用（`footprint`）作为参考记在报告里，口径不变（I26）。
- 首 token：mock 立即作答，应用一侧多了 Core、Agent Host、主进程转发与渲染进程的一次提交与绘制。

### 5.3 PR 冒烟的稳定性

<!-- 由 T44 填写 -->

### 5.4 长跑

本机 8 小时长跑没有做：用户于 2026-11-22 决定去除 T44 的这一验收项。长跑的负载、采样与判定已实现（第 4.1 节），Nightly 每天在两个平台跑 1 小时的缩短版做趋势监控；完整的 8 小时由 I195 跟踪，发布前补跑，结果写在这里。

### 5.5 回归门禁的演示

临时在主进程事件转发路径（`EventRouter.forward`，`apps/desktop/src/main/core/router.ts`）加 2 ms 忙等并重新打开发包，运行 `node scripts/perf/run.mjs --lane pr --only core-to-renderer-p95 --runs 1 --absolute --machine m1-max-32g`：

```
✗ core-to-renderer-p95           2.62 ms      1.10        0.72  1
FAIL over budget — core-to-renderer-p95: current 2.62 ms (median of 1 runs), budget 1.10 ms, baseline 0.72 ms
FAIL regressed more than 10% — core-to-renderer-p95: current 2.62 ms (median of 1 runs), budget 1.10 ms, baseline 0.72 ms
```

退出码 1。撤销修改、重新打包后同一命令为 0.49 ms，通过（`tmp/evidence/T44/a03-regression-failure.txt`、`a03-after-revert.txt`）。

## 6. Windows

Windows 基准机（x64 8 核 / 16 GB / NVMe SSD、Windows 11）上的实测由 W3 用同一套脚本补齐：

```sh
node scripts/perf/run.mjs --lane nightly --absolute --machine <机器类别>
node scripts/perf/run.mjs --lane long --absolute --machine <机器类别>
```

已知的平台差异：事件循环延迟按"满载 p99 − 同轮空闲 p99"（计时器粒度约 15.6 ms）；AHP 往返与权限裁决的预算是 15 ms 与 10 ms（ADR-0040、ADR-0041）；应用全部进程合计的预算是 450 MB；进程 CPU 时间与 RSS 经 CIM（`Win32_Process`）读取；安装包是 Velopack 的 `Setup.exe`（需要 .NET SDK，`scripts/release/pack-windows.mjs`），安装后体积量打包后的应用目录。
