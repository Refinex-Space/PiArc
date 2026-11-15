# T16 文件工具与编辑不变量

| 项 | 内容 |
|---|---|
| 阶段 | 2 M1 可行走骨架 |
| 依赖 | T15 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort xhigh，新会话 |
| 规模 | 大 |
| 关联验证项 | 无 |
| 关联需求 | FR-TL-01、FR-TL-02 |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T16`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

Claude Code 的专业度很大一部分来自文件工具的严格语义：先读后改、唯一匹配、保真写入、输出截断。模型在这些约束下很难把文件改坏，出错时也能得到清楚的反馈。T07 已经让 Read、Write、Edit、Glob、Grep 的 I/O 经过 Core，但只是"能用"。本任务在 Core 中补齐架构第 6.1.2 节的全部不变量，并用 L2 场景逐条覆盖。

完成后，每条不变量都有一个 L2 场景和一个稳定的能力 ID，两个平台的 CI 都在跑。

## 必读

1. 架构设计：
   - 第 6.1.2 节"工具语义不变量"、第 6.1.4 节"第一版工具清单"
   - 第 6.15 节"工程不变量与初始校准值"中的截断与重复读取两行
   - 第 7.1 节（piarc-fs、piarc-diff 的职责）、第 7.7 节"diff 与预处理"
2. `docs/research/harness-reference-notes.md` 第 1.2 节"工具契约"。
3. T07、T15 交付的代码与 CLAUDE.md：Operations 委托、`fs/*` 方法、L2 场景格式、`tests/capabilities.yaml`。
4. 实现时查阅：
   - Pi 锁定版本中 Read/Edit/Write 工具的参数与结果格式、`withFileMutationQueue`；
   - `ignore` 与 `grep-searcher` crate 的 API；
   - 需要的 PDF、图片处理库的文档。

## 范围

### 要做

- piarc-fs：文件状态表、全部编辑不变量、路径边界与受保护路径、输出截断与落盘、重复读取存根。
- piarc-diff：结构化 diff 与 hunk。
- Read 的分页、图片、PDF、ipynb；Glob 与 Grep 遵守 `.gitignore`。
- 每条不变量一个 L2 场景，登记能力 ID。

### 不做

- Bash 与 PowerShell（T17）、写前快照与回退（T28）、审批与权限规则（T20、T23）。
- 受保护路径的"询问"交互：本任务只在 Core 中把这类写入标记为"需要询问"并返回给裁决层；M1 的裁决与审批卡由 T20 实现。在 T20 之前，这类写入按拒绝处理，并给出明确理由。

## 交付物

### 1. 文件状态表

- 每个会话一张表：规范化路径 → 最近一次读取时的内容 hash、mtime、读取范围。
- 路径规范化：相对路径、符号链接、大小写不敏感的卷（macOS 默认卷与 Windows），以及 Windows 的 `\\?\` 前缀。规则写进 piarc-fs 的 CLAUDE.md。
- 子 agent 的状态表与父会话分开（T31 会用到，本任务预留按会话隔离的接口）。

### 2. 编辑不变量（逐条对应架构第 6.1.2 节）

| 不变量 | 实现要求 |
|---|---|
| 先读后改 | 对已存在文件执行 Edit 或 Write 前，本会话必须读过它，否则返回明确错误，要求先 Read |
| 外部修改检测 | 读取后文件的 hash 或 mtime 变化，Edit 返回错误，要求重新读取 |
| 唯一匹配 | Edit 的旧文本必须唯一出现，或显式 `replace_all`；多处匹配时报错并给出匹配次数，不替换第一处；零匹配时报错 |
| 保真写入 | 保留原文件的换行风格（LF/CRLF）、编码与 BOM；写入用同目录临时文件加原子 rename；新文件默认 UTF-8 无 BOM、LF |
| 结构化 diff | 每次变更产生 unified diff 与 hunk 结构（piarc-diff，基于 similar），随 `fileChange` item 下发 |
| 输出截断 | 单个工具结果超过 50K 字符时写入会话临时目录，模型收到约 2KB 预览与文件路径；单条消息内工具结果合计上限 200K 字符。阈值集中定义，可配置 |
| 重复读取 | 文件自上次读取后未变化、且读取范围相同，Read 返回简短存根，提示内容未变 |
| 路径边界 | 默认只允许读写工作区与已添加目录。越界访问返回"需要询问"，由裁决层处理 |
| 受保护路径 | `.git/`、`.piarc/`、`.claude/`、`.pi/`、shell 配置文件的写入标记为"需要询问"，在 Manual 与 Accept edits 模式下都询问 |
| 并发 | 写同一文件的操作经 Pi 的 `withFileMutationQueue` 串行，Core 侧再以路径锁兜底 |

### 3. Read、Glob、Grep

- Read：文本带行号，支持 offset 与 limit 分页；图片（PNG、JPEG、GIF、WebP）按模型能力返回图像块，模型不支持视觉时返回说明文字；PDF 分页提取文本（超过阈值页数必须指定页码范围）；`.ipynb` 渲染为 cell 列表与输出摘要。
- Glob 与 Grep：基于 `ignore` 与 `grep-searcher`，遵守 `.gitignore`、`.ignore`，默认跳过二进制文件；结果数量与总长度有上限，超出时截断并说明。

### 4. L2 场景与能力 ID

- 第 6.1.2 节每条不变量至少一个场景（`tests/scenarios/tools-*.yaml`），能力 ID 登记在 `tests/capabilities.yaml`，例如 `CAP-TOOL-EDIT-UNIQUE-001`。
- 场景断言同时覆盖三个方面：给模型的工具结果（mock provider 请求断言）、文件副作用、事件中的 `fileChange` diff。
- CRLF、BOM、GBK（或其他非 UTF-8 编码）文件的夹具放在 `.gitattributes` 设置的例外目录中，保证 Git 不改动换行。

## 实现要点

- 错误信息是给模型看的：写清楚"发生了什么、模型下一步该做什么"。例如"文件自上次读取后已被修改，请先用 Read 重新读取"。
- 截断预览取头部与尾部，中间标明省略的字符数；落盘文件路径用会话临时目录内的相对路径，不暴露用户名。
- 编码检测只在"非 UTF-8"时启用，写回时用原编码，避免把 GBK 文件写成 UTF-8。
- 原子 rename 在 Windows 上目标存在时的行为不同：用 `std::fs::rename` 前确认语义，必要时用 `ReplaceFileW` 的等价实现。Windows CI 必须覆盖。

## 验收标准

- [T16-A01] 架构第 6.1.2 节表中的每条不变量都有对应的 L2 场景且全部通过，能力 ID 登记在 `tests/capabilities.yaml`。验证：场景运行输出与能力清单（无 MISSING）。
- [T16-A02] 未读先改、读后被外部修改、多处匹配、零匹配四种情况都返回明确错误，文件内容不变。验证：场景测试。
- [T16-A03] CRLF、带 BOM、非 UTF-8 编码的文件经 Edit 后，换行风格、BOM 与编码保持不变，且只有目标文本被修改。验证：macOS 与 Windows CI 上的测试输出。
- [T16-A04] 写入中途失败（模拟磁盘错误）时原文件保持完整。验证：测试。
- [T16-A05] 超过 50K 字符的工具结果落盘，模型收到预览与路径；单条消息合计超过 200K 字符时按规则截断。验证：mock provider 请求断言。
- [T16-A06] 未变化文件的重复读取返回存根；文件变化或读取范围不同时返回完整内容。验证：场景测试。
- [T16-A07] 工作区外路径与受保护路径的写入返回"需要询问"；在 T20 之前按拒绝处理并给出理由。验证：测试。
- [T16-A08] Read 正确处理行号分页、图片（视觉与非视觉模型两种情况）、PDF 页码范围、ipynb。验证：测试。
- [T16-A09] Grep 与 Glob 遵守 `.gitignore`，跳过二进制文件，结果超限时截断并说明。验证：测试。
- [T16-A10] 每次文件变更的 `fileChange` item 带结构化 diff，hunk 与实际改动一致。验证：测试。
- [T16-A11] `npm run verify` 通过（含 Windows CI 上的 L2 场景）。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 创建或更新 `crates/piarc-fs` 与 `crates/piarc-diff` 的 CLAUDE.md：路径规范化规则、阈值常量位置、Windows 上的原子写入、易错点。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：路径规范化、保真写入、截断与落盘。
