# 0096. 麦克风进入安全基线

- 状态：已接受（用户 2026-11-26 确认缓解方案与剩余风险）
- 日期：2026-11-26
- 取代：无
- 相关：架构文档第 10.1、10.3 节（THR-14）；ADR-0018、ADR-0056、ADR-0094；[语音输入设计增补](../architecture/addenda/voice-dictation.md) 3.9 节

## 背景

语音输入在主进程（Core）里用 CPAL 原生采集。macOS 上：

- 应用 Info.plist 没有 `NSMicrophoneUsageDescription` 时，进程一访问麦克风就被 TCC 结束；
- hardened runtime 下需要 entitlement `com.apple.security.device.audio-input`，而 `entitlements.mac.plist` 只有 `allow-jit` 与 `disable-library-validation`，`check-app-layout.mjs` 与 THR-14 的测试锁定这两项；
- TCC 把授权记在"责任进程"名下：PiArc 拉起的子进程（Agent Host、MCP server、Pi 扩展、Bash 命令、hooks、用户终端）默认以 PiArc 为责任进程，用户授权后它们不弹框即可录音。今天缺少 usage description，这条路事实上关着；本功能会打开它。Terminal、VS Code 等托管命令的应用都有同样的性质。

渲染进程的 `media` 权限一律拒绝（`security/permissions.ts`），这不需要改：PCM 不经渲染进程。

## 决策

1. macOS 打包产物的 Info.plist 加 `NSMicrophoneUsageDescription`（说明只在用户点击麦克风时本机识别、不上传、不保存音频）；只有主程序的签名带 `com.apple.security.device.audio-input`，Electron Helper、内置 node 与 Resources 下的其他 Mach-O 不带。THR-14 的对策改为"主程序三项 entitlement"，`check-app-layout.mjs` 同时断言 Helper 与 node 没有这一项。
2. 系统授权只在用户点击麦克风后请求（`systemPreferences.askForMediaAccess`）；被拒或受限时不再弹框，给出系统设置入口。
3. 开始听写与测试麦克风要求发起窗口 5 秒内有真实输入，窗口不可见或最小化时拒绝；听写事件只经 `dictation/<webContentsId>` 路由，只有该窗口能订阅。
4. Agent Host 的定稿 Seatbelt 配置与 Bash 沙箱配置加 `(deny device-microphone)` 与 `(deny device-camera)`：Agent Host 及其后代（MCP server、Pi 扩展、npx）与沙箱里的命令不能录音。
5. 剩余风险（已接受）：沙箱关闭或沙箱外运行的 Bash 命令、hooks 与用户终端以 PiArc 为责任进程，在用户授权后可以录音；macOS 菜单栏会显示麦克风使用指示。Windows 的麦克风隐私开关按桌面应用整体生效，PiArc 不改变现状。
6. 不对子进程放弃 TCC 责任主体（`responsibility_spawnattrs_setdisclaim`）：那会让每个子进程访问"文稿""桌面"等受保护目录时各自请求授权，现有命令与工具的行为全面回退。
7. 新增威胁 THR-18"麦克风与听写内容"，对策见第 2–4 条与设计增补 V-9.4；测试名带 `THR-18`。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 渲染进程 `getUserMedia` 采集 | 授权主体就是应用 | 渲染进程要放开 `media`、PCM 经 IPC，违反需求与基线 | 不采用 |
| 对全部子进程放弃 TCC 责任主体 | 子进程拿不到麦克风 | 文件类 TCC 也一起失效，需私有 API | 不采用（用户确认） |
| 沙箱关闭时也给 Bash 套只拒绝麦克风的配置 | 关掉剩余风险的一部分 | 每条命令多一层 `sandbox-exec`，与"关闭沙箱"的语义冲突 | 不采用（用户选择缓解方案） |
| Seatbelt 拒绝 + entitlement 只给主程序 | 覆盖模型驱动的主要路径，改动集中 | 未沙箱化的命令仍可录音 | 采用 |

## 后果

- 正面：模型与扩展拉起的进程不能静默录音；渲染进程权限不变。
- 负面与代价：用户授权后，未进沙箱的命令能录音（同 Terminal）；ad-hoc 签名每次更新后系统会重新请求授权。
- 需要配套做的事：架构 10.1 节 THR-14 与 THR-18、10.3 节 entitlement 一句；`tests/security/threats.yaml`；S10 报告；`agent_host_profile` 测试加麦克风用例；打包签名把主程序与 Helper 的 entitlement 分开。

## 重新评估的触发条件

- 改为平台签名分发（ADR-0018 被取代）。
- macOS 提供不需要私有 API 的按子进程隔离设备授权的方式。
- Windows 引入按应用的麦克风授权并影响子进程。
