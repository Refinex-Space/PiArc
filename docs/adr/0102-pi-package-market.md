# 0102. Pi 包市场

- 状态：已接受（用户 2026-11-27 确认）
- 日期：2026-11-27
- 取代：无；修订 ADR-0058 第 2 条"插件市场在范围外"中关于 Pi 包的部分
- 相关：架构第 6.7、9.2、10.1、10.5 节；ADR-0045、ADR-0058、ADR-0082、ADR-0101；[设计增补](../architecture/addenda/pi-package-market.md)

## 背景

设置页"Skills 与插件"只能从本地目录、git 地址或 npm 包名安装扩展包，用户要先在别处找到包名。Pi 的包发布在 npm，带 `pi-package` 关键字（Pi 1.5.2 `docs/packages.md`），官方目录 pi.dev/packages 展示其中一部分，按扩展、skill、提示模板、主题分类。

2026-11-27 核对的事实：

- pi.dev 没有公开 API：`/api/packages` 答"API routes are reserved for future features"。页面是服务端渲染的 HTML。
- 已归档的官网源码（earendil-works/pi-website `src/packages.html`）直接用 npm：`registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=250&from=N` 拉列表，按关键词初判类型，再逐个读 `/<包名>/latest` 的 `pi` 清单修正，结果缓存 15 分钟。
- npm 搜索的翻页有上限：`from` 超过 5000 后静默返回第一页的内容，所以一条查询最多枚举约 5250 个包（`total` 显示 14,466）。pi.dev 当前显示 5,369 个。
- 搜索结果自带 `downloads.monthly`、`updated`、`keywords`、`publisher`、`links`、`flags.insecure`；`/latest` 带 `pi` 清单、`deprecated`、`dist.integrity`；完整 packument 带 README。
- 在 2,000 个热门包里，只靠关键词能判定类型的占 59%。

ADR-0058 把插件市场放在范围外，并让 npm 读用户的 `.npmrc`；现有 npm 安装不带 PiArc 的代理，所有包共用一个 npm 前缀，安装靠"前后两次读 `dependencies` 做差"认出包名，失败时不清理，卸载按 id 运行 `npm uninstall`。这些在一键安装面前都会变成问题。

## 决策

1. **只做 Pi 包的市场。** 数据来自 npm registry 的公开接口，不解析 pi.dev 的网页，不依赖社区索引。Claude Code 的插件市场（`enabledPlugins`、`extraKnownMarketplaces`）仍然忽略。
2. **目录由 Core 取，只连 `registry.npmjs.org`。** 请求经 `piarc-web` 新增的有界 GET：只用 HTTPS、每一跳检查主机、限制体积与时长；有生效代理（ADR-0082）时一律经 CONNECT，代理连不上就报错并显示缓存，不改走直连。打开市场视图之前不发任何请求。
3. **本地索引加实时搜索。** Core 把按热度排前的至多 5,250 个包同步进 `core.sqlite`，超过 6 小时的索引在打开市场时于后台刷新，先显示旧数据；搜索词非空且在线时另向 npm 实时查询，长尾的包也能搜到。类型先按关键词判定，再在后台按版本读 `/latest` 的清单修正；只含主题的包不显示，已弃用的包只在搜到时带标记出现。
4. **市场安装是结构化请求。** 页面只传包名、精确版本、作用域与工作区；Core 自己拼 `<包名>@<版本>`，固定使用目录的源（`registry.npmjs.org`，不读用户的 `.npmrc`），带代理变量，装完核对包名、版本、完整性值与锁文件里每个依赖的来源，不符就回滚。安装仍然只取文件、默认关闭；开启仍是唯一的执行闸门，沿用主进程原生确认。
5. **npm 安装改为每个包一个前缀，全部 npm 操作串行。** 新的 npm 安装（市场与手动）放在 `<数据目录>/pi/npm/pkgs/<键>/`，卸载删除整个前缀；已有记录保持原路径，按 npm 包名卸载。手动 npm 安装也带上 PiArc 的代理变量，但仍读用户的 `.npmrc`（ADR-0058 第 4 条不变）。
6. **卸载在"已安装"里直接可见。** 页内两步确认，文案写明对所有项目生效；独立 skill 不可删，只提供"在访达中显示"。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 解析 pi.dev 列表页的 `data-package-*` 属性 | 与官网的收录、分类、排序一致 | 依赖未承诺的页面结构，改版即失效 | 不采用 |
| 只按查询实时搜索 npm，不建索引 | 实现最少 | 做不到按下载量浏览全部、分类计数与离线浏览 | 不采用 |
| 调用 Pi 的 `pi install`/`pi remove` | 与 Pi 命令行一致 | 会运行安装脚本，绕过项目信任与原生确认，Pi 设置里的 `packages` 有意对 Pi 不可见 | 不采用 |
| 社区索引 pi-package.rectorspace.com | 现成的 JSON | 非官方，可用性与内容不受控 | 不采用 |
| 尊重用户 `.npmrc` 的镜像 | 国内镜像可能更快 | 新版本可能还没同步，无法核对来源与目录一致 | 不采用（用户 2026-11-27 选择） |

## 后果

- 正面：用户能在设置里按类别浏览、搜索、查看详情并安装 Pi 包；代理设置对目录与安装都生效；安装的结果与目录看到的一致。
- 负面与代价：多一个外连主机与一张缓存表；npm 安装布局变成两种（旧的共用前缀与新的每包前缀）；索引只覆盖按热度排前的约 5,250 个包，其余只能搜到。
- 需要配套做的事：架构第 6.7 节加"市场"一段，第 9.2 节加表，第 10.1 节 THR-03、THR-04、THR-11、THR-13 的对策与 `tests/security/threats.yaml`，第 10.5 节与 `docs/security/egress.md` 登记 `registry.npmjs.org`；S10 报告登记新 IPC。

## 重新评估的触发条件

- Pi 发布公开的目录 API。
- npm 搜索接口的翻页上限、字段或限流变化。
- 用户需要从镜像或私有源安装市场里的包。
