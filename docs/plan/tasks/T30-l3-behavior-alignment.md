# T30 L3 行为对齐基座

| 项 | 内容 |
|---|---|
| 阶段 | 3 M2 Harness 核心 |
| 依赖 | T29 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 中 |
| 关联验证项 | 无 |
| 关联需求 | 无 |
| 需要的用户决定 | 本机需要 Claude Code CLI（`claude`）。没有时请用户安装；全局安装须先征得同意 |

启动方式：在仓库根目录开新会话，输入 `/task T30`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

L2 场景证明 PiArc 的行为符合我们写下的期望；L3 检查这些期望本身是否与 Claude Code 一致。做法是黑盒观察（ADR-0006 第 3 条）：同一个严格 mock provider 同时服务 PiArc 和真实的 `claude -p`，记录双方发出的请求结构与行为轨迹，归一化后做结构化比对。只比对结构，任何 Claude Code 的提示词或工具描述文本都不落盘。

本任务建立这套基座，先覆盖权限（T23）与 hooks（T25）场景，这也是 M2 退出标准的一部分（第 16 章）。

完成后，一条命令完成录制与比对；权限与 hooks 场景的每个差异要么已修正，要么在 `tests/l3-allowlist.yaml` 中写明有意偏离的理由。

## 必读

1. 架构设计：第 12.1 节 L3 一行、第 12.2–12.5 节、第 13.3 节 Nightly 一行。
2. ADR-0005（"L3 覆盖兼容矩阵"）、ADR-0006。
3. `docs/research/harness-reference-notes.md` 第 2.3 节；`docs/research/claude-official-capabilities.md` A9（headless 与 `--permission-prompt-tool`）、A2、A3。
4. T05、T15、T23、T24、T25 交付的代码与 CLAUDE.md：mock provider 的校验与请求记录、场景运行器与 YAML 格式、权限与 hooks 场景、`.claude/settings.json` 的兼容读取。
5. 实现时查阅（以本机 `claude --version` 对应的官方文档为准）：`--output-format stream-json` 的消息结构、`ANTHROPIC_BASE_URL`、配置目录隔离、关闭非必要网络流量的环境变量、`--permission-prompt-tool` 的用法。

## 范围

### 要做

- 前提检查与 Claude Code 的隔离运行方式。
- mock provider 的 L3 录制模式、双侧运行器、归一化、结构化 diff、报告。
- `tests/l3-allowlist.yaml` 及其校验；提示词剥离检查脚本。
- 一条命令完成全流程；Nightly workflow。
- 权限与 hooks 场景的首批比对，修正 PiArc 侧确认的偏差。

### 不做

- 其他能力（memory、rules、plan、压缩等）的 L3 覆盖：框架支持即可，覆盖随后续任务增加。
- 调用任何真实模型服务商；使用用户的 Claude 账号或订阅。

## 交付物

### 1. 前提与隔离

- 检查 `claude` 是否在 PATH 中并记录版本。不存在时停止依赖它的部分，提醒用户安装（全局安装须同意），先完成归一化、diff、allowlist 校验、检查脚本这些不依赖它的部分。
- Claude Code 的每次运行：临时配置目录（官方文档给出的环境变量）、假的 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 指向 mock、关闭非必要网络流量、工作目录为场景夹具的临时副本。不读取也不修改本机的 `~/.claude` 与登录状态。
- 场景夹具中的 `.claude/settings.json` 同时驱动两侧：Claude Code 原生读取，PiArc 经 T24 的兼容层读取。
- 审批应答：`-p` 模式没有交互审批，用 `--permission-prompt-tool` 指向一个测试夹具 MCP server，按场景的审批应答序列作答。无法这样复现的场景列入排除清单并写明原因。

### 2. 录制

- mock 的 L3 模式保留协议合法性校验（配对、角色交替、schema），关闭 PiArc 特有的 system 段校验。
- 录制器只写白名单结构，原始请求体不落盘、不进日志：
  - 工具列表：名称与参数 schema，所有 `description` 字段删除，只留长度与 hash；
  - system：段数，以及每段的长度与 hash 指纹；
  - 消息：角色与内容块类型序列、缓存断点位置；`tool_use` 的工具名与归一化参数；`tool_result` 的错误标记与长度。
- Claude Code 可能发出主循环以外的辅助请求，录制器按请求特征分类，只比对主循环请求；分类规则写进文档。
- 行为轨迹：把 Claude Code 的 stream-json 输出与 PiArc 的 AHP 事件归一化为同一格式——有序的工具调用（规范名、归一化参数）、权限结果（允许、拒绝、询问及应答）、hooks 调用、最终状态。hooks 由夹具脚本记录事件名、输入字段名集合与返回的决策。

### 3. 归一化与比对

- 去掉 id、时间戳；绝对路径替换为 `<WS>`、`<HOME>`、`<TMP>` 等占位，统一路径分隔符；工具名按规范名映射。
- 按场景、按字段路径做结构化 diff，输出 Markdown 报告与 JSON 结果（写在 `tmp/l3/`，不入库）；存在未解释差异时非 0 退出。

### 4. allowlist

- `tests/l3-allowlist.yaml` 每条记录：场景、差异的字段路径、适用的 Claude Code 版本范围、理由（必填），以及排除清单（不参与比对的场景与原因）。
- 校验：缺理由的条目、已不再匹配任何差异的条目都让命令失败。

### 5. 提示词剥离检查

- 检查脚本（Node，跨平台，例如 `scripts/l3/check-recordings.mjs`）：按白名单 schema 校验录制产物，并扫描所有字符串值，超过长度阈值的自然语言文本一律报错。每次录制后自动运行。
- 脚本自带单测：一个故意带提示词正文的夹具必须失败，正常录制必须通过；单测并入 `npm run verify`。

### 6. 一条命令与 Nightly

- 根 `package.json` 新增一条命令（例如 `npm run l3`）：前提检查 → PiArc 侧运行 → Claude Code 侧运行 → 剥离检查 → 归一化 → 比对 → 报告。
- Nightly workflow：独立于 PR CI；安装锁定版本的 Claude Code（包名与安装方式按官方文档），使用假 key，不需要任何密钥；报告作为产物上传。

## 实现要点

- 比对出的差异逐条分析：PiArc 的偏差先写能复现的失败场景再修正；有意的偏离（例如 PiArc 的多模型 Tool Profile、不支持的 `defer`）写入 allowlist。
- 同一侧重复运行两次的轨迹必须一致，否则先消除不确定性（排序、并发顺序），再比对两侧。
- Claude Code 升级会带来新差异：报告首行写明两侧版本，allowlist 条目按版本范围生效。

## 验收标准

- [T30-A01] 本机 `claude` 可用时版本写入报告；PATH 中没有 `claude` 时 L3 命令给出明确提示并以非 0 退出。验证：两次运行的命令输出。
- [T30-A02] 一条命令完成两侧运行、剥离检查、归一化、比对并生成报告。验证：命令输出与 `tmp/l3/` 下的报告。
- [T30-A03] Claude Code 运行使用临时配置目录、假 API key 与指向 mock 的 base URL；运行前后本机 `~/.claude` 的文件清单与修改时间不变。验证：命令输出与前后比对结果。
- [T30-A04] 录制产物只含白名单结构，system 文本、工具描述与参数描述只以长度与 hash 出现。验证：检查脚本对本次录制的输出。
- [T30-A05] 检查脚本对带提示词正文的夹具失败、对正常录制通过，其单测已并入 verify。验证：测试输出。
- [T30-A06] 同一侧重复运行两次，归一化后的轨迹完全一致。验证：两次运行的 diff 为空。
- [T30-A07] hooks 场景的比对覆盖触发事件的顺序、输入字段名集合与决策结果。验证：报告中的 hooks 部分。
- [T30-A08] 权限与 hooks 场景没有未解释的差异：每个差异已修正或写入 allowlist 并附理由；缺理由或不再匹配的 allowlist 条目会让命令失败。验证：L3 报告与 allowlist 校验输出。
- [T30-A09] Nightly workflow 语法有效，安装锁定版本的 Claude Code，不依赖任何密钥，并上传报告。验证：actionlint 或 YAML 解析输出与 workflow 内容。
- [T30-A10] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 在 `docs/engineering/testing.md` 中补充 L3 一节：运行命令、隔离方式、allowlist 规则、剥离检查、如何新增场景。
- 在 `PLAN.md`"登记事项"中列出 allowlist 中需要后续任务处理的偏离。
