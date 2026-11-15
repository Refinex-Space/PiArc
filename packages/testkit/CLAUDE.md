# @piarc/testkit

仅测试用的 npm 工作区：用真实模型客户端（pi-ai）驱动 `crates/piarc-testkit` 的 mock provider 独立进程，证明 mock 对真实客户端可用。不发布，不被其他工作区依赖。mock 的说明见 `docs/engineering/testing.md` 第 10 节。

## 命令

| 命令 | 用途 |
|---|---|
| `npx vitest run packages/testkit` | pi-ai 经 Anthropic Messages 与 OpenAI 兼容两种线格式各跑一次工具调用往返 |

## 不变量

- `@earendil-works/pi-ai` 精确锁定（当前 1.5.2）；T06 锁定 Pi 版本时与 `agent-host` 统一到同一版本（`PLAN.md` 登记事项 I14）。
- 只用自建的 pi-ai provider（`createProvider`），auth 只返回常量测试 key；不用内置 anthropic provider，也不碰任何 OAuth 登录（ADR-0006）。测试 key 不得包含 `sk-ant-oat`：pi-ai 见到它会切到 OAuth 路径。
- API 实现从 pi-ai 的公开子路径导出 `@earendil-works/pi-ai/api/<api>.lazy` 取得（主入口不导出它们），不深度导入 `dist/`。
- 场景文件在 `scenarios/`，一个文件一个场景，格式见 testing.md 第 10.3 节。

## 易错点

- `mock-provider.ts` 的 `buildMockProvider` 用 `cargo build --message-format json` 找到可执行文件路径，所以不依赖 `target/` 位置；第一次运行要编译，`beforeAll` 超时设为 300 s。
- 用完调用 `stop()`（关闭 stdin），否则子进程会留到 Vitest 退出。
