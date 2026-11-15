# T02 协议单一来源与契约测试基座

| 项 | 内容 |
|---|---|
| 阶段 | 0 工程基座 |
| 依赖 | T01 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 中 |
| 关联验证项 | 无 |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T02`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

每条跨进程、跨语言的边界都要有版本化的 schema 和契约测试（架构原则 6"协议先行、可测试"）。ADR-0009 规定协议类型只在 Rust crate `piarc-protocol` 中定义：导出 JSON Schema，再生成 TypeScript 类型，供 Agent Host 与客户端使用。

本任务建立这条单一来源的管线，以及之后每个任务新增协议消息时都要走的 L1 契约流程：改了 Rust 类型不重新生成、新增消息不带样本，`npm run verify` 都会失败。同时交付 LF 分帧编解码器的 Rust 与 TS 两份实现，T06 直接用它们接通 stdio。

本任务只定义骨架类型：消息信封、结构化错误、握手、会话事件信封、item 状态，以及 `turn/*`、`item/*` 的最小形状。具体业务方法由后续任务按需添加。

## 必读

1. 架构设计 `docs/architecture/ARCHITECTURE.md`：
   - 第 7.4 节"Agent Host Protocol（AHP）"
   - 第 7.6 节"Core API（NAPI-RS 导出面）"中类型来源与 L1 快照的段落
   - 第 12.1 节"测试分层"中的 L1 一行
   - 第 13.2 节"构建流水线"第一行（schema → TS 类型，CI 检查无漂移）
2. ADR-0009、ADR-0014（第 5 条错误、第 6 条类型来源）。
3. T01 交付的 `scripts/dev/verify.mjs`、`docs/engineering/coding-standards.md`、`docs/engineering/testing.md` 与根 `CLAUDE.md`。
4. 实现时查阅：schemars 与 serde 锁定版本的文档；ajv 的文档；选定的 JSON Schema → TypeScript 生成工具的文档。

## 范围

### 要做

- `piarc-protocol` 骨架类型、协议版本常量与兼容规则。
- JSON Schema 导出、TS 类型生成、`npm run gen:protocol`、漂移检查。
- L1 契约测试基座：golden 样本、Rust 与 TS 两侧往返、样本完整性检查。
- LF 分帧编解码器，Rust 与 TS 各一份。

### 不做

- 具体业务方法（`session/*`、`fs/*`、`policy/*` 等）：随功能任务增加，第一批由 T06、T07 加入。
- Agent Host 与 Core 的进程连接、心跳、背压（T06）。
- NAPI-RS 生成的 `.d.ts` 快照（T04）；终端帧的二进制格式（T10 起草、T33 定稿）。

## 交付物

### 1. `piarc-protocol` 骨架类型

| 类型 | 要求 |
|---|---|
| JSON-RPC 2.0 消息 | request、response（`result` 与 `error` 二选一）、notification；`id` 支持数字与字符串；不支持批量请求，收到批量时返回 Invalid Request，写进 crate 文档 |
| 结构化错误 | 遵循 JSON-RPC 2.0 的 error 对象（`code`、`message`、`data`）；`data` 中 `kind`（可机读枚举）与 `retryable` 必填，`details` 可选。标准错误码与应用错误码段分开定义。T04 的 NAPI 错误复用同一形状 |
| 握手 | `host/hello`：`protocol`、`pi`、`capabilities`；`core/welcome`：`protocol`、`enabled`、`workspace`、`connectionEpoch`，与第 7.4 节示例一致 |
| 版本与能力协商 | 协议版本常量（`主.次`）只在 Rust 中定义一处；纯函数 `negotiate`：主版本不同返回结构化错误；次版本不同允许连接，`enabled` 取双方都支持的能力交集 |
| 会话事件信封 | 每条会话通知的 `params` 带 `sessionId`、`seq`（会话内单调递增的整数）、`ts`。ADR-0009 第 4 条的 `type` 对应 JSON-RPC 的 `method`，`payload` 对应 `params` 中其余字段，映射写进 crate 文档 |
| item | 状态枚举 `inProgress / completed / failed / declined / interrupted`；`turnId`、`itemId` 类型；`turn/started`、`turn/completed`、`item/started`、`item/completed`、`item/agentMessage/delta` 的最小载荷 |

- 字段统一 camelCase。同一主版本内的新增字段必须向后兼容：反序列化忽略未知字段，schema 的 `additionalProperties` 与此一致，规则写进 crate 文档。

### 2. Schema 导出与 TS 生成

- schemars 把 JSON Schema 导出到 `packages/protocol/schema/`。输出确定性：键顺序稳定、格式固定、文件末尾换行，不写入时间戳、绝对路径与用户名。
- 从 schema 生成 TS 类型到 `packages/protocol/src/generated/`。生成工具的选型是补充型决策，精确锁定版本，理由写进报告。生成文件头注明"由 `npm run gen:protocol` 生成，不要手改"。
- `npm run gen:protocol` → `scripts/dev/gen-protocol.mjs`：一条命令完成 Rust 导出与 TS 生成，跨平台。
- `scripts/ci/check-protocol-drift.mjs`：在临时目录重新生成，与仓库中的文件逐字节比较，不一致时列出文件并退出非 0，并入 `verify.mjs`。
- 生成目录要么不参与 Prettier 检查，要么由生成脚本最后统一格式化，二选一，保证格式检查与漂移检查不互相冲突。
- `packages/protocol/src/index.ts` 导出生成类型、协议版本与 TS 帧编解码器。

### 3. L1 契约测试基座

- `tests/contracts/<消息名>/` 下放 golden 样本，每类消息至少一个合法样本；`invalid/` 下放反例：缺必填字段、枚举值非法、类型错误。
- Rust：遍历样本做 serde 往返（反序列化 → 序列化 → 按 JSON 语义与原样本相等），反例必须反序列化失败。
- TS：ajv 按导出的 schema 校验，合法样本通过、反例失败；再做 parse → stringify 往返。
- `scripts/ci/check-contract-samples.mjs`：schema 中每个方法与顶层消息类型至少有一个合法样本，缺失时列出并退出非 0，并入 verify。
- 在 `docs/engineering/testing.md` 的 L1 一节写明新增协议消息的步骤：改 Rust 类型 → `npm run gen:protocol` → 加样本与反例 → 跑两侧测试。

### 4. LF 分帧编解码器

Rust（`piarc-protocol` 的 `framing` 模块，只处理字节缓冲，不做 I/O）与 TS（`packages/protocol/src/framing.ts`）各一份，行为一致：

- 按 `\n` 字节分帧，帧内容为 UTF-8 JSON。JSON 字符串中的 U+2028、U+2029 不是分隔符（ADR-0009 第 1 条）。
- 半包缓存到下一次输入；一次输入含多帧时全部解出。
- 单帧上限可配置，默认 8 MiB。超限时报结构化错误，丢弃到下一个 `\n`，后续帧照常解析。
- 非法 UTF-8、非法 JSON 报结构化错误，不 panic，不抛未捕获异常。
- 编码时帧尾追加 `\n`，帧内不出现裸 `\n`。
- 两份实现共用 `tests/contracts/framing/` 下的字节级用例数据。

## 实现要点

- 先打通最小链路：一个类型 → schema → TS → 样本 → 两侧测试 → 漂移检查，全部通过后再补其余类型。
- 往返比较按 JSON 语义（解析后比较），避免键顺序和空白导致误报；schema 文件本身按字节比较。
- Windows 上生成结果的换行统一为 LF（`.gitattributes` 已设），脚本拼路径用 `path.join`。
- 样本文件名与消息名一一对应，便于检查脚本从 schema 推导应有的样本。

## 验收标准

- [T02-A01] 连续两次运行 `npm run gen:protocol`，`packages/protocol/schema/` 与 `packages/protocol/src/generated/` 字节一致，`git status` 无变化。验证：两次运行后的 `git status` 与文件哈希比较输出。
- [T02-A02] 临时给一个 Rust 协议类型加字段而不重新生成，`npm run verify` 在漂移检查步骤失败并列出不一致的文件；重新生成后通过。验证：两次运行的关键输出。
- [T02-A03] JSON-RPC 请求、响应、错误、通知，握手两条消息，会话事件信封，`turn/*` 与 `item/*` 骨架消息都有合法 golden 样本，Rust serde 往返与 TS ajv 校验加往返全部通过。验证：样本清单与两侧测试输出。
- [T02-A04] 反例样本（缺必填字段、非法枚举、类型错误）在 Rust 反序列化与 ajv 校验中都被拒绝。验证：两侧测试输出。
- [T02-A05] 临时新增一个没有样本的消息类型，样本完整性检查失败并指出缺样本的类型；撤销后通过。验证：关键输出。
- [T02-A06] Rust 与 TS 两份帧编解码器在半包、粘包、超长帧（超限后后续帧仍能解析）、非法 UTF-8、非法 JSON 五类用例上全部通过，用例数据两侧共用。验证：两侧测试输出。
- [T02-A07] JSON 字符串中含 U+2028、U+2029 时不被当作帧分隔符，解码结果与原文一致。验证：两侧测试。
- [T02-A08] 主版本不同的握手被 `negotiate` 拒绝，返回 `kind` 明确的结构化错误；次版本不同时握手成功，`enabled` 为双方能力交集。验证：单元测试。
- [T02-A09] 结构化错误序列化后符合 JSON-RPC 2.0 error 对象，`data.kind` 与 `data.retryable` 缺失时反序列化失败。验证：样本与测试。
- [T02-A10] 生成、漂移检查、样本完整性检查都是 Node 脚本，不写死路径分隔符，并由 verify 调用，CI 的 macOS 与 Windows 两个 runner 都会执行。验证：脚本代码与 CI 配置检查。
- [T02-A11] `npm run verify` 通过，汇总表包含漂移检查与样本完整性检查两个新步骤。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 创建 `crates/piarc-protocol/CLAUDE.md` 与 `packages/protocol/CLAUDE.md`：新增消息的步骤、生成命令、确定性约束、信封与 `method` 的映射。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：帧编解码器（Rust 与 TS）、`negotiate`、结构化错误类型、生成与漂移检查脚本。
- 根 `CLAUDE.md` 的"命令"一节补上 `npm run gen:protocol`（实际执行成功后）。
