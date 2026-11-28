---
paths:
  - "docs/**/*.md"
  - "**/CLAUDE.md"
  - "**/AGENTS.md"
  - "README*.md"
---

# 文档规则（精要）

- 架构设计 `docs/architecture/ARCHITECTURE.md` 是唯一基线。改动其中已定内容先写 ADR（流程见 `docs/adr/README.md`），通过后再改正文并递增版本号、写修订记录。
- 设计增补写在 `docs/architecture/addenda/`，只补充不改基线；稳定后并入正文。
- 技术验证报告写在 `docs/spikes/`，命名 `Sxx-短标题.md`，并更新 `docs/spikes/README.md`。
- 面向用户与贡献者的文档（`README*.md`、`CONTRIBUTING.md`、`SECURITY.md`）用英文写正文，`README.zh-CN.md` 与英文版同步。
- 调研资料（`docs/research/`）是带日期的快照，引用前回到原始来源核对。
- 写作：设计文档用中文，先结论后理由，肯定句，少限定语，不写"本文将"，标题平实；中英文之间留空格；代码、命令、标识符保持原文。需要时用 `doc-craft` 技能体检。
