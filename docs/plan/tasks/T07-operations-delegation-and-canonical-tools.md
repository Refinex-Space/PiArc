# T07 Operations 委托与规范名工具（S4）

| 项 | 内容 |
|---|---|
| 阶段 | 1 M0 技术验证 |
| 依赖 | T06 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort xhigh，新会话 |
| 规模 | 大 |
| 关联验证项 | S4（Operations 委托与规范名工具） |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T07`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

ADR-0004 决定工具 I/O 下沉 Core：Harness Kit 用 Pi 的 `create*Tool(..., { operations })` 重建内置工具，把文件读写与命令执行经 AHP 委托给 Core。只有这样，Core 才能在后续任务中统一做写前快照、沙箱、审计与权限检查。工具对模型暴露 Claude Code 的规范名（第 6.1.1 节），用户现有的权限规则与 hooks 配置才能直接生效。

S4 要回答两个问题：Pi 的内置工具能否经 Operations 把 I/O 全部交给 Core；能否改为规范名、换上 PiArc 自写的描述，而行为与 Pi 原生一致。通过标准（架构第 16 章）：Read/Edit/Write/Bash 全部经 Core，行为与 Pi 原生一致。本任务把 Glob、Grep 也纳入。

本任务只做"最小正确"的 I/O：路径限定在工作区内，命令能流式输出。编辑不变量（T16）、Bash 完整行为（T17）、权限（T20）、快照（T28）、沙箱（T11、T39）都会叠加到这条委托路径上。

## 必读

1. 架构设计：
   - 第 6.1.1 节"规范名与 Tool Profile"、第 6.1.3 节"Operations 委托"
   - 第 6.1.2 节"工具语义不变量"（确认哪些不在本任务）
   - 第 7.1 节中 `piarc-fs`、`piarc-exec` 的职责与依赖规则
   - 第 7.4 节中 `fs/*`、`exec/*` 两行及其超时语义；第 11 章"AHP 往返"一行
2. ADR-0004、ADR-0009（第 8 条"大块数据走引用"）、ADR-0006（工具描述原创）。
3. `docs/research/pi-v1.4.0-baseline.md` 第 4.1 节"内置工具"，第 4.6 节中 `registerTool` 与 `tool_call` 部分。
4. T06 交付的 `agent-host`、`piarc-host`、`core-bridge` 及其 CLAUDE.md；T05 的 mock provider。
5. 实现时查阅（Pi 锁定版本的源码与类型声明）：`create*Tool` 系列工厂（Read、Write、Edit、Bash，以及 grep、find、ls 对应的工厂，以实际导出为准）与对应 `*Operations` 接口的签名和调用时机；在会话中停用内置工具、注册自定义工具的方式；`ignore` 与 `grep-searcher` crate 的 API。

## 范围

### 要做

- Harness Kit 工具层：六个规范名工具、默认 Tool Profile、名称映射表。
- AHP `fs/*` 七个方法与 `exec/run`（含流式输出通知）的协议类型与样本。
- Core：`piarc-fs`、`piarc-exec` 的最小正确实现，由 `piarc-core` 分派。
- Pi 原生工具与委托工具的行为对照测试；S4 报告。

### 不做

- 先读后改、唯一匹配、保真写入、截断落盘等不变量（T16）。工具参数沿用 Pi 的参数 schema，参数风格的调整随 T16 处理。
- Bash 的进程树终止、超时、`cd` 保留、输出截断与语义退出码（T17）；PowerShell 工具（T17）。
- 权限闸门与审批（T20）、写前快照（T28）、沙箱（T11、T39）、按模型家族定制的 Tool Profile。

## 交付物

### 1. 工具层（`agent-host/src/tools/`）

| 规范名 | Pi 工厂 | 委托的 AHP 方法 |
|---|---|---|
| Read | read | `fs/read`、`fs/stat` |
| Write | write | `fs/write`、`fs/mkdir` |
| Edit | edit | `fs/read`、`fs/write` |
| Bash | bash | `exec/run` |
| Glob | find | `fs/glob` |
| Grep | grep | `fs/grep` |

- 用 Pi 的工厂函数加 Operations 创建工具，包装为规范名，换上 PiArc 自写的描述（默认 Tool Profile）。会话中停用 Pi 原生工具，模型只看到规范名工具。
- 名称映射表：模型可见名 ↔ 规范名，双向查询；`tool_call` 等事件中的工具名经映射得到规范名。默认 Profile 两者相同，用一个测试 Profile 验证改名生效。
- 工具描述原创，不参照 Claude Code 的工具描述原文（ADR-0006），提交前自查。
- Pi 的 ls 没有规范名（第 6.1.1 节），默认 Profile 不暴露；`fs/list` 仍按第 6.1.3 节实现，供 `LsOperations` 与后续使用。
- 某个 Pi 工厂的 I/O 无法完全经 Operations 委托时（例如锁定版本的 grep 或 find 在 Operations 之外直接调用外部程序），改为 PiArc 注册的同名工具直接调用 `fs/grep`、`fs/glob`，在 S4 报告中记录原因。
- `agent-host/src/tools/` 与 `agent-host/src/harness/` 用 ESLint `no-restricted-imports` 禁止引入 `fs`、`node:fs`、`child_process`、`node:child_process` 及其 promises 变体。

### 2. AHP 方法

- 在 `piarc-protocol` 中定义 `fs/read`、`fs/stat`、`fs/write`、`fs/mkdir`、`fs/grep`、`fs/glob`、`fs/list`、`exec/run` 的参数与结果，以及 `exec/run` 的输出通知（请求 id、stdout/stderr、序号）与取消方式；走 T02 的生成流程并补齐 golden 样本。
- 每个请求带 `sessionId`，Core 按会话的工作区根与 cwd 解析路径。
- 内容传输：帧上限（T02，默认 8 MiB）内的文本内联返回，超过上限的读取由调用方按范围分段请求；图片等二进制内容的传输方式在 ADR-0009 第 8 条的框架内决定，写进 S4 报告。

### 3. Core 实现

- `piarc-fs`：读（支持偏移与长度）、stat、写、mkdir、glob 与 grep（基于 `ignore` 与 `grep-searcher`，遵守 `.gitignore`）、list。
- 路径限定：规范化并解析符号链接后，必须位于该会话的工作区根之内，越界返回结构化错误（T16 会把越界改为"需要询问"）。
- `piarc-exec`：在会话 cwd 中经用户 shell 执行命令，stdout 与 stderr 经通知流式回传，结束时返回退出码；支持取消（终止直接子进程）；环境变量不含凭据。Windows 上用 Git Bash（GitHub Windows runner 自带），探测与缺失提示由 T17 实现。
- `piarc-core` 把 Agent Host 发来的 `fs/*`、`exec/*` 分派给对应 crate，功能 crate 之间不互相依赖（第 7.1 节）。

### 4. 行为对照

- 同一组场景（mock provider 脚本驱动）分别用 Pi 原生工具与委托工具运行，比较给模型的工具结果（mock 请求记录）与文件副作用（运行后的工作区快照）。
- 场景至少覆盖：Read 全文与 offset/limit 分页、Read 不存在的文件、Write 新文件与覆盖、Edit 唯一替换与找不到旧文本、Bash 成功与失败的退出码和输出、Grep 有匹配与无匹配、Glob 匹配与 `.gitignore` 过滤。
- 结果一致的直接通过；有差异的逐条列出原因与处理（修正委托实现，或记录为有意差异并说明理由）。

### 5. S4 报告

`docs/spikes/S04-operations-delegation.md`：Pi 各工厂的 Operations 覆盖情况、改名方式与限制、行为对照表、AHP 往返耗时、结论。macOS 已验证：全部对照场景与计时；Windows：以 CI 运行结果为准（路径、换行与 Git Bash 下的 exec），未取得时在报告中注明，由 W0 核对。更新 `docs/spikes/README.md`。

## 实现要点

- 写每处 Pi 调用前，先在锁定版本的类型声明中确认 Operations 的签名与调用时机。Pi 的工具可能在 Operations 之外访问文件系统（例如图片缩放、输出截断写临时文件），逐个排查并记录。
- Pi 原生 bash 会注入 `PI_PROVIDER` 等环境变量，Read 会截断到 2000 行或 50KB（基线第 4.1 节）。委托后这些行为与 Pi 原生保持一致，差异进对照表。
- 零直接调用分两层证明：ESLint 规则管住 PiArc 自己的代码；运行时 spy 管住 Pi 内部，场景运行期间记录 Agent Host 进程内对工作区路径的 fs 调用与 `child_process` 调用。Pi 写会话 JSONL 的目录不在工作区内，不计入。
- 路径比较走规范化（大小写、分隔符、`\\?\` 前缀，第 15.3 节），测试夹具包含含空格与中文的路径。

## 验收标准

- [T07-A01] 六个工具的每次调用都在 Core 收到对应的 AHP 请求（Read→`fs/read`、Write→`fs/write`、Edit→`fs/read` 与 `fs/write`、Bash→`exec/run`、Glob→`fs/glob`、Grep→`fs/grep`）。验证：场景测试中对 Core 侧调用记录的断言。
- [T07-A02] 场景运行期间，Agent Host 进程内对工作区路径的 fs 调用为 0，`child_process` 调用为 0。验证：运行时 spy 测试输出。
- [T07-A03] 在 `agent-host/src/tools/` 或 `agent-host/src/harness/` 中引入 `fs` 或 `child_process` 被 ESLint 拦截。验证：临时违规时 `npm run lint` 失败的输出，撤销后通过。
- [T07-A04] 模型收到的工具列表恰好是 Read、Write、Edit、Bash、Glob、Grep 六个规范名，描述为默认 Profile 的文本，不含 Pi 原生工具名。验证：mock provider 请求断言。
- [T07-A05] 名称映射表双向正确；用测试 Profile 改名后模型看到新名称，事件与 Core 侧仍得到规范名。验证：单元测试与场景测试。
- [T07-A06] 行为对照场景全部运行，结果一致，或差异已逐条列出原因与处理。验证：对照测试输出与 S4 报告中的对照表。
- [T07-A07] 绝对路径越界、`..` 越界、指向工作区外的符号链接三种情况，`fs/*` 都返回结构化错误且不触碰目标文件。验证：测试。
- [T07-A08] `exec/run` 在命令结束前就经通知送出输出，结束时返回退出码；取消后子进程被终止。验证：测试。
- [T07-A09] 新增的 `fs/*`、`exec/*` 消息都有 schema 与 golden 样本，样本完整性检查通过。验证：verify 中对应步骤的输出。
- [T07-A10] 小文件 `fs/read` 的 AHP 往返 p95 ≤ 5 ms（≥ 1,000 次）。验证：契约测试中的计时输出。
- [T07-A11] T06 的 S3 双会话场景改用委托工具后仍然通过，两个会话的路径各自解析到自己的工作区。验证：场景测试。
- [T07-A12] S4 报告已写入，`docs/spikes/README.md` 已更新。验证：文件内容。
- [T07-A13] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新 `agent-host/CLAUDE.md`：工具层位置、名称映射表、禁用 fs 与 child_process 的规则。
- 创建或更新 `crates/piarc-fs` 与 `crates/piarc-exec` 的 CLAUDE.md：路径限定规则、`exec/run` 通知格式、T16 与 T17 将要叠加的内容。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：路径限定检查、工具名映射、行为对照测试辅助。
