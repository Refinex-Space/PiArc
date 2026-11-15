# piarc-testkit

仅测试用的支持 crate：目前是严格校验请求的 mock provider（架构第 12.2 节）；T15 在这里加 L2 场景运行器与事件断言。发布的 crate 不得依赖它（`crates/deps-rules.json` 的 testsupport 层）。完整说明（端点、场景选择、脚本格式、规则表、记录字段）在 `docs/engineering/testing.md` 第 10 节，crate 文档（`src/lib.rs`）有同一份脚本格式。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-testkit` | 单元测试 + `tests/` 下的集成测试（线格式、校验规则、场景选择与故障注入、独立进程） |
| `cargo test -p piarc-testkit --test validation -- --nocapture` | 打印每条规则的 400 说明（验收证据用） |
| `cargo run -q -p piarc-testkit --bin piarc-mock-provider -- --port 0 --scenarios packages/testkit/scenarios` | 手动起一个独立进程：第一行打印端口，回车或关闭 stdin 后退出 |
| `npx vitest run packages/testkit` | pi-ai 对 mock 的两种线格式往返（会先 `cargo build` 这个 bin） |

## 两种运行形态

- 库：`MockProvider::start(library).await`，必须在 tokio 运行时内调用；每个测试起自己的实例，步数计数天然隔离。
- 独立进程：`piarc-mock-provider`，`--port 0` 取空闲端口，stdout 第一行是端口；stdin 到 EOF 就退出。父进程退出前关闭它的 stdin。

## 规则 ID

可关闭：`tool_pairing`、`role_order`、`tool_schema`、`system_sections`、`cache_breakpoint_count`、`cache_breakpoint_position`。不可关闭：`malformed_request`、`streaming_required`、`scenario_not_selected`、`scenario_not_found`、`scenario_exhausted`、`not_found`。ID 是对外契约（测试按它断言），不要改名。

## 新增校验规则

1. `src/rules.rs`：`Rule` 加变体与 `id()`；写检查函数（只看 `Request`，不看原始 JSON）并接进 `validate`。
2. 可关闭的规则：加进 `Rule::VALIDATION` 与 `src/scenario.rs` 的 `RuleSwitches`（字段名与 ID 相同）。
3. 规则需要的新信息先加到 `src/request.rs` 的中立结构，再在 `anthropic.rs`、`openai.rs` 的 `parse` 里填充。
4. `tests/validation.rs` 加一个经 HTTP 触发 400 的测试，断言 `error.code` 与位置；同步 `testing.md` 第 10.4 节。

## 不变量

- 校验器与编码器分开：`rules.rs` 只依赖 `request.rs`；线格式细节只在 `anthropic.rs`、`openai.rs`。
- mock 不含场景特判，脚本是数据；不为某个测试硬编码响应。
- 被校验拒绝的请求不消耗步数；注入错误、断流（`disconnect_after_events`）与挂起（`stall_after_events`）消耗步数（模拟客户端重试时下一步应答）。
- 只绑定 `127.0.0.1`；记录里凭据头的值一律 `<redacted>`。
- 对客户端发来的未知字段宽容，对规则覆盖的结构严格。新增对某个客户端（pi-ai 等）的兼容前，先在其锁定版本源码里确认它实际发出的形状。

## 易错点

- 断流靠 `body.rs` 的 `ScriptBody::aborted`：最后一块之后先返回一次 `Pending` 让 hyper 把已写数据刷到 socket，再返回错误让 hyper 关闭连接。直接返回错误会丢掉已缓冲的事件。挂起（`stalled`）在最后一块之后一直返回 `Pending` 且不唤醒，客户端关闭连接时 hyper 丢弃响应体。
- 参数分段按字符而不是字节计偏移；`split_at` 的每个偏移必须严格递增且落在 `(0, 长度)` 内，加载时检查。
- 工具参数以紧凑 JSON、键按字典序流出（serde_json 默认），断言拼接结果时用同样的序列化。
- Anthropic SDK 的 beta 客户端请求 `/v1/messages?beta=true`；路由只比较路径，记录里保留查询串。
- `jsonschema` 经 `fluent-uri` 引入 MIT-0 的 `borrow-or-share`，`deny.toml` 为它单独设了许可证例外；升级 `jsonschema` 后例外不再命中时 cargo-deny 会警告。
