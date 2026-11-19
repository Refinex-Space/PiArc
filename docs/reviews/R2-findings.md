# R2 · M1 macOS 阶段评审

**阶段门暂缓。** 两种严格 mock 协议在开发版和打包版均完成真实文件编辑、手动审批和 Bash 测试。百炼 qwen-flash 已经通过真实工作流。读取状态和项目信任存在已核实的接口语义问题，见 [ADR-0034](../adr/0034-bind-read-and-trust-confirmation.md)。M2 的前提是关闭阶段门所列问题并复核。W1 重点是 Windows shell、进程树、凭据和桌面实机交互。

## 双协议与真实模型

基线 `d57c72e`，macOS arm64。执行 `PIARC_EVIDENCE_TASK=R2 npm run test:e2e -w @piarc/desktop -- r2-workflow`，4/4。每种形态都通过设置页添加自定义端点，Messages 用 mock 根地址，OpenAI Chat Completions 用同一 mock 的 /v1，均选 fixture 模型。每个用例用独立的严格 mock 和空白应用数据目录。

在含空格和中文的工作区创建 sum.cjs、sum.test.cjs。初始 3 + 2 返回 1，Node 单元测试报 ERR_ASSERTION。会话通过 Read 取得两份源文件，在 Manual 卡片允许一次 Edit，再允许一次 Bash 执行 `node --test sum.test.cjs`。逐请求检查实际线格式、模型收到的源代码和测试输出，独立重跑通过，测试文件逐字节保持原内容。各次真实网络交换 4 次，端点均为本地测试服务器。夹具和 W1 可复用入口在 `apps/desktop/e2e/r2-workflow.e2e.ts`，截图在 `tmp/evidence/R2/l4/`。

另在打包应用配置关闭云端的本机 Ollama，使用已安装的 deepseek-r1:7b（OpenAI Chat Completions）执行相同初始项目和用户指令。服务端记录 1 次推理请求，HTTP 200，费用 0。模型直接输出文字建议，未发起 Edit 或 Bash，等待真实审批卡超时。该运行未达到退出标准。证据见 `tmp/evidence/R2/local-run.log`、`local/l4/`。

维护者随后授权百炼北京端点最多 8 次调用、预算人民币 0.10 元。打包应用在隔离的 Git 夹具中从设置页配置 qwen-flash，经保险箱取得凭据，依次执行 Read、Read、Edit、Bash，测试由 ERR_ASSERTION 变为通过。最后一轮给出结果。转发器限制请求次数、输入字节和最大输出，仅记录 HTTP 状态、工具名与用量。5 次请求均为 HTTP 200，合计输入 11,868、输出 254 tokens；按每百万输入 0.15 元、输出 1.50 元计，估算 0.0021612 元，优惠和账单结算以服务商为准。证据在 `tmp/evidence/R2/paid/` 的 usage.json、before.txt、after.txt 和三张截图。本次付费调用发生在目录句柄改动合入前，最终构建用相同夹具重跑两种协议。累计计费调用仍为 5 次。[百炼 qwen-flash 官方定价](https://help.aliyun.com/zh/model-studio/qwen-flash)

## M1 目标与证据

全部 62 个 L2 场景在本机运行，61 个通过、0 个失败，exec-windows-shells 按平台留给 W1。重新生成能力文档后 MISSING 0，M1 planned 0。报告在 `target/l2/results.json`，命令输出在 `tmp/evidence/R2/scenarios-final.log` 及 `coverage-final.log`。本次 dev 和 packaged 的 40 个 Electron 用例全部通过，见 `final-ui.log`。

| 第 16 章目标 | 能力或 L4 | 核实的结果 |
|---|---|---|
| 单工作区、多会话列表 | CAP-SESSION-MULTI-001、CAP-SESSION-MANAGE-001，t18-sessions | 会话隔离；实际重命名、置顶、归档、删除与重启；新增 session-manage 从数据库复查状态。 |
| 流式对话 | chat-basic、t19-transcript | 工作行、增量回答、最终回复均经真实 Host；I19 另测同连接的突发通知及后续工具 I/O。 |
| Read、Write、Edit、Bash、Glob、Grep 经 Core | CAP-TOOL-CORE-001，policy-manual，r2-workflow | 六工具有实际执行和结果；双协议 L4 核对 Edit 和 Bash 的审批及最终文件。失败重试见 tools-read-failed-retry，目录身份回归见 F01。 |
| Windows PowerShell | CAP-TOOL-POWERSHELL-001、exec-windows-shells | 有场景和前序记录；本次 macOS 未执行 Windows 专属工具。 |
| Manual、Accept edits | CAP-PERM-MODE-001、CAP-PERM-APPROVAL-001，t20-approvals | 两种模式的基础矩阵、精确规则、拒绝反馈、规则原生确认与键盘保护有证据。 |
| 模型与保险箱 | CAP-PROVIDER-CONFIG-001、CAP-MODEL-SWITCH-001，t21-models | 通过设置页写入合成凭据和端点，会话实际切换协议；本地真实模型的结果见前节。 |
| 会话持久化与恢复 | CAP-SESSION-PERSIST-001，sessions-persist-across-restart | Core 重启后第二次请求带回第一轮历史；R2 新增等长重写索引回归。 |
| transcript P0 行类型 | t19-transcript、t20-approvals、t22-memory | 按用例核对真实回合的 P0 行、审批卡、模式变更与 memory 消息。 |
| M1 上下文与项目信任 | CAP-CTX-PROMPT-001、CAP-CTX-MEMORY-001、CAP-TRUST-DIALOG-001 | 系统段与 memory，项目清单和信任决定；展示期间出现新增项须重新确认（ADR-0034）。 |

本次新增 `core/sessions` 快照的逐会话断言，覆盖审批中以及结束后未读。徽标排序与原生通知效果见 `t18-sessions` 和 `t18-attention`。I19 的 2,048 个 SSE 文本分片在此运行中投影成 1,313 个客户端 delta。提交 prompt 到 Core 收到 fs/stat 为 103.399 ms，从 fs/stat 到随后的 fs/read 为 2.058 ms，下一次模型请求收到正确的文件内容。该区间含 stat 往返，只有单次观测；依据不支持改变 AHP 通道。复跑命令为 `cargo test -p piarc-testkit --test sessions a_read_completes_after_a_notification_burst -- --nocapture`。I16 确认实现的默认 cacheWarming 为 off，显式配置保留。

## 前序验收状态

按 task 精确筛选 acceptance.json，T13–T22 共 126 项，全部 passing，blocked、failing、not_started 各 0。各任务已登记的通过数如下。

| 任务 | passing |
|---|---:|
| T13 | 14 |
| T14 | 13 |
| T15 | 11 |
| T16 | 11 |
| T17 | 13 |
| T18 | 14 |
| T19 | 14 |
| T20 | 14 |
| T21 | 11 |
| T22 | 11 |

## W1 · Windows 11 实机复核清单

开工记录 Windows 版本、架构、提交与安装形态；在隔离测试数据目录安装。每项写操作、结果及截图或日志到 `tmp/evidence/W1/`。历史的 T13–T22 验收中，因需要 Windows 实机而为 blocked 的编号为 **无（0 项）**；以下实机检查仍须独立执行。

| 检查 | W1 执行与通过条件 |
|---|---|
| 两种服务商、完整任务 | 构建后运行 `npm run test:e2e -w @piarc/desktop -- r2-workflow`。使用上文的 Messages 与 /v1 Chat Completions 组合和同一“加法 regression”夹具，工作区路径含中文与空格。核对初始失败、Manual 两张审批卡、测试变绿以及测试文件未修改。真实服务商另记录模型、调用数与费用，计费前取得许可。 |
| L2 与 L4 | 本机跑 `npm run verify` 和全套打包形态 L4；L2 至少 20 个通过，记录全部失败及平台跳过。复跑 I19 的突发通知后读取，记录 Windows 的 fs/stat 到 fs/read 间隔。 |
| Git Bash 与 PowerShell | 在安装与无 Git Bash 的隔离环境分别检查工具列表、缺失提示和回退；Manual 批准后执行 PowerShell，Git Bash 下的中文输出保持完整。 |
| 进程树 | 分别取消、超时，用 Job Object、测试 PID 与 tasklist 检查父进程和后代均已结束。验证输出流中断导致命令失败。 |
| 路径与文件 | 盘符、UNC、长路径、空格与中文、大小写、CON/NUL；CRLF、BOM、有损坏码元的 UTF-16 均按约定处理。以真实 Git worktree 核对反向注册。在真实 UNC 共享和 NTFS junction 上复核目录变更、共享删除、外部目标的审批边界，以及大目录取消（ADR-0036）。 |
| 数据与凭据 | 验证 %LOCALAPPDATA%\PiArc、隔离目录、Credential Manager 的测试主密钥与重启读取；用合成标记扫描数据、日志和子进程环境。核对 v3 → v4 索引迁移、同长度重写和 Windows 文件替换。 |
| 原生人工交互 | 微软拼音与日文 IME 在 composer 和审批卡的候选、Enter、Esc、/、@；窗口在后台时的结束与审批 Toast、点击归属、任务栏覆盖计数；检查 Mica、右上窗口控件、标题栏覆盖层及明暗外观。真实通知点击、首次 SmartScreen 放行由用户操作。 |
| 评审发现 | 原生删除确认显示实际目标标题、ID 和工作区，取消保留文件。无效 PDF 不留副本。核对环境继承决策、工作树登记及审批清单版本。Unix 临时文件模式对应 W1 检查 Windows 的既有 ACL/属性约定，记录实际行为。 |

## 逐项核实与裁决

位置和行号指审查基线 `d57c72e`。四份审查中，项目信任清单变化被两名审查者分别指出；下表合并为 P01。下列先红后绿记录位于 `tmp/evidence/R2/`。目录和命令环境的实施另行并行，原四名审查者均只读。

| 编号 / 维度 | 基线位置、失败条件 | 核实结论与处理 |
|---|---|---|
| P01 权限 / IPC | trust.rs:236、TrustDialog.tsx:135；用户阅读期间清单变化 | 确认。Core 对目录、完整清单和原决定签发版本，持锁核对后保存。过期肯定答复返回最新清单，UI 提示重审。a58198d、8f516e8，ADR-0034；trust-version-red.log、t18-trust 两种形态和 ego-trust-refresh.png。 |
| P02 权限 | piarc-git/src/checkout.rs:173；移动或失效的 linked worktree 登记仍能沿用原主库决定 | 确认。校验 worktrees 位置及反向 gitdir；真实 Git 工作树移动测试由失败转为通过。6e95bd5，regression-red.log / regression-green.log。 |
| P03 权限 | piarc-core/src/trust.rs:96、106、389；读取清单失败或快照损坏 | 确认。Core 和视图均保持未信任；中断的配置保存由状态测试覆盖。6e95bd5，同上。 |
| F01 文件边界 | piarc-fs/src/scope.rs:165、write.rs:107；目录在授权与使用之间移动 | 确认。预检、预览、读写、搜索、memory 外部导入使用稳定目录身份。Unix 的 rename 保证提交到同一目录对象；最终复核与 rename 之间仍有命名空间时间窗。Windows 特性见 W1 清单。d997de9、ADR-0036，directory-red.log / directory-green.log、walk-red.log / walk-green-final.log、memory-binding-red.log / memory-binding-green.log。 |
| F02 读取状态 | piarc-fs/src/write.rs:190、agent-host/src/tools/read.ts:65；内容已开始读取但解析失败 | 确认。查询统计不授予写入新鲜度；实际成功、同一调用、同一范围及文件版本才提交。损坏 notebook 连续两次返回解析错误。69916a6、ADR-0034，read-state-red.log / read-state-green.log、read-l2.log。 |
| F03 暂存保密性 | piarc-fs/src/atomic.rs:44；私有文件的 Unix 临时副本曾晚于写入才恢复模式 | 确认。暂存从创建起使用 0600；持有文件句柄完成权限恢复、同步与原子发布。6e95bd5；regression-red.log / regression-green.log。 |
| F04 命令环境 | piarc-exec/src/env.rs:68；登录环境已有的私密字段随工具继承 | 确认。决策采用 OS、locale 和工具链字段准入；登录失败回退、Windows 及 Git Bash 探测遵守同一边界。依赖自定义变量的构建可能需要调整。cb840ae、ADR-0035，env-red.log / env-l2-final.log、env-command-integration.log。 |
| F05 编码 | piarc-fs/src/encoding.rs:157、write.rs:118；受损 UTF-16 在无关编辑中丢失原字节 | 确认。检测有损 UTF-16 转换并拒绝写回，保留原文件。6e95bd5；regression-red.log / regression-green.log。 |
| F06 索引 | piarc-store/src/index.rs:201；早期行等长重写，尾行不变 | 确认。schema v4 保存文件身份与修改时间；缺失基线或标记变化时重扫。macOS 用设备/inode，Windows 以创建时间识别替换；低时间分辨率或保留原文件时间的等长重写可能无法区分，可执行全量重建。be3462c；index-red.log / index-green.log。 |
| F07 diff | piarc-diff/src/lib.rs:61、81；大差异在截断前分配完整文本和行副本 | 确认。按字节预算写预览并统计遗漏字节，在降级路径上停止保留 hunk 行；完整 diff 行数仍精确。2bce778；diff-red.log / diff-green.log。 |
| U01 删除会话 | session-ipc.ts:400；原生弹窗标题由 UI 提供，与实际删除 ID 独立 | 确认。主进程向 Core 查询标题与工作区并显示目标 ID，缺少索引标题时显示 ID。b426028；delete-red.log、t18-sessions 两种形态和 ego-session-menu.png。 |
| U02 附件 | composer/attachments.rs:94；PDF 解析失败，但最终存储位置已有副本 | 确认。先对输入字节解析并验证页数，再发布内容寻址文件。6e95bd5；regression-red.log / regression-green.log。 |
| Q01 命令错误 | piarc-exec/src/command.rs:289；进程退出 0 掩盖了部分输出读取错误 | 确认。保留第一个带流名的 I/O 错误，触发进程树清理后报告失败；完整 crate 的统一类型化边界经 I61 指派 T32。ee48bc0；pipe-red.log / pipe-green.log。 |
| Q02 覆盖真实性 | policy-session-rule.yaml:3、26；未断言 Core 状态或通知输入 | 确认。L2 明确校验审批中、结束未读的真实 Core 快照；优先级与通知呈现经 t18-sessions / t18-attention。d9b661f。 |
| Q03 M1 门禁 | tests/capabilities.yaml:22、40；T18 完成而两项能力仍为 planned | 确认。补充可执行信任清单和重启后会话元数据、删除的 L2 断言；M1 planned 2 → 0，MISSING 0。d9b661f、8c8bfb1。 |
| Q04 模块长度 | runtime.rs:1、piarc-host/tests/resilience.rs:1 | 确认。I81 已拆为状态和会话门面，公开入口保持。b426028。韧性测试保留为单一集成测试目标，共用握手、重启和背压夹具；L2 runner 保留单个 Driver 的事件与时序实现，超长按工程规范 2.7 记录。 |
| Q05 文档 | AGENTS.md:31、coding-standards.md:268、piarc-fs/src/lib.rs:11 等 | 确认。24 对目录说明的导入文件统一为单行，修正四个工作区及 checkpoint 分期，补 T21 共用入口。5a8b23e。 |

R1 已登记的终端暴露与原生信任确认分别保留 I30/I51（T34/T45）和 I79（T45）；macOS 脱离原进程组的后代限制见 I36。I80 对应 workspace actor 预热早于路由登记，T35 在多窗口验收中复核；I25 的真实输入法仍由 W1 补 Windows 证据。本轮未复制外部参考实现；目录能力依赖精确锁定的 cap-std / cap-fs-ext 4.0.3，许可审计与来源检查通过。

## 独立审查的输入与调度

四个独立 explorer 均从空上下文只读审查 d57c72e，均提供架构 10.1 威胁模型和第 16 章。权限审查另给 6.2、10.2、T13、T20 与 ADR-0031；工具审查给 6.1、6.11、9、15.2 和 T13/16/17/21；客户端审查给第 8 章、10.3、T18/T19 和 ADR-0022；工程质量审查给第 7、12 章及工程规范。各自只收到 R2 对应范围和文件入口。平台同时允许三个子代理，第四项在首个槽位释放后启动，与剩余审查重叠。

## 附录 · 审查原文

### 权限与审批

对 `d57c72e` 的只读审查发现三项与 M1 项目信任边界相关的问题。

| 严重度 | 失效条件与影响 | 修复方向 |
|---|---|---|
| 高 | 信任对话框打开后、用户确认前，项目新增可执行项。客户端只提交工作区和布尔值，Core 在确认时重新枚举并保存全部条目。用户没看到的扩展或 allow 规则可随本次确认生效。见 `apps/desktop/src/renderer/shell/TrustDialog.tsx:112`、`:135`，`crates/piarc-core/src/trust.rs:236`。 | 由 Core 为展示的清单生成版本标识。确认时若清单已变，返回最新清单供重新确认。 |
| 高 | Core 仅根据工作目录中 Git 元数据指向的位置确定 linked worktree 的主 checkout，未核对主仓库登记的工作树是否指回当前目录。在元数据错误或不可信、所列条目又与已有快照相容时，独立目录可能继承其他项目的信任，跳过首次确认。见 `crates/piarc-git/src/checkout.rs:154`、`:173`，`crates/piarc-core/src/trust.rs:85`。 | 共享信任前验证主仓库的工作树登记与当前工作目录双向一致。无法验证时按独立项目或未信任处理。 |
| 中 | 已信任项目的配置无法解析或扩展目录无法列举时，枚举器将失败记入 `unreadable`，信任查询和界面却仅比较成功列出的条目。数据库中的快照损坏且当前清单为空时，也会得到 `trusted: true`。这使 Agent Host 在无法确认清单完整性的情况下收到肯定答复。见 `crates/piarc-config/src/executables.rs:86`、`:129`，`crates/piarc-core/src/trust.rs:96`、`:106`、`:389`。 | 清单不完整或快照解析失败时返回未信任，让界面区分读取失败与新增项，并保留上次有效记录。 |

已覆盖的路径包括 `policy/evaluate` 与 `trust/get` 的传输失败和畸形回复、按会话与连接代次核对审批、首个有效答复生效、重连清卡、受保护路径逐次审批，以及项目层 `bypassPermissions` 和 `auto` 的过滤。桌面端在持久修改前展示最终规则和目录，默认按钮为取消。既有 L4 用例覆盖 400 ms 热键延迟、首张可见卡、输入法合成、Esc 焦点条件与长命令展开门槛。见 `agent-host/src/harness/policy.ts:56`、`agent-host/src/harness/project-trust.ts:25`、`crates/piarc-policy/src/ledger.rs:40`、`crates/piarc-policy/src/decision.rs:50`、`crates/piarc-config/src/settings.rs:157`、`apps/desktop/src/main/core/session-ipc.ts:274`、`apps/desktop/e2e/t20-approvals.e2e.ts:76`。

以上结论来自指定提交的源码与既有测试定义。本次未运行测试或漏洞复现，未修改文件。

### 工具不变量与数据安全

基于 `d57c72e` 的只读审查发现 7 项问题。前三项直接影响路径授权、先读后改和文件保密性，建议优先处理。

| 优先级 | 位置 | 失效条件与影响 | 修复方向 |
|---|---|---|---|
| P1 | `crates/piarc-fs/src/scope.rs:165`、`crates/piarc-fs/src/content.rs:74`、`crates/piarc-fs/src/write.rs:107` | 路径核验与实际打开、替换分开进行。如果父目录在其间被换成链接，最终 I/O 目标可能位于授权目录之外。同一 Core 的路径锁无法约束外部目录变动。 | 将核准的目录身份绑定到实际操作，在受信目录句柄上打开、替换，遇到链接或目录身份变化时中止。Windows 单独核验目录重解析点。 |
| P1 | `crates/piarc-fs/src/write.rs:190`、`agent-host/src/tools/read.ts:65` | `fs/stat` 已登记读取，之后 PDF 页范围校验、内容解析或读取仍可能失败。相同范围重试会收到“未变化”存根，Write 也可能在模型没有取得内容时通过先读检查。 | 将重复读取查询与成功登记分开，成功后提交对应版本与范围，错误或取消时丢弃待登记状态。 |
| P1 | `crates/piarc-fs/src/atomic.rs:44`、`:48`、`:74` | Unix 上替换私有文件时，临时文件先按默认 umask 创建并写入全文，之后才恢复原文件权限。在可遍历的共享目录，其他用户可能读取暂存内容；中途崩溃会延长暴露时间。 | 替换现有文件时从创建起就限制临时文件权限，再通过持有的文件句柄设置最终模式。 |
| P1 | `crates/piarc-exec/src/env.rs:68`、`crates/piarc-core/src/tool_io/exec.rs:151` | 用户登录 shell 或父进程已导出的服务商、云凭据可进入工具命令。保险箱路径没有注入密钥，但 T17-A08 声明的“命令环境没有任何凭据”超出了实际保证。 | 明确允许继承的命令环境并用假凭据覆盖登录、回退和 Windows 路径。若继续保留用户导出的凭据，应同步验收口径并登记风险。 |
| P2 | `crates/piarc-fs/src/encoding.rs:157`、`crates/piarc-fs/src/write.rs:118` | 解码忽略替换标记。带 BOM 的 UTF-16 文件若含无效码元，Edit 修改其他行也会将原字节永久变成 U+FFFD，文本 diff 不显示这项损失。ADR-0027 只明确记录了非法 UTF-8 的同类限制。 | 编辑或追加前验证原文可以无损解码、回编码；无法保持原字节时拒绝覆盖。 |
| P2 | `crates/piarc-store/src/index.rs:201` | 增量同步只比较长度和上次末行哈希。等长替换保留末行但改变较早消息时，直接返回 `Unchanged`，标题或用量会与全量重建不同。 | 记录文件身份与变更信息，单独处理等长修改和文件替换，对不确定的前缀重新扫描。 |
| P2 | `crates/piarc-diff/src/lib.rs:61`、`:81` | 大改动先复制所有 hunk 行，再构造完整 unified diff，最后才应用 5,000 行和 512 KiB 上限。长文件的预览虽被截断，计算期间的额外内存仍随完整差异增长。 | 计数时先判断行数阈值，构造文本时执行字节预算，进入降级模式后停止保存行副本。 |

核对过的正常路径包括跨会话写锁与内容哈希检查、唯一匹配与 `replaceAll`、有效编码和 BOM 保留、同目录写入与原子 rename、工具结果及命令输出的预览落盘、JSONL 只读流式解析和未完成末行重读，以及保险箱加密、系统主密钥、AHP 凭据传输和公开配置分离。普通命令通过 macOS 进程组或 Windows Job Object 清理。macOS 已脱离进程组的后代仍受既有登记项 I36 限制。

本审查未改文件、未运行测试或复现攻击。Windows 平台行为仅核对了源码，需由 W1 实机确认。

### 渲染进程与 IPC

以 `d57c72e` 为基线，静态审查发现 3 项需要处理的问题。

| 优先级 | 发现与影响 | 修复方向 |
|---|---|---|
| P1 | **项目信任确认没有绑定用户看到的清单。** 对话框先读取可执行项，确认时只提交工作区路径和布尔值。Core 随后重新枚举并保存当前清单。如果对话框打开期间项目新增可执行项，该项会随用户本次确认进入可信快照。这种情况无需渲染进程被注入，区别于已登记的 I79。`apps/desktop/src/renderer/shell/TrustDialog.tsx:112,135`，`crates/piarc-core/src/trust.rs:236–250`。 | Core 为展示的清单签发版本，处理确认时核对工作区及版本。清单变化时保持未信任，展示新增项并重新确认。 |
| P2 | **删除会话的原生确认框可能显示错误目标。** 目标 ID 与弹窗标题分别来自渲染进程。界面状态过期或页面被注入时，弹窗可以显示另一会话的标题，用户确认后仍按原 ID 删除 JSONL、附件和索引。现有 L4 断言弹窗数量、确认删除与取消保留，未核对标题与 ID 的绑定。`apps/desktop/src/main/core/session-ipc.ts:400–421`，`apps/desktop/e2e/t18-sessions.e2e.ts:123–137`。 | IPC 只接收目标 ID，由主进程向 Core 查询标题与工作区，在原生弹窗显示可信目标信息。 |
| P2 | **校验失败的 PDF 会留在会话目录。** Core 在验证可读性、密码保护与页数前已将文件写入最终位置。被拒绝的 PDF 仍留下副本，不同文件还会持续占用磁盘。`crates/piarc-core/src/composer/attachments.rs:94–106`，`crates/piarc-fs/src/pdf.rs:100–107`。 | 先在本次操作独占的临时文件中完成解析，成功后再提交最终文件。失败时清理临时文件，并覆盖重复提交、并发去重及拒绝后无残留的情况。 |

**已知风险仍存在。** 普通窗口的发布版 preload 和主进程仍开放终端，窗口所有权校验不能防止已被注入的同一窗口向自己的用户 shell 写入。R1 已登记 I30、I51，由 T34/T45 收口，不重复计为新增发现。信任决定缺少主进程原生确认另有 I79 跟踪。见 `apps/desktop/src/main/main.ts:165`、`apps/desktop/src/main/core/terminal-ipc.ts:137–153`、`docs/architecture/ARCHITECTURE.md:1205,1225`。

**已有保障。** preload 使用固定通道，主进程统一精确比较 `senderFrame.origin`。窗口启用 sandbox、context isolation，关闭 Node 集成；生产 CSP 限制外部资源与脚本。Markdown 原始 HTML、工具输出、命令输出及 diff 行按文本渲染，远程图片不自动加载。外链由主进程二次检查协议和用户信息，原生确认显示与实际打开相同的规范化 URL，默认取消，每窗口只允许一个待答外链确认。附件另有每文件大小、类型、内容前缀和会话目录边界检查。见 `apps/desktop/src/main/ipc/register.ts:13`、`apps/desktop/src/main/web-preferences.ts:9`、`apps/desktop/src/main/external-links.ts:25`、`apps/desktop/src/renderer/transcript/markdown/MarkdownView.tsx:83`、`crates/piarc-core/src/composer/attachments.rs:127`。

**覆盖范围。** 现有 18 个 XSS 样本覆盖实验页完成与流式回复，以及正式会话的回复、Read 和 Bash 输出。正式文件路径使用其中一个代表样本。断言检查可见文本、执行标记、禁止元素、事件属性、CSP 违规和远程请求。另有来源混淆、外部导航、重定向、新窗口、外链确认及取消的 L4 用例。本次仅核对代码与测试断言，未运行测试或实施攻击。

### 工程质量

基线 `d57c72e` 有两项影响运行结果或验收可信度的问题，另有一个尚未通过的 M1 门禁。此次只读核查未修改文件或运行测试。

| 优先级 | 发现与影响 | 既有覆盖与建议 |
|---|---|---|
| P2 | `crates/piarc-exec/src/command.rs:289` 把 stdout、stderr 的读取错误当作 EOF。若读取中途失败而进程退出 0，Core 会返回成功，模型拿到不完整的命令输出。`crates/piarc-core/src/tool_io/exec.rs:248` 还把执行错误统一归到 shell 文件路径，对应 I61。 | `command.rs:365` 和 `:385` 覆盖正常输出与流式送达，`capture.rs:392` 覆盖落盘失败。先注入失败的 `AsyncRead` 与成功退出状态，再让执行器返回注明输出流及失败阶段的错误，并保持进程清理。 |
| P2 | `tests/scenarios/policy-session-rule.yaml:3` 是 `CAP-SESSION-STATUS-001` 和 `CAP-SYS-NOTIFY-001` 唯一覆盖来源。其 `:26` 开始只断言拒绝条目、工具结果和请求数。会话状态或通知回归时，该场景仍可通过。`tests/capabilities.yaml:47` 还把徽标优先级归给 Core，实际计算在 `apps/desktop/src/renderer/store/status.ts:11`。 | `apps/desktop/e2e/t18-sessions.e2e.ts:156` 和 `t18-attention.e2e.ts:23` 已验证客户端行为。补充 Core 快照状态的 L2 断言，将客户端通知与优先级关联对应 L4 证据。 |
| 门禁 | `tests/capabilities.yaml:22` 的 `CAP-TRUST-DIALOG-001` 与 `:40` 的 `CAP-SESSION-MANAGE-001` 仍为 `planned`，所属 T18 已完成，R2-A03 要求 M1 的 `planned` 数为零。 | 已有 `t18-trust.e2e.ts`、`t18-sessions.e2e.ts`。补证信任决定、会话元数据及其持久化后再更新能力状态。 |
| 维护 | `crates/piarc-core/src/runtime.rs` 有 1,281 行，I81 已指派 R2 拆分。`crates/piarc-host/tests/resilience.rs` 有 1,194 行。Rust 函数 80 行限制已由 `clippy.toml:1` 与 `Cargo.toml:112` 强制。 | 按领域移动 Core 门面方法并保留 API。对于韧性测试文件，按编码规范记录保留长文件的理由或按测试主题拆分。 |
| 文档 | 24 对 `AGENTS.md` 与 `CLAUDE.md` 均存在，20 个 `CLAUDE.md` 多出 HTML 注释。`AGENTS.md:31` 把四个 TypeScript 工作区写成三个。通用能力复用表 `docs/engineering/coding-standards.md:268` 从 T19 跳至 T22，缺少 T21 的设置 Host 和模型目录入口。 | 统一单行导入，按 `tsconfig.json` 修正计数，登记 `crates/piarc-core/src/sessions/provider_settings.rs:46` 与 `agent-host/AGENTS.md:88` 对应入口。 |

按基线 Cargo 清单核对，21 个 crate、34 条内部依赖全部符合分层规则。`crates/deps-rules.json:71` 为后续 checkpoint 保留了例外，当前 `piarc-fs` 未使用该依赖。`crates/piarc-fs/src/lib.rs:11` 已写成每次写入前都调用 checkpoint，建议注明该行为由 M2 交付。
