# T41 配置诊断完善、M4 hooks 事件与用量成本

| 项 | 内容 |
|---|---|
| 阶段 | 5 M4 安全与打磨 |
| 依赖 | T40 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 中 |
| 关联验证项 | 无 |
| 关联需求 | FR-EX-05、FR-HN-05（M4 部分）、FR-MD-06 |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T41`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

三项相互独立的补全：

- **配置诊断**：T24 的基础版只覆盖设置文件。T31–T40 之后，配置来源多了 MCP、memory、rules、agents、skills、commands、插件与 Pi 包。迁移用户（需求场景 S7）要靠诊断页回答"这项配置为什么生效 / 没生效"，所以诊断必须覆盖全部来源。
- **M4 hooks**：第 6.3.2 节的 M4 事件与 `mcp_tool` handler，补完 FR-HN-05 的 M4 部分。
- **用量与成本**：按会话、按模型统计 token 与成本，价格表可配置（FR-MD-06）。

完成后，诊断页能列出每个来源的加载状态与键的去向；六个 M4 事件和 `mcp_tool` handler 都有场景覆盖；会话右栏与"用量"页显示 token 与成本。

## 必读

1. 架构设计：
   - 第 6.14 节"Claude Code 配置兼容矩阵"与其后的配置诊断说明
   - 第 6.3 节"Hooks"全部
   - 第 6.6.2 节（memory 与 rules 的加载时机，对应 InstructionsLoaded）、第 6.11 节（`cd` 保留，对应 CwdChanged）
   - 第 6.6.5 节、第 6.13 节、第 8.2 节（设置窗口与右栏）、第 9.2 节（`sessions` 的用量累计）
2. ADR-0005。
3. 需求规格 FR-EX-05、FR-HN-05、FR-MD-06，第 3 节场景 S7。
4. `docs/research/claude-official-capabilities.md` A2.3、A3.1、A3.3（第 3、5、19、21、22、24 行）、A3.4；`docs/research/pi-v1.4.0-baseline.md` 第 2.3、2.5 节。
5. T24（诊断基础版）、T25 与 T38（hooks）、T36（MCP）、T40（插件）交付的代码与 CLAUDE.md。
6. 实现时查阅：
   - pi-ai 锁定版本的 `Usage` 类型、`calculateCost`、模型的 `cost` 字段；
   - Pi 锁定版本中回合因 API 错误结束时的事件与错误类型；
   - notify crate 的 API（FileChanged 的监视）。

## 范围

### 要做

- 配置诊断完整版（全部来源、插件来源、企业来源预留）与设置页。
- M4 hooks 事件：UserPromptExpansion、InstructionsLoaded、CwdChanged、FileChanged、ConfigChange、StopFailure；`mcp_tool` handler。
- 用量与成本统计、价格表配置与界面。

### 不做

- 企业来源的读取（T47）：诊断中只留位置，显示"未配置"。
- M5 hooks 事件（T48）、`agent` handler（第 6.3.2 节未排期）。

## 交付物

### 1. 配置诊断完整版

- 来源：PiArc 用户设置、`.piarc/settings.json`、`.piarc/settings.local.json`、`.claude/settings.json`、`.claude/settings.local.json`、`~/.claude/settings.json`、`~/.claude.json`（MCP 段）、`.mcp.json`、memory 文件（含 `@import`）、`.claude/rules`、agents、skills、commands、输出风格、每个已启用插件与 Pi 包的组件、企业来源（预留）。
- 每个来源：路径、作用域、加载状态（已加载 / 不存在 / 解析错误 / 未信任未生效 / 本平台不生效 / 已忽略）、生效的键、被覆盖的键（标明覆盖它的来源）、被忽略的键（附原因）、解析错误的位置（行列）。
- 配置在会话中变化时（T13 的监听），诊断结果自动刷新。
- 复用 T24 的数据结构扩展来源类型，不另建一套。Core 提供诊断 API，设置窗口"配置诊断"页展示，文案中英文。

### 2. M4 hooks 事件

| 事件 | 挂载点 | matcher | 决策与输出 |
|---|---|---|---|
| UserPromptExpansion | 斜杠命令、skill、MCP prompt 展开为输入之前（T37、T40） | 命令名 | exit 2 或 `decision: "block"` 阻止展开，理由显示给用户；纯文本 stdout 作为上下文 |
| InstructionsLoaded | memory 文件或 rules 注入时（会话开始、子目录懒加载、`paths` 匹配、`@import`、压缩后重注入） | 加载原因 | 无决策 |
| CwdChanged | Bash 的 `cd` 改变持久 cwd 时（T17） | 无 | `watchPaths`、`systemMessage` |
| FileChanged | 被监视的文件在磁盘上变化（piarc-fs 的 notify 封装） | 字面文件名 | `watchPaths`、`systemMessage` |
| ConfigChange | 会话中配置文件变化（T13 的监听） | 来源 | `decision: "block"` 时该变更不在当前会话生效；企业来源不可阻断 |
| StopFailure | 回合因 API 错误结束（重试用尽之后） | 错误类型 | 输出被忽略 |

- 输入与输出字段名与 Claude Code 一致（A3.3），PiArc 不提供的字段列在 piarc-hooks 的 CLAUDE.md 中。
- `watchPaths`：每个会话维护动态监视列表，由 SessionStart、CwdChanged、FileChanged 的输出替换；列表长度设上限，超限部分丢弃并记录。
- StopFailure 的错误类型映射表集中定义（pi-ai / Pi 错误 → `rate_limit`、`overloaded`、`authentication_failed`、`server_error`、`max_output_tokens` 等），未识别的归为 `unknown`。

### 3. `mcp_tool` handler

- 配置字段：`server`、`tool`、`input`，`input` 中的 `${...}` 按 hook 输入替换（如 `${tool_input.file_path}`）。适用的事件范围以 A3.1 为准。
- hooks 在 Core 中执行，MCP 连接在 Agent Host 的连接池中：新增 Core → Agent Host 的 AHP 请求调用工具（补充型），schema 与 L1 golden 样本一并提交。
- 返回文本等同 command handler 的 stdout，按同一决策协议解析；默认超时 600 秒；server 未连接（含项目未信任）、超时或调用出错按非阻断错误处理并记录。

### 4. 用量与成本

- 数据：每次模型请求的 input、output、cacheRead、cacheWrite（及 reasoning，有则记录）来自 Pi 的用量数据，Core 按会话、按模型汇总存 SQLite，可从 JSONL 重建。子 agent 的用量计入父会话并单独列出；辅助模型调用（如 WebFetch 的提取，T29）单独归类计入。
- 价格表：默认取 pi-ai 模型目录的 `cost`，用户可在设置中按 `provider/model` 覆盖各类单价（美元 / 百万 token）。价格未知的模型显示"未知"，不按 0 计。
- 计算：成本 = 各类 token 数 × 当前生效价格表单价，界面标注"估算"。用整数（如微美元）或十进制计算，不用浮点累加；对目录价的计算结果与 pi-ai `calculateCost` 一致。
- 界面：会话右栏显示本会话 token 与成本；设置窗口"用量"页按模型汇总、按会话列出。文案中英文；Playwright 用例与亮/暗截图放在 `tmp/evidence/T41/`。

## 实现要点

- 诊断的"被覆盖"要能追到具体来源：合并时保留每个键的来源链，不在合并后丢掉。
- M4 事件的挂载点分属 Core 与 Harness Kit，决策统一经 `hooks/run` 回到 Core 合并，不在 Agent Host 内做决策合并。
- ConfigChange 被阻断时只影响当前会话；文件本身不回滚，诊断页标明"本会话未应用"。
- 每个事件与 `mcp_tool` 场景登记能力 ID，例如 `CAP-HOOK-CONFIGCHANGE-001`、`CAP-HOOK-MCPTOOL-001`。

## 验收标准

- [T41-A01] 配置诊断列出交付物 1 中的全部来源，每个来源显示加载状态、生效键、被覆盖键（标明覆盖来源）、忽略键（附原因）与解析错误位置。验证：测试（每类来源一个夹具）。
- [T41-A02] 未信任项目的可执行配置在诊断中标为"未信任，未生效"；企业来源显示为预留且"未配置"。验证：测试。
- [T41-A03] 配置文件在会话中变化后，诊断结果自动刷新，不需要重开设置窗口。验证：测试。
- [T41-A04] 诊断页展示上述信息，中英文文案完整。验证：Playwright 与亮/暗截图（`tmp/evidence/T41/`）。
- [T41-A05] 六个 M4 事件各有一个场景，覆盖 matcher、该事件的输入字段与 JSON 输出字段。验证：L2 场景（能力 ID 已登记）。
- [T41-A06] UserPromptExpansion 以 exit 2 或 `decision: "block"` 阻止展开且理由显示给用户；ConfigChange 阻断后该变更不在当前会话生效，企业来源的变更不可阻断。验证：L2 场景。
- [T41-A07] FileChanged 按 SessionStart 与 CwdChanged 返回的 `watchPaths` 监视文件，文件变化后 hook 执行且 `systemMessage` 送达；超出监视上限的路径被丢弃并记录。验证：L2 场景。
- [T41-A08] mock provider 注入 429、529、5xx、鉴权失败且重试用尽后触发 StopFailure，错误类型映射正确，hook 输出不改变回合结果。验证：L2 场景。
- [T41-A09] `mcp_tool` handler 调用已连接 MCP server 的工具，`input` 模板替换正确，返回文本按决策协议解析；server 未连接或超时按非阻断错误处理。验证：L2 场景（mock MCP server）与新增 AHP 请求的 L1 样本。
- [T41-A10] 会话与模型的成本等于各请求 token 数乘以价格表单价之和（含缓存读写），对目录价与 pi-ai `calculateCost` 的结果一致；子 agent 用量计入父会话并单独列出。验证：测试。
- [T41-A11] 用户覆盖价格后成本按新价格计算；价格未知的模型显示"未知"而不是 0。验证：测试。
- [T41-A12] 会话右栏与"用量"页按会话、按模型显示 token 与成本。验证：Playwright 与截图。
- [T41-A13] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新 `crates/piarc-hooks` 的 CLAUDE.md：M4 事件的挂载点、`watchPaths` 规则、StopFailure 映射表位置、`mcp_tool` 的执行路径。
- 更新 `crates/piarc-config` 的 CLAUDE.md：诊断的来源类型与来源链。
- 更新架构第 6.3.2 节（M4 行标注已实现）与第 6.14 节的诊断说明。
