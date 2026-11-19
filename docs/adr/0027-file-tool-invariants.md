# 0027. 文件工具不变量的落点：Core 的状态表与写入，Harness Kit 的匹配与结果预算（补充）

- 状态：已接受（补充 ADR-0004 第 3 条、ADR-0020，T16）；第 1、4 条的读取登记时点由 ADR-0034 修订
- 日期：2026-11-17
- 取代：无
- 相关：架构文档第 6.1.2–6.1.4、6.15、7.4、7.7 节；ADR-0009 第 8 条、ADR-0020

## 背景

架构第 6.1.2 节要求文件工具满足一组不变量：先读后改、外部修改检测、唯一匹配、保真写入、结构化 diff、输出截断、路径边界与受保护路径、并发串行；第 6.15 节另有截断阈值与重复读取。T07 只让 Read、Write、Edit、Glob、Grep 的 I/O 经过 Core（ADR-0020），这些不变量还没有落地。

落点有三个选择：全部放进 Core，全部放进 Agent Host，或按职责拆开。限制条件：

- Pi 1.5.2 的 edit 有多处编辑、模糊匹配、保留未改行的换行符拼接，这部分不在包入口导出；整体搬进 Core 等于移植约 500 行并失去随 Pi 升级的修复（ADR-0020 已否决）。
- 文件状态、编码、原子替换都依赖读写真实文件，只有 Core 能做（Agent Host 不碰文件系统）。
- 工具结果的大小控制要看到每个工具（含 MCP 与扩展工具）的结果，以及一次回复的全部结果，只有 Agent Host 的 Pi 钩子看得到。

## 决策

1. **文件状态表在 Core**（`piarc_fs::FileStates`，每个会话一张，随会话在 Core 中打开而存在）：键是规范路径（解析符号链接、去掉 `\\?\`，大小写不敏感的卷上折叠大小写），值是内容 SHA-256、大小、mtime 与 `Read` 调用的范围（会话自己写入的条目没有范围）。判断变化以哈希为准。`fs/stat` 带 `read` 时登记一次读取并回答 `unchanged`；`fs/read` 带 `requireFresh`（Edit 读文件时）与 `fs/write` 替换已存在的文件时检查"本会话读过或写过、内容未变"，否则 `fileNotRead`、`fileModified`。子 agent 作为独立会话有自己的表。
2. **写入在 Core**（`piarc_fs::write`）：持有该文件的路径锁（所有会话共享）完成"检查新鲜度 → 解码旧文本 → 按旧文件的编码与 BOM 编码新文本（`lineEndings: matchFile` 时再换成旧文件的主要换行风格）→ 同目录临时文件写入并 `fsync` → rename 覆盖 → 登记写入"。新文件为 UTF-8 无 BOM、换行照写。编码只在不是 UTF-8 时检测（BOM、合法 UTF-8、含 NUL 的二进制之外交给 `chardetng`，用 `encoding_rs` 编解码）；新文本含旧编码表示不了的字符时整次写入被拒（`unencodableText`）。大文本以一次上传（`upload`）分段发送，最后一段到达才写入，失败时原文件完整。结果带 `piarc-diff` 算出的 `FileDiff`。
3. **匹配仍用 Pi 的 edit**（ADR-0020 不变）：唯一匹配、零匹配与重叠由 Pi 报错；PiArc 在 Edit 参数上增加 `replaceAll`，此时由工具层自己做精确匹配并按 Pi 的拼接方式保留换行（移植 Pi 的两个函数，MIT），多处匹配的报错附上 `replaceAll` 的提示。Write 交给 Core 的文本用 `matchFile`，Edit 用 `asWritten`（Pi 已保留每行原有的换行）。
4. **Read 的扩展在工具层**：行号作为文本流的变换加在 Pi 选行之前（`cat -n` 格式，Pi 的选行、截断与提示照旧）；查找文件时向 Core 登记读取，重复读取直接返回存根；`.pdf` 交给 Core 的 `fs/pdf`（`lopdf` 提取文本，超过 10 页必须给 `pages`，每次至多 20 页）；`.ipynb` 在工具层渲染为 cell 与输出摘要；不支持图片的模型只收到说明，不带图片块。
5. **询问的标记在 `piarc-fs`，裁决在 Core**：会话目录（工作区根、已添加目录）之外的读写、受保护路径（`.git/`、`.piarc/`、`.claude/`、`.pi/` 与 shell 配置文件）的写入标记为需要询问（`piarc_fs::Error::NeedsApproval`），会话临时目录可读不可写。`tool_io` 的 `adjudicate` 在 T20 之前一律拒绝，返回 `permissionDenied`，消息写明原因与下一步；T20 在这里接入审批。
6. **结果预算在 Harness Kit**（`agent-host/src/harness/tool-results.ts`，阈值集中在 `TOOL_RESULT_LIMITS`）：`tool_result` 钩子把超过 50K 字符的结果交给 Core 的 `fs/spill` 写入会话临时目录，模型收到约 2KB 的头尾预览与路径（家目录下以 `~` 开头，不含用户名）；`context` 钩子在每次请求前让一次回复的全部结果合计不超过 200K 字符，从最大的开始换成预览，决定按工具调用 id 记住，使每次请求的文本相同。Read 不参与（它的输出已有上限并会提示下一段）。
7. **diff 随条目下发**：Write、Edit 把 `fs/write` 结果里的 `FileDiff` 放进工具结果的 `details.fileDiff`，投影器（实时与历史）放到 `fileChange` 条目的 `diff`。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| Edit 整体移到 Core（`fs/edit`） | 一处实现全部不变量 | 移植 Pi 的匹配与拼接，失去上游修复；改变 ADR-0020 第 2 条 | 否决 |
| 先读后改只在 Agent Host 记账 | 不改 Core | 其他会话与外部修改看不到；写入与检查不在同一把锁下 | 否决 |
| `append` 分段写入沿用 T07 | 不加协议成员 | 第一段就截断了原文件，中途失败留下半个文件 | 否决（`append` 保留，语义变为"追加到当前文本"并受同样的检查） |
| PDF 用 `pdf-extract` | 文本间距更好 | 依赖 lopdf 0.42，引入已停止维护的 `ttf-parser`（RUSTSEC-2026-0192），cargo-deny 拒绝 | 否决，改用 lopdf 0.46 自带的提取 |
| 截断在每个工具里各自做 | 不需要钩子 | MCP 与扩展工具覆盖不到；单条消息的合计无从判断 | 否决 |
| 截断时按完成顺序累计预算 | 不需要每次请求前处理 | 并行工具的完成顺序不确定，结果不可复现、破坏缓存 | 否决 |

## 后果

- 正面：第 6.1.2 节的每条不变量都有实现与 L2 场景（`tests/scenarios/tools-*.yaml`）；写入的失败不会留下半个文件；编码、BOM 与换行不被工具改写；diff 有了单一来源，T28 的快照与 Changes 面板可以直接使用。
- 负面与代价：每次 Read 登记与每次写入检查都要读一遍文件求哈希；Windows 上 rename 覆盖不保留原文件的 ACL 与备用数据流（保留隐藏、系统属性）；含非法 UTF-8 的 UTF-8 文件经编辑后这些字节变成 U+FFFD；lopdf 的文本提取对部分 PDF（例如资源写在页树节点上的内联字典）取不到文字（I71）。
- 需要配套做的事：T20 在 `tool_io::files::adjudicate` 接入审批；T27 压缩上下文后清掉状态表里的读取范围，避免存根指向已被压缩掉的结果（I72）；T28 的写前快照接在 `piarc_fs::write` 的锁内。

## 重新评估的触发条件

- Pi 的 edit 支持替换全部，或把匹配函数从包入口导出（`replace-all.ts` 可以删去）；
- `pdf-extract` 升级到不依赖 `ttf-parser` 的 lopdf（换回更好的文本提取）；
- 审批流程（T20）需要在询问之前知道更多上下文（例如 Bash 命令触及的路径），`NeedsApproval` 的字段不够用。
