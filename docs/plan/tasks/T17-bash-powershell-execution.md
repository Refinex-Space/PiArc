# T17 Bash / PowerShell 执行与进程管理

| 项 | 内容 |
|---|---|
| 阶段 | 2 M1 可行走骨架 |
| 依赖 | T16 |
| 执行平台 | macOS（Windows 行为由 CI 与 W1 验证） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 大 |
| 关联验证项 | 无 |
| 关联需求 | FR-TL-01、FR-TL-02 |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T17`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

T07 让 Bash 的执行经过 Core 的 `exec/run`，但只是最小实现：超时不杀子进程、输出不截断、cwd 不保留。这些正是 claw-code 踩过的坑（超时不杀进程、只杀直接子进程、管道不读导致死锁，见 `harness-reference-notes.md` 第 2.2 节）。本任务按架构第 6.11 节补齐 Bash 的行为，并在 Windows 上提供经 Git Bash 执行的 `Bash` 与仅 Windows 可用的 `PowerShell` 工具。

完成后，命令超时或被中断时整棵进程树都会被终止，长输出不会撑爆上下文，bash 卡需要的结构化数据由 Core 给出。

## 必读

1. 架构设计：
   - 第 6.11 节"Bash 行为"一条
   - 第 6.2.2 节"Windows 上的命令"一条
   - 第 6.1.3 节 `BashOperations` 一行、第 6.15 节"工具结果截断"一行
   - 第 5.3 节最后一条（语义成败）、第 5.4 节"凭据不放进环境变量"
   - 第 15.2 节"Shell""进程树""换行与编码"三行、第 15.3 节
2. ADR-0004。
3. `docs/research/harness-reference-notes.md` 第 2.2 节第 5、6 条。
4. T07、T11、T14、T16 交付的代码与 CLAUDE.md：`exec/run` 的最小实现、Job Object 实现、`commandExecution` 投影、截断与落盘能力。
5. 实现时查阅：Pi 锁定版本的 `createBashTool` 与 `BashOperations.exec` 签名、Pi 在 Windows 上定位 bash 的逻辑；Rust 标准库与所用进程库的进程组、信号、Job Object 接口。

## 范围

### 要做

- piarc-exec：独立进程、进程组 / Job Object 终止、cwd 保留与越界重置、超时、输出截断与落盘、语义退出码、命令环境、流式输出。
- Windows：Git Bash 探测与缺失提示、`Bash` 经 Git Bash 执行、`PowerShell` 工具。
- `commandExecution` item 的结构化字段（bash 卡数据）。
- 每条行为一个 L2 场景，登记能力 ID。

### 不做

- 前台超时转后台、`run_in_background`、Monitor、KillShell（T32）。本任务中超时即终止。
- 沙箱执行（T39）、Bash 与 PowerShell 的规则分析与只读白名单（T23）、审批（T20）。
- bash 卡界面（T19）。

## 交付物

### 1. 进程与终止

- 每条命令一个独立进程。macOS 放进新的进程组，终止时先向进程组发 SIGTERM，宽限期后发 SIGKILL；Windows 挂进 Job Object（`KILL_ON_JOB_CLOSE`），终止时关闭 Job。
- 超时、会话 abort、Core 关闭三种情况都终止整棵进程树。
- 复用 T11 的 Job Object 实现。它若在 piarc-sandbox 中，按依赖规则处理：移到 piarc-exec，或在 `crates/deps-rules.json` 登记一条明确的单向依赖例外并写理由（补充型）。

### 2. 工作目录

- `cd` 在工作区内跨命令保留：命令结束后取得 shell 的最终工作目录，作为该会话下一条命令的 cwd。
- 最终目录不在工作区与已添加目录内时，重置为工作区根，并在工具结果中说明原因。
- Windows 上 Git Bash 给出的 `/c/…` 形式路径转换为 Windows 路径后再做边界判断。

### 3. 超时与输出

- 默认超时 2 分钟，上限 10 分钟；模型传入超过上限的值时按上限执行并在结果中说明。超时终止后结果包含已有输出与"已超时终止"的说明。
- 成功输出内联约 30,000 字符；超出时写入会话临时目录，模型收到约 2,000 字符预览与文件路径。失败输出给出头部与尾部。阈值集中定义，可配置，落盘复用 T16 的截断能力。
- stdout 与 stderr 持续读取，任何一方输出量大都不阻塞子进程。

### 4. 语义退出码

- 判定表集中定义并测试：`grep`/`egrep`/`fgrep`/`rg` 退出码 1 为"无匹配"，`diff`/`cmp` 退出码 1 为"有差异"，`test`/`[` 退出码 1 为"条件为假"，这些情况的语义状态为成功。
- 整条命令只有一个简单命令时套用判定表；含管道或控制运算符时只看退出码。T23 引入语法分析后再细化。
- 投影器按 Core 给出的语义状态设置 item 状态（T14 的规则）。

### 5. 命令环境

- 以用户登录 shell 的环境为基础：从 Dock 或开始菜单启动的应用拿不到 shell 配置中的 PATH，启动时用登录 shell 解析一次并缓存。
- 剔除 PiArc、Electron、Node 的内部变量（如 `ELECTRON_*`、`NODE_OPTIONS`、`PI_*`），清单集中定义并测试；不注入任何凭据（第 5.4 节）。
- Windows 子进程控制台使用 UTF-8（第 15.2 节）。

### 6. Windows 命令

- Git Bash 探测：设置中的显式路径 → 常见安装位置 → 由 `git` 可执行文件位置推导。找到时 `Bash` 经 Git Bash 执行。
- 找不到时不向模型暴露 `Bash`，只提供 `PowerShell`，并通过 Core 事件提示用户安装 Git for Windows（第 15.2 节）。
- `PowerShell` 工具只在 Windows 注册：优先 PowerShell 7（`pwsh`），没有时用 Windows PowerShell 5.1；工具描述由 PiArc 自写；输出、超时、终止、截断规则与 Bash 相同。

### 7. 流式输出与结构化数据

- 执行期间输出经 `exec/run` 的通知流式回传 Agent Host，并以 item 增量经 Core 的事件批次到达客户端。
- `commandExecution` item 带：命令、cwd、退出码、语义状态、耗时、是否超时、是否截断与落盘路径。

### 8. L2 场景与能力 ID

超时终止进程树、cd 保留与越界重置、输出截断、语义退出码、环境剔除、Windows 的 Git Bash 与 PowerShell 各至少一个场景（`tests/scenarios/exec-*.yaml`，Windows 专属场景标 `platforms: [windows]`），能力 ID 形如 `CAP-EXEC-TIMEOUT-001`。

## 实现要点

- 进程树测试要真的制造孙进程（例如命令里再启动一个长时间 sleep 的子 shell），测试结束后按 PID 确认它们都已退出。
- 取最终 cwd 的方式（例如在命令后追加写出 `pwd` 到临时文件）不能改变命令的退出码与输出；这段包装代码对模型不可见。
- 登录 shell 解析环境会执行用户的 shell 配置文件：加超时，失败时退回当前进程环境并记录警告。
- PowerShell 输出编码与 Git Bash 路径转换只能在 Windows 上验证，CI 必须覆盖；实机核对留给 W1。

## 验收标准

- [T17-A01] 命令超时后整棵进程树（含孙进程）被终止，结果包含已有输出与超时说明（T32 之后超时改为转后台，届时由 T32 更新场景期望，进程树终止能力仍用于 abort 与 KillShell）。验证：macOS 与 Windows CI 上的测试输出。
- [T17-A02] 会话 abort 时正在执行的命令及其子进程全部被终止，对应 item 状态为 `interrupted`。验证：场景测试。
- [T17-A03] `cd` 到工作区内子目录后，下一条命令在该目录执行；`cd` 到工作区外后，下一条命令回到工作区根，结果中说明了重置原因。验证：场景测试。
- [T17-A04] 默认超时为 2 分钟；传入超过 10 分钟的超时按 10 分钟执行并说明。验证：单测（时钟可注入）。
- [T17-A05] 超过 30,000 字符的成功输出落盘，模型收到约 2,000 字符预览与路径；失败输出给出头部与尾部。验证：场景测试中的 mock provider 请求断言。
- [T17-A06] stdout 与 stderr 各输出 50 MB 的命令正常结束，不死锁。验证：测试。
- [T17-A07] `grep` 无匹配与 `diff` 有差异时退出码为 1，语义状态与 item 状态为成功；同一命令真正出错（退出码 2）时为失败。验证：场景测试。
- [T17-A08] 命令环境中没有 PiArc、Electron、Node 的内部变量，也没有任何凭据；登录 shell 中配置的 PATH 生效。验证：测试。
- [T17-A09] 输出在命令结束前就以增量到达 Agent Host 与客户端事件流。验证：测试。
- [T17-A10] `commandExecution` item 带命令、cwd、退出码、语义状态、耗时、超时与截断标记。验证：golden 测试。
- [T17-A11] Windows 上找到 Git Bash 时 `Bash` 经它执行；找不到时模型请求的工具列表中没有 `Bash`、有 `PowerShell`，并产生安装提示事件；macOS 上工具列表中没有 `PowerShell`。验证：mock provider 请求断言（Windows 部分由 CI 证明）。
- [T17-A12] Windows 上 PowerShell 与 Git Bash 的中文输出不乱码，Git Bash 的 `cd` 路径转换后边界判断正确。验证：Windows CI 上的测试输出。
- [T17-A13] `npm run verify` 通过（含 Windows CI 上的 L2 场景）。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 创建或更新 `crates/piarc-exec` 的 CLAUDE.md：终止流程、cwd 跟踪方式、阈值常量位置、语义退出码表、环境剔除清单、Windows 差异与易错点。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：进程树终止、登录 shell 环境解析、语义退出码判定。
