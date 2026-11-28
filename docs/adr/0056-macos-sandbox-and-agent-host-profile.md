# 0056. macOS Bash 沙箱正式版与 Agent Host 配置定稿（补充）

- 状态：已接受，补充 ADR-0004 第 4 条、ADR-0005、ADR-0015 第 2 条、ADR-0028、ADR-0031、ADR-0037
- 日期：2026-11-21
- 相关：架构第 6.2.1、6.2.3、6.10、8.2、9.2、10.1、10.3 节；T39；FR-TL-07；登记事项 I05、I34、I35、I36、I40、I54、I117、I133

## 背景

T11 验证了 Seatbelt 配置生成、本地域名代理与进程组终止（S8），沙箱只作为测试入口 `open_sandboxed_session` 存在；T12 给 Agent Host 套了一份宽松配置，定稿留到 M4。T39 把沙箱做成用户可用的功能，基线没写到的细节有：沙箱开关在哪一刻决定、配置何时生成、自动批准排在阶梯哪一步、沙箱外重试怎样询问、白名单外域名怎样问用户、项目配置能改什么、拒绝怎样告诉模型、Agent Host 的配置写到哪一层。

事实（2026-11-21）：

- Claude Code 的 `sandbox` 键（官方 settings reference 与 sandboxing 页，无日期）：`enabled` 默认 false；`autoAllowBashIfSandboxed` 自 v2.1.324 起默认 false；`filesystem.denyRead`、`network.allowedDomains` 为路径与域名列表；Bash 的沙箱外重试参数是 `dangerouslyDisableSandbox`；`bypassPermissions` 下 Claude Code 的重试与白名单外域名都不询问，项目文件可以追加域名。
- Pi 1.5.2 的 `SettingsManager` 只要项目设置文件 `<cwd>/.pi/settings.json` 存在，读它之前就用 proper-lockfile 建 `.pi/settings.json.lock` 目录（`dist/core/settings-manager.js` 的 `withLock`）；拿不到锁时整个项目设置不读。
- `sandbox-exec` 被拒绝时程序看到 `EPERM`，各自打印 "Operation not permitted" 与路径；系统日志里的沙箱违规在本机未授权时读不到。

## 决策

1. **沙箱随调用的授权走。** `policy/evaluate` 判 Bash 与 Monitor 调用时决定它是否在沙箱中运行（合并设置开启、平台有可用的沙箱、模型没有请求沙箱外），结果记在调用的授权里，`exec/run`、`exec/monitor` 消费授权时取出。因沙箱而自动批准的命令一定在沙箱中运行；设置在批准与执行之间被关掉时，命令仍按批准时的决定运行。
2. **配置按命令生成。** 每条沙箱命令启动前按当时的合并设置生成 Seatbelt 配置（工作区或 worktree、会话临时目录、`permissions.additionalDirectories` 可写，`PROTECTED_PATHS` 禁写，`denyRead` 拒读），不跨命令缓存；会话的代理随第一条沙箱命令启动、随会话关闭停止，白名单在每次启动命令时替换。改设置后的下一条命令即按新设置执行，不重启 Agent Host。
3. **设置键与来源。** 键沿用 Claude Code 的 `sandbox.enabled`、`sandbox.autoAllowBashIfSandboxed`、`sandbox.filesystem.denyRead`、`sandbox.network.allowedDomains`（语义相同，`.claude/settings*.json` 的同名键经兼容层只读并入）；其余 `sandbox.*` 键在映射表中逐条标为忽略并写原因，`network.allowManagedDomainsOnly` 标为 T47。项目文件只能收紧：开启沙箱、追加 `denyRead` 生效；追加域名、打开自动批准、关闭沙箱在合并前去掉，配置诊断标"项目级不生效"（`projectSandbox`），理由同第 6.2.1 节项目级 bypass 不生效。允许域名取用户两层（PiArc 与 Claude Code）与企业来源的并集；企业来源由 T47 接入，T39 用测试替身（`SandboxConfig.enterprise`，开发构建的 `PIARC_TEST_SANDBOX_ENTERPRISE_DOMAINS`）验证合并与只读展示。`denyRead` 的相对路径在项目文件里相对项目根，在用户文件里相对文件所在目录。
4. **自动批准在第 7 步。** 沙箱内自动批准是"模式默认"的一种，排在 allow 规则之后、越界询问之前：企业 deny、PreToolUse hooks、deny 与 ask 规则、关键路径删除、无法静态判定、plan 模式的拒绝、受保护路径的询问都先于它。越界读取与改变命令解析的前置赋值不阻止自动批准（沙箱照样限制它们）。Monitor 不享受自动批准（与只读白名单不放行 Monitor 一致）。
5. **沙箱外重试。** `dangerouslyDisableSandbox: true` 只在沙箱生效时有意义（否则忽略）。它在 deny 规则之后成为必问的一步（`unsandboxed`）：任何模式（含 `bypassPermissions` 与自动批准）都询问，allow 规则与 PreToolUse 的 allow 不跳过它，PermissionRequest hooks 不代答（`after_permission_request` 跳过这一步），plan 模式下的非只读命令仍拒绝。审批卡标"在沙箱外执行"、显示完整命令，只提供仅本次允许与拒绝（Core 拒绝其他答复）。与 Claude Code 的差异是有意的：一次沙箱外执行等于暂时关掉这层防线，只让用户本人决定。
6. **白名单外域名。** 代理把白名单外的主机交给 Core（`ProxyHooks::unlisted`），连接挂起，Core 在会话的审批账本放一张"权限扩展（网络域名）"卡（工具名 `SandboxNetwork`，字段 `domain`）：仅本次允许放行这个连接、本会话允许记入会话、"加入白名单"经主进程原生确认后写入用户级 `sandbox.network.allowedDomains`、拒绝或 60 秒内无人回答时连接得到 403。卡片不经裁决阶梯，任何模式都问，hooks 不能代答；回合结束与连接断开不撤卡（后台命令也会发起连接），卡随回答、超时或会话关闭结束。
7. **拒绝的反馈与审计。** 代理的拒绝立即写 `audit_events`（`kind: "sandbox"`）。前台命令失败时 Core 从输出里取 "Operation not permitted" 所指的路径，只保留被本条命令策略禁止的（工作区外、受保护路径、`denyRead`），连同本条命令期间代理拒绝的主机写进结果的 `sandbox.denials` 与审计；Agent Host 在工具结果里列出被拒的路径与主机，并提示可以带 `dangerouslyDisableSandbox` 请求沙箱外执行（用户须批准）；没有识别出具体项时说明沙箱的边界与不走代理的工具（ssh、UDP）不能联网。后台命令只审计代理的拒绝。设置页的审计按"沙箱拒绝"筛选。
8. **沙箱不可用。** 平台没有沙箱（Windows）、`/usr/bin/sandbox-exec` 缺失、或命令输出显示 `sandbox-exec` 自身启动失败（风险 R10）时，命令不经沙箱、按普通审批运行，自动批准随之失效；Core 在 `core/notices` 发一次 `sandboxUnavailable`，会话环境栏与设置页显示原因，配置诊断在 Windows 上把开启沙箱与自动批准的键标为"本平台不生效"（`platform`）。因沙箱启动失败而没跑成的命令返回 `failedToStart`，不自动改在沙箱外重跑。
9. **进程启动路径。** agent 能启动进程的路径各有归属：Bash 前台命令、`run_in_background` 后台命令、`exec/monitor` 的 Monitor 命令、`exec/run` 带 `terminal` 的终端承载任务在沙箱开启时都经同一包装运行；用户在终端面板里打开的终端、hooks、MCP server、LSP 与文件工具不进 Bash 沙箱（架构第 6.10 节）。清单与各自的测试写在 `crates/piarc-sandbox/AGENTS.md`。
10. **代理加固（I54）。** 同时服务的连接至多 256 个（满了 accept 循环等待，不耗尽描述符）；读请求头 30 秒、连上游 30 秒、隧道 10 分钟无数据即关闭；accept 失败退避重试；转发的 `Host` 一律改为目标主机。私网地址（10/8、172.16/12、192.168/16、100.64/10、fc00::/7）不拦：内网镜像与私有 registry 在那里，白名单只应写可信主机。
11. **Agent Host 配置定稿。** 配置模板入库（`crates/piarc-sandbox/src/seatbelt/agent-host.sbpl`，路径与受保护路径表达式经 `-D` 参数传入，生成结果有 golden）：读取、进程与网络放开；写入只限工作区（受保护路径除外，worktree 同样处理）、`<数据目录>/pi`、`<数据目录>/agent-host`、`<数据目录>/sessions/*/tmp` 与终端设备。数据目录的其余部分（用户设置、含信任决定与审计的数据库、保险箱、用户级 skills 与命令、shell integration 脚本、检查点、日志）对 Agent Host 及其子进程只读：这些位置被写入就等于越过信任或权限。Pi 读项目设置时要建的 `.pi/settings.json.lock` 单独放行。Agent Host 与它启动的 MCP server、npx 的 `TMPDIR`、`npm_config_cache`、`XDG_CACHE_HOME` 指向 `<数据目录>/agent-host/`。开发构建与测试（`AgentHostLaunch::Custom`）在 macOS 上同样套这份配置，全部 L2 场景在它之下运行。
12. **登记事项的处理。** I05：stdio MCP server 在 Agent Host 配置之下（第 6.10 节的"在沙箱外"指 Bash 沙箱），常见 registry 包的 npx 启动不需要放宽；I40：`npx <本地目录>` 仍因 chmod 被拒，维持 T36 的提示。I34：不把用户的 Cargo 配置复制进会话（可能含 registry token），镜像用户在命令环境里设 `CARGO_REGISTRIES_*` 或经沙箱外重试。I35：不加"允许本机绑定""允许写 `.git/config`"与 Unix socket 白名单，限制写在设置页。I36：脱离进程组的后代仍留在沙箱内，停止命令时不追踪它们，限制保留。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 会话打开时决定是否沙箱（T11 原型） | 实现简单 | 改设置要重开会话；自动批准与执行可能分开 | 否决 |
| 编译后的配置跨命令缓存 | 省约 8 ms/命令 | 设置变化可能不生效；S8 已测额外耗时来自 `sandbox-exec` 本身 | 否决 |
| 沙箱外重试按 Claude Code（bypass 不问、allow 规则放行） | 与参考一致 | 关掉防线不经用户；任务要求任何模式都问 | 否决 |
| 白名单外直接拒绝（`strictAllowlist` 式） | 无交互 | 每加一个域名都要去设置页 | 否决（用户可加入白名单后不再询问） |
| 读系统日志判断 Seatbelt 拒绝 | 不依赖程序的输出格式 | 需要额外授权，延迟高；CI 上不稳定 | 否决，改为输出加策略核对 |
| Agent Host 可写整个数据目录（T12） | 不会碰到意外的写入失败 | 扩展或 MCP server 能改用户设置、信任决定、用户级 skills，第二道防线形同虚设 | 否决 |

## 后果

- 正面：沙箱开关、模式、白名单与 `denyRead` 改动即时生效；自动批准与询问的位置可预测；第二道防线覆盖用户设置与信任数据；L2 全部场景在定稿配置下通过。
- 负面与代价：每条沙箱命令多约 8 ms；拒绝识别依赖程序打印路径，不打印的只能给出一般说明；写数据目录其他位置的 Pi 扩展与 MCP server 会失败（例如把缓存写到 `~/.cache` 的 server 需要 `XDG_CACHE_HOME`）；`git init`、Docker、ssh 在沙箱内不可用。
- 需要配套做的事：T47 接入企业来源（`allowManagedDomainsOnly` 等）；T45 的威胁模型测试复核第二道防线；Windows 的隔离方案见 ADR-0057。

## 重新评估的触发条件

- Apple 移除或改变 `sandbox-exec` 的行为，或 macOS 新版本上沙箱启动失败；
- 常见 MCP server 或 Pi 扩展因 Agent Host 的写入限制无法运行，需要放宽（放宽属于变更，另写 ADR）；
- Claude Code 改变 `sandbox.*` 键的语义；
- 拒绝识别漏报成为用户反馈的主要问题。
