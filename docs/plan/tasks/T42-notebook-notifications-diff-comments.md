# T42 NotebookEdit、可操作通知与 diff 行内评论

| 项 | 内容 |
|---|---|
| 阶段 | 5 M4 安全与打磨 |
| 依赖 | T41 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 中 |
| 关联验证项 | 无（可操作通知采用 S6 关于 ad-hoc 签名下系统通知的结论，不重新验证） |
| 关联需求 | FR-TL-06、FR-SY-03、FR-RV-04 |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T42`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

三项 M4 的 P2 功能，彼此独立：

- **NotebookEdit**：第一版工具清单（第 6.1.4 节）的最后一个工具，按 cell 编辑 Jupyter notebook，遵守与 Edit 相同的不变量。
- **可操作通知**：等待审批时，用户在系统通知里直接允许或拒绝（FR-SY-03）。答复必须经过审批账本，与审批卡同等对待。macOS 能否做取决于 S6 的结论：ad-hoc 签名下 `UNNotification` 可能不可用（ADR-0018 第 6 条），此时走降级路径。
- **diff 行内评论**：在 Changes 面板的 diff 行上写评论，一次批量发给 agent（FR-RV-04）。

完成后，三项都有场景或 Playwright 用例覆盖；macOS 通知按 S6 结论走带操作或降级的路径；Windows Toast 按钮的逻辑有 CI 测试，实机验证留给 W4。

## 必读

1. 架构设计：
   - 第 6.1.2 节"工具语义不变量"、第 6.1.4 节 NotebookEdit 行、第 6.9 节"Checkpoint 与 Rewind"
   - 第 6.2.2、6.2.3 节（审批账本与审批选项）
   - 第 8.2 节（Changes 与审批卡）、第 8.5 节（审批热键、长参数阅读闸门）、第 8.8 节"系统通知"行
   - 第 10.1 节"审批疲劳与误点""多窗口审批错乱"两行
2. ADR-0018（第 6 条）。
3. 需求规格 FR-TL-06、FR-SY-01、FR-SY-03、FR-RV-04。
4. `docs/spikes/` 中的 S6 报告（通知可用性结论）；`docs/research/claude-official-capabilities.md` A1（NotebookEdit）、A2.2（`Edit(...)` 规则覆盖 NotebookEdit）、B3（diff 行内评论的交互）。
5. T16（ipynb 读取、保真写入）、T18（通知与角标）、T20（审批账本）、T28（Changes 面板）交付的代码与 CLAUDE.md。
6. 实现时查阅：
   - nbformat 规范（cell id 从 4.5 起存在）；
   - 锁定 Electron 版本的 Notification API：操作按钮在 macOS 与 Windows 上的支持方式与激活回调；
   - Windows Toast 对 AppUserModelID 与开始菜单快捷方式的要求，以及 Velopack 安装时创建的内容。

## 范围

### 要做

- NotebookEdit 工具：cell 的插入、替换、删除，保真写入。
- 系统通知中的允许 / 拒绝：macOS 按 S6 结论实现或降级；Windows Toast 按钮。
- Changes 面板的 diff 行内评论与批量发送。

### 不做

- 执行 cell、连接 kernel。
- Windows Toast 的实机验证（W4）。
- 通知中填写拒绝反馈：通知里的"拒绝"不带反馈，需要反馈时在审批卡上答复。

## 交付物

### 1. NotebookEdit

- 规范名 `NotebookEdit`，参数风格对照 Claude Code（A1），描述文字自写。操作：在指定 cell 前后插入、替换 cell 源码与类型、删除 cell。
- 定位：优先用 cell id；没有 cell id 的旧版 notebook 按序号定位。cell 不存在时返回明确错误。
- 不变量：经 Core 的 `fs/read` + `fs/write`，先读后改、外部修改检测、写前快照、原子写入都与 Edit 相同；产生 `fileChange` diff。
- 保真：未改动的 cell、notebook 元数据、键的顺序、缩进、换行风格与结尾换行逐字节不变。被修改 cell 的 outputs 与 `execution_count` 的处理对照 Claude Code 官方行为确定，写进工具描述与 CLAUDE.md。
- 权限：Manual 模式需审批，Accept edits 模式下工作区内允许；`Edit(路径 glob)` 规则与受保护路径同样适用；hooks 按规范名匹配。

### 2. 可操作通知

- 范围：会话等待审批且窗口不在前台时，通知带"允许本次"与"拒绝"两个操作（平台支持时）。
- 账本：通知携带 `requestId`、`revision`、`connectionEpoch`。主进程收到操作后调用 Core 的审批接口，由账本校验：只接受第一个有效答复，过期请求被拒绝并在应用内提示"该请求已处理或已失效"。各窗口的审批卡同步更新。
- 高风险请求只提供"打开"：关键路径删除、沙箱外重试（T39），以及命令或 diff 超出通知可显示长度的请求，通知中不出现"允许"，点击后打开对应审批卡。理由：第 8.5 节的阅读闸门在通知里无法实现。
- macOS 路径按 S6 结论二选一，另一条用测试替身覆盖：
  - **通知可用**：通知带上述操作；平台不支持操作按钮时退化为点击通知打开审批卡。
  - **通知不可用**：退回应用内提醒加 Dock 角标与弹跳（ADR-0018 第 6 条），设置页的通知项说明原因与当前行为。
- Windows：Toast 按钮与激活回调；生成与回调路径在 Windows CI 上测试，实机验证登记到 W4。
- 通知答复写审计，来源标为"通知"。

### 3. diff 行内评论

- Changes 面板的 diff 行上可添加评论（鼠标悬停行号或键盘操作），可编辑、删除，可跨多个文件；评论绑定到旧侧或新侧的行号范围。
- Mod+Enter 一次发送全部未发送评论。消息按文件分组，每条包含文件路径、行号范围、所在侧（旧 / 新）、代码摘录与评论正文；消息格式集中定义。
- 会话运行中发送时作为排队消息（与 composer 的 Mod+Enter 语义一致），回合结束后送达。
- 未发送的评论是渲染进程的草稿，按第 7.3 节存 `localStorage`，丢失时不影响业务。diff 更新后按内容重新定位，定位失败标为"已失效"并保留文本。
- Playwright 用例与亮/暗截图放在 `tmp/evidence/T42/`。

## 实现要点

- notebook 的保真写入不要"解析 JSON 再整体序列化"：序列化格式与原文件不同会产生整文件 diff。只替换目标 cell 对应的片段，或用能保持原格式的序列化方式，并用逐字节对比的测试兜底。
- 通知层在主进程内用窄接口包一层，测试中替换为测试替身，断言账本调用与参数；真实通知只在手工核对中出现。
- 通知操作与审批卡共用同一条答复路径，不为通知单独实现一套校验。
- 每个场景登记能力 ID，例如 `CAP-TOOL-NOTEBOOK-001`、`CAP-APPROVAL-NOTIFY-001`。

## 验收标准

- [T42-A01] NotebookEdit 的插入、替换、删除各有一个场景，结果与期望 notebook 一致，未改动的 cell、元数据、缩进与换行风格逐字节不变。验证：L2 场景（能力 ID 已登记）。
- [T42-A02] 未先 Read、读取后被外部修改、cell id 不存在时返回明确错误且文件不变；没有 cell id 的旧版 notebook 按序号定位。验证：L2 场景。
- [T42-A03] NotebookEdit 的写入进入检查点并可回退，受 `Edit(...)` 规则、受保护路径与模式默认约束，并产生 `fileChange` diff。验证：L2 场景。
- [T42-A04] 从通知作出的答复经审批账本处理：与审批卡同时答复时只接受第一个有效答复，过期请求被拒绝并在应用内提示，审计记录来源为"通知"。验证：测试（通知层测试替身，断言 `requestId`、`revision`、`connectionEpoch`）。
- [T42-A05] 关键路径删除、沙箱外重试以及参数超出通知可显示长度的请求，通知只提供"打开"，不提供"允许"。验证：测试。
- [T42-A06] macOS 按 S6 结论走带操作或降级的路径，实际可用的路径有实测截图，另一条路径有测试；降级时设置页说明原因。验证：截图（`tmp/evidence/T42/`）与测试输出。
- [T42-A07] Windows Toast 按钮的生成与激活回调路径有测试，实机验证已登记到 W4。验证：Windows CI 测试输出与 `PLAN.md` 登记事项。
- [T42-A08] Changes 面板中可在多个文件的 diff 行上添加、编辑、删除评论，Mod+Enter 一次发送全部评论。验证：Playwright 与截图。
- [T42-A09] 批量发送的消息包含每条评论的文件路径、行号范围、所在侧与代码摘录。验证：mock provider 请求断言。
- [T42-A10] 会话运行中发送的评论作为排队消息，在当前回合结束后送达。验证：Playwright 与 mock provider 请求断言。
- [T42-A11] diff 更新后未发送的评论重新定位，定位失败的评论标为"已失效"并保留文本。验证：组件测试。
- [T42-A12] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新 `crates/piarc-fs` 的 CLAUDE.md：notebook 保真写入的做法与易错点。
- 更新主进程通知模块与渲染进程 `changes` 模块的 CLAUDE.md：通知答复路径、高风险请求的规则、评论消息格式的位置。
- 更新架构第 8.8 节"系统通知"行：macOS 实际采用的路径。
