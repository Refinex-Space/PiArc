# T13 存储、数据目录、配置与项目信任（Core 侧）

| 项 | 内容 |
|---|---|
| 阶段 | 2 M1 可行走骨架 |
| 依赖 | R1（结论为进入 M1） |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 大 |
| 关联验证项 | 无 |
| 关联需求 | FR-WS-01（Core 部分）、FR-WS-03（索引部分） |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T13`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

M0 证明了高风险假设可行，M1 开始搭正式产品。Core 是应用级事实来源（架构第 7.3 节），但目前还没有落脚的地方：数据目录、SQLite 索引、设置分层、项目信任都不存在。本任务把这四样做出来，后续任务直接在上面工作：

- T14 用会话索引做会话列表与重启恢复；
- T18 用信任接口做信任对话框；
- T20 写审计表、读写 `.piarc/settings.local.json`；
- T24、T25、T36 在信任闸门与配置分层上接入 Claude Code 配置、hooks、MCP。

完成后，Core 有一个带迁移的 SQLite 数据库、一套可重建的会话索引、分层校验的设置与变更通知，以及按仓库主 checkout 解析的项目信任。

## 必读

1. 架构设计：
   - 第 5.5 节"Pi 配置隔离"
   - 第 7.1 节（piarc-store、piarc-config、piarc-git、piarc-telemetry 的职责与依赖规则）、第 7.3 节"状态归属"
   - 第 9 章"数据与存储"全部
   - 第 10.2 节"项目信任"、第 10.1 节威胁表"恶意项目配置"一行
   - 第 15.2 节"数据目录""路径"两行、第 15.3 节
2. ADR-0005、ADR-0011。
3. `docs/research/pi-v1.4.0-baseline.md` 第 4.3 节"session 存储"、第 4.5 节"settings 层级"（Pi 的项目信任与 `project_trust` 事件）、第 4.6 节"extension 机制"。
4. T04、T06 交付的代码与 CLAUDE.md：`CoreConfig`、`piarc-host`、`agent-host` 的会话目录与 `agentDir`。
5. 实现时查阅：rusqlite 锁定版本的事务与迁移用法；Pi 锁定版本的会话 entry 类型与 `project_trust` 事件签名；Electron 锁定版本中 `app.setPath` 可设置的路径名。

## 范围

### 要做

- 两个平台的数据目录与缓存目录，主进程启动时固定 `userData`。
- piarc-store：迁移框架、五张表、Pi JSONL 流式只读解析与增量同步、重建索引。
- piarc-telemetry：日志按天轮转、保留 7 天。
- piarc-config 第一版：PiArc 用户设置、`.piarc/settings.json`、`.piarc/settings.local.json` 的分层加载、校验、合并与变更监听。
- 项目信任：主 checkout 解析、持久化、撤销、可执行配置枚举、`trust/get`，以及 Harness Kit 对 Pi `project_trust` 的接管。

### 不做

- 信任对话框与设置界面（T18）、会话编排与会话列表事件（T14）。
- Claude Code 配置文件的语义加载（T24）。本任务的分层接口要能插入 ADR-0005 中 `.claude/` 的两层与企业层。
- 全文索引 `session_fts`（T35）、检查点表（T28）、日志与诊断包脱敏（T45）。

## 交付物

### 1. 数据目录

- macOS `~/Library/Application Support/PiArc/`，Windows `%LOCALAPPDATA%\PiArc\`；缓存目录 macOS `~/Library/Caches/PiArc/`，Windows `%LOCALAPPDATA%\PiArc\Cache\`（架构第 9.1 节）。
- 主进程在 `ready` 之前调用 `app.setPath('userData', …)`，再把数据目录与缓存目录经 `CoreConfig` 交给 Core。路径计算写成纯函数，两个平台都有单测。
- Core 按第 9.1 节建立子目录（`pi/`、`sessions/`、`logs/` 等），`agentDir` 与 Pi 会话目录都指向这里。

### 2. piarc-store

- rusqlite；迁移按版本号顺序执行，每个迁移一个事务，记录在 `schema_migrations`；已执行的迁移跳过；失败时回滚且不留下半个版本。
- 表：`workspaces`、`sessions`、`audit_events`、`background_tasks`、`schema_migrations`（字段按第 9.2 节），另加 `project_trust`（见交付物 5，补充型）。
- Pi JSONL 解析：流式读取，按 entry 解析出会话元数据（标题、模型、用量累计、更新时间、父会话）写入 `sessions`。
- 增量同步：每个会话文件记录已同步的字节偏移与最后一个 entry id；文件变长时从偏移继续；文件变短或被替换时整文件重扫。
- 重建索引：清空派生数据后全量扫描 `pi/sessions/`，作为 Core API 暴露（第 9.2 节"重建索引"诊断操作）。

### 3. 日志

piarc-telemetry 把 Core 与 Agent Host 的日志写入 `logs/`，按天轮转，启动时与每天清理超过 7 天的文件。

### 4. piarc-config

- 层级（低 → 高）：内置默认、用户级 `settings.json`、`.piarc/settings.json`、`.piarc/settings.local.json`；会话层与企业层留接口。层级是一张"来源 + 优先级"的有序表，T24 插入 `.claude/` 两层时不改合并代码。
- 合并：标量按优先级覆盖，对象深合并，列表合并去重；权限列表的 deny 优先语义由 T20、T23 在 piarc-policy 中实现。
- 校验：用 schema 校验每个文件；错误报告文件路径、JSON Pointer 与原因；一个文件无效时只跳过该文件，其余照常加载；未知键报告为警告。
- 变更监听：配置文件变化后去抖重新加载，发出带变化键列表的事件；新内容无效时保留上一份有效配置并报告错误。
- 写接口：只写 `.piarc/` 与用户级设置文件，写入用临时文件加原子 rename。

### 5. 项目信任

- 主 checkout 解析（piarc-git）：普通仓库取仓库根；linked worktree 的 `.git` 是文件，经 `gitdir` 与 `commondir` 找到主仓库；submodule 的 gitdir 没有 `commondir`，按独立仓库处理；非 git 目录取自身规范路径。
- 持久化：`project_trust` 以主 checkout 规范路径为键，记录决定、时间与信任时的可执行项快照；撤销后该工作区的 Agent Host 重启使撤销生效（会话自动恢复）。
- 可执行配置枚举：Core API 列出项目中会被启用的可执行项，按类别（hooks、MCP server、权限 allow 规则、插件、Pi 扩展）给出来源文件与条目名。只读取键名与条目，不做语义加载（语义加载属于 T24、T25、T36、T40）。扫描范围：`.piarc/settings*.json`、`.claude/settings*.json`、`.mcp.json`、`.claude-plugin/`、`.pi/`（extensions、settings.json、mcp.json）。
- 新增项检测：与信任时的快照比较，API 返回新增的可执行项，供 T18 的对话框再次确认（第 10.2 节）。
- 接口约定：项目级可执行配置的消费者（hooks、MCP、allow 规则、插件、扩展）一律经 piarc-config 的同一个信任查询函数判断，约定写进 piarc-config 的 CLAUDE.md。
- `trust/get`（AHP，Agent Host → Core）：Core 侧实现；Agent Host 的 `core-bridge` 在超时、错误、解析失败时一律返回"不信任"。
- Harness Kit 接管 Pi 的 `project_trust` 事件，决定来自 `trust/get`，不使用 Pi 的 `trust.json`（第 5.5 节）。未信任时 Pi 的项目级资源（`.pi/extensions`、`.pi/settings.json`、`.pi/mcp.json` 等）不加载。

## 实现要点

- Pi 写会话文件用 `appendFileSync`，不 fsync、不加锁：最后一行可能写到一半。解析器把不完整的末行视为尚未写完，下次从它的起点继续，不报错也不跳过。
- 会话格式版本（v1.4.0 为 `CURRENT_SESSION_VERSION = 3`）不认识时，把该会话标为"索引不可用"并报告，不让 Core 失败；单行损坏时跳过该行并记录。
- piarc-config 与 piarc-fs 不能互相依赖：文件监听用 piarc-fs 的 notify 封装，由 piarc-core 把变化事件转给 piarc-config。
- 路径一律先规范化再比较（大小写、符号链接、Windows `\\?\` 前缀），测试夹具含空格与中文路径（第 15.3 节）。
- `trust/get` 是安全边界：任何异常路径都返回"不信任"，用故障注入测试覆盖，不能只测正常路径。

## 验收标准

- [T13-A01] 迁移在空库与已迁移库上各执行两次，结果一致且 `schema_migrations` 记录正确；注入失败的迁移整体回滚，数据库停留在上一版本。验证：测试。
- [T13-A02] 数据目录与缓存目录在 macOS 与 Windows 上解析为第 9.1 节的位置，主进程在 `ready` 前设置 `userData`。验证：单测（Windows 部分由 CI 输出证明）。
- [T13-A03] 对同一组会话文件，随机追加 entry 后做增量同步，与全量重建索引得到的 `sessions` 表内容完全相同；末行写到一半时不报错，补全后被同步。验证：测试。
- [T13-A04] 100 MB 的合成会话文件建立索引期间，Core 内存增量不超过 32 MB。验证：测试中记录的内存数据。
- [T13-A05] 未知会话格式版本与损坏行不会让 Core 失败：前者标为索引不可用，后者跳过并记录。验证：测试。
- [T13-A06] 日志按天轮转，超过 7 天的日志被清理。验证：测试（时钟可注入）。
- [T13-A07] 四个层级的设置按优先级合并；无效文件被跳过且错误报告含文件路径与 JSON Pointer，其余层照常生效。验证：测试。
- [T13-A08] 运行中修改设置文件后发出带变化键的事件；改成无效内容时保留上一份有效配置并报告错误。验证：测试。
- [T13-A09] 信任按主 checkout 解析：同一仓库的 linked worktree 共享信任，submodule 与非 git 目录各自独立。验证：测试（用真实 git 夹具）。
- [T13-A10] 信任决定在 Core 重启后保留；撤销后 `trust/get` 返回不信任，且该工作区的 Agent Host 重启后不再加载项目级 Pi 扩展。验证：测试。
- [T13-A11] `trust/get` 在超时、Core 返回错误、响应无法解析三种情况下，Agent Host 都按不信任处理。验证：故障注入测试。
- [T13-A12] 未信任工作区中，夹具 `.pi/extensions/` 注册的工具不出现在模型请求的工具列表中；信任后出现。验证：mock provider 请求断言。
- [T13-A13] 可执行配置枚举对夹具工作区按类别列出全部条目与来源文件；在 `.piarc/settings.json` 中新增一个 allow 规则后，新增项检测只返回这一条。验证：测试。
- [T13-A14] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 创建或更新 `crates/piarc-store`、`crates/piarc-config`、`crates/piarc-git` 的 CLAUDE.md：迁移的写法、增量同步的状态、配置层级表与扩展方式、信任查询的唯一入口、主 checkout 解析规则。
- 在架构第 9.2 节补充 `project_trust` 表（补充型更新）。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：配置层级与合并、信任查询、JSONL 流式解析。
