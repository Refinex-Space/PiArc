# piarc-web

WebFetch 的网络侧（架构第 6.1.4 节，ADR-0045）：SSRF 检查（`ssrf`）、钉住已检查地址的 HTTP/1.1 + TLS 抓取与同站重定向（`Fetcher`）、HTML 转 Markdown 与文本解码（`convert`）、规则匹配用的 URL 主机（`rule_host`）。`piarc-core::tool_io::web` 用它应答 AHP `web/fetch`。不做权限裁决、授权绑定与审计（Core），不调用模型（Agent Host 的 WebFetch 工具）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-web` | SSRF 表驱动单测（每个网段、IPv6、映射与内嵌形式、允许列表）、转换单测（脚本剔除、字符集、二进制拒绝、按字符截断）、`tests/fetch.rs`（本地 HTTP 服务器 + 按名字给地址的解析器：内网拒绝、混合地址整体拒绝、重定向后重绑定、同站跟随与跨站返回、上限、超时、取消） |
| `cargo clippy -p piarc-web --all-targets -- -D warnings` | lint |

## 不变量

- 只连接 `ssrf::check` 返回的地址，连接时不再解析主机：这是防 DNS 重绑定的唯一手段，改连接代码时保持"解析 → 检查 → 按 IP 连接"的顺序；每一跳（包括同站重定向）都重新解析并检查。
- 一个主机解析出的地址里只要有一个被拒，整个主机被拒（不挑公网地址连接）。允许列表只来自 `CoreConfig.web`，不要从项目设置读。
- 规则与 hooks 匹配的主机一律用 `rule_host`，与 `Fetcher` 用同一个 URL 解析器（`url` crate）；不要在别处手写 URL 拆分。
- 上限只在 `FetchLimits`（默认 10 MiB、100,000 字符、60 s、10 次重定向）。超限的正文截断并标记，超时与重定向过多报错；错误消息写给模型看（`to_error_object`，`details.reason` 区分原因）。
- TLS 用 rustls 的 ring 实现与 `rustls-platform-verifier`（系统信任库）。不要打开 rustls 的默认特性（会引入 aws-lc-rs）。

## 易错点

- 请求带 `Accept-Encoding: identity`，服务器仍返回压缩体时报 `unsupportedEncoding`；不走 HTTP 代理（I112）。
- htmd 跳过 `head`，所以页面标题不进正文；`<title>` 之外的内容按 turndown 风格转换。
- `tests/fetch.rs` 的跨站重定向用同一台服务器的 `127.0.0.1` 与另一个测试主机名，不要换成 `localhost`（解析结果因机器而异）。
- Windows 交叉 clippy（根 `AGENTS.md` 的命令）靠 C 占位编译 ring，只检查不链接。
