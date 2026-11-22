## 改动

<!-- 一两句话说明改了什么、为什么。关联的任务编号（Txx）或登记事项（Ixx）。 -->

## 检查项

- [ ] <!-- source-and-license --> 来源与许可证：新增代码若参考了外部项目，已写明来源（仓库、路径、版本）与许可证；没有复制 `reference/claude-code`、`reference/OpenClaudeDesktop` 的代码、提示词或界面组件（ADR-0006）
- [ ] <!-- dependency-review --> 新增依赖已评审：写明用途与替代方案，许可证在白名单内，精确锁定版本（npm 不用 `^`、`~`；Cargo 只在 `[workspace.dependencies]` 声明），`npm run audit:deps` 没有未处理的高危与严重问题；没有新增依赖时勾选
- [ ] <!-- threat-map --> 新增或改变的安全对策已登记到 `tests/security/threats.yaml`，测试名带威胁编号（`docs/engineering/testing.md` 第 16 节）；不涉及安全对策时勾选
- [ ] `npm run verify` 通过
