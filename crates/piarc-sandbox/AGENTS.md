# piarc-sandbox

Bash 沙箱与 Agent Host 的 Seatbelt 配置、会话的本地代理与域名白名单、沙箱环境变量、沙箱拒绝的识别（架构第 6.10、10.3 节；T11 原型见 `docs/spikes/S08-sandbox.md`，T39 正式版见 ADR-0056）。不启动进程（`piarc-exec`），不决定哪条命令走沙箱（Core 的 `tool_io::sandbox` 在裁决时决定），只依赖 `piarc-protocol`、`piarc-ports`。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-sandbox` | 策略规范化、两份配置的 golden 与转义、白名单、地址检查、拒绝识别（`denials`）、代理（`tests/proxy.rs`：本机上游 + 注入解析器，不用外网；运行中换白名单、白名单外询问与拒绝回报、`Host` 改写、空闲与读头超时） |
| `PIARC_UPDATE_SNAPSHOTS=1 cargo test -p piarc-sandbox seatbelt` | 有意改了配置后重写 `tests/snapshots/seatbelt-profile.sbpl` 与 `agent-host-profile.sbpl`，在评审中看 diff |
| `cargo test -p piarc-sandbox --test devices` | THR-18（ADR-0096）：两份配置在真实 `sandbox-exec` 下拒绝 `device-microphone` 与 `device-camera`（经 JXA 调 `sandbox_check` 询问运行中的进程，另有无规则的对照） |
| `cargo test -p piarc-core --test agent_host_profile` | Agent Host 配置在真实 `sandbox-exec` 上：允许的位置写得进、其余写不进、读取放开（T39-A09） |
| `cargo test -p piarc-testkit --test sessions sandbox::` | 真实 Agent Host：测试扩展写主目录失败、npx MCP server 只写允许的位置（A09）；网络卡四种答复与超时、改白名单后下一条命令生效且 Agent Host 进程不变、直连失败、审计（A05、A07、A14）；git、python、cargo build、npm install 经 Bash 工具在沙箱内（A11，后两项连真实 registry） |
| `cargo test -p piarc-testkit --test scenarios -- sandbox-` | L2：两种模式、四种拦截、四条启动路径、沙箱外重试、项目只能收紧、Windows 不生效 |
| `cargo run -p piarc-sandbox --release --example s8-bench [-- --iterations N]` | S8 测量：`sandbox-exec` 每条命令额外耗时、代理每请求延迟与吞吐（macOS） |

`cargo test -p piarc-core --test sandbox` 与 `--test sandbox_commands` 是 T11 的端到端用例（`open_sandboxed_session` 强制沙箱的会话）。

## 配置生成（`seatbelt.rs`、`session.rs` 模块文档为准）

- 每条命令一份配置，不跨命令缓存：Core 的 `tool_io::sandbox::sandbox_launch` 按当时的合并设置组 `SandboxPolicy`（`workspace_root` 为会话的文件根，worktree 会话是 worktree；`session_tmp` 为 `<数据目录>/sessions/<会话 id>/tmp/`；`extra_dirs` 为 `permissions.additionalDirectories`；`deny_read` 为 `sandbox.filesystem.denyRead`；`protected` 为 `PROTECTED_PATHS`），`SessionSandbox::launch(policy)` 解析真实路径并生成配置与包装参数。
- 命令以 `/usr/bin/sandbox-exec -p <配置> -DKEY=VALUE… -- <shell> …` 运行；路径只经 `-D` 参数进入，正则用的目录前缀在 Rust 侧转义后作为 `WRITABLE_i_RE` 传入。
- 规则顺序：Codex 的 deny-default 基础配置（`src/seatbelt/base.sbpl`，Apache-2.0，见 `third-party/sources.json`）→ 读取全开、`denyRead` 拒绝 → 可写目录 → 受保护路径与防改名 → 只允许连 `localhost:<代理端口>`。Seatbelt 后面的规则优先，拒绝必须写在放开之后。
- 受保护路径清单与理由：`policy.rs` 的 `PROTECTED_PATHS` 文档（架构 6.10 同步了同一张表）。改清单要同时改架构与两份快照。
- 可用性：`platform_sandbox()` 在 macOS 给 `Seatbelt`（`Seatbelt::at` 换程序，测试用缺失的程序代表 R10），其余平台为 `None`；`available()` 只看程序在不在、可不可执行；命令输出首行以 `sandbox-exec:` 开头且失败时（`launch_failed`）由 Core 停用沙箱并提示。

## agent 启动进程的路径（每条在沙箱开启时都经同一包装）

| 路径 | 入口 | 测试 |
|---|---|---|
| Bash 前台命令 | `tool_io::exec_run`（授权的 `sandboxed`） | L2 `sandbox-ask-writes`、`sandbox-auto-allow`、`sandbox-launch-paths` 的 `fg` |
| `run_in_background` 后台命令 | 同上，`exec::run` 登记任务 | L2 `sandbox-launch-paths` 的 `bg` |
| Monitor 命令 | `tool_io::tasks::exec_monitor`（`claim_monitor` 的 `sandboxed`） | L2 `sandbox-launch-paths` 的 `mon` |
| agent 的终端承载任务（`exec/run` 带 `terminal`） | `tool_io::terminals::exec_terminal`（同一包装） | L2 `sandbox-terminal` |
| 沙箱外重试（`dangerouslyDisableSandbox`） | 同 Bash 前台，授权的 `sandboxed` 为假，必问 | L2 `sandbox-unsandboxed-retry` |

不进 Bash 沙箱的：用户在终端面板里打开的终端（`open_user_terminal`）、hooks、MCP server、LSP、文件工具（第 6.10 节）。MCP server 与 Pi 扩展由 Agent Host 启动，受 Agent Host 配置约束（下一节）。

## Agent Host 的配置（T39 定稿，ADR-0056 第 11 条）

- 模板 `src/seatbelt/agent-host.sbpl`，生成函数 `SeatbeltProfile::agent_host(workspace, data_dir, protected)`，包装 `agent_host_launch(workspace, data_dir)`；golden 为 `tests/snapshots/agent-host-profile.sbpl`。
- 麦克风与摄像头拒绝（`(deny device-microphone)`、`(deny device-camera)`，ADR-0096）：语音输入的麦克风授权只给主进程，Bash 沙箱配置末尾同样写明（基础配置已默认拒绝，显式写出防止以后的放开盖过它）。
- 读取、进程、网络放开；写入只限工作区（受保护路径除外，`.piarc/worktrees/<名称>/` 同样）、`<数据目录>/pi`（`extensions/`、`skills/`、`prompts/`、`npm/`、`git/`、`settings.json`、`models.json` 除外：Pi 自动加载或 Core 当作用户级来源读取，R5）、`<数据目录>/agent-host`、`<数据目录>/sessions/*/tmp` 与终端设备；`.pi/settings.json.lock` 单独放行（Pi 1.5.2 读项目设置前用 proper-lockfile 建它）。用户设置、`core.sqlite`、保险箱、用户级资源、shell integration、检查点与日志对 Agent Host 及其子进程只读。
- Core（`piarc_core::agent_host`）在 macOS 上对打包与开发两种启动都套这份配置，`agent_host_env` 把 `TMPDIR`、`npm_config_cache`、`XDG_CACHE_HOME` 指向 `<数据目录>/agent-host/`，启动前建好这些目录。
- 第 6.10 节说的"MCP server 在沙箱外"指 Bash 沙箱：stdio MCP server 由 Agent Host 启动，仍受这份配置约束。常见 MCP server 若必须放宽写入范围才能运行，属于放松安全基线，按变更型写 ADR。

## 代理（`proxy/mod.rs` 模块文档为准）

- 每会话一个 `NetworkProxy`（Core 在第一条沙箱命令时启动），只听 `127.0.0.1`，丢弃即停止（含已建立的隧道）。HTTP 绝对形式转发 + `CONNECT` 隧道；不解 TLS；转发的 `Host` 一律改为目标主机。
- 白名单可在运行中替换（`set_allowlist`，Core 在每次启动命令时用当时的设置替换）；白名单外的主机交给 `ProxyHooks::unlisted`（Core 发网络卡），拒绝回报给 `ProxyHooks::refused`（Core 写审计）。
- 允许之后再解析一次并拒绝回环、未指定、链路本地、云元数据地址，连接用检查过的地址；私网地址不拦。拒绝：403 + `x-piarc-proxy-denied: not-allowed|blocked-address` + 原因正文。
- 限值 `ProxyLimits`：并发连接 256（accept 等待空位）、读请求头 30 s、连上游 30 s、隧道空闲 10 分钟；accept 失败指数退避（10 ms 到 1 s）。
- 解析与连接经 `Network` trait：测试与开发构建用 `MappedNetwork` 把名字映射到 203.0.113.0/24，再在 `connect` 里转到本机端口（只按地址找端口，忽略请求的端口）。

## 沙箱内命令的环境（`env.rs`）

`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 与小写形式指向代理，`NO_PROXY`、`no_proxy` 置空，`NODE_USE_ENV_PROXY=1`；`CARGO_HTTP_PROXY`、`npm_config_proxy`、`npm_config_https_proxy`、`PIP_PROXY` 与 `GIT_CONFIG_COUNT`/`KEY`/`VALUE`（`http.proxy`、`https.proxy`）覆盖各工具自己的配置；`TMPDIR` 为会话临时目录，`XDG_CACHE_HOME`、`npm_config_cache`、`CARGO_HOME`、`PIP_CACHE_DIR`、`GOCACHE`、`GOMODCACHE` 在其下的 `cache/`。

## 拒绝的识别（`denials.rs`）

`file_denials(output, cwd, policy)` 取含 "Operation not permitted"/`EPERM` 的行里引号中的字符串与消息前的字段（不含空白的裸文件名按 cwd 解析），只保留策略禁止的路径（可写目录外、受保护路径、`denyRead`），至多 10 条。只读输出，不读系统日志：程序不打印路径时识别不出，结果只说明沙箱的边界。

## 易错点

- Cargo、git 先读用户 git 配置里的 `http.proxy`，npm 先读 `.npmrc`，都盖过 `HTTP_PROXY`：`sandbox_env` 必须同时设置各工具的覆盖项。新增要联网的工具时先确认它的配置优先级。
- 默认 APFS 卷上 Seatbelt 匹配不区分大小写；不要为大小写另写规则（`denials` 的比较同样忽略 ASCII 大小写）。
- `sandbox-exec` 自身约 8 ms/命令，与配置大小无关；别为性能删规则或缓存配置（改设置后的下一条命令必须用新配置）。
- 沙箱内不能绑定端口、不能连 Unix socket，`git init`/`clone`/`config` 会失败：测试仓库在沙箱外创建。`cd` 跨命令保留（T17）：多条命令的测试脚本用子 shell。
- Agent Host 及其子进程（含测试里的包装脚本、MCP 夹具）只能写数据目录里 `agent-host/` 等位置：测试要它们写的 pid 文件放在 `<数据目录>/agent-host/`，不要放在测试根目录。
- Pi 新版本若在别处写文件（锁、缓存），L2 会以"读不到项目设置"之类的表现失败：先查 Pi 的写入点，再决定放行单个名字还是改环境变量，不要放宽整个目录。

## 参考

- 架构第 6.2.3、6.10、10.3 节；ADR-0004 第 4 条、ADR-0015、ADR-0056、ADR-0057（Windows，已接受）；`docs/spikes/S08-sandbox.md`。
