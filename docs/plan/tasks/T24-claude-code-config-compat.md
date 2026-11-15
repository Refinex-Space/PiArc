# T24 Claude Code 配置兼容层与配置诊断（基础）

| 项 | 内容 |
|---|---|
| 阶段 | 3 M2 Harness 核心 |
| 依赖 | T23 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 中 |
| 关联验证项 | 无 |
| 关联需求 | FR-CX-02、FR-EX-05（基础） |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T24`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

ADR-0005 决定 PiArc 读取 Claude Code 的配置、但从不写入 `.claude/`。T13 的 piarc-config 只加载 PiArc 自己的设置，并为兼容层预留了接口；T23 的规则合并已经按 ADR-0005 的全部层级工作，但 `.claude/` 的文件还没有接进来。

本任务接入四个 Claude Code 配置文件与 `.claude/rules/`，把与 PiArc 功能对应的键映射进来，其余键明确标为"已忽略"；同时提供配置诊断 API 和设置页的基础版，让用户看清每个文件里哪些键生效、哪些被覆盖、哪些被忽略。

完成后，打开一个带 `.claude/` 的仓库，权限规则与 rules 文件直接生效（需求第 3 章场景 S7 的配置部分），诊断页能解释每一项的去向。

## 必读

1. 架构设计：
   - 第 6.14 节"Claude Code 配置兼容矩阵"
   - 第 6.6.1 节第 4 段"项目上下文"、第 6.6.2 节"Memory 文件"（rules 与懒加载）
   - 第 6.2.1 节起始模式解析、第 6.2.2 节规则来源、第 10.2 节"项目信任"
   - 第 7.3 节"状态归属"中配置文件一行（只读 `.claude/`）
2. ADR-0005。
3. `docs/research/claude-official-capabilities.md` A2.3（settings 层级）、A6.1（rules 与 `paths:`）。
4. T13、T22、T23 交付的代码与 CLAUDE.md：piarc-config 的分层与变更监听、memory 懒加载的注入路径、规则合并接口。
5. 实现时查阅：Claude Code 官方 settings 文档的键清单（以原始来源为准，`docs/research/` 只是快照）。

## 范围

### 要做

- 只读加载 `.claude/settings.json`、`.claude/settings.local.json`、`~/.claude/settings.json`、`~/.claude.json`，接入 ADR-0005 的合并顺序。
- 键映射表：每个已知键标为"生效""由后续任务支持（任务编号）"或"已忽略"。
- `.claude/rules/**/*.md` 与 `~/.claude/rules/` 的加载，`paths:` 条件注入。
- PiArc 永不写 `.claude/` 的保证与测试。
- 配置诊断 API 与设置页"配置诊断"基础版。

### 不做

- hooks 的解析与执行（T25）。本任务把 `hooks` 键标为"由 T25 支持"，T25 再改为生效。
- `~/.claude.json` 与 `.mcp.json` 中的 MCP 配置（T36）；agents、skills、commands 目录（T31、T37）；托管配置（T47）。
- 诊断完整版：全部来源、插件来源、企业来源（T41）。

## 交付物

### 1. 文件加载与合并

| 文件 | 层级（ADR-0005） | 信任约束 |
|---|---|---|
| `.claude/settings.local.json` | 项目本地，低于 `.piarc/settings.json` | 信任前 allow 规则与 `additionalDirectories` 不生效 |
| `.claude/settings.json` | 项目共享 | 同上 |
| `~/.claude/settings.json` | 用户级，最低 | 无 |
| `~/.claude.json` | 只读取状态并列入诊断 | MCP 段留给 T36，其余键标为"已忽略" |

- 合并规则：列表类键合并，deny 永远优先；标量按层级覆盖。
- 项目级 `.claude/settings*.json` 中的 `permissions.defaultMode` 为 `bypassPermissions` 或 `auto` 时不生效，诊断中注明原因。
- 一个文件解析失败不影响其他文件；诊断给出文件、行列与错误信息。
- 家目录位置可注入：测试一律使用临时家目录，不读取本机真实的 `~/.claude`。

### 2. 键映射表

- 一张集中定义的表（单一来源），键 → 状态 → 对应的 PiArc 设置或功能。M2 生效的至少包括 `permissions.allow`、`permissions.ask`、`permissions.deny`、`permissions.defaultMode`、`permissions.additionalDirectories`。
- 其余键以官方 settings 文档为准逐个归类；后续任务实现对应功能时修改这张表，不另建判断逻辑。
- 诊断与合并都读这张表，保证"列为生效的键"确实被使用。

### 3. `.claude/rules/`

- 从工作区根的 `.claude/rules/**/*.md` 与用户级 `~/.claude/rules/` 读取，支持符号链接。
- 没有 `paths:` 的 rules 随项目上下文段加载（第 6.6.1 节第 4 段），与 memory 文件同样对待。
- 有 `paths:` 的 rules：agent 首次读写匹配文件时，以 T22 建立的懒加载路径作为 system-reminder 注入，每个 rules 文件每会话注入一次；不改写 system prompt。

### 4. 不写 `.claude/`

- piarc-config 的写接口拒绝 `.claude/` 下的任何路径，并返回结构化错误。
- "总是允许"、模式记忆、设置页的修改都只写 `.piarc/` 与用户级 PiArc 设置。

### 5. 配置诊断

- Core API：返回每个配置文件的加载状态（已加载、不存在、解析失败、因未信任而部分生效）、生效的键、被覆盖的键（以及覆盖它的来源）、被忽略的键、解析错误。
- 设置窗口"配置诊断"页基础版：按文件列出上述信息，可展开查看每个键的最终取值与来源。

### 6. L2 场景与能力 ID

合并顺序、信任约束、rules 条件注入各至少一个场景（`tests/scenarios/config-*.yaml`），能力 ID 形如 `CAP-CONFIG-MERGE-001`、`CAP-CONFIG-RULES-001`。

## 实现要点

- 配置变更监听沿用 T13：`.claude/` 文件变化后重新加载并刷新诊断。第 10.2 节要求"新增的可执行项再次确认"：T13 或 T18 已有该机制时把 `.claude/` 文件接入；没有时登记事项，不在本任务扩展。
- `~/.claude.json` 可能很大且含与 PiArc 无关的状态，只解析需要的部分，不把内容写进日志。
- rules 的 `paths:` 匹配用 gitignore 风格 glob，路径相对工作区根；匹配前规范化路径（Windows 大小写与分隔符）。

## 验收标准

- [T24-A01] 四个 Claude Code 配置文件与 PiArc 配置按 ADR-0005 的顺序合并，列表类键合并、deny 优先。验证：用真实文件夹具的集成测试。
- [T24-A02] 项目级 `.claude/settings*.json` 的 allow 规则与 `additionalDirectories` 在信任前不生效，deny 与 ask 照常生效。验证：测试。
- [T24-A03] 项目级 `.claude/settings*.json` 中 `defaultMode` 为 `bypassPermissions` 或 `auto` 时不生效，诊断注明原因。验证：测试。
- [T24-A04] 键映射表之外的键与标为"已忽略"的键逐个出现在诊断的忽略列表中。验证：测试。
- [T24-A05] 一个配置文件 JSON 损坏时其他文件照常加载，诊断给出文件、行列与错误信息。验证：测试。
- [T24-A06] 测试全程使用注入的临时家目录，不读取本机 `~/.claude`。验证：测试代码审阅与家目录注入的单测。
- [T24-A07] 无 `paths:` 的 rules 进入项目上下文段；有 `paths:` 的 rules 在首次读写匹配文件时以 system-reminder 注入、每会话一次，读写不匹配的文件时不注入，system prompt 字节不变。验证：场景测试中的 mock provider 请求断言。
- [T24-A08] 跑完全部 L2 场景后，各工作区与临时家目录中的 `.claude/` 没有任何新增或修改；piarc-config 写接口拒绝 `.claude/` 路径。验证：测试（目录快照比对与写接口单测）。
- [T24-A09] 运行中修改 `.claude/settings.json` 后配置重新加载，诊断随之更新。验证：测试。
- [T24-A10] 配置诊断页按文件显示加载状态、生效键、被覆盖键（含覆盖来源）、忽略键与解析错误。验证：Playwright 流程与截图（`tmp/evidence/T24/`）。
- [T24-A11] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新 `crates/piarc-config` 的 CLAUDE.md：键映射表位置与修改方式、家目录注入、不写 `.claude/` 的约束。
- 在架构第 6.14 节补充 M2 实际生效的键清单（补充型更新）。
