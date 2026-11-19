# 文档

PiArc 的设计、决策与交付文档都在这里。动手写代码前先读架构设计；要改动它，走 ADR。

| 目录 | 内容 | 什么时候读 |
|---|---|---|
| [architecture/](architecture/ARCHITECTURE.md) | 架构设计，项目唯一的架构基线；`addenda/` 放设计增补 | 开工前必读；实现任何模块前读对应章节 |
| [product/](product/REQUIREMENTS.md) | 需求规格：场景、功能与非功能需求、待决事项 | 判断做什么、做到什么程度时 |
| [adr/](adr/README.md) | 架构决策记录：流程、模板与全部决策 | 要改动架构基线时；想知道"为什么这样"时 |
| [plan/](plan/PLAN.md) | 交付计划：看板、执行协议、任务提示词、验收清单、参考源码用法 | 每个任务开工与收尾时 |
| [spikes/](spikes/README.md) | M0 技术验证的跟踪表与报告 | M0 期间；评审验证结论时 |
| [reviews/](reviews/README.md) | 阶段评审的发现与处理 | 评审任务；回顾某阶段的问题时 |
| [research/](research/README.md) | 调研快照与参考源清单 | 需要原始依据时（注意时效） |
| [engineering/](engineering/coding-standards.md) | [编码规范](engineering/coding-standards.md)、[测试规范](engineering/testing.md)、[提示词原创性检查](engineering/prompt-originality.md)、[CLAUDE.md 规范](engineering/claude-md.md) | 写任何代码前 |

## 文档约定

- 设计文档用中文；代码、命令、配置、标识符保持原文。
- 架构设计与其他文档冲突时，以架构设计和已接受的 ADR 为准；发现冲突就提 ADR 修正。
- 改动架构基线的流程：提 ADR → 通过 → 修改 `architecture/ARCHITECTURE.md` 并递增版本号 → 再改代码。
