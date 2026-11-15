# T22 System prompt 组装与 memory 文件

| 项 | 内容 |
|---|---|
| 阶段 | 2 M1 可行走骨架 |
| 依赖 | T21 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 中 |
| 关联验证项 | 无 |
| 关联需求 | FR-CX-01、NFR-05 |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T22`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

目前会话用的还是 Pi 默认的 system prompt，其中写死了 "pi" 和 Pi 的文档路径；T06 关掉了 Pi 自带的上下文文件加载，所以 `CLAUDE.md` 还没有进入上下文。本任务让 Harness Kit 接管 system prompt：按架构第 6.6.1 节的七段、"越稳定越靠前"组装，内容全部由 PiArc 原创；同时按 Claude Code 的语义加载 memory 文件（层级拼接、`@path` 导入、子目录懒加载）。

system prompt 的稳定性直接影响 prompt cache 与 Claude 的 preserved thinking（`claude-official-capabilities.md` C 节）：会话中途的变化一律以追加消息送达，不改写已发送的 system prompt。

完成后，打开一个带 `CLAUDE.md` 的仓库，模型看到 PiArc 自己的身份与准则、项目 memory 与环境信息，且跨回合的 system 字节不变。

## 必读

1. 架构设计：
   - 第 6.6.1 节"System prompt 组装"、第 6.6.2 节"Memory 文件"
   - 第 6.14 节 memory 一行、第 6.15 节"缓存断点"一行
   - 第 10.2 节（信任前 memory 照常加载）、第 10.4 节
2. ADR-0005、ADR-0006。
3. `docs/research/claude-official-capabilities.md` A6.1"CLAUDE.md 层级与加载"、A6.2 中 prompt caching 一条。
4. `docs/research/pi-v1.4.0-baseline.md` 第 4.2 节"system prompt 的组装"。
5. T06、T07、T16、T20 交付的代码与 CLAUDE.md：Harness Kit 扩展工厂、规范名工具与描述、文件工具的路径信息、"权限扩展"审批卡。
6. 实现时查阅：Pi 锁定版本的 `before_agent_start` 返回值、`systemPromptOptions` 与 `forceSystemPrompt`、`sendMessage` 的 custom message 与送达时机。

## 范围

### 要做

- Harness Kit 在 `before_agent_start` 中按七段组装 system prompt，PiArc 自写身份与准则、工具使用准则。
- memory 文件：层级拼接、用户级、`@path` 导入、子目录懒加载、会话中途变化以追加消息送达。
- 确认 Pi 自带上下文文件加载保持关闭；提示词原创性自查。
- 每条行为一个 L2 场景，登记能力 ID。

### 不做

- `.claude/rules/` 与 `paths:`（T24），第 4 段中的 rules 索引由 T24 填入。
- 输出风格与 skills 索引（T37）、MCP server 说明（T36）：第 3、5、6 段在 M1 没有内容，组装时省略，顺序位置保留。
- 统一的 system reminder 通道与显示控制、压缩后重注入（T27）；自动记忆（T47）。

## 交付物

### 1. System prompt 七段

| 顺序 | 段 | M1 内容 |
|---|---|---|
| 1 | 身份与基础准则 | PiArc 原创的编码 agent 行为准则（产品名为 PiArc，不提 Claude 或 pi） |
| 2 | 工具使用准则 | 当前工具集中各工具的使用约束，随 Tool Profile 生成 |
| 3 | 输出风格 | 省略（T37） |
| 4 | 项目上下文 | memory 文件（交付物 2） |
| 5 | skills 索引 | 省略（T37） |
| 6 | MCP server 说明 | 省略（T36） |
| 7 | 环境 | 工作目录、平台、日期、会话开始时的 git 状态快照 |

- 不使用 Pi 默认 preamble 与 docs 段。
- 组装结果在会话开始时确定；同一会话内的后续回合发送完全相同的 system 字节。
- 提示词文本放在 `agent-host/src/harness/prompts/` 下的独立文件中，用英文书写。

### 2. Memory 文件

- 项目层级：从会话 cwd 向上到文件系统根逐级收集 `CLAUDE.md`、`.claude/CLAUDE.md`、`AGENTS.md`、`CLAUDE.local.md`，按从根到 cwd 的顺序拼接（越靠近 cwd 越靠后）。
- 同一目录同时有 `CLAUDE.md` 与 `AGENTS.md` 时默认只读 `CLAUDE.md`，设置中可改为两者都读；只有 `AGENTS.md` 时读它。
- 用户级：`~/.claude/CLAUDE.md` 与 PiArc 用户级 memory 文件（位置在数据目录下，补充型决定，写进架构第 9.1 节），排在项目层级之前。
- 每个文件带来源路径标注；注入前去掉块级 HTML 注释；单文件超过 4 MiB 时跳过并记录。
- `@path` 导入：路径相对于所在文件；最多 4 层；代码块与行内代码中的 `@` 不解析；循环导入只展开一次。
- 工作区外的导入首次需要确认：经 T20 的"权限扩展"审批卡询问，决定按工作区记录在 Core；未确认或被拒绝时不展开，并在该位置留下说明。
- 未信任的工作区照常加载 memory 文件（第 10.2 节）。

### 3. 懒加载与中途变化

- 子目录 memory：agent 首次读写某个子目录（cwd 之下）中的文件时，把该子目录到 cwd 之间尚未加载的 memory 文件以带标记的 custom message 注入，每个文件每会话一次。T27 会把这条注入并入统一的 system reminder 通道。
- 会话中途 memory 文件变化：在下一回合开始前以追加消息送达变化后的内容，不改写 system prompt。

### 4. L2 场景与能力 ID

七段顺序、system 字节稳定、拼接顺序与取舍、`@path` 导入规则、越界导入确认、懒加载、中途变化各至少一个场景（`tests/scenarios/context-*.yaml`），能力 ID 形如 `CAP-CTX-MEMORY-001`。mock provider 按场景配置校验 system 段的存在与顺序。

## 实现要点

- 原创性：只依据第 6.6.1 节与官方文档的行为描述写提示词，写作时不参考 `reference/claude-code` 中的提示词。提交前用脚本做自查：把 PiArc 提示词与本地 `reference/claude-code` 的文本做 n-gram 比对，连续 10 个词以上相同的片段必须为零；脚本只输出统计与 PiArc 一侧的位置，不输出也不保存参考文本。`reference/` 不在 CI 中，所以自查在本机执行，结果写进 `docs/engineering/prompt-originality.md`（写作依据、检查方法、结果、日期）。
- 环境段的日期与 git 状态在会话开始时取一次；跨日的会话不更新 system，日期变化走追加消息。
- 懒加载的触发点用文件工具的路径信息（Read、Write、Edit、Glob、Grep），不依赖模型自述。
- 注意 Pi 的上下文文件加载器与 Harness Kit 不能同时生效：用 mock 请求断言同一个 `CLAUDE.md` 的内容只出现一次。
- 家目录位置可注入：测试一律使用临时家目录，不读取本机真实的 `~/.claude/CLAUDE.md`。

## 验收标准

- [T22-A01] 模型请求中的 system prompt 按第 6.6.1 节顺序包含第 1、2、4、7 段，第 3、5、6 段在 M1 省略；不含 Pi 默认 preamble 与 Pi 文档路径。验证：场景测试中的 mock provider 请求断言。
- [T22-A02] 同一会话的多个回合，以及回合之间 memory 文件被修改时，发送的 system 字节完全相同。验证：场景测试（逐字节比较）。
- [T22-A03] 多级目录的 `CLAUDE.md`、`.claude/CLAUDE.md`、`CLAUDE.local.md` 与用户级 memory 按规定顺序拼接；`CLAUDE.md` 与 `AGENTS.md` 并存时默认只取前者，改设置后两者都取。验证：场景测试。
- [T22-A04] 块级 HTML 注释被去掉；超过 4 MiB 的 memory 文件被跳过并记录。验证：单测。
- [T22-A05] `@path` 导入按相对路径解析，第 5 层不再展开，代码块与行内代码中的 `@` 不解析，循环导入只展开一次。验证：单测。
- [T22-A06] 工作区外的导入首次出现"权限扩展"审批卡；允许后展开并在之后的会话中不再询问；拒绝时不展开并留下说明。验证：场景测试。
- [T22-A07] 首次读取子目录中的文件后，该子目录的 `CLAUDE.md` 以带标记的消息注入一次；再次读写同一子目录不重复注入。验证：场景测试。
- [T22-A08] 会话中途修改 `CLAUDE.md` 后，下一回合的请求中出现包含新内容的追加消息。验证：场景测试。
- [T22-A09] 同一个 `CLAUDE.md` 的内容在请求中只出现一次（Pi 自带加载保持关闭）；未信任工作区的 memory 照常出现。验证：mock provider 请求断言。
- [T22-A10] 提示词原创性自查脚本在本机运行，连续 10 词以上相同片段为零，结果记录在 `docs/engineering/prompt-originality.md`。验证：脚本输出与记录文件。
- [T22-A11] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新 `agent-host/CLAUDE.md`：七段的组装入口、提示词文件位置、memory 加载顺序、懒加载触发点、修改提示词前必须重跑原创性自查。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：memory 加载、`@path` 解析、custom message 注入。
