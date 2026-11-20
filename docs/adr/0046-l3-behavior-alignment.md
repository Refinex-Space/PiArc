# 0046. L3 行为对齐基座的落地（补充）

- 状态：已接受，补充 ADR-0005、ADR-0006、ADR-0039
- 日期：2026-11-20
- 相关：架构第 6.3、12.1、12.2、12.5、13.3 节；`docs/engineering/testing.md` 第 12、14 节；T30

## 背景

架构第 12.5 节规定 L3 的方向：同一个严格 mock 服务 PiArc 与 `claude -p --output-format stream-json`，两侧的请求与事件归一化后做结构化 diff，差异要么修正要么写进 `tests/l3-allowlist.yaml`，只比对结构不复制文本。没有规定：Claude Code 怎样与用户本机的配置、登录和网络隔离；`-p` 没有交互审批时询问怎样作答；录制怎样保证提示词不落盘；Claude Code 的辅助请求怎样不打乱 mock 的脚本；"结构"具体比哪些字段；allowlist 的格式与失效规则。首批比对还发现 PiArc 的一个偏差：会话第一个提示的 UserPromptSubmit hooks 可能先于 SessionStart hooks 运行，先后在两次运行之间也不固定，而 Claude Code 总是先运行 SessionStart。

## 决策

1. **Claude Code 在每个场景的临时根中隔离运行。** `CLAUDE_CONFIG_DIR` 与 `HOME` 指向临时目录（前者同时让 macOS 钥匙串条目按目录区分），环境从零构建：假的 `ANTHROPIC_API_KEY`、指向 mock 的 `ANTHROPIC_BASE_URL`、经 `ANTHROPIC_CUSTOM_HEADERS` 选择场景、关闭非必要流量、自动更新、遥测、错误上报与标题请求。项目信任按场景写在临时配置目录的 `.claude.json`。运行前后比较本机 `~/.claude` 与 `~/.claude.json` 的文件清单与修改时间，有变化即失败。
2. **审批用 `--permission-prompt-tool`。** 夹具 MCP server（`scripts/l3/fixtures/approval-server.mjs`）按 `tool_use_id` 取场景的应答；PiArc 侧 L2 运行器按审批卡所属的工具调用取同一条应答（L2 应答新增可选的 `call`）。没有应答的询问一律拒绝并记为未脚本化，两侧问的次数不同也不会让后面的应答错位。`-p` 表达不了的应答（"总是允许"、"本会话允许"、添加目录）与需要第二次输入、重启或第二个会话的 L2 场景列入 allowlist 的排除清单并写明原因。
3. **录制只写白名单结构。** mock 新增 L3 模式（`Mode::L3`、`--l3`）：保留协议规则（配对、角色交替、工具 schema、断点数量），关闭 PiArc 特有的 system 段与断点位置规则；请求记录只保留 `piarc_testkit::l3::structure`（工具名、描述与参数描述的长度和 hash、参数 schema、system 段指纹、消息的块类型序列、`tool_use` 的脚本参数、`tool_result` 的错误标记与长度、缓存断点），原始请求体不进记录。Claude Code 的 stream-json 只在内存中读取工具调用、拒绝与最终状态。录制产物写盘前把绝对路径换成占位符，并由 `scripts/l3/check-recordings.mjs` 按白名单 schema 校验、扫描自然语言文本。
4. **只比对主循环请求。** 流式且声明了工具的 Messages 请求是主循环，其余是辅助请求；L3 模式下流式辅助请求得到固定短文本、不消耗脚本步数，非流式的照常被拒（Claude Code 的自动模式分类器因此按不可用处理）。辅助请求只比个数。
5. **比对的内容。** 请求：主循环请求数，每个请求的顶层键、工具集与每个工具的参数类型和必填项、system 段数与断点、每条消息的角色与块序列；文本的长度与 hash 只记录不比较。行为：按工具调用 id 的规范工具名、换回 Claude Code 参数名的输入、状态与模型看到的错误标记，按调用 id 的询问与应答，hooks 的顺序与每次调用的输入字段名和返回的决定，最终状态，工作区文件的 hash。PiArc 的文件工具沿用 Pi 的参数（ADR-0020），场景用 Claude Code 的参数名书写，运行与比对时按 `scripts/l3/scenario.mjs` 的映射转换。
6. **allowlist 按版本范围生效，失效即失败。** 每条差异记录场景、字段路径模式、适用的 Claude Code 版本范围与必填的理由，可选后续任务；缺理由，或版本在范围内、所点名的场景都跑过却没有匹配任何差异的条目，都让命令失败。对照领域（`perm-`、`policy-`、`hooks-`、`config-` 开头的 L2 场景）中的每个场景必须被某个 L3 场景对照或被排除。
7. **会话的 SessionStart hooks 先于其提示的 UserPromptSubmit hooks。** Agent Host 在打开会话的过程中报告 SessionStart（`hooks/run`），这个请求在会话打开的应答之前写出；Core 处理它时先为该会话登记"SessionStart 进行中"再运行，UserPromptSubmit 运行前等登记清零（会话 token 取消时不再等）。SessionStart 仍不阻塞会话打开（ADR-0039 第 3 条不变）。压缩后的 SessionStart（`source: compact`）不登记。
8. **同侧可重复是比对的前提。** `npm run l3 -- --repeat n` 让每侧运行 n 次，归一化结果不同即失败；同一事件、同一工具调用的并行 hooks 按名字排序，其他顺序原样比较。Nightly 用 `--repeat 2`，在 macOS 上安装锁定版本的 Claude Code，不使用任何密钥。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 用 `--bare` 运行 Claude Code | 跳过本机配置与钥匙串，更易隔离 | 同时跳过项目 hooks 与设置，比不了 hooks 与规则 | 否决；用临时配置目录与 HOME 隔离 |
| `--permission-prompts none` | 不需要夹具 | 所有询问一律拒绝，比不了允许之后的行为与询问次数 | 否决 |
| 录制完整请求体，比对时再剥离 | 调试方便 | 提示词原文会落盘，违反 ADR-0006 | 否决 |
| 审批按出现顺序作答（L2 的方式） | 不需要调用 id | 一侧多问一次，后面的应答全部错位，一个差异变成一串 | 否决 |
| hooks 顺序在归一化中排序 | 不改 Core | 掩盖真实的顺序差异：SessionStart 的副作用对后续 hooks 可见是 Claude Code 的语义 | 否决，修正 Core |

## 后果

- 正面：权限与 hooks 的 12 个场景与 Claude Code 2.1.318 的每个差异都已修正或附理由；Claude Code 升级带来的新差异在 Nightly 中立即暴露。
- 负面与代价：allowlist 要随 Claude Code 版本维护；比对只覆盖 `-p` 能表达的路径；本机运行时，其他 Claude Code 会话写 `~/.claude` 会让隔离检查报告变化。
- 需要配套做的事：其他能力（memory、rules、计划、压缩、子 agent 等）的 L3 场景随各自任务增加；allowlist 中带 `follow_up` 的偏离登记在 `PLAN.md`。

## 重新评估的触发条件

- Claude Code 改变 `-p`、stream-json、`--permission-prompt-tool` 或配置目录的行为；
- 需要在 Windows 上运行 L3；
- Anthropic 的条款对运行 Claude Code 做比对测试有新的限制。
