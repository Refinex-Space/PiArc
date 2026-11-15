# S3 Agent Host 同进程多会话

- 任务：T06（2026-11-15）
- 范围：同一个 Agent Host 进程用 Pi SDK 托管多个不同 cwd 的会话时，工具副作用、中断、压缩与 MCP 是否互不串扰（ADR-0010 的前提）。
- 结论：macOS **通过**。工具、中断、压缩与 MCP 四项都按会话隔离，ADR-0010"每工作区一个 Agent Host"的前提成立，不触发"退回每会话一个进程"。两个附带发现不影响隔离结论：中断后的下一次请求出现相邻的 user 消息（I18），MCP server 按会话各起一份、尚未共享（T36）。Windows 由 CI 运行同一组测试，结果待推送后核对。

## 1. 验证环境

| 项 | 版本 |
|---|---|
| 系统 | macOS 26.5.2（25F84），arm64 |
| Node | 本机 24.14.1；CI 用 `.nvmrc` 的 24.22.2 |
| Pi | `@earendil-works/*` 1.5.2（`agent-host/package.json` 精确锁定） |
| Agent Host | `npm run build:agent-host` 的单文件 ESM bundle（esbuild 0.28.2，目标 node22.19，约 15 MB） |
| Core | `piarc-core::agent_host::start`（`piarc-host` 监管器 + `piarc-exec` 的 tokio 进程启动器），Rust 1.99.1 |
| 模型侧 | `piarc-testkit` 严格 mock provider（库形态），Anthropic Messages 线格式 |

## 2. 做了什么

测试在 `crates/piarc-testkit/tests/agent_host/`，经 Core 的无头入口启动真实的 Agent Host bundle，不依赖 Electron：

- 每个测试在系统临时目录下建一个根目录（路径含空格与中文）：数据目录 `data/`（Pi 的 agentDir 是 `data/pi/`），两个工作区 `ws a 甲`、`ws b 乙`。
- `data/pi/models.json` 定义自建 provider `piarc-mock`，指向 mock 的地址，两个模型：`mock-large`（200k 窗口）与 `mock-small`（32k 窗口）。凭据只在内存中（`InMemoryCredentialStore`），`pi/` 下不出现 `auth.json`。
- 会话经 AHP `session/create` 创建，cwd 分别指向两个工作区；Agent Host 创建会话前经 `trust/get` 询问 Core 项目是否受信任。
- 场景脚本经提示词中的 `[[piarc-scenario:<id>]]` 选择；32k 模型的请求经请求头选择（压缩会替换首条 user 消息，标记随之消失）。

| 测试 | 做法 |
|---|---|
| `two_sessions_run_tool_calls_concurrently_and_only_touch_their_own_workspace` | 两个会话同时收到提示词，各自按脚本执行 `write` → `edit` → `read`，路径都是相对路径 `notes/note.txt` |
| `interrupting_one_session_leaves_the_other_running_to_completion` | A 的模型流在第一个文本增量后挂起（mock 新增的 `stall_after_events`），B 开始回合后中断 A |
| `compacting_one_session_leaves_the_history_of_the_other_untouched` | A 用 32k 模型，第一轮回答报告 20,500 token 用量，越过阈值（32,000 − 16,384）触发自动压缩；B 用 200k 模型连续问两轮 |
| `each_session_gets_only_the_mcp_servers_of_its_own_project` | 两个工作区都受信任，各有 `.pi/mcp.json`：A 配 `alpha`，B 配 `beta`，都是测试夹具 `packages/testkit/src/mcp-echo-server.ts`（stdio，`exposure: direct`） |

## 3. 观察到的现象

### 3.1 工具调用与工作目录

- 两个回合交错执行：`A:turn/started B:turn/started A:item/completed B:item/completed …`，测试断言 B 的回合在 A 结束前开始、A 的回合在 B 结束前开始。
- `ws a 甲/notes/note.txt` 内容为 `written by session A, edited`，`ws b 乙/notes/note.txt` 为 `written by session B, edited`；A 的 `read` 结果只含 A 的文本，B 同理。Pi 的工具按会话 cwd 解析相对路径，Agent Host 里没有任何 `process.chdir`。
- 两个会话的通知各自带 `{sessionId, seq, ts}`，`seq` 从 1 连续到 18，无缺口、无重复（A10）。
- `trust/get` 按顺序问到了两个工作区的 cwd。

### 3.2 中断

- 中断 A：`session/abort` 返回被中断的 `turnId`；A 的文本条目以 `interrupted` 结束，回合 `turn/completed` 为 `interrupted`；B 的回合以 `completed` 结束，文件照常写入。回合顺序：`A:turn/started B:turn/started A:turn/completed:interrupted B:turn/completed:completed`。
- 被中断的会话仍可继续使用：A 的下一个提示词正常完成。
- 发现：Pi 1.5.2 在下一次请求中丢弃被中断的 assistant 消息，请求里出现两条相邻的 user 消息。Anthropic API 会把它们合并；严格 mock 的 `role_order` 规则拒绝这种请求，所以中断场景暂时关闭了这条规则。PiArc 要自己决定中断后的对话形态，登记为 I18（T14 处理）。

### 3.3 压缩

- A 越过阈值后自动压缩：A 的会话文件出现一条 `compaction` 条目；mock 收到的第二个请求是压缩摘要请求，内容是 A 的历史；第三个请求以 `The conversation history before this point was compacted into the following summary` 开头，原来的第一个问题只存在于摘要中。`keepRecentTokens` 设为 1 时，Pi 做的是"拆分回合"压缩：最近的回答保留在摘要之后。
- B 不受影响：B 的会话文件没有 `compaction` 条目，条目为 `system, user, assistant, user, assistant`（Pi 1.5 把 system prompt 记为第一条消息）；B 的第二个请求完整包含第一轮问答，不含 A 的任何内容。
- 压缩事件（`compaction_start/end`）还没有投影到 AHP，由 T14 补上；本测试以会话文件与 mock 请求记录为证据。

### 3.4 MCP

- A 调用 `mcp__alpha__echo`，结果为 `alpha echoes "hi from A" from <ws a 甲> (pid …)`；B 调用 `mcp__beta__echo`，结果来自 `<ws b 乙>` 与另一个 pid。
- 发给模型的工具列表各自只含本会话的 MCP 工具：A 的请求里有 `mcp__alpha__echo`、没有 `mcp__beta__echo`，B 相反。
- 结论：Pi 内置 MCP 扩展**能**按会话隔离。每个会话的资源加载器各有一个 `createMcpExtension()` 实例，扩展模块没有可变的模块级状态；MCP server 以会话 cwd 为工作目录启动。关闭会话时 `AgentSessionRuntime.dispose()` 发出 `session_shutdown`，MCP 扩展在该事件上断开连接（`coding-agent/src/extensions/mcp/index.ts:1253`，读源码确认，本任务没有单独测试 server 进程的退出）。
- 代价：同一 server 被多个会话配置时会各起一份进程，不共享。工作区级共享连接池是 T36 的范围（ADR-0010 第 3 条），不在本任务替换。
- 注意：MCP 扩展默认从进程级的 `getAgentDir()` 读 `mcp.json`、写 `mcp.log` 与 `mcp-auth.json`，不看 SDK 的 `agentDir`。Agent Host 启动时把 `PI_CODING_AGENT_DIR` 设为 PiArc 的 `pi/` 目录，否则会读到用户本机的 `~/.pi/agent/mcp.json`（基线文档"版本差异"一节）。

## 4. 进程级全局状态排查

| 状态 | 现象 | 处理 |
|---|---|---|
| `process.cwd()` | Agent Host 不调用 `process.chdir`；Pi 按会话 cwd 解析工具路径（3.1 实测） | 无需处理；`agent-host/CLAUDE.md` 列为不变量 |
| `process.env` | Pi 的 bash 工具把 `process.env` 传给子进程；`getAgentDir()` 读 `PI_CODING_AGENT_DIR` | 只在启动时设置一次 `PI_CODING_AGENT_DIR`，会话代码不改环境变量 |
| `getAgentDir()` 的默认路径 | MCP 扩展、`SessionManager.create` 的默认会话目录、`ModelRuntime.create` 的默认 `auth.json` 都走它 | 固定到 PiArc 目录；会话注册表启动时校验两者一致；`ModelRuntime` 显式传入内存凭据与 `models.json` |
| `ModelRuntime` | 工作区共享一个；扩展经 `registerProvider` 注册的 provider 对所有会话可见 | 有意共享（架构第 5.2 节）；Harness Kit 注册 provider 时要按工作区考虑 |
| 扩展加载缓存 | `extensions/loader.ts` 的模块级 `extensionCache` 按 cwd 失效，不同 cwd 的会话交替加载文件型扩展会互相清空缓存 | 只影响加载耗时；Harness Kit 用内联工厂，不经过它 |
| `SettingsManager` | `create()` 默认 `projectTrusted: true` | Agent Host 按 Core 的 `trust/get` 结果显式传入 |
| Anthropic message threads 的会话状态 | pi-ai 按 `sessionId` 保存，`session.dispose()` 清理 | 关闭会话走 `AgentSessionRuntime.dispose()` |

## 5. 内存

`host/ping` 返回的 Agent Host RSS（`process.memoryUsage.rss()`），5 次运行：

| 阶段 | RSS |
|---|---|
| 握手后，没有会话 | 157.2–158.4 MB |
| 一个会话（刚创建） | 164.8–167.7 MB |
| 两个会话（刚创建） | 167.5–169.4 MB |
| 两个会话各跑完一个回合（6 次模型请求、6 次工具调用） | 187.7–191.1 MB |

第一个会话约增加 7–10 MB，第二个约 1–4 MB；回合结束后的增长主要来自 V8 堆（请求体、事件对象），不随会话数线性增加。按 ADR-0010 的估算，每会话一个进程时两个会话约需 2 × 158 MB，同进程为 169 MB。

## 6. 结论与后续

- S3 在 macOS 上通过：工具副作用、中断、压缩、MCP 均按会话隔离。
- I18：中断后的对话形态（相邻 user 消息）由 T14 定义，届时恢复中断场景的 `role_order` 校验。
- MCP 共享连接池（同一 server 只起一份）由 T36 实现；替换内置 MCP 扩展时保留"按会话 cwd 与信任加载配置"的行为。
- Windows：同一组测试在 CI 的 `verify` 作业中运行（`cargo test --workspace`），结果待推送后核对。
