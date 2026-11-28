# 0006. 合规红线：禁用 Claude 订阅登录、clean-room、自有品牌

- 状态：已接受（第 3、4 条的前端对标范围及视觉复刻的备选结论由 [ADR-0073](0073-settings-segmented-control-reference.md) 修订；第 4 条的 logo 限制由 [ADR-0107](0107-provider-brand-marks.md) 修订：标识 Anthropic 服务商时可以显示它的标记）
- 日期：2026-11-14
- 相关：架构文档第 10 章；`docs/research/REFERENCES.md`

## 背景

1. Anthropic 官方明确禁止第三方应用提供 Claude.ai 登录、用用户的 Free/Pro/Max/Ultra 订阅凭证代发请求、或收集/中转 Claude.ai 凭据；第三方产品应使用 API key 或云厂商凭证。唯一例外是在产品中运行**未修改的** Claude Code 二进制，由用户在其中走 Anthropic 自己的登录流程。产品不得称为 "Claude Code"。来源：https://code.claude.com/docs/en/legal-and-compliance 、https://code.claude.com/docs/en/agent-sdk/overview （2026-11-14 抓取）。
2. Pi 的 pi-ai 在使用 Claude Pro/Max OAuth 时会伪装成 Claude Code：`user-agent` 写成 `claude-cli/…`，注入 "You are Claude Code…"，工具名改写为 Claude Code 风格（`reference/pi/packages/ai/src/providers/anthropic-messages.ts:95-130,1048-1063,1227-1244`，Pi 调研已复核）。
3. 参考源 `reference/claude-code` 复原的是 Anthropic 专有产品，仓库无 LICENSE；`reference/OpenClaudeDesktop` 的 `app/src/generated/` 是从官方应用切出的组件；`reference/open-claude-ui` 还原了 Claude 的品牌视觉。

## 决策

1. **PiArc 不提供、不启用任何 Claude 订阅登录路径。** Agent Host 在 `ModelRuntime` 中屏蔽 Anthropic 的 OAuth 登录方式；Anthropic 模型只接受 API key、Amazon Bedrock、Google Vertex AI、Microsoft Foundry 等云凭证或用户自配网关。CI 中加检查，防止 Pi 升级后该路径被重新暴露。
2. "驱动未修改的 Claude Code 二进制作为外部内核"列为 P2 候选能力，实施前必须单独做法务评审，不在第一版范围内。
3. **clean-room。** PiArc 的代码、系统提示词、工具描述、UI 文案全部自行编写。允许研读参考源以理解行为和交互，禁止复制其源码、提示词原文和资产。行为对齐通过黑盒观察实现（架构文档第 12 章 L3 测试：对真实 Claude Code 录制请求和事件结构，只比对结构，不拷贝文本）。
4. **自有品牌。** 不使用 Anthropic 的 logo、专有字体、提示音、标志性品牌色和整体视觉识别；产品名、功能名不含 "Claude"。描述兼容性时可以写"兼容 Claude Code 配置格式"。
5. MIT 许可的参考源（pi、claw-code、open-claude-ui 中作者原创部分）按许可证复用，保留版权声明，PR 中注明来源。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 沿用 Pi 的 Claude 订阅 OAuth | 用户可以用订阅额度，获客容易 | 违反 Anthropic 条款，且伴随身份伪装，账号封禁和法律风险直接落在用户和我们身上 | 否决 |
| 复刻 Claude Desktop 视觉 | 用户迁移零学习成本 | 商标与 trade dress 风险 | 否决，只对标交互能力 |

## 后果

- 正面：商业模式不建立在灰色地带上；可以公开发布和推广。
- 负面与代价：只有 Claude 订阅、没有 API key 的用户无法在 PiArc 中直接使用 Claude 模型；这部分用户可以选择其他服务商。
- 需要配套做的事：上手流程中清楚说明各服务商支持的凭证类型；PR 模板加入"来源与许可证"检查项。

## 重新评估的触发条件

- Anthropic 修改第三方集成条款，或为第三方应用提供官方授权的订阅接入方式；
- 决定推进"外部 Claude Code 内核"能力（需法务结论）。
