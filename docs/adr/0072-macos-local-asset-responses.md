# 0072. macOS 通过原生缓冲区交付本地应用资源

- 状态：已接受（2026-11-24，按本次 M4 收尾授权作出的补充决策）
- 相关：架构第 10.3、11 章，I192、I222，ADR-0016、ADR-0018

## 背景

在 M1 Max、32 GB 上，以打包开发构建与同版本空白 Electron 窗口对照，主进程空闲 RSS 增量为 35.09 MB，预算为 24 MB。空首页按需创建 Markdown 和高亮 Worker 后，同一测量为 32.83–33.13 MB。进一步使用 `protocol.handle` 和 `net.fetch` 流式读取、剥除 Core 本地符号后仍为 28.62–28.84 MB。另行试验针对体积的原生薄链接优化，该传输下仍为 27.61–27.62 MB。

## 决定

1. macOS 使用锁定版本 Electron 的 `protocol.registerBufferProtocol` 把已经读取的本地资源直接交给 Chromium，Windows 保持 `protocol.handle`。两个适配器共用一个处理函数，沿用应用 origin、路径约束、GET/HEAD、MIME、CSP 和 `nosniff`。缺失或越界资源返回 404，其他方法返回 405。
2. macOS 打包时对开发、发布两种 Core 副本使用同一套本地符号剥除操作，再按现有层次签名。`build:core` 的产物保留符号。内置 Node 继续使用官方签名。
3. macOS 使用缓冲区和剥除符号的比较中，保留原有窗口位置恢复逻辑时两次实测为 22.79、22.95 MB。用于定位的签名开发包和结果记录在 `tmp/evidence/partial-closure/` 的 `buffer-no-screen-optimization-*` 与 `forge-idle-*`。

## 代价与复核

Electron 已将缓冲区协议 API 标为弃用并推荐 `protocol.handle`。本决策限定在 macOS 和应用自身的静态资源，保留该调用处的一行 lint 例外。在升级 Electron 时，先尝试用推荐 API 达到原预算，再复查正常页面、GET/HEAD、错误响应的安全头、外链拦截及签名产物。不得用 `file:` 导航、放宽 CSP、关闭 fuse 或修改预算来替代复核。[Electron 45.3.2 协议文档](https://github.com/electron/electron/blob/v45.3.2/docs/api/protocol.md#protocolregisterbufferprotocolscheme-handler-deprecated)
