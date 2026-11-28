# 0109. 会话运行时防止系统休眠

- 状态：已接受（用户在 2026-11-28 要求支持运行时防止系统休眠，设置里提供开关、默认开启）
- 日期：2026-11-28
- 相关：ADR-0052（托盘计数来自 Core 的 `core/activity`）、ADR-0073（桌面前端以 OpenClaudeDesktop 为参考）

## 背景

长回合常常要跑几十分钟：构建、测试、子 agent。用户离开电脑后，系统闲置睡眠会让回合停在半路，Agent Host 与模型请求一起被挂起。

三个参考实现的做法：

| 参考 | 何时持有 | 类型 | 默认 |
|---|---|---|---|
| Claude Desktop（OpenClaudeDesktop `next-4.16336.0` 的主进程 `desktop-settings.cjs`） | 有回合在进行时；另有“使用电池时也保持”（默认开）、按会话保持与 Cowork 的常驻开关 | `prevent-app-suspension` | 开 |
| PI-Desktop（`apps/desktop/electron/main/bootstrap/app-lifecycle.ts`） | 应用运行期间一直持有，与是否有任务无关；另有防止屏幕关闭 | `prevent-app-suspension` / `prevent-display-sleep` | 关 |
| ZCode（`docs/off-peak-task/decisions.md` D4） | 有任务在执行时 | `prevent-app-suspension` | 关 |

Electron 45.3.2 的 `powerSaveBlocker.start('prevent-app-suspension')` 阻止系统闲置睡眠，但不阻止显示器关闭；合盖与手动睡眠仍按系统处理。在 macOS 上，它表现为 `NoIdleSleepAssertion` 断言，`pmset -g assertions` 可以看到。

## 决策

1. **何时持有**：偏好 `power.keepAwake` 打开（默认），并且至少有一个会话处在回合中时，主进程持有一个 `prevent-app-suspension` 阻止器；回合都结束或开关关闭时立即释放，应用退出时（`will-quit`）也释放。等待审批的回合仍算在进行中。
2. **信号**：运行中的会话数只取 Core 的 `core/activity`，与托盘计数同源。主进程不订阅 `core/sessions` 自己统计。后台命令、终端和 Monitor 不单独持有阻止器：用户的交互终端可能一直开着，若算进去，电脑就永远不会睡。
3. **只防闲置睡眠**：不提供 `prevent-display-sleep`，屏幕照常关闭。合盖与手动睡眠由系统决定。
4. **设置**：通用页新增“电源”一节，开关为“运行时防止系统休眠”。偏好写在用户级 `settings.json` 的 `power.keepAwake`（Core 的 `CLIENT_KEYS` 与 `piarc_config` 的 schema 新增 `power`），托管设置可以锁定它。读到偏好之前不持有，所以保存过 `false` 的用户启动时也不会短暂持有。
5. **实现**：`apps/desktop/src/main/platform/keep-awake.ts` 的 `KeepAwake` 按“开关 × 运行数”计算是否该持有，Electron 调用经 `PowerBlocker` 端口注入，便于测试。系统拒绝创建阻止器时只记日志，回合照常进行。开发构建的测试钩子 `keepAwake()` 返回当前是否持有。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 应用运行期间一直持有（PI-Desktop） | 实现最简单 | 没有工作时也不睡，耗电，与“运行时”的需求不符 | 不采用 |
| 后台任务也计入 | 长构建转后台后也不睡 | 交互终端会让电脑一直不睡 | 不采用；需要时再按任务类型细分 |
| 增加“使用电池时也保持”开关 | 笔记本用户可以省电 | 官方默认开，与不加开关的效果相同；先保持一个开关 | 暂不加 |
| 防止屏幕关闭 | 屏幕常亮 | 智能体工作不需要屏幕；更耗电 | 不采用 |

## 保留的风险

- 笔记本使用电池时同样保持唤醒，长回合会多耗电，用户可以在设置里关掉。
- 等待审批的回合也会让电脑保持唤醒，直到用户回来处理或回合结束。
