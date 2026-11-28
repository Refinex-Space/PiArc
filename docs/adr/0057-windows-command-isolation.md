# 0057. Windows 上命令与 Agent Host 的隔离方案

- 状态：已接受
- 日期：2026-11-21（提议）；2026-11-21 接受（用户在 T39 中采纳）
- 取代：无
- 相关：架构第 6.10、10.3、14 章（R16）、15.2 节；需求 FR-TL-07、D7；ADR-0004 第 4 条、ADR-0015、ADR-0018；T39；`docs/research/native-stack.md` 第 8 章、`docs/research/electron-stack.md` 第 8 节

## 背景

需求 D7（2026-11-14 决定）：Windows 第一版不提供 OS 级沙箱，只靠权限规则与 Job Object 管理进程树，界面明确提示；M4 评估隔离方案，结论另写 ADR。T39 已在 Windows 上做到"不静默降级"：设置页的沙箱开关不可用并写明原因，配置开启沙箱或自动批准时会话环境栏提示、配置诊断标"本平台不生效"，命令照常按权限规则审批（ADR-0056 第 8 条）。

这份 ADR 评估要不要、以及何时在 Windows 上给两类进程加 OS 级隔离：

1. **Bash 沙箱**：agent 运行的命令（Git Bash 的 `bash.exe`、git、npm/node、cargo 与 MSVC `link.exe`、python）只能写工作区、会话临时目录与已添加目录，受保护路径禁写，网络只能经 Core 在 `127.0.0.1` 上的代理按域名白名单出去（与 macOS 相同的约束）。
2. **Agent Host 的第二道防线**（ADR-0004 第 4 条）：Node 进程本身向模型服务发 HTTPS 请求，只写工作区与数据目录里它自己的位置，经 npx 启动 MCP server。

PiArc 的硬约束：Windows 11 x64 与 arm64；Velopack 按用户安装，安装与运行都不要管理员权限；不签名、不出 MSIX（ADR-0018）；遥测默认关闭；Job Object（`KILL_ON_JOB_CLOSE`）继续管理进程树。

下面的事实于 2026-11-21 抓取原始来源核对，来源编号见文末"来源"；无法从一手来源确认的写"未验证"。

## 比较

| 候选 | 文件写入限制 | 网络只经本机代理 | Git Bash、git、npm、cargo、python | 系统覆盖 | 管理员 | 遥测 | 不签名、按用户安装 | 能否兼作 Agent Host 防线 | 工作量与维护风险（判断） |
|---|---|---|---|---|---|---|---|---|---|
| A. AppContainer（`CreateAppContainerProfile` + `SECURITY_CAPABILITIES`，含 LPAC）[L1][L2] | 能，但要给工作区与工具目录写持久 ACE | 不能只放行一个回环端口：没有网络 capability 就没有网络，`internetClient` 是任意出站；回环需要整机的豁免（`NetworkIsolationSetAppContainerConfig` 文档称"用于调试"[L3]），豁免是否要管理员未验证 | Git Bash 起不来：MSYS2 运行时建 `\BaseNamedObjects\msys-2.0S5-…` 被拒 [M6 #1061]；Codex 评估后放弃，原话 "wrong shape for agents that need shells, Git, and build tools" [C2] | Win11 x64、arm64 | 启动不要；回环豁免未验证 | 无 | 兼容 | 不能：模型请求要么开全量出站，要么依赖调试用的回环豁免 | 大；ACL 维护与 MSYS2 兼容都是长期负担 |
| B. MXC，`processcontainer` 后端（MIT，Rust 实现）[M1–M6] | 能（`readwritePaths`、`readonlyPaths`、`deniedPaths`；隐式只读基线） | 能做到"只连一个回环端口"（官方 Model 2：WFP 只放行配置的回环地址与端口，并设置 `HTTP(S)_PROXY` 与容器级 WinHTTP 代理），代价是要 `ingress.default: allow`（私网入站随之打开），未打包的 PiArc 代理属于文档所说的最低强度一档（"intended primarily for development and debugging"）[M3]；第三方实测在 26200.9711 上只有代理端口可达，原话 "closed by measurement, not by promise" [S] | Git Bash、`sh` 与 `usr\bin` 下的工具起不来，issue 未关 [M6 #1061、#1729]；git.exe、node、python、cmd、pwsh 有可用报告；cargo 与 MSVC `link.exe` 未验证；`%TEMP%` 每条命令新建并在结束时删除，npm/pip 缓存不保留 [S]；前台进程退出时其余后代被结束 [C3] | 只有 Win11：24H2 要 26100.9278、25H2 要 26200.9278（2026-08 的 KB5120998），还要等灰度推送（"Microsoft is rolling out"）[M2][C1] | 不要（v1.1.0 删掉了需要管理员的回退路径）[M5] | 预编译的 Windows 发布版发 4 类 Required 事件，"need no user consent… administrative policy does not block them"，请求里关遥测无效 [M1][M4][M5]；自己从源码以 release 构建并把 `MXC_TELEMETRY_COMPONENT_PATH` 置空可以不走路由 [M4]（这依赖构建开关，可能变化） | 调用方要不要签名，文档没写，推断兼容，未验证 | 较可行：Node 与 stdio 没有已知阻断，npx 拉起的 server 在同一容器里；Pi 的 HTTP 客户端是否遵守代理变量未验证 | 中等（Core 接 Rust crate）；风险高：项目 2026-02 创建、1.0.0 在 2026-10-07、1.1.0 刚改过遥测与回退策略 [M1][M5] |
| C. Win32 app isolation [W1][W2] | 隔离整个应用，不是单条命令 | 同 AppContainer | 未评估到命令级 | Win11 24H2+；仍是预览（"This feature is in preview"） | 未验证 | 无 | 不兼容：要 MSIX 或 "packaged with external location"，MSIX 必须签名 [W2] | 不适用 | 排除 |
| D. Windows Sandbox（Hyper-V 一次性 VM）[WS1][WS2][WS3] | 整机隔离 | 只能整体开关网络，经宿主回环代理出网的做法没有文档，未验证 | 每个实例都要重新安装 Git Bash 等工具，宿主软件不可见 | 不支持 Home 版；arm64 要 Win11 22H2+；同时只能运行一个实例 | 启用可选功能要管理员，可能重启 | 无 | 兼容但不实用 | 不适合 | 排除：启动要几秒、单实例、`wsb` CLI 的 exec 不支持进程 I/O |
| E1. 受限令牌加 ACL（Codex 的 unelevated 模式）[C1][C2] | 能（write-restricted token + 合成 SID，ACE 授给工作区；大工作区上写 ACL 慢） | 不能："Windows doesn't allow matching a firewall rule to the non-principal identity of a restricted token"，网络只能靠环境变量，属于建议性的 [C2] | 未见阻断报告 | Win10/11 全部 | 不要 | 无 | 兼容 | 只能限制写入，挡不住网络外传 | 中等；Codex 已把它降为旧版回退，不支持读拒绝 [C1] |
| E2. 独立本地账户加 WFP（Codex 的 elevated 模式、sandbox-runtime 的 Windows alpha）[C2][S] | 能 | 能（机器级 WFP 规则只放行到代理端口段的回环）；已知绕过：冒充 anonymous token、派生 deny-only token、经系统服务（SMB、Dnscache）的流量 [S] | 受限令牌下 Schannel 握手失败：cargo 自带的 libcurl、`curl.exe`、PowerShell IWR、`http.sslBackend=schannel` 的 git；Git for Windows 改用 OpenSSL 可用 [S]；个人目录下的工具要先授读权限 | x64、arm64 | 要一次提权安装（UAC）[C2][S] | 无 | 违反"不要管理员" | 可以但更复杂 | 大；跨用户 ACL 与 WFP 规则的安装、升级、卸载都要维护 |
| F. WSL2 路线（在 WSL2 里用 bubblewrap，Claude Code 的做法）[CC][WSL1][WSL2] | 能 | 能（bubblewrap 删网络命名空间 + socat 转发）| 跑的是 Linux 工具链，不是 Git Bash 与 MSVC；调用 Windows `.exe` 不受 bubblewrap 约束；`/mnt/c` 跨文件系统慢 [WSL2] | Win10 2004+、Win11 | `wsl --install` 要管理员与重启 [WSL1] | 无 | 兼容 | 不适用（Agent Host 是 Windows 进程） | 大；与 PiArc 以 Windows 原生工具链为主的定位不符，可作为以后的可选模式 |
| G. 维持现状（权限规则 + Job Object） | 无 OS 级限制 | 无 | 全部可用 | 全部 | 不要 | 无 | 兼容 | 无 | 最小；与 Claude Code 在原生 Windows 上一致："On native Windows, Claude Code runs commands unsandboxed" [CC] |

## 决策

1. **到 Beta 维持现状（方案 G）**，并保留 T39 已做的提示：设置页、环境栏、配置诊断写明 Windows 上命令不在 OS 沙箱中运行，自动批准不生效，命令按权限规则审批；Job Object 照常结束整棵进程树。
2. **不做 A、C、D、E2、F。** A 跑不了 Git Bash 且挡不住网络；C 要签名的 MSIX；D 不适合按会话或按命令使用；E2 要管理员；F 换掉了工具链。E1 只能限制写入、网络仍可外传，单独上线会让用户误以为有沙箱，不做。
3. **把 MXC `processcontainer`（方案 B）列为 Beta 之后的候选，先做验证、不上线。** 建议在 R6 之后（Beta 发布评审通过后）安排一个评估任务，在满足下列全部条件时以"实验性、默认关闭"的选项引入：
   - 从 `mxc-sdk` 源码自己构建，并确认遥测不走路由（release 构建置空 `MXC_TELEMETRY_COMPONENT_PATH`，用 ETW 抓 `Microsoft.MXC` provider 核对）；
   - **先用于 Agent Host 的第二道防线**（Node 与 stdio 没有已知阻断），验证模型请求、会话 JSONL、npx 拉起的 MCP server 照常工作；
   - **Bash 沙箱等 Git Bash 问题（#1061、#1729）修复之后再进容器**，或产品决定在容器里改用 PowerShell / BusyBox 版 MinGit；
   - 系统不满足最低版本或探测不到 ProcessContainer 时与今天一样明确提示"不可用"，不静默降级。
4. **`piarc-sandbox` 保持平台无关的接口**（`CommandSandbox`、`SessionSandbox`、`ProxyHooks`），Windows 后端以后作为新的 `CommandSandbox` 实现接入；本 ADR 不新增 Windows 代码。
5. 验证的最小实验（手动触发的 CI 作业或本机虚拟机，实验代码不进入发布产物）：
   - 在 `windows-11-arm`（Win11 Enterprise 26200.9974，arm64）上调用 `mxc-sdk` 的探测，看 ProcessContainer 是否可用；`windows-latest` 是 Windows Server 2025（26100），MXC 是否支持未验证；Win11 x64 只能用本机或虚拟机测；
   - 托管 runner 以管理员运行且关闭了 UAC，验证"不要管理员"要新建标准用户运行；以标准用户运行未签名的 Rust 测试程序；
   - Model 2 加未打包的本地代理：到代理端口可达，到其他回环端口、直连公网、UDP 53 被阻断，容器外能否连进容器的监听端口；
   - 典型命令：Git Bash 的 `bash -c` 加管道、`git status`、`npm ci`、`cargo build`（MSVC link 与 crates.io）、`python -m pip`；
   - Job Object 嵌套：Core 的 `KILL_ON_JOB_CLOSE` 能否结束容器内的整棵进程树；
   - AppContainer：以非管理员调用 `NetworkIsolationSetAppContainerConfig` 是否成功（补上方案 A 未验证的一条）。

接受后已做：架构第 6.10、10.3、15.2 节与第 14 章 R16 同步（2.50）；第 3 条的评估任务与第 5 条的实验登记在 `docs/plan/PLAN.md` 的 I177，安排在 R6 之后。

## 备选方案

见上表。主要的取舍是方案 B 与方案 G：B 是唯一能在不要管理员、不签名的前提下同时限制写入与网络的路线，但现在有 Git Bash 阻断、系统版本门槛与遥测问题；G 没有 OS 级边界，但不引入新风险，与 Claude Code 在原生 Windows 上的做法一致。

## 后果

- 正面：Beta 之前不引入一个年轻 SDK 的遥测与兼容风险；Windows 用户看到的是一致、明确的"不可用"提示；以后的接入点已经在 `piarc-sandbox` 的接口里。
- 负面与代价：Windows 上命令没有 OS 级写入与网络限制，只靠权限规则；提示注入诱导的命令在用户批准后可以写工作区外与外传数据（与 Claude Code 的原生 Windows 相同）；Agent Host 在 Windows 上没有第二道防线（架构第 10.3 节已登记）。
- 需要配套做的事：用户确认后更新架构与 R16；按第 3 条在 PLAN 登记 Beta 之后的评估任务与第 5 条的实验；T45 的威胁模型测试把"Windows 无 OS 沙箱"写进已接受风险。

## 重新评估的触发条件

- MXC 的 Git Bash 问题（#1061、#1729）修复，或产品决定在容器里不用 Git Bash；
- MXC 改变遥测政策（提供关闭开关，或取消构建时的关闭方式）；
- ProcessContainer 的灰度推送基本覆盖 24H2/25H2 用户；
- `mxc-sdk` 连续两个 minor 版本没有破坏性行为变化；
- Win32 app isolation 或 PSEC 提供面向未签名、未打包应用的"绑定代理身份"方式；
- Claude Code 或 Codex 在原生 Windows 上的默认方案改变；
- Windows 用户反馈中"需要沙箱"成为主要诉求。

## 来源（均于 2026-11-21 抓取）

- [M1] github.com/microsoft/mxc README，main@74c0f71（2026-11-20）
- [M2] mxc `docs/backends/process-container/os-version-support.md`
- [M3] mxc `docs/backends/process-container/networking.md`
- [M4] mxc `docs/telemetry.md`、`docs/development/architecture/telemetry.md`
- [M5] mxc v1.1.0 release notes（2026-11-15）；crates.io `mxc-sdk` 1.0.0 / 1.0.1 / 1.1.0（2026-10-06 / 10-17 / 11-14）；npm `@microsoft/mxc-sdk` 1.1.0（2026-11-14）
- [M6] mxc issues #1061（MSYS2 在容器内初始化失败，open）、#1729（打补丁后管道、子 shell、`git status` 仍失败，open）、#1464（`GetFinalPathNameByHandleW` 失败，第三方称 26200.9711 已修复）
- [S] github.com/anthropics/sandbox-runtime README，commit 41501a6（2026-11-11；npm 0.0.83）
- [C1] learn.chatgpt.com/codex/windows/windows-sandbox（页面无日期）
- [C2] openai.com/index/building-codex-windows-sandbox（2026-05-13）
- [C3] openai/codex `codex-rs/mxc-sandbox/README.md`（2026-11-18）
- [CC] code.claude.com/docs/en/sandboxing（页面无日期）
- [L1] learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer（ms.date 2023-07-20，updated 2025-09-03）
- [L2] learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox（2026-06-01）
- [L3] learn.microsoft.com/en-us/previous-versions/windows/apps/hh780593(v=win.10)（2015-08-31）；`NetworkIsolationSetAppContainerConfig`（ms.date 2022-08-02）
- [W1] learn.microsoft.com/en-us/windows/win32/secauthz/app-isolation-overview（ms.date 2024-10-01，updated 2025-05-15）；app-isolation-release-notes（2024-10-31）
- [W2] learn.microsoft.com/en-us/windows/msix/package/signing-package-overview（ms.date 2026-04-14）
- [WS1] learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/（ms.date 2026-03-29，updated 2026-10-08）
- [WS2] windows-sandbox-install（2026-03-29）
- [WS3] windows-sandbox-cli（ms.date 2024-10-22，updated 2025-01-24）
- [WSL1] learn.microsoft.com/en-us/windows/wsl/install（ms.date 2025-06-09）
- [WSL2] learn.microsoft.com/en-us/windows/wsl/compare-versions（ms.date 2024-11-19）
- GitHub 托管 runner：docs.github.com/en/actions/reference/runners/github-hosted-runners（`windows-latest` 为 Windows Server 2025，管理员运行、UAC 关闭；`windows-11-arm` 为 Win11 Enterprise 26200.9974）
