# S8 沙箱：Seatbelt、网络代理与 Job Object

| 项 | 内容 |
|---|---|
| 任务 | T11（2026-11-15） |
| 结论 | macOS：通过。写入与网络限制生效，git、npm install、cargo build、python 在沙箱内正常运行，停止后无残留进程；每条命令额外约 8.4 ms（p50）。Windows：Job Object 已实现，单测待 CI，实机待 W0 |
| 代码 | `crates/piarc-sandbox`（配置生成、代理）、`crates/piarc-exec/src/tree.rs` 与 `job.rs`（进程树）、`crates/piarc-core/src/tool_io.rs`（编排） |
| 测试 | `crates/piarc-sandbox/tests/proxy.rs`、`crates/piarc-core/tests/sandbox.rs`、`crates/piarc-core/tests/sandbox_commands.rs`、`crates/piarc-exec` 单元测试 |

## 1. 验证环境

- macOS 26.5.2（25F84），Apple Silicon；`/usr/bin/sandbox-exec`（系统自带，`man` 页标为 DEPRECATED）。
- Rust 1.99.1；tokio 1.54.1；hyper 1.12.0；nix 0.28.0（`killpg`）；windows-sys 0.61.2（Job Object，只在 Windows 编译）。
- 常见命令：Apple git（`/usr/bin/git`）、Node 24.14.1 + npm、cargo 1.99.1、Python 3.14。

## 2. 配置模型

每条命令生成一份 SBPL 配置，以 `/usr/bin/sandbox-exec -p <配置> -DKEY=VALUE… -- /bin/bash -c <命令>` 运行（固定路径，不查 `PATH`）。`sandbox-exec` 调用 `sandbox_init` 后 `exec` 成 bash，进程号不变，所以 bash 就是进程组的组长。

输入（`SandboxPolicy`）：工作区根、会话临时目录（`<数据目录>/sessions/<会话 id>/tmp/`）、附加目录、`denyRead`、受保护路径清单；代理端口由会话的代理给出。路径先变成绝对路径、解析符号链接（`/var` → `/private/var`、`/tmp` → `/private/tmp`），Seatbelt 按真实路径匹配；`denyRead` 中尚不存在的路径解析到最长的存在前缀为止。

配置的组成，后面的规则优先：

| 段 | 规则 |
|---|---|
| 基础 | 拷自 Codex 的 `seatbelt_base_policy.sbpl`（Apache-2.0，来源与许可证见 `third-party/sources.json`）：`(deny default)`，再放开进程创建、同沙箱内的信号与进程信息、一组 sysctl、`opendirectoryd.libinfo` 等少量 Mach 服务、POSIX 信号量、伪终端 |
| 读取 | `(allow file-read*)`，再 `(deny file-read* (subpath DENY_READ_i))` |
| 写入 | 可写目录的 `subpath`；`/dev/null`、`/dev/stdout`、`/dev/stderr`、`/dev/tty`、`/dev/fd/N` 只放开写数据 |
| 受保护路径 | 每个可写目录下任意深度：`(deny file-write* (regex "^<目录>/(.*/)?(<清单>)(/.*)?$"))`；`.git`、`.git/modules`、`.git/worktrees` 禁止改名与删除；`denyRead` 路径及其在可写目录内的祖先禁止改名与删除 |
| 网络 | 只有 `(allow network-outbound (remote ip "localhost:<代理端口>"))`；不能绑定端口，不能连 Unix socket |
| 其他 | `(deny system-fcntl (fcntl-command 80 110))`：禁止经只读描述符改写文件（做法同 Codex） |

路径一律经 `-D` 参数传入，配置正文只出现参数名：含空格、中文、`[`、`(`、`+` 的路径不需要 SBPL 字符串转义，配置正文也与具体路径无关，快照（`crates/piarc-sandbox/tests/snapshots/seatbelt-profile.sbpl`）能直接反映规则变化。受保护路径要用正则，正则所需的目录前缀在 Rust 侧转义元字符后作为另一个参数（`WRITABLE_i_RE`）传入，配置里用 `(string-append "^" (param …) "…")` 拼接。

实测要点：

- 默认的大小写不敏感 APFS 卷上，Seatbelt 的 `literal` 与 `regex` 都不区分大小写：`mkdir .CLAUDE` 命中 `.claude` 的规则。大小写敏感卷上 `.CLAUDE` 本来就是另一个目录，读取 `.claude` 的程序看不到它，也就不构成绕过。
- 硬链接被拦截：`ln .git/config x` 返回 `Operation not permitted`，不能借另一个名字改写受保护文件。
- 拒绝在命令侧是普通的 `EPERM`：bash 报 `Operation not permitted`，Python 抛 `PermissionError: [Errno 1]`，测试按这段文字断言。

## 3. 受保护路径清单

第 6.1.2 节的清单面向文件工具，整个 `.git/` 都要询问；沙箱如果禁写整个 `.git/`，`git add`、`git commit` 都会失败。沙箱用下面这份更窄的清单（`piarc_sandbox::PROTECTED_PATHS`），在每个可写目录下任意深度生效，目录连同其下全部内容：

| 路径 | 理由 |
|---|---|
| `.git/hooks`、`.git/modules/**/hooks` | 钩子在之后的 git 命令中运行，那时不在沙箱里 |
| `.git/config`、`.git/config.worktree`、`.git/modules/**/config`、`.git/worktrees/*/config.worktree` | `core.hooksPath`、`core.fsmonitor`、别名与过滤器都能运行代码 |
| `.piarc`、`.claude`、`.pi` | PiArc、Claude Code、Pi 的项目设置：权限规则、hooks、扩展 |
| `.mcp.json` | MCP server 以进程形式在沙箱外启动 |
| `.vscode`、`.idea` | 编辑器的任务与设置可以运行代码 |
| `.gitconfig` | git 配置文件 |
| `.bashrc`、`.bash_profile`、`.bash_login`、`.bash_logout`、`.profile`、`.zshrc`、`.zshenv`、`.zprofile`、`.zlogin`、`.zlogout` | 之后的 shell 会执行它们 |

`*` 匹配一级目录，`**` 匹配一级或多级。

代价：`git init`、`git clone`、`git config`、`git submodule add` 要写 `.git/config` 或 `.git/hooks`，在沙箱内失败；`git status`、`add`、`commit`、`log`、`diff` 正常。这与 `@anthropic-ai/sandbox-runtime` 的默认做法一致（它也禁写 `.git/hooks` 与 `.git/config`）。是否给用户放开 `.git/config` 的开关，由 T39 决定。

## 4. 缓存目录方案

二选一的结论：**用环境变量把缓存指向会话临时目录**，不把用户目录下的缓存加入可写清单。

| 变量 | 值 |
|---|---|
| `TMPDIR` | 会话临时目录 |
| `XDG_CACHE_HOME` | `<会话临时目录>/cache` |
| `npm_config_cache` | `<会话临时目录>/cache/npm` |
| `CARGO_HOME` | `<会话临时目录>/cache/cargo` |
| `PIP_CACHE_DIR`、`GOCACHE`、`GOMODCACHE` | `<会话临时目录>/cache/{pip,go-build,go-mod}` |

理由：可写的共享缓存会让沙箱内的命令埋下之后在沙箱外运行的代码。最直接的例子是 `~/.cargo/registry/src` 中解开的 crate 源码：下一次不在沙箱里的 `cargo build` 会直接编译它、运行它的 `build.rs`，不做任何校验。npm 的内容缓存按完整性哈希寻址，风险小一些，但同样没有必要放开。

代价：

- 每个会话的第一次安装或构建是冷缓存（本机 `npm install is-number` 约 1.6 s，`cargo build` 拉一个 crate 约 6 s）。
- `CARGO_HOME` 换了位置，沙箱内读不到 `~/.cargo/config.toml`（镜像源设置）与凭据。凭据读不到是期望的；镜像源设置读不到会影响配置了国内镜像的用户，T39 决定是否把用户的 Cargo 配置（不含凭据）带进会话。
- xcrun（`/usr/bin/python3` 等命令行工具的转发器）在 `$TMPDIR` 下写缓存数据库；`TMPDIR` 不指向可写目录时它打印错误但仍能运行。

## 5. 网络代理

`piarc_sandbox::proxy::NetworkProxy`，hyper 1.12 的 HTTP/1 服务端与客户端：

- 只监听 `127.0.0.1`，端口随机；每个沙箱会话一个，会话关闭时停止，已建立的隧道和请求一并结束。
- 普通 HTTP 请求（绝对形式 `GET http://host/path`）改写成源形式转发，去掉逐跳头部；`CONNECT host:port` 建立 TCP 隧道。不解 TLS，判断依据只有客户端请求的主机名。
- 白名单：精确域名，或 `*.` 通配（任意层级的子域，不含域名本身）；不区分大小写，忽略末尾的点；默认为空，全部拒绝。
- 主机在白名单内才解析；任一解析结果是回环、未指定、链路本地（含 `169.254.169.254`）或已知的云元数据地址（`100.100.100.200`、`168.63.129.16`、`192.0.0.192`、`fd00:ec2::254`，含 IPv4 映射的 IPv6 形式）就拒绝。白名单里写的 IP 字面量同样检查。连接用的就是检查过的地址，不再解析第二次（防 DNS 重绑定）。
- 拒绝返回 `403 Forbidden`，`x-piarc-proxy-denied` 头给出类别（`not-allowed` 或 `blocked-address`），正文给出原因，例如 `PiArc sandbox proxy: evil.test is not in the sandbox network allowlist`；解析或连接失败返回 `502`。curl 对 `CONNECT` 的拒绝显示 `CONNECT tunnel failed, response 403`。
- 解析与连接经 `Network` trait：生产用系统解析器，测试把名字解析到文档地址段（203.0.113.0/24）再连到本机上游，代理的回环检查看到的是公网地址，字节不出本机。

沙箱内命令的环境：`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 及小写形式指向代理，`NO_PROXY`、`no_proxy` 置空，`NODE_USE_ENV_PROXY=1`（Node 24 的内置 `fetch` 只有设置它才读代理变量）。实测发现 Cargo 与 git 优先读用户 git 配置里的 `http.proxy`、npm 优先读 `.npmrc`，环境变量反而被盖过：本机的 git 配置指向另一个本地代理，`cargo build` 因此连到那个端口、被 Seatbelt 拦下。所以还要设置各工具自己的覆盖项：`CARGO_HTTP_PROXY`、`npm_config_proxy`、`npm_config_https_proxy`、`PIP_PROXY`，以及 `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` 写入 `http.proxy`、`https.proxy`（命令继承的 `GIT_CONFIG_*` 因此被替换）。

绕过代理的连接全部失败（第 7 节 A05）：不设代理变量连本机端口、`--noproxy` 直连、Python 直接 `connect` 公网 IPv4 与 IPv6、绑定本机端口、连 Unix socket（`/var/run/mDNSResponder`），都返回 `Operation not permitted`，测试用的监听端口一次连接都没收到。`open https://…` 也失败（沙箱里没有 LaunchServices）。不走 HTTP 代理的工具（ssh、数据库驱动）以及 UDP 在沙箱内都无法出网，这与 Claude Code 的沙箱相同。

TLS：配置没有放开 `trustd`、`ocspd` 等证书服务（它们会替调用者访问网络，能成为外传通道），实测 Apple git（`git ls-remote https://github.com/…`）、curl、cargo、Node 的 HTTPS 都正常。

## 6. 经 Core 执行

`ToolIo::open_sandboxed_session(会话, 工作区, cwd, SandboxSettings)` 创建会话临时目录、启动会话的代理、解析策略，登记为沙箱会话。之后该会话的 `exec/run`：

1. `SessionSandbox::launch()` 生成本条命令的配置，给出 `sandbox-exec` 参数与环境变量；
2. 环境 = Core 的白名单环境 + 请求的 `env` + 沙箱变量（同名以沙箱为准）；
3. `CommandRunner` 以 `Launcher` 包住 shell，经 `ProcessTreeSpawner` 启动。

`piarc-sandbox` 不启动进程，`piarc-exec` 不知道沙箱，二者经 `piarc-core` 编排（第 7.1 节）。输出流式回传、退出码、`exec/kill` 与连接断开时终止，都与普通 `exec/run` 相同；区别是终止作用于整个进程组。哪些会话走沙箱、Bash 工具的两种模式、沙箱外重试的审批由 T39 接入。

进程树（`ProcessTreeSpawner`）：

- macOS：子进程在 `fork` 与 `exec` 之间成为新进程组的组长（`process_group(0)`），终止与丢弃句柄时 `killpg(SIGKILL)`。丢弃发生在命令结束后，所以命令留在后台的进程也随之结束。`setsid` 或 `setpgid` 主动离开进程组的后代不受影响；它们仍在沙箱里，但会活下来，T17 决定是否需要更强的追踪。
- Windows：子进程以 `CREATE_SUSPENDED` 创建，放进设置了 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`、没有任何 breakaway 标志的 Job Object 后才恢复主线程，因此没有执行过一条指令就在 Job 里，后代都无法脱离。终止调用 `TerminateJobObject`；丢弃时关闭句柄，Job 中剩余进程全部结束。T12 启动 Agent Host、T17 的通用命令执行都应改用它（`PLAN.md` 登记事项）。

## 7. 验收结果

| 验收项 | 结果 | 证据 |
|---|---|---|
| A01 写入范围 | 通过 | `sandbox.rs::writes_stay_inside_the_writable_directories`：工作区（含新建子目录）、会话临时目录（含经 `$TMPDIR`）、附加目录写入成功；主目录、系统临时目录中的其他路径、`/tmp`、工作区外的兄弟目录均为 `Operation not permitted` 且文件不存在 |
| A02 受保护路径 | 通过 | `protected_paths_refuse_writes`：清单中 23 项在工作区顶层、嵌套子目录、附加目录三处，作为文件写入与在其下写入全部被拒；追加 `.git/config`、`mv .git`、`mv .git/hooks`、硬链接 `.git/config`、`mkdir .CLAUDE`、`rm -rf .git` 全部被拒，原文件不变 |
| A03 denyRead | 通过 | `deny_read_paths_are_unreadable`：工作区外的文件与工作区内的目录不可读、不可列出、不可改名；其他文件与 `/etc/hosts` 可读 |
| A04 代理白名单 | 通过 | `proxy.rs`：精确与通配、HTTP 与 `CONNECT` 各有放行与拒绝用例，拒绝返回 403、类别头与原因正文 |
| A05 绕过代理 | 通过 | `connections_around_the_proxy_fail`：见第 5 节；经代理访问白名单外域名得到 403 |
| A06 回环与元数据 | 通过 | `names_resolving_to_loopback_or_metadata_are_refused`：解析到 `127.0.0.1`、`::1`、`169.254.169.254` 的名字，以及白名单中的这些 IP 字面量，HTTP 与 `CONNECT` 都返回 403 `blocked-address` |
| A07 常见命令 | 通过 | `sandbox_commands.rs`（见第 8 节） |
| A08 经 Core 执行 | 通过 | `sandboxed_commands_stream_and_report_exit_codes`（第一块输出在命令结束前到达、退出码 7 与 stderr、通知通道关闭即终止）；`killing_a_sandboxed_command_leaves_no_process`：bash → sh → sleep 共 5 个进程，`exec/kill` 后响应 `killed: true`、`signal: 9`，`ps` 中该进程组为空（日志：`before kill, group 1605: [1605, 1608, 1610, 1616, 1617]`，`after kill … []`）；会话关闭后代理端口不再监听 |
| A09 空格与中文路径 | 通过 | 上述测试的工作区为 `piarc sandbox … 中文 …/ws 工作 区 [x](y)+`，附加目录为 `extra 附加`；配置快照与参数用例覆盖中文与 `[x]` 的转义 |
| A10 Job Object | 待 CI | `piarc-exec` 的 `tree::tests::windows`（父 cmd → 子 cmd → 孙 ping，关闭 Job 与终止 Job 两个用例）与 `job::tests`（无 breakaway 标志）只在 Windows 编译运行；本机无法编译 Windows 目标 |
| A11 测量 | 通过 | 第 9 节 |

## 8. 常见命令

白名单为 `registry.npmjs.org`、`index.crates.io`、`static.crates.io`；工作区路径含空格与中文。

| 命令 | 结果 | 耗时 |
|---|---|---|
| `git status --porcelain && git add -A && git commit -q -m … && git log --oneline` | 成功（仓库在沙箱外 `git init`） | 0.11 s |
| `python3 'tool 脚本.py'`（写文件、`tempfile`） | 成功，`tempfile.gettempdir()` 为会话临时目录 | 0.07 s |
| `cargo build --offline && ./target/debug/hello`（无依赖） | 成功 | 0.65 s |
| `cargo build`（依赖 crates.io 上的 `itoa 1.0.15`） | 成功，`Downloaded itoa v1.0.15` | 约 6 s |
| `npm install --no-audit --no-fund`（`is-number 7.0.0`）后 `node -e 'require(…)'` | 成功，`added 1 package` | 1.6–1.7 s |

需要网络的两项（cargo 拉依赖、npm install）在无法连到 registry 时失败并写明原因，不静默通过；其余三项不需要网络。另外手工核对：`git ls-remote https://github.com/…`、Node 内置 `fetch` 经代理都成功。

## 9. 测量数据

`cargo run -p piarc-sandbox --release --example s8-bench -- --iterations 300`（原始输出 `tmp/evidence/T11/s8-bench.txt`，不入库）：

| `/bin/bash -c true` | p50 | p95 |
|---|---|---|
| 直接运行 | 1.90 ms | 2.34 ms |
| `sandbox-exec`，每条命令生成配置 | 10.31 ms | 11.15 ms |
| 其中生成配置 | 0.03 ms | 0.04 ms |
| 额外耗时（按排名相减） | 8.41 ms | 8.82 ms |

额外耗时来自 `sandbox-exec` 本身：换成 `(version 1)(allow default)` 这样最小的配置，同样约 10.3 ms（p50），与配置大小无关。对模型发起的命令（通常数百毫秒以上）可以接受；如果以后要压低，方向是缓存编译后的配置，而不是精简规则。

| 一个新连接上的一次请求（本机上游） | p50 | p95 |
|---|---|---|
| 直连 | 0.09 ms | 0.14 ms |
| 经代理（绝对形式 HTTP） | 0.18 ms | 0.25 ms |
| 经代理（`CONNECT` 隧道） | 0.22 ms | 0.34 ms |

代理每个请求额外约 0.1 ms。64 MiB 下载：直连 4.0 GiB/s，经代理 HTTP 4.2 GiB/s，经 `CONNECT` 1.5 GiB/s，远高于实际网络。真实 registry 上的对比（同一文件直连与沙箱内各下几次）耗时在 1.6–12 s 之间波动，两种方式都有快有慢，差别由网络决定，不来自代理或沙箱。

## 10. Windows

- 第一版不提供 OS 级沙箱（需求 D7）：`platform_sandbox()` 在 Windows 返回 `None`，`open_sandboxed_session` 返回 `internalError`（"commands cannot be sandboxed on this platform"）。设置页的提示与不静默降级由 T39 实现。
- Job Object 实现在 `piarc-exec` 的 `job` 模块（safe 封装，`unsafe` 只在这个模块，编码规范 2.8），作为 `ProcessSpawner` 的 Windows 实现 `ProcessTreeSpawner`。
- 待 Windows CI：`cargo test -p piarc-exec` 中的三级进程树用例与 Job 标志用例。
- 待 W0 实机：Job Object 终止进程树（包括 T12 用它启动的 Agent Host 及其子进程、Agent Host 被杀时其子进程随之结束）。

## 11. 风险与遗留

- `sandbox-exec` 被 Apple 标为废弃（R10）：沙箱层在 `CommandSandbox` trait 后面，业务代码不分平台；macOS 26.5.2 上行为正常。
- 沙箱内不能绑定端口：启动本地服务器的测试（例如 supertest、`python -m http.server`）在沙箱内失败。是否增加"允许本机绑定"的选项由 T39 决定（放开绑定不影响出站白名单，`sandbox-runtime` 有同名选项）。
- 不能连 Unix socket：Docker、ssh-agent、数据库的本地 socket 不可用。
- `GIT_CONFIG_COUNT` 被沙箱占用，命令继承的同类变量失效。
- 代理只看主机名，不解 TLS：可能被 domain fronting 绕过；放行 `github.com` 等同于可以推送到任意仓库（与 `sandbox-runtime` 记录的局限相同）。

## 12. 结论

macOS：**通过**。按命令生成的 Seatbelt 配置把写入限制在工作区、会话临时目录与附加目录，受保护路径与 `denyRead` 生效；本地代理按白名单放行、拒绝回环与元数据地址，绕过代理的连接全部失败；git、npm install、cargo build、python 正常；停止后进程组为空。每条命令额外约 8.4 ms，代理每请求额外约 0.1 ms。

Windows：Job Object 已实现；三级进程树单测待 CI，实机（含 Agent Host 场景）待 W0。
