# T37 Skills、斜杠命令、命令面板与输出风格

| 项 | 内容 |
|---|---|
| 阶段 | 4 M3 多会话与生态 |
| 依赖 | T36 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 大 |
| 关联验证项 | 无 |
| 关联需求 | FR-EX-01、FR-EX-02、FR-HN-07、FR-SY-05（命令面板） |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T37`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

Pi 已经有 skills 与 prompt templates，格式与 Claude Code 接近，但目录不同、不读 `.claude/skills` 与 `.claude/commands`、不支持 `allowed-tools`（基线文档第 4.7 节）。本任务按架构第 6.7 节补齐：Claude Code 目录兼容、skill 的渐进加载与 frontmatter、斜杠命令合并列表、composer 命令面板与应用级 Mod+K 命令面板、输出风格。

完成后，带 `.claude/skills`、`.claude/commands` 的仓库打开即可使用；system prompt 只含 skills 索引，正文按需加载；切换输出风格不破坏 prompt cache。

## 必读

1. 架构设计：
   - 第 6.7 节"Skills、命令、插件、输出风格"
   - 第 6.6.1 节（第 3、5 段与会话中途的变化）、第 6.6.4 节（压缩后重注入 skill 正文）、第 6.15 节（skill 正文上限）
   - 第 6.2.2 节（`Skill(名称)` 规则）、第 6.2.3 节（裁决流程）、第 6.14 节（兼容矩阵）
   - 第 8.2 节（composer 的 `/` 命令面板）、第 8.5 节（Mod+K、输入法守卫）、第 10.2 节
2. `docs/research/claude-official-capabilities.md` 第 A5.1、A5.2、A5.4 节。
3. `docs/research/pi-v1.4.0-baseline.md` 第 4.7 节、第 9 节第 6、7 行。
4. T18（快捷键注册表）、T19（composer）、T22（system prompt 组装）、T23（规则）、T24（配置诊断与 rules 的 `paths` 注入）、T27（压缩重注入接口）交付的代码与 CLAUDE.md。
5. 实现时查阅（Pi 锁定版本）：skills 加载与 `resources_discover`、settings 中的 `skills` 路径、prompt templates 的参数语法、`registerCommand`；Claude Code 官方文档中 commands 的命名空间规则与输出风格的目录与 frontmatter。

## 范围

### 要做

- Skills 发现、索引、`Skill` 工具与 frontmatter。
- 斜杠命令合并列表、参数替换与内置命令。
- composer 命令面板（按来源分组、模糊搜索）；应用级 Mod+K 命令面板。
- 输出风格（内置若干 + Markdown 自定义），切换以消息送达。
- 设置窗口"skills 与插件"页中的 skills 列表与诊断。

### 不做

- 插件提供的 skills 与命令（T40）、MCP prompts 命令（T40，本任务在合并列表中预留来源）。
- skill 的 `context: fork`（T48）；skill 的 `model`、`effort` 字段（第 6.7 节未列入，解析后标为暂不支持）。
- UserPromptExpansion hook（T41，本任务为命令展开预留挂载点）。
- skill 正文中的动态命令注入（`` !`command` ``）：不执行。

## 交付物

### 1. Skills 发现

- 路径：Pi 默认路径（PiArc 的 `pi/` agent 目录与项目中的 Pi 目录）+ `.claude/skills`、`~/.claude/skills`、`.piarc/skills`、PiArc 用户目录 `skills/`；插件经 `resources_discover` 预留。
- 同名取舍：项目级优先于用户级；同级内 `.piarc` > `.claude` > Pi 默认目录。被覆盖的条目在诊断中列出。
- 发现的 skill 目录对 `Read` 放行只读访问（模型可以直接读 SKILL.md 与资源文件）。
- 文件变化时重新加载（AHP `resources/reload`），`resources/listSkills` 返回列表、来源与警告。

### 2. 索引与 `Skill` 工具

- system prompt 第 5 段只列名称与截断到固定长度的描述；`disable-model-invocation: true` 的 skill 不进入索引。
- 带 `paths` 的 skill 在 agent 处理匹配文件后才进入索引，以追加消息送达（与 T24 的 rules 注入同一机制）。
- 规范名 `Skill`：加载 SKILL.md 正文，完成 `arguments`（`$name`、`$ARGUMENTS`）替换，正文作为消息留在对话中；已调用的 skill 登记到 T27 的重注入接口（单个 5K、合计 25K token）。
- 加载正文按只读处理，默认不询问；`Skill(名称)` 的 deny 与 ask 规则照常生效。

### 3. frontmatter

| 字段 | 行为 |
|---|---|
| `allowed-tools` | 调用该 skill 的当前回合内，列出的工具免审批：Core 在裁决第 6 步（allow 规则）参考，deny 与 ask 仍然优先；回合结束即失效；未信任项目中的 skill 不产生此效果 |
| `disable-model-invocation` | 只能由用户经斜杠命令调用，不进索引 |
| `user-invocable` | 为 false 时不出现在斜杠命令列表 |
| `arguments`、`argument-hint` | 参数替换与面板中的参数提示 |
| `paths` | 见第 2 节 |
| `hooks` | 经 T25 的 hooks 引擎作为限定作用域的来源接入，从该 skill 被调用起到会话结束生效（以官方文档为准）；未信任项目中的 skill 不执行 |
| 其他字段 | 保留在解析结果中，诊断中标为"已忽略"或"暂不支持（Txx）" |

### 4. 斜杠命令

- 合并列表的来源：内置命令（Core 实现）、`.claude/commands`（项目与用户级，命名空间规则与 Claude Code 一致）、`.piarc/commands`、PiArc 用户目录 `commands/`、Pi prompt templates、`user-invocable` 的 skills；MCP prompts 预留。
- 内置命令至少包括 `/compact`、`/clear`、`/model`、`/rewind`、`/context`、`/output-style`；其他内置命令只映射已有功能，不为命令新增功能。
- 同名冲突：内置命令优先，其余按第 1 节的来源顺序，冲突在诊断中列出。
- 参数：`$ARGUMENTS`、位置参数 `$1` 起、命名参数；命令文件支持与 skill 相同的 frontmatter 子集（含 `allowed-tools`）。
- 展开位置统一，并为 T41 的 UserPromptExpansion 预留挂载点。AHP `resources/listCommands` 返回合并后的列表。

### 5. 命令面板

- composer 中输入 `/` 打开面板：按来源分组、模糊搜索、显示描述与参数提示、键盘导航；输入法合成期间 `/` 不触发（第 8.5 节）。
- 应用级 Mod+K 命令面板：快捷键注册表中的应用操作、会话切换、当前会话的斜杠命令，模糊搜索；快捷键可在设置中修改。

### 6. 输出风格

- 内置风格（默认、简洁、讲解等），指令文本由 PiArc 原创。
- 自定义：Markdown + frontmatter，目录为 `.claude/output-styles/`、`~/.claude/output-styles/`、`.piarc/output-styles/` 与 PiArc 用户目录（目录与字段以官方文档为准，实现时核对）。
- 新会话把当前风格放在 system prompt 第 3 段；会话中途切换（设置、`/output-style`）以追加消息送达，不改写已发送的 system prompt。

### 7. 设置页与测试

- "skills 与插件"页列出 skills：来源、覆盖关系、警告、被忽略的字段。
- 场景 `tests/scenarios/skill-*.yaml`、`tests/scenarios/command-*.yaml`，能力 ID 如 `CAP-SKILL-ALLOWED-001`、`CAP-STYLE-SWITCH-001`。

## 实现要点

- `allowed-tools` 是项目配置带来的权限扩展，与项目 allow 规则同等对待：信任前不生效（第 10.2 节）。
- 内置风格、内置命令描述与 `Skill` 工具描述都是提示词，提交前做原创性自查，不与 Claude Code 的文本逐句对应。
- 模糊匹配算法前后端只用一份（命令面板与 Mod+K 共用），放进通用能力复用表。

## 验收标准

- [T37-A01] skills 发现覆盖 Pi 默认路径、`.claude/skills`、`~/.claude/skills`、`.piarc/skills` 与 PiArc 用户目录，同名按优先级取舍并在诊断中列出。验证：测试。
- [T37-A02] system prompt 只含 skills 索引（名称与截断后的描述），`disable-model-invocation` 的 skill 不在索引中。验证：mock provider 请求断言。
- [T37-A03] `Skill` 工具加载正文并完成参数替换；已调用的 skill 在压缩后按上限重新注入；skill frontmatter 中的 `hooks` 在调用后开始生效。验证：L2 场景（mock 请求断言）。
- [T37-A04] `allowed-tools` 列出的工具在调用 skill 的当前回合免审批，下一回合恢复询问，deny 与 ask 规则仍然优先。验证：L2 场景。
- [T37-A05] 未信任项目中 skill 与命令的 `allowed-tools` 不产生免审批效果，skill frontmatter 中的 `hooks` 不执行。验证：测试。
- [T37-A06] 带 `paths` 的 skill 在处理匹配文件后才进入索引，以追加消息送达。验证：L2 场景。
- [T37-A07] 斜杠命令列表合并内置命令、`.claude/commands`、Pi prompt templates 与可由用户调用的 skills，同名冲突按规则取舍；`$ARGUMENTS`、位置参数与命名参数替换正确。验证：测试。
- [T37-A08] `/compact`、`/clear`、`/model`、`/rewind`、`/context`、`/output-style` 执行对应功能。验证：L2 场景与 Playwright。
- [T37-A09] composer 命令面板按来源分组、模糊搜索并显示参数提示，输入法合成期间 `/` 不打开面板。验证：Playwright（截图存 `tmp/evidence/T37/`）。
- [T37-A10] Mod+K 命令面板可模糊搜索并执行应用操作与会话切换，快捷键修改后立即生效。验证：Playwright。
- [T37-A11] 内置与自定义输出风格可选；会话中途切换以追加消息送达，已发送的 system prompt 字节不变。验证：mock provider 请求断言与 Playwright。
- [T37-A12] skill 正文中的 `` !`command` `` 不被执行，按原文传递，诊断中标为不支持。验证：测试。
- [T37-A13] 内置风格、内置命令描述与 `Skill` 工具描述完成原创性自查。验证：报告中的自查记录。
- [T37-A14] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新 `agent-host/CLAUDE.md`：skills 与命令的发现路径、优先级、`allowed-tools` 的传递方式；更新 `crates/piarc-policy` 的 CLAUDE.md：回合级免审批的生命周期。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：模糊匹配、frontmatter 解析、参数替换。
- 在 `PLAN.md`"登记事项"中记录暂不支持的 frontmatter 字段及接手任务（`context: fork` → T48）。
