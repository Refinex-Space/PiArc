# S2 NAPI-RS Core 接入主进程

- 任务：T04（2026-11-14 至 11-15）
- 范围：Core 以 NAPI-RS 原生模块加载在 Electron 主进程，事件经 `ThreadsafeFunction` 合并后送到主进程，再按路由键经 MessagePort 转发到渲染进程；四个目标的预编译与加载。
- 结论：macOS **通过**。S2 的三条标准（10 万事件/分钟下无丢失、主进程事件循环延迟 p99 ≤ 16 ms、预编译产物可加载）在 macOS 上全部达标，darwin-arm64 与 darwin-x64 都能加载。另有两点：
  1. "超过阈值的批次用 `ArrayBuffer` 转移所有权"在 Electron 45 上做不到（`MessagePortMain` 只能转移端口）。[ADR-0019](../adr/0019-event-batches-copied-not-transferred.md) 已接受：批次一律复制转发，实测代价很小（第 4.3 节）。
  2. 主进程空闲 RSS 160–164 MB，超出第 11 章 120 MB 的初始预算（不属于 S2 的通过标准），但其中约 155 MB 是不加载 Core 的裸 Electron 自身，Core 与应用代码只占约 5–8 MB。预算由 R1 校准（登记事项 I12）。

  Windows（W0）**有条件通过**：win32-x64 与 win32-arm64 都能加载（CI `core-load`，arm64 为 GitHub 的 arm64 Windows 11 runner），实机基准无丢失、无乱序，同步调用 p99 0.008 ms，空闲主进程 108.4 MB。主进程事件循环延迟按原始值 p99 16.81 ms，超出 16 ms：Windows 的计时器粒度约 15.6 ms，同一台机器上空闲的 Node 就是 p50 15.56 ms、p99 16.58 ms，满载只多 0.23 ms。Core 没有造成可见的阻塞，ADR-0014 的触发条件不成立；Windows 上这项指标的测量口径交 R1 校准（第 8 节）。

## 1. 验证环境

| 项 | 版本 |
|---|---|
| 机器 | Apple M1 Max，10 核，32 GB；macOS 26.5.2（25F84），arm64；Rosetta 2 已安装 |
| Electron | 45.3.2，Chromium 156.0.8078.100，内置 Node 24.22.2 |
| Rust | 1.99.1（`rust-toolchain.toml`）；目标 `aarch64-apple-darwin`、`x86_64-apple-darwin` |
| NAPI-RS | `napi` 3.16.2（features `napi6`、`serde-json`，默认的 `dyn-symbols`），`napi-derive` 3.7.1，`napi-build` 2.6.0，`@napi-rs/cli` 3.10.12 |
| tokio | 1.54.1（`rt-multi-thread`、`sync`、`time`、`macros`），`tokio-util` 0.7.20 |
| 本机 Node | 24.14.1（脚本、Vitest 与 Node 宿主的加载检查） |

## 2. 做了什么

- `piarc-core`：tokio 多线程运行时、有界事件队列、事件合并器、有序关闭、任务监督（panic 转 `core/errors` 错误事件）、演示事件源。规则写在 crate 文档与 `crates/piarc-core/CLAUDE.md`。
- `piarc-napi`：`CoreRuntime.create(options, onEvents)`、`shutdown()`、`state`；`onEvents` 是强引用的 `ThreadsafeFunction`；每个导出都经 panic 边界，错误抛成带 `code`、`data.kind`、`data.retryable` 的 `Error`。`testing` feature（只在开发构建中）导出演示事件源、同步轻量方法 `echo`、计数与两个 panic 触发器。
- 主进程：`native-path.ts` 统一解析 `.node` 路径（源码树为 `target/piarc-core/development/`，打包后为 `app.asar.unpacked/native/`），窗口打开前启动 Core，`will-quit` 时等 `shutdown()` 完成再退出；`EventRouter` 维护路由键 → 窗口表，每个页面加载一个 `MessageChannelMain`。
- preload：`subscribeEvents(route, listener)`、`unsubscribeEvents(route)`，回调只收到批次。渲染进程 `#/event-probe` 测试页计数并校验批次与事件序号。
- 测试：Rust 集成测试（`crates/piarc-core/tests/event_channel.rs`）；Vitest 集成测试在 Node 中加载真实 `.node` 跑事件通道（verify 中的短时正确性版本）；L4 两种形态各 6 个用例（`e2e/core-events.e2e.ts`）。
- 预编译：`scripts/dev/build-core.mjs` 用 `@napi-rs/cli` 构建；CI `core-build` 构建四个目标的开发与发布两种模块，`core-load` 在四种原生 runner 上用 `scripts/ci/load-core.mjs` 在 Node 与 Electron 中加载并跑一次事件通道。
- 基准：`npm run bench:s2`（`scripts/bench/s2-event-channel.mjs`）。

## 3. 方法

- 形态：开发构建的打包产物（`out/development/`，带 Core 开发版），由 Playwright 驱动；空闲内存一项改为不经 Playwright 直接启动（不挂调试器），用 `ps` 读主进程 RSS，并以同一个 Electron 打开一个空窗口的裸应用作对照。
- 吞吐：演示事件源以 100,000/60 个/秒发 500,000 个事件（5 分钟，每个事件约 200 字节），探针窗口订阅该路由，计数并逐个核对批次序号与事件序号。
- 主进程事件循环延迟：`monitorEventLoopDelay({ resolution: 1 })`，覆盖整个吞吐阶段。该直方图记录的是两次采样之间的完整间隔，每个值都包含 1 ms 的采样间隔；下文给出原始值，与预算比较时也用原始值（偏保守）。
- 同步调用：主进程内连续调用 `echo` 10,000 次（先预热 1,000 次），`performance.now()` 计每次耗时。
- 转发耗时：主进程 `EventRouter.forward` 从收到 Core 的一次投递到向所有订阅窗口发完消息的时间（含结构化克隆）。
- 大批次：每个事件的 `pad` 为 1、4、8 MiB，每秒 5 个、共 15 个，每批一个事件。

## 4. 实测数据

### 4.1 吞吐与正确性（10 万事件/分钟 × 5 分钟）

证据：`tmp/evidence/T04/bench/s2-packaged-2026-11-15T07-56-50-894Z.json`。

| 指标 | 结果 | 标准 |
|---|---|---|
| 发出 / 收到事件 | 500,000 / 500,000 | 相等 |
| 批次序号错误 / 事件序号错误 / 无法解析的批次 | 0 / 0 / 0 | 0 |
| Core 侧丢弃（`lost`） | 0 | 0 |
| 回调次数 | 17,029 次，300.7 s，56.6 次/秒 | ≤ 1000/16 × 110% = 68.75 次/秒 |
| 平均每批事件数 | 29.4 | > 1 |
| 主进程事件循环延迟 | p50 1.23 ms，p99 3.58 ms，max 38.0 ms（224,504 个样本） | p99 ≤ 16 ms |
| 主进程转发每次投递 | p50 0.094 ms，p95 0.503 ms，p99 0.828 ms，max 6.49 ms | 第 11 章 p95 ≤ 5 ms |

max 38 ms 是 5 分钟内的单次尖峰，p99 远低于预算。

压测：同样的方法以 10 倍速率（100 万事件/分钟）跑 1 分钟（证据：`tmp/evidence/T04/bench/s2-packaged-stress-1m-per-min.json`）。发出与收到都是 1,000,000，序号错误 0；回调仍是 56.6 次/秒，平均每批 293.8 个事件；事件循环延迟 p50 1.23 ms、p99 4.10 ms、max 45.9 ms；每次转发 p95 0.56 ms、p99 1.44 ms。合并器把增加的负载放进了更大的批次，回调频率不变。

### 4.2 同步 NAPI 调用（`echo`，10,000 次）

| p50 | p95 | p99 | max | 标准 |
|---|---|---|---|---|
| 0.001 ms | 0.002 ms | 0.005 ms | 0.086 ms | p99 ≤ 1 ms |

### 4.3 大批次（结构化克隆转发）

| 批次大小 | 批次数 | 转发 p50 | 转发 max | 同期事件循环延迟 p99 / max |
|---|---|---|---|---|
| 1 MiB | 15 | 0.67 ms | 4.81 ms | 3.38 ms / 8.25 ms |
| 4 MiB | 15 | 1.68 ms | 2.29 ms | 3.16 ms / 7.38 ms |
| 8 MiB | 15 | 1.96 ms | 3.03 ms | 3.09 ms / 6.17 ms |

`ArrayBuffer` 转移在 Electron 45 主进程中不可用（第 5 节），所以没有"转移阈值"：所有批次都复制转发。上表说明复制的代价在 8 MiB 时仍只有约 2 ms。

### 4.4 主进程内存

| 进程 | 空闲 RSS（中位数） |
|---|---|
| PiArc 打包产物（含 Core，一个窗口） | 160.0 MB（5 分钟基准）；163–164 MB（手动复测 4 次） |
| 裸 Electron 45.3.2（一个空窗口，不加载 Core） | 155.3 MB、156.6 MB（两次基准） |
| 差值（Core + 应用主进程代码） | 约 5–8 MB |

压测那一轮基准读到 187.8 MB，随后用同样的方式手动复测 4 次都是 163–164 MB，没有复现，按离群值记录。

另用一个最小 Electron 应用分步测量：一个窗口 156.7 MB → 加载 Core 并创建运行时 158.3 MB → 以 10 万事件/分钟跑 10 秒后 162.0 MB。Core 空闲时约占 1.5–2 MB，跑过事件流后分配器高水位再多约 4 MB。第 11 章"主进程内存（含 Core，空闲）≤ 120 MB"在 macOS 上低于 Electron 自身的基线，需要校准（I12）。

### 4.5 四个目标的构建与加载

| 目标 | 构建 | 加载 | 证据 |
|---|---|---|---|
| darwin-arm64 | 本机 `@napi-rs/cli` 构建通过；CI `core-build` 已配置 | 本机 Node 24.14.1 与 Electron 45.3.2 中开发版与发布版都通过；L4 两种形态通过；CI `core-load`（`macos-latest`）待推送 | `tmp/evidence/T04/load-darwin-arm64.log` |
| darwin-x64 | 本机交叉构建（`x86_64-apple-darwin`）通过 | 本机 Rosetta 2 下的 x64 Electron 45.3.2（官方发布包，SHA-256 已核对）中开发版与发布版都通过；CI `core-load`（`macos-15-intel`）待推送 | `tmp/evidence/T04/load-darwin-x64-rosetta.log` |
| win32-x64 | CI `core-build`（`windows-latest`，MSVC）通过（运行 43827342553）；W0 本机 `npm run build:core -- --flavor all` 通过 | CI `core-load`（`windows-latest`）开发版与发布版在 Node、Electron 中通过；W0 本机同样通过，L4 两种形态通过，实机基准见第 8 节 | `tmp/evidence/W0/` |
| win32-arm64 | CI `core-build`（`windows-latest` 交叉构建）通过 | CI `core-load`（`windows-11-arm`，镜像 `windows-11-vs2026-arm64`）开发版与发布版在 Node 24.22.2、Electron 45.3.2 中通过；没有本地 arm64 设备 | CI 运行 43827342553 |

加载检查的内容：在 Node 与 Electron 中 `process.dlopen`，开发版跑 2,000 个演示事件（全部到达、序号连续）、`triggerPanic` 得到 `internalError`、有序关闭后状态为 `stopped`；发布版只检查创建与关闭。

## 5. 发现

1. **Electron 45 主进程不能转移 `ArrayBuffer`。** `MessagePortMain.postMessage` 的转移列表只接受 `MessagePortMain`，放入 `ArrayBuffer` 会抛 `Port at index 0 is not a valid port`；源码中消息经 V8 `ValueSerializer` 复制。这与 ADR-0014 第 4 条、架构第 8.3 节第 5 条不符，按协议属于变更型，写了 ADR-0019，已接受：批次一律复制转发，T04-A06 随之改为"1 MiB 以上的批次完整到达，记录转发耗时，同期事件循环延迟 p99 ≤ 16 ms"。
2. **Electron 不允许外部 buffer。** NAPI-RS 在 `napi_create_external_buffer` 返回 `napi_no_external_buffers_allowed` 时退回复制（源码 `env.rs`、`arraybuffer.rs`），所以 Core 的载荷进 JavaScript 时也复制一次。
3. **`monitorEventLoopDelay` 的值含采样间隔。** 空闲的 Node 进程在 `resolution: 10` 时 p50 约 11 ms、`resolution: 1` 时约 1.2 ms。只看原始值会把 10 ms 的采样间隔误当成延迟；基准改用 1 ms。
4. **`ThreadsafeFunction` 确实让进程保持存活。** Vitest 用例中，加载 Core 后不关闭的 Node 子进程 2 秒内不退出；`await shutdown()` 后自行退出（退出码 0）。Electron 中 `will-quit` 时先关闭 Core，L4 验证应用在事件流进行中退出正常。
5. **ESM 主进程不能在顶层 `await app.whenReady()`**：`ready` 要等入口模块求值完才触发，顶层等待会死锁。加载检查脚本因此改为 `whenReady().then(...)`。
6. **NAPI-RS 的类型生成**：参数是 `ThreadsafeFunction` 类型别名时，生成的 `.d.ts` 会写出别名名，需要 `#[napi(ts_arg_type = ...)]`；字符串枚举默认生成 `const enum`，主进程比较字符串不方便，改用类型联合（`constEnum: false`）。

## 6. ADR 触发条件

- ADR-0014 的触发条件（事件循环延迟 p99 超过 16 ms 且由 Core 造成）未触发：实测 p99 3.58 ms（含 1 ms 采样间隔）。不需要把 Core 移到 `utilityProcess`。
- 转移 `ArrayBuffer` 不可行，写了 ADR-0019 并已接受（修订 ADR-0014 第 4 条，架构 v2.7）。

## 7. 后续

- R1：按第 4.4 节的数据校准主进程内存预算（I12）；按第 8 节校准 Windows 上事件循环延迟的测量口径。

## 8. Windows（W0，2026-11-16）

| 项 | 内容 |
|---|---|
| 机器 | HUAWEI 笔记本，Intel Core i5-1340P（4 个性能核 + 8 个能效核，16 线程），16 GB，NVMe SSD 1 TB；Windows 11 专业版 25H2（10.0.26200.9974），x64；接交流电，平衡电源计划；Defender 实时保护开启；运行时还开着微信、IDE 等常驻程序 |
| 对照第 11 章基准机型 | x64 8 核 / 16 GB / NVMe：核数、内存、磁盘都满足；能效核与笔记本散热使它弱于台式机，数据偏保守 |
| 产物 | 本机开发构建打包（`npm run package:desktop -- --flavor development`），Electron 45.3.2 |

`npm run bench:s2 -- --form packaged`（`tmp/evidence/W0/bench/s2-packaged.json`）：

| 项 | Windows | 预算 | macOS（第 4 节） |
|---|---|---|---|
| 10 万事件/分钟 × 5 分钟 | 50 万个全部到达，乱序 0；9,974 次回调（33.0 次/秒），每批 50.1 个 | 无丢失、无乱序 | 同 |
| 同步调用 `echo` | p50 0.003 ms，p99 0.008 ms，max 1.44 ms | p99 ≤ 1 ms | p99 约 0.01 ms |
| 主进程事件循环延迟（原始值，1 ms 采样） | p50 15.35 ms，p99 16.81 ms，max 36.47 ms | p99 ≤ 16 ms | p99 3.58 ms |
| 同机空闲 Node 24.13.1 的同一测量 | p50 15.56 ms，p99 16.58 ms，max 16.79 ms | — | 1 ms 采样时 p50 约 1.2 ms |
| 每次投递的主进程转发 | p50 0.098 ms，p99 0.214 ms | — | — |
| 1 / 4 / 8 MiB 批次转发 | p50 1.63 / 5.08 / 10.74 ms；同期事件循环 p99 16.89 / 16.42 / 21.32 ms | 完整到达 | — |
| 空闲主进程 RSS | 108.4 MB；裸 Electron 96.1 MB | ≤ 120 MB | 160–164 MB |

分析：

- **事件循环延迟的原始值受 Windows 计时器粒度支配。** 1 ms 的采样定时器在 Windows 默认计时器精度下约 15.6 ms 才触发一次，`monitorEventLoopDelay` 记录的是两次采样的完整间隔，所以空闲的 Node 进程也是 p50 15.56 ms、p99 16.58 ms。满载的 p99 只比空闲多 0.23 ms，事件流没有让主进程出现可见的阻塞。同一机器上 S7 的 `type` 100 MB 期间 p50 为 4.12 ms（S7 报告第 11 节），说明 Chromium 在有渲染负载时提高了计时器精度，同一指标的底数随负载变化。
- 按原始值，p99 16.81 ms 超出预算 0.81 ms，这里如实记录为"原始值不通过"，预算不改。8 MiB 批次期间的 21.3 ms 是一次 10.7 ms 复制转发叠加在 15.6 ms 底数上的结果，与 macOS 的分析一致（ADR-0019 已接受复制转发）。
- **空闲内存比 macOS 低**：Windows 上裸 Electron 96.1 MB，含 Core 108.4 MB，在 120 MB 预算内；Core 与应用代码约 12 MB。I12 的校准要分平台写。
- 结论：**有条件通过**。功能性标准（无丢失、无乱序、四个目标加载）全部达标；事件循环延迟的测量口径在 Windows 上需要 R1 校准，例如扣除同机空闲基线，或改为测量每次回调的执行时长。

win32-arm64：没有本地 arm64 设备。CI 的 `core-load` 在 GitHub 的 arm64 Windows 11 runner（真实 arm64 硬件上的 Windows 11）上通过，开发版跑完 2,000 个事件。W0 给加载检查加了一项终端检查，在 PTY 中运行命令，并从 libghostty-vt 的帧中读回输出（`scripts/ci/core-load-check.mjs`），本机 x64 四种组合通过。arm64 上 libghostty-vt 的实际运行要等下一次 CI 才有结果，由 R1 核对（S7 报告第 11 节）。
