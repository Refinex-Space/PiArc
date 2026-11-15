# W2 Windows：M2 达标

| 项 | 内容 |
|---|---|
| 阶段 | 4 M3 多会话与生态（在 M3 期间执行，最迟在 R4 之前完成） |
| 依赖 | R3 |
| 执行平台 | Windows 11 实机（x64；有 arm64 设备时同时验证） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 中 |
| 关联验证项 | 无 |
| 关联需求 | NFR-08（Windows 最多滞后一个里程碑） |
| 需要的用户决定 | 无 |

启动方式：在 Windows 11 电脑上，由用户先 `git pull` 同步，然后在仓库根目录开新会话，输入 `/task W2`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

按架构第 15.1 节，Windows 最迟在下一个里程碑结束前达到上一个里程碑的退出标准。M2 已在 macOS 上通过 R3，本任务在 Windows 11 实机上验收 M2 退出标准（第 16 章）：第 6 章 M2 能力全部有场景覆盖；L3 对齐在权限与 hooks 上无未解释差异。

CI 已经在 Windows 上跑 L0–L2，本任务补的是 CI 覆盖不到的部分：真实安装的 Git Bash 与 PowerShell、真实的进程树、Windows 路径与文件锁、Electron 界面在 Windows 上的完整流程。发现的平台问题修复或登记。

本任务与 macOS 上的 M3 任务交替进行；同一时间只在一台电脑上执行一个任务（执行协议"Windows 任务"）。

## 必读

1. 架构设计：
   - 第 15 章"Windows 平台适配"全部、第 16 章中 M2 的退出标准
   - 第 6.2.2 节（Windows 上的命令）、第 6.3.1 节（hooks 执行）、第 6.6.4 节（压缩）、第 6.9 节（检查点与回退）、第 6.14 节（配置兼容矩阵）
2. `docs/reviews/R3-findings.md` 开头结论中的"W2 重点核对项"；`docs/reviews/W1-windows-m1-parity.md`；`PLAN.md`"登记事项"中的 Windows 条目。
3. `docs/plan/acceptance.json` 中 T23–T30 标为 `blocked`、原因为等待 Windows 的验收项。
4. T23–T30 的 CLAUDE.md，尤其 piarc-policy（Bash 分析与 PowerShell 规则）、piarc-hooks（Windows 上 command 的执行方式）、piarc-checkpoint、piarc-config（兼容层路径）。
5. T30 的 L3 基座说明（录制与比对命令、`tests/l3-allowlist.yaml`）。

## 范围

### 要做

- 按下表在 Windows 11 实机上逐项验收，留存证据。
- 修复发现的平台问题，或登记到 `PLAN.md`。
- 写 W2 报告，给出 M2 在 Windows 上是否达标的结论，更新 `PLAN.md`。

### 不做

- M3 能力在 Windows 上的验收（W3）。
- 修改其他任务的验收项状态：T23–T30 中等待 Windows 的验收项，在本任务中逐项给出 Windows 结论，由用户据此更新。

## 交付物

### 1. 验收清单

| 方面 | 核对内容 |
|---|---|
| 权限与 Bash 分析 | Git Bash 下 `Bash` 工具的 deny/ask/allow 匹配、复合命令拆分、包装命令剥离、只读白名单；关键路径删除覆盖盘符根、`%USERPROFILE%`、工作区根，以及 `/c/...` 与 `C:\...` 两种写法；`Read`/`Edit` 路径规则在 Windows 路径上的匹配 |
| PowerShell 规则 | `PowerShell(…)` 精确匹配；未被精确允许的命令在 Manual 模式下询问；"总是允许"写入的规则再次命中 |
| hooks | Windows 上 command handler 的执行方式（T25 的设计）、stdin JSON、exit 2 阻断与理由；超时与取消时整棵进程树被终止，含 hook 启动的孙进程；UserPromptSubmit 的 30 秒超时 |
| 回退与 Changes | Rewind 四个选项、冲突检测、按文件与按 hunk 丢弃；覆盖 CRLF 文件、含空格与中文的路径、超过 260 字符的路径、大小写不同的同一路径；目标文件被其他进程占用时的提示与文件完整性 |
| 压缩 | 阈值触发、`/compact` 重点、熔断、压缩后重注入；用量环与分类明细显示 |
| 配置兼容层 | `%USERPROFILE%\.claude\settings.json`、`%USERPROFILE%\.claude.json` 的读取与合并；`.claude/rules` 的 `paths:` 条件在 Windows 路径上生效；配置诊断页 |
| 其他 M2 能力 | 计划模式、任务清单、AskUserQuestion、下一步建议、三档视图的界面流程；WebFetch 的 SSRF 防护（回环、内网、IPv6）；OAuth 与设备码登录经回环端口（mock 授权服务器）；外部修改检测（Windows 文件监听） |
| M2 退出标准 | 本机 L2 全部通过、能力清单中 M2 能力无 MISSING；L3 在权限与 hooks 场景上的比对 |
| R3 重点核对项 | R3 评审文件开头列出的每一项 |

- L3 需要本机安装 Claude Code CLI。未安装时先请用户决定是否安装（全局安装需要同意）；用户不同意时，在 `PLAN.md` 中记录为未验证及原因。
- 界面流程用 Playwright 驱动 Windows 上的 Electron 应用，截图与日志放 `tmp/evidence/W2/`。

### 2. 平台问题处理

- 每个问题先写能复现的失败测试，再修复；修复属于补充型的直接做，涉及架构或 ADR 的按决策分级写 ADR。
- 本任务内修不了的登记到 `PLAN.md`"登记事项"，写明现象、影响与建议的接手任务。
- 平台差异放在 Core 的 trait 实现或主进程的 `platform/` 模块，不在业务代码里加平台分支（第 15.3 节）。

### 3. W2 报告

- `docs/reviews/W2-windows-m2-parity.md`：环境与提交号；检查表每项的结论（通过 / 修复后通过 / 登记）与证据路径；发现的问题与处理；T23–T30 中等待 Windows 的验收项与各自的 Windows 结论（由用户据此更新）；结论（M2 在 Windows 上是否达标）。R4 据此确认 W2。
- `PLAN.md` 写入 W2 结论摘要。

## 实现要点

- Windows 上的路径比较先规范化（大小写、`\\?\` 前缀、分隔符），测试夹具含空格与中文路径。
- 进程树相关的验证用进程表前后对比（例如按父 PID 枚举），不只看直接子进程是否退出。
- 文件被占用时 Windows 返回共享冲突错误，回退应报告并保留现场，不能留下写了一半的文件。
- Defender 实时扫描可能拖慢快照目录与 `node_modules` 的读写，测量到明显影响时记录数据（第 15.2 节"杀毒软件"）。

## 验收标准

- [W2-A01] 本机运行 L2 场景全部通过（含 T23–T30 新增的场景），能力清单中 M2 能力无 MISSING。验证：命令输出与 `docs/product/capabilities.md`。
- [W2-A02] Git Bash 下的 Bash 规则与复合命令分析端到端符合预期：deny/ask/allow 用例、包装命令剥离、盘符根与用户目录的关键路径删除总是询问。验证：场景输出与 Playwright 截图（存 `tmp/evidence/W2/`）。
- [W2-A03] `PowerShell(…)` 规则精确匹配生效，未被精确允许的命令在 Manual 模式下询问，"总是允许"写入的规则能再次命中。验证：Playwright 与场景输出。
- [W2-A04] hooks 超时与取消时整棵进程树被终止（含 hook 启动的孙进程），exit 2 阻断且理由回到模型。验证：实机测试输出（进程表前后对比）。
- [W2-A05] 回退四个选项、冲突检测与按 hunk 丢弃在 CRLF 文件、含空格与中文的路径、超过 260 字符的路径上结果正确；目标文件被占用时给出明确提示且文件不损坏。验证：场景测试与 Playwright。
- [W2-A06] 阈值触发压缩、`/compact` 重点、熔断与重注入在本机通过，用量环显示正确。验证：L2 场景输出与截图。
- [W2-A07] 配置兼容层读取 `%USERPROFILE%\.claude\settings.json` 与 `%USERPROFILE%\.claude.json`，`.claude/rules` 的 `paths:` 条件在 Windows 路径上生效，诊断页显示正确。验证：测试与 Playwright。
- [W2-A08] 计划模式、任务清单、AskUserQuestion、下一步建议与三档视图的界面流程在 Windows 上通过。验证：Playwright（Windows）。
- [W2-A09] WebFetch 在 Windows 上拒绝回环、内网与 IPv6 本地地址；OAuth 与设备码登录经回环端口完成（mock 授权服务器）；外部修改检测经文件监听生效。验证：测试输出。
- [W2-A10] 权限与 hooks 场景的 L3 比对在 Windows 上无未解释差异；未安装 Claude Code CLI 且用户不同意安装时，`PLAN.md` 中记录为未验证及原因。验证：L3 命令输出或 `PLAN.md` 记录。
- [W2-A11] 发现的平台问题都已修复（附复现的失败测试）或登记到 `PLAN.md`"登记事项"；`docs/reviews/W2-windows-m2-parity.md` 逐条给出 M2 退出标准与 R3 重点核对项的 Windows 证据与结论，并列出 T23–T30 中等待 Windows 的验收项的结论。验证：报告、提交记录与登记事项内容。
- [W2-A12] Windows 上 `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 平台问题修复涉及的目录，在其 CLAUDE.md 的易错点中补充 Windows 条目。
- 任务结束后提醒用户推送，再回到 macOS 继续后续任务。
