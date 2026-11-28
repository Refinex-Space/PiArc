# 关于页与应用内更新（设计增补）

- 日期：2026-11-28
- 状态：已实施（2026-11-28）
- 决策：[ADR-0111](../../adr/0111-in-app-updates.md)（应用内更新，修订 ADR-0018 第 2 条，已接受）
- 相关：[发布规范](../../engineering/release.md)、ADR-0024（发布清单）、ADR-0082（代理）、架构第 13.4 节（"关于"页显示的版本）

## 1. 目标

1. 用户随时能看到自己用的是哪个版本、由哪些组件构成，并能一键复制给 issue。
2. 有新版本时不打断工作：侧栏底部一行提示，点开才看说明；安全更新用警示色。
3. 检测、下载、校验、重启安装在应用内完成，两个平台的操作一致；网络一律走用户代理。
4. 任何一步出问题都说清楚原因和下一步，不留"更新失败"这种死胡同。

## 2. 入口

| 入口 | 行为 |
|---|---|
| 应用菜单"关于 PiArc"（macOS）／帮助菜单"关于 PiArc"（Windows） | 打开设置的"关于"页（`#/settings/about`），取代 Electron 的原生关于面板 |
| 应用菜单／帮助菜单"检查更新…" | 打开"关于"页并立即检查 |
| 侧栏底部的更新提示 | 有新版本、下载中：打开"关于"页；已可安装：直接"重启以更新" |
| 设置导航"支持 › 关于" | 同第一行 |

原生关于面板只能放名称、版本和一行版权，开发形态下还显示 Electron 的名字与图标；放进设置页可以和更新、版本信息、链接放在一起，视觉与设置页同一套（ADR-0101）。

## 3. "关于"页

单栏，自上而下：

1. **标题区**：应用图标（`design/brand/icon.svg` 的造型，用令牌着色：图块 `workbench.card`、字形 `text.primary`、1 px `session.line` 环）、"PiArc"、`版本 1.0.0（arm64）`（开发构建另标"开发构建"）、一句标语。
2. **软件更新**分节：
   - 状态行：名称是当前状态，说明是一行细节，右侧是唯一的动作（见第 4 节）。安全更新在名称后带警示色徽标。
   - 需要手动安装时，在状态行下多一行原因与"打开发布页面"。
   - 有新版本时，下面是更新说明（Markdown，经 `MarkdownView`，按界面语言取，缺了用英文；超过约 1,200 字符先折叠，"展开全部"），标题行右侧"在 GitHub 上查看"。
   - "自动检查更新"开关（用户级 `updates.autoCheck`，托管设置可锁定）。
3. **版本信息**分节：PiArc、Electron、Chromium、Node.js、Pi、Agent Host 协议、libghostty-vt、系统，两列细线列表，数值等宽且可选中；分节标题右侧的图标按钮复制全部版本（纯文本，一行一项）。
4. **资源**分节：发布说明、源代码、报告问题、许可证，每行末尾一个外链图标按钮（经主进程确认后在浏览器打开）；最后一行许可与版权。

## 4. 状态与动作

| Core 状态 | 名称 | 说明 | 动作 |
|---|---|---|---|
| 读取中 | 正在读取更新状态… | — | — |
| `idle` | 尚未检查更新 | — | 检查更新 |
| `checking` | 正在检查更新… | — | 检查更新（加载中） |
| `upToDate` | PiArc 已是最新版本 | 上次检查：5 分钟前 | 检查更新 |
| `available` | PiArc 1.1.0 可用 | 2026-12-01 发布 · 186 MB | 下载更新（主按钮） |
| `downloading` | 正在下载 PiArc 1.1.0 | 进度条与"42% · 78 MB / 186 MB" | 取消 |
| `ready` | PiArc 1.1.0 已可安装 | 将以新版本重启，会话会自动恢复 | 重启以更新（主按钮） |
| `failed`（检查） | 无法检查更新 | 按错误码的本地化原因，原文在提示里 | 检查更新 |
| `failed`（下载） | 更新下载失败 | 同上 | 重试（从断点续传） |
| 不可用 | 此构建不提供更新 | 没有内置公钥／没有此平台的产物 | — |

错误码到文案：`network`、`timeout`、`refused` → 连不上发布服务器；`proxy` → 检查"设置 › 代理"；`tls`；`integrity` → 未通过校验、已拒绝；`notFound` → 还没有发布任何版本；`disk`、`diskFull`；其余 → 稍后重试。

"重启以更新"先走退出确认（有运行中的会话或后台任务时原生确认），用户取消则什么都不变。不能原地替换时（macOS 在 App Translocation 路径或目录不可写、Windows 非安装版、源码树运行）显示手动安装的原因。

## 5. 侧栏提示

`available`、`downloading`、`ready` 时，在侧栏底部身份行之上显示一行：强调色浅底、圆点加文字（"PiArc 1.1.0 可用"、"正在下载 1.1.0 · 42%"、"重启以更新到 1.1.0"）；安全更新用警示色浅底与"安全更新 1.1.0"。下载中圆点呼吸（减少动效时静止）。不弹窗、不发系统通知、不打断输入。

## 6. 数据流

```
主进程定时器（启动 30 s 后、此后每小时看一次是否满 24 h，且 updates.autoCheck）
   │ 或 页面"检查更新" / 菜单"检查更新…"
   ▼
Core updates.check(生效代理) ──GET──► github.com/…/releases/latest/download/piarc-release-manifest.json(.minisig)
   │ 验签 → 比版本 → 取 piarc-release-notes.json（核对哈希）→ Windows 另取 releases.win-<arch>.json
   ▼
core/updates（UpdateStatus 快照） ──► 每个窗口的 update-store ──► 关于页 / 侧栏提示
   │ 页面"下载更新"
   ▼
Core updates.download ──► <缓存>/updates/<版本>/（续传、每个文件核对大小与 SHA-256，进度至多 200 ms 一次）
   │ 页面"重启以更新"
   ▼
Core install_plan（再次校验）──► 主进程：退出确认 ──► macOS：ditto 解压到同卷暂存、核对 Info.plist、分离的替换脚本
                                                └─► Windows：Velopack FileSource（本地目录）、waitExitThenApplyUpdate
```

## 7. 测试

- Core：`cargo test -p piarc-core --lib updates`（版本比较、产物选择、说明与 Velopack 源解析）、`cargo test -p piarc-testkit --test updates`（经 mock 的 GitHub 下载：两个平台、已是最新、篡改与换密钥、外来说明、代理 CONNECT 与代理不可达不直连、离线与未发布）。
- 主进程：`npx vitest run apps/desktop/src/main/core/updates-ipc.test.ts apps/desktop/src/main/platform/mac-update.test.ts apps/desktop/src/main/platform/windows-update.test.ts`（安装编排、调度、Info.plist 核对；替换脚本在真实 shell 上的替换与回滚）。
- 渲染进程：`npx vitest run apps/desktop/src/renderer/updates apps/desktop/src/renderer/settings/AboutPage.test.tsx`。
- L4：`PIARC_EVIDENCE_TASK=about npx playwright test -c apps/desktop/playwright.config.ts about-updates --project dev`；无障碍旅程 `t43-a11y` 含 `settings:about`。
- 真实安装（替换 `/Applications/PiArc.app`、Velopack 应用更新）只在发布前按发布规范第 5 节手动验证，L4 的打包形态不运行它。
