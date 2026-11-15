# 0015. Agent Host 继续使用单独内置的 Node LTS，不复用 Electron 自带的 Node

- 状态：已接受（第 5 条"签名"已被 [ADR-0018](0018-unsigned-distribution.md) 修订：内置 node 保留 Node.js 官方签名，不重签）
- 日期：2026-11-14
- 取代：[ADR-0003](0003-embedded-node-runtime.md)
- 相关：架构文档第 5.6、6.10、10.3、13 章；`docs/research/electron-stack.md` 第 2 节、`docs/research/pi-v1.4.0-baseline.md`

## 背景

ADR-0003 决定随应用内置 Node LTS 运行 Agent Host。客户端改为 Electron 后（ADR-0013），Electron 自带一份 Node（Electron 45.3.x 内置 Node 24.22.x，满足 Pi 的 ≥ 22.19 要求），于是要重新判断：能否省掉这份约 119 MB 的 Node。

Agent Host 的硬性要求：

1. 在 macOS 上运行于 Seatbelt 配置之下（ADR-0004 的第二道防线）；
2. 与 Core 之间走 stdio 上的 AHP（ADR-0009）；
3. MCP stdio server 大量用 `npx` 启动，Pi 的插件包安装也调用 npm，子进程需要可用的 `node` / `npm` / `npx`；
4. Agent Host 的 Node 版本不应被 Electron 的升级节奏牵着走。

调研事实（2026-11-14）：

- **`utilityProcess.fork`**：stdin 只能是 `ignore`；进程由 Chromium 的 ServiceProcessHost 拉起，没有包装器入口，无法单独套 `sandbox-exec`，源码注释写明它目前不在沙箱中。
- **`ELECTRON_RUN_AS_NODE`**：能套 Seatbelt，但必须保留 `RunAsNode` fuse，违反 Electron 官方安全清单第 19 条（Claude Desktop 关掉了这个 fuse）。fuse 写在 Electron Framework 二进制里，所有 helper 共用，不能只为某个进程打开。主可执行文件的 entitlements 也会作用到 Agent Host 及其子进程。
- **npm / npx**：Electron 不带 npm/npx。非 Node-API 的原生模块按 Node ABI 预编译，在 Electron 里加载不了。
- **版本节奏**：Electron 46（暂定 2027-01-05）会把内置 Node 升到 26.13。
- **同类做法**：Cursor 3.30.14 单独带了 node v24.22.1（122.5 MB），并把它加到 MCP 子进程的 PATH 前面；Claude Desktop 用 `/usr/bin/sandbox-exec -p` 包装启动自家原生 helper。两者都是本机实测。
- **ADR-0003 中仍然成立的事实**：Node 24 + Pi bundle 冷启动 250–300 ms、RSS 约 120 MB；Bun 编译版约 99 MB、RSS 约 90 MB，但不能给 `npx` 用；Node 官方 macOS 二进制需要重签才能公证。

## 决策

1. **随应用内置完整的 Node LTS 发行包**（node + npm + npx），版本与当时 Electron 内置的 Node 同一大版本（撰写时为 24.22.3），写在构建清单中。
2. **由 Core 直接启动 Agent Host**，不经过 Electron：
   - macOS：`/usr/bin/sandbox-exec -f <profile> -D …参数… <内置 node> agent-host.mjs`；
   - Windows：`CreateProcess` 启动，把进程挂进 Job Object（设置 `KILL_ON_JOB_CLOSE`）；
   - Core 自己持有 stdio 管道。
3. **Electron 应用自身关闭 `RunAsNode`、`EnableNodeOptionsEnvironmentVariable`、`EnableNodeCliInspectArguments` 三个 fuse**（完整 fuse 配置见 ADR-0016，现由 ADR-0018 沿用）。Agent Host 不依赖 Electron 二进制，这些 fuse 可以放心关闭。
4. **Agent Host 的 JS bundle 和 Pi 运行时资源放在 asar 之外**（`Resources/agent-host/`），因为独立的 node 读不了 asar。这些文件的完整性由代码签名保证；Seatbelt 配置放行对它们的读取。
5. **签名**：内置 node 用 PiArc 的签名身份重签，开启 hardened runtime，entitlements 从 `com.apple.security.cs.allow-jit` 开始，按 M0 结果逐项增加并写明原因。只有确认需要加载第三方原生模块时，才给这个 node 单独加 `disable-library-validation`，不影响主应用。
6. **内置的 node/npx 提供给 MCP stdio server 和 Pi 插件包安装使用**：Core 启动这些子进程时把内置 Node 的 `bin` 目录放在 PATH 最前面。
7. 沿用 ADR-0003 的其余做法：关闭 Pi 的自更新与版本检查，Agent Host 只随应用整体更新；预置 `rg`、`fd`，避免 Pi 运行时下载。
8. **安全更新**：Node LTS 发布安全版本时，在下一个补丁版本中跟进。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| A1：`utilityProcess.fork` 运行 Agent Host | 不多带 Node；Electron 管理生命周期 | 无法套 Seatbelt；不能走 stdio；没有 npm/npx；Node 版本随 Electron 变化 | 否决；可用于受信任的内部 helper |
| A2：`ELECTRON_RUN_AS_NODE` 启动 Electron 自身 | 能套 Seatbelt，能走 stdio | 必须保留 `RunAsNode` fuse；主应用 entitlements 外溢到 Agent Host；仍需另带 npm；原生模块 ABI 不匹配 | 否决 |
| Bun `--compile` | 体积与内存略小 | 不能给 `npx` 和 Pi 插件包安装使用 | 否决（ADR-0003 中的对照项，结论不变） |
| 依赖用户机器上的 Node | 安装包最小 | 版本不可控，首次使用门槛高 | 否决 |

## 后果

- 正面：
  - Agent Host 可以套 Seatbelt、走 stdio；
  - Electron 的高风险 fuse 可以全部关闭；
  - MCP 与插件包生态开箱即用；
  - Agent Host 的 Node 版本独立于 Electron。
- 负面与代价：
  - 每个架构的安装包多出约 119 MB（压缩后约 28–38 MB），与 Electron 自带的 Node 在功能上重复；
  - 要跟进 Node LTS 的安全版本；
  - 需要单独签名并维护 node 的 entitlements；
  - Agent Host 资源在 asar 之外，不受 ASAR 完整性校验覆盖，只靠代码签名。
- 需要配套做的事（M0 S6）：
  - 在 Seatbelt 配置下跑通 Pi 的 bash/grep/find、git、`npx` 拉起 MCP server 与 worker_threads；
  - 确认 Pi 在独立目录布局下的资源定位（是否需要 `PI_PACKAGE_DIR`）；
  - 研究 Core 启动的子进程在 macOS TCC 上的责任归属；
  - 测量安装包增量。

## 重新评估的触发条件

- Electron 提供可以单独套沙箱、支持 stdin 的子进程方式，且 Agent Host 不再需要 npm/npx；
- 内置 Node 无法公证，或需要过宽的 entitlements；
- 实测多会话场景下 Agent Host 内存超出预算 30% 以上；
- Pi 上游放弃 Node 支持。
