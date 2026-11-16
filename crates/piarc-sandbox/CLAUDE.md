# piarc-sandbox

沙箱内命令的配置与网络出口（架构第 6.10 节，T11；报告 `docs/spikes/S08-sandbox.md`）：Seatbelt 配置生成（macOS）、会话的本地代理与域名白名单、沙箱环境变量。不启动进程（`piarc-exec`），不决定哪些会话或命令走沙箱（T39），只依赖 `piarc-protocol`、`piarc-ports`。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-sandbox` | 策略规范化、配置快照与转义、白名单、地址检查、代理（`tests/proxy.rs`：本机上游 + 注入解析器，不用外网） |
| `PIARC_UPDATE_SNAPSHOTS=1 cargo test -p piarc-sandbox seatbelt` | 有意改了配置后重写 `tests/snapshots/seatbelt-profile.sbpl`，在评审中看 diff |
| `cargo run -p piarc-sandbox --release --example s8-bench [-- --iterations N]` | S8 测量：`sandbox-exec` 每条命令额外耗时、代理每请求延迟与吞吐（macOS） |

沙箱行为的端到端测试在 `piarc-core`：`cargo test -p piarc-core --test sandbox`（写入、受保护路径、`denyRead`、绕过代理、终止无残留）与 `--test sandbox_commands`（git、python、cargo build、npm install；后两项要连 registry）。

## 配置模型（`seatbelt.rs` 模块文档为准）

- `SandboxPolicy::resolve()` 先把路径变成真实路径（解析符号链接），Seatbelt 按真实路径匹配；可写目录必须存在，`denyRead` 可以不存在。
- 每条命令一份配置：`/usr/bin/sandbox-exec -p <配置> -DKEY=VALUE… -- /bin/bash -c <命令>`。路径只经 `-D` 参数进入，配置正文不含路径；正则用的目录前缀在 Rust 侧转义后作为 `WRITABLE_i_RE` 传入。
- 规则顺序：Codex 的 deny-default 基础配置（`src/seatbelt/base.sbpl`，Apache-2.0，见 `third-party/sources.json`）→ 读取全开、`denyRead` 拒绝 → 可写目录 → 受保护路径与防改名 → 只允许连 `localhost:<代理端口>`。Seatbelt 后面的规则优先，拒绝必须写在放开之后。
- 受保护路径清单与理由：`policy.rs` 的 `PROTECTED_PATHS` 文档（架构 6.10 同步了同一张表）。改清单要同时改架构与快照。

## 代理（`proxy/mod.rs` 模块文档为准）

- 每会话一个 `NetworkProxy`，只听 `127.0.0.1`，丢弃即停止（含已建立的隧道）。HTTP 绝对形式转发 + `CONNECT` 隧道；不解 TLS。
- 先查白名单（精确域名、`*.` 通配，不含域名本身），再解析一次并拒绝回环、未指定、链路本地、云元数据地址，连接用检查过的地址。拒绝：403 + `x-piarc-proxy-denied: not-allowed|blocked-address` + 原因正文。
- 解析与连接经 `Network` trait；测试把名字解析到 203.0.113.0/24，再在 `connect` 里转到本机端口。

## Job Object 与进程树

不在本 crate：`piarc-exec::ProcessTreeSpawner`（macOS 进程组，Windows Job Object）。`piarc-core::tool_io` 把 `SessionSandbox::launch()` 给出的包装程序放进 `CommandSpec::launcher`，用 `ProcessTreeSpawner` 运行。

## 易错点

- Cargo、git 先读用户 git 配置里的 `http.proxy`，npm 先读 `.npmrc`，都盖过 `HTTP_PROXY`：`sandbox_env` 必须同时设置 `CARGO_HTTP_PROXY`、`npm_config_*proxy`、`PIP_PROXY`、`GIT_CONFIG_*`。新增要联网的工具时先确认它的配置优先级。
- 默认 APFS 卷上 Seatbelt 匹配不区分大小写；不要为大小写另写规则。
- `sandbox-exec` 自身约 8 ms/命令，与配置大小无关；别为性能删规则。
- 沙箱内不能绑定端口、不能连 Unix socket，`git init`/`clone`/`config` 会失败（写 `.git/config`、`.git/hooks`）：测试仓库在沙箱外创建。
