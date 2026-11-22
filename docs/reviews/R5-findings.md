# R5 · M4 macOS 阶段评审

**M4（macOS）未达标。** 第 16 章 M4 的两条退出标准：安全威胁表逐条有测试，本地全部满足（第 10.1 节 14 条威胁、59 个对策都映射到测试，`check-threats.mjs` 通过，14 条各抽查一个测试并确认断言在验证对策；抽查补上两处映射缺口），两个平台 CI 上的结果要等本分支推送；性能预算全部达标，不满足：R5 复测的本机 Nightly 有四行超出（流式帧 p99、主进程增量、Agent Host 内存、应用全部进程合计），其中"应用全部进程合计"是 RSS 口径问题，本评审写了 ADR-0063（提议）请用户决定，其余三行要优化。M4 的功能都已交付：第 16 章 M4 行的九项都有任务与验收证据，T41 漏改的两个能力补了 L2 场景后，能力清单里 M4 及之前没有 `planned` 的能力（L2 216 个场景 213 通过、3 个按平台跳过、MISSING 0）。四个独立审查共 57 条发现：修复或部分修复 21 项（P1 与 Q1 算一项；其中 3 项安全与门禁缺陷每项先有失败的测试：Agent Host 的子进程能往 Pi 自动加载的目录里放代码、克隆的插件用自带 `.npmrc` 让 npm 运行任意程序、性能门禁在 CI 上不判任何值），其余写明不同意的理由或登记到具体任务（I211–I222）。W3 的 Windows M3 结论确认：除内存一项（同一口径问题）外逐条有证据。ADR-0057 已接受，架构相关章节已同步。

**进入 M5（T46）的前提条件**：

1. **用户决定 ADR-0063**（内存口径，放宽）：采纳后按物理占用重测两个平台，M3 与 M4 的内存一行按新口径判定；否决则这一行维持超出，需要另找优化方案。
2. **用户决定 ADR-0064**（"信任"经主进程原生确认，I79）：不阻塞 T46 开工，但采纳后要在 M5 内实现。
3. **性能达标任务**（I222，计划变更，需用户排期）：流式帧 p99、主进程增量、Agent Host 内存三行要优化到预算内，才能判定 M4 的性能退出标准。建议在 T46 之前或与 M5 并行，最晚 R6 之前。
4. **推送并看 CI**：本分支自 `c651816` 起未推送。R5 的修复覆盖了运行 45024661885（W3 的提交）在两个平台上的已知失败；推送后的 CI 要确认威胁映射在 Windows verify 上通过（R5-A01），并从 CI 工件记录 `github-arm64`、`github-x64` 的性能基线（R5 起缺基线的 CI 性能冒烟会失败，见第 4 节 P1）。
5. 用户核对的事项（不阻塞）：T42-A06（通知横幅截图，需"屏幕录制"权限）、T43-A10（VoiceOver 实际操作）、T44-A04 与 T44-A09（T44 自己的验收项，本评审不能改，见第 2.3 节）。

## 1. 退出标准取证

### 1.1 安全威胁表逐条有测试

- 本机：`node scripts/ci/check-threats.mjs --results target/l2/results.json` → `threat map checks passed`（14 条威胁、59 个对策；R5 后映射 172 个测试 ID）；`docs/security/threat-coverage.md` 与清单一致（verify 第 17 步，见第 6 节）。
- CI：本分支未推送。最近一次两个平台都跑完的 CI 是 W3 的提交 de98771（运行 45024661885）：
  - macOS verify：17 步中只有第 1 步 Prettier 失败（W3 合并带来的 `tests/scenarios/plugin-commands.yaml` 格式，a94a03c 已修），第 17 步威胁映射通过。
  - Windows verify：第 1 步同一 Prettier 失败；第 8 步 `cargo test` 有 1 个失败（`state::sources` 的测试辅助函数按 `/` 匹配 Windows 路径，e682784 已修）；第 14 步 L2 199 通过、0 失败、14 个按平台跳过（I208 列出的 12 个场景全部通过）；第 17 步威胁映射通过。
  - 两个平台的 L4 有失败（第 6 节），其中映射到威胁的用例都通过。
  - 结论：映射引用的测试在两个平台 CI 上通过的证据只到 de98771；R5 新增的 4 个映射测试（THR-01 L2、THR-03 两个、THR-04、THR-14）要等推送后的 CI。R5-A01 记为 blocked。

**抽查记录**（每条威胁一个测试，读断言确认它在验证对策，而不只是功能可用）：

| 威胁 | 抽查的测试 | 断言 | 结论 |
|---|---|---|---|
| THR-01 提示注入 | `piarc-policy/src/decision/tests.rs::mandatory_asks_hold_in_every_mode` | 对 `criticalPath`、`unresolved`、`requiresUserInteraction`、`askRule` 四种必问，在全部模式（含跳过权限）下、即使有 allow 规则与 hook 的允许，结论都是 `Ask` 且步骤不变 | 验证对策（关键路径删除总是询问） |
| THR-02 恶意项目配置 | `piarc-core/tests/state.rs::trust_get_answers_untrusted_on_every_failure` | 目录解析不了、查询失败与 panic、表被删除时都答 `trusted: false`；参数错误是 `InvalidParams` | 验证对策（任何失败都按不信任） |
| THR-03 恶意插件 / Pi 包 | `agent-host/src/runtime/pi-settings.test.ts`"THR-03 hides every package source…" | 经 `withoutPiPackages` 后 Pi 的包管理器 `resolve()` 得到空扩展、项目与用户的 npm 都没运行、没有建 npm 目录 | 验证对策 |
| THR-04 凭据泄露 | `piarc-testkit/tests/credential_leaks.rs::thr04_a_vault_credential_stays_out_of_child_environments_and_log_files` | 命令的 `env` 输出里没有保险箱的密钥；Agent Host 进程环境没有；Core 与 Agent Host 的日志行写进文件时已替换 | 验证对策 |
| THR-05 沙箱逃逸 | `piarc-core/tests/sandbox.rs::connections_around_the_proxy_fail` | 去掉代理变量、`--noproxy`、python 直连 IPv4/IPv6 都失败且监听端没有收到连接；代理对白名单外的主机答 `not-allowed` | 验证对策 |
| THR-06 审批疲劳 | `apps/desktop/src/renderer/transcript/rows/approval-keys.test.ts`"arms the first visible card at 400 ms…" | 399 ms、非首张、按键重复时不作答 | 验证对策（L4 `t43-approval-focus` 在真实窗口复核） |
| THR-07 多窗口审批 | `piarc-core/src/tool_io/policy/tests.rs::concurrent_answers_apply_once_and_each_decision_is_audited_by_session` | 过期 revision 答 `stale`；两个并发答复一个 `applied` 一个 `alreadyHandled`；审计按会话 | 验证对策（connectionEpoch 在同文件 `disconnect_expires_pending_cards…`） |
| THR-08 供应链 | `scripts/ci/supply-chain.test.mjs`"THR-08 every npm dependency is pinned…" | 扫描全部 `package.json` 的三类依赖，非精确版本即失败 | 验证对策 |
| THR-09 更新通道 | `piarc-core/tests/release.rs::a_file_whose_hash_differs_from_the_manifest_is_refused` | 同大小改一个字节得到 `HashMismatch`，多一个字节得到 `sizeMismatch`，都拒绝 | 验证对策（HTTPS 与受保护环境两项 deferred 到 T50，I200） |
| THR-10 应用文件被篡改 | `scripts/ci/check-fuses.test.mjs`"release settings follow ADR-0018 rule 1" | 断言配置常量；产物上的 fuse 由 `ci:scripts/ci/check-fuses.mjs` 读取比对 | 单测只验证配置，对策由 CI 检查产物，两者合起来成立 |
| THR-11 渲染进程注入 | `apps/desktop/src/renderer/transcript/markdown/to-ir.test.ts`"turns every XSS payload into text…" | 每个载荷的链接与图片只剩 `https`/`http`/`mailto` 或 `null` | 只验证了链接一半；对策"原始 HTML 当文本"由同文件"keeps raw HTML as html nodes, verbatim"断言，却没有映射：**R5 补进映射**（4f6de69） |
| THR-12 通用运行时滥用 | `apps/desktop/src/main/security/runtime-switches.test.ts`"THR-12 removes and reports…" | 两个远程调试开关被移除并报告，其他开关保留 | 验证对策（产物上由 `check-release-runtime.mjs` 复核） |
| THR-13 恶意链接 | `apps/desktop/src/main/launch.test.ts`"THR-13 open no network share or device path…" | 五种 UNC、设备路径的 `piarc://open` 都解析为空 | 验证对策；Windows 上 OSC 8 链接没有运行的测试，登记 I220 |
| THR-14 同一用户进程注入 | `scripts/ci/check-app-layout.test.mjs`"reads an ad-hoc signature with the hardened runtime" | 只测解析 `codesign` 输出；布局检查比对产物与 `entitlements.mac.plist`，plist 本身多一项也通过 | 对策"entitlements 只有两项"没有被断言：**R5 新增**"THR-14 the app asks for only JIT and disabled library validation"，往 plist 加 `get-task-allow` 时失败（`tmp/evidence/R5/thr14-red.log`），已映射 |

### 1.2 性能预算全部达标

- 测量框架与门禁的审查（第 4 节 P1）发现 CI 上的 PR 冒烟与 Nightly 不判任何值：CI 的两个 runner 类别没有基线、命令不带 `--absolute`。9f5ec0a 改为缺基线即失败。所以在 R5 之前，"最近一次 Nightly 完整测量通过"在 CI 上没有意义；`perf-nightly.yml` 只在默认分支（`main`）的定时触发上运行，`main` 还没有这些提交，CI 上从未运行过（`gh run list --workflow perf-nightly.yml`：workflow not found on the default branch）。
- 唯一的完整测量是本机 Nightly：T44（2026-11-21，M1 Max / 32 GB，非基准机型，`performance.md` 第 5.2 节）与 R5 的复测（下表；方法与 T44 相同：`node scripts/perf/run.mjs --lane nightly --absolute --machine m1-max-32g`，报告 `tmp/evidence/R5/perf-nightly-report.json`）。

| 第 11 章的行 | 预算 | T44 | R5 | 结论 |
|---|---|---|---|---|
| 冷启动到可交互窗口 | ≤ 1,000 ms | 440 ms | 666 ms | 达标；相对基线 +51% 报回归，测量时机器有负载（见下），未确认 |
| 打开工作区到 Agent Host 就绪 | ≤ 1,000 ms | 955 ms（10 次中位，口径错误） | 982 ms（10 次最大，改回的口径） | 达标，余量 2%（I193） |
| 首 token 额外延迟 | ≤ 50 ms | 24.3 ms | 25.2 ms | 达标 |
| 主进程增量 | ≤ 24 MB | 32.5 MB | 35.6 MB | **超出**（I192） |
| 渲染进程内存 | ≤ 220 MB | 173 MB | 174 MB | 达标 |
| 应用全部进程合计 | ≤ 510 MB（RSS） | 519 MB | 530 MB | **超出**（RSS 口径，ADR-0063） |
| Agent Host 内存 | ≤ 150 MB | 202 MB | 196 MB | **超出**（I194） |
| 每会话增量 | ≤ 40 MB | 10.5 MB | 6.5 MB | 达标 |
| 主进程事件循环 p99 | ≤ 16 ms | 2.7 ms | 5.0 ms | 达标；相对基线报回归，同上未确认 |
| 流式帧 p99 / 长任务 | ≤ 12 ms / 0 | 16.4 ms / 0 | 16.2 ms / 0 | **帧工作超出**（I191） |
| 万条滚动 | 60 fps | 60 | 60 | 达标 |
| 会话切换（缓存 / 冷） | ≤ 100 / 170 ms | 28.8 / 62.1 ms | 30.2 / 62.2 ms | 达标 |
| Core 事件到渲染进程 p95 | ≤ 1.1 ms | 0.22 ms | 0.18 ms | 达标 |
| AHP 往返 p95 | ≤ 5 ms | 0.25 ms | 0.30 ms | 达标 |
| 权限裁决 p95 | ≤ 2 ms | 0.69 ms | 0.84 ms | 达标 |
| 终端回显 p95 | ≤ 5 ms | 0.67 ms | 0.77 ms | 达标 |
| 空闲 CPU（可见 / 隐藏）、隐藏帧 | ≤ 5% / 5% / 0 | 3.6% / 3.5% / 0 | 2.8% / 2.5% / 0 | 达标 |
| Agent Host 崩溃恢复 | ≤ 3 s | 1.44 s | 1.44 s | 达标 |
| 渲染进程恢复 | ≤ 2 s | 0.22 s | 0.21 s | 达标 |
| 安装包与安装后体积 | ≤ 200 / 450 MB | 176.2 / 446.6 MB | 未重测（R5 不改随包内容） | 达标（T44） |
| 8 小时长跑 | ≤ 10% | 未测（I195） | 未测 | 未测 |

- 环境：同 T44 的 M1 Max / 32 GB，接电源（80%，`tmp/evidence/R5/perf-nightly.txt` 第一行），开发构建打包于 1118ef0 之后（`tmp/evidence/R5/package-dev-2.log`）。测量时机器没有空闲：IntelliJ IDEA 占约 117% CPU、UURemote 远程桌面在运行，负载均值约 5（`uptime`、`ps -r`）。冷启动与事件循环两行的相对回归在这种负载下与 T44-A04 记录的"受干扰的运行"相同，不作为回归结论；内存与帧时间两类与 T44 一致（差在 ±5% 内）。
- 判定：第 11 章 23 个可测行中 4 行超出预算（主进程增量、应用全部进程合计、Agent Host 内存、流式帧 p99），与 T44 相同；其中只有"应用全部进程合计"是口径问题。性能一条退出标准不满足，R5-A02 为 failing。

- Windows（W3，i5-1340P / 16 GB，非基准机型，`performance.md` 第 6.1 节）：冷启动 1,075 ms、首 token 额外 122 ms、主进程增量 29.3 MB、应用全部进程合计 558 MB、流式帧 p99 49.3 ms 与长任务 25、万条滚动 35 fps、权限裁决 p95 12.4 ms 超出；工作区就绪、渲染进程与 Agent Host 内存、每会话增量、事件循环、会话切换、事件转发、AHP 往返、终端回显（1,000 对）、空闲 CPU、两种恢复达标；安装包与安装后体积只测了开发构建（I202），8 小时长跑未测（I195）。按第 15.1 节，Windows 的 M4 在 W4 验收，这些项列入文末 W4 清单，不阻断 M4（macOS）的结论。

### 1.3 M4 目标逐项

| 第 16 章 M4 的目标 | 任务 | 验收证据 | 状态 |
|---|---|---|---|
| macOS 沙箱 | T39 | T39-A01–A11、A14 passing；A12（Windows CI 的沙箱不生效提示）blocked | 达标；A12 等 CI |
| Windows 隔离方案评估 | T39 | T39-A13 passing；ADR-0057 已接受（2026-11-21），架构第 4 章、6.10、10.3、15.2 节与 R16 已同步 | 达标 |
| 插件 | T40 | T40-A01–A11 passing；R5 修复克隆包的 `.npmrc`（S5） | 达标 |
| NotebookEdit | T42 | T42-A01–A03 passing | 达标 |
| 可操作的系统通知 | T42 | T42-A04、A05 passing；A06（横幅截图要"屏幕录制"权限）、A07（Windows CI）blocked | 功能达标；截图等用户、Windows 等 CI |
| 配置诊断 | T24、T41 | T41 passing；R5 补 L2 `config-diag-sources`，`CAP-CONFIG-DIAG-002` 改 active | 达标 |
| 无障碍 | T43 | T43-A01–A09 passing；A10（VoiceOver 实际操作）blocked；R5 修复 5 项（第 4 节） | 自动化达标；VoiceOver 等用户 |
| 本地化 | T43 | T43 passing；R5 修复 i18n 检查的盲区与英文复数 | 达标 |
| 性能预算全部进 CI | T44 | T44-A01–A03、A05、A07、A08 passing；A04 failing、A09 not_started；R5 发现 CI 门禁不判值并修复（P1） | 测量进了 CI，判定要在 CI 记录基线后才生效 |

- `acceptance.json` 摘要（T39–T45、W3）：T40、T41 全部 passing；T39 14/15（A12 blocked，Windows CI）；T42 10/12（A06 blocked 截图权限，A07 blocked Windows CI）；T43 10/11（A10 blocked VoiceOver）；T44 6/8（A04 failing、A09 not_started）；T45 12/13（A02 blocked CI）；W3 10/12（A01 failing 内存、A12 blocked 全量 verify）。
- blocked 的原因都成立（另一平台的 CI、需要用户在场或系统权限）。**不成立的两项**：T44-A04（5 次 PR 冒烟在安静环境下全部通过，T44 在远程桌面负载下未完成）与 T44-A09（T44 收尾的全量 verify 未运行）是 T44 自己没做完的验收，协议不允许本评审改别的任务的验收项。R5 在收尾提交上跑了全量 verify（第 6 节），代码层面 T44-A09 要求的检查已通过；T44-A04 需要在安静环境重跑 5 次后由 T44 续做或用户关闭。W3-A01 是内存口径（ADR-0063）。因此 R5-A03 为 failing。
- 能力清单：`node scripts/plan/check-capabilities.mjs --results target/l2/results.json` → `L2 coverage: 216 scenarios (3 skipped on macos), MISSING 0`、`capability checks passed`；`--milestone M4` → `planned capabilities of M4 and earlier: 0`（`tmp/evidence/R5/run-l2-2.log`）。开工时 `--milestone M4` 列出 `CAP-USAGE-COST-001`、`CAP-CONFIG-DIAG-002`：T41 交付了功能却没改状态，R5 新增 L2 动作 `check_cost` 与两个场景后改为 active（71a1e1c）。能力 192 项：active 185、planned 7（M5）、blocked 0。

## 2. W3 与 ADR-0057

### 2.1 W3 确认

- W3 的结论与证据（[W3 报告](W3-windows-m3-parity.md)，`PLAN.md` 的 W3 会话日志）：M3 的能力在 Windows 11 实机逐项核对（终端与输入法、MCP、worktree、托盘、多窗口、`piarc://` 与右键菜单、读屏），修了 10 个 Windows 缺陷，每个先有在 Windows 上失败的测试；M3 的退出标准只有内存一项不达标（Agent Host 163 MB 达标，应用其余进程 576 MB 超出 450 MB，私有工作集 256 MB），与 macOS 是同一口径问题。
- R5 的核对：
  - W3 的 10 个修复在 CI 上成立：运行 45024661885 的 Windows verify 中 L2 199 通过（I208 的 12 个场景含不在 W3 改动里的 `hooks-m4-mcp-tool` 全部通过），Vitest 通过。
  - W3 没跑收尾的全量 verify（W3-A12 blocked）：CI 的 Windows verify 替它跑了，失败的两处（Prettier、`state::sources` 的 Windows 路径）R5 已修（a94a03c、e682784）。
  - W3 遗留问题都有归属：I201（内存，ADR-0063）、I202（Windows 发布构建体积，T50）、I203（本地深路径包源，W4）、I204 与 I205（Windows 终端，T48）、I206（平台限制，已记录）、I207（Windows 性能，W4）。W3 登记的 I174、I175 由 R5 指派 T48。
  - Windows 的 M3 退出标准：功能逐条有证据，内存一项随 ADR-0063 的决定判定。

### 2.2 ADR-0057

状态"已接受"（2026-11-21，用户在 T39 中采纳）。架构已同步：第 4 章；第 6.10 节 Windows 一条（到 Beta 维持现状，MXC ProcessContainer 为 Beta 之后的候选及前提）；第 10.3 节（Windows 的 Agent Host 没有第二道防线，计入已接受风险）；第 15.2 节沙箱一行；第 14 章 R16。威胁映射 THR-03、THR-05 的 accepted-risk 条目引用它。不是进入 M5 前的待决事项。

## 3. 独立审查的输入与调度

四个审查者是只读子代理（`read-only-reviewer`，只有读文件与搜索工具），在同一条消息里并行启动，基线 16c6d41（合并 W3 之后），相互看不到对方。每个审查者拿到审查范围、要回答的问题、代码位置、架构章节、ADR 与材料，M4 期间（8a1b0cf..16c6d41）的改动清单与提交列表；要求自己形成结论、给出文件与行号和失败场景、标出"待核实"，并列出检查过且没有问题的部分与没读到的部分；没有给出本评审的预判。审查者禁止打开 `reference/` 下的 clean-room 参考。审查原文要点在 `tmp/evidence/R5/review-{security,perf,a11y,quality}.md`。

| 审查 | 范围 | 材料 |
|---|---|---|
| 安全（S） | `piarc-sandbox`（会话沙箱、Agent Host 配置模板、代理）、Core 的 `tool_io/sandbox`；`piarc-policy` 与 Core 的 `tool_io/policy`；插件管理（`piarc-core/src/plugins`、`piarc-config` 的 plugins、`piarc-git` 的 package、Agent Host 加载扩展处、`pi-settings.ts`）；`piarc-telemetry`（脱敏、诊断包）；主进程 IPC、preload 与渲染面 | 架构 6.2、6.7、6.10、10.1–10.5；ADR-0025、0029、0031、0039、0056–0058、0062；威胁映射与覆盖表、Electron 清单、外连清单 |
| 性能（P） | `scripts/perf/`（指标、判定、探针、长跑、基线）、`ci.yml` 与 `perf-nightly.yml`、被当作探针的基准脚本、事件转发、transcript 与终端的热路径、权限裁决 | 架构第 11 章、12.1 节；`performance.md`、`M3-memory.md` |
| 无障碍（A） | 渲染进程组件、`e2e/a11y/states.ts` 与覆盖检查、`t43-*` 旅程、i18n 目录与 `check-i18n.mjs`、主进程面向用户的文字 | `accessibility.md`、架构 8.5、8.7；ADR-0061 |
| 工程质量（Q） | M4 期间的全部代码改动 | `coding-standards.md`、`testing.md`、`claude-md.md`、各目录 AGENTS.md、`deps-rules.json`、架构 6.15、7.1、12 |

汇总时比对了重复：P1 与 Q1 是同一问题；S3 与已登记的 I79 相同；Q3 与 I209 相同；Q5、Q6、Q10 分别并入 I173、I175、I174。审查结论来自读源码，审查者没有运行测试；本评审对每条"确认"的发现先写测试复现。

## 4. 逐项核实与处理

编号与位置指审查基线 16c6d41。修复的每一项都先写失败的测试（输出在 `tmp/evidence/R5/` 的 `*-red.log`），修复后通过（`*-green.log`）。

### 安全（S）

| 编号 | 位置与失败场景 | 核实结论与处理 |
|---|---|---|
| S1 高 | `piarc-sandbox/src/seatbelt/agent-host.sbpl:26-30`：Agent Host 配置让整个 `<数据目录>/pi` 可写；Pi 自动加载 `<pi>/extensions` 下的文件与 `<pi>/settings.json` 的 `extensions`，Agent Host 的 MCP server 或 npx 子进程写进去，下次会话在 Agent Host 内运行 | 确认，且比报告的更宽：Core 还从 `<pi>/skills`、`<pi>/prompts` 读用户级 skill 与命令（其 `allowed-tools` 与 hooks 不需要信任），确认过的包在 `<pi>/npm`、`<pi>/git`。真实 `sandbox-exec` 测试先红（`s1-red.log`）。这些路径与 `settings.json`、`models.json` 对 Agent Host 只读，Pi 的会话文件与设置锁仍可写；8 个受影响的 L2 与 `sessions sandbox::` 通过。4f6de69 |
| S2 中 | `piarc-sandbox/src/policy.rs:27-51`：受保护路径不覆盖 bare 仓库布局与 `.git` 文件的 gitdir 重定向 | 读码成立，需要在真实 `sandbox-exec` 下写复现再定保护方式：登记 I211（T48，R6 前） |
| S3 中 | `session-ipc.ts:780-785`：信任决定没有原生确认 | 与 I79 相同；改变 ADR-0029 的结论，写 ADR-0064（提议）由用户决定 |
| S4 中 | `sandbox-ipc.ts:85-113`：关闭沙箱、删减 `denyRead` 不经原生确认，THR-11 的测试名说"sandbox loosening"却只测了自动批准与域名 | 确认（单测先红，`s4-red.log`）。两者都经同一原生确认，并列出失去保护的路径；L4 `t45-ipc-hardening` 加入伪造的关闭沙箱，`t39-sandbox` 断言关闭时弹出确认。977173b。域名列表的长度上限登记 I212 |
| S5 中 | `plugins/mod.rs:310,330-337`：克隆的包在用户确认之前、沙箱之外由 npm 安装依赖，npm 读克隆里的 `.npmrc` | 确认，比"待核实"更严重：包的 `.npmrc` 写 `git=<包里的脚本>`、依赖一个 git 地址，`npm install --ignore-scripts` 照样运行那个脚本（单测先红，`s5-red.log`）。npm 运行期间把 `.npmrc` 移开、结束后放回（检出保持原样）。8cdd10b。安装与更新没有原生确认并入 I213 |
| S6 中 | `plugins/mod.rs:595-619`：更新保留按名字的确认，名字背后的代码可整个换掉 | 读码成立（确认按名字，更新不比内容）：登记 I213（T48，R6 前） |
| S7 低-中 | `plugins-ipc.ts:210-248`：原生确认框的项名没有长度上限、不处理控制与双向字符 | 读码成立：登记 I212（T48，R6 前） |
| S8 低-中 | `piarc-telemetry/src/redact.rs:110-118`：字段规则以 `\b` 开头，`AWS_SECRET_ACCESS_KEY=`、`DB_PASSWORD=`、`MY_API_KEY` 不匹配 | 确认（单测先红，`s8-red.log`）。字段名前改为"行首或非字母数字"，加入误报守护（`MAX_TOKENS=4096` 等不替换）。306d957。报告里的其余弱点（少于 12 字符的已知值不记、JSON 转义后的值）是 T45 的设计取舍（`MIN_SECRET_LEN` 防误伤），不改 |
| S9 低 | `proxy/mod.rs:267`：代理没有认证，任何本机进程能触发域名卡；卡片不显示命令；没有频率限制 | 成立：登记 I214（T48） |
| S10 低 | `proxy/address.rs:23-39`：不挡 `::a.b.c.d`、`64:ff9b::/96` | 成立：并入 I214 |
| S11 低 | `transcript/rows/web-search.tsx:28-37`：来源链接的 `href` 没经 `safeHref` | 确认（行组件测试先红，`s11-red.log`）。经 `safeHref`，其他地址显示为文字。点击本来就经主进程确认，修的是不一致。f30813a |
| S12 低 | `piarc-policy/src/decision.rs:200-205`：沙箱自动批准时工作区外的读取不询问，没有默认 `denyRead` | 不同意改：第 6.10 节与 ADR-0056 的决定是读取默认放开、`denyRead` 可配置；自动批准默认关闭，打开时经原生确认并写明作用。是否内置默认 `denyRead`（`~/.ssh` 等）属产品决定，留给 T48 的沙箱完善时评估（写进 I214 的说明） |
| S13 低 | `policy/`：工作区内的目录来源包对文件工具没有保护 | 读码成立、待实测：登记 I215（T48） |

### 性能（P）

| 编号 | 位置与失败场景 | 核实结论与处理 |
|---|---|---|
| P1 高 | `gate.mjs:109-123`、`run.mjs:449-460`、`ci.yml:126`、`perf-nightly.yml:79,85`：CI 的 `github-*` 类别没有基线、命令不带 `--absolute`，PR 冒烟与 Nightly 对任何回归都通过；损坏的基线文件读作没有基线 | 确认（单测先红，`p1-red.log`）。两道都判不了的值算失败（"nothing judged"），非有限值在任何模式下失败，基线文件解析不了直接报错，`--update-baseline` 拒绝有错误的运行；CI 的性能冒烟挪到发布检查之后，免得它的失败跳过 THR-12 等发布构建检查；文档写明推送后从工件记录基线。9f5ec0a。推送后 CI 的性能步骤会以"nothing judged"失败，直到记录基线（前提条件 4） |
| P2 中 | `long-run.mjs:112-143`：只比首尾两个样本；`prompt` 的失败被吞掉，回合没进行也测成空闲 | 确认（读码）。拒绝的提示计数，过半即失败；增长取首尾各两个样本的平均。94007a5 |
| P3 中 | `run.mjs:133-148`：正则把汇总行 `max of 10: … open + resume` 算作第 11 个样本并取中位，而 T14 与第 11 章按 10 次最大判定，探针还忽略示例的退出码 | 确认（读 `t14-warmup.rs` 的输出格式）。只取 `round N:` 行，判定值改为最大。9f5ec0a。没有为探针的解析单独写失败测试（解析在探针函数内），这次修复以第 1.2 节的复测数据为证 |
| P4 中 | `gate.mjs:46-49`、`metrics.mjs` 的 `floor`：小值指标的相对阈值远大于 10%；预算为 0 的计数要多出 2 个才触发 | 部分确认并修复：两个计数指标的 `floor` 改为 0，比基线多一个即失败（单测"fails the first count over a baseline of zero"）。9f5ec0a。其余指标的 `floor` 要按多次运行的方差重定，登记 I216 |
| P5 中 | `gate.mjs:44,46`：非有限值在非 absolute 模式下放行 | 确认，随 P1 修复（单测先红）。9f5ec0a |
| P6 中低 | `run.mjs`：探针忽略退出码、可能读到上次的输出；`--update-baseline` 不查错误 | `--update-baseline` 部分随 P1 修复；探针退出码与清理输出登记 I216 |
| P7 低 | `probe-sessions.mjs`：`main-loop-p99` 的负载约 100 事件/秒 | 成立：登记 I216（把 s2 的事件循环登记为指标） |
| P8 低 | `probe-idle.mjs:124-135`：隐藏时的 rAF 计数近乎空检查 | 不同意改：rAF 计数守的是页面在隐藏时不再请求帧（T34 的停拉约定），Chromium 自己停 rAF 时它为 0 是期望值；有效部分是终端帧计数，两者一起报告不误导。不改 |
| P9 低 | `hooks_m4.rs:35`：FileChanged 每 500 ms 轮询与第 11 章"无轮询" | 轮询是 ADR-0059 的决定（FSEvents 在负载下启动阻塞），只在配置了 `watchPaths` 时运行；第 11 章的写法补"未配置 FileChanged 时"，登记 I216 |
| P10 低 | `LiveRegion.tsx`、`row-label.ts`：流式期间每次行变更对整段文本做 `words()`，`excerpt` 先规整后截取 | 待测量：作为 I191（流式帧 p99 超出）的候选并入 I222 |
| P11 低 | `metrics.mjs:264` 写"≥ 200 pairs"实际 1,000；PR 流式 15 s 未写明；`metrics.test.mjs` 不核对预算数值 | `how` 文字已改（e64b420）；其余并入 I216 |

### 无障碍（A）

| 编号 | 位置与失败场景 | 核实结论与处理 |
|---|---|---|
| A1 中 | `e2e/a11y/states.test.ts:31-34,47`：覆盖检查按文件与正则计数，同一文件新增的对话框（终端粘贴确认框）、审批的沙箱网络卡与 MemoryImport 变体、菜单、Toasts 等没有登记；没有反向检查 | 读码成立：登记 I217（T48） |
| A2 中 | `t43-a11y.e2e.ts`：`AXE_DIR` 的 `.checked` 标记不清理，旅程里删掉的检查靠上次的标记继续通过；`row:*` 不断言行存在 | 标记部分确认并修复（旅程开头清掉标记，axe 报告保留）。2438660。`row:*` 的存在断言并入 I217 |
| A3 中 | `check-i18n.mjs:313-319`：`includes('-lab')` 把 `row-label.ts`、`approval-label.ts` 排除在硬编码文字检查之外 | 确认（单测先红，`a3-red.log`）。只排除文件名以 `-lab` 结尾的测试页。3fa9d21 |
| A4 中 | `check-i18n.mjs`：只查 JSX；`store/tasks.ts:157-164` 的 `formatDuration` 返回英文单位，`main.ts:114` 的 `showErrorBox` 只有英文 | 时长确认并修复（经目录的 `bgTasks.duration`）。0a983ca。检查规则的盲区与 `showErrorBox` 登记 I218 |
| A5 低 | `en.ts:807,997,1139,1180`：英文没有单复数（"1 comments not sent"） | 确认（`t35-worktrees` 甚至断言了"1 uncommitted changes"）。四条改为复数消息，L4 断言改为单数。0a983ca |
| A6 中 | `shell/Menu.tsx`：菜单关闭后焦点落到 body | 确认（组件测试先红，`a6-red.log`）。关闭时把焦点还给打开前的元素，条目自己移走焦点（重命名框）时不动。517b85d |
| A7 中 | `use-approval-focus.ts`：答复后焦点落到 body，第二张卡不取焦点 | 读码成立：登记 I217 |
| A8–A10 中 | `TerminalPanel.tsx:526-528` 等：查找条与重命名框的内联 ref 每次渲染抢焦点；关闭标签、评论编辑后焦点丢失 | 读码成立（A8 待运行核实）：登记 I217 |
| A11 中 | `DiffBody.tsx:141-151`、`tools.tsx:376-380`：diff 的符号 `aria-hidden`，增删行对读屏器一样 | 确认（行组件测试先红，`a11-red.log`）。符号改为带名称的图像（新增、删除）。1118ef0。diff 表的名称并入 I217 |
| A12 中 | `rows/status.tsx` 等：虚拟列表里的 `role=alert` 行重挂载时重复播报 | 待读屏核实：登记 I217 |
| A13 低 | `Toasts.tsx`、`NoticeBar.tsx`：动态插入的 live region、8 s 消失、多条 alert | 登记 I217 |
| A14 中 | 13 处设置页错误提示没有 `role="alert"` | 确认（源码检查先红，`a14-red.log`）。13 处加上，源码检查守住"操作失败后显示的错误"（配置问题列表保持普通文本，避免逐条打断）。1809a13 |
| A15 中 | `Composer.tsx`：`@` 与 `/` 候选框与编辑器没有 combobox 关联 | 登记 I217 |
| A16、A17、A19、A20 低 | tab 没有方向键；`Dialog` 的可聚焦选择器；相同文本不再播报；溢出检查覆盖面；`▾` 进按钮名称 | 登记 I217 |

### 工程质量（Q）

| 编号 | 位置与失败场景 | 核实结论与处理 |
|---|---|---|
| Q1 中 | 同 P1 | 9f5ec0a |
| Q2 中 | `plugins/mod.rs`、`fetch.rs`：async 函数里的同步文件 I/O，`let _ =` 没有注释，卸载时删数据目录失败不进结果 | 成立：登记 I219（T48） |
| Q3 中 | THR-13 的 OSC 8 对策在 Windows 没有运行的测试 | 同 I209：登记 I220（W4） |
| Q4 低 | `t40-plugins.e2e.ts:155`、`t43-keyboard.e2e.ts:77`：真实时钟下的固定等待 | 并入 I176（T48） |
| Q5 低 | `piarc-config` 的 `plugins/manifest.rs::read`、`piarc-telemetry` 的 `bundle.rs`、`zip.rs` 没有错误枚举 | 并入 I173（T48） |
| Q6 低 | `strip_verbatim` 的重复实现与语义不一 | 并入 I175（T48）；复用表补登（e64b420） |
| Q7 低 | `coding-standards.md` 写 16 步、沙箱会话一行过期、复用表缺 T39–T45 与 W3 | 确认并修复：17 步、沙箱会话改写、补 9 行。e64b420 |
| Q8 低 | `crates/piarc-core/AGENTS.md` 138 行、`apps/desktop/AGENTS.md` 122 行；`piarc-diff/AGENTS.md:26` 过期；T42 的 Core 约定不在 AGENTS.md | `piarc-diff` 一句已改（e64b420）；拆分与补登登记 I221 |
| Q9 低 | `piarc-store/src/index.rs` 1,017 行（M4 越线）等 | 登记 I221（往里加内容的任务先拆分） |
| Q10 低 | 业务代码里的平台分支（`terminals.rs:118`、`exec/launch.rs:76`、`hooks.rs:332`） | 并入 I174（T48） |
| Q11、Q12 | 只给测试用的代码在生产模块里；整文件平台门控的测试没有 NOT RUN 说明 | 登记 I219 |

### 交给 R5 的登记事项

T45、T44、W3 把 26 项交给 R5。处理（每项在 `PLAN.md` 登记事项的"建议处理"列末尾写了 **R5** 说明）：

- 修复：I120（Grep、Glob 结果去掉 `Read(…)` deny 覆盖的文件，L2 先红，cf76d24）、I209 与 I210 的已知原因（cc4ec00：`t35-worktrees` 是真实缺陷，提示的长路径把按钮挤到侧栏下面，先有失败的 L4；`t35-windows` 按显示器工作区取期望位置；`t44-recovery` 容忍重载中的帧）、I208（W3 已修，CI 上确认）。
- ADR 提议：I26（ADR-0063）、I79（ADR-0064）。
- 交 T48（M5 Harness 补全），进入 R6 前完成：I56、I94、I121、I123、I126、I172、I173、I175、I176、I178、I197、I199。理由：都是 M4 之前的功能在正确性、纵深防御或工程质量上的余项，规模超出评审，且不影响 M4 的退出标准。
- 交性能达标任务（I222，计划变更）：I190–I194；I196（Electron 升级）随 T50 或该任务。
- 交 W4：I203、I207，以及 I209 的 Windows 余项（I220）。
- 交推送后的 CI 复核：I210 中本机在 1024×677 窗口下不能复现的三处（`t34-terminal` 双击选词、`t18-sessions` 归档后的临时目录、`terminal.e2e` 帧数）。

## 5. 重新评估的触发条件

| ADR | 条件 | 结果 |
|---|---|---|
| ADR-0010（进程模型） | 无法规避的跨会话状态串扰 | 未触发：M4 的插件与扩展按会话重开，MCP prompts 在工作区池内；审查没有发现会话之间的状态串扰 |
| ADR-0013（Electron） / 第 14 章 R1 | 内存或启动超出 30% 且无法优化 | 未触发：RSS 口径的"应用全部进程合计"超出约 2%（519 / 510），物理占用口径在预算内；主进程增量超出 35%（32.5 / 24 MB），但 M0 时为 5–8 MB，增长来自 M1–M4 加进 Core 的子系统，属可优化（I192）；按 R1 的规则在性能达标任务（I222）里先优化，优化后仍超出 30% 再复审 |
| ADR-0056（沙箱） | 常见 MCP server 必须放宽 Agent Host 的写入范围才能运行 | 未触发：S1 的修复收紧了 `<pi>` 下的写入，`sessions sandbox::`（npx MCP server 只写允许的位置）与受影响的 L2 通过 |
| ADR-0057（Windows 隔离） | MXC 的 Git Bash 问题修复、遥测可关、ProcessContainer 覆盖主流版本 | 未复核外部条件（R6 之后的 MXC 评估任务负责，I177） |
| ADR-0062（安全收口） | 威胁映射的待补项所属任务完成 | 未触发：THR-09 的两项 deferred 到 T50，T50 未开始 |

## 6. 质量门禁

- `npm run verify` 在收尾提交 4b7c223（工作区干净）17/17 通过：Vitest 161 个文件 1,758 通过（1 个 Windows 专属按平台跳过），cargo test 全部通过，L2 216 个场景 213 通过、0 失败、3 个按平台跳过，能力覆盖 MISSING 0，威胁映射通过（`tmp/evidence/R5/verify-final-2.txt`；`target/verify/last-pass.json` 记录 4b7c223）。
- 之前的两次全量：第一次有 Prettier、rustfmt 与覆盖表漂移三处格式问题（4b7c223 修正）；第二次只有 `crates/piarc-core/tests/state.rs` 的 `editing_settings_while_running…` 超时（20 s 内没有设置事件）。同一用例在开工基线也超时过，单独连跑三次通过（`state-watch-rerun.log`）：设置监听在高负载下迟到（I185），本机测量期间负载均值约 6。没有放宽等待时间，登记在 I185 由 T48 定位。
- 开工基线（16c6d41 合并 W3 之后）：14/17。Prettier（W3 带来的 `plugin-commands.yaml`，a94a03c）、上面同一个设置监听用例、第 17 步（本任务进行中的映射改动）。
- 全量 L4（两种形态，开发构建打包于 1118ef0 之后，`PIARC_EVIDENCE_TASK=R5 npm run test:e2e -w @piarc/desktop`）：341 通过、23 按平台跳过、3 失败（`tmp/evidence/R5/l4-full.log`）。`t18-review` 两种形态失败于 `screencapture -l`（终端没有"屏幕录制"权限，与 R3、R4 相同）；`t34-terminal`"a user terminal is not shared until the switch is turned on"打包形态一次面板 20 s 内空白，单独重跑三次通过（`l4-t34-rerun.log`），记入 I210 的待复核项。R5 修改波及的 `t35-worktrees`、`t35-windows`、`t44-recovery`、`t39-sandbox`、`t45-ipc-hardening`、`t43-*`、`t42-comments`、`t32-background`、`t28-rewind` 都通过。
- 修复的红绿日志在 `tmp/evidence/R5/`：`s1-*`、`s4-*`、`s5-*`、`s8-*`、`s11-*`、`p1-*`、`i120-*`、`a3-*`、`a6-*`、`a11-*`、`a14-*`、`notice-red.log`、`l4-fixes-green.log`、`thr14-red.log`。
- Windows 交叉 clippy 没有运行：R5 没有改 `cfg(windows)` 代码、平台模块或带 C 代码的依赖；Windows 上的影响（`state::sources` 的路径、沙箱只在 macOS）由推送后的 CI 核对。
- 界面改动（设置页错误播报、diff 符号名称、菜单焦点、提示行换行、沙箱放宽的确认）都有 L4 或组件测试；提示行的截图在 `tmp/evidence/R5/l4/t35-worktrees.e2e.ts-start-…/worktree-session-light.png`。没有改提示词，不需要原创性检查。

## 结论

- **M4（macOS）未达标。** 安全一条本地满足、CI 证据要等推送；性能一条不满足（第 1.2 节的超出行）。M4 的功能全部交付并有验收证据，能力清单里 M4 及之前没有 `planned` 的能力。
- **进入 M5（T46）的前提条件**：见开头"进入 M5 的前提条件"1–4。其中 1（ADR-0063）与 3（性能达标任务的排期）阻塞 M4 的退出判定；用户可以决定在 M4 退出判定之前先开始 T46（设计关口，不依赖这几项），与性能达标任务并行，但 R6 之前两者都要完成。
- R5 本身的状态：变更型的 ADR-0063、ADR-0064 等用户确认；其余交付物已完成。

## W4 需要在 Windows 上验收的 M4 项

| 项 | 为什么 | 怎样核对 |
|---|---|---|
| 沙箱不可用的提示（T39-A12） | Windows CI 输出要推送后产生 | CI 的 L2 `sandbox-windows-not-applied` 与 L4 `t39-sandbox` 的 Windows 用例；实机看设置页、环境栏与配置诊断 |
| 可操作通知（T42-A07、I187） | Windows Toast 的按钮只在 macOS 测过（测试替身） | CI 的 `attention.test.ts`；安装后实机等待审批时点 Toast 的"仅本次允许"与"拒绝"，看审计来源"通知" |
| 威胁映射的 Windows 结果（T45-A02、R5-A01） | 映射测试在 Windows CI 上的结果 | 推送后的 Windows verify 第 17 步与 L4 映射用例 |
| THR-13 的 OSC 8（I220） | Windows 上没有运行的测试 | 补 `t45-xss` 的 Windows 变体并加进映射 |
| 插件与 Pi 包 | 内置 npm、git 克隆与 `core.longpaths` 只在 W3 修过（I203 本地深路径） | `cargo test -p piarc-core --lib plugins::`（含 R5 的 `.npmrc` 用例，Unix 门控，Windows 用 `.cmd` 脚本补一份）；L2 `plugin-*`、`pi-package-git`；I203 实测 |
| NotebookEdit 的 CRLF | `fixtures/crlf/` 的 notebook 向量 | `cargo test -p piarc-fs notebook` 与 `npx vitest run agent-host/src/tools` 在 Windows 通过 |
| 配置诊断全部来源 | Windows 路径分隔符（R5 修了测试辅助函数） | `cargo test -p piarc-core --test state sources`、L2 `config-diag-sources` |
| 用量与成本 | 与平台无关，确认 CI 通过 | L2 `usage-cost-session` |
| 无障碍与本地化 | 讲述人、NVDA 对 M4 新界面（插件、沙箱、用量、诊断包、diff 评论）；R5 改的 diff 符号名称、菜单焦点、设置页错误播报 | `accessibility.md` 第 3 节的两列；`t43-` 在 Windows 跑 |
| 性能（第 11 章 Windows 列） | W3 的数据来自非基准笔记本，9 项超出（I207）；CI 的 `github-x64` 没有基线 | 在基准机型或 CI Nightly（记录 `github-x64` 基线后）上判定；按 ADR-0063 的决定测私有工作集 |
| Windows 发布构建体积（I202） | 只测了开发构建 | T50 的发布流水线在 CI 上量 |
| 诊断包与外连（T45） | `t45-egress` 在 Windows 允许拼写词典主机（I198） | 首次在输入框键入时是否下载词典 |
| 内存（M3 与 M4） | 同 macOS 的口径问题（I201） | 按 ADR-0063 的决定判定 |
