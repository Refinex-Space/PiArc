# agent-host · mcp

Agent Host 的 MCP 连接池与每会话的 MCP 扩展（T36，ADR-0053）。配置的合并、信任与启停在 Core（`piarc_config::mcp`、`piarc_core::mcp`）；进程边界与总体说明见上级 [`agent-host/AGENTS.md`](../../AGENTS.md)。

- 位置：`src/mcp/`。`pool.ts` 是工作区连接池（每个 Agent Host 一个，`host.ts` 在 Core 开启 `mcpPool` 时创建），`session.ts` 是每个会话的 PiArc MCP 扩展（`McpSession`），`connection.ts` 是一个 server 的连接（MCP 客户端、工具缓存、OAuth），`stdio.ts` 是自写的 stdio 传输，`config.ts` 解析 Core 的 `mcp/servers`，`vault-store.ts` 是 OAuth 状态的保险箱存储，`sign-in.ts` 是 `mcp/login`。提示文本在 `harness/prompts/mcp.ts`（改后跑原创性检查）。
- 接管内置扩展：会话运行时不再加入 Pi 的 `createMcpExtension()`，而是把 `McpSession.extension` 放在扩展列表最前（工具先注册，闸门与预算包住它们）；codemode 不加载，Pi 的 `.pi/mcp.json`、`mcp-auth.json` 不读写。`ToolSearch` 是 Pi 的 `createToolSearchExtension()`，经一个包住 `ExtensionAPI` 的 Proxy 把 `registerTool` 改成规范名与 PiArc 的描述，其余成员原样转发（`Reflect.apply`）。
- 配置只来自 Core 的 `mcp/servers`（来源、信任、启停、`${VAR}` 展开都在 Core），`mcp/status` 先 `refresh()` 再回答：定义变化的 server 换新连接。不要在 Agent Host 读任何 MCP 配置文件。
- 租约与空闲：会话 `session_start` 时 `attach`、`session_shutdown` 时 `detach`；空闲阈值来自 `mcp.idleTimeoutSeconds`（默认 600 s），计时用 `PoolClock`（测试经 `HostOptions.mcpClock` 注入手动时钟）。有租约时失败按 1 s 起倍增至 60 s 重试，`needsAuth` 不重试。
- roots：工作区根加已打开会话所在的 `.piarc/worktrees/<名称>/`，不是会话的 cwd（一个连接被多个会话共用）；stdio server 的工作目录是工作区根，定义的 `cwd` 相对它解析。会话进出改变 roots 时发 `notifications/roots/list_changed`。
- 暴露：会话的 MCP 工具数不超过 `mcp.deferThreshold`（默认 30）时直接声明，超过时注册但不激活（`alwaysLoad` 除外）并激活 `ToolSearch`，命中经 `setActiveTools` 激活（这里用 `setActiveTools` 是对的：被激活的是池注册的工具，与子 agent 过滤不同）。首个回合最多等 `STARTUP_WAIT_MS`（10 s）让连接中的 server 连上，instructions 进 system prompt 的 `mcp_servers` 段；之后的变化只经 `mcpChanged` 提醒。
- 裁决：工具 `_meta["anthropic/requiresUserInteraction"]` 为真时 `policy/evaluate` 带 `requiresUserInteraction: true`（`McpSession.requiresUserInteraction`），Core 总是询问。

- prompts（T40，ADR-0058）：声明 `prompts` 能力的 server 连接后用 `client.request('prompts/list')` 分页取全，`notifications/prompts/list_changed` 后重取并经 `#changed(false)` 发状态；`prompts.ts` 把它们变成 `mcp__<server>__<prompt>` 命令并展开输入（只送文本内容）。pi-mcp 没有 prompts API，不要等它。

易错点：

- 不要用 pi-mcp 的 `StdioTransport`：它以 `detached` 启动 server，Agent Host 被杀时 server 成为孤儿。`stdio.ts` 让 server 留在 Agent Host 的进程组，关闭顺序是关 stdin（1 s）→ `SIGTERM` 进程树（2 s，macOS 先经 `/bin/ps` 收集子孙）→ `SIGKILL`；Windows 用 `taskkill /T /F`。
- server 的环境是 Core 给的命令环境加 `serverEnv` 的补充（PATH 最前是 `dirname(process.execPath)` 即内置 Node，`TMPDIR`、`TEMP`、`TMP`、`npm_config_cache`、`npm_config_update_notifier` 取 Agent Host 的值），再加定义的 `env`；不要把 `process.env` 整个传下去（`PI_PACKAGE_DIR` 等内部变量不给 server）。`npx` 因 Seatbelt 得到 `EPERM` 时错误里有改用 registry 包或 tarball 的提示（I40）。
- 第一次列出工具也算"工具变化"（`connection.ts` 的 `changed` 含 `!this.listed`），否则先登录后连上的 server 不会注册工具。
- `mcp/statusChanged` 没有会话头：新增类似的工作区级通知要加进 `piarc-host` 的 `HOST_NOTIFICATIONS`，否则 Core 当作无效通知丢弃。客户端收到 `core/mcp` 后不要再请求 `mcp/status`（它会 `refresh` 再发 `statusChanged`，形成循环）。
- OAuth 状态在保险箱键 `mcp/<server>`；刷新前取 `secrets/lock`，失效的锁写入得到 `secretLockLost`。pi-mcp 只使用 `serverUrl` 相同的状态。
- 子 agent 的内联 server 经 `pool.addTemporary(子会话 id, defs)` 加入（键为 `owner\0name`），子会话结束即关闭；`tool-filter.ts` 的 `WithInlineServers` 让它们的 `mcp__<server>__…` 通过过滤。
