# T36 MCP 共享连接池

| 项 | 内容 |
|---|---|
| 阶段 | 4 M3 多会话与生态 |
| 依赖 | T35 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort xhigh，新会话 |
| 规模 | 大 |
| 关联验证项 | 无 |
| 关联需求 | FR-EX-03 |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T36`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

Claude Desktop 的内存问题有相当一部分来自 stdio MCP server 按会话重复启动（ADR-0010）。PiArc 用自己的 MCP 扩展替换 Pi 内置的 MCP 扩展（内置扩展是 replaceable），在 Agent Host 内按工作区维护共享连接池：同一 server 只启动一份，按需连接，空闲断开。

替换还解决 Pi 内置扩展与 PiArc 设计不符的两处：默认 exposure 是 codemode 且接入 MCP 就自动激活 codemode，与规范名工具和裁决流程不符；token 以明文存在 `mcp-auth.json`，与凭据保险箱不符（第 9.1 节）。

完成后，用户的 `.mcp.json` 与 `~/.claude.json` 中的 server 可以直接使用，工作区内所有会话共享连接，OAuth token 只在保险箱中。

## 必读

1. 架构设计：
   - 第 6.8 节"MCP"
   - 第 5.2 节（`workspace.ts` 中的 MCP 连接池）、第 5.4 节、第 5.6 节（PATH 前置内置 Node）
   - 第 6.1.1 节（`mcp__<server>__<tool>`）、第 6.2.2 节（`mcp__` 规则与 `requiresUserInteraction`）、第 6.6.1 节（第 6 段与会话中途的变化）
   - 第 7.4 节（`mcp/*` 请求与 `mcp/statusChanged`）、第 9.1 节、第 10.1 节、第 10.2 节
2. ADR-0005（来源顺序）、ADR-0010。
3. `docs/research/pi-v1.4.0-baseline.md` 第 4.6 节（replaceable 内置扩展）、第 7.1 节、第 7.2 节（codemode 自动激活）、第 9 节第 11 行。
4. `docs/research/claude-official-capabilities.md` 第 A8 节。
5. `docs/spikes/S03-multi-session.md` 中的 MCP 结论，以及 `PLAN.md`"登记事项"中 T06 登记的 MCP 问题（如有）。
6. T24（配置兼容层，留下了 `~/.claude.json` 的 MCP 段）、T29（OAuth 交互经 AHP 到客户端的路径）、T12（内置 npx）、T31（子 agent 的 `mcpServers` 字段）交付的代码与 CLAUDE.md。
7. 实现时查阅（Pi 锁定版本）：pi-mcp 的客户端 API、传输、OAuth 与凭据后端注入点；内置 mcp 扩展与 tool-search 扩展的注册方式；`registerMcpServer`、`mcp_servers_change`。

## 范围

### 要做

- PiArc MCP 扩展替换 Pi 内置 MCP 扩展；不启用 codemode。
- 配置来源、合并与同名取舍；stdio 与 Streamable HTTP；SSE、WebSocket 明确提示不支持。
- 工作区共享连接池：同一 server 一份，按需连接，空闲断开。
- stdio server 的 PATH 前置内置 Node；Agent Host 退出时不留孤儿进程。
- OAuth（浏览器授权，token 进保险箱）。
- 工具暴露、裁决与延迟加载（超过阈值改经 `ToolSearch`）。
- MCP 设置页；子 agent `mcpServers` 字段接线。

### 不做

- MCP prompts 作为斜杠命令、插件提供的 server（T40）。
- `mcp_tool` 类型的 hook handler（T41）。
- 企业托管的 MCP 配置（T47）；elicitation（T48）；sampling 与 resources/subscribe（pi-mcp 不支持）。

## 交付物

### 1. 替换内置扩展

- Harness Kit 注册 PiArc 的 MCP 扩展，接管 Pi 内置 MCP 扩展的能力名；确认内置 MCP 扩展与 codemode 都未加载、未激活（测试断言）。
- MCP 工具只以 direct 或 deferred 方式暴露，名称为 `mcp__<server>__<tool>`，投影为 `mcpToolCall` item。

### 2. 配置来源与合并

- 来源：`.mcp.json`（项目，需信任）、`~/.claude.json` 的 user 级与 local 级（按项目）server、PiArc 用户级设置、工作区 `.piarc/` 中的 MCP 配置（项目级，需信任）；插件与企业为预留接口。
- 同名 server 按"企业 > 本地 > 项目 > 用户 > 插件"取整条定义，不合并字段。支持 `${VAR}` 与 `${VAR:-default}` 展开。
- SSE、WebSocket 配置标为"不支持"，在设置页与 T24 的配置诊断页中显示原因。
- 项目信任：信任前不连接、不启动项目级 server；信任后 `.mcp.json` 新增的 server 需要再次确认（第 10.2 节）。

### 3. 连接池

- 位于 Agent Host 的工作区级运行时（第 5.2 节 `workspace.ts`）：每个 server 一个连接或进程，各会话共享。
- 首个需要该 server 的会话开始时连接；所有会话都不再使用超过空闲阈值（可配置，时钟可注入）后断开；之后有会话需要时自动重连，失败按退避重试并上报状态。
- 工具列表缓存在池中；`list_changed` 或连接变化时刷新，并以追加消息通知各会话，不改写已发送的 system prompt（第 6.6.1 节）；server instructions 进入 system prompt 第 6 段（长度截断）。
- 调用结果按调用方会话路由，取消只作用于对应调用；工具结果经 T16 的截断与落盘规则。

### 4. stdio 进程

- 由 Agent Host 启动，PATH 前置内置 Node 的 `bin` 目录，使 `npx` 类 server 在本机未装 Node 时也能运行；环境变量只来自 server 配置，不含 PiArc 的凭据。
- Agent Host 退出或被杀时 server 进程随之终止：macOS 用进程组，Windows 依靠 Agent Host 的 Job Object（第 5.6 节）。

### 5. OAuth

- 使用 pi-mcp 的 OAuth 流程（发现、PKCE、动态客户端注册、刷新）；授权页由客户端在系统浏览器中打开，回调沿用 T29 的回环端口或 `piarc://` 路径。
- token 经 pi-mcp 的凭据后端注入点存入 Core 的保险箱（`secrets/*`）；数据目录下不出现 `mcp-auth.json`。
- 401/403 时状态为"需要认证"，设置页提供认证按钮。

### 6. 工具暴露与裁决

- MCP 工具调用经 `policy/evaluate`：`mcp__server__tool` 与 `mcp__server__*` 规则生效；带 `requiresUserInteraction` 标记的工具在任何模式下都询问（第 6.2.2 节）。
- MCP 工具总数不超过阈值（默认 30）时直接暴露；超过时改为延迟加载，复用 Pi 的 `tool_search`，以规范名 `ToolSearch` 暴露。

### 7. AHP 与设置页

- AHP：`mcp/status`、`mcp/reconnect`、`mcp/setEnabled`，通知 `mcp/statusChanged`；启停状态按工作区持久化在 Core。
- 设置窗口"MCP"页：每个 server 的来源、传输、状态（已连接 / 连接中 / 需要认证 / 失败 / 已停用 / 不支持 / 待信任）、工具数、最近错误；重连、启用、停用、认证操作。

### 8. 子 agent 的 `mcpServers`

- 按名称引用的 server 复用连接池中的连接；内联定义作为该子 agent 运行期间的临时 server，结束后断开。项目级定义中的内联 server 在信任前不启动。去掉 T31 中该字段"暂未生效"的提示。

### 9. 测试与能力 ID

- 测试夹具：最小 stdio MCP server、Streamable HTTP server、mock OAuth 授权服务器。场景 `tests/scenarios/mcp-*.yaml`，能力 ID 如 `CAP-MCP-POOL-001`。

## 实现要点

- 共享连接意味着同一 server 面对多个 cwd 不同的会话（worktree）。MCP `roots` 按工作区根与活动 worktree 提供，不随会话切换；把这一点写进 `agent-host/CLAUDE.md` 的易错点。
- 替换前先读锁定版本中内置 MCP 扩展的源码，确认接管点与它注册的全部能力，避免两套实现同时生效。
- stdio 分帧照 MCP 规范实现，测试夹具用独立实现的 server，避免 mock 与实现犯同一个错误（claw-code 的教训）。

## 验收标准

- [T36-A01] Pi 内置 MCP 扩展与 codemode 均未加载，MCP 工具以 `mcp__<server>__<tool>` 直接或延迟暴露给模型。验证：测试与 mock provider 请求断言。
- [T36-A02] 同一工作区两个会话使用同一个 stdio server 时只有一个 server 进程，两个会话的调用结果各自正确返回。验证：测试（进程计数与 PID 断言）。
- [T36-A03] 所有会话停止使用超过空闲阈值后连接断开、stdio 进程退出，之后有会话需要时自动重连。验证：测试（时钟可注入）。
- [T36-A04] 未信任项目的 `.mcp.json` server 不连接、不启动进程；信任后才连接；`.mcp.json` 新增 server 时需要再次确认。验证：测试。
- [T36-A05] 同名 server 按"企业 > 本地 > 项目 > 用户 > 插件"取整条定义；SSE 与 WebSocket 配置被标为不支持并在界面提示。验证：单元测试与 Playwright 截图。
- [T36-A06] `npx` 启动的 stdio server 使用内置 Node，系统 PATH 中没有 node 时也能启动。验证：测试（从 PATH 中移除系统 node 后运行）。
- [T36-A07] 经 mock 授权服务器完成浏览器授权、token 刷新与重新认证；token 只存在保险箱中，数据目录下没有 `mcp-auth.json` 或明文 token。验证：端到端测试与磁盘扫描。
- [T36-A08] MCP 工具总数超过阈值（默认 30）时改为延迟加载，模型经 `ToolSearch` 检索到目标工具并成功调用。验证：L2 场景（mock 请求断言工具列表与调用顺序）。
- [T36-A09] `mcp__server__tool` 与 `mcp__server__*` 规则生效，带 `requiresUserInteraction` 标记的工具在任何模式下都询问。验证：L2 场景。
- [T36-A10] 工具集因 `list_changed` 或连接变化而改变时，变化以追加消息送达，已发送的 system prompt 字节不变。验证：mock provider 请求断言。
- [T36-A11] Agent Host 正常退出或被杀后没有遗留的 MCP server 进程。验证：macOS 与 Windows CI 上的测试。
- [T36-A12] MCP 设置页显示每个 server 的来源、传输、状态与工具数，重连、启用、停用操作生效。验证：Playwright（截图存 `tmp/evidence/T36/`）。
- [T36-A13] 子 agent 定义中按名称引用的 server 复用连接池，项目级内联 server 在信任前不启动。验证：L2 场景。
- [T36-A14] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新 `agent-host/CLAUDE.md`：MCP 扩展与连接池的位置、接管内置扩展的方式、roots 规则、空闲阈值、易错点。
- 若 S3 或 T06 登记过 MCP 串扰问题，在 `PLAN.md`"登记事项"中标为已处理并写明验证方式。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：MCP 配置合并、连接池。
