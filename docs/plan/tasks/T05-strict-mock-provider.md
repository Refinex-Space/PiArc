# T05 严格校验的 mock provider

| 项 | 内容 |
|---|---|
| 阶段 | 1 M0 技术验证 |
| 依赖 | T02 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 中 |
| 关联验证项 | 无 |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T05`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

L2 场景测试的模型侧全部由 mock provider 驱动（架构第 12.2 节）。claw-code 的教训是 mock 不校验请求：tool_use 与 tool_result 配对错误、角色错乱这类问题在测试里全被掩盖，到真实服务商才暴露。PiArc 的 mock 要比真实服务商更严格：任何不合规的请求都返回 400，并写明违反了哪条规则。

本任务在 `piarc-testkit` 中实现它：模拟 Anthropic Messages 与 OpenAI 兼容 Chat Completions 两种线格式的流式响应，按场景脚本返回多步响应，可以注入错误，并记录每轮请求供断言。最后用 Pi 的 pi-ai 对它跑一遍带工具调用的完整往返，证明它对真实客户端可用。

T06 用它驱动 Agent Host 的多会话与故障注入测试；T15 的场景文件会内嵌它的脚本格式，所以脚本格式要稳定并写成文档。

## 必读

1. 架构设计：
   - 第 12.2 节"严格 mock provider"、第 12.3 节"场景数据文件"
   - 第 6.15 节中"回合继续条件""缓存断点"两行
2. `docs/research/pi-v1.4.0-baseline.md` 第 2.1 节（消息、流、工具调用模型）、第 2.2 节（provider 与认证）、第 2.4 节（缓存与 thinking 参数）。
3. `docs/research/claude-official-capabilities.md` C 节（prompt caching 的断点数量与前缀顺序等 API 约束）。
4. `docs/research/harness-reference-notes.md` 第 2.2、2.3 节（mock 的反面教训与 parity 测试方法）。
5. T02 交付的结构化错误类型与 CLAUDE.md。
6. 实现时查阅：Anthropic Messages 与 OpenAI Chat Completions 的官方流式线格式文档（事件类型、增量字段、错误体）；pi-ai 锁定版本中 `anthropic-messages` 与 `openai-completions` 两个 api 的实现，以及给模型指定自定义 `baseUrl` 的方式；选定的 HTTP 服务库的文档。

## 范围

### 要做

- 两种线格式的流式响应编码。
- 场景脚本：多步响应、工具参数分段增量、错误注入。
- 请求校验与每轮请求记录。
- 库与独立进程两种运行形态。
- 用 pi-ai 完成两种线格式各一次的工具调用往返。

### 不做

- 场景 YAML 运行器、事件序列与文件副作用断言（T15）。
- 与 Core、Agent Host 的集成（T06）。
- L3 对 Claude Code 的录制比对（T30）。

## 交付物

### 1. 线格式

| 线格式 | 要求 |
|---|---|
| Anthropic Messages（`POST /v1/messages`，`stream: true`） | SSE 事件按官方顺序：`message_start` → 每个内容块的 `content_block_start`、`content_block_delta`（`text_delta`、`input_json_delta`）、`content_block_stop` → `message_delta`（stop reason 与用量）→ `message_stop`；错误用官方错误体 |
| OpenAI 兼容 Chat Completions（`POST /v1/chat/completions`，`stream: true`） | `data:` 分块；文本在 `delta.content`；工具调用在 `delta.tool_calls[index]` 中分片追加 `function.arguments`；最后给出 `finish_reason` 与 `data: [DONE]` |

- 非流式请求返回 400 并说明未支持。
- 用量字段（输入、输出、缓存读写 token）由脚本给出，供后续用量统计任务断言。

### 2. 场景脚本

- 用 serde 定义，可从 JSON 或 YAML 加载；字段命名稳定，格式写进 crate 文档与 `docs/engineering/testing.md`。
- 场景选择：请求头（例如 `x-piarc-scenario`）或首条用户消息中的标记；两者都没有、或场景不存在时返回 400 并说明。
- 每个场景是多步脚本，第 N 次请求返回第 N 步。一步可以是文本、一个或多个工具调用、两者混合，或一次错误注入。
- 工具参数 JSON 按脚本切成多段增量，默认至少 3 段，允许在字符串值与转义序列中间切开。
- 错误注入：429（带 `retry-after`）、529 / overloaded、500 与 503、流中途断开（发出部分事件后关闭连接）。
- 每个场景实例独立计数，测试之间互不影响。

### 3. 请求校验

| 规则 | 不合规时 |
|---|---|
| tool_use / tool_result 配对：每个工具调用在下一条消息中都有结果，id 一致，没有孤立的结果 | 400，指出缺失或多余的 id |
| 角色顺序：Anthropic 中 user 与 assistant 交替、首条为 user；OpenAI 中 `tool` 消息紧跟带 `tool_calls` 的 assistant 消息 | 400，指出位置 |
| 工具 schema：参数 schema 是合法 JSON Schema 且顶层为 object；工具名符合服务商约束（实现时查官方文档）且不重复 | 400，指出工具 |
| system 必要段落：场景配置要求出现的段落或标记（例如 Pi 写入的段名）全部存在 | 400，列出缺失项 |
| 缓存断点（Anthropic）：数量不超过 API 上限；位置符合场景配置（例如"只有一个消息级断点"，第 6.15 节） | 400，给出实际位置 |

- 校验规则可以按场景开关，默认全开。
- 400 的错误体同时给机器可读的规则 ID 与人能读的说明，测试按规则 ID 断言。
- 每轮请求完整记录：原始请求体、线格式、场景、步序号、校验结果。库模式提供查询 API；独立进程模式提供 HTTP 查询端点。

### 4. 运行形态

- 库：测试进程内启动，返回实际端口与请求记录句柄。
- 独立进程：`piarc-testkit` 的一个 bin 目标。`--port 0` 时随机端口，启动后在 stdout 第一行打印实际端口；stdin 关闭或收到终止信号时退出。T06 与之后的跨进程测试用它。
- 只绑定 `127.0.0.1`。

### 5. pi-ai 往返验证

- 新建仅测试用的 npm 工作区（例如 `packages/testkit`，`private: true`），把 `@earendil-works/pi-ai` 作为 devDependency 精确锁定为 npm 上的最新稳定版。T06 锁定 Pi 版本时会把它与 `agent-host` 统一到同一版本。
- 用 pi-ai 的公开 API 把模型的 `baseUrl` 指向 mock，两种线格式各跑一次：用户消息 → 模型返回工具调用（参数分多段）→ 客户端提交工具结果 → 模型返回最终文本。断言 mock 记录的两次请求都通过校验，第二次请求含正确配对的工具结果。
- 只用测试 API key；不使用、不触发任何订阅 OAuth 路径（ADR-0006）。

## 实现要点

- 校验器与线格式编码器分开：校验器只看解析后的请求结构，便于逐条规则单测，也便于以后加线格式。
- mock 本身不含场景特判，脚本是数据；不为某个测试硬编码响应。
- HTTP 服务与 SSE 编码库的选型是补充型决策，经 cargo-deny 许可证检查。
- pi-ai 的线格式实现可能附带额外请求头或字段（例如缓存控制、beta 头）：先在锁定版本源码中确认，再决定校验器接受什么；对它不认识的字段保持宽容，对规则覆盖的结构保持严格。

## 验收标准

- [T05-A01] 两种线格式的流式输出按官方事件顺序与字段编码，文本与工具调用两类内容都有测试。验证：单元测试。
- [T05-A02] 配对、角色顺序、工具 schema、system 必要段落、缓存断点数量、缓存断点位置六条规则各有一个触发 400 的测试，错误体带对应规则 ID 与说明。验证：测试输出。
- [T05-A03] 合规请求（包括 pi-ai 发出的正常请求）通过全部规则，不误报。验证：测试输出。
- [T05-A04] 脚本中的工具参数在客户端收到时至少分成 3 段增量，拼接后与原 JSON 一致。验证：测试断言。
- [T05-A05] 429、529、500、503 与流中途断开五种错误注入都生效，客户端收到对应的状态或断流。验证：测试。
- [T05-A06] 按请求头与按首条消息标记两种方式都能选中场景；未指定或不存在的场景返回 400。验证：测试。
- [T05-A07] 请求记录按顺序保存每轮请求，库 API 与独立进程的 HTTP 端点都能查询。验证：测试。
- [T05-A08] 独立进程以 `--port 0` 启动后在 stdout 第一行打印端口并提供服务，stdin 关闭后退出。验证：测试。
- [T05-A09] pi-ai 经 Anthropic Messages 线格式对 mock 完成一次含工具调用的完整往返，两次请求都通过校验。验证：测试输出。
- [T05-A10] pi-ai 经 OpenAI 兼容线格式对 mock 完成一次含工具调用的完整往返，两次请求都通过校验。验证：测试输出。
- [T05-A11] `@earendil-works/pi-ai` 精确锁定版本，测试中没有使用任何 OAuth 登录方式。验证：`package.json` 与测试代码检查。
- [T05-A12] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 创建 `crates/piarc-testkit/CLAUDE.md`：两种运行形态、脚本格式、规则 ID 清单、如何新增校验规则。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：mock provider（库与独立进程）、请求校验器、请求记录查询。
- 在 `PLAN.md`"登记事项"中注明 `packages/testkit` 的 pi-ai 版本需要在 T06 中与 Pi 锁定版本统一。
