---
paths:
  - "docs/**/*.md"
  - "**/CLAUDE.md"
  - "**/AGENTS.md"
  - "README*.md"
---

# 文档规则（精要）

- 架构设计 `docs/architecture/ARCHITECTURE.md` 是唯一基线。改动其中已定内容先写 ADR（流程见 `docs/adr/README.md`），通过后再改正文并递增版本号、写修订记录。
- 设计增补写在 `docs/architecture/addenda/`，只补充不改基线；由评审任务并入正文。
- M0 验证报告写在 `docs/spikes/`，命名 `Sxx-短标题.md`，并更新 `docs/spikes/README.md`；评审发现写在 `docs/reviews/Rn-findings.md`。
- `docs/plan/acceptance.json`：只能改本任务验收项的 `status` 与 `evidence`；禁止删除或改写描述。
- `docs/plan/PLAN.md`：任务开工与收尾时按 `docs/plan/protocol.md` 更新看板、检查点、登记事项、会话日志。
- 调研资料（`docs/research/`）是带日期的快照，引用前回到原始来源核对。
- 写作：设计文档用中文，先结论后理由，肯定句，少限定语，不写"本文将"，标题平实；中英文之间留空格；代码、命令、标识符保持原文。需要时用 `doc-craft` 技能体检。
