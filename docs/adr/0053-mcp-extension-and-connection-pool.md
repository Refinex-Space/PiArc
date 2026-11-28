# 0053. MCP 扩展与工作区连接池的落地（补充）

- 状态：已接受，补充 ADR-0005、ADR-0010、ADR-0021、ADR-0025、ADR-0035、ADR-0048
- 日期：2026-11-21
- 相关：架构第 5.2、5.5、5.6、6.1.1、6.2.2、6.6.1、6.8、6.14、7.4、9.1、10.2 节；T36；FR-EX-03；登记事项 I40、I111、I117、I129、I132

## 背景

架构第 6.8 节定了方向：PiArc 的 MCP 扩展替换 Pi 内置的 MCP 扩展，在 Agent Host 内按工作区维护共享连接池，token 进保险箱，SSE 不支持。S3 时 Agent Host 给每个会话加载 Pi 的 `createMcpExtension()`，同一个 server 被几个会话配置就起几份进程，pi-mcp 的 token 写在明文的 `pi/mcp-auth.json`，默认暴露方式 codemode 会自动激活 Pi 的 codemode。T36 实现时要定下基线没写到的细节：配置从哪几处读、同一层里谁先、`${VAR}` 用哪份环境展开、池子在什么时候连接和断开、stdio 进程怎样保证不成为孤儿、server 的环境从哪里来、延迟加载怎样复用 Pi 的 `tool_search`、server 说明与中途变化怎样进上下文、OAuth 状态存在哪里、启停选择存在哪里、子 agent 的 `mcpServers` 怎样接线。

## 决策

1. **替换内置扩展。** SDK 路径的会话不加载 Pi 的内置扩展；Agent Host 不再加入 `createMcpExtension()`，改为每个会话一个 PiArc 的扩展（`agent-host/src/mcp/session.ts` 的 `McpSession`，在扩展列表最前），它共用工作区的 `McpPool`（`agent-host/src/mcp/pool.ts`，每个 Agent Host 一个）。codemode 不加载。Pi 的 `.pi/mcp.json`、`mcp.log`、`mcp-auth.json` 都不再读写；Pi 扩展经 `registerMcpServer` 或 `mcp_servers_change` 动态加入的 server 不接入（插件与 Pi 包由 T40 处理）。能力名 `mcpPool` 由 Core 在握手中开启。
2. **配置来源与同名取舍在 Core。** `piarc_config::mcp::merge` 是唯一的合并实现，`piarc_core::mcp` 收集输入并应答 `mcp/servers`。来源按优先级从高到低：local（`~/.claude.json` 的 `projects[<工作区>].mcpServers`）> project（`.piarc/settings.local.json`、`.piarc/settings.json`、`.mcp.json`，按此顺序）> user（PiArc 用户级 `settings.json`、`~/.claude.json` 顶层 `mcpServers`）；enterprise 与 plugin 是预留的作用域（T47、T40）。同名 server 取最先出现的整条定义，不合并字段，被替换的定义作为 `overridden` 列出。server 名必须是 1–64 个 `[A-Za-z0-9_-]`。`type` 接受 `stdio`、`http`、`streamable-http`；`sse`、`ws`、`websocket` 列为不支持并带原因，在 MCP 设置页与配置诊断页显示；`headersHelper` 不执行，报为问题。`timeout` 是单次工具调用的毫秒数（下限 1,000）。池的两个设置是 PiArc 自己的键：`mcp.idleTimeoutSeconds`（默认 600）、`mcp.deferThreshold`（默认 30）。Claude Code 的键：`disabledMcpjsonServers` 生效；`enableAllProjectMcpServers`、`enabledMcpjsonServers` 忽略（项目 server 由 PiArc 的信任对话框决定）；`allowedMcpServers`、`deniedMcpServers` 是企业策略，留给 T47。
3. **`${VAR}` 在 Core 展开。** `${VAR}` 与 `${VAR:-default}` 在 `command`、`args`、`env`、`cwd`、`url`、`headers` 中展开，值取用户登录 shell 的环境去掉 PiArc 内部变量后的那一份（`ToolIo::expansion_environment`，与 ADR-0035 的命令环境同源但不过滤准入名单：用户在配置里点名的变量就是要传给 server 的）。没有值又没有默认值的引用保持原文并报为问题。配置诊断读取时不展开，报告里不出现环境变量的值。
4. **信任。** project 作用域的 server 在项目受信任前标为 `untrusted`：照常列出（不带程序与地址），不连接、不启动。可执行项按 server 名加程序或地址再加 `type`、`args`、`env`、`cwd`、`headers`、`oauth` 命名（`piarc_config::mcp::trust_item_name`），改了"运行什么"就是新增项，项目回到未确认（ADR-0029、I63）。`.piarc/settings*.json` 的 `mcpServers` 与子 agent 定义中的内联 server 也是可执行项；`.pi/mcp.json` 不再枚举。local 与 user 作用域是用户自己的文件，不需要信任。
5. **启停选择按工作区存在 Core。** MCP 设置页的启用与停用写 `core.sqlite` 的 `mcp_servers(workspace, name, enabled)`（schema v9），合并时用户的选择优先于 `disabledMcpjsonServers`。停用的 server 状态为 `disabled`，池关闭它的连接。
6. **连接池的生命周期。** 会话打开时对每个可运行的 server 取一个租约（`attach`），第一个租约触发连接；工具列表与 server 说明缓存在池中。没有进行中的调用、也没有新租约满 `idleTimeoutMs` 后断开（stdio 进程退出），下次需要时再连。有租约时连接失败按 1 s 起倍增、至多 60 s 的退避重试；需要登录的 server 停在 `needsAuth` 等用户登录。计时用可注入的 `PoolClock`。`mcp/status` 先让池重读一次配置：定义变了的 server 换新连接，删除或停用的关闭。
7. **roots 与工作目录按工作区。** 一个连接被不同 cwd 的会话共用（worktree 会话、子 agent 的临时 worktree），所以 server 的 roots 是工作区根加已打开会话所在的 `.piarc/worktrees/<名称>/`，会话进出时发 `notifications/roots/list_changed`；stdio server 的工作目录是工作区根（定义的 `cwd` 相对工作区根解析）。S3 报告里"每会话按自己的 cwd 起 server"的结论随之作废。
8. **stdio 传输自写，server 留在 Agent Host 的进程组。** pi-mcp 的 `StdioTransport` 以 `detached` 启动 server，Agent Host 被杀时 Core 对 Agent Host 进程组的清理够不到它们。PiArc 的 `agent-host/src/mcp/stdio.ts` 按 MCP 规范逐行分帧（UTF-8、单条至多 16 MiB、容忍 CRLF），不脱离 Agent Host 的进程组（macOS）与 Job Object（Windows）；关闭按规范先关 stdin（等 1 s），再对进程树发 `SIGTERM`（等 2 s，macOS 先经 `ps` 收集子孙进程，覆盖 `npx` 这类包装），最后 `SIGKILL`；Windows 用 `taskkill /T /F`。
9. **server 的环境。** stdio server 从 Core 在 `mcp/servers` 里给出的命令环境（ADR-0035）起步，PATH 最前加内置 Node 所在目录（`npx` 类 server 在没装 Node 的机器上也能运行），再加 Agent Host 自己的 `TMPDIR`、`TEMP`、`TMP`、`npm_config_cache`、`npm_config_update_notifier`（Seatbelt 只放行数据目录的写入），最后是定义里的 `env`。Agent Host 的其他变量（`PI_PACKAGE_DIR` 等）不传给 server；凭据从不进环境。`npx` 因 Seatbelt 报 `EPERM` 时错误里提示改用 registry 包或本地 tarball（I40）。
10. **工具暴露与 `ToolSearch`。** 工具名经 pi-mcp 的 `createMcpToolName` 得到 `mcp__<server>__<tool>`，投影为 `mcpToolCall` 条目，结果经 pi-mcp 的 `toLlmContent` 转换后走 T16 的结果预算。会话的 MCP 工具总数不超过阈值时全部直接声明（描述至多 4,096 字符）；超过时全部注册但不激活（描述至多 16,384 字符），只有 server 的 `alwaysLoad` 或工具 `_meta["anthropic/alwaysLoad"]` 为真的保持声明，并激活 `ToolSearch`：它是 Pi 的 `tool_search`（`createToolSearchExtension`），经一个包住 `ExtensionAPI` 的 Proxy 以规范名 `ToolSearch` 和 PiArc 自己的描述注册，命中的工具经 `setActiveTools` 激活，下一步起可调用。`ToolSearch` 只读，在 Core 的只读宿主工具里，不需要审批。
11. **server 说明与中途变化。** 首个回合开始前最多等 10 s 让正在连接的 server 连上，它们的 instructions（每个至多 4,096 字符，说明它们只解释工具、不改变用户指令）与"哪些 server 的工具要经 ToolSearch 找"写进 system prompt 第 6 段 `mcp_servers`（在环境段之前）。之后工具增减（`list_changed`、重连、停用）与新的 instructions 都经 `piarc.reminder` 的 `mcpChanged` 提醒送达，已发送的 system prompt 不改写（第 6.6.1 节）。
12. **裁决。** MCP 工具调用照常经 `policy/evaluate`，`mcp__<server>__<tool>` 与 `mcp__<server>__*` 规则生效。工具的 `_meta["anthropic/requiresUserInteraction"]` 为真时 Agent Host 在请求里带 `requiresUserInteraction: true`，Core 把它作为必须询问的一步（`requiresUserInteraction`）：任何模式下都询问（L2 覆盖了跳过权限），既有 allow 规则不放行，审批卡不提供"总是允许"的规则。
13. **OAuth 状态在保险箱。** 用 pi-mcp 的 OAuth（受保护资源与授权服务器元数据发现、PKCE S256、动态客户端注册、刷新与 refresh token 轮换）；客户端注册、token 与待用的 PKCE verifier 经 `McpOAuthServerStore` 存在保险箱键 `mcp/<server>`。刷新前取 Core 的 `secrets/lock`（两个工作区的 Agent Host 共用同一个用户级 server 时不会用同一个轮换的 refresh token 刷新两次）。pi-mcp 只使用 `serverUrl` 与当前地址相同的状态，所以同名而地址不同的 server 从头登录、覆盖旧状态。登录：设置页调 `mcp/login`，Agent Host 开回环监听（定义的 `oauth.callbackPort` 或临时端口），授权页经 `ui/loginInteraction` 交给 Core 的 `core/login`（provider 为 `mcp:<server>`），客户端沿用 T29 的登录对话框在系统浏览器中打开，也可手工粘贴回调地址。401、403 与 `insufficient_scope` 使状态变为 `needsAuth`。
14. **AHP 与 Core 的状态。** Agent Host → Core：`mcp/servers`。Core → Agent Host：`mcp/status`、`mcp/reconnect`、`mcp/setEnabled`、`mcp/login`（结果为该 server 的状态）。Agent Host → Core 的通知 `mcp/statusChanged` 是第一个工作区级通知：它没有会话头，`piarc-host` 只对 `HOST_NOTIFICATIONS` 列出的方法放行（`HostEvent::HostNotification`），Core 加上 `workspace` 后发到路由 `core/mcp`。工作区没有运行中的 Agent Host 时，Core 按配置回答状态（可运行的为 `idle`）。
15. **子 agent 的 `mcpServers`。** 子会话与主会话共用工作区的池，按名称引用的 server 用池里已有的连接。内联定义由 Core 在 `agents/list` 中检查与展开（`mcpInline`，作用域 `subagent`；项目级定义的内联 server 在项目受信任前为 `untrusted`），子会话运行期间作为属于它的临时 server 加入池（键为子会话 id 加名称），子会话结束即关闭；工具过滤让这些 server 的 `mcp__<server>__…` 通过，除非 `disallowedTools` 点名该工具或 `mcp__<server>`。T31 对 `mcpServers` 的"暂未生效"警告随之去掉。

## 备选方案

| 方案 | 结论 | 理由 |
|---|---|---|
| 保留 Pi 的 MCP 扩展，只把 `mcp-auth.json` 换成保险箱 | 否决 | 它按会话实例化、server 按会话复制，codemode 默认开启；池子与工具名、裁决、提醒都要在它外面再包一层 |
| 用 pi-mcp 的 `StdioTransport` | 否决 | 它让 server 自成进程组，Agent Host 被杀时 server 成为孤儿（A11） |
| 连接池放在 Core（Rust 实现 MCP 客户端） | 否决 | pi-mcp 已有客户端、Streamable HTTP 与 OAuth；Core 只管配置、信任、启停与凭据，ADR-0010 定了池在 Agent Host |
| server 的 roots 与 cwd 随会话 | 否决 | 一个连接被多个会话共用，随会话切换会让同一 server 的文件视图来回变化 |
| server 继承 Agent Host 的完整环境 | 否决 | Agent Host 的环境是为它自己裁剪的（`PI_PACKAGE_DIR` 等内部变量），用户在终端里能用的工具链变量反而不全；命令环境（ADR-0035）才是用户期望的环境 |
| 延迟加载自写检索工具 | 否决 | Pi 的 `tool_search` 已按名称与描述检索并激活工具；只需换成规范名与 PiArc 的描述 |

## 后果

- 正面：同一工作区的 server 只有一份进程，空闲后释放；token 不落盘；Agent Host 退出或被杀不留 server 进程；用户的 `.mcp.json` 与 `~/.claude.json` 直接可用；工具多时 system prompt 不膨胀。
- 代价：自写 stdio 传输要跟进 MCP 规范；首个回合可能为连接中的 server 等最多 10 s；同名 server 的 OAuth 状态在工作区之间共用一个保险箱键。
- 需要配套做的事：Windows CI 验证无孤儿进程（A11）；MCP 资源（`resources/*`）工具与 prompts 斜杠命令（T40 及之后）；`allowedMcpServers`、`deniedMcpServers`（T47）；Pi 扩展注册的 server（T40）。
