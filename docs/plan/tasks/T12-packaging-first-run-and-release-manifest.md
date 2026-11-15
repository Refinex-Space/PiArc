# T12 打包、首次运行与发布清单（S6）

| 项 | 内容 |
|---|---|
| 阶段 | 1 M0 技术验证 |
| 依赖 | T03、T04、T06、T08、T11 |
| 执行平台 | macOS（CI 同时产出 Windows 安装包；Windows 实机在 W0） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 大 |
| 关联验证项 | S6（未签名打包、首次运行、内置 Node 与发布清单） |
| 需要的用户决定 | D2（应用标识与产品域名：bundle id、AppUserModelID、发布清单地址） |
| 关口 | 实机关口：首次打开、通知目视确认、钥匙串弹窗计数由用户在实机上操作 |

启动方式：在仓库根目录开新会话，输入 `/task T12`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

PiArc 不做平台代码签名（ADR-0018）：macOS 只做 ad-hoc 签名，Windows 不签名，更新的完整性靠项目密钥签名的发布清单。这带来一串需要实测的问题：macOS 15 与 26 上首次打开是否出现"仍要打开"，Gatekeeper 会不会单独拦截 Core 启动的内置 node，ad-hoc 签名下系统通知能否使用，每次更新后钥匙串弹几次授权。Agent Host 由 Core 经 `sandbox-exec` 启动内置 Node（ADR-0015），这条路径也要在打包产物里跑通，包括 MCP 常用的 `npx`。

S6 的通过标准（架构第 16 章）：macOS 15 与 26 上能按指引完成首次打开；Gatekeeper 不单独拦截内置 node；系统通知可用性有结论；Velopack 未签名安装与更新可用；清单签名校验失败时拒绝更新；fuses 配置确定。

本任务在 macOS 上产出安装包、跑通打包后的完整链路、实现发布清单的签名与校验，并准备首次运行检查清单。需要在系统界面上点击的步骤由用户完成。Windows 安装包由 CI 产出，安装、更新、SmartScreen 与智能应用控制在 W0 实机验证。

## 必读

1. 架构设计：
   - 第 5.6 节"运行时与打包"
   - 第 10.3 节"进程加固"中应用二进制与 Agent Host 两段；第 10.1 节中"更新通道被劫持""应用文件被篡改"两行
   - 第 13.1–13.3 节；第 8.8 节中系统通知一行；第 9.1 节中凭据保险箱一段
   - 第 11 章安装包体积两行；第 14 章 R18
2. ADR-0015、ADR-0018 全文；ADR-0016（背景，已被 ADR-0018 取代）。
3. `docs/research/electron-stack.md` 第 5 节；`docs/research/pi-v1.4.0-baseline.md` 第 8.1、8.3 节（`PI_PACKAGE_DIR` 与 rg、fd 预置）。
4. T03（fuses 与 `check-fuses.mjs`）、T04（`.node` 加载）、T06（`piarc-host` 启动 Agent Host）的代码与 CLAUDE.md；T11（Job Object）、T08（`piarc-secrets`）不在依赖中，已完成时一并阅读。
5. 实现时查阅：Forge 的 `make`、`maker-dmg`、`maker-zip` 与 `plugin-fuses` 的 `resetAdHocDarwinSignature`；Velopack 官方 Electron 指南；Node.js 官方发行包与 SHASUMS256；`codesign`、`spctl`、`xattr` 的手册；minisign 格式说明。

## 范围

### 要做

- macOS DMG 与 ZIP（arm64、x64，ad-hoc）；Windows Velopack 安装包（x64、arm64，不签名，CI 产出）。
- 内置 Node、rg、fd 与 Agent Host 资源按第 5.6 节布局；Core 从打包产物启动 Agent Host；`PI_PACKAGE_DIR`；内置 npx 拉起 MCP stdio server。
- 发布清单的生成、测试密钥签名与 Core 内的校验。
- 首次运行检查清单与实机结果记录；体积对照；S6 报告（macOS 部分）。

### 不做

- 自动更新流程、更新检查与提示界面、发布流水线与正式签名密钥（T50）。
- `THIRD_PARTY_NOTICES` 生成、README 与下载页的首次运行指引（T50）。
- Agent Host Seatbelt 配置定稿（T39）、Defender 扫描流水线（T50）。

## 交付物

### 1. 打包与签名

- macOS：Forge `make` 产出 DMG 与 ZIP，arm64 与 x64 各一套；写入 fuses 后用 `resetAdHocDarwinSignature` 重新 ad-hoc 签名；`check-fuses.mjs` 对最终产物通过。
- 签名分层：内置 node 保留 Node.js 官方签名，不重签；rg、fd、`.node` 用 ad-hoc 签名；整体签名不能覆盖 node 的签名（例如对整个 bundle `--deep` 重签）。签名后用 `codesign --verify --deep --strict` 与 `spctl --assess` 检查并记录结果。
- hardened runtime：验证 ad-hoc 签名下能否启用（库验证可能要求同一 Team ID）；不能启用就不启用，结论写入报告与架构第 10.1、10.3 节。
- Windows：按 Velopack 官方 Electron 指南，由 CI 产出 x64 与 arm64 安装包（按用户安装、不签名），同时产出版本号相邻的两个版本供 W0 验证更新机制。Velopack 与 Forge/Vite 集成问题过多时，按 ADR-0018 第 3 条退回 electron-builder NSIS，并写 ADR（补充）说明。
- 图标：Forge 的 `packagerConfig.icon` 与安装包图标直接引用 `design/brand/`（macOS `icon.icns`、Windows `icon.ico`，来源见该目录 README），不在 `apps/desktop` 中另存副本。
- 应用标识（bundle id、AppUserModelID）取自集中定义的应用标识（D2）。D2 未落实时用临时标识完成测量，并在报告中注明。

### 2. 内置运行时与 Agent Host 启动

- 构建脚本下载 Node LTS 官方发行包（与 Electron 内置 Node 同一大版本，版本写在构建清单中）并按 SHASUMS256 校验；rg、fd 下载官方发布产物并校验 SHA256；全部放在 asar 之外（第 5.6 节布局）。
- Core 从打包产物启动 Agent Host：macOS 经 `/usr/bin/sandbox-exec -f <宽松配置> -D …`（第 10.3 节：读取广泛路径；写入限于工作区、数据目录、会话临时目录；允许网络）；Windows 经 Job Object：T11 已完成时复用其实现；未完成时在本任务实现，放置方式遵循 T11 交付物 4 的原则（由 `piarc-core` 注入 `ProcessSpawner` 实现），之后由 T11 复用。环境变量按第 5.6 节最小化，`PI_PACKAGE_DIR` 指向 `pi-assets/`，PATH 前置内置 Node 的 `bin`。
- 在宽松配置下逐项验证 ADR-0015 列出的 S6 待办：Pi 的 bash、grep、find，git，`worker_threads`，内置 npx 拉起 MCP stdio server；npx 安装的含原生模块的 MCP server 能否被保留官方签名的 node 加载。
- 打包产物的测试入口：用测试专用的启动参数把模型请求指向 T05 的 mock provider。该参数只在测试构建中生效，或经评估确认在发布构建中无害，结论写进报告。
- 研究 Core 启动的子进程在 macOS TCC 上的责任归属（ADR-0015 待办），写入报告。

### 3. 发布清单

- 生成脚本：输入一组产物，输出清单（版本号、文件名、大小、SHA-256），用 minisign 格式的测试密钥签名。测试密钥对只用于测试，文件名标明 test；正式密钥由 T50 在受保护环境中管理。
- Core 中的校验：先验证清单签名（内置公钥），再验证文件哈希；任一失败返回结构化错误，调用方拒绝继续。所在 crate 与模块在 crate 文档中说明。
- minisign 校验如果 T10 已经实现则复用，否则在本任务实现并登记到复用表。

### 4. 首次运行检查清单（实机关口）

`docs/spikes/S06-first-run-checklist.md`：智能体准备产物与逐步说明，用户在实机上操作并告知结果。

| 项 | 内容 |
|---|---|
| 首次打开 | 经浏览器下载 DMG（带隔离属性）→ 拖入"应用程序"→ 打开；被拦下后"系统设置 → 隐私与安全性"中是否出现"仍要打开"；macOS 15 与 26 分别记录 |
| 备选方案 | 按钮不出现时，执行 `xattr -dr com.apple.quarantine` 后能否打开 |
| 内置 node | Core 启动内置 node 时，Gatekeeper 是否单独拦截 |
| 系统通知 | 应用发出的通知是否显示；程序侧是否收到失败事件 |
| 钥匙串弹窗 | 构建 A 创建主密钥后，安装构建 B 并读取凭据，统计授权弹窗次数（ADR-0018 预期 ≤ 1） |

- 没有 macOS 15 或 26 设备时，对应项记录"未验证"与原因。
- 产物与清单准备好后，看板状态改为"阻塞（等待用户实机操作）"，报告中写明用户要做什么、要反馈什么；收到结果后继续。

### 5. S6 报告

`docs/spikes/S06-packaging-first-run.md`：产物与签名检查、hardened runtime 结论、fuse 最终配置、宽松配置下的验证结果、清单签名、首次运行检查结果、体积（DMG 与安装后体积，对照第 11 章）、结论。macOS 已验证：上述各项；待 W0：Velopack 安装、启动、卸载、相邻版本更新、SmartScreen、智能应用控制、Windows 体积。更新 `docs/spikes/README.md`。

## 实现要点

- 下载的第三方二进制（node、rg、fd、Velopack 工具）的版本与哈希集中在一个入库清单中，哈希不符时构建失败。
- 钥匙串弹窗计数依赖 T08 的 `piarc-secrets`，但看板依赖中没有 T08：开工时检查 T08 状态，未完成时先做其余部分，这一项在 T08 完成后补测。
- 全局安装工具（例如 Velopack CLI 依赖的运行时）需要用户同意；能在 CI 中完成的放在 CI。
- 安装后体积在 macOS 上量 `.app` 目录；体积超出预算时列出各部分占用，不在本任务中裁剪功能。

## 验收标准

- [T12-A01] 本机产出 arm64 与 x64 的 DMG 与 ZIP；最终产物为 ad-hoc 签名，`codesign --verify --deep --strict` 通过，`check-fuses.mjs` 通过。验证：命令输出。
- [T12-A02] hardened runtime 在 ad-hoc 签名下能否启用有结论与证据，已写入报告与架构第 10.1、10.3 节。验证：`codesign -dv` 输出与文档改动。
- [T12-A03] 产物布局符合第 5.6 节：内置 node 保留 Node.js 官方签名，rg、fd 与 `.node` 为 ad-hoc 签名，Agent Host 资源在 asar 之外；运行中 Pi 经 `PI_PACKAGE_DIR` 找到资源，不在运行时下载 rg、fd。验证：布局检查脚本、`codesign -dv` 输出与运行日志。
- [T12-A04] CI 配置产出 Windows x64 与 arm64 Velopack 安装包（含版本相邻的两个版本）与 macOS 产物，配置语法有效。验证：actionlint 输出；实际产物需要用户推送后由 CI 产出，未取得时标 `blocked`，由 W0 核对。
- [T12-A05] 打包后的应用经 `sandbox-exec` 宽松配置启动内置 node 运行 Agent Host，并完成一轮 mock 对话。验证：针对打包产物的 Playwright 测试。
- [T12-A06] 宽松配置下 Pi 的 bash、grep、find、git、`worker_threads` 正常，写入允许范围以外的位置失败。验证：测试输出。
- [T12-A07] 内置 npx 拉起本地夹具 MCP stdio server，server 进程使用的是内置 node；含原生模块的 npx 包的加载结果已记录。验证：测试输出与报告。
- [T12-A08] 清单签名校验通过；篡改清单内容、篡改文件哈希、换用其他密钥签名三种情况都返回结构化错误并拒绝。验证：测试。
- [T12-A09] 首次运行检查清单各项有结论，macOS 15 与 26 分别记录，用户确认的项注明，未验证的项写明原因。验证：检查清单文件（实机关口）。
- [T12-A10] ad-hoc 签名下系统通知的可用性有结论，包括程序侧事件与用户目视确认。验证：测试输出与检查清单。
- [T12-A11] 两次构建之间的钥匙串授权弹窗次数已记录，并与 ADR-0018 的预期对照。验证：检查清单（用户操作）。
- [T12-A12] macOS arm64 DMG ≤ 200 MB，安装后体积 ≤ 450 MB；Windows x64 安装包体积在 CI 产物取得后补记。验证：体积测量输出。
- [T12-A13] S6 报告（macOS 部分）含各项结论与待 W0 的项，`docs/spikes/README.md` 已更新。验证：文件内容。
- [T12-A14] 安装包与应用使用 `design/brand/` 的图标（macOS `icon.icns`、Windows `icon.ico`），`apps/desktop` 中没有另存图标副本。验证：Forge 配置与两个平台产物的图标截图。
- [T12-A15] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新 `apps/desktop/CLAUDE.md`：打包命令、签名分层、产物布局检查、测试入口。
- 更新 `crates/piarc-host/CLAUDE.md`：打包后的启动路径、宽松 Seatbelt 配置的位置、环境变量。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：第三方二进制下载与校验、发布清单生成与校验、布局检查脚本。
- 根 `CLAUDE.md` 的"命令"一节补上打包命令（实际执行成功后）。
