# 0016. 打包、签名与更新：Electron Forge；macOS Developer ID + 公证 + 内置更新；Windows 签名安装包；不上应用商店

- 状态：已接受
- 日期：2026-11-14
- 取代：[ADR-0012](0012-distribution-developer-id.md)
- 相关：架构文档第 10.3、13 章；`docs/research/electron-stack.md` 第 2.2、3、5 节；`docs/research/native-stack.md` 第 7、9 章

## 背景

ADR-0012 为原生 macOS 应用选了 Developer ID + 公证 + Sparkle，不上 Mac App Store；Windows 当时留到第二阶段。客户端改为 Electron（ADR-0013）后，两个平台要同时出包，更新机制也要换成 Electron 体系内的方案。

仍然成立的约束：

- Mac App Store 要求 App Sandbox，沙盒会被子进程继承，与"在用户选定目录执行任意命令、启动 MCP server、安装插件包"冲突。Microsoft Store 的 MSIX 包有 AppData 文件虚拟化问题，子进程看到的路径会与宿主不一致。
- 应用内嵌 Node、rg、fd、Core 的 `.node` 等可执行文件，全部需要签名。

调研事实（2026-11-14）：

- **打包工具**：Electron Forge 8.0.1 是官方工具，Vite 插件已转为稳定版，自带 fuses 插件，会自动写入 ASAR 完整性信息。electron-builder 26.18.0 功能更多，但官方文档明确说它 "do not come with official support from the Electron project"。
- **macOS 更新**：Electron 内置的 `autoUpdater`（Squirrel.Mac）要求应用已签名，只接受 ZIP。从 Electron 45 起支持断点续传、`sha256` 校验和 Sparkle `BinaryDelta` 增量包；可以读取静态存储上的 JSON feed。Claude Desktop 用的就是它（本机看到 bundle 中有 Squirrel.framework）。
- **Windows 安装与更新**：
  - Squirrel.Windows 上游最后一个版本是 2020 年的 2.0.1。
  - Velopack（GitHub 最新 1.2.161）支持按用户安装、不弹 UAC、增量更新，官方有基于 Forge 的 Electron 指南，但在 Vite 下有集成问题报告。
  - MSIX 有 Forge maker，Electron 内置 `autoUpdater` 也支持 MSIX；Claude Desktop 在 Windows 上提供按用户安装的 MSIX（x64、arm64）和 `ClaudeSetup.exe`。
- **Windows 签名**：
  - 从 2024 年起，EV 证书不再能直接消除 SmartScreen 警告，信誉要靠固定的签名身份慢慢积累。
  - Azure Artifact Signing 的 Public Trust 只面向部分国家和地区的组织，不含中国大陆；个人开发者只限美国和加拿大。
- **Electron fuses**（@electron/fuses 2.1.3）共 9 个，在签名前写入 Electron 二进制。Claude Desktop 关闭了 `RunAsNode`、`NodeOptions`、`NodeCliInspect`，开启了 ASAR 完整性校验和 `OnlyLoadAppFromAsar`（本机实测）。

## 决策

1. **构建与打包统一用 Electron Forge**（`plugin-vite`、`plugin-fuses`、`plugin-auto-unpack-natives`），版本精确锁定。
2. **fuses**（`strictlyRequireAllFuses: true`，Electron 新增 fuse 时构建会失败，必须显式决定）：

   | fuse | 设置 | 原因 |
   |---|---|---|
   | `RunAsNode` | 关 | 防止应用被当作通用 Node 运行；Agent Host 不依赖它（ADR-0015） |
   | `EnableNodeOptionsEnvironmentVariable` | 关 | 防止经 `NODE_OPTIONS` 注入代码 |
   | `EnableNodeCliInspectArguments` | 关 | 防止经 `--inspect` 附加调试器 |
   | `EnableEmbeddedAsarIntegrityValidation` | 开 | 校验 app.asar 完整性 |
   | `OnlyLoadAppFromAsar` | 开 | 与上一项配合，否则可以绕过 |
   | `EnableCookieEncryption` | 开 | 用系统密钥加密 cookie |
   | `GrantFileProtocolExtraPrivileges` | 关 | 界面用自定义协议提供，不用 `file://` |
   | `LoadBrowserProcessSpecificV8Snapshot` | 关 | M0 测量启动收益后再决定 |
   | `WasmTrapHandlers` | 保持默认（开） | 无安全上的理由关闭 |

   开发构建可以放开 `NodeCliInspect` 以便调试；发布构建的 fuse 配置在 CI 中校验。
3. **macOS**：
   - Developer ID 签名（hardened runtime，主应用 entitlements 只有 `allow-jit`，每项在 `apps/desktop/build/entitlements.md` 中写明用途）+ `notarytool` 公证 + staple；
   - 出 DMG 和 ZIP 两种包，按架构分包（arm64 为主，x64 见需求 D6）；
   - 自动更新用 Electron 内置 `autoUpdater`，读取静态存储上的 JSON feed，带 `sha256` 校验；增量包作为后续优化。
4. **Windows**：
   - 按用户安装，不要求管理员权限；
   - 安装与更新方案由 M0 的两天 spike 决定，候选 Velopack 与 MSIX，默认倾向 Velopack（没有 MSIX 文件虚拟化问题，有增量更新）；
   - Velopack 与 Forge/Vite 集成问题过多时，退回 electron-builder 的 NSIS + electron-updater，接受第三方工具的风险；
   - 签名：签名主体符合 Azure Artifact Signing 资格时用它；不符合时用 OV 证书，私钥放在云 HSM；不为 SmartScreen 购买 EV 证书。签名身份长期保持不变，以积累信誉；
   - WinGet 作为补充渠道，Beta 后提交。
5. **不上 Mac App Store 与 Microsoft Store。** Homebrew Cask 作为 macOS 的补充渠道。
6. **整包原子更新。** Agent Host、内置 Node、Core 不单独更新。发布产物在 CI 中构建、签名、公证，签名凭据只存在于 CI 的密钥管理中。
7. **Electron 版本**：只使用官方仍在支持期内的大版本（官方支持最新 3 个大版本，8 周一个），至少每季度升级一次；出现在野利用的高危漏洞时立即发版。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| electron-builder + electron-updater 作为主工具 | 功能全，NSIS 与多种更新源成熟 | 非官方支持；替换了 Electron 自身的更新器 | Windows 的退路 |
| Mac App Store / Microsoft Store | 发现与支付渠道 | 沙盒或文件虚拟化与核心能力冲突 | 否决 |
| Windows 只用 MSIX | 系统级安装与更新，企业部署方便 | AppData 虚拟化让子进程路径不一致；Win11 才有的特性多 | M0 对比后再定；企业部署需要时可补充 |
| 保留 Sparkle | 原方案熟悉 | 不属于 Electron 体系，需要额外原生集成 | 否决（Electron 内置更新器已支持 Sparkle 格式的增量包） |

## 后果

- 正面：两个平台用同一套打包工具；fuses 与 ASAR 完整性由官方工具处理；macOS 更新路径与 Claude Desktop 相同，成熟可靠。
- 负面与代价：
  - 要自建更新存储与发布流水线；
  - Windows 签名主体资格可能限制可选方案；
  - SmartScreen 信誉需要时间积累，早期用户会看到警告；
  - 跟随 Electron 大版本升级是硬性的持续工作。
- 需要配套做的事（M0 S6）：
  - 两个平台各跑通一次完整的签名、公证（macOS）、安装、更新流程；
  - 确定 entitlements 与 fuses 的最终配置；
  - 完成 Windows 安装方案 spike 并补充本 ADR 的结论。

## 重新评估的触发条件

- Apple 或微软调整应用商店对开发者工具执行任意命令的政策；
- Windows spike 中 Velopack 与 MSIX 都无法满足按用户安装、增量更新、签名校验三项要求；
- 需要面向企业的 MDM / Intune 分发（届时补充 pkg 与 MSIX 包）；
- Forge 停止维护或与 Electron 新版本长期不兼容。
