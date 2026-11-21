# 0055. WebSearch 与 hooks 扩展（M3）的落地（补充）

- 状态：已接受，补充 ADR-0005、ADR-0035、ADR-0039、ADR-0045、ADR-0048
- 日期：2026-11-21
- 相关：架构第 6.1.4、6.2.3、6.3、6.4、6.13、7.4、8.5、10.1 节；T38；FR-TL-03、FR-HN-05；登记事项 I93、I112、I115、I122、I123、I128

## 背景

架构第 6.1.4 节定了 WebSearch 的方向（可配置后端，服务商原生搜索优先，其次第三方搜索 API），第 6.3.2 节把 `http`、`prompt` 两种 handler 与 SubagentStart、SubagentStop、PostToolBatch 排在 M3。T38 要定下基线没写到的细节：原生搜索在锁定的 pi-ai 1.5.2 上怎样接、第三方后端选哪家、key 放在哪里、后端都不可用时怎样处理；两种新 handler 在哪个进程执行、白名单怎样生效、模型判定的提示与结果怎样解释；三个新事件挂在哪里、子 agent 里的 hooks 输入怎样标明来源。

调研结论（2026-11-21 核对官方文档）：

- pi-ai 1.5.2 没有服务端工具的类型。它的请求选项有 `onPayload`（发送前替换请求体）与 `onProviderStreamEvent`（每个解析出的原始流事件），Anthropic Messages 适配器调用后者，并且对不认识的内容块（`server_tool_use`、`web_search_tool_result`）不建内容、不报错。
- Anthropic 的 `web_search_20250305` 工具在流中先给 `server_tool_use`（`input.query`），再以一个 `content_block_start` 整块给出 `web_search_tool_result`（`content` 是 `web_search_result` 列表：`url`、`title`、`encrypted_content`、`page_age`；出错时是 `web_search_tool_result_error` 与 `error_code`），回答文本带 `web_search_result_location` 引用。
- Claude Code 的 `http` hook：POST 输入 JSON；2xx 空体等于 exit 0 无输出，2xx JSON 对象按命令 hook 的输出协议读，2xx 其他内容、非 2xx、连接失败、超时都是非阻断错误；没有 exit 2 的对应物；`headers` 的 `$VAR`、`${VAR}` 只解析 `allowedEnvVars` 列出的变量，其余换成空串；设置 `allowedHttpHookUrls`（`*` 通配，跨文件合并，未设置时不限制）与 `httpHookAllowedEnvVars`（设置后变量须同时在两张表里）。
- Claude Code 的 `prompt` hook：`$ARGUMENTS` 换成输入 JSON，没有占位时把 JSON 接在末尾；模型返回 `{ok, reason, impossible}`；默认超时 30 秒；`ok: false` 的效果按事件不同（见第 6 条）；`continueOnBlock` 改变 PreToolUse、PostToolUse 的效果。
- 事件与 handler 的组合：PreToolUse、PostToolUse、PostToolUseFailure、Stop、SubagentStop、UserPromptSubmit、PostToolBatch（及后续里程碑的几个）支持全部类型；PermissionRequest 支持 command、http、prompt；SessionStart 只支持 command（与 `mcp_tool`）；其余事件（SessionEnd、Notification、PreCompact、PostCompact、SubagentStart）支持 command 与 http。
- SubagentStart 不能阻断，`additionalContext` 进子 agent 的首个请求；SubagentStop 的 block 与 exit 2 让子 agent 带理由续跑，续跑上限与 Stop 相同；PostToolBatch 在一批工具调用全部完成、下一次模型请求前运行一次，`tool_calls` 每项带 `tool_name`、`tool_input`、`tool_use_id`、`tool_response`，block、`continue: false` 与 exit 2 停止循环。
- PermissionRequest 的 exit 2 不生效，权限流程照常（I123 核对：T25 的实现与此一致）；PreToolUse 的 allow 不越过 deny 与 ask 规则（I122 核对：与 ADR-0039 一致）。

## 决策

### WebSearch

1. **工具。** 规范名 `WebSearch`，参数与 Claude Code 相同：`query`（至少 2 个字符）、可选 `allowed_domains`、`blocked_domains`（主机名列表，两者不同时使用）。描述由 PiArc 自写。裁决与其他工具相同（`assess::other_call`，`Subject::Tool`）：Manual 与 Accept edits 下询问，`WebSearch` 的 deny、ask、allow 规则与 PreToolUse、PermissionRequest hooks 照常生效，"总是允许"提供 `WebSearch`。
2. **后端选择。** 会话打开时决定 `WebSearch` 是否进入工具集（工具集在会话内不变，ADR-0043）：会话模型支持原生搜索，或 Core 报告第三方后端可用，就注册；两者都不可用就不注册。执行时再按当时的模型与设置选：模型支持原生搜索用原生后端，否则用第三方后端，都不可用时工具结果是错误并说明原因。
3. **原生后端。** 模型调用的始终是 PiArc 的 `WebSearch`；`tool_call` 闸门放行之后，工具经辅助模型通道（T29 的 `AuxiliaryModel.complete`，指定用会话模型，因为原生搜索要发给同一服务商）发一次只带服务端搜索工具的请求：`onPayload` 加入工具定义（`max_uses` 为 1，带上域名过滤），`onProviderStreamEvent` 收集 `web_search_tool_result`。审批、hooks 与审计因此对所有后端一致；把服务端工具直接加进主请求会绕过闸门，不采用。线格式的适配在 `agent-host/src/providers/web-search.ts`（服务商策略目录），工具代码只认统一的结果。T38 支持 Anthropic Messages（`web_search_20250305`）；模型能力表新增 `nativeWebSearch`：服务商 `anthropic` 且线协议为 `anthropic-messages` 的模型为真，用户级每模型设置 `modelProviders.models.<模型>.nativeWebSearch` 可以覆盖（兼容 Anthropic 线协议并支持服务端搜索的端点手动打开）。OpenAI Responses、Gemini 的原生搜索留给后续（登记 I164）。
4. **第三方后端。** Core 的网络请求只在 `piarc-web`（ADR-0045）：新模块 `piarc_web::search` 定义后端适配接口（`Backend`：怎样组请求、怎样解析回答）与首个实现 Brave Search API（`GET https://api.search.brave.com/res/v1/web/search`，`X-Subscription-Token`，结果在 `web.results[]` 的 `title`、`url`、`description`）。选 Brave 的理由：有公开、稳定的 API 文档与按量计费；自有索引，不依赖其他搜索引擎的转售；回答直接是标题、地址、摘要，不需要再调模型；只要一个请求头，key 放在保险箱即可。Agent Host 经新 AHP `web/search`（能力 `webSearch`）请求：Core 消费同一调用、同一查询的授权（一次批准一次搜索，ADR-0031），从保险箱读 `websearch/<后端>` 的 key，请求复用 WebFetch 的 HTTP 客户端、超时与大小上限，写 `kind: "webSearch"` 审计。后端地址是固定的服务端点，不经 SSRF 检查（`Reach::Configured`，仍按解析出的地址连接）；测试经 `CoreConfig.web` 换成本地 mock。`web/searchBackend` 回答第三方后端是否可用及原因（`notConfigured`、`noKey`）。
5. **设置。** 用户级 `settings.json` 的 `webSearch.backend`（`brave`，不设为没有第三方后端），只读用户层：用哪家服务、用谁的 key 不由项目决定。key 只在保险箱（键 `websearch/brave`），经 Core 的设置 API 写入、删除，设置页只显示是否已保存。设置页的"网页搜索"一节显示当前默认模型是否支持原生搜索、第三方后端状态，以及两者都不可用时 `WebSearch` 不提供的原因。
6. **结果。** 统一为标题、URL、摘要（至多 10 条，按 `allowed_domains`、`blocked_domains` 过滤，主机名按后缀匹配）。工具结果是带编号的列表并写明后端与"Sources"；条目的 `details.webSearch` 带查询、后端与结果，transcript 显示来源链接，点击经第 8.5 节的外链确认后打开。WebFetch 的二次抓取由模型自己调用。代理与压缩编码维持 ADR-0045 的现状（不走代理、请求 `identity`），I112 交 T45 与网络设置一起决定。

### hooks

7. **执行仍全部在 Core，三种 handler 共用一个执行框架。** `piarc_hooks::Handler` 带 `Action`（`Command`、`Http`、`Prompt`）；`Runner` 并行运行一个事件的全部 handler，超时、取消、`onFailure`、决策合并与审计共用 T25 的实现。`http` 经注入的 `HttpPort`（Core 用 `piarc_web::Fetcher::call`，`Reach::Configured`：hook 的地址是用户写的，可以是本机服务），`prompt` 经注入的 `JudgePort`（Core 经新的 AHP 请求 `hooks/prompt`（Core → Agent Host）让会话的辅助模型通道做一次判定，会话由主会话 id 找到工作区的 Agent Host）。两个端口的回答被翻译成命令 hook 的输出协议（JSON 对象或错误）后交给同一个 `Outcome`、`Decision`。
8. **`http` handler。** 请求体是 hook 输入 JSON，`Content-Type: application/json`；超时默认 600 秒（UserPromptSubmit 30 秒）；响应按第一节的调研解释，不跟随重定向，体至多 1 MiB。`allowedHttpHookUrls`、`httpHookAllowedEnvVars` 是 Claude Code 键（生效，列表跨层合并）：前者设置后不匹配的 URL 不发请求并作为非阻断错误报告，匹配时 scheme 与主机不区分大小写、主机末尾的点忽略、`*` 匹配任意字符；`headers` 的 `$VAR`、`${VAR}` 从登录 shell 环境取值（`ToolIo::expansion_environment`，与 MCP 的展开同源），只解析同时满足 handler 的 `allowedEnvVars` 与（设置时）`httpHookAllowedEnvVars` 的变量，其余换成空串。审计记录 URL 的 scheme 与主机、整个 URL 的 SHA-256 与状态码，不记录路径、查询与头。
9. **`prompt` handler。** Core 把 `$ARGUMENTS` 换成输入 JSON（`\$` 转义，没有占位时接在末尾），Agent Host 用 PiArc 原创的判定提示（`harness/prompts/hook-judge.ts`）包装、要求只回答一个 JSON 对象；`model` 经 `resolveModel`（别名可用），缺省用辅助模型；默认超时 30 秒。回答 `{ok, reason, impossible}` 按事件翻译：

   | 事件 | `ok: false` 的效果 |
   |---|---|
   | PreToolUse | 拒绝调用，理由作为拒绝理由给模型；`continueOnBlock` 不为真时同时结束回合（`continue: false`） |
   | Stop、SubagentStop | 带理由续跑（`impossible: true` 时不续跑） |
   | PostToolUse | `continueOnBlock` 为真时理由给模型继续，否则结束回合并提示用户 |
   | PostToolUseFailure | 理由给模型 |
   | UserPromptSubmit | 阻断这次输入，理由给用户 |
   | PostToolBatch | 停止循环，理由给用户 |
   | PermissionRequest | 不起作用 |

   回答不是 JSON 对象、缺 `ok`、超时、模型请求失败都是非阻断错误（`onFailure: "block"` 时按阻断处理）。每次调用写审计：模型、输入与输出 token、提示的 SHA-256；用量同时计入会话当前回合（T29 的辅助用量）。测试只用 mock provider。
10. **事件与 handler 的组合。** 按调研结论：SessionStart 只运行 command；SessionEnd、Notification、PreCompact、PostCompact、SubagentStart 运行 command 与 http；其余事件三种都运行。不支持的组合在配置诊断中标 `unsupportedType` 并忽略。项目级的 `http`、`prompt` hooks 与命令 hooks 一样在信任前不执行（设置合并排除项目层的 `hooks`），子 agent 定义与 skill 的 hooks 同样按 ADR-0048、ADR-0054 的信任规则登记。
11. **M3 事件。** 都由 Agent Host 经 `hooks/run` 报告：

    | 事件 | 挂载点 | 行为 |
    |---|---|---|
    | SubagentStart | 子会话登记之后、首次 `prompt` 之前（`ChildSession.run`） | matcher 为 agent 类型；输入带 `agent_id`、`agent_type`；`additionalContext` 作为 `hookContext` 提醒进入子 agent 的首个请求；不能阻断 |
    | SubagentStop | 子会话的 `agent_before_settle`（取代 Stop） | 输入带 `stop_hook_active`、`agent_transcript_path`（子会话 JSONL）、`last_assistant_message`；block 与 exit 2 带理由续跑一轮，计数与上限同 Stop（`STOP_CONTINUATION_LIMIT`） |
    | PostToolBatch | Pi `turn_end`（本轮有工具结果且正常完成） | 输入 `tool_calls`（`tool_name`、`tool_input`、`tool_use_id`、`tool_response` 为模型收到的内容）；`additionalContext` 进下一次请求；block、`continue: false` 与 exit 2 停止循环：Pi 1.5.2 的 `turn_end` 不能结束运行，Agent Host 中止本次运行（与 T25 的 `continue: false` 相同），理由经提示行给用户并作为 `hookContext` 提醒留给模型的下一次请求 |

12. **子 agent 里的 hooks。** 子会话触发的所有 hooks（包括 Core 观察的 PreToolUse、PermissionRequest 与子 agent 定义的 hooks）输入带 `agent_id`（子会话 id）与 `agent_type`；`session_id`、`transcript_path`、`prompt_id` 是主会话的，与 Claude Code 一致。Core 从会话的 `Link`（ADR-0048）得到这些值，Agent Host 不在输入里自报。
13. **通用字段（I115）。** `prompt_id`：Core 在每次 UserPromptSubmit（prompt、steer、follow-up）生成一个 UUID 记在会话上，之后该会话及其子 agent 的所有事件都带它，第一次输入之前没有。`effort`：Agent Host 在 `hooks/run` 与 `policy/evaluate` 中给出会话当前的 effort 档位，Core 只在工具事件、Stop、SubagentStop、PostToolBatch 上写成 `{ level }`，模型不支持 effort（档位为 off）时省略。
14. **命令 hook 的环境变量白名单（I93，用户决定）。** 用户级 `settings.json` 的 `hookAllowedEnvVars`（变量名列表，只读用户层）：列出的变量从登录 shell 环境加进命令 hook 的环境（ADR-0035 的准入环境之外），其余仍不传。项目文件里的这个键不生效。
15. **错误与审计步骤（I128）。** `piarc-hooks` 的解析错误是 `piarc_hooks::Error`（`error.rs`，`kind()`、`retryable()`），执行函数移出 `lib.rs`；`piarc-web` 的 `FetchError` 移到 `error.rs`。审计步骤名维持字符串（`policy.rs` 的 `hookDeny` 等是 AHP 与审计表的对外值），不改。
16. **权限效力（I122 的文档部分）。** ADR-0039 的第 6 条补充：PermissionRequest hook 的 allow 可以代答 ask 规则、受保护路径与越界询问（Claude Code 文档的语义：ask 规则只是"需要询问"，hook 是询问的一种答复），不能代答关键路径删除与 `requiresUserInteraction`。撤销信任时清掉项目 hook 写入的模式记忆与规则的代码改动不在 T38 范围（登记 I165）。

## 备选方案

| 方案 | 结论 | 理由 |
|---|---|---|
| 把服务端搜索工具直接加进主请求 | 否决 | 搜索在服务商一侧发生，绕过 `tool_call` 闸门、Manual 审批、`WebSearch` 规则与 PreToolUse hooks；任务要求所有后端经同一裁决 |
| 第三方搜索在 Agent Host 用 `fetch` 发出 | 否决 | 网络请求只在 Core（ADR-0045），key 只在保险箱，Agent Host 拿到 key 就要放进进程内存与请求头 |
| Tavily、Exa、SearXNG 作为首个后端 | 暂不采用 | Tavily、Exa 的结果面向 LLM 的二次加工，计费按信用点；SearXNG 需要用户自建实例。适配接口留出位置，后续按需增加 |
| `prompt` handler 在 Core 直接调用模型 | 否决 | 模型请求、服务商凭据适配与脱敏都在 Agent Host（ADR-0021）；Core 只经 AHP 请求一次判定 |
| `http` hook 的地址经 SSRF 检查 | 否决 | 地址是用户（或受信任项目）写在设置里的，本机服务是常见用法；`allowedHttpHookUrls` 是约束它的手段 |
| PostToolBatch 在工具的执行包装里等全部结果后设 `terminate` | 否决 | PostToolUse hooks 在 `tool_result` 中、执行包装之后运行，PostToolBatch 必须在它们之后；在执行包装里等待会让批次互相等待 |

## 后果

- AHP：能力 `webSearch`，方法 `web/search`、`web/searchBackend`（Agent Host → Core）与 `hooks/prompt`（Core → Agent Host）；`hooks/run` 新增三个事件与 `effort`；`policy/evaluate` 新增可选 `effort`；`models/list` 的模型新增 `nativeWebSearch`。
- 设置键：`allowedHttpHookUrls`、`httpHookAllowedEnvVars` 生效（`claude::SETTINGS_KEYS`）；PiArc 新增 `webSearch.backend`、`hookAllowedEnvVars`（只读用户层）与每模型的 `nativeWebSearch`。
- 新的登记：I164（OpenAI Responses、Gemini 的原生搜索）、I165（撤销信任时清理项目 hook 写入的模式与规则）；I112 改交 T45。
