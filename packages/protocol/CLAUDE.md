# @piarc/protocol

AHP 的 TypeScript 类型（由 `piarc-protocol` 生成）、`PROTOCOL_VERSION` 与 LF 帧编解码器（`src/framing.ts`）。类型的来源是 Rust crate `crates/piarc-protocol`，这里不手写协议类型。

## 命令

| 命令 | 用途 |
|---|---|
| `npm run gen:protocol` | 重新生成 `schema/` 与 `src/generated/`（先跑 Rust 导出，再用 json-schema-to-typescript 生成，最后按仓库 Prettier 配置格式化） |
| `node scripts/ci/check-protocol-drift.mjs` | 在临时目录重新生成并逐字节比较；verify 第 9 步 |
| `node scripts/ci/check-contract-samples.mjs` | 每个契约要有合法样本与反例；verify 第 10 步 |
| `npx vitest run packages/protocol` | ajv 契约校验（`src/contracts.test.ts`）与共享帧用例（`src/framing.test.ts`） |

## 不变量

- `schema/` 与 `src/generated/` 是生成物，不手改；改协议先改 Rust，再 `npm run gen:protocol`（步骤见 `docs/engineering/testing.md` 第 7 节）。生成器拥有这两个目录，会删除不再生成的文件。
- 生成文件由生成器用仓库 Prettier 配置格式化，所以它们参与 `prettier --check`，与漂移检查不冲突。ESLint 只对 `src/generated/` 关闭两条风格规则。
- TS 类型按"闭合对象"生成（`additionalProperties: false` 只影响 TS 输出）；运行时校验以 `schema/ahp.schema.json` 为准，它允许未知成员。
- `src/framing.ts` 与 Rust 的 `framing` 模块行为一致，共用 `tests/contracts/framing/` 用例；改一边必须改另一边并补共享用例。

## 易错点

- ajv 要用 `ajv/dist/2020.js` 的 `Ajv2020`（schema 是 draft 2020-12），并为 schemars 输出的 `int32`、`int64`、`uint64` 注册格式，否则 strict 模式报错。
- `JSON.stringify` 会把孤立代理项写成 `\udXXX` 转义，Rust 端无法解码；`encodeFrame` 遇到这种字符串直接抛 `TypeError`。流式文本按 UTF-16 切分时可能产生孤立代理项，发送前要先处理。
- 解码器拒绝嵌套超过 `MAX_NESTING`（127）层的 JSON，与 serde_json 一致。

## 参考

- 架构第 7.4 节、第 13.2 节第一行；ADR-0009、ADR-0014；`crates/piarc-protocol/CLAUDE.md`。
