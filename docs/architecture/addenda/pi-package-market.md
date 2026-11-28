# Pi 包市场与卸载（M1–M8）设计增补

- 日期：2026-11-27
- 状态：已确认（2026-11-27），已实施（PLAN.md"Pi 包市场与卸载"章节，2026-11-27）
- 决策：[ADR-0102](../../adr/0102-pi-package-market.md)（变更型，修订 ADR-0058 的市场范围）
- 输入：用户需求（设置页"Skills 与插件"的卸载与市场，参考 pi.dev/packages）、用户提供的数据源调研、产品、架构、测试、安全四份评审（附录 A）
- 已与用户确认（2026-11-27）：包级卸载做显眼，独立 skill 只给"在访达中显示"；分类为全部、扩展、Skills、提示模板，不列主题；数据以 npm 为核心，不解析网页；安装、卸载、更新沿用 PiArc 的包管理；代理连不上时报错，不自动直连；市场安装固定使用目录的源

## 1. 背景与目标

PiArc 能安装 Pi 包，但用户得先在别处找到包名，再到安装表单里输入；已安装的包，卸载藏在"…"菜单里。目标：

1. 在"Skills 与插件"里按类别浏览 Pi 包，搜索、排序、查看详情，一步安装到所有项目或当前项目。
2. 已安装的包在同一页管理：开启、更新、卸载，卸载直接可见。
3. 目录加载快、断网可用；启用了代理时，目录请求与 npm 安装都走代理。
4. 安装的结果与目录看到的一致，不因为一键安装降低现有的安全基线。

## 2. 范围

### 2.1 做

| 期 | 内容 |
|---|---|
| M1 | 修现有包管理：npm 操作串行、每包一个前缀、安装失败回滚、按 npm 包名卸载、代理变量、数据目录名碰撞检查；先写能复现的失败测试 |
| M2 | `piarc-web` 拆出连接层（`connect.rs`），新增有界 GET（`get.rs`） |
| M3 | 缓存表（schema v16）与 `piarc-store` 读写 |
| M4 | Core `market` 模块：同步、分类、查询、详情、安装、事件；协议类型；NAPI |
| M5 | 主进程 IPC 与参数校验；开发构建的测试覆盖变量 |
| M6 | 设置页：已安装 / 市场两个视图、列表、详情、安装与卸载、离线与错误状态、i18n、a11y |
| M7 | 审计页显示 `plugin` 类别；独立 skill 的"在访达中显示" |
| M8 | 测试设施（假 npm registry、CONNECT 代理）、L2 与 L4、安全映射、文档与收尾 |

### 2.2 不做

主题；解析 pi.dev 网页；GitHub 的举报与风险标记；评分、作者页、多选筛选、批量安装；`pi.image`、`pi.video` 预览（CSP 不加载远程媒体）；设置关闭时的定期后台同步；安装中途取消（沿用 600 秒超时）；镜像源与私有源；自动更新。

## 3. 需求与验收

编号即验收项。数值上限统一在第 4.3 节的常量里。

### 浏览与搜索

- **M-01 打开前不联网。** 应用启动、打开设置、打开"Skills 与插件"的"已安装"视图时，假 registry 收到 0 个请求；切到"市场"后才开始。
- **M-02 缓存优先。** 索引新于 6 小时时，打开市场到列表出现，假 registry 收到 0 个请求。旧于 6 小时时，先显示旧列表，并且恰好发起一轮后台同步；同步完成后列表更新，选中的分类、搜索词与滚动位置不变。
- **M-03 首次同步。** 没有缓存时显示加载状态，第一页（250 条）写库后立即显示，其余页边同步边出现；工具行显示"正在同步 N/M"。全部完成后索引条数等于各页去重后的条数（至多 5,250）。
- **M-04 默认排序。** "热门"按 `downloads.monthly` 降序，相同时按包名升序；"最近更新"按 `updated` 降序，相同时按包名升序。两次查询结果相同。
- **M-05 分类。** 分类由纯函数决定：有清单时以清单的 `pi.extensions`、`pi.skills`、`pi.prompts`、`pi.themes` 为准，没有清单时用关键词（`extension|pi-extension|extensions` 等四组，与官网旧源码相同）。只含主题的包不出现、不计数；同时含主题的包在详情写一句"主题部分不使用"；类型判定不出的包只出现在"全部"，标"类型未标明"。一个包含多类时在每类各计一次，"全部"按去重计数。计数与夹具算出的期望值相等。
- **M-06 补全类型。** 索引中清单版本与包版本不同的条目，Core 在后台以至多 4 个并发读 `/latest`，结果按 `包名@版本` 缓存；补全过程中计数随之更新（`core/market` 事件），工具行显示"正在识别类型 N/M"。
- **M-07 搜索。** 搜索词非空且在线时，Core 向 npm 实时查询 `keywords:pi-package <词>`，结果并入索引后按当前分类与排序返回；离线时在索引里按包名、描述、关键词、发布者匹配（大小写不敏感，先 NFC 规范化）。输入防抖 250 ms；后发的查询结果不会被先发的覆盖。精确输入包名时，已弃用的包也出现，并带"已弃用"标记。
- **M-08 离线与错误。** registry 连不上而有缓存时，列表照常显示，工具行写"离线 · 显示 N 小时前的列表"并有"重试"；没有缓存时显示一句原因、"重试"与"代理设置"入口，点一次"重试"恰好发 1 个请求。代理连不上时原因写明"代理连不上"。
- **M-09 风险标记。** `flags.insecure` 的包在行与详情显示警告；已弃用的包默认不在浏览中出现。页面不显示"官方"或"已验证"之类的标记。

### 详情

- **M-10 详情内容。** 名称、描述、版本、发布者、许可证、更新时间、月下载量、资源类型（来自清单）、关键词、npm 与仓库链接、README。缺失的字段显示"—"。链接只放行 `https`，点击经主进程原生确认。
- **M-11 README。** 只经 `MarkdownView` 渲染；原始 HTML 当文本，远程图片显示为带主机名的卡片；超过 256 KiB 截断并写明，packument 超过 8 MiB 时显示"README 过大"与 npm 链接。名称、作者、描述中的双向控制字符显示为 `[U+XXXX]`。
- **M-12 导航。** 详情在设置栏内原地展开，顶部"← 市场"；返回后分类、搜索词、滚动位置不变。地址为 `#/settings/skills?view=market&package=<包名>`，前进后退与直接打开都能定位。

### 安装、开启、更新、卸载

- **M-13 安装请求。** IPC `marketInstall` 只收 `{name, version, scope, workspace?}`：包名符合 npm 规则（≤214 字符，可带 `@scope/`，小写，URL 安全，不以 `.`、`_` 开头），版本是精确 semver（不收范围、tag、URL、路径、别名）。主进程与 Core 各校验一次，Core 还要求该版本出现在它取到的 packument 里。
- **M-14 安装过程。** Core 拼 `<包名>@<版本>`，在新前缀里以内置 npm 安装，参数含 `--ignore-scripts`、`--save-exact`，环境含 `npm_config_registry=https://registry.npmjs.org/`、空的 `npm_config_userconfig`、代理变量（有生效代理时）。npm 操作串行；同一包已在安装时，第二次请求答"进行中"，不启动第二个 npm 进程。
- **M-15 安装核对。** 装完核对：装下的 `package.json` 的 `name`、`version` 等于请求值；类型是 Pi 包；登记的 id 等于 npm 包名；锁文件里该包的 `integrity` 等于 packument 的 `dist.integrity`；锁文件里每个新增条目的 `resolved` 都是目录 registry 主机上的 https tarball 且带 `integrity`。任一项不符就回滚：删除前缀目录、不留记录与声明，页面显示原因，可以重新安装。
- **M-16 安装结果。** 成功后包处于关闭状态，"已安装"出现该包，市场的按钮变为"已安装"；离开设置再回来，进行中的安装仍显示进行中，完成后显示结果；进行中时其他包的按钮可用并显示排队。
- **M-17 作用域。** 主按钮"安装"装到所有项目；旁边菜单"仅此项目"只在当前项目受信任时可选，否则不可选并写明原因与"信任此项目"入口。包已在别处安装、当前项目没有声明时，按钮为"添加到此项目"，点击走现有的开启流程（原生确认），不运行 npm。
- **M-18 开启。** 安装后行内出现开关；开启时主进程原生确认，正文列出 npm 包名与 id（不同时都写并标警告）、类型、精确版本、完整性值、registry 主机、声明了但未运行的安装脚本、不支持的部分、作用域，以及每个可执行项与"扩展在 Agent Host 内运行"的说明。取消则不开启。
- **M-19 更新。** 目录里的版本高于已安装版本时，"已安装"行与市场行显示"更新到 x.y.z"；点击后按 M-14、M-15 安装新版本，记录的版本变为新版本，新增的可执行项待确认。
- **M-20 卸载。** "已安装"行与详情都有可见的"卸载"，页内两步确认，文案写明"从这台电脑卸载，所有项目都会停用"。卸载后：记录、前缀目录（旧布局时为 `node_modules/<npm 包名>`）、插件数据目录、用户层与当前项目的声明都不存在；其他项目的声明保留，那些项目显示"缺失"并带"从市场安装"；有一行审计；运行中的 Agent Host 收到 `resources/reload`；市场按钮变回"安装"，不需要刷新。
- **M-21 独立 skill。** 不属于任何包的 skill 行提供"在访达中显示"（Windows 为"在资源管理器中显示"），不提供删除。
- **M-22 审计。** 插件审计行写明 `origin`（`market` 或 `manual`）、包名、版本、完整性值、registry 主机、作用域与工作区；卸载行写删除的路径与清掉的声明；npm 的错误输出入库前去掉 URL 里的用户信息与 token。权限页审计的类别能筛出"插件"。

### 网络与稳定性

- **M-23 主机与代理。** 目录请求只连 `registry.npmjs.org`（发布构建），每一跳重定向都在允许列表内；有生效代理时每个请求都在代理上表现为 `CONNECT registry.npmjs.org:443`，直连次数为 0；代理连不上或答 407 时报 `proxy`，直连次数为 0。自动模式下系统代理变了，下一次请求就用新代理。
- **M-24 上限。** 体积、时长、并发、重试都有上限且由常量决定（第 4.3 节）；超出体积报 `tooLarge`，卡住报 `timeout`，只对网络错误、5xx、429 重试并遵守 `Retry-After`（不超过 30 秒），4xx 不重试。
- **M-25 坏数据。** 搜索页、清单、packument 的畸形 JSON、缺字段、类型错误、超长字段：合法条目照常入库，非法条目逐条跳过；Core 去掉控制字符并截断（描述 1 KiB，关键词至多 32 个、每个 64 字符）；缓存行损坏时丢弃并重新取。

### 呈现

- **M-26 视觉与可访问性。** 页面按[视觉规范](../../engineering/visual-design.md)：无描边卡片，行与行之间是细线，每项至多一句说明；亮色、暗色、紧凑密度都核对悬停、选中、禁用与焦点；中英文没有溢出。市场列表、详情、离线、错误、空状态、卸载确认都登记到 `apps/desktop/e2e/a11y/states.ts` 并通过 axe。

## 4. 设计

### 4.1 页面

"Skills 与插件"页头下方是 `SegmentedControl`："已安装 | 市场"（`?view=installed|market`）。

**已安装**：
1. 扩展包：每行是名称（等宽）、类型标记、来源、状态（已开启 / 已关闭 / 未加载）、一行描述；右侧是开关、"卸载"（幽灵按钮，危险色文字）与"…"（更新、在访达中显示、查看来源）。点开的细节（组件、来源、提交与版本、不支持的部分）收在行内折叠区。末尾是"+ 从文件夹、git 或 npm 安装"。
2. Skills：沿用现有的可折叠行；属于某个包的 skill 标出包名；独立 skill 的"…"里有"在访达中显示"。
3. 输出风格。

**市场**：
1. 第一行：全宽搜索框。
2. 第二行：左边分类 `SegmentedControl`（全部 / 扩展 / Skills / 提示模板，带计数），右边排序（热门 / 最近更新）与"刷新"图标按钮。
3. 工具行：一句状态（"N 分钟前更新"、"正在同步 N/M"、"离线 · 显示 N 小时前的列表"）。
4. 列表：每行左边是名称（等宽）、一行截断的描述、元信息（发布者 · 月下载量 · 更新时间 · 类型标记 · 风险标记）；右边是一个按钮：安装（带"仅此项目"菜单）/ 已安装 / 添加到此项目 / 更新到 x.y.z / 安装中。每次 50 行，"显示更多"。
5. 详情：原地展开，见 M-10 到 M-12。头部是名称、描述、主按钮与作用域；下面是元信息表、资源类型、警告、链接、README。

文件：`apps/desktop/src/renderer/settings/market/`（`MarketView.tsx`、`MarketList.tsx`、`MarketDetail.tsx`、`market-parse.ts` 与测试、`market-state.ts`），`SkillsPage.tsx` 与 `PluginsSection.tsx` 改为"已安装"视图的组成部分。

### 4.2 Core 与数据

**`piarc-web`**：
- `connect.rs`（`pub(crate)`）：从 `download.rs` 原样移出 `open`、`direct`、`tunnel`、`target`、`Stream`；`download.rs` 改为调用它，行为不变。
- `get.rs`：`Getter::get(&GetJob { url, allows_host, proxy, max_bytes, extra_roots? }, &CancellationToken) -> Result<Bytes, GetError>`。只用 HTTPS，重定向至多 5 次且每跳经 `allows_host`，`Accept-Encoding: identity`，单次读卡住 30 秒、总时长 60 秒；错误码沿用 `DownloadError::code()` 的名称并加 `tooLarge`、`status`。测试构造可注入根证书与解析器；发布构建没有这条路径。

**`piarc-store`**：迁移 `0016_market.sql`（STRICT）：
- `market_packages(name PK, version, description, keywords JSON, publisher, maintainers JSON, license, updated_ms, downloads_monthly, downloads_weekly, npm_url, repo_url, homepage_url, insecure, kw_kinds, manifest_kinds, manifest_version, manifest_at_ms, deprecated, theme_only, sync_gen, from_index)`；
- `market_sync(id=1, gen, state, done, total, started_ms, finished_ms, last_error)`。
- 查询：分类、搜索（`LIKE`，14k 行内足够）、排序、`LIMIT/OFFSET`；"已安装"状态由 Core 关联 `packages` 表（按 npm 包名）给出。

**`piarc-core::market`**（`mod.rs`、`npm.rs` 解析与分类、`sync.rs`、`install.rs`），Hub 方法在 `sessions/market.rs`：
- 同步：顺序拉 21 页（每页 250），每页写库并发事件；整轮成功才删除旧代的行，失败保留旧数据与 `last_error`。同一时刻只有一个同步任务。
- 类型补全：见 M-06；清单读取失败的条目保持原样，下次补全再试。
- 详情：读 packument（8 MiB 上限），取 `readme`（截到 256 KiB）、`versions[version].dist.integrity`、`deprecated`；内存 LRU 32 条，不落库。
- 安装：校验 → npm 互斥锁 → 新前缀 `<数据目录>/pi/npm/pkgs/<键>/`（键为包名的 `@`、`/` 换成 `+` 后的小写形式，加 8 位哈希避免碰撞）→ npm → 核对（M-15）→ 交给 `PluginManager::register`（id 必须等于 npm 包名）→ 写声明（关闭）→ 审计 → `resources/reload`。失败任一步都回滚。记录的 `location` 只存包名，`path` 是前缀下的包目录。
- 事件：路由 `core/market`：`{type: "sync", state, done, total}`、`{type: "kinds", names}`、`{type: "install", name, state, error?}`。

**`PluginManager` 的修改**（`crates/piarc-core/src/plugins/`）：
- Hub 持有一把 npm 互斥锁，安装、更新、卸载从开始一直持锁到登记结束。
- 手动 npm 安装也用每包前缀；`installed_name` 不再靠差集。
- 环境加 `network::env_for(proxy.effective(..))` 的变量，以及 `npm_config_https_proxy`、`npm_config_proxy`、`npm_config_noproxy`（npm 的配置优先于 `HTTPS_PROXY`，但低于用户 `.npmrc`，手动安装照旧）。
- 注册失败时回滚 npm 安装；卸载按记录路径推出 npm 包名（旧布局）或删除前缀（新布局），删除前做路径包含检查（只允许 `<pi>/npm/` 与 `<pi>/git/` 之下）。
- 数据目录名碰撞（`a.b` 与 `a-b`）时拒绝安装并写明原因。

**协议与 NAPI**：`piarc-protocol/src/market.rs`（`MarketQuery`、`MarketPage`、`MarketEntry`、`MarketDetail`、`MarketInstallRequest`、事件），`npm run gen:protocol`；NAPI `marketQuery`、`marketDetail`、`marketRefresh`、`marketInstall`，`npm run build:core -- --flavor all`。

**主进程**：`apps/desktop/src/main/core/market-ipc.ts`：`query` ≤200 字符且无控制字符，`category`、`sort` 为枚举，`offset` 0–20000，`limit` 1–100，`name`、`version` 按 M-13，`scope`、`workspace` 沿用 `plugins-ipc.ts` 的函数。`shared/ipc.ts`、`preload.ts`、`e2e/preload.e2e.ts` 键快照、S10 报告同步。`confirmationText` 按 M-18 补充内容。

**开发构建覆盖变量**（`crates/piarc-napi/src/testing.rs` 的 `createForTests`）：`PIARC_TEST_MARKET_REGISTRY`（目录与 npm 的 registry 基础地址，没设时为 `https://registry.invalid`）、`PIARC_TEST_MARKET_HOSTS`（`名称=端口`，只把这些名称解析到回环）、`PIARC_TEST_MARKET_CA`（PEM，Core 信任它并作为 `NODE_EXTRA_CA_CERTS` 交给 npm）。发布构建没有这些路径，`check-app-layout.mjs --flavor release` 核对。

### 4.3 常量（`piarc_core::market::MarketLimits`）

| 项 | 值 |
|---|---|
| 索引页大小与页数 | 250 × 至多 21（`from` ≤ 5000） |
| 索引过期 | 6 小时 |
| 搜索页、`/latest`、packument 体积上限 | 4 MiB、1 MiB、8 MiB |
| README 截断 | 256 KiB |
| 单次读卡住、单次请求总时长 | 30 秒、60 秒 |
| 清单补全并发 | 4 |
| 重试 | 至多 2 次（网络错误、5xx、429），间隔 1 秒、3 秒，`Retry-After` 不超过 30 秒 |
| 页面每页条数 | 50 |
| 详情 LRU | 32 |

### 4.4 兼容

- 已有的 npm 安装记录保持在共用前缀，更新时迁到新前缀（核对通过后删除旧条目）。
- 旧客户端没有 `market_*` 表也能运行；迁移只新增表。
- ADR-0058 的手动安装、git、目录来源行为不变，只多了代理变量与串行化。

## 5. 测试计划

**测试设施**（`crates/piarc-testkit`）：
- `piarc-mock-npm`：HTTPS（测试 CA，SAN 含 `registry.npmjs.test` 与 `127.0.0.1`），路由 `/-/v1/search`、`/<包名>/latest`、`/<包名>`（含 `@scope%2f名`）、tarball；启动时生成 tarball 并算 sha512；严格模式（未知路径 404 并记违规）；stdin 控制 `offline`、`online`、`hold <路径>`、`status <路径> <码>`；请求日志按行写 JSON。
- `piarc-mock-proxy`：把 `crates/piarc-web/tests/download.rs` 的 CONNECT 代理移入 testkit，记录每个 CONNECT 目标，可切换 200、407、拒绝连接。
- npm 隔离：测试设 `npm_config_cache` 为临时目录、`npm_config_fetch_retries=0`。

**Rust 单元**：搜索页、清单、packument 的解析（正常、缺字段、畸形、超限、BOM）；分类表；计数与排序；包名与版本校验、URL 编码；缓存过期与同步代次（`ManualClock`）；重试与退避；有界 GET 的直连检查、CONNECT、407、跨主机重定向、超限、卡住；`npm_env`；npm 互斥锁；数据目录碰撞。

**Rust 集成**（`crates/piarc-testkit/tests/market.rs`，真实内置 npm + 假 registry）：冷同步每页 1 次；新鲜缓存 0 请求；过期后台刷新 1 次；离线有缓存与无缓存；安装 `name@1.2.0` 后版本、完整性、没有运行 `postinstall`；经代理安装只有 `CONNECT registry.npmjs.test` 且用户 `.npmrc` 的代理未被使用；代理 407 或连不上时两者都失败且直连为 0；同名安装去重；两个包并发安装都成功；tarball 500 无残留；依赖指向非 registry 来源时回滚；卸载带 scope 的包；`thr03_*` 系列（名称、版本、类型、完整性不符时拒绝；git 依赖的 `prepare` 不运行；安装一个包不改动另一个包）。

**主进程与渲染进程单元**：IPC 畸形参数逐项被拒；市场安装不接受 `location`；确认正文含包名与 id、类型、registry 主机；Core 答复解析丢弃坏项；搜索防抖与竞态；分类计数文案（中文 `=1`）；按钮状态机；离线横幅的本地化时间；卸载后标记同步。

**L4**（`apps/desktop/e2e/market-*.e2e.ts`，开发打包构建，覆盖变量指向 mock）：浏览分类与计数；搜索；详情与链接确认；安装到所有项目与此项目（含未受信任项目）；开启时原生确认的取消与确认；更新；从行与详情卸载；离线横幅与重试；代理开启与代理连不上；XSS 载荷并入 `t45-xss`；新命令并入 `t45-ipc-hardening`；`t45-egress` 保持不打开市场、`crates/piarc-testkit/tests/egress.rs` 加"市场只连 mock"；a11y 与中英文溢出；截图在 `tmp/evidence/market/`。受影响的现有用例：t40、t37 的 Skills 部分、preload 快照、proxy-settings。

## 6. 风险与待确认

| 风险 | 处理 |
|---|---|
| npm 搜索接口的翻页上限、字段或限流变化 | 解析容错、同步失败保留旧数据；ADR-0102 的重新评估条件 |
| 索引只覆盖热门前约 5,250 个包 | 搜索实时查询 npm 覆盖长尾；工具行不承诺"全部" |
| 类型补全约 2,000 次 `/latest` 请求（首轮） | 按版本缓存、并发 4、只在市场打开过后进行；之后只补新版本 |
| 共用前缀里的旧安装仍可能互相影响依赖 | 更新时迁到每包前缀；新安装不再共用 |
| 其他项目保留的声明在重装后重新生效 | 市场安装的 id 等于 npm 包名，同名即同一个 npm 包；可执行项仍要重新确认 |
| 镜像源用户的安装速度 | 走用户配置的代理；镜像不支持（用户已选择） |
| 安装不能中途取消 | 沿用 600 秒超时；按钮显示进行中与排队 |

## 7. 实施步骤

每步完成后提交并更新 `PLAN.md` 的计划外章节检查点。

1. **M1 现有包管理的修复。** 先写失败测试（共用前缀下并发安装认错包、注册失败残留、带 `plugin.json` 的包卸载删错、数据目录碰撞），再实现互斥锁、每包前缀、回滚、按路径卸载、代理变量。验证：`cargo test -p piarc-core --lib plugins::`、`cargo clippy -p piarc-core --all-targets -- -D warnings`。
2. **M2 有界 GET。** 拆 `connect.rs`，加 `get.rs`。验证：`cargo test -p piarc-web`（`download`、`get` 两套）。
3. **M3 缓存表。** 迁移 v16 与读写。验证：`cargo test -p piarc-store`。
4. **M8 前半：测试设施。** `piarc-mock-npm`、`piarc-mock-proxy`、证书。验证：`cargo test -p piarc-testkit --lib`。
5. **M4 Core 市场模块、协议与 NAPI。** 验证：`cargo test -p piarc-core --lib market::`、`cargo test -p piarc-testkit --test market`、`npm run gen:protocol`、`npm run build:core -- --flavor all`。
6. **M5 主进程 IPC。** 验证：`npx vitest run apps/desktop/src/main/core`、`npx tsc --build`、`npm run lint`。
7. **M6 页面。** 验证：`npx vitest run apps/desktop/src/renderer/settings`、`node scripts/ci/check-i18n.mjs`、`npm run package:desktop -- --flavor development` 后跑 `PIARC_EVIDENCE_TASK=market npx playwright test -c apps/desktop/playwright.config.ts market- t40- t37- --project dev`，并截图核对亮暗、紧凑、中英文。
8. **M7 审计与"在访达中显示"。** 验证：`PIARC_EVIDENCE_TASK=market npx playwright test -c apps/desktop/playwright.config.ts t23-permissions --project dev`。
9. **M8 后半：安全与文档。** `tests/security/threats.yaml`、架构第 6.7、9.2、10.1、10.5 节（版本号与修订记录）、`docs/security/egress.md`、S10、AGENTS.md。验证：`node scripts/ci/check-threats.mjs`、`PIARC_EVIDENCE_TASK=market npx playwright test -c apps/desktop/playwright.config.ts t45- t43- --project dev`。
10. **收尾。** 提交后 `npm run verify`，派 `dev-flow:spec-reviewer` 对照本文第 3 节复核。

## 附录 A：裁决表

| # | 意见 | 来源 | 决定 | 理由 |
|---|---|---|---|---|
| 1 | ADR-0058 把市场列在范围外，需写变更型 ADR | 架构 | 采纳 | 改基线，ADR-0102 提议 |
| 2 | npm 搜索翻页有上限，需核实 | 产品 | 采纳并已核实 | `from` > 5000 返回第一页，索引至多 5,250，搜索实时查询补长尾 |
| 3 | 只靠关键词分类不全，约 41% 无法判定 | 产品、测试 | 采纳 | 后台按版本补全清单（M-06）；判定不出的只在"全部" |
| 4 | 按精确版本记录 `location` 会让更新失效 | 产品、架构 | 采纳 | `location` 只存包名，安装时用精确版本 |
| 5 | 跨项目重复安装被拒 | 产品 | 采纳 | "添加到此项目"走开启流程，不跑 npm |
| 6 | 卸载影响所有项目，其他项目的声明残留 | 产品、安全 | 部分采纳 | 文案写明；不改别的项目的仓库文件；"缺失"行给"从市场安装" |
| 7 | npm 操作并发不安全，安装靠差集认包名 | 架构、测试 | 采纳 | npm 互斥锁、每包前缀 |
| 8 | 安装失败不回滚、卸载按 id 删错 | 架构、安全、测试 | 采纳 | M1 先写失败测试再修 |
| 9 | npm 不带 PiArc 代理，`.npmrc` 会覆盖 | 架构、安全、测试 | 采纳 | 市场安装固定源与空 userconfig；手动安装加代理变量 |
| 10 | 代理失败的语义 | 测试、架构 | 用户决定：报错，不直连 | 2026-11-27 |
| 11 | 市场安装的源 | 测试、安全 | 用户决定：固定目录的源 | 2026-11-27 |
| 12 | 需要结构化安装请求与装后核对 | 安全 | 采纳 | M-13、M-15 |
| 13 | 每包独立前缀 | 安全（should） | 采纳 | 同时解决并发、认包名、卸载与依赖互相影响 |
| 14 | 安装本身要原生确认 | 安全 | 不采纳 | 结构化安装不运行代码、只连固定源、装后核对；开启仍原生确认 |
| 15 | 原生确认正文补充包名与 id、类型、registry 主机等 | 安全 | 采纳 | M-18 |
| 16 | 项目作用域安装要求受信任 | 产品、安全 | 采纳 | M-17 |
| 17 | 第三方元数据的 XSS 与双向控制字符 | 安全、测试 | 采纳 | M-11、M-25，并入 THR-11 |
| 18 | 远程图片、`pi.image`/`pi.video` 不取 | 安全、产品 | 采纳 | CSP 不放宽 |
| 19 | 打开市场前不联网；测试覆盖变量默认指向 `.invalid` | 测试 | 采纳 | M-01，出网测试 |
| 20 | 去掉 `api.npmjs.org` | 产品、架构 | 采纳 | 搜索结果已带下载量 |
| 21 | 审计页显示 `plugin` 类 | 产品、安全 | 采纳 | M-22；卸载需要可追溯 |
| 22 | 审计不顺手改 | 架构 | 不采纳 | 卸载与市场安装的可追溯属于本需求 |
| 23 | `flags.insecure` 默认隐藏 | 架构 | 不采纳 | 与产品意见冲突，选产品：显示警告；安装不运行代码 |
| 24 | 安装进行中状态放在 Core，可离开页面 | 产品 | 采纳 | `core/market` 的 install 事件 |
| 25 | 安装中途取消 | 产品 | 不采纳 | 不在验收必需项；沿用超时 |
| 26 | SQLite FTS5、README 落库、24 小时 README 缓存 | 用户调研 | 不采纳 | 14k 行内 `LIKE` 足够；README 内存 LRU |
| 27 | 索引过期 30 分钟 | 用户调研 | 部分采纳 | 改为 6 小时，打开时后台刷新；手动刷新随时可用 |
| 28 | 按名称排序 | 产品 | 不采纳 | 用处小 |
| 29 | 仿冒包名的编辑距离提示 | 安全（should） | 不采纳 | 本期不做，记入风险后续评估 |
| 30 | 市场作为页内视图而非单独页或对话框 | 产品、架构 | 采纳 | 已安装与市场状态需对得上 |
| 31 | 性能预算（5k 条缓存渲染耗时） | 测试 | 部分采纳 | 分页 50 条渲染；不新增第 11 章指标 |
