# 0060. NotebookEdit、可操作通知与 diff 行内评论的落地（补充）

- 状态：已接受，补充 ADR-0018、ADR-0027、ADR-0031、ADR-0044
- 日期：2026-11-21
- 相关：架构第 6.1.4、7.4、8.2、8.8 节；T42；FR-TL-06、FR-SY-03、FR-RV-04

## 背景

T42 交付基线里排在 M4 的三件事：Jupyter notebook 的 cell 编辑工具 `NotebookEdit`、在系统通知里直接允许或拒绝、在 Changes 面板的 diff 行上写评论并一次发给 agent。基线只写了工具名、"通知内直接允许 / 拒绝在 M4"与 FR-RV-04 的一句话，下面是实现时定下的细节。

调研结论（2026-11-21 核对 Claude Code 官方文档与锁定的 Electron 45）：`NotebookEdit` 的参数是 `notebook_path`、`cell_id`、`new_source`、`cell_type`、`edit_mode`（`replace`、`insert`、`delete`），`Edit(...)` 规则覆盖它；Electron 45 的 `Notification` 在 macOS 与 Windows 上都支持 `actions`（按钮）与 `action` 事件。

## 决策

### NotebookEdit

1. **不解析再序列化。** notebook 按 JSON 扫描出每个 cell 的字节区间，只替换、插入或删除一个 cell 的那一段，cell 之外的字节不变（`piarc_fs::notebook`）。被改的 cell 按文件自己的缩进、换行与分隔风格重写，键按 nbformat 的排序；它不改的键（`id`、`metadata`、`attachments`）保留原文。替换代码 cell 的源码时清空 `outputs` 与 `execution_count`（它们不再对应新代码）。
2. **两份实现、一份向量。** Core 用 Rust 版算出批准的结果（审批卡的 diff、写入的核对），Agent Host 的工具用同一算法的 TypeScript 版（`agent-host/src/tools/notebook-text.ts`）算出要写的文本；两者都跑 `tests/notebook/` 的共享向量（含 CRLF、四空格缩进、无 id 的旧版 notebook）。
3. **定位与新 cell 的 id。** `cell_id` 是 cell 的 `id`；没有 id 的旧版 notebook（nbformat 4.5 之前）按序号定位（`cell-N` 或 `N`，从 0 起）。插入放在指定 cell 之后，没有指定时放在最前。notebook 使用 id 时，新 cell 的 id 取工具调用 id 的 SHA-256 前 8 个十六进制字符，与已有 id 冲突时在种子后加 `-n` 重算，所以 Core 与 Agent Host 不用通信就得到同一个 id。
4. **与文件工具同一条路。** 先读后改、外部修改、检查点快照、`fileChange` diff、受保护路径与模式默认都沿用 `Write`/`Edit` 的实现：读写经 `fs/read`（`requireFresh`）与 `fs/write`，授权按调用绑定（ADR-0031），规则匹配 `Edit(...)`。

### 可操作通知

5. **哪些卡片可以从通知放行。** Core 在卡片上标 `notificationAllow`（`tool_io/policy/notify.rs`）：只有普通命令（有可保存的规则、单行、不超过 160 个字符）与小的文件改动（增删合计不超过 12 行、未降级）可以；关键路径删除、沙箱外重试、受保护路径、参数超出通知能完整显示的长度，通知只给"打开"。通知没有地方放第 8.5 节的阅读闸门，所以只放行能在通知里读完的请求。
6. **同一账本。** 通知的按钮经 `answerApproval` 答复，带 `via: notification`、卡片的 `requestId`、`revision`、`connectionEpoch`；Core 只接受"仅本次允许"（且卡片标了 `notificationAllow`）或不带反馈的"拒绝"，先到的有效答复生效，过期答复被拒绝并在应用内提示。审计来源记为"通知"（`notification`）。
7. **平台。** macOS 与 Windows 都用 Electron 的 `actions`（macOS 的通知按钮、Windows Toast 的按钮）；系统通知放在主进程的窄接口 `NotificationPort` 后面，测试替换为替身并断言账本调用与参数。系统不支持通知时设置页说明原因。macOS 的 ad-hoc 签名构建在用户允许通知后显示横幅（S6），Windows 的实机核对登记到 W4。

### diff 行内评论

8. **评论是渲染进程的草稿。** 评论绑定到一个文件的旧侧或新侧的行号范围，带写下时的行文本（摘录），按会话存在 `localStorage`（第 7.3 节：丢了不影响业务）。diff 更新后先在原位置、再在同一侧的全部 hunk 里按摘录找回，找不到的标"已失效"并保留文本，不发送。
9. **一次发送，格式集中定义。** Mod+Enter（或"发送评论"）把全部未失效的评论拼成一条消息，按文件分组，每条写明路径、行号范围、所在侧、代码摘录与正文（`changes/comments.ts` 的 `formatComments`）。会话空闲时作为 prompt 发出，运行中时作为排队的 follow-up，与 composer 的 Mod+Enter 一致。Core 与 Agent Host 不需要新接口，所以 FR-RV-04 登记为 `client_only`，由 L4 验证。
10. **审批快捷键让出文本框。** 等待审批时，审批卡的 Mod+Enter 在捕获阶段对整个窗口生效；在卡片与 composer 之外的文本框（评论编辑框）里按下的键留给该文本框，既不答复审批也不被吞掉。

## 影响

- `ApprovalRequest` 新增 `notificationAllow`，`ApprovalAnswer` 新增可选的 `via`（`AnswerVia::Notification`）；都是补充，旧答复语义不变。
- 工具清单新增 `NotebookEdit`（Tool Profile、提示词与原创性检查已更新）；L2 新增 `notebook-edit-*` 与 `notify-approval` 场景，审批应答可写 `via` 与 `notification_allow`。
- 主进程的通知模块新增动作回调与 `answerApproval` 的连接，应用状态新增 `notificationsSupported`，渲染进程新增 `approvalNotice` 应用事件；没有新增 IPC 命令。

## 备选方案

- **notebook 整体解析再序列化**：serde_json 的输出风格与 Jupyter 不同（缩进、键序、`ensure_ascii`），每次编辑都是整文件 diff，检查点与审查都失去意义。
- **新 cell 的 id 由 Core 生成后告诉 Agent Host**：需要多一次往返；从调用 id 派生是确定的，两边独立算出同一个值。
- **通知里放行任何请求**：通知放不下长命令与大 diff，用户看不到全文就批准，违背阅读闸门的初衷。
- **评论存在 Core**：评论只在发送前有意义，发送后就是普通消息；放在 Core 要新增存储与接口，换来的只是跨设备保留草稿。
