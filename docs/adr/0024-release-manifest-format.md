# 0024. 发布清单的格式、签名与校验位置（补充 ADR-0018 第 4 条）

- 状态：已接受（补充）
- 日期：2026-11-16
- 取代：无
- 相关：[ADR-0018](0018-unsigned-distribution.md) 第 4 条；架构文档第 10.1、13.2 节；`docs/spikes/S06-packaging-first-run.md` 第 6 节

## 背景

ADR-0018 第 4 条决定：没有平台签名时，每个版本发布一份清单（版本号、文件名、SHA-256），用项目自有的 Ed25519 密钥按 minisign 格式签名，应用内置公钥，校验失败就拒绝更新。它没有规定清单的具体格式、签名文件的形状、校验代码放在哪里，以及测试密钥与正式密钥怎样分开。发布后清单格式就成了对外契约：老版本的应用要能读新版本发布的清单，改格式代价高，所以在 T12 定下来。

事实（2026-11-16）：

- minisign 的签名分两层：对文件（预哈希模式下是文件的 BLAKE2b-512）的 Ed25519 签名，以及对"签名 ‖ 受信注释"的全局签名。受信注释同样受保护。
- 仓库已有 minisign 校验依赖 `minisign-verify` 0.3.0（T10 引入，零依赖，minisign 作者维护），只接受预哈希签名的用法已在 libghostty-vt 产物校验中使用。
- Node 的 `node:crypto` 提供 Ed25519 与 BLAKE2b-512，足以生成 minisign 预哈希签名；minisign 私钥文件里的校验和是 BLAKE2b-256，Node 不提供，需要自写（只用于私钥文件的完整性检查）。

## 决策

1. **清单**：`piarc-release-manifest.json`，UTF-8 JSON，成员：
   - `format`：固定为 `piarc-release-manifest/1`。以后不兼容的改动换成 `/2`，应用拒绝不认识的格式；
   - `product`、`version`（SemVer）、`createdAt`（ISO 8601）；
   - `files`：按文件名排序的数组，每项 `name`（不含目录的文件名）、`size`（字节）、`sha256`（小写十六进制）。
   签名覆盖文件的原始字节，所以应用先验签、后解析，不对清单做任何规范化。
2. **签名**：同目录的 `piarc-release-manifest.json.minisig`，minisign 格式，只用预哈希（`ED`）签名，不接受旧式（`Ed`）签名。受信注释沿用 minisign 默认的 `timestamp:…\tfile:…\tprehashed`。
3. **生成**：`scripts/release/release-manifest.mjs`（`generate`、`verify`、`keygen`）。它只读未加密的 minisign 私钥，用于测试密钥；正式密钥由 T50 在受保护的发布环境中生成和使用，可以用 minisign 命令行或在本脚本上扩展加密私钥的读取。
4. **校验位置**：`piarc_core::release`。`verify_manifest` 先用信任的公钥验签，通过后才解析；`verify_file` 校验每个下载产物的大小与 SHA-256。所有失败都是结构化错误，类别 `releaseIntegrity`（协议新增，错误码 -32017），`details.reason` 区分 `noTrustedKey`、`malformedSignature`、`unknownKey`、`badSignature`、`malformedManifest`、`notListed`、`sizeMismatch`、`hashMismatch`；文件读不了时为 `ioError`。调用方遇到任何错误都拒绝更新。
5. **公钥**：内置公钥只有 `piarc_core::release::BUILTIN_RELEASE_KEYS` 一处，T50 之前为空，此时一切清单都被拒绝（fail closed）。测试密钥对在 `scripts/release/test-keys/`，文件名带 `test`，绝不进入内置列表。换密钥时允许列表里同时放新旧两把公钥过渡。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 每个产物单独一个 `.minisig` | 不需要清单格式 | 版本号与产物列表不受签名保护，可被混搭成"旧产物 + 新版本号" | 否决 |
| 用 Velopack 自带的发布元数据（`releases.*.json`）代替清单 | Windows 侧少一份文件 | macOS 没有对应物；Velopack 的元数据不签名 | 否决：清单覆盖两个平台的全部产物，Velopack 的元数据作为清单里的一个产物 |
| 用 Rust 写签名工具（`minisign` crate） | 不需要自写 BLAKE2b | 发布流水线的其余部分都是 Node 脚本；为一次签名增加一个 crate 与 bin | 否决 |
| 校验放在主进程（TypeScript） | 更新界面就在主进程 | 主进程只做转发（ADR-0013）；Core 已有 minisign 校验与哈希能力 | 否决 |

## 后果

- 正面：两个平台共用一份签名清单；Node 签名、Rust 校验两套实现互相印证格式（`crates/piarc-core/tests/release.rs` 用 Node 生成的签名样本）；没有正式公钥时默认拒绝。
- 负面与代价：`scripts/lib/blake2b.mjs` 是自写的 BLAKE2b，只用于私钥文件校验和，测试对照 `node:crypto` 的 BLAKE2b-512 与公开的 BLAKE2b-256 向量；清单格式发布后只能按 `format` 版本演进。
- 需要配套做的事：T50 生成正式密钥并写入 `BUILTIN_RELEASE_KEYS`，在受保护环境中签名；更新流程（macOS 提示、Windows Velopack）在下载后、应用前调用 `verify_file`。

## 重新评估的触发条件

- 项目取得平台代码签名（ADR-0018 的触发条件），更新完整性可以依赖系统校验时；
- minisign 格式或 `minisign-verify` 停止维护；
- 需要清单表达更多信息（例如分阶段发布、增量包），而 `/1` 无法容纳时，按 `format` 升级。
