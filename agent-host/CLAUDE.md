# @piarc/agent-host

Agent Host：一个 Node 进程，用 Pi SDK 托管一个工作区的多个会话，经 stdin/stdout 上的 AHP 与 Core 通信（架构第 5 章、ADR-0002、ADR-0010）。不负责权限裁决、hooks 执行、快照、沙箱、凭据持久化（都在 Core）；监管它的是 `crates/piarc-host`。

## 命令

| 命令 | 用途 |
|---|---|
| `npm run build:agent-host` | esbuild 打包到 `agent-host/dist/bundle/agent-host.mjs`，并写 `pi-assets/package.json`；`@piarc/protocol` 从源码打包，不依赖 `tsc` 产物 |
| `npx vitest run agent-host` | 单元测试：出站队列、投影、Core 桥接 |
| `cargo test -p piarc-testkit --test agent_host -- --nocapture` | 端到端：Core 监管真实 bundle、mock provider 应答（S3 与进程级 S9）；测试会先自己打包 |
| `node agent-host/dist/bundle/agent-host.mjs --data-dir <dir>` | 手动运行；需设 `PI_PACKAGE_DIR=<bundle>/pi-assets`，stdout 只走 AHP 帧 |

## 入口与结构

- `src/main.ts`：进程入口。解析 `--data-dir`、`--bridge-timeout-ms`；设置 `PI_CODING_AGENT_DIR`；接管 stdout（第三方的 `console.log` 改写到 stderr）；SIGTERM/SIGINT 有序退出，第二个信号立即退出。
- `src/host.ts`：与进程无关的主体：握手（`host/hello` → `core/welcome`）、请求分派、`host/shutdown`、stdin 关闭即退出。退出码见 `EXIT`（3 = 协议主版本不符，70 = 出站积压超限）。
- `src/runtime/session-registry.ts`：会话注册表，`sessionId → AgentSessionRuntime`；创建、恢复（`session/resume`）、提示词、中断、关闭。
- `src/runtime/projector.ts`：投影入口，Pi 的 `AgentSessionEvent` → `turn/*`、`item/*`。
- `src/runtime/core-bridge.ts`：向 Core 发请求的唯一入口（统一超时，默认 30 s；`timeoutMs: null` 给等待用户的请求，靠 `signal` 取消）。
- `src/protocol/outbound.ts`：写 stdout 的唯一路径：等 `drain`、合并增量、写出时分配 `seq`。

## 打包的外部依赖

| 包 | 原因 |
|---|---|
| `@silvia-odwyer/photon-node` | 从自己的包目录加载 `photon_rs_bg.wasm`（图片缩放） |
| `bufferutil`、`utf-8-validate`、`kerberos`、`supports-color` | 可选原生加速或输出着色，导入失败时调用方自行降级 |

其余全部内联（含 jiti）；`scripts/dev/build-agent-host.mjs` 发现其他外部导入就失败。尚未打包：codemode worker、图片缩放 worker、pi-ai 的 OAuth 与 Bedrock 懒加载模块（用到这些功能的任务负责补上，参考 Pi 自己的 `scripts/build-coding-agent-bundle.mjs`）。

## 不变量

- stdout 只写 AHP 帧，且只经 `OutboundQueue`。日志写 stderr，会话相关的行以 `[session <id>] ` 开头（Core 据此打会话标签）。
- 发往 Core 的字符串必须是合法 UTF-16（Rust 端拒绝孤立代理项）：增量走投影器的代理项处理，其他字符串用 `toWellFormed()`。
- `session/prompt` 先回复再开始回合（`setImmediate`），Core 总是先拿到 `turnId`。`requestId` 是幂等键。
- 只从 `@earendil-works/*` 的包入口或 `exports` 声明的子路径导入（ESLint 检查）；Pi 的 API 以锁定版本的类型声明为准。
- 凭据只在内存（`InMemoryCredentialStore`），`pi/` 下不写 `auth.json`；T08 接入保险箱。

## 多会话的易错点

- 不要调用 `process.chdir`，也不要读 `process.cwd()` 推断会话目录：Pi 按每个会话的 `cwd` 解析工具路径。
- 不要在会话代码里改 `process.env`：bash 工具的子进程继承它，所有会话共享。
- Pi 的 MCP 扩展、默认会话目录、默认 `auth.json` 读进程级的 `getAgentDir()`，不看 SDK 的 `agentDir`。`main.ts` 把 `PI_CODING_AGENT_DIR` 固定为 `<data>/pi`，`SessionRegistry` 构造时校验；测试直接用注册表时也要先设它。
- `SettingsManager.create()` 默认 `projectTrusted: true`；注册表总是按 `trust/get` 的结果显式传入。
- `ModelRuntime` 是工作区共享的：扩展注册的 provider 对所有会话可见。
- 关闭会话要走 `AgentSessionRuntime.dispose()`：单独的 `session.dispose()` 不发 `session_shutdown`，MCP 不会断开。
- MCP 扩展按会话实例化：同一个 server 被两个会话配置时会起两份进程（共享池是 T36）。
- 扩展加载器的模块级缓存按 cwd 失效，不同 cwd 的会话交替加载文件型扩展会互相清空它；Harness Kit 用内联工厂不受影响。
- 中断后的下一次请求里 Pi 丢弃被中断的 assistant 消息，出现相邻的 user 消息（`docs/plan/PLAN.md` I18）。

## 参考

- 架构第 5 章、第 7.4–7.5 节；ADR-0002、ADR-0009、ADR-0010、ADR-0015。
- `docs/research/pi-v1.4.0-baseline.md` 文末"版本差异：v1.5.2"；`docs/spikes/S03-multi-session.md`、`S09-ahp-resilience.md`。
