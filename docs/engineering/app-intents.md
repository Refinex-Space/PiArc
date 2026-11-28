# macOS 快捷指令

## 原型结果

T49 的最小动作名为 **Open PiArc**。在 macOS arm64、Xcode 26.3、macOS SDK 26.2 上，Xcode 成功将动作编入 ExtensionKit 扩展，并生成可发现动作的元数据。扩展嵌入本机 Electron 发布构建的副本后，通过外层 ad-hoc 重签、严格递归签名校验和全部 9 个发布 fuse 检查。2026-11-23，用户在实机“快捷指令”中找到了该动作，运行后成功打开 PiArc；本次没有收到截图。可行性原型通过，已据此实现工作区与新会话两个动作。

同机成功交叉构建 x86_64 扩展。原型的布局检查中，扩展身份、签名与动作元数据均通过。两项内置 Node 证书检查失败；原发布包中的同一份 Node 也失败，其签名者信息显示 `Authority=(unavailable)`，嵌入扩展前后 Node 文件的 SHA-256 相同。在隔离数据目录启动 Electron 收到 `SIGABRT`，此环境未验证窗口启动。证据见 `tmp/evidence/T49/intents-build.log`、`intents-layout.json`、`intents-launch.log`。

Apple 支持在独立的 App Intents 扩展里提供动作；扩展在后台执行。Open PiArc 用 `NSWorkspace` 激活包装该扩展的应用。另两个动作用同一 API 将定位 URL 交给这个应用，以免草稿交给注册了同一 scheme 的其他副本。[Apple App extension](https://developer.apple.com/documentation/appintents/app-extension)、[运行方式](https://developer.apple.com/documentation/appintents/configuring-the-runtime-behavior-of-your-app-intents)。

## 构建与签名

在 macOS 上运行 `npm run package:desktop -- --flavor release --arch arm64`。构建 Intel 版本时使用 `--arch x64`。需要完整的 Xcode。若 `xcode-select -p` 指向 Command Line Tools，可仅在此次命令的环境中设置 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`，无需修改系统设置。

Forge 的 macOS 打包流程通过 `xcodebuild` 构建 `apps/desktop/native/app-intents/PiArcShortcuts.xcodeproj`。Xcode 以对应的架构生成元数据并 ad-hoc 签名扩展。Forge 完成 Electron 的第一轮深度重签后，将扩展放入 `PiArc.app/Contents/Extensions/PiArcShortcuts.appex`，装入 Agent Host 资源，最后用已有签名流程封存外层应用。内置 Node 保留其官方签名。扩展只声明 App Sandbox entitlement。

macOS CI 的 `package-macos` 作业通过同一入口构建两个架构，再运行 `check-app-layout.mjs` 与 `check-fuses.mjs`。原生路由测试核对工作区和草稿的编码、长度与本地路径限制；布局检查验证扩展身份、签名和三个可发现动作的元数据。提交 cdb81a0 的两项发布打包 CI 均通过。日志逐项确认三个动作的元数据和扩展签名，arm64 布局 28/28，x64 布局 27/27，两个架构均通过 9 项 fuse 校验。[arm64 作业](https://github.com/Refinex-Space/PiArc/actions/runs/45201604327/job/137786269610)、[x64 作业](https://github.com/Refinex-Space/PiArc/actions/runs/45201604327/job/137786269505)。

## 正式构建验证

本机从当前任务源码编译了 release Core、Agent Host 与三个 Electron 进程的代码。Forge 尝试下载 Electron 时网络受限，随后在独立临时源码目录让同一 Forge 打包入口使用本地缓存的 Electron 45.3.2 arm64 ZIP，SHA-256 与已锁定 Electron 包的 `checksums.json` 相符。产物在 `tmp/evidence/T49/shortcuts-final/PiArc.app`。其 main、preload、38 个 renderer 资源和 Agent Host bundle 与本轮编译输出逐字节相符；从包内成功加载发布版 Core 并核对了侧边对话方法。扩展面向 macOS 13 及以上，arm64 和 x86_64 均已编译，用户实机包为 arm64。

包内的三个动作均生成了可发现元数据。初次在受限会话中核对签名时，系统未提供签名者证书链，布局检查为 26/28。2026-11-23 在原生 macOS 26.5.2 桌面上对同一个正式包复验，`check-app-layout.mjs` 28/28 通过，其中包括内置 Node 的官方签名。发布 fuses 9/9 通过，`codesign --verify --deep --strict` 通过。以独立临时数据目录启动新实例后，WindowServer 报告该 PID 拥有可见的 1280 × 800 主窗口。证据在 `tmp/evidence/T49/` 下的 `intents-unrestricted-layout.json`、`intents-unrestricted-fuses.log`、`intents-unrestricted-codesign.log` 和 `intents-unrestricted-launch.log`。

## 工作区与新会话动作

- **在 PiArc 中打开工作区**（Open Workspace in PiArc）接收本机文件夹的绝对路径。通过 `piarc://open` 定位，沿用工作区的信任流程。
- **在 PiArc 中新建会话**（New Session in PiArc）另有可选参数“草稿文字”。它使用 ADR-0069 的 `piarc://draft`，只预填编辑器。用户在 PiArc 中手动发送后才会开始回合。工作区路径和草稿分别限制在 4096 个 UTF-16 代码单元，空字符被拒绝；空格、加号、换行和其他特殊字符按查询参数编码。

## 实机验收清单

1. 准备一个本机空文件夹，如 `~/Desktop/PiArc-T49`，在 Finder 中选中它，按 ⌥⌘C 复制绝对路径。退出其他 PiArc 副本，然后在 Finder 中打开本次正式构建 `tmp/evidence/T49/shortcuts-final/PiArc.app`。把“快捷指令”切到前台，保留 PiArc 窗口。
2. 在“快捷指令”点“＋”，按 App 搜索 PiArc，截取动作列表。把“在 PiArc 中打开工作区”加入快捷指令，粘贴上述绝对路径，点运行。期望 PiArc 激活并显示这个工作区；首次打开按正常流程处理项目信任。
3. 新建另一个快捷指令，添加“在 PiArc 中新建会话”。同样粘贴工作区绝对路径，“草稿文字”填 `T49 + 草稿 & 待确认`，运行并截取 PiArc 窗口。期望对应工作区的新会话输入框完整显示这些文字，可继续编辑，transcript 中没有新用户消息，且没有运行中的回合。无需发送该草稿或配置模型。
4. 退出 PiArc 后再运行“新建会话”，检查冷启动也能显示相同草稿。请记录系统版本、动作名称、应用已运行及冷启动结果，附上动作列表及带草稿的窗口截图。没有找到动作时请提供搜索页；运行失败时请附完整错误文字。

2026-11-23，用户运行正式包的“在 PiArc 中新建会话”后确认：工作区正确，`T49 + 草稿 & 待确认` 原样显示，未自动发送。用户也已确认最小动作“打开 PiArc”能被发现并运行。用户明确接受本次以实机文字记录代替动作和窗口截图。冷启动、单独运行“打开工作区”没有独立的用户实机记录。
