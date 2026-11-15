# 0005. 兼容 Claude Code 配置生态，PiArc 自有配置独立

- 状态：已接受
- 日期：2026-11-14
- 相关：架构文档第 6、9 章

## 背景

Claude Code 已形成事实上的配置生态：`CLAUDE.md`/`AGENTS.md` 层级与 `@import`、`.claude/settings.json` 中的 `permissions` 与 `hooks`、`.claude/agents/*.md`、`.claude/skills/*/SKILL.md`（Agent Skills 开放标准）、`.claude/commands/*.md`、`.claude/rules/`、`.mcp.json`、`.claude-plugin/plugin.json` 插件格式。开发者在这些文件上已有大量投入，Claude Code 自身也提供 `/import codex|gemini|cursor` 做跨工具迁移。

Pi 已部分兼容：读取 `CLAUDE.md`（每目录一个，不支持 `@import`）、SKILL.md 格式兼容但默认不读 `.claude/skills`、不读 `.claude/commands` 和 `.claude/agents`（Pi 调研第 4.2、4.7 节）。

## 决策

1. PiArc **读取** Claude Code 的项目级和用户级配置，语义尽量与官方文档一致：memory 文件层级与 `@import`、权限规则语法（`Tool(specifier)`，deny → ask → allow）、hooks 事件与 JSON 协议、subagent frontmatter、skills、commands、rules、`.mcp.json`、插件目录结构。具体兼容矩阵见架构文档第 6 章，每一项标注"完整 / 部分 / 不支持"，不支持的项在 UI 中明确提示。
2. PiArc 自己的配置写在 `.piarc/`（项目）和应用支持目录（用户），**不写入** `.claude/`，避免污染用户的 Claude Code 配置。"总是允许"类规则写入 `.piarc/settings.local.json`。
3. 同一概念两边都有配置时，合并顺序为：企业策略 > CLI/会话 > `.piarc/settings.local.json` > `.piarc/settings.json` > `.claude/settings.local.json` > `.claude/settings.json` > 用户级 PiArc 设置 > 用户级 `~/.claude/settings.json`。列表类键合并，deny 永远优先。
4. 兼容层受项目信任约束：项目级 hooks、MCP、权限 allow 规则、插件在信任前不生效。
5. Pi 自己的 `.pi/` 与 `~/.pi/agent/` 默认**不共享**。Agent Host 把 Pi 的 agent 目录指向 PiArc 应用支持目录（`PI_CODING_AGENT_DIR` / SDK `agentDir`），避免与用户本机的 Pi CLI 互相影响；提供一次性导入。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 只用 Pi 原生配置格式 | 实现最省 | 用户要重写全部配置，失去最大的迁移优势 | 否决 |
| 直接读写 `.claude/` | 两个工具配置完全同步 | PiArc 写入的规则会改变用户 Claude Code 的行为 | 否决写入，只读 |

## 后果

- 正面：Claude Code 用户可以零配置迁移，并且能用任意模型跑自己现有的 agents、skills、hooks。
- 负面与代价：要持续跟进 Claude Code 配置格式的变化；兼容层是长期维护成本。
- 需要配套做的事：L3 行为对齐测试覆盖兼容矩阵中的每一项。

## 重新评估的触发条件

- Claude Code 配置格式发生大规模不兼容变化；
- 行业出现被广泛采用的中立标准（如 AGENTS.md 扩展到权限与 hooks）。
