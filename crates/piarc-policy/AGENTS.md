# piarc-policy

Core 的 M1 权限裁决与审批账本。AHP 和客户端共享的数据类型在 `piarc_protocol::policy`；路径与信任查询、审计、取消等待及窗口快照由 `piarc_core::tool_io::policy` 串接。

- `evaluate` 使用 Core 已解析的实际路径分类。受保护路径写入和需要交互的提问先进入审批，其余调用先比对精确规则。只读工具可在允许目录内使用；自动接受编辑模式另放行工作区内的 Write、Edit 和通过全部路径检查的简单 Bash 文件命令。
- T23 替换两处 M1 判定。`simple_paths` 只识别 `mkdir`、`touch`、`mv`、`cp` 的保守字面量子集；`exact_rule` 构造区分大小写的完整规则文本。Shell 命令的工作目录、符号链接与隐式目标由 Core 按执行端语义检查。
- `Ledger<T>` 按到达顺序保存待答请求。Core 在同一把会话锁下核对 session、revision、epoch 并取出首个有效答复。旧版本答复保留卡片，重复答复返回已处理。中断、连接失效与取消从账本移除请求并唤醒等待方。
- 失败即拒绝覆盖 Agent Host 的 RPC 及解析失败、Core 的配置与路径检查、审计落库、状态失效。只有 Core 完成裁决和审计才能签发实际 I/O 使用的授权。审批等待随回合和连接生命周期结束。
- `cargo test -p piarc-policy` 检查裁决矩阵与简单命令。实测路径执行 `cargo test -p piarc-core --lib tool_io::policy::tests -- --test-threads=1 --nocapture`，其中自动裁决计时包含项目配置、信任快照、规范路径及审计写入。
