# 0038. Claude Code 配置兼容层与配置诊断的落地（补充）

- 状态：已接受，补充 ADR-0005、ADR-0033
- 日期：2026-11-18
- 相关：架构第 6.6.2、6.14、7.3、7.4、10.2 节；T24

## 背景

ADR-0005 决定 PiArc 只读 Claude Code 的配置，给出了合并顺序与信任约束。T13 在 `piarc-config` 中为 `.claude/` 预留了层级，T22 建立了 memory 文件的读取与懒加载，T23 让规则按 ADR-0005 的全部层级求值。T24 接入四个文件与 `.claude/rules/` 时，架构没有规定以下细节：Claude Code 的约 250 个设置键怎样决定"生效 / 待支持 / 忽略"并保证判断只有一处；测试怎样不读本机的 `~/.claude`；`~/.claude.json` 读到什么程度；带 `paths:` 的 rules 怎样在每会话只注入一次、恢复与分叉后仍一致；"不写 `.claude/`"由谁保证；用户从哪里看到每个键的去向。

## 决策

1. **键映射表是唯一判断。** `piarc_config::claude::SETTINGS_KEYS` 按官方 settings 索引逐键给出状态：生效（以同一 JSON Pointer 并入 PiArc 设置）、待支持（带任务编号）、已忽略（带原因）。合并只保留生效的键（`claude::project`），诊断用同一张表分类（`claude::classify`），表外的键按"未知"列为忽略。M2 生效的键是 `permissions.allow`、`ask`、`deny`、`defaultMode`、`additionalDirectories`。后续任务实现某个键时只改这一行并把键加进 PiArc 的设置 schema，测试保证生效的键都是 PiArc 已知的设置。
2. **三个设置层进同一张层级表。** `LayerTable::workspace(data, workspace, home)` 在 PiArc 四层之外加入 `~/.claude/settings.json`（`claudeUser`，优先级 10）、`.claude/settings.json`（30）、`.claude/settings.local.json`（40），格式标为 `Format::ClaudeCode`、不可写。信任与模式过滤沿用 T13、T23 的规则：项目层的 allow、`additionalDirectories` 与 `acceptEdits` 在信任前移除，`bypassPermissions`、`auto` 始终移除。生效键的类型错误与 PiArc 文件一样使整个文件被跳过；未知键不校验。
3. **家目录由 Core 注入。** `CoreConfig.home`（取代 T22 的 `memory_home`）默认取进程家目录，经 `DataDirs::with_home` 传到所有读取设置的地方（`DataDirs::layers`）；测试、L2、`createForTests`（L4）一律注入临时目录，`None` 不读任何用户级 Claude Code 文件。
4. **`~/.claude.json` 只读键名。** 它不是设置层：诊断按键名列出（值在解析时跳过，不写日志），`mcpServers` 与当前工作区在 `projects` 下的 `mcpServers` 标为"由 T36 支持"，其余标为忽略。
5. **rules 是 memory 文档。** 用户级 `~/.claude/rules/` 排在 `~/.claude/CLAUDE.md` 之后，工作区根的 `.claude/rules/` 排在根目录的 `.claude/CLAUDE.md` 之后；递归、跟随符号链接（同一目录只访问一次）、跳过隐藏项。注入正文时去掉 frontmatter；指向工作区外的符号链接与外部导入一样需要审批。`paths:` 按 gitignore 语义相对工作区根匹配，Windows 不区分大小写，无效或为空的 `paths:` 永不加载。
6. **条件 rules 由 Core 匹配、Agent Host 记账。** AHP `fs/memory` 新增可选参数 `files`（刚读写的文件）与 `rules`（本会话已注入的条件 rules），`MemoryFile` 新增 `paths`，`MemorySnapshot` 新增 `inactiveRules`。Agent Host 在 Read、Write、Edit 成功后，只在 Core 上次回答"还有未加载的条件 rules"时带上文件路径询问；新出现的条件 rules 经 T22 的 `piarc.memory` 追加消息送达，并写入分支条目 `piarc.memoryRules`，之后每次扫描都带上它们，因此每会话只注入一次、system prompt 不变，恢复与分叉沿用分支。
7. **不写 `.claude/` 由写接口保证。** `piarc-config` 的写入（含底层 `replace_file`）对路径中含 `.claude` 目录或名为 `.claude.json` 的目标返回结构化错误 `WriteError::ClaudeConfig`（Core 映射为 `permissionDenied`），与层级表是否标为可写无关。L2 运行器在每个场景前后比对运行根下全部 Claude Code 配置的快照，有新增、修改或删除即判失败。
8. **配置诊断复用权限裁决的加载。** Core API `config_diagnostics`（NAPI `configDiagnostics`）以 `TrustService::permission_settings` 加载设置，对每个文件给出加载状态（已加载、不存在、无法读取、无效但沿用上一份、信任前部分生效）、生效的键（标量写明决定它的层，列表为合并）、被覆盖的键与覆盖它的层、忽略的键与原因（未知、忽略、待支持及任务、待信任、项目不能选择的模式）和带行列的解析错误。设置窗口"配置诊断"页按文件列出并可展开，收到 `core/settings` 后重新请求。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 合并与诊断各自维护键清单 | 改动局部 | 两处会漂移，诊断可能说"生效"而合并没用 | 否决 |
| `.claude/` 文件原样并入合并、靠 schema 警告未知键 | 实现最省 | 忽略的键（`env`、`model` 等）会进入 PiArc 设置，后续任务读到时语义已错 | 否决 |
| Agent Host 用 glob 库自行匹配 `paths:` | 少一次 AHP 往返 | Agent Host 要读 rule 的 frontmatter（违反 ADR-0004/0020 的 I/O 边界）或由 Core 下发全部 glob；两侧 glob 语义要保持一致 | 否决，匹配在 Core |
| Agent Host 持久化全部触及过的文件 | Core 无状态 | 条目随会话无限增长，每次扫描都要发送 | 否决，只记已注入的 rules |
| `~/.claude.json` 整份解析为 JSON 值 | 简单 | 文件可能很大且含账号信息，没有必要在内存中保留其值 | 否决，只取键名 |

## 后果

- 正面：带 `.claude/` 的仓库打开即按其权限规则与 rules 工作；诊断页能解释每个键的去向；后续任务只改映射表的一行即可让一个键生效。
- 负面与代价：映射表要随 Claude Code 的设置索引更新；每次触及文件都多一次 `fs/memory` 往返，只在有未加载的条件 rules 时发生；家目录被监听（`~/.claude/` 不存在时监听家目录本身），家目录中的任何变动都会触发一次去抖后的重新加载。
- 需要配套做的事：T25、T27–T29、T31、T35–T40、T46、T47 实现对应功能时把映射表中的行改为"生效"；T41 的诊断完整版在本 API 上增加插件与企业来源。

## 重新评估的触发条件

- Claude Code 的设置文件位置或合并语义发生不兼容变化；
- 条件 rules 的往返在 L3 或性能基准中成为可见的延迟。
