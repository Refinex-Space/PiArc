# 0108. 读取并编辑 Pi 的全局指令

- 状态：已接受（用户在 2026-11-28 选定：PiArc 应像 Pi 一样读取 `~/.pi/agent` 的全局指令，并在设置里查看和编辑它）
- 日期：2026-11-28
- 修订：ADR-0033 第 3 条的用户级来源，在 `~/.claude/CLAUDE.md` 之前加入 Pi 的全局指令
- 相关：ADR-0004（Agent Host 不碰文件系统）、ADR-0033（memory 来源与顺序）、ADR-0101（设置是工作台视图）

## 背景

Pi 1.5.2 的 `loadProjectContextFiles`（`packages/coding-agent/src/core/resource-loader.ts`）在每个会话开头加载上下文文件，分两步：

1. 先在 agentDir 里取第一个存在的文件作为全局指令，按 `AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD` 的顺序找。agentDir 默认是 `~/.pi/agent`，可用 `PI_CODING_AGENT_DIR` 覆盖。
2. 再从 cwd 逐级向上到根目录，每级取一个。

PiArc 让 Core 统一发现 memory（ADR-0033），Agent Host 设了 `noContextFiles: true`，并把 `PI_CODING_AGENT_DIR` 指向 `<数据目录>/pi`。所以第 2 步已经由 Core 的逐级读取覆盖，`~/AGENTS.md` 和项目里的 `AGENTS.md` 都在内；第 1 步的全局文件却没人读。习惯 Pi CLI 的用户写在 `~/.pi/agent/AGENTS.md` 里的约定，在 PiArc 里不生效，界面上也没有入口。

## 决策

1. **加载**：Core 发现用户级 memory 时，先读 Pi 的全局指令：`<家目录>/.pi/agent` 下第一个存在的候选文件，候选与顺序同 Pi。之后是 `~/.claude/CLAUDE.md` 及其 rules，再后是数据目录的 `MEMORY.md`。它和其他 memory 文件一样经 `fs/memory` 送达，每回合检查变化，文件里的 `@` 导入和指向外部的符号链接照旧走审批。实现是 `piarc_core::pi_instructions::global_file`，`memory_reader` 调用它。
2. **位置**：只认家目录下的 `~/.pi/agent`，不跟随用户 shell 里的 `PI_CODING_AGENT_DIR`。Agent Host 进程里的这个变量是 PiArc 自己设置的，指向数据目录，不能用来找用户的文件。测试、L2、L4 都用注入的临时家目录，不读本机的 `~/.pi`。
3. **编辑**：设置“智能体”组新增“指令”页（`#/settings/instructions`），显示这个文件的路径和全文，可以直接编辑保存。读写只在 Core，入口是 NAPI 的 `piInstructions` 与 `savePiInstructions`，主进程 IPC 同名：
   - 编辑的是 Pi 实际加载的那个文件。一个候选都没有时，保存会创建 `AGENTS.md` 和所在目录。
   - 保存要带上读取时内容的 SHA-256；文件已被 Pi CLI 或编辑器改过时返回 `fileModified`，页面提示后可以重新载入，不会覆盖别人的修改。
   - 保持原文件的编码、BOM 和主要换行符（`piarc_fs::encoding`）。符号链接写到链接目标，在目标所在目录原子替换，dotfiles 里的链接因此不会被替换成普通文件。
   - 上限 4 MiB，与 memory 读取的上限相同，保证保存的内容能被读到。
4. **生效**：保存后，运行中的会话在下一个回合看到新内容，走 memory 已有的变化提醒，不需要重启会话。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 只在界面上编辑 `<数据目录>/MEMORY.md` | 不改加载顺序 | 用户在 Pi CLI 里写的全局指令仍不生效，两边各写一份 | 不采用 |
| 读 `<数据目录>/pi/` 下的 `AGENTS.md`（PiArc 的 agentDir） | 不碰用户家目录 | 那是 PiArc 隔离出来的目录，用户不会在那里写，Pi CLI 也不读 | 不采用 |
| 关掉 `noContextFiles`，让 Pi 自己加载 | 与 Pi 完全一致 | Agent Host 会直接读文件系统，违反 ADR-0004；agentDir 已被换掉，读到的也不是 `~/.pi/agent` | 否决 |
| 只读展示，不允许编辑 | 不写家目录 | 不满足需求 | 不采用 |

## 保留的风险

- `~/.pi/agent/AGENTS.md` 与独立运行的 Pi CLI 共用。在 PiArc 里修改会同时影响 Pi CLI，反之亦然。这正是需求的目的；页面显示文件的完整路径。
- 文件不存在时，Core 会在家目录下创建 `~/.pi/agent/`。写入只发生在用户点“保存”时。
- 写入以原子替换完成，会重置文件权限为默认值。
