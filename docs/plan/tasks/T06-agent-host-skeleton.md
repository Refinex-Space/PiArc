# T06 Agent Host 骨架：Pi SDK 多会话与 AHP（S3、S9）

| 项 | 内容 |
|---|---|
| 阶段 | 1 M0 技术验证 |
| 依赖 | T04、T05 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort xhigh，新会话 |
| 规模 | 大 |
| 关联验证项 | S3（同进程多会话）、S9（AHP 握手、背压、崩溃重启与对账） |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T06`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

Agent Host 是 PiArc 与 Pi 之间的边界：一个 Node 进程，用 Pi SDK 托管一个工作区内的多个会话，通过 AHP 与 Core 通信。架构中两项依赖运行时行为的假设，要在本任务中用代码证明：

- **S3**：同一进程中，多个不同 cwd 的会话并发运行，互不串扰（ADR-0010 的前提）。
- **S9**：AHP 的握手、背压、崩溃重启与调用对账，在故障注入下行为正确（ADR-0009 的前提）。

本任务的代码是正式实现的起点：T07 在其上做 Operations 委托，T14 补全事件投影。任何一项不通过，按 ADR-0010 或 ADR-0009 的触发条件处理，例如退回每会话一个进程。

## 必读

1. 架构设计：
   - 第 3.2 节"一次用户输入的完整流程"、第 3.3 节"进程模型"
   - 第 5.1–5.5 节、第 5.7 节
   - 第 7.4 节"AHP"、第 7.5 节"Agent Host 监管"
2. ADR-0002、ADR-0009、ADR-0010、ADR-0015。
3. `docs/research/pi-v1.4.0-baseline.md` 全文。
4. 本任务之前已有的 `piarc-protocol`（T02）、`piarc-core` 与 `piarc-napi`（T04）、`piarc-testkit` 的 mock provider（T05）代码与 CLAUDE.md。
5. 实现时查阅（Pi 锁定版本的源码，按需定位，不通读）：
   - `createAgentSession`、`AgentSessionRuntime`、`SessionManager`、`DefaultResourceLoader`（`extensionFactories`、`agentDir`）；
   - `ModelRuntime.create`；
   - 事件类型 `AgentSessionEvent`，尤其是 `agent_start`、`message_update`、`agent_settled`、`compaction_*`；
   - 关闭版本检查与上下文文件加载的选项；
   - pi-mcp 的扩展注册方式。

## 范围

### 要做

- 锁定 Pi 版本，并更新基线文档。
- `agent-host` 包：stdio 接管、握手、会话注册表、最小事件投影、Core 桥接、esbuild 打包。
- Core 侧 `piarc-host`：启动、握手、心跳、背压、重启、调用对账、日志。
- S3、S9 的场景测试与故障注入测试，以及两份验证报告。

### 不做

- 工具 Operations 委托（T07）。本任务中工具可以用 Pi 原生实现，只要会话之间互不串扰。
- 完整的事件投影与会话编排（T14）、凭据（T08）、打包后的内置 Node（T12）。
- 权限闸门、hooks 等 Harness Kit 能力（M1 之后）。

## 交付物

### 1. 锁定 Pi 版本

- 查 npm 上 `@earendil-works/pi-coding-agent` 及其依赖包的最新稳定版。
- 若最新版不是 v1.4.0：
  - 读这些包 CHANGELOG 中 v1.4.0 之后的 Breaking Changes；
  - 把影响 PiArc 的差异写进基线文档（新建 `docs/research/pi-v<版本>-baseline.md`，或在原文档末尾追加"版本差异"一节，二选一并说明理由）；
  - 用 `git -C reference/pi fetch --tags` 后检出同一 tag，更新 `docs/research/REFERENCES.md` 的固定版本。
- 在 `agent-host/package.json` 中精确锁定版本，`@earendil-works/*` 全部同一版本。T05 为 mock provider 测试临时锁定过 pi-ai 的版本，这里统一到同一版本，并处理 PLAN"登记事项"中 T05 留下的提醒。
- ESLint 规则：禁止从 `@earendil-works/*` 的内部路径深度 import，只允许包入口（架构第 5.7 节）。

### 2. `agent-host` 包

```
agent-host/src/
├── main.ts              # 接管 stdio、握手、信号处理（SIGTERM 有序退出）
├── protocol/            # 复用 packages/protocol 的生成类型与 T02 的帧编解码器
├── runtime/
│   ├── session-registry.ts   # sessionId → AgentSession；create / close
│   ├── projector.ts          # 最小投影（见下）
│   └── core-bridge.ts        # 向 Core 发请求：统一超时，失败即拒绝
└── index.ts
```

- **握手**：启动后发送 `host/hello`（协议版本、Pi 版本、能力列表），等待 `core/welcome`。主版本不匹配时退出并给出错误。
- **会话注册表**：用 `createAgentSession` 在同一进程托管多个会话：
  - 每个会话有自己的 cwd 与基于文件的 `SessionManager`，会话目录在 PiArc 数据目录下；
  - `agentDir` 指向 PiArc 数据目录下的 `pi/`（架构第 5.5 节）；
  - 关闭 Pi 的版本检查与自更新，关闭 Pi 自带的上下文文件加载；
  - 模型请求指向 T05 的 mock provider。
- **最小投影**：
  - 一次 prompt 的首个 `agent_start` → `turn/started`；
  - 文本增量 → `item/agentMessage/delta`，`itemId` 为 `messageId#contentIndex`；
  - 工具开始与结束 → `item/started`、`item/completed`；
  - `agent_settled` → `turn/completed`；
  - 每条通知带 `{sessionId, seq, ts}`，`seq` 按会话单调递增。
- **Core 桥接**：向 Core 发出的请求统一走一个函数，带超时（可配置，默认 30 秒；`policy/evaluate` 这类等待用户的请求不设固定超时，但会话中断时取消）；超时、连接断开、解析失败一律按拒绝或错误返回，不静默继续。
- **打包**：esbuild 打成单个 ESM bundle（目标 `node22.19`），外部依赖只保留 Pi 要求的原生或 wasm 资源，列清单写进 `agent-host/CLAUDE.md`。

### 3. Core 侧 `piarc-host`

- **启动**：用配置给出的 node 可执行文件与 bundle 路径启动 Agent Host。开发期用 `.nvmrc` 对应的 node，打包后的内置 node 由 T12 接入，本任务只保证路径可配置。工作目录为工作区根，环境变量最小化（只传必要项，不传凭据）。
- **握手**：等待 `host/hello`，超时 10 秒；校验协议版本后回复 `core/welcome`，`connectionEpoch` 每次重连递增。
- **I/O**：stdout 持续读取并解帧；写入走有界队列，队列满时对上游施加背压（新请求返回可重试错误或等待，二选一并在报告中说明），不无限增长内存。
- **心跳**：`host/ping` 每 30 秒一次，连续失败视为挂死，杀进程并按重启策略处理。
- **重启**：异常退出后指数退避重启，10 分钟内最多 5 次，超过后停止并上报；重启后恢复之前打开的会话。
- **调用对账**：每个 Core 发出的请求有状态：已发送、已确认、终态。进程退出时，未到终态的请求标记为 `uncertain` 并上报，不自动重放。
- **日志**：Agent Host 的 stderr 逐行进入 tracing，打上工作区与会话标签。

### 4. S3：同进程多会话（场景测试）

在同一个 Agent Host 中开两个会话，cwd 分别指向两个临时工作区，用 mock provider 的脚本让它们同时：

- 运行读写文件的工具调用，结果只出现在各自的 cwd；
- 其中一个会话被中断，另一个会话继续完成；
- 其中一个会话触发压缩（调小上下文窗口），另一个会话的历史不受影响；
- MCP：用一个最小的 stdio MCP server（测试夹具）给其中一个会话。如果 Pi 内置的 MCP 扩展无法按会话隔离，记录现象与原因，登记为 T36 的前置问题，不在本任务中替换 MCP 扩展。

报告 `docs/spikes/S03-multi-session.md`：做了什么、观察到的现象、结论（通过 / 有条件通过 / 不通过），以及单会话与双会话的 RSS 数据。

### 5. S9：AHP 故障注入

逐项注入并断言行为：

| 注入 | 期望 |
|---|---|
| 进行中的 prompt 期间杀掉 Agent Host | Core 检测到退出，按退避重启，会话恢复；进行中的请求标为 `uncertain` |
| Agent Host 输出半帧后挂起 | 超时后按挂死处理，Core 不崩溃 |
| 输出非法 JSON 或超长帧 | 记录错误，丢弃该帧或断开重连（按 ADR-0009 的规定），Core 不崩溃 |
| Core 侧 stdout 读取变慢 | 背压生效，Agent Host 不无限缓冲，内存有界 |
| 主版本不匹配的 `host/hello` | 握手被拒绝，错误可读 |
| 10 分钟内连续崩溃 6 次 | 第 6 次后停止重启并上报 |

报告 `docs/spikes/S09-ahp-resilience.md`。

## 实现要点

- 写每一处 Pi 调用前，先在锁定版本的源码或类型声明中确认签名与行为，不按名字猜测。基线文档中的文件:行号针对 v1.4.0。
- 多会话串扰最容易出现在进程级的全局状态上：`process.cwd()`、环境变量、模块级单例（例如资源加载器、MCP 客户端）。逐一排查并写进 `agent-host/CLAUDE.md` 的易错点。
- 测试用 Core 的无头入口驱动，不依赖 Electron。若需要一个临时的测试驱动程序，放在 `piarc-testkit` 或测试目录中；正式的 `piarc-devcli` 由 T15 建立。
- 故障注入测试必须是确定性的：用可控的测试替身（例如一个可以按指令发半帧、发非法 JSON 的假 Agent Host 脚本），不靠 sleep 碰运气。

## 验收标准

- [T06-A01] Pi 版本已精确锁定，`@earendil-works/*` 全部同一版本；与 v1.4.0 的差异已写入基线文档；`reference/pi` 已检出同一 tag，且 `REFERENCES.md` 已更新。验证：`package.json`、文档改动与 `git -C reference/pi describe --tags` 输出。
- [T06-A02] 深度 import Pi 内部路径被 ESLint 拦截。验证：临时违规时 `npm run lint` 失败的输出，撤销后通过。
- [T06-A03] 握手成功时双方交换协议版本与能力；主版本不匹配时握手被拒绝且错误可读。验证：两个测试的输出。
- [T06-A04] 同进程两个不同 cwd 的会话并发运行工具调用，文件副作用与工具结果只出现在各自的工作区。验证：场景测试。
- [T06-A05] 一个会话被中断、另一个会话正常完成；一个会话压缩后，另一个会话的历史不变。验证：场景测试。
- [T06-A06] 进行中的 prompt 期间杀掉 Agent Host：Core 自动重启并恢复会话，进行中的请求被标为 `uncertain`。验证：故障注入测试。
- [T06-A07] 半帧挂起、非法 JSON、超长帧都不会让 Core 崩溃，行为符合 ADR-0009。验证：故障注入测试。
- [T06-A08] Core 读取变慢时背压生效，Agent Host 与 Core 的内存有界。验证：测试中记录的内存峰值与队列长度。
- [T06-A09] 10 分钟内连续崩溃超过 5 次后停止重启并上报。验证：故障注入测试（时钟可注入，不真实等待 10 分钟）。
- [T06-A10] 每条会话通知带 `{sessionId, seq, ts}`，同一会话的 `seq` 连续递增。验证：测试断言。
- [T06-A11] S3、S9 两份报告已写入 `docs/spikes/`，`docs/spikes/README.md` 已更新状态。验证：文件内容。
- [T06-A12] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 创建 `agent-host/CLAUDE.md`：入口、会话注册表的位置、投影入口、打包外部依赖清单、多会话的易错点。
- 创建或更新 `crates/piarc-host` 的 CLAUDE.md：重启策略、背压方式、对账状态。
- S3 若出现 MCP 串扰，在 `PLAN.md`"登记事项"中登记，建议由 T36 处理。
