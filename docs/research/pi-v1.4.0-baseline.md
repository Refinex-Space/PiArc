> 本文是 2026-11-14 的调研快照，由调研过程整理而成，引用时注意时效。内容基于 Pi v1.4.0（commit 4a080252f06c）源码，文件:行号均指向该版本，升级 Pi 后需要复核。重要事实在用于设计或实现前，请回到原始来源重新核对。
>
> **PiArc 锁定的版本是 v1.5.2**（T06，2026-11-15）。第 0–11 节保留 v1.4.0 的原文与行号；v1.5.2 与它的差异、以及 T06 按 v1.5.2 源码复核的事实，见文末"版本差异：v1.5.2"一节，两者冲突时以该节为准。

# Pi v1.4.0 底座调研报告（PiArc）

调研对象：`reference/pi`，git HEAD `4a08025 Release v1.4.0`，浅克隆，只有 1 个提交。
下文路径都相对这个仓库根目录，`文件:行号` 指向 v1.4.0 源码。

标注约定：
- 【核实】：读源码或文档确认过。
- 【实测】：在本机跑过。环境是 macOS arm64、Node v24.14.1、Bun 1.4.4。
- 【推测】：根据代码推断，没有验证。

调研方式：
- 本人通读了 agent-core、coding-agent（工具、system prompt、session、settings、extension、RPC、trust）、构建脚本和 CHANGELOG。
- pi-ai、chord、durable/env/mcp/codemode 三块由并行子代理读源码，我对关键结论做了抽查复核。抽查项包括：Anthropic OAuth 伪装 Claude Code、coding-agent 不依赖 chord/durable、MCP 默认走 codemode、codemode 默认不激活、pi.dev catalog URL、chord 协议版本号。
- 全程只读：没有改 reference 目录，没有 `npm install`/build，没有发网络请求。
- 实测时用的是本机已经装好的 pi 1.4.0（`~/.pi/agent/install/releases/1.4.0`）。运行时加了 `--offline`，配置目录指向一个临时空目录，没有碰用户的 `~/.pi` 配置和凭据。

---

## 0. 结论先行

1. **建议的底座形态**：Rust 宿主拉起 Pi sidecar 子进程，用 Pi 自带的 RPC 模式通信（stdin/stdout 上的严格 LF JSONL）。Claude Code 级的 Harness 能力大部分写成 PiArc 自己的 Pi extension 包，在自定义 sidecar 入口里通过 `main(args, { extensionFactories })` 静态注入。宿主负责原生 UI、凭据（Keychain）、文件快照和 OS 沙箱。chord 和 durable 都不进主路径。
2. **能直接拿到的**：
   - 约 42 个 provider 的统一流式抽象（pi-ai）；
   - Claude Pro/Max、ChatGPT/Codex、Copilot、xAI 等 OAuth 订阅登录；
   - 稳定的 agent loop，支持并行工具、steering/follow-up 队列、abort；
   - JSONL 树形会话（fork/clone/tree）、自动 compaction、skills、prompt templates、MCP（stdio/HTTP + OAuth）；
   - 功能很全的 extension API（tool_call 可以阻断和改写参数，可以注册或覆盖工具、命令、provider）。
3. **必须自己补的**：子 agent、plan mode、权限系统、hooks、todo、文件级 checkpoint、Web 工具、后台 shell，以及登录 UI。RPC 里没有 login 命令，`/login` 只在 TUI 里有。会话列表、多会话并发、企业策略、协议版本协商也都没有。前五项用 extension 就能做，官方 examples 里有可运行的原型。后几项需要宿主侧实现。
4. **三个必须提前决策的风险**：
   - **合规风险（高）**：pi-ai 用 Claude Pro/Max OAuth 发请求时，会伪装成 Claude Code，包括 `user-agent: claude-cli/2.1.280`、注入 "You are Claude Code…" system 文本、把工具名改成 Claude Code 的大小写。证据见 `packages/ai/src/api/anthropic-messages.ts:95-130,1048-1068,1227-1244`。商业桌面产品复用这条路径，要先评估服务条款风险。
   - **上游 API 变化快**：自 2026-06 起 coding-agent 发了 51 个版本，其中 9 个带 Breaking，合计 33 条；pi-ai 有 14 个版本带 Breaking，合计 34 条。RPC 没有版本握手。必须锁定精确版本，并在宿主侧做协议适配层。
   - **上游协作门槛高**：新贡献者的 issue 和 PR 默认自动关闭，核心坚持"能做成 extension 的就不进核心"（`CONTRIBUTING.md`）。所以要优先走 extension，避免 fork 核心。
5. **分发代价**【实测】：

| 方案 | 体积 | RPC 冷启动到首个 `get_state` 响应 | RSS |
|---|---|---|---|
| Bun compile 单文件 | 约 99 MB（gzip 43 MB，xz 29 MB） | 约 0.35 s（首次执行 1.85 s） | 约 90 MB |
| Node + esbuild bundle | 约 135 MB（node 本体 119 MB） | 0.25–0.30 s | 约 120 MB |

---

## 1. 分层与依赖

### 1.1 包依赖（核实，来自各包 `package.json` 的 dependencies，以及 src 里 `@earendil-works/*` import 的计数）

```
pi-telemetry (无内部依赖)
   ├── pi-ai (telemetry + @anthropic-ai/sdk, openai, @google/genai, @aws-sdk/client-bedrock-runtime, undici 代理等)
   │     └── pi-agent-core (ai, typebox)
   │           └── pi-coding-agent (agent-core, ai, codemode, mcp, tui, jiti, photon-node, quickjs-wasi ...)
   └── chord (telemetry, typebox)
         └── pi-durable (chord, ai, codemode, telemetry, photon, diff)
               └── pi-env (chord, durable) + Rust daemon
pi-mcp (只依赖 cross-spawn)    pi-codemode (只依赖 quickjs-wasi)    pi-tui (无内部依赖)
```

- coding-agent 的依赖列表里没有 chord、durable、env（`packages/coding-agent/package.json` 的 dependencies），src 里 grep 也是 0 处引用。1.2.0 明确写了 "Removed the dependency on `@earendil-works/chord`"，同一版本还删掉了实验性的 server/client/plugin 栈，以及 `pi-client`、`pi-protocol`、`pi-server` 三个包（`packages/coding-agent/CHANGELOG.md:165-166`）。
- 根 `package.json` 的 build 顺序是 telemetry → chord → tui → codemode → mcp → ai → durable → env → agent → coding-agent。

### 1.2 职责边界

| 包 | 职责 | 是否在 CLI 主路径 |
|---|---|---|
| pi-ai | 统一的多 provider LLM 流式 API、模型目录、OAuth 流程、cost 计算、跨 provider 消息转换 | 是 |
| pi-agent-core | 无状态 `agentLoop` 加有状态 `Agent` 类：turn 循环、工具执行、hooks、队列、abort。约 2.5k 行 | 是 |
| pi-coding-agent | CLI/TUI/print/json/RPC 模式、SDK、内置工具、会话、settings、extension/skills/prompts/packages、compaction、内置 MCP/codemode/tool-search 扩展 | 是（主体） |
| pi-tui | 终端 UI 库，带可选的 N-API 原生剪贴板/修饰键 helper | 只用于 TUI |
| pi-mcp | 自写的 MCP 客户端 | 是（经内置扩展） |
| pi-codemode | QuickJS-WASM 沙箱，让模型写 JS 来编排工具 | 是（经内置扩展，默认不激活） |
| chord | 带类型的宿主运行时：热重载插件、契约、复制状态、JSON link RPC | 否 |
| pi-durable | 持久化 agent harness，自带一套 agent loop，标注 Experimental | 否 |
| pi-env | durable 的远程执行环境（Rust daemon，SSH） | 否 |
| pi-telemetry | 厂商中立的 telemetry 契约，不带 exporter | 是（noop） |

**两套平行的 agent 栈**【核实】：
- A 栈：ai → agent-core → coding-agent，这是 CLI 产品本身。
- B 栈：chord → durable → env，是持久化/云端（Cloudflare DO、浏览器）方向的实验栈。durable 的 generation 直接调 pi-ai 的 `streamSimple`（`packages/durable/src/harness/generation.ts:484`），不用 pi-agent-core。它自带的 read/write/edit/bash、tool_search、子 agent 和 coding-agent 里的同名能力重复，会话格式也互不兼容。

### 1.3 哪些包能脱离 coding-agent 单独嵌入

- **pi-ai**：可以。运行时内部依赖只有 telemetry。必须跑在 Node ≥22.19 或 Bun 上；OAuth 回调服务器和 Bedrock 都依赖 Node API。
- **pi-agent-core**：可以，只依赖 pi-ai。
- **pi-mcp**、**pi-codemode**：可以，零内部依赖。
- **chord**、**pi-durable**：可以，但 durable 标注 "Experimental. The API changes without notice"（`packages/durable/README.md:3`）。
- 对 PiArc 来说，"嵌入"只能发生在 JS sidecar 里，Rust/Swift 不能直接链接这些包。所以真正要选的是：用 coding-agent 的 RPC，还是自写一个 Node sidecar 基于 SDK 加自定义协议。见第 11 节。

---

## 2. pi-ai：Provider 抽象（子代理读码，关键点已抽查）

### 2.1 统一的消息、流、工具调用模型

- 消息类型 `Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage`（`packages/ai/src/types.ts:652`）。
  - `SystemMessage` 可以出现在对话中间，带 `sections`（按名字替换的 prompt 片段）和 `toolsAdded/toolsRemoved`（`types.ts:554-570`）。agent-core 在每次请求前，把可执行工具集和 transcript 里声明的工具集做 diff，差异写成 system message（`packages/agent/src/agent-loop.ts:342-375`）。
  - 好处是 system prompt 和工具变化都留在 transcript 里，可以重放。
- 内容块：
  - `TextContent`（带 `textSignature`）；
  - `ThinkingContent`（`thinking/thinkingSignature/redacted`）；
  - `ImageContent`，只支持 base64；
  - `ToolCall{id,name,arguments,thoughtSignature?,namespace?,argumentsError?}`（`types.ts:422-457`）。
- `StopReason`：`pending|stop|length|toolUse|error|aborted|deferred`（`types.ts:482`）。
- 流事件共 12 种（`types.ts:814-830`）：`start`、`text_start/delta/end`、`thinking_start/delta/end`、`toolcall_start/delta/end`、`done`、`error`。失败也必须在流内以 `error` 事件结束，不抛异常。工具参数在流式过程中用 partial-json 增量解析。
- `Api` 表示线协议，共 10 种：openai-completions、openai-responses、azure-openai-responses、openai-codex-responses、anthropic-messages、bedrock-converse-stream、google-generative-ai、google-vertex、mistral-conversations、pi-messages（`types.ts:64-76`）。
  - `Provider` 是运行时单元，负责 auth、models、stream，可以同时用多种 api，例如 github-copilot 同时用 anthropic 和 openai 两种（`packages/ai/src/providers/github-copilot.ts:9-31`）。
  - `Model` 是纯数据。
- 入口：
  - `createModels()` 加 `models.setProvider()`；
  - `models.stream/complete` 用各 api 的原生参数，`streamSimple/completeSimple` 用统一参数（`packages/ai/src/models.ts:324-337,417,1028`）；
  - 自定义 provider 用 `createProvider({...})`（`models.ts:1032-1218`）；
  - 旧的全局 API 在 `./compat`，注释说会删除（`packages/ai/src/compat.ts:9-10`）。

### 2.2 Provider 与认证

- 共 42 个 provider id，`builtinProviders()` 一次注册全部（`packages/ai/src/providers/all.ts:136-189`）。覆盖：
  - anthropic、openai、google、google-vertex、amazon-bedrock、azure、mistral、xai、meta；
  - groq、cerebras、deepseek、together、fireworks、openrouter、vercel-ai-gateway、cloudflare、huggingface、nvidia；
  - moonshot/kimi、zai、qwen、xiaomi、minimax、github-copilot、openai-codex（legacy）、radius（pi.dev 网关）等。
- API key：每个 provider 自带 `envApiKeyAuth`，存储的凭据优先于环境变量（`packages/ai/src/auth/helpers.ts:9-31`）。Anthropic 依次识别 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_OAUTH_TOKEN`、`ANTHROPIC_API_KEY`（`packages/ai/src/providers/anthropic.ts:28-70`）。
- OAuth 订阅，统一懒加载（`packages/ai/src/auth/oauth/load.ts:33-80`）：

| 订阅 | 实现 | 方式 |
|---|---|---|
| Claude Pro/Max | `auth/oauth/anthropic.ts:14-25` | PKCE，回调端口 53692，有回退端口 |
| ChatGPT | `openai-chatgpt.ts:16-26` | 回调端口 1455 |
| ChatGPT/Codex（legacy） | `openai-codex.ts:22-33` | 回调或 device code |
| GitHub Copilot | `github-copilot.ts:495-506` | device code，支持企业域名 |
| xAI、Meta、Kimi、OpenRouter、Radius | 同目录各文件 | 各自实现 |

  Gemini CLI 和 Antigravity 已在 0.71.0 删除（`packages/ai/CHANGELOG.md:1205`）。
- 云认证：
  - Bedrock：bearer、profile、AK/SK、ECS、IRSA（`packages/ai/src/providers/amazon-bedrock.ts:11-80`）；
  - Vertex：API key 或 ADC（`google-vertex.ts:13-90`）；
  - Azure：环境变量（`packages/ai/src/api/azure-openai-config.ts:74-75`）。
- **token 刷新在 pi-ai 内部，持久化交给调用方**：
  - `CredentialStore` 接口有 `read/list/modify/delete`，要求 `modify` 按 provider 串行化，最好跨进程加锁（`packages/ai/src/auth/types.ts:65-94`）；默认实现只在内存里。
  - 剩余有效期不到 5 分钟时，在锁内刷新，超时 15 s（`packages/ai/src/auth/resolve.ts:102-191`）。
  - coding-agent 的实现是 `~/.pi/agent/auth.json` 加 `proper-lockfile`（`packages/coding-agent/src/core/auth-storage.ts:9,130`）。
- `./bun-oauth` 给 Bun 单文件二进制用，把各 OAuth 模块静态注册进去，替代打包器跟不进去的动态 import（`packages/ai/src/bun-oauth.ts:13-25`）。

**合规风险【本人复核】**：Anthropic OAuth token 走的路径会做三件事。
- 默认头改成 `user-agent: claude-cli/2.1.280` 和 `x-app: cli`（`packages/ai/src/api/anthropic-messages.ts:1048-1063`）。
- system 第一段强制写成 "You are Claude Code, Anthropic's official CLI for Claude."（`anthropic-messages.ts:1227-1244`）。
- 工具名按 Claude Code 的大小写改写（`anthropic-messages.ts:95-130`，代码注释里自称 "Stealth mode"）。

PiArc 如果把"Claude Pro/Max 订阅登录"做成卖点，直接依赖的就是这条路径，需要法务和产品层面先决策。

### 2.3 模型目录

- 生成方式：`packages/ai/scripts/generate-models.ts` 汇总 models.dev、OpenRouter、Vercel AI Gateway、Radius 的数据，再加大量手工补丁，生成 `src/providers/data/<id>.json`。这个目录被 gitignore，当前 checkout 里不存在。`models.generated.ts` 只做聚合。
  - 构建前需要先 hydrate：`npm run build` 会联网刷新，`build:offline` 要求数据已经就位。发版用的源码包里带有固定版本的数据（根 `README.md` "Building standalone binaries" 一节）。
- **pi.dev overlay 在 coding-agent 里，不在 pi-ai 里**（`packages/coding-agent/src/core/remote-catalog-provider.ts:14-16,66-73,144-171`）【已抽查】：
  - URL 为 `https://pi.dev/api/models/providers/{id}?types=chat,image,classifier`；
  - 每 4 小时检查一次，单次超时 4 s，用 ETag/304；
  - 只有远端 Last-Modified 晚于本地生成时间才覆盖，失败时保留缓存；
  - 缓存放在 `<agentDir>/models-store.json`；
  - 设了 `PI_OFFLINE` 就不联网。
- Model 字段：`id/name/api/provider/baseUrl/input/inputLimits/cost(USD 每百万 token，含 input/output/cacheRead/cacheWrite，可分档)/reasoning/thinkingLevelMap/promptCache/contextWindow/maxTokens/samplingParams/compat`（`packages/ai/src/types.ts:833-880`，`packages/ai/src/providers/model-schema.ts:28-49`）。

### 2.4 缓存与 thinking 参数如何统一

- **缓存**：统一参数 `cacheRetention: none|short|long`，默认 short（`packages/ai/src/types.ts:251`）。
  - Anthropic 在三处打 `cache_control`：system、最后一个工具、最后一条 user 消息；long 对应 1h TTL（`anthropic-messages.ts:1227-1252,1529-1555,1659`）。
  - OpenAI Responses 用 `prompt_cache_key=sessionId`，long 对应 24h（`packages/ai/src/api/openai-responses.ts:124-142`）。
  - Bedrock 用 `cachePoint`。Google 只做统计。
- **thinking**：统一等级 `off/minimal/low/medium/high/xhigh/max`。`Model.thinkingLevelMap` 映射到厂商值，`clampThinkingLevel` 就近取一个支持的等级（`packages/ai/src/models.ts:1258-1290`）。
  - Anthropic：adaptive 加 effort，或 budget_tokens（默认 1024/2048/8192/16384）。
  - OpenAI：`reasoning.effort`。
  - Gemini：`thinkingLevel` 或 `thinkingBudget`。
  - OpenAI 兼容端点：`compat.thinkingFormat` 有 11 种写法（`packages/ai/src/providers/compat-schema.ts:244-263`）。
- `compat`：OpenAI-compatible 端点先按 provider 和 baseUrl 自动探测，再由 `model.compat` 逐字段覆盖（`packages/ai/src/api/openai-completions.ts:1603,1706-1744`）。

### 2.5 token 与 cost

- `Usage` 字段：`input/output/cacheRead/cacheWrite/cacheWrite1h?/reasoning?/totalTokens/cost{...,total}`（`packages/ai/src/types.ts:459-480`）。
- `calculateCost` 支持分档，1h 缓存写入按 2 倍 input 单价计（`packages/ai/src/models.ts:1236-1256`）。
- OpenAI 的 input 要先扣掉 cached 部分；DeepSeek、Kimi 的缓存字段做了兼容（`packages/ai/src/api/openai-completions.ts:1540-1566`）。
- coding-agent 通过 RPC 的 `get_session_stats` 暴露累计用量和 contextUsage。

### 2.6 跨 provider 切换时的消息转换

`transformMessages`（`packages/ai/src/api/transform-messages.ts:91-256`）的规则：
- provider、api、model 三者都相同才算同一模型。
- 换了模型，thinking 块直接丢弃，不转成文本；text 和 toolCall 上的签名去掉。
- toolCall id 按目标 api 规范化，同时改写对应的 toolResult。
- error/aborted 的 assistant 消息跳过；孤立的工具调用补一条合成的错误结果。
- 目标模型不支持视觉时，图片换成占位文本。

结果是会话中途可以换模型，但旧模型的推理内容会丢。

---

## 3. pi-agent-core：agent loop（本人通读）

### 3.1 循环结构

`runLoop`（`packages/agent/src/agent-loop.ts:172-330`）是两层循环。

内层循环在"还有工具调用"或"有待处理消息"时继续，每一轮依次做：
1. 调 `prepareNextTurn` hook，可以替换 context、model、thinking（:189-213）；
2. 发出 steering 等待处理的消息（:216-222）；
3. 调 `prepareRequest`（:224-243）；
4. 流式拿到 assistant 回复（:246）；
5. 执行工具（:268-281）；
6. 调 `finishTurn`，可以返回 continue 或 end（:289-297）；
7. 再轮询一次 steering（:300）。

外层循环在内层结束后轮询 follow-up 队列，有消息就继续（:308-314）。

其他细节：
- 如果回复的 stopReason 是 `error` 或 `aborted`，立即结束这次 run（:249-260）。
- 如果 stopReason 是 `length`（输出被截断），这条消息里的所有工具调用直接判为失败，不执行，避免拿截断的参数去执行（`agent-loop.ts:488-516`）。

### 3.2 工具执行：并发还是串行

- 默认 `parallel`。只要这一批调用里有一个工具声明了 `executionMode: "sequential"`，整批改为串行（`agent-loop.ts:518-533`）。
- 并行模式的具体做法（`agent-loop.ts:596-668`）：
  - 预检（prepare）**按顺序**逐个做：参数准备、schema 校验、`beforeToolCall`；
  - 通过预检的工具并发执行；
  - `tool_execution_end` 按完成顺序发出，toolResult 消息按 assistant 里的原始顺序发出。
- 预检串行这一点对权限弹窗很重要：确认框不会并发弹出。
- `beforeToolCall` 只能返回 `{block, reason, terminate}`（`packages/agent/src/types.ts:66-75`）。`afterToolCall` 可以逐字段覆盖 content、details、isError、usage、terminate（`types.ts:92-105`，`agent-loop.ts:869-920`）。
- `runToolCall` 让一个工具调用另一个工具时也经过同一套 hooks（`agent-loop.ts:821-829`）。coding-agent 的 codemode 就是靠它让嵌套调用也经过权限检查。
- 工具抛出的异常会转成错误结果，不会冒泡（`agent-loop.ts:855-866`）。

### 3.3 中断与队列

- `Agent.abort()` 触发当前 run 的 AbortController（`packages/agent/src/agent.ts:350-352`）。signal 一路传到 provider 流和工具的 `execute(signal)`。
  - 串行模式下，abort 后不再执行后续工具（`agent-loop.ts:585-587`）。
  - 并行模式下，尚未开始的工具返回 "Operation aborted"（`agent-loop.ts:629-637`）。
- `steer(msg)` 在当前 turn 的工具执行完、下一次请求前注入；`followUp(msg)` 在 agent 本来要停下时注入（`agent.ts:308-315`）。
  - 队列模式 `one-at-a-time`（默认）或 `all`（`types.ts:55`）。
  - run 进行中调用 `prompt()` 会抛错，提示改用 steer 或 followUp（`agent.ts:382-386`）。
- 订阅者按注册顺序被 await。`agent_end` 的监听器跑完，run 才算结束，`waitForIdle()` 才返回（`agent.ts:575-622`）。

### 3.4 事件与状态

- `AgentEvent` 共 10 种：agent_start/end、turn_start/end、message_start/update/end、tool_execution_start/update/end（`types.ts:516-539`）。`message_update` 携带底层的 `AssistantMessageEvent`。
- `AgentState` 字段：model、thinkingLevel、tools、messages，以及只读的 isStreaming、streamingMessage、pendingToolCalls、errorMessage（`types.ts:382-422`）。状态在 `processEvents` 里按事件归约（`agent.ts:575-615`）。
- `AgentMessage` 可以通过声明合并扩展自定义消息类型，发请求前由 `convertToLlm` 过滤或转换（`types.ts:365-374`）。

### 3.5 transport 抽象

- `StreamFn` 是可注入的流函数，默认用 pi-ai（`types.ts:33-37`，`packages/agent/src/stream-fn.ts`）。
- `Transport = "sse"|"websocket"|"websocket-cached"|"auto"`（`packages/ai/src/types.ts:147`），只是传给 provider 的首选项，主要影响 OpenAI Codex 的 WebSocket。
- `streamProxy` 把 LLM 调用转给远端代理服务器，服务端会去掉 partial 字段以节省带宽（`packages/agent/src/proxy.ts:23-60,107`）。PiArc 将来如果要做"云端托管模型、本地 agent"，可以用这个形态。

---

## 4. coding-agent（本人通读）

### 4.1 内置工具

| 工具 | 参数 | 实现要点 |
|---|---|---|
| read | `path, offset?, limit?`（`core/tools/read.ts:14-17`） | 截断到 2000 行或 50KB（`core/tools/truncate.ts:11-12`）；支持 jpg/png/gif/webp/bmp 作为附件，默认自动缩放（photon wasm）；模型不支持视觉时给出提示（`read.ts:63-90`） |
| bash | `command, timeout?(秒，无默认)`（`bash.ts:40-43`） | 每条命令 spawn 一个新 shell，没有持久 shell 会话；detached 进程组，abort 或超时时杀整棵进程树（`bash.ts:112-135`）；输出只保留尾部 2000 行/50KB，全量写临时文件（`bash.ts:255,352`）；注入 `PI_PROVIDER/PI_MODEL/PI_REASONING_LEVEL` 等环境变量（`bash.ts:205-212`）；`commandPrefix`、`spawnHook`、`shellPath` 可配（`bash.ts:214-226`） |
| edit | `path, edits[{oldText,newText}]`（`edit.ts:21-39`） | 一次调用多处替换，都基于原文件匹配，要求唯一且不重叠；按文件串行（`withFileMutationQueue`，`edit.ts:166`）；声明了 `constrainedSampling: json_schema`（`edit.ts:157`） |
| write | `path, content`（`write.ts:11-14`） | 整文件写入 |
| grep | `pattern, path?, glob?, ignoreCase?, literal?, context?, limit?(100)`（`grep.ts:21-32`） | 调 ripgrep，遵守 .gitignore |
| find | `pattern(glob), path?, limit?(1000)`（`find.ts:26-31`） | 调 fd |
| ls | `path?, limit?(500)`（`ls.ts:11-13`） | 包含点文件 |
| powershell | 同 bash | 可选，Windows 用（`docs/windows.md`） |

补充说明：
- **默认激活的只有 read、bash、edit、write**（`core/settings-manager.ts:85`，`core/system-prompt.ts:64`）。grep、find、ls 要用 `--tools` 或 settings 的 `defaultTools` 打开。
- **rg/fd 的获取顺序**：先找 `<agentDir>/bin`，再找 PATH，都没有就**运行时从 GitHub 下载**（`utils/tools-manager.ts:84-103,350-401`）；设了 `PI_OFFLINE` 则跳过下载。打包 sidecar 时应把 rg 和 fd 预置到 `<agentDir>/bin`，或者放进 PATH。
- 每个工具都有可插拔的 `*Operations` 接口（`BashOperations.exec`，`bash.ts:71-91`；`ReadOperations`、`EditOperations` 等），可以把文件和命令操作转发到别处（SSH、VM、宿主进程）。extension 也可以用同名 `registerTool` 覆盖内置工具（`examples/extensions/sandbox/index.ts:8-10`）。

### 4.2 system prompt 的组装

- `buildSystemPromptSections`（`core/system-prompt.ts:128-200`）按以下顺序生成各段：
  1. `preamble`：默认是 "You are an expert coding assistant operating inside pi…"（:156）；
  2. `tools`：工具的一行简介；
  3. `rules`：工具贡献的 guidelines 加通用规则；
  4. `docs`：Pi 自身文档的路径；
  5. `addendum`：来自 APPEND_SYSTEM.md；
  6. `project_context`：AGENTS.md 等上下文文件；
  7. `skills`：skill 清单；
  8. `cwd`；
  9. 自定义 sections。

  除 preamble 外，每段都包在同名 XML 标签里，作为 `SystemMessage.sections` 写进 transcript。
- `SYSTEM.md` 替换 preamble，`APPEND_SYSTEM.md` 追加内容。两者都是项目级 `.pi/` 优先（需要 trust），否则用全局 `~/.pi/agent/`（`core/resource-loader.ts:1213-1239`）。`before_agent_start` 可以用 `forceSystemPrompt` 整体替换（`system-prompt.ts:13`）。
- **上下文文件规则**（`core/resource-loader.ts:184-279`）：
  - 每个目录只取第一个命中的文件，优先级是 `AGENTS.override.md` > `AGENTS.md` > `AGENTS.MD` > `CLAUDE.md` > `CLAUDE.MD`。
  - 加载范围是全局 `~/.pi/agent/`，加上 cwd 到文件系统根的所有祖先目录，按从根到 cwd 的顺序排列。
  - 嵌套 git worktree 会对主仓库的同名文件去重。
  - 不支持 `@import`，不会按需加载子目录里的 CLAUDE.md，也没有 `/memory` 命令。
  - **上下文文件不受 project trust 约束**（`docs/security.md:57`）。
  - `--no-context-files` 可以整体关闭。
- 白标：preamble 和 docs 段写死了 "pi" 和 Pi 文档路径。PiArc 应该用 `SYSTEM.md`、`customPrompt` 或 `before_agent_start` 自己写 preamble。

### 4.3 session 存储

- JSONL，`CURRENT_SESSION_VERSION = 3`（`core/session-manager.ts:41`）。entry 类型有 session、message、thinking_level_change、model_change、usage、compaction、branch_summary、custom、label、session_info、custom_message、context_edit（:44-176）。每条 entry 用 `id/parentId` 组成树，leaf 指针表示当前位置。
- 存储路径是 `~/.pi/agent/sessions/--<cwd，把 / \ : 换成 ->--/<ts>_<id>.jsonl`（`session-manager.ts:589-597,1080`）。
- 文件延迟创建：出现第一条 user 或 assistant 消息才写盘（:1158-1170）；之后每条 entry 用 `appendFileSync` 追加，**不 fsync，也不加文件锁**（:1172-1186）。宿主并发只读是安全的，但不要写同一个文件。
- 会话操作在 RPC 里都有对应命令：new_session、switch_session、fork、clone、get_tree、get_entries、set_session_name（`modes/rpc/rpc-types.ts:22-74`）。**但没有 list_sessions**，宿主需要自己扫描会话目录。

### 4.4 compaction

- 默认值：`enabled: true`，`reserveTokens: 16384`，`keepRecentTokens: 20000`；分支摘要的 reserve 也是 16384（`core/settings-defaults.ts:9-17`）。
- 触发场景有三种：manual、threshold、overflow，对应事件 `compaction_start/end`（`core/agent-session.ts:209-220`）。
- extension 可以用 `session_before_compact` 改写或接管压缩（`examples/extensions/custom-compaction.ts`）。

### 4.5 settings 层级

- 只有两层：全局 `~/.pi/agent/settings.json` 和项目 `.pi/settings.json`，深合并，项目优先（`core/settings-manager.ts:143-146,193-194`），再叠加 CLI 参数。**没有企业托管策略层。**
- 项目级资源受 project trust 约束，包括 settings.json、mcp.json、extensions、skills、prompts、themes、SYSTEM.md、APPEND_SYSTEM.md（`core/trust-manager.ts:30-39`）。信任决定存在 `<agentDir>/trust.json`（:214）。
- **RPC 模式下的 trust 行为**：默认值 `defaultProjectTrust: "ask"`。RPC 启动时不会弹 trust 对话框（`main.ts:744-775`，hasUI 只在 interactive 下为真），结果是**按不信任处理**（`core/project-trust.ts:86-88`）。宿主要么自己做 trust UI，再传 `--approve/--no-approve`，要么写 trust.json，要么通过 extension 的 `project_trust` 事件处理。
- 白标：`package.json` 的 `piConfig.{name, configDir}` 可以改变 CLI 名称、配置目录（默认 `.pi`）和环境变量前缀（如 `PIARC_CODING_AGENT_DIR`）（`src/config.ts:577-586`，`docs/cli-integration.md:84-96`）。
- install telemetry 默认开启，但只影响 provider 归因头和交互模式下的安装上报；版本检查和 `report-install` 只在 interactive 模式里调用（`core/client-identity.ts:14`，`modes/interactive/interactive-mode.ts:1366`）。RPC 模式启动时的联网只有 pi.dev 模型目录刷新，可以用 `PI_OFFLINE` 关掉。

### 4.6 extension 机制

- **发现顺序**：项目 `.pi/extensions/`（需 trust）→ 全局 `~/.pi/agent/extensions/` → settings 或 packages 里配置的路径（`core/extensions/loader.ts:852-877`）。单文件、`index.ts`、或带 `pi.extensions` 字段的 package.json 三种形式都可以（:747-792）。
- **加载方式**：用 jiti 在**同一进程内**加载 TS（:575-584）。Bun 二进制里用 virtualModules 提供 `@earendil-works/*` 的导入。**没有隔离**，extension 和 Pi 拥有同样的权限。
- **内置扩展**有 llama.cpp、codemode、tool-search、mcp。后三个是 replaceable：第三方 extension 注册同名能力时会接管（`src/extensions/index.ts:7-14`）。
- **事件全集**，即 `ExtensionEvent` union（`core/extensions/types.ts:1441-1473`，订阅签名在 :1592-1675）：
  - 资源与信任：project_trust、resources_discover、mcp_servers_change
  - 会话：session_start、session_info_changed、session_before_switch、session_before_fork、session_before_compact、session_compact、session_compact_failed、session_shutdown、session_before_tree、session_tree
  - 上下文与请求：context（可替换 messages）、context_with_system、cache_warming_decision、before_provider_request（可改 payload）、before_provider_headers、after_provider_response、provider_stream_event
  - agent 生命周期：before_agent_start（可注入消息、改 system prompt）、agent_start、agent_end、agent_before_settle（可以要求继续）、agent_settled
  - turn、消息、工具执行：turn_start、turn_end、message_start/update/end、tool_execution_start/update/end
  - 其他：ui_prompt_start/end、model_select、thinking_level_select、user_bash（用户的 `!` 命令，可替换执行）、input（可 transform 或 handled，`types.ts:1185-1187`）、tool_call、tool_result
- **tool_call 拦截**：
  - 可以阻断：返回 `{block, reason, terminate}`（`types.ts:1405-1414`）。
  - 可以改写：**直接修改 `event.input`**，后续 handler 会看到修改，修改后**不再做 schema 校验**（`types.ts:1250-1255`）。
  - handler 抛异常时，按阻断处理（fail-closed，`core/agent-session.ts:675-680`）。
  - 多个 handler 中只要有一个返回 block 就短路（`core/extensions/runner.ts:1249-1266`）。
  - 嵌套调用（codemode 脚本、`executeTool`）同样触发，带 `parentToolCallId`（`agent-session.ts:752-753`）；MCP 工具也一样（`docs/mcp.md:252`）。
  - tool_result 可以覆盖返回的 content 等字段。
- **可注册的东西**（`types.ts:1671-1917`）：
  - 工具：registerTool，可以覆盖内置工具；
  - 命令与输入：registerCommand（斜杠命令）、registerShortcut、registerFlag；
  - 渲染：registerMessageRenderer、registerEntryRenderer、registerToolRenderer、registerMarkdownTransformer，这几个**只在 TUI 生效**；
  - 模型：registerProvider/unregisterProvider、registerVirtualModel（路由型虚拟模型）、registerMcpServer；
  - 会话与运行时：sendMessage、sendUserMessage、appendEntry、setActiveTools、setModel、setThinkingLevel、exec、跨扩展的 `events` 总线。
- **UI**（`ExtensionUIContext`，`types.ts:149-300`）：select、confirm、input、editor、notify、setStatus、setWidget、setFooter、setHeader、custom（自定义 TUI 组件/overlay）、setEditorComponent 等。
  - **RPC 模式只支持其中一部分**：select、confirm、input、editor、notify、setStatus、setWidget（仅字符串行）、setTitle、set_editor_text（`modes/rpc/rpc-mode.ts:138-269`）。
  - custom、footer、header、自定义编辑器和组件型 widget 在 RPC 下都是空操作（`rpc-mode.ts:164-304`）。

### 4.7 skills、prompt templates、packages

- **skills**：
  - 格式是 `SKILL.md` 加 frontmatter（`name`、`description`、`disable-model-invocation`）（`core/skills.ts:66-71`）。
  - 发现位置：`~/.pi/agent/skills`、`.pi/skills`，以及从 cwd 向上到 git 根的每一层 `.agents/skills`（`skills.ts:458-463`，`core/package-manager.ts:474-492`）。默认不读 `.claude/skills`，也不支持 `allowed-tools`。
  - system prompt 里只列 skill 清单，模型需要时用 read 工具加载；用户可以用 `/skill:name` 显式调用。
- **prompt templates**：`.pi/prompts/*.md`、`~/.pi/agent/prompts/*.md`，作为斜杠命令展开，相当于 Claude Code 的 commands。默认不读 `.claude/commands`。
- **packages**：
  - 来源支持 `npm:<spec>` 和 git（`core/package-manager.ts:1486-1500`），分别安装到 `<agentDir>/npm` 和 `<agentDir>/git`（:2099,2180）。
  - 包通过 package.json 的 `pi` 字段声明 extensions、skills、prompts、themes。
  - **安装依赖外部 npm 可执行文件**（`npmCommand`，:1787-1820）。所以 Bun 单文件 sidecar 装不了 npm 包，宿主要自带 npm，或者自己做包分发。

### 4.8 RPC 模式的进程模型

- 一个进程同一时刻只有一个活动会话（`AgentSessionRuntime`），可以切换会话，但不能并发跑多个。
- 启动时 `takeOverStdout()` 接管 stdout，防止第三方 `console.log` 污染协议流（`rpc-mode.ts:55`）。帧格式是严格 LF 分隔的 JSONL，不能用 Node readline，因为 readline 会把 U+2028/2029 也当换行（`modes/rpc/jsonl.ts:8,33`）。
- 所有 `AgentSessionEvent` 原样转发（`rpc-mode.ts:355-357`），类型包括 agent/turn/message/tool 事件、queue_update、compaction_*、auto_retry_*、entry_appended、thinking_level_changed 等（`core/agent-session.ts:196-240`）。
- stdin 关闭即有序退出（`rpc-mode.ts:805`）。
- 官方 RPC 入口是 `src/rpc-entry.ts`，内容就是调用 `main(["--mode","rpc",...])`。npm 包把它导出为 `@earendil-works/pi-coding-agent/rpc-entry`（esbuild bundle 版本）。
- **`main(args, { extensionFactories })` 是公开导出的**（`src/index.ts:416`，`src/main.ts:571-578`）。PiArc 可以写自己的 sidecar 入口：stock RPC 协议保持不变，同时静态注入 PiArc 的 extension，运行时不需要 jiti，也不依赖磁盘上的 extension 文件。
- **协议缺口**【核实】：
  - 没有版本握手；
  - 没有 login 或 logout 命令，`pi auth` 只有 `check/print-api-key/print-bearer-token`（`cli/auth-command.ts:5,52-61`）；
  - 没有 list_sessions；
  - 没有按请求取消，只有 `abort`、`abort_bash`、`abort_retry` 这类语义命令。
- **extension 和宿主之间的双向通道**【核实】：
  - extension → 宿主：`pi.appendEntry(customType, data)` 会触发 `entry_appended` 事件，经 RPC 发给宿主（`agent-session.ts:3466-3471`）；`ctx.ui.setStatus/setWidget/notify` 会变成 `extension_ui_request` 通知；工具的 `onUpdate` 会变成 `tool_execution_update`。
  - 宿主 → extension：RPC `prompt` 发送 `/命令 参数`，会执行 extension 注册的命令（`agent-session.ts:2101-2102`）；也可以用对话框的 response 回应。

---

## 5. chord（子代理读码，结论已抽查）

- **定位**：带类型的宿主运行时（`packages/chord/package.json:4`，`README.md:3-11`）。
  - 对象由 `host.serve(type, factory)` 注册，身份是 `(type, canonicalInput, principal)`，调用方只拿到 reference（`docs/spec.md:12-23`）。
  - 契约用 TypeBox schema 描述，兼容规则是版本相同、提供方覆盖消费方（`spec.md:27,60-68`）。
  - 热重载走 load → prepare → gate → commit → retire，最多同时保留两个代码版本（`spec.md:198-217`）。
  - 状态是单写者的 cell，用 delta ops 复制给消费方，没有 CRDT（`src/cell.ts:200-235`，`src/delta/README.md:126-131`）。
- **线协议**：JSON 帧（`src/wire.ts:60-165`），`PROTOCOL_VERSION = 4`【已抽查，`wire.ts:24`】。
  - 版本不一致直接断开，不做协商（`src/connection.ts:833-835`）。
  - 传输只有 memory、Node IPC（`child_process.fork` 的 ipc 通道）、WebSocket 三种（`src/link.ts:240-415`）。没有 stdio。
- **不适合当原生宿主到 Pi 进程的协议层**【核实加判断】：
  1. coding-agent 根本不用 chord，Pi 侧没有可以直接调用的契约。
  2. spec 写的是"描述 src 中的运行时"（`spec.md:3`），字段级定义只在 TS 源码里。契约里嵌着 TypeBox schema 和自定义子类型算法，delta 的字符串偏移按 UTF-16 计数。用 Rust/Swift 实现对端成本高。
  3. 协议在 1.3.0 一个版本里从 v2 升到 v3 再到 v4（`packages/chord/CHANGELOG.md:22-36`），3 个版本全部带 Breaking。
- 在 Pi 里只有 durable 和 env 在用，用到的是 Context、delta、sqlite（`node:sqlite`）这些基础件。
- **结论**：用 coding-agent 的 JSONL RPC。chord 的 delta 编码格式可以作为将来做"视图增量同步"的参考。

## 6. durable（子代理读码）

- **模型**：Harness/Session 原子提交三类东西：不可变 Entry、Task 记录、Chord 文档。只有提交后的状态可见（`packages/durable/docs/spec.md:43-44`）。
  - 实体有 Conversation（可 fork）、Entry（pi.user/assistant/tool-result/compaction…）、Document（pi.agent/pi.live/pi.usage…）、Task（带 checkpoint 的状态机）、Submission（幂等的 requestId）。
  - 存储后端有 memory、IndexedDB、SQLite（node 或 Cloudflare）、JSONL（全量常驻内存）（`README.md:761-767`）。
  - 一个存储同一时刻只能被一个进程持有，没有跨进程锁（`README.md:790`）。
  - 恢复语义是"效果三明治"：先提交 intent，再执行外部效果，最后提交结果。只有声明了 `replay: "safe"` 的工具在重启后会重跑（`README.md:277`）。
- **和 coding-agent session 的关系**：没有关系。两者格式互不兼容，也没有转换层。coding-agent 不 import durable。agent-core 1.0.0 把原来的实验 harness 迁到了 durable（`packages/agent/CHANGELOG.md:35`）。
- **不在主路径上**。从 README 的大量篇幅（Cloudflare DO 的 onWake 和 alarm）看，它面向会被驱逐、需要崩溃恢复的宿主【推测：消费者是 pi-chat 一类产品】。
- **对 PiArc**：先不用。PiArc 需要的"崩溃后恢复会话"，用 coding-agent 的 append-only JSONL 加 `--session` 重新打开就够了。

## 7. mcp、codemode、env（子代理读码，部分已抽查）

### 7.1 pi-mcp

- 自己写的实现，不依赖官方 SDK。OAuth 部分改编自官方 TS SDK v1.29.0（`packages/mcp/README.md:3,112`）。
- **传输**：stdio 和 Streamable HTTP（支持 session id、GET 流、Last-Event-ID 续传）。**不支持旧版 SSE**（`README.md:132`）。
- **协议版本**：最高 `2025-11-25`【已抽查，`src/protocol/types.ts:4`】。
- **能力**：

| 能力 | 状态 |
|---|---|
| tools、resources（list/templates/read）、roots、progress、cancel、logging、list_changed | 支持 |
| resources/subscribe、prompts 专用 API、sampling、elicitation | 不支持 |

- **OAuth**：RFC 9728/8414 发现、PKCE S256、动态客户端注册、刷新、step-up、iss 校验。包本身不负责打开浏览器，也不管凭据存哪里（`README.md:110`）。
- **coding-agent 集成**（内置扩展 `src/extensions/mcp/`）：
  - 配置文件是 `~/.pi/agent/mcp.json` 和 `.pi/mcp.json`（后者需要 trust）。
  - 工具名格式 `mcp__<server>__<tool>`。
  - token 以 0600 权限明文存在 `~/.pi/agent/mcp-auth.json`。
  - 默认 exposure 是 `codemode`：MCP 工具不直接声明给模型，只能在 codemode 脚本里调用。可选值还有 `deferred`（经 tool_search 加载）、`direct`、`hidden`（`docs/mcp.md:191-222`）。
  - `autoEnableCodemode` 默认为 true【已抽查，`src/extensions/mcp/config.ts:28`】。
  - 用 SDK 嵌入时内置扩展**不会自动加载**（`docs/sdk.md:116`）。

### 7.2 pi-codemode

- quickjs-wasi：每次执行开一个 worker 线程，跑一个独立的 QuickJS WASM 实例。脚本里没有 fs、网络、timers、process，只能调用注入的 `tools.*` 和 `models.*`（`packages/codemode/README.md:56,362`）。
- 资源上限：每个 VM 堆 256 MB，同时最多 2 个 worker（`packages/coding-agent/src/extensions/codemode/execute.ts:56-63`）。
- 在 coding-agent 里注册时 `defaultActive: false`【已抽查，`src/extensions/codemode/index.ts:44`】。但只要接入 MCP 就会被自动激活。
- 嵌套工具调用不进入 LLM 上下文，但会触发 tool_call/tool_result（带 parentToolCallId）。
- 打包时需要额外提供 `quickjs.wasm` 和 worker entry（`src/config.ts:494-525`）。

### 7.3 pi-env

- durable `ExecutionEnv` 的远程实现，coding-agent 不用。
- daemon 是 Rust 写的（edition 2024，依赖 notify、ignore），经 SSH 启动，用 stdin/stdout 二进制帧通信（`packages/env/docs/protocol.md:3-35`）。
- 提供文件、listFiles（遵守 gitignore）、exec、watch、pty 操作。pty 不支持 Windows（`protocol.md:141`）。
- 对 PiArc 的价值【推测】：它的 listFiles、watch、pty 实现可以给 Rust 宿主做参考。

---

## 8. 构建与分发

### 8.1 官方产物（核实）

- **standalone 二进制用 Bun compile 生成，不用 Node SEA**（仓库里 grep 不到 postject 或 sea-config）。
  - 命令见 `scripts/build-binaries.sh:117-137`：

    ```
    bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv \
      --target=bun-<platform>[-baseline] ./dist/bun/cli.js \
      ./src/utils/image-resize-worker.ts ./src/extensions/codemode/worker.ts
    ```

  - x64 目标用 `-baseline`。worker 必须作为显式 entry 传入，否则不会被嵌进二进制。
  - CI 固定用 Bun 1.3.14（`.github/workflows/build-binaries.yml`）。
- **目标平台**：darwin-arm64、darwin-x64、linux-x64、linux-arm64、windows-x64、windows-arm64（`build-binaries.sh:13,114`）。
- **二进制旁边必须带的资源**（`build-binaries.sh:142-160`）：
  - `package.json`：用来读 VERSION 和 piConfig；
  - README、CHANGELOG；
  - `photon_rs_bg.wasm`：图片缩放；
  - `theme/*.json`、`assets/*`、`export-html/`；
  - `docs/`、`examples/`：system prompt 里引用了它们的路径；
  - `native/<os>/prebuilds/<os-arch>/*.node`：pi-tui 的剪贴板和修饰键 helper，22–52 KB。
- 运行时按 `dirname(process.execPath)` 找这些资源（`src/config.ts:393-404,413-477`），也可以用 `PI_PACKAGE_DIR` 覆盖。
- **tui 的 native addon 是可选的**：加载失败时 try/catch 回退（`packages/tui/src/native-platform.ts:28-52`），只服务于 TUI 的剪贴板和修饰键，**RPC sidecar 不需要它**。
- **npm 分发**：esbuild 把 coding-agent 打成 `dist/bundle`（`scripts/build-coding-agent-bundle.mjs`）。
  - 只允许 `@silvia-odwyer/photon-node`、`jiti` 和若干可选原生加速包作为 external（:18-28,82）。
  - `target: node22.19`（:94）。
  - bin 指向 `dist/bundle/cli.js`。
  - 官方安装器用 `install-lock/` 锁定传递依赖（根 README "Supply-chain hardening"）。
- **Node 版本**：所有包 `engines.node >=22.19.0`。
- **从源码构建**：`npm run build` 会联网刷新模型数据；离线构建必须用 release 源码包，或者自己 hydrate 模型数据（根 README "Building standalone binaries from release source"）。

### 8.2 本机实测（Darwin 25.5 arm64）

| 项 | 结果 | 方法 |
|---|---|---|
| npm 安装形态的磁盘占用 | 148 MB（含全部 node_modules）。其中 bundle 9.0 MB，pi-ai dist 6.4 MB，photon-node 2.2 MB，jiti 1.7 MB，quickjs-wasi 1.5 MB；@anthropic-ai/sdk、@google/genai、@aws-sdk 等是 bundle 已经内联但仍被安装的依赖 | `du` 统计 `~/.pi/agent/install/releases/1.4.0` |
| Node 本体 | 119 MB（v24.14.1 arm64） | `ls` |
| Node sidecar 最小集（估算） | node 119 MB + bundle 9 MB + photon 2.2 MB + jiti 1.7 MB + quickjs-wasi 1.5 MB ≈ 134 MB；加上 docs/examples 约 138 MB | 推算，不含 rg/fd |
| Bun compile 单文件 | 98.8 MB；gzip 42.8 MB，xz 28.6 MB | 用 Bun 1.4.4 编译已安装的 `dist/bundle/rpc-entry.js`，0.5 s 完成。和官方流程不同：官方编译 `dist/bun/cli.js` 并嵌入 worker 和 quickjs wasm，所以体积只能当量级参考 |
| `pi --offline --version` | 0.20–0.26 s | `/usr/bin/time`，3 次 |
| RPC 冷启动到首个 `get_state` 响应（Node 24 + bundle） | 250–300 ms，RSS 约 120 MB | 自写脚本 spawn `pi --offline --mode rpc --no-session`，配置目录为空，内置扩展加载/不加载两种都测了，3 次 |
| 同上（Bun compile 版） | 首次 1849 ms（推测是首次执行的系统校验开销），之后约 355–364 ms，RSS 约 90 MB | 同一脚本 |

测量脚本：
- `docs/research/scripts/measure-rpc.mjs`
- `docs/research/scripts/measure-rpc-ext.mjs`

注意：测量时配置目录为空，没有模型和凭据，没有 MCP server，没有用户 extension。真实场景下会叠加模型目录加载、MCP 后台连接（首个 prompt 最多等 10 s，`docs/mcp.md:100`）、extension 加载等开销。

### 8.3 打进 .app 的可行性评估

- **可行**【核实加实测】。两条路线：
  - **A. Bun compile**：单文件约 99 MB，压缩后约 30–43 MB，内存更低。需要注意：
    - 资源要放在二进制旁边，或通过 `PI_PACKAGE_DIR` 指定；
    - codemode 依赖嵌入的 `quickjs.wasm`（`setEmbeddedQuickJSWasmPath`），要走官方的 `dist/bun/cli.js` 入口；
    - 装不了 npm 型的 Pi package；
    - extension 通过 jiti 加 virtualModules 加载。
  - **B. 内置 Node 加 bundle**：约 135 MB，启动略快。npm、npx 可以复用同一个 Node，Pi package 和 MCP 的 stdio server（很多是 `npx` 启动的）都更顺。
- **建议选 B**，或者 B 加一个独立的 Node 运行时目录。理由是 MCP 生态普遍依赖 `npx`，Pi packages 依赖 npm，codemode 和 image worker 在 Node 下就是官方的 `bundled-node` 路径（`src/config.ts:500-525`）。如果对体积敏感，再评估 A。
- **签名和公证**【推测，需要验证】：
  - Node 和 Bun 在 hardened runtime 下通常需要 `com.apple.security.cs.allow-jit` 等 entitlement；
  - 内嵌的 `.node` 和 rg/fd 也要逐个签名。
- **rg/fd** 要预置，否则 grep 和 find 首次使用时会从 GitHub 下载（`utils/tools-manager.ts:350-401`）。
- **Windows**：
  - bash 工具默认找 Git Bash，可以选用 PowerShell 工具（`docs/windows.md`）；
  - 进程树清理在 MCP stdio 中用 taskkill（`packages/mcp/src/transports/stdio.ts:19-27`）。

---

## 9. 与 Claude Code 的能力缺口

类别说明：
- **E**：用 Pi extension 可以实现，不改核心。
- **C**：需要改 Pi 核心或依赖上游。
- **H**：需要宿主侧（Rust/Swift）实现，或者宿主做更合适。

| # | 能力 | Pi 现状 | 判断 | 依据与建议 |
|---|---|---|---|---|
| 1 | 子 agent（Task 工具） | 不内置（根 README 写明跳过） | **E** 加 H（UI） | 官方示例 `examples/extensions/subagent/index.ts:298,343-344` 为每个子任务 spawn 一个 `pi --mode json -p --no-session` 子进程，支持并行、流式、abort 和用量统计。子进程的事件可以通过工具的 `onUpdate` 变成 `tool_execution_update` 传给宿主。代价是每个子 agent 约 120 MB RSS【实测】。在同一个 Node 进程里用 SDK `createAgentSession` 跑多个会话应该可行【推测：coding-agent 没有 `process.chdir`，cwd 按会话传递】，可以省内存 |
| 2 | Plan mode | 不内置 | **E** | 官方示例 `examples/extensions/plan-mode/index.ts`：`setActiveTools` 收起 edit 和 write（:108-112），在 `tool_call` 里拦截非白名单 bash（:164-171），用 `/plan` 命令和 `--plan` flag 切换。审批 UI 可以用 RPC 的 select/confirm，也可以宿主原生做 |
| 3 | 权限系统（allow/deny 规则、模式、逐次确认） | 没有（根 README "Permissions & Containerization"） | **E**（拦截）加 **H**（规则存储、UI、审计） | 拦截基础已经够用：`tool_call` 可以阻断和改写参数，handler 抛异常时 fail-closed，预检串行，嵌套调用和 MCP 调用都覆盖到。官方示例有 `permission-gate.ts`、`protected-paths.ts`、`confirm-destructive.ts`。需要注意：`user_bash`（用户的 `!` 命令）要单独拦截；改写后的参数不会重新校验；extension 本身没有隔离，权限 extension 和其他 extension 是同等权限 |
| 4 | Hooks（settings 里配置 shell 命令） | 没有配置式 hooks，只有 TS extension 事件 | **E** | 写一个"hooks 兼容 extension"，按事件映射执行 shell：PreToolUse→`tool_call`，PostToolUse→`tool_result`，UserPromptSubmit→`input`/`before_agent_start`，Stop→`agent_before_settle`（可以要求继续），PreCompact→`session_before_compact`，SessionStart/End→`session_start`/`session_shutdown`。SubagentStop 和 Notification 没有直接对应 |
| 5 | Todo（TodoWrite） | 不内置 | **E** | 官方示例 `examples/extensions/todo.ts` 把状态存在工具结果的 details 里，所以切分支时状态自动正确。宿主可以从 `tool_execution_end` 拿到状态，再原生渲染 |
| 6 | Skills | **已有**，形态接近 | 配置或 E | SKILL.md 格式兼容（name、description、disable-model-invocation），但目录不同（`.pi/skills`、`.agents/skills`、`~/.pi/agent/skills`），默认不读 `.claude/skills`，不支持 `allowed-tools`（`core/skills.ts:66-71,458-463`）。用 settings 的 `skills` 路径或 `resources_discover` 事件就能接入 `.claude/skills` |
| 7 | 自定义斜杠命令 | prompt templates 加 extension 命令 | 配置或 E | 默认不读 `.claude/commands`，可以加路径兼容 |
| 8 | Plugins/marketplace | Pi packages（npm/git） | **H** 加 E | 形态不同，和 Claude 插件格式不兼容【推测】。安装依赖 npm（`core/package-manager.ts:1787`）。PiArc 可以在宿主侧做市场 UI，底层复用 `pi install`，或者自己做包管理 |
| 9 | Checkpoint 与 rewind | 对话层面**已有**（JSONL 树、fork、clone、tree）；文件层面没有 | **H**（推荐）或 E | 示例 `git-checkpoint.ts:20-25` 在每个 turn 开始时 `git stash create`，非 git 目录用不了。建议 Rust 侧做文件快照，按 session entry id 建索引。extension 在 `turn_start` 和 `tool_call(write/edit/bash)` 时通知宿主；也可以用 `EditOperations`/`WriteOperations` 把写操作改走宿主 |
| 10 | Memory（CLAUDE.md） | **部分有**：全局加祖先目录，每个目录一个文件 | **E** | 不支持 `@import`，不会按需加载子目录的 CLAUDE.md，没有 `/memory`（`core/resource-loader.ts:184-279`）。用 `before_agent_start`/`context_with_system` 补。注意上下文文件不受 trust 约束 |
| 11 | MCP | **已有**（内置扩展） | E/C | 缺 SSE、prompts、sampling、elicitation、resource subscribe。prompts 可以在 extension 层基于通用 `request()` 做成斜杠命令。elicitation 和 sampling 要扩展 pi-mcp 的 handler（`client.ts:252,264`），也可以替换内置 mcp 扩展（replaceable） |
| 12 | WebFetch、WebSearch | 没有（src 里 grep 不到） | **E** | registerTool 即可 |
| 13 | AskUserQuestion | 不内置 | **E** | 示例有 `question.ts`、`questionnaire.ts`。RPC 只支持 select/input/confirm/editor，复杂表单要走自定义通道 |
| 14 | 后台 shell（run_in_background、BashOutput、KillShell） | 没有。bash 每次调用都 spawn 新 shell，没有持久会话（`bash.ts:112`） | **H**（推荐）或 E | 交互式终端和 PTY 适合放在 Rust 侧（可以参考 pi-env daemon 的 pty），再用 extension 工具桥接 |
| 15 | 登录 UI（OAuth、API key） | 只在 TUI 的 `/login` 里有；RPC 没有对应命令 | **H** 加自定义 sidecar 入口 | 用 SDK 时可以注入 `modelRuntime` 并调用 `ModelRuntime.login(provider, type, AuthInteraction)`（`core/model-runtime.ts:834-846`，`core/sdk.ts` 的 `modelRuntime` 选项），把 auth_url、device_code 事件转给宿主。ModelRegistry 没有对 extension 暴露 login【推测】。直接写 auth.json 会和内部格式耦合 |
| 16 | 凭据安全存储（Keychain、Credential Manager） | auth.json 和 mcp-auth.json 是 0600 明文 | **H**，可能需要 C | pi-ai 有 `CredentialStore` 接口可注入；coding-agent 的 `AuthStorage` 能否注入自定义后端，我没有核实。MCP 有 backend 注入点（`src/extensions/mcp/oauth.ts:147`） |
| 17 | 会话列表与搜索 | RPC 没有 list | **H** | 宿主直接读 `~/.pi/agent/sessions/--cwd--/*.jsonl`（v3 格式） |
| 18 | 多会话并发 | 一个 RPC 进程一个活动会话 | **H** | 用进程池（每个约 120 MB），或者自写 SDK sidecar 在单进程里托管多个 AgentSession【推测可行】 |
| 19 | 企业托管策略 | 没有，只有全局加项目两层 | **H** | 宿主生成 settings 或在启动参数里强制 |
| 20 | OS 级沙箱 | 没有；示例有 sandbox（基于 @anthropic-ai/sandbox-runtime）和 Gondolin（VM） | **H** 加 E | macOS seatbelt、Windows AppContainer 放在宿主或用 BashOperations 包一层 |
| 21 | 富 UI 扩展（diff 审阅、自定义面板） | TUI 组件 API 在 RPC 下不可用 | **H** | 宿主原生实现。extension 通过 `appendEntry` 触发的 `entry_appended`，或工具 details 传结构化数据 |
| 22 | 协议版本协商 | 没有 | **H** | 锁定 Pi 版本，启动后用 `get_state`/`get_commands` 探测能力，宿主侧做适配层 |
| 23 | Output styles、system prompt 定制 | **已有**：SYSTEM.md、APPEND_SYSTEM.md、before_agent_start | 现成 | — |
| 24 | Compaction、自动重试、用量统计 | **已有** | 现成 | `core/settings-defaults.ts:9-27`，RPC `get_session_stats` |
| 25 | NotebookEdit、IDE 集成 | 没有 | E / H | — |

**小结**：
- 绝大多数 Harness 能力（1–7、10–13）用 extension 就能实现，官方 examples 是现成的起点。
- 真正**必须改 Pi 核心**的地方很少：MCP elicitation/sampling、凭据后端注入可能需要动核心，其余都可以靠 SDK 入口或 replaceable 扩展绕开。
- 宿主侧（H）的工作量主要在：登录、凭据、会话管理、进程池、文件 checkpoint、沙箱、原生 UI、协议适配。

---

## 10. 许可证、发布节奏、API 稳定性

- **许可证**：MIT，`Copyright (c) 2025 Mario Zechner`（`LICENSE:1-3`），所有包都是 MIT。pi-mcp 内含改编自 MCP 官方 TS SDK 的 MIT 代码，附了许可证（`packages/mcp/LICENSES/`）。商用、闭源集成、fork 都没有障碍。
- **发布节奏**【核实，用脚本统计 CHANGELOG，脚本见 `docs/research/scripts/count-breaking.mjs`】：
  - coding-agent 从 0.10.0（2025-11-25）到 1.4.0（2026-10-21）共 290 个版本。
  - 自 2026-06-01 起 51 个版本，约每周 2.5 个。
  - 1.x 系列 21 天内发了 9 个版本（1.0.0 于 10-01，1.4.0 于 10-21）。
  - 所有包同版本号联动发布（`scripts/sync-versions.js`）。
- **Breaking Changes 频率**（自 2026-06-01，按 `### Breaking Changes` 下的条目数）：

| 包 | 带 Breaking 的版本数 | Breaking 条目数 | 进入 1.x 后 |
|---|---|---|---|
| coding-agent | 9 | 33 | 1.0.3、1.2.0，共 5 条 |
| pi-ai | 14 | 34 | 1.0.3、1.1.0、1.3.0、1.4.0，共 6 条 |
| agent-core | 7 | 15 | 1.0.0，1 条 |
| chord | 3 个版本全部 | — | 协议 v2→v4 |
| durable | 5 | — | 标注 Experimental，1.4.0 的 schema 迁移不可回滚 |

  典型例子：
  - coding-agent 1.2.0 把 `before_agent_start` 改成 union 类型，并修改了 `sendUserMessage` 的约束；
  - pi-ai 0.86.0 把 provider 的输入从 `Context` 改成 `TranscriptContext`；
  - pi-ai 0.80.x 重组了入口和 OAuth API；
  - coding-agent 1.2.0 删除了实验性的 server、client、protocol 包。
- **RPC 协议历史上也有 breaking**：例如改成严格 LF 分帧、`get_commands` 字段改名、slash command 的 source 字段改名（`packages/coding-agent/CHANGELOG.md:3081,3360,3874`）。
- **上游治理**：新贡献者的 issue 和 PR 默认自动关闭，需要 maintainer 回复 `lgtm` 才能提 PR；核心坚持极简（`CONTRIBUTING.md`）。
- **对"跟随上游"策略的影响**：
  1. **锁定精确版本**，整套 `@earendil-works/*` 同版本一起升级，用 install-lock 或自己的 lockfile。
  2. **只依赖三个面**：RPC JSONL 协议、`main(args, {extensionFactories})`、ExtensionAPI。不要深度 import 内部模块。
  3. **宿主侧建协议适配层**，每次升级用录制的 RPC 事件流做回归测试。建议按月或按需升级，不追每个版本。
  4. **尽量不 fork 核心**。必须改的地方先维护成小补丁集，同时去上游 issue 争取 hook 点；考虑到贡献门槛，要预留长期自维护补丁的成本。
  5. **白标走官方支持的 `piConfig`**（`docs/cli-integration.md:84-96`）。需要先决定 PiArc 是否和用户已装的 pi 共用 `~/.pi` 配置。共用能互通 skills 和 extension，但会被对方的设置和 extension 影响。

---

## 11. 架构建议（供决策）

1. **进程模型**：Rust 宿主按工作区或窗口启动 Pi sidecar，用进程池方式管理，每个会话一个进程，后续可以复用。sidecar 入口是 PiArc 自己写的 `piarc-agent.ts`：

   ```ts
   import { main } from "@earendil-works/pi-coding-agent";
   import { piarcExtensions } from "./extensions";
   main(["--mode", "rpc", ...args], { extensionFactories: piarcExtensions });
   ```

   协议保持 stock RPC，PiArc 的 Harness 扩展静态打进 bundle。【核实：`main` 是公开导出，支持 `extensionFactories`；rpc-entry 就是这样调用的。】
2. **协议层**：用 Pi 的 RPC JSONL，Rust 端严格按 LF 分帧。不要用 chord。宿主自定义的数据流有两条：
   - extension → 宿主：custom entry（会产生 `entry_appended` 事件）、tool details、`extension_ui_request`；
   - 宿主 → extension：`/piarc:*` 命令，通过 RPC `prompt` 发送。

   如果后续发现 RPC 不够用，比如多会话复用一个进程、登录流程，再升级为"SDK 加自定义协议"的 sidecar。这样仍然复用 Pi 的 AgentSession，不改核心。
3. **登录与凭据**：在 sidecar 里加一个 `/piarc:login` 命令，或者自定义入口，调用 `ModelRuntime.login`，把 `auth_url`、`device_code` 转给宿主显示。凭据持久化先沿用 auth.json，再评估改成 Keychain 后端。**Claude 订阅 OAuth 的合规问题要单独决策。**
4. **Harness 扩展包**（E 类）：subagent、plan、permissions、hooks 兼容、todo、web tools、ask-user、`.claude/*` 兼容（skills、commands、CLAUDE.md @import）。都从 Pi 官方 examples 改造，放在 PiArc 仓库里维护。
5. **宿主侧**（H 类）：
   - 文件 checkpoint（快照按 entry id 索引）；
   - 会话索引；
   - 权限规则存储和审计 UI；
   - 沙箱；
   - PTY 后台 shell；
   - 预置 rg/fd；
   - project trust UI；
   - Node 运行时、签名和公证。
6. **不要做的事**：不引入 durable、env、chord；不依赖 TUI 组件 API；不深度 import pi 内部模块。

---

## 附：子代理原始结论的可信度说明

- 第 2 节（pi-ai）、第 5 节（chord）、第 6–7 节（durable、env、mcp、codemode）的行号证据来自子代理读码。
- 我逐项复核过的：Anthropic OAuth 伪装、MCP 协议版本、`autoEnableCodemode`、codemode `defaultActive:false`、pi.dev catalog URL 和刷新间隔、chord `PROTOCOL_VERSION=4`、coding-agent 删除 chord 依赖、durable 的 Experimental 标注。
- 其余行号没有逐条复核，可能有 ±几行的偏差。

---

## 版本差异：v1.5.2

T06 锁定 Pi v1.5.2（npm 2026-11-10 发布，`latest` 标签，`reference/pi` 检出 tag `v1.5.2`，commit `b4afdddf44e0`）。差异写在本文末尾，而不是另起 `pi-v1.5.2-baseline.md`：架构第 5.7 节的升级流程以本文为基线文档，v1.4.0 → v1.5.2 只有两个次版本，第 0–11 节的结构与结论仍然成立，单独成文会让两份文档长期重复。本节的 `文件:行号` 指向 v1.5.2，路径相对 `reference/pi/packages/`。

### 锁定方式

- `agent-host/package.json` 精确锁定 `@earendil-works/pi-coding-agent`、`pi-ai`、`pi-agent-core`、`pi-mcp` 为 `1.5.2`；`packages/testkit` 的 `pi-ai` 已是 `1.5.2`（T05）。传递依赖 `pi-tui`、`pi-codemode`、`pi-schema`、`pi-telemetry` 由 coding-agent 精确依赖，lockfile 中全部为 `1.5.2`（`npm ls --all` 核对，无第二个版本）。
- `pi-schema` 是 v1.5.0 起的新包：pi-ai 与 agent-core 用它校验工具参数。

### 各包 Breaking Changes 对 PiArc 的影响

| 版本 | 包 | 变化 | 对 PiArc 的影响 |
|---|---|---|---|
| 1.5.0 | pi-ai、agent-core | 主入口不再导出 TypeBox（`Type`、`Static`、`TSchema`），`typebox` 不再是依赖；`Tool.parameters`、`AgentTool.parameters` 接受任意 JSON Schema；工具参数统一由 pi-schema 校验并做类型强制转换（MCP 工具也一样），校验失败的文字改为 pi-schema 的格式（`- path: missing`） | Harness Kit 与 T07 的规范名工具用 pi-schema 的构造器或直接从 `typebox` 导入定义参数；L3 对齐（T30）比较工具错误文本时要按新格式；`Type.Refine()`、codec 等 TypeBox 专有特性不再生效，不能依赖它们做参数约束 |
| 1.5.0 | coding-agent | 工具参数校验改用 pi-schema（同上）；"Tightened system prompt" | PiArc 自写 preamble（第 4.2 节），只影响 L3 抽样基线 |
| 1.5.1 | coding-agent | 自定义 `GrepOperations.readFile` 不再用于上下文行：grep 直接取 ripgrep 的上下文输出，不再自己读文件 | T07 的 Operations 委托不能只替换 `readFile`：grep 要整体委托（覆盖工具的 `execute()`，或注册同名工具），否则上下文行绕过 Core |
| 1.5.1 | pi-ai、coding-agent | `openai-completions` 在没有工具但历史中有工具调用时省略 `"tools": []` | mock provider 不要求 `tools` 字段，无影响；对接要求该字段的旧代理时用 `compat.requiresToolsWithToolHistory` |
| 1.5.0 | pi-ai | `appendGrammarToolInputJsonDelta()` 签名变化 | PiArc 不使用，无影响 |

agent-core 1.5.1–1.5.2、pi-mcp 1.5.0–1.5.2 没有 Breaking Changes。

### 非破坏性但需要注意的变化

- **Anthropic message threads**（pi-ai 1.5.1）：带 `sessionId` 的请求只发新增消息、由服务端接续上文。默认只对 `api.anthropic.com` 上的 `anthropic` provider 开启，自定义端点不受影响；会话结束要调用 `cleanupSessionResources(sessionId)`，`AgentSession.dispose()` 已经调用（`coding-agent/src/core/agent-session.ts:1477-1498`）。
- **`cacheWarming` 默认改为 `"idle"`**（coding-agent 1.5.1）：会话空闲时最多 30 分钟内自动发请求保温提示缓存，会产生费用。模型配置了 `promptCache` 才会保温。PiArc 生成 `pi/settings.json` 时要显式决定该值（登记事项 I16）。
- **pi-mcp 新增可复用部件**（1.5.1）：`createMcpToolName()`、`validateMcpServerConfig()`、`limitMcpContent()`、OAuth 两段式登录（`@earendil-works/pi-mcp/oauth`）与 `PipeTransport`。T36 的共享连接池可以直接用它们。
- **pi-ai 新增 `lazy-oauth`、`lazy-bedrock-provider` 子路径导出**（1.5.1）：给按动态 import 拆分的 Node bundle 用。PiArc 的 Agent Host 打成单文件 bundle，不调用 OAuth 登录与 Bedrock，暂不需要；T08/T21 接入登录时再评估。
- MCP stdio 子进程在 server 主进程已退出时残留的问题已修复（pi-mcp 1.5.1）。

### T06 按 v1.5.2 源码复核的事实

| 事实 | 证据 | PiArc 的做法 |
|---|---|---|
| `createAgentSession()` 的 `cwd`、`agentDir`、`modelRuntime`、`settingsManager`、`sessionManager` 都可以按会话传入；没传 `sessionManager` 时用 `<agentDir>/sessions/--<cwd>--/` | `coding-agent/src/core/sdk.ts:191-207` | 每个会话自己的 cwd 与文件型 `SessionManager`（`getDefaultSessionDir(cwd, agentDir)`），工作区共享一个 `ModelRuntime` |
| `AgentSessionRuntime.dispose()` 依次 abort、发 `session_shutdown`、`session.dispose()`；单独调 `session.dispose()` 不发 `session_shutdown`，MCP 扩展不会断开 server | `coding-agent/src/core/agent-session-runtime.ts:415-424`、`agent-session.ts:1477-1498` | 会话注册表持有 `AgentSessionRuntime`，关闭会话调它的 `dispose()` |
| SDK 会话不加载内置的 codemode、tool_search、MCP 扩展，要自己放进 `DefaultResourceLoader` 的 `extensionFactories`，并调用 `session.bindExtensions()` 触发 `session_start` | `coding-agent/docs/sdk.md:116` | Agent Host 只加 `createMcpExtension()`，创建会话后调用 `bindExtensions` |
| MCP 扩展默认的配置读取、日志与 OAuth 凭据路径用进程级的 `getAgentDir()`（`PI_CODING_AGENT_DIR` 或 `~/.pi/agent`），**不用** SDK 传入的 `agentDir` | `coding-agent/src/extensions/mcp/index.ts:371,1344-1346`、`extensions/mcp/oauth.ts:72-73`、`src/config.ts:609-636` | Agent Host 启动时把 `PI_CODING_AGENT_DIR` 设为 PiArc 的 `pi/` 目录，所有走 `getAgentDir()` 的默认路径都落在 PiArc 目录内，不读用户的 `~/.pi/agent` |
| `SettingsManager.create()` 默认 `projectTrusted: true`，会读项目 `.pi/settings.json`；MCP 扩展只在项目受信任时读 `.pi/mcp.json` | `coding-agent/src/core/settings-manager.ts:310-337`、`extensions/mcp/config.ts:137-148` | 信任状态由 Core 决定（架构第 5.5 节）：Agent Host 创建会话前经 `trust/get` 询问 Core，失败按不信任，再传 `projectTrusted` |
| `DefaultResourceLoader` 的 `noContextFiles: true` 关闭 AGENTS.md/CLAUDE.md 加载 | `coding-agent/src/core/resource-loader.ts:304-341,680-688` | Agent Host 一律关闭；T22 自己组装上下文 |
| 版本检查与安装上报只在交互模式中调用；SDK 路径不联网检查版本，也没有自更新 | `coding-agent/src/modes/interactive/interactive-mode.ts:1200,1481` | Core 仍以最小环境变量启动 Agent Host，并设 `PI_SKIP_VERSION_CHECK=1`、`PI_TELEMETRY=0` 作为兜底 |
| `ModelRuntime.create()` 默认不联网刷新模型目录（`allowModelNetwork` 默认 false）；不传 `credentials` 时读写 `<authPath>`，默认 `~/.pi/agent/auth.json` | `coding-agent/src/core/model-runtime.ts:110-126,218-266` | Agent Host 传入 pi-ai 的 `InMemoryCredentialStore` 与 `<agentDir>/models.json`，`pi/` 下不出现 `auth.json`；凭据保险箱由 T08 接入 |
| 扩展加载器有模块级缓存 `extensionCache`，按 cwd 失效：两个不同 cwd 的会话交替加载文件型扩展会互相清空缓存 | `coding-agent/src/core/extensions/loader.ts:136-157`、`resource-loader.ts:545` | 只影响 jiti 加载的文件型扩展的加载耗时，不影响正确性；Harness Kit 用内联工厂，不经过它 |
| `ModelRuntime.create({ credentials })` 接受 pi-ai 的 `CredentialStore`，`read`、`list`、`modify`、`delete` 都是异步的；同步的 `AuthStorageBackend.withLock` 只属于 coding-agent 的 `AuthStorage`（`auth.json` 后端）。OAuth 刷新在 `modify` 内进行：剩余有效期不到 5 分钟时刷新，刷新超时 15 秒，进锁后复查，释放锁前持久化（T08 核对） | `coding-agent/src/core/model-runtime.ts:112`、`ai/src/auth/types.ts:65-94`、`ai/src/auth/resolve.ts:102-191` | Agent Host 注入 Core 保险箱支撑的 `CredentialStore`（`agent-host/src/runtime/credentials.ts`），读从内存返回，读改写在 Core 的键锁内（ADR-0021）；第 9 节第 16 行的"可能需要改核心"不成立 |
