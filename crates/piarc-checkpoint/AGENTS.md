# piarc-checkpoint

检查点的纯逻辑部分（架构第 6.9 节，ADR-0011、ADR-0044）：内容寻址的对象库 `ObjectStore`、回退 / 撤销 / Changes 基线的计划函数（`plan`）、保留策略 `RetentionPolicy`。索引表在 `piarc-store`（schema v5 的 `checkpoints`、`checkpoint_files`、`checkpoint_sessions`），编排在 `piarc-core::checkpoints`（建检查点、记录、保留、回收）与 `piarc-core::tool_io::checkpoints`（回退、撤销、Changes、丢弃）。写入原文件之前存快照由 `piarc-fs` 调用本 crate（`fs → checkpoint` 是 `crates/deps-rules.json` 登记的单向例外），本 crate 不依赖任何功能 crate。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-checkpoint` | 对象库（同内容一份、读时校验哈希、钉住与回收、回收后重新存入、只删过期临时文件）与计划（新建文件删除、跨回合取回合开始时的内容、冲突、之前的回退计入、撤销遇到再次改动列为冲突、基线） |
| `cargo test -p piarc-core --lib tool_io::checkpoints` | 经 Core 的 `ToolIo`：A01 对象计数、冲突逐个选择、注入写入失败后停止与撤销、丢弃、CRLF 与 BOM、保留与回收（时钟注入） |
| `cargo clippy -p piarc-checkpoint --all-targets -- -D warnings` | lint |

## 存储布局与写入顺序

- 对象在 `<数据目录>/checkpoints/objects/<哈希前两位>/<64 位哈希>`（`DataDirs::checkpoint_objects`），先写同目录的临时文件再 rename；读出时校验 SHA-256，不符报错，不返回内容。临时文件超过 1 小时才被回收删除（可能是正在写的）。
- 顺序固定：`piarc-fs` 在路径锁内、原子替换之前 `put` 旧字节 → 替换成功 → Core 写 `checkpoint_files` → 释放 `Pin`。替换失败留下的对象没有记录，由下一次回收删除。不要先写索引再存对象：索引会指向不存在的快照。
- `put` 先钉住再检查文件是否存在，`collect_garbage` 在钉住表的锁内检查并删除，所以回收与写入交错时不会删掉刚存入的对象。调用方先读引用集合再遍历时，用 `begin_collection()` 在读引用之前开始回收：回收进行期间释放了最后一个钉的对象本次保留（R3：写入可能在读引用之后才记行并释放钉）。回退、撤销、丢弃在读快照与写回期间持有 `Pin`。

## 计划规则（`plan.rs` 模块文档为准）

- 恢复到回合 T 之前 = 该会话检查点 id ≥ T 的全部记录，按路径（`key` 由调用方给，Core 用 `Scope::key`，Windows 不区分大小写）取第一条的"之前"为目标、最后一条的"之后"为会话留下的内容。按时间算，与对话分支无关。
- 当前内容 = 目标：`Unchanged`；= 会话留下的：`Write` 或 `Delete`；其余（外部或 Bash 改过、被删）：`Conflict`，由用户逐个选。
- 回退、撤销、丢弃自己也写记录（`restore`、`undo`、`discard`，挂在最新检查点），所以下一次回退与 Changes 基线把它们计入；撤销按恢复批次 id 找记录，已被再次改动的文件列为冲突。
- Changes 基线 = 每个路径最早一条记录的"之前"（`None` 为新建文件）。

## 保留与回收

- `RetentionPolicy` 默认每会话 100 个检查点、30 天未访问（`DEFAULT_MAX_CHECKPOINTS`、`DEFAULT_IDLE`），经 `CoreConfig.checkpoints` 改；时间一律来自注入的 `now_ms`，测试不睡眠。
- 每个回合结束后 `Checkpoints::prune` 删掉该会话超出数量的最早检查点；Core 启动后与之后每 6 小时 `sweep`：删超期会话的全部记录，再按 `referenced_snapshots` 回收未引用、未钉住的对象。删除会话时 `forget_session` 删记录，对象随下次回收。

## 易错点

- 设置 `fileCheckpointingEnabled: false`（Claude Code 同名键）时 Core 不建检查点、写入不存快照：该回合的回退预览 `codeAvailable` 为假；之前记录的回合仍可恢复。
- 只被 Bash 改动的文件没有记录：不在回退与 Changes 里，界面写明并建议配合 git，不要补扫工作区。
- 子 agent（T31）的写入按会话 id 记录，接入时复用同一入口；跨会话合并是 ADR-0044 的重新评估条件。
