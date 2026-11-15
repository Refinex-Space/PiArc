# T11 沙箱验证：Seatbelt、网络代理与 Job Object（S8）

| 项 | 内容 |
|---|---|
| 阶段 | 1 M0 技术验证 |
| 依赖 | T07 |
| 执行平台 | macOS（CI 同时覆盖 Windows；Windows 实机结论在 W0） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 中 |
| 关联验证项 | S8（macOS：Seatbelt 与网络代理；Windows：Job Object） |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T11`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

macOS 上，Bash 命令在 Seatbelt 中执行，文件写入与网络都受白名单约束（第 6.10 节）。Windows 第一版不提供 OS 级沙箱，只用 Job Object 保证超时与停止时整棵进程树被终止（需求 D7）。沙箱的正式接入在 M4 的 T39；M0 先证明机制可行：

- 能否按命令生成 Seatbelt 配置，把写入限制在工作区等目录，并禁写受保护路径；
- 本地代理能否按域名白名单放行，且命令无法绕过代理直连；
- git、npm install、cargo build、python 这些常见命令在沙箱内能否正常运行；
- Job Object 能否终止整棵进程树。

S8 的通过标准（架构第 16 章）：写入与网络限制生效，常见构建命令可运行；超时与停止时无残留进程。Seatbelt 接口被 Apple 标为废弃（风险 R10），沙箱层放在 trait 后面。

## 必读

1. 架构设计：
   - 第 6.10 节"沙箱"
   - 第 10.3 节"进程加固"中 Agent Host 一段
   - 第 6.1.2 节中"路径边界"一行（受保护路径）
   - 第 7.1 节中 `piarc-sandbox`、`piarc-exec` 的职责与依赖规则，以及 `ProcessSpawner` 窄 trait
   - 第 15.2 节中沙箱与进程树两行
2. ADR-0004（第 4 条双重防线）、ADR-0015。
3. `docs/research/native-stack.md` 第 8.1–8.3 节。
4. `docs/research/claude-official-capabilities.md` A7.2 节"Sandboxing"。
5. T07 交付的 `exec/run`、`piarc-exec` 与 `piarc-core` 及其 CLAUDE.md。
6. 实现时查阅：`sandbox-exec` 与 SBPL 配置语法。Codex 的 seatbelt 实现与 `@anthropic-ai/sandbox-runtime` 都是 Apache-2.0，可以研读其配置模型；复用配置片段时保留许可证声明并注明出处。Windows Job Object 的 API（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`、进程在开始运行前加入 Job 的方式）；选定的 HTTP 代理库的文档。

## 范围

### 要做

- `piarc-sandbox`：按命令生成 Seatbelt 配置；本地 HTTP/HTTPS（`CONNECT`）代理与域名白名单。
- 沙箱内命令经 Core 的 exec 路径执行。
- 常见命令可运行性测试。
- Windows：Job Object 终止进程树的实现与 CI 单测。
- S8 报告（macOS 部分）。

### 不做

- 沙箱接入 Bash 工具的两种模式、沙箱外重试的审批、网络白名单设置与沙箱设置页（T39）。
- Agent Host 自身的 Seatbelt 配置（T12 用宽松配置启动，T39 定稿）。
- Bash 的超时、`cd` 保留与进程组管理的通用实现（T17）；Windows 隔离方案评估（T39）。

## 交付物

### 1. Seatbelt 配置生成

- 输入：工作区根、会话临时目录、附加目录、受保护路径、`denyRead` 列表、代理端口；输出：SBPL 配置文本与 `sandbox-exec -D` 参数。路径先规范化并解析符号链接，写入配置时正确转义。
- 默认策略：读取放开（`denyRead` 除外）；写入只允许工作区、会话临时目录、附加目录；受保护路径禁写；网络只允许连接本机代理端口。
- 沙箱受保护路径清单在 crate 文档中明确列出。第 6.1.2 节的清单面向文件工具，整个 `.git/` 禁写会让 `git commit` 失败；本任务确定沙箱用的清单（例如 `.git/hooks`、`.git/config`、`.piarc/`、`.claude/`、shell 配置文件），写进报告并同步架构第 6.10 节。
- 包管理器写用户目录下的缓存（npm 缓存、`CARGO_HOME`）：用环境变量把缓存指向会话临时目录，或把特定缓存目录加入可写清单，二选一并写明理由。
- 固定使用 `/usr/bin/sandbox-exec`，不从 PATH 查找。

### 2. 网络代理

- Core 内置的本地 HTTP 代理，支持普通 HTTP 请求与 HTTPS `CONNECT`，只监听回环地址，端口随机，随会话关闭。
- 白名单支持精确域名与 `*.` 通配；默认拒绝，被拒绝的请求返回明确状态与原因；目标解析到回环或云元数据地址时同样拒绝。
- 沙箱内命令的 `HTTP_PROXY`、`HTTPS_PROXY`（含小写形式）指向代理；不走代理的连接被 Seatbelt 拦截。
- 代理测试用可注入的解析器与本地上游服务器，不依赖外网；只有常见命令测试需要访问真实 registry。

### 3. 经 Core 执行

- `piarc-core` 编排：向 `piarc-sandbox` 取得包装后的命令（`sandbox-exec` 参数与环境变量），交给 `piarc-exec` 执行；功能 crate 之间不互相依赖（第 7.1 节）。
- 流式输出、退出码、取消语义与 T07 的 `exec/run` 一致；停止沙箱内命令后不留残留进程（通用的进程组实现以 T17 为准，本任务保证沙箱路径不留残留）。

### 4. Windows Job Object

- T12 可能先于本任务实现 Job Object（用于启动 Agent Host）：已有实现时复用并补齐下列要求，不另写一套。
- 创建 Job 并设置 `KILL_ON_JOB_CLOSE`；进程在开始运行前加入 Job，不留逃逸窗口；不允许 breakaway。
- 放置位置（架构第 7.1 节）：Job Object 实现在 `piarc-exec`，作为 `ProcessSpawner`（定义在 `piarc-ports`）的 Windows 实现；`piarc-core` 把它注入 `piarc-host`（T12 启动 Agent Host）与沙箱路径。`piarc-sandbox` 不实现进程管理。
- Windows CI 单测：父进程 → 子进程 → 孙进程，关闭 Job 后三者全部退出。

### 5. 测量与报告

- 测量 `sandbox-exec` 带来的每条命令额外耗时（p50/p95）与代理的额外延迟。
- `docs/spikes/S08-sandbox.md`：配置模型、受保护路径清单、缓存目录方案、代理行为、常见命令结果、测量数据、结论。macOS 已验证：Seatbelt 与代理全部项；Windows CI：Job Object 单测；待 W0：Job Object 实机终止进程树，包括 Agent Host 场景。更新 `docs/spikes/README.md`。

## 实现要点

- 沙箱层放在 trait 后面，macOS 实现用 `cfg(target_os = "macos")`，业务代码不出现平台分支。
- 生成的 SBPL 要有快照测试，配置变化在评审中可见；含空格与中文的路径必须有用例（第 15.3 节）。
- Seatbelt 的拒绝在命令侧表现为普通的权限错误：测试断言具体的失败原因（例如 `Operation not permitted`），不只断言退出码非 0。
- 常见命令测试需要网络时，在测试说明中写清楚；CI 无网络时显式报告原因，不静默通过（第 12.6 节）。

## 验收标准

- [T11-A01] 沙箱内命令写入工作区、会话临时目录、附加目录成功；写入这些目录以外的位置（用户主目录、系统临时目录中的其他路径）被拒绝。验证：测试。
- [T11-A02] 工作区内受保护路径清单中的每一项写入都被拒绝。验证：测试。
- [T11-A03] `denyRead` 中的路径不可读，其余路径可读。验证：测试。
- [T11-A04] 经代理访问白名单内域名成功，白名单外域名被拒绝并返回明确原因；精确与通配匹配、HTTP 与 `CONNECT` 都有用例。验证：代理测试（可注入解析器与本地上游）。
- [T11-A05] 沙箱内绕过代理直连（不设代理环境变量、直接连 IP）失败。验证：测试。
- [T11-A06] 解析到回环或云元数据地址的目标被代理拒绝。验证：测试。
- [T11-A07] git（status、add、commit）、npm install（白名单含 registry）、cargo build、python 脚本在沙箱内成功。验证：集成测试输出。
- [T11-A08] 沙箱内命令经 Core 的 exec 路径执行，流式输出、退出码与取消语义与 `exec/run` 一致；停止后没有残留进程。验证：测试（检查进程列表）。
- [T11-A09] 含空格与中文的工作区路径下，配置生成与写入限制正确。验证：测试。
- [T11-A10] Job Object 关闭后，父、子、孙三级进程全部退出。验证：Windows CI 测试输出；未取得时标 `blocked`，由 W0 核对。
- [T11-A11] `sandbox-exec` 的每条命令额外耗时与代理额外延迟已测量。验证：报告中的数据。
- [T11-A12] S8 报告（macOS 部分）含受保护路径清单、缓存目录方案、结论与待 W0 的项；架构第 6.10 节已同步沙箱受保护路径清单；`docs/spikes/README.md` 已更新。验证：文件内容。
- [T11-A13] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 创建 `crates/piarc-sandbox/CLAUDE.md`：配置模型、受保护路径清单、代理行为、Job Object 的位置与注入方式。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：Seatbelt 配置生成、本地代理、Job Object（或 `ProcessSpawner` 实现）。
- Job Object 的放置若影响 T12、T17，在 `PLAN.md`"登记事项"中写明它们应复用的接口。
