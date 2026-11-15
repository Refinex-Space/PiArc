# T21 模型、服务商与凭据设置

| 项 | 内容 |
|---|---|
| 阶段 | 2 M1 可行走骨架 |
| 依赖 | T20 |
| 执行平台 | macOS（CI 同时覆盖 Windows；Windows 凭据管理器实测在 W1） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 大 |
| 关联验证项 | 无 |
| 关联需求 | FR-MD-01、FR-MD-03、NFR-05 |
| 需要的用户决定 | 无（用真实服务商测试前需征得用户同意费用） |

启动方式：在仓库根目录开新会话，输入 `/task T21`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

多模型是 PiArc 相对 Claude Code 的核心差异（架构第 1.1 节）。T08 建好了凭据保险箱与 Pi `CredentialStore` 适配，但用户还没有地方配置服务商，模型也只能用 mock。本任务做出服务商配置、模型目录与能力表、统一的 effort 档位、会话内切换模型与 effort（切换前显示代价），以及设置窗口的"模型与服务商"页。

合规红线在本任务落地（ADR-0006）：Anthropic 的订阅 OAuth 登录必须保持屏蔽，并有 CI 测试防止 Pi 升级后重新暴露。

完成后，用户可以配置至少两家服务商并在会话中切换，凭据只存在保险箱中。

## 必读

1. 架构设计：
   - 第 2.2 节最后一条（订阅 OAuth 伪装）
   - 第 5.2 节 `providers/` 目录、第 5.4 节"凭据与登录"、第 5.5 节
   - 第 6.13 节"多模型适配"
   - 第 8.2 节"环境栏""设置"两条、第 9.1 节凭据保险箱一条
2. ADR-0006、ADR-0018 第 5 条。
3. `docs/research/pi-v1.4.0-baseline.md` 第 2.2 节"Provider 与认证"、第 2.3 节"模型目录"、第 2.4 节"缓存与 thinking 参数如何统一"、第 2.5 节、第 2.6 节"跨 provider 切换时的消息转换"。
4. `docs/research/claude-official-capabilities.md` C 节 Effort、Preserved thinking、Prompt caching 三行。
5. T08、T14、T18、T19 交付的代码与 CLAUDE.md：保险箱与 `secrets/*`、`session/setModel`、设置页注册、composer 附件流程。
6. 实现时查阅：pi-ai 锁定版本的 `Model` 字段、`thinkingLevelMap` 与 `clampThinkingLevel`、自定义 provider 与 `models.json` 格式、OAuth 登录方式的注册与枚举、Anthropic provider 判定订阅凭据的逻辑。

## 范围

### 要做

- 服务商配置：API key、云厂商凭证（Bedrock、Vertex 等 pi-ai 支持的方式）、OpenAI 兼容端点、本地模型；凭据经保险箱。
- 模型列表（pi-ai 模型目录 + PiArc 覆盖）与模型能力表。
- effort 统一档位与映射；会话内切换模型与 effort，切换前显示代价。
- 屏蔽 Anthropic 订阅 OAuth 与 CI 测试；不支持视觉的模型拒绝图片附件。
- 设置窗口"模型与服务商"页；环境栏的模型菜单与 effort 子菜单。

### 不做

- OAuth 与设备码登录流程、每模型设置（显示名、上下文窗口、图片输入、默认 effort）（T29）。
- 模型别名（T31）、用量与成本统计界面（T41）、PreModelSwitch hook（T48）。

## 交付物

### 1. 服务商配置

- 支持的配置类型：API key（pi-ai 内置服务商）、云厂商凭证（按 pi-ai 支持的认证方式提供字段）、OpenAI 兼容端点（base URL、可选 key、模型列表）、本地模型（按 OpenAI 兼容端点配置，可无 key）。
- 密钥类字段只经 `secrets/*` 写入保险箱；非密钥字段（区域、项目、base URL）写入用户级设置，自定义端点由 Core 生成 `pi/models.json`（第 9.1 节）。
- `pi/` 下不出现 `auth.json`；Agent Host 的环境变量中不出现任何凭据（第 5.4 节）。
- 设置页增、改、删服务商；删除时同时删除保险箱中的对应条目。

### 2. 模型目录与能力表

- 模型列表来自 pi-ai 模型目录，叠加 PiArc 覆盖配置（`agent-host/src/providers/`）。
- 能力表字段：上下文窗口、最大输出、视觉、工具调用可靠性等级、支持的 thinking / effort 档位、prompt cache 支持（第 6.13 节）。来源与覆盖规则写进 `agent-host/CLAUDE.md`。
- 能力表经 AHP（`models/list`）交给 Core 与客户端。

- 模型目录刷新是否联网由设置控制（架构第 5.5 节）：默认按 pi-ai 的策略刷新，用户可关闭；关闭后只用本地缓存的目录，不发出刷新请求。

### 3. effort

- UI 档位 off / low / medium / high / xhigh / max，映射到 Pi 的 thinking level（off、low、medium、high、xhigh、max；不使用 minimal）。
- 只显示当前模型支持的档位（依据 `thinkingLevelMap`）；不依赖 pi-ai 的就近取档悄悄改变用户的选择。

### 4. 切换模型与 effort

- 环境栏模型菜单（Mod+Shift+I）与 effort 子菜单（Mod+Shift+E），注册到 T18 的快捷键注册表；经 `session/setModel`、`session/setEffort` 生效。
- 切换模型前显示代价：当前上下文 token 数、prompt cache 将失效、按新模型价格估算的缓存写入成本、是否会丢弃 thinking 块（依据 pi-ai 跨服务商消息转换规则）。用户确认后切换，切换写入会话 entry。

### 5. 合规与降级

- Anthropic 订阅 OAuth 登录方式在 Agent Host 中屏蔽：可用登录方式列表不包含它，调用它返回结构化错误。
- 核实 pi-ai 是否会依据凭据格式或 `ANTHROPIC_OAUTH_TOKEN`、`ANTHROPIC_AUTH_TOKEN` 进入订阅请求路径；会的话，设置页拒绝这类凭据，Agent Host 侧再拦截一次，并加测试。
- CI 测试：断言可用登录方式不含 Anthropic 订阅 OAuth；Pi 升级后该测试失败即阻断合并。
- 当前模型不支持视觉时，composer 拒绝图片附件并说明原因；已在排队中的图片输入在发送前被拦下并提示。

## 实现要点

- 服务商测试用 T05 的 mock provider，以两种线格式各配置一个"服务商"（Anthropic Messages 形态与 OpenAI 兼容端点），走与真实服务商相同的配置路径。
- 真实服务商是可选验证：先向用户说明预计调用次数与模型，征得同意后只用最便宜够用的模型跑一轮对话；本机已有本地模型时可以优先用它（无费用）。用户不同意时在验收证据中注明"仅 mock"。
- 凭据扫描测试覆盖：数据目录全部文件、日志、`pi/` 目录、Agent Host 进程环境；扫描用测试中写入的已知假凭据作为特征。
- 代价估算的价格来自 pi-ai 模型目录的 cost 字段；没有价格时显示"未知"，不显示 0。

## 验收标准

- [T21-A01] 经设置页配置两个服务商（Anthropic Messages 形态与 OpenAI 兼容端点的 mock）后，各完成一轮带工具调用的对话；真实服务商在用户同意后补测，未同意时注明。验证：Playwright 流程与 mock provider 请求断言。
- [T21-A02] API key、云厂商凭证、OpenAI 兼容端点、本地模型四种配置都能保存、编辑、删除，非法配置给出字段级错误。验证：测试与截图（`tmp/evidence/T21/`）。
- [T21-A03] 用已知假凭据配置后扫描数据目录、日志、`pi/` 与 Agent Host 进程环境，只在保险箱密文中找到它（明文零命中）；删除服务商后保险箱条目同时删除。验证：扫描测试。
- [T21-A04] 能力表由 pi-ai 目录与 PiArc 覆盖合并而成，覆盖项生效。验证：单测。
- [T21-A05] effort 菜单只显示当前模型支持的档位，各档位映射到正确的 Pi thinking level。验证：单测与 mock provider 请求断言。
- [T21-A06] 切换模型前的代价提示中，上下文 token 数、缓存写入成本估算、thinking 块丢弃标记与夹具数据计算结果一致；没有价格时显示"未知"。验证：单测。
- [T21-A07] 确认切换后，下一次请求使用新模型与新 effort 参数，切换记录在会话 entry 中，恢复会话后保持。验证：场景测试与 mock provider 请求断言。
- [T21-A08] 可用登录方式列表不含 Anthropic 订阅 OAuth，直接调用返回结构化错误；订阅类凭据被设置页与 Agent Host 拒绝（若 pi-ai 存在该路径）。验证：CI 中运行的测试。
- [T21-A09] 当前模型不支持视觉时，图片附件被拒绝并显示原因，模型请求中没有图片内容。验证：测试与 Playwright 流程。
- [T21-A10] 关闭"联网刷新模型目录"后，启动与切换模型都不发出目录刷新请求，模型列表来自本地缓存；重新打开后恢复刷新。验证：测试（拦截网络请求并断言）。
- [T21-A11] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新 `agent-host/CLAUDE.md`：能力表来源与覆盖、effort 映射、订阅 OAuth 屏蔽的位置与测试名。
- 在架构第 6.13 节补充能力表的实际字段与覆盖规则（补充型更新）。
