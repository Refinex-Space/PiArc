# S6 首次运行检查清单（实机关口）

T12 的这几项必须由人在真实的 macOS 上操作：系统设置里的"仍要打开"、通知横幅、钥匙串授权对话框都只有人能看见和点击。智能体已经准备好产物和脚本，你按下面的步骤操作，把每一步看到的结果告诉智能体（截图或文字都可以），由智能体填进第 4 节的结果表和 S6 报告。

不会改动你的系统设置：清单里没有任何关闭 Gatekeeper、改安全设置的步骤。钥匙串只用测试条目 `piarc-test.s6-keychain.credential-vault`，最后一步删除。

## 1. 准备

| 项 | 内容 |
|---|---|
| 产物 | `tmp/s6/PiArc-A.dmg`（构建 A：开发构建，arm64，ad-hoc 签名，hardened runtime）与 `tmp/s6/PiArc-B.dmg`（构建 B：同一应用，版本号改为 0.0.1 后按打包方式重签，代码身份不同，模拟一次更新） |
| 为什么用开发构建 | 第 3–5 项要用 Playwright 驱动应用调用测试入口，只有开发构建开着 `--inspect` fuse 并带测试导出。它与发布构建的签名方式、布局完全相同，只差这一个 fuse |
| 重新生成 | `npm run package:desktop -- --flavor development --make`，再 `node scripts/dev/s6-probe.mjs variant --app apps/desktop/out/development/PiArc-darwin-arm64/PiArc.app --out tmp/s6`；A 是 `apps/desktop/out/development/make/dmg/arm64/PiArc-0.0.0-arm64.dmg` |
| 机器 | 每台机器先在终端运行 `sw_vers` 与 `spctl --status`，把输出告诉智能体。`spctl --status` 显示 `assessments disabled` 时 Gatekeeper 是关的，第 2 项的结果没有意义：要么换一台开着 Gatekeeper 的 Mac，要么由你自己决定是否用 `sudo spctl --master-enable` 打开（智能体不会替你执行） |
| macOS 15 与 26 | 两个大版本各做一遍第 2–3 项。没有 macOS 15 的设备就告诉智能体，结果表记"未验证"并写明原因 |
| 已装的 PiArc | 如果 `/Applications/PiArc.app` 已存在，先把它移到废纸篓 |

## 2. 首次打开（带隔离属性）

1. 在仓库根目录运行（保持窗口开着）：

   ```bash
   node scripts/dev/s6-probe.mjs serve tmp/s6/PiArc-A.dmg
   ```

2. 用 Safari 打开 <http://127.0.0.1:8765/>，点链接下载 `PiArc-A.dmg`。经浏览器下载的文件带隔离属性，与从 GitHub Releases 下载一致。下载完在终端按 Ctrl+C 停掉服务。
3. 可选的确认：`xattr ~/Downloads/PiArc-A.dmg` 的输出里应有 `com.apple.quarantine`。
4. 双击 DMG，把 PiArc 拖进"应用程序"文件夹（窗口里有快捷方式）。
5. 在"应用程序"里双击 PiArc。记录：
   - 出现的对话框原文（截图最好）；
   - 能否直接打开。
6. 如果被拦下：打开"系统设置 → 隐私与安全性"，往下翻到"安全性"一节。记录：
   - 是否出现关于 PiArc 的提示和"仍要打开"按钮；
   - 点"仍要打开"后是否要求输入密码、之后能否打开。
7. 备选方案，只在第 6 步没有"仍要打开"按钮时做：

   ```bash
   xattr -dr com.apple.quarantine /Applications/PiArc.app
   ```

   这条命令去掉系统对这个应用的来源检查。执行后再双击 PiArc，记录能否打开。
8. 打开后关掉 PiArc 窗口，退出应用（⌘Q）。

## 3. 内置 node 是否被 Gatekeeper 单独拦截

第 2 项打开过一次之后运行：

```bash
node scripts/dev/s6-probe.mjs agent-host
```

脚本启动 `/Applications/PiArc.app`，让 Core 从应用自带的 `Resources/agent-host/` 经 `sandbox-exec` 启动内置 node 运行 Agent Host，跟本机的 mock provider 完成一轮对话（含一次 Bash 调用）。内置 node、rg、fd 都带着从 DMG 拷出来的隔离属性。记录：

- 屏幕上是否弹出任何关于 `node`、`rg`、`fd` 的系统对话框；
- 终端输出的 JSON 里 `turn.status` 是否为 `completed`（失败时把整段输出发给智能体）。

## 4. 系统通知

```bash
node scripts/dev/s6-probe.mjs notify --wait 30
```

应用会保持运行 30 秒，请在这段时间里看屏幕右上角。Electron 在应用退出时会删掉自己已投递的通知，应用一退出，横幅和通知中心里的条目就都消失了。

第一次运行时 macOS 可能先问是否允许 PiArc 发通知，选"允许"。记录：

- 是否看到标题为 PiArc、内容为"S6 notification probe: did you see this?"的通知横幅（或在通知中心里看到它）；
- 终端输出中 `events` 的内容（`show` 还是 `failed`，`failed` 时的错误文字）；
- "系统设置 → 通知"里是否出现 PiArc。

## 5. 钥匙串授权弹窗计数

1. 构建 A 已经装在"应用程序"里。创建测试主密钥并写入一条测试凭据：

   ```bash
   node scripts/dev/s6-probe.mjs keychain write
   ```

   记录这一步出现了几次钥匙串对话框（预期 0 次：条目是这个应用自己创建的）。输出里 `ok` 应为 `true`，`opened` 为 `createdWithNewKey`。
2. 安装构建 B，模拟更新：退出 PiArc，按第 2 项的方式（serve → Safari 下载 → 拖入"应用程序"并替换）装上 `tmp/s6/PiArc-B.dmg`，打开一次（可能再次需要"仍要打开"，一并记录）。
3. 用构建 B 读取凭据：

   ```bash
   node scripts/dev/s6-probe.mjs keychain read
   ```

   每出现一次"PiArc 想要使用钥匙串中的机密信息"一类的对话框就计一次。请点"始终允许"并输入登录密码。记录对话框次数、每次的原文（截图）、输出中的 `ok` 与 `found`。
4. 再运行一次 `keychain read`，记录这次是否还有对话框（预期 0 次）。
5. 清理：

   ```bash
   node scripts/dev/s6-probe.mjs keychain delete
   ```

   然后把 `/Applications/PiArc.app` 移到废纸篓。

ADR-0018 的预期：每次更新后最多弹 1 次（只有主密钥一个条目）。

## 6. 要反馈给智能体的内容

| 项 | 反馈 |
|---|---|
| 环境 | 每台机器的 `sw_vers`、`spctl --status` 输出 |
| 第 2 项 | 对话框原文；"仍要打开"是否出现；是否需要密码；备选命令是否用过、结果 |
| 第 3 项 | 有无系统对话框；`turn.status` |
| 第 4 项 | 横幅是否出现；`events`；通知设置里是否有 PiArc |
| 第 5 项 | 每一步的对话框次数与原文、`ok`/`found` |

## 7. 结果

2026-11-16，用户的 MacBook Pro（macOS 26.5.2，25F84，Apple Silicon）。用户操作了第 2–5 项，智能体用 computer use 查看了系统设置，并用 `s6-probe.mjs` 驱动钥匙串一项。没有 macOS 15 的设备。

| 项 | macOS 26 | macOS 15 |
|---|---|---|
| 首次打开：被拦下后"仍要打开"是否出现 | **未验证**。这台 Mac 的 `spctl --status` 为 `assessments disabled`，且经 Safari 从 `127.0.0.1` 下载的 DMG 只带 `com.apple.provenance`、没有 `com.apple.quarantine`，应用直接打开（用户截图），Gatekeeper 根本没有参与。要在开着 Gatekeeper 的 Mac 上、用带隔离属性的下载重做（I42） | **未验证**：没有 macOS 15 设备 |
| 备选方案：`xattr -dr com.apple.quarantine` 后能否打开 | **未验证**（原因同上，没有被拦下，不需要备选） | **未验证** |
| 内置 node 是否被 Gatekeeper 单独拦截 | **未出现拦截，但不构成证据**：用户在已安装的应用上运行 `agent-host`，内置 node 经 `sandbox-exec` 启动、完成对话（`turn.status: completed`），没有系统对话框；Gatekeeper 关闭、文件无隔离属性，所以不能说明开启时的表现（I42） | **未验证** |
| 系统通知：横幅是否显示；程序侧事件 | 程序侧：用户运行 `notify` 收到 `show`（4 ms），L4 收到 `show`（7 ms）。系统设置 → 通知中 PiArc 已出现，但**"允许通知"为关**（智能体用 computer use 查看）：横幅没有显示，而程序照样收到 `show`。结论：ad-hoc 签名的应用能注册到通知中心；`show`/`failed` 不能反映用户是否允许，程序无法据此判断要不要退回应用内提醒（I43）。用户随后打开 PiArc 的"允许通知"，运行 `notify --wait 30`，**横幅显示**（用户目视确认）；系统日志记录通知中心 `displaying as banner`、`interruptionSuppression: none`。应用退出时 Electron 删除已投递的通知，横幅和通知中心条目随之消失（`tmp/evidence/T12/notification-usernoted.log`） | **未验证** |
| 钥匙串：构建 B 读取时的授权弹窗次数（预期 ≤ 1） | **1 次**（用户确认）。构建 A（CDHash `eaa1215e…`）`keychain write` 创建主密钥并写入，0 次；构建 A 读，0 次；换装构建 B（CDHash `b878e8a8…`，版本 0.0.1）后第一次读等待约 8 s（耗时 9 s，其后两次各 1 s），弹 1 次，用户选"始终允许"后 `found: true`；之后再读 0 次。与 ADR-0018 的预期一致 | **未验证** |
