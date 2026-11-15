# T50 发布流水线与更新

| 项 | 内容 |
|---|---|
| 阶段 | 6 M5 Beta |
| 依赖 | T49 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 大 |
| 关联验证项 | 无（以 S6 报告的结论为前提） |
| 关联需求 | FR-SY-06；NFR-05（第三方许可证） |
| 需要的用户决定 | D2（更新源与下载页地址依赖应用标识与产品域名）；D6（是否发布 Intel 版本，未决定时按需求文档的建议首发提供）；正式的清单签名密钥由用户生成并存入 GitHub 受保护环境，智能体不接触私钥 |
| 关口 | 两处由用户执行：① 推送代码、创建需要维护者审批的受保护环境并存入私钥、触发发布流水线并批准签名步骤，等待期间状态改为"阻塞（等待用户触发发布流水线）"；② 把草稿发布公开。本任务只产出草稿发布，公开不在本任务内 |

启动方式：在仓库根目录开新会话，输入 `/task T50`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

PiArc 不做平台签名（ADR-0018），发布完整性靠项目自己的发布清单签名：每个版本一份清单（文件名、大小、SHA-256），用 Ed25519 密钥按 minisign 格式签名，应用内置公钥，验证失败就拒绝更新。T12 已经产出安装包、用测试密钥签过清单、在 Core 中实现了校验逻辑。本任务把它变成可重复的发布流程：

- CI 发布流水线：四个目标的构建、ad-hoc 签名、Velopack、fuse 检查、Defender 扫描、清单与签名、GitHub Releases 草稿；
- 两个平台的更新路径：macOS 发现新版本后提示并打开下载页，Windows 由 Velopack 自动更新，两者都先验证清单签名；
- 合规与说明：`THIRD_PARTY_NOTICES`、"关于"页、首次运行指引、发布与 Electron 升级的操作文档。

签名私钥只在需要维护者审批的 CI 环境中使用（架构第 10.1 节"更新通道被劫持"一行）。完成标志是一次完整的草稿发布，公开由用户在确认后执行。

## 必读

1. 架构设计：
   - 第 8.8 节（更新一行）、第 10.1 节（更新通道被劫持、应用文件被篡改、供应链三行）、第 10.3 节（应用二进制）、第 10.4 节"合规"、第 10.5 节
   - 第 13 章全部，第 14 章 R17、R18，第 15.2 节"签名与安装""杀毒软件"两行
2. ADR-0018 全文，ADR-0015。
3. `docs/research/electron-stack.md` 第 5 节。
4. T03 的 `scripts/ci/check-fuses.mjs`、T12 的打包配置、清单生成与 Core 校验代码、S6 报告；T45 的依赖审计配置。
5. 实现时查阅：Velopack 锁定版本的 JS API（检查、下载、应用更新的步骤）、Electron Forge 锁定版本的 maker 配置、minisign 的命令行用法、Microsoft Defender 命令行扫描的官方文档、GitHub Actions 受保护环境与 `gh release` 的文档。

## 范围

### 要做

- 发布流水线、清单格式定稿与签名环境、两个平台的更新检查与校验。
- `THIRD_PARTY_NOTICES` 生成与检查、"关于"页。
- README 与发布说明模板中的首次运行指引、发布流程文档、Electron 升级流程文档。

### 不做

- macOS 应用内自动替换（ADR-0018 第 2 条，第一版不做）。
- WinGet、Homebrew 与任何应用商店渠道（ADR-0018 第 7 条）。
- Velopack 实机更新验证（W4）、草稿发布的公开（用户）。

## 交付物

### 1. 发布流水线 `.github/workflows/release.yml`

- 触发：推送 `v*` tag 或手动触发；产物一律进入草稿发布。
- 构建矩阵：darwin-arm64、darwin-x64（按 D6）、win32-x64、win32-arm64。macOS 出 DMG 与 ZIP（ad-hoc 重签），Windows 出 Velopack 安装包与更新包（不签名）。每个产物跑 `check-fuses.mjs`。
- Windows 产物在 Windows runner 上用 Microsoft Defender 扫描，结果写入作业日志。
- 清单作业汇总产物生成清单；签名作业运行在受保护环境（需要维护者审批），只下载清单并签名，不安装依赖、不执行仓库的构建脚本；最后创建草稿发布，附上全部产物、清单、签名、`THIRD_PARTY_NOTICES` 与发布说明。
- 每个作业的 `permissions` 取最小值；第三方 action 按提交 SHA 固定；依赖安装用 `npm ci --ignore-scripts`。
- `scripts/release/check-workflow-secrets.mjs`：签名私钥的 secret 只能出现在签名作业中，其他作业与 PR 流水线引用即失败，并入 verify。

### 2. 清单格式与签名

- 在 T12 的基础上定稿：版本号、发布日期、是否安全更新及说明、每个产物的平台、架构、类型、文件名、大小、SHA-256，下载页与发布说明地址。JSON Schema 入库并有测试。
- 公钥内置在 Core 中，同时写进 README。
- `scripts/release/verify-release.mjs`：下载一个发布的全部文件，校验清单签名与每个文件的哈希，供发布后核对与用户手动使用。

### 3. macOS 更新检查

- 主进程在启动时和之后每 24 小时获取清单与签名（HTTPS），由 Core 验证签名，按 SemVer 比较；低于或等于当前版本的清单忽略（防降级）。
- 有新版本时在应用内提示：版本号、更新说明；安全更新单独标明。点击后经现有的外链确认流程用系统浏览器打开下载页（只放行 `https:`）。
- 网络失败、签名失败、解析失败都不提示新版本；签名失败写日志，并在"关于"页显示"更新信息校验失败"。
- 请求不携带版本号与 User-Agent 以外的任何标识（第 10.5 节）。

### 4. Windows Velopack 更新

- 启动时和之后每 24 小时检查。应用更新前先获取并验证签名清单，再核对下载包的 SHA-256 与清单一致；任一失败即中止、删除已下载的包并提示，不应用更新。
- 校验通过后提示用户重启以完成更新。检查、下载、应用的调用方式以 Velopack 锁定版本文档为准。

### 5. `THIRD_PARTY_NOTICES` 与"关于"页

- `scripts/release/gen-notices.mjs`：覆盖发布产物中实际包含的组件：Rust crates、打进主进程、渲染进程与 Agent Host bundle 的 npm 依赖（按构建的 metafile 统计，不按整个 `node_modules`）、Pi、libghostty-vt、fork 的 ghostty-web 渲染器代码、内置 Node、rg、fd；随包附带 Electron 与 Chromium 的许可证文件。选用的生成工具按补充型决策处理并通过 cargo-deny。
- 检查脚本：发布产物中有组件缺少许可证条目或许可证文本即失败。
- "关于"页：应用、AHP 协议、Electron、Pi、内置 Node、libghostty-vt 的版本与构建提交，数值由构建时生成的元数据提供；可查看第三方许可证全文（按纯文本渲染）。

### 6. 文档

- README：下载与首次运行指引（macOS：先拖入"应用程序"再打开、"仍要打开"、`xattr -dr com.apple.quarantine` 及其含义；Windows：SmartScreen 的"更多信息 → 仍要运行"、开启智能应用控制的电脑无法运行及原因，不引导用户关闭系统安全功能）、公钥与手动校验命令、两个平台的更新方式。只新增这些小节，不改动 README 其他内容。
- 发布说明模板：GitHub Release 页面即下载页，包含简版首次运行指引与 README 链接。
- `docs/engineering/release.md`：发布步骤与角色、受保护环境与审批、密钥生成（由用户离线完成并备份）、密钥轮换与泄露处置、Defender 误报的样本提交、"安全更新"的判定标准。
- `docs/engineering/electron-upgrade.md`：按第 13.4 节写明升级评估时限、步骤（破坏性变更核对、四个目标的 NAPI 重建、fuses、L1/L2/L4 与性能测试、更新流程回归、S10 安全清单复核、内置 Node 版本对齐 ADR-0015）与在野高危漏洞的紧急发版路径。

## 实现要点

- 发布流水线先在本地验证：actionlint、清单与签名脚本用测试密钥跑通、`verify-release.mjs` 对本地产物通过，再请用户推送触发。
- 更新检查的时钟与清单地址可注入，测试不访问网络、不真实等待 24 小时。
- 草稿发布产生后，用 `gh release view` 只读核对状态与附件；不要执行任何公开发布或修改发布状态的命令。

## 验收标准

- [T50-A01] 发布流水线包含四个目标的构建、ad-hoc 重签、Velopack 打包、fuse 检查、Defender 扫描、清单、受保护环境中的签名与草稿发布；actionlint 通过，第三方 action 全部按提交 SHA 固定。验证：actionlint 输出与检查结果。
- [T50-A02] 签名私钥只在需要维护者审批的受保护环境中的签名作业里引用，其他作业与 PR 流水线引用时 `check-workflow-secrets.mjs` 失败。验证：脚本输出（含一次临时违规演示）与 `gh api` 读取的环境保护设置。
- [T50-A03] 一次完整的草稿发布已产生且未公开：四个目标的产物、清单、签名、`THIRD_PARTY_NOTICES` 齐全，`verify-release.mjs` 对下载的文件校验签名与哈希全部通过。验证：`gh release view --json isDraft,assets` 输出与脚本输出。
- [T50-A04] macOS 在启动时与每 24 小时检查一次更新；有新版本时显示版本号与说明，安全更新单独标明，点击后打开下载页。验证：测试（时钟注入）与 Playwright 截图（`tmp/evidence/T50/`）。
- [T50-A05] 清单签名错误、文件哈希不符、清单版本不高于当前版本三种情况下，macOS 不提示新版本，Windows 不应用更新，签名失败被记录。验证：两个平台的测试输出。
- [T50-A06] Windows 更新路径在应用前验证清单签名与更新包哈希，失败时中止并删除已下载的包。验证：Windows CI 测试输出（本地更新源夹具）。
- [T50-A07] `THIRD_PARTY_NOTICES` 覆盖交付物 5 列出的全部组件；临时移除一个组件的许可证条目时检查脚本失败。验证：脚本输出。
- [T50-A08] "关于"页显示的六项版本与构建提交和锁文件、`package.json`、`Cargo.toml` 中的值一致，可查看第三方许可证全文。验证：测试与 Playwright 截图。
- [T50-A09] README 与发布说明模板包含两个平台的首次运行指引、公钥与手动校验步骤；按 README 的步骤手动校验一次草稿发布中的产物成功。验证：文件内容与命令输出。
- [T50-A10] `release.md` 与 `electron-upgrade.md` 覆盖交付物 6 列出的要点。验证：两份文档的章节标题。
- [T50-A11] 草稿发布的流水线中 Defender 扫描无检出；有检出时已按 `release.md` 提交误报样本并记录。验证：作业日志。
- [T50-A12] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新架构第 13.2、13.3 节中与实际流水线不一致的描述（补充型）。
- 更新根 `CLAUDE.md` 的"命令"一节：发布前本地检查与 `verify-release.mjs` 的用法（只写实际执行成功过的命令）。
- 在报告中写明用户需要做的事：确认草稿发布内容后由用户公开；正式密钥的离线备份位置由用户保管。
