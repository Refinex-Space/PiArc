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
node scripts/dev/s6-probe.mjs notify
```

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

智能体收到反馈后填写。

| 项 | macOS 26 | macOS 15 |
|---|---|---|
| 首次打开：被拦下后"仍要打开"是否出现 | 待用户操作 | 待用户操作 |
| 备选方案：`xattr -dr com.apple.quarantine` 后能否打开 | 待用户操作 | 待用户操作 |
| 内置 node 是否被 Gatekeeper 单独拦截 | 待用户操作 | 待用户操作 |
| 系统通知：横幅是否显示；程序侧事件 | 待用户目视（程序侧：L4 收到 `show`，见 S6 报告第 5 节） | 待用户操作 |
| 钥匙串：构建 B 读取时的授权弹窗次数（预期 ≤ 1） | 待用户操作 | 待用户操作 |
