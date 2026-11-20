# 阶段评审

评审任务（R1–R6）是阶段门，结论决定能否进入下一阶段。每次评审的发现与处理写在本目录：

| 评审 | 阶段门 | 发现记录 | 结论 |
|---|---|---|---|
| R1 | M0 → M1 | [`R1-findings.md`](R1-findings.md)（另见 [`docs/spikes/M0-summary.md`](../spikes/M0-summary.md)） | **有条件进入 M1**（2026-11-16）：没有不通过的验证项，没有触发 ADR 的重新评估；48 条审查发现中 12 个缺陷已修复，其余登记 I50–I61；前提条件与检查时间点见 M0 总结第 9 节 |
| R2 | M1（macOS）达标 | [R2-findings.md](R2-findings.md) | **macOS 达标，可进入 M2**（2026-11-19）。双协议工作流、真实百炼与 61 个 macOS L2 场景通过，Windows 实机检查见 W1 清单。 |
| R3 | M2（macOS）达标 | [R3-findings.md](R3-findings.md) | **macOS 达标，可进入 M3**（2026-11-20）。M2 能力 46 项全部有 L2 场景，L3 对 Claude Code 2.1.318 的权限与 hooks 场景 0 个未解释差异；四个独立审查的 40 条发现中修复 16 项缺陷，用户确认的 ADR-0047 已实现，其余登记 I120–I128；Windows 由 W2 验收（含 W1 遗留的 UNC）。 |
| R4 | M3 达标 | `R4-findings.md` | 未开始 |
| R5 | M4 达标 | `R5-findings.md` | 未开始 |
| R6 | 公开 Beta | `R6-findings.md` | 未开始 |

Windows 达标任务（W0–W4）的报告也放在本目录，命名 `Wn-windows-<短标题>.md`，例如 `W1-windows-m1-parity.md`。

- W1：[`W1-windows-m1-parity.md`](W1-windows-m1-parity.md)：**M1 在 Windows 11 x64 达标**（2026-11-19），UNC 共享未能在本机验证（I96）；修复 10 个 Windows 平台缺陷，ADR-0040、0041 给出 Windows 的两项预算口径。

每条发现记录：编号、维度、文件与行号、失败场景、核实结论（确认 / 不同意及理由）、处理（已修复的提交 / 登记事项编号 / ADR）。
