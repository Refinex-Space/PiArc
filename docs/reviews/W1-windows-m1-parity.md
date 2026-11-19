# W1 · Windows 11 上的 M1 验收

**结论：M1 在 Windows 11 x64 上达标，UNC 一项未能在本机验证。** 两种严格 mock 协议在两种形态下都完成了"读代码 → 改代码 → 跑测试"，工作区路径含空格与中文；本机 L2 60 个通过；最终提交 `b0a510f` 上 `npm run verify` 15/15。全量 L4 在修复控制台窗口之前的构建上 199/199，在最终构建上 198/199，唯一失败的用例单独复跑通过。验收中发现并修复了 10 个 Windows 平台缺陷，每个都带回归测试；另有 2 项性能预算按 Windows 实测改为平台口径（ADR-0040、0041，用户采纳）。UNC 共享（本机 SMB 客户端不可用）与日文输入法（用户决定不安装语言包）未验证，W1-A05 因 UNC 标为 `blocked`，已登记。

## 环境

| 项 | 值 |
|---|---|
| 平台 | `win32` x64（`node -p "process.platform + ' ' + process.arch"`） |
| 系统 | Windows 11 专业版 25H2，版本 10.0.26200.9974；与 W0 同一台机器（S2 报告第 8 节） |
| 起点 | `b654341`（R2 收尾）；验收提交见文末 |
| 工具链 | Node 24，Rust 1.99.1，Git for Windows（`C:\Program Files\Git`），PowerShell 7 与 5.1 |
| 安装形态 | CI 运行 44453549786 的 `piarc-windows-x64-velopack`（起点提交的开发构建 0.0.2），按用户安装到 `%LOCALAPPDATA%\cn.piarc.desktop\`；修复后的行为用本机 `npm run package:desktop -- --flavor development` 的打包产物验证 |
| 安全设置 | 未改动。"检查应用和文件"关闭；安装包由 curl 下载，不带 `Zone.Identifier`，没有 SmartScreen 与 UAC |

证据目录 `tmp/evidence/W1/`（不入库）。

## 起点基线是红的

起点提交在 CI（运行 44453549786）与本机都不绿：两平台 ESLint 失败，Windows `cargo test` 7 项失败，L4 的 `agent-host.e2e.ts` 等失败。用户在本会话决定并入 W1 修复。另外，Windows 的 verify 作业在第一个失败的测试目标处停止（`cargo test` 没有 `--no-fail-fast`），R2 之后有 4 个测试目标从未在 Windows CI 上跑到；W1 用 `--no-fail-fast` 全量运行才发现它们（I97）。

## 检查表

| 检查项（验收项） | 结果 | 证据 |
|---|---|---|
| 平台、版本、架构、提交（A01） | 通过 | 本节"环境" |
| 完整任务，双协议，路径含空格与中文（A02） | 通过 | L4 `r2-workflow.e2e.ts` 两种协议 × 两种形态 4/4：初始 `node --test` 报 `ERR_ASSERTION`，Manual 下两张审批卡（Edit `sum.cjs`、Bash `node --test sum.test.cjs`），测试变绿，测试文件逐字节不变，每次 4 个严格校验的请求无违规。`tmp/evidence/W1/l4/r2-workflow*/`（before/after、三张截图）。用户决定不再跑真实服务商（R2 已有百炼记录） |
| L2 ≥ 20（A03） | 通过 | verify 第 14 步：60 通过、0 失败、2 个 macOS 专属按平台跳过（`verify-final.log`）；能力覆盖 MISSING 0 |
| Git Bash、隐藏后的提示、PowerShell（A04） | 通过 | 新 L4 `w1-windows-shells.e2e.ts` 两种形态 4/4：Bash 经 Git Bash 执行（`pwd -W` 报出工作区的 Windows 路径），PowerShell 在 Manual 下询问，两者中文输出完整；把 Git 的安装位置与 PATH 指向空处后，模型只拿到 `PowerShell`，主区出现"没有找到 Git Bash"提示与下载按钮。L2 `exec-windows-shells` 通过 |
| 路径（A05） | 通过（UNC 本机无法验证） | 盘符、含空格与中文：全部 L2 与 L4 的工作区；超过 260 字符（499 字符含中文）经完整预检写读一致；保留名与以点或空格结尾的名字在预检时拒绝且不留文件（修复见 F5）；大小写：`a_read_under_another_spelling…`、保护路径大小写用例；junction：经 junction 指向外部的读写都要求越界审批，已获准目录在授权期间改名被 Windows 拒绝（共享冲突 32）；Git Bash 挂载目录（`/tmp` 即 `%TEMP%`）下的 `cd` 跟踪（修复见 F3）。UNC：用户建了临时共享，但本机 `net view \\localhost` 报系统错误 1702，SMB 客户端不可用，测试打印 NOT RUN（I96） |
| 换行与编码（A05） | 通过 | L2 `tools-edit-preserves-encoding`（CRLF、BOM、GBK）、`piarc-fs` 写入用例（含损坏 UTF-16 拒绝写回）、`legacy_encodings_are_read_and_written_back`；子进程中文：`exec_commands` 的 PowerShell 与 Git Bash、`w1-windows-shells`、输入法核对中命令输出"输入法核对" |
| 进程树（A06） | 通过 | `piarc-exec` 终止用例 6/6（超时、取消、后台进程、运行时关闭、50 MB 管道）与 Job Object 三级树；8 个子孙 PID 经 `tasklist` 确认不存在（`process-tree.log`）；L4 `agent-host-kill.e2e.ts` 结束主进程后 Agent Host 子树退出；管道读取失败报失败（`a_failed_output_pipe_is_reported…`） |
| 凭据与数据目录（A07） | 通过 | 用户同意后，打包应用以正式方式启动（无测试开关、无 `--user-data-dir`）：`userData` 为 `%LOCALAPPDATA%\PiArc`；凭据管理器中只有 `master-key.cn.piarc.desktop.credential-vault`；重启后第二个会话拿到回复（读不到密钥时 Pi 报 "No API key found"）；数据目录 87 个文件（含 2 个日志）中没有合成密钥的 UTF-8 或 UTF-16 明文（`a07-run.log`、`a07/scan.json`）。另有 `PIARC_REQUIRE_KEYCHAIN=1` 的 `system_store`（测试条目建、读、删）、`credentials::login_and_one_refresh…`（数据目录、Agent Host 与 Bash 进程环境无明文）、`provider_settings_crud…` |
| 输入法（A08） | 通过（日文未验证） | CDP 合成：`composer.e2e.ts`、`t20-approvals.e2e.ts` 的输入法用例在全量 L4 中通过。实机：用户用微软拼音在 composer 中、审批卡待处理时逐项操作，7 项全部符合预期（`A08-ime-hand-check.md`）；mock 只收到任务、命令结果与"你好"3 个请求，合成期间没有误发送 |
| 通知与任务栏（A09） | 通过 | 见"系统通知（A09）"；点击 Toast 从通知中心打开会话登记 I98 |
| 外观（A10） | 通过 | `t18-review` 在 Windows 截取真实窗口：右上窗口控件、标题栏覆盖层的按钮颜色随亮暗切换，侧栏透出 Mica（`A10-mica-light.png`、`A10-mica-dark.png`、`A10-dark-high-contrast.png`） |
| L4（A11） | 通过 | 修复控制台窗口前的构建全量 199/199（10.2 分钟）；最终构建 `b0a510f` 198/199，`t18-review` 的悬停按钮被实机鼠标打断，单独复跑通过（`l4-final.log`） |
| R2 平台发现（A12） | 通过 | 见"R2 清单逐项" |
| verify（A13） | 通过 | 最终提交 `b0a510f` 上 `npm run verify` 15/15（`verify-final.log`）。此前一次紧接全量 L4 运行时，权限裁决 p95 11.17 ms 超过 10 ms 而失败，复跑通过；这台机器上安静时为 7.7–8.9 ms，余量小（I95） |

### 系统通知（A09）

用户临时打开了系统通知总开关（W0 时为关闭）。安装后的应用与本机打包产物都使用 AUMID `cn.piarc.desktop`，开始菜单有对应的快捷方式。

- 窗口最小化后，"“Wait in the background…”需要你审批"与"…已完成"两条 Toast 都弹出（主进程记录 `shown: true`），用户确认看到。
- 任务栏按钮出现计数覆盖图标（`attention().count` 为 1）。用户截图显示它是锯齿明显的方块（`A09-taskbar-overlay-before.png`）：16 px 硬边圆点在缩放显示下被放大。已改为 32 px、边缘抗锯齿、缩放系数 2（F10，`A09-overlay-old-x8.png` 与 `A09-overlay-new-x4.png` 对比）。
- 点击 Toast：起点构建中点击审批 Toast 只把窗口带到前台、不打开会话，原因是通知对象未被持有（F9）。修复后，横幅仍在屏幕上时点击，2 秒内打开目标会话（`notify-click-run1.log` 中的 MATCH）；Toast 进入通知中心后点击走 COM 激活，只聚焦窗口或启动了别的 Electron 程序（开发构建与正式版共用 AUMID），登记 I98 交 T42。
- 另有两次早期运行在 30–60 s 内没有发出通知请求，之后同样的操作立即发出，原因未查明（I99）。

A09 的验收内容（窗口不在前台时回合完成与等待审批都弹出系统通知、任务栏覆盖图标显示计数）通过；点击后的跳转按 T42 的范围登记。

## 发现的问题与处理

每项都先写能在 Windows CI 复现的失败测试（F3 的 L2 场景、F9 的模拟除外，见各行），再在平台适配层修复。

| # | 问题 | 处理 |
|---|---|---|
| F1 | verify 的 ESLint 先于 `tsc --build`，读到 `@piarc/protocol` 过期或缺失的 `dist` 类型，两平台 CI 失败 | verify 改为先 `tsc --build`（77ea56c），同步编码规范的步骤号 |
| F2 | 测试在 `Scope` 释放前删除临时目录：cap-std 打开目录时不共享删除（ADR-0036），Windows 共享冲突 | 测试按字段顺序先释放 scope（2f21a6c）；同类问题见 4d7ed60 |
| F3 | Git Bash 的 `pwd -P` 报出挂载名（`/tmp` 即 `%TEMP%`），转换不回 Windows 路径：工作区在 `%TEMP%` 下时每次 `cd` 都被当成越界 | Windows 上 trap 用 `pwd -W`（d9ee057），`cwd` 单元测试先红后绿；本机 L2 的 3 个 exec 场景随之通过 |
| F4 | PATH 中当前用户无权访问的条目（常见的 `system32\config\systemprofile\…`）让 `safe_search` 整体失败，Accept edits 下 `mkdir`/`touch`/`cp`/`mv` 一律询问 | 跳过 `EACCES` 的条目，工作区内的条目仍拒绝，Git Bash 的实际解析另有探测（09c63c3），`icacls` 构造的 Windows 用例先红后绿 |
| F5 | 句柄相对的写入绕开 Win32 名字规则：`CON`、`aux.txt`、`CON.` 被写成资源管理器打不开、之后按路径也读不到的文件；`NUL` 报含糊的 `EINVAL` | `Scope::locate` 在 Windows 拒绝保留设备名与以点或空格结尾的名字（017b20b），先红后绿 |
| F6 | 列表宽度变化（Windows 经典滚动条约 12 px）时 `virtualizer.measure()` 清空行高，已挂载的行停在估算值上互相重叠；`t19-security` 6 次失败 5 次 | 宽度变化后对 DOM 中的行逐一重新测量（976649e），同一用例 4/4 且耗时由 40 s 降到 5 s |
| F7 | S6 探针在 T20 之后没有人批准预检，L4 `agent-host.e2e.ts` 的工具全被拒绝（两平台 CI） | 探针像 Agent Host 测试 harness 一样批准预检（33e3190） |
| F8 | PiArc 是图形界面进程，启动 git、bash.exe、PowerShell、Agent Host 时没有 `CREATE_NO_WINDOW`，每个都弹出控制台窗口（默认终端为 Windows Terminal 时报 `0x800700e8`），用户在 L4 期间看到大量弹窗 | 两个启动器都带 `CREATE_NO_WINDOW`（931a9bf）；测试先 `FreeConsole` 模拟图形界面父进程，修复前子进程拿到窗口句柄、修复后为 0 |
| F9 | 通知对象未被持有，Windows 上点击 Toast 不打开对应会话 | `Attention` 持有已显示的通知直到点击或失败，至多 32 条（5f2e1b7）；回收时机无法在测试中确定复现，单元测试以模拟的 Electron 断言持有与释放，用户实测点击后打开目标会话 |
| F10 | 任务栏计数覆盖图标在缩放显示下是锯齿方块 | 32 px、4×4 超采样的边缘覆盖率、缩放系数 2，单元测试断言尺寸与半透明边缘（先红后绿） |
| T1 | 测试与环境相关：`exec_commands` 断言命令自己的 `pwd -P`；目录改名被拒的错误码在 25H2 上是 32；慢读者用例 50 ms 心跳在负载下误判 | 按平台行为调整（4d7ed60）：心跳超时 500 ms 仍短于 2 s 停读窗口，6/6 |
| T2 | L4 依赖窗口在前台、英文文案或 5 s 的默认等待 | `t18-attention` 只断言完成通知并排除关闭中的窗口，`r2-workflow` 等待真实 `node --test` 至多 60 s，新用例同时匹配中英文（beb41a4、5db11d1） |

性能预算：无需用户参与的权限裁决 Windows p95 实测 3.4–8.9 ms（CI 3.35 ms），小文件 AHP 往返 5.0–9.3 ms，超出原 2 ms、5 ms。耗时分散在 NTFS 元数据调用与 ADR-0036 的逐级目录绑定上，降到原预算需要改变"每次读最新状态"或绑定方式。用户采纳 ADR-0040（Windows ≤ 10 ms）与 ADR-0041（Windows ≤ 15 ms），优化交 T23、T44（I95）。

## R2 清单逐项

| R2 清单 | Windows 结果 |
|---|---|
| 两种服务商、完整任务 | 见 A02 |
| L2 与 L4；I19 突发通知 | 见 A03、A11；I19：2,048 个 wire delta 后 `fs/stat` → `fs/read` 5.31 ms，提交到 `fs/stat` 137.9 ms（macOS 2.06、103.4 ms），单次观测，不改 AHP 通道（`i19-burst.log`） |
| Git Bash 与 PowerShell | 见 A04；I75（PowerShell 的 `Set-Location` 不跨命令保留）在 W1 的流程中没有造成问题，保留登记 |
| 进程树 | 见 A06 |
| 路径与文件 | 见 A05。真实 Git worktree 的反向登记：`worktrees_share_the_main_checkout…`、`worktrees_share_trust…` 在 Windows 通过。大目录取消：`composer::file_search` 与 `fuzzy::stops_when_cancelled` 通过 |
| 数据与凭据 | 见 A07；v3 → v4 索引迁移、等长重写与文件替换：`piarc-store` 全部通过（Windows 以创建时间识别替换） |
| 原生人工交互 | 见 A08、A09、A10；首次 SmartScreen 放行仍无法观察（"检查应用和文件"关闭，I49） |
| 评审发现 | 原生删除确认、无效 PDF、环境继承、工作树登记与审批清单版本：对应用例（`t18-sessions`、`attachments`、`exec-env-*`、`state`、`t18-trust`）在 Windows 通过。临时文件：Windows 上暂存文件继承目录 ACL，替换只带隐藏与系统属性、不保留 ACL 与备用数据流（`piarc-fs` 易错点），与 Unix 的 0600 不对应，按现有约定记录 |

## M1 退出标准的 Windows 证据

| 第 16 章目标 | Windows 证据 |
|---|---|
| 至少 2 家服务商完成读代码 → 改代码 → 跑测试 | `r2-workflow` 两种线协议 × 两种形态 |
| L2 ≥ 20 | 60 通过 |
| 单工作区、多会话、流式、持久化与恢复 | L2 `sessions-*`、L4 `t18-sessions`、`t19-transcript`；A07 中重启后继续使用 |
| Read/Write/Edit/Bash/Glob/Grep 与 PowerShell 经 Core | L2 `tools-canonical-via-core`、`exec-windows-shells`，L4 `agent-host.e2e.ts` |
| Manual 与 Accept edits | L2 `policy-*`（含 `policy-accept-edits` 修复后通过）、L4 `t20-approvals` |
| 模型与凭据保险箱 | A07、L4 `t21-models` |
| transcript P0 行类型 | L4 `t19-*`、`t20-*`、`t22-memory` |

T13–T22 中因需要 Windows 而为 `blocked` 的验收项：无（0 项），与 R2 的统计一致，没有需要用户更新的前序验收项。

## 登记与遗留

| 编号 | 内容 | 建议处理 |
|---|---|---|
| I95 | Windows 权限裁决与 AHP 往返的预算按平台口径，10 ms 在本机负载下余量小 | T23、T44 |
| I96 | UNC 工作区未实机验证，测试需 `PIARC_TEST_UNC_SHARE` | W2，或 T44 在 CI 设变量 |
| I97 | verify 的 `cargo test` 遇首个失败目标即停，掩盖了 Windows 失败 | T44 评估 `--no-fail-fast` |
| I98 | 从通知中心点击 Toast 不打开会话；开发构建与正式版共用 AUMID | T42 |
| I99 | 两次通知核对早期没有通知请求，原因未查明 | T42 |
| I100 | 设置页"刷新模型目录"勾选框等设置 Host 启动才变化 | T29 |

沿用的登记：I25（Windows 日文输入法未验证）、I49（SmartScreen 放行流程仍未观察，本机"检查应用和文件"关闭）、I75（PowerShell 目录不保留，W1 中未造成问题）。

本机状态：按用户同意，安装版 PiArc 0.0.2、`%LOCALAPPDATA%\PiArc\` 与凭据管理器条目 `master-key.cn.piarc.desktop.credential-vault` 保留；系统通知由用户临时打开，由用户决定是否关闭。Electron 在 `HKCU\Software\Classes\CLSID` 下为显示过通知的各个程序注册了 Toast 激活器（安装版、本机打包产物、`node_modules` 的 electron.exe），这是 Electron 的行为，W1 没有清理。

## 提交

起点 `b654341`，验收提交 `b0a510f`。代码修复：77ea56c、2f21a6c、33e3190、d9ee057、09c63c3、017b20b、976649e、931a9bf、5f2e1b7、b0a510f；测试：4d7ed60、beb41a4、b75d2bf、5db11d1、c6cc25f；ADR：e029f0d、6bedb45。
