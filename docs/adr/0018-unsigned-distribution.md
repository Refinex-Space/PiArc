# 0018. 不做平台代码签名：macOS 只做 ad-hoc 签名，Windows 不签名，更新与凭据存储随之调整

- 状态：已接受
- 日期：2026-11-14
- 取代：[ADR-0016](0016-packaging-signing-updates.md)
- 修订：[ADR-0015](0015-agent-host-runtime-bundled-node.md) 第 5 条（内置 node 的签名）
- 相关：架构文档第 5.6、7.3、8.8、9.1、10、13、15、16 章；需求 D2、D8；`docs/research/electron-stack.md` 第 5 节

## 背景

PiArc 免费开源，不上应用商店。2026-11-14 产品负责人决定：不加入 Apple Developer Program，也不做 Windows 代码签名。ADR-0016 中依赖签名的部分（公证、Electron 内置更新器、签名安装包）因此需要重定。

事实（2026-11-14）：

- **macOS 首次打开**：
  - Apple silicon 上原生代码至少要有 ad-hoc 签名才能运行，打包工具会自动完成；没有 Developer ID 就不能公证。
  - 从网上下载的应用带隔离属性。macOS 15 起取消了"右键 → 打开"的绕过方式，用户要先打开一次被拦下，再到"系统设置 → 隐私与安全性"点"仍要打开"并输入管理员密码。
  - 有报告称完全没有签名的应用在 macOS 15.1 上不出现"仍要打开"按钮；ad-hoc 签名应用的表现要实测。终端执行 `xattr -dr com.apple.quarantine` 可以作为备选。
- **macOS 更新与系统能力**：
  - Electron 内置的更新器（Squirrel.Mac）要求应用已签名，ad-hoc 签名不满足。
  - Electron 42 起系统通知改用 `UNNotification`，要求应用已签名；ad-hoc 签名是否满足未确认。
  - 钥匙串条目和"文稿""桌面"等文件夹的授权（TCC）都绑定应用的代码身份。ad-hoc 签名的身份就是代码哈希，每次发版都会变，所以每次更新后系统会再次请求授权。
- **Homebrew**：官方 cask 仓库在停用通不过 Gatekeeper 检查的 cask，`--no-quarantine` 参数已取消。来源主要是 GitHub issue 与博客，未见正式公告。
- **Windows**：
  - 未签名程序会触发 SmartScreen 警告，用户可以选"更多信息 → 仍要运行"。签名后也要积累信誉，警告不会立刻消失。
  - 开启"智能应用控制"的电脑会直接拦截未签名程序，没有单次放行的选项。
  - Velopack 不签名也能打包和更新，官方提醒未签名应用可能被杀毒软件误报。MSIX 必须签名。
- **免费的 Windows 签名**：SignPath Foundation 为符合条件的开源项目（OSI 许可证、公开仓库、CI 自动构建、不含闭源组件）免费签名，证书署名是 SignPath Foundation。

## 决策

1. **打包工具与 fuses 沿用 ADR-0016 的做法。**
   - 构建与打包统一用 Electron Forge（`plugin-vite`、`plugin-fuses`、`plugin-auto-unpack-natives`），版本精确锁定。
   - fuses 设置不变（`strictlyRequireAllFuses: true`）：关闭 `RunAsNode`、`EnableNodeOptionsEnvironmentVariable`、`EnableNodeCliInspectArguments`、`GrantFileProtocolExtraPrivileges`；开启 `EnableEmbeddedAsarIntegrityValidation`、`OnlyLoadAppFromAsar`、`EnableCookieEncryption`；`LoadBrowserProcessSpecificV8Snapshot` 关闭，等 M0 测量后再定；`WasmTrapHandlers` 保持默认。
   - macOS 上写入 fuses 会破坏原有签名，所以打包时开启 `resetAdHocDarwinSignature`，重新做 ad-hoc 签名。
   - 没有平台签名时，ASAR 完整性信息本身不受保护（macOS 存在 Info.plist，Windows 存在 exe 资源中），只能防意外损坏，防不了篡改。
2. **macOS**：
   - 只做 ad-hoc 签名，不公证。hardened runtime 在 ad-hoc 签名下能否启用，在 M0 验证：库验证要求同一 Team ID，可能需要关闭库验证。不能启用时就不启用，并记入威胁模型。
   - 内置 node 保留 Node.js 官方的签名，不重签（修订 ADR-0015 第 5 条）。rg、fd 和 `.node` 原生模块用 ad-hoc 签名。
   - 出 DMG 与 ZIP，按架构分包。
   - **首次运行指引**写在下载页和 README 中：
     - 先把应用拖到"应用程序"文件夹再打开，避免从下载目录运行时被系统挪到随机的只读路径（App Translocation）；
     - 被拦下后到"系统设置 → 隐私与安全性"点"仍要打开"；
     - 按钮不出现时，执行 `xattr -dr com.apple.quarantine /Applications/PiArc.app`，并说明这条命令的含义：它会跳过系统对这个应用的来源检查。
   - **更新**：不使用 Electron 内置更新器。主进程在启动时和之后每 24 小时查询一次发布清单；发现新版本时在应用内提示，并给出更新说明；用户点击后打开下载页，自行下载替换。第一版不做应用内自动替换，以后要做时另写 ADR。
3. **Windows**：
   - 不签名。安装与更新用 Velopack，按用户安装，不要求管理员权限；MSIX 需要签名，不再考虑。
   - Velopack 与 Forge/Vite 的集成问题过多时，退回 electron-builder 的 NSIS + electron-updater，同样不签名。
   - **首次运行指引**：SmartScreen 提示时选"更多信息 → 仍要运行"。开启智能应用控制的电脑无法运行 PiArc；文档如实说明原因和关闭这项功能的后果，由用户自己决定，PiArc 不主动引导用户关闭系统安全功能。
   - 发布前用 Microsoft Defender 扫描产物；出现误报时向微软提交样本。
4. **发布完整性**：作为没有平台签名时的最低保障。
   - 每个版本发布一份清单，包括版本号、各平台文件名和 SHA-256。清单用项目自有的 Ed25519 密钥签名（minisign 格式），公钥内置在应用里，也公布在 README 中。
   - macOS 的更新提示和 Windows 的 Velopack 更新，都必须先验证清单签名与文件哈希，验证失败就拒绝更新。Velopack 的接入方式在 M0 验证。
   - 私钥只在受保护的发布环境中使用，即需要维护者审批的 CI 环境。
   - 这道保障防的是下载渠道和镜像被篡改，防不了发布账号本身被攻破。
5. **凭据存储调整**：减少更新后的授权弹窗。
   - 服务商 API key、OAuth token、MCP token 加密存放在数据目录下的保险箱文件中（AES-256-GCM）。
   - 系统凭据库只存一个主密钥：macOS 用钥匙串，Windows 用凭据管理器。这样 macOS 每次更新后最多弹一次钥匙串授权，而不是每个凭据各弹一次；Windows 上顺带绕开了凭据管理器单条 2,560 字节的上限。
   - 主密钥不可用（例如用户拒绝授权）时，凭据不可读，界面提示用户重新授权，不回退到明文存储。
6. **macOS 系统通知**：M0 验证 ad-hoc 签名下 `UNNotification` 是否可用。不可用时退回应用内提醒加 Dock 角标与弹跳，需求 FR-SY-01 在 macOS 上相应降级。
7. **分发渠道**：
   - GitHub Releases 是唯一的官方渠道；
   - 不上 Mac App Store 与 Microsoft Store；
   - 不提交 Homebrew 官方仓库，也不提供替用户去掉隔离属性的安装脚本；
   - WinGet 在 Beta 后评估。
8. **Electron 版本政策沿用 ADR-0016**：只用官方仍在支持期内的大版本，至少每季度升级一次；出现在野利用的高危漏洞时立即发版。
   - 因为 macOS 没有自动更新，安全版本发布时，应用内提示要标明"安全更新"。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| macOS Developer ID + 公证；Windows 用 SignPath 免费签名（原推荐方案 A） | 安装顺畅；macOS 自动更新、通知、钥匙串都正常 | Apple 开发者计划 99 美元/年；SignPath 要求公开仓库、CI 构建与已发布版本 | 否决（产品负责人选择零费用）；见触发条件 |
| 安装脚本自动去掉隔离属性 | 用户少一步操作 | 等于替用户绕过系统安全检查 | 否决 |
| macOS 应用内自动替换（下载、校验、替换应用） | 不依赖 Squirrel.Mac | 要自己处理权限、原子替换与回滚；更新后仍会触发钥匙串和文件夹授权 | 第一版不做 |
| 每个凭据单独存系统凭据库（原设计） | 实现最简单 | ad-hoc 签名下每次更新、每个凭据都要弹窗授权 | 否决 |

## 后果

- 正面：零成本；不受 Apple、微软开发者账号与地区资格限制；发布流程更简单。
- 负面与代价：
  - 首次安装需要用户手动放行，会劝退一部分非技术用户。目标用户是开发者，影响相对小。
  - macOS 没有自动更新，用户可能长期停留在旧版本，安全修复到达更慢。
  - macOS 每次更新后需要重新授权一次钥匙串，可能还要重新授权文件夹访问。
  - Windows：开启智能应用控制的电脑无法使用；每个新版本都可能重新出现 SmartScreen 警告；杀毒软件误报的风险更高。
  - 没有平台签名，ASAR 完整性校验与"防止应用被冒用"这两项防护的价值下降。对安装目录有写权限的本机攻击者可以篡改应用而不被发现，这是接受的风险。
- 需要配套做的事（M0 S6）：
  - 验证 ad-hoc 打包后的首次运行流程，包括 macOS 15 与 26 上是否出现"仍要打开"；
  - 验证 Gatekeeper 是否会单独拦截 Core 启动的内置 node；
  - 验证系统通知是否可用，以及钥匙串每次更新的弹窗次数；
  - 验证 Velopack 未签名安装与更新；
  - 验证清单签名的校验流程。

## 重新评估的触发条件

- 项目公开并发布第一个版本后，申请 SignPath Foundation 免费签名。零费用，只影响 Windows 部分；
- 用户反馈中"安装受阻"或"停留在旧版本"成为主要问题；
- 出现愿意承担 Apple 开发者计划费用的赞助方或组织主体；
- Apple 进一步收紧未公证应用的运行方式，例如对 ad-hoc 签名应用也不再提供"仍要打开"。
