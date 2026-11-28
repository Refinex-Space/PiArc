# S6 未签名打包、首次运行、内置 Node 与发布清单

| 项 | 内容 |
|---|---|
| 任务 | T12（2026-11-16） |
| 结论 | macOS：有条件通过。arm64 与 x64 的 DMG、ZIP 本机产出，分层 ad-hoc 签名与 fuse 检查通过；hardened runtime 可以启用（需 `disable-library-validation`）；打包产物经 `sandbox-exec` 宽松配置启动内置 node 完成 mock 对话，bash、grep、find、git、`worker_threads`、npx 拉起 MCP、原生模块正常，越界写入被拒；发布清单签名与三种篡改用例通过；arm64 DMG 168.8 MB、安装后 449.0 MB，都在预算内（后者只余约 1 MB）。钥匙串每次更新弹 1 次（用户实机确认）；系统通知可用，允许后横幅显示，但程序侧 `show` 不反映是否允许（I43）；Gatekeeper 开启时的首次打开未验证（用户的 Mac 关着 Gatekeeper，I42）。Windows（W0，第 9 节）：CI 产出 x64、arm64 的 Velopack 安装包与 0.0.1、0.0.2 两个版本；本机发布构建 fuse 与布局检查通过；打包产物经 Job Object 启动内置 node 完成 mock 对话（含 npx 拉起 MCP）；delta 包能把 0.0.1 重建成与 0.0.2 内容一致的完整包。安装、更新、卸载与 SmartScreen 见第 9.3 节 |
| 代码 | `apps/desktop/packaging/`（布局、签名、DMG maker、Velopack 绑定）、`scripts/dev/fetch-binaries.mjs` + `third-party/binaries.lock.json`、`crates/piarc-core/src/agent_host.rs`（`BundledRuntime`、`start_bundled`）、`crates/piarc-sandbox/src/seatbelt.rs`（Agent Host 配置）、`crates/piarc-core/src/release.rs`、`scripts/release/` |
| 测试 | `apps/desktop/e2e/agent-host.e2e.ts`、`notification.e2e.ts`；`crates/piarc-core/tests/release.rs`、`agent_host_probe.rs`；`scripts/ci/check-app-layout.mjs`；`scripts/release/release-manifest.test.mjs`、`scripts/lib/blake2b.test.mjs` |
| 实机清单 | [S06-first-run-checklist.md](S06-first-run-checklist.md) |

## 1. 验证环境

- macOS 26.5.2（25F84），Apple Silicon。本机 `spctl --status` 为 `assessments disabled`（Gatekeeper 评估被关闭），所以本机的 `spctl --assess` 一律显示 accepted，不能作为首次打开的证据；首次打开放进实机清单，在开着 Gatekeeper 的机器上做。
- Electron 45.3.2（内置 Node 24.22.2），Electron Forge 8.0.1；内置 Node 24.22.3（2026-11-10 的安全版本，与 Electron 同一大版本）、ripgrep 15.2.0、fd 10.5.0、Pi 1.5.2；Velopack 1.2.161（npm 绑定与 vpk）。
- 版本与哈希锁定在 `third-party/binaries.lock.json`：Node 的 SHA-256 取自官方 `SHASUMS256.txt`，rg、fd 取自 GitHub 发布产物的摘要，vpk 取自 nuget.org 包本身。`fetch-binaries.mjs` 每次使用都重新校验，大小或哈希不符即失败并删除文件。

## 2. 产物与签名

### 2.1 产物

`npm run package:desktop -- --flavor release --arch <arch> --make`：

| 产物 | arm64 | x64 |
|---|---|---|
| DMG（hdiutil，ULFO） | 168,829,697 B | 177,326,620 B |
| ZIP（maker-zip） | 171,301,948 B | 180,162,085 B |
| `.app`（`du -sk`） | 438,448 KiB | 446,220 KiB |

- DMG 由自写的 Forge maker 用 `hdiutil` 生成（`packaging/maker-dmg.mjs`），内含 PiArc.app 与"应用程序"快捷方式。Forge 自带的 maker-dmg 经 appdmg 依赖 `fs-xattr`、`macos-alias` 两个要靠安装脚本编译的原生模块，与 `npm ci --ignore-scripts` 冲突。
- 图标直接引用 `design/brand/icon`（`.icns` 与包内 `electron.icns` 的 SHA-1 相同），`apps/desktop` 中没有副本；bundle id 为 `cn.piarc.desktop`，取自应用标识（`app-identity.test.mjs` 保证与 `piarc_core::identity::APP_IDENTIFIER` 一致）。
- x64 构建在本机经 Rosetta 启动后持续运行（Core 加载失败会弹窗退出，未出现）；其余行为由 CI 的 `package-macos` 作业与 Intel 机器上的使用覆盖。

### 2.2 签名分层

写入 fuses 后（`postPackage` 钩子，`packaging/macos-sign.mjs`）：

1. Electron 的框架、Helper 与主程序整体重签（`--deep`，此时 bundle 里还没有 Agent Host 资源）。fuses 插件自己的 ad-hoc 重签只在 arm64 上做，x64 也由这一步覆盖。
2. 拷入 `Resources/agent-host/`，逐个 ad-hoc 签名 Resources 下的 Mach-O（Core 的 `.node`、rg、fd），跳过 `agent-host/node/`。
3. 不带 `--deep` 签整个 bundle：CodeResources 封存 Resources（含 Agent Host 文件），内层签名保持不变。

`scripts/ci/check-app-layout.mjs` 的 21 项检查对两个架构的 `out/` 产物、DMG 内的应用、ZIP 解开后的应用都通过（`tmp/evidence/T12/layout-release-*.json`）。要点（`codesign -dv`，`tmp/evidence/T12/codesign-release-arm64.txt`）：

| 文件 | 签名 |
|---|---|
| PiArc.app | `flags=0x10002(adhoc,runtime)`，Identifier `cn.piarc.desktop`；`codesign --verify --deep --strict`：valid on disk、satisfies its Designated Requirement |
| `agent-host/node/bin/node` | `flags=0x10000(runtime)`，Authority `Developer ID Application: Node.js Foundation (HX7739G8FX)`，保留官方签名 |
| rg、fd、`piarc-core.darwin-*.node` | `flags=0x2(adhoc)` |

## 3. hardened runtime

结论：ad-hoc 签名下可以启用，但必须同时关闭库验证。PiArc 启用，entitlements 只有 `allow-jit` 与 `disable-library-validation`。

| 配置 | 结果 |
|---|---|
| runtime，无 entitlements | 启动即退出：dyld 拒绝加载 Electron Framework，"mapping process and mapped file (non-platform) have different Team IDs"（ad-hoc 签名没有 Team ID） |
| runtime + `allow-jit` | 同上 |
| runtime + `allow-jit` + `disable-library-validation` | 正常运行，Core 加载；打包形态 L4 全套 68 项通过 |

关闭库验证后 hardened runtime 仍有价值：它阻止 `DYLD_*` 环境变量注入与调试器附加。实测用 `DYLD_INSERT_LIBRARIES` 注入一个构造函数打印标记的 dylib：未开 hardened runtime 的构建打印 4 次，开启后 0 次（`tmp/evidence/T12/hardened-runtime.txt`）。钥匙串授权绑定在应用的代码身份上，同一用户的进程若能注入 PiArc，就能不经授权读到主密钥，所以这层保护有实际意义。架构第 10.1、10.3 节已同步。

内置 node 的官方签名自带 `get-task-allow`、`allow-dyld-environment-variables`、`disable-library-validation` 等 entitlements。Core 以最小环境启动它（不传 `DYLD_*`），但同一用户的进程可以调试附加 Agent Host，读到其内存中的凭据。这与 ADR-0018"保留官方签名"的决定相伴，登记为 I39。

## 4. 内置运行时与宽松 Seatbelt 配置

### 4.1 布局与启动

`Resources/agent-host/`（架构第 5.6 节）：`node/`（只留 `bin/node`、`bin/npm`、`bin/npx`、`lib/node_modules/npm`、`LICENSE`，去掉头文件、文档、corepack）、`agent-host.mjs`、`pi-assets/`、`node_modules/@silvia-odwyer/photon-node`（bundle 的外部依赖）、`bin/rg`、`bin/fd`。全部在 asar 之外，`app.asar` 中没有它们。

Core（`piarc_core::agent_host::start_bundled`）的启动命令：

```
/usr/bin/sandbox-exec -p <配置> -DWRITABLE_0=<工作区> -DWRITABLE_1=<数据目录> -- <内置 node> agent-host.mjs --data-dir <数据目录>
```

用 `-p` 而不是 `-f`：配置正文与沙箱命令一样由 `piarc-sandbox` 生成、不含路径（路径只经 `-D` 传入），不必写临时文件。进程经 `ProcessTreeSpawner` 启动（I33 的 Agent Host 部分），环境变量见架构第 5.6 节：`PATH` 前置内置 Node 的 `bin` 与 `bin/`（rg、fd），`TMPDIR` 与 `npm_config_cache` 指向数据目录下的 `agent-host/`。

宽松配置（快照 `crates/piarc-sandbox/tests/snapshots/agent-host-profile.sbpl`）：`(allow default)` 之后 `(deny file-write*)`，再放行工作区、数据目录与终端设备的写入；读取与网络不限。定稿在 T39。

### 4.2 打包产物上的一轮对话（A05、A06）

L4 `agent-host.e2e.ts`（打包形态，4.3 s）经开发构建 Core 的测试导出 `agentHostProbe` 按上面的方式启动 Agent Host，mock provider 以 `<数据目录>/pi/models.json` 指定。场景依次调用 Bash（`printf bash-ok; git status --short`）、Grep、Glob 与一个 MCP 工具，最后回一句文本。结果（`tmp/evidence/T12/agent-host/`）：

| 检查 | 结果 |
|---|---|
| 回合 | `completed`；四次工具调用都 `completed`；Core 应答的 `exec/run`、`fs/grep`、`fs/glob` 没有错误 |
| Pi 定位资源 | `piVersion` 1.5.2（Pi 从 `PI_PACKAGE_DIR` 的 `package.json` 读到）；数据目录下没有 `pi/bin/`，Pi 没有下载 rg、fd |
| MCP server | 由内置 `npx` 启动，`process.execPath` 等于 `Resources/agent-host/node/bin/node`，Node v24.22.3；npx 缓存落在 `<数据目录>/agent-host/npm-cache/_npx/` |
| `worker_threads` | MCP server 内的 worker 往返正常（21 → 42） |
| git | `git --version`、`git -C <工作区> status --porcelain` 正常 |
| 写入范围 | 写工作区内的文件成功；写工作区与数据目录以外的文件得到 `EPERM`，文件不存在 |
| 原生模块 | MCP server 用 `process.dlopen` 加载 ad-hoc（linker-signed）的 `.node` 成功 |

说明：

- Bash、Grep、Glob 是委托工具（ADR-0020），I/O 由 Core 执行，不在 Agent Host 的 Seatbelt 之内；Agent Host 自身与它启动的子进程（npx、MCP server、git）受配置约束，越界写入的 `EPERM` 就来自 MCP server。
- 用 `npx <本地目录>` 启动 MCP 会失败：npm 把目录链接进缓存，再对目录里的 bin 执行 `chmod`，这个文件在可写目录之外，被配置拒绝（`EPERM`）。来自 registry 的包是 tarball，解到缓存里再 `chmod`，不受影响；测试因此先 `npm pack` 再 `npx --package <tgz>`。用户若在 MCP 配置里写本地目录，会遇到同样的失败，T36/T39 处理 MCP 配置时要考虑（I40）。

### 4.3 npx 安装的原生模块（A07）

在同一配置下，用内置 npm 从 registry 安装 `@napi-rs/lzma@1.5.3`（自带 darwin-arm64 预编译 `.node`，`flags=0x20002(adhoc,linker-signed)`），再用内置 node 加载并完成一次 xz 压缩往返：成功（`tmp/evidence/T12/npm-native-module.txt`）。下载的 `.node` 没有隔离属性（npm 不经 LaunchServices）。内置 node 的官方签名带 `disable-library-validation`，所以第三方原生模块不受库验证限制。

### 4.4 TCC 责任归属

macOS 的隐私授权（"文稿""桌面"、下载文件夹等）按"负责进程"记账：一个进程启动的子进程默认以启动它的应用为负责方，除非启动时用私有接口声明放弃（`responsibility_spawnattrs_setdisclaim`，终端类应用会这样做）。Core 在 PiArc 主进程中用普通的 `posix_spawn` 启动 `sandbox-exec`，没有放弃负责关系，所以 Agent Host、npx、MCP server、git 访问受保护目录时，系统会以 PiArc 的名义弹窗，授权记在 PiArc 的代码身份上。ad-hoc 签名的身份就是代码哈希，每次更新都会变，这些授权随之失效（ADR-0018 已列为代价）。本结论来自对 TCC 机制的分析与公开资料，没有实测弹窗的归属；可以在实机上用 MCP server 读 `~/Documents` 验证，留给 T39 定稿配置时一并确认。

## 5. 系统通知

程序侧：L4 `notification.e2e.ts`（打包形态）在 ad-hoc 签名、hardened runtime 的开发构建上调用 `new Notification().show()`：`Notification.isSupported()` 为 true，7 ms 后收到 `show` 事件，没有 `failed`（`tmp/evidence/T12/l4/notification*/notification.json`）；用户在已安装的构建上运行 `notify`，同样 4 ms 后收到 `show`。

系统侧（用户的 Mac，智能体用 computer use 查看"系统设置 → 通知"）：PiArc 出现在应用列表中（ad-hoc 签名的应用能注册到通知中心），但"允许通知"为关，横幅没有显示。也就是说，用户关闭（或从未允许）通知时，程序收到的仍是 `show`，`failed` 不会出现。

结论：ad-hoc 签名不妨碍 `UNNotification` 注册与提交；但程序侧的 `show`/`failed` 不能反映通知是否真的送达，不能用它决定是否退回应用内提醒加 Dock 角标（ADR-0018 第 6 条）。T35/T18 做通知时要另找授权状态的来源（例如原生模块查询 `UNUserNotificationCenter` 的设置），或者在通知之外总是给应用内提醒（I43）。

允许通知之后：用户打开 PiArc 的"允许通知"，运行 `node scripts/dev/s6-probe.mjs notify --wait 30`，横幅显示（用户目视确认）。系统统一日志同时记录通知中心收到 `cn.piarc.desktop` 的通知并 `displaying as banner`，勿扰未拦截（`interruptionSuppression: none`）。所以 ad-hoc 签名下系统通知可用，不需要按 ADR-0018 第 6 条降级。

另一个行为：应用退出时 Electron 会删除自己已投递的通知（日志 `Removing 1 delivered notifications`），通知中心里的条目随之消失。最初的探针 8 秒后就关闭应用，加上"临时"样式的横幅只停留约 5 秒，第一次没看到横幅就是这个原因；T35 设计"关闭窗口后后台运行"时要考虑这一点（I43）。证据 `tmp/evidence/T12/notification-usernoted.log`。

## 6. 发布清单

格式与校验位置见 ADR-0024。`scripts/release/release-manifest.mjs` 用测试密钥（`scripts/release/test-keys/`）签名，Core 的 `piarc_core::release` 用 `minisign-verify` 校验，两套独立实现在同一组样本上一致。`cargo test -p piarc-core --test release`（`tmp/evidence/T12/release-manifest-tests.txt`）：

| 情况 | 结果 |
|---|---|
| 测试密钥签名的清单与两个产物 | 通过 |
| 清单内容被改（版本号 0.1.0 → 0.1.1） | `releaseIntegrity`，`reason: badSignature` |
| 受信注释被改 | `badSignature` |
| 产物改一个字节（大小不变） | `hashMismatch`；多一个字节为 `sizeMismatch`；未列出的文件为 `notListed` |
| 用另一把密钥签名 | `unknownKey`；改为信任那把密钥后通过（证明拒绝的是密钥而不是格式） |
| 没有信任的公钥（含当前内置列表） | `noTrustedKey` |
| 非 minisign 文本 | `malformedSignature` |

内置公钥列表 `BUILTIN_RELEASE_KEYS` 在 T50 之前为空，所以任何清单都被拒绝（fail closed）。

## 7. fuse 最终配置

与 ADR-0018 第 1 条一致，`check-fuses.mjs` 对 arm64、x64 的发布构建与开发构建全部通过（9 个 fuse）：关闭 `RunAsNode`、`EnableNodeOptionsEnvironmentVariable`、`EnableNodeCliInspectArguments`（开发构建开启）、`GrantFileProtocolExtraPrivileges`、`LoadBrowserProcessSpecificV8Snapshot`；开启 `EnableEmbeddedAsarIntegrityValidation`、`OnlyLoadAppFromAsar`、`EnableCookieEncryption`、`WasmTrapHandlers`。`LoadBrowserProcessSpecificV8Snapshot` 维持关闭：T12 没有测量启动时间收益，留给 T44 的启动优化。

## 8. 体积（对照第 11 章）

| 指标 | 预算 | arm64 | x64 |
|---|---|---|---|
| DMG | ≤ 200 MB | 168.8 MB（通过） | 177.3 MB |
| 安装后（`.app`） | ≤ 450 MB | 449.0 MB（438,448 KiB，通过，余量约 1 MB） | 456.9 MB（446,220 KiB，预算只针对 arm64） |

arm64 `.app` 各部分（KiB）：Electron Framework 255,872；四个 Helper 各 232；`app.asar` 3,052；`app.asar.unpacked`（Core）3,280；`agent-host/node` 148,784（其中 node 可执行文件 122.6 MB，npm 17,456 KiB，npm 自带的 docs 与 man 约 3.2 MiB）；`agent-host.mjs` 15,424；rg + fd 6,820；photon-node 2,584。安装后体积已经贴着预算，后续任何随包内容都会超出；按任务要求本任务不裁剪，登记为 I41 交 R1 决定（可选的方向：裁掉 npm 包内的文档与 man 页、压缩 bundle、为 x64 与 arm64 之外不另出通用包）。

Windows x64 的体积见第 9.2 节。

## 9. Windows

- CI 作业 `package-windows`：x64 与 arm64（arm64 在 x64 runner 上交叉构建 Core），开发构建（带 W0 需要的测试入口），`check:fuses` 与布局检查，`vpk pack` 出 0.0.1 与 0.0.2 两个版本到同一个发布目录。actionlint 1.7.12 对 `.github/workflows/ci.yml` 无报错（`tmp/evidence/T12/actionlint.txt`；shellcheck 未安装，相关规则未运行）。
- Velopack 接入：主进程最先运行 `VelopackApp.build().run()`（只在打包后的 Windows 构建，绑定从 app.asar 的 `node_modules` 加载，只带目标架构的 `.node`）；`vpk` 对非 .NET 主程序跳过 VelopackApp 检查。pack id 与快捷方式的 AUMID 都是 `cn.piarc.desktop`，与主进程 `app.setAppUserModelId` 一致；pack id 不能用 `PiArc`，否则安装目录 `%LocalAppData%\PiArc` 与数据目录重合，卸载会删掉数据。

### 9.1 CI 与本机检查（W0，2026-11-16）

机器见 S2 报告第 8 节（Windows 11 专业版 25H2 26200.9974，x64）。

- CI 运行 43827342553（提交 1ab2417）：`package Windows (x64)`、`package Windows (arm64)` 通过。x64 产物 `piarc-windows-x64-velopack` 包含：
  - `cn.piarc.desktop-0.0.1-win-x64-full.nupkg` 与 `0.0.2-full.nupkg`（各 207.8 MiB）；
  - `0.0.2-delta.nupkg`（1.0 MiB）；
  - `cn.piarc.desktop-win-x64-Setup.exe`（214.9 MiB，安装最新版 0.0.2）；
  - `Portable.zip`、`releases.win-x64.json`、`RELEASES-win-x64`。
- 本机发布构建：`npm run package:desktop` 之后，`npm run check:fuses` 9 项全部与发布配置一致，`check-app-layout.mjs --flavor release` 10 项通过（`tmp/evidence/W0/check-fuses.log`、`check-layout-release.log`）。
- 打包产物的 Agent Host：L4 `agent-host.e2e.ts`（打包形态）在 Windows 上通过。Core 经 Job Object 用内置 `node.exe` 启动 Agent Host，完成 Bash（Git Bash）、Grep、Glob 与内置 npx 拉起的 MCP 一轮 mock 对话。结束主进程后，Agent Host 的进程树全部退出（S8 报告第 10 节）。
- 通知（L4 `notification.e2e.ts`）：Windows 上 Electron 先发 `show`，系统拒绝时随后再发 `failed`。本机这次是 `failed`："Settings prevent the notification type from being delivered"，因为打包目录里的开发构建没有带 AUMID 的开始菜单快捷方式，或者系统通知设置挡住了它。CI 的 Windows runner 上只有 `show`。与 macOS 不同，Windows 上的 `failed` 能反映投递被拒（I43 的 Windows 部分），用例改为允许 `show` 之后跟 `failed`。
- 更新包：用 Portable 包里的 `Update.exe patch` 把 `0.0.1-full` 加 `0.0.2-delta` 重建为完整包，用时 34 s。重建包的 SHA-256 与 CI 的 `0.0.2-full` 不同（zip 重新组装），但 2,026 个文件的名称、大小与 CRC 全部一致。这正是 UpdateManager 下载 delta 后要做的一步。
- 安全设置（只读注册表，未改）：
  - 智能应用控制 `VerifiedAndReputablePolicyState=0`（关）；
  - 资源管理器的 SmartScreen"检查应用和文件"为 `Off`；
  - Defender 实时保护开启。
  
  所以在这台机器上运行安装包时，资源管理器层面的 SmartScreen 拦截不会出现（与 macOS 上 Gatekeeper 被关闭同类，I42）。以用户在"Windows 安全中心"界面看到的状态为准（检查清单第 8.1 节 W1）。

### 9.2 体积

| 项 | 预算 | x64 |
|---|---|---|
| 安装包（`Setup.exe`，CI 的开发构建） | ≤ 200 MB | 214.9 MiB（225.3 MB），**超出约 25 MB** |
| 本机发布构建的打包目录 | — | 492.5 MiB（516.4 MB） |
| 安装后（`%LOCALAPPDATA%\cn.piarc.desktop\current`，CI 的开发构建 0.0.2） | ≤ 450 MB | 497.2 MiB（521.3 MB），**超出约 71 MB** |
| 安装目录合计（另含 Velopack 为增量更新缓存的完整包 207.8 MiB、`Update.exe` 5.0 MiB、启动桩） | — | 710.4 MiB（745.0 MB）；卸载登记的 `EstimatedSize` 为 509,120 KiB |

打包目录各部分：`PiArc.exe` 238.5 MiB（与 Electron 45.3.2 原版 `electron.exe` 同样大）、`locales` 48.8 MiB、`dxcompiler.dll` 24.6 MiB、`resources.pak` 12.8 MiB、`icudtl.dat` 10.3 MiB、其余 Chromium 文件约 25 MiB；`resources/agent-host` 126.1 MiB（内置 node 101.7 MiB、`agent-host.mjs` 14.2 MiB、rg 与 fd 7.9 MiB、photon-node 2.2 MiB）；`app.asar` 与 Core 9.5 MiB。Electron 本体就有约 360 MiB，Windows 版比 macOS 的 Electron Framework（250 MiB）大得多，加上内置 node，打包目录已经超出安装后 450 MB 的预算。按任务要求 W0 不裁剪，与 I41 一起交 R1 决定（方向：去掉不需要的 locales、Velopack 安装包只带一个架构、校准 Windows 的预算）。

### 9.3 实机项（2026-11-16，用户操作 + 智能体检查）

| 项 | 结果 |
|---|---|
| 安全设置（用户截图，未更改） | "检查应用和文件"**关**；"适用于 Microsoft Edge 的 SmartScreen"开；网络钓鱼防护开；"阻止可能不需要的应用"关；"适用于 Microsoft Store 应用的 SmartScreen"开。智能应用控制：注册表 `VerifiedAndReputablePolicyState=0`（关），截图未包含该页 |
| 下载 | 用户用 Edge 从 CI 运行页面下载 `piarc-windows-x64-velopack.zip`，**没有下载警告**；资源管理器"全部解压缩"。zip 与解压出的 `Setup.exe` 都带 `Zone.Identifier`，`ZoneId=3`（来自网络），zip 的 `ReferrerUrl` 是 CI 运行页面 |
| SmartScreen 放行流程 | **本机无法观察**：双击 `Setup.exe` 后没有出现"Windows 已保护你的电脑"，直接安装。原因是"检查应用和文件"关闭，不是标记丢失（文件带 `ZoneId=3`）。"更多信息 → 仍要运行"的步骤要在开着该开关的机器上做（I42 的 Windows 部分，登记 I49） |
| 智能应用控制 | 当前状态为关，未实测；按 ADR-0018 预期，开启时未签名的安装包与应用无法运行 |
| 安装 | 按用户安装到 `%LOCALAPPDATA%\cn.piarc.desktop\`（`current\`、`packages\`、`Update.exe`、启动桩 `PiArc.exe`），**没有 UAC**，安装后自动打开 PiArc；卸载登记在 HKCU（`DisplayName` PiArc、`DisplayVersion` 0.0.2、`Publisher` PiArc）；开始菜单与桌面各一个快捷方式，AUMID 都是 `cn.piarc.desktop`（与主进程 `setAppUserModelId` 一致），目标 `current\PiArc.exe` |
| 图标 | 安装后的 `PiArc.exe`、`Setup.exe`、启动桩与 `design/brand/icon.ico` 的系统渲染一致（`tmp/evidence/W0/icon/compare.png`） |
| 首次运行与 Agent Host | 已安装的应用用 `node scripts/dev/s6-probe.mjs agent-host` 驱动：Core 经 Job Object 用内置 node 启动 Agent Host（Pi 1.5.2），mock 对话中 Bash 工具经 Git Bash 输出 `bash-ok`，`turn.status: completed`（`tmp/evidence/W0/s6-installed-agent-host.json`）。结束主进程后进程树全部退出的验证见 S8 报告第 10 节 |
| 系统通知 | 已安装、带 AUMID 快捷方式的应用：`show`（19 ms）之后 `failed`（44 ms，"Settings prevent the notification type from being delivered"）。原因是系统通知总开关关闭（`PushNotifications\ToastEnabled=0`），横幅**本机无法观察**；程序侧的 `failed` 正确反映了投递被拒 |
| 相邻版本更新 | **可行**。已安装的 `Update.exe apply --norestart --package <0.0.1-full>` 换装 0.0.1（14 s），再 `apply` 由 `Update.exe patch` 用 0.0.1 完整包 + 0.0.2 delta 重建的完整包（17 s）：`sq.version` 与卸载登记的版本 0.0.2 → 0.0.1 → 0.0.2，都没有 UAC；数据目录中的标记文件保留，两个快捷方式保留，`packages\` 只留最新完整包；更新后 mock 对话再次 `completed`（`tmp/evidence/W0/update-apply-*.log`、`s6-updated-agent-host.json`）。应用内的检查更新、下载 delta 与提示由 T50 实现 |
| Defender | 下载、安装、运行、更新、卸载全程没有报警（用户确认）；`Get-MpThreatDetection` 6 小时内 0 条 |
| 卸载 | 用户在"设置 → 应用 → 已安装的应用"中卸载，顺利完成，无 UAC。之后安装目录、开始菜单与桌面快捷方式、HKCU 卸载登记、通知注册项都不存在，无残留进程。留下：`%APPDATA%\PiArc\`（Electron 默认的 userData，71 个文件 9.5 MiB 的 Chromium 缓存与本地存储；架构第 9.1 节要求用 `app.setPath('userData', …)` 改到 `%LOCALAPPDATA%\PiArc\`，尚未实现，登记 I48）与 `%LOCALAPPDATA%\velopack\` 下 Velopack 自己的两份日志（约 85 KB） |
| 微软拼音 | 用户在已安装的应用中核对，composer 与终端全部符合预期（S1 报告第 8 节、S7 报告第 11.4 节） |

结论（Windows）：**有条件通过**。

- **通过的部分**：按用户安装、无 UAC、Job Object 下的 Agent Host、相邻版本更新、卸载后程序文件与登记清理、图标与 AUMID。
- **未达标的部分**：安装包 225 MB、安装后 521 MB，都超出预算（I45）。
- **本机无法观察的部分**：本机关闭了 SmartScreen"检查应用和文件"与系统通知，SmartScreen 放行流程与通知横幅都看不到（I49）。
- **留给后续任务**：卸载后留下 Electron 默认 userData（I48）。

## 10. 实机项

2026-11-16 在用户的 Mac（macOS 26.5.2）上按检查清单完成，细节见清单第 7 节。用户实测时发现钥匙串探针写入的键名不合保险箱规则（`probe/s6`），已先写失败测试再修复（提交 89c560f）并重打构建 A、B。

| 项 | 结果 |
|---|---|
| 首次打开、"仍要打开"（macOS 26、macOS 15） | 未验证：这台 Mac 的 Gatekeeper 评估被关闭，浏览器下载的 DMG 也没有隔离属性；没有 macOS 15 设备（I42） |
| `xattr -dr com.apple.quarantine` 备选 | 未验证（同上） |
| Gatekeeper 是否单独拦截内置 node | 未出现拦截，但 Gatekeeper 关闭，不构成证据（I42） |
| 通知 | 允许通知后横幅显示（用户目视确认，系统日志 `displaying as banner`）；允许通知为关时程序仍收到 `show`，事件不反映投递结果；应用退出时 Electron 删除已投递的通知（I43） |
| 钥匙串授权弹窗次数 | 构建 A 创建与读取 0 次；换装构建 B 后第一次读取 1 次（用户确认），之后 0 次，符合 ADR-0018 的预期 |

## 11. 结论

- 有条件通过（macOS）：打包、签名分层、hardened runtime、fuses、内置运行时与宽松 Seatbelt、发布清单都已验证；钥匙串每次更新弹 1 次，符合 ADR-0018。
- 系统通知在 ad-hoc 签名下可用：允许通知后横幅显示；但程序侧事件不可靠，用户关闭通知时仍收到 `show`（I43）。
- 未验证：Gatekeeper 开启时的首次打开（"仍要打开"、备选命令、对内置 node 的表现），这台 Mac 关着 Gatekeeper，也没有 macOS 15 设备（I42）。
- 安装后体积贴着预算（I41），需要在 R1 决定余量策略。
- 内置 node 的官方 entitlements 允许同一用户调试附加 Agent Host（I39），这是保留官方签名的代价。
