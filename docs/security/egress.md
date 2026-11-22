# 外连与遥测

PiArc 没有遥测：没有上报代码，也没有遥测开关（架构第 10.5 节"遥测默认关闭"由此成立）。会话内容只发往用户配置的模型服务商与 MCP server；其余外连要么由用户的明确操作发起，要么已关闭。本页逐项列出 PiArc 及其组件可能发起的外连，以及测试怎样证明一次完整的 mock 会话里没有别的连接（T45-A09）。

## 1. 测试

| 测试 | 观察点 | 结论 |
|---|---|---|
| `crates/piarc-testkit/tests/egress.rs` 的 `thr04_a_whole_mock_session_connects_only_to_the_model_provider` | Agent Host 按应用中的方式运行（不设 `PI_OFFLINE`），包装模块订阅 Node 的 `diagnostics_channel`（`net.client.socket`、undici 的 `client:connected`、`http.client.request.start`），把每个连接写进 `<数据目录>/agent-host/egress.jsonl`；会话做一个回合：Bash 命令、stdio MCP server 的工具调用、回复 | 全部连接都指向 mock 服务商（127.0.0.1） |
| `apps/desktop/e2e/t45-egress.e2e.ts` 的 `THR-04 a whole mock session makes no outbound connection from Electron` | 全新用户数据目录，带 `--log-net-log` 启动；打开工作区、建会话跑一个回合、打开设置窗口的四个页面；Chromium 的 net log（主进程与渲染进程的请求、Chromium 自己的后台请求）与主进程 Node 层的连接；用一次经 Electron `net` 到 mock 服务商的环回请求证明 net log 能记录请求 | 只有环回目标；macOS 上没有拼写检查词典下载 |

Core（Rust）在这次会话里不发起连接：它的网络出口只有下表的 WebFetch、WebSearch 第三方后端与沙箱代理，三者都只在工具调用或沙箱命令时才连接，测试中的会话没有用到。

## 2. 外连清单

| 外连 | 由谁发起 | 发出什么 | 何时 | 状态 |
|---|---|---|---|---|
| 模型服务商 | Agent Host（pi-ai） | 会话内容 | 每次模型请求 | 用户配置；本页测试中是 mock |
| MCP server（HTTP 传输）及其 OAuth | Agent Host 的连接池 | 工具调用参数与结果 | 用户配置的 server | 用户配置；stdio server 不经网络 |
| hooks 的 `http` 类型与命令 | Core | hook 输入 | 用户与受信任项目配置的 hook | 用户配置 |
| WebFetch | Core（`piarc-web`） | 请求的 URL | 获准的工具调用 | 每次经权限裁决，SSRF 检查 |
| WebSearch 第三方后端 | Core（`piarc_web::search`） | 搜索词 | 获准的工具调用 | 用户保存 key 后才有 |
| 沙箱代理 | Core（`piarc-sandbox`） | 沙箱内命令自己的流量 | 沙箱命令联网 | 白名单外的主机询问 |
| 扩展包安装与更新 | Core（内置 npm、git） | 包名与版本 | 用户安装或更新 | 用户操作；`--ignore-scripts` |
| Pi 的远程模型目录 `https://pi.dev/api/models/providers/<id>` | Agent Host（Pi `ModelRuntime`） | 服务商 id，不含会话内容 | 只对配置了凭据的内置服务商，每个至多 4 小时一次 | 默认开启，`modelProviders.catalogRefresh: false` 关闭；mock 会话里没有内置服务商的凭据，不发生 |
| Chromium 拼写检查词典 | Electron（Hunspell） | 语言代码 | Windows 与 Linux 首次需要某语言的词典时，从 Google 的 CDN（`redirector.gvt1.com`）下载 | 保留：只取词典文件，不含会话内容；macOS 用系统拼写检查，不下载。Windows 的 L4 允许这个主机 |
| Chromium 的 IPv6/IPv4 可达性探测 | Electron（网络服务的主机解析器） | 不发数据：对 `[2001:4860:4860::8888]:443` 的 UDP `connect()` 只用来确定本机路由 | Chromium 的网络栈第一次解析主机名时 | 保留：没有数据包离开本机；`t45-egress` 只在该套接字没有发送字节时把它当作探测 |
| 应用更新检查 | 主进程 | 版本号 | 启动与每 24 小时 | 尚未实现（T50），实现后补入本表与测试 |

## 3. 已关闭的外连

| 外连 | 关闭方式 | 证据 |
|---|---|---|
| Pi 的版本检查（`pi.dev/api/latest-version`） | Core 给 Agent Host 固定设 `PI_SKIP_VERSION_CHECK=1`；SDK 路径本来也不调用 | `crates/piarc-host/src/config.rs` 的 `passes_only_named_variables_and_the_fixed_ones` |
| Pi 的安装遥测（`pi.dev/api/report-install`） | 固定设 `PI_TELEMETRY=0`；只在 Pi 的交互模式触发 | 同上 |
| Pi 按自己设置的 `packages` 自动安装（npm、git） | Agent Host 的设置读取不交出 `packages`（T45） | `agent-host/src/runtime/pi-settings.test.ts`、L2 `sec-pi-settings-packages` |
| Pi 下载 rg、fd | Pi 原生工具不加载；打包产物内置 rg、fd 且排在 PATH 前面 | `agent-host/src/tools/index.ts`、`check-app-layout.mjs` |
| Pi 的会话分享、bug report 上传、包更新检查 | 只在 Pi 的交互模式与 CLI，SDK 路径不加载 | Pi 1.5.2 `main.js` 的 `builtInExtensions` |
| Electron 的 Safe Browsing、component updater、WebRTC 日志上传 | Electron 45 不带这些服务（`browser_process_impl.cc` 返回空实现） | Electron 源码，`docs/tutorial/sandbox.md` |
| npm 的自更新提示 | Agent Host 环境 `npm_config_update_notifier=false` | `crates/piarc-core/src/agent_host.rs` 的 `agent_host_env` |

## 4. 维护

新增任何外连（新的服务、更新检查、遥测）时，在第 2 节加一行，写明发出的内容与开关，并让 `t45-egress` 或 `egress.rs` 覆盖它；把它登记到 `tests/security/threats.yaml` 的 THR-04。
