# 0086. 提交信息生成（补充）

- 状态：已接受，补充 ADR-0045（辅助模型）、ADR-0070（会话级一次性请求）
- 日期：2026-11-25
- 相关：ADR-0084、0085；架构第 5.1、7.4、7.6 节；[设计增补](../architecture/addenda/git-panel.md)

## 背景

提交视图要能根据已暂存的内容生成提交信息，语言跟随界面语言（中文界面写中文描述，英文界面写英文），并遵循设置里的提交指令。辅助模型通道 `harness/auxiliary.ts` 要求会话已打开；现有的 Core → Agent Host 一次性调用 `hooks/prompt` 用于评判 hook，提示词由 Core 拼装，Agent Host 未运行时直接失败。界面语言只在主进程可知（`PreferenceStore.locale()`），Core、Agent Host 与 AHP 都没有 locale。

## 决策

1. **会话级 AHP 方法 `session/commitMessage`（Core → Agent Host）。** 经会话 actor 发出，Agent Host 被空闲回收时由 actor 重新拉起；握手能力 `commitMessage`。参数：`sessionId`、`language`（`en` | `zh-CN`）、`instructions`（≤ 8 KiB）、`branch`、`recentSubjects`（≤ 10）、`files`（路径、状态、增删数、扣下原因）、`diff`（≤ 32 KiB）、可选 `amend`（上次提交信息）。结果：`text`、`model`、`fallback`（辅助模型不可用、退回会话模型时为真）。Core 侧超时 60 s，用户可取消。
2. **输入由 Core 组装。** 已暂存 diff（`git diff --cached`，只读模式）按单文件 8 KiB、合计 32 KiB 截断，超出只给路径与计数；以下文件只给路径：二进制、匹配权限规则 `Read(...)` deny 的路径、`.env*`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`id_rsa*`、`id_ed25519*`、`.npmrc`、`.pypirc`；锁文件只给计数。正文经 `piarc_telemetry::redact`。locale 由主进程填入，Core 只接受两个取值。
3. **提示与输出在 Agent Host。** `harness/commit-message.ts` 经 `auxiliary.complete`（purpose `commitMessage`，输出上限 600 token）调用；system 提示在 `harness/prompts/commit-message.ts`，PiArc 自写并跑原创性检查。指令、语言要求、分支、最近标题与 diff 都放在 user 内容里，diff 作为标明边界的材料段落。输出去掉代码围栏与控制字符，截到 4 KiB。
4. **只填入输入框。** 结果只替换提交信息框的内容（可撤回），从不自动提交或执行；提交由用户点击，经 `commit -F -` 传入。
5. **用量与审计。** 用量按 purpose `commitMessage` 记在该会话（`auxiliary/commitMessage`），用量页显示"提交信息"。审计只记模型、token 数、发送与扣下的文件数，不记内容。
6. **提交指令。** 默认指令随界面语言在 i18n 目录中提供（Conventional Commits、类型关键字为英文、首行祈使语气不超过 72 字符、正文说明原因）；用户级设置 `git.commitInstructions` 覆盖默认，与默认相同时不写入。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 复用 `hooks/prompt` | 不加 AHP 方法 | 语义是评判 hook；Agent Host 未运行时直接失败；提示词由 Core 拼装 | 否决 |
| 复用侧边对话 | 已有会话级通道 | 带着主会话的 system prompt、工具声明与历史，成本高且会泄露对话 | 否决 |
| 给 agent 发一句"请提交"（参考版做法） | 无新接口 | 进入主会话历史，结果不可预期，不能只生成信息 | 否决；可在 G5 作为另一入口 |
| 主进程直接调用服务商 | 无需 Agent Host | 凭据只经 AHP 交给 Agent Host（ADR-0021），主进程拿不到 | 否决 |

## 后果

- 正面：生成走与 WebFetch、Auto 模式相同的辅助通道与计费；不进入主会话历史；语言与指令可控。
- 负面与代价：已暂存内容会发给模型服务商（用户点击时才发送，有预算、扣下与脱敏）；AHP 新增一个方法与能力。
- 需要配套做的事：`npm run gen:protocol` 与契约样本；用量页标签；`docs/engineering/prompt-originality.md` 更新。

## 重新评估的触发条件

- 需要按仓库约定（例如提交历史的语言）而不是界面语言决定提交信息语言；
- G5 的 PR 描述生成需要相同通道时，合并为一个"Git 文本生成"方法。
