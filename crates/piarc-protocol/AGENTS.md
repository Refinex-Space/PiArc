# piarc-protocol

AHP 与 Core API 数据类型的唯一来源：Rust 类型 → JSON Schema → `@piarc/protocol` 的 TS 类型（ADR-0009 第 7 条、ADR-0014 第 6 条）。另含版本协商 `negotiate`、只处理字节缓冲的 LF 帧编解码器，以及终端帧格式草案 `term_frame`（二进制，不导出 JSON Schema，T33 定稿；改动要同步渲染进程的 TS 解码器并重写共享样本，见 `crates/piarc-term/AGENTS.md`）。不负责 I/O、进程监管、心跳与背压（`piarc-host`）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-protocol` | 单元测试 + L1 契约往返（`tests/contracts.rs`）+ 共享帧用例（`tests/framing.rs`） |
| `cargo run -q -p piarc-protocol --bin export-schema` | 打印导出的 schema 文件（JSON 对象，键为文件名）；平时用 `npm run gen:protocol` |
| `npm run gen:protocol` | 改了任何协议类型后必须运行，并提交 `packages/protocol/schema/` 与 `src/generated/` |

## 新增协议消息

1. 定义参数与结果类型（`#[serde(rename_all = "camelCase")]`，派生 `Serialize`、`Deserialize`、`JsonSchema`）和方法标记（请求方法用 `method::request!`，通知实现 `Method` 加 `NotificationMethod`）。可选成员用 `Option` 加 `skip_serializing_if`，布尔与数组也一样：`default` 加省略 `false`/`[]` 会让样本往返不等。
2. 在 `src/contract.rs` 的 `CONTRACTS` 中登记：请求方法登记请求与成功响应两个契约，通知登记一个。成功响应的契约名是 `<方法>/result`（样本在请求目录下的 `result/`）；`host/hello` 的 `core/welcome` 是 T02 留下的唯一例外。
3. `npm run gen:protocol`，再在 `tests/contracts/<契约名>/` 加合法样本、在 `invalid/` 加反例。
4. 完整步骤与检查见 `docs/engineering/testing.md` 第 7 节。

## 不变量

- 不依赖任何 workspace crate（`crates/deps-rules.json` 的 foundation 层）。
- `PROTOCOL_VERSION` 只在 `src/version.rs` 定义；TS 侧的常量由生成器写出。
- 成员 camelCase，枚举值 camelCase 字符串；不用 `deny_unknown_fields`，schema 不出现 `additionalProperties: false`：接收方忽略未知成员。兼容规则全文在 `src/lib.rs` 的 crate 文档。
- ADR-0009 的会话事件 `{sessionId, seq, ts, type, payload}`：`type` 是 JSON-RPC `method`，`sessionId`、`seq`、`ts` 在 `params` 中（`SessionEventHeader`，用 `#[serde(flatten)]` 并入各方法的参数），`payload` 是 `params` 的其余成员。
- AHP 的 `InputMention` 区间使用 UTF-16 码元，和 ProseMirror 序列化后的 JS 字符串偏移一致。输入、队列与用户条目都以 `InputAttachment` 引用描述图片和 PDF。可选元数据缺失的纯文本消息沿用 T14 行为（ADR-0030）。
- `policy/evaluate` 的参数与结果是 AHP 契约，审批卡、答复与结果类型随 Core API 的 schema 生成，定义在 `policy.rs`。
- `fs/memory` 的分页结果承载编码为 JSON 的 `MemorySnapshot`。修改内层结构也要生成 schema 与 TS 类型。
- `hooks.rs`（T25）：`hooks/run` 的 `input` 用 Claude Code 的蛇形字段名（`tool_name` 等），这是 hook 的输入格式而不是 AHP 成员，不改 camelCase；事件枚举照常 camelCase。
- 导出必须确定：`export_schema` 递归排序对象键；不要写入时间、路径、用户名。
- `contracts` 名中 `jsonrpc/`、`envelope/` 留给顶层消息类型，`framing/` 留给帧用例目录，方法不得使用。
- 错误：crate 内 `Error`（`kind()`、`retryable()`、`to_error_object()`）；线上形状是 `rpc_error::ErrorObject`，应用错误码取 `-32099..=-32000`。

- `harness.rs`（T26）：任务清单、计划、提问的类型与 `harness/todo`、`harness/plan`、`ui/ask`；审批卡的 `plan`、`questions` 与答复的 `mode`、`comments`、`answers` 在 `policy.rs` 引用它们。评论偏移是计划原文的 UTF-16 码元。
- `context.rs`（T27，能力 `context`）：提醒类型 `ReminderType`（成员名 `type`，Rust 里是 `kind`）、`ContextUsage` 与分类、`session/usage`、`session/getContextUsage`、`session/remind`、`context/settings`、`fs/changes`、`fs/forgetReads`。`Item::Reminder`、`ContextCompaction.autoCompactStopped`、`SessionCompactParams.instructions`、`FsReadParams.restore` 分别在 `turn.rs`、`session.rs`、`fs.rs`。
- `models.rs` 定义目录、设置 Host 写入与公开状态、会话切换与代价预览。可空价格字段用 JSON `null` 表达未知；切换输入明确区分目标模型和当前 effort。

## 易错点

- `Option` 字段在 serde 中缺失即 `None`、在 schemars 中非必填；"必须出现但可为 null" 要 `#[serde(deserialize_with = "Option::deserialize")]` 加自定义 schema（见 `ErrorResponse::id`）。`Value` 字段缺失会被当成 `null`，必填时同样加 `deserialize_with`。
- `result` 与 `error` 互斥：响应类型手写 `Deserialize` 先检查成员，schema 用 `"error": false` 表示禁止出现（不用 `not.required`，ajv strict 模式会拒绝）。
- schemars 给 `i32` 输出 `format: "int32"`：TS 契约测试的 ajv 要注册它（`packages/protocol/src/contracts.test.ts`）。
- 帧解码按 serde_json 的规则：嵌套超过 `MAX_NESTING`（127）层、孤立代理项转义（`"\ud800"`）、UTF-8 BOM 都是非法 JSON。TS 解码器做了同样的检查；改这里的行为要同步 `packages/protocol/src/framing.ts` 与 `tests/contracts/framing/` 的共享用例。

## 参考

- 架构第 7.4 节（AHP）、第 7.6 节（类型来源与 L1 快照）；ADR-0009、ADR-0014。
