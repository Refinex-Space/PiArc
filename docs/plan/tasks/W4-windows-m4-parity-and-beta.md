# W4 Windows：M4 达标与 Beta 同步

| 项 | 内容 |
|---|---|
| 阶段 | 6 M5 Beta |
| 依赖 | R5、T50 |
| 执行平台 | Windows 11（x64；有 arm64 设备时同时验证） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 中 |
| 关联验证项 | 无 |
| 关联需求 | M4：FR-TL-06、FR-TL-07（Windows 提示）、FR-EX-04、FR-EX-05、FR-SY-03、FR-RV-04、NFR-01、NFR-03、NFR-04、NFR-06、NFR-07；M5：FR-PM-06、FR-CX-05、FR-HN-05（M5）、FR-CH-08、FR-SY-06、FR-SY-07 |
| 需要的用户决定 | 无 |
| 关口 | 实机关口：SmartScreen 放行、Narrator 与 NVDA 读屏核对需要用户在实机上操作；写入 `HKLM` 或 `C:\Program Files` 下的测试托管配置需要用户同意并提供管理员权限。准备好产物与逐步清单后，状态改为"阻塞（等待用户实机操作）" |

启动方式：由用户在 Windows 11 电脑上 `git pull` 同步后，在仓库根目录开新会话，输入 `/task W4`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

架构第 15.1 节规定：每个里程碑由 macOS 先达标，Windows 最迟在下一个里程碑结束前跟上；Beta（M5）要求两个平台同时达标。W3 完成了 M3 的 Windows 验收。本任务在 Windows 11 实机上完成两件事：

- M4 的退出标准在 Windows 上达标：安全威胁表逐条有测试并通过、第 11 章性能预算在 Windows 基准机上全部达标，以及 M4 各功能的 Windows 行为；
- M5 的全部功能在 Windows 上达标，包括 Velopack 实机更新、跳转列表与读屏。

两个平台的 CI 一直在跑，本任务关注 CI 覆盖不到的部分：真实安装、系统集成、读屏、长时间运行和基准机数据。发现的平台问题当场修复（补充型）或写 ADR（变更型）。

## 必读

1. 架构设计：第 15 章全部、第 8.7 节、第 8.8 节、第 10.1 节、第 11 章、第 16 章（M4、M5 退出标准）。
2. ADR-0013、ADR-0017、ADR-0018；T39 写的 Windows 隔离评估 ADR 及用户的决定。
3. `docs/reviews/R5-findings.md`、W3 在 `PLAN.md` 中的结论与登记事项。
4. T39–T50 的 CLAUDE.md 与验收证据，重点是 T43 的 VoiceOver 核对清单、T44 的性能测量入口、T45 的威胁表映射、T47 的托管来源注入点、T49 为 W4 登记的跳转列表步骤、T50 的 `release.md`。
5. 实现时查阅：Velopack 锁定版本的更新流程文档；NVDA 与 Narrator 的基本操作说明（供编写核对清单）。

## 范围

### 要做

- M4 退出标准与 M4 功能的 Windows 验收；M5 功能的 Windows 验收。
- Velopack 安装、更新与签名校验的实机验证；跳转列表实机验证；Narrator 与 NVDA 核对。
- 修复平台问题，结论写入 `PLAN.md` 与相关报告。

### 不做

- T39 中 Windows 隔离方案的实现：用户若接受了某个方案，另起任务，不在本任务内。
- 关闭或修改用户的系统安全设置（智能应用控制、Defender），除非用户明确同意。

## 交付物

### 1. M4 验收（Windows）

| 项 | 要求 |
|---|---|
| 安全 | T45 威胁表映射的测试在 Windows 实机上全部通过；诊断包脱敏覆盖 `C:\Users\<用户名>` 形式的路径 |
| 性能 | T44 的完整测量在 Windows 基准机（第 11 章：x64 8 核、16 GB、NVMe）上运行，含 8 小时长跑，数据写入性能报告 |
| 沙箱 | 设置页与开关处显示"Windows 上沙箱不可用"；超时、停止、KillShell 时 Job Object 终止整棵进程树 |
| 插件与 Pi 包 | 经内置 npm 安装、`--ignore-scripts` 生效，路径含空格与中文；配置诊断显示 Windows 路径 |
| M4 hooks 与通知 | CwdChanged、FileChanged（ReadDirectoryChangesW）场景通过；Toast 中的允许 / 拒绝经审批账本生效 |
| NotebookEdit 与 diff 评论 | CRLF 的 ipynb 保真写入；diff 行内评论批量发送 |
| 无障碍与本地化 | axe 零违规；键盘全流程；强制颜色与对比度主题；中英文切换含主进程菜单；Narrator 与 NVDA 核对清单 |

### 2. M5 验收（Windows）

- Auto 模式（PowerShell 与 Git Bash 命令进入审查）、自动记忆（worktree 共享）、托管配置（`HKLM` 策略键与 `C:\Program Files\ClaudeCode\` 下的兼容文件，经用户同意写入，验证后删除）。
- T48 的各项场景在 Windows 实机上通过，其中 WorktreeCreate 使用 Windows 路径；T48 中标为阻塞的项保持同样状态。
- 侧边对话；跳转列表（最近工作区与任务，点击后路由到已运行实例，AppUserModelID 与 Velopack 快捷方式一致）。

### 3. Velopack 实机更新

- 用测试密钥构建版本 N 与 N+1，本地或测试地址提供更新源与签名清单。
- 安装 N（记录 SmartScreen 表现）→ 应用发现 N+1 → 验证签名与哈希 → 下载 → 重启后为 N+1；会话、设置与凭据完好（凭据管理器中的主密钥仍可读取保险箱）。
- 篡改清单签名、篡改更新包各一次，应用拒绝更新并提示。

### 4. 结论

- 每项的 Windows 证据写入 `PLAN.md` 会话日志；平台问题修复（先写复现测试）或登记；给 T51 的已知问题候选列表。

## 实现要点

- 读屏核对清单按 T43 的 VoiceOver 清单改写，列出操作步骤与期望播报，交用户逐项执行并回报结果。
- 8 小时长跑可以无人值守运行，期间并行做不依赖它的检查项。
- 写系统位置前先说明要写什么、为什么、之后如何删除，得到同意再做；验证结束后确认已删除。

## 验收标准

- [W4-A01] T45 威胁表映射的测试在 Windows 实机上全部通过，诊断包脱敏覆盖 Windows 用户目录路径。验证：测试输出（列出测试 ID）。
- [W4-A02] 第 11 章全部指标在 Windows 基准机上达标，8 小时长跑稳态后内存增长不超过 10%，数据写入性能报告。验证：测量输出与报告。
- [W4-A03] 沙箱"不可用"提示在设置页与开关处显示；超时、停止、KillShell 后无残留进程。验证：截图与测试输出。
- [W4-A04] 插件与 Pi 包在含空格与中文的路径下安装并加载，`--ignore-scripts` 生效，配置诊断显示 Windows 路径。验证：L2 场景与 Playwright。
- [W4-A05] CwdChanged、FileChanged 场景通过；Toast 中的允许与拒绝经审批账本生效，多窗口下只接受第一个答复。验证：测试输出与实机截图。
- [W4-A06] axe 零违规（亮/暗），键盘全流程通过，强制颜色模式下界面可用；Narrator 与 NVDA 核对清单逐项有结论。验证：Playwright 输出、截图与用户实机操作记录。
- [W4-A07] Auto 模式、自动记忆、托管配置（`HKLM` 与兼容文件）在 Windows 上行为与 macOS 一致，测试写入的系统位置已删除。验证：L2 场景输出与实机记录。
- [W4-A08] T48 的场景在 Windows 实机上通过（阻塞项状态与 T48 一致），WorktreeCreate 使用 Windows 路径。验证：测试输出。
- [W4-A09] 侧边对话在 Windows 上通过 Playwright 用例；跳转列表显示最近工作区与任务，点击后在已运行实例中打开且只预填输入。验证：Playwright 输出与实机截图。
- [W4-A10] Velopack 从 N 更新到 N+1 前验证签名与哈希，更新后会话、设置与凭据完好；篡改清单与篡改更新包都被拒绝。验证：实机记录与日志。
- [W4-A11] 安装与更新过程中 SmartScreen 与 Defender 的表现已记录，用户的安全设置未被改动。验证：实机记录。
- [W4-A12] 发现的平台问题已修复（附复现测试）或登记到 `PLAN.md`，给 T51 的已知问题候选列表已写入会话日志。验证：问题清单与提交。
- [W4-A13] Windows 上 `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 把 Windows 数据写回 T44 的性能报告与 T43 的无障碍核对记录。
- 更新主进程 `platform/` 的 CLAUDE.md：本任务发现的 Windows 易错点。
- 任务结束后由用户推送，T51 从 macOS 开始。
