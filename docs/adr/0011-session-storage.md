# 0011. 会话以 Pi JSONL 为事实来源，Core 维护 SQLite 索引与文件快照

- 状态：已接受
- 日期：2026-11-14
- 相关：架构文档第 9 章

## 背景

- Pi 的会话是 append-only 的 JSONL 树（`CURRENT_SESSION_VERSION = 3`），每个 entry 有 `id/parentId`，leaf 指针表示当前分支；压缩只插入摘要 entry，原始 entry 保留。写入用 `appendFileSync`，不 fsync、不加锁；宿主并发只读是安全的（Pi 调研 4.3 节）。
- Pi 没有会话列表、全文搜索、文件快照。
- Claude 的 preserved thinking 要求历史只追加、不改写（官方调研 C 节），这与 Pi 的 append-only 设计一致。

## 决策

1. **对话内容的唯一事实来源是 Pi 的 JSONL 文件**，存放在 PiArc 应用支持目录下（通过 SDK `agentDir` / 会话目录配置，与用户本机 Pi CLI 隔离）。Core 只读，不写这些文件。
2. **Core 维护 SQLite 索引**（`rusqlite`）：工作区、会话元数据（标题、状态、模型、用量、归档、置顶）、全文索引（FTS5）、权限审计、hooks 执行记录。索引可以从 JSONL 完整重建。
3. **文件快照（checkpoint）由 Core 管理**：每次经 Core 执行的写操作之前，保存原文件内容到内容寻址存储（按 hash 去重），并按"会话 + 用户回合 entry id"建立索引。rewind 时代码回退由 Core 完成，对话回退复用 Pi 的分支能力（在指定 entry 处 fork 或移动 leaf）。
4. 快照保留策略：每个会话最近 100 个检查点，30 天未访问的会话快照清理；数值可配置。与 Claude Code 一致，只被 Bash 改动过的文件不纳入快照，UI 中明确说明并建议配合 git 使用。
5. 应用自身状态（窗口布局、最近工作区等）存 SQLite 或 `UserDefaults`，不与会话数据混放。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 全部存 SQLite，Pi 用内存会话 | 查询能力强 | 要在 Core 中重写会话树、压缩、分支逻辑，并持续跟随 Pi 格式 | 否决 |
| 用 git 影子仓库做快照 | 能覆盖 Bash 改动 | 大仓库性能差，二进制文件膨胀，和用户 git 操作互相干扰 | 作为后续可选增强 |

## 后果

- 正面：会话格式跟随 Pi 上游，无需自建迁移；索引坏了可以重建。
- 负面与代价：Pi 会话格式升级时要更新 Core 的只读解析器；JSONL 文件可能很大（Claude Code 社区有 3.7 GB 单会话导致崩溃的报告），解析器必须流式、增量。
- 需要配套做的事：Core 的 JSONL 读取器支持按 entry id 增量读取（对应 Pi `get_entries since` 的语义）。

## 重新评估的触发条件

- Pi 改变会话存储模型（例如迁移到 durable）；
- 单会话文件大小导致恢复时间超出预算。
