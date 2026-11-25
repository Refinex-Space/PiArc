# 0082. Agent Host 的网络代理

- 状态：已接受（用户在会话中要求新增“代理”设置）
- 日期：2026-11-25
- 来源：用户要求设置页新增“代理”，可手动填写或自动检测，默认自动检测，用于解决 Pi 访问 OpenAI 订阅等服务商时的地区限制；对应 Pi CLI 的 `settings.json` 中的 `httpProxy`
- 相关：ADR-0021、0035、0062；架构第 5.5、8.2、10 节；`docs/security/egress.md`

## 背景

Agent Host 只带白名单里的环境变量启动（`piarc_host::DEFAULT_ENV_PASSTHROUGH`），白名单里没有代理变量，所以无论用户的系统或终端怎么设置，模型请求和服务商登录都直连。Pi 的 `httpProxy` 设置只在它自己的 CLI 入口生效：入口把它写进 `HTTP_PROXY`、`HTTPS_PROXY`，再装上 undici 的 `EnvHttpProxyAgent`。PiArc 经 SDK 使用 Pi，不经过那个入口，相关函数也没有从包入口导出（项目只允许用包入口）。

Node 24 自带 `NODE_USE_ENV_PROXY=1`：带上它，内置 `fetch` 按 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 走代理。pi-ai 访问 Codex（ChatGPT 订阅）用的 WebSocket 传输也读这几个变量。内置的 Node 24.22.3 与开发用的 Node 24.13.1 都已实测支持。

## 决策

1. **设置。** 用户级 `settings.json` 新增 `proxy: { mode: "auto" | "manual", url? }`，缺省为 `auto`。设置页“代理”用分段控件选“自动检测 / 手动设置”：自动时显示检测到的系统代理，并可重新检测；手动时填写地址后保存。
2. **地址。** 只接受 `http://` 或 `https://` 加主机和可选端口，不接受 SOCKS、路径，也不接受用户名和密码（凭据不进设置文件和进程环境，架构第 10 节）。Core 的 `network::check_url` 是最终裁决，渲染进程的 `proxyUrlProblem` 只用来即时提示。
3. **自动检测。** 主进程用 Electron 的 `session.resolveProxy` 按模型服务商的地址解析系统代理（系统设置与 PAC），取第一个 HTTP/HTTPS 代理，SOCKS 跳过，`DIRECT` 即为直连。启动时解析一次，窗口获得焦点时至多每 30 s 再解析，设置页可以要求立即重新解析（IPC `detectProxy`）。结果经 NAPI `setSystemProxy` 交给 Core。
4. **生效。** Core 每次启动 Agent Host（工作区的 Agent Host，以及服务商设置与登录用的 Agent Host）时，按生效的代理加上 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY=localhost,127.0.0.1,::1` 与 `NODE_USE_ENV_PROXY=1`。本机地址（本地模型、测试用 mock）始终直连。不改 Pi 的设置文件，也不改 AHP。
5. **变更。** 生效的代理变化时（系统代理变了，或用户改了设置），工作区的 Agent Host 在空闲时停止并立即启动新进程，打开中的会话在新进程上恢复，与空闲回收后再启动的路径相同；有回合在运行、请求在途或进程还在启动时，先记下，空闲或就绪后再重启，不打断回合。
6. **托管。** `/proxy` 与其他用户设置一样受托管锁（T47）约束。

## 不采用

- 写 Pi 的 `pi/settings.json` 的 `httpProxy`：SDK 路径不读它，写了也不生效。
- 在 Agent Host 里引入 undici，自己装全局分发器：要新增直接依赖，还要处理 Node 内置 `fetch` 与 npm 版 undici 混用的问题（Pi 的注释提到 Node 26 下的压缩问题）。环境变量方案用 Node 自带能力即可。
- 在 Core 里读系统代理（注册表、`scutil`）：读不了 PAC，Electron 的解析覆盖得更全。
- 支持带用户名和密码的代理：需要把凭据放进保险箱，再在启动时单独注入，先不做。
