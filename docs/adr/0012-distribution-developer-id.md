# 0012. 分发走 Developer ID + 公证 + Sparkle，不上 Mac App Store

- 状态：已取代（2026-11-14 被 [ADR-0016](0016-packaging-signing-updates.md) 取代）
- 日期：2026-11-14
- 相关：架构文档第 13 章；`docs/research/native-stack.md` 第 7、9 章

## 背景

- Mac App Store 要求 App Sandbox，沙盒会被子进程继承；审核规则禁止下载或执行会改变应用功能的代码。PiArc 的核心能力是在用户选定的任意目录执行任意命令、启动 MCP server、安装插件包，两者冲突（原生技术栈调研 7.4 节）。
- 应用内嵌 Node、rg、fd 等可执行文件，都需要签名并通过公证。
- DMG 使用 ULMO 压缩时 Node 本体可从 119 MB 压到约 29 MB，估算 arm64 DMG 在 40–60 MB。

## 决策

1. macOS 通过 Developer ID 签名 + `notarytool` 公证 + staple，直接分发 DMG。
2. 自动更新使用 Sparkle 2（撰写时 2.10.1），EdDSA 签名更新包；更新是整包原子更新，Agent Host 和内嵌运行时不单独更新。
3. 按架构分包：arm64 为主，x86_64 单独提供（见 ADR-0007）。
4. 发布产物在 CI 中构建、签名、公证，签名凭据只存在于 CI 的密钥管理中。
5. Windows（第二阶段）倾向 Velopack + WinGet，暂不用 MSIX（AppData 虚拟化会让子进程看到的路径与宿主不一致）；届时另写 ADR 确认。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| Mac App Store | 分发与支付渠道 | 沙盒与核心能力冲突 | 否决 |
| Homebrew Cask 作为唯一渠道 | 开发者友好 | 普通用户门槛高，仍需签名公证 | 作为补充渠道 |

## 后果

- 正面：不受沙盒限制，可以完整实现 Agent 能力。
- 负面与代价：自建更新与分发基础设施；失去 App Store 的发现渠道。
- 需要配套做的事：M0 跑通一次完整的签名、公证、Sparkle 更新流程（包括内嵌 Node 的重签与 entitlements 验证）。

## 重新评估的触发条件

- Apple 调整 App Store 对开发者工具执行任意命令的政策；
- 需要面向企业的 MDM 分发（届时补充 pkg 安装包）。
