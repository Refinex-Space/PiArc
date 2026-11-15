# T39 macOS 沙箱正式版与 Windows 隔离评估

| 项 | 内容 |
|---|---|
| 阶段 | 5 M4 安全与打磨 |
| 依赖 | R4 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort xhigh，新会话 |
| 规模 | 大 |
| 关联验证项 | 无（以 S8 的结论为起点） |
| 关联需求 | FR-TL-07 |
| 需要的用户决定 | D7（已决定：Windows 第一版不提供 OS 级沙箱，M4 评估隔离方案，结论另写 ADR） |
| 关口 | 设计关口，只针对 Windows 隔离评估：评估结论写成 ADR（状态"提议"），提交后这部分停止，等用户决定；macOS 沙箱与 Agent Host 配置部分照常完成 |

启动方式：在仓库根目录开新会话，输入 `/task T39`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

T11 验证了 Seatbelt 配置生成、本地域名代理与 Job Object（S8），但沙箱还没有接到 agent 实际执行命令的路径上。本任务把它做成用户可用的功能：Bash 命令可选在沙箱中执行，两种审批模式，沙箱失败后的沙箱外重试，网络白名单与设置页。同时定稿 Agent Host 自身的 Seatbelt 配置：这是 ADR-0004 第 4 条的第二道防线，架构第 10.3 节把具体配置留到了 M4。

Windows 第一版不提供 OS 级沙箱（需求 D7）。本任务在 Windows 上做两件事：在设置页与沙箱开关处明确提示"不可用"；评估可行的隔离方案，写成 ADR 提议后停在关口。

完成后：macOS 上沙箱默认关闭，开启后默认"沙箱内仍审批"；Agent Host 运行在定稿的配置下且有测试覆盖；Windows 的提示明确，不静默降级；隔离方案 ADR 等待用户决定。macOS 部分完成后 T40 即可开工，不必等 Windows 关口。

## 必读

1. 架构设计：
   - 第 6.10 节"沙箱"、第 6.11 节中的 Bash 行为
   - 第 6.2.1–6.2.3 节（沙箱自动批准在裁决流程中的位置要与它一致）
   - 第 10.1 节"沙箱逃逸""恶意插件 / MCP server / Pi 包"两行，第 10.3 节中的"Agent Host"
   - 第 14 章 R10、R16，第 15.2 节"沙箱"行
2. ADR-0004（第 4、5 条）、ADR-0015（第 2、6 条）、ADR-0018（第 2 条）。
3. 需求规格 FR-TL-07、第 7 节 D7。
4. `docs/research/native-stack.md` 第 8 章、`docs/research/electron-stack.md` 第 8 节、`docs/research/claude-official-capabilities.md` A7.2。
5. `docs/spikes/` 中的 S8 报告（macOS 与 Windows 两部分）；T11、T17、T20、T23、T32 交付的 piarc-sandbox、piarc-exec、piarc-policy 代码与 CLAUDE.md；T12 中 Agent Host 的宽松 Seatbelt 配置。
6. 实现时查阅：
   - `sandbox-exec` 与 SBPL 语法（`man sandbox-exec`、系统自带的 `.sb` 配置）；
   - `@anthropic-ai/sandbox-runtime`（Apache-2.0）的 Seatbelt 与代理模型：只参照模型，复用代码须按许可证注明出处；
   - Windows 评估的原始来源：Microsoft Learn 上 AppContainer、Win32 app isolation、Windows Sandbox 的文档，`microsoft/mxc` 仓库文档。调研文档是快照，事实回到原始来源核对并记录日期。

## 范围

### 要做

- Bash 执行路径接入沙箱（macOS）：开关、两种模式；前台、后台与 Monitor 命令全部覆盖。
- 沙箱外重试，总是审批。
- 网络白名单（用户与企业来源）与沙箱设置页。
- Agent Host 的 Seatbelt 配置定稿与测试。
- Windows："不可用"提示；隔离方案评估 ADR（提议）。

### 不做

- 企业策略的读取与托管配置格式（T47）：本任务只在合并逻辑中预留企业来源，用测试替身覆盖。
- Auto 模式（T46）。
- Windows 上任何 OS 级隔离的实现。ADR 获批后若决定实现，由用户在 PLAN 中另行安排。
- 把 hooks、MCP server、文件工具纳入 Bash 沙箱：第 6.10 节规定它们在沙箱外，受项目信任与权限规则约束。
- 用户在终端面板中自己输入的命令（T34）不进沙箱。

## 交付物

### 1. Bash 执行路径接入沙箱

- 设置：沙箱开关默认关闭（FR-TL-07"可选开启"）；两种模式："沙箱内仍审批"（默认）与"沙箱内自动批准"。语义相同时键名沿用 Claude Code 的 `sandbox.*`（实现时对照官方文档核对），`.claude/settings*.json` 中的对应键经兼容层只读加载。
- 来源约束：项目级配置只能收紧（开启沙箱、追加 `denyRead`），不能放宽（添加白名单域名、切换为自动批准）。被拒的项目级键在配置诊断中标为"项目级不生效"，理由与第 6.2.1 节"项目级 bypass/auto 不生效"相同。
- 执行：沙箱开启时，前台命令、`run_in_background` 后台命令与 Monitor 命令都经 T11 的配置生成器在 Seatbelt 中执行：写入限于工作区、会话临时目录与已添加目录，受保护路径禁写，`denyRead` 生效，网络只能经 Core 代理。
- 裁决：自动批准作为第 6.2.3 节第 7 步"模式默认"的一种，排在企业 deny、PreToolUse hooks、deny 与 ask 规则之后；关键路径删除仍询问，plan 模式下的非只读命令仍拒绝。把这个位置写进架构第 6.2.3 节（补充型）。
- 沙箱拒绝的反馈：命令失败且检测到 Seatbelt 或代理拒绝时，工具结果写明被拒的路径或域名，并提示可以请求沙箱外重试；拒绝记录写入 `audit_events`（第 9.2 节已列出"沙箱拒绝"）。
- 沙箱不可用（`/usr/bin/sandbox-exec` 缺失或启动失败，风险 R10）：降级为只靠权限控制并明确提示，自动批准随之失效。

### 2. 沙箱外重试

- Bash 工具增加请求沙箱外执行的参数。参数名与 Claude Code 一致，便于 hooks 的 `tool_input` 兼容；描述文字自写。
- 这类请求与关键路径删除同级：任何模式（含 `bypassPermissions` 与沙箱自动批准）都询问。审批卡标明"在沙箱外执行"并显示完整命令，只提供"仅本次允许"与"拒绝"（可附反馈），不提供本会话允许与总是允许。
- PermissionRequest hooks 不代答这类请求，只接受用户答复；在报告中说明这个取舍。审批结果写审计。

### 3. 网络白名单

- 来源：用户设置与企业来源取并集。企业来源由 T47 接入，本任务用测试替身验证合并结果，以及企业条目在界面中只读。
- 沿用 T11 的代理与域名语法，补齐两点：修改白名单后下一条命令立即按新白名单执行，不重启 Agent Host；代理拒绝写入审计。
- 白名单外域名的审批：沙箱内命令访问白名单外的域名时，代理先挂起该连接并经审批账本发出"权限扩展（网络域名）"审批卡（架构第 8.2 节）。选项为仅本次允许、本会话允许、加入用户白名单、拒绝；拒绝或超时（默认 60 秒）时连接被拒。bypass 模式下同样询问，hooks 不能代答。

### 4. 沙箱设置页

- 设置窗口"沙箱"页：开关、模式、网络白名单（增删改，标明来源，企业条目只读）、`denyRead` 列表、当前生效的写入范围预览、跳转到按"沙箱拒绝"筛选的审计页。
- 文案中英文；Playwright 用例与亮/暗截图放在 `tmp/evidence/T39/`。

### 5. Agent Host 的 Seatbelt 配置定稿

- 按第 10.3 节：读取广泛放开；写入限于工作区、PiArc 数据目录、会话临时目录；网络允许。配置模板入库，生成函数有 golden 测试。
- 子进程继承这份配置：Agent Host 经内置 npx 启动的 MCP stdio server、Pi 自身写缓存的位置都要落在允许范围内。把 npm 缓存、`TMPDIR` 等指向数据目录或会话临时目录，并用测试覆盖 npx 启动 MCP server。
- 第二道防线的测试：用测试专用扩展模拟第三方 Pi 扩展向用户主目录写文件，写入失败；模型请求、会话 JSONL、MCP 不受影响。
- 第 6.10 节说的"MCP server 在沙箱外"指 Bash 沙箱；MCP server 仍受 Agent Host 配置约束，这一点写进 piarc-sandbox 的 CLAUDE.md。若常见 MCP server 必须放宽写入范围才能运行，属于放松安全基线，按变更型处理。

### 6. Windows 提示

- 设置页的沙箱开关不可用，旁边提示"Windows 上沙箱不可用：命令不在操作系统沙箱中运行，只受权限规则约束"（中英文）。
- 配置（含 `.claude/settings*.json`）在 Windows 上开启了沙箱或自动批准时：会话环境栏显示提示，配置诊断标出"本平台不生效"，命令照常按权限规则审批，不会被自动批准。
- Job Object 进程树管理保持不变。

### 7. Windows 隔离方案评估（设计关口）

- 候选：AppContainer、MXC（`processcontainer` 后端）、Win32 app isolation、Windows Sandbox、受限令牌加 ACL 或独立本地账户加 WFP（Codex、sandbox-runtime 的做法）、WSL2 路线、维持现状。
- 比较维度：文件写入与网络限制能力；能否运行 Git Bash、git、npm、cargo、python；系统版本覆盖（Windows 11 x64 与 arm64）；是否需要管理员权限（Velopack 按用户安装）；遥测（MXC 的 Windows 构建带不可关闭的 Required 遥测）；与不签名分发（ADR-0018）是否兼容；能否兼作 Agent Host 的第二道防线；工作量与维护风险。
- 事实注明来源与日期，无法验证的写"未验证"。需要时可以在 Windows CI 上做最小实验佐证关键事实，实验代码不进入发布产物。
- ADR：编号取 `docs/adr/` 最大编号加一，状态"提议"，按模板写背景、比较表、推荐（含建议的实施时间点）、后果与触发条件，同步更新 `docs/adr/README.md` 索引。
- 提交后，看板状态改为"阻塞（等待用户确认 ADR-xxxx）"，报告中列出需要用户决定的要点。用户确认后续做：ADR 改为"已接受"（或按用户意见修改后接受），同步更新架构第 6.10、10.3、15.2 节与第 14 章 R16；若决定实现某个方案，把实现工作登记到 PLAN"登记事项"。

## 实现要点

- 逐一列出能让 agent 启动进程的路径：Bash 前台、后台、Monitor，以及 T33 中由 agent 启动的终端承载任务。每条路径在沙箱开启时要么经过沙箱，要么被禁用；清单写进 piarc-sandbox 的 CLAUDE.md，每条各有一个测试。
- 每条命令的 Seatbelt 配置随命令生成，不跨命令缓存；改设置后的下一条命令必须用新配置。
- 代理环境变量同时设置大写与小写形式。不走代理的工具（ssh、UDP 类）在沙箱内失败属预期，工具结果中说明原因。
- 网络与 DNS 测试沿用 T11 的本地夹具，不依赖外网；常见构建命令的测试按 T11 的方式访问 registry。
- Windows 提示的证据来自 Windows CI 上的 Playwright 断言与截图产物，不在 macOS 上伪造平台充当证据。

## 验收标准

- [T39-A01] 沙箱开启且为"沙箱内仍审批"模式时，Bash 命令照常进入审批，获批后在 Seatbelt 中执行：写工作区成功，写工作区外、受保护路径与 `denyRead` 路径失败。验证：L2 场景（能力 ID 已登记）。
- [T39-A02] "沙箱内自动批准"模式下沙箱内的 Bash 命令不弹审批，deny 规则、ask 规则、关键路径删除与 plan 模式的拦截仍然生效。验证：L2 场景，每种情况一个。
- [T39-A03] 前台命令、`run_in_background` 后台命令与 Monitor 命令都在沙箱内执行，agent 启动进程的路径清单中每条路径各有测试。验证：L2 场景（三条路径各尝试写工作区外文件，均失败）与路径清单。
- [T39-A04] 模型请求沙箱外重试时，所有模式（含 `bypassPermissions` 与自动批准）都弹出审批，卡片只提供"仅本次允许"与"拒绝"，PermissionRequest hooks 不能代答，拒绝理由回到模型。验证：L2 场景与 mock provider 请求断言。
- [T39-A05] 白名单内域名经代理可达，白名单外域名被拒，绕过代理的直连失败；修改白名单后下一条命令按新白名单执行，Agent Host 进程 id 不变。验证：测试。
- [T39-A06] 网络白名单按用户与企业来源合并；项目级配置中的白名单域名与自动批准设置不生效，并在配置诊断中标为"项目级不生效"。验证：测试（企业来源用测试替身）。
- [T39-A07] Seatbelt 拒绝与代理拒绝写入 `audit_events`，审计页可按"沙箱拒绝"筛选查看。验证：测试与 Playwright。
- [T39-A08] 沙箱设置页可开关沙箱、切换模式、编辑白名单与 `denyRead`，改动对下一条命令生效，企业来源条目不可编辑。验证：Playwright 用例与亮/暗截图（`tmp/evidence/T39/`）。
- [T39-A09] Agent Host 在定稿的 Seatbelt 配置下：写工作区、数据目录、会话临时目录成功，测试扩展向用户主目录写文件失败，经内置 npx 启动的 MCP stdio server 可以完成一次工具调用。验证：macOS 集成测试。
- [T39-A10] 全部 L2 场景在 Agent Host 定稿配置下通过，配置生成结果有 golden 测试。验证：macOS CI 输出。
- [T39-A11] git、npm install（白名单含 registry）、cargo build、python 脚本经 Bash 工具在沙箱内执行成功。验证：集成测试输出。
- [T39-A12] Windows 上设置页与沙箱开关显示"沙箱不可用"提示；配置开启沙箱或自动批准时，命令仍按权限规则审批，不会被自动批准。验证：Windows CI 上的 Playwright 断言与截图、L2 场景。
- [T39-A13] Windows 隔离方案评估 ADR 已写入 `docs/adr/`，状态"提议"，比较表覆盖 AppContainer、MXC、Win32 app isolation、Windows Sandbox、受限令牌或独立账户方案、WSL2 与维持现状，事实注明来源与日期；`docs/adr/README.md` 索引已更新。验证：文件内容。
- [T39-A14] 沙箱内命令访问白名单外域名时出现"权限扩展（网络域名）"审批卡：仅本次允许后本次连接成功、下次再问；加入白名单后不再询问；拒绝或超时后连接失败且命令得到明确错误。验证：场景测试与 Playwright 流程。
- [T39-A15] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 创建或更新 `crates/piarc-sandbox` 的 CLAUDE.md：配置生成参数、进程启动路径清单、代理环境变量、Agent Host 配置的位置与约束、易错点。
- 更新架构第 6.2.3 节（自动批准的位置）与第 10.3 节（Agent Host 配置已定稿，指向配置模板与测试）。
- 报告中写明 macOS 部分已全部完成、T40 可以开工；Windows 隔离部分等待 ADR 决定。
