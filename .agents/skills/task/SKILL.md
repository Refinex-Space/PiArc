---
name: task
description: 按 docs/plan/tasks/ 中的任务提示词执行一个交付任务。与 Claude Code 的 /task 命令等效，只在用户输入 $task <任务编号>（如 $task T05、$task W1、$task R2）时运行。
---

要执行的任务编号：用户在 `$task` 后面给出的编号。

如果没有给出编号，或者 `docs/plan/tasks/` 下不存在以该编号加短横线开头的文件，停止并请用户给出正确的编号，不要猜测。

否则：

1. 先运行下面三条命令，记下结果，作为开工检查的输入：
   - 当前平台：`node -p "process.platform + ' ' + process.arch"`
   - 当前仓库状态：`git status --short`
   - 最近的提交：`git log --oneline -5`
2. 找到 `docs/plan/tasks/` 下文件名以该编号加短横线开头的任务文件，完整读取它。
3. 把这个文件的全部内容当作本次会话的任务提示词，严格按它执行。它要求先读的 `docs/plan/protocol.md` 等文件，同样要完整读取并遵守。
4. 完整执行任务。只在协议规定的情况下停下：前置条件不满足、执行平台不符、变更型 ADR、任务关口、需要用户授权的操作。
