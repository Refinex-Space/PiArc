# 0059. M4 hooks、完整配置诊断与用量成本的落地（补充）

- 状态：已接受，补充 ADR-0005、ADR-0038、ADR-0039、ADR-0053、ADR-0055
- 日期：2026-11-21
- 相关：架构第 6.3.2、6.13、6.14、7.4、8.2、9.2 节；T41；FR-EX-05、FR-HN-05、FR-MD-06

## 背景

T41 补三件事：第 6.3.2 节排在 M4 的六个 hooks 事件与 `mcp_tool` handler；T24 只覆盖设置文件的配置诊断补全到全部来源；按会话、按模型的 token 与成本统计（FR-MD-06）。基线只给了事件表与"诊断列出加载状态、生效与被覆盖的键"这一句，下面是实现时定下的细节。

调研结论（2026-11-21 核对锁定版本与官方文档）：

- Claude Code 的 M4 事件：UserPromptExpansion（`expansion_type`、`command_name`、`command_args`、`command_source`、`prompt`，可阻断）、InstructionsLoaded（`file_path`、`memory_type`、`load_reason`，无决策）、CwdChanged（`old_cwd`、`new_cwd`）、FileChanged（`file_path`、`event`，matcher 是文件名）、ConfigChange（`source`、`file_path`，`decision: block` 让变更不在本会话生效，`policy_settings` 不可阻断）、StopFailure（`error` 为错误类型，输出被忽略）；SessionStart、CwdChanged、FileChanged 的 `hookSpecificOutput.watchPaths` 替换监视列表。`mcp_tool` handler 的字段是 `server`、`tool`、`input`，`input` 中的 `${path}` 按 hook 输入替换，工具的文本按命令的 stdout 读。
- pi-ai 1.5.2 的 `calculateCost`：tier 取 `inputTokensAbove` 小于本次请求输入 + 缓存读 + 缓存写的最大一档；1 小时缓存写入按输入价的两倍；浮点按百万 token 计价。Pi 的会话文件里，assistant 消息带 `usage`（含 `cacheWrite1h`、可选的 `reasoning`），`usage` 条目（如 `cache_warm`）带 `provider`、`model`、`usage`；PiArc 的辅助模型调用写 `piarc.auxiliaryUsage` 自定义条目（T29）。

## 决策

### M4 hooks

1. **挂载点。** UserPromptExpansion：命令文件与 skill 在 Core 展开之后、登记 `allowed-tools` 与 hooks 之前运行（`ToolIo::user_prompt_expansion`），MCP prompt 由 Agent Host 在展开时经 `hooks/run` 报告；阻断时输入以 `permissionDenied`（`hookBlocked`）被拒，什么都不登记。InstructionsLoaded 与 StopFailure 由 Agent Host 经 `hooks/run` 报告（`HostHookEvent` 加三个值）；CwdChanged、FileChanged、ConfigChange 由 Core 自己观察（`tool_io/hooks_m4.rs`）。
2. **watchPaths。** 每个会话一份监视列表，由 SessionStart、CwdChanged、FileChanged 的输出整体替换（多个 handler 合并），相对路径按会话当前目录；上限 64，超出的丢弃并以 FileChanged 的错误提示告诉用户（只写个数，路径写日志）。列表里的文件每 500 ms 轮询一次（是否存在、大小、修改时间），每次轮询中变化的文件各运行一次 FileChanged（`event` 为 `change` 或 `unlink`）。不用 notify：全量 L2 并行时实测 FSEvents 流的启动会阻塞几十秒，命令改变目录后要等新列表就位，回合因此卡住；至多 64 次 `stat` 的轮询开销小、立即生效、各平台一致。SessionStart 与 FileChanged 的新列表在后台安装，CwdChanged 的等它就位再返回命令结果（之后的改动不漏）；列表带替换序号，后来的总是生效。
3. **ConfigChange 的时机与阻断。** 每个会话记住自己最后见到的各层取值（`SessionIo.config_seen`，会话登记时取基线），在处理每个输入（prompt、steer、follow-up）之前与设置监听看到变化时核对一次文件（`ToolIo::check_config`，同一把锁，同一变化只处理一次），有变化的层运行 ConfigChange。权限裁决每次都重新读设置文件，所以只靠文件事件不够：事件迟到时下一次裁决会先用上新值。hook 阻断时 Core 记下该层变化前的值（`SessionIo.config_pins`），本会话的权限裁决与 hooks 规划都用它，文件不回滚，用户收到"本会话未应用"的提示。`policy_settings`（企业来源，T47）的阻断不生效。
4. **StopFailure 的错误类型** 只在 `agent-host/src/runtime/turn-errors.ts` 的 `stopFailureType` 映射：`rate_limit`、`overloaded`、`authentication_failed`、`billing_error`、`invalid_request`、`model_not_found`、`server_error`、`max_output_tokens`，其余 `unknown`。
5. **`mcp_tool` handler 的执行路径。** hooks 在 Core 执行、MCP 连接在 Agent Host 的池里，所以新增 Core → Agent Host 的 AHP 请求 `hooks/mcpTool`（`sessionId`、`server`、`tool`、`arguments`、`timeoutMs`；结果 `text`、`isError`），由工作区的池调用工具。`input` 的 `${a.b}` 占位按 hook 输入替换，整串只有一个占位时保留原类型。工具文本按命令的 stdout 读；`isError`、server 未配置或未连接（含项目未信任）、超时（默认 600 s）都是非阻断错误。所有事件都接受它。

### 配置诊断

6. **复用 T24 的 `FileReport`。** 加一个来源类别字段 `kind`（`settings`、`claudeState`，T41 起另有 `mcpJson`、`memory`、`rule`、`agent`、`skill`、`command`、`outputStyle`、`plugin`、`enterprise`），状态补上"本平台不生效"、"已忽略"、"未配置"，忽略原因补上不支持、已关闭、条件加载、待确认、待批准、无效，忽略项可带具体说明（`detail`）。设置文件之外的来源由各功能自己的加载器给出（`crate::mcp` 的合并、`fs/memory` 的发现、`piarc_config::{agents, skills, rules}`、包列表），报告不另写判断，所以与会话实际得到的一致。
7. **来源链。** 被覆盖的项写明覆盖它的来源文件（`sourceFile`）：设置键沿用 T24 的层，skill、命令、输出风格、子 agent 定义与 MCP server 用加载器记录的覆盖关系，被整份覆盖的文件状态为"已忽略"。
8. **自动刷新。** 设置监听另外监听工作区根目录（memory 文件、`.mcp.json`）与用户、项目两级的 `.claude/rules`、`.claude/agents`、`.piarc/agents`、数据目录的 `agents`，每次重载都发 `core/settings`（变化的键可能为空），诊断页据此重新请求。
9. **企业来源** 只占位置，状态"未配置"，T47 接入读取。

### 用量与成本

10. **数据从 JSONL 派生。** schema v11 的 `usage_records` 每行一次模型请求：assistant 消息的 `usage`（类别 `model`）、`piarc.auxiliaryUsage` 与 Pi 的 `usage` 条目（类别 `auxiliary`，带用途）；与 `session_text` 同一次扫描、同一事务写入，重建索引时清空重读。子 agent 的会话有自己的行，报告沿 `subagent_parent` 计入主会话并单独列出。
11. **价格表。** 目录价取 pi-ai 模型目录的 `cost`：Agent Host 在 `CatalogModel.cost` 里给出（四项全零或按点数计费的套餐不给），Core 把见到的目录价记在 `model_prices` 表，生成报告前向运行中的 Agent Host 刷新一次。用户在用户级 `settings.json` 的 `modelPrices`（`provider/model` → 四项单价，美元 / 百万 token）覆盖，只读用户层。两者都没有的模型成本为"未知"，不计入合计且报告标 `partial`，从不按 0 计。
12. **整数计算。** 单价换成每 token 的皮美元（单价 × 10⁶，取整），请求成本是 token 数乘单价的 `u128` 精确和，只有最后的合计转为美元浮点。规则与 `calculateCost` 相同：没有分档的模型按合计计算（线性），有分档的逐请求选档。`tests/usage/cost-vectors.json` 是 `calculateCost` 的输出，Vitest 核对它仍是 pi-ai 的结果，Rust 按同一份核对 Core 的结果。
13. **界面与 API。** Core API `usageReport(workspace?)`、`sessionUsage(sessionId)`、`setModelPrice(provider, model, price?)`；会话右栏的"用量"卡片与设置窗口的"用量"页，金额标"估算"。

## 影响

- 新增 AHP 请求 `hooks/mcpTool`（Core → Agent Host）与 L1 样本；`HostHookEvent` 加三个值；`CatalogModel` 新增可选的 `cost`。都是补充，旧消息语义不变。
- 新增表 `usage_records`、`model_prices`（schema v11），迁移清空 `session_files` 让已有会话重扫一次。
- `core/settings` 现在在每次重载时都发；目前只有诊断页订阅它。

## 备选方案

- **成本存在会话行里累加**：不能事后改价，也做不到分档；按请求存行、查询时计价，改价立即生效。
- **在 Agent Host 运行 `mcp_tool` hook**：hooks 的合并、审计、超时与信任都在 Core（ADR-0039），只把工具调用交给持有连接的池更一致。
- **诊断为新来源另建一套结构**：任务要求复用 T24 的结构；加 `kind` 字段后界面按类别分组即可。
