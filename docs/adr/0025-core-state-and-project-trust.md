# 0025. Core 状态的落地：数据目录、SQLite 迁移、按主 checkout 的信任与 Pi 信任接管（补充 ADR-0011、ADR-0005 第 4 条）

- 状态：已接受（补充）
- 日期：2026-11-16
- 取代：无
- 相关：[ADR-0011](0011-session-storage.md)、[ADR-0005](0005-claude-code-config-compatibility.md) 第 4、5 条；架构文档第 5.5、9.1、9.2、10.2 节

## 背景

M1 开始需要 Core 的持久状态。架构写了目录位置、表的概要与"信任按仓库主 checkout 解析、由 Harness Kit 接管 Pi 的 `project_trust`"，没有规定下面几件发布后难以回退的事：

- Electron 的 Chromium 数据放在哪里。第 9.1 节把"Chromium 缓存"列在可丢弃的缓存目录；Electron 45.3.2 的 `app.setPath` 可以设 `sessionData`（Cookie、HTTP 缓存、`localStorage` 都在其中），也只能在 `ready` 之前设。
- 数据库的版本怎么演进。数据库一旦在用户机器上建立，迁移的写法就成了契约。
- 信任决定的键与撤销的语义，以及 Pi 1.5.2 中"接管"的实际挂点。事实（Pi 1.5.2 源码）：`project_trust` 扩展事件只由 CLI 的 `resolveProjectTrusted` 发出（`core/project-trust.ts`），它读写 `<agentDir>/trust.json`；SDK 路径的资源加载器提供 `resolveProjectTrust` 钩子（`core/resource-loader.ts` 的 `reload`），先在项目资源关闭的状态下加载全局与内联扩展，再按钩子的回答设置 `SettingsManager` 的信任并重新加载。MCP 扩展读 `ctx.isProjectTrusted()` 决定是否读 `.pi/mcp.json`。

## 决策

1. **目录**：主进程在 `ready` 与单实例锁之前，把 `userData` 设为数据目录，把 `sessionData` 设为缓存目录下的 `Chromium/`。`--user-data-dir=<dir>` 时数据目录为 `<dir>`、缓存目录为 `<dir>/Cache`（L4 与多配置隔离依赖它）。路径计算是主进程的纯函数，Core 只接收结果。
2. **迁移**：`core.sqlite` 的结构只经编号迁移改变：按版本号顺序执行，每个迁移与它的 `schema_migrations` 行在同一事务；已发布的迁移不修改；数据库版本高于本构建时拒绝打开，不降级。
3. **会话索引的两类列**：`sessions` 中从 JSONL 派生的列可随时清空重建；Core 自己的列（置顶、归档、未读、所属工作区、状态、worktree）在重建时保留。增量同步状态单独存在 `session_files`（字节偏移、末行哈希、最后的 entry id）。
4. **信任**：`project_trust` 以主 checkout 的规范路径为键，存决定（`trusted` / `denied`）、时间与当时可执行项的快照。撤销删除该行（回到"未决定"，对话框会再次询问），并让该工作区的 Agent Host 计划内重启（不计入崩溃退避，会话自动恢复）。所有消费者经 `piarc_config::project_trust` 查询，失败一律不信任。
5. **Pi 信任接管**：Agent Host 以 `projectTrusted: false` 创建每个会话的 `SettingsManager`，并经 `resourceLoaderReloadOptions.resolveProjectTrust` 用 Core 的 `trust/get` 回答 Pi；不调用 Pi 的 `resolveProjectTrusted`，不读写 `trust.json`，Pi 扩展的 `project_trust` 处理器不参与决定。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| `sessionData` 留在数据目录 | `localStorage` 不会被系统清理缓存时带走 | 第 9.1 节要求 Chromium 缓存可丢弃；Windows 上数据目录会混入大量 Chromium 文件 | 否决。`localStorage` 按第 7.3 节本来就可丢失 |
| 撤销记为 `denied` | 保留历史 | "撤销"与"拒绝"在对话框上是两种状态，混为一谈后无法再次询问 | 否决 |
| 在会话创建前单独调 `trust/get` 再传 `projectTrusted`（T06 的做法） | 改动少 | Pi 在 `SettingsManager` 构造时已按传入值读项目设置；fork、switch 改变 cwd 时不会重新询问 | 改为钩子 |
| 写 Pi 的 `trust.json` 镜像 Core 的决定 | Pi 的 CLI 也能看到 | 两处事实来源；同一用户的其他 Pi CLI 会读到 PiArc 的决定 | 否决（ADR-0005 第 5 条：不共享 Pi 的配置） |

## 后果

- 正面：数据库可以按迁移演进、索引坏了可重建而不丢用户的置顶归档；worktree 共享信任；Agent Host 中没有绕过 Core 的信任路径。
- 负面与代价：macOS 清理 `~/Library/Caches` 会清掉渲染进程的 `localStorage`（面板布局等回到默认值）；信任变化会重启工作区的 Agent Host，进行中的回合以 `uncertain` 结束。
- 需要配套做的事：T14 为每个工作区启动 `restart_on_trust_change` 并在会话文件变化时触发增量同步；T18 的对话框用 `TrustView` 的 `items` 与 `newItems`；T24 把 `.claude/` 的层与它们的可执行指针加入层级表。

## 重新评估的触发条件

出现以下任一情况时复核本决策：

- Pi 改变 `resolveProjectTrust` 钩子或项目资源的加载顺序；
- 用户报告 `localStorage` 被系统清理带来的问题；
- 需要按 worktree 而不是按仓库区分信任。
