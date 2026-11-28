# 0111. 应用内更新：GitHub Releases 作为更新源，Core 经用户代理下载并校验，macOS 自行替换应用包

- 状态：已接受（2026-11-28 维护者在会话中选择"应用内下载并替换"）
- 日期：2026-11-28
- 修订：[ADR-0018](0018-unsigned-distribution.md) 第 2 条的"更新"一项（第一版不做应用内自动替换）
- 补充：[ADR-0024](0024-release-manifest-format.md)（清单格式不变，新增一个列在清单里的更新说明文件）
- 相关：ADR-0082（代理）、ADR-0097（`piarc_web::download`）；架构第 10.1 节（THR-09）、第 13 章；[关于与更新设计增补](../architecture/addenda/about-and-updates.md)；[发布规范](../engineering/release.md)

## 背景

ADR-0018 决定 macOS 只做 ad-hoc 签名，因此用不了 Electron 内置更新器（Squirrel.Mac 要求 Developer ID 签名），第一版的更新只是"检测到新版本后打开下载页"。Windows 用 Velopack，按用户安装、能应用内更新，但还没有接上检测与下载。2026-11-28 维护者要求两个平台都在应用内完成"检测 → 下载 → 重启安装"，并且下载优先走用户代理。

事实（2026-11-28）：

- Core 已有经用户代理（ADR-0082 的生效代理，`CONNECT`，代理不可达时不直连）的小文件 GET（`piarc_web::get`）和大文件下载（`piarc_web::download`：每一跳检查主机、续传、大小与 SHA-256 校验，ADR-0097），也有清单验签与文件校验（`piarc_core::release`，ADR-0024）。
- GitHub 的 `https://github.com/<owner>/<repo>/releases/latest/download/<文件名>` 重定向到最新正式版（不含草稿和预发布）的同名产物，下载最终落在 `release-assets.githubusercontent.com`（旧称 `objects.githubusercontent.com`）。不走 REST API，没有每小时 60 次的未认证限额。
- Velopack 1.2.161 的 Node 绑定 `UpdateManager` 接受本地目录作为更新源（`FileSource`），读其中的 `releases.<channel>.json`，下载（复制）时核对其中的 SHA-256，`waitExitThenApplyUpdate` 在应用退出后替换并重启。它自己的 HTTP 下载不读 PiArc 的代理设置。
- 由 PiArc 进程（而非浏览器）写出的文件不带 `com.apple.quarantine`，`ditto -x -k` 解出的应用包保留 ad-hoc 签名与符号链接。ad-hoc 签名的代码身份每版都变，更新后钥匙串会再要一次授权，ADR-0018 第 5 条已接受这个代价。

## 决策

1. **更新源与产物命名。** 唯一更新源是 GitHub Releases 的最新正式版。一个版本的产物平铺在同一个 Release 里，文件名是对外契约：

   | 文件 | 用途 |
   |---|---|
   | `piarc-release-manifest.json`、`.minisig` | ADR-0024 的签名清单，列出下面全部文件 |
   | `piarc-release-notes.json` | 更新说明（第 2 条），列在清单里 |
   | `PiArc-<版本>-macos-<arm64\|x64>.zip` | macOS 应用内更新 |
   | `PiArc-<版本>-macos-<arm64\|x64>.dmg` | macOS 手动安装 |
   | `PiArc-<版本>-windows-<x64\|arm64>-Setup.exe` | Windows 首次安装（Velopack 的 Setup，改名） |
   | `releases.win-<x64\|arm64>.json` 与其中 Full 条目的 `.nupkg` | Windows 应用内更新（vpk 的原始文件名） |

   发布流水线负责改名与核对（`docs/engineering/release.md`）。应用只认这些名字，不猜测其他命名。
2. **更新说明。** `piarc-release-notes.json`：`{ "format": "piarc-release-notes/1", "version", "date"（YYYY-MM-DD）, "security"（布尔，ADR-0018 第 8 条的"安全更新"）, "notes": { "en": Markdown, "zh-CN": Markdown } }`，由两份 CHANGELOG 的同一版本一节生成。它列在签名清单里，Core 下载后先核对大小与 SHA-256 再解析，`version` 与清单不一致即拒绝。说明文字按界面语言取，缺了用 `en`；渲染进程经 `MarkdownView` 显示，链接照常经主进程确认。
3. **检测。** Core 新增 `piarc_core::updates`：
   - 取 `latest/download/` 下的清单与签名（每个至多 64 KiB），用内置公钥验签（`BUILTIN_RELEASE_KEYS`，为空时状态为"不可用"，不发请求），`product` 必须是 `PiArc`，版本按 SemVer 比较，只有更高的正式版才算新版本，接着取更新说明；
   - 所有请求经生效代理（与市场、语音模型相同，代理不可达时报 `proxy`，不直连；本机地址照 ADR-0082 的 `NO_PROXY` 直连，只影响开发构建的本地测试源），每一跳主机只能是 `github.com`、`release-assets.githubusercontent.com`、`objects.githubusercontent.com`；
   - 主进程在启动 30 秒后检测一次，之后每 24 小时一次（用户级偏好 `updates.autoCheck`，缺省为开）；手动检测不受开关影响。开发构建只连 `PIARC_TEST_UPDATE_FEED`（缺省是一个解析不到的地址），与市场的测试开关同一做法，`t45-egress` 不受影响。
4. **下载。** 只在用户点"下载更新"后进行，单飞、可取消、可续传，进度在路由 `core/updates` 广播（与状态快照同一事件）。下载到 `<缓存目录>/updates/<版本>/`，每个文件按清单核对大小与 SHA-256；Windows 先下 `releases.win-<arch>.json`、核对后解析出目标版本的 Full 包名，该包也必须在清单里。启动时与每次检测时删除不高于当前版本的旧目录。
5. **macOS 安装。** 主进程在用户点"重启以更新"时：
   - 先确认可以替换：应用包不在 App Translocation 的随机路径下，所在目录可写；不满足时不替换，改为在访达中显示已校验的 DMG 所在位置并说明原因（"请把 PiArc 移到'应用程序'文件夹"）；
   - 用 `ditto -x -k` 解压到同一卷上的暂存目录，核对解出的 `Info.plist` 的 `CFBundleIdentifier` 是应用标识、`CFBundleShortVersionString` 是目标版本，任一失败即报错并保留当前版本；
   - 写出并以分离进程启动一个 `/bin/sh` 辅助脚本（参数逐个传入，不经字符串拼接），然后退出应用。脚本等主进程退出（至多 60 秒），把旧包改名为同目录下的备份，把新包移入原路径，失败就把备份移回；成功后启动新版本并删除备份与暂存。脚本的输出写在暂存目录的日志里。
6. **Windows 安装。** 主进程以第 4 条的目录作为 `FileSource` 建 `UpdateManager`，`checkForUpdatesAsync` 得到的版本必须与 Core 下载的一致，`downloadUpdateAsync` 从本地目录复制并由 Velopack 再核对一次 SHA-256，然后 `waitExitThenApplyUpdate(…, restart: true)` 并退出。不是 Velopack 安装的副本（L4 的打包形态、复制出来的目录）不提供应用内安装，改为打开 Release 页面。
7. **退出。** 安装前沿用退出确认（有运行中的会话或后台任务时原生确认，`platform/quit.ts`），用户取消就不安装，已下载的更新保留到下次。
8. **界面。** 设置"支持"组新增"关于"页（版本、组件版本、更新状态与说明、自动检测开关、链接），应用菜单的"关于 PiArc"与新增的"检查更新…"都打开这一页，不再使用 Electron 的原生关于面板；有新版本或已可安装时，侧栏底部显示一个不打断的提示。细节见设计增补。
9. **威胁映射。** THR-09（更新通道被劫持）新增对策：Core 只认验签通过的清单，所有产物核对大小与 SHA-256 后才交给安装步骤；macOS 安装前核对解出的应用标识与版本；Windows 的 `releases.*.json` 本身在签名清单里。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| macOS 只打开下载页（ADR-0018 原方案） | 不替换运行中的程序 | 用户长期停留在旧版本，安全修复到达慢 | 维护者否决 |
| macOS 下载 DMG、打开后让用户拖拽 | 改动小 | 多一步手动操作，要处理已挂载的卷 | 不采用；替换失败时作为退路（第 5 条） |
| Velopack 直连 `GithubSource` | 少一段代码 | 不走用户代理；Velopack 元数据不签名，绕过清单 | 否决 |
| 用 GitHub REST API 取最新版本与说明 | 能拿到 Release 正文 | 未认证 60 次/小时；正文不受签名保护 | 否决 |
| 检测与下载放在主进程（Electron `net`） | `net` 自带系统代理 | 手动代理与"代理不可达不直连"要重写；校验在 Core，产物要再传一遍 | 否决：沿用 Core 的下载器与校验 |

## 后果

- 正面：两个平台的检测、下载、校验是同一份代码，一律经用户代理；安装前有两道校验（清单哈希、包内标识与版本）；更新说明受签名保护。
- 负面与代价：
  - macOS 的替换脚本要自己处理权限、原子改名与回滚；`/Applications` 不可写的账户只能手动安装；
  - 每次更新后 macOS 仍会弹一次钥匙串授权（ADR-0018 已接受）；
  - 产物命名成了契约，改名要换清单之外的兼容处理。
- 需要配套做的事：
  - 发布流水线 `.github/workflows/release.yml`、`docs/engineering/release.md`、两份 CHANGELOG；
  - 正式密钥生成后写入 `BUILTIN_RELEASE_KEYS` 与 README（首发前，由维护者完成）；
  - `docs/security/egress.md` 的"应用更新检查"一行与 `threats.yaml` 的 THR-09。

## 重新评估的触发条件

- 项目取得 Apple Developer ID 签名：改用 Electron 内置更新器；
- GitHub 改变 `releases/latest/download` 的重定向主机或行为；
- 需要增量包、分阶段发布或测试通道（届时 `piarc-release-notes/1` 与清单按 `format` 升级）。
