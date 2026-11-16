# S6 未签名打包、首次运行、内置 Node 与发布清单

| 项 | 内容 |
|---|---|
| 任务 | T12（2026-11-16） |
| 结论 | macOS：自动化部分通过，首次运行部分等待实机操作。arm64 与 x64 的 DMG、ZIP 本机产出，分层 ad-hoc 签名与 fuse 检查通过；hardened runtime 可以启用（需 `disable-library-validation`）；打包产物经 `sandbox-exec` 宽松配置启动内置 node 完成 mock 对话，bash、grep、find、git、`worker_threads`、npx 拉起 MCP、原生模块正常，越界写入被拒；发布清单签名与三种篡改用例通过；arm64 DMG 168.8 MB、安装后 449.0 MB，都在预算内（后者只余约 1 MB）。首次打开、Gatekeeper 对内置 node 的表现、通知横幅、钥匙串弹窗次数待用户按检查清单操作。Windows：CI 配置就绪，产物与实机待推送后的 CI 与 W0 |
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

程序侧：L4 `notification.e2e.ts`（打包形态）在 ad-hoc 签名、hardened runtime 的开发构建上调用 `new Notification().show()`：`Notification.isSupported()` 为 true，7 ms 后收到 `show` 事件，没有 `failed`（`tmp/evidence/T12/l4/notification*/notification.json`）。程序因此能得知结果，通知不可用时可以按 ADR-0018 第 6 条退回应用内提醒。横幅是否真的显示、系统设置中是否出现 PiArc，待用户在检查清单第 4 项目视确认。

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

Windows x64 安装包体积在 CI 产物取得后补记（W0）。

## 9. Windows（待 CI 与 W0）

- CI 作业 `package-windows`：x64 与 arm64（arm64 在 x64 runner 上交叉构建 Core），开发构建（带 W0 需要的测试入口），`check:fuses` 与布局检查，`vpk pack` 出 0.0.1 与 0.0.2 两个版本到同一个发布目录。actionlint 1.7.12 对 `.github/workflows/ci.yml` 无报错（`tmp/evidence/T12/actionlint.txt`；shellcheck 未安装，相关规则未运行）。
- Velopack 接入：主进程最先运行 `VelopackApp.build().run()`（只在打包后的 Windows 构建，绑定从 app.asar 的 `node_modules` 加载，只带目标架构的 `.node`）；`vpk` 对非 .NET 主程序跳过 VelopackApp 检查。pack id 与快捷方式的 AUMID 都是 `cn.piarc.desktop`，与主进程 `app.setAppUserModelId` 一致；pack id 不能用 `PiArc`，否则安装目录 `%LocalAppData%\PiArc` 与数据目录重合，卸载会删掉数据。
- 待 W0：安装（按用户、无 UAC）、启动后经 Job Object 运行 Agent Host 并完成 mock 对话、卸载残留、相邻版本更新、SmartScreen、智能应用控制、安装包与安装后体积、Defender 表现；Windows 上 AUMID 与 Velopack 快捷方式是否一致、通知是否显示。

## 10. 实机项（待用户）

检查清单 [S06-first-run-checklist.md](S06-first-run-checklist.md) 已准备好构建 A、构建 B（同一应用改版本号重签，代码身份不同）与驱动脚本 `scripts/dev/s6-probe.mjs`。待用户操作的项：

| 项 | 状态 |
|---|---|
| 首次打开、"仍要打开"（macOS 26、macOS 15） | 待用户操作 |
| `xattr -dr com.apple.quarantine` 备选 | 待用户操作 |
| Gatekeeper 是否单独拦截内置 node | 待用户操作 |
| 通知横幅目视 | 待用户操作（程序侧已通过） |
| 钥匙串授权弹窗次数（构建 A 创建、构建 B 读取） | 待用户操作 |

## 11. 结论

- 有条件通过（macOS）：打包、签名分层、hardened runtime、fuses、内置运行时与宽松 Seatbelt、发布清单都已验证；首次运行四项待实机结果，收到后在本节更新结论。
- 安装后体积贴着预算（I41），需要在 R1 决定余量策略。
- 内置 node 的官方 entitlements 允许同一用户调试附加 Agent Host（I39），这是保留官方签名的代价。
